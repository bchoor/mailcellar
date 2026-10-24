import { DurableObject } from 'cloudflare:workers';
import {
  ARCHIVE_LIMIT,
  GMAIL_SCOPES,
  type ConnectedAccount,
  type Me,
  domainOf,
  ftsRowid,
  monthOf,
  type ArchiveRows,
  type ArchiveView,
  type IndexedMessage,
  type MailLabel,
  checkScheduleChange,
  DEFAULT_SCHEDULES,
  type Schedule,
  type UsageDay,
  type UsageMetric,
  type SyncState,
  type SyncSummary,
  type SyncOverview,
  type AccountCoverage,
  type BackfillJob,
  type CensusState,
  type MonthCoverage,
  type PartState,
  type SyncPart,
  addMonths,
  jobStatus,
  monthNow,
  SYNC_STALE_MS,
  type ScheduleRun,
  type UserId,
  asUserId,
  nextRun,
  syncStatus,
  syncSummary,
  withRecent,
  LANE_STALE_MS,
} from '@mailcellar/schema';
import type { Env } from './env';
import { accountMailbox, BasinNotReady, launchLanes, runDied, syncDeps } from './sync';

/**
 * Ordered schema migrations for the mailbox's SQLite database. Each entry runs once,
 * inside one transaction, and bumps `schema_version`. Never edit an entry that has
 * shipped; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  // 1: bookkeeping only
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
  // 2: the index the archive pages read (docs/spikes.md, S4). Every table is WITHOUT ROWID
  // so its primary key is the only row a write touches. Search covers subject, sender,
  // snippet and label IDs; it is contentless, so the text lives once, in messages.
  `CREATE TABLE messages (
     id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ts INTEGER NOT NULL,
     from_addr TEXT NOT NULL, from_name TEXT NOT NULL, subject TEXT NOT NULL,
     snippet TEXT NOT NULL, size INTEGER NOT NULL, attachments INTEGER NOT NULL,
     labels TEXT NOT NULL
   ) STRICT, WITHOUT ROWID;
   CREATE INDEX messages_ts ON messages (ts);
   CREATE VIRTUAL TABLE message_fts USING fts5 (
     subject, from_addr, from_name, snippet, labels,
     content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 1'
   );
   CREATE TABLE senders (
     addr TEXT PRIMARY KEY, name TEXT NOT NULL, n INTEGER NOT NULL, bytes INTEGER NOT NULL,
     first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL
   ) STRICT, WITHOUT ROWID;
   CREATE TABLE domains (domain TEXT PRIMARY KEY, n INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT, WITHOUT ROWID;
   CREATE TABLE months (month TEXT PRIMARY KEY, n INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT, WITHOUT ROWID;
   CREATE TABLE labels (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, n INTEGER NOT NULL, bytes INTEGER NOT NULL
   ) STRICT, WITHOUT ROWID;`,
  // 3: the person's schedule settings (a JSON change over DEFAULT_SCHEDULES), and the
  // usage the mailbox measures itself, per UTC day.
  `CREATE TABLE schedules (id TEXT PRIMARY KEY, change TEXT NOT NULL) STRICT, WITHOUT ROWID;
   CREATE TABLE usage_days (
     day TEXT NOT NULL, metric TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (day, metric)
   ) STRICT, WITHOUT ROWID;`,
  // 4: accounts. The person's connected Gmail accounts with their refresh tokens (never sent
  // to the app), and each message's state: live in Gmail and
  // here, or archived (trashed in Gmail, kept here). A purged message has no row.
  `CREATE TABLE accounts (
     id TEXT PRIMARY KEY, email TEXT NOT NULL, refresh_token TEXT NOT NULL,
     scopes TEXT NOT NULL, added_at TEXT NOT NULL, tested_at TEXT NOT NULL, test_error TEXT
   ) STRICT, WITHOUT ROWID;
   ALTER TABLE messages ADD COLUMN state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'archived'));`,
  // 5: backfill by month. Gmail's count for each month (the census, from message IDs only),
  // and backfill jobs: months queued together, each month copied as one part.
  `CREATE TABLE gmail_months (month TEXT PRIMARY KEY, n INTEGER NOT NULL, counted_at TEXT NOT NULL) STRICT, WITHOUT ROWID;
   CREATE TABLE jobs (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, label TEXT NOT NULL) STRICT;
   CREATE TABLE job_months (
     job INTEGER NOT NULL, month TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'canceled')),
     error TEXT, PRIMARY KEY (job, month)
   ) STRICT, WITHOUT ROWID;
   CREATE INDEX job_months_state ON job_months (state, month);`,
  // 6: Basin first. Messages each backfill month has copied to Basin, when the month landed
  // there (listed to the end, copied, committed) and when its search index was built from Basin.
  `CREATE TABLE basin_months (
     month TEXT PRIMARY KEY, copied INTEGER NOT NULL, landed_at TEXT, indexed_at TEXT
   ) STRICT, WITHOUT ROWID;`,
  // 7: the person paused backfill (2026-10-24). A user's mailbox that already has accounts starts
  // paused; nothing copies until they resume it. A new mailbox starts unpaused.
  `INSERT INTO meta (key, value) SELECT 'backfill_paused', 'true' WHERE EXISTS (SELECT 1 FROM accounts)
   ON CONFLICT (key) DO NOTHING`,
  // 8: the Senders and Domains pages sort by count; without an index each load read every row.
  `CREATE INDEX senders_n ON senders (n);
   CREATE INDEX domains_n ON domains (n);`,
];

/** How long a kept page answer may lag the writes behind it, in ms. Tests set it to 0. */
export const keepFor = { ms: 60_000 };

const today = () => new Date().toISOString().slice(0, 10);

/** What one ingest call wrote: rows written is what the Free plan's 100k a day counts. */
export interface IngestResult {
  added: number;
  skipped: number;
  rowsWritten: number;
  /** IDs of the messages this call added (not ones already indexed). */
  addedIds: string[];
}

type Tally = Map<string, { n: number; bytes: number; first: number; last: number; name: string }>;
function tally(into: Tally, key: string, m: IndexedMessage, name = '') {
  const t = into.get(key) ?? { n: 0, bytes: 0, first: m.ts, last: m.ts, name };
  t.n += 1;
  t.bytes += m.size;
  t.first = Math.min(t.first, m.ts);
  t.last = Math.max(t.last, m.ts);
  into.set(key, t);
}

