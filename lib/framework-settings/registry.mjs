// lib/framework-settings/registry.mjs
// The rule / criterion / hook registry — DERIVED, never hand-maintained.
//
// WHY DERIVED: a hand-seeded catalog is exactly how AGENTS.md ended up pointing at three
// files that no longer exist (CLAUDE.full.md, CLAUDE.dev.md, CLAUDE.sa.md). So there is no
// catalog file to forget to update. The registry is assembled on every call from:
//
//   1. core-registry.mjs   — hooks + framework-core rules (framework territory)
//   2. every skill descriptor <skills tree>/<skill>/skill.yaml and
//      <parked tree>/<skill>/skill.yaml  — the rules extracted into skills. Both trees are named
//      once, in lib/sk-cli/skill-trees.mjs; SKILL_TREES below is that naming applied.
//
// The offloaded tree is scanned deliberately: AAP-93 includes the offloaded skills, and a
// retired skill's rule fragment must still be addressable (its hook may still be wired —
// hook.enforce-flow-headful is the live example).
//
// A skill that owns nothing ships no descriptor. Coverage is therefore DISCOVERED, never
// counted: nothing here hard-codes how many skills exist, and an external (non-Sidekicks)
// skill is excluded by construction because it ships no descriptor.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { SKILLS_ROOT_SEGMENTS, OFFLOAD_ROOT_SEGMENTS } from '../sk-cli/skill-trees.mjs';
import { parse } from '../yaml-subset/yaml.mjs';
import { isFloor } from './floor.mjs';
import { coreEntries } from './core-registry.mjs';
import { parseId } from './framework-config.mjs';

/**
 * The two skill trees a descriptor may live in, repo-relative and NATIVELY separated (these are
 * compared against and joined onto real paths, so they must carry `\` on Windows — which is why they
 * are built from the segment constants rather than the POSIX `*_REL` spellings).
 */
export const SKILL_TREES = Object.freeze([
  join(...SKILLS_ROOT_SEGMENTS),
  join(...OFFLOAD_ROOT_SEGMENTS),
]);

export const DESCRIPTOR_NAME = 'skill.yaml';

/**
 * List the descriptor files present, as repo-relative paths.
 *
 * @param {string} repoRoot
 * @returns {Array<{ skill: string, tree: string, relPath: string, absPath: string }>}
 */
export function discoverDescriptors(repoRoot) {
  const found = [];
  for (const tree of SKILL_TREES) {
    const treeAbs = join(repoRoot, tree);
    if (!existsSync(treeAbs)) continue;
    let entries;
    try {
      entries = readdirSync(treeAbs, { withFileTypes: true });
    } catch {
      continue; // an unreadable tree is not a registry error
    }
    for (const dirent of entries) {
      // A skill folder may be a real directory or (rarely) a link — accept both.
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
      const relPath = join(tree, dirent.name, DESCRIPTOR_NAME);
      const absPath = join(repoRoot, relPath);
      if (existsSync(absPath)) {
        found.push({ skill: dirent.name, tree, relPath, absPath });
      }
    }
  }
  found.sort((a, b) => a.skill.localeCompare(b.skill));
  return found;
}

/**
 * Parse and validate one descriptor.
 *
 * @param {{ skill: string, tree: string, relPath: string, absPath: string }} d
 * @returns {{
 *   skill: string, tree: string, relPath: string,
 *   rules: Array<{id: string, title: string, body: string|null}>,
 *   hooks: string[],
 *   config: object|null,
 *   configs: object[],
 * }}
 */
