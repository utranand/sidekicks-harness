#!/usr/bin/env node
// skill-advisor-hook.mjs — PreToolUse hook (matcher: Skill)
//
// Why this exists: plan-producing skills (implementation planner, sequence planner,
// PM pipeline) ship their deliverable in one shot — once the plan lands, the user
// acts on it. A flawed plan is therefore the most expensive artifact to get wrong,
// and the model has no standing instruction to get a second opinion before
// finalizing. This hook closes that gap deterministically: whenever one of the
// planner-family skills is invoked via the Skill tool, it injects an ADVISOR GATE
// directive telling the agent to spawn a high-tier advisor subagent to review the
// draft deliverable BEFORE presenting it.
//
// The directive names a capability TIER (high-tier), not a vendor model ID — per
// CLAUDE.md "Subagent model selection", the agent resolves the tier against the
// active CLI's own model list.
//
// It is intentionally silent for every other tool and every other skill — no
// output, exit 0 — so it never interferes with normal use. It never blocks a tool
// call: any error is swallowed and treated as "not a planner skill".
//
// Cross-CLI skill invocation (the only thing that differs between CLIs):
//   Claude Code → tool_name 'Skill',         skill name in tool_input.skill
//   Gemini CLI  → tool_name 'activate_skill', skill name in tool_input.name
//   Codex CLI   → no tool call (it reads SKILL.md inline), so no PreToolUse hook
//                 fires on activation — this hook simply never matches there.
// The output (additionalContext) is identical across all three.
//
// Wired via .claude/settings.json → PreToolUse (matcher "Skill") and
// .gemini/settings.json → BeforeTool (matcher "activate_skill"). Zero dependencies.

import { readFileSync } from 'node:fs';

// skill name → advisor directive tailored to that skill's failure modes.
// To gate another skill, add an entry here — no settings.json change needed.
const ADVISOR_DIRECTIVES = {
  'sk-implementation-planner':
    'ADVISOR GATE [hook]: before finalizing the implementation plan, spawn a ' +
    'high-tier advisor subagent (Agent tool; resolve the tier per CLAUDE.md ' +
    'model-tier rules) to adversarially review the draft plan. Have it check: ' +
    'step sequencing and dependency gaps, missing DB rollback scripts, ' +
    'artifacts-only boundaries (no live connects/deploys), implementation-rules ' +
    'violations, and handoff-guide completeness. Incorporate its findings into ' +
    'the plan before presenting it.',

  'sk-task-planner':
    'ADVISOR GATE [hook]: before handing the draft tasks.yaml queue back, spawn a ' +
    'high-tier advisor subagent (Agent tool; resolve the tier per CLAUDE.md ' +
    'model-tier rules) to adversarially review the decomposition. Have it check: ' +
    'every task has a single nameable deliverable and done_criteria an independent ' +
    'agent could grade (no effort-based or unverifiable criteria, and none that ' +
    'secretly weaken the goal); the tasks together actually reach the stated goal ' +
    '(no missing step); depends_on edges are correct (no cycle, no false ' +
    'serialization of independent tasks, no missing dependency); each task names the ' +
    'right single tool for its kind (no giant skill task that needs internal ' +
    'fan-out — that belongs in a sequence); general-task deliverables land INSIDE ' +
    'the queue folder as .md (or an explicit format) and no project binding was ' +
    'fabricated for project-independent work; the file matches GTD’s ' +
    'tasks.template schema (no invented fields, validated_at stays null); and the ' +
    'goal is genuinely general/knowledge work — a code-development goal belongs to ' +
    'sk-get-plan-done, not here. Incorporate its findings before presenting ' +
    'the queue.',

  // 'sk-sequence-planner':
  //   'ADVISOR GATE [hook]: before finalizing the command-sequence, spawn a ' +
  //   'high-tier advisor subagent (Agent tool; resolve the tier per CLAUDE.md ' +
  //   'model-tier rules) to adversarially review the draft sequence. Have it check: ' +
  //   'stage ordering, parallel-wave safety (registry-mutating CLI verbs like ' +
  //   'project/service add must stay sequential; a parallel wave has NO intra-wave ' +
  //   'ordering, so multi-step service builds must be phase-split), per-step ' +
  //   'work_dir/scope correctness, and missing verification/gate steps. ' +
  //   'Incorporate its findings before presenting the sequence.',

  // 'sk-bmad-pm':
  //   'ADVISOR GATE [hook]: before handing off the planning pipeline output, spawn ' +
  //   'a high-tier advisor subagent (Agent tool; resolve the tier per CLAUDE.md ' +
  //   'model-tier rules) to adversarially review the produced PRD/epic breakdown: ' +
  //   'requirement coverage vs the source plan, epic boundaries and sequencing, ' +
  //   'story sizing, and PRD↔epic↔story traceability gaps. Incorporate its ' +
  //   'findings before declaring the pipeline complete.',

  // 'sk-get-plan-done':
  //   'ADVISOR GATE [hook]: before presenting the mission plan for user sign-off ' +
  //   '(the one gate before the autonomous loop), spawn a high-tier advisor ' +
  //   'subagent (Agent tool; resolve the tier per CLAUDE.md model-tier rules) to ' +
  //   'adversarially review the plan and derived acceptance criteria. Have it ' +
  //   'check: criteria actually cover the stated goal (no unverifiable or missing ' +
  //   'criteria), the verify command genuinely proves them, scope/working-folder ' +
  //   'alignment, hidden destructive or irreversible steps that need explicit user ' +
  //   'permission, and whether the loop has a sound done-condition (no ' +
  //   'run-forever risk). Incorporate its findings before asking for sign-off.',

  'sk-database-analyst':
    'ADVISOR GATE [hook]: before delivering the final .sql script, spawn a ' +
    'high-tier advisor subagent (Agent tool; resolve the tier per CLAUDE.md ' +
    'model-tier rules) to adversarially review the draft SQL against the ' +
    'project’s committed schema captures. Have it verify: every table, ' +
    'column, and join key exists in the captures (check the raw schema.sql, not ' +
    'only the exploded per-table tree — camelCase/snake_case name pairs ' +
    'collapse there), join cardinality and aggregation correctness (no fan-out ' +
    'double counting), NULL/timezone handling, and that the script stays ' +
    'read-only unless the user explicitly authorized writes (Rule 4). ' +
    'Incorporate its findings before presenting the script.',
};

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    return; // malformed payload — stay out of the way
  }

  // Resolve the invoked skill name across CLIs (see header note).
  const ti = input.tool_input || {};
  let skill;
  if (input.tool_name === 'Skill') skill = ti.skill;
  else if (input.tool_name === 'activate_skill') skill = ti.name;
  else return; // not a skill-activation tool — silent

  const directive = ADVISOR_DIRECTIVES[skill];
  if (!directive) return; // not a gated skill — silent

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: directive,
      },
    })
  );
}

// Framework gate: `sidekicks framework disable <id>` makes this hook a no-op (exit 0).
await import('./lib/hook-gate.mjs')
  .then((gate) => gate.exitIfDisabled('hook.skill-advisor'))
  .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

main();
