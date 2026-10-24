import { ARCHIVE_VIEWS, asUserId, mailboxName, type ArchiveView, type Health } from '@mailcellar/schema';
import type { Env } from './env';

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
    const archive = url.pathname.match(/^\/api\/archive\/([a-z]+)$/);
    if (archive && request.method === 'GET' && ARCHIVE_VIEWS.includes(archive[1] as ArchiveView)) {
      // Phase 1: no sign-in yet, so every visitor sees the synthetic sample mailbox.
      // PR 4 replaces this with the signed-in user's own mailbox, and sample mode ends.
      const mailbox = env.MAILBOX.getByName(mailboxName(SAMPLE_USER));
      await mailbox.ensureSample();
      const q = (url.searchParams.get('q') ?? '').slice(0, 200);
      const rows = await mailbox.archive(archive[1] as ArchiveView, q);
      return Response.json(rows, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
