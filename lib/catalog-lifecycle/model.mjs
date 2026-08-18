// lib/catalog-lifecycle/model.mjs
// buildCatalog(repoRoot) — the pure catalog model, derived from authoritative declarations only.
//
// WHAT THIS IS FOR. Six inventories of this substrate existed only as prose scattered through
// docs/, and prose does not get recompiled: docs/architecture.md claimed "33 verbs across seven
// namespaces" while the shipped CLI carried 136 verbs across 16. A number in prose is a number
// nothing checks. So every section below is READ from the declaration that already governs the
// thing, and never restated:
//
//   cli              VERBS / NAMESPACES               lib/sk-cli/help.mjs
//   framework        coreEntries() + buildRegistry()  lib/framework-settings/
//   skills           discoverSkills/readSkillManifest lib/skill-manifest/read.mjs
//   config           listBlocks()                     lib/config-store/read.mjs
//   executors        readRegistry/effectiveExecutors  lib/cli-executor-lifecycle/_shared.mjs
//   durable_formats  DURABLE_FORMATS                  ./durable-formats.mjs
//
// DETERMINISM IS THE CONTRACT. The model is rendered, written to disk, and later regenerated and
// compared byte-for-byte by `catalog check`, on macOS and on Windows. Three rules make that hold:
// no timestamp ever enters the model; every array is sorted by its own id with a code-point compare
// (never `localeCompare`, whose collation depends on the ICU build); and every path field is
// repo-relative with POSIX separators (never a machine-absolute path -- CLAUDE.md, portable paths).
// Object keys are written in a fixed order because JSON.stringify preserves insertion order, so the
// literals below ARE the serialization order.
//
// SCOPE-INDEPENDENT ON PURPOSE. The executor registry is read from the ROOT path
// (.sidekicks/config/cli-executors.json), not through resolveRegistryPath's active-scope lookup:
// the catalog describes the REPO, and a catalog that changed shape because someone ran
// `project use` would report drift for a fact about a project it is not describing.
//
// Zero npm dependencies -- node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { VERBS, NAMESPACES } from '../sk-cli/help.mjs';
import { buildRegistry } from '../framework-settings/registry.mjs';
import { discoverSkills, readSkillManifest, readFrontmatterDependsOn } from '../skill-manifest/read.mjs';
import { listBlocks } from '../config-store/read.mjs';
import { readRegistry, effectiveExecutors, routingPolicy, BUILTIN_NAMES } from '../cli-executor-lifecycle/_shared.mjs';
import { DURABLE_FORMATS } from './durable-formats.mjs';
import { posix, cmp, sortBy, uniqSorted } from './_shared.mjs';

/** The catalog's own schema version. Bumped only for a REMOVAL or rename -- additions are free. */
export const CATALOG_SCHEMA_VERSION = 1;

/** Every section name, in serialization order -- the valid `--section` values, minus `all`. */
export const CATALOG_SECTIONS = Object.freeze([
  'cli', 'framework', 'skills', 'config', 'executors', 'durable_formats',
]);

/** Where the executor registry is read from, repo-relative and root-anchored (see header). */
export const EXECUTOR_REGISTRY_REL = '.sidekicks/config/cli-executors.json';

/**
 * `how` values that make a sibling edge an ACQUISITION -- the skill loads the sibling's code into
 * its own process. Only these participate in the cycle failure, and the reason is not squeamishness:
 * a cycle is a defect exactly when it cannot resolve. Two skills that spawn each other's script
 * (`subprocess`) or hand work to each other (`handoff`, `cli-verb`) are mutual COMPOSITION, which is
 * a shipped and legitimate pattern here -- sk-get-jira-done and sk-is-jira-done each name the other,
 * as do sk-cli-executor and sk-loop-fleet. An `import` cycle has no such resolution: neither module
 * can finish loading. Mutual-composition cycles are still reported, as data, under
 * `skills.mutual_composition` -- visible, and not a failure.
 */
const ACQUISITION_HOWS = new Set(['import']);

/** `how` values that make an edge informational rather than a declared runtime need. */
const INFORMATIONAL_HOWS = new Set(['prose']);

/**
 * Build the whole catalog.
 *
 * @param {string} repoRoot - absolute repo root
 * @returns {object} the catalog model (no timestamps, fixed key order, sorted arrays)
 */
