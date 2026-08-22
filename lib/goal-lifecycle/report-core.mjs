// lib/goal-lifecycle/report-core.mjs
// The evidence report: what was observed, kept apart from what was claimed.
//
// THE SEPARATION IS THE WHOLE DESIGN. A run produces two very different kinds of statement, and
// blending them is how a report becomes reassuring instead of useful:
//
//   OBSERVED — facts this engine established itself: which files changed, what a command's exit code
//              was, which branch and commit each checkout was on, how many attempts ran, what each
//              session cost. These are checkable without trusting a model.
//   CLAIMED  — what a model said: a reviewer's "met", the final verifier's "approved", an
//              implementer's summary. Every one is attributed to the seat that said it.
//
// So a reader can always tell "the tests exited 0" from "the reviewer believes the criterion is met",
// and a claim never borrows the authority of a fact.
//
// WHAT THE REPORT REFUSES TO SMOOTH OVER. Same-family fallbacks (where independence was reduced
// because only one CLI family was configured). Exclusions (what the plan deliberately did not do).
// Unresolved gaps. Truncated evidence. Best-effort cost figures that some CLIs simply do not report.
// Each of those is a thing a reader would otherwise assume in the flattering direction.
//
// Pure string and object building — no filesystem, no clock. Zero npm dependencies.

/**
 * Build the report model — the structured facts, before any rendering.
 *
 * @param {{state: object, plan: object, envelope: object, goal: object, verdict: object|null,
 *          exitCheck: object|null, contest: object|null, runDirRel: string}} input
 * @returns {object}
 */
export function buildReportModel(input) {
  const { state, plan, envelope } = input;

  /** @type {object[]} */
  const attempts = [];
  for (const [nodeId, rec] of Object.entries(state.nodes || {})) {
    for (const a of rec.attempts || []) {
      attempts.push({
        node: nodeId,
        n: a.n,
        executor: a.executor,
        family: a.family,
        tier: a.tier,
        model: a.model,
        result: a.result,
        exit_code: a.exit_code,
        error: a.error,
        transcript: a.transcript,
        review: a.review,
        session_resumed: Boolean(a.session_id) && a.n > 1,
      });
    }
  }

  const sameFamilyFallbacks = [];
  if (input.verdict?.verifier?.same_family_fallback) {
    sameFamilyFallbacks.push(
      `final verification ran on ${input.verdict.verifier.family}, the same family as the `
      + 'implementation — no other family was configured',
    );
  }

  return {
    run_id: state.run_id,
    run_dir: input.runDirRel,
    phase: state.phase,
    goal: input.goal?.goal ?? plan?.goal ?? '(unknown)',
    created_at: state.created_at,
    updated_at: state.updated_at,

    // ---- observed ------------------------------------------------------------------------------
    observed: {
      checkouts: (envelope.checkouts || []).map((c) => ({
        path: c.path,
        branch: c.branch,
        base_commit: c.base_commit,
      })),
      write_roots: envelope.write_roots || [],
      nodes: Object.fromEntries(
        Object.entries(state.nodes || {}).map(([id, rec]) => [id, {
          state: rec.state,
          attempts: rec.attempt_count,
          last_error: rec.last_error,
        }]),
      ),
      attempts,
      spent: state.spent || {},
      breaker: state.breaker || {},
      transitions: state.sequence ?? 0,
      approvals: state.approvals || [],
      action_grants: state.action_grants || [],
      exit_check: input.exitCheck ?? null,
      divergence: state.divergence ?? null,
    },

    // ---- claimed -------------------------------------------------------------------------------
    claimed: {
      final_verdict: input.verdict
        ? {
          result: input.verdict.result,
          summary: input.verdict.summary,
          evidence: input.verdict.evidence || [],
          failed_criteria: input.verdict.failed_criteria || [],
          scope_change_reason: input.verdict.scope_change_reason ?? null,
          by: input.verdict.verifier ?? null,
        }
        : null,
      criteria: (plan?.nodes || []).flatMap((n) => (n.acceptance || []).map((c) => ({
        id: c.id,
        node: n.id,
        text: c.text,
      }))),
      plan_decisions: plan?.decisions || [],
      assumptions: plan?.assumptions || [],
    },

    // ---- routing -------------------------------------------------------------------------------
    routing: (envelope.routing || []).map((r) => ({
      node: r.node, executor: r.executor, family: r.family, tier: r.tier,
    })),

    // ---- the things a reader would otherwise assume favourably ---------------------------------
    exclusions: plan?.out_of_scope || [],
    same_family_fallbacks: sameFamilyFallbacks,
    gaps: collectGaps(input),
    contest: input.contest ?? null,
  };
}

/**
 * Unresolved gaps — stated, not smoothed over.
 *
 * @param {object} input
 * @returns {string[]}
 */
