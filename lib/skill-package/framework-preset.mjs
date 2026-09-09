// lib/skill-package/framework-preset.mjs
// Dynamic composition for sk-inherit's `framework` preset.
//
// Runtime disposition lives with each skill, while dependency edges live in SKILL.md frontmatter
// and skill.manifest.yaml. Keeping the resolver here gives forge/publish consumers one answer and
// avoids teaching each script a subtly different parser.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../yaml-subset/yaml.mjs';
import {
  discoverSkills,
  readFrontmatterDependsOn,
  readSkillManifest,
  readSkillRuntimeClass,
} from '../skill-manifest/read.mjs';

const byteSort = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function destinationIntent(entry) {
  const path = join(entry.dir, 'skill.yaml');
  if (!existsSync(path)) return { value: null, error: null };
  try {
    const value = parse(readFileSync(path, 'utf8'))?.skill_repo;
    return { value: typeof value === 'string' && value !== '' ? value : null, error: null };
  } catch (err) {
    return { value: null, error: `skill '${entry.skill}' publication intent is unreadable (${err.message})` };
  }
}

function hasBundledLicense(entry) {
  try {
    return readdirSync(entry.dir).some((name) => name.toLowerCase() === 'license.txt');
  } catch {
    return false;
  }
}

/**
 * Resolve the public framework runtime from active per-skill declarations and hard dependencies.
 * Errors are returned (rather than thrown) so a plan command can render every composition problem
 * in one pass and then fail closed.
 *
 * @param {string} repoRoot
 * @param {{requiredFloor?: string[]}} [opts]
 * @returns {{selected: string[], reasons: Record<string, string[]>, errors: string[]}}
 */
export function resolveFrameworkPreset(repoRoot, opts = {}) {
  const discovered = discoverSkills(repoRoot);
  const active = new Map(discovered.filter((entry) => !entry.offloaded).map((entry) => [entry.skill, entry]));
  const offloaded = new Set(discovered.filter((entry) => entry.offloaded).map((entry) => entry.skill));
  const errors = new Set();
  const chosen = new Map();
  const queue = [];
  const intents = new Map();

  const runtimeClass = (entry) => {
    try {
      return readSkillRuntimeClass(entry);
    } catch (err) {
      errors.add(String(err?.message || err));
      return null;
    }
  };
  const intent = (entry) => {
    if (!intents.has(entry.skill)) intents.set(entry.skill, destinationIntent(entry));
    const read = intents.get(entry.skill);
    if (read.error) errors.add(read.error);
    return read.value;
  };
  const restricted = (entry) => {
    const klass = runtimeClass(entry);
    if (klass === null) return 'invalid runtime class';
    if (klass === 'source-only') return 'runtime-class source-only';
    if (intent(entry) === 'private') return 'publication intent private';
    return null;
  };
  const select = (name, reason) => {
    if (!chosen.has(name)) {
      chosen.set(name, new Set());
      queue.push(name);
    }
    chosen.get(name).add(reason);
  };

  // Runtime metadata is validated for every active skill: a typo must not silently hide a root.
  for (const entry of [...active.values()].sort((a, b) => byteSort(a.skill, b.skill))) {
    const klass = runtimeClass(entry);
    if (klass !== 'framework') continue;
    const publication = intent(entry);
    if (publication === 'private') continue;
    if (publication === 'none' && !hasBundledLicense(entry)) {
      errors.add(
        `framework root '${entry.skill}' is not publishable (skill_repo: none without license.txt)`
      );
      continue;
    }
    select(entry.skill, 'declared');
  }

  for (const name of [...new Set(opts.requiredFloor || [])].sort(byteSort)) {
    const entry = active.get(name);
    if (!entry) {
      errors.add(offloaded.has(name)
        ? `required-floor skill '${name}' is offloaded`
        : `required-floor skill '${name}' is missing`);
      continue;
    }
    const why = restricted(entry);
    if (why) {
      errors.add(`required-floor skill '${name}' is not publishable (${why})`);
      continue;
    }
    select(name, 'required-floor');
  }

  while (queue.length) {
    const name = queue.shift();
    const entry = active.get(name);
    const dependencies = new Set(readFrontmatterDependsOn(entry));
    let read = null;
    try {
      read = readSkillManifest(repoRoot, entry);
    } catch (err) {
      errors.add(`skill '${name}' manifest is unreadable (${err.message})`);
    }
    for (const error of read?.errors || []) errors.add(error);
    if (read?.manifest) {
      for (const row of read.manifest.requires?.sibling_skills || []) {
        if (row.optional === true || (row.scope || 'runtime') === 'test') continue;
        if (typeof row.skill === 'string' && row.skill !== '') dependencies.add(row.skill);
      }
    }

    for (const dependency of [...dependencies].sort(byteSort)) {
      const target = active.get(dependency);
      if (!target) {
        errors.add(offloaded.has(dependency)
          ? `'${name}' requires offloaded skill '${dependency}'`
          : `'${name}' requires missing skill '${dependency}'`);
        continue;
      }
      const why = restricted(target);
      if (why) {
        errors.add(`'${name}' requires '${dependency}', which is not publishable (${why})`);
        continue;
      }
      if (intent(target) === 'none' && !hasBundledLicense(target)) {
        errors.add(
          `'${name}' requires '${dependency}', which declares skill_repo: none without license.txt`
        );
        continue;
      }
      select(dependency, `dependency-of:${name}`);
    }
  }

  const selected = [...chosen.keys()].sort(byteSort);
  const reasons = {};
  for (const name of selected) reasons[name] = [...chosen.get(name)].sort(byteSort);
  return { selected, reasons, errors: [...errors].sort(byteSort) };
}
