// lib/scope-lifecycle/explain.mjs
// `sidekicks scope explain [--skill-id <id>] [--work-item <id>] [--json]`
//
// The read-only answer to "what is in effect HERE, and which layer decided it" — active scope, the
// three anchors, the resolved skill set, every framework entry's effective state, every configuration
// block's deciding layer, where the framework itself comes from, the registered executors, and the
// multi-CLI wiring — in one pass, from the resolvers that already own each answer (./explain-model.mjs
// documents the mapping, and why a second precedence implementation is the thing to avoid).
//
// EXIT CODES, and the distinction that makes them useful:
//   0  the report was produced and nothing in it is an error
//   1  the report was produced AND carries error-severity findings — the report is still on stdout,
//      so a caller reads WHY rather than just "it failed". Same convention `check run` uses: a bare 1
//      for "ran, and the answer is no", reserved apart from the SidekicksError codes.
//   2  the ARGUMENTS were invalid — nothing was inspected, so there is no report to read
//
// BOTH SPELLINGS OF EVERY VALUED FLAG WORK. The dispatcher's global parseArgs is `strict: false` with
// only the three global booleans declared, so `--skill-id sk-commander` reaches this verb as
// `{ 'skill-id': true }` plus a positional while `--skill-id=sk-commander` reaches it as a string.
// Re-reading ctx.argv in parseExplainArgs is what makes the space form work.
//
// THERE IS NO REVEAL FLAG, AND THERE IS NO CODE PATH THAT COULD ADD ONE. `config get` has `--reveal`
// because a caller asking for one block's value has already decided to look at it; a whole-workspace
// composition dump is the opposite situation, and one reveal flag on it would print every credential
// in the repo at once. So the flag is REJECTED rather than ignored — silently dropping it would let a
// caller believe it had been honoured — and the model never renders a value in the first place
// (./_shared.mjs § valueShape), so the guarantee does not depend on this check being reached.
//
// Zero npm dependencies — node:* + lib/ back-edges only; macOS + Windows.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { deepScrub, parseScopeFlags, positionalArgs } from './_shared.mjs';
import { buildExplainModel } from './explain-model.mjs';

/** Flags that never take a value. Everything else in this verb is valued. */
export const EXPLAIN_BOOLEANS = Object.freeze(['json', 'help', 'version', 'verbose']);

/** Flag spellings that would ask for a credential value. Rejected, never ignored (see header). */
const REVEAL_FLAGS = Object.freeze(['reveal', 'unmask', 'show-secrets', 'secrets', 'no-mask']);

/** "The report was produced, and the answer is no." Not a SidekicksError — the report is on stdout. */
const EXIT_FINDINGS = 1;

const USAGE = 'usage: sidekicks scope explain [--skill-id <id>] [--work-item <id>] [--json]';

/**
 * Read `scope explain`'s options out of a raw argv slice.
 *
 * @param {string[]} argv - ctx.argv (argv[0]/[1] are the namespace and verb)
 * @returns {{skillId: string|null, workItem: string|null, json: boolean}}
 * @throws {SidekicksError} EXIT_VALIDATION on an unexpected positional, a valueless --skill-id /
 *   --work-item, --work-item without --skill-id, or any reveal-shaped flag.
 */
