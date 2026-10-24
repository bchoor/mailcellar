import { ARCHIVE_VIEWS, asUserId, mailboxName, type ArchiveView, type Health } from '@mailcellar/schema';
import type { Env } from './env';
import type { MailboxDO } from './mailbox';

export { MailboxDO } from './mailbox';

const SAMPLE_USER = asUserId('sample');

// Static assets serve the app; only /api/* reaches this handler (run_worker_first).
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health' && request.method === 'GET') {
      const body: Health = { ok: true, service: 'mailcellar', version: env.APP_VERSION };
      return Response.json(body);
    }
    if (url.pathname.startsWith('/api/archive/') || url.pathname.startsWith('/api/schedules') || url.pathname === '/api/usage') {
      // Phase 1: no sign-in yet, so every visitor sees the synthetic sample mailbox.
      // PR 4 replaces this with the signed-in user's own mailbox, and sample mode ends.
      const mailbox = env.MAILBOX.getByName(mailboxName(SAMPLE_USER));
      await mailbox.ensureSample();
      const res = await mailboxApi(request, url, mailbox);
      if (res) return res;
    }
    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

const noStore = { 'cache-control': 'no-store' };

/** The API a mailbox serves: its archive pages, schedules and usage. Null: not one of these. */
async function mailboxApi(request: Request, url: URL, mailbox: DurableObjectStub<MailboxDO>): Promise<Response | null> {
  const archive = url.pathname.match(/^\/api\/archive\/([a-z]+)$/);
  if (archive && request.method === 'GET' && ARCHIVE_VIEWS.includes(archive[1] as ArchiveView)) {
    const q = (url.searchParams.get('q') ?? '').slice(0, 200);
    return Response.json(await mailbox.archive(archive[1] as ArchiveView, q), { headers: noStore });
  }
  if (url.pathname === '/api/usage' && request.method === 'GET')
    return Response.json(await mailbox.usage(), { headers: noStore });
  if (url.pathname === '/api/schedules' && request.method === 'GET')
    return Response.json(await mailbox.schedules(), { headers: noStore });
  const schedule = url.pathname.match(/^\/api\/schedules\/([a-z-]{1,40})$/);
  if (schedule && request.method === 'PUT') {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: 'too_large' }, { status: 413 });
    let change: unknown;
    try {
      change = JSON.parse(text);
    } catch {
      return Response.json({ error: 'bad_json' }, { status: 400 });
    }
    const saved = await mailbox.saveSchedule(schedule[1], change);
    return saved.ok
      ? Response.json(saved.schedule, { headers: noStore })
      : Response.json({ error: 'invalid', detail: saved.error }, { status: 400 });
  }
  return null;
}

