// lib/core-lifecycle/update.mjs
// `sidekicks core update [--ref <tag|branch|sha>] [--json] [--dry-run]`
//
// Move the mounted framework core to another ref and re-seed everything derived from it: the per-CLI
// wiring, the skill overlay, the enable map, the push guard.
//
// THE OLD CORE'S JOB ENDS AT THE CHECKOUT. This verb runs from the core it is REPLACING — the
// workspace shim forwards into the mount — so everything after `git checkout` used to be the
// outgoing release re-deriving the workspace from the incoming release's files. Every fix living in
// that tail therefore skipped the update that installed it (INC-2026-09-04-03). The tail now moves
// to the new core: `lib/core-lifecycle/_finish.mjs` owns it, its presence on disk is the capability
// probe, and this verb re-enters the NEW core's `core update --finish` to run it. A core older than
// that module is finished in-process as before, and said so in a note.
//
// TWO INVARIANTS, both load-bearing:
//
//   1. It STAGES the parent gitlink — and, when --ref recorded a new tracked ref, .gitmodules
//      alongside it — but never commits either. Same contract as `project add` / `project remove`
//      (docs/architecture.md D17/D19): the CLI never commits or pushes the workspace repo — that
//      decision belongs to whoever owns the history. .gitmodules joined the staged set because
//      writing the branch key into the WORKTREE copy alone left `git commit` recording a pin whose
//      tracked ref was absent from the committed file (INC-2026-09-04-02, N-2).
//   2. It refuses to run over TRACKED modifications in the core. The core is read-only by design, so
//      an edited tracked file means either the guard was bypassed or something is writing into the
//      submodule — and a checkout would discard it silently. `--force` is deliberately NOT offered:
//      the fix is to look. UNTRACKED files are only reported, never blocking: `git checkout` leaves
//      them alone, and a consumer checkout legitimately accumulates residue (a skill's `__pycache__`,
//      a built `.venv`) that must not wedge every future update.
//
// A pinned ref is normal here. A submodule tracking a tag sits on a detached HEAD, which is exactly
// what "pinned to v1.2.0" means — so the checkout is explicit about detaching rather than trying to
// invent a local branch.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { readCoreMarker } from '../sk-cli/core-mount.mjs';
import * as git from '../git-delegation/git.mjs';
import { parseCoreFlags, requireCore, inspectCore, shortSha, agentPackHint } from './_shared.mjs';
import { applyDerived } from './_derive.mjs';
import { finishUpdate, supportsFinish } from './_finish.mjs';
import {
  readTrackedRef, refCandidates, resolveFirst, preflightTarget,
} from './_ref.mjs';

