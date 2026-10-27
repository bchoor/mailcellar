// The backfill: each Gmail account's sync (/api/sync), on the Backfill page and in the status bar,
// and its coverage map: one line per year, one block per month, from Gmail's exact count for the
// month (the census) and what MailCellar has copied. Pick months there, or select them with a
// preset, then Copy these months; picked queued months can be taken back out.
// Everything shown is what the sync state says now; nothing is estimated.
import {
  ErrorLine, IconButton, LumenCoverageMap, LumenTokenizedFilter, useIsMobile, useLumenFilter, LumenLayout, StatusItem, Tile, TileRow,
  type CoverageData, type CoverageFact, type CoveragePick, type FilterField, type FilterToken, type ScheduleRun,
} from '@columenlabs/lumen-ui';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Progress } from '@columenlabs/lumen-ui/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@columenlabs/lumen-ui/ui/tooltip';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@columenlabs/lumen-ui/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@columenlabs/lumen-ui/ui/toggle-group';
import { addMonths, monthRange, type AccountCoverage, type ActiveJob, type BackfillStatus, type JobRecord, type MonthCoverage, type SyncOverview, type SyncSummary, type AccountStatus, type QuotaMeter, quotaStop } from '@mailcellar/schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { CalendarRangeIcon, MailIcon, HourglassIcon, ListChecksIcon, ListXIcon, Loader2Icon, PauseIcon, PlayIcon, RefreshCwIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { EmptyState } from './archive';
import { useQuota } from './quota';
import { Spark, WithSpark } from './spark';

const fmt = (n: number) => n.toLocaleString('en-US');
const size = (bytes: number) =>
  bytes < 1e6 ? `${fmt(Math.round(bytes / 1e3))} KB` : bytes < 1e9 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e9).toFixed(2)} GB`;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const PT = 'America/Los_Angeles';
/** A time in Pacific: `9:14 AM PT` today, `Oct 25, 9:14 AM PT` another day. */
function pt(iso: string): string {
  const d = new Date(iso);
  const day = (x: Date) => x.toLocaleDateString('en-US', { timeZone: PT });
  const t = d.toLocaleTimeString('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit' });
  return day(d) === day(new Date()) ? `${t} PT` : `${d.toLocaleDateString('en-US', { timeZone: PT, month: 'short', day: 'numeric' })}, ${t} PT`;
}
/** A length of time: `42s`, `2m 13s`, `1h 05m`. */
function took(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}
/** Now, ticking every second while `on`: running jobs' time so far moves without a poll. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** The one query every backfill card and the status bar read; each picks its part with `select`. */
export const BACKFILL_KEY = ['backfill'];

/** Copying, indexing, counting or a job going somewhere: the only time the backfill is polled. */
const busy = (s: BackfillStatus | undefined) =>
  !!s && s.accounts.some((a) => a.running?.length || a.copy.status === 'copying' || a.index.status === 'indexing' || a.census.status === 'counting' || (!s.paused && a.months.some(busyMonth)));
/** A sync job going: it takes seconds to a few minutes, so the page asks more often. */
const syncing = (s: BackfillStatus | undefined) => !!s?.accounts.some((a) => a.running?.some((j) => j.kind === 'sync'));

/**
 * Every mailbox's backfill (GET /api/backfill/status, read from one kept row a mailbox). Polls
 * every 5 seconds while a sync job runs, every 15 while something else copies, indexes or counts,
 * and never while the tab is hidden. Each poll reads the kept rows, not the tables.
 */
const backfillQuery = {
  queryKey: BACKFILL_KEY,
  queryFn: async (): Promise<BackfillStatus> => {
    const res = await fetch('/api/backfill/status');
    if (!res.ok) throw new Error(`Couldn't load the backfill (${res.status})`);
    return res.json();
  },
  refetchInterval: (q: { state: { data?: BackfillStatus } }) => (syncing(q.state.data) ? 5_000 : busy(q.state.data) ? 15_000 : false),
  refetchIntervalInBackground: false,
} as const;

/** Each account's sync, and the backfill's one state. */
export function useSync() {
  return useQuery(backfillQuery);
}

const monthName = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });

const REFUSED: Record<string, string> = {
  paused: 'Backfill is paused',
  not_found: 'This account was removed',
};

/** Start a sync for one account. Resolves to what happened, in words. */
async function syncNow(id: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`/api/accounts/${id}/sync`, { method: 'POST' });
  if (!res.ok) {
    // The Worker names why it refused: paused, or no such account.
    const error = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    return { ok: false, detail: (error && REFUSED[error]) ?? `Not started (${res.status})` };
  }
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
  // The DO write limit is the Indexing panel's to explain.
  if (doHeld(s)) return 'Not copying right now. The next run picks up the queue.';
  if (s.phase === 'waiting' && s.resumesAt && s.pausedFor) return `Waiting for the account's daily limit (${s.pausedFor}). Resumes ${when(s.resumesAt)}.`;
  if (s.phase === 'waiting' && s.resumesAt) return `Waiting for today's free limit to reset. Resumes ${when(s.resumesAt)}.`;
  if (s.status === 'waiting' && s.resumesAt) return `Trying again ${when(s.resumesAt)}.`;
  if (s.phase === 'live') return 'New mail is copied every 6 hours, or when you check. Pick older months on the map.';
  if (s.status === 'running') return s.month ? `Copying ${monthName(s.month)}.` : 'Copying.';
  return 'Not running. Check for new mail, or the next scheduled check, continues it.';
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
const isDoWrites = (name: string | null | undefined, meters: QuotaMeter[]) =>
  name === 'do_rows_written' || meters.some((m) => m.metric === 'do_rows_written' && m.label === name);
