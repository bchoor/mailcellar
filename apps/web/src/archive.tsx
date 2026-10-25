// The archive pages, for the mailbox picked in the sidebar. Each reads its own rows from that
// mailbox's rollups (/api/accounts/:id/archive/*), so no page loads every message.
import { type FilterToken, LumenLayout, LumenSavedWidget, Tile, TileRow, useLumenLoad, usePrefs, type LumenLoad, type ViewDomain } from '@columenlabs/lumen-ui';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@columenlabs/lumen-ui/ui/empty';
import { Tooltip, TooltipContent, TooltipTrigger } from '@columenlabs/lumen-ui/ui/tooltip';
import { CONTAINS_KEY, type CustomViewConfig, customViewConfigSchema } from '@columenlabs/lumen-ui-types/views';
import {
  type ArchiveRows,
  type ArchiveView,
  type DomainRow,
  type LabelColors,
  type LabelRow,
  MESSAGE_PAGE_SIZES,
  type MessageFilter,
  type MessagePage,
  type MessageRow,
  type MonthRow,
  type SenderRow,
} from '@mailcellar/schema';
import { useQuery } from '@tanstack/react-query';
import {
  AtSignIcon,
  CalendarClockIcon,
  CalendarIcon,
  GlobeIcon,
  type LucideIcon,
  HardDriveIcon,
  InboxIcon,
  MailIcon,
  MailOpenIcon,
  PaperclipIcon,
  SearchIcon,
  TagIcon,
  UserIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useMailbox, useMailboxCrumbs } from './mailbox';
import { daySpan, localDay, type Period, periodOf, periodSpan, periods } from './period';

// Sizes stay exact here and round only when shown, so a total matches the sum of its rows.
const KB = 1024;
const MB = KB * 1024;
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/** A sortable ISO day for the value, `Sep 29, 2026` on screen. */
const dayText = (ts: number) => DAY.format(new Date(ts));
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
/** `2026-09` → `Sep 2026`. */
const monthName = (month: string) => MONTH.format(new Date(`${month}-01T00:00:00Z`));
export const count = (n: number) => n.toLocaleString('en-US');
/** Bytes as people read them: 812 KB, 977 MB, 1.2 GB. */
export function bytes(b: number) {
  if (b >= 1024 * MB) return `${(b / (1024 * MB)).toFixed(1)} GB`;
  if (b >= MB) return `${Math.round(b / MB)} MB`;
  return b ? `${Math.max(1, Math.round(b / KB))} KB` : '0 KB';
}

