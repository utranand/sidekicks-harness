// lib/cli-executor-lifecycle/remove.mjs
// `sidekicks cli-executor remove <name>` — drop an executor entry from the scope-resolved registry.
//
// Removing a REGISTERED entry deletes it. Removing a built-in whose only presence is the default
// (no on-disk entry) is a no-op error — there is nothing to remove; to stop the family addressing a
// built-in, register it disabled instead (`register <name> --disabled`).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { read } from '../settings-store/settings.mjs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  resolveRegistryPath,
  readRegistry,
  writeRegistry,
  BUILTIN_NAMES,
  parseFlags,
} from './_shared.mjs';

/**
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = args.name;
  if (!name) {
    throw new SidekicksError('cli-executor remove: a <name> is required', EXIT_VALIDATION);
  }

  const flags = parseFlags(ctx.argv, ['root']);
  const { path, pathRel } = resolveRegistryPath(repoRoot, read(repoRoot), { root: flags.root === true });
  const registry = readRegistry(path);

  if (!Object.prototype.hasOwnProperty.call(registry.executors, name)) {
    const hint = BUILTIN_NAMES.includes(name)
      ? ` — '${name}' is a built-in default; to stop addressing it, run 'cli-executor register ${name} --disabled'`
      : '';
    throw new SidekicksError(`cli-executor remove: '${name}' is not registered in ${pathRel}${hint}`, EXIT_VALIDATION);
  }

  delete registry.executors[name];
  writeRegistry(path, registry, repoRoot);
  return { stdout: `removed executor '${name}' from ${pathRel}\n`, exitCode: EXIT_OK };
}
