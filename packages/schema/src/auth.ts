// Sign-in and connected Gmail accounts. A person signs in with Google; the account they
// sign in with is connected too, and Settings ▸ Accounts connects more. Refresh tokens
// live in the user's mailbox Durable Object and never leave the Worker.

/** Google OAuth scopes. gmail.modify lets cleanup trash a message in Gmail once
 * MailCellar holds its copy; Purged uses Gmail's Trash too, so full mail access is never asked. */
export const GMAIL_SCOPES = {
  readonly: 'https://www.googleapis.com/auth/gmail.readonly',
  modify: 'https://www.googleapis.com/auth/gmail.modify',
} as const;
export const SIGN_IN_SCOPES = ['openid', 'email', 'profile', GMAIL_SCOPES.modify] as const;

/** The session cookie: `<user id>.<random token>`; the mailbox keeps only the token's hash. */
export const SESSION_COOKIE = 'mc_session';
export const SESSION_DAYS = 30;

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

/** Response of GET /api/me. */
export interface Me {
  user: { email: string; name: string | null };
  accounts: ConnectedAccount[];
}

/** Codes the sign-in redirect puts in `?auth_error=`, and what the sign-in page says for each. */
export const AUTH_ERRORS = {
  denied: 'Google sign-in was cancelled.',
  state: 'That sign-in link expired. Try again.',
  gmail_scope: 'MailCellar needs access to Gmail. Tick the Gmail box on Google’s consent screen.',
  no_refresh: 'Google didn’t grant offline access. Try again.',
  google: 'Google sign-in failed. Try again in a minute.',
  signed_out: 'Sign in first, then add another account.',
} as const;
export type AuthError = keyof typeof AUTH_ERRORS;
