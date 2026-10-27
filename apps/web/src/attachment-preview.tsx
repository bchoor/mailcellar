/// <reference types="vite/client" />
// An attachment opened from the message drawer, in a dialog over it: images in a viewer that steps
// through every attachment, PDFs drawn in the app, text as text, and anything else as its
// name, size and a download.
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@columenlabs/lumen-ui/ui/dialog';
import { Skeleton } from '@columenlabs/lumen-ui/ui/skeleton';
import type { MessageAttachment } from '@mailcellar/schema';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FileIcon, FileTextIcon, ImageIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { bytes } from './format';

export type Kind = 'image' | 'pdf' | 'text' | 'other';
const IMAGES = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;
const TEXT = /^(text\/(plain|csv)|application\/json)$/i;
export const kindOf = (a: MessageAttachment): Kind =>
  IMAGES.test(a.mimeType) ? 'image' : /^application\/pdf$/i.test(a.mimeType) ? 'pdf' : TEXT.test(a.mimeType) ? 'text' : 'other';
export const kindIcon = (k: Kind) => (k === 'image' ? ImageIcon : k === 'other' ? FileIcon : FileTextIcon);

function TextView({ url }: { url: string }) {
  const q = useQuery({ queryKey: ['attachment-text', url], staleTime: Number.POSITIVE_INFINITY, queryFn: async () => (await fetch(url)).text() });
  if (q.isPending) return <Skeleton className="m-4 h-40 w-full" />;
  return <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words bg-background p-4 font-mono text-xs">{q.data}</pre>;
}

/** A PDF drawn page by page with pdf.js (loaded on first use): its scripts and forms never run. */
function PdfView({ url }: { url: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    let stop = false;
    (async () => {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
      const width = Math.min(900, (box.current?.clientWidth ?? 800) - 32);
      for (let n = 1; n <= doc.numPages && !stop; n++) {
        const page = await doc.getPage(n);
        const scale = width / page.getViewport({ scale: 1 }).width;
        const vp = page.getViewport({ scale: scale * devicePixelRatio });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        canvas.style.width = `${width}px`;
        canvas.className = 'mx-auto mb-4 rounded-sm bg-white shadow-md';
        await page.render({ canvas, viewport: vp }).promise;
        box.current?.appendChild(canvas);
        setState('ready');
      }
    })().catch(() => !stop && setState('failed'));
    return () => {
      stop = true;
    };
  }, [url]);
  return (
    <div ref={box} className="h-full w-full overflow-auto p-4">
      {state === 'loading' && <Skeleton className="mx-auto aspect-[8.5/11] w-full max-w-[900px]" />}
      {state === 'failed' && <p className="p-8 text-center text-sm text-muted-foreground">This PDF can't be shown here. Download it to open it.</p>}
    </div>
  );
}

function Stage({ a, url, download }: { a: MessageAttachment; url: string; download: string }) {
  const kind = kindOf(a);
  if (kind === 'image') return <img src={url} alt={a.filename} className="max-h-full max-w-full object-contain" />;
  if (kind === 'pdf') return <PdfView url={url} />;
  if (kind === 'text') return <TextView url={url} />;
  const Icon = kindIcon(kind);
  return (
    <div className="flex flex-col items-center gap-3 p-8 text-center">
      <Icon className="size-12 text-muted-foreground" strokeWidth={1.25} />
      <div className="max-w-80 break-words font-medium">{a.filename}</div>
      <div className="text-xs text-muted-foreground">
        {bytes(a.size)}
        {/\.([a-z0-9]{1,8})$/i.test(a.filename) && ` · ${a.filename.split('.').pop()!.toUpperCase()} file`}
      </div>
      <p className="text-sm text-muted-foreground">This file type can't be shown here.</p>
      <Button asChild size="sm">
        <a href={download} download={a.filename}>
          <DownloadIcon /> Download
        </a>
      </Button>
    </div>
  );
}

