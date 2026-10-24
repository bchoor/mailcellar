// The backfill copy engine (backfill speed plan v4, 2026-10-24). A lane copies one month: it
// lists the month's IDs once, fetches each message once as raw, and writes each Gmail batch as
// one pack file in R2, with each message's offset and length in its Basin row. The lane's
// progress is an R2 file too, so copying reads and writes no Durable Object rows: the account's
// DO only paces Gmail from memory (a token bucket, as msgvault does). Lanes stage Basin rows;
// one committer per account appends them to Basin about once a minute, and lands each month
// once all of it is there. The month's search index is built from Basin after that.
import { mailboxName, monthQuery, r2Keys, type SyncPart, type UserId } from '@mailcellar/schema';
import type { BasinRow } from './basin';
import type { Env } from './env';
import { b64urlBytes, batchGet, getRaw, GmailError, listPage, type RawMessage } from './gmail';
import { accountQuota } from './quota';
import { accountMailbox, basinRow, launchLanes, syncDeps } from './sync';

/** Raw mail bigger than this is fetched alone; between MEDIUM and this, MEDIUM_BATCH at a time. */
export const HUGE = 2 * 1024 * 1024;
/** Raw mail a run copies before it stops fetching huge messages (the CPU budget may stop it sooner). */
export const HUGE_RUN_BYTES = 60 * 1024 * 1024;
export const MEDIUM = 128 * 1024;
export const SMALL_BATCH = 25;
export const MEDIUM_BATCH = 8;
/**
 * Small batches a lane fetches at once. Gmail runs a batch's gets side by side and turns away
 * a user with too many at once, so one, and the mailbox lets FLIGHT run across its lanes.
 */
export const WAVE = 1;
/** Batches in flight at once across an account's lanes (25 gets each; msgvault keeps 10 going). */
export const FLIGHT = 2;
/** Outside requests a lane run makes at most (Workers Free stops a run at 50). */
export const LANE_CALLS = 40;
/**
 * CPU a lane run may spend, in estimated ms. Free stops a run at about 2 s; without gzip a
 * message measured 0.3 to 0.6 ms locally (1.7 ms with a 500 KB attachment), so the estimate
 * is that times 2.5 and the budget under half the cap. Tune both from production CPU times.
 */
export const LANE_CPU_MS = 900;
export const copyCpuMs = (bytes: number) => 0.8 + (bytes / 1024) * 0.01;
/**
 * Gmail pacing per account, as msgvault does it: Gmail allows 250 units a second per user; the
 * bucket fills at 200 (40 messages a second), halves on a rate limit, and after `calmMs` without
 * one climbs back `step` at a time.
 */
export const BUCKET = { cap: 250, rate: 200, min: 25, step: 25, calmMs: 10_000 };
/** Gmail quota units a message costs (messages.get). */
export const UNITS = 5;
/** A lane run's worst case, checked against the spend cap before it starts: every call a full batch of raw mail. */
export const LANE_SPEND = { classA: LANE_CALLS + 5, classB: 5, bytes: LANE_CALLS * SMALL_BATCH * MEDIUM };

/** A month's lane, as its R2 progress file holds it. */
export interface LaneProgress {
  /** The run that owns the lane now; empty once the month is all copied and staged. */
  runId: string;
  /** The run before it, which handed over: a retry of that run hands over again. */
  prev: string | null;
  job: number;
  month: string;
  /** The list being paged (big mail first, then everything); null once listing is done. */
  list: 'huge' | 'medium' | 'all' | null;
  pageToken: string | null;
  /** IDs left to copy, by size; `all` holds the full listing until it ends. */
  huge: string[];
  medium: string[];
  small: string[];
  all: string[];
  /** An earlier copy of the month put mail in Basin: that mail is skipped when listing ends. */
  prior: boolean;
  copied: number;
  bytes: number;
  copiedIds: string[];
  packs: number;
  runs: number;
  startedAt: string;
  updatedAt: string;
  /**
   * A huge message being fetched now. A run that finds it still set died fetching it (most
   * likely out of memory), so the message goes to `tooBig` instead of killing every run after.
   */
  trying: string | null;
  /** Messages too big to copy in a Worker; the month lands without them, and they're listed. */
  tooBig: string[];
  /** The lane stopped because backfill was paused: resuming starts it again at once. */
  stopped: 'paused' | null;
  error: string | null;
}

