import { asUserId, mailboxName, MAX_LANES, type SyncParams, type SyncState, copyRate, withRecent } from '@mailcellar/schema';
import { introspectWorkflowInstance } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountMailbox, launchLanes, BATCH_BYTES, nextReset, RUN_CALLS, runBatch as run, runCensus, syncDeps, type RunOptions } from '../src/sync';
import { fileTarget } from './fixtures/basin';
import { fakeGmail, fakeMessages } from './fixtures/gmail';

const tables = new Map<string, ReturnType<typeof fileTarget>>();
const table = (user: string) => tables.get(user) ?? tables.set(user, fileTarget(user as never)).get(user)!;
// Every run writes Basin rows to a local Iceberg table for its user.
syncDeps.basin = async (_env, user) => table(user).target;
// Lanes and index builds this test would start, instead of starting Workflows.
let launched: (SyncParams & { id: string })[] = [];
syncDeps.launch = async (_env, params, id) => void launched.push({ ...params, id });
const roomy: RunOptions = { calls: RUN_CALLS, batchBytes: BATCH_BYTES };
const runBatch = (...[e, user, account, runId, limits]: Parameters<typeof run>) => run(e, user, account, runId, limits ?? roomy);

let n = 0;
/**
 * A user with one connected Gmail account, that account's sync claimed by run `runId`, and a
 * backfill of `months` queued (the fake's mail is in January 2024 unless a test dates it).
 */
async function setup(runId = 'run-1', state: Partial<SyncState> = {}, months = ['2024-01']) {
  const user = asUserId(`sync${++n}`);
  const account = `acct${n}`;
  await env.MAILBOX.getByName(mailboxName(user)).connectAccount({
    id: account, email: 'me@example.com', refreshToken: 'rt', scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  });
  const mailbox = accountMailbox(env, user, account);
  const now = new Date().toISOString();
  await mailbox.saveSync({
    phase: 'backfill', runId, total: null, copied: 0, bytes: 0, pending: [], pageToken: null, historyId: null,
    basinQueue: [], basinReady: false, startedAt: now, updatedAt: now, resumesAt: null, error: null, ...state,
  });
  if (months.length) await mailbox.queueMonths(months, 'Test');
  launched = [];
  return { user, account, mailbox };
}

describe('sync', () => {
  // Skip the one-second pause between Gmail batches.
  beforeEach(() => void vi.spyOn(scheduler, 'wait').mockResolvedValue(undefined));

  it('AC-PAUSE1 a paused backfill starts no lane', async () => {
    fakeGmail(fakeMessages(3));
    const { user, account } = await setup();
    await env.MAILBOX.getByName(mailboxName(user)).setBackfillPaused(true);
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: 0, more: false });
    expect(launched).toEqual([]);
    expect(await launchLanes(env, user, account)).toBe(0);
  });

  it('hands queued months to lanes and goes live', async () => {
    fakeGmail([]);
    const { user, account, mailbox } = await setup('run-1', {}, ['2023-01', '2023-02', '2023-03', '2023-04']);
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ phase: 'live', more: false });
    expect(launched.map((l) => l.month)).toEqual(['2023-04', '2023-03', '2023-02'].slice(0, MAX_LANES));
    expect((await mailbox.syncState())!.lanes).toEqual(['2023-04', '2023-03', '2023-02'].slice(0, MAX_LANES));
  });

  it('picks up new mail once live, and indexes it as soon as Basin has it', async () => {
    const mail = fakeMessages(2);
    fakeGmail(mail, { historyAdded: [mail[1].id] });
    const { user, account, mailbox } = await setup('run-1', { phase: 'live', historyId: '100', copied: 1 }, []);
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: 1, phase: 'live', more: false });
    expect((await mailbox.syncState())!.historyId).toBe('200');
    expect(await table(user).read()).toHaveLength(1);
    expect(await mailbox.archive('messages')).toHaveLength(1);
  });

  it('stops with a reason when Google no longer accepts the account', async () => {
    fakeGmail([], { tokenError: 'invalid_grant' });
    const { user, account, mailbox } = await setup('run-1', {}, []);
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ phase: 'error', more: false });
    expect((await mailbox.syncState())!.error).toMatch(/no longer accepts/);
  });

  it('stops a run that a newer run replaced', async () => {
    const calls = fakeGmail(fakeMessages(1));
    const { user, account } = await setup('run-2');
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ phase: 'replaced', more: false });
    expect(calls).toEqual([]);
  });

  it('resumes after the daily reset', () => {
    expect(nextReset(new Date('2026-10-24T18:00:00Z')).toISOString()).toBe('2026-10-25T00:05:00.000Z');
  });

  it('runs as a Workflow', async () => {
    const mail = fakeMessages(2);
    fakeGmail(mail, { historyAdded: mail.map((m) => m.id) });
    const { user, account, mailbox } = await setup('wf-1', { phase: 'live', historyId: '100' }, []);
    const instance = await introspectWorkflowInstance(env.SYNC, 'wf-1');
    try {
      await env.SYNC.create({ id: 'wf-1', params: { user, account } });
      await instance.waitForStatus('complete');
      expect(await instance.getOutput()).toMatchObject({ copied: 2, phase: 'live', more: false });
      expect((await mailbox.syncState())!.copied).toBe(2);
    } finally {
      await instance.dispose();
    }
  });
});

