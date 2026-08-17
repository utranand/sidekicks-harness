// lib/active-scope/scope.mjs
// Active-scope resolution helpers: resolveEffectiveScope + resolveWorkingFolder.
// Zero npm dependencies — node:fs, node:path only (plus errors.mjs back-edge).
//
// resolveEffectiveScope: pure (no FS, never throws). Derives the effective project
//   + service from a settings object. Called by verbs before any FS operation.
//
// resolveWorkingFolder: reads settings + validates existence of service dir.
//   Receives repoRoot explicitly (no module-level globals) for isolation testing.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { SidekicksError, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';

/**
 * Derive the effective active scope from a (possibly empty) settings object.
 *
 * Pure function — no FS calls, never throws, always returns a valid scope.
 * When settings is absent / active_project is unset or null, root scope is returned.
 *
 * @param {object} settings - Parsed .sidekicks/settings.json (may be {}).
 * @returns {{
 *   projectName: string,
 *   projectRelPath: string | null,
 *   serviceName: string | null
 * }}
 *   - projectName: "sidekicks" for root, otherwise the named project.
 *   - projectRelPath: null for root, "projects/<name>" for a named project.
 *   - serviceName: null when active_service is absent/null.
 */
export function resolveEffectiveScope(settings) {
  const rawProject = settings && settings.active_project;
  const projectName =
    !rawProject || rawProject === 'sidekicks' ? 'sidekicks' : rawProject;

  const projectRelPath = projectName === 'sidekicks' ? null : `projects/${projectName}`;

  const rawService = settings && settings.active_service;
  const serviceName = rawService || null;

  return { projectName, projectRelPath, serviceName };
}

/**
 * Resolve the agent's effective working folder.
 *
 * Three-level precedence:
 *   1. active project + active service → projects/<active>/services/<active_service>/
 *   2. active project only             → projects/<active>/
 *   3. root project active             → repoRoot (repo root)
 *
 * Validates the resolved service dir exists when a service is active.
 * Does NOT fall back silently — throws EXIT_NOT_FOUND if service dir is missing.
 *
 * `workdir` is the canonical *working folder* an agent should write CODE into —
 * distinct from the structural `servicePath`/`projectPath` (the free-write boundary):
 *   - active service → `<servicePath>/src` when that directory exists, else `<servicePath>`.
 *     Source lives under `src/`; the service root holds metadata (`service.yaml`). Boundary
 *     stays the service root, so writing outside `src/` is still legal.
 *   - active project only → `projectPath`.
 *   - root → repoRoot.
 *
 * `artifactsbase` is the base dir that GENERATED artifacts + run state (`artifacts/runs/…`)
 * anchor to — deliberately NOT `workdir`, so a skill's generated output never pollutes a
 * service's `src/` source tree:
 *   - active service → `<servicePath>` (the service ROOT, not `src/`) → `.../services/<svc>/artifacts/…`.
 *   - active project only → `projectPath`.
 *   - root → repoRoot.
 * For project and root scope `artifactsbase === workdir` (there is no `src/` split); only for an
 * active service do they diverge (`servicePath` vs `servicePath/src`).
 *
 * @param {object} settings   - Parsed .sidekicks/settings.json (may be {}).
 * @param {string} repoRoot   - Absolute path to the repository root.
 * @returns {{
 *   projectName: string,
 *   projectPath: string,
 *   serviceName: string | null,
 *   servicePath: string | null,
 *   workdir: string,
 *   artifactsbase: string
 * }}
 * @throws {SidekicksError(EXIT_NOT_FOUND)} if the service directory does not exist.
 */
export function resolveWorkingFolder(settings, repoRoot) {
  const scope = resolveEffectiveScope(settings);

  // Level 3: root active
  if (scope.projectName === 'sidekicks') {
    return {
      projectName: 'sidekicks',
      projectPath: repoRoot,
      serviceName: null,
      servicePath: null,
      workdir: repoRoot,
      artifactsbase: repoRoot,
    };
  }

  const projectPath = join(repoRoot, 'projects', scope.projectName);

  // Level 1: active project + active service
  if (scope.serviceName) {
    const servicePath = join(projectPath, 'services', scope.serviceName);
    // Validate the service directory exists (no silent fallback).
    let stat;
    try { stat = statSync(servicePath); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) {
      throw new SidekicksError(
        `working folder 'projects/${scope.projectName}/services/${scope.serviceName}/' does not exist`,
        EXIT_NOT_FOUND
      );
    }
    // Canonical working folder is the service's src/ when present; otherwise the service root.
    const srcPath = join(servicePath, 'src');
    let srcStat;
    try { srcStat = statSync(srcPath); } catch { srcStat = null; }
    const workdir = srcStat && srcStat.isDirectory() ? srcPath : servicePath;
    return {
      projectName: scope.projectName,
      projectPath,
      serviceName: scope.serviceName,
      servicePath,
      workdir,
      // Generated artifacts anchor at the service ROOT, never inside src/.
      artifactsbase: servicePath,
    };
  }

  // Level 2: active project only
  return {
    projectName: scope.projectName,
    projectPath,
    serviceName: null,
    servicePath: null,
    workdir: projectPath,
    artifactsbase: projectPath,
  };
}
