// lib/goal-lifecycle/plan.mjs
// `sidekicks goal plan <goal-or-file> [--executor <n>] [--tier <t>] [--contest] [--planners a,b,c]`
//
// Intake → plan → independent critique → an approval envelope with a digest. Nothing is dispatched
// here that can write to the repository: planning and critique both run in the selected CLI's
// enforced read-only mode, and the ONLY writer of run state is this process.
//
// THE ORDER OF WRITES IS THE CRASH-SAFETY DESIGN. `goal.json` lands before any subprocess starts, so
// a crash during planning leaves a run that can be identified and resumed rather than an orphan
// folder. The lease is taken before the first state write and released in a `finally`, so a crash
// leaves a lock whose owner is a dead pid on this host — which the conservative reclaim rules will
// archive and take over, while never touching a live or foreign one.
//
// WHAT THIS VERB REFUSES TO DO. It does not approve its own plan; it prints the digest and stops. It
// does not loop on critique more than twice. It does not widen the goal to fit what the planner
// happened to return. And when the planner cannot produce a valid document, it moves the run to
// `needs_user` with the validation errors rather than accepting a partial plan — an invalid plan
// dispatched is an unbounded agent run.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveWorkingFolder } from '../active-scope/scope.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { bangkokTimestamp } from '../run-events/store.mjs';
import { effectiveExecutors, readEffectiveRegistry, routingPolicy } from '../cli-executor-lifecycle/_shared.mjs';
import { resolveFamily } from '../cli-executor-lifecycle/profiles.mjs';
import {
  RELATIVE,
  assembleEnvelope,
  flagString,
  goalPositionals,
  newRunId,
  parseGoalFlags,
  resolveGoalRunDir,
} from './commands.mjs';
import {
  canonicalEnvelope,
  criterionOwners,
  envelopeDigest,
  goalDigest,
  planDigest,
  validateEnvelope,
  validateGoal,
} from './schema.mjs';
import { topoOrder } from './graph.mjs';
import { defaultActionPolicy, defaultBudgets } from './policy.mjs';
import {
  buildCorrectionPrompt,
  buildCriticPrompt,
  buildPlannerPrompt,
  describeExecutors,
  runCritiqueSession,
  runPlanningSession,
  selectExecutor,
  selectIndependentExecutor,
} from './planner.mjs';
import { renderApprovalSummary, renderPlanMarkdown } from './render.mjs';
import {
  acquireRunLease,
  appendGoalEvent,
  clearLease,
  goalPaths,
  mkdirp,
  newRunState,
  readJsonIfPresent,
  readRunState,
  releaseRunLease,
  stampDivergence,
  stampLease,
  writeJson,
  writeRunState,
} from './store.mjs';
import {
  toAwaitingApproval,
  toNeedsUser,
  toPlanCorrection,
  toPlanReview,
  toPlanning,
} from './state-machine.mjs';

/** The plan critique budget. Two passes, then a human — never an unbounded loop. */
export const MAX_CRITIQUE_PASSES = 2;

/** Boolean flags this verb accepts (everything else is a valued flag, re-parsed locally). */
const BOOLEANS = ['contest', 'json', 'no-critique'];

