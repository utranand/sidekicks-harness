// lib/framework-lifecycle/check.mjs
// `sidekicks framework check <id> [--quiet]`
//
// The predicate form: exit 0 when the id is ENABLED, exit 1 when it is DISABLED. Nothing about a
// gated hook depends on parsing output, so a caller can gate itself with a plain `if` and no JSON.
//
// Every wired hook is now Node and consults scripts/lib/hook-gate.mjs in-process instead
// (INC-2026-09-05-05, W-1 retired the last shell hook), so this verb is no longer on the per-call
// hot path. It stays as the scriptable answer to "is this id on?" for sequences, docs and humans.
//
// Exit codes:
//   0  enabled  (including every safety-floor id, and any id nothing has an opinion about)
//   1  disabled
//   2  the id is malformed (EXIT_VALIDATION) — never confused with "disabled"
//
// An UNKNOWN-but-well-formed id is reported enabled, deliberately: a typo in a gate must
// never silently switch a hook off. `framework doctor` is what catches the typo.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { resolve } from '../framework-settings/resolve.mjs';
import { parseFrameworkFlags, requireId, stateWord } from './_shared.mjs';

const EXIT_DISABLED = 1;

/**
 * Run `framework check <id>`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseFrameworkFlags(ctx.argv, ['quiet']);
  const id = requireId(args.name, 'framework check');

  const resolved = resolve(repoRoot, id);
  const stdout = flags.quiet ? '' : `${id}: ${stateWord(resolved)} [${resolved.source}]\n`;

  return { stdout, exitCode: resolved.enabled ? EXIT_OK : EXIT_DISABLED };
}
