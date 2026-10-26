// The account's meters for its Workers plan (read from Cloudflare's billing), one Durable Object for every user and mailbox (name
// 'account'). Each sync and census run asks it for room before its batch and reports what the
// batch used after. It reads Cloudflare's analytics for the whole account (every project on
// it) at most every 5 minutes, and adds what MailCellar has counted since.
import { DurableObject } from 'cloudflare:workers';
import { PAID_DAILY_GUARD, paidNow, SPEND, spendCost, type SpendOverview, type SpendUse, QUOTA_METRICS, quotaStop, quotaLimits, R2_CLASS_A, R2_CLASS_B, quotaCost, quotaReset, quotaStart, type BillingPeriod, type QuotaMetric, type QuotaOverview, type QuotaPart, type QuotaPlan, isMailCellar, QUOTA_PARTS, QUOTA_REFRESH_MS, LEVEL_METRICS, levelLimits, levelCost, type LevelMetric } from '@mailcellar/schema';
import { createPeople, doSql, sqlStore } from '@columenlabs/lumen-people';
import type { Env } from './env';
import type { EmailCheck, Person } from '@columenlabs/lumen-ui-types/people';
import type { StoredEmail } from '@columenlabs/lumen-people';

export type StoredEmailRow = { settings: StoredEmail; updatedAt: number; updatedBy: string };
import { adminEmails, INVITE_DAYS, type PeopleOp, type PeopleService, SCOPES } from './people';

export type QuotaUse = Partial<Record<QuotaMetric, number>>;

const metrics = QUOTA_METRICS;
type Limits = ReturnType<typeof quotaLimits>;
/** Cloudflare's figures are read again after this. */
export const CF_READ_MS = 5 * 60_000;
/** How long the end-to-end test switch lasts once set. */
export const TEST_MS = 30 * 60_000;

/** The control review's test switch: a low DO-write stop with a near reset, and a lower spend stop. */
export interface TestLimit {
  /** DO rows written today past which indexing waits, until resetAt; null leaves the real stop. */
  doStop: number | null;
  resetAt: string;
  /** Dollars; null leaves SPEND.stop. Never above it. */
  spendStop: number | null;
  expiresAt: string;
}
/** The UTC day a meter's period started: today, or the billing period's first day. */
const periodKey = (limits: Limits, metric: QuotaMetric, now: Date, billing: BillingPeriod | null) => quotaStart(limits[metric].period, now, billing);


const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
// Each family is read from the start of its period on the plan: today on Free, the month on Paid.
// Storage is read for the last two days, and each store's latest day counts.
const QUERY = `query($a: String!, $workers: Time!, $to: Time!, $dos: Date!, $d1: Date!, $r2: Date!, $stored: Date!, $hours: Time!) {
  viewer { accounts(filter: {accountTag: $a}) {
    workers: workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $workers, datetime_lt: $to}) { dimensions { scriptName } sum { requests } }
    doStored: durableObjectsSqlStorageGroups(limit: 10000, filter: {date_geq: $stored}) { dimensions { namespaceId date } max { storedBytes } }
    d1Stored: d1StorageAdaptiveGroups(limit: 10000, filter: {date_geq: $stored}) { dimensions { databaseId date } max { databaseSizeBytes } }
    r2Stored: r2StorageAdaptiveGroups(limit: 10000, filter: {date_geq: $stored}) { dimensions { bucketName date } max { payloadSize metadataSize } }
    dos: durableObjectsPeriodicGroups(limit: 10000, filter: {date_geq: $dos}) { dimensions { namespaceId } sum { rowsRead rowsWritten } }
    doHours: durableObjectsPeriodicGroups(limit: 100, filter: {datetimeHour_geq: $hours}) { dimensions { datetimeHour } sum { rowsWritten } }
    d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: {date_geq: $d1}) { dimensions { databaseId } sum { rowsRead rowsWritten } }
    r2: r2OperationsAdaptiveGroups(limit: 10000, filter: {date_geq: $r2}) { dimensions { actionType bucketName } sum { requests } }
  } }
}`;

