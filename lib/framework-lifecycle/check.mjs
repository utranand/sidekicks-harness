// lib/framework-lifecycle/check.mjs
// `sidekicks framework check <id> [--quiet]`
//
// The predicate form the hook gates use: exit 0 when the id is ENABLED, exit 1 when it is
// DISABLED. Nothing about a gated hook depends on parsing output, so a shell hook
// (.sidekicks/hooks/rtk-hook.sh) can gate itself with a plain `if` and no JSON.
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
