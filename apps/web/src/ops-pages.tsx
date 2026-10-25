import { LumenLayout, Tile, TileRow, type ViewDomain, useLumenLoad } from '@columenlabs/lumen-ui';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { type CustomViewConfig, customViewConfigSchema } from '@columenlabs/lumen-ui-types/views';
import { useQuery } from '@tanstack/react-query';
import {
  ActivityIcon,
  CalendarIcon,
  GaugeIcon,
  HashIcon,
  HourglassIcon,
  PercentIcon,
} from 'lucide-react';
import { useState } from 'react';
import { FREE_DAILY, PLAN_NAMES, type UsageDay } from '@mailcellar/schema';
import { EmptyState } from './archive';
import { AccountLimits, AccountLimitsTools, useQuota } from './quota';

const fmt = (n: number) => n.toLocaleString('en-US');

// The table: usage the mailboxes measure themselves (/api/usage), per UTC day. The account's
// limits above it are Cloudflare's own figures (quota.tsx).
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
  const indexed = days.find((d) => d.day === today && d.metric === 'messages_indexed')?.value ?? 0;
  const quota = useQuota().data;
  const plan = quota?.plan;
  return (
    <div className="flex flex-col gap-4">
      <TileRow>
        <Tile className="lg:flex-1" label="Messages indexed today" value={fmt(indexed)} />
        <Tile
          className="lg:flex-1"
          label="Plan"
          value={plan ? PLAN_NAMES[plan] : '…'}
          caption={
            quota && !quota.planReadAt
              ? 'taken as Free until Cloudflare billing can be read'
              : plan === 'paid'
                ? `use past the allowance is billed${quota?.paidPeriodEnd ? `; period ends ${new Date(quota.paidPeriodEnd).toLocaleString()}` : ''}`
                : 'daily limits refuse work past them'
          }
        />
      </TileRow>
      <AccountLimits />
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
      lead={[{ id: 'limits', title: 'Account limits', icon: GaugeIcon, kind: 'widget', link: false, tools: <AccountLimitsTools />, children: <LimitsCard days={query.data ?? []} /> }]}
      domain={USAGE_DOMAIN}
      config={config}
      rows={usageRows(query.data ?? [])}
      load={load}
      onConfigChange={setConfig}
      rowTitle={(r) => `${r.day} · ${r.metric}`}
    />
  );
}
