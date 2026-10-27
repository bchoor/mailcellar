// The archive pages, for the mailbox picked in the sidebar. Each reads its own rows from that
// mailbox's rollups (/api/accounts/:id/archive/*), so no page loads every message.
import { type FilterToken, LumenLayout, type LumenTab, LumenTabs, LumenSavedWidget, type ServerGroups, Tile, TileRow, useIsMobile, useLumenLoad, usePrefs, type LumenLoad, type ViewDomain } from '@columenlabs/lumen-ui';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@columenlabs/lumen-ui/ui/empty';
import { Tooltip, TooltipContent, TooltipTrigger } from '@columenlabs/lumen-ui/ui/tooltip';
import { CONTAINS_KEY, type CustomViewConfig, customViewConfigSchema } from '@columenlabs/lumen-ui-types/views';
import {
  type ArchiveRows,
  type ArchiveView,
  type BodySnippet,
  type DomainRow,
  type GmailLabels,
  type LabelRow,
  MESSAGE_GROUPS,
  MESSAGE_PAGE_SIZES,
  type MessageFilter,
  type MessageGroups,
  type MessagePage,
  type MessageRow,
  type MessageSort,
  type MonthRow,
  type SenderRow,
} from '@mailcellar/schema';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  AtSignIcon,
  CalendarClockIcon,
  CalendarIcon,
  GlobeIcon,
  type LucideIcon,
  HardDriveIcon,
  InboxIcon,
  InfoIcon,
  MailIcon,
  MailOpenIcon,
  MailsIcon,
  MessagesSquareIcon,
  PaperclipIcon,
  SearchIcon,
  TagIcon,
  UserIcon,
  UsersIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useMailbox, useMailboxCrumbs } from './mailbox';
import { bytes, count, listTime, moment, monthName } from './format';
import { MessageDrawer } from './message-drawer';
import { daySpan, localDay, type Period, periodOf, periodSpan, periods } from './period';

// Sizes stay exact here and round only when shown, so a total matches the sum of its rows.
// Decimal units, as format.ts writes sizes.
const KB = 1000;
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/** A sortable ISO day for the value, `Sep 29, 2026` on screen. */
const dayText = (ts: number) => DAY.format(new Date(ts));

// Gmail's system labels come as INBOX, CATEGORY_PROMOTIONS, YELLOW_STAR: shown as Inbox, Promotions, Yellow star.
export function labelName(l: { name: string; type: string }) {
  if (l.type !== 'system') return l.name;
  const word = l.name.replace(/^CATEGORY_/, '').replaceAll('_', ' ').toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A page with nothing to show yet, saying why and what fills it. */
export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {children && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  );
}

function NoMail() {
  const { account } = useMailbox();
  return (
    <EmptyState icon={MailIcon} title="No mail yet">
      {account?.kind === 'archive'
        ? `Nothing is imported into ${account.email} yet.`
        : account
        ? `Mail from ${account.email} shows here once the backfill copies it.`
        : 'Add a Gmail account in Settings ▸ Accounts. Mail shows here once the backfill copies it.'}
    </EmptyState>
  );
}
/** The empty state once a rollup has loaded with no rows; nothing while it loads or fails. */
const isEmpty = (query: { data?: unknown[] }) => !!query.data && !query.data.length;
/** A page of an archive with nothing in it yet: the empty state alone, no charts or totals. */
const EmptyPage = ({ title }: { title: string }) => (
  <LumenLayout crumbs={useMailboxCrumbs(title)} cards={[{ id: 'empty', title, kind: 'own', w: 6, link: false, children: <NoMail /> }]} />
);