describe('basin check', () => {
  it('reports a missing token instead of failing', async () => {
    const { basinCheck } = await import('../src/basin');
    expect(await basinCheck(env)).toEqual({ ok: false, ms: 0, error: 'BASIN_TOKEN is not set' });
  });
});

describe('backfill by month', () => {
  beforeEach(() => void vi.spyOn(scheduler, 'wait').mockResolvedValue(undefined));
  const at = (iso: string, i: number) => ({ ...fakeMessages(1, i)[0], ts: Date.parse(iso) });

  it('counts each month from IDs, newest first, back past the first month with mail', async () => {
    const mail = [at('2026-01-15T00:00:00Z', 1), at('2026-01-20T00:00:00Z', 2), at('2025-11-01T00:00:00Z', 3)];
    fakeGmail(mail);
    const { user, account, mailbox } = await setup('run-1', {}, []);
    const now = new Date().toISOString();
    const census = { runId: 'c1', month: '2026-02', pageToken: null, n: 0, empty: 0, mode: 'full' as const, startedAt: now, updatedAt: now, finishedAt: null, error: null };
    await mailbox.saveCensus(census);
    // A small budget: the census stops part way and says there is more.
    expect(await runCensus(env, user, account, 'c1', 4)).toEqual({ more: true, counted: ['2026-02', '2026-01', '2025-12'] });
    expect((await mailbox.censusState())!.month).toBe('2025-11');
    const months = await mailbox.coverageMonths();
    expect(months.map((m) => [m.month, m.gmail])).toEqual([['2025-12', 0], ['2026-01', 2], ['2026-02', 0]]);
    // Months counted after they ended are final: a refresh stops at the first one.
    await mailbox.saveCensus({ ...census, runId: 'c2', month: '2026-03', mode: 'refresh' });
    expect(await runCensus(env, user, account, 'c2', 10)).toEqual({ more: false, counted: ['2026-03'] });
  });

  it('ends the census after a year with no mail before Gmail began', async () => {
    const calls = fakeGmail([at('2004-04-02T00:00:00Z', 1)]);
    const { user, account, mailbox } = await setup('run-1', {}, []);
    const now = new Date().toISOString();
    await mailbox.saveCensus({ runId: 'c1', month: '2004-05', pageToken: null, n: 0, empty: 0, mode: 'full', startedAt: now, updatedAt: now, finishedAt: null, error: null });
    expect(await runCensus(env, user, account, 'c1', 40)).toMatchObject({ more: false });
    const c = (await mailbox.censusState())!;
    expect([c.month, c.finishedAt !== null]).toEqual([null, true]);
    expect(calls.filter((x) => x.startsWith('q=before:'))).toHaveLength(1);
    expect((await mailbox.coverageMonths()).find((m) => m.month === '2004-04')?.gmail).toBe(1);
  });

  it('AC-RATE1 the rate is messages a minute over the last 10 minutes, and a stall brings it down', () => {
    const t = (min: number) => new Date(Date.UTC(2026, 9, 24, 20, min)).toISOString();
    let s = { copied: 0 } as SyncState;
    for (const [min, copied] of [[0, 0], [5, 400], [10, 800], [15, 1200]] as const) {
      s = { ...s, copied };
      s = { ...s, recent: withRecent(s, t(min)) };
    }
    expect(copyRate(s, Date.parse(t(15)))).toBe(80);
    expect(copyRate(s, Date.parse(t(25)))).toBe(0);
    expect(copyRate({ ...s, recent: [{ at: t(15), copied: 1200 }] }, Date.parse(t(15)))).toBeNull();
  });
});
