// lib/package-lifecycle/assemble.mjs
// Execute a copy plan produced by buildCopyPlan().
// Barrel-exported.

import {
  lstatSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { copyTree } from "./fs-copy.mjs";
import { mkdirp } from "../fs-safety/fsx.mjs";
import { SidekicksError, EXIT_IO } from "../sk-cli/errors.mjs";

const isWindows = process.platform === "win32";

/**
 * Execute an assembly plan produced by `buildCopyPlan`.
 * Implements pipeline Steps 3–7 (Steps 1–2 + 8–10 in create.mjs).
 *
 * @param {{
 *   copies: Array<{src: string, dst: string, preserveMode?: boolean}>,
 *   symlinks: Array<{path: string, target: string}>,
 *   generated: Array<{path: string, kind: string}>,
 *   excluded: string[],
 *   cleanSettings?: object,
 * }} plan
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export function assemblePackage(plan, opts = {}) {
  const { log = () => {} } = opts;

  // Steps 3–7: execute all copy entries
  log("assemblePackage: executing copy plan");

  for (const { src, dst, preserveMode } of plan.copies) {
    mkdirp(dirname(dst));
    log(`copy: ${src} → ${dst}${preserveMode ? " [0755]" : ""}`);
    _copySrcToDst(src, dst, !!preserveMode);
  }

  // Recreate symlinks (Step 6 + 7)
  log("assemblePackage: creating symlinks");
  for (const { path, target } of plan.symlinks) {
    mkdirp(dirname(path));
    if (existsSync(path)) {
      log(`symlink already exists, skipping: ${path}`);
      continue;
    }
    if (_trySymlink(target, path)) {
      log(`symlink: ${path} → ${target}`);
    } else {
      // Fallback: copy the target (Windows without Developer Mode).
      const absSrc = resolve(dirname(path), target);
      try {
        const srcStat = lstatSync(absSrc);
        if (srcStat.isDirectory()) {
          copyTree(absSrc, path);
        } else {
          copyFileSync(absSrc, path);
        }
      } catch (cpErr) {
        throw new SidekicksError(
          `assemblePackage: cannot create symlink or copy '${path}' → '${target}': ${cpErr.message}`,
          EXIT_IO
        );
      }
      log(`copy (symlink unavailable): ${path} ← ${target}`);
    }
  }

  // Write clean settings.json (Step 5)
  if (plan.cleanSettings) {
    const settingsEntry = plan.generated.find((g) => g.kind === "settings");
    if (settingsEntry) {
      log(`settings: ${settingsEntry.path}`);
      mkdirp(dirname(settingsEntry.path));
      try {
        writeFileSync(
          settingsEntry.path,
          JSON.stringify(plan.cleanSettings, null, 2) + "\n",
          "utf8"
        );
      } catch (err) {
        throw new SidekicksError(
          `assemblePackage: cannot write settings.json: ${err.message}`,
          EXIT_IO
        );
      }
    }
  }

  // Create projects/.gitkeep
  const gitkeepEntry = plan.generated.find((g) => g.kind === "gitkeep");
  if (gitkeepEntry) {
    log(`gitkeep: ${gitkeepEntry.path}`);
    mkdirp(dirname(gitkeepEntry.path));
    try {
      writeFileSync(gitkeepEntry.path, "", "utf8");
    } catch (err) {
      throw new SidekicksError(
        `assemblePackage: cannot write projects/.gitkeep: ${err.message}`,
        EXIT_IO
      );
    }
  }

  log("assemblePackage: complete");
}

/**
 * Copy a single src item to dst.
 * If src is a directory → copyTree.
 * If src is a symlink → recreate as symlink.
 * If src is a regular file → copyFileSync + optional chmod.
 *
 * @param {string} src
 * @param {string} dst
 * @param {boolean} preserveMode
 */
function _copySrcToDst(src, dst, preserveMode) {
  let stat;
  try {
    stat = lstatSync(src);
  } catch (err) {
    throw new SidekicksError(
      `assemblePackage: cannot stat '${src}': ${err.message}`,
      EXIT_IO
    );
  }

  if (stat.isDirectory()) {
    copyTree(src, dst, { preserveMode });
  } else if (stat.isSymbolicLink()) {
    let target;
    try {
      target = readlinkSync(src);
    } catch (err) {
      throw new SidekicksError(
        `assemblePackage: cannot read symlink '${src}': ${err.message}`,
        EXIT_IO
      );
    }
    if (!_trySymlink(target, dst)) {
      // Fallback: copy the resolved file instead.
      const absSrc = resolve(dirname(src), target);
      try {
        copyFileSync(absSrc, dst);
      } catch (cpErr) {
        throw new SidekicksError(
          `assemblePackage: cannot recreate symlink or copy '${dst}': ${cpErr.message}`,
          EXIT_IO
        );
      }
    }
  } else {
    // Regular file
    try {
      copyFileSync(src, dst);
    } catch (err) {
      throw new SidekicksError(
        `assemblePackage: cannot copy '${src}' → '${dst}': ${err.message}`,
        EXIT_IO
      );
    }
    if (preserveMode && !isWindows) {
      try {
        chmodSync(dst, stat.mode & 0o7777);
      } catch (err) {
        throw new SidekicksError(
          `assemblePackage: cannot chmod '${dst}': ${err.message}`,
          EXIT_IO
        );
      }
    }
  }
}

/**
 * Try to create a symlink; return true on success, false on EPERM (Windows
 * without Developer Mode). Throws on any other error.
 */
function _trySymlink(target, linkPath) {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch (err) {
    if (isWindows && err.code === "EPERM") return false;
    throw err;
  }
}