function useArchive<V extends ArchiveView>(view: V, q = '') {
  const id = useMailbox().account?.id ?? null;
  return useQuery({
    queryKey: ['archive', id, view, q],
    // No mailbox: nothing to read, so the page shows its empty state.
    queryFn: async (): Promise<ArchiveRows[V][]> => {
      if (!id) return [];
      const res = await fetch(`/api/accounts/${id}/archive/${view}${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      if (!res.ok) throw new Error(`Couldn't load ${view} (${res.status})`);
      return res.json();
    },
    // While a new search loads, keep the last results; never another mailbox's.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === id ? prev : undefined),
  });
}

/**
 * The mailbox's labels as Gmail has them now, read live, so a label made or renamed since the
 * last sync shows its name, not its ID. Reading them also renames the index's labels, so the
 * Labels rollup is read again once they arrive.
 */
function useGmailLabels() {
  const id = useMailbox().account?.id ?? null;
  const client = useQueryClient();
  return useQuery({
    queryKey: ['gmail-labels', id],
    queryFn: async (): Promise<GmailLabels> => {
      if (!id) return {};
      const res = await fetch(`/api/accounts/${id}/labels`);
      // Gmail unreachable: the index's names stand in.
      if (!res.ok) return {};
      const body: GmailLabels = await res.json();
      client.invalidateQueries({ queryKey: ['archive', id, 'labels'] });
      return body;
    },
  });
}

// Labels are IDs on a message; Gmail names them, then the Labels rollup.
function useLabelNames() {
  const labels = useArchive('labels');
  const gmail = useGmailLabels().data ?? {};
  const names = new Map((labels.data ?? []).map((l) => [l.id, labelName(l)]));
  return (ids: string[]) => ids.map((id) => (gmail[id] ? labelName(gmail[id]) : (names.get(id) ?? id)));
}

/** Gmail's inbox tabs: a message is in one, Primary when it carries none of the other four. */
const CATEGORIES = ['Promotions', 'Social', 'Updates', 'Forums'] as const;
const CATEGORY_IDS = CATEGORIES.map((c) => `CATEGORY_${c.toUpperCase()}`);
const categoryOf = (ids: string[]) => CATEGORIES.find((c) => ids.includes(`CATEGORY_${c.toUpperCase()}`)) ?? 'Primary';

/** The open tab, kept in the address (?tab=) so refresh and links keep it; the first tab when none or unknown. */
function useTab<V extends string>(tabs: LumenTab<V>[]): [V, (v: V) => void] {
  const raw = useSearch({ strict: false, select: (s: { tab?: unknown }) => s.tab });
  const navigate = useNavigate();
  const value = tabs.find((t) => t.value === raw)?.value ?? tabs[0].value;
  const set = (v: V) => void navigate({ to: '.', search: v === tabs[0].value ? {} : { tab: v }, replace: true });
  return [value, set];
}

/** Messages' tabs: every message, then Gmail's inbox tabs. */
const MESSAGE_TABS: LumenTab<'all' | 'primary' | 'promotions' | 'social' | 'updates' | 'forums'>[] = [
  { value: 'all', label: 'All', icon: MailsIcon },
  { value: 'primary', label: 'Primary', icon: InboxIcon },
  { value: 'promotions', label: 'Promotions', icon: TagIcon },
  { value: 'social', label: 'Social', icon: UsersIcon },
  { value: 'updates', label: 'Updates', icon: InfoIcon },
  { value: 'forums', label: 'Forums', icon: MessagesSquareIcon },
];

/** A message's own labels (the person's, not Gmail's built-in ones), each with its Gmail colours. */
function useUserLabels() {
  const labels = useArchive('labels');
  const gmail = useGmailLabels().data ?? {};
  const mine = new Map((labels.data ?? []).filter((l) => l.type === 'user').map((l) => [l.id, l.name]));
  for (const [id, l] of Object.entries(gmail)) if (l.type === 'user') mine.set(id, l.name);
  return (ids: string[]): Chip[] => [
    ...FOLDERS.filter((f) => ids.includes(f.id)).map(({ id: _, ...c }) => c),
    ...ids.filter((x) => mine.has(x)).map((x) => ({ name: mine.get(x)!, bg: gmail[x]?.bg, fg: gmail[x]?.fg })),
  ];
}
export interface Chip {
  name: string;
  bg?: string;
  fg?: string;
}
/** Gmail's Spam and Trash, shown as chips before the person's labels, in Gmail's colours. */
const FOLDERS: (Chip & { id: string })[] = [
  { id: 'SPAM', name: 'Spam', bg: '#fb4c2f', fg: '#ffffff' },
  { id: 'TRASH', name: 'Trash', bg: '#999999', fg: '#ffffff' },
];

/** Label chips in their Gmail colours; past two, a +n with the rest on hover. */
function Chips({ chips }: { chips: Chip[] }) {
  if (!chips.length) return null;
  const shown = chips.slice(0, 2);
  const rest = chips.slice(2);
  return (
    <span className="flex max-w-56 items-center gap-1 overflow-hidden">
      {shown.map((c) => (
        // A badge centres its content, so a long name is cut on both sides: the name ends in an ellipsis instead.
        <Badge key={c.name} variant={c.bg ? 'default' : 'secondary'} className="min-w-0 max-w-28 justify-start" style={c.bg ? { background: c.bg, color: c.fg } : undefined} title={c.name}>
          <span className="truncate">{c.name}</span>
        </Badge>
      ))}
      {rest.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-xs text-muted-foreground tabular-nums">+{rest.length}</span>
          </TooltipTrigger>
          <TooltipContent>{rest.map((c) => c.name).join(', ')}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

const view = (name: string, over: Record<string, unknown>): CustomViewConfig => ({
  name,
  ...customViewConfigSchema.parse(over),
});
const TABLE = { id: 'table', kind: 'table', style: 'table', w: 6 };
const n = { key: 'n', label: 'Messages', icon: MailIcon, value: (r: { n: number }) => r.n, format: 'rounded', aggregate: 'sum' } as const;
// Each size reads in its own unit (812 KB, 45.2 MB, 13.1 GB); the key stays for saved views.
const size = { key: 'size_mb', label: 'Size', icon: HardDriveIcon, value: (r: { bytes: number }) => r.bytes, format: 'bytes', aggregate: 'sum' } as const;

// Overview and Time: one row a month.
const MONTHS: ViewDomain<MonthRow> = {
  id: 'months',
  rowKey: (r) => r.month,
  fields: [
    // The chart buckets on the date; the table shows the month by name.
    { key: 'date', label: 'Month', icon: CalendarIcon, value: (r) => `${r.month}-01`, format: 'text', render: (r) => monthName(r.month) },
    { key: 'year', label: 'Year', icon: CalendarClockIcon, value: (r) => r.month.slice(0, 4), format: 'text', filterable: true, groupable: true },
    n,
    size,
  ],
} as ViewDomain<MonthRow>;

const LABELS: ViewDomain<LabelRow> = {
  id: 'labels',
  rowKey: (r) => r.id,
  text: (r) => [labelName(r)],
  // A message carries several labels, so a sum across labels counts it more than once: no Total.
  fields: [
    { key: 'label', label: 'Label', icon: TagIcon, value: (r) => labelName(r), format: 'text', filterable: true, groupable: true },
    { key: 'type', label: 'Type', icon: TagIcon, value: (r) => (r.type === 'system' ? 'Built-in' : 'Yours'), format: 'text', filterable: true, groupable: true, hideOnPhone: true },
    { ...n, aggregate: undefined },
    { ...size, aggregate: undefined },
  ],
} as ViewDomain<LabelRow>;

const DOMAINS: ViewDomain<DomainRow> = {
  id: 'domains',
  rowKey: (r) => r.domain,
  text: (r) => [r.domain],
  fields: [
    { key: 'domain', label: 'Domain', icon: GlobeIcon, value: (r) => r.domain, format: 'text', filterable: true },
    n,
    size,
  ],
} as ViewDomain<DomainRow>;

const SENDERS: ViewDomain<SenderRow> = {
  id: 'senders',
  rowKey: (r) => r.addr,
  text: (r) => [r.addr, r.name],
  fields: [
    { key: 'from', label: 'Sender', icon: AtSignIcon, value: (r) => r.addr, format: 'text', filterable: true },
    { key: 'name', label: 'Name', icon: UserIcon, value: (r) => r.name, format: 'text', hideOnPhone: true },
    { key: 'domain', label: 'Domain', icon: GlobeIcon, value: (r) => r.addr.split('@')[1] ?? '', format: 'text', filterable: true, groupable: true },
    n,
    size,
    { key: 'first', label: 'First email', icon: CalendarIcon, value: (r) => day(r.firstTs), format: 'text', render: (r) => dayText(r.firstTs), hideOnPhone: true },
    { key: 'last', label: 'Latest email', icon: CalendarIcon, value: (r) => day(r.lastTs), format: 'text', render: (r) => dayText(r.lastTs) },
  ],
} as ViewDomain<SenderRow>;

/** Text cut to a column's width with an ellipsis; the whole of it shows on hover. */
function Clip({ text, w }: { text: string; w: string }) {
  if (!text) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block truncate" style={{ maxWidth: w }}>
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-md whitespace-normal break-all">{text}</TooltipContent>
    </Tooltip>
  );
}

type MessageView = MessageRow & { labelNames: string[]; chips: Chip[]; unread: boolean; important: boolean; category: string; period: string; day: string; found?: BodySnippet };

/** Where a search's words are in a message's body: the words in bold, under the subject. */
function Found({ s }: { s: BodySnippet }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of s.hits) {
    if (a > at) parts.push(s.text.slice(at, a));
    parts.push(<b key={a} className="font-semibold text-foreground">{s.text.slice(a, b)}</b>);
    at = b;
  }
  parts.push(s.text.slice(at));
  return (
    <span className="block truncate text-xs font-normal text-muted-foreground" style={{ maxWidth: '22rem' }} title={s.text}>
      {parts}
    </span>
  );
}

/** The attachment a search's words were found in, under the subject. */
function FoundIn({ name }: { name: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs font-normal text-muted-foreground" style={{ maxWidth: '22rem' }} title={`Found in ${name}`}>
      <PaperclipIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">In {name}</span>
    </span>
  );
}

/**
 * Body snippets for rows a search matched only in their body, read from their raw files: one
 * request a page of rows, kept a while. Keyed by message ID.
 */
function useFound(id: string | null, text: string, rows: MessageRow[]): Map<string, BodySnippet> {
  const ids = rows.filter((r) => r.bodyHit).map((r) => r.id).slice(0, 50);
  const found = useQuery({
    queryKey: ['found', id, text, ids.join(',')],
    enabled: !!id && !!text && ids.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<Record<string, BodySnippet>> => {
      const res = await fetch(`/api/accounts/${id}/snippets?${new URLSearchParams({ ids: ids.join(','), q: text })}`);
      if (!res.ok) return {};
      return res.json();
    },
  });
  return useMemo(() => new Map(Object.entries(found.data ?? {})), [found.data]);
}
const MESSAGES: ViewDomain<MessageView> = {
  id: 'messages',
  // The server pages and groups these rows; a pivot would cover one page only.
  pivotNote: 'Pivot is off: the server pages these rows.',
  rowKey: (r) => r.id,
  text: (r) => [r.subject, r.fromAddr, r.fromName],
  fields: [
    // The day in the person's time zone, like Period.
    { key: 'date', label: 'Date', icon: CalendarIcon, value: (r) => r.day, format: 'text', render: (r) => <time dateTime={new Date(r.ts).toISOString()} title={moment(r.ts)}>{listTime(r.ts)}</time> },
    {
      key: 'from', label: 'Sender', icon: AtSignIcon, value: (r) => r.fromAddr, format: 'text', filterable: true, groupable: true,
      // Unread: a dot and bold, as in Gmail.
      render: (r) => (
        <span className={`flex items-center gap-1.5 ${r.unread ? 'font-semibold' : ''}`}>
          <span className={`size-2 shrink-0 rounded-full ${r.unread ? 'bg-primary' : ''}`} aria-label={r.unread ? 'Unread' : undefined} />
          <Clip text={r.fromAddr} w="13rem" />
        </span>
      ),
    },
    { key: 'domain', label: 'Domain', icon: GlobeIcon, value: (r) => r.fromAddr.split('@')[1] ?? '', format: 'text', filterable: true, groupable: true },
    {
      key: 'subject', label: 'Subject', icon: MailIcon, value: (r) => r.subject, format: 'text',
      render: (r) => (
        <span className="block min-w-0">
          <span className={`flex items-center gap-1 ${r.unread ? 'font-semibold' : ''}`}>
            {r.important && <span className="text-warning" title="Important">★</span>}
            <Clip text={r.subject} w="22rem" />
          </span>
          {r.found && <Found s={r.found} />}
          {r.attachHit && <FoundIn name={r.attachHit} />}
        </span>
      ),
    },
    { key: 'category', label: 'Category', icon: InboxIcon, value: (r) => r.category, format: 'text', filterable: true, groupable: true, hideOnPhone: true },
    {
      key: 'is', label: 'Read', icon: MailOpenIcon, value: (r) => (r.unread ? 'Unread' : 'Read'), format: 'text', filterable: true, groupable: true,
      // is:spam and is:trash, as in Gmail, offered when the page has such mail.
      values: (r) => [r.unread ? 'Unread' : 'Read', ...FOLDERS.filter((f) => r.labels.includes(f.id)).map((f) => f.name)],
    },
    { key: 'period', label: 'Period', icon: CalendarClockIcon, value: (r) => r.period, format: 'text', filterable: true, groupable: true },
    { key: 'label', label: 'Labels', icon: TagIcon, value: (r) => r.chips.map((c) => c.name).join(', '), values: (r) => r.chips.map((c) => c.name), format: 'text', filterable: true, groupable: true, render: (r) => <Chips chips={r.chips} />, hideOnPhone: true },
    { key: 'size_kb', label: 'Size', icon: HardDriveIcon, value: (r) => r.size, format: 'bytes', aggregate: 'sum', filterable: true },
    // None reads as a dash, so the few messages with files stand out.
    { key: 'attachments', label: 'Attachments', icon: PaperclipIcon, value: (r) => r.attachments, format: 'rounded', aggregate: 'sum', filterable: true, hideOnPhone: true, render: (r) => r.attachments || <span className="num text-muted-foreground">—</span> },
  ],
} as ViewDomain<MessageView>;

// A widget drawn over another page's rollup (Overview's label share and top domains).
function RollupWidget<T>(p: { title: string; domain: ViewDomain<T>; rows: T[]; load: LumenLoad; card: Record<string, unknown> }) {
  const widget = customViewConfigSchema.parse({ cards: [p.card] }).cards![0];
  return (
    <LumenSavedWidget
      widget={widget as Parameters<typeof LumenSavedWidget>[0]['widget']}
      title={p.title}
      domain={p.domain}
      rows={p.rows}
      fields={[]}
      merge={(r) => r}
      load={p.load}
    />
  );
}

/** Whole months from one YYYY-MM to another. */
const monthsBetween = (a: string, b: string) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));

