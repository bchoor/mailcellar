// The Gmail API calls the sync makes, and turning a message Gmail returns into an index row.
// Workers Free allows 50 outside requests per Workflow run (spike S7), so messages are fetched
// with Gmail's batch endpoint: one request carries up to 50 messages.get calls.
import type { IndexedMessage, MailLabel } from '@mailcellar/schema';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1';
/** Google's advice for Gmail batches; larger ones get rate limited. */
export const BATCH_SIZE = 50;

/** A Gmail call that failed. `status` 429 and 5xx are worth retrying later. */
export class GmailError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** One message as messages.get returns it with format=minimal: no content, but its size. */
export interface MinimalMessage {
  id: string;
  sizeEstimate: number;
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
export async function listPage(token: string, pageToken?: string, max = 500) {
  const q = new URLSearchParams({ maxResults: String(max) });
  if (pageToken) q.set('pageToken', pageToken);
  const body = await call<{ messages?: { id: string }[]; nextPageToken?: string }>(token, `/messages?${q}`);
  return { ids: (body.messages ?? []).map((m) => m.id), next: body.nextPageToken ?? null };
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
 * failed with a retryable status; a message deleted in the meantime (404) is dropped.
 */
export async function batchGet<F extends 'minimal' | 'raw'>(
  token: string,
  ids: string[],
  format: F,
): Promise<{ messages: (F extends 'raw' ? RawMessage : MinimalMessage)[]; retry: string[] }> {
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
  if (!res.ok) throw new GmailError(res.status, `Gmail batch failed (HTTP ${res.status})`);
  const parts = parseBatch(new TextDecoder().decode(await res.arrayBuffer()), res.headers.get('content-type') ?? '');
  const messages = [];
  const got = new Set<string>();
  const retry: string[] = [];
  for (const p of parts) {
    const id = p.contentId?.replace(/^response-/, '');
    if (!id) continue;
    got.add(id);
    if (p.status === 200) messages.push(JSON.parse(p.body));
    else if (p.status === 429 || p.status >= 500) retry.push(id);
    else if (p.status !== 404) throw new GmailError(p.status, `Gmail message fetch failed (HTTP ${p.status})`);
  }
  for (const id of ids) if (!got.has(id)) retry.push(id);
  return { messages, retry };
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

export function b64urlBytes(s: string): Uint8Array {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes as a string, one character a byte (true latin1, unlike TextDecoder's windows-1252). */
function binary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return s;
}

/** The header block of a raw message, unfolded, as name → first value. */
export function headers(raw: Uint8Array): Map<string, string> {
  const head = binary(raw.subarray(0, Math.min(raw.length, 65536)));
  const end = head.search(/\r?\n\r?\n/);
  const block = (end < 0 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
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
export function countAttachments(raw: Uint8Array): number {
  const text = binary(raw);
  return (text.match(/^content-disposition:[ \t]*attachment/gim) ?? []).length;
}

/** The index row for a message, from Gmail's fields and the raw headers. */
export function indexRow(m: RawMessage, raw: Uint8Array): IndexedMessage {
  const h = headers(raw);
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
