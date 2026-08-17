// lib/skill-package/adopt.mjs
// Converting a foreign skill folder into one this framework can carry — as a PLAN, never as a write.
//
// WHAT CONVERSION IS NOT. It is tempting to have an importer "fix up" an upstream skill: write it a
// skill.yaml, stamp a VERSION.json, generate a manifest, drop it into an audit group. Every one of
// those is refused here, for two different reasons:
//
//   1. POLICY IS NOT DERIVABLE. `rules:`, `hooks:` and `config:` in a skill.yaml are claims about
//      what THIS repo enforces. An importer inventing them would turn somebody else's folder into
//      local policy that nobody decided. Worse, an otherwise-empty descriptor flips
//      manifestRequired(scan, hasDescriptor=true) to true (scan.mjs), forcing a ceremonial manifest
//      onto a skill that needs none.
//   2. AN EDIT COSTS BYTE-EXACTNESS. The folder is copied verbatim, so a later re-import from the
//      same upstream reconciles as `up-to-date` instead of as a permanent conflict, and so the
//      recorded provenance means something. Rewriting frontmatter to "correct" a name would make
//      every future import a conflict, forever.
//
// So conversion synthesizes nothing. What it does is READ the upstream metadata so the registration
// profile can record it, and turn everything a human must decide into ordered plan lines.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readSkillFrontmatter } from '../skill-manifest/read.mjs';
import { walkSkillFiles } from '../skill-lifecycle/scan.mjs';

/** Files at a source ROOT that carry licensing and cannot travel inside a skill folder. */
const ROOT_LICENCE = Object.freeze([
  'LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENCE', 'NOTICE', 'THIRD_PARTY_NOTICES.md',
]);

/** Licence-ish files INSIDE a skill folder, which do travel because they are folder content. */
const CARRIED_LICENCE = /^(LICEN[CS]E|NOTICE|COPYING)(\.[A-Za-z0-9]+)?$/i;

/**
 * What adopting one foreign skill involves.
 *
 * Pure: reads the source folder, writes nothing, decides nothing a human owns.
 *
 * @param {string} fromRoot - the source tree root
 * @param {object} entry - a readSource() entry
 * @returns {{skill: string, warnings: string[], carries: string[], steps: string[], facts: object}}
 */
export function adoptionPlan(fromRoot, entry) {
  const fm = readSkillFrontmatter(entry);
  const files = walkSkillFiles(entry.dir);
  const warnings = [];
  const carries = [];
  const steps = [];

  // ── Metadata: reported, never corrected ──────────────────────────────────────────────────────
  if (!fm.present) {
    warnings.push(
      `${entry.skill}: SKILL.md has no frontmatter — no CLI will match this skill on a description`
    );
  } else {
    if (fm.name === null) warnings.push(`${entry.skill}: SKILL.md declares no 'name:'`);
    else if (fm.name !== entry.skill) {
      warnings.push(
        `${entry.skill}: SKILL.md says name: '${fm.name}' but the folder is '${entry.skill}' — `
        + 'the FOLDER name wins here (discovery keys on it); the file is copied unedited'
      );
    }
    if (!fm.description) {
      warnings.push(`${entry.skill}: SKILL.md declares no 'description:' — nothing will trigger it`);
    }
  }

  // ── Python: surfaced, never installed ────────────────────────────────────────────────────────
  const py = files.filter((f) => f.rel.endsWith('.py'));
  const reqTxt = files.find((f) => f.rel === 'requirements.txt');
  if (py.length) {
    steps.push(
      `${entry.skill}: derive its python dependencies — 'sidekicks skill manifest ${entry.skill} `
      + "--apply' writes requires.python with TODO markers; answer those, then 'sidekicks skill "
      + `heal ${entry.skill} --apply' installs them into the single repo-root .venv (it will NOT `
      + 'create the .venv — that is yours: python3 -m venv .venv)'
    );
  }
  if (reqTxt) {
    const body = safeRead(reqTxt.abs);
    carries.push('requirements.txt (its pins WIN over the derived package list at heal time)');
    if (/^\s*-r\s+\.\./m.test(body)) {
      warnings.push(
        `${entry.skill}: requirements.txt reaches outside the skill folder (-r ../…) — the folder `
        + 'is not liftable as-is and skill doctor will report requirements-escapes-skill'
      );
    }
  }

  // ── Licensing: what travelled, and what could not ────────────────────────────────────────────
  for (const f of files) {
    if (CARRIED_LICENCE.test(f.rel.split('/').pop() || '')) carries.push(f.rel);
  }
  const rootLicences = ROOT_LICENCE.filter((n) => existsSync(join(fromRoot, n)));
  if (rootLicences.length) {
    steps.push(
      `${entry.skill}: the source root carries ${rootLicences.join(', ')}, which did NOT travel — `
      + 'import writes nothing outside .sidekicks/. Carry or reference it by hand'
    );
  }
  if (fm.license) {
    steps.push(`${entry.skill}: upstream declares license '${fm.license}' — record it where your repo records attribution`);
  } else if (!carries.length && !rootLicences.length) {
    warnings.push(`${entry.skill}: no licence found upstream, in the folder or at the source root`);
  }

  // ── Republication is a decision, not a default ───────────────────────────────────────────────
  steps.push(
    `${entry.skill}: decide whether a skill you did not write is yours to republish — `
    + `'skill_repo: none' in .agents/skills/${entry.skill}/skill.yaml withholds it from every `
    + 'configured destination'
  );

  return {
    skill: entry.skill,
    warnings,
    carries: [...new Set(carries)].sort(),
    steps,
    facts: {
      upstream_name: fm.name,
      upstream_description: fm.description,
      upstream_version: fm.version,
      license: fm.license,
      layout: entry.layout,
      category: entry.category,
      upstream_path: entry.upstreamRel,
      file_count: files.length,
      has_scripts: files.some((f) => f.inScripts),
      python_files: py.length,
    },
  };
}

/** Read a file as text, or '' — a source we do not own may be unreadable for any number of reasons. */
function safeRead(abs) {
  try { return readFileSync(abs, 'utf8'); } catch { return ''; }
}

/**
 * Names at a plugin-marketplace root that hold their own skills subtrees.
 *
 * Used only to make the refusal message actionable when someone points `--from` at a marketplace
 * whose skills live one level further in. Never used to import: a plugin is commands, agents, hooks
 * and skills together, and `skill import` has standing over exactly one of those four.
 */
export function marketplacePlugins(fromRoot) {
  const out = [];
  for (const base of ['plugins', '.']) {
    let entries;
    try { entries = readdirSync(join(fromRoot, base), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const skills = join(fromRoot, base, e.name, 'skills');
      if (existsSync(skills)) out.push(`${base === '.' ? '' : `${base}/`}${e.name}/skills`);
    }
  }
  return [...new Set(out)].sort();
}
