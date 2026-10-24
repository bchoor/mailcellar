// The backfill: each Gmail account's sync (/api/sync), on the Backfill page and in the status bar.
// Everything shown is what the sync state says now; nothing is estimated.
import { ErrorLine, LumenLayout, NoteLine, StatusItem, Tile, TileRow, type ScheduleRun } from '@columenlabs/lumen-ui';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Progress } from '@columenlabs/lumen-ui/ui/progress';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@columenlabs/lumen-ui/ui/dropdown-menu';
import type { SyncOverview, SyncRange, SyncSummary } from '@mailcellar/schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronDownIcon, DatabaseIcon, HourglassIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from './archive';

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

const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Start a sync for one account, over `range` if given. Resolves to what happened, in words. */
async function syncNow(id: string, range?: SyncRange): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`/api/accounts/${id}/sync`, { method: 'POST', body: range ? JSON.stringify({ range }) : undefined });
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
  if (s.phase === 'paused' && s.resumesAt) return `Paused at today's free limit. Resumes ${when(s.resumesAt)}.`;
  if (s.status === 'waiting' && s.resumesAt) return `Trying again ${when(s.resumesAt)}.`;
  if (s.phase === 'live') return s.since ? `Mail since ${day(s.since)} copied. New mail is copied on each sync.` : 'All mail copied. New mail is copied on each sync.';
  if (s.status === 'running') return s.since ? `Copying mail since ${day(s.since)}.` : 'Copying all mail.';
  return 'Not running. Sync now or the next scheduled run continues it.';
}

/** The badge: what the sync is doing now. */
function badge(s: SyncSummary): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  if (s.phase === null) return { label: 'Not started', variant: 'outline' };
  if (s.phase === 'live' && s.status !== 'running') return { label: 'Up to date', variant: 'secondary' };
  return STATUS[s.status];
}

const pct = (s: SyncSummary) => (s.total ? Math.min(100, Math.round((s.copied / s.total) * 1000) / 10) : 0);

function AccountSync({ id, sync: s, basin }: { id: string; sync: SyncSummary; basin: boolean }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const done = s.phase === 'live';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Badge variant={badge(s).variant}>{badge(s).label}</Badge>
          {headline(s) && <span className="text-muted-foreground">{headline(s)}</span>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={busy || !basin || s.status === 'running'}>
              <RefreshCwIcon className={busy ? 'animate-spin' : undefined} /> Sync now <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Copy</DropdownMenuLabel>
            {(
              [
                ['30d', 'Last 30 days'],
                ['all', 'All mail'],
              ] as const
            ).map(([range, label]) => (
              <DropdownMenuItem
                key={range}
                onSelect={async () => {
                  setBusy(true);
                  try {
                    setResult(await syncNow(id, range));
                    await client.invalidateQueries({ queryKey: ['sync'] });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {s.total !== null && (
        <div className="grid grid-cols-[1fr_auto] items-center gap-3 text-sm">
          <Progress value={done ? 100 : pct(s)} className="h-2" />
          <span className="tabular-nums text-muted-foreground">
            {fmt(s.copied)} / {s.since ? 'about ' : ''}{fmt(s.total)} · {done ? 100 : pct(s)}%
          </span>
        </div>
      )}
      {s.phase !== null && (
        <TileRow>
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

export function BackfillPage() {
  const query = useSync();
  const data = query.data;
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
        ...(data?.accounts ?? []).map((a) => ({
          id: a.id, title: a.email, icon: HourglassIcon, kind: 'widget' as const, link: false as const, w: 6,
          children: <AccountSync id={a.id} sync={a.sync} basin={data!.basin} />,
        })),
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
        ? 'Up to date'
        : syncs.some((s) => s.status === 'running') && total
          ? `${Math.floor((copied / total) * 100)}%`
          : syncs.every((s) => s.phase === null)
            ? 'Not started'
            : syncs.some((s) => s.phase === 'paused')
              ? 'Paused'
              : 'Not running';
  const ok = !data.basin || syncs.some((s) => s.status === 'stopped') ? false : syncs.every((s) => s.phase === 'live') ? true : null;
  return (
    <Link to="/backfill" className="hover:underline">
      <StatusItem label="Backfill" value={value} ok={ok} />
    </Link>
  );
}
