// lib/skill-package/mode.mjs
// Deciding whether one file is EXECUTABLE, on a platform that may not be able to tell you.
//
// WHY THIS EXISTS. `fsx.execAwareMode()` answers the question from the source `stat`, which is
// correct on the way OUT of this repo — the local filesystem is authoritative about a file it
// holds. It is wrong on the way IN. Windows/NTFS has no execute bit at all: libuv reports one only
// for `.exe/.cmd/.bat/.com`, and `chmodSync` there succeeds while doing nothing
// (docs/guide/pending-update/windows-compatibility.md §6). So a skill that passes through ANY
// Windows checkout loses `+x` on every `.sh` and `.py` it carries, silently, and nothing
// downstream can notice: the manifest `bundle{}` records content hashes only, so `skill verify`
// and `skill doctor` are structurally blind to the loss (INC-2026-09-05-02, X-3, and before it
// memory `skill-export-drops-file-mode`, where five non-executable scripts were published through
// a full export run in which every gate passed).
//
// The answer is to stop deriving executability from whichever filesystem the bytes are sitting on
// and read it from the most authoritative signal available, in this order:
//
//   1. A recorded `modes{}` in the incoming manifest. Someone already decided this, on a machine
//      that could tell. Nothing observed later outranks a recorded decision.
//   2. The source repository's git index. `git ls-files -s` reports 100755 vs 100644 from the
//      OBJECT, not from the working tree, so it is right even when the working tree is on NTFS.
//      This is the signal that makes a Windows-hosted import correct rather than merely honest.
//   3. The source `stat`. Right on POSIX, uninformative (never executable) on Windows.
//   4. A `#!` shebang. A file that names an interpreter was meant to be run. Weakest of the four
//      and used only when the three above said nothing, because it is an inference about intent
//      rather than an observation.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sep } from 'node:path';

/** The two modes this framework ever writes. A raw mode copy drags umask and platform bits along. */
export const MODE_EXEC = 0o755;
export const MODE_PLAIN = 0o644;

/** `755`/`644` as the manifest records them, from a numeric file mode. */
export function modeDigits(mode) {
  return (mode & 0o111) ? 755 : 644;
}

/** A manifest `modes{}` digit back to a real file mode. */
export function modeFromDigits(digits) {
  return Number(digits) === 755 ? MODE_EXEC : MODE_PLAIN;
}

/**
 * Does this file begin with `#!`?
 *
 * Reads two bytes, not the file: a skill may carry a multi-megabyte asset and this runs per file.
 *
 * @param {string} abs
 * @returns {boolean}
 */
export function hasShebang(abs) {
  let fd = null;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(2);
    const n = readSync(fd, buf, 0, 2, 0);
    return n === 2 && buf[0] === 0x23 && buf[1] === 0x21;
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * Every path the source git repository records as executable, skill-folder-relative and POSIX.
 *
 * Returns null — distinct from an empty set — when the source is not a git worktree or git is not
 * available, so a caller can tell "git says nothing is executable" from "git could not be asked".
 *
 * One spawn per skill folder, not per file. `shell: false`, so a path with a space or a shell
 * metacharacter is an argument rather than syntax.
 *
 * @param {string} skillDir - absolute
 * @returns {Set<string>|null}
 */
export function gitExecPaths(skillDir) {
  const r = spawnSync('git', ['-C', skillDir, 'ls-files', '-s', '--', '.'], {
    encoding: 'utf8', shell: false,
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
  const out = new Set();
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    // `<mode> <object> <stage>\t<path>` — the path is everything after the first tab, and it is
    // reported relative to the -C directory because of the `-- .` pathspec.
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const mode = line.slice(0, 6);
    if (mode !== '100755') continue;
    out.add(line.slice(tab + 1).split(sep).join('/'));
  }
  return out;
}

/**
 * The mode one incoming file should land with.
 *
 * @param {string} abs - the source file
 * @param {object} [ctx]
 * @param {Record<string, number>} [ctx.recorded] - the incoming manifest's `modes{}`
 * @param {Set<string>|null} [ctx.gitExec] - from gitExecPaths(), or null when git said nothing
 * @param {string} [ctx.rel] - the file's skill-relative POSIX path, for the two lookups above
 * @param {boolean} [ctx.allowShebang=true] - consult step 4 at all; see recordModes()
 * @returns {number} MODE_EXEC or MODE_PLAIN
 */
export function resolveSourceMode(abs, ctx = {}) {
  const rel = ctx.rel;
  // 1. A recorded decision outranks anything observed now.
  if (rel && ctx.recorded && Object.prototype.hasOwnProperty.call(ctx.recorded, rel)) {
    return modeFromDigits(ctx.recorded[rel]);
  }
  // 2. The source's git index, which is platform-independent. Only consulted when git actually
  //    answered: an empty set from a real repo IS an answer ("nothing here is executable"), and
  //    trusting it is the whole point — it is what a Windows working tree cannot tell us.
  if (rel && ctx.gitExec) return ctx.gitExec.has(rel) ? MODE_EXEC : MODE_PLAIN;
  // 3. The local stat. Authoritative on POSIX; always says "not executable" on Windows.
  let statSaidExec = null;
  try {
    statSaidExec = (statSync(abs).mode & 0o111) !== 0;
  } catch { /* unreadable; fall through */ }
  if (statSaidExec) return MODE_EXEC;
  // 4. Intent, when nothing OBSERVED it. Deliberately last, and skippable — see recordModes().
  if (ctx.allowShebang === false) return MODE_PLAIN;
  return hasShebang(abs) ? MODE_EXEC : MODE_PLAIN;
}

/**
 * The `modes{}` block for one skill folder: only the paths that are executable.
 *
 * NO SHEBANG INFERENCE WHERE THE FILESYSTEM CAN ANSWER. Recording is not the same job as copying.
 * When a copy arrives from somewhere the mode is unknowable, guessing from `#!` is better than
 * losing the bit. But this writes the baseline `mode-drift` is graded against, and on POSIX the
 * local stat IS the truth — so inferring here would make a deliberate `chmod -x` unrecordable: the
 * re-record would put 755 straight back, `mode-drift` would fire for ever, and `skill doctor`'s own
 * advice ("re-record if it is deliberately no longer executable") would be a lie. The inference is
 * therefore allowed only where nothing else can answer: Windows, where NTFS has no bit to read and
 * git has already had its say above.
 *
 * @param {string} skillDir - absolute
 * @param {Array<{rel: string, abs: string}>} files
 * @returns {Record<string, number>} possibly empty
 */
export function recordModes(skillDir, files) {
  const gitExec = gitExecPaths(skillDir);
  const allowShebang = process.platform === 'win32';
  const out = {};
  for (const f of files) {
    const mode = resolveSourceMode(f.abs, { rel: f.rel, gitExec, allowShebang });
    if (mode === MODE_EXEC) out[f.rel] = 755;
  }
  return out;
}
