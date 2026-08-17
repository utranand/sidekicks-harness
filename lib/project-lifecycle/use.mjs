// lib/project-lifecycle/use.mjs
// `project use <name>` — set the active project.
// Acceptance gate: directory existence — NOT manifest health.
// Unconditionally resets active_service to null.
// Zero npm dependencies. node:fs + node:path + relative lib imports only.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { read, setActiveProject } from '../settings-store/settings.mjs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { rebuildRootIndex } from '../scope-index/index.mjs';

/**
 * Run `project use <name>`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string | undefined }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = args && args.name;

  // Require name argument
  if (!name) {
    throw new SidekicksError(
      'project use requires a <name> argument',
      EXIT_VALIDATION
    );
  }

  // Validate name matches [a-z0-9-]+ (non-empty kebab-case)
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new SidekicksError(
      `project name '${name}' is invalid: must match [a-z0-9-]`,
      EXIT_VALIDATION
    );
  }

  // Acceptance gate: directory existence
  // "sidekicks" is always valid (root project — no directory required)
  if (name !== 'sidekicks') {
    const projectDir = join(repoRoot, 'projects', name);
    let stat;
    try { stat = statSync(projectDir); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) {
      throw new SidekicksError(
        `unknown project '${name}': no directory found at projects/${name}/`,
        EXIT_VALIDATION
      );
    }

    // Manifestless-dir warning: warn but proceed
    const manifestPath = join(projectDir, 'manifest.yaml');
    if (!existsSync(manifestPath)) {
      process.stderr.write(
        `warning: active project '${name}' has missing or unparseable manifest.yaml\n`
      );
    }
  }

  // Read current settings — throws EXIT_VALIDATION on corrupt JSON
  const existing = read(repoRoot);

  // Convergence check:
  // True no-write no-op only when BOTH active_project and active_service already match
  if (existing.active_project === name && existing.active_service == null) {
    return { stdout: '', exitCode: EXIT_OK };
  }

  // Atomically write {active_project: name, active_service: null} (unconditional reset)
  setActiveProject(repoRoot, name);

  // ── Rebuild root index (Epic 4, Story 4.1) ───────────────────────────────────
  // The active pointer in the root index changed — rebuild so it reflects the new
  // active project (and null service). Best-effort wrapping added in Story 4.3.
  rebuildRootIndex(repoRoot);

  return { stdout: '', exitCode: EXIT_OK };
}
