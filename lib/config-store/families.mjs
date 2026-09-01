// lib/config-store/families.mjs
// The merged block registry: which family file every configuration block lives in, who owns it, who
// reads it, and how it resolves across scopes.
//
// DERIVED, NEVER HAND-CATALOGUED — the same stance as lib/framework-settings/registry.mjs, and for
// the same recorded reason: a hand-seeded catalog is how AGENTS.md ended up pointing at three files
// that no longer exist. Two sources merge here:
//
//   1. lib/config-store/core-families.mjs  — the family taxonomy plus blocks owned by framework code
//   2. every .sidekicks/{skills,skill-offloaded}/<skill>/skill.yaml `config:` declaration
//
// A block may be declared by SEVERAL skills. That is the normal case, not an error: `jira` is read
// by sk-jira-connector (which ships the defaults) and by sk-jira-autopilot,
// sk-get-jira-done and the ready gate. Exactly one declaration may carry `defaults:` — two
// defaults sources for one block is a `defaults-conflict` finding, because the resolver would have
// to pick one silently.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { buildRegistry } from '../framework-settings/registry.mjs';
import { FAMILIES, FAMILY_NAMES, CORE_BLOCKS } from './core-families.mjs';

export { FAMILIES, FAMILY_NAMES } from './core-families.mjs';

/** The directory, relative to a scope root, that holds the family files. */
export const CONFIG_DIR = 'config';

/** The legacy monolith every scope used before the family split. Still read, one layer lower. */
export const LEGACY_FILE = 'config.yaml';

/** Defaults applied to any field a declaration leaves unset. */
const BLOCK_DEFAULTS = Object.freeze({
  scope: 'any',
  inherits_root: false,
  merge: 'per_key',
});

/**
 * One resolved block entry.
 *
 * @typedef {{
 *   block: string,
 *   family: string,
 *   file: string,
 *   secret: string,
 *   title: string,
 *   owners: string[],
 *   defaults_from: {skill: string, tree: string, file: string}|null,
 *   builtin: object|null,
 *   readers: string[],
 *   aliases: string[],
 *   public_keys: string[],
 *   scope: 'root'|'any',
 *   inherits_root: boolean,
 *   merge: 'per_key'|'whole_block',
 *   source: 'core'|'skill',
 * }} BlockEntry
 */

/**
 * Build the merged block registry.
 *
 * @param {string} repoRoot
 * @returns {{ blocks: BlockEntry[], byBlock: Map<string, BlockEntry>, families: Map<string, BlockEntry[]> }}
 */
export function buildFamilies(repoRoot) {
  /** @type {Map<string, BlockEntry>} */
  const byBlock = new Map();

  for (const core of CORE_BLOCKS) {
    byBlock.set(core.block, {
      ...BLOCK_DEFAULTS,
      ...core,
      ...fileFor(core.family, core.block),
      owners: [],
      defaults_from: null,
      builtin: core.builtin ?? null,
      readers: [...core.readers],
      aliases: [],
      public_keys: [...(core.public_keys ?? [])],
      source: 'core',
    });
  }

  const { descriptors } = buildRegistry(repoRoot);
  for (const d of descriptors) {
    for (const decl of d.configs || []) {
      const existing = byBlock.get(decl.block);
      if (existing) {
        mergeDeclaration(existing, decl, d);
        continue;
      }
      const family = decl.family ?? decl.block;
      assertKnownFamily(family, decl.block, d.relPath);
      byBlock.set(decl.block, {
        ...BLOCK_DEFAULTS,
        block: decl.block,
        family,
        ...fileFor(family, decl.block),
        title: decl.block,
        owners: [d.skill],
        defaults_from: decl.defaults
          ? { skill: d.skill, tree: d.tree, file: decl.defaults }
          : null,
        builtin: decl.builtin,
        readers: [],
        aliases: [...decl.aliases],
        public_keys: [...(decl.public_keys ?? [])],
        scope: decl.scope ?? BLOCK_DEFAULTS.scope,
        inherits_root: decl.inherits_root ?? BLOCK_DEFAULTS.inherits_root,
        merge: decl.merge ?? BLOCK_DEFAULTS.merge,
        source: 'skill',
      });
    }
  }

  const blocks = [...byBlock.values()].sort((a, b) => a.block.localeCompare(b.block));
  /** @type {Map<string, BlockEntry[]>} */
  const families = new Map();
  for (const f of FAMILIES) families.set(f.family, []);
  for (const entry of blocks) {
    if (!families.has(entry.family)) families.set(entry.family, []);
    families.get(entry.family).push(entry);
  }
  return { blocks, byBlock, families };
}

