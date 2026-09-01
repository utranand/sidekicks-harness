// lib/fs-safety/fsx.mjs
// Atomic filesystem utilities: writeAtomic, rmrf, mkdirp, copyAtomic.
// Zero npm dependencies — node:fs, node:path, node:crypto only.
// Every write is write-to-temp-then-fs.renameSync (crash-safe).
// All errors are wrapped as SidekicksError(EXIT_IO) per architecture Implementation Patterns.

import { writeFileSync, renameSync, mkdirSync, rmSync, existsSync, readFileSync, statSync, symlinkSync, chmodSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SidekicksError, EXIT_IO } from '../sk-cli/errors.mjs';

/**
 * Atomically write `content` to `absPath`.
 * Writes to a same-directory temp file first, then renames to the target.
 * Creates the parent directory if it does not exist.
 *
 * @param {string} absPath  - Absolute path to the target file.
 * @param {string} content  - UTF-8 string content to write.
 * @param {{mode?: number}} [opts] - Optional. `mode`, when given, is applied to the temp file
 *   BEFORE the rename, so the final path never briefly exists with the wrong mode. Omitted
 *   entirely (the default for every existing call site) leaves today's behaviour untouched.
 * @throws {SidekicksError(EXIT_IO)} on any filesystem failure.
 */
/**
 * True if a directory entry is itself a directory, OR a symlink whose target resolves
 * to a directory. This lets a symlinked external project folder under `projects/` be
 * discovered like a real one — a directory-symlink dirent reports `isDirectory() === false`
 * (verified on macOS), so plain `.filter(d => d.isDirectory())` scans would silently drop it.
 * Both branches are covered for cross-platform safety: POSIX symlinks land in the
 * `isSymbolicLink()` path, while a Windows directory junction may already report
 * `isDirectory() === true`. Broken or unresolvable symlinks return false.
 *
 * @param {import('node:fs').Dirent} dirent - a withFileTypes readdir entry
 * @param {string} parentDir - absolute path of the directory containing `dirent`
 * @returns {boolean}
 */
/**
 * Create a directory link at `linkPath` pointing to the directory `absTarget`,
 * cross-platform. `absTarget` MUST be absolute — a linked external project lives
 * out of the repo tree (often another volume), so an absolute target is what stays
 * valid; a relative one would not resolve. The parent of `linkPath` is created if
 * missing. Mirrors the platform split used for host skill links (skill-links.mjs):
 *   - Windows → NTFS junction (no admin/Developer-Mode privilege required)
 *   - POSIX   → absolute directory symlink
 *
 * @param {string} absTarget - Absolute path to the existing target directory.
 * @param {string} linkPath  - Absolute path of the link to create (must not exist).
 * @throws {SidekicksError(EXIT_IO)} on any filesystem failure.
 */
export function createDirLink(absTarget, linkPath) {
  try {
    mkdirSync(dirname(linkPath), { recursive: true });
    if (process.platform === 'win32') {
      symlinkSync(absTarget, linkPath, 'junction');
    } else {
      symlinkSync(absTarget, linkPath, 'dir');
    }
  } catch (err) {
    throw new SidekicksError(
      `createDirLink: failed to link '${linkPath}' → '${absTarget}': ${err.message}`,
      EXIT_IO
    );
  }
}

/**
 * Remove a directory link created by `createDirLink`, WITHOUT following it — the target is
 * never touched. The inverse of createDirLink, and the same platform split in reverse.
 *
 * Three spellings of "delete this link" and only this one is safe on both OSes:
 *   - `unlinkSync` is correct for a POSIX symlink but throws EPERM on a Windows JUNCTION,
 *     which Windows insists is removed as a directory (the reason for the fallback).
 *   - `rmSync(p, { force: true })` — the reflexive choice — throws ERR_FS_EISDIR on a macOS
 *     symlink-to-a-directory, so it silently only works for links to files.
 *   - `rmSync(p, { recursive: true })` would be worse than either: it invites deleting the
 *     TARGET's contents, which for a linked `node_modules` is the main checkout's install.
 *
 * @param {string} linkPath - Absolute path of the link to remove.
 * @throws {SidekicksError(EXIT_IO)} on any filesystem failure other than a missing path.
 */
export function removeDirLink(linkPath) {
  try {
    unlinkSync(linkPath);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    if (err.code !== 'EPERM' && err.code !== 'EISDIR' && err.code !== 'ERR_FS_EISDIR') {
      throw new SidekicksError(
        `removeDirLink: failed to remove link '${linkPath}': ${err.message}`,
        EXIT_IO
      );
    }
    try {
      // recursive:false removes the reparse point / directory entry itself, never its contents.
      rmSync(linkPath, { recursive: false, force: false });
    } catch (err2) {
      throw new SidekicksError(
        `removeDirLink: failed to remove link '${linkPath}': ${err2.message}`,
        EXIT_IO
      );
    }
  }
}

