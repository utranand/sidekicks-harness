// lib/goal-lifecycle/state-machine.mjs
// The only code allowed to change a goal run's phase or a node's state.
//
// WHY THERE IS NO GENERIC SETTER. Every phase change is also a permission change: `running` means an
// implementation subprocess may be dispatched, `awaiting_approval` means it may not, and
// `awaiting_action_approval` means a specific outward action is pending an exact grant. A `set(field,
// value)` helper would let any caller grant itself the right to dispatch. So the surface is a fixed
// table of named transitions, each of which knows its legal predecessors, bumps the monotonic
// sequence, and returns the sidecar event that records it. A transition not in the table cannot
// happen.
//
// THE TABLE IS THE ONE IN plan.md, not a superset. Notably: there is an exit from `needs_user` (to
// `running` after remediation, or to `planning` when the blocker invalidated the plan) and from
// `stopped` (to `running` once the STOP file is gone) — an earlier revision of the design had
// neither, which made both states one-way traps.
//
// EVENTS STAY INSIDE SCHEMA v1. lib/run-events/schema.mjs freezes the event vocabulary, so this
// module maps its richer phase set onto the existing ten event types rather than proposing a
// version 2: plan review and final verification ride as `step.started`/`step.completed` with a
// reserved step id, and every pause (`needs_user`, `stopped`, `awaiting_action_approval`) is
// `run.blocked`. The phase itself always travels in `detail.phase`, so nothing is lost.
//
// Pure state transformation: no filesystem, no process, no clock except the injected one. The store
// persists what these functions return.

import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';

/** Every legal run phase. */
export const PHASES = Object.freeze([
  'new',
  'planning',
  'plan_review',
  'awaiting_approval',
  'running',
  'awaiting_action_approval',
  'final_verification',
  'needs_user',
  'stopped',
  'done',
  'failed',
]);

/** Phases from which nothing further happens. */
export const TERMINAL_PHASES = Object.freeze(['done', 'failed']);

/**
 * Legal successors per phase — the exact graph in plan.md's "State machine" section.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const TRANSITIONS = Object.freeze({
  new: Object.freeze(['planning']),
  planning: Object.freeze(['plan_review', 'needs_user']),
  plan_review: Object.freeze(['awaiting_approval', 'planning', 'needs_user']),
  awaiting_approval: Object.freeze(['running']),
  running: Object.freeze([
    'final_verification',
    'awaiting_action_approval',
    'needs_user',
    'stopped',
    'failed',
    'planning',
  ]),
  awaiting_action_approval: Object.freeze(['running', 'stopped']),
  final_verification: Object.freeze([
    'done',
    'running',
    'planning',
    'awaiting_action_approval',
    'needs_user',
    'stopped',
    'failed',
  ]),
  needs_user: Object.freeze(['running', 'planning']),
  stopped: Object.freeze(['running']),
  done: Object.freeze([]),
  failed: Object.freeze([]),
});

/** Reserved step ids for the two phases that are not node work. */
export const PLAN_REVIEW_STEP = 'plan-review';
export const FINAL_VERIFY_STEP = 'final-verify';

/**
 * Is `to` reachable from `from`?
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/**
 * Move a run to `to`, or refuse.
 *
 * Every transition goes through here, so the sequence bump and the legality check cannot be skipped
 * by a caller that "knows" the move is fine.
 *
 * @param {object} state
 * @param {string} to
 * @param {{event: string, status: string, step?: string|null, attempt?: string|null,
 *          detail?: object, refs?: object[]}} record
 * @returns {{state: object, event: object}}
 * @throws {SidekicksError} EXIT_VALIDATION on an illegal move
 */
