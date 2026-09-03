// lib/config-store/read.mjs
// THE resolver for "what configuration does this block carry here?" — one implementation, one
// precedence chain, for every consumer (CLI verbs, framework config, skills via `sidekicks config
// get`, framework code in lib/agent-lifecycle).
//
// Resolution order, highest first. Files are grouped by SCOPE, and a group's own files merge per key
// before groups are compared, so splitting the credentials out of a family file never changes what
// resolves:
//
//   project group  1. projects/<active>/config/<family>.secret.yaml   (git-ignored)
//                  2. projects/<active>/config/<family>.yaml          (committed)
//                  3. projects/<active>/config.yaml → block           (legacy monolith)
//   root group     4. .sidekicks/config/<family>.secret.yaml          (git-ignored)
//                  5. .sidekicks/config/<family>.yaml                 (committed)
//                  6. .sidekicks/config.yaml → block                  (legacy monolith)
//   defaults       7. <owning skill>/config.defaults.yaml             (committed, non-secret)
//   builtin        8. the descriptor's `config.builtin`
//
// WHICH GROUPS APPLY:
//   - a `scope: root` block (per-machine infrastructure — one daemon, one tray, one bot per
//     checkout) reads the root group only, whatever project is active. A project cannot override it,
//     so its project files are not consulted at all.
//   - otherwise the project group applies when a user project is active, and the root group follows
//     only when the block `inherits_root` (today: slack and run_notify) — or when root IS the
//     active scope, in which case the root group IS the scope group.
//
// HOW GROUPS COMBINE:
//   - `merge: per_key` (the default) — the highest group carrying a KEY owns that key, so a project
//     may override one value without restating the block.
//   - `merge: whole_block` — the highest group carrying the BLOCK owns all of it. `run_notify` needs
//     this: a project setting `enabled: false` switches reporting off wholesale instead of
//     inheriting root's transports (pinned by tests/run-notify-hook.test.mjs).
//
// A MISSING FILE IS NEVER AN ERROR, at any layer: the answer is simply "whatever the next layer
// says", ending in {}. That holds for a fresh clone with no config at all.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SidekicksError, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { blockFromFile } from './block.mjs';
import { buildFamilies, CONFIG_DIR, LEGACY_FILE } from './families.mjs';

/**
 * Where a resolved key came from. The four values are SCOPE-grained, unchanged from the original
 * skill-config resolver, so a caller that recorded 'project-config' before still sees it now that
 * the project group has three files instead of one. `layers[].files[]` carries the file detail.
 */
export const LAYER = Object.freeze({
  PROJECT: 'project-config',
  ROOT: 'root-config',
  DEFAULTS: 'skill-defaults',
  BUILTIN: 'skill-builtin',
});

/** How a file inside a group is spelled, for `config where` and the doctor. */
export const FILE_KIND = Object.freeze({
  SECRET: 'secret',
  FAMILY: 'family',
  LEGACY: 'legacy',
  DEFAULTS: 'defaults',
});

/**
 * The files a scope contributes for one block, highest precedence first.
 *
 * @param {string} baseRel - repo-relative scope base ('.sidekicks' or 'projects/<p>')
 * @param {{file: string, secret: string}} entry
 * @returns {Array<{path: string, kind: string}>}
 */
function scopeFiles(baseRel, entry) {
  return [
    { path: join(baseRel, CONFIG_DIR, entry.secret), kind: FILE_KIND.SECRET },
    { path: join(baseRel, CONFIG_DIR, entry.file), kind: FILE_KIND.FAMILY },
    { path: join(baseRel, LEGACY_FILE), kind: FILE_KIND.LEGACY },
  ];
}

/**
 * Fill keys `target` does not have from `source`, recursing into nested mappings.
 *
 * WHY DEEP, INSIDE A GROUP. A scope's three files are not three competing configurations — they are
 * one configuration split for git: `jira.secret.yaml` carries `alias.api_token` and `jira.yaml`
 * carries `alias.host`. A top-level merge would let the first file's `alias` mapping shadow the
 * second's entirely, so splitting the credentials out would silently delete every non-secret key
 * beside them. Across SCOPES the merge stays top-level (see mergeGroups) — there a project must be
 * able to replace an alias wholesale.
 *
 * @param {Record<string, any>} target - mutated
 * @param {Record<string, any>} source
 */