export function parseExplainArgs(argv) {
  const flags = parseScopeFlags(argv, EXPLAIN_BOOLEANS);

  for (const name of REVEAL_FLAGS) {
    if (Object.hasOwn(flags, name)) {
      throw new SidekicksError(
        `scope explain: '--${name}' is not a flag of this verb — credential values are ALWAYS masked `
        + 'here, in every output mode, and no flag can change that. Read one block deliberately with '
        + "'sidekicks config get <block> --reveal' instead.\n" + USAGE,
        EXIT_VALIDATION,
      );
    }
  }

  const rest = positionalArgs(argv, EXPLAIN_BOOLEANS).slice(2);
  if (rest.length > 0) {
    throw new SidekicksError(
      `scope explain: unexpected argument '${rest[0]}' — the skill id is a FLAG value here `
      + `(--skill-id=<id>), not a positional\n${USAGE}`,
      EXIT_VALIDATION,
    );
  }

  const hasSkill = Object.hasOwn(flags, 'skill-id');
  const hasItem = Object.hasOwn(flags, 'work-item');

  // Checked before the value check, so `--work-item x` with no --skill-id says WHY it is wrong rather
  // than complaining about a value it would have refused to use anyway.
  if (hasItem && !hasSkill) {
    throw new SidekicksError(
      'scope explain: --work-item is only valid together with --skill-id — a work item names WHERE a '
      + "skill's run folder hangs, so there is no run base to resolve without the skill\n" + USAGE,
      EXIT_VALIDATION,
    );
  }

  const skillId = hasSkill ? flags['skill-id'] : null;
  if (hasSkill && (skillId === true || skillId === '')) {
    throw new SidekicksError(
      'scope explain: --skill-id needs a value (use --skill-id=<id> or --skill-id <id>)\n' + USAGE,
      EXIT_VALIDATION,
    );
  }
  const workItem = hasItem ? flags['work-item'] : null;
  if (hasItem && (workItem === true || workItem === '')) {
    throw new SidekicksError(
      'scope explain: --work-item needs a value (use --work-item=<id> or --work-item <id>)\n' + USAGE,
      EXIT_VALIDATION,
    );
  }

  return {
    skillId: typeof skillId === 'string' ? skillId : null,
    workItem: typeof workItem === 'string' ? workItem : null,
    json: Boolean(flags.json),
  };
}

/**
 * Build the report and render it.
 *
 * @param {string} repoRoot
 * @param {{skillId?: string|null, workItem?: string|null, json?: boolean}} [opts]
 * @returns {{stdout: string, exitCode: number}}
 */
export function explainScope(repoRoot, opts = {}) {
  const built = buildExplainModel(repoRoot, {
    skillId: opts.skillId ?? null,
    workItem: opts.workItem ?? null,
  });
  // The portable-path rule enforced once, on the MODEL, before either renderer runs: every path field
  // was already relativized by repoRel, and this catches anything that reached a MESSAGE from a lib
  // module or an FS error. Scrubbing here rather than the finished text is what keeps the JSON valid
  // on Windows, where a separator is escaped in the serialized form (./_shared.mjs § deepScrub).
  const model = deepScrub(built, repoRoot);
  return {
    stdout: opts.json ? `${JSON.stringify(model, null, 2)}\n` : renderHuman(model),
    exitCode: model.finding_counts.error > 0 ? EXIT_FINDINGS : EXIT_OK,
  };
}

/** '(none)' for an absent scalar, so a human line never reads `service:` with nothing after it. */
function or(value, fallback = '(none)') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

/** 'yes'/'no' — a boolean rendered the same way in every section. */
function yn(value) {
  return value === null || value === undefined ? '(unknown)' : value ? 'yes' : 'no';
}

/**
 * Render the report for a reader.
 *
 * PARITY IS THE CONTRACT, not an aspiration: every fact in the JSON appears here too, which is why
 * this walks the same arrays instead of summarizing them. `tests/scope-lifecycle/explain.test.mjs`
 * asserts it mechanically — every id, block, key, shape, name and finding in the JSON must be findable
 * in this text — so a field added to the model without a line here fails the suite.
 *
 * @param {object} m - the model from buildExplainModel
 * @returns {string}
 */
