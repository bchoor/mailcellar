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
  raw: (user: UserId, gmailId: GmailId) => `u/${user}/raw/${gmailId}.eml.gz`,
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
export * from './sample';
