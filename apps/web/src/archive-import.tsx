// Archive mailboxes: mail imported from an mbox file, with no Gmail link and no sync. The file is
// uploaded from the browser in parts straight to raw files (resumable), then a background import
// splits it into messages and writes them like a backfill. Progress shows on the Backfill page.
import { ErrorLine, IntegrationRow, LumenConfirm } from '@columenlabs/lumen-ui';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import { Label } from '@columenlabs/lumen-ui/ui/label';
import { Progress } from '@columenlabs/lumen-ui/ui/progress';
import type { ConnectedAccount } from '@mailcellar/schema';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArchiveIcon, FileUpIcon, PauseIcon, PlayIcon, PlusIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';

const fmt = (n: number) => n.toLocaleString('en-US');
const gb = (bytes: number) => (bytes < 1024 ** 3 ? `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`);
const added = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
const minutes = (s: number) => (s < 90 ? 'about a minute' : `about ${Math.round(s / 60)} min`);
const cap = (t: string) => t[0].toUpperCase() + t.slice(1);

/** Parts sent at once. */
const PARALLEL = 3;

/** An upload running in this tab. It lives outside React so it carries on while Settings is closed. */
interface Upload {
  id: string;
  file: File;
  partSize: number;
  parts: number;
  /** Parts not sent yet; workers take from the front. */
  queue: number[];
  sentBytes: number;
  started: number;
  startBytes: number;
  paused: boolean;
  running: number;
  error: string | null;
}

const uploads = new Map<string, Upload>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function useUpload(id: string): Upload | undefined {
  useSyncExternalStore(subscribe, () => version);
  return uploads.get(id);
}

const partLength = (u: Upload, n: number) => (n < u.parts ? u.partSize : u.file.size - (n - 1) * u.partSize);

async function sendPart(u: Upload, n: number): Promise<void> {
  const start = (n - 1) * u.partSize;
  const blob = u.file.slice(start, start + partLength(u, n));
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`/api/archives/${u.id}/parts/${n}`, { method: 'PUT', body: blob });
      if (res.ok) return;
      // A refusal (wrong length, not uploading) won't change on a retry.
      if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`Part ${n} refused (${res.status})`), { final: true });
      throw new Error(`Part ${n} failed (${res.status})`);
    } catch (e) {
      if ((e as { final?: boolean }).final || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    }
  }
}

/** Send the parts left, then complete the upload, which starts the import. */
function run(u: Upload, done: () => void) {
  u.paused = false;
  u.error = null;
  u.started = Date.now();
  u.startBytes = u.sentBytes;
  emit();
  const worker = async () => {
    u.running++;
    try {
      while (!u.paused && !u.error && u.queue.length) {
        const n = u.queue.shift()!;
        try {
          await sendPart(u, n);
          u.sentBytes += partLength(u, n);
        } catch (e) {
          u.queue.unshift(n);
          u.error = (e as Error).message;
        }
        emit();
      }
    } finally {
      u.running--;
    }
    if (u.running || u.paused || u.error || u.queue.length) return;
    try {
      const res = await fetch(`/api/archives/${u.id}/complete`, { method: 'POST' });
      if (!res.ok) throw new Error(`Upload not finished (${res.status})`);
      uploads.delete(u.id);
    } catch (e) {
      u.error = (e as Error).message;
    }
    emit();
    done();
  };
  for (let i = 0; i < PARALLEL; i++) void worker();
}

/** Pick an upload back up from the server's list of parts sent, with the same file chosen again. */
async function resume(id: string, file: File, done: () => void): Promise<void> {
  const res = await fetch(`/api/archives/${id}/upload`);
  if (!res.ok) throw new Error(`Upload not found (${res.status})`);
  const at = (await res.json()) as { bytes: number; partSize: number; parts: number; sent: number[]; status: string };
  if (at.status !== 'uploading') return done();
  if (file.size !== at.bytes) throw new Error(`That file is ${gb(file.size)}; this upload is ${gb(at.bytes)}. Choose the same file.`);
  const sent = new Set(at.sent);
  const u: Upload = {
    id, file, partSize: at.partSize, parts: at.parts,
    queue: Array.from({ length: at.parts }, (_, i) => i + 1).filter((n) => !sent.has(n)),
    sentBytes: 0, started: Date.now(), startBytes: 0, paused: false, running: 0, error: null,
  };
  u.sentBytes = at.sent.reduce((s, n) => s + partLength(u, n), 0);
  uploads.set(id, u);
  run(u, done);
}

/** A file chooser that also takes a dropped file. */
function FilePick({ file, onFile, prompt }: { file: File | null; onFile: (f: File) => void; prompt: string }) {
  return (
    <label
      className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-5 text-center text-sm hover:bg-muted/50"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <FileUpIcon className="size-5 text-muted-foreground" />
      {file ? (
        <>
          <span className="font-medium">{file.name}</span>
          <span className="text-muted-foreground">{gb(file.size)} · tap to choose another</span>
        </>
      ) : (
        <>
          <span className="font-medium">{prompt}</span>
          <span className="text-muted-foreground">or drop it here · any size</span>
        </>
      )}
      <input
        type="file"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </label>
  );
}

