// lib/memory-lifecycle/show.mjs
// `sidekicks memory show <name> [--json] [--local]` — print one entry.
//
// INHERITANCE: when a user project is active, look in the project layer first,
// then fall back to the inherited root layer (project overrides root). `--local`
// restricts the lookup to the active scope (no root fallback). Not-found across
// the chain → EXIT_NOT_FOUND.
//
// Human form prints the entry file content verbatim (with a one-line origin note
// when the entry was inherited from root); --json emits
// { name, scope, inherited, path, frontmatter, body }.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { read } from '../settings-store/settings.mjs';
import { resolveMemoryChain, storeRoot } from '../active-scope/memory-paths.mjs';
import { EXIT_OK, SidekicksError, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { validateSlug, parseMemoryFlags, parseEntryFile, requireAgentLayer } from './_shared.mjs';

/** How much of a resolved lineage anchor `--trace` prints. */
const TRACE_LINES = 40;

/**
 * Resolve a durable lineage anchor to a readable excerpt.
 *
 * Every form here outlives the run that produced it — that is the whole reason
 * `artifacts/runs/…` is refused at add time. Resolution is best-effort: an anchor that
 * cannot be resolved right now (a commit not in this clone, a journal id on another
 * node) reports why instead of failing the show.
 *
 * @param {string} repoRoot
 * @param {string} source
 * @returns {{ label: string, text: string }}
 */
function traceSource(repoRoot, source) {
  const clip = (t) => t.replace(/\r\n?/g, '\n').split('\n').slice(0, TRACE_LINES).join('\n');

  if (source.startsWith('commit:')) {
    const sha = source.slice('commit:'.length);
    const res = spawnSync('git', ['-C', repoRoot, 'show', '--stat', '--no-color', sha], {
      encoding: 'utf8', shell: false,
    });
    if (res.error || res.status !== 0) {
      return { label: `commit ${sha}`, text: `(not resolvable in this clone: ${(res.stderr || '').trim().split('\n')[0] || 'git show failed'})` };
    }
    return { label: `commit ${sha}`, text: clip(res.stdout || '') };
  }

  if (source.startsWith('journal:')) {
    const id = source.slice('journal:'.length);
    return {
      label: `journal ${id}`,
      text: `(journal entries are event-sourced — resolve with the verb that owns this id, `
        + `e.g. 'sidekicks journal mission show ${id}' or 'sidekicks journal issue show ${id}')`,
    };
  }

  // evidence/… is store-relative; anything else is repo-relative committed prose.
  const abs = source.startsWith('evidence/')
    ? join(storeRoot(repoRoot), source)
    : join(repoRoot, source);
  if (!existsSync(abs)) {
    return { label: source, text: '(file not found — the anchor no longer resolves)' };
  }
  try {
    return { label: source, text: clip(readFileSync(abs, 'utf8')) };
  } catch (err) {
    return { label: source, text: `(unreadable: ${err.message})` };
  }
}

/**
 * Run `memory show`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = validateSlug(args.name);
  const flags = parseMemoryFlags(ctx.argv, ['json', 'local', 'trace']);

  // --agent <name> looks only in that agent's own store (no root fallback).
  const { active, chain } = flags.agent
    ? (() => { const l = requireAgentLayer(repoRoot, flags.agent); return { active: l, chain: [l] }; })()
    : resolveMemoryChain(repoRoot, read(repoRoot));
  const layers = flags.local ? [active] : chain;

  // Resolve from the first (most-specific) layer that has the entry.
  let hit = null;
  for (const layer of layers) {
    const entryPath = join(layer.baseDir, `${name}.md`);
    if (existsSync(entryPath)) {
      hit = { layer, entryPath, entryPathRel: `${layer.baseDirRel}/${name}.md` };
      break;
    }
  }

  if (!hit) {
    const where = flags.local
      ? `${active.baseDirRel}/`
      : layers.map((l) => `${l.baseDirRel}/`).join(' or ');
    throw new SidekicksError(
      `memory show: entry '${name}' not found in ${where}`,
      EXIT_NOT_FOUND
    );
  }

  const inherited = hit.layer.kind === 'root' && active.kind !== 'root';
  const text = readFileSync(hit.entryPath, 'utf8');
  const { frontmatter, body } = parseEntryFile(text);
  const source = frontmatter?.metadata?.source ?? null;
  const trace = (flags.trace && source) ? traceSource(repoRoot, String(source)) : null;

  if (flags.json) {
    const out = {
      name,
      scope: hit.layer.scopeLabel,
      namespace: hit.layer.namespace,
      inherited,
      path: hit.entryPathRel,
      frontmatter,
      body,
    };
    if (flags.trace) out.trace = trace ?? { label: null, text: '(entry declares no source)' };
    return { stdout: JSON.stringify(out, null, 2) + '\n', exitCode: EXIT_OK };
  }

  // Human form — print the file content verbatim, prefixed with an origin note
  // when the entry came from the inherited root layer.
  const prefix = inherited ? `# (inherited from root — ${hit.entryPathRel})\n\n` : '';
  let stdout = prefix + (text.endsWith('\n') ? text : text + '\n');
  if (flags.trace) {
    stdout += trace
      ? `\n--- lineage: ${trace.label} ---\n${trace.text}\n`
      : '\n--- lineage: (entry declares no source) ---\n';
  }
  return { stdout, exitCode: EXIT_OK };
}
