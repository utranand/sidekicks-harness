// lib/goal-lifecycle/contest.mjs
// `goal plan --contest` — the highest eligible tier of every capable CLI family plans in parallel,
// each candidate is judged by a DIFFERENT family, and the winner is the base for one synthesis pass.
//
// WHY FAMILY, NOT EXECUTOR NAME. Two registrations of the same vendor CLI are not independent
// contestants, and a judge from the candidate's own family is grading its own house style. Nothing
// else in the executor registry can tell those apart — `kind`, `binary` and `transport` are happily
// identical across two aliases — so eligibility, one-seat-per-family selection and judge assignment
// are all decided on the canonical `family` value. A generic executor that has not declared one stays
// usable for ordinary work and is simply contest-ineligible.
//
// WHY "HIGHEST AVAILABLE" IS NOT A TIER DOWNGRADE. Everywhere else in this engine an unmapped tier
// fails closed, and that rule stands. The contest asks a different question: of the tiers this family
// HAS, which is the best one? Selecting `top` then `high` from what is mapped is a selection policy,
// not a substitution for a request that was made — and the resolved tier is recorded per candidate so
// the operator sees which seat ran on what.
//
// WHY PARALLEL IS SAFE HERE. Every contestant and judge runs in the plan/read-only profile, and only
// this parent process writes run state or artifacts. The children cannot race because they cannot
// write. That is also why the contest lives inside the `planning` phase rather than earning a
// state-machine phase of its own.
//
// WHY A SEPARATE SYNTHESIS PASS. A judge sees ONE candidate — it cannot know that a runner-up had a
// better idea, so asking it to name superior alternatives would be asking it to invent them. The
// comparison is a distinct session that reads the winner, the runner-up and both judge reports, and
// every graft it accepts or rejects is persisted with its rationale.
//
// AN INTERRUPTED CONTEST IS RESUMED, NOT RESTARTED. `input.resume` re-enters the SAME run: every job
// the ledger records as settled has its artifact FOLDED from disk by its deterministic id, and only
// the jobs that were never dispatched — or whose child a resume proved dead, once, within the retry
// bound — are dispatched again. Restarting instead would throw away work the operator paid for, and
// re-dispatching an unclassified job would risk two sessions doing the same thing; both are why the
// ledger records intent BEFORE the spawn. The fold is idempotent because the id is derived from the
// family rather than from a counter: the same run resumed twice folds the same artifacts.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { hostname } from 'node:os';
import { join } from 'node:path';
import { resolveFamily, highestMappedTier, roleSupported } from '../cli-executor-lifecycle/profiles.mjs';
import { canonicalPlan, planDigest } from './schema.mjs';
import {
  JUDGE_OUTPUT_SCHEMA,
  PLAN_OUTPUT_SCHEMA,
  buildPlannerPrompt,
  checkPlanDocument,
  describeExecutors,
  runPlanningSession,
  writeSchemaFile,
} from './planner.mjs';
import { mkdirp, readJsonIfPresent, writeJson } from './store.mjs';
import {
  declareJobs,
  jobId,
  jobRecord,
  markDispatched,
  markRunning,
  markTerminal,
  MAX_JOB_RETRIES,
  resumeDisposition,
  spendRetry,
} from './jobs.mjs';
import { invokeExecutor } from '../cli-executor-lifecycle/invoke.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { bangkokTimestamp } from '../run-events/store.mjs';

/** A contest needs at least two families that can cross-judge one another. */
export const MIN_CONTEST_FAMILIES = 2;

/**
 * This host's name, for the job ledger.
 *
 * Recorded per job so a resume on a DIFFERENT machine classifies the job as unknown rather than
 * checking a pid that means something else there.
 */
function hostnameOf() {
  try {
    return hostname();
  } catch {
    return 'unknown-host';
  }
}

/** Tier preference order. `high` is the floor — a family below it is ineligible. */
export const CONTEST_TIER_ORDER = Object.freeze(['top', 'high']);

/** The five rubric dimensions, weighted equally. Fixed, so scores are comparable across runs. */
export const RUBRIC_DIMENSIONS = Object.freeze([
  'goal_coverage',
  'criteria_testability',
  'risk_realism',
  'scope_discipline',
  'dependency_correctness',
]);

/**
 * Group the enabled executors into contest seats — one per canonical family.
 *
 * @param {{executors: Record<string, object>, prefer?: string[], only?: string[]|null}} input
 * @returns {{seats: object[], ineligible: {executor: string, reason: string}[]}}
 */