export function collectGaps(input) {
  const { state, plan } = input;
  /** @type {string[]} */
  const gaps = [];

  for (const [id, rec] of Object.entries(state.nodes || {})) {
    if (rec.state !== 'completed') {
      gaps.push(`node ${id} is ${rec.state}${rec.last_error ? ` — ${rec.last_error}` : ''}`);
    }
  }
  for (const node of plan?.nodes || []) {
    if (!state.nodes?.[node.id]) {
      gaps.push(`node ${node.id} (${node.title}) was never dispatched`);
    }
  }
  if (state.needs_user) {
    gaps.push(`the run is waiting on a human: ${state.needs_user.reason}`);
  }
  if (state.action_request) {
    gaps.push(
      `an action is held pending a grant: ${state.action_request.action_class} on `
      + `${state.action_request.target}`,
    );
  }
  if (state.divergence) {
    gaps.push(`the event sidecar diverged on '${state.divergence.event}' and was reconciled or halted`);
  }
  if ((state.spent?.tokens ?? null) === null) {
    gaps.push(
      'token and cost figures are unavailable: the executors used did not report them, so the only '
      + 'measured spend is attempts and wall clock',
    );
  }
  const noTests = (plan?.nodes || []).filter((n) => (n.tests || []).length === 0).map((n) => n.id);
  if (noTests.length > 0) {
    gaps.push(
      `node(s) ${noTests.join(', ')} named no test commands, so their criteria rest on review `
      + 'judgement rather than a command exit code',
    );
  }
  return gaps;
}

/**
 * Render the report as markdown.
 *
 * @param {object} model - from buildReportModel
 * @returns {string}
 */
