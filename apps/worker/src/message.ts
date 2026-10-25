// One message opened from the Messages page. Its Basin row says which raw file holds it and
// at which bytes; only those bytes are read, then parsed here. No Gmail call and no Durable
// Object read or write: the raw files and Basin are under the person's own prefix.
import { basinNamespace, r2Keys, type MailAddress, type MessageAttachment, type MessageDetail, type UserId } from '@mailcellar/schema';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { restCatalogConnect, restCatalogLoadTable } from 'icebird';
import PostalMime, { type Address, type Attachment, type Email } from 'postal-mime';
import { MESSAGES_TABLE, monthFiles, r2Resolver, type TableMetadata } from './basin';
import type { Env } from './env';

/** Where a message's bytes are: the whole of `key`, or `len` bytes from `offset` of a pack. */
interface RawAt {
  key: string;
  offset: number | null;
  len: number | null;
}

/** Inline images past this many bytes, all told, stay as cid: links rather than data URLs. */
const INLINE_MAX = 4 * 1024 * 1024;

// Opened messages are read again for their attachments: keep where each one is for this isolate.
const located = new Map<string, RawAt>();

/** The message's place in the raw files, from its Basin row in that month; null when Basin has none. */
async function fromBasin(env: Env, user: UserId, account: string, id: string, month: string): Promise<RawAt | null> {
  if (!env.BASIN_TOKEN) return null;
  const catalog = await restCatalogConnect({
    url: env.BASIN_CATALOG_URI,
    warehouse: env.BASIN_WAREHOUSE,
    requestInit: { headers: { authorization: `Bearer ${env.BASIN_TOKEN}` } },
  });
  let metadata;
  try {
    ({ metadata } = await restCatalogLoadTable(catalog, { namespace: basinNamespace(user), table: MESSAGES_TABLE }));
  } catch (e) {
    if (/404|not ?found|NoSuch/i.test(String(e))) return null;
    throw e;
  }
  const resolver = r2Resolver(env.ARCHIVE, env.BASIN_BUCKET);
  const files = await monthFiles(metadata as TableMetadata, resolver, month);
  // Each file's row groups whose id range can't hold the message are skipped on their statistics.
  const hits = await Promise.all(
    files.map(async (f) => {
      const file = await resolver.reader(f.path, f.size);
      const metadata = await parquetMetadataAsync(file);
      // Files written before raw_offset and raw_len were added hold whole-file messages only.
      const has = new Set(metadata.schema.map((c) => c.name));
      const rows = (await parquetReadObjects({
        file,
        metadata,
        columns: ['account', 'id', 'raw_key', 'raw_offset', 'raw_len'].filter((c) => has.has(c)),
        filter: { id: { $eq: id } },
      })) as { account: string; raw_key: string; raw_offset: bigint | number | null; raw_len: bigint | number | null }[];
      return rows.find((r) => r.account === account && r.raw_key) ?? null;
    }),
  );
  const row = hits.find((r) => r !== null);
  if (!row) return null;
  return { key: row.raw_key, offset: row.raw_offset == null ? null : Number(row.raw_offset), len: row.raw_len == null ? null : Number(row.raw_len) };
}

/** The message's own bytes, or null when no raw file holds it. */
async function rawBytes(env: Env, user: UserId, account: string, id: string, month: string): Promise<Uint8Array | null> {
  const cacheKey = `${user}/${account}/${id}`;
  let at = located.get(cacheKey) ?? (await fromBasin(env, user, account, id, month));
  // Mail the live sync copied before Basin rows carried an offset sits in a file of its own.
  at ??= { key: r2Keys.raw(user, account, id), offset: null, len: null };
  // Basin's own rows point inside this person's prefix; anything else is refused.
  if (!at.key.startsWith(r2Keys.prefix(user))) return null;
  const obj = await env.ARCHIVE.get(at.key, at.offset !== null && at.len !== null ? { range: { offset: at.offset, length: at.len } } : undefined);
  if (!obj) return null;
  located.set(cacheKey, at);
  if (located.size > 500) located.delete(located.keys().next().value!);
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

/** GET /api/accounts/:id/messages/:mid/attachments/:n?month=: one attachment, always as a download. */
export async function attachment(env: Env, user: UserId, account: string, id: string, month: string, index: number): Promise<Response | null> {
  const raw = await rawBytes(env, user, account, id, month);
  if (!raw) return null;
  const a = (await parse(raw)).attachments[index];
  if (!a) return null;
  const name = (a.filename || `attachment-${index + 1}`).replace(/[\r\n"\\]/g, '_');
  // Served as bytes to save, never as a page: an HTML attachment can't run on this site.
  return new Response(bytesOf(a), {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=86400',
    },
  });
}
