import { LumenLayout, NoteLine, Tile, TileRow, type ViewDomain, useLumenLoad } from '@columenlabs/lumen-ui';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { Progress } from '@columenlabs/lumen-ui/ui/progress';
import { type CustomViewConfig, customViewConfigSchema } from '@columenlabs/lumen-ui-types/views';
import { useQuery } from '@tanstack/react-query';
import {
  ActivityIcon,
  AlertTriangleIcon,
  CalendarIcon,
  CloudIcon,
  CpuIcon,
  GaugeIcon,
  HashIcon,
  HourglassIcon,
  MailIcon,
  PercentIcon,
  RowsIcon,
  TimerIcon,
} from 'lucide-react';
import { useState } from 'react';
import { FREE_DAILY, type UsageDay } from '@mailcellar/schema';
import { BACKFILL, RUNS, type Run } from './ops';

const fmt = (n: number) => n.toLocaleString('en-US');
const done = BACKFILL.stages.find((s) => s.key === 'fetched')?.done ?? 0;
const pct = Math.round((done / BACKFILL.total) * 100);
const daysLeft = Math.ceil((BACKFILL.total - done) / BACKFILL.perDay);

/** The status bar item every page shows while the backfill runs. */
export function BackfillStatus() {
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Backfill {pct}%</span>
      <Progress value={pct} className="h-1.5 w-20" />
      <span>about {daysLeft} days left</span>
    </span>
  );
}

const RUN_DOMAIN: ViewDomain<Run> = {
  id: 'sync_runs',
  rowKey: (r) => r.id,
  text: (r) => [r.id, r.status],
  fields: [
    { key: 'started', label: 'Started', icon: CalendarIcon, value: (r) => r.started, format: 'text' },
    { key: 'date', label: 'Date', icon: CalendarIcon, value: (r) => r.date, format: 'text', groupable: true },
    { key: 'status', label: 'Status', icon: ActivityIcon, value: (r) => r.status, format: 'text', filterable: true, groupable: true },
    { key: 'messages', label: 'Messages', icon: MailIcon, value: (r) => r.messages, format: 'integer', aggregate: 'sum' },
    { key: 'steps', label: 'Workflow steps', icon: HashIcon, value: (r) => r.steps, format: 'integer', aggregate: 'sum' },
    { key: 'rows_written', label: 'Rows written', icon: RowsIcon, value: (r) => r.rows_written, format: 'integer', aggregate: 'sum' },
    { key: 'minutes', label: 'Minutes', icon: TimerIcon, value: (r) => r.minutes, format: 'integer', aggregate: 'sum' },
    { key: 'cpu_ms', label: 'CPU per step (ms)', icon: CpuIcon, value: (r) => r.cpu_ms, format: 'number', aggregate: 'mean' },
    { key: 'errors', label: 'Errors', icon: AlertTriangleIcon, value: (r) => r.errors, format: 'integer', aggregate: 'sum' },
  ],
} as ViewDomain<Run>;

const RUN_VIEW: CustomViewConfig = {
  name: 'Sync runs',
  ...customViewConfigSchema.parse({
    columns: ['started', 'status', 'messages', 'steps', 'rows_written', 'minutes', 'cpu_ms', 'errors'],
    sort: { key: 'started', desc: true },
    cards: [
      { id: 'per_day', title: 'Messages synced per day', kind: 'chart', style: 'bars', date: 'date', values: ['messages'], bucket: 'day', agg: 'sum', w: 6 },
      { id: 'table', kind: 'table', style: 'table', w: 6 },
    ],
  }),
};

function BackfillCard() {
  return (
    <div className="flex flex-col gap-4">
      <TileRow>
        <Tile label="Messages archived" value={fmt(done)} caption={`of ${fmt(BACKFILL.total)} in Gmail`} />
        <Tile label="Progress" value={`${pct}%`} />
        <Tile label="Pace" value={`${fmt(BACKFILL.perDay)}/day`} caption="limited by the free tier" />
        <Tile label="Time left" value={`~${daysLeft} days`} caption="at today's pace" />
      </TileRow>
      <div className="grid gap-3">
        {BACKFILL.stages.map((s) => {
          const of = s.of ?? BACKFILL.total;
          const p = Math.round((s.done / of) * 100);
          return (
            <div key={s.key} className="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3 text-sm">
              <span className="truncate">{s.label}</span>
              <Progress value={p} className="h-2" />
              <span className="tabular-nums text-muted-foreground">
                {fmt(s.done)} · {p}%
              </span>
            </div>
          );
        })}
      </div>
      <NoteLine icon={GaugeIcon} title="Bottleneck" note={BACKFILL.bottleneck} />
    </div>
  );
}

export function BackfillPage() {
  const query = useQuery({ queryKey: ['runs'], queryFn: async () => RUNS });
  const load = useLumenLoad(query);
  const [config, setConfig] = useState(RUN_VIEW);
  return (
    <LumenLayout
      crumbs={[{ label: 'Backfill' }]}
      meta={<Badge variant="secondary">Running</Badge>}
      lead={[{ id: 'progress', title: 'Backfill progress', icon: HourglassIcon, kind: 'widget', link: false, children: <BackfillCard /> }]}
      domain={RUN_DOMAIN}
      config={config}
      rows={query.data ?? []}
      load={load}
      onConfigChange={setConfig}
      rowTitle={(r) => r.id}
    />
  );
}

