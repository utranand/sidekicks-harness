// lib/index-lifecycle/rebuild.mjs
// `index rebuild [<project>]` verb implementation.
//
// Rebuilds and persists the shadow index on demand.
//
// Invocation forms:
//   index rebuild              — rebuild+persist the root index (and all project indexes)
//   index rebuild <project>   — rebuild+persist only that project's tracked index.json
//
// This is one of only two paths (the other being Epic 4 service-mutating hooks) that
// may persist the tracked project index. It passes `{ persist: true }` to the Epic 2
// readProjectIndex call to force a write to `projects/<name>/index.json`.
//
// Unknown project name → non-zero exit + clean stderr message.
// No dispatcher change required — cli.mjs resolves `index rebuild` to this module via
// the existing `lib/${namespace}-lifecycle/${verb}.mjs` convention.
//
// Zero npm dependencies — node:fs + node:path only (plus relative lib/ imports).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRootIndex,
  writeIndex,
  buildProjectIndex,
  readProjectIndex,
} from '../scope-index/index.mjs';
import { SidekicksError, EXIT_OK, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { statePath, stateRel } from '../state-store/paths.mjs';

/**
 * Run `index rebuild [<project>]`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name?: string, rest: string[], flags: object }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} if a named project does not exist (EXIT_NOT_FOUND).
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const project = args.name ?? null;

  if (project !== null && project !== undefined) {
    // `index rebuild <project>` — rebuild and persist only that project's index.
    const projectDir = join(repoRoot, 'projects', project);
    if (!existsSync(projectDir)) {
      throw new SidekicksError(
        `index rebuild: unknown project '${project}' — no directory at projects/${project}`,
        EXIT_NOT_FOUND
      );
    }

    // readProjectIndex with persist:true rebuilds and writes projects/<name>/index.json.
    readProjectIndex(repoRoot, project, { persist: true });

    return {
      stdout: `rebuilt project index: projects/${project}/index.json\n`,
      exitCode: EXIT_OK,
    };
  }

  // Bare `index rebuild` — rebuild+persist root index, then all project indexes.
  const rootIndex = buildRootIndex(repoRoot);
  const rootIndexPath = statePath(repoRoot, 'index.json');
  writeIndex(rootIndexPath, rootIndex, repoRoot);

  const lines = [`rebuilt root index: ${stateRel(repoRoot, 'index.json')}`];

  // Rebuild each user project's index (root project "sidekicks" has no per-project index).
  for (const [name, entry] of Object.entries(rootIndex.projects)) {
    if (entry.kind !== 'user') continue;
    // entry.index holds the relative path, e.g. "projects/<name>/index.json".
    readProjectIndex(repoRoot, name, { persist: true });
    lines.push(`rebuilt project index: projects/${name}/index.json`);
  }

  return {
    stdout: lines.join('\n') + '\n',
    exitCode: EXIT_OK,
  };
}
