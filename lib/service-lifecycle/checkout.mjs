// lib/service-lifecycle/checkout.mjs
// Implements `sidekicks service checkout <branch> [<service-name>] [--create]`.
// Branch switch/create that keeps service.yaml in sync.
//
// Motivation: switching or creating a branch in a service's src/ working tree via raw
// `git checkout` leaves service.yaml's branch/commit fields stale. This verb mediates
// the operation — it performs the checkout AND rewrites service.yaml branch+commit in
// one step, so the manifest never drifts from the working tree (Rule 1: the CLI mediates
// structural writes under projects/<name>/).
//
// Preconditions (in order — mirrors `service sync`):
//   1. active project ≠ root → EXIT_VALIDATION
//   2. <branch> argument present → EXIT_VALIDATION
//   3. resolve target service name ([<service-name>] || active_service || EXIT_VALIDATION)
//   4. projects/<active>/services/<target>/ exists as directory → EXIT_VALIDATION
//   5. service.yaml exists → EXIT_VALIDATION
//   6. git on PATH → EXIT_GIT
//   7. src/ is a git working tree (git.isRepo) → EXIT_VALIDATION
//   8. src/ has no uncommitted TRACKED changes, unless --allow-dirty → EXIT_VALIDATION
//      (a HEAD move in a shared checkout is how in-flight work gets lost; a sibling
//       worktree is the non-destructive alternative the error names)
//
// Then: git checkout (with -b when --create) → re-read currentBranch + headCommit →
// fs-guard check → setBranchCommit. Active-scope pointers are NOT modified (no
// settings.json write) — switching a branch does not change which service is active.
// Zero npm dependencies — node:fs, node:path only (plus relative lib/ imports).
// All git spawns delegated to git-delegation/git.mjs; shell: false everywhere.

import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  SidekicksError,
  EXIT_OK,
  EXIT_VALIDATION,
  EXIT_GIT,
} from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { setBranchCommit } from '../manifest-schema/service.mjs';
import {
  whichGit,
  isRepo,
  checkout,
  currentBranch,
  headCommit,
  hasTrackedChanges,
} from '../git-delegation/git.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { rebuildProjectIndex } from '../scope-index/index.mjs';

