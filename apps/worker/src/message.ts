// One message opened from the Messages page. Its mailbox row says which raw file holds it and at
// which bytes; only those bytes are read, then parsed in its mailbox's Durable Object, which keeps
// the last message it parsed: a burst of requests for one message (its attachments' previews)
// parses it once. No Gmail call.
import { mailboxName, r2Keys, type MailAddress, type MessageAttachment, type MessageDetail, type UserId } from '@mailcellar/schema';
import PostalMime, { type Address, type Attachment, type Email } from 'postal-mime';
import type { Env } from './env';
import { htmlToText } from './gmail';

/** Inline images past this many bytes, all told, stay as cid: links rather than data URLs. */
const INLINE_MAX = 4 * 1024 * 1024;

type Location = { key: string; offset: number; len: number } | null;

/** The message's own bytes, or null when no raw file holds it. Mail with no location sits in a file of its own. */
async function rawBytes(env: Env, user: UserId, account: string, id: string, location: Location): Promise<Uint8Array | null> {
  const at = location ?? { key: r2Keys.raw(user, account, id), offset: -1, len: -1 };
  // Locations point inside this person's prefix; anything else is refused.
  if (!at.key.startsWith(r2Keys.prefix(user))) return null;
  const obj = await env.ARCHIVE.get(at.key, at.offset >= 0 && at.len >= 0 ? { range: { offset: at.offset, length: at.len } } : undefined);
  if (!obj) return null;
  if (obj.httpMetadata?.contentEncoding === 'gzip') return new Uint8Array(await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return new Uint8Array(await obj.arrayBuffer());
}

/** The message parsed, or null when no raw file holds it. Runs in the mailbox's Durable Object (MailboxDO.mail). */
export async function readMail(env: Env, user: UserId, account: string, id: string, location: Location): Promise<Email | null> {
  const raw = await rawBytes(env, user, account, id, location);
  return raw ? PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' }) : null;
}

const mailbox = (env: Env, user: UserId, account: string) => env.MAILBOX.getByName(mailboxName(user, account));

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
  return mailbox(env, user, account).messagePart(user, account, id, { part: 'detail' }) as Promise<MessageDetail | null>;
}

/** The message as the app shows it: headers, HTML with its images in place, attachments. */
export function detailOf(mail: Email): MessageDetail {
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

/** The message for a reader with no screen (the MCP server): headers, attachments, and its body as plain text. */
export async function messageText(env: Env, user: UserId, account: string, id: string): Promise<MessageText | null> {
  return mailbox(env, user, account).messagePart(user, account, id, { part: 'text' }) as Promise<MessageText | null>;
}

export type MessageText = Omit<MessageDetail, 'html' | 'text'> & { body: string };
export type MessageFile = { filename: string; mimeType: string; bytes: Uint8Array };

export function textOf(mail: Email): MessageText {
  const date = mail.date && !Number.isNaN(Date.parse(mail.date)) ? new Date(mail.date).toISOString() : null;
  return {
    from: addresses(mail.from ? [mail.from] : undefined)[0] ?? null,
    to: addresses(mail.to), cc: addresses(mail.cc), bcc: addresses(mail.bcc), replyTo: addresses(mail.replyTo),
    date, subject: mail.subject ?? '',
    attachments: listed(mail).map(({ a, index }) => ({ index, filename: a.filename || `attachment-${index + 1}`, mimeType: a.mimeType, size: bytesOf(a).length })),
    body: (mail.text ?? (mail.html ? htmlToText(mail.html) : '')).trim(),
  };
}

/** One attachment's name, type and bytes; null when the message or the attachment isn't there. */
export async function attachmentFile(env: Env, user: UserId, account: string, id: string, index: number): Promise<MessageFile | null> {
  return mailbox(env, user, account).messagePart(user, account, id, { part: 'file', index }) as Promise<MessageFile | null>;
}

export function fileOf(mail: Email, index: number): MessageFile | null {
  const a = mail.attachments[index];
  if (!a) return null;
  return { filename: a.filename || `attachment-${index + 1}`, mimeType: a.mimeType.split(';')[0].trim().toLowerCase(), bytes: bytesOf(a) };
}

/** Types the app may show in place; anything else is only ever a download. SVG stays out: as a page it can run scripts. */
const VIEWABLE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/(plain|csv)|application\/json)$/i;

/**
 * GET /api/accounts/:id/messages/:mid/attachments/:n?month=: one attachment, as a download; with
 * `view=1` a viewable type comes as itself (for the preview), still unable to run on this site.
 */
export async function attachment(env: Env, user: UserId, account: string, id: string, month: string, index: number, view = false): Promise<Response | null> {
  const a = await attachmentFile(env, user, account, id, index);
  if (!a) return null;
  const name = a.filename.replace(/[\r\n"\\]/g, '_');
  const type = a.mimeType;
  const shown = view && VIEWABLE.test(type);
  // Text is read as text by the app; JSON or CSV opened directly shows as plain text, never as a page.
  const as = shown ? (type.startsWith('text/') || type === 'application/json' ? 'text/plain; charset=utf-8' : type) : 'application/octet-stream';
  return new Response(a.bytes, {
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
