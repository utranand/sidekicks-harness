// lib/framework-settings/resolve.mjs
// THE resolver for "is this framework rule / AGENTS.md criterion / hook enabled here?".
// One implementation, consulted by the `framework` verbs, by every gated hook, and by any
// future skill-side gate.
//
// Resolution order, highest first:
//
//   0. the frozen safety floor (floor.mjs)          — always enabled, no file can override
//   1. projects/<active>/manifest.yaml
//        overrides.framework.{rules,criteria,hooks}.<slug>   — committed, per project
//   2. .sidekicks/settings.json
//        framework.{rules,criteria,hooks}.<slug>             — git-ignored, per machine
//   3. .sidekicks/config/settings/{rules,criteria,hooks}.yaml
//        <slug>                                              — committed, team default
//      …over .sidekicks/config/framework.yaml (the pre-split monolith), read one step lower
//        {rules,criteria,hooks}.<slug>                       — committed, legacy
//   4. built-in default: ENABLED
//
// Layer 1 sitting above layer 2 is not a free choice: .sidekicks/RULES.md (Overrides
// Precedence) already declares `manifest.overrides` High (Wins) over the framework
// settings layer. This is the code that finally makes that documented contract real —
// before AAP-93 no lib/ module read it at all.
//
// A missing or empty file at ANY layer contributes nothing and is never an error: with all
// three absent every id resolves enabled, i.e. exactly the pre-AAP-93 behaviour (fresh-clone
// equivalence). A floor id appearing in any data layer IS an error — silently ignoring it
// would let a settings file claim a safety rule is off while the resolver says it is on.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { read as readManifest } from '../manifest-schema/manifest.mjs';
import { LOCKED_IDS, isFloor, floorReason } from './floor.mjs';
import {
  BLOCKS,
  SETTINGS_REL_DIR,
  committedSources,
  parseId,
  toggleMap,
  writeToggle,
} from './framework-config.mjs';

/** Where a resolved value came from. */
export const SOURCE = Object.freeze({
  FLOOR: 'floor',
  MANIFEST: 'manifest',
  SETTINGS: 'settings',
  FILE: 'framework-file',
  DEFAULT: 'default',
});

/**
 * Reject a floor id present in a data layer, rather than silently ignoring it.
 *
 * @param {Record<string, Record<string, boolean>>} blocks - block → slug → bool
 * @param {string} label - source label for the message
 */
function assertNoFloorIds(blocks, label) {
  for (const [block, map] of Object.entries(blocks)) {
    const kind = block === 'rules' ? 'rule' : block === 'criteria' ? 'criterion' : 'hook';
    for (const slug of Object.keys(map)) {
      const id = `${kind}.${slug}`;
      if (LOCKED_IDS.has(id)) {
        throw new SidekicksError(
          `framework: '${label}' sets ${block}.${slug}, but ${floorReason(id)}. `
          + 'Remove the entry — the floor is not configurable.',
          EXIT_VALIDATION
        );
      }
    }
  }
}

/**
 * Read one layer's three blocks into block → slug → boolean.
 *
 * @param {object} parsed
 * @param {string} label
 * @returns {Record<string, Record<string, boolean>>}
 */
function layerBlocks(parsed, label) {
  /** @type {Record<string, Record<string, boolean>>} */
  const out = {};
  for (const block of BLOCKS) out[block] = toggleMap(parsed, block, label);
  assertNoFloorIds(out, label);
  return out;
}

/**
 * Load all three data layers once. Callers resolving many ids should hold the result and
 * pass it back in, so a `framework list` over 40 ids still reads each file exactly once.
 *
 * @param {string} repoRoot
 * @returns {{
 *   manifest: Record<string, Record<string, boolean>>,
 *   settings: Record<string, Record<string, boolean>>,
 *   file: Record<string, Record<string, boolean>>,
 *   projectName: string,
 * }}
 */
