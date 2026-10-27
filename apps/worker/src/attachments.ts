// Attachment search (Bikram, 2026-10-26): the words of a message's documents (PDF, Word, Excel,
// PowerPoint, OpenDocument, and text files) in search, as an index only, like body search: the files
// stay in the raw files (R2 objects). Cloudflare's converter (Workers AI toMarkdown) turns a document
// into text off this Worker's CPU, at no cost for documents; text files are decoded here. Images are
// skipped (describing them costs AI credits). The pass reads mail whose attachments aren't looked at
// yet: 'new' for mail copied since (each sync ends with it), 'all' for mail copied before too.
import { paidNow, r2Keys, type UserId } from '@mailcellar/schema';
import type { Env } from './env';
import { b64Bytes, binary, decodeBody, decodeWords, htmlToText, utf8 } from './gmail';
import { accountQuota } from './quota';
import { accountMailbox } from './sync';

/** Files the converter reads: by extension, with the types mail sends them as. */
const CONVERTED: Record<string, RegExp> = {
  pdf: /^application\/pdf$/,
  docx: /wordprocessingml\.document$/,
  odt: /opendocument\.text$/,
  xlsx: /spreadsheetml\.sheet$/,
  xlsm: /ms-excel\.sheet\.macroenabled/,
  xlsb: /ms-excel\.sheet\.binary/,
  xls: /^application\/vnd\.ms-excel$/,
  ods: /opendocument\.spreadsheet$/,
  numbers: /apple\.numbers$/,
  pptx: /presentationml\.presentation$/,
  ppsx: /presentationml\.slideshow$/,
  pptm: /ms-powerpoint\.presentation\.macroenabled/,
  odp: /opendocument\.presentation$/,
};
/** Files decoded here: their text is the file. */
const PLAIN = /^(txt|text|csv|tsv|md|markdown|json|xml|htm|html)$/;

/** A document the converter takes, at most (bigger ones are mostly scans with little text). */
export const DOC_MAX = 10 * 1024 * 1024;
/** Text a file keeps in search, at most. */
export const FILE_TEXT_MAX = 32 * 1024;
/** Files a message puts in search, at most. */
const FILES_MAX = 6;

export interface AttachmentPart {
  name: string;
  /** The converter's file extension, or 'text' for a file decoded here. */
  kind: string;
  bytes: Uint8Array;
  charset: string;
}

/** A part's file name: from filename= or name=, RFC 2231 (filename*=utf-8''…) and RFC 2047 both decoded. */
function fileName(header: string): string {
  const star = /\b(?:file)?name\*=([^']*)'[^']*'([^;\s]+)/i.exec(header);
  if (star) {
    try {
      return new TextDecoder(star[1] || 'utf-8').decode(Uint8Array.from(unescape(star[2]), (c) => c.charCodeAt(0)));
    } catch {
      return star[2];
    }
  }
  const plain = /\b(?:file)?name="([^"]*)"|\b(?:file)?name=([^;\s]+)/i.exec(header);
  return plain ? decodeWords(utf8(plain[1] ?? plain[2])).trim() : '';
}

/** What a part is, from its type and its file name's extension; null for anything not searched (images, archives…). */
function kindOf(type: string, name: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (ext in CONVERTED) return ext;
  for (const [k, re] of Object.entries(CONVERTED)) if (re.test(type)) return k;
  if (PLAIN.test(ext) || /^text\/(plain|csv|tab-separated-values|markdown|html|xml)$/.test(type)) return 'text';
  return null;
}

/**
 * A message's attached documents, decoded: parts sent as attachments or with a file name, of a type
 * search reads, up to FILES_MAX. Images, calendar invites and the message's own text are left out.
 */
export function attachmentParts(raw: Uint8Array): AttachmentPart[] {
  const out: AttachmentPart[] = [];
  const walk = (entity: string, depth: number, top: boolean) => {
    if (depth > 8 || out.length >= FILES_MAX) return;
    const split = entity.search(/\r?\n\r?\n/);
    const head = (split < 0 ? entity : entity.slice(0, split)).replace(/\r?\n[ \t]+/g, ' ');
    const body = split < 0 ? '' : entity.slice(split).replace(/^\r?\n\r?\n/, '');
    const h = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(head)?.[1] ?? '';
    const ctype = h('content-type');
    const type = ctype.toLowerCase().split(';')[0].trim();
    if (type.startsWith('multipart/')) {
      const boundary = /boundary="?([^";]+)"?/i.exec(ctype)?.[1];
      if (!boundary) return;
      for (const part of body.split(`--${boundary}`).slice(1)) {
        if (part.startsWith('--')) break;
        walk(part.replace(/^[ \t]*\r?\n/, ''), depth + 1, false);
      }
      return;
    }
    // A forwarded message: its own attachments count, its body is the forward's text.
    if (type === 'message/rfc822') return walk(body, depth + 1, true);
    if (top) return;
    const disposition = h('content-disposition');
    const name = fileName(disposition) || fileName(ctype);
    if (!name && !/^attachment/i.test(disposition)) return;
    const kind = kindOf(type, name);
    if (!kind) return;
    const encoding = h('content-transfer-encoding').toLowerCase().trim();
    // Base64 is 4 characters for 3 bytes: too big a file is skipped before it is decoded.
    if (body.length * 0.74 > DOC_MAX) return;
    const charset = /charset="?([^";\s]+)"?/i.exec(ctype)?.[1] ?? 'utf-8';
    let bytes: Uint8Array;
    try {
      if (encoding === 'base64') bytes = b64Bytes(body.replace(/[^A-Za-z0-9+/=]/g, ''));
      else if (kind === 'text') bytes = new TextEncoder().encode(decodeBody(body, encoding, charset));
      else return;
    } catch {
      return;
    }
    if (bytes.length) out.push({ name: name || `attachment.${kind === 'text' ? 'txt' : kind}`, kind, bytes, charset: encoding === 'base64' ? charset : 'utf-8' });
  };
  walk(binary(raw), 0, true);
  return out;
}

