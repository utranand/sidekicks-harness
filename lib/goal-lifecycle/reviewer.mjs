// lib/goal-lifecycle/reviewer.mjs
// The implementation session and the independent verdict on it.
//
// THE REVIEWER IS NOT THE IMPLEMENTER, AND THAT IS ENFORCED IN THREE PLACES. It runs in a FRESH
// session (never a resume of the one that wrote the code), in an enforced read-only mode, and
// preferably on a different model family. A reviewer that can edit the tree it is grading will fix
// what it finds and report a pass; a reviewer resuming the implementer's session has the
// implementer's own reasoning in context and grades its intentions rather than its output.
//
// EVIDENCE IS REQUIRED, INCLUDING FOR A PASS. `validateReviewVerdict` refuses a `met` criterion with
// an empty evidence list, and this module hands the reviewer the material to produce one: the actual
// diff of the attempt, the actual output of the node's own test commands, and the criterion ids it
// must rule on. An unevidenced "met" is the single most expensive thing a reviewer can say, because
// it completes a node on the reviewer's word.
//
// THE PROMPT DOES NOT SAY WHAT THE ANSWER SHOULD BE. It gives the criteria, the change, and the
// command output, and it says explicitly that a fail is a normal, useful outcome. A prompt that
// leans on "confirm this works" gets confirmation.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { invokeExecutor } from '../cli-executor-lifecycle/invoke.mjs';
import { validateReviewVerdict } from './schema.mjs';
import { IMPLEMENT_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA, writeSchemaFile } from './planner.mjs';
import { renderGrantBlock, renderPolicyBlock } from './policy.mjs';

/** How much of a diff or a test log is handed to a session. Bounded, because a prompt is not a file. */
export const EVIDENCE_CHAR_CAP = 60_000;

/**
 * Truncate evidence, and SAY that it was truncated.
 *
 * Silent truncation is the failure where a reviewer confidently rules on the first half of a diff.
 *
 * @param {string} text
 * @param {number} [cap]
 * @returns {string}
 */
