// lib/framework-lifecycle/sync.mjs
// `sidekicks framework sync [--check] [--prune] [--split] [--json]`
//
// Materialises the SETTINGS files — .sidekicks/config/settings/{rules,criteria,hooks}.yaml — so
// every toggleable framework entry is VISIBLE in a committed file: one explicit
// `<slug>: true|false` per registry entry, instead of an empty `rules: {}` that hides which rules
// the repo carries. Resolution is unchanged: an explicit `true` and an absent key both mean
// enabled (lib/framework-settings/resolve.mjs).
//
// This is the write path for the rule in CLAUDE.md: adding a rule, criterion or hook to the
// registry means listing it here in the same change. `--check` is the read-only form, which
// `framework doctor` also runs, so a forgotten entry fails CI instead of going unnoticed.
//
// `--split` is the one-time migration off the pre-split `config/framework.yaml` monolith: every
// entry moves into its per-kind file at its RECORDED value, and the monolith is parked as
// `pending-removal.framework.yaml`. Until it is run, the monolith is still read one layer below
// the per-kind files, so an unmigrated checkout resolves identically.
//
// Safety-floor ids are never written — a floor id in any data layer is a validation error by
// design (so no file can claim a safety rule is off). They stay visible via `framework list`.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { SETTINGS_REL_DIR } from '../framework-settings/framework-config.mjs';
import {
  frameworkDrift,
  materializeFramework,
  splitSettings,
} from '../framework-settings/materialize.mjs';
import { parseFrameworkFlags } from './_shared.mjs';

/**
 * Run `framework sync`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseFrameworkFlags(ctx.argv, ['check', 'prune', 'split', 'json']);
  const checkOnly = flags.check === true;
  const prune = flags.prune === true;
  const split = flags.split === true;

  if (checkOnly && (prune || split)) {
    throw new SidekicksError(
      'framework sync: --check writes nothing, so it cannot be combined with --prune or --split',
      EXIT_VALIDATION
    );
  }

  const before = frameworkDrift(repoRoot);

  if (checkOnly) {
    const drifted = before.missing.length > 0;
    if (flags.json) {
      const payload = {
        ok: !drifted,
        path: SETTINGS_REL_DIR,
        listed: before.listed.length,
        toggleable: before.toggleable,
        floor: before.floor.length,
        missing: before.missing,
        unknown: before.unknown,
        unmigrated: before.unmigrated,
      };
      return {
        stdout: JSON.stringify(payload, null, 2) + '\n',
        exitCode: drifted ? EXIT_VALIDATION : EXIT_OK,
      };
    }
    if (drifted) {
      throw new SidekicksError(
        `framework sync --check: ${before.missing.length} entr(ies) are not listed in `
        + `${SETTINGS_REL_DIR}:\n${before.missing.map((id) => `  ${id}`).join('\n')}\n`
        + "Run 'sidekicks framework sync' to list them at their default (enabled).",
        EXIT_VALIDATION
      );
    }
    const clean = [
      `framework sync --check: OK (${before.listed.length}/${before.toggleable} toggleable entries listed in ${SETTINGS_REL_DIR})`,
      `  floor:   ${before.floor.length} locked ids, deliberately not listed (not configurable)`,
    ];
    if (before.unknown.length) {
      clean.push(`  unknown: ${before.unknown.length} listed id(s) no longer in the registry `
        + `(${before.unknown.join(', ')}) — 'framework sync --prune' drops them`);
    }
    if (before.unmigrated.length) {
      clean.push(`  legacy:  ${before.unmigrated.length} id(s) still live only in the pre-split `
        + "monolith — 'framework sync --split' moves them into the per-kind settings files");
    }
    return { stdout: clean.join('\n') + '\n', exitCode: EXIT_OK };
  }

  // The migration runs FIRST: once entries live in the per-kind files, materialisation and pruning
  // both operate on one source instead of straddling two.
  const migration = split ? splitSettings(repoRoot) : null;

  const result = materializeFramework(repoRoot, { prune });
  const after = frameworkDrift(repoRoot);

  if (flags.json) {
    const payload = {
      ok: after.missing.length === 0,
      path: result.path,
      created: result.created,
      added: result.added,
      pruned: result.pruned,
      unknown: result.unknown,
      listed: after.listed.length,
      toggleable: after.toggleable,
      floor: after.floor.length,
      unmigrated: after.unmigrated,
      split: migration
        ? { moved: migration.moved, skipped: migration.skipped, from: migration.from, to: migration.to }
        : null,
    };
    return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: EXIT_OK };
  }

  const out = [];
  if (migration) {
    if (migration.from === null) {
      out.push('framework sync --split: nothing to migrate — no pre-split monolith present');
    } else {
      out.push(`framework sync --split: ${migration.moved.length} entr(ies) moved out of `
        + `${migration.from} into ${SETTINGS_REL_DIR}/`);
      out.push(`  parked  ${migration.from} as ${migration.to} (git-ignored rollback reference)`);
      if (migration.skipped.length) {
        out.push(`  kept    ${migration.skipped.length} per-kind decision(s) that already existed: `
          + migration.skipped.join(', '));
      }
    }
  }
  if (result.added.length === 0 && result.pruned.length === 0) {
    out.push(`framework sync: already complete — ${after.listed.length}/${after.toggleable} `
      + `toggleable entries listed in ${SETTINGS_REL_DIR}`);
  } else {
    out.push(`framework sync: ${result.path}${result.created ? ' (file created)' : ''}`);
    if (result.added.length) {
      out.push(`  added   ${result.added.length} entr(ies) at their default (enabled):`);
      for (const id of result.added) out.push(`    + ${id}`);
    }
    if (result.pruned.length) {
      out.push(`  pruned  ${result.pruned.length} entr(ies) no longer in the registry:`);
      for (const id of result.pruned) out.push(`    - ${id}`);
    }
  }
  out.push(`  floor:  ${after.floor.length} locked ids stay unlisted — the floor is not configurable`);
  if (result.unknown.length) {
    out.push(`  NOTE: ${result.unknown.length} listed id(s) are not in the registry `
      + `(${result.unknown.join(', ')}). Re-run with --prune to drop them.`);
  }
  if (after.unmigrated.length) {
    out.push(`  NOTE: ${after.unmigrated.length} id(s) still live only in the pre-split monolith. `
      + 'Re-run with --split to move them into the per-kind settings files.');
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
