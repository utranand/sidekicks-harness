// lib/core-lifecycle/_ref.mjs
// Which ref the mounted core is supposed to track, and whether a target is safe to check out.
//
// THE DEFECT. Every installer leaves the core on a DETACHED HEAD — that is what "pinned to v1.2.0"
// means, and it is correct. But `core update` then read the tracking intent back off the checkout:
// `before.branch` is always the literal `HEAD` on a detached head, so the branch rung was skipped and
// every update fell through to `origin/main`. A core deliberately installed from `--ref next` moved
// itself onto main at the first update, silently. Nothing recorded what had been asked for.
//
// WHERE THE INTENT LIVES. `.gitmodules` → `submodule.<path>.branch`. It is git's own field for this,
// it is COMMITTED (so it travels to another clone of the workspace, which repository-local config
// does not), and both installers can write it in one line with no JSON:
//     git config -f .gitmodules submodule.<path>.branch <ref>
// Repository-local `sidekicks.trackedRef` on the core sits above it as a per-machine override.
//
// Explicitly NOT used:
//   - `.sidekicks/state/` — state is "REBUILT, never edited" and per-machine (lib/state-store/
//     paths.mjs). Tracking intent is a user decision and is not rebuildable from anything.
//   - `.sidekicks/settings.json` — that file answers "what is active on THIS machine".
//   - `.sidekicks-core.json` — the FORGE writes it; it describes the core, not the workspace's
//     intent, and a checkout overwrites it.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import * as git from '../git-delegation/git.mjs';

/** Repository-local override key, set on the CORE checkout. */
export const TRACKED_REF_KEY = 'sidekicks.trackedRef';

/** Files a tree must contain to be a mountable core, checked BEFORE anything is checked out. */
const REQUIRED_PATHS = Object.freeze([
  'bin/sidekicks',
  'lib/sk-cli/cli.mjs',
]);

/** The core marker layout this code knows how to consume. */
const SUPPORTED_LAYOUT = 1;

/**
 * The ref this mount is meant to track, highest-priority source first.
 *
 * @param {string} repoRoot
 * @param {string} coreDir
 * @param {string} coreRel - the submodule path as recorded in .gitmodules
 * @returns {{ref: string, source: string}|null}
 */
export function readTrackedRef(repoRoot, coreDir, coreRel) {
  const local = git.getLocalConfig(coreDir, TRACKED_REF_KEY);
  if (local) return { ref: local, source: `${TRACKED_REF_KEY} (this machine)` };
  const declared = git.submoduleBranch(repoRoot, coreRel);
  if (declared) return { ref: declared, source: '.gitmodules' };
  return null;
}

/**
 * Record the ref this mount tracks, in both places.
 *
 * Called after a SUCCESSFUL `--ref` update. This write — not the read side — is the actual fix for
 * "the installer detaches and the intent is lost": until something persists what was asked for,
 * every later update has only the detached HEAD to go on, and a detached HEAD remembers nothing.
 *
 * Best-effort: a workspace that is not a git repo, or a core with no writable config, still gets a
 * working update. The caller reports what could not be recorded rather than failing the whole verb.
 *
 * @param {string} repoRoot
 * @param {string} coreDir
 * @param {string} coreRel
 * @param {string} ref
 * @returns {string[]} notes about anything that could not be recorded
 */
export function writeTrackedRef(repoRoot, coreDir, coreRel, ref) {
  const notes = [];
  try {
    git.setLocalConfig(coreDir, TRACKED_REF_KEY, ref);
  } catch (err) {
    notes.push(`could not record the tracked ref on the core (${err.message})`);
  }
  if (!git.setSubmoduleBranch(repoRoot, coreRel, ref)) {
    notes.push('could not record the tracked ref in .gitmodules — a fresh clone of this workspace '
      + `will not know it tracks '${ref}'`);
  }
  return notes;
}

/**
 * Build the ordered list of refs to try, most specific first.
 *
 * @param {{wantRef: string|null, tracked: {ref: string, source: string}|null, branch: string|null}} opts
 * @returns {Array<{ref: string, why: string}>}
 */
