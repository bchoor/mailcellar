// The Gmail API calls the sync makes, and turning a message Gmail returns into an index row.
// Workers Free allows 50 outside requests per Workflow run (spike S7), so messages are fetched
// with Gmail's batch endpoint: one request carries up to 50 messages.get calls.
import type { IndexedMessage, MailLabel } from '@mailcellar/schema';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1';
/** Google's advice for Gmail batches; larger ones get rate limited. */
export const BATCH_SIZE = 50;

/** A Gmail call that failed. `status` 429 (also Gmail's rate-limit 403) and 5xx are worth retrying later. */
export class GmailError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** One message as messages.get returns it with format=minimal: no content, but its size. */
export interface MinimalMessage {
  id: string;
  sizeEstimate: number;
  labelIds?: string[];
}

/** One message as messages.get returns it with format=raw. */
export interface RawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  sizeEstimate: number;
  internalDate: string;
  historyId?: string;
  /** The whole message, base64url. */
  raw: string;
}

async function call<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new GmailError(res.status, `Gmail ${path.split('?')[0]} failed (HTTP ${res.status})`);
  return res.json() as Promise<T>;
}

export const profile = (token: string) =>
  call<{ emailAddress: string; messagesTotal: number; historyId: string }>(token, '/profile');

export async function labels(token: string): Promise<MailLabel[]> {
  const body = await call<{ labels?: { id: string; name: string; type: string }[] }>(token, '/labels');
  return (body.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type === 'system' ? 'system' : 'user' }));
}

