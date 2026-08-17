// lib/service-lifecycle/pull.mjs
// Implements `sidekicks service pull [<service-name>] [<branch>]`.
//
// On-demand acquisition of a service's code. `service add` registers a service and records
// its remote_source but deliberately does NOT fetch the code — pull is the step the user
// runs when the working tree is actually needed. It populates the service's src/ from the
// recorded remote_source and writes back the resolved branch/commit.
//
// Acquisition mode mirrors the historical `add` behaviour and branches on the PROJECT
// manifest.remote_source (i.e. whether the project is itself a git repo):
//   project has remote_source → git submodule add (stages, NO commit)
//   project remote_source null → git clone
//
// Branch defaults to "main" and may be overridden positionally. If the ref does not exist
// on the remote, git fails and we surface EXIT_GIT advising an explicit <branch>.
//
// Preconditions (in order):
//   1. active project ≠ root → EXIT_VALIDATION
//   2. resolve target service name (named arg || active_service || EXIT_VALIDATION)
//   3. projects/<active>/services/<target>/ exists as directory → EXIT_VALIDATION
//   4. service.yaml exists and records a remote_source → EXIT_VALIDATION
//   5. git on PATH → EXIT_GIT
//   6. src/ is NOT already a working tree (no clobber) → EXIT_VALIDATION
//
// On failure: rmrf(serviceDir/src) + (SUBMODULE) submoduleAbort → EXIT_GIT. The service's
// docs/ and service.yaml are preserved — only the partial src/ is rolled back.
// On success: read currentBranch + headCommit from src/ → setBranchCommit. Active-scope
// pointers are NOT modified.
//
// Zero npm dependencies — node:fs, node:path only (plus relative lib/ imports).
// All git spawns delegated to git-delegation/git.mjs; shell: false everywhere.

import { statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SidekicksError,
  EXIT_OK,
  EXIT_VALIDATION,
  EXIT_GIT,
} from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { rmrf } from '../fs-safety/fsx.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { read as readManifest } from '../manifest-schema/manifest.mjs';
import { setBranchCommit } from '../manifest-schema/service.mjs';
import { parse } from '../yaml-subset/yaml.mjs';
import {
  whichGit,
  isRepo,
  clone,
  submoduleAdd,
  submoduleAbort,
  submoduleUpdateInit,
  submoduleDeinit,
  rootSubmoduleHas,
  checkout,
  currentBranch,
  headCommit,
} from '../git-delegation/git.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { rebuildProjectIndex } from '../scope-index/index.mjs';

const DEFAULT_BRANCH = 'main';