export function OverviewPage() {
  const months = useArchive('months');
  const labels = useArchive('labels');
  const domains = useArchive('domains');
  const totals = useArchive('totals');
  const load = useLumenLoad(months);
  const labelsLoad = useLumenLoad(labels);
  const domainsLoad = useLumenLoad(domains);
  const [config, setConfig] = useState(() =>
    view('Overview', {
      columns: ['date', 'n', 'size_mb'],
      sort: { key: 'date', desc: true },
      // The month table lives on Time; Overview keeps the totals and the shape.
      cards: [{ id: 'per_year', title: 'Messages per year', kind: 'chart', style: 'bars', date: 'date', values: ['n'], bucket: 'year', agg: 'sum', w: 6 }],
    }),
  );
  const rows = months.data ?? [];
  const total = rows.reduce((a, r) => a + r.n, 0);
  const size = rows.reduce((a, r) => a + r.bytes, 0);
  const years = new Set(rows.map((r) => r.month.slice(0, 4)));
  const first = rows.reduce((a, r) => (r.month < a ? r.month : a), rows[0]?.month ?? '');
  const last = rows.reduce((a, r) => (r.month > a ? r.month : a), first);
  // Two years or less of mail reads better a month a bar than as one or two year bars.
  const short = first !== '' && monthsBetween(first, last) < 24;
  const shown = short
    ? { ...config, cards: config.cards?.map((c) => (c.id === 'per_year' ? { ...c, title: 'Messages per month', bucket: 'month' as const } : c)) }
    : config;
  const userLabels = (labels.data ?? []).filter((l) => l.type === 'user');
  const crumbs = useMailboxCrumbs('Overview');
  // An empty archive has no totals or charts worth drawing: say so once.
  if (isEmpty(months)) return <EmptyPage title="Overview" />;
  return (
    <LumenLayout
      crumbs={crumbs}
      domain={MONTHS}
      config={shown}
      rows={rows}
      load={load}
      onConfigChange={setConfig}
      rowTitle={(r) => monthName(r.month)}
      lead={[
        {
          id: 'totals', title: 'In your archive', kind: 'own', w: 6, link: false,
          children: (
            <TileRow className="grid grid-cols-2 lg:flex">
              {/* A dash until the numbers load, never a 0 that isn't true. */}
              <Tile className="lg:flex-1" label="Messages" value={months.data ? count(total) : '—'} />
              <Tile className="lg:flex-1" label="Size" value={months.data ? bytes(size) : '—'} />
              <Tile className="lg:flex-1" label="Senders" value={totals.data?.[0] ? count(totals.data[0].senders) : '—'} />
              <Tile className="lg:flex-1" label="Years" value={months.data ? count(years.size) : '—'} caption={first ? `since ${monthName(first)}` : undefined} />
            </TileRow>
          ),
        },
        {
          id: 'by_label', title: 'Your labels', kind: 'own', w: 3,
          children: <RollupWidget title="Your labels" domain={LABELS} rows={userLabels} load={labelsLoad} card={{ id: 'by_label', kind: 'allocation', style: 'donut', by: 'label', value: 'n' }} />,
        },
        {
          id: 'by_domain', title: 'Top 6 domains', kind: 'own', w: 3,
          children: <RollupWidget title="Top 6 domains" domain={DOMAINS} rows={(domains.data ?? []).slice(0, 6)} load={domainsLoad} card={{ id: 'by_domain', kind: 'allocation', style: 'bar_list', by: 'domain', value: 'n' }} />,
        },
      ]}
    />
  );
}