interface CfAccount {
  workers: { dimensions?: { scriptName?: string }; sum: { requests: number } }[];
  dos: { dimensions?: { namespaceId?: string }; sum: { rowsRead: number; rowsWritten: number } }[];
  doHours?: { dimensions: { datetimeHour: string }; sum: { rowsWritten: number } }[];
  d1: { dimensions?: { databaseId?: string }; sum: { rowsRead: number; rowsWritten: number } }[];
  r2: { dimensions: { actionType: string; bucketName: string }; sum: { requests: number } }[];
  doStored?: { dimensions: { namespaceId?: string; date: string }; max: { storedBytes: number } }[];
  d1Stored?: { dimensions: { databaseId?: string; date: string }; max: { databaseSizeBytes: number } }[];
  r2Stored?: { dimensions: { bucketName?: string; date: string }; max: { payloadSize: number; metadataSize: number } }[];
}

/** Cloudflare's figures: each meter's use this period, and who used it; storage, and Workflows running now. */
export type CloudflareFigures = Record<QuotaMetric, number> & {
  parts?: Partial<Record<QuotaMetric, QuotaPart[]>>;
  /** Each level by who holds it; a level left out couldn't be read. */
  levels?: Partial<Record<LevelMetric, QuotaPart[]>>;
  /** DO rows written on the account each hour over the last 24 hours, oldest first (an hour with none is 0). */
  doHours?: { at: string; written: number }[];
};

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
 * Read and D1 Read). An ID with no name shows as Unnamed DO or Unnamed database.
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
  // A namespace counts under its Worker, so each project keeps one colour across meters.
  for (const n of ns) if (n.script || n.name) out.set(n.id, n.script ?? n.name!);
  for (const d of dbs) out.set(d.uuid, d.name);
  return out;
}

/** The latest day's value for each key: storage is a level, so days don't add up. */
function latest<T extends { dimensions: { date: string } }>(rows: T[], key: (r: T) => string, f: (r: T) => number): Map<string, number> {
  const day = new Map<string, string>();
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    const d = day.get(k);
    if (d && d > r.dimensions.date) continue;
    out.set(k, d === r.dimensions.date ? Math.max(out.get(k)!, f(r)) : f(r));
    day.set(k, r.dimensions.date);
  }
  return out;
}

/** Workflow instances running now, by Worker (needs Workflows Read on the analytics token). */
export async function readWorkflows(env: Env): Promise<QuotaPart[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workflows?per_page=100`, { headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` } });
  if (!res.ok) throw new Error(`Workflows answered HTTP ${res.status}.`);
  const body = (await res.json()) as { result?: { script_name?: string; name: string; instances?: { running?: number } }[] };
  const by = new Map<string, number>();
  for (const w of body.result ?? []) {
    const k = w.script_name || w.name;
    by.set(k, (by.get(k) ?? 0) + (w.instances?.running ?? 0));
  }
  return topParts(by);
}

