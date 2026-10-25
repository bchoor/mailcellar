// One message opened from the Messages page. Its mailbox row says which raw file holds it and at
// which bytes (one keyed DO read); only those bytes are read, then parsed here. No Gmail call.
// Until its location has moved from Basin into the mailbox (locate.ts, 2026-10-25), a message
// is found through Basin as before.
import { basinNamespace, mailboxName, r2Keys, type MailAddress, type MessageAttachment, type MessageDetail, type UserId } from '@mailcellar/schema';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { restCatalogLoadTable } from 'icebird';
import PostalMime, { type Address, type Attachment, type Email } from 'postal-mime';
import { basinCatalog, MESSAGES_TABLE, monthFiles, r2Resolver, type TableMetadata } from './basin';
import type { Env } from './env';

/** Inline images past this many bytes, all told, stay as cid: links rather than data URLs. */
const INLINE_MAX = 4 * 1024 * 1024;

/**
 * Where every message of one account's month is in the raw files: the pack files once each, and
 * per message ID its pack and, inside it, offset and length (-1 for a file of its own).
 */
interface Locations {
  packs: string[];
  at: Record<string, [number, number, number]>;
}

// Months already read, for this isolate: an open after the first reads no file to find its message.
const months = new Map<string, Locations>();

/** Every message of the month from its Basin rows; null when Basin has no table yet. */
async function fromBasin(env: Env, user: UserId, account: string, month: string): Promise<Locations | null> {
  if (!env.BASIN_TOKEN) return null;
  let metadata;
  try {
    ({ metadata } = await restCatalogLoadTable(await basinCatalog(env), { namespace: basinNamespace(user), table: MESSAGES_TABLE }));
  } catch (e) {
    if (/404|not ?found|NoSuch/i.test(String(e))) return null;
    throw e;
  }
  const resolver = r2Resolver(env.ARCHIVE, env.BASIN_BUCKET);
  const files = await monthFiles(metadata as TableMetadata, resolver, month);
  const loc: Locations = { packs: [], at: {} };
  const pack = new Map<string, number>();
  await Promise.all(
    files.map(async (f) => {
      const file = await resolver.reader(f.path, f.size);
      const meta = await parquetMetadataAsync(file);
      // Files written before raw_offset and raw_len were added hold whole-file messages only.
      const has = new Set(meta.schema.map((c) => c.name));
      const rows = (await parquetReadObjects({
        file,
        metadata: meta,
        columns: ['account', 'id', 'raw_key', 'raw_offset', 'raw_len'].filter((c) => has.has(c)),
        filter: { account: { $eq: account } },
      })) as { id: string; raw_key: string; raw_offset?: bigint | number | null; raw_len?: bigint | number | null }[];
      for (const r of rows) {
        if (!r.raw_key) continue;
        let p = pack.get(r.raw_key);
        if (p === undefined) pack.set(r.raw_key, (p = loc.packs.push(r.raw_key) - 1));
        loc.at[r.id] = [p, r.raw_offset == null ? -1 : Number(r.raw_offset), r.raw_len == null ? -1 : Number(r.raw_len)];
      }
    }),
  );
  return loc;
}

/**
 * The month's locations: this isolate's copy, else its raw file, else read from Basin once and
 * saved as a raw file (one object write a month; no Durable Object read or write). `fresh` reads
 * Basin again, for a message copied after the file was saved.
 */
async function monthLocations(env: Env, user: UserId, account: string, month: string, fresh = false): Promise<Locations | null> {
  const name = `${user}/${account}/${month}`;
  const key = r2Keys.locations(user, account, month);
  let loc = fresh ? undefined : months.get(name);
  if (!loc && !fresh) {
    const obj = await env.ARCHIVE.get(key);
    if (obj) loc = (await obj.json()) as Locations;
  }
  if (!loc) {
    const built = await fromBasin(env, user, account, month);
    if (!built) return null;
    loc = built;
    if (loc.packs.length) await env.ARCHIVE.put(key, JSON.stringify(loc), { httpMetadata: { contentType: 'application/json' } });
  }
  months.set(name, loc);
  if (months.size > 24) months.delete(months.keys().next().value!);
  return loc;
}

/** Warm a month before any of its messages is opened (the Messages page asks for the months it shows). */
export async function warmMonth(env: Env, user: UserId, account: string, month: string): Promise<number> {
  return Object.keys((await monthLocations(env, user, account, month))?.at ?? {}).length;
}

/** Where the message's bytes are: whole of `key`, or `len` bytes at `offset`. */
async function locate(env: Env, user: UserId, account: string, id: string, month: string): Promise<{ key: string; offset: number; len: number }> {
  const own = await env.MAILBOX.getByName(mailboxName(user, account)).location(id);
  if (own) return own;
  let loc = await monthLocations(env, user, account, month);
  if (loc && !loc.at[id]) loc = await monthLocations(env, user, account, month, true);
  const at = loc?.at[id];
  // Mail the live sync copied before Basin rows carried an offset sits in a file of its own.
  if (!loc || !at) return { key: r2Keys.raw(user, account, id), offset: -1, len: -1 };
  return { key: loc.packs[at[0]], offset: at[1], len: at[2] };
}

