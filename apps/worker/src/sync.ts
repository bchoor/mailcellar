// The sync Workflow: copies new mail of one Gmail account into MailCellar, 500 messages a run,
// and routes the other runs: backfill lanes and the committer that lands months (copy.ts), index checks,
// the census.
// Spike S7 found that a Workflow run is one Worker invocation, so Workers Free's caps of
// 50 outside requests and 1,000 Cloudflare calls cover the whole run. A run therefore does
// one batch and then starts the next run, until the account is copied.
// Raw mail goes to raw files (gzipped up to 256 KB, spike S3) and each message's row, with
// where its raw bytes are, straight to the account's DO: the mailbox is the record (2026-10-25).
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { addMonths, asUserId, GMAIL_FIRST_MONTH, mailboxName, monthBounds, monthNow, monthQuery, r2Keys, type CensusState, type IndexedMessage, type SyncParams, type SyncState, type UserId, withRecent, MAX_LANES, paidNow, SYNC_STALE_MS, type JobBy } from '@mailcellar/schema';
import type { Env } from './env';
import { measured, meteredEnv } from './telemetry';
import { accountQuota, type QuotaUse } from './quota';
import { runCommit, runLane } from './copy';
import { runImport } from './import';
import { runAttachments } from './attachments';
import { runBodies, runRecipients } from './bodies';
import { BATCH_SIZE, b64urlBytes, batchGet, addedSince, GmailError, indexRow, labels, listPage, packBySize, profile, type RawMessage } from './gmail';

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

/** What a full run may use, asked of the account's meters before it starts (with its DO rows). */
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
  throw new GmailError(body.error === 'invalid_grant' ? 401 : res.status, `Google no longer accepts this account (${body.error ?? `HTTP ${res.status}`}). Reconnect it in Settings ▸ Accounts.`);
}

