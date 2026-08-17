// lib/memory-lifecycle/rebuild.mjs
// `sidekicks memory rebuild` — regenerate the central store's three generated faces.
//
// Self-heal after manual edits: scans EVERY namespace under .sidekicks/memory/ and
// rewrites MEMORY.md (human, grouped namespace -> category), index.json (machine
// index — the one file query/map/pack read) and graph.json (knowledge-graph adjacency).
//
// Whole-store by design: with one central store there is no per-scope index left to
// rebuild in isolation, and a partial regeneration is exactly how the three faces drift
// apart. `--agent` is accepted and ignored for backward compatibility with the old
// per-agent form, which now regenerates the same central files.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { EXIT_OK } from '../sk-cli/errors.mjs';
import { humanIndexPath, machineIndexPath } from '../active-scope/memory-paths.mjs';
import { parseMemoryFlags, listNamespaces } from './_shared.mjs';
import { syncStoreFaces, computeFingerprint, STORE_FACE_VERSION } from './_store.mjs';

/**
 * Is the committed index out of step with the entry files? Same fingerprint the read path
 * uses, so the hook and the readers agree on what "stale" means.
 *
 * @param {string} repoRoot
 * @returns {boolean}
 */
function facesAreStale(repoRoot) {
  const abs = machineIndexPath(repoRoot);
  if (!existsSync(abs)) return true;
  try {
    const parsed = JSON.parse(readFileSync(abs, 'utf8'));
    if (parsed?.version !== STORE_FACE_VERSION) return true;
    return parsed?.fingerprint?.hash !== computeFingerprint(repoRoot).hash;
  } catch {
    return true;
  }
}

/**
 * Run `memory rebuild`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'if-stale']);

  // --if-stale is what the post-merge git hook calls: after a merge that did not touch the
  // store, rewriting three files would dirty the working tree for nothing.
  if (flags['if-stale'] && !facesAreStale(repoRoot)) {
    const fresh = computeFingerprint(repoRoot);
    if (flags.json) {
      return {
        stdout: JSON.stringify({ stale: false, count: fresh.count, rebuilt: false }, null, 2) + '\n',
        exitCode: EXIT_OK,
      };
    }
    return { stdout: `memory rebuild: up to date — ${fresh.count} entries, nothing regenerated\n`, exitCode: EXIT_OK };
  }

  const result = syncStoreFaces(repoRoot);
  const namespaces = listNamespaces(repoRoot);

  if (flags.json) {
    return {
      stdout: JSON.stringify({ ...result, namespaces }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const indexRel = relative(repoRoot, humanIndexPath(repoRoot)).replace(/\\/g, '/');
  const storeRel = indexRel.replace(/\/MEMORY\.md$/, '');
  return {
    stdout:
      `rebuilt ${storeRel}/{MEMORY.md, index.json, graph.json} — `
      + `${result.count} ${result.count === 1 ? 'entry' : 'entries'} across `
      + `${namespaces.length} namespace${namespaces.length === 1 ? '' : 's'}, `
      + `${result.edges} graph edge${result.edges === 1 ? '' : 's'}\n`,
    exitCode: EXIT_OK,
  };
}
