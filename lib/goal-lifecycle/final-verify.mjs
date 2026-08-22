// lib/goal-lifecycle/final-verify.mjs
// The adversarial check on the whole goal, and the exit check that has to pass with it.
//
// WHY A SECOND VERIFIER AT ALL. Every node passed its own review — but a plan can be executed
// faithfully node by node and still not achieve the goal. Each reviewer only ever saw one node's
// criteria; nobody has yet asked "is the thing the user wanted actually done". So this session gets
// the original goal, the approved plan, the whole diff, every attempt verdict, and the exclusions —
// and it is asked to REFUTE completion, not to confirm it.
//
// THREE OUTCOMES, AND THE THIRD IS THE IMPORTANT ONE.
//
//   approved              → the exit check runs, and only then may the run say `done`
//   rejected-in-scope     → an approved criterion is not actually met; its OWNER NODE reopens, using
//                           the criterion→owner map bound in the envelope
//   rejected-scope-change → what is missing was never in the approved plan. This does NOT become a
//                           correction: it invalidates approval and returns to planning, because
//                           quietly widening the work is how an approved change becomes an
//                           unapproved one.
//
// Dressing a scope change up as a correction is the specific failure this distinction exists to
// prevent, which is why the verifier has to declare which it is and the engine acts on the
// declaration rather than inferring it.
//
// `plan.json` IS NEVER MUTATED AFTER APPROVAL. A reopen changes node STATE in `run.json`; the graph
// the operator approved stays byte-identical, so its digest keeps meaning something.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { join } from 'node:path';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { bangkokTimestamp, checkEvents } from '../run-events/store.mjs';
import { resolveFamily } from '../cli-executor-lifecycle/profiles.mjs';
import { invokeExecutor } from '../cli-executor-lifecycle/invoke.mjs';
import { canonicalEnvelope, validateFinalVerdict } from './schema.mjs';
import { allNodesComplete } from './graph.mjs';
import { FINAL_OUTPUT_SCHEMA, selectIndependentExecutor, writeSchemaFile } from './planner.mjs';
import { boundEvidence } from './reviewer.mjs';
import { RELATIVE } from './commands.mjs';
import { mkdirp, writeJson } from './store.mjs';
import { nodeStates, reopenNode, toDone, toNeedsUser, toPlanning, toRunning } from './state-machine.mjs';
import { commitTransition, runTests } from './runner.mjs';
import { checkoutsFor, collectDelta } from './evidence.mjs';

/**
 * The final verification prompt.
 *
 * It asks for refutation explicitly, and it hands over the exclusions — because the difference
 * between "we did not do this" and "we failed to do this" is exactly what the operator needs, and
 * only the approved `out_of_scope` list can settle it.
 *
 * @param {{goal: string, plan: object, diff: string, testOutput: string,
 *          attemptSummaries: string[], criteria: {id: string, text: string, owner: string}[]}} input
 * @returns {string}
 */
