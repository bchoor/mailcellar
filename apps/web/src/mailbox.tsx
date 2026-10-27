// The mailbox in the sidebar: its pages under one section. With several mailboxes a picker at the
// top of the section switches between them, keeping the page, rather than repeating every page
// once per mailbox. The mailbox a page shows is in its URL (/m/:id/…).
import { type Crumb, LumenSelector, NavGroup } from '@columenlabs/lumen-ui';
import type { ConnectedAccount } from '@mailcellar/schema';
import { useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { ArchiveIcon, FilterIcon, LayoutDashboardIcon, MailIcon, NewspaperIcon, PanelsTopLeftIcon, SearchIcon, SettingsIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useMe } from './auth';

/** A mailbox's pages, as paths under /m/:id. '' is its Overview. */
export const MAILBOX_PAGES = ['', 'messages', 'panes', 'gmail/filters', 'gmail/subscriptions'] as const;

/** Pages that became a Panes tab; their old addresses open that tab. */
export const PANE_PAGES = ['senders', 'domains', 'labels', 'time'] as const;

export const mailboxPath = (id: string, page = '') => `/m/${id}${page ? `/${page}` : ''}`;

/** The mailbox the current page shows; null on pages outside a mailbox, or one no longer connected. */
export function useMailbox(): { account: ConnectedAccount | null } {
  const id = useParams({ strict: false, select: (p: { mailbox?: string }) => p.mailbox });
  const accounts = useMe().data?.accounts ?? [];
  return { account: accounts.find((a) => a.id === id) ?? null };
}

/** The mailbox last opened, so pages outside a mailbox (Copy mail, Usage) still name one in the sidebar. */
const LAST = 'mailcellar.mailbox';
const remembered = () => {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
};

/** The mailbox's pages as nav items. */
function pagesOf(a: ConnectedAccount) {
  const to = (page?: string) => mailboxPath(a.id, page);
  return [
    { title: 'Overview', to: to(), icon: LayoutDashboardIcon, exact: true },
    { title: 'Messages', to: to('messages'), icon: SearchIcon },
    { title: 'Panes', to: to('panes'), icon: PanelsTopLeftIcon },
    // Read live from Gmail; separate from Settings ▸ Accounts, which connects mailboxes. Archives have no Gmail.
    ...(a.kind === 'archive' ? [] : [{
      title: 'Gmail settings',
      to: to('gmail'),
      icon: SettingsIcon,
      items: [
        { title: 'Filters', to: to('gmail/filters'), icon: FilterIcon },
        { title: 'Subscriptions', to: to('gmail/subscriptions'), icon: NewspaperIcon },
      ],
    }]),
  ];
}

/** The open mailbox's pages; with more than one mailbox, a picker above them switches mailbox on the same page. */
export function MailboxNav() {
  const accounts = useMe().data?.accounts ?? [];
  const { account } = useMailbox();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = account ?? accounts.find((a) => a.id === remembered()) ?? accounts[0];
  useEffect(() => {
    if (!account) return;
    try {
      localStorage.setItem(LAST, account.id);
    } catch {
      // Not kept: the first mailbox shows next time.
    }
  }, [account]);
  if (!current) return null;
  if (accounts.length < 2) return <NavGroup label={current.email} items={pagesOf(current)} />;
  const switchTo = (id: string) => {
    // The same page in the other mailbox; Gmail settings only where it has them.
    const page = account ? (pathname.match(/\/m\/[^/]+\/?(.*)$/)?.[1] ?? '') : '';
    const next = accounts.find((a) => a.id === id);
    navigate({ to: mailboxPath(id, next?.kind === 'archive' && page.startsWith('gmail') ? '' : page) });
  };
  return (
    <div className="mailbox-nav">
      <div className="px-2 pt-2">
        <LumenSelector
          label="Mailbox"
          size="sm"
          className="w-full"
          value={current.id}
          onChange={switchTo}
          options={accounts.map((a) => ({ value: a.id, label: a.email, icon: a.kind === 'archive' ? ArchiveIcon : MailIcon, detail: a.kind === 'archive' ? 'mbox' : 'Gmail' }))}
        />
      </div>
      <NavGroup items={pagesOf(current)} />
    </div>
  );
}

/** A page's crumbs, led by its mailbox's address (linking to its Overview), so every page says whose mail it shows. */
export function useMailboxCrumbs(...labels: string[]): Crumb[] {
  const { account } = useMailbox();
  const own = labels.map((label) => ({ label }));
  return account ? [{ label: account.email, to: mailboxPath(account.id) }, ...own] : own;
}
