# Set up MailCellar

You need a Cloudflare account, a domain on Cloudflare, a Google Cloud project, and [Bun](https://bun.sh). Examples use `mail.example.com`; use your own domain.

## 1. R2 bucket and Basin

```bash
bun install
bunx wrangler login
bunx wrangler r2 bucket create mailcellar
bunx wrangler r2 bucket catalog enable mailcellar
```

Another bucket name works too: set it in `wrangler.jsonc` as both `r2_buckets[0].bucket_name` and `vars.BASIN_BUCKET`.

Create an API token for Basin (My Profile ▸ API Tokens) with **Workers R2 Data Catalog: Edit** and **Workers R2 Storage: Edit** on your account. It becomes the `BASIN_TOKEN` secret.

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
bunx wrangler secret put GOOGLE_CLIENT_ID
bunx wrangler secret put GOOGLE_CLIENT_SECRET
bunx wrangler secret put BASIN_TOKEN
```

Optional:

- `ADMIN_EMAILS`: comma-separated emails allowed the end-to-end test switch.
- `CF_ANALYTICS_TOKEN`: a token with Account Analytics, Workers Scripts and Workflows read. The Usage page reads the account's usage with it.
- `CF_BILLING_TOKEN`: a token with Billing Read. The Usage page reads the plan with it.
- `BASIN_CATALOG_URI` and `BASIN_WAREHOUSE`: only if your catalog isn't at the default for `CF_ACCOUNT_ID` and the bucket.

Plain variables set in the dashboard work too: `keep_vars` keeps them across deploys.

## 7. Workers Builds

Workers & Pages ▸ mailcellar ▸ Settings ▸ Builds ▸ Connect your fork. Build command `bun install --frozen-lockfile && bun run build`, deploy command `bunx wrangler deploy`. Every push to `main` deploys.

## 8. Use it

Open `https://mail.example.com`, sign in through Access, then Settings ▸ Accounts ▸ Add Gmail account. Pick months on Backfill, then Start backfill. Settings ▸ Accounts ▸ Add mbox archive imports an mbox file.

## Local dev

`cp .dev.vars.example .dev.vars`, fill in the Google client and `DEV_USER_EMAIL`, then `bunx wrangler dev`. `ACCESS_AUD` stays empty locally, so the Worker acts as `DEV_USER_EMAIL`.
