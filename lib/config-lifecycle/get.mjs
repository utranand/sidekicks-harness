// lib/config-lifecycle/get.mjs
// `sidekicks config get <block>[.<key>] [--json] [--reveal]`
//
// The effective value of one configuration block in the active scope, with the layer that decided
// each key. This is the verb every consumer should call instead of reading a config file: it is the
// only place the 8-layer chain lives, and the only one that knows a block's family file, its
// git-ignored secret sibling, whether it inherits root, and whether it merges per key.
//
// It is also THE surface a skill's Python or shell script uses — `sidekicks config get jira --json`
// replaces the near-duplicate config_loader.py each connector used to carry.
//
// Credential-shaped values are masked unless --reveal is passed.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, SidekicksError, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { resolveBlock } from '../config-store/read.mjs';
import { parseConfigFlags, requireBlock, redact, hasSecretKey, MASK_NOTE, pluck } from './_shared.mjs';

/**
 * Run `config get`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseConfigFlags(ctx.argv, ['json', 'reveal']);
  const target = requireBlock(args.name, 'config get');

  // `jira.shp.api_token` — the block is the first segment, the rest is a key path into it.
  const dot = target.indexOf('.');
  const blockName = dot === -1 ? target : target.slice(0, dot);
  const keyPath = dot === -1 ? null : target.slice(dot + 1);

  const resolved = resolveBlock(repoRoot, blockName);

  if (keyPath !== null) {
    const { found, value } = pluck(resolved.config, keyPath);
    if (!found) {
      throw new SidekicksError(
        `config get: '${blockName}' carries no key '${keyPath}' in scope `
        + `'${resolved.active_scope}' — run 'sidekicks config get ${blockName}' to see what it does`,
        EXIT_NOT_FOUND
      );
    }
    const leaf = keyPath.split('.').pop();
    const isPublic = (resolved.public_keys || []).includes(leaf)
      || keyPath.split('.').some((k) => (resolved.public_keys || []).includes(k));
    const shown = flags.reveal || isPublic
      ? value
      : redact(value, /(api_key|apikey|token|password|passwd|secret|pass)/i.test(leaf), resolved.public_keys);
    if (flags.json) {
      return { stdout: JSON.stringify(shown, null, 2) + '\n', exitCode: EXIT_OK };
    }
    return {
      stdout: (typeof shown === 'object' ? JSON.stringify(shown, null, 2) : String(shown)) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const shown = flags.reveal ? resolved.config : redact(resolved.config, false, resolved.public_keys);

  if (flags.json) {
    return {
      stdout: JSON.stringify({ ...resolved, config: shown }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const out = [
    `${resolved.block} — family '${resolved.family}' (${resolved.file})`,
    `active scope: ${resolved.active_scope}   scope: ${resolved.scope}   `
    + `inherits root: ${resolved.inherits_root}   merge: ${resolved.merge}`,
  ];
  if (resolved.owners.length) out.push(`declared by: ${resolved.owners.join(', ')}`);
  if (resolved.readers.length) out.push(`read by: ${resolved.readers.join(', ')}`);
  out.push('', 'layers, highest first:');
  for (const layer of resolved.layers) {
    const mark = layer.present ? 'carries this block' : 'no block here';
    // Only a scope layer can fail to apply; a defaults/builtin layer simply has nothing to offer.
    const note = layer.applies === false && layer.files.length ? ' (does not apply to this scope)' : '';
    out.push(`  ${layer.layer.padEnd(15)} ${layer.path || '(none)'} — ${mark}${note}`);
    for (const f of layer.files) {
      if (!f.present) continue;
      out.push(`${''.padEnd(19)}↳ ${f.kind.padEnd(8)} ${f.path}`);
    }
  }
  out.push('');
  const keys = Object.keys(shown);
  if (keys.length === 0) {
    out.push('effective: (nothing configured — the reader uses its documented built-in behaviour)');
  } else {
    out.push('effective values:');
    for (const key of keys) {
      out.push(`  ${key}: ${JSON.stringify(shown[key])}   [${resolved.sources[key]}]`);
    }
    if (!flags.reveal && hasSecretKey(resolved.config, resolved.public_keys)) out.push('', MASK_NOTE);
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
