// lib/skill-lifecycle/manifest.mjs
// `sidekicks skill manifest <skill> | --all [--check] [--apply] [--json]`
//
// Materialise a skill's dependency manifest from what the scanner found.
//
// REPORTS BY DEFAULT, WRITES ONLY ON --apply. Deliberately unlike lib/sk-cli/skill-links.mjs,
// which heals on every CLI invocation: that function repairs a LINK, where no data is at risk and a
// wrong guess costs nothing. This one writes into a hand-maintained file inside the CLI write
// surface, so the default has to be "show me" and the write has to be asked for.
//
// NEVER RE-DECIDES A RECORDED CHOICE. An entry already in the file keeps its `why`, `optional`,
// `how`, `degraded` and its comments; only missing entries are added. The rule and the reasoning are
// lib/framework-settings/materialize.mjs:84-88.
//
// --check is the read-only twin (exit EXIT_VALIDATION on drift, writes nothing), so CI can fail on a
// stale manifest exactly the way `framework sync --check` does.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, EXIT_VALIDATION, EXIT_USAGE, SidekicksError } from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import {
  discoverSkills,
  readSkillManifest,
  readSkillDescriptor,
  derivedSections,
  readFrontmatterDependsOn,
  MANIFEST_NAME,
} from '../skill-manifest/read.mjs';
import { manifestPlan, renderManifest, upsertManifest } from '../skill-manifest/materialize.mjs';
import { scanSkill, manifestRequired, walkSkillFiles, buildModuleOwners } from './scan.mjs';
import { parseSkillFlags, resolveTargets } from './_shared.mjs';

/**
 * Plan (and optionally write) the manifest for each target skill.
 *
 * Exported so the test suite drives the same code path the verb does.
 *
 * @param {string} repoRoot
 * @param {{skill?: string|null, apply?: boolean}} opts
 * @returns {{results: Array<object>, wrote: string[], drift: string[]}}
 */
export function materializeManifests(repoRoot, opts = {}) {
  const all = discoverSkills(repoRoot);
  const universe = all.map((s) => s.skill);
  const filesBySkill = new Map(all.map((e) => [e.skill, walkSkillFiles(e.dir)]));
  const moduleOwners = buildModuleOwners(filesBySkill);

  const targets = opts.skill ? all.filter((s) => s.skill === opts.skill) : all;
  const results = [];
  const wrote = [];
  const drift = [];

  for (const entry of targets) {
    const scan = scanSkill(repoRoot, entry, universe, {
      files: filesBySkill.get(entry.skill),
      moduleOwners,
    });
    const descriptor = readSkillDescriptor(repoRoot, entry);
    const { required, because } = manifestRequired(scan, Boolean(descriptor));
    const read = readSkillManifest(repoRoot, entry);
    const derived = derivedSections(descriptor, entry.skill);

    // A skill that needs nothing gets nothing. The required set is derived, never counted — the same
    // reasoning lib/framework-settings/registry.mjs applies to descriptors.
    if (!required && !read.present) {
      results.push({ skill: entry.skill, action: 'skip', reason: 'no dependency to declare' });
      continue;
    }

    const plan = manifestPlan(scan, read.manifest, derived, readFrontmatterDependsOn(entry));
    const addCount = plan.add.python.length + plan.add.node.length + plan.add.binaries.length + plan.add.framework_files.length
      + plan.add.sibling_skills.length;

    if (!plan.changed) {
      results.push({ skill: entry.skill, action: 'unchanged', path: read.relPath });
      continue;
    }

    const action = read.present ? 'update' : 'create';
    const detail = {
      skill: entry.skill,
      action,
      path: read.relPath,
      because,
      added: {
        python: plan.add.python.map((p) => p.import),
        node: plan.add.node.map((n) => n.package),
        binaries: plan.add.binaries.map((b) => b.name),
        sibling_skills: plan.add.sibling_skills.map((s) => `${s.skill} (${s.how})`),
      },
      added_count: addCount,
      derived_changed: plan.derivedChanged,
      bundle_changed: plan.bundleChanged,
      bundle_entries: Object.keys(plan.bundle).length,
    };
    results.push(detail);
    drift.push(`${entry.skill}: ${action} (${addCount} new entr${addCount === 1 ? 'y' : 'ies'}`
      + `${plan.derivedChanged ? ', derived sections' : ''}${plan.bundleChanged ? ', bundle baseline' : ''})`);

    if (opts.apply) {
      const text = read.text === null || !read.present
        ? renderManifest(plan)
        : upsertManifest(read.text, plan);
      // Rule 1: everything under .sidekicks/ is written through the CLI, and through the guard.
      assertWritable(read.absPath, repoRoot);
      writeAtomic(read.absPath, text);
      wrote.push(read.relPath);
    }
  }

  return { results, wrote, drift };
}

/**
 * Run `skill manifest`.
 *
 * @param {{repoRoot: string, argv: string[]}} ctx
 * @param {{name?: string}} args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, args) {
  const flags = parseSkillFlags(ctx.argv, ['check', 'apply', 'json', 'all']);
  if (flags.check && flags.apply) {
    throw new SidekicksError(
      'skill manifest: --check and --apply are mutually exclusive — --check never writes',
      EXIT_USAGE
    );
  }

  const name = args && args.name ? args.name : null;
  if (!name && !flags.all) {
    throw new SidekicksError(
      "skill manifest: name a skill or pass --all (run 'sidekicks skill list --needs-manifest')",
      EXIT_USAGE
    );
  }
  if (name) resolveTargets(ctx.repoRoot, name, { all: false, verb: 'skill manifest' });

  const { results, wrote, drift } = materializeManifests(ctx.repoRoot, {
    skill: name,
    apply: Boolean(flags.apply),
  });

  const changed = results.filter((r) => r.action === 'create' || r.action === 'update');

  if (flags.json) {
    const payload = {
      ok: flags.check ? changed.length === 0 : true,
      mode: flags.apply ? 'apply' : (flags.check ? 'check' : 'report'),
      wrote,
      results,
    };
    return {
      stdout: JSON.stringify(payload, null, 2) + '\n',
      exitCode: flags.check && changed.length ? EXIT_VALIDATION : EXIT_OK,
    };
  }

  if (flags.check) {
    if (changed.length) {
      throw new SidekicksError(
        `skill manifest --check: ${changed.length} manifest(s) are missing or stale\n`
        + drift.map((d) => `  ${d}`).join('\n')
        + "\n  fix with 'sidekicks skill manifest --all --apply'",
        EXIT_VALIDATION
      );
    }
    return { stdout: 'skill manifest --check: OK (every manifest is current)\n', exitCode: EXIT_OK };
  }

  if (!changed.length) {
    return { stdout: 'skill manifest: nothing to do (every manifest is current)\n', exitCode: EXIT_OK };
  }

  const out = [];
  if (flags.apply) {
    out.push(`skill manifest: wrote ${wrote.length} ${MANIFEST_NAME} file(s)`);
    for (const r of changed) out.push(`  ${r.action === 'create' ? '+' : '~'} ${r.path}`);
    out.push('');
    out.push("Every TODO left in those files is a question only you can answer — 'sidekicks skill doctor'");
    out.push('lists them until they are gone.');
  } else {
    out.push(`skill manifest: ${changed.length} manifest(s) would be written (nothing written)`);
    for (const d of drift) out.push(`  ${d}`);
    out.push('');
    out.push("  apply with 'sidekicks skill manifest " + (name || '--all') + " --apply'");
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
