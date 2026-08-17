// lib/scope-lifecycle/artifacts-base.mjs
// `scope artifacts-base` — print the absolute base dir that GENERATED artifacts + run state
// (the `artifacts/runs/…` tree) should anchor to for the active scope.
//
// This is deliberately NOT the working folder. The working folder (`scope working-folder`) is
// where an agent writes CODE — for an active service that is its `src/`. Anchoring generated
// artifacts there pollutes the service's source tree, so the artifacts base is instead:
//   - active service → <repo>/projects/<proj>/services/<svc>   (the service ROOT, not src/)
//                      → generated output lands at .../services/<svc>/artifacts/runs/<skill-id>
//   - active project only → <repo>/projects/<proj>
//   - root project active → <repo>
//
// For project and root scope the artifacts base equals the working folder (there is no src/
// split); only for an active service do they diverge. A skill's default run base is therefore
// `$(scope artifacts-base)/artifacts/runs/<skill-id>`, keeping generated artifacts and run
// state out of `src/` while `work_dir` (code) stays at `src/`.
//
// Like `scope working-folder`, the CLI resolves the repo root by walking up for .sidekicks/, so
// this can be invoked from ANY working directory inside the repo and returns an absolute path.
//
// Missing settings.json is not an error (root scope). A named-but-missing active service dir
// surfaces as EXIT_NOT_FOUND (propagated from resolveWorkingFolder) — no silent fallback.
// Zero npm dependencies. node imports + relative lib imports only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { read } from '../settings-store/settings.mjs';
import { resolveWorkingFolder } from '../active-scope/scope.mjs';

/**
 * Run `scope artifacts-base`.
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
  const { artifactsbase } = resolveWorkingFolder(settings, repoRoot);

  return { stdout: artifactsbase + '\n', exitCode: EXIT_OK };
}
