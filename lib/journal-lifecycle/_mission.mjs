// lib/journal-lifecycle/_mission.mjs
// L7 mission — the pure half: the event fold, the decider, and the readers.
// NOT a dispatchable verb (no VERBS entry); `mission.mjs` owns arguments and
// presentation, exactly the way thread.mjs sits on top of _threads.mjs.
//
// Why this layer exists at all: a persistent agent on a CLI with no session
// resume wakes COLD every time. Anything it "remembers" has to be re-derived
// from disk, so the disk needs to hold not just what happened but what to do
// next. Missions are that record, and `decideNext` is the one function allowed
// to answer "what next" — a memory-less wake obeys it instead of improvising.
//
// Three properties the callers depend on:
//
//   1. foldStatus and decideNext are PURE. No clock, no fs, no config: nowMs is
//      always a parameter (the discipline _routines.mjs uses for due-math). That
//      is what makes both of them testable by direct import and identical on
//      every machine.
//   2. The FOLD is the only source of current status. `mission.md` is immutable
//      after creation and carries `initial_status`, never `status`, so no reader
//      can mistake it for truth and no writer has to rewrite a file another
//      machine may own (projects/global/memory/journal-store-needs-node-partition).
//   3. Nothing here throws on bad input. A torn row, an unknown event type or a
//      step reference that names nothing is COUNTED and ignored — never fatal,
//      and never able to reorder a terminal transition.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  readJsonlDir,
  readEntry,
  filterIndex,
  expandLayout,
  toStoreRel,
  MISSION_MAX_STEP_ATTEMPTS,
} from './_shared.mjs';
import { readRootMessagingConfig } from '../agent-lifecycle/_bridge.mjs';

/** Statuses that end a mission. Once one is folded, it is sticky. */
const TERMINAL = new Set(['done', 'abandoned', 'rejected']);

/** Exactly one of these comes back from decideNext. */
export const NEXT_ACTIONS = [
  'verify_step',
  'resume_blocked',
  'close_mission',
  'execute_step',
  'plan_steps',
  'await_approval',
  'propose_goal',
  'consolidate_day',
  'idle',
];

/**
 * How long a `step.start` holds its step, in seconds, when nothing configures it.
 *
 * A step has no lock, only an attempt counter — so before this, two callers could
 * both stamp `step.start` on one step, take `attempts` 0→1→2, and leave the step
 * EXHAUSTED after a single real try (the mission then auto-blocks for a human).
 * The decider's "re-attach before re-sending" was advice printed to a model, not
 * a guard.
 *
 * There is no heartbeat and no renewal on purpose: the delegate kills a wake at
 * `--max-runtime`, so a `doing` step whose lease predates that is definitively
 * abandoned. The default is therefore the delegate's OWN default max-runtime, so
 * a lease can never expire while its wake could still be alive. Lower it in root
 * config (`agent_daemon.step_lease_seconds`) only alongside a lower --max-runtime.
 */
export const MISSION_STEP_LEASE_S = 3600;

/** doctor finding kinds that are standing work worth proposing as a next goal. */
const BACKLOG_KINDS = ['stale-issue', 'unpromoted-incident', 'undecided-improvement'];
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/**
 * Total order over event rows, computed identically on every machine.
 *
 * `ts` first (the human-meaningful order), then `node`, then `seq`. Node before
 * seq because seq is per-node and only comparable within one node — without the
 * node tie-break, two shards written in the same second would fold differently
 * depending on which file was read first.
 */
function compareRows(a, b) {
  const t = String(a.ts).localeCompare(String(b.ts));
  if (t !== 0) return t;
  const n = String(a.node ?? '').localeCompare(String(b.node ?? ''));
  if (n !== 0) return n;
  const sa = Number.isFinite(a.seq) ? a.seq : 0;
  const sb = Number.isFinite(b.seq) ? b.seq : 0;
  if (sa !== sb) return sa - sb;
  return String(a.type ?? '').localeCompare(String(b.type ?? ''));
}

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function usableRow(row) {
  return !!row
    && typeof row === 'object'
    && typeof row.type === 'string'
    && TS_RE.test(String(row.ts ?? ''));
}

function flatData(row) {
  const d = row && typeof row.data === 'object' && row.data && !Array.isArray(row.data) ? row.data : {};
  return d;
}

function blankState() {
  return {
    status: 'proposed',
    status_ts: null,
    proposed_at: null,
    approved_at: null,
    started_at: null,
    closed_at: null,
    outcome: '',
    summary: '',
    blocked_reason: '',
    pending_question: null,
    last_ask_ts: null,
    // Answers to a definition-of-done decision. `close_approved` means the human
    // said "yes, retire it"; `replan_requested` means they said "not done yet,
    // keep going" — which is the ONLY thing that lets a non-standing mission
    // re-enter plan_steps after its batch ran dry. Both are cleared by the next
    // step.add, so one answer governs one round and never leaks into the next.
    close_approved: false,
    replan_requested: false,
    steps: [],
    counts: { total: 0, pending: 0, doing: 0, done_unverified: 0, verified: 0, dropped: 0 },
    last_activity_ts: null,
    event_count: 0,
    ignored_rows: 0,
    step_id_conflicts: 0,
    after_close: false,
    torn_rows: 0,
    declaration: null,
  };
}

