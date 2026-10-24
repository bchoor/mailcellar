import {
  LumenShell,
  NavGroup,
  SchedulesSection,
  type ScheduleItem,
  type ScheduleRun,
} from '@columenlabs/lumen-ui';
import { useSidebar } from '@columenlabs/lumen-ui/ui/sidebar';
import { TooltipProvider } from '@columenlabs/lumen-ui/ui/tooltip';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useLocation,
} from '@tanstack/react-router';
import {
  CalendarClockIcon,
  FilterIcon,
  GaugeIcon,
  GlobeIcon,
  HourglassIcon,
  LayoutDashboardIcon,
  NewspaperIcon,
  SearchIcon,
  TagIcon,
  UserIcon,
  UsersIcon,
} from 'lucide-react';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountsSettings, NoIdentity, SettingsFromUrl, useMe } from './auth';
import { DomainsPage, LabelsPage, MessagesPage, OverviewPage, SendersPage, TimePage } from './archive';
import { FiltersPage, SubscriptionsPage } from './gmail-pages';
import { MailboxProvider, MailboxSwitcher } from './mailbox';
import { BackfillPage, UsagePage } from './ops-pages';
import './index.css';

// Schedules are saved in the mailbox. Nothing runs them until phase 2's sync,
// so Run now reports that rather than pretending.
function SchedulesSettings() {
  const query = useQuery({
    queryKey: ['schedules'],
    queryFn: async (): Promise<ScheduleItem[]> => {
      const res = await fetch('/api/schedules');
      if (!res.ok) throw new Error(`Couldn't load schedules (${res.status})`);
      return res.json();
    },
  });
  const client = useQueryClient();
  if (!query.data) return <p className="text-sm text-muted-foreground">{query.error ? String(query.error.message) : 'Loading…'}</p>;
  return (
    <SchedulesSection
      schedules={query.data}
      onSave={async (id: string, change: Partial<ScheduleItem>) => {
        const res = await fetch(`/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify(change) });
        const body = await res.json();
        if (!res.ok) throw new Error(body.detail ?? 'Not saved');
        client.setQueryData<ScheduleItem[]>(['schedules'], (all) => all?.map((s) => (s.id === id ? body : s)));
      }}
      onRun={async (): Promise<ScheduleRun> => ({
        at: new Date().toISOString(),
        ok: false,
        detail: 'Not built yet: syncing starts when the backfill ships',
      })}
    />
  );
}

const nav = (
  <NavGroup
    label="Archive"
    items={[
      { title: 'Overview', to: '/', icon: LayoutDashboardIcon, exact: true },
      { title: 'Messages', to: '/messages', icon: SearchIcon },
      { title: 'Senders', to: '/senders', icon: UsersIcon },
      { title: 'Domains', to: '/domains', icon: GlobeIcon },
      { title: 'Labels', to: '/labels', icon: TagIcon },
      { title: 'Time', to: '/time', icon: CalendarClockIcon },
    ]}
  />
);
// Read live from Gmail for the picked mailbox; separate from Settings ▸ Accounts, which connects mailboxes.
const gmailNav = (
  <NavGroup
    label="Gmail settings"
    items={[
      { title: 'Filters', to: '/gmail/filters', icon: FilterIcon },
      { title: 'Subscriptions', to: '/gmail/subscriptions', icon: NewspaperIcon },
    ]}
  />
);
const opsNav = (
  <NavGroup
    label="Operations"
    items={[
      { title: 'Backfill', to: '/backfill', icon: HourglassIcon },
      { title: 'Cloudflare usage', to: '/usage', icon: GaugeIcon },
    ]}
  />
);

// On a phone the menu is a sheet over the page: picking a page closes it.
function CloseMenuOnNavigate() {
  const path = useLocation({ select: (l) => l.pathname });
  const { setOpenMobile } = useSidebar();
  useEffect(() => setOpenMobile(false), [path, setOpenMobile]);
  return null;
}

function Frame() {
  const me = useMe();
  if (me.isPending) return null;
  if (me.data === null) return <NoIdentity />;
  return (
    <MailboxProvider>
      <LumenShell
        app="mailcellar"
        appLabel="MailCellar"
        // Each connected Gmail account is a mailbox; every page shows the one picked here.
        brand={<MailboxSwitcher />}
        nav={<>{nav}{gmailNav}{opsNav}</>}
        user={me.data ? { email: me.data.user.email, name: null } : null}
        // Signing out is Cloudflare Access's: it ends the Access session for this site.
        signOutUrl="/cdn-cgi/access/logout"
        // What's new: one entry per PR merged to main, generated at build time.
        releases="/api/releases"
        settings={[
          { id: 'accounts', title: 'Accounts', icon: UserIcon, description: 'Gmail accounts MailCellar copies', content: <AccountsSettings /> },
          { id: 'schedules', title: 'Schedules', icon: CalendarClockIcon, description: 'Jobs that run automatically', content: <SchedulesSettings /> },
        ]}
      >
        <CloseMenuOnNavigate />
        <SettingsFromUrl />
        <Outlet />
      </LumenShell>
    </MailboxProvider>
  );
}

/** Set by vite.config.ts: true in the one-file prototype build. */
declare const __SINGLE_FILE__: boolean;

const root = createRootRoute({ component: Frame });
const PAGES = { '/': OverviewPage, '/messages': MessagesPage, '/senders': SendersPage, '/domains': DomainsPage, '/labels': LabelsPage, '/time': TimePage };
const routes = Object.entries(PAGES).map(([path, component]) => createRoute({ getParentRoute: () => root, path, component }));
const opsRoutes = [
  createRoute({ getParentRoute: () => root, path: '/backfill', component: BackfillPage }),
  createRoute({ getParentRoute: () => root, path: '/usage', component: UsagePage }),
  createRoute({ getParentRoute: () => root, path: '/gmail/filters', component: FiltersPage }),
  createRoute({ getParentRoute: () => root, path: '/gmail/subscriptions', component: SubscriptionsPage }),
];
const router = createRouter({
  routeTree: root.addChildren([...routes, ...opsRoutes]),
  // Real URLs, so refresh, Back and links work. The one-file prototype has no server to answer them.
  history: __SINGLE_FILE__ ? createMemoryHistory({ initialEntries: ['/'] }) : createBrowserHistory(),
});
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
