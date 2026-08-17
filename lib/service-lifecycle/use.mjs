// lib/service-lifecycle/use.mjs
// `service use <service-name>` verb — set the active service.
//
// Dir-presence criterion: validates that
//   projects/<active>/services/<name>/
// exists as a directory. service.yaml presence is NOT required.
//
// Writes only active_service via settings.setActiveService (RMW, preserves active_project).
// All writes guarded by fs-guard.assertWritable (invariant).
//
// Zero npm dependencies.

import { join } from 'node:path';
import { statSync } from 'node:fs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { read, setActiveService } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { rebuildRootIndex } from '../scope-index/index.mjs';

/**
 * Run `service use <service-name>`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: Function }} ctx
 * @param {{ name: string | undefined, rest: string[], flags: object }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any precondition failure or write error.
 */
export async function run(ctx, args) {
  const serviceName = args.name;

  // Precondition 1: <service-name> argument must be provided.
  if (!serviceName) {
    throw new SidekicksError(
      'service use requires a <service-name> argument',
      EXIT_VALIDATION
    );
  }

  // Precondition 2: effective active project must not be root.
  const settingsObj = read(ctx.repoRoot);
  const scope = resolveEffectiveScope(settingsObj);
  if (scope.projectName === 'sidekicks') {
    throw new SidekicksError(
      "service use requires an active user project; switch with 'project use <name>' first",
      EXIT_VALIDATION
    );
  }

  // Precondition 3: projects/<active>/services/<name>/ must exist as a directory
  // (dir-presence criterion — service.yaml NOT required).
  const serviceDir = join(
    ctx.repoRoot,
    'projects',
    scope.projectName,
    'services',
    serviceName
  );
  let stat;
  try {
    stat = statSync(serviceDir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    throw new SidekicksError(
      `service directory 'projects/${scope.projectName}/services/${serviceName}/' does not exist`,
      EXIT_VALIDATION
    );
  }

  // Write-surface guard before the settings write.
  const settingsPath = join(ctx.repoRoot, '.sidekicks', 'settings.json');
  assertWritable(settingsPath, ctx.repoRoot);

  // Atomic RMW — preserves active_project; sets active_service.
  setActiveService(ctx.repoRoot, serviceName);

  // ── Rebuild root index (Epic 4, Story 4.1) ───────────────────────────────────
  // The active pointer (active.service) lives in the root index — rebuild it so
  // the index reflects the newly-active service. Best-effort wrapping added in 4.3.
  rebuildRootIndex(ctx.repoRoot);

  return { stdout: '', exitCode: EXIT_OK };
}
