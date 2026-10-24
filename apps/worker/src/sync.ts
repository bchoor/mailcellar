// The sync Workflow: copies one Gmail account into MailCellar, 500 messages a run.
// Spike S7 found that a Workflow run is one Worker invocation, so Workers Free's caps of
// 50 outside requests and 1,000 Cloudflare calls cover the whole run. A run therefore does
// one batch and then starts the next run, until the account is copied.
// Raw mail goes to R2 (gzipped up to 256 KB, spike S3); the index goes to the account's DO.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { asUserId, mailboxName, r2Keys, type IndexedMessage, type SyncParams, type SyncState, type UserId } from '@mailcellar/schema';
import type { Env } from './env';
import { BATCH_SIZE, b64urlBytes, batchGet, addedSince, GmailError, indexRow, labels, listPage, packBySize, profile } from './gmail';

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

/**
 * Start (or restart) syncing an account. The new run takes over: a run already going finds
 * another run ID in the sync state and stops at its next save.
 */
export async function startSync(env: Env, user: UserId, account: string): Promise<string> {
  const mailbox = accountMailbox(env, user, account);
  const now = new Date().toISOString();
  const state: SyncState = (await mailbox.syncState()) ?? {
    phase: 'backfill', runId: '', total: null, copied: 0, bytes: 0, pending: [], pageToken: null, historyId: null,
    startedAt: now, updatedAt: now, resumesAt: null, error: null,
  };
  const runId = `${account}-${Date.now().toString(36)}`;
  await mailbox.saveSync({ ...state, runId, phase: resumePhase(state), error: null, resumesAt: null, updatedAt: now });
  await env.SYNC.create({ id: runId, params: { user, account } });
  return runId;
}

/** A Gmail answer worth trying again later: rate limits, Google's errors, the network. */
const retryable = (e: unknown) => (e instanceof GmailError && (e.status === 429 || e.status >= 500)) || e instanceof TypeError;

/** One run's work: list what's left, copy up to RUN_SIZE messages, save progress. */
export async function runBatch(env: Env, user: UserId, account: string, runId: string, limits = { calls: RUN_CALLS, batchBytes: BATCH_BYTES }): Promise<RunResult> {
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
    const take = state.pending.slice(0, RUN_SIZE);
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
        await env.ARCHIVE.put(r2Keys.raw(user, account, m.id), small ? await gzip(raw) : raw, {
          httpMetadata: { contentType: 'message/rfc822', contentEncoding: small ? 'gzip' : undefined },
        });
        rows.push(indexRow(m, raw));
        bytes += m.sizeEstimate;
      }
    }
  } catch (e) {
    if (e instanceof GmailError && (e.status === 401 || e.status === 403)) return stop(e.message);
    if (!retryable(e)) throw e;
    return later(new Date(Date.now() + 5 * 60_000), state.phase, `Gmail didn't answer (${e instanceof GmailError ? `HTTP ${e.status}` : 'network'}). Trying again shortly.`);
  }

  let copied = 0;
  try {
    if (rows.length) copied = (await mailbox.ingest(rows)).added;
  } catch (e) {
    if (!isDailyLimit(e)) throw e;
    return later(nextReset(), 'paused', null);
  }

  const backfillDone = state.phase === 'backfill' && state.pageToken === null && !rest.length;
  const next: SyncState = {
    ...state,
    phase: backfillDone ? 'live' : state.phase,
    pending: rest,
    copied: state.copied + copied,
    bytes: state.bytes + bytes,
    resumesAt: null,
    error: null,
  };
  if (!(await save(next))) return replaced;
  const more = rest.length > 0 || (next.phase === 'backfill' && next.pageToken !== null);
  return { copied, phase: next.phase, more, resumesAt: null };
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
