// The backfill: each Gmail account's sync (/api/sync), on the Backfill page and in the status bar,
// and its coverage map: one line per year, one block per month, from Gmail's exact count for the
// month (the census) and what MailCellar has copied. Pick months there, or select them with a
// preset, then Start backfill; picked queued months can be taken back out.
// Everything shown is what the sync state says now; nothing is estimated.
import {
  ErrorLine, LumenCoverageMap, LumenLayout, NoteLine, StatusItem, Tile, TileRow,
  type CoverageData, type CoverageFact, type CoveragePick, type FilterToken, type ScheduleRun,
} from '@columenlabs/lumen-ui';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Progress } from '@columenlabs/lumen-ui/ui/progress';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@columenlabs/lumen-ui/ui/dropdown-menu';
import { addMonths, monthRange, type AccountCoverage, type BackfillJob, type MonthCoverage, type SyncOverview, type SyncSummary } from '@mailcellar/schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarRangeIcon, ChevronDownIcon, GaugeIcon, MailIcon, DatabaseIcon, HourglassIcon, ListChecksIcon, ListTodoIcon, ListXIcon, RefreshCwIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from './archive';
import { AccountLimits } from './quota';

const fmt = (n: number) => n.toLocaleString('en-US');
const size = (bytes: number) =>
  bytes < 1e6 ? `${fmt(Math.round(bytes / 1e3))} KB` : bytes < 1e9 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e9).toFixed(2)} GB`;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Each account's sync. Polls every 15 seconds while one is copying. */
export function useSync() {
  return useQuery({
    queryKey: ['sync'],
    queryFn: async (): Promise<SyncOverview> => {
      const res = await fetch('/api/sync');
      if (!res.ok) throw new Error(`Couldn't load the backfill (${res.status})`);
      return res.json();
    },
    refetchInterval: (q) => (q.state.data?.accounts.some((a) => a.sync.status === 'running') ? 15_000 : false),
  });
}

const monthName = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Start a sync for one account. Resolves to what happened, in words. */
async function syncNow(id: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`/api/accounts/${id}/sync`, { method: 'POST' });
  if (res.status === 409) return { ok: false, detail: 'Waiting for Basin write access' };
  if (!res.ok) return { ok: false, detail: `Not started (${res.status})` };
  const body = (await res.json()) as { started: boolean; sync: SyncSummary };
  return { ok: true, detail: body.started ? 'Started' : STATUS[body.sync.status].label };
}

/** Schedules ▸ Gmail sync ▸ Run now: Sync now for every account. */
export async function syncAllNow(ids: string[]): Promise<ScheduleRun> {
  const results = await Promise.all(ids.map((id) => syncNow(id)));
  const started = results.filter((r) => r.detail === 'Started').length;
  const failed = results.filter((r) => !r.ok);
  return {
    at: new Date().toISOString(),
    ok: failed.length === 0,
    detail: failed.length ? failed[0].detail : `Started ${started} of ${ids.length}`,
  };
}

const STATUS: Record<SyncSummary['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  idle: { label: 'Not running', variant: 'outline' },
  running: { label: 'Copying', variant: 'default' },
  waiting: { label: 'Waiting', variant: 'secondary' },
  stopped: { label: 'Stopped', variant: 'destructive' },
};

/** What a sync is doing, in a few words; null when the badge says it all. */
function headline(s: SyncSummary): string | null {
  if (s.phase === null || s.status === 'stopped') return null;
  if (s.phase === 'paused' && s.resumesAt && s.pausedFor) return `Paused before the account's daily limit (${s.pausedFor}). Resumes ${when(s.resumesAt)}.`;
  if (s.phase === 'paused' && s.resumesAt) return `Paused at today's free limit. Resumes ${when(s.resumesAt)}.`;
  if (s.status === 'waiting' && s.resumesAt) return `Trying again ${when(s.resumesAt)}.`;
  if (s.phase === 'live') return 'New mail is copied on each sync. Pick months below to copy older mail.';
  if (s.status === 'running') return s.month ? `Copying ${monthName(s.month)}.` : 'Copying.';
  return 'Not running. Sync now or the next scheduled run continues it.';
}

