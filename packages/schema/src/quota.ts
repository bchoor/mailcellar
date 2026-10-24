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
/** Per-meter stop lines where they differ from QUOTA_STOP: DO rows written stop at 97.5k of 100k (Bikram, 2026-10-24). */
export const QUOTA_STOPS: Partial<Record<QuotaMetric, number>> = { do_rows_written: 0.975 };
/** The share of a meter's limit where backfills pause. */
export const quotaStop = (metric: QuotaMetric) => QUOTA_STOPS[metric] ?? QUOTA_STOP;

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
  /** When this period ends and the meter starts again from 0. */
  resetsAt: string;
  /** Who used it, most first: Worker scripts, Durable Object namespaces, D1 databases or R2 buckets. Empty until Cloudflare's figures are read. */
  parts: QuotaPart[];
}

/** One project's share of a meter. */
export interface QuotaPart {
  /** The script, namespace, database or bucket; `Other` sums the rest. */
  name: string;
  value: number;
  /** MailCellar's own (its Worker, Durable Objects or bucket). */
  mine: boolean;
}

/** Parts a meter shows before the rest are summed as Other. */
export const QUOTA_PARTS = 5;

/** Whether a script, namespace or bucket is MailCellar's own. */
export const isMailCellar = (name: string) => /^mailcellar(?:$|[ _-])/.test(name);

/** The account's billing period, read from its subscriptions. Monthly meters count within it. */
export interface BillingPeriod {
  start: string;
  end: string;
}

/** Refresh reads Cloudflare at most once this often. */
export const QUOTA_REFRESH_MS = 60_000;

/**
 * What the account holds now rather than uses up per period: bytes stored, and Workflow
 * instances running. The level is what Cloudflare last read.
 */
export type LevelMetric = 'do_storage' | 'd1_storage' | 'r2_storage' | 'workflows_running';

export interface LevelLimit {
  label: string;
  unit: 'bytes' | 'count';
  /** Included on the plan: bytes, or instances at once. */
  limit: number;
  /** Dollars a GB-month past it; none where nothing is billed. */
  perGbMonth?: number;
}

const GB = 1024 ** 3;
const R2_STORED: LevelLimit = { label: 'R2 storage', unit: 'bytes', limit: 10 * GB, perGbMonth: 0.015 };

/** Each plan's levels, from Cloudflare's pricing and limits pages (checked 2026-10-24). */
export const LEVEL_LIMITS_BY_PLAN: Record<QuotaPlan, Record<LevelMetric, LevelLimit>> = {
  free: {
    do_storage: { label: 'Durable Object storage', unit: 'bytes', limit: 5 * GB },
    d1_storage: { label: 'D1 storage', unit: 'bytes', limit: 5 * GB },
    r2_storage: R2_STORED,
    workflows_running: { label: 'Workflows running', unit: 'count', limit: 100 },
  },
  paid: {
    do_storage: { label: 'Durable Object storage', unit: 'bytes', limit: 5 * GB, perGbMonth: 0.2 },
    d1_storage: { label: 'D1 storage', unit: 'bytes', limit: 5 * GB, perGbMonth: 0.75 },
    r2_storage: R2_STORED,
    workflows_running: { label: 'Workflows running', unit: 'count', limit: 50_000 },
  },
};
export const levelLimits = (plan: string | undefined) => LEVEL_LIMITS_BY_PLAN[plan === 'paid' ? 'paid' : 'free'];
export const LEVEL_METRICS = Object.keys(LEVEL_LIMITS_BY_PLAN.free) as LevelMetric[];

export interface LevelMeter {
  metric: LevelMetric;
  label: string;
  unit: 'bytes' | 'count';
  /** Account-wide, as last read. */
  used: number;
  limit: number;
  /** Dollars a month past the allowance at this level; null where nothing is billed. */
  cost: number | null;
  /** Who holds it: namespaces and databases by project, buckets, Workflows by Worker. */
  parts: QuotaPart[];
}

/** Dollars a month for storing `used` bytes past the allowance. */
export function levelCost(l: LevelLimit, used: number): number | null {
  return l.perGbMonth === undefined ? null : (Math.max(0, used - l.limit) / GB) * l.perGbMonth;
}

