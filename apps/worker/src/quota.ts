// The account's meters for its Workers plan (read from Cloudflare's billing), one Durable Object for every user and mailbox (name
// 'account'). Each sync and census run asks it for room before its batch and reports what the
// batch used after. It reads Cloudflare's analytics for the whole account (every project on
// it) at most every 5 minutes, and adds what MailCellar has counted since.
import { DurableObject } from 'cloudflare:workers';
import { QUOTA_METRICS, QUOTA_STOP, quotaLimits, R2_CLASS_A, R2_CLASS_B, quotaCost, quotaReset, quotaStart, type BillingPeriod, type QuotaMetric, type QuotaOverview, type QuotaPart, type QuotaPlan, isMailCellar, QUOTA_PARTS } from '@mailcellar/schema';
import type { Env } from './env';

export type QuotaUse = Partial<Record<QuotaMetric, number>>;

const metrics = QUOTA_METRICS;
type Limits = ReturnType<typeof quotaLimits>;
/** Cloudflare's figures are read again after this. */
export const CF_READ_MS = 5 * 60_000;
/** The UTC day a meter's period started: today, or the billing period's first day. */
const periodKey = (limits: Limits, metric: QuotaMetric, now: Date, billing: BillingPeriod | null) => quotaStart(limits[metric].period, now, billing);


const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
// Each family is read from the start of its period on the plan: today on Free, the month on Paid.
const QUERY = `query($a: String!, $workers: Time!, $to: Time!, $dos: Date!, $d1: Date!, $r2: Date!) {
  viewer { accounts(filter: {accountTag: $a}) {
    workers: workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $workers, datetime_lt: $to}) { dimensions { scriptName } sum { requests } }
    dos: durableObjectsPeriodicGroups(limit: 10000, filter: {date_geq: $dos}) { dimensions { namespaceId } sum { rowsRead rowsWritten } }
    d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: {date_geq: $d1}) { dimensions { databaseId } sum { rowsRead rowsWritten } }
    r2: r2OperationsAdaptiveGroups(limit: 10000, filter: {date_geq: $r2}) { dimensions { actionType bucketName } sum { requests } }
  } }
}`;

interface CfAccount {
  workers: { dimensions?: { scriptName?: string }; sum: { requests: number } }[];
  dos: { dimensions?: { namespaceId?: string }; sum: { rowsRead: number; rowsWritten: number } }[];
  d1: { dimensions?: { databaseId?: string }; sum: { rowsRead: number; rowsWritten: number } }[];
  r2: { dimensions: { actionType: string; bucketName: string }; sum: { requests: number } }[];
}

/** Cloudflare's figures: each meter's use this period, and who used it. */
export type CloudflareFigures = Record<QuotaMetric, number> & { parts?: Partial<Record<QuotaMetric, QuotaPart[]>> };

/** Totals by name, most first, the rest past QUOTA_PARTS summed as Other. MailCellar's own always shows. */
export function topParts(by: Map<string, number>): QuotaPart[] {
  const all = [...by.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value, mine: isMailCellar(name) }));
  const shown = all.slice(0, QUOTA_PARTS);
  const rest = all.slice(QUOTA_PARTS);
  shown.push(...rest.filter((p) => p.mine));
  const other = rest.filter((p) => !p.mine).reduce((n, p) => n + p.value, 0);
  if (other) shown.push({ name: 'Other', value: other, mine: false });
  return shown;
}

/**
 * Names for Durable Object namespaces and D1 databases, which analytics know only by ID: the
 * names kept in the meter (SyncParams.names), then what the token may list (Workers Scripts
 * Read and D1 Read). An ID with no name shows shortened.
 */
async function names(env: Env, known: Record<string, string>): Promise<Map<string, string>> {
  const out = new Map(Object.entries(known));
  const get = async <T>(path: string) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}${path}`, { headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` } });
    return res.ok ? (((await res.json()) as { result?: T[] }).result ?? []) : [];
  };
  const [ns, dbs] = await Promise.all([
    get<{ id: string; script?: string; class?: string; name?: string }>('/workers/durable_objects/namespaces?per_page=1000').catch(() => []),
    get<{ uuid: string; name: string }>('/d1/database?per_page=1000').catch(() => []),
  ]);
  for (const n of ns) out.set(n.id, n.script && n.class ? `${n.script} ${n.class}` : (n.name ?? n.id));
  for (const d of dbs) out.set(d.uuid, d.name);
  return out;
}

