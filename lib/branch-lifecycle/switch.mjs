// lib/branch-lifecycle/switch.mjs
// Implements `sidekicks branch switch <branch> [--create]`.
//
// Switches the active scope's git working tree (the project's repo, or the active
// service's src/) to <branch> (`git checkout <branch>`). With --create the branch
// is created and switched to in one step (`git checkout -b <branch>`). Either way
// HEAD moves; for a service target that triggers a service.yaml branch+commit
// rewrite (via syncAfterMove) so the manifest never drifts from the working tree.
//
// This is the scope-aware sibling of `service checkout`: `service checkout` targets
// a named/active service explicitly, while `branch switch` targets whatever the
// active scope resolves to (project repo OR service src/).
//
// Zero npm dependencies — relative lib/ imports only.
// All git spawns delegated to git-delegation/git.mjs; shell: false everywhere.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { checkout, hasTrackedChanges } from '../git-delegation/git.mjs';
import { resolveBranchTarget, syncAfterMove } from './resolve.mjs';

/**
 * Execute the `branch switch <branch> [--create]` verb.
 *
 * @param {{ repoRoot: string }} ctx
 * @param {{ name: string|undefined, rest: string[], flags: object }} args
 *   - args.name         → <branch> (required)
 *   - args.flags.create → --create (create the branch with `git checkout -b`)
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  const branch =
    args && args.name != null && String(args.name).trim() !== ''
      ? String(args.name).trim()
      : null;
  if (!branch) {
    throw new SidekicksError(
      'branch switch requires a <branch> argument',
      EXIT_VALIDATION
    );
  }

  const create = Boolean(args && args.flags && args.flags.create);

  const target = resolveBranchTarget(repoRoot, 'switch');

  // Shared-checkout guard. git only refuses a switch when the changes would be
  // OVERWRITTEN; otherwise it carries them across and moves HEAD — which swaps files
  // underneath everything else live in this working tree (a second agent CLI session,
  // a dev server, a running build, the user's editor). That is the observed way work
  // gets lost, so a dirty tree is refused here and the caller is pointed at a sibling
  // worktree, which moves no HEAD at all (CLAUDE.md → "Protected branches", "Git
  // worktrees"). --allow-dirty is the explicit user-sanctioned override.
  if (!(args && args.flags && args.flags['allow-dirty']) && hasTrackedChanges(target.repoDir)) {
    throw new SidekicksError(
      `${target.label} has uncommitted tracked changes — refusing to move HEAD in a shared ` +
        'working tree. Create the branch in a sibling worktree instead: ' +
        `git -C ${target.repoDir} worktree add ../worktrees/${branch.replace(/[\\/]/g, '-')} ` +
        `${create ? '-b ' : ''}${branch}  (or commit here first, or pass --allow-dirty if you ` +
        'are certain nothing else is using this checkout)',
      EXIT_VALIDATION
    );
  }

  // git's own refusal (branch missing without --create, branch exists with
  // --create, dirty tree that would be overwritten) surfaces as EXIT_GIT.
  checkout(target.repoDir, branch, { create });

  const { branch: newBranch, commit } = syncAfterMove(repoRoot, target);
  return {
    stdout: `${target.label}: ${newBranch} (${commit.slice(0, 7)})\n`,
    exitCode: EXIT_OK,
  };
}
