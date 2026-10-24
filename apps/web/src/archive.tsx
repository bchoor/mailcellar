// The archive pages. Each reads its own rows from the mailbox's rollups (/api/archive/*),
// so no page loads every message: Senders reads senders, Time reads months, and so on.
import { LumenLayout, LumenSavedWidget, Tile, TileRow, useLumenLoad, type LumenLoad, type ViewDomain } from '@columenlabs/lumen-ui';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@columenlabs/lumen-ui/ui/empty';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import { type CustomViewConfig, customViewConfigSchema } from '@columenlabs/lumen-ui-types/views';
import type { ArchiveRows, ArchiveView, DomainRow, LabelRow, MessageRow, MonthRow, SenderRow } from '@mailcellar/schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AtSignIcon,
  CalendarClockIcon,
  CalendarIcon,
  GlobeIcon,
  type LucideIcon,
  HardDriveIcon,
  MailIcon,
  PaperclipIcon,
  SearchIcon,
  TagIcon,
  UserIcon,
} from 'lucide-react';
import { type ReactNode, useDeferredValue, useState } from 'react';

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

const NO_MAIL = (
  <EmptyState icon={MailIcon} title="No mail yet">
    Add a Gmail account in Settings ▸ Accounts, and the archive fills as the backfill runs.
  </EmptyState>
);
/** The empty state once a rollup has loaded with no rows; nothing while it loads or fails. */
const isEmpty = (query: { data?: unknown[] }) => !!query.data && !query.data.length;
/** A page of an archive with nothing in it yet: the empty state alone, no charts or totals. */
const EmptyPage = ({ title }: { title: string }) => (
  <LumenLayout crumbs={[{ label: title }]} cards={[{ id: 'empty', title, kind: 'own', w: 6, link: false, children: NO_MAIL }]} />
);

function useArchive<V extends ArchiveView>(view: V, q = '') {
  return useQuery({
    queryKey: ['archive', view, q],
    queryFn: async (): Promise<ArchiveRows[V][]> => {
      const res = await fetch(`/api/archive/${view}${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      if (!res.ok) throw new Error(`Couldn't load ${view} (${res.status})`);
      return res.json();
    },
    placeholderData: keepPreviousData,
  });
}

// Labels are IDs on a message; the Labels rollup names them.
function useLabelNames() {
  const labels = useArchive('labels');
  const names = new Map((labels.data ?? []).map((l) => [l.id, labelName(l)]));
  return (ids: string[]) => ids.map((id) => names.get(id) ?? id);
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
    { key: 'type', label: 'Kind', icon: TagIcon, value: (r) => (r.type === 'system' ? 'Gmail' : 'Yours'), format: 'text', filterable: true, groupable: true },
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
    { key: 'first', label: 'First', icon: CalendarIcon, value: (r) => day(r.firstTs), format: 'text', render: (r) => dayText(r.firstTs) },
    { key: 'last', label: 'Latest', icon: CalendarIcon, value: (r) => day(r.lastTs), format: 'text', render: (r) => dayText(r.lastTs) },
  ],
} as ViewDomain<SenderRow>;

type MessageView = MessageRow & { labelNames: string[] };
const MESSAGES: ViewDomain<MessageView> = {
  id: 'messages',
  rowKey: (r) => r.id,
  text: (r) => [r.subject, r.fromAddr, r.fromName],
  fields: [
    { key: 'date', label: 'Date', icon: CalendarIcon, value: (r) => day(r.ts), format: 'text', render: (r) => dayText(r.ts) },
    { key: 'from', label: 'Sender', icon: AtSignIcon, value: (r) => r.fromAddr, format: 'text', filterable: true, groupable: true },
    { key: 'domain', label: 'Domain', icon: GlobeIcon, value: (r) => r.fromAddr.split('@')[1] ?? '', format: 'text', filterable: true, groupable: true },
    { key: 'subject', label: 'Subject', icon: MailIcon, value: (r) => r.subject, format: 'text' },
    { key: 'label', label: 'Labels', icon: TagIcon, value: (r) => r.labelNames.join(', '), format: 'text', filterable: true, groupable: true },
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
  // An empty archive has no totals or charts worth drawing: say so once.
  if (isEmpty(months)) return <EmptyPage title="Overview" />;
  return (
    <LumenLayout
      crumbs={[{ label: 'Overview' }]}
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

export function MessagesPage() {
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const messages = useArchive('messages', q);
  const labelNames = useLabelNames();
  const load = useLumenLoad(messages);
  const [config, setConfig] = useState(() =>
    view('Messages', { columns: ['date', 'from', 'subject', 'label', 'size_kb', 'attachments'], sort: { key: 'date', desc: true } }),
  );
  const rows = (messages.data ?? []).map((m) => ({ ...m, labelNames: labelNames(m.labels) }));
  const loaded = !!messages.data && !messages.isPlaceholderData;
  if (loaded && !rows.length && !q) return <EmptyPage title="Messages" />;
  const noMatch = loaded && !rows.length && (
    <EmptyState icon={SearchIcon} title={`No mail matches “${q}”`}>
      Search looks at the subject, the sender and the first lines of each message.
    </EmptyState>
  );
  return (
    <LumenLayout
      crumbs={[{ label: 'Messages' }]}
      meta={loaded && rows.length ? <span className="text-xs text-muted-foreground">{q ? `${count(rows.length)} matching` : `Newest ${count(rows.length)}`}</span> : undefined}
      domain={MESSAGES}
      config={config}
      rows={rows}
      load={load}
      onConfigChange={setConfig}
      rowTitle={(r) => r.subject}
      state={noMatch || undefined}
      // One search box: it searches the whole mailbox, where the view's filter would only see the rows shown.
      hideFilter
      viewTools={
        <div className="relative w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8"
            placeholder="Search all mail"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search all mail"
          />
        </div>
      }
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
  if (isEmpty(query)) return <EmptyPage title={title} />;
  return (
    <LumenLayout
      crumbs={[{ label: title }]}
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