export function resolveSeats(input) {
  const prefer = input.prefer || [];
  /** @type {{executor: string, reason: string}[]} */
  const ineligible = [];
  /** @type {Map<string, object[]>} */
  const byFamily = new Map();

  const names = input.only ? input.only : Object.keys(input.executors).sort();
  for (const name of names) {
    const spec = input.executors[name];
    if (!spec) {
      ineligible.push({ executor: name, reason: 'not a registered executor' });
      continue;
    }
    if (spec.enabled === false) {
      ineligible.push({ executor: name, reason: 'disabled in this scope' });
      continue;
    }
    const support = roleSupported(name, spec, 'plan');
    if (!support.ok) {
      ineligible.push({ executor: name, reason: support.reason });
      continue;
    }
    const family = resolveFamily(name, spec);
    if (!family) {
      ineligible.push({
        executor: name,
        reason: 'declares no canonical family, so its independence cannot be established — register '
          + `one with 'cli-executor register ${name} --family <f>'`,
      });
      continue;
    }
    const tier = highestMappedTier(spec, CONTEST_TIER_ORDER);
    if (!tier) {
      ineligible.push({
        executor: name,
        reason: `maps no ${CONTEST_TIER_ORDER.join(' or ')} tier — high is the contest floor`,
      });
      continue;
    }
    const seat = {
      executor: name,
      spec,
      family,
      tier,
      model: spec.models[tier],
      // A fallback is worth reporting: a family that competed at `high` because it maps no `top` is
      // not the same evidence as one that competed at its best.
      tier_fallback: tier !== CONTEST_TIER_ORDER[0],
      priority: prefer.indexOf(name),
    };
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(seat);
  }

  // One seat per family: routing priority first, then executor name — a total, deterministic order.
  const seats = [...byFamily.entries()]
    .map(([, candidates]) => candidates.sort((a, b) => {
      const pa = a.priority === -1 ? Number.MAX_SAFE_INTEGER : a.priority;
      const pb = b.priority === -1 ? Number.MAX_SAFE_INTEGER : b.priority;
      if (pa !== pb) return pa - pb;
      return a.executor < b.executor ? -1 : 1;
    })[0])
    .sort((a, b) => (a.family < b.family ? -1 : 1));

  for (const [family, candidates] of byFamily) {
    for (const extra of candidates.slice(1)) {
      ineligible.push({
        executor: extra.executor,
        reason: `family '${family}' is already represented by '${candidates[0].executor}' — one seat `
          + 'per family, because two seats from one vendor are not independent',
      });
    }
  }

  return { seats, ineligible };
}

/**
 * Validate an explicit `--planners` selection before anything runs.
 *
 * @param {{names: string[], executors: Record<string, object>}} input
 * @returns {string[]} errors (empty when the selection is usable)
 */
export function validatePlannerSelection(input) {
  /** @type {string[]} */
  const errors = [];
  const seen = new Set();
  /** @type {Map<string, string>} */
  const families = new Map();

  for (const name of input.names) {
    if (seen.has(name)) {
      errors.push(`--planners lists '${name}' twice`);
      continue;
    }
    seen.add(name);
    const spec = input.executors[name];
    if (!spec) {
      errors.push(`--planners names '${name}', which is not a registered executor`);
      continue;
    }
    if (spec.enabled === false) {
      errors.push(`--planners names '${name}', which is disabled in this scope`);
      continue;
    }
    const support = roleSupported(name, spec, 'plan');
    if (!support.ok) {
      errors.push(`--planners names '${name}', which cannot plan: ${support.reason}`);
      continue;
    }
    const family = resolveFamily(name, spec);
    if (!family) {
      errors.push(
        `--planners names '${name}', which declares no canonical family — a contestant whose `
        + 'independence cannot be established is ineligible',
      );
      continue;
    }
    if (families.has(family)) {
      errors.push(
        `--planners names both '${families.get(family)}' and '${name}', which share family `
        + `'${family}' — two seats from one vendor are not independent contestants`,
      );
      continue;
    }
    families.set(family, name);
    if (!highestMappedTier(spec, CONTEST_TIER_ORDER)) {
      errors.push(
        `--planners names '${name}', which maps no ${CONTEST_TIER_ORDER.join(' or ')} tier — `
        + 'high is the contest floor',
      );
    }
  }

  if (errors.length === 0 && families.size < MIN_CONTEST_FAMILIES) {
    errors.push(
      `--planners resolves to ${families.size} eligible family/families; a contest needs at least `
      + `${MIN_CONTEST_FAMILIES} that can cross-judge one another`,
    );
  }
  return errors;
}

/**
 * Round-robin judge assignment: each candidate is scored by the NEXT family's seat.
 *
 * A rotation rather than a random pairing, because the assignment has to be reproducible from
 * `run.json` alone on a resume — and because a rotation guarantees no seat judges itself as long as
 * there are two or more of them.
 *
 * @param {object[]} candidates - surviving candidates, each with a `family`
 * @param {object[]} seats - all eligible seats
 * @returns {{candidate_family: string, judge_executor: string, judge_family: string,
 *            judge_tier: string, judge_spec: object}[]}
 */
export function assignJudges(candidates, seats) {
  const pool = seats.filter((s) => candidates.some((c) => c.family !== s.family));
  return candidates.map((candidate, i) => {
    const eligibleJudges = seats.filter((s) => s.family !== candidate.family);
    // Rotate the starting point by the candidate's index so judging load spreads evenly instead of
    // every candidate landing on the first alphabetical family.
    const judge = eligibleJudges[i % Math.max(1, eligibleJudges.length)] ?? pool[0];
    return {
      candidate_family: candidate.family,
      judge_executor: judge.executor,
      judge_family: judge.family,
      judge_tier: judge.tier,
      judge_spec: judge.spec,
    };
  });
}

/**
 * Strip everything that identifies a candidate's AUTHOR before a judge sees it.
 *
 * Judges are told the goal, the repository and one candidate. Leaving the executor names in the
 * routing fields would tell a judge which vendor wrote it, which is exactly the bias cross-family
 * judging exists to remove. The routing is restored from the stored candidate after scoring.
 *
 * @param {object} plan
 * @returns {object}
 */
export function anonymizeCandidate(plan) {
  const copy = canonicalPlan(plan);
  return {
    ...copy,
    nodes: copy.nodes.map((n) => {
      const { executor, tier, ...rest } = n;
      return rest;
    }),
  };
}