/** The Messages column each server order sorts. */
const SORT_COLUMN: Record<MessageSort, string> = { date: 'date', from: 'from', size: 'size_kb', attachments: 'attachments', category: 'category' };

/** The Messages page's chips as the server's filters; a chip it can't apply is left out. */
function toFilters(tokens: FilterToken[], list: Period[], tz: string): MessageFilter[] {
  const byKey = new Map<string, FilterToken[]>();
  for (const t of tokens) byKey.set(t.key, [...(byKey.get(t.key) ?? []), t]);
  const out: MessageFilter[] = [];
  for (const [key, ts] of byKey) {
    const not = !!ts[0].not;
    const values = ts.map((t) => t.value);
    const op = ts[0].op === 'gt' || ts[0].op === 'lt' || ts[0].op === 'between' ? ts[0].op : ts[0].op ? 'eq' : undefined;
    if (key === CONTAINS_KEY) out.push({ key: 'text', values, not });
    else if (key === 'from' || key === 'domain' || key === 'subject' || key === 'label') out.push({ key, values, not });
    else if (key === 'is') {
      // Read and unread are the UNREAD label's absence and presence; both together filter nothing.
      const unread = values.some((v) => v.toLowerCase() === 'unread');
      const read = values.some((v) => v.toLowerCase() === 'read');
      if (unread !== read) out.push({ key: 'label', values: ['UNREAD'], not: read !== not });
      for (const f of FOLDERS) if (values.some((v) => v.toLowerCase() === f.name.toLowerCase())) out.push({ key: 'label', values: [f.id], not });
    } else if (key === 'category') {
      // Categories are exclusive: Primary is having none of the other four.
      const picked = CATEGORIES.filter((c) => values.some((v) => v.toLowerCase() === c.toLowerCase())).map((c) => `CATEGORY_${c.toUpperCase()}`);
      const primary = values.some((v) => v.toLowerCase() === 'primary');
      const others = CATEGORY_IDS.filter((x) => !picked.includes(x));
      if (primary && others.length) out.push({ key: 'label', values: others, not: !not });
      else if (!primary && picked.length) out.push({ key: 'label', values: picked, not });
    }
    else if (key === 'period' || key === 'date') {
      const spans = values
        .map((v) => (key === 'period' ? periodSpan(list, v, tz) : daySpan(v, tz)))
        .filter((x): x is Period => !!x)
        .map((x) => `${x.from}..${x.to}`);
      if (spans.length) out.push({ key: 'range', values: spans, not });
    } else if ((key === 'size_kb' || key === 'attachments') && op) {
      const scale = key === 'size_kb' ? KB : 1;
      const v = ts[0].value.split('..').map((x) => String(Number(x) * scale)).join('..');
      out.push({ key: key === 'size_kb' ? 'size' : 'attachments', values: [v], op });
    }
  }
  return out;
}