/** One page of message IDs, newest first. */
/** One page of message IDs, newest first; `search` is a Gmail search such as `after:2026/09/24`. */
export async function listPage(token: string, pageToken?: string, max = 500, search?: string) {
  const q = new URLSearchParams({ maxResults: String(max) });
  if (pageToken) q.set('pageToken', pageToken);
  if (search) q.set('q', search);
  const body = await call<{ messages?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(token, `/messages?${q}`);
  return { ids: (body.messages ?? []).map((m) => m.id), next: body.nextPageToken ?? null, estimate: body.resultSizeEstimate ?? null };
}

/** Messages added since a history ID. Gmail answers 404 when the ID is too old to replay. */
export async function addedSince(token: string, startHistoryId: string) {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let historyId = startHistoryId;
  let calls = 0;
  do {
    calls++;
    const q = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', maxResults: '500' });
    if (pageToken) q.set('pageToken', pageToken);
    const body = await call<{ history?: { messagesAdded?: { message: { id: string } }[] }[]; nextPageToken?: string; historyId: string }>(
      token,
      `/history?${q}`,
    );
    for (const h of body.history ?? []) for (const a of h.messagesAdded ?? []) ids.add(a.message.id);
    historyId = body.historyId;
    pageToken = body.nextPageToken;
  } while (pageToken);
  return { ids: [...ids], historyId, calls };
}

/**
 * Get up to BATCH_SIZE messages in one request. Returns what came back and the IDs that
 * failed with a retryable status. `gone` lists the messages Gmail won't give: deleted in the
 * meantime (404), or refused (400, "Precondition check failed" on some old mail).
 * `throttled` counts messages Gmail turned away for speed (retried, not a reason to slow down),
 * and `reason` is the first one's message, to tell concurrency from quota.
 */
export async function batchGet<F extends 'minimal' | 'raw'>(
  token: string,
  ids: string[],
  format: F,
): Promise<{ messages: (F extends 'raw' ? RawMessage : MinimalMessage)[]; retry: string[]; gone: Gone[]; throttled: number; reason?: string }> {
  const boundary = `mc${crypto.randomUUID().replaceAll('-', '')}`;
  const body =
    ids
      .map((id) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <${id}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?format=${format}\r\n`)
      .join('') + `--${boundary}--`;
  const res = await fetch(BATCH_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/mixed; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    // Gmail says it's going too fast with 429, or 403 and a rate-limit reason (not a refusal).
    const text = await res.text();
    throw new GmailError(res.status === 403 && rateLimited(text) ? 429 : res.status, `Gmail batch failed (HTTP ${res.status})`);
  }
  const parts = parseBatch(new TextDecoder().decode(await res.arrayBuffer()), res.headers.get('content-type') ?? '');
  const messages = [];
  const got = new Set<string>();
  const retry: string[] = [];
  const gone: Gone[] = [];
  let throttled = 0;
  let reason: string | undefined;
  for (const p of parts) {
    const id = p.contentId?.replace(/^response-/, '');
    if (!id) continue;
    got.add(id);
    if (p.status === 200) messages.push(JSON.parse(p.body));
    else if (p.status === 429 || (p.status === 403 && rateLimited(p.body))) {
      retry.push(id);
      throttled++;
      reason ??= errorMessage(p.body);
    } else if (p.status >= 500) retry.push(id);
    else if (p.status === 400 || p.status === 404) {
      gone.push({ id, why: `HTTP ${p.status}: ${errorMessage(p.body)}` });
      console.error('gmail skipped', id, p.status, errorMessage(p.body));
    } else throw new GmailError(p.status, `Gmail message fetch failed (HTTP ${p.status}: ${errorMessage(p.body)})`);
  }
  for (const id of ids) if (!got.has(id)) retry.push(id);
  return { messages, retry, gone, throttled, reason };
}

/** A message Gmail lists but won't give, and why. */
export interface Gone {
  id: string;
  why: string;
}

/** Gmail's error message from a JSON error body, else the body's start. */
const errorMessage = (body: string): string => {
  try {
    return String(JSON.parse(body).error?.message ?? body).slice(0, 120);
  } catch {
    return body.slice(0, 120);
  }
};

/** A 403 that is Gmail's rate limit (rateLimitExceeded, userRateLimitExceeded), not access refused. */
export const rateLimited = (body: string) => /rate ?limit/i.test(body);

/**
 * Get one message as raw, without the batch endpoint: for huge mail, so the answer is parsed
 * once, with no multipart text copy beside it. A Gone: Gmail won't give it (404 or 400, as in batchGet).
 */
export async function getRaw(token: string, id: string): Promise<RawMessage | Gone> {
  const res = await fetch(`${API}/messages/${id}?format=raw`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 || res.status === 404) {
      console.error('gmail skipped', id, res.status, errorMessage(text));
      return { id, why: `HTTP ${res.status}: ${errorMessage(text)}` };
    }
    throw new GmailError(res.status === 403 && rateLimited(text) ? 429 : res.status, `Gmail message fetch failed (HTTP ${res.status}: ${errorMessage(text)})`);
  }
  return (await res.json()) as RawMessage;
}

/**
 * Group messages into raw batches of at most BATCH_SIZE messages and `maxBytes` together,
 * so a batch answer fits in a Worker's 128 MB. A message bigger than that goes alone.
 */
export function packBySize(messages: MinimalMessage[], maxBytes: number): string[][] {
  const batches: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const m of messages) {
    if (cur.length && (cur.length >= BATCH_SIZE || bytes + m.sizeEstimate > maxBytes)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(m.id);
    bytes += m.sizeEstimate;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** Split a Gmail batch response into its parts: Content-ID, HTTP status and JSON body. */
export function parseBatch(text: string, contentType: string) {
  const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
  if (!boundary) throw new GmailError(502, 'Gmail batch answer had no boundary');
  const out: { contentId: string | null; status: number; body: string }[] = [];
  for (const chunk of text.split(`--${boundary}`)) {
    const trimmed = chunk.replace(/^\r?\n/, '');
    if (!trimmed || trimmed.startsWith('--')) continue;
    const contentId = /^content-id:\s*<([^>]+)>/im.exec(trimmed)?.[1] ?? null;
    const http = /^HTTP\/[\d.]+ (\d{3})/m.exec(trimmed);
    if (!http) continue;
    const afterStatus = trimmed.slice(http.index);
    const blank = afterStatus.search(/\r?\n\r?\n/);
    const body = blank < 0 ? '' : afterStatus.slice(blank).trim();
    out.push({ contentId, status: Number(http[1]), body });
  }
  return out;
}

const fromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string, o: { alphabet: string; lastChunkHandling?: string }) => Uint8Array }).fromBase64;

/** Standard base64 as bytes; natively where the runtime has it. */
function b64Bytes(s: string): Uint8Array {
  if (fromBase64) return fromBase64(s, { alphabet: 'base64', lastChunkHandling: 'loose' });
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function b64urlBytes(s: string): Uint8Array {
  // Native where the runtime has it: several times faster than atob and a loop.
  if (fromBase64) return fromBase64(s, { alphabet: 'base64url' });
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes as a string, one character a byte (true latin1, unlike TextDecoder's windows-1252). */
const utf16 = new TextDecoder('utf-16le');
function binary(bytes: Uint8Array): string {
  // Widen each byte to a UTF-16 unit and decode natively: about 8 times faster than String.fromCharCode.
  return utf16.decode(new Uint16Array(bytes));
}

/** The header block of a raw message, unfolded, as name → first value. */
export function headers(raw: Uint8Array): Map<string, string> {
  // Only the header block is turned into text: find its blank line in the bytes first.
  const limit = Math.min(raw.length, 65536);
  let end = limit;
  for (let i = 0; i < limit - 1; i++)
    if (raw[i] === 10 && (raw[i + 1] === 10 || (raw[i + 1] === 13 && raw[i + 2] === 10))) {
      end = i;
      break;
    }
  const block = binary(raw.subarray(0, end)).replace(/\r?\n[ \t]+/g, ' ');
  const out = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!out.has(name)) out.set(name, line.slice(i + 1).trim());
  }
  return out;
}

/** Decode RFC 2047 encoded words (=?charset?B|Q?text?=), as subjects and names use them. */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, '$1')
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bq])\?([^?]*)\?=/gi, (whole, charset: string, enc: string, text: string) => {
      try {
        const bytes =
          enc.toLowerCase() === 'b'
            ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
            : Uint8Array.from(
                text.replaceAll('_', ' ').replace(/=([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
                (c) => c.charCodeAt(0),
              );
        return new TextDecoder(charset.trim()).decode(bytes);
      } catch {
        return whole;
      }
    });
}

/** Header bytes are latin1-decoded; undo that for UTF-8 sent unencoded, which many senders do. */
function utf8(value: string): string {
  if (!/[\x80-\xff]/.test(value)) return value;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(value, (c) => c.charCodeAt(0)));
  } catch {
    return value;
  }
}

/** "Name <addr>" or a bare address → its parts. */
export function parseFrom(value: string): { addr: string; name: string } {
  const decoded = decodeWords(utf8(value));
  const angle = /^(.*?)<([^>]*)>/.exec(decoded);
  if (angle) return { addr: angle[2].trim(), name: angle[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1') };
  const bare = decoded.replace(/\(.*\)/, '').trim();
  return { addr: bare, name: '' };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Gmail's snippet is HTML-escaped: &#39;, &amp; and friends. */
export const unescapeSnippet = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) =>
    e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(e[1] === 'x' || e[1] === 'X' ? 2 : 1), e[1] === 'x' || e[1] === 'X' ? 16 : 10)) : (ENTITIES[e.toLowerCase()] ?? whole),
  );

/** Parts marked as attachments. A cheap count over the raw bytes, not a MIME parse (spike S3). */
/** One character a byte, decoded natively: fine for finding ASCII header text, not for showing text. */
const latin1 = new TextDecoder('latin1');

export function countAttachments(raw: Uint8Array): number {
  return (latin1.decode(raw).match(/^content-disposition:[ \t]*attachment/gim) ?? []).length;
}

/** The index row for a message, from Gmail's fields and the raw headers. */
export function indexRow(m: RawMessage, raw: Uint8Array, h = headers(raw)): IndexedMessage {
  const from = parseFrom(h.get('from') ?? '');
  return {
    id: m.id,
    threadId: m.threadId,
    ts: Number(m.internalDate),
    fromAddr: from.addr,
    fromName: from.name,
    subject: decodeWords(utf8(h.get('subject') ?? '')),
    snippet: unescapeSnippet(m.snippet ?? '').slice(0, 200),
    size: m.sizeEstimate,
    attachments: countAttachments(raw),
    labels: m.labelIds ?? [],
  };
}

/** Addresses in a To or Cc header, lower-cased. */
export function parseAddresses(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  const push = () => {
    const a = /<([^>]*)>/.exec(cur)?.[1] ?? cur.replace(/\(.*?\)/g, '').trim();
    if (a.includes('@')) out.push(a.trim().toLowerCase());
    cur = '';
  };
  for (const c of value) {
    if (c === '"' && depth === 0) quoted = !quoted;
    else if (!quoted && c === '<') depth++;
    else if (!quoted && c === '>') depth = Math.max(0, depth - 1);
    if (c === ',' && !quoted && depth === 0) push();
    else cur += c;
  }
  push();
  return out;
}

/** One byte a character, as `binary` made them. */
function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const hex = (c: number) => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);

/** Quoted-printable as bytes, in one pass: the regex version was most of a message's CPU. */
function quotedPrintable(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 61) {
      out[n++] = c;
      continue;
    }
    const a = s.charCodeAt(i + 1);
    if (a === 13 && s.charCodeAt(i + 2) === 10) i += 2;
    else if (a === 10) i += 1;
    else {
      const hi = hex(a);
      const lo = hex(s.charCodeAt(i + 2));
      if (hi < 0 || lo < 0) out[n++] = c;
      else {
        out[n++] = hi * 16 + lo;
        i += 2;
      }
    }
  }
  return out.subarray(0, n);
}

function decodeBody(body: string, encoding: string, charset: string): string {
  let bytes: Uint8Array;
  const enc = encoding.toLowerCase();
  if (enc === 'base64') {
    try {
      bytes = b64Bytes(body.replace(/[^A-Za-z0-9+/=]/g, ''));
    } catch {
      return '';
    }
  } else if (enc === 'quoted-printable') {
    bytes = quotedPrintable(body);
  } else bytes = latin1Bytes(body);
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

const htmlToText = (html: string) =>
  unescapeSnippet(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();

/** Body text is looked for in a message's first bytes only: text parts come before attachments. */
export const BODY_SCAN = 256 * 1024;

/**
 * The readable text of a message, for full-text search in Basin: the first text/plain part,
 * or the first text/html part with tags removed. Attachments are skipped, not decoded. Only the
 * first BODY_SCAN bytes are read, which keeps a message with big attachments cheap.
 */
export function bodyText(raw: Uint8Array, max = 32 * 1024): string {
  type Found = { plain?: string; html?: string };
  const found: Found = {};
  const walk = (entity: string, depth: number) => {
    // The plain part wins over HTML, so once it is found nothing else is decoded.
    if (depth > 8 || found.plain !== undefined) return;
    const split = entity.search(/\r?\n\r?\n/);
    const head = (split < 0 ? entity : entity.slice(0, split)).replace(/\r?\n[ \t]+/g, ' ');
    const body = split < 0 ? '' : entity.slice(split).replace(/^\r?\n\r?\n/, '');
    const h = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(head)?.[1] ?? '';
    const type = h('content-type').toLowerCase() || 'text/plain';
    if (/^attachment/i.test(h('content-disposition'))) return;
    if (type.startsWith('multipart/')) {
      const boundary = /boundary="?([^";]+)"?/i.exec(h('content-type'))?.[1];
      if (!boundary) return;
      const parts = body.split(`--${boundary}`);
      for (const part of parts.slice(1)) {
        if (part.startsWith('--')) break;
        walk(part.replace(/^[ \t]*\r?\n/, ''), depth + 1);
      }
      return;
    }
    const charset = /charset="?([^";\s]+)"?/i.exec(h('content-type'))?.[1] ?? 'utf-8';
    // Only as much source as the text kept can need: HTML is mostly tags.
    if (type.startsWith('text/plain') && found.plain === undefined) found.plain = decodeBody(body.slice(0, max * 2), h('content-transfer-encoding'), charset);
    else if (type.startsWith('text/html') && found.html === undefined) found.html = htmlToText(decodeBody(body.slice(0, max * 2), h('content-transfer-encoding'), charset));
  };
  walk(binary(raw.subarray(0, BODY_SCAN)), 0);
  return (found.plain ?? found.html ?? '').trim().slice(0, max);
}
