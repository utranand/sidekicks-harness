// lib/fs-safety/canonical-path.mjs
// Path containment that survives symlinks, junctions, `..`, and Windows case — the one answer to
// "is this destination really where the caller said it was".
//
// WHY THIS IS ITS OWN MODULE. The repo had two half-correct containment helpers and one guard with
// neither:
//   - lib/skill-lifecycle/export.mjs resolved through realpath as far as a path exists (so an
//     --output about to be created still compares correctly), but compared case-sensitively;
//   - lib/sk-cli/core-mount.mjs isInsidePath() case-folded on Windows, but assumed both sides
//     were already realpath'd, which a not-yet-created destination can never be;
//   - lib/package-lifecycle/plan.mjs compared lexical resolve() output with startsWith(), which an
//     external symlink or an NTFS junction pointing back into the source repo walks straight past.
// The third one was a reproduced boundary violation: `package create --output <symlink-into-repo>`
// was accepted, and `package transfer ../scripts --output <tmp>/requested` wrote to <tmp>/scripts.
//
// The two properties have to be present together. Partial realpath without case folding misses a
// Windows bypass; case folding without partial realpath refuses every legitimate new directory.
//
// NOT a permission check. lib/fs-safety/fs-guard.mjs owns the CLI write surface (Rule 1); this
// module answers a narrower question — containment — for the paths that leave that surface, where an
// answer of "outside" is a refusal rather than a routing decision.
//
// Zero npm dependencies — node:* only.

import { realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const isWindows = process.platform === 'win32';

/**
 * A path resolved through realpath AS FAR AS IT EXISTS, with the unresolved tail re-appended.
 *
 * The walk is the point: a destination is usually about to be created, so `realpathSync` on the full
 * path throws. Walking up to the nearest existing ancestor and re-attaching the remainder gives a
 * canonical form for a path that is not there yet — which is exactly the moment a containment check
 * has to be right, because after the write it is too late.
 *
 * On macOS this is also what makes `/tmp` and `/private/tmp` compare equal: `process.cwd()` reports
 * the resolved form while an `--output` the operator typed does not.
 *
 * @param {string} p
 * @returns {string} absolute, canonical as far as the filesystem could tell
 */
export function realPartial(p) {
  let cur = resolve(p);
  for (;;) {
    try { return join(realpathSync(cur), resolve(p).slice(cur.length)); } catch { /* keep walking */ }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    cur = up;
  }
}

/**
 * Whether `candidate` is `parent` or sits underneath it, symlinks and junctions resolved.
 *
 * Case-folded on Windows: NTFS is case-insensitive, so `C:\Repo` and `c:\repo` are one directory and
 * a case-sensitive comparison is a bypass, not a nicety.
 *
 * @param {string} candidate
 * @param {string} parent
 * @returns {boolean}
 */
export function isInside(candidate, parent) {
  const a = fold(realPartial(candidate));
  const b = fold(realPartial(parent));
  return a === b || a.startsWith(b + sep);
}

/**
 * Do two paths name the same directory, symlinks resolved?
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameDir(a, b) {
  return fold(realPartial(a)) === fold(realPartial(b));
}

/**
 * Whether `name` is usable as exactly ONE path component under a caller-chosen directory.
 *
 * Everything rejected here is a way of escaping the directory the caller named, and each was
 * reachable: `..` walks out of it, a separator reaches into a sibling subtree, an absolute path or a
 * `C:` drive prefix ignores the base entirely, and a `\\host\share` UNC prefix leaves the machine.
 * Callers used `existsSync(join(base, name))` as their only validation, which answers a different
 * question — `join()` collapses `..` first, so the escaped path exists and the check passes.
 *
 * Both separators are rejected on both platforms on purpose: a `\` is a legal filename character on
 * POSIX, but a name carrying one is either an attempt at a Windows path or something no unit is
 * called, and accepting it would make the same input mean two things on two machines.
 *
 * @param {string} name
 * @returns {string|null} the reason it is unusable, or null when the name is a plain component
 */
export function badPathComponent(name) {
  if (typeof name !== 'string' || name === '') return 'is empty';
  if (name === '.' || name === '..') return `is '${name}', which names a directory, not a unit`;
  if (name.includes('/') || name.includes('\\')) return 'contains a path separator';
  if (name.startsWith('~')) return 'starts with ~, which a shell may expand to a home directory';
  if (/^[A-Za-z]:/.test(name)) return 'starts with a drive prefix';
  if (name.includes('\0')) return 'contains a NUL byte';
  return null;
}

/** Case-fold on Windows only, where the filesystem itself does. */
function fold(p) {
  return isWindows ? String(p).toLowerCase() : p;
}
