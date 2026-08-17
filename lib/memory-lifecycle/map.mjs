// lib/memory-lifecycle/map.mjs
// `sidekicks memory map [--json] [--all]` — the compact category map.
//
// THIS IS THE ONLY THING A SESSION LOADS AT START. The whole listing used to be
// injected eagerly: ~36 KB / ~9k tokens of entries, almost none of which the session
// would touch, growing with every entry ever registered. The map replaces it with one
// line per category — what exists, how much of it, and how many hard rules are in it —
// and the session pulls a category's bodies only when it is about to act in that
// category (`memory pack <category>`).
//
// Scope-resolved like every read verb: a project sees its own namespace plus inherited
// root. `--all` counts the whole store across every namespace instead.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { read } from '../settings-store/settings.mjs';
import { resolveMemoryChain } from '../active-scope/memory-paths.mjs';
import { parseMemoryFlags, requireAgentLayer } from './_shared.mjs';
import { readIndexJson } from './_store.mjs';

/**
 * Count entries and rules per category over a set of namespaces, honouring the
 * most-specific-wins collision rule so an overridden root entry is not counted twice.
 *
 * @param {Array<object>} rows - index.json entries
 * @param {string[]} namespaces - most-specific first
 * @returns {Array<{ category: string, entries: number, rules: number }>}
 */
export function categoryCounts(rows, namespaces) {
  const rank = new Map(namespaces.map((ns, i) => [ns, i]));
  const winner = new Map();
  for (const row of rows) {
    if (!rank.has(row.namespace)) continue;
    const prev = winner.get(row.slug);
    if (prev && rank.get(prev.namespace) <= rank.get(row.namespace)) continue;
    winner.set(row.slug, row);
  }
  const byCategory = new Map();
  for (const row of winner.values()) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, { category: row.category, entries: 0, rules: 0 });
    const c = byCategory.get(row.category);
    c.entries += 1;
    if (row.rule) c.rules += 1;
  }
  return [...byCategory.values()].sort((a, b) => (b.entries - a.entries) || a.category.localeCompare(b.category));
}

/**
 * Run `memory map`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'all', 'local']);
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

  const counts = categoryCounts(index.entries, namespaces);
  const total = counts.reduce((n, c) => n + c.entries, 0);
  const totalRules = counts.reduce((n, c) => n + c.rules, 0);

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        scope: scopeLabel, namespaces, total, rules: totalRules, categories: counts,
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  if (counts.length === 0) {
    return { stdout: `No local-memory entries for scope '${scopeLabel}'.\n`, exitCode: EXIT_OK };
  }

  const parts = counts.map((c) => (c.rules
    ? `${c.category} (${c.entries} ${c.entries === 1 ? 'entry' : 'entries'}, ${c.rules} rule${c.rules === 1 ? '' : 's'})`
    : `${c.category} (${c.entries})`));

  return {
    stdout: `Memory exists for: ${parts.join(' · ')}\n`,
    exitCode: EXIT_OK,
  };
}
