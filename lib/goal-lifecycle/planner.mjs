// lib/goal-lifecycle/planner.mjs
// Turning a goal into a validated plan, and getting a second opinion on it.
//
// THE ENGINE PERSISTS, THE MODEL PROPOSES. A planning session returns a structured document and
// nothing else: it does not write `plan.json`, it does not choose the run folder, and it does not get
// to say whether its own plan is good enough. That separation is the reason planning can run in an
// enforced read-only mode at all.
//
// SCHEMAS ARE KEPT COMPACT ON PURPOSE. Claude takes its output schema INLINE on the command line, and
// on Windows the whole line has to fit under ~32K after cmd.exe escaping. So these schemas carry
// structure and no prose: the explanation of what a good plan looks like belongs in the prompt, which
// has no such ceiling. `additionalProperties: false` everywhere is the part that earns its bytes — it
// is what turns a hallucinated extra field into a validation failure instead of a silent ignore.
//
// THE CRITIC IS BOUNDED, AND THAT IS A SAFETY PROPERTY. Two correction passes, then the run stops and
// asks a human. An unbounded plan/critique loop is the failure mode where an engine looks busy
// forever and spends real money doing it, so the cap lives in the state machine (which refuses the
// third pass) rather than in a caller's loop counter.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { join } from 'node:path';
import { invokeExecutor } from '../cli-executor-lifecycle/invoke.mjs';
import { containmentNote, roleSupported } from '../cli-executor-lifecycle/profiles.mjs';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { GOAL_SCHEMA_VERSION, validatePlan } from './schema.mjs';
import { validateGraph } from './graph.mjs';
import { mkdirp, writeJson } from './store.mjs';

/**
 * The JSON Schema a planning session must satisfy.
 *
 * Mirrors the contract `validatePlan` enforces. The schema is the CLI's guard rail and the validator
 * is the engine's — both, because not every CLI enforces a schema (gemini has no schema flag at all),
 * and a schema cannot express the referential rules anyway: that a dependency names a real node, that
 * criterion ids are unique across the whole plan, that there is no cycle.
 */
export const PLAN_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['schema_version', 'goal', 'nodes', 'risks', 'out_of_scope'],
  additionalProperties: false,
  properties: {
    schema_version: { type: 'integer', enum: [GOAL_SCHEMA_VERSION] },
    goal: { type: 'string', minLength: 1 },
    assumptions: { type: 'array', items: { type: 'string' } },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['choice', 'why'],
        additionalProperties: false,
        properties: {
          choice: { type: 'string' },
          why: { type: 'string' },
          rejected: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    nodes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'title', 'depends_on', 'work_dir', 'executor', 'tier', 'affected_paths', 'acceptance', 'tests'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
          title: { type: 'string', minLength: 1 },
          depends_on: { type: 'array', items: { type: 'string' } },
          work_dir: { type: 'string', minLength: 1 },
          executor: { type: 'string', minLength: 1 },
          tier: { type: 'string', enum: ['top', 'high', 'mid', 'low'] },
          complexity: { type: 'string', enum: ['normal', 'complex'] },
          affected_paths: { type: 'array', minItems: 1, items: { type: 'string' } },
          acceptance: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['id', 'text', 'owner_node'],
              additionalProperties: false,
              properties: {
                id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
                text: { type: 'string', minLength: 1 },
                owner_node: { type: 'string', minLength: 1 },
              },
            },
          },
          tests: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    out_of_scope: { type: 'array', items: { type: 'string' } },
  },
});

/** The critic's contract: approve, or return corrections precise enough to apply. */
export const CRITIC_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['verdict', 'findings'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'correct'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'what', 'fix'],
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocking', 'advisory'] },
          what: { type: 'string', minLength: 1 },
          fix: { type: 'string', minLength: 1 },
          node: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
});

/**
 * The IMPLEMENTATION session's contract.
 *
 * Two reasons this exists rather than letting an implementer answer in prose. First, the invoker
 * requires a schema for every CLI that enforces one — Claude takes it inline, Codex and Antigravity
 * take a path — so an implementation session without one could not be dispatched at all. Second, and
 * more importantly, it is the SANCTIONED CHANNEL the policy block promises: an agent that needs a
 * push, a deploy or a database write has a structured way to say so. Without one, an agent with edit
 * permissions and no way to report a blocker will either do the thing or stall silently.
 *
 * `result: "blocked"` plus an `action_request` is a SUCCESSFUL outcome for the session. The run pauses
 * and asks the operator for that one action; it does not fail the attempt for asking.
 */
