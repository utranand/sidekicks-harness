// lib/skill-manifest/read.mjs
// Skill discovery, manifest reading, and reconciliation of the DERIVED sections against skill.yaml.
//
// WHY DISCOVERY AND NOT A LIST. Same rationale as lib/framework-settings/registry.mjs: a
// hand-seeded catalog rots, and nothing here may hard-code how many skills exist. An externally
// installed skill is included in discovery but never *required* to carry a manifest — the required
// set is computed from what the scanner actually finds in its files (lib/skill-lifecycle/scan.mjs).
//
// WHY config/framework_hooks ARE DERIVED. Both already have an authority: the skill's skill.yaml
// (`config:` / `hooks:`) plus lib/framework-settings/core-registry.mjs for the hook's script path.
// Copying them into the manifest by hand would create a second source that can disagree with the
// first. They are therefore reconciled on every read, and a hand edit is reported as drift.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_TREES, readDescriptor, DESCRIPTOR_NAME } from '../framework-settings/registry.mjs';
import { CORE_HOOKS } from '../framework-settings/core-registry.mjs';
import { MANIFEST_NAME, parseManifest } from './schema.mjs';

export { MANIFEST_NAME };

/**
 * Every skill directory present, across the active and offloaded trees.
 *
 * The offloaded tree is included for the same reason registry.mjs scans it: a retired skill still
 * has to be addressable (its rule fragments and its dependency claims stay inspectable), and a
 * restore must not be the moment its manifest is first validated.
 *
 * @param {string} repoRoot
 * @returns {Array<{skill: string, tree: string, dir: string, relDir: string, offloaded: boolean}>}
 */
export function discoverSkills(repoRoot) {
  const out = [];
  for (const tree of SKILL_TREES) {
    const abs = join(repoRoot, tree);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;                       // an absent tree is not an error (fresh clone, lean runtime)
    }
    for (const e of entries) {
      // A symlink is accepted for the same reason registry.mjs accepts one: a skill may be linked
      // in from elsewhere and must still be discovered.
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const dir = join(abs, e.name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(join(dir, 'SKILL.md'))) continue;   // a skill is defined by having one
      out.push({
        skill: e.name,
        tree,
        dir,
        relDir: `${tree}/${e.name}`,
        offloaded: tree.includes('skill-offloaded'),
      });
    }
  }
  out.sort((a, b) => (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0));
  return out;
}

/**
 * Read one skill's descriptor, if it has one. A malformed descriptor is the framework registry's
 * problem, not this gate's — swallow it here so `skill doctor` never fails for a reason
 * `framework doctor` already reports.
 *
 * @param {string} repoRoot
 * @param {{skill: string, tree: string, dir: string}} entry
 * @returns {ReturnType<typeof readDescriptor>|null}
 */
export function readSkillDescriptor(repoRoot, entry) {
  const absPath = join(entry.dir, DESCRIPTOR_NAME);
  if (!existsSync(absPath)) return null;
  try {
    return readDescriptor({
      skill: entry.skill,
      tree: entry.tree,
      relPath: `${entry.tree}/${entry.skill}/${DESCRIPTOR_NAME}`,
      absPath,
    });
  } catch {
    return null;
  }
}

/**
 * What the manifest's DERIVED sections MUST contain, computed from the descriptor plus the core
 * hook registry. `degraded` is not derivable — only the author knows what breaks — so an existing
 * value is carried through and a missing one is reported by the schema validator.
 *
 * OWNERSHIP IS READ FROM BOTH DIRECTIONS. A skill can own a hook without shipping a descriptor at
 * all: `CORE_HOOKS[].owners` records the same fact, and four hooks are held that way today
 * (sk-validation-gate, sk-artifact-manager x2, sk-get-things-done). Reading
 * only `descriptor.hooks` sent those hook BODIES down the plain `framework_files` path instead —
 * authored where they should be derived, with the wrong remediation attached and, once
 * scripts/COMPONENTS.json lands, the wrong place to hash-check them against. Same stance as
 * lib/framework-settings/registry.mjs: the ownership record already exists, so derive it rather than
 * requiring the skill to restate it.
 *
 * @param {ReturnType<typeof readDescriptor>|null} descriptor
 * @param {string} [skill] - the skill's name, for the CORE_HOOKS owner lookup
 * @returns {{config: object|null, framework_hooks: Array<{id: string, script: string}>,
 *            framework_rules: Array<{id: string, title: string|null, body: string|null}>}}
 */
