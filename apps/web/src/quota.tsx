// The Cloudflare account's limits (/api/quota): every project on the account counts, and
// backfills pause before a hard daily limit. Shown on the Backfill and Usage pages.
import { IconButton, NoteLine } from '@columenlabs/lumen-ui';
import { ToggleGroup, ToggleGroupItem } from '@columenlabs/lumen-ui/ui/toggle-group';
import { quotaStop, type LevelMeter, type QuotaMeter, type QuotaOverview, type QuotaPart } from '@mailcellar/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudIcon, PauseIcon, RefreshCwIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';

const fmt = (n: number) => n.toLocaleString('en-US');
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Bytes in the largest unit that keeps a whole number in front: 1.2 GB, 340 MB. */
function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : fmt(Math.round(n))} ${units[i]}`;
}

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

/** All: the account's use, by project. MailCellar: only MailCellar's own share. */
type Show = 'all' | 'mine';

// Both pages' cards share the choice, and the header's toggle drives the body.
let shown: Show = 'all';
const listeners = new Set<() => void>();
const useShow = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => shown,
  );
const setShow = (s: Show) => {
  shown = s;
  for (const l of listeners) l();
};

const MINE = 'var(--chart-1)';
const OTHER = 'color-mix(in oklab, var(--muted-foreground) 45%, transparent)';
/** Colours for other projects, in legend order; red is left for warnings and slate for Other. */
const PALETTE = [2, 6, 3, 5, 9, 4, 7].map((n) => `var(--chart-${n})`);
type Colors = (p: { name: string; mine: boolean }) => string;

const partName = (p: QuotaPart) => (p.mine ? `${p.name} (MailCellar)` : p.name);

/**
 * One key for every bar: MailCellar first (its Worker, objects, database and buckets in one
 * colour), then each other project once, by its biggest share of any limit, each its own colour.
 */
function legend(data: QuotaOverview): { keys: { name: string; color: string; mine: boolean }[]; color: Colors } {
  const best = new Map<string, number>();
  const rows: { parts: QuotaPart[]; scale: number }[] = [
    ...data.meters.map((m) => ({ parts: m.parts, scale: Math.max(m.limit, m.used) })),
    ...data.levels.map((m) => ({ parts: m.parts, scale: Math.max(m.limit, m.used) })),
  ];
  for (const r of rows)
    for (const p of r.parts) if (!p.mine && p.name !== 'Other') best.set(p.name, Math.max(best.get(p.name) ?? 0, p.value / r.scale));
  const others = [...best.entries()].sort((a, b) => b[1] - a[1]).map(([name], i) => ({ name, color: PALETTE[i] ?? 'var(--chart-8)', mine: false }));
  const byName = new Map(others.map((k) => [k.name, k.color]));
  const mine = rows.some((r) => r.parts.some((p) => p.mine));
  const other = rows.some((r) => r.parts.some((p) => p.name === 'Other'));
  return {
    keys: [...(mine ? [{ name: 'MailCellar', color: MINE, mine: true }] : []), ...others, ...(other ? [{ name: 'Other', color: OTHER, mine: false }] : [])],
    color: (p) => (p.mine ? MINE : (byName.get(p.name) ?? OTHER)),
  };
}

/** Every row: the same fixed label and figures columns, so all bars are one width. */
const ROW = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm sm:grid-cols-[13rem_minmax(0,1fr)_17rem]';

interface Bar {
  label: string;
  used: number;
  limit: number;
  parts: QuotaPart[];
  /** Backfills pause at `stop` of it: a red line marks where. */
  hard?: boolean;
  stop?: number;
  cost: number | null;
  /** Figures: counts, bytes or (for cost) a month's bill. */
  unit: (n: number) => string;
}

function BarRow({ b, color, show }: { b: Bar; color: Colors; show: Show }) {
  const mine = b.parts.filter((p) => p.mine).reduce((n, p) => n + p.value, 0);
  const used = show === 'mine' ? mine : b.used;
  const pct = Math.round((used / b.limit) * 1000) / 10;
  // Over the allowance, the bar's end is the use and a line marks the allowance.
  const scale = Math.max(b.limit, used);
  const parts = show === 'mine' ? [{ name: 'mailcellar', value: mine, mine: true }] : b.parts.length ? b.parts : [{ name: 'Account', value: b.used, mine: false }];
  const stop = b.stop ?? 1;
  const warn = b.hard ? pct >= stop * 100 : pct > 100;
  return (
    <div className={ROW}>
      <span className="min-w-0 sm:truncate">{b.label}</span>
      <div className="relative order-last col-span-2 flex h-2 overflow-hidden rounded-full bg-muted sm:order-none sm:col-span-1" role="img" aria-label={`${b.label}: ${parts.map((p) => `${partName(p)} ${b.unit(p.value)}`).join(', ')}`}>
        {parts.map((p) => (
          <div key={p.name} className="h-full" style={{ width: `${(p.value / scale) * 100}%`, background: color(p) }} title={`${partName(p)}: ${b.unit(p.value)}`} />
        ))}
        {b.hard && <div className="absolute inset-y-0 w-px bg-loss" style={{ left: `${stop * 100}%` }} title={`Backfills pause at ${fmt(Math.round(b.limit * stop))}`} />}
        {used > b.limit && <div className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: `${(b.limit / scale) * 100}%` }} title="Free allowance" />}
      </div>
      <span className={`text-right tabular-nums ${warn ? 'text-loss' : 'text-muted-foreground'}`}>
        {b.unit(used)} / {b.unit(b.limit)} · {pct}%
        {show === 'all' && b.cost ? ` · ${usd(b.cost)}` : ''}
      </span>
    </div>
  );
}

const meterBar = (m: QuotaMeter): Bar => ({ label: m.label, used: m.used, limit: m.limit, hard: m.hard, stop: quotaStop(m.metric), cost: m.cost, unit: fmt, parts: m.parts.length ? m.parts : [{ name: 'mailcellar', value: m.ours, mine: true }, { name: 'Account', value: m.used - m.ours, mine: false }] });
const levelBar = (m: LevelMeter): Bar => ({ label: m.label, used: m.used, limit: m.limit, cost: m.cost, unit: m.unit === 'bytes' ? bytes : fmt, parts: m.parts });

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
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

/** The card header's controls: whose use, and Refresh (Cloudflare is read at most once a minute). */
export function AccountLimitsTools() {
  const show = useShow();
  const client = useQueryClient();
  const { data } = useQuota();
  const [now, setNow] = useState(Date.now());
  const wait = data ? Date.parse(data.refreshAt) - now : 0;
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(t);
  }, [wait]);
  const refresh = useMutation({
    mutationFn: async (): Promise<QuotaOverview> => {
      const res = await fetch('/api/quota/refresh', { method: 'POST' });
      if (!res.ok) throw new Error(`Couldn't refresh the account's limits (${res.status})`);
      return res.json();
    },
    onSuccess: (q) => {
      client.setQueryData(['quota'], q);
      setNow(Date.now());
    },
  });
  return (
    <div className="flex items-center gap-1">
      <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={show} onValueChange={(v) => v && setShow(v as Show)} aria-label="Whose use">
        <ToggleGroupItem value="all">All</ToggleGroupItem>
        <ToggleGroupItem value="mine">MailCellar</ToggleGroupItem>
      </ToggleGroup>
      <IconButton
        icon={RefreshCwIcon}
        label={wait > 0 ? `Refresh after ${new Date(data!.refreshAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : 'Refresh'}
        busy={refresh.isPending}
        disabled={!data || wait > 0 || refresh.isPending}
        onClick={() => refresh.mutate()}
      />
    </div>
  );
}

