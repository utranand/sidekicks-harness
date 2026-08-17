// lib/memory-lifecycle/resolve.mjs
// `sidekicks memory resolve [<slug>] [--all] [--strategy union|ours|theirs] [--accept] [--dry-run] [--json]`
//
// Repair entries that are ALREADY conflicted on disk, and clear a merge-review flag once a
// human has read the result. The driver prevents these; this verb exists for the cases the
// driver cannot cover:
//
//   - the merge happened in a clone where the driver was not registered yet
//   - the merge happened through another tool (an IDE, a web UI, `git mergetool`)
//   - a rebase or cherry-pick left markers behind
//   - `metadata.merge_review` is set and somebody has now reviewed the entry
//
// Same frontmatter engine as the driver (`_merge.mjs`): links union, rule true wins, earliest
// created. The BODY is unioned by _merge.mjs's pure path rather than by `git merge-file` —
// what is on disk here is already a merge RESULT, so there is usually no base left to do a
// three-way against. `--strategy ours|theirs` is the escape hatch for a body that should not
// be unioned at all: it takes one side WHOLE, which is a decision a human makes, not a
// default this verb picks.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { layerForNamespace } from '../active-scope/memory-paths.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import {
  parseMemoryFlags,
  scanStore,
  hasConflictMarkers,
  parseConflictSides,
  buildEntryFile,
} from './_shared.mjs';
import { mergeEntry, readEntryParts } from './_merge.mjs';
import { syncStoreFaces } from './_store.mjs';

const STRATEGIES = ['union', 'ours', 'theirs'];

/**
 * Repair one conflicted file's text.
 *
 * @param {string} text - the raw, marker-bearing file text
 * @param {'union'|'ours'|'theirs'} strategy
 * @returns {{ text: string, conflicted: boolean, notes: string[], review: string|null }}
 */
function repairText(text, strategy) {
  const sides = parseConflictSides(text);
  if (strategy === 'ours') {
    return { text: normalizeSide(sides.ours), conflicted: false, notes: ['took ours whole'], review: null };
  }
  if (strategy === 'theirs') {
    return { text: normalizeSide(sides.theirs), conflicted: false, notes: ['took theirs whole'], review: null };
  }
  // union — the same semantic merge the driver performs. `base` is null for two-way markers;
  // mergeEntry treats an absent base as "both sides changed", which is the honest reading.
  return mergeEntry({ base: sides.base, ours: sides.ours, theirs: sides.theirs });
}

/**
 * Re-emit one side through buildEntryFile so `--strategy ours|theirs` lands the same bytes
 * `memory add` would have written, instead of whatever the marker split happened to leave.
 *
 * @param {string} sideText
 * @returns {string}
 */
function normalizeSide(sideText) {
  const parts = readEntryParts(sideText);
  return buildEntryFile({
    name: parts.name,
    description: parts.description ?? '',
    type: parts.type ?? 'context',
    created: parts.created,
    body: parts.body,
    category: parts.category,
    rule: parts.rule === true,
    source: parts.source,
    links: parts.links,
    mergeReview: parts.mergeReview,
  });
}

/** Clear `metadata.merge_review` from an entry, keeping every other field byte-identical. */
function clearReview(text) {
  const parts = readEntryParts(text);
  return buildEntryFile({
    name: parts.name,
    description: parts.description ?? '',
    type: parts.type ?? 'context',
    created: parts.created,
    body: parts.body,
    category: parts.category,
    rule: parts.rule === true,
    source: parts.source,
    links: parts.links,
    mergeReview: null,
  });
}

/**
 * Run `memory resolve`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args - name = one slug; omit it with --all
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'all', 'accept', 'dry-run']);
  const strategy = flags.strategy ? String(flags.strategy) : 'union';
  if (!STRATEGIES.includes(strategy)) {
    throw new SidekicksError(
      `memory resolve: invalid --strategy '${strategy}' — one of: ${STRATEGIES.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const slug = args.name ? String(args.name) : null;
  if (!slug && !flags.all) {
    throw new SidekicksError(
      'memory resolve: pass an entry <name>, or --all to repair every conflicted entry',
      EXIT_VALIDATION
    );
  }

  const entries = scanStore(repoRoot);
  const candidates = entries.filter((e) => (slug ? e.slug === slug : true))
    .filter((e) => (flags.accept ? (e.mergeReview || e.conflicted) : e.conflicted));

  if (slug && !entries.some((e) => e.slug === slug)) {
    throw new SidekicksError(`memory resolve: no entry '${slug}' in the store`, EXIT_NOT_FOUND);
  }

  const actions = [];
  for (const e of candidates) {
    const layer = layerForNamespace(repoRoot, e.namespace);
    const abs = join(layer.baseDir, `${e.slug}.md`);
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }

    let next = null;
    const notes = [];
    if (hasConflictMarkers(text)) {
      const repaired = repairText(text, strategy);
      next = repaired.text;
      notes.push(...repaired.notes);
      if (repaired.conflicted) notes.push(`flagged merge_review=${repaired.review}`);
    }
    if (flags.accept) {
      next = clearReview(next ?? text);
      notes.push('cleared merge_review');
    }
    if (next == null || next === text) continue;

    actions.push({ slug: e.slug, namespace: e.namespace, file: e.file, notes });
    if (!flags['dry-run']) {
      assertWritable(abs, repoRoot);
      writeAtomic(abs, next);
    }
  }

  if (actions.length && !flags['dry-run']) syncStoreFaces(repoRoot);

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        strategy, dryRun: flags['dry-run'] === true, accepted: flags.accept === true, actions,
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  if (!actions.length) {
    const what = flags.accept ? 'no entry to repair or accept' : 'no conflicted entry';
    return { stdout: `memory resolve: ${what}${slug ? ` for '${slug}'` : ''} — nothing to do\n`, exitCode: EXIT_OK };
  }

  const out = [
    flags['dry-run']
      ? `memory resolve (--dry-run, nothing written) — strategy ${strategy}:`
      : `memory resolve — strategy ${strategy}:`,
  ];
  for (const a of actions) {
    out.push(`  ${a.file}`);
    for (const n of a.notes) out.push(`    ${n}`);
  }
  if (!flags['dry-run']) out.push('regenerated MEMORY.md + index.json + graph.json');
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
