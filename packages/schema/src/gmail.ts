// Gmail settings, read live from the Gmail API for one connected account: its filters, and
// the mailing lists and newsletters it receives. Nothing here is stored.

/** A Gmail filter as users.settings.filters.list returns it. */
export interface GmailFilter {
  id: string;
  criteria: {
    from?: string;
    to?: string;
    subject?: string;
    query?: string;
    negatedQuery?: string;
    hasAttachment?: boolean;
    excludeChats?: boolean;
    size?: number;
    sizeComparison?: 'larger' | 'smaller' | 'unspecified';
  };
  action: { addLabelIds?: string[]; removeLabelIds?: string[]; forward?: string };
}

/** Response of GET /api/accounts/:id/filters: the filters, and label names by ID for their actions. */
export interface FiltersResponse {
  filters: GmailFilter[];
  labels: Record<string, string>;
}

/** One sender of list mail: messages that carry List-Unsubscribe or List-Id. */
export interface Subscription {
  addr: string;
  name: string;
  /** The List-Id, when the sender sets one. */
  listId: string | null;
  /** Messages from this sender among those scanned. */
  n: number;
  /** Newest one, ms since the epoch. */
  lastTs: number;
}

/** Response of GET /api/accounts/:id/subscriptions. */
export interface SubscriptionsResponse {
  /** How many of the newest messages were read. */
  scanned: number;
  subscriptions: Subscription[];
}

/** How many of the newest messages the Subscriptions page reads. */
export const SUBSCRIPTION_SCAN = 500;

/** Why a Gmail settings read failed, in words for the page. */
export const GMAIL_ERRORS = {
  not_found: 'This account isn’t connected.',
  token: 'Google no longer accepts this account’s connection. Remove it in Settings ▸ Accounts and add it again.',
  scope: 'This account didn’t grant Gmail access. Remove it in Settings ▸ Accounts and add it again.',
  gmail: 'Gmail didn’t answer. Try again in a minute.',
} as const;
export type GmailError = keyof typeof GMAIL_ERRORS;

const SIZE_UNITS: [number, string][] = [[1024 ** 3, 'GB'], [1024 ** 2, 'MB'], [1024, 'KB']];
const sizeText = (b: number) => {
  for (const [unit, name] of SIZE_UNITS) if (b >= unit) return `${Math.round((b / unit) * 10) / 10} ${name}`;
  return `${b} bytes`;
};

const CATEGORIES: Record<string, string> = {
  CATEGORY_PERSONAL: 'Primary',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
};

/** What a filter matches, in plain words: `From news@x.com · Has an attachment`. */
export function filterCriteria(f: GmailFilter): string {
  const c = f.criteria;
  const parts: string[] = [];
  if (c.from) parts.push(`From ${c.from}`);
  if (c.to) parts.push(`To ${c.to}`);
  if (c.subject) parts.push(`Subject has “${c.subject}”`);
  if (c.query) parts.push(`Has the words “${c.query}”`);
  if (c.negatedQuery) parts.push(`Doesn’t have “${c.negatedQuery}”`);
  if (c.hasAttachment) parts.push('Has an attachment');
  if (c.size && c.sizeComparison && c.sizeComparison !== 'unspecified')
    parts.push(`${c.sizeComparison === 'larger' ? 'Larger' : 'Smaller'} than ${sizeText(c.size)}`);
  if (c.excludeChats) parts.push('Not chats');
  return parts.join(' · ') || 'All mail';
}

/** What a filter does, in plain words: `Skip the inbox · Apply label “News”`. */
export function filterActions(f: GmailFilter, labels: Record<string, string>): string {
  const name = (id: string) => labels[id] ?? id;
  const parts: string[] = [];
  for (const id of f.action.removeLabelIds ?? [])
    parts.push(
      id === 'INBOX' ? 'Skip the inbox'
      : id === 'UNREAD' ? 'Mark as read'
      : id === 'SPAM' ? 'Never send to Spam'
      : id === 'IMPORTANT' ? 'Never mark as important'
      : `Remove label “${name(id)}”`,
    );
  for (const id of f.action.addLabelIds ?? [])
    parts.push(
      id === 'TRASH' ? 'Delete it'
      : id === 'STARRED' ? 'Star it'
      : id === 'IMPORTANT' ? 'Mark as important'
      : id in CATEGORIES ? `Categorize as ${CATEGORIES[id]}`
      : `Apply label “${name(id)}”`,
    );
  if (f.action.forward) parts.push(`Forward to ${f.action.forward}`);
  return parts.join(' · ') || 'Nothing';
}

/** `"News Co" <news@x.com>` → name and address, address lower-cased. */
export function parseFrom(from: string): { name: string; addr: string } {
  const m = from.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: (m[1] ?? '').trim(), addr: m[2].trim().toLowerCase() };
  return { name: '', addr: from.trim().toLowerCase() };
}
