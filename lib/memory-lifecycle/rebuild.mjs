// lib/memory-lifecycle/rebuild.mjs
// `sidekicks memory rebuild` — regenerate the central store's three generated faces.
//
// Self-heal after manual edits: scans EVERY namespace under .sidekicks/memory/ and
// rewrites MEMORY.md (human, grouped namespace -> category), index.json (machine
// index — the one file query/map/pack read) and graph.json (knowledge-graph adjacency).
//
// Whole-store by design: with one central store there is no per-scope index left to
// rebuild in isolation, and a partial regeneration is exactly how the three faces drift
// apart. `--agent` is accepted and ignored for backward compatibility with the old
// per-agent form, which now regenerates the same central files.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { humanIndexPath } from '../active-scope/memory-paths.mjs';
import { parseMemoryFlags, listNamespaces } from './_shared.mjs';
import { syncStoreFaces } from './_store.mjs';
import { relative } from 'node:path';

/**
 * Run `memory rebuild`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json']);

  const result = syncStoreFaces(repoRoot);
  const namespaces = listNamespaces(repoRoot);

  if (flags.json) {
    return {
      stdout: JSON.stringify({ ...result, namespaces }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const indexRel = relative(repoRoot, humanIndexPath(repoRoot)).replace(/\\/g, '/');
  const storeRel = indexRel.replace(/\/MEMORY\.md$/, '');
  return {
    stdout:
      `rebuilt ${storeRel}/{MEMORY.md, index.json, graph.json} — `
      + `${result.count} ${result.count === 1 ? 'entry' : 'entries'} across `
      + `${namespaces.length} namespace${namespaces.length === 1 ? '' : 's'}, `
      + `${result.edges} graph edge${result.edges === 1 ? '' : 's'}\n`,
    exitCode: EXIT_OK,
  };
}
