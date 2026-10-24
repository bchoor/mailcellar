// Sample backfill figures for the prototype, until phase 2's sync reports real ones. Illustrative only.
export interface Run {
  id: string;
  date: string;
  started: string;
  minutes: number;
  messages: number;
  steps: number;
  rows_written: number;
  cpu_ms: number;
  errors: number;
  status: string;
}

export const BACKFILL = {
  total: 200_000,
  stages: [
    { key: 'listed', label: 'Listed in Gmail', done: 200_000 },
    { key: 'fetched', label: 'Fetched', done: 118_402 },
    { key: 'r2', label: 'Saved to R2', done: 118_402 },
    { key: 'indexed', label: 'Indexed for search', done: 118_120 },
    { key: 'basin', label: 'Committed to archive tables', done: 112_000 },
    { key: 'embedded', label: 'Embedded (subset, cap 13,000)', done: 9_840, of: 13_000 },
  ],
  perDay: 33_000,
  bottleneck: 'Durable Object rows written: 100,000 a day on the free tier',
};

const seeded = (n: number) => {
  const x = Math.sin(n * 7919 + 104729) * 233280;
  return x - Math.floor(x);
};

const DAYS = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
export const RUNS: Run[] = DAYS.flatMap((date, d) =>
  [0, 1, 2, 3].map((k) => {
    const i = d * 4 + k;
    const today = date === '2026-10-23';
    const messages = today && k > 1 ? 0 : Math.round(7_400 + seeded(i) * 1_800);
    return {
      id: `run_${String(i + 1).padStart(3, '0')}`,
      date,
      started: `${date} ${String(k * 6).padStart(2, '0')}:00`,
      minutes: messages ? Math.round(70 + seeded(i + 9) * 60) : 0,
      messages,
      steps: Math.round(messages / 20),
      rows_written: messages * 3,
      cpu_ms: Math.round((4.8 + seeded(i + 3) * 2.4) * 10) / 10,
      errors: seeded(i + 5) < 0.2 ? 1 : 0,
      status: today && k > 1 ? 'Scheduled' : today && k === 1 ? 'Running' : 'Done',
    };
  }),
).reverse();