/** One per user and mailbox (see mailboxName). Holds that user's index, rollups, sync state and schedule. */
export class MailboxDO extends DurableObject<Env> {
  /**
   * Answers the Backfill page polls (coverage, jobs), kept in memory. The page asks every 15 s,
   * and coverage reads every month row (~900 rows a call), which an open page turned into ~10M
   * rows read a day. A kept answer is served until a write has happened and it is a minute old;
   * queueing or changing a job drops them, so a click shows at once.
   */
  private kept = new Map<string, { at: number; writes: number; value: unknown }>();
  /** Writes so far (rows written, as count() sees them), to tell whether a kept answer is still true. */
  private writes = 0;

  private keep<T>(key: string, read: () => T): T {
    const k = this.kept.get(key);
    if (k && (k.writes === this.writes || Date.now() - k.at < keepFor.ms)) return k.value as T;
    const value = read();
    this.kept.set(key, { at: Date.now(), writes: this.writes, value });
    return value;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.dropSample();
    });
  }

  /**
   * Phase 1 filled one shared mailbox with made-up sample mail. No fake data is kept, so a
   * mailbox still flagged as sample has its index and rollups emptied the next time it loads.
   */
  private dropSample(): void {
    const sql = this.ctx.storage.sql;
    if (!sql.exec(`SELECT 1 FROM meta WHERE key = 'sample'`).toArray().length) return;
    this.ctx.storage.transactionSync(() => {
      for (const table of ['messages', 'message_fts', 'senders', 'domains', 'months', 'labels'])
        sql.exec(`DELETE FROM ${table}`);
      sql.exec(`DELETE FROM meta WHERE key = 'sample'`);
    });
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(MIGRATIONS[0]);
    const current = this.readVersion();
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.ctx.storage.transactionSync(() => {
        if (v > 0) sql.exec(MIGRATIONS[v]);
        sql.exec(
          `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          String(v + 1),
        );
      });
    }
  }

  private readVersion(): number {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .toArray()[0];
    return row ? Number(row.value) : 0;
  }

  async schemaVersion(): Promise<number> {
    return this.readVersion();
  }

  /** Whether the person paused backfill: then no sync or backfill month starts, and runs stop at their next batch. */
  async backfillPaused(): Promise<boolean> {
    return this.isPaused();
  }

  private isPaused(): boolean {
    return this.pausedBy() !== null;
  }

  /** Who paused backfill: the person ('true'), or the spend cap ('budget'); null when it runs. */
  private pausedBy(): 'person' | 'budget' | null {
    const v = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'backfill_paused'`).toArray()[0]?.value;
    return v === undefined ? null : v === 'budget' ? 'budget' : 'person';
  }

  /**
   * Pause or resume backfill. Resuming starts each account's sync again; lanes pick up where they
   * stood. `budget`: the spend cap paused it (a person's pause is kept as theirs).
   */
  async setBackfillPaused(paused: boolean, budget = false): Promise<void> {
    const sql = this.ctx.storage.sql;
    const { rowsWritten } = paused
      ? sql.exec(`INSERT INTO meta (key, value) VALUES ('backfill_paused', ?) ON CONFLICT (key) DO NOTHING`, budget ? 'budget' : 'true')
      : sql.exec(`DELETE FROM meta WHERE key = 'backfill_paused'`);
    if (rowsWritten) this.count({ do_rows_written: rowsWritten });
    if (paused || !this.env.BASIN_TOKEN) return;
    for (const { id } of sql.exec<{ id: string }>(`SELECT id FROM accounts`).toArray()) {
      try {
        await this.syncAccount(id, true);
      } catch (e) {
        console.error('resume sync', id, e);
      }
    }
  }

  /** This account's sync progress, or null before its first sync. */
  async syncState(): Promise<SyncState | null> {
    const row = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'sync'`).toArray()[0];
    return row ? (JSON.parse(row.value) as SyncState) : null;
  }

  /**
   * Save sync progress. With `onlyIf`, saves only while that run still owns the sync, so a
   * run replaced by a newer one can't overwrite it. Returns whether it saved.
   */
  async saveSync(state: SyncState, onlyIf?: string, added?: { copied: number; bytes: number }): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const current = this.meta<SyncState>('sync');
      if (onlyIf !== undefined && current?.runId !== onlyIf) return false;
      // Lanes add to the count and keep the list of lanes while this run works: with `added`,
      // the run's own copies are added to what's stored, not written over it.
      let next = state;
      if (current) {
        next = { ...state, lanes: current.lanes };
        if (added) {
          next = { ...next, copied: current.copied + added.copied, bytes: current.bytes + added.bytes, recent: current.recent };
          next.recent = withRecent(next, next.updatedAt);
        }
      }
      this.putMeta('sync', next);
      return true;
    });
  }

  private meta<T>(key: string): T | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private putMeta(key: string, value: unknown): number {
    return this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key, JSON.stringify(value),
    ).rowsWritten;
  }

  /** One backfill lane's progress: the month it copies, listed and staged like a sync. */
  async laneState(month: string): Promise<SyncState | null> {
    return this.meta<SyncState>(`lane:${month}`);
  }

  /**
   * Save a lane's progress while `onlyIf` owns it, and add what it copied to the account's sync
   * (its count and rate) and to the month's Basin count. A few rows, once a run, never per message.
   */
  async saveLane(month: string, state: SyncState, onlyIf: string, added: { copied: number; bytes: number }): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      if (this.meta<SyncState>(`lane:${month}`)?.runId !== onlyIf) return false;
      let written = this.putMeta(`lane:${month}`, state);
      if (added.copied || added.bytes) {
        const main = this.meta<SyncState>('sync');
        if (main) {
          const next = { ...main, copied: main.copied + added.copied, bytes: main.bytes + added.bytes, updatedAt: state.updatedAt };
          written += this.putMeta('sync', { ...next, recent: withRecent(next, state.updatedAt) });
        }
        written += this.ctx.storage.sql.exec(
          `INSERT INTO basin_months (month, copied) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET copied = copied + excluded.copied`,
          month, added.copied,
        ).rowsWritten;
      }
      this.count({ do_rows_written: written });
      return true;
    });
  }

  /** Hand a lane to its next run (or a fresh run, for a lane that died). False: `onlyIf` no longer owns it. */
  async handLane(month: string, onlyIf: string | null, runId: string): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const lane = this.meta<SyncState>(`lane:${month}`);
      if (!lane || (onlyIf !== null && lane.runId !== onlyIf)) return false;
      this.count({ do_rows_written: this.putMeta(`lane:${month}`, { ...lane, runId, resumesAt: null, updatedAt: new Date().toISOString() }) });
      return true;
    });
  }

  /** Close a lane: its month landed, failed or was taken out of the queue. */
  async endLane(month: string, runId: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      if (this.meta<SyncState>(`lane:${month}`)?.runId !== runId) return;
      let written = this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = ?`, `lane:${month}`).rowsWritten;
      written += this.setLanes();
      this.count({ do_rows_written: written });
    });
  }

  /** Keep the sync's list of lanes in step with the lanes there are. */
  private setLanes(): number {
    const main = this.meta<SyncState>('sync');
    if (!main) return 0;
    const lanes = this.ctx.storage.sql
      .exec<{ key: string }>(`SELECT key FROM meta WHERE key LIKE 'lane:%' ORDER BY key DESC`)
      .toArray()
      .map((r) => r.key.slice('lane:'.length));
    return this.putMeta('sync', { ...main, lanes });
  }

  /**
   * Start lanes for queued months, newest first, until `max` run at once, and take over lanes
   * that stopped saving (their run died). Returns each lane to start, with its new run ID.
   * `legacy` moves a month a single-run sync was copying into a lane of its own.
   */
  async claimLanes(max: number, prefix: string, legacy?: SyncState): Promise<{ month: string; runId: string }[]> {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const now = new Date();
      const at = now.toISOString();
      const id = (month: string) => `${prefix}-${month}-${now.getTime().toString(36)}`;
      const out: { month: string; runId: string }[] = [];
      let written = 0;
      const lanes = sql
        .exec<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key LIKE 'lane:%'`)
        .toArray()
        .map((r) => ({ month: r.key.slice('lane:'.length), state: JSON.parse(r.value) as SyncState }));
      const fresh = (part: SyncPart, from?: SyncState): SyncState => ({
        phase: 'backfill', runId: id(part.month), total: null, copied: 0, bytes: 0, part,
        pending: from?.pending ?? [], pageToken: from ? from.pageToken : '', historyId: null,
        basinQueue: from?.basinQueue ?? [], basinReady: from?.basinReady ?? false, startedAt: at, updatedAt: at, resumesAt: null, error: null,
      });
      if (legacy?.part && !lanes.some((l) => l.month === legacy.part!.month)) {
        const lane = fresh(legacy.part, legacy);
        written += this.putMeta(`lane:${legacy.part.month}`, lane);
        lanes.push({ month: legacy.part.month, state: lane });
        out.push({ month: legacy.part.month, runId: lane.runId });
      }
      // A lane waiting out a limit isn't stale; one that stopped saving is, and starts again where it stood.
      for (const l of lanes) {
        const waiting = l.state.resumesAt && Date.parse(l.state.resumesAt) > now.getTime();
        if (!waiting && now.getTime() - Date.parse(l.state.updatedAt) >= LANE_STALE_MS) {
          const runId = id(l.month);
          written += this.putMeta(`lane:${l.month}`, { ...l.state, runId, resumesAt: null, updatedAt: at });
          out.push({ month: l.month, runId });
        }
      }
      const busy = new Set(lanes.map((l) => l.month));
      const room = max - lanes.length;
      if (room > 0) {
        const parts = sql
          .exec<{ job: number; month: string }>(
            `SELECT job, month FROM job_months WHERE state IN ('running', 'queued') ORDER BY month DESC, job`,
          )
          .toArray()
          .filter((p) => !busy.has(p.month) && (busy.add(p.month), true))
          .slice(0, room);
        for (const p of parts) {
          written += sql.exec(`UPDATE job_months SET state = 'running' WHERE job = ? AND month = ? AND state = 'queued'`, p.job, p.month).rowsWritten;
          const lane = fresh(p);
          written += this.putMeta(`lane:${p.month}`, lane);
          out.push({ month: p.month, runId: lane.runId });
        }
      }
      if (out.length) written += this.setLanes();
      if (written) this.count({ do_rows_written: written });
      return out;
    });
  }

  /** Of these message IDs, the ones not in the index yet (reads only). */
  async unknownIds(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const cursor = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
    const known = new Set(cursor.toArray().map((r) => r.id));
    this.count({ do_rows_read: cursor.rowsRead });
    return ids.filter((id) => !known.has(id));
  }

  /** A month's backfill has landed in Basin: the month is done, and its index can be built. */
  async landMonth(part: SyncPart): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      let written = this.ctx.storage.sql.exec(
        `INSERT INTO basin_months (month, copied, landed_at) VALUES (?, 0, ?) ON CONFLICT (month) DO UPDATE SET landed_at = excluded.landed_at, indexed_at = NULL`,
        part.month, new Date().toISOString(),
      ).rowsWritten;
      written += this.ctx.storage.sql.exec(`UPDATE job_months SET state = 'done', error = NULL WHERE job = ? AND month = ? AND state = 'running'`, part.job, part.month).rowsWritten;
      this.count({ do_rows_written: written });
    });
  }

  /** The month's search index has been built from Basin. */
  async markIndexed(month: string): Promise<void> {
    const { rowsWritten } = this.ctx.storage.sql.exec(`UPDATE basin_months SET indexed_at = ? WHERE month = ?`, new Date().toISOString(), month);
    this.count({ do_rows_written: rowsWritten });
  }

  /**
   * Basin commits one at a time per account: concurrent commits to one Iceberg table conflict
   * and retry, which costs a run's few outside requests. Take the turn for `ms`, unless another
   * run holds it. Returns whether `owner` has it.
   */
  async commitTurn(owner: string, ms: number): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const lease = this.meta<{ owner: string; until: number }>('commit_turn');
      if (lease && lease.owner !== owner && lease.until > Date.now()) return false;
      this.putMeta('commit_turn', { owner, until: Date.now() + ms });
      return true;
    });
  }

  async endCommitTurn(owner: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      if (this.meta<{ owner: string }>('commit_turn')?.owner === owner) this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = 'commit_turn'`);
    });
  }

  /** Record the mailbox's labels, so the Labels page can name them. Counts are kept. */
  async putLabels(labels: MailLabel[]): Promise<void> {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      for (const l of labels)
        sql.exec(
          `INSERT INTO labels (id, name, type, n, bytes) VALUES (?, ?, ?, 0, 0)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, type = excluded.type`,
          l.id, l.name, l.type,
        );
    });
  }

  /** Whether any backfill month is waiting to be copied. */
  async hasQueued(): Promise<boolean> {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM job_months WHERE state IN ('queued', 'running') LIMIT 1`).toArray().length > 0;
  }

  /** A backfill month's state now (a canceled one is dropped by the sync). */
  async partState(part: SyncPart): Promise<PartState | null> {
    return (
      this.ctx.storage.sql
        .exec<{ state: PartState }>(`SELECT state FROM job_months WHERE job = ? AND month = ?`, part.job, part.month)
        .toArray()[0]?.state ?? null
    );
  }

  /**
   * The next month to copy, marked running: newest first. A month left running by a run that
   * was replaced comes first, since only one sync runs per account.
   */
  async nextPart(): Promise<SyncPart | null> {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ job: number; month: string }>(
        `SELECT job, month FROM job_months WHERE state IN ('running', 'queued')
         ORDER BY state = 'running' DESC, month DESC, job LIMIT 1`,
      )
      .toArray()[0];
    if (!row) return null;
    const { rowsWritten } = sql.exec(`UPDATE job_months SET state = 'running' WHERE job = ? AND month = ? AND state = 'queued'`, row.job, row.month);
    if (rowsWritten) this.count({ do_rows_written: rowsWritten });
    return { job: row.job, month: row.month };
  }

  /** Close a running backfill month as done or failed. A canceled month stays canceled. */
  async finishPart(part: SyncPart, state: 'done' | 'failed', error: string | null = null): Promise<void> {
    const { rowsWritten } = this.ctx.storage.sql.exec(
      `UPDATE job_months SET state = ?, error = ? WHERE job = ? AND month = ? AND state = 'running'`,
      state, error, part.job, part.month,
    );
    if (rowsWritten) this.count({ do_rows_written: rowsWritten });
  }

  /** The census's progress, or null before the first. */
  async censusState(): Promise<CensusState | null> {
    const row = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'census'`).toArray()[0];
    return row ? (JSON.parse(row.value) as CensusState) : null;
  }

  /** Save census progress; with `onlyIf`, only while that run owns it. Returns whether it saved. */
  async saveCensus(state: CensusState, onlyIf?: string): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      if (onlyIf !== undefined && (this.censusRow()?.runId ?? null) !== onlyIf) return false;
      this.ctx.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('census', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        JSON.stringify(state),
      );
      this.count({ do_rows_written: 1 });
      return true;
    });
  }

  private censusRow(): CensusState | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'census'`).toArray()[0];
    return row ? (JSON.parse(row.value) as CensusState) : null;
  }

  /** A month's Gmail count if it was counted after the month ended (so it can't grow); else null. */
  async finalCount(month: string): Promise<number | null> {
    const row = this.ctx.storage.sql
      .exec<{ n: number; counted_at: string }>(`SELECT n, counted_at FROM gmail_months WHERE month = ?`, month)
      .toArray()[0];
    return row && row.counted_at >= `${addMonths(month, 1)}-01T00:00:00.000Z` ? row.n : null;
  }

  /** Record Gmail's count for a month. */
  async putMonthCount(month: string, n: number): Promise<void> {
    const { rowsWritten } = this.ctx.storage.sql.exec(
      `INSERT INTO gmail_months VALUES (?, ?, ?) ON CONFLICT (month) DO UPDATE SET n = excluded.n, counted_at = excluded.counted_at`,
      month, n, new Date().toISOString(),
    );
    this.count({ do_rows_written: rowsWritten });
  }

  /** Each month's Gmail count, copied count and latest backfill state, oldest first. */
  async coverageMonths(): Promise<MonthCoverage[]> {
    return structuredClone(this.keep('coverage', () => this.readCoverage()));
  }

  private readCoverage(): MonthCoverage[] {
    const sql = this.ctx.storage.sql;
    const by = new Map<string, MonthCoverage>();
    const at = (month: string) =>
      by.get(month) ?? by.set(month, { month, gmail: null, copied: 0, inBasin: 0, landed: false, indexed: 0, state: null, error: null }).get(month)!;
    // The latest job to touch a month decides its state. One pass over job_months: the old
    // correlated max(job) per row scanned the table once a row (~70k rows read a call at 265 months).
    let read = 0;
    const each = <T>(query: string) => {
      const cursor = sql.exec<T & Record<string, SqlStorageValue>>(query);
      const rows = cursor.toArray();
      read += cursor.rowsRead;
      return rows;
    };
    for (const r of each<{ month: string; n: number }>(`SELECT month, n FROM gmail_months`)) at(r.month).gmail = r.n;
    for (const r of each<{ month: string; n: number }>(`SELECT month, n FROM months`)) Object.assign(at(r.month), { copied: r.n, indexed: r.n });
    const basin = new Set<string>();
    for (const r of each<{ month: string; copied: number; landed_at: string | null }>(`SELECT month, copied, landed_at FROM basin_months`)) {
      const m = at(r.month);
      basin.add(r.month);
      Object.assign(m, { inBasin: r.copied, landed: r.landed_at !== null, copied: Math.max(m.copied, r.copied) });
    }
    for (const r of each<{ month: string; state: PartState; error: string | null }>(
      `SELECT month, state, error FROM (
         SELECT month, state, error, row_number() OVER (PARTITION BY month ORDER BY job DESC) AS latest FROM job_months
       ) WHERE latest = 1`,
    )) Object.assign(at(r.month), { state: r.state, error: r.error });
    // Months copied before Basin came first went to Basin and the index together.
    for (const m of by.values()) if (!basin.has(m.month)) Object.assign(m, { inBasin: m.indexed, landed: m.indexed > 0 && m.state === 'done' });
    this.count({ do_rows_read: read });
    return [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
  }

  /**
   * Queue months as one backfill job. Months already waiting or being copied are left out.
   * Returns the job, or null when every month was already queued.
   */
  async queueMonths(months: string[], label: string): Promise<number | null> {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const busy = new Set(
        sql.exec<{ month: string }>(`SELECT month FROM job_months WHERE state IN ('queued', 'running')`).toArray().map((r) => r.month),
      );
      const fresh = [...new Set(months)].filter((m) => !busy.has(m));
      if (!fresh.length) return null;
      const job = sql
        .exec<{ id: number }>(`INSERT INTO jobs (created_at, label) VALUES (?, ?) RETURNING id`, new Date().toISOString(), label)
        .toArray()[0].id;
      for (const m of fresh) sql.exec(`INSERT INTO job_months (job, month, state) VALUES (?, ?, 'queued')`, job, m);
      this.kept.clear();
      this.count({ do_rows_written: fresh.length + 1 });
      return job;
    });
  }

  /** The latest backfill jobs, newest first. */
  async jobList(limit = 20): Promise<BackfillJob[]> {
    return structuredClone(this.keep(`jobs:${limit}`, () => this.readJobs(limit)));
  }

  private readJobs(limit: number): BackfillJob[] {
    const sql = this.ctx.storage.sql;
    const jobs = sql
      .exec<{ id: number; created_at: string; label: string }>(`SELECT id, created_at, label FROM jobs ORDER BY id DESC LIMIT ?`, limit)
      .toArray();
    return jobs.map((j) => {
      const months: Record<PartState, number> = { queued: 0, running: 0, done: 0, failed: 0, canceled: 0 };
      let from = '';
      let to = '';
      for (const r of sql.exec<{ state: PartState; n: number; first: string; last: string }>(
        `SELECT state, count(*) AS n, min(month) AS first, max(month) AS last FROM job_months WHERE job = ? GROUP BY state`,
        j.id,
      )) {
        months[r.state] = r.n;
        if (!from || r.first < from) from = r.first;
        if (r.last > to) to = r.last;
      }
      return { id: j.id, createdAt: j.created_at, label: j.label, status: jobStatus(months), months, from, to };
    });
  }

  /** Cancel a job's months still waiting or being copied; Retry its failed or canceled months. Returns months changed, or null: no such job. */
  async changeJob(job: number, action: 'cancel' | 'retry'): Promise<number | null> {
    const sql = this.ctx.storage.sql;
    if (!sql.exec(`SELECT 1 FROM jobs WHERE id = ?`, job).toArray().length) return null;
    const cursor =
      action === 'cancel'
        ? sql.exec(`UPDATE job_months SET state = 'canceled' WHERE job = ? AND state IN ('queued', 'running') RETURNING month`, job)
        : sql.exec(
            `UPDATE job_months SET state = 'queued', error = NULL WHERE job = ? AND state IN ('failed', 'canceled')
             AND month NOT IN (SELECT month FROM job_months WHERE state IN ('queued', 'running')) RETURNING month`,
            job,
          );
    const changed = cursor.toArray().length;
    if (changed) {
      this.kept.clear();
      this.count({ do_rows_written: cursor.rowsWritten });
    }
    return changed;
  }

  /** Take months out of the queue (all of them when `months` is null). Mail already copied stays. Returns months changed. */
  async unqueueMonths(months: string[] | null): Promise<number> {
    const sql = this.ctx.storage.sql;
    const cursor = months
      ? sql.exec(`UPDATE job_months SET state = 'canceled' WHERE state IN ('queued', 'running') AND month IN (SELECT value FROM json_each(?)) RETURNING month`, JSON.stringify(months))
      : sql.exec(`UPDATE job_months SET state = 'canceled' WHERE state IN ('queued', 'running') RETURNING month`);
    const changed = cursor.toArray().length;
    if (changed) this.count({ do_rows_written: cursor.rowsWritten });
    return changed;
  }

  /**
   * Index a batch of messages in one transaction. Messages already indexed are skipped,
   * so a retried batch never double-counts. Rollups are written once a batch, not once a
   * message, which S4 measured at a third of the write budget.
   */
  async ingest(batch: IndexedMessage[]): Promise<IngestResult> {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      let rowsWritten = 0;
      const run = (query: string, ...args: (string | number)[]) => {
        rowsWritten += sql.exec(query, ...args).rowsWritten;
      };
      const senders: Tally = new Map();
      const domains: Tally = new Map();
      const months: Tally = new Map();
      const labels: Tally = new Map();
      const addedIds: string[] = [];
      for (const m of batch) {
        const labelText = m.labels.join(' ');
        const insert = sql.exec(
          `INSERT INTO messages (id, thread_id, ts, from_addr, from_name, subject, snippet, size, attachments, labels)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          m.id, m.threadId, m.ts, m.fromAddr, m.fromName, m.subject, m.snippet, m.size, m.attachments, labelText,
        );
        rowsWritten += insert.rowsWritten;
        if (insert.rowsWritten === 0) continue;
        addedIds.push(m.id);
        run(
          `INSERT INTO message_fts (rowid, subject, from_addr, from_name, snippet, labels)
           VALUES (CAST(? AS INTEGER), ?, ?, ?, ?, ?)`,
          ftsRowid(m.id), m.subject, m.fromAddr, m.fromName, m.snippet, labelText,
        );
        tally(senders, m.fromAddr.toLowerCase(), m, m.fromName);
        tally(domains, domainOf(m.fromAddr), m);
        tally(months, monthOf(m.ts), m);
        for (const l of m.labels) tally(labels, l, m);
      }
      for (const [addr, t] of senders)
        run(
          `INSERT INTO senders VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (addr) DO UPDATE SET
             name = CASE WHEN excluded.last_ts >= last_ts THEN excluded.name ELSE name END,
             n = n + excluded.n, bytes = bytes + excluded.bytes,
             first_ts = min(first_ts, excluded.first_ts), last_ts = max(last_ts, excluded.last_ts)`,
          addr, t.name, t.n, t.bytes, t.first, t.last,
        );
      for (const [domain, t] of domains)
        run(
          `INSERT INTO domains VALUES (?, ?, ?) ON CONFLICT (domain) DO UPDATE SET
             n = n + excluded.n, bytes = bytes + excluded.bytes`,
          domain, t.n, t.bytes,
        );
      for (const [month, t] of months)
        run(
          `INSERT INTO months VALUES (?, ?, ?) ON CONFLICT (month) DO UPDATE SET
             n = n + excluded.n, bytes = bytes + excluded.bytes`,
          month, t.n, t.bytes,
        );
      // A label Gmail has not named yet keeps its ID as its name until putLabels runs.
      for (const [id, t] of labels)
        run(
          `INSERT INTO labels VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET
             n = n + excluded.n, bytes = bytes + excluded.bytes`,
          id, id, /^[A-Z_]+$/.test(id) ? 'system' : 'user', t.n, t.bytes,
        );
      const added = addedIds.length;
      if (added) this.count({ messages_indexed: added, do_rows_written: rowsWritten });
      return { added, skipped: batch.length - added, rowsWritten, addedIds };
    });
  }

  /**
   * Add to today's usage. Rows written includes this call's own writes, one a metric,
   * so the meter never under-reports what the free tier counts.
   */
  private count(usage: Partial<Record<UsageMetric, number>>) {
    // A call that only records reads changed nothing a kept answer shows.
    if (Object.entries(usage).some(([m, v]) => m !== 'do_rows_read' && v)) this.writes++;
    const others = Object.entries(usage).filter(([m, v]) => m !== 'do_rows_written' && v);
    const written = (usage.do_rows_written ?? 0) + others.length + 1; // +1: the rows-written row itself
    const day = today();
    for (const [metric, value] of [...others, ['do_rows_written', written] as const])
      this.ctx.storage.sql.exec(
        `INSERT INTO usage_days VALUES (?, ?, ?) ON CONFLICT (day, metric) DO UPDATE SET value = value + excluded.value`,
        day, metric, value,
      );
  }

  /**
   * One archive page's rows, read from the rollups so no page scans every message.
   * `q` searches subject, sender, snippet and labels; each word must match.
   */
  async archive<V extends ArchiveView>(view: V, q = ''): Promise<ArchiveRows[V][]> {
    const sql = this.ctx.storage.sql;
    const rows = (query: string, ...args: (string | number)[]) => {
      const cursor = sql.exec(query, ...args);
      const out = cursor.toArray() as unknown as ArchiveRows[V][];
      this.count({ do_rows_read: cursor.rowsRead });
      return out;
    };
    switch (view) {
      case 'months':
        return rows(`SELECT month, n, bytes FROM months ORDER BY month`);
      case 'labels':
        return rows(`SELECT id, name, type, n, bytes FROM labels WHERE n > 0 ORDER BY n DESC`);
      case 'domains':
        return rows(`SELECT domain, n, bytes FROM domains ORDER BY n DESC LIMIT ?`, ARCHIVE_LIMIT);
      case 'senders':
        return rows(
          `SELECT addr, name, n, bytes, first_ts AS firstTs, last_ts AS lastTs
           FROM senders ORDER BY n DESC LIMIT ?`,
          ARCHIVE_LIMIT,
        );
      case 'messages': {
        const cols = `id, thread_id AS threadId, ts, from_addr AS fromAddr, from_name AS fromName,
          subject, snippet, size, attachments, labels, state`;
        const match = ftsQuery(q);
        const found = match
          ? rows(
              // FTS rowids are Gmail IDs as signed 64-bit integers; %x prints them back as hex.
              `SELECT ${cols} FROM messages WHERE id IN (
                 SELECT printf('%x', rowid) FROM message_fts WHERE message_fts MATCH ?
               ) ORDER BY ts DESC LIMIT ?`,
              match,
              ARCHIVE_LIMIT,
            )
          : rows(`SELECT ${cols} FROM messages ORDER BY ts DESC LIMIT ?`, ARCHIVE_LIMIT);
        for (const m of found as unknown as { labels: string | string[] }[])
          m.labels = String(m.labels).split(' ').filter(Boolean);
        return found;
      }
    }
    throw new Error('unknown view');
  }

  /** The schedules with the person's changes applied, when Gmail sync next runs, and how it last went. */
  async schedules(): Promise<Schedule[]> {
    return DEFAULT_SCHEDULES.map((s) => this.schedule(s.id)!);
  }

  private schedule(id: string): Schedule | null {
    const base = DEFAULT_SCHEDULES.find((s) => s.id === id);
    if (!base) return null;
    const sql = this.ctx.storage.sql;
    const change = sql.exec<{ change: string }>(`SELECT change FROM schedules WHERE id = ?`, id).toArray()[0];
    const s: Schedule = { ...base, ...(change ? JSON.parse(change.change) : {}) };
    if (id !== 'gmail-sync') return s;
    const hasAccount = sql.exec(`SELECT 1 FROM accounts LIMIT 1`).toArray().length > 0;
    const last = sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'last:gmail-sync'`).toArray()[0];
    return {
      ...s,
      last: last ? (JSON.parse(last.value) as ScheduleRun) : null,
      next: hasAccount ? (nextRun(s, new Date())?.toISOString() ?? null) : null,
      waiting: !hasAccount ? 'Add a Gmail account in Settings ▸ Accounts first' : !this.env.BASIN_TOKEN ? 'Waiting for Basin write access' : null,
    };
  }

  /** The user this mailbox belongs to, for the user's own mailbox (not one account's). */
  private userId(): UserId | null {
    const name = this.ctx.id.name;
    return name?.endsWith(':default') ? asUserId(name.slice(0, -':default'.length)) : null;
  }

  /** Set the alarm for Gmail sync's next run, or clear it when sync is off or there's no account. */
  private async armSync(): Promise<void> {
    if (!this.userId()) return;
    const next = this.schedule('gmail-sync')!.next;
    if (next) await this.ctx.storage.setAlarm(Date.parse(next));
    else if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm();
  }

  /** Gmail sync's scheduled run: start a sync for each account that isn't syncing already. */
  async alarm(): Promise<void> {
    const user = this.userId();
    if (!user) return;
    const ids = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM accounts`).toArray().map((a) => a.id);
    if (ids.length && this.schedule('gmail-sync')!.on) {
      let run: ScheduleRun;
      if (this.isPaused()) run = { at: new Date().toISOString(), ok: true, detail: 'Backfill paused' };
      else if (!this.env.BASIN_TOKEN) run = { at: new Date().toISOString(), ok: false, detail: 'Waiting for Basin write access' };
      else {
        let started = 0;
        let failed = 0;
        for (const id of ids) {
          try {
            const r = await this.syncAccount(id, false);
            if ('error' in r) failed++;
            else if (r.status === 'started') started++;
          } catch (e) {
            console.error('scheduled sync', id, e);
            failed++;
          }
        }
        const already = ids.length - started - failed;
        const parts = [`Started ${started} of ${ids.length}`];
        if (already) parts.push(`${already} already syncing or waiting`);
        if (failed) parts.push(`${failed} failed to start`);
        run = { at: new Date().toISOString(), ok: !failed, detail: parts.join('; ') };
      }
      const { rowsWritten } = this.ctx.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('last:gmail-sync', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        JSON.stringify(run),
      );
      this.count({ do_rows_written: rowsWritten });
    }
    await this.armSync();
  }

  /** One account's sync, as the app shows it. Null: not this user's account. */
  async syncInfo(account: string): Promise<SyncSummary | null> {
    const user = this.userId();
    if (!user || !this.hasAccount(account)) return null;
    return syncSummary(await accountMailbox(this.env, user, account).syncState());
  }

  /** Every account's sync, for the Backfill page and the status bar, and whether Basin can be written. */
  async syncAll(): Promise<SyncOverview> {
    const user = this.userId();
    const accounts = this.ctx.storage.sql
      .exec<{ id: string; email: string }>(`SELECT id, email FROM accounts ORDER BY added_at`)
      .toArray();
    const pausedBy = this.pausedBy();
    const paused = pausedBy !== null;
    return {
      basin: !!this.env.BASIN_TOKEN,
      paused,
      pausedBy,
      accounts: user
        ? await Promise.all(
            accounts.map(async (a) => {
              const mailbox = accountMailbox(this.env, user, a.id);
              let state = await mailbox.syncState();
              // A run Cloudflare stopped never saves again: start it afresh, so the page never shows a dead run as running.
              // Lanes are checked on their own: a lane that stopped saving starts again where it stood.
              const ownWork = state && (state.phase !== 'live' || state.pending.length > 0 || state.basinQueue.length > 0);
              if (!paused && state?.lanes?.length) await launchLanes(this.env, user, a.id);
              if (!paused && state && ownWork && syncStatus(state) === 'running' && (await runDied(this.env, state.runId))) {
                try {
                  await syncDeps.start(this.env, user, a.id);
                  state = await mailbox.syncState();
                } catch (e) {
                  if (!(e instanceof BasinNotReady)) throw e;
                }
              }
              return { ...a, sync: syncSummary(state) };
            }),
          )
        : [],
    };
  }

  /**
   * Start syncing an account unless a run is going or waiting to resume. Sync now (`manual`)
   * also restarts a sync that stopped on an error; the schedule leaves those for the person.
   */
  async syncAccount(account: string, manual: boolean): Promise<{ status: 'started' | SyncSummary['status'] } | { error: 'not_found' | 'basin_not_ready' | 'paused' }> {
    const user = this.userId();
    if (!user || !this.hasAccount(account)) return { error: 'not_found' };
    if (this.isPaused()) return { error: 'paused' };
    const state = await accountMailbox(this.env, user, account).syncState();
    const status = syncStatus(state);
    const dead = status === 'running' && (await runDied(this.env, state!.runId));
    if ((status === 'running' && !dead) || status === 'waiting' || (status === 'stopped' && !manual)) return { status };
    try {
      await syncDeps.start(this.env, user, account);
    } catch (e) {
      if (e instanceof BasinNotReady) return { error: 'basin_not_ready' };
      throw e;
    }
    return { status: 'started' };
  }

  /**
   * An account's coverage map: each month's Gmail count, what MailCellar has, and backfill
   * states. Opening it starts the census when there is none, resumes one that stopped, and
   * recounts recent months every 6 hours. Null: not this user's account.
   */
  async coverage(account: string): Promise<AccountCoverage | null> {
    const user = this.userId();
    if (!user || !this.hasAccount(account)) return null;
    const mailbox = accountMailbox(this.env, user, account);
    let c = await mailbox.censusState();
    const now = Date.now();
    const stale = c && now - Date.parse(c.updatedAt) >= SYNC_STALE_MS;
    const held = !!c?.resumesAt && Date.parse(c.resumesAt) > now;
    const mode = held ? null : !c ? 'full' : c.month !== null && (c.error || stale) ? 'resume' : c.finishedAt && now - Date.parse(c.finishedAt) >= 6 * 3_600_000 ? 'refresh' : null;
    if (mode) {
      await syncDeps.census(this.env, user, account, mode === 'refresh' ? 'refresh' : 'full');
      c = await mailbox.censusState();
    }
    const counting = !!c && c.month !== null && !c.error;
    return {
      months: await mailbox.coverageMonths(),
      census: {
        status: !c ? 'not_started' : c.error ? 'stopped' : counting ? 'counting' : 'done',
        month: c?.month ?? null,
        finishedAt: c?.finishedAt ?? null,
        error: c?.error ?? null,
      },
      current: monthNow(),
    };
  }

  /** Queue months to copy for an account, and start its sync if none is going. */
  async backfill(account: string, months: string[], label: string): Promise<{ job: number | null; status: 'started' | SyncSummary['status'] } | { error: 'not_found' | 'basin_not_ready' | 'paused' }> {
    const user = this.userId();
    if (!user || !this.hasAccount(account)) return { error: 'not_found' };
    if (this.isPaused()) return { error: 'paused' };
    if (!this.env.BASIN_TOKEN) return { error: 'basin_not_ready' };
    const job = await accountMailbox(this.env, user, account).queueMonths(months, label);
    const r = await this.syncAccount(account, true);
    // A sync already going: the new months get lanes now, up to MAX_LANES at once.
    if (!('error' in r) && r.status !== 'started') await launchLanes(this.env, user, account);
    return 'error' in r ? r : { job, status: r.status };
  }

  /** An account's latest backfill jobs. Null: not this user's account. */
  async jobs(account: string): Promise<BackfillJob[] | null> {
    const user = this.userId();
    if (!user || !this.hasAccount(account)) return null;
    return accountMailbox(this.env, user, account).jobList();
  }

  /** Cancel or retry a backfill job; a retry starts the sync if none is going. Null: no such account or job. */
  async jobAction(account: string, job: number, action: 'cancel' | 'retry'): Promise<{ changed: number } | null> {
    const user = this.userId();
    if (!user || !this.hasAccount(account)) return null;
    const changed = await accountMailbox(this.env, user, account).changeJob(job, action);
    if (changed === null) return null;
    if (action === 'retry' && changed && this.env.BASIN_TOKEN && !this.isPaused()) await this.syncAccount(account, true);
    return { changed };
  }

  /** Take months out of an account's queue, or all when `months` is null. Null: not this user's account. */
  async unqueue(account: string, months: string[] | null): Promise<{ changed: number } | null> {
    const user = this.userId();
    if (!user || !this.hasAccount(account)) return null;
    return { changed: await accountMailbox(this.env, user, account).unqueueMonths(months) };
  }

  private hasAccount(id: string): boolean {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM accounts WHERE id = ?`, id).toArray().length > 0;
  }

  /** Save a change to one schedule; an unknown schedule or a change it can't take is refused. */
  async saveSchedule(id: string, change: unknown): Promise<{ ok: true; schedule: Schedule } | { ok: false; error: string }> {
    const base = DEFAULT_SCHEDULES.find((s) => s.id === id);
    if (!base) return { ok: false, error: 'unknown schedule' };
    let checked;
    try {
      checked = checkScheduleChange(base, change);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const sql = this.ctx.storage.sql;
    const prev = sql.exec<{ change: string }>(`SELECT change FROM schedules WHERE id = ?`, id).toArray()[0];
    const merged = { ...(prev ? JSON.parse(prev.change) : {}), ...checked };
    const { rowsWritten } = sql.exec(
      `INSERT INTO schedules VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET change = excluded.change`,
      id, JSON.stringify(merged),
    );
    this.count({ do_rows_written: rowsWritten });
    if (id === 'gmail-sync') await this.armSync();
    return { ok: true, schedule: this.schedule(id)! };
  }

  /** Connect a Gmail account, or refresh its token and scopes if it is connected already. */
  async connectAccount(
    account: { id: string; email: string; refreshToken: string | null; scopes: string[] },
  ): Promise<{ ok: true } | { ok: false; error: 'no_refresh' }> {
    const sql = this.ctx.storage.sql;
    const known = sql.exec<{ refresh_token: string }>(`SELECT refresh_token FROM accounts WHERE id = ?`, account.id).toArray()[0];
    const token = account.refreshToken ?? known?.refresh_token;
    if (!token) return { ok: false, error: 'no_refresh' };
    const { rowsWritten } = sql.exec(
        `INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (id) DO UPDATE SET
           email = excluded.email, refresh_token = excluded.refresh_token, scopes = excluded.scopes,
           tested_at = excluded.tested_at, test_error = NULL`,
        account.id, account.email, token, account.scopes.join(' '), new Date().toISOString(), new Date().toISOString(),
    );
    this.count({ do_rows_written: rowsWritten });
    await this.armSync();
    return { ok: true };
  }

  /** An account's refresh token, for the Worker to test or sync with. Never sent to the app. */
  async accountToken(id: string): Promise<string | null> {
    return this.ctx.storage.sql.exec<{ refresh_token: string }>(`SELECT refresh_token FROM accounts WHERE id = ?`, id).toArray()[0]?.refresh_token ?? null;
  }

  /** Record a connection test: the scopes Google reports for the token, or why it failed. */
  async recordTest(id: string, result: { scopes: string[] } | { error: string }): Promise<void> {
    const sql = this.ctx.storage.sql;
    const at = new Date().toISOString();
    const { rowsWritten } =
      'error' in result
        ? sql.exec(`UPDATE accounts SET tested_at = ?, test_error = ? WHERE id = ?`, at, result.error, id)
        : sql.exec(`UPDATE accounts SET tested_at = ?, test_error = NULL, scopes = ? WHERE id = ?`, at, result.scopes.join(' '), id);
    if (rowsWritten) this.count({ do_rows_written: rowsWritten });
  }

  /** Disconnect an account and hand back its refresh token, so the Worker can revoke it at Google. */
  async disconnectAccount(id: string): Promise<string | null> {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ refresh_token: string }>(`DELETE FROM accounts WHERE id = ? RETURNING refresh_token`, id).toArray()[0];
    if (row) {
      this.count({ do_rows_written: 1 });
      await this.armSync();
    }
    return row?.refresh_token ?? null;
  }

  /** The Access user (passed in by the Worker) and the accounts the archive keeps. Never includes tokens. */
  async me(email: string): Promise<Me> {
    const sql = this.ctx.storage.sql;
    // Mailboxes from before schedules ran have no alarm yet; the first visit sets it.
    if ((await this.ctx.storage.getAlarm()) === null) await this.armSync();
    const accounts = sql
      .exec<{ id: string; email: string; scopes: string; added_at: string; tested_at: string; test_error: string | null }>(
        `SELECT id, email, scopes, added_at, tested_at, test_error FROM accounts ORDER BY added_at`,
      )
      .toArray()
      .map((a): ConnectedAccount => {
        const scopes = a.scopes.split(' ');
        const modify = scopes.includes(GMAIL_SCOPES.modify);
        const read = modify || scopes.includes(GMAIL_SCOPES.readonly);
        return {
          id: a.id,
          email: a.email,
          addedAt: a.added_at,
          read,
          modify,
          test: {
            at: a.tested_at,
            ok: !a.test_error && read,
            detail: a.test_error ? null : modify ? 'read and modify' : 'read only',
            error: a.test_error,
          },
        };
      });
    return { user: { email }, accounts };
  }

  /** Usage for the last `days` UTC days, oldest first. */
  async usage(days = 30): Promise<UsageDay[]> {
    const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    return this.ctx.storage.sql
      .exec<{ day: string; metric: string; value: number }>(
        `SELECT day, metric, value FROM usage_days WHERE day >= ? ORDER BY day, metric`,
        since,
      )
      .toArray() as UsageDay[];
  }
}

/** A search box's words as an FTS5 query: each word quoted, so FTS syntax in it is literal. */
export function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((w) => `"${w.replaceAll('"', '""')}"`)
    .join(' ');
}
