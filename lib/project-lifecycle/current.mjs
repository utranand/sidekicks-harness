// lib/project-lifecycle/current.mjs
// `project current` — print the effective active project name.
// Always exits 0 except on corrupt settings.json.
// Missing settings.json is NOT an error — prints 'sidekicks'.
// Manifestless-but-named-active: prints name + stderr warning, exits 0.
// Zero npm dependencies. node:fs + node:path + relative lib imports only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../sk-cli/errors.mjs';
import { read } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';

/**
 * Run `project current`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;

  // read() returns {} on missing file; throws EXIT_VALIDATION on corrupt
  const settings = read(repoRoot);

  const { projectName } = resolveEffectiveScope(settings);

  // Manifestless-but-named-active: warn to stderr, still exit 0
  if (projectName !== 'sidekicks') {
    const manifestPath = join(repoRoot, 'projects', projectName, 'manifest.yaml');
    if (!existsSync(manifestPath)) {
      process.stderr.write(
        `warning: active project '${projectName}' has no manifest.yaml\n`
      );
    }
  }

  return { stdout: projectName + '\n', exitCode: EXIT_OK };
}
