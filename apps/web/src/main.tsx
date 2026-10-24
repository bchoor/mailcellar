import {
  IntegrationRow,
  LumenShell,
  NavGroup,
  SchedulesSection,
  TestBadge,
  type ScheduleItem,
  type ScheduleRun,
} from '@columenlabs/lumen-ui';
import { TooltipProvider } from '@columenlabs/lumen-ui/ui/tooltip';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
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
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DomainsPage, LabelsPage, MessagesPage, OverviewPage, SendersPage, TimePage } from './archive';
import { BackfillPage, BackfillStatus, UsagePage } from './ops-pages';
import { RELEASES, RELEASES_API } from './releases';
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

const ACCOUNTS = [
  { email: 'you@example.com', meta: 'Gmail · 1,682 messages · synced 2 h ago' },
  { email: 'work@example.org', meta: 'Gmail · 718 messages · synced 2 h ago' },
];

function AccountsSettings() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      {ACCOUNTS.map((a) => (
        <IntegrationRow
          key={a.email}
          name={a.email}
          meta={a.meta}
          badge={<TestBadge test={{ ok: true }} ok="Connected" />}
          open={open === a.email}
          onOpenChange={(o: boolean) => setOpen(o ? a.email : null)}
        >
          <p className="text-sm text-muted-foreground">
            Read-only Gmail access. The archive keeps every message, even after you delete it from Gmail.
          </p>
        </IntegrationRow>
      ))}
    </div>
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

function Frame() {
  return (
    <LumenShell
      app="mailcellar"
      appLabel="MailCellar"
      brand={<span className="px-2 font-semibold">MailCellar</span>}
      nav={<>{nav}{opsNav}</>}
      status={<BackfillStatus />}
      releases={RELEASES_API}
      user={{ email: 'you@example.com', name: 'Sample user' }}
      settings={[
        { id: 'accounts', title: 'Accounts', icon: UserIcon, description: 'Gmail accounts this archive keeps', content: <AccountsSettings /> },
        { id: 'schedules', title: 'Schedules', icon: CalendarClockIcon, description: 'Work the archive runs on its own', content: <SchedulesSettings /> },
      ]}
    >
      <Outlet />
    </LumenShell>
  );
}

const root = createRootRoute({ component: Frame });
const PAGES = { '/': OverviewPage, '/messages': MessagesPage, '/senders': SendersPage, '/domains': DomainsPage, '/labels': LabelsPage, '/time': TimePage };
const routes = Object.entries(PAGES).map(([path, component]) => createRoute({ getParentRoute: () => root, path, component }));
const opsRoutes = [
  createRoute({ getParentRoute: () => root, path: '/backfill', component: BackfillPage }),
  createRoute({ getParentRoute: () => root, path: '/usage', component: UsagePage }),
];
const router = createRouter({
  routeTree: root.addChildren([...routes, ...opsRoutes]),
  history: createMemoryHistory({ initialEntries: ['/'] }),
});
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
// No releases API yet: seed What's new with the prototype's change log (Lumen's query key).
queryClient.setQueryData(['edgeshell', 'releases', RELEASES_API], { pages: [RELEASES], pageParams: [null] });

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
