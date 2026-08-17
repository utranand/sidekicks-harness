// lib/memory-lifecycle/query.mjs
// `sidekicks memory query <term-or-category> [--related] [--limit N] [--all] [--json]`
//
// L1 retrieval — the "find the atom" verb. Deterministic, grep-grade, zero-dependency:
// there is no vector index and that is a deliberate trade. A vector store cannot be
// committed, cannot be diffed, and cannot be read by a fresh clone with no install;
// at this store's size, one JSON scan plus a graph hop recovers most of what embeddings
// would have. `--related` is the recall assist.
//
// COST CONTRACT: exactly ONE index.json read, then entry bodies opened only for the
// SHORTLIST (rows whose slug/description already matched, plus a body sweep bounded by
// --limit). A whole-store body grep is what the machine index exists to avoid.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { read } from '../settings-store/settings.mjs';
import { resolveMemoryChain, layerForNamespace } from '../active-scope/memory-paths.mjs';
import { parseMemoryFlags, requireAgentLayer, MEMORY_CATEGORIES } from './_shared.mjs';
import { readIndexJson, readGraphJson } from './_store.mjs';

/** How many body-scan hits to add before stopping. Bodies are the expensive part. */
const DEFAULT_LIMIT = 20;

/** Declared edges are ranked above harvested ones, harvested above inferred. */
const ORIGIN_RANK = { declared: 0, harvested: 1, inferred: 2 };

/**
 * Run `memory query`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args - args.name is the search term
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'related', 'all', 'local']);
  const term = args.name != null ? String(args.name).trim() : '';
  if (!term) {
    throw new SidekicksError(
      'memory query: a <term-or-category> is required — e.g. '
        + `'sidekicks memory query database' (categories: ${MEMORY_CATEGORIES.join(', ')})`,
      EXIT_VALIDATION
    );
  }
  const limit = flags.limit ? Math.max(1, Number(flags.limit) || DEFAULT_LIMIT) : DEFAULT_LIMIT;

  // Which namespaces are in play — same resolution every read verb uses.
  const index = readIndexJson(repoRoot);
  let namespaces;
  let scopeLabel;
  if (flags.agent) {
    const layer = requireAgentLayer(repoRoot, flags.agent);
    namespaces = [layer.namespace];
    scopeLabel = layer.scopeLabel;
  } else if (flags.all) {
    namespaces = [...new Set(index.entries.map((e) => e.namespace))];
    scopeLabel = 'whole store';
  } else {
    const { active, chain } = resolveMemoryChain(repoRoot, read(repoRoot));
    const layers = flags.local ? [active] : chain;
    namespaces = layers.map((l) => l.namespace);
    scopeLabel = active.scopeLabel;
  }
  const rank = new Map(namespaces.map((ns, i) => [ns, i]));

  // Most-specific-wins collapse before matching, so an overridden root entry never
  // surfaces alongside the project entry that replaced it.
  const visible = new Map();
  for (const row of index.entries) {
    if (!rank.has(row.namespace)) continue;
    const prev = visible.get(row.slug);
    if (prev && rank.get(prev.namespace) <= rank.get(row.namespace)) continue;
    visible.set(row.slug, row);
  }

  const needle = term.toLowerCase();
  const hits = new Map(); // slug -> { row, why }

  // 1. Category match — an exact category name is a category query, not a keyword.
  for (const row of visible.values()) {
    if (row.category.toLowerCase() === needle) hits.set(row.slug, { row, why: 'category' });
  }

  // 2. Metadata match — slug + description, straight off the one index read.
  for (const row of visible.values()) {
    if (hits.has(row.slug)) continue;
    if (row.slug.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle)) {
      hits.set(row.slug, { row, why: 'metadata' });
    }
  }

  // 3. Body sweep — ONLY when metadata found little, and bounded. This is the one step
  //    that opens files, so it stays the last resort rather than the default path.
  if (hits.size < limit) {
    for (const row of visible.values()) {
      if (hits.size >= limit) break;
      if (hits.has(row.slug)) continue;
      const abs = join(layerForNamespace(repoRoot, row.namespace).baseDir, `${row.slug}.md`);
      if (!existsSync(abs)) continue;
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      if (text.toLowerCase().includes(needle)) hits.set(row.slug, { row, why: 'body' });
    }
  }

  // 4. --related: one graph hop off every hit, declared edges first.
  const related = [];
  if (flags.related && hits.size) {
    const graph = readGraphJson(repoRoot);
    const seeds = new Set(hits.keys());
    const candidates = [];
    for (const e of graph.edges) {
      if (e.dangling) continue;
      if (seeds.has(e.from) && !seeds.has(e.to) && visible.has(e.to)) {
        candidates.push({ slug: e.to, rel: e.rel, from: e.from, origin: e.origin });
      }
    }
    candidates.sort((a, b) => (ORIGIN_RANK[a.origin] ?? 9) - (ORIGIN_RANK[b.origin] ?? 9));
    const seen = new Set();
    for (const c of candidates) {
      if (seen.has(c.slug)) continue;
      seen.add(c.slug);
      related.push({ ...c, row: visible.get(c.slug) });
    }
  }

  const rows = [...hits.values()].sort((a, b) => a.row.slug.localeCompare(b.row.slug));

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        term,
        scope: scopeLabel,
        hits: rows.map(({ row, why }) => ({ ...row, matched: why })),
        related: related.map((r) => ({
          slug: r.slug, rel: r.rel, from: r.from, origin: r.origin,
          category: r.row.category, description: r.row.description, rule: r.row.rule,
        })),
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  if (rows.length === 0) {
    return {
      stdout: `No local-memory entries match '${term}' in scope '${scopeLabel}'.\n`,
      exitCode: EXIT_OK,
    };
  }

  const out = [`Memory query '${term}' — ${rows.length} hit${rows.length === 1 ? '' : 's'} in ${scopeLabel}`, ''];
  for (const { row, why } of rows) {
    const tags = [row.category];
    if (row.rule) tags.push('rule');
    tags.push(why);
    out.push(`  ${row.slug} — ${row.description}  [${tags.join(', ')}]`);
  }
  if (related.length) {
    out.push('', `Related (one graph hop):`);
    for (const r of related) {
      out.push(`  ${r.slug} — ${r.row.description}  [${r.rel} from ${r.from}, ${r.origin}]`);
    }
  }
  out.push('', `Read a body with 'sidekicks memory show <slug>'.`, '');
  return { stdout: out.join('\n'), exitCode: EXIT_OK };
}
