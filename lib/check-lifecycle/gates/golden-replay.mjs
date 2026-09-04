// lib/check-lifecycle/gates/golden-replay.mjs
// The `golden.replay` gate: compare the product's real output against the curated golden fixtures.
//
// REPLAY ONLY. There is deliberately NO update path in this file — no `--apply`, no `--update`, no
// environment variable that would let a fixture be rewritten from here, and nothing that writes
// anywhere. A gate that can refresh its own expectations cannot fail, and a snapshot suite whose CI
// leg rewrites the snapshot proves only that the code agrees with itself. Refreshing a fixture is an
// explicit local review step (scripts/update-golden-contracts.mjs, Phase 5) that a human runs and
// reads a diff from; this gate only ever reads.
//
// ABSENT FIXTURES ARE NOT A PASS — in the repo that owns them. Until the curated fixtures exist
// there, the gate reports `skipped` with that as its reason, and because the gate is BLOCKING a skip
// fails the profile. That is the intended behaviour, not a gap: `release` is not green until there
// is something to replay.
//
// A MOUNTED WORKSPACE IS THE OTHER CASE, and it is not the same one. The fixtures live under
// `tests/`, which travels into neither a forged core nor a package — deliberately: they are the
// SOURCE repo's contract snapshots, a consumer has nothing to compare them against, and
// `scripts/update-golden-contracts.mjs` must never be run there. So their absence in a mount is a
// design decision, not a missing deliverable, and grading it `skipped` made `check run release`
// permanently red in every consumer install for a gate that had correctly concluded it had nothing
// to do (INC-2026-09-04-02, N-3). That case reports `not_applicable`, which clears the profile
// without ever claiming the fixtures were replayed. Everything else about the gate is unchanged —
// where the fixtures DO exist, they are replayed, and a mismatch still fails.
//
// Zero npm dependencies — node:* only; macOS + Windows.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { coreDirOf, frameworkRootOf } from '../../sk-cli/core-mount.mjs';

/** Where Phase 5's curated fixtures and their harness live. */
export const GOLDEN_DIR = join('tests', 'fixtures', 'golden');
export const GOLDEN_SUITE = join('tests', 'golden-contracts.test.mjs');

/**
 * @param {{repoRoot: string, spawn: Function, timeoutMs: number, signal: AbortSignal}} ctx
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string, reason: string|null, status?: string}>}
 */
export async function goldenReplay({ repoRoot, spawn, timeoutMs, signal }) {
  // The fixtures belong to the FRAMEWORK, so they are looked for at the framework root — which in a
  // mount is the core, not the workspace. Resolving against the workspace searched a tree that never
  // held them and could not have.
  const root = frameworkRootOf(repoRoot);
  const mounted = coreDirOf(repoRoot) !== null;
  const dir = join(root, GOLDEN_DIR);
  const suite = join(root, GOLDEN_SUITE);

  const fixtures = existsSync(dir)
    ? readdirSync(dir).filter((f) => !f.startsWith('.'))
    : [];

  if (fixtures.length === 0 || !existsSync(suite)) {
    const missing = [];
    if (fixtures.length === 0) missing.push(`${GOLDEN_DIR}/ holds no fixtures`);
    if (!existsSync(suite)) missing.push(`${GOLDEN_SUITE} does not exist`);
    if (mounted) {
      return {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        status: 'not_applicable',
        reason: `no golden fixtures in a mounted framework core (${missing.join('; ')}) — and there `
          + 'never will be. They are the SOURCE repository\'s contract snapshots: a consumer has '
          + 'nothing to compare them against, and refreshing one is a human review step that must '
          + 'not happen here. This is not a skipped check, it is a check with no subject.',
      };
    }
    return {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      status: 'skipped',
      reason: `nothing to replay — ${missing.join('; ')}. This gate never creates fixtures; `
        + 'a blocking gate that is skipped fails the profile, so `release` stays red until the '
        + 'curated snapshots land.',
    };
  }

  // Replay: the suite reads the fixtures and diffs. No flag here can make it write one. cwd stays
  // the workspace; only the suite's own location comes from the framework root.
  const r = await spawn({
    argv: ['node', '--test', suite],
    cwd: repoRoot,
    timeoutMs,
    signal,
    env: { SIDEKICKS_GOLDEN_REPLAY_ONLY: '1', CI: process.env.CI ?? '' },
  });
  return {
    exitCode: r.exitCode,
    signal: r.signal ?? null,
    stdout: r.stdout,
    stderr: r.stderr,
    reason: r.exitCode === 0
      ? null
      : `golden fixtures do not match (${fixtures.length} fixture file(s) replayed) — review the diff `
        + 'and change either the product or, deliberately, the fixture; this gate never rewrites one',
  };
}
