#!/usr/bin/env bash
# Cut MailCellar releases (docs/releases.md) through the GitHub REST API, no Actions.
# Copied from columenlabs/edgedesk scripts/release.sh; MailCellar has no desks.
#   scripts/release.sh          one patch release at main once RELEASE_EVERY (10)
#                               first-parent merges landed since the latest v0.* tag,
#                               or on the first merge 7 days after it; FORCE=1 cuts
#                               it now whatever the count. Behind by more than one batch
#                               (a recut), it cuts one patch at each RELEASE_EVERY-th merge
#   scripts/release.sh minor    tag main as the next minor; its notes are the
#                               hand-written docs/releases/v0.X.0.md (required)
#   scripts/release.sh notes    set the latest minor release's notes from its file again
#   scripts/release.sh recut    delete every v0.* release and tag, then cut them again over
#                               main's history: v0.0.0 at the first commit, one patch per
#                               RELEASE_EVERY merges (Bikram, 2026-10-24)
#   DRY_RUN=1 scripts/release.sh  print the releases it would cut, create nothing
# .github/workflows/release.yml runs it on each merge to main (OpenShip's self-hosted
# runner). With no v0.* tag yet, it first tags the first commit v0.0.0.
# Needs gh with REST access to the repo, and jq. A patch's notes are key
# takeaways Claude writes from the batch's PRs (ANTHROPIC_API_KEY), then the list of
# those PRs written by the script; without a key they are GitHub's PR list.
set -euo pipefail
BUMP=${1:-patch}
DRY_RUN=${DRY_RUN:-0}
FORCE=${FORCE:-0}
RELEASE_EVERY=${RELEASE_EVERY:-10}
MODEL=claude-sonnet-5-5
REPO=${GITHUB_REPOSITORY:-bchoor/mailcellar}
git fetch -q origin main --tags
if [ "$BUMP" = recut ]; then
  for t in $(git tag --list 'v0.*'); do
    if [ "$DRY_RUN" = 1 ]; then
      echo "would delete $t"
    else
      id=$(gh api "repos/$REPO/releases/tags/$t" --jq .id 2> /dev/null) \
        && gh api -X DELETE "repos/$REPO/releases/$id" --silent
      gh api -X DELETE "repos/$REPO/git/refs/tags/$t" --silent
      echo "deleted $t"
    fi
    git tag -d "$t" > /dev/null
  done
  BUMP=patch
  FORCE=0 # only whole batches: the merges after the last one wait for the next release
fi
LATEST=$(git tag --list 'v0.*' --sort=-v:refname | head -1)
if [ -z "$LATEST" ]; then
  # First run: tag the first commit v0.0.0, so the count of merges starts there.
  ROOT=$(git rev-list --max-parents=0 origin/main | tail -1)
  if [ "$DRY_RUN" = 1 ]; then
    echo "would tag v0.0.0 at $(git log -1 --format='%h %s' "$ROOT")"
  else
    gh api -X POST "repos/$REPO/git/refs" -f ref=refs/tags/v0.0.0 -f sha="$ROOT" --silent
    git fetch -q origin --tags
    echo "tagged v0.0.0 at $(git log -1 --format='%h %s' "$ROOT")"
  fi
  git tag -f v0.0.0 "$ROOT" > /dev/null
  LATEST=v0.0.0
fi
IFS=. read -r _ MINOR PATCH <<< "${LATEST#v}"

release() { # tag sha previous-tag [notes-file]
  if [ "$DRY_RUN" = 1 ]; then
    echo "would cut $1 (notes from ${4:-$3}) $(git log -1 --format='%h %s' "$2")"
    return
  fi
  if [ -n "${4:-}" ]; then
    notes=$(cat "$4")
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    notes=$(takeaways "$1" "$2" "$3") || { echo "Claude wrote no notes" >&2; exit 1; }
  else
    notes=$(gh api -X POST "repos/$REPO/releases/generate-notes" \
      -f tag_name="$1" -f target_commitish="$2" -f previous_tag_name="$3" --jq .body)
  fi
  at=$(gh api -X POST "repos/$REPO/releases" \
    -f tag_name="$1" -f target_commitish="$2" -f name="$1" -f body="$notes" --jq .published_at)
  git tag -f "$1" "$2" > /dev/null
  echo "$1 $(git log -1 --format='%h %s' "$2")"
  changelog "$1" "$at" "$notes" "$2"
}

