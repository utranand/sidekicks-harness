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
// ABSENT FIXTURES ARE NOT A PASS. Until the curated fixtures exist, the gate reports `skipped` with
// that as its reason — and because the gate is BLOCKING, a skip fails the profile. That is the
// intended behaviour, not a gap: `release` is not green until there is something to replay.
//
// Zero npm dependencies — node:* only; macOS + Windows.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Where Phase 5's curated fixtures and their harness live. */
export const GOLDEN_DIR = join('tests', 'fixtures', 'golden');
export const GOLDEN_SUITE = join('tests', 'golden-contracts.test.mjs');

/**
 * @param {{repoRoot: string, spawn: Function, timeoutMs: number, signal: AbortSignal}} ctx
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string, reason: string|null, status?: string}>}
 */
export async function goldenReplay({ repoRoot, spawn, timeoutMs, signal }) {
  const dir = join(repoRoot, GOLDEN_DIR);
  const suite = join(repoRoot, GOLDEN_SUITE);

  const fixtures = existsSync(dir)
    ? readdirSync(dir).filter((f) => !f.startsWith('.'))
    : [];

  if (fixtures.length === 0 || !existsSync(suite)) {
    const missing = [];
    if (fixtures.length === 0) missing.push(`${GOLDEN_DIR}/ holds no fixtures`);
    if (!existsSync(suite)) missing.push(`${GOLDEN_SUITE} does not exist`);
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

  // Replay: the suite reads the fixtures and diffs. No flag here can make it write one.
  const r = await spawn({
    argv: ['node', '--test', GOLDEN_SUITE],
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
