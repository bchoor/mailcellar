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
  type GmailLabels,
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
  type AccountStatus,
  type BackfillStatus,
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
  mailboxName,
  r2Keys,
  type SyncParams,
  type MessageFilter,
  type MessageRow,
  type MessagePage,
  type MessageSort,
  type MessageGroup,
  type MessageGroupBy,
  type MessageGroups,
  MESSAGE_SORTS,
} from '@mailcellar/schema';
import type { Env } from './env';
import { accountMailbox, accessToken, BasinNotReady, INDEX_CHUNK, INDEX_ROWS, launchLanes, RUN_COST, runDied, syncDeps } from './sync';
import { BUCKET, endLaneFile, FLIGHT, freshLane, readLane, rememberCopied, saveLane } from './copy';
import { GmailError } from './gmail';
import { accountQuota } from './quota';

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
  // 9: when each backfill month finished (done or failed), for the Backfills list's Done today.
  `ALTER TABLE job_months ADD COLUMN finished_at TEXT;`,
  // 10: the slim index (2026-10-24). Search keeps no per-message size row (columnsize = 0) and
  // so no contentless delete: a message is taken out with FTS5's 'delete' command and its text
  // from messages. That was one DO row written a message. The constructor fills it again.
  `DROP TABLE message_fts;
   CREATE VIRTUAL TABLE message_fts USING fts5 (
     subject, from_addr, from_name, snippet, labels,
     content = '', columnsize = 0, tokenize = 'unicode61 remove_diacritics 1'
   );
   INSERT INTO meta (key, value) VALUES ('fts_refill', 'true') ON CONFLICT (key) DO UPDATE SET value = excluded.value;`,
  // 11: the status row (2026-10-24) keeps each month's latest backfill state, found by month.
  `CREATE INDEX job_months_month ON job_months (month, job);`,
  // 12: Spam and Trash are not kept (Bikram, 2026-10-24). Live sync had copied some; the
  // constructor takes them out of the index and deletes their raw files.
  `INSERT INTO meta (key, value) VALUES ('drop_spam', 'true') ON CONFLICT (key) DO UPDATE SET value = excluded.value;`,
];

/** Gmail labels whose mail MailCellar doesn't keep: the index never takes it in. */
const NOT_KEPT = ['SPAM', 'TRASH'];
const notKept = (labels: string[]) => labels.some((l) => NOT_KEPT.includes(l));


const today = () => new Date().toISOString().slice(0, 10);
/** How often the watchdog alarm checks on work in progress (MailboxDO.recover). */
const WATCH_MS = 5 * 60_000;

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

/**
 * A mailbox's backfill status, kept as one meta row ('status') and in memory: every month's
 * counts and states, the latest jobs, the census and the index's progress. It is the only thing
 * the status reads (coverage, jobs, sync, Messages totals) look at, so a poll reads at most this
 * one row and never a table. Each writer that changes a month or job updates its entries from
 * the tables (a few keyed rows) in the same transaction and saves the row.
 */
interface StatusBook {
  v: number;
  months: Record<string, MonthCoverage>;
  jobs: BackfillJob[];
  census: CensusState | null;
  /** Months whose index is being built from Basin now. */
  indexing: string[];
  /** Indexing waits for the account's daily DO write limit. */
  indexWait: { resumesAt: string; label: string } | null;
}
/** Bump to rebuild every mailbox's status row from its tables once (the shape changed). */
const STATUS_V = 1;
/** Backfill jobs the status keeps, newest first. */
const JOBS_KEPT = 20;
/** The Size sparkline: one point a minute over the last hour, kept in memory. */
const SIZE_STEP_MS = 60_000;
const SIZE_WINDOW_MS = 60 * 60_000;

/** One per user and mailbox (see mailboxName). Holds that user's index, rollups, sync state and schedule. */
export class MailboxDO extends DurableObject<Env> {
  private book: StatusBook | null = null;

  /** The status: in memory, else its row (one row read), else built from the tables once. */
  private status(): StatusBook {
    if (this.book) return this.book;
    const saved = this.meta<StatusBook>('status');
    if (saved?.v === STATUS_V) return (this.book = saved);
    this.book = { v: STATUS_V, months: {}, jobs: [], census: this.censusRow(), indexing: [], indexWait: null };
    const all = this.ctx.storage.sql.exec<{ month: string }>(
      `SELECT month FROM gmail_months UNION SELECT month FROM months UNION SELECT month FROM basin_months UNION SELECT month FROM job_months`,
    );
    this.refreshMonths(all.toArray().map((r) => r.month));
    const jobs = this.ctx.storage.sql.exec<{ id: number }>(`SELECT id FROM jobs ORDER BY id DESC LIMIT ?`, JOBS_KEPT);
    this.refreshJobs(jobs.toArray().map((j) => j.id));
    console.log(JSON.stringify({ statusBuilt: { months: Object.keys(this.book.months).length, jobs: this.book.jobs.length } }));
    this.count({ do_rows_read: all.rowsRead + jobs.rowsRead, do_rows_written: this.saveStatus() });
    return this.book;
  }

  /** Save the status row. Returns rows written. */
  private saveStatus(): number {
    return this.putMeta('status', this.status());
  }

  /** Read these months' entries again from the tables: a keyed row from each of four, a month. */
  private refreshMonths(months: Iterable<string>): void {
    const book = this.status();
    const sql = this.ctx.storage.sql;
    const one = <T,>(query: string, month: string) => sql.exec<T & Record<string, SqlStorageValue>>(query, month).toArray()[0] as T | undefined;
    for (const month of new Set(months)) {
      const gmail = one<{ n: number }>(`SELECT n FROM gmail_months WHERE month = ?`, month);
      const index = one<{ n: number }>(`SELECT n FROM months WHERE month = ?`, month);
      const basin = one<{ copied: number; landed_at: string | null; indexed_at: string | null }>(`SELECT copied, landed_at, indexed_at FROM basin_months WHERE month = ?`, month);
      // The latest job to touch a month decides its state.
      const job = one<{ state: PartState; error: string | null; finished_at: string | null }>(
        `SELECT state, error, finished_at FROM job_months WHERE month = ? ORDER BY job DESC LIMIT 1`, month,
      );
      if (!gmail && !index && !basin && !job) {
        delete book.months[month];
        continue;
      }
      const indexed = index?.n ?? 0;
      const state = job?.state ?? null;
      book.months[month] = {
        month,
        gmail: gmail?.n ?? null,
        indexed,
        state,
        error: job?.error ?? null,
        finishedAt: job?.finished_at ?? null,
        // Months copied before Basin came first went to Basin and the index together.
        ...(basin
          ? {
              // Once indexed, Basin's count against Gmail's list of the month; the index counts by message date.
              copied: basin.indexed_at !== null ? basin.copied : Math.max(indexed, basin.copied),
              inBasin: basin.copied,
              landed: basin.landed_at !== null,
              indexState: basin.landed_at === null ? null : basin.indexed_at !== null ? 'done' : 'queued',
            }
          : { copied: indexed, inBasin: indexed, landed: indexed > 0 && state === 'done', indexState: null }),
      };
    }
  }

  /** Read these jobs again from the tables (a job's months, by its key) and keep the latest JOBS_KEPT. */
  private refreshJobs(ids: Iterable<number>): void {
    const book = this.status();
    const sql = this.ctx.storage.sql;
    for (const id of new Set(ids)) {
      book.jobs = book.jobs.filter((j) => j.id !== id);
      const j = sql.exec<{ id: number; created_at: string; label: string }>(`SELECT id, created_at, label FROM jobs WHERE id = ?`, id).toArray()[0];
      if (!j) continue;
      const months: Record<PartState, number> = { queued: 0, running: 0, done: 0, failed: 0, canceled: 0 };
      let from = '';
      let to = '';
      for (const r of sql.exec<{ state: PartState; n: number; first: string; last: string }>(
        `SELECT state, count(*) AS n, min(month) AS first, max(month) AS last FROM job_months WHERE job = ? GROUP BY state`,
        id,
      )) {
        months[r.state] = r.n;
        if (!from || r.first < from) from = r.first;
        if (r.last > to) to = r.last;
      }
      book.jobs.push({ id: j.id, createdAt: j.created_at, label: j.label, status: jobStatus(months), months, from, to });
    }
    book.jobs.sort((a, b) => b.id - a.id);
    book.jobs.length = Math.min(book.jobs.length, JOBS_KEPT);
  }