export const freshLane = (part: SyncPart, runId: string, prior: boolean): LaneProgress => {
  const at = new Date().toISOString();
  return {
    runId, prev: null, job: part.job, month: part.month, list: 'huge', pageToken: null, huge: [], medium: [], small: [], all: [],
    prior, copied: 0, bytes: 0, copiedIds: [], packs: 0, runs: 0, startedAt: at, updatedAt: at, trying: null, tooBig: [], stopped: null, error: null,
  };
};

/** A lane's progress and its R2 etag, for a conditional save; null when there is none. */
export async function readLane(env: Env, user: UserId, account: string, month: string): Promise<{ p: LaneProgress; etag: string } | null> {
  const obj = await env.ARCHIVE.get(r2Keys.lane(user, account, month));
  return obj ? { p: (await obj.json()) as LaneProgress, etag: obj.etag } : null;
}

/** Save a lane's progress only if nobody saved it since `etag` (null: only if there is none). Returns the new etag, or null. */
export async function saveLane(env: Env, user: UserId, account: string, p: LaneProgress, etag: string | null): Promise<string | null> {
  const put = await env.ARCHIVE.put(r2Keys.lane(user, account, p.month), JSON.stringify(p), {
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
  });
  return put?.etag ?? null;
}

const nextId = (account: string, month: string) => `${account}-${month}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** What one lane run did. */
export interface LaneResult {
  copied: number;
  more: boolean;
  /** The run that carries on, when there is more. */
  nextId: string | null;
  resumesAt: string | null;
  /** Why the lane stopped, if it did. */
  stopped?: 'replaced' | 'paused' | 'budget' | 'unqueued' | 'failed';
  stats?: LaneStats;
}

/** Logged once a run, so production CPU and wall time can tune the budget. */
export interface LaneStats {
  month: string;
  copied: number;
  bytes: number;
  calls: number;
  cpuEstMs: number;
  wallMs: number;
  gmailMs: number;
  waitMs: number;
  /** Batches Gmail refused as a whole for speed: these slow the account down. */
  throttled: number;
  /** Messages Gmail turned away inside a batch (retried in a later one), and the first one's reason. */
  turnedAway: number;
  reason?: string;
}

export interface LaneOptions {
  cpuMs?: number;
  calls?: number;
}

/**
 * One run of a month's lane: list what's left, copy until the run's CPU or request budget is
 * spent, stage the Basin rows, save progress. Reads and writes no DO rows.
 */
export async function runLane(env: Env, user: UserId, account: string, month: string, runId: string, opts: LaneOptions = {}): Promise<LaneResult> {
  const started = Date.now();
  const none = (stopped: LaneResult['stopped']): LaneResult => ({ copied: 0, more: false, nextId: null, resumesAt: null, stopped });
  const got = await readLane(env, user, account, month);
  if (!got) return none('replaced');
  const { p } = got;
  let etag = got.etag;
  p.tooBig ??= [];
  // The run before died fetching this huge message: set it aside and go on.
  if (p.trying) {
    p.huge = p.huge.filter((id) => id !== p.trying);
    p.tooBig.push(p.trying);
    p.trying = null;
  }
  // A retry of a run that already saved and handed over: hand over again.
  if (p.prev === runId && p.runId) return { copied: 0, more: true, nextId: p.runId, resumesAt: null };
  if (p.runId !== runId) return none('replaced');
  const owner = env.MAILBOX.getByName(mailboxName(user));
  const mailbox = accountMailbox(env, user, account);
  const stop = async (why: 'paused' | 'budget'): Promise<LaneResult> => {
    if (why === 'budget') await owner.setBackfillPaused(true, true);
    // Kept where it stood; resuming restarts it at once.
    await saveLane(env, user, account, { ...p, stopped: 'paused', updatedAt: new Date().toISOString() }, etag);
    return none(why);
  };
  if (await owner.backfillPaused()) return stop('paused');
  const quota = accountQuota(env);
  if (await quota.overBudget(LANE_SPEND)) return stop('budget');

  const stats: LaneStats = { month, copied: 0, bytes: 0, calls: 0, cpuEstMs: 0, wallMs: 0, gmailMs: 0, waitMs: 0, throttled: 0, turnedAway: 0 };
  const turn = (units: number, throttled: boolean) =>
    mailbox.laneTurn({ user, account, month, runId, units, throttled, copied: p.copied + stats.copied, bytes: p.bytes + stats.bytes });
  const first = await turn(0, false);
  if (first.error) return failLane(env, user, account, p, first.error);
  if (!first.active) return endUnqueued(env, user, account, p);
  const token = first.token!;
  const callBudget = opts.calls ?? LANE_CALLS;
  const cpuBudget = opts.cpuMs ?? LANE_CPU_MS;
  const rows: BasinRow[] = [];
  const syncedAt = new Date().toISOString();
  let classA = 0;
  let resumesAt: string | null = null;

  try {
    // Listing: big mail first, so it can be fetched in small batches; then the whole month.
    while (p.list && stats.calls < callBudget) {
      const q = `${monthQuery(month)}${p.list === 'huge' ? ` larger:${HUGE}` : p.list === 'medium' ? ` larger:${MEDIUM}` : ''}`;
      const t = Date.now();
      const page = await listPage(token, p.pageToken ?? undefined, 500, q);
      stats.gmailMs += Date.now() - t;
      stats.calls++;
      (p.list === 'huge' ? p.huge : p.list === 'medium' ? p.medium : p.all).push(...page.ids);
      p.pageToken = page.next;
      if (page.next) continue;
      if (p.list === 'huge') p.list = 'medium';
      else if (p.list === 'medium') p.list = 'all';
      else await endListing(env, user, account, p);
    }
    // Copying: small mail in waves of batches, then medium, then huge one at a time.
    let throttled = false;
    while (!p.list && stats.calls < callBudget) {
      const wave = nextWave(p, callBudget - stats.calls);
      if (!wave) break;
      const count = wave.batches.flat().length;
      // Stop before a wave that might not fit; the first always goes, so a run always moves on.
      if (stats.cpuEstMs && stats.cpuEstMs + count * copyCpuMs(TIER_MAX[wave.tier]) > cpuBudget) {
        putBack(p, wave.tier, wave.batches);
        break;
      }
      let pace = await turn(UNITS * count, throttled);
      throttled = false;
      // Other lanes have the account's batches in flight: wait for a free one (a while, then the next run).
      for (let asks = 0; pace.active && pace.busy && asks < 40; asks++) {
        stats.waitMs += pace.waitMs;
        await scheduler.wait(pace.waitMs);
        pace = await turn(UNITS * count, false);
      }
      if (!pace.active) {
        putBack(p, wave.tier, wave.batches);
        return endUnqueued(env, user, account, p);
      }
      if (pace.busy) {
        putBack(p, wave.tier, wave.batches);
        break;
      }
      if (pace.waitMs) {
        stats.waitMs += pace.waitMs;
        await scheduler.wait(pace.waitMs);
      }
      // A huge message is fetched alone, and noted first, so a run it kills doesn't repeat it.
      if (wave.tier === 'huge') {
        if (stats.bytes >= HUGE_RUN_BYTES) {
          putBack(p, wave.tier, wave.batches);
          break;
        }
        // Stage what the run copied so far, so the note saved is the run's whole state: nothing is lost with it.
        if (rows.length) {
          await env.ARCHIVE.put(r2Keys.staged(user, account, month, `${runId}-${p.packs}`), JSON.stringify(rows.splice(0)));
          classA++;
        }
        const id = wave.batches[0][0];
        const note = { ...p, copied: p.copied + stats.copied, bytes: p.bytes + stats.bytes, huge: [id, ...p.huge], trying: id, updatedAt: new Date().toISOString() };
        const marked = await saveLane(env, user, account, note, etag);
        if (!marked) return { ...none('replaced'), copied: stats.copied };
        etag = marked;
        classA++;
      }
      const t = Date.now();
      const results = await Promise.allSettled(
        wave.tier === 'huge'
          ? [getRaw(token, wave.batches[0][0]).then((m) => ({ messages: m ? [m] : [], retry: [], throttled: 0, reason: undefined }))]
          : wave.batches.map((ids) => batchGet(token, ids, 'raw')),
      );
      stats.gmailMs += Date.now() - t;
      stats.calls += wave.batches.length;
      for (const [i, r] of results.entries()) {
        if (r.status === 'rejected') {
          const e = r.reason;
          if (!(e instanceof TypeError || (e instanceof GmailError && (e.status === 429 || e.status >= 500)))) throw e;
          putBack(p, wave.tier, [wave.batches[i]]);
          if (e instanceof GmailError && e.status === 429) throttled = true;
          continue;
        }
        stats.turnedAway += r.value.throttled;
        stats.reason ??= r.value.reason;
        p.trying = null;
        putBack(p, wave.tier, [r.value.retry]);
        if (!r.value.messages.length) continue;
        const packed = pack(account, r.value.messages, r2Keys.pack(user, account, month, `${runId}-${p.packs}`), syncedAt);
        await env.ARCHIVE.put(packed.key, packed.bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
        p.packs++;
        classA++;
        rows.push(...packed.rows);
        p.copiedIds.push(...packed.rows.map((x) => x.id));
        stats.copied += packed.rows.length;
        stats.bytes += packed.bytes.length;
        stats.cpuEstMs += packed.rows.reduce((t, x) => t + copyCpuMs(x.raw_len ?? 0), 0);
      }
      if (throttled) stats.throttled++;
    }
  } catch (e) {
    if (e instanceof GmailError && (e.status === 401 || e.status === 403)) return failLane(env, user, account, p, e.message);
    if (!(e instanceof TypeError || (e instanceof GmailError && (e.status === 429 || e.status >= 500)))) throw e;
    // Gmail didn't answer: keep what this run copied, and try again in a minute.
    resumesAt = new Date(Date.now() + 60_000).toISOString();
    p.error = `Gmail didn't answer (${e instanceof GmailError ? `HTTP ${e.status}` : 'network'}). Trying again shortly.`;
  }

  if (rows.length) {
    await env.ARCHIVE.put(r2Keys.staged(user, account, month, runId), JSON.stringify(rows));
    classA++;
  }
  const done = !p.list && !p.huge.length && !p.medium.length && !p.small.length;
  const next = done ? '' : nextId(account, month);
  const saved: LaneProgress = {
    ...p, trying: null, runId: next, prev: runId, copied: p.copied + stats.copied, bytes: p.bytes + stats.bytes, runs: p.runs + 1,
    updatedAt: new Date().toISOString(), stopped: null, error: resumesAt ? p.error : null,
  };
  classA++;
  if (!(await saveLane(env, user, account, saved, etag))) return { ...none('replaced'), copied: stats.copied };
  // Tell the page what this run copied (the last wave's mail isn't in the turns before it).
  await turn(0, false);
  // Raw mail at its size, staged rows and Basin's files at about a KB a message.
  await quota.charge({ classA: classA + 1, classB: 3, bytes: stats.bytes + stats.copied * 1024 });
  if (rows.length || done) await ensureCommitter(env, user, account);
  stats.wallMs = Date.now() - started;
  console.log(JSON.stringify({ lane: stats }));
  return { copied: stats.copied, more: !done, nextId: done ? null : next, resumesAt, stats };
}

