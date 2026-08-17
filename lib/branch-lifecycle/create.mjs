// lib/branch-lifecycle/create.mjs
// Implements `sidekicks branch create <name> [--switch]`.
//
// Creates a new branch in the active scope's git working tree (the project's repo,
// or the active service's src/). Without --switch the working tree STAYS on the
// current branch (`git branch <name>`) — HEAD does not move, so no metadata changes.
// With --switch it creates AND checks out the branch (`git checkout -b <name>`),
// moving HEAD; for a service target that triggers a service.yaml branch+commit
// rewrite (via syncAfterMove) so the manifest never drifts from the working tree.
//
// Zero npm dependencies — relative lib/ imports only.
// All git spawns delegated to git-delegation/git.mjs; shell: false everywhere.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { createBranch, checkout, hasTrackedChanges } from '../git-delegation/git.mjs';
import { resolveBranchTarget, syncAfterMove } from './resolve.mjs';

/**
 * Execute the `branch create <name> [--switch]` verb.
 *
 * @param {{ repoRoot: string }} ctx
 * @param {{ name: string|undefined, rest: string[], flags: object }} args
 *   - args.name        → <name> (required)
 *   - args.flags.switch → --switch (create AND check out)
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
      'branch create requires a <name> argument',
      EXIT_VALIDATION
    );
  }

  const doSwitch = Boolean(args && args.flags && args.flags.switch);

  const target = resolveBranchTarget(repoRoot, 'create');

  if (doSwitch) {
    // Shared-checkout guard — only --switch moves HEAD, so only this arm needs it.
    // git carries uncommitted changes across a checkout instead of refusing, which
    // swaps files underneath anything else live in this tree; a sibling worktree
    // moves no HEAD (CLAUDE.md → "Protected branches", "Git worktrees").
    if (!(args.flags && args.flags['allow-dirty']) && hasTrackedChanges(target.repoDir)) {
      throw new SidekicksError(
        `${target.label} has uncommitted tracked changes — refusing to move HEAD in a shared ` +
          'working tree. Create the branch in a sibling worktree instead: ' +
          `git -C ${target.repoDir} worktree add ../worktrees/${name.replace(/[\\/]/g, '-')} ` +
          `-b ${name}  (or drop --switch to create the branch without moving HEAD, commit here ` +
          'first, or pass --allow-dirty if you are certain nothing else is using this checkout)',
        EXIT_VALIDATION
      );
    }
    // Create and switch in one step — git refuses if the branch already exists.
    checkout(target.repoDir, name, { create: true });
    const { branch, commit } = syncAfterMove(repoRoot, target);
    return {
      stdout: `${target.label}: created and switched to ${branch} (${commit.slice(0, 7)})\n`,
      exitCode: EXIT_OK,
    };
  }

  // Create only — HEAD stays put, so no metadata sync is needed.
  createBranch(target.repoDir, name);
  return {
    stdout: `${target.label}: created branch ${name} (still on current branch; use --switch or 'branch switch ${name}' to check it out)\n`,
    exitCode: EXIT_OK,
  };
}
