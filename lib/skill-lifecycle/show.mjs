// lib/skill-lifecycle/show.mjs
// `sidekicks skill show <skill> [--json]`
//
// One skill's dependency picture: what it DECLARES, what the scanner DETECTS, and the evidence
// (file:line) behind each detected edge. Read-only.
//
// The evidence matters more than the count: a `notice` a human cannot locate is a notice a human
// ignores, so every detected edge prints where it was found.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { readSkillManifest, MANIFEST_NAME } from '../skill-manifest/read.mjs';
import { auditSkills } from './audit.mjs';
import { parseSkillFlags, resolveTargets } from './_shared.mjs';

/**
 * Run `skill show`.
 *
 * @param {{repoRoot: string, argv: string[]}} ctx
 * @param {{name?: string}} args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, args) {
  const flags = parseSkillFlags(ctx.argv, ['json']);
  const [entry] = resolveTargets(ctx.repoRoot, args && args.name, {
    all: false,
    verb: 'skill show',
  });

  const { skills, findings } = auditSkills(ctx.repoRoot, { skill: entry.skill });
  const state = skills[0];
  const read = readSkillManifest(ctx.repoRoot, entry);
  const mine = findings.filter((f) => f.skill === entry.skill);

  if (flags.json) {
    const payload = {
      skill: entry.skill,
      path: entry.relDir,
      offloaded: entry.offloaded,
      manifest: {
        required: state.manifest_required,
        required_because: state.manifest_required_because,
        present: read.present,
        path: read.relPath,
        declared: read.manifest ? read.manifest.requires : null,
        bundle_entries: read.manifest ? Object.keys(read.manifest.bundle).length : 0,
        bundle: state.bundle,
      },
      detected: {
        python: state.scan.python,
        node: state.scan.node,
        binaries: state.scan.binaries,
        skills: state.scan.skills,
        framework_files: state.scan.frameworkFiles,
      },
      findings: mine,
    };
    return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: EXIT_OK };
  }

  const out = [`${entry.skill}  (${entry.relDir}${entry.offloaded ? ', offloaded' : ''})`];
  out.push('');
  out.push(`  ${MANIFEST_NAME}: ${read.present ? read.relPath : 'absent'}`);
  out.push(`  required:  ${state.manifest_required ? state.manifest_required_because.join('; ') : 'no'}`);
  out.push(`  files:     ${state.detected.files}${
    state.bundle === 'none' ? '' : ` (bundle baseline ${state.bundle})`}`);

  const section = (title, rows) => {
    if (!rows.length) return;
    out.push('');
    out.push(`  ${title}`);
    for (const line of rows) out.push(`    ${line}`);
  };

  if (read.manifest) {
    const r = read.manifest.requires;
    section('declared', [
      ...r.python.map((p) => `python  ${p.import} (pip: ${p.package})${p.optional ? ' [optional]' : ''}`),
      ...r.node.map((p) => `node    ${p.package}`),
      ...r.binaries.map((b) => `binary  ${b.name}${b.optional ? ' [optional]' : ''}`),
      ...r.sibling_skills.map((s) => `skill   ${s.skill} (${s.how})`),
      ...r.host_paths.map((h) => `host    ${h.path}`),
      ...r.framework_hooks.map((h) => `hook    ${h.id} -> ${h.script}`),
      ...(r.config ? [`config  block '${r.config.block}'`] : []),
    ]);
  }

  const s = state.scan;
  section('detected', [
    ...s.python.map((p) => `python  ${p.module} (pip: ${p.package})   ${p.evidence.file}:${p.evidence.line}`),
    ...s.node.map((p) => `node    ${p.package}   ${p.evidence.file}:${p.evidence.line}`),
    ...s.binaries.map((b) => `binary  ${b.name}   ${b.evidence.file}:${b.evidence.line}`),
    ...s.skills.map((x) => `skill   ${x.skill} (${x.how}, ${x.confidence}, by ${x.form}${x.testOnly ? ', tests only' : ''})   ${x.evidence.file}:${x.evidence.line}`),
    ...s.frameworkFiles.map((f) => `fw      ${f.path}   ${f.evidence.file}:${f.evidence.line}`),
  ]);

  section('findings', mine.map(
    (f) => `[${f.check}] ${f.severity}${f.suppressed ? ' (recorded)' : ''}: ${f.detail}`
  ));

  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