export function readDescriptor(d) {
  let text;
  try {
    text = readFileSync(d.absPath, 'utf8');
  } catch (err) {
    throw new SidekicksError(
      `framework: failed to read '${d.relPath}': ${err.message}`,
      EXIT_VALIDATION
    );
  }
  const obj = parse(text);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new SidekicksError(
      `framework: '${d.relPath}' top-level value must be a mapping`,
      EXIT_VALIDATION
    );
  }
  if (obj.skill !== undefined && obj.skill !== d.skill) {
    throw new SidekicksError(
      `framework: '${d.relPath}' declares skill '${obj.skill}' but lives in '${d.skill}/'`,
      EXIT_VALIDATION
    );
  }

  const rules = [];
  const rawRules = obj.rules === undefined || obj.rules === null ? [] : obj.rules;
  if (!Array.isArray(rawRules)) {
    throw new SidekicksError(
      `framework: '${d.relPath}' field 'rules' must be a list of entries`,
      EXIT_VALIDATION
    );
  }
  for (const entry of rawRules) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SidekicksError(
        `framework: '${d.relPath}' every 'rules' item must be a mapping with an id`,
        EXIT_VALIDATION
      );
    }
    const { kind } = parseId(entry.id); // validates shape
    if (kind === 'hook') {
      throw new SidekicksError(
        `framework: '${d.relPath}' declares '${entry.id}' under 'rules' — hook ids belong `
        + "under 'hooks' (hook scripts are framework-owned; see core-registry.mjs)",
        EXIT_VALIDATION
      );
    }
    rules.push({
      id: entry.id,
      title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : entry.id,
      body: typeof entry.body === 'string' && entry.body !== '' ? entry.body : null,
    });
  }

  const hooks = [];
  const rawHooks = obj.hooks === undefined || obj.hooks === null ? [] : obj.hooks;
  if (!Array.isArray(rawHooks)) {
    throw new SidekicksError(
      `framework: '${d.relPath}' field 'hooks' must be a list of hook ids`,
      EXIT_VALIDATION
    );
  }
  for (const hookId of rawHooks) {
    const { kind } = parseId(hookId);
    if (kind !== 'hook') {
      throw new SidekicksError(
        `framework: '${d.relPath}' field 'hooks' carries '${hookId}', which is not a hook id`,
        EXIT_VALIDATION
      );
    }
    hooks.push(hookId);
  }

  const configs = readConfigDeclarations(obj, d);
  const splitExempt = readSplitExemptions(obj, d);

  return {
    skill: d.skill,
    tree: d.tree,
    relPath: d.relPath,
    rules,
    hooks,
    // `config` is the FIRST declared block, kept for every caller written before a skill could
    // declare more than one (lib/skill-config/resolve.mjs, framework config, the audit checks).
    config: configs.length ? configs[0] : null,
    configs,
    settings_split: splitExempt,
  };
}

/**
 * Normalize `settings_split:` — the RECORDED JUDGMENTS behind the two split detectors.
 *
 * The detectors (lib/skill-lifecycle/settings-split.mjs) hunt what has not been declared yet, and
 * some of what they surface is deliberately not declarable: a hard stop that belongs to the safety
 * floor, a restatement of a rule the framework already owns, a required output shape, a constant
 * that only LOOKS like a knob. Without a home for those judgments the only ways to a clean report
 * are declaring a fake criterion or ignoring the notice — and the second is what happens.
 *
 * So an exemption is a first-class, reviewable record: it must carry the reason, and it is matched
 * by TEXT rather than by line number, so it survives an edit above it and lapses when the sentence
 * it excuses is rewritten. Both are the point — a reworded policy deserves a fresh look.
 *
 *   settings_split:
 *     policy_exempt:
 *       - quote: "Python is ALWAYS the repo-root"
 *         why: restates the framework's own Python rule — not this skill's policy
 *     tunable_exempt:
 *       - name: MAX_SKILL_NAME_LENGTH
 *         why: a limit the host CLI imposes, not a knob this repo may choose
 *
 * @param {object} obj - the parsed descriptor
 * @param {{ relPath: string }} d
 * @returns {{policy_exempt: Array<{quote: string, why: string}>,
 *            tunable_exempt: Array<{name: string, why: string}>}}
 */