function move(state, to, record) {
  const from = state.phase;
  if (!PHASES.includes(to)) {
    throw new SidekicksError(`goal: '${to}' is not a run phase`, EXIT_VALIDATION);
  }
  if (!canTransition(from, to)) {
    throw new SidekicksError(
      `goal: illegal transition ${from} → ${to} (legal from '${from}': `
      + `${(TRANSITIONS[from] || []).join(', ') || 'none — terminal phase'})`,
      EXIT_VALIDATION,
    );
  }
  state.phase = to;
  state.sequence = Number(state.sequence ?? 0) + 1;
  return {
    state,
    event: {
      run_id: state.run_id,
      event: record.event,
      status: record.status,
      node: record.step ?? null,
      attempt: record.attempt ?? null,
      refs: record.refs ?? [],
      detail: { phase: to, from, ...(record.detail || {}) },
    },
  };
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

/**
 * Intake → planning. Also the transition a scope-invalidating finding takes back to planning.
 *
 * Returning to `planning` CLEARS approval, which is the whole point: an approved envelope binds a
 * plan digest, and a re-plan produces a different one.
 *
 * @param {object} state
 * @param {{reason?: string}} [opts]
 * @returns {{state: object, event: object}}
 */
export function toPlanning(state, opts = {}) {
  const first = state.phase === 'new';
  if (!first) {
    state.approved_envelope_digest = null;
    state.plan_digest = null;
    state.envelope = null;
  }
  state.needs_user = null;
  return move(state, 'planning', {
    event: first ? 'run.created' : 'run.reconciled',
    status: first ? 'pending' : 'running',
    detail: {
      reason: opts.reason ? String(opts.reason).slice(0, 512) : 'planning',
      approval_cleared: !first,
    },
  });
}

/**
 * Planning → plan review. The critic reads the rendered artifacts in read-only mode.
 *
 * @param {object} state
 * @param {{plan_digest: string}} opts
 * @returns {{state: object, event: object}}
 */
export function toPlanReview(state, opts) {
  state.plan_digest = opts.plan_digest;
  return move(state, 'plan_review', {
    event: 'step.started',
    status: 'running',
    step: PLAN_REVIEW_STEP,
    detail: { plan_digest: opts.plan_digest, pass: Number(state.planning?.critique_passes ?? 0) + 1 },
  });
}

/**
 * Plan review → planning, for one bounded correction pass.
 *
 * The pass counter lives here rather than in the caller so the cap cannot be bypassed by a caller
 * that forgot to increment it. Exhaustion is the caller's cue to go to `needs_user` instead.
 *
 * @param {object} state
 * @param {{findings: string[], max_passes?: number}} opts
 * @returns {{state: object, event: object}}
 * @throws {SidekicksError} when the correction budget is already spent
 */
export function toPlanCorrection(state, opts) {
  const max = Number(opts.max_passes ?? 2);
  const spent = Number(state.planning?.critique_passes ?? 0);
  if (spent >= max) {
    throw new SidekicksError(
      `goal: plan critique budget exhausted (${spent}/${max} correction passes) — the run must go to `
      + "needs_user with the open findings, never round the plan/critique loop again",
      EXIT_VALIDATION,
    );
  }
  state.planning = { ...(state.planning || {}), critique_passes: spent + 1 };
  // A correction is NOT a re-plan: the goal and target are unchanged, so approval was never granted
  // and there is nothing to clear. Reuse the planning move but keep the digest for the diff.
  const priorDigest = state.plan_digest;
  const r = move(state, 'planning', {
    event: 'step.failed',
    status: 'failed',
    step: PLAN_REVIEW_STEP,
    detail: {
      pass: spent + 1,
      max_passes: max,
      findings: (opts.findings || []).slice(0, 20).map((f) => String(f).slice(0, 512)),
      prior_plan_digest: priorDigest ?? null,
    },
  });
  state.needs_user = null;
  return r;
}

/**
 * Plan review → awaiting approval. The envelope is now offered; nothing may be dispatched.
 *
 * @param {object} state
 * @param {{envelope: object, envelope_digest: string, plan_digest: string}} opts
 * @returns {{state: object, event: object}}
 */
export function toAwaitingApproval(state, opts) {
  state.envelope = opts.envelope;
  state.plan_digest = opts.plan_digest;
  return move(state, 'awaiting_approval', {
    event: 'step.completed',
    status: 'succeeded',
    step: PLAN_REVIEW_STEP,
    detail: { envelope_digest: opts.envelope_digest, plan_digest: opts.plan_digest },
  });
}

/**
 * Awaiting approval → running: the user approved this exact envelope digest.
 *
 * The approval is appended to a history rather than overwriting a field, so a later budget amendment
 * cannot erase the record of what was originally approved.
 *
 * @param {object} state
 * @param {{digest: string, at: string, kind?: 'initial'|'amendment', changed?: string[]}} opts
 * @returns {{state: object, event: object}}
 */
export function approveEnvelope(state, opts) {
  state.approved_envelope_digest = opts.digest;
  state.approvals = [
    ...(Array.isArray(state.approvals) ? state.approvals : []),
    {
      digest: opts.digest,
      kind: opts.kind || 'initial',
      at: opts.at,
      changed: (opts.changed || []).slice(),
    },
  ];
  return move(state, 'running', {
    event: 'run.approved',
    status: 'running',
    detail: {
      envelope_digest: opts.digest,
      plan_digest: state.plan_digest ?? null,
      approval_kind: opts.kind || 'initial',
    },
  });
}

/**
 * Back to `running` from a pause: `needs_user`, `stopped`, or `awaiting_action_approval`.
 *
 * @param {object} state
 * @param {{reason: string}} opts
 * @returns {{state: object, event: object}}
 */
export function toRunning(state, opts) {
  state.needs_user = null;
  if (state.phase === 'stopped') state.stop = null;
  if (state.phase === 'awaiting_action_approval') state.action_request = null;
  return move(state, 'running', {
    event: 'run.started',
    status: 'running',
    detail: { reason: String(opts.reason).slice(0, 512) },
  });
}

/**
 * All nodes complete → final verification.
 *
 * @param {object} state
 * @returns {{state: object, event: object}}
 */
export function toFinalVerification(state) {
  return move(state, 'final_verification', {
    event: 'step.started',
    status: 'running',
    step: FINAL_VERIFY_STEP,
    detail: { plan_digest: state.plan_digest ?? null },
  });
}

/**
 * Final verification approved and the exit check passed → done.
 *
 * @param {object} state
 * @param {{verdict: object, at: string, exit_check: object}} opts
 * @returns {{state: object, event: object}}
 */
export function toDone(state, opts) {
  state.final = {
    result: 'approved',
    at: opts.at,
    summary: String(opts.verdict?.summary ?? '').slice(0, 1024),
    exit_check: opts.exit_check,
  };
  return move(state, 'done', {
    event: 'run.completed',
    status: 'succeeded',
    step: FINAL_VERIFY_STEP,
    detail: { exit_check_ok: Boolean(opts.exit_check?.ok) },
  });
}

/**
 * A pause that needs a human. Carries WHY, because a `needs_user` with no reason is unactionable.
 *
 * @param {object} state
 * @param {{reason: string, findings?: string[], next?: string}} opts
 * @returns {{state: object, event: object}}
 */
export function toNeedsUser(state, opts) {
  state.needs_user = {
    reason: String(opts.reason).slice(0, 1024),
    findings: (opts.findings || []).slice(0, 20).map((f) => String(f).slice(0, 512)),
    next: opts.next ? String(opts.next).slice(0, 512) : null,
  };
  return move(state, 'needs_user', {
    event: 'run.blocked',
    status: 'blocked',
    detail: { reason: state.needs_user.reason, finding_count: state.needs_user.findings.length },
  });
}

/**
 * The STOP gate was observed. Graceful by construction: this runs AFTER the current attempt
 * settled, so it never describes a half-written edit.
 *
 * @param {object} state
 * @param {{at: string}} opts
 * @returns {{state: object, event: object}}
 */
export function toStopped(state, opts) {
  state.stop = { observed_at: opts.at };
  return move(state, 'stopped', {
    event: 'run.blocked',
    status: 'blocked',
    detail: { reason: 'STOP file present — no new attempt is dispatched' },
  });
}

/**
 * An outward or destructive action was requested. Pauses BEFORE execution, every time.
 *
 * @param {object} state
 * @param {{request: object, digest: string}} opts
 * @returns {{state: object, event: object}}
 */
export function toAwaitingActionApproval(state, opts) {
  state.action_request = { ...opts.request, digest: opts.digest };
  return move(state, 'awaiting_action_approval', {
    event: 'run.blocked',
    status: 'blocked',
    detail: {
      reason: 'an action outside goal approval was requested',
      action_class: String(opts.request?.action_class ?? 'unknown'),
      request_digest: opts.digest,
    },
  });
}

/**
 * Unrecoverable failure. Distinct from `needs_user`: this one is not waiting for anything.
 *
 * @param {object} state
 * @param {{reason: string}} opts
 * @returns {{state: object, event: object}}
 */
export function toFailed(state, opts) {
  state.needs_user = null;
  return move(state, 'failed', {
    event: 'run.failed',
    status: 'failed',
    detail: { reason: String(opts.reason).slice(0, 1024) },
  });
}

// ---------------------------------------------------------------------------
// Node and attempt state
// ---------------------------------------------------------------------------

/**
 * The node record, created on first touch.
 *
 * @param {object} state
 * @param {string} nodeId
 * @returns {object}
 */
export function nodeRecord(state, nodeId) {
  if (!state.nodes || typeof state.nodes !== 'object') state.nodes = {};
  if (!state.nodes[nodeId]) {
    state.nodes[nodeId] = {
      state: 'pending',
      attempt_count: 0,
      active_attempt: null,
      attempts: [],
      last_error: null,
    };
  }
  return state.nodes[nodeId];
}

/** Node id → state, the map graph.mjs's selectors take. */
export function nodeStates(state) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [id, rec] of Object.entries(state.nodes || {})) out[id] = rec.state ?? 'pending';
  return out;
}

