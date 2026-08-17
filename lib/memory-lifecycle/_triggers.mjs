// lib/memory-lifecycle/_triggers.mjs
// The category TRIGGER REGISTRY: what kind of action pulls which scenario pack.
//
// NOT a dispatchable verb (leading underscore).
//
// Two layers, resolved highest-first:
//   1. `.sidekicks/memory/triggers.yaml` — the store's own committed overlay, written
//      by `sidekicks memory triggers` (Rule 1 — never hand-edited).
//   2. BUNDLED_TRIGGERS below — the framework's shipped defaults.
// A category present in both takes the store's definition WHOLE (not key-merged): a
// half-overridden trigger set is the shape where an operator removes a skill from a
// list and it silently comes back from the defaults.
//
// Matching is deliberately dumb and deterministic — glob-free prefix/suffix wildcards
// and substring keyword tests. A trigger that needs a regex is a trigger nobody can
// predict the behaviour of at 3am.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import * as yaml from '../yaml-subset/yaml.mjs';
import { triggersPath } from '../active-scope/memory-paths.mjs';

/**
 * Shipped defaults. Skills are matched with a single trailing `*` wildcard; verbs are
 * matched against the `sidekicks <verb>` namespace; keywords are substring tests over
 * the raw command, and exist for CLIs whose hook payload carries no structured skill
 * name.
 */
export const BUNDLED_TRIGGERS = Object.freeze({
  database: {
    skills: [
      'sk-database-*',
      'sk-teleport-database-*',
      'sk-safe-data-importer',
      'sk-shp-*',
    ],
    verbs: ['database'],
    keywords: ['psql', 'pg_dump', 'pg_restore'],
  },
  cluster: {
    skills: ['sk-cluster-ops', 'sk-teleport-cluster-ops'],
    verbs: [],
    keywords: ['kubectl', 'tsh kube', 'helm '],
  },
  implementation: {
    skills: [
      'sk-bmad-*',
      'sk-get-plan-done',
      'sk-implementation-planner',
      'sk-service-*',
    ],
    verbs: ['service'],
    keywords: [],
  },
  jira: {
    skills: ['sk-jira-*', 'sk-get-jira-done', 'sk-is-jira-done'],
    verbs: [],
    keywords: [],
  },
  deploy: {
    skills: ['sk-commander', 'sk-git-ship', 'sk-release-notes'],
    verbs: [],
    keywords: ['docker build', 'kubectl apply'],
  },
  agents: {
    skills: ['sk-agent-*', 'sk-loop-fleet', 'sk-squad'],
    verbs: ['agent', 'journal'],
    keywords: [],
  },
  framework: {
    skills: ['sk-framework-*', 'sk-skill-*', 'skill-creator', 'sk-parity-keeper'],
    verbs: ['framework', 'skill', 'config'],
    keywords: [],
  },
});

/**
 * Read the store's trigger overlay, or null when there is none.
 * A missing overlay is never an error — the bundled defaults are the whole answer.
 *
 * @param {string} repoRoot
 * @returns {object|null}
 */
export function readTriggerOverlay(repoRoot) {
  const abs = triggersPath(repoRoot);
  if (!existsSync(abs)) return null;
  try {
    const parsed = yaml.parse(readFileSync(abs, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // A corrupt overlay must not wedge every triggered action — fall back to defaults.
    return null;
  }
}

/**
 * The effective trigger registry: bundled defaults with the store's overlay replacing
 * whole categories.
 *
 * @param {string} repoRoot
 * @returns {Record<string, {skills: string[], verbs: string[], keywords: string[]}>}
 */
export function resolveTriggers(repoRoot) {
  const out = {};
  for (const [cat, def] of Object.entries(BUNDLED_TRIGGERS)) {
    out[cat] = { skills: [...def.skills], verbs: [...def.verbs], keywords: [...def.keywords] };
  }
  const overlay = readTriggerOverlay(repoRoot);
  if (overlay) {
    for (const [cat, def] of Object.entries(overlay)) {
      if (!def || typeof def !== 'object') continue;
      out[cat] = {
        skills: Array.isArray(def.skills) ? def.skills.map(String) : [],
        verbs: Array.isArray(def.verbs) ? def.verbs.map(String) : [],
        keywords: Array.isArray(def.keywords) ? def.keywords.map(String) : [],
      };
    }
  }
  return out;
}

/**
 * Does `value` match `pattern`? Supports ONE leading and/or trailing `*`; no other
 * metacharacter is special, so a literal pattern is always safe to write.
 *
 * @param {string} pattern
 * @param {string} value
 * @returns {boolean}
 */
export function matchesPattern(pattern, value) {
  const p = String(pattern);
  const v = String(value);
  const starts = p.startsWith('*');
  const ends = p.endsWith('*');
  const core = p.slice(starts ? 1 : 0, ends ? p.length - 1 : p.length);
  if (core === '') return true;
  if (starts && ends) return v.includes(core);
  if (ends) return v.startsWith(core);
  if (starts) return v.endsWith(core);
  return v === core;
}

/**
 * Which categories does an action fire? Returns every match, in registry order — an
 * action can legitimately be both a database action and a deploy action, and choosing
 * one for the caller would silently drop half the rules that apply.
 *
 * @param {object} triggers - from resolveTriggers()
 * @param {{ skill?: string|null, command?: string|null }} action
 * @returns {string[]} category names
 */
export function categoriesFor(triggers, { skill = null, command = null } = {}) {
  const out = [];
  const cmd = command ? String(command) : '';
  // `sidekicks <verb>` / `node bin/sidekicks <verb>` — the namespace is what a verb
  // trigger names, so pull it out rather than substring-matching the whole line.
  const verbMatch = /(?:^|[\s/])(?:sidekicks)\s+([a-z][a-z-]*)/.exec(cmd);
  const verb = verbMatch ? verbMatch[1] : null;

  for (const [cat, def] of Object.entries(triggers)) {
    let hit = false;
    if (skill) hit = def.skills.some((p) => matchesPattern(p, skill));
    if (!hit && verb) hit = def.verbs.includes(verb);
    if (!hit && cmd) hit = def.keywords.some((k) => cmd.toLowerCase().includes(String(k).toLowerCase()));
    if (hit) out.push(cat);
  }
  return out;
}