/** The start of the first of the last 24 hours (UTC), the current hour included. */
const firstHour = (now: Date) => new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 - 23 * 3_600_000);

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
        stored: new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10),
        hours: firstHour(now).toISOString(),
      },
    }),
  });
  if (!res.ok) throw new Error(`Cloudflare analytics answered HTTP ${res.status}.`);
  const body = (await res.json()) as { data?: { viewer: { accounts: CfAccount[] } }; errors?: { message: string }[] | null };
  if (body.errors?.length) throw new Error(`Cloudflare analytics: ${body.errors[0].message}`);
  const a = body.data?.viewer.accounts[0];
  if (!a) throw new Error('Cloudflare analytics returned no account.');
  const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((n, r) => n + f(r), 0);
  const ids = a.dos.length || a.d1.length || a.doStored?.length || a.d1Stored?.length;
  const named = ids ? await names(env, known) : new Map<string, string>();
  const label = (id: string | undefined, kind: 'DO' | 'database') => (id && named.get(id)) || `Unnamed ${kind}`;
  const by = <T>(rows: T[], key: (r: T) => string, f: (r: T) => number) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + f(r));
    return topParts(m);
  };
  /** Levels by who holds them, once each store's latest day is taken. */
  const held = (levels: Map<string, number>, name: (id: string) => string) => {
    const m = new Map<string, number>();
    for (const [id, v] of levels) m.set(name(id), (m.get(name(id)) ?? 0) + v);
    return topParts(m);
  };
  const scriptName = (s: string | undefined) => (s && s !== '__unknown__' ? s : 'Unnamed Worker');
  const script = (r: CfAccount['workers'][number]) => scriptName(r.dimensions?.scriptName);
  const ns = (r: CfAccount['dos'][number]) => label(r.dimensions?.namespaceId, 'DO');
  const db = (r: CfAccount['d1'][number]) => label(r.dimensions?.databaseId, 'database');
  const bucket = (r: CfAccount['r2'][number]) => r.dimensions.bucketName || 'Unnamed bucket';
  const classA = (r: CfAccount['r2'][number]) => (R2_CLASS_A.has(r.dimensions.actionType) ? r.sum.requests : 0);
  const classB = (r: CfAccount['r2'][number]) => (R2_CLASS_B.has(r.dimensions.actionType) ? r.sum.requests : 0);
  const levels: CloudflareFigures['levels'] = {
    do_storage: held(latest(a.doStored ?? [], (r) => r.dimensions.namespaceId ?? '', (r) => r.max.storedBytes), (id) => label(id, 'DO')),
    d1_storage: held(latest(a.d1Stored ?? [], (r) => r.dimensions.databaseId ?? '', (r) => r.max.databaseSizeBytes), (id) => label(id, 'database')),
    r2_storage: held(latest(a.r2Stored ?? [], (r) => r.dimensions.bucketName ?? '', (r) => r.max.payloadSize + r.max.metadataSize), (id) => id || 'Unnamed bucket'),
  };
  try {
    levels.workflows_running = await readWorkflows(env);
  } catch {
    // Left out: the page says Workflows running couldn't be read.
  }
  const hourly = new Map<number, number>();
  for (const r of a.doHours ?? []) {
    const t = Date.parse(r.dimensions.datetimeHour);
    hourly.set(t, (hourly.get(t) ?? 0) + r.sum.rowsWritten);
  }
  const doHours = Array.from({ length: 24 }, (_, i) => {
    const t = firstHour(now).getTime() + i * 3_600_000;
    return { at: new Date(t).toISOString(), written: hourly.get(t) ?? 0 };
  });
  return {
    doHours,
    parts: {
      workers_requests: by(a.workers, script, (r) => r.sum.requests),
      do_rows_written: by(a.dos, ns, (r) => r.sum.rowsWritten),
      do_rows_read: by(a.dos, ns, (r) => r.sum.rowsRead),
      d1_rows_written: by(a.d1, db, (r) => r.sum.rowsWritten),
      d1_rows_read: by(a.d1, db, (r) => r.sum.rowsRead),
      r2_class_a: by(a.r2, bucket, classA),
      r2_class_b: by(a.r2, bucket, classB),
    },
    levels,
    workers_requests: sum(a.workers, (r) => r.sum.requests),
    do_rows_written: sum(a.dos, (r) => r.sum.rowsWritten),
    do_rows_read: sum(a.dos, (r) => r.sum.rowsRead),
    d1_rows_written: sum(a.d1, (r) => r.sum.rowsWritten),
    d1_rows_read: sum(a.d1, (r) => r.sum.rowsRead),
    r2_class_a: sum(a.r2, classA),
    r2_class_b: sum(a.r2, classB),
  };
}

