// The sync Workflow: copies one Gmail account into MailCellar, 500 messages a run.
// Spike S7 found that a Workflow run is one Worker invocation, so Workers Free's caps of
// 50 outside requests and 1,000 Cloudflare calls cover the whole run. A run therefore does
// one batch and then starts the next run, until the account is copied.
// Raw mail goes to R2 (gzipped up to 256 KB, spike S3), the index to the account's DO, and
// every message's row to Basin, the system of record. Basin rows are staged in R2 first, so
// a failed commit is retried by the next run instead of losing the batch.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { addMonths, asUserId, GMAIL_FIRST_MONTH, mailboxName, monthBounds, monthNow, monthQuery, r2Keys, type CensusState, type IndexedMessage, type SyncParams, type SyncState, type UserId } from '@mailcellar/schema';
import { basinCheck, catalogTarget, COMMIT_CALLS, type BasinRow, type BasinTarget } from './basin';
import type { Env } from './env';
import { accountQuota, type QuotaUse } from './quota';
import { BATCH_SIZE, b64urlBytes, batchGet, addedSince, bodyText, GmailError, headers, indexRow, labels, listPage, packBySize, parseAddresses, profile, type RawMessage } from './gmail';

/** Messages one run copies: about 510 R2 and DO calls, well inside the cap of 1,000. */
export const RUN_SIZE = 500;
/** Outside requests a run may make; Workers Free stops a run at 50 (spike S7). */
export const RUN_CALLS = 45;
/** Raw mail fetched in one Gmail batch, as Gmail sizes it: keeps the answer well inside 128 MB. */
export const BATCH_BYTES = 8 * 1024 * 1024;
/** Messages up to this size are gzipped; larger ones are mostly already-compressed attachments. */
export const GZIP_MAX = 256 * 1024;
/**
 * CPU a run may spend copying, in ms. Workers Free stopped a run at about 2 s of CPU on
 * 2026-10-24 (the spike's 1.9 s had passed), so a run stays at a quarter of that and the
 * next run copies the rest. Workers can't read their own CPU time, so it is estimated.
 */
export const RUN_CPU_MS = 500;
/**
 * Estimated CPU to copy one message, from spike S3: decoding and reading it (0.01 ms a KB),
 * gzip (0.03 ms a KB, small mail only), its Basin row (body text up to 32 KB staged, read back
 * and written as Parquet: 0.05 ms a KB) and a fixed 0.5 ms for the index row and calls.
 */
