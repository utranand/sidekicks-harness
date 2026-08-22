// lib/goal-lifecycle/jobs.mjs
// The planning phase's job ledger: every concurrent child the contest dispatches, on disk, before it
// is dispatched.
//
// WHY THE NODE LOOP DID NOT NEED THIS AND THE CONTEST DOES. The node loop runs ONE child at a time, so
// the attempt record is the ledger — open it, spawn, settle it. The contest fans out one contestant per
// family and then one judge per candidate, concurrently. `Promise.all` over sessions that record
// themselves only on RETURN means a parent that dies mid-fan-out leaves several children alive with
// nothing on disk naming them: a resume cannot tell "this family never started" from "this family is
// still planning", and the wrong answer re-dispatches a live session.
//
// SO THE INTENT IS PERSISTED BEFORE THE SPAWN. Every job exists on disk as `pending` before any child
// starts, becomes `dispatched` with its pid the moment one does, and reaches a terminal substate only
// when its outcome is known. A crash therefore leaves evidence of exactly which stage each family was
// in, and resume classifies rather than guesses.
//
// DETERMINISTIC IDS. `contestant:anthropic`, `judge:openai`, `synthesis` — derived from the family, not
// from a counter or a timestamp. A resumed run has to be able to look up the same job it dispatched,
// and an id containing a clock reading is a different id every time it is recomputed.
//
// THE PARENT IS THE ONLY WRITER, and every mutation here is synchronous: read, change, write, with no
// `await` in between. Node's single thread is what serializes concurrent contestants against each
// other, so no second lock is needed — but that guarantee only holds while these functions stay
// synchronous, which is why none of them is async.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

/** The substates a job moves through. Terminal ones are the only outcomes a resume may trust. */
export const JOB_SUBSTATES = Object.freeze([
  'pending', 'dispatched', 'running', 'completed', 'failed', 'disqualified',
]);

/** Substates that mean the job's fate is known. */
export const TERMINAL_SUBSTATES = Object.freeze(['completed', 'failed', 'disqualified']);

/**
 * How many times one planning job may be re-dispatched.
 *
 * ONE, and only for a job whose child could not be verified. The approved plan's rule is "a dead or
 * unverifiable child is marked failed and may be retried once within the planning budget", and the
 * bound matters in both directions: a run whose machine is killing children would otherwise cycle
 * forever, and a contestant that returned a bad plan has had its turn — retrying THAT is not a
 * recovery, it is a second roll of the dice on the same question.
 */
export const MAX_JOB_RETRIES = 1;

/**
 * A deterministic job id.
 *
 * @param {'contestant'|'judge'|'synthesis'} kind
 * @param {string} [key] - the family, for the per-family kinds
 * @returns {string}
 */
export function jobId(kind, key) {
  return kind === 'synthesis' ? 'synthesis' : `${kind}:${key}`;
}

/**
 * Declare a set of jobs as `pending`.
 *
 * Existing job records with the same id are PRESERVED, not reset: a second call in the same run is a
 * resume re-declaring what it already knows, and overwriting a recorded pid with `pending` would erase
 * the only evidence that a child exists.
 *
 * @param {object} state
 * @param {{id: string, kind: string, key?: string|null, executor?: string|null,
 *          family?: string|null, tier?: string|null}[]} jobs
 * @returns {object} state
 */
export function declareJobs(state, jobs) {
  const planning = state.planning || {};
  const existing = planning.jobs && typeof planning.jobs === 'object' ? planning.jobs : {};
  /** @type {Record<string, object>} */
  const next = { ...existing };
  for (const job of jobs) {
    if (next[job.id]) continue;
    next[job.id] = {
      id: job.id,
      kind: job.kind,
      key: job.key ?? null,
      executor: job.executor ?? null,
      family: job.family ?? null,
      tier: job.tier ?? null,
      substate: 'pending',
      pid: null,
      session_id: null,
      hostname: null,
      dispatched_at: null,
      ended_at: null,
      outcome: null,
      error: null,
      retries: 0,
      // Set only when a resume proved the child unverifiable. A job that failed on its own merits is
      // not retryable, and the two must not be conflated — see MAX_JOB_RETRIES.
      retryable: false,
    };
  }
  state.planning = { ...planning, jobs: next };
  return state;
}

