// lib/goal-lifecycle/stop.mjs
// `sidekicks goal stop <run-id> [--reason <text>]` — the durable, graceful stop gate.
//
// A FILE, NOT A STATE FIELD. The whole purpose of `stop` is to halt a run someone ELSE is driving, so
// it must work from a session that does not hold the run lease. Writing to `run.json` from here would
// break the single-writer invariant it exists to protect; writing a `STOP` file does not, and it
// survives a crash, a reboot, and a lost terminal.
//
// GRACEFUL, AND THAT IS A DELIBERATE DEFAULT. A running attempt is allowed to finish. The engine
// re-reads this gate before every dispatch and every transition, so no NEW attempt starts — but
// killing a child mid-edit leaves half-written files, which is worse than one more completed attempt.
// A `--now` that propagates SIGTERM is out of scope for release one, and this file says so rather
// than leaving the reader to infer it.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, EXIT_USAGE, SidekicksError } from '../sk-cli/errors.mjs';
import { RELATIVE, flagString, goalPositionals, loadRun, parseGoalFlags } from './commands.mjs';
import { inspectRunLease, stopPresent, writeStop } from './store.mjs';

const BOOLEANS = ['json', 'now'];

/**
 * Run `goal stop`.
 *
 * @param {{repoRoot: string, argv: string[], flags: object, log: Function}} ctx
 * @param {object} _args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, _args) {
  const flags = parseGoalFlags(ctx.argv, BOOLEANS);
  const runId = goalPositionals(ctx.argv, BOOLEANS)[0];
  if (!runId) {
    throw new SidekicksError('goal stop: usage: goal stop <run-id> [--reason <text>]', EXIT_USAGE);
  }

  if (flags.now === true) {
    throw new SidekicksError(
      'goal stop: --now (kill the running attempt) is not implemented in release one. A half-written '
      + 'edit is worse than one more finished attempt, so stopping is graceful: the current attempt '
      + 'completes and no new one is dispatched. Kill the process yourself if you must, then '
      + "'goal resume' will reconcile the unfinished attempt.",
      EXIT_USAGE,
    );
  }

  const { runDir, state } = loadRun(ctx.repoRoot, runId);
  const already = stopPresent(runDir);
  const path = writeStop(runDir, { reason: flagString(flags.reason) || undefined });
  const lease = inspectRunLease(runDir);

  const payload = {
    run_id: runId,
    run_dir: RELATIVE(ctx.repoRoot, runDir),
    stop_file: RELATIVE(ctx.repoRoot, path),
    already_present: already,
    phase: state.phase,
    lease_state: lease.state,
  };

  if (flags.json === true) {
    return { stdout: `${JSON.stringify(payload, null, 2)}\n`, exitCode: EXIT_OK };
  }

  const lines = [
    `goal run ${runId} — STOP gate ${already ? 'already set (refreshed)' : 'set'}`,
    '',
    `  ${payload.stop_file}`,
    '',
  ];
  if (lease.state === 'active') {
    lines.push('  A live process holds this run. Its current attempt will finish; no new attempt will');
    lines.push('  be dispatched, and the run will settle in phase `stopped`.');
  } else {
    lines.push(`  No live owner (lease: ${lease.state}). The run is already idle and will not start.`);
  }
  lines.push('');
  lines.push(`  To continue later: delete the STOP file, then 'sidekicks goal resume ${runId}'.`);
  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
}
