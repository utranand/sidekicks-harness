// lib/catalog-lifecycle/rebuild.mjs
// `sidekicks catalog rebuild [--dry-run] [--json]`
//
// A thin dispatch entrypoint (see ./show.mjs for why each verb needs its own file).
//
// Zero npm dependencies -- node:* + lib/ back-edges only.

import { rebuildCatalog } from './commands.mjs';
import { parseCatalogFlags } from './_shared.mjs';

/**
 * @param {{repoRoot: string, argv: string[]}} ctx
 * @param {object} _args
 * @returns {{stdout: string, exitCode: number}}
 */
export async function run(ctx, _args) {
  const flags = parseCatalogFlags(ctx.argv, ['json', 'dry-run']);
  return rebuildCatalog(ctx.repoRoot, {
    json: Boolean(flags.json),
    dryRun: Boolean(flags['dry-run']),
  });
}