type Tier = 'small' | 'medium' | 'huge';
/** The biggest message each tier can hold, for the CPU estimate before fetching (huge: Gmail's largest). */
const TIER_MAX: Record<Tier, number> = { small: MEDIUM, medium: HUGE, huge: 36 * 1024 * 1024 };

/** The next batches to fetch: up to WAVE small batches, else one medium batch, else one huge message. */
function nextWave(p: LaneProgress, calls: number): { tier: Tier; batches: string[][] } | null {
  if (p.small.length) {
    const batches: string[][] = [];
    while (p.small.length && batches.length < Math.min(WAVE, calls)) batches.push(p.small.splice(0, SMALL_BATCH));
    return { tier: 'small', batches };
  }
  if (p.medium.length) return { tier: 'medium', batches: [p.medium.splice(0, MEDIUM_BATCH)] };
  if (p.huge.length) return { tier: 'huge', batches: [p.huge.splice(0, 1)] };
  return null;
}

/** IDs to fetch again, back at the front of their tier. */
function putBack(p: LaneProgress, tier: Tier, batches: string[][]): void {
  p[tier].unshift(...batches.flat());
}

/** One pack: the batch's raw messages end to end, and each one's Basin row with where it is. */
export function pack(account: string, messages: RawMessage[], key: string, syncedAt: string): { key: string; bytes: Uint8Array; rows: BasinRow[] } {
  const raws = messages.map((m) => b64urlBytes(m.raw));
  // One message: its bytes are the pack, with no copy.
  if (raws.length === 1) return { key, bytes: raws[0], rows: [basinRow(account, messages[0], raws[0], key, syncedAt, { offset: 0, len: raws[0].length })] };
  const bytes = new Uint8Array(raws.reduce((t, r) => t + r.length, 0));
  const rows: BasinRow[] = [];
  let offset = 0;
  for (const [i, m] of messages.entries()) {
    bytes.set(raws[i], offset);
    rows.push(basinRow(account, m, raws[i], key, syncedAt, { offset, len: raws[i].length }));
    offset += raws[i].length;
  }
  return { key, bytes, rows };
}

