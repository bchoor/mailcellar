// The sync Workflow: copies new mail of one Gmail account into MailCellar, 500 messages a run,
// and routes the other runs: backfill lanes and the Basin committer (copy.ts), index builds,
// the census.
// Spike S7 found that a Workflow run is one Worker invocation, so Workers Free's caps of
// 50 outside requests and 1,000 Cloudflare calls cover the whole run. A run therefore does
// one batch and then starts the next run, until the account is copied.
// Raw mail goes to R2 (gzipped up to 256 KB, spike S3), the index to the account's DO, and
// every message's row to Basin, the system of record. Basin rows are staged in R2 first, so
// a failed commit is retried by the next run instead of losing the batch.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { addMonths, asUserId, GMAIL_FIRST_MONTH, mailboxName, monthBounds, monthNow, monthQuery, r2Keys, type CensusState, type IndexedMessage, type SyncParams, type SyncState, type UserId, withRecent, MAX_LANES, paidNow } from '@mailcellar/schema';
import { basinCheck, catalogTarget, COMMIT_CALLS, type BasinRow, type BasinTarget } from './basin';
import type { Env } from './env';
import { accountQuota, type QuotaUse } from './quota';
import { runCommit, runLane } from './copy';
import { BATCH_SIZE, b64urlBytes, batchGet, addedSince, bodyText, GmailError, headers, indexRow, labels, listPage, packBySize, parseAddresses, profile, type RawMessage } from './gmail';

/** Messages one run copies: about 510 R2 and DO calls, well inside the cap of 1,000. */
export const RUN_SIZE = 500;
/** Outside requests a run may make: Workers Free stops a run at 50 (spike S7), Paid at 10,000. */
export const RUN_CALLS = () => (paidNow() ? 400 : 45);
/** Raw mail fetched in one Gmail batch, as Gmail sizes it: keeps the answer well inside 128 MB. */
export const BATCH_BYTES = 8 * 1024 * 1024;
/** Messages up to this size are gzipped; larger ones are mostly already-compressed attachments. */
export const GZIP_MAX = 256 * 1024;
/**
 * CPU a run may spend copying, in ms. Workers Free stopped a run at about 2 s of CPU on
 * 2026-10-24 (the spike's 1.9 s had passed), so a run stays at a quarter of that and the
 * next run copies the rest. Workers can't read their own CPU time, so it is estimated.
 */
export const RUN_CPU_MS = () => (paidNow() ? 10_000 : 500);
/**
 * Estimated CPU to copy one message: twice what a local benchmark measured on 2026-10-24
 * (20 KB 3 ms, 100 KB 5 ms, 6.8 MB 9 ms), since the first estimate ran about 5x low in
 * production. A fixed 5 ms, the body read up to 256 KB (0.05 ms a KB) and the raw bytes
 * decoded and stored (0.001 ms a KB).
 */
export function messageCpuMs(size: number): number {
  const kb = size / 1024;
  return 5 + Math.min(kb, 256) * 0.05 + kb * 0.001;
}
/**
 * Whether the run that owns a sync has died: its Workflow errored (Cloudflare stopped it, say
 * for CPU), was terminated, or ended without handing over. Then nothing will save the sync
 * again, so it is started afresh instead of waiting SYNC_STALE_MS. Copied mail is skipped.
 */
export async function runDied(env: Env, runId: string): Promise<boolean> {
  if (!runId) return false;
  const status = await syncDeps.runStatus(env, runId);
  return status === 'errored' || status === 'terminated' || status === 'complete';
}

/** Staged Basin batches one run commits when Basin is behind; that run copies nothing new. */
export const BASIN_COMMIT_KEYS = 2;
/**
 * What a full run may use, asked of the account's meters before it starts. Copying writes R2 and
 * Basin, not the DO (a few bookkeeping rows), so the DO's daily limits never pause it: only the
 * index build waits for them (INDEX_COST, runIndex).
 */
export const RUN_COST: QuotaUse = { workers_requests: 10, r2_class_a: RUN_SIZE + 30, r2_class_b: 50 };
/** DO rows indexing a message takes (measured ~3.0 rows a message after the slim index, #49, and +2 for the Sender and Size sort indexes), with room to spare. */
export const INDEX_ROWS = 6;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The DO holding one Gmail account's index and sync state. */
export const accountMailbox = (env: Env, user: UserId, account: string) => env.MAILBOX.getByName(mailboxName(user, account));

/** What one run did, and whether another run should follow. */
export interface RunResult {
  copied: number;
  phase: SyncState['phase'] | 'replaced';
  more: boolean;
  resumesAt: string | null;
}

export async function accessToken(env: Env, refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (body.access_token) return body.access_token;
  throw new GmailError(body.error === 'invalid_grant' ? 401 : res.status, 'Google no longer accepts this account. Remove it and add it again.');
}

