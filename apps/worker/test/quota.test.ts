import { asUserId, mailboxName, QUOTA_LIMITS, type QuotaMetric, type QuotaOverview } from '@mailcellar/schema';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountQuota, quotaDeps, readCloudflare } from '../src/quota';
import { accountMailbox, BATCH_BYTES, RUN_CALLS, runBatch, runCensus } from '../src/sync';
import { fakeGmail, fakeMessages } from './fixtures/gmail';
import { mockFetch, signIn } from './helpers';

const zero = Object.fromEntries(Object.keys(QUOTA_LIMITS).map((m) => [m, 0])) as Record<QuotaMetric, number>;
const realRead = quotaDeps.readCloudflare;
let n = 0;
// Each test gets its own account meter, so figures never leak between tests.
beforeEach(() => void (quotaDeps.name = `quota-test-${++n}`));
afterEach(() => void Object.assign(quotaDeps, { readCloudflare: realRead, name: 'account' }));

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
            { dimensions: { actionType: 'PutObject' }, sum: { requests: 800 } },
            { dimensions: { actionType: 'UploadPart' }, sum: { requests: 200 } },
            { dimensions: { actionType: 'GetObject' }, sum: { requests: 5000 } },
            { dimensions: { actionType: 'DeleteObject' }, sum: { requests: 99 } },
          ],
        }] } },
        errors: null,
      });
    });
    const now = new Date('2026-10-24T18:00:00Z');
    const cf = await readCloudflare({ ...env, CF_ANALYTICS_TOKEN: 'test-token', CF_ACCOUNT_ID: 'acct-1' }, now);
    expect(cf).toEqual({
      workers_requests: 1958, do_rows_written: 15929, do_rows_read: 6117, d1_rows_written: 3690, d1_rows_read: 27604,
      r2_class_a: 1000, r2_class_b: 5000,
    });
    expect(sent!.variables).toEqual({ a: 'acct-1', day: '2026-10-24', from: '2026-10-24T00:00:00Z', to: now.toISOString(), month: '2026-10-01' });
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
});
