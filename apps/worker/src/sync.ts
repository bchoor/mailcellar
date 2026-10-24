// The sync Workflow: copies one Gmail account into MailCellar, 500 messages a run.
// Spike S7 found that a Workflow run is one Worker invocation, so Workers Free's caps of
// 50 outside requests and 1,000 Cloudflare calls cover the whole run. A run therefore does
// one batch and then starts the next run, until the account is copied.
// Raw mail goes to R2 (gzipped up to 256 KB, spike S3), the index to the account's DO, and
// every message's row to Basin, the system of record. Basin rows are staged in R2 first, so
// a failed commit is retried by the next run instead of losing the batch.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { asUserId, mailboxName, r2Keys, type IndexedMessage, type SyncParams, type SyncState, type UserId } from '@mailcellar/schema';
import { catalogTarget, COMMIT_CALLS, type BasinRow, type BasinTarget } from './basin';
import type { Env } from './env';
import { BATCH_SIZE, b64urlBytes, batchGet, addedSince, bodyText, GmailError, headers, indexRow, labels, listPage, packBySize, parseAddresses, profile, type RawMessage } from './gmail';

/** Messages one run copies: about 510 R2 and DO calls, well inside the cap of 1,000. */
export const RUN_SIZE = 500;
/** Outside requests a run may make; Workers Free stops a run at 50 (spike S7). */
export const RUN_CALLS = 45;
/** Raw mail fetched in one Gmail batch, as Gmail sizes it: keeps the answer well inside 128 MB. */
export const BATCH_BYTES = 8 * 1024 * 1024;
/** Messages up to this size are gzipped; larger ones are mostly already-compressed attachments. */
export const GZIP_MAX = 256 * 1024;
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

/** The phase a stopped sync resumes in: back to the listing, or on to new mail. */
const resumePhase = (s: SyncState): SyncState['phase'] =>
  s.phase === 'paused' || s.phase === 'error' ? (s.pageToken !== null || s.pending.length || s.historyId === null ? 'backfill' : 'live') : s.phase;

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
    basinQueue: [], basinReady: false, startedAt: now, updatedAt: now, resumesAt: null, error: null,
  };
  const runId = `${account}-${Date.now().toString(36)}`;
  await mailbox.saveSync({ ...state, runId, phase: resumePhase(state), error: null, resumesAt: null, updatedAt: now });
  await env.SYNC.create({ id: runId, params: { user, account } });
  return runId;
}

/** A Gmail answer worth trying again later: rate limits, Google's errors, the network. */
const retryable = (e: unknown) => (e instanceof GmailError && (e.status === 429 || e.status >= 500)) || e instanceof TypeError;

/** One run's work: list what's left, copy up to RUN_SIZE messages, save progress. */
export interface RunOptions {
  calls: number;
  batchBytes: number;
  /** Where Basin rows go; the R2 Data Catalog unless a test supplies another. */
  basin?: (env: Env, user: UserId) => Promise<BasinTarget | null>;
}

/** Where Basin rows go, and how a sync starts. Tests swap in a local table and a stand-in start. */
export const syncDeps: {
  basin: (env: Env, user: UserId) => Promise<BasinTarget | null>;
  start: (env: Env, user: UserId, account: string) => Promise<string>;
} = { basin: catalogTarget, start: (env, user, account) => startSync(env, user, account) };

/** Staged Basin batches allowed to wait; past this, copying stops until Basin takes them. */
export const BASIN_QUEUE_MAX = 20;

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
  const stop = async (error: string): Promise<RunResult> => {
    if (!(await save({ ...state, phase: 'error', error }))) return replaced;
    return { copied: 0, phase: 'error', more: false, resumesAt: null };
  };
  // Stop for now and let a fresh run try again: same as the daily limit, with another reason.
  const later = async (resumesAt: Date, phase: SyncState['phase'], error: string | null): Promise<RunResult> => {
    if (!(await save({ ...state, phase, resumesAt: resumesAt.toISOString(), error }))) return replaced;
    return { copied: 0, phase, more: true, resumesAt: resumesAt.toISOString() };
  };

  const refreshToken = await env.MAILBOX.getByName(mailboxName(user)).accountToken(account);
  if (!refreshToken) return stop('This account was removed from MailCellar.');

  const rows: IndexedMessage[] = [];
  const basin: BasinRow[] = [];
  const syncedAt = new Date().toISOString();
  let bytes = 0;
  let rest: string[];
  let calls = 1; // the token refresh
  try {
    const token = await accessToken(env, refreshToken);
    // First run: how much there is, where new mail starts, and the label names.
    if (state.historyId === null) {
      const p = await profile(token);
      await mailbox.putLabels(await labels(token));
      calls += 2;
      state.total = p.messagesTotal;
      state.historyId = p.historyId;
      state.pageToken = '';
    }
    if (!state.pending.length) {
      if (state.phase === 'backfill' && state.pageToken !== null) {
        const page = await listPage(token, state.pageToken || undefined);
        calls++;
        state.pending = page.ids;
        state.pageToken = page.next;
      } else if (state.phase === 'live') {
        const added = await addedSince(token, state.historyId!);
        state.pending = added.ids;
        state.historyId = added.historyId;
        calls += added.calls;
      }
    }
    // Basin is behind: commit what's staged before copying more.
    const take = state.basinQueue.length >= BASIN_QUEUE_MAX ? [] : state.pending.slice(0, RUN_SIZE);
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
    const batches = packBySize(sized, limits.batchBytes);
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
  try {
    if (rows.length) ({ added: copied, addedIds } = await mailbox.ingest(rows));
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
      for (const key of state.basinQueue) {
        const obj = await env.ARCHIVE.get(key);
        if (obj) queued.push(...(await gunzipJson<BasinRow[]>(obj.body)));
      }
      await target.append(queued);
      await env.ARCHIVE.delete(state.basinQueue);
      state.basinQueue = [];
    } catch (e) {
      // The rows stay staged; the next run commits them.
      basinError = `Basin didn't take this batch (${String(e).slice(0, 120)}). Retrying with the next batch.`;
    }
  }

  const backfillDone = state.phase === 'backfill' && state.pageToken === null && !rest.length;
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
  if (!(await save(next))) return replaced;
  const more = rest.length > 0 || (next.phase === 'backfill' && next.pageToken !== null) || next.basinQueue.length > 0;
  return { copied, phase: next.phase, more, resumesAt: next.resumesAt };
}

export class SyncWorkflow extends WorkflowEntrypoint<Env, SyncParams> {
  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep): Promise<RunResult> {
    const user = asUserId(event.payload.user);
    const { account } = event.payload;
    const runId = event.instanceId;
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