/** A file's text as search keeps it: spaces collapsed, at most FILE_TEXT_MAX. */
const tidy = (s: string) => s.replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, FILE_TEXT_MAX);

/** One file's text: decoded here for a text file, from the converter for a document; '' when it has none. */
async function fileText(env: Env, p: AttachmentPart, onCall: () => void): Promise<string> {
  if (p.kind === 'text') {
    let text: string;
    try {
      text = new TextDecoder(p.charset).decode(p.bytes);
    } catch {
      text = new TextDecoder().decode(p.bytes);
    }
    return tidy(/\.html?$/i.test(p.name) || /^\s*</.test(text) ? htmlToText(text) : text);
  }
  const name = /\.[a-z0-9]+$/i.test(p.name) && p.name.toLowerCase().endsWith(`.${p.kind}`) ? p.name : `${p.name}.${p.kind}`;
  onCall();
  try {
    const r = await env.AI.toMarkdown(
      { name, blob: new Blob([p.bytes]) },
      // Text only, and pictures inside a document are not described: that would cost AI credits.
      { conversionOptions: { output: { format: 'text' }, pdf: { images: { convert: false } }, docx: { images: { convert: false } } } },
    );
    return r.format === 'error' ? '' : tidy(r.data);
  } catch (e) {
    console.log(JSON.stringify({ attachments: { convertError: String(e).slice(0, 200), kind: p.kind } }));
    return '';
  }
}

/** What search keeps for a message's attachments: each file's name and text, and the names of those with text. */
export async function attachmentText(env: Env, raw: Uint8Array, onCall: () => void = () => {}): Promise<{ names: string[]; text: string }> {
  const parts = attachmentParts(raw);
  const names: string[] = [];
  const texts: string[] = [];
  for (const p of parts) {
    const t = await fileText(env, p, onCall);
    if (!t) continue;
    names.push(p.name.replace(/\n/g, ' '));
    texts.push(`${p.name}\n${t}`);
  }
  return { names, text: texts.join('\n\n') };
}

/** Messages a batch reads. */
const ATTACH_BATCH = 20;
/** Rows a message's attachments cost to write, about (its messages row, the FTS rows for up to 64 KB of text). */
export const ATTACH_ROWS = 12;
/**
 * CPU a run may spend, in estimated ms, like a copy lane's (copy.ts): Free stops a run at about 2 s.
 * Finding and decoding a message's files measured about 7 ms a MB locally; the estimate is 8.
 */