export function buildCatalog(repoRoot) {
  return {
    schema_version: CATALOG_SCHEMA_VERSION,
    cli: buildCliSection(),
    framework: buildFrameworkSection(repoRoot),
    skills: buildSkillsSection(repoRoot),
    config: buildConfigSection(repoRoot),
    executors: buildExecutorsSection(repoRoot),
    durable_formats: buildDurableFormatsSection(),
  };
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

/** `cli:<namespace>/<verb>` -- the stable id form. Never derive it anywhere else. */
export function cliCommandId(namespace, verb) {
  return `cli:${namespace}/${verb}`;
}

function buildCliSection() {
  const commands = sortBy(
    VERBS.map((v) => ({
      id: cliCommandId(v.namespace, v.verb),
      namespace: v.namespace,
      verb: v.verb,
      args: v.args || '',
      summary: v.summary,
      status: v.status,
      // Dispatch is convention-based (lib/sk-cli/cli.mjs): the dispatcher lazily imports
      // `lib/<namespace>-lifecycle/<verb>.mjs` and calls its exported run(ctx, args). Recording the
      // module here is what lets `catalog check` prove a registered verb is not a dead help row.
      module: `lib/${v.namespace}-lifecycle/${v.verb}.mjs`,
    })),
    (r) => r.id,
  );
  const namespaces = sortBy(
    NAMESPACES.map((ns) => ({
      namespace: ns,
      command_count: commands.filter((c) => c.namespace === ns).length,
    })),
    (r) => r.namespace,
  );
  return {
    namespace_count: namespaces.length,
    command_count: commands.length,
    namespaces,
    commands,
  };
}

// ---------------------------------------------------------------------------
// framework
// ---------------------------------------------------------------------------

function buildFrameworkSection(repoRoot) {
  const { entries } = buildRegistry(repoRoot);
  const rows = sortBy(
    entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      owners: uniqSorted(e.owners),
      body_at: posix(e.body_at),
      body_marker: e.body_marker ?? null,
      script: posix(e.script),
      floor: Boolean(e.floor),
      source: e.source,
    })),
    (r) => r.id,
  );
  return {
    entry_count: rows.length,
    rule_count: rows.filter((r) => r.kind === 'rule').length,
    criterion_count: rows.filter((r) => r.kind === 'criterion').length,
    hook_count: rows.filter((r) => r.kind === 'hook').length,
    floor_count: rows.filter((r) => r.floor).length,
    entries: rows,
  };
}

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

/** A skill's stable catalog id: its logical id when it declares one, else `skill:<folder>`. */
export function skillId(folder, manifestSkill) {
  return manifestSkill ? String(manifestSkill) : `skill:${folder}`;
}

function buildSkillsSection(repoRoot) {
  const discovered = discoverSkills(repoRoot);

  /** @type {Array<object>} */ const active = [];
  /** @type {Array<object>} */ const parked = [];
  /** @type {Array<object>} */ const edges = [];

  for (const entry of discovered) {
    const manifest = readSkillManifest(repoRoot, entry);
    const logical = manifest.manifest && manifest.manifest.skill;
    const id = skillId(entry.skill, logical);
    const siblings = (manifest.manifest
      && manifest.manifest.requires
      && manifest.manifest.requires.sibling_skills) || [];

    const hard = [];
    const informational = [];
    for (const row of siblings) {
      if (!row || !row.skill) continue;
      const how = row.how ? String(row.how) : null;
      const target = String(row.skill);
      const kind = (row.optional === true || (how && INFORMATIONAL_HOWS.has(how)))
        ? 'informational'
        : 'hard';
      (kind === 'hard' ? hard : informational).push(target);
      edges.push({
        from: id,
        from_folder: entry.skill,
        to_folder: target,
        how,
        kind,
        acquisition: kind === 'hard' && Boolean(how) && ACQUISITION_HOWS.has(how),
        parked_source: entry.offloaded,
      });
    }

    // A skill with no manifest still declares siblings, in the `sidekicks.depends-on:` frontmatter
    // block the manifest MIRRORS (lib/skill-manifest/read.mjs). Reading it only when the manifest is
    // absent keeps one authority per skill -- the mirror never adds an edge the manifest denied.
    if (!manifest.present) {
      for (const target of readFrontmatterDependsOn(entry)) {
        hard.push(target);
        edges.push({
          from: id,
          from_folder: entry.skill,
          to_folder: target,
          how: null,
          kind: 'hard',
          // Frontmatter states no `how`, so it cannot claim an in-process import. Treating it as
          // acquisition would invent a load-time relation the skill never declared.
          acquisition: false,
          parked_source: entry.offloaded,
        });
      }
    }

    const row = {
      id,
      folder: entry.skill,
      tree: posix(entry.tree),
      descriptor: existsSync(join(entry.dir, 'skill.yaml')),
      manifest: manifest.present,
      logical_id: logical ? String(logical) : null,
      hard_depends_on: uniqSorted(hard),
      informational_refs: uniqSorted(informational),
    };
    (entry.offloaded ? parked : active).push(row);
  }

  const activeRows = sortBy(active, (r) => r.id);
  const parkedRows = sortBy(parked, (r) => r.id);
  const edgeRows = [...edges].sort((a, b) =>
    cmp(a.from, b.from) || cmp(a.to_folder, b.to_folder) || cmp(a.how || '', b.how || ''));

  // Only ACTIVE skills' edges form the runtime graph -- a parked skill is invisible to discovery, so
  // an edge into or out of .sidekicks/skill-offloaded/ can neither be missing nor cycle at runtime.
  const activeFolders = new Set(activeRows.map((r) => r.folder));
  const activeGraph = new Map(activeRows.map((r) => [r.folder, []]));
  const acquisitionGraph = new Map(activeRows.map((r) => [r.folder, []]));
  const missing = [];
  for (const e of edgeRows) {
    if (e.parked_source || e.kind !== 'hard') continue;
    if (!activeFolders.has(e.to_folder)) {
      missing.push({ from: e.from_folder, to: e.to_folder, how: e.how });
      continue;
    }
    activeGraph.get(e.from_folder).push(e.to_folder);
    if (e.acquisition) acquisitionGraph.get(e.from_folder).push(e.to_folder);
  }

  return {
    active_count: activeRows.length,
    parked_count: parkedRows.length,
    edge_count: edgeRows.length,
    hard_edge_count: edgeRows.filter((e) => e.kind === 'hard' && !e.parked_source).length,
    // Mutual composition across a process or handoff boundary: reported, never a failure (header).
    mutual_composition: findCycles(activeGraph),
    acquisition_cycles: findCycles(acquisitionGraph),
    missing_targets: sortBy(missing, (r) => `${r.from} ${r.to}`),
    active: activeRows,
    parked: parkedRows,
    edges: edgeRows,
  };
}

