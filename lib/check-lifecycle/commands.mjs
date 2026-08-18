// lib/check-lifecycle/commands.mjs
// CLI parsing and rendering for `sidekicks check run`.
//
// Split from ./run.mjs for the reason every lifecycle family here splits them: the verb file is a
// dispatch shim, and the suite asserts the same function the verb calls rather than a
// re-implementation of it.
//
// Zero npm dependencies — node:* only.

import { runProfile } from './runner.mjs';
import { PROFILE_NAMES, PROFILE_TIMEOUT_MS, JOBS_MIN, JOBS_MAX, normalizeJobs, defaultJobCount } from './registry.mjs';
import { parseCheckFlags, positionalArgs } from './_shared.mjs';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';

/** Flags that never take a value. Everything else in this family is valued. */
export const CHECK_BOOLEANS = Object.freeze(['json', 'help', 'version', 'verbose']);

/**
 * Read `check run`'s options out of a raw argv slice.
 *
 * BOTH SPELLINGS OF EVERY VALUED FLAG WORK. The dispatcher's global parseArgs is `strict: false` with
 * only the three global booleans declared, so `--profile quick` reaches a verb as
 * `{ profile: true }` plus a positional `quick` while `--profile=quick` reaches it as
 * `{ profile: 'quick' }`. Re-reading the raw argv here is what makes the space form work; the bare
 * positional form (`check run quick`) keeps working through the same pass.
 *
 * @param {string[]} argv
 * @returns {{profile: string, jobs: number, json: boolean}}
 * @throws {SidekicksError} EXIT_VALIDATION on an unknown profile, a bad --jobs, or an extra positional
 */
export function parseCheckRunArgs(argv) {
  const flags = parseCheckFlags(argv, CHECK_BOOLEANS);
  // positionals: ['check', 'run', <maybe profile>]
  const rest = positionalArgs(argv, CHECK_BOOLEANS).slice(2);

  let profile = typeof flags.profile === 'string' && flags.profile !== '' ? flags.profile : null;
  if (flags.profile === true || flags.profile === '') {
    throw new SidekicksError(
      `check run: --profile needs a value (use --profile=<name> or --profile <name>) — one of ${PROFILE_NAMES.join(', ')}`,
      EXIT_VALIDATION,
    );
  }
  if (!profile) profile = rest.shift() || 'quick';
  if (rest.length > 0) {
    throw new SidekicksError(
      `check run: unexpected argument '${rest[0]}' — usage: sidekicks check run [<profile>] [--profile <name>] [--jobs <${JOBS_MIN}-${JOBS_MAX}>] [--json]`,
      EXIT_VALIDATION,
    );
  }
  if (!PROFILE_NAMES.includes(profile)) {
    throw new SidekicksError(
      `check run: unknown profile '${profile}' — expected one of ${PROFILE_NAMES.join(', ')}`,
      EXIT_VALIDATION,
    );
  }

  const jobs = normalizeJobs(
    Object.hasOwn(flags, 'jobs') ? flags.jobs : null,
    defaultJobCount(),
  );

  return { profile, jobs, json: Boolean(flags.json) };
}

/**
 * Run a profile and render the outcome.
 *
 * @param {string} repoRoot
 * @param {{profile: string, jobs?: number, json?: boolean, deps?: object}} opts
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function checkRun(repoRoot, { profile, jobs = null, json = false, deps = {} } = {}) {
  const { result, exitCode } = await runProfile({ repoRoot, profile, jobs, deps });
  return {
    stdout: json ? `${JSON.stringify(result, null, 2)}\n` : renderHuman(result, jobs, deps),
    exitCode,
  };
}

const MARK = Object.freeze({ passed: 'PASS', failed: 'FAIL', blocked: 'BLOCK', skipped: 'SKIP' });

/**
 * The human rendering: the same facts as the JSON, grouped for reading.
 *
 * @param {object} result
 * @param {number|null} jobs
 * @param {object} deps
 * @returns {string}
 */
export function renderHuman(result, jobs = null, deps = {}) {
  const lines = [];
  const timeout = deps.timeoutMs ?? PROFILE_TIMEOUT_MS[result.profile];
  lines.push(`check run — profile ${result.profile}`
    + `${jobs ? `, jobs ${jobs}` : ''}`
    + `${timeout ? `, per-gate timeout ${Math.round(timeout / 1000)}s` : ''}`);
  lines.push(`  started ${result.started_at}`);
  lines.push('');

  const width = Math.max(...result.gates.map((g) => g.id.length), 12);
  for (const gate of result.gates) {
    const mark = MARK[gate.status] || gate.status.toUpperCase();
    const secs = gate.duration_ms === null ? '' : `${(gate.duration_ms / 1000).toFixed(1)}s`;
    const pad = ' '.repeat(Math.max(1, width - gate.id.length + 1));
    lines.push(`  ${mark.padEnd(5)} ${gate.id}${pad}${secs.padStart(7)}`
      + `${gate.blocking ? '' : '  (non-blocking)'}`);
    if (gate.reason) lines.push(`        ${gate.reason}`);
    if (gate.status !== 'passed') {
      for (const [label, text] of [['stderr', gate.stderr_tail], ['stdout', gate.stdout_tail]]) {
        const body = String(text || '').split('\n').filter((l) => l.trim() !== '');
        if (body.length === 0) continue;
        lines.push(`        --- ${label} (last ${Math.min(20, body.length)} line(s)) ---`);
        for (const l of body.slice(-20)) lines.push(`        ${l}`);
      }
    }
  }

  const counts = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const gate of result.gates) counts[gate.status] = (counts[gate.status] || 0) + 1;
  lines.push('');
  lines.push(`${result.status === 'passed' ? 'PASSED' : 'FAILED'}`
    + ` — ${counts.passed} passed, ${counts.failed} failed, ${counts.blocked} blocked, ${counts.skipped} skipped`
    + ` in ${(result.duration_ms / 1000).toFixed(1)}s`);
  if (counts.skipped > 0) {
    lines.push('  a SKIPPED blocking gate fails the profile — it is never reported as success');
  }
  return `${lines.join('\n')}\n`;
}
