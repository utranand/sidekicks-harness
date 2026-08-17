// lib/sk-cli/paths.mjs
// Repo-root resolver — walks parent directories looking for a .sidekicks/ subdirectory.
// Uses node:path and node:fs exclusively. Zero third-party imports.

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { SidekicksError, EXIT_VALIDATION } from "./errors.mjs";
import { isMountedCore, coreDirOf } from "./core-mount.mjs";

/**
 * Walk up from startDir until a directory containing a .sidekicks/ subdirectory is found.
 * Returns the absolute path of that ancestor directory.
 * Throws SidekicksError (EXIT_VALIDATION) if no such ancestor exists.
 *
 * Two things make a directory a root, and NEARNESS decides between them — the walk stops at the
 * first ancestor that is either:
 *
 *   a. carrying a `.sidekicks/` that is not a MOUNTED framework core. A core mounted at
 *      `<workspace>/.sidekicks-core/` carries its own `.sidekicks/` but is a read-only submodule the
 *      workspace consumes, so it is skipped — that skip is what makes a cwd inside the core still
 *      resolve the WORKSPACE. Both the marker AND the mount-point name are required (isMountedCore):
 *      a core checked out anywhere else — a standalone clone, or the service checkout where it is
 *      forged — is its own root and must keep running its own CLI.
 *   b. carrying a MOUNTED core of its own. A workspace is a root even before it has a `.sidekicks/`:
 *      the verb whose whole job is to create that directory (`core init`, which the bootstrap calls)
 *      cannot require it to already exist.
 *
 * (b) is checked at the same level as (a) rather than as a post-walk fallback, and that is the whole
 * point: a deferred (b) let an UNRELATED `.sidekicks/` far above the workspace — `$HOME/.sidekicks`,
 * which skills create for their own state — win over the workspace directly under the cwd, so the
 * bootstrap's `core init` resolved `$HOME` and died with "no framework core is mounted".
 *
 * Last resort, after the walk reaches the filesystem root: a mounted core itself — a mount with no
 * workspace above it at all (a clone that happens to sit at a path named `.sidekicks-core`). Kept
 * last so a real workspace always wins.
 *
 * @param {string} [startDir=process.cwd()] - Directory to start walking from.
 * @returns {string} Absolute path of the repo root.
 */
export function resolveRepoRoot(startDir = process.cwd()) {
  let current = startDir;
  let coreFallback = null;
  while (true) {
    const hasSidekicks = existsSync(join(current, ".sidekicks"));
    const isCore = isMountedCore(current);
    if (hasSidekicks && !isCore) {
      return current;
    }
    if (coreDirOf(current) !== null) {
      return current;
    }
    if (coreFallback === null && hasSidekicks && isCore) {
      coreFallback = current;
    }
    const parent = dirname(current);
    if (parent === current) {
      if (coreFallback !== null) return coreFallback;
      // Reached filesystem root with no .sidekicks/ and no core involved either way.
      throw new SidekicksError(
        "not inside a Sidekicks repository — no .sidekicks/ found in any ancestor",
        EXIT_VALIDATION
      );
    }
    current = parent;
  }
}
