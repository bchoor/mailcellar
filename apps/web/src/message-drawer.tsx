// A message opened from the Messages page, in the kit's drawer. Headers and body come from the
// message's raw file (/api/accounts/:id/messages/:mid); the row it opened from fills the title
// while that loads. The body is drawn in a frame that runs no scripts and loads no remote images
// until the person asks, or the sender is on their list (image-senders.tsx). Shown images come
// through the app's own fetcher (/api/img), so the sender never sees the reader.
import { DrawerSection, LumenDrawer, usePrefs } from '@columenlabs/lumen-ui';
import { ButtonGroup } from '@columenlabs/lumen-ui/ui/button-group';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@columenlabs/lumen-ui/ui/dropdown-menu';
import { Badge } from '@columenlabs/lumen-ui/ui/badge';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Skeleton } from '@columenlabs/lumen-ui/ui/skeleton';
import { imageRule, type MailAddress, type MessageAttachment, type MessageDetail, type MessageRow, monthOf, SHARED_MAIL_DOMAINS } from '@mailcellar/schema';
import { useQuery } from '@tanstack/react-query';
import { ToggleGroup, ToggleGroupItem } from '@columenlabs/lumen-ui/ui/toggle-group';
import { ChevronDownIcon, DownloadIcon, ImageIcon, ImageOffIcon, LayoutGridIcon, ListIcon, MailIcon, PaperclipIcon, ShieldAlertIcon, UserIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type Chip } from './archive';
import { bytes } from './format';
import { AttachmentGrid, AttachmentPreview, kindIcon, kindOf } from './attachment-preview';
import { useImageSenderChange, useImageSenders } from './image-senders';

const who = (a: MailAddress) => (a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address);
const list = (as: MailAddress[]) => as.map(who).join(', ');

/** An image, background or stylesheet the HTML would fetch from the web. */
const REMOTE = /(?:src|background|srcset)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i;

/** A remote image's address through the app's own fetcher. Attribute text may still hold `&amp;`. */
const viaFetcher = (u: string) => `${location.origin}/api/img?u=${encodeURIComponent(u.replace(/&amp;/gi, '&'))}`;

