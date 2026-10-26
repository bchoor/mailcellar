// What the people kit (@columenlabs/lumen-people) needs to know about MailCellar: who the built-in
// admins are, and the one thing access is given on. Each person's mail is their own, so there is
// one scope: whether they may use MailCellar at all. Admins also manage people.
import type { PeopleService } from '@columenlabs/lumen-people';
import type { Scope } from '@columenlabs/lumen-ui-types/people';
import type { Env } from './env';

export const SCOPES: Scope[] = [
  {
    id: 'mail',
    name: 'MailCellar',
    icon: 'mail',
    // An invite to MailCellar is an invite to use it.
    inviteLevel: 'use',
    description: 'Their own mailboxes and mail',
    levels: [
      { id: 'none', label: 'No access' },
      { id: 'use', label: 'Use', description: 'Add their own Gmail accounts and mbox archives, and search their own mail. Nobody else sees it.' },
    ],
  },
];
export const MAIL_SCOPE = SCOPES[0];
export const INVITE_DAYS = 7;

/** The people service's calls the Worker makes through QuotaDO. */
export type PeopleOp = 'list' | 'invite' | 'resend' | 'revoke' | 'update' | 'setAccess' | 'removable' | 'remove' | 'linkFor' | 'accept' | 'audit' | 'log';
export type { PeopleService };

/** ADMIN_EMAILS: the built-in admins, who can never lose admin. Unset: no people list, Access alone decides. */
export const adminEmails = (env: Env) => (env.ADMIN_EMAILS ?? '').toLowerCase().split(',').map((e) => e.trim()).filter(Boolean);
