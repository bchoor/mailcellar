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
import { MESSAGES, type Msg } from './data';
import { BackfillPage, BackfillStatus, UsagePage } from './ops-pages';
import './index.css';

const MESSAGE_DOMAIN: ViewDomain<Msg> = {
  id: 'messages',
  rowKey: (r) => r.id,
  text: (r) => [r.subject, r.from],
  fields: [
    { key: 'date', label: 'Date', icon: CalendarIcon, value: (r) => r.date, format: 'text' },
    { key: 'from', label: 'Sender', icon: AtSignIcon, value: (r) => r.from, format: 'text', filterable: true, groupable: true },
    { key: 'domain', label: 'Domain', icon: GlobeIcon, value: (r) => r.domain, format: 'text', filterable: true, groupable: true },
    { key: 'subject', label: 'Subject', icon: MailIcon, value: (r) => r.subject, format: 'text' },
    { key: 'label', label: 'Label', icon: TagIcon, value: (r) => r.label, format: 'text', filterable: true, groupable: true },
    { key: 'account', label: 'Account', icon: InboxIcon, value: (r) => r.account, format: 'text', filterable: true, groupable: true },
    { key: 'year', label: 'Year', icon: CalendarClockIcon, value: (r) => r.year, format: 'text', filterable: true, groupable: true },
    { key: 'n', label: 'Messages', icon: MailIcon, value: (r) => r.n, format: 'integer', aggregate: 'sum' },
    { key: 'size_mb', label: 'Size (MB)', icon: HardDriveIcon, value: (r) => r.size_mb, format: 'number', aggregate: 'sum', filterable: true },
    { key: 'attachments', label: 'Attachments', icon: PaperclipIcon, value: (r) => r.attachments, format: 'integer', aggregate: 'sum', filterable: true },
  ],
} as ViewDomain<Msg>;

const view = (name: string, over: Record<string, unknown>): CustomViewConfig => ({
  name,
  ...customViewConfigSchema.parse(over),
});
const TABLE = { id: 'table', kind: 'table', style: 'table', w: 6 };
const grouped = (name: string, by: string, cards: unknown[] = []) =>
  view(name, {
    shape: 'group',
    group: { fields: ['from', 'domain', 'label', 'account', 'year'], default: by },
    columns: ['date', 'from', 'subject', 'label', 'n', 'size_mb', 'attachments'],
    sort: { key: 'n', desc: true },
    ...(cards.length ? { cards: [...cards, TABLE] } : {}),
  });

const VIEWS: Record<string, { title: string; config: CustomViewConfig }> = {
  overview: {
    title: 'Overview',
    config: view('Overview', {
      columns: ['date', 'from', 'subject', 'label', 'size_mb', 'attachments'],
      sort: { key: 'date', desc: true },
      cards: [
        {
          id: 'summary', kind: 'metric', style: 'row', w: 6,
          tiles: [
            { key: 'msgs', label: 'Messages', field: 'n', agg: 'sum' },
            { key: 'senders', label: 'Senders', field: 'from', agg: 'distinct' },
            { key: 'size', label: 'Size (MB)', field: 'size_mb', agg: 'sum' },
            { key: 'att', label: 'Attachments', field: 'attachments', agg: 'sum' },
          ],
        },
        { id: 'per_year', title: 'Messages per year', kind: 'chart', style: 'bars', date: 'date', values: ['n'], bucket: 'year', agg: 'sum', w: 6 },
        { id: 'by_label', title: 'By label', kind: 'allocation', style: 'donut', by: 'label', value: 'n', w: 3 },
        { id: 'by_domain', title: 'Top domains', kind: 'allocation', style: 'bar_list', by: 'domain', value: 'n', w: 3 },
        TABLE,
      ],
    }),
  },
  messages: {
    title: 'Messages',
    config: view('Messages', {
      columns: ['date', 'from', 'subject', 'label', 'account', 'size_mb', 'attachments'],
      sort: { key: 'date', desc: true },
    }),
  },
  senders: { title: 'Senders', config: grouped('Senders', 'from') },
  domains: { title: 'Domains', config: grouped('Domains', 'domain') },
  labels: {
    title: 'Labels',
    config: grouped('Labels', 'label', [{ id: 'label_share', title: 'Share by label', kind: 'allocation', style: 'donut', by: 'label', value: 'n', w: 3 }]),
  },
  time: {
    title: 'Time',
    config: grouped('Time', 'year', [
      { id: 'per_month', title: 'Messages per month', kind: 'chart', style: 'bars', date: 'date', values: ['n'], bucket: 'month', agg: 'sum', w: 6 },
    ]),
  },
};

function ViewPage({ id }: { id: string }) {
  const v = VIEWS[id] ?? VIEWS.overview;
  const query = useQuery({ queryKey: ['messages'], queryFn: async () => MESSAGES });
  const load = useLumenLoad(query);
  const [config, setConfig] = useState(v.config);
  return (
    <LumenLayout
      key={id}
      crumbs={[{ label: v.title }]}
      domain={MESSAGE_DOMAIN}
      config={config}
      rows={query.data ?? []}
      load={load}
      onConfigChange={setConfig}
      rowTitle={(r) => r.subject}
    />
  );
}

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
const routes = Object.keys(VIEWS).map((id) =>
  createRoute({
    getParentRoute: () => root,
    path: id === 'overview' ? '/' : `/${id}`,
    component: () => <ViewPage id={id} />,
  }),
);
const opsRoutes = [
  createRoute({ getParentRoute: () => root, path: '/backfill', component: BackfillPage }),
  createRoute({ getParentRoute: () => root, path: '/usage', component: UsagePage }),
];
const router = createRouter({
  routeTree: root.addChildren([...routes, ...opsRoutes]),
  history: createMemoryHistory({ initialEntries: ['/'] }),
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
