// The account's meters for its Workers plan (read from Cloudflare's billing), one Durable Object for every user and mailbox (name
// 'account'). Each sync and census run asks it for room before its batch and reports what the
// batch used after. It reads Cloudflare's analytics for the whole account (every project on
// it) at most every 5 minutes, and adds what MailCellar has counted since.
import { DurableObject } from 'cloudflare:workers';
import { QUOTA_METRICS, QUOTA_STOP, quotaLimits, R2_CLASS_A, R2_CLASS_B, quotaCost, quotaReset, type QuotaMetric, type QuotaOverview, type QuotaPlan } from '@mailcellar/schema';
import type { Env } from './env';

export type QuotaUse = Partial<Record<QuotaMetric, number>>;

const metrics = QUOTA_METRICS;
type Limits = ReturnType<typeof quotaLimits>;
/** Cloudflare's figures are read again after this. */
export const CF_READ_MS = 5 * 60_000;
/** The UTC day or month a meter counts in now. */
const periodKey = (limits: Limits, metric: QuotaMetric, now = new Date()) => now.toISOString().slice(0, limits[metric].period === 'day' ? 10 : 7);


const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
// Each family is read from the start of its period on the plan: today on Free, the month on Paid.
const QUERY = `query($a: String!, $workers: Time!, $to: Time!, $dos: Date!, $d1: Date!, $r2: Date!) {
  viewer { accounts(filter: {accountTag: $a}) {
    workers: workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $workers, datetime_lt: $to}) { sum { requests } }
    dos: durableObjectsPeriodicGroups(limit: 10000, filter: {date_geq: $dos}) { sum { rowsRead rowsWritten } }
    d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: {date_geq: $d1}) { sum { rowsRead rowsWritten } }
    r2: r2OperationsAdaptiveGroups(limit: 10000, filter: {date_geq: $r2}) { dimensions { actionType } sum { requests } }
  } }
}`;

interface CfAccount {
  workers: { sum: { requests: number } }[];
  dos: { sum: { rowsRead: number; rowsWritten: number } }[];
  d1: { sum: { rowsRead: number; rowsWritten: number } }[];
  r2: { dimensions: { actionType: string }; sum: { requests: number } }[];
}

/** The account's use this period of each meter on the plan, from Cloudflare's GraphQL analytics. */
export async function readCloudflare(env: Env, plan: QuotaPlan, now = new Date()): Promise<Record<QuotaMetric, number>> {
  if (!env.CF_ANALYTICS_TOKEN) throw new Error('No Cloudflare analytics token is set.');
  const limits = quotaLimits(plan);
  const day = now.toISOString().slice(0, 10);
  const from = (m: QuotaMetric) => (limits[m].period === 'day' ? day : `${day.slice(0, 8)}01`);
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        a: env.CF_ACCOUNT_ID, workers: `${from('workers_requests')}T00:00:00Z`, to: now.toISOString(),
        dos: from('do_rows_written'), d1: from('d1_rows_written'), r2: from('r2_class_a'),
      },
    }),
  });
  if (!res.ok) throw new Error(`Cloudflare analytics answered HTTP ${res.status}.`);
  const body = (await res.json()) as { data?: { viewer: { accounts: CfAccount[] } }; errors?: { message: string }[] | null };
  if (body.errors?.length) throw new Error(`Cloudflare analytics: ${body.errors[0].message}`);
  const a = body.data?.viewer.accounts[0];
  if (!a) throw new Error('Cloudflare analytics returned no account.');
  const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((n, r) => n + f(r), 0);
  return {
    workers_requests: sum(a.workers, (r) => r.sum.requests),
    do_rows_written: sum(a.dos, (r) => r.sum.rowsWritten),
    do_rows_read: sum(a.dos, (r) => r.sum.rowsRead),
    d1_rows_written: sum(a.d1, (r) => r.sum.rowsWritten),
    d1_rows_read: sum(a.d1, (r) => r.sum.rowsRead),
    r2_class_a: sum(a.r2, (r) => (R2_CLASS_A.has(r.dimensions.actionType) ? r.sum.requests : 0)),
    r2_class_b: sum(a.r2, (r) => (R2_CLASS_B.has(r.dimensions.actionType) ? r.sum.requests : 0)),
  };
}

/** The plan is cached this long: it is read only when a backfill or a page asks for the limits, never on a timer. */
export const PLAN_READ_MS = 24 * 3_600_000;

/**
 * The account's Workers plan, from its subscriptions (a read-only Billing Read token). Workers
 * Paid shows as a subscription to a Workers rate plan; with none, the account is on Free.
 */
