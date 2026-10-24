import { DEFAULT_SCHEDULES, nextRun, syncStatus, type AccountCoverage, type BackfillJob, type Schedule, type SyncOverview, type SyncState, type SyncSummary } from '@mailcellar/schema';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { keepFor } from '../src/mailbox';
import { accountMailbox, syncDeps } from '../src/sync';
import { signIn } from './helpers';

const sync = DEFAULT_SCHEDULES[0];
const at = (iso: string) => new Date(iso);

describe('nextRun', () => {
  it('runs every few hours inside the window, in UTC by default', () => {
    expect(nextRun(sync, at('2026-10-24T07:00:00Z'))?.toISOString()).toBe('2026-10-24T12:00:00.000Z');
    expect(nextRun(sync, at('2026-10-24T18:00:00Z'))?.toISOString()).toBe('2026-10-25T00:00:00.000Z');
  });

  it('keeps to its days and time zone', () => {
    // 2026-10-24 is a Saturday; Mondays only, 09:00 to 17:00 in Los Angeles (UTC-7 in October).
    const s: Schedule = { ...sync, days: [1], from: '09:00', to: '17:00', every: 180, tz: 'America/Los_Angeles' };
    expect(nextRun(s, at('2026-10-24T07:00:00Z'))?.toISOString()).toBe('2026-10-26T16:00:00.000Z');
    expect(nextRun(s, at('2026-10-26T16:00:00Z'))?.toISOString()).toBe('2026-10-26T19:00:00.000Z');
  });

  it('runs a daily schedule once, and an overnight window past midnight', () => {
    const daily = DEFAULT_SCHEDULES[1];
    expect(nextRun(daily, at('2026-10-24T03:15:00Z'))?.toISOString()).toBe('2026-10-25T03:15:00.000Z');
    const night: Schedule = { ...sync, from: '22:00', to: '02:00', every: 180 };
    expect(nextRun(night, at('2026-10-24T23:30:00Z'))?.toISOString()).toBe('2026-10-25T01:00:00.000Z');
  });

  it('never runs when off', () => {
    expect(nextRun({ ...sync, on: false }, at('2026-10-24T07:00:00Z'))).toBeNull();
  });
});

describe('syncStatus', () => {
  const now = Date.parse('2026-10-24T07:00:00Z');
  const state = (s: Partial<SyncState>): SyncState => ({
    phase: 'backfill', runId: 'r', total: 10, copied: 0, bytes: 0, pending: [], pageToken: '', historyId: '1',
    basinQueue: [], basinReady: true, startedAt: '2026-10-24T06:00:00Z', updatedAt: '2026-10-24T06:59:00Z',
    resumesAt: null, error: null, ...s,
  });

  it('tells a going run from a finished, waiting, stopped or dead one', () => {
    expect(syncStatus(null, now)).toBe('idle');
    expect(syncStatus(state({}), now)).toBe('running');
    expect(syncStatus(state({ updatedAt: '2026-10-24T05:00:00Z' }), now)).toBe('idle');
    expect(syncStatus(state({ phase: 'live', pageToken: null }), now)).toBe('idle');
    expect(syncStatus(state({ phase: 'live', pending: ['m1'] }), now)).toBe('running');
    expect(syncStatus(state({ phase: 'paused', resumesAt: '2026-10-25T00:05:00Z' }), now)).toBe('waiting');
    expect(syncStatus(state({ phase: 'error', error: 'gone' }), now)).toBe('stopped');
  });
});

let n = 0;
async function withAccount() {
  const me = await signIn(`schedule${++n}@example.com`);
  const id = `a${String(n).padStart(22, '0')}`;
  await me.mailbox.connectAccount({ id, email: 'me@example.com', refreshToken: 'rt', scopes: ['https://www.googleapis.com/auth/gmail.modify'] });
  return { ...me, id };
}

const realStart = syncDeps.start;
const realCensus = syncDeps.census;
const realStatus = syncDeps.runStatus;
afterEach(() => void Object.assign(syncDeps, { start: realStart, census: realCensus, runStatus: realStatus }));

