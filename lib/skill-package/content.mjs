// lib/skill-package/content.mjs
// Where a bundled file's RECORDED content comes from when the file on disk is gone or wrong.
//
// This is the module `sidekicks skill heal --restore` is built on, and the one design question it
// answers is: `skill.manifest.yaml` records a `bundle{}` of sha256 hashes, not content. So a
// restore has to find the bytes somewhere, and a sha256 is not a git blob id — the recorded hash
// cannot be handed to `git cat-file` as an address.
//
// The answer is the repo's own git object store, searched by PATH and verified by HASH: read the
// path at a revision, hash the bytes the same way the baseline did, and accept only an exact match.
// Nothing is ever written from an unverified source, so the failure mode is "reports unhealable",
// never "restores the wrong file".
//
// MEASURED, not assumed (AAP-96): across all 1091 bundle entries in the 97 manifests this repo
// carries, the recorded hash matched `git show HEAD:<path>` for 1091 of them — 100%, zero misses.
// That is why HEAD is tried first, why a bounded history walk is enough as the fallback, and why no
// content-addressed cache is built yet. `sources` keeps the seam for one: the skills repo will grow
// a blob store (AAP-92), and adding it here means adding a branch to `resolveContent`, not
// rethinking the contract.
//
// It also explains why this works identically on Windows. The bundle hash is LF-normalized
// (lib/skill-manifest/hash.mjs), and a git blob IS the normalized form, so a checkout with
// core.autocrlf=true resolves to the same blob and the restored LF content re-hashes clean. One
// implementation, no OS fork.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { relative } from 'node:path';
import { hashContent, hashFile, isBinaryPath } from '../skill-manifest/hash.mjs';
import { logRevs, showBlob } from '../git-delegation/git.mjs';

/** How far back a path is followed before the search is called off. */
export const HISTORY_LIMIT = 20;

/** The sources `resolveContent` knows how to read, in the order it tries them. */
export const SOURCES = Object.freeze(['disk', 'git']);

/**
 * Repo-relative, POSIX-separated form of an absolute path — the shape git speaks and the shape a
 * portable artifact records (`rule.portable-artifact-paths`: no machine-absolute path is ever
 * persisted or printed as an identifier).
 *
 * @param {string} repoRoot
 * @param {string} absPath
 * @returns {string}
 */
export function toRepoRel(repoRoot, absPath) {
  return relative(repoRoot, absPath).split('\\').join('/');
}

/**
 * Find content whose hash equals `wantHash`.
 *
 * The disk check comes first and is not an optimization: it is what makes heal idempotent. A second
 * `--apply` finds the file already correct, reports `source: 'disk'`, and does nothing.
 *
 * @param {string} repoRoot
 * @param {string} absPath - the file's location on disk (may not exist)
 * @param {string} wantHash - the `sha256:<hex>` the bundle recorded
 * @param {{sources?: string[], historyLimit?: number, revs?: string[]}} [opts]
 *   `revs` pins the search to exactly those revisions (the `--from <ref>` form) instead of
 *   HEAD-then-history. An explicit ref is an instruction, so it is not widened silently.
 * @returns {{found: boolean, content: Buffer|null, source: string|null, tried: string[]}}
 *   `source` is `'disk'`, `'git:HEAD'` or `'git:<sha-or-ref>'`. `content` is null when `source` is
 *   `'disk'` — there is nothing to write — and when nothing matched.
 */
export function resolveContent(repoRoot, absPath, wantHash, opts = {}) {
  const sources = opts.sources || SOURCES;
  const limit = opts.historyLimit === undefined ? HISTORY_LIMIT : opts.historyLimit;
  const relPath = toRepoRel(repoRoot, absPath);
  const binary = isBinaryPath(absPath);
  const tried = [];

  if (sources.includes('disk')) {
    tried.push('disk');
    if (hashFile(absPath) === wantHash) {
      return { found: true, content: null, source: 'disk', tried };
    }
  }

  if (sources.includes('git')) {
    // HEAD first and by name, because the overwhelming case is "a tracked file was deleted or
    // edited since it was recorded" and HEAD answers it in one spawn. Then a BOUNDED walk back
    // through the revisions that touched this path — bounded on purpose: an unbounded
    // `rev-list --all` search would turn one unhealable file into a repo-wide scan, and a hash
    // recorded further back than this is a manifest that stopped being maintained, which is a
    // different problem the report names rather than papers over.
    const revs = opts.revs && opts.revs.length
      ? opts.revs
      : ['HEAD', ...logRevs(repoRoot, relPath, limit)];
    const seen = new Set();
    for (const rev of revs) {
      if (seen.has(rev)) continue;
      seen.add(rev);
      tried.push(`git:${rev.length === 40 ? rev.slice(0, 7) : rev}`);
      const buf = showBlob(repoRoot, rev, relPath);
      if (buf && hashContent(buf, binary) === wantHash) {
        return { found: true, content: buf, source: `git:${rev}`, tried };
      }
    }
  }

  return { found: false, content: null, source: null, tried };
}