export const IMPLEMENT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['result', 'summary'],
  additionalProperties: false,
  properties: {
    result: { type: 'string', enum: ['completed', 'blocked'] },
    summary: { type: 'string', minLength: 1 },
    changed_paths: { type: 'array', items: { type: 'string' } },
    action_request: {
      type: 'object',
      required: ['action_class', 'target', 'reason', 'reversible'],
      additionalProperties: false,
      properties: {
        action_class: { type: 'string' },
        target: { type: 'string', minLength: 1 },
        reason: { type: 'string', minLength: 1 },
        reversible: { type: 'boolean' },
        safety_procedure: { type: 'string' },
      },
    },
  },
});

/** The attempt reviewer's contract. Mirrors `validateReviewVerdict`. */
export const REVIEW_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['result', 'criteria', 'summary'],
  additionalProperties: false,
  properties: {
    result: { type: 'string', enum: ['pass', 'fail'] },
    criteria: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['criterion_id', 'status', 'evidence'],
        additionalProperties: false,
        properties: {
          criterion_id: { type: 'string' },
          status: { type: 'string', enum: ['met', 'unmet', 'unverifiable'] },
          evidence: { type: 'array', minItems: 1, items: { type: 'string' } },
        },
      },
    },
    summary: { type: 'string', minLength: 1 },
    reviewer_family: { type: 'string' },
  },
});

/** The final verifier's contract. Mirrors `validateFinalVerdict`. */
export const FINAL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['result', 'summary', 'evidence'],
  additionalProperties: false,
  properties: {
    result: { type: 'string', enum: ['approved', 'rejected-in-scope', 'rejected-scope-change'] },
    summary: { type: 'string', minLength: 1 },
    evidence: { type: 'array', minItems: 1, items: { type: 'string' } },
    failed_criteria: { type: 'array', items: { type: 'string' } },
    scope_change_reason: { type: 'string' },
  },
});

/** The contest judge's fixed rubric. Five dimensions, 0–5 each, every score with a rationale. */
export const JUDGE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['scores', 'strengths', 'gaps'],
  additionalProperties: false,
  properties: {
    scores: {
      type: 'object',
      required: ['goal_coverage', 'criteria_testability', 'risk_realism', 'scope_discipline', 'dependency_correctness'],
      additionalProperties: false,
      properties: {
        goal_coverage: { $ref: '#/$defs/dim' },
        criteria_testability: { $ref: '#/$defs/dim' },
        risk_realism: { $ref: '#/$defs/dim' },
        scope_discipline: { $ref: '#/$defs/dim' },
        dependency_correctness: { $ref: '#/$defs/dim' },
      },
    },
    strengths: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
    notable_ideas: { type: 'array', items: { type: 'string' } },
  },
  $defs: {
    dim: {
      type: 'object',
      required: ['score', 'why'],
      additionalProperties: false,
      properties: { score: { type: 'integer', minimum: 0, maximum: 5 }, why: { type: 'string', minLength: 1 } },
    },
  },
});

/**
 * Write a schema to the run folder and return its path.
 *
 * A file, because three of the four built-in CLIs take a path and the fourth takes the same JSON
 * inline — so one file serves both transports and the caller passes both.
 *
 * @param {string} runDir
 * @param {string} name
 * @param {object} schema
 * @returns {{path: string, json: string}}
 */
