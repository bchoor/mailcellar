// Writes apps/web/dist/releases.json at build time for the status bar's What's new, served by
// the Worker at /api/releases. One entry per release, newest first: its Key takeaways
// (apps/web/changelog.json, written by scripts/release.sh) and the PRs merged in it, from git
// history. The newest entry's tag is the status bar's label: the version plus the deployed
// commit; PRs merged since that release head its list. With no release yet, one entry per PR.
// Real history only: nothing is written by hand.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const day = (at) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const merges = git('log', '--first-parent', '--format=%H%x09%cI%x09%s', 'HEAD')
  .split('\n')
  .map((line) => line.split('\t'))
  .map(([sha, at, subject]) => ({ sha, at, m: subject?.match(/^(.*) \(#(\d+)\)$/) }));
const prs = merges
  .filter((c) => c.m)
  .map(({ sha, at, m }) => ({ sha, at, number: m[2], title: m[1].replace(/^PR \d+: /, '') }));
const head = merges[0].sha.slice(0, 7);

/** @type {{ tag: string, sha: string, published_at: string, takeaways: { text: string, types: string[] }[] }[]} */
const cut = JSON.parse(readFileSync(join(root, 'apps/web/changelog.json'), 'utf8'));
// Only releases in this build's history: a build of an older commit shows the version it had.
const inHistory = new Set(merges.map((c) => c.sha));
const shipped = cut.filter((r) => inHistory.has(r.sha));

const line = (pr) => ({ text: `**#${pr.number}** ${pr.title} · ${day(pr.at)}`, types: [] });
let releases;
if (shipped.length === 0) {
  releases = prs.map((pr) => ({ tag: `#${pr.number} · ${pr.sha.slice(0, 7)}`, published_at: new Date(pr.at).toISOString(), takeaways: [line(pr)] }));
} else {
  // Walk newest to oldest: PRs belong to the newest release at or below them.
  const bucket = new Map(shipped.map((r) => [r.sha, []]));
  const since = [];
  let into = since;
  for (const c of merges) {
    if (bucket.has(c.sha)) into = bucket.get(c.sha);
    const pr = prs.find((p) => p.sha === c.sha);
    if (pr) into.push(pr);
  }
  releases = shipped.map((r, i) => ({
    tag: i === 0 ? `${r.tag} · ${head}` : r.tag,
    published_at: r.published_at,
    takeaways: [
      ...(i === 0 ? since.map((pr) => ({ ...line(pr), text: `Not in a release yet: ${line(pr).text}` })) : []),
      ...r.takeaways,
      ...bucket.get(r.sha).map(line),
    ],
  }));
}

const out = join(root, 'apps/web/dist/releases.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ releases }));
console.log(`changelog: ${shipped.length} releases, ${prs.length} merged PRs, at ${head}`);