export function copyState(o: { paused: boolean; pausedBy: 'person' | 'budget' | null } | undefined, a: AccountStatus | undefined, meters: QuotaMeter[] = []): StageState {
  if (o?.paused && o.pausedBy === 'budget') return { kind: 'budget', label: 'Copying paused: spend cap', detail: 'Stopped at the backfill spend cap. Indexing continues. Resume to go on.' };
  if (o?.paused) return { kind: 'person', label: 'Copying paused by you', detail: 'Nothing copies until you resume. Indexing continues.' };
  const s = a?.sync;
  // The DO write limit holds indexing only; a sync that still names it is not a copy pause.
  if (s?.phase === 'waiting' && !isDoWrites(s.pausedFor, meters)) {
    const why = meterLine(s.pausedFor, meters);
    const until = s.resumesAt ? `Resumes ${resumeTime(s.resumesAt)}.` : '';
    return { kind: 'limit', label: 'Copying waiting: daily limit', detail: why ? `${why}. ${until}`.trim() : until || null };
  }
  if (a?.copy.status === 'copying' || s?.status === 'running') return { kind: 'running', label: 'Copying', detail: null };
  return { kind: 'idle', label: 'Not copying', detail: null };
}
export function indexState(a: AccountStatus | undefined, meters: QuotaMeter[] = []): StageState {
  const held = a?.sync.phase === 'waiting' && isDoWrites(a.sync.pausedFor, meters);
  if (a?.index.status === 'waiting' || held) {
    const why = meterLine(a?.index.pausedFor ?? 'do_rows_written', meters) ?? 'daily DO write limit';
    const until = a?.index.resumesAt ?? (held ? a?.sync.resumesAt : null);
    return { kind: 'limit', label: 'Indexing paused', detail: `${until ? `Until ${resumeTime(until)}` : 'Until the limit resets'} (${why}).` };
  }
  if (a?.index.status === 'indexing') return { kind: 'running', label: 'Indexing', detail: null };
  return { kind: 'idle', label: 'Not indexing', detail: null };
}

/** A sync paused for the DO write limit: that limit holds indexing, not copying. */
const doHeld = (s: SyncSummary) => s.phase === 'waiting' && (s.pausedFor === 'do_rows_written' || /durable object rows written/i.test(s.pausedFor ?? ''));

/** The badge: what the sync is doing now. */
function badge(s: SyncSummary): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  if (s.phase === null) return { label: 'Not started', variant: 'outline' };
  if (s.phase === 'live' && s.status !== 'running') return { label: 'Live', variant: 'secondary' };
  if (s.phase === 'waiting') return { label: doHeld(s) ? 'Indexing waiting' : 'Copying waiting', variant: 'secondary' };
  return STATUS[s.status];
}

/** A wait in words, from minutes. */
const duration = (min: number) =>
  min < 60 ? `about ${Math.max(1, Math.round(min))} min` : min < 48 * 60 ? `about ${Math.round(min / 60)} h` : `about ${Math.round(min / 1440)} days`;
/** Messages Gmail has in a month that can be copied: its count less those Gmail won't give. */
const copyable = (m: MonthCoverage) => (m.gmail === null ? null : m.gmail - (m.unavailable ?? 0));
/** Messages in a month Gmail has and MailCellar hasn't copied yet. */
const left = (m: MonthCoverage) => Math.max(0, (copyable(m) ?? 0) - m.copied);

/** The copy rate over the last 10 minutes, or why there is none. */
function rateTile(s: SyncSummary, state: StageState): { value: string; caption: string } {
  if (state.kind === 'person') return { value: 'Paused', caption: 'by you' };
  if (state.kind === 'budget') return { value: 'Paused', caption: 'spend cap' };
  if (state.kind === 'limit') return { value: 'Paused', caption: s.resumesAt ? `until ${resumeTime(s.resumesAt)}` : 'daily limit' };
  if (s.status === 'stopped') return { value: 'Stopped', caption: 'see the error below' };
  if (s.ratePerMin === null) return { value: '—', caption: s.status === 'running' ? 'measuring' : 'not copying' };
  return { value: `${fmt(Math.round(s.ratePerMin))} / min`, caption: 'last 10 minutes' };
}

/**
 * A mailbox's numbers, the same on every screen: Gmail's count (the census, by month), what
 * MailCellar has of it (a month never counts more than Gmail lists), and what search has (the
 * Messages total, which also keeps mail since deleted in Gmail).
 */
export function mailboxCounts(months: MonthCoverage[]): { gmail: number; copied: number; searchable: number } {
  let gmail = 0;
  let copied = 0;
  let searchable = 0;
  for (const m of months) {
    searchable += m.indexed;
    const n = copyable(m);
    if (n === null) continue;
    gmail += n;
    copied += m.copied;
  }
  // Capped on the total, not by month: Gmail files a few messages near a month's end under the
  // next month, so their dated month runs one over and the next one under.
  return { gmail, copied: Math.min(copied, gmail), searchable };
}

/**
 * Why Searchable differs from copied, in words. Search holds mail Gmail's count leaves out: new
 * since Gmail last counted, Spam and Trash, and mail since deleted in Gmail (MailCellar keeps it).
 * Less: mail still to index.
 */
function searchableNote(c: { copied: number; searchable: number }): string {
  const extra = c.searchable - c.copied;
  if (extra < 0) return `${fmt(-extra)} copied, not yet searchable`;
  if (!extra) return c.copied ? 'all copied mail' : 'nothing copied yet';
  return `${fmt(c.copied)} copied + ${fmt(extra)} not in Gmail's count`;
}

/** Copied of Gmail's count, to a tenth; 100 only when every message is copied. */
const pct = (c: { gmail: number; copied: number }) => (c.gmail ? (c.copied >= c.gmail ? 100 : Math.min(99.9, Math.floor((c.copied / c.gmail) * 1000) / 10)) : 0);

/** A Sync panel's heading: the stage, its state as a badge, and why. */
function StageHead({ title, state, fallback }: { title: string; state: StageState; fallback?: string | null }) {
  const variant = state.kind === 'running' ? 'default' : state.kind === 'idle' ? 'outline' : 'secondary';
  // The heading names the stage, so the badge drops it: Running, Idle, Paused by you.
  const text = { running: 'Running', idle: 'Idle', limit: 'Paused', person: 'Paused by you', budget: 'Paused: spend cap' }[state.kind];
  const line = state.detail ?? fallback;
  return (
    // One line in both groups, so the cards below share a top edge; the whole reason shows on hover.
    <div className="flex h-6 min-w-0 items-center gap-2 overflow-hidden text-sm" title={line ? `${title}: ${text}. ${line}` : `${title}: ${text}`}>
      <span className="shrink-0 font-medium">{title}</span>
      <Badge variant={variant} className="shrink-0">{text}</Badge>
      {line && <span className="min-w-0 truncate text-muted-foreground">{line}</span>}
    </div>
  );
}

