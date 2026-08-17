// lib/database-lifecycle/scope-guard.mjs
// Shared scope guard for all `database` namespace verbs.
// Rejects the root `sidekicks` scope (no active user project) with EXIT_VALIDATION.
// Zero npm dependencies — only lib/sk-cli/errors.mjs.

import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';

/**
 * Assert that the active scope is a user project (not the root `sidekicks` scope).
 *
 * Every `database` verb calls this as precondition 1 — before any read, write, or other
 * side effect — so root-scope rejections are uniform and fast.
 *
 * @param {{ projectName: string }} scope - Resolved scope from resolveEffectiveScope().
 * @throws {SidekicksError(EXIT_VALIDATION)} when scope.projectName === 'sidekicks'.
 */
export function assertUserProjectScope(scope) {
  if (scope.projectName === 'sidekicks') {
    throw new SidekicksError(
      'the `database` commands require an active user project; switch with `sidekicks project use <name>` first',
      EXIT_VALIDATION
    );
  }
}
