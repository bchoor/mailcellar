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
} from '@mailcellar/schema';
import type { Env } from './env';

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
];

const today = () => new Date().toISOString().slice(0, 10);

/** What one ingest call wrote: rows written is what the Free plan's 100k a day counts. */
export interface IngestResult {
  added: number;
  skipped: number;
  rowsWritten: number;
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
      let added = 0;
      for (const m of batch) {
        const labelText = m.labels.join(' ');
        const insert = sql.exec(
          `INSERT INTO messages (id, thread_id, ts, from_addr, from_name, subject, snippet, size, attachments, labels)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          m.id, m.threadId, m.ts, m.fromAddr, m.fromName, m.subject, m.snippet, m.size, m.attachments, labelText,
        );
        rowsWritten += insert.rowsWritten;
        if (insert.rowsWritten === 0) continue;
        added++;
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
      if (added) this.count({ messages_indexed: added, do_rows_written: rowsWritten });
      return { added, skipped: batch.length - added, rowsWritten };
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

  /** The schedules with the person's changes applied. Nothing runs them until phase 2's sync. */
  async schedules(): Promise<Schedule[]> {
    const hasAccount = this.ctx.storage.sql.exec(`SELECT 1 FROM accounts LIMIT 1`).toArray().length > 0;
    const saved = new Map(
      this.ctx.storage.sql
        .exec<{ id: string; change: string }>(`SELECT id, change FROM schedules`)
        .toArray()
        .map((r) => [r.id, JSON.parse(r.change)]),
    );
    return DEFAULT_SCHEDULES.map((s) => ({
      ...s,
      ...saved.get(s.id),
      waiting: s.id !== 'gmail-sync' ? null : hasAccount ? 'Not built yet: syncing starts when the backfill ships' : 'Add a Gmail account in Settings ▸ Accounts first',
    }));
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
    return { ok: true, schedule: (await this.schedules()).find((s) => s.id === id)! };
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
    if (row) this.count({ do_rows_written: 1 });
    return row?.refresh_token ?? null;
  }

  /** The Access user (passed in by the Worker) and the accounts the archive keeps. Never includes tokens. */
  async me(email: string): Promise<Me> {
    const sql = this.ctx.storage.sql;
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
            ok: !a.test_error && read && modify,
            detail: a.test_error ? null : `Read ${read ? '✓' : '✗'} · Modify ${modify ? '✓' : '✗'}`,
            error: a.test_error ?? (!modify ? 'No Modify access, so MailCellar can’t remove archived mail from Gmail. Add the account again and allow it.' : null),
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
