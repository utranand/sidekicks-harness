// lib/branch-lifecycle/resolve.mjs
// Shared resolution + post-move sync for the scope-aware `branch` namespace.
//
// The `branch` verbs (list / current / create / switch / delete) all operate on
// the SAME git working tree: the one the active scope resolves to. This module
// centralizes that resolution and the precondition gauntlet so each verb stays a
// thin shell.
//
// Target repo by active scope (mirrors `scope working-folder`):
//   - root project (`sidekicks`) active → REJECTED. Branch ops are "on a project
//       or service"; the substrate does not manage the root repo's branches as a
//       scope. Switch with `project use <name>` first.
//   - user project active, no service   → projects/<project>/        (the project's own repo)
//   - user project + service active      → projects/<project>/services/<service>/src/
//
// Preconditions (in order), all fail-fast before any git op:
//   1. active project ≠ root → EXIT_VALIDATION
//   2. projects/<project>/ exists as a directory → EXIT_VALIDATION
//   3. (service scope only) services/<service>/ exists + service.yaml present → EXIT_VALIDATION
//   4. git on PATH → EXIT_GIT
//   5. target dir is its OWN git working tree (git.isRepo — toplevel equality, so a
//      plain project dir inside the root repo is NOT mistaken for a repo) → EXIT_VALIDATION
//
// syncAfterMove(): called by verbs that move HEAD (switch, create --switch). For a
// SERVICE target it rewrites service.yaml branch+commit (setBranchCommit) and rebuilds
// the owning project index — exactly mirroring `service checkout`, so the manifest never
// drifts from the working tree. For a PROJECT target there is no branch field in the
// manifest to update (projects record remote_source only), so it is a no-op beyond reading
// back the new state for the caller's report.
//
// Zero npm dependencies — node:fs, node:path only (plus relative lib/ imports).
// All git spawns delegated to git-delegation/git.mjs; shell: false everywhere.

import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  SidekicksError,
  EXIT_VALIDATION,
  EXIT_GIT,
} from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { setBranchCommit } from '../manifest-schema/service.mjs';
import {
  whichGit,
  isRepo,
  currentBranch,
  headCommit,
} from '../git-delegation/git.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { rebuildProjectIndex } from '../scope-index/index.mjs';

/**
 * Resolve and validate the git working tree the active scope's branch ops apply to.
 *
 * @param {string} repoRoot - Absolute repository root.
 * @param {string} verb     - The verb name (for error message wording, e.g. "switch").
 * @returns {{
 *   projectName: string,
 *   serviceName: string | null,
 *   label: string,            // service name when a service is active, else project name
 *   repoDir: string,          // absolute path to the git working tree to operate on
 *   serviceYamlPath: string | null  // set only for a service target (drives sync)
 * }}
 * @throws {SidekicksError} on any precondition failure.
 */
export function resolveBranchTarget(repoRoot, verb) {
  const settings = readSettings(repoRoot);
  const scope = resolveEffectiveScope(settings);

  // ── Precondition 1: active project ≠ root ─────────────────────────────────
  if (scope.projectName === 'sidekicks') {
    throw new SidekicksError(
      `branch ${verb} requires an active user project or service; ` +
        "switch with 'project use <name>' (and optionally 'service use <name>') first",
      EXIT_VALIDATION
    );
  }

  // ── Precondition 2: projects/<project>/ exists ────────────────────────────
  const projectDir = join(repoRoot, 'projects', scope.projectName);
  let pStat;
  try { pStat = statSync(projectDir); } catch { pStat = null; }
  if (!pStat || !pStat.isDirectory()) {
    throw new SidekicksError(
      `active project directory 'projects/${scope.projectName}/' does not exist (stale pointer)`,
      EXIT_VALIDATION
    );
  }

  let repoDir;
  let serviceYamlPath = null;
  let label;

  if (scope.serviceName) {
    // ── Precondition 3: services/<service>/ exists + service.yaml present ───
    const serviceDir = join(projectDir, 'services', scope.serviceName);
    let sStat;
    try { sStat = statSync(serviceDir); } catch { sStat = null; }
    if (!sStat || !sStat.isDirectory()) {
      throw new SidekicksError(
        `service directory 'projects/${scope.projectName}/services/${scope.serviceName}/' does not exist`,
        EXIT_VALIDATION
      );
    }
    serviceYamlPath = join(serviceDir, 'service.yaml');
    if (!existsSync(serviceYamlPath)) {
      throw new SidekicksError(
        `service.yaml not found at 'projects/${scope.projectName}/services/${scope.serviceName}/service.yaml'`,
        EXIT_VALIDATION
      );
    }
    repoDir = join(serviceDir, 'src');
    label = scope.serviceName;
  } else {
    repoDir = projectDir;
    label = scope.projectName;
  }

  // ── Precondition 4: git on PATH ───────────────────────────────────────────
  if (whichGit() === null) {
    throw new SidekicksError(
      `git is required for 'branch ${verb}' — install git and ensure it is on PATH`,
      EXIT_GIT
    );
  }

  // ── Precondition 5: target is its OWN git working tree ────────────────────
  // isRepo is the toplevel-equality check (NOT a walk-up), so a plain project dir
  // inside the substrate's root repo is correctly reported as NOT its own repo
  // rather than leaking the root repo's branches.
  if (!isRepo(repoDir)) {
    const hint = scope.serviceName
      ? "pull the service first ('service pull') or restore its src/ checkout"
      : "initialize the project repo first ('project set-remote <git-url>' or 'git init' in the project)";
    throw new SidekicksError(
      `'${repoDir}' is not a git working tree — ${hint}`,
      EXIT_VALIDATION
    );
  }

  return {
    projectName: scope.projectName,
    serviceName: scope.serviceName,
    label,
    repoDir,
    serviceYamlPath,
  };
}

/**
 * Persist the post-move git state into Sidekicks metadata and rebuild the index.
 *
 * Called by verbs that move HEAD (switch, create --switch). Reads the now-current
 * branch + HEAD commit from the target and:
 *   - SERVICE target → rewrites service.yaml branch+commit + rebuilds the project index.
 *   - PROJECT target → no manifest field to update; reads state back for the report only.
 *
 * @param {string} repoRoot
 * @param {{ projectName: string, repoDir: string, serviceYamlPath: string | null }} target
 * @returns {{ branch: string, commit: string }} the freshly-read git state.
 * @throws {SidekicksError} on git or write failure.
 */
export function syncAfterMove(repoRoot, target) {
  // currentBranch returns "HEAD" for detached state (never null).
  const branch = currentBranch(target.repoDir);
  const commit = headCommit(target.repoDir);

  if (target.serviceYamlPath) {
    assertWritable(target.serviceYamlPath, repoRoot);
    setBranchCommit(target.serviceYamlPath, branch, commit);
    rebuildProjectIndex(repoRoot, target.projectName);
  }

  return { branch, commit };
}
