// lib/skill-lifecycle/advise.mjs
// `sidekicks skill advise <skill>… [--from <path>] [--json]`
//
// "What else do I need before this skill works?"
//
// Three sources, in descending authority, and KEPT SEPARATE — because they disagree on purpose:
//
//   1. requires.sibling_skills   AUTHORITATIVE. Carries `how:`, `scope:` and `degraded:`, and
//                                `degraded:` is the only field that says what is LOST without it.
//   2. frontmatter depends-on    A MIRROR, already kept honest by the depends-on-divergence error.
//                                A cross-check, never a second source.
//   3. the scanner's tiers       UNDECLARED edges. `wired` is a real edge someone forgot to
//                                declare; `code-comment` is usually a provenance note; `prose` is a
//                                "see also" and NOT a dependency.
//
// Flattening those into one list is the failure mode this verb exists to avoid: it would promote a
// prose "see also" to a hard requirement, and demote a `degraded:` sentence to a bullet.
//
// With `--from <path>` it also answers the actual operational question — is the missing sibling
// AVAILABLE in the skills repository — by reading that tree's generated `catalog.yaml` rather than
// cloning 84 folders to find out.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION, EXIT_USAGE, SidekicksError } from '../sk-cli/errors.mjs';
import { discoverSkills, readFrontmatterDependsOn } from '../skill-manifest/read.mjs';
import { skillClosure } from '../skill-package/closure.mjs';
import { auditSkills } from './audit.mjs';
import { parse } from '../yaml-subset/yaml.mjs';
import { parseSkillFlags, positionalArgs } from './_shared.mjs';

/** The scanner findings that name an UNDECLARED sibling edge, with their confidence. */
const UNDECLARED_CHECKS = Object.freeze({
  'undeclared-skill': 'wired',
  'skill-named-in-comment': 'code-comment',
});

/** Skills available in a skills-repository tree, from its generated catalog. */
export function readCatalog(fromRoot) {
  const abs = join(fromRoot, 'catalog.yaml');
  if (!existsSync(abs)) return null;
  let obj;
  try { obj = parse(readFileSync(abs, 'utf8')); } catch { return null; }
  if (!obj || !Array.isArray(obj.skills)) return null;
  return new Map(obj.skills.map((s) => [s.name, s]));
}

/** The audit group each skill sits in — the family answer, and the bmad detector. */
export function skillGroups(repoRoot) {
  const abs = join(
    repoRoot, '.agents', 'skills', 'sk-skill-auditor', 'assets', 'audit-groups.yaml'
  );
  const byName = new Map();
  if (!existsSync(abs)) return byName;
  let current = null;
  for (const raw of readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s+-\s+(\S+)/);
    if (item) {
      // `single` is a reserved rotating cursor, not a family — its member's real group wins.
      if (current && current !== 'single' && !byName.has(item[1])) byName.set(item[1], current);
      continue;
    }
    const header = line.match(/^\s+([a-z][a-z0-9-]*):\s*$/);
    if (header) { current = header[1]; continue; }
    if (/^\S/.test(line)) current = null;
  }
  return byName;
}

/**
 * Advise on one or more skills. Pure.
 *
 * @param {string} repoRoot
 * @param {string[]} names
 * @param {{catalog?: Map<string,object>|null}} [opts]
 */
export function advisePlan(repoRoot, names, opts = {}) {
  const all = discoverSkills(repoRoot);
  const present = new Set(all.map((e) => e.skill));
  const byName = new Map(all.map((e) => [e.skill, e]));
  const groups = skillGroups(repoRoot);
  const catalog = opts.catalog || null;

  // The scanner is consulted ONCE for the whole run, not per skill — auditSkills() walks every
  // skill's files to build its module-owner index, and calling it in a loop would repeat that.
  const findings = auditSkills(repoRoot, {}).findings;

  const out = [];
  for (const name of names) {
    const entry = byName.get(name);
    const closure = skillClosure(repoRoot, [name]);

    // Direct declared edges only — the transitive rest is `required_transitive` below, because
    // "what does X need" and "what will come along with it" are different questions.
    const direct = closure.edges.filter((e) => e.from === name);
    const required = direct.map((e) => ({
      skill: e.to,
      how: e.how,
      scope: e.scope,
      degraded: e.degraded,
      present: present.has(e.to),
      offloaded: present.has(e.to) ? Boolean(byName.get(e.to).offloaded) : false,
      available_in_catalog: catalog ? catalog.has(e.to) : null,
    }));

    const transitive = closure.selected
      .map((s) => s.skill)
      .filter((s) => s !== name && !required.some((r) => r.skill === s));

    const mirror = readFrontmatterDependsOn(entry || { dir: '' });
    const declared = new Set(required.map((r) => r.skill));
    const mirror_only = mirror.filter((d) => !declared.has(d));

    const consider = findings
      .filter((f) => f.skill === name && UNDECLARED_CHECKS[f.check])
      .map((f) => ({ confidence: UNDECLARED_CHECKS[f.check], detail: f.detail }));

    out.push({
      skill: name,
      group: groups.get(name) || null,
      required,
      required_transitive: transitive,
      mirror_only,
      consider,
      non_healable: {
        framework_files: closure.framework_files.map((f) => f.path),
        framework_hooks: closure.framework_hooks.map((h) => h.id),
        host_paths: closure.host_paths.map((h) => ({ path: h.path, degraded: h.degraded })),
        binaries: closure.binaries.map((b) => b.name),
      },
      // The bmad family arrives as CLI PLUGIN skills (bmad:bmm:agents:pm, …). Nothing under
      // .agents/skills/ provides them and no scanner can see them, so this is answered from
      // group membership and the name — never by probing a directory that would not be there.
      needs_bmad: groups.get(name) === 'bmad' || /^sk-bmad-/.test(name),
    });
  }
  return out;
}