/** Gzipped JSON, for staged Basin rows. */
async function gzipJson(value: unknown): Promise<Uint8Array> {
  return gzip(new TextEncoder().encode(JSON.stringify(value)));
}
async function gunzipJson<T>(body: ReadableStream): Promise<T> {
  return (await new Response(body.pipeThrough(new DecompressionStream('gzip'))).json()) as T;
}

/** Basin's row for a message: the index row plus recipients and body text. */
export function basinRow(account: string, m: RawMessage, raw: Uint8Array, rawKey: string, syncedAt: string, at?: { offset: number; len: number }): BasinRow {
  const h = headers(raw);
  const row = indexRow(m, raw, h);
  return {
    account,
    id: row.id,
    thread_id: row.threadId,
    ts: new Date(row.ts).toISOString(),
    from_addr: row.fromAddr,
    from_name: row.fromName,
    to_addrs: parseAddresses(h.get('to') ?? ''),
    cc_addrs: parseAddresses(h.get('cc') ?? ''),
    subject: row.subject,
    snippet: row.snippet,
    body_text: bodyText(raw),
    labels: row.labels,
    size: m.sizeEstimate,
    attachments: row.attachments,
    raw_key: rawKey,
    synced_at: syncedAt,
    ...(at ? { raw_offset: at.offset, raw_len: at.len } : {}),
  };
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Next 00:05 UTC, when the free tier's daily limits have reset. */
export const nextReset = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));

/** Durable Objects on Workers Free fail writes once the account's daily rows are used up. */
const isDailyLimit = (e: unknown) => /exceeded|limit/i.test(String(e));

/** The phase a stopped sync resumes in: back to the backfill, or on to new mail. */
const resumePhase = (s: SyncState): SyncState['phase'] =>
  s.phase === 'waiting' || s.phase === 'error'
    ? s.pageToken !== null || s.pending.length || s.historyId === null || s.part ? 'backfill' : 'live'
    : s.phase;

/** Basin is the system of record, so no sync starts until it can be written. */
export class BasinNotReady extends Error {}

/**
 * Start (or restart) syncing an account. The new run takes over: a run already going finds
 * another run ID in the sync state and stops at its next save.
 */
export async function startSync(env: Env, user: UserId, account: string): Promise<string> {
  if (!env.BASIN_TOKEN) throw new BasinNotReady('Basin has no write token yet');
  const mailbox = accountMailbox(env, user, account);
  const now = new Date().toISOString();
  const state: SyncState = (await mailbox.syncState()) ?? {
    phase: 'backfill', runId: '', total: null, copied: 0, bytes: 0, pending: [], pageToken: null, historyId: null,
    basinQueue: [], basinReady: false, startedAt: now, updatedAt: now, resumesAt: null, error: null, part: null,
  };
  // Months waiting in a backfill take a live sync back to backfilling.
  const phase = resumePhase(state) === 'live' && (await mailbox.hasQueued()) ? 'backfill' : resumePhase(state);
  const runId = `${account}-${Date.now().toString(36)}`;
  await mailbox.saveSync({ ...state, runId, phase, error: null, resumesAt: null, updatedAt: now });
  await env.SYNC.create({ id: runId, params: { user, account } });
  return runId;
}

/** A Gmail answer worth trying again later: rate limits, Google's errors, the network. */
const retryable = (e: unknown) => (e instanceof GmailError && (e.status === 429 || e.status >= 500)) || e instanceof TypeError;

/** One run's work: list what's left, copy up to RUN_SIZE messages, save progress. */
export interface RunOptions {
  calls: number;
  batchBytes: number;
  /** CPU budget, in estimated ms; RUN_CPU_MS unless a test sets another. */
  cpuMs?: number;
  /** Where Basin rows go; the R2 Data Catalog unless a test supplies another. */
  basin?: (env: Env, user: UserId) => Promise<BasinTarget | null>;
}

/** Where Basin rows go, how a sync starts, and how a run's Workflow stands. Tests swap in stand-ins. */
export const syncDeps: {
  runStatus: (env: Env, runId: string) => Promise<string | null>;
  basin: (env: Env, user: UserId) => Promise<BasinTarget | null>;
  start: (env: Env, user: UserId, account: string) => Promise<string>;
  census: (env: Env, user: UserId, account: string, mode: CensusState['mode']) => Promise<string>;
  /** Start a Workflow run: a lane or an index build. */
  launch: (env: Env, params: SyncParams, id: string) => Promise<void>;
} = {
  runStatus: async (env, runId) => {
    try {
      return (await (await env.SYNC.get(runId)).status()).status;
    } catch {
      return null;
    }
  },
  basin: catalogTarget,
  start: (env, user, account) => startSync(env, user, account),
  census: (env, user, account, mode) => startCensus(env, user, account, mode),
  // From the account's alarm, not from the caller: a run started by a run counts as nested in it (MailboxDO.launchLater).
  launch: (env, params, id) => accountMailbox(env, asUserId(params.user), params.account).launchLater(id, params),
};