/**
 * Run `goal plan`.
 *
 * @param {{repoRoot: string, argv: string[], flags: object, log: Function}} ctx
 * @param {object} _args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, _args) {
  const flags = parseGoalFlags(ctx.argv, BOOLEANS);
  const positionals = goalPositionals(ctx.argv, BOOLEANS);

  const goalArg = positionals.join(' ').trim();
  if (goalArg === '') {
    throw new SidekicksError(
      'goal plan: usage: goal plan "<goal>" | <path-to-goal-file> [--executor <name>] '
      + '[--tier <top|high|mid|low>] [--contest] [--planners <a,b,c>] [--json]',
      EXIT_USAGE,
    );
  }

  const contest = flags.contest === true;
  const planners = flagString(flags.planners);
  const requestedExecutor = flagString(flags.executor);
  const requestedTier = flagString(flags.tier) || 'high';

  // Flag combinations are checked BEFORE anything is written, so an unusable request never leaves a
  // half-created run folder behind.
  if (planners && !contest) {
    throw new SidekicksError(
      'goal plan: --planners names the contestants of a contest, so it requires --contest',
      EXIT_VALIDATION,
    );
  }
  if (contest && (requestedExecutor || flagString(flags.tier))) {
    throw new SidekicksError(
      'goal plan: --contest runs the highest eligible tier of every capable CLI family, so it is '
      + 'mutually exclusive with the single-planner --executor / --tier flags',
      EXIT_VALIDATION,
    );
  }

  const { goalText, requirementDocs } = readGoal(ctx.repoRoot, goalArg);

  const settings = readSettings(ctx.repoRoot);
  const scope = resolveWorkingFolder(settings, ctx.repoRoot);
  const registry = readEffectiveRegistry(ctx.repoRoot, settings);
  const executors = effectiveExecutors(registry);
  const prefer = routingPolicy(registry);

  const runId = newRunId();
  const { runDir } = resolveGoalRunDir(ctx.repoRoot, runId);
  mkdirp(runDir);

  // ---- intake, before any subprocess ------------------------------------------------------------
  const createdAt = bangkokTimestamp(Date.now());
  const goalRecord = {
    schema_version: 1,
    run_id: runId,
    goal: goalText,
    created_at: createdAt,
    work_dir: RELATIVE(ctx.repoRoot, scope.workdir),
    requirement_docs: requirementDocs,
  };
  const goalCheck = validateGoal(goalRecord);
  if (!goalCheck.ok) {
    throw new SidekicksError(`goal plan: invalid goal record: ${goalCheck.errors.join('; ')}`, EXIT_VALIDATION);
  }
  writeJson(goalPaths(runDir).goal, goalRecord);

  let state = newRunState({ run_id: runId, goal_digest: goalDigest(goalRecord) });
  const lease = acquireRunLease(runDir);
  try {
    stampLease(state, { nonce: lease.nonce });
    state = commit(runDir, state, toPlanning(state, { reason: 'goal intake' }));

    const executorSummaries = describeExecutors(executors, resolveFamily);
    if (executorSummaries.length === 0) {
      state = commit(runDir, state, toNeedsUser(state, {
        reason: 'no executor maps any model tier, so nothing can be planned or implemented',
        next: "register one: cli-executor register <name> --model-high <id>",
      }));
      return finish(ctx, runDir, state, flags, 'no usable executor');
    }

    // ---- plan --------------------------------------------------------------------------------
    let planDoc = null;
    let planErrors = [];
    let plannerSeat = null;
    let contestRecord = null;

    if (contest) {
      // The request itself is persisted BEFORE the fan-out, because a resume has to reproduce the
      // same field of seats from disk alone: `--planners` and the tier came off a command line that
      // no longer exists by then, and rebuilding the contest from a different field would fold
      // artifacts into a comparison that was never held.
      state.planning = {
        ...(state.planning || {}),
        contest_request: {
          planners: planners ? planners.split(',').map((s) => s.trim()).filter(Boolean) : null,
          tier: requestedTier,
        },
      };
      state = writeRunState(runDir, state);
      const { runContest } = await import('./contest.mjs');
      const outcome = await runContest({
        repoRoot: ctx.repoRoot,
        runDir,
        runId,
        goalText,
        goalRecord,
        executors,
        prefer,
        planners: planners ? planners.split(',').map((s) => s.trim()).filter(Boolean) : null,
        scopeLabel: scopeLabel(scope),
        workDir: goalRecord.work_dir,
        log: ctx.log,
        // The job ledger. Handed the live state and a writer, so every contestant, judge and synthesis
        // dispatch is on disk BEFORE its child exists — a fan-out recorded only on return cannot be
        // resumed without risking a duplicate dispatch.
        state,
        persist: (s) => { state = writeRunState(runDir, s); },
      });
      contestRecord = outcome.contest;
      state.planning = { ...(state.planning || {}), contest: contestRecord };
      planDoc = outcome.plan;
      planErrors = outcome.errors;
      plannerSeat = outcome.seat;
    }

    if (planDoc === null && planErrors.length === 0) {
      // Single-planner path — also the contest's documented degradation.
      plannerSeat = selectExecutor({
        executors, prefer, requested: requestedExecutor || null, role: 'plan', tier: requestedTier,
      });
      const prompt = buildPlannerPrompt({
        goal: goalText,
        workDir: goalRecord.work_dir,
        scope: scopeLabel(scope),
        requirementDocs,
        executors: executorSummaries,
      });
      writePrompt(runDir, 'planner', prompt);
      ctx.log(`goal plan: planning with ${plannerSeat.name} at the ${requestedTier} tier (read-only)`);
      const session = await runPlanningSession({
        name: plannerSeat.name,
        spec: plannerSeat.spec,
        tier: requestedTier,
        prompt,
        runDir,
        cwd: ctx.repoRoot,
      });
      writeTranscript(runDir, 'planner', session.invocation);
      planDoc = session.plan;
      planErrors = session.errors;
    }

    if (planDoc === null) {
      state = commit(runDir, state, toNeedsUser(state, {
        reason: 'the planning session did not produce a valid plan',
        findings: planErrors,
        next: 'fix the cause, then run `goal plan` again — an invalid plan is never dispatched',
      }));
      return finish(ctx, runDir, state, flags, 'planning failed');
    }

    return await finishPlanning({
      ctx,
      runDir,
      runId,
      state,
      setState: (next) => { state = next; },
      goalRecord,
      goalText,
      executors,
      prefer,
      requestedTier,
      scope,
      createdAt,
      planDoc,
      plannerSeat,
      contestRecord,
      flags,
      noCritique: flags['no-critique'] === true,
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

/**
 * Continue an interrupted planning phase in the SAME run.
 *
 * Called by `goal resume` once it has classified every planning job: live children are left alone and
 * foreign or unverifiable ownership has already gone to `needs_user`, so what reaches here is a run
 * whose remaining work is safe to do. The contest is re-entered with `resume: true`, which folds every
 * settled job's artifact off disk by its deterministic id and dispatches only what was never
 * dispatched or has a retry left.
 *
 * A run with NO job ledger was a single-planner run: there is nothing to fold, and the caller says so
 * rather than silently re-planning under a fresh digest.
 *
 * @param {{repoRoot: string, argv: string[], flags: object, log: Function}} ctx
 * @param {string} runDir
 * @param {object} loadedState
 * @param {object} flags
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function continuePlanning(ctx, runDir, loadedState, flags) {
  const goalRecord = readJsonIfPresent(goalPaths(runDir).goal);
  if (!goalRecord) {
    throw new SidekicksError(
      `goal resume: ${RELATIVE(ctx.repoRoot, goalPaths(runDir).goal)} is missing, so the goal this run `
      + 'was planning cannot be recovered — nothing is inferred from the artifacts',
      EXIT_VALIDATION,
    );
  }

  const settings = readSettings(ctx.repoRoot);
  const scope = resolveWorkingFolder(settings, ctx.repoRoot);
  const registry = readEffectiveRegistry(ctx.repoRoot, settings);
  const executors = effectiveExecutors(registry);
  const prefer = routingPolicy(registry);
  const request = loadedState.planning?.contest_request || {};
  const requestedTier = typeof request.tier === 'string' && request.tier !== '' ? request.tier : 'high';

  let state = loadedState;
  const lease = acquireRunLease(runDir);
  try {
    stampLease(state, { nonce: lease.nonce });
    state = writeRunState(runDir, state);

    const { runContest } = await import('./contest.mjs');
    const outcome = await runContest({
      repoRoot: ctx.repoRoot,
      runDir,
      runId: state.run_id,
      goalText: goalRecord.goal,
      goalRecord,
      executors,
      prefer,
      planners: Array.isArray(request.planners) ? request.planners : null,
      scopeLabel: scopeLabel(scope),
      workDir: goalRecord.work_dir,
      log: ctx.log,
      resume: true,
      state,
      persist: (s) => { state = writeRunState(runDir, s); },
    });
    const contestRecord = outcome.contest;
    state.planning = { ...(state.planning || {}), contest: contestRecord };

    if (outcome.plan === null) {
      state = commit(runDir, state, toNeedsUser(state, {
        reason: outcome.errors.length > 0
          ? 'the resumed contest could not produce a valid plan'
          : 'the resumed contest produced no comparable candidate',
        findings: outcome.errors,
        next: 'the completed candidates remain under plan-candidates/; fix the cause, then resume again',
      }));
      return finish(ctx, runDir, state, flags, 'resumed planning failed');
    }

    return await finishPlanning({
      ctx,
      runDir,
      runId: state.run_id,
      state,
      setState: (next) => { state = next; },
      goalRecord,
      goalText: goalRecord.goal,
      executors,
      prefer,
      requestedTier,
      scope,
      createdAt: goalRecord.created_at,
      planDoc: outcome.plan,
      plannerSeat: outcome.seat,
      contestRecord,
      flags,
      noCritique: false,
    });
  } finally {
    try {
      const onDisk = readRunState(runDir);
      clearLease(onDisk);
      writeRunState(runDir, onDisk);
    } catch { /* releasing the lock matters more than the bookkeeping */ }
    releaseRunLease(runDir, lease.nonce);
  }
}

