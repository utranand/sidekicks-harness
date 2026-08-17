// lib/skill-package/closure.mjs
// "What does this set of skills actually need in order to work somewhere else?"
//
// One function, four consumers: `skill export`, `skill import`, `skill advise`, and
// `package transfer`. That count is the whole justification for the module existing. Before it,
// every consumer answered the question its own way — `lib/package-lifecycle/transfer.mjs` answered
// it with `// skills are self-contained` and skipped the work; `sk-inherit/scripts/inherit.mjs`
// re-implemented frontmatter parsing, reference scanning and tree hashing to answer it. A gate and
// a verb that disagree is the failure mode lib/skill-lifecycle/scan.mjs:5-11 already names, and
// closure had the same problem detection did.
//
// IT READS MANIFESTS, IT DOES NOT SCAN. Closure is a DECLARATION question — `requires.sibling_skills`
// is the authority and carries `how:`, `scope:` and `degraded:`, none of which a scanner can infer.
// Scanning is scan.mjs's job and `skill doctor`'s gate. Keeping them apart is what makes this cheap
// enough to call from a hot verb and honest enough to be the export contract: an undeclared edge is
// doctor's finding, not a silent omission here. `advisory` exists for the one case where a caller
// genuinely wants the scanner's opinion too, and it is opt-in.
//
// THE HOLES ARE VISIBLE. `missing` (a declared sibling in neither tree) and `no_manifest` (a skill
// in the closure that declares nothing at all) are returned, not swallowed. An export that quietly
// dropped a sibling would produce a package that fails at the destination, and blame the destination.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverSkills,
  readSkillManifest,
  readSkillDescriptor,
  derivedSections,
  readFrontmatterDependsOn,
} from '../skill-manifest/read.mjs';

/** `scope: test` rows are dropped under 'runtime' — a lifted skill is complete without its harness. */
export const SCOPES = Object.freeze(['runtime', 'all']);

/**
 * Merge a row into a keyed accumulator, recording every skill that needed it.
 *
 * Deduplication is by the row's identity, and `needed_by` is a LIST rather than a first-writer-wins
 * field: when two skills both need `scripts/enforce-local-memory.mjs`, dropping one of them from the
 * record is what makes a later "is this still needed?" unanswerable.
 */
function collect(map, key, row, neededBy) {
  const existing = map.get(key);
  if (existing) {
    if (!existing.needed_by.includes(neededBy)) existing.needed_by.push(neededBy);
    // Prefer a row that carries prose over one that does not — two declarations of the same host
    // path may differ in how much they explain, and the explanation is the useful half.
    for (const field of ['degraded', 'why', 'install_hint', 'install_hint_windows', 'entry']) {
      if (!existing[field] && row[field]) existing[field] = row[field];
    }
    return;
  }
  map.set(key, { ...row, needed_by: [neededBy] });
}

/**
 * The transitive closure of everything `names` needs.
 *
 * `rules` and `config_blocks` are ONE ROW PER OWNER, not per id — deliberately. Co-ownership is
 * real: four skills declare `rule.bmad-first`, but exactly one of them ships the body and the other
 * three redeclare it with `body: null` to record that they are bound by it. Same for a config block:
 * `sk-jira-connector` ships `jira`'s defaults and `sk-jira-autopilot` consumes it with
 * `defaults: null`. So a consumer copying files must select the row whose `body` / `defaults` is
 * non-null, and a consumer reporting ownership wants them all. Collapsing to one row per id would
 * make the first reading impossible and the second wrong.
 *
 * @param {string} repoRoot
 * @param {string[]} names - seed skill names
 * @param {{scope?: 'runtime'|'all', includeAdvisory?: boolean}} [opts]
 * @returns {{
 *   selected: Array<{skill: string, tree: string, dir: string, relDir: string, offloaded: boolean, seed: boolean, via: string[]}>,
 *   edges: Array<{from: string, to: string, how: string, scope: string, degraded: string|null}>,
 *   missing: Array<{skill: string, needed_by: string[], degraded: string|null}>,
 *   no_manifest: string[],
 *   unknown_seeds: string[],
 *   python: Array<object>, node: Array<object>, binaries: Array<object>,
 *   host_paths: Array<object>, framework_files: Array<object>, framework_hooks: Array<object>,
 *   rules: Array<{id: string, body: string|null, owner: string}>,
 *   config_blocks: Array<{block: string, defaults: string|null, owner: string}>,
 *   requirements: Array<{skill: string, path: string}>,
 *   advisory: Array<{from: string, to: string, confidence: string, evidence: object}>,
 * }}
 */