export function derivedSections(descriptor, skill = null) {
  const owned = skill
    ? CORE_HOOKS.filter((h) => (h.owners || []).includes(skill)).map((h) => h.id)
    : [];
  if (!descriptor) {
    return {
      config: null,
      framework_rules: [],
      framework_hooks: owned.map((id) => ({
        id, script: CORE_HOOKS.find((h) => h.id === id).script,
      })),
    };
  }

  const config = descriptor.config
    ? {
      block: descriptor.config.block,
      defaults: descriptor.config.defaults,
      // config.example.yaml is the OTHER, human-facing schema surface (read by sk-hello and
      // sk-config-doctor). It is recorded, not merged: unifying the two surfaces is real
      // debt with its own card, and this gate consumes both rather than picking a winner.
      example: null,
    }
    : null;

  // The SETTINGS half: every rule and criterion this skill owns, with the body file that must
  // travel beside it. Derived for the same reason config is — skill.yaml already declares them, and
  // a second hand-maintained copy could disagree with the first.
  const framework_rules = [...descriptor.rules]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => ({ id: r.id, title: r.title || null, body: r.body || null }));

  const byId = new Map(CORE_HOOKS.map((h) => [h.id, h]));
  const framework_hooks = [];
  for (const id of [...new Set([...descriptor.hooks, ...owned])].sort()) {
    const hook = byId.get(id);
    if (!hook) continue;              // registry.mjs already refuses an unregistered hook id
    framework_hooks.push({ id, script: hook.script });
  }
  return { config, framework_rules, framework_hooks };
}

/**
 * Read one skill's manifest.
 *
 * @param {string} repoRoot
 * @param {{skill: string, tree: string, dir: string}} entry
 * @returns {{present: boolean, relPath: string, manifest: object|null, errors: string[]}}
 */
export function readSkillManifest(repoRoot, entry) {
  const relPath = `${entry.tree}/${entry.skill}/${MANIFEST_NAME}`;
  const absPath = join(entry.dir, MANIFEST_NAME);
  if (!existsSync(absPath)) {
    return { present: false, relPath, absPath, text: null, manifest: null, errors: [], todos: [] };
  }
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch (err) {
    return {
      present: true, relPath, absPath, text: null, manifest: null, todos: [],
      errors: [`${relPath}: unreadable (${err.message})`],
    };
  }
  const { manifest, errors, todos } = parseManifest(text, entry.skill, relPath);
  return { present: true, relPath, absPath, text, manifest, errors, todos };
}

/**
 * Skills named by the `sidekicks.depends-on:` block in SKILL.md frontmatter.
 *
 * This block predates the manifest and stays: it is agent-readable, and sk-inherit's
 * composition analysis treats it as its most authoritative confidence tier. It becomes a MIRROR of
 * `requires.sibling_skills`, kept honest by the `depends-on-divergence` check — one authority, one
 * mirror, one test that they cannot drift. Same stance tests/skill-config.test.mjs already takes
 * for INHERITS_ROOT.
 *
 * The parse mirrors sk-inherit/scripts/inherit.mjs declaredDependencies(), including
 * dropping the bare `sidekicks` entry (that names the CLI substrate, not a skill).
 *
 * @param {{dir: string}} entry
 * @returns {string[]}
 */
export function readFrontmatterDependsOn(entry) {
  const f = join(entry.dir, 'SKILL.md');
  if (!existsSync(f)) return [];
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    return [];
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return [];
  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*depends-on:\s*$/.test(l));
  if (start === -1) return [];
  const deps = [];
  for (let i = start + 1; i < lines.length; i++) {
    const item = /^\s*-\s*(?:skill:)?([A-Za-z0-9._-]+)\s*$/.exec(lines[i]);
    if (!item) break;                          // the list ends at the first non-item line
    if (item[1] !== 'sidekicks') deps.push(item[1]);
  }
  return [...new Set(deps)].sort();
}

/**
 * The top-level scalars of a skill's `SKILL.md` frontmatter.
 *
 * WHY THIS LIVES HERE. Until now nothing in `lib/` could read a skill's own `name:`/`description:`
 * — the only frontmatter reader was readFrontmatterDependsOn above, which parses one nested block.
 * Description extraction existed solely inside sk-skill-manager's scripts
 * (skill-repo-readmes-public.mjs, skill-search.mjs), and a lib/ module may not reach into a skill's
 * script. `skill import` needs it to RECORD what an upstream skill calls itself — never to rewrite
 * it — so the reader is the same fence regex as above, promoted to a general one.
 *
 * IT REPORTS, IT NEVER COERCES. Values come back as raw strings: an absent key is `null`, an empty
 * value is `''`, and the two are different answers. A folded block scalar (`description: >-`) is
 * joined into one line, the way the README generators already fold it, because dropping the body
 * of the one field foreign skills always write long would defeat the purpose. A key whose
 * continuation lines are STRUCTURE (`  key: value` or `  - item`) is a nested mapping, not text:
 * it is recorded with a `null` value rather than folded into nonsense.
 *
 * @param {{dir: string}} entry
 * @returns {{present: boolean, name: string|null, description: string|null, version: string|null,
 *            license: string|null, keys: Map<string, string|null>}}
 */