export function renderReport(model) {
  const lines = [];
  const done = model.phase === 'done';

  lines.push('---');
  lines.push(`run_id: ${model.run_id}`);
  lines.push(`phase: ${model.phase}`);
  lines.push(`generated_from: run.json`);
  lines.push('---');
  lines.push('');
  lines.push(`# Goal run ${model.run_id}`);
  lines.push('');
  lines.push(`**${done ? 'Completed' : `Not completed — phase \`${model.phase}\``}.**`);
  lines.push('');
  lines.push('## Goal');
  lines.push('');
  lines.push(model.goal);
  lines.push('');

  // ---- the headline claim, attributed ----------------------------------------------------------
  lines.push('## Final verdict (a claim, by a model)');
  lines.push('');
  if (!model.claimed.final_verdict) {
    lines.push('No final verification has run, so nothing has judged this goal complete.');
  } else {
    const v = model.claimed.final_verdict;
    lines.push(`**${v.result}** — ${v.summary}`);
    lines.push('');
    lines.push(`Verified by: ${v.by ? `${v.by.executor} · ${v.by.tier} (${v.by.family})` : 'unknown'}`);
    lines.push('');
    lines.push('Evidence the verifier cited:');
    lines.push('');
    for (const e of v.evidence) lines.push(`- ${e}`);
    if (v.failed_criteria.length > 0) {
      lines.push('');
      lines.push(`Criteria it refuted: ${v.failed_criteria.join(', ')}`);
    }
    if (v.scope_change_reason) {
      lines.push('');
      lines.push(`Scope change: ${v.scope_change_reason}`);
    }
  }
  lines.push('');

  // ---- the mechanical facts --------------------------------------------------------------------
  lines.push('## Exit check (facts, not judgement)');
  lines.push('');
  if (!model.observed.exit_check) {
    lines.push('The exit check has not run.');
  } else {
    lines.push('| check | result | detail |');
    lines.push('|---|---|---|');
    for (const c of model.observed.exit_check.checks) {
      lines.push(`| ${c.name} | ${c.ok ? 'pass' : '**FAIL**'} | ${c.detail} |`);
    }
  }
  lines.push('');

  lines.push('## What was observed');
  lines.push('');
  lines.push('Checkouts written to, as they were when the run was approved:');
  lines.push('');
  for (const c of model.observed.checkouts) {
    lines.push(`- \`${c.path}\` on \`${c.branch}\` at \`${String(c.base_commit).slice(0, 12)}\``);
  }
  lines.push('');
  lines.push(`Write roots: ${model.observed.write_roots.map((r) => `\`${r}\``).join(', ') || '(none)'}`);
  lines.push('');
  lines.push('| node | state | attempts | last error |');
  lines.push('|---|---|---:|---|');
  for (const [id, n] of Object.entries(model.observed.nodes)) {
    lines.push(`| \`${id}\` | ${n.state} | ${n.attempts} | ${n.last_error ?? '—'} |`);
  }
  lines.push('');

  lines.push('### Every attempt, with its routing');
  lines.push('');
  lines.push('| node | # | executor · tier | model | result | evidence |');
  lines.push('|---|---:|---|---|---|---|');
  for (const a of model.observed.attempts) {
    const evidence = [a.transcript, a.review].filter(Boolean).map((p) => `\`${p}\``).join('<br>') || '—';
    lines.push(
      `| \`${a.node}\` | ${a.n} | ${a.executor} · ${a.tier}${a.family ? ` (${a.family})` : ''} `
      + `| ${a.model ?? '—'} | ${a.result}${a.error ? ` — ${a.error}` : ''} | ${evidence} |`,
    );
  }
  lines.push('');

  const spent = model.observed.spent;
  lines.push('### Spend');
  lines.push('');
  lines.push(`- attempts: ${spent.attempts ?? 0}`);
  lines.push(`- wall clock: ${Math.round((spent.wall_clock_ms ?? 0) / 1000)}s`);
  lines.push(
    `- tokens: ${spent.tokens ?? 'not reported by these executors'}`,
  );
  lines.push(`- cost: ${spent.usd != null ? `$${Number(spent.usd).toFixed(4)}` : 'not reported by these executors'}`);
  lines.push('');
  lines.push('Attempts and wall clock are the ENFORCED budget floors — every executor exposes both.');
  lines.push('Token and dollar figures are best-effort and are reported, never enforced.');
  lines.push('');

  if (model.observed.approvals.length > 0) {
    lines.push('### Approvals');
    lines.push('');
    for (const a of model.observed.approvals) {
      lines.push(
        `- ${a.kind} at ${a.at} — \`${String(a.digest).slice(0, 16)}…\``
        + `${a.changed?.length ? ` (changed: ${a.changed.join(', ')})` : ''}`,
      );
    }
    lines.push('');
  }

  if (model.observed.action_grants.length > 0) {
    lines.push('### Actions granted separately');
    lines.push('');
    lines.push('Goal approval did not cover these. Each was held, shown to the operator, and granted');
    lines.push('by its own digest:');
    lines.push('');
    for (const g of model.observed.action_grants) {
      lines.push(`- ${g.action_class} on \`${g.target}\` (node ${g.node}) at ${g.granted_at}`);
    }
    lines.push('');
  }

  lines.push('## Routing');
  lines.push('');
  lines.push('| node | executor | family | tier |');
  lines.push('|---|---|---|---|');
  for (const r of model.routing) {
    lines.push(`| \`${r.node}\` | ${r.executor} | ${r.family || '—'} | ${r.tier} |`);
  }
  lines.push('');

  if (model.same_family_fallbacks.length > 0) {
    lines.push('## Reduced independence');
    lines.push('');
    lines.push('Independence was compromised in the following places. This is reported rather than');
    lines.push('hidden, because a review by the same model family as the implementation is weaker');
    lines.push('evidence than one by a different family:');
    lines.push('');
    for (const f of model.same_family_fallbacks) lines.push(`- ${f}`);
    lines.push('');
  }

  lines.push('## Explicitly not done');
  lines.push('');
  if (model.exclusions.length === 0) {
    lines.push('The plan declared nothing out of scope.');
  } else {
    lines.push('These were excluded by the approved plan. They are not failures:');
    lines.push('');
    for (const e of model.exclusions) lines.push(`- ${e}`);
  }
  lines.push('');

  lines.push('## Unresolved gaps');
  lines.push('');
  if (model.gaps.length === 0) {
    lines.push('None identified.');
  } else {
    for (const g of model.gaps) lines.push(`- ${g}`);
  }
  lines.push('');

  if (model.contest) {
    lines.push('## How the plan was chosen');
    lines.push('');
    if (model.contest.degraded_reason) {
      lines.push(`A single planner wrote it. ${model.contest.degraded_reason}`);
    } else {
      lines.push('| family | executor · tier | score | verdict |');
      lines.push('|---|---|---:|---|');
      for (const c of model.contest.candidates || []) {
        lines.push(
          `| ${c.family} | ${c.executor} · ${c.tier} | ${c.score ?? '—'} `
          + `| ${c.disqualified ? `disqualified: ${c.disqualified}` : (c.winner ? '**winner**' : 'scored')} |`,
        );
      }
    }
    lines.push('');
  }

  lines.push('## Criteria that were approved');
  lines.push('');
  lines.push('| id | node | criterion |');
  lines.push('|---|---|---|');
  for (const c of model.claimed.criteria) {
    lines.push(`| \`${c.id}\` | \`${c.node}\` | ${c.text} |`);
  }
  lines.push('');

  if (model.claimed.assumptions.length > 0) {
    lines.push('## Assumptions the plan rested on');
    lines.push('');
    for (const a of model.claimed.assumptions) lines.push(`- ${a}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`Run artifacts: \`${model.run_dir}\``);
  return `${lines.join('\n')}\n`;
}