function fillMissingDeep(target, source) {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    const bothMappings = existing && typeof existing === 'object' && !Array.isArray(existing)
      && value && typeof value === 'object' && !Array.isArray(value);
    if (bothMappings) {
      fillMissingDeep(existing, value);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = value;
      continue;
    }
    // A key present but EMPTY in the higher file is a placeholder, not a value: the committed family
    // file keeps `api_token: ""` so a fresh clone can see what to supply, and the secret sibling — or
    // the legacy monolith below it — is what actually carries it.
    if ((existing === '' || existing === null) && value !== '' && value !== null) {
      target[key] = value;
    }
  }
}

/**
 * Read a group's files and merge them (highest first).
 *
 * @param {string} repoRoot
 * @param {Array<{path: string, kind: string}>} files
 * @param {{block: string, aliases: string[]}} entry
 * @returns {{value: object|null, files: Array<{path: string, kind: string, present: boolean}>}}
 */
function readGroup(repoRoot, files, entry) {
  /** @type {Record<string, any>|null} */
  let value = null;
  const detail = [];
  for (const f of files) {
    const found = blockFromFile(join(repoRoot, f.path), f.path, entry.block, entry.aliases);
    detail.push({ ...f, present: found !== null });
    if (found === null) continue;
    if (value === null) value = structuredClone(found);
    else fillMissingDeep(value, found);
  }
  return { value, files: detail };
}

/**
 * Resolve one configuration block.
 *
 * @param {string} repoRoot
 * @param {string} block - a block name or one of its recorded legacy aliases
 * @returns {{
 *   block: string, family: string, scope: string, merge: string, inherits_root: boolean,
 *   owners: string[], readers: string[], aliases: string[],
 *   config: object, sources: Record<string, string>,
 *   layers: Array<object>, active_scope: string,
 * }}
 * @throws {SidekicksError} EXIT_NOT_FOUND when nothing declares the block.
 */
export function resolveBlock(repoRoot, block) {
  const { byBlock } = buildFamilies(repoRoot);
  let entry = byBlock.get(block) ?? null;
  if (!entry) {
    for (const candidate of byBlock.values()) {
      if (candidate.aliases.includes(block)) { entry = candidate; break; }
    }
  }
  if (!entry) {
    throw new SidekicksError(
      `config: nothing declares block '${block}' — run 'sidekicks config list' to see the `
      + "registered blocks, then declare it in the owning skill's skill.yaml (or in "
      + 'lib/config-store/core-families.mjs when framework code reads it)',
      EXIT_NOT_FOUND
    );
  }

  const settings = readSettings(repoRoot);
  const { projectName, projectRelPath } = resolveEffectiveScope(settings);

  const projectApplies = entry.scope !== 'root' && projectRelPath !== null;
  // A project-scoped block is never read from root, not even when root IS the active scope:
  // with no project active it has no configured values and resolves to the skill's defaults,
  // which is the honest answer rather than a half-inherited one.
  const rootApplies = entry.scope !== 'project'
    && (entry.scope === 'root' || projectRelPath === null || entry.inherits_root);

  const layers = [];
  /** @type {Array<[string, object|null]>} */
  const groups = [];

  // 1. project group
  const projectRead = projectApplies
    ? readGroup(repoRoot, scopeFiles(projectRelPath, entry), entry)
    : { value: null, files: projectRelPath ? scopeFiles(projectRelPath, entry).map((f) => ({ ...f, present: false })) : [] };
  layers.push({
    layer: LAYER.PROJECT,
    applies: projectApplies,
    path: pickPath(projectRead, projectRelPath ? join(projectRelPath, CONFIG_DIR, entry.file) : null),
    present: projectRead.value !== null,
    files: projectRead.files,
  });
  if (projectApplies) groups.push([LAYER.PROJECT, projectRead.value]);

  // 2. root group
  const rootBase = '.sidekicks';
  const rootRead = rootApplies
    ? readGroup(repoRoot, scopeFiles(rootBase, entry), entry)
    : { value: null, files: scopeFiles(rootBase, entry).map((f) => ({ ...f, present: false })) };
  layers.push({
    layer: LAYER.ROOT,
    applies: rootApplies,
    // Kept for the callers that read this field before the scope had more than one file.
    inherits: rootApplies,
    path: pickPath(rootRead, join(rootBase, CONFIG_DIR, entry.file)),
    present: rootRead.value !== null,
    files: rootRead.files,
  });
  if (rootApplies) groups.push([LAYER.ROOT, rootRead.value]);

  // 3. the owning skill's committed defaults
  const defaultsRel = entry.defaults_from
    ? join(entry.defaults_from.tree, entry.defaults_from.skill, entry.defaults_from.file)
    : null;
  const defaultsValue = defaultsRel
    ? blockFromFile(join(repoRoot, defaultsRel), defaultsRel, entry.block, entry.aliases)
    : null;
  layers.push({
    layer: LAYER.DEFAULTS,
    applies: defaultsRel !== null,
    path: defaultsRel,
    present: defaultsValue !== null,
    files: defaultsRel
      ? [{ path: defaultsRel, kind: FILE_KIND.DEFAULTS, present: defaultsValue !== null }]
      : [],
  });
  groups.push([LAYER.DEFAULTS, defaultsValue]);

  // 4. the documented built-in carried by the descriptor
  layers.push({
    layer: LAYER.BUILTIN,
    applies: entry.builtin !== null,
    path: null,
    present: entry.builtin !== null,
    files: [],
  });
  groups.push([LAYER.BUILTIN, entry.builtin]);

  const { config, sources } = mergeGroups(groups, entry.merge);

  return {
    block: entry.block,
    family: entry.family,
    file: entry.file,
    secret_file: entry.secret,
    scope: entry.scope,
    merge: entry.merge,
    inherits_root: entry.inherits_root,
    owners: entry.owners,
    readers: entry.readers,
    aliases: entry.aliases,
    public_keys: entry.public_keys,
    title: entry.title,
    config,
    sources,
    layers,
    active_scope: projectName,
  };
}

