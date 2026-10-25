import {
  configureLumen,
  LumenPageState,
  LumenShell,
  NavGroup,
  RouteError,
  SchedulesSection,
  type ScheduleItem,
  type ScheduleRun,
} from '@columenlabs/lumen-ui';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@columenlabs/lumen-ui/ui/sidebar';
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
  Link,
  Navigate,
  useLocation,
  useParams,
} from '@tanstack/react-router';
import { CalendarClockIcon, CircleHelpIcon, GaugeIcon, HourglassIcon, UserIcon } from 'lucide-react';
import { type ReactNode, StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountsSettings, NoIdentity, SettingsFromUrl, useMe } from './auth';
import { MessagesPage, OverviewPage, PanesPage } from './archive';
import { FiltersPage, SubscriptionsPage } from './gmail-pages';
import { MAILBOX_PAGES, MailboxNav, mailboxPath, PANE_PAGES } from './mailbox';
import { UsagePage } from './ops-pages';
import { BackfillPage, SyncStatus, syncAllNow } from './sync';
import './index.css';

// Until a person picks: the device's theme, and Pacific time (Bikram, 2026-10-24).
configureLumen({ defaultPrefs: { theme: 'system', timeZone: 'America/Los_Angeles' } });
// Whether the last input was a pointer or a key, for index.css: a clicked tab gets no focus ring.
const html = document.documentElement;
addEventListener('pointerdown', () => html.setAttribute('data-pointer', ''), true);
addEventListener('keydown', () => html.removeAttribute('data-pointer'), true);

// Schedules are saved in the mailbox, which runs Gmail sync on its own. Run now syncs every account now.
function SchedulesSettings() {
  const me = useMe();
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
      onRun={async (id: string): Promise<ScheduleRun> => {
        const ids = me.data?.accounts.map((a) => a.id) ?? [];
        const run: ScheduleRun =
          id === 'gmail-sync' && ids.length
            ? await syncAllNow(ids)
            : { at: new Date().toISOString(), ok: false, detail: id === 'gmail-sync' ? 'Add a Gmail account first' : 'Not built yet' };
        await client.invalidateQueries({ queryKey: ['backfill'] });
        return run;
      }}
    />
  );
}

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

// The sidebar's top: the logo (the favicon's mark) and the name; collapsed, the logo alone.
const brand = (
  <SidebarMenu>
    <SidebarMenuItem>
      <SidebarMenuButton size="lg" tooltip="MailCellar" asChild>
        <Link to="/">
          <img src="/favicon.svg" alt="" className="size-8 shrink-0 rounded-lg" />
          <span className="truncate font-semibold">MailCellar</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  </SidebarMenu>
);

function Frame() {
  const me = useMe();
  if (me.isPending) return null;
  if (me.data === null) return <NoIdentity />;
  return (
    <LumenShell
      app="mailcellar"
      appLabel="MailCellar"
      brand={brand}
      // One section per Gmail account, then the pages that cover all of them.
      nav={<><MailboxNav />{opsNav}</>}
      user={me.data ? { email: me.data.user.email, name: null } : null}
      // Signing out is Cloudflare Access's: it ends the Access session for this site.
      signOutUrl="/cdn-cgi/access/logout"
      // What's new: each release's Key takeaways and merged PRs; the status bar shows the version.
      releases="/api/releases"
      statusEnd={<SyncStatus />}
      settings={[
        { id: 'accounts', title: 'Accounts', icon: UserIcon, description: 'Gmail accounts MailCellar copies', content: <AccountsSettings /> },
        { id: 'schedules', title: 'Schedules', icon: CalendarClockIcon, description: 'Jobs that run automatically', content: <SchedulesSettings /> },
      ]}
    >
      <CloseMenuOnNavigate />
      <SettingsFromUrl />
      <Outlet />
    </LumenShell>
  );
}

/** Set by vite.config.ts: true in the one-file prototype build. */
declare const __SINGLE_FILE__: boolean;

const root = createRootRoute({ component: Frame });
const PAGES: Record<(typeof MAILBOX_PAGES)[number], () => ReactNode> = {
  '': OverviewPage,
  messages: MessagesPage,
  panes: PanesPage,
  'gmail/filters': FiltersPage,
  'gmail/subscriptions': SubscriptionsPage,
};
const mailboxRoutes = MAILBOX_PAGES.map((page) =>
  createRoute({ getParentRoute: () => root, path: `/m/$mailbox${page ? `/${page}` : ''}`, component: PAGES[page] }),
);

// Outside a mailbox (home, or an old link like /messages): open that page in the first mailbox.
// With none connected, Overview says how to add one.
function FirstMailbox({ page, search }: { page: string; search?: Record<string, string> }) {
  const first = useMe().data?.accounts[0];
  if (!first) return <OverviewPage />;
  return <Navigate to={mailboxPath(first.id, page)} search={search} replace />;
}
const firstRoutes = MAILBOX_PAGES.map((page) =>
  createRoute({ getParentRoute: () => root, path: `/${page}`, component: () => <FirstMailbox page={page} /> }),
);
// Gmail settings is a nav group: its own address opens its first page.
const gmailRoute = createRoute({
  getParentRoute: () => root,
  path: '/m/$mailbox/gmail',
  component: function GmailSettings() {
    const { mailbox } = gmailRoute.useParams();
    return <Navigate to={mailboxPath(mailbox, 'gmail/filters')} replace />;
  },
});
// Senders, Domains, Labels and Time are Panes tabs now; old links open the tab.
const paneRoutes = PANE_PAGES.flatMap((tab) => [
  createRoute({
    getParentRoute: () => root,
    path: `/m/$mailbox/${tab}`,
    component: function OldPane() {
      const mailbox = useParams({ strict: false, select: (p: { mailbox?: string }) => p.mailbox ?? '' });
      return <Navigate to={mailboxPath(mailbox, 'panes')} search={{ tab }} replace />;
    },
  }),
  createRoute({ getParentRoute: () => root, path: `/${tab}`, component: () => <FirstMailbox page="panes" search={{ tab }} /> }),
]);
// An address no page answers: the kit's page state, inside the shell.
function NotFound() {
  return <LumenPageState crumbs={[{ label: 'MailCellar', to: '/' }]} title="Page" icon={CircleHelpIcon} notFound="No page at this address." />;
}
const opsRoutes = [
  createRoute({ getParentRoute: () => root, path: '/backfill', component: BackfillPage }),
  createRoute({ getParentRoute: () => root, path: '/usage', component: UsagePage }),
];
const router = createRouter({
  routeTree: root.addChildren([...mailboxRoutes, gmailRoute, ...paneRoutes, ...firstRoutes, ...opsRoutes]),
  defaultNotFoundComponent: NotFound,
  defaultErrorComponent: RouteError,
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
