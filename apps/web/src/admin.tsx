// Admin ▸ Users: who may use MailCellar. Cloudflare Access proves who someone is; this list
// decides whether they are let in. Admins (ADMIN_EMAILS) always are, and only they see this page.
import { ErrorLine, IntegrationRow, LumenConfirm, LumenLayout } from '@columenlabs/lumen-ui';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@columenlabs/lumen-ui/ui/empty';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import type { AppUser } from '@mailcellar/schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOutIcon, PlusIcon, UserXIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { EmptyState } from './archive';

const ERRORS: Record<string, string> = {
  bad_email: 'That isn’t an email address.',
  already_added: 'Already on the list.',
  is_admin: 'Admins are set on the Worker, not here.',
  forbidden: 'Only admins can change who uses MailCellar.',
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** The list, or the API's refusal in words. */
async function call(path: string, init?: RequestInit): Promise<AppUser[]> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(ERRORS[(body as { error?: string }).error ?? ''] ?? `Not saved (${res.status})`);
  return body as AppUser[];
}

function AddUser() {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      client.setQueryData(['users'], await call('/api/admin/users', { method: 'POST', body: JSON.stringify({ email }) }));
      setEmail('');
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input type="email" required placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="max-w-sm" />
        <Button type="submit" size="sm" disabled={busy || !email.trim()}>
          <PlusIcon /> {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
      <ErrorLine error={error} />
      <p className="text-xs text-muted-foreground">They sign in with Google or an emailed code, using this address.</p>
    </form>
  );
}

function UserList() {
  const client = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => call('/api/admin/users') });
  if (!users.data) return users.error ? <ErrorLine error={users.error} /> : <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div>
      {users.data.map((u) => (
        <IntegrationRow
          key={u.email}
          name={u.email}
          meta={u.admin ? 'Admin' : `Added ${day(u.addedAt!)} · ${u.seenAt ? `last seen ${day(u.seenAt)}` : 'not signed in yet'}`}
          badge={<Badge variant={u.admin ? 'secondary' : 'outline'}>{u.admin ? 'Admin' : 'User'}</Badge>}
          open={open === u.email}
          onOpenChange={(o: boolean) => setOpen(o ? u.email : null)}
        >
          {u.admin ? (
            <p className="text-sm text-muted-foreground">Admins are set by the ADMIN_EMAILS variable on the Worker. They can always sign in.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">Their mail is theirs alone; admins can’t open it here.</p>
              <div>
                <LumenConfirm
                  title={`Remove ${u.email}?`}
                  description="They can’t sign in from the next minute. Their mail stays in MailCellar; adding them again gives it back."
                  action="Remove"
                  busyAction="Removing…"
                  onConfirm={async () => {
                    client.setQueryData(['users'], await call(`/api/admin/users/${encodeURIComponent(u.email)}`, { method: 'DELETE' }));
                  }}
                >
                  <Button variant="outline" size="sm">Remove</Button>
                </LumenConfirm>
              </div>
            </div>
          )}
        </IntegrationRow>
      ))}
      {users.data.every((u) => u.admin) && (
        <EmptyState icon={PlusIcon} title="Only admins so far">Add an email above to let someone in.</EmptyState>
      )}
    </div>
  );
}

export function UsersPage() {
  return (
    <LumenLayout
      crumbs={[{ label: 'Admin' }, { label: 'Users' }]}
      cards={[
        { id: 'add', title: 'Add a user', kind: 'own', w: 6, link: false, children: <AddUser /> },
        { id: 'users', title: 'Who can sign in', kind: 'own', w: 6, link: false, children: <UserList /> },
      ]}
    />
  );
}

/** Signed in with Cloudflare Access, but not on this MailCellar's list. */
export function NotInvited({ email }: { email: string }) {
  return (
    <Empty className="min-h-[50vh]">
      <EmptyHeader>
        <EmptyMedia variant="icon"><UserXIcon /></EmptyMedia>
        <EmptyTitle>You’re not on the list</EmptyTitle>
        <EmptyDescription>
          {email} isn’t allowed in this MailCellar. Ask its admin to add you, or sign out and use another address.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" variant="outline" asChild>
          <a href="/cdn-cgi/access/logout"><LogOutIcon />Sign out</a>
        </Button>
      </EmptyContent>
    </Empty>
  );
}
