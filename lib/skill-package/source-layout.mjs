// lib/skill-package/source-layout.mjs
// Reading a skills tree that was NOT laid out by `sidekicks skill export`.
//
// `skill import` used to require `<from>/.sidekicks/skills/` and refused everything else, so the
// only repositories it could ingest were ones this framework had written. Every other skills
// ecosystem — the Anthropic marketplace, a plugin repo, a bare `.claude/skills/` folder — was
// unreachable, and there was no conversion path anywhere in lib/ or in the skill.
//
// THE PROBE IS NEVER RECURSIVE. A "find every SKILL.md" walk is a false-positive machine: it
// sweeps vendored copies, docs examples and template folders, and a wrong hit here is a folder
// copied into `.sidekicks/` under a name nobody chose. Each layout is a bounded lookup at a known
// depth, tried in priority order, first hit wins.
//
// IT DECIDES WHERE FILES COME FROM, NEVER WHAT THEY MEAN. Nothing here reads a skill's body, and
// nothing here writes. Converting a foreign folder into something this framework understands is
// adopt.mjs's job, and the parts of that job which are policy — rules, config blocks, hook wiring,
// audit-group membership — belong to a human and are emitted as an apply plan.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SKILLS_ROOT_REL, SKILL_TREE_BY_BASENAME } from '../sk-cli/skill-trees.mjs';

/** Layout ids, in the order `detectLayout` probes them. */
export const LAYOUTS = Object.freeze(['sidekicks', 'claude', 'flat', 'nested', 'root']);

/**
 * The trees a native sidekicks source keeps skills in, as path segments, in PROBE ORDER.
 *
 * Three entries rather than two, and every one of them is load-bearing. `.agents/skills` is where a
 * current source keeps its skills. `.sidekicks/skills` is where a source published BEFORE the move
 * keeps them — including every skills repository this repo publishes to, which is deliberately not
 * migrated (see DEST_TREES in lib/skill-lifecycle/destinations.mjs). `.sidekicks/skill-offloaded` is
 * the parked tree, which did not move at all. Importing from an older sibling repo has to keep
 * working, so this reads whichever shape is on disk instead of assuming the local one.
 */
const NATIVE_TREE_PATHS = Object.freeze([
  Object.freeze(['.agents', 'skills']),
  Object.freeze(['.sidekicks', 'skills']),
  Object.freeze(['.sidekicks', 'skill-offloaded']),
]);

/**
 * Directory names that are never a skill, however much they look like one at depth 1.
 *
 * The `root` layout — a bare `<name>/SKILL.md` at the repository root — is the most permissive
 * probe there is, so it is also the only one that needs a deny list. This is not hypothetical:
 * `~/.claude/plugins/marketplaces/anthropic-agent-skills/template/SKILL.md` is a 140-byte stub
 * that would otherwise import as a skill called `template`.
 */
const NEVER_A_SKILL = Object.freeze(new Set([
  'template', 'templates', 'example', 'examples', 'spec', 'specs', 'docs', 'doc',
  'test', 'tests', 'fixtures', 'meta', 'dist', 'build', 'node_modules', 'scripts',
  'assets', 'references', 'artifacts', 'schemas', 'bin', 'lib', 'src',
]));

/**
 * A directory name this framework can carry as a skill.
 *
 * The same charset `readFrontmatterDependsOn` already accepts, lowercased: a skill name becomes a
 * directory under `.agents/skills/`, a symlink target on three other CLIs, and a key in several
 * generated YAML files, so a name with a space or a slash in it is a defect and not a preference.
 */