// Gmail's system labels come as INBOX, SENT, CATEGORY_PROMOTIONS: shown as Inbox, Sent, Promotions.
export function labelName(l: { name: string; type: string }) {
  if (l.type !== 'system') return l.name;
  const word = l.name.replace(/^CATEGORY_/, '').toLowerCase();
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
      {account
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

// Labels are IDs on a message; the Labels rollup names them.
function useLabelNames() {
  const labels = useArchive('labels');
  const names = new Map((labels.data ?? []).map((l) => [l.id, labelName(l)]));
  return (ids: string[]) => ids.map((id) => names.get(id) ?? id);
}

/** Gmail's inbox tabs: a message is in one, Primary when it carries none of the other four. */
const CATEGORIES = ['Promotions', 'Social', 'Updates', 'Forums'] as const;
const CATEGORY_IDS = CATEGORIES.map((c) => `CATEGORY_${c.toUpperCase()}`);
const categoryOf = (ids: string[]) => CATEGORIES.find((c) => ids.includes(`CATEGORY_${c.toUpperCase()}`)) ?? 'Primary';

/** A message's own labels (the person's, not Gmail's built-in ones), each with its Gmail colours. */
function useUserLabels() {
  const id = useMailbox().account?.id ?? null;
  const labels = useArchive('labels');
  const colors = useQuery({
    queryKey: ['label-colors', id],
    queryFn: async (): Promise<LabelColors> => {
      if (!id) return {};
      const res = await fetch(`/api/accounts/${id}/label-colors`);
      // No colours is fine: the chips show plain.
      return res.ok ? res.json() : {};
    },
    staleTime: Infinity,
  });
  const mine = new Map((labels.data ?? []).filter((l) => l.type === 'user').map((l) => [l.id, l.name]));
  return (ids: string[]): Chip[] => [
    ...FOLDERS.filter((f) => ids.includes(f.id)).map(({ id: _, ...c }) => c),
    ...ids.filter((x) => mine.has(x)).map((x) => ({ name: mine.get(x)!, ...colors.data?.[x] })),
  ];
}
interface Chip {
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
        <Badge key={c.name} variant={c.bg ? 'default' : 'secondary'} className="max-w-28 truncate" style={c.bg ? { background: c.bg, color: c.fg } : undefined} title={c.name}>
          {c.name}
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
const size = { key: 'size_mb', label: 'Size (MB)', icon: HardDriveIcon, value: (r: { bytes: number }) => r.bytes / MB, format: 'rounded', aggregate: 'sum' } as const;

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
    { key: 'type', label: 'Type', icon: TagIcon, value: (r) => (r.type === 'system' ? 'Built-in' : 'Yours'), format: 'text', filterable: true, groupable: true },
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
    { key: 'name', label: 'Name', icon: UserIcon, value: (r) => r.name, format: 'text' },
    { key: 'domain', label: 'Domain', icon: GlobeIcon, value: (r) => r.addr.split('@')[1] ?? '', format: 'text', filterable: true, groupable: true },
    n,
    size,
    { key: 'first', label: 'First email', icon: CalendarIcon, value: (r) => day(r.firstTs), format: 'text', render: (r) => dayText(r.firstTs) },
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

type MessageView = MessageRow & { labelNames: string[]; chips: Chip[]; unread: boolean; important: boolean; category: string; period: string; day: string };
const MESSAGES: ViewDomain<MessageView> = {
  id: 'messages',
  rowKey: (r) => r.id,
  text: (r) => [r.subject, r.fromAddr, r.fromName],
  fields: [
    // The day in the person's time zone, like Period.
    { key: 'date', label: 'Date', icon: CalendarIcon, value: (r) => r.day, format: 'text', render: (r) => dayText(Date.parse(`${r.day}T00:00:00Z`)) },
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
        <span className={`flex items-center gap-1 ${r.unread ? 'font-semibold' : ''}`}>
          {r.important && <span className="text-warning" title="Important">★</span>}
          <Clip text={r.subject} w="22rem" />
        </span>
      ),
    },
    { key: 'category', label: 'Category', icon: InboxIcon, value: (r) => r.category, format: 'text', filterable: true, groupable: true },
    {
      key: 'is', label: 'Read', icon: MailOpenIcon, value: (r) => (r.unread ? 'Unread' : 'Read'), format: 'text', filterable: true, groupable: true,
      // is:spam and is:trash, as in Gmail, offered when the page has such mail.
      values: (r) => [r.unread ? 'Unread' : 'Read', ...FOLDERS.filter((f) => r.labels.includes(f.id)).map((f) => f.name)],
    },
    { key: 'period', label: 'Period', icon: CalendarClockIcon, value: (r) => r.period, format: 'text', filterable: true, groupable: true },
    { key: 'label', label: 'Labels', icon: TagIcon, value: (r) => r.chips.map((c) => c.name).join(', '), values: (r) => r.chips.map((c) => c.name), format: 'text', filterable: true, groupable: true, render: (r) => <Chips chips={r.chips} /> },
    { key: 'size_kb', label: 'Size (KB)', icon: HardDriveIcon, value: (r) => Math.max(1, r.size / KB), format: 'rounded', aggregate: 'sum', filterable: true },
    { key: 'attachments', label: 'Attachments', icon: PaperclipIcon, value: (r) => r.attachments, format: 'rounded', aggregate: 'sum', filterable: true },
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

export function OverviewPage() {
  const months = useArchive('months');
  const labels = useArchive('labels');
  const domains = useArchive('domains');
  const senders = useArchive('senders');
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
  const userLabels = (labels.data ?? []).filter((l) => l.type === 'user');
  const crumbs = useMailboxCrumbs('Overview');
  // An empty archive has no totals or charts worth drawing: say so once.
  if (isEmpty(months)) return <EmptyPage title="Overview" />;
  return (
    <LumenLayout
      crumbs={crumbs}
      domain={MONTHS}
      config={config}
      rows={rows}
      load={load}
      onConfigChange={setConfig}
      rowTitle={(r) => monthName(r.month)}
      lead={[
        {
          id: 'totals', title: 'In your archive', kind: 'own', w: 6, link: false,
          children: (
            <TileRow className="grid grid-cols-2 lg:flex">
              <Tile className="lg:flex-1" label="Messages" value={count(total)} />
              <Tile className="lg:flex-1" label="Size" value={bytes(size)} />
              <Tile className="lg:flex-1" label="Senders" value={senders.data ? count(senders.data.length) : '—'} />
              <Tile className="lg:flex-1" label="Years" value={count(years.size)} caption={first ? `since ${monthName(first)}` : undefined} />
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

export function MessagesPage() {
  const id = useMailbox().account?.id ?? null;
  const { timeZone } = usePrefs();
  const labelNames = useLabelNames();
  const userLabels = useUserLabels();
  const [tokens, setTokens] = useState<FilterToken[]>([]);
  const [size, setSize] = useState(50);
  // Page n starts after cursors[n]; each page read adds the next one's.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState(0);
  // The server sorts by date only (its index is on time): newest first unless the header says oldest.
  const [asc, setAsc] = useState(false);
  const list = useMemo(() => periods(Date.now(), timeZone), [timeZone]);
  const filters = useMemo(() => toFilters(tokens, list, timeZone), [tokens, list, timeZone]);
  const key = JSON.stringify(filters);
  // A new filter or page size starts again from the newest.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets when the filter, size or sort changes.
  useEffect(() => {
    setCursors([null]);
    setPage(0);
  }, [key, size, id, asc]);
  const cursor = cursors[page] ?? null;
  const messages = useQuery({
    queryKey: ['messages', id, key, size, cursor, asc],
    queryFn: async (): Promise<MessagePage | null> => {
      if (!id) return null;
      const qs = new URLSearchParams({ size: String(size), ...(filters.length ? { f: key } : {}), ...(cursor ? { cursor } : {}), ...(asc ? { asc: '1' } : {}) });
      const res = await fetch(`/api/accounts/${id}/messages?${qs}`);
      if (!res.ok) throw new Error(`Couldn't load messages (${res.status})`);
      return res.json();
    },
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === id && prevQuery?.queryKey[2] === key ? prev : undefined),
  });
  const data = messages.data;
  useEffect(() => {
    if (!data || messages.isPlaceholderData) return;
    setCursors((c) => (c[page + 1] === data.next ? c : [...c.slice(0, page + 1), data.next]));
  }, [data, messages.isPlaceholderData, page]);
  const load = useLumenLoad(messages);
  const [config, setConfig] = useState(() =>
    view('Messages', { columns: ['date', 'from', 'subject', 'category', 'label', 'size_kb', 'attachments'], sort: { key: 'date', desc: true } }),
  );
  const rows = (data?.rows ?? []).map((m) => ({
    ...m,
    labelNames: labelNames(m.labels),
    chips: userLabels(m.labels),
    unread: m.labels.includes('UNREAD'),
    important: m.labels.includes('IMPORTANT'),
    category: categoryOf(m.labels),
    period: periodOf(list, m.ts),
    day: localDay(m.ts, timeZone),
  }));
  const loaded = !!data && !messages.isPlaceholderData;
  const crumbs = useMailboxCrumbs('Messages');
  if (loaded && !rows.length && !filters.length && page === 0) return <EmptyPage title="Messages" />;
  const noMatch = loaded && !rows.length && (
    <EmptyState icon={SearchIcon} title="No mail matches these filters">
      {data?.partial ? 'None in the mail searched so far. Next page keeps searching.' : 'Text search looks at the subject, the sender and the first lines of each message.'}
    </EmptyState>
  );
  const seen = page * size + rows.length;
  const meta =
    loaded &&
    [
      data.total !== null ? `${count(data.total)} messages` : `${count(seen)}${data.next ? '+' : ''} matching`,
      data.partial ? 'searching on' : '',
      data.unindexed ? `${count(data.unindexed)} copied month${data.unindexed === 1 ? '' : 's'} not searchable yet` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  return (
    <LumenLayout
      crumbs={crumbs}
      meta={meta ? <span className="text-xs text-muted-foreground">{meta}</span> : undefined}
      domain={MESSAGES}
      config={config}
      rows={rows}
      load={load}
      onConfigChange={setConfig}
      rowTitle={(r) => r.subject}
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
        sorts: ['date'],
        onSort: (s) => setAsc(s?.key === 'date' && !s.desc),
      }}
    />
  );
}

function RollupPage<V extends 'senders' | 'domains' | 'labels' | 'months'>({
  title, source, domain, initial, rowTitle,
}: {
  title: string;
  source: V;
  domain: ViewDomain<ArchiveRows[V]>;
  initial: Record<string, unknown>;
  rowTitle: (r: ArchiveRows[V]) => string;
}) {
  const query = useArchive(source);
  const load = useLumenLoad(query);
  const [config, setConfig] = useState(() => view(title, initial));
  const crumbs = useMailboxCrumbs(title);
  if (isEmpty(query)) return <EmptyPage title={title} />;
  return (
    <LumenLayout
      crumbs={crumbs}
      domain={domain}
      config={config}
      rows={query.data ?? []}
      load={load}
      onConfigChange={setConfig}
      rowTitle={rowTitle}
    />
  );
}

export const SendersPage = () => (
  <RollupPage
    title="Senders" source="senders" domain={SENDERS} rowTitle={(r) => r.addr}
    initial={{ columns: ['from', 'name', 'n', 'size_mb', 'first', 'last'], sort: { key: 'n', desc: true } }}
  />
);

export const DomainsPage = () => (
  <RollupPage
    title="Domains" source="domains" domain={DOMAINS} rowTitle={(r) => r.domain}
    initial={{ columns: ['domain', 'n', 'size_mb'], sort: { key: 'n', desc: true } }}
  />
);

export const LabelsPage = () => (
  <RollupPage
    title="Labels" source="labels" domain={LABELS} rowTitle={labelName}
    initial={{ columns: ['label', 'type', 'n', 'size_mb'], sort: { key: 'n', desc: true } }}
  />
);

export const TimePage = () => (
  <RollupPage
    title="Time" source="months" domain={MONTHS} rowTitle={(r) => monthName(r.month)}
    initial={{
      shape: 'group',
      group: { fields: ['year'], default: 'year' },
      columns: ['date', 'n', 'size_mb'],
      sort: { key: 'date', desc: true },
      cards: [{ id: 'per_month', title: 'Messages per month', kind: 'chart', style: 'bars', date: 'date', values: ['n'], bucket: 'month', agg: 'sum', w: 6 }, TABLE],
    }}
  />
);
