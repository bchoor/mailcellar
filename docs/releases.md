# Releases

MailCellar uses SemVer `v0.MINOR.PATCH` tags, cut by `scripts/release.sh` from `.github/workflows/release.yml` on OpenShip's runner. Both are copied from columenlabs/edgedesk.

- **Patch**: automatic. Once 10 pull requests (repo variable `RELEASE_EVERY`) have merged since the last tag, or on the first merge 7 days after it, the next merge to `main` cuts a patch. Claude writes its Key takeaways from the pull requests (secret `ANTHROPIC_API_KEY`); the list of pull requests follows. On by default; set the repo variable `RELEASE_ON_MERGE` to `false` to pause it.
- **Minor**: by hand, for a milestone (phase 1 done, phase 2 done). Write `docs/releases/v0.X.0.md` first, merge it, then run the Release workflow with `bump: minor`.
- **Notes**: re-applies a minor's notes file to its release.
- **Recut**: Run workflow with `recut` deletes every release and tag, then cuts them again over main's history (v0.0.0 at the first commit, one patch per 10 merges).
- **Run workflow**: dry run by default; untick it to cut for real.
- **Catch-up**: if more than one batch of 10 merges has no release (after a recut), the next run cuts one patch at each 10th merge, in order.
- **What's new**: after each release, `release.sh` commits its Key takeaways to `apps/web/changelog.json` (`changelog: vX` on main), which Workers Builds deploys. The status bar shows the newest version and the deployed commit (`v0.0.1 · 9dadc7b`); its drawer lists each release's Key takeaways only, never PR titles.

Setup: none. With no tag, the first run tags the first commit `v0.0.0`, and merges count from there.

Deploys are separate: Cloudflare Workers Builds is connected to this repo and deploys every push to `main` to the Worker's custom domain (build `bun install --frozen-lockfile && bun run build`, deploy `bunx wrangler deploy`). Cloudflare manages its own build token, so no Cloudflare token lives in GitHub. Edit it under the Worker's Settings > Builds.
