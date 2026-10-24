// The Cloudflare account's free-tier limits, shared by every user, mailbox and project on the
// account. Backfills pause before a hard limit and resume after it resets. Figures come from
// Cloudflare's analytics for the whole account; MailCellar's own count stands in when they
// can't be read, and the higher of the two counts.

/** A metered allowance. Daily ones reset at 00:00 UTC; monthly ones on the 1st. */
export type QuotaMetric =
  | 'workers_requests'
  | 'do_rows_written'
  | 'do_rows_read'
  | 'd1_rows_written'
  | 'd1_rows_read'
  | 'r2_class_a'
  | 'r2_class_b';

export interface QuotaLimit {
  label: string;
  limit: number;
  period: 'day' | 'month';
  /** A hard limit stops the app when passed, so backfills pause before it. Others are billed past the free tier. */
  hard: boolean;
  /** Dollars per million past the free tier, for billed meters. */
  perMillion?: number;
}

/** From Cloudflare's pricing pages (Workers Free, R2), checked 2026-10-24. */
export const QUOTA_LIMITS: Record<QuotaMetric, QuotaLimit> = {
  workers_requests: { label: 'Worker requests', limit: 100_000, period: 'day', hard: true },
  do_rows_written: { label: 'Durable Object rows written', limit: 100_000, period: 'day', hard: true },
  do_rows_read: { label: 'Durable Object rows read', limit: 5_000_000, period: 'day', hard: true },
  d1_rows_written: { label: 'D1 rows written', limit: 100_000, period: 'day', hard: true },
  d1_rows_read: { label: 'D1 rows read', limit: 5_000_000, period: 'day', hard: true },
  r2_class_a: { label: 'R2 writes (Class A)', limit: 1_000_000, period: 'month', hard: false, perMillion: 4.5 },
  r2_class_b: { label: 'R2 reads (Class B)', limit: 10_000_000, period: 'month', hard: false, perMillion: 0.36 },
};

/** Backfills pause once a hard meter would pass this share of its limit, leaving room for the app itself. */
export const QUOTA_STOP = 0.9;

/** R2 operations by Cloudflare's class (deletes are free). */
export const R2_CLASS_A = new Set([
  'PutObject', 'CopyObject', 'CreateMultipartUpload', 'UploadPart', 'UploadPartCopy', 'CompleteMultipartUpload',
  'ListObjects', 'ListBuckets', 'ListMultipartUploads', 'ListParts', 'PutBucket', 'PutBucketLifecycleConfiguration',
  'PutBucketCors', 'PutBucketEncryption',
]);
export const R2_CLASS_B = new Set(['GetObject', 'HeadObject', 'HeadBucket', 'GetBucketLifecycleConfiguration', 'GetBucketCors', 'GetBucketEncryption', 'GetBucketLocation']);

export interface QuotaMeter {
  metric: QuotaMetric;
  label: string;
  /** The account's use this period: the higher of Cloudflare's figure and MailCellar's own count. */
  used: number;
  /** MailCellar's own count this period. */
  ours: number;
  limit: number;
  period: 'day' | 'month';
  hard: boolean;
  /** Dollars past the free tier this period, for billed meters; 0 within it. */
  cost: number | null;
}

/** GET /api/quota: the account's meters now, and whether backfills are paused for a limit. */
export interface QuotaOverview {
  /** When Cloudflare's figures were read; null when they couldn't be (then only MailCellar's own count shows). */
  readAt: string | null;
  /** Why Cloudflare's figures couldn't be read, if they couldn't. */
  readError: string | null;
  /** The UTC day the daily meters count. */
  day: string;
  meters: QuotaMeter[];
  paused: { metric: QuotaMetric; label: string; resumesAt: string } | null;
}

/** When a limit's period resets: 00:05 UTC tomorrow, or 00:05 UTC on the 1st. */
export function quotaReset(period: 'day' | 'month', now = new Date()): Date {
  return period === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 5));
}

/** Dollars past the free tier for a billed meter. */
export function quotaCost(metric: QuotaMetric, used: number): number | null {
  const { perMillion, limit } = QUOTA_LIMITS[metric];
  return perMillion === undefined ? null : Math.max(0, used - limit) / 1_000_000 * perMillion;
}