/**
 * Open a new attempt on a node, BEFORE any subprocess is dispatched.
 *
 * The ordering is the safety property: the attempt record (and its id) exists on disk first, so a
 * crash between here and the spawn leaves a visible attempt with no terminal result — which
 * `resume` treats as unverifiable and refuses to re-dispatch — rather than an invisible one that
 * gets silently duplicated.
 *
 * @param {object} state
 * @param {{node: string, attempt_id: string, executor: string, family?: string|null, tier: string,
 *          model?: string|null, role: string, at: string, max_attempts: number}} opts
 * @returns {{state: object, event: object, attempt: object}}
 * @throws {SidekicksError} when the node's attempt budget is spent
 */
export function startAttempt(state, opts) {
  const rec = nodeRecord(state, opts.node);
  if (rec.attempt_count >= opts.max_attempts) {
    throw new SidekicksError(
      `goal: node '${opts.node}' has used its ${opts.max_attempts} attempts — only the user may raise `
      + 'the limit (an append-only budget amendment), never the engine',
      EXIT_VALIDATION,
    );
  }
  const n = rec.attempt_count + 1;
  const attempt = {
    id: opts.attempt_id,
    n,
    executor: opts.executor,
    family: opts.family ?? null,
    tier: opts.tier,
    model: opts.model ?? null,
    role: opts.role,
    dispatched_at: opts.at,
    pid: null,
    session_id: null,
    ended_at: null,
    exit_code: null,
    result: 'dispatched',
    transcript: null,
    digest: null,
    review: null,
    correction: null,
    error: null,
  };
  rec.attempt_count = n;
  rec.active_attempt = attempt.id;
  rec.state = 'running';
  rec.attempts = [...rec.attempts, attempt];
  state.sequence = Number(state.sequence ?? 0) + 1;
  state.spent = { ...(state.spent || {}), attempts: Number(state.spent?.attempts ?? 0) + 1 };
  return {
    state,
    attempt,
    event: {
      run_id: state.run_id,
      event: 'step.started',
      status: 'running',
      node: opts.node,
      attempt: n,
      refs: [],
      detail: {
        phase: state.phase,
        attempt_id: attempt.id,
        executor: opts.executor,
        tier: opts.tier,
        role: opts.role,
      },
    },
  };
}

