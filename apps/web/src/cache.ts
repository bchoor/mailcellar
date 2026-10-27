// Pages paint at once from the answers last saved on this device, then refresh in the background.
// Mail data (rollups, message lists) is kept until its mailbox's indexed count moves, which the
// backfill status (polled while anything copies) reports; everything else refreshes once per load.
import { savedAnswers } from '@columenlabs/lumen-ui';
import type { PersistedClient, PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import type { Query, QueryClient } from '@tanstack/react-query';
import type { BackfillStatus, Me } from '@mailcellar/schema';

/** Set by vite.config.ts: the commit this build was made from. */
declare const __BUILD__: string;

/** Query keys whose answer changes only with the mail in mailbox `key[1]`. */
const MAIL_DATA = new Set(['archive', 'found', 'messages', 'message-groups', 'message-periods', 'message-group-rows']);
/** Read once and large (message bodies, attachment text, search snippets): kept in memory only. */
const MEMORY_ONLY = new Set(['message', 'attachment-text', 'found']);

const isMailData = (q: Query) => MAIL_DATA.has(q.queryKey[0] as string);

// The kit's persister: a restore that has not answered in 1.5 s gives up and the app asks the server.
const persister = savedAnswers<PersistedClient>({ name: 'mailcellar' });

export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> = {
  persister,
  maxAge: 7 * 24 * 3600_000,
  // A new build may change an answer's shape: start clean.
  buster: __BUILD__,
  dehydrateOptions: { shouldDehydrateQuery: (q) => q.state.status === 'success' && !MEMORY_ONLY.has(q.queryKey[0] as string) },
};

/**
 * Keeps saved answers honest: after a restore, everything but mail data is asked again (the page
 * shows the saved copy meanwhile); mail data is asked again when its mailbox's indexed count
 * changes; and a different person signing in on this device starts from nothing.
 */
export function keepFresh(client: QueryClient) {
  const indexed = new Map<string, number>();
  const note = (s: BackfillStatus | undefined) => {
    const moved: string[] = [];
    for (const a of s?.accounts ?? []) {
      const was = indexed.get(a.id);
      if (was !== undefined && was !== a.totals.indexed) moved.push(a.id);
      indexed.set(a.id, a.totals.indexed);
    }
    return moved;
  };
  // While a backfill indexes, the count moves every poll: a page re-reads its mail at most once a minute.
  const last = new Map<string, number>();
  const waiting = new Set<string>();
  const refresh = (id: string) => {
    if (waiting.has(id)) return;
    const wait = Math.max(0, (last.get(id) ?? 0) + 60_000 - Date.now());
    waiting.add(id);
    setTimeout(() => {
      waiting.delete(id);
      last.set(id, Date.now());
      void client.invalidateQueries({ predicate: (q) => isMailData(q) && q.queryKey[1] === id });
    }, wait);
  };
  let who = (client.getQueryData(['me']) as Me | null | undefined)?.user.email;
  note(client.getQueryData(['backfill']));
  client.getQueryCache().subscribe((e) => {
    if (e.type !== 'updated' || e.action.type !== 'success') return;
    const key = e.query.queryKey[0];
    if (key === 'me') {
      const email = (e.query.state.data as Me | null)?.user.email;
      if (who !== undefined && email !== who) {
        // Signed out (null) or someone else: drop every saved answer but this one.
        client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
        indexed.clear();
      }
      who = email;
    }
    if (key === 'backfill') for (const id of note(e.query.state.data as BackfillStatus)) refresh(id);
  });
  void client.invalidateQueries({ predicate: (q) => !isMailData(q) });
}

/** Signing out of Access leaves this page: forget the saved answers first. */
export function forgetOnSignOut() {
  addEventListener(
    'click',
    (e) => {
      if ((e.target as Element | null)?.closest?.('a[href*="/cdn-cgi/access/logout"]')) void persister.removeClient();
    },
    true,
  );
}