export function buildFinalVerifyPrompt(input) {
  const lines = [];
  lines.push('You are the final check on a completed piece of work, in a READ-ONLY session. You did');
  lines.push('not write any of it, and you did not review the individual steps.');
  lines.push('');
  lines.push('Your job is to TRY TO REFUTE the claim that this goal is done. Every step already passed');
  lines.push('its own review, so "each part looks fine" is not the question — the question is whether');
  lines.push('the thing the user asked for is actually true of this repository now. Return ONE JSON');
  lines.push('document matching the provided schema, and no prose outside it.');
  lines.push('');
  lines.push('## The goal, as originally stated');
  lines.push('');
  lines.push(input.goal);
  lines.push('');
  lines.push('## The criteria that were approved');
  lines.push('');
  lines.push('Every one of these was accepted by a step reviewer. Check them yourself against the');
  lines.push('repository — a criterion someone else marked met is a claim, not evidence:');
  lines.push('');
  for (const c of input.criteria) {
    lines.push(`  - ${c.id} (node ${c.owner}): ${c.text}`);
  }
  lines.push('');
  lines.push('## What was explicitly OUT of scope');
  lines.push('');
  const oos = Array.isArray(input.plan?.out_of_scope) ? input.plan.out_of_scope : [];
  if (oos.length === 0) {
    lines.push('  (nothing was declared out of scope)');
  } else {
    for (const o of oos) lines.push(`  - ${o}`);
  }
  lines.push('');
  lines.push('Something missing because it is on that list is NOT a failure. Say so rather than');
  lines.push('reporting it as one.');
  lines.push('');
  lines.push('## What the steps reported');
  lines.push('');
  for (const s of input.attemptSummaries) lines.push(`  - ${s}`);
  lines.push('');
  lines.push('## The complete change');
  lines.push('');
  lines.push('```diff');
  lines.push(boundEvidence(input.diff) || '(no changes were made)');
  lines.push('```');
  lines.push('');
  if (input.testOutput) {
    lines.push('## Output of the plan\'s test commands, run just now');
    lines.push('');
    lines.push('```');
    lines.push(boundEvidence(input.testOutput));
    lines.push('```');
    lines.push('');
  }
  lines.push('## Which verdict to return');
  lines.push('');
  lines.push('- `approved` — you tried to refute it and could not. Every approved criterion holds');
  lines.push('  against the repository, and your `evidence` says how you checked.');
  lines.push('- `rejected-in-scope` — an approved criterion is NOT actually met. List the exact');
  lines.push('  criterion ids in `failed_criteria`; those ids are what reopens the responsible work,');
  lines.push('  so a rejection without them cannot be acted on.');
  lines.push('- `rejected-scope-change` — what is missing was never in the approved plan. Use this');
  lines.push('  when fixing it would mean doing work nobody approved, and say why in');
  lines.push('  `scope_change_reason`. Do NOT report it as `rejected-in-scope` to get it fixed');
  lines.push('  quietly: that turns an approved change into an unapproved one.');
  lines.push('');
  lines.push('Read files. Run nothing. Do not assume a passing test suite proves the goal — check');
  lines.push('that the tests actually cover the criteria they are cited for.');
  return lines.join('\n');
}

/**
 * The exit check: the mechanical facts that must hold before `done`, independent of any model.
 *
 * A verdict is a judgement; these are checks. Both are required, because a verifier can be wrong
 * about the tree and a green tree can still be missing a node.
 *
 * @param {{repoRoot: string, runDir: string, state: object, plan: object, envelope: object,
 *          testOutput?: string, testsOk?: boolean}} input
 * @returns {{ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}}
 */