/** One archive mailbox in Settings ▸ Accounts: its file, and the upload while it runs. */
export function ArchiveRow({ a, open, onOpenChange }: { a: ConnectedAccount; open: boolean; onOpenChange: (o: boolean) => void }) {
  const client = useQueryClient();
  const x = a.archive!;
  const u = useUpload(a.id);
  const [problem, setProblem] = useState<Error | null>(null);
  const refresh = () => void client.invalidateQueries({ queryKey: ['me'] });
  const uploading = x.status === 'uploading';
  const paused = uploading && (!u || u.paused || !!u.error);
  const status = uploading
    ? paused ? { label: 'Upload paused', variant: 'outline' as const } : { label: 'Uploading', variant: 'default' as const }
    : x.status === 'importing' ? { label: 'Importing', variant: 'default' as const }
    : x.status === 'done' ? { label: 'Imported', variant: 'secondary' as const }
    : { label: 'Failed', variant: 'destructive' as const };
  const sent = u?.sentBytes ?? 0;
  const pct = x.bytes ? Math.floor((sent / x.bytes) * 100) : 0;
  const rate = u && !u.paused ? (u.sentBytes - u.startBytes) / Math.max(1, (Date.now() - u.started) / 1000) : 0;
  return (
    <IntegrationRow
      name={a.email}
      meta={`mbox archive · ${x.file} · ${gb(x.bytes)} · added ${added(a.addedAt)}`}
      badge={<Badge variant={status.variant}>{status.label}</Badge>}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="flex flex-col gap-3">
        {uploading && u && (
          <>
            <div className="grid grid-cols-[1fr_auto] items-center gap-3 text-sm">
              <Progress value={pct} className="h-2" />
              <span className="tabular-nums text-muted-foreground">
                {gb(sent)} of {gb(x.bytes)} · {pct}%
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {paused
                ? 'Paused. Resume picks up at the last part sent.'
                : `${rate > 0 ? `${cap(minutes((x.bytes - sent) / rate))} left. ` : ''}Keep this page open. If it closes, choose the same file again to carry on.`}
            </p>
          </>
        )}
        {uploading && !u && (
          <FilePick
            file={null}
            prompt={`Choose ${x.file} to carry on`}
            onFile={(f) => {
              setProblem(null);
              resume(a.id, f, refresh).catch((e: Error) => setProblem(e));
            }}
          />
        )}
        {!uploading && (
          <p className="text-sm text-muted-foreground">
            {x.status === 'failed' ? 'The import stopped.' : x.messages === null ? `Reading the file. ${fmt(x.imported)} messages imported so far.` : `${fmt(x.imported)} of ${fmt(x.messages)} messages imported.`}{' '}
            <Link to="/backfill" search={{ mailbox: a.email }} className="underline">
              Open Backfill
            </Link>
          </p>
        )}
        <ErrorLine error={problem ?? (u?.error ? new Error(u.error) : x.error ? new Error(x.error) : null)} />
        <div className="flex gap-2">
          {uploading && u && !paused && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                u.paused = true;
                emit();
              }}
            >
              <PauseIcon /> Pause upload
            </Button>
          )}
          {uploading && u && paused && (
            <Button size="sm" disabled={u.running > 0} onClick={() => run(u, refresh)}>
              <PlayIcon /> Resume upload
            </Button>
          )}
          <LumenConfirm
            title={`Remove ${a.email}?`}
            description={uploading ? 'The upload stops and the parts sent are deleted.' : 'It leaves Settings and stops showing as a mailbox.'}
            action="Remove"
            busyAction="Removing…"
            onConfirm={async () => {
              if (u) {
                u.paused = true;
                uploads.delete(a.id);
                emit();
              }
              const res = await fetch(`/api/accounts/${a.id}`, { method: 'DELETE' });
              if (!res.ok) throw new Error(`Not removed (${res.status})`);
              await client.invalidateQueries({ queryKey: ['me'] });
            }}
          >
            <Button variant="outline" size="sm">
              Remove
            </Button>
          </LumenConfirm>
        </div>
      </div>
    </IntegrationRow>
  );
}

/** Add an mbox archive: a name and the file, then the upload starts. */
export function AddArchive() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Error | null>(null);
  const refresh = () => void client.invalidateQueries({ queryKey: ['me'] });
  if (!open)
    return (
      <div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <ArchiveIcon /> Add mbox archive
        </Button>
      </div>
    );
  const start = async () => {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch('/api/archives', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), file: file.name, bytes: file.size }),
      });
      if (!res.ok) throw new Error(`Not added (${res.status})`);
      const at = (await res.json()) as { id: string; partSize: number; parts: number };
      const u: Upload = {
        id: at.id, file, partSize: at.partSize, parts: at.parts,
        queue: Array.from({ length: at.parts }, (_, i) => i + 1),
        sentBytes: 0, started: Date.now(), startBytes: 0, paused: false, running: 0, error: null,
      };
      uploads.set(at.id, u);
      run(u, refresh);
      await client.invalidateQueries({ queryKey: ['me'] });
      setOpen(false);
      setName('');
      setFile(null);
    } catch (e) {
      setProblem(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ArchiveIcon className="size-4" /> Add mbox archive
      </div>
      <p className="text-sm text-muted-foreground">
        Mail from an mbox file (Apple Mail, Thunderbird, Google Takeout), kept as a mailbox of its own. No Gmail link and no sync.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="archive-name">Name</Label>
        <Input id="archive-name" value={name} placeholder="e.g. Old work mail" onChange={(e) => setName(e.target.value)} />
      </div>
      <FilePick
        file={file}
        prompt="Choose an mbox file"
        onFile={(f) => {
          setFile(f);
          // Named after the file until the person types a name.
          setName((n) => n.trim() || f.name.replace(/\.mbox$/i, ''));
        }}
      />
      {file && (
        <p className="text-sm text-muted-foreground">
          Uploads in 64 MB parts, {minutes(file.size / (12 * 1024 ** 2))} on a fast connection. The import starts once it’s up and shows on Backfill.
        </p>
      )}
      <ErrorLine error={problem} />
      <div className="flex gap-2">
        <Button size="sm" disabled={!name.trim() || !file || busy} onClick={() => void start()}>
          <PlusIcon /> {busy ? 'Starting…' : 'Upload and import'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