/** Basin rows staged this many batches behind: the run commits instead of copying more. */
export const BASIN_BEHIND = 4;
/** How long a run may hold the account's Basin commit turn. */
export const COMMIT_TURN_MS = 2 * 60_000;
/** What a run may add to the backfill's spend, checked against the cap before it starts: RUN_SIZE messages of up to 100 KB. */
export const RUN_SPEND = { classA: RUN_COST.r2_class_a!, classB: RUN_COST.r2_class_b!, bytes: RUN_SIZE * 100 * 1024 };

/** An index row for a Basin row (the search index is built from Basin). */
export function indexedFromBasin(r: Pick<BasinRow, 'id' | 'thread_id' | 'ts' | 'from_addr' | 'from_name' | 'subject' | 'snippet' | 'size' | 'attachments' | 'labels'>): IndexedMessage {
  return {
    id: r.id, threadId: r.thread_id, ts: Date.parse(r.ts), fromAddr: r.from_addr, fromName: r.from_name,
    subject: r.subject, snippet: r.snippet, size: Number(r.size), attachments: Number(r.attachments), labels: r.labels,
  };
}

/**
 * Start lanes for queued backfill months, up to MAX_LANES at once, and restart lanes that
 * stopped. Each lane copies one month to R2 and Basin (copy.ts), then takes the next queued month.
 */
export async function launchLanes(env: Env, user: UserId, account: string): Promise<number> {
  if (await env.MAILBOX.getByName(mailboxName(user)).backfillPaused()) return 0;
  const lanes = await accountMailbox(env, user, account).claimLanes(user, account, MAX_LANES);
  for (const l of lanes) await syncDeps.launch(env, { user, account, month: l.month }, l.runId);
  return lanes.length;
}

/**
 * One run of the account's own sync: new mail since the last run, and it hands queued backfill
 * months to lanes (copy.ts). Mail goes to R2 and its rows to Basin first; new mail is indexed as
 * soon as Basin has it.
 */
