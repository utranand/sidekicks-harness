// lib/config-lifecycle/list.mjs
// `sidekicks config list [--json] [--family <f>] [--live]`
//
// Every registered configuration block, grouped by the family file it lives in, with who declared
// it, who reads it, and how it resolves. This is the answer to "where do I put this setting" and to
// "what does this repo actually configure" — questions that had no answer while 14 of 25 live blocks
// were declared nowhere.
//
// DERIVED: lib/config-store/families.mjs assembles it from core-families.mjs plus every skill.yaml
// found by scanning both skill trees. There is no catalog file to forget to update.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../sk-cli/errors.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { listBlocks } from '../config-store/read.mjs';
import { FAMILIES, CONFIG_DIR, LEGACY_FILE } from '../config-store/families.mjs';
import { topLevelKeyLines } from '../config-store/lint.mjs';
import { parseConfigFlags } from './_shared.mjs';

/**
 * Which of a scope's files currently carry each block — so `list` can say "declared but never
 * configured" without resolving 31 blocks one by one.
 *
 * @param {string} repoRoot
 * @param {string[]} bases - repo-relative scope bases, highest precedence first
 * @returns {Map<string, string[]>} block → the files carrying it
 */
function liveBlocks(repoRoot, bases) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  const record = (rel) => {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) return;
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      return; // an unreadable file is the doctor's finding, not this verb's
    }
    for (const { key } of topLevelKeyLines(text)) {
      const at = out.get(key) ?? [];
      if (!at.includes(rel)) at.push(rel);
      out.set(key, at);
    }
  };
  for (const base of bases) {
    record(join(base, LEGACY_FILE));
    const dir = join(base, CONFIG_DIR);
    for (const f of FAMILIES) {
      record(join(dir, f.file));
      record(join(dir, f.secret));
    }
  }
  return out;
}

/**
 * Run `config list`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseConfigFlags(ctx.argv, ['json', 'live']);

  const settings = readSettings(repoRoot);
  const { projectName, projectRelPath } = resolveEffectiveScope(settings);
  const bases = projectRelPath ? [projectRelPath, '.sidekicks'] : ['.sidekicks'];

  let blocks = listBlocks(repoRoot);
  if (flags.family) blocks = blocks.filter((b) => b.family === String(flags.family));

  const live = liveBlocks(repoRoot, bases);
  const annotated = blocks.map((b) => ({
    ...b,
    configured_in: live.get(b.block) ?? [],
    ...(b.aliases.length
      ? { alias_configured_in: b.aliases.flatMap((a) => live.get(a) ?? []) }
      : {}),
  }));
  const shown = flags.live
    ? annotated.filter((b) => b.configured_in.length || (b.alias_configured_in || []).length)
    : annotated;

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        active_scope: projectName,
        scope_bases: bases,
        families: FAMILIES,
        blocks: shown,
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const byFamily = new Map();
  for (const b of shown) {
    if (!byFamily.has(b.family)) byFamily.set(b.family, []);
    byFamily.get(b.family).push(b);
  }
  const out = [
    `Configuration blocks (${shown.length}) — active scope: ${projectName}`,
    `scope files are read from: ${bases.map((b) => join(b, CONFIG_DIR)).join(', ')}`,
    '',
  ];
  const order = [...FAMILIES.map((f) => f.family), ...[...byFamily.keys()].filter((f) => !FAMILIES.some((x) => x.family === f))];
  for (const family of order) {
    const list = byFamily.get(family);
    if (!list || !list.length) continue;
    const known = FAMILIES.find((f) => f.family === family);
    out.push(`${list[0].file}${known ? `   — ${known.title}` : ''}`);
    for (const b of list) {
      const where = b.configured_in.length ? b.configured_in.join(', ') : '(not configured here)';
      const owners = b.owners.length ? b.owners.join(', ') : `framework (${b.readers[0] ?? 'no reader recorded'})`;
      out.push(`  ${b.block.padEnd(28)} ${where}`);
      out.push(`  ${''.padEnd(28)} declared by: ${owners}`);
      const notes = [];
      if (b.scope === 'root') notes.push('root scope only');
      if (b.scope === 'project') notes.push('project scope only');
      if (b.inherits_root) notes.push('inherits root');
      if (b.merge !== 'per_key') notes.push(`merge: ${b.merge}`);
      if (b.aliases.length) notes.push(`legacy names: ${b.aliases.join(', ')}`);
      if (!b.defaults) notes.push('no defaults file');
      if (notes.length) out.push(`  ${''.padEnd(28)} ${notes.join(' · ')}`);
    }
    out.push('');
  }
  return { stdout: out.join('\n'), exitCode: EXIT_OK };
}