/**
 * Run `core update`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: Function }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseCoreFlags(ctx.argv, ['json', 'dry-run', 'finish', 'stage-gitlink']);
  const dryRun = flags['dry-run'] === true;
  const wantRef = typeof flags.ref === 'string' && flags.ref ? flags.ref : null;

  // The second half of the handoff: this process IS the newly mounted core, re-entered by the core
  // it replaced. No fetch, no ladder, no checkout — the files are already here.
  if (flags.finish === true) return runFinish(ctx, flags, wantRef);

  const coreDir = requireCore(repoRoot, 'core update');
  const before = inspectCore(repoRoot, coreDir);

  const state = git.worktreeState(coreDir);
  if (state.tracked.length) {
    throw new SidekicksError(
      `core update: ${before.coreRel} has ${state.tracked.length} modified tracked file(s):\n`
      + state.tracked.slice(0, 10).map((p) => `  ${p}`).join('\n')
      + (state.tracked.length > 10 ? `\n  … and ${state.tracked.length - 10} more` : '') + '\n'
      + 'The core is a read-only consumer checkout, so this is unexpected — checking out another ref '
      + 'would discard these silently. Inspect first:\n'
      + `  git -C ${before.coreRel} status\n`
      + 'Then either drop the changes (git checkout .) or move them into the framework repository.',
      EXIT_VALIDATION
    );
  }

  // ── Which ref to land on ────────────────────────────────────────────────────────────────────────
  // The ladder, most specific first: --ref → the recorded tracking intent (core-local
  // sidekicks.trackedRef, then committed .gitmodules) → the branch this mount is on → main.
  //
  // The recorded rung is the one that was missing. Installers detach at the requested ref, so
  // `before.branch` is always the literal 'HEAD' and the branch rung never fires — a core installed
  // from `--ref next` silently retargeted itself to main on its first update. See _ref.mjs.
  const tracked = readTrackedRef(repoRoot, coreDir, before.coreRel);
  const candidates = refCandidates({ wantRef, tracked, branch: before.branch });

  if (dryRun) {
    const out = [
      `core update --dry-run: ${before.coreRel}`,
      `  now:    ${before.describe || before.branch || '(detached)'} @ ${shortSha(before.head)}`,
      `  tracks: ${tracked ? `${tracked.ref}  (${tracked.source})` : '(nothing recorded — would fall through to the ladder)'}`,
      `  would:  fetch origin --tags, then resolve the first of: ${candidates.map((c) => c.ref).join(' -> ')}`,
      '          then verify the target carries a core marker and entrypoint BEFORE checking it out',
      '          then check out, and hand the rest to the core that just arrived: wiring, skill\n'
      + '          overlay, framework sync, the push guard, the tracked ref and the staging',
      '          then STAGE the parent gitlink, and .gitmodules when --ref records a new\n          tracked ref (never commit either)',
      '          then run the new mount\'s own core doctor and print anything it flags',
    ];
    return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
  }

  // ── Fetch ───────────────────────────────────────────────────────────────────────────────────────
  const notes = [];
  if (state.untracked.length) {
    notes.push(`${state.untracked.length} untracked file(s) in ${before.coreRel} left in place `
      + `(e.g. ${state.untracked.slice(0, 3).join(', ')}) — a checkout does not touch them`);
  }
  try {
    git.fetch(coreDir, 'origin', { tags: true });
  } catch (err) {
    // Offline is not fatal when the requested ref is already local (a rollback to a known tag).
    notes.push(`fetch failed (${err.message}) — resolving from local refs only`);
  }

  // Each candidate is tried as a bare ref and then as `origin/<ref>` — the two-rung sub-ladder the
  // installers always had and this verb did not, which is why `--ref <remote-only-branch>` failed
  // despite branches being an advertised input.
  const hit = resolveFirst(coreDir, candidates);
  if (!hit) {
    throw new SidekicksError(
      `core update: none of the refs this mount could target resolve in ${before.coreRel}:\n`
      + candidates.map((c) => `  ${c.ref}  (${c.why}; tried as '${c.ref}' and 'origin/${c.ref}')`).join('\n') + '\n'
      + (wantRef
        ? 'Check the tag/branch name against the framework repository.'
        : 'Pass an explicit --ref, or record the intended one with:\n'
          + `  git -C ${repoRootLabel(repoRoot)} config -f .gitmodules submodule.${before.coreRel}.branch <ref>`),
      EXIT_VALIDATION
    );
  }
  const target = hit.resolvedAs;
  const targetSha = hit.sha;
  if (!wantRef && hit.why !== '--ref') {
    notes.push(`no --ref given; took '${hit.ref}' from ${hit.why}`);
  }

  const alreadyThere = targetSha === before.head;

  // ── Preflight: verify the TARGET before mutating anything ───────────────────────────────────────
  // Compatibility used to be judged after the checkout, so an incompatible ref had already replaced
  // the working tree by the time anyone knew — with no way back. Everything needed is readable from
  // the object database once the fetch has landed.
  if (!alreadyThere) {
    const pre = preflightTarget(coreDir, targetSha);
    if (!pre.ok) {
      throw new SidekicksError(
        `core update: '${target}' (${shortSha(targetSha)}) is not a mountable framework core, so it `
        + `was NOT checked out — ${before.coreRel} is untouched at ${shortSha(before.head)}:\n`
        + pre.problems.map((p) => `  - ${p}`).join('\n'),
        EXIT_VALIDATION
      );
    }
  }

  // ── Checkout ────────────────────────────────────────────────────────────────────────────────────
  if (!alreadyThere) {
    git.checkoutRev(coreDir, targetSha);
  }

  const after = inspectCore(repoRoot, coreDir);
  const markerAfter = readCoreMarker(coreDir);

  // ── Hand the tail to the core that just arrived ────────────────────────────────────────────────
  // Re-deriving, recording the tracked ref and staging all describe the NEW release, so they are the
  // new release's code to run (INC-2026-09-04-03, R-1). `supportsFinish` probes for the module by
  // path rather than asking the new core, because parseCoreFlags absorbs unknown flags silently: a
  // pre-handoff core handed `--finish` would drop it and run a whole second update.
  //
  // ROLLBACK is unchanged and now covers a failed handoff too. If the tail throws — in either core —
  // the workspace is already half-reconciled against the new core, so restoring the old SHA is
  // necessary but not sufficient: re-running applyDerived against it is what actually restores the
  // workspace. That works because every surface it writes is derived and idempotent: wiring is
  // rewritten, the overlay is rebuilt from the core's own directory listing, the .gitignore block is
  // regenerated, the enable map re-synced, the push guard re-armed. Nothing accumulates, so
  // prune-then-recreate is self-healing. The gitlink is never staged on this path, so the index
  // still holds the old SHA and needs no repair.
  const rollback = (reason) => {
    if (alreadyThere) throw new SidekicksError(`core update: ${reason}`, EXIT_VALIDATION);
    let restored = false;
    try {
      git.checkoutRev(coreDir, before.head);
      applyDerived(repoRoot, coreDir, ctx.log);
      restored = true;
    } catch (rollbackErr) {
      throw new SidekicksError(
        `core update: applying the new core failed (${reason}), AND rolling back to `
        + `${shortSha(before.head)} failed too (${rollbackErr.message}). ${before.coreRel} is in an `
        + `indeterminate state — restore it by hand:\n`
        + `  git -C ${before.coreRel} checkout --detach ${before.head}\n`
        + `  ${repoRootLabel(repoRoot)}/bin/sidekicks core init`,
        EXIT_VALIDATION
      );
    }
    throw new SidekicksError(
      `core update: '${target}' could not be applied (${reason}).\n`
      + `Rolled back to ${shortSha(before.head)}${restored ? ' and re-applied the previous core' : ''}; `
      + 'the workspace is as it was and nothing was staged.',
      EXIT_VALIDATION
    );
  };

  const stageGitlink = !alreadyThere;
  let fin;
  let finishedByNewCore = false;
  if (supportsFinish(coreDir)) {
    const child = spawnFinish(repoRoot, coreDir, { wantRef, stageGitlink });
    if (!child.ok) rollback(child.reason);
    fin = child.payload;
    finishedByNewCore = true;
  } else {
    try {
      fin = finishUpdate(repoRoot, coreDir, before.coreRel, { wantRef, stageGitlink, log: ctx.log });
    } catch (err) {
      rollback(err.message);
    }
    fin.notes.push(
      'the newly mounted core predates the update handoff, so THIS core\'s rules finished the '
      + 'update — if the doctor below reports wiring or tracked-ref drift, run '
      + '\'sidekicks core init\' and \'git add .gitmodules\''
    );
  }
  const derived = fin.derived;
  const wiring = derived.wiring;
  const synced = derived.sync;
  const guard = derived.guard;
  const staged = fin.staged;
  const toStage = fin.toStage;
  const doctor = fin.doctor;
  notes.push(...fin.notes);

  if (flags.json) {
    const payload = {
      ok: true,
      path: before.coreRel,
      from: { head: before.head, ref: before.describe || before.branch },
      to: { head: after.head, ref: after.describe || target, requested: target },
      // What the ladder actually used, and where the intent came from — so a caller can tell an
      // explicit choice from a fallback instead of inferring one from a detached HEAD.
      tracking: {
        requested: wantRef,
        resolved_from: hit.why,
        ref: hit.ref,
        recorded: wantRef ? readTrackedRef(repoRoot, coreDir, before.coreRel) : tracked,
      },
      changed: !alreadyThere,
      version: markerAfter?.version || null,
      staged,
      committed: false,
      // Which core's code ran the tail. False means the newly mounted core predates the handoff, so
      // the surfaces below were derived by the OUTGOING release's rules — the one situation where a
      // fresh `core init` may still be owed (INC-2026-09-04-03).
      finished_by_new_core: finishedByNewCore,
      // The mount's own doctor, run after everything landed. Never fails the update: the update
      // itself succeeded, and an unattended run must not look broken because the workspace needs a
      // follow-up. Reported so nobody has to guess (R-2).
      doctor,
      wiring: wiring.files,
      skills: { ...derived.skills, repaired: derived.repaired },
      gitignore: derived.gitignore,
      configuration_templates: derived.configurationTemplates,
      configuration_sync: derived.configSync,
      framework_sync: synced ? { added: synced.added } : null,
      push_guard: { pushUrl: guard.pushUrl, pushDefault: guard.pushDefault, hook: guard.hook },
      // Reported, never acted on. An update runs unattended, so it is the LAST place that may
      // create an agent — a pack that arrived in this release is announced and nothing more.
      agent_packs: { available: agentPackHint(repoRoot).count, installed: 0 },
      notes,
    };
    return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: EXIT_OK };
  }

  const out = [];
  if (alreadyThere) {
    out.push(`core update: already at ${after.describe || target} @ ${shortSha(after.head)} — re-applied the derived surfaces`);
  } else {
    out.push(`core update: ${before.coreRel}`);
    out.push(`  ${shortSha(before.head)} -> ${shortSha(after.head)}`
      + `  (${before.describe || before.branch || 'detached'} -> ${after.describe || target})`);
    if (markerAfter?.version) out.push(`  framework version: ${markerAfter.version}`);
  }
  if (wiring.files.length) out.push(`  wiring re-applied: ${wiring.files.join(', ')}`);
  out.push(`  skills: ${derived.skills.linked} linked from the core, ${derived.skills.own} authored here `
    + `(core ships ${derived.skills.coreShips})`);
  if (derived.gitignore.changed) out.push(`  .gitignore block ${derived.gitignore.action}`);
  const templates = derived.configurationTemplates;
  if (templates.created.length || templates.kept.length || templates.obsolete.length) {
    out.push(`  configuration templates: ${templates.created.length} created, ${templates.kept.length} kept, ${templates.obsolete.length} obsolete`);
  }
  if (synced && synced.added.length) {
    out.push(`  framework sync: listed ${synced.added.length} new entr(ies)`);
  }
  out.push(`  push guard: ${guard.pushUrl && guard.pushDefault && guard.hook ? 'armed' : 'INCOMPLETE — run \'sidekicks core doctor\''}`);
  const packLine = agentPackHint(repoRoot).line;
  if (packLine) out.push(`  ${packLine}`);
  if (staged) {
    out.push(`  staged ${toStage.join(' and ')} in the workspace index — NOT committed. Review, then:`);
    out.push(`    git -C ${repoRootLabel(repoRoot)} commit -m "chore: update sidekicks framework core"`);
  }
  out.push(...doctorLines(doctor));
  for (const n of notes) out.push(`  NOTE: ${n}`);

  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}

/**
 * `core update --finish`: the tail, running from the newly mounted core.
 *
 * Deliberately minimal — no fetch, no ref ladder, no checkout, no rollback. The core that invoked
 * this one owns all of those, because they need the pre-checkout world this process cannot see.
 * Output is JSON only: the caller renders it, so there is exactly one report per update.
 *
 * @param {{ repoRoot: string, argv: string[], log: Function }} ctx
 * @param {object} flags
 * @param {string|null} wantRef
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
async function runFinish(ctx, flags, wantRef) {
  const { repoRoot } = ctx;
  const coreDir = requireCore(repoRoot, 'core update --finish');
  const info = inspectCore(repoRoot, coreDir);
  const fin = finishUpdate(repoRoot, coreDir, info.coreRel, {
    wantRef,
    stageGitlink: flags['stage-gitlink'] === true,
    log: ctx.log,
  });
  return {
    stdout: JSON.stringify({
      ok: true,
      derived: fin.derived,
      notes: fin.notes,
      staged: fin.staged,
      toStage: fin.toStage,
      doctor: fin.doctor,
    }, null, 2) + '\n',
    exitCode: EXIT_OK,
  };
}

/**
 * Re-enter the NEWLY MOUNTED core to run the tail, and read back what it did.
 *
 * Through the core's own `bin/sidekicks`, not the workspace shim: the shim resolves the mount at run
 * time and would work, but naming the binary directly makes it unambiguous WHICH core is finishing —
 * the whole point of the handoff.
 *
 * @param {string} repoRoot
 * @param {string} coreDir
 * @param {{wantRef: string|null, stageGitlink: boolean}} opts
 * @returns {{ok: true, payload: object} | {ok: false, reason: string}}
 */
