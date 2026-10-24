import type { SyncParams } from '@mailcellar/schema';
import type { MailboxDO } from './mailbox';
import type { QuotaDO } from './quota';

export interface Env {
  ASSETS: Fetcher;
  MAILBOX: DurableObjectNamespace<MailboxDO>;
  /** The account's free-tier meters, one object for every user (quota.ts). */
  QUOTA: DurableObjectNamespace<QuotaDO>;
  ARCHIVE: R2Bucket;
  /** Basin (R2 Data Catalog): the catalog, its warehouse and bucket, and the write token (a Worker secret). */
  BASIN_CATALOG_URI: string;
  BASIN_WAREHOUSE: string;
  BASIN_BUCKET: string;
  BASIN_TOKEN?: string;
  /** Copies one Gmail account, a batch a run (sync.ts). */
  SYNC: Workflow<SyncParams>;
  APP_VERSION: string;
  /** Cloudflare's analytics for the whole account (quota.ts): the account and a read-only Account Analytics token (a Worker secret). */
  CF_ACCOUNT_ID: string;
  /** A read-only Billing Read token (a Worker secret): the account's plan sets the limits and whether backfills pause (quota.ts). */
  CF_BILLING_TOKEN?: string;
  CF_ANALYTICS_TOKEN?: string;
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
      durableNamespaces: 'MailboxDO' | 'QuotaDO';
    }
  }
}
