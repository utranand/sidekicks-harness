// lib/branch-lifecycle/current.mjs
// Implements `sidekicks branch current`.
// Prints the checked-out branch of the active scope's git working tree (the
// project's repo, or the active service's src/). Prints "HEAD" when detached.
// Read-only: no settings.json / service.yaml / index writes.
// Zero npm dependencies — relative lib/ imports only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { currentBranch } from '../git-delegation/git.mjs';
import { resolveBranchTarget } from './resolve.mjs';

/**
 * Execute the `branch current` verb.
 *
 * @param {{ repoRoot: string }} ctx
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx) {
  const { repoRoot } = ctx;
  const target = resolveBranchTarget(repoRoot, 'current');
  const branch = currentBranch(target.repoDir);
  return { stdout: `${branch}\n`, exitCode: EXIT_OK };
}
