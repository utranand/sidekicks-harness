// lib/state-store/paths.mjs
// Where DERIVED and PER-MACHINE state lives, and the one-release compatibility window for the move.
//
// `.sidekicks/` mixed three unrelated kinds of file at its top level: the boundary contract, every
// configuration file, and a pile of caches — a 109 KB artifact inventory, an 80 KB list of running
// agents, a scope index. Configuration moved to `<scope>/config/` (lib/config-store/paths.mjs); this
// is the other half of that split. State goes to `<scope>/state/`.
//
// STATE IS NOT CONFIGURATION, and the difference is not cosmetic:
//   - state is REBUILT, never edited — `index rebuild`, the artifact scan, the agent registry;
//   - state is per-machine, so all of it is git-ignored and none of it travels in a package;
//   - losing a state file costs a rebuild. Losing a configuration file costs credentials nobody has.
// That is why the two directories have different rules, and why `sidekicks config` refuses to write
// here.
//
// DELIBERATELY NOT MOVED: `.sidekicks/settings.json` (and its `settings.example.json` template). It is
// state by nature — which project and service are active on THIS machine — but it is also the pointer
// every other lookup starts from, named literally in ~25 lib modules and ~40 test fixtures. Moving it
// churns all of that for no portability gain, since it is git-ignored either way. It stays put on
// purpose, documented in `.sidekicks/settings.example.json`.
//
// COMPATIBILITY: every reader goes through `statePath()`, which prefers `<base>/state/<name>` and falls
// back to the legacy `<base>/<name>` when only that exists. A checkout that has not moved its files
// keeps working; the first write lands in the new place.
//
// Zero npm dependencies — node:* only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The directory that holds derived and per-machine state, relative to a scope root. */
export const STATE_DIR = 'state';

/**
 * State files by basename, so packaging, the ignore rules and `core doctor` can all name the same set
 * instead of three drifting lists.
 */
export const STATE_FILES = Object.freeze([
  'index.json',                 // root scope registry — rebuilt by `sidekicks index rebuild`
  'running-agents.json',        // live delegate-agent registry
  'artifacts-inventory.json',   // artifact scan cache
  'artifacts-inventory.md',     // its human-readable rendering
]);

/**
 * Resolve one state file to the path that should be READ.
 *
 * Prefers `<base>/state/<name>`; falls back to the legacy `<base>/<name>` when that is the only one
 * present. When neither exists the NEW path is returned, so a writer creates the file in the right
 * place instead of recreating the old layout.
 *
 * @param {string} repoRoot
 * @param {string} name - a basename from STATE_FILES
 * @param {{base?: string}} [opts] - scope base relative to repoRoot (default '.sidekicks')
 * @returns {string} absolute path
 */
export function statePath(repoRoot, name, opts = {}) {
  const base = opts.base ?? '.sidekicks';
  const preferred = join(repoRoot, base, STATE_DIR, name);
  if (existsSync(preferred)) return preferred;
  const legacy = join(repoRoot, base, name);
  if (existsSync(legacy)) return legacy;
  return preferred;
}

/**
 * The same resolution as a repo-RELATIVE path, for messages and for recorded artifacts (no
 * machine-absolute path may ever be persisted).
 *
 * @param {string} repoRoot
 * @param {string} name
 * @param {{base?: string}} [opts]
 * @returns {string}
 */
export function stateRel(repoRoot, name, opts = {}) {
  const base = opts.base ?? '.sidekicks';
  if (existsSync(join(repoRoot, base, STATE_DIR, name))) return join(base, STATE_DIR, name);
  if (existsSync(join(repoRoot, base, name))) return join(base, name);
  return join(base, STATE_DIR, name);
}