export function AttachmentPreview({
  items, at, onAt, view, download,
}: {
  items: MessageAttachment[];
  at: number | null;
  onAt: (n: number | null) => void;
  view: (a: MessageAttachment) => string;
  download: (a: MessageAttachment) => string;
}) {
  const a = at === null ? null : items[at];
  const swipe = useRef<number | null>(null);
  const step = (d: number) => at !== null && onAt((at + d + items.length) % items.length);
  // biome-ignore lint/correctness/useExhaustiveDependencies: step reads the current position.
  useEffect(() => {
    if (at === null) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [at, items.length]);
  return (
    <Dialog open={!!a} onOpenChange={(o) => !o && onAt(null)}>
      <DialogContent className="flex h-[88svh] flex-col gap-0 p-0 [--dialog-pad:0px] sm:max-w-5xl max-md:h-full max-md:pt-[env(safe-area-inset-top)]">
        {a && at !== null && (
          <>
            <div className="flex items-center gap-3 border-b py-2.5 pr-12 pl-4">
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-sm" title={a.filename}>
                  {a.filename}
                </DialogTitle>
                <DialogDescription className="text-xs tabular-nums">
                  {at + 1} of {items.length} · {bytes(a.size)}
                </DialogDescription>
              </div>
              <Button asChild size="sm" variant="outline">
                <a href={download(a)} download={a.filename}>
                  <DownloadIcon /> <span className="max-md:sr-only">Download</span>
                </a>
              </Button>
            </div>
            <div
              className="relative flex min-h-0 flex-1 items-center justify-center bg-muted/60"
              // A sideways swipe on a phone steps like the arrows.
              onTouchStart={(e) => (swipe.current = e.touches[0].clientX)}
              onTouchEnd={(e) => {
                const dx = e.changedTouches[0].clientX - (swipe.current ?? e.changedTouches[0].clientX);
                if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
                swipe.current = null;
              }}
            >
              <Stage key={a.index} a={a} url={view(a)} download={download(a)} />
              {items.length > 1 && (
                <>
                  <Button size="icon" variant="secondary" className="absolute top-1/2 left-3 -translate-y-1/2 rounded-full shadow-md" aria-label="Previous" onClick={() => step(-1)}>
                    <ChevronLeftIcon />
                  </Button>
                  <Button size="icon" variant="secondary" className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full shadow-md" aria-label="Next" onClick={() => step(1)}>
                    <ChevronRightIcon />
                  </Button>
                </>
              )}
            </div>
            {items.length > 1 && <Strip items={items} at={at} onAt={onAt} view={view} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Every attachment as a thumbnail under the viewer; the open one is ringed and kept in view. */
function Strip({ items, at, onAt, view }: { items: MessageAttachment[]; at: number; onAt: (n: number) => void; view: (a: MessageAttachment) => string }) {
  useEffect(() => {
    document.getElementById(`strip-${at}`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [at]);
  return (
    <div className="flex gap-1.5 overflow-x-auto border-t bg-popover p-2">
      {items.map((a, i) => {
        const kind = kindOf(a);
        const Icon = kindIcon(kind);
        return (
          <button
            key={a.index}
            id={`strip-${i}`}
            type="button"
            title={a.filename}
            onClick={() => onAt(i)}
            className={`flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted ${i === at ? 'ring-2 ring-primary ring-offset-1 ring-offset-popover' : 'opacity-70 hover:opacity-100'}`}
          >
            {kind === 'image' ? <img src={view(a)} alt="" loading="lazy" className="size-full object-cover" /> : <Icon className="size-5 text-muted-foreground" />}
          </button>
        );
      })}
    </div>
  );
}

/** Attachments as tiles: images as thumbnails, other files as their icon and name. */
export function AttachmentGrid({ items, onOpen, view }: { items: MessageAttachment[]; onOpen: (n: number) => void; view: (a: MessageAttachment) => string }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
      {items.map((a, i) => {
        const kind = kindOf(a);
        const Icon = kindIcon(kind);
        return (
          <li key={a.index}>
            <button type="button" onClick={() => onOpen(i)} className="group w-full text-left" title={a.filename}>
              <span className="flex aspect-square items-center justify-center overflow-hidden rounded-md border bg-muted group-hover:ring-2 group-hover:ring-ring/50">
                {kind === 'image' ? <img src={view(a)} alt="" loading="lazy" className="size-full object-cover" /> : <Icon className="size-8 text-muted-foreground" strokeWidth={1.25} />}
              </span>
              <span className="mt-1 block truncate text-xs">{a.filename}</span>
              <span className="block text-[11px] text-muted-foreground tabular-nums">{bytes(a.size)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
