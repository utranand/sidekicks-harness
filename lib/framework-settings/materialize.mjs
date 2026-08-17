// lib/framework-settings/materialize.mjs
// "Every framework entry is VISIBLE in .sidekicks/framework.yaml."
//
// The enable map resolves an unlisted id to the built-in default (enabled), so an empty file
// and a fully-listed file behave identically. They do NOT read identically: with `rules: {}`
// nobody can see, in the committed file, which rules and criteria this repo is actually
// carrying — you have to run `framework list` and trust it. That invisibility is how a rule
// gets added, never noticed, and never reviewed.
//
// So the repo keeps the file MATERIALISED: one explicit `<slug>: true|false` line per
// non-floor registry entry. Nothing about resolution changes (an explicit `true` and a
// missing key both mean enabled) — the file simply stops hiding what exists.
//
// FLOOR IDS ARE DELIBERATELY ABSENT. A safety-floor id present in any data layer is a
// validation error (resolve.mjs assertNoFloorIds) precisely so a settings file can never
// claim a safety rule is off. They stay visible through `framework list`, which marks them
// `enabled (floor)`. `framework sync` therefore materialises the toggleable set, not the
// whole registry, and the drift check below never asks for a floor id.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { buildRegistry } from './registry.mjs';
import {
  BLOCKS,
  BLOCK_KIND,
  FRAMEWORK_REL,
  SETTINGS_REL_DIR,
  committedSources,
  frameworkPath,
  makeId,
  parseId,
  removeMonolithToggles,
  writeToggles,
} from './framework-config.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { ensurePendingIgnore, PENDING_PREFIX } from '../config-store/write.mjs';

/**
 * Compare the registry against the committed file.
 *
 * @param {string} repoRoot
 * @returns {{
 *   missing: string[],     // registered, toggleable, but listed in neither committed source
 *   unknown: string[],     // listed in a committed source, but no longer in the registry
 *   listed: string[],      // ids a committed source carries and the registry knows
 *   unmigrated: string[],  // ids carried ONLY by the pre-split monolith — `sync --split` moves them
 *   toggleable: number,    // registry entries that MUST be listed
 *   floor: string[],       // registry entries that must NOT be listed
 * }}
 */
export function frameworkDrift(repoRoot) {
  const { entries } = buildRegistry(repoRoot);

  // "Listed" means listed in EITHER committed source: an entry still carried only by the pre-split
  // monolith is visible, so sync must not re-add it and doctor must not call it drift. Moving it
  // into the per-kind file is what `sync --split` is for, reported separately as `unmigrated`.
  /** @type {Record<string, Record<string, boolean>>} */
  const fileBlocks = { rules: {}, criteria: {}, hooks: {} };
  /** @type {Record<string, Record<string, boolean>>} */
  const splitBlocks = { rules: {}, criteria: {}, hooks: {} };
  const unmigrated = [];
  for (const source of committedSources(repoRoot)) {
    for (const block of BLOCKS) {
      Object.assign(fileBlocks[block], source.blocks[block] ?? {});
      if (source.kind === 'settings') Object.assign(splitBlocks[block], source.blocks[block] ?? {});
    }
  }
  for (const block of BLOCKS) {
    for (const slug of Object.keys(fileBlocks[block])) {
      if (!Object.prototype.hasOwnProperty.call(splitBlocks[block], slug)) {
        unmigrated.push(makeId(BLOCK_KIND[block], slug));
      }
    }
  }
  unmigrated.sort();

  /** @type {Record<string, Set<string>>} */
  const known = { rules: new Set(), criteria: new Set(), hooks: new Set() };
  const missing = [];
  const listed = [];
  const floor = [];
  let toggleable = 0;

  for (const entry of entries) {
    if (entry.floor) { floor.push(entry.id); continue; }
    const { block, slug } = parseId(entry.id);
    known[block].add(slug);
    toggleable += 1;
    if (Object.prototype.hasOwnProperty.call(fileBlocks[block], slug)) listed.push(entry.id);
    else missing.push(entry.id);
  }

  const unknown = [];
  for (const block of BLOCKS) {
    for (const slug of Object.keys(fileBlocks[block])) {
      if (!known[block].has(slug)) unknown.push(makeId(BLOCK_KIND[block], slug));
    }
  }

  missing.sort();
  unknown.sort();
  return { missing, unknown, listed, unmigrated, toggleable, floor };
}