/**
 * Fold every event row for ONE mission into its current state.
 *
 * PURE: no clock, no fs, no config. Deterministic regardless of the order the
 * shards were read in — the caller may hand rows over in any sequence.
 *
 * @param {object[]} rows - raw event rows from events/<node>.jsonl shards
 * @param {{torn?: number}} [meta] - torn-line count from the reader
 * @returns {object} the folded state
 */
export function foldStatus(rows, meta = {}) {
  const st = blankState();
  st.torn_rows = Number.isFinite(meta.torn) ? meta.torn : 0;

  const list = Array.isArray(rows) ? rows : [];
  const usable = [];
  for (const row of list) {
    st.event_count += 1;
    if (usableRow(row)) usable.push(row);
    else st.ignored_rows += 1;
  }
  usable.sort(compareRows);

  const byId = new Map();

  for (const row of usable) {
    const type = String(row.type);
    const ts = String(row.ts);
    const data = flatData(row);

    // Terminal is sticky. A clock-skewed node appending a stale `start` must
    // never resurrect finished work, so after a close only the activity stamp
    // moves and the mission is flagged so doctor can say so.
    if (TERMINAL.has(st.status)) {
      st.after_close = true;
      st.last_activity_ts = ts;
      continue;
    }

    st.last_activity_ts = ts;

    switch (type) {
      case 'declaration.bind': {
        // A declaration bind is an immutable provenance assertion.  A second
        // row is intentionally retained as a conflict: callers must refuse
        // rather than choosing whichever shard happened to win the read.
        const bind = {
          ref: String(data.declaration_ref ?? ''),
          slug: String(data.slug ?? ''),
          fingerprint: String(data.fingerprint ?? ''),
          revision: Number(data.revision ?? 0),
          adopted: data.adopted === true,
          dod_checks: Array.isArray(data.dod_checks) ? data.dod_checks.map(String) : [],
          ts,
        };
        if (!bind.ref || !bind.slug || !/^[a-f0-9]{64}$/.test(bind.fingerprint) || bind.revision !== 1) {
          st.ignored_rows += 1;
        } else if (st.declaration) {
          st.declaration.conflict = true;
        } else {
          st.declaration = bind;
        }
        break;
      }
      case 'propose':
        st.status = 'proposed';
        st.status_ts = ts;
        st.proposed_at = ts;
        break;
      case 'approve':
        st.status = 'approved';
        st.status_ts = ts;
        st.approved_at = ts;
        st.pending_question = null;
        break;
      case 'reject':
        st.status = 'rejected';
        st.status_ts = ts;
        st.closed_at = ts;
        st.outcome = 'rejected';
        st.summary = String(data.reason ?? row.note ?? '');
        st.pending_question = null;
        break;
      case 'start':
        st.status = 'active';
        st.status_ts = ts;
        st.started_at = st.started_at || ts;
        break;
      case 'block':
        st.status = 'blocked';
        st.status_ts = ts;
        st.blocked_reason = String(data.reason ?? row.note ?? '');
        break;
      case 'unblock':
        st.status = 'active';
        st.status_ts = ts;
        st.blocked_reason = '';
        st.pending_question = null;
        break;
      case 'ask':
        st.pending_question = { ts, text: String(data.question ?? row.note ?? ''), step: row.step ?? null };
        st.last_ask_ts = ts;
        break;
      case 'answer': {
        st.pending_question = null;
        // A human decision recorded against a mission. `close`/`continue` answer
        // a definition-of-done question; `release` lifts the gate on ONE named
        // step, which is the only way a gated step ever becomes executable —
        // approving a goal never releases a gate (hard rule 4), and neither does
        // releasing one step release any other.
        const resolution = String(data.resolution ?? '');
        if (resolution === 'close') st.close_approved = true;
        else if (resolution === 'continue') st.replan_requested = true;
        else if (resolution === 'release' && row.step) {
          const step = byId.get(String(row.step));
          if (step) {
            step.gate = '';
            step.updated_ts = ts;
          } else {
            st.ignored_rows += 1;
          }
        }
        break;
      }
      case 'close':
        st.status = data.outcome === 'abandoned' ? 'abandoned' : 'done';
        st.status_ts = ts;
        st.closed_at = ts;
        st.outcome = st.status;
        st.summary = String(data.summary ?? row.note ?? '');
        st.pending_question = null;
        break;
      case 'note':
        break;
      case 'step.add': {
        const id = String(row.step ?? '');
        if (!id) { st.ignored_rows += 1; break; }
        if (byId.has(id)) { st.step_id_conflicts += 1; break; }
        const step = {
          id,
          title: String(data.title ?? ''),
          state: 'pending',
          verified: false,
          lane: String(data.lane ?? ''),
          gate: String(data.gate ?? ''),
          acceptance: String(data.acceptance ?? ''),
          evidence: '',
          last_fail: '',
          attempts: 0,
          // Lease: who is executing this step right now, and since when. Set by
          // step.start, cleared by step.done / step.verify / step.drop.
          owner: '',
          started_ts: '',
          updated_ts: ts,
        };
        const after = String(data.after ?? '');
        const at = after ? st.steps.findIndex((s) => s.id === after) : -1;
        if (at >= 0) st.steps.splice(at + 1, 0, step);
        else st.steps.push(step);
        byId.set(id, step);
        // A new step answers the "is this done?" question by itself, so both
        // definition-of-done answers expire here. Without this, one `continue`
        // would keep re-entering plan_steps forever and one `close` approval
        // would still be armed against a mission that has since grown work.
        st.replan_requested = false;
        st.close_approved = false;
        break;
      }
      case 'step.drop':
      case 'step.start':
      case 'step.done':
      case 'step.verify': {
        const step = byId.get(String(row.step ?? ''));
        if (!step) { st.ignored_rows += 1; break; }
        step.updated_ts = ts;
        if (type === 'step.drop') {
          step.state = 'dropped';
          step.owner = '';
          step.started_ts = '';
        } else if (type === 'step.start') {
          const owner = String(data.owner ?? '');
          // A RE-ATTACH by the same owner does not spend an attempt. The counter
          // exists to bound how many times a step is genuinely TRIED, and a wake
          // resuming its own interrupted step is still the first try — charging it
          // again is how a single crash used to exhaust both attempts and block
          // the mission for a human who had seen nothing fail.
          const reattach = step.state === 'doing' && owner !== '' && owner === step.owner;
          step.state = 'doing';
          if (!reattach) step.attempts += 1;
          if (owner) step.owner = owner;
          if (!reattach || !step.started_ts) step.started_ts = ts;
          if (data.lane) step.lane = String(data.lane);
          if (data.ref) step.ref = String(data.ref);
        } else if (type === 'step.done') {
          step.state = 'done';
          step.verified = false;
          step.owner = '';
          step.started_ts = '';
          if (data.evidence) step.evidence = String(data.evidence);
        } else if (data.verdict === 'pass') {
          step.state = 'verified';
          step.verified = true;
          step.last_fail = '';
          step.owner = '';
          step.started_ts = '';
          if (data.evidence) step.evidence = String(data.evidence);
        } else {
          // A failed verification is not a new kind of thing — it is the step not
          // being done. Back to `doing`, carrying the verdict that must inform
          // the next attempt.
          step.state = 'doing';
          step.verified = false;
          step.last_fail = String(data.reason ?? row.note ?? 'rejected');
          // The previous executor is finished with it either way — the next
          // attempt claims the lease fresh.
          step.owner = '';
          step.started_ts = '';
        }
        break;
      }
      default:
        // Unknown type: counted, ignored, never fatal. Forward compatibility is
        // the point — an older clone must survive a newer event vocabulary.
        st.ignored_rows += 1;
        break;
    }
  }

  st.steps.forEach((s, i) => { s.order = i + 1; });
  st.counts = {
    total: st.steps.length,
    pending: st.steps.filter((s) => s.state === 'pending').length,
    doing: st.steps.filter((s) => s.state === 'doing').length,
    done_unverified: st.steps.filter((s) => s.state === 'done').length,
    verified: st.steps.filter((s) => s.state === 'verified').length,
    dropped: st.steps.filter((s) => s.state === 'dropped').length,
  };
  return st;
}