/**
 * The judging prompt: one candidate, a fixed rubric, no cross-candidate speculation.
 *
 * @param {{goal: string, candidateJson: string}} input
 * @returns {string}
 */
export function buildJudgePrompt(input) {
  const lines = [];
  lines.push('You are scoring ONE implementation plan in a READ-ONLY session. You did not write it,');
  lines.push('and you are not being shown any other plan. Return ONE JSON document matching the');
  lines.push('provided schema, and no prose outside it.');
  lines.push('');
  lines.push('## The goal the plan must serve');
  lines.push('');
  lines.push(input.goal);
  lines.push('');
  lines.push('## The candidate plan');
  lines.push('');
  lines.push('```json');
  lines.push(input.candidateJson);
  lines.push('```');
  lines.push('');
  lines.push('## Rubric — score each 0-5, and say why');
  lines.push('');
  lines.push('- goal_coverage: does the plan actually achieve the whole goal? Name what it misses.');
  lines.push('- criteria_testability: could YOU verify every acceptance criterion from files and');
  lines.push('  command output alone, without asking the implementer?');
  lines.push('- risk_realism: are the risks real for THIS repository, or generic filler?');
  lines.push('- scope_discipline: is anything in scope the goal did not ask for? Is out_of_scope honest?');
  lines.push('- dependency_correctness: does any node need something a later node produces?');
  lines.push('');
  lines.push('## Rules');
  lines.push('');
  lines.push('- Ground every score in the actual repository. Check that the paths and commands exist.');
  lines.push('- List concrete strengths and gaps. `notable_ideas` is for approaches in THIS plan worth');
  lines.push('  keeping — not guesses about what some other plan might have done. You cannot see any');
  lines.push('  other plan, so any comparison you make would be invented.');
  lines.push('- A 5 means you could hand this to an implementer as-is. Do not award it by default.');
  return lines.join('\n');
}

/**
 * The synthesis prompt: the winner is the base, and a graft has to earn its place.
 *
 * @param {{goal: string, winnerJson: string, runnerUpJson: string, winnerReport: object,
 *          runnerUpReport: object}} input
 * @returns {string}
 */
export function buildSynthesisPrompt(input) {
  const lines = [];
  lines.push('You are combining two independently written implementation plans in a READ-ONLY');
  lines.push('session. Plan A WON a scored comparison and is the base. Plan B is the runner-up.');
  lines.push('Return ONE JSON document matching the plan schema — the improved plan — and no prose');
  lines.push('outside it.');
  lines.push('');
  lines.push('## The goal');
  lines.push('');
  lines.push(input.goal);
  lines.push('');
  lines.push('## Plan A — the winner, and your base');
  lines.push('');
  lines.push('```json');
  lines.push(input.winnerJson);
  lines.push('```');
  lines.push('');
  lines.push('## Plan B — the runner-up');
  lines.push('');
  lines.push('```json');
  lines.push(input.runnerUpJson);
  lines.push('```');
  lines.push('');
  lines.push('## What the independent judges said');
  lines.push('');
  lines.push('Plan A:');
  lines.push(`  strengths: ${(input.winnerReport?.strengths || []).join('; ') || '(none listed)'}`);
  lines.push(`  gaps:      ${(input.winnerReport?.gaps || []).join('; ') || '(none listed)'}`);
  lines.push('Plan B:');
  lines.push(`  strengths: ${(input.runnerUpReport?.strengths || []).join('; ') || '(none listed)'}`);
  lines.push(`  gaps:      ${(input.runnerUpReport?.gaps || []).join('; ') || '(none listed)'}`);
  lines.push('');
  lines.push('## Rules — these are hard');
  lines.push('');
  lines.push('- Plan A is the base. Start from it and change as little as possible.');
  lines.push('- Take something from Plan B ONLY when it improves a named rubric dimension: goal');
  lines.push('  coverage, criteria testability, risk realism, scope discipline, or dependency');
  lines.push('  correctness. "Also reasonable" is not a reason.');
  lines.push('- Do NOT widen the scope. Same goal, same target, same write footprint. If Plan B does');
  lines.push('  more than the goal asked for, that is a reason to reject its extra work, not to adopt');
  lines.push('  it.');
  lines.push('- Keep Plan A\'s node ids and criterion ids wherever the node survives. A renumbered');
  lines.push('  plan cannot be compared to the one that was judged.');
  lines.push('- If Plan B has nothing worth taking, return Plan A unchanged. That is a valid outcome.');
  return lines.join('\n');
}

/**
 * Total a judge's rubric scores.
 *
 * @param {object} report
 * @returns {number|null} null when the report is unusable
 */
export function totalScore(report) {
  const scores = report?.scores;
  if (!scores || typeof scores !== 'object') return null;
  let total = 0;
  for (const dim of RUBRIC_DIMENSIONS) {
    const value = scores[dim]?.score;
    if (!Number.isInteger(value)) return null;
    total += value;
  }
  return total;
}

/**
 * Rank scored candidates. Ties break by routing priority, then family, then executor name — a total
 * order, so the same contest always produces the same winner.
 *
 * @param {object[]} candidates
 * @returns {object[]} sorted best-first
 */
export function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    if ((b.score ?? -1) !== (a.score ?? -1)) return (b.score ?? -1) - (a.score ?? -1);
    const pa = a.priority === -1 || a.priority === undefined ? Number.MAX_SAFE_INTEGER : a.priority;
    const pb = b.priority === -1 || b.priority === undefined ? Number.MAX_SAFE_INTEGER : b.priority;
    if (pa !== pb) return pa - pb;
    if (a.family !== b.family) return a.family < b.family ? -1 : 1;
    return a.executor < b.executor ? -1 : 1;
  });
}

