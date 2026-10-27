// Shapes of indexed mail, shared by the sync path, the mailbox DO and the app.
// The DO keeps only what the archive pages need (S4: 635 bytes a message);
// bodies and headers live in raw files (R2 objects).
import type { GmailId } from './index';

/** One message as the mailbox DO indexes it. */
export interface IndexedMessage {
  id: GmailId;
  threadId: string;
  /** Gmail internalDate, in ms since the epoch. */
  ts: number;
  fromAddr: string;
  fromName: string;
  subject: string;
  /** Gmail's snippet: at most 200 characters, already plain text. */
  snippet: string;
  /** Gmail sizeEstimate, in bytes. */
  size: number;
  attachments: number;
  /** Gmail label IDs, such as INBOX or Label_12. */
  labels: string[];
  /** The raw file (R2 object) holding the message, and where in it: offset and length, absent for a file of one. */
  raw?: string;
  rawOffset?: number;
  rawLen?: number;
  /** Body text for search only (index, never stored): absent for mail indexed before body search. */
  body?: string;
  /** To, Cc and Bcc addresses, lower case, space separated: absent for mail indexed before recipients were kept. */
  rcpt?: string;
}

/** A Gmail label as labels.list returns it. */
export interface MailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
}

const GMAIL_ID = /^[0-9a-f]{1,16}$/;

/**
 * The FTS5 rowid for a Gmail ID, as a decimal string to bind with CAST(? AS INTEGER).
 * Gmail IDs are up to 16 hex digits, so they fill a signed 64-bit integer exactly and
 * map one to one; a JS number would lose precision past 2^53.
 */
export function ftsRowid(id: GmailId): string {
  if (!GMAIL_ID.test(id)) throw new Error('invalid gmail id');
  return BigInt.asIntN(64, BigInt(`0x${id}`)).toString();
}

/**
 * SQL: the message IDs an FTS5 table's MATCH ? finds, for `id IN (...)`. A rowid prints back as
 * hex two ways: bare for a Gmail ID, zero padded to 16 for an imported ID (which can start with 0).
 */
export function ftsIds(table: 'message_fts' | 'body_fts' | 'attach_fts'): string {
  return `SELECT printf(f.p, ${table}.rowid) FROM ${table}, (SELECT '%x' AS p UNION ALL SELECT '%016x') f WHERE ${table} MATCH ?`;
}

/** Sender domain, lower-cased: the Domains page groups on it. */
export function domainOf(addr: string): string {
  const at = addr.lastIndexOf('@');
  return at < 0 ? '' : addr.slice(at + 1).toLowerCase();
}

/** Calendar month of a message, UTC, as YYYY-MM: the Time page groups on it. */
export const monthOf = (ts: number) => new Date(ts).toISOString().slice(0, 7);

/** The archive pages and the rows each one reads, newest or biggest first. */
export interface MonthRow { month: string; n: number; bytes: number }
export interface LabelRow { id: string; name: string; type: 'system' | 'user'; n: number; bytes: number }
export interface DomainRow { domain: string; n: number; bytes: number }
export interface SenderRow { addr: string; name: string; n: number; bytes: number; firstTs: number; lastTs: number }
/**
 * Where a message lives. MailCellar always holds at least what Gmail holds:
 * live is in both; archived was trashed in Gmail after MailCellar's copy was confirmed.
 * A purged message is gone from both, so it has no row.
 */
export type MessageState = 'live' | 'archived';
export const MESSAGE_STATES: readonly MessageState[] = ['live', 'archived'];

export type MessageRow = IndexedMessage & {
  state: MessageState;
  /** Under a text search: the words were found only in the body, so the row's snippet doesn't show them. */
  bodyHit?: boolean;
  /** Under a text search: the words were found in an attachment's text; the name of the file (the first, if several). */
  attachHit?: string;
};
/** The part of a message's body where a search's words are, and each word's place in it ([start, end) in `text`). */
export interface BodySnippet {
  text: string;
  hits: [number, number][];
}
export interface ArchiveRows {
  months: MonthRow;
  labels: LabelRow;
  domains: DomainRow;
  senders: SenderRow;
  messages: MessageRow;
}
export type ArchiveView = keyof ArchiveRows;
export const ARCHIVE_VIEWS: readonly ArchiveView[] = ['months', 'labels', 'domains', 'senders', 'messages'];

