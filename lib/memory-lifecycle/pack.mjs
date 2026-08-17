// lib/memory-lifecycle/pack.mjs
// `sidekicks memory pack <category> [--agent <a>] [--local] [--json]`
//
// A SCENARIO PACK is the unit a triggered action loads: everything the store knows
// about one kind of work, and nothing about any other kind. That split is the whole
// economy of the design — a session that never touches the database never pays for the
// database entries, while a session that is about to run SQL gets every hard rule about
// running SQL, in full, before it acts.
//
// Composition, deliberately asymmetric:
//   - RULE entries         → body VERBATIM. A rule you only got the summary of is a rule
//                            you did not get; truncating one is worse than omitting it.
//   - non-rule entries     → one index line each. The reader pulls a body on demand
//                            with `memory show`, so recall stays cheap.
//   - each rule            → a one-line `related:` footer from its declared edges, so
//                            one more hop is reachable without inlining the neighbor.
//
// Merged over the namespace chain, most-specific first (project beats root; with
// --agent, the agent's namespace beats both) — the same collision rule every read verb
// uses, so a project's refinement of a shared rule is the one that fires.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { read } from '../settings-store/settings.mjs';
import { resolveMemoryChain, layerForNamespace } from '../active-scope/memory-paths.mjs';
import { parseMemoryFlags, parseEntryFile, requireAgentLayer, MEMORY_CATEGORIES } from './_shared.mjs';
import { readIndexJson, readGraphJson } from './_store.mjs';

/**
 * Resolve the namespace chain a pack merges over. With --agent the agent's own
 * namespace is prepended to the scope chain: an agent's private refinement of a shared
 * rule must stick to that agent, which is only true if it wins the collision.
 *
 * @returns {{ layers: Array<object>, scopeLabel: string }}
 */
function packChain(repoRoot, flags) {
  const { active, chain } = resolveMemoryChain(repoRoot, read(repoRoot));
  const base = flags.local ? [active] : chain;
  if (!flags.agent) return { layers: base, scopeLabel: active.scopeLabel };
  const agentLayer = requireAgentLayer(repoRoot, flags.agent);
  return { layers: [agentLayer, ...base], scopeLabel: `${agentLayer.scopeLabel} over ${active.scopeLabel}` };
}

/**
 * Build the pack for one category.
 *
 * @param {string} repoRoot
 * @param {string} category
 * @param {Array<object>} layers - namespace layers, most-specific first
 * @returns {{ category: string, rules: Array<object>, notes: Array<object> }}
 */
export function buildPack(repoRoot, category, layers) {
  const index = readIndexJson(repoRoot);
  const rank = new Map(layers.map((l, i) => [l.namespace, i]));

  const winner = new Map();
  for (const row of index.entries) {
    if (row.category !== category) continue;
    if (!rank.has(row.namespace)) continue;
    const prev = winner.get(row.slug);
    if (prev && rank.get(prev.namespace) <= rank.get(row.namespace)) continue;
    winner.set(row.slug, row);
  }

  const graph = readGraphJson(repoRoot);
  const rules = [];
  const notes = [];
  for (const row of [...winner.values()].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (!row.rule) {
      notes.push({ slug: row.slug, description: row.description, namespace: row.namespace });
      continue;
    }
    const abs = join(layerForNamespace(repoRoot, row.namespace).baseDir, `${row.slug}.md`);
    let body = '';
    if (existsSync(abs)) {
      try { body = parseEntryFile(readFileSync(abs, 'utf8')).body; } catch { body = ''; }
    }
    const related = graph.edges
      .filter((e) => e.from === row.slug && e.origin === 'declared' && !e.dangling)
      .map((e) => `${e.rel} ${e.to}`);
    rules.push({
      slug: row.slug,
      description: row.description,
      namespace: row.namespace,
      source: row.source,
      body,
      related,
    });
  }
  return { category, rules, notes };
}

/**
 * Run `memory pack`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args - args.name is the category
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'local']);
  const category = args.name != null ? String(args.name).trim() : '';
  if (!category) {
    throw new SidekicksError(
      `memory pack: a <category> is required — one of: ${MEMORY_CATEGORIES.join(', ')} `
        + `(see 'sidekicks memory map' for what this scope actually carries)`,
      EXIT_VALIDATION
    );
  }

  const { layers, scopeLabel } = packChain(repoRoot, flags);
  const pack = buildPack(repoRoot, category, layers);

  if (flags.json) {
    return {
      stdout: JSON.stringify({ ...pack, scope: scopeLabel, namespaces: layers.map((l) => l.namespace) }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  if (pack.rules.length === 0 && pack.notes.length === 0) {
    // Not an error: an untouched category is the normal case, and a trigger that fires
    // on one must stay silent rather than inject an apology.
    return { stdout: '', exitCode: EXIT_OK };
  }

  const out = [`# Memory pack — ${category} (${scopeLabel})`, ''];

  if (pack.rules.length) {
    out.push(
      `## Hard rules — ${pack.rules.length} — MANDATORY reading before acting in this category`,
      ''
    );
    for (const r of pack.rules) {
      out.push(`### ${r.slug}`);
      out.push(`_${r.description}_${r.namespace === 'root' ? '' : `  (${r.namespace})`}`);
      out.push('');
      out.push(r.body || '(empty body)');
      if (r.source) out.push('', `source: ${r.source}`);
      if (r.related.length) out.push('', `related: ${r.related.join(', ')}`);
      out.push('');
    }
  }

  if (pack.notes.length) {
    out.push(`## Other entries in '${category}' — read a body with \`sidekicks memory show <slug>\``, '');
    for (const n of pack.notes) {
      out.push(`- ${n.slug} — ${n.description}${n.namespace === 'root' ? '' : `  (${n.namespace})`}`);
    }
    out.push('');
  }

  return { stdout: out.join('\n'), exitCode: EXIT_OK };
}
