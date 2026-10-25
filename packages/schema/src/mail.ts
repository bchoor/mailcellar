// Shapes of indexed mail, shared by the sync path, the mailbox DO and the app.
// The DO keeps only what the archive pages need (S4: 635 bytes a message);
// bodies and headers live in R2 and, from phase 2, in Basin.
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

/** Sender domain, lower-cased: the Domains page groups on it. */
export function domainOf(addr: string): string {
  const at = addr.lastIndexOf('@');
  return at < 0 ? '' : addr.slice(at + 1).toLowerCase();
}

/** Calendar month of a message, UTC, as YYYY-MM: the Time page groups on it. */
export const monthOf = (ts: number) => new Date(ts).toISOString().slice(0, 7);

/**
 * Basin Catalog (Iceberg) tables, one set per user under basinNamespace(user).
 * The system of record; written by the sync Workflow with icebird in phase 2.
 */
export const BASIN_TABLES = {
  messages: {
    partitionBy: { column: 'ts', transform: 'month' },
    columns: [
      { name: 'id', type: 'string', required: true },
      { name: 'thread_id', type: 'string', required: true },
      { name: 'ts', type: 'timestamptz', required: true },
      { name: 'from_addr', type: 'string', required: true },
      { name: 'from_name', type: 'string' },
      { name: 'to_addrs', type: 'list<string>' },
      { name: 'cc_addrs', type: 'list<string>' },
      { name: 'subject', type: 'string' },
      { name: 'snippet', type: 'string' },
      { name: 'body_text', type: 'string' },
      { name: 'labels', type: 'list<string>' },
      { name: 'size', type: 'long', required: true },
      { name: 'attachments', type: 'int', required: true },
      { name: 'raw_key', type: 'string', required: true },
      { name: 'synced_at', type: 'timestamptz', required: true },
      // Added 2026-10-24: raw mail is packed, many messages to a file; a message is these bytes of raw_key.
      { name: 'raw_offset', type: 'long' },
      { name: 'raw_len', type: 'long' },
    ],
  },
  attachments: {
    partitionBy: null,
    columns: [
      { name: 'message_id', type: 'string', required: true },
      { name: 'sha256', type: 'string', required: true },
      { name: 'filename', type: 'string' },
      { name: 'mime_type', type: 'string' },
      { name: 'size', type: 'long', required: true },
      { name: 'r2_key', type: 'string', required: true },
    ],
  },
} as const;

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

export type MessageRow = IndexedMessage & { state: MessageState };
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
  key: 'from' | 'domain' | 'subject' | 'label' | 'text' | 'size' | 'attachments' | 'range';
  values: string[];
  not?: boolean;
  op?: 'gt' | 'lt' | 'eq' | 'between';
}
export const MESSAGE_PAGE_SIZES = [25, 50, 100] as const;
/** One page of messages, newest first (or oldest first), and where the next starts. */
export interface MessagePage {
  rows: MessageRow[];
  /** Pass back as `cursor` for the next page; null on the last. */
  next: string | null;
  /** Every message the filter matches, when known without scanning (no filter: the months' sum). */
  total: number | null;
  /** The page stopped at the scan budget before it filled: Next keeps searching. */
  partial: boolean;
  /** Months copied to Basin whose mail is not in this index yet (not shown here). */
  unindexed: number;
}

const FILTER_KEYS: readonly MessageFilter['key'][] = ['from', 'domain', 'subject', 'label', 'text', 'size', 'attachments', 'range'];
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
