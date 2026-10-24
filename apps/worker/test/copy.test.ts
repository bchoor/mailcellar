import { asUserId, mailboxName, r2Keys, type SyncParams, type UserId } from '@mailcellar/schema';
import { env } from 'cloudflare:workers';
import { fileCatalog, icebergAppend, icebergCreateTable, icebergRead, loadLatestFileCatalogMetadata } from 'icebird';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addColumns, icebergSchema, partitionSpec, r2Resolver, toRecords, type BasinRow } from '../src/basin';
import { BUCKET, COMMITTER_IDLE, ensureCommitter, HUGE, MEDIUM, readLane, runCommit, runLane, SMALL_BATCH, type LaneOptions } from '../src/copy';
import { quotaDeps } from '../src/quota';
import { accountMailbox, launchLanes, runIndex, syncDeps } from '../src/sync';
import { fileTarget } from './fixtures/basin';
import { fakeGmail, fakeMessages, fakeRaw } from './fixtures/gmail';

const tables = new Map<string, ReturnType<typeof fileTarget>>();
const table = (user: string) => tables.get(user) ?? tables.set(user, fileTarget(user as never)).get(user)!;
syncDeps.basin = async (_env, user) => table(user).target;
let launched: (SyncParams & { id: string })[] = [];
syncDeps.launch = async (_env, params, id) => void launched.push({ ...params, id });
const realQuota = { ...quotaDeps };

let n = 0;
/** A user with one Gmail account and `months` queued (the fake's mail is in January 2024 unless dated). */
async function setup(months = ['2024-01']) {
  const user = asUserId(`copy${++n}`);
  const account = `acct${n}`;
  const owner = env.MAILBOX.getByName(mailboxName(user));
  await owner.connectAccount({ id: account, email: 'me@example.com', refreshToken: 'rt', scopes: ['https://www.googleapis.com/auth/gmail.modify'] });
  const mailbox = accountMailbox(env, user, account);
  const now = new Date().toISOString();
  await mailbox.saveSync({
    phase: 'live', runId: 'main', total: null, copied: 0, bytes: 0, pending: [], pageToken: null, historyId: '100',
    basinQueue: [], basinReady: true, startedAt: now, updatedAt: now, resumesAt: null, error: null,
  });
  if (months.length) await mailbox.queueMonths(months, 'Test');
  launched = [];
  return { user, account, mailbox, owner };
}

/** One run of a month's lane, as the run that owns it now. */
async function lane(user: UserId, account: string, month: string, opts?: LaneOptions) {
  const got = await readLane(env, user, account, month);
  return runLane(env, user, account, month, got?.p.runId ?? 'none', opts);
}

/** One check of the account's committer, as the run that owns it now. */
async function commit(user: UserId, account: string) {
  const c = await env.ARCHIVE.get(r2Keys.committer(user, account));
  return runCommit(env, user, account, c ? ((await c.json()) as { runId: string }).runId : 'none');
}

/** The account mailbox's own count of DO rows, read and written. */
async function rows(user: UserId, account: string) {
  const usage = await accountMailbox(env, user, account).usage();
  const sum = (m: string) => usage.filter((u) => u.metric === m).reduce((t, u) => t + u.value, 0);
  return { read: sum('do_rows_read'), written: sum('do_rows_written') };
}

beforeEach(() => {
  vi.spyOn(scheduler, 'wait').mockResolvedValue(undefined);
  Object.assign(quotaDeps, realQuota);
});

