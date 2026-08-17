// lib/skill-lifecycle/list.mjs
// `sidekicks skill list [--json] [--needs-manifest]`
//
// The inventory: every discovered skill, whether it needs a dependency manifest, whether it has one,
// and how many edges the scanner finds. Read-only.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { auditSkills } from './audit.mjs';
import { parseSkillFlags } from './_shared.mjs';

/**
 * Run `skill list`.
 *
 * @param {{repoRoot: string, argv: string[]}} ctx
 * @param {object} _args - unused
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, _args) {
  const flags = parseSkillFlags(ctx.argv, ['json', 'needs-manifest']);
  const { skills, counts } = auditSkills(ctx.repoRoot, {});

  let rows = skills;
  if (flags['needs-manifest']) {
    rows = rows.filter((s) => s.manifest_required && !s.manifest_present);
  }

  if (flags.json) {
    const payload = {
      counts,
      skills: rows.map((s) => ({
        skill: s.skill,
        tree: s.tree,
        offloaded: s.offloaded,
        manifest_required: s.manifest_required,
        manifest_present: s.manifest_present,
        descriptor: s.descriptor,
        bundle: s.bundle,
        detected: s.detected,
      })),
    };
    return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: EXIT_OK };
  }

  if (!rows.length) {
    return { stdout: 'skill list: nothing to show\n', exitCode: EXIT_OK };
  }

  const width = Math.max(...rows.map((s) => s.skill.length));
  const out = [];
  for (const s of rows) {
    const state = s.manifest_present
      ? `manifest (${s.bundle === 'none' ? 'no baseline' : s.bundle})`
      : (s.manifest_required ? 'MANIFEST NEEDED' : '-');
    const d = s.detected;
    const edges = [
      d.python ? `py:${d.python}` : null,
      d.node ? `node:${d.node}` : null,
      d.binaries ? `bin:${d.binaries}` : null,
      d.skills ? `skills:${d.skills}` : null,
      d.framework_files ? `fw:${d.framework_files}` : null,
    ].filter(Boolean).join(' ');
    out.push(`${s.skill.padEnd(width)}  ${state.padEnd(22)}  ${edges}`.trimEnd());
  }
  out.push('');
  out.push(
    `${counts.skills} skills · ${counts.required} need a manifest · ${counts.manifests} have one`
  );
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