export async function runBatch(
  env: Env,
  user: UserId,
  account: string,
  runId: string,
  limits: RunOptions = { calls: RUN_CALLS(), batchBytes: BATCH_BYTES },
): Promise<RunResult> {
  const mailbox = accountMailbox(env, user, account);
  const state = await mailbox.syncState();
  const replaced: RunResult = { copied: 0, phase: 'replaced', more: false, resumesAt: null };
  if (!state || state.runId !== runId) return replaced;
  const added = { copied: 0, bytes: 0 };
  const save = (next: SyncState) => mailbox.saveSync({ ...next, updatedAt: new Date().toISOString() }, runId, added);
  // A stop fails the month being copied; Retry copies it again (copied mail is skipped).
  const stop = async (error: string): Promise<RunResult> => {
    const part = state.part;
    if (!(await save({ ...state, phase: 'error', error, part: null, pending: [], pageToken: part ? null : state.pageToken }))) return replaced;
    if (part) await mailbox.finishPart(part, 'failed', error);
    return { copied: 0, phase: 'error', more: false, resumesAt: null };
  };
  // Stop for now and let a fresh run try again: same as the daily limit, with another reason.
  const later = async (resumesAt: Date, phase: SyncState['phase'], error: string | null): Promise<RunResult> => {
    if (!(await save({ ...state, phase, resumesAt: resumesAt.toISOString(), error }))) return replaced;
    return { copied: 0, phase, more: true, resumesAt: resumesAt.toISOString() };
  };

  const owner = env.MAILBOX.getByName(mailboxName(user));
  // Paused by the person: stop without saving. A lane keeps where it stood; resuming picks it up.
  if (await owner.backfillPaused()) return { copied: 0, phase: state.phase, more: false, resumesAt: null };
  const refreshToken = await owner.accountToken(account);
  if (!refreshToken) return stop('This account was removed from MailCellar.');

  // The account's daily limits are shared by every user: pause before one, resume after it resets.
  const quota = accountQuota(env);
  const full = await quota.reserve(RUN_COST);
  if (full) {
    state.pausedFor = full.label;
    return later(new Date(full.resumesAt), 'waiting', null);
  }
  state.pausedFor = null;
  // The spend cap: a run that could pass it pauses all backfill instead (Bikram's $1.10, 2026-10-24).
  if (await quota.overBudget(RUN_SPEND)) {
    await owner.setBackfillPaused(true, true);
    return { copied: 0, phase: state.phase, more: false, resumesAt: null };
  }
  let r2a = 0;
  let r2b = 0;
  let rowsRead = 0;

  const basin: BasinRow[] = [];
  const syncedAt = new Date().toISOString();
  let rest: string[];
  let calls = 1; // the token refresh
  try {
    const token = await accessToken(env, refreshToken);
    {
      // First run: how much there is, where new mail starts, and the label names.
      if (state.historyId === null) {
        const p = await profile(token);
        await mailbox.putLabels(await labels(token));
        calls += 2;
        state.total = p.messagesTotal;
        state.historyId = p.historyId;
      }
      // Backfill months are copied by lanes, several at once. A month this sync was copying
      // itself (before lanes) is still queued as running, so a lane copies it again from the start.
      if (state.phase === 'backfill' || state.part || (await mailbox.hasQueued())) {
        await launchLanes(env, user, account);
        if (state.part) Object.assign(state, { part: null, pending: [], pageToken: null });
        state.phase = 'live';
      }
      if (!state.pending.length) {
        const fresh = await addedSince(token, state.historyId!);
        state.pending = await mailbox.unknownIds(fresh.ids);
        rowsRead += fresh.ids.length;
        state.historyId = fresh.historyId;
        calls += fresh.calls;
      }
    }
    // Basin is behind: this run only commits what's staged, so its CPU stays in budget.
    const take = state.basinQueue.length >= BASIN_BEHIND ? [] : state.pending.slice(0, RUN_SIZE);
    rest = state.pending.slice(take.length);
    // Sizes first (format=minimal), so raw batches can be packed to fit in memory.
    const sized = [];
    for (let i = 0; i < take.length; i += BATCH_SIZE) {
      // Gmail allows 250 quota units a second per user; a batch of 50 gets costs 250.
      if (calls) await scheduler.wait(1000);
      calls++;
      const { messages, retry } = await batchGet(token, take.slice(i, i + BATCH_SIZE), 'minimal');
      // Spam and Trash are left out, as the backfill's Gmail list leaves them out.
      sized.push(...messages.filter((m) => !m.labelIds?.some((l) => l === 'SPAM' || l === 'TRASH')));
      rest.push(...retry);
    }
    // Keep the run's CPU in budget: what doesn't fit goes to the next run.
    const budget = limits.cpuMs ?? RUN_CPU_MS();
    let cpu = 0;
    let fit = 0;
    while (fit < sized.length && (fit === 0 || cpu + messageCpuMs(sized[fit].sizeEstimate) <= budget)) cpu += messageCpuMs(sized[fit++].sizeEstimate);
    rest = [...sized.slice(fit).map((m) => m.id), ...rest];
    const batches = packBySize(sized.slice(0, fit), limits.batchBytes);
    for (const [b, ids] of batches.entries()) {
      if (calls >= limits.calls - COMMIT_CALLS) {
        rest = [...batches.slice(b).flat(), ...rest];
        break;
      }
      await scheduler.wait(1000);
      calls++;
      const { messages, retry } = await batchGet(token, ids, 'raw');
      rest = [...retry, ...rest];
      for (const m of messages) {
        const raw = b64urlBytes(m.raw);
        const small = raw.length <= GZIP_MAX;
        const rawKey = r2Keys.raw(user, account, m.id);
        r2a++;
        await env.ARCHIVE.put(rawKey, small ? await gzip(raw) : raw, {
          httpMetadata: { contentType: 'message/rfc822', contentEncoding: small ? 'gzip' : undefined },
        });
        basin.push(basinRow(account, m, raw, rawKey, syncedAt));
        added.copied++;
        added.bytes += m.sizeEstimate;
      }
    }
    // Gmail's count of a month goes stale as new mail lands in it: count the months it landed in again.
    const landed = new Set(basin.map((r) => new Date(r.ts).toISOString().slice(0, 7)).filter((m) => m >= addMonths(monthNow(), -1)));
    for (const month of landed) {
      if (calls + LIST_CALLS() > limits.calls) break;
      let n = 0;
      let pageToken: string | undefined;
      for (let page = 0; page < LIST_CALLS(); page++) {
        calls++;
        const got = await listPage(token, pageToken, 500, monthQuery(month));
        n += got.ids.length;
        pageToken = got.next ?? undefined;
        if (!pageToken) break;
      }
      if (!pageToken) await mailbox.putMonthCount(month, n);
    }
  } catch (e) {
    // Mail fetched before the error isn't staged for Basin, so it isn't counted; the next run copies it again.
    Object.assign(added, { copied: 0, bytes: 0 });
    if (e instanceof GmailError && (e.status === 401 || e.status === 403)) return stop(e.message);
    if (!retryable(e)) throw e;
    return later(new Date(Date.now() + 5 * 60_000), state.phase, `Gmail didn't answer (${e instanceof GmailError ? `HTTP ${e.status}` : 'network'}). Trying again shortly.`);
  }

  // Stage this batch's rows for Basin, then commit what's staged when it's this run's turn.
  if (basin.length) {
    const key = r2Keys.basinQueue(user, account, `live-${runId}-${Date.now().toString(36)}`);
    r2a++;
    await env.ARCHIVE.put(key, await gzipJson(basin));
    state.basinQueue = [...state.basinQueue, key];
  }
  let basinError: string | null = null;
  let waitTurn = false;
  let rowsWritten = 0;
  if (state.basinQueue.length) {
    if (!(await mailbox.commitTurn(runId, COMMIT_TURN_MS))) waitTurn = true;
    else
      try {
        const target = await (limits.basin ?? syncDeps.basin)(env, user);
        if (!target) throw new Error('Basin has no write token');
        if (!state.basinReady) {
          await target.ensure();
          state.basinReady = true;
        }
        const queued: BasinRow[] = [];
        const commit = state.basinQueue.slice(0, BASIN_COMMIT_KEYS);
        for (const key of commit) {
          r2b++;
          const obj = await env.ARCHIVE.get(key);
          if (obj) queued.push(...(await gunzipJson<BasinRow[]>(obj.body)));
        }
        if (queued.length) await target.append(queued);
        // A Basin commit writes data and metadata files through the catalog: about 10 R2 writes.
        r2a += 10 + commit.length;
        await env.ARCHIVE.delete(commit);
        state.basinQueue = state.basinQueue.slice(commit.length);
        // New mail is indexed as soon as Basin has it, when the DO's daily limits have room.
        if (queued.length && !(await quota.reserve({ do_rows_written: queued.length * INDEX_ROWS, do_rows_read: queued.length * 2 }))) {
          try {
            rowsWritten = (await mailbox.ingest(queued.map(indexedFromBasin))).rowsWritten;
          } catch (e) {
            // Basin has it; the month's index is built from Basin later.
            if (!isDailyLimit(e)) throw e;
          }
        }
      } catch (e) {
        // The rows stay staged; the next run commits them.
        basinError = `Basin didn't take this batch (${String(e).slice(0, 120)}). Retrying with the next batch.`;
      } finally {
        await mailbox.endCommitTurn(runId);
      }
  }
  // Sync-state saves and month bookkeeping: a few rows each run.
  await quota.add({ do_rows_written: rowsWritten + 6, do_rows_read: rowsRead + rowsWritten * 2 + 20, r2_class_a: r2a, r2_class_b: r2b });
  // Raw mail counts at Gmail's size (gzip only makes it smaller), staged rows and Basin's files at a KB a message.
  await quota.charge({ classA: r2a, classB: r2b, bytes: added.bytes + added.copied * 1024 });

  const next: SyncState = { ...state, pending: rest, copied: state.copied + added.copied, bytes: state.bytes + added.bytes, resumesAt: null, error: basinError };
  // A Basin failure waits 5 minutes, so a run that can't commit doesn't start the next at once;
  // a run that waited for its turn to commit tries again shortly.
  if (basinError) next.resumesAt = new Date(Date.now() + 5 * 60_000).toISOString();
  else if (waitTurn && !added.copied) next.resumesAt = new Date(Date.now() + 15_000).toISOString();

  if (!(await save(next))) return replaced;
  const more = rest.length > 0 || next.basinQueue.length > 0;
  return { copied: added.copied, phase: next.phase, more, resumesAt: next.resumesAt };
}