/**
 * Everything after a plan document exists: critique, envelope, digest, approval offer.
 *
 * Shared by `goal plan` and by a resumed planning phase, so the two cannot drift into offering
 * differently-assembled envelopes for the same plan — the digest an operator approves has to be a
 * function of the plan and the checkouts, never of which verb happened to produce it.
 *
 * @param {object} input
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
async function finishPlanning(input) {
  const { ctx, runDir, runId, flags, goalRecord, scope, createdAt } = input;
  let state = input.state;
  let planDoc = input.planDoc;
  const { plannerSeat, contestRecord, executors, prefer, requestedTier } = input;
  const commitState = (transition) => {
    state = commit(runDir, state, transition);
    input.setState(state);
    return state;
  };

  // ---- critique --------------------------------------------------------------------------------
  let digest = planDigest(planDoc);
  commitState(toPlanReview(state, { plan_digest: digest }));

  if (!input.noCritique) {
    const outcome = await critiqueLoop({
      ctx,
      runDir,
      goalText: input.goalText,
      executors,
      prefer,
      tier: requestedTier,
      authorFamily: plannerSeat ? resolveFamily(plannerSeat.name, plannerSeat.spec) : null,
      authorExecutor: plannerSeat ? plannerSeat.name : null,
      plan: planDoc,
      state,
      writePlanState: (next) => { state = next; input.setState(next); },
    });
    if (!outcome.ok) {
      commitState(toNeedsUser(state, {
        reason: outcome.reason,
        findings: outcome.findings,
        next: 'address the findings, then run `goal plan` again',
      }));
      return finish(ctx, runDir, state, flags, 'plan critique unresolved');
    }
    planDoc = outcome.plan;
    digest = planDigest(planDoc);
  }

  // ---- envelope --------------------------------------------------------------------------------
  const { envelope, owners } = assembleEnvelope({
    repoRoot: ctx.repoRoot,
    plan: planDoc,
    goalDigest: goalDigest(goalRecord),
    planDigest: digest,
    scope: { project: scope.projectName, service: scope.serviceName ?? null },
    budgets: defaultBudgets(),
    actionPolicy: defaultActionPolicy({
      allowedTestCommands: [...new Set(planDoc.nodes.flatMap((n) => n.tests || []))],
    }),
    criterionOwners: criterionOwners(planDoc),
    familyOf: (name) => resolveFamily(name, executors[name] || {}),
  });
  const canonical = canonicalEnvelope(envelope);
  const envCheck = validateEnvelope(canonical);
  if (!envCheck.ok) {
    commitState(toNeedsUser(state, {
      reason: 'the approval envelope could not be assembled from this plan and the current checkouts',
      findings: envCheck.errors,
      next: 'usually a plan whose affected paths do not resolve to a Git checkout',
    }));
    return finish(ctx, runDir, state, flags, 'envelope invalid');
  }
  const envDigest = envelopeDigest(canonical);

  const order = topoOrder(planDoc);
  writeJson(goalPaths(runDir).plan, planDoc);
  writeJson(goalPaths(runDir).envelope, canonical);
  writeAtomicText(goalPaths(runDir).planMd, renderPlanMarkdown(planDoc, {
    runId,
    planDigest: digest,
    envelopeDigest: envDigest,
    createdAt,
    contest: contestRecord,
    order: order.ok ? order.order : undefined,
  }));

  commitState(toAwaitingApproval(state, {
    envelope: canonical,
    envelope_digest: envDigest,
    plan_digest: digest,
  }));

  const summary = renderApprovalSummary({
    runId,
    envelope: canonical,
    envelopeDigest: envDigest,
    planPath: RELATIVE(ctx.repoRoot, goalPaths(runDir).planMd),
    contest: contestRecord,
  });

  if (flags.json === true) {
    return {
      stdout: `${JSON.stringify({
        run_id: runId,
        run_dir: RELATIVE(ctx.repoRoot, runDir),
        phase: state.phase,
        plan_digest: digest,
        envelope_digest: envDigest,
        nodes: planDoc.nodes.map((n) => n.id),
        checkouts: canonical.checkouts,
        write_roots: canonical.write_roots,
        owners_assessed: owners.map((o) => ({ path: o.path, branch: o.branch, protected: o.protected })),
        contest: contestRecord,
        approve: `sidekicks goal approve ${runId} --digest ${envDigest}`,
      }, null, 2)}\n`,
      exitCode: EXIT_OK,
    };
  }
  return { stdout: summary, exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The bounded plan/critique loop.
 *
 * The cap is enforced by the state machine (`toPlanCorrection` refuses a third pass), not by this
 * loop's counter — so a future caller that forgets to count cannot spin.
 *
 * @param {object} input
 * @returns {Promise<{ok: boolean, plan: object|null, reason: string, findings: string[]}>}
 */
