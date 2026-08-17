// lib/config-store/paths.mjs
// Where a FRAMEWORK configuration file lives, and the one-release compatibility window for the move.
//
// `.sidekicks/` had grown nine configuration and state files at its top level, mixed together: the
// framework enable map next to a derived index cache, an external-CLI registry next to a 109 KB
// artifact inventory. Configuration now lives in exactly one place per scope — `<scope>/config/` — so
// "where is this configured" has a single answer and a package can carry configuration without
// sweeping up caches.
//
// STATE IS NOT CONFIGURATION and does not move here. `.sidekicks/settings.json` (which project is
// active on THIS machine), `index.json`, `running-agents.json` and `artifacts-inventory.*` are
// per-machine or derived; they are rebuilt, never edited, and three of the four are git-ignored.
//
// COMPATIBILITY: every reader goes through `frameworkConfigPath()`, which prefers
// `.sidekicks/config/<name>` and falls back to the legacy `.sidekicks/<name>` when only that exists.
// A checkout that has not moved its files keeps working, and a lifted skill copy does too.
//
// Zero npm dependencies — node:* only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The directory that holds every configuration file, relative to a scope root. */
export const CONFIG_DIR = 'config';

/**
 * The directory inside CONFIG_DIR that holds the SETTINGS files — the boolean enable map, split one
 * file per kind (rules.yaml, criteria.yaml, hooks.yaml).
 *
 * Settings and configuration both live under `config/`, but they are governed by different verbs
 * and answer different questions ("is this ON?" vs "what value does it use?"). The sub-directory is
 * what makes that boundary visible in a directory listing instead of only in a guide. See
 * lib/framework-settings/framework-config.mjs and docs/guide/settings-vs-configuration.md.
 */
export const SETTINGS_DIR = 'settings';

/**
 * Framework configuration files, by basename. Listed so `config doctor` can tell a legitimate
 * framework file inside `config/` from a typo'd family filename that would resolve to nothing.
 */
export const FRAMEWORK_CONFIG_FILES = Object.freeze([
  'framework.yaml',
  'framework.example.yaml',
  'cli-executors.json',
  'cli-executors.example.json',
  'agents-watch.yaml',
  'agents-watch.example.yaml',
  'agents-liveness.yaml',
  'agents-liveness.example.yaml',
  'office-config.json',
]);

/**
 * Resolve one framework configuration file to the path that should be READ.
 *
 * Prefers `<base>/config/<name>`; falls back to the legacy `<base>/<name>` when that is the only one
 * present. When neither exists the NEW path is returned, so a writer creates the file in the right
 * place instead of recreating the old layout.
 *
 * @param {string} repoRoot
 * @param {string} name - a basename from FRAMEWORK_CONFIG_FILES
 * @param {{base?: string}} [opts] - scope base relative to repoRoot (default '.sidekicks')
 * @returns {string} absolute path
 */
export function frameworkConfigPath(repoRoot, name, opts = {}) {
  const base = opts.base ?? '.sidekicks';
  const preferred = join(repoRoot, base, CONFIG_DIR, name);
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
export function frameworkConfigRel(repoRoot, name, opts = {}) {
  const base = opts.base ?? '.sidekicks';
  if (existsSync(join(repoRoot, base, CONFIG_DIR, name))) return join(base, CONFIG_DIR, name);
  if (existsSync(join(repoRoot, base, name))) return join(base, name);
  return join(base, CONFIG_DIR, name);
}
