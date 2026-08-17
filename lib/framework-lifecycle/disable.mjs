// lib/framework-lifecycle/disable.mjs
// `sidekicks framework disable <id>`
//
// Writes `false` into the committed SETTINGS layer — .sidekicks/config/settings/<kind>.yaml —
// preserving comments.
//
// REFUSES every safety-floor id with a non-zero exit and the reason — before touching the
// filesystem. The floor is a frozen constant in lib/framework-settings/floor.mjs precisely
// because .sidekicks/ is fully writable (fs-guard is a write-SURFACE guard), so a data-file
// flag could never be trusted to hold.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, EXIT_NOT_FOUND, SidekicksError } from '../sk-cli/errors.mjs';
import { buildRegistry } from '../framework-settings/registry.mjs';
import { resolve, setEnabled } from '../framework-settings/resolve.mjs';
import { requireId, stateWord } from './_shared.mjs';

/**
 * Run `framework disable <id>`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} EXIT_VALIDATION for a floor id, EXIT_NOT_FOUND for an unknown id.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const id = requireId(args.name, 'framework disable');

  const { byId } = buildRegistry(repoRoot);
  if (!byId.has(id)) {
    throw new SidekicksError(
      `framework disable: unknown id '${id}' — run 'sidekicks framework list' to see the ids`,
      EXIT_NOT_FOUND
    );
  }

  // setEnabled throws EXIT_VALIDATION for a floor id — the refusal lives in the resolver so
  // every caller (CLI, hook, future skill gate) refuses identically.
  const result = setEnabled(repoRoot, id, false);
  const after = resolve(repoRoot, id);
  const entry = byId.get(id);

  const out = [`${id}: disabled (${result.path}${result.created ? ', file created' : ''})`];
  if (entry.body_at && entry.body_at !== 'AGENTS.md') {
    out.push(`  Its body stays at ${entry.body_at} — re-enable with: sidekicks framework enable ${id}`);
  }
  if (after.enabled) {
    out.push(`  NOTE: effective state is still ${stateWord(after)} — a higher layer wins `
      + `[${after.source}]. Clear it there to take effect.`);
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