/**
 * Record the child's pid and native session id as soon as they are known.
 *
 * Not a transition — no sequence bump, no event. It is a fact about an attempt already open, and
 * `resume` reads it to decide whether a child is provably live.
 *
 * @param {object} state
 * @param {{node: string, attempt_id: string, pid?: number|null, session_id?: string|null}} opts
 * @returns {object} state
 */
export function recordAttemptProcess(state, opts) {
  const rec = nodeRecord(state, opts.node);
  const attempt = rec.attempts.find((a) => a.id === opts.attempt_id);
  if (!attempt) {
    throw new SidekicksError(
      `goal: no open attempt '${opts.attempt_id}' on node '${opts.node}'`,
      EXIT_VALIDATION,
    );
  }
  if (opts.pid !== undefined && opts.pid !== null) attempt.pid = opts.pid;
  if (opts.session_id !== undefined && opts.session_id !== null) attempt.session_id = opts.session_id;
  attempt.result = 'running';
  return state;
}

/**
 * Settle an attempt: the subprocess ended and (where applicable) a reviewer judged it.
 *
 * @param {object} state
 * @param {{node: string, attempt_id: string, at: string, exit_code: number|null,
 *          result: 'passed'|'failed'|'errored', transcript?: string|null, digest?: string|null,
 *          review?: string|null, error?: string|null, wall_clock_ms?: number,
 *          tokens?: number|null, usd?: number|null}} opts
 * @returns {{state: object, event: object}}
 */
