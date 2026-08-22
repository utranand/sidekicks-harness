// lib/goal-lifecycle/resume.mjs
// `sidekicks goal resume <run-id> [--abandon-attempt <id>] [--json]` — reconcile, then continue.
//
// THE NEXT ACTION COMES FROM DISK, NEVER FROM CONTEXT. `run.json`, the artifacts beside it, and the
// lease are the whole input. That is what makes a run survive a closed terminal, a reboot, or a
// different machine picking it up — and it is why the engine's state machine has no "current step"
// living in a variable somewhere.
//
// AN UNSETTLED ATTEMPT IS NEVER RE-DISPATCHED. This is the rule that prevents the worst failure this
// engine can have: two implementation sessions editing the same files because the first one's fate
// was unknown. So an attempt with no terminal result is classified, not retried:
//
//   * a LIVE child on this host  → reported, and the run is left alone. Something is still working.
//   * a DEAD child on this host  → the attempt is unverifiable. Whatever it wrote is in the tree, but
//                                  nothing knows how far it got, so a human decides: inspect the
//                                  diff, then `--abandon-attempt <id>` to write it off explicitly.
//   * a FOREIGN or unknown owner → never judged from here. `needs_user`.
//
// "Unverifiable" is deliberately not "probably fine". A dead session may have half-applied a change,
// and the next attempt would build on top of it while believing the tree was clean.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { read as readSettings } from '../settings-store/settings.mjs';
import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { bangkokTimestamp } from '../run-events/store.mjs';
import { reconciliationIntent } from '../run-events/schema.mjs';
import {
  RELATIVE,
  flagString,
  goalPositionals,
  loadRun,
  parseGoalFlags,
} from './commands.mjs';
import {
  GOAL_ENGINE,
  appendGoalEvent,
  goalPaths,
  inspectRunLease,
  readJsonIfPresent,
  stopPresent,
  writeRunState,
} from './store.mjs';
import {
  finishAttempt,
  toNeedsUser,
  toPlanning,
  toRunning,
  unsettledAttempts,
} from './state-machine.mjs';
import { classifyPlanningJobs, markUnverifiable } from './jobs.mjs';
import { commitTransition } from './runner.mjs';

const BOOLEANS = ['json'];

/**
 * Is that pid alive on this host?
 *
 * `EPERM` means it exists and belongs to someone else — alive. Only `ESRCH` is death, and anything
 * else is treated as alive, because "I could not tell" must never authorize a re-dispatch.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    return true;
  }
}

/**
 * Classify every unsettled attempt in a run.
 *
 * @param {object} state
 * @param {{hostname: string, aliveCheck?: (pid: number) => boolean}} opts
 * @returns {{node: string, attempt_id: string, verdict: 'live'|'dead'|'unknown', reason: string}[]}
 */
export function classifyUnsettled(state, opts) {
  const alive = opts.aliveCheck || pidAlive;
  const leaseHost = state.lease?.hostname ?? null;
  return unsettledAttempts(state).map(({ node, attempt }) => {
    if (leaseHost && leaseHost !== opts.hostname) {
      return {
        node,
        attempt_id: attempt.id,
        verdict: 'unknown',
        reason: `the attempt was opened on host '${leaseHost}', and a pid on another host cannot be `
          + 'judged from here',
      };
    }
    if (attempt.pid === null) {
      return {
        node,
        attempt_id: attempt.id,
        verdict: 'dead',
        reason: 'the attempt was opened but no child pid was ever recorded — it never spawned, or it '
          + 'died between the record and the spawn',
      };
    }
    if (alive(attempt.pid)) {
      return {
        node,
        attempt_id: attempt.id,
        verdict: 'live',
        reason: `pid ${attempt.pid} is still running on this host`,
      };
    }
    return {
      node,
      attempt_id: attempt.id,
      verdict: 'dead',
      reason: `pid ${attempt.pid} is gone, and the attempt recorded no terminal result — how far it `
        + 'got is unknown',
    };
  });
}