export function skillClosure(repoRoot, names, opts = {}) {
  const scope = opts.scope === 'all' ? 'all' : 'runtime';
  const all = discoverSkills(repoRoot);
  const byName = new Map(all.map((e) => [e.skill, e]));

  const seeds = [...new Set(names || [])];
  const unknown_seeds = seeds.filter((n) => !byName.has(n));

  /** @type {Map<string, {entry: object, seed: boolean, via: string[]}>} */
  const chosen = new Map();
  const edges = [];
  const missingMap = new Map();
  const no_manifest = [];

  const python = new Map();
  const node = new Map();
  const binaries = new Map();
  const host_paths = new Map();
  const framework_files = new Map();
  const framework_hooks = new Map();
  const rules = [];
  const config_blocks = [];
  const requirements = [];

  // Breadth-first over declared siblings. A visited set rather than recursion depth: two skills that
  // declare each other is legal (a handoff pair), and a naive walk would not terminate.
  const queue = [];
  for (const n of seeds) {
    if (!byName.has(n)) continue;
    chosen.set(n, { entry: byName.get(n), seed: true, via: [] });
    queue.push(n);
  }

  while (queue.length) {
    const name = queue.shift();
    const entry = byName.get(name);
    const read = readSkillManifest(repoRoot, entry);

    // A skill's own pinned requirements travel with it and are what `heal` prefers, so the export
    // has to know the file exists even when the manifest lists the packages unpinned.
    if (existsSync(join(entry.dir, 'requirements.txt'))) {
      requirements.push({ skill: name, path: 'requirements.txt' });
    }

    // Rules and config blocks come from the DESCRIPTOR, not the manifest: a rule body lives inside
    // the skill folder and must travel with it (tests/framework-export.test.mjs), and a lifted skill
    // whose rule body stayed behind has a dangling framework entry.
    const descriptor = readSkillDescriptor(repoRoot, entry);
    if (descriptor) {
      for (const r of descriptor.rules || []) {
        rules.push({ id: r.id, body: r.body || null, owner: name });
      }
      const derived = derivedSections(descriptor, name);
      if (derived.config) {
        config_blocks.push({
          block: derived.config.block, defaults: derived.config.defaults || null, owner: name,
        });
      }
      for (const h of derived.framework_hooks) {
        collect(framework_hooks, h.id, { id: h.id, script: h.script, degraded: null }, name);
      }
    }

    if (!read.present || !read.manifest) {
      // Not an error — 41 skills legitimately declare nothing. But it IS the reason a closure can be
      // incomplete, so the caller is told which skills contributed no declarations rather than
      // being handed a confident-looking answer built partly from silence.
      no_manifest.push(name);
      continue;
    }

    const req = read.manifest.requires;
    const inScope = (row) => scope === 'all' || (row.scope || 'runtime') !== 'test';

    for (const row of req.python) {
      if (!inScope(row)) continue;
      const key = row.package || row.import;
      collect(python, key, {
        package: key, import: row.import || key, optional: Boolean(row.optional),
        why: row.why || null,
      }, name);
    }
    for (const row of req.node) {
      collect(node, row.package, {
        package: row.package, scope: row.scope || null, optional: Boolean(row.optional),
        why: row.why || null,
      }, name);
    }
    for (const row of req.binaries) {
      collect(binaries, row.name, {
        name: row.name, optional: Boolean(row.optional), why: row.why || null,
        install_hint: row.install_hint || null,
        install_hint_windows: row.install_hint_windows || null,
      }, name);
    }
    for (const row of req.host_paths) {
      collect(host_paths, row.path, { path: row.path, degraded: row.degraded || null }, name);
    }
    for (const row of req.framework_files) {
      collect(framework_files, row.path, { path: row.path, degraded: row.degraded || null }, name);
    }
    for (const row of req.framework_hooks) {
      collect(framework_hooks, row.id, {
        id: row.id, script: row.script || null, degraded: row.degraded || null,
      }, name);
    }

    for (const row of req.sibling_skills) {
      if (!inScope(row)) continue;
      const target = row.skill;
      edges.push({
        from: name, to: target, how: row.how || 'prose',
        scope: row.scope || 'runtime', degraded: row.degraded || null,
        entry: row.entry || null,
      });
      if (!byName.has(target)) {
        collect(missingMap, target, { skill: target, degraded: row.degraded || null }, name);
        continue;
      }
      if (chosen.has(target)) {
        const rec = chosen.get(target);
        if (!rec.via.includes(name)) rec.via.push(name);
        continue;
      }
      chosen.set(target, { entry: byName.get(target), seed: false, via: [name] });
      queue.push(target);
    }
  }

  const advisory = [];
  if (opts.includeAdvisory) {
    // The scanner's opinion, on request only, and never merged into `edges` — an undeclared edge is
    // a DIFFERENT kind of fact from a declared one, and flattening the two would let a `prose`
    // mention become an export dependency.
    for (const [name] of chosen) {
      const entry = byName.get(name);
      for (const dep of readFrontmatterDependsOn(entry)) {
        if (edges.some((e) => e.from === name && e.to === dep)) continue;
        advisory.push({
          from: name, to: dep, confidence: 'frontmatter',
          evidence: { file: 'SKILL.md', note: 'named in depends-on but not in requires.sibling_skills' },
        });
      }
    }
  }

  const selected = [...chosen.entries()]
    .map(([skill, rec]) => ({ ...rec.entry, skill, seed: rec.seed, via: rec.via }))
    .sort((a, b) => (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0));

  return {
    selected,
    edges,
    missing: [...missingMap.values()],
    no_manifest: no_manifest.sort(),
    unknown_seeds,
    python: [...python.values()],
    node: [...node.values()],
    binaries: [...binaries.values()],
    host_paths: [...host_paths.values()],
    framework_files: [...framework_files.values()],
    framework_hooks: [...framework_hooks.values()],
    rules,
    config_blocks,
    requirements,
    advisory,
  };
}
