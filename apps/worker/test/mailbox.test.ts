import { asUserId, ftsRowid, mailboxName } from '@mailcellar/schema';
import { sampleMessages, SAMPLE_LABELS } from './fixtures/sample';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const one = (sql: SqlStorage, q: string, ...args: (string | number)[]) =>
  Number(Object.values(sql.exec(q, ...args).one())[0]);

describe('mailbox index', () => {
  const mail = sampleMessages(1000);

  it('indexes a batch within the S4 write budget, and a retry writes nothing', async () => {
    const stub = env.MAILBOX.getByName(mailboxName(asUserId('ingest')));
    let rows = 0;
    for (let i = 0; i < mail.length; i += 100) {
      const r = await stub.ingest(mail.slice(i, i + 100));
      expect(r.added).toBe(100);
      rows += r.rowsWritten;
    }
    // S4 measured 6.98 rows a message with rowid rollup tables; WITHOUT ROWID rollups do better.
    console.log(`rows written a message: ${(rows / mail.length).toFixed(2)}`);
    expect(rows / mail.length).toBeLessThan(6.98);

    const again = await stub.ingest(mail.slice(0, 100));
    expect(again).toEqual({ added: 0, skipped: 100, rowsWritten: 0, addedIds: [] });
  });

  it('keeps rollups equal to the messages they count', async () => {
    const stub = env.MAILBOX.getByName(mailboxName(asUserId('rollups')));
    await stub.ingest(mail.slice(0, 500));
    await stub.ingest(mail.slice(250, 1000)); // overlaps: the repeats must not count twice
    await runInDurableObject(stub, (_obj, state) => {
      const sql = state.storage.sql;
      const bytes = one(sql, `SELECT sum(size) FROM messages`);
      expect(one(sql, `SELECT count(*) FROM messages`)).toBe(1000);
      for (const t of ['senders', 'domains', 'months']) {
        expect(one(sql, `SELECT sum(n) FROM ${t}`)).toBe(1000);
        expect(one(sql, `SELECT sum(bytes) FROM ${t}`)).toBe(bytes);
      }
      // Every message is in exactly one of INBOX or SENT, plus one user label.
      expect(one(sql, `SELECT sum(n) FROM labels WHERE id IN ('INBOX', 'SENT')`)).toBe(1000);
      expect(one(sql, `SELECT sum(n) FROM labels WHERE type = 'user'`)).toBe(1000);
    });
  });

  it('finds mail by word, sender and label', async () => {
    const stub = env.MAILBOX.getByName(mailboxName(asUserId('search')));
    await stub.ingest(mail);
    await runInDurableObject(stub, (_obj, state) => {
      const sql = state.storage.sql;
      const match = (q: string) => one(sql, `SELECT count(*) FROM message_fts WHERE message_fts MATCH ?`, q);
      expect(match('invoice')).toBe(one(sql, `SELECT count(*) FROM messages WHERE subject LIKE '%invoice%'`));
      expect(match('from_addr:"shop.example"')).toBe(one(sql, `SELECT n FROM domains WHERE domain = 'shop.example'`));
      expect(match('labels:"Label_2"')).toBe(one(sql, `SELECT n FROM labels WHERE id = 'Label_2'`));
      // Contentless FTS returns rowids; they lead back to the message.
      const rowid = String(sql.exec(`SELECT rowid FROM message_fts WHERE message_fts MATCH 'invoice' LIMIT 1`).one().rowid);
      const hit = mail.find((m) => ftsRowid(m.id) === rowid);
      expect(hit?.subject).toMatch(/invoice/i);
    });
  });

  it('names labels without losing their counts', async () => {
    const stub = env.MAILBOX.getByName(mailboxName(asUserId('labels')));
    await stub.ingest(mail.slice(0, 200));
    await stub.putLabels(SAMPLE_LABELS);
    await runInDurableObject(stub, (_obj, state) => {
      const row = state.storage.sql.exec(`SELECT name, type, n FROM labels WHERE id = 'Label_2'`).one();
      expect(row.name).toBe('Receipts');
      expect(row.type).toBe('user');
      expect(Number(row.n)).toBeGreaterThan(0);
    });
  });
});

describe('ftsRowid', () => {
  it('maps every 64-bit Gmail ID to a distinct signed integer', () => {
    expect(ftsRowid('0')).toBe('0');
    expect(ftsRowid('7fffffffffffffff')).toBe('9223372036854775807');
    expect(ftsRowid('ffffffffffffffff')).toBe('-1');
    expect(ftsRowid('18f3a2b4c5d6e7f8')).toBe(BigInt('0x18f3a2b4c5d6e7f8').toString());
    expect(() => ftsRowid('not-hex')).toThrow();
  });
});
