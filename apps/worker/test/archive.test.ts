import { asUserId, mailboxName, type LabelRow, type MessageRow, type MonthRow, type SenderRow } from '@mailcellar/schema';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const get = async <T>(path: string) => {
  const res = await exports.default.fetch(`https://mailcellar.icaruslab.dev${path}`);
  expect(res.status).toBe(200);
  return (await res.json()) as T[];
};

describe('archive API (phase 1 sample mailbox)', () => {
  it('serves rollups that add up to the sample', async () => {
    const months = await get<MonthRow>('/api/archive/months');
    expect(months.reduce((a, m) => a + m.n, 0)).toBe(2400);
    expect(months.map((m) => m.month)).toEqual([...months.map((m) => m.month)].sort());
    const labels = await get<LabelRow>('/api/archive/labels');
    expect(labels.find((l) => l.id === 'Label_2')?.name).toBe('Receipts');
    const senders = await get<SenderRow>('/api/archive/senders');
    expect(senders[0].n).toBeGreaterThanOrEqual(senders.at(-1)!.n);
  });

  it('lists the newest messages first, a page at most', async () => {
    const msgs = await get<MessageRow>('/api/archive/messages');
    expect(msgs).toHaveLength(1000);
    expect(msgs[0].ts).toBeGreaterThanOrEqual(msgs[999].ts);
    expect(Array.isArray(msgs[0].labels)).toBe(true);
  });

  it('searches every word, and treats search syntax as text', async () => {
    const hits = await get<MessageRow>('/api/archive/messages?q=invoice');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((m) => /invoice/i.test(m.subject + m.snippet))).toBe(true);
    const both = await get<MessageRow>('/api/archive/messages?q=invoice%20shop');
    expect(both).toHaveLength(0); // invoices come from billing@, not shop.example
    for (const q of ['"', 'a OR (', 'NEAR(x', '*', 'from_addr:']) await get<MessageRow>(`/api/archive/messages?q=${encodeURIComponent(q)}`);
  });

  it('finds a message whose Gmail ID has the top bit set', async () => {
    const stub = env.MAILBOX.getByName(mailboxName(asUserId('highbit')));
    const m: MessageRow = {
      id: 'f00000000000000a', threadId: 't', ts: 1, fromAddr: 'x@y.example', fromName: 'X',
      subject: 'zebracorn', snippet: '', size: 1, attachments: 0, labels: ['INBOX'],
    };
    await stub.ingest([m]);
    const found = (await stub.archive('messages', 'zebracorn')) as MessageRow[];
    expect(found.map((r) => r.id)).toEqual(['f00000000000000a']);
  });

  it('404s an unknown page', async () => {
    const res = await exports.default.fetch('https://mailcellar.icaruslab.dev/api/archive/secrets');
    expect(res.status).toBe(404);
  });
});
