// Admin ▸ Users: who may use MailCellar. Cloudflare Access proves who someone is; this list
// decides whether they are let in. Admins (ADMIN_EMAILS) always are, and only they see this page.
import { ErrorLine, IntegrationRow, LumenConfirm, LumenLayout } from '@columenlabs/lumen-ui';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@columenlabs/lumen-ui/ui/empty';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import type { AppUser, UsersChange } from '@mailcellar/schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOutIcon, MailIcon, PlusIcon, UserXIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { EmptyState } from './archive';

const ERRORS: Record<string, string> = {
  bad_email: 'That isn’t an email address.',
  already_added: 'Already on the list.',
  is_admin: 'Admins are set on the Worker, not here.',
  forbidden: 'Only admins can change who uses MailCellar.',
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** The API's answer, or its refusal in words. */
async function call<T = AppUser[]>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(ERRORS[(body as { error?: string }).error ?? ''] ?? `Not saved (${res.status})`);
  return body as T;
}

/** What happened to the invite email, in words. */
const inviteNote = (to: string, c: UsersChange) =>
  c.invite === 'sent' ? `Invite sent to ${to}.` : c.invite === 'off' ? `Added. Email isn’t set up, so tell ${to} yourself.` : null;

function AddUser() {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const c = await call<UsersChange>('/api/admin/users', { method: 'POST', body: JSON.stringify({ email }) });
      client.setQueryData(['users'], c.users);
      setNote(inviteNote(email.trim(), c));
      if (c.error) setError(new Error(c.error));
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
          <PlusIcon /> {busy ? 'Adding…' : 'Add and invite'}
        </Button>
      </div>
      <ErrorLine error={error} />
      {note && <p className="text-sm text-gain">{note}</p>}
      <p className="text-xs text-muted-foreground">They get an email with the link. They sign in with Google or an emailed code, using this address.</p>
    </form>
  );
}

/** Send the invite email again, for someone who hasn't signed in yet. */
function Resend({ email }: { email: string }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  return (
    <>
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setNote(null);
          setError(null);
          try {
            const c = await call<UsersChange>(`/api/admin/users/${encodeURIComponent(email)}/invite`, { method: 'POST' });
            client.setQueryData(['users'], c.users);
            setNote(inviteNote(email, c));
            if (c.error) setError(new Error(c.error));
          } catch (err) {
            setError(err as Error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <MailIcon /> {busy ? 'Sending…' : 'Resend invite'}
      </Button>
      {note && <p className="basis-full text-sm text-gain">{note}</p>}
      {error && <div className="basis-full"><ErrorLine error={error} /></div>}
    </>
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
          meta={
            u.admin
              ? 'Admin'
              : u.seenAt
                ? `Added ${day(u.addedAt!)} · last seen ${day(u.seenAt)}`
                : `${u.invitedAt ? `Invited ${day(u.invitedAt)}` : `Added ${day(u.addedAt!)}`} · not signed in yet`
          }
          badge={<Badge variant={u.admin ? 'secondary' : 'outline'}>{u.admin ? 'Admin' : u.seenAt ? 'User' : 'Invited'}</Badge>}
          open={open === u.email}
          onOpenChange={(o: boolean) => setOpen(o ? u.email : null)}
        >
          {u.admin ? (
            <p className="text-sm text-muted-foreground">Admins are set by the ADMIN_EMAILS variable on the Worker. They can always sign in.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">Their mail is theirs alone; admins can’t open it here.</p>
              <div className="flex flex-wrap gap-2">
                {!u.seenAt && <Resend email={u.email} />}
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
        <EmptyState icon={PlusIcon} title="Only admins so far">Add an email above to invite someone.</EmptyState>
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
