// lib/goal-lifecycle/store.mjs
// The durable half of the goal engine: where a run's files live, how `run.json` is written, how the
// single-writer lease is taken, and how the event sidecar is kept honest.
//
// `run.json` IS THE AUTHORITY. The `events.v1.jsonl` sidecar is a diagnostic, exactly as
// lib/run-events/schema.mjs's DUAL_WRITE_STEPS describes: state is mutated first and never rolled
// back to match the sidecar, and a failed append halts the engine before its next transition rather
// than fabricating history. That asymmetry is what makes a crash mid-transition recoverable — the
// sidecar may lag, it may never lead.
//
// THE LEASE IS BORROWED, NOT REBUILT. lib/run-events/store.mjs already implements exclusive-create
// locking with a nonce, and — more importantly — the conservative ownership rules that decide when a
// lock may be reclaimed: a dead pid on THIS host may be archived, while a live owner, a foreign
// host, or a malformed record never is. Those rules took an incident to get right. `acquireLock`
// takes its paths as an argument, so pointing it at `run.lock` reuses all of it verbatim; the
// heartbeat lives in `run.json` (where a reader already looks) rather than being rewritten into the
// lock file on every tick.
//
// TWO LOCKS, ON PURPOSE. `run.lock` is the STATE-WRITER lease, held for a whole transition; the
// sidecar's own `events.v1.lock` is taken and released inside a single append. They protect
// different things, and collapsing them would make one long-held lease block a diagnostic write.
//
// SESSION IDS NEVER REACH THE SIDECAR. lib/run-events/schema.mjs refuses a `detail` key matching
// `session[-_]?id` as secret-shaped. That is correct — a resumable session id is a capability — so
// session ids live in `run.json` and the sidecar gets the attempt id instead.
//
// Zero npm dependencies — node:* plus lib/ back-edges only.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { SidekicksError, EXIT_IO, EXIT_NOT_FOUND, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  acquireLock,
  appendEvent,
  bangkokTimestamp,
  classifyLock,
  releaseLock,
} from '../run-events/store.mjs';
import { DIVERGED_CODE, deterministicEventId } from '../run-events/schema.mjs';
import { GOAL_SCHEMA_VERSION } from './schema.mjs';

/** The engine identity this store writes into every event. Already in the frozen ENGINES list. */
export const GOAL_ENGINE = 'cli-orchestrator';

/** Filenames inside a run folder. Named here so nothing else spells them. */
export const RUN_STATE_FILENAME = 'run.json';
export const GOAL_FILENAME = 'goal.json';
export const PLAN_FILENAME = 'plan.json';
export const PLAN_MD_FILENAME = 'implementation-plan.md';
export const ENVELOPE_FILENAME = 'approval-envelope.json';
export const STOP_FILENAME = 'STOP';
export const RUN_LOCK_FILENAME = 'run.lock';
export const RUN_LOCK_RECOVERY_DIRNAME = 'run.lock.recovery';

/**
 * Every path the engine writes inside one run folder.
 *
 * @param {string} runDir - absolute path to the run folder
 * @returns {{runDir: string, goal: string, plan: string, planMd: string, envelope: string,
 *            state: string, stop: string, lock: string, recovery: string, attempts: string,
 *            planCandidates: string, contest: string, final: string}}
 */
export function goalPaths(runDir) {
  return {
    runDir,
    goal: join(runDir, GOAL_FILENAME),
    plan: join(runDir, PLAN_FILENAME),
    planMd: join(runDir, PLAN_MD_FILENAME),
    envelope: join(runDir, ENVELOPE_FILENAME),
    state: join(runDir, RUN_STATE_FILENAME),
    stop: join(runDir, STOP_FILENAME),
    lock: join(runDir, RUN_LOCK_FILENAME),
    recovery: join(runDir, RUN_LOCK_RECOVERY_DIRNAME),
    attempts: join(runDir, 'attempts'),
    planCandidates: join(runDir, 'plan-candidates'),
    contest: join(runDir, 'contest'),
    final: join(runDir, 'final'),
  };
}

/**
 * The folder one attempt's evidence lives in: `attempts/<node>/<n>/`.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @param {number} n - 1-based attempt number within the node
 * @returns {string}
 */
