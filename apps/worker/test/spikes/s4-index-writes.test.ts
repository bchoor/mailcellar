// Spike S4: rows written and bytes per message for candidate search-index designs.
// Free DOs allow 100k rows written a day, so rows/message sets how long a backfill takes.
// Run: bun run --filter=@mailcellar/worker spike:s4   (results go to stdout)
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const MESSAGES = 1000;
const BATCH = 100; // messages per sync step
const MAILBOX_SIZE = 200_000; // the plan's sizing target
const FREE_ROWS_PER_DAY = 100_000;

// Synthetic, deterministic mail: no real content anywhere in this spike.
// A 20k-word vocabulary drawn on a Zipf curve, like real text, so the index has a
// realistic number of distinct terms. 'invoice' is word 0, the most common.
function rng(seed: number) { // mulberry32
  return () => {
    let t = (seed = (seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const VOCAB = (() => {
  const r = rng(7);
  const syl = 'ka lo mi su re ta ne vo pi da fu ge ho ji be ru zo ma ni te'.split(' ');
  const words = new Set<string>(['invoice']);
  while (words.size < 20_000) {
    const n = 2 + Math.floor(r() * 3);
    words.add(Array.from({ length: n }, () => syl[Math.floor(r() * syl.length)]).join(''));
  }
  return [...words];
})();
function message(i: number, r: () => number) {
  const pick = () => VOCAB[Math.min(VOCAB.length - 1, Math.floor(1 / Math.max(r(), 1 / VOCAB.length)) - 1)];
  const words = (n: number) => Array.from({ length: n }, pick).join(' ');
  const domain = `d${Math.floor(r() * 300)}.example`;
  const body = words(300 + Math.floor(r() * 500)); // ~2-5 KB of text
  return {
    id: `m${i.toString(16).padStart(12, '0')}`,
    thread: `t${Math.floor(i / 3)}`,
    ts: Date.UTC(2015, 0, 1) + Math.floor(r() * 10 * 365) * 86_400_000,
    from: `sender${Math.floor(r() * 2000)}@${domain}`,
    domain,
    to: `me@example.com, cc${Math.floor(r() * 50)}@example.com`,
    subject: words(4 + Math.floor(r() * 8)),
    snippet: body.slice(0, 200),
    body,
    size: body.length + 2000,
    labels: ['INBOX', r() < 0.3 ? 'CATEGORY_UPDATES' : 'CATEGORY_PERSONAL'],
  };
}
type Msg = ReturnType<typeof message>;

const BASE = [
  `CREATE TABLE messages (id TEXT PRIMARY KEY, thread TEXT NOT NULL, ts INTEGER NOT NULL,
     from_addr TEXT NOT NULL, subject TEXT NOT NULL, snippet TEXT NOT NULL, size INTEGER NOT NULL,
     labels TEXT NOT NULL) STRICT`,
  `CREATE INDEX messages_ts ON messages(ts)`,
  `CREATE TABLE senders (addr TEXT PRIMARY KEY, n INTEGER NOT NULL, bytes INTEGER NOT NULL, last_ts INTEGER NOT NULL) STRICT`,
  `CREATE TABLE domains (domain TEXT PRIMARY KEY, n INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT`,
  `CREATE TABLE months (month TEXT PRIMARY KEY, n INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT`,
  `CREATE TABLE labels (label TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT`,
];

interface Design {
  name: string;
  fts: string;
  ftsInsert: string;
  ftsArgs: (m: Msg) => unknown[];
  rollups: 'per-message' | 'per-batch';
  withoutRowid?: boolean;
}
const full = {
  fts: `CREATE VIRTUAL TABLE fts USING fts5(subject, from_addr, to_addr, body, tokenize='unicode61 remove_diacritics 1')`,
  ftsInsert: `INSERT INTO fts(rowid, subject, from_addr, to_addr, body) VALUES (?, ?, ?, ?, ?)`,
  ftsArgs: (m: Msg) => [rowid(m), m.subject, m.from, m.to, m.body],
};
const slim = {
  fts: `CREATE VIRTUAL TABLE fts USING fts5(subject, from_addr, snippet, tokenize='unicode61 remove_diacritics 1')`,
  ftsInsert: `INSERT INTO fts(rowid, subject, from_addr, snippet) VALUES (?, ?, ?, ?)`,
  ftsArgs: (m: Msg) => [rowid(m), m.subject, m.from, m.snippet],
};
const contentless = {
  fts: `CREATE VIRTUAL TABLE fts USING fts5(subject, from_addr, snippet, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 1')`,
  ftsInsert: slim.ftsInsert,
  ftsArgs: slim.ftsArgs,
};
const DESIGNS: Design[] = [
  { name: 'full body FTS, rollups per message', ...full, rollups: 'per-message' },
  { name: 'full body FTS, rollups per batch', ...full, rollups: 'per-batch' },
  { name: 'subject+from+snippet FTS, rollups per batch', ...slim, rollups: 'per-batch' },
  { name: 'contentless subject+from+snippet, rollups per batch', ...contentless, rollups: 'per-batch' },
  { name: 'same, messages WITHOUT ROWID', ...contentless, rollups: 'per-batch', withoutRowid: true },
];
function rowid(m: Msg) {
  return parseInt(m.id.slice(1), 16) + 1;
}
const month = (ts: number) => new Date(ts).toISOString().slice(0, 7);

function setup(sql: SqlStorage, d: Design) {
  const base = d.withoutRowid ? BASE.map((q) => q.replace(/(labels TEXT NOT NULL\)) STRICT/, '$1 STRICT, WITHOUT ROWID')) : BASE;
  for (const q of [...base, d.fts]) sql.exec(q);
}

function loadBatch(sql: SqlStorage, d: Design, batch: Msg[], by: Record<string, number>) {
  const run = (q: string, ...args: unknown[]) => {
    const k = q.match(/INTO (\w+)/)![1];
    by[k] = (by[k] ?? 0) + sql.exec(q, ...args).rowsWritten;
  };
  for (const m of batch) {
    run(`INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, m.id, m.thread, m.ts, m.from, m.subject, m.snippet, m.size, m.labels.join(','));
    run(d.ftsInsert, ...d.ftsArgs(m));
  }
  const groups = d.rollups === 'per-message' ? batch.map((m) => [m]) : [batch];
  for (const g of groups) {
    const tally = <K>(key: (m: Msg) => K[]) => {
      const t = new Map<K, { n: number; bytes: number; ts: number }>();
      for (const m of g) for (const k of key(m)) {
        const v = t.get(k) ?? { n: 0, bytes: 0, ts: 0 };
        t.set(k, { n: v.n + 1, bytes: v.bytes + m.size, ts: Math.max(v.ts, m.ts) });
      }
      return t;
    };
    for (const [k, v] of tally((m) => [m.from]))
      run(`INSERT INTO senders VALUES (?, ?, ?, ?) ON CONFLICT(addr) DO UPDATE SET n = n + excluded.n, bytes = bytes + excluded.bytes, last_ts = max(last_ts, excluded.last_ts)`, k, v.n, v.bytes, v.ts);
    for (const [k, v] of tally((m) => [m.domain]))
      run(`INSERT INTO domains VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET n = n + excluded.n, bytes = bytes + excluded.bytes`, k, v.n, v.bytes);
    for (const [k, v] of tally((m) => [month(m.ts)]))
      run(`INSERT INTO months VALUES (?, ?, ?) ON CONFLICT(month) DO UPDATE SET n = n + excluded.n, bytes = bytes + excluded.bytes`, k, v.n, v.bytes);
    for (const [k, v] of tally((m) => m.labels))
      run(`INSERT INTO labels VALUES (?, ?) ON CONFLICT(label) DO UPDATE SET n = n + excluded.n`, k, v.n);
  }
}

// FTS5 keeps its index in shadow tables, written at commit by its own statements.
function shadowRows(sql: SqlStorage) {
  const out: Record<string, number> = {};
  for (const { name } of sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fts_%'`))
    out[name] = Number(sql.exec(`SELECT count(*) AS n FROM "${name}"`).one().n);
  return out;
}

describe('S4: index writes per message', () => {
  const results: Record<string, unknown>[] = [];

  for (const [i, d] of DESIGNS.entries()) {
    it(d.name, async () => {
      const r = rng(42);
      const msgs = Array.from({ length: MESSAGES }, (_, n) => message(n, r));
      const stub = env.MAILBOX.getByName(`spike-s4-${i}`);
      const by: Record<string, number> = {};
      const before = await runInDurableObject(stub, (_obj, state) => {
        setup(state.storage.sql, d);
        return state.storage.sql.databaseSize;
      });
      // One call per batch, like one sync step, so each batch commits and FTS5 flushes.
      for (let b = 0; b < msgs.length; b += BATCH) {
        const batch = msgs.slice(b, b + BATCH);
        await runInDurableObject(stub, (_obj, state) => loadBatch(state.storage.sql, d, batch, by));
      }
      await runInDurableObject(stub, async (_obj, state) => {
        const shadow = shadowRows(state.storage.sql);
        const written = Object.values(by).reduce((a, b) => a + b, 0);
        const bytes = state.storage.sql.databaseSize - before;
        // A search must still find a word only the body or snippet holds.
        const hit = state.storage.sql.exec(`SELECT count(*) AS n FROM fts WHERE fts MATCH 'invoice'`).one();
        expect(Number(hit.n)).toBeGreaterThan(0);
        const rowsPerMsg = written / MESSAGES;
        results.push({
          design: d.name,
          rowsPerMsg: +rowsPerMsg.toFixed(2),
          bytesPerMsg: Math.round(bytes / MESSAGES),
          backfillDays: +((rowsPerMsg * MAILBOX_SIZE) / FREE_ROWS_PER_DAY).toFixed(1),
          by: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, +(v / MESSAGES).toFixed(2)])),
          shadowRows: shadow,
        });
      });
    });
  }

  it('report', () => {
    console.log(`\nS4 (${MESSAGES} synthetic messages, batches of ${BATCH}; days = ${MAILBOX_SIZE} mails at ${FREE_ROWS_PER_DAY} rows/day)`);
    for (const r of results) console.log(JSON.stringify(r));
    expect(results).toHaveLength(DESIGNS.length);
  });
});
