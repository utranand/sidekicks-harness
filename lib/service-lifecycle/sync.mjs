// lib/service-lifecycle/sync.mjs
// Implements `sidekicks service sync [<service-name>]`.
//
// Preconditions (in order):
//   1. active project ≠ root → EXIT_VALIDATION
//   2. resolve target service name (named arg || active_service || EXIT_VALIDATION)
//   3. projects/<active>/services/<target>/ exists as directory → EXIT_VALIDATION
//   4. service.yaml exists → EXIT_VALIDATION
//   5. git on PATH → EXIT_GIT
//   6. src/ is a git working tree (git.isRepo) → EXIT_VALIDATION
//
// Then: local git reads (currentBranch + headCommit) → fs-guard check → setBranchCommit.
// Active-scope pointers are NOT modified (no settings.json write).
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
  currentBranch,
  headCommit,
} from '../git-delegation/git.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { rebuildProjectIndex } from '../scope-index/index.mjs';

/**
 * Execute the `service sync [<service-name>]` verb.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string|undefined, rest: string[], flags: object }} args
 *   - args.name → [<service-name>] (first positional after the verb — optional)
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  // Optional <service-name> argument — first positional after the verb.
  const optServiceName =
    args && args.name != null && String(args.name).trim() !== ''
      ? String(args.name).trim()
      : null;

  // ── Precondition 1: active project ≠ root ─────────────────────────────────
  const settings = readSettings(repoRoot);
  const scope = resolveEffectiveScope(settings);

  if (scope.projectName === 'sidekicks') {
    throw new SidekicksError(
      "service sync requires an active user project; switch with 'project use <name>' first",
      EXIT_VALIDATION
    );
  }

  // ── Precondition 2: resolve target service name ────────────────────────────
  // Use explicit arg if provided; else fall back to active_service from settings.
  const target = optServiceName || settings.active_service || null;

  if (!target) {
    throw new SidekicksError(
      "service sync requires an active service or a <service-name> argument; " +
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

  // ── Precondition 4: service.yaml must exist ────────────────────────────────
  const serviceYamlPath = join(serviceDir, 'service.yaml');
  if (!existsSync(serviceYamlPath)) {
    throw new SidekicksError(
      `service.yaml not found at 'projects/${scope.projectName}/services/${target}/service.yaml'`,
      EXIT_VALIDATION
    );
  }

  // ── Precondition 5: git on PATH ───────────────────────────────────────────
  if (whichGit() === null) {
    throw new SidekicksError(
      "git is required for 'service sync' — install git and ensure it is on PATH",
      EXIT_GIT
    );
  }

  // ── Precondition 6: src/ is a git working tree ────────────────────────────
  // isRepo returns false (does NOT throw) for absent or non-repo paths.
  const srcDir = join(serviceDir, 'src');
  if (!isRepo(srcDir)) {
    throw new SidekicksError(
      `'${srcDir}' is not a git working tree (src/ absent or not a repo); ` +
        "re-run 'service add' or manually restore the source checkout",
      EXIT_VALIDATION
    );
  }

  // ── Read git state — local only, no network ──────────────────────
  // currentBranch returns "HEAD" for detached state (never null).
  const branch = currentBranch(srcDir);
  const commit = headCommit(srcDir);

  // ── fs-guard check before write (invariant) ─────────────────────────
  assertWritable(serviceYamlPath, repoRoot);

  // ── Atomic partial rewrite: only branch + commit ───────────────────────────
  // setBranchCommit reads existing service.yaml, updates only branch + commit,
  // preserves name / remote_source / overrides, then writes atomically.
  setBranchCommit(serviceYamlPath, branch, commit);

  // ── Rebuild project index (Epic 4, Story 4.2) ────────────────────────────
  // Tail-call after all mutations succeed. Only the owning project's index is
  // rebuilt; the root index is left untouched (service verbs are project-level).
  // Best-effort wrapping is added in Story 4.3 — errors propagate here.
  rebuildProjectIndex(repoRoot, scope.projectName);

  return { stdout: '', exitCode: EXIT_OK };
}
