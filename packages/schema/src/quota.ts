// The Cloudflare account's limits, shared by every user, mailbox and project on the account,
// for the plan it is on. Backfills pause before a hard limit and resume after it resets. Figures come from
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
  /** A hard limit stops the app when passed, so backfills pause before it. Others are billed past what the plan includes. */
  hard: boolean;
  /** Dollars per million past the allowance, for billed meters. */
  perMillion?: number;
}

/** The account's Workers plan, read from Cloudflare's billing; Free until it can be read. */
export type QuotaPlan = 'free' | 'paid';
export const QUOTA_PLANS: QuotaPlan[] = ['free', 'paid'];
export const PLAN_NAMES: Record<QuotaPlan, string> = { free: 'Workers Free', paid: 'Workers Paid' };

const R2 = {
  r2_class_a: { label: 'R2 writes (Class A)', limit: 1_000_000, period: 'month', hard: false, perMillion: 4.5 },
  r2_class_b: { label: 'R2 reads (Class B)', limit: 10_000_000, period: 'month', hard: false, perMillion: 0.36 },
} as const;

/**
 * Each plan's allowances, from Cloudflare's pricing pages (checked 2026-10-24). Free has hard
 * daily limits; Paid includes a monthly amount and bills past it, so nothing pauses. Paid's
 * month is counted by calendar month, which may differ from the billing cycle by a few days.
 */
export const QUOTA_LIMITS_BY_PLAN: Record<QuotaPlan, Record<QuotaMetric, QuotaLimit>> = {
  free: {
    workers_requests: { label: 'Worker requests', limit: 100_000, period: 'day', hard: true },
    do_rows_written: { label: 'Durable Object rows written', limit: 100_000, period: 'day', hard: true },
    do_rows_read: { label: 'Durable Object rows read', limit: 5_000_000, period: 'day', hard: true },
    d1_rows_written: { label: 'D1 rows written', limit: 100_000, period: 'day', hard: true },
    d1_rows_read: { label: 'D1 rows read', limit: 5_000_000, period: 'day', hard: true },
    ...R2,
  },
  paid: {
    workers_requests: { label: 'Worker requests', limit: 10_000_000, period: 'month', hard: false, perMillion: 0.3 },
    do_rows_written: { label: 'Durable Object rows written', limit: 50_000_000, period: 'month', hard: false, perMillion: 1 },
    do_rows_read: { label: 'Durable Object rows read', limit: 25_000_000_000, period: 'month', hard: false, perMillion: 0.001 },
    d1_rows_written: { label: 'D1 rows written', limit: 50_000_000, period: 'month', hard: false, perMillion: 1 },
    d1_rows_read: { label: 'D1 rows read', limit: 25_000_000_000, period: 'month', hard: false, perMillion: 0.001 },
    ...R2,
  },
};

/** The plan's allowances; an unknown plan reads as Free, the stricter one. */
export const quotaLimits = (plan: string | undefined) => QUOTA_LIMITS_BY_PLAN[plan === 'paid' ? 'paid' : 'free'];
export const QUOTA_METRICS = Object.keys(QUOTA_LIMITS_BY_PLAN.free) as QuotaMetric[];

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
  /** Dollars past the allowance this period, for billed meters; 0 within it. */
  cost: number | null;
}

/** GET /api/quota: the account's meters now, and whether backfills are paused for a limit. */
export interface QuotaOverview {
  plan: QuotaPlan;
  /** When the plan was last read from Cloudflare; null when it never was (then it is taken as Free). */
  planReadAt: string | null;
  /** Why the plan couldn't be read, if it couldn't. */
  planError: string | null;
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

/** Dollars past the allowance for a billed meter. */
export function quotaCost(l: QuotaLimit, used: number): number | null {
  const { perMillion, limit } = l;
  return perMillion === undefined ? null : Math.max(0, used - limit) / 1_000_000 * perMillion;
}