/** Groups per page; the server's page size. */
const GROUPS_PAGE = 50;
/** What the pager counts, by the field grouped by. */
const GROUP_NOUNS: Record<string, string> = { from: 'senders', domain: 'domains', label: 'labels', category: 'categories' };

/** The group fields the server groups by (Period is grouped here, from the periods list). */
const SERVER_GROUPS: readonly string[] = MESSAGE_GROUPS;

/** Periods as exclusive spans, newest first: This week is the week before Yesterday, and so on. */
function periodGroups(list: Period[]): { key: string; filter: MessageFilter }[] {
  const out: { key: string; filter: MessageFilter }[] = [];
  let end = Number.MAX_SAFE_INTEGER;
  for (const p of list) {
    const to = Math.min(p.to, end);
    if (to <= p.from) continue;
    out.push({ key: p.label, filter: { key: 'range', values: [`${p.from}..${to}`] } });
    end = Math.min(end, p.from);
  }
  return out;
}

/**
 * Messages grouped by the server: the picked field's groups (from the rollups, more on asking),
 * and each open group's rows, a page at a time in the page's order. Null when not grouped.
 */
function useServerGroups(
  id: string | null,
  filters: MessageFilter[],
  sort: { by: MessageSort; asc: boolean },
  list: Period[],
  toView: (m: MessageRow) => MessageView,
): { groups: ServerGroups; grouped: boolean } {
  const client = useQueryClient();
  const [by, setBy] = useState<string | null>(null);
  const key = JSON.stringify(filters);
  const server = !!by && SERVER_GROUPS.includes(by);
  // Groups come 50 a page; page n starts after cursors[n], and the first page brings the total.
  const [gpage, setGpage] = useState(0);
  const [gcursors, setGcursors] = useState<(string | null)[]>([null]);
  const [gtotal, setGtotal] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new grouping or filter starts at page one.
  useEffect(() => {
    setGpage(0);
    setGcursors([null]);
    setGtotal(null);
  }, [by, key, id]);
  const after = gcursors[gpage] ?? null;
  const lists = useQuery({
    queryKey: ['message-groups', id, by, key, after],
    enabled: !!id && server,
    queryFn: async (): Promise<MessageGroups> => {
      const qs = new URLSearchParams({ by: by!, ...(filters.length ? { f: key } : {}), ...(after ? { after } : {}) });
      const res = await fetch(`/api/accounts/${id}/messages/groups?${qs}`);
      if (!res.ok) throw new Error(`Couldn't load groups (${res.status})`);
      return res.json();
    },
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === by && prevQuery?.queryKey[3] === key ? prev : undefined),
  });
  const glist = lists.data;
  useEffect(() => {
    if (!glist || lists.isPlaceholderData) return;
    if (glist.total !== null) setGtotal(glist.total);
    setGcursors((c) => (c[gpage + 1] === glist.next ? c : [...c.slice(0, gpage + 1), glist.next]));
  }, [glist, lists.isPlaceholderData, gpage]);
  // Period's groups are the periods list; their counts come from the server, unfiltered only.
  const spans = useMemo(() => (by === 'period' ? periodGroups(list) : []), [by, list]);
  const counts = useQuery({
    queryKey: ['message-periods', id, spans.map((g) => g.filter.values[0]).join(',')],
    enabled: !!id && spans.length > 0 && !filters.length,
    queryFn: async (): Promise<{ n: number[] }> => {
      const res = await fetch(`/api/accounts/${id}/messages/periods?spans=${spans.map((g) => g.filter.values[0]).join(',')}`);
      if (!res.ok) throw new Error(`Couldn't count periods (${res.status})`);
      return res.json();
    },
    staleTime: 60_000,
  });
  const found: { key: string; n: number | null; filter: MessageFilter }[] | null = !by
    ? null
    : server
      ? (lists.data?.groups ?? null)
      : by === 'period'
        ? filters.length
          ? spans.map((g) => ({ ...g, n: null }))
          : counts.data
            ? spans.map((g, i) => ({ ...g, n: counts.data.n[i] ?? null })).filter((g) => g.n !== 0)
            : null
        : null;
  // Which groups are open, and how many pages each has asked for; the first opens by itself.
  const [open, setOpen] = useState<Map<string, number> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new grouping, filter, order or page starts closed.
  useEffect(() => setOpen(null), [by, key, id, sort.by, sort.asc, gpage]);
  const opened = open ?? new Map(found?.length ? [[found[0].key, 1]] : []);
  const shown = (found ?? []).filter((g) => opened.has(g.key));
  const pages = useQueries({
    queries: shown.flatMap((g) =>
      Array.from({ length: opened.get(g.key)! }, (_, i) => ({
        queryKey: ['message-group-rows', id, by, key, g.key, sort.by, sort.asc, i],
        queryFn: async (): Promise<MessagePage> => {
          // Page i starts where page i-1 ended (already loaded: Show more asks only after it shows).
          const prev = i ? client.getQueryData<MessagePage>(['message-group-rows', id, by, key, g.key, sort.by, sort.asc, i - 1]) : null;
          const f = JSON.stringify([...filters, g.filter]);
          const qs = new URLSearchParams({ size: '50', f, ...(prev?.next ? { cursor: prev.next } : {}), ...(sort.asc ? { asc: '1' } : {}), ...(sort.by !== 'date' ? { sort: sort.by } : {}) });
          const res = await fetch(`/api/accounts/${id}/messages?${qs}`);
          if (!res.ok) throw new Error(`Couldn't load messages (${res.status})`);
          return res.json();
        },
        enabled: !!id,
        staleTime: 60_000,
      })),
    ),
  });
  let at = 0;
  const rowsOf = new Map<string, { rows: MessageView[]; next: boolean; loading: boolean }>();
  for (const g of shown) {
    const mine = pages.slice(at, at + opened.get(g.key)!);
    at += mine.length;
    const last = mine[mine.length - 1];
    rowsOf.set(g.key, {
      rows: mine.flatMap((p) => p.data?.rows ?? []).map(toView),
      next: !!last?.data?.next,
      loading: mine.some((p) => p.isPending),
    });
  }
  const groups: ServerGroups = {
    onGroup: setBy,
    list: found?.map((g) => {
      const r = rowsOf.get(g.key);
      return {
        key: g.key,
        n: g.n,
        open: opened.has(g.key),
        rows: r?.rows ?? [],
        loading: r?.loading,
        more: r?.next && !r.loading ? () => setOpen(new Map(opened).set(g.key, opened.get(g.key)! + 1)) : undefined,
      };
    }) ?? null,
    pages: server
      ? {
          page: gpage,
          size: GROUPS_PAGE,
          total: gtotal,
          more: !!glist?.next,
          onPage: (p) => setGpage(Math.max(0, Math.min(p, gcursors.length - 1))),
          noun: GROUP_NOUNS[by!] ?? 'groups',
        }
      : undefined,
    onToggle: (k) => {
      const next = new Map(opened);
      next.has(k) ? next.delete(k) : next.set(k, 1);
      setOpen(next);
    },
    onToggleAll: (all) => setOpen(new Map(all ? (found ?? []).map((g) => [g.key, opened.get(g.key) ?? 1]) : [])),
  };
  return { groups, grouped: server || by === 'period' };
}