/**
 * Move a job to `dispatched` and record the pid that proves a child exists.
 *
 * @param {object} state
 * @param {string} id
 * @param {{pid?: number|null, hostname: string, at: string}} opts
 * @returns {object} state
 */
export function markDispatched(state, id, opts) {
  const job = jobOf(state, id);
  if (!job) return state;
  job.substate = 'dispatched';
  job.pid = opts.pid ?? null;
  job.hostname = opts.hostname;
  job.dispatched_at = opts.at;
  return state;
}

/**
 * Record a native session id, and note that the child is past start-up.
 *
 * @param {object} state
 * @param {string} id
 * @param {{session_id?: string|null}} opts
 * @returns {object} state
 */
export function markRunning(state, id, opts = {}) {
  const job = jobOf(state, id);
  if (!job) return state;
  if (job.substate === 'dispatched') job.substate = 'running';
  if (opts.session_id) job.session_id = opts.session_id;
  return state;
}

/**
 * Settle a job.
 *
 * @param {object} state
 * @param {string} id
 * @param {{substate: 'completed'|'failed'|'disqualified', outcome?: string|null,
 *          error?: string|null, at: string}} opts
 * @returns {object} state
 */
export function markTerminal(state, id, opts) {
  const job = jobOf(state, id);
  if (!job) return state;
  job.substate = TERMINAL_SUBSTATES.includes(opts.substate) ? opts.substate : 'failed';
  job.outcome = opts.outcome ?? null;
  job.error = opts.error ? String(opts.error).slice(0, 1024) : null;
  job.ended_at = opts.at;
  return state;
}

/**
 * Settle a job whose child could not be verified, and mark it retryable.
 *
 * Separate from `markTerminal` on purpose. This is the ONLY door to a retry, and it is opened by a
 * resume that proved a child dead — never by a job that finished and returned something unusable.
 *
 * @param {object} state
 * @param {string} id
 * @param {{reason: string, at: string}} opts
 * @returns {object} state
 */
export function markUnverifiable(state, id, opts) {
  const job = jobOf(state, id);
  if (!job) return state;
  job.substate = 'failed';
  job.outcome = 'unverifiable';
  job.error = String(opts.reason ?? '').slice(0, 1024);
  job.ended_at = opts.at;
  job.retryable = Number(job.retries ?? 0) < MAX_JOB_RETRIES;
  return state;
}

/**
 * Re-open a job as `pending`, spending one retry — or refuse, because the budget is gone.
 *
 * The bound is enforced HERE rather than at each call site, and it is the only accounting for a
 * re-dispatch. Both routes to one pass through it: a resume that proved the child dead, and a job the
 * ledger calls settled whose artifact is not on disk. The second one is easy to miss, and missing it
 * is unbounded: a run whose candidate file keeps vanishing would re-dispatch on every resume forever.
 *
 * The pid, session id and timestamps are CLEARED. Leaving a dead pid on a job that is about to be
 * dispatched again would make the next resume classify the new child by the old child's pid.
 *
 * @param {object} state
 * @param {string} id
 * @returns {boolean} whether the retry was granted
 */
export function spendRetry(state, id) {
  const job = jobOf(state, id);
  if (!job) return false;
  const spent = Number(job.retries ?? 0);
  if (spent >= MAX_JOB_RETRIES) return false;
  job.retries = spent + 1;
  job.retryable = false;
  job.substate = 'pending';
  job.pid = null;
  job.session_id = null;
  job.hostname = null;
  job.dispatched_at = null;
  job.ended_at = null;
  job.outcome = null;
  job.error = null;
  return true;
}

