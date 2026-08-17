// lib/config-lifecycle/example.mjs
// `sidekicks config example <family|block> [--secrets] [--json]`
//
// Prints a scaffold to STDOUT. It never writes a file, and that is a deliberate reversal of how this
// repo used to document configuration.
//
// WHY NO GENERATED *.example.yaml FILE. The old shape was: the live config is git-ignored, so a
// hand-maintained `config.example.yaml` documents its schema. That file drifted — by 4 blocks at root
// and 10 in projects/shp-sk — because nothing could fail when it fell behind. The store removes the
// need for it: the family file is non-secret and COMMITTED, so the real structure already travels to a
// fresh clone. Generating a second committed file next to it would recreate the same drift in a new
// place.
//
// What a fresh clone genuinely lacks is the git-ignored half. So:
//   `config example <family>`            → a starting family file, from the declared blocks
//   `config example <family> --secrets`  → the `.secret.yaml` skeleton, derived from the credential
//                                          placeholders the committed family file already carries
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { buildFamilies, FAMILIES, CONFIG_DIR } from '../config-store/families.mjs';
import { readBlock } from '../config-store/block.mjs';
import { renderBody } from '../config-store/write.mjs';
import { secretValuedKeys } from '../config-store/lint.mjs';
import { parseConfigFlags, requireBlock } from './_shared.mjs';

const SECRET_KEY_RE = /(api_key|apikey|token|password|passwd|secret|pass)/i;

/** Keep only the credential-shaped leaves of a value, preserving their nesting path. */
function secretSkeleton(value) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, v] of Object.entries(value || {})) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = v && typeof v === 'object' ? {} : '';
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = secretSkeleton(v);
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out;
}

/**
 * Run `config example`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseConfigFlags(ctx.argv, ['secrets', 'json']);
  const target = requireBlock(args.name, 'config example');

  const { blocks } = buildFamilies(repoRoot);
  const known = FAMILIES.find((f) => f.family === target);
  const family = known ? target : blocks.find((b) => b.block === target)?.family;
  if (!family) {
    throw new SidekicksError(
      `config example: '${target}' is neither a family nor a declared block — run `
      + "'sidekicks config list' to see both",
      EXIT_NOT_FOUND
    );
  }
  const members = blocks.filter((b) => b.family === family);
  const file = members[0].file;
  const secretFile = members[0].secret;

  const settings = readSettings(repoRoot);
  const { projectName, projectRelPath } = resolveEffectiveScope(settings);
  const base = projectRelPath ?? '.sidekicks';
  const plainRel = join(base, CONFIG_DIR, file);
  const plainAbs = join(repoRoot, plainRel);
  const plainText = existsSync(plainAbs) ? readFileSync(plainAbs, 'utf8') : null;

  const lines = [];

  if (flags.secrets) {
    lines.push(
      `# ${join(base, CONFIG_DIR, secretFile)} — GIT-IGNORED credential half of ${file}.`,
      '#',
      '# Fill in each value below. The committed family file carries the same keys with empty values,',
      '# which is how you can see what is needed without the secrets being in git; this file overrides',
      '# them key by key.',
      '',
    );
    let any = false;
    for (const b of members) {
      const live = plainText ? readBlock(plainText, b.block) : null;
      const skeleton = live ? secretSkeleton(live) : null;
      if (!skeleton || !Object.keys(skeleton).length) continue;
      any = true;
      lines.push(`${b.block}:`, ...renderBody(skeleton, 1), '');
    }
    if (!any) {
      lines.push(
        plainText
          ? `# ${plainRel} declares no credential-shaped key — this family needs no secret file.`
          : `# ${plainRel} does not exist yet. Run 'sidekicks config example ${family}' first.`,
        ''
      );
    }
  } else {
    const title = known ? known.title : family;
    lines.push(
      `# ${plainRel} — ${title}`,
      '#',
      '# COMMITTED and non-secret: this is the structure that travels with the repo. Every credential',
      `# belongs in the git-ignored sibling '${secretFile}' — keep the key here with an empty value so a`,
      '# fresh clone can see what it has to supply.',
      '#',
      `# Blocks in this family (from 'sidekicks config list'):`,
    );
    for (const b of members) {
      const readers = b.owners.length ? b.owners.join(', ') : (b.readers[0] ?? 'framework code');
      lines.push(`#   ${b.block} — read by: ${readers}`);
    }
    lines.push('');
    for (const b of members) {
      const live = plainText ? readBlock(plainText, b.block) : null;
      if (live && Object.keys(live).length) {
        lines.push(`${b.block}:`, ...renderBody(live, 1), '');
      } else {
        lines.push(`${b.block}: {}`, '');
      }
    }
  }

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        family,
        scope: projectName,
        file: flags.secrets ? join(base, CONFIG_DIR, secretFile) : plainRel,
        blocks: members.map((b) => b.block),
        content: lines.join('\n'),
        source_exists: plainText !== null,
        credential_keys_in_committed_file: plainText
          ? secretValuedKeys(plainText).map((h) => h.key)
          : [],
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}
