// lib/package-lifecycle/fs-copy.mjs
// Recursive, symlink-aware copy helper for the package assembly engine.
// Internal helper — NOT barrel-exported.
// Writes via direct node:fs; NEVER calls assertWritable (external destination is outside the
// CLI-managed repo surface — see plan §6.1 write-guard caveat).

import {
  lstatSync,
  statSync,
  readdirSync,
  copyFileSync,
  symlinkSync,
  readlinkSync,
  chmodSync,
  constants as fsConstants,
} from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { mkdirp } from "../fs-safety/fsx.mjs";
import { SidekicksError, EXIT_IO } from "../sk-cli/errors.mjs";

const isWindows = process.platform === "win32";

/**
 * Recursively copy the directory tree rooted at `src` into `dst`.
 *
 * Behaviour:
 * - Symlinks are recreated as symlinks (not dereferenced). A symlink whose target is outside
 *   the tree is recreated verbatim.
 * - Regular files are copied byte-for-byte via copyFileSync.
 * - When `preserveMode` is true the source file mode is applied to the destination file
 *   (e.g., preserves 0755 on `bin/sidekicks`).
 * - Any path that resolves to a string in the `exclude` set (relative to `src`) is skipped
 *   entirely (the sub-tree under a skipped directory is not visited).
 * - MUST NOT import or call assertWritable — the external destination is outside the guarded
 *   CLI write surface.
 *
 * @param {string} src - Absolute path to the source root.
 * @param {string} dst - Absolute path to the destination root (created if absent).
 * @param {{ exclude?: Set<string>, preserveMode?: boolean }} [opts]
 */
export function copyTree(src, dst, opts = {}) {
  const { exclude = new Set(), preserveMode = false } = opts;

  mkdirp(dst);
  _copyDir(src, dst, src, exclude, preserveMode);
}

/**
 * @param {string} srcDir   Current source directory being walked.
 * @param {string} dstDir   Corresponding destination directory.
 * @param {string} srcRoot  The top-level src root (for relative-path exclude checks).
 * @param {Set<string>} exclude  Set of repo-relative paths to skip (relative to srcRoot).
 * @param {boolean} preserveMode  Whether to carry file modes to the destination.
 */
function _copyDir(srcDir, dstDir, srcRoot, exclude, preserveMode) {
  let entries;
  try {
    entries = readdirSync(srcDir);
  } catch (err) {
    throw new SidekicksError(
      `copyTree: cannot read source directory '${srcDir}': ${err.message}`,
      EXIT_IO
    );
  }

  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const dstPath = join(dstDir, entry);

    // Check exclude set using path relative to srcRoot
    const relPath = relative(srcRoot, srcPath);
    if (exclude.has(relPath) || exclude.has(relPath + "/")) {
      continue;
    }

    // Two config-store files NEVER travel, whatever the exclude set says:
    //
    //   *.secret.yaml              the credential half of a family file. Its committed sibling is
    //                              meant to travel; a package carrying this one would carry live
    //                              tokens off the machine.
    //   pending-removal.*          the pre-family monolith `config migrate --prune` retires. It holds
    //                              every credential the split moved out, and it is a rollback
    //                              reference for THIS checkout, meaningless anywhere else.
    //
    // Matched by name rather than through the exclude set on purpose: that set is compared against a
    // path relative to each copied subtree, so a repo-relative entry like
    // `.sidekicks/config/pending-removal.config.yaml` never matches once the walk starts inside
    // `.sidekicks/config/`. Its .gitignore-derived half cannot help either — the pattern normalizer
    // reduces `*.secret.yaml` to the empty string and drops it.
    if (entry.endsWith(".secret.yaml") || entry.startsWith("pending-removal.")) {
      continue;
    }

    let stat;
    try {
      stat = lstatSync(srcPath);
    } catch (err) {
      throw new SidekicksError(
        `copyTree: cannot stat '${srcPath}': ${err.message}`,
        EXIT_IO
      );
    }

    if (stat.isSymbolicLink()) {
      // Recreate as a link — do not dereference into a content copy.
      let target;
      try {
        target = readlinkSync(srcPath);
      } catch (err) {
        throw new SidekicksError(
          `copyTree: cannot read symlink '${srcPath}': ${err.message}`,
          EXIT_IO
        );
      }

      // Classify the target. A DIRECTORY link (e.g. .claude/skills → .agents/skills,
      // which is a junction on Windows) must never be copyFile'd — that was the bug:
      // readlinkSync on a junction returns its directory target, and copyFileSync on a
      // directory throws EPERM. statSync follows the link to learn the real target type.
      const absTarget = resolve(dirname(srcPath), target);
      let targetIsDir = false;
      try {
        targetIsDir = statSync(absTarget).isDirectory();
      } catch {
        // Dangling link — treat as a file-style recreate below.
      }

      if (isWindows && targetIsDir) {
        // Windows directory link → recreate as a junction (needs no Developer Mode /
        // admin), pointed at the DESTINATION's own corresponding directory so the
        // package stays self-contained rather than referencing the source repo.
        // `.agents/skills` is copied before `.claude`/`.agent` in the include order,
        // so this target already exists; if the package later moves, the CLI's
        // ensureSkillLinks() self-heals the junction on first run.
        const relTarget = relative(dirname(srcPath), absTarget) || ".";
        const dstTarget = resolve(dirname(dstPath), relTarget);
        try {
          symlinkSync(dstTarget, dstPath, "junction");
        } catch (err) {
          throw new SidekicksError(
            `copyTree: cannot create junction '${dstPath}' → '${dstTarget}': ${err.message}`,
            EXIT_IO
          );
        }
      } else {
        try {
          // POSIX (file or directory) and Windows file links: recreate verbatim as a symlink.
          symlinkSync(target, dstPath);
        } catch (err) {
          // On Windows without Developer Mode, a file symlink fails — copy content instead.
          if (isWindows && err.code === "EPERM") {
            try {
              copyFileSync(absTarget, dstPath);
            } catch (cpErr) {
              throw new SidekicksError(
                `copyTree: cannot create symlink or copy '${dstPath}' → '${target}': ${cpErr.message}`,
                EXIT_IO
              );
            }
          } else {
            throw new SidekicksError(
              `copyTree: cannot create symlink '${dstPath}' → '${target}': ${err.message}`,
              EXIT_IO
            );
          }
        }
      }
    } else if (stat.isDirectory()) {
      mkdirp(dstPath);
      _copyDir(srcPath, dstPath, srcRoot, exclude, preserveMode);
    } else if (stat.isFile()) {
      try {
        copyFileSync(srcPath, dstPath, fsConstants.COPYFILE_FICLONE_FORCE ^ fsConstants.COPYFILE_FICLONE_FORCE);
      } catch {
        // Fallback to plain copy if FICLONE is unsupported
        try {
          copyFileSync(srcPath, dstPath);
        } catch (err2) {
          throw new SidekicksError(
            `copyTree: cannot copy '${srcPath}' → '${dstPath}': ${err2.message}`,
            EXIT_IO
          );
        }
      }
      if (preserveMode && !isWindows) {
        try {
          chmodSync(dstPath, stat.mode & 0o7777);
        } catch (err) {
          throw new SidekicksError(
            `copyTree: cannot chmod '${dstPath}': ${err.message}`,
            EXIT_IO
          );
        }
      }
    }
    // Ignore other entry types (device files, sockets, etc.)
  }
}