/**
 * Run `skill advise`.
 *
 * @param {{repoRoot: string, argv: string[]}} ctx
 */
export async function run(ctx) {
  const flags = parseSkillFlags(ctx.argv, ['json']);
  const names = positionalArgs(ctx.argv, ['from']);
  if (!names.length) {
    throw new SidekicksError(
      "skill advise: name at least one skill (run 'sidekicks skill list')",
      EXIT_USAGE
    );
  }

  const known = new Set(discoverSkills(ctx.repoRoot).map((s) => s.skill));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length) {
    throw new SidekicksError(
      `skill advise: unknown skill(s): ${unknown.join(', ')} — run 'sidekicks skill list'`,
      EXIT_VALIDATION
    );
  }

  let catalog = null;
  let catalogNote = null;
  if (typeof flags.from === 'string' && flags.from) {
    const fromRoot = resolve(String(flags.from));
    catalog = readCatalog(fromRoot);
    if (!catalog) {
      catalogNote = `no readable catalog.yaml under ${fromRoot} — availability not checked`;
    }
  }

  const rows = advisePlan(ctx.repoRoot, names, { catalog });
  const bmadRepo = 'https://github.com/bmad-code-org/BMAD-METHOD.git';

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        ok: true, catalog: Boolean(catalog), catalog_note: catalogNote,
        bmad_repo: rows.some((r) => r.needs_bmad) ? bmadRepo : null,
        skills: rows,
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const out = [];
  for (const r of rows) {
    out.push(`${r.skill}${r.group ? `  [${r.group} family]` : ''}`);

    if (r.required.length) {
      out.push('  required (declared, authoritative)');
      for (const s of r.required) {
        const state = !s.present
          ? (s.available_in_catalog === true ? 'MISSING — in the skills repo'
            : (s.available_in_catalog === false ? 'MISSING — not in the skills repo either' : 'MISSING'))
          : (s.offloaded ? 'offloaded' : 'present');
        out.push(`    ${s.skill.padEnd(38)} ${state.padEnd(32)} ${s.how}${s.scope === 'test' ? ' (test scope)' : ''}`);
        if (!s.present && s.degraded) out.push(`        without it: ${s.degraded}`);
        if (!s.present) {
          out.push(s.offloaded
            ? '        -> restore it with sk-skill-offload'
            : `        -> sidekicks skill import ${s.skill} --from <skills-repo>`);
        }
      }
    } else {
      out.push('  required: none declared');
    }

    if (r.required_transitive.length) {
      out.push(`  comes along transitively: ${r.required_transitive.join(', ')}`);
    }
    if (r.mirror_only.length) {
      // Should be impossible while depends-on-divergence is an error — surfaced anyway, because a
      // mirror that has drifted is exactly the case where the two sources disagree.
      out.push(`  frontmatter names but the manifest does NOT: ${r.mirror_only.join(', ')}`);
    }
    if (r.consider.length) {
      out.push('  consider (detected in code, not declared)');
      for (const c of r.consider) out.push(`    [${c.confidence}] ${c.detail}`);
    }

    const nh = r.non_healable;
    if (nh.framework_files.length || nh.framework_hooks.length || nh.host_paths.length || nh.binaries.length) {
      out.push('  cannot be installed — state the cost, do not work around it');
      for (const p of nh.framework_files) out.push(`    framework file  ${p}`);
      for (const h of nh.framework_hooks) out.push(`    hook            ${h}  (wiring in 4 CLI configs — Rule 6)`);
      for (const h of nh.host_paths) out.push(`    host path       ${h.path}${h.degraded ? ` — ${h.degraded}` : ''}`);
      for (const b of nh.binaries) out.push(`    binary          ${b}`);
    }

    if (r.needs_bmad) {
      out.push('  bmad family: the agents and workflows are CLI PLUGIN skills, not files under');
      out.push(`    .agents/skills/ — install them yourself: git clone ${bmadRepo}`);
    }
    out.push('');
  }
  if (catalogNote) out.push(catalogNote);

  return { stdout: out.join('\n'), exitCode: EXIT_OK };
}
