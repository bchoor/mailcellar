# MailCellar

Gmail and mbox archive on Cloudflare Workers. Bun monorepo. MIT.

## Layout

- `apps/web`: the app (Vite, React, Lumen UI), served as static assets.
- `apps/worker`: the Worker (`/api/*`) and `MailboxDO` (SQLite). One per user (`user:default`: accounts, schedules, usage) and one per Gmail account (`accountMailbox`: that account's archive and sync state).
- `packages/schema`: shared IDs, key layout and API types.
- `wrangler.jsonc`: one Worker; bindings `MAILBOX`, `QUOTA`, `SYNC`, `ARCHIVE` (R2), `ASSETS`, `METRICS` (Analytics Engine `mailcellar_requests`: Lumen's ops meters, one point per request, binding call, DO method, Workflow step and browser point, `apps/worker/src/telemetry.ts`; `TELEMETRY` is the old per-work dataset until METRICS is confirmed). No account, domain or personal values: those are Worker variables and secrets ([docs/setup.md](docs/setup.md)).

## Commands

- `bun install`
- `bun run dev`: web app at http://localhost:5173/app/. `bunx wrangler dev` serves Worker, public page and app at http://localhost:8787 (app at /app/). The page's source is apps/web/site/.
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
- Deploys: Cloudflare Workers Builds deploys every push to `main` through `scripts/deploy.sh`, which checks the live app (`scripts/smoke.mjs`) and rolls back to the version before if the check fails. CI and releases: `.github/workflows/`, [docs/releases.md](docs/releases.md).

## Production never stalls (Bikram, 2026-10-27)

No change may stall a request, a page load or a Durable Object's start. A merge that can is not merged.
- A Durable Object's `blockConcurrencyWhile` holds only the schema migration and other bounded work. A pass over a mailbox's rows (a fill, a recount, a cleanup) or any network call (R2, Gmail, AI) runs after start in small steps (`MailboxDO.catchUp`), resumes from a saved point, and never holds a request.
- Migrations are additive (new tables, new columns with defaults). Every `INSERT` names its columns, so the version before still works on the new schema and a rollback is safe.
- Every outside call on a request's path has a timeout and a fallback; a page that waits on device storage gives up within 1.5 s (`savedAnswers`).
- Before merge, `bun run e2e` (CI job e2e) builds the base branch, imports real-shaped mail, then starts this build on the same Durable Objects and loads the app and its API like a returning person: every call answers within 8 s and the browser boots with no error.
- After deploy, `scripts/deploy.sh` checks the live app signed in (`/app/`, every file it names, `/api/me`, each mailbox's Overview) and rolls back on failure.

