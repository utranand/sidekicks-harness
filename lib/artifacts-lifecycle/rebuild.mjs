// lib/artifacts-lifecycle/rebuild.mjs
// `artifacts rebuild`
//
// scanRuns across ALL scan roots (project + service src/), infer headers for legacy
// folders (mapped status), write the aggregated index.json (overwrite — a derived
// cache) and ARTIFACTS.md. The ONLY writer of those two files (no hot-path race).
// Self-heal entry point; makes existing runs visible with no retrofit.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import {
  resolveStores,
  scanRuns,
  buildIndex,
  renderTimeline,
  writeAtomicJson,
  writeAtomicText,
  ensureRepoIgnore,
} from './_shared.mjs';

/**
 * Run `artifacts rebuild`.
 * @param {{ repoRoot: string, argv: string[], flags: object, log: Function }} ctx
 * @param {object} _args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const flags = ctx.flags || {};
  const ad = flags.artifacts_dir || flags['artifacts-dir'];
  const stores = resolveStores(ctx, ad ? { artifacts_dir: String(ad) } : {});

  const scan = scanRuns(stores.scanRoots);
  const inferred = scan.filter((r) => r.inferred).length;

  const index = buildIndex(scan, {
    project: stores.project,
    projectWorkdir: stores.projectWorkdir,
  });
  const timeline = renderTimeline(scan, { project: stores.project });

  // Self-heal the owning repo's .gitignore for the derived index.
  try { ensureRepoIgnore(stores.projectWorkdir); } catch { /* best-effort */ }

  writeAtomicJson(stores.indexPath, index);
  writeAtomicText(stores.timelinePath, timeline);

  const rootCount = stores.scanRoots.length;
  return {
    stdout: `rebuilt: ${scan.length} Jira runs across ${rootCount} root${rootCount === 1 ? '' : 's'}, ${inferred} inferred\n`,
    exitCode: EXIT_OK,
  };
}