export function attemptDir(runDir, nodeId, n) {
  return join(runDir, 'attempts', nodeId, String(n));
}

/**
 * The stable attempt id — `<node>#<n>`.
 *
 * Deterministic rather than random because it is also the sidecar's `step`/`attempt` key, so a
 * retried dual-write after a crash produces the SAME `event_id` and the store answers `duplicate`
 * instead of double-recording the attempt.
 *
 * @param {string} nodeId
 * @param {number} n
 * @returns {string}
 */
export function attemptId(nodeId, n) {
  return `${nodeId}#${n}`;
}

// ---------------------------------------------------------------------------
// run.json
// ---------------------------------------------------------------------------

/** The fixed key order of `run.json` — determinism, so two runs diff cleanly. */
export const RUN_FIELD_ORDER = Object.freeze([
  'schema_version',
  'run_id',
  'created_at',
  'updated_at',
  'sequence',
  'phase',
  'goal_digest',
  'plan_digest',
  'approved_envelope_digest',
  'approvals',
  'envelope',
  'planning',
  'nodes',
  'spent',
  'breaker',
  'lease',
  'stop',
  'action_request',
  'final',
  'divergence',
  'needs_user',
]);

/**
 * A fresh run state at intake.
 *
 * @param {{run_id: string, goal_digest: string, now?: () => number}} parts
 * @returns {object}
 */
export function newRunState(parts) {
  const now = parts.now || Date.now;
  const stamp = bangkokTimestamp(now());
  return orderRunState({
    schema_version: GOAL_SCHEMA_VERSION,
    run_id: parts.run_id,
    created_at: stamp,
    updated_at: stamp,
    sequence: 0,
    phase: 'new',
    goal_digest: parts.goal_digest,
    plan_digest: null,
    approved_envelope_digest: null,
    approvals: [],
    envelope: null,
    planning: { critique_passes: 0, contest: null },
    nodes: {},
    spent: { attempts: 0, wall_clock_ms: 0, tokens: null, usd: null },
    breaker: { consecutive_failures: 0 },
    lease: null,
    stop: null,
    action_request: null,
    final: null,
    divergence: null,
    needs_user: null,
  });
}

/**
 * Re-key a state object into RUN_FIELD_ORDER, dropping nothing (unknown keys sort last, so a
 * forward-compatible field written by a newer engine survives a read/write cycle here).
 *
 * @param {object} state
 * @returns {object}
 */
export function orderRunState(state) {
  const src = state || {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of RUN_FIELD_ORDER) if (key in src) out[key] = src[key];
  for (const key of Object.keys(src).sort()) if (!(key in out)) out[key] = src[key];
  return out;
}

/**
 * Read `run.json`.
 *
 * @param {string} runDir
 * @returns {object}
 * @throws {SidekicksError} EXIT_NOT_FOUND when absent, EXIT_VALIDATION when unparseable
 */