function readSplitExemptions(obj, d) {
  const empty = { policy_exempt: [], tunable_exempt: [] };
  const raw = obj.settings_split;
  if (raw === undefined || raw === null) return empty;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SidekicksError(
      `framework: '${d.relPath}' field 'settings_split' must be a mapping`,
      EXIT_VALIDATION
    );
  }
  /** @param {string} field @param {string} key - the identifying field of an entry */
  const list = (field, key) => {
    const items = raw[field] === undefined || raw[field] === null ? [] : raw[field];
    if (!Array.isArray(items)) {
      throw new SidekicksError(
        `framework: '${d.relPath}' settings_split.${field} must be a list of exemptions`,
        EXIT_VALIDATION
      );
    }
    return items.map((entry, i) => {
      const where = `settings_split.${field}[${i}]`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new SidekicksError(
          `framework: '${d.relPath}' ${where} must be a mapping with '${key}' and 'why'`,
          EXIT_VALIDATION
        );
      }
      if (typeof entry[key] !== 'string' || entry[key].trim() === '') {
        throw new SidekicksError(
          `framework: '${d.relPath}' ${where}.${key} must name what is exempted`,
          EXIT_VALIDATION
        );
      }
      // The reason is REQUIRED. An exemption without one is indistinguishable from a suppression,
      // and a reviewer reading it a year later has no way to tell whether it still holds.
      if (typeof entry.why !== 'string' || entry.why.trim() === '') {
        throw new SidekicksError(
          `framework: '${d.relPath}' ${where}.why must state why this is not declarable — an `
          + 'exemption without a reason is a suppression',
          EXIT_VALIDATION
        );
      }
      // lib/yaml-subset does not fold a block scalar inside a SEQUENCE item: `why: >-` parses as the
      // literal string '>-' and its continuation lines then swallow the entry that follows. Caught
      // here because the silent form is worse than the loud one — the file looks right, the reason
      // reads as punctuation, and the next exemption vanishes.
      if (/^[>|][-+]?$/.test(entry.why.trim())) {
        throw new SidekicksError(
          `framework: '${d.relPath}' ${where}.why is a block scalar ('${entry.why.trim()}'), which `
          + 'this YAML subset does not fold inside a list item — write the reason on one line, in '
          + 'quotes',
          EXIT_VALIDATION
        );
      }
      return { [key]: entry[key], why: entry.why };
    });
  };
  return {
    policy_exempt: list('policy_exempt', 'quote'),
    tunable_exempt: list('tunable_exempt', 'name'),
  };
}

/** Optional per-block fields, with the value each falls back to when the descriptor omits it. */
const CONFIG_SCOPES = Object.freeze(new Set(['root', 'any', 'project']));
const CONFIG_MERGES = Object.freeze(new Set(['per_key', 'whole_block']));

/**
 * Normalize one `config:` entry.
 *
 * `family` names the file the block lives in inside a scope's `config/` directory; omitting it means
 * "a file of its own", which is the right answer for a block no other skill shares.
 *
 * @param {object} entry
 * @param {{ relPath: string }} d
 * @param {string} where - 'config' or 'config.blocks[N]', for the error message
 * @returns {{block: string, family: string|null, defaults: string|null, builtin: object|null,
 *            scope: string|null, inherits_root: boolean|null, merge: string|null, aliases: string[]}}
 */