describe('Sync now', () => {
  it("lists every account's sync, and whether Basin can be written", async () => {
    const { api, id } = await withAccount();
    const all = (await (await api('/api/sync')).json()) as SyncOverview;
    expect(all).toEqual({ basin: false, paused: false, pausedBy: null, accounts: [{ id, email: 'me@example.com', sync: expect.objectContaining({ status: 'idle', phase: null }) }] });
  });

  it("refuses to start until Basin can be written, and shows the account's sync", async () => {
    const { api, id } = await withAccount();
    const info = (await (await api(`/api/accounts/${id}/sync`)).json()) as SyncSummary;
    expect(info).toMatchObject({ status: 'idle', phase: null, copied: 0 });
    const res = await api(`/api/accounts/${id}/sync`, { method: 'POST' });
    expect([res.status, await res.json()]).toEqual([409, { error: 'basin_not_ready' }]);
  });

  it('starts a sync once, then reports the run that is going', async () => {
    const { api, id } = await withAccount();
    const started: string[] = [];
    syncDeps.start = async (e, u, account) => {
      started.push(account);
      const now = new Date().toISOString();
      await accountMailbox(e, u, account).saveSync({
        phase: 'backfill', runId: 'r1', total: null, copied: 0, bytes: 0, pending: [], pageToken: null, historyId: null,
        basinQueue: [], basinReady: false, startedAt: now, updatedAt: now, resumesAt: null, error: null,
      });
      return 'r1';
    };
    const first = (await (await api(`/api/accounts/${id}/sync`, { method: 'POST' })).json()) as { started: boolean; sync: SyncSummary };
    expect([first.started, first.sync.status, first.sync.phase]).toEqual([true, 'running', 'backfill']);
    const again = (await (await api(`/api/accounts/${id}/sync`, { method: 'POST' })).json()) as { started: boolean };
    expect(again.started).toBe(false);
    expect(started).toEqual([id]);
  });

  it('restarts a sync stopped on an error only when the person asks', async () => {
    const { mailbox, id, user, api } = await withAccount();
    const now = new Date().toISOString();
    await accountMailbox(env, user, id).saveSync({
      phase: 'error', runId: 'r0', total: 5, copied: 2, bytes: 10, pending: [], pageToken: '', historyId: '1',
      basinQueue: [], basinReady: true, startedAt: now, updatedAt: now, resumesAt: null, error: 'Google no longer accepts this account.',
    });
    syncDeps.start = async () => 'r2';
    expect(await mailbox.syncAccount(id, false)).toEqual({ status: 'stopped' });
    expect(await mailbox.syncAccount(id, true)).toEqual({ status: 'started' });
    expect((await api(`/api/accounts/a${'x'.repeat(22)}/sync`, { method: 'POST' })).status).toBe(404);
  });
});

describe('Healing a dead run', () => {
  it('AC-HEAL1 a run Cloudflare stopped is started afresh when the page or the schedule looks, not after 45 minutes', async () => {
    const { mailbox, id, user, api } = await withAccount();
    const now = new Date().toISOString();
    await accountMailbox(env, user, id).saveSync({
      phase: 'backfill', runId: 'dead-run', total: 1623, copied: 0, bytes: 0, pending: ['m1'], pageToken: '', historyId: '1',
      basinQueue: [], basinReady: true, startedAt: now, updatedAt: now, resumesAt: null, error: null,
    });
    const asked: string[] = [];
    syncDeps.runStatus = async (_e, runId) => (asked.push(runId), runId === 'dead-run' ? 'errored' : 'running');
    const started: string[] = [];
    syncDeps.start = async (e, u, account) => {
      started.push(account);
      const s = (await accountMailbox(e, u, account).syncState())!;
      await accountMailbox(e, u, account).saveSync({ ...s, runId: 'fresh-run', updatedAt: new Date().toISOString() });
      return 'fresh-run';
    };
    const all = (await (await api('/api/sync')).json()) as SyncOverview;
    expect(started).toEqual([id]);
    expect(all.accounts[0].sync.status).toBe('running');
    // The fresh run is alive: neither the page nor the schedule starts another.
    await api('/api/sync');
    expect(await mailbox.syncAccount(id, false)).toEqual({ status: 'running' });
    expect(started).toEqual([id]);
    expect(asked).toEqual(['dead-run', 'fresh-run', 'fresh-run']);
  });

  it('AC-HEAL2 the schedule restarts a dead run too', async () => {
    const { mailbox, id, user } = await withAccount();
    const now = new Date().toISOString();
    await accountMailbox(env, user, id).saveSync({
      phase: 'backfill', runId: 'dead-run', total: 5, copied: 0, bytes: 0, pending: ['m1'], pageToken: '', historyId: '1',
      basinQueue: [], basinReady: true, startedAt: now, updatedAt: now, resumesAt: null, error: null,
    });
    syncDeps.runStatus = async () => 'errored';
    syncDeps.start = async () => 'fresh-run';
    expect(await mailbox.syncAccount(id, false)).toEqual({ status: 'started' });
  });
});