export function MessagesPage() {
  const id = useMailbox().account?.id ?? null;
  const { timeZone } = usePrefs();
  const labelNames = useLabelNames();
  const userLabels = useUserLabels();
  const [tab, setTab] = useTab(MESSAGE_TABS);
  // Each tab's count from the rollups (the same counts Labels and Time show); none until they load.
  const months = useArchive('months');
  const labelRows = useArchive('labels');
  const tabCounts = useMemo(() => {
    if (!months.data || !labelRows.data) return MESSAGE_TABS;
    const all = months.data.reduce((t, m) => t + m.n, 0);
    const of = (v: string) => labelRows.data?.find((l) => l.id === `CATEGORY_${v.toUpperCase()}`)?.n ?? 0;
    const cats = CATEGORIES.reduce((t, c) => t + of(c), 0);
    const n = (v: string) => (v === 'all' ? all : v === 'primary' ? Math.max(0, all - cats) : of(v));
    return MESSAGE_TABS.map((t) => ({ ...t, after: <span className="text-xs text-muted-foreground tabular-nums">{count(n(t.value))}</span> }));
  }, [months.data, labelRows.data]);
  const [tokens, setTokens] = useState<FilterToken[]>([]);
  const [size, setSize] = useState(50);
  // Page n starts after cursors[n]; each page read adds the next one's.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState(0);
  // The server sorts by the columns it has an index for (Date, Sender, Size): newest first by default.
  const [sort, setSort] = useState<{ by: MessageSort; asc: boolean }>({ by: 'date', asc: false });
  const asc = sort.asc;
  // Every year back to the oldest month indexed, for Period's groups.
  const oldest = useMemo(() => {
    const first = months.data?.reduce((a, m) => (m.month < a ? m.month : a), '9999-12');
    return first && first !== '9999-12' ? Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1) : undefined;
  }, [months.data]);
  const list = useMemo(() => periods(Date.now(), timeZone, oldest), [timeZone, oldest]);
  // A category tab is one more chip the server applies, ANDed with the person's.
  const filters = useMemo(
    () => toFilters(tab === 'all' ? tokens : [{ key: 'category', value: tab } as FilterToken, ...tokens], list, timeZone),
    [tab, tokens, list, timeZone],
  );
  const key = JSON.stringify(filters);
  // A new filter or page size starts again from the newest.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets when the filter, size or sort changes.
  useEffect(() => {
    setCursors([null]);
    setPage(0);
  }, [key, size, id, sort.by, asc]);
  const cursor = cursors[page] ?? null;
  // The search box's words: rows they matched only in the body show where.
  const text = filters.filter((f) => f.key === 'text' && !f.not).flatMap((f) => f.values).join(' ');
  const [hits, setHits] = useState<MessageRow[]>([]);
  const found = useFound(id, text, hits);
  const toView = (m: MessageRow): MessageView => ({
    ...m,
    labelNames: labelNames(m.labels),
    chips: userLabels(m.labels),
    unread: m.labels.includes('UNREAD'),
    important: m.labels.includes('IMPORTANT'),
    category: categoryOf(m.labels),
    period: periodOf(list, m.ts),
    day: localDay(m.ts, timeZone),
    found: found.get(m.id),
  });
  const { groups, grouped } = useServerGroups(id, filters, sort, list, toView);
  const messages = useQuery({
    // Grouped, each open group loads its own rows; this page still gives the filter its values.
    queryKey: ['messages', id, key, size, cursor, sort.by, asc],
    queryFn: async (): Promise<MessagePage | null> => {
      if (!id) return null;
      const qs = new URLSearchParams({ size: String(size), ...(filters.length ? { f: key } : {}), ...(cursor ? { cursor } : {}), ...(asc ? { asc: '1' } : {}), ...(sort.by !== 'date' ? { sort: sort.by } : {}) });
      const res = await fetch(`/api/accounts/${id}/messages?${qs}`);
      if (!res.ok) throw new Error(`Couldn't load messages (${res.status})`);
      return res.json();
    },
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === id && prevQuery?.queryKey[2] === key ? prev : undefined),
  });
  const data = messages.data;
  // The orders the server serves, kept while grouped (no flat page loads then).
  const [sorts, setSorts] = useState('date');
  const sortsNow = data?.sorts.join(',');
  useEffect(() => {
    if (sortsNow) setSorts(sortsNow);
  }, [sortsNow]);
  const serverSorts = useMemo(() => sorts.split(',').map((x) => SORT_COLUMN[x as MessageSort]), [sorts]);
  useEffect(() => {
    if (!data || messages.isPlaceholderData) return;
    setCursors((c) => (c[page + 1] === data.next ? c : [...c.slice(0, page + 1), data.next]));
  }, [data, messages.isPlaceholderData, page]);
  const load = useLumenLoad(messages);
  const [config, setConfig] = useState(() =>
    view('Messages', { columns: ['date', 'from', 'subject', 'category', 'label', 'size_kb', 'attachments'], sort: { key: 'date', desc: true } }),
  );
  // A category tab holds one category, so its column says nothing there; the saved view keeps it for All.
  const byCategory = tab !== 'all' && config.columns.includes('category');
  // A Pivot shape shows as a table: the server pages these rows.
  const flat = config.shape === 'pivot' ? { ...config, shape: 'table' as const } : config;
  const kept = byCategory ? { ...flat, columns: flat.columns.filter((c) => c !== 'category') } : flat;
  // A phone has room for one column and a bit: the subject leads, then the sender, so a row says what it is.
  const phone = useIsMobile();
  const lead = ['subject', 'from'].filter((c) => kept.columns.includes(c));
  const shown = phone ? { ...kept, columns: [...lead, ...kept.columns.filter((c) => !lead.includes(c))] } : kept;
  const at = config.columns.indexOf('category');
  const onConfig = (next: typeof config) =>
    setConfig(
      byCategory && !next.columns.includes('category')
        ? { ...next, columns: [...next.columns.slice(0, at), 'category', ...next.columns.slice(at)] }
        : next,
    );
  const page0 = (data?.rows ?? []).map(toView);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the shown page's rows, by their IDs.
  useEffect(() => setHits(data?.rows ?? []), [data?.rows.map((r) => r.id).join(',')]);
  // Grouped, the table draws the open groups' rows; these rows only feed the filter's values.
  const rows = grouped
    ? [...new Map([...page0, ...(groups.list ?? []).flatMap((g) => g.rows as MessageView[])].map((r) => [r.id, r])).values()]
    : page0;
  const loaded = !grouped && !!data && !messages.isPlaceholderData;
  const crumbs = useMailboxCrumbs('Messages');
  // A row click opens the message in the drawer.
  const [opened, setOpened] = useState<MessageView | null>(null);
  if (loaded && !rows.length && !filters.length && page === 0) return <EmptyPage title="Messages" />;
  const intro = <LumenTabs tabs={tabCounts} value={tab} onChange={setTab} />;
  const noMatch = loaded && !rows.length && (
    <EmptyState icon={SearchIcon} title={tokens.length ? 'No mail matches these filters' : 'No mail in this tab'}>
      {data?.partial ? 'None in the mail searched so far. Next page keeps searching.' : 'Text search looks at the subject, the sender and the body.'}
    </EmptyState>
  );
  const seen = page * size + (data?.rows.length ?? 0);
  const meta =
    !!data &&
    !messages.isPlaceholderData &&
    [
      data.total !== null ? `${count(data.total)} messages` : `${count(seen)}${data.next ? '+' : ''} matching`,
      data.partial ? 'searching on' : '',
      data.unindexed ? `${count(data.unindexed)} copied month${data.unindexed === 1 ? '' : 's'} not searchable yet` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  return (
    <>
    <LumenLayout
      crumbs={crumbs}
      meta={meta ? <span className="text-xs text-muted-foreground">{meta}</span> : undefined}
      intro={intro}
      domain={MESSAGES}
      config={shown}
      rows={rows}
      load={load}
      onConfigChange={onConfig}
      rowTitle={(r) => r.subject}
      onOpen={setOpened}
      state={noMatch || undefined}
      onTokens={setTokens}
      paging={{
        page,
        size,
        total: data?.total ?? null,
        more: !!data?.next,
        onPage: (p) => setPage(Math.max(0, Math.min(p, cursors.length - 1))),
        onSize: setSize,
        sizes: MESSAGE_PAGE_SIZES,
        // Sender and Size sort once their indexes are built; until then only Date does.
        sorts: serverSorts,
        groups,
        onSort: (s) => {
          const by = (Object.keys(SORT_COLUMN) as MessageSort[]).find((x) => SORT_COLUMN[x] === s?.key) ?? 'date';
          const next = !!s && !s.desc;
          // Told on every render that holds a sort, not only on a click: keep the same object then.
          setSort((c) => (c.by === by && c.asc === next ? c : { by, asc: next }));
        },
      }}
    />
    {id && <MessageDrawer account={id} row={opened} chips={opened?.chips ?? []} rows={data?.rows ?? []} onClose={() => setOpened(null)} />}
    </>
  );
}