function readConfigEntry(entry, d, where) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new SidekicksError(
      `framework: '${d.relPath}' ${where} must be a mapping`,
      EXIT_VALIDATION
    );
  }
  if (typeof entry.block !== 'string' || entry.block === '') {
    throw new SidekicksError(
      `framework: '${d.relPath}' ${where}.block must name the scope-config block the skill reads`,
      EXIT_VALIDATION
    );
  }
  if (entry.scope !== undefined && entry.scope !== null && !CONFIG_SCOPES.has(entry.scope)) {
    throw new SidekicksError(
      `framework: '${d.relPath}' ${where}.scope must be 'root', 'any' or 'project', `
      + `not '${entry.scope}'`,
      EXIT_VALIDATION
    );
  }
  if (entry.merge !== undefined && entry.merge !== null && !CONFIG_MERGES.has(entry.merge)) {
    throw new SidekicksError(
      `framework: '${d.relPath}' ${where}.merge must be 'per_key' or 'whole_block', `
      + `not '${entry.merge}'`,
      EXIT_VALIDATION
    );
  }
  if (entry.inherits_root !== undefined && entry.inherits_root !== null
    && typeof entry.inherits_root !== 'boolean') {
    throw new SidekicksError(
      `framework: '${d.relPath}' ${where}.inherits_root must be true or false`,
      EXIT_VALIDATION
    );
  }
  const aliases = entry.aliases === undefined || entry.aliases === null ? [] : entry.aliases;
  if (!Array.isArray(aliases)) {
    throw new SidekicksError(
      `framework: '${d.relPath}' ${where}.aliases must be a list of legacy block names`,
      EXIT_VALIDATION
    );
  }
  const publicKeys = entry.public_keys === undefined || entry.public_keys === null
    ? []
    : entry.public_keys;
  if (!Array.isArray(publicKeys)) {
    throw new SidekicksError(
      `framework: '${d.relPath}' ${where}.public_keys must be a list of key names that LOOK like `
      + 'credentials but are not (they and their subtrees stay in the committed file)',
      EXIT_VALIDATION
    );
  }
  return {
    block: entry.block,
    family: typeof entry.family === 'string' && entry.family !== '' ? entry.family : null,
    defaults: typeof entry.defaults === 'string' && entry.defaults !== '' ? entry.defaults : null,
    builtin: entry.builtin !== undefined && entry.builtin !== null
      && typeof entry.builtin === 'object' && !Array.isArray(entry.builtin)
      ? entry.builtin
      : null,
    scope: entry.scope ?? null,
    inherits_root: entry.inherits_root ?? null,
    merge: entry.merge ?? null,
    aliases: aliases.map(String),
    public_keys: publicKeys.map(String),
  };
}

/**
 * Every block a descriptor declares. Two accepted shapes:
 *
 *   config:                     # one block — the original shape, unchanged
 *     block: jira
 *     family: jira
 *     defaults: config.defaults.yaml
 *
 *   config:                     # several blocks owned by one skill
 *     blocks:
 *       - block: skill_manager
 *         family: skills
 *         defaults: config.defaults.yaml
 *       - block: skill_nickname
 *         family: skills
 *
 * A `blocks:` item must stay FLAT (no nested `builtin:`): lib/yaml-subset serializes a mapping
 * inside a sequence item by stringifying it, so a nested value there would not survive a rewrite.
 * A skill needing `builtin` uses the single-block form.
 *
 * @param {object} obj - the parsed descriptor
 * @param {{ relPath: string }} d
 * @returns {Array<ReturnType<typeof readConfigEntry>>}
 */
function readConfigDeclarations(obj, d) {
  if (obj.config === undefined || obj.config === null) return [];
  if (typeof obj.config !== 'object' || Array.isArray(obj.config)) {
    throw new SidekicksError(
      `framework: '${d.relPath}' field 'config' must be a mapping`,
      EXIT_VALIDATION
    );
  }
  if (obj.config.blocks !== undefined && obj.config.blocks !== null) {
    if (!Array.isArray(obj.config.blocks)) {
      throw new SidekicksError(
        `framework: '${d.relPath}' config.blocks must be a list of block declarations`,
        EXIT_VALIDATION
      );
    }
    if (obj.config.block !== undefined && obj.config.block !== null) {
      throw new SidekicksError(
        `framework: '${d.relPath}' declares both config.block and config.blocks — use one shape`,
        EXIT_VALIDATION
      );
    }
    const seen = new Set();
    return obj.config.blocks.map((entry, i) => {
      const parsed = readConfigEntry(entry, d, `config.blocks[${i}]`);
      if (seen.has(parsed.block)) {
        throw new SidekicksError(
          `framework: '${d.relPath}' declares block '${parsed.block}' twice`,
          EXIT_VALIDATION
        );
      }
      seen.add(parsed.block);
      return parsed;
    });
  }
  return [readConfigEntry(obj.config, d, 'config')];
}

/**
 * Read every descriptor present.
 *
 * @param {string} repoRoot
 * @returns {Array<ReturnType<typeof readDescriptor>>}
 */
export function readDescriptors(repoRoot) {
  return discoverDescriptors(repoRoot).map(readDescriptor);
}

