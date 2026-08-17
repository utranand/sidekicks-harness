// lib/project-lifecycle/unlink.mjs
// Implements `sidekicks project unlink <name>`.
//
// Removes an EXTERNAL project binding created by `project link`: deletes only the
// projects/<name> symlink (or Windows junction) and its managed .gitignore entry.
// The external directory it pointed at — and all its contents — are left completely
// untouched. This is the safe counterpart to `project remove`, whose destructive
// tree-deletion semantics must never reach an out-of-tree linked directory.
//
// Refuses a non-symlink projects/<name> (a real in-tree project) — that is what
// `project remove` is for.
//
// Zero npm dependencies — node:fs, node:path only (plus relative lib/ imports).

import { lstatSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_IO } from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { read as readSettings, setActiveProject } from '../settings-store/settings.mjs';
import { rebuildRootIndex } from '../scope-index/index.mjs';
import { removeExternalIgnore, isSymlink } from './external-links.mjs';

/**
 * Execute the `project unlink <name>` verb.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = args && args.name != null ? String(args.name) : '';

  if (!name) {
    throw new SidekicksError('usage: sidekicks project unlink <name>', EXIT_VALIDATION);
  }
  if (name === 'sidekicks') {
    throw new SidekicksError("cannot unlink the reserved root project 'sidekicks'", EXIT_VALIDATION);
  }

  const projectDir = join(repoRoot, 'projects', name);

  // Must be a symlink/junction — a real directory is not an external link.
  let lst;
  try { lst = lstatSync(projectDir); } catch { lst = null; }
  if (!lst) {
    throw new SidekicksError(
      `project '${name}' is not linked (projects/${name} not found)`,
      EXIT_VALIDATION
    );
  }
  if (!isSymlink(projectDir)) {
    throw new SidekicksError(
      `projects/${name} is a real directory, not an external link; use 'sidekicks project remove ${name}'`,
      EXIT_VALIDATION
    );
  }

  // Resolve the target for the confirmation message (may be broken → unknown).
  let target = null;
  try { target = realpathSync(projectDir); } catch { target = null; }

  // Write-surface guard, then remove ONLY the link (never the external contents).
  assertWritable(projectDir, repoRoot);
  try {
    unlinkSync(projectDir);
  } catch (err) {
    throw new SidekicksError(
      `unlink: failed to remove link projects/${name}: ${err.message}`,
      EXIT_IO
    );
  }

  // Drop the managed .gitignore entry.
  removeExternalIgnore(repoRoot, `projects/${name}`);

  // If it was the active project, fall back to root.
  const settings = readSettings(repoRoot);
  if (settings.active_project === name) {
    setActiveProject(repoRoot, 'sidekicks');
  }

  // Root index no longer references the departed project.
  rebuildRootIndex(repoRoot);

  const where = target ? ` (contents at ${target} left intact)` : ' (external contents left intact)';
  return {
    stdout: `Unlinked external project '${name}'${where}.\n`,
    exitCode: EXIT_OK,
  };
}