export async function readPlan(env: Env): Promise<QuotaPlan> {
  if (!env.CF_BILLING_TOKEN) throw new Error('No Cloudflare billing token is set, so the plan is taken as Workers Free.');
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/subscriptions`, {
    headers: { authorization: `Bearer ${env.CF_BILLING_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Cloudflare billing answered HTTP ${res.status}, so the plan is taken as Workers Free.`);
  const body = (await res.json()) as { result?: { state?: string; rate_plan?: { id?: string; public_name?: string } }[] };
  const workers = (body.result ?? []).some(
    (s) => {
      const name = `${s.rate_plan?.id ?? ''} ${s.rate_plan?.public_name ?? ''}`;
      return s.state !== 'Cancelled' && /workers/i.test(name) && !/free/i.test(name);
    },
  );
  return workers ? 'paid' : 'free';
}

/** Swapped in tests: each test gets its own meter, and none calls Cloudflare. */
export const quotaDeps = { readCloudflare, readPlan, name: 'account' };

/** The one meter for the whole Cloudflare account. */
export const accountQuota = (env: Env) => env.QUOTA.getByName(quotaDeps.name);

export class QuotaDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      -- MailCellar's own count, by UTC day.
      CREATE TABLE IF NOT EXISTS usage (period TEXT NOT NULL, metric TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (period, metric)) STRICT, WITHOUT ROWID;
      -- Cloudflare's figure for a period when last read, and MailCellar's own count at that moment.
      CREATE TABLE IF NOT EXISTS cloudflare (metric TEXT PRIMARY KEY, period TEXT NOT NULL, value INTEGER NOT NULL, ours INTEGER NOT NULL) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
    `);
  }

  /** The plan last read from Cloudflare; Free until one is read. */
  private get plan(): QuotaPlan {
    return this.meta('plan') === 'paid' ? 'paid' : 'free';
  }

  private get limits() {
    return quotaLimits(this.plan);
  }

  /** Read the plan at most once every PLAN_READ_MS. A failed read keeps the last plan known. */
  private async refreshPlan(now: Date) {
    const tried = this.meta('plan_tried_at');
    if (tried && now.getTime() - Date.parse(tried) < PLAN_READ_MS) return;
    this.setMeta('plan_tried_at', now.toISOString());
    try {
      this.setMeta('plan', await quotaDeps.readPlan(this.env));
      this.setMeta('plan_read_at', now.toISOString());
      this.setMeta('plan_error', null);
    } catch (e) {
      this.setMeta('plan_error', e instanceof Error ? e.message : 'The plan could not be read.');
    }
  }

  /** MailCellar's own count this period. It is kept by UTC day, so a plan change keeps it. */
  private ours(metric: QuotaMetric, now: Date): number {
    return (
      this.ctx.storage.sql
        .exec<{ value: number }>(`SELECT sum(value) AS value FROM usage WHERE period LIKE ? AND metric = ?`, `${periodKey(this.limits, metric, now)}%`, metric)
        .toArray()[0]?.value ?? 0
    );
  }

  private meta(key: string): string | null {
    return this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0]?.value ?? null;
  }

  private setMeta(key: string, value: string | null) {
    if (value === null) this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = ?`, key);
    else this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO meta VALUES (?, ?)`, key, value);
  }

  /** Read Cloudflare's figures at most once every CF_READ_MS, whether the last try worked or not. */
  private async refresh(now: Date) {
    await this.refreshPlan(now);
    const tried = this.meta('tried_at');
    if (tried && now.getTime() - Date.parse(tried) < CF_READ_MS) return;
    this.setMeta('tried_at', now.toISOString());
    try {
      const cf = await quotaDeps.readCloudflare(this.env, this.plan, now);
      for (const m of metrics)
        this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO cloudflare VALUES (?, ?, ?, ?)`, m, periodKey(this.limits, m, now), cf[m], this.ours(m, now));
      this.setMeta('read_at', now.toISOString());
      this.setMeta('read_error', null);
    } catch (e) {
      this.setMeta('read_error', e instanceof Error ? e.message : 'Cloudflare analytics could not be read.');
    }
  }

  /** The account's use: Cloudflare's last figure plus what MailCellar counted since, never under its own count. */
  private used(metric: QuotaMetric, now: Date): { used: number; ours: number } {
    const ours = this.ours(metric, now);
    const cf = this.ctx.storage.sql
      .exec<{ value: number; ours: number }>(`SELECT value, ours FROM cloudflare WHERE metric = ? AND period = ?`, metric, periodKey(this.limits, metric, now))
      .toArray()[0];
    return { used: cf ? Math.max(ours, cf.value + ours - cf.ours) : ours, ours };
  }

  /**
   * Whether a batch costing `cost` fits under every hard limit's stop line. Null: go ahead. Else
   * the first meter it would pass, and when that meter resets.
   */
  async reserve(cost: QuotaUse): Promise<{ metric: QuotaMetric; label: string; resumesAt: string } | null> {
    const now = new Date();
    await this.refresh(now);
    for (const m of metrics) {
      const { limit, label, period, hard } = this.limits[m];
      if (hard && this.used(m, now).used + (cost[m] ?? 0) > limit * QUOTA_STOP)
        return { metric: m, label, resumesAt: quotaReset(period, now).toISOString() };
    }
    return null;
  }

  /** Add what a batch used. This object's own writes count too. */
  async add(use: QuotaUse): Promise<void> {
    const now = new Date();
    const entries = metrics.filter((m) => use[m]);
    if (!entries.length) return;
    const own = entries.length + 1;
    for (const m of entries.includes('do_rows_written') ? entries : [...entries, 'do_rows_written' as const]) {
      const value = (use[m] ?? 0) + (m === 'do_rows_written' ? own : 0);
      this.ctx.storage.sql.exec(
        `INSERT INTO usage VALUES (?, ?, ?) ON CONFLICT (period, metric) DO UPDATE SET value = value + excluded.value`,
        now.toISOString().slice(0, 10), m, value,
      );
    }
  }

  async overview(): Promise<QuotaOverview> {
    const now = new Date();
    await this.refresh(now);
    const meters = metrics.map((m) => {
      const { label, limit, period, hard } = this.limits[m];
      const { used, ours } = this.used(m, now);
      return { metric: m, label, used, ours, limit, period, hard, cost: quotaCost(this.limits[m], used) };
    });
    const over = meters.find((m) => m.hard && m.used >= m.limit * QUOTA_STOP);
    return {
      plan: this.plan,
      planReadAt: this.meta('plan_read_at'),
      planError: this.meta('plan_error'),
      readAt: this.meta('read_at'),
      readError: this.meta('read_error'),
      day: now.toISOString().slice(0, 10),
      meters,
      paused: over ? { metric: over.metric, label: over.label, resumesAt: quotaReset(over.period, now).toISOString() } : null,
    };
  }
}
