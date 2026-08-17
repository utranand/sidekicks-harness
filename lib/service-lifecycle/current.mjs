// lib/service-lifecycle/current.mjs
// `service current` verb — print the effective active service name or "(none)".
//
// Never exits non-zero for an unset pointer.
// Missing settings.json → "(none)" with exit 0.
// Corrupt settings.json → exit 2 via settings.read contract.
//
// Zero npm dependencies.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs'; // eslint-disable-line no-unused-vars
import { read } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';

/**
 * Run `service current`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: Function }} ctx
 * @param {{ name: string | undefined, rest: string[], flags: object }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError(EXIT_VALIDATION)} if settings.json is present but corrupt.
 */
export async function run(ctx, _args) {
  // settings.read returns {} for absent file; throws EXIT_VALIDATION for corrupt file.
  const settingsObj = read(ctx.repoRoot);
  const scope = resolveEffectiveScope(settingsObj);

  // scope.serviceName is null when active_service is absent or null.
  const name = scope.serviceName;
  return { stdout: (name || '(none)') + '\n', exitCode: EXIT_OK };
}
