// Writes apps/web/dist/releases.json at build time for the status bar's What's new, served by
// the Worker at /api/releases. One entry per release, newest first, with its Key takeaways only
// (apps/web/changelog.json, written by scripts/release.sh): plain words for people, never PR
// titles. The newest entry's tag is the status bar's label: the version plus the deployed commit.
// With no release yet the list is empty and What's new shows its empty state.
// Real history only: nothing is written by hand.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// Build machines may clone shallowly; fetch the rest so older releases are found too.
if (git('rev-parse', '--is-shallow-repository') === 'true') {
  try {
    git('fetch', '--quiet', '--unshallow');
  } catch {
    console.warn('changelog: shallow clone and --unshallow failed; listing the history that is here');
  }
}

const merges = git('log', '--first-parent', '--format=%H', 'HEAD').split('\n');
const head = merges[0].slice(0, 7);

/** @type {{ tag: string, sha: string, published_at: string, takeaways: { text: string, types: string[] }[] }[]} */
const cut = JSON.parse(readFileSync(join(root, 'apps/web/changelog.json'), 'utf8'));
// Only releases in this build's history: a build of an older commit shows the version it had.
const inHistory = new Set(merges);
const releases = cut
  .filter((r) => inHistory.has(r.sha))
  .map((r, i) => ({ tag: i === 0 ? `${r.tag} · ${head}` : r.tag, published_at: r.published_at, takeaways: r.takeaways }));

const out = join(root, 'apps/web/dist/releases.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ releases }));
console.log(`changelog: ${releases.length} releases, at ${head}`);
