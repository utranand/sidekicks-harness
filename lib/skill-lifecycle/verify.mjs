// lib/skill-lifecycle/verify.mjs
// `sidekicks skill verify [<skill>] [--json]`
//
// The INTEGRITY half of the gate, narrower than `doctor` on purpose: verify asks only "is what this
// skill declared actually present and unchanged", never "has everything been declared yet". That
// separation is what lets verify be a hard gate from day one while the declaration backfill is still
// draining through doctor's notices.
//
// It is also the verb that survives a lift: it reads a manifest and hashes files, so it needs no
// git, no framework registry and no network. A lifted skill can be verified; it cannot be healed.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { auditSkills } from './audit.mjs';
import { parseSkillFlags, findingLines } from './_shared.mjs';

// The integrity checks. Everything else doctor reports is an omission, not a break.
const INTEGRITY_CHECKS = Object.freeze(new Set([
  'manifest-invalid',
  'derived-drift',
  'bundle-stale',
  'declared-but-absent',
  'relative-cross-skill-import',
  'requirements-escapes-skill',
  'depends-on-divergence',
]));

/**
 * Run `skill verify`.
 *
 * @param {{repoRoot: string, argv: string[]}} ctx
 * @param {{name?: string}} args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, args) {
  const flags = parseSkillFlags(ctx.argv, ['json', 'strict']);
  const skill = args && args.name ? args.name : null;
  const { findings, skills, counts } = auditSkills(ctx.repoRoot, { skill });

  const relevant = findings.filter(
    (f) => INTEGRITY_CHECKS.has(f.check) && f.severity === 'error' && (flags.strict || !f.suppressed)
  );

  if (flags.json) {
    const payload = {
      ok: relevant.length === 0,
      checked: skills.length,
      with_manifest: counts.manifests,
      findings: relevant,
    };
    return {
      stdout: JSON.stringify(payload, null, 2) + '\n',
      exitCode: relevant.length ? EXIT_VALIDATION : EXIT_OK,
    };
  }

  if (relevant.length) {
    throw new SidekicksError(
      `skill verify: ${relevant.length} integrity problem(s)\n${findingLines(relevant).join('\n')}`,
      EXIT_VALIDATION
    );
  }

  const withBaseline = skills.filter((s) => s.bundle !== 'none').length;
  return {
    stdout: `skill verify: OK (${skills.length} skill(s) checked, ${withBaseline} with a hash baseline)\n`,
    exitCode: EXIT_OK,
  };
}
