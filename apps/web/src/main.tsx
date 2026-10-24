import {
  IntegrationRow,
  LumenLayout,
  LumenShell,
  NavGroup,
  SchedulesSection,
  TestBadge,
  type ScheduleItem,
  type ScheduleRun,
  type ViewDomain,
  useLumenLoad,
} from '@columenlabs/lumen-ui';
import { TooltipProvider } from '@columenlabs/lumen-ui/ui/tooltip';
import { type CustomViewConfig, customViewConfigSchema } from '@columenlabs/lumen-ui-types/views';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import {
  AtSignIcon,
  CalendarClockIcon,
  CalendarIcon,
  GaugeIcon,
  GlobeIcon,
  HourglassIcon,
  HardDriveIcon,
  InboxIcon,
  LayoutDashboardIcon,
  MailIcon,
  PaperclipIcon,
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

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const minutesAhead = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

const INITIAL_SCHEDULES: ScheduleItem[] = [
  {
    id: 'gmail-sync',
    name: 'Gmail sync',
    on: true,
    every: 360,
    from: '00:00',
    to: '23:59',
    days: [0, 1, 2, 3, 4, 5, 6],
    tz: 'America/Los_Angeles',
    kind: 'window',
    choices: [60, 180, 360, 720, 1440],
    about: {
      inspects: 'Gmail changes since the last run, for each connected account',
      processes: 'Saves new messages and attachments, and applies label changes and deletions',
      enriches: 'Embeddings for the messages you chose for semantic search',
      outputs: 'Your archive tables, search index and the views on these pages',
      cost: 'Free tier',
    },
    last: { at: minutesAgo(130), ok: true, detail: '214 new messages, 3 label changes' },
    next: minutesAhead(230),
    waiting: null,
  },
  {
    id: 'compaction',
    name: 'Archive maintenance',
    on: true,
    every: 1440,
    from: '03:15',
    to: '03:15',
    days: [0, 1, 2, 3, 4, 5, 6],
    tz: 'America/Los_Angeles',
    kind: 'daily',
    choices: [],
    about: {
      inspects: 'Your archive tables',
      processes: 'Merges small files and expires old snapshots',
      outputs: 'Faster long-range views',
      cost: 'Free tier',
    },
    last: { at: minutesAgo(900), ok: true, detail: 'Merged 41 files' },
    next: minutesAhead(540),
    waiting: null,
  },
];

function SchedulesSettings() {
  const [items, setItems] = useState(INITIAL_SCHEDULES);
  return (
    <SchedulesSection
      schedules={items}
      onSave={async (id: string, change: Partial<ScheduleItem>) => {
        setItems((all) => all.map((s) => (s.id === id ? { ...s, ...change } : s)));
      }}
      onRun={async (id: string): Promise<ScheduleRun> => {
        await new Promise((r) => setTimeout(r, 1200));
        const run = { at: new Date().toISOString(), ok: true, detail: '12 new messages' };
        setItems((all) => all.map((s) => (s.id === id ? { ...s, last: run } : s)));
        return run;
      }}
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