/** The plan is cached this long: it is read only when a backfill or a page asks for the limits, never on a timer. */
export const PLAN_READ_MS = 3_600_000;

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
export async function readPlan(env: Env, now = new Date()): Promise<{ plan: QuotaPlan; billing: BillingPeriod | null; paidEnd: string | null }> {
  if (!env.CF_BILLING_TOKEN) throw new Error('No Cloudflare billing token is set, so the plan is taken as Workers Free.');
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/subscriptions`, {
    headers: { authorization: `Bearer ${env.CF_BILLING_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Cloudflare billing answered HTTP ${res.status}, so the plan is taken as Workers Free.`);
  const body = (await res.json()) as { result?: Subscription[] };
  // A cancelled subscription still runs until its period ends.
  const active = (body.result ?? []).filter(
    (s) => s.state !== 'Cancelled' || (!!s.current_period_end && now.getTime() < Date.parse(s.current_period_end)),
  );
  const name = (s: Subscription) => `${s.rate_plan?.id ?? ''} ${s.rate_plan?.public_name ?? ''}`;
  const workers = active.find((s) => /workers/i.test(name(s)) && !/free/i.test(name(s)));
  const running = active.filter(
    (s) => s.current_period_start && s.current_period_end && Date.parse(s.current_period_start) <= now.getTime() && now.getTime() < Date.parse(s.current_period_end),
  );
  const sub = running.find((s) => /r2/i.test(name(s))) ?? running[0];
  const billing = sub ? { start: new Date(sub.current_period_start!).toISOString(), end: new Date(sub.current_period_end!).toISOString() } : null;
  const paidEnd = workers?.current_period_end ? new Date(workers.current_period_end).toISOString() : null;
  return { plan: workers ? 'paid' : 'free', billing, paidEnd };
}

/**
 * Cloudflare's figures for the backfill's spend: the bucket's R2 writes and reads since
 * SPEND.since, and the bytes it holds now less what it held then.
 */
export async function readSpend(env: Env): Promise<SpendUse> {
  if (!env.CF_ANALYTICS_TOKEN) throw new Error('No Cloudflare analytics token is set.');
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query($a: String!, $since: Time!, $day: Date!, $bucket: String!) { viewer { accounts(filter: {accountTag: $a}) {
        ops: r2OperationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: $since, bucketName: $bucket}) { dimensions { actionType } sum { requests } }
        stored: r2StorageAdaptiveGroups(limit: 10, filter: {date_geq: $day, bucketName: $bucket}, orderBy: [date_DESC]) { dimensions { date } max { payloadSize metadataSize } }
      } } }`,
      variables: { a: env.CF_ACCOUNT_ID, since: SPEND.since, day: SPEND.since.slice(0, 10), bucket: env.ARCHIVE_BUCKET },
    }),
  });
  if (!res.ok) throw new Error(`Cloudflare analytics answered HTTP ${res.status}.`);
  type Body = { data?: { viewer: { accounts: { ops: { dimensions: { actionType: string }; sum: { requests: number } }[]; stored: { max: { payloadSize: number; metadataSize: number } }[] }[] } }; errors?: { message: string }[] | null };
  const body = (await res.json()) as Body;
  if (body.errors?.length) throw new Error(`Cloudflare analytics: ${body.errors[0].message}`);
  const a = body.data?.viewer.accounts[0];
  if (!a) throw new Error('Cloudflare analytics returned no account.');
  const count = (set: Set<string>) => a.ops.reduce((n, r) => n + (set.has(r.dimensions.actionType) ? r.sum.requests : 0), 0);
  const now = a.stored[0]?.max;
  return { classA: count(R2_CLASS_A), classB: count(R2_CLASS_B), bytes: now ? now.payloadSize + now.metadataSize - SPEND.baseBytes : 0 };
}

/** Swapped in tests: each test gets its own meter, and none calls Cloudflare. */
export const quotaDeps = { readCloudflare, readPlan, readSpend, name: 'account' };

