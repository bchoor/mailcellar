// Who may use MailCellar. Cloudflare Access proves who a person is; this decides whether they
// are let in. ADMIN_EMAILS are always in and keep the guest list (Admin ▸ Users); everyone else
// must be on it. With no ADMIN_EMAILS there is no guest list, and Access alone decides.
import type { AppUser } from '@mailcellar/schema';
import type { Env } from './env';
import { accountQuota } from './quota';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
/** How long a Worker trusts what the guest list said about someone: a removal takes effect within this. */
const ADMIT_MS = 60_000;
const admitted = new Map<string, number>();

export const adminEmails = (env: Env) => (env.ADMIN_EMAILS ?? '').toLowerCase().split(',').map((e) => e.trim()).filter(Boolean);
export const isAdmin = (env: Env, email: string) => adminEmails(env).includes(email.toLowerCase());

/** Whether this signed-in person may use MailCellar. */
export async function admit(env: Env, email: string): Promise<boolean> {
  const admins = adminEmails(env);
  const key = email.toLowerCase();
  if (!admins.length || admins.includes(key)) return true;
  if ((admitted.get(key) ?? 0) > Date.now()) return true;
  const ok = await accountQuota(env).admit(key);
  if (ok) admitted.set(key, Date.now() + ADMIT_MS);
  else admitted.delete(key);
  return ok;
}

const noStore = { 'cache-control': 'no-store' };

async function list(env: Env): Promise<AppUser[]> {
  const admins = adminEmails(env);
  const guests = (await accountQuota(env).members()).filter((m) => !admins.includes(m.email));
  return [
    ...admins.map((email): AppUser => ({ email, admin: true, addedAt: null, seenAt: null })),
    ...guests.map((m): AppUser => ({ email: m.email, admin: false, addedAt: m.added_at, seenAt: m.seen_at })),
  ];
}

/** /api/admin/users: list (GET), add (POST {"email"}), remove (DELETE /:email). Admins only. Null: not one of these. */
export async function membersApi(request: Request, env: Env, url: URL, email: string): Promise<Response | null> {
  const one = url.pathname.match(/^\/api\/admin\/users\/([^/]{3,320})$/);
  if (url.pathname !== '/api/admin/users' && !one) return null;
  if (!isAdmin(env, email)) return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
  if (url.pathname === '/api/admin/users' && request.method === 'GET') return Response.json(await list(env), { headers: noStore });
  if (url.pathname === '/api/admin/users' && request.method === 'POST') {
    let body: { email?: unknown };
    try {
      body = JSON.parse((await request.text()).slice(0, 1024));
    } catch {
      return Response.json({ error: 'bad_json' }, { status: 400 });
    }
    const add = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL.test(add)) return Response.json({ error: 'bad_email' }, { status: 400, headers: noStore });
    if (isAdmin(env, add) || !(await accountQuota(env).addMember(add))) return Response.json({ error: 'already_added' }, { status: 409, headers: noStore });
    return Response.json(await list(env), { headers: noStore });
  }
  if (one && request.method === 'DELETE') {
    const remove = decodeURIComponent(one[1]).toLowerCase();
    // Admins come from ADMIN_EMAILS (a Worker variable), not the guest list.
    if (isAdmin(env, remove)) return Response.json({ error: 'is_admin' }, { status: 409, headers: noStore });
    if (!(await accountQuota(env).removeMember(remove))) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
    admitted.delete(remove);
    return Response.json(await list(env), { headers: noStore });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}