const RUN_CPU_MS = () => (paidNow() ? 10_000 : 900);
const attachCpuMs = (bytes: number) => 1 + (bytes / (1024 * 1024)) * 8;
/** Outside requests a run makes at most (Workers Free stops a run at 50): raw-file reads, converter and mailbox calls. */
const RUN_CALLS = () => (paidNow() ? 1000 : 44);
/** The calls a message can take at most: its raw file and a converter call a file. */
const MESSAGE_CALLS = 1 + FILES_MAX;
/** Calls a batch makes besides its messages': the guard, the mailbox twice, the meters. */
const BATCH_CALLS = 4;
/** Messages read and converted at once. */
const FLIGHT = 4;

export interface AttachResult {
  read: number;
  files: number;
  rowsWritten: number;
  bytes: number;
  cpuEstMs: number;
  calls: number;
  rawReads: number;
  done: boolean;
  nextId: string | null;
  resumesAt?: string;
}

/**
 * One attachment pass run: batches of mail with attachments not looked at yet, until its CPU budget is
 * spent, the daily write guard is near, or none are left. Each message's raw file is read whole
 * (one ranged read in its pack); a message whose raw file is gone is marked, so the pass moves on.
 */
export async function runAttachments(env: Env, user: UserId, account: string, runId: string, scope: 'new' | 'all'): Promise<AttachResult> {
  const mailbox = accountMailbox(env, user, account);
  const quota = accountQuota(env);
  const prefix = r2Keys.prefix(user);
  const out: AttachResult = { read: 0, files: 0, rowsWritten: 0, bytes: 0, cpuEstMs: 0, calls: 0, rawReads: 0, done: false, nextId: null };
  let full = false;
  // A batch starts only when its own calls and its in-flight messages' worst case still fit.
  while (!full && out.calls + BATCH_CALLS + FLIGHT * MESSAGE_CALLS <= RUN_CALLS()) {
    out.calls += BATCH_CALLS;
    const guard = await quota.reserve({ do_rows_written: ATTACH_BATCH * ATTACH_ROWS });
    if (guard) {
      out.resumesAt = guard.resumesAt;
      break;
    }
    const all = await mailbox.attachTodo(ATTACH_BATCH, scope);
    if (!all.length) {
      out.done = true;
      break;
    }
    // As many as the run's CPU allows (at least one); the rest stay waiting for the next run.
    const todo: typeof all = [];
    for (const t of all) {
      const est = attachCpuMs(t.len >= 0 ? t.len : 1024 * 1024);
      if (todo.length && out.cpuEstMs + est > RUN_CPU_MS()) {
        full = true;
        break;
      }
      out.cpuEstMs += est;
      todo.push(t);
    }
    const found: { id: string; names: string[]; text: string }[] = [];
    let next = 0;
    let reads = 0;
    const worker = async () => {
      while (next < todo.length) {
        // Out of calls: the rest stay waiting for the next run.
        if (out.calls + FLIGHT * MESSAGE_CALLS > RUN_CALLS()) {
          full = true;
          break;
        }
        const t = todo[next++];
        out.calls++;
        const key = t.key ?? r2Keys.raw(user, account, t.id);
        const placed = t.offset >= 0 && t.len >= 0;
        const obj = key.startsWith(prefix) ? await env.ARCHIVE.get(key, placed ? { range: { offset: t.offset, length: t.len } } : undefined) : null;
        reads++;
        if (!obj) {
          found.push({ id: t.id, names: [], text: '' });
          continue;
        }
        const raw =
          obj.httpMetadata?.contentEncoding === 'gzip'
            ? new Uint8Array(await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
            : new Uint8Array(await obj.arrayBuffer());
        out.bytes += raw.length;
        found.push({ id: t.id, ...(await attachmentText(env, raw, () => out.calls++)) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(FLIGHT, todo.length) }, worker));
    const r = await mailbox.addAttachments(found);
    await quota.add({ do_rows_written: r.rowsWritten, do_rows_read: todo.length * 2, r2_class_b: reads });
    out.read += found.length;
    out.files += found.reduce((n, f) => n + f.names.length, 0);
    out.rowsWritten += r.rowsWritten;
    out.rawReads += reads;
  }
  // The workflow starts the next run, after the guard's reset when it stopped for it.
  out.cpuEstMs = Math.round(out.cpuEstMs);
  if (!out.done) out.nextId = `${account}-attach-${Date.now().toString(36)}`;
  console.log(JSON.stringify({ attachments: { account, runId, scope, ...out } }));
  return out;
}