# The app's What's new, as in EdgeDesk: each release's Key takeaways, newest first, in CHANGELOG
# (read by scripts/changelog.mjs at build time, served at /api/releases; the newest one is the
# version in the status bar). Committed to main through the contents API, so Workers Builds deploys
# it; a GITHUB_TOKEN commit starts no workflow, and the patch count below skips these commits.
# A failed write is reported, never fatal: the release stands.
CHANGELOG=apps/web/changelog.json
# Each bullet opens with its type tags, `[Feature] [Fix] **Headline**: ...`; they become the
# takeaway's chips. Unknown tags are dropped.
TAGS_JQ='map(capture("^(?<tags>(\\[[A-Za-z]+\\][ \t]*)*)(?<text>.*)$")
  | [.tags | scan("\\[([A-Za-z]+)\\]")[0] | ascii_downcase] as $tags
  | {text, types: [$tags[] | select(IN("feature", "improvement", "fix", "performance", "security"))] | unique})'
changelog() { # tag published_at notes sha
  bullets=$(printf '%s\n' "$3" | awk '
    /^#{1,3}[ \t]/ { if (inside) exit; inside = tolower($0) ~ /key takeaways/; next }
    inside && /^[ \t]*[-*][ \t]+/ { sub(/^[ \t]*[-*][ \t]+/, ""); print }' | jq -R . | jq -s "$TAGS_JQ")
  for attempt in 1 2 3; do
    file=$(gh api "repos/$REPO/contents/$CHANGELOG?ref=main") || break
    sha=$(jq -r .sha <<< "$file")
    next=$(jq -r .content <<< "$file" | base64 -d | jq --arg tag "$1" --arg at "$2" --arg sha "$4" --argjson t "$bullets" \
      '[{tag: $tag, sha: $sha, published_at: $at, takeaways: $t}] + map(select(.tag != $tag))
       | sort_by(.published_at) | reverse')
    gh api -X PUT "repos/$REPO/contents/$CHANGELOG" -f message="changelog: $1" -f branch=main \
      -f sha="$sha" -f content="$(printf '%s\n' "$next" | base64 -w0)" --silent && return
    sleep $((attempt * 2))
  done
  echo "could not write $1 to $CHANGELOG" >&2
}

takeaways() { # tag sha previous-tag: Key takeaways and changes by desk, from the PRs
  prs=$(git log --first-parent --format=%s "$3..$2" | grep -oE '\(#[0-9]+\)$' | tr -dc '0-9\n')
  pulls=$(for n in $prs; do
    gh api "repos/$REPO/pulls/$n" --jq '{number, title, body, login: .user.login}' \
      || { echo "could not read PR #$n" >&2; return 1; }
  done) || return 1
  input=$(jq -r '"## #\(.number) \(.title)\n\((.body // "") | .[0:1500])\n"' <<< "$pulls")
  list=$(jq -r '"- #\(.number) \(.title) (@\(.login))"' <<< "$pulls")
  prompt="Write the GitHub release notes for MailCellar $1, which covers the merged pull requests below. \
MailCellar keeps every Gmail message a person has, searchable and private, on Cloudflare's free tier. \
Start with '## Key takeaways': 3 to 5 bullets, each opening with one or more type tags from [Feature] [Improvement] [Fix] [Performance] [Security] \
(e.g. '- [Feature] **Headline**: sentence'), then a bold one-line headline, then one plain sentence on what a user can now do. \
Write each bullet for a new user who has never seen the change: the sentence must say where it lives, \
as they would find it, with the page or menu path (e.g. 'In Settings ▸ Accounts, ...', 'On the Senders page, ...'), \
and name the thing changed in full; a change with no screen says what it affects. \
Key takeaways are only what a user can notice: leave out CI, build, test and internal-only changes. \
Then one '## <area>' section per area touched (App, Gmail, Search, Sync, Storage, Infra), \
a few short bullets each in plain words, merging related PRs. No PR numbers, no file paths. \
Output only the markdown."
  body=$(jq -n --arg model "$MODEL" --arg text "$prompt"$'\n\n'"$input" \
    '{model: $model, max_tokens: 16000, messages: [{role: "user", content: $text}]}')
  # The model thinks before it writes, so 4,000 tokens ran out on every release of 2026-10-22.
  # Only a whole reply is published: v0.3.56 went out cut mid-sentence. Anything but end_turn
  # (max_tokens, refusal, an error) is asked again, at most 3 times, then fails the release.
  for attempt in 1 2 3; do
    reply=$(curl -sS https://api.anthropic.com/v1/messages \
      -H "x-api-key: $ANTHROPIC_API_KEY" -H 'anthropic-version: 2023-06-01' \
      -H 'content-type: application/json' -d "$body")
    text=$(jq -r 'if .stop_reason == "end_turn"
      then [.content[]? | select(.type == "text") | .text] | join("") else "" end' <<< "$reply")
    [ -n "$text" ] && break
    # show why, without the key
    jq -c '{type, error, stop_reason, model, blocks: [.content[]?.type]}' <<< "$reply" >&2
    sleep $((attempt * 5))
  done
  [ -n "$text" ] || return 1
  printf '%s' "$text"
  printf '\n\n## Pull requests (%s)\n%s\n\nFull changelog: https://github.com/%s/compare/%s...%s\n' \
    "$(echo "$prs" | wc -w | tr -d ' ')" "$list" "$REPO" "$3" "$1"
}

if [ "$BUMP" = minor ]; then
  TAG="v0.$((MINOR + 1)).0"
  FILE="docs/releases/$TAG.md"
  git show "origin/main:$FILE" > /dev/null 2>&1 \
    || { echo "$FILE is not on main: write the key takeaways first (docs/releases.md)" >&2; exit 1; }
  git show "origin/main:$FILE" > "${RUNNER_TEMP:-/tmp}/notes.md"
  release "$TAG" "$(git rev-parse origin/main)" "v0.$MINOR.0" "${RUNNER_TEMP:-/tmp}/notes.md"
  exit
fi
if [ "$BUMP" = notes ]; then
  TAG="v0.$MINOR.0"
  git show "origin/main:docs/releases/$TAG.md" > "${RUNNER_TEMP:-/tmp}/notes.md" 2> /dev/null \
    || { echo "docs/releases/$TAG.md is not on main" >&2; exit 1; }
  if [ "$DRY_RUN" = 1 ]; then echo "would set $TAG notes from docs/releases/$TAG.md"; exit; fi
  id=$(gh api "repos/$REPO/releases/tags/$TAG" --jq .id)
  at=$(gh api -X PATCH "repos/$REPO/releases/$id" -F body=@"${RUNNER_TEMP:-/tmp}/notes.md" --jq .published_at)
  echo "$TAG notes set from docs/releases/$TAG.md"
  changelog "$TAG" "$at" "$(cat "${RUNNER_TEMP:-/tmp}/notes.md")" "$(git rev-list -n1 "$TAG")"
  exit
fi
# The changelog commits release.sh itself writes are not merges.
mapfile -t MERGES < <(git rev-list --first-parent --reverse --invert-grep --grep='^changelog: ' "$LATEST..origin/main")
# Behind by a batch or more (a recut over main's history): one patch at each RELEASE_EVERY-th merge.
LATEST_SHA=$(git rev-list -n1 "$LATEST")
while [ "${#MERGES[@]}" -ge "$RELEASE_EVERY" ]; do
  PATCH=$((PATCH + 1))
  LATEST_SHA=${MERGES[$((RELEASE_EVERY - 1))]}
  release "v0.$MINOR.$PATCH" "$LATEST_SHA" "$LATEST"
  LATEST="v0.$MINOR.$PATCH"
  MERGES=("${MERGES[@]:$RELEASE_EVERY}")
done
COUNT=${#MERGES[@]}
if [ "$COUNT" = 0 ]; then echo "nothing merged since $LATEST"; exit; fi
AGE_DAYS=$(( ($(date +%s) - $(git log -1 --format=%ct "$LATEST_SHA")) / 86400 ))
if [ "$FORCE" != 1 ] && [ "$AGE_DAYS" -lt 7 ]; then
  echo "$COUNT of $RELEASE_EVERY merges, $AGE_DAYS of 7 days since $LATEST: no release yet"
  exit
fi
release "v0.$MINOR.$((PATCH + 1))" "$(git rev-parse origin/main)" "$LATEST"