async function critiqueLoop(input) {
  const { ctx, runDir } = input;
  let plan = input.plan;
  let state = input.state;

  for (let pass = 0; pass <= MAX_CRITIQUE_PASSES; pass += 1) {
    let critic;
    try {
      critic = selectIndependentExecutor({
        executors: input.executors,
        prefer: input.prefer,
        role: 'review',
        tier: input.tier,
        avoidFamily: input.authorFamily,
        avoidExecutor: input.authorExecutor,
        familyOf: resolveFamily,
      });
    } catch (err) {
      // No seat can review. Better to say so than to let the plan's own author approve it.
      return { ok: false, plan: null, reason: `no executor can review the plan: ${err.message}`, findings: [] };
    }

    const prompt = buildCriticPrompt({
      goal: input.goalText,
      planJson: JSON.stringify(plan, null, 2),
      workDir: '.',
    });
    writePrompt(runDir, `critic-${pass + 1}`, prompt);
    ctx.log(
      `goal plan: critique pass ${pass + 1} with ${critic.name} (${critic.family ?? '?'})`
      + `${critic.same_family_fallback ? ' — SAME FAMILY as the author, recorded as a fallback' : ''}`,
    );

    const session = await runCritiqueSession({
      name: critic.name,
      spec: critic.spec,
      tier: input.tier,
      prompt,
      runDir,
      cwd: ctx.repoRoot,
    });
    writeTranscript(runDir, `critic-${pass + 1}`, session.invocation);

    if (!session.ok) {
      return { ok: false, plan: null, reason: 'the plan critic returned no usable verdict', findings: session.errors };
    }
    if (session.verdict === 'approve') {
      return { ok: true, plan, reason: '', findings: [] };
    }

    const blocking = session.findings.filter((f) => f.severity === 'blocking');
    const findingLines = blocking.map((f) => `${f.node ? `[${f.node}] ` : ''}${f.what} → ${f.fix}`);

    // The state machine refuses the pass past the cap; that refusal is the loop's exit.
    let corrected;
    try {
      corrected = toPlanCorrection(state, { findings: findingLines, max_passes: MAX_CRITIQUE_PASSES });
    } catch {
      return {
        ok: false,
        plan: null,
        reason: `the plan critic still reports ${blocking.length} blocking finding(s) after `
          + `${MAX_CRITIQUE_PASSES} correction passes`,
        findings: findingLines,
      };
    }
    state = commit(runDir, state, corrected);
    input.writePlanState(state);

    const author = selectExecutor({
      executors: input.executors,
      prefer: input.prefer,
      requested: input.authorExecutor,
      role: 'plan',
      tier: input.tier,
    });
    const fixPrompt = buildCorrectionPrompt({
      goal: input.goalText,
      planJson: JSON.stringify(plan, null, 2),
      findings: blocking,
      pass: state.planning.critique_passes,
      maxPasses: MAX_CRITIQUE_PASSES,
    });
    writePrompt(runDir, `planner-correction-${state.planning.critique_passes}`, fixPrompt);
    const redo = await runPlanningSession({
      name: author.name,
      spec: author.spec,
      tier: input.tier,
      prompt: fixPrompt,
      runDir,
      cwd: ctx.repoRoot,
    });
    writeTranscript(runDir, `planner-correction-${state.planning.critique_passes}`, redo.invocation);
    if (redo.plan === null) {
      return {
        ok: false,
        plan: null,
        reason: 'the correction pass did not produce a valid plan',
        findings: redo.errors,
      };
    }
    plan = redo.plan;
    state = commit(runDir, state, toPlanReview(state, { plan_digest: planDigest(plan) }));
    input.writePlanState(state);
  }

  return {
    ok: false,
    plan: null,
    reason: `the plan critique loop reached its ${MAX_CRITIQUE_PASSES}-pass cap`,
    findings: [],
  };
}