export function writeSchemaFile(runDir, name, schema) {
  const dir = join(runDir, 'schemas');
  mkdirp(dir);
  const path = join(dir, `${name}.schema.json`);
  writeJson(path, schema);
  return { path, json: JSON.stringify(schema) };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * The planning prompt.
 *
 * Three things in here are load-bearing rather than decorative. It states the read-only boundary
 * explicitly, because a model that believes it may edit will propose steps that assume it already
 * did. It requires every criterion to be checkable by someone who did NOT write the code, because a
 * criterion only its author can verify makes the independent review theatre. And it demands an
 * `out_of_scope` list, because a plan that excludes nothing has not been bounded — the final verifier
 * uses that list to tell "we did not do this" apart from "we failed to do this".
 *
 * @param {{goal: string, workDir: string, scope: string, requirementDocs?: string[],
 *          executors: {name: string, family: string|null, tiers: string[], best_at?: string[]}[],
 *          repoNotes?: string|null}} input
 * @returns {string}
 */
export function buildPlannerPrompt(input) {
  const lines = [];
  lines.push('You are planning an implementation. You are running in a READ-ONLY session: you cannot');
  lines.push('modify this repository, and nothing you propose has been done yet. Investigate first,');
  lines.push('then return ONE JSON document matching the provided schema. Return no prose outside it.');
  lines.push('');
  lines.push('## Goal');
  lines.push('');
  lines.push(input.goal);
  lines.push('');
  lines.push('## Where you are');
  lines.push('');
  lines.push(`- active scope: ${input.scope}`);
  lines.push(`- working folder (all paths you name are RELATIVE to the repository root): ${input.workDir}`);
  if (Array.isArray(input.requirementDocs) && input.requirementDocs.length) {
    lines.push('- read these first, they are the requirement of record:');
    for (const doc of input.requirementDocs) lines.push(`  - ${doc}`);
  }
  if (input.repoNotes) {
    lines.push('');
    lines.push(input.repoNotes);
  }
  lines.push('');
  lines.push('## Executors you may route work to');
  lines.push('');
  lines.push('Each node names the executor and model tier that will implement it. Route by fit, and');
  lines.push('use the mid tier unless a node is genuinely hard — then mark it complexity: "complex"');
  lines.push('and request a higher tier. Only these executors and these tiers exist:');
  lines.push('');
  for (const ex of input.executors) {
    const best = ex.best_at && ex.best_at.length ? ` — best at: ${ex.best_at.join(', ')}` : '';
    lines.push(`- ${ex.name} (family ${ex.family ?? 'unregistered'}), tiers: ${ex.tiers.join(', ')}${best}`);
  }
  lines.push('');
  lines.push('## What makes this plan executable');
  lines.push('');
  lines.push('1. Split the work into nodes that each land as one reviewable change. A node is too big');
  lines.push('   if its acceptance criteria cannot all be checked at once, and too small if it cannot');
  lines.push('   be reviewed on its own.');
  lines.push('2. `depends_on` must name real node ids and must be acyclic. Nodes run ONE AT A TIME in');
  lines.push('   dependency order, so a dependency you declare is a decision about sequence.');
  lines.push('3. Every acceptance criterion must be checkable by someone who did NOT write the code,');
  lines.push('   from files and command output alone. "Works correctly" is not a criterion; "GET');
  lines.push('   /health returns 200 with {status:\'ok\'}" is. Each criterion gets a stable id and');
  lines.push('   names its owner node — that id is what a later verifier reopens work by.');
  lines.push('4. `affected_paths` lists the repo-relative paths the node will touch. They decide which');
  lines.push('   Git checkouts the run is allowed to write to, so an omission blocks the node.');
  lines.push('5. `tests` are the exact commands that prove the node, runnable as written.');
  lines.push('6. `out_of_scope` must not be empty. State what you deliberately are NOT doing; it is');
  lines.push('   how a later verifier tells an exclusion apart from a failure.');
  lines.push('7. Never name an absolute path (no /Users/..., no C:\\...). Repo-relative only.');
  lines.push('');
  lines.push('Do not pad the plan. A node you cannot state acceptance criteria for is a node you have');
  lines.push('not understood yet — investigate it instead of guessing.');
  return lines.join('\n');
}

/**
 * The plan-critique prompt.
 *
 * The critic is asked for BLOCKING findings specifically, and told what it may not do: it cannot
 * widen the goal, and it cannot approve a plan whose criteria it could not itself verify. A critic
 * that returns twelve advisory nits and no verdict has not done the job the two-pass budget exists
 * to pay for.
 *
 * @param {{goal: string, planJson: string, workDir: string}} input
 * @returns {string}
 */
export function buildCriticPrompt(input) {
  const lines = [];
  lines.push('You are reviewing an implementation plan in a READ-ONLY session. You did not write it.');
  lines.push('Return ONE JSON document matching the provided schema, and no prose outside it.');
  lines.push('');
  lines.push('## The goal the plan must serve');
  lines.push('');
  lines.push(input.goal);
  lines.push('');
  lines.push('## The plan');
  lines.push('');
  lines.push('```json');
  lines.push(input.planJson);
  lines.push('```');
  lines.push('');
  lines.push('## What to check, against the actual repository');
  lines.push('');
  lines.push('- Does the plan actually achieve the goal, or only part of it? Name the missing part.');
  lines.push('- Could YOU verify every acceptance criterion from files and command output alone,');
  lines.push('  without asking the implementer? Any criterion you could not is blocking.');
  lines.push('- Do the affected paths and test commands exist, or make sense for files being created?');
  lines.push('- Is the dependency order right — does any node need something a later node produces?');
  lines.push('- Are the risks real ones for THIS repository, or generic filler?');
  lines.push('- Is anything in scope that the goal did not ask for?');
  lines.push('');
  lines.push('## Rules');
  lines.push('');
  lines.push('- `verdict: "approve"` means you found nothing blocking. Advisory findings may accompany');
  lines.push('  an approval; blocking ones may not.');
  lines.push('- `verdict: "correct"` requires at least one blocking finding, each with a `fix` precise');
  lines.push('  enough to apply without further interpretation.');
  lines.push('- You may NOT widen the goal. If the plan is right and the goal is wrong, say so as a');
  lines.push('  finding — do not plan the larger thing.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/**
 * Run one planning session and validate what comes back.
 *
 * Returns a RESULT rather than throwing on a bad plan: a planner that returns an invalid document is
 * an ordinary outcome the caller handles (a repair turn, a correction pass, or `needs_user`), not an
 * exceptional one.
 *
 * @param {{name: string, spec: object, tier: string, prompt: string, runDir: string, cwd: string,
 *          timeoutMs?: number, invoke?: Function, role?: string}} input
 * @returns {Promise<{ok: boolean, plan: object|null, errors: string[], invocation: object}>}
 */
export async function runPlanningSession(input) {
  const invoke = input.invoke || invokeExecutor;
  const schema = writeSchemaFile(input.runDir, 'plan', PLAN_OUTPUT_SCHEMA);

  const result = await invoke({
    name: input.name,
    spec: input.spec,
    role: input.role || 'plan',
    tier: input.tier,
    prompt: input.prompt,
    cwd: input.cwd,
    schemaPath: schema.path,
    schemaJson: schema.json,
    timeoutMs: input.timeoutMs,
    // Forwarded so a concurrent caller (the plan contest) can persist the child's pid before this
    // await settles — a fan-out whose children are only recorded on return cannot be resumed.
    onSpawn: input.onSpawn,
  });

  if (!result.ok && result.result === null) {
    return {
      ok: false,
      plan: null,
      errors: [
        result.timed_out
          ? `the planning session timed out after ${result.duration_ms}ms`
          : `the planning session failed (exit ${result.exit_code})`
            + `${result.parse_error ? `: ${result.parse_error}` : ''}`
            + `${result.error ? `: ${result.error}` : ''}`,
      ],
      invocation: result,
    };
  }

  const checked = checkPlanDocument(result.result);
  return { ok: checked.ok, plan: checked.ok ? result.result : null, errors: checked.errors, invocation: result };
}

/**
 * Validate a candidate plan document, structurally then referentially then topologically.
 *
 * One function so every path that accepts a plan — the single planner, each contest contestant, the
 * synthesis output — applies exactly the same bar. A contestant held to a looser standard than the
 * winner would make the contest meaningless.
 *
 * @param {unknown} doc
 * @returns {{ok: boolean, errors: string[]}}
 */
export function checkPlanDocument(doc) {
  if (doc === null || typeof doc !== 'object') {
    return { ok: false, errors: ['the session returned no JSON document'] };
  }
  const shape = validatePlan(doc);
  if (!shape.ok) return shape;
  const graph = validateGraph(doc);
  if (!graph.ok) return { ok: false, errors: graph.errors };
  return { ok: true, errors: [] };
}

/**
 * Run one plan-critique session.
 *
 * @param {{name: string, spec: object, tier: string, prompt: string, runDir: string, cwd: string,
 *          timeoutMs?: number, invoke?: Function}} input
 * @returns {Promise<{ok: boolean, verdict: 'approve'|'correct'|null, findings: object[],
 *                    errors: string[], invocation: object}>}
 */
export async function runCritiqueSession(input) {
  const invoke = input.invoke || invokeExecutor;
  const schema = writeSchemaFile(input.runDir, 'critic', CRITIC_OUTPUT_SCHEMA);

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

  const doc = result.result;
  if (doc === null || typeof doc !== 'object' || !['approve', 'correct'].includes(doc.verdict)) {
    return {
      ok: false,
      verdict: null,
      findings: [],
      errors: [
        `the plan critic returned no usable verdict${result.parse_error ? `: ${result.parse_error}` : ''}`,
      ],
      invocation: result,
    };
  }

  const findings = Array.isArray(doc.findings) ? doc.findings : [];
  const blocking = findings.filter((f) => f && f.severity === 'blocking');

  // A self-contradictory verdict is refused rather than reinterpreted. "correct" with nothing
  // blocking gives the engine nothing to apply; "approve" alongside a blocking finding would let the
  // gate be talked past by whichever half the caller happened to read.
  if (doc.verdict === 'correct' && blocking.length === 0) {
    return {
      ok: false,
      verdict: null,
      findings,
      errors: ["the critic asked for corrections but listed no blocking finding — nothing to apply"],
      invocation: result,
    };
  }
  if (doc.verdict === 'approve' && blocking.length > 0) {
    return {
      ok: false,
      verdict: null,
      findings,
      errors: [`the critic approved the plan while reporting ${blocking.length} blocking finding(s)`],
      invocation: result,
    };
  }

  return { ok: true, verdict: doc.verdict, findings, errors: [], invocation: result };
}

/**
 * Build the correction prompt for a second planning pass.
 *
 * It carries the previous plan and the blocking findings verbatim, and forbids the two things a
 * correction pass tends to do wrong: rewriting the plan from scratch (losing what was already
 * agreed) and widening the scope while it is in there anyway.
 *
 * @param {{goal: string, planJson: string, findings: object[], pass: number, maxPasses: number}} input
 * @returns {string}
 */
export function buildCorrectionPrompt(input) {
  const lines = [];
  lines.push('You are correcting an implementation plan you previously produced, in a READ-ONLY');
  lines.push('session. An independent reviewer found the problems below. Return the CORRECTED plan as');
  lines.push('one JSON document matching the schema, and no prose outside it.');
  lines.push('');
  lines.push(`This is correction pass ${input.pass} of a maximum ${input.maxPasses}. After that the run`);
  lines.push('stops and asks a human, so fix the blocking findings now rather than partially.');
  lines.push('');
  lines.push('## Goal (unchanged)');
  lines.push('');
  lines.push(input.goal);
  lines.push('');
  lines.push('## Your previous plan');
  lines.push('');
  lines.push('```json');
  lines.push(input.planJson);
  lines.push('```');
  lines.push('');
  lines.push('## Blocking findings you must fix');
  lines.push('');
  for (const f of input.findings) {
    lines.push(`- ${f.node ? `[${f.node}] ` : ''}${f.what}`);
    lines.push(`  fix: ${f.fix}`);
  }
  lines.push('');
  lines.push('## Rules');
  lines.push('');
  lines.push('- Change only what the findings require. Keep every node id, criterion id and decision');
  lines.push('  that was not criticised — a from-scratch rewrite discards what was already agreed and');
  lines.push('  cannot be reviewed as a correction.');
  lines.push('- Do NOT widen the scope. Same goal, same target.');
  lines.push('- If a finding is wrong, keep your plan and say why in `assumptions`. Do not silently');
  lines.push('  ignore it.');
  return lines.join('\n');
}

/**
 * The executor summaries a planning prompt needs, derived from the effective registry.
 *
 * @param {Record<string, object>} executors - effective executor map
 * @param {(name: string, spec: object) => string|null} familyOf
 * @param {string[]} [tiers]
 * @returns {{name: string, family: string|null, tiers: string[], best_at: string[]}[]}
 */
export function describeExecutors(executors, familyOf, tiers = ['top', 'high', 'mid', 'low']) {
  return Object.entries(executors)
    .filter(([, spec]) => spec.enabled !== false)
    .map(([name, spec]) => ({
      name,
      family: familyOf(name, spec),
      tiers: tiers.filter((t) => spec.models?.[t]),
      best_at: Array.isArray(spec.specialties) ? spec.specialties : [],
    }))
    .filter((row) => row.tiers.length > 0)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * A one-line note for the report about how a session was contained.
 *
 * @param {string} name
 * @param {object} spec
 * @param {string} role
 * @returns {string}
 */
export function noteContainment(name, spec, role) {
  return containmentNote(name, spec, role);
}

/**
 * Pick the executor a role runs on: an explicit choice, else the configured routing head.
 *
 * Fails closed in both directions — an explicit choice that cannot hold the role or map the tier is
 * an error, and when no configured executor can, that is an error too. The alternative (quietly
 * using whichever one happens to work) would route high-stakes planning onto an arbitrary model.
 *
 * @param {{executors: Record<string, object>, prefer?: string[], requested?: string|null,
 *          role: string, tier: string}} input
 * @returns {{name: string, spec: object}}
 * @throws {SidekicksError} EXIT_VALIDATION
 */
export function selectExecutor(input) {
  const { executors, role, tier } = input;
  const eligible = (name) => {
    const spec = executors[name];
    if (!spec || spec.enabled === false) return { ok: false, reason: `'${name}' is not an enabled executor` };
    const support = roleSupported(name, spec, role);
    if (!support.ok) return { ok: false, reason: support.reason };
    if (!spec.models?.[tier]) {
      return { ok: false, reason: `'${name}' maps no model for the ${tier} tier` };
    }
    return { ok: true, reason: '' };
  };

  if (input.requested) {
    const check = eligible(input.requested);
    if (!check.ok) {
      throw new SidekicksError(
        `goal: executor '${input.requested}' cannot hold the ${role} role at the ${tier} tier — `
        + `${check.reason}. An explicit choice is never substituted for.`,
        EXIT_VALIDATION,
      );
    }
    return { name: input.requested, spec: executors[input.requested] };
  }

  const order = [...(input.prefer || []), ...Object.keys(executors).sort()];
  /** @type {string[]} */
  const rejected = [];
  for (const name of [...new Set(order)]) {
    const check = eligible(name);
    if (check.ok) return { name, spec: executors[name] };
    rejected.push(`${name}: ${check.reason}`);
  }
  throw new SidekicksError(
    `goal: no configured executor can hold the ${role} role at the ${tier} tier.\n  `
    + rejected.join('\n  ')
    + "\nMap a model with 'cli-executor register <name> --model-<tier> <id>', or request a tier that "
    + 'is mapped.',
    EXIT_VALIDATION,
  );
}

/**
 * Pick a reviewing seat that is NOT from `avoidFamily`, falling back with the fallback recorded.
 *
 * Independence is preferred, not mandatory: on a machine with one configured CLI family there is no
 * independent seat to be had, and refusing to review at all would be worse than reviewing with the
 * compromise stamped on the report. The caller persists `same_family_fallback` so the report can say
 * so rather than implying an independence it did not have.
 *
 * @param {{executors: Record<string, object>, prefer?: string[], role: string, tier: string,
 *          avoidFamily?: string|null, avoidExecutor?: string|null,
 *          familyOf: (name: string, spec: object) => string|null}} input
 * @returns {{name: string, spec: object, family: string|null, same_family_fallback: boolean}}
 */
export function selectIndependentExecutor(input) {
  const candidates = Object.keys(input.executors).sort();
  const order = [...new Set([...(input.prefer || []), ...candidates])];

  const usable = order.filter((name) => {
    const spec = input.executors[name];
    if (!spec || spec.enabled === false) return false;
    if (!roleSupported(name, spec, input.role).ok) return false;
    return Boolean(spec.models?.[input.tier]);
  });

  const differentFamily = usable.filter((name) => {
    const fam = input.familyOf(name, input.executors[name]);
    return input.avoidFamily ? fam !== input.avoidFamily : true;
  });

  const pool = differentFamily.length > 0 ? differentFamily : usable;
  if (pool.length === 0) {
    throw new SidekicksError(
      `goal: no configured executor can hold the ${input.role} role at the ${input.tier} tier`,
      EXIT_VALIDATION,
    );
  }
  // Within the pool, avoid the exact executor that produced the work even when the family matches.
  const name = pool.find((n) => n !== input.avoidExecutor) ?? pool[0];
  return {
    name,
    spec: input.executors[name],
    family: input.familyOf(name, input.executors[name]),
    same_family_fallback: differentFamily.length === 0,
  };
}
