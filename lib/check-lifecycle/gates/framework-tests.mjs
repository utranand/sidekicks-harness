// lib/check-lifecycle/gates/framework-tests.mjs
// The gates that run the framework's OWN test files: `tests.contract`, `tests.all` and `parity`.
//
// Why these three cannot be plain `command:` rows.
//
// A command gate is spawned with `cwd = repoRoot`, and repoRoot is the WORKSPACE — `resolveRepoRoot`
// deliberately walks past a mounted core. That works for every gate whose argv goes through
// `bin/sidekicks`, because a mounted workspace has a shim there. It does not work for an argv naming
// a framework FILE: in a mounted workspace `scripts/` and the contract suites are at
// `.sidekicks-core/…`, not at the workspace root. So `check run quick` failed in every mounted
// workspace on `tests.contract`, and `full` failed on `tests.all` and `parity` too
// (INC-2026-09-04-01, F-3).
//
// The fix is one line of intent: resolve the files against the FRAMEWORK root, not the workspace
// root, and build an absolute argv. `frameworkRootOf` is that root.
//
// A MISSING FILE FAILS, it does not skip. The suites live under `lib/**/tests/`, and `lib/` is
// copied whole into a forged core, so their absence means the forge dropped part of the framework —
// which is exactly what a release gate exists to catch. (Before they were colocated they lived under
// `tests/`, which is not part of the forged surface at all: the gate could not have run in a mount
// however its paths were resolved.) Reporting `skipped` would be worse than useless here: a blocking
// gate that skips fails the profile anyway, so a skip is a failure that has lost its explanation.
//
// Zero npm dependencies — node:* only; macOS + Windows.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { frameworkRootOf } from '../../sk-cli/core-mount.mjs';

/** The two suites that pin the catalog and check contracts. Colocated so they travel with lib/. */
export const CONTRACT_SUITES = Object.freeze([
  join('lib', 'catalog-lifecycle', 'tests', 'catalog.test.mjs'),
  join('lib', 'check-lifecycle', 'tests', 'runner.test.mjs'),
]);

/** The Rule 6 parity suites. Under tests/, so they exist in the source repo only. */
export const PARITY_SUITES = Object.freeze([
  join('tests', 'multi-cli-parity.test.mjs'),
  join('tests', 'agent-context-mirror.test.mjs'),
]);

/** The whole-suite launcher, which self-anchors on its own module location once found. */
export const TEST_LAUNCHER = join('scripts', 'run-tests.mjs');

/**
 * Run `node --test` over files resolved against the framework root.
 *
 * @param {{repoRoot: string, spawn: Function, timeoutMs: number, signal: AbortSignal}} ctx
 * @param {readonly string[]} rels - framework-root-relative paths
 * @param {string} what - what the gate is called, for the failure reason
 */
async function runSuites({ repoRoot, spawn, timeoutMs, signal }, rels, what) {
  const root = frameworkRootOf(repoRoot);
  const abs = rels.map((rel) => join(root, rel));
  const missing = rels.filter((rel, i) => !existsSync(abs[i]));

  if (missing.length > 0) {
    return {
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: '',
      reason: `${what}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing from `
        + `the framework at ${root}. These files travel inside lib/, so their absence means the `
        + 'framework itself is incomplete — not that this environment has nothing to check.',
    };
  }

  // cwd stays the WORKSPACE: the suites reason about the repo they are run in, and only their own
  // location had to come from the framework root.
  return spawn({ argv: ['node', '--test', ...abs], cwd: repoRoot, timeoutMs, signal });
}

/** `tests.contract` — the catalog and check contracts, runnable in a mount. */
export async function testsContract(ctx) {
  return runSuites(ctx, CONTRACT_SUITES, 'tests.contract');
}

/** `parity` — Rule 6 shared-surface parity. */
export async function parity(ctx) {
  return runSuites(ctx, PARITY_SUITES, 'parity');
}

/**
 * `tests.all` — the whole suite, through the framework's own launcher.
 *
 * The launcher self-anchors on its module location, so once it is FOUND it discovers the right
 * tree. Finding it is the part that needed the framework root.
 */
export async function testsAll({ repoRoot, spawn, timeoutMs, signal }) {
  const root = frameworkRootOf(repoRoot);
  const launcher = join(root, TEST_LAUNCHER);
  if (!existsSync(launcher)) {
    return {
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: '',
      reason: `tests.all: ${TEST_LAUNCHER} is missing from the framework at ${root} — the forged `
        + 'core ships it, so its absence is an incomplete framework.',
    };
  }
  return spawn({ argv: ['node', launcher], cwd: repoRoot, timeoutMs, signal });
}