/** The next free step id for a folded state. Never renumbers an existing one. */
export function nextStepId(state) {
  let max = 0;
  for (const s of state?.steps ?? []) {
    const n = Number(String(s.id).slice(1));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `s${max + 1}`;
}

/** Live = not finished. The set the decider and the active-mission cap look at. */
export function isLive(status) {
  return status === 'approved' || status === 'active' || status === 'blocked';
}

/**
 * The lease state of a step, as a pure function of the step, the clock and the
 * TTL — so both the write path and the decider reach the same verdict without
 * either of them owning a clock.
 *
 *   'free'   nobody holds it (not `doing`, or `doing` with no recorded owner —
 *            the pre-lease shape every existing mission carries)
 *   'held'   an owner claimed it within the TTL: a second executor must NOT
 *            start it
 *   'stale'  the lease predates the TTL, so its wake cannot still be alive
 *            (the delegate kills at --max-runtime) — claimable again
 *
 * @param {object} step
 * @param {number} nowMs
 * @param {number} ttlMs
 * @returns {'free'|'held'|'stale'}
 */
export function stepLeaseState(step, nowMs, ttlMs) {
  if (!step || step.state !== 'doing') return 'free';
  const owner = String(step.owner ?? '');
  if (!owner) return 'free';
  const since = Date.parse(String(step.started_ts ?? ''));
  if (!Number.isFinite(since)) return 'free';
  return (nowMs - since) <= ttlMs ? 'held' : 'stale';
}

/**
 * The step lease TTL in ms, from root config with a documented default. Read
 * here rather than in the caller so the write path and the decider cannot drift.
 */
export function stepLeaseTtlMs(repoRoot) {
  let raw = 0;
  try {
    const block = readRootMessagingConfig(repoRoot).agent_daemon || {};
    const defaults = (block.defaults && typeof block.defaults === 'object') ? block.defaults : {};
    raw = Number(defaults.step_lease_seconds ?? 0);
  } catch {
    raw = 0;
  }
  const secs = Number.isFinite(raw) && raw > 0 ? raw : MISSION_STEP_LEASE_S;
  return secs * 1000;
}

// ---------------------------------------------------------------------------
// The decider
// ---------------------------------------------------------------------------

function hoursSince(ts, nowMs) {
  const t = Date.parse(String(ts ?? ''));
  if (!Number.isFinite(t)) return Infinity;
  return (nowMs - t) / 3_600_000;
}

function missionBrief(m) {
  return {
    id: m.id,
    title: m.title,
    status: m.status,
    path: m.path,
    dir: m.dir,
    progress: { ...m.counts },
  };
}

function stepBrief(s) {
  if (!s) return null;
  return {
    id: s.id,
    title: s.title,
    state: s.state,
    verified: !!s.verified,
    lane: s.lane || '',
    gate: s.gate || '',
    acceptance: s.acceptance || '',
    evidence: s.evidence || '',
    attempts: s.attempts || 0,
    last_fail: s.last_fail || '',
    owner: s.owner || '',
    started_ts: s.started_ts || '',
  };
}

/** Order live missions so nothing starves: priority, then how long it has waited. */
function byUrgency(a, b) {
  const pa = Number.isFinite(a.priority) ? a.priority : 3;
  const pb = Number.isFinite(b.priority) ? b.priority : 3;
  if (pa !== pb) return pa - pb;
  const ta = String(a.status_ts ?? '');
  const tb = String(b.status_ts ?? '');
  if (ta !== tb) return ta.localeCompare(tb);
  return String(a.id).localeCompare(String(b.id));
}

/**
 * The moment that last spent the user's attention: any question asked, any
 * proposal still waiting, any rejection they just made.
 *
 * The rejection clause is the important half. Rung 5 only covers UNANSWERED
 * proposals, so without it the very next wake after a "no" would propose again —
 * precisely the nagging this cooldown exists to stop.
 */
function lastAskMs(missions) {
  let best = null;
  for (const m of missions) {
    const stamps = [m.last_ask_ts];
    if (m.status === 'proposed') stamps.push(m.proposed_at || m.status_ts);
    if (m.status === 'rejected') stamps.push(m.closed_at || m.status_ts);
    for (const s of stamps) {
      const t = Date.parse(String(s ?? ''));
      if (Number.isFinite(t) && (best === null || t > best)) best = t;
    }
  }
  return best;
}

/** Rank doctor findings into proposal candidates. Non-standing kinds are dropped. */
export function rankBacklog(findings) {
  return (Array.isArray(findings) ? findings : [])
    .filter((f) => f && BACKLOG_KINDS.includes(f.kind) && f.ref)
    .sort((a, b) => {
      const sa = SEVERITY_RANK[a.severity] ?? 3;
      const sb = SEVERITY_RANK[b.severity] ?? 3;
      if (sa !== sb) return sa - sb;
      return String(a.ref).localeCompare(String(b.ref));
    });
}

function diaryHourPassed(nowMs, diaryAt, tzOffsetMinutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(diaryAt ?? ''));
  if (!m) return true;
  const shifted = new Date(nowMs + (Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 420) * 60_000);
  const mins = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return mins >= Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Choose EXACTLY ONE next action for one agent.
 *
 * PURE over its arguments — the caller reads the store, runs doctor and reads the
 * clock, then passes all three in. That is what lets a test pin a decision
 * without a filesystem, and what stops orientation from becoming a write.
 *
 * The ladder, first match wins:
 *
 *   1 verify_step      an active mission's first done-but-unverified step
 *   2 resume_blocked   blocked with no open question, or past block_retry_hours
 *   3 execute_step     'doing' before 'pending'  (never a gated step)
 *   4 plan_steps       approved/active with no live steps
 *   5 await_approval   anything proposed, gated, or waiting on an answer
 *   6 propose_goal     cooldown clear, candidate from the inherited backlog
 *   7 consolidate_day  past the diary hour with no diary written today
 *   8 idle
 *
 * Rung 1 outranks rung 3 on purpose: the failure this layer exists to prevent is
 * an unverified done-claim reaching the user, and a deferred verification is a
 * claim already made. Verification is also the cheaper action with the larger
 * information gain — it either banks the progress or reveals the step was never
 * done.
 *
 * Rung 5 above rung 6 IS the anti-nag guarantee, and it is structural rather
 * than a flag: while anything is outstanding, a proposal is unreachable.
 *
 * A `standing` mission is the one exception at rung 4: instead of requiring
 * "never planned yet", it re-enters `plan_steps` every time its current batch
 * of steps has all verified or dropped (zero pending/doing left) — so it keeps
 * self-planning the next batch toward the SAME goal indefinitely rather than
 * ever falling through to rung 6's propose_goal.
 *
 * @param {{missions: object[], backlog?: object[], nowMs: number, opts?: object}} input
 * @returns {object} the action (every key always present)
 */
export function decideNext({ missions = [], backlog = [], nowMs = 0, opts = {} } = {}) {
  const suppressed = [];
  const cooldownH = Number.isFinite(opts.cooldownH) ? opts.cooldownH : 24;
  const blockRetryH = Number.isFinite(opts.blockRetryH) ? opts.blockRetryH : 48;
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : MISSION_MAX_STEP_ATTEMPTS;
  const leaseTtlMs = Number.isFinite(opts.leaseTtlMs) ? opts.leaseTtlMs : MISSION_STEP_LEASE_S * 1000;

  const live = missions.filter((m) => isLive(m.status)).sort(byUrgency);
  const active = live.filter((m) => m.status === 'active');

  const act = (action, extra) => ({
    action,
    reason: '',
    mission: null,
    step: null,
    command: '',
    on_done: '',
    suppressed,
    ...extra,
  });

  if (opts.mode === 'consolidate') {
    return act('consolidate_day', {
      reason: 'consolidate mode: harvest the day regardless of pending work',
      command: `node bin/sidekicks journal diary write ${opts.agent ?? '<agent>'} --from-buffer`,
    });
  }

  // 1 — verify before you build.
  for (const m of active) {
    const step = m.steps.find((s) => s.state === 'done' && !s.verified);
    if (!step) continue;
    return act('verify_step', {
      reason: `${m.id} step ${step.id} is done but unverified since ${step.updated_ts}`,
      mission: missionBrief(m),
      step: stepBrief(step),
      command: `node bin/sidekicks journal mission verify ${m.id} --step ${step.id} --verdict pass|fail --evidence=<path>`,
      on_done: `node bin/sidekicks journal mission next ${m.agent} --json`,
    });
  }

  // 2 — unblock before you start anything new.
  for (const m of live.filter((x) => x.status === 'blocked')) {
    const q = m.pending_question;
    if (q && hoursSince(q.ts, nowMs) < blockRetryH) {
      suppressed.push({
        action: 'resume_blocked',
        why: `${m.id} is waiting on an answer asked ${q.ts} (${blockRetryH}h retry window not elapsed)`,
      });
      continue;
    }
    return act('resume_blocked', {
      reason: q
        ? `${m.id} has been blocked past the ${blockRetryH}h retry window — work around the blocker or escalate once`
        : `${m.id} is blocked with no open question: ${m.blocked_reason || 'reason not recorded'}`,
      mission: missionBrief(m),
      command: `node bin/sidekicks journal mission event ${m.id} --type unblock --note=<what changed>`,
      on_done: `node bin/sidekicks journal mission next ${m.agent} --json`,
    });
  }

  // 2.5 — retire finished work before starting new work. A NON-standing mission
  // whose every step is verified or dropped used to fall silently out of the
  // ladder while still occupying one of the agent's live-mission slots: the
  // definition of done was prose nobody read, so nothing ever closed it.
  //
  // This rung is a two-step conversation, never a self-certification (hard rule
  // 7 — the lane that produced an artifact never grades it):
  //   first pass  → an INDEPENDENT verifier grades the recorded DoD, then ONE
  //                 chat signal offers `<id> close` / `<id> continue`, and the
  //                 wake exits. `pending_question` then pins the mission to the
  //                 anti-nag rung below, so it is asked exactly once.
  //   second pass → the human answered `close`, so the close actually runs.
  // A `continue` answer sets replan_requested instead, which is what lets rung 4
  // plan another batch (see there).
  //
  // Standing missions are excluded by definition: they have no terminal DoD, and
  // rung 4 already re-plans them forever.
  for (const m of live.filter((x) => x.status === 'active' && !x.standing)) {
    const everPlanned = m.counts.total - m.counts.dropped > 0;
    const liveSteps = m.counts.pending + m.counts.doing;
    if (!everPlanned || liveSteps > 0) continue;
    if (m.counts.done_unverified > 0) continue; // rung 1 owns that
    if (m.replan_requested) {
      suppressed.push({
        action: 'close_mission',
        why: `${m.id} — the user answered 'continue', so plan the next batch instead of re-asking`,
      });
      continue;
    }
    if (m.pending_question) {
      // Already asked. Rung 5 reports the wait; asking twice is the nag this
      // ladder is shaped to make impossible.
      continue;
    }
    if (m.close_approved) {
      return act('close_mission', {
        reason: `${m.id} — the user approved the close; record the outcome and retire the mission`,
        mission: missionBrief(m),
        command: `node bin/sidekicks journal mission close ${m.id} --outcome done --summary=<what shipped, in one line>`,
        on_done: `node bin/sidekicks journal mission next ${m.agent} --json`,
      });
    }
    const agent = m.agent ?? opts.agent ?? '<agent>';
    const on_done = opts.relay
      ? `node bin/sidekicks agent send ${opts.relay} --from ${agent} --kind signal --origin=none --options "${m.id} close;${m.id} continue"`
      : `node bin/sidekicks agent complete ${agent} <this message id> --status done --summary "${m.id} DoD reached — reply '${m.id} close' to retire it" --option "${m.id} close" --option "${m.id} continue"`;
    return act('close_mission', {
      reason: `${m.id} has every step verified or dropped and is not standing — grade its definition of done (in ${m.path}) with an INDEPENDENT verifier, then ask the user once whether to close`,
      mission: missionBrief(m),
      command: `node bin/sidekicks journal mission event ${m.id} --type ask --question=<DoD verdict + close or continue?>`,
      on_done,
    });
  }

  // 3 — execute. 'doing' outranks 'pending' inside one mission: a step already
  // in flight is re-attached to, never duplicated.
  for (const m of active) {
    const live_steps = m.steps.filter((s) => s.state === 'doing' || s.state === 'pending');
    const step = live_steps.find((s) => s.state === 'doing') || live_steps[0];
    if (!step) continue;
    if (step.gate) {
      suppressed.push({
        action: 'execute_step',
        why: `${m.id} ${step.id} carries gate '${step.gate}' — a gated step is never executed by a scheduled tick`,
      });
      continue;
    }
    if (step.attempts >= maxAttempts) {
      suppressed.push({
        action: 'execute_step',
        why: `${m.id} ${step.id} has used its ${maxAttempts} attempts — it needs a human, not another try`,
      });
      continue;
    }
    // A live lease held by someone else is a hard stop, not advice: two executors
    // on one step take it from 0 to its 2-attempt bound in a single round and
    // block the mission for a human who saw nothing fail.
    const lease = stepLeaseState(step, nowMs, leaseTtlMs);
    if (lease === 'held' && String(step.owner) !== String(opts.owner ?? '')) {
      suppressed.push({
        action: 'execute_step',
        why: `${m.id} ${step.id} is held by ${step.owner} since ${step.started_ts} — a second executor never starts a leased step`,
      });
      continue;
    }
    return act('execute_step', {
      reason: step.state === 'doing'
        ? (lease === 'stale'
          ? `${m.id} step ${step.id} was left in flight by ${step.owner || 'an unknown owner'} at ${step.started_ts || 'an unrecorded time'} and its lease has expired — re-attach, do not re-send`
          : `${m.id} step ${step.id} is already in flight (attempt ${step.attempts}) — re-attach before re-sending`)
        : `${m.id} step ${step.id} is the next unstarted step`,
      mission: missionBrief(m),
      step: stepBrief(step),
      command: `node bin/sidekicks journal mission event ${m.id} --type step.start --step ${step.id} --note=<lane and target>`,
      on_done: `node bin/sidekicks journal mission event ${m.id} --type step.done --step ${step.id} --evidence=<path>`,
    });
  }

  // 4 — a mission with no live steps cannot be executed; plan it. A standing
  // mission also re-enters here once its current batch has all verified/dropped
  // (zero pending/doing), even though it already has steps on record — that is
  // what keeps it self-planning the SAME goal forever instead of ever reaching
  // rung 6's propose_goal.
  for (const m of live.filter((x) => x.status === 'approved' || x.status === 'active')) {
    const hasEverPlanned = m.counts.total - m.counts.dropped > 0;
    const liveStepCount = m.counts.pending + m.counts.doing;
    // A `continue` answer to a definition-of-done question is the non-standing
    // equivalent of `standing`, for exactly one batch: the user said the goal is
    // not met yet, so the mission plans again instead of sitting finished-but-open.
    const needsPlan = m.standing
      ? liveStepCount === 0
      : (!hasEverPlanned || (m.replan_requested && liveStepCount === 0));
    if (!needsPlan) continue;
    return act('plan_steps', {
      reason: m.standing && hasEverPlanned
        ? `${m.id} is standing and has run its current step batch dry (all verified/dropped) — self-plan the next batch toward the same goal`
        : m.replan_requested
          ? `${m.id} — the user answered 'continue' on its definition of done: plan the next batch toward the same goal`
          : `${m.id} is ${m.status} with no live steps`,
      mission: missionBrief(m),
      command: `node bin/sidekicks journal mission plan ${m.id} --step=<title> --lane <lane> [--gate <kind>] --acceptance=<criteria>`,
      on_done: `node bin/sidekicks journal mission next ${m.agent} --json`,
    });
  }

  // 5 — the anti-nag rung. Deliberately above propose_goal.
  const waiting = missions
    .filter((m) => m.status === 'proposed' || (isLive(m.status) && m.pending_question))
    .sort((a, b) => String(a.status_ts ?? '').localeCompare(String(b.status_ts ?? '')));
  if (waiting.length) {
    const m = waiting[0];
    const asked = m.pending_question ? m.pending_question.ts : (m.proposed_at || m.status_ts);
    return act('await_approval', {
      reason: `${m.id} is waiting on the user since ${asked} (${Math.floor(hoursSince(asked, nowMs))}h) — ask nothing, post nothing`,
      mission: missionBrief(m),
      step: m.pending_question?.step ? stepBrief(m.steps.find((s) => s.id === m.pending_question.step)) : null,
      command: `node bin/sidekicks journal mission show ${m.id} --json`,
    });
  }

  // 6 — propose the next goal, rate-limited and de-duplicated for good.
  const last = lastAskMs(missions);
  const elapsed = last === null ? Infinity : (nowMs - last) / 3_600_000;
  if (elapsed < cooldownH) {
    suppressed.push({
      action: 'propose_goal',
      why: `cooldown — the user was last asked ${Math.floor(elapsed)}h ago of ${cooldownH}h`,
    });
  } else {
    const seen = new Set();
    for (const m of missions) for (const r of m.related ?? []) seen.add(String(r));
    const candidates = rankBacklog(backlog);
    const pick = candidates.find((c) => !seen.has(String(c.ref)));
    for (const c of candidates) {
      if (seen.has(String(c.ref))) {
        suppressed.push({ action: 'propose_goal', why: `${c.ref} is already carried by a mission — never proposed twice` });
      }
    }
    if (pick) {
      const agent = opts.agent ?? '<agent>';
      // How the proposal reaches the human depends on whether this agent HAS a
      // chat surface. With a relay mailbox it is a signal with tap-buttons; with
      // none, the only channel back is the completion reply of the message that
      // woke this session — so say that instead of naming a mailbox that would
      // silently swallow the post.
      const on_done = opts.relay
        ? `node bin/sidekicks agent send ${opts.relay} --from ${agent} --kind signal --origin=none --options "<MIS-id> accept;<MIS-id> revise;<MIS-id> shelve"`
        : `node bin/sidekicks agent complete ${agent} <this message id> --status done --summary "<MIS-id> proposed — reply '<MIS-id> accept' to approve" --option "<MIS-id> accept" --option "<MIS-id> shelve"`;
      return act('propose_goal', {
        reason: `no live mission; the highest-ranked inherited backlog item is ${pick.ref} (${pick.kind}, ${pick.severity})`,
        command: `node bin/sidekicks journal mission propose ${agent} --title=<goal> --why=<why now> --related ${pick.ref}`,
        on_done,
        step: null,
        mission: null,
        candidate: { ref: pick.ref, kind: pick.kind, severity: pick.severity, subject: pick.subject ?? '' },
      });
    }
  }

  // 7 — close the day out.
  if (!opts.diaryWrittenToday && diaryHourPassed(nowMs, opts.diaryAt, opts.tzOffsetMinutes)) {
    return act('consolidate_day', {
      reason: `past the ${opts.diaryAt ?? '18:00'} diary hour with no diary written today`,
      command: `node bin/sidekicks journal diary write ${opts.agent ?? '<agent>'} --from-buffer`,
    });
  }

  // 8 — the honest answer. Never fabricated work.
  return act('idle', { reason: 'no live mission, nothing to verify, nothing due — exit cheap' });
}

// ---------------------------------------------------------------------------
// Readers (impure — fs + config)
// ---------------------------------------------------------------------------

/**
 * The Telegram relay mailbox an agent's own lane posts through, or '' when it has
 * no chat surface at all.
 *
 * Resolved from the channel table, never guessed: the DEFAULT channel keeps the
 * bare `telegram` mailbox and a named lane gets `telegram-<lane id>` — which is
 * exactly why `telegram-<agent>` is the wrong guess. ethan is the default lane,
 * so its mailbox is `telegram`; angely has its own channel, so its mailbox is
 * `telegram-angely`. An agent with no channel row (a codex build agent, say) gets
 * '' and escalates through its completion reply instead of a chat post.
 *
 * Mirrors relayAgentFor() in telegram.mjs and relayAgentForDeliver() in
 * _routines.mjs. Never throws — an unreadable config means "no lane", not a
 * failed read.
 *
 * @returns {{mailbox: string, channel: string, chatOut: string}}
 */
export function resolveAgentLane(repoRoot, agent) {
  const none = { mailbox: '', channel: '', chatOut: '' };
  const name = String(agent ?? '');
  if (!name) return none;
  let tg;
  try {
    tg = readRootMessagingConfig(repoRoot).telegram || {};
  } catch {
    return none;
  }
  const channels = Array.isArray(tg.channels) ? tg.channels : [];
  const own = channels.find((c) => c && String(c.target ?? '') === name);
  if (own) {
    const id = String(own.id ?? '').trim();
    return {
      mailbox: own.default === true || id === '' ? 'telegram' : `telegram-${id}`,
      channel: id,
      chatOut: String(own.chat_out ?? own.chat ?? ''),
    };
  }
  // No row of its own: the table's fallback target still reaches the default lane.
  if (String(tg.default_target ?? '') === name) {
    const dflt = channels.find((c) => c && c.default === true);
    return {
      mailbox: 'telegram',
      channel: String(dflt?.id ?? ''),
      chatOut: String(dflt?.chat_out ?? tg.chat_id ?? ''),
    };
  }
  return none;
}

/** The absolute directory holding one mission's files. */
export function missionDirAbs(cfg, { agent, id, slug }) {
  return expandLayout(cfg, 'mission', { agent, id, slug });
}

/** Where THIS machine appends. One writer per file, enforced by the path. */
export function missionEventsShard(cfg, dirAbs, node) {
  return join(dirAbs, 'events', `${node}.jsonl`);
}

/** Read + union every event shard for one mission. */
export function readMissionEvents(cfg, dirAbs) {
  return readJsonlDir(join(dirAbs, 'events'));
}

/** The next seq for this node's shard: per-(mission,node) monotonic. */
export function nextSeqForNode(rows, node) {
  let max = 0;
  for (const r of rows) {
    if (String(r.node ?? '') !== node) continue;
    const n = Number(r.seq);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * Load one mission from an index row: frontmatter + folded state, normalized into
 * the shape decideNext consumes.
 *
 * @returns {object|null}
 */
export function loadMissionFromRow(cfg, row) {
  if (!row) return null;
  const entry = readEntry(cfg, row.path);
  const fm = entry?.frontmatter ?? {};
  // Derived from the recorded path, not from the entry: a mission whose
  // mission.md went missing still has its event history, and a doctor finding is
  // more useful than a silently empty fold.
  const dirAbs = join(cfg.storeRoot, String(row.path ?? ''), '..');
  const events = readMissionEvents(cfg, dirAbs);
  const state = foldStatus(events.rows, { torn: events.torn });
  return {
    id: String(row.id ?? fm.id ?? ''),
    agent: String(row.agent ?? fm.agent ?? ''),
    node: String(fm.node ?? ''),
    title: String(fm.title ?? row.title ?? ''),
    path: row.path,
    dir: toStoreRel(cfg, dirAbs),
    dirAbs,
    priority: Number.isFinite(Number(fm.priority)) ? Number(fm.priority) : 3,
    due: String(fm.due ?? ''),
    origin: String(fm.origin ?? ''),
    // Standing: this mission keeps re-entering rung 4 (plan_steps) forever once
    // its current batch of steps is all verified/dropped, instead of falling
    // through to propose_goal. Absent on every mission.md written before this
    // field existed, which is why the check is `=== true` — never `undefined`.
    standing: fm.standing === true,
    related: Array.isArray(fm.related) ? fm.related.map(String) : [],
    initial_status: String(fm.initial_status ?? ''),
    created_at: String(fm.created_at ?? row.ts ?? ''),
    // Immutable creation marker written only by `agent daemon reconcile`. It
    // identifies the mission a primary declaration opened, so an interrupted
    // reconcile rebinds that exact record instead of opening a second one.
    // Distinct from the folded `declaration` below, which is the bind EVENT.
    declaration_ref: String(fm.declaration_ref ?? ''),
    declaration_revision: Number.isFinite(Number(fm.declaration_revision)) ? Number(fm.declaration_revision) : 0,
    declaration_fingerprint: String(fm.declaration_fingerprint ?? ''),
    body: entry?.body ?? '',
    missing: !entry,
    shards: events.files,
    ...state,
  };
}

/** Every mission for an agent (or all agents when `agent` is absent). */
export function loadMissions(cfg, { agent } = {}) {
  return filterIndex(cfg, { kind: 'mission', agent: agent || undefined })
    .map((row) => loadMissionFromRow(cfg, row))
    .filter(Boolean);
}

/**
 * One mission by id, or null when the index does not know it.
 *
 * Case-insensitive: an id typed back from a chat client (or shouted) must reach
 * the same record — a false "no such mission" costs a round trip with a human.
 */
export function loadMission(cfg, id) {
  const want = String(id).toLowerCase();
  const row = filterIndex(cfg, { kind: 'mission' }).find((r) => String(r.id).toLowerCase() === want);
  return row ? loadMissionFromRow(cfg, row) : null;
}

/** Has a diary been written for this agent today? Feeds rung 7. */
export function diaryWrittenToday(cfg, agent, date) {
  const layer = cfg.layers.diary;
  if (!layer?.enabled) return true; // nothing to consolidate into
  const abs = expandLayout(cfg, 'diary', { agent, date });
  return existsSync(abs);
}

/**
 * Mission-shaped `journal doctor` findings.
 *
 * Lives here rather than in doctor.mjs so the dependency runs one way: doctor
 * imports these, decideNext takes findings as a PARAMETER and imports nothing —
 * which is what keeps the decider pure.
 *
 * @returns {{kind: string, severity: string, subject: string, fix: string, ref: string, agent: string}[]}
 */
export function missionFindings(cfg, { agent, nowMs = Date.now(), staleDays = 7 } = {}) {
  const out = [];
  for (const m of loadMissions(cfg, { agent })) {
    const push = (kind, severity, subject, fix) =>
      out.push({ kind, severity, subject, fix, ref: m.id, agent: m.agent });

    if (m.missing) {
      push('mission-missing-file', 'high',
        `${m.id} is in the index but ${m.path} is gone`,
        `sidekicks journal rebuild`);
      continue;
    }
    if (m.torn_rows > 0) {
      push('mission-torn-event', 'high',
        `${m.id} has ${m.torn_rows} unreadable event row(s)`,
        `sidekicks journal mission show ${m.id} --events`);
    }
    if (m.step_id_conflicts > 0) {
      push('mission-step-id-conflict', 'high',
        `${m.id} has ${m.step_id_conflicts} duplicate step id(s) — two nodes planned it concurrently`,
        `sidekicks journal mission show ${m.id} --events`);
    }
    if (!isLive(m.status)) {
      if (m.after_close) {
        push('mission-write-after-close', 'low',
          `${m.id} received events after it closed`,
          `sidekicks journal mission show ${m.id} --events`);
      }
      continue;
    }
    const unverified = m.steps.find((s) => s.state === 'done' && !s.verified);
    if (unverified && hoursSince(unverified.updated_ts, nowMs) > 24) {
      push('mission-unverified-step', 'medium',
        `${m.id} step ${unverified.id} has been done-but-unverified since ${unverified.updated_ts}`,
        `sidekicks journal mission verify ${m.id} --step ${unverified.id} --verdict pass|fail --evidence=<path>`);
    }
    if (m.counts.total - m.counts.dropped === 0) {
      push('mission-planless', 'low',
        `${m.id} is ${m.status} with no live steps`,
        `sidekicks journal mission plan ${m.id} --step=<title>`);
    }
    const idleH = hoursSince(m.last_activity_ts || m.created_at, nowMs);
    if (idleH > staleDays * 24) {
      push('mission-stalled', 'medium',
        `${m.id} has had no event for ${Math.floor(idleH / 24)} day(s)`,
        `sidekicks journal mission next ${m.agent} --json`);
    }
  }
  return out;
}