/** Gzipped JSON: rows the live sync staged for Basin before 2026-10-25. */
async function gunzipJson<T>(body: ReadableStream): Promise<T> {
  return (await new Response(body.pipeThrough(new DecompressionStream('gzip'))).json()) as T;
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

/**
 * Start (or restart) syncing an account. The new run takes over: a run already going finds
 * another run ID in the sync state and stops at its next save. With `by`, it opens a sync job
 * (the history's entry), unless one is open still; without, it carries on the open one.
 */
export async function startSync(env: Env, user: UserId, account: string, by?: JobBy): Promise<string> {
  const mailbox = accountMailbox(env, user, account);
  const now = new Date().toISOString();
  const state: SyncState = (await mailbox.syncState()) ?? {
    phase: 'backfill', runId: '', total: null, copied: 0, bytes: 0, pending: [], pageToken: null, historyId: null,
    basinQueue: [], basinReady: false, startedAt: now, updatedAt: now, resumesAt: null, error: null, part: null,
  };
  // Months waiting in a backfill take a live sync back to backfilling.
  const phase = resumePhase(state) === 'live' && (await mailbox.hasQueued()) ? 'backfill' : resumePhase(state);
  const runId = `${account}-${Date.now().toString(36)}`;
  const open = state.run && Date.now() - Date.parse(state.updatedAt) < SYNC_STALE_MS ? state.run : null;
  const run = open ?? (by ? { startedAt: now, by, copied: 0, bytes: 0 } : null);
  await mailbox.saveSync({ ...state, runId, phase, error: null, resumesAt: null, updatedAt: now, run });
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
}

/** How a sync starts, and how a run's Workflow stands. Tests swap in stand-ins. */
export const syncDeps: {
  runStatus: (env: Env, runId: string) => Promise<string | null>;
  start: (env: Env, user: UserId, account: string, by?: JobBy) => Promise<string>;
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
  start: (env, user, account, by) => startSync(env, user, account, by),
  census: (env, user, account, mode) => startCensus(env, user, account, mode),
  // From the account's alarm, not from the caller: a run started by a run counts as nested in it (MailboxDO.launchLater).
  launch: (env, params, id) => accountMailbox(env, asUserId(params.user), params.account).launchLater(id, params),
};

/** What a run may add to the backfill's spend, checked against the cap before it starts: RUN_SIZE messages of up to 100 KB. */
export const RUN_SPEND = { classA: RUN_COST.r2_class_a!, classB: RUN_COST.r2_class_b!, bytes: RUN_SIZE * 100 * 1024 };

/** A row the live sync staged before 2026-10-25 (gzipped JSON in its queue), with the columns indexing reads. */
interface StagedRow {
  id: string;
  thread_id: string;
  ts: string;
  from_addr: string;
  from_name: string;
  subject: string;
  snippet: string;
  size: number;
  attachments: number;
  labels: string[];
  raw_key?: string;
  raw_offset?: number | null;
  raw_len?: number | null;
}

/** The mailbox's row for a staged row. */
function indexedFromStaged(r: StagedRow): IndexedMessage {
  return {
    id: r.id, threadId: r.thread_id, ts: Date.parse(r.ts), fromAddr: r.from_addr, fromName: r.from_name,
    subject: r.subject, snippet: r.snippet, size: Number(r.size), attachments: Number(r.attachments), labels: r.labels,
    ...(r.raw_key ? { raw: r.raw_key } : {}), ...(r.raw_offset != null ? { rawOffset: Number(r.raw_offset) } : {}), ...(r.raw_len != null ? { rawLen: Number(r.raw_len) } : {}),
  };
}

/** The mailbox's row for a copied message, with where its raw bytes are (offset and length in a pack). */
export function copiedRow(m: RawMessage, raw: Uint8Array, rawKey: string, at?: { offset: number; len: number }): IndexedMessage {
  return { ...indexRow(m, raw), raw: rawKey, ...(at ? { rawOffset: at.offset, rawLen: at.len } : {}) };
}

/**
 * Start lanes for queued backfill months, up to MAX_LANES at once, and restart lanes that
 * stopped. Each lane copies one month to raw files and the mailbox (copy.ts), then takes the next queued month.
 */
export async function launchLanes(env: Env, user: UserId, account: string): Promise<number> {
  if (await env.MAILBOX.getByName(mailboxName(user)).backfillPaused()) return 0;
  const lanes = await accountMailbox(env, user, account).claimLanes(user, account, MAX_LANES);
  for (const l of lanes) await syncDeps.launch(env, { user, account, month: l.month }, l.runId);
  return lanes.length;
}

/**
 * One run of the account's own sync: new mail since the last run, and it hands queued backfill
 * months to lanes (copy.ts). Mail goes to raw files and its rows straight into the mailbox.
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
  // Months whose Gmail list this run fetched again, with their IDs.
  const relisted = new Map<string, string[]>();
  const save = (next: SyncState) => mailbox.saveSync({ ...next, updatedAt: new Date().toISOString() }, runId, added);
  // What the sync job is doing, for the Sync card: kept in the mailbox's memory, never written.
  const step = (text: string) => mailbox.runStep(runId, text);
  // A stop fails the month being copied; Retry copies it again (copied mail is skipped).
  const stop = async (error: string): Promise<RunResult> => {
    const part = state.part;
    if (!(await save({ ...state, phase: 'error', error, part: null, pending: [], pageToken: part ? null : state.pageToken }))) return replaced;
    if (part) await mailbox.finishPart(part, 'failed', error);
    await mailbox.endRun(runId, 'failed', error);
    return { copied: 0, phase: 'error', more: false, resumesAt: null };
  };
  // Stop for now and let a fresh run try again: same as the daily limit, with another reason.
  const later = async (resumesAt: Date, phase: SyncState['phase'], error: string | null, why: string): Promise<RunResult> => {
    if (!(await save({ ...state, phase, resumesAt: resumesAt.toISOString(), error }))) return replaced;
    await step(why);
    return { copied: 0, phase, more: true, resumesAt: resumesAt.toISOString() };
  };

  const owner = env.MAILBOX.getByName(mailboxName(user));
  // Paused by the person: stop without saving. A lane keeps where it stood; resuming picks it up.
  if (await owner.backfillPaused()) {
    await mailbox.endRun(runId, 'stopped', 'Backfill is paused.');
    return { copied: 0, phase: state.phase, more: false, resumesAt: null };
  }
  await step('Checking Gmail for new mail');
  const refreshToken = await owner.accountToken(account);
  if (!refreshToken) return stop('This account was removed from MailCellar.');

  // The account's daily limits are shared by every user: pause before one, resume after it resets.
  const quota = accountQuota(env);
  // The run indexes what it copies, so it waits for the DO's daily writes too.
  const full = await quota.reserve({ ...RUN_COST, do_rows_written: RUN_SIZE * INDEX_ROWS });
  if (full) {
    state.pausedFor = full.label;
    return later(new Date(full.resumesAt), 'waiting', null, `Waiting for the daily limit (${full.label})`);
  }
  state.pausedFor = null;
  // The spend cap: a run that could pass it pauses all backfill instead (Bikram's $1.10, 2026-10-24).
  if (await quota.overBudget(RUN_SPEND)) {
    await owner.setBackfillPaused(true, true);
    await mailbox.endRun(runId, 'stopped', 'Stopped at the backfill spend cap.');
    return { copied: 0, phase: state.phase, more: false, resumesAt: null };
  }
  let r2a = 0;
  let r2b = 0;
  let rowsRead = 0;

  const rows: IndexedMessage[] = [];
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
        await step('Starting queued backfill months');
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
    const take = state.pending.slice(0, RUN_SIZE);
    rest = state.pending.slice(take.length);
    await step(take.length ? `Copying ${take.length.toLocaleString('en-US')} new message${take.length === 1 ? '' : 's'}` : 'No new mail');
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
      if (calls >= limits.calls) {
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
        rows.push(copiedRow(m, raw, rawKey));
        added.copied++;
        added.bytes += m.sizeEstimate;
      }
    }
    // Gmail's count of a month goes stale as new mail lands in it: count the months it landed in again.
    const landed = new Set(rows.map((r) => new Date(r.ts).toISOString().slice(0, 7)).filter((m) => m >= addMonths(monthNow(), -1)));
    for (const month of landed) {
      if (calls + LIST_CALLS() > limits.calls) break;
      await step(`Recounting ${new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })} in Gmail`);
      const ids: string[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < LIST_CALLS(); page++) {
        calls++;
        const got = await listPage(token, pageToken, 500, monthQuery(month));
        ids.push(...got.ids);
        pageToken = got.next ?? undefined;
        if (!pageToken) break;
      }
      if (!pageToken) {
        await mailbox.putMonthCount(month, ids.length);
        relisted.set(month, ids);
      }
    }
  } catch (e) {
    // Mail fetched before the error isn't indexed, so it isn't counted; the next run copies it again.
    Object.assign(added, { copied: 0, bytes: 0 });
    if (e instanceof GmailError && (e.status === 401 || e.status === 403)) return stop(e.message);
    if (!retryable(e)) throw e;
    const why = `Gmail didn't answer (${e instanceof GmailError ? `HTTP ${e.status}` : 'network'})`;
    return later(new Date(Date.now() + 5 * 60_000), state.phase, `${why}. Trying again shortly.`, `${why}. Trying again in 5 min`);
  }

  // Index what this run copied, with where each message is. Rows staged for Basin before
  // 2026-10-25 go in first, then their staged files are deleted.
  let indexError: string | null = null;
  let rowsWritten = 0;
  try {
    const queued: IndexedMessage[] = [];
    const drained = state.basinQueue.slice(0, 4);
    for (const key of drained) {
      r2b++;
      const obj = await env.ARCHIVE.get(key);
      if (obj) queued.push(...(await gunzipJson<StagedRow[]>(obj.body)).map(indexedFromStaged));
    }
    const batch = [...queued, ...rows];
    if (batch.length) {
      await step('Making new mail searchable');
      rowsWritten = (await mailbox.ingest(batch)).rowsWritten;
    }
    if (drained.length) {
      await env.ARCHIVE.delete(drained);
      state.basinQueue = state.basinQueue.slice(drained.length);
    }
  } catch (e) {
    if (!isDailyLimit(e)) throw e;
    // Past the daily limit: what this run copied is copied again by a run after the reset.
    rest = [...rows.map((r) => r.id), ...rest];
    Object.assign(added, { copied: 0, bytes: 0 });
    indexError = 'Paused before the daily DO write limit. Copying resumes after it resets.';
  }
  // Copied counts against the list Gmail just gave, not by message date: a message dated the
  // last day of a month that Gmail files in the next one left one month a message short.
  if (!indexError)
    for (const [month, ids] of relisted) {
      const { have } = await mailbox.monthHas(month, ids);
      await mailbox.markIndexed(month, have);
    }
  // Sync-state saves and month bookkeeping: a few rows each run.
  await quota.add({ do_rows_written: rowsWritten + 6, do_rows_read: rowsRead + rowsWritten * 2 + 20, r2_class_a: r2a, r2_class_b: r2b });
  // Raw mail counts at Gmail's size (gzip only makes it smaller).
  await quota.charge({ classA: r2a, classB: r2b, bytes: added.bytes });

  const next: SyncState = { ...state, pending: rest, copied: state.copied + added.copied, bytes: state.bytes + added.bytes, resumesAt: null, error: indexError };
  if (indexError) next.resumesAt = nextReset().toISOString();

  if (!(await save(next))) return replaced;
  const more = rest.length > 0 || next.basinQueue.length > 0;
  if (!more) await mailbox.endRun(runId, 'done', null);
  else if (indexError) await step('Waiting for the daily DO write limit');
  return { copied: added.copied, phase: next.phase, more, resumesAt: next.resumesAt };
}

/** Index rows a chunk takes, for the daily-limit check the Backfill page makes while months wait (mailbox.ts). */
export const INDEX_CHUNK = 500;

/**
 * Finish a landed month: copying indexed its messages as it went, so this checks the mailbox
 * against Gmail's list of the month, forgets what's missing (copying the month again fetches
 * it), and marks the month done. Once no month is left, senders, domains and labels are
 * counted again. Returns as the old index build did, so callers keep working.
 */
export async function runIndex(env: Env, user: UserId, account: string, month: string, _from = 0): Promise<{ indexed: number; next: number | null; resumesAt: string | null }> {
  const mailbox = accountMailbox(env, user, account);
  await mailbox.indexStarted(month);
  // The Sender and Size sort indexes first, so each message is indexed once with all of them.
  await mailbox.buildSorts();
  // Gmail's month decides what the month holds; an archive's month counts its own rows.
  const listed = await listMonth(env, user, account, month);
  const { have, missing } = await mailbox.monthHas(month, listed ? [...listed] : null);
  console.log(JSON.stringify({ indexedMonth: { month, have, listed: listed?.size ?? null, missing: missing.length } }));
  if (missing.length) await forgetMissing(env, user, account, month, missing);
  await mailbox.markIndexed(month, have);
  const quota = accountQuota(env);
  // Senders, domains and labels once backfill is done, not once a month.
  if (!(await mailbox.hasQueued()) && !(await mailbox.indexPending())) {
    const n = await mailbox.indexedCount();
    const full = await quota.reserve({ do_rows_read: n, do_rows_written: Math.ceil(n / 4) });
    if (!full) {
      const r = await mailbox.rebuildRollups();
      await quota.add({ do_rows_read: r.rowsRead, do_rows_written: r.rowsWritten });
      console.log(JSON.stringify({ rollups: r }));
    }
  }
  return { indexed: have, next: null, resumesAt: null };
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
 * Gmail lists these IDs for the month but the mailbox hasn't got them: take them out of the month's
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

/** The steps of a run, each one writing its time and use to telemetry, named by the step. */
function measuredSteps(env: Env, step: WorkflowStep): WorkflowStep {
  return new Proxy(step, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== 'do' || typeof v !== 'function') return typeof v === 'function' ? v.bind(target) : v;
      return (name: string, ...rest: unknown[]) => {
        const callback = rest.pop() as () => Promise<unknown>;
        return (v as (...a: unknown[]) => unknown).call(target, name, ...rest, () => measured(env, 'workflow', name, callback));
      };
    },
  });
}

