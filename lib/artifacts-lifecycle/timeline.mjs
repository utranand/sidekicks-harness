// lib/artifacts-lifecycle/timeline.mjs
// `artifacts timeline [--json]`
//
// The headline feature: chronological across all Jira skills AND service repos, newest
// first — the same rendering ARTIFACTS.md carries, scan-on-read. Shares renderTimeline
// with rebuild; a thin presenter, not a duplicate scan path.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import {
  resolveStores,
  scanRuns,
  buildIndex,
  renderTimeline,
  parseArtifactFlags,
} from './_shared.mjs';

/**
 * Run `artifacts timeline`.
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const flags = parseArtifactFlags(ctx.argv, ['json']);
  const ad = flags.artifacts_dir || flags['artifacts-dir'];
  const stores = resolveStores(ctx, ad ? { artifacts_dir: String(ad) } : {});

  const scan = scanRuns(stores.scanRoots);

  if (flags.json) {
    const index = buildIndex(scan, {
      project: stores.project,
      projectWorkdir: stores.projectWorkdir,
    });
    return { stdout: JSON.stringify(index.runs, null, 2) + '\n', exitCode: EXIT_OK };
  }

  const body = renderTimeline(scan, { project: stores.project });
  return { stdout: body, exitCode: EXIT_OK };
}
