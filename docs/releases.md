# Releases

MailCellar uses `v0.MINOR.PATCH` tags, cut by `scripts/release.sh` from `.github/workflows/release.yml` on OpenShip's runner.

- **Patch**: automatic. Once 10 pull requests (repo variable `RELEASE_EVERY`) have merged since the last tag, or on the first merge 7 days after it, the next merge to `main` cuts a patch. Claude writes its Key takeaways from the pull requests (secret `ANTHROPIC_API_KEY`); the list of pull requests follows. Only runs while the repo variable `RELEASE_ON_MERGE` is `true`.
- **Minor**: by hand, for a milestone (phase 1 done, phase 2 done). Write `docs/releases/v0.X.0.md` first, merge it, then run the Release workflow with `bump: minor`.
- **Notes**: re-applies a minor's notes file to its release.
- **Run workflow**: dry run by default; untick it to cut for real.

Setup: tag the first commit `v0.0.0`, then set `RELEASE_ON_MERGE=true`.

Deploys are separate: `.github/workflows/deploy.yml` deploys every merge to `main` to https://mailcellar.icaruslab.dev once the `CLOUDFLARE_API_TOKEN` secret is set.
