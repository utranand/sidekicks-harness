// lib/memory-lifecycle/sync.mjs
// `sidekicks memory sync [<name>] [--all] [--strategy merge|skip|overwrite] [--dry-run] [--json]`
//
// PULL: bring entries in from every registered external source into the local store. This is how a
// fresh clone gets its memory now that `.sidekicks/memory/` is git-ignored — git no longer carries
// the entries, a source does.
//
// The default strategy is `merge`, not `skip`: two checkouts refine the same entry independently,
// and skipping means the refinement made on the other machine silently never arrives. Merge reuses
// the same semantic entry merge the git driver uses (links union, `rule: true` wins, earliest
// `created`, bodies unioned and stamped `merge_review`), so nothing is lost and `memory doctor`
// lists what still needs a human read.
//
// The three generated faces are regenerated ONCE, after every source has been applied — a rescan
// per entry would walk the whole store for each file.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { parseMemoryFlags } from './_shared.mjs';
import { syncStoreFaces } from './_store.mjs';
import {
  readSources, requireSource, refreshSource, detectShape, applyEntries, importEvidence,
  namespaceAllowed, STRATEGIES,
} from './_sources.mjs';

/** Summarize one source's application into count lines a human can scan. */
function summarize(applied) {
  const bits = [];
  if (applied.added.length) bits.push(`${applied.added.length} new`);
  if (applied.merged.length) bits.push(`${applied.merged.length} merged`);
  if (applied.overwritten.length) bits.push(`${applied.overwritten.length} overwritten`);
  if (applied.skipped.length) bits.push(`${applied.skipped.length} skipped`);
  if (applied.unchanged.length) bits.push(`${applied.unchanged.length} unchanged`);
  if (applied.rejected.length) bits.push(`${applied.rejected.length} rejected`);
  return bits.length ? bits.join(', ') : 'nothing to do';
}

/**
 * Run `memory sync`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args - args.name is an optional source name
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'all', 'dry-run', 'offline']);
  const dryRun = flags['dry-run'] === true;
  const offline = flags.offline === true;
  const registry = readSources(repoRoot);

  const strategy = String(flags.strategy ?? '').trim() || registry.default_strategy;
  if (!STRATEGIES.includes(strategy)) {
    throw new SidekicksError(
      `memory sync: --strategy must be one of ${STRATEGIES.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const wanted = args.name ? [requireSource(repoRoot, String(args.name))] : registry.sources;
  if (!wanted.length) {
    return {
      stdout: 'no memory source registered — nothing to sync from.\n'
        + "  register one:  sidekicks memory source add <name> --kind dir --path <folder>\n"
        + "                 sidekicks memory source add <name> --kind git --url <repo>\n",
      exitCode: EXIT_OK,
    };
  }

  const results = [];
  let touched = 0;

  for (const source of wanted) {
    const row = { source: source.name, kind: source.kind };
    let refreshed;
    try {
      refreshed = refreshSource(repoRoot, source, { offline });
    } catch (err) {
      // One unreachable source must not abort the others: a sync across three sources where the
      // VPN is down for one is still worth the two that answered.
      row.error = err.message;
      results.push(row);
      continue;
    }
    row.dir = refreshed.dir;
    if (refreshed.head) row.head = refreshed.head;
    if (refreshed.note) row.note = refreshed.note;

    let detected;
    try {
      detected = detectShape(refreshed.dir, { namespace: source.namespace ?? null, as: source.as || null });
    } catch (err) {
      row.error = err.message;
      results.push(row);
      continue;
    }
    row.shape = detected.shape;

    const items = detected.items.filter((i) => namespaceAllowed(i.namespace, source.namespaces));
    const applied = applyEntries(repoRoot, items, { strategy, dryRun });
    applied.rejected.push(...detected.rejected);
    row.applied = applied;
    row.summary = summarize(applied);
    touched += applied.added.length + applied.merged.length + applied.overwritten.length;

    if (detected.evidenceRoot) {
      // An export folder's evidence is already namespaced one level down when it came from a
      // whole-store publish; a single-namespace export carries the namespace's subtree directly.
      const ns = detected.shape === 'export' && items.length ? items[0].namespace : null;
      row.evidence = importEvidence(
        repoRoot,
        detected.evidenceRoot,
        detected.shape === 'store' ? null : ns,
        { dryRun }
      );
    }
    results.push(row);
  }

  if (touched && !dryRun) syncStoreFaces(repoRoot);

  if (flags.json) {
    return {
      stdout: JSON.stringify({ strategy, dry_run: dryRun, sources: results }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const out = [`memory sync — strategy ${strategy}${dryRun ? ' (dry run — nothing written)' : ''}`, ''];
  const reviews = [];
  for (const r of results) {
    if (r.error) { out.push(`${r.source}  [${r.kind}]  ERROR: ${r.error}`); continue; }
    out.push(`${r.source}  [${r.kind}${r.shape ? ` · ${r.shape}` : ''}${r.head ? ` · ${r.head}` : ''}]  ${r.summary}`);
    if (r.note) out.push(`  ${r.note}`);
    if (r.evidence) out.push(`  ${r.evidence} evidence file(s)`);
    if (r.applied?.skipped.length) out.push(`  skipped: ${r.applied.skipped.join(', ')}`);
    if (r.applied?.rejected.length) out.push(`  rejected: ${r.applied.rejected.join(', ')}`);
    reviews.push(...(r.applied?.reviews ?? []));
  }
  if (reviews.length) {
    out.push('', `${reviews.length} entr${reviews.length === 1 ? 'y' : 'ies'} had a diverged body — both sides kept, flagged for review:`);
    out.push(`  ${reviews.join(', ')}`);
    out.push("  read each, then clear it: sidekicks memory resolve <slug> --accept");
  }
  if (!dryRun && touched) out.push('', 'regenerated MEMORY.md + index.json + graph.json');
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
