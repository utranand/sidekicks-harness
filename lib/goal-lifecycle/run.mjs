// lib/goal-lifecycle/run.mjs
// `sidekicks goal run <run-id> [--max-nodes N] [--json]` — dispatch the approved plan.
//
// THE LEASE IS TAKEN HERE, ONCE, FOR THE WHOLE LOOP. Exactly one process may write this run's state,
// and the loop holds that right from its first transition to its last. A second `goal run` on the same
// run does not queue behind it — it fails fast, because two engines dispatching the same node would
// each open an attempt and both would spawn.
//
// COMPLETION IS NOT THIS VERB'S DECISION. When every node passes, an independent adversarial
// verifier runs — inside this same lease, so nothing can slip in between — and only its approval plus
// a passing exit check may say `done`. A runner that declared success because its own loop ran out of
// work would be grading itself.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { read as readSettings } from '../settings-store/settings.mjs';
import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { effectiveExecutors, readEffectiveRegistry, routingPolicy } from '../cli-executor-lifecycle/_shared.mjs';
import {
  RELATIVE,
  assertPhase,
  flagString,
  goalPositionals,
  loadRun,
  parseGoalFlags,
} from './commands.mjs';
import {
  acquireRunLease,
  assertNoDivergence,
  clearLease,
  goalPaths,
  readJsonIfPresent,
  readRunState,
  releaseRunLease,
  stampLease,
  writeRunState,
} from './store.mjs';
import { toFinalVerification } from './state-machine.mjs';
import { commitTransition, runNodes } from './runner.mjs';
import { runFinalVerification } from './final-verify.mjs';

const BOOLEANS = ['json'];

/**
 * Run `goal run`.
 *
 * @param {{repoRoot: string, argv: string[], flags: object, log: Function}} ctx
 * @param {object} _args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, _args) {
  const flags = parseGoalFlags(ctx.argv, BOOLEANS);
  const runId = goalPositionals(ctx.argv, BOOLEANS)[0];
  if (!runId) {
    throw new SidekicksError('goal run: usage: goal run <run-id> [--max-nodes N] [--json]', EXIT_USAGE);
  }

  const maxNodesRaw = flagString(flags['max-nodes']);
  const maxNodes = maxNodesRaw === '' ? 0 : Number(maxNodesRaw);
  if (maxNodesRaw !== '' && (!Number.isInteger(maxNodes) || maxNodes < 1)) {
    throw new SidekicksError(
      `goal run: --max-nodes must be a positive integer, got '${maxNodesRaw}'`,
      EXIT_VALIDATION,
    );
  }

  const { runDir, state: loaded } = loadRun(ctx.repoRoot, runId);
  // `final_verification` is accepted as well as `running`: a run interrupted during the final check
  // has no verdict, and re-running the check is the only way to get one. Re-verifying is cheap next to
  // the alternative, which is trusting an interrupted judgement.
  assertPhase(loaded, ['running', 'final_verification'], 'run');
  assertNoDivergence(loaded);

  const plan = readJsonIfPresent(goalPaths(runDir).plan);
  if (!plan) {
    throw new SidekicksError(
      'goal run: plan.json is missing from the run folder — nothing can be dispatched',
      EXIT_VALIDATION,
    );
  }
  const envelope = readJsonIfPresent(goalPaths(runDir).envelope);
  if (!envelope) {
    throw new SidekicksError(
      'goal run: the approval envelope is missing from the run folder',
      EXIT_VALIDATION,
    );
  }

  const settings = readSettings(ctx.repoRoot);
  const registry = readEffectiveRegistry(ctx.repoRoot, settings);
  const executors = effectiveExecutors(registry);
  const prefer = routingPolicy(registry);

  // One writer. A second `goal run` fails fast rather than joining in.
  const lease = acquireRunLease(runDir);
  let state = loaded;
  try {
    stampLease(state, { nonce: lease.nonce });
    state = writeRunState(runDir, state);

    const resuming = state.phase === 'final_verification';
    const result = resuming
      ? { outcome: 'all-complete', state, detail: 're-running the interrupted final verification' }
      : await runNodes({
        repoRoot: ctx.repoRoot,
        runDir,
        state,
        plan,
        envelope,
        executors,
        prefer,
        maxNodes,
        log: ctx.log,
        lease,
      });
    state = result.state;

    if (result.outcome === 'all-complete') {
      // Every node passed. That is NOT completion — an independent adversarial verifier decides
      // that, and it runs inside this same lease so nothing can slip in between.
      // Already in the phase when resuming an interrupted check — the transition would be illegal.
      if (!resuming) state = commitTransition(runDir, toFinalVerification(state));
      const verified = await runFinalVerification({
        repoRoot: ctx.repoRoot,
        runDir,
        state,
        plan,
        envelope,
        executors,
        prefer,
        log: ctx.log,
      });
      state = verified.state;

      // A rejected-in-scope verdict reopened the responsible node(s), so the loop has more to do.
      // Continuing inside the same invocation is deliberate: the operator asked for the run to be
      // driven, and a reopen is part of driving it, not a new request.
      if (verified.outcome === 'reopened') {
        const again = await runNodes({
          repoRoot: ctx.repoRoot,
          runDir,
          state,
          plan,
          envelope,
          executors,
          prefer,
          maxNodes,
          log: ctx.log,
          lease,
        });
        state = again.state;
        return report(ctx, runDir, state, flags, {
          headline: `final verification reopened work (${verified.detail}); the loop continued`,
          next: `sidekicks goal run ${runId}`,
          outcome: again.outcome === 'all-complete' ? 'reopened-and-complete' : again.outcome,
          detail: again.detail,
        });
      }

      return report(ctx, runDir, state, flags, {
        headline: describeFinal(verified),
        next: verified.outcome === 'done'
          ? `sidekicks goal report ${runId}`
          : (verified.outcome === 'replan' ? 'sidekicks goal plan "<goal>"' : `sidekicks goal status ${runId}`),
        outcome: verified.outcome,
        detail: verified.detail,
      });
    }

    return report(ctx, runDir, state, flags, {
      headline: describe(result.outcome, result.detail),
      next: nextStep(result.outcome, runId),
      outcome: result.outcome,
      detail: result.detail,
    });
  } finally {
    // Re-READ before clearing the lease. When an exception escaped the loop, `state` in this scope is
    // whatever it was before the failing call — the loop's own last transition (divergence, a
    // needs_user record) was already persisted, and writing this stale copy over it would erase
    // exactly the evidence the operator needs. run.json is the authority, so the authority is what
    // gets amended.
    try {
      const onDisk = readRunState(runDir);
      clearLease(onDisk);
      writeRunState(runDir, onDisk);
    } catch { /* releasing the lock matters more than the bookkeeping */ }
    releaseRunLease(runDir, lease.nonce);
  }
}

