// lib/check-lifecycle/run.mjs
// `sidekicks check run [<profile>] [--profile <name>] [--jobs <1-8>] [--json]`
//
// A thin dispatch entrypoint: convention-based dispatch (lib/sk-cli/cli.mjs) imports
// `lib/<namespace>-lifecycle/<verb>.mjs` and calls its exported run(ctx, args), so the file exists
// per verb even though the whole implementation is in ./commands.mjs and ./runner.mjs.
//
// The options are read from ctx.argv, not from args.flags: the dispatcher's global parseArgs is
// `strict: false` and declares only --help/--version/--verbose, so `--profile quick` would arrive as
// `{ profile: true }` plus a positional. See ./commands.mjs § parseCheckRunArgs.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { checkRun, parseCheckRunArgs } from './commands.mjs';

/**
 * @param {{repoRoot: string, argv: string[]}} ctx
 * @param {{name?: string, rest?: string[]}} _args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, _args) {
  const { profile, jobs, json } = parseCheckRunArgs(ctx.argv);
  return checkRun(ctx.repoRoot, { profile, jobs, json });
}