export class SyncWorkflow extends WorkflowEntrypoint<Env, SyncParams> {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, meteredEnv(env));
  }

  /** Start the attachment pass for mail copied since attachment search; its own runs, so a slow file never holds the sync. */
  private async startAttachments(user: UserId, account: string): Promise<string | null> {
    if (!(await accountMailbox(this.env, user, account).attachTodo(1, 'new')).length) return null;
    const id = `${account}-attach-${Date.now().toString(36)}`;
    await syncDeps.launch(this.env, { user, account, attachments: 'new' }, id);
    return id;
  }

  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep): Promise<unknown> {
    step = measuredSteps(this.env, step);
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
      if (r.waitMs) await step.sleep('wait for months to land', r.waitMs);
      await step.do('next run', () => syncDeps.launch(this.env, { user, account, commit: true }, r.nextId!));
      return r;
    }
    if (event.payload.sizes) return step.do('sizes', () => accountMailbox(this.env, user, account).storageSizes());
    if (event.payload.bodies) {
      // The body pass (bodies.ts): each run moves the mailbox's bookmark and names the next.
      const r = await step.do('bodies', { retries: { limit: 1, delay: '1 minute' }, timeout: '15 minutes' }, () => runBodies(this.env, user, account, runId));
      if (!r.nextId) return r;
      if (r.resumesAt) await step.sleepUntil('wait for the daily guard', new Date(r.resumesAt));
      await step.do('next run', () => syncDeps.launch(this.env, { user, account, bodies: true }, r.nextId!));
      return r;
    }
    if (event.payload.attachments) {
      // The attachment pass (attachments.ts): runs chain like the body pass's, each taking the next unread mail.
      const scope = event.payload.attachments;
      const r = await step.do('attachments', { retries: { limit: 1, delay: '1 minute' }, timeout: '15 minutes' }, () => runAttachments(this.env, user, account, runId, scope));
      if (!r.nextId) return r;
      if (r.resumesAt) await step.sleepUntil('wait for the daily guard', new Date(r.resumesAt));
      await step.do('next run', () => syncDeps.launch(this.env, { user, account, attachments: scope }, r.nextId!));
      return r;
    }
    if (event.payload.recipients) {
      // The recipients pass (bodies.ts): runs chain like the body pass's.
      const r = await step.do('recipients', { retries: { limit: 1, delay: '1 minute' }, timeout: '15 minutes' }, () => runRecipients(this.env, user, account, runId));
      if (!r.nextId) return r;
      if (r.resumesAt) await step.sleepUntil('wait for the daily guard', new Date(r.resumesAt));
      await step.do('next run', () => syncDeps.launch(this.env, { user, account, recipients: true }, r.nextId!));
      return r;
    }
    if (event.payload.import) {
      // An archive's import: each run saves its progress to a raw file and names the next run.
      const r = await step.do('import', { retries: { limit: 1, delay: '1 minute' }, timeout: '15 minutes' }, () => runImport(this.env, user, account, runId));
      // Once imported, the archive's attachments go in search.
      if (!r.nextId && r.phase === 'done') await step.do('attachments', () => this.startAttachments(user, account));
      if (!r.nextId) return r;
      if (r.resumesAt) await step.sleepUntil('wait before trying again', new Date(r.resumesAt));
      await step.do('next run', () => syncDeps.launch(this.env, { user, account, import: true }, r.nextId!));
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
      return (await step.do('index', { retries: { limit: 1, delay: '1 minute' }, timeout: '10 minutes' }, () => runIndex(this.env, user, account, index))).indexed;
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
    if (!result.more) {
      // New mail is in: its attachments (and backfill's since the last sync) go in search, in a run of their own.
      if (result.phase !== 'error' && result.phase !== 'replaced') await step.do('attachments', () => this.startAttachments(user, account));
      return result;
    }
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
