import { asUserId, mailboxName, QUOTA_METRICS, type QuotaMetric, type QuotaOverview } from '@mailcellar/schema';
import { introspectWorkflowInstance } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountQuota, quotaDeps, readCloudflare, readPlan, topParts } from '../src/quota';
import { accountMailbox, BATCH_BYTES, RUN_CALLS, runBatch, runCensus } from '../src/sync';
import { fakeGmail, fakeMessages } from './fixtures/gmail';
import { mockFetch, signIn } from './helpers';

const zero = Object.fromEntries(QUOTA_METRICS.map((m) => [m, 0])) as Record<QuotaMetric, number>;
const real = { ...quotaDeps };
let n = 0;
// Each test gets its own account meter, so figures never leak between tests.
beforeEach(() => void (quotaDeps.name = `quota-test-${++n}`));
afterEach(() => void Object.assign(quotaDeps, real));

/** Cloudflare's figures for the account, as a test sets them. */
const cloudflare = (figures: Partial<Record<QuotaMetric, number>>) =>
  void (quotaDeps.readCloudflare = async () => ({ ...zero, ...figures }));

async function connected() {
  const user = asUserId(`quota${n}`);
  const account = `acct-q${n}`;
  await env.MAILBOX.getByName(mailboxName(user)).connectAccount({
    id: account, email: 'me@example.com', refreshToken: 'rt', scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  });
  return { user, account, mailbox: accountMailbox(env, user, account) };
}