/**
 * Run the contest.
 *
 * Returns the plan to continue with plus a `contest` record for `run.json` and the report — or, when
 * the contest cannot be held, `degraded_reason` and no plan, which is the caller's signal to run the
 * ordinary single-planner path.
 *
 * @param {object} input
 * @returns {Promise<{plan: object|null, errors: string[], seat: object|null, contest: object}>}
 */
export async function runContest(input) {
  const invoke = input.invoke || invokeExecutor;
  const contestDir = join(input.runDir, 'contest');
  const candidatesDir = join(input.runDir, 'plan-candidates');
  mkdirp(contestDir);
  mkdirp(candidatesDir);

  // The ledger. `state` and `persist` are optional so a caller that only wants a plan (the tests that
  // exercise ranking and synthesis in isolation) does not have to build a run state — but when they ARE
  // supplied, every dispatch is on disk before its child exists. See jobs.mjs.
  const state = input.state ?? null;
  const persistState = input.persist || (() => {});
  const host = input.hostname || hostnameOf();
  const stamp = () => bangkokTimestamp(input.now ? input.now() : Date.now());
  /** Record a ledger change and flush it. Synchronous by contract — see jobs.mjs. */
  const ledger = (mutate) => {
    if (!state) return;
    mutate(state);
    persistState(state);
  };
  /** Resuming needs BOTH a ledger to read and the caller's say-so; either alone is not a resume. */
  const resuming = input.resume === true && state !== null;
  const jobOf = (id) => (state ? jobRecord(state, id) : null);
  /**
   * What to do with one job on this pass: `dispatch` on a fresh run, and on a resume whatever the
   * ledger says. A retry is spent HERE, immediately before the dispatch it pays for.
   */
  const disposition = (id) => {
    if (!resuming) return 'dispatch';
    const job = jobOf(id);
    const decided = resumeDisposition(job);
    if (decided === 'dispatch' && job?.retryable) ledger((s) => spendRetry(s, id));
    return decided;
  };
  /**
   * The ledger says settled and the artifact is not there. A planning session is read-only, so
   * re-running it cannot duplicate anything — but it is charged a retry, or a job whose artifact keeps
   * vanishing would be re-dispatched on every resume forever.
   *
   * @returns {string|null} null when a retry was granted; otherwise why it was not
   */
  const retryMissingArtifact = (id, what) => {
    if (!resuming) return null;
    let granted = false;
    ledger((s) => { granted = spendRetry(s, id); });
    if (granted) {
      if (input.log) {
        input.log(
          `goal resume: ${what} is settled in the ledger but its artifact is missing — re-running it`,
        );
      }
      return null;
    }
    const job = jobOf(id);
    return `settled as '${job?.substate ?? 'unknown'}' with no artifact on disk, and its retry budget `
      + `(${MAX_JOB_RETRIES}) is spent${job?.error ? `: ${job.error}` : ''}`;
  };

  // ---- eligibility -----------------------------------------------------------------------------
  if (input.planners) {
    const errors = validatePlannerSelection({ names: input.planners, executors: input.executors });
    if (errors.length > 0) {
      // An explicit selection that cannot be honoured is an ERROR, not a quiet degradation: the
      // operator named these seats deliberately.
      return { plan: null, errors, seat: null, contest: { selection_errors: errors } };
    }
  }

  const { seats, ineligible } = resolveSeats({
    executors: input.executors,
    prefer: input.prefer,
    only: input.planners,
  });

  if (seats.length < MIN_CONTEST_FAMILIES) {
    const reason = `only ${seats.length} eligible CLI family/families (need ${MIN_CONTEST_FAMILIES} to `
      + `cross-judge): ${ineligible.map((i) => `${i.executor} — ${i.reason}`).join('; ') || 'none registered'}`;
    const contest = { degraded_reason: reason, resumed: resuming, ineligible, candidates: [] };
    writeJson(join(contestDir, 'scoreboard.json'), contest);
    if (input.log) input.log(`goal plan: contest degraded to a single planner — ${reason}`);
    return { plan: null, errors: [], seat: null, contest };
  }

  const executorSummaries = describeExecutors(input.executors, resolveFamily);
  const prompt = buildPlannerPrompt({
    goal: input.goalText,
    workDir: input.workDir,
    scope: input.scopeLabel,
    requirementDocs: input.goalRecord?.requirement_docs || [],
    executors: executorSummaries,
  });
  writeAtomic(join(contestDir, 'contestant-prompt.md'), `${prompt}\n`);

  // ---- fan out ---------------------------------------------------------------------------------
  if (input.log) {
    input.log(
      `goal plan: contest — ${seats.length} families in parallel: `
      + seats.map((s) => `${s.family}/${s.executor}@${s.tier}`).join(', '),
    );
  }

  // Every contestant is `pending` on disk before the first one starts.
  ledger((s) => declareJobs(s, seats.map((seat) => ({
    id: jobId('contestant', seat.family),
    kind: 'contestant',
    key: seat.family,
    executor: seat.executor,
    family: seat.family,
    tier: seat.tier,
  }))));

  const settled = await Promise.all(seats.map(async (seat) => {
    const familyDir = join(candidatesDir, seat.family);
    const id = jobId('contestant', seat.family);
    mkdirp(familyDir);
    if (disposition(id) === 'fold') {
      const folded = foldCandidate(seat, familyDir);
      if (folded) {
        if (input.log) {
          input.log(
            `goal resume: folded contestant ${seat.family} from disk `
            + `(${folded.disqualified ? 'disqualified' : folded.digest})`,
          );
        }
        return folded;
      }
      const exhausted = retryMissingArtifact(id, `contestant ${seat.family}`);
      if (exhausted) {
        const record = { ...seatRecord(seat), disqualified: exhausted, errors: [exhausted], folded: true };
        writeJson(join(familyDir, 'candidate.json'), record);
        return record;
      }
    }
    try {
      const session = await runPlanningSession({
        name: seat.executor,
        spec: seat.spec,
        tier: seat.tier,
        prompt,
        runDir: input.runDir,
        cwd: input.repoRoot,
        invoke,
        // The pid lands on disk BEFORE this await settles — that is the whole point of the ledger.
        onSpawn: (info) => ledger((s) => markDispatched(s, id, {
          pid: info.pid, hostname: host, at: stamp(),
        })),
      });
      ledger((s) => markRunning(s, id, { session_id: session.invocation?.session_id ?? null }));
      writeAtomic(
        join(familyDir, 'transcript.log'),
        `${session.invocation?.stdout ?? ''}\n--- stderr ---\n${session.invocation?.stderr ?? ''}\n`,
      );
      if (!session.ok || session.plan === null) {
        const record = {
          ...seatRecord(seat),
          disqualified: session.errors[0] || 'returned no valid plan',
          errors: session.errors,
        };
        writeJson(join(familyDir, 'candidate.json'), record);
        ledger((s) => markTerminal(s, id, {
          substate: 'disqualified', outcome: 'no valid plan', error: record.disqualified, at: stamp(),
        }));
        return record;
      }
      const digest = planDigest(session.plan);
      writeJson(join(familyDir, 'plan.json'), session.plan);
      const record = { ...seatRecord(seat), plan: session.plan, digest, disqualified: null };
      writeJson(join(familyDir, 'candidate.json'), { ...record, plan: undefined, plan_file: 'plan.json' });
      ledger((s) => markTerminal(s, id, { substate: 'completed', outcome: digest, at: stamp() }));
      return record;
    } catch (err) {
      // A crashed contestant is recorded and the contest continues — that is the whole point of
      // running several. An exception here must not take the run down with it.
      const record = {
        ...seatRecord(seat),
        disqualified: `the session threw: ${err && err.message ? err.message : String(err)}`,
        errors: [String(err && err.message ? err.message : err)],
      };
      writeJson(join(familyDir, 'candidate.json'), record);
      ledger((s) => markTerminal(s, id, {
        substate: 'failed', outcome: 'threw', error: record.disqualified, at: stamp(),
      }));
      return record;
    }
  }));

  const survivors = settled.filter((c) => c.disqualified === null && c.plan);
  if (survivors.length < MIN_CONTEST_FAMILIES) {
    const reason = `${survivors.length} of ${settled.length} contestants produced a valid plan (need `
      + `${MIN_CONTEST_FAMILIES} to compare)`;
    // One survivor is still a plan — use it rather than throwing away a good candidate, and record
    // that no comparison happened.
    const contest = {
      degraded_reason: reason,
      resumed: resuming,
      ineligible,
      candidates: settled.map(publicCandidate),
    };
    writeJson(join(contestDir, 'scoreboard.json'), contest);
    if (input.log) input.log(`goal plan: contest degraded — ${reason}`);
    if (survivors.length === 1) {
      const only = survivors[0];
      contest.candidates = contest.candidates.map((c) => (c.family === only.family ? { ...c, winner: true } : c));
      writeJson(join(contestDir, 'scoreboard.json'), contest);
      return {
        plan: only.plan,
        errors: [],
        seat: { name: only.executor, spec: only.spec },
        contest,
      };
    }
    return { plan: null, errors: [], seat: null, contest };
  }

  // ---- cross-family judging --------------------------------------------------------------------
  const assignments = assignJudges(survivors, seats);
  const judgeSchema = writeSchemaFile(input.runDir, 'judge', JUDGE_OUTPUT_SCHEMA);

  ledger((s) => declareJobs(s, survivors.map((candidate, i) => ({
    id: jobId('judge', candidate.family),
    kind: 'judge',
    key: candidate.family,
    executor: assignments[i]?.judge_executor ?? null,
    family: assignments[i]?.judge_family ?? null,
    tier: assignments[i]?.judge_tier ?? null,
  }))));

  const judged = await Promise.all(survivors.map(async (candidate, i) => {
    const assignment = assignments[i];
    const jid = jobId('judge', candidate.family);
    const familyDir = join(candidatesDir, candidate.family);

    if (disposition(jid) === 'fold') {
      const verdict = readJsonIfPresent(join(familyDir, 'judge-verdict.json'));
      if (verdict) {
        if (input.log) input.log(`goal resume: folded the judge verdict for ${candidate.family} from disk`);
        return { ...candidate, score: verdict.score ?? null, judge: verdict, folded_judge: true };
      }
      const exhausted = retryMissingArtifact(jid, `the judge for ${candidate.family}`);
      if (exhausted) {
        const verdict = { ...assignment, judge_spec: undefined, score: null, report: null, error: exhausted };
        writeJson(join(familyDir, 'judge-verdict.json'), verdict);
        return { ...candidate, score: null, judge: verdict, folded_judge: true };
      }
    }

    const anonymized = anonymizeCandidate(candidate.plan);
    const judgePrompt = buildJudgePrompt({
      goal: input.goalText,
      candidateJson: JSON.stringify(anonymized, null, 2),
    });
    writeAtomic(join(familyDir, 'judge-prompt.md'), `${judgePrompt}\n`);

    try {
      const result = await invoke({
        name: assignment.judge_executor,
        spec: assignment.judge_spec,
        role: 'review',
        tier: assignment.judge_tier,
        prompt: judgePrompt,
        cwd: input.repoRoot,
        schemaPath: judgeSchema.path,
        schemaJson: judgeSchema.json,
        onSpawn: (info) => ledger((s) => markDispatched(s, jid, {
          pid: info.pid, hostname: host, at: stamp(),
        })),
      });
      ledger((s) => markRunning(s, jid, { session_id: result.session_id ?? null }));
      writeAtomic(
        join(familyDir, 'judge-transcript.log'),
        `${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}\n`,
      );
      const score = totalScore(result.result);
      const verdict = {
        ...assignment,
        judge_spec: undefined,
        score,
        report: result.result ?? null,
        error: score === null ? (result.parse_error || 'the judge returned no usable rubric') : null,
      };
      writeJson(join(familyDir, 'judge-verdict.json'), verdict);
      ledger((s) => markTerminal(s, jid, {
        substate: score === null ? 'failed' : 'completed',
        outcome: score === null ? null : String(score),
        error: verdict.error,
        at: stamp(),
      }));
      return { ...candidate, score, judge: verdict };
    } catch (err) {
      const verdict = {
        ...assignment,
        judge_spec: undefined,
        score: null,
        report: null,
        error: `the judge session threw: ${err && err.message ? err.message : String(err)}`,
      };
      writeJson(join(familyDir, 'judge-verdict.json'), verdict);
      ledger((s) => markTerminal(s, jid, {
        substate: 'failed', outcome: 'threw', error: verdict.error, at: stamp(),
      }));
      return { ...candidate, score: null, judge: verdict };
    }
  }));

  const scored = judged.filter((c) => c.score !== null);
  if (scored.length === 0) {
    const reason = 'no candidate could be scored — every judge failed to return a usable rubric';
    const contest = {
      degraded_reason: reason,
      resumed: resuming,
      ineligible,
      candidates: judged.map(publicCandidate),
      judges: judged.map((c) => stripSpec(c.judge)),
    };
    writeJson(join(contestDir, 'scoreboard.json'), contest);
    // Unjudged is not unusable: fall back to the deterministic first seat's plan and say so.
    const fallback = rankCandidates(judged)[0];
    return {
      plan: fallback.plan,
      errors: [],
      seat: { name: fallback.executor, spec: fallback.spec },
      contest,
    };
  }

  const ranked = rankCandidates(scored);
  const winner = ranked[0];
  const runnerUp = ranked[1] ?? null;

  // ---- synthesis -------------------------------------------------------------------------------
  let plan = winner.plan;
  let synthesis = { note: 'no runner-up to compare against; the winning plan stands as written' };

  if (runnerUp) {
    const sid = jobId('synthesis');
    const seat = seats.find((s) => s.family !== winner.family) ?? seats[0];
    ledger((s) => declareJobs(s, [{
      id: sid,
      kind: 'synthesis',
      key: null,
      executor: seat?.executor ?? null,
      family: seat?.family ?? null,
      tier: seat?.tier ?? null,
    }]));
    let folded = null;
    let exhausted = null;
    if (disposition(sid) === 'fold') {
      folded = foldSynthesis(contestDir);
      if (!folded) exhausted = retryMissingArtifact(sid, 'the synthesis pass');
    }
    if (folded) {
      if (input.log) input.log('goal resume: folded the synthesis decision from disk');
      synthesis = folded;
    } else if (exhausted) {
      // No synthesis means the winning plan stands, which is a valid outcome — so the run continues
      // and says why, rather than failing over a comparative pass that is an improvement, not a gate.
      synthesis = { plan: null, decisions: [], note: exhausted, folded: true };
    } else {
      synthesis = await synthesize({
        input,
        invoke,
        seats,
        winner,
        runnerUp,
        contestDir,
        onSpawn: (info) => ledger((s) => markDispatched(s, sid, {
          pid: info.pid, hostname: host, at: stamp(),
        })),
      });
      ledger((s) => markTerminal(s, sid, {
        substate: synthesis.plan ? 'completed' : 'failed',
        outcome: synthesis.note ?? null,
        error: synthesis.plan ? null : (synthesis.note ?? null),
        at: stamp(),
      }));
    }
    if (synthesis.plan) plan = synthesis.plan;
  }

  const contest = {
    degraded_reason: null,
    resumed: resuming,
    ineligible,
    candidates: judged.map((c) => ({
      ...publicCandidate(c),
      winner: c.family === winner.family,
    })),
    judges: judged.map((c) => stripSpec(c.judge)),
    synthesis: { ...synthesis, plan: undefined },
    winner: { family: winner.family, executor: winner.executor, tier: winner.tier, score: winner.score },
  };
  writeJson(join(contestDir, 'scoreboard.json'), contest);

  return {
    plan,
    errors: [],
    seat: { name: winner.executor, spec: winner.spec },
    contest,
  };
}

