// lib/catalog-lifecycle/check.mjs
// `sidekicks catalog check [--json]`
//
// A thin dispatch entrypoint (see ./show.mjs for why each verb needs its own file). The gate itself
// is auditCatalog/checkCatalog in ./commands.mjs, so the suite can assert the same checks the verb
// runs rather than a re-implementation of them.
//
// Zero npm dependencies -- node:* + lib/ back-edges only.

import { checkCatalog } from './commands.mjs';
import { parseCatalogFlags } from './_shared.mjs';

/**
 * @param {{repoRoot: string, argv: string[]}} ctx
 * @param {object} _args
 * @returns {{stdout: string, exitCode: number}}
 */
export async function run(ctx, _args) {
  const flags = parseCatalogFlags(ctx.argv, ['json']);
  return checkCatalog(ctx.repoRoot, { json: Boolean(flags.json) });
}