/**
 * Execute the `service checkout <branch> [<service-name>] [--create]` verb.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string|undefined, rest: string[], flags: object }} args
 *   - args.name    → <branch> (first positional — required)
 *   - args.rest[0] → [<service-name>] (optional; defaults to active service)
 *   - args.flags.create → --create (create the branch with `git checkout -b`)
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  // ── Precondition 2: <branch> argument present ─────────────────────────────
  const branch =
    args && args.name != null && String(args.name).trim() !== ''
      ? String(args.name).trim()
      : null;
  if (!branch) {
    throw new SidekicksError(
      'service checkout requires a <branch> argument',
      EXIT_VALIDATION
    );
  }

  const create = Boolean(args && args.flags && args.flags.create);

  // Optional [<service-name>] — second positional after the branch.
  const optServiceName =
    args && Array.isArray(args.rest) && args.rest[0] != null && String(args.rest[0]).trim() !== ''
      ? String(args.rest[0]).trim()
      : null;

  // ── Precondition 1: active project ≠ root ─────────────────────────────────
  const settings = readSettings(repoRoot);
  const scope = resolveEffectiveScope(settings);

  if (scope.projectName === 'sidekicks') {
    throw new SidekicksError(
      "service checkout requires an active user project; switch with 'project use <name>' first",
      EXIT_VALIDATION
    );
  }

  // ── Precondition 3: resolve target service name ────────────────────────────
  const target = optServiceName || settings.active_service || null;
  if (!target) {
    throw new SidekicksError(
      "service checkout requires an active service or a <service-name> argument; " +
        "activate one with 'service use <name>' or pass the name explicitly",
      EXIT_VALIDATION
    );
  }

  // ── Precondition 4: service directory must exist ───────────────────────────
  const projectDir = join(repoRoot, 'projects', scope.projectName);
  const serviceDir = join(projectDir, 'services', target);

  let stat;
  try { stat = statSync(serviceDir); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) {
    throw new SidekicksError(
      `service directory 'projects/${scope.projectName}/services/${target}/' does not exist`,
      EXIT_VALIDATION
    );
  }

  // ── Precondition 5: service.yaml must exist ────────────────────────────────
  const serviceYamlPath = join(serviceDir, 'service.yaml');
  if (!existsSync(serviceYamlPath)) {
    throw new SidekicksError(
      `service.yaml not found at 'projects/${scope.projectName}/services/${target}/service.yaml'`,
      EXIT_VALIDATION
    );
  }

  // ── Precondition 6: git on PATH ───────────────────────────────────────────
  if (whichGit() === null) {
    throw new SidekicksError(
      "git is required for 'service checkout' — install git and ensure it is on PATH",
      EXIT_GIT
    );
  }

  // ── Precondition 7: src/ is a git working tree ────────────────────────────
  // isRepo returns false (does NOT throw) for absent or non-repo paths. It also
  // guards against the leak where git run from a plain subdir walks up to the
  // PARENT repo — only the service's own src/ checkout is its own repo.
  const srcDir = join(serviceDir, 'src');
  if (!isRepo(srcDir)) {
    throw new SidekicksError(
      `'${srcDir}' is not a git working tree (src/ absent or not a repo); ` +
        "re-run 'service add' or manually restore the source checkout",
      EXIT_VALIDATION
    );
  }

  // ── Precondition 8: the src/ tree carries no uncommitted tracked work ─────
  // git only refuses a checkout when the changes would be OVERWRITTEN; otherwise it
  // carries them over and moves HEAD, swapping files underneath anything else live in
  // this shared checkout (a second agent CLI session, a dev server, a running build).
  // A sibling worktree moves no HEAD, so that is the answer offered here (CLAUDE.md →
  // "Protected branches", "Git worktrees"). --allow-dirty is the explicit override.
  const allowDirty = Boolean(args && args.flags && args.flags['allow-dirty']);
  if (!allowDirty && hasTrackedChanges(srcDir)) {
    throw new SidekicksError(
      `'${srcDir}' has uncommitted tracked changes — refusing to move HEAD in a shared ` +
        'working tree. Create the branch in a sibling worktree instead: ' +
        `git -C ${srcDir} worktree add ../worktrees/${branch.replace(/[\\/]/g, '-')} ` +
        `${create ? '-b ' : ''}${branch}  (or commit here first, or pass --allow-dirty if you ` +
        'are certain nothing else is using this checkout)',
      EXIT_VALIDATION
    );
  }

  // ── Perform the checkout (create or switch) — local git op ────────
  // git's own refusal (branch missing without --create, branch exists with
  // --create, dirty tree that would be overwritten) surfaces as EXIT_GIT.
  checkout(srcDir, branch, { create });

  // ── Re-read git state and record it — keeps service.yaml from drifting ─────
  // currentBranch returns "HEAD" for detached state (never null); after a named
  // checkout it is the branch we just switched to.
  const newBranch = currentBranch(srcDir);
  const newCommit = headCommit(srcDir);

  // ── fs-guard check before write (invariant) ─────────────────────────
  assertWritable(serviceYamlPath, repoRoot);

  // ── Atomic partial rewrite: only branch + commit (preserves name/remote/overrides)
  setBranchCommit(serviceYamlPath, newBranch, newCommit);

  // ── Rebuild project index (Epic 4, Story 4.2) ────────────────────────────
  // Tail-call after all mutations succeed. Only the owning project's index is
  // rebuilt; the root index is left untouched (service verbs are project-level).
  // Best-effort wrapping is added in Story 4.3 — errors propagate here.
  rebuildProjectIndex(repoRoot, scope.projectName);

  return {
    stdout: `${target}: ${newBranch} (${newCommit.slice(0, 7)})\n`,
    exitCode: EXIT_OK,
  };
}
