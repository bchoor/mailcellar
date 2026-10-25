// Sync progress for one Gmail account, kept in that account's mailbox DO (meta key 'sync').
// The Backfill page and the status bar read it; the sync Workflow is the only writer.

export type SyncPhase =
  /** Copying the mailbox for the first time, newest mail first. */
  | 'backfill'
  /** Backfill finished; new mail is copied on each sync. */
  | 'live'
  /** Waiting for a daily limit to reset (resumesAt); copying is not paused, it is waiting. */
  | 'waiting'
  /** Stopped on an error that needs the person (for example, access was removed). */
  | 'error';

export interface SyncState {
  phase: SyncPhase;
  /** The Workflow run allowed to write. A run that finds another ID here stops. */
  runId: string;
  /** Messages in Gmail when the backfill started, as Gmail counts them. */
  total: number | null;
  /** Messages copied so far, and their size in bytes as Gmail reports it. */
  copied: number;
  bytes: number;
  /** Message IDs listed but not copied yet. */
  pending: string[];
  /** Next page of the backfill listing; null once the listing is done. */
  pageToken: string | null;
  /** Where new-mail syncs resume; set when the backfill starts. */
  historyId: string | null;
  startedAt: string;
  updatedAt: string;
  /** Batches copied but not yet committed to Basin (R2 keys of staged rows), oldest first. */
  basinQueue: string[];
  /** The user's Basin table exists. */
  basinReady: boolean;
  /** When a paused sync resumes. */
  resumesAt: string | null;
  error: string | null;
  /** The month the backfill is copying now (listing it with `pageToken`), and the backfill job it belongs to. */
  part?: SyncPart | null;
  /** The account limit a pause waits for (QUOTA_LIMITS label); null when not paused for one. */
  pausedFor?: string | null;
  /** When each recent save happened and `copied` then, oldest first, kept for RATE_WINDOW_MS and a little more. */
  recent?: { at: string; copied: number }[];
  /** Backfill months being copied in parallel now, each by its own lane (a chain of runs). */
  lanes?: string[];
}

/**
 * Backfill months copied at once, each by its own chain of runs. They share one Gmail rate, so
 * more lanes don't copy faster; three keep it busy (backfill speed plan v4).
 */
export const MAX_LANES = 3;
/** A lane that hasn't saved for this long has died, and is started again where it stood. */
export const LANE_STALE_MS = 10 * 60_000;

/** The copy rate is measured over this window. */
export const RATE_WINDOW_MS = 10 * 60_000;

/** `recent` with a save at `at` added, trimmed to what the rate can still use. */
export function withRecent(s: SyncState, at: string): { at: string; copied: number }[] {
  const keep = Date.parse(at) - RATE_WINDOW_MS * 1.5;
  return [...(s.recent ?? []).filter((r) => Date.parse(r.at) >= keep), { at, copied: s.copied }].slice(-60);
}

/**
 * Messages copied a minute over the last RATE_WINDOW_MS: from the oldest save in the window (or
 * the last one before it) to now, so a stall shows as a falling rate. Null until there is a minute
 * of history to measure.
 */
export function copyRate(s: SyncState | null, now = Date.now()): number | null {
  const recent = s?.recent ?? [];
  if (!s || !recent.length) return null;
  const from = now - RATE_WINDOW_MS;
  const before = recent.filter((r) => Date.parse(r.at) <= from).at(-1);
  const base = before ?? recent[0];
  const since = Math.max(Date.parse(base.at), from);
  const minutes = (now - since) / 60_000;
  if (minutes < 1) return null;
  return Math.max(0, s.copied - base.copied) / minutes;
}

/** One month of one backfill job: the unit a backfill copies. */
export interface SyncPart {
  job: number;
  /** YYYY-MM, UTC. */
  month: string;
}

/** What starts a sync Workflow run. */
export interface SyncParams {
  user: string;
  account: string;
  /** Instead of syncing, write one made-up row to the Basin check table (basin.ts, basinCheck). */
  check?: boolean;
  /** Instead of syncing, count the account's messages by month (the census). */
  census?: boolean;
  /**
   * Instead of syncing, keep names for Durable Object namespace and D1 database IDs (ID → name)
   * in the account meter, for the Usage page. Sent through the Workflows API by whoever can list
   * them, since the analytics token can't.
   */
  names?: Record<string, string>;
  /** Copy this backfill month: one lane of a parallel backfill (its progress is an R2 file, r2Keys.lane). */
  month?: string;
  /** Commit what the account's lanes staged to Basin, and land the months that are all there. */
  commit?: boolean;
  /**
   * Copy one month as a test: queue it and resume backfill, only if no other month of any of the
   * user's accounts is waiting or being copied. The answer lists those months if there are any.
   */
  trial?: string;
  /** With `trial`: take the test account's other waiting months out of the queue first. */
  park?: boolean;
  /** Pause the user's backfill (as the person's pause). */
  pause?: boolean;
  /**
   * Instead of syncing, compare the search index with Gmail's month lists for this year: the
   * answer names the indexed messages no month lists, and listed ones the index lacks. Reads only.
   */
  audit?: string;
  /** Check a landed month against Gmail's list of it and mark it done (copying indexed it already). */
  index?: string;
  /** Unused since copying indexes as it goes (2026-10-25); kept so runs queued before then still parse. */
  from?: number;
  /**
   * Instead of syncing, move where each copied message is from Basin into the mailbox (2026-10-25):
   * these months, a few a run. With `check`, report messages that still have no location instead.
   */
  locate?: string[];
  /** Instead of syncing, queue every past month with mail not yet copied, and resume backfill. */
  missing?: boolean;
  /** Import an archive's uploaded mbox: one run of the chain (import.ts). */
  import?: boolean;
}