export function runExitCheck(input) {
  const { state, plan } = input;
  /** @type {{name: string, ok: boolean, detail: string}[]} */
  const checks = [];

  const complete = allNodesComplete(plan, nodeStates(state));
  checks.push({
    name: 'every node complete',
    ok: complete,
    detail: complete
      ? `${Object.keys(state.nodes || {}).length} node(s) completed`
      : 'at least one node is not complete',
  });

  const noDivergence = !state.divergence;
  checks.push({
    name: 'state and event sidecar agree',
    ok: noDivergence,
    detail: noDivergence ? 'no divergence recorded' : `diverged on '${state.divergence.event}'`,
  });

  // The sidecar's own integrity check — sequence continuity, no duplicate ids, no truncated tail.
  let sidecar = { ok: false, detail: 'not checked' };
  try {
    const result = checkEvents(input.runDir);
    const problems = Array.isArray(result?.errors) ? result.errors : [];
    sidecar = {
      ok: problems.length === 0,
      detail: problems.length === 0 ? 'sidecar is internally consistent' : problems.join('; '),
    };
  } catch (err) {
    sidecar = { ok: false, detail: `sidecar check failed: ${err.message}` };
  }
  checks.push({ name: 'event sidecar is consistent', ok: sidecar.ok, detail: sidecar.detail });

  const approved = Boolean(state.approved_envelope_digest);
  checks.push({
    name: 'an approved envelope is still bound',
    ok: approved,
    detail: approved ? state.approved_envelope_digest.slice(0, 16) + '…' : 'no approval on record',
  });

  if (input.testsOk !== undefined) {
    checks.push({
      name: "the plan's test commands pass",
      ok: input.testsOk === true,
      detail: input.testsOk ? 'all green' : 'at least one command failed — see the report',
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Every acceptance criterion in the approved plan, with its owner.
 *
 * Read from the ENVELOPE's criterion map rather than from the plan, so a criterion whose ownership
 * changed after approval cannot silently reopen a different node.
 *
 * @param {object} plan
 * @param {object} envelope
 * @returns {{id: string, text: string, owner: string}[]}
 */
export function approvedCriteria(plan, envelope) {
  const owners = canonicalEnvelope(envelope).criterion_owners || {};
  /** @type {Map<string, string>} */
  const texts = new Map();
  for (const node of plan.nodes || []) {
    for (const c of node.acceptance || []) texts.set(c.id, c.text);
  }
  return Object.entries(owners).map(([id, owner]) => ({ id, owner, text: texts.get(id) ?? '(text unavailable)' }));
}

/**
 * One-line summaries of every attempt, for the verifier and the report.
 *
 * @param {object} state
 * @returns {string[]}
 */
export function attemptSummaries(state) {
  /** @type {string[]} */
  const out = [];
  for (const [nodeId, rec] of Object.entries(state.nodes || {})) {
    for (const a of rec.attempts || []) {
      const outcome = a.result === 'passed' ? 'accepted' : `${a.result}${a.error ? `: ${a.error}` : ''}`;
      out.push(`${nodeId} attempt ${a.n} (${a.executor} · ${a.tier}) — ${outcome}`);
    }
  }
  return out.length > 0 ? out : ['(no attempts recorded)'];
}

/**
 * Run final verification and act on the verdict.
 *
 * @param {object} input
 * @returns {Promise<{state: object, outcome: string, detail: string, verdict: object|null}>}
 */
export async function runFinalVerification(input) {
  const { repoRoot, runDir, plan, envelope, executors } = input;
  let state = input.state;
  const log = input.log || (() => {});
  const now = input.now || Date.now;
  const invoke = input.invoke || invokeExecutor;
  const finalDir = join(runDir, 'final');
  mkdirp(finalDir);

  const canonical = canonicalEnvelope(envelope);
  const criteria = approvedCriteria(plan, canonical);

  // The whole change, per approved checkout, and the plan's tests re-run now rather than trusted from
  // a step.
  //
  // EVERY checkout, not the first one. A plan spanning a service's own repository and the outer one has
  // two base commits, and asking the outer repository for a diff against the FIRST recorded base is
  // wrong twice over: the range is meaningless in the other repository, and the nested tree's real
  // change appears as a single dirty-gitlink line. Each checkout is baselined at its own approved base
  // commit and diffed on its own, and the verifier sees which section came from where.
  const baseline = {
    at_head: {},
    checkouts: checkoutsFor(canonical).map((c) => {
      const approved = (canonical.checkouts || []).find((x) => x.path === c.path);
      return {
        path: c.path,
        abs: c.abs || (c.path === '.' ? repoRoot : join(repoRoot, c.path)),
        head: approved?.base_commit ?? null,
        // Empty: at final verification the question is what changed since the APPROVED BASE COMMIT,
        // which includes everything the run's own attempts left uncommitted.
        entries: {},
      };
    }),
  };
  const delta = collectDelta(repoRoot, baseline);
  const diff = delta.diff;
  const allTests = [...new Set((plan.nodes || []).flatMap((n) => n.tests || []))];
  const tests = runTests(repoRoot, allTests, canonical.action_policy?.allowed_test_commands || []);
  writeAtomic(join(finalDir, 'tests.log'), tests.output || '(no test commands in the plan)\n');
  writeAtomic(join(finalDir, 'change.diff'), diff || '(no changes)\n');
  writeJson(join(finalDir, 'changed-paths.json'), {
    derived_from: 'git, per approved checkout, against each checkout\'s approved base commit',
    changed: delta.changed,
    sections: delta.sections.map((s) => ({
      checkout: s.checkout, head_before: s.head_before, head_now: s.head_now, changed: s.changed.length,
    })),
  });

  // The verifier avoids the family that did the most implementation work, and runs at the top tier
  // where one is mapped — this is the last chance to catch a wrong result.
  const implementFamilies = new Set(
    Object.values(state.nodes || {})
      .flatMap((rec) => rec.attempts || [])
      .map((a) => a.family)
      .filter(Boolean),
  );
  let seat;
  for (const tier of ['top', 'high']) {
    try {
      seat = selectIndependentExecutor({
        executors,
        prefer: input.prefer,
        role: 'final-verify',
        tier,
        avoidFamily: [...implementFamilies][0] ?? null,
        familyOf: resolveFamily,
      });
      seat.tier = tier;
      break;
    } catch {
      seat = null;
    }
  }
  if (!seat) {
    state = commitTransition(runDir, toNeedsUser(state, {
      reason: 'no configured executor can perform the final verification',
      findings: ['final verification needs a top or high tier seat in plan/read-only mode'],
      next: "register one: cli-executor register <name> --model-high <id>",
    }));
    return { state, outcome: 'blocked', detail: 'no verifier available', verdict: null };
  }

  const prompt = buildFinalVerifyPrompt({
    goal: plan.goal,
    plan,
    diff,
    testOutput: tests.output,
    attemptSummaries: attemptSummaries(state),
    criteria,
  });
  writeAtomic(join(finalDir, 'brief.md'), `${prompt}\n`);
  log(
    `goal: final verification by ${seat.name} · ${seat.tier} (${seat.family ?? '?'})`
    + `${seat.same_family_fallback ? ' — SAME FAMILY fallback, recorded' : ''}`,
  );

  const schema = writeSchemaFile(runDir, 'final', FINAL_OUTPUT_SCHEMA);
  const result = await invoke({
    name: seat.name,
    spec: seat.spec,
    role: 'final-verify',
    tier: seat.tier,
    prompt,
    cwd: repoRoot,
    schemaPath: schema.path,
    schemaJson: schema.json,
    timeoutMs: Number(canonical.budgets?.max_wall_clock_ms_per_attempt) || undefined,
  });
  writeAtomic(
    join(finalDir, 'transcript.log'),
    `${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}\n`,
  );

  const check = validateFinalVerdict(result.result, criteria.map((c) => c.id));
  if (!check.ok) {
    writeJson(join(finalDir, 'verdict.json'), { unusable: true, errors: check.errors });
    state = commitTransition(runDir, toNeedsUser(state, {
      reason: 'the final verifier returned no usable verdict, so completion cannot be claimed',
      findings: check.errors,
      next: `sidekicks goal resume ${state.run_id}  (re-runs the final check)`,
    }));
    return { state, outcome: 'blocked', detail: 'unusable final verdict', verdict: null };
  }

  const verdict = {
    ...result.result,
    verifier: {
      executor: seat.name,
      family: seat.family,
      tier: seat.tier,
      same_family_fallback: seat.same_family_fallback,
    },
    at: bangkokTimestamp(now()),
  };
  writeJson(join(finalDir, 'verdict.json'), verdict);

  // ---- rejected: scope change → back to planning, approval invalidated -------------------------
  if (verdict.result === 'rejected-scope-change') {
    log(`goal: final verification found a SCOPE CHANGE — ${verdict.scope_change_reason}`);
    state = commitTransition(runDir, toPlanning(state, {
      reason: `final verification found a scope change: ${verdict.scope_change_reason}`,
    }));
    return {
      state,
      outcome: 'replan',
      detail: verdict.scope_change_reason,
      verdict,
    };
  }

  // ---- rejected in scope → reopen the owner node from the APPROVED map --------------------------
  if (verdict.result === 'rejected-in-scope') {
    const owners = canonical.criterion_owners || {};
    const reopened = [];
    for (const id of verdict.failed_criteria || []) {
      const owner = owners[id];
      if (!owner) continue;
      reopenNode(state, { node: owner, reason: `final verification refuted ${id}` });
      reopened.push(`${id} → node ${owner}`);
    }
    if (reopened.length === 0) {
      state = commitTransition(runDir, toNeedsUser(state, {
        reason: 'the final verifier rejected criteria that map to no node in the approved envelope',
        findings: (verdict.failed_criteria || []).map((id) => `${id} has no owner node`),
        next: 're-plan; the criterion map and the plan have diverged',
      }));
      return { state, outcome: 'blocked', detail: 'rejected criteria with no owner', verdict };
    }
    log(`goal: final verification reopened ${reopened.join(', ')}`);
    state = commitTransition(runDir, toRunning(state, {
      reason: `final verification refuted ${verdict.failed_criteria.join(', ')}`,
    }));
    return { state, outcome: 'reopened', detail: reopened.join(', '), verdict };
  }

  // ---- approved → the exit check decides whether `done` is legal --------------------------------
  const exit = runExitCheck({
    repoRoot,
    runDir,
    state,
    plan,
    envelope: canonical,
    testsOk: allTests.length > 0 ? tests.ok : undefined,
  });
  writeJson(join(finalDir, 'exit-check.json'), exit);

  if (!exit.ok) {
    const failed = exit.checks.filter((c) => !c.ok);
    state = commitTransition(runDir, toNeedsUser(state, {
      reason: 'the final verifier approved the work, but the exit check did not pass',
      findings: failed.map((c) => `${c.name}: ${c.detail}`),
      next: 'the verdict is a judgement and the exit check is a fact — both are required for done',
    }));
    return { state, outcome: 'blocked', detail: 'exit check failed', verdict };
  }

  state = commitTransition(runDir, toDone(state, {
    verdict,
    at: verdict.at,
    exit_check: exit,
  }));
  log('goal: final verification APPROVED and the exit check passed — done');
  return { state, outcome: 'done', detail: 'approved and exit-checked', verdict };
}

/**
 * A short, honest note about the verifier's independence, for the report.
 *
 * @param {object} verdict
 * @returns {string}
 */
export function verifierNote(verdict) {
  const v = verdict?.verifier;
  if (!v) return 'no final verifier ran';
  return v.same_family_fallback
    ? `${v.executor} · ${v.tier} (${v.family}) — SAME model family as the implementation, because no `
      + 'other family was configured; treat its independence as reduced'
    : `${v.executor} · ${v.tier} (${v.family}) — a different model family from the implementation`;
}

/** Where the final artifacts live, relative to a run folder. */
export function finalPaths(runDir) {
  return {
    dir: join(runDir, 'final'),
    brief: join(runDir, 'final', 'brief.md'),
    verdict: join(runDir, 'final', 'verdict.json'),
    exitCheck: join(runDir, 'final', 'exit-check.json'),
    diff: join(runDir, 'final', 'change.diff'),
    tests: join(runDir, 'final', 'tests.log'),
    transcript: join(runDir, 'final', 'transcript.log'),
    report: join(runDir, 'final', 'report.md'),
  };
}

/** Repo-relative paths of the final artifacts, for a report that must stay portable. */
export function finalPathsRelative(runDir) {
  const p = finalPaths(runDir);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(p)) out[key] = RELATIVE(runDir, value);
  return out;
}
