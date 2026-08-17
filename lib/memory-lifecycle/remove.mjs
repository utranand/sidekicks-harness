// lib/memory-lifecycle/remove.mjs
// `sidekicks memory remove <name> [--force]` — delete one entry + its index line.
//
// Deletes <name>.md (rmrf on the single file) and removes its MEMORY.md pointer
// line (RMW, preserving all other lines) from the ACTIVE scope only. Root entries
// are a shared inherited base — `remove` never deletes an inherited root entry
// from a project; switch to root scope to change the base. Not-found in the active
// scope → EXIT_NOT_FOUND (with a hint when the name exists only as inherited root).
// A single reversible file under git, so no confirmation is required. Paths repo-relative.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { read } from '../settings-store/settings.mjs';
import { resolveMemoryChain } from '../active-scope/memory-paths.mjs';
import { rmrf } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { EXIT_OK, SidekicksError, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { validateSlug, parseMemoryFlags, requireAgentLayer } from './_shared.mjs';
import { syncStoreFaces, readGraphJson } from './_store.mjs';

/**
 * Run `memory remove`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = validateSlug(args.name);
  // --force accepted for symmetry with other verbs; removal is reversible so it's a no-op flag.
  const flags = parseMemoryFlags(ctx.argv, ['force']);

  // --agent <name> removes from that agent's own store (no inheritance to guard).
  const { active, root, inherits } = flags.agent
    ? (() => { const l = requireAgentLayer(repoRoot, flags.agent); return { active: l, root: l, inherits: false }; })()
    : resolveMemoryChain(repoRoot, read(repoRoot));
  const { baseDir, scopeLabel, baseDirRel } = active;
  const entryPath = join(baseDir, `${name}.md`);
  const entryPathRel = `${baseDirRel}/${name}.md`;

  if (!existsSync(entryPath)) {
    // Distinguish "inherited from root" from genuinely absent, so the user knows
    // the entry exists but lives in the shared base they must change from root scope.
    if (inherits && existsSync(join(root.baseDir, `${name}.md`))) {
      throw new SidekicksError(
        `memory remove: '${name}' is inherited from root (${root.baseDirRel}/${name}.md), not in project '${scopeLabel}'. ` +
          `Switch to root scope to remove the shared entry: 'sidekicks project use sidekicks' then 'sidekicks memory remove ${name}'.`,
        EXIT_NOT_FOUND
      );
    }
    throw new SidekicksError(
      `memory remove: entry '${name}' not found at ${entryPathRel}`,
      EXIT_NOT_FOUND
    );
  }

  // Delete the single entry file (surface-gated).
  assertWritable(entryPath, repoRoot);
  rmrf(entryPath);

  // Regenerate the three faces. Edges that pointed at this slug survive the rebuild as
  // `dangling: true` rather than vanishing — a silently dropped edge is indistinguishable
  // from one that never existed, and `memory doctor` needs something to report.
  syncStoreFaces(repoRoot);

  const dangling = readGraphJson(repoRoot).edges.filter((e) => e.to === name && e.dangling);
  const lines = [`removed ${entryPathRel}`];
  if (dangling.length) {
    const froms = [...new Set(dangling.map((e) => e.from))];
    lines.push(
      `note: ${dangling.length} edge${dangling.length === 1 ? '' : 's'} now dangling `
        + `(from: ${froms.join(', ')}) — see 'sidekicks memory doctor'`
    );
  }

  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}
