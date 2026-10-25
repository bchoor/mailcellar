// Shared names and shapes for the Worker, the mailbox Durable Object and the app.
// Every store is keyed by the user, so one user's data is never addressable from
// another's session (design doc, "Per-user storage layout").

/** Opaque, stable user ID (never an email address). */
export type UserId = string & { readonly __brand: 'UserId' };

/** Gmail message ID as Gmail returns it. */
export type GmailId = string;

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function asUserId(id: string): UserId {
  if (!SAFE_ID.test(id)) throw new Error('invalid user id');
  return id as UserId;
}

/** Name of the user's mailbox Durable Object: one per user and mailbox. */
export function mailboxName(user: UserId, mailbox = 'default'): string {
  if (!SAFE_ID.test(mailbox)) throw new Error('invalid mailbox name');
  return `${user}:${mailbox}`;
}

function accountPrefix(user: UserId, account: string): string {
  if (!SAFE_ID.test(account)) throw new Error('invalid account');
  return `u/${user}/a/${account}/`;
}
function safeMonth(month: string): string {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('invalid month');
  return month;
}

/** R2 keys, all under the user's own prefix. */
export const r2Keys = {
  prefix: (user: UserId) => `u/${user}/`,
  /** A message as Gmail sent it; gzipped when small (contentEncoding says which). */
  raw: (user: UserId, account: string, gmailId: GmailId) => {
    if (!SAFE_ID.test(account) || !/^[0-9a-f]{1,16}$/.test(gmailId)) throw new Error('invalid raw key');
    return `u/${user}/a/${account}/raw/${gmailId}.eml`;
  },
  /** A batch of Basin rows waiting to be committed (gzipped JSON). */
  basinQueue: (user: UserId, account: string, batch: string) => {
    if (!SAFE_ID.test(account) || !SAFE_ID.test(batch)) throw new Error('invalid queue key');
    return `u/${user}/a/${account}/basin-queue/${batch}.json.gz`;
  },
  /** One lane's progress copying a month (JSON): the copy path keeps its state here, not in a Durable Object. */
  lane: (user: UserId, account: string, month: string) => `${accountPrefix(user, account)}lanes/${safeMonth(month)}.json`,
  lanes: (user: UserId, account: string) => `${accountPrefix(user, account)}lanes/`,
  /** One Gmail batch of raw mail, the messages end to end; Basin keeps each one's offset and length. */
  pack: (user: UserId, account: string, month: string, name: string) => {
    if (!SAFE_ID.test(name)) throw new Error('invalid pack name');
    return `${accountPrefix(user, account)}packs/${safeMonth(month)}/${name}.raw`;
  },
  /** Basin rows a lane run copied, waiting for the account's committer (JSON). */
  staged: (user: UserId, account: string, month: string, run: string) => {
    if (!SAFE_ID.test(run)) throw new Error('invalid staged name');
    return `${accountPrefix(user, account)}staged/${safeMonth(month)}_${run}.json`;
  },
  stagedPrefix: (user: UserId, account: string, month?: string) => `${accountPrefix(user, account)}staged/${month ? `${safeMonth(month)}_` : ''}`,
  /** The message IDs a month has in Basin, written when it lands: what copying it again skips. */
  copied: (user: UserId, account: string, month: string) => `${accountPrefix(user, account)}copied/${safeMonth(month)}.json`,
  /** The message IDs Gmail lists for a month, saved when its index is built: what the month counts as in Basin. */
  listed: (user: UserId, account: string, month: string) => `${accountPrefix(user, account)}listed/${safeMonth(month)}.json`,
  /** Where each of a month's messages is in the raw files (JSON), built from Basin the first time one is opened. */
  locations: (user: UserId, account: string, month: string) => `${accountPrefix(user, account)}locations/${safeMonth(month)}.json`,
  /** Which run is the account's Basin committer, and when it last checked in. */
  committer: (user: UserId, account: string) => `${accountPrefix(user, account)}committer.json`,
  attachment: (user: UserId, sha256: string) => {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid sha256');
    return `u/${user}/att/${sha256}`;
  },
};

/** Basin Catalog namespace for the user's Iceberg tables. */
export const basinNamespace = (user: UserId) => `u_${user}`;

/** Response of GET /api/health. */
export interface Health {
  ok: true;
  service: 'mailcellar';
  version: string;
}

export * from './mail';
export * from './ops';
export * from './auth';
export * from './sync';
export * from './gmail';
export * from './quota';
