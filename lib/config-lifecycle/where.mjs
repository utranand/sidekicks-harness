// lib/config-lifecycle/where.mjs
// `sidekicks config where <block> [--json]`
//
// "Which file do I edit, and which files is this value coming from right now?" — the two questions a
// scattered configuration surface could not answer. It prints, per scope, every candidate file in
// precedence order, marks the ones that exist and the ones that carry the block, and names the file
// a new value SHOULD go into (the family file, or its secret sibling for a credential).
//
// Read-only. Never prints a value — that is `config get`.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../sk-cli/errors.mjs';
import { resolveBlock, FILE_KIND } from '../config-store/read.mjs';
import { parseConfigFlags, requireBlock } from './_shared.mjs';

/**
 * Run `config where`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseConfigFlags(ctx.argv, ['json']);
  const block = requireBlock(args.name, 'config where');
  const resolved = resolveBlock(repoRoot, block);

  const scopes = resolved.layers
    .filter((l) => l.files.length)
    .map((l) => ({
      layer: l.layer,
      applies: l.applies,
      files: l.files.map((f) => ({
        ...f,
        exists: existsSync(join(repoRoot, f.path)),
      })),
    }));

  // Where a NEW value belongs: the highest applying scope's family file, and its secret sibling for
  // a credential. Never the legacy monolith — that layer only exists to keep old scopes working.
  const target = scopes.find((s) => s.applies)?.files.find((f) => f.kind === FILE_KIND.FAMILY) ?? null;
  const secretTarget = scopes.find((s) => s.applies)?.files.find((f) => f.kind === FILE_KIND.SECRET) ?? null;

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        block: resolved.block,
        family: resolved.family,
        file: resolved.file,
        secret_file: resolved.secret_file,
        active_scope: resolved.active_scope,
        scope: resolved.scope,
        inherits_root: resolved.inherits_root,
        write_to: target ? target.path : null,
        write_secrets_to: secretTarget ? secretTarget.path : null,
        scopes,
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const out = [
    `${resolved.block} — family '${resolved.family}', file '${resolved.file}'`,
    `active scope: ${resolved.active_scope}`,
    '',
  ];
  for (const s of scopes) {
    out.push(`${s.layer}${s.applies ? '' : '   (does not apply to this scope)'}`);
    for (const f of s.files) {
      const state = !f.exists ? 'absent' : f.present ? 'CARRIES this block' : 'exists, block absent';
      out.push(`  ${f.kind.padEnd(9)} ${f.path.padEnd(52)} ${state}`);
    }
    out.push('');
  }
  if (target) {
    out.push(`write a new value to:      ${target.path}`);
    if (secretTarget) out.push(`write a credential to:     ${secretTarget.path}   (git-ignored)`);
  } else {
    out.push('no scope file applies here — this block resolves from its skill defaults only');
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
