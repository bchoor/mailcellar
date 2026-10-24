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
  GaugeIcon,
  GlobeIcon,
  HourglassIcon,
  LayoutDashboardIcon,
  SearchIcon,
  TagIcon,
  UserIcon,
  UsersIcon,
} from 'lucide-react';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountsSettings, SignInPage, useMe } from './auth';
import { DomainsPage, LabelsPage, MessagesPage, OverviewPage, SendersPage, TimePage } from './archive';
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
        detail: 'Sync arrives with the backfill, in the next phase',
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
  if (me.data === null) return <SignInPage />;
  return (
    <LumenShell
      app="mailcellar"
      appLabel="MailCellar"
      brand={<span className="px-2 font-semibold">MailCellar</span>}
      nav={<>{nav}{opsNav}</>}
      user={me.data?.user ?? null}
      signOutUrl="/api/auth/logout"
      settings={[
        { id: 'accounts', title: 'Accounts', icon: UserIcon, description: 'Gmail accounts this archive keeps', content: <AccountsSettings /> },
        { id: 'schedules', title: 'Schedules', icon: CalendarClockIcon, description: 'Work the archive runs on its own', content: <SchedulesSettings /> },
      ]}
    >
      <CloseMenuOnNavigate />
      <Outlet />
    </LumenShell>
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
