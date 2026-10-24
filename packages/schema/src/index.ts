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
