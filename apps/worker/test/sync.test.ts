import { asUserId, mailboxName, MAX_LANES, r2Keys, type SyncParams, type SyncState, copyRate, withRecent } from '@mailcellar/schema';
import { introspectWorkflowInstance } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountMailbox, BASIN_BEHIND, launchLanes, BATCH_BYTES, messageCpuMs, nextReset, RUN_CALLS, RUN_SIZE, runBatch as run, runCensus, runIndex, syncDeps, type RunOptions } from '../src/sync';
import { fileTarget } from './fixtures/basin';
import { fakeGmail, fakeMessages, fakeRaw } from './fixtures/gmail';

const tables = new Map<string, ReturnType<typeof fileTarget>>();
const table = (user: string) => tables.get(user) ?? tables.set(user, fileTarget(user as never)).get(user)!;
// Every run writes Basin rows to a local Iceberg table for its user.
syncDeps.basin = async (_env, user) => table(user).target;
// Lanes and index builds this test would start, instead of starting Workflows.
let launched: (SyncParams & { id: string })[] = [];
syncDeps.launch = async (_env, params, id) => void launched.push({ ...params, id });
const roomy: RunOptions = { calls: RUN_CALLS, batchBytes: BATCH_BYTES };
const runBatch = (...[e, user, account, runId, limits, month]: Parameters<typeof run>) => run(e, user, account, runId, limits ?? roomy, month);

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

/** One run of a month's lane, as the lane's current run. */
async function lane(user: string, account: string, month: string, limits?: RunOptions) {
  const s = await accountMailbox(env, asUserId(user), account).laneState(month);
  return runBatch(env, asUserId(user), account, s?.runId ?? 'none', limits, month);
}

/** Today's rows written by the account's mailbox. */
async function rowsWritten(user: string, account: string) {
  const usage = await accountMailbox(env, asUserId(user), account).usage();
  return usage.filter((u) => u.metric === 'do_rows_written').reduce((t, u) => t + u.value, 0);
}