/** The CPU time one Worker request may use, in ms: Free's is 10 ms, Paid's default 30 s. */
export const CPU_LIMIT_MS: Record<QuotaPlan, number> = { free: 10, paid: 30_000 };

/** One Worker's CPU time per request today (UTC), in ms. */
export interface CpuRow {
  name: string;
  mine: boolean;
  requests: number;
  p50: number;
  p99: number;
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
  /** The billing period monthly meters count in; null when it can't be read (then the calendar month). */
  billing: BillingPeriod | null;
  meters: QuotaMeter[];
  /** Storage and Workflows running, as last read; empty until read. */
  levels: LevelMeter[];
  /** CPU per request by Worker, most requests first, as last read; empty until read. */
  cpu: { limitMs: number; rows: CpuRow[] };
  /** When Refresh may read Cloudflare again (at most one read a minute). */
  refreshAt: string;
  paused: { metric: QuotaMetric; label: string; resumesAt: string } | null;
  /** The backfill's spend against its cap. */
  spend: SpendOverview;
}

/** The billing period, if it is known and still running at `now`. */
const current = (billing: BillingPeriod | null | undefined, now: Date) =>
  billing && Date.parse(billing.start) <= now.getTime() && now.getTime() < Date.parse(billing.end) ? billing : null;

/** The UTC day a limit's period started: today, or the billing period's first day (else the 1st). */
export function quotaStart(period: 'day' | 'month', now = new Date(), billing?: BillingPeriod | null): string {
  const day = now.toISOString().slice(0, 10);
  if (period === 'day') return day;
  return current(billing, now)?.start.slice(0, 10) ?? `${day.slice(0, 8)}01`;
}

/** When a limit's period resets: 00:05 UTC tomorrow, or when the billing period ends (else 00:05 UTC on the 1st). */
export function quotaReset(period: 'day' | 'month', now = new Date(), billing?: BillingPeriod | null): Date {
  if (period === 'day') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));
  const b = current(billing, now);
  return b ? new Date(b.end) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 5));
}

/** Dollars past the allowance for a billed meter. */
export function quotaCost(l: QuotaLimit, used: number): number | null {
  const { perMillion, limit } = l;
  return perMillion === undefined ? null : Math.max(0, used - limit) / 1_000_000 * perMillion;
}

/**
 * The backfill's spend cap (Bikram, 2026-10-24 2:11 PM PT): all R2 spend the backfill adds from
 * `since` until it's done stays at or under `cap`. The backfill pauses itself once spend plus
 * the next run would pass `stop`, which leaves room for what the meters can't see yet.
 * Everything is priced as billed: the account is past R2's free writes and storage already.
 * R2 Data Catalog's own REST calls are not R2 operations and aren't counted here; the data and
 * metadata files a Basin commit writes are (they go through the bucket).
 */
export const SPEND = {
  since: '2026-10-24T21:11:00Z',
  cap: 1.1,
  stop: 1.0,
  /** The mailcellar bucket's bytes at `since` (Cloudflare's storage figure for 2026-10-24). */
  baseBytes: 149_316_163,
  classAPerOp: 4.5 / 1e6,
  classBPerOp: 0.36 / 1e6,
  /** One month of storage for each byte added: what it costs until the backfill is done. */
  perByte: 0.015 / GB,
} as const;

/** What the backfill has added since SPEND.since: R2 writes and reads, and bytes stored. */
export interface SpendUse {
  classA: number;
  classB: number;
  bytes: number;
}

export const spendCost = (u: SpendUse) => u.classA * SPEND.classAPerOp + u.classB * SPEND.classBPerOp + Math.max(0, u.bytes) * SPEND.perByte;

/** GET /api/quota's spend: dollars added since SPEND.since, against the cap. */
export interface SpendOverview {
  since: string;
  cap: number;
  stop: number;
  spent: number;
  use: SpendUse;
  /** When Cloudflare's own figures were last read; null before (then only MailCellar's count). */
  readAt: string | null;
}