describe('copy engine', () => {
  it('AC-COPY1 copies a month with one raw fetch a message, a pack a batch and no DO rows; the committer lands it', async () => {
    const mail = fakeMessages(4);
    mail[0].raw = fakeRaw(1, { subject: 'Huge', pad: HUGE + 10 });
    mail[1].raw = fakeRaw(2, { subject: 'Medium', pad: MEDIUM + 10 });
    mail[2].labels = ['INBOX', 'Label_1'];
    const calls = fakeGmail(mail);
    const { user, account, mailbox } = await setup();
    expect(await launchLanes(env, user, account)).toBe(1);
    expect(launched).toEqual([{ user, account, month: '2024-01', id: expect.stringContaining(`${account}-2024-01-`) }]);
    expect((await mailbox.syncState())!.lanes).toEqual(['2024-01']);
    launched = [];

    const before = await rows(user, account);
    const r = await lane(user, account, '2024-01');
    expect(r).toMatchObject({ copied: 4, more: false, nextId: null });
    // Big mail is listed first; every message is fetched once, as raw, by size: small mail together, the rest alone.
    expect(calls.filter((c) => c.startsWith('q='))).toEqual([expect.stringMatching(`larger:${HUGE}$`), expect.stringMatching(`larger:${MEDIUM}$`), expect.stringMatching(/before:\d+$/)]);
    expect(calls.filter((c) => c.startsWith('get '))).toEqual(['get raw 2', 'get raw 1', 'get raw 1']);
    // Copying read and wrote no rows, beyond loading which months are queued once (and metering that).
    const after = await rows(user, account);
    expect(after.read - before.read).toBeLessThanOrEqual(3);
    expect(after.written - before.written).toBeLessThanOrEqual(2);
    expect(await mailbox.archive('messages')).toEqual([]);

    // One pack a batch; each Basin row says where its message is in the pack.
    const packs = await env.ARCHIVE.list({ prefix: `u/${user}/a/${account}/packs/2024-01/` });
    expect(packs.objects).toHaveLength(3);
    const staged = await env.ARCHIVE.list({ prefix: r2Keys.stagedPrefix(user, account) });
    expect(staged.objects).toHaveLength(1);
    const basinRows = (await (await env.ARCHIVE.get(staged.objects[0].key))!.json()) as BasinRow[];
    for (const row of basinRows) {
      const obj = await env.ARCHIVE.get(row.raw_key, { range: { offset: row.raw_offset!, length: row.raw_len! } });
      expect(await obj!.text()).toBe(mail.find((m) => m.id === row.id)!.raw);
    }

    // The lane started the account's committer once; it commits, then lands the month.
    const commits = launched.filter((l) => l.commit);
    expect(commits).toHaveLength(1);
    launched = [];
    const c = await commit(user, account);
    expect(c).toMatchObject({ committed: 4, landed: ['2024-01'], more: true });
    const basin = await table(user).read();
    expect(basin.map((x) => x.subject).sort()).toEqual(['Huge', 'Medium', 'Test 3', 'Test 4']);
    expect(basin.find((x) => x.subject === 'Test 3')).toMatchObject({ account, labels: ['INBOX', 'Label_1'], raw_offset: expect.anything(), raw_len: expect.anything() });
    const [m] = await mailbox.coverageMonths();
    expect([m.state, m.inBasin, m.landed, m.copied]).toEqual(['done', 4, true, 4]);
    expect((await mailbox.syncState())!).toMatchObject({ copied: 4, lanes: [] });
    expect(launched.find((l) => l.index)).toMatchObject({ index: '2024-01' });
    expect(await env.ARCHIVE.get(r2Keys.lane(user, account, '2024-01'))).toBeNull();
    expect(((await (await env.ARCHIVE.get(r2Keys.copied(user, account, '2024-01')))!.json()) as string[]).sort()).toEqual(mail.map((x) => x.id).sort());
    expect((await env.ARCHIVE.list({ prefix: r2Keys.stagedPrefix(user, account) })).objects).toEqual([]);
    // The search index is built from Basin after the month lands.
    expect(await runIndex(env, user, account, '2024-01')).toEqual({ indexed: 4, next: null, resumesAt: null });
    expect(((await mailbox.archive('messages')) as { subject: string }[]).map((x) => x.subject).sort()).toEqual(['Huge', 'Medium', 'Test 3', 'Test 4']);
  });

  it('AC-COPY2 retries mail Gmail rate-limited (429, or 403 rateLimitExceeded) and slows the account down', async () => {
    const mail = fakeMessages(3);
    fakeGmail(mail, { failOnce: { [mail[1].id]: 429, [mail[2].id]: 403 } });
    const { user, account } = await setup();
    await launchLanes(env, user, account);
    const first = await lane(user, account, '2024-01');
    expect(first).toMatchObject({ copied: 3, more: false });
    expect(first.stats!.throttled).toBe(1);
    expect(await commit(user, account)).toMatchObject({ committed: 3 });
  });

  it('AC-COPY3 paces Gmail with a token bucket that halves on a rate limit and recovers', async () => {
    const { user, account, mailbox } = await setup();
    await launchLanes(env, user, account);
    fakeGmail([]);
    const turn = (units: number, throttled = false) => mailbox.laneTurn({ user, account, month: '2024-01', runId: 'x', units, throttled, copied: 0, bytes: 0 });
    vi.useFakeTimers({ now: Date.parse('2026-10-24T22:00:00Z'), toFake: ['Date'] });
    try {
      expect((await turn(BUCKET.cap)).waitMs).toBe(0);
      // Empty: 200 units wait a second at full rate.
      expect((await turn(BUCKET.rate)).waitMs).toBe(1000);
      // A rate limit halves the rate.
      expect((await turn(0, true)).waitMs).toBe(2000);
      vi.setSystemTime(Date.parse('2026-10-24T22:01:01Z'));
      // A minute later it's back to full, and the bucket filled up again.
      expect((await turn(BUCKET.cap)).waitMs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC-COPY4 stops a run at its CPU budget and leaves the rest for the next run', async () => {
    fakeGmail(fakeMessages(SMALL_BATCH * 2 + 20));
    const { user, account } = await setup();
    await launchLanes(env, user, account);
    // The first wave always goes (two batches of 50); then the budget is spent.
    expect(await lane(user, account, '2024-01', { cpuMs: 1 })).toMatchObject({ copied: SMALL_BATCH * 2, more: true });
    expect((await readLane(env, user, account, '2024-01'))!.p.small).toHaveLength(20);
    expect(await lane(user, account, '2024-01', { cpuMs: 1 })).toMatchObject({ copied: 20, more: false });
  });

  it('AC-COPY5 a paused lane stops where it stands and starts again at once on resume', async () => {
    fakeGmail(fakeMessages(3));
    const { user, account, owner } = await setup();
    await launchLanes(env, user, account);
    await owner.setBackfillPaused(true);
    expect(await lane(user, account, '2024-01')).toMatchObject({ copied: 0, more: false, stopped: 'paused' });
    const p = (await readLane(env, user, account, '2024-01'))!.p;
    expect([p.stopped, p.copied]).toEqual(['paused', 0]);
    expect(await launchLanes(env, user, account)).toBe(0);
    // Resuming starts the account's sync, which starts the lane again where it stood.
    syncDeps.start = async () => 'main';
    await owner.setBackfillPaused(false);
    launched = [];
    expect(await launchLanes(env, user, account)).toBe(1);
    expect(await lane(user, account, '2024-01')).toMatchObject({ copied: 3, more: false });
  });

  it('AC-COPY6 ends a lane whose month was taken out of the queue', async () => {
    fakeGmail(fakeMessages(3));
    const { user, account, mailbox } = await setup();
    await launchLanes(env, user, account);
    await mailbox.unqueueMonths(['2024-01']);
    expect(await lane(user, account, '2024-01')).toMatchObject({ copied: 0, more: false, stopped: 'unqueued' });
    expect(await env.ARCHIVE.get(r2Keys.lane(user, account, '2024-01'))).toBeNull();
    expect((await mailbox.syncState())!.lanes).toEqual([]);
  });

  it('AC-COPY7 a replaced run stops; a retried run that already saved hands over again', async () => {
    fakeGmail(fakeMessages(SMALL_BATCH * 2 + 1));
    const { user, account } = await setup();
    await launchLanes(env, user, account);
    expect(await runLane(env, user, account, '2024-01', 'not-the-owner')).toMatchObject({ more: false, stopped: 'replaced' });
    const owner = (await readLane(env, user, account, '2024-01'))!.p.runId;
    const r = await runLane(env, user, account, '2024-01', owner, { cpuMs: 1 });
    expect(r).toMatchObject({ copied: SMALL_BATCH * 2, more: true });
    expect(await runLane(env, user, account, '2024-01', owner)).toEqual({ copied: 0, more: true, nextId: r.nextId, resumesAt: null });
  });

  it('AC-COPY8 one committer an account; staged rows wait while Basin fails; it stops when idle', async () => {
    fakeGmail(fakeMessages(2));
    const { user, account } = await setup();
    expect(await ensureCommitter(env, user, account)).not.toBeNull();
    expect(await ensureCommitter(env, user, account)).toBeNull();
    expect(launched.filter((l) => l.commit)).toHaveLength(1);
    await launchLanes(env, user, account);
    await lane(user, account, '2024-01');
    const real = syncDeps.basin;
    syncDeps.basin = async () => ({ ensure: async () => { throw new Error('catalog down'); }, append: async () => {}, monthRows: async () => [] });
    try {
      expect(await commit(user, account)).toMatchObject({ committed: 0, landed: [], more: true, waitMs: 5 * 60_000 });
      expect((await env.ARCHIVE.list({ prefix: r2Keys.stagedPrefix(user, account) })).objects).toHaveLength(1);
    } finally {
      syncDeps.basin = real;
    }
    expect(await commit(user, account)).toMatchObject({ committed: 2, landed: ['2024-01'] });
    for (let i = 1; i < COMMITTER_IDLE; i++) expect(await commit(user, account)).toMatchObject({ more: true, waitMs: 60_000 });
    expect(await commit(user, account)).toMatchObject({ more: false });
    expect(await env.ARCHIVE.get(r2Keys.committer(user, account))).toBeNull();
  });

  it('AC-COPY9 copying a landed month again copies only what it lacks', async () => {
    const mail = fakeMessages(3);
    fakeGmail(mail.slice(0, 2));
    const { user, account, mailbox } = await setup();
    await launchLanes(env, user, account);
    await lane(user, account, '2024-01');
    await commit(user, account);
    fakeGmail(mail);
    await mailbox.queueMonths(['2024-01'], 'Again');
    await launchLanes(env, user, account);
    expect(await lane(user, account, '2024-01')).toMatchObject({ copied: 1, more: false });
    await commit(user, account);
    expect(await table(user).read()).toHaveLength(3);
    expect((await mailbox.coverageMonths())[0]).toMatchObject({ inBasin: 3, landed: true });
  });

  it('AC-COPY10 a run that could pass the spend cap pauses all backfill instead', async () => {
    fakeGmail(fakeMessages(2));
    const { user, account, owner } = await setup();
    quotaDeps.readSpend = async () => ({ classA: 230_000, classB: 0, bytes: 0 });
    quotaDeps.name = `copy-spend-${n}`;
    await launchLanes(env, user, account);
    expect(await lane(user, account, '2024-01')).toMatchObject({ copied: 0, stopped: 'budget' });
    expect((await owner.syncAll()).pausedBy).toBe('budget');
  });

  it('fails the month when Google refuses access, with the reason', async () => {
    const mail = fakeMessages(2);
    fakeGmail(mail, { failOnce: { [mail[0].id]: 403 }, refuse403: true });
    const { user, account, mailbox } = await setup();
    await launchLanes(env, user, account);
    expect(await lane(user, account, '2024-01')).toMatchObject({ stopped: 'failed' });
    const [m] = await mailbox.coverageMonths();
    expect([m.state, m.error]).toEqual(['failed', expect.stringMatching(/HTTP 403/)]);
  });

  it('shows what a lane has copied on the map and the sync card before the month lands', async () => {
    fakeGmail(fakeMessages(3));
    const { user, account, mailbox, owner } = await setup();
    await launchLanes(env, user, account);
    await lane(user, account, '2024-01');
    expect((await mailbox.coverageMonths())[0]).toMatchObject({ copied: 3, landed: false });
    expect((await owner.syncInfo(account))!).toMatchObject({ copied: 3, status: 'running', months: ['2024-01'] });
  });

  it('a speed test queues one month and resumes, only when nothing else is queued', async () => {
    const { account, mailbox, owner } = await setup(['2023-05']);
    await owner.setBackfillPaused(true);
    syncDeps.start = async () => 'main';
    expect(await owner.trial(account, '2024-01')).toEqual({ started: false, active: [{ account, months: ['2023-05'] }] });
    // The test month itself being queued already is fine.
    expect(await owner.trial(account, '2023-05')).toMatchObject({ started: true, job: null });
    await owner.setBackfillPaused(true);
    expect((await owner.syncAll()).paused).toBe(true);
    await mailbox.unqueueMonths(null);
    expect(await owner.trial(account, '2024-01')).toMatchObject({ started: true, job: expect.any(Number) });
    expect((await owner.syncAll()).paused).toBe(false);
    expect(await mailbox.activeList()).toEqual(['2024-01']);
  });
});

describe('Basin columns', () => {
  it('AC-BASIN1 a table made before raw_offset and raw_len gains them, with the IDs a new table gets', async () => {
    const resolver = r2Resolver(env.ARCHIVE, env.BASIN_BUCKET);
    const catalog = fileCatalog({ resolver });
    const tableUrl = `s3://${env.BASIN_BUCKET}/test-basin/columns-${Date.now()}/messages`;
    const full = icebergSchema();
    const old = { ...full, fields: full.fields.filter((f) => f.name !== 'raw_offset' && f.name !== 'raw_len') };
    expect(full.fields.slice(-2).map((f) => [f.name, f.id])).toEqual([['raw_offset', 20], ['raw_len', 21]]);
    await icebergCreateTable({ catalog, tableUrl, schema: old, partitionSpec: partitionSpec() });
    const meta = async () => (await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister: async () => { throw new Error('no listing'); } })).metadata as never;
    expect(await addColumns({ catalog, tableUrl, resolver }, await meta())).toBe(true);
    expect(await addColumns({ catalog, tableUrl, resolver }, await meta())).toBe(false);
    const now = new Date().toISOString();
    const row: BasinRow = {
      account: 'a', id: 'abc', thread_id: 'abc', ts: now, from_addr: 'x@example.com', from_name: '', to_addrs: [], cc_addrs: [], subject: 's',
      snippet: '', body_text: '', labels: [], size: 10, attachments: 0, raw_key: 'k', synced_at: now, raw_offset: 5, raw_len: 10,
    };
    await icebergAppend({ catalog, tableUrl, records: toRecords([row]) });
    const [back] = (await icebergRead({ tableUrl, resolver })) as Record<string, unknown>[];
    expect([Number(back.raw_offset), Number(back.raw_len)]).toEqual([5, 10]);
  });
});
