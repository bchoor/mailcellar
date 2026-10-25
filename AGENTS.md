# MailCellar

Gmail and mbox archive on Cloudflare Workers. Bun monorepo. MIT.

## Layout

- `apps/web`: the app (Vite, React, Lumen UI), served as static assets.
- `apps/worker`: the Worker (`/api/*`) and `MailboxDO` (SQLite). One per user (`user:default`: accounts, schedules, usage) and one per Gmail account (`accountMailbox`: that account's archive and sync state).
- `packages/schema`: shared IDs, key layout and API types.
- `wrangler.jsonc`: one Worker; bindings `MAILBOX`, `QUOTA`, `SYNC`, `ARCHIVE` (R2), `ASSETS`. No account, domain or personal values: those are Worker variables and secrets ([docs/setup.md](docs/setup.md)).

## Commands

- `bun install`
- `bun run dev`: web app at http://localhost:5173. `bunx wrangler dev` serves Worker + app at http://localhost:8787.
- `bun run check`: type-check and build. Must pass before a push.

## Identity and accounts

- Login is Cloudflare Access. The Worker verifies `Cf-Access-Jwt-Assertion` (`apps/worker/src/auth.ts`) and uses its email as the user.
- Gmail accounts are added separately via Google OAuth: `/api/accounts/connect`, callback `/api/auth/callback`.
- Each account is a mailbox with its own sidebar section; its pages live under `/m/:id/…` and read `/api/accounts/:id/archive/*`. Backfill and Cloudflare usage cover all mailboxes. Gmail settings (`/api/accounts/:id/filters`, `/subscriptions`) are read live from Gmail, never stored.
- Local dev: `.dev.vars` (gitignored, from `.dev.vars.example`) sets `ACCESS_AUD=""`, `DEV_USER_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

## Conventions

- No sample or seeded data in the app.
- No unit tests; e2e only when needed (Bikram, 2026-10-24).
- DO schema changes are a new entry in `MIGRATIONS` (`apps/worker/src/mailbox.ts`); never edit a shipped one.
- Refresh tokens stay in the Durable Object; no API response includes them.
- What's new (status bar) shows the SemVer version and deployed commit, and lists each release's Key takeaways and merged PRs, built by `scripts/changelog.mjs` from git history and `apps/web/changelog.json` (written only by `scripts/release.sh`). Keep it; never hand-write entries.
- Deploys: Cloudflare Workers Builds deploys every push to `main`. CI and releases: `.github/workflows/`, [docs/releases.md](docs/releases.md).