/** Index rows written a call when building a month's index (fewer calls, fewer search segments). Measured ~3 DO rows a message (Jul 2026). */
export const INDEX_CHUNK = 500;
/** Chunks one index run writes before handing over to a fresh run (each run reads the month from Basin again). */
export const INDEX_CHUNKS_A_RUN = () => (paidNow() ? 20 : 4);

/**
 * Build a landed month's search index from Basin: read the month back, and index what the
 * index doesn't have yet, a chunk at a time within the account's daily limits. Rerunning it
 * is safe: messages already indexed are skipped. Returns where the next run starts, if any.
 */
export async function runIndex(env: Env, user: UserId, account: string, month: string, from = 0): Promise<{ indexed: number; next: number | null; resumesAt: string | null }> {
  const mailbox = accountMailbox(env, user, account);
  // Indexing from now, not from the first chunk: reading the month back from Basin takes a while.
  await mailbox.indexStarted(month);
  // The Sender and Size sort indexes first, so each message is indexed once with all of them.
  await mailbox.buildSorts();
  const target = await syncDeps.basin(env, user);
  if (!target) return { indexed: 0, next: from, resumesAt: new Date(Date.now() + 5 * 60_000).toISOString() };
  // Gmail's month decides what the month holds: listed on the first run, kept in R2 for the rest.
  const listed = from === 0 ? await listMonth(env, user, account, month) : await readListed(env, user, account, month);
  const rows = (await target.monthRows(account, month, listed ?? undefined)).sort((a, b) => a.id.localeCompare(b.id));
  const quota = accountQuota(env);
  let at = from;
  let indexed = 0;
  for (let i = 0; i < INDEX_CHUNKS_A_RUN() && at < rows.length; i++) {
    const chunk = rows.slice(at, at + INDEX_CHUNK);
    const full = await quota.reserve({ do_rows_written: chunk.length * INDEX_ROWS, do_rows_read: chunk.length * 2 });
    if (full) {
      // The page shows indexing waiting until then; the next chunk clears it.
      await mailbox.indexWaiting(month, full.resumesAt, full.label);
      return { indexed, next: at, resumesAt: full.resumesAt };
    }
    let r;
    try {
      r = await mailbox.ingest(chunk.map(indexedFromBasin), false);
    } catch (e) {
      if (!isDailyLimit(e)) throw e;
      const resumesAt = nextReset().toISOString();
      // Past the daily limit this write fails too; the page then shows the month indexing.
      await mailbox.indexWaiting(month, resumesAt, 'DO rows written').catch(() => {});
      return { indexed, next: at, resumesAt };
    }
    await quota.add({ do_rows_written: r.rowsWritten, do_rows_read: chunk.length * 2 });
    indexed += r.added;
    at += chunk.length;
  }
  if (at < rows.length) return { indexed, next: at, resumesAt: null };
  const ids = new Set(rows.map((r) => r.id));
  // Counted against Gmail's list: mail Gmail no longer has stays indexed but isn't owed.
  const inBasin = listed ? [...listed].filter((id) => ids.has(id)).length : ids.size;
  console.log(JSON.stringify({ indexedMonth: { month, inBasin, rows: rows.length, listed: listed?.size ?? null } }));
  if (listed && inBasin < listed.size) await forgetMissing(env, user, account, month, [...listed].filter((id) => !ids.has(id)));
  await mailbox.markIndexed(month, inBasin);
  // Senders, domains and labels once backfill is done, not once a month.
  // (Senders, domains and labels left with no mail after unindexMonth keep their rows until mail returns.)
  // Once, when the last month is indexed: rebuilt after every month it rewrote each changed sender again.
  if (!(await mailbox.hasQueued()) && !(await mailbox.indexPending())) {
    const n = await mailbox.indexedCount();
    const full = await quota.reserve({ do_rows_read: n, do_rows_written: Math.ceil(n / 4) });
    if (!full) {
      const r = await mailbox.rebuildRollups();
      await quota.add({ do_rows_read: r.rowsRead, do_rows_written: r.rowsWritten });
      console.log(JSON.stringify({ rollups: r }));
    }
  }
  return { indexed, next: null, resumesAt: null };
}

