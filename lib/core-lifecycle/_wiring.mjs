// lib/core-lifecycle/_wiring.mjs
// Per-CLI wiring for a workspace whose framework lives in a submodule (AAP-110).
//
// THE PROBLEM. Every supported CLI is wired to hook scripts by path, and each spells that path its
// own way (Rule 6 parity, docs/guide/multi-cli-compatibility.md):
//
//   .claude/settings.json   node "$CLAUDE_PROJECT_DIR/scripts/<hook>.mjs"
//   .gemini/settings.json   node "$GEMINI_PROJECT_DIR/scripts/<hook>.mjs"
//   .agent/settings.json    node "$AGENT_PROJECT_DIR/scripts/<hook>.mjs"
//   .codex/config.toml      node scripts/<hook>.mjs            (cwd is the workspace root)
//   (all four)              .sidekicks/hooks/rtk-hook.sh
//
// In a mounted workspace those scripts are NOT at <workspace>/scripts/ — they are at
// <workspace>/.sidekicks-core/scripts/. So the wiring is copied out of the core and every hook path
// is re-pointed through the mount. Nothing else in the files is touched.
//
// TEXTUAL, NOT PARSE-AND-REEMIT. `.codex/config.toml` carries load-bearing comments explaining which
// hooks cannot be ported to Codex and why; a round-trip through a TOML emitter would drop them. The
// same rule the framework enable map follows (lib/framework-settings/framework-config.mjs writes
// line-level so comments survive) applies here.
//
// Every rule is IDEMPOTENT by construction: after a rewrite the text no longer matches its own
// pattern, so `core update` can re-apply the whole set without doubling a prefix.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { CORE_DIR } from '../sk-cli/core-mount.mjs';

/**
 * Wiring files whose hook paths must be re-pointed at the mount.
 * Keep in sync with CLI_WIRING in .agents/skills/sk-inherit/scripts/inherit.mjs and the
 * parity matrix in docs/guide/multi-cli-compatibility.md — adding a CLI means adding a row here.
 */
export const WIRING_FILES = Object.freeze([
  join('.claude', 'settings.json'),
  join('.codex', 'config.toml'),
  join('.gemini', 'settings.json'),
  join('.agent', 'settings.json'),
]);

/**
 * Wiring directories copied verbatim — subagents, commands and plugins carry no hook paths.
 */
export const WIRING_DIRS = Object.freeze([
  join('.claude', 'agents'),
  join('.claude', 'commands'),
  join('.codex', 'agents'),
  join('.agents', 'plugins'),
]);

/**
 * Path rewrites, applied in order. Each entry is [pattern, replacement].
 *
 * @type {ReadonlyArray<[RegExp, string]>}
 */
const REWRITES = Object.freeze([
  // Claude / Gemini / Antigravity: an env-var-anchored absolute path.
  [/(\$(?:CLAUDE|GEMINI|AGENT)_PROJECT_DIR)\/scripts\//g, `$1/${CORE_DIR}/scripts/`],
  // Codex: workspace-root-relative, no env var.
  [/\bnode scripts\//g, `node ${CORE_DIR}/scripts/`],
  // The shell hook under .sidekicks/hooks/ travels inside the core too. The lookbehind is what makes
  // this idempotent: after a rewrite the match is preceded by `-core/`, which the class excludes.
  [/(?<![\w./-])\.sidekicks\/hooks\//g, `${CORE_DIR}/.sidekicks/hooks/`],
]);

/**
 * Apply every path rewrite to one wiring file's text.
 *
 * @param {string} text
 * @returns {string}
 */
export function rewireText(text) {
  let out = text;
  for (const [pattern, replacement] of REWRITES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Does this text still reference a hook path that does NOT go through the mount?
 * Used by `core doctor` — a wiring file the rewrite missed produces hooks that silently never run.
 *
 * @param {string} text
 * @returns {string[]} the offending fragments (empty when clean)
 */
export function unroutedHookPaths(text) {
  const offenders = [];
  for (const [pattern] of REWRITES) {
    // Fresh regex per check: the shared literals carry /g and therefore lastIndex state.
    const re = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = re.exec(text)) !== null) offenders.push(m[0]);
  }
  return offenders;
}

/**
 * Copy the per-CLI wiring out of the core into the workspace, re-pointing hook paths at the mount.
 *
 * Overwrites: the wiring files are framework-owned (the "System" class in
 * lib/package-lifecycle/overlay.mjs's vocabulary) and are regenerated on every `core init` /
 * `core update`. A workspace that needs its own hooks adds them in the host CLI's local settings
 * (e.g. `.claude/settings.local.json`), which is never touched here.
 *
 * @param {string} repoRoot - workspace root
 * @param {string} coreDir  - absolute path of the mounted core
 * @returns {{files: string[], dirs: string[], skipped: string[]}}
 */
export function applyWiring(repoRoot, coreDir) {
  const files = [];
  const dirs = [];
  const skipped = [];

  for (const rel of WIRING_FILES) {
    const src = join(coreDir, rel);
    if (!existsSync(src)) { skipped.push(rel); continue; }
    const dest = join(repoRoot, rel);
    mkdirp(dirname(dest));
    writeAtomic(dest, rewireText(readFileSync(src, 'utf8')));
    files.push(rel);
  }

  for (const rel of WIRING_DIRS) {
    const src = join(coreDir, rel);
    if (!existsSync(src)) { skipped.push(rel); continue; }
    const dest = join(repoRoot, rel);
    mkdirp(dirname(dest));
    cpSync(src, dest, { recursive: true, dereference: true });
    dirs.push(rel);
  }

  return { files, dirs, skipped };
}

/**
 * Read the workspace's wiring files and report any hook path that still bypasses the mount.
 *
 * @param {string} repoRoot
 * @returns {Array<{file: string, offenders: string[]}>}
 */
export function auditWiring(repoRoot) {
  const problems = [];
  for (const rel of WIRING_FILES) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const offenders = unroutedHookPaths(text);
    if (offenders.length) problems.push({ file: rel, offenders: [...new Set(offenders)] });
  }
  return problems;
}