describe('sync', () => {
  // Skip the one-second pause between Gmail batches.
  beforeEach(() => void vi.spyOn(scheduler, 'wait').mockResolvedValue(undefined));

  it('AC-BF1 copies a month to R2 and Basin with no index rows, then builds its index from Basin once it lands', async () => {
    const mail = fakeMessages(3);
    mail[0].raw = fakeRaw(1, { subject: 'Big one', pad: 300 * 1024 });
    mail[1].labels = ['INBOX', 'Label_1'];
    fakeGmail(mail);
    const { user, account, mailbox } = await setup();
    // The account's own run hands the month to a lane and goes live.
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: 0, phase: 'live', more: false });
    expect(launched.map((l) => l.month)).toEqual(['2024-01']);
    const before = await rowsWritten(user, account);
    expect(await lane(user, account, '2024-01')).toEqual({ copied: 3, phase: 'backfill', more: false, resumesAt: null });
    // Copying wrote a few rows of progress, none per message, and nothing to the index yet.
    expect((await rowsWritten(user, account)) - before).toBeLessThan(20);
    expect(await mailbox.archive('messages')).toEqual([]);
    const s = (await mailbox.syncState())!;
    expect([s.total, s.copied, s.historyId, s.lanes]).toEqual([3, 3, '200', []]);
    // Raw mail in R2: small mail gzipped, mail over 256 KB as it is.
    const small = await env.ARCHIVE.get(r2Keys.raw(user, account, mail[1].id));
    const big = await env.ARCHIVE.get(r2Keys.raw(user, account, mail[0].id));
    expect(small?.httpMetadata?.contentEncoding).toBe('gzip');
    expect(await new Response(small!.body.pipeThrough(new DecompressionStream('gzip'))).text()).toBe(mail[1].raw);
    expect(big?.httpMetadata?.contentEncoding).toBeUndefined();
    expect(await big!.text()).toBe(mail[0].raw);
    // Basin, the system of record, has a row for each message, with its body text.
    const basin = await table(user).read();
    expect(basin.map((r) => r.subject).sort()).toEqual(['Big one', 'Test 2', 'Test 3']);
    expect(basin.find((r) => r.subject === 'Test 2')).toMatchObject({ account, from_addr: 's2@example.com', body_text: 'Body 2', raw_key: r2Keys.raw(user, account, mail[1].id) });
    // The month landed: done, and its index build started.
    let [m] = await mailbox.coverageMonths();
    expect([m.state, m.inBasin, m.landed, m.indexed, m.copied]).toEqual(['done', 3, true, 0, 3]);
    expect(launched.at(-1)).toMatchObject({ user, account, index: '2024-01' });
    expect(await runIndex(env, user, account, '2024-01')).toEqual({ indexed: 3, next: null, resumesAt: null });
    const rows = (await mailbox.archive('messages')) as { subject: string; labels: string[] }[];
    expect(rows.map((r) => r.subject).sort()).toEqual(['Big one', 'Test 2', 'Test 3']);
    expect(rows.find((r) => r.subject === 'Test 2')?.labels).toEqual(['INBOX', 'Label_1']);
    const labels = (await mailbox.archive('labels')) as { id: string; name: string }[];
    expect(labels.find((l) => l.id === 'Label_1')?.name).toBe('Receipts');
    [m] = await mailbox.coverageMonths();
    expect([m.inBasin, m.landed, m.indexed]).toEqual([3, true, 3]);
    // Building it again changes nothing.
    expect(await runIndex(env, user, account, '2024-01')).toMatchObject({ indexed: 0, next: null });
  });

  it('AC-BF2 copies queued months in parallel, newest first, at most MAX_LANES at once; a landed lane takes the next month', async () => {
    const months = Array.from({ length: MAX_LANES + 2 }, (_, i) => `2023-${String(i + 1).padStart(2, '0')}`);
    fakeGmail([]);
    const { user, account, mailbox } = await setup('run-1', {}, months);
    await runBatch(env, user, account, 'run-1');
    const first = launched.map((l) => l.month!);
    expect(first).toEqual([...months].reverse().slice(0, MAX_LANES));
    expect((await mailbox.syncState())!.lanes).toEqual(first);
    // An empty month lands at once, and its lane starts the next queued month.
    launched = [];
    expect(await lane(user, account, first[0])).toMatchObject({ copied: 0, more: false });
    expect(launched.map((l) => l.index ?? l.month)).toEqual([first[0], months[1]]);
    // A lane that stopped saving (its run died) is started again where it stood.
    await mailbox.saveLane(first[1], { ...(await mailbox.laneState(first[1]))!, updatedAt: '2020-01-01T00:00:00.000Z' }, (await mailbox.laneState(first[1]))!.runId, { copied: 0, bytes: 0 });
    expect(await mailbox.claimLanes(MAX_LANES, account)).toEqual([{ month: first[1], runId: expect.stringContaining(`${account}-${first[1]}-`) }]);
    expect(await mailbox.claimLanes(MAX_LANES, account)).toEqual([]);
  });

  it('copies RUN_SIZE messages a lane run, then asks for another run', async () => {
    fakeGmail(fakeMessages(RUN_SIZE + 20));
    const { user, account } = await setup();
    await runBatch(env, user, account, 'run-1');
    const big = { ...roomy, cpuMs: 1e9 };
    expect(await lane(user, account, '2024-01', big)).toMatchObject({ copied: RUN_SIZE, more: true });
    expect(await lane(user, account, '2024-01', big)).toMatchObject({ copied: 20, more: false });
    expect(await table(user).read()).toHaveLength(RUN_SIZE + 20);
  }, 30_000);

  it('skips mail the index already has', async () => {
    const mail = fakeMessages(3);
    fakeGmail(mail);
    const { user, account, mailbox } = await setup();
    await mailbox.ingest([{ id: mail[0].id, threadId: mail[0].id, ts: Date.UTC(2024, 0, 1), fromAddr: 'a@b.c', fromName: '', subject: 'x', snippet: '', size: 1, attachments: 0, labels: [] }]);
    await runBatch(env, user, account, 'run-1');
    expect(await lane(user, account, '2024-01')).toMatchObject({ copied: 2, more: false });
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

  it('moves a month a single-run sync was copying into a lane, with what it had listed', async () => {
    const mail = fakeMessages(3);
    fakeGmail(mail);
    const { user, account, mailbox } = await setup('run-1', { historyId: '100' });
    const part = (await mailbox.nextPart())!;
    await mailbox.saveSync({ ...(await mailbox.syncState())!, part, pending: [mail[2].id], pageToken: null });
    await runBatch(env, user, account, 'run-1');
    expect(launched.map((l) => l.month)).toEqual(['2024-01']);
    expect((await mailbox.syncState())!).toMatchObject({ phase: 'live', part: null, pending: [] });
    expect(await lane(user, account, '2024-01')).toMatchObject({ copied: 1, more: false });
  });

  it('keeps messages Gmail rate-limited for the next run', async () => {
    const mail = fakeMessages(3);
    fakeGmail(mail, { failOnce: { [mail[2].id]: 429 } });
    const { user, account, mailbox } = await setup();
    await runBatch(env, user, account, 'run-1');
    expect(await lane(user, account, '2024-01')).toMatchObject({ copied: 2, more: true });
    expect((await mailbox.laneState('2024-01'))!.pending).toEqual([mail[2].id]);
    expect(await lane(user, account, '2024-01')).toMatchObject({ copied: 1, more: false });
    expect(await table(user).read()).toHaveLength(3);
  });

  it('AC-BF5 a held backfill starts no month: queued months wait', async () => {
    const { user, account, mailbox } = await setup();
    const held = { ...env, BACKFILL_PAUSED: '1' };
    launched.length = 0;
    expect(await launchLanes(held, user, account)).toBe(0);
    expect(launched).toEqual([]);
    expect(await mailbox.hasQueued()).toBe(true);
  });

  it('keeps a batch staged when Basin fails, and commits it with the next run', async () => {
    fakeGmail(fakeMessages(2));
    const { user, account, mailbox } = await setup();
    await runBatch(env, user, account, 'run-1');
    const failing: RunOptions = { ...roomy, basin: async () => ({ ensure: async () => { throw new Error('catalog down'); }, append: async () => {}, monthRows: async () => [] }) };
    const r = await lane(user, account, '2024-01', failing);
    expect(r).toMatchObject({ copied: 2, more: true });
    expect(r.resumesAt).not.toBeNull();
    const s = (await mailbox.laneState('2024-01'))!;
    expect(s.basinQueue).toHaveLength(1);
    expect(s.error).toMatch(/Basin didn't take/);
    // Not landed while a batch is staged.
    expect((await mailbox.coverageMonths())[0]).toMatchObject({ state: 'running', inBasin: 2, landed: false });
    expect(await lane(user, account, '2024-01')).toMatchObject({ copied: 0, more: false });
    expect(await table(user).read()).toHaveLength(2);
    expect(await env.ARCHIVE.get(s.basinQueue[0])).toBeNull();
  });

  it('AC-BF3 commits one run at a time: a lane without the turn keeps its batch staged and copies on', async () => {
    fakeGmail(fakeMessages(4));
    const { user, account, mailbox } = await setup();
    await runBatch(env, user, account, 'run-1');
    expect(await mailbox.commitTurn('someone-else', 60_000)).toBe(true);
    const two = { ...roomy, cpuMs: messageCpuMs(1000) * 2.5 };
    expect(await lane(user, account, '2024-01', two)).toMatchObject({ copied: 2, more: true });
    expect((await mailbox.laneState('2024-01'))!).toMatchObject({ basinQueue: [expect.any(String)], basinReady: false });
    await mailbox.endCommitTurn('someone-else');
    expect(await lane(user, account, '2024-01', two)).toMatchObject({ copied: 2, more: false });
    expect(await table(user).read()).toHaveLength(4);
  });

  it('AC-CPU1 stops a run at its CPU budget and leaves the rest for the next run', async () => {
    const mail = fakeMessages(10);
    for (const m of mail) m.raw = fakeRaw(1, { pad: 100 * 1024 });
    fakeGmail(mail);
    const { user, account, mailbox } = await setup();
    await runBatch(env, user, account, 'run-1');
    // Room for 4 of these messages, as estimated.
    const cpuMs = messageCpuMs(100 * 1024) * 4.5;
    expect(await lane(user, account, '2024-01', { ...roomy, cpuMs })).toMatchObject({ copied: 4, more: true });
    expect((await mailbox.laneState('2024-01'))!.pending).toHaveLength(6);
    expect(await table(user).read()).toHaveLength(4);
    // A message bigger than the whole budget still goes, alone.
    expect(await lane(user, account, '2024-01', { ...roomy, cpuMs: 1 })).toMatchObject({ copied: 1, more: true });
  });

  it('AC-CPU2 a lane with Basin behind only commits', async () => {
    fakeGmail(fakeMessages(6));
    const { user, account, mailbox } = await setup();
    await runBatch(env, user, account, 'run-1');
    const failing: RunOptions = { ...roomy, cpuMs: messageCpuMs(1000) * 1.5, basin: async () => ({ ensure: async () => { throw new Error('catalog down'); }, append: async () => {}, monthRows: async () => [] }) };
    for (let i = 0; i < BASIN_BEHIND; i++) {
      const s = (await mailbox.laneState('2024-01'))!;
      await mailbox.handLane('2024-01', s.runId, s.runId);
      await lane(user, account, '2024-01', failing);
    }
    expect((await mailbox.laneState('2024-01'))!.basinQueue).toHaveLength(BASIN_BEHIND);
    expect(await lane(user, account, '2024-01')).toMatchObject({ copied: 0, more: true });
    expect((await mailbox.laneState('2024-01'))!.basinQueue).toHaveLength(BASIN_BEHIND - 2);
  });

  it('fails the month being copied when Google refuses, with the reason', async () => {
    fakeGmail([], { tokenError: 'invalid_grant' });
    const { user, account, mailbox } = await setup('run-1', { historyId: '100' });
    await mailbox.claimLanes(MAX_LANES, account);
    expect(await lane(user, account, '2024-01')).toMatchObject({ phase: 'error', more: false });
    const [m] = await mailbox.coverageMonths();
    expect([m.state, m.error]).toEqual(['failed', expect.stringMatching(/no longer accepts/)]);
    expect((await mailbox.jobList())[0].status).toBe('failed');
    expect(await mailbox.laneState('2024-01')).toBeNull();
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
    expect(await runBatch(env, user, account, 'run-1', undefined, '2024-01')).toMatchObject({ phase: 'replaced', more: false });
    expect(calls).toEqual([]);
  });

  it('packs big mail into small raw batches and stops at the request budget', async () => {
    const mail = fakeMessages(60);
    // Over half the batch size each, so every big one is fetched alone.
    for (const m of mail.slice(0, 50)) m.raw = fakeRaw(1, { pad: 6000 });
    fakeGmail(mail);
    const { user, account, mailbox } = await setup('run-1', { historyId: '100' });
    await mailbox.claimLanes(MAX_LANES, account);
    const calls = fakeGmail(mail);
    const r = await lane(user, account, '2024-01', { calls: RUN_CALLS, batchBytes: 10_000 });
    // token, list and 2 size batches, with 7 calls kept for the Basin commit, leave 34 of
    // the 45 calls for raw batches.
    expect(calls.filter((c) => c.includes('batch'))).toHaveLength(2 + 34);
    expect(r).toMatchObject({ copied: 34, more: true });
    expect((await mailbox.laneState('2024-01'))!.pending).toHaveLength(26);
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

  it('copies only the queued months, each in its own lane, and marks each done', async () => {
    const mail = [at('2023-12-31T23:59:59Z', 1), at('2024-01-01T00:00:00Z', 2), at('2024-02-10T00:00:00Z', 3), at('2024-03-05T00:00:00Z', 4)];
    const calls = fakeGmail(mail);
    const { user, account, mailbox } = await setup('run-1', {}, ['2024-01', '2024-02']);
    await runBatch(env, user, account, 'run-1');
    expect(launched.map((l) => l.month)).toEqual(['2024-02', '2024-01']);
    expect(await lane(user, account, '2024-02')).toMatchObject({ copied: 1, more: false });
    expect(calls.filter((c) => c.startsWith('q='))).toEqual([`q=after:${Date.UTC(2024, 1, 1) / 1000 - 1} before:${Date.UTC(2024, 2, 1) / 1000}`]);
    expect(await lane(user, account, '2024-01')).toMatchObject({ copied: 1, more: false });
    const months = await mailbox.coverageMonths();
    expect(months.map((m) => [m.month, m.copied, m.state])).toEqual([['2024-01', 1, 'done'], ['2024-02', 1, 'done']]);
    const [job] = await mailbox.jobList();
    expect([job.status, job.months.done, job.from, job.to]).toEqual(['done', 2, '2024-01', '2024-02']);
  });

  it('ends a lane whose month was taken out of the queue', async () => {
    fakeGmail([at('2024-01-02T00:00:00Z', 1), at('2024-02-02T00:00:00Z', 2)]);
    const { user, account, mailbox } = await setup('run-1', { historyId: '100' }, []);
    const first = (await mailbox.queueMonths(['2024-02'], 'Feb'))!;
    await mailbox.queueMonths(['2024-01'], 'Jan');
    expect(await mailbox.queueMonths(['2024-01'], 'Again')).toBeNull();
    await mailbox.claimLanes(MAX_LANES, account);
    expect(await mailbox.changeJob(first, 'cancel')).toBe(1);
    expect(await lane(user, account, '2024-02')).toMatchObject({ copied: 0, more: false });
    expect(await mailbox.laneState('2024-02')).toBeNull();
    expect(await lane(user, account, '2024-01')).toMatchObject({ copied: 1, more: false });
    const months = await mailbox.coverageMonths();
    expect(months.map((m) => [m.month, m.copied, m.state])).toEqual([['2024-01', 1, 'done'], ['2024-02', 0, 'canceled']]);
    // Retry queues it again.
    expect(await mailbox.changeJob(first, 'retry')).toBe(1);
    expect(await mailbox.hasQueued()).toBe(true);
  });

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