export function loadLayers(repoRoot) {
  const settingsObj = readSettings(repoRoot);
  const { projectName, projectRelPath } = resolveEffectiveScope(settingsObj);

  // Layer 1 — the active project's manifest overrides (root scope has no manifest).
  let manifestBlocks = { rules: {}, criteria: {}, hooks: {} };
  if (projectRelPath) {
    const manifestAbs = join(repoRoot, projectRelPath, 'manifest.yaml');
    if (existsSync(manifestAbs)) {
      const manifest = readManifest(manifestAbs);
      const overrides = manifest && manifest.overrides;
      const scoped = overrides && typeof overrides === 'object' && !Array.isArray(overrides)
        ? overrides.framework
        : null;
      if (scoped !== undefined && scoped !== null) {
        if (typeof scoped !== 'object' || Array.isArray(scoped)) {
          throw new SidekicksError(
            `framework: '${projectRelPath}/manifest.yaml' overrides.framework must be a mapping`,
            EXIT_VALIDATION
          );
        }
        manifestBlocks = layerBlocks(scoped, `${projectRelPath}/manifest.yaml overrides.framework`);
      }
    }
  }

  // Layer 2 — the per-machine settings block (absent by default).
  const settingsFramework = settingsObj && settingsObj.framework;
  let settingsBlocks = { rules: {}, criteria: {}, hooks: {} };
  if (settingsFramework !== undefined && settingsFramework !== null) {
    if (typeof settingsFramework !== 'object' || Array.isArray(settingsFramework)) {
      throw new SidekicksError(
        "framework: '.sidekicks/settings.json' field 'framework' must be an object",
        EXIT_VALIDATION
      );
    }
    settingsBlocks = layerBlocks(settingsFramework, '.sidekicks/settings.json framework');
  }

  // Layer 3 — the committed team default. Two sources merge here, lowest first: the pre-split
  // `config/framework.yaml` monolith, then the per-kind `config/settings/*.yaml` files above it.
  // Each is validated against the safety floor SEPARATELY so the error names the file that
  // actually carries the offending id.
  const fileBlocks = { rules: {}, criteria: {}, hooks: {} };
  for (const source of committedSources(repoRoot)) {
    const validated = layerBlocks(source.blocks, source.label);
    for (const block of BLOCKS) Object.assign(fileBlocks[block], validated[block]);
  }

  return { manifest: manifestBlocks, settings: settingsBlocks, file: fileBlocks, projectName };
}

/**
 * Resolve one id against the layers.
 *
 * @param {string} repoRoot
 * @param {string} id - `<kind>.<slug>`
 * @param {ReturnType<typeof loadLayers>} [layers] - preloaded layers (optional)
 * @returns {{ id: string, kind: string, enabled: boolean, source: string, floor: boolean }}
 */
export function resolve(repoRoot, id, layers) {
  const { kind, block, slug } = parseId(id);
  if (isFloor(id)) {
    return { id, kind, enabled: true, source: SOURCE.FLOOR, floor: true };
  }
  const l = layers || loadLayers(repoRoot);
  for (const [layer, source] of [
    [l.manifest, SOURCE.MANIFEST],
    [l.settings, SOURCE.SETTINGS],
    [l.file, SOURCE.FILE],
  ]) {
    const map = layer[block];
    if (map && Object.prototype.hasOwnProperty.call(map, slug)) {
      return { id, kind, enabled: map[slug], source, floor: false };
    }
  }
  return { id, kind, enabled: true, source: SOURCE.DEFAULT, floor: false };
}

/**
 * Convenience predicate. An id nothing has an opinion about resolves TRUE — an unknown id
 * is enabled, so a typo in a hook gate can never silently switch a hook off.
 *
 * @param {string} repoRoot
 * @param {string} id
 * @param {ReturnType<typeof loadLayers>} [layers]
 * @returns {boolean}
 */
export function isEnabled(repoRoot, id, layers) {
  return resolve(repoRoot, id, layers).enabled;
}

/**
 * Write an enable/disable decision into the committed SETTINGS layer — the per-kind file for the
 * id's kind, `.sidekicks/config/settings/{rules,criteria,hooks}.yaml`.
 *
 * Refuses floor ids before touching the filesystem. Enabling is written explicitly rather
 * than by deleting the key: an explicit `true` documents the decision and survives a change
 * to the built-in default.
 *
 * @param {string} repoRoot
 * @param {string} id
 * @param {boolean} enabled
 * @returns {{ id: string, enabled: boolean, path: string, created: boolean }}
 * @throws {SidekicksError} EXIT_VALIDATION when `id` is malformed or in the floor.
 */
export function setEnabled(repoRoot, id, enabled) {
  parseId(id); // validate shape first
  if (isFloor(id) && enabled === false) {
    throw new SidekicksError(`framework: ${floorReason(id)}`, EXIT_VALIDATION);
  }
  if (isFloor(id)) {
    // Enabling a floor id is a no-op by definition — never write it into a data file,
    // because a floor id present in any layer is itself a validation error.
    return { id, enabled: true, path: SETTINGS_REL_DIR, created: false };
  }
  const { path, created } = writeToggle(repoRoot, id, enabled);
  return { id, enabled, path, created };
}