/** Gmail list calls an index run may spend listing its month (500 IDs a call). */
const LIST_CALLS = () => (paidNow() ? 100 : 30);

/**
 * The IDs Gmail lists for a month, saved to R2 for the index runs after this one. Null when
 * Gmail didn't answer or the month is too big to list in one run: the month then counts its
 * own rows, as before.
 */
async function listMonth(env: Env, user: UserId, account: string, month: string): Promise<Set<string> | null> {
  try {
    const refreshToken = await env.MAILBOX.getByName(mailboxName(user)).accountToken(account);
    if (!refreshToken) return null;
    const token = await accessToken(env, refreshToken);
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let calls = 0; ; calls++) {
      if (calls === LIST_CALLS()) return null;
      const page = await listPage(token, pageToken, 500, monthQuery(month));
      ids.push(...page.ids);
      if (!page.next) break;
      pageToken = page.next;
    }
    await env.ARCHIVE.put(r2Keys.listed(user, account, month), JSON.stringify(ids));
    await accountQuota(env).charge({ classA: 1 });
    return new Set(ids);
  } catch (e) {
    if (!(e instanceof GmailError) && !retryable(e)) throw e;
    console.log(JSON.stringify({ listMonth: { month, error: String(e).slice(0, 160) } }));
    return null;
  }
}

async function readListed(env: Env, user: UserId, account: string, month: string): Promise<Set<string> | null> {
  const obj = await env.ARCHIVE.get(r2Keys.listed(user, account, month));
  return obj ? new Set((await obj.json()) as string[]) : null;
}

/**
 * Gmail lists these IDs for the month but Basin hasn't got them: take them out of the month's
 * landed-IDs file, so copying the month again fetches them.
 */
async function forgetMissing(env: Env, user: UserId, account: string, month: string, missing: string[]): Promise<void> {
  console.log(JSON.stringify({ monthGap: { account, month, missing } }));
  const key = r2Keys.copied(user, account, month);
  const obj = await env.ARCHIVE.get(key);
  if (!obj) return;
  const gone = new Set(missing);
  const ids = ((await obj.json()) as string[]).filter((id) => !gone.has(id));
  await env.ARCHIVE.put(key, JSON.stringify(ids));
}

/**
 * The search index against Gmail's month lists for a year: indexed messages no month of the year
 * lists (with their dates and labels), and listed messages the index lacks. Months with a saved
 * list use it; the rest are listed from Gmail now. Reads only.
 */
