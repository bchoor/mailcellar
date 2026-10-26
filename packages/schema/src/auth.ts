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
  /** The last connection test, in Lumen's KeyTestResult shape. Read access is enough to pass;
   * without modify the account is read only (no archiving or deleting in Gmail). */
  test: { at: string; ok: boolean; detail: string | null; error: string | null };
  /** 'archive': mail imported from an mbox file, with no Gmail link and no sync. Absent for Gmail. */
  kind?: 'gmail' | 'archive';
  /** An archive's file and how far its upload and import are. */
  archive?: ArchiveImport;
}

/** An archive mailbox's mbox file: uploaded in parts straight to raw files, then imported from there. */
export interface ArchiveImport {
  file: string;
  bytes: number;
  /** Messages found in the file (null until the import has read it all), and imported so far. */
  messages: number | null;
  imported: number;
  /** The upload's progress is the browser's own (uploading); the import's shows on Backfill. */
  status: 'uploading' | 'importing' | 'done' | 'failed';
  error: string | null;
}

/** Response of GET /api/me: the Access user and their connected Gmail accounts. */
export interface Me {
  user: { email: string };
  /** Manages people: sees Admin ▸ People. */
  admin: boolean;
  accounts: ConnectedAccount[];
}

/** Codes the connect redirect puts in `?auth_error=`, and what Settings ▸ Accounts says for each. */
export const AUTH_ERRORS = {
  denied: 'Adding the account was cancelled at Google.',
  state: 'Adding the account was interrupted or took too long. Try again.',
  gmail_scope: 'MailCellar needs access to Gmail. Tick the Gmail box on Google’s consent screen.',
  no_refresh: 'Google didn’t give MailCellar lasting access to this account. Try adding it again.',
  google: 'Google didn’t finish adding the account. Try again in a minute.',
} as const;
export type AuthError = keyof typeof AUTH_ERRORS;
