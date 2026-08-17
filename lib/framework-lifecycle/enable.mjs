// lib/framework-lifecycle/enable.mjs
// `sidekicks framework enable <id>`
//
// Writes `true` into the committed SETTINGS layer — .sidekicks/config/settings/<kind>.yaml —
// preserving that file's
// comments (the write is line-level, never parse+re-emit). An explicit `true` is written
// rather than deleting the key, so re-enabling a rule is a recorded decision.
//
// A higher layer still wins: if the active project's manifest.yaml disables the id, the
// effective state stays disabled and this verb says so instead of pretending it took effect.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, EXIT_NOT_FOUND, SidekicksError } from '../sk-cli/errors.mjs';
import { buildRegistry } from '../framework-settings/registry.mjs';
import { resolve, setEnabled, SOURCE } from '../framework-settings/resolve.mjs';
import { requireId, stateWord } from './_shared.mjs';

/**
 * Run `framework enable <id>`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const id = requireId(args.name, 'framework enable');

  const { byId } = buildRegistry(repoRoot);
  const entry = byId.get(id);
  if (!entry) {
    throw new SidekicksError(
      `framework enable: unknown id '${id}' — run 'sidekicks framework list' to see the ids`,
      EXIT_NOT_FOUND
    );
  }

  const result = setEnabled(repoRoot, id, true);
  const after = resolve(repoRoot, id);

  const out = [];
  if (entry.floor) {
    out.push(`${id} is part of the safety floor — always enabled, nothing to write.`);
  } else {
    out.push(`${id}: enabled (${result.path}${result.created ? ', file created' : ''})`);
  }
  if (!after.enabled) {
    out.push(`  NOTE: effective state is still ${stateWord(after)} — a higher layer wins `
      + `[${after.source}]. Clear it there to take effect.`);
  } else if (!entry.floor && after.source !== SOURCE.FILE) {
    out.push(`  NOTE: the effective state now comes from [${after.source}], which outranks `
      + `${result.path}.`);
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