/** A human headline for a final-verification outcome. */
function describeFinal(verified) {
  switch (verified.outcome) {
    case 'done':
      return 'final verification APPROVED it and the exit check passed — done';
    case 'replan':
      return `final verification found a SCOPE CHANGE, so approval is invalidated: ${verified.detail}`;
    case 'blocked':
      return `final verification could not complete the run: ${verified.detail}`;
    default:
      return verified.detail;
  }
}

/** A human headline per loop outcome. */
function describe(outcome, detail) {
  switch (outcome) {
    case 'stopped': return 'stopped at the STOP gate — the running attempt was allowed to finish';
    case 'budget': return `paused on a budget: ${detail}`;
    case 'limit': return `paused at the --max-nodes limit: ${detail}`;
    case 'blocked': return `paused and needs you: ${detail}`;
    default: return detail;
  }
}

/** What the operator does next, per outcome. */
function nextStep(outcome, runId) {
  switch (outcome) {
    case 'stopped': return `delete the STOP file, then: sidekicks goal resume ${runId}`;
    case 'budget': return `sidekicks goal approve ${runId} --max-attempts <N>`;
    case 'limit': return `sidekicks goal run ${runId}`;
    default: return `sidekicks goal status ${runId}`;
  }
}

/** Terminal report, human or JSON. */
function report(ctx, runDir, state, flags, meta) {
  const payload = {
    run_id: state.run_id,
    run_dir: RELATIVE(ctx.repoRoot, runDir),
    phase: state.phase,
    outcome: meta.outcome,
    detail: meta.detail,
    nodes: Object.fromEntries(
      Object.entries(state.nodes || {}).map(([id, rec]) => [id, {
        state: rec.state,
        attempts: rec.attempt_count,
        last_error: rec.last_error,
      }]),
    ),
    spent: state.spent,
    breaker: state.breaker,
    needs_user: state.needs_user ?? null,
    next: meta.next,
  };
  if (flags.json === true) {
    return {
      stdout: `${JSON.stringify(payload, null, 2)}\n`,
      exitCode: SUCCESS_OUTCOMES.includes(meta.outcome) ? EXIT_OK : EXIT_VALIDATION,
    };
  }

  const lines = [`goal run ${state.run_id} — ${state.phase}`, '', `  ${meta.headline}`, ''];
  for (const [id, rec] of Object.entries(state.nodes || {})) {
    const err = rec.last_error ? ` — ${rec.last_error}` : '';
    lines.push(`    ${id.padEnd(12)} ${String(rec.state).padEnd(10)} ${rec.attempt_count} attempt(s)${err}`);
  }
  if (state.needs_user) {
    lines.push('');
    for (const f of state.needs_user.findings || []) lines.push(`  - ${f}`);
  }
  lines.push('');
  lines.push(`  next: ${meta.next}`);
  return {
    stdout: `${lines.join('\n')}\n`,
    exitCode: SUCCESS_OUTCOMES.includes(meta.outcome) ? EXIT_OK : EXIT_VALIDATION,
  };
}

/**
 * Outcomes that exit 0.
 *
 * `done` is the only true success. `reopened-and-complete` means final verification refuted
 * something, the loop fixed it, and every node is complete again — the run still needs another
 * `goal run` to re-verify, so it exits 0 as progress but is not `done`.
 */
const SUCCESS_OUTCOMES = Object.freeze(['done', 'reopened-and-complete']);
