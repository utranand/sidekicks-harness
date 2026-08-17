// lib/branch-lifecycle/list.mjs
// Implements `sidekicks branch list`.
// Lists the local branches of the active scope's git working tree (the project's
// repo, or the active service's src/), marking the checked-out branch with '*'.
// Read-only: no settings.json / service.yaml / index writes.
// Zero npm dependencies — relative lib/ imports only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { listBranches, currentBranch } from '../git-delegation/git.mjs';
import { resolveBranchTarget } from './resolve.mjs';

/**
 * Execute the `branch list` verb.
 *
 * @param {{ repoRoot: string }} ctx
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx) {
  const { repoRoot } = ctx;
  const target = resolveBranchTarget(repoRoot, 'list');

  const branches = listBranches(target.repoDir);
  const current = currentBranch(target.repoDir); // "HEAD" when detached

  if (branches.length === 0) {
    // A repo with commits always has a branch; this is the no-commits-yet case.
    return { stdout: `${target.label}: (no branches yet)\n`, exitCode: EXIT_OK };
  }

  const lines = branches.map((b) => (b === current ? `* ${b}` : `  ${b}`));
  // Detached HEAD: current is the literal "HEAD" and matches no branch — note it.
  if (current === 'HEAD') lines.unshift('* (detached HEAD)');

  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}
