import { DurableObject } from 'cloudflare:workers';
import type { Email } from 'postal-mime';
import { detailOf, fileOf, readMail, textOf, type MessageFile, type MessageText } from './message';
import {
  ARCHIVE_LIMIT,
  GMAIL_SCOPES,
  type ConnectedAccount,
  type ArchiveImport,
  type Me,
  domainOf,
  ftsIds,
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
  type ActiveJob,
  type JobRecord,
  type JobBy,
  JOBS_HISTORY,
  type CensusState,
  type MonthCoverage,
  type PartState,
  type SyncPart,
  addMonths,
  jobStatus,
  monthNow,
  SYNC_STALE_MS,
  type ScheduleRun,
  type MessageDetail,
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
  type SenderRow,
  type DomainRow,
  type LabelRow,
  type MessagePage,
  type MessageSort,
  type MessageGroup,
  type MessageGroupBy,
  type MessageGroups,
  MESSAGE_SORTS,
} from '@mailcellar/schema';
import type { Env } from './env';
import { accountMailbox, accessToken, INDEX_CHUNK, INDEX_ROWS, launchLanes, RUN_COST, runDied, syncDeps } from './sync';
import { BUCKET, endLaneFile, FLIGHT, freshLane, readLane, rememberCopied, saveLane } from './copy';
import { GmailError } from './gmail';
import { keepImporting, type ArchiveRecord } from './import';
import { accountQuota } from './quota';
import { countRows, measureObject, meteredEnv } from './telemetry';

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
  // from messages. That was one DO row written a message. catchUp fills it again.
  `DROP TABLE message_fts;
   CREATE VIRTUAL TABLE message_fts USING fts5 (
     subject, from_addr, from_name, snippet, labels,
     content = '', columnsize = 0, tokenize = 'unicode61 remove_diacritics 1'
   );
   INSERT INTO meta (key, value) VALUES ('fts_refill', 'true') ON CONFLICT (key) DO UPDATE SET value = excluded.value;`,
  // 11: the status row (2026-10-24) keeps each month's latest backfill state, found by month.
  `CREATE INDEX job_months_month ON job_months (month, job);`,
  // 12: Spam and Trash are not kept (Bikram, 2026-10-24). Live sync had copied some; the
  // catchUp takes them out of the index and deletes their raw files.
  `INSERT INTO meta (key, value) VALUES ('drop_spam', 'true') ON CONFLICT (key) DO UPDATE SET value = excluded.value;`,
  // 13: new mail indexed into a month already built from Basin wasn't added to its copied count
  // (2026-10-25: one mailbox showed 43 short of Gmail with all 43 searchable). Once:
  // recent indexed months take the index's count where it is higher. ingest keeps it from now on.
  `UPDATE basin_months SET copied = (SELECT n FROM months WHERE months.month = basin_months.month)
   WHERE month >= '2026-09' AND indexed_at IS NOT NULL
     AND copied < (SELECT n FROM months WHERE months.month = basin_months.month);`,
  // 14: archive mailboxes (2026-10-25): mail imported from an uploaded mbox file, with no Gmail
  // link. `archive` holds the file and how far its upload and import are (JSON); no refresh token.
  `ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'gmail';
   ALTER TABLE accounts ADD COLUMN archive TEXT;`,
  // 15: the mailbox is the record (Bikram, 2026-10-25): each message keeps the raw file (R2
  // object) that holds it, and its offset and length there (null for a file of one). Copying
  // writes them; mail copied before is filled from Basin once (locate runs).
  `ALTER TABLE messages ADD COLUMN raw_key TEXT;
   ALTER TABLE messages ADD COLUMN raw_offset INTEGER;
   ALTER TABLE messages ADD COLUMN raw_len INTEGER;`,
  // 16: body search (Bikram, 2026-10-25). The words of each message's body, as an index only: the
  // text stays in the raw files (R2 objects). Contentless delete, so a message leaves it by rowid.
  // messages.body is 1 once the body is in (or had no text): copying sets it, the body pass fills the rest.
  `CREATE VIRTUAL TABLE body_fts USING fts5 (
     body, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 1'
   );
   ALTER TABLE messages ADD COLUMN body INTEGER;`,
  // 17: recipients (Bikram, 2026-10-25): each message's To, Cc and Bcc addresses, for "mail I sent
  // to X". Null until kept: copying writes them, the recipients pass fills mail copied before.
  `ALTER TABLE messages ADD COLUMN rcpt TEXT;`,
  // 18: attachment search (Bikram, 2026-10-26). The words of each message's documents (PDF, Word,
  // Excel, text), as an index only, like body search. messages.attach is the JSON list of the files
  // with text once looked at ('[]': none), '?' for mail copied since that waits for the next sync's
  // attachment pass, and null for mail copied before, which waits for the one-time pass.
  `CREATE VIRTUAL TABLE attach_fts USING fts5 (
     text, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 1'
   );
   ALTER TABLE messages ADD COLUMN attach TEXT;
   CREATE INDEX messages_attach ON messages (attach) WHERE attachments > 0;`,
  // 19: labelled mail per month (Bikram, 2026-10-27): messages with at least one of the person's
  // own labels. Ingest keeps it from now on; catchUp counts mail already in, a few months a step.
  `ALTER TABLE months ADD COLUMN labelled INTEGER NOT NULL DEFAULT 0;
   INSERT INTO meta (key, value) VALUES ('labelled_fill', 'true') ON CONFLICT (key) DO UPDATE SET value = excluded.value;`,
];

/** Months a step of the labelled count covers (MailboxDO.fillLabelled): a few hundred ms at most. */
const FILL_MONTHS = 6;
/** The pause between one-time pass steps (MailboxDO.catchUp), so requests run in between. */
const CATCH_UP_GAP_MS = 50;

/** Gmail labels whose mail MailCellar doesn't keep: the index never takes it in. */
const NOT_KEPT = ['SPAM', 'TRASH'];
const notKept = (labels: string[]) => labels.some((l) => NOT_KEPT.includes(l));
/** Whether a message has one of the person's own labels: Gmail names those IDs Label_N (system labels and categories are upper case). */
const labelled = (labels: string[]) => labels.some((l) => l.startsWith('Label_'));
/** The same test in SQL, on the messages table's space-separated labels. */
const LABELLED_SQL = `' ' || labels LIKE '% Label\\_%' ESCAPE '\\'`;

/** What count_messages groups by. */
export type CountDim = 'sender' | 'domain' | 'label' | 'recipient' | 'month' | 'year';
/** The dimensions SQL groups on its own, one value a message. */
const COUNT_SQL = {
  sender: 'lower(from_addr)',
  domain: `lower(substr(from_addr, instr(from_addr, '@') + 1))`,
  month: `strftime('%Y-%m', ts / 1000, 'unixepoch')`,
  year: `strftime('%Y', ts / 1000, 'unixepoch')`,
} as const;


const today = () => new Date().toISOString().slice(0, 10);
/** Whether a message's attach column says its files' text is in attach_fts. */
const attachIndexed = (attach: string | null) => !!attach && attach.startsWith('[') && attach !== '[]';
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

/** A message as the sender, domain and label totals count it. */
type Counted = { ts: number; size: number; fromAddr: string; fromName: string; labels: string[] };

/**
 * Add (+1) or take away (-1) these messages' shares of the sender, domain and label totals.
 * The totals only ever move by such shares: nothing recounts the mailbox to keep them right.
 * Taking away leaves a sender's first and last dates as they were; a total that reaches 0 goes.
 */
function moveRollups(run: (query: string, ...args: (string | number)[]) => void, rows: Iterable<Counted>, sign: 1 | -1): void {
  writeRollups(run, rollupShares(rows), sign);
}

/** The sender, domain and label totals of some messages, before they are written. */
interface Shares { n: number; senders: Tally; domains: Tally; labels: Tally }

function rollupShares(rows: Iterable<Counted>, into: Shares = { n: 0, senders: new Map(), domains: new Map(), labels: new Map() }): Shares {
  for (const r of rows) {
    const m = { ts: r.ts, size: r.size } as IndexedMessage;
    tally(into.senders, r.fromAddr.toLowerCase(), m, r.fromName);
    tally(into.domains, domainOf(r.fromAddr), m);
    for (const l of r.labels) tally(into.labels, l, m);
    into.n++;
  }
  return into;
}

/** Messages whose shares wait in one row before the totals are written (MailboxDO.settleRollups). */
const ROLLUP_EVERY = 2000;

/** Shares as one meta row, and back. */
const sharesJson = (s: Shares) => ({ n: s.n, senders: [...s.senders], domains: [...s.domains], labels: [...s.labels] });
const sharesOf = (j: ReturnType<typeof sharesJson>): Shares => ({ n: j.n, senders: new Map(j.senders), domains: new Map(j.domains), labels: new Map(j.labels) });

function writeRollups(run: (query: string, ...args: (string | number)[]) => void, shares: Shares, sign: 1 | -1): void {
  const { senders, domains, labels } = shares;
  if (sign < 0) {
    for (const [table, key, t] of [['senders', 'addr', senders], ['domains', 'domain', domains], ['labels', 'id', labels]] as const)
      for (const [k, x] of t) {
        run(`UPDATE ${table} SET n = n - ?, bytes = max(0, bytes - ?) WHERE ${key} = ?`, x.n, x.bytes, k);
        run(`DELETE FROM ${table} WHERE ${key} = ? AND n <= 0`, k);
      }
    return;
  }
  for (const [addr, t] of senders)
    run(
      `INSERT INTO senders (addr, name, n, bytes, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (addr) DO UPDATE SET
         name = CASE WHEN excluded.last_ts >= last_ts THEN excluded.name ELSE name END,
         n = n + excluded.n, bytes = bytes + excluded.bytes,
         first_ts = min(first_ts, excluded.first_ts), last_ts = max(last_ts, excluded.last_ts)`,
      addr, t.name, t.n, t.bytes, t.first, t.last,
    );
  for (const [domain, t] of domains)
    run(
      `INSERT INTO domains (domain, n, bytes) VALUES (?, ?, ?) ON CONFLICT (domain) DO UPDATE SET
         n = n + excluded.n, bytes = bytes + excluded.bytes`,
      domain, t.n, t.bytes,
    );
  // A label Gmail has not named yet keeps its ID as its name until putLabels or nameLabels runs.
  for (const [id, t] of labels)
    run(
      `INSERT INTO labels (id, name, type, n, bytes) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET
         n = n + excluded.n, bytes = bytes + excluded.bytes`,
      id, id, /^[A-Z_]+$/.test(id) ? 'system' : 'user', t.n, t.bytes,
    );
}

