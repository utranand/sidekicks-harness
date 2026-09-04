// lib/core-lifecycle/_finish.mjs
// The tail of `core update` — everything that happens AFTER the new core's files are on disk.
//
// THIS FILE'S EXISTENCE IS A PROTOCOL VERSION. `core update` is a verb of the core being replaced:
// the workspace shim forwards into the mount, so once `git checkout` has put the NEW release's files
// there, it is still the OLD release's code that re-derives the workspace from them. Every fix that
// lives in this tail therefore skipped the very update that installed it — v1.4.2's rewrite table
// had no rule for the env-var-anchored hook path v1.4.3 introduced, and v1.4.2's staging step did
// not know `.gitmodules` existed, so upgrading to v1.4.3 reproduced both defects v1.4.3 fixed
// (INC-2026-09-04-03, U-1/U-2).
//
// So the old core hands the tail over. It cannot ASK the new core whether it understands the
// handoff: parseCoreFlags (_shared.mjs) has no reject path and silently absorbs an unknown flag, so
// a pre-handoff core given `core update --finish` would drop the flag and run a second complete
// update. The probe is this module's presence on disk instead — readable without executing anything,
// and impossible for an older core to fake. Moving or renaming this file BREAKS that probe: every
// already-released core looks for it at exactly this path.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as git from '../git-delegation/git.mjs';
import { applyDerived } from './_derive.mjs';
import { writeTrackedRef } from './_ref.mjs';
import { coreChecks } from './doctor.mjs';

/**
 * The repo-relative path an older core probes to decide whether the newly mounted core can finish
 * its own update. Named here so the two ends of the protocol read the same constant.
 */
export const FINISH_MODULE_REL = 'lib/core-lifecycle/_finish.mjs';

/**
 * Does the core mounted at `coreDir` carry the update handoff?
 *
 * @param {string} coreDir
 * @returns {boolean}
 */
export function supportsFinish(coreDir) {
  return existsSync(join(coreDir, ...FINISH_MODULE_REL.split('/')));
}

/**
 * Re-derive the workspace, record the tracked ref, stage what the update owns, and report what the
 * mount's own doctor now thinks.
 *
 * Extracted verbatim from `core update`'s body so the two paths — handed off to the new core, or run
 * in-process when the new core predates the handoff — cannot drift.
 *
 * @param {string} repoRoot
 * @param {string} coreDir
 * @param {string} coreRel - the mount's repo-relative path (inspectCore().coreRel)
 * @param {{wantRef?: string|null, stageGitlink?: boolean, log?: Function}} [opts]
 * @returns {{
 *   derived: object, notes: string[], staged: boolean, toStage: string[],
 *   doctor: {total: number, failed: Array<{check: string, detail: string, fix: string|null}>},
 * }}
 */
export function finishUpdate(repoRoot, coreDir, coreRel, opts = {}) {
  const { wantRef = null, stageGitlink = true, log = () => {} } = opts;
  const notes = [];

  // Throws on failure. The caller owns the rollback, because only it knows the sha to go back to.
  const derived = applyDerived(repoRoot, coreDir, log);
  notes.push(...derived.notes);

  // Only for an explicit --ref: that is the moment the operator STATED an intent. Writing back what
  // the ladder merely inferred would turn a fallback into a decision nobody made.
  if (wantRef) notes.push(...writeTrackedRef(repoRoot, coreDir, coreRel, wantRef));

  // ── Stage the gitlink AND .gitmodules, never commit ────────────────────────────────────────────
  //
  // .gitmodules is here because writeTrackedRef above only writes the WORKTREE copy: `git config -f`
  // edits a file, and nothing in lib/ stages on its own (git.mjs setSubmoduleBranch says so). That
  // left `git commit` recording a pin whose tracked ref was absent from the committed file — so a
  // fresh clone read no branch key and `core update` fell back to main, silently retargeting the
  // workspace. The gitlink was already the documented exception to "the CLI never commits the
  // workspace's history"; staging the file that DESCRIBES that gitlink is the same exception, and
  // half of it was missing.
  //
  // `stageGitlink` is false when the mount was already at the target sha: there is no gitlink change
  // to stage — but --ref may still have just written a NEW tracked ref, which is exactly the
  // "re-pin an already-correct mount" case that recorded nothing.
  let staged = false;
  const toStage = [];
  if (stageGitlink) toStage.push(coreRel);
  if (wantRef && existsSync(join(repoRoot, '.gitmodules'))) toStage.push('.gitmodules');
  if (toStage.length) {
    try {
      git.addPaths(repoRoot, toStage);
      staged = true;
    } catch (err) {
      notes.push(`could not stage ${toStage.join(' and ')} (${err.message}) — stage them by hand`);
    }
  }

  // ── Say what is still wrong ────────────────────────────────────────────────────────────────────
  // The doctor that runs here is the NEWLY MOUNTED core's, whichever core drove the update. That is
  // what makes it the safety net for the case the handoff itself cannot cover: upgrading FROM a core
  // that predates this module still finishes with the old rules, but the check that follows is the
  // new release's and names the fix (INC-2026-09-04-03, R-2).
  const checks = coreChecks(repoRoot, coreDir);
  const failed = checks.filter((c) => !c.ok)
    .map((c) => ({ check: c.check, detail: c.detail, fix: c.fix }));

  return { derived, notes, staged, toStage, doctor: { total: checks.length, failed } };
}
