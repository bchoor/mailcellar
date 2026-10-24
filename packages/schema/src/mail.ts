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