/**
 * Persist a transition: state first (it is the authority), then the sidecar event.
 *
 * A failed append records divergence and the caller halts. State is never rolled back to match the
 * sidecar — a fabricated history reads as evidence, which is worse than a gap.
 *
 * @param {string} runDir
 * @param {object} _prev
 * @param {{state: object, event: object}} transition
 * @returns {object} the persisted state
 */
export function commit(runDir, _prev, transition) {
  let state = writeRunState(runDir, transition.state);
  const appended = appendGoalEvent(runDir, transition.event);
  if (!appended.ok) {
    stampDivergence(state, { event: transition.event.event, error: appended.error });
    state = writeRunState(runDir, state);
  }
  return state;
}

/**
 * Read the goal from a quoted string or a file path.
 *
 * A path is detected by EXISTENCE, not by shape: `goal plan "docs/req.md"` should read the file, and
 * `goal plan "add a widget"` should not go looking for one.
 *
 * @param {string} repoRoot
 * @param {string} arg
 * @returns {{goalText: string, requirementDocs: string[]}}
 */
export function readGoal(repoRoot, arg) {
  const abs = isAbsolute(arg) ? arg : resolvePath(repoRoot, arg);
  if (!arg.includes('\n') && arg.length < 512 && existsSync(abs)) {
    const text = readFileSync(abs, 'utf8').trim();
    if (text === '') {
      throw new SidekicksError(`goal plan: '${arg}' is empty`, EXIT_VALIDATION);
    }
    return { goalText: text, requirementDocs: [RELATIVE(repoRoot, abs)] };
  }
  return { goalText: arg, requirementDocs: [] };
}