/** At most this many rows a page: the rest is reached by search, not by scrolling. */
export const ARCHIVE_LIMIT = 1000;

/**
 * One filter on the Messages page, applied by the server: a chip's values (any of them matches),
 * or with `not` none of them. `from`, `domain` and `subject` match text within; `label` a label's
 * name or id; `text` searches subject, sender and snippet. `size` (bytes) and `attachments` take
 * an `op` (`gt`, `lt`, `eq`, or `between` with `a..b`). `range` values are `from..to` in epoch ms.
 */
export interface MessageFilter {
  key: 'from' | 'to' | 'domain' | 'subject' | 'label' | 'text' | 'size' | 'attachments' | 'range';
  values: string[];
  not?: boolean;
  op?: 'gt' | 'lt' | 'eq' | 'between';
}
export const MESSAGE_PAGE_SIZES = [25, 50, 100] as const;
/** What the server can order messages by: Date always; Sender and Size once their indexes are built. */
export const MESSAGE_SORTS = ['date', 'from', 'size', 'attachments', 'category'] as const;
export type MessageSort = (typeof MESSAGE_SORTS)[number];
/** What the server groups messages by, each from a rollup: Sender, Domain, Category, Labels, Read. */
export const MESSAGE_GROUPS = ['from', 'domain', 'category', 'label', 'is'] as const;
export type MessageGroupBy = (typeof MESSAGE_GROUPS)[number];
/** One group: its key as the page shows it, its count from the rollup (null under other filters,
 *  which the rollup can't apply), and the filter that loads its rows. */
export interface MessageGroup {
  key: string;
  n: number | null;
  filter: MessageFilter;
}
/** A page of groups, largest first, and where the next starts. */
export interface MessageGroups {
  groups: MessageGroup[];
  next: string | null;
  /** Every group there is, on the first page only (null on later pages). */
  total: number | null;
}
/** One page of messages, newest first (or oldest first), and where the next starts. */
export interface MessagePage {
  rows: MessageRow[];
  /** Pass back as `cursor` for the next page; null on the last. */
  next: string | null;
  /** Every message the filter matches, when known without scanning (no filter: the months' sum). */
  total: number | null;
  /** The page stopped at the scan budget before it filled: Next keeps searching. */
  partial: boolean;
  /** Months copied whose mail is not in this index yet (not shown here). */
  unindexed: number;
  /** The orders this mailbox can serve now; a page asked in another comes by date. */
  sorts: MessageSort[];
}

const FILTER_KEYS: readonly MessageFilter['key'][] = ['from', 'to', 'domain', 'subject', 'label', 'text', 'size', 'attachments', 'range'];
const FILTER_OPS: readonly NonNullable<MessageFilter['op']>[] = ['gt', 'lt', 'eq', 'between'];
/** The `f` query parameter (JSON filters) checked; null when it is not a list of filters. */
export function messageFilters(raw: string | null): MessageFilter[] | null {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length > 12) return null;
  const out: MessageFilter[] = [];
  for (const f of v as Partial<MessageFilter>[]) {
    if (!f || !FILTER_KEYS.includes(f.key!) || !Array.isArray(f.values) || !f.values.length || f.values.length > 20) return null;
    if (!f.values.every((x) => typeof x === 'string' && x.length <= 200)) return null;
    if (f.op !== undefined && !FILTER_OPS.includes(f.op)) return null;
    out.push({ key: f.key!, values: f.values, ...(f.not ? { not: true } : {}), ...(f.op ? { op: f.op } : {}) });
  }
  return out;
}

/** The account's labels as Gmail has them now, by label id: name, type, and colours (`#fb4c2f` style hex) when set. */
export type GmailLabels = Record<string, { name: string; type: 'system' | 'user'; bg?: string; fg?: string }>;

/** A name and address on a message, as its headers give them. */
export interface MailAddress { name: string; address: string }
/** One attachment of an opened message; `index` is what its download asks for. */
export interface MessageAttachment { index: number; filename: string; mimeType: string; size: number }
/**
 * One message opened from the Messages page, parsed from its raw file. `html` has its inline
 * (cid:) images as data URLs; remote images stay as written, for the app to block or show.
 */
export interface MessageDetail {
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  /** ISO time from the Date header, when it parses. */
  date: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  attachments: MessageAttachment[];
}
