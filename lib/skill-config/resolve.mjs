// lib/skill-config/resolve.mjs
// The SKILL-shaped view of configuration: "what does skill X see here?".
//
// This module is now a thin adapter over lib/config-store — the single reader for every consumer.
// It stays because its callers ask a skill-shaped question (`framework config <skill>`,
// lib/skill-lifecycle/destinations.mjs) and because its public surface is the compatibility contract
// pinned by tests/skill-config.test.mjs: resolveSkillConfig, configReadingSkills, readBlock,
// INHERITS_ROOT, LAYER, SECRET_KEY_RE, findSecretKeys.
//
// WHAT MOVED, AND WHY:
//   - the tolerant line-level block reader → lib/config-store/block.mjs (re-exported here). The
//     resolver, the linter, the migrator and the writer all need it; it belongs to the store.
//   - the resolution chain → lib/config-store/read.mjs. It grew from 4 files to 8 (a family file and
//     its git-ignored secret sibling per scope, above the legacy monolith), and the per-key merge,
//     the root-inheritance gate and the `whole_block` mode now come from the block's registry entry
//     instead of a hardcoded set.
//
// A MISSING project config is still a non-error at every step.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidekicksError, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { buildRegistry } from '../framework-settings/registry.mjs';
import { buildFamilies } from '../config-store/families.mjs';
import { resolveBlock, LAYER } from '../config-store/read.mjs';

export { readBlock, blockFromFile, parseValue, parseRegion } from '../config-store/block.mjs';
export { LAYER } from '../config-store/read.mjs';

export const DEFAULTS_NAME = 'config.defaults.yaml';

/**
 * Config blocks a project scope inherits from root when its own scope carries none.
 *
 * DERIVED, not declared here: the truth is the `inherits_root` flag on each block's registry entry
 * (a skill sets it in its `skill.yaml`, framework-owned blocks in
 * lib/config-store/core-families.mjs). Root-`scope` infrastructure blocks are excluded — they always
 * read root and were never part of this set.
 *
 * Kept as a lazily-built frozen Set because callers (and tests/skill-config.test.mjs) treat it as
 * one. It used to be MIRRORED inside sk-hello, with a test pinning the copies together; that
 * skill now asks the CLI instead of keeping its own resolver, so this is the only copy.
 *
 * @type {ReadonlySet<string>}
 */
export const INHERITS_ROOT = buildInheritsRoot();

function buildInheritsRoot() {
  // Built from the registry of THIS repo at import time: the module's own location walked up two
  // directories (lib/skill-config/ → repo root). fileURLToPath, not URL.pathname — the latter yields
  // '/C:/…' on Windows.
  const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  try {
    const { blocks } = buildFamilies(repoRoot);
    return Object.freeze(new Set(
      blocks.filter((b) => b.scope !== 'root' && b.inherits_root).map((b) => b.block)
    ));
  } catch {
    // A repo whose descriptors do not parse must not break every importer of this module; the
    // resolver itself reports the real error when it runs.
    return Object.freeze(new Set(['slack', 'run_notify']));
  }
}

/**
 * Resolve a skill's effective configuration.
 *
 * @param {string} repoRoot
 * @param {string} skillId - a skill directory name, e.g. 'sk-slack-connector'
 * @returns {{
 *   skill: string, block: string, config: object, sources: Record<string, string>,
 *   layers: Array<object>, scope: string,
 * }}
 * @throws {SidekicksError} EXIT_NOT_FOUND when the skill declares no config block.
 */
export function resolveSkillConfig(repoRoot, skillId) {
  const { descriptors } = buildRegistry(repoRoot);
  const descriptor = descriptors.find((d) => d.skill === skillId);
  if (!descriptor) {
    throw new SidekicksError(
      `skill-config: '${skillId}' has no skill.yaml descriptor — a skill declares the config `
      + 'block it reads there (see docs/guide/framework-settings.md)',
      EXIT_NOT_FOUND
    );
  }
  if (!descriptor.config) {
    throw new SidekicksError(
      `skill-config: '${skillId}' declares no config block — it reads no scope configuration`,
      EXIT_NOT_FOUND
    );
  }

  const resolved = resolveBlock(repoRoot, descriptor.config.block);
  return {
    skill: skillId,
    block: resolved.block,
    family: resolved.family,
    config: resolved.config,
    sources: resolved.sources,
    layers: resolved.layers,
    scope: resolved.active_scope,
  };
}

/**
 * Every skill that declares a config block, with the defaults file it points at (if any).
 * Discovery-driven: nothing here counts skills or hard-codes names.
 *
 * @param {string} repoRoot
 * @returns {Array<{skill: string, tree: string, block: string, family: string, defaults: string|null}>}
 */
export function configReadingSkills(repoRoot) {
  const { descriptors } = buildRegistry(repoRoot);
  const out = [];
  for (const d of descriptors) {
    for (const decl of d.configs || []) {
      out.push({
        skill: d.skill,
        tree: d.tree,
        block: decl.block,
        family: decl.family ?? decl.block,
        defaults: decl.defaults ? join(d.tree, d.skill, decl.defaults) : null,
      });
    }
  }
  return out;
}

/** Key names that must never appear in a committed defaults or family file. */
export const SECRET_KEY_RE = /(api_key|apikey|token|password|passwd|secret|pass)/i;

/**
 * Secret-shaped keys found in a config object, at any depth.
 *
 * @param {object} obj
 * @param {string} [prefix]
 * @returns {string[]} dotted key paths
 */
export function findSecretKeys(obj, prefix = '') {
  const hits = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return hits;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (SECRET_KEY_RE.test(key)) hits.push(path);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      hits.push(...findSecretKeys(value, path));
    }
  }
  return hits;
}

// LAYER is re-exported above; referenced here so the import is not flagged as unused by a reader
// scanning for it.
export const LAYER_NAMES = Object.freeze(Object.values(LAYER));