async function auditIndex(env: Env, user: UserId, account: string, year: string) {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`).filter((m) => m <= monthNow());
  const listed = new Map<string, string>();
  const live: string[] = [];
  for (const m of months) {
    const ids = (await readListed(env, user, account, m)) ?? (live.push(m), await listMonth(env, user, account, m));
    if (!ids) return { error: `couldn't list ${m}` };
    for (const id of ids) listed.set(id, m);
  }
  const mailbox = accountMailbox(env, user, account);
  const indexed = await mailbox.indexedIn(year);
  const have = new Set(indexed.map((r) => r.id));
  const month = (ts: number) => new Date(ts).toISOString().slice(0, 7);
  // Each month as the screens count it (census, counter, copied) beside what the index and Gmail hold.
  const counters = new Map(((await mailbox.archive('months')) as { month: string; n: number }[]).map((r) => [r.month, r.n]));
  const coverage = new Map((await mailbox.coverageMonths()).map((m) => [m.month, m]));
  const byMonth = months.map((m) => ({
    month: m,
    census: coverage.get(m)?.gmail ?? null,
    copied: coverage.get(m)?.copied ?? null,
    counter: counters.get(m) ?? 0,
    rows: indexed.filter((r) => month(r.ts) === m).length,
    listed: [...listed.values()].filter((l) => l === m).length,
  }));
  return {
    live,
    byMonth,
    listed: listed.size,
    indexed: indexed.length,
    notListed: indexed.filter((r) => !listed.has(r.id)).map((r) => ({ id: r.id, date: new Date(r.ts).toISOString(), labels: r.labels })),
    notIndexed: [...listed].filter(([id]) => !have.has(id)).map(([id, m]) => ({ id, month: m })),
    otherMonth: indexed.filter((r) => listed.has(r.id) && listed.get(r.id) !== month(r.ts)).map((r) => ({ id: r.id, date: new Date(r.ts).toISOString(), listedIn: listed.get(r.id) })),
  };
}

/** Outside requests a census run may make (one is the token refresh). */
export const CENSUS_CALLS = () => (paidNow() ? 400 : 40);
/** Months in a row with no mail, before the first month of Gmail, after which the census asks if anything is older. */
const EMPTY_STREAK = 12;

/** Start counting an account's mail by month, or resume a census that stopped part way. */
export async function startCensus(env: Env, user: UserId, account: string, mode: CensusState['mode']): Promise<string> {
  const mailbox = accountMailbox(env, user, account);
  const now = new Date().toISOString();
  const prev = await mailbox.censusState();
  const runId = `${account}-census-${Date.now().toString(36)}`;
  const resume = prev && prev.month !== null;
  const next: CensusState = resume
    ? { ...prev, runId, error: null, resumesAt: null, updatedAt: now }
    : { runId, month: monthNow(), pageToken: null, n: 0, empty: 0, mode, startedAt: now, updatedAt: now, finishedAt: null, error: null };
  await mailbox.saveCensus(next);
  await env.SYNC.create({ id: runId, params: { user, account, census: true } });
  return runId;
}

/**
 * One census run: count months, newest first, by listing message IDs (500 a call). A month
 * already counted after it ended can't change, so a full census skips it and a refresh stops there.
 */
export async function runCensus(env: Env, user: UserId, account: string, runId: string, budget = CENSUS_CALLS()): Promise<{ more: boolean; counted: string[] }> {
  const mailbox = accountMailbox(env, user, account);
  const c = await mailbox.censusState();
  if (!c || c.runId !== runId || c.month === null) return { more: false, counted: [] };
  const counted: string[] = [];
  const quota = accountQuota(env);
  const full = await quota.reserve({ do_rows_written: budget + 10, do_rows_read: budget * 2 });
  if (full) {
    const now = new Date().toISOString();
    await mailbox.saveCensus({ ...c, error: `Paused before the account's daily limit (${full.label}).`, resumesAt: full.resumesAt, updatedAt: now }, runId);
    return { more: false, counted };
  }
  const refreshToken = await env.MAILBOX.getByName(mailboxName(user)).accountToken(account);
  let calls = 1;
  try {
    if (!refreshToken) throw new GmailError(401, 'This account was removed from MailCellar.');
    const token = await accessToken(env, refreshToken);
    while (c.month !== null && calls < budget) {
      const month: string = c.month;
      let n: number | null = c.pageToken === null ? await mailbox.finalCount(month) : null;
      if (n !== null && c.mode === 'refresh') {
        c.month = null;
        break;
      }
      if (n === null) {
        const page = await listPage(token, c.pageToken || undefined, 500, monthQuery(month));
        calls++;
        c.n += page.ids.length;
        c.pageToken = page.next;
        if (page.next) continue;
        n = c.n;
        await mailbox.putMonthCount(month, n);
        counted.push(month);
      }
      c.n = 0;
      c.empty = n ? 0 : c.empty + 1;
      c.month = addMonths(month, -1);
      if (c.month < GMAIL_FIRST_MONTH && c.empty >= EMPTY_STREAK) {
        // Nothing for a year before Gmail began: done, unless Gmail has older mail (imported).
        const older = await listPage(token, undefined, 1, `before:${monthBounds(month).after}`);
        calls++;
        if (older.ids.length) c.empty = 0;
        else c.month = null;
      }
    }
  } catch (e) {
    if (!(e instanceof GmailError) && !retryable(e)) throw e;
    // The census resumes from here the next time the coverage map is opened.
    c.error = e instanceof GmailError && (e.status === 401 || e.status === 403) ? e.message : `Gmail didn't answer (${e instanceof GmailError ? `HTTP ${e.status}` : 'network'}).`;
  }
  await quota.add({ do_rows_written: counted.length * 2 + 2, do_rows_read: calls * 2 });
  const now = new Date().toISOString();
  if (c.month === null) c.finishedAt = now;
  if (!(await mailbox.saveCensus({ ...c, updatedAt: now }, runId))) return { more: false, counted };
  return { more: c.month !== null && !c.error, counted };
}

