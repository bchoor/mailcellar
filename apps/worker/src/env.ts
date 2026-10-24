import type { MailboxDO } from './mailbox';

export interface Env {
  ASSETS: Fetcher;
  MAILBOX: DurableObjectNamespace<MailboxDO>;
  ARCHIVE: R2Bucket;
  APP_VERSION: string;
  /** Google OAuth client: Worker secrets in production, .dev.vars locally. Never in the repo. */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

// Types `env` and `exports` from cloudflare:workers (used by tests and future modules).
type WorkerEnv = Env;
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps {
      mainModule: typeof import('./index');
      durableNamespaces: 'MailboxDO';
    }
  }
}
