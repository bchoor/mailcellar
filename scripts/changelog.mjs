// Writes apps/web/dist/releases.json at build time: one entry per PR merged to main,
// newest first, from git history. The Worker serves it at /api/releases for the status
// bar's What's new. Real history only: nothing is written by hand.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// Build machines may clone shallowly; fetch the rest so older PRs are listed too.
if (git('rev-parse', '--is-shallow-repository') === 'true') {
  try {
    git('fetch', '--quiet', '--unshallow');
  } catch {
    console.warn('changelog: shallow clone and --unshallow failed; listing the history that is here');
  }
}

const releases = git('log', '--first-parent', '--format=%H%x09%cI%x09%s', 'HEAD')
  .split('\n')
  .map((line) => line.split('\t'))
  .map(([sha, at, subject]) => ({ sha, at, m: subject?.match(/^(.*) \(#(\d+)\)$/) }))
  .filter((c) => c.m)
  .map(({ sha, at, m }) => ({
    tag: `#${m[2]} · ${sha.slice(0, 7)}`,
    published_at: new Date(at).toISOString(),
    takeaways: [{ text: m[1].replace(/^PR \d+: /, ''), types: [] }],
  }));

const out = join(root, 'apps/web/dist/releases.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ releases }));
console.log(`changelog: ${releases.length} merged PRs`);