export function refCandidates({ wantRef, tracked, branch }) {
  // An explicit --ref is a REQUEST, not a preference. If it does not resolve, the answer is an error
  // naming what was tried — never a quiet landing on some other ref the operator did not ask for.
  // The whole point of this ladder is to stop silent retargeting; falling back from --ref would
  // reintroduce it in a more surprising place.
  if (wantRef) return [{ ref: wantRef, why: '--ref' }];

  const out = [];
  if (tracked) out.push({ ref: tracked.ref, why: `recorded in ${tracked.source}` });
  // A detached HEAD reports the literal 'HEAD', which names nothing — skip it rather than compose
  // `origin/HEAD`, which resolves to whatever the remote's default branch happens to be.
  if (branch && branch !== 'HEAD') out.push({ ref: branch, why: 'the branch this mount is on' });
  out.push({ ref: 'main', why: 'the default' });
  // De-duplicate, keeping the highest-priority reason for each ref.
  const seen = new Set();
  return out.filter((c) => (seen.has(c.ref) ? false : (seen.add(c.ref), true)));
}

/**
 * Resolve one candidate to a SHA, trying the bare ref then `origin/<ref>`.
 *
 * The two-rung sub-ladder is what the installers always had (`<ref>^{commit}`, then
 * `origin/<ref>^{commit}`) and `core update` never did — which is why `--ref next` failed against a
 * branch that exists only on the remote, despite branches being an advertised input. `revParse`
 * already appends `^{commit}`, so this is free.
 *
 * @param {string} coreDir
 * @param {string} ref
 * @returns {{sha: string, resolvedAs: string}|null}
 */
export function resolveRef(coreDir, ref) {
  const direct = git.revParse(coreDir, ref);
  if (direct) return { sha: direct, resolvedAs: ref };
  const remote = git.revParse(coreDir, `origin/${ref}`);
  if (remote) return { sha: remote, resolvedAs: `origin/${ref}` };
  return null;
}

/**
 * Walk the candidate ladder and return the first ref that resolves.
 *
 * @param {string} coreDir
 * @param {Array<{ref: string, why: string}>} candidates
 * @returns {{ref: string, why: string, sha: string, resolvedAs: string}|null}
 */
export function resolveFirst(coreDir, candidates) {
  for (const c of candidates) {
    const hit = resolveRef(coreDir, c.ref);
    if (hit) return { ...c, ...hit };
  }
  return null;
}

/**
 * Validate a target tree WITHOUT checking it out.
 *
 * Validation used to happen after `git checkout`, so a ref that turned out to be incompatible had
 * already replaced the working tree — and there was no rollback. Everything needed is readable from
 * the object database once the fetch has landed, so the whole check moves in front of the mutation.
 *
 * `showBlob` rather than `cat-file -e`: existence proves a path is there, but `layout` and `version`
 * are the fields that decide compatibility, and only reading the blob answers those.
 *
 * @param {string} coreDir
 * @param {string} sha
 * @returns {{ok: boolean, version: string|null, layout: number|null, problems: string[]}}
 */
export function preflightTarget(coreDir, sha) {
  const problems = [];

  const raw = git.showBlob(coreDir, sha, '.sidekicks-core.json');
  let marker = null;
  if (!raw) {
    problems.push('it carries no .sidekicks-core.json marker, so it is not a framework core');
  } else {
    try {
      marker = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      problems.push(`its .sidekicks-core.json does not parse (${err.message})`);
    }
  }
  if (marker) {
    if (!marker.version) problems.push('its marker records no version');
    if (marker.layout != null && marker.layout !== SUPPORTED_LAYOUT) {
      problems.push(`its marker declares layout ${marker.layout}, and this workspace understands `
        + `layout ${SUPPORTED_LAYOUT} — update the workspace's framework before moving to it`);
    }
  }

  for (const rel of REQUIRED_PATHS) {
    if (!git.showBlob(coreDir, sha, rel)) problems.push(`it has no ${rel}`);
  }

  return {
    ok: problems.length === 0,
    version: marker?.version ?? null,
    layout: marker?.layout ?? null,
    problems,
  };
}
