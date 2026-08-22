// lib/goal-lifecycle/approve-action.mjs
// `sidekicks goal approve-action <run-id> <request-id> --digest <sha256>` — grant ONE held action.
//
// GOAL APPROVAL NEVER COVERED THIS. Approving a plan authorizes repository edits inside the bound
// write roots and the test commands the plan named. A push, a deploy, a database write, a package
// publication, a message to anyone — each is a separate blast radius, and each needs its own grant
// naming its own target. That is why this verb exists at all, and why it takes a request id AND a
// digest: the grant is for that action on that target in that run, and it is not transferable.
//
// WHAT THIS VERB DOES NOT DO. It does not perform the action. It records the grant and returns the
// run to `running`, so the next attempt may proceed with the operator's permission on file. The engine
// still never pushes, deploys or writes to a database on its own initiative — a granted action is
// carried out by the session that asked, under the safety procedure the request named, and a database
// write additionally carries Rule 4 (a transaction that can roll back).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { bangkokTimestamp } from '../run-events/store.mjs';
import { DIGEST_RE, digestOf } from './schema.mjs';
import {
  RELATIVE,
  assertPhase,
  flagString,
  goalPositionals,
  loadRun,
  parseGoalFlags,
} from './commands.mjs';
import { writeRunState } from './store.mjs';
import { toRunning } from './state-machine.mjs';
import { commitTransition } from './runner.mjs';

const BOOLEANS = ['json'];

/**
 * Run `goal approve-action`.
 *
 * @param {{repoRoot: string, argv: string[], flags: object, log: Function}} ctx
 * @param {object} _args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, _args) {
  const flags = parseGoalFlags(ctx.argv, BOOLEANS);
  const positionals = goalPositionals(ctx.argv, BOOLEANS);
  const runId = positionals[0];
  const requestId = positionals[1];
  if (!runId || !requestId) {
    throw new SidekicksError(
      'goal approve-action: usage: goal approve-action <run-id> <request-id> --digest <sha256>\n'
      + "  'goal status <run-id>' shows the held request, its id and its digest.",
      EXIT_USAGE,
    );
  }

  const { runDir, state } = loadRun(ctx.repoRoot, runId);
  assertPhase(state, ['awaiting_action_approval'], 'approve-action');

  const held = state.action_request;
  if (!held) {
    throw new SidekicksError(
      'goal approve-action: this run holds no action request — nothing to grant',
      EXIT_VALIDATION,
    );
  }

  if (held.request_id !== requestId) {
    throw new SidekicksError(
      `goal approve-action: this run holds request '${held.request_id}', not '${requestId}'. A grant `
      + 'names the exact request it authorizes.',
      EXIT_VALIDATION,
    );
  }

  const digest = flagString(flags.digest);
  if (!DIGEST_RE.test(digest)) {
    throw new SidekicksError(
      'goal approve-action: --digest <sha256> is required. The digest binds the action class, the '
      + 'target and the run, so a grant cannot be re-used for a different action or a different '
      + `target. This request's digest is ${held.digest}.`,
      EXIT_USAGE,
    );
  }

  // Recompute rather than compare to the stored value alone: the point is that the digest describes
  // the action as it stands right now, not as it was when the summary was printed.
  const canonical = {
    schema_version: 1,
    run_id: held.run_id,
    request_id: held.request_id,
    node: held.node,
    action_class: held.action_class,
    target: held.target,
  };
  const actual = digestOf(canonical);
  if (actual !== digest) {
    throw new SidekicksError(
      `goal approve-action: digest mismatch.\n  you granted: ${digest}\n  this request: ${actual}\n`
      + '  A grant is bound to one action class and one target. Re-read the request with\n'
      + `  'sidekicks goal status ${runId}' and grant the digest it shows.`,
      EXIT_VALIDATION,
    );
  }

  // Append-only, like every other approval: the record of what was granted has to survive the run.
  //
  // The record carries everything the next attempt needs to actually USE it — the safety procedure the
  // session itself proposed, and any standing requirement (Rule 4's transaction, for a database write)
  // that the grant does not waive. A grant that recorded only "class + target" would leave the next
  // attempt to re-derive its own conditions, which is the one thing the operator's decision is
  // supposed to settle. `consumed_by` starts null and is the field that makes the grant single-use.
  state.action_grants = [
    ...(Array.isArray(state.action_grants) ? state.action_grants : []),
    {
      request_id: held.request_id,
      action_class: held.action_class,
      target: held.target,
      node: held.node,
      attempt_id: held.attempt_id ?? null,
      digest: actual,
      safety_procedure: held.safety_procedure ?? null,
      extra_requirements: (held.extra_requirements || []).slice(),
      granted_at: bangkokTimestamp(Date.now()),
      consumed_by: null,
      consumed_at: null,
    },
  ];
  writeRunState(runDir, state);

  const next = commitTransition(runDir, toRunning(state, {
    reason: `granted ${held.action_class} on ${held.target} (request ${held.request_id})`,
  }));

  const payload = {
    run_id: next.run_id,
    run_dir: RELATIVE(ctx.repoRoot, runDir),
    phase: next.phase,
    granted: next.action_grants[next.action_grants.length - 1],
    grants_total: next.action_grants.length,
    next: `sidekicks goal run ${runId}`,
  };

  if (flags.json === true) {
    return { stdout: `${JSON.stringify(payload, null, 2)}\n`, exitCode: EXIT_OK };
  }

  const lines = [
    `goal run ${runId} — granted ${held.action_class}`,
    '',
    `  target:   ${held.target}`,
    `  node:     ${held.node}`,
    `  request:  ${held.request_id}`,
    '',
    '  This grant authorizes that ONE action on that ONE target. Nothing else about the run',
    '  changed, and no other held or future action is covered by it.',
  ];
  if ((held.extra_requirements || []).length > 0) {
    lines.push('');
    lines.push('  Still required:');
    for (const req of held.extra_requirements) lines.push(`    - ${req}`);
  }
  lines.push('');
  lines.push(`  next: sidekicks goal run ${runId}`);
  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
}
