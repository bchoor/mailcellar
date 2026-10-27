// Gmail settings for the mailbox picked in the sidebar, read live from Gmail on each visit:
// its filters, and the mailing lists and newsletters it receives.
import { LumenLayout, useLumenLoad, type ViewDomain } from '@columenlabs/lumen-ui';
import { type CustomViewConfig, customViewConfigSchema } from '@columenlabs/lumen-ui-types/views';
import {
  type FiltersResponse,
  filterActions,
  filterCriteria,
  GMAIL_ERRORS,
  type GmailError,
  type Subscription,
  type SubscriptionsResponse,
} from '@mailcellar/schema';
import { useQuery } from '@tanstack/react-query';
import { AtSignIcon, CalendarIcon, FilterIcon, GlobeIcon, ListIcon, MailIcon, NewspaperIcon, UserIcon, ZapIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from './archive';
import { count, day } from './format';
import { useMailbox, useMailboxCrumbs } from './mailbox';


/** One Gmail settings read for the picked mailbox; a refusal throws its words. */
function useGmail<T>(page: 'filters' | 'subscriptions') {
  const id = useMailbox().account?.id ?? null;
  return useQuery({
    queryKey: ['gmail', id, page],
    enabled: !!id,
    queryFn: async (): Promise<T> => {
      const res = await fetch(`/api/accounts/${id}/${page}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(GMAIL_ERRORS[(body as { error?: GmailError }).error ?? 'gmail'] ?? GMAIL_ERRORS.gmail);
      return body as T;
    },
  });
}

const view = (name: string, over: Record<string, unknown>): CustomViewConfig => ({ name, ...customViewConfigSchema.parse(over) });

/** The whole page as one card: no mailbox, a failed read, or nothing found. */
const Notice = ({ title, icon, heading, text }: { title: string; icon: typeof MailIcon; heading: string; text: string }) => (
  <LumenLayout
    crumbs={useMailboxCrumbs('Gmail settings', title)}
    cards={[{ id: 'notice', title, kind: 'own', w: 6, link: false, children: <EmptyState icon={icon} title={heading}>{text}</EmptyState> }]}
  />
);
const NO_MAILBOX = 'Add a Gmail account in Settings ▸ Accounts.';

interface FilterRow {
  id: string;
  when: string;
  then: string;
}

const FILTERS: ViewDomain<FilterRow> = {
  id: 'gmail_filters',
  rowKey: (r) => r.id,
  text: (r) => [r.when, r.then],
  fields: [
    { key: 'when', label: 'When', icon: FilterIcon, value: (r) => r.when, format: 'text' },
    { key: 'then', label: 'Then', icon: ZapIcon, value: (r) => r.then, format: 'text', filterable: true },
  ],
} as ViewDomain<FilterRow>;

export function FiltersPage() {
  const { account } = useMailbox();
  const query = useGmail<FiltersResponse>('filters');
  const load = useLumenLoad(query);
  const [config, setConfig] = useState(() => view('Filters', { columns: ['when', 'then'] }));
  const crumbs = useMailboxCrumbs('Gmail settings', 'Filters');
  if (!account) return <Notice title="Filters" icon={FilterIcon} heading="No mailbox yet" text={NO_MAILBOX} />;
  if (query.error) return <Notice title="Filters" icon={FilterIcon} heading="Couldn’t read filters" text={query.error.message} />;
  const data = query.data;
  if (data && !data.filters.length)
    return <Notice title="Filters" icon={FilterIcon} heading="No filters" text={`${account.email} has no Gmail filters.`} />;
  const rows = (data?.filters ?? []).map((f) => ({ id: f.id, when: filterCriteria(f), then: filterActions(f, data!.labels) }));
  return (
    <LumenLayout
      crumbs={crumbs}
      meta={data ? <span className="text-xs text-muted-foreground">{count(rows.length)} in Gmail</span> : undefined}
      domain={FILTERS}
      config={config}
      rows={rows}
      load={load}
      onConfigChange={setConfig}
      rowTitle={(r) => r.when}
    />
  );
}

const SUBSCRIPTIONS: ViewDomain<Subscription> = {
  id: 'gmail_subscriptions',
  rowKey: (r) => r.addr,
  text: (r) => [r.addr, r.name, r.listId ?? ''],
  fields: [
    { key: 'name', label: 'Name', icon: UserIcon, value: (r) => r.name || r.addr.split('@')[0], format: 'text' },
    { key: 'from', label: 'Sender', icon: AtSignIcon, value: (r) => r.addr, format: 'text', filterable: true },
    { key: 'domain', label: 'Domain', icon: GlobeIcon, value: (r) => r.addr.split('@')[1] ?? '', format: 'text', filterable: true, groupable: true },
    { key: 'list', label: 'List ID', icon: ListIcon, value: (r) => r.listId ?? '', format: 'text' },
    { key: 'n', label: 'Messages', icon: MailIcon, value: (r) => r.n, format: 'rounded', aggregate: 'sum' },
    { key: 'last', label: 'Latest', icon: CalendarIcon, value: (r) => new Date(r.lastTs).toISOString().slice(0, 10), format: 'text', render: (r) => day(r.lastTs) },
  ],
} as ViewDomain<Subscription>;

export function SubscriptionsPage() {
  const { account } = useMailbox();
  const query = useGmail<SubscriptionsResponse>('subscriptions');
  const load = useLumenLoad(query);
  const [config, setConfig] = useState(() =>
    view('Subscriptions', { columns: ['name', 'from', 'n', 'last'], sort: { key: 'n', desc: true } }),
  );
  const crumbs = useMailboxCrumbs('Gmail settings', 'Subscriptions');
  if (!account) return <Notice title="Subscriptions" icon={NewspaperIcon} heading="No mailbox yet" text={NO_MAILBOX} />;
  if (query.error) return <Notice title="Subscriptions" icon={NewspaperIcon} heading="Couldn’t read subscriptions" text={query.error.message} />;
  const data = query.data;
  if (data && !data.subscriptions.length)
    return (
      <Notice
        title="Subscriptions"
        icon={NewspaperIcon}
        heading="No subscriptions found"
        text={`None of the newest ${count(data.scanned)} messages in ${account.email} came from a mailing list or newsletter.`}
      />
    );
  return (
    <LumenLayout
      crumbs={crumbs}
      meta={data ? <span className="text-xs text-muted-foreground">From the newest {count(data.scanned)} messages</span> : undefined}
      domain={SUBSCRIPTIONS}
      config={config}
      rows={data?.subscriptions ?? []}
      load={load}
      onConfigChange={setConfig}
      rowTitle={(r) => r.name || r.addr}
    />
  );
}