/** Listing is done: sort the month into tiers, and skip mail an earlier copy put in Basin. */
async function endListing(env: Env, user: UserId, account: string, p: LaneProgress): Promise<void> {
  const skip = new Set<string>();
  const copied = await env.ARCHIVE.get(r2Keys.copied(user, account, p.month));
  if (copied) for (const id of (await copied.json()) as string[]) skip.add(id);
  else if (p.prior) {
    const target = await syncDeps.basin(env, user);
    if (target) for (const r of await target.monthRows(account, p.month)) skip.add(r.id);
  }
  const huge = new Set(p.huge);
  const big = new Set([...p.huge, ...p.medium]);
  p.huge = p.huge.filter((id) => !skip.has(id));
  p.medium = p.medium.filter((id) => !huge.has(id) && !skip.has(id));
  p.small = [...new Set(p.all)].filter((id) => !big.has(id) && !skip.has(id));
  p.all = [];
  p.list = null;
  p.pageToken = null;
}

async function failLane(env: Env, user: UserId, account: string, p: LaneProgress, error: string): Promise<LaneResult> {
  const mailbox = accountMailbox(env, user, account);
  await mailbox.finishPart({ job: p.job, month: p.month }, 'failed', error);
  await env.ARCHIVE.delete(r2Keys.lane(user, account, p.month));
  await mailbox.endLane(p.month);
  await launchLanes(env, user, account);
  return { copied: 0, more: false, nextId: null, resumesAt: null, stopped: 'failed' };
}