/** Cloudflare's spend figures are read again after this; MailCellar's own count covers the gap. */
export const SPEND_READ_MS = 2 * 60_000;
/** MailCellar's own spend count is saved at most this often: one row, never one a message. */
export const SPEND_SAVE_MS = 60_000;
const NO_USE: SpendUse = { classA: 0, classB: 0, bytes: 0 };
const higher = (a: SpendUse, b: SpendUse): SpendUse => ({ classA: Math.max(a.classA, b.classA), classB: Math.max(a.classB, b.classB), bytes: Math.max(a.bytes, b.bytes) });

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
  /** MailCellar's own count of the backfill's spend use, kept in memory and saved once a minute. */
  private spendOurs: SpendUse | null = null;
  private spendSavedAt = 0;
  /** Cloudflare's figures, as last read. */
  private spendCf: { use: SpendUse; at: number; tried: number } | null = null;
  /** DO rows written each hour, as last read; in memory only (read again after a restart). */
  private doHours: { at: string; written: number }[] = [];

  private ownSpend(): SpendUse {
    if (!this.spendOurs) {
      const saved = this.meta('spend');
      this.spendOurs = saved ? (JSON.parse(saved) as SpendUse) : { ...NO_USE };
    }
    return this.spendOurs;
  }

  /** Spend use: the higher of MailCellar's own count and Cloudflare's, figure by figure. */
  private async spendUse(now = Date.now()): Promise<SpendUse> {
    const ours = this.ownSpend();
    if (!this.spendCf || now - this.spendCf.tried >= SPEND_READ_MS) {
      const tried = now;
      try {
        this.spendCf = { use: await quotaDeps.readSpend(this.env), at: now, tried };
      } catch {
        this.spendCf = this.spendCf ? { ...this.spendCf, tried } : { use: NO_USE, at: 0, tried };
      }
    }
    return higher(ours, this.spendCf.use);
  }

  /** Add what a run used to the backfill's spend. */
  async charge(use: Partial<SpendUse>): Promise<void> {
    const ours = this.ownSpend();
    ours.classA += use.classA ?? 0;
    ours.classB += use.classB ?? 0;
    ours.bytes += use.bytes ?? 0;
    if (Date.now() - this.spendSavedAt >= SPEND_SAVE_MS) {
      this.setMeta('spend', JSON.stringify(ours));
      this.spendSavedAt = Date.now();
    }
  }

  /** Whether a run that may use `next` still fits under the spend stop. Null: go ahead. */
  async overBudget(next: Partial<SpendUse>): Promise<SpendOverview | null> {
    const s = await this.spend();
    const after = s.spent + spendCost({ ...NO_USE, ...next });
    return after > s.stop ? s : null;
  }

  async spend(): Promise<SpendOverview> {
    const use = await this.spendUse();
    // The test switch can only lower the stop, never raise it.
    const stop = Math.min(SPEND.stop, this.testLimit()?.spendStop ?? SPEND.stop);
    const overage = this.overage();
    return { since: SPEND.since, cap: SPEND.cap, stop, spent: spendCost(use) + overage, use, overage, readAt: this.spendCf?.at ? new Date(this.spendCf.at).toISOString() : null };
  }

  /**
   * On Paid, dollars billed past the month's included Workers requests, DO and D1 rows (account
   * wide). They count toward the spend guard with the backfill's R2; R2 is counted above.
   */
  private overage(now = new Date()): number {
    if (this.plan !== 'paid') return 0;
    return metrics
      .filter((m) => m !== 'r2_class_a' && m !== 'r2_class_b')
      .reduce((t, m) => t + (quotaCost(this.limits[m], this.used(m, now).used) ?? 0), 0);
  }

  /** The end-to-end test switch while it lasts (TEST_MS from when it was set), else null. */
  private testLimit(now = new Date()): TestLimit | null {
    const saved = this.meta('test_limit');
    if (!saved) return null;
    const t = JSON.parse(saved) as TestLimit;
    return Date.parse(t.expiresAt) > now.getTime() ? t : null;
  }

  /**
   * Set the test switch for TEST_MS, or clear it with null: a DO-write stop `doWrites` rows above
   * today's use, a reset `resetMin` minutes away, and a lower spend stop. Admin only (index.ts).
   */
  async setTestLimit(o: { doWrites?: number; resetMin?: number; spendStop?: number } | null): Promise<TestLimit | null> {
    if (!o) {
      this.setMeta('test_limit', null);
      return null;
    }
    const now = new Date();
    await this.refresh(now);
    const t: TestLimit = {
      doStop: o.doWrites === undefined ? null : this.used('do_rows_written', now).used + o.doWrites,
      resetAt: new Date(now.getTime() + (o.resetMin ?? 3) * 60_000).toISOString(),
      spendStop: o.spendStop ?? null,
      expiresAt: new Date(now.getTime() + TEST_MS).toISOString(),
    };
    this.setMeta('test_limit', JSON.stringify(t));
    console.log(JSON.stringify({ testLimit: t }));
    return t;
  }

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

  /** Who may use MailCellar (members.ts): the kit's people service, on this object's own SQLite. */
  private peopleService: PeopleService | null = null;
  private async peopleNow(): Promise<PeopleService> {
    if (!this.peopleService) {
      const store = sqlStore(doSql(this.ctx.storage.sql));
      await store.init();
      // An invite turns active on its link's Accept, so the link in the email always works.
      this.peopleService = createPeople({ store, scopes: SCOPES, fixedAdmins: adminEmails(this.env), inviteDays: INVITE_DAYS, acceptOnSignIn: false });
    }
    return this.peopleService;
  }

  /** A verified sign-in: the person (their visit noted), or null when they may not come in. */
  async seen(email: string): Promise<Person | null> {
    return (await this.peopleNow()).seen(email);
  }

  /** One call on the people service; the kit's routes reach it through here. */
  async people<K extends PeopleOp>(op: K, args: Parameters<PeopleService[K]>): Promise<Awaited<ReturnType<PeopleService[K]>>> {
    const service = await this.peopleNow();
    return (service[op] as (...a: unknown[]) => Promise<Awaited<ReturnType<PeopleService[K]>>>)(...args);
  }

  /** The invite email settings (Admin ▸ Email), key included. Only the kit's routes read it; the key never goes back out. */
  emailSettings(): StoredEmailRow | null {
    const v = this.meta('email');
    return v ? (JSON.parse(v) as StoredEmailRow) : null;
  }

  setEmailSettings(row: StoredEmailRow | null): void {
    this.setMeta('email', row && JSON.stringify(row));
  }

  emailTest(): EmailCheck | null {
    const v = this.meta('email_test');
    return v ? (JSON.parse(v) as EmailCheck) : null;
  }

  setEmailTest(t: EmailCheck): void {
    this.setMeta('email_test', JSON.stringify(t));
  }

  /** The plan last read from Cloudflare; Free until one is read, and from PAID_ENDS whatever billing says. */
  private get plan(): QuotaPlan {
    return this.meta('plan') === 'paid' && paidNow() ? 'paid' : 'free';
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
      const { plan, billing, paidEnd } = await quotaDeps.readPlan(this.env, now);
      console.log('plan', plan, 'workers paid period ends', paidEnd);
      this.setMeta('plan', plan);
      this.setMeta('paid_end', paidEnd);
      this.setMeta('billing', billing && JSON.stringify(billing));
      this.setMeta('plan_read_at', now.toISOString());
      this.setMeta('plan_error', null);
    } catch (e) {
      this.setMeta('plan_error', e instanceof Error ? e.message : 'The plan could not be read.');
    }
  }

  /** MailCellar's own count this period. It is kept by UTC day, so a plan change keeps it. */
  /** MailCellar's own count of a meter today (UTC). */
  private today(metric: QuotaMetric, now: Date): number {
    return (
      this.ctx.storage.sql
        .exec<{ value: number }>(`SELECT value FROM usage WHERE period = ? AND metric = ?`, now.toISOString().slice(0, 10), metric)
        .toArray()[0]?.value ?? 0
    );
  }

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

  /** Read Cloudflare's figures at most once every `every` ms, whether the last try worked or not. */
  private async refresh(now: Date, every = CF_READ_MS) {
    await this.refreshPlan(now);
    const tried = this.meta('tried_at');
    if (tried && now.getTime() - Date.parse(tried) < every) return;
    this.setMeta('tried_at', now.toISOString());
    try {
      const cf = await quotaDeps.readCloudflare(this.env, this.plan, now, this.billing(now), this.names());
      for (const m of metrics)
        this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO cloudflare VALUES (?, ?, ?, ?)`, m, this.start(m, now), cf[m], this.ours(m, now));
      this.setMeta('parts', JSON.stringify(cf.parts ?? {}));
      this.setMeta('levels', JSON.stringify(cf.levels ?? {}));
      this.doHours = cf.doHours ?? [];
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
   * Whether a batch costing `cost` fits under the stop line of each hard limit it uses. Null: go
   * ahead. Else the first meter it would pass, and when that meter resets. A meter the batch
   * doesn't use never stops it (copying uses no DO rows, so the DO's limits pause only indexing).
   */
  async reserve(cost: QuotaUse): Promise<{ metric: QuotaMetric; label: string; resumesAt: string } | null> {
    const now = new Date();
    await this.refresh(now);
    // On Paid nothing is hard: a daily guard per meter keeps a runaway well under the month's allowance.
    if (this.plan === 'paid')
      for (const m of metrics) {
        const guard = PAID_DAILY_GUARD[m];
        if (guard && cost[m] && this.today(m, now) + cost[m] > guard)
          return { metric: m, label: `${this.limits[m].label} (daily guard)`, resumesAt: quotaReset('day', now).toISOString() };
      }
    // The test switch's DO-write stop holds indexing until its own near reset.
    const test = this.testLimit(now);
    if (test?.doStop != null && cost.do_rows_written && now.getTime() < Date.parse(test.resetAt) && this.used('do_rows_written', now).used + cost.do_rows_written > test.doStop)
      return { metric: 'do_rows_written', label: this.limits.do_rows_written.label, resumesAt: test.resetAt };
    for (const m of metrics) {
      if (!cost[m]) continue;
      const { limit, label, period, hard } = this.limits[m];
      if (hard && this.used(m, now).used + (cost[m] ?? 0) > limit * quotaStop(m))
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

  /** Refresh: read Cloudflare now, unless it was read in the last QUOTA_REFRESH_MS. */
  async readNow(): Promise<QuotaOverview> {
    return this.overview(QUOTA_REFRESH_MS);
  }

  async overview(every = CF_READ_MS): Promise<QuotaOverview> {
    const now = new Date();
    await this.refresh(now, every);
    const stored = this.meta('parts');
    const parts = (stored ? JSON.parse(stored) : {}) as Partial<Record<QuotaMetric, QuotaPart[]>>;
    const meters = metrics.map((m) => {
      const { label, limit, period, hard } = this.limits[m];
      const { used, ours } = this.used(m, now);
      const resetsAt = quotaReset(period, now, this.billing(now)).toISOString();
      return { metric: m, label, used, ours, limit, period, hard, cost: quotaCost(this.limits[m], used), resetsAt, parts: withOurs(parts[m] ?? [], used) };
    });
    const read = this.meta('read_at') !== null;
    const held = JSON.parse(this.meta('levels') ?? '{}') as Partial<Record<LevelMetric, QuotaPart[]>>;
    const levelPlan = levelLimits(this.plan);
    // A level shows once read; Workflows running is left out when the token can't list Workflows.
    const levels = read
      ? LEVEL_METRICS.filter((m) => held[m]).map((m) => {
          const l = levelPlan[m];
          const used = held[m]!.reduce((n, p) => n + p.value, 0);
          return { metric: m, label: l.label, unit: l.unit, used, limit: l.limit, cost: levelCost(l, used), parts: held[m]! };
        })
      : [];
    const tried = this.meta('tried_at');
    const test = this.testLimit(now);
    const testHeld = test?.doStop != null && now.getTime() < Date.parse(test.resetAt) && this.used('do_rows_written', now).used >= test.doStop;
    const over = testHeld
      ? { metric: 'do_rows_written' as const, label: this.limits.do_rows_written.label, resetsAt: test.resetAt }
      : meters.find((m) => m.hard && m.used >= m.limit * quotaStop(m.metric));
    return {
      plan: this.plan,
      planReadAt: this.meta('plan_read_at'),
      planError: this.meta('plan_error'),
      paidPeriodEnd: this.meta('paid_end'),
      readAt: this.meta('read_at'),
      readError: this.meta('read_error'),
      day: now.toISOString().slice(0, 10),
      billing: this.billing(now),
      meters,
      levels,
      doHours: this.doHours,
      refreshAt: new Date((tried ? Date.parse(tried) : now.getTime()) + QUOTA_REFRESH_MS).toISOString(),
      paused: over ? { metric: over.metric, label: over.label, resumesAt: over.resetsAt } : null,
      spend: await this.spend(),
    };
  }
}
