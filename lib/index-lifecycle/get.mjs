// lib/index-lifecycle/get.mjs
// `index get <key>` verb implementation.
//
// Resolves a single scope handle from the root index via the drill-down edge.
//
// Supported key forms:
//   index get active                      → root index `active` object
//   index get project:<p>                 → root projects[<p>] entry
//   index get skills                      → root index `skills` array
//   index get project:<p>:service:<s>     → service entry from the project's index
//
// The drill-down for `project:<p>:service:<s>` is entirely in `getEntry`; this
// verb is a thin wrapper that formats output and maps not-found to a non-zero exit.
//
// Unknown key → non-zero exit (EXIT_NOT_FOUND) + clean stderr message; no partial output.
// No dispatcher change required — cli.mjs resolves `index get` to this module via
// the existing `lib/${namespace}-lifecycle/${verb}.mjs` convention.
//
// Zero npm dependencies — relative lib/ imports only.

import { getEntry } from '../scope-index/index.mjs';
import { SidekicksError, EXIT_OK, EXIT_NOT_FOUND, EXIT_USAGE } from '../sk-cli/errors.mjs';

/**
 * Run `index get <key>`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name?: string, rest: string[], flags: object }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} if the key is missing (EXIT_USAGE) or not found (EXIT_NOT_FOUND).
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const key = args.name;

  if (!key) {
    throw new SidekicksError(
      'index get: missing required argument <key> — run \'sidekicks index --help\'',
      EXIT_USAGE
    );
  }

  const result = getEntry(repoRoot, key);

  if (!result.found) {
    throw new SidekicksError(
      `index get: unknown key '${key}' — valid forms: active, project:<p>, skills, project:<p>:service:<s>`,
      EXIT_NOT_FOUND
    );
  }

  const stdout = JSON.stringify(result.entry, null, 2) + '\n';
  return { stdout, exitCode: EXIT_OK };
}