/**
 * Every simple cycle reachable in a directed graph, each rendered as an ordered folder list.
 *
 * Iterative DFS with an explicit stack -- 122 active skills is small, but a recursive walk over an
 * agent-authored graph is exactly the kind of thing that finds a stack limit on someone else's
 * machine. Deterministic: nodes are visited in sorted order and each cycle is emitted once, keyed by
 * its rotation-normalized form.
 *
 * @param {Map<string, string[]>} graph
 * @returns {Array<{cycle: string[]}>}
 */
export function findCycles(graph) {
  const nodes = [...graph.keys()].sort(cmp);
  /** @type {Map<string, string[]>} */ const seen = new Map();
  const state = new Map(); // 0/absent = unvisited, 1 = on stack, 2 = done

  for (const start of nodes) {
    if (state.get(start)) continue;
    /** @type {Array<{node: string, targets: string[], i: number}>} */
    const stack = [{ node: start, targets: [...(graph.get(start) || [])].sort(cmp), i: 0 }];
    state.set(start, 1);
    const path = [start];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i >= top.targets.length) {
        state.set(top.node, 2);
        stack.pop();
        path.pop();
        continue;
      }
      const next = top.targets[top.i];
      top.i += 1;
      if (!graph.has(next)) continue;              // outside the graph: not a cycle candidate
      if (state.get(next) === 1) {
        const at = path.indexOf(next);
        if (at !== -1) {
          // Stored in its rotation-minimal form so the emitted cycle and the sort key agree --
          // otherwise the array is sorted by a string the reader cannot see.
          const cycle = rotateMinimal(path.slice(at));
          const key = cycle.join(' > ');
          if (!seen.has(key)) seen.set(key, cycle);
        }
        continue;
      }
      if (state.get(next) === 2) continue;
      state.set(next, 1);
      path.push(next);
      stack.push({ node: next, targets: [...(graph.get(next) || [])].sort(cmp), i: 0 });
    }
  }

  return [...seen.keys()].sort(cmp).map((key) => ({ cycle: [...seen.get(key)] }));
}

/**
 * The rotation of a cycle that sorts first -- so the same cycle found from a different entry point
 * (A,B vs B,A) is one finding with one spelling.
 *
 * @param {string[]} cycle
 * @returns {string[]}
 */