function RollupPage<V extends 'senders' | 'domains' | 'labels' | 'months'>({
  title, source, domain, initial, rowTitle, intro, icon,
}: {
  title: string;
  icon: LucideIcon;
  intro: ReactNode;
  source: V;
  domain: ViewDomain<ArchiveRows[V]>;
  initial: Record<string, unknown>;
  rowTitle: (r: ArchiveRows[V]) => string;
}) {
  const query = useArchive(source);
  const load = useLumenLoad(query);
  const [config, setConfig] = useState(() => view(title, initial));
  const crumbs = useMailboxCrumbs('Panes', title);
  // An empty tab says so inside the pane; the tabs stay so another can be picked.
  const empty = isEmpty(query) && <EmptyState icon={icon} title={`No ${title === 'Time' ? 'months' : title.toLowerCase()} in this mailbox`} />;
  return (
    <LumenLayout
      crumbs={crumbs}
      intro={intro}
      domain={domain}
      config={config}
      rows={query.data ?? []}
      load={load}
      onConfigChange={setConfig}
      rowTitle={rowTitle}
      state={empty || undefined}
    />
  );
}

const SendersPane = ({ intro }: { intro: ReactNode }) => (
  <RollupPage
    title="Senders" icon={UsersIcon} source="senders" domain={SENDERS} rowTitle={(r) => r.addr} intro={intro}
    initial={{ columns: ['from', 'name', 'n', 'size_mb', 'first', 'last'], sort: { key: 'n', desc: true } }}
  />
);