/** Bump to recount every mailbox's sender, domain and label totals once (rebuildRollups). 2: totals move by shares from here on. */
const ROLLUPS_V = 2;

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
  /** Finished jobs, newest first (JOBS_HISTORY). Saved with the row: no write of its own. */
  history?: JobRecord[];
  /** Messages and bytes each open backfill job has copied, by job ID; dropped when it ends. */
  tally?: Record<number, { copied: number; bytes: number }>;
}
/** Bump to rebuild every mailbox's status row from its tables once (the shape changed). */
const STATUS_V = 2;
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

  /** Read these months' entries again from the tables: a keyed row from each of five, a month. */
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
      const unavailable = this.meta<string[]>(`unavailable:${month}`)?.length ?? 0;
      book.months[month] = {
        month,
        gmail: gmail?.n ?? null,
        ...(unavailable ? { unavailable } : {}),
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
      const was = book.jobs.find((j) => j.id === id);
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
      const job: BackfillJob = { id: j.id, createdAt: j.created_at, label: j.label, status: jobStatus(months), months, from, to };
      book.jobs.push(job);
      // A job that was going and now isn't goes into the history, with what it copied.
      if (was && (was.status === 'queued' || was.status === 'running') && job.status !== 'queued' && job.status !== 'running') this.logBackfill(job);
    }
    book.jobs.sort((a, b) => b.id - a.id);
    book.jobs.length = Math.min(book.jobs.length, JOBS_KEPT);
  }

  /** A backfill job ended: keep it in the history, with what it copied and its first error. Saved with the status row. */
  private logBackfill(job: BackfillJob): void {
    const book = this.status();
    const tally = book.tally?.[job.id] ?? { copied: 0, bytes: 0 };
    if (book.tally) delete book.tally[job.id];
    const error = job.months.failed
      ? this.ctx.storage.sql.exec<{ error: string | null }>(`SELECT error FROM job_months WHERE job = ? AND state = 'failed' LIMIT 1`, job.id).toArray()[0]?.error ?? null
      : job.months.canceled ? 'Taken out of the queue.' : null;
    const total = Object.values(job.months).reduce((n, x) => n + x, 0);
    this.logJob({
      id: `backfill:${job.id}`, kind: 'backfill', label: job.label, by: 'you', startedAt: job.createdAt, endedAt: new Date().toISOString(),
      result: job.status === 'done' ? 'done' : job.status === 'failed' ? 'failed' : 'stopped',
      copied: tally.copied, bytes: tally.bytes, months: { done: job.months.done, failed: job.months.failed, total }, error,
    });
  }

  /** Add a finished job to the history (in the status row; the caller saves it). */
  private logJob(r: JobRecord): void {
    const book = this.status();
    book.history = [r, ...(book.history ?? []).filter((h) => h.id !== r.id)].slice(0, JOBS_HISTORY);
    console.log(JSON.stringify({ jobDone: { id: r.id, result: r.result, copied: r.copied, ms: Date.parse(r.endedAt) - Date.parse(r.startedAt), error: r.error } }));
  }

  /** Messages a backfill job copied: kept with the status row, saved by the caller's changed(). */
  private tallyJob(job: number, copied: number, bytes: number): void {
    if (!copied && !bytes) return;
    const book = this.status();
    const t = (book.tally ??= {})[job] ?? { copied: 0, bytes: 0 };
    book.tally[job] = { copied: t.copied + copied, bytes: t.bytes + bytes };
  }

  /** Months and jobs changed: update their entries and save the status row. Returns rows written. */
  private changed(months: Iterable<string>, jobs: Iterable<number> = []): number {
    this.refreshMonths(months);
    this.refreshJobs(jobs);
    return this.saveStatus();
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, meteredEnv(env));
    countRows(ctx.storage.sql);
    // Only the schema and the waiting rollups hold the first request; both are quick. Never add a
    // pass over the mailbox's rows or a network call here: a request waits on all of it.
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.settleRollups();
      // A user's mailbox that just started (a deploy, say) doesn't know what is going on: the
      // watchdog looks within WATCH_MS, and keeps looking while something is.
      if (this.userId()) {
        const at = await ctx.storage.getAlarm();
        if (at === null || at > Date.now() + WATCH_MS) await ctx.storage.setAlarm(Date.now() + WATCH_MS);
      }
    });
    this.catchUp();
  }

  /** A pass from a migration is running: catchUp starts it at most once per start. */
  private catchingUp = false;

  /**
   * The one-time passes migrations ask for (their meta flags), after start and a small step at a
   * time, so requests run between steps. A flag stays until its pass is done: a restart picks up
   * where it stood.
   */
  private catchUp(): void {
    if (this.catchingUp) return;
    this.catchingUp = true;
    const step = async () => {
      try {
        if (await this.catchUpStep()) return void setTimeout(step, CATCH_UP_GAP_MS);
      } catch (e) {
        console.error('catch-up', e);
      }
      this.catchingUp = false;
    };
    setTimeout(step, 0);
  }

  /** One step of the first pass still to do. Whether there is more to do now. */
  private async catchUpStep(): Promise<boolean> {
    const flag = (key: string) => this.ctx.storage.sql.exec(`SELECT 1 FROM meta WHERE key = ?`, key).toArray().length > 0;
    if (flag('sample')) {
      this.dropSample();
      return true;
    }
    if (flag('fts_refill')) {
      this.refillSearch();
      return true;
    }
    // A raw file delete that failed leaves the flag; the next start tries again.
    if (flag('drop_spam')) return this.dropSpam();
    if (flag('labelled_fill')) return this.fillLabelled();
    return false;
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
  private async dropSpam(): Promise<boolean> {
    this.settleRollups();
    const sql = this.ctx.storage.sql;
    if (!sql.exec(`SELECT 1 FROM meta WHERE key = 'drop_spam'`).toArray().length) return false;
    const cursor = sql.exec<{ id: string; ts: number; from_addr: string; from_name: string; subject: string; snippet: string; size: number; labels: string; body: number | null; attach: string | null }>(
      `SELECT id, ts, from_addr, from_name, subject, snippet, size, labels, body, attach FROM messages
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
        return false;
      }
    }
    this.ctx.storage.transactionSync(() => {
      let written = 0;
      const run = (query: string, ...args: (string | number)[]) => {
        written += sql.exec(query, ...args).rowsWritten;
      };
      const months: Tally = new Map();
      const marked = new Map<string, number>();
      for (const r of rows) {
        if (labelled(r.labels.split(' '))) marked.set(monthOf(r.ts), (marked.get(monthOf(r.ts)) ?? 0) + 1);
        run(
          `INSERT INTO message_fts (message_fts, rowid, subject, from_addr, from_name, snippet, labels) VALUES ('delete', CAST(? AS INTEGER), ?, ?, ?, ?, ?)`,
          ftsRowid(r.id), r.subject, r.from_addr, r.from_name, r.snippet, r.labels,
        );
        if (r.body) run(`DELETE FROM body_fts WHERE rowid = CAST(? AS INTEGER)`, ftsRowid(r.id));
        if (attachIndexed(r.attach)) run(`DELETE FROM attach_fts WHERE rowid = CAST(? AS INTEGER)`, ftsRowid(r.id));
        run(`DELETE FROM messages WHERE id = ?`, r.id);
        tally(months, monthOf(r.ts), { ts: r.ts, size: r.size } as IndexedMessage);
      }
      moveRollups(run, rows.map((r) => ({ ts: r.ts, size: r.size, fromAddr: r.from_addr, fromName: r.from_name, labels: r.labels.split(' ').filter(Boolean) })), -1);
      for (const [k, x] of months) {
        run(`UPDATE months SET n = n - ?, bytes = max(0, bytes - ?), labelled = max(0, labelled - ?) WHERE month = ?`, x.n, x.bytes, marked.get(k) ?? 0, k);
        run(`DELETE FROM months WHERE month = ? AND n <= 0`, k);
      }
      run(`DELETE FROM meta WHERE key = 'drop_spam'`);
      if (rows.length) written += this.changed(months.keys());
      console.log(JSON.stringify({ dropSpam: { removed: rows.length, rowsRead: read, rowsWritten: written } }));
      this.count({ do_rows_read: read, do_rows_written: written });
    });
    return true;
  }

  /**
   * After migration 19: count labelled mail for the next FILL_MONTHS months (the flag holds the
   * last month done). Each month reads its own messages by the ts index and writes its one row,
   * so a step is short however big the mailbox. Whether months are left.
   */
  private fillLabelled(): boolean {
    const sql = this.ctx.storage.sql;
    const flag = sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'labelled_fill'`).toArray()[0];
    if (!flag) return false;
    const after = flag.value === 'true' ? '' : flag.value;
    const months = sql
      .exec<{ month: string }>(`SELECT month FROM months WHERE month > ? ORDER BY month LIMIT ?`, after, FILL_MONTHS)
      .toArray()
      .map((r) => r.month);
    const more = months.length === FILL_MONTHS;
    this.ctx.storage.transactionSync(() => {
      let read = 0;
      let written = 0;
      const run = (query: string, ...args: string[]) => {
        const c = sql.exec(query, ...args);
        c.toArray();
        read += c.rowsRead;
        written += c.rowsWritten;
      };
      for (const m of months)
        run(
          `UPDATE months SET labelled = (
             SELECT count(*) FROM messages
             WHERE ts >= unixepoch(months.month || '-01') * 1000
               AND ts < unixepoch(months.month || '-01', '+1 month') * 1000
               AND ${LABELLED_SQL}
           ) WHERE month = ?`,
          m,
        );
      if (more) run(`UPDATE meta SET value = ? WHERE key = 'labelled_fill'`, months[months.length - 1]);
      else run(`DELETE FROM meta WHERE key = 'labelled_fill'`);
      console.log(JSON.stringify({ fillLabelled: { months: months.length, done: !more, rowsRead: read, rowsWritten: written } }));
      this.count({ do_rows_read: read, do_rows_written: written });
    });
    return more;
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
    if (paused) return true;
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
          // The open sync job counts its own copies; the run's copy of it is from its start.
          const run = current.run ?? null;
          next.run = run && { ...run, copied: run.copied + added.copied, bytes: run.bytes + added.bytes };
        }
      }
      this.putMeta('sync', next);
      return true;
    });
  }

  /** What the sync job is doing now, in memory only: shown on the Sync card, never written. */
  private step: { runId: string; text: string } | null = null;

  /** A sync run says what it is doing. Costs no row. */
  async runStep(runId: string, text: string): Promise<void> {
    this.step = { runId, text };
  }

  /**
   * The sync job ended (done, failed, or stopped): it goes into the history and the sync state
   * closes it. Two rows (the sync state and the status row), once a job.
   */
  async endRun(runId: string, result: JobRecord['result'], error: string | null): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const main = this.meta<SyncState>('sync');
      if (!main || main.runId !== runId || !main.run) return;
      const run = main.run;
      this.logJob({
        id: `sync:${run.startedAt}`, kind: 'sync', label: run.by === 'you' ? 'Sync now' : 'Scheduled sync', by: run.by,
        startedAt: run.startedAt, endedAt: new Date().toISOString(), result, copied: run.copied, bytes: run.bytes, error,
      });
      this.step = null;
      this.count({ do_rows_written: this.putMeta('sync', { ...main, run: null }) + this.saveStatus() });
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

  /** Where a message's raw bytes are: its raw file, and offset and length there (-1 for a file of one). One keyed read. */
  /** The last message parsed here: a burst of requests for one message (its attachments' previews) parses it once. */
  private lastMail: { id: string; mail: Promise<Email | null> } | null = null;

  /** One message's detail, plain text or attachment, parsed from its raw file here (where CPU is not cut at 10 ms). */
  async messagePart(user: UserId, account: string, id: string, want: { part: 'detail' | 'text' } | { part: 'file'; index: number }): Promise<MessageDetail | MessageText | MessageFile | null> {
    let last = this.lastMail;
    if (last?.id !== id) {
      const read = this.location(id).then((at) => readMail(this.env, user, account, id, at));
      last = this.lastMail = { id, mail: read };
      // A failed read is tried again next time, not kept.
      read.catch(() => {
        if (this.lastMail?.mail === read) this.lastMail = null;
      });
    }
    const mail = await last.mail;
    if (!mail) return null;
    if (want.part === 'file') return fileOf(mail, want.index);
    return want.part === 'detail' ? detailOf(mail) : textOf(mail);
  }

  async location(id: string): Promise<{ key: string; offset: number; len: number } | null> {
    const cursor = this.ctx.storage.sql.exec<{ raw_key: string | null; raw_offset: number | null; raw_len: number | null }>(
      `SELECT raw_key, raw_offset, raw_len FROM messages WHERE id = ?`, id,
    );
    const r = cursor.toArray()[0];
    this.count({ do_rows_read: cursor.rowsRead });
    return r?.raw_key ? { key: r.raw_key, offset: r.raw_offset ?? -1, len: r.raw_len ?? -1 } : null;
  }

  /** Where each of these messages is (body snippets): null for one in a raw file of its own. Unknown IDs are left out. */
  async locations(ids: string[]): Promise<Record<string, { key: string; offset: number; len: number } | null>> {
    const out: Record<string, { key: string; offset: number; len: number } | null> = {};
    let read = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const cursor = this.ctx.storage.sql.exec<{ id: string; raw_key: string | null; raw_offset: number | null; raw_len: number | null }>(
        `SELECT id, raw_key, raw_offset, raw_len FROM messages WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk,
      );
      for (const r of cursor) out[r.id] = r.raw_key ? { key: r.raw_key, offset: r.raw_offset ?? -1, len: r.raw_len ?? -1 } : null;
      read += cursor.rowsRead;
    }
    this.count({ do_rows_read: read });
    return out;
  }

  /**
   * The body pass's next messages (bodies.ts): up to `limit` read in ID order from its bookmark,
   * those without their body in search with where each is. `last` is the last ID read, the next
   * bookmark; null when the pass has read to the end.
   */
  async bodyTodo(limit: number): Promise<{ todo: { id: string; key: string | null; offset: number; len: number }[]; last: string | null }> {
    const sql = this.ctx.storage.sql;
    const at = sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'body_pass'`).toArray()[0]?.value ?? '';
    const cursor = sql.exec<{ id: string; raw_key: string | null; raw_offset: number | null; raw_len: number | null; body: number | null }>(
      `SELECT id, raw_key, raw_offset, raw_len, body FROM messages WHERE id > ? ORDER BY id LIMIT ?`, at, limit,
    );
    const rows = cursor.toArray();
    this.count({ do_rows_read: cursor.rowsRead + 1 });
    return {
      todo: rows.filter((r) => !r.body).map((r) => ({ id: r.id, key: r.raw_key, offset: r.raw_offset ?? -1, len: r.raw_len ?? -1 })),
      last: rows.length === limit ? rows[rows.length - 1].id : null,
    };
  }

  /**
   * Put bodies the pass read in search, mark them, and move its bookmark to `last` (null: the pass
   * is done), in one transaction. A message already marked (copied since, or a retried batch) is skipped.
   */
  async addBodies(bodies: { id: string; body: string }[], last: string | null): Promise<{ added: number; rowsWritten: number }> {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      let written = 0;
      let added = 0;
      for (const b of bodies) {
        const marked = sql.exec(`UPDATE messages SET body = 1 WHERE id = ? AND body IS NULL`, b.id).rowsWritten;
        written += marked;
        if (!marked || !b.body) continue;
        written += sql.exec(`INSERT INTO body_fts (rowid, body) VALUES (CAST(? AS INTEGER), ?)`, ftsRowid(b.id), b.body).rowsWritten;
        added++;
      }
      written += sql.exec(
        `INSERT INTO meta (key, value) VALUES ('body_pass', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        last ?? '~done',
      ).rowsWritten;
      this.count({ do_rows_written: written });
      return { added, rowsWritten: written };
    });
  }

  /**
   * The attachment pass's next messages (attachments.ts): up to `limit` with attachments not looked
   * at yet, with where each is. 'new' takes mail copied since attachment search; 'all' mail copied before too.
   */
  async attachTodo(limit: number, scope: 'new' | 'all'): Promise<{ id: string; key: string | null; offset: number; len: number }[]> {
    const sql = this.ctx.storage.sql;
    // messages_attach holds only mail with attachments, so this reads those rows alone.
    const cursor = sql.exec<{ id: string; raw_key: string | null; raw_offset: number | null; raw_len: number | null }>(
      `SELECT id, raw_key, raw_offset, raw_len FROM messages WHERE attachments > 0 AND ${scope === 'new' ? `attach = '?'` : `(attach IS NULL OR attach = '?')`} LIMIT ?`,
      limit,
    );
    const rows = cursor.toArray();
    this.count({ do_rows_read: cursor.rowsRead });
    return rows.map((r) => ({ id: r.id, key: r.raw_key, offset: r.raw_offset ?? -1, len: r.raw_len ?? -1 }));
  }

  /** Put the attachment text the pass read in search and mark each message looked at, in one transaction. */
  async addAttachments(items: { id: string; names: string[]; text: string }[]): Promise<{ rowsWritten: number }> {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      let written = 0;
      for (const a of items) {
        const files = a.text ? a.names : [];
        const marked = sql.exec(
          `UPDATE messages SET attach = ? WHERE id = ? AND (attach IS NULL OR attach = '?')`, JSON.stringify(files), a.id,
        ).rowsWritten;
        written += marked;
        if (!marked || !files.length) continue;
        written += sql.exec(`INSERT INTO attach_fts (rowid, text) VALUES (CAST(? AS INTEGER), ?)`, ftsRowid(a.id), a.text).rowsWritten;
      }
      this.count({ do_rows_written: written });
      return { rowsWritten: written };
    });
  }

  /**
   * The recipients pass's next messages (recipients.ts): up to `limit` in ID order from its
   * bookmark, those whose recipients aren't kept yet, with where each is. `last` as bodyTodo's.
   */
  async rcptTodo(limit: number): Promise<{ todo: { id: string; key: string | null; offset: number; len: number }[]; last: string | null }> {
    const sql = this.ctx.storage.sql;
    const at = sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'rcpt_pass'`).toArray()[0]?.value ?? '';
    const cursor = sql.exec<{ id: string; raw_key: string | null; raw_offset: number | null; raw_len: number | null; rcpt: string | null }>(
      `SELECT id, raw_key, raw_offset, raw_len, rcpt FROM messages WHERE id > ? ORDER BY id LIMIT ?`, at, limit,
    );
    const rows = cursor.toArray();
    this.count({ do_rows_read: cursor.rowsRead + 1 });
    return {
      todo: rows.filter((r) => r.rcpt === null).map((r) => ({ id: r.id, key: r.raw_key, offset: r.raw_offset ?? -1, len: r.raw_len ?? -1 })),
      last: rows.length === limit ? rows[rows.length - 1].id : null,
    };
  }

  /** Keep the recipients the pass read and move its bookmark to `last` (null: done), in one transaction. */
  async addRcpts(list: { id: string; rcpt: string }[], last: string | null): Promise<{ added: number; rowsWritten: number }> {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      let written = 0;
      let added = 0;
      for (const r of list) {
        const n = sql.exec(`UPDATE messages SET rcpt = ? WHERE id = ? AND rcpt IS NULL`, r.rcpt, r.id).rowsWritten;
        written += n;
        added += n ? 1 : 0;
      }
      written += sql.exec(
        `INSERT INTO meta (key, value) VALUES ('rcpt_pass', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        last ?? '~done',
      ).rowsWritten;
      this.count({ do_rows_written: written });
      return { added, rowsWritten: written };
    });
  }

  /**
   * How many of a month's messages the mailbox has: of `ids` (Gmail's list of the month) when
   * given, with the ones it lacks; else the month's own count, by message date.
   */
  async monthHas(month: string, ids: string[] | null): Promise<{ have: number; missing: string[] }> {
    const sql = this.ctx.storage.sql;
    if (!ids) {
      const cursor = sql.exec<{ n: number }>(`SELECT n FROM months WHERE month = ?`, month);
      const n = cursor.toArray()[0]?.n ?? 0;
      this.count({ do_rows_read: cursor.rowsRead });
      return { have: n, missing: [] };
    }
    const known = new Set(await this.knownIds(ids));
    return { have: known.size, missing: ids.filter((id) => !known.has(id)) };
  }

  private async knownIds(ids: string[]): Promise<string[]> {
    const known: string[] = [];
    for (let i = 0; i < ids.length; i += 5000) {
      const cursor = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids.slice(i, i + 5000)));
      for (const r of cursor) known.push(r.id);
      this.count({ do_rows_read: cursor.rowsRead });
    }
    return known;
  }

  /**
   * A month's backfill has landed in Basin: the month is done, its index can be built, and what
   * the lane copied is added to the month and the account's sync. A few rows, once a month.
   */
  async landMonth(part: SyncPart, added: { copied: number; bytes: number } = { copied: 0, bytes: 0 }, gone: string[] = []): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      let written = 0;
      // Messages Gmail lists but won't give: kept by month, so the month counts them as unavailable.
      if (gone.length) {
        const key = `unavailable:${part.month}`;
        const had = this.meta<string[]>(key) ?? [];
        const all = [...new Set([...had, ...gone])];
        if (all.length > had.length) written += this.putMeta(key, all);
      }
      written += this.ctx.storage.sql.exec(
        `INSERT INTO basin_months (month, copied, landed_at) VALUES (?, ?, ?)
         ON CONFLICT (month) DO UPDATE SET copied = copied + excluded.copied, landed_at = excluded.landed_at, indexed_at = NULL`,
        part.month, added.copied, new Date().toISOString(),
      ).rowsWritten;
      written += this.ctx.storage.sql.exec(`UPDATE job_months SET state = 'done', error = NULL, finished_at = ? WHERE job = ? AND month = ? AND state = 'running'`, new Date().toISOString(), part.job, part.month).rowsWritten;
      const main = this.meta<SyncState>('sync');
      if (main && added.copied) written += this.putMeta('sync', { ...main, copied: main.copied + added.copied, bytes: main.bytes + added.bytes, updatedAt: new Date().toISOString() });
      this.live.delete(part.month);
      this.changedMonths();
      this.tallyJob(part.job, added.copied, added.bytes);
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
          `INSERT INTO senders (addr, name, n, bytes, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (addr) DO UPDATE SET
             name = excluded.name, n = excluded.n, bytes = excluded.bytes, first_ts = excluded.first_ts, last_ts = excluded.last_ts
           WHERE n != excluded.n OR bytes != excluded.bytes OR name != excluded.name`,
          addr, t.name, t.n, t.bytes, t.first, t.last,
        );
      for (const [domain, t] of domains)
        run(
          `INSERT INTO domains (domain, n, bytes) VALUES (?, ?, ?) ON CONFLICT (domain) DO UPDATE SET n = excluded.n, bytes = excluded.bytes
           WHERE n != excluded.n OR bytes != excluded.bytes`,
          domain, t.n, t.bytes,
        );
      for (const [id, t] of labels)
        run(
          `INSERT INTO labels (id, name, type, n, bytes) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET n = excluded.n, bytes = excluded.bytes
           WHERE n != excluded.n OR bytes != excluded.bytes`,
          id, id, /^[A-Z_]+$/.test(id) ? 'system' : 'user', t.n, t.bytes,
        );
      // Every message is counted above, so shares still waiting would count twice.
      run(`DELETE FROM meta WHERE key = 'rollups_waiting'`);
    });
    this.waiting = null;
    written += this.putMeta('rollups_v', ROLLUPS_V);
    this.count({ do_rows_read: cursor.rowsRead, do_rows_written: written });
    return { rowsRead: cursor.rowsRead, rowsWritten: written };
  }

  /** Whether the sender, domain and label totals were recounted since ROLLUPS_V last changed: one keyed read. */
  async rollupsCurrent(): Promise<boolean> {
    return this.meta<number>('rollups_v') === ROLLUPS_V;
  }

  /** Messages in the index, from the status row. */
  async indexedCount(): Promise<number> {
    return this.indexedTotal();
  }

  private indexedTotal(): number {
    return Object.values(this.status().months).reduce((t, m) => t + m.indexed, 0);
  }

  /** Take a month out of the index, to build it again from Basin, and its messages' shares out of the totals. */
  async unindexMonth(month: string): Promise<{ removed: number; rowsWritten: number }> {
    this.settleRollups();
    const sql = this.ctx.storage.sql;
    const after = Date.parse(`${month}-01T00:00:00Z`);
    const before = Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`);
    return this.ctx.storage.transactionSync(() => {
      let written = 0;
      const rows = sql
        .exec<{ id: string; ts: number; size: number; subject: string; from_addr: string; from_name: string; snippet: string; labels: string; body: number | null; attach: string | null }>(
          `SELECT id, ts, size, subject, from_addr, from_name, snippet, labels, body, attach FROM messages WHERE ts >= ? AND ts < ?`, after, before,
        )
        .toArray();
      for (const m of rows) {
        written += sql.exec(
          `INSERT INTO message_fts (message_fts, rowid, subject, from_addr, from_name, snippet, labels) VALUES ('delete', CAST(? AS INTEGER), ?, ?, ?, ?, ?)`,
          ftsRowid(m.id), m.subject, m.from_addr, m.from_name, m.snippet, m.labels,
        ).rowsWritten;
        if (m.body) written += sql.exec(`DELETE FROM body_fts WHERE rowid = CAST(? AS INTEGER)`, ftsRowid(m.id)).rowsWritten;
        if (attachIndexed(m.attach)) written += sql.exec(`DELETE FROM attach_fts WHERE rowid = CAST(? AS INTEGER)`, ftsRowid(m.id)).rowsWritten;
      }
      written += sql.exec(`DELETE FROM messages WHERE ts >= ? AND ts < ?`, after, before).rowsWritten;
      moveRollups((query, ...args) => void (written += sql.exec(query, ...args).rowsWritten), rows.map((r) => ({ ts: r.ts, size: r.size, fromAddr: r.from_addr, fromName: r.from_name, labels: r.labels.split(' ').filter(Boolean) })), -1);
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
   * Months the status still shows indexing, less those whose index is built: an ingest touches
   * every month its messages fall in, which can be one the run isn't building, and only the run's
   * own month is cleared when it ends. Such a month kept the watchdog alarm on. A month still to
   * index has no indexed_at (landing clears it). For the watchdog only: one row read a month.
   */
  async pruneIndexing(): Promise<string[]> {
    const book = this.status();
    const cursor = this.ctx.storage.sql.exec<{ month: string }>(
      `SELECT month FROM basin_months WHERE indexed_at IS NULL AND month IN (${book.indexing.map(() => '?').join(',')})`,
      ...book.indexing,
    );
    const pending = new Set(cursor.toArray().map((r) => r.month));
    this.count({ do_rows_read: cursor.rowsRead });
    if (pending.size < book.indexing.length) {
      book.indexing = book.indexing.filter((m) => pending.has(m));
      if (!book.indexing.length) book.indexWait = null;
      this.count({ do_rows_written: this.saveStatus() });
    }
    return book.indexing;
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

  /** Record the mailbox's labels, so the Labels page can name them. Counts are kept. */
  async putLabels(labels: MailLabel[]): Promise<void> {
    this.settleRollups();
    const sql = this.ctx.storage.sql;
    this.kept.clear();
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
    this.settleRollups();
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
  /**
   * An archive's import has read its whole file: each month's message count stands in for Gmail's
   * (the census), and every month with mail is queued as one job, so the map and the Backfills
   * list show the import like a backfill. Returns the job.
   */
  async importPlan(label: string, months: Record<string, number>, total: number): Promise<number> {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const at = new Date().toISOString();
      let written = 0;
      for (const [month, n] of Object.entries(months))
        written += sql.exec(
          `INSERT INTO gmail_months (month, n, counted_at) VALUES (?, ?, ?) ON CONFLICT (month) DO UPDATE SET n = excluded.n, counted_at = excluded.counted_at`,
          month, n, at,
        ).rowsWritten;
      const job = sql.exec<{ id: number }>(`INSERT INTO jobs (created_at, label) VALUES (?, ?) RETURNING id`, at, label).toArray()[0].id;
      for (const month of Object.keys(months)) written += sql.exec(`INSERT INTO job_months (job, month, state) VALUES (?, ?, 'queued')`, job, month).rowsWritten;
      const sync: SyncState = {
        phase: 'backfill', runId: 'import', total, copied: 0, bytes: 0, pending: [], pageToken: null, historyId: null,
        startedAt: at, updatedAt: at, basinQueue: [], basinReady: true, resumesAt: null, error: null, lanes: [],
      };
      written += this.putMeta('sync', { ...sync, recent: withRecent(sync, at) });
      this.changedMonths();
      written += 1 + this.changed(Object.keys(months), [job]);
      this.count({ do_rows_written: written });
      return job;
    });
  }

  /**
   * One import run's progress: what it copied to Basin each month, and the months it is in now.
   * One call a run (a few rows), like a lane's turn; the import's own state is a raw file.
   */
  async importProgress(p: { job: number; copied: Record<string, number>; bytes: number; months: string[]; error: string | null }): Promise<void> {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      let written = 0;
      let added = 0;
      for (const [month, n] of Object.entries(p.copied)) {
        added += n;
        written += sql.exec(
          `INSERT INTO basin_months (month, copied) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET copied = copied + excluded.copied`,
          month, n,
        ).rowsWritten;
      }
      const running = p.months.filter((m) => !(m in p.copied)).concat(Object.keys(p.copied));
      for (const month of new Set(running))
        written += sql.exec(`UPDATE job_months SET state = 'running' WHERE job = ? AND month = ? AND state = 'queued'`, p.job, month).rowsWritten;
      const main = this.meta<SyncState>('sync');
      if (main) {
        const at = new Date().toISOString();
        const next: SyncState = { ...main, copied: main.copied + added, bytes: main.bytes + p.bytes, updatedAt: at, lanes: p.months, error: p.error };
        written += this.putMeta('sync', { ...next, recent: withRecent(next, at) });
      }
      this.sample(Date.now());
      this.tallyJob(p.job, added, p.bytes);
      written += this.changed(new Set([...running, ...Object.keys(p.copied)]), [p.job]);
      this.count({ do_rows_written: written });
    });
  }

  /** The import copied the whole file: every month lands (its index is built next), and copying shows done. */
  async importLand(job: number, months: string[]): Promise<void> {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      const at = new Date().toISOString();
      let written = 0;
      for (const month of months)
        written += sql.exec(
          `INSERT INTO basin_months (month, copied, landed_at) VALUES (?, 0, ?) ON CONFLICT (month) DO UPDATE SET landed_at = excluded.landed_at, indexed_at = NULL`,
          month, at,
        ).rowsWritten;
      written += sql.exec(`UPDATE job_months SET state = 'done', error = NULL, finished_at = ? WHERE job = ? AND state IN ('queued', 'running')`, at, job).rowsWritten;
      const main = this.meta<SyncState>('sync');
      if (main) written += this.putMeta('sync', { ...main, phase: 'live', lanes: [], updatedAt: at, error: null });
      this.changedMonths();
      written += this.changed(months, [job]);
      this.count({ do_rows_written: written });
    });
  }

  /**
   * The import is searchable: a month the file held a message twice in counts it once (its index
   * did), so the month isn't shown short. Messages too big to import still count as missing.
   */
  async importSettle(tooBig: Record<string, number>): Promise<void> {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      const rows = sql.exec<{ month: string; n: number; copied: number }>(
        `SELECT g.month, g.n, b.copied FROM gmail_months g JOIN basin_months b ON b.month = g.month WHERE b.indexed_at IS NOT NULL`,
      ).toArray();
      let written = 0;
      const changed: string[] = [];
      for (const r of rows) {
        const n = r.copied + (tooBig[r.month] ?? 0);
        if (n >= r.n) continue;
        written += sql.exec(`UPDATE gmail_months SET n = ? WHERE month = ?`, n, r.month).rowsWritten;
        changed.push(r.month);
      }
      if (changed.length) written += this.changed(changed);
      this.count({ do_rows_read: rows.length * 2, do_rows_written: written });
    });
  }

  /** The import stopped on an error that needs the person: the page shows it. */
  async importFailed(error: string): Promise<void> {
    const main = this.meta<SyncState>('sync');
    if (main) this.count({ do_rows_written: this.putMeta('sync', { ...main, phase: 'error', lanes: [], error, updatedAt: new Date().toISOString() }) });
  }

  /** The labels the index holds, by ID, with their names: an archive's Labels (it has no Gmail to ask). */
  async labelMap(): Promise<GmailLabels> {
    this.settleRollups();
    const cursor = this.ctx.storage.sql.exec<{ id: string; name: string; type: string }>(`SELECT id, name, type FROM labels`);
    const out: GmailLabels = {};
    for (const l of cursor) out[l.id] = { name: l.name, type: l.type === 'system' ? 'system' : 'user' };
    this.count({ do_rows_read: cursor.rowsRead });
    return out;
  }

  async putMonthCount(month: string, n: number): Promise<void> {
    const { rowsWritten } = this.ctx.storage.sql.exec(
      `INSERT INTO gmail_months (month, n, counted_at) VALUES (?, ?, ?) ON CONFLICT (month) DO UPDATE SET n = excluded.n, counted_at = excluded.counted_at`,
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
    running: ActiveJob[];
    history: JobRecord[];
  }> {
    const book = this.status();
    const wait = book.indexWait && Date.parse(book.indexWait.resumesAt) > Date.now() ? book.indexWait : null;
    const sync = await this.syncView();
    return {
      sync,
      running: this.runningJobs(sync),
      history: structuredClone(book.history ?? []),
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

  /**
   * Jobs going now, from the sync state, the status row and memory (no row): the open sync job
   * with what it is doing, then each backfill still queued or copying, newest first.
   */
  private runningJobs(sync: SyncState | null): ActiveJob[] {
    const out: ActiveJob[] = [];
    const status = syncStatus(sync);
    if (sync?.run && (status === 'running' || status === 'waiting')) {
      const run = sync.run;
      out.push({
        id: `sync:${run.startedAt}`, kind: 'sync', label: run.by === 'you' ? 'Sync now' : 'Scheduled sync', by: run.by, startedAt: run.startedAt,
        step: this.step?.runId === sync.runId ? this.step.text : null, copied: run.copied, resumesAt: status === 'waiting' ? sync.resumesAt : null,
      });
    }
    const book = this.status();
    const lanes = this.lanes();
    for (const j of book.jobs) {
      if (j.status !== 'queued' && j.status !== 'running') continue;
      // Months its lanes are copying now, with what they copied that hasn't landed yet.
      const copying = [...lanes].filter(([, job]) => job === j.id).map(([month]) => month).sort().reverse();
      const unlanded = copying.reduce((n, m) => n + (this.live.get(m)?.copied ?? 0), 0);
      const name = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
      const total = Object.values(j.months).reduce((n, x) => n + x, 0);
      out.push({
        id: `backfill:${j.id}`, kind: 'backfill', label: j.label, by: 'you', startedAt: j.createdAt,
        step: copying.length ? `Copying ${copying.map(name).join(', ')}` : 'Queued: starts when a lane is free',
        copied: (book.tally?.[j.id]?.copied ?? 0) + unlanded,
        months: { done: j.months.done, failed: j.months.failed, total },
      });
    }
    return out;
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
   * so a retried batch never double-counts. Each added message's share goes into the month,
   * sender, domain and label totals, written once a batch, not once a message (S4 measured
   * per-message writes at a third of the write budget). `newMail` is mail in a month already
   * indexed; without it (a month copied or imported) the batch's months show as indexing.
   */
  async ingest(batch: IndexedMessage[], newMail = true): Promise<IngestResult> {
    try {
      return this.ingestBatch(batch, newMail);
    } catch (e) {
      // Rolled back: the waiting shares are read again from their row.
      this.waiting = undefined;
      throw e;
    }
  }

  private ingestBatch(batch: IndexedMessage[], newMail: boolean): IngestResult {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      let rowsWritten = 0;
      const run = (query: string, ...args: (string | number)[]) => {
        rowsWritten += sql.exec(query, ...args).rowsWritten;
      };
      const months: Tally = new Map();
      const marked = new Map<string, number>();
      const counted: Counted[] = [];
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
          `INSERT INTO messages (id, thread_id, ts, from_addr, from_name, subject, snippet, size, attachments, labels, raw_key, raw_offset, raw_len, body, rcpt, attach)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          m.id, m.threadId, m.ts, m.fromAddr, m.fromName, m.subject, m.snippet, m.size, m.attachments, labelText,
          m.raw ?? null, m.rawOffset ?? null, m.rawLen ?? null, m.body === undefined ? null : 1, m.rcpt ?? null,
          // Freshly copied mail with attachments waits for the sync's attachment pass.
          m.body !== undefined && m.attachments > 0 ? '?' : null,
        );
        rowsWritten += insert.rowsWritten;
        if (insert.rowsWritten === 0) continue;
        addedIds.push(m.id);
        run(
          `INSERT INTO message_fts (rowid, subject, from_addr, from_name, snippet, labels)
           VALUES (CAST(? AS INTEGER), ?, ?, ?, ?, ?)`,
          ftsRowid(m.id), m.subject, m.fromAddr, m.fromName, m.snippet, labelText,
        );
        if (m.body) run(`INSERT INTO body_fts (rowid, body) VALUES (CAST(? AS INTEGER), ?)`, ftsRowid(m.id), m.body);
        tally(months, monthOf(m.ts), m);
        if (labelled(m.labels)) marked.set(monthOf(m.ts), (marked.get(monthOf(m.ts)) ?? 0) + 1);
        counted.push(m);
      }
      // Sender, domain and label totals: a batch of 25 touched about two rows a message there, as
      // most of its senders differ. Their shares wait in one row and are written together, once
      // ROLLUP_EVERY messages have come in or before anything reads or takes away from the totals.
      if (counted.length) {
        const shares = rollupShares(counted, structuredClone(this.waitingShares() ?? undefined));
        if (shares.n >= ROLLUP_EVERY) {
          writeRollups(run, shares, 1);
          run(`DELETE FROM meta WHERE key = 'rollups_waiting'`);
          this.waiting = null;
        } else {
          rowsWritten += this.putMeta('rollups_waiting', sharesJson(shares));
          this.waiting = shares;
        }
      }
      for (const [month, t] of months)
        run(
          `INSERT INTO months (month, n, bytes, labelled) VALUES (?, ?, ?, ?) ON CONFLICT (month) DO UPDATE SET
             n = n + excluded.n, bytes = bytes + excluded.bytes, labelled = labelled + excluded.labelled`,
          month, t.n, t.bytes, marked.get(month) ?? 0,
        );
      // New mail in a month already built from Basin: it is in Basin too, so count it as
      // copied. The month's copied count is otherwise only set when its index is built.
      if (newMail)
        for (const [month, t] of months)
          run(`UPDATE basin_months SET copied = copied + ? WHERE month = ? AND indexed_at IS NOT NULL`, t.n, month);
      const added = addedIds.length;
      // A month copied or imported: the batch's months are indexing, and no longer waiting.
      const touched = new Set(batch.map((m) => monthOf(m.ts)));
      if (added || (!newMail && batch.length)) {
        const book = this.status();
        if (!newMail) {
          for (const m of touched) if (!book.indexing.includes(m)) book.indexing.push(m);
          book.indexWait = null;
        }
        rowsWritten += this.changed(added ? touched : []);
        this.count({ messages_indexed: added, do_rows_written: rowsWritten });
      }
      return { added, skipped: batch.length - added, rowsWritten, addedIds };
    });
  }

  /** Shares waiting to be added to the totals (ingest), kept in memory once read; undefined until read. */
  private waiting: Shares | null | undefined;
  private waitingShares(): Shares | null {
    if (this.waiting === undefined) {
      const j = this.meta<ReturnType<typeof sharesJson>>('rollups_waiting');
      this.waiting = j ? sharesOf(j) : null;
    }
    return this.waiting;
  }

  /** Write the waiting shares into the sender, domain and label totals: before anything reads or takes away from them. */
  private settleRollups(): void {
    if (!this.waitingShares()) return;
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      let written = 0;
      const run = (query: string, ...args: (string | number)[]) => void (written += sql.exec(query, ...args).rowsWritten);
      writeRollups(run, this.waiting!, 1);
      run(`DELETE FROM meta WHERE key = 'rollups_waiting'`);
      this.count({ do_rows_written: written });
    });
    this.waiting = null;
  }

  /**
   * Add to today's usage. Rows written includes this call's own writes, one a metric,
   * so the meter never under-reports what the free tier counts.
   */
  private count(usage: Partial<Record<UsageMetric, number>>) {
    // Any write may change what a kept read answered.
    if (usage.do_rows_written) this.kept.clear();
    const others = Object.entries(usage).filter(([m, v]) => m !== 'do_rows_written' && v);
    const written = (usage.do_rows_written ?? 0) + others.length + 1; // +1: the rows-written row itself
    const day = today();
    for (const [metric, value] of [...others, ['do_rows_written', written] as const])
      this.ctx.storage.sql.exec(
        `INSERT INTO usage_days (day, metric, value) VALUES (?, ?, ?) ON CONFLICT (day, metric) DO UPDATE SET value = value + excluded.value`,
        day, metric, value,
      );
  }

  /**
   * Archive answers kept in memory until the next write (count() with rows written clears them),
   * so a page shown again reads no rows and meters nothing. The 8 most recently used.
   */
  private kept = new Map<string, unknown>();
  private keep<T>(key: string, read: () => T): T {
    if (this.kept.has(key)) {
      const hit = this.kept.get(key) as T;
      this.kept.delete(key);
      this.kept.set(key, hit);
      return hit;
    }
    const value = read();
    this.kept.set(key, value);
    if (this.kept.size > 8) this.kept.delete(this.kept.keys().next().value as string);
    return value;
  }

  /**
   * One archive page's rows, read from the rollups so no page scans every message.
   * `q` searches subject, sender, snippet and labels; each word must match.
   */
  async archive<V extends ArchiveView>(view: V, q = ''): Promise<ArchiveRows[V][]> {
    if (view !== 'months' && view !== 'messages') this.settleRollups();
    return this.keep(`archive:${view}:${q}`, () => this.readArchive(view, q));
  }

  private readArchive<V extends ArchiveView>(view: V, q: string): ArchiveRows[V][] {
    const sql = this.ctx.storage.sql;
    const rows = (query: string, ...args: (string | number)[]) => {
      const cursor = sql.exec(query, ...args);
      const out = cursor.toArray() as unknown as ArchiveRows[V][];
      this.count({ do_rows_read: cursor.rowsRead });
      return out;
    };
    switch (view) {
      case 'totals':
        return rows(`SELECT (SELECT count(*) FROM senders) AS senders, (SELECT count(*) FROM domains) AS domains`);
      case 'months':
        return rows(`SELECT month, n, bytes, labelled FROM months ORDER BY month`);
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
        const words = textMatch(q);
        const found = words
          ? rows(`SELECT ${cols} FROM messages WHERE ${words.where} ORDER BY ts DESC LIMIT ?`, ...words.args, ARCHIVE_LIMIT)
          : rows(`SELECT ${cols} FROM messages ORDER BY ts DESC LIMIT ?`, ARCHIVE_LIMIT);
        for (const m of found as unknown as { labels: string | string[] }[])
          m.labels = String(m.labels).split(' ').filter(Boolean);
        return found;
      }
    }
    throw new Error('unknown view');
  }

  /** The biggest senders, domains or labels by count, from their rollups (the MCP server's aggregate). */
  async top(by: 'senders' | 'domains' | 'labels', limit: number): Promise<(SenderRow | DomainRow | LabelRow)[]> {
    const query = {
      senders: `SELECT addr, name, n, bytes, first_ts AS firstTs, last_ts AS lastTs FROM senders ORDER BY n DESC LIMIT ?`,
      domains: `SELECT domain, n, bytes FROM domains ORDER BY n DESC LIMIT ?`,
      labels: `SELECT id, name, type, n, bytes FROM labels WHERE n > 0 ORDER BY n DESC LIMIT ?`,
    }[by];
    const cursor = this.ctx.storage.sql.exec(query, limit);
    const out = cursor.toArray() as unknown as (SenderRow | DomainRow | LabelRow)[];
    this.count({ do_rows_read: cursor.rowsRead });
    return out;
  }

  /** The database's size in bytes, as SQLite counts its pages. */
  async databaseSize(): Promise<number> {
    return this.ctx.storage.sql.databaseSize;
  }

  /**
   * How the database's bytes split: message metadata and rollups (bytes as stored), the envelope and
   * body search indexes (their blocks), and the rest (plain indexes and page overhead). Reads every
   * message row once, so only on request (a `sizes` run of the sync Workflow).
   */
  async storageSizes(): Promise<{ total: number; messages: number; metadata: number; envelopeSearch: number; bodySearch: number; attachSearch: number; indexesAndOverhead: number }> {
    const sql = this.ctx.storage.sql;
    let read = 0;
    const one = (query: string) => {
      const c = sql.exec<{ v: number | null }>(query);
      const v = c.one().v ?? 0;
      read += c.rowsRead;
      return v;
    };
    const total = sql.databaseSize;
    const messages = one(`SELECT COUNT(*) AS v FROM messages`);
    // Stored bytes of each row: text as written, numbers at 8 bytes. SQLite's page split isn't readable here.
    const metadata = one(
      `SELECT SUM(length(id) + length(thread_id) + length(from_addr) + length(from_name) + length(subject) + length(snippet)
         + length(labels) + length(state) + ifnull(length(raw_key), 0) + 48) AS v FROM messages`,
    ) +
      one(`SELECT SUM(length(addr) + length(name) + 32) AS v FROM senders`) +
      one(`SELECT SUM(length(domain) + 16) AS v FROM domains`) +
      one(`SELECT SUM(length(month) + 16) AS v FROM months`) +
      one(`SELECT SUM(length(id) + length(name) + length(type) + 16) AS v FROM labels`);
    const envelopeSearch = one(`SELECT SUM(length(block)) AS v FROM message_fts_data`);
    const bodySearch = one(`SELECT SUM(length(block)) AS v FROM body_fts_data`);
    const attachSearch = one(`SELECT SUM(length(block)) AS v FROM attach_fts_data`);
    this.count({ do_rows_read: read });
    return {
      total, messages, metadata, envelopeSearch, bodySearch, attachSearch,
      indexesAndOverhead: Math.max(0, total - metadata - envelopeSearch - bodySearch - attachSearch),
    };
  }

  /** Whether the thread index is built; null until read from the schema. */
  private threadReady: boolean | null = null;
  private threadTried = 0;

  /**
   * One conversation, oldest first (the MCP server's list_thread), and how many messages it has.
   * Its index is built like the sort indexes: once the day's DO writes have room for one write a
   * message. Until then a conversation is found by reading the whole mailbox.
   */
  async thread(threadId: string, limit: number): Promise<{ rows: MessageRow[]; total: number }> {
    const sql = this.ctx.storage.sql;
    this.threadReady ??= sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'messages_thread'`).toArray().length > 0;
    if (!this.threadReady && Date.now() - this.threadTried >= 5 * 60_000) {
      this.threadTried = Date.now();
      const quota = accountQuota(this.env);
      if (!(await quota.reserve({ do_rows_written: this.indexedTotal() + 100 }))) {
        const c = sql.exec(`CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, ts)`);
        this.count({ do_rows_written: c.rowsWritten, do_rows_read: c.rowsRead });
        await quota.add({ do_rows_written: c.rowsWritten, do_rows_read: c.rowsRead });
        console.log(JSON.stringify({ threadIndex: { rowsWritten: c.rowsWritten, rowsRead: c.rowsRead } }));
        this.threadReady = true;
      }
    }
    const c = sql.exec(
      `SELECT id, thread_id AS threadId, ts, from_addr AS fromAddr, from_name AS fromName,
         subject, snippet, size, attachments, labels, state
       FROM messages WHERE thread_id = ? ORDER BY ts, id`,
      threadId,
    );
    const all = c.toArray() as unknown as (Omit<MessageRow, 'labels'> & { labels: string })[];
    this.count({ do_rows_read: c.rowsRead });
    return { rows: all.slice(0, limit).map((r) => ({ ...r, labels: r.labels.split(' ').filter(Boolean) })), total: all.length };
  }

  /**
   * How many messages match, in one query rather than pages (the MCP server's count_messages and
   * search_messages' total), optionally grouped by one or two of: sender, domain, label, recipient,
   * month, year. Dates seek the ts index; the rest is checked on those rows. `keys` also returns
   * each match's sender, subject and minute, so mailboxes can be counted together without a
   * message held in two of them counted twice.
   */
  async countMessages(
    q: { text?: string; from?: string; to?: string; domain?: string; label?: string; after?: number; before?: number; attachments?: boolean },
    groupBy: CountDim[],
    keys = false,
  ): Promise<{ total: number; bytes: number; groups: { key: string; sub?: string; n: number; bytes: number }[]; keys?: string[]; unknownLabel?: true; rcptPending?: true }> {
    const sql = this.ctx.storage.sql;
    let read = 0;
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.after !== undefined) where.push('ts >= ?'), args.push(q.after);
    if (q.before !== undefined) where.push('ts < ?'), args.push(q.before);
    if (q.from) where.push(`(instr(lower(from_addr), ?) > 0 OR instr(lower(from_name), ?) > 0)`), args.push(q.from.toLowerCase(), q.from.toLowerCase());
    if (q.to) where.push(`instr(rcpt, ?) > 0`), args.push(q.to.toLowerCase());
    if (q.domain) {
      // The domain and its subdomains: amazon.com counts mail from amazon.com and email.amazon.com.
      const d = q.domain.toLowerCase().replace(/^@/, '');
      where.push(`(lower(from_addr) LIKE ? ESCAPE '\\' OR lower(from_addr) LIKE ? ESCAPE '\\')`);
      const lit = d.replace(/[\\%_]/g, (c) => `\\${c}`);
      args.push(`%@${lit}`, `%.${lit}`);
    }
    if (q.attachments) where.push('attachments > 0');
    if (q.label) {
      this.settleRollups();
      const v = q.label;
      const c = sql.exec<{ id: string }>(`SELECT id FROM labels WHERE id = ? OR id = ? OR lower(name) = ?`, v, v.toUpperCase(), v.toLowerCase());
      const ids = c.toArray().map((r) => r.id);
      read += c.rowsRead;
      if (!ids.length) return { total: 0, bytes: 0, groups: [], unknownLabel: true };
      where.push(`(${ids.map(() => `instr(' ' || labels || ' ', ?) > 0`).join(' OR ')})`);
      args.push(...ids.map((id) => ` ${id} `));
    }
    // Each word in the envelope, the body or an attachment, as one list of IDs: SQLite seeks those rows by key
    // instead of reading the mailbox (textMatch's OR reads every row).
    for (const w of q.text ? ftsQuery(q.text).split(' ').filter(Boolean) : []) {
      where.push(`id IN (${ftsIds('message_fts')} UNION ${ftsIds('body_fts')} UNION ${ftsIds('attach_fts')})`);
      args.push(w, w, w);
    }
    const byRcpt = !!q.to || groupBy.includes('recipient');
    if (!where.length && !groupBy.length && !keys) {
      // No filter: the running totals hold it.
      const [m] = sql.exec<{ b: number }>(`SELECT coalesce(sum(bytes), 0) AS b FROM months`).toArray();
      return { total: this.indexedTotal(), bytes: m?.b ?? 0, groups: [] };
    }
    const cond = where.length ? where.join(' AND ') : '1';
    const exec = <R extends Record<string, SqlStorageValue>>(query: string) => {
      const c = sql.exec<R>(query, ...args);
      const out = c.toArray();
      read += c.rowsRead;
      return out;
    };
    const [sum] = exec<{ n: number; b: number }>(`SELECT count(*) AS n, coalesce(sum(size), 0) AS b FROM messages WHERE ${cond}`);
    let groups: { key: string; sub?: string; n: number; bytes: number }[] = [];
    if (groupBy.length === 1 && groupBy[0] in COUNT_SQL) {
      groups = exec<{ key: string; n: number; bytes: number }>(
        `SELECT ${COUNT_SQL[groupBy[0] as keyof typeof COUNT_SQL]} AS key, count(*) AS n, coalesce(sum(size), 0) AS bytes FROM messages WHERE ${cond} GROUP BY 1`,
      );
    } else if (groupBy.length) {
      // Labels and recipients are several a message, and two dimensions cross: grouped here.
      const values = (d: CountDim, r: { from_addr: string; ts: number; labels: string; rcpt: string | null }): string[] => {
        if (d === 'label') return r.labels.split(' ').filter(Boolean);
        if (d === 'recipient') return (r.rcpt ?? '').split(' ').filter(Boolean);
        if (d === 'sender') return [r.from_addr.toLowerCase()];
        if (d === 'domain') return [(r.from_addr.split('@')[1] ?? '').toLowerCase()];
        const iso = new Date(r.ts).toISOString();
        return [d === 'month' ? iso.slice(0, 7) : iso.slice(0, 4)];
      };
      const n = new Map<string, { key: string; sub?: string; n: number; bytes: number }>();
      for (const r of exec<{ from_addr: string; ts: number; labels: string; rcpt: string | null; size: number }>(
        `SELECT from_addr, ts, labels, rcpt, size FROM messages WHERE ${cond}`,
      ))
        for (const a of values(groupBy[0], r))
          for (const b of groupBy[1] ? values(groupBy[1], r) : [undefined]) {
            const k = b === undefined ? a : `${a}\u0000${b}`;
            const g = n.get(k) ?? { key: a, ...(b !== undefined ? { sub: b } : {}), n: 0, bytes: 0 };
            g.n++;
            g.bytes += r.size;
            n.set(k, g);
          }
      groups = [...n.values()];
    }
    const out = keys
      ? exec<{ k: string }>(`SELECT lower(from_addr) || '|' || subject || '|' || (ts / 60000) AS k FROM messages WHERE ${cond} LIMIT 50000`).map((r) => r.k)
      : undefined;
    // Until the recipients pass is done, mail copied before it can't match a recipient: say so.
    let pending = byRcpt && sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'rcpt_pass'`).toArray()[0]?.value !== '~done';
    if (pending && !sql.exec(`SELECT 1 FROM messages WHERE rcpt IS NULL LIMIT 1`).toArray().length) {
      // Every message was copied with its recipients (a mailbox added since): nothing for the pass to do.
      sql.exec(`INSERT INTO meta (key, value) VALUES ('rcpt_pass', '~done') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
      pending = false;
    }
    this.count({ do_rows_read: read });
    return { total: sum?.n ?? 0, bytes: sum?.b ?? 0, groups, ...(out ? { keys: out } : {}), ...(pending ? { rcptPending: true as const } : {}) };
  }

  /**
   * One page of Messages groups, largest first, from the rollups: no message is read. Counts are
   * the rollup's, so they hold for the whole mailbox only: under other filters each is null.
   * Senders and domains page on their n index, GROUPS_PAGE at a time; the rest come whole.
   */
  /**
   * How many messages each time span holds, for Group by Period. Whole UTC months come from the
   * months rollup; the rest (a week, a day, a time zone's hours at a month's edge) is counted off
   * the ts index, a read per message there.
   */
  async periodCounts(spans: [number, number][]): Promise<number[]> {
    const sql = this.ctx.storage.sql;
    let read = 0;
    const exec = <R extends Record<string, SqlStorageValue>>(query: string, ...args: number[]) => {
      const c = sql.exec<R>(query, ...args);
      read += c.rowsRead;
      return c.toArray();
    };
    const months = new Map(exec<{ month: string; n: number }>(`SELECT month, n FROM months`).map((r) => [r.month, r.n]));
    const count = (a: number, b: number) => (a < b ? exec<{ n: number }>(`SELECT count(*) AS n FROM messages WHERE ts >= ? AND ts < ?`, a, b)[0].n : 0);
    const monthStart = (t: number, up: boolean) => {
      const d = new Date(t);
      const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth());
      return up && at < t ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1) : at;
    };
    const out = spans.map(([from, to]) => {
      to = Math.min(to, Date.now() + 86_400_000);
      if (to <= from) return 0;
      const a = monthStart(from, true);
      const b = monthStart(to, false);
      if (a >= b) return count(from, to);
      let n = count(from, a) + count(b, to);
      for (let m = a; m < b; m = monthStart(m + 32 * 86_400_000, false)) n += months.get(monthOf(m)) ?? 0;
      return n;
    });
    this.count({ do_rows_read: read });
    return out;
  }

  async messageGroups(by: MessageGroupBy, filtered: boolean, after: string | null): Promise<MessageGroups> {
    this.settleRollups();
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
    let total: number | null = null;
    if (by === 'from' || by === 'domain') {
      const [table, key] = by === 'from' ? ['senders', 'addr'] : ['domains', 'domain'];
      // The cursor is the last group's (n, key): shaped like a Size cursor, (number, string).
      const at = after ? decodeCursor(after, [{ keys: SORT_KEYS.size }])?.slice(1) : null;
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
      // The pager's total, counted once on the first page (one read per sender or domain).
      if (!after) total = got.length < GROUPS_PAGE ? got.length : (exec<{ c: number }>(`SELECT count(*) AS c FROM ${table} WHERE n > 0`)[0]?.c ?? null);
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
    return { groups, next, total: by === 'from' || by === 'domain' ? total : groups.length };
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
        sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'messages_%'`).toArray().map((r) => r.name),
      );
      // Category needs no index: it reads each category in date order, one after another.
      this.sortsReady = new Set<MessageSort>(['date', 'category', ...SORT_INDEXES.filter((x) => have.has(x.name)).map((x) => x.sort)]);
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
  async messagePage(
    filters: MessageFilter[],
    cursor: string | null,
    size: number,
    asc: boolean,
    sort: MessageSort = 'date',
    skip = 0,
  ): Promise<MessagePage> {
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
    // Words match the envelope or the body, each on its own; labels match the envelope's index.
    const words = textMatch(text);
    const match = rare.map((l) => `labels : "${l!.id.replaceAll('"', '""')}"`).join(' ');
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
    const lo = spans.length ? Math.max(...spans.map((x) => x[0])) : null;
    const hi = spans.length ? Math.min(...spans.map((x) => x[1])) : null;
    // The order as phases read one after another (Attachments: with, then without; Category: each).
    const phases = sortPhases(by, asc, by === 'category' && !labelIds.length ? exec<{ id: string; n: number }>(`SELECT id, n FROM labels`) : labelIds, this.indexedTotal());
    // A jump to a page (no cursor, `skip` rows in). By date with no filter, the months' counts find
    // the month the page starts in: the read seeks to it and skips that month's rows only. Another
    // counted, one-phase order past its middle reads from the other end instead.
    let anchor: SortKey | null = null;
    if (skip && !cursor) {
      const all = this.filteredTotal(filters, labelIds, exec);
      if (all !== null) {
        skip = Math.min(skip, Math.max(0, Math.floor((all - 1) / size) * size));
        if (!filters.length && by === 'date' && phases.length === 1) {
          const months = Object.entries(this.status().months)
            .filter(([, m]) => m.indexed > 0)
            .map(([month, m]) => [month, m.indexed] as const)
            .sort(([a], [b]) => (asc ? a.localeCompare(b) : b.localeCompare(a)));
          let before = 0;
          for (const [month, n] of months) {
            if (before + n > skip) {
              if (before) {
                // Newest first: rows before the next month's start; oldest first: from this month's start.
                anchor = asc ? [Date.parse(`${month}-01T00:00:00Z`) - 1, '~'] : [Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`), ''];
                skip -= before;
              }
              break;
            }
            before += n;
          }
        } else if (phases.length === 1 && skip * 2 + size > all) {
          const end = Math.min(skip + size, all);
          const back = await this.messagePage(filters, null, end - skip, !asc, sort, all - end);
          back.rows.reverse();
          const last = back.rows.at(-1);
          return { ...back, next: end < all && last ? JSON.stringify(keyOf(phases[0].keys, last)) : null, partial: false };
        }
      }
    }
    // The rows a page reads: the skipped ones too, then one more to know a page follows.
    const need = (cursor ? 0 : skip) + size;
    const budget = SCAN_BUDGET + (need - size) * 4;
    // Under a search, whether the envelope holds every word: if not, the row matched on its body or an attachment.
    const envelope = words ? ftsQuery(text) : '';
    const cols = `id, thread_id AS threadId, ts, from_addr AS fromAddr, from_name AS fromName,
      subject, snippet, size, attachments, labels, state, rcpt${
        envelope ? `, attach, id IN (${ftsIds('message_fts')}) AS envelope, id IN (${ftsIds('attach_fts')}) AS inAttach` : ''
      }`;
    const [cmp, dir] = asc ? ['>', 'ASC'] : ['<', 'DESC'];
    // A cursor is the phase, then the last row's keys in that phase's order.
    const from = cursor ? decodeCursor(cursor, phases) : null;
    let p = from?.[0] ?? 0;
    let at: SortKey | null = from ? from.slice(1) : anchor;
    const rows: MessageRow[] = [];
    const ends: SortKey[] = [];
    let scanned = 0;
    let more = true;
    let last: SortKey | null = null;
    while (rows.length <= need && scanned < budget && (more || p < phases.length - 1)) {
      if (!more) {
        // This phase is read to its end: the next starts from its top.
        p++;
        at = null;
        more = true;
      }
      const { keys, where: also, test, label } = phases[p];
      const phaseMatch = [match, label ? `labels : "${label}"` : ''].filter(Boolean).join(' ');
      const bounded = keys[0] === 'ts';
      const chunk = rest.length || test ? SCAN_CHUNK : need + 1 - rows.length;
      const where = [
        at ? `(${keys.join(', ')}) ${cmp} (${keys.map(() => '?').join(', ')})` : '1',
        bounded && lo !== null && Number.isFinite(lo) ? 'ts >= ?' : '1',
        bounded && hi !== null && Number.isFinite(hi) ? 'ts < ?' : '1',
        phaseMatch ? `id IN (${ftsIds('message_fts')})` : '1',
        words?.where ?? '1',
        sender ? 'lower(from_addr) = ?' : '1',
        also ?? '1',
      ];
      const args: (string | number)[] = [
        ...(envelope ? [envelope, envelope] : []),
        ...(at ?? []),
        ...(bounded && lo !== null && Number.isFinite(lo) ? [lo] : []),
        ...(bounded && hi !== null && Number.isFinite(hi) ? [hi] : []),
        ...(phaseMatch ? [phaseMatch] : []),
        ...(words?.args ?? []),
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
        last = keyOf(keys, g);
        const { envelope: inEnvelope, inAttach, attach, ...row } = g as typeof g & { envelope?: number; inAttach?: number; attach?: string | null };
        // Not in the envelope: in an attachment when its text holds every word, else in the body.
        const file = envelope && !inEnvelope && inAttach && attachIndexed(attach ?? null) ? (JSON.parse(attach!) as string[])[0] : undefined;
        const hit = !envelope || inEnvelope ? {} : file ? { attachHit: file } : { bodyHit: true };
        const m = { ...row, labels: row.labels.split(' ').filter(Boolean), ...hit } as MessageRow;
        if (!keep(m) || (test && !test(m))) continue;
        rows.push(m);
        ends.push([p, ...last]);
        if (rows.length > need) break;
      }
      at = last;
    }
    const full = rows.length > need;
    if (full) rows.length = need;
    const end = full ? ends[need - 1] : more ? (last ? [p, ...last] : null) : p < phases.length - 1 ? [p + 1] : null;
    const unindexed = Object.values(this.status().months).filter((m) => m.inBasin > 0 && m.indexState !== null && m.indexState !== 'done').length;
    rows.splice(0, need - size);
    const total = this.filteredTotal(filters, labelIds, exec);
    this.count({ do_rows_read: read });
    return {
      rows,
      next: end ? JSON.stringify(phases.length > 1 ? end : end.slice(1)) : null,
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
      waiting: !hasAccount ? 'Add a Gmail account in Settings ▸ Accounts first' : null,
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
   * going (what, per account: logged on the gmail-sync line), which keeps the watchdog alarm set. A census that stopped on an error is retried only
   * at a sync slot (`slot`): retried every tick, a failing census kept the alarm going all day.
   */
  private async recover(user: UserId, slot: boolean): Promise<string[]> {
    const paused = this.isPaused();
    const busy: string[] = [];
    for (const a of this.accountList()) {
      try {
        const mailbox = accountMailbox(this.env, user, a.id);
        const v = await mailbox.statusView();
        // An archive has no Gmail: its import restarts where it stood if its run died.
        if (a.kind === 'archive') {
          const importing = await keepImporting(this.env, user, a.id);
          if (importing) busy.push(`${a.id}:import ${importing}`);
          if (v.index.status === 'indexing') {
            const months = await mailbox.pruneIndexing();
            if (months.length) busy.push(`${a.id}:index ${months.join(' ')}`);
          }
          continue;
        }
        const sync = await this.keepRunning(user, a.id, v.sync, paused);
        const census = (await this.keepCounting(user, a.id, v.census, slot)) ?? v.census;
        const status = syncStatus(sync);
        if (status === 'stopped' || census?.error)
          console.warn('account-error', JSON.stringify({ account: a.id, email: a.email, sync: status === 'stopped' ? sync?.error : null, census: census?.error ?? null }));
        if (!paused && (status === 'running' || status === 'waiting' || !!sync?.lanes?.length)) busy.push(`${a.id}:sync ${status}`);
        else if (!paused && (await mailbox.hasQueued())) busy.push(`${a.id}:queued`);
        if (!!census && census.month !== null && !census.error && !(census.resumesAt && Date.parse(census.resumesAt) > Date.now())) busy.push(`${a.id}:census ${census.month}`);
        if (v.index.status === 'indexing') {
          const months = await mailbox.pruneIndexing();
          if (months.length) busy.push(`${a.id}:index ${months.join(' ')}`);
        } else if (v.index.status !== 'idle') busy.push(`${a.id}:index ${v.index.status}`);
      } catch (e) {
        console.error('watchdog', a.id, e);
        busy.push(`${a.id}:error`);
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
    // A reconnected account retries its census now, and its stopped sync starts again.
    const reconnected = [...this.reconnected];
    this.reconnected.clear();
    const busy = await this.recover(user, due || reconnected.length > 0);
    for (const id of reconnected)
      try {
        await this.syncAccount(id, true);
      } catch (e) {
        console.error('reconnect sync', id, e);
      }
    this.watching = busy.length > 0;
    console.log('gmail-sync', JSON.stringify({ on: sync.on, every: sync.every, tz: sync.tz, last: sync.last, slot: slot?.toISOString() ?? null, due, paused: this.pausedBy(), busy }));
    const ids = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM accounts WHERE kind = 'gmail'`).toArray().map((a) => a.id);
    if (due && ids.length && sync.on) {
      let run: ScheduleRun;
      if (this.isPaused()) run = { at: new Date().toISOString(), ok: true, detail: 'Backfill paused' };
      else {
        let started = 0;
        let failed = 0;
        for (const id of ids) {
          try {
            const r = await this.syncAccount(id, false, 'schedule');
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
    // An open sync job is its own work too: a run that died with one open starts again and closes it.
    const ownWork = state.phase !== 'live' || state.pending.length > 0 || state.basinQueue.length > 0 || !!state.run;
    if (state.lanes?.length) await launchLanes(this.env, user, account);
    if ((ownWork && syncStatus(state) === 'running' && (await runDied(this.env, state.runId))) || (await this.pauseLifted(state))) {
      await syncDeps.start(this.env, user, account);
      return await accountMailbox(this.env, user, account).syncView();
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
              // An archive's import was started by its upload and doesn't wait for the backfill's pause.
              copy: paused && a.kind !== 'archive' ? { status: 'paused', pausedBy: pausedBy! } : { status: sync.status === 'running' ? 'copying' : 'idle' },
              index,
              months: v.months,
              census: censusView(census),
              current: monthNow(),
              jobs: v.jobs,
              totals: { indexed: v.indexed },
              sizes: v.sizes,
              running: v.running,
              history: v.history,
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
    return { paused, pausedBy, state, resumesAt: state === 'index_waiting' ? waits[0] : null, accounts };
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
   * Starts the census when there is none and resumes one whose run died. At a sync slot (`slot`)
   * it also retries one that stopped on an error and recounts recent months every 6 hours.
   * Returns the census once started, else null.
   */
  private async keepCounting(user: UserId, account: string, c: CensusState | null, slot: boolean): Promise<CensusState | null> {
    const now = Date.now();
    const stale = c && now - Date.parse(c.updatedAt) >= SYNC_STALE_MS;
    const held = !!c?.resumesAt && Date.parse(c.resumesAt) > now;
    const mode =
      held ? null
      : !c ? 'full'
      : c.month !== null && (c.error ? slot : stale) ? 'resume'
      : slot && c.finishedAt && now - Date.parse(c.finishedAt) >= 6 * 3_600_000 ? 'refresh'
      : null;
    if (!mode) return null;
    await syncDeps.census(this.env, user, account, mode === 'refresh' ? 'refresh' : 'full');
    return accountMailbox(this.env, user, account).censusState();
  }

  /**
   * Start syncing an account unless a run is going or waiting to resume. Sync now (`manual`)
   * also restarts a sync that stopped on an error; the schedule leaves those for the person.
   * `by` opens a sync job for the history (Sync now, the schedule); other callers start runs only.
   */
  async syncAccount(account: string, manual: boolean, by?: JobBy): Promise<{ status: 'started' | SyncSummary['status'] } | { error: 'not_found' | 'paused' }> {
    const user = this.userId();
    if (!user || !this.isGmail(account)) return { error: 'not_found' };
    if (this.isPaused()) return { error: 'paused' };
    const state = await accountMailbox(this.env, user, account).syncState();
    const status = syncStatus(state);
    const dead = status === 'running' && (await runDied(this.env, state!.runId));
    const lifted = status === 'waiting' && (await this.pauseLifted(state!));
    if ((status === 'running' && !dead) || (status === 'waiting' && !lifted) || (status === 'stopped' && !manual)) return { status };
    await syncDeps.start(this.env, user, account, by);
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
  async backfill(account: string, months: string[], label: string): Promise<{ job: number | null; status: 'started' | SyncSummary['status'] } | { error: 'not_found' | 'paused' }> {
    const user = this.userId();
    if (!user || !this.isGmail(account)) return { error: 'not_found' };
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
    if (!user || !this.isGmail(account)) return { months: [], error: 'not_found' };
    const now = monthNow();
    const months = (await accountMailbox(this.env, user, account).coverageMonths())
      .filter((m) => m.month < now && m.gmail !== null && m.gmail - (m.unavailable ?? 0) > m.copied)
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
    if (!user || !this.isGmail(account) || !/^\d{4}-\d{2}$/.test(month)) return { started: false, active: [] };
    const ids = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM accounts WHERE kind = 'gmail'`).toArray().map((a) => a.id);
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
    if (!user || !this.isGmail(account)) return null;
    const changed = await accountMailbox(this.env, user, account).changeJob(job, action);
    if (changed === null) return null;
    if (action === 'retry' && changed && !this.isPaused()) await this.syncAccount(account, true);
    return { changed };
  }

  /** Take months out of an account's queue, or all when `months` is null. Null: not this user's account. */
  async unqueue(account: string, months: string[] | null): Promise<{ changed: number } | null> {
    const user = this.userId();
    if (!user || !this.isGmail(account)) return null;
    return { changed: await accountMailbox(this.env, user, account).unqueueMonths(months) };
  }

  private hasAccount(id: string): boolean {
    return this.accountList().some((a) => a.id === id);
  }

  /** A Gmail account (not an archive): the only kind that syncs, counts and backfills from Gmail. */
  private isGmail(id: string): boolean {
    return this.accountList().some((a) => a.id === id && a.kind === 'gmail');
  }

  /** Whether `id` is one of this person's mailboxes, Gmail or archive: what the archive pages check. */
  async hasMailbox(id: string): Promise<boolean> {
    return this.hasAccount(id);
  }

  async accountKind(id: string): Promise<'gmail' | 'archive' | null> {
    return this.accountList().find((a) => a.id === id)?.kind ?? null;
  }

  /** Each of the person's accounts' kind, by ID (the Worker keeps it a minute: index.ts kindOf). */
  async accountKinds(): Promise<Record<string, 'gmail' | 'archive'>> {
    return Object.fromEntries(this.accountList().map((a) => [a.id, a.kind]));
  }

  /** The person's mailboxes (id, name, kind), kept in memory once read: adding and removing are the only writers. */
  private accountsKept: { id: string; email: string; kind: 'gmail' | 'archive' }[] | null = null;
  private accountList(): { id: string; email: string; kind: 'gmail' | 'archive' }[] {
    this.accountsKept ??= this.ctx.storage.sql
      .exec<{ id: string; email: string; kind: 'gmail' | 'archive' }>(`SELECT id, email, kind FROM accounts ORDER BY added_at`)
      .toArray();
    return this.accountsKept;
  }

  /** Add an archive mailbox for an mbox file whose upload has just begun. */
  async addArchive(id: string, name: string, record: ArchiveRecord): Promise<void> {
    const at = new Date().toISOString();
    const { rowsWritten } = this.ctx.storage.sql.exec(
      `INSERT INTO accounts (id, email, refresh_token, scopes, added_at, tested_at, test_error, kind, archive) VALUES (?, ?, '', '', ?, ?, NULL, 'archive', ?)`,
      id, name, at, at, JSON.stringify(record),
    );
    this.accountsKept = null;
    this.count({ do_rows_written: rowsWritten });
  }

  /** An archive's file and upload, as saved; null for a Gmail account or none. */
  async archiveRecord(id: string): Promise<ArchiveRecord | null> {
    const row = this.ctx.storage.sql.exec<{ archive: string | null }>(`SELECT archive FROM accounts WHERE id = ? AND kind = 'archive'`, id).toArray()[0];
    return row?.archive ? (JSON.parse(row.archive) as ArchiveRecord) : null;
  }

  /** Change an archive's record (its status, say). Returns it as saved, or null for no such archive. */
  async setArchive(id: string, change: Partial<ArchiveRecord>): Promise<ArchiveRecord | null> {
    const current = await this.archiveRecord(id);
    if (!current) return null;
    const next = { ...current, ...change };
    const { rowsWritten } = this.ctx.storage.sql.exec(`UPDATE accounts SET archive = ? WHERE id = ?`, JSON.stringify(next), id);
    this.count({ do_rows_written: rowsWritten });
    // The import runs on its own; the watchdog restarts it if its run dies.
    if (change.status === 'importing') {
      this.watching = true;
      await this.ctx.storage.setAlarm(Date.now() + WATCH_MS);
    }
    return next;
  }

  /** Remove an archive mailbox. Returns its record, so the Worker can drop an unfinished upload. */
  async removeArchive(id: string): Promise<ArchiveRecord | null> {
    const record = await this.archiveRecord(id);
    if (!record) return null;
    this.ctx.storage.sql.exec(`DELETE FROM accounts WHERE id = ?`, id);
    this.accountsKept = null;
    this.count({ do_rows_written: 1 });
    return record;
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
      `INSERT INTO schedules (id, change) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET change = excluded.change`,
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
        `INSERT INTO accounts (id, email, refresh_token, scopes, added_at, tested_at, test_error) VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (id) DO UPDATE SET
           email = excluded.email, refresh_token = excluded.refresh_token, scopes = excluded.scopes,
           tested_at = excluded.tested_at, test_error = NULL`,
        account.id, account.email, token, account.scopes.join(' '), new Date().toISOString(), new Date().toISOString(),
    );
    this.accountsKept = null;
    this.count({ do_rows_written: rowsWritten });
    if (known) this.reconnected.add(account.id);
    // The watchdog starts the account's census (recover, keepCounting).
    this.watching = true;
    await this.ctx.storage.setAlarm(Date.now());
    return { ok: true };
  }

  /** Accounts added again since the last alarm (a fresh Google token): retried at the next one. */
  private reconnected = new Set<string>();

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
    const user = this.userId();
    const rows = sql
      .exec<{ id: string; email: string; scopes: string; added_at: string; tested_at: string; test_error: string | null; kind: 'gmail' | 'archive'; archive: string | null }>(
        `SELECT id, email, scopes, added_at, tested_at, test_error, kind, archive FROM accounts ORDER BY added_at`,
      )
      .toArray();
    // An archive's import count is its mailbox's: one call each, only while it imports.
    const imported = new Map<string, number>();
    for (const a of rows)
      if (a.kind === 'archive' && user && a.archive && (JSON.parse(a.archive) as ArchiveRecord).status !== 'uploading')
        imported.set(a.id, (await accountMailbox(this.env, user, a.id).syncState())?.copied ?? 0);
    const accounts = rows
      .map((a): ConnectedAccount => {
        if (a.kind === 'archive') {
          const r = JSON.parse(a.archive ?? '{}') as ArchiveRecord;
          const archive: ArchiveImport = { file: r.file, bytes: r.bytes, messages: r.messages, imported: imported.get(a.id) ?? 0, status: r.status, error: r.error };
          return { id: a.id, email: a.email, addedAt: a.added_at, read: true, modify: false, test: { at: a.tested_at, ok: true, detail: null, error: null }, kind: 'archive', archive };
        }
        const scopes = a.scopes.split(' ');
        const modify = scopes.includes(GMAIL_SCOPES.modify);
        const read = modify || scopes.includes(GMAIL_SCOPES.readonly);
        return {
          id: a.id,
          email: a.email,
          kind: 'gmail',
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
    return { user: { email }, admin: false, accounts };
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
const SORT_KEYS: Record<'date' | 'from' | 'size', readonly string[]> = { date: ['ts', 'id'], from: ['lower(from_addr)', 'ts', 'id'], size: ['size', 'id'] };
/** The sort indexes built after the fact (buildSorts), one DO write per message indexed each. */
const SORT_INDEXES: readonly { sort: MessageSort; name: string; create: string }[] = [
  { sort: 'from', name: 'messages_from', create: `CREATE INDEX IF NOT EXISTS messages_from ON messages (lower(from_addr), ts)` },
  { sort: 'size', name: 'messages_size', create: `CREATE INDEX IF NOT EXISTS messages_size ON messages (size)` },
  // Partial: only mail with attachments, so it costs a write for those alone.
  { sort: 'attachments', name: 'messages_attachments', create: `CREATE INDEX IF NOT EXISTS messages_attachments ON messages (attachments, ts) WHERE attachments > 0` },
];
type SortKey = (string | number)[];
/** One stretch of an order: its keyset columns and what narrows it (a where, a row test, a label searched). */
interface SortPhase {
  keys: readonly string[];
  where?: string;
  test?: (m: MessageRow) => boolean;
  label?: string;
}
/**
 * An order as phases read one after another. Date, Sender and Size are one phase off their
 * index. Attachments reads mail with attachments off its partial index, then the rest by date.
 * Category reads each category by date, in name order; a rare one through search.
 */
function sortPhases(by: MessageSort, asc: boolean, labels: { id: string; n: number }[], total: number): SortPhase[] {
  if (by === 'attachments') {
    const some: SortPhase = { keys: ['attachments', 'ts', 'id'], where: 'attachments > 0' };
    const none: SortPhase = { keys: ['ts', 'id'], where: 'attachments = 0' };
    return asc ? [none, some] : [some, none];
  }
  if (by === 'category') {
    const n = (id: string) => labels.find((l) => l.id === id)?.n ?? 0;
    const named = [
      { name: 'Primary', phase: { keys: SORT_KEYS.date, test: (m: MessageRow) => !m.labels.some((l) => CATEGORY_LABEL.test(l)) } as SortPhase },
      ...CATEGORY_IDS.map((id) => ({
        name: categoryName(id),
        phase: (n(id) < total * 0.05 ? { keys: SORT_KEYS.date, label: id } : { keys: SORT_KEYS.date, test: (m: MessageRow) => m.labels.includes(id) }) as SortPhase,
      })),
    ].sort((a, b) => a.name.localeCompare(b.name));
    return (asc ? named : named.reverse()).map((x) => x.phase);
  }
  return [{ keys: SORT_KEYS[by as 'date' | 'from' | 'size'] }];
}
/** A row's values for a phase's keyset columns. */
const keyOf = (keys: readonly string[], m: { ts: number; id: string; fromAddr: string; size: number; attachments: number }): SortKey =>
  keys.map((k) => (k === 'lower(from_addr)' ? m.fromAddr.toLowerCase() : m[k as 'ts' | 'id' | 'size' | 'attachments']));
/** A cursor is [phase, ...keys] (or the keys alone for a one-phase order); a bad one is page one. */
function decodeCursor(c: string, phases: SortPhase[]): [number, ...SortKey] | null {
  if (c.length > 600) return null;
  let v: unknown;
  try {
    v = JSON.parse(c);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const at = (phases.length > 1 ? v : [0, ...v]) as [number, ...SortKey];
  const phase = phases[at[0]];
  if (!phase || !Number.isInteger(at[0])) return null;
  const keys = at.slice(1);
  // A phase's start ([p] alone) is a cursor too: the phase before it was read to its end.
  if (!keys.length) return at;
  const like = keyOf(phase.keys, { ts: 0, id: '', fromAddr: '', size: 0, attachments: 0 });
  return keys.length === like.length && keys.every((x, i) => typeof x === typeof like[i]) ? at : null;
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
        case 'to':
          return has(m.rcpt ?? '');
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

// Every call, alarm included, writes its time and rows to telemetry.
measureObject(MailboxDO);

/**
 * A search box's words as a condition on messages: each word in the envelope's index, the body's or
 * the attachments' (so one word can be in the subject and another in the body). Null when there are no words.
 */
export function textMatch(q: string): { where: string; args: string[] } | null {
  const words = ftsQuery(q).split(' ').filter(Boolean);
  if (!words.length) return null;
  return {
    where: words
      .map(() => `(id IN (${ftsIds('message_fts')}) OR id IN (${ftsIds('body_fts')}) OR id IN (${ftsIds('attach_fts')}))`)
      .join(' AND '),
    args: words.flatMap((w) => [w, w, w]),
  };
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
