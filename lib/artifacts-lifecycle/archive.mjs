// lib/artifacts-lifecycle/archive.mjs
// `artifacts archive <path> [--force]`  |  `artifacts archive --done [--dry-run]`  |
// `artifacts archive --stale [--older-than <days>] [--force] [--dry-run]`
//
// Move artifact folders into their scope's artifacts/archived/ mirror (reversible git-mv,
// staged, never committed). Three modes:
//   • single: archive one <path> (a run, sql import, command-sequence, …).
//   • batch --done:  archives EVERY live run whose status is `done`, repo-wide, in one
//             shot — the automatic "clean up finished work" pass. --dry-run previews it.
//   • batch --stale: archives every ORPHANED run — active status (running/blocked/paused)
//             but heartbeat both stale (past the scan's liveness threshold) AND abandoned for
//             --older-than days (default 7) — the "clean up old dead agents" pass. Still gated
//             by --force (same active-run safety contract as single-path archiving); --dry-run
//             previews the candidate list either way.
// A run still running/blocked/paused is refused unless --force, so archiving never hides
// active work.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { SidekicksError, EXIT_OK, EXIT_USAGE, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { parseArtifactFlags } from './_shared.mjs';
import { archiveOne, doneRunPaths, staleRunCandidates, DEFAULT_STALE_ARCHIVE_DAYS, refreshInventory } from './_manage.mjs';

const USAGE =
  'artifacts archive: usage: artifacts archive <path> [--force]  |  artifacts archive --done [--dry-run]  |  artifacts archive --stale [--older-than <days>] [--force] [--dry-run]';

/**
 * Run `artifacts archive`.
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on all failure paths.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseArtifactFlags(ctx.argv, ['force', 'done', 'stale', 'dry-run', 'json']);

  if (flags.done) return batch(repoRoot, { force: !!flags.force, dryRun: !!flags['dry-run'] });
  if (flags.stale) {
    return batchStale(repoRoot, {
      force: !!flags.force,
      dryRun: !!flags['dry-run'],
      olderThanDays: flags['older-than'],
    });
  }

  // ── single-path mode ──
  const target = args.name;
  if (!target) throw new SidekicksError(USAGE, EXIT_USAGE);

  const r = archiveOne(repoRoot, target, { force: !!flags.force });
  if (!r.ok) {
    // A refused active run gets the explicit --force hint; other reasons print as-is.
    const hint = /active run/.test(r.reason || '')
      ? `\nPass --force to archive it anyway (reversible via 'artifacts restore').`
      : '';
    throw new SidekicksError(`artifacts archive: ${r.reason}${hint}`, EXIT_VALIDATION);
  }
  refreshInventory(repoRoot);
  const note = r.method === 'git'
    ? 'Staged (git mv) — commit yourself when ready.'
    : 'Moved (plain mv — not a git repo, or git unavailable).';
  return { stdout: `archived: ${r.from} → ${r.to}\n${note}\n`, exitCode: EXIT_OK };
}

/**
 * Batch mode: archive every `done` run repo-wide.
 * @param {string} repoRoot
 * @param {{ force: boolean, dryRun: boolean }} opts
 */
function batch(repoRoot, opts) {
  const paths = doneRunPaths(repoRoot);
  if (paths.length === 0) {
    return { stdout: 'artifacts archive --done: no done runs to archive.\n', exitCode: EXIT_OK };
  }

  if (opts.dryRun) {
    const lines = [`artifacts archive --done (dry-run): would archive ${paths.length} done run${paths.length === 1 ? '' : 's'}:`, ''];
    for (const p of paths) lines.push(`  ${p}`);
    lines.push('', 'Re-run without --dry-run to move them (reversible via `artifacts restore`).', '');
    return { stdout: lines.join('\n'), exitCode: EXIT_OK };
  }

  let ok = 0;
  const failures = [];
  for (const p of paths) {
    const r = archiveOne(repoRoot, p, { force: opts.force });
    if (r.ok) ok++;
    else failures.push(`  ${p} — ${r.reason}`);
  }
  refreshInventory(repoRoot);

  const lines = [`archived ${ok}/${paths.length} done run${paths.length === 1 ? '' : 's'} into their scope archives (staged git mv — commit when ready).`];
  if (failures.length) {
    lines.push('', `${failures.length} skipped:`, ...failures);
  }
  lines.push('');
  // A partial failure is still a non-fatal outcome — report it, exit EXIT_OK so a clean-up
  // sweep never hard-fails the caller; the skipped list is the actionable signal.
  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}

const ageLabel = (r) => (r.heartbeat_age_seconds == null
  ? 'unknown age'
  : `${(r.heartbeat_age_seconds / 86400).toFixed(1)}d idle`);

/**
 * Batch mode: archive every ORPHANED run repo-wide — active status (running/blocked/paused)
 * but stale AND abandoned past --older-than days. Selection alone never moves anything: the
 * active-run safety gate still applies, so the actual move requires --force (same contract as
 * single-path archiving of a live run) — --dry-run always just lists the candidates.
 * @param {string} repoRoot
 * @param {{ force: boolean, dryRun: boolean, olderThanDays: string|number|undefined }} opts
 */
function batchStale(repoRoot, opts) {
  const parsedDays = Number(opts.olderThanDays);
  const olderThanDays = Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays : DEFAULT_STALE_ARCHIVE_DAYS;
  const candidates = staleRunCandidates(repoRoot, { olderThanSeconds: olderThanDays * 86400 });

  if (candidates.length === 0) {
    return { stdout: `artifacts archive --stale: no orphaned runs older than ${olderThanDays}d found.\n`, exitCode: EXIT_OK };
  }

  if (opts.dryRun) {
    const lines = [
      `artifacts archive --stale (dry-run): would archive ${candidates.length} orphaned run${candidates.length === 1 ? '' : 's'} (older than ${olderThanDays}d):`,
      '',
    ];
    for (const r of candidates) lines.push(`  [${r.status}] ${r.path} — ${ageLabel(r)}`);
    lines.push('', 'Re-run with --force (without --dry-run) to move them (reversible via `artifacts restore`).', '');
    return { stdout: lines.join('\n'), exitCode: EXIT_OK };
  }

  if (!opts.force) {
    const lines = [
      `artifacts archive --stale: ${candidates.length} orphaned run${candidates.length === 1 ? '' : 's'} older than ${olderThanDays}d (active status — needs --force to move):`,
      '',
    ];
    for (const r of candidates) lines.push(`  [${r.status}] ${r.path} — ${ageLabel(r)}`);
    lines.push('', 'Confirm these are truly dead, then re-run with --force (reversible via `artifacts restore`).');
    throw new SidekicksError(lines.join('\n'), EXIT_VALIDATION);
  }

  let ok = 0;
  const failures = [];
  for (const r of candidates) {
    const res = archiveOne(repoRoot, r.path, { force: true });
    if (res.ok) ok++;
    else failures.push(`  ${r.path} — ${res.reason}`);
  }
  refreshInventory(repoRoot);

  const lines = [`archived ${ok}/${candidates.length} orphaned run${candidates.length === 1 ? '' : 's'} (older than ${olderThanDays}d) into their scope archives (staged git mv — commit when ready).`];
  if (failures.length) {
    lines.push('', `${failures.length} skipped:`, ...failures);
  }
  lines.push('');
  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}
