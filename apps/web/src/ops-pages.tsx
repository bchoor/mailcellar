import { LumenLayout, NoteLine, Tile, TileRow, type ViewDomain, useLumenLoad } from '@columenlabs/lumen-ui';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { Progress } from '@columenlabs/lumen-ui/ui/progress';
import { type CustomViewConfig, customViewConfigSchema } from '@columenlabs/lumen-ui-types/views';
import { useQuery } from '@tanstack/react-query';
import {
  ActivityIcon,
  CalendarIcon,
  CloudIcon,
  GaugeIcon,
  HashIcon,
  HourglassIcon,
  PercentIcon,
} from 'lucide-react';
import { useState } from 'react';
import { FREE_DAILY, type UsageDay } from '@mailcellar/schema';
import { EmptyState } from './archive';

const fmt = (n: number) => n.toLocaleString('en-US');

// No sync has run yet: the Workflow arrives in phase 2 and reports real runs here.
// Until then the page says so, and the status bar shows nothing.
export function BackfillPage() {
  return (
    <LumenLayout
      crumbs={[{ label: 'Backfill' }]}
      meta={<Badge variant="secondary">Not started</Badge>}
      cards={[
        {
          id: 'progress', title: 'Backfill progress', icon: HourglassIcon, kind: 'widget', link: false, w: 6,
          children: (
            <EmptyState icon={HourglassIcon} title="No backfill yet">
              Not built yet. Once it ships, it copies the existing mail in each connected Gmail account, about 18,000 messages a day
              on the Workers Free plan. Progress and each run show here.
            </EmptyState>
          ),
        },
      ]}
    />
  );
}

// Usage the mailbox measures itself (/api/usage). Account-wide figures for the other
// services are not counted yet (no Analytics API token, by decision).
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
    // Rows read and rows written don't add up to anything, so no Total; a day's group shows its peak share.
    { key: 'used', label: 'Used', icon: HashIcon, value: (r) => r.used, format: 'rounded' },
    { key: 'allowance', label: 'Free a day', icon: HashIcon, value: (r) => r.allowance, format: 'rounded' },
    { key: 'pct', label: 'Of free', icon: PercentIcon, value: (r) => r.pct, format: 'weight', filterable: true },
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
        <Tile className="lg:flex-1" label="Messages indexed today" value={fmt(indexed)} />
        <Tile className="lg:flex-1" label="Rows written left today" value={fmt(left)} caption="the daily cap that limits the backfill" />
        <Tile className="lg:flex-1" label="Plan" value="Workers Free" caption="usage past the caps is refused, not billed" />
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
        title="Counted by MailCellar itself"
        note="Only its own database reads and writes. Worker requests and R2 storage aren’t counted here yet."
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
      meta={<span className="text-xs text-muted-foreground">Days run midnight to midnight UTC</span>}
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
