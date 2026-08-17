// lib/skill-lifecycle/registry.mjs
// `sidekicks skill registry [<skill>] [--check] [--backfill --assume-imported] [--apply] [--json]`
//
// The read side of the registration-profile store, plus the one operator-driven writer that is not
// an import.
//
// WHAT `--check` IS FOR. The profile records facts about an EVENT (see lib/skill-registry/profile.mjs)
// and mirrors a handful of facts about the folder. Only the mirrored half can be wrong, and when the
// two disagree the FILESYSTEM WINS — this verb reports the disagreement, it never "corrects" disk to
// match a record. `untracked` (a skill with no profile) is not a failure and never sets a non-zero
// exit: most skills here were authored in this repo, and only imported ones carry a receipt.
//
// WHY `--backfill` DEMANDS `--assume-imported`. There is no reliable way to derive whether a skill
// arrived from elsewhere. Presence at a configured destination proves nothing, because `skill export`
// writes there too — a skill this repo authored and published looks identical to one it took in. So
// the direction is an assertion the operator makes, not an inference this verb draws. Everything a
// backfill cannot know is written as the literal `unknown` rather than omitted: an absent key reads
// as "none", and `unknown` reads as "nobody knows", which are different answers.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, EXIT_VALIDATION, EXIT_USAGE, EXIT_NOT_FOUND, SidekicksError } from '../sk-cli/errors.mjs';
import { discoverSkills } from '../skill-manifest/read.mjs';
import { readSkillFrontmatter } from '../skill-manifest/read.mjs';
import {
  listProfiles, profileDrift, recordProfile, readProfile, mirrorFacts, fileHashes, REGISTRY_REL,
} from '../skill-registry/store.mjs';
import { UNKNOWN } from '../skill-registry/profile.mjs';
import { nowBangkok } from '../artifacts-lifecycle/_shared.mjs';
import { parseSkillFlags, positionalArgs } from './_shared.mjs';

/** Statuses that make `--check` fail. `untracked` and `local-only` are information, not defects. */
const CHECK_FAILS = Object.freeze(new Set(['missing-runtime', 'tree-drift']));

/**
 * A profile for a skill that is already installed, honest about what it cannot know.
 *
 * @param {string} repoRoot
 * @param {object} entry - a discoverSkills() entry
 */
function backfilledFacts(repoRoot, entry) {
  const fm = readSkillFrontmatter(entry);
  return {
    skill: entry.skill,
    status: 'installed',
    provenance: 'backfilled',
    // Every one of these is a fact about an import that has already happened. Nothing on disk
    // records them, and guessing would make the store exactly the hand-maintained second source of
    // truth it is built not to be.
    source: { kind: UNKNOWN, destination: UNKNOWN, remote: UNKNOWN, commit: UNKNOWN, branch: UNKNOWN },
    upstream: {
      name: fm.name || entry.skill,          // the folder is what it is called HERE; frontmatter is a hint
      path: UNKNOWN,
      version: fm.version || UNKNOWN,
      description: fm.description || '',
    },
    adapter: { layout: UNKNOWN, converted: false, category: '', synthesized: UNKNOWN },
    // Deliberately NOT enabled_here: "did this import turn these on HERE" is unknowable afterwards.
    // What the skill DECLARES stays derivable from its own skill.yaml, so it is not copied here.
    enabled_here: {
      framework_rules: UNKNOWN, config_blocks: UNKNOWN, hooks_requested: UNKNOWN,
      repo_root_files: UNKNOWN, audit_group: UNKNOWN,
    },
    licence: { declared: fm.license || UNKNOWN, carried: UNKNOWN, not_carried: UNKNOWN },
    imported_at: UNKNOWN,
    imported_by: { tool: 'sidekicks skill registry --backfill', cli_version: UNKNOWN },
    mirror: mirrorFacts(repoRoot, entry),
    // A snapshot of NOW, not of the install — labelled so a removal does not mistake it for one.
    files_recorded_at: 'backfill',
    files: fileHashes(entry),
    history: [{ at: nowBangkok(), action: 'backfill', detail: 'asserted by the operator' }],
  };
}

/**
 * Run `skill registry`.
 *
 * @param {{repoRoot: string, argv: string[]}} ctx
 */
