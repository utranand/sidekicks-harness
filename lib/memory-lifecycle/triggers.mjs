// lib/memory-lifecycle/triggers.mjs
// `sidekicks memory triggers <list|set|reset> [<category>] [--skills a,b] [--verbs a,b] [--keywords a,b] [--json]`
//
// Manage `.sidekicks/memory/triggers.yaml` — the committed overlay deciding which
// actions pull which category's scenario pack. The CLI is the only writer (Rule 1).
//
// `set` replaces a category's definition WHOLE rather than merging keys. Half-merging
// is the shape where an operator drops a skill from the list and it silently returns
// from the bundled defaults, which is exactly the surprise a deterministic trigger
// registry exists to avoid.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import * as yaml from '../yaml-subset/yaml.mjs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { triggersPath, storeRoot } from '../active-scope/memory-paths.mjs';
import { writeAtomic, mkdirp, rmrf } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { parseMemoryFlags, validateCategory } from './_shared.mjs';
import { resolveTriggers, readTriggerOverlay, BUNDLED_TRIGGERS } from './_triggers.mjs';

const SUBS = ['list', 'set', 'reset'];

/** Split a comma-separated flag value; an explicitly empty value means "none". */
function splitCsv(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return [];
  return s.split(',').map((v) => v.trim()).filter(Boolean);
}

/**
 * Run `memory triggers`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string, rest?: string[] }} args - name = sub, rest[0] = category
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json']);
  const sub = args.name || 'list';
  if (!SUBS.includes(sub)) {
    throw new SidekicksError(
      `memory triggers: expected one of ${SUBS.join(', ')} — e.g. 'sidekicks memory triggers list'`,
      EXIT_VALIDATION
    );
  }

  const abs = triggersPath(repoRoot);
  const rel = relative(repoRoot, abs).replace(/\\/g, '/');

  if (sub === 'list') {
    const effective = resolveTriggers(repoRoot);
    const overlay = readTriggerOverlay(repoRoot) || {};
    if (flags.json) {
      return {
        stdout: JSON.stringify({ file: rel, overlaid: Object.keys(overlay), triggers: effective }, null, 2) + '\n',
        exitCode: EXIT_OK,
      };
    }
    const out = [`Memory triggers — bundled defaults${existsSync(abs) ? ` + overlay ${rel}` : ' (no store overlay)'}`, ''];
    for (const [cat, def] of Object.entries(effective)) {
      const origin = Object.prototype.hasOwnProperty.call(overlay, cat) ? 'store' : 'bundled';
      out.push(`${cat}  [${origin}]`);
      if (def.skills.length) out.push(`  skills:   ${def.skills.join(', ')}`);
      if (def.verbs.length) out.push(`  verbs:    ${def.verbs.join(', ')}`);
      if (def.keywords.length) out.push(`  keywords: ${def.keywords.join(', ')}`);
      out.push('');
    }
    return { stdout: out.join('\n'), exitCode: EXIT_OK };
  }

  const category = (args.rest || [])[0];
  if (!category) {
    throw new SidekicksError(`memory triggers ${sub}: a <category> is required`, EXIT_VALIDATION);
  }
  const { category: cat, warning } = validateCategory(category);

  const overlay = readTriggerOverlay(repoRoot) || {};

  if (sub === 'reset') {
    if (!Object.prototype.hasOwnProperty.call(overlay, cat)) {
      return { stdout: `memory triggers: '${cat}' has no store override — already at the bundled default\n`, exitCode: EXIT_OK };
    }
    delete overlay[cat];
    writeOverlay(repoRoot, abs, overlay);
    const back = Object.prototype.hasOwnProperty.call(BUNDLED_TRIGGERS, cat) ? 'the bundled default' : 'nothing (no bundled default)';
    return { stdout: `reset '${cat}' in ${rel} — it now resolves to ${back}\n`, exitCode: EXIT_OK };
  }

  // set — replace the category WHOLE.
  const skills = splitCsv(flags.skills);
  const verbs = splitCsv(flags.verbs);
  const keywords = splitCsv(flags.keywords);
  if (skills === null && verbs === null && keywords === null) {
    throw new SidekicksError(
      `memory triggers set ${cat}: pass at least one of --skills / --verbs / --keywords `
        + `(the category is replaced whole; an omitted list becomes empty)`,
      EXIT_VALIDATION
    );
  }
  overlay[cat] = { skills: skills ?? [], verbs: verbs ?? [], keywords: keywords ?? [] };
  writeOverlay(repoRoot, abs, overlay);

  const lines = [`set '${cat}' in ${rel}`];
  if (warning) lines.push(warning);
  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}

/** Serialize + write the overlay, or delete the file once it holds nothing. */
function writeOverlay(repoRoot, abs, overlay) {
  if (Object.keys(overlay).length === 0) {
    if (existsSync(abs)) { assertWritable(abs, repoRoot); rmrf(abs); }
    return;
  }
  const header = [
    '# .sidekicks/memory/triggers.yaml — which actions pull which memory scenario pack.',
    '#',
    '# Managed by `sidekicks memory triggers set|reset`. Never hand-edit it (Rule 1).',
    '# A category listed here REPLACES the framework default for that category whole.',
    '# Skill patterns take one leading and/or trailing `*`; verbs match `sidekicks <verb>`;',
    '# keywords are substring tests over the raw command.',
    '',
  ].join('\n');
  const text = header + yaml.serialize(overlay);
  yaml.assertRoundTrips(yaml.serialize(overlay), 'memory triggers overlay');
  mkdirp(storeRoot(repoRoot));
  assertWritable(abs, repoRoot);
  writeAtomic(abs, text);
}
