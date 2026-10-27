// Keeps Cloudflare Access in step with the people list, so a sign-in code goes only to people let
// in. It edits one rule: the allow rule that belongs to the app's own Access application (found by
// ACCESS_AUD). A shared, reusable rule is never touched: changing it would open every app using it.
import { can, type Person, type SyncStatus } from '@columenlabs/lumen-ui-types/people';
import type { Env } from './env';
import { adminEmails, MAIL_SCOPE, SCOPES } from './people';
import { accountQuota } from './quota';

type Rule = { email: { email: string } } | Record<string, unknown>;
type Policy = { id: string; name: string; decision: string; reusable?: boolean; precedence?: number; include: Rule[]; exclude?: Rule[]; require?: Rule[] };
type App = { id: string; aud: string; name: string; policies?: Policy[] };
type Answer<T> = { success: boolean; result: T; errors?: { message: string }[] };

const status = (ok: boolean, detail: string): SyncStatus => ({ configured: true, ok, detail, at: Date.now() });

/** Everyone who may sign in: the built-in admins, and each active or invited person with Use or admin.
 *  An expired invite drops out at the next change to the list. */
export function allowed(env: Env, people: Person[]): string[] {
  const let_in = people.filter((p) => (p.status === 'active' || p.status === 'invited') && can(p, MAIL_SCOPE, 'use', SCOPES)).map((p) => p.email.toLowerCase());
  return [...new Set([...adminEmails(env), ...let_in])].sort();
}

/** Rewrites the app's own allow rule to list exactly `emails`. Returns how it went, and keeps it. */
export async function syncAccess(env: Env, people: Person[]): Promise<SyncStatus> {
  const done = await run(env, people);
  await accountQuota(env).setAccessSync(done);
  return done;
}

async function run(env: Env, people: Person[]): Promise<SyncStatus> {
  const token = env.CF_ACCESS_TOKEN;
  const auds = (env.ACCESS_AUD ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  if (!token || !env.CF_ACCOUNT_ID || !auds.length) return { configured: false, ok: false, detail: 'Not set up', at: null };
  const cf = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    const body = (await res.json().catch(() => null)) as Answer<T> | null;
    if (!res.ok || !body?.success) throw new Error(body?.errors?.[0]?.message ?? `Cloudflare answered ${res.status}`);
    return body.result;
  };
  try {
    const apps = await cf<App[]>('apps?per_page=100');
    const app = apps.find((a) => auds.includes(a.aud));
    if (!app) return status(false, 'MailCellar’s Access application was not found');
    const own = (app.policies ?? []).filter((p) => p.decision === 'allow' && !p.reusable);
    if (own.length !== 1) return status(false, `${app.name} needs exactly one allow rule of its own`);
    const rule = own[0];
    const emails = allowed(env, people);
    // Keep any rule that is not a single email (a group, a domain); replace the emails.
    const others = rule.include.filter((r) => !('email' in r));
    await cf(`apps/${app.id}/policies/${rule.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: rule.name,
        decision: rule.decision,
        precedence: rule.precedence,
        include: [...others, ...emails.map((email) => ({ email: { email } }))],
        exclude: rule.exclude ?? [],
        require: rule.require ?? [],
      }),
    });
    return status(true, `${emails.length} ${emails.length === 1 ? 'person' : 'people'} can sign in`);
  } catch (e) {
    return status(false, e instanceof Error ? e.message : 'Sign-in sync failed');
  }
}
