// lib/package-lifecycle/preview.mjs
// Verb entry for `sidekicks package preview`.
// Alias for `package create --dry-run` — prints the copy plan without writing.
// NOT barrel-exported — reached via the dispatcher's lazy import().

import { run as createRun } from "./create.mjs";

/**
 * Run the `package preview` verb.
 * Delegates to `create` with dry-run mode enabled.
 * Requires `--output <path>` (same contract as `create --dry-run`).
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string|undefined, rest: string[], flags: object }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  // Inject --dry-run into argv so create.mjs picks it up via parseArgs
  const dryRunArgv = [...ctx.argv, "--dry-run"];
  return createRun({ ...ctx, argv: dryRunArgv }, args);
}