/**
 * The one comparative synthesis pass.
 *
 * Runs on a family different from the winner's where one exists — a synthesizer from the winning
 * family has an interest in the winner needing no help. Contract-invalid or scope-widening output
 * falls back to the unsynthesized winner rather than silently changing the plan that was judged.
 *
 * @param {object} args
 * @returns {Promise<{plan: object|null, decisions: object[], note: string, synthesizer?: object}>}
 */
async function synthesize(args) {
  const { input, invoke, seats, winner, runnerUp, contestDir } = args;
  const seat = seats.find((s) => s.family !== winner.family) ?? seats[0];
  const schema = writeSchemaFile(input.runDir, 'plan', PLAN_OUTPUT_SCHEMA);

  const prompt = buildSynthesisPrompt({
    goal: input.goalText,
    winnerJson: JSON.stringify(canonicalPlan(winner.plan), null, 2),
    runnerUpJson: JSON.stringify(anonymizeCandidate(runnerUp.plan), null, 2),
    winnerReport: winner.judge?.report,
    runnerUpReport: runnerUp.judge?.report,
  });
  writeAtomic(join(contestDir, 'synthesis-prompt.md'), `${prompt}\n`);

  let result;
  try {
    result = await invoke({
      name: seat.executor,
      spec: seat.spec,
      role: 'plan',
      tier: seat.tier,
      prompt,
      cwd: input.repoRoot,
      schemaPath: schema.path,
      schemaJson: schema.json,
      onSpawn: args.onSpawn,
    });
  } catch (err) {
    return {
      plan: null,
      decisions: [],
      note: `the synthesis session threw (${err && err.message ? err.message : err}); the winning plan `
        + 'stands unchanged',
    };
  }
  writeAtomic(
    join(contestDir, 'synthesis-transcript.log'),
    `${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}\n`,
  );

  const checked = checkPlanDocument(result.result);
  if (!checked.ok) {
    const note = `the synthesis output was contract-invalid (${checked.errors.join('; ')}); the winning `
      + 'plan stands unchanged';
    writeJson(join(contestDir, 'synthesis-decisions.json'), { accepted: false, note, decisions: [] });
    return { plan: null, decisions: [], note };
  }

  const widening = detectScopeWidening(winner.plan, result.result);
  if (widening.length > 0) {
    const note = `the synthesis output widened scope (${widening.join('; ')}); rejected, and the winning `
      + 'plan stands unchanged';
    writeJson(join(contestDir, 'synthesis-decisions.json'), { accepted: false, note, decisions: [] });
    return { plan: null, decisions: [], note };
  }

  const decisions = diffDecisions(winner.plan, result.result, runnerUp.family);
  const record = {
    accepted: true,
    synthesizer: { executor: seat.executor, family: seat.family, tier: seat.tier },
    base: { family: winner.family, digest: winner.digest },
    runner_up: { family: runnerUp.family, digest: runnerUp.digest },
    resulting_digest: planDigest(result.result),
    decisions,
  };
  writeJson(join(contestDir, 'synthesis-decisions.json'), record);
  // The synthesized plan itself, so a resume can FOLD this pass instead of re-running it. The
  // decisions file records what changed and its digest; without the document, a resumed run would
  // have to re-ask a model a question that was already answered — and might get a different answer.
  writeJson(join(contestDir, 'synthesis-plan.json'), result.result);
  return {
    plan: result.result,
    decisions,
    note: decisions.length === 0
      ? 'the synthesizer took nothing from the runner-up; the winning plan stands as written'
      : `${decisions.length} change(s) grafted from the runner-up`,
    synthesizer: record.synthesizer,
  };
}