/** The month was taken out of the queue: the lane ends; what it copied and staged stays (and lands). */
async function endUnqueued(env: Env, user: UserId, account: string, p: LaneProgress): Promise<LaneResult> {
  await env.ARCHIVE.delete(r2Keys.lane(user, account, p.month));
  await accountMailbox(env, user, account).endLane(p.month);
  await launchLanes(env, user, account);
  return { copied: 0, more: false, nextId: null, resumesAt: null, stopped: 'unqueued' };
}

/** The account's committer, as its R2 file holds it. */
export interface Committer {
  runId: string;
  at: string;
  /** Checks in a row that found nothing to do. */
  idle: number;
  /** Basin's table exists with every column (checked once a committer chain). */
  ready: boolean;
  error: string | null;
}

/** A committer that hasn't checked in for this long has died, and a lane starts a new one. */
export const COMMITTER_STALE_MS = 3 * 60_000;
/** How often the committer looks for staged rows. */
export const COMMIT_EVERY_MS = 60_000;
/** Checks with nothing to do before the committer stops (a lane starts it again). */
export const COMMITTER_IDLE = 3;
/** Staged bytes one commit takes: about 2,000 messages' rows, well inside a run's CPU. */
export const COMMIT_BYTES = 8 * 1024 * 1024;

/** Start the account's committer unless one is checking in. Only one starts, however many lanes ask. */
export async function ensureCommitter(env: Env, user: UserId, account: string): Promise<string | null> {
  const key = r2Keys.committer(user, account);
  const obj = await env.ARCHIVE.get(key);
  if (obj) {
    const c = (await obj.json()) as Committer;
    if (Date.now() - Date.parse(c.at) < COMMITTER_STALE_MS) return null;
  }
  const runId = `${account}-commit-${Date.now().toString(36)}`;
  const c: Committer = { runId, at: new Date().toISOString(), idle: 0, ready: false, error: null };
  const put = await env.ARCHIVE.put(key, JSON.stringify(c), { onlyIf: obj ? { etagMatches: obj.etag } : { etagDoesNotMatch: '*' } });
  if (!put) return null;
  await syncDeps.launch(env, { user, account, commit: true }, runId);
  return runId;
}

export interface CommitResult {
  committed: number;
  landed: string[];
  more: boolean;
  nextId: string | null;
  waitMs: number;
}

/**
 * One check of the account's committer: append what the lanes staged to Basin (one append, up
 * to COMMIT_BYTES), then land each month whose lane is done and has nothing staged left.
 */