/** Each limit against its allowance: what resets today, this month, and what's held now. */
export function AccountLimits() {
  const show = useShow();
  const { data, error } = useQuota();
  if (error) return <p className="text-sm text-loss">{error.message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const { keys, color } = legend(data);
  const daily = data.meters.filter((m) => m.period === 'day');
  const monthly = data.meters.filter((m) => m.period === 'month');
  const workflows = data.readAt && !data.levels.some((l) => l.metric === 'workflows_running');
  const monthEnds = monthly[0] && `${date(monthly[0].resetsAt)}${data.billing ? '' : ' (calendar month)'}`;
  return (
    <div className="flex flex-col gap-5">
      {data.paused && (
        <NoteLine
          icon={PauseIcon}
          title={`${data.paused.metric === 'do_rows_written' ? 'Indexing' : 'Backfills'} paused: ${data.paused.label} is past ${fmt(Math.round((data.meters.find((m) => m.metric === data.paused!.metric)?.limit ?? 0) * quotaStop(data.paused.metric)))} today`}
          note={`Resumes ${time(data.paused.resumesAt)}, after the limit resets.`}
        />
      )}
      {daily.length > 0 && (
        <Section title={`Today · resets ${time(daily[0].resetsAt)}`}>
          {daily.map((m) => <BarRow key={m.metric} b={meterBar(m)} color={color} show={show} />)}
        </Section>
      )}
      {monthly.length > 0 && (
        <Section title={`This month · resets ${monthEnds}`}>
          {monthly.map((m) => <BarRow key={m.metric} b={meterBar(m)} color={color} show={show} />)}
        </Section>
      )}
      {data.levels.length > 0 && (
        <Section title="Now">
          {data.levels.map((m) => <BarRow key={m.metric} b={levelBar(m)} color={color} show={show} />)}
        </Section>
      )}
      {show === 'all' && <Legend keys={keys} />}
      <NoteLine
        icon={CloudIcon}
        title={data.readAt ? `Whole Cloudflare account, read ${time(data.readAt)}` : 'Counted by MailCellar only'}
        note={
          data.readAt
            ? `Every project on the account counts. ${
                data.plan === 'paid'
                  ? 'On Workers Paid nothing pauses: use past the allowance is billed.'
                  : 'Backfills pause at the red line of a daily limit. R2 is billed past its free tier, never paused.'
              }${workflows ? ' Workflows running couldn’t be read.' : ''}${data.readError ? ` The last read failed: ${data.readError}` : ''}`
            : `${data.readError ?? 'Cloudflare’s figures aren’t read yet.'} Other projects on the account aren’t counted.`
        }
      />
    </div>
  );
}
