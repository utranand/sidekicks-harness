// lib/memory-lifecycle/list.mjs
// `sidekicks memory list [--json] [--local] [--compact] [--category <c>] [--namespace <ns>] [--agent <a>]`
//
// INHERITANCE: when a user project is active, the effective set is the project's
// own entries PLUS the inherited root entries, with the project layer winning on
// a name collision (marked "overrides root"). Root entries the project doesn't
// override are marked "inherited from root". `--local` restricts to the active
// scope only (no inheritance). When root is the active scope there is nothing to
// inherit, so the listing is just the root namespace.
//
// Reads the central machine index (`.sidekicks/memory/index.json`) — ONE file read for
// the whole store, instead of a directory walk per layer. That is the point of the
// central store: the old walk could cross a git submodule and an unmounted external
// volume before it could answer "what do I know".
//
// Human form prints `name — description` with an origin tag; --json emits an array
// of { name, description, type, category, rule, source, path, scope, namespace,
// inherited, overridden }. --compact prints the header + one slug per line (no
// descriptions, no tags) — the cheap index form headless wakes inject into session
// context. Empty → a friendly message / []. All paths repo-relative.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { read } from '../settings-store/settings.mjs';
import { resolveMemoryChain, layerForNamespace } from '../active-scope/memory-paths.mjs';
import { parseMemoryFlags, requireAgentLayer } from './_shared.mjs';
import { readIndexJson } from './_store.mjs';

/**
 * Run `memory list`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'local', 'compact']);

  // --agent <name> lists a named agent's own namespace (no inheritance);
  // --namespace <ns> pins one namespace directly; otherwise the active scope's chain.
  let active;
  let chain;
  let inherits;
  if (flags.agent) {
    active = requireAgentLayer(repoRoot, flags.agent);
    chain = [active];
    inherits = false;
  } else if (flags.namespace) {
    active = layerForNamespace(repoRoot, String(flags.namespace));
    chain = [active];
    inherits = false;
  } else {
    ({ active, chain, inherits } = resolveMemoryChain(repoRoot, read(repoRoot)));
  }
  // --local (or no inheritance) → only the active layer.
  const layers = flags.local ? [active] : chain;

  const categoryFilter = flags.category ? String(flags.category) : null;
  const index = readIndexJson(repoRoot);

  // Bucket the one index read by namespace so the merge below stays a lookup.
  const byNamespace = new Map();
  for (const row of index.entries) {
    if (categoryFilter && row.category !== categoryFilter) continue;
    if (!byNamespace.has(row.namespace)) byNamespace.set(row.namespace, []);
    byNamespace.get(row.namespace).push(row);
  }

  // Merge most-specific-first: the first layer to define a slug owns it; a later
  // (root) layer defining the same slug is recorded as "overridden".
  const byName = new Map();
  const overriddenInRoot = new Set();
  for (const layer of layers) {
    for (const row of byNamespace.get(layer.namespace) ?? []) {
      if (byName.has(row.slug)) {
        if (layer.kind === 'root') overriddenInRoot.add(row.slug);
        continue; // a more-specific layer already owns this slug
      }
      byName.set(row.slug, {
        name: row.slug,
        description: row.description,
        type: row.type,
        category: row.category,
        rule: row.rule,
        source: row.source,
        path: `${layer.baseDirRel}/${row.slug}.md`,
        scope: layer.scopeLabel,
        namespace: row.namespace,
        inherited: layer.kind === 'root' && active.kind !== 'root',
        overridden: false,
      });
    }
  }
  for (const slug of overriddenInRoot) {
    const e = byName.get(slug);
    if (e) e.overridden = true;
  }

  const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (flags.json) {
    return { stdout: JSON.stringify(entries, null, 2) + '\n', exitCode: EXIT_OK };
  }

  if (entries.length === 0) {
    // The exact "No local-memory entries" prefix is what the SessionStart hook sniffs
    // to stay silent on an empty store — do not reword it without updating that hook.
    const filter = categoryFilter ? ` in category '${categoryFilter}'` : '';
    return {
      stdout: `No local-memory entries${filter} for scope '${active.scopeLabel}' (${active.baseDirRel}/). Add one with 'sidekicks memory add <name> --description "..."'.\n`,
      exitCode: EXIT_OK,
    };
  }

  const scopeBit = inherits && !flags.local
    ? `${active.scopeLabel} (${active.baseDirRel}/) + inherited root`
    : `${active.scopeLabel} (${active.baseDirRel}/)`;
  const header = categoryFilter
    ? `Local memory — ${scopeBit} — category '${categoryFilter}'`
    : `Local memory — ${scopeBit}`;
  const lines = [header, ''];
  for (const e of entries) {
    if (flags.compact) {
      lines.push(`  ${e.name}`);
      continue;
    }
    let tag = '';
    if (e.inherited) tag = '  [inherited from root]';
    else if (e.overridden) tag = '  [local, overrides root]';
    if (e.rule) tag = `  [rule]${tag}`;
    lines.push(`  ${e.name} — ${e.description}${tag}`);
  }
  lines.push('');
  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}