/**
 * Build the merged registry.
 *
 * @param {string} repoRoot
 * @returns {{
 *   entries: Array<{id: string, kind: string, title: string, owners: string[], body_at: string|null, body_marker: string|null, script: string|null, floor: boolean, source: string}>,
 *   byId: Map<string, object>,
 *   descriptors: Array<ReturnType<typeof readDescriptor>>,
 * }}
 */
export function buildRegistry(repoRoot) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const entry of coreEntries()) byId.set(entry.id, entry);

  const descriptors = readDescriptors(repoRoot);
  for (const d of descriptors) {
    for (const rule of d.rules) {
      const existing = byId.get(rule.id);
      if (existing && existing.source === 'core') {
        throw new SidekicksError(
          `framework: '${d.relPath}' redeclares '${rule.id}', which is a framework-core `
          + 'entry (its body stays in AGENTS.md) — remove it from the descriptor',
          EXIT_VALIDATION
        );
      }
      if (existing) {
        // Two skills co-own one rule: one canonical body, every owner recorded.
        if (!existing.owners.includes(d.skill)) existing.owners.push(d.skill);
        if (!existing.body_at && rule.body) {
          existing.body_at = join(d.tree, d.skill, rule.body);
        }
        continue;
      }
      byId.set(rule.id, {
        id: rule.id,
        kind: parseId(rule.id).kind,
        title: rule.title,
        owners: [d.skill],
        body_at: rule.body ? join(d.tree, d.skill, rule.body) : null,
        // A skill-owned body is a whole FILE inside the skill folder, so its existence is already a
        // real check — there is nothing to address inside it. Only framework-core rules, which share
        // one AGENTS.md, need a marker to distinguish "the file is there" from "the rule is there".
        body_marker: null,
        script: null,
        floor: isFloor(rule.id),
        source: 'skill',
      });
    }
    for (const hookId of d.hooks) {
      const entry = byId.get(hookId);
      if (!entry) {
        throw new SidekicksError(
          `framework: '${d.relPath}' claims hook '${hookId}', which is not a registered `
          + 'framework hook (hooks are declared in lib/framework-settings/core-registry.mjs)',
          EXIT_VALIDATION
        );
      }
      if (!entry.owners.includes(d.skill)) entry.owners.push(d.skill);
    }
  }

  const entries = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { entries, byId, descriptors };
}

// ---------------------------------------------------------------------------
// Wiring cross-check inputs (used by `framework doctor`)
// ---------------------------------------------------------------------------

/** Per-CLI config files that wire hooks, repo-relative (Rule 6). */
export const HOOK_CONFIGS = Object.freeze([
  join('.claude', 'settings.json'),
  join('.codex', 'config.toml'),
  join('.gemini', 'settings.json'),
  join('.agent', 'settings.json'),
]);

/**
 * Hook scripts actually wired in a per-CLI config, as repo-relative paths.
 *
 * Text-scanned on purpose: the four configs are three different formats (JSON, TOML, JSON),
 * and every one of them references a hook the same way — by its path.
 *
 * Returns POSIX-form paths ('scripts/run-notify-hook.mjs'), matching how every config
 * spells them on every OS — compare against `posixScript()`, never a join()ed path.
 *
 * @param {string} repoRoot
 * @param {string} [config] - repo-relative config to scan (default: .claude/settings.json,
 *                            the canonical authoring surface per Rule 6)
 * @returns {string[]} sorted, de-duplicated
 */
export function wiredHookScripts(repoRoot, config = HOOK_CONFIGS[0]) {
  const abs = join(repoRoot, config);
  if (!existsSync(abs)) return [];
  const text = readFileSync(abs, 'utf8');
  const found = new Set();
  // Every wired hook path, including one this registry does not know about — an
  // unregistered wired hook is precisely the drift the doctor must report.
  for (const m of text.matchAll(/(?:scripts|\.sidekicks\/hooks)\/[A-Za-z0-9._-]+\.(?:mjs|sh)/g)) {
    found.add(m[0]);
  }
  return [...found].sort();
}

/**
 * A repo-relative path in the POSIX form the per-CLI configs use.
 *
 * @param {string} relPath
 * @returns {string}
 */
export function posixScript(relPath) {
  return relPath.split('\\').join('/');
}