/** Where an account's sync stands: a run is going, it's waiting to resume, it stopped on an error, or it can start. */
export type SyncStatus = 'idle' | 'running' | 'waiting' | 'stopped';

/** A run that hasn't saved for this long has died: a run's step times out at 15 minutes and retries once. */
export const SYNC_STALE_MS = 45 * 60_000;

export function syncStatus(s: SyncState | null, now = Date.now()): SyncStatus {
  if (!s) return 'idle';
  if (s.phase === 'error') return 'stopped';
  if (s.resumesAt && Date.parse(s.resumesAt) > now) return 'waiting';
  // Live with nothing left to copy means the last run finished.
  const busy = s.phase !== 'live' || s.pending.length > 0 || s.basinQueue.length > 0 || !!s.lanes?.length;
  return busy && now - Date.parse(s.updatedAt) < SYNC_STALE_MS ? 'running' : 'idle';
}

/** One account's sync as the app shows it. */
export interface SyncSummary {
  status: SyncStatus;
  phase: SyncPhase | null;
  total: number | null;
  copied: number;
  bytes: number;
  startedAt: string | null;
  updatedAt: string | null;
  resumesAt: string | null;
  error: string | null;
  /** The month being copied now, if any (the newest, when several are). */
  month: string | null;
  /** Every month being copied now, newest first. */
  months: string[];
  /** The account limit a pause waits for, if any. */
  pausedFor: string | null;
  /** Messages copied a minute over the last 10 minutes; null until measured. */
  ratePerMin: number | null;
}

export function syncSummary(s: SyncState | null, now = Date.now()): SyncSummary {
  return {
    status: syncStatus(s, now),
    phase: s?.phase ?? null,
    total: s?.total ?? null,
    copied: s?.copied ?? 0,
    bytes: s?.bytes ?? 0,
    startedAt: s?.startedAt ?? null,
    updatedAt: s?.updatedAt ?? null,
    resumesAt: s?.resumesAt ?? null,
    error: s?.error ?? null,
    month: s?.lanes?.[0] ?? s?.part?.month ?? null,
    months: s?.lanes ?? (s?.part ? [s.part.month] : []),
    pausedFor: s?.pausedFor ?? null,
    ratePerMin: copyRate(s, now),
  };
}

/** GET /api/sync: each account's sync, and whether Basin (the system of record) can be written yet. */
export interface SyncOverview {
  basin: boolean;
  /** The person paused backfill: nothing copies until they resume (PUT /api/backfill/paused). */
  paused: boolean;
  /** Who paused it: the person, or the backfill's spend cap (SPEND in quota.ts). */
  pausedBy: 'person' | 'budget' | null;
  /** `kind` archive: an imported mbox, with no Gmail link; its `email` is the name it was given. */
  accounts: { id: string; email: string; kind?: 'gmail' | 'archive'; sync: SyncSummary }[];
}

/** The first month Gmail had mail (April 2004). The census looks further back only if Gmail has older mail. */
export const GMAIL_FIRST_MONTH = '2004-04';

/** A month's bounds in Unix seconds, for Gmail's `after:` and `before:` (exact, in UTC). */
export function monthBounds(month: string): { after: number; before: number } {
  const [y, m] = month.split('-').map(Number);
  return { after: Date.UTC(y, m - 1, 1) / 1000, before: Date.UTC(y, m, 1) / 1000 };
}

/** Gmail's search for one month: messages from its first second to the next month's. */
export const monthQuery = (month: string) => {
  const { after, before } = monthBounds(month);
  // `after:` is exclusive, so it starts one second early.
  return `after:${after - 1} before:${before}`;
};

/** The month before (`delta` -1) or after (+1) a YYYY-MM month. */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/** Every month from `from` to `to`, oldest first. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** The month a time falls in, UTC. */
export const monthNow = (now = new Date()) => now.toISOString().slice(0, 7);