/** The HTML with every remote image pointed at the fetcher; `srcset` goes, so each image's `src` stands. */
function proxied(html: string) {
  return html
    .replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(\s(?:src|background)\s*=\s*)(["']?)\s*((?:https?:)?\/\/[^"'\s>]+)/gi, (_m, a: string, q: string, u: string) => `${a}${q}${viaFetcher(u)}`)
    .replace(/url\(\s*(&quot;|["']?)\s*((?:https?:)?\/\/[^"')\s&]+(?:&amp;[^"')\s&]+)*)/gi, (_m, q: string, u: string) => `url(${q}${viaFetcher(u)}`);
}

/** The message's HTML as its own document: no scripts (sandbox), no remote loads; with `images`, only the app's fetcher. */
function frameDoc(html: string, images: boolean) {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:${images ? " 'self'" : ''}`;
  // A refresh tag would load a page into the frame; the CSP above doesn't cover navigation.
  const page = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '');
  const body = images ? proxied(page) : page;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>html,body{margin:0;background:#fff;color:#111}body{padding:16px;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}</style></head><body>${body}</body></html>`;
}

/** The HTML body at its own height, so the drawer scrolls it with the headers. */
function HtmlBody({ html, images }: { html: string; images: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    let width = 0;
    // A message laid out wider than the frame (a fixed 600px table) zooms out to its width, as
    // mail apps do, so nothing runs off the right edge; measured again when the frame's width changes.
    const shrink = (doc: Document) => {
      if (frame.clientWidth === width) return;
      width = frame.clientWidth;
      doc.body.style.zoom = '';
      const over = doc.documentElement.scrollWidth / doc.documentElement.clientWidth;
      if (over > 1.01) doc.body.style.zoom = String(Math.floor(100 / over) / 100);
    };
    const fit = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      width = 0;
      shrink(doc);
      setHeight(Math.max(120, doc.documentElement.scrollHeight));
      observer?.disconnect();
      observer = new ResizeObserver(() => {
        shrink(doc);
        setHeight(Math.max(120, doc.documentElement.scrollHeight));
      });
      observer.observe(doc.body);
      observer.observe(frame);
    };
    frame.addEventListener('load', fit);
    return () => {
      frame.removeEventListener('load', fit);
      observer?.disconnect();
    };
  }, []);
  return (
    <iframe
      ref={ref}
      title="Message"
      // Same origin without scripts lets the page read the frame's height; nothing in it can run.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={frameDoc(html, images)}
      className="w-full rounded-md border bg-white"
      style={{ height }}
    />
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

export function MessageDrawer({ account, row, chips, rows, onClose }: { account: string; row: MessageRow | null; chips: Chip[]; rows: MessageRow[]; onClose: () => void }) {
  const { timeZone } = usePrefs();
  const [images, setImages] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each message opens with images blocked.
  useEffect(() => setImages(false), [row?.id]);
  const [at, setAt] = useState<number | null>(null);
  const [grid, setGrid] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each message opens with no preview.
  useEffect(() => setAt(null), [row?.id]);
  const month = row ? monthOf(row.ts) : '';
  const detail = useQuery({
    queryKey: ['message', account, row?.id],
    enabled: !!row,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async (): Promise<MessageDetail> => {
      const res = await fetch(`/api/accounts/${account}/messages/${row!.id}?month=${month}`);
      if (res.status === 404) throw new Error('This message is not in the raw files.');
      if (!res.ok) throw new Error(`Couldn't open this message (${res.status})`);
      return res.json();
    },
  });
  const d = detail.data;
  const when = (ts: number) =>
    new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));
  const from = d?.from ? who(d.from) : row ? (row.fromName ? `${row.fromName} <${row.fromAddr}>` : row.fromAddr) : '';
  const remote = !!d?.html && REMOTE.test(d.html);
  const senders = useImageSenders();
  const { add, remove } = useImageSenderChange();
  const sender = d?.sender ?? null;
  const rule = imageRule(senders.data ?? [], sender);
  const shown = images || !!rule;
  const ruleKind = rule && sender && rule === sender.address ? 'address' : 'domain';
  const file = (a: MessageAttachment) => `/api/accounts/${account}/messages/${row?.id}/attachments/${a.index}?month=${month}`;
  const download = file;
  const view = (a: MessageAttachment) => `${file(a)}&view=1`;
  return (
    <LumenDrawer
      open={!!row}
      onClose={onClose}
      title={row?.subject || '(no subject)'}
      description={row ? `${row.fromName || row.fromAddr} · ${when(row.ts)}` : undefined}
      dock="message"
      defaultSize="40%"
      minSize="360px"
      maxSize="60%"
    >
      {row && (
        <>
          <DrawerSection icon={UserIcon} title="Details" defaultOpen>
            <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              <Field label="From">{from}</Field>
              {d ? (
                <>
                  {d.to.length > 0 && <Field label="To">{list(d.to)}</Field>}
                  {d.cc.length > 0 && <Field label="Cc">{list(d.cc)}</Field>}
                  {d.bcc.length > 0 && <Field label="Bcc">{list(d.bcc)}</Field>}
                  {d.replyTo.length > 0 && list(d.replyTo) !== from && <Field label="Reply to">{list(d.replyTo)}</Field>}
                </>
              ) : (
                detail.isPending && <Field label="To"><Skeleton className="h-4 w-48" /></Field>
              )}
              <Field label="Date">{when(d?.date ? Date.parse(d.date) : row.ts)}</Field>
              <Field label="Subject">{d?.subject || row.subject || '(no subject)'}</Field>
              {chips.length > 0 && (
                <Field label="Labels">
                  <span className="flex flex-wrap gap-1">
                    {chips.map((c) => (
                      <Badge key={c.name} variant={c.bg ? 'default' : 'secondary'} style={c.bg ? { background: c.bg, color: c.fg } : undefined}>
                        {c.name}
                      </Badge>
                    ))}
                  </span>
                </Field>
              )}
            </dl>
          </DrawerSection>
          <DrawerSection
            icon={MailIcon}
            title="Message"
            defaultOpen
            hint={!remote ? null : rule ? `Allowed: ${rule}` : !images ? 'Images blocked' : null}
            actions={
              !remote ? undefined : rule ? (
                <Button size="icon" variant="ghost" className="size-7" aria-label={`Stop showing images from ${rule}`} title={`Stop showing images from ${rule}`} onClick={() => remove(ruleKind, rule)}>
                  <ImageOffIcon />
                </Button>
              ) : !images ? (
                <ButtonGroup>
                  <Button size="sm" variant="outline" onClick={() => setImages(true)}>
                    <ImageIcon /> Show images
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" aria-label="More ways to show images" className="px-1.5">
                        <ChevronDownIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
                      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Always show images from</DropdownMenuLabel>
                      {sender && !SHARED_MAIL_DOMAINS.has(sender.org) && (
                        <DropdownMenuItem disabled={!sender.verified || !senders.isSuccess} onSelect={() => add('domain', sender.org)}>
                          <span className="truncate" title={sender.org}>{sender.org}</span>
                        </DropdownMenuItem>
                      )}
                      {sender && (
                        <DropdownMenuItem disabled={!sender.verified || !senders.isSuccess} onSelect={() => add('address', sender.address)}>
                          <span className="truncate" title={sender.address}>{sender.address}</span>
                        </DropdownMenuItem>
                      )}
                      {!sender?.verified && (
                        <>
                          {sender && <DropdownMenuSeparator />}
                          <p className="flex gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
                            <ShieldAlertIcon className="size-3.5 shrink-0" /> Gmail didn't confirm this sender, so images show for this message only.
                          </p>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ButtonGroup>
              ) : undefined
            }
          >
            {detail.isPending ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : detail.isError ? (
              <p className="text-sm text-destructive">{detail.error.message}</p>
            ) : d?.html ? (
              <HtmlBody key={`${row.id}-${shown}`} html={d.html} images={shown} />
            ) : d?.text ? (
              <pre className="whitespace-pre-wrap break-words font-sans text-sm">{d.text}</pre>
            ) : (
              <p className="text-sm text-muted-foreground">This message has no text.</p>
            )}
          </DrawerSection>
          {d && d.attachments.length > 0 && (
            <DrawerSection
              icon={PaperclipIcon}
              title="Attachments"
              count={d.attachments.length}
              defaultOpen
              actions={
                <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={grid ? 'grid' : 'list'} onValueChange={(v) => v && setGrid(v === 'grid')} aria-label="Show as">
                  <ToggleGroupItem value="list" aria-label="List"><ListIcon /></ToggleGroupItem>
                  <ToggleGroupItem value="grid" aria-label="Grid"><LayoutGridIcon /></ToggleGroupItem>
                </ToggleGroup>
              }
            >
              {grid ? (
                <AttachmentGrid items={d.attachments} onOpen={setAt} view={view} />
              ) : (
                <ul className="divide-y text-sm">
                  {d.attachments.map((a, i) => {
                    const Icon = kindIcon(kindOf(a));
                    return (
                      <li key={a.index} className="flex items-center gap-2">
                        <button type="button" onClick={() => setAt(i)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left hover:text-primary" title={`Open ${a.filename}`}>
                          <Icon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{bytes(a.size)}</span>
                        </button>
                        <Button asChild size="icon" variant="ghost" className="size-7" aria-label={`Download ${a.filename}`}>
                          <a href={download(a)} download={a.filename}>
                            <DownloadIcon />
                          </a>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <AttachmentPreview items={d.attachments} at={at} onAt={setAt} view={view} download={download} />
            </DrawerSection>
          )}
        </>
      )}
    </LumenDrawer>
  );
}