export async function run(ctx) {
  const flags = parseSkillFlags(ctx.argv, ['json', 'check', 'backfill', 'assume-imported', 'apply']);
  const names = positionalArgs(ctx.argv, []);

  if (flags.backfill) {
    if (!names.length) {
      throw new SidekicksError(
        'skill registry --backfill: name the skill(s) to record. There is deliberately no --all: a '
        + 'receipt asserts where a skill came from, and asserting that for every skill at once is '
        + 'how a record stops meaning anything.',
        EXIT_USAGE
      );
    }
    if (!flags['assume-imported']) {
      throw new SidekicksError(
        'skill registry --backfill: add --assume-imported. Nothing on disk says whether a skill was '
        + 'imported or authored here — being present in a skills repository proves nothing, because '
        + '`skill export` puts it there too. The direction has to be your assertion, not a guess.',
        EXIT_VALIDATION
      );
    }
    const installed = new Map(discoverSkills(ctx.repoRoot).map((e) => [e.skill, e]));
    const wrote = [];
    const plan = [];
    for (const n of names) {
      const entry = installed.get(n);
      if (!entry) throw new SidekicksError(`skill registry: unknown skill '${n}'`, EXIT_NOT_FOUND);
      if (readProfile(ctx.repoRoot, n)) {
        throw new SidekicksError(
          `skill registry: '${n}' already has a profile — delete it with 'skill remove --purge-profile' `
          + 'or leave it alone; backfill never overwrites a real receipt with an inferred one',
          EXIT_VALIDATION
        );
      }
      plan.push(`${REGISTRY_REL}/${n}.yaml`);
      if (flags.apply) wrote.push(recordProfile(ctx.repoRoot, backfilledFacts(ctx.repoRoot, entry)));
    }
    if (flags.json) {
      return {
        stdout: JSON.stringify({ ok: true, applied: Boolean(flags.apply), plan, wrote }, null, 2) + '\n',
        exitCode: EXIT_OK,
      };
    }
    const out = [flags.apply
      ? `skill registry: backfilled ${wrote.length} profile(s)`
      : `skill registry: would backfill ${plan.length} profile(s) (nothing written)`];
    for (const p of plan) out.push(`  ${p}`);
    out.push('', 'A backfilled profile records only what disk can still show. Where it came from, '
      + 'which ids the import enabled here, when it happened and what the converter synthesized are '
      + `written as '${UNKNOWN}' — they are gone, and a guess would be worse than a gap. Every such `
      + "profile reports as 'incomplete' forever, and `skill remove` says so before it acts.");
    if (!flags.apply) out.push('', `  apply with '--backfill --assume-imported ${names.join(' ')} --apply'`);
    return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
  }

  const rows = profileDrift(ctx.repoRoot)
    .filter((r) => !names.length || names.includes(r.skill));
  if (names.length && !rows.length) {
    throw new SidekicksError(`skill registry: unknown skill '${names.join(', ')}'`, EXIT_NOT_FOUND);
  }
  const failing = rows.filter((r) => CHECK_FAILS.has(r.status));
  const exitCode = flags.check && failing.length ? EXIT_VALIDATION : EXIT_OK;

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        ok: exitCode === EXIT_OK,
        registry: REGISTRY_REL,
        profiles: listProfiles(ctx.repoRoot).length,
        rows,
      }, null, 2) + '\n',
      exitCode,
    };
  }

  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const out = [
    `skill registry: ${listProfiles(ctx.repoRoot).length} profile(s) in ${REGISTRY_REL}`,
    `  ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'nothing to report'}`,
    '',
  ];
  // untracked is the majority and the expected state; showing it by default buries the rest.
  const interesting = rows.filter((r) => r.status !== 'untracked');
  for (const r of interesting) out.push(`  [${r.status}] ${r.skill}\n      ${r.detail}`);
  if (!interesting.length) {
    out.push('  Every profile matches disk. Skills with no profile were authored here.');
  }
  if (failing.length && !flags.check) {
    out.push('', `${failing.length} row(s) would fail 'skill registry --check'.`);
  }
  if (exitCode !== EXIT_OK) throw new SidekicksError(out.join('\n'), exitCode);
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
