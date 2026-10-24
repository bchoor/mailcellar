// The Cloudflare account's limits (/api/quota): every project on the account counts, and
// backfills pause before a hard daily limit. Shown on the Backfill and Usage pages.
import { NoteLine } from '@columenlabs/lumen-ui';
import { QUOTA_STOP, type QuotaMeter, type QuotaOverview, type QuotaPart } from '@mailcellar/schema';
import { useQuery } from '@tanstack/react-query';
import { CloudIcon, PauseIcon } from 'lucide-react';

const fmt = (n: number) => n.toLocaleString('en-US');
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
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

const OTHER = 'color-mix(in oklab, var(--muted-foreground) 45%, transparent)';
/** Colours for other projects, in legend order; red is left for warnings and slate for Other. */
const PALETTE = [2, 6, 3, 5, 9, 4, 7].map((n) => `var(--chart-${n})`);
type Colors = (p: QuotaPart) => string;

const partName = (p: QuotaPart) => (p.mine ? `${p.name} (MailCellar)` : p.name);

/**
 * One key for every bar: MailCellar first (all its Worker, objects and buckets in one colour),
 * then each other project once, by its biggest share of any meter, each with its own colour.
 */
function legend(meters: QuotaMeter[]): { keys: { name: string; color: string; mine: boolean }[]; color: Colors } {
  const best = new Map<string, number>();
  for (const m of meters)
    for (const p of m.parts) if (!p.mine && p.name !== 'Other') best.set(p.name, Math.max(best.get(p.name) ?? 0, p.value / Math.max(m.limit, m.used)));
  const others = [...best.entries()].sort((a, b) => b[1] - a[1]).map(([name], i) => ({ name, color: PALETTE[i] ?? 'var(--chart-8)', mine: false }));
  const byName = new Map(others.map((k) => [k.name, k.color]));
  const mine = meters.some((m) => m.parts.some((p) => p.mine));
  const other = meters.some((m) => m.parts.some((p) => p.name === 'Other'));
  return {
    keys: [...(mine ? [{ name: 'MailCellar', color: 'var(--chart-1)', mine: true }] : []), ...others, ...(other ? [{ name: 'Other', color: OTHER, mine: false }] : [])],
    color: (p) => (p.mine ? 'var(--chart-1)' : (byName.get(p.name) ?? OTHER)),
  };
}

function MeterRow({ m, color }: { m: QuotaMeter; color: Colors }) {
  const pct = Math.round((m.used / m.limit) * 1000) / 10;
  // Over the allowance, the bar's end is the use and a line marks the allowance.
  const scale = Math.max(m.limit, m.used);
  const parts = m.parts.length ? m.parts : [{ name: 'Account', value: m.used, mine: false }];
  const warn = m.hard ? pct >= QUOTA_STOP * 100 : pct > 100;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(0,14rem)_1fr_auto]">
      <span className="min-w-0 sm:truncate">
        {m.label}
        <span className="text-muted-foreground"> · {m.period === 'day' ? 'today' : 'this month'}</span>
      </span>
      <div className="relative order-last col-span-2 flex h-2 overflow-hidden rounded-full bg-muted sm:order-none sm:col-span-1" role="img" aria-label={`${m.label}: ${parts.map((p) => `${partName(p)} ${fmt(p.value)}`).join(', ')}`}>
        {parts.map((p) => (
          <div key={p.name} className="h-full" style={{ width: `${(p.value / scale) * 100}%`, background: color(p) }} title={`${partName(p)}: ${fmt(p.value)}`} />
        ))}
        {m.hard && <div className="absolute inset-y-0 w-px bg-loss" style={{ left: `${QUOTA_STOP * 100}%` }} title={`Backfills pause at ${Math.round(QUOTA_STOP * 100)}%`} />}
        {m.used > m.limit && <div className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: `${(m.limit / scale) * 100}%` }} title="Free allowance" />}
      </div>
      <span className={`text-right tabular-nums ${warn ? 'text-loss' : 'text-muted-foreground'}`}>
        {fmt(m.used)} / {fmt(m.limit)} · {pct}%
        {m.cost ? ` · ${usd(m.cost)}` : ''}
      </span>
    </div>
  );
}

function Legend({ keys }: { keys: ReturnType<typeof legend>['keys'] }) {
  if (!keys.length) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {keys.map((k) => (
        <li key={k.name} className={`flex items-center gap-1.5 ${k.mine ? 'font-medium text-foreground' : ''}`}>
          <span className="size-2.5 rounded-sm" style={{ background: k.color }} />
          {k.name}
        </li>
      ))}
    </ul>
  );
}

/** Each meter against its free allowance: hard daily limits first, then the billed ones. */
export function AccountLimits() {
  const { data, error } = useQuota();
  if (error) return <p className="text-sm text-loss">{error.message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const hard = data.meters.filter((m) => m.hard);
  const billed = data.meters.filter((m) => !m.hard);
  const { keys, color } = legend(data.meters);
  const daily = data.meters.find((m) => m.period === 'day');
  const monthly = data.meters.find((m) => m.period === 'month');
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
        {hard.map((m) => <MeterRow key={m.metric} m={m} color={color} />)}
      </div>
      <div className="grid gap-3">
        {billed.map((m) => <MeterRow key={m.metric} m={m} color={color} />)}
      </div>
      <Legend keys={keys} />
      <NoteLine
        icon={CloudIcon}
        title={data.readAt ? `Whole Cloudflare account, read ${time(data.readAt)}` : 'Counted by MailCellar only'}
        note={
          data.readAt
            ? `Every project on the account counts. ${daily ? `Daily limits reset ${time(daily.resetsAt)}. ` : ''}${monthly ? `Monthly ones reset ${date(monthly.resetsAt)}` : ''}${
                data.billing ? `, the end of the billing period (from ${date(data.billing.start)}). ` : ', counted by calendar month until the billing period can be read. '
              }${
                data.plan === 'paid'
                  ? 'On Workers Paid nothing pauses: use past the allowance is billed.'
                  : `Backfills pause at ${Math.round(QUOTA_STOP * 100)}% of a daily limit. R2 is billed past its free tier, never paused.`
              }${data.readError ? ` The last read failed: ${data.readError}` : ''}`
            : `${data.readError ?? 'Cloudflare’s figures aren’t read yet.'} Other projects on the account aren’t counted.`
        }
      />
    </div>
  );
}