/**
 * True if a directory entry is itself a directory, OR a symlink whose target resolves
 * to a directory. This lets a symlinked external project folder under `projects/` be
 * discovered like a real one — a directory-symlink dirent reports `isDirectory() === false`
 * (verified on macOS), so plain `.filter(d => d.isDirectory())` scans would silently drop it.
 * Both branches are covered for cross-platform safety: POSIX symlinks land in the
 * `isSymbolicLink()` path, while a Windows directory junction may already report
 * `isDirectory() === true`. Broken or unresolvable symlinks return false.
 *
 * @param {import('node:fs').Dirent} dirent - a withFileTypes readdir entry
 * @param {string} parentDir - absolute path of the directory containing `dirent`
 * @returns {boolean}
 */
export function isDirLikeDirent(dirent, parentDir) {
  if (dirent.isDirectory()) return true;
  if (dirent.isSymbolicLink()) {
    try {
      return statSync(join(parentDir, dirent.name)).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

/** Owner-only file and directory modes for anything holding a credential or private state. */
export const SECRET_FILE_MODE = 0o600;
export const SECRET_DIR_MODE = 0o700;

/**
 * Atomically write a file that holds a CREDENTIAL or private runtime state, owner-only.
 *
 * writeAtomic() has supported an explicit mode for a long time; across 85 call sites, two passed
 * one and none passed 0600. So bearer tokens, `*.secret.yaml` credential halves and private agent
 * state all landed at the umask default (0644 in a 0755 directory) — git-ignored, which stops a
 * commit and does nothing about another local account reading them. Centralizing the decision is
 * the point: a rule every caller has to remember is a rule that gets forgotten.
 *
 * WINDOWS, stated plainly rather than papered over: chmod is largely inert there — Node maps it
 * to the read-only attribute, not an ACL. The directory mode is still applied and the atomic
 * write still behaves, but owner-only enforcement on Windows needs a real ACL (icacls) and is NOT
 * claimed here. Callers must not treat a Windows run as hardened.
 *
 * @param {string} absPath
 * @param {string} content
 */
export function writeSecretAtomic(absPath, content, opts = {}) {
  const dir = dirname(absPath);
  try {
    // `privateDir` is opt-in, and the default is deliberately NOT to touch the directory.
    // A `.secret.yaml` lives in `config/` ALONGSIDE the committed, non-secret family files, so
    // chmodding that directory to 0700 locked `jira.yaml`, `agents.yaml` and `.gitignore` away
    // from any other uid — a container, a CI runner, a second local account, a group-shared
    // checkout — none of which the threat model ever wanted to exclude. It also contradicted
    // the committed half's own rule that it keeps ordinary permissions. The file mode below is
    // self-sufficient; the directory is only restricted where the WHOLE tree is private
    // (.bridge/runtime/), and even then only on creation plus an explicit tighten.
    if (opts.privateDir) {
      mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
      chmodSync(dir, SECRET_DIR_MODE);
    } else {
      mkdirSync(dir, { recursive: true });
    }
  } catch (err) {
    if (err && err.code === 'ENOSYS') { /* chmod unsupported (some Windows filesystems) */ }
    else if (err && err.code !== 'EPERM') {
      throw new SidekicksError(
        `writeSecretAtomic: failed to prepare directory '${dir}': ${err.message}`,
        EXIT_IO
      );
    }
  }
  writeAtomic(absPath, content, { mode: SECRET_FILE_MODE });
}

/**
 * Tighten an EXISTING sensitive file (and its directory) to owner-only, best-effort.
 *
 * The write path above only fixes files written from now on; a repo that already has a 0644
 * `bridge.json` keeps it until something repairs it. Returns what it changed so a doctor can
 * report it, and never throws — a permissions repair must not break the read it rode in on.
 *
 * @param {string} absPath
 * @returns {{repaired: boolean, from: number|null}}
 */
export function tightenSecretMode(absPath, opts = {}) {
  try {
    if (process.platform === 'win32') return { repaired: false, from: null };
    const before = statSync(absPath).mode & 0o777;
    if ((before & 0o077) === 0) return { repaired: false, from: before };
    chmodSync(absPath, SECRET_FILE_MODE);
    // The parent is touched only for a WHOLLY private tree, and only when the caller says so.
    // Tightening it unconditionally meant a repair on one `.secret.yaml` silently restricted the
    // committed family files sitting beside it — a change no verb reverses and `config doctor`
    // cannot even see, since it reports file modes only.
    if (opts.privateDir) {
      try {
        const dir = dirname(absPath);
        if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, SECRET_DIR_MODE);
      } catch { /* the file is the sensitive half; a stubborn parent is not worth failing on */ }
    }
    return { repaired: true, from: before };
  } catch {
    return { repaired: false, from: null };
  }
}

export function writeAtomic(absPath, content, opts) {
  const dir = dirname(absPath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new SidekicksError(
      `writeAtomic: failed to create directory '${dir}': ${err.message}`,
      EXIT_IO
    );
  }

  // Generate a temp filename in the same directory (same filesystem — rename is atomic).
  const tmpPath = join(dir, `.sk-tmp-${randomBytes(8).toString('hex')}`);

  try {
    // The mode goes on at CREATION, not only in the chmod below. Writing the temp file at the
    // umask default first left a credential readable on disk for the window between the write
    // and the chmod — short, but a window is a window, and the chmod is kept as the belt that
    // covers a platform ignoring the create mode.
    writeFileSync(tmpPath, content, opts && opts.mode !== undefined ? { encoding: 'utf8', mode: opts.mode } : 'utf8');
  } catch (err) {
    throw new SidekicksError(
      `writeAtomic: failed to write temp file '${tmpPath}': ${err.message}`,
      EXIT_IO
    );
  }

  // Mode goes on the temp file, before the rename — the target path must never briefly exist
  // with the wrong mode. `opts` is optional so every pre-existing call site is untouched.
  if (opts && opts.mode !== undefined) {
    try {
      chmodSync(tmpPath, opts.mode);
    } catch (err) {
      try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      throw new SidekicksError(
        `writeAtomic: failed to chmod temp file '${tmpPath}': ${err.message}`,
        EXIT_IO
      );
    }
  }

  try {
    renameSync(tmpPath, absPath);
  } catch (err) {
    // Best-effort cleanup of the temp file; ignore cleanup errors.
    try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    throw new SidekicksError(
      `writeAtomic: failed to rename '${tmpPath}' → '${absPath}': ${err.message}`,
      EXIT_IO
    );
  }
}

/**
 * The normalized destination mode for a file copy, derived from the source: 0o755 if ANY execute
 * bit is set on the source, else 0o644. Deliberately NOT a raw copy of the source mode — a raw
 * copy drags along umask- and platform-dependent bits (e.g. group/other write) and makes a copy
 * non-reproducible across machines. Cross-platform with no branch: on Windows `chmodSync` only
 * toggles the read-only flag and the execute bit is meaningless there, which is harmless.
 *
 * @param {string} srcAbsPath - Absolute path of the source file (must already exist).
 * @returns {number} 0o755 or 0o644
 */
export function execAwareMode(srcAbsPath) {
  const mode = statSync(srcAbsPath).mode;
  return (mode & 0o111) ? 0o755 : 0o644;
}

/**
 * Recursively remove a directory (or file) at `absPath`.
 * No-op if the path does not exist.
 *
 * @param {string} absPath - Absolute path to remove.
 * @throws {SidekicksError(EXIT_IO)} on failure.
 */
export function rmrf(absPath) {
  if (!existsSync(absPath)) return;
  try {
    rmSync(absPath, { recursive: true, force: true });
  } catch (err) {
    throw new SidekicksError(
      `rmrf: failed to remove '${absPath}': ${err.message}`,
      EXIT_IO
    );
  }
}

/**
 * Recursively create directories at `absPath` (equivalent to `mkdir -p`).
 * No-op if the directory already exists.
 *
 * @param {string} absPath - Absolute path to create.
 * @throws {SidekicksError(EXIT_IO)} on failure.
 */
export function mkdirp(absPath) {
  try {
    mkdirSync(absPath, { recursive: true });
  } catch (err) {
    throw new SidekicksError(
      `mkdirp: failed to create directory '${absPath}': ${err.message}`,
      EXIT_IO
    );
  }
}

/**
 * Atomically copy `srcAbsPath` to `destAbsPath`.
 * Reads src with readFileSync, then delegates to writeAtomic (temp-then-rename).
 * Does NOT call assertWritable — caller is responsible for write-gating.
 *
 * @param {string} srcAbsPath  - Absolute path of the source file.
 * @param {string} destAbsPath - Absolute path of the destination file.
 * @throws {SidekicksError(EXIT_IO)} if the source is unreadable.
 */
export function copyAtomic(srcAbsPath, destAbsPath) {
  let content;
  try {
    content = readFileSync(srcAbsPath, 'utf8');
  } catch (err) {
    throw new SidekicksError(
      `copyAtomic: failed to read source '${srcAbsPath}': ${err.message}`,
      EXIT_IO
    );
  }
  writeAtomic(destAbsPath, content);
}
