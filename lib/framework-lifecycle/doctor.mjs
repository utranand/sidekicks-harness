// lib/framework-lifecycle/doctor.mjs
// `sidekicks framework doctor [--json]`
//
// The drift check that keeps the registry from becoming the next CLAUDE.full.md. A catalog
// with no enforcement rots, so this is BOTH a verb and a test (tests/framework-settings/
// doctor.test.mjs runs it against the real repo, so CI fails on divergence).
//
// Checks:
//   1. every hook wired in .claude/settings.json has a registry entry
//   2. every registered hook's script is wired and exists on disk — unless every skill that
//      owns the hook is absent from this checkout (a trimmed framework core; AAP-111)
//   3. every entry that claims a body_at names a file that exists, AND — for framework-core
//      entries, which all share one AGENTS.md — that the rule's own prose is still IN that file
//   4. every safety-floor id (floor.mjs) is present in the registry and marked floor
//   5. no registry entry claims floor for an id the code does not lock
//   6. every skill descriptor's declared config defaults file exists
//   7. one config block has defaults in exactly one skill
//   8. every toggleable entry is VISIBLE in .sidekicks/framework.yaml (`framework sync`)
//
// Exit 0 with a clean report, or EXIT_VALIDATION listing every problem found (never the
// first one only — a partial report invites a second round trip).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { coreDirOf } from '../sk-cli/core-mount.mjs';
import { resolveOwnedFile, bodyTexts } from './_body.mjs';
import { LOCKED_IDS } from '../framework-settings/floor.mjs';
import {
  buildRegistry,
  wiredHookScripts,
  posixScript,
  HOOK_CONFIGS,
} from '../framework-settings/registry.mjs';
import { resolve as resolveEntry, loadLayers } from '../framework-settings/resolve.mjs';
import { SETTINGS_REL_DIR } from '../framework-settings/framework-config.mjs';
import { frameworkDrift } from '../framework-settings/materialize.mjs';
import { discoverSkills } from '../skill-manifest/read.mjs';
import { parseFrameworkFlags } from './_shared.mjs';

/**
 * Collect every drift finding. Exported so the test suite asserts the same checks the verb
 * runs, rather than a re-implementation of them.
 *
 * @param {string} repoRoot
 * @returns {{ findings: Array<{check: string, detail: string}>, counts: object }}
 */
