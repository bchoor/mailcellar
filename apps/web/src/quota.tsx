// The Cloudflare account's limits (/api/quota): every project on the account counts, and
// backfills pause before a hard daily limit. Shown on the Backfill and Usage pages.
import { NoteLine } from '@columenlabs/lumen-ui';
import { Progress } from '@columenlabs/lumen-ui/ui/progress';
import { QUOTA_STOP, type QuotaMeter, type QuotaOverview } from '@mailcellar/schema';
import { useQuery } from '@tanstack/react-query';
import { CloudIcon, PauseIcon } from 'lucide-react';

const fmt = (n: number) => n.toLocaleString('en-US');
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function useQuota() {
  return useQuery({
    queryKey: ['quota'],
    queryFn: async (): Promise<QuotaOverview> => {
      const res = await fetch('/api/quota');
      if (!res.ok) throw new Error(`Couldn't load the account's limits (${res.status})`);
      return res.json();
    },
    refetchInterval: 5 * 60_000,
  });
}

function MeterRow({ m }: { m: QuotaMeter }) {
  const pct = Math.round((m.used / m.limit) * 1000) / 10;
  const bar = m.hard
    ? pct >= QUOTA_STOP * 100 ? 'h-2 [&>div]:bg-loss' : pct > 75 ? 'h-2 [&>div]:bg-amber-500' : 'h-2'
    : pct > 100 ? 'h-2 [&>div]:bg-amber-500' : 'h-2';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(0,14rem)_1fr_auto]">
      <span className="min-w-0 sm:truncate">
        {m.label}
        <span className="text-muted-foreground"> · {m.period === 'day' ? 'today' : 'this month'}</span>
      </span>
      <Progress value={Math.min(pct, 100)} className={`${bar} order-last col-span-2 sm:order-none sm:col-span-1`} />
      <span className="text-right tabular-nums text-muted-foreground">
        {fmt(m.used)} / {fmt(m.limit)} · {pct}%
        {m.cost ? ` · ${usd(m.cost)}` : ''}
      </span>
    </div>
  );
}

/** Each meter against its free allowance: hard daily limits first, then the billed ones. */
export function AccountLimits() {
  const { data, error } = useQuota();
  if (error) return <p className="text-sm text-loss">{error.message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const hard = data.meters.filter((m) => m.hard);
  const billed = data.meters.filter((m) => !m.hard);
  return (
    <div className="flex flex-col gap-4">
      {data.paused && (
        <NoteLine
          icon={PauseIcon}
          title={`Backfills paused: ${data.paused.label} is past ${Math.round(QUOTA_STOP * 100)}% of its daily limit`}
          note={`They resume ${time(data.paused.resumesAt)}, after the limit resets.`}
        />
      )}
      <div className="grid gap-3">
        {hard.map((m) => <MeterRow key={m.metric} m={m} />)}
      </div>
      <div className="grid gap-3">
        {billed.map((m) => <MeterRow key={m.metric} m={m} />)}
      </div>
      <NoteLine
        icon={CloudIcon}
        title={data.readAt ? `Whole Cloudflare account, read ${time(data.readAt)}` : 'Counted by MailCellar only'}
        note={
          data.readAt
            ? `Every project on the account counts. Backfills pause at ${Math.round(QUOTA_STOP * 100)}% of a daily limit. R2 is billed past its free tier, never paused.${data.readError ? ` The last read failed: ${data.readError}` : ''}`
            : `${data.readError ?? 'Cloudflare’s figures aren’t read yet.'} Other projects on the account aren’t counted.`
        }
      />
    </div>
  );
}
