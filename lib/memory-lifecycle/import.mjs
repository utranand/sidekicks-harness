// lib/memory-lifecycle/import.mjs
// `sidekicks memory import <dir> [--namespace <ns>] [--as <ns>] [--strategy …] [--force] [--dry-run] [--json]`
//
// Ingest a folder of memory entries into the central store — the one-shot form of `memory sync`
// for a folder nobody wants to register as a standing source.
//
// It understands four shapes, not just its own export format (lib/memory-lifecycle/_sources.mjs):
// an export folder, a LIVE central store from another checkout (every namespace preserved), a
// dormant pre-central tree whose path names its namespace, and a flat folder of entries. Detection
// lives in `_sources.mjs` so `import` and `sync` can never disagree about what a folder is.
//
// The default collision strategy is `merge` — the same semantic entry merge the git driver uses.
// `--force` is kept as the historical spelling of `--strategy overwrite`, because a silent
// wholesale overwrite is what the old refusal existed to prevent and the flag should keep meaning
// exactly that.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { parseMemoryFlags } from './_shared.mjs';
import { syncStoreFaces } from './_store.mjs';
import {
  detectShape, applyEntries, importEvidence, resolveSourcePath, STRATEGIES, DEFAULT_STRATEGY,
} from './_sources.mjs';

/**
 * Run `memory import`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args - args.name is the folder to ingest
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'force', 'dry-run']);
  const dryRun = flags['dry-run'] === true;
  const dirArg = args.name != null ? String(args.name).trim() : '';
  if (!dirArg) {
    throw new SidekicksError(
      'memory import: a <dir> is required — an export folder, another checkout\'s '
        + '.sidekicks/memory/, a dormant projects/<p>/memory/ tree, or a folder of entry files',
      EXIT_VALIDATION
    );
  }
  const dir = resolveSourcePath(repoRoot, dirArg)
    || (isAbsolute(dirArg) ? resolve(dirArg) : resolve(repoRoot, dirArg));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new SidekicksError(`memory import: '${dirArg}' is not a directory`, EXIT_NOT_FOUND);
  }

  let strategy = String(flags.strategy ?? '').trim() || DEFAULT_STRATEGY;
  // --force predates --strategy and has always meant "overwrite what is already there".
  if (flags.force === true && !String(flags.strategy ?? '').trim()) strategy = 'overwrite';
  if (!STRATEGIES.includes(strategy)) {
    throw new SidekicksError(
      `memory import: --strategy must be one of ${STRATEGIES.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const detected = detectShape(dir, {
    namespace: String(flags.namespace ?? '').trim() || null,
    as: String(flags.as ?? '').trim() || null,
  });

  const applied = applyEntries(repoRoot, detected.items, { strategy, dryRun });
  applied.rejected.push(...detected.rejected);

  let evidence = 0;
  if (detected.evidenceRoot) {
    const ns = detected.shape === 'store' ? null : (detected.items[0]?.namespace ?? null);
    evidence = importEvidence(repoRoot, detected.evidenceRoot, ns, { dryRun });
  }

  const touched = applied.added.length + applied.merged.length + applied.overwritten.length;
  if (touched && !dryRun) syncStoreFaces(repoRoot);

  const namespaces = [...new Set(detected.items.map((i) => i.namespace))];

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        shape: detected.shape, namespaces, strategy, dry_run: dryRun, evidence, ...applied,
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const out = [
    `imported from a '${detected.shape}' folder into ${namespaces.join(', ') || '(nothing)'}`
      + ` — strategy ${strategy}${dryRun ? ' (dry run — nothing written)' : ''}`,
    `  ${applied.added.length} new, ${applied.merged.length} merged, `
      + `${applied.overwritten.length} overwritten, ${applied.skipped.length} skipped, `
      + `${applied.unchanged.length} unchanged`
      + `${evidence ? `, ${evidence} evidence file(s)` : ''}`,
  ];
  if (applied.skipped.length) out.push(`  skipped (local wins): ${applied.skipped.join(', ')}`);
  if (applied.rejected.length) out.push(`  rejected: ${applied.rejected.join(', ')}`);
  if (applied.reviews.length) {
    out.push(
      `  ${applied.reviews.length} diverged body/bodies kept in full and flagged: ${applied.reviews.join(', ')}`,
      "  read each, then clear it: sidekicks memory resolve <slug> --accept"
    );
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
