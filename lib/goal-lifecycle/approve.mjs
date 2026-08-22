// lib/goal-lifecycle/approve.mjs
// `sidekicks goal approve <run-id> --digest <sha256>` — the gate no subprocess starts before.
//
// THE DIGEST IS THE WHOLE POINT. The user does not approve "the run" or "the plan"; they approve one
// exact canonical approval envelope, identified by its SHA-256. The verb recomputes that digest from
// what is on disk and refuses anything else — so a plan edited after the summary was printed, a
// branch that moved, a base commit that advanced, or a routing change all fail the gate instead of
// riding in on a stale approval.
//
// THE AMENDMENT PATH, AND WHY IT IS NARROW. Budgets are bound by the envelope, which creates a real
// conflict: raising an exhausted attempt limit would invalidate approval and throw away every node
// already completed. So a run sitting in `needs_user` may be approved AGAIN with a new envelope that
// differs ONLY in budget fields — recorded as an append-only amendment, with node state preserved.
// A new envelope differing in anything else (target, nodes, routing, write roots, action policy,
// criterion ownership) is refused and needs re-planning. `classifyAmendment` in schema.mjs is what
// decides which it is; this verb never eyeballs the diff itself.
//
// TWO STEPS, DELIBERATELY. An amendment is proposed first (budget flags, no digest) and approved
// second (the digest it printed). A one-step form would mean the operator approves a digest they have
// not seen, which is the same as not having a digest.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { bangkokTimestamp } from '../run-events/store.mjs';
import {
  DIGEST_RE,
  canonicalEnvelope,
  classifyAmendment,
  envelopeDigest,
  validateEnvelope,
} from './schema.mjs';
import {
  RELATIVE,
  assertPhase,
  captureDirtyBaseline,
  flagString,
  goalPositionals,
  loadRun,
  parseGoalFlags,
  resolveWriteOwners,
} from './commands.mjs';
import { goalPaths, readJsonIfPresent, writeJson } from './store.mjs';
import { approveEnvelope, toRunning } from './state-machine.mjs';
import { commit } from './plan.mjs';

const BOOLEANS = ['json'];

/** Budget flags an amendment may change, mapped to their envelope fields. */
const BUDGET_FLAGS = Object.freeze({
  'max-attempts': 'max_attempts_per_node',
  'max-total-attempts': 'max_total_attempts',
  'max-attempt-ms': 'max_wall_clock_ms_per_attempt',
  'max-total-ms': 'max_wall_clock_ms_total',
  breaker: 'max_consecutive_failures',
});