  /** Months and jobs changed: update their entries and save the status row. Returns rows written. */
  private changed(months: Iterable<string>, jobs: Iterable<number> = []): number {
    this.refreshMonths(months);
    this.refreshJobs(jobs);
    return this.saveStatus();
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.refillSearch();
      this.dropSample();
      await this.dropSpam();
      // A user's mailbox that just started (a deploy, say) doesn't know what is going on: the
      // watchdog looks within WATCH_MS, and keeps looking while something is.
      if (this.userId()) {
        const at = await ctx.storage.getAlarm();
        if (at === null || at > Date.now() + WATCH_MS) await ctx.storage.setAlarm(Date.now() + WATCH_MS);
      }
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
      for (const table of ['messages', 'senders', 'domains', 'months', 'labels']) sql.exec(`DELETE FROM ${table}`);
      sql.exec(`INSERT INTO message_fts (message_fts) VALUES ('delete-all')`);
      sql.exec(`DELETE FROM meta WHERE key = 'sample'`);
    });
  }

  /**
   * After migration 12: take Spam and Trash out of the index and its rollups, and delete their
   * raw files (live sync wrote one file a message). Raw files go first: if R2 fails, the flag
   * stays and the next start tries again. Basin keeps its rows.
   */
  private async dropSpam(): Promise<void> {
    const sql = this.ctx.storage.sql;
    if (!sql.exec(`SELECT 1 FROM meta WHERE key = 'drop_spam'`).toArray().length) return;
    const cursor = sql.exec<{ id: string; ts: number; from_addr: string; from_name: string; subject: string; snippet: string; size: number; labels: string }>(
      `SELECT id, ts, from_addr, from_name, subject, snippet, size, labels FROM messages
       WHERE ' ' || labels || ' ' LIKE '% SPAM %' OR ' ' || labels || ' ' LIKE '% TRASH %'`,
    );
    const rows = cursor.toArray();
    const read = cursor.rowsRead;
    const name = this.ctx.id.name ?? '';
    const at = name.lastIndexOf(':');
    if (rows.length && at > 0 && !name.endsWith(':default')) {
      try {
        const user = asUserId(name.slice(0, at));
        const account = name.slice(at + 1);
        const keys = rows.map((r) => r2Keys.raw(user, account, r.id));
        for (let i = 0; i < keys.length; i += 1000) await this.env.ARCHIVE.delete(keys.slice(i, i + 1000));
      } catch (e) {
        console.log(JSON.stringify({ dropSpam: { error: String(e) } }));
        return;
      }
    }
    this.ctx.storage.transactionSync(() => {
      let written = 0;
      const run = (query: string, ...args: (string | number)[]) => {
        written += sql.exec(query, ...args).rowsWritten;
      };
      const senders: Tally = new Map();
      const domains: Tally = new Map();
      const months: Tally = new Map();
      const labels: Tally = new Map();
      for (const r of rows) {
        run(
          `INSERT INTO message_fts (message_fts, rowid, subject, from_addr, from_name, snippet, labels) VALUES ('delete', CAST(? AS INTEGER), ?, ?, ?, ?, ?)`,
          ftsRowid(r.id), r.subject, r.from_addr, r.from_name, r.snippet, r.labels,
        );
        run(`DELETE FROM messages WHERE id = ?`, r.id);
        const m = { ts: r.ts, size: r.size } as IndexedMessage;
        tally(senders, r.from_addr.toLowerCase(), m);
        tally(domains, domainOf(r.from_addr), m);
        tally(months, monthOf(r.ts), m);
        for (const l of r.labels.split(' ').filter(Boolean)) tally(labels, l, m);
      }
      for (const [table, key, t] of [['senders', 'addr', senders], ['domains', 'domain', domains], ['months', 'month', months], ['labels', 'id', labels]] as const)
        for (const [k, x] of t) {
          run(`UPDATE ${table} SET n = n - ?, bytes = max(0, bytes - ?) WHERE ${key} = ?`, x.n, x.bytes, k);
          run(`DELETE FROM ${table} WHERE ${key} = ? AND n <= 0`, k);
        }
      run(`DELETE FROM meta WHERE key = 'drop_spam'`);
      if (rows.length) written += this.changed(months.keys());
      console.log(JSON.stringify({ dropSpam: { removed: rows.length, rowsRead: read, rowsWritten: written } }));
      this.count({ do_rows_read: read, do_rows_written: written });
    });
  }

  /** After migration 10: put every indexed message back in search. */
  private refillSearch(): void {
    const sql = this.ctx.storage.sql;
    if (!sql.exec(`SELECT 1 FROM meta WHERE key = 'fts_refill'`).toArray().length) return;
    this.ctx.storage.transactionSync(() => {
      let written = 0;
      for (const m of sql.exec<{ id: string; subject: string; from_addr: string; from_name: string; snippet: string; labels: string }>(
        `SELECT id, subject, from_addr, from_name, snippet, labels FROM messages`,
      ))
        written += sql.exec(
          `INSERT INTO message_fts (rowid, subject, from_addr, from_name, snippet, labels) VALUES (CAST(? AS INTEGER), ?, ?, ?, ?, ?)`,
          ftsRowid(m.id), m.subject, m.from_addr, m.from_name, m.snippet, m.labels,
        ).rowsWritten;
      written += sql.exec(`DELETE FROM meta WHERE key = 'fts_refill'`).rowsWritten;
      console.log(JSON.stringify({ refillSearch: { rowsWritten: written } }));
      this.count({ do_rows_written: written });
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

  /** Who paused backfill, kept in memory once read: every lane run asks, and this DO is the only writer. */
  private pausedKept: 'person' | 'budget' | null | undefined;

  /** Who paused backfill: the person ('true'), or the spend cap ('budget'); null when it runs. */
  private pausedBy(): 'person' | 'budget' | null {
    if (this.pausedKept === undefined) {
      const v = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'backfill_paused'`).toArray()[0]?.value;
      this.pausedKept = v === undefined ? null : v === 'budget' ? 'budget' : 'person';
    }
    return this.pausedKept;
  }

  /**
   * Pause or resume backfill. Resuming starts each account's sync again; lanes pick up where they
   * stood. `budget`: the spend cap paused it (a person's pause is kept as theirs). Returns false
   * when a resume was refused because spend is still past the cap's stop line.
   */
  async setBackfillPaused(paused: boolean, budget = false): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    // Paused at the spend cap: resuming is refused while spend is still past the stop line.
    if (!paused && this.pausedBy() === 'budget' && (await accountQuota(this.env).overBudget({}))) return false;
    const { rowsWritten } = paused
      ? sql.exec(`INSERT INTO meta (key, value) VALUES ('backfill_paused', ?) ON CONFLICT (key) DO NOTHING`, budget ? 'budget' : 'true')
      : sql.exec(`DELETE FROM meta WHERE key = 'backfill_paused'`);
    this.pausedKept = undefined;
    if (rowsWritten) this.count({ do_rows_written: rowsWritten });
    if (paused || !this.env.BASIN_TOKEN) return true;
    await this.watch();
    for (const { id } of sql.exec<{ id: string }>(`SELECT id FROM accounts`).toArray()) {
      try {
        await this.syncAccount(id, true);
      } catch (e) {
        console.error('resume sync', id, e);
      }
    }
    return true;
  }

  /** This account's sync progress, or null before its first sync. */
  async syncState(): Promise<SyncState | null> {
    return structuredClone(this.syncState0());
  }

  /** The sync state, kept in memory once read (this DO is its only writer; putMeta drops it). */
  private syncKept: SyncState | null | undefined;
  private syncState0(): SyncState | null {
    if (this.syncKept === undefined) this.syncKept = this.meta<SyncState>('sync');
    return this.syncKept;
  }

  /**
   * The sync as the page shows it: what's saved, plus what lanes have copied of months not landed
   * yet (they report it from memory, not rows), and when they last checked in.
   */
  async syncView(): Promise<SyncState | null> {
    const s = await this.syncState();
    if (!s || !this.live.size) return s;
    const lanes = [...this.live.values()];
    const at = Math.max(Date.parse(s.updatedAt), ...lanes.map((l) => l.at));
    return {
      ...s,
      copied: s.copied + lanes.reduce((n, l) => n + l.copied, 0),
      bytes: s.bytes + lanes.reduce((n, l) => n + l.bytes, 0),
      updatedAt: new Date(at).toISOString(),
      recent: this.samples.length ? this.samples : s.recent,
    };
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
    if (!row) return null;
    const value = JSON.parse(row.value) as T;
    // Syncs saved before the rename call waiting for a daily limit 'paused'.
    if (key === 'sync' && (value as { phase?: string }).phase === 'paused') (value as { phase: string }).phase = 'waiting';
    return value;
  }

  private putMeta(key: string, value: unknown): number {
    if (key === 'sync') this.syncKept = undefined;
    return this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key, JSON.stringify(value),
    ).rowsWritten;
  }

  /** The months lanes are copying (meta `lane:<month>` → job), kept in memory once read: the DO is their only writer. */
  private laneJobs: Map<string, number> | null = null;

  private lanes(): Map<string, number> {
    if (!this.laneJobs) {
      const rows = this.ctx.storage.sql.exec<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key LIKE 'lane:%'`).toArray();
      // A lane from before the copy engine kept its sync state here, with its month's job as `part`.
      this.laneJobs = new Map(rows.map((r) => {
        const v = JSON.parse(r.value) as { job?: number; part?: SyncPart };
        return [r.key.slice('lane:'.length), v.job ?? v.part?.job ?? 0];
      }));
    }
    return this.laneJobs;
  }

  /** Close a lane: its month landed, failed or was taken out of the queue. */
  async endLane(month: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      let written = this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = ?`, `lane:${month}`).rowsWritten;
      this.lanes().delete(month);
      this.live.delete(month);
      written += this.setLanes();
      this.count({ do_rows_written: written });
    });
  }

  /** Keep the sync's list of lanes in step with the lanes there are. */
  private setLanes(): number {
    const main = this.meta<SyncState>('sync');
    if (!main) return 0;
    this.syncKept = undefined;
    return this.putMeta('sync', { ...main, lanes: [...this.lanes().keys()].sort().reverse() });
  }

  /**
   * Start lanes for queued months, newest first, until `max` run at once, and take over lanes
   * that stopped (their run died, or backfill was paused). Each lane's progress is an R2 file
   * (copy.ts); this writes a row only when a month starts or ends. Returns each lane to start.
   */
  async claimLanes(user: UserId, account: string, max: number): Promise<{ month: string; runId: string }[]> {
    this.laneUser = user;
    this.laneAccount = account;
    const sql = this.ctx.storage.sql;
    // A lane whose month was stopped while nothing ran to notice (its run had died) comes off now.
    // From the status row: no row read per lane per poll.
    const book = this.status();
    const stopped = [...this.lanes().keys()].filter((month) => book.months[month]?.state === 'canceled');
    if (stopped.length) await this.stopLanes(stopped);
    const now = Date.now();
    const id = (month: string) => `${account}-${month}-${now.toString(36)}`;
    const lanes = this.lanes();
    const fresh: { part: SyncPart; prior: boolean }[] = [];
    if (lanes.size < max && !this.noneQueued)
      this.ctx.storage.transactionSync(() => {
        let written = 0;
        const parts = sql
          .exec<{ job: number; month: string; prior: number | null }>(
            `SELECT j.job, j.month, b.copied AS prior FROM job_months j LEFT JOIN basin_months b ON b.month = j.month
             WHERE j.state IN ('running', 'queued') ORDER BY j.month DESC, j.job`,
          )
          .toArray();
        const busy = new Set(lanes.keys());
        for (const p of parts) {
          if (lanes.size >= max) break;
          if (busy.has(p.month)) continue;
          busy.add(p.month);
          written += sql.exec(`UPDATE job_months SET state = 'running' WHERE job = ? AND month = ? AND state = 'queued'`, p.job, p.month).rowsWritten;
          written += this.putMeta(`lane:${p.month}`, { job: p.job, month: p.month });
          lanes.set(p.month, p.job);
          fresh.push({ part: { job: p.job, month: p.month }, prior: (p.prior ?? 0) > 0 });
        }
        // Nothing else waits: later checks skip the query until a month is queued.
        if (parts.every((p) => busy.has(p.month))) this.noneQueued = true;
        if (fresh.length) {
          this.active = null;
          written += this.setLanes();
          written += this.changed(fresh.map((f) => f.part.month), fresh.map((f) => f.part.job));
        }
        if (written) this.count({ do_rows_written: written });
      });
    const out: { month: string; runId: string }[] = [];
    for (const f of fresh) {
      const runId = id(f.part.month);
      const got = await readLane(this.env, user, account, f.part.month);
      // A lane that ended on this month and wasn't settled yet: keep its IDs before starting afresh.
      if (got?.p.ended) await rememberCopied(this.env, user, account, f.part.month, got.p.copiedIds);
      if (await saveLane(this.env, user, account, freshLane(f.part, runId, f.prior), got?.etag ?? null)) out.push({ month: f.part.month, runId });
    }
    // A lane that checked in lately is running. One that hasn't (or stopped for a pause) starts again where it stood.
    const started = new Set(fresh.map((f) => f.part.month));
    for (const [month, job] of lanes) {
      if (started.has(month)) continue;
      const beat = this.live.get(month);
      if (beat && now - beat.at < LANE_STALE_MS && !beat.stopped) continue;
      const got = await readLane(this.env, user, account, month);
      if (got && !got.p.runId) continue; // all copied: the committer lands it
      if (got && !got.p.stopped && now - Date.parse(got.p.updatedAt) < LANE_STALE_MS) continue;
      const runId = id(month);
      const prior = (sql.exec<{ copied: number }>(`SELECT copied FROM basin_months WHERE month = ?`, month).toArray()[0]?.copied ?? 0) > 0;
      const next = got ? { ...got.p, runId, prev: null, stopped: null, updatedAt: new Date(now).toISOString() } : freshLane({ job, month }, runId, prior);
      if (await saveLane(this.env, user, account, next, got?.etag ?? null)) {
        this.live.delete(month);
        out.push({ month, runId });
      }
    }
    return out;
  }

  /** Whose account this object is, as lanes and the user's object tell it (to find lane files). */
  private laneUser: UserId | null = null;
  private laneAccount: string | null = null;
  /**
   * Start a run from this object's alarm instead of from the run before it. Workers counts a
   * run started by a run as nested in it, and refuses R2 and DO calls about ten deep, so a chain
   * of runs that start each other dies after about ten. The hand-over is stored (`launch:<id>`)
   * so a deploy or restart before the alarm fires doesn't lose it. Costs the alarm plus two rows
   * (the key written, then deleted) a run.
   */
  async launchLater(id: string, params: SyncParams): Promise<void> {
    await this.ctx.storage.put(`launch:${id}`, params);
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Nothing is queued that a lane isn't copying; reset whenever a month is queued. */
  private noneQueued = false;
  /** Backfill months waiting or being copied, by state; read once, then kept with every change. */
  private active: Map<string, PartState> | null = null;
  /** What each lane last reported, in memory only: shown on the map and the sync card while it copies. */
  private live = new Map<string, { at: number; runId: string; copied: number; bytes: number; stopped?: boolean }>();
  /** Copy-rate samples (total copied over time), in memory only. */
  private samples: { at: string; copied: number }[] = [];
  /** Size copied (as Gmail counts it), one point a minute for the last hour, in memory only: the Size tile's sparkline. */
  private sizes: { at: string; bytes: number }[] = [];
  /** Gmail pacing for this account, msgvault's way: a token bucket that halves on a rate limit and recovers. */
  private bucket = { level: BUCKET.cap, at: 0, rate: BUCKET.rate, calmAt: 0 };
  /** Lanes with a batch in flight, until their next turn (or 30 s, if a run died mid-batch). */
  private flight = new Map<string, number>();
  private access: { token: string; until: number } | null = null;

  private activeMonths(): Map<string, PartState> {
    if (!this.active) {
      const cursor = this.ctx.storage.sql.exec<{ month: string; state: PartState }>(`SELECT month, state FROM job_months WHERE state IN ('queued', 'running')`);
      this.active = new Map(cursor.toArray().map((r) => [r.month, r.state]));
      this.count({ do_rows_read: cursor.rowsRead });
    }
    return this.active;
  }

  /** Job months changed: what's kept about the active ones is read again when next asked. */
  private changedMonths(): void {
    this.active = null;
    this.noneQueued = false;
  }

  /** Take Gmail units from the bucket; the answer is how long to wait first. */
  private pace(units: number, throttled: boolean, now = Date.now()): number {
    const b = this.bucket;
    if (throttled) {
      b.rate = Math.max(BUCKET.min, b.rate / 2);
      b.calmAt = now + BUCKET.calmMs;
    } else if (b.rate < BUCKET.rate && now >= b.calmAt) {
      b.rate = Math.min(BUCKET.rate, b.rate + BUCKET.step);
      b.calmAt = now + BUCKET.calmMs;
    }
    b.level = Math.min(BUCKET.cap, b.level + (b.at ? ((now - b.at) / 1000) * b.rate : 0));
    b.at = now;
    b.level -= units;
    return b.level >= 0 ? 0 : Math.ceil((-b.level / b.rate) * 1000);
  }

  /**
   * A lane's turn before each Gmail batch, answered from memory: an access token, whether the
   * month is still queued, and how long to wait for Gmail's rate. It records what the lane has
   * copied, for the page. Reads no rows (job months are read once, then kept). A turn ends the
   * lane's last batch; one with units starts the next, unless FLIGHT batches are already out
   * (then `busy`: ask again after waitMs).
   */
  async laneTurn(t: { user: UserId; account: string; month: string; runId: string; units: number; throttled: boolean; copied: number; bytes: number }): Promise<{ token: string | null; active: boolean; waitMs: number; busy?: boolean; error?: string }> {
    const now = Date.now();
    this.laneUser = t.user;
    this.laneAccount = t.account;
    this.flight.delete(t.month);
    for (const [month, until] of this.flight) if (until < now) this.flight.delete(month);
    const active = this.activeMonths().get(t.month) === 'running';
    const before = this.live.get(t.month);
    this.live.set(t.month, { at: now, runId: t.runId, copied: t.copied, bytes: t.bytes });
    if (t.copied !== (before?.copied ?? 0)) this.sample(now);
    if (!active) return { token: null, active, waitMs: 0 };
    if (!this.access || this.access.until < now + 60_000) {
      const refresh = await this.env.MAILBOX.getByName(mailboxName(t.user)).accountToken(t.account);
      if (!refresh) return { token: null, active, waitMs: 0, error: 'This account was removed from MailCellar.' };
      try {
        this.access = { token: await accessToken(this.env, refresh), until: now + 50 * 60_000 };
      } catch (e) {
        if (e instanceof GmailError && e.status === 401) return { token: null, active, waitMs: 0, error: e.message };
        throw e;
      }
    }
    if (t.units && this.flight.size >= FLIGHT) {
      if (t.throttled) this.pace(0, true, now);
      return { token: this.access.token, active, waitMs: 250, busy: true };
    }
    if (t.units) this.flight.set(t.month, now + 30_000);
    return { token: this.access.token, active, waitMs: this.pace(t.units, t.throttled, now) };
  }

  /** Add a copy-rate sample: everything copied so far, the lanes' unlanded months included. */
  private sample(now: number): void {
    const main = this.syncState0();
    if (!main) return;
    const copied = main.copied + [...this.live.values()].reduce((n, l) => n + l.copied, 0);
    const at = new Date(now).toISOString();
    const last = this.samples.at(-1);
    if (last && now - Date.parse(last.at) < 10_000) last.copied = copied;
    else this.samples = withRecent({ ...main, copied, recent: this.samples }, at);
    const bytes = main.bytes + [...this.live.values()].reduce((n, l) => n + l.bytes, 0);
    const point = this.sizes.at(-1);
    if (point && now - Date.parse(point.at) < SIZE_STEP_MS) point.bytes = bytes;
    else this.sizes = [...this.sizes.filter((p) => now - Date.parse(p.at) < SIZE_WINDOW_MS), { at, bytes }];
  }

  /** Every indexed message of a year, as ID, date and labels (reads only): for an audit against Gmail. */
  async indexedIn(year: string): Promise<{ id: string; ts: number; labels: string }[]> {
    const after = Date.parse(`${year}-01-01T00:00:00Z`);
    const before = Date.parse(`${Number(year) + 1}-01-01T00:00:00Z`);
    const cursor = this.ctx.storage.sql.exec<{ id: string; ts: number; labels: string }>(`SELECT id, ts, labels FROM messages WHERE ts >= ? AND ts < ?`, after, before);
    const rows = cursor.toArray();
    this.count({ do_rows_read: cursor.rowsRead });
    return rows;
  }

  /** Of these message IDs, the ones not in the index yet (reads only). */
  async unknownIds(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const cursor = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
    const known = new Set(cursor.toArray().map((r) => r.id));
    this.count({ do_rows_read: cursor.rowsRead });
    return ids.filter((id) => !known.has(id));
  }

  /**
   * A month's backfill has landed in Basin: the month is done, its index can be built, and what
   * the lane copied is added to the month and the account's sync. A few rows, once a month.
   */
  async landMonth(part: SyncPart, added: { copied: number; bytes: number } = { copied: 0, bytes: 0 }): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      let written = this.ctx.storage.sql.exec(
        `INSERT INTO basin_months (month, copied, landed_at) VALUES (?, ?, ?)
         ON CONFLICT (month) DO UPDATE SET copied = copied + excluded.copied, landed_at = excluded.landed_at, indexed_at = NULL`,
        part.month, added.copied, new Date().toISOString(),
      ).rowsWritten;
      written += this.ctx.storage.sql.exec(`UPDATE job_months SET state = 'done', error = NULL, finished_at = ? WHERE job = ? AND month = ? AND state = 'running'`, new Date().toISOString(), part.job, part.month).rowsWritten;
      const main = this.meta<SyncState>('sync');
      if (main && added.copied) written += this.putMeta('sync', { ...main, copied: main.copied + added.copied, bytes: main.bytes + added.bytes, updatedAt: new Date().toISOString() });
      this.live.delete(part.month);
      this.changedMonths();
      written += this.changed([part.month], [part.job]);
      this.count({ do_rows_written: written });
    });
  }

  /**
   * Count senders, domains and labels again from every indexed message, writing only the rows
   * that changed: after the index is built from Basin, which leaves them out (ingest).
   */
  async rebuildRollups(): Promise<{ rowsRead: number; rowsWritten: number }> {
    const sql = this.ctx.storage.sql;
    const senders: Tally = new Map();
    const domains: Tally = new Map();
    const labels: Tally = new Map();
    const cursor = sql.exec<{ from_addr: string; from_name: string; ts: number; size: number; labels: string }>(
      `SELECT from_addr, from_name, ts, size, labels FROM messages`,
    );
    for (const r of cursor) {
      const m = { ts: r.ts, size: r.size } as IndexedMessage;
      const addr = r.from_addr.toLowerCase();
      const before = senders.get(addr);
      tally(senders, addr, m, r.from_name);
      if (before && r.ts >= before.last) senders.get(addr)!.name = r.from_name;
      tally(domains, domainOf(r.from_addr), m);
      for (const l of r.labels.split(' ').filter(Boolean)) tally(labels, l, m);
    }
    let written = 0;
    this.ctx.storage.transactionSync(() => {
      const run = (query: string, ...args: (string | number)[]) => {
        written += sql.exec(query, ...args).rowsWritten;
      };
      for (const [addr, t] of senders)
        run(
          `INSERT INTO senders VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (addr) DO UPDATE SET
             name = excluded.name, n = excluded.n, bytes = excluded.bytes, first_ts = excluded.first_ts, last_ts = excluded.last_ts
           WHERE n != excluded.n OR bytes != excluded.bytes OR name != excluded.name`,
          addr, t.name, t.n, t.bytes, t.first, t.last,
        );
      for (const [domain, t] of domains)
        run(
          `INSERT INTO domains VALUES (?, ?, ?) ON CONFLICT (domain) DO UPDATE SET n = excluded.n, bytes = excluded.bytes
           WHERE n != excluded.n OR bytes != excluded.bytes`,
          domain, t.n, t.bytes,
        );
      for (const [id, t] of labels)
        run(
          `INSERT INTO labels VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET n = excluded.n, bytes = excluded.bytes
           WHERE n != excluded.n OR bytes != excluded.bytes`,
          id, id, /^[A-Z_]+$/.test(id) ? 'system' : 'user', t.n, t.bytes,
        );
    });
    this.count({ do_rows_read: cursor.rowsRead, do_rows_written: written });
    return { rowsRead: cursor.rowsRead, rowsWritten: written };
  }

  /** Messages in the index, from the status row. */
  async indexedCount(): Promise<number> {
    return this.indexedTotal();
  }

  private indexedTotal(): number {
    return Object.values(this.status().months).reduce((t, m) => t + m.indexed, 0);
  }

  /** Take a month out of the index, to build it again from Basin. Rollups follow at the next rebuildRollups. */
  async unindexMonth(month: string): Promise<{ removed: number; rowsWritten: number }> {
    const sql = this.ctx.storage.sql;
    const after = Date.parse(`${month}-01T00:00:00Z`);
    const before = Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`);
    return this.ctx.storage.transactionSync(() => {
      let written = 0;
      const rows = sql
        .exec<{ id: string; subject: string; from_addr: string; from_name: string; snippet: string; labels: string }>(
          `SELECT id, subject, from_addr, from_name, snippet, labels FROM messages WHERE ts >= ? AND ts < ?`, after, before,
        )
        .toArray();
      for (const m of rows)
        written += sql.exec(
          `INSERT INTO message_fts (message_fts, rowid, subject, from_addr, from_name, snippet, labels) VALUES ('delete', CAST(? AS INTEGER), ?, ?, ?, ?, ?)`,
          ftsRowid(m.id), m.subject, m.from_addr, m.from_name, m.snippet, m.labels,
        ).rowsWritten;
      written += sql.exec(`DELETE FROM messages WHERE ts >= ? AND ts < ?`, after, before).rowsWritten;
      written += sql.exec(`DELETE FROM months WHERE month = ?`, month).rowsWritten;
      written += sql.exec(`UPDATE basin_months SET indexed_at = NULL WHERE month = ?`, month).rowsWritten;
      const book = this.status();
      if (!book.indexing.includes(month)) book.indexing.push(month);
      written += this.changed([month]);
      this.count({ do_rows_written: written });
      return { removed: rows.length, rowsWritten: written };
    });
  }

  /**
   * The month's search index has been built from Basin, which has `inBasin` messages for it. The
   * lanes' count can be off by one or two (a message copied twice is one row in search), so
   * Basin's own count replaces it: the month is done, not left Indexing for a message it has.
   */
  async markIndexed(month: string, inBasin: number): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      let written = this.ctx.storage.sql.exec(
        `UPDATE basin_months SET indexed_at = ?, copied = ? WHERE month = ?`, new Date().toISOString(), inBasin, month,
      ).rowsWritten;
      const book = this.status();
      book.indexing = book.indexing.filter((m) => m !== month);
      if (!book.indexing.length) book.indexWait = null;
      written += this.changed([month]);
      this.count({ do_rows_written: written });
    });
  }

  /**
   * An index run for `month` has started: the page shows it indexing while the run reads the
   * month back from Basin, before its first chunk lands. Held in memory only, so it writes no
   * row; the first chunk saves it with the status.
   */
  async indexStarted(month: string): Promise<void> {
    const book = this.status();
    if (!book.indexing.includes(month)) book.indexing.push(month);
  }

  /**
   * Indexing `month` waits for the account's daily DO write limit (`label`) until `resumesAt`.
   * Copying goes on; the page shows indexing as waiting. The next index chunk clears it.
   */
  async indexWaiting(month: string, resumesAt: string, label: string): Promise<void> {
    const book = this.status();
    if (!book.indexing.includes(month)) book.indexing.push(month);
    book.indexWait = { resumesAt, label };
    this.count({ do_rows_written: this.saveStatus() });
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

  /** Give indexed labels Gmail's current names; writes only the rows whose name changed. */
  async nameLabels(labels: GmailLabels): Promise<void> {
    const sql = this.ctx.storage.sql;
    let written = 0;
    this.ctx.storage.transactionSync(() => {
      for (const [id, l] of Object.entries(labels))
        written += sql.exec(`UPDATE labels SET name = ?, type = ? WHERE id = ? AND (name IS NOT ? OR type IS NOT ?)`, l.name, l.type, id, l.name, l.type).rowsWritten;
    });
    if (written) this.count({ do_rows_written: written });
  }

  /** Backfill months waiting or being copied. */
  async activeList(): Promise<string[]> {
    return [...this.activeMonths().keys()].sort();
  }

  /** Whether any backfill month is waiting to be copied. */
  async hasQueued(): Promise<boolean> {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM job_months WHERE state IN ('queued', 'running') LIMIT 1`).toArray().length > 0;
  }

  /** Whether any month has mail in Basin its search index hasn't been built for yet. */
  async indexPending(): Promise<boolean> {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM basin_months WHERE copied > 0 AND indexed_at IS NULL LIMIT 1`).toArray().length > 0;
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
    if (rowsWritten) {
      this.changedMonths();
      this.count({ do_rows_written: rowsWritten + this.changed([row.month], [row.job]) });
    }
    return { job: row.job, month: row.month };
  }

  /** Close a running backfill month as done or failed. A canceled month stays canceled. */
  async finishPart(part: SyncPart, state: 'done' | 'failed', error: string | null = null): Promise<void> {
    const { rowsWritten } = this.ctx.storage.sql.exec(
      `UPDATE job_months SET state = ?, error = ?, finished_at = ? WHERE job = ? AND month = ? AND state = 'running'`,
      state, error, new Date().toISOString(), part.job, part.month,
    );
    if (rowsWritten) {
      this.changedMonths();
      this.count({ do_rows_written: rowsWritten + this.changed([part.month], [part.job]) });
    }
  }

  /** The census's progress, or null before the first (from the status row). */
  async censusState(): Promise<CensusState | null> {
    return structuredClone(this.status().census);
  }

  /** Save census progress; with `onlyIf`, only while that run owns it. Returns whether it saved. */
  async saveCensus(state: CensusState, onlyIf?: string): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      if (onlyIf !== undefined && (this.status().census?.runId ?? null) !== onlyIf) return false;
      this.ctx.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('census', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        JSON.stringify(state),
      );
      this.status().census = structuredClone(state);
      this.count({ do_rows_written: 1 + this.saveStatus() });
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
    this.count({ do_rows_written: rowsWritten + this.changed([month]) });
  }

  /**
   * Each month's Gmail count, copied count, copy and index state, oldest first. From the status
   * row and the lanes' reports in memory: reads no table.
   */
  async coverageMonths(): Promise<MonthCoverage[]> {
    const book = this.status();
    await this.liveFromFiles();
    const wait = book.indexWait && Date.parse(book.indexWait.resumesAt) > Date.now() ? book.indexWait : null;
    return Object.values(book.months)
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((s) => {
        const m: MonthCoverage = { ...s };
        // Lanes report what they've copied from memory; a month shows it until it lands.
        const l = this.live.get(m.month);
        if (l) m.copied = Math.max(m.copied, m.inBasin + l.copied);
        m.copyState = m.state === 'running' ? 'copying' : m.state === 'canceled' ? 'stopped' : m.state;
        if (m.indexState === 'queued' && book.indexing.includes(m.month)) {
          m.indexState = wait ? 'waiting' : 'indexing';
          if (wait) m.resumesAt = wait.resumesAt;
        }
        return m;
      });
  }

  /**
   * Everything the Backfill page shows for this mailbox, from the status row and memory: its
   * sync, census, months, jobs and index state. Reads no table.
   */
  async statusView(): Promise<{
    sync: SyncState | null;
    census: CensusState | null;
    months: MonthCoverage[];
    jobs: BackfillJob[];
    indexed: number;
    index: { status: 'indexing' | 'waiting' | 'idle'; pausedFor?: string; resumesAt?: string };
    sizes: { at: string; bytes: number }[];
  }> {
    const book = this.status();
    const wait = book.indexWait && Date.parse(book.indexWait.resumesAt) > Date.now() ? book.indexWait : null;
    return {
      sync: await this.syncView(),
      census: structuredClone(book.census),
      months: await this.coverageMonths(),
      jobs: structuredClone(book.jobs),
      indexed: this.indexedTotal(),
      sizes: this.sizes.filter((p) => Date.now() - Date.parse(p.at) < SIZE_WINDOW_MS),
      index: wait
        ? { status: 'waiting', pausedFor: wait.label, resumesAt: wait.resumesAt }
        : { status: book.indexing.length ? 'indexing' : 'idle' },
    };
  }

  /** A lane not heard from since this object started (its run died, or the object restarted): its progress from its R2 file. */
  private async liveFromFiles(): Promise<void> {
    const user = this.laneUser;
    if (!user) return;
    for (const month of this.lanes().keys()) {
      if (this.live.has(month)) continue;
      const got = await readLane(this.env, user, this.laneAccount!, month);
      this.live.set(month, { at: got ? Date.parse(got.p.updatedAt) : 0, runId: got?.p.runId ?? '', copied: got?.p.copied ?? 0, bytes: got?.p.bytes ?? 0 });
    }
  }

  /**
   * Take lanes off months that were stopped. What they copied is counted for the month (the
   * committer still adds their staged rows to Basin), so a month queued again skips it.
   */
  private async stopLanes(months: string[]): Promise<void> {
    const user = this.laneUser;
    const stopped = months.filter((m) => this.lanes().has(m));
    if (!stopped.length) return;
    await this.liveFromFiles();
    for (const month of stopped) {
      const copied = this.live.get(month)?.copied ?? 0;
      if (copied) {
        const { rowsWritten } = this.ctx.storage.sql.exec(
          `INSERT INTO basin_months (month, copied) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET copied = copied + excluded.copied`,
          month, copied,
        );
        this.count({ do_rows_written: rowsWritten + this.changed([month]) });
      }
      await this.endLane(month);
      // The file stays, ended: the committer settles what the lane staged (copy.ts, settleMonth).
      if (user) await endLaneFile(this.env, user, this.laneAccount!, month);
    }
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
      this.changedMonths();
      this.count({ do_rows_written: fresh.length + 1 + this.changed(fresh, [job]) });
      return job;
    });
  }

  /** The latest backfill jobs, newest first (from the status row). */
  async jobList(limit = JOBS_KEPT): Promise<BackfillJob[]> {
    return structuredClone(this.status().jobs.slice(0, limit));
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
    const rows = cursor.toArray() as { month: string }[];
    const changed = rows.length;
    if (changed) {
      this.changedMonths();
      this.count({ do_rows_written: cursor.rowsWritten + this.changed(rows.map((r) => r.month), [job]) });
      if (action === 'cancel') await this.stopLanes(rows.map((r) => r.month));
    }
    return changed;
  }

  /** Take months out of the queue, failed ones included (all of them when `months` is null). Mail already copied stays. Returns months changed. */
  async unqueueMonths(months: string[] | null): Promise<number> {
    const sql = this.ctx.storage.sql;
    const cursor = months
      ? sql.exec(`UPDATE job_months SET state = 'canceled' WHERE state IN ('queued', 'running', 'failed') AND month IN (SELECT value FROM json_each(?)) RETURNING job, month`, JSON.stringify(months))
      : sql.exec(`UPDATE job_months SET state = 'canceled' WHERE state IN ('queued', 'running', 'failed') RETURNING job, month`);
    const rows = cursor.toArray() as { job: number; month: string }[];
    const changed = rows.length;
    if (changed) {
      this.changedMonths();
      this.count({ do_rows_written: cursor.rowsWritten + this.changed(rows.map((r) => r.month), rows.map((r) => r.job)) });
      await this.stopLanes(rows.map((r) => r.month));
    }
    return changed;
  }

  /**
   * Index a batch of messages in one transaction. Messages already indexed are skipped,
   * so a retried batch never double-counts. Rollups are written once a batch, not once a
   * message, which S4 measured at a third of the write budget. Without `rollups` (the index
   * built from Basin) only the month count is kept up; rebuildRollups adds the rest once,
   * when backfill is done, since a sender in every month would be written once a month.
   */
  async ingest(batch: IndexedMessage[], rollups = true): Promise<IngestResult> {
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
      // Find what's indexed already with one keyed read a message: an insert that conflicts reads
      // about seven rows, so indexing a month again (a recount) cost seven reads a message for nothing.
      const have = new Set<string>();
      for (let i = 0; i < batch.length; i += 100) {
        const ids = batch.slice(i, i + 100).map((m) => m.id);
        for (const r of sql.exec<{ id: string }>(`SELECT id FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)) have.add(r.id);
      }
      for (const m of batch) {
        if (have.has(m.id) || notKept(m.labels)) continue;
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
        tally(months, monthOf(m.ts), m);
        if (!rollups) continue;
        tally(senders, m.fromAddr.toLowerCase(), m, m.fromName);
        tally(domains, domainOf(m.fromAddr), m);
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
      // A label Gmail has not named yet keeps its ID as its name until putLabels or nameLabels runs.
      for (const [id, t] of labels)
        run(
          `INSERT INTO labels VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET
             n = n + excluded.n, bytes = bytes + excluded.bytes`,
          id, id, /^[A-Z_]+$/.test(id) ? 'system' : 'user', t.n, t.bytes,
        );
      const added = addedIds.length;
      // Built from Basin (no rollups): the batch's months are indexing, and no longer waiting.
      const touched = new Set(batch.map((m) => monthOf(m.ts)));
      if (added || (!rollups && batch.length)) {
        const book = this.status();
        if (!rollups) {
          for (const m of touched) if (!book.indexing.includes(m)) book.indexing.push(m);
          book.indexWait = null;
        }
        rowsWritten += this.changed(added ? touched : []);
        this.count({ messages_indexed: added, do_rows_written: rowsWritten });
      }
      return { added, skipped: batch.length - added, rowsWritten, addedIds };
    });
  }

  /**
   * Add to today's usage. Rows written includes this call's own writes, one a metric,
   * so the meter never under-reports what the free tier counts.
   */
  private count(usage: Partial<Record<UsageMetric, number>>) {
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

  /**
   * One page of Messages groups, largest first, from the rollups: no message is read. Counts are
   * the rollup's, so they hold for the whole mailbox only: under other filters each is null.
   * Senders and domains page on their n index, GROUPS_PAGE at a time; the rest come whole.
   */
  async messageGroups(by: MessageGroupBy, filtered: boolean, after: string | null): Promise<MessageGroups> {
    const sql = this.ctx.storage.sql;
    let read = 0;
    const exec = <R extends Record<string, SqlStorageValue>>(query: string, ...args: (string | number)[]) => {
      const c = sql.exec<R>(query, ...args);
      read += c.rowsRead;
      return c.toArray();
    };
    const all = this.indexedTotal();
    const count = (n: number) => (filtered ? null : n);
    let groups: MessageGroup[] = [];
    let next: string | null = null;
    if (by === 'from' || by === 'domain') {
      const [table, key] = by === 'from' ? ['senders', 'addr'] : ['domains', 'domain'];
      // The cursor is the last group's (n, key): shaped like a Size cursor, (number, string).
      const at = after ? decodeCursor(after, 'size') : null;
      const got = exec<{ k: string; n: number }>(
        `SELECT ${key} AS k, n FROM ${table} WHERE n > 0 ${at ? `AND (n, ${key}) < (?, ?)` : ''} ORDER BY n DESC, ${key} DESC LIMIT ?`,
        ...(at ? [at[0], at[1]] : []),
        GROUPS_PAGE + 1,
      );
      if (got.length > GROUPS_PAGE) {
        got.length = GROUPS_PAGE;
        next = JSON.stringify([got[GROUPS_PAGE - 1].n, got[GROUPS_PAGE - 1].k]);
      }
      groups = got.map((g) => ({ key: g.k, n: count(g.n), filter: { key: by, values: [g.k], ...(by === 'from' ? { op: 'eq' as const } : {}) } }));
    } else if (by === 'label') {
      groups = exec<{ id: string; name: string; n: number }>(`SELECT id, name, n FROM labels WHERE type = 'user' AND n > 0 ORDER BY n DESC`).map((l) => ({
        key: l.name,
        n: count(l.n),
        filter: { key: 'label', values: [l.id] },
      }));
    } else {
      const ids = by === 'category' ? CATEGORY_IDS : ['UNREAD'];
      const n = new Map(exec<{ id: string; n: number }>(`SELECT id, n FROM labels WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids).map((r) => [r.id, r.n]));
      const sum = ids.reduce((t, id) => t + (n.get(id) ?? 0), 0);
      groups =
        by === 'category'
          ? [
              { key: 'Primary', n: count(Math.max(0, all - sum)), filter: { key: 'label', values: ids, not: true } },
              ...ids.map((id) => ({ key: categoryName(id), n: count(n.get(id) ?? 0), filter: { key: 'label' as const, values: [id] } })),
            ]
          : [
              { key: 'Unread', n: count(sum), filter: { key: 'label', values: ['UNREAD'] } },
              { key: 'Read', n: count(Math.max(0, all - sum)), filter: { key: 'label', values: ['UNREAD'], not: true } },
            ];
      if (!filtered) groups = groups.filter((g) => g.n !== 0).sort((a, b) => (b.n ?? 0) - (a.n ?? 0));
    }
    this.count({ do_rows_read: read });
    return { groups, next };
  }

  /** Sorts this mailbox can serve now; null until read from the schema. */
  private sortsReady: Set<MessageSort> | null = null;
  private sortsTried = 0;

  /**
   * The orders Messages can ask for: Date, and each sort index built. A missing index is built
   * when the day's DO writes have room for it (one write per message indexed), tried at most
   * every 5 minutes, so a mailbox with mail already indexed gets it within the daily limit.
   */
  async buildSorts(): Promise<MessageSort[]> {
    const sql = this.ctx.storage.sql;
    if (!this.sortsReady) {
      const have = new Set(
        sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('messages_from', 'messages_size')`).toArray().map((r) => r.name),
      );
      this.sortsReady = new Set<MessageSort>(['date', ...SORT_INDEXES.filter((x) => have.has(x.name)).map((x) => x.sort)]);
    }
    const ready = this.sortsReady;
    const missing = SORT_INDEXES.filter((x) => !ready.has(x.sort));
    if (missing.length && Date.now() - this.sortsTried >= 5 * 60_000) {
      this.sortsTried = Date.now();
      const quota = accountQuota(this.env);
      for (const x of missing) {
        if (await quota.reserve({ do_rows_written: this.indexedTotal() + 100 })) break;
        const c = sql.exec(x.create);
        this.count({ do_rows_written: c.rowsWritten, do_rows_read: c.rowsRead });
        await quota.add({ do_rows_written: c.rowsWritten, do_rows_read: c.rowsRead });
        console.log(JSON.stringify({ sortIndex: { name: x.name, rowsWritten: c.rowsWritten, rowsRead: c.rowsRead } }));
        ready.add(x.sort);
      }
    }
    return MESSAGE_SORTS.filter((s) => ready.has(s));
  }

  /**
   * One page of messages under the Messages page's filters, keyset-paged over the index of the
   * order asked for: (ts, id), (from_addr, ts, id) or (size, id). Free text narrows through FTS;
   * every other filter is checked on rows read in that order, at most SCAN_BUDGET rows a page, so
   * a rare filter returns a partial page and a cursor that keeps searching instead of reading the
   * whole mailbox.
   */
  async messagePage(filters: MessageFilter[], cursor: string | null, size: number, asc: boolean, sort: MessageSort = 'date'): Promise<MessagePage> {
    const sql = this.ctx.storage.sql;
    let read = 0;
    const exec = <R extends Record<string, SqlStorageValue>>(query: string, ...args: (string | number)[]) => {
      const c = sql.exec<R>(query, ...args);
      const out = c.toArray();
      read += c.rowsRead;
      return out;
    };
    const sorts = await this.buildSorts();
    const by = sorts.includes(sort) ? sort : 'date';
    const keys = SORT_KEYS[by];
    const text = filters.filter((f) => f.key === 'text' && !f.not).flatMap((f) => f.values).join(' ');
    const rest = filters.filter((f) => !(f.key === 'text' && !f.not));
    // Label chips name labels as the page shows them (Inbox, Promotions, yours by name).
    const labelIds = rest.some((f) => f.key === 'label')
      ? exec<{ id: string; name: string; type: string; n: number }>(`SELECT id, name, type, n FROM labels`)
      : [];
    // A rare label (a Labels group) is found through search, not by reading mail in order:
    // under 5% of the mailbox, reading in order would mostly read other mail.
    const one = rest.length && rest.every((f) => f.key === 'label' && !f.not && f.values.length === 1) ? rest : [];
    const rare = one.map((f) => labelIds.find((l) => l.id === f.values[0])).filter((l) => !!l && l.n < this.indexedTotal() * 0.05);
    const match = [ftsQuery(text), ...rare.map((l) => `labels : "${l!.id.replaceAll('"', '""')}"`)].filter(Boolean).join(' ');
    // One sender (a Sender group) seeks its index rather than checking rows read in order.
    const sender = sorts.includes('from') ? rest.find((f) => f.key === 'from' && f.op === 'eq' && !f.not && f.values.length === 1) : undefined;
    const keep = messageTest(rest, labelIds);
    // Date chips bound the ts range read (by date), so an old period is a seek, not a scan from today.
    const spans = filters
      .filter((f) => f.key === 'range' && !f.not)
      .map((f) => f.values.map((v) => v.split('..').map(Number)))
      .map((r) => [Math.min(...r.map((x) => x[0])), Math.max(...r.map((x) => x[1]))]);
    // Another order reads its own index and checks dates on the rows: bounding ts there would sort
    // the whole period again for every chunk.
    const lo = spans.length && by === 'date' ? Math.max(...spans.map((x) => x[0])) : null;
    const hi = spans.length && by === 'date' ? Math.min(...spans.map((x) => x[1])) : null;
    const cols = `id, thread_id AS threadId, ts, from_addr AS fromAddr, from_name AS fromName,
      subject, snippet, size, attachments, labels, state`;
    const [cmp, dir] = asc ? ['>', 'ASC'] : ['<', 'DESC'];
    let at = cursor ? decodeCursor(cursor, by) : null;
    const rows: MessageRow[] = [];
    let scanned = 0;
    let more = true;
    let last: SortKey | null = null;
    while (rows.length <= size && scanned < SCAN_BUDGET && more) {
      const chunk = rest.length ? SCAN_CHUNK : size + 1 - rows.length;
      const where = [
        at ? `(${keys.join(', ')}) ${cmp} (${keys.map(() => '?').join(', ')})` : '1',
        lo !== null && Number.isFinite(lo) ? 'ts >= ?' : '1',
        hi !== null && Number.isFinite(hi) ? 'ts < ?' : '1',
        match ? `id IN (SELECT printf('%x', rowid) FROM message_fts WHERE message_fts MATCH ?)` : '1',
        sender ? 'lower(from_addr) = ?' : '1',
      ];
      const args: (string | number)[] = [
        ...(at ?? []),
        ...(lo !== null && Number.isFinite(lo) ? [lo] : []),
        ...(hi !== null && Number.isFinite(hi) ? [hi] : []),
        ...(match ? [match] : []),
        ...(sender ? [sender.values[0].toLowerCase()] : []),
      ];
      const got = exec<Record<string, SqlStorageValue>>(
        `SELECT ${cols} FROM messages WHERE ${where.join(' AND ')} ORDER BY ${keys.map((k) => `${k} ${dir}`).join(', ')} LIMIT ?`,
        ...args,
        chunk,
      ) as unknown as (Omit<MessageRow, 'labels'> & { labels: string })[];
      more = got.length === chunk;
      scanned += got.length;
      for (const g of got) {
        last = sortKey(by, g);
        const m = { ...g, labels: g.labels.split(' ').filter(Boolean) } as MessageRow;
        if (!keep(m)) continue;
        rows.push(m);
        if (rows.length > size) break;
      }
      at = last;
    }
    const full = rows.length > size;
    if (full) rows.length = size;
    const end = full ? sortKey(by, rows[rows.length - 1]) : more ? last : null;
    const unindexed = Object.values(this.status().months).filter((m) => m.inBasin > 0 && m.indexState !== null && m.indexState !== 'done').length;
    const total = this.filteredTotal(filters, labelIds, exec);
    this.count({ do_rows_read: read });
    return {
      rows,
      next: end ? JSON.stringify(end) : null,
      total,
      partial: !full && !!end,
      unindexed,
      sorts,
    };
  }

  /**
   * Every message the filters match, when a rollup holds it without a scan: no filter (the
   * status row), or one chip that is a rollup's key: categories, one label (Unread is the
   * UNREAD label), domains. Anything else is null: the pager shows "50+".
   */
  private filteredTotal(
    filters: MessageFilter[],
    labelIds: { id: string; name: string; type: string }[],
    exec: <R extends Record<string, SqlStorageValue>>(query: string, ...args: (string | number)[]) => R[],
  ): number | null {
    const all = this.indexedTotal();
    if (!filters.length) return all;
    if (filters.length !== 1 || filters[0].op) return null;
    const f = filters[0];
    const sum = (table: string, key: string, values: string[]) =>
      exec<{ n: number }>(`SELECT n FROM ${table} WHERE ${key} IN (${values.map(() => '?').join(', ')})`, ...values).reduce((t, r) => t + r.n, 0);
    let n: number | null = null;
    // Categories are exclusive, so their counts add; Primary is everything outside the other four.
    if (f.key === 'label' && f.values.every((v) => CATEGORY_LABEL.test(v))) n = sum('labels', 'id', f.values);
    else if (f.key === 'label' && f.values.length === 1) {
      const byName = new Map(labelIds.map((l) => [shownLabel(l), l.id]));
      const v = f.values[0];
      const id = labelIds.some((l) => l.id === v) ? v : byName.get(v.toLowerCase());
      if (id) n = sum('labels', 'id', [id]);
    } else if (f.key === 'domain') n = sum('domains', 'domain', [...new Set(f.values.map((v) => v.toLowerCase()))]);
    if (n === null) return null;
    return f.not ? Math.max(0, all - n) : Math.min(n, all);
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
    this.syncDue = next ? Date.parse(next) : null;
    const at = Math.min(this.syncDue ?? Infinity, this.watching ? Date.now() + WATCH_MS : Infinity);
    if (at !== Infinity) await this.ctx.storage.setAlarm(at);
    else if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm();
  }

  /** When the scheduled Gmail sync is due (the alarm also fires for the watchdog); unknown after a restart. */
  private syncDue: number | null | undefined;
  /** Something is copying, indexing, counting or queued: the watchdog alarm checks it every WATCH_MS. */
  private watching = false;

  /** Keep the watchdog alarm going: called when work starts. */
  private async watch(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    await this.armSync();
  }

  /**
   * The watchdog: restart what stopped without a page open (a dead or stale sync, lanes whose run
   * died, the census) for every account. Page polls only read. Returns whether anything is still
   * going, which keeps the watchdog alarm set.
   */
  private async recover(user: UserId): Promise<boolean> {
    const paused = this.isPaused();
    let busy = false;
    for (const a of this.accountList()) {
      try {
        const mailbox = accountMailbox(this.env, user, a.id);
        const v = await mailbox.statusView();
        const sync = await this.keepRunning(user, a.id, v.sync, paused);
        const census = (await this.keepCounting(user, a.id, v.census)) ?? v.census;
        const status = syncStatus(sync);
        if (
          (!paused && (status === 'running' || status === 'waiting' || !!sync?.lanes?.length || (await mailbox.hasQueued()))) ||
          (!!census && census.month !== null && !census.error) ||
          v.index.status !== 'idle'
        )
          busy = true;
      } catch (e) {
        console.error('watchdog', a.id, e);
        busy = true;
      }
    }
    return busy;
  }

  /** Gmail sync's scheduled run: start a sync for each account that isn't syncing already. */
  async alarm(): Promise<void> {
    let retry = false;
    for (const [key, params] of await this.ctx.storage.list<SyncParams>({ prefix: 'launch:' })) {
      const id = key.slice('launch:'.length);
      try {
        await this.env.SYNC.create({ id, params });
      } catch (e) {
        // Already started (a retried hand-over): nothing to do. Anything else is tried at the next alarm.
        if (!/already exists/i.test(String(e))) {
          console.error('launch', id, e);
          retry = true;
          continue;
        }
      }
      await this.ctx.storage.delete(key);
    }
    if (retry) await this.ctx.storage.setAlarm(Date.now() + 30_000);
    const user = this.userId();
    if (!user) return;
    // Due when a slot has passed since the last run. Read from the saved run, not the alarm kept
    // in memory: a deploy restarts this DO, and a slot due across a restart was skipped.
    const sync = this.schedule('gmail-sync')!;
    const slot = sync.last ? nextRun(sync, new Date(sync.last.at)) : this.syncDue != null ? new Date(this.syncDue) : null;
    const due = !!slot && Date.now() >= slot.getTime() - 1000;
    console.log('gmail-sync', JSON.stringify({ on: sync.on, every: sync.every, tz: sync.tz, last: sync.last, slot: slot?.toISOString() ?? null, due, paused: this.pausedBy() }));
    this.watching = await this.recover(user);
    const ids = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM accounts`).toArray().map((a) => a.id);
    if (due && ids.length && sync.on) {
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
    return syncSummary(await accountMailbox(this.env, user, account).syncView());
  }

  /** Every account's sync, for the Backfill page and the status bar, and whether Basin can be written. */
  async syncAll(): Promise<SyncOverview> {
    const user = this.userId();
    const pausedBy = this.pausedBy();
    const paused = pausedBy !== null;
    return {
      basin: !!this.env.BASIN_TOKEN,
      paused,
      pausedBy,
      accounts: user
        ? await Promise.all(
            this.accountList().map(async (a) => {
              return { ...a, sync: syncSummary(await accountMailbox(this.env, user, a.id).syncView()) };
            }),
          )
        : [],
    };
  }

  /**
   * A run Cloudflare stopped never saves again: start it afresh, so the page never shows a dead
   * run as running. Lanes are checked on their own: a lane that stopped saving starts again where
   * it stood. Returns the sync as it is now.
   */
  /**
   * A sync paused for an account limit that no longer stops it: the run sleeping until the reset
   * paused under an older rule (before #56 the DO's write limit paused copying too). A fresh run
   * replaces it now; the sleeping one finds another run ID when it wakes, and stops.
   */
  private async pauseLifted(state: SyncState): Promise<boolean> {
    if (state.phase !== 'waiting' || syncStatus(state) !== 'waiting') return false;
    return !(await accountQuota(this.env).reserve(RUN_COST));
  }

  private async keepRunning(user: UserId, account: string, state: SyncState | null, paused: boolean): Promise<SyncState | null> {
    if (paused || !state) return state;
    const ownWork = state.phase !== 'live' || state.pending.length > 0 || state.basinQueue.length > 0;
    if (state.lanes?.length) await launchLanes(this.env, user, account);
    if ((ownWork && syncStatus(state) === 'running' && (await runDied(this.env, state.runId))) || (await this.pauseLifted(state))) {
      try {
        await syncDeps.start(this.env, user, account);
        return await accountMailbox(this.env, user, account).syncView();
      } catch (e) {
        if (!(e instanceof BasinNotReady)) throw e;
      }
    }
    return state;
  }

  /**
   * GET /api/backfill/status: every mailbox's sync, coverage, copy and index state and latest
   * backfills, in one answer. Each mailbox answers from its status row (statusView), so a poll
   * reads no table: this user's accounts and pause are kept in memory too.
   */
  async backfillStatus(): Promise<BackfillStatus> {
    const user = this.userId();
    const pausedBy = this.pausedBy();
    const paused = pausedBy !== null;
    const accounts: AccountStatus[] = user
      ? await Promise.all(
          this.accountList().map(async (a) => {
            const mailbox = accountMailbox(this.env, user, a.id);
            const v = await mailbox.statusView();
            // Read only: the watchdog alarm (recover) restarts what stopped.
            const sync = syncSummary(v.sync);
            const census = v.census;
            const index = await this.indexHeld(v.index, v.months);
            // Held for the limit: every month queued for indexing waits with it.
            if (index.status === 'waiting')
              for (const m of v.months) if (m.indexState === 'queued' || m.indexState === 'indexing') Object.assign(m, { indexState: 'waiting', resumesAt: index.resumesAt });
            return {
              ...a,
              sync,
              copy: paused ? { status: 'paused', pausedBy: pausedBy! } : { status: sync.status === 'running' ? 'copying' : 'idle' },
              index,
              months: v.months,
              census: censusView(census),
              current: monthNow(),
              jobs: v.jobs,
              totals: { indexed: v.indexed },
              sizes: v.sizes,
            } satisfies AccountStatus;
          }),
        )
      : [];
    const waits = accounts.flatMap((a) => (a.index.status === 'waiting' && a.index.resumesAt ? [a.index.resumesAt] : [])).sort();
    const state: BackfillStatus['state'] =
      pausedBy === 'budget' ? 'budget'
      : paused ? 'paused'
      : accounts.some((a) => a.copy.status === 'copying' || a.index.status === 'indexing') ? 'running'
      : waits.length ? 'index_waiting'
      : 'idle';
    return { basin: !!this.env.BASIN_TOKEN, paused, pausedBy, state, resumesAt: state === 'index_waiting' ? waits[0] : null, accounts };
  }

  /** The daily limit indexing would wait for, asked of the quota at most every 5 minutes. */
  private indexLimit: { at: number; full: { label: string; resumesAt: string } | null } | null = null;

  /**
   * Months queued for indexing while no index run reports (one asleep until the daily limit
   * resets, started before it could say so): waiting, when the next chunk would pass the DO
   * write limit. Asks the quota once per 5 minutes, and only then.
   */
  private async indexHeld(index: AccountStatus['index'], months: MonthCoverage[]): Promise<AccountStatus['index']> {
    if (index.status !== 'idle' || !months.some((m) => m.indexState === 'queued')) return index;
    const now = Date.now();
    if (!this.indexLimit || now - this.indexLimit.at > 5 * 60_000)
      this.indexLimit = { at: now, full: await accountQuota(this.env).reserve({ do_rows_written: INDEX_CHUNK * INDEX_ROWS }) };
    const full = this.indexLimit.full;
    return full && Date.parse(full.resumesAt) > now ? { status: 'waiting', pausedFor: full.label, resumesAt: full.resumesAt } : index;
  }

  /**
   * Opening the map starts the census when there is none, resumes one that stopped, and
   * recounts recent months every 6 hours. Returns the census once started, else null.
   */
  private async keepCounting(user: UserId, account: string, c: CensusState | null): Promise<CensusState | null> {
    const now = Date.now();
    const stale = c && now - Date.parse(c.updatedAt) >= SYNC_STALE_MS;
    const held = !!c?.resumesAt && Date.parse(c.resumesAt) > now;
    const mode = held ? null : !c ? 'full' : c.month !== null && (c.error || stale) ? 'resume' : c.finishedAt && now - Date.parse(c.finishedAt) >= 6 * 3_600_000 ? 'refresh' : null;
    if (!mode) return null;
    await syncDeps.census(this.env, user, account, mode === 'refresh' ? 'refresh' : 'full');
    return accountMailbox(this.env, user, account).censusState();
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
    const lifted = status === 'waiting' && (await this.pauseLifted(state!));
    if ((status === 'running' && !dead) || (status === 'waiting' && !lifted) || (status === 'stopped' && !manual)) return { status };
    try {
      await syncDeps.start(this.env, user, account);
    } catch (e) {
      if (e instanceof BasinNotReady) return { error: 'basin_not_ready' };
      throw e;
    }
    await this.watch();
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
    const v = await mailbox.statusView();
    return { months: v.months, census: censusView(v.census), current: monthNow() };
  }

  /** Queue months to copy for an account, and start its sync if none is going. */
  async backfill(account: string, months: string[], label: string): Promise<{ job: number | null; status: 'started' | SyncSummary['status'] } | { error: 'not_found' | 'basin_not_ready' | 'paused' }> {
    const user = this.userId();
    if (!user || !this.hasAccount(account)) return { error: 'not_found' };
    if (!this.env.BASIN_TOKEN) return { error: 'basin_not_ready' };
    const job = await accountMailbox(this.env, user, account).queueMonths(months, label);
    // Paused: the months wait in the queue and start when the person resumes.
    if (this.isPaused()) return { job, status: 'idle' };
    const r = await this.syncAccount(account, true);
    // A sync already going: the new months get lanes now, up to MAX_LANES at once.
    if (!('error' in r) && r.status !== 'started') await launchLanes(this.env, user, account);
    await this.watch();
    return 'error' in r ? r : { job, status: r.status };
  }

  /**
   * Queue every past month Gmail has more mail in than MailCellar copied, as one job, and resume
   * backfill (the spend cap still pauses it). The months to copy come from the census.
   */
  async backfillMissing(account: string): Promise<{ months: string[]; job?: number | null; error?: string }> {
    const user = this.userId();
    if (!user || !this.hasAccount(account)) return { months: [], error: 'not_found' };
    const now = monthNow();
    const months = (await accountMailbox(this.env, user, account).coverageMonths())
      .filter((m) => m.month < now && m.gmail !== null && m.gmail > m.copied)
      .map((m) => m.month);
    if (!months.length) return { months };
    // A person's pause is theirs to lift: the months wait in the queue until they resume.
    if (this.pausedBy() === 'person') {
      const job = await accountMailbox(this.env, user, account).queueMonths(months, 'All missing months');
      return { months, job, error: 'paused' };
    }
    if (!(await this.setBackfillPaused(false))) return { months, error: 'over_budget' };
    const r = await this.backfill(account, months, 'All missing months');
    return 'error' in r ? { months, error: r.error } : { months, job: r.job };
  }

  /**
   * Copy one month as a test of the copy engine: queue it (unless it is already) and resume
   * backfill, but only when no other month of any account is waiting or being copied.
   */
  async trial(account: string, month: string, park = false): Promise<{ started: boolean; active: { account: string; months: string[] }[]; job?: number | null; parked?: string[] }> {
    const user = this.userId();
    if (!user || !this.hasAccount(account) || !/^\d{4}-\d{2}$/.test(month)) return { started: false, active: [] };
    const ids = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM accounts`).toArray().map((a) => a.id);
    const active = [];
    for (const id of ids) {
      // The test month itself may already be queued (or part copied): that's the month that runs.
      const months = (await accountMailbox(this.env, user, id).activeList()).filter((m) => id !== account || m !== month);
      if (months.length) active.push({ account: id, months });
    }
    // `park`: months waiting on the test's own account are taken out of the queue (Retry on
    // their job queues them again); another account's months still stop the test.
    let parked: string[] = [];
    if (park && active.length === 1 && active[0].account === account) {
      parked = active[0].months;
      await accountMailbox(this.env, user, account).unqueueMonths(parked);
      active.length = 0;
    }
    if (active.length) return { started: false, active };
    const job = await accountMailbox(this.env, user, account).queueMonths([month], `Speed test: ${month}`);
    // A person's pause is theirs to lift: the test month waits in the queue until they resume.
    if (this.pausedBy() === 'person') return { started: false, active, job, parked };
    return { started: await this.setBackfillPaused(false), active, job, parked };
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
    return this.accountList().some((a) => a.id === id);
  }

  /** The person's accounts (id, email), kept in memory once read: connect and disconnect are the only writers. */
  private accountsKept: { id: string; email: string }[] | null = null;
  private accountList(): { id: string; email: string }[] {
    this.accountsKept ??= this.ctx.storage.sql.exec<{ id: string; email: string }>(`SELECT id, email FROM accounts ORDER BY added_at`).toArray();
    return this.accountsKept;
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
    this.accountsKept = null;
    this.count({ do_rows_written: rowsWritten });
    // The watchdog starts the account's census (recover, keepCounting).
    this.watching = true;
    await this.ctx.storage.setAlarm(Date.now());
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
      this.accountsKept = null;
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

/** The census as the map shows it. */
function censusView(c: CensusState | null): AccountCoverage['census'] {
  const counting = !!c && c.month !== null && !c.error;
  return {
    status: !c ? 'not_started' : c.error ? 'stopped' : counting ? 'counting' : 'done',
    month: c?.month ?? null,
    finishedAt: c?.finishedAt ?? null,
    error: c?.error ?? null,
  };
}

/** Rows read at most for one Messages page, and how many a read takes. */
const SCAN_BUDGET = 2000;
/** Gmail's four category labels; Primary is a message with none of them. */
const CATEGORY_LABEL = /^CATEGORY_(PROMOTIONS|SOCIAL|UPDATES|FORUMS)$/;
const CATEGORY_IDS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];
/** CATEGORY_SOCIAL as the page names it: Social. */
const categoryName = (id: string) => id.charAt(9) + id.slice(10).toLowerCase();
/** Senders or domains a page of Messages groups lists. */
const GROUPS_PAGE = 50;
const SCAN_CHUNK = 250;
/** Each order's keyset columns, matching its index (a WITHOUT ROWID index ends in the key, id). Senders sort as the rollup keys them: lower case. */
const SORT_KEYS: Record<MessageSort, readonly string[]> = { date: ['ts', 'id'], from: ['lower(from_addr)', 'ts', 'id'], size: ['size', 'id'] };
/** The sort indexes built after the fact (buildSorts), one DO write per message indexed each. */
const SORT_INDEXES: readonly { sort: MessageSort; name: string; create: string }[] = [
  { sort: 'from', name: 'messages_from', create: `CREATE INDEX IF NOT EXISTS messages_from ON messages (lower(from_addr), ts)` },
  { sort: 'size', name: 'messages_size', create: `CREATE INDEX IF NOT EXISTS messages_size ON messages (size)` },
];
type SortKey = (string | number)[];
const sortKey = (by: MessageSort, m: { ts: number; id: string; fromAddr: string; size: number }): SortKey =>
  by === 'from' ? [m.fromAddr.toLowerCase(), m.ts, m.id] : by === 'size' ? [m.size, m.id] : [m.ts, m.id];
/** A cursor is the last row's keys as JSON; one of another order or shape is ignored (page one). */
function decodeCursor(c: string, by: MessageSort): SortKey | null {
  if (c.length > 600) return null;
  let v: unknown;
  try {
    v = JSON.parse(c);
  } catch {
    return null;
  }
  const like = sortKey(by, { ts: 0, id: '', fromAddr: '', size: 0 });
  return Array.isArray(v) && v.length === like.length && v.every((x, i) => typeof x === typeof like[i]) ? (v as SortKey) : null;
}

/** Gmail's built-in label ids as the pages name them: INBOX is Inbox, CATEGORY_SOCIAL is Social. */
const shownLabel = (l: { name: string; type: string }) =>
  l.type === 'system' ? l.name.replace(/^CATEGORY_/, '').toLowerCase() : l.name.toLowerCase();

/** The Messages page's filters, other than free text, as one test on a message. */
export function messageTest(filters: MessageFilter[], labels: { id: string; name: string; type: string }[]): (m: MessageRow) => boolean {
  const byName = new Map(labels.map((l) => [shownLabel(l), l.id]));
  const num = (op: MessageFilter['op'], value: string, n: number) => {
    const [a, b] = value.split('..').map(Number);
    if (op === 'between') return n >= a && n <= b;
    if (op === 'gt') return n > a;
    if (op === 'lt') return n < a;
    return n === a;
  };
  const tests = filters.map((f) => {
    const vs = f.values.map((v) => v.toLowerCase());
    const has = (s: string) => vs.some((v) => s.toLowerCase().includes(v));
    const one = (m: MessageRow): boolean => {
      switch (f.key) {
        case 'from':
          // eq: the one address (a Sender group), any case; else a part of the address or name.
          return f.op === 'eq' ? vs.includes(m.fromAddr.toLowerCase()) : has(m.fromAddr) || has(m.fromName);
        case 'domain':
          return vs.includes((m.fromAddr.split('@')[1] ?? '').toLowerCase());
        case 'subject':
          return has(m.subject);
        case 'text':
          return has(m.subject) || has(m.fromAddr) || has(m.fromName) || has(m.snippet);
        case 'label':
          return vs.some((v) => m.labels.includes(byName.get(v) ?? v.toUpperCase()) || m.labels.includes(v));
        case 'size':
          return f.values.every((v) => num(f.op, v, m.size));
        case 'attachments':
          return f.values.every((v) => num(f.op, v, m.attachments));
        case 'range':
          return f.values.some((v) => {
            const [a, b] = v.split('..').map(Number);
            return m.ts >= a && m.ts < b;
          });
      }
      return true;
    };
    return (m: MessageRow) => one(m) !== !!f.not;
  });
  return (m) => tests.every((t) => t(m));
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
