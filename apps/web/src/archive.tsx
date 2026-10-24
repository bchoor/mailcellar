// The archive pages. Each reads its own rows from the mailbox's rollups (/api/archive/*),
// so no page loads every message: Senders reads senders, Time reads months, and so on.
import { LumenLayout, LumenSavedWidget, useLumenLoad, type LumenLoad, type ViewDomain } from '@columenlabs/lumen-ui';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import { type CustomViewConfig, customViewConfigSchema } from '@columenlabs/lumen-ui-types/views';
import type { ArchiveRows, ArchiveView, DomainRow, LabelRow, MessageRow, MonthRow, SenderRow } from '@mailcellar/schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AtSignIcon,
  CalendarClockIcon,
  CalendarIcon,
  GlobeIcon,
  HardDriveIcon,
  MailIcon,
  PaperclipIcon,
  SearchIcon,
  TagIcon,
  UserIcon,
} from 'lucide-react';
import { useDeferredValue, useState } from 'react';

const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10;
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

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
  const names = new Map((labels.data ?? []).map((l) => [l.id, l.name]));
  return (ids: string[]) => ids.map((id) => names.get(id) ?? id);
}

const view = (name: string, over: Record<string, unknown>): CustomViewConfig => ({
  name,
  ...customViewConfigSchema.parse(over),
});
const TABLE = { id: 'table', kind: 'table', style: 'table', w: 6 };
const n = { key: 'n', label: 'Messages', icon: MailIcon, value: (r: { n: number }) => r.n, format: 'integer', aggregate: 'sum' } as const;
const size = { key: 'size_mb', label: 'Size (MB)', icon: HardDriveIcon, value: (r: { bytes: number }) => mb(r.bytes), format: 'number', aggregate: 'sum' } as const;

// Overview and Time: one row a month.
const MONTHS: ViewDomain<MonthRow> = {
  id: 'months',
  rowKey: (r) => r.month,
  fields: [
    { key: 'date', label: 'Month', icon: CalendarIcon, value: (r) => `${r.month}-01`, format: 'text' },
    { key: 'year', label: 'Year', icon: CalendarClockIcon, value: (r) => r.month.slice(0, 4), format: 'text', filterable: true, groupable: true },
    n,
    size,
  ],
} as ViewDomain<MonthRow>;

const LABELS: ViewDomain<LabelRow> = {
  id: 'labels',
  rowKey: (r) => r.id,
  text: (r) => [r.name],
  fields: [
    { key: 'label', label: 'Label', icon: TagIcon, value: (r) => r.name, format: 'text', filterable: true, groupable: true },
    { key: 'type', label: 'Kind', icon: TagIcon, value: (r) => (r.type === 'system' ? 'Gmail' : 'Yours'), format: 'text', filterable: true, groupable: true },
    n,
    size,
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
    { key: 'first', label: 'First', icon: CalendarIcon, value: (r) => day(r.firstTs), format: 'text' },
    { key: 'last', label: 'Latest', icon: CalendarIcon, value: (r) => day(r.lastTs), format: 'text' },
  ],
} as ViewDomain<SenderRow>;