/**
 * Scope widening the synthesis pass is not allowed to introduce.
 *
 * Checked in code rather than trusted to the prompt: "do not widen the scope" is exactly the
 * instruction a model is most likely to follow in spirit and break in detail, and the consequence is
 * an approval envelope binding write roots the operator never saw.
 *
 * @param {object} base
 * @param {object} candidate
 * @returns {string[]}
 */
export function detectScopeWidening(base, candidate) {
  /** @type {string[]} */
  const found = [];
  const basePaths = new Set((base.nodes || []).flatMap((n) => n.affected_paths || []));
  const newPaths = (candidate.nodes || [])
    .flatMap((n) => n.affected_paths || [])
    .filter((p) => !basePaths.has(p));
  if (newPaths.length > 0) found.push(`new affected paths: ${newPaths.join(', ')}`);

  if (String(candidate.goal ?? '') !== String(base.goal ?? '')) found.push('the goal statement changed');

  const baseOos = new Set(base.out_of_scope || []);
  const dropped = (base.out_of_scope || []).filter((o) => !(candidate.out_of_scope || []).includes(o));
  if (dropped.length > 0) found.push(`out-of-scope commitments dropped: ${dropped.join('; ')}`);
  if (baseOos.size > 0 && (candidate.out_of_scope || []).length === 0) {
    found.push('out_of_scope was emptied');
  }
  return found;
}

