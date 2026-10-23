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
  DollarSignIcon,
  GaugeIcon,
  HashIcon,
  HourglassIcon,
  MailIcon,
  PercentIcon,
  RowsIcon,
  TimerIcon,
} from 'lucide-react';
import { useState } from 'react';
import { BACKFILL, RUNS, type Run, USAGE, type Usage } from './ops';

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

const USAGE_DOMAIN: ViewDomain<Usage> = {
  id: 'cloudflare_usage',
  rowKey: (r) => r.id,
  text: (r) => [r.service, r.metric],
  fields: [
    { key: 'service', label: 'Service', icon: CloudIcon, value: (r) => r.service, format: 'text', filterable: true, groupable: true },
    { key: 'metric', label: 'Metric', icon: ActivityIcon, value: (r) => r.metric, format: 'text' },
    { key: 'period', label: 'Period', icon: CalendarIcon, value: (r) => r.period, format: 'text', filterable: true, groupable: true },
    { key: 'used', label: 'Used', icon: HashIcon, value: (r) => r.used, format: 'compact' },
    { key: 'allowance', label: 'Free allowance', icon: HashIcon, value: (r) => r.allowance, format: 'compact' },
    { key: 'unit', label: 'Unit', icon: RowsIcon, value: (r) => r.unit, format: 'text' },
    { key: 'pct', label: '% of free', icon: PercentIcon, value: (r) => r.pct, format: 'number', aggregate: 'max', filterable: true },
    { key: 'cost', label: 'Cost this month', icon: DollarSignIcon, value: (r) => r.cost, format: 'price', aggregate: 'sum' },
  ],
} as ViewDomain<Usage>;

const USAGE_VIEW: CustomViewConfig = {
  name: 'Cloudflare usage',
  ...customViewConfigSchema.parse({
    columns: ['service', 'metric', 'period', 'used', 'allowance', 'unit', 'pct', 'cost'],
    sort: { key: 'pct', desc: true },
  }),
};

function LimitsCard() {
  const top = [...USAGE].sort((a, b) => b.pct - a.pct).slice(0, 6);
  const bill = USAGE.reduce((s, r) => s + r.cost, 0);
  const over = USAGE.filter((r) => r.pct > 100);
  return (
    <div className="flex flex-col gap-4">
      <TileRow>
        <Tile label="Bill this month" value={`$${bill.toFixed(2)}`} caption="projected, Workers Free plan" />
        <Tile label="Over the free tier" value={String(over.length)} caption={over.map((r) => `${r.service} ${r.metric.toLowerCase()}`).join(', ') || 'none'} />
        <Tile label="Closest daily limit" value={`${top.find((r) => r.period === 'Today')?.pct ?? 0}%`} caption={top.find((r) => r.period === 'Today')?.metric} />
      </TileRow>
      <div className="grid gap-3">
        {top.map((r) => (
          <div key={r.id} className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3 text-sm">
            <span className="truncate">
              {r.service} · {r.metric}
            </span>
            <Progress
              value={Math.min(r.pct, 100)}
              className={r.pct > 100 ? 'h-2 [&>div]:bg-loss' : r.pct > 75 ? 'h-2 [&>div]:bg-amber-500' : 'h-2'}
            />
            <span className="tabular-nums text-muted-foreground">
              {fmt(r.used)} / {fmt(r.allowance)} {r.unit} · {r.pct}%
            </span>
          </div>
        ))}
      </div>
      <NoteLine
        icon={AlertTriangleIcon}
        title="R2 storage is past the free 10 GB"
        note="Billed at $0.015 per GB-month. Skipping the raw-message copy would bring it under."
      />
    </div>
  );
}

export function UsagePage() {
  const query = useQuery({ queryKey: ['usage'], queryFn: async () => USAGE });
  const load = useLumenLoad(query);
  const [config, setConfig] = useState(USAGE_VIEW);
  return (
    <LumenLayout
      crumbs={[{ label: 'Cloudflare usage' }]}
      meta={<span className="text-xs text-muted-foreground">From Cloudflare's GraphQL Analytics API, refreshed hourly</span>}
      lead={[{ id: 'limits', title: 'Against the free tier', icon: GaugeIcon, kind: 'widget', link: false, children: <LimitsCard /> }]}
      domain={USAGE_DOMAIN}
      config={config}
      rows={query.data ?? []}
      load={load}
      onConfigChange={setConfig}
      rowTitle={(r) => `${r.service} · ${r.metric}`}
    />
  );
}