/**
 * Run `goal resume`.
 *
 * @param {{repoRoot: string, argv: string[], flags: object, log: Function}} ctx
 * @param {object} _args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, _args) {
  const flags = parseGoalFlags(ctx.argv, BOOLEANS);
  const runId = goalPositionals(ctx.argv, BOOLEANS)[0];
  if (!runId) {
    throw new SidekicksError(
      'goal resume: usage: goal resume <run-id> [--abandon-attempt <node#n>] [--json]',
      EXIT_USAGE,
    );
  }
  const abandon = flagString(flags['abandon-attempt']);

  const { runDir, state: loaded } = loadRun(ctx.repoRoot, runId);
  let state = loaded;
  const lease = inspectRunLease(runDir);
  const { hostname } = await import('node:os');

  // ---- a live owner is left strictly alone ------------------------------------------------------
  if (lease.state === 'active') {
    return respond(ctx, runDir, state, flags, {
      headline: `a LIVE process holds this run (pid ${lease.owner.pid} on ${lease.owner.hostname})`,
      detail: 'nothing was changed. Let it finish, or set the STOP gate and wait for it to settle.',
      next: `sidekicks goal stop ${runId}`,
      exit: EXIT_VALIDATION,
    });
  }
  if (lease.state === 'foreign' || lease.state === 'malformed') {
    return respond(ctx, runDir, state, flags, {
      headline: `the run lease is ${lease.state} and is never reclaimed automatically`,
      detail: lease.reason,
      next: 'confirm the owner is really gone, then remove the run.lock file by hand',
      exit: EXIT_VALIDATION,
    });
  }

  // ---- unsettled attempts ------------------------------------------------------------------------
  const unsettled = classifyUnsettled(state, { hostname: hostname() });
  const live = unsettled.filter((u) => u.verdict === 'live');
  const unknown = unsettled.filter((u) => u.verdict === 'unknown');
  let dead = unsettled.filter((u) => u.verdict === 'dead');

  if (live.length > 0) {
    return respond(ctx, runDir, state, flags, {
      headline: `${live.length} attempt(s) are still running — nothing was re-dispatched`,
      detail: live.map((u) => `${u.attempt_id}: ${u.reason}`).join('; '),
      next: `sidekicks goal status ${runId}`,
      exit: EXIT_VALIDATION,
    });
  }

  if (abandon) {
    const target = dead.find((u) => u.attempt_id === abandon);
    if (!target) {
      throw new SidekicksError(
        `goal resume: '${abandon}' is not an unsettled attempt on this run. Unsettled: `
        + `${dead.map((u) => u.attempt_id).join(', ') || 'none'}`,
        EXIT_VALIDATION,
      );
    }
    // Abandoning is an EXPLICIT write-off, recorded as an errored attempt against the node's budget.
    // It is not a free retry: whatever that session wrote is still in the tree, and the next attempt
    // has to cope with it.
    state = commitTransition(runDir, finishAttempt(state, {
      node: target.node,
      attempt_id: target.attempt_id,
      at: bangkokTimestamp(Date.now()),
      exit_code: null,
      result: 'errored',
      error: `abandoned by the operator on resume: ${target.reason}`,
      wall_clock_ms: 0,
    }));
    ctx.log(`goal resume: abandoned ${target.attempt_id}`);
    dead = dead.filter((u) => u.attempt_id !== abandon);
  }

  if (unknown.length > 0 || dead.length > 0) {
    const findings = [...unknown, ...dead].map((u) => `${u.attempt_id}: ${u.reason}`);
    return respond(ctx, runDir, state, flags, {
      headline: `${findings.length} attempt(s) ended without a proven result and will NOT be re-dispatched`,
      detail: findings.join('\n    '),
      next: dead.length > 0
        ? `inspect the tree, then: sidekicks goal resume ${runId} --abandon-attempt ${dead[0].attempt_id}`
        : `sidekicks goal status ${runId}`,
      exit: EXIT_VALIDATION,
    });
  }

  // ---- reconcile the sidecar --------------------------------------------------------------------
  if (state.divergence) {
    const intent = reconciliationIntent({
      engine: GOAL_ENGINE,
      run_id: state.run_id,
      work_item: state.run_id,
      actor: { kind: 'cli', id: 'sidekicks-goal' },
      legacy_state: { phase: state.phase, sequence: state.sequence, nodes: state.nodes },
      current_state: state.phase,
      missing_event: state.divergence.event,
    });
    const appended = appendGoalEvent(runDir, {
      run_id: state.run_id,
      event: 'run.reconciled',
      status: 'running',
      node: null,
      detail: intent.detail,
    });
    if (!appended.ok) {
      return respond(ctx, runDir, state, flags, {
        headline: 'the event sidecar still cannot be written, so the run stays halted',
        detail: appended.error,
        next: `sidekicks artifacts events check ${RELATIVE(ctx.repoRoot, runDir)}`,
        exit: EXIT_VALIDATION,
      });
    }
    state.divergence = null;
    state = writeRunState(runDir, state);
    ctx.log('goal resume: sidecar reconciled — no historical events were fabricated');
  }

  // ---- decide the next action from state alone ---------------------------------------------------
  if (stopPresent(runDir)) {
    return respond(ctx, runDir, state, flags, {
      headline: 'the STOP gate is still present, so nothing will be dispatched',
      detail: `delete ${RELATIVE(ctx.repoRoot, goalPaths(runDir).stop)} first`,
      next: `sidekicks goal resume ${runId}`,
      exit: EXIT_VALIDATION,
    });
  }

  const settings = readSettings(ctx.repoRoot);
  void settings; // read here so a corrupt settings file fails before a transition, not after

  // ---- planning jobs, which fan out and therefore need the same treatment -------------------------
  //
  // A contest dispatches several children at once, so an interrupted planning phase can leave one
  // family still running while another never started. The ledger says which, and the classification is
  // the same conservative ladder as for attempts:
  //
  //   * LIVE on this host  → reported, nothing touched. Something is still planning.
  //   * FOREIGN or malformed ownership → `needs_user`. A pid on another host means nothing here, and
  //                          "dispatched with no pid" cannot be told apart from "died before the
  //                          spawn" — neither is a fact a resume may act on.
  //   * DEAD on this host  → marked failed and retryable ONCE, inside the planning budget.
  //   * NEVER DISPATCHED   → dispatched now; the ledger proves no child exists for it.
  //
  // Everything already settled is FOLDED from its artifact by deterministic job id, so the run
  // continues in place rather than starting a second run and re-paying for the candidates it has.
  if (state.phase === 'planning') {
    const jobs = classifyPlanningJobs(state, { hostname: hostname(), aliveCheck: pidAlive });
    const liveJobs = jobs.filter((j) => j.verdict === 'live');
    const unknown = jobs.filter((j) => j.verdict === 'unknown');
    const deadJobs = jobs.filter((j) => j.verdict === 'dead');
    if (liveJobs.length > 0) {
      return respond(ctx, runDir, state, flags, {
        headline: `${liveJobs.length} planning session(s) are still running — nothing was re-dispatched`,
        detail: liveJobs.map((j) => `${j.id}: ${j.reason}`).join('\n    '),
        next: `sidekicks goal status ${runId}`,
        exit: EXIT_VALIDATION,
      });
    }
    if (unknown.length > 0) {
      state = commitTransition(runDir, toNeedsUser(state, {
        reason: `${unknown.length} planning session(s) have ownership this host cannot judge`,
        findings: unknown.map((j) => `${j.id}: ${j.reason}`),
        next: 'resume on the host that dispatched them, or confirm those children are gone and clear '
          + 'the job by hand; the candidates that DID complete are on disk under plan-candidates/',
      }));
      return respond(ctx, runDir, state, flags, {
        headline: `${unknown.length} planning session(s) cannot be judged from this host and will NOT `
          + 'be re-dispatched',
        detail: unknown.map((j) => `${j.id}: ${j.reason}`).join('\n    '),
        next: `sidekicks goal status ${runId}`,
        exit: EXIT_VALIDATION,
      });
    }

    if (!state.planning?.jobs || Object.keys(state.planning.jobs).length === 0) {
      // A single-planner run keeps no ledger, so there is nothing to fold and no dispatch that can be
      // proven safe. Saying so beats re-planning silently under a digest the operator never saw.
      return respond(ctx, runDir, state, flags, {
        headline: 'this run was interrupted during planning, and it kept no job ledger',
        detail: 'a single-planner run records no per-seat state, so nothing here can be folded or '
          + 'proven safe to dispatch',
        next: 'sidekicks goal plan "<goal>"   (a fresh planning phase; nothing is auto-resumed)',
        exit: EXIT_VALIDATION,
      });
    }

    // A dead child is written off before anything is dispatched, so the retry it may be granted is
    // recorded on disk even if this process dies in the next second.
    if (deadJobs.length > 0) {
      const at = bangkokTimestamp(Date.now());
      for (const job of deadJobs) markUnverifiable(state, job.id, { reason: job.reason, at });
      state = writeRunState(runDir, state);
      ctx.log(
        `goal resume: ${deadJobs.length} planning session(s) died and were written off: `
        + deadJobs.map((j) => j.id).join(', '),
      );
    }

    const { continuePlanning } = await import('./plan.mjs');
    return continuePlanning(ctx, runDir, state, flags);
  }

  switch (state.phase) {
    case 'stopped':
      state = commitTransition(runDir, toRunning(state, { reason: 'the STOP gate was removed' }));
      return handoff(ctx, runDir, state, flags, runId);

    case 'needs_user': {
      // Whether remediation belongs in planning or in execution is decided by whether an approved
      // envelope still describes the tree — not by asking the operator to classify their own fix.
      const envelope = readJsonIfPresent(goalPaths(runDir).envelope);
      if (!state.approved_envelope_digest || !envelope) {
        state = commitTransition(runDir, toPlanning(state, {
          reason: 'resumed with no approved envelope — the blocker invalidated the plan',
        }));
        return respond(ctx, runDir, state, flags, {
          headline: 'returned to planning — there is no approved envelope to execute',
          detail: 'the plan has to be re-made and re-approved',
          next: 'sidekicks goal plan "<goal>"',
          exit: EXIT_OK,
        });
      }
      state = commitTransition(runDir, toRunning(state, { reason: 'resumed after operator remediation' }));
      return handoff(ctx, runDir, state, flags, runId);
    }

    case 'running':
      return handoff(ctx, runDir, state, flags, runId);

    case 'final_verification':
      // A run interrupted DURING final verification has no verdict, and a verdict is the only thing
      // that may complete it. Re-running the check is safe and cheap relative to the alternative,
      // which is trusting an interrupted judgement.
      return respond(ctx, runDir, state, flags, {
        headline: 'this run was interrupted during final verification',
        detail: 'no verdict was recorded, and completion requires a fresh approving one',
        next: `sidekicks goal run ${runId}  (re-runs the final check)`,
        exit: EXIT_VALIDATION,
      });

    case 'awaiting_approval':
      return respond(ctx, runDir, state, flags, {
        headline: 'this run is waiting for approval, not for a resume',
        detail: `approve the envelope digest shown by 'goal status ${runId}'`,
        next: `sidekicks goal approve ${runId} --digest <sha256>`,
        exit: EXIT_VALIDATION,
      });

    case 'awaiting_action_approval':
      return respond(ctx, runDir, state, flags, {
        headline: 'this run is holding an outward action that needs its own grant',
        detail: `${state.action_request?.action_class ?? 'an action'} → ${state.action_request?.target ?? '?'}`,
        next: `sidekicks goal approve-action ${runId} ${state.action_request?.request_id ?? '<request-id>'} `
          + `--digest ${state.action_request?.digest ?? '<sha256>'}`,
        exit: EXIT_VALIDATION,
      });

    case 'done':
    case 'failed':
      return respond(ctx, runDir, state, flags, {
        headline: `this run is ${state.phase} — there is nothing to resume`,
        detail: '',
        next: `sidekicks goal report ${runId}`,
        exit: EXIT_VALIDATION,
      });

    default:
      return respond(ctx, runDir, state, flags, {
        headline: `phase '${state.phase}' has no automatic resume`,
        detail: 'planning and final verification are driven by their own verbs',
        next: `sidekicks goal status ${runId}`,
        exit: EXIT_VALIDATION,
      });
  }
}

/** Reconciled and runnable — say so, and name the verb that continues. */
function handoff(ctx, runDir, state, flags, runId) {
  return respond(ctx, runDir, state, flags, {
    headline: 'reconciled and runnable',
    detail: 'nothing was re-dispatched; the next action was derived from run.json and the filesystem',
    next: `sidekicks goal run ${runId}`,
    exit: EXIT_OK,
  });
}

/** Terminal response, human or JSON. */
function respond(ctx, runDir, state, flags, meta) {
  const payload = {
    run_id: state.run_id,
    run_dir: RELATIVE(ctx.repoRoot, runDir),
    phase: state.phase,
    headline: meta.headline,
    detail: meta.detail,
    next: meta.next,
    divergence: state.divergence ?? null,
    needs_user: state.needs_user ?? null,
  };
  if (flags.json === true) {
    return { stdout: `${JSON.stringify(payload, null, 2)}\n`, exitCode: meta.exit };
  }
  const lines = [`goal run ${state.run_id} — ${state.phase}`, '', `  ${meta.headline}`];
  if (meta.detail) lines.push(`    ${meta.detail}`);
  lines.push('');
  lines.push(`  next: ${meta.next}`);
  return { stdout: `${lines.join('\n')}\n`, exitCode: meta.exit };
}
