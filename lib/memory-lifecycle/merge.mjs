// lib/memory-lifecycle/merge.mjs
// `sidekicks memory merge <install|status|uninstall|driver>`
//
// The git-side of the central store: one driver that makes a memory merge conflict-free.
//
//   install    register `merge.sidekicks-memory` in THIS clone (+ the post-merge hooks)
//   status     what is wired and what is not — the thing to run when a merge still conflicted
//   uninstall  drop the registration; `.gitattributes` stays (an unregistered driver name
//              just falls back to git's text merge)
//   driver     THE BACKEND GIT CALLS. Not for humans.
//
// Two path classes, because they have different truths:
//
//   ENTRY (`*.md`)                the source of truth. Merged semantically by _merge.mjs,
//                                 body text merged by `git merge-file` itself.
//   FACE (MEMORY.md/index.json/   DERIVED. The driver cannot regenerate them: git merges
//        graph.json)              paths in an unspecified order, so the entries are not
//                                 final while the driver runs. It keeps ours and exits
//                                 clean; the post-merge hook and the read-side fingerprint
//                                 check in _store.mjs are what make them true again.
//
// Anything else routed here by a stale `.gitattributes` falls through to git's own
// three-way merge with markers, exit code included — a driver that silently resolved a file
// it does not understand would be worse than the conflict.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  HUMAN_INDEX_NAME,
  MACHINE_INDEX_NAME,
  GRAPH_NAME,
} from '../active-scope/memory-paths.mjs';
import { parseMemoryFlags } from './_shared.mjs';
import { mergeEntry, unionBody } from './_merge.mjs';
import {
  DRIVER_NAME,
  ensureMemoryMergeDriver,
  removeMemoryMergeDriver,
  driverStatus,
  cliRelPath,
  driverCommand,
} from './_merge-driver.mjs';

const SUBS = ['install', 'status', 'uninstall', 'driver'];

/** The three generated faces — derived, never merged. */
const FACE_NAMES = new Set([HUMAN_INDEX_NAME, MACHINE_INDEX_NAME, GRAPH_NAME]);

/**
 * Classify the path git is merging.
 *
 * @param {string} path - the repo-relative path git passed as %P
 * @returns {'face'|'entry'|'other'}
 */
