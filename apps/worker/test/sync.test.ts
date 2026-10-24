import { asUserId, mailboxName, r2Keys, type SyncState } from '@mailcellar/schema';
import { introspectWorkflowInstance } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountMailbox, BATCH_BYTES, nextReset, RUN_CALLS, RUN_SIZE, runBatch as run, syncDeps, withRange } from '../src/sync';
import { fileTarget } from './fixtures/basin';
import { fakeGmail, fakeMessages, fakeRaw } from './fixtures/gmail';

const tables = new Map<string, ReturnType<typeof fileTarget>>();
const table = (user: string) => tables.get(user) ?? tables.set(user, fileTarget(user as never)).get(user)!;
// Every run writes Basin rows to a local Iceberg table for its user.
syncDeps.basin = async (_env, user) => table(user).target;
const runBatch = (...[e, user, account, runId, limits]: Parameters<typeof run>) =>
  run(e, user, account, runId, limits ?? { calls: RUN_CALLS, batchBytes: BATCH_BYTES });

let n = 0;
/** A user with one connected Gmail account, and that account's sync claimed by run `runId`. */
async function setup(runId = 'run-1', state: Partial<SyncState> = {}) {
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
    const { user, account, mailbox } = await setup('run-1', { pageToken: '', historyId: '100', total: RUN_SIZE + 20 });
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: RUN_SIZE, phase: 'backfill', more: true });
    expect((await mailbox.syncState())!.pageToken).toBe(String(RUN_SIZE));
    expect(await runBatch(env, user, account, 'run-1')).toMatchObject({ copied: 20, phase: 'live', more: false });
  }, 30_000);

  it('picks up new mail once live', async () => {
    const mail = fakeMessages(2);
    fakeGmail(mail, { historyAdded: [mail[1].id] });
    const { user, account, mailbox } = await setup('run-1', { phase: 'live', historyId: '100', copied: 1 });
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

describe('date range', () => {
  beforeEach(() => void vi.spyOn(scheduler, 'wait').mockResolvedValue(undefined));
  const base = (s: Partial<SyncState>): SyncState => ({
    phase: 'backfill', runId: 'r', total: 100, copied: 10, bytes: 0, pending: ['x'], pageToken: 'p2', historyId: '100',
    basinQueue: [], basinReady: true, startedAt: '', updatedAt: '', resumesAt: null, error: null, ...s,
  });
  const now = new Date('2026-10-24T12:00:00Z');

  it('lists Gmail again when the range changes, and leaves a finished full copy alone', () => {
    expect(withRange(base({}), '30d', now)).toMatchObject({ since: '2026-09-24', phase: 'backfill', pending: [], pageToken: '' });
    expect(withRange(base({ since: '2026-09-24', phase: 'live', pending: [] }), 'all', now)).toMatchObject({ since: null, phase: 'backfill', pageToken: '' });
    const done = base({ phase: 'live', pending: [], pageToken: null });
    expect(withRange(done, '30d', now)).toBe(done);
    const fresh = base({ historyId: null, pageToken: null, pending: [] });
    expect(withRange(fresh, '30d', now).pageToken).toBeNull();
  });

  it('copies only the range, with Gmail’s estimate as the total', async () => {
    const calls = fakeGmail(fakeMessages(3), { estimate: 2 });
    const { user, account, mailbox } = await setup('run-1', { since: '2026-09-24' });
    await runBatch(env, user, account, 'run-1');
    expect(calls).toContain('q=after:2026/09/24');
    expect((await mailbox.syncState())!.total).toBe(2);
  });
});
