// Mailboxes in the sidebar: each connected Gmail account is a section of its own, holding its
// pages, like Outlook lists each added account. The mailbox a page shows is in its URL (/m/:id/…).
import { type Crumb, NavGroup } from '@columenlabs/lumen-ui';
import type { ConnectedAccount } from '@mailcellar/schema';
import { useParams } from '@tanstack/react-router';
import {
  CalendarClockIcon,
  FilterIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  NewspaperIcon,
  SearchIcon,
  SettingsIcon,
  TagIcon,
  UsersIcon,
} from 'lucide-react';
import { useMe } from './auth';

/** A mailbox's pages, as paths under /m/:id. '' is its Overview. */
export const MAILBOX_PAGES = ['', 'messages', 'senders', 'domains', 'labels', 'time', 'gmail/filters', 'gmail/subscriptions'] as const;

export const mailboxPath = (id: string, page = '') => `/m/${id}${page ? `/${page}` : ''}`;

/** The mailbox the current page shows; null on pages outside a mailbox, or one no longer connected. */
export function useMailbox(): { account: ConnectedAccount | null } {
  const id = useParams({ strict: false, select: (p: { mailbox?: string }) => p.mailbox });
  const accounts = useMe().data?.accounts ?? [];
  return { account: accounts.find((a) => a.id === id) ?? null };
}

/** One section per mailbox, labelled with its address; its header folds it. */
export function MailboxNav() {
  const accounts = useMe().data?.accounts ?? [];
  return (
    <div className="mailbox-nav">
      {accounts.map((a) => {
        const to = (page?: string) => mailboxPath(a.id, page);
        return (
          <NavGroup
            key={a.id}
            label={a.email}
            items={[
              { title: 'Overview', to: to(), icon: LayoutDashboardIcon, exact: true },
              { title: 'Messages', to: to('messages'), icon: SearchIcon },
              { title: 'Senders', to: to('senders'), icon: UsersIcon },
              { title: 'Domains', to: to('domains'), icon: GlobeIcon },
              { title: 'Labels', to: to('labels'), icon: TagIcon },
              { title: 'Time', to: to('time'), icon: CalendarClockIcon },
              // Read live from Gmail; separate from Settings ▸ Accounts, which connects mailboxes.
              {
                title: 'Gmail settings',
                to: to('gmail'),
                icon: SettingsIcon,
                items: [
                  { title: 'Filters', to: to('gmail/filters'), icon: FilterIcon },
                  { title: 'Subscriptions', to: to('gmail/subscriptions'), icon: NewspaperIcon },
                ],
              },
            ]}
          />
        );
      })}
    </div>
  );
}

/** A page's crumbs, led by its mailbox's address (linking to its Overview), so every page says whose mail it shows. */
export function useMailboxCrumbs(...labels: string[]): Crumb[] {
  const { account } = useMailbox();
  const own = labels.map((label) => ({ label }));
  return account ? [{ label: account.email, to: mailboxPath(account.id) }, ...own] : own;
}