export function messageCpuMs(size: number): number {
  const kb = size / 1024;
  return 0.5 + kb * 0.01 + (size <= GZIP_MAX ? kb * 0.03 : 0) + Math.min(kb, 32) * 0.05;
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
/** What a full run may use, asked of the account's meters before it starts: about 6 DO rows a message (spike S4). */
export const RUN_COST: QuotaUse = { do_rows_written: RUN_SIZE * 6 + 50, do_rows_read: RUN_SIZE * 4, r2_class_a: RUN_SIZE + 30, r2_class_b: 50 };
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

async function accessToken(env: Env, refreshToken: string): Promise<string> {
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
function basinRow(account: string, m: RawMessage, raw: Uint8Array, row: IndexedMessage, rawKey: string, syncedAt: string): BasinRow {
  const h = headers(raw);
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
  s.phase === 'paused' || s.phase === 'error'
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
};

export async function runBatch(
  env: Env,
  user: UserId,
  account: string,
  runId: string,
  limits: RunOptions = { calls: RUN_CALLS, batchBytes: BATCH_BYTES },
): Promise<RunResult> {
  const mailbox = accountMailbox(env, user, account);
  const state = await mailbox.syncState();
  const replaced: RunResult = { copied: 0, phase: 'replaced', more: false, resumesAt: null };
  if (!state || state.runId !== runId) return replaced;
  const save = (next: SyncState) => mailbox.saveSync({ ...next, updatedAt: new Date().toISOString() }, runId);
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

  const refreshToken = await env.MAILBOX.getByName(mailboxName(user)).accountToken(account);
  if (!refreshToken) return stop('This account was removed from MailCellar.');

  // The account's daily limits are shared by every user: pause before one, resume after it resets.
  const quota = accountQuota(env);
  const full = await quota.reserve(RUN_COST);
  if (full) {
    state.pausedFor = full.label;
    return later(new Date(full.resumesAt), 'paused', null);
  }
  state.pausedFor = null;
  let r2a = 0;
  let r2b = 0;

  const rows: IndexedMessage[] = [];
  const basin: BasinRow[] = [];
  const syncedAt = new Date().toISOString();
  let bytes = 0;
  let rest: string[];
  let calls = 1; // the token refresh
  try {
    const token = await accessToken(env, refreshToken);
    // First run: how much there is, where new mail starts, and the label names. What to copy
    // comes from backfill jobs (or, for a sync started before jobs, the all-mail listing).
    if (state.historyId === null) {
      const p = await profile(token);
      await mailbox.putLabels(await labels(token));
      calls += 2;
      state.total = p.messagesTotal;
      state.historyId = p.historyId;
    }
    // A month whose backfill was canceled is dropped, with what was listed of it.
    if (state.part && (await mailbox.partState(state.part)) !== 'running') {
      state.part = null;
      state.pending = [];
      state.pageToken = null;
    }
    if (state.phase === 'live' && !state.pending.length && (await mailbox.hasQueued())) state.phase = 'backfill';
    if (!state.pending.length) {
      if (state.phase === 'backfill') {
        if (!state.part && state.pageToken === null) {
          state.part = await mailbox.nextPart();
          if (state.part) state.pageToken = '';
        }
        if (state.pageToken !== null) {
          const page = await listPage(token, state.pageToken || undefined, 500, state.part ? monthQuery(state.part.month) : undefined);
          calls++;
          state.pending = page.ids;
          state.pageToken = page.next;
        }
      } else if (state.phase === 'live') {
        const added = await addedSince(token, state.historyId!);
        state.pending = added.ids;
        state.historyId = added.historyId;
        calls += added.calls;
      }
    }
    // Basin is behind: this run only commits what's staged, so its CPU stays in budget.
    const take = state.basinQueue.length ? [] : state.pending.slice(0, RUN_SIZE);
    rest = state.pending.slice(take.length);
    // Sizes first (format=minimal), so raw batches can be packed to fit in memory.
    const sized = [];
    for (let i = 0; i < take.length; i += BATCH_SIZE) {
      // Gmail allows 250 quota units a second per user; a batch of 50 gets costs 250.
      if (calls) await scheduler.wait(1000);
      calls++;
      const { messages, retry } = await batchGet(token, take.slice(i, i + BATCH_SIZE), 'minimal');
      sized.push(...messages);
      rest.push(...retry);
    }
    // Keep the run's CPU in budget: what doesn't fit goes to the next run.
    const budget = limits.cpuMs ?? RUN_CPU_MS;
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
        const row = indexRow(m, raw);
        rows.push(row);
        basin.push(basinRow(account, m, raw, row, rawKey, syncedAt));
        bytes += m.sizeEstimate;
      }
    }
  } catch (e) {
    if (e instanceof GmailError && (e.status === 401 || e.status === 403)) return stop(e.message);
    if (!retryable(e)) throw e;
    return later(new Date(Date.now() + 5 * 60_000), state.phase, `Gmail didn't answer (${e instanceof GmailError ? `HTTP ${e.status}` : 'network'}). Trying again shortly.`);
  }

  let copied = 0;
  let addedIds: string[] = [];
  let rowsWritten = 0;
  try {
    if (rows.length) ({ added: copied, addedIds, rowsWritten } = await mailbox.ingest(rows));
  } catch (e) {
    if (!isDailyLimit(e)) throw e;
    return later(nextReset(), 'paused', null);
  }

  // Stage this batch's new rows for Basin, then commit everything staged. Only rows the index
  // just added are staged, so a message copied twice never becomes two rows.
  const fresh = new Set(addedIds);
  const staged = basin.filter((r) => fresh.has(r.id));
  if (staged.length) {
    const key = r2Keys.basinQueue(user, account, `${runId}-${Date.now().toString(36)}`);
    r2a++;
    await env.ARCHIVE.put(key, await gzipJson(staged));
    state.basinQueue = [...state.basinQueue, key];
  }
  let basinError: string | null = null;
  if (state.basinQueue.length) {
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
      await target.append(queued);
      // A Basin commit writes data and metadata files through the catalog: about 10 R2 writes.
      r2a += 10 + commit.length;
      await env.ARCHIVE.delete(commit);
      state.basinQueue = state.basinQueue.slice(commit.length);
    } catch (e) {
      // The rows stay staged; the next run commits them.
      basinError = `Basin didn't take this batch (${String(e).slice(0, 120)}). Retrying with the next batch.`;
    }
  }

  // A month is done once it is listed to the end and all of it copied; then the next month starts.
  if (state.part && state.pageToken === null && !rest.length) {
    await mailbox.finishPart(state.part, 'done');
    state.part = await mailbox.nextPart();
    if (state.part) state.pageToken = '';
  }
  const backfillDone = state.phase === 'backfill' && !state.part && state.pageToken === null && !rest.length;
  const next: SyncState = {
    ...state,
    phase: backfillDone ? 'live' : state.phase,
    pending: rest,
    copied: state.copied + copied,
    bytes: state.bytes + bytes,
    resumesAt: null,
    error: basinError,
  };
  // A Basin failure waits 5 minutes, so a run that can't commit doesn't start the next at once.
  if (basinError) next.resumesAt = new Date(Date.now() + 5 * 60_000).toISOString();
  // Months queued while new mail was being copied: back to the backfill.
  const requeued = next.phase === 'live' && !rest.length && (await mailbox.hasQueued());
  if (requeued) next.phase = 'backfill';
  // Sync-state saves and month bookkeeping: a few rows each run.
  await quota.add({ do_rows_written: rowsWritten + 6, do_rows_read: rowsWritten * 2 + 20, r2_class_a: r2a, r2_class_b: r2b });
  if (!(await save(next))) return replaced;
  const more = requeued || rest.length > 0 || (next.phase === 'backfill' && next.pageToken !== null) || next.basinQueue.length > 0;
  return { copied, phase: next.phase, more, resumesAt: next.resumesAt };
}