/**
 * What a resume should do with one job.
 *
 * The whole point of the ledger, expressed as one decision so `contest.mjs` and `resume.mjs` cannot
 * disagree about it:
 *
 *   * `fold`      — terminal and settled. Its artifact is on disk and is read, once, by job id.
 *   * `dispatch`  — never spawned, or a proven-dead child with a retry left. Safe to run.
 *   * `observe`   — a child may still be alive. NOTHING happens; the caller reports and stops.
 *
 * @param {object|null} job
 * @returns {'fold'|'dispatch'|'observe'}
 */
export function resumeDisposition(job) {
  if (!job) return 'dispatch';
  if (job.substate === 'pending') return 'dispatch';
  if (!TERMINAL_SUBSTATES.includes(job.substate)) return 'observe';
  if (job.retryable && Number(job.retries ?? 0) < MAX_JOB_RETRIES) return 'dispatch';
  return 'fold';
}

/** The mutable job record, or null. */
function jobOf(state, id) {
  const jobs = state.planning?.jobs;
  return jobs && typeof jobs === 'object' ? (jobs[id] ?? null) : null;
}

/**
 * One job record by id, read-only.
 *
 * @param {object} state
 * @param {string} id
 * @returns {object|null}
 */
export function jobRecord(state, id) {
  const job = jobOf(state, id);
  return job ? { ...job } : null;
}

/**
 * Every job whose fate is not yet known.
 *
 * @param {object} state
 * @returns {object[]}
 */
export function unfinishedJobs(state) {
  const jobs = state.planning?.jobs;
  if (!jobs || typeof jobs !== 'object') return [];
  return Object.values(jobs).filter((j) => !TERMINAL_SUBSTATES.includes(j.substate));
}

/**
 * Classify every unfinished planning job for a resume.
 *
 * Same conservative ladder the node loop uses, and for the same reason: a job that cannot be PROVEN
 * dead is never re-dispatched. `pending` is the one case that is safe to re-run — the ledger says no
 * child was ever spawned for it, and the pid field being null is corroborating rather than the sole
 * evidence.
 *
 * @param {object} state
 * @param {{hostname: string, aliveCheck: (pid: number) => boolean}} opts
 * @returns {{id: string, verdict: 'live'|'dead'|'unknown'|'never-dispatched', reason: string}[]}
 */
export function classifyPlanningJobs(state, opts) {
  return unfinishedJobs(state).map((job) => {
    if (job.substate === 'pending') {
      return {
        id: job.id,
        verdict: 'never-dispatched',
        reason: 'the ledger recorded the intent but no child was ever spawned, so re-running it '
          + 'cannot duplicate anything',
      };
    }
    if (job.hostname && job.hostname !== opts.hostname) {
      return {
        id: job.id,
        verdict: 'unknown',
        reason: `dispatched on host '${job.hostname}', and a pid on another host cannot be judged `
          + 'from here',
      };
    }
    if (job.pid === null) {
      return {
        id: job.id,
        verdict: 'unknown',
        reason: 'recorded as dispatched with no pid — it either died between the record and the spawn '
          + 'or the pid was never reported, and the two are not distinguishable',
      };
    }
    if (opts.aliveCheck(job.pid)) {
      return { id: job.id, verdict: 'live', reason: `pid ${job.pid} is still running on this host` };
    }
    return {
      id: job.id,
      verdict: 'dead',
      reason: `pid ${job.pid} is gone and the job recorded no terminal outcome, so what it produced `
        + 'is unknown',
    };
  });
}

/**
 * A one-line summary per job, for `status` and the report.
 *
 * @param {object} state
 * @returns {string[]}
 */
export function describeJobs(state) {
  const jobs = state.planning?.jobs;
  if (!jobs || typeof jobs !== 'object') return [];
  return Object.values(jobs)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((j) => `${j.id} — ${j.substate}${j.executor ? ` (${j.executor})` : ''}`
      + `${j.pid ? ` pid ${j.pid}` : ''}${Number(j.retries ?? 0) > 0 ? ` retry ${j.retries}` : ''}`
      + `${j.error ? `: ${j.error}` : ''}`);
}