export function finishAttempt(state, opts) {
  const rec = nodeRecord(state, opts.node);
  const attempt = rec.attempts.find((a) => a.id === opts.attempt_id);
  if (!attempt) {
    throw new SidekicksError(
      `goal: no open attempt '${opts.attempt_id}' on node '${opts.node}'`,
      EXIT_VALIDATION,
    );
  }
  attempt.ended_at = opts.at;
  attempt.exit_code = opts.exit_code ?? null;
  attempt.result = opts.result;
  attempt.transcript = opts.transcript ?? attempt.transcript;
  attempt.digest = opts.digest ?? attempt.digest;
  attempt.review = opts.review ?? attempt.review;
  attempt.error = opts.error ? String(opts.error).slice(0, 1024) : null;
  if (opts.guard_refusals !== undefined) attempt.guard_refusals = Number(opts.guard_refusals);
  if (opts.write_violations !== undefined) {
    attempt.write_violations = (opts.write_violations || []).slice();
  }
  if (opts.changed_paths !== undefined) attempt.changed_paths = (opts.changed_paths || []).slice();

  rec.active_attempt = null;
  if (opts.result === 'passed') {
    rec.state = 'completed';
    rec.last_error = null;
    state.breaker = { consecutive_failures: 0 };
  } else {
    // `failed`, not `blocked`: the node is eligible again, and the attempt budget — not the graph —
    // is what stops a failure being retried forever.
    rec.state = 'failed';
    rec.last_error = attempt.error || `attempt ${attempt.n} ${opts.result}`;
    state.breaker = {
      consecutive_failures: Number(state.breaker?.consecutive_failures ?? 0) + 1,
    };
  }

  const spent = state.spent || {};
  state.spent = {
    ...spent,
    wall_clock_ms: Number(spent.wall_clock_ms ?? 0) + Number(opts.wall_clock_ms ?? 0),
    // Token and dollar figures are best-effort: not every CLI reports them, so they are recorded
    // and reported but never the enforcement floor (attempts and wall clock are).
    tokens: opts.tokens == null ? (spent.tokens ?? null) : Number(spent.tokens ?? 0) + Number(opts.tokens),
    usd: opts.usd == null ? (spent.usd ?? null) : Number(spent.usd ?? 0) + Number(opts.usd),
  };

  state.sequence = Number(state.sequence ?? 0) + 1;
  return {
    state,
    event: {
      run_id: state.run_id,
      event: opts.result === 'passed' ? 'step.completed' : 'step.failed',
      status: opts.result === 'passed' ? 'succeeded' : 'failed',
      node: opts.node,
      attempt: attempt.n,
      refs: [],
      detail: {
        phase: state.phase,
        attempt_id: attempt.id,
        result: opts.result,
        exit_code: attempt.exit_code,
        consecutive_failures: Number(state.breaker?.consecutive_failures ?? 0),
      },
    },
  };
}

