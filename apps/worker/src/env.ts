import type { SyncParams } from '@mailcellar/schema';
import type { MailboxDO } from './mailbox';

export interface Env {
  ASSETS: Fetcher;
  MAILBOX: DurableObjectNamespace<MailboxDO>;
  ARCHIVE: R2Bucket;
  /** Basin (R2 Data Catalog): the catalog, its warehouse and bucket, and the write token (a Worker secret). */
  BASIN_CATALOG_URI: string;
  BASIN_WAREHOUSE: string;
  BASIN_BUCKET: string;
  BASIN_TOKEN?: string;
  /** Copies one Gmail account, a batch a run (sync.ts). */
  SYNC: Workflow<SyncParams>;
  APP_VERSION: string;
  /** Google OAuth client: Worker secrets in production, .dev.vars locally. Never in the repo. */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Cloudflare Access in front of the site: the team domain and this app's audience tag. */
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Local dev only (.dev.vars, with ACCESS_AUD empty): the email to act as, since wrangler dev has no Access. */
  DEV_USER_EMAIL?: string;
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
