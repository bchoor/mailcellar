// Settings ▸ Accounts: the Gmail accounts the archive keeps. Signing in to the app is
// Cloudflare Access's job; the Worker reads the email Access vouches for.
import { ErrorLine, IntegrationRow, KeyTestLine, LumenConfirm, TestBadge, useShell } from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@columenlabs/lumen-ui/ui/empty';
import { AUTH_ERRORS, type AuthError, type Me } from '@mailcellar/schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOutIcon, PlusIcon, RefreshCwIcon, ShieldAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

/** The Access user and their Gmail accounts: null when Access sent no identity (the API answers 401). */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<Me | null> => {
      const res = await fetch('/api/me');
      if (res.status === 401) return null;
      if (!res.ok) throw new Error(`Couldn't load your account (${res.status})`);
      return res.json();
    },
  });
}

/** One query parameter from the address, read once and then cleared from the bar. */
function takeParam(name: string): string | null {
  const url = new URL(window.location.href);
  const value = url.searchParams.get(name);
  if (value === null) return null;
  url.searchParams.delete(name);
  window.history.replaceState(null, '', url);
  return value;
}

/** Coming back from Google lands on `/?settings=accounts`: open Settings there. */
export function SettingsFromUrl() {
  const { openSettings } = useShell();
  useEffect(() => {
    const section = takeParam('settings');
    if (section) openSettings(section);
  }, [openSettings]);
  return null;
}

/** Shown only if Cloudflare Access let a request through without its signed identity. */
export function NoIdentity() {
  return (
    <Empty className="min-h-[50vh]">
      <EmptyHeader>
        <EmptyMedia variant="icon"><ShieldAlertIcon /></EmptyMedia>
        <EmptyTitle>Sign-in didn’t reach MailCellar</EmptyTitle>
        <EmptyDescription>
          Cloudflare Access didn’t pass your sign-in to MailCellar. Reload the page; if it keeps happening, sign out of Access and back in.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => window.location.reload()}><RefreshCwIcon />Reload</Button>
          <Button size="sm" variant="outline" asChild>
            <a href="/cdn-cgi/access/logout"><LogOutIcon />Sign out of Access</a>
          </Button>
        </div>
      </EmptyContent>
    </Empty>
  );
}

/** A green ✓ or a red ✗ for one kind of Gmail access. */
const Mark = ({ ok }: { ok: boolean }) =>
  ok ? <span className="text-gain">✓</span> : <span className="text-loss">✗</span>;

const added = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

export function AccountsSettings() {
  const me = useMe();
  const client = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [problem] = useState(() => {
    const code = takeParam('auth_error');
    return code ? new Error(AUTH_ERRORS[code as AuthError] ?? AUTH_ERRORS.google) : null;
  });
  const accounts = me.data?.accounts ?? [];
  return (
    <div className="flex flex-col gap-3">
      <ErrorLine error={problem ?? me.error} />
      {accounts.length === 0 && !me.isPending && (
        <p className="text-sm text-muted-foreground">No Gmail accounts yet. Add one so MailCellar can start copying its mail.</p>
      )}
      <div>
        {accounts.map((a) => (
          <IntegrationRow
            key={a.id}
            name={a.email}
            meta={`Gmail · added ${added(a.addedAt)} · ${a.modify ? 'Read ✓ · Modify ✓' : 'Read only'}`}
            badge={<TestBadge test={a.test} ok="Connected" />}
            open={open === a.id}
            onOpenChange={(o: boolean) => setOpen(o ? a.id : null)}
          >
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                {a.modify
                  ? 'MailCellar copies all mail from this account, and removes it from Gmail when you archive it.'
                  : 'MailCellar copies all mail from this account.'}
              </p>
              <p className="text-sm">
                Read <Mark ok={a.read} /> · Modify <Mark ok={a.modify} />
                {a.read && !a.modify && <span className="text-muted-foreground"> · Archiving and deleting in Gmail aren’t available.</span>}
              </p>
              <KeyTestLine
                test={a.test}
                run={async () => {
                  const res = await fetch(`/api/accounts/${a.id}/test`, { method: 'POST' });
                  if (!res.ok) throw new Error(`Test failed (${res.status})`);
                  await client.invalidateQueries({ queryKey: ['me'] });
                }}
              />
              <div>
                <LumenConfirm
                  title={`Remove ${a.email}?`}
                  description="MailCellar stops copying mail from this account and gives up its access to it. Mail already copied stays in MailCellar."
                  action="Remove"
                  busyAction="Removing…"
                  onConfirm={async () => {
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
        ))}
      </div>
      <div>
        <Button asChild variant="outline" size="sm">
          <a href="/api/accounts/connect">
            <PlusIcon /> Add Gmail account
          </a>
        </Button>
      </div>
    </div>
  );
}