/**
 * The census: Gmail's message count for each month, counted exactly by listing message IDs
 * (never the mail itself). It runs newest month first, so the map fills from today back.
 */
export interface CensusState {
  runId: string;
  /** The month counted next; null when finished. */
  month: string | null;
  pageToken: string | null;
  /** IDs counted so far in `month`. */
  n: number;
  /** Months in a row with no mail, counting back; a long run ends the census. */
  empty: number;
  /** `full` counts back to the first mail; `refresh` stops at the first month counted after it ended. */
  mode: 'full' | 'refresh';
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** A census paused for an account limit resumes after this. */
  resumesAt?: string | null;
}

/** A backfill month's state. Copied months are `done`. */
export type PartState = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

/** One month on the coverage map. */
export interface MonthCoverage {
  month: string;
  /** Messages Gmail has that month (the census); null until counted. */
  gmail: number | null;
  /** Of those, messages Gmail lists but won't give (404, or 400 on some old mail): not copyable, so not missing. */
  unavailable?: number;
  /** Messages MailCellar has that month: copied to Basin, or indexed if more (mail copied before Basin came first). */
  copied: number;
  /** Messages copied to Basin, the system of record, this month (a backfill in progress counts as it goes). */
  inBasin: number;
  /** Whether the month's backfill has landed in Basin: listed to the end, copied and committed. */
  landed: boolean;
  /** Messages in the search index this month; built from Basin after the month lands. */
  indexed: number;
  /** The latest backfill's state for this month, if one touched it. */
  state: PartState | null;
  /** Why that backfill failed. */
  error: string | null;
  /** When that backfill finished the month (done or failed); null while it runs, or for months finished before this was kept. */
  finishedAt: string | null;
  /** The month's copy as the Backfill page names it: `state`, with running as copying and canceled as stopped. */
  copyState?: 'queued' | 'copying' | 'done' | 'failed' | 'stopped' | null;
  /** The month's search index, once it has landed in Basin; null before (or for mail indexed before Basin came first). */
  indexState?: IndexState | null;
  /** Indexing waits for the daily DO write limit until this time. */
  resumesAt?: string | null;
}

/** A landed month's search index: queued, being built from Basin, waiting for the daily DO write limit, or done. */
export type IndexState = 'queued' | 'indexing' | 'waiting' | 'done';

/** GET /api/accounts/:id/coverage. */
export interface AccountCoverage {
  months: MonthCoverage[];
  census: { status: 'counting' | 'done' | 'stopped' | 'not_started'; month: string | null; finishedAt: string | null; error: string | null };
  /** The month still running (YYYY-MM): its count can still grow. */
  current: string;
}

/** One mailbox on GET /api/backfill/status: its sync, coverage, copy and index state, and latest backfills. */
export interface AccountStatus extends AccountCoverage {
  id: string;
  email: string;
  /** archive: an imported mbox; its months count the file, not Gmail. */
  kind?: 'gmail' | 'archive';
  sync: SyncSummary;
  /** Copying is never paused by the DO write limit, only by the person or the spend guard. */
  copy: { status: 'copying' | 'paused' | 'idle'; pausedBy?: 'person' | 'budget' };
  /** Indexing waits for the daily DO write limit (`pausedFor` names it) until `resumesAt`. */
  index: { status: 'indexing' | 'waiting' | 'idle'; pausedFor?: string; resumesAt?: string };
  jobs: BackfillJob[];
  /** Messages in this mailbox's search index. */
  totals: { indexed: number };
  /** Size copied (as Gmail counts it), a point a minute over the last hour, while copying; empty after a restart until copying moves. */
  sizes: { at: string; bytes: number }[];
}

/**
 * GET /api/backfill/status: the one read the Backfill page and status bar poll. Every mailbox
 * answers from one kept status row, so a poll reads no table.
 */
export interface BackfillStatus extends SyncOverview {
  /** running, paused by the person, indexing waiting for the daily limit (until resumesAt), paused by the spend guard, or idle. */
  state: 'running' | 'paused' | 'index_waiting' | 'budget' | 'idle';
  resumesAt: string | null;
  accounts: AccountStatus[];
}

/** A backfill: months queued together, copied newest first. */
export interface BackfillJob {
  id: number;
  createdAt: string;
  label: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled';
  months: Record<PartState, number>;
  /** First and last month it covers. */
  from: string;
  to: string;
}

/** A job's status from its months' states: running beats queued beats failed beats canceled. */
export function jobStatus(months: Record<PartState, number>): BackfillJob['status'] {
  if (months.running) return 'running';
  if (months.queued) return 'queued';
  if (months.failed) return 'failed';
  if (months.canceled) return 'canceled';
  return 'done';
}