/**
 * What the synthesis actually changed, as an auditable list.
 *
 * Derived by DIFFING the documents rather than asking the model to report its own edits: a
 * self-reported change list is exactly as reliable as the model's memory of what it did.
 *
 * @param {object} base
 * @param {object} synthesized
 * @param {string} sourceFamily
 * @returns {object[]}
 */
export function diffDecisions(base, synthesized, sourceFamily) {
  /** @type {object[]} */
  const decisions = [];
  const baseNodes = new Map((base.nodes || []).map((n) => [n.id, n]));
  const newNodes = new Map((synthesized.nodes || []).map((n) => [n.id, n]));

  for (const [id, node] of newNodes) {
    if (!baseNodes.has(id)) {
      decisions.push({
        accepted: true, what: `node '${id}' added (${node.title})`, source_family: sourceFamily,
        why: 'present in the synthesized plan and not in the winner',
      });
      continue;
    }
    const before = baseNodes.get(id);
    const beforeCriteria = new Set((before.acceptance || []).map((c) => c.id));
    const added = (node.acceptance || []).filter((c) => !beforeCriteria.has(c.id));
    if (added.length > 0) {
      decisions.push({
        accepted: true,
        what: `criteria added to '${id}': ${added.map((c) => c.id).join(', ')}`,
        source_family: sourceFamily,
        why: 'improves criteria testability',
      });
    }
    const beforeTests = new Set(before.tests || []);
    const newTests = (node.tests || []).filter((t) => !beforeTests.has(t));
    if (newTests.length > 0) {
      decisions.push({
        accepted: true,
        what: `tests added to '${id}': ${newTests.join(', ')}`,
        source_family: sourceFamily,
        why: 'improves criteria testability',
      });
    }
    if (JSON.stringify(before.depends_on || []) !== JSON.stringify(node.depends_on || [])) {
      decisions.push({
        accepted: true,
        what: `dependencies of '${id}' changed: [${(before.depends_on || []).join(', ')}] → `
          + `[${(node.depends_on || []).join(', ')}]`,
        source_family: sourceFamily,
        why: 'improves dependency correctness',
      });
    }
  }
  for (const id of baseNodes.keys()) {
    if (!newNodes.has(id)) {
      decisions.push({
        accepted: true, what: `node '${id}' removed`, source_family: sourceFamily,
        why: 'the synthesizer judged it unnecessary',
      });
    }
  }
  const newRisks = (synthesized.risks || []).filter((r) => !(base.risks || []).includes(r));
  if (newRisks.length > 0) {
    decisions.push({
      accepted: true, what: `risks added: ${newRisks.join('; ')}`, source_family: sourceFamily,
      why: 'improves risk realism',
    });
  }
  return decisions;
}