function rotateMinimal(cycle) {
  let best = null;
  let bestKey = null;
  for (let i = 0; i < cycle.length; i += 1) {
    const rotated = [...cycle.slice(i), ...cycle.slice(0, i)];
    const key = rotated.join(' > ');
    if (bestKey === null || key < bestKey) { bestKey = key; best = rotated; }
  }
  return best === null ? [] : best;
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/** `config:<block>` -- the stable id form. */
export function configBlockId(block) {
  return `config:${block}`;
}

function buildConfigSection(repoRoot) {
  const blocks = sortBy(
    listBlocks(repoRoot).map((b) => ({
      id: configBlockId(b.block),
      block: b.block,
      family: b.family,
      file: posix(b.file),
      secret_file: posix(b.secret_file),
      title: b.title ?? null,
      owners: uniqSorted(b.owners),
      readers: uniqSorted((b.readers || []).map((r) => posix(r))),
      aliases: uniqSorted(b.aliases),
      public_keys: uniqSorted(b.public_keys),
      scope: b.scope ?? null,
      inherits_root: Boolean(b.inherits_root),
      merge: b.merge ?? null,
      defaults: posix(b.defaults),
      source: b.source,
    })),
    (r) => r.id,
  );
  const families = sortBy(
    [...new Set(blocks.map((b) => b.family))].map((family) => ({
      family,
      block_count: blocks.filter((b) => b.family === family).length,
    })),
    (r) => r.family,
  );
  return {
    family_count: families.length,
    block_count: blocks.length,
    families,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// executors
// ---------------------------------------------------------------------------

/** `executor:<name>` -- the stable id form. */
export function executorId(name) {
  return `executor:${name}`;
}

function buildExecutorsSection(repoRoot) {
  const path = join(repoRoot, ...EXECUTOR_REGISTRY_REL.split('/'));
  const present = existsSync(path);
  const registry = readRegistry(path);
  const effective = effectiveExecutors(registry);
  const registered = new Set(Object.keys(registry.executors || {}));
  const builtin = new Set(BUILTIN_NAMES);

  // Deliberately NARROW. `binary`, `invoke` and `brief_stdin` are excluded: they are the fields that
  // can carry a machine-absolute path or an operator's argv, and no generated artifact may persist
  // either (CLAUDE.md, portable artifact paths / secrets). What the catalog needs from an executor is
  // its shape, not how to launch it.
  const executors = sortBy(
    Object.entries(effective).map(([name, spec]) => ({
      id: executorId(name),
      name,
      builtin: builtin.has(name),
      registered: registered.has(name),
      kind: spec.kind ?? null,
      enabled: spec.enabled !== false,
      transport: spec.transport ?? null,
      sandbox: spec.sandbox ?? null,
      usage_exposed: Boolean(spec.usage_exposed),
      description: spec.description ?? null,
      model_tiers: uniqSorted(Object.keys(spec.models || {})),
      specialty_count: Array.isArray(spec.specialties) ? spec.specialties.length : 0,
    })),
    (r) => r.id,
  );

  return {
    registry_file: EXECUTOR_REGISTRY_REL,
    registry_present: present,
    executor_count: executors.length,
    routing_prefer: routingPolicy(registry),
    executors,
  };
}

// ---------------------------------------------------------------------------
// durable_formats
// ---------------------------------------------------------------------------

/** `format:<id>` -- the stable id form. */
export function durableFormatId(id) {
  return `format:${id}`;
}

function buildDurableFormatsSection() {
  const formats = sortBy(
    DURABLE_FORMATS.map((f) => ({
      id: durableFormatId(f.id),
      format: f.id,
      owner: posix(f.owner),
      path_pattern: f.path_pattern,
      schema_version: f.schema_version ?? null,
      reader: posix(f.reader),
      writer: posix(f.writer),
      compatibility: f.compatibility,
    })),
    (r) => r.id,
  );
  return {
    format_count: formats.length,
    formats,
  };
}

/**
 * Every id the catalog declares, with the section that declared it -- the duplicate-id check input.
 *
 * @param {object} model
 * @returns {Array<{id: string, section: string}>}
 */
export function catalogIds(model) {
  const out = [];
  for (const c of model.cli.commands) out.push({ id: c.id, section: 'cli' });
  for (const e of model.framework.entries) out.push({ id: e.id, section: 'framework' });
  for (const s of model.skills.active) out.push({ id: s.id, section: 'skills' });
  for (const s of model.skills.parked) out.push({ id: s.id, section: 'skills' });
  for (const b of model.config.blocks) out.push({ id: b.id, section: 'config' });
  for (const x of model.executors.executors) out.push({ id: x.id, section: 'executors' });
  for (const f of model.durable_formats.formats) out.push({ id: f.id, section: 'durable_formats' });
  return out;
}