/**
 * Run `goal approve`.
 *
 * @param {{repoRoot: string, argv: string[], flags: object, log: Function}} ctx
 * @param {object} _args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, _args) {
  const flags = parseGoalFlags(ctx.argv, BOOLEANS);
  const positionals = goalPositionals(ctx.argv, BOOLEANS);
  const runId = positionals[0];
  if (!runId) {
    throw new SidekicksError(
      'goal approve: usage: goal approve <run-id> --digest <sha256>\n'
      + '  to raise a budget on a blocked run, first propose it:\n'
      + '    goal approve <run-id> [--max-attempts N] [--max-total-attempts N] [--breaker N] '
      + '[--max-attempt-ms N] [--max-total-ms N]',
      EXIT_USAGE,
    );
  }

  const { runDir, state } = loadRun(ctx.repoRoot, runId);
  const digest = flagString(flags.digest);

  const budgetChanges = {};
  for (const [flag, field] of Object.entries(BUDGET_FLAGS)) {
    const value = flagString(flags[flag]);
    if (value === '') continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
      throw new SidekicksError(
        `goal approve: --${flag} must be a non-negative integer (0 = unbounded), got '${value}'`,
        EXIT_VALIDATION,
      );
    }
    budgetChanges[field] = n;
  }
  const hasBudgetChanges = Object.keys(budgetChanges).length > 0;

  if (hasBudgetChanges) {
    return amend(ctx, { runDir, state, digest, budgetChanges, flags });
  }

  // ---- the ordinary approval ------------------------------------------------------------------
  assertPhase(state, ['awaiting_approval'], 'approve');

  if (!DIGEST_RE.test(digest)) {
    throw new SidekicksError(
      'goal approve: --digest <sha256> is required and must be the 64-character digest `goal plan` '
      + 'printed. Approving without naming the exact envelope would defeat the gate.',
      EXIT_USAGE,
    );
  }

  const onDisk = canonicalEnvelope(readJsonIfPresent(goalPaths(runDir).envelope) ?? state.envelope);
  const check = validateEnvelope(onDisk);
  if (!check.ok) {
    throw new SidekicksError(
      `goal approve: the stored approval envelope is not valid (${check.errors.join('; ')}) — re-plan`,
      EXIT_VALIDATION,
    );
  }
  const actual = envelopeDigest(onDisk);
  if (actual !== digest) {
    throw new SidekicksError(
      `goal approve: digest mismatch.\n  you approved: ${digest}\n  on disk now:  ${actual}\n`
      + '  The envelope changed after the summary was printed — a plan edit, a branch move, or an\n'
      + "  advanced base commit all do this. Re-read 'goal status' and approve the current digest,\n"
      + '  or re-plan. Approval is never granted to a digest the operator did not see.',
      EXIT_VALIDATION,
    );
  }

  // Freeze what was ALREADY someone else's uncommitted work, at the moment of approval. Every later
  // attempt is compared against this rather than against "is the tree dirty" — otherwise the first
  // attempt's own change would block the second one.
  state.baseline = {
    captured_at: bangkokTimestamp(Date.now()),
    dirty_tracked: captureDirtyBaseline(
      ctx.repoRoot,
      resolveWriteOwners(ctx.repoRoot, (onDisk.write_roots || []).concat(
        (onDisk.checkouts || []).map((c) => c.path),
      )),
    ),
  };

  const next = commit(runDir, state, approveEnvelope(state, {
    digest: actual,
    at: bangkokTimestamp(Date.now()),
    kind: 'initial',
  }));

  return report(ctx, runDir, next, flags, {
    headline: `approved — ${next.run_id} may now dispatch implementation`,
    next: `sidekicks goal run ${next.run_id}`,
  });
}

/**
 * The budget amendment path: propose, then approve.
 *
 * @param {object} ctx
 * @param {{runDir: string, state: object, digest: string, budgetChanges: object, flags: object}} input
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
function amend(ctx, input) {
  const { runDir, state, budgetChanges, flags } = input;

  // An amendment is for a run that STOPPED because a budget ran out. Offering it in any other phase
  // would let an operator quietly widen a running run's limits mid-flight.
  assertPhase(state, ['needs_user', 'stopped'], 'approve --max-*');

  const current = canonicalEnvelope(readJsonIfPresent(goalPaths(runDir).envelope) ?? state.envelope);
  if (!current || !current.plan_digest) {
    throw new SidekicksError(
      'goal approve: this run has no approved envelope to amend — approve it normally first',
      EXIT_VALIDATION,
    );
  }

  const proposed = canonicalEnvelope({ ...current, budgets: { ...current.budgets, ...budgetChanges } });
  const classified = classifyAmendment(current, proposed);

  if (classified.kind === 'identical') {
    throw new SidekicksError(
      'goal approve: the proposed budgets match the approved ones — nothing to amend',
      EXIT_VALIDATION,
    );
  }
  if (classified.kind !== 'amendment') {
    // Unreachable via these flags, and kept as the gate's own last check: if a future flag ever
    // touched a non-budget field, this refuses rather than laundering it through the amendment path.
    throw new SidekicksError(
      `goal approve: this would change ${classified.changed.filter((c) => !c.startsWith('budgets.')).join(', ')}, `
      + 'which is not a budget amendment — re-plan instead',
      EXIT_VALIDATION,
    );
  }

  const proposedDigest = envelopeDigest(proposed);

  if (!input.digest) {
    const before = current.budgets;
    const lines = [`goal run ${state.run_id} — proposed budget amendment`, ''];
    for (const [field, value] of Object.entries(budgetChanges)) {
      lines.push(`  ${field}: ${before[field]} → ${value}`);
    }
    lines.push('');
    lines.push('  Nothing else changes: the plan, routing, write roots, base commits, action policy');
    lines.push('  and criterion ownership are all identical, and every completed node is preserved.');
    lines.push('');
    lines.push(`  amended envelope digest: ${proposedDigest}`);
    lines.push('');
    lines.push('  Approve exactly this digest to apply it:');
    lines.push(`    sidekicks goal approve ${state.run_id} --digest ${proposedDigest} \\`);
    lines.push(`      ${Object.entries(budgetChanges).map(([f, v]) => `--${flagFor(f)} ${v}`).join(' ')}`);
    return {
      stdout: flags.json === true
        ? `${JSON.stringify({
          run_id: state.run_id, kind: 'amendment', changed: classified.changed,
          from: before, to: proposed.budgets, envelope_digest: proposedDigest,
        }, null, 2)}\n`
        : `${lines.join('\n')}\n`,
      exitCode: EXIT_OK,
    };
  }

  if (input.digest !== proposedDigest) {
    throw new SidekicksError(
      `goal approve: digest mismatch for the amendment.\n  you approved: ${input.digest}\n`
      + `  proposed now: ${proposedDigest}\n`
      + '  Re-run without --digest to see the current proposal.',
      EXIT_VALIDATION,
    );
  }

  writeJson(goalPaths(runDir).envelope, proposed);
  state.envelope = proposed;

  // The approval history is appended to, not replaced: the record of what was ORIGINALLY approved
  // has to survive every later amendment.
  state.approvals = [
    ...(Array.isArray(state.approvals) ? state.approvals : []),
    {
      digest: proposedDigest,
      kind: 'amendment',
      at: bangkokTimestamp(Date.now()),
      changed: classified.changed,
    },
  ];
  state.approved_envelope_digest = proposedDigest;

  const next = commit(runDir, state, toRunning(state, {
    reason: `budget amended (${classified.changed.join(', ')}); completed node state preserved`,
  }));

  return report(ctx, runDir, next, flags, {
    headline: `amended and resumed — ${classified.changed.join(', ')}`,
    next: `sidekicks goal run ${next.run_id}`,
  });
}

/** The flag name for an envelope budget field, for the copy-pasteable command. */
function flagFor(field) {
  return Object.entries(BUDGET_FLAGS).find(([, f]) => f === field)?.[0] ?? field;
}

/** Common terminal report. */
function report(ctx, runDir, state, flags, meta) {
  const payload = {
    run_id: state.run_id,
    run_dir: RELATIVE(ctx.repoRoot, runDir),
    phase: state.phase,
    approved_envelope_digest: state.approved_envelope_digest,
    approvals: state.approvals,
    next: meta.next,
  };
  if (flags.json === true) {
    return { stdout: `${JSON.stringify(payload, null, 2)}\n`, exitCode: EXIT_OK };
  }
  return {
    stdout: `goal run ${state.run_id} — ${meta.headline}\n\n  phase: ${state.phase}\n  next:  ${meta.next}\n`,
    exitCode: EXIT_OK,
  };
}
