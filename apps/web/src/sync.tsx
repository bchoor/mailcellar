// The backfill: each Gmail account's sync (/api/sync), on the Backfill page and in the status bar,
// and its coverage map: one line per year, one block per month, from Gmail's exact count for the
// month (the census) and what MailCellar has copied. Pick months there, or select them with a
// preset, then Start backfill; picked queued months can be taken back out.
// Everything shown is what the sync state says now; nothing is estimated.
import {
  ErrorLine, IconButton, LumenCoverageMap, LumenLayout, NoteLine, StatusItem, Tile, TileRow,
  type CoverageData, type CoverageFact, type CoveragePick, type FilterToken, type ScheduleRun,
} from '@columenlabs/lumen-ui';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Progress } from '@columenlabs/lumen-ui/ui/progress';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@columenlabs/lumen-ui/ui/dropdown-menu';
import { addMonths, monthRange, type AccountCoverage, type BackfillStatus, type MonthCoverage, type SyncOverview, type SyncSummary, type AccountStatus, type QuotaMeter, quotaStop } from '@mailcellar/schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarRangeIcon, ChevronDownIcon, GaugeIcon, MailIcon, DatabaseIcon, HourglassIcon, ListChecksIcon, ListTodoIcon, ListXIcon, Loader2Icon, PauseIcon, PlayIcon, RefreshCwIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { EmptyState } from './archive';
import { AccountLimits, AccountLimitsTools, useQuota } from './quota';

const fmt = (n: number) => n.toLocaleString('en-US');
const size = (bytes: number) =>
  bytes < 1e6 ? `${fmt(Math.round(bytes / 1e3))} KB` : bytes < 1e9 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e9).toFixed(2)} GB`;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The one query every backfill card and the status bar read; each picks its part with `select`. */
export const BACKFILL_KEY = ['backfill'];

/** Copying, indexing or counting somewhere: the only time the backfill is polled. */
const busy = (s: BackfillStatus | undefined) =>
  !!s && s.accounts.some((a) => a.copy.status === 'copying' || a.index.status === 'indexing' || a.census.status === 'counting' || (!s.paused && a.months.some(busyMonth)));

/**
 * Every mailbox's backfill (GET /api/backfill/status, read from one kept row a mailbox). Polls
 * every 15 seconds while something copies, indexes or counts, and never while the tab is hidden.
 */
const backfillQuery = {
  queryKey: BACKFILL_KEY,
  queryFn: async (): Promise<BackfillStatus> => {
    const res = await fetch('/api/backfill/status');
    if (!res.ok) throw new Error(`Couldn't load the backfill (${res.status})`);
    return res.json();
  },
  refetchInterval: (q: { state: { data?: BackfillStatus } }) => (busy(q.state.data) ? 15_000 : false),
  refetchIntervalInBackground: false,
} as const;