/** The message's own bytes, or null when no raw file holds it. */
async function rawBytes(env: Env, user: UserId, account: string, id: string, month: string): Promise<Uint8Array | null> {
  const at = await locate(env, user, account, id, month);
  // Basin's own rows point inside this person's prefix; anything else is refused.
  if (!at.key.startsWith(r2Keys.prefix(user))) return null;
  const obj = await env.ARCHIVE.get(at.key, at.offset >= 0 && at.len >= 0 ? { range: { offset: at.offset, length: at.len } } : undefined);
  if (!obj) return null;
  if (obj.httpMetadata?.contentEncoding === 'gzip') return new Uint8Array(await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return new Uint8Array(await obj.arrayBuffer());
}

const parse = (raw: Uint8Array) => PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });

function addresses(list: Address[] | undefined): MailAddress[] {
  return (list ?? []).flatMap((a) => (a.group ? a.group : [a])).map((a) => ({ name: a.name ?? '', address: a.address ?? '' }));
}
const bytesOf = (a: Attachment) => (typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content as ArrayBuffer));
/** Attachments the person sees: not the images the HTML shows in place. */
const listed = (mail: Email) => mail.attachments.map((a, index) => ({ a, index })).filter(({ a }) => !(a.related && a.contentId && mail.html));

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** HTML with its cid: images as data URLs, up to INLINE_MAX in all. */
function inlineImages(mail: Email): string | null {
  if (!mail.html) return null;
  const byCid = new Map<string, Attachment>();
  for (const a of mail.attachments) if (a.contentId) byCid.set(a.contentId.replace(/^<|>$/g, '').toLowerCase(), a);
  if (!byCid.size) return mail.html;
  let budget = INLINE_MAX;
  return mail.html.replace(/cid:([^"'\s)>]+)/gi, (whole, cid: string) => {
    const a = byCid.get(decodeURIComponent(cid).toLowerCase());
    if (!a || !a.mimeType.startsWith('image/')) return whole;
    const b = bytesOf(a);
    if (b.length > budget) return whole;
    budget -= b.length;
    return `data:${a.mimeType};base64,${base64(b)}`;
  });
}

/** GET /api/accounts/:id/messages/:mid?month=: the message, parsed; null when no raw file holds it. */
export async function openMessage(env: Env, user: UserId, account: string, id: string, month: string): Promise<MessageDetail | null> {
  const raw = await rawBytes(env, user, account, id, month);
  if (!raw) return null;
  const mail = await parse(raw);
  const from = addresses(mail.from ? [mail.from] : undefined)[0] ?? null;
  const date = mail.date && !Number.isNaN(Date.parse(mail.date)) ? new Date(mail.date).toISOString() : null;
  const attachments: MessageAttachment[] = listed(mail).map(({ a, index }) => ({
    index,
    filename: a.filename || `attachment-${index + 1}`,
    mimeType: a.mimeType,
    size: bytesOf(a).length,
  }));
  return {
    from, to: addresses(mail.to), cc: addresses(mail.cc), bcc: addresses(mail.bcc), replyTo: addresses(mail.replyTo),
    date, subject: mail.subject ?? '', html: inlineImages(mail), text: mail.text ?? null, attachments,
  };
}

/** Types the app may show in place; anything else is only ever a download. SVG stays out: as a page it can run scripts. */
const VIEWABLE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/(plain|csv)|application\/json)$/i;

/**
 * GET /api/accounts/:id/messages/:mid/attachments/:n?month=: one attachment, as a download; with
 * `view=1` a viewable type comes as itself (for the preview), still unable to run on this site.
 */
export async function attachment(env: Env, user: UserId, account: string, id: string, month: string, index: number, view = false): Promise<Response | null> {
  const raw = await rawBytes(env, user, account, id, month);
  if (!raw) return null;
  const a = (await parse(raw)).attachments[index];
  if (!a) return null;
  const name = (a.filename || `attachment-${index + 1}`).replace(/[\r\n"\\]/g, '_');
  const type = a.mimeType.split(';')[0].trim().toLowerCase();
  const shown = view && VIEWABLE.test(type);
  // Text is read as text by the app; JSON or CSV opened directly shows as plain text, never as a page.
  const as = shown ? (type.startsWith('text/') || type === 'application/json' ? 'text/plain; charset=utf-8' : type) : 'application/octet-stream';
  return new Response(bytesOf(a), {
    headers: {
      'content-type': as,
      'content-disposition': `${shown ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
      // Opened on its own, nothing in it can run, load or be framed elsewhere.
      'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
      'cache-control': 'private, max-age=86400',
    },
  });
}