/** The badge: what the sync is doing now. */
function badge(s: SyncSummary): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  if (s.phase === null) return { label: 'Not started', variant: 'outline' };
  if (s.phase === 'live' && s.status !== 'running') return { label: 'Live', variant: 'secondary' };
  return STATUS[s.status];
}

/** A wait in words, from minutes. */
const duration = (min: number) =>
  min < 60 ? `about ${Math.max(1, Math.round(min))} min` : min < 48 * 60 ? `about ${Math.round(min / 60)} h` : `about ${Math.round(min / 1440)} days`;
/** Messages in a month Gmail has and MailCellar hasn't copied yet. */
const left = (m: MonthCoverage) => Math.max(0, (m.gmail ?? 0) - m.copied);

/** The copy rate over the last 10 minutes, or why there is none. */
function rateTile(s: SyncSummary): { value: string; caption: string } {
  if (s.phase === 'paused') return { value: 'Paused', caption: s.pausedFor ? `for ${s.pausedFor}${s.resumesAt ? `, resumes ${when(s.resumesAt)}` : ''}` : s.resumesAt ? `resumes ${when(s.resumesAt)}` : 'waiting' };
  if (s.status === 'stopped') return { value: 'Stopped', caption: 'see the error below' };
  if (s.ratePerMin === null) return { value: '—', caption: s.status === 'running' ? 'measuring' : 'not copying' };
  return { value: `${fmt(Math.round(s.ratePerMin))} / min`, caption: 'last 10 minutes' };
}

const pct = (s: SyncSummary) => (s.total ? Math.min(100, Math.round((s.copied / s.total) * 1000) / 10) : 0);