export function readRunState(runDir) {
  const paths = goalPaths(runDir);
  let raw;
  try {
    raw = readFileSync(paths.state, 'utf8');
  } catch {
    throw new SidekicksError(
      `goal: no run state at ${RUN_STATE_FILENAME} in this run folder — is the run id correct?`,
      EXIT_NOT_FOUND,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SidekicksError(
      `goal: ${RUN_STATE_FILENAME} is not valid JSON (${err.message}) — this file is the run's `
      + 'authority and is never repaired automatically',
      EXIT_VALIDATION,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SidekicksError(`goal: ${RUN_STATE_FILENAME} must contain a JSON object`, EXIT_VALIDATION);
  }
  return parsed;
}

/**
 * Write `run.json` atomically, stamping `updated_at`.
 *
 * `sequence` is NOT touched here: it is bumped by the state machine's transition functions, which
 * are the only things allowed to change phase or node state. A write that merely refreshes a
 * heartbeat must not look like a transition.
 *
 * @param {string} runDir
 * @param {object} state
 * @param {{now?: () => number}} [opts]
 * @returns {object} the state as written
 */
export function writeRunState(runDir, state, opts = {}) {
  const now = opts.now || Date.now;
  const next = orderRunState({ ...state, updated_at: bangkokTimestamp(now()) });
  mkdirp(runDir);
  writeAtomic(goalPaths(runDir).state, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * `mkdir -p`, local so this module keeps its back-edges to fsx's write helper only.
 *
 * @param {string} dir
 */
export function mkdirp(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new SidekicksError(`goal: cannot create '${dir}': ${err.message}`, EXIT_IO);
  }
}

/**
 * Read a JSON artifact from a run folder, or null when absent.
 *
 * @param {string} absPath
 * @returns {object|null}
 */
export function readJsonIfPresent(absPath) {
  if (!existsSync(absPath)) return null;
  try {
    return JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (err) {
    throw new SidekicksError(`goal: '${absPath}' is not valid JSON: ${err.message}`, EXIT_VALIDATION);
  }
}

/**
 * Write a JSON artifact atomically, in canonical-ish pretty form (2-space, trailing newline).
 *
 * @param {string} absPath
 * @param {unknown} value
 */
export function writeJson(absPath, value) {
  writeAtomic(absPath, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// The run lease
// ---------------------------------------------------------------------------

/**
 * Take the run's exclusive state-writer lease.
 *
 * @param {string} runDir
 * @param {{now?: () => number, hostname?: string, pid?: number, timeoutMs?: number}} [opts]
 * @returns {{nonce: string, reclaimed: string[]}}
 */
export function acquireRunLease(runDir, opts = {}) {
  const paths = goalPaths(runDir);
  mkdirp(runDir);
  return acquireLock(
    { lock: paths.lock, recovery: paths.recovery },
    {
      now: opts.now,
      hostname: opts.hostname,
      pid: opts.pid,
      timeoutMs: opts.timeoutMs,
    },
  );
}

/**
 * Release a lease we hold. A lease whose nonce is no longer ours is left alone.
 *
 * @param {string} runDir
 * @param {string} nonce
 */
export function releaseRunLease(runDir, nonce) {
  releaseLock({ lock: goalPaths(runDir).lock }, nonce);
}

/**
 * Classify the current lease holder without trying to take it — what `goal status` reports.
 *
 * @param {string} runDir
 * @param {{hostname?: string}} [opts]
 * @returns {{state: 'active'|'reclaimable'|'foreign'|'malformed'|'gone', owner: object|null, reason: string}}
 */
export function inspectRunLease(runDir, opts = {}) {
  return classifyLock(goalPaths(runDir).lock, opts.hostname || osHostname());
}

/**
 * Record (or refresh) the lease heartbeat in `run.json`.
 *
 * @param {object} state
 * @param {{nonce: string, now?: () => number, hostname?: string, pid?: number}} opts
 * @returns {object} the mutated state (same object, for chaining)
 */
export function stampLease(state, opts) {
  const now = opts.now || Date.now;
  const stamp = bangkokTimestamp(now());
  const existing = state.lease && state.lease.nonce === opts.nonce ? state.lease : null;
  state.lease = {
    nonce: opts.nonce,
    pid: opts.pid ?? process.pid,
    hostname: opts.hostname || osHostname(),
    acquired_at: existing ? existing.acquired_at : stamp,
    heartbeat_at: stamp,
  };
  return state;
}

/**
 * Drop the lease record from `run.json` (the on-disk lock is released separately).
 *
 * @param {object} state
 * @returns {object}
 */
export function clearLease(state) {
  state.lease = null;
  return state;
}

// ---------------------------------------------------------------------------
// STOP
// ---------------------------------------------------------------------------

/**
 * Write the durable STOP gate.
 *
 * A file rather than a flag in `run.json` deliberately: `goal stop` must work from a session that
 * does NOT hold the run lease (the whole point is to stop a run someone else is driving), and
 * touching `run.json` without the lease would break the single-writer invariant.
 *
 * @param {string} runDir
 * @param {{reason?: string, now?: () => number}} [opts]
 * @returns {string} the absolute STOP path
 */
export function writeStop(runDir, opts = {}) {
  const now = opts.now || Date.now;
  const paths = goalPaths(runDir);
  mkdirp(runDir);
  const body = [
    `stopped_at: ${bangkokTimestamp(now())}`,
    `reason: ${opts.reason ? String(opts.reason).replace(/[\r\n]+/g, ' ') : 'operator requested'}`,
    'note: graceful — a running attempt finishes; no new attempt is dispatched while this file exists.',
    '',
  ].join('\n');
  writeAtomic(paths.stop, body);
  return paths.stop;
}

/**
 * Is the STOP gate present?
 *
 * @param {string} runDir
 * @returns {boolean}
 */
export function stopPresent(runDir) {
  return existsSync(goalPaths(runDir).stop);
}

// ---------------------------------------------------------------------------
// The event sidecar
// ---------------------------------------------------------------------------

/**
 * Append one goal transition to the run's sidecar.
 *
 * Returns a result object rather than throwing on an append failure, because the caller has ALREADY
 * mutated authoritative state by the time this runs: the correct response to a failed append is to
 * record divergence and halt, not to unwind a write that is the resume authority.
 *
 * @param {string} runDir
 * @param {{event: string, status: string, actor?: {kind: string, id: string}, run_id: string,
 *          work_item?: string|null, node?: string|null, attempt?: string|number|null,
 *          refs?: object[], detail?: object}} intent
 * @param {{now?: () => number}} [opts]
 * @returns {{ok: true, result: 'appended'|'duplicate', sequence: number}
 *          |{ok: false, error: string, code: string}}
 */
export function appendGoalEvent(runDir, intent, opts = {}) {
  const eventId = deterministicEventId({
    engine: GOAL_ENGINE,
    run_id: intent.run_id,
    event: intent.event,
    step: intent.node ?? null,
    attempt: intent.attempt ?? null,
  });
  const payload = {
    event_id: eventId,
    run_id: intent.run_id,
    work_item: intent.work_item ?? intent.run_id,
    engine: GOAL_ENGINE,
    event: intent.event,
    status: intent.status,
    actor: intent.actor ?? { kind: 'cli', id: 'sidekicks-goal' },
    refs: intent.refs ?? [],
    detail: intent.detail ?? {},
  };
  try {
    const r = appendEvent(runDir, payload, { now: opts.now });
    return { ok: true, result: r.result, sequence: r.sequence };
  } catch (err) {
    return {
      ok: false,
      code: DIVERGED_CODE,
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Record sidecar divergence on the state and return it.
 *
 * The engine must not perform another transition while this is set — `assertNoDivergence` is the
 * gate every dispatch path calls, and `goal resume` is what clears it after reconciliation.
 *
 * @param {object} state
 * @param {{event: string, error: string, now?: () => number}} info
 * @returns {object}
 */
export function stampDivergence(state, info) {
  const now = info.now || Date.now;
  state.divergence = {
    code: DIVERGED_CODE,
    event: info.event,
    error: String(info.error).slice(0, 512),
    observed_at: bangkokTimestamp(now()),
  };
  return state;
}

/**
 * Refuse to proceed while the sidecar is known to have diverged.
 *
 * @param {object} state
 * @throws {SidekicksError} EXIT_IO
 */
export function assertNoDivergence(state) {
  if (!state || !state.divergence) return;
  throw new SidekicksError(
    `goal: ${state.divergence.code} — the event sidecar could not record the '${state.divergence.event}' `
    + `transition (${state.divergence.error}). ${RUN_STATE_FILENAME} remains authoritative; run `
    + "'goal resume' to reconcile before another transition.",
    EXIT_IO,
  );
}

/**
 * Assert a run folder exists and is a directory — the precondition `appendEvent` also enforces,
 * checked here so a typo'd run id fails with a goal-shaped message.
 *
 * @param {string} runDir
 * @throws {SidekicksError} EXIT_NOT_FOUND
 */
export function assertRunDir(runDir) {
  let st;
  try {
    st = statSync(runDir);
  } catch {
    throw new SidekicksError(`goal: run folder not found: ${runDir}`, EXIT_NOT_FOUND);
  }
  if (!st.isDirectory()) {
    throw new SidekicksError(`goal: run folder is not a directory: ${runDir}`, EXIT_NOT_FOUND);
  }
}
