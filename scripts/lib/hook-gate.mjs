// scripts/lib/hook-gate.mjs
// The one entry gate every wired Node hook consults before doing any work.
//
// CONTRACT — three properties, all deliberate:
//   1. DISABLED ⇒ the hook exits 0 having done nothing. A disabled hook must never look
//      like a failing hook: on Claude Code a non-zero PreToolUse hook blocks the tool call,
//      so "off" has to be indistinguishable from "ran and had nothing to say".
//   2. FAILS OPEN. If the resolver throws for any reason (corrupt settings file, a lib/
//      module missing in a partial checkout), the hook runs. A settings subsystem must never
//      be able to silently switch off enforcement — least of all the floor hooks.
//   3. THE GATE LIVES IN THE SCRIPT, not in the per-CLI wiring. That is what keeps Rule 6
//      cheap: .claude/settings.json, .codex/config.toml, .gemini/settings.json and
//      .agent/settings.json stay byte-identical to before, all four inherit the gate at once,
//      and lib/framework-lifecycle/tests/multi-cli-parity.test.mjs keeps passing unchanged.
//
// Zero npm dependencies — node:* + the framework-settings resolver only.

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Marker file at the root of a framework-core checkout.
 *
 * DUPLICATED from lib/sk-cli/core-mount.mjs on purpose: this module must not static-import
 * from lib/ (property 2 — a partial checkout must still run its hooks, not crash them at
 * module-load time). Change both together.
 */
const CORE_MARKER = '.sidekicks-core.json';
const CORE_DIR = '.sidekicks-core';

/**
 * A core is skipped only where it is MOUNTED — both the marker and the mount-point name. A core
 * checked out anywhere else (a standalone clone, or the service checkout where it is forged) is its
 * own root. Mirrors isMountedCore in lib/sk-cli/core-mount.mjs.
 */
const sameName = (a, b) => (process.platform === 'win32'
  ? String(a).toLowerCase() === String(b).toLowerCase()
  : a === b);
const isMountedCore = (dir) => sameName(basename(dir), CORE_DIR) && existsSync(join(dir, CORE_MARKER));

/**
 * Has `dir` MOUNTED a core of its own — i.e. is it a workspace? Mirrors coreDirOf in
 * lib/sk-cli/core-mount.mjs (which returns the path; here only the yes/no is needed).
 */
const hasMountedCore = (dir) => existsSync(join(dir, CORE_DIR, CORE_MARKER));

/**
 * Walk up from this file to the repo root (the directory carrying .sidekicks/).
 * Hooks are invoked with an unpredictable cwd, so the anchor is the script location.
 *
 * When the framework is consumed as a submodule, THIS FILE lives at
 * <workspace>/.sidekicks-core/scripts/lib/hook-gate.mjs, and the core carries its own .sidekicks/.
 * Stopping there would bind every hook to the CORE's state — the observed memory-leak class
 * recorded in .sidekicks/memory/inherited-runtime-scripts-must-be-copied.md. A directory carrying
 * the core marker is therefore walked past: the workspace above it is the root. A core with NO
 * workspace above it (cloned or forged standalone) is its own root — the last-resort tier, which is
 * exactly why mounting it flips the answer. Mirrors lib/sk-cli/paths.mjs.
 *
 * A workspace that has mounted a core is a root even before `core init` gives it a `.sidekicks/`,
 * and it wins over any `.sidekicks/` further up — otherwise an unrelated one ($HOME/.sidekicks,
 * which skills create for their own state) captured every hook in a freshly mounted workspace.
 * Same nearness rule as lib/sk-cli/paths.mjs; change both together.
 *
 * @returns {string|null} absolute repo root, or null when it cannot be found.
 */
export function hookRepoRoot() {
  let cur = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let coreFallback = null;
  for (;;) {
    const hasSidekicks = existsSync(join(cur, '.sidekicks'));
    const isCore = isMountedCore(cur);
    if (hasSidekicks && !isCore) return cur;
    if (hasMountedCore(cur)) return cur;
    if (coreFallback === null && hasSidekicks && isCore) coreFallback = cur;
    const parent = dirname(cur);
    if (parent === cur) return coreFallback;   // a STANDALONE core is its own root; a mounted one is not
    cur = parent;
  }
}

/**
 * Is this hook id enabled? Any failure answers `true` (fail open).
 *
 * The resolver is imported DYNAMICALLY on purpose: a checkout missing
 * lib/framework-settings/ (a partial copy, a mid-rebase tree) must still run its hooks
 * rather than crash them, which a static import would do at module-load time.
 *
 * @param {string} id - e.g. 'hook.office-viz'
 * @returns {Promise<boolean>}
 */
export async function hookEnabled(id) {
  try {
    const repoRoot = hookRepoRoot();
    if (!repoRoot) return true;
    const { isEnabled } = await import('../../lib/framework-settings/resolve.mjs');
    return isEnabled(repoRoot, id);
  } catch {
    return true; // fail open — see property 2 above
  }
}

/**
 * The form hooks use as their first statement (top-level await is available in .mjs):
 *
 *   import { exitIfDisabled } from './lib/hook-gate.mjs';
 *   await exitIfDisabled('hook.office-viz');
 *
 * Exits the process with code 0 when the id is disabled; returns otherwise.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function exitIfDisabled(id) {
  if (!(await hookEnabled(id))) process.exit(0);
}
