// Archive mailboxes' API: add one for an mbox file, upload the file in parts straight to raw
// files (an R2 multipart upload, resumable: each part's etag is kept as a raw file of its own),
// then complete it, which starts the import (import.ts).
import { r2Keys, type UserId } from '@mailcellar/schema';
import type { Env } from './env';
import { PART_SIZE, startImport, type ArchiveRecord } from './import';
import type { MailboxDO } from './mailbox';

const noStore = { 'cache-control': 'no-store' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: noStore });

/** R2 takes up to 10,000 parts. */
const MAX_BYTES = PART_SIZE * 10_000;

const partsOf = (r: ArchiveRecord) => Math.max(1, Math.ceil(r.bytes / r.partSize));
const partBytes = (r: ArchiveRecord, n: number) => (n < partsOf(r) ? r.partSize : r.bytes - (n - 1) * r.partSize);

/** A new mailbox ID in the same shape as a Gmail account's, so every mailbox route takes it. */
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(17));
  return `a${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').slice(0, 22)}`;
}

/** The part numbers already sent, from their etag files. */
async function sentParts(env: Env, user: UserId, id: string): Promise<{ partNumber: number; etag: string }[]> {
  const out: { partNumber: number; etag: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({ prefix: r2Keys.uploadParts(user, id), cursor, include: ['customMetadata'] });
    for (const o of page.objects) {
      const etag = o.customMetadata?.etag;
      if (etag) out.push({ partNumber: Number(o.key.slice(-10, -5)), etag });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => a.partNumber - b.partNumber);
}

type Mailbox = DurableObjectStub<MailboxDO>;

/** The archive routes; null when the request is none of them. */
export async function archiveApi(request: Request, env: Env, url: URL, user: UserId, mailbox: Mailbox): Promise<Response | null> {
  if (url.pathname === '/api/archives' && request.method === 'POST') {
    // {"name": "Old mail", "file": "Old mail.mbox", "bytes": 2147490684}
    let body: { name?: unknown; file?: unknown; bytes?: unknown };
    try {
      body = JSON.parse((await request.text()).slice(0, 4096));
    } catch {
      return json({ error: 'bad_json' }, 400);
    }
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const file = typeof body.file === 'string' ? body.file.trim().slice(0, 200) : '';
    const bytes = typeof body.bytes === 'number' && Number.isInteger(body.bytes) ? body.bytes : 0;
    if (!name || !file) return json({ error: 'bad_name' }, 400);
    if (bytes <= 0 || bytes > MAX_BYTES) return json({ error: 'bad_size' }, 400);
    const id = newId();
    const upload = await env.ARCHIVE.createMultipartUpload(r2Keys.upload(user, id), { httpMetadata: { contentType: 'application/mbox' } });
    const record: ArchiveRecord = { file, bytes, uploadId: upload.uploadId, partSize: PART_SIZE, status: 'uploading', messages: null, error: null };
    await mailbox.addArchive(id, name, record);
    return json({ id, partSize: PART_SIZE, parts: partsOf(record), sent: [] });
  }
  const upload = url.pathname.match(/^\/api\/archives\/(a[A-Za-z0-9_-]{22})\/upload$/);
  if (upload && request.method === 'GET') {
    // Where an upload stands: the parts already sent, so choosing the file again sends only the rest.
    const record = await mailbox.archiveRecord(upload[1]);
    if (!record) return json({ error: 'not_found' }, 404);
    const sent = record.status === 'uploading' ? (await sentParts(env, user, upload[1])).map((p) => p.partNumber) : [];
    return json({ id: upload[1], file: record.file, bytes: record.bytes, partSize: record.partSize, parts: partsOf(record), sent, status: record.status });
  }
  const part = url.pathname.match(/^\/api\/archives\/(a[A-Za-z0-9_-]{22})\/parts\/(\d{1,5})$/);
  if (part && request.method === 'PUT') {
    const [, id, n] = part;
    const record = await mailbox.archiveRecord(id);
    if (!record) return json({ error: 'not_found' }, 404);
    if (record.status !== 'uploading') return json({ error: 'not_uploading' }, 409);
    const number = Number(n);
    if (number < 1 || number > partsOf(record)) return json({ error: 'bad_part' }, 400);
    const length = Number(request.headers.get('content-length'));
    if (!request.body || length !== partBytes(record, number)) return json({ error: 'bad_length', expected: partBytes(record, number) }, 400);
    const sent = await env.ARCHIVE.resumeMultipartUpload(r2Keys.upload(user, id), record.uploadId).uploadPart(number, request.body);
    await env.ARCHIVE.put(r2Keys.uploadPart(user, id, number), '', { customMetadata: { etag: sent.etag } });
    return json({ part: number });
  }
  const complete = url.pathname.match(/^\/api\/archives\/(a[A-Za-z0-9_-]{22})\/complete$/);
  if (complete && request.method === 'POST') {
    const id = complete[1];
    const record = await mailbox.archiveRecord(id);
    if (!record) return json({ error: 'not_found' }, 404);
    if (record.status !== 'uploading') return json({ status: record.status });
    const sent = await sentParts(env, user, id);
    const have = new Set(sent.map((p) => p.partNumber));
    const missing = Array.from({ length: partsOf(record) }, (_, i) => i + 1).filter((p) => !have.has(p));
    if (missing.length) return json({ error: 'missing_parts', missing }, 409);
    await env.ARCHIVE.resumeMultipartUpload(r2Keys.upload(user, id), record.uploadId).complete(sent);
    await mailbox.setArchive(id, { status: 'importing' });
    await startImport(env, user, id, record);
    return json({ status: 'importing' });
  }
  return null;
}

/** Remove an archive mailbox: an upload not finished is dropped (its parts are deleted with it). */
export async function removeArchive(env: Env, user: UserId, mailbox: Mailbox, id: string): Promise<boolean> {
  const record = await mailbox.removeArchive(id);
  if (!record) return false;
  if (record.status === 'uploading') {
    try {
      await env.ARCHIVE.resumeMultipartUpload(r2Keys.upload(user, id), record.uploadId).abort();
    } catch (e) {
      console.log(JSON.stringify({ abortUpload: { id, error: String(e).slice(0, 160) } }));
    }
    const parts = await env.ARCHIVE.list({ prefix: r2Keys.uploadParts(user, id) });
    if (parts.objects.length) await env.ARCHIVE.delete(parts.objects.map((o) => o.key));
  }
  return true;
}