/** The account's use this period of each meter on the plan, from Cloudflare's GraphQL analytics. */
export async function readCloudflare(env: Env, plan: QuotaPlan, now = new Date(), billing: BillingPeriod | null = null, known: Record<string, string> = {}): Promise<CloudflareFigures> {
  if (!env.CF_ANALYTICS_TOKEN) throw new Error('No Cloudflare analytics token is set.');
  const limits = quotaLimits(plan);
  const from = (m: QuotaMetric) => quotaStart(limits[m].period, now, billing);
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
  const named = a.dos.length || a.d1.length ? await names(env, known) : new Map<string, string>();
  const label = (id: string | undefined) => (id ? (named.get(id) ?? id.slice(0, 8)) : 'Unnamed');
  const by = <T>(rows: T[], key: (r: T) => string, f: (r: T) => number) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + f(r));
    return topParts(m);
  };
  const script = (r: CfAccount['workers'][number]) => (r.dimensions?.scriptName && r.dimensions.scriptName !== '__unknown__' ? r.dimensions.scriptName : 'Unnamed');
  const ns = (r: CfAccount['dos'][number]) => label(r.dimensions?.namespaceId);
  const db = (r: CfAccount['d1'][number]) => label(r.dimensions?.databaseId);
  const bucket = (r: CfAccount['r2'][number]) => r.dimensions.bucketName || 'Unnamed';
  const classA = (r: CfAccount['r2'][number]) => (R2_CLASS_A.has(r.dimensions.actionType) ? r.sum.requests : 0);
  const classB = (r: CfAccount['r2'][number]) => (R2_CLASS_B.has(r.dimensions.actionType) ? r.sum.requests : 0);
  return {
    parts: {
      workers_requests: by(a.workers, script, (r) => r.sum.requests),
      do_rows_written: by(a.dos, ns, (r) => r.sum.rowsWritten),
      do_rows_read: by(a.dos, ns, (r) => r.sum.rowsRead),
      d1_rows_written: by(a.d1, db, (r) => r.sum.rowsWritten),
      d1_rows_read: by(a.d1, db, (r) => r.sum.rowsRead),
      r2_class_a: by(a.r2, bucket, classA),
      r2_class_b: by(a.r2, bucket, classB),
    },
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

interface Subscription {
  state?: string;
  rate_plan?: { id?: string; public_name?: string };
  current_period_start?: string;
  current_period_end?: string;
}

/**
 * The account's Workers plan and billing period, from its subscriptions (a read-only Billing
 * Read token). Workers Paid shows as a subscription to a Workers rate plan; with none, the
 * account is on Free. The period is R2's subscription's, else any active one's; usage is billed
 * on it. With no subscription there is no period, and monthly meters count the calendar month.
 */
export async function readPlan(env: Env, now = new Date()): Promise<{ plan: QuotaPlan; billing: BillingPeriod | null }> {
  if (!env.CF_BILLING_TOKEN) throw new Error('No Cloudflare billing token is set, so the plan is taken as Workers Free.');
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/subscriptions`, {
    headers: { authorization: `Bearer ${env.CF_BILLING_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Cloudflare billing answered HTTP ${res.status}, so the plan is taken as Workers Free.`);
  const body = (await res.json()) as { result?: Subscription[] };
  const active = (body.result ?? []).filter((s) => s.state !== 'Cancelled');
  const name = (s: Subscription) => `${s.rate_plan?.id ?? ''} ${s.rate_plan?.public_name ?? ''}`;
  const workers = active.some((s) => /workers/i.test(name(s)) && !/free/i.test(name(s)));
  const running = active.filter(
    (s) => s.current_period_start && s.current_period_end && Date.parse(s.current_period_start) <= now.getTime() && now.getTime() < Date.parse(s.current_period_end),
  );
  const sub = running.find((s) => /r2/i.test(name(s))) ?? running[0];
  const billing = sub ? { start: new Date(sub.current_period_start!).toISOString(), end: new Date(sub.current_period_end!).toISOString() } : null;
  return { plan: workers ? 'paid' : 'free', billing };
}

/** Swapped in tests: each test gets its own meter, and none calls Cloudflare. */
export const quotaDeps = { readCloudflare, readPlan, name: 'account' };

/** The one meter for the whole Cloudflare account. */
export const accountQuota = (env: Env) => env.QUOTA.getByName(quotaDeps.name);

/**
 * The parts as Cloudflare last read them, plus what MailCellar counted since: the meter's use
 * past the parts' sum is MailCellar's own, so the blocks add up to the bar.
 */
function withOurs(parts: QuotaPart[], used: number): QuotaPart[] {
  const since = used - parts.reduce((n, p) => n + p.value, 0);
  if (!parts.length || since <= 0) return parts;
  const mine = parts.find((p) => p.mine);
  return mine
    ? parts.map((p) => (p === mine ? { ...p, value: p.value + since } : p))
    : [...parts, { name: 'mailcellar', value: since, mine: true }];
}

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

  /** The billing period last read, while it runs; null otherwise. */
  private billing(now: Date): BillingPeriod | null {
    const b = this.meta('billing');
    if (!b) return null;
    const p = JSON.parse(b) as BillingPeriod;
    return Date.parse(p.end) > now.getTime() ? p : null;
  }

  private start(metric: QuotaMetric, now: Date) {
    return periodKey(this.limits, metric, now, this.billing(now));
  }

  /** Read the plan at most once every PLAN_READ_MS. A failed read keeps the last plan known. */
  private async refreshPlan(now: Date) {
    const tried = this.meta('plan_tried_at');
    // Also read again once the billing period it knows has ended.
    const ended = this.meta('billing') !== null && !this.billing(now);
    if (tried && !ended && now.getTime() - Date.parse(tried) < PLAN_READ_MS) return;
    this.setMeta('plan_tried_at', now.toISOString());
    try {
      const { plan, billing } = await quotaDeps.readPlan(this.env, now);
      this.setMeta('plan', plan);
      this.setMeta('billing', billing && JSON.stringify(billing));
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
        .exec<{ value: number }>(`SELECT sum(value) AS value FROM usage WHERE period >= ? AND metric = ?`, this.start(metric, now), metric)
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
      const cf = await quotaDeps.readCloudflare(this.env, this.plan, now, this.billing(now), this.names());
      for (const m of metrics)
        this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO cloudflare VALUES (?, ?, ?, ?)`, m, this.start(m, now), cf[m], this.ours(m, now));
      this.setMeta('parts', JSON.stringify(cf.parts ?? {}));
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
      .exec<{ value: number; ours: number }>(`SELECT value, ours FROM cloudflare WHERE metric = ? AND period = ?`, metric, this.start(metric, now))
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
        return { metric: m, label, resumesAt: quotaReset(period, now, this.billing(now)).toISOString() };
    }
    return null;
  }

  private names(): Record<string, string> {
    const n = this.meta('names');
    return n ? (JSON.parse(n) as Record<string, string>) : {};
  }

  /** Keep names for namespace and database IDs, and read Cloudflare's figures again with them. */
  async setNames(names: Record<string, string>): Promise<number> {
    const all = { ...this.names(), ...names };
    this.setMeta('names', JSON.stringify(all));
    this.setMeta('tried_at', null);
    return Object.keys(all).length;
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
    const stored = this.meta('parts');
    const parts = (stored ? JSON.parse(stored) : {}) as Partial<Record<QuotaMetric, QuotaPart[]>>;
    const meters = metrics.map((m) => {
      const { label, limit, period, hard } = this.limits[m];
      const { used, ours } = this.used(m, now);
      const resetsAt = quotaReset(period, now, this.billing(now)).toISOString();
      return { metric: m, label, used, ours, limit, period, hard, cost: quotaCost(this.limits[m], used), resetsAt, parts: withOurs(parts[m] ?? [], used) };
    });
    const over = meters.find((m) => m.hard && m.used >= m.limit * QUOTA_STOP);
    return {
      plan: this.plan,
      planReadAt: this.meta('plan_read_at'),
      planError: this.meta('plan_error'),
      readAt: this.meta('read_at'),
      readError: this.meta('read_error'),
      day: now.toISOString().slice(0, 10),
      billing: this.billing(now),
      meters,
      paused: over ? { metric: over.metric, label: over.label, resumesAt: over.resetsAt } : null,
    };
  }
}