type MessageView = MessageRow & { labelNames: string[] };
const MESSAGES: ViewDomain<MessageView> = {
  id: 'messages',
  rowKey: (r) => r.id,
  text: (r) => [r.subject, r.fromAddr, r.fromName],
  fields: [
    { key: 'date', label: 'Date', icon: CalendarIcon, value: (r) => day(r.ts), format: 'text' },
    { key: 'from', label: 'Sender', icon: AtSignIcon, value: (r) => r.fromAddr, format: 'text', filterable: true, groupable: true },
    { key: 'domain', label: 'Domain', icon: GlobeIcon, value: (r) => r.fromAddr.split('@')[1] ?? '', format: 'text', filterable: true, groupable: true },
    { key: 'subject', label: 'Subject', icon: MailIcon, value: (r) => r.subject, format: 'text' },
    { key: 'label', label: 'Labels', icon: TagIcon, value: (r) => r.labelNames.join(', '), format: 'text', filterable: true, groupable: true },
    { key: 'size_mb', label: 'Size (MB)', icon: HardDriveIcon, value: (r) => mb(r.size), format: 'number', aggregate: 'sum', filterable: true },
    { key: 'attachments', label: 'Attachments', icon: PaperclipIcon, value: (r) => r.attachments, format: 'integer', aggregate: 'sum', filterable: true },
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
  const load = useLumenLoad(months);
  const labelsLoad = useLumenLoad(labels);
  const domainsLoad = useLumenLoad(domains);
  const [config, setConfig] = useState(() =>
    view('Overview', {
      columns: ['date', 'n', 'size_mb'],
      sort: { key: 'date', desc: true },
      cards: [
        {
          id: 'summary', kind: 'metric', style: 'row', w: 6,
          tiles: [
            { key: 'msgs', label: 'Messages', field: 'n', agg: 'sum' },
            { key: 'size', label: 'Size (MB)', field: 'size_mb', agg: 'sum' },
            { key: 'years', label: 'Years', field: 'year', agg: 'distinct' },
          ],
        },
        { id: 'per_year', title: 'Messages per year', kind: 'chart', style: 'bars', date: 'date', values: ['n'], bucket: 'year', agg: 'sum', w: 6 },
        TABLE,
      ],
    }),
  );
  const userLabels = (labels.data ?? []).filter((l) => l.type === 'user');
  return (
    <LumenLayout
      crumbs={[{ label: 'Overview' }]}
      domain={MONTHS}
      config={config}
      rows={months.data ?? []}
      load={load}
      onConfigChange={setConfig}
      rowTitle={(r) => r.month}
      lead={[
        {
          id: 'by_label', title: 'By label', kind: 'own', w: 3,
          children: <RollupWidget title="By label" domain={LABELS} rows={userLabels} load={labelsLoad} card={{ id: 'by_label', kind: 'allocation', style: 'donut', by: 'label', value: 'n' }} />,
        },
        {
          id: 'by_domain', title: 'Top domains', kind: 'own', w: 3,
          children: <RollupWidget title="Top domains" domain={DOMAINS} rows={(domains.data ?? []).slice(0, 10)} load={domainsLoad} card={{ id: 'by_domain', kind: 'allocation', style: 'bar_list', by: 'domain', value: 'n' }} />,
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
    view('Messages', { columns: ['date', 'from', 'subject', 'label', 'size_mb', 'attachments'], sort: { key: 'date', desc: true } }),
  );
  const rows = (messages.data ?? []).map((m) => ({ ...m, labelNames: labelNames(m.labels) }));
  return (
    <LumenLayout
      crumbs={[{ label: 'Messages' }]}
      meta={<span className="text-xs text-muted-foreground">{q ? `${rows.length} matching` : `Newest ${rows.length}`}</span>}
      domain={MESSAGES}
      config={config}
      rows={rows}
      load={load}
      onConfigChange={setConfig}
      rowTitle={(r) => r.subject}
      viewTools={
        <div className="relative w-64">
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
    title="Labels" source="labels" domain={LABELS} rowTitle={(r) => r.name}
    initial={{
      columns: ['label', 'type', 'n', 'size_mb'],
      sort: { key: 'n', desc: true },
      cards: [{ id: 'label_share', title: 'Share by label', kind: 'allocation', style: 'donut', by: 'label', value: 'n', w: 3 }, TABLE],
    }}
  />
);

export const TimePage = () => (
  <RollupPage
    title="Time" source="months" domain={MONTHS} rowTitle={(r) => r.month}
    initial={{
      shape: 'group',
      group: { fields: ['year'], default: 'year' },
      columns: ['date', 'n', 'size_mb'],
      sort: { key: 'date', desc: true },
      cards: [{ id: 'per_month', title: 'Messages per month', kind: 'chart', style: 'bars', date: 'date', values: ['n'], bucket: 'month', agg: 'sum', w: 6 }, TABLE],
    }}
  />
);
