// Signing in with Google, and Settings ▸ Accounts: the Gmail accounts the archive keeps.
import { ErrorLine, IntegrationRow, KeyTestLine, LumenAuthHeading, LumenAuthProblem, LumenAuthStage, LumenConfirm, TestBadge } from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { AUTH_ERRORS, type AuthError, type Me } from '@mailcellar/schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveIcon, LockIcon, MailIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';

/** Who is signed in: null when nobody is (the API answers 401). */
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

/** The error Google's redirect left in the address, once; it is cleared from the bar. */
function takeAuthError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('auth_error');
  if (!code) return null;
  url.searchParams.delete('auth_error');
  window.history.replaceState(null, '', url);
  return AUTH_ERRORS[code as AuthError] ?? AUTH_ERRORS.google;
}

export function SignInPage() {
  const [problem] = useState(takeAuthError);
  return (
    <LumenAuthStage
      brand={<span className="font-semibold">MailCellar</span>}
      pitch={{ title: 'Your Gmail, kept for good', body: 'MailCellar archives every message on your own Cloudflare account.' }}
      points={[
        { icon: ArchiveIcon, title: 'Keeps everything', body: 'Mail stays here even after you delete it from Gmail.' },
        { icon: LockIcon, title: 'Only you', body: 'Your mail is read only through your own session.' },
      ]}
    >
      <LumenAuthHeading title="Sign in" sub="With the Google account whose mail you want to keep." />
      <LumenAuthProblem>{problem}</LumenAuthProblem>
      <Button asChild className="w-full">
        <a href="/api/auth/login">
          <MailIcon /> Sign in with Google
        </a>
      </Button>
    </LumenAuthStage>
  );
}

const added = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

export function AccountsSettings() {
  const me = useMe();
  const client = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const accounts = me.data?.accounts ?? [];
  return (
    <div className="flex flex-col gap-3">
      <ErrorLine error={me.error} />
      {accounts.length === 0 && !me.isPending && (
        <p className="text-sm text-muted-foreground">No Gmail account is connected. Add one to start archiving.</p>
      )}
      <div>
        {accounts.map((a) => (
          <IntegrationRow
            key={a.id}
            name={a.email}
            meta={`Gmail · added ${added(a.addedAt)} · Read ${a.read ? '✓' : '✗'} · Modify ${a.modify ? '✓' : '✗'}`}
            badge={<TestBadge test={a.test} ok="Connected" />}
            open={open === a.id}
            onOpenChange={(o: boolean) => setOpen(o ? a.id : null)}
          >
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                MailCellar reads this mailbox, and moves a message to Gmail’s Trash only once its copy here is safe.
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
                  description="MailCellar stops syncing it and gives up its Gmail access. Mail already archived stays here."
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
          <a href="/api/auth/login?add=1">
            <PlusIcon /> Add Gmail account
          </a>
        </Button>
      </div>
    </div>
  );
}