export function classifyPath(path) {
  const p = String(path ?? '').replace(/\\/g, '/');
  const name = basename(p);
  if (FACE_NAMES.has(name)) return 'face';
  if (!p.endsWith('.md')) return 'other';
  // Only files inside the store are entries. An evidence snapshot is prose, not an entry —
  // it is never routed here by our .gitattributes, and if it were, it is not ours to rebuild.
  if (!/(^|\/)\.sidekicks\/memory\//.test(p)) return 'other';
  if (/(^|\/)\.sidekicks\/memory\/evidence\//.test(p)) return 'other';
  return 'entry';
}

/** Read a file, or null when git passed a path for a side that does not exist. */
function readSide(path) {
  if (!path) return null;
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/**
 * Merge two BODY texts with git's own three-way engine.
 *
 * Reusing `git merge-file` rather than writing a diff3: git is already a hard dependency of
 * this CLI, and its merge is the one every reviewer's mental model is calibrated to. Clean
 * merges keep git's result verbatim; a conflicting merge is re-run with `--union` so the
 * store never receives markers, and the caller stamps `merge_review` on the entry.
 *
 * @param {string} base
 * @param {string} ours
 * @param {string} theirs
 * @returns {{ body: string, conflicted: boolean }}
 */
function gitBodyMerge(base, ours, theirs) {
  const dir = mkdtempSync(join(tmpdir(), 'sk-memmerge-'));
  const paths = {
    base: join(dir, 'base'),
    ours: join(dir, 'ours'),
    theirs: join(dir, 'theirs'),
  };
  const nl = (s) => (s.endsWith('\n') || s === '' ? s : `${s}\n`);
  try {
    writeFileSync(paths.base, nl(base), 'utf8');
    writeFileSync(paths.ours, nl(ours), 'utf8');
    writeFileSync(paths.theirs, nl(theirs), 'utf8');
    const attempt = (extra) => spawnSync('git', [
      'merge-file', '-p', ...extra,
      '-L', 'ours', '-L', 'base', '-L', 'theirs',
      paths.ours, paths.base, paths.theirs,
    ], { shell: false, encoding: 'utf8' });

    const clean = attempt([]);
    // status 0 = clean; >0 = that many conflicts; <0 = git could not run at all.
    if (!clean.error && clean.status === 0) {
      return { body: String(clean.stdout ?? '').replace(/\n+$/, ''), conflicted: false };
    }
    const union = attempt(['--union']);
    if (!union.error && union.status !== null && union.status >= 0) {
      return { body: String(union.stdout ?? '').replace(/\n+$/, ''), conflicted: true };
    }
    // git unavailable — the pure fallback in _merge.mjs is still correct, just coarser.
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

/**
 * The driver sub-verb. Writes the merged result to the `--ours` path (git's `%A`) and exits 0
 * when the merge is clean by git's contract.
 *
 * `%A` is a git temp file OUTSIDE the CLI-managed write surface, so this is the one place in
 * the memory verbs that writes without assertWritable: the path is chosen by git, and
 * refusing it would break the merge git asked us to perform.
 *
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @param {Record<string, string|boolean>} flags
 * @returns {{ stdout: string, exitCode: number }}
 */
function runDriver(ctx, flags) {
  const oursPath = flags.ours ? String(flags.ours) : '';
  const theirsPath = flags.theirs ? String(flags.theirs) : '';
  const basePath = flags.base ? String(flags.base) : '';
  const path = flags.path ? String(flags.path) : '';
  if (!oursPath || !theirsPath) {
    throw new SidekicksError(
      'memory merge driver: --ours and --theirs are required — this sub-verb is invoked BY git '
        + "(see 'sidekicks memory merge status'), not by hand",
      EXIT_VALIDATION
    );
  }

  const kind = classifyPath(path);

  if (kind === 'face') {
    // %A already holds ours; leaving it untouched IS the answer. The faces are regenerated
    // from the merged entries afterwards (post-merge hook, or the next memory read).
    return { stdout: `memory merge: kept ours for the generated face ${path} — it is rebuilt from the entries\n`, exitCode: EXIT_OK };
  }

  if (kind === 'other') {
    const marker = flags['marker-size'] ? ['--marker-size', String(flags['marker-size'])] : [];
    const r = spawnSync('git', ['merge-file', ...marker, oursPath, basePath, theirsPath], {
      shell: false, encoding: 'utf8',
    });
    const code = r.error ? 1 : (r.status === 0 ? EXIT_OK : 1);
    return {
      stdout: `memory merge: '${path}' is not a store entry — deferred to git's text merge\n`,
      exitCode: code,
    };
  }

  const merged = mergeEntry(
    { base: readSide(basePath), ours: readSide(oursPath), theirs: readSide(theirsPath) },
    // git first, the pure union as the fallback when git itself could not run.
    { mergeBody: (b, o, t) => gitBodyMerge(b, o, t) ?? unionBody(b, o, t) },
  );

  writeFileSync(oursPath, merged.text, 'utf8');

  const lines = [`memory merge: merged ${path || basename(oursPath)}`];
  for (const n of merged.notes) lines.push(`  ${n}`);
  if (merged.conflicted) {
    lines.push(`  flagged merge_review=${merged.review} — clear it with 'sidekicks memory resolve ${basename(oursPath, '.md')} --accept'`);
  }
  // Exit 0 either way: the file on disk is complete and marker-free. A non-zero exit would
  // leave git writing conflict markers over the merge we just performed.
  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}

/**
 * Run `memory merge`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log?: Function }} ctx
 * @param {{ name?: string }} args - name = sub-verb
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json']);
  const sub = args.name || 'status';
  if (!SUBS.includes(sub)) {
    throw new SidekicksError(
      `memory merge: expected one of ${SUBS.join(', ')} — e.g. 'sidekicks memory merge status'`,
      EXIT_VALIDATION
    );
  }

  if (sub === 'driver') return runDriver(ctx, flags);

  if (sub === 'install') {
    const result = ensureMemoryMergeDriver(repoRoot, ctx.log ?? (() => {}));
    const status = driverStatus(repoRoot);
    if (flags.json) {
      return { stdout: JSON.stringify({ ...result, status }, null, 2) + '\n', exitCode: result.ok ? EXIT_OK : EXIT_VALIDATION };
    }
    if (!result.ok) {
      return { stdout: `memory merge: NOT registered — ${result.reason}\n`, exitCode: EXIT_VALIDATION };
    }
    const out = [
      result.installed
        ? `registered merge driver '${DRIVER_NAME}' for this clone (covers every worktree of it)`
        : `merge driver '${DRIVER_NAME}' was already registered`,
    ];
    if (result.hooks?.written.length) out.push(`hooks written: ${result.hooks.written.join(', ')}`);
    if (result.hooks?.blocked.length) {
      out.push(`hooks NOT written (a foreign hook is there — left alone): ${result.hooks.blocked.join(', ')}`);
      out.push('the faces still self-heal on the next memory read, so this is a slower path, not a broken one');
    }
    if (!status.attributes) {
      out.push(`warning: no 'merge=${DRIVER_NAME}' line in .gitattributes — nothing routes to the driver yet`);
    }
    return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
  }

  if (sub === 'uninstall') {
    const result = removeMemoryMergeDriver(repoRoot);
    if (flags.json) {
      return { stdout: JSON.stringify(result, null, 2) + '\n', exitCode: result.ok ? EXIT_OK : EXIT_VALIDATION };
    }
    const out = [result.ok
      ? `removed the '${DRIVER_NAME}' merge driver from this clone — memory files fall back to git's text merge`
      : `memory merge uninstall: ${result.reason}`];
    if (result.removedHooks.length) out.push(`neutralized hook(s): ${result.removedHooks.join(', ')}`);
    out.push(`note: set SIDEKICKS_MEMORY_MERGE=off in the environment, or the next 'sidekicks' run re-registers it`);
    return { stdout: out.join('\n') + '\n', exitCode: result.ok ? EXIT_OK : EXIT_VALIDATION };
  }

  // status
  const status = driverStatus(repoRoot);
  if (flags.json) {
    return { stdout: JSON.stringify(status, null, 2) + '\n', exitCode: EXIT_OK };
  }
  const cli = cliRelPath(repoRoot);
  const out = [
    `Memory merge driver '${DRIVER_NAME}'`,
    '',
    `  git checkout    ${status.git ? 'yes' : 'NO — nothing to register'}`,
    `  registered      ${status.registered ? 'yes' : 'NO'}`,
    `  .gitattributes  ${status.attributes ? `routes to ${DRIVER_NAME}` : 'NO merge= line — nothing routes here'}`,
    `  cli entry       ${cli ?? 'NOT FOUND (no bin/sidekicks)'}`,
    `  driver command  ${cli ? driverCommand(cli) : '(unavailable)'}`,
  ];
  if (status.hooksDir) {
    const rel = relative(repoRoot, status.hooksDir);
    const shown = rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : status.hooksDir;
    out.push(`  hooks dir       ${shown}${status.hooksPath ? `  (core.hooksPath=${status.hooksPath})` : ''}`);
  }
  for (const h of status.hooks) out.push(`  hook ${h.name.padEnd(14)}${h.state}`);
  if (status.strayHooks?.length) {
    out.push('');
    out.push(`WARNING: ${status.strayHooks.join(', ')} also sits in the git dir's own hooks/ directory, which`);
    out.push(`core.hooksPath=${status.hooksPath} makes git ignore ENTIRELY — that copy can never fire.`);
    out.push('It is a leftover from before the hooks dir was resolved; deleting it changes nothing but the confusion.');
  }
  if (status.disabled) out.push('', 'SIDEKICKS_MEMORY_MERGE=off — self-heal is switched off in this environment');
  if (!status.registered && !status.disabled) {
    out.push('', "not registered — run 'sidekicks memory merge install' (any sidekicks command also self-heals it)");
  }
  out.push('');
  return { stdout: out.join('\n'), exitCode: EXIT_OK };
}