/**
 * Execute the `service pull [<service-name>] [<branch>]` verb.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string|undefined, rest: string[], flags: object }} args
 *   - args.name    → [<service-name>] (optional; defaults to active service)
 *   - args.rest[0] → [<branch>]       (optional; defaults to "main")
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  const optServiceName =
    args && args.name != null && String(args.name).trim() !== ''
      ? String(args.name).trim()
      : null;
  const branch =
    args && args.rest && args.rest[0] != null && String(args.rest[0]).trim() !== ''
      ? String(args.rest[0]).trim()
      : DEFAULT_BRANCH;

  // ── Precondition 1: active project ≠ root ─────────────────────────────────
  const settings = readSettings(repoRoot);
  const scope = resolveEffectiveScope(settings);

  if (scope.projectName === 'sidekicks') {
    throw new SidekicksError(
      "service pull requires an active user project; switch with 'project use <name>' first",
      EXIT_VALIDATION
    );
  }

  // ── Precondition 2: resolve target service name ────────────────────────────
  const target = optServiceName || settings.active_service || null;
  if (!target) {
    throw new SidekicksError(
      "service pull requires an active service or a <service-name> argument; " +
        "activate one with 'service use <name>' or pass the name explicitly",
      EXIT_VALIDATION
    );
  }

  // ── Precondition 3: service directory must exist ───────────────────────────
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

  // ── Precondition 4: service.yaml exists and records a remote_source ────────
  const serviceYamlPath = join(serviceDir, 'service.yaml');
  if (!existsSync(serviceYamlPath)) {
    throw new SidekicksError(
      `service.yaml not found at 'projects/${scope.projectName}/services/${target}/service.yaml'`,
      EXIT_VALIDATION
    );
  }

  let serviceObj;
  try {
    serviceObj = parse(readFileSync(serviceYamlPath, 'utf8'));
  } catch (err) {
    throw new SidekicksError(
      `service.yaml at '${serviceYamlPath}' is not valid YAML: ${err.message}`,
      EXIT_VALIDATION
    );
  }

  const url = serviceObj && serviceObj.remote_source ? String(serviceObj.remote_source) : null;
  if (!url) {
    throw new SidekicksError(
      `service '${target}' has no remote_source recorded — nothing to pull. ` +
        'Record a git URL in service.yaml (or re-add with a URL) before pulling.',
      EXIT_VALIDATION
    );
  }

  // ── Precondition 5: git on PATH ───────────────────────────────────────────
  if (whichGit() === null) {
    throw new SidekicksError(
      "git is required for 'service pull' — install git and ensure it is on PATH",
      EXIT_GIT
    );
  }

  // ── Precondition 6: src/ must NOT already be populated (no clobber) ────────
  const srcDir = join(serviceDir, 'src');
  const relPath = join('services', target, 'src');
  // A registered submodule whose working tree was freed (deinit'd) leaves an empty,
  // still-registered slot — that is a re-populate case, not a clobber.
  const registeredSubmodule = rootSubmoduleHas(projectDir, relPath);

  if (isRepo(srcDir)) {
    throw new SidekicksError(
      `'${srcDir}' is already a git working tree — already pulled. ` +
        "Use 'service checkout <branch>' to switch branches or 'service sync' to refresh state.",
      EXIT_VALIDATION
    );
  }
  if (existsSync(srcDir) && !registeredSubmodule) {
    throw new SidekicksError(
      `'${srcDir}' already exists but is not a git working tree — remove it before pulling.`,
      EXIT_VALIDATION
    );
  }

  // ── Determine acquisition mode ────────────────────────────────────────────
  //   RESTORE   → re-populate a previously-freed (deinit'd) submodule from its
  //               existing registration; network-fetch, no re-add, no commit.
  //   SUBMODULE → add a brand-new submodule (project is its own repo / has remote).
  //   CLONE     → plain clone into src/.
  const manifestPath = join(projectDir, 'manifest.yaml');
  const manifestObj = readManifest(manifestPath);
  const mode = registeredSubmodule ? 'RESTORE'
    : manifestObj.remote_source ? 'SUBMODULE'
    : 'CLONE';

  const branchExplicit =
    args && args.rest && args.rest[0] != null && String(args.rest[0]).trim() !== '';

  // fs-guard check on the service directory before any write (invariant).
  assertWritable(serviceDir, repoRoot);

  // ── Attempt acquisition ───────────────────────────────────────────────────
  try {
    if (mode === 'CLONE') {
      clone(url, srcDir, branch);
    } else if (mode === 'SUBMODULE') {
      submoduleAdd(url, relPath, projectDir, branch);
    } else {
      // RESTORE: re-populate the existing submodule registration at its pinned commit.
      submoduleUpdateInit(relPath, projectDir);
      // update --init checks out the pinned commit (detached HEAD). Return to the
      // branch the service was on (or an explicit override) so state matches a fresh
      // pull; best-effort — leave the pinned detached HEAD if that branch is gone.
      const restoreBranch = branchExplicit
        ? branch
        : (serviceObj.branch && serviceObj.branch !== 'HEAD' ? String(serviceObj.branch) : null);
      if (restoreBranch) {
        try { checkout(srcDir, restoreBranch); } catch { /* leave at pinned commit */ }
      }
    }
  } catch (err) {
    // Roll back only the partial src/ — keep docs/ and service.yaml intact.
    if (mode === 'RESTORE') {
      // Return the slot to its emptied/deinit'd state WITHOUT deregistering it.
      try { submoduleDeinit(relPath, projectDir); } catch { /* best-effort */ }
      try { rmrf(srcDir); } catch { /* best-effort */ }
    } else {
      try { rmrf(srcDir); } catch { /* best-effort */ }
      if (mode === 'SUBMODULE') {
        submoduleAbort(relPath, projectDir);
      }
    }
    if (err instanceof SidekicksError) {
      throw new SidekicksError(
        `${err.message} (could not pull branch '${branch}' — pass an explicit <branch> if it differs)`,
        EXIT_GIT
      );
    }
    throw new SidekicksError(
      err.message || 'git acquisition failed',
      EXIT_GIT
    );
  }

  // ── Read git state from the freshly acquired src/ ─────────────────────────
  const resolvedBranch = currentBranch(srcDir); // literal "HEAD" for detached state
  const commit = headCommit(srcDir);

  // ── Atomic partial rewrite: only branch + commit ──────────────────────────
  assertWritable(serviceYamlPath, repoRoot);
  setBranchCommit(serviceYamlPath, resolvedBranch, commit);

  // ── Rebuild project index (Epic 4, Story 4.2) ────────────────────────────
  // Tail-call after all mutations succeed. Only the owning project's index is
  // rebuilt; the root index is left untouched (service verbs are project-level).
  // Best-effort wrapping is added in Story 4.3 — errors propagate here.
  rebuildProjectIndex(repoRoot, scope.projectName);

  const modeLabel = mode === 'RESTORE' ? 'submodule restore' : mode.toLowerCase();
  return {
    stdout: `Pulled '${target}' into src/ on branch '${resolvedBranch}' (${modeLabel}).\n`,
    exitCode: EXIT_OK,
  };
}