const DomainsPane = ({ intro }: { intro: ReactNode }) => (
  <RollupPage
    title="Domains" icon={GlobeIcon} source="domains" domain={DOMAINS} rowTitle={(r) => r.domain} intro={intro}
    initial={{ columns: ['domain', 'n', 'size_mb'], sort: { key: 'n', desc: true } }}
  />
);

const LabelsPane = ({ intro }: { intro: ReactNode }) => (
  <RollupPage
    title="Labels" icon={TagIcon} source="labels" domain={LABELS} rowTitle={labelName} intro={intro}
    initial={{ columns: ['label', 'type', 'n', 'size_mb'], sort: { key: 'n', desc: true } }}
  />
);

const TimePane = ({ intro }: { intro: ReactNode }) => (
  <RollupPage
    title="Time" icon={CalendarClockIcon} source="months" domain={MONTHS} rowTitle={(r) => monthName(r.month)} intro={intro}
    initial={{
      shape: 'group',
      group: { fields: ['year'], default: 'year' },
      columns: ['date', 'n', 'size_mb'],
      sort: { key: 'date', desc: true },
      cards: [{ id: 'per_month', title: 'Messages per month', kind: 'chart', style: 'bars', date: 'date', values: ['n'], bucket: 'month', agg: 'sum', w: 6 }, TABLE],
    }}
  />
);

/** Panes: the mailbox rolled up by sender, domain, label and month, one tab each. */
export const PANE_TABS: LumenTab<'senders' | 'domains' | 'labels' | 'time'>[] = [
  { value: 'senders', label: 'Senders', icon: UsersIcon },
  { value: 'domains', label: 'Domains', icon: GlobeIcon },
  { value: 'labels', label: 'Labels', icon: TagIcon },
  { value: 'time', label: 'Time', icon: CalendarClockIcon },
];
const PANES = { senders: SendersPane, domains: DomainsPane, labels: LabelsPane, time: TimePane };

export function PanesPage() {
  const [tab, setTab] = useTab(PANE_TABS);
  const Pane = PANES[tab];
  return <Pane key={tab} intro={<LumenTabs tabs={PANE_TABS} value={tab} onChange={setTab} />} />;
}