describe('Backfill by month', () => {
  it('starts the census when the map is first opened, and not again while it counts', async () => {
    const { api, id, user } = await withAccount();
    const started: string[] = [];
    syncDeps.census = async (e, u, account, mode) => {
      started.push(mode);
      const now = new Date().toISOString();
      await accountMailbox(e, u, account).saveCensus({ runId: 'c1', month: '2026-10', pageToken: null, n: 0, empty: 0, mode, startedAt: now, updatedAt: now, finishedAt: null, error: null });
      return 'c1';
    };
    const first = (await (await api(`/api/accounts/${id}/coverage`)).json()) as AccountCoverage;
    expect(first).toMatchObject({ months: [], census: { status: 'counting', month: '2026-10' } });
    await api(`/api/accounts/${id}/coverage`);
    expect(started).toEqual(['full']);
    await accountMailbox(env, user, id).putMonthCount('2026-09', 12);
    const second = (await (await api(`/api/accounts/${id}/coverage`)).json()) as AccountCoverage;
    expect(second.months).toEqual([{ month: '2026-09', gmail: 12, copied: 0, inBasin: 0, landed: false, indexed: 0, state: null, error: null, finishedAt: null }]);
    expect((await api(`/api/accounts/a${'x'.repeat(22)}/coverage`)).status).toBe(404);
  });

  it('checks the months asked for, and waits for Basin like Sync now', async () => {
    const { api, id } = await withAccount();
    const post = (body: unknown) => api(`/api/accounts/${id}/backfill`, { method: 'POST', body: JSON.stringify(body) });
    for (const bad of [{}, { months: [] }, { months: ['2024-13'] }, { months: ['2999-01'] }, { months: [202401] }])
      expect((await post(bad)).status).toBe(400);
    const res = await post({ months: ['2024-01'] });
    expect([res.status, await res.json()]).toEqual([409, { error: 'basin_not_ready' }]);
  });

  it('AC-READS1 keeps the map and jobs answers a minute while runs write, and drops them when the person queues', async () => {
    const { id, user } = await withAccount();
    const box = accountMailbox(env, user, id);
    const read = async () => (await box.usage()).filter((u) => u.metric === 'do_rows_read').reduce((t, u) => t + u.value, 0);
    keepFor.ms = 60_000;
    try {
      await box.putMonthCount('2024-01', 5);
      expect((await box.coverageMonths()).map((m) => m.month)).toEqual(['2024-01']);
      const before = await read();
      // Polls with nothing written read nothing.
      await box.coverageMonths();
      await box.coverageMonths();
      expect(await read()).toBe(before);
      // A run's write shows within the minute, not at once.
      await box.putMonthCount('2024-02', 7);
      expect((await box.coverageMonths()).map((m) => m.month)).toEqual(['2024-01']);
      // Queueing shows at once.
      await box.queueMonths(['2024-02'], 'Test');
      expect((await box.coverageMonths()).map((m) => [m.month, m.state])).toEqual([['2024-01', null], ['2024-02', 'queued']]);
      expect((await box.jobList()).map((j) => j.label)).toEqual(['Test']);
      // Clear queue and Remove show at once too.
      expect(await box.unqueueMonths(null)).toBe(1);
      expect((await box.coverageMonths()).map((m) => [m.month, m.state])).toEqual([['2024-01', null], ['2024-02', 'canceled']]);
    } finally {
      keepFor.ms = 0;
    }
  });

  it('lists jobs, and cancels or retries one', async () => {
    const { api, id, user } = await withAccount();
    const job = (await accountMailbox(env, user, id).queueMonths(['2024-01', '2024-02'], 'Last 3 months'))!;
    const jobs = (await (await api(`/api/accounts/${id}/jobs`)).json()) as BackfillJob[];
    expect(jobs).toEqual([expect.objectContaining({ id: job, label: 'Last 3 months', status: 'queued', from: '2024-01', to: '2024-02' })]);
    const cancel = await api(`/api/accounts/${id}/jobs/${job}/cancel`, { method: 'POST' });
    expect(await cancel.json()).toEqual({ changed: 2 });
    const retry = await api(`/api/accounts/${id}/jobs/${job}/retry`, { method: 'POST' });
    expect(await retry.json()).toEqual({ changed: 2 });
    expect((await api(`/api/accounts/${id}/jobs/999/cancel`, { method: 'POST' })).status).toBe(404);
  });

  it('AC-UNQ1 takes picked months out of the queue, or clears it, and leaves done months alone', async () => {
    const { api, id, user } = await withAccount();
    const box = accountMailbox(env, user, id);
    await box.queueMonths(['2024-01', '2024-02', '2024-03'], 'Picked months');
    const post = (body: unknown) => api(`/api/accounts/${id}/backfill/cancel`, { method: 'POST', body: JSON.stringify(body) });
    expect((await post({ months: ['2024-13'] })).status).toBe(400);
    expect(await (await post({ months: ['2024-02'] })).json()).toMatchObject({ changed: 1 });
    const left = (await (await api(`/api/accounts/${id}/coverage`)).json()) as AccountCoverage;
    expect(left.months.filter((m) => m.state === 'queued').map((m) => m.month)).toEqual(['2024-01', '2024-03']);
    // A failed month leaves with Clear queue too.
    expect((await box.claimLanes(1, id)).map((l) => l.month)).toEqual(['2024-03']);
    await box.finishPart({ job: 1, month: '2024-03' }, 'failed', 'HTTP 403');
    expect(await (await post({})).json()).toMatchObject({ changed: 2 });
    expect(await (await post({})).json()).toMatchObject({ changed: 0 });
    expect((await api(`/api/accounts/a${'x'.repeat(22)}/backfill/cancel`, { method: 'POST', body: '{}' })).status).toBe(404);
  });
});