/** The seat fields a candidate record carries. */
function seatRecord(seat) {
  return {
    executor: seat.executor,
    spec: seat.spec,
    family: seat.family,
    tier: seat.tier,
    model: seat.model,
    tier_fallback: seat.tier_fallback,
    priority: seat.priority,
  };
}

/** A candidate without the executor spec or the plan body — what run.json and the report carry. */
function publicCandidate(c) {
  return {
    executor: c.executor,
    family: c.family,
    tier: c.tier,
    model: c.model ?? null,
    tier_fallback: Boolean(c.tier_fallback),
    score: c.score ?? null,
    digest: c.digest ?? null,
    disqualified: c.disqualified ?? null,
    // Which halves of this seat's work came off disk rather than out of a fresh session. Reported
    // because a scoreboard that hides it would read as a contest that ran when it partly did not.
    folded: Boolean(c.folded),
    folded_judge: Boolean(c.folded_judge),
  };
}

/**
 * Read one settled candidate back off disk, or null when its artifact is not there.
 *
 * The seat is re-derived from the CURRENT registry rather than trusted from the stored record: a
 * resume on a machine whose registry changed should fail the eligibility check it would fail on a
 * fresh run, not inherit yesterday's routing.
 *
 * @param {object} seat
 * @param {string} familyDir
 * @returns {object|null}
 */
function foldCandidate(seat, familyDir) {
  const record = readJsonIfPresent(join(familyDir, 'candidate.json'));
  if (!record) return null;
  if (record.disqualified) {
    return {
      ...seatRecord(seat),
      disqualified: record.disqualified,
      errors: Array.isArray(record.errors) ? record.errors : [],
      folded: true,
    };
  }
  const plan = readJsonIfPresent(join(familyDir, 'plan.json'));
  if (!plan) return null;
  return {
    ...seatRecord(seat),
    plan,
    digest: record.digest ?? planDigest(plan),
    disqualified: null,
    folded: true,
  };
}

/**
 * Read a settled synthesis decision back off disk, or null.
 *
 * A REJECTED synthesis folds too, and folds to the same outcome it had: the winning plan stands. That
 * is not the absence of a result — it is the result, and re-running the pass to rediscover it would
 * spend a session to maybe reach a different answer than the one already recorded.
 *
 * @param {string} contestDir
 * @returns {object|null}
 */
function foldSynthesis(contestDir) {
  const record = readJsonIfPresent(join(contestDir, 'synthesis-decisions.json'));
  if (!record) return null;
  if (record.accepted !== true) {
    return {
      plan: null,
      decisions: [],
      note: record.note ?? 'the synthesis output was rejected; the winning plan stands unchanged',
      folded: true,
    };
  }
  const plan = readJsonIfPresent(join(contestDir, 'synthesis-plan.json'));
  if (!plan) return null;
  const decisions = Array.isArray(record.decisions) ? record.decisions : [];
  return {
    plan,
    decisions,
    note: decisions.length === 0
      ? 'the synthesizer took nothing from the runner-up; the winning plan stands as written'
      : `${decisions.length} change(s) grafted from the runner-up`,
    synthesizer: record.synthesizer ?? null,
    folded: true,
  };
}

/** A judge assignment with the executor spec removed (it is not persistable state). */
function stripSpec(judge) {
  if (!judge) return null;
  const { judge_spec, ...rest } = judge;
  return rest;
}
