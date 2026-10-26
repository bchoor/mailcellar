# Set up MailCellar

You need a Cloudflare account, a domain on Cloudflare, a Google Cloud project, and [Bun](https://bun.sh). Examples use `mail.example.com`; use your own domain.

## 1. R2 bucket

```bash
bun install
bunx wrangler login
bunx wrangler r2 bucket create mailcellar
```

Another bucket name works too: set it in `wrangler.jsonc` as both `r2_buckets[0].bucket_name` and `vars.ARCHIVE_BUCKET`.

## 2. Plan

`wrangler.jsonc` sets `limits.cpu_ms`, which needs Workers Paid. On Workers Free, remove `limits` and set `WORKERS_PLAN = 'free'` in `packages/schema/src/quota.ts`. The same file holds `PAID_ENDS` (when Paid's budgets end) and `SPEND` (the backfill's spend cap).

## 3. First deploy and domain

```bash
bun run deploy
```

Then, in the dashboard: Workers & Pages ▸ mailcellar ▸ Settings ▸ Domains & Routes ▸ Add ▸ Custom domain ▸ `mail.example.com`. The config turns off `workers.dev` and preview URLs, so the custom domain is the only way in.

## 4. Cloudflare Access

Zero Trust ▸ Access ▸ Applications ▸ Add ▸ Self-hosted, on `mail.example.com`, with a policy that allows only your email. From the application, copy:

- **Team domain**, such as `https://yourteam.cloudflareaccess.com`: `ACCESS_TEAM_DOMAIN`.
- **Application Audience (AUD) tag**: `ACCESS_AUD`.

The Worker checks Access's signed token on every API request. With `ACCESS_AUD` unset it refuses every request (unless `DEV_USER_EMAIL` is set, which is for local dev only).

## 5. Google OAuth client

In Google Cloud console:

1. Enable the **Gmail API**.
2. OAuth consent screen: External. Add your Gmail addresses as test users. Scopes: `openid`, `email`, `gmail.modify`.
3. Credentials ▸ Create ▸ OAuth client ID ▸ Web application. Redirect URIs:
   - `https://mail.example.com/api/auth/callback`
   - `http://localhost:8787/api/auth/callback` (local dev)

Copy the client ID and secret. While the app is in Testing, Google expires its refresh tokens after 7 days; Settings ▸ Accounts ▸ Reconnect gets a new one and keeps the mail.

## 6. Variables and secrets

```bash
bunx wrangler secret put CF_ACCOUNT_ID         # your account ID (dashboard ▸ Account home)
bunx wrangler secret put ACCESS_TEAM_DOMAIN
bunx wrangler secret put ACCESS_AUD
bunx wrangler secret put MCP_ACCESS_AUD     # step 9, for the MCP server
bunx wrangler secret put GOOGLE_CLIENT_ID
bunx wrangler secret put GOOGLE_CLIENT_SECRET
```

Optional:

- `ADMIN_EMAILS`: comma-separated built-in admins. They are always let in and see Admin ▸ People, where they invite people and set their access; anyone else Access signs in needs an invite. Unset: no people list, and Access alone decides who gets in.
- Invite emails: set in the app, Admin ▸ Email, against any Resend-style email API (Resend, or a self-hosted one such as FreeSend). A self-hosted one behind a Cloudflare Tunnel is reached through a Workers VPC service bound as `FREESEND` (`vpc_services` in `wrangler.jsonc`), the Private tunnel route. Not set: each invite gives a link to send by hand.
- `CF_ANALYTICS_TOKEN`: a token with Account Analytics, Workers Scripts and Workflows read. The Usage page reads the account's usage with it.
- `CF_BILLING_TOKEN`: a token with Billing Read. The Usage page reads the plan with it.
- `SUITE_LIST_URL`: when MailCellar sits in a suite of Lumen apps, the address its app switcher reads (`{ apps: [{ id, name, url, icon?, group? }] }`, sent with the browser's cookies, so the suite must allow this origin with credentials). Unset: the sidebar shows MailCellar alone.
- `SUITE_PREFS_COOKIE` and `SUITE_PREFS_DOMAIN`: the suite's shared Lumen prefs cookie and its domain (such as `.example.com`), so theme mode, font and size follow the person across the suite. MailCellar keeps its own palette and mark.

Plain variables set in the dashboard work too: `keep_vars` keeps them across deploys.

## 7. Workers Builds

Workers & Pages ▸ mailcellar ▸ Settings ▸ Builds ▸ Connect your fork. Build command `bun install --frozen-lockfile && bun run build`, deploy command `bunx wrangler deploy`. Every push to `main` deploys.

## 8. Use it

Open `https://mail.example.com`, sign in through Access, then Settings ▸ Accounts ▸ Add Gmail account. Pick months on Backfill, then Start backfill. Settings ▸ Accounts ▸ Add mbox archive imports an mbox file.

## 9. MCP server

`/mcp` gets its own Access application, so an MCP client's sign-in reaches only `/mcp`:

1. Zero Trust ▸ Access ▸ Applications ▸ Add ▸ Self-hosted, on `mail.example.com` with path `mcp`, and the same policy (only your email).
2. Advanced settings ▸ turn on **Managed OAuth**, with dynamic client registration allowing `https://claude.ai/api/mcp/auth_callback` (and `http://localhost/*` for local clients).
3. Copy its **Application Audience (AUD) tag** into the Worker variable `MCP_ACCESS_AUD`.

Until `MCP_ACCESS_AUD` is set, `/mcp` answers 503. Then add the connector in claude.ai (Settings ▸ Connectors ▸ Add custom connector, `https://mail.example.com/mcp`) and sign in through Access when asked.

## Local dev

`cp .dev.vars.example .dev.vars`, fill in the Google client and `DEV_USER_EMAIL`, then `bunx wrangler dev`. `ACCESS_AUD` stays empty locally, so the Worker acts as `DEV_USER_EMAIL`.