export function boundEvidence(text, cap = EVIDENCE_CHAR_CAP) {
  const s = String(text ?? '');
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n\n[...truncated ${s.length - cap} more characters — read the file on disk `
    + 'for the rest; do not rule on what you cannot see]';
}

/**
 * The implementation prompt for one node.
 *
 * @param {{goal: string, node: object, writeRoots: string[], planSummary: string,
 *          correction?: string|null, grant?: object|null, attemptNumber: number,
 *          maxAttempts: number}} input
 * @returns {string}
 */
export function buildImplementPrompt(input) {
  const { node } = input;
  const lines = [];
  lines.push('You are implementing ONE node of an approved plan. Make the change and stop. The engine');
  lines.push('runs the approved test commands after you return. Do not start work the node does not name.');
  lines.push('');
  lines.push(`This is attempt ${input.attemptNumber} of at most ${input.maxAttempts} for this node.`);
  lines.push('');
  lines.push('## The overall goal (context — not your task)');
  lines.push('');
  lines.push(input.goal);
  lines.push('');
  lines.push(`## Your task: node ${node.id} — ${node.title}`);
  lines.push('');
  if (Array.isArray(node.depends_on) && node.depends_on.length) {
    lines.push(`Nodes ${node.depends_on.join(', ')} are already complete. Build on what they landed.`);
    lines.push('');
  }
  lines.push('Files this node is expected to touch:');
  for (const p of node.affected_paths || []) lines.push(`  - ${p}`);
  lines.push('');
  lines.push('## What you will be judged on');
  lines.push('');
  lines.push('A FRESH independent reviewer — a different session, read-only, that did not write your');
  lines.push('code — will rule on each of these from files and command output alone. Every one must be');
  lines.push('met with concrete evidence or the attempt fails:');
  lines.push('');
  for (const c of node.acceptance || []) {
    lines.push(`  - ${c.id}: ${c.text}`);
  }
  lines.push('');
  lines.push('Leave the evidence where the reviewer can find it: real code, real tests, real output.');
  lines.push('Do not claim a criterion is met in a comment or a summary — the reviewer reads the tree,');
  lines.push('not your account of it.');
  lines.push('');
  lines.push(renderPolicyBlock({ writeRoots: input.writeRoots, tests: node.tests || [] }));
  lines.push('');
  lines.push('Every one of those commands is refused by a guard on this session\'s PATH before it runs,');
  lines.push('so attempting one does not get it done — it fails the attempt with the refusal on record.');
  if (input.grant) {
    lines.push('');
    lines.push(renderGrantBlock(input.grant));
  }
  lines.push('');
  lines.push('## What to return');
  lines.push('');
  lines.push('ONE JSON document matching the provided schema, and no prose outside it:');
  lines.push('');
  lines.push('  - `result: "completed"` — you made the change. `summary` says what you did and');
  lines.push('    `changed_paths` lists the repo-relative files you touched.');
  lines.push('  - `result: "blocked"` plus `action_request` — the work genuinely cannot be finished');
  lines.push('    without one of the forbidden actions above. Name the exact `action_class`, its');
  lines.push('    `target`, the `reason`, whether it is `reversible`, and any `safety_procedure` it');
  lines.push('    needs. The run will pause and ask the operator for that ONE action. Reporting it');
  lines.push('    this way is a successful outcome; taking the action is not.');
  if (input.planSummary) {
    lines.push('');
    lines.push('## The rest of the plan, for context only');
    lines.push('');
    lines.push(input.planSummary);
  }
  if (input.correction) {
    lines.push('');
    lines.push('## THIS IS A CORRECTION — read this before touching anything');
    lines.push('');
    lines.push(input.correction);
  }
  return lines.join('\n');
}

/**
 * The review prompt for one attempt.
 *
 * @param {{goal: string, node: object, diff: string, testOutput: string, attemptNumber: number,
 *          priorFailures?: string[]}} input
 * @returns {string}
 */
export function buildReviewPrompt(input) {
  const { node } = input;
  const lines = [];
  lines.push('You are reviewing ONE implementation attempt in a READ-ONLY session. You did not write');
  lines.push('this code. Return ONE JSON document matching the provided schema, and no prose outside');
  lines.push('it.');
  lines.push('');
  lines.push('A FAIL is a normal and useful outcome. Your verdict decides whether this work is');
  lines.push('accepted, so rule on what the tree actually shows — not on what the change was clearly');
  lines.push('trying to do.');
  lines.push('');
  lines.push('## The goal this node serves (context)');
  lines.push('');
  lines.push(input.goal);
  lines.push('');
  lines.push(`## Node ${node.id} — ${node.title}`);
  lines.push('');
  lines.push('Rule on EXACTLY these criteria, one verdict each, no others:');
  lines.push('');
  for (const c of node.acceptance || []) {
    lines.push(`  - ${c.id}: ${c.text}`);
  }
  lines.push('');
  if (Array.isArray(input.priorFailures) && input.priorFailures.length) {
    lines.push('## Earlier attempts on this node failed for these reasons');
    lines.push('');
    for (const f of input.priorFailures) lines.push(`  - ${f}`);
    lines.push('');
    lines.push('Check specifically whether each of those is now actually fixed.');
    lines.push('');
  }
  lines.push('## The change, as a diff');
  lines.push('');
  lines.push('```diff');
  lines.push(boundEvidence(input.diff) || '(no changes were made)');
  lines.push('```');
  lines.push('');
  if (input.testOutput) {
    lines.push('## Output of the node\'s own test commands');
    lines.push('');
    lines.push('```');
    lines.push(boundEvidence(input.testOutput));
    lines.push('```');
    lines.push('');
  }
  lines.push('## How to rule');
  lines.push('');
  lines.push('- `met` needs evidence a third party could re-check: a repo-relative `path:line`, or a');
  lines.push('  command and its exit code. An empty evidence list is rejected by the engine, so a');
  lines.push('  criterion you cannot evidence is `unverifiable`, not `met`.');
  lines.push('- `unmet` means the tree does not do it. `unverifiable` means you cannot tell from what');
  lines.push('  you were given — both fail the attempt, and the distinction tells the next attempt');
  lines.push('  whether to fix the code or to make it checkable.');
  lines.push('- Read the files. The diff is what changed, not the whole truth about the tree.');
  lines.push('- `result: "pass"` is legal only when EVERY criterion above is `met`.');
  return lines.join('\n');
}

/**
 * Run one implementation session.
 *
 * @param {{name: string, spec: object, tier: string, prompt: string, cwd: string,
 *          timeoutMs?: number, resumeSession?: string|null, onSpawn?: Function,
 *          env?: Record<string, string>, invoke?: Function}} input
 * @returns {Promise<object>} the raw invocation result — the caller persists it
 */
export async function runImplementSession(input) {
  const invoke = input.invoke || invokeExecutor;
  // A schema is not optional here. Every CLI that enforces structured output needs one to be
  // dispatched at all, and it is also the channel an agent uses to REPORT a blocker instead of
  // taking an action the approval never covered.
  const schema = writeSchemaFile(input.runDir, 'implement', IMPLEMENT_OUTPUT_SCHEMA);
  return invoke({
    name: input.name,
    spec: input.spec,
    role: 'implement',
    tier: input.tier,
    prompt: input.prompt,
    cwd: input.cwd,
    schemaPath: schema.path,
    schemaJson: schema.json,
    timeoutMs: input.timeoutMs,
    resumeSession: input.resumeSession ?? null,
    // The command guard arrives as environment: a PATH whose first entry refuses every hard-stopped
    // command. Passed through rather than built here, because the guard belongs to the ATTEMPT (it
    // carries that attempt's grant and writes that attempt's refusal log), and this function does not
    // know which attempt it is serving.
    env: input.env,
    onSpawn: input.onSpawn,
  });
}

/**
 * Run one attempt review and validate the verdict against the node's own criteria.
 *
 * A verdict that does not cover exactly the node's criteria is REFUSED rather than partially
 * applied: a reviewer that skipped a criterion has not judged the attempt, and one that invented an
 * extra id is judging something else.
 *
 * @param {{name: string, spec: object, tier: string, prompt: string, cwd: string, runDir: string,
 *          criteria: string[], timeoutMs?: number, invoke?: Function}} input
 * @returns {Promise<{ok: boolean, verdict: object|null, errors: string[], invocation: object}>}
 */
export async function runReviewSession(input) {
  const invoke = input.invoke || invokeExecutor;
  const schema = writeSchemaFile(input.runDir, 'review', REVIEW_OUTPUT_SCHEMA);

  const result = await invoke({
    name: input.name,
    spec: input.spec,
    role: 'review',
    tier: input.tier,
    prompt: input.prompt,
    cwd: input.cwd,
    schemaPath: schema.path,
    schemaJson: schema.json,
    timeoutMs: input.timeoutMs,
  });

  if (result.result === null || typeof result.result !== 'object') {
    return {
      ok: false,
      verdict: null,
      errors: [
        `the reviewer returned no usable verdict${result.parse_error ? `: ${result.parse_error}` : ''}`
        + `${result.timed_out ? ' (timed out)' : ''}`,
      ],
      invocation: result,
    };
  }

  const check = validateReviewVerdict(result.result, input.criteria);
  if (!check.ok) {
    return { ok: false, verdict: null, errors: check.errors, invocation: result };
  }
  return { ok: true, verdict: result.result, errors: [], invocation: result };
}

/**
 * A one-paragraph summary of the rest of the plan, for an implementation session's context.
 *
 * Deliberately a SUMMARY and not the plan: handing an implementer the whole document invites it to
 * work ahead into nodes that have not been dispatched, whose dependencies are not satisfied and
 * whose write roots may differ.
 *
 * @param {object} plan
 * @param {string} currentNodeId
 * @param {Record<string, string>} nodeStates
 * @returns {string}
 */
export function summarizePlanFor(plan, currentNodeId, nodeStates = {}) {
  const lines = [];
  for (const node of plan.nodes || []) {
    if (node.id === currentNodeId) continue;
    const state = nodeStates[node.id] ?? 'pending';
    const marker = state === 'completed' ? 'done' : state;
    lines.push(`- ${node.id} (${marker}): ${node.title}`);
  }
  if (lines.length === 0) return '';
  lines.push('');
  lines.push('These are NOT your task. Do not implement them, and do not assume a pending one exists yet.');
  return lines.join('\n');
}
