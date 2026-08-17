// lib/scope-lifecycle/working-folder.mjs
// `scope working-folder` — print the absolute canonical working folder for the active scope.
//
// This is the path an agent (or skill) should anchor artifact paths to, resolved entirely
// from .sidekicks/settings.json via resolveWorkingFolder:
//   - active service → <repo>/projects/<proj>/services/<svc>/src  (falls back to the service
//     root when no src/ exists)
//   - active project only → <repo>/projects/<proj>
//   - root project active → <repo>
//
// Because the CLI resolves the repo root by walking up for .sidekicks/, a skill can invoke this
// from ANY working directory inside the repo and get back an absolute path to operate on.
//
// Missing settings.json is not an error (root scope). A named-but-missing active service dir
// surfaces as EXIT_NOT_FOUND (propagated from resolveWorkingFolder) — no silent fallback.
// Zero npm dependencies. node imports + relative lib imports only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { read } from '../settings-store/settings.mjs';
import { resolveWorkingFolder } from '../active-scope/scope.mjs';

/**
 * Run `scope working-folder`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on corrupt settings.json or a missing active service directory.
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;

  // read() returns {} on missing file; throws EXIT_VALIDATION on corrupt JSON.
  const settings = read(repoRoot);

  // Throws EXIT_NOT_FOUND if an active service is set but its directory is absent.
  const { workdir } = resolveWorkingFolder(settings, repoRoot);

  return { stdout: workdir + '\n', exitCode: EXIT_OK };
}
