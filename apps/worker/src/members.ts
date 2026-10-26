// Who may use MailCellar. Cloudflare Access proves who a person is; the people list decides
// whether they are let in (Lumen's people kit, kept in QuotaDO). ADMIN_EMAILS are built-in
// admins; everyone else needs an invite. With no ADMIN_EMAILS there is no list, and Access alone decides.
import { type PeopleApi, peopleRoutes } from '@columenlabs/lumen-people';
import { can, type Person } from '@columenlabs/lumen-ui-types/people';
import type { Env } from './env';
import { canSend, sendMail } from './mailer';
import { adminEmails, INVITE_DAYS, MAIL_SCOPE, type PeopleOp, SCOPES } from './people';
import { accountQuota } from './quota';

/** How long a Worker trusts what the list said about someone: a removal takes effect within this. */
const ADMIT_MS = 60_000;
const admitted = new Map<string, { until: number; person: Person }>();

/** Who's in: the person (active, with Use or admin), or null. No list: everyone Access lets through, as a member. */
export async function admit(env: Env, email: string): Promise<{ admin: boolean } | null> {
  const key = email.toLowerCase();
  if (!adminEmails(env).length) return { admin: false };
  const hit = admitted.get(key);
  if (hit && hit.until > Date.now()) return { admin: hit.person.role === 'admin' };
  // seen(): notes the visit. A pending invite is let in too; its link's Accept makes it active.
  const person = (await accountQuota(env).seen(key)) as Person | null;
  if (!person || !can(person, MAIL_SCOPE, 'use', SCOPES)) {
    admitted.delete(key);
    return null;
  }
  admitted.set(key, { until: Date.now() + ADMIT_MS, person });
  return { admin: person.role === 'admin' };
}

/** The people service, reached through QuotaDO, in the shape the kit's routes call. */
const service = (env: Env): PeopleApi => {
  const call = (op: PeopleOp) => (...args: unknown[]) => accountQuota(env).people(op, args as never);
  const ops: PeopleOp[] = ['list', 'invite', 'resend', 'revoke', 'update', 'setAccess', 'removable', 'remove', 'linkFor', 'accept', 'audit', 'log'];
  return Object.fromEntries(ops.map((op) => [op, call(op)])) as unknown as PeopleApi;
};

/** /api/people/*: the routes Admin ▸ People and the invite page call. Null: not one of these. */
export async function peopleApi(request: Request, env: Env, url: URL, email: string, admin: boolean): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/people')) return null;
  const routes = peopleRoutes({
    base: '/api/people',
    people: () => service(env),
    actor: () => ({ email, admin }),
    scopes: SCOPES,
    inviteDays: INVITE_DAYS,
    fixedAdmins: adminEmails(env),
    appName: 'MailCellar',
    link: (token) => `${url.origin}/invite/${token}`,
    mailer: () => (canSend(env) ? (m) => sendMail(env, m) : null),
    mailFrom: () => env.MAIL_FROM,
    removeSteps: () => [{ label: 'Their mail', outcome: 'Stays in MailCellar. Inviting them again gives it back.' }],
  });
  const res = await routes(request);
  // A change to someone's access takes effect on this Worker at once, elsewhere within ADMIT_MS.
  if (request.method !== 'GET') admitted.clear();
  return res;
}
