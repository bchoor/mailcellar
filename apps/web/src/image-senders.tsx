// Senders whose remote images show without asking: read once, kept with the app's other answers,
// changed from a message's "Show images" menu or Settings > Images. A rule counts only for a
// sender Gmail confirmed (imageRule), so a copied From line can't load images.
import { apiJson, IntegrationRow, LumenConfirm, lumenToast, usePrefs } from '@columenlabs/lumen-ui';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import type { ImageSender, ImageSenderKind } from '@mailcellar/schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageOffIcon } from 'lucide-react';
import { useState } from 'react';

const KEY = ['image-senders'];
const path = (kind: ImageSenderKind, value: string) => `/api/image-senders/${kind}/${encodeURIComponent(value)}`;

/** The list. Until it answers (or if it fails), no rule matches and images stay blocked. */
export function useImageSenders() {
  return useQuery({ queryKey: KEY, queryFn: () => apiJson<ImageSender[]>('/api/image-senders', undefined, 'images.list'), staleTime: 60_000 });
}

/** Adds or removes a rule; the answer is the list as saved. */
export function useImageSenderChange() {
  const client = useQueryClient();
  const send = async (method: 'PUT' | 'DELETE', kind: ImageSenderKind, value: string) =>
    client.setQueryData(KEY, await apiJson<ImageSender[]>(path(kind, value), { method }, `images.${method === 'PUT' ? 'add' : 'remove'}`));
  return {
    add: async (kind: ImageSenderKind, value: string) => {
      try {
        await send('PUT', kind, value);
        lumenToast.undo(`Images from ${value} show`, () => void send('DELETE', kind, value).catch(() => lumenToast.error(`Couldn't undo for ${value}`)));
      } catch {
        lumenToast.error(`Couldn't save ${value}`);
      }
    },
    remove: async (kind: ImageSenderKind, value: string) => {
      try {
        await send('DELETE', kind, value);
        lumenToast.undo(`Images from ${value} are blocked`, () => void send('PUT', kind, value).catch(() => lumenToast.error(`Couldn't undo for ${value}`)));
      } catch {
        lumenToast.error(`Couldn't remove ${value}`);
      }
    },
  };
}

/** Settings > Images: one row per rule, opening in place to say what it covers and to remove it. */
export function ImageSettings() {
  const list = useImageSenders();
  const { remove } = useImageSenderChange();
  const { timeZone } = usePrefs();
  const [open, setOpen] = useState<string | null>(null);
  const day = (iso: string) => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone }).format(new Date(iso));
  const rows = list.data ?? [];
  return (
    <div className="flex flex-col gap-3">
      {list.isError && <p className="text-sm text-destructive">Couldn't load the list.</p>}
      {rows.length === 0 && list.isSuccess && (
        <p className="text-sm text-muted-foreground">None yet. On a message, open the menu beside Show images and pick Always.</p>
      )}
      <div>
        {rows.map((r) => {
          const id = `${r.kind}:${r.value}`;
          return (
            <IntegrationRow
              key={id}
              name={r.value}
              meta={`Added ${day(r.addedAt)}`}
              badge={<Badge variant="secondary">{r.kind === 'domain' ? 'Domain' : 'Address'}</Badge>}
              open={open === id}
              onOpenChange={(o: boolean) => setOpen(o ? id : null)}
            >
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  {r.kind === 'domain'
                    ? `Images show in mail from ${r.value} and its subdomains, when Gmail confirmed the sender.`
                    : `Images show in mail from ${r.value}, when Gmail confirmed the sender.`}
                </p>
                <div className="flex gap-2">
                  <LumenConfirm
                    title={`Stop showing images from ${r.value}?`}
                    description="Its messages open with images blocked again."
                    action="Remove"
                    busyAction="Removing…"
                    destructive
                    onConfirm={() => remove(r.kind, r.value)}
                  >
                    <Button size="sm" variant="outline">
                      <ImageOffIcon /> Remove
                    </Button>
                  </LumenConfirm>
                </div>
              </div>
            </IntegrationRow>
          );
        })}
      </div>
    </div>
  );
}