const VALID_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Directory entries of `dir`, or [] when it is absent/unreadable. Never throws. */
function dirs(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;                 // .git, .github, .claude-plugin, …
    const abs = join(dir, e.name);
    try { if (!statSync(abs).isDirectory()) continue; } catch { continue; }
    out.push({ name: e.name, abs });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Is there a SKILL.md directly inside this directory? */
function isSkillDir(abs) {
  return existsSync(join(abs, 'SKILL.md'));
}

/**
 * One probe's candidates, before name validation.
 *
 * @returns {Array<{name: string, abs: string, category: string|null}>}
 */
function probe(fromRoot, layout) {
  switch (layout) {
    case 'sidekicks': {
      const out = [];
      const seen = new Set();
      for (const rel of NATIVE_TREE_PATHS) {
        // The WHOLE relative path, not its basename. The two native trees no longer share a parent
        // (`.agents/skills` vs `.sidekicks/skill-offloaded`), so a basename cannot be re-joined to a
        // fixed prefix later — doing that silently reported every incoming skill under the tree it
        // did not come from, and the import then wrote to a directory nothing was reading.
        const tree = rel.join('/');
        for (const d of dirs(join(fromRoot, ...rel))) {
          // A source may carry BOTH parents — a skills repository mid-migration, or a checkout where
          // .agents/skills is still the exposure link into .sidekicks/skills. First hit wins so the
          // same skill is never offered twice.
          if (seen.has(d.name) || !isSkillDir(d.abs)) continue;
          seen.add(d.name);
          out.push({ name: d.name, abs: d.abs, category: null, tree });
        }
      }
      return out;
    }
    case 'claude':
      return dirs(join(fromRoot, '.claude', 'skills'))
        .filter((d) => isSkillDir(d.abs))
        .map((d) => ({ name: d.name, abs: d.abs, category: null }));
    case 'flat':
      return dirs(join(fromRoot, 'skills'))
        .filter((d) => isSkillDir(d.abs))
        .map((d) => ({ name: d.name, abs: d.abs, category: null }));
    case 'nested': {
      const out = [];
      for (const cat of dirs(join(fromRoot, 'skills'))) {
        // A depth-1 directory that IS a skill is a skill, not a category — otherwise a repo that
        // mixes the two would have its flat skills read as empty categories.
        if (isSkillDir(cat.abs)) continue;
        for (const d of dirs(cat.abs)) {
          if (isSkillDir(d.abs)) out.push({ name: d.name, abs: d.abs, category: cat.name });
        }
      }
      return out;
    }
    case 'root':
      return dirs(fromRoot)
        .filter((d) => isSkillDir(d.abs) && !NEVER_A_SKILL.has(d.name.toLowerCase()))
        .map((d) => ({ name: d.name, abs: d.abs, category: null }));
    default:
      return [];
  }
}

/**
 * Which layout this tree is in.
 *
 * `sidekicks` SHORT-CIRCUITS. A sidekicks repository may perfectly well also carry `.claude/skills`
 * (this one does — it is the Rule 3 exposure link pointing straight back at `.agents/skills`),
 * and reading a native tree as a foreign one would strip its provenance and re-adopt skills that
 * are already ours.
 *
 * `flat` and `nested` are UNIONED rather than raced, because one repository can legitimately hold
 * both shapes; every other pair is an ambiguity the caller has to settle with `--layout`.
 *
 * @param {string} fromRoot
 * @returns {{layout: string|null, counts: Record<string, number>, ambiguous: string[], evidence: string}}
 */
export function detectLayout(fromRoot) {
  const counts = {};
  for (const id of LAYOUTS) counts[id] = probe(fromRoot, id).length;

  if (counts.sidekicks > 0) {
    return {
      layout: 'sidekicks', counts, ambiguous: [],
      evidence: `${counts.sidekicks} skill(s) under .agents/skills/ or .sidekicks/{skills,skill-offloaded}/`,
    };
  }

  const hits = ['claude', 'flat', 'nested', 'root'].filter((id) => counts[id] > 0);
  // flat and nested are one answer, not two.
  const merged = hits.includes('flat') && hits.includes('nested')
    ? ['flat+nested', ...hits.filter((h) => h !== 'flat' && h !== 'nested')]
    : hits;

  if (merged.length === 0) return { layout: null, counts, ambiguous: [], evidence: '' };
  if (merged.length > 1) {
    return {
      layout: null, counts, ambiguous: merged,
      evidence: merged.map((id) => `${id} (${id === 'flat+nested'
        ? counts.flat + counts.nested : counts[id]})`).join(', '),
    };
  }
  const only = merged[0];
  const n = only === 'flat+nested' ? counts.flat + counts.nested : counts[only];
  return { layout: only, counts, ambiguous: [], evidence: `${n} skill(s) in the '${only}' layout` };
}

/** Is this root a CLI plugin marketplace rather than a plain skills repository? */
function sourceKind(fromRoot, layout) {
  if (layout === 'sidekicks') return 'sidekicks';
  if (existsSync(join(fromRoot, '.claude-plugin'))) return 'plugin-marketplace';
  return 'plain';
}

/**
 * Every skill in a source tree, keyed by the name it would land under here.
 *
 * @param {string} fromRoot
 * @param {{layout?: string|null, into?: string}} opts - `into` is the destination tree for a
 *   FOREIGN skill ('skills' or 'skill-offloaded'); a native skill always keeps its own tree.
 * @returns {{layout: string, native: boolean, source_kind: string,
 *            entries: Map<string, object>, rejected: Array<{path: string, reason: string}>,
 *            detection: object}}
 */
export function readSource(fromRoot, opts = {}) {
  const detection = detectLayout(fromRoot);
  const layout = opts.layout && opts.layout !== 'auto' ? opts.layout : detection.layout;
  if (!layout) {
    return {
      layout: null, native: false, source_kind: sourceKind(fromRoot, null),
      entries: new Map(), rejected: [], detection,
    };
  }

  const ids = layout === 'flat+nested' ? ['flat', 'nested'] : [layout];
  const native = layout === 'sidekicks';
  const into = native ? null : (opts.into || 'skills');
  const entries = new Map();
  const rejected = [];

  for (const id of ids) {
    for (const c of probe(fromRoot, id)) {
      const name = c.name;
      if (!VALID_NAME.test(name)) {
        rejected.push({
          path: relDir(fromRoot, c.abs),
          reason: `'${name}' is not a usable skill directory name (lowercase letters, digits, . _ - only)`,
        });
        continue;
      }
      if (entries.has(name)) {
        rejected.push({
          path: relDir(fromRoot, c.abs),
          reason: `'${name}' appears more than once in this tree — keeping ${entries.get(name).upstreamRel}`,
        });
        continue;
      }
      // A native skill keeps the tree it was found in, already a full relative path. A FOREIGN one
      // has no tree of its own, so `--into`'s basename vocabulary is resolved to a real path here.
      const tree = native ? c.tree : (SKILL_TREE_BY_BASENAME[into] || `${SKILLS_ROOT_REL}`);
      entries.set(name, {
        skill: name,
        dir: c.abs,
        tree,
        relDir: `${tree}/${name}`,
        upstreamRel: relDir(fromRoot, c.abs),
        category: c.category,
        layout: id,
        native,
      });
    }
  }

  return { layout, native, source_kind: sourceKind(fromRoot, layout), entries, rejected, detection };
}

/** A source-relative POSIX path, resolving symlinks so `.claude/skills` reports where it really is. */
function relDir(fromRoot, abs) {
  let root = fromRoot;
  let target = abs;
  try { root = realpathSync(fromRoot); } catch { /* keep the literal path */ }
  try { target = realpathSync(abs); } catch { /* keep the literal path */ }
  const rel = relative(root, target);
  // A `.claude/skills` link can point outside the source root entirely; report the absolute-ish
  // form rather than a `../../..` chain nobody can act on.
  return rel && !rel.startsWith('..') ? rel.split('\\').join('/') : abs.split('\\').join('/');
}
