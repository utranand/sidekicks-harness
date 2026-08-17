// lib/memory-lifecycle/graph.mjs
// `sidekicks memory graph [<slug>] [--depth N] [--json]`
//
// The store's discoverability face: given one entry, what does it derive from, what
// does it supersede, and what else applies to the same thing — without a human keeping
// a mental map. With no slug it reports whole-graph stats.
//
// Edge ordering is the contract: declared edges (someone wrote them down) rank above
// harvested [[wiki-links]], which rank above inferred same-anchor edges. A reader
// following the list top-down walks from strongest evidence to weakest.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, SidekicksError, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { parseMemoryFlags, validateSlug } from './_shared.mjs';
import { readGraphJson } from './_store.mjs';

const ORIGIN_RANK = { declared: 0, harvested: 1, inferred: 2 };

/**
 * Breadth-first neighborhood of one slug, out to `depth` hops, following edges in
 * BOTH directions — "what points at this" is as much of an answer as "what this
 * points at", and a one-directional walk hides half the neighborhood.
 *
 * @param {{nodes: Array<object>, edges: Array<object>}} graph
 * @param {string} start
 * @param {number} depth
 * @returns {Array<{ slug: string, hop: number, via: Array<object> }>}
 */
export function neighborhood(graph, start, depth) {
  const out = [];
  const seen = new Set([start]);
  let frontier = [start];
  for (let hop = 1; hop <= depth; hop++) {
    const next = [];
    for (const cur of frontier) {
      const touching = graph.edges.filter((e) => e.from === cur || e.to === cur);
      touching.sort((a, b) => (ORIGIN_RANK[a.origin] ?? 9) - (ORIGIN_RANK[b.origin] ?? 9));
      for (const e of touching) {
        const other = e.from === cur ? e.to : e.from;
        if (seen.has(other)) continue;
        seen.add(other);
        next.push(other);
        out.push({
          slug: other,
          hop,
          rel: e.rel,
          origin: e.origin,
          direction: e.from === cur ? 'out' : 'in',
          from: cur,
          dangling: e.dangling === true,
        });
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return out;
}

/**
 * Run `memory graph`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json']);
  const graph = readGraphJson(repoRoot);
  const depth = flags.depth ? Math.max(1, Number(flags.depth) || 1) : 1;

  // No slug → whole-graph stats.
  if (!args.name) {
    const byOrigin = {};
    for (const e of graph.edges) byOrigin[e.origin] = (byOrigin[e.origin] ?? 0) + 1;
    const dangling = graph.edges.filter((e) => e.dangling).length;
    if (flags.json) {
      return { stdout: JSON.stringify(graph, null, 2) + '\n', exitCode: EXIT_OK };
    }
    const parts = Object.entries(byOrigin)
      .sort((a, b) => (ORIGIN_RANK[a[0]] ?? 9) - (ORIGIN_RANK[b[0]] ?? 9))
      .map(([k, v]) => `${v} ${k}`);
    return {
      stdout:
        `Memory graph — ${graph.nodes.length} node${graph.nodes.length === 1 ? '' : 's'}, `
        + `${graph.edges.length} edge${graph.edges.length === 1 ? '' : 's'}`
        + `${parts.length ? ` (${parts.join(', ')})` : ''}`
        + `${dangling ? `, ${dangling} DANGLING — see 'sidekicks memory doctor'` : ''}\n`,
      exitCode: EXIT_OK,
    };
  }

  const slug = validateSlug(args.name);
  const node = graph.nodes.find((n) => n.slug === slug);
  if (!node) {
    throw new SidekicksError(
      `memory graph: no entry '${slug}' in the store — run 'sidekicks memory rebuild' if you added it by hand`,
      EXIT_NOT_FOUND
    );
  }

  const hood = neighborhood(graph, slug, depth);

  if (flags.json) {
    return {
      stdout: JSON.stringify({ slug, node, depth, neighborhood: hood }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const out = [
    `${slug}  [${node.namespace}, ${node.category}${node.rule ? ', rule' : ''}]`,
    '',
  ];
  if (hood.length === 0) {
    out.push('  (no edges — link it with \'sidekicks memory link <from> <rel> <to>\')', '');
    return { stdout: out.join('\n'), exitCode: EXIT_OK };
  }
  for (const n of hood) {
    const arrow = n.direction === 'out' ? '->' : '<-';
    const marks = [n.origin];
    if (n.dangling) marks.push('DANGLING');
    out.push(`  ${'  '.repeat(n.hop - 1)}${arrow} ${n.rel} ${n.slug}  [${marks.join(', ')}]`);
  }
  out.push('');
  return { stdout: out.join('\n'), exitCode: EXIT_OK };
}
