// lib/catalog-lifecycle/show.mjs
// `sidekicks catalog show [<section>] [--section <s>] [--json]`
//
// A thin dispatch entrypoint: convention-based dispatch (lib/sk-cli/cli.mjs) imports
// `lib/<namespace>-lifecycle/<verb>.mjs` and calls its exported run(ctx, args), so the file has to
// exist per verb even though all three catalog verbs share one implementation in ./commands.mjs.
//
// THE SECTION IS READ TWICE ON PURPOSE. The dispatcher's global parseArgs runs with `strict: false`
// and declares only --help/--version/--verbose, so `--section cli` arrives as `{ section: true }`
// plus a positional `cli`, while `--section=cli` arrives as `{ section: 'cli' }`. Re-reading the raw
// argv here (parseCatalogFlags) makes the space form work, and falling back to args.name makes the
// bare positional form (`catalog show cli`) work too.
//
// Zero npm dependencies -- node:* + lib/ back-edges only.

import { showCatalog } from './commands.mjs';
import { parseCatalogFlags } from './_shared.mjs';

/**
 * @param {{repoRoot: string, argv: string[]}} ctx
 * @param {{name?: string}} args
 * @returns {{stdout: string, exitCode: number}}
 */
export async function run(ctx, args) {
  const flags = parseCatalogFlags(ctx.argv, ['json']);
  const section = (typeof flags.section === 'string' && flags.section !== '')
    ? flags.section
    : (args && args.name);
  return showCatalog(ctx.repoRoot, { section, json: Boolean(flags.json) });
}