export function renderHuman(m) {
  const out = [];
  const a = m.active;
  const an = m.anchors;

  out.push('scope explain — effective composition');
  out.push(`  schema version:    ${m.schema_version}`);
  out.push(`  status:            ${m.ok ? 'OK' : `${m.finding_counts.error} error finding(s)`}`);
  out.push('');

  out.push('active scope');
  out.push(`  root project:      ${a.root_project}`);
  out.push(`  active project:    ${a.project}   path=${or(a.project_path, '(n/a)')}`);
  out.push(`  active service:    ${or(a.service)}   path=${or(a.service_path, '(n/a)')}`);
  out.push(`  service state:     ${or(a.service_state, '(n/a)')}`);
  out.push(`  settings file:     ${a.settings_file}   present=${yn(a.settings_present)}`);
  out.push('');

  out.push('anchors (repo-relative — no absolute path is ever reported)');
  out.push(`  working folder:    ${or(an.working_folder)}`);
  out.push(`  artifacts base:    ${or(an.artifacts_base)}`);
  out.push(`  runs root:         ${or(an.runs_root)}`);
  out.push(`  run base pattern:  ${an.run_base_pattern}`);
  out.push(`  --bare pattern:    ${an.run_base_bare_pattern}`);
  out.push(`  ad-hoc pattern:    ${an.run_base_adhoc_pattern}`);
  out.push(`  skill id:          ${or(an.skill_id)}`);
  out.push(`  work item:         ${or(an.work_item)}`);
  out.push(`  facet:             ${or(an.facet)}`);
  out.push(`  resolved run base: ${an.resolved_run_base === null
    ? 'null (pass --skill-id to resolve a concrete run base)'
    : `${an.resolved_run_base}${an.resolved_run_base_adhoc ? '   (ad-hoc: no work item)' : ''}`}`);
  out.push('');

  const rs = m.resolved_skills;
  out.push(`resolved skills — ${rs.active_count} active, ${rs.parked_count} parked, `
    + `${rs.hard_edge_count} hard edge(s), ${rs.missing_target_count} missing target(s)`);
  out.push(`  trees: ${rs.trees.length ? rs.trees.join(', ') : '(none)'}`);
  for (const s of rs.skills) {
    out.push(`  ${s.state.padEnd(6)} ${s.id}   folder=${s.folder} tree=${s.tree} `
      + `logical=${or(s.logical_id)} descriptor=${yn(s.descriptor)} manifest=${yn(s.manifest)} `
      + `hard-depends-on=${s.hard_depends_on.length ? s.hard_depends_on.join(',') : '(none)'}`);
  }
  out.push('');

  const fw = m.framework;
  out.push(`framework — ${fw.entry_count} entries (${fw.rule_count} rule, ${fw.criterion_count} `
    + `criterion, ${fw.hook_count} hook), ${fw.floor_count} floor, ${fw.disabled_count} disabled`);
  for (const e of fw.entries) {
    out.push(`  ${(e.enabled ? 'enabled' : 'DISABLED').padEnd(8)} ${e.id}   kind=${e.kind} `
      + `layer=${e.deciding_layer}${e.floor ? ' (floor)' : ''} `
      + `owners=${e.owners.length ? e.owners.join(',') : '(framework-core)'}`);
  }
  out.push('');

  const cfg = m.configuration;
  out.push(`configuration — ${cfg.block_count} block(s) in ${cfg.family_count} family(ies); `
    + `${cfg.configured_count} configured, ${cfg.default_count} on the owning skill's default, `
    + `${cfg.unset_count} unset`);
  out.push('  credential values are ALWAYS masked here — this verb has no reveal flag, and reports '
    + 'value SHAPE only');
  out.push(`  families: ${cfg.families.map((f) => `${f.family}(${f.block_count})`).join(', ') || '(none)'}`);
  for (const b of cfg.blocks) {
    out.push(`  block ${b.block}   family=${b.family} status=${b.status} `
      + `layer=${or(b.deciding_layer, '(no layer carries it)')} file=${or(b.deciding_file, '(none)')} `
      + `family-file=${or(b.family_file)} secret-file=${or(b.secret_file)} `
      + `defaults=${or(b.defaults_file)} scope=${or(b.scope)} merge=${or(b.merge)} `
      + `inherits-root=${yn(b.inherits_root)} `
      + `owners=${b.owners.length ? b.owners.join(',') : '(framework-core)'} keys=${b.key_count}`);
    for (const k of b.keys) {
      out.push(`      ${k.key}   layer=${or(k.layer)} credential=${yn(k.secret)} shape=${k.shape}`);
    }
  }
  out.push('');

  const ph = m.package_health;
  out.push(`package health — ${ph.state}`);
  out.push(`  source tree:       ${yn(ph.source_tree)}`);
  out.push(`  core mounted:      ${yn(ph.core_mounted)}   mount dir=${ph.core_mount_dir}`);
  if (ph.core) {
    const c = ph.core;
    out.push(`  core path:         ${c.path}`);
    out.push(`  core version:      ${or(c.version)}   name=${or(c.name)}`);
    out.push(`  core ref:          ${or(c.ref)} @ ${or(c.head)}   dirty=${yn(c.dirty)}`);
    out.push(`  core skills:       ${c.skills_linked} linked, ${c.skills_own} authored here `
      + `(core ships ${c.skills_shipped_by_core})`);
    out.push(`  core wiring:       ${c.wiring_problem_count} file(s) bypass the mount`
      + `${c.wiring_problems.length ? `: ${c.wiring_problems.join(', ')}` : ''}`);
  }
  out.push('');

  const ex = m.executors;
  out.push(`executors — ${ex.executor_count} resolved   registry=${ex.registry_file} `
    + `present=${yn(ex.registry_present)} prefer=${or(ex.routing_prefer)}`);
  for (const e of ex.executors) {
    out.push(`  ${e.name}   builtin=${yn(e.builtin)} registered=${yn(e.registered)} `
      + `kind=${or(e.kind)} enabled=${yn(e.enabled)} transport=${or(e.transport)} `
      + `sandbox=${or(e.sandbox)} tiers=${e.model_tiers.length ? e.model_tiers.join(',') : '(none)'}`);
  }
  out.push('');

  const mc = m.multi_cli;
  out.push('multi-CLI wiring (Rule 6 — instructions canonical at AGENTS.md, skills at .agents/skills)');
  out.push(`  instructions:      ${mc.instructions.canonical}   present=${yn(mc.instructions.present)}`);
  for (const mi of mc.instructions.mirrors) {
    out.push(`    mirror ${mi.path}   present=${yn(mi.present)} link=${yn(mi.link)} `
      + `resolves-to-canonical=${mi.resolves === null ? '(n/a)' : yn(mi.resolves)}`);
  }
  out.push(`  skills:            ${mc.skills.canonical}   present=${yn(mc.skills.present)}`);
  for (const el of mc.skills.exposure_links) {
    out.push(`    exposure ${el.path}   present=${yn(el.present)} link=${yn(el.link)} `
      + `resolves-to-canonical=${el.resolves === null ? '(n/a)' : yn(el.resolves)}`);
  }
  out.push('  hooks:');
  for (const h of mc.hooks) {
    out.push(`    ${h.config}   present=${yn(h.present)} wired-hook-scripts=${h.wired_hook_count}`);
  }
  out.push('');

  out.push(`findings — ${m.findings.length} (${m.finding_counts.error} error, `
    + `${m.finding_counts.warning} warning, ${m.finding_counts.info} info)`);
  if (m.findings.length === 0) {
    out.push('  (none)');
  } else {
    for (const f of m.findings) {
      out.push(`  [${f.severity}] ${f.code}   ${f.subject}: ${f.message}`);
    }
  }
  out.push('');

  return out.join('\n');
}

/**
 * Run `scope explain`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {object} _args - unused; the options are read from ctx.argv (see header)
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { skillId, workItem, json } = parseExplainArgs(ctx.argv);
  return explainScope(ctx.repoRoot, { skillId, workItem, json });
}