/**
 * Spend an action grant on one attempt.
 *
 * A TRANSITION, not a mutation helper, because the fact that a grant was spent has to reach the event
 * sidecar: it is the audit line for the one point in a run where the engine carries out something the
 * goal approval did not cover. Refuses a grant that is already consumed rather than re-marking it —
 * that refusal is what makes "once" mean once even if a caller loops.
 *
 * @param {object} state
 * @param {{request_id: string, attempt_id: string, at: string}} opts
 * @returns {{state: object, event: object}}
 * @throws {SidekicksError} EXIT_VALIDATION
 */
export function consumeGrant(state, opts) {
  const grants = Array.isArray(state.action_grants) ? state.action_grants : [];
  const grant = grants.find((g) => g && g.request_id === opts.request_id);
  if (!grant) {
    throw new SidekicksError(
      `goal: no action grant '${opts.request_id}' on this run`,
      EXIT_VALIDATION,
    );
  }
  if (grant.consumed_by) {
    throw new SidekicksError(
      `goal: the grant for '${opts.request_id}' was already spent by attempt ${grant.consumed_by}. A `
      + 'grant authorizes one action once; a second use needs a second grant.',
      EXIT_VALIDATION,
    );
  }
  grant.consumed_by = opts.attempt_id;
  grant.consumed_at = opts.at;
  state.sequence = Number(state.sequence ?? 0) + 1;
  return {
    state,
    event: {
      run_id: state.run_id,
      event: 'step.started',
      status: 'running',
      node: grant.node,
      refs: [],
      detail: {
        phase: state.phase,
        grant_consumed: grant.request_id,
        action_class: grant.action_class,
        target: grant.target,
        attempt_id: opts.attempt_id,
      },
    },
  };
}

/**
 * Reopen a completed node — what a rejected-in-scope final verdict does.
 *
 * The node's attempt history is KEPT (it is evidence) and its count is NOT reset: reopening does not
 * buy fresh attempts, so a node cannot be cycled indefinitely by repeated final rejections.
 *
 * @param {object} state
 * @param {{node: string, reason: string}} opts
 * @returns {object} state
 */
export function reopenNode(state, opts) {
  const rec = nodeRecord(state, opts.node);
  rec.state = 'failed';
  rec.active_attempt = null;
  rec.last_error = `reopened: ${String(opts.reason).slice(0, 512)}`;
  return state;
}

/**
 * Every attempt that is open with no proven terminal result — what a resume has to reconcile.
 *
 * @param {object} state
 * @returns {{node: string, attempt: object}[]}
 */
export function unsettledAttempts(state) {
  /** @type {{node: string, attempt: object}[]} */
  const out = [];
  for (const [node, rec] of Object.entries(state.nodes || {})) {
    for (const attempt of rec.attempts || []) {
      if (attempt.ended_at === null) out.push({ node, attempt });
    }
  }
  return out;
}