function AccountSync({ id, sync: s, basin }: { id: string; sync: SyncSummary; basin: boolean }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const { data: cov } = useQuery(useCoverage(id));
  const queued = cov?.months.filter(busyMonth) ?? [];
  const toCopy = queued.reduce((n, m) => n + left(m), 0);
  const rate = rateTile(s);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Badge variant={badge(s).variant}>{badge(s).label}</Badge>
          {headline(s) && <span className="text-muted-foreground">{headline(s)}</span>}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !basin || s.status === 'running'}
          onClick={async () => {
            setBusy(true);
            try {
              setResult(await syncNow(id));
              await client.invalidateQueries({ queryKey: ['sync'] });
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCwIcon className={busy ? 'animate-spin' : undefined} /> Sync now
        </Button>
      </div>
      {s.total !== null && (
        <div className="grid grid-cols-[1fr_auto] items-center gap-3 text-sm">
          <Progress value={pct(s)} className="h-2" />
          <span className="tabular-nums text-muted-foreground">
            {fmt(s.copied)} of {fmt(s.total)} in Gmail · {pct(s)}%
          </span>
        </div>
      )}
      {s.phase !== null && (
        <TileRow>
          <Tile className="lg:flex-1" label="Rate" value={rate.value} caption={rate.caption} />
          <Tile
            className="lg:flex-1"
            label="Queued to copy"
            value={`${fmt(toCopy)}`}
            caption={!queued.length ? 'nothing queued' : `messages in ${fmt(queued.length)} month${queued.length > 1 ? 's' : ''}${s.ratePerMin ? ` · ${duration(toCopy / s.ratePerMin)} left` : ''}`}
          />
          <Tile className="lg:flex-1" label="Size" value={size(s.bytes)} caption="as Gmail counts it" />
          <Tile className="lg:flex-1" label="Started" value={s.startedAt ? when(s.startedAt) : '—'} />
          <Tile className="lg:flex-1" label="Last saved" value={s.updatedAt ? when(s.updatedAt) : '—'} />
        </TileRow>
      )}
      {s.error && <ErrorLine error={new Error(s.error)} />}
      {result && !result.ok && <ErrorLine error={new Error(result.detail)} />}
    </div>
  );
}

/** An account's coverage: polls every 15 seconds while the census counts or a month is copying. */
function useCoverage(id: string) {
  return {
    queryKey: ['coverage', id],
    queryFn: async (): Promise<AccountCoverage> => {
      const res = await fetch(`/api/accounts/${id}/coverage`);
      if (!res.ok) throw new Error(`Couldn't load the coverage (${res.status})`);
      return res.json();
    },
    refetchInterval: (q: { state: { data?: AccountCoverage } }) => {
      const d = q.state.data;
      return d && (d.census.status === 'counting' || d.months.some((m) => busyMonth(m) || indexing(m))) ? 15_000 : false;
    },
  };
}

/** A month copied to Basin whose search index is still being built from it. */
const indexing = (m: MonthCoverage) => m.landed && m.indexed < m.inBasin;

/** A month's state on the map: Copying while a lane copies it, then Indexing until search has it all. */
function monthState(m: MonthCoverage, copying: string[]): CoverageFact['state'] {
  if (copying.includes(m.month) || m.state === 'running') return 'running';
  if (m.state === 'queued' || m.state === 'failed') return m.state;
  if (indexing(m)) return 'indexing';
  // Done, canceled or untouched: it shows by what is copied (a canceled month with nothing is Missing).
  return undefined;
}

/** A backfill error in a few words for the map's tooltip; the Backfills list keeps the full text. */
function shortError(e: string): string {
  if (/HTTP 429|rate ?limit/i.test(e)) return 'Gmail rate limit';
  if (/HTTP 403/.test(e)) return 'Gmail refused (403)';
  if (/HTTP 5\d\d/.test(e)) return 'Gmail unavailable';
  return e.length > 40 ? `${e.slice(0, 39)}…` : e;
}

/** Coverage as map facts: a month shows once Gmail's count for it is known or a backfill touched it. */
const facts = (id: string, email: string, copying: string[]) => (c: AccountCoverage): CoverageData => ({
  facts: c.months
    .filter((m) => m.gmail !== null || m.state)
    .map((m) => ({
      row: id,
      period: m.month,
      have: m.copied,
      expected: m.gmail ?? 0,
      state: monthState(m, copying),
      note: [m.landed && m.indexed < m.copied ? `${fmt(m.indexed)} searchable` : null, m.error ? `Failed: ${shortError(m.error)}` : null].filter(Boolean).join(' · ') || undefined,
    })),
  rows: [{ row: id, label: email }],
  current: c.current,
});

/** The map's words for its states. */
const STATE_LABELS = { running: 'Copying' } as const;

const busyMonth = (m: MonthCoverage) => m.state === 'queued' || m.state === 'running';

/** The months a preset copies. Months Gmail counted as empty are left out. */
function presetMonths(c: AccountCoverage, preset: Preset): string[] {
  const by = new Map(c.months.map((m) => [m.month, m]));
  const worth = (month: string) => {
    const m = by.get(month);
    return !m || ((m.gmail === null || m.gmail > 0) && !busyMonth(m));
  };
  switch (preset) {
    case 'missing':
      return c.months.filter((m) => m.gmail !== null && m.gmail > m.copied && !busyMonth(m)).map((m) => m.month);
    case '3m':
      return monthRange(addMonths(c.current, -2), c.current).filter(worth);
    case '12m':
      return monthRange(addMonths(c.current, -11), c.current).filter(worth);
    case 'all':
      return c.months.filter((m) => m.gmail !== null && m.gmail > 0 && !busyMonth(m)).map((m) => m.month);
  }
}

type Preset = 'missing' | '3m' | '12m' | 'all';
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'missing', label: 'Missing months' },
  { id: '3m', label: 'Last 3 months' },
  { id: '12m', label: 'Last 12 months' },
  { id: 'all', label: 'All months' },
];

