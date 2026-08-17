// lib/branch-lifecycle/delete.mjs
// Implements `sidekicks branch delete <name> [--force]`.
//
// Deletes a branch in the active scope's git working tree (the project's repo, or
// the active service's src/). Safe by default (`git branch -d`, refuses unmerged
// branches); --force uses `git branch -D`. git refuses to delete the currently
// checked-out branch, so the recorded current branch (service.yaml) can never be the
// one removed here — no metadata sync is needed.
//
// Zero npm dependencies — relative lib/ imports only.
// All git spawns delegated to git-delegation/git.mjs; shell: false everywhere.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { deleteBranch } from '../git-delegation/git.mjs';
import { resolveBranchTarget } from './resolve.mjs';

/**
 * Execute the `branch delete <name> [--force]` verb.
 *
 * @param {{ repoRoot: string }} ctx
 * @param {{ name: string|undefined, rest: string[], flags: object }} args
 *   - args.name        → <name> (required)
 *   - args.flags.force → --force (force delete even if unmerged, `git branch -D`)
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  const name =
    args && args.name != null && String(args.name).trim() !== ''
      ? String(args.name).trim()
      : null;
  if (!name) {
    throw new SidekicksError(
      'branch delete requires a <name> argument',
      EXIT_VALIDATION
    );
  }

  const force = Boolean(args && args.flags && args.flags.force);

  const target = resolveBranchTarget(repoRoot, 'delete');

  // git refuses to delete the current branch, or an unmerged branch without -D —
  // either refusal surfaces as EXIT_GIT.
  deleteBranch(target.repoDir, name, { force });

  return {
    stdout: `${target.label}: deleted branch ${name}\n`,
    exitCode: EXIT_OK,
  };
}
