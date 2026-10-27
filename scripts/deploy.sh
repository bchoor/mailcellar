#!/usr/bin/env bash
# Workers Builds' deploy step (its deploy command is `bash scripts/deploy.sh`): deploy, check the
# live app, and put the version that was live back if the check fails. The build then fails, so
# the commit's "Workers Builds" check is red and nobody is left on a broken app.
#
# Build variables (Workers Builds settings, never in the repo):
#   SMOKE_URL                              the live site, e.g. https://mail.example.com
#   SMOKE_CLIENT_ID, SMOKE_CLIENT_SECRET   a Cloudflare Access service token the Worker lets in
#                                          (SERVICE_IDENTITIES), so /app and /api answer
# Without them it deploys and checks only what answers without signing in.
set -euo pipefail
cd "$(dirname "$0")/.."

SHA="${WORKERS_CI_COMMIT_SHA:-$(git rev-parse HEAD)}"

# The version serving all traffic now, to go back to.
PREV=$(bunx wrangler deployments status --json 2>/dev/null | bun -e '
  const d = JSON.parse(await Bun.stdin.text());
  const v = (d.versions ?? []).sort((a, b) => b.percentage - a.percentage)[0];
  console.log(v?.version_id ?? "");
' || true)
echo "deploy: live before is ${PREV:-unknown}"

bunx wrangler deploy --var "APP_VERSION:$SHA"

if [ -z "${SMOKE_URL:-}" ]; then
  echo "::warning:: deploy: SMOKE_URL is not set, so the live app was not checked"
  exit 0
fi

check() {
  if [ -n "${SMOKE_CLIENT_ID:-}" ]; then
    # Workers Builds has no browser: the requests are checked here, the browser boot before merge (e2e).
    SMOKE_VERSION="$SHA" SMOKE_BROWSER=0 bun scripts/smoke.mjs
  else
    echo "::warning:: deploy: no SMOKE_CLIENT_ID, so only the public page is checked"
    curl -sf --max-time 8 "$SMOKE_URL/" >/dev/null && curl -sf --max-time 8 "$SMOKE_URL/releases.json" >/dev/null
  fi
}

if check; then
  echo "deploy: $SHA is live and answering"
  exit 0
fi

echo "deploy: the live check failed on $SHA"
if [ -n "$PREV" ]; then
  echo "deploy: rolling back to $PREV"
  bunx wrangler rollback "$PREV" --message "Live check failed on ${SHA:0:7}; back to the version before" -y
  SMOKE_VERSION= check && echo "deploy: rolled back; the previous version answers" || echo "deploy: rolled back, but the check still fails"
else
  echo "deploy: no previous version known, nothing to roll back to"
fi
exit 1
