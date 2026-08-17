// lib/skill-lifecycle/doctor.mjs
// `sidekicks skill doctor [<skill>] [--json] [--strict]`
//
// The dependency drift check. BOTH a verb and a CI gate — tests/skills/skill-doctor.test.mjs runs it
// against the real repo, so a new undeclared dependency fails CI instead of going unnoticed. Same
// arrangement as `framework doctor`, for the same reason: a catalog with no enforcement rots.
//
// `--strict` ignores the known-gaps ratchet, which is how you see the true backlog while it drains.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { MANIFEST_NAME } from '../skill-manifest/read.mjs';
import { auditSkills } from './audit.mjs';
import { parseSkillFlags, findingLines } from './_shared.mjs';

/**
 * Run `skill doctor`.
 *
 * @param {{repoRoot: string, argv: string[]}} ctx
 * @param {{name?: string}} args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, args) {
  const flags = parseSkillFlags(ctx.argv, ['json', 'strict']);
  const skill = args && args.name ? args.name : null;
  const { findings, counts } = auditSkills(ctx.repoRoot, { skill });

  const live = flags.strict ? findings : findings.filter((f) => !f.suppressed);
  const errors = live.filter((f) => f.severity === 'error');
  const notices = live.filter((f) => f.severity === 'notice');

  if (flags.json) {
    const payload = {
      ok: errors.length === 0,
      strict: Boolean(flags.strict),
      counts,
      findings: live,
    };
    const stdout = JSON.stringify(payload, null, 2) + '\n';
    // --json still exits non-zero, but the payload goes to stdout, not the error path.
    return { stdout, exitCode: errors.length ? EXIT_VALIDATION : EXIT_OK };
  }

  if (errors.length) {
    throw new SidekicksError(
      `skill doctor: ${errors.length} error(s), ${notices.length} notice(s)\n`
      + findingLines(errors).join('\n')
      + (notices.length ? `\n${findingLines(notices).join('\n')}` : ''),
      EXIT_VALIDATION
    );
  }

  const out = ['skill doctor: OK'];
  out.push(`  skills:      ${counts.skills} discovered, ${counts.audited} audited`);
  out.push(`  manifests:   ${counts.manifests} present, ${counts.required} required (${MANIFEST_NAME})`);
  out.push(`  findings:    0 errors, ${notices.length} notices${
    flags.strict ? '' : `, ${counts.suppressed} recorded in known-gaps.mjs`}`);
  if (notices.length) {
    out.push('');
    out.push(...findingLines(notices));
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
