// lib/artifacts-lifecycle/scan.mjs
// `artifacts scan [--json]`
//
// Scan the WHOLE repo for every skill-generated artifact — the root store plus every
// project and service store — group them by type, and persist a single consolidated
// inventory at .sidekicks/artifacts-inventory.{json,md}. Unlike `artifacts rebuild`
// (Jira-only, active project), this is repo-wide and type-agnostic. Read-only over the
// artifacts themselves; its only writes are the two derived inventory files.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { parseArtifactFlags } from './_shared.mjs';
import {
  buildInventory,
  writeInventory,
  ensureInventoryIgnore,
  buildRunningAgents,
  writeRunningAgents,
} from './_manage.mjs';
import { readLivenessConfig } from './liveness-config.mjs';
import { resolveWatchRoots } from './watch-config.mjs';

/**
 * Run `artifacts scan`.
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx) {
  const flags = parseArtifactFlags(ctx.argv, ['json']);
  // Threshold precedence: --stale-seconds flag › .sidekicks/agents-liveness.yaml › built-in
  // default. (scan is a manual command, so it ignores the config's `enabled` toggle — that
  // gates only the automatic watcher; a hand-run scan always produces the inventory.)
  const cfg = readLivenessConfig(ctx.repoRoot);
  const opts = { staleSeconds: cfg.staleSeconds };
  const flagStale = Number(flags['stale-seconds']);
  if (Number.isFinite(flagStale) && flagStale > 0) opts.staleSeconds = flagStale;
  // Extra watch folders from .sidekicks/agents-watch.yaml — runs anchored outside the
  // standard bases (plan-centric trees, artifacts_dir overrides) join the same inventory.
  opts.watchRoots = resolveWatchRoots(ctx.repoRoot);
  const inv = buildInventory(ctx.repoRoot, opts);
  const { jsonRel, mdRel } = writeInventory(ctx.repoRoot, inv);
  // The centralized running-agents view — every agent's identity + status + liveness in one
  // file — is derived from the same build and persisted alongside (the office-viz handoff).
  const { jsonRel: agentsRel } = writeRunningAgents(ctx.repoRoot, buildRunningAgents(inv));
  try { ensureInventoryIgnore(ctx.repoRoot); } catch { /* best-effort */ }

  if (flags.json) {
    return { stdout: JSON.stringify(inv, null, 2) + '\n', exitCode: EXIT_OK };
  }

  const t = inv.totals;
  const live = t.runs + t.sql + t['command-sequence'] + t['office-viz'] + t.other;
  const mins = Math.round((inv.stale_seconds_threshold || 0) / 60);
  const lines = [
    `Artifacts inventory — ${live} live artifact${live === 1 ? '' : 's'} (+ ${t.archived} archived):`,
    '',
    `  runs:             ${t.runs}  (${t.running_live} actually running, ${t.stale_running} stale/orphaned)`,
    `  sql:              ${t.sql}`,
    `  command-sequence: ${t['command-sequence']}`,
    `  office-viz:       ${t['office-viz']}`,
    `  other:            ${t.other}`,
    `  archived:         ${t.archived}`,
    '',
  ];
  // Surface orphaned runs prominently — this is the whole point of the liveness signal.
  if (t.stale_running > 0) {
    lines.push(`⚠ ${t.stale_running} stale/orphaned run${t.stale_running === 1 ? '' : 's'} (status active but heartbeat > ${mins}m — likely a dead worker):`);
    for (const r of inv.activity.stale) {
      const age = r.heartbeat_age_seconds == null ? 'unknown' : `${r.heartbeat_age_seconds}s ago`;
      lines.push(`    [${r.status}] ${r.skill}/${r.slug} — heartbeat ${age}  ${r.path}`);
    }
    lines.push('');
  }
  if ((inv.watch_roots || []).length > 0) {
    lines.push(`Watching ${inv.watch_roots.length} extra root${inv.watch_roots.length === 1 ? '' : 's'} (agents-watch.yaml):`);
    for (const wr of inv.watch_roots) lines.push(`    ${wr.path}  [${wr.scope}]`);
    lines.push('');
  }
  lines.push(`Written: ${jsonRel} + ${mdRel} + ${agentsRel}`, '');
  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}