export async function runCommit(env: Env, user: UserId, account: string, runId: string, maxBytes = COMMIT_BYTES): Promise<CommitResult> {
  const key = r2Keys.committer(user, account);
  const obj = await env.ARCHIVE.get(key);
  const c = obj ? ((await obj.json()) as Committer) : null;
  if (!obj || !c || c.runId !== runId) return { committed: 0, landed: [], more: false, nextId: null, waitMs: 0 };
  const quota = accountQuota(env);
  const listed = await env.ARCHIVE.list({ prefix: r2Keys.stagedPrefix(user, account) });
  const take: string[] = [];
  let bytes = 0;
  for (const o of listed.objects) {
    if (take.length && bytes + o.size > maxBytes) break;
    take.push(o.key);
    bytes += o.size;
  }
  let committed = 0;
  let classA = 1;
  let classB = 1;
  c.error = null;
  if (take.length)
    try {
      const target = await syncDeps.basin(env, user);
      if (!target) throw new Error('Basin has no write token');
      if (!c.ready) {
        await target.ensure();
        c.ready = true;
      }
      const rows: BasinRow[] = [];
      for (const k of take) {
        const staged = await env.ARCHIVE.get(k);
        classB++;
        if (staged) rows.push(...((await staged.json()) as BasinRow[]));
      }
      if (rows.length) await target.append(rows);
      // A Basin commit writes data and metadata files through the catalog: about 10 R2 writes.
      classA += 10;
      await env.ARCHIVE.delete(take);
      committed = rows.length;
    } catch (e) {
      // The rows stay staged; the next check commits them.
      c.error = `Basin didn't take the staged rows (${String(e).slice(0, 160)}).`;
    }

  // Land months whose lane is done and whose rows are all in Basin.
  const landed: string[] = [];
  const lanes = await env.ARCHIVE.list({ prefix: r2Keys.lanes(user, account) });
  classA += 2;
  for (const o of lanes.objects) {
    const lane = await env.ARCHIVE.get(o.key);
    classB++;
    if (!lane) continue;
    const p = (await lane.json()) as LaneProgress;
    if (p.runId || p.list) continue;
    const left = await env.ARCHIVE.list({ prefix: r2Keys.stagedPrefix(user, account, p.month), limit: 1 });
    if (left.objects.length) continue;
    await landMonth(env, user, account, p);
    landed.push(p.month);
  }
  await quota.charge({ classA: classA + 2, classB });

  const busy = take.length > 0 || landed.length > 0 || lanes.objects.length > 0;
  c.idle = busy ? 0 : c.idle + 1;
  if (c.idle >= COMMITTER_IDLE) {
    await env.ARCHIVE.delete(key);
    return { committed, landed, more: false, nextId: null, waitMs: 0 };
  }
  const next = `${account}-commit-${Date.now().toString(36)}`;
  const saved = await env.ARCHIVE.put(key, JSON.stringify({ ...c, runId: next, at: new Date().toISOString() }), { onlyIf: { etagMatches: obj.etag } });
  if (!saved) return { committed, landed, more: false, nextId: null, waitMs: 0 };
  // More staged than one commit takes: commit again at once; else look again in a minute.
  const behind = listed.truncated || take.length < listed.objects.length;
  console.log(JSON.stringify({ commit: { account, committed, landed, behind, error: c.error } }));
  return { committed, landed, more: true, nextId: next, waitMs: behind && !c.error ? 0 : c.error ? 5 * COMMIT_EVERY_MS : COMMIT_EVERY_MS };
}

/** A month is all in Basin: remember its IDs, mark it done, build its index, and start the next month. */
async function landMonth(env: Env, user: UserId, account: string, p: LaneProgress): Promise<void> {
  const key = r2Keys.copied(user, account, p.month);
  const before = await env.ARCHIVE.get(key);
  const ids = new Set(before ? ((await before.json()) as string[]) : []);
  const had = ids.size;
  for (const id of p.copiedIds) ids.add(id);
  await env.ARCHIVE.put(key, JSON.stringify([...ids]));
  const mailbox = accountMailbox(env, user, account);
  // Messages new to the month, each once: a run's count can repeat one it copied again after a retry.
  await mailbox.landMonth({ job: p.job, month: p.month }, { copied: ids.size - had, bytes: p.bytes });
  await syncDeps.launch(env, { user, account, index: p.month }, `${account}-index-${p.month}-${Date.now().toString(36)}`);
  await env.ARCHIVE.delete(r2Keys.lane(user, account, p.month));
  await mailbox.endLane(p.month);
  if (p.tooBig?.length) console.log(JSON.stringify({ landed: p.month, tooBig: p.tooBig }));
  await launchLanes(env, user, account);
}
