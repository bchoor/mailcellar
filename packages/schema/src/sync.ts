// Sync progress for one Gmail account, kept in that account's mailbox DO (meta key 'sync').
// The Backfill page and the status bar read it; the sync Workflow is the only writer.

export type SyncPhase =
  /** Copying the mailbox for the first time, newest mail first. */
  | 'backfill'
  /** Backfill finished; new mail is copied on each sync. */
  | 'live'
  /** Stopped for the day at the free tier's write limit; resumes after 00:00 UTC. */
  | 'paused'
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
  const busy = s.phase !== 'live' || s.pending.length > 0 || s.basinQueue.length > 0;
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
  /** The month being copied now, if any. */
  month: string | null;
  /** The account limit a pause waits for, if any. */
  pausedFor: string | null;
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
    month: s?.part?.month ?? null,
    pausedFor: s?.pausedFor ?? null,
  };
}

/** GET /api/sync: each account's sync, and whether Basin (the system of record) can be written yet. */
export interface SyncOverview {
  basin: boolean;
  accounts: { id: string; email: string; sync: SyncSummary }[];
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
  /** Messages MailCellar has that month. */
  copied: number;
  /** The latest backfill's state for this month, if one touched it. */
  state: PartState | null;
  /** Why that backfill failed. */
  error: string | null;
}

/** GET /api/accounts/:id/coverage. */
export interface AccountCoverage {
  months: MonthCoverage[];
  census: { status: 'counting' | 'done' | 'stopped' | 'not_started'; month: string | null; finishedAt: string | null; error: string | null };
  /** The month still running (YYYY-MM): its count can still grow. */
  current: string;
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
