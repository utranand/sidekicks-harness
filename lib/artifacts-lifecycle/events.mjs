// lib/artifacts-lifecycle/events.mjs
// `sidekicks artifacts events <append|show|check|unlock> <run-dir> [...]`
//
// A thin dispatch entrypoint: convention-based dispatch (lib/sk-cli/cli.mjs) imports
// `lib/<namespace>-lifecycle/<verb>.mjs` and calls its exported run(ctx, args), so the file exists per
// verb even though the whole implementation lives in lib/run-events/.
//
// THE IMPLEMENTATION IS IN lib/run-events/, NOT HERE, on purpose. Three engines append to a run's
// event sidecar — sk-commander, sk-get-things-done and sk-cli-orchestrator (the last one from Python)
// — and the schema, the lock policy and the tail-recovery rules must have exactly ONE home for all of
// them. Putting them in artifacts-lifecycle would tie a cross-engine durable contract to the verb
// namespace that happens to expose it; a subsystem of its own is what lets `package transfer` ship
// the contract without dragging the artifacts index scanner along.
//
// The options come from ctx.argv, not from args.name / args.rest: the dispatcher's global parseArgs
// is `strict: false` and declares only --help/--version/--verbose, so `--input intent.json` arrives as
// `{ input: true }` plus a stray positional that would otherwise be mistaken for the run directory.
// See lib/run-events/commands.mjs § parseEventsArgs.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { runEventsCli } from '../run-events/commands.mjs';

/**
 * Run `artifacts events`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string, rest?: string[] }} _args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  return runEventsCli(ctx.argv);
}