function spawnFinish(repoRoot, coreDir, { wantRef, stageGitlink }) {
  const args = [join(coreDir, 'bin', 'sidekicks'), 'core', 'update', '--finish'];
  if (stageGitlink) args.push('--stage-gitlink');
  if (wantRef) args.push('--ref', wantRef);
  // The env flag turns OFF cli.mjs's ambient overlay self-heal for this one process. finishUpdate's
  // own reconciling pass replaces it, and letting the additive one run first would create links the
  // managed .gitignore block has no record of — which a rollback is then unable to prune.
  const r = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, SIDEKICKS_CORE_UPDATE_FINISH: '1' },
  });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.error) return { ok: false, reason: `the new core could not be run: ${r.error.message}` };
  if (r.status !== 0) {
    const tail = text.split('\n').filter((l) => l.trim()).slice(-4).join(' / ');
    return { ok: false, reason: `the new core's 'core update --finish' exited ${r.status}: ${tail}` };
  }
  let payload;
  try {
    payload = JSON.parse(r.stdout);
  } catch {
    return { ok: false, reason: "the new core's 'core update --finish' produced no readable result" };
  }
  if (!payload || payload.ok !== true || !payload.derived) {
    return { ok: false, reason: "the new core's 'core update --finish' reported no result" };
  }
  // Named for the caller's shape; the child speaks the same field names finishUpdate returns.
  return { ok: true, payload };
}

/**
 * The closing verdict: what the mount's own doctor found, and the exact command that fixes it.
 *
 * @param {{total: number, failed: Array<{check: string, detail: string, fix: string|null}>}} doctor
 * @returns {string[]}
 */
function doctorLines(doctor) {
  if (!doctor || !Array.isArray(doctor.failed)) return [];
  if (doctor.failed.length === 0) return [`  core doctor: ${doctor.total} checks passed`];
  const width = Math.max(...doctor.failed.map((c) => c.check.length));
  const out = [`  core doctor: ${doctor.failed.length} of ${doctor.total} checks need attention`];
  for (const c of doctor.failed) {
    out.push(`    ${c.check.padEnd(width)}  ${c.detail}`);
    if (c.fix) out.push(`    ${' '.repeat(width)}  fix: ${c.fix}`);
  }
  return out;
}

/** '.' for the workspace root — the command shown is meant to be copy-pasteable from anywhere. */
function repoRootLabel(repoRoot) {
  return repoRoot === process.cwd() ? '.' : repoRoot;
}
