// Connected Gmail accounts. Cloudflare Access signs the person in (it gives the app their
// email); Gmail accounts are separate, and Settings ▸ Accounts connects any number of them
// through Google. Refresh tokens live in the user's mailbox Durable Object and never leave the Worker.

/** Google OAuth scopes. gmail.modify lets cleanup trash a message in Gmail once
 * MailCellar holds its copy; Purged uses Gmail's Trash too, so full mail access is never asked. */
export const GMAIL_SCOPES = {
  readonly: 'https://www.googleapis.com/auth/gmail.readonly',
  modify: 'https://www.googleapis.com/auth/gmail.modify',
} as const;
/** Asked when connecting a Gmail account: who it is, and modify (which includes reading). */
export const CONNECT_SCOPES = ['openid', 'email', GMAIL_SCOPES.modify] as const;

/** A Gmail account connected to the archive, as the app sees it (no tokens). */
export interface ConnectedAccount {
  /** Opaque ID derived from Google's subject ID. */
  id: string;
  email: string;
  addedAt: string;
  /** What Google granted when last checked: read mail, and modify it (cleanup's move to Trash). */
  read: boolean;
  modify: boolean;
  /** The last connection test, in Lumen's KeyTestResult shape. Not ok without modify. */
  test: { at: string; ok: boolean; detail: string | null; error: string | null };
}

/** Response of GET /api/me: the Access user and their connected Gmail accounts. */
export interface Me {
  user: { email: string };
  accounts: ConnectedAccount[];
}

/** Codes the connect redirect puts in `?auth_error=`, and what Settings ▸ Accounts says for each. */
export const AUTH_ERRORS = {
  denied: 'Adding the account was cancelled at Google.',
  state: 'That link expired. Try adding the account again.',
  gmail_scope: 'MailCellar needs access to Gmail. Tick the Gmail box on Google’s consent screen.',
  no_refresh: 'Google didn’t grant offline access. Try adding the account again.',
  google: 'Google didn’t finish adding the account. Try again in a minute.',
} as const;
export type AuthError = keyof typeof AUTH_ERRORS;