export function auditFramework(repoRoot) {
  const findings = [];
  const { entries, descriptors } = buildRegistry(repoRoot);

  // A MOUNTED workspace resolves framework-owned files somewhere else, and this doctor used to
  // ignore that. `core init` rewrites every hook path to `.sidekicks-core/scripts/...`
  // (lib/core-lifecycle/_wiring.mjs), so all seven owner-less framework hooks reported
  // 'hook-script-missing' in a healthy consumer install while the very same doctor run INSIDE the
  // generated core passed — which is why the release gates never saw it. Both file-resolving checks
  // below therefore try the workspace first, then the mounted core.
  const coreDir = coreDirOf(repoRoot);

  // Loaded once: the body-marker check below asks "is this entry actually on?" per entry, and
  // re-reading the settings files thirty times would be the same answer at thirty times the cost.
  let layers = null;
  try {
    layers = loadLayers(repoRoot);
  } catch { /* an unreadable enable map is reported by the drift check below, not here */ }

  const hookEntries = entries.filter((e) => e.kind === 'hook');
  const registeredScripts = new Set(hookEntries.map((e) => posixScript(e.script || '')));
  const wired = wiredHookScripts(repoRoot, HOOK_CONFIGS[0]);

  // 1 — wired but unregistered.
  for (const script of wired) {
    if (!registeredScripts.has(script)) {
      findings.push({
        check: 'hook-unregistered',
        detail: `${HOOK_CONFIGS[0]} wires '${script}', which has no entry in `
          + 'lib/framework-settings/core-registry.mjs — add one so the hook is gateable',
      });
    }
  }

  // 2 — registered but not wired, or the script file is gone.
  //
  // Owner-aware (AAP-111): a distributed core legitimately omits a hook's script and wiring when
  // every skill that owns the hook stayed behind — the id stays registered (the gate must resolve
  // identically either way; core-registry.mjs), but demanding its wiring here would make a
  // correctly-trimmed core fail its own doctor. Presence is judged by discoverSkills (SKILL.md is
  // what defines a skill — several owner skills carry no skill.yaml). A hook with owners: [] is
  // framework-owned and is never skipped.
  const present = new Set(discoverSkills(repoRoot).map((e) => e.skill));
  let ownerAbsent = 0;
  const wiredSet = new Set(wired);
  for (const entry of hookEntries) {
    if (entry.owners.length > 0 && !entry.owners.some((o) => present.has(o))) {
      ownerAbsent += 1;
      continue;
    }
    const script = posixScript(entry.script || '');
    if (!wiredSet.has(script)) {
      findings.push({
        check: 'hook-unwired',
        detail: `'${entry.id}' claims script '${script}', which ${HOOK_CONFIGS[0]} does not wire`,
      });
    }
    if (script && !resolveOwnedFile(repoRoot, coreDir, script.split('/'))) {
      findings.push({
        check: 'hook-script-missing',
        detail: `'${entry.id}' points at '${script}', which does not exist`,
      });
    }
  }

  // 3 — a body_at that names nothing (the CLAUDE.full.md failure mode) …
  for (const entry of entries) {
    if (!entry.body_at) continue;
    const bodies = bodyTexts(repoRoot, coreDir, entry.body_at);
    if (!bodies.length) {
      findings.push({
        check: 'body-missing',
        detail: `'${entry.id}' records body_at '${entry.body_at}', which does not exist`,
      });
      continue;
    }
    // … and, for framework-core entries, a body_at that names a file the rule is no longer IN.
    //
    // This is the check the lightweight v2 core needed and did not have. Thirty core entries all
    // record body_at 'AGENTS.md', so file existence proves nothing about any single one of them:
    // seven floor rules were absent from the forged instruction surface while `framework show`
    // reported body_exists: true for every one. The marker is one distinctive phrase from the
    // rule's own prose (core-registry.mjs), so this asserts the RULE, not the filename.
    if (!entry.body_marker) continue;
    // A rule that is turned OFF need not be stated. That is the whole point of the enable map, and
    // it is what lets a lightweight distribution ship a smaller instruction surface honestly:
    // either the prose is there, or the entry is explicitly disabled — never silently absent while
    // the registry still reports it enabled, which is how v2.0.0 lost seven safety rules.
    //
    // This is NOT a hole in the floor. lib/framework-settings/resolve.mjs throws on a floor id
    // present in ANY settings layer, `true` or `false` alike, so a floor entry always resolves
    // enabled and always reaches the check below.
    if (!resolveEntry(repoRoot, entry.id, layers).enabled) continue;
    if (!bodies.some((b) => b.text.includes(entry.body_marker))) {
      findings.push({
        check: 'body-marker-missing',
        detail: `'${entry.id}' records body_at '${entry.body_at}', but that file no longer states `
          + `the rule (marker: "${entry.body_marker}") — searched ${bodies.map((b) => b.rel).join(', ')}`,
      });
    }
  }

  // 4/5 — the floor and the registry must agree in both directions.
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const id of LOCKED_IDS) {
    const entry = byId.get(id);
    if (!entry) {
      findings.push({
        check: 'floor-unregistered',
        detail: `floor id '${id}' has no registry entry — every locked id must be listed `
          + 'so `framework show` can explain it',
      });
      continue;
    }
    if (!entry.floor) {
      findings.push({
        check: 'floor-mismatch',
        detail: `'${id}' is locked in floor.mjs but its registry entry is not marked floor`,
      });
    }
  }
  for (const entry of entries) {
    if (entry.floor && !LOCKED_IDS.has(entry.id)) {
      findings.push({
        check: 'floor-mismatch',
        detail: `'${entry.id}' is marked floor in the registry but is not locked in floor.mjs `
          + '(floor.mjs is the only authority)',
      });
    }
  }

  // 6 — a descriptor's config defaults file must exist.
  for (const d of descriptors) {
    if (d.config && d.config.defaults) {
      const rel = join(d.tree, d.skill, d.config.defaults);
      if (!existsSync(join(repoRoot, rel))) {
        findings.push({
          check: 'defaults-missing',
          detail: `'${d.relPath}' points config.defaults at '${rel}', which does not exist`,
        });
      }
    }
  }

  // 7 — one config block, one defaults source. Several skills may READ a block (jira-autopilot
  // reads the connector's `jira:`), but if two of them ship defaults for it the same block
  // resolves two ways depending on which skill you ask through.
  const defaultsByBlock = new Map();
  for (const d of descriptors) {
    if (!d.config || !d.config.defaults) continue;
    const list = defaultsByBlock.get(d.config.block) || [];
    list.push(d.skill);
    defaultsByBlock.set(d.config.block, list);
  }
  for (const [block, skills] of defaultsByBlock) {
    if (skills.length > 1) {
      findings.push({
        check: 'defaults-conflict',
        detail: `config block '${block}' has defaults in more than one skill (${skills.join(', ')})`
          + ' — exactly one skill may own a block\'s defaults; the others declare the block without one',
      });
    }
  }

  // 8 — the committed enable map must list every toggleable entry, so what the repo carries
  // is readable in the file itself and not only via `framework list`. Floor ids are excluded:
  // writing one into a data layer is a validation error by design.
  const drift = frameworkDrift(repoRoot);
  for (const id of drift.missing) {
    findings.push({
      check: 'entry-unlisted',
      detail: `'${id}' is not listed in ${SETTINGS_REL_DIR}/ — run 'sidekicks framework sync' to `
        + 'add it at its default (enabled); every framework entry stays visible in the file',
    });
  }
  for (const id of drift.unknown) {
    findings.push({
      check: 'entry-unknown',
      detail: `${SETTINGS_REL_DIR}/ lists '${id}', which no registry entry declares — run `
        + "'sidekicks framework sync --prune' to drop it (or restore the skill that owned it)",
    });
  }

  return {
    findings,
    counts: {
      entries: entries.length,
      listed: drift.listed.length,
      unlisted: drift.missing.length,
      rules: entries.filter((e) => e.kind === 'rule').length,
      criteria: entries.filter((e) => e.kind === 'criterion').length,
      hooks: hookEntries.length,
      hooks_owner_absent: ownerAbsent,
      descriptors: descriptors.length,
      floor: LOCKED_IDS.size,
      wired_hooks: wired.length,
    },
  };
}