// Usage the mailbox measures itself (/api/usage). Account-wide figures for the other
// services need Cloudflare's GraphQL Analytics API, which waits on an API token.
interface UsageRow {
  id: string;
  day: string;
  metric: string;
  used: number;
  allowance: number;
  pct: number;
}

const METRICS: Record<keyof typeof FREE_DAILY, string> = {
  do_rows_written: 'Durable Object rows written',
  do_rows_read: 'Durable Object rows read',
};

function usageRows(days: UsageDay[]): UsageRow[] {
  return days
    .filter((d): d is UsageDay & { metric: keyof typeof FREE_DAILY } => d.metric in FREE_DAILY)
    .map((d) => {
      const allowance = FREE_DAILY[d.metric];
      return {
        id: `${d.day}:${d.metric}`,
        day: d.day,
        metric: METRICS[d.metric],
        used: d.value,
        allowance,
        pct: Math.round((d.value / allowance) * 1000) / 10,
      };
    });
}

const USAGE_DOMAIN: ViewDomain<UsageRow> = {
  id: 'mailbox_usage',
  rowKey: (r) => r.id,
  text: (r) => [r.metric],
  fields: [
    { key: 'day', label: 'Day', icon: CalendarIcon, value: (r) => r.day, format: 'text', groupable: true },
    { key: 'metric', label: 'Metric', icon: ActivityIcon, value: (r) => r.metric, format: 'text', filterable: true, groupable: true },
    { key: 'used', label: 'Used', icon: HashIcon, value: (r) => r.used, format: 'compact', aggregate: 'sum' },
    { key: 'allowance', label: 'Free a day', icon: HashIcon, value: (r) => r.allowance, format: 'compact' },
    { key: 'pct', label: '% of free', icon: PercentIcon, value: (r) => r.pct, format: 'number', aggregate: 'max', filterable: true },
  ],
} as ViewDomain<UsageRow>;

const USAGE_VIEW: CustomViewConfig = {
  name: 'Cloudflare usage',
  ...customViewConfigSchema.parse({
    columns: ['day', 'metric', 'used', 'allowance', 'pct'],
    sort: { key: 'day', desc: true },
  }),
};

function LimitsCard({ days }: { days: UsageDay[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = usageRows(days).filter((r) => r.day === today);
  const indexed = days.find((d) => d.day === today && d.metric === 'messages_indexed')?.value ?? 0;
  const written = rows.find((r) => r.id.endsWith('do_rows_written'));
  const left = written ? Math.max(0, written.allowance - written.used) : FREE_DAILY.do_rows_written;
  return (
    <div className="flex flex-col gap-4">
      <TileRow>
        <Tile label="Messages indexed today" value={fmt(indexed)} />
        <Tile label="Rows written left today" value={fmt(left)} caption="the backfill's limit on Free" />
        <Tile label="Bill this month" value="$0.00" caption="Workers Free plan" />
      </TileRow>
      <div className="grid gap-3">
        {(Object.keys(FREE_DAILY) as (keyof typeof FREE_DAILY)[]).map((m) => {
          const r = rows.find((x) => x.id.endsWith(m));
          const pct = r?.pct ?? 0;
          return (
            <div key={m} className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3 text-sm">
              <span className="truncate">{METRICS[m]}</span>
              <Progress
                value={Math.min(pct, 100)}
                className={pct > 100 ? 'h-2 [&>div]:bg-loss' : pct > 75 ? 'h-2 [&>div]:bg-amber-500' : 'h-2'}
              />
              <span className="tabular-nums text-muted-foreground">
                {fmt(r?.used ?? 0)} / {fmt(FREE_DAILY[m])} · {pct}%
              </span>
            </div>
          );
        })}
      </div>
      <NoteLine
        icon={CloudIcon}
        title="Measured by your mailbox"
        note="Workers, R2, Basin and the rest join this page once Cloudflare's Analytics API is connected."
      />
    </div>
  );
}

export function UsagePage() {
  const query = useQuery({
    queryKey: ['usage'],
    queryFn: async (): Promise<UsageDay[]> => {
      const res = await fetch('/api/usage');
      if (!res.ok) throw new Error(`Couldn't load usage (${res.status})`);
      return res.json();
    },
  });
  const load = useLumenLoad(query);
  const [config, setConfig] = useState(USAGE_VIEW);
  return (
    <LumenLayout
      crumbs={[{ label: 'Cloudflare usage' }]}
      meta={<span className="text-xs text-muted-foreground">Today and the last 30 days, UTC</span>}
      lead={[{ id: 'limits', title: 'Against the free tier', icon: GaugeIcon, kind: 'widget', link: false, children: <LimitsCard days={query.data ?? []} /> }]}
      domain={USAGE_DOMAIN}
      config={config}
      rows={usageRows(query.data ?? [])}
      load={load}
      onConfigChange={setConfig}
      rowTitle={(r) => `${r.day} · ${r.metric}`}
    />
  );
}
