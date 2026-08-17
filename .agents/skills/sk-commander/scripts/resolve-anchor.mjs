// .agents/skills/sk-commander/scripts/resolve-anchor.mjs
//
// Resolve a command-sequence step ANCHOR (work_dir / docs_dir / artifacts_dir) at PARSE TIME, so the
// commander can bake a concrete, location-independent value into the Workflow script it authors.
// (The Workflow runtime has no filesystem access and cannot resolve paths itself — see the commander
// SKILL.md "File-relative anchors" section.)
//
// The rule (one place, shared by the CLI and the test):
//   • A LEADING-DOT value — exactly `.` or `..`, or one starting `./`, `../`, `.\`, `..\` — is
//     FILE-RELATIVE: resolved against the sequence file's own directory, then expressed REPO-RELATIVE
//     (with forward slashes) so it travels and still drives scope alignment. This is what lets a
//     generated bundle carry `work_dir: .` and be relocated anywhere inside the repo.
//   • Any other relative value (`projects/…`, `.sidekicks/…`, a bare name) is REPO-RELATIVE already —
//     passed through unchanged. Note `.sidekicks/…` is NOT leading-dot (it does not start with `./`),
//     so it is correctly left alone.
//   • An absolute value is passed through unchanged.
//   • An empty / undefined value returns '' (the step omits the anchor).
//
// Cross-platform: pure node:path, tolerates `/` and `\` inputs, always emits `/` (POSIX) output so the
// baked YAML/brief reads the same on macOS and Windows.

import path from 'node:path';

/** True iff `value` is a leading-dot relative path (`.`, `..`, `./…`, `../…`, `.\…`, `..\…`). */
export function isLeadingDot(value) {
  if (value === '.' || value === '..') return true;
  return /^\.\.?[\\/]/.test(value);
}

/**
 * @param {string} value     the step's raw anchor (work_dir/docs_dir/artifacts_dir)
 * @param {string} seqFile   absolute path to the command-sequence FILE (its dirname is the anchor base)
 * @param {string} repoRoot  absolute repo root (nearest ancestor with .sidekicks/)
 * @returns {string}         resolved value: repo-relative (POSIX) for leading-dot; unchanged otherwise
 */
export function resolveAnchor(value, seqFile, repoRoot) {
  if (value == null || value === '') return '';
  if (path.isAbsolute(value)) return value;          // absolute → as-is
  if (!isLeadingDot(value)) return value;            // repo-relative (projects/…, .sidekicks/…) → as-is
  const seqDir = path.dirname(path.resolve(seqFile));
  const abs = path.resolve(seqDir, value);           // anchor the leading-dot value to the file's folder
  const rel = path.relative(path.resolve(repoRoot), abs);
  // Express repo-relative with POSIX separators; '.' (the repo root itself) stays '.'.
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

// --- CLI: `node resolve-anchor.mjs <seqFile> <value> [<repoRoot>]` → prints the resolved value -------
// repoRoot defaults to the nearest ancestor of seqFile containing a .sidekicks/ directory.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [seqFile, value, repoRootArg] = process.argv.slice(2);
  if (!seqFile || value === undefined) {
    process.stderr.write('usage: resolve-anchor.mjs <seqFile> <value> [<repoRoot>]\n');
    process.exit(2);
  }
  let repoRoot = repoRootArg;
  if (!repoRoot) {
    const { existsSync } = await import('node:fs');
    let r = path.dirname(path.resolve(seqFile));
    while (r !== path.dirname(r) && !existsSync(path.join(r, '.sidekicks'))) r = path.dirname(r);
    repoRoot = r;
  }
  process.stdout.write(resolveAnchor(value, seqFile, repoRoot));
}