/**
 * Run `framework doctor`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseFrameworkFlags(ctx.argv, ['json']);
  const { findings, counts } = auditFramework(repoRoot);

  if (flags.json) {
    const stdout = JSON.stringify({ ok: findings.length === 0, counts, findings }, null, 2) + '\n';
    if (findings.length) {
      // --json still exits non-zero, but the payload goes to stdout, not the error path.
      return { stdout, exitCode: EXIT_VALIDATION };
    }
    return { stdout, exitCode: EXIT_OK };
  }

  if (findings.length) {
    const lines = findings.map((f) => `  [${f.check}] ${f.detail}`);
    throw new SidekicksError(
      `framework doctor: ${findings.length} problem(s) found\n${lines.join('\n')}`,
      EXIT_VALIDATION
    );
  }

  const out = [
    'framework doctor: OK',
    `  entries:     ${counts.entries} (${counts.rules} rules, ${counts.criteria} criteria, ${counts.hooks} hooks)`,
    `  descriptors: ${counts.descriptors} skill.yaml found`,
    `  floor:       ${counts.floor} locked ids, all registered`,
    `  visibility:  ${counts.listed} toggleable entries listed in ${SETTINGS_REL_DIR}/`,
    `  wiring:      ${counts.wired_hooks} hooks wired in ${HOOK_CONFIGS[0]}, all registered`,
  ];
  if (counts.hooks_owner_absent > 0) {
    out.push(`  owner-absent: ${counts.hooks_owner_absent} hook(s) tolerated unwired (owner skill not in this checkout)`);
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
