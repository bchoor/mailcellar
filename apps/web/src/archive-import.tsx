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
import { Link } from '@tanstack/react-router';
import { ArchiveIcon, FileUpIcon, PauseIcon, PlayIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';

const fmt = (n: number) => n.toLocaleString('en-US');
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const added = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
const minutes = (s: number) => (s < 90 ? 'about a minute' : `about ${Math.round(s / 60)} min`);
const cap = (t: string) => t[0].toUpperCase() + t.slice(1);

const STATUS: Record<NonNullable<ConnectedAccount['archive']>['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  uploading: { label: 'Uploading', variant: 'default' },
  upload_paused: { label: 'Upload paused', variant: 'outline' },
  importing: { label: 'Importing', variant: 'default' },
  done: { label: 'Imported', variant: 'secondary' },
  failed: { label: 'Failed', variant: 'destructive' },
};

/** One archive mailbox in Settings ▸ Accounts: its file, and the upload while it runs. */
export function ArchiveRow({ a, open, onOpenChange }: { a: ConnectedAccount; open: boolean; onOpenChange: (o: boolean) => void }) {
  const x = a.archive!;
  const status = STATUS[x.status];
  const uploading = x.status === 'uploading' || x.status === 'upload_paused';
  const pct = x.bytes ? Math.floor((x.uploaded / x.bytes) * 100) : 0;
  return (
    <IntegrationRow
      name={a.email}
      meta={`mbox archive · ${x.file} · ${gb(x.bytes)} · added ${added(a.addedAt)}`}
      badge={<Badge variant={status.variant}>{status.label}</Badge>}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="flex flex-col gap-3">
        {uploading ? (
          <>
            <div className="grid grid-cols-[1fr_auto] items-center gap-3 text-sm">
              <Progress value={pct} className="h-2" />
              <span className="tabular-nums text-muted-foreground">
                {gb(x.uploaded)} of {gb(x.bytes)} · {pct}%
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {x.status === 'upload_paused'
                ? 'Paused. Resume picks up at the last part sent; choose the same file if this page was closed.'
                : `${x.bytesPerSec ? `${cap(minutes((x.bytes - x.uploaded) / x.bytesPerSec))} left. ` : ''}Keep this page open. If it closes, choose the same file again to carry on.`}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {x.messages === null ? 'Reading the file.' : `${fmt(x.imported)} of ${fmt(x.messages)} messages imported.`}{' '}
            <Link to="/backfill" search={{ mailbox: a.email }} className="underline">
              Open Backfill
            </Link>
          </p>
        )}
        <ErrorLine error={x.error ? new Error(x.error) : null} />
        <div className="flex gap-2">
          {x.status === 'uploading' && (
            <Button variant="outline" size="sm">
              <PauseIcon /> Pause upload
            </Button>
          )}
          {x.status === 'upload_paused' && (
            <Button size="sm">
              <PlayIcon /> Resume upload
            </Button>
          )}
          <LumenConfirm
            title={`Remove ${a.email}?`}
            description="Its mail, raw files and search index are deleted from MailCellar."
            action="Remove"
            busyAction="Removing…"
            onConfirm={async () => {}}
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
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  if (!open)
    return (
      <div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <ArchiveIcon /> Add mbox archive
        </Button>
      </div>
    );
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
      <label className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-5 text-center text-sm hover:bg-muted/50">
        <FileUpIcon className="size-5 text-muted-foreground" />
        {file ? (
          <>
            <span className="font-medium">{file.name}</span>
            <span className="text-muted-foreground">{gb(file.size)} · tap to choose another</span>
          </>
        ) : (
          <>
            <span className="font-medium">Choose an mbox file</span>
            <span className="text-muted-foreground">or drop it here · any size</span>
          </>
        )}
        <input type="file" className="sr-only" onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setFile({ name: f.name, size: f.size });
            // Named after the file until the person types a name.
            setName((n) => n.trim() || f.name.replace(/\.mbox$/i, ''));
          }} />
      </label>
      {file && (
        <p className="text-sm text-muted-foreground">
          Uploads in 64 MB parts, {minutes(file.size / (12 * 1024 ** 2))} on a fast connection. The import starts once it’s up and shows on Backfill.
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={!name.trim() || !file}>
          <PlusIcon /> Upload and import
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