/**
 * Materialise the file: add every missing entry at its built-in default (`true`), optionally
 * dropping entries the registry no longer knows.
 *
 * A missing entry is written as `true` and NEVER as the currently effective state: the
 * effective state may come from a per-machine settings.json or a per-project manifest, and
 * copying that into the committed team layer would silently promote one machine's opinion.
 * An already-listed entry is left exactly as it is — sync never re-decides a recorded choice.
 *
 * @param {string} repoRoot
 * @param {{ prune?: boolean }} [opts]
 * @returns {{ added: string[], pruned: string[], unknown: string[], path: string, created: boolean }}
 */
export function materializeFramework(repoRoot, opts = {}) {
  const drift = frameworkDrift(repoRoot);
  const prune = opts.prune === true;
  // Write in canonical block order (rules, criteria, hooks) so a file this creates from
  // scratch reads in the order the contract documents, not alphabetically by kind.
  const byBlock = (id) => BLOCKS.indexOf(parseId(id).block);
  const ordered = [...drift.missing].sort((a, b) => byBlock(a) - byBlock(b) || a.localeCompare(b));
  const ops = [
    ...ordered.map((id) => ({ id, value: true })),
    ...(prune ? drift.unknown.map((id) => ({ id, remove: true })) : []),
  ];
  if (ops.length === 0) {
    return {
      added: [],
      pruned: [],
      unknown: drift.unknown,
      unmigrated: drift.unmigrated,
      path: SETTINGS_REL_DIR,
      created: false,
    };
  }
  const { path, created } = writeToggles(repoRoot, ops);
  // A pruned id may live in the pre-split monolith rather than the per-kind file, and writeToggles
  // only ever touches the latter. Without this second pass `sync --prune` would report a removal
  // that the resolver still sees.
  if (prune) removeMonolithToggles(repoRoot, drift.unknown);
  return {
    added: drift.missing,
    pruned: prune ? drift.unknown : [],
    unknown: prune ? [] : drift.unknown,
    unmigrated: drift.unmigrated,
    path,
    created,
  };
}

/**
 * Migrate the pre-split monolith into the per-kind settings files, then park it.
 *
 * Every entry the monolith carries is written into `settings/<kind>.yaml` at its RECORDED value —
 * this is a move, not a re-decision, so a `false` stays `false`. An id the per-kind file already
 * carries wins and is left alone: the split file is the higher layer, so it already decided.
 *
 * The monolith is then renamed to `pending-removal.framework.yaml` beside itself rather than
 * deleted — the same one-release rollback reference `config migrate --prune` leaves, and the same
 * git-ignore rule already covers the prefix.
 *
 * @param {string} repoRoot
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ moved: string[], skipped: string[], from: string|null, to: string|null }}
 */
export function splitSettings(repoRoot, opts = {}) {
  const monolithAbs = frameworkPath(repoRoot);
  if (!existsSync(monolithAbs)) return { moved: [], skipped: [], from: null, to: null };

  /** @type {Record<string, Record<string, boolean>>} */
  const monolith = { rules: {}, criteria: {}, hooks: {} };
  /** @type {Record<string, Record<string, boolean>>} */
  const split = { rules: {}, criteria: {}, hooks: {} };
  let fromRel = FRAMEWORK_REL;
  for (const source of committedSources(repoRoot)) {
    const target = source.kind === 'monolith' ? monolith : split;
    if (source.kind === 'monolith') fromRel = source.rel;
    for (const block of BLOCKS) Object.assign(target[block], source.blocks[block] ?? {});
  }

  const ops = [];
  const skipped = [];
  for (const block of BLOCKS) {
    for (const [slug, value] of Object.entries(monolith[block])) {
      const id = makeId(BLOCK_KIND[block], slug);
      if (Object.prototype.hasOwnProperty.call(split[block], slug)) { skipped.push(id); continue; }
      ops.push({ id, value });
    }
  }
  ops.sort((a, b) => BLOCKS.indexOf(parseId(a.id).block) - BLOCKS.indexOf(parseId(b.id).block)
    || a.id.localeCompare(b.id));
  const moved = ops.map((op) => op.id);
  skipped.sort();

  const parkedRel = join(dirname(fromRel), `${PENDING_PREFIX}framework.yaml`);
  if (opts.dryRun === true) return { moved, skipped, from: fromRel, to: parkedRel };

  if (ops.length) writeToggles(repoRoot, ops);

  const parkedAbs = join(repoRoot, parkedRel);
  assertWritable(parkedAbs, repoRoot);
  assertWritable(monolithAbs, repoRoot);
  ensurePendingIgnore(repoRoot, dirname(fromRel));
  renameSync(monolithAbs, parkedAbs);

  return { moved, skipped, from: fromRel, to: parkedRel };
}