describe('Account limits', () => {
  it("AC-Q1 without Cloudflare's figures, /api/quota shows MailCellar's own count and why", async () => {
    await accountQuota(env).add({ do_rows_written: 1200, r2_class_a: 40 });
    const { api } = await signIn('quota1@example.com');
    const q = (await (await api('/api/quota')).json()) as QuotaOverview;
    expect(q.readAt).toBeNull();
    expect(q.readError).toBe('No Cloudflare analytics token is set.');
    expect(q.paused).toBeNull();
    const by = Object.fromEntries(q.meters.map((m) => [m.metric, m]));
    // Its own writes to the meter count too: one row a metric, plus one.
    expect(by.do_rows_written).toMatchObject({ used: 1203, ours: 1203, limit: 100_000, hard: true });
    expect(by.r2_class_a).toMatchObject({ used: 40, hard: false, cost: 0 });
  });

  it("AC-Q2 reads the whole account from Cloudflare's analytics, R2 by class", async () => {
    let sent: { query: string; variables: Record<string, string> } | undefined;
    mockFetch(async (url, init) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
      sent = JSON.parse(String(init?.body));
      return Response.json({
        data: { viewer: { accounts: [{
          workers: [{ sum: { requests: 1958 } }],
          dos: [{ sum: { rowsRead: 6117, rowsWritten: 15929 } }],
          d1: [{ sum: { rowsRead: 27604, rowsWritten: 3690 } }],
          r2: [
            { dimensions: { actionType: 'PutObject', bucketName: 'mailcellar' }, sum: { requests: 800 } },
            { dimensions: { actionType: 'UploadPart', bucketName: 'other' }, sum: { requests: 200 } },
            { dimensions: { actionType: 'GetObject', bucketName: 'other' }, sum: { requests: 5000 } },
            { dimensions: { actionType: 'DeleteObject', bucketName: 'mailcellar' }, sum: { requests: 99 } },
          ],
        }] } },
        errors: null,
      });
    });
    const now = new Date('2026-10-24T18:00:00Z');
    const cf = await readCloudflare({ ...env, CF_ANALYTICS_TOKEN: 'test-token', CF_ACCOUNT_ID: 'acct-1' }, 'free', now);
    expect(cf).toEqual({
      workers_requests: 1958, do_rows_written: 15929, do_rows_read: 6117, d1_rows_written: 3690, d1_rows_read: 27604,
      r2_class_a: 1000, r2_class_b: 5000,
      // Who used each meter, most first, so the page shows which project drives it.
      parts: {
        workers_requests: [{ name: 'Unnamed', value: 1958, mine: false }],
        do_rows_written: [{ name: 'Unnamed', value: 15929, mine: false }],
        do_rows_read: [{ name: 'Unnamed', value: 6117, mine: false }],
        d1_rows_written: [{ name: 'Unnamed', value: 3690, mine: false }],
        d1_rows_read: [{ name: 'Unnamed', value: 27604, mine: false }],
        r2_class_a: [{ name: 'mailcellar', value: 800, mine: true }, { name: 'other', value: 200, mine: false }],
        r2_class_b: [{ name: 'other', value: 5000, mine: false }],
      },
    });
    // On Free, Workers, DO and D1 count today; R2 counts the month.
    expect(sent!.variables).toEqual({ a: 'acct-1', workers: '2026-10-24T00:00:00Z', to: now.toISOString(), dos: '2026-10-24', d1: '2026-10-24', r2: '2026-10-01' });
    // On Paid, everything counts the month.
    await readCloudflare({ ...env, CF_ANALYTICS_TOKEN: 'test-token', CF_ACCOUNT_ID: 'acct-1' }, 'paid', now);
    expect(sent!.variables).toEqual({ a: 'acct-1', workers: '2026-10-01T00:00:00Z', to: now.toISOString(), dos: '2026-10-01', d1: '2026-10-01', r2: '2026-10-01' });
    // With a billing period, monthly meters count from its first day.
    await readCloudflare({ ...env, CF_ANALYTICS_TOKEN: 'test-token', CF_ACCOUNT_ID: 'acct-1' }, 'free', now, { start: '2026-10-09T00:00:00.000Z', end: '2026-11-09T00:00:00.000Z' });
    expect(sent!.variables).toMatchObject({ dos: '2026-10-24', r2: '2026-10-09' });
  });

  it('AC-Q3 a backfill pauses before a hard daily limit, says which, and resumes after the reset', async () => {
    cloudflare({ do_rows_written: 89_500 });
    fakeGmail(fakeMessages(3));
    const { user, account, mailbox } = await connected();
    const now = new Date().toISOString();
    await mailbox.saveSync({
      phase: 'backfill', runId: 'run-q', total: null, copied: 0, bytes: 0, pending: [], pageToken: null, historyId: null,
      basinQueue: [], basinReady: false, startedAt: now, updatedAt: now, resumesAt: null, error: null,
    });
    await mailbox.queueMonths(['2024-01'], 'Test');
    const r = await runBatch(env, user, account, 'run-q', { calls: RUN_CALLS, batchBytes: BATCH_BYTES });
    const reset = new Date();
    reset.setUTCDate(reset.getUTCDate() + 1);
    const resumesAt = `${reset.toISOString().slice(0, 10)}T00:05:00.000Z`;
    expect(r).toEqual({ copied: 0, phase: 'paused', more: true, resumesAt });
    expect((await mailbox.syncState())!).toMatchObject({ phase: 'paused', pausedFor: 'Durable Object rows written', copied: 0 });
    const q = await accountQuota(env).overview();
    expect(q.paused).toBeNull(); // 89.5% is under the stop line; only the run's cost would pass it.
  });

  it('AC-Q4 R2 past its free tier is billed, never paused', async () => {
    cloudflare({ r2_class_a: 2_000_000, r2_class_b: 9_500_000 });
    expect(await accountQuota(env).reserve({ r2_class_a: 1000, r2_class_b: 1000 })).toBeNull();
    const q = await accountQuota(env).overview();
    expect(q.readError).toBeNull();
    expect(q.readAt).not.toBeNull();
    const a = q.meters.find((m) => m.metric === 'r2_class_a')!;
    expect(a.cost).toBeCloseTo(4.5);
    expect(q.paused).toBeNull();
  });

  it("AC-Q5 adds MailCellar's count since Cloudflare's last read, and shows a pause once over the line", async () => {
    cloudflare({ workers_requests: 80_000 });
    const quota = accountQuota(env);
    await quota.overview(); // reads Cloudflare: 80,000
    quotaDeps.readCloudflare = async () => { throw new Error('should not read again within 5 minutes'); };
    await quota.add({ workers_requests: 11_000 });
    const q = await quota.overview();
    expect(q.meters.find((m) => m.metric === 'workers_requests')!.used).toBe(91_000);
    expect(q.paused).toMatchObject({ metric: 'workers_requests', label: 'Worker requests' });
  });

  it('AC-Q6 a census pauses before a hard limit and resumes after the reset', async () => {
    cloudflare({ do_rows_read: 4_600_000 });
    const { user, account, mailbox } = await connected();
    const now = new Date().toISOString();
    await mailbox.saveCensus({ runId: 'c1', month: '2026-03', pageToken: null, n: 0, empty: 0, mode: 'full', startedAt: now, updatedAt: now, finishedAt: null, error: null });
    expect(await runCensus(env, user, account, 'c1', 40)).toEqual({ more: false, counted: [] });
    const c = (await mailbox.censusState())!;
    expect(c.error).toBe("Paused before the account's daily limit (Durable Object rows read).");
    expect(Date.parse(c.resumesAt!)).toBeGreaterThan(Date.now());
  });

  it('AC-Q7 on Workers Paid, limits are monthly allowances that bill past them, so nothing pauses', async () => {
    quotaDeps.readPlan = async () => ({ plan: 'paid', billing: null });
    cloudflare({ do_rows_written: 60_000_000, workers_requests: 9_000_000 });
    const quota = accountQuota(env);
    expect(await quota.reserve({ do_rows_written: 100_000 })).toBeNull();
    const q = await quota.overview();
    expect(q.plan).toBe('paid');
    expect(q.planError).toBeNull();
    expect(q.paused).toBeNull();
    expect(q.meters.every((m) => !m.hard && m.period === 'month')).toBe(true);
    const w = q.meters.find((m) => m.metric === 'do_rows_written')!;
    expect(w).toMatchObject({ limit: 50_000_000, used: 60_000_000 });
    expect(w.cost).toBeCloseTo(10);
  });

  it("AC-Q8 reads the plan from the account's subscriptions; without a billing token it is Free and says so", async () => {
    const q = await accountQuota(env).overview();
    expect(q.plan).toBe('free');
    expect(q.planReadAt).toBeNull();
    expect(q.planError).toBe('No Cloudflare billing token is set, so the plan is taken as Workers Free.');

    let subs: unknown[] = [];
    mockFetch(async (url, init) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-1/subscriptions');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer bill-token');
      return Response.json({ success: true, result: subs });
    });
    const e = { ...env, CF_BILLING_TOKEN: 'bill-token', CF_ACCOUNT_ID: 'acct-1' };
    const now = new Date('2026-10-24T18:00:00Z');
    subs = [{ state: 'Paid', rate_plan: { id: 'r2_paid', public_name: 'R2 Paid' }, current_period_start: '2026-10-09T00:00:00Z', current_period_end: '2026-11-09T00:00:00Z' }];
    expect(await readPlan(e, now)).toEqual({ plan: 'free', billing: { start: '2026-10-09T00:00:00.000Z', end: '2026-11-09T00:00:00.000Z' } });
    subs.push({ state: 'Paid', rate_plan: { id: 'workers_paid', public_name: 'Workers Paid' } });
    expect((await readPlan(e, now)).plan).toBe('paid');
    subs = [];
    expect(await readPlan(e, now)).toEqual({ plan: 'free', billing: null });
  });

  it('AC-Q9 monthly meters reset when the billing period ends, and R2 shows by bucket', async () => {
    const end = new Date(Date.now() + 9 * 86_400_000).toISOString();
    const start = new Date(Date.now() - 20 * 86_400_000).toISOString();
    quotaDeps.readPlan = async () => ({ plan: 'free', billing: { start, end } });
    let from: unknown;
    quotaDeps.readCloudflare = async (_e, _p, _now, billing) => {
      from = billing;
      return { ...zero, r2_class_a: 1_500_000, parts: { r2_class_a: [{ name: 'market-data', value: 1_499_000, mine: false }, { name: 'mailcellar', value: 1000, mine: true }] } };
    };
    const q = await accountQuota(env).overview();
    expect(from).toEqual({ start, end });
    expect(q.billing).toEqual({ start, end });
    expect(q.meters.find((m) => m.metric === 'r2_class_a')!.resetsAt).toBe(end);
    expect(Date.parse(q.meters.find((m) => m.metric === 'do_rows_written')!.resetsAt)).toBeLessThan(Date.parse(end));
    expect(q.meters.find((m) => m.metric === 'r2_class_a')!.parts.map((p) => p.name)).toEqual(['market-data', 'mailcellar']);
  });

  it('AC-Q10 each meter splits by project: top five, Other, and MailCellar always shown, with its count since the read', async () => {
    const usage = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x, i) => [x, 1000 - i * 100]));
    const names = new Map([...Object.entries(usage), ['mailcellar', 10]]);
    quotaDeps.readCloudflare = async () => ({ ...zero, workers_requests: 4910, parts: { workers_requests: topParts(names) } });
    const quota = accountQuota(env);
    await quota.overview();
    await quota.add({ workers_requests: 5 });
    const w = (await quota.overview()).meters.find((m) => m.metric === 'workers_requests')!;
    expect(w.parts).toEqual([
      { name: 'a', value: 1000, mine: false }, { name: 'b', value: 900, mine: false }, { name: 'c', value: 800, mine: false },
      { name: 'd', value: 700, mine: false }, { name: 'e', value: 600, mine: false },
      { name: 'mailcellar', value: 15, mine: true }, { name: 'Other', value: 900, mine: false },
    ]);
  });

  it('AC-Q11 names for namespace and database IDs, kept through the Workflows API', async () => {
    let known: Record<string, string> = {};
    quotaDeps.readCloudflare = async (_e, _p, _n, _b, k) => ((known = k ?? {}), { ...zero });
    const instance = await introspectWorkflowInstance(env.SYNC, 'names-1');
    try {
      await env.SYNC.create({ id: 'names-1', params: { user: 'names', account: 'names', names: { ec5dad1c: 'mailcellar MailboxDO' } } });
      await instance.waitForStatus('complete');
    } finally {
      await instance.dispose();
    }
    await accountQuota(env).overview();
    expect(known).toEqual({ ec5dad1c: 'mailcellar MailboxDO' });
  });
});