const months = (n: number) => `${fmt(n)} month${n === 1 ? '' : 's'}`;

/** What Sync now does, for its tooltip. Matches syncAccount and runBatch in the Worker. */
const SYNC_NOW_HELP = [
  'Copies mail that reached Gmail since the last sync.',
  'Saves each message as a raw file and indexes it in the mailbox.',
  "Makes new mail searchable at once if today's DO writes have room. If not, indexing does it later.",
  'Starts copying queued months, up to 3 at a time. It never queues months.',
  'Skips Spam and Trash.',
  'Does not recount Gmail. That runs every 6 hours.',
  'Restarts a sync that stopped on an error.',
  'Does nothing while backfill is paused, or while a daily limit holds.',
];
function SyncNowHelp() {
  return (
    <div className="flex flex-col gap-1.5 py-1 text-left">
      <span className="font-medium">Check for new mail</span>
      <ul className="flex list-disc flex-col gap-1 pl-4">
        {SYNC_NOW_HELP.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/** A job's name, the same everywhere: new mail (Check for new mail, or the schedule), or older months (a backfill). */
const jobName = (j: { kind: 'sync' | 'backfill'; by: 'you' | 'schedule' | null; label: string }) =>
  j.kind === 'sync' ? (j.by === 'schedule' ? 'New mail (scheduled)' : 'New mail') : `Older months: ${j.label}`;

/** One job going now: what it is, what it is doing, when it started and how long it has run (ticking). */
function RunningJob({ job, now }: { job: ActiveJob; now: number }) {
  const step = job.resumesAt ? `${job.step ?? 'Waiting'} · resumes ${pt(job.resumesAt)}` : job.step ?? 'Working';
  const counts = [
    job.months ? `${fmt(job.months.done)} of ${months(job.months.total)} done${job.months.failed ? `, ${fmt(job.months.failed)} failed` : ''}` : null,
    job.copied ? `${fmt(job.copied)} copied` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div data-job={job.kind} className="flex min-w-0 items-start gap-3 px-3 py-2.5">
      <span aria-hidden className="relative mt-1.5 flex size-2 shrink-0">
        <span className={`absolute inline-flex size-full rounded-full opacity-60 ${job.resumesAt ? '' : 'animate-ping'} bg-[var(--cov-run)]`} />
        <span className="relative inline-flex size-2 rounded-full bg-[var(--cov-run)]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium">{jobName(job)}</span>
          <span className="shrink-0 tabular-nums text-sm">{took(now - Date.parse(job.startedAt))}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground sm:flex-nowrap">
          <span className="min-w-0 sm:truncate">{counts ? `${step} · ${counts}` : step}</span>
          <span className="shrink-0">started {pt(job.startedAt)}</span>
        </div>
      </div>
    </div>
  );
}

/** A finished job in one line: `New mail · done 9:16 AM PT · 34 messages in 1m 12s`. */
function lastJob(r: JobRecord): string {
  const what = jobName(r);
  const result = r.result === 'done' ? 'done' : r.result === 'failed' ? 'failed' : 'stopped';
  return `Last: ${what} · ${result} ${pt(r.endedAt)} · ${fmt(r.copied)} message${r.copied === 1 ? '' : 's'} in ${took(Date.parse(r.endedAt) - Date.parse(r.startedAt))}`;
}

/**
 * What is running now: every job going, ticking each second between polls. Sync now shows here at
 * once (Starting) and stays until the job ends. With nothing going, the last job in one line.
 */
function RunningNow({ jobs, starting, last }: { jobs: ActiveJob[]; starting: boolean; last: JobRecord | undefined }) {
  const now = useNow(jobs.length > 0 || starting);
  if (!jobs.length && !starting)
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        <span className="shrink-0 font-medium text-foreground">Nothing running</span>
        {last && <span className="truncate">{lastJob(last)}</span>}
      </div>
    );
  return (
    <div className="flex flex-col divide-y rounded-md border">
      <div className="flex items-center justify-between px-3 pt-2 text-xs font-medium text-muted-foreground">
        <span>Running now</span>
      </div>
      {starting && !jobs.some((j) => j.kind === 'sync') && (
        <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
          <Loader2Icon className="size-3.5 animate-spin text-[var(--cov-run)]" /> Checking for new mail…
        </div>
      )}
      {jobs.map((j) => (
        <RunningJob key={j.id} job={j} now={now} />
      ))}
    </div>
  );
}

function AccountSync({ id, archive = false, sync: s, copy, index, meters, sizes = [], doHours = [], running = [], last }: { id: string; archive?: boolean; sync: SyncSummary; copy: StageState; index: StageState; meters: QuotaMeter[]; sizes?: AccountStatus['sizes']; doHours?: { at: string; written: number }[]; running?: ActiveJob[]; last?: JobRecord }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const { data: cov } = useQuery(useCoverage(id));
  const counts = mailboxCounts(cov?.months ?? []);
  const queued = cov?.months.filter(busyMonth) ?? [];
  const toCopy = queued.reduce((n, m) => n + left(m), 0);
  const rate = rateTile(s, copy);
  // Copying writes each message's row as it goes; a copied month is then checked against Gmail's list.
  const checking = cov?.months.filter(indexing) ?? [];
  const writes = meters.find((m) => m.metric === 'do_rows_written');
  const reads = meters.find((m) => m.metric === 'do_rows_read');
  // One stage: copying's state, else the check's when it waits for the DO write limit or runs.
  const stage: StageState = copy.kind !== 'idle' ? copy : index.kind === 'limit' ? { ...index, label: 'Paused' } : index.kind === 'running' ? { kind: 'running', label: 'Copying', detail: null } : copy;
  const syncRunning = running.some((j) => j.kind === 'sync');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {counts.gmail ? (
          <div className="grid w-full min-w-0 grid-cols-[1fr_auto] items-center gap-3 text-sm sm:w-auto sm:flex-1">
            <Progress value={pct(counts)} className="h-2" />
            <span className="tabular-nums text-muted-foreground">
              {fmt(counts.copied)} of {fmt(counts.gmail)} {archive ? 'in the file' : 'in Gmail'} · {pct(counts)}%
            </span>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">{headline(s)}</span>
        )}
        {/* The span keeps the tooltip working while the button is disabled. An archive has nothing to sync. */}
        {!archive && <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>
              <Button
              variant="outline"
              size="sm"
              disabled={busy || syncRunning || s.status === 'running'}
              onClick={async () => {
                setBusy(true);
                setResult(null);
                try {
                  setResult(await syncNow(id));
                  await client.invalidateQueries({ queryKey: BACKFILL_KEY });
                } finally {
                  setBusy(false);
                }
              }}
            >
              <RefreshCwIcon className={busy || syncRunning ? 'animate-spin' : undefined} /> {syncRunning ? 'Checking' : 'Check for new mail'}
            </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" className="max-w-xs">
            <SyncNowHelp />
          </TooltipContent>
        </Tooltip>}
        {!archive && (
          <Button variant="outline" size="sm" onClick={() => document.querySelector('[data-month-map]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            <CalendarRangeIcon /> Copy older months
          </Button>
        )}
      </div>
      <RunningNow jobs={running} starting={busy} last={last} />
      {result && !result.ok && <ErrorLine error={new Error(result.detail)} />}
      {s.phase !== null && (
        <div className="flex min-w-0 flex-col gap-3">
          <StageHead
            title={archive ? 'Importing' : 'Copying'}
            state={stage}
            fallback={
              archive && stage.kind === 'idle' ? 'All of the file is imported'
              : checking.length && stage.kind !== 'limit' ? `Checking ${months(checking.length)} against Gmail`
              : stage.kind === 'running' || stage.kind === 'idle' ? headline(s) : null
            }
          />
          <TileRow className="flex-1">
            <Tile className="lg:flex-1" label="Rate" value={rate.value} caption={rate.caption} />
            <Tile
              className="lg:flex-1"
              label={archive ? 'Left to import' : 'Queued to copy'}
              value={fmt(toCopy)}
              caption={!queued.length ? 'nothing queued' : `in ${months(queued.length)}${s.ratePerMin ? ` · ${duration(toCopy / s.ratePerMin).replace('about ', '~')}` : ''}`}
            />
            <Tile className="lg:flex-1" label="Searchable" value={fmt(counts.searchable)} caption={searchableNote(counts)} />
            <Tile
              className="lg:flex-1"
              label="Size"
              value={<WithSpark value={size(s.bytes)} spark={<Spark label="Size over the last hour" points={sizes.map((p) => [Date.parse(p.at), p.bytes])} />} />}
              caption={archive ? 'as the file holds it' : 'as Gmail counts it'}
            />
            <Tile
              className="lg:flex-1"
              label="DO writes today"
              value={
                <WithSpark
                  value={writes ? compact(writes.used) : '—'}
                  spark={doHours.some((h) => h.written) && <Spark label="DO writes each hour, last 24 hours" points={doHours.map((h) => [Date.parse(h.at), h.written])} />}
                />
              }
              caption={reads ? `${compact(reads.used)} reads` : 'not read yet'}
            />
          </TileRow>
        </div>
      )}
      {s.error && <ErrorLine error={new Error(s.error)} />}
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

/**
 * A copied month whose search index is still being checked. The server's index
 * state decides (a month marked indexed is done, whatever its count); counts only without one.
 */
const indexing = (m: MonthCoverage) => (m.indexState !== undefined && m.indexState !== null ? m.indexState !== 'done' : m.landed && m.indexed < m.inBasin);

/** A month's state on the map: Copying while a lane copies it, then Indexing until search has it all. */
function monthState(m: MonthCoverage, copying: string[]): CoverageFact['state'] {
  if (m.state === 'running' || (copying.includes(m.month) && m.state !== 'canceled')) return 'running';
  if (m.state === 'queued' || m.state === 'failed') return m.state;
  if (indexing(m)) return 'indexing';
  // Done, canceled or untouched: it shows by what is copied (a canceled month with nothing is Missing).
  return undefined;
}

/** A backfill error in a few words for the map's tooltip; the Jobs list keeps the full text. */
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
      have: copyable(m) === null ? m.copied : Math.min(m.copied, copyable(m)!),
      expected: copyable(m) ?? 0,
      state: monthState(m, copying),
      note:
        [
          copyable(m) !== null && m.copied < copyable(m)! && m.copied > 0 && !busyMonth(m) ? `${fmt(copyable(m)! - m.copied)} missing` : null,
          m.unavailable ? `${fmt(m.unavailable)} Gmail won't give` : null,
          indexing(m) ? `${fmt(m.indexed)} of ${fmt(m.inBasin)} searchable` : null,
          m.error ? `Failed: ${shortError(m.error)}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
    })),
  rows: [{ row: id, label: email }],
  current: c.current,
});

/** The map's words for its states. */
const STATE_LABELS = { running: 'Copying', indexing: 'Checking', high: 'Almost (95–99%)' } as const;

const busyMonth = (m: MonthCoverage) => m.state === 'queued' || m.state === 'running';

/** The months a preset copies. Months Gmail counted as empty, and months already copied, are left out. */
function presetMonths(c: AccountCoverage, preset: Preset): string[] {
  const by = new Map(c.months.map((m) => [m.month, m]));
  const worth = (month: string) => {
    const m = by.get(month);
    return !m || ((m.gmail === null || copyable(m)! > m.copied) && !busyMonth(m));
  };
  switch (preset) {
    case 'missing':
      return c.months.filter((m) => m.gmail !== null && copyable(m)! > m.copied && !busyMonth(m)).map((m) => m.month);
    case '3m':
      return monthRange(addMonths(c.current, -2), c.current).filter(worth);
    case '12m':
      return monthRange(addMonths(c.current, -11), c.current).filter(worth);
  }
}

type Preset = 'missing' | '3m' | '12m';
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'missing', label: 'All missing' },
  { id: '3m', label: 'Last 3 months' },
  { id: '12m', label: 'Last 12 months' },
];

/** Queue months to copy; resolves to an error in words, or null. */
async function queueBackfill(id: string, months: string[], label: string): Promise<string | null> {
  const res = await fetch(`/api/accounts/${id}/backfill`, { method: 'POST', body: JSON.stringify({ months, label }) });
  if (res.ok) return null;
  const { error } = (await res.json().catch(() => ({}))) as { error?: string };
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
 * One account's coverage map: pick months (tap one, then another for the range; a year; or a quick pick), then
 * Copy these months, or Remove from queue for queued ones. Nothing starts from a pick alone.
 */
function AccountCoverageMap({ id, email, archive = false, rate, copying }: { id: string; email: string; archive?: boolean; rate: number | null; copying: string[] }) {
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
    <div data-month-map className="flex flex-col gap-2">
      <LumenCoverageMap
        source={{ ...backfillQuery, select: (s: BackfillStatus) => facts(id, email, copying)(coverageOf(s, id)) }}
        stateLabels={STATE_LABELS}
        title={`${email} by month`}
        icon={CalendarRangeIcon}
        rows={{ title: 'Year' }}
        layout="months"
        unit="messages"
        summary={['complete', 'counts']}
        // An archive imports the whole file: no months to pick.
        select={!archive ? 'backfill' : undefined}
        selectable={(_row, key) => {
          const m = month(key);
          return !!m && m.gmail !== null && copyable(m)! > m.copied && !busyMonth(m);
        }}
        onQueue={(pick: CoveragePick) => queue(pick.flatMap((p) => p.months))}
        queueLabel="Copy these months"
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
        hint={archive ? 'Months as the file dates its mail. The import covers all of it.' : censusHint(data) ?? 'Pick older months, then Copy these months.'}
        pickTools={archive ? undefined : 
          <span className="flex flex-wrap items-center gap-1.5">
            {PRESETS.map((p) => (
              <Button key={p.id} variant="outline" size="sm" className="h-7 rounded-full" disabled={!data} onClick={() => data && select(presetMonths(data, p.id))}>
                {p.label}
              </Button>
            ))}
            {anyQueued && (
              <Button variant="ghost" size="sm" className="h-7" onClick={() => void unqueue()}>
                <ListXIcon /> Clear queue
              </Button>
            )}
          </span>
        }
        empty={
          <p className="py-6 text-center text-muted-foreground">
            {archive ? 'Reading the file. Months show here as they are found.' : data?.census.status === 'stopped' ? 'Counting stopped. It resumes when you open this page.' : 'Counting Gmail by month. Months show here as they are counted.'}
          </p>
        }
      />
      {error && <ErrorLine error={new Error(error)} />}
    </div>
  );
}

/** Next months shown under All before the rest fold into one line. */
const NEXT_SHOWN = 3;

/**
 * A queue row's stage, its chip's colour and the filter it falls under. Copying writes each
 * message's row as it goes; a copied month is then checked against Gmail's list (Checking),
 * which can wait for the daily DO write limit. All of it is copying: one queue.
 */
type Stage = 'failed' | 'copying' | 'stopping' | 'next' | 'checking' | 'check_waiting';
const STAGES: Record<Stage, { label: string; filter: StageFilter; dot: string }> = {
  failed: { label: 'Failed', filter: 'failed', dot: 'bg-destructive' },
  copying: { label: 'Copying', filter: 'copying', dot: 'bg-[var(--cov-run)]' },
  stopping: { label: 'Stopping', filter: 'copying', dot: 'bg-muted-foreground' },
  checking: { label: 'Checking', filter: 'copying', dot: 'bg-[var(--cov-index)]' },
  check_waiting: { label: 'Waiting', filter: 'copying', dot: 'bg-[var(--cov-index-soft)]' },
  next: { label: 'Next', filter: 'next', dot: 'bg-muted-foreground/50' },
};
type StageFilter = 'all' | 'failed' | 'copying' | 'next' | 'finished';
const FILTERS: { key: StageFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'failed', label: 'Needs attention' },
  { key: 'copying', label: 'Copying' },
  { key: 'next', label: 'Next' },
];

/** The bars' colours, as whole class names so Tailwind finds them. */
const BAR = {
  copy: '[&>[data-slot=progress-indicator]]:bg-[var(--cov-run)]',
  done: '[&>[data-slot=progress-indicator]]:bg-[var(--cov-full)]',
  failed: '[&>[data-slot=progress-indicator]]:bg-destructive',
  index: '[&>[data-slot=progress-indicator]]:bg-[var(--cov-index)]',
} as const;

/** A bar and its count, `588 / 1,176`; a dash when there is nothing to count yet. */
function Meter({ done, total, color }: { done: number; total: number; color: keyof typeof BAR }) {
  if (!total) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Progress value={Math.min(100, (done / total) * 100)} className={`hidden h-1.5 max-w-48 flex-1 sm:block ${BAR[color]}`} />
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
        {fmt(Math.min(done, total))} / {fmt(total)}
      </span>
    </span>
  );
}

type RowAction = { label: string; primary?: boolean; busy?: boolean; disabled?: boolean; run: () => void };

/** One month: its stage, copied of Gmail's count, searchable of copied, time left or why it failed, and its one action. */
function BackfillRow({ m, stage, left, action }: { m: MonthCoverage; stage: Stage; left?: string; action?: RowAction }) {
  const { label, dot } = STAGES[stage];
  return (
    <TableRow className="h-9">
      <TableCell className="tabular-nums font-medium">{monthName(m.month)}</TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />
          {label}
        </span>
      </TableCell>
      <TableCell className="w-[45%]">
        <Meter done={m.copied} total={copyable(m) ?? 0} color={stage === 'failed' ? 'failed' : m.gmail !== null && m.copied >= copyable(m)! ? 'done' : 'copy'} />
      </TableCell>
      <TableCell className={`hidden text-right tabular-nums text-xs sm:table-cell ${stage === 'failed' ? 'text-loss' : 'text-muted-foreground'}`}>{left}</TableCell>
      <TableCell className="w-16 pr-0 text-right sm:w-20">
        {action && (
          <Button variant={action.primary ? 'default' : 'outline'} size="xs" className="w-14 sm:w-16" disabled={action.busy || action.disabled} onClick={action.run}>
            {action.busy ? <Loader2Icon className="animate-spin" /> : action.label}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Finished jobs, newest first: what ran, when, how long it took, what it copied, and how it ended. */
function JobHistory({ history }: { history: JobRecord[] }) {
  if (!history.length) return <p className="text-sm text-muted-foreground">No finished jobs yet. Each sync and backfill shows here when it ends.</p>;
  return (
    <Table className="text-sm">
      <TableHeader>
        <TableRow className="text-xs">
          <TableHead className="sm:w-[34%]">Job</TableHead>
          <TableHead className="hidden sm:table-cell">Started</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Took</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Messages</TableHead>
          <TableHead className="w-24 sm:w-28">Result</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {history.map((r) => (
          <TableRow key={r.id} className="h-9 align-top">
            <TableCell className="max-w-0 py-2">
              <div className="truncate font-medium">{jobName(r)}</div>
              {r.months && (
                <div className="truncate text-xs text-muted-foreground">
                  {months(r.months.total)}: {fmt(r.months.done)} done{r.months.failed ? `, ${fmt(r.months.failed)} failed` : ''}
                </div>
              )}
              <div className="truncate text-xs text-muted-foreground sm:hidden">
                {pt(r.startedAt)} · {took(Date.parse(r.endedAt) - Date.parse(r.startedAt))} · {fmt(r.copied)} msgs
              </div>
            </TableCell>
            <TableCell className="hidden whitespace-nowrap py-2 text-xs text-muted-foreground sm:table-cell">{pt(r.startedAt)}</TableCell>
            <TableCell className="hidden whitespace-nowrap py-2 text-right tabular-nums sm:table-cell">{took(Date.parse(r.endedAt) - Date.parse(r.startedAt))}</TableCell>
            <TableCell className="hidden py-2 text-right tabular-nums sm:table-cell">{fmt(r.copied)}</TableCell>
            <TableCell className="py-2">
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
                <span aria-hidden className={`size-2 shrink-0 rounded-full ${r.result === 'done' ? 'bg-[var(--cov-full)]' : r.result === 'failed' ? 'bg-destructive' : 'bg-muted-foreground'}`} />
                {r.result === 'done' ? 'Done' : r.result === 'failed' ? 'Failed' : 'Stopped'}
              </span>
              {r.error && <div className={`line-clamp-2 text-xs ${r.result === 'failed' ? 'text-loss' : 'text-muted-foreground'}`} title={r.error}>{r.result === 'failed' ? shortError(r.error) : r.error}</div>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * An account's jobs. The queue, by month and filtered by stage: what failed and why (Retry), what
 * is copying now (Stop) or being checked, and what is next (Remove). Progress is in messages; mail
 * already copied stays when a month is taken out. Finished: every job that ended, newest first.
 */
function Jobs({ id, rate, copying, history }: { id: string; rate: number | null; copying: string[]; history: JobRecord[] }) {
  const client = useQueryClient();
  const { data, error } = useQuery(useCoverage(id));
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: BACKFILL_KEY });
  /** The action in flight ('clear', 'pause', or a month), and what the last one did. */
  const [inFlight, setInFlight] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  /** Months stopped here that a lane may still hold; they show Stopping until it lets go. */
  const [stopped, setStopped] = useState<string[]>([]);
  const [filter, setFilter] = useState<StageFilter>('all');
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
        setProblem(res.status === 409 ? 'Held by spend cap: spend is still past the stop line.' : `Not ${to ? 'paused' : 'resumed'} (${res.status})`);
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
  // Copied months still being checked against Gmail's list, or waiting for the DO write limit to be.
  const inCopy = new Set([...held, ...next, ...failed].map((m) => m.month));
  const indexJobs = months.filter((m) => !inCopy.has(m.month) && (m.indexState === 'indexing' || m.indexState === 'waiting' || m.indexState === 'queued' || (!m.indexState && indexing(m))));
  const each = rate && now.length ? rate / now.length : null;
  const rows: { m: MonthCoverage; stage: Stage; left?: string; action?: RowAction }[] = [
    ...failed.map((m) => ({ m, stage: 'failed' as const, left: m.error ? shortError(m.error) : 'Failed', action: { label: 'Retry', primary: true, busy: inFlight === m.month, disabled: inFlight !== null, run: () => void retry(m.month) } })),
    ...now.map((m) => ({ m, stage: 'copying' as const, left: each ? `${duration(left(m) / each)} left` : undefined, action: { label: 'Stop', busy: inFlight === m.month, disabled: inFlight !== null, run: () => void unqueue(m.month, [m.month]) } })),
    ...halting.map((m) => ({ m, stage: 'stopping' as const, action: { label: 'Stop', busy: true, run: () => {} } })),
    ...indexJobs.map((m) => ({
      m,
      stage: (m.indexState === 'waiting' ? 'check_waiting' : 'checking') as Stage,
      left: m.indexState === 'waiting' && m.resumesAt ? `DO limit, until ${resumeTime(m.resumesAt)}` : undefined,
    })),
    ...next.map((m) => ({ m, stage: 'next' as const, action: { label: 'Remove', busy: inFlight === m.month, disabled: inFlight !== null, run: () => void unqueue(m.month, [m.month]) } })),
  ];
  const counts = new Map<StageFilter, number>([['all', rows.length]]);
  for (const r of rows) counts.set(STAGES[r.stage].filter, (counts.get(STAGES[r.stage].filter) ?? 0) + 1);
  counts.set('finished', history.length);
  // A filter whose rows have all gone shows everything again; an empty queue shows what finished.
  const on = filter === 'finished' ? filter : filter !== 'all' && !counts.get(filter) ? 'all' : !rows.length && filter === 'all' && history.length ? 'finished' : filter;
  const picked = on === 'all' ? rows : rows.filter((r) => STAGES[r.stage].filter === on);
  // Under All, the Next queue shows its first few; its filter shows them all.
  const nextRows = picked.filter((r) => r.stage === 'next');
  const folded = on === 'all' ? nextRows.slice(NEXT_SHOWN) : [];
  const shown = picked.filter((r) => !folded.includes(r));
  const chips = (
    <ToggleGroup type="single" variant="outline" size="sm" spacing={1} className="flex-wrap" value={on} onValueChange={(v) => v && setFilter(v as StageFilter)}>
      {FILTERS.filter((f) => counts.get(f.key)).map((f) => (
        <ToggleGroupItem key={f.key} value={f.key} className={`h-7 rounded-full px-3 text-xs ${f.key === 'failed' ? 'text-loss' : ''}`}>
          {f.label} <span className="tabular-nums">{fmt(counts.get(f.key) ?? 0)}</span>
        </ToggleGroupItem>
      ))}
      <ToggleGroupItem value="finished" className="h-7 rounded-full px-3 text-xs">
        Finished <span className="tabular-nums">{fmt(history.length)}</span>
      </ToggleGroupItem>
    </ToggleGroup>
  );
  if (on === 'finished' || (!busy.length && !halting.length && !failed.length && !indexJobs.length))
    return (
      <div className="flex flex-col gap-3 text-sm">
        {said && <span className="text-xs text-gain">{said}</span>}
        {chips}
        {on === 'finished' ? <JobHistory history={history} /> : <p className="text-muted-foreground">Nothing queued to copy. Pick months on the map.{paused ? ' Copying is paused.' : ''}</p>}
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5 text-sm">
          <span>
            <b className="tabular-nums">{fmt(toCopy)}</b> to copy
            {indexJobs.length > 0 && <> · <b className="tabular-nums">{fmt(indexJobs.length)}</b> {indexJobs.length === 1 ? 'month' : 'months'} to check</>}
            {rate && toCopy ? ` · ${duration(toCopy / rate)} at ${fmt(Math.round(rate))} a minute` : ''}
          </span>
          {copy.kind !== 'running' && copy.kind !== 'idle' && (
            <span className="text-xs text-muted-foreground">
              <b className="font-medium text-foreground">{copy.label}</b>
              {copy.detail ? ` ${copy.detail}` : ''}
            </span>
          )}
          {index.kind === 'limit' && <span className="text-xs text-muted-foreground">Checking waits for the daily DO write limit. {index.detail}</span>}
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
      {chips}
      <Table className="text-sm">
        <TableHeader>
          <TableRow className="text-xs">
            <TableHead className="w-24">Month</TableHead>
            <TableHead className="w-32">Stage</TableHead>
            <TableHead>Copied</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Left</TableHead>
            <TableHead className="w-16 sm:w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((r) => (
            <BackfillRow key={r.m.month} {...r} />
          ))}
          {folded.length > 0 && (
            <TableRow className="h-9">
              <TableCell colSpan={5} className="text-xs text-muted-foreground">
                and {fmt(folded.length)} more next: {monthName(folded[0].m.month)}
                {folded.length > 1 ? ` to ${monthName(folded[folded.length - 1].m.month)}` : ''} ·{' '}
                <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={() => setFilter('next')}>
                  Show all
                </Button>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
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

/** The badge in a word or two, to fit beside the mailbox on the map. */
const shortBadge = (s: SyncSummary, kind?: 'gmail' | 'archive') => {
  const b = badge(s);
  const label = b.label.replace(/^(Copying|Indexing) paused$/, 'Paused');
  // An archive never syncs: it imports once, then it's done.
  if (kind === 'archive') return { ...b, label: label === 'Copying' ? 'Importing' : label === 'Live' ? 'Imported' : label };
  return { ...b, label };
};

/**
 * Every mailbox on one map: one row each with its status and last sync, one column per year (or
 * quarter, or month), and how complete each copy is. Tap a row to show that mailbox below.
 */
function MailboxesMap({ accounts }: { accounts: SyncOverview['accounts'] }) {
  // A phone's name column fits the address or the status, not both: it keeps the address.
  const mobile = useIsMobile();
  // The picked mailbox is the card's Mailbox chip: the card's colour shares it with the cards below.
  // A mailbox's name links to this page with ?mailbox=, which picks it.
  const asked = (useSearch({ strict: false }) as { mailbox?: string }).mailbox;
  const filter = useLumenFilter(accounts, MAILBOX_FIELDS, { initial: [{ key: 'mailbox', value: asked ?? accounts[0].email }] });
  const picked = accounts.find((a) => a.email === filter.tokens.find((t) => t.key === 'mailbox')?.value);
  const pick = (email: string) => filter.setTokens([...filter.tokens.filter((t) => t.key !== 'mailbox'), { key: 'mailbox', value: email }]);
  useEffect(() => {
    if (asked && asked !== picked?.email) pick(asked);
  }, [asked]);
  const href = picked ? CSS.escape(`mailbox=${encodeURIComponent(picked.email)}`) : null;
  return (
    <div data-mailboxes className="min-w-0">
      {/* The picked mailbox's name is shaded, like a picked row in a list. */}
      {href && <style>{`[data-mailboxes] span:has(> span > a[href*="${href}"]){background:color-mix(in oklab,var(--color-primary) 10%,transparent);border-radius:6px}[data-mailboxes] a[href*="${href}"]{color:var(--color-primary)}`}</style>}
      <LumenCoverageMap
      source={{
        ...backfillQuery,
        select: (s: BackfillStatus): CoverageData => {
          const all = Object.fromEntries(s.accounts.map((a) => [a.id, a as AccountCoverage]));
          const per = accounts.map((a) => (all[a.id] ? facts(a.id, a.email, a.sync.months)(all[a.id]) : { facts: [], rows: [] }));
          return {
            facts: per.flatMap((p) => p.facts),
            rows: accounts.map((a) => ({
              row: a.id,
              label: a.email,
              badge: mobile ? undefined : <Badge variant={shortBadge(a.sync, a.kind).variant}>{shortBadge(a.sync, a.kind).label}</Badge>,
              sub: a.kind === 'archive' ? 'mbox archive' : freshness(a.sync),
            })),
            current: Object.values(all)[0]?.current,
          };
        },
      }}
      title="Mailboxes"
      stateLabels={STATE_LABELS}
      icon={MailIcon}
      rows={{ title: 'Mailbox', link: (row) => {
        const a = accounts.find((x) => x.id === row);
        return a && { to: '/backfill', search: { mailbox: a.email } };
      } }}
      block="year"
      zoom={['month', 'quarter', 'year']}
      unit="messages"
      summary={['complete']}
      select="drill"
      drilled={null}
      onDrill={(row) => {
        const a = accounts.find((x) => x.id === row);
        if (a) pick(a.email);
      }}
      filter={<LumenTokenizedFilter filter={filter} placeholder="Mailbox" label="Mailbox" />}
      filterCount={filter.tokens.length}
      hint={accounts.length > 1 ? 'Tap a mailbox to show it below.' : undefined}
      />
    </div>
  );
}

const MAILBOX_FIELDS: FilterField<SyncOverview['accounts'][number]>[] = [{ key: 'mailbox', label: 'Mailbox', icon: MailIcon, values: (a) => [a.email] }];

/** The mailbox a card follows: the mailbox chip of its colour, else the first mailbox. */
function followed<A extends { email: string }>(accounts: A[], follows: FilterToken[]): A {
  const email = follows.find((t) => t.key === 'mailbox')?.value;
  return accounts.find((a) => a.email === email) ?? accounts[0];
}

export function BackfillPage() {
  const query = useSync();
  const quota = useQuota();
  const data = query.data;
  const running = data?.accounts.filter((a) => a.sync.status === 'running').length ?? 0;
  return (
    <LumenLayout
      crumbs={[{ label: 'Copy mail' }]}
      meta={data && <Badge variant="secondary">{running ? `${running} copying` : 'Not copying'}</Badge>}
      cards={[
        ...(query.error ? [{ id: 'error', title: 'Copy mail', icon: HourglassIcon, kind: 'widget' as const, link: false as const, w: 6, children: <ErrorLine error={query.error} /> }] : []),
        ...(data && data.accounts.length === 0
          ? [{
              id: 'none', title: 'Copy mail', icon: HourglassIcon, kind: 'widget' as const, link: false as const, w: 6,
              children: (
                <EmptyState icon={HourglassIcon} title="No Gmail accounts">
                  Add one in Settings ▸ Accounts. Its copying shows here.
                </EmptyState>
              ),
            }]
          : []),
        // Tapping a row in Mailboxes picks the mailbox; the cards below show it.
        ...(data && data.accounts.length
          ? [
              {
                // The map's frame takes its link colour by its title, so the card's id is the title.
                id: 'Mailboxes', title: 'Mailboxes', kind: 'own' as const, color: 'teal' as const, w: 6,
                children: <MailboxesMap accounts={data.accounts} />,
              },
              {
                // One card for all copying: new mail (Check for new mail, the schedule) and older
                // months (picked on the map below) run as jobs with one Running now, queue and history.
                id: 'sync', title: 'Copy mail', icon: HourglassIcon, kind: 'widget' as const, color: 'teal' as const, w: 6, reads: ['mailbox'],
                tools: <RefreshTool keys={[BACKFILL_KEY]} />,
                children: (f: FilterToken[]) => {
                  const a = followed(data.accounts, f);
                  return (
                    <div key={a.id} className="flex flex-col gap-5">
                      <AccountSync id={a.id} archive={a.kind === 'archive'} sync={a.sync} copy={copyState(data, a, quota.data?.meters)} index={indexState(a, quota.data?.meters)} meters={quota.data?.meters ?? []} sizes={a.sizes} doHours={quota.data?.doHours} running={a.running} last={a.history?.[0]} />
                      <div className="flex flex-col gap-3 border-t pt-4">
                        <span className="text-sm font-medium">Jobs</span>
                        <Jobs id={a.id} rate={a.sync.ratePerMin} copying={a.sync.months} history={a.history ?? []} />
                      </div>
                    </div>
                  );
                },
              },
              {
                id: 'map', title: 'By month', kind: 'own' as const, color: 'teal' as const, w: 6, reads: ['mailbox'],
                children: (f: FilterToken[]) => {
                  const a = followed(data.accounts, f);
                  return <AccountCoverageMap key={a.id} id={a.id} email={a.email} archive={a.kind === 'archive'} rate={a.sync.ratePerMin} copying={a.sync.months} />;
                },
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
  const { gmail: total, copied } = mailboxCounts(data.accounts.flatMap((a) => a.months));
  const value = data.paused
    ? copyState(data, undefined).label
    : syncs.some((s) => s.status === 'stopped')
      ? 'Stopped'
      : syncs.every((s) => s.phase === 'live')
        ? 'Live'
        : syncs.some((s) => s.status === 'running') && total
          ? `${Math.floor((copied / total) * 100)}%`
          : syncs.every((s) => s.phase === null)
            ? 'Not started'
            : syncs.some((s) => s.phase === 'waiting')
              ? syncs.every((s) => s.phase !== 'waiting' || doHeld(s)) ? 'Indexing waiting' : 'Copying waiting'
              : 'Not running';
  const ok = syncs.some((s) => s.status === 'stopped') ? false : syncs.every((s) => s.phase === 'live') ? true : null;
  return (
    <Link to="/backfill" className="hover:underline">
      <StatusItem label="Copying" value={value} ok={ok} />
    </Link>
  );
}