/** Each account's sync, and the backfill's one state. */
export function useSync() {
  return useQuery(backfillQuery);
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

/** A time to resume at: `5:00 PM PDT` today, `Oct 25, 5:00 PM PDT` another day. */
function resumeTime(iso: string): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${t}`;
}

/**
 * Copying and indexing each have one state, and every card reads it, so none disagree. Copying
 * pauses only for the person, the spend cap, or a daily limit other than DO writes. The DO write
 * limit pauses indexing alone: copying goes on.
 */
export interface StageState {
  kind: 'person' | 'budget' | 'limit' | 'running' | 'idle';
  /** Short, for a badge: "Copying", "Indexing paused". */
  label: string;
  /** One line on why and when it resumes. */
  detail: string | null;
}
const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : fmt(n);
/** A daily limit's use against where backfill stops for it: "DO rows written 89.7k of 97.5k". */
function meterLine(name: string | null | undefined, meters: QuotaMeter[]): string | null {
  const m = meters.find((x) => x.label === name || x.metric === name);
  return m ? `${m.label} ${compact(m.used)} of ${compact(m.limit * quotaStop(m.metric))}` : null;
}
export function copyState(o: { paused: boolean; pausedBy: 'person' | 'budget' | null } | undefined, a: AccountStatus | undefined, meters: QuotaMeter[] = []): StageState {
  if (o?.paused && o.pausedBy === 'budget') return { kind: 'budget', label: 'Copying paused: spend cap', detail: 'Stopped at the backfill spend cap. Resume to go on.' };
  if (o?.paused) return { kind: 'person', label: 'Copying paused by you', detail: 'Nothing copies until you resume.' };
  const s = a?.sync;
  if (s?.phase === 'paused') {
    const why = meterLine(s.pausedFor, meters);
    const until = s.resumesAt ? `Resumes ${resumeTime(s.resumesAt)}.` : '';
    return { kind: 'limit', label: 'Copying paused: daily limit', detail: why ? `${why}. ${until}`.trim() : until || null };
  }
  if (a?.copy.status === 'copying' || s?.status === 'running') return { kind: 'running', label: 'Copying', detail: null };
  return { kind: 'idle', label: 'Not copying', detail: null };
}
export function indexState(a: AccountStatus | undefined, meters: QuotaMeter[] = []): StageState {
  if (a?.index.status === 'waiting') {
    const why = meterLine(a.index.pausedFor ?? 'do_rows_written', meters) ?? 'daily DO write limit';
    return { kind: 'limit', label: 'Indexing paused', detail: `${a.index.resumesAt ? `Until ${resumeTime(a.index.resumesAt)}` : 'Until the limit resets'} (${why}).` };
  }
  if (a?.index.status === 'indexing') return { kind: 'running', label: 'Indexing', detail: null };
  return { kind: 'idle', label: 'Not indexing', detail: null };
}

/** The badge: what the sync is doing now. */
function badge(s: SyncSummary): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  if (s.phase === null) return { label: 'Not started', variant: 'outline' };
  if (s.phase === 'live' && s.status !== 'running') return { label: 'Live', variant: 'secondary' };
  if (s.phase === 'paused') return { label: 'Copying paused', variant: 'secondary' };
  return STATUS[s.status];
}

/** A wait in words, from minutes. */
const duration = (min: number) =>
  min < 60 ? `about ${Math.max(1, Math.round(min))} min` : min < 48 * 60 ? `about ${Math.round(min / 60)} h` : `about ${Math.round(min / 1440)} days`;
/** Messages in a month Gmail has and MailCellar hasn't copied yet. */
const left = (m: MonthCoverage) => Math.max(0, (m.gmail ?? 0) - m.copied);

/** The copy rate over the last 10 minutes, or why there is none. */
function rateTile(s: SyncSummary, state: StageState): { value: string; caption: string } {
  if (state.kind === 'person') return { value: 'Paused', caption: 'by you' };
  if (state.kind === 'budget') return { value: 'Paused', caption: 'spend cap' };
  if (state.kind === 'limit') return { value: 'Paused', caption: s.resumesAt ? `until ${resumeTime(s.resumesAt)}` : 'daily limit' };
  if (s.status === 'stopped') return { value: 'Stopped', caption: 'see the error below' };
  if (s.ratePerMin === null) return { value: '—', caption: s.status === 'running' ? 'measuring' : 'not copying' };
  return { value: `${fmt(Math.round(s.ratePerMin))} / min`, caption: 'last 10 minutes' };
}

const pct = (s: SyncSummary) => (s.total ? Math.min(100, Math.round((s.copied / s.total) * 1000) / 10) : 0);

/** A Sync panel's heading: the stage, its state as a badge, and why. */
function StageHead({ title, state, fallback }: { title: string; state: StageState; fallback?: string | null }) {
  const variant = state.kind === 'running' ? 'default' : state.kind === 'idle' ? 'outline' : 'secondary';
  // The heading names the stage, so the badge drops it: Running, Idle, Paused by you.
  const text = { running: 'Running', idle: 'Idle', limit: 'Paused', person: 'Paused by you', budget: 'Paused: spend cap' }[state.kind];
  const line = state.detail ?? fallback;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">{title}</span>
      <Badge variant={variant}>{text}</Badge>
      {line && <span className="text-muted-foreground">{line}</span>}
    </div>
  );
}

const months = (n: number) => `${fmt(n)} month${n === 1 ? '' : 's'}`;

function AccountSync({ id, sync: s, basin, copy, index, meters }: { id: string; sync: SyncSummary; basin: boolean; copy: StageState; index: StageState; meters: QuotaMeter[] }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const { data: cov } = useQuery(useCoverage(id));
  const queued = cov?.months.filter(busyMonth) ?? [];
  const toCopy = queued.reduce((n, m) => n + left(m), 0);
  const rate = rateTile(s, copy);
  // Copied to Basin and not yet searchable: what indexing has left.
  const inBasin = cov?.months.reduce((n, m) => n + m.inBasin, 0) ?? 0;
  const indexed = cov?.months.reduce((n, m) => n + Math.min(m.indexed, m.inBasin), 0) ?? 0;
  const toIndex = cov?.months.filter(indexing) ?? [];
  const unindexed = toIndex.reduce((n, m) => n + m.inBasin - m.indexed, 0);
  const writes = meters.find((m) => m.metric === 'do_rows_written');
  const reads = meters.find((m) => m.metric === 'do_rows_read');
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {s.total !== null ? (
          <div className="grid w-full min-w-0 grid-cols-[1fr_auto] items-center gap-3 text-sm sm:w-auto sm:flex-1">
            <Progress value={pct(s)} className="h-2" />
            <span className="tabular-nums text-muted-foreground">
              {fmt(s.copied)} of {fmt(s.total)} in Gmail · {pct(s)}%
            </span>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">{headline(s)}</span>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !basin || s.status === 'running'}
          onClick={async () => {
            setBusy(true);
            try {
              setResult(await syncNow(id));
              await client.invalidateQueries({ queryKey: BACKFILL_KEY });
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCwIcon className={busy ? 'animate-spin' : undefined} /> Sync now
        </Button>
      </div>
      {/* Copying and Indexing side by side: six cards on one row on desktop. */}
      <div className="grid gap-4 lg:grid-cols-2">
        {s.phase !== null && (
          <div className="flex min-w-0 flex-col gap-3">
            <StageHead title="Copying" state={copy} fallback={copy.kind === 'running' || copy.kind === 'idle' ? headline(s) : null} />
            <TileRow>
              <Tile className="lg:flex-1" label="Rate" value={rate.value} caption={rate.caption} />
              <Tile
                className="lg:flex-1"
                label="Queued to copy"
                value={fmt(toCopy)}
                caption={!queued.length ? 'nothing queued' : `in ${months(queued.length)}${s.ratePerMin ? ` · ${duration(toCopy / s.ratePerMin).replace('about ', '~')}` : ''}`}
              />
              <Tile className="lg:flex-1" label="Size" value={size(s.bytes)} caption="as Gmail counts it" />
            </TileRow>
          </div>
        )}
        {inBasin > 0 && (
          <div className="flex min-w-0 flex-col gap-3">
            <StageHead title="Indexing" state={index} />
            <TileRow>
              <Tile className="lg:flex-1" label="Searchable" value={`${Math.floor((indexed / inBasin) * 1000) / 10}%`} caption={`${fmt(indexed)} of ${fmt(inBasin)}`} />
              <Tile className="lg:flex-1" label="Queued for indexing" value={fmt(unindexed)} caption={toIndex.length ? `in ${months(toIndex.length)}` : 'nothing queued'} />
              <Tile
                className="lg:flex-1"
                label="DO I/O today"
                value={writes ? `${compact(writes.used)} writes` : '—'}
                caption={reads ? `${compact(reads.used)} reads` : 'not read yet'}
              />
            </TileRow>
          </div>
        )}
      </div>
      {s.error && <ErrorLine error={new Error(s.error)} />}
      {result && !result.ok && <ErrorLine error={new Error(result.detail)} />}
    </div>
  );
}

/** One account's coverage, from the backfill query. */
const coverageOf = (s: BackfillStatus, id: string): AccountCoverage =>
  s.accounts.find((a) => a.id === id) ?? { months: [], census: { status: 'not_started', month: null, finishedAt: null, error: null }, current: '' };

/** An account's coverage: the backfill query, narrowed to the account. */
function useCoverage(id: string) {
  return { ...backfillQuery, select: (s: BackfillStatus) => coverageOf(s, id) };
}

/** A month copied to Basin whose search index is still being built from it. */
const indexing = (m: MonthCoverage) => m.landed && m.indexed < m.inBasin;

/** A month's state on the map: Copying while a lane copies it, then Indexing until search has it all. */
function monthState(m: MonthCoverage, copying: string[]): CoverageFact['state'] {
  if (m.state === 'running' || (copying.includes(m.month) && m.state !== 'canceled')) return 'running';
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
      note: [indexing(m) ? `${fmt(m.indexed)} of ${fmt(m.inBasin)} searchable` : null, m.error ? `Failed: ${shortError(m.error)}` : null].filter(Boolean).join(' · ') || undefined,
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
  if (res.ok) return null;
  const { error } = (await res.json().catch(() => ({}))) as { error?: string };
  if (error === 'basin_not_ready') return 'Waiting for Basin write access';
  return `Not queued (${error ?? res.status})`;
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
  const refresh = () => client.invalidateQueries({ queryKey: BACKFILL_KEY });
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
  const anyQueued = !!data?.months.some((m) => busyMonth(m) || m.state === 'failed');
  return (
    <div className="flex flex-col gap-2">
      <LumenCoverageMap
        source={{ ...backfillQuery, select: (s: BackfillStatus) => facts(id, email, copying)(coverageOf(s, id)) }}
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

/** Months in the Next section before the rest fold into one line. */
const NEXT_SHOWN = 3;

/** One month's row: its bar and messages copied, why it failed, and its one action. */
function BackfillRow({ m, note, action, count }: { m: MonthCoverage; note?: string; action?: { label: string; primary?: boolean; busy?: boolean; disabled?: boolean; run: () => void }; count?: { done: number; total: number; noun: string } }) {
  // Copied of Gmail's count, unless the row counts something else (searchable of copied).
  const { done, total, noun } = count ?? { done: m.copied, total: m.gmail ?? 0, noun: 'messages' };
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  return (
    <li className="grid grid-cols-[5.5rem_minmax(0,1fr)_5.5rem] items-center gap-3 py-2 text-sm">
      <span className="tabular-nums">{monthName(m.month)}</span>
      <span className="flex min-w-0 flex-col gap-1">
        <Progress value={pct} className="h-1.5" />
        <span className="tabular-nums text-xs text-muted-foreground">
          {fmt(done)} of {fmt(total)} {noun}
          {note && <> · <span className={m.error ? 'text-loss' : undefined}>{note}</span></>}
        </span>
      </span>
      {action ? (
        <Button variant={action.primary ? 'default' : 'outline'} size="sm" className="w-full" disabled={action.busy || action.disabled} onClick={action.run}>
          {action.busy ? <Loader2Icon className="animate-spin" /> : action.label}
        </Button>
      ) : (
        <span />
      )}
    </li>
  );
}

function BackfillSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="flex gap-2 text-xs font-medium text-muted-foreground">
        {title} <span className="tabular-nums">{fmt(count)}</span>
      </h3>
      <ul className="flex flex-col divide-y">{children}</ul>
    </section>
  );
}

/**
 * An account's backfill by month: what failed and why (Retry), what is copying now (Stop), and
 * what is next (Remove). Progress is in messages. Mail already copied stays when a month is taken out.
 */
function Backfills({ id, rate, copying }: { id: string; rate: number | null; copying: string[] }) {
  const client = useQueryClient();
  const { data, error } = useQuery(useCoverage(id));
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: BACKFILL_KEY });
  /** The action in flight ('clear', 'pause', or a month), and what the last one did. */
  const [inFlight, setInFlight] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  /** Months stopped here that a lane may still hold; they show Stopping until it lets go. */
  const [stopped, setStopped] = useState<string[]>([]);
  const act = async (key: string, fn: () => Promise<string | null>) => {
    setInFlight(key);
    setSaid(null);
    try {
      setSaid(await fn());
    } finally {
      setInFlight(null);
    }
  };
  const unqueue = (key: string, months?: string[]) =>
    act(key, async () => {
      const res = await fetch(`/api/accounts/${id}/backfill/cancel`, { method: 'POST', body: JSON.stringify(months ? { months } : {}) });
      setProblem(res.ok ? null : `Not removed (${res.status})`);
      await refresh();
      if (!res.ok) return null;
      const { changed } = (await res.json()) as { changed: number };
      setStopped((s) => [...s, ...(months ?? copying)]);
      return months ? `${monthName(months[0])} taken out. Copied mail stays.` : `${fmt(changed)} month${changed === 1 ? '' : 's'} cleared. Copied mail stays.`;
    });
  const sync = useSync();
  const paused = !!sync.data?.paused;
  const quota = useQuota();
  const account = sync.data?.accounts.find((a) => a.id === id);
  const copy = copyState(sync.data, account, quota.data?.meters);
  const index = indexState(account, quota.data?.meters);
  /** Pause or resume all backfill; nothing copies while paused. */
  const setPaused = (to: boolean) =>
    act('pause', async () => {
      const res = await fetch('/api/backfill/paused', { method: 'PUT', body: JSON.stringify({ paused: to }) });
      if (!res.ok) {
        setProblem(`Not ${to ? 'paused' : 'resumed'} (${res.status})`);
        return null;
      }
      setProblem(null);
      await res.json();
      await refresh();
      return to ? 'Paused. Nothing new starts until you resume.' : 'Resumed. Queued months start copying.';
    });
  const retry = (month: string) =>
    act(month, async () => {
      const failed = await queueBackfill(id, [month], 'Retry');
      setProblem(failed);
      await refresh();
      return failed ? null : `${monthName(month)} queued again.${paused ? ' It starts when you resume.' : ''}`;
    });
  if (error) return <ErrorLine error={error} />;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  // Newest first, as the backfill copies them.
  const months = [...data.months].sort((a, b) => b.month.localeCompare(a.month));
  // A stopped month leaves Copying now once its lane lets go; until then it shows Stopping.
  const stopping = (m: MonthCoverage) => m.state === 'canceled' || stopped.includes(m.month);
  const held = months.filter((m) => copying.includes(m.month) || m.state === 'running');
  const now = held.filter((m) => !stopping(m));
  const halting = held.filter(stopping);
  // Forget a stop once its lane let go, so the month can be queued and copied again.
  const gone = stopped.filter((s) => !held.some((m) => m.month === s));
  if (gone.length) setStopped((s) => s.filter((x) => !gone.includes(x)));
  const next = months.filter((m) => m.state === 'queued' && !copying.includes(m.month));
  const failed = months.filter((m) => m.state === 'failed');
  const busy = [...now, ...next];
  const toCopy = busy.reduce((n, m) => n + left(m), 0);
  // Months copied to Basin whose search index is queued, building, or waiting for the DO write limit.
  const indexJobs = months.filter((m) => m.indexState === 'indexing' || m.indexState === 'waiting' || m.indexState === 'queued' || (!m.indexState && indexing(m)));
  const indexSection = indexJobs.length > 0 && (
    <BackfillSection title="Indexing" count={indexJobs.length}>
      {index.kind === 'limit' && <li className="py-2 text-xs text-muted-foreground">Indexing paused. {index.detail}</li>}
      {indexJobs.map((m) => (
        <BackfillRow key={m.month} m={m} count={{ done: Math.min(m.indexed, m.inBasin), total: m.inBasin, noun: 'searchable' }} note={m.indexState === 'waiting' ? 'waiting for limit' : m.indexState === 'queued' ? 'queued' : 'indexing'} />
      ))}
    </BackfillSection>
  );
  if (!busy.length && !halting.length && !failed.length)
    return (
      <div className="flex flex-col gap-1 text-sm">
        {said && <span className="text-xs text-gain">{said}</span>}
        <p className="text-muted-foreground">Nothing queued to copy. Pick months on the map, or use Select months.{paused ? ' Copying is paused.' : ''}</p>
        {indexSection}
      </div>
    );
  const each = rate && now.length ? rate / now.length : null;
  const rest = next.slice(NEXT_SHOWN);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5 text-sm">
          <span>
            <b className="tabular-nums">{fmt(toCopy)}</b> messages left in <b className="tabular-nums">{fmt(busy.length)}</b> month{busy.length === 1 ? '' : 's'}
            {rate && toCopy ? ` · ${duration(toCopy / rate)} at ${fmt(Math.round(rate))} a minute` : ''}
          </span>
          <span className="text-xs text-muted-foreground">
            {copy.kind === 'running' || copy.kind === 'idle' ? `Copying ${fmt(now.length)} at once` : <b className="font-medium text-foreground">{copy.label}</b>} · {fmt(next.length)} waiting
            {failed.length > 0 && <> · <span className="text-loss">{fmt(failed.length)} failed</span></>}
          </span>
          {copy.detail && <span className="text-xs text-muted-foreground">{copy.detail}</span>}
          {index.kind === 'limit' && <span className="text-xs text-muted-foreground">Indexing paused. {index.detail} Copying goes on.</span>}
          {said && <span className="text-xs text-gain">{said}</span>}
        </div>
        <span className="flex gap-2">
          {copy.kind === 'limit' ? (
            // Copying paused by a daily limit: it resumes by itself; a click can't lift the limit.
            <Button variant="outline" size="sm" disabled title={copy.detail ?? undefined}>
              <PauseIcon /> {account?.sync.resumesAt ? `Resumes ${resumeTime(account.sync.resumesAt)}` : 'Paused for limit'}
            </Button>
          ) : (
            <Button variant={paused ? 'default' : 'outline'} size="sm" disabled={!sync.data || inFlight !== null} onClick={() => void setPaused(!paused)}>
              {inFlight === 'pause' ? <Loader2Icon className="animate-spin" /> : paused ? <PlayIcon /> : <PauseIcon />} {paused ? 'Resume' : 'Pause'}
            </Button>
          )}
          {busy.length + failed.length > 0 && (
            <Button variant="outline" size="sm" disabled={inFlight !== null} onClick={() => void unqueue('clear')}>
              {inFlight === 'clear' ? <Loader2Icon className="animate-spin" /> : <ListXIcon />} Clear queue
            </Button>
          )}
        </span>
      </div>
      {failed.length > 0 && (
        <BackfillSection title="Needs attention" count={failed.length}>
          {failed.map((m) => (
            <BackfillRow key={m.month} m={m} note={m.error ? shortError(m.error) : 'Failed'} action={{ label: 'Retry', primary: true, busy: inFlight === m.month, disabled: inFlight !== null, run: () => void retry(m.month) }} />
          ))}
        </BackfillSection>
      )}
      {held.length > 0 && (
        <BackfillSection title="Copying now" count={now.length}>
          {now.map((m) => (
            <BackfillRow key={m.month} m={m} note={each ? `${duration(left(m) / each)} left` : undefined} action={{ label: 'Stop', busy: inFlight === m.month, disabled: inFlight !== null, run: () => void unqueue(m.month, [m.month]) }} />
          ))}
          {halting.map((m) => (
            <BackfillRow key={m.month} m={m} note="Stopping…" action={{ label: 'Stop', busy: true, run: () => {} }} />
          ))}
        </BackfillSection>
      )}
      {next.length > 0 && (
        <BackfillSection title="Next" count={next.length}>
          {next.slice(0, NEXT_SHOWN).map((m) => (
            <BackfillRow key={m.month} m={m} action={{ label: 'Remove', busy: inFlight === m.month, disabled: inFlight !== null, run: () => void unqueue(m.month, [m.month]) }} />
          ))}
          {rest.length > 0 && (
            <li className="py-2 text-xs text-muted-foreground">
              and {fmt(rest.length)} more: {monthName(rest[0].month)}
              {rest.length > 1 ? ` to ${monthName(rest[rest.length - 1].month)}` : ''}
            </li>
          )}
        </BackfillSection>
      )}
      {indexSection}
      {problem && <ErrorLine error={new Error(problem)} />}
    </div>
  );
}

/** A card's Refresh: reads its queries again now, spinning until they answer. */
function RefreshTool({ keys }: { keys: string[][] }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <IconButton
      icon={RefreshCwIcon}
      label="Refresh"
      busy={busy}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await Promise.all(keys.map((queryKey) => client.refetchQueries({ queryKey })));
        } finally {
          setBusy(false);
        }
      }}
    />
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
  const source = backfillQuery;
  return (
    <div className="flex flex-col gap-2">
      <LumenCoverageMap
        source={{
          ...source,
          select: (s: BackfillStatus): CoverageData => {
            const all = Object.fromEntries(s.accounts.map((a) => [a.id, a as AccountCoverage]));
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
function followed<A extends { email: string }>(accounts: A[], follows: FilterToken[]): A {
  const email = follows.find((t) => t.key === 'mailbox')?.value;
  return accounts.find((a) => a.email === email) ?? accounts[0];
}

export function BackfillPage() {
  const query = useSync();
  const quota = useQuota();
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
                tools: <RefreshTool keys={[BACKFILL_KEY]} />,
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
                tools: <RefreshTool keys={[BACKFILL_KEY]} />,
                children: (f: FilterToken[]) => {
                  const a = followed(data.accounts, f);
                  return <AccountSync key={a.id} id={a.id} sync={a.sync} basin={data.basin} copy={copyState(data, a, quota.data?.meters)} index={indexState(a, quota.data?.meters)} meters={quota.data?.meters ?? []} />;
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
                tools: <RefreshTool keys={[BACKFILL_KEY]} />,
                children: (f: FilterToken[]) => {
                  const a = followed(data.accounts, f);
                  return <Backfills key={a.id} id={a.id} rate={a.sync.ratePerMin} copying={a.sync.months} />;
                },
              },
              {
                id: 'limits', title: 'Account limits', icon: GaugeIcon, kind: 'widget' as const, link: false as const, w: 6,
                tools: <AccountLimitsTools />,
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
    : data.paused
      ? copyState(data, undefined).label
    : syncs.some((s) => s.status === 'stopped')
      ? 'Stopped'
      : syncs.every((s) => s.phase === 'live')
        ? 'Live'
        : syncs.some((s) => s.status === 'running') && total
          ? `${Math.floor((copied / total) * 100)}%`
          : syncs.every((s) => s.phase === null)
            ? 'Not started'
            : syncs.some((s) => s.phase === 'paused')
              ? 'Copying paused'
              : 'Not running';
  const ok = !data.basin || syncs.some((s) => s.status === 'stopped') ? false : syncs.every((s) => s.phase === 'live') ? true : null;
  return (
    <Link to="/backfill" className="hover:underline">
      <StatusItem label="Backfill" value={value} ok={ok} />
    </Link>
  );
}
