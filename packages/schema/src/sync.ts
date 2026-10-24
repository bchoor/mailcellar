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
  /** The backfill copies mail from this day on (YYYY-MM-DD, UTC); null or missing: all mail. */
  since?: string | null;
}

/** What Sync now copies: the last 30 days, or all mail. */
export type SyncRange = '30d' | 'all';

/** The first day a range covers, as SyncState.since. */
export function rangeSince(range: SyncRange, now = new Date()): string | null {
  return range === 'all' ? null : new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
}

/** What starts a sync Workflow run. */
export interface SyncParams {
  user: string;
  account: string;
  /** Instead of syncing, write one made-up row to the Basin check table (basin.ts, basinCheck). */
  check?: boolean;
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
  /** First day the backfill copies; null: all mail. When set, `total` is Gmail's estimate. */
  since: string | null;
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
    since: s?.since ?? null,
  };
}

/** GET /api/sync: each account's sync, and whether Basin (the system of record) can be written yet. */
export interface SyncOverview {
  basin: boolean;
  accounts: { id: string; email: string; sync: SyncSummary }[];
}