/** Queue months to copy; resolves to an error in words, or null. */
async function queueBackfill(id: string, months: string[], label: string): Promise<string | null> {
  const res = await fetch(`/api/accounts/${id}/backfill`, { method: 'POST', body: JSON.stringify({ months, label }) });
  if (res.status === 409) return 'Waiting for Basin write access';
  return res.ok ? null : `Not queued (${res.status})`;
}

function censusHint(c: AccountCoverage | undefined): string | null {
  if (!c) return null;
  const { census } = c;
  if (census.status === 'counting')
    return census.month ? `Counting Gmail by month: ${monthName(census.month)} next.` : 'Counting Gmail by month.';
  if (census.status === 'stopped') return `Counting stopped: ${census.error}. It resumes when you open this page.`;
  if (census.finishedAt) return `Gmail counted ${when(census.finishedAt)}. Recent months are recounted every 6 hours.`;
  return null;
}

/**
 * One account's coverage map: pick months (click, shift-click a range, or Select months), then
 * Start backfill, or Remove from queue for queued ones. Nothing starts from a pick alone.
 */
function AccountCoverageMap({ id, email, basin, rate, copying }: { id: string; email: string; basin: boolean; rate: number | null; copying: string[] }) {
  const client = useQueryClient();
  const source = useCoverage(id);
  const { data } = useQuery(source);
  const [error, setError] = useState<string | null>(null);
  const [preselect, setPreselect] = useState<CoveragePick>();
  const refresh = () => Promise.all(['coverage', 'jobs', 'sync'].map((k) => client.invalidateQueries({ queryKey: k === 'sync' ? ['sync'] : [k, id] })));
  const month = (key: string) => data?.months.find((x) => x.month === key);
  const queue = async (months: string[]) => {
    setError(await queueBackfill(id, months, 'Picked months'));
    await refresh();
  };
  /** Take months out of the queue, or every queued month. Mail already copied stays. */
  const unqueue = async (months?: string[]) => {
    const res = await fetch(`/api/accounts/${id}/backfill/cancel`, { method: 'POST', body: JSON.stringify(months ? { months } : {}) });
    setError(res.ok ? null : `Not removed (${res.status})`);
    await refresh();
  };
  const select = (months: string[]) => {
    setError(months.length ? null : 'Nothing to select: those months are copied, queued or empty.');
    setPreselect([{ row: id, months }]);
  };
  const anyQueued = !!data?.months.some(busyMonth);
  return (
    <div className="flex flex-col gap-2">
      <LumenCoverageMap
        source={{ ...source, select: facts(id, email, copying) }}
        stateLabels={STATE_LABELS}
        title={`${email} by month`}
        icon={CalendarRangeIcon}
        rows={{ title: 'Year' }}
        layout="months"
        unit="messages"
        summary={['complete', 'counts']}
        select={basin ? 'backfill' : undefined}
        selectable={(_row, key) => {
          const m = month(key);
          return !!m && m.gmail !== null && m.gmail > 0 && !busyMonth(m);
        }}
        onQueue={(pick: CoveragePick) => queue(pick.flatMap((p) => p.months))}
        queueLabel="Start backfill"
        pickNote={(pick: CoveragePick) => {
          const n = pick.flatMap((p) => p.months).reduce((t, key) => t + (month(key) ? left(month(key)!) : 0), 0);
          return `${fmt(n)} messages · ${rate ? `${duration(n / rate)} at ${fmt(Math.round(rate))} a minute` : 'time shows once copying runs'}`;
        }}
        removable={(_row, key) => {
          const m = month(key);
          return !!m && busyMonth(m);
        }}
        onRemove={(pick: CoveragePick) => unqueue(pick.flatMap((p) => p.months))}
        preselect={preselect}
        hint={censusHint(data) ?? 'Click a month, shift-click for a range. Nothing starts until Start backfill.'}
        tools={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={!basin || !data}>
                <ListTodoIcon /> Select months <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {PRESETS.map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => data && select(presetMonths(data, p.id))}>
                  {p.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!anyQueued} onSelect={() => void unqueue()}>
                <ListXIcon /> Clear queue
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
        empty={
          <p className="py-6 text-center text-muted-foreground">
            {data?.census.status === 'stopped' ? 'Counting stopped. It resumes when you open this page.' : 'Counting Gmail by month. Months show here as they are counted.'}
          </p>
        }
      />
      {error && <ErrorLine error={new Error(error)} />}
    </div>
  );
}

const JOB_STATUS: Record<BackfillJob['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  queued: { label: 'Queued', variant: 'outline' },
  running: { label: 'Copying', variant: 'default' },
  done: { label: 'Done', variant: 'secondary' },
  failed: { label: 'Failed', variant: 'destructive' },
  canceled: { label: 'Removed', variant: 'outline' },
};

/** An account's latest backfills, with Cancel and Retry. */
function Jobs({ id }: { id: string }) {
  const client = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['jobs', id],
    queryFn: async (): Promise<BackfillJob[]> => {
      const res = await fetch(`/api/accounts/${id}/jobs`);
      if (!res.ok) throw new Error(`Couldn't load the backfills (${res.status})`);
      return res.json();
    },
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === 'queued' || j.status === 'running') ? 15_000 : false),
  });
  const act = async (job: number, action: 'cancel' | 'retry') => {
    await fetch(`/api/accounts/${id}/jobs/${job}/${action}`, { method: 'POST' });
    await Promise.all([client.invalidateQueries({ queryKey: ['jobs', id] }), client.invalidateQueries({ queryKey: ['coverage', id] }), client.invalidateQueries({ queryKey: ['sync'] })]);
  };
  if (error) return <ErrorLine error={error} />;
  if (!data?.length) return <p className="text-sm text-muted-foreground">No backfills yet. Pick months on the map, or use Select months.</p>;
  return (
    <ul className="flex flex-col divide-y text-sm">
      {data.map((j) => {
        const total = Object.values(j.months).reduce((a, b) => a + b, 0);
        const span = j.from === j.to ? monthName(j.from) : `${monthName(j.from)} to ${monthName(j.to)}`;
        return (
          <li key={j.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <Badge variant={JOB_STATUS[j.status].variant}>{JOB_STATUS[j.status].label}</Badge>
            <span className="font-medium">{j.label}</span>
            <span className="text-muted-foreground">{span}</span>
            <span className="tabular-nums text-muted-foreground">
              {fmt(j.months.done)} of {fmt(total)} months
              {j.months.failed ? ` · ${fmt(j.months.failed)} failed` : ''}
              {j.months.canceled ? ` · ${fmt(j.months.canceled)} removed` : ''}
            </span>
            <span className="ml-auto flex gap-2">
              {(j.months.queued > 0 || j.months.running > 0) && (
                <Button variant="outline" size="sm" onClick={() => act(j.id, 'cancel')}>
                  <XIcon /> Cancel
                </Button>
              )}
              {(j.months.failed > 0 || j.months.canceled > 0) && (
                <Button variant="outline" size="sm" onClick={() => act(j.id, 'retry')}>Retry</Button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** How fresh a mailbox's copy is: when its sync last saved, in words. */
function freshness(s: SyncSummary, now = Date.now()): string {
  if (!s.updatedAt) return 'Never synced';
  const min = Math.round((now - Date.parse(s.updatedAt)) / 60_000);
  const ago = min < 1 ? 'just now' : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
  return `Synced ${ago}`;
}

/**
 * Every mailbox on one map: one row each, one column per month (or quarter, or year), and how
 * fresh each copy is. Picks queue a backfill in each mailbox picked.
 */
function AllMailboxesMap({ accounts, picked, onPick }: { accounts: SyncOverview['accounts']; picked: string | null; onPick: (email: string) => void }) {
  const ids = accounts.map((a) => a.id);
  const source = {
    queryKey: ['coverage-all', ids],
    queryFn: async (): Promise<Record<string, AccountCoverage>> => {
      const all = await Promise.all(
        ids.map(async (id) => {
          const res = await fetch(`/api/accounts/${id}/coverage`);
          if (!res.ok) throw new Error(`Couldn't load the coverage (${res.status})`);
          return [id, (await res.json()) as AccountCoverage] as const;
        }),
      );
      return Object.fromEntries(all);
    },
    refetchInterval: (q: { state: { data?: Record<string, AccountCoverage> } }) =>
      Object.values(q.state.data ?? {}).some((c) => c.census.status === 'counting' || c.months.some((m) => busyMonth(m) || indexing(m))) ? 15_000 : false,
  };
  return (
    <div className="flex flex-col gap-2">
      <LumenCoverageMap
        source={{
          ...source,
          select: (all): CoverageData => {
            const per = accounts.map((a) => (all[a.id] ? facts(a.id, a.email, a.sync.months)(all[a.id]) : { facts: [], rows: [] }));
            return {
              facts: per.flatMap((p) => p.facts),
              rows: accounts.map((a) => ({
                row: a.id,
                label: a.email,
                sub: `${badge(a.sync).label} · ${freshness(a.sync)}`,
              })),
              current: Object.values(all)[0]?.current,
            };
          },
        }}
        title="All mailboxes by month"
        stateLabels={STATE_LABELS}
        icon={CalendarRangeIcon}
        rows={{ title: 'Mailbox' }}
        block="month"
        zoom={['month', 'quarter', 'year']}
        unit="messages"
        summary={['complete']}
        select="drill"
        drilled={null}
        onDrill={(row) => {
          const a = accounts.find((x) => x.id === row);
          if (a) onPick(a.email);
        }}
        hint="Tap a row to show that mailbox below."
      />
    </div>
  );
}

/** Every mailbox, one line each: tap one to show it in the cards below. */
function MailboxList({ accounts, picked, onPick }: { accounts: SyncOverview['accounts']; picked: string; onPick: (email: string) => void }) {
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {accounts.map((a) => (
        <li key={a.id}>
          <Button
            variant={a.email === picked ? 'secondary' : 'ghost'}
            className="h-auto w-full justify-start gap-3 py-2"
            aria-pressed={a.email === picked}
            onClick={() => onPick(a.email)}
          >
            <span className="min-w-0 flex-1 truncate text-left font-medium">{a.email}</span>
            <Badge variant={badge(a.sync).variant}>{badge(a.sync).label}</Badge>
            <span className="hidden text-muted-foreground sm:inline">{freshness(a.sync)}</span>
            <span className="w-14 text-right tabular-nums text-muted-foreground">{a.sync.total ? `${pct(a.sync)}%` : '—'}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The mailbox a card follows: the mailbox chip of its colour, else the first mailbox. */
function followed(accounts: SyncOverview['accounts'], follows: FilterToken[]) {
  const email = follows.find((t) => t.key === 'mailbox')?.value;
  return accounts.find((a) => a.email === email) ?? accounts[0];
}

export function BackfillPage() {
  const query = useSync();
  const data = query.data;
  const [picked, setPicked] = useState<string | null>(null);
  const shown = data?.accounts.find((a) => a.email === picked) ?? data?.accounts[0];
  const running = data?.accounts.filter((a) => a.sync.status === 'running').length ?? 0;
  return (
    <LumenLayout
      crumbs={[{ label: 'Backfill' }]}
      meta={data && <Badge variant="secondary">{running ? `${running} copying` : 'Not copying'}</Badge>}
      cards={[
        ...(query.error ? [{ id: 'error', title: 'Backfill', icon: HourglassIcon, kind: 'widget' as const, link: false as const, w: 6, children: <ErrorLine error={query.error} /> }] : []),
        ...(data && !data.basin
          ? [{
              id: 'basin', title: 'Basin', icon: DatabaseIcon, kind: 'widget' as const, link: false as const, w: 6,
              children: (
                <NoteLine
                  icon={DatabaseIcon}
                  title="Waiting for Basin write access"
                  note="Basin keeps every copied message. No sync starts until MailCellar can write to it."
                />
              ),
            }]
          : []),
        ...(data && data.accounts.length === 0
          ? [{
              id: 'none', title: 'Backfill', icon: HourglassIcon, kind: 'widget' as const, link: false as const, w: 6,
              children: (
                <EmptyState icon={HourglassIcon} title="No Gmail accounts">
                  Add one in Settings ▸ Accounts. Its backfill shows here.
                </EmptyState>
              ),
            }]
          : []),
        // The mailbox map picks the mailbox: its chip goes to every card of its colour (Lumen's
        // linked cards), and the cards below show the mailbox they follow.
        // Picking a mailbox shares its chip with every card of the same colour (Lumen's linked
        // cards); the cards below show the mailbox they follow.
        ...(data && data.accounts.length
          ? [
              {
                id: 'mailboxes', title: 'Mailboxes', icon: MailIcon, kind: 'widget' as const, color: 'teal' as const, w: 6,
                publishes: [{ key: 'mailbox', value: shown!.email }],
                children: <MailboxList accounts={data.accounts} picked={shown!.email} onPick={setPicked} />,
              },
              ...(data.accounts.length > 1
                ? [{
                    id: 'all', title: 'All mailboxes by month', kind: 'own' as const, w: 6,
                    children: <AllMailboxesMap accounts={data.accounts} picked={shown!.email} onPick={setPicked} />,
                  }]
                : []),
            ]
          : []),
        ...(data && data.accounts.length
          ? [
              {
                id: 'sync', title: 'Sync', icon: HourglassIcon, kind: 'widget' as const, color: 'teal' as const, w: 6, reads: ['mailbox'],
                children: (f: FilterToken[]) => {
                  const a = followed(data.accounts, f);
                  return <AccountSync key={a.id} id={a.id} sync={a.sync} basin={data.basin} />;
                },
              },
              {
                id: 'map', title: 'By month', kind: 'own' as const, color: 'teal' as const, w: 6, reads: ['mailbox'],
                children: (f: FilterToken[]) => {
                  const a = followed(data.accounts, f);
                  return <AccountCoverageMap key={a.id} id={a.id} email={a.email} basin={data.basin} rate={a.sync.ratePerMin} copying={a.sync.months} />;
                },
              },
              {
                id: 'jobs', title: 'Backfills', icon: ListChecksIcon, kind: 'widget' as const, color: 'teal' as const, w: 6, reads: ['mailbox'],
                children: (f: FilterToken[]) => <Jobs key={followed(data.accounts, f).id} id={followed(data.accounts, f).id} />,
              },
              {
                id: 'limits', title: 'Account limits', icon: GaugeIcon, kind: 'widget' as const, link: false as const, w: 6,
                children: <AccountLimits />,
              },
            ]
          : []),
      ]}
    />
  );
}

/** The status bar's backfill item: how far the copying is, linking to the Backfill page. Hidden with no accounts. */
export function SyncStatus() {
  const { data } = useSync();
  if (!data?.accounts.length) return null;
  const syncs = data.accounts.map((a) => a.sync);
  const total = syncs.reduce((n, s) => n + (s.total ?? 0), 0);
  const copied = syncs.reduce((n, s) => n + s.copied, 0);
  const value = !data.basin
    ? 'Waiting for Basin'
    : syncs.some((s) => s.status === 'stopped')
      ? 'Stopped'
      : syncs.every((s) => s.phase === 'live')
        ? 'Live'
        : syncs.some((s) => s.status === 'running') && total
          ? `${Math.floor((copied / total) * 100)}%`
          : syncs.every((s) => s.phase === null)
            ? 'Not started'
            : syncs.some((s) => s.phase === 'paused')
              ? 'Paused (limit)'
              : 'Not running';
  const ok = !data.basin || syncs.some((s) => s.status === 'stopped') ? false : syncs.every((s) => s.phase === 'live') ? true : null;
  return (
    <Link to="/backfill" className="hover:underline">
      <StatusItem label="Backfill" value={value} ok={ok} />
    </Link>
  );
}
