// Sample backfill and Cloudflare usage figures for the prototype. Illustrative only.
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

export interface Usage {
  id: string;
  service: string;
  metric: string;
  period: string;
  used: number;
  allowance: number;
  unit: string;
  pct: number;
  cost: number;
}

const u = (
  service: string,
  metric: string,
  period: string,
  used: number,
  allowance: number,
  unit: string,
  cost = 0,
): Usage => ({
  id: `${service}:${metric}`,
  service,
  metric,
  period,
  used,
  allowance,
  unit,
  pct: Math.round((used / allowance) * 1000) / 10,
  cost,
});

export const USAGE: Usage[] = [
  u('Workers', 'Requests', 'Today', 3_410, 100_000, 'requests'),
  u('Workflows', 'Steps', 'Today', 1_870, 3_000, 'steps'),
  u('Workflows', 'CPU per step (avg)', 'Per step', 6.1, 10, 'ms'),
  u('Durable Objects', 'Rows written', 'Today', 61_240, 100_000, 'rows'),
  u('Durable Objects', 'Rows read', 'Today', 820_000, 5_000_000, 'rows'),
  u('Durable Objects', 'Requests', 'Today', 4_020, 100_000, 'requests'),
  u('Durable Objects', 'Stored data', 'Now', 0.41, 5, 'GB'),
  u('R2', 'Storage', 'This month', 14.2, 10, 'GB-month', 0.06),
  u('R2', 'Class A operations', 'This month', 236_000, 1_000_000, 'ops'),
  u('R2', 'Class B operations', 'This month', 41_000, 10_000_000, 'ops'),
  u('Basin', 'Catalog operations', 'This month', 3_900, 1_000_000, 'ops'),
  u('Basin', 'SQL data scanned', 'This month', 0.3, 10, 'GB'),
  u('Workers AI', 'Neurons', 'Today', 7_350, 10_000, 'neurons'),
  u('Vectorize', 'Stored dimensions', 'Now', 3_780_000, 5_000_000, 'dims'),
  u('Vectorize', 'Queried dimensions', 'This month', 1_100_000, 30_000_000, 'dims'),
  u('Analytics Engine', 'Data points written', 'Today', 1_240, 100_000, 'points'),
];
