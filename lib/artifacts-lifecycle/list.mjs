// lib/artifacts-lifecycle/list.mjs
// `artifacts list [--skill <s>] [--status <st>] [--json]`
//
// Rebuilds the index IN MEMORY (scan-on-read, like `index show`), filters, prints a
// table or JSON. Flags parsed via the memory-style ctx.argv re-parse (the parseArgs
// space-form gotcha).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import {
  resolveStores,
  scanRuns,
  buildIndex,
  parseArtifactFlags,
} from './_shared.mjs';

/**
 * Run `artifacts list`.
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const flags = parseArtifactFlags(ctx.argv, ['json']);
  const ad = flags.artifacts_dir || flags['artifacts-dir'];
  const stores = resolveStores(ctx, ad ? { artifacts_dir: String(ad) } : {});

  const scan = scanRuns(stores.scanRoots);
  const index = buildIndex(scan, {
    project: stores.project,
    projectWorkdir: stores.projectWorkdir,
  });

  let runs = index.runs;
  if (flags.skill) runs = runs.filter((r) => r.skill === String(flags.skill));
  if (flags.status) runs = runs.filter((r) => r.status === String(flags.status));

  if (flags.json) {
    return { stdout: JSON.stringify(runs, null, 2) + '\n', exitCode: EXIT_OK };
  }

  if (runs.length === 0) {
    return {
      stdout: `No Jira artifact runs for project '${stores.project}'. Run 'sidekicks artifacts rebuild' or register a run.\n`,
      exitCode: EXIT_OK,
    };
  }

  const lines = [`Artifact runs — ${stores.project} (${runs.length}):`, ''];
  for (const r of runs) {
    const inferTag = r.inferred ? ' (inferred)' : '';
    lines.push(`  [${r.status}] ${r.skill}/${r.slug} — ${r.title}  (${r.updated_at})${inferTag}`);
  }
  lines.push('');
  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}
