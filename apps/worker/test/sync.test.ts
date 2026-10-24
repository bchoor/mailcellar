import { asUserId, mailboxName, r2Keys, type SyncState } from '@mailcellar/schema';
import { introspectWorkflowInstance } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountMailbox, BATCH_BYTES, nextReset, RUN_CALLS, RUN_SIZE, runBatch as run, runCensus, syncDeps } from '../src/sync';
import { fileTarget } from './fixtures/basin';
import { fakeGmail, fakeMessages, fakeRaw } from './fixtures/gmail';

const tables = new Map<string, ReturnType<typeof fileTarget>>();
const table = (user: string) => tables.get(user) ?? tables.set(user, fileTarget(user as never)).get(user)!;
// Every run writes Basin rows to a local Iceberg table for its user.
syncDeps.basin = async (_env, user) => table(user).target;
const runBatch = (...[e, user, account, runId, limits]: Parameters<typeof run>) =>
  run(e, user, account, runId, limits ?? { calls: RUN_CALLS, batchBytes: BATCH_BYTES });

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
  return { user, account, mailbox };
}

describe('sync', () => {
  // Skip the one-second pause between Gmail batches.
  beforeEach(() => void vi.spyOn(scheduler, 'wait').mockResolvedValue(undefined));

  it('copies a mailbox: raw mail to R2, the index to the account DO, then goes live', async () => {
    const mail = fakeMessages(3);
    mail[0].raw = fakeRaw(1, { subject: 'Big one', pad: 300 * 1024 });
    mail[1].labels = ['INBOX', 'Label_1'];
    fakeGmail(mail);
    const { user, account, mailbox } = await setup();
    const r = await runBatch(env, user, account, 'run-1');
    expect(r).toEqual({ copied: 3, phase: 'live', more: false, resumesAt: null });
    const s = (await mailbox.syncState())!;
    expect([s.total, s.copied, s.historyId, s.pageToken, s.pending]).toEqual([3, 3, '100', null, []]);
    const rows = (await mailbox.archive('messages')) as { subject: string }[];
    expect(rows.map((m) => m.subject).sort()).toEqual(['Big one', 'Test 2', 'Test 3']);
    const labels = (await mailbox.archive('labels')) as { id: string; name: string }[];
    expect(labels.find((l) => l.id === 'Label_1')?.name).toBe('Receipts');
    // Small mail is gzipped; mail over 256 KB is stored as it is.
    const small = await env.ARCHIVE.get(r2Keys.raw(user, account, mail[1].id));
    const big = await env.ARCHIVE.get(r2Keys.raw(user, account, mail[0].id));
    expect(small?.httpMetadata?.contentEncoding).toBe('gzip');
    const text = await new Response(small!.body.pipeThrough(new DecompressionStream('gzip'))).text();
    expect(text).toBe(mail[1].raw);
    expect(big?.httpMetadata?.contentEncoding).toBeUndefined();
    expect(await big!.text()).toBe(mail[0].raw);
    // Basin, the system of record, has a row for each message, with its body text.
    const basin = await table(user).read();
    expect(basin.map((r) => r.subject).sort()).toEqual(['Big one', 'Test 2', 'Test 3']);
    expect(basin.find((r) => r.subject === 'Test 2')).toMatchObject({ account, from_addr: 's2@example.com', body_text: 'Body 2', raw_key: r2Keys.raw(user, account, mail[1].id) });
    expect(s.basinQueue).toEqual([]);
  });

  it('copies RUN_SIZE messages a run, then asks for another run', async () => {
    fakeGmail(fakeMessages(RUN_SIZE + 20));
    const { user, account, mailbox } = await setup('run-1', { pageToken: '', historyId: '100', total: RUN_SIZE + 20 }, []);
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: RUN_SIZE, phase: 'backfill', more: true });
    expect((await mailbox.syncState())!.pageToken).toBe(String(RUN_SIZE));
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: 20, phase: 'live', more: false });
  }, 30_000);

  it('picks up new mail once live', async () => {
    const mail = fakeMessages(2);
    fakeGmail(mail, { historyAdded: [mail[1].id] });
    const { user, account, mailbox } = await setup('run-1', { phase: 'live', historyId: '100', copied: 1 }, []);
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: 1, phase: 'live', more: false });
    expect((await mailbox.syncState())!.historyId).toBe('200');
  });

  it('keeps messages Gmail rate-limited for the next batch', async () => {
    const mail = fakeMessages(3);
    fakeGmail(mail, { failOnce: { [mail[2].id]: 429 } });
    const { user, account, mailbox } = await setup();
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: 2, more: true });
    expect((await mailbox.syncState())!.pending).toEqual([mail[2].id]);
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: 1, phase: 'live', more: false });
    expect(await table(user).read()).toHaveLength(3);
  });

  it('keeps a batch staged when Basin fails, and commits it with the next run', async () => {
    const mail = fakeMessages(2);
    fakeGmail(mail);
    const { user, account, mailbox } = await setup();
    const failing = { calls: RUN_CALLS, batchBytes: BATCH_BYTES, basin: async () => ({ ensure: async () => { throw new Error('catalog down'); }, append: async () => {} }) };
    const r = await runBatch(env, user, account, 'run-1', failing);
    expect(r).toMatchObject({ copied: 2, more: true });
    expect(r.resumesAt).not.toBeNull();
    const s = (await mailbox.syncState())!;
    expect(s.basinQueue).toHaveLength(1);
    expect(s.error).toMatch(/Basin didn't take/);
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: 0, phase: 'live', more: false });
    expect(await table(user).read()).toHaveLength(2);
    expect(await env.ARCHIVE.get(s.basinQueue[0])).toBeNull();
  });

  it('stops with a reason when Google no longer accepts the account', async () => {
    fakeGmail([], { tokenError: 'invalid_grant' });
    const { user, account, mailbox } = await setup();
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ phase: 'error', more: false });
    expect((await mailbox.syncState())!.error).toMatch(/no longer accepts/);
  });

  it('stops a run that a newer run replaced', async () => {
    const calls = fakeGmail(fakeMessages(1));
    const { user, account } = await setup('run-2');
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ phase: 'replaced', more: false });
    expect(calls).toEqual([]);
  });

  it('packs big mail into small raw batches and stops at the request budget', async () => {
    const mail = fakeMessages(60);
    // Over half the batch size each, so every big one is fetched alone.
    for (const m of mail.slice(0, 50)) m.raw = fakeRaw(1, { pad: 6000 });
    const calls = fakeGmail(mail);
    const { user, account, mailbox } = await setup();
    const r = await runBatch(env, user, account, 'run-1', { calls: RUN_CALLS, batchBytes: 10_000 });
    // token, profile, labels, list and 2 size batches, with 7 calls kept for the Basin commit,
    // leave 32 of the 45 calls for raw batches.
    expect(calls.filter((c) => c.includes('batch'))).toHaveLength(2 + 32);
    expect(r).toMatchObject({ copied: 32, more: true });
    expect((await mailbox.syncState())!.pending).toHaveLength(28);
  });

  it('resumes after the daily reset', () => {
    expect(nextReset(new Date('2026-10-24T18:00:00Z')).toISOString()).toBe('2026-10-25T00:05:00.000Z');
  });

  it('runs as a Workflow', async () => {
    fakeGmail(fakeMessages(2));
    const { user, account, mailbox } = await setup('wf-1');
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

  it('copies only the queued months, newest first, and marks each done', async () => {
    const mail = [at('2023-12-31T23:59:59Z', 1), at('2024-01-01T00:00:00Z', 2), at('2024-02-10T00:00:00Z', 3), at('2024-03-05T00:00:00Z', 4)];
    const calls = fakeGmail(mail);
    const { user, account, mailbox } = await setup('run-1', {}, ['2024-01', '2024-02']);
    const r = await runBatch(env, user, account, 'run-1');
    // February first; its listing is done and copied, so January is next.
    expect(r).toMatchObject({ copied: 1, phase: 'backfill', more: true });
    expect(calls.filter((c) => c.startsWith('q='))).toEqual([`q=after:${Date.UTC(2024, 1, 1) / 1000 - 1} before:${Date.UTC(2024, 2, 1) / 1000}`]);
    expect((await mailbox.syncState())!.part).toMatchObject({ month: '2024-01' });
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: 1, phase: 'live', more: false });
    const months = await mailbox.coverageMonths();
    expect(months.map((m) => [m.month, m.copied, m.state])).toEqual([['2024-01', 1, 'done'], ['2024-02', 1, 'done']]);
    const [job] = await mailbox.jobList();
    expect([job.status, job.months.done, job.from, job.to]).toEqual(['done', 2, '2024-01', '2024-02']);
  });

  it('drops a canceled month and moves on', async () => {
    fakeGmail([at('2024-01-02T00:00:00Z', 1), at('2024-02-02T00:00:00Z', 2)]);
    const { user, account, mailbox } = await setup('run-1', { historyId: '100' }, []);
    const first = (await mailbox.queueMonths(['2024-02'], 'Feb'))!;
    await mailbox.queueMonths(['2024-01'], 'Jan');
    expect(await mailbox.queueMonths(['2024-01'], 'Again')).toBeNull();
    // February is running when it's canceled.
    await mailbox.saveSync({ ...(await mailbox.syncState())!, part: (await mailbox.nextPart())!, pageToken: '' });
    expect(await mailbox.changeJob(first, 'cancel')).toBe(1);
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: 1, phase: 'live' });
    const months = await mailbox.coverageMonths();
    expect(months.map((m) => [m.month, m.copied, m.state])).toEqual([['2024-01', 1, 'done'], ['2024-02', 0, 'canceled']]);
    // Retry queues it again.
    expect(await mailbox.changeJob(first, 'retry')).toBe(1);
    expect(await mailbox.hasQueued()).toBe(true);
  });

  it('fails the month being copied when Google refuses, with the reason', async () => {
    fakeGmail([], { tokenError: 'invalid_grant' });
    const { user, account, mailbox } = await setup('run-1', { part: { job: 1, month: '2024-01' }, pageToken: '' });
    await mailbox.nextPart();
    await runBatch(env, user, account, 'run-1');
    const [m] = await mailbox.coverageMonths();
    expect([m.state, m.error]).toEqual(['failed', expect.stringMatching(/no longer accepts/)]);
    expect((await mailbox.jobList())[0].status).toBe('failed');
  });

  it('turns a live sync back to backfilling when months are queued', async () => {
    fakeGmail([at('2024-01-02T00:00:00Z', 1)]);
    const { user, account, mailbox } = await setup('run-1', { phase: 'live', historyId: '100' });
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: 1, phase: 'live', more: false });
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
});