/** Outside requests a census run may make (one is the token refresh). */
export const CENSUS_CALLS = 40;
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
export async function runCensus(env: Env, user: UserId, account: string, runId: string, budget = CENSUS_CALLS): Promise<{ more: boolean; counted: string[] }> {
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
  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep): Promise<RunResult | number | Awaited<ReturnType<typeof basinCheck>> | Awaited<ReturnType<typeof runCensus>>> {
    if (event.payload.check) return step.do('basin check', { retries: { limit: 0, delay: '1 second' } }, () => basinCheck(this.env));
    const { names } = event.payload;
    if (names) return step.do('names', () => accountQuota(this.env).setNames(names));
    const user = asUserId(event.payload.user);
    const { account } = event.payload;
    const runId = event.instanceId;
    if (event.payload.census) {
      const counted = await step.do('count', { retries: { limit: 1, delay: '1 minute' }, timeout: '10 minutes' }, () => runCensus(this.env, user, account, runId));
      if (counted.more)
        await step.do('next run', async () => {
          const mailbox = accountMailbox(this.env, user, account);
          const c = await mailbox.censusState();
          if (!c || c.runId !== runId) return null;
          const nextId = `${account}-census-${Date.now().toString(36)}`;
          if (!(await mailbox.saveCensus({ ...c, runId: nextId }, runId))) return null;
          await this.env.SYNC.create({ id: nextId, params: { user, account, census: true } });
          return nextId;
        });
      return counted;
    }
    // Each step is idempotent: R2 writes overwrite and the index skips messages it has.
    // Gmail and the daily limit are handled inside the step (a fresh run retries them, with a
    // fresh request budget); a retry here is for anything unexpected.
    const result = await step.do('copy', { retries: { limit: 1, delay: '1 minute' }, timeout: '15 minutes' }, () =>
      runBatch(this.env, user, account, runId),
    );
    if (!result.more) return result;
    if (result.resumesAt) await step.sleepUntil('wait before trying again', new Date(result.resumesAt));
    // Hand over to a fresh run, so the next batch gets its own request budget.
    await step.do('next run', async () => {
      const mailbox = accountMailbox(this.env, user, account);
      const state = await mailbox.syncState();
      if (!state || state.runId !== runId) return null;
      const nextId = `${account}-${Date.now().toString(36)}`;
      await mailbox.saveSync({ ...state, runId: nextId, phase: resumePhase(state), resumesAt: null }, runId);
      await this.env.SYNC.create({ id: nextId, params: { user, account } });
      return nextId;
    });
    return result;
  }
}