describe('Pausing backfill', () => {
  it('AC-PAUSE2 Sync now, Copy and the schedule start nothing while paused, and the sync API says so', async () => {
    const { api, id, mailbox } = await withAccount();
    let started = 0;
    syncDeps.start = async () => (started++, 'r1');
    const put = (body: unknown) => api('/api/backfill/paused', { method: 'PUT', body: JSON.stringify(body) });
    expect((await put({ paused: 'yes' })).status).toBe(400);
    expect(((await (await put({ paused: true })).json()) as SyncOverview).paused).toBe(true);
    expect(((await (await api('/api/sync')).json()) as SyncOverview).paused).toBe(true);
    const now = await api(`/api/accounts/${id}/sync`, { method: 'POST' });
    expect([now.status, await now.json()]).toEqual([409, { error: 'paused' }]);
    const copy = await api(`/api/accounts/${id}/backfill`, { method: 'POST', body: JSON.stringify({ months: ['2024-01'] }) });
    // Copy queues while paused (it starts on resume); this test env has no Basin, so it stops there.
    expect([copy.status, await copy.json()]).toEqual([409, { error: 'basin_not_ready' }]);
    expect(await runDurableObjectAlarm(mailbox)).toBe(true);
    const list = (await (await api('/api/schedules')).json()) as Schedule[];
    expect(list[0].last).toMatchObject({ ok: true, detail: 'Backfill paused' });
    expect(started).toBe(0);
    expect(((await (await put({ paused: false })).json()) as SyncOverview).paused).toBe(false);
  });
});

describe('Gmail sync schedule', () => {
  it('sets an alarm when an account is added, and records each run', async () => {
    const { mailbox, api } = await withAccount();
    const alarm = await runInDurableObject(mailbox, (_i, state) => state.storage.getAlarm());
    const list = (await (await api('/api/schedules')).json()) as Schedule[];
    expect(alarm).toBe(Date.parse(list[0].next!));
    expect(list[0].waiting).toBe('Waiting for Basin write access');
    expect(await runDurableObjectAlarm(mailbox)).toBe(true);
    const after = (await (await api('/api/schedules')).json()) as Schedule[];
    expect(after[0].last).toMatchObject({ ok: false, detail: 'Waiting for Basin write access' });
    expect(await runInDurableObject(mailbox, (_i, state) => state.storage.getAlarm())).toBe(Date.parse(after[0].next!));
  });

  it('clears the alarm when sync is turned off', async () => {
    const { mailbox, api } = await withAccount();
    await api('/api/schedules/gmail-sync', { method: 'PUT', body: JSON.stringify({ on: false }) });
    expect(await runInDurableObject(mailbox, (_i, state) => state.storage.getAlarm())).toBeNull();
  });
});