export class SyncWorkflow extends WorkflowEntrypoint<Env, SyncParams> {
  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep): Promise<unknown> {
    if (event.payload.check) return step.do('basin check', { retries: { limit: 0, delay: '1 second' } }, () => basinCheck(this.env));
    const { names } = event.payload;
    if (names) return step.do('names', () => accountQuota(this.env).setNames(names));
    const user = asUserId(event.payload.user);
    const { account, month } = event.payload;
    const runId = event.instanceId;
    if (event.payload.trial) {
      const trial = event.payload.trial;
      return step.do('trial', () => this.env.MAILBOX.getByName(mailboxName(user)).trial(account, trial, !!event.payload.park));
    }
    if (event.payload.missing) return step.do('queue missing months', () => this.env.MAILBOX.getByName(mailboxName(user)).backfillMissing(account));
    if (event.payload.pause) return step.do('pause', () => this.env.MAILBOX.getByName(mailboxName(user)).setBackfillPaused(true).then(() => true));
    if (event.payload.commit) {
      const r = await step.do('commit', { retries: { limit: 1, delay: '1 minute' }, timeout: '10 minutes' }, () => runCommit(this.env, user, account, runId));
      if (!r.more || !r.nextId) return r;
      if (r.waitMs) await step.sleep('wait for more staged rows', r.waitMs);
      await step.do('next run', () => syncDeps.launch(this.env, { user, account, commit: true }, r.nextId!));
      return r;
    }
    if (month) {
      // Each step is idempotent: a retried run that already saved hands over to the run it named.
      const r = await step.do('copy', { retries: { limit: 1, delay: '1 minute' }, timeout: '15 minutes' }, () => runLane(this.env, user, account, month, runId));
      if (!r.more || !r.nextId) return r;
      if (r.resumesAt) await step.sleepUntil('wait before trying again', new Date(r.resumesAt));
      await step.do('next run', () => syncDeps.launch(this.env, { user, account, month }, r.nextId!));
      return r;
    }
    if (event.payload.audit) {
      const year = event.payload.audit;
      return step.do('audit', { retries: { limit: 0, delay: '1 second' }, timeout: '10 minutes' }, () => auditIndex(this.env, user, account, year));
    }
    if (event.payload.index) {
      const index = event.payload.index;
      const from = event.payload.from ?? 0;
      if (event.payload.reindex && !from)
        console.log(JSON.stringify({ unindex: await step.do('unindex', () => accountMailbox(this.env, user, account).unindexMonth(index)) }));
      const r = await step.do('index', { retries: { limit: 1, delay: '1 minute' }, timeout: '10 minutes' }, () => runIndex(this.env, user, account, index, from));
      if (r.next === null) return r.indexed;
      if (r.resumesAt) await step.sleepUntil('wait for the daily limit', new Date(r.resumesAt));
      await step.do('next run', async () => {
        await syncDeps.launch(this.env, { user, account, index, from: r.next! }, `${account}-index-${index}-${Date.now().toString(36)}`);
      });
      return r.indexed;
    }
    if (event.payload.census) {
      const counted = await step.do('count', { retries: { limit: 1, delay: '1 minute' }, timeout: '10 minutes' }, () => runCensus(this.env, user, account, runId));
      if (counted.more)
        await step.do('next run', async () => {
          const mailbox = accountMailbox(this.env, user, account);
          const c = await mailbox.censusState();
          if (!c || c.runId !== runId) return null;
          const nextId = `${account}-census-${Date.now().toString(36)}`;
          if (!(await mailbox.saveCensus({ ...c, runId: nextId }, runId))) return null;
          await mailbox.launchLater(nextId, { user, account, census: true });
          return nextId;
        });
      return counted;
    }
    // Each step is idempotent: R2 writes overwrite and the index skips messages it has.
    // Gmail and the daily limit are handled inside the step (a fresh run retries them, with a
    // fresh request budget); a retry here is for anything unexpected.
    const result = await step.do('copy', { retries: { limit: 1, delay: '1 minute' }, timeout: '15 minutes' }, () => runBatch(this.env, user, account, runId));
    if (!result.more) return result;
    if (result.resumesAt) await step.sleepUntil('wait before trying again', new Date(result.resumesAt));
    // Hand over to a fresh run, so the next batch gets its own request budget.
    await step.do('next run', async () => {
      const mailbox = accountMailbox(this.env, user, account);
      const state = await mailbox.syncState();
      if (!state || state.runId !== runId) return null;
      const nextId = `${account}-${Date.now().toString(36)}`;
      await mailbox.saveSync({ ...state, runId: nextId, phase: resumePhase(state), resumesAt: null }, runId, { copied: 0, bytes: 0 });
      await mailbox.launchLater(nextId, { user, account });
      return nextId;
    });
    return result;
  }
}