/**
 * Fold a second (or third) declaration of an already-known block into its entry.
 *
 * @param {BlockEntry} entry
 * @param {object} decl
 * @param {{skill: string, tree: string, relPath: string}} d
 */
function mergeDeclaration(entry, decl, d) {
  if (!entry.owners.includes(d.skill)) entry.owners.push(d.skill);
  if (decl.family && decl.family !== entry.family) {
    assertKnownFamily(decl.family, decl.block, d.relPath);
    throw new SidekicksError(
      `config: '${d.relPath}' puts block '${decl.block}' in family '${decl.family}', but it is `
      + `already registered in family '${entry.family}' — one block lives in exactly one file`,
      EXIT_VALIDATION
    );
  }
  if (decl.defaults) {
    if (entry.defaults_from) {
      throw new SidekicksError(
        `config: two skills ship defaults for block '${decl.block}' `
        + `(${entry.defaults_from.skill} and ${d.skill}) — exactly one may, so the resolver never `
        + 'has to pick silently. Drop `defaults:` from the reader that does not own the block.',
        EXIT_VALIDATION
      );
    }
    entry.defaults_from = { skill: d.skill, tree: d.tree, file: decl.defaults };
  }
  if (decl.builtin && !entry.builtin) entry.builtin = decl.builtin;
  for (const alias of decl.aliases) {
    if (!entry.aliases.includes(alias)) entry.aliases.push(alias);
  }
  // public_keys UNION across declarations: one reader knowing a key is not a credential is enough,
  // and the alternative (intersection) would leak the moment a second reader forgot to list it.
  for (const key of decl.public_keys ?? []) {
    if (!entry.public_keys.includes(key)) entry.public_keys.push(key);
  }
  // A declaration may sharpen a core default (a skill knows its own block's scope semantics), but
  // a core entry's explicit choice wins: the framework wired the reader.
  if (entry.source === 'skill') {
    if (decl.scope) entry.scope = decl.scope;
    if (decl.inherits_root !== null) entry.inherits_root = decl.inherits_root;
    if (decl.merge) entry.merge = decl.merge;
  }
}

/**
 * @param {string} family
 * @param {string} block
 * @returns {{family: string, file: string, secret: string}}
 */
function fileFor(family, block) {
  const known = FAMILIES.find((f) => f.family === family);
  if (known) return { family, file: known.file, secret: known.secret };
  // A block in a family of its own: the file is named after the block.
  const base = block.replace(/_/g, '-');
  return { family, file: `${base}.yaml`, secret: `${base}.secret.yaml` };
}

/**
 * A declared family must either be a registered family or be the block's own name. Anything else is
 * a typo that would silently create an eleventh file nobody looks in.
 *
 * @param {string} family
 * @param {string} block
 * @param {string} relPath
 */
function assertKnownFamily(family, block, relPath) {
  if (FAMILY_NAMES.has(family) || family === block) return;
  throw new SidekicksError(
    `config: '${relPath}' declares block '${block}' in unknown family '${family}' — use one of `
    + `${[...FAMILY_NAMES].join(', ')}, or omit 'family:' to give the block a file of its own`,
    EXIT_VALIDATION
  );
}

/**
 * One block's entry, or null when nothing declares it.
 *
 * @param {string} repoRoot
 * @param {string} block
 * @returns {BlockEntry|null}
 */
export function blockEntry(repoRoot, block) {
  const { byBlock } = buildFamilies(repoRoot);
  if (byBlock.has(block)) return byBlock.get(block);
  for (const entry of byBlock.values()) {
    if (entry.aliases.includes(block)) return entry;
  }
  return null;
}
