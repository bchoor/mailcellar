# MailCellar

Gmail archive on Cloudflare Workers (Free plan). Bun monorepo.

## Layout

- `apps/web`: the app (Vite, React, Lumen UI), served as static assets.
- `apps/worker`: the Worker (`/api/*`) and `MailboxDO` (SQLite). One per user (`user:default`: accounts, schedules, usage) and one per Gmail account (`accountMailbox`: that account's archive and sync state).
- `packages/schema`: shared IDs, key layout and API types.
- `wrangler.jsonc`: one Worker, `mailcellar.icaruslab.dev`; bindings `MAILBOX`, `ARCHIVE` (R2), `ASSETS`.

## Commands

- `bun install`
- `bun run dev`: web app at http://localhost:5173. `bunx wrangler dev` serves Worker + app at http://localhost:8787.
- `bun run check`: type-check, build, Worker tests (Vitest in workerd). Must pass before a push.

## Identity and accounts

- Login is Cloudflare Access. The Worker verifies `Cf-Access-Jwt-Assertion` (`apps/worker/src/auth.ts`) and uses its email as the user.
- Gmail accounts are added separately via Google OAuth: `/api/accounts/connect`, callback `/api/auth/callback`.
- Each account is a mailbox; the sidebar switcher picks one and every page shows it (`/api/accounts/:id/archive/*`). Gmail settings (`/api/accounts/:id/filters`, `/subscriptions`) are read live from Gmail, never stored.
- Local dev: `.dev.vars` (gitignored) sets `ACCESS_AUD=""`, `DEV_USER_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

## Conventions

- No sample or seeded data in the app. Fixtures live under `apps/worker/test/fixtures/` only.
- DO schema changes are a new entry in `MIGRATIONS` (`apps/worker/src/mailbox.ts`); never edit a shipped one.
- Refresh tokens stay in the Durable Object; no API response includes them.
- What's new (status bar) lists PRs merged to main, built from git history by `scripts/changelog.mjs`. Keep it; never hand-write entries.
- Deploys: Cloudflare Workers Builds deploys every push to `main`. CI and releases: `.github/workflows/`, [docs/releases.md](docs/releases.md).