/** A human label for the active scope. */
function scopeLabel(scope) {
  return scope.serviceName
    ? `project ${scope.projectName}, service ${scope.serviceName}`
    : `project ${scope.projectName}`;
}

/** Persist a prompt so the run's evidence includes what was actually asked. */
function writePrompt(runDir, name, prompt) {
  const dir = `${runDir}/prompts`;
  mkdirp(dir);
  writeAtomicText(`${dir}/${name}.md`, prompt);
}

/**
 * Persist a session's transcript and its routing metadata.
 *
 * The transcript is the raw stdout/stderr; the metadata is what the report cites. Kept as two files
 * because one is for a human reading a failure and the other is machine-read.
 */
function writeTranscript(runDir, name, invocation) {
  if (!invocation) return;
  const dir = `${runDir}/transcripts`;
  mkdirp(dir);
  writeAtomicText(`${dir}/${name}.log`, `${invocation.stdout ?? ''}\n--- stderr ---\n${invocation.stderr ?? ''}\n`);
  const { stdout, stderr, args, ...meta } = invocation;
  writeJson(`${dir}/${name}.json`, meta);
}

/**
 * The one text-artifact writer, so every file this verb produces is written the same crash-safe way.
 *
 * @param {string} path
 * @param {string} text
 */
function writeAtomicText(path, text) {
  writeAtomic(path, text.endsWith('\n') ? text : `${text}\n`);
}

/** Emit the terminal report for a run that stopped short of approval. */
function finish(ctx, runDir, state, flags, reason) {
  const payload = {
    run_id: state.run_id,
    run_dir: RELATIVE(ctx.repoRoot, runDir),
    phase: state.phase,
    reason,
    needs_user: state.needs_user ?? null,
  };
  if (flags.json === true) {
    return { stdout: `${JSON.stringify(payload, null, 2)}\n`, exitCode: EXIT_VALIDATION };
  }
  const lines = [
    `goal run ${state.run_id} — ${state.phase}`,
    '',
    `  ${reason}`,
  ];
  for (const f of state.needs_user?.findings || []) lines.push(`    - ${f}`);
  if (state.needs_user?.next) lines.push(`  next: ${state.needs_user.next}`);
  lines.push('');
  lines.push(`  run folder: ${payload.run_dir}`);
  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_VALIDATION };
}