export function readSkillFrontmatter(entry) {
  const empty = { present: false, name: null, description: null, version: null, license: null, keys: new Map() };
  const f = join(entry.dir, 'SKILL.md');
  if (!existsSync(f)) return empty;
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    return empty;
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return empty;

  const lines = fm[1].split(/\r?\n/);
  const keys = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_.-]+):(.*)$/.exec(lines[i]);        // column 0 only — top level
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    const folded = rest === '' || /^[|>][-+]?\d*$/.test(rest);
    if (!folded) {
      keys.set(key, unquoteScalar(rest));
      continue;
    }
    // Gather the indented continuation, then decide whether it is prose or structure.
    const cont = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') { cont.push(''); continue; }
      if (!/^\s/.test(l)) break;                                 // back to column 0 — key ended
      cont.push(l);
    }
    const first = cont.find((l) => l.trim() !== '');
    const isStructure = first !== undefined && /^\s+(?:[A-Za-z0-9_.-]+:|-\s)/.test(first);
    keys.set(key, isStructure || first === undefined
      ? null
      : unquoteScalar(cont.map((l) => l.trim()).join(' ').replace(/\s+/g, ' ').trim()));
    i = j - 1;
  }

  const get = (k) => (keys.has(k) ? keys.get(k) : null);
  return {
    present: true,
    name: get('name'),
    description: get('description'),
    version: get('version'),
    license: get('license'),
    keys,
  };
}

/** Strip ONE layer of matching quotes, leaving everything else — including inner quotes — alone. */
function unquoteScalar(value) {
  if (value.length >= 2) {
    const q = value[0];
    if ((q === "'" || q === '"') && value[value.length - 1] === q) return value.slice(1, -1);
  }
  return value;
}

/**
 * Compare a manifest's DERIVED sections against what skill.yaml says they must be.
 *
 * @param {object|null} manifest
 * @param {{config: object|null, framework_rules: object[], framework_hooks: object[]}} derived
 * @returns {string[]} one line per divergence
 */
export function derivedDrift(manifest, derived) {
  const out = [];
  if (!manifest) return out;

  const have = manifest.requires.config;
  const want = derived.config;
  if (!have && want) {
    out.push(`requires.config is absent but skill.yaml declares block '${want.block}'`);
  } else if (have && !want) {
    out.push(`requires.config declares block '${have.block}' but skill.yaml declares no config`);
  } else if (have && want) {
    if (have.block !== want.block) {
      out.push(`requires.config.block is '${have.block}' but skill.yaml says '${want.block}'`);
    }
    if ((have.defaults || null) !== (want.defaults || null)) {
      out.push(
        `requires.config.defaults is '${have.defaults}' but skill.yaml says '${want.defaults}'`
      );
    }
  }

  const haveRules = new Map(
    (manifest.requires.framework_rules || []).map((r) => [r.id, r.body || null])
  );
  // Tolerant on BOTH sides, like every other section here: a manifest written before this section
  // existed has no `framework_rules`, and a caller may hand in a partial derived object.
  const wantRules = new Map((derived.framework_rules || []).map((r) => [r.id, r.body || null]));
  for (const [id, body] of wantRules) {
    if (!haveRules.has(id)) {
      out.push(`requires.framework_rules is missing '${id}' (skill.yaml declares it)`);
    } else if (haveRules.get(id) !== body) {
      out.push(
        `requires.framework_rules['${id}'].body is '${haveRules.get(id)}' but skill.yaml says `
        + `'${body}'`
      );
    }
  }
  for (const id of haveRules.keys()) {
    if (!wantRules.has(id)) {
      out.push(`requires.framework_rules declares '${id}', which skill.yaml does not claim`);
    }
  }

  const haveHooks = new Map(manifest.requires.framework_hooks.map((h) => [h.id, h.script]));
  const wantHooks = new Map(derived.framework_hooks.map((h) => [h.id, h.script]));
  for (const [id, script] of wantHooks) {
    if (!haveHooks.has(id)) {
      out.push(`requires.framework_hooks is missing '${id}' (skill.yaml declares it)`);
    } else if (haveHooks.get(id) !== script) {
      out.push(
        `requires.framework_hooks['${id}'].script is '${haveHooks.get(id)}' but the core hook `
        + `registry says '${script}'`
      );
    }
  }
  for (const id of haveHooks.keys()) {
    if (!wantHooks.has(id)) {
      out.push(`requires.framework_hooks declares '${id}', which skill.yaml does not claim`);
    }
  }
  return out;
}