/** The first file that actually carries the block, else the canonical family file. */
function pickPath(read, fallback) {
  const carrying = read.files.find((f) => f.present);
  return carrying ? carrying.path : fallback;
}

/**
 * Combine the scope groups.
 *
 * @param {Array<[string, object|null]>} groups - highest precedence first
 * @param {string} merge - 'per_key' | 'whole_block'
 * @returns {{config: object, sources: Record<string, string>}}
 */
function mergeGroups(groups, merge) {
  /** @type {Record<string, any>} */
  const config = {};
  /** @type {Record<string, string>} */
  const sources = {};
  for (const [layer, value] of groups) {
    if (!value) continue;
    for (const [key, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(config, key)) continue; // a higher group owns it
      config[key] = v;
      sources[key] = layer;
    }
    if (merge === 'whole_block') break; // the highest group carrying the block owns all of it
  }
  return { config, sources };
}

/**
 * Every registered block with the family file it lives in, for `config list`.
 *
 * @param {string} repoRoot
 * @returns {Array<object>}
 */
export function listBlocks(repoRoot) {
  const { blocks } = buildFamilies(repoRoot);
  return blocks.map((b) => ({
    block: b.block,
    family: b.family,
    file: b.file,
    secret_file: b.secret,
    title: b.title,
    owners: b.owners,
    readers: b.readers,
    aliases: b.aliases,
    public_keys: b.public_keys,
    scope: b.scope,
    inherits_root: b.inherits_root,
    merge: b.merge,
    defaults: b.defaults_from
      ? join(b.defaults_from.tree, b.defaults_from.skill, b.defaults_from.file)
      : null,
    source: b.source,
  }));
}

/**
 * The scope bases that exist, for the doctor and the migrator: root plus every project directory
 * carrying either a legacy monolith or a config/ directory.
 *
 * @param {string} repoRoot
 * @param {string[]} projectRelPaths
 * @returns {Array<{scope: string, base: string}>}
 */
export function scopeBases(repoRoot, projectRelPaths) {
  const out = [{ scope: 'sidekicks', base: '.sidekicks' }];
  for (const rel of projectRelPaths) {
    const hasLegacy = existsSync(join(repoRoot, rel, LEGACY_FILE));
    const hasDir = existsSync(join(repoRoot, rel, CONFIG_DIR));
    if (hasLegacy || hasDir) out.push({ scope: rel.split(/[\\/]/).pop(), base: rel });
  }
  return out;
}
