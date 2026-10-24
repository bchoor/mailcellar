import { checkScheduleChange, DEFAULT_SCHEDULES, type Schedule, type UsageDay } from '@mailcellar/schema';
import { describe, expect, it } from 'vitest';
import { signIn } from './helpers';

const owner = signIn('ops-owner@example.com', { sample: true });
const api = async (path: string, init?: RequestInit) => (await owner).api(path, init);
const put = (id: string, body: unknown) =>
  api(`/api/schedules/${id}`, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('schedules', () => {
  it('starts from the defaults, with sync waiting on a Gmail account', async () => {
    const list = (await (await api('/api/schedules')).json()) as Schedule[];
    expect(list.map((s) => s.id)).toEqual(['gmail-sync', 'compaction']);
    expect(list[0].waiting).toMatch(/Gmail/);
  });

  it('saves a change and keeps earlier ones', async () => {
    expect((await put('gmail-sync', { every: 180 })).status).toBe(200);
    const res = await put('gmail-sync', { on: false, tz: 'America/Los_Angeles' });
    const s = (await res.json()) as Schedule;
    expect([s.every, s.on, s.tz]).toEqual([180, false, 'America/Los_Angeles']);
    const list = (await (await api('/api/schedules')).json()) as Schedule[];
    expect(list[0].every).toBe(180);
  });

  it('refuses what a schedule cannot take', async () => {
    for (const [id, body] of [
      ['gmail-sync', { every: 5 }],
      ['gmail-sync', { from: '25:00' }],
      ['gmail-sync', { days: [] }],
      ['gmail-sync', { tz: 'Mars/Olympus' }],
      ['gmail-sync', { name: 'renamed' }],
      ['compaction', { every: 60 }],
      ['gmail-sync', 'not json'],
      ['nope', { on: true }],
    ] as const) {
      const res = await put(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('checks changes the same way outside the DO', () => {
    expect(checkScheduleChange(DEFAULT_SCHEDULES[0], { days: [3, 1, 1] })).toEqual({ days: [1, 3] });
    expect(() => checkScheduleChange(DEFAULT_SCHEDULES[0], null)).toThrow();
  });
});

describe('usage', () => {
  it("counts the mailbox's own rows written, read and messages indexed", async () => {
    await api('/api/archive/senders'); // seeds the sample and reads a rollup
    const usage = (await (await api('/api/usage')).json()) as UsageDay[];
    const today = new Date().toISOString().slice(0, 10);
    const v = (m: string) => usage.find((u) => u.day === today && u.metric === m)?.value ?? 0;
    expect(v('messages_indexed')).toBe(2400);
    expect(v('do_rows_written')).toBeGreaterThan(2400);
    expect(v('do_rows_read')).toBeGreaterThan(0);
  });

  it('counts its own writes, so the meter matches what Free counts', async () => {
    const written = async () => {
      const usage = (await (await api('/api/usage')).json()) as UsageDay[];
      return usage.filter((u) => u.metric === 'do_rows_written').reduce((a, u) => a + u.value, 0);
    };
    await api('/api/archive/months');
    const before = await written();
    await put('compaction', { from: '04:00' }); // 1 schedule row + 1 meter row
    expect((await written()) - before).toBe(2);
    const mid = await written();
    await api('/api/archive/labels'); // 1 rows-read row + 1 rows-written row
    expect((await written()) - mid).toBe(2);
  });
});
