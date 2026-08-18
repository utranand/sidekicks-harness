// =============================================================================
// sk-commander — Workflow script template
// =============================================================================
// This is the EXECUTION ENGINE for the commander. After you (the commander) have
// parsed the user's sequence into ordered stages and classified each wave, ADAPT
// this template to those stages and run it with the `Workflow` tool:
//
//     Workflow({ script: "<the adapted script>", args: { runStamp: "<YYYYMMDD-HHMMSS>" } })
//
// You do NOT hand-spawn subagents, hand-maintain a run-state file, or hand-merge
// worktrees — the Workflow runtime does all of that deterministically: parallel()
// is a real barrier, isolation:'worktree' gives each member a private checkout,
// every agent() call is journaled so an interrupted run resumes via resumeFromRunId,
// and the script's plain JS gives you retry loops and handoff threading for free.
//
// HARD CONSTRAINTS of the Workflow runtime (violating these fails the script):
//   • `meta` must be a PURE LITERAL — no variables, calls, or interpolation. You
//     know the stages at author time, so write the phase titles out literally.
//   • Pure JS only — NO Date.now(), Math.random(), or argless `new Date()` (they
//     break resume). Timestamps come in via `args` (pass runStamp from the CLI);
//     vary per-member by array index, not randomness.
//   • A stage is a global BARRIER. Stages run in order; a wave is parallel() inside
//     that order. This is sequential-stages-with-waves — NOT pipeline() (pipeline is
//     for per-item independent chains, which is not the commander's model).
// =============================================================================

export const meta = {
  name: 'commander-<short-run-label>',          // literal, adapt per run
  description: '<one line: what this pipeline does>',
  phases: [
    // ONE entry per stage; titles must match the phase() calls below exactly.
    { title: 'Stage 1 — sk-bmad-pm' },
    { title: 'Stage 2 — wave (3 services)' },
    { title: 'Stage 3 — sk-bmad-code-review' },
  ],
}

// Stage status tracker — one entry per stage, in declaration order.
// ADAPT: keep this list in sync with meta.phases above (same titles, same count).
// Status lifecycle: todo → inprogress → done | failed
// Stages that never start (barrier not crossed) remain 'todo'; callers treat
// a 'todo' stage in a halted result as 'pending'.
// startedAt / completedAt are ISO-8601 UTC strings populated from subagent reports
// (Workflow scripts cannot call Date.now() — timestamps come in via subagent Bash).
const stages = [
  { title: 'Stage 1 — sk-bmad-pm',          status: 'todo', startedAt: '', completedAt: '' },
  { title: 'Stage 2 — wave (3 services)',            status: 'todo', startedAt: '', completedAt: '' },
  { title: 'Stage 3 — sk-bmad-code-review',  status: 'todo', startedAt: '', completedAt: '' },
]

// Transition a stage to its next status and emit a log line so the user can
// track progress in real time via `/workflows`. Pass ts (ISO string) to include
// the wall-clock time in the log message (omit for the inprogress transition,
// where the time is not yet known; include for done/failed).
function setStatus(idx, next, ts) {
  const prev = stages[idx].status
  stages[idx].status = next
  log(`[${stages[idx].title}] ${prev} → ${next}${ts ? '  @ ' + ts : ''}`)
}

// -----------------------------------------------------------------------------
// Shared helpers (keep these verbatim; adapt only the STAGES section at the end)
// -----------------------------------------------------------------------------

// Every sub-skill step returns this, so the script threads handoffs forward and
// detects failure deterministically instead of parsing prose.
const STEP = {
  type: 'object',
  properties: {
    ok:          { type: 'boolean', description: 'true ONLY if the skill met its success condition (e.g. all stories done, validator converged, expected files written)' },
    outputs:     { type: 'array', items: { type: 'string' }, description: 'absolute paths written or changed' },
    handoff:     { type: 'string', description: 'one line for the next stage: what was produced and where' },
    branch:      { type: 'string', description: 'worktree members only: the branch committed to (empty otherwise)' },
    error:       { type: 'string', description: 'failure detail when ok=false (empty otherwise)' },
    startedAt:   { type: 'string', description: 'ISO-8601 UTC timestamp when this step started — run `date -u +%Y-%m-%dT%H:%M:%SZ` at the very start of your work and record the output here' },
    completedAt: { type: 'string', description: 'ISO-8601 UTC timestamp when this step completed — run `date -u +%Y-%m-%dT%H:%M:%SZ` just before you return and record the output here' },
  },
  required: ['ok', 'outputs', 'handoff'],
}

// A step is a SKILL step (has `step.skill`) or a CLI step (has `step.run`).
const isCli = (step) => typeof step.run === 'string' && step.run.length > 0

// The worktree addendum is identical for both kinds — isolation is about the shared
// .sidekicks/settings.json, which both `sidekicks project/service use` (skills align)
// and registry writes touch. (Registry-mutating CLI steps shouldn't be in a wave at
// all — classify them sequential at author time; see SKILL.md.)
function worktreeAddendum(step, branch) {
  if (!branch) return ''
  const what = isCli(step) ? `the command "${step.run}"` : `the skill "${step.skill}"`
  return `

You are running in an ISOLATED git worktree so your scope alignment cannot collide with sibling steps
running at the same instant (sub-skills run \`sidekicks project use\` / \`service use\`, which write the
shared .sidekicks/settings.json). Work normally. BEFORE you return, commit everything you changed to a
branch named EXACTLY "${branch}":
    git add -A && git commit -m "commander: ${what.replace(/"/g, "'")} @ ${step.work_dir || 'root'}"
Put that branch name in "branch". Do NOT push, merge, or touch any path outside your work_dir's
service directory.`
}

// When the sequence is bound to a Jira card (its top-level `jira:` block, passed in
// via args.jira), every step posts a one-line PROGRESS comment to that card AS IT
// FINISHES — so a stakeholder watching the board sees each step land in real time.
// Posting goes through sk-jira-footprint (which posts via the connector) and is
// strictly best-effort: a Jira failure must NEVER fail the step. The commander posts the
// started/done bookends itself, around this Workflow — this addendum is only the per-step
// progress, done by the step's own executor (which already has Bash). Symmetric with
// worktreeAddendum: appended to both CLI and skill briefs.
const JIRA = (typeof args !== 'undefined' && args && args.jira) || null   // { card, env } or null

function jiraAddendum(step) {
  if (!JIRA || !JIRA.card || !JIRA.env) return ''
  const label = stepLabel(step).replace(/"/g, "'")
  return `

PROGRESS TRACKING (best-effort — never fail the step over this): once this step's work is verified
complete, post a one-line progress note to Jira card ${JIRA.card} so the board tracks it step by step.
Resolve the repo root (walk up for a .sidekicks/ dir), then run:
    "$ROOT/.venv/bin/python" "$ROOT/.agents/skills/sk-jira-footprint/scripts/footprint.py" \\
      progress --card ${JIRA.card} --env ${JIRA.env} --task "${label}" --title "<=8-word plain summary of what this step produced>"
If that command errors (exit 3 or anything else), ignore it and proceed — the step's real result stands.`
}

// The step brief = the agent prompt. Clean context per step so one step's scope
// alignment and reasoning can't bleed into another. `prior` is the accumulated
// one-line handoffs; `branch`, when set, makes this a worktree member.
function brief(step, prior, branch) {
  const ctx = prior.length ? prior.map((h) => `  - ${h}`).join('\n') : '  (none — first stage)'

  // ---- CLI step: run EXACTLY the given command, no improvising ----
  if (isCli(step)) {
    const wd = step.work_dir || 'the repo root'
    return `Run EXACTLY this shell command as ONE step of a larger orchestrated sequence. Do NOT
improvise, add steps, fix unrelated things, or run anything other than the command below.

- Command: ${step.run}
- Working directory: ${wd}
- Context from earlier stages (already complete):
${ctx}

cd into the working directory (if one is given) and run the command. Report tersely for an orchestrator,
not a human: set ok=true ONLY if the command exited 0 — OR if its effect already holds (e.g. a re-run
\`sidekicks service add\` reporting the service already exists is a benign success; this keeps retries
idempotent). On ok=false put the stderr/exit detail in "error". List any paths it created/changed in
outputs, and give a one-line handoff (the command + outcome) for the next stage.

Timestamps: run \`date -u +%Y-%m-%dT%H:%M:%SZ\` at the very start of your work (before cd/command) and record it in startedAt; run it again just before returning and record it in completedAt.${worktreeAddendum(step, branch)}${jiraAddendum(step)}`
  }

  // ---- Skill step ----
  const wd = step.work_dir || 'none — use the skill’s normal scope resolution'
  const dd = step.docs_dir || 'none — the skill defaults its artifacts to its own run base (runs layout v2: a work_item facet, else _adhoc/<skill-id>/docs)'
  const wi = step.work_item || 'none — the skill self-derives one, or falls back to _adhoc/'
  const inputs = (step.inputs && step.inputs.length) ? step.inputs.join(', ') : 'none'
  const docsSuffix = step.docs_dir ? ' docs_dir=' + step.docs_dir : ''
  const workItemSuffix = step.work_item ? ' work_item=' + step.work_item : ''
  return `Invoke the skill "${step.skill}" to accomplish ONE step of a larger orchestrated sequence.

- work_dir: ${wd}
- docs_dir: ${dd}
- work_item: ${wi}
- Instruction: ${step.instruction}
- Inputs to read: ${inputs}
- Context from earlier stages (already complete):
${ctx}

Pass work_dir=${step.work_dir || '(omit)'}${docsSuffix}${workItemSuffix} to the skill so it anchors there, then run the skill to
completion. Report tersely for an orchestrator, not a human: set ok=true ONLY if the skill's success
condition is genuinely met; list absolute paths in outputs; give a one-line handoff for the next stage.

If you hit a genuine judgment fork — an architecture tradeoff, two viable implementations — that your
inputs don't settle: you have no Agent tool to fan out alternatives, so reason the fork through
yourself. Decide, record the choice and its one-line
rationale in your report, and keep moving — don't stall the step on a tradeoff.

Timestamps: run \`date -u +%Y-%m-%dT%H:%M:%SZ\` before you invoke the skill (startedAt) and again just before returning (completedAt).${worktreeAddendum(step, branch)}${jiraAddendum(step)}`
}

// A short, legible label for the progress display (skill name, or the command head).
function stepLabel(step) {
  if (isCli(step)) return `$ ${step.run.length > 40 ? step.run.slice(0, 37) + '…' : step.run}`
  return step.skill
}

// Run one step (skill OR CLI) with up to 3 attempts, feeding the prior failure back each
// retry. Returns the STEP object on success; returns a failed STEP (ok:false) after 3 tries
// — the caller decides whether that halts the run.
//
// A step may carry an OPTIONAL `model` (a model id, e.g. 'claude-haiku-4-5-20251001') to run
// that one step on a specific model — e.g. a cheap model for a trivial CLI/verification step, a
// stronger one for a heavy planning step. Omit it and the agent inherits the session model
// (the right default — only set it when you're confident a different tier fits). An explicit
// opts.model overrides the step's, so a whole wave can be pinned from the call site.
async function runStep(step, prior, opts = {}) {
  const model = opts.model || step.model           // per-step model; undefined => inherit session model
  let last = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    const retryNote = last ? `\n\nPREVIOUS ATTEMPT FAILED: ${last}\nDiagnose and correct course this time.` : ''
    const r = await agent(brief(step, prior, opts.branch) + retryNote, {
      label: `${stepLabel(step)}${step.work_dir ? ' @ ' + step.work_dir : ''}${attempt > 1 ? ` (try ${attempt})` : ''}`,
      phase: opts.phase,
      schema: STEP,
      ...(model ? { model } : {}),
      ...(opts.isolation ? { isolation: opts.isolation } : {}),
    })
    if (r && r.ok) return r
    last = (r && r.error) || 'subagent returned without meeting the success condition'
  }
  return { ok: false, outputs: [], handoff: '', branch: '', error: last }
}

// Merge the disjoint worktree branches of a finished cross-scope wave back into the
// working tree. Returns true on a clean integration. Branches touch DISJOINT service
// subtrees, so a conflict here is proof the wave wasn't independent — surface it.
async function integrate(branches, phaseTitle) {
  if (!branches.length) return true
  const r = await agent(
    `Merge these git branches into the current working branch, in order: ${branches.join(', ')}.
Each was produced by a sibling step in an isolated worktree and touches a DISJOINT service subtree,
so the merges must not conflict. For each branch: \`git merge --no-edit <branch>\`. If ANY merge
conflicts, ABORT it (\`git merge --abort\`), STOP, and report the conflicting branch + files verbatim
(a conflict means the wave was not truly independent). After all merge cleanly, remove the now-merged
worktrees: \`git worktree list\` then \`git worktree remove <path>\` for each commander worktree.
Set ok=true only if every branch merged cleanly.`,
    { label: 'integrate worktrees', phase: phaseTitle, schema: STEP },
  )
  return !!(r && r.ok)
}

// -----------------------------------------------------------------------------
// STAGES — adapt everything below to the parsed sequence
// -----------------------------------------------------------------------------
// Any step (skill OR CLI) may carry an optional `model: '<model-id>'` to pin that step to a
// specific model; runStep passes it straight into the agent() spawn. Omit it to inherit the
// session model (the usual right choice). Example: { run: 'npm test', work_dir: '…/src',
//   model: 'claude-haiku-4-5-20251001' } runs a cheap verification step on Haiku.
// A skill step may also carry `docs_dir: '<path>'` — the artifact anchor for plan-centric
// sk-bmad-* steps (planning artifacts live there; code work stays at work_dir). It often
// arrives embedded in the instruction text instead (`docs_dir=… …`) — keep that verbatim.
//
// PATHS ARE PRE-RESOLVED: every work_dir/docs_dir/artifacts_dir baked below is repo-relative or
// absolute. The commander resolved any leading-dot file-relative anchor (`.`, `./…`, `../…` — see
// SKILL.md "File-relative anchors") against the sequence file's directory at parse time, because this
// Workflow runtime has NO filesystem access and could not resolve them here. Never write a literal
// `.`/`./…`/`../…` work_dir into this script — it would be taken as the repo root, not the bundle.

const handoffs = []                                   // accumulated one-line handoffs
const stamp = (args && args.runStamp) || 'run'        // branch namespacing (no Date.now in scripts)
const summary = []                                    // per-stage report the commander prints
// args.jira ({ card, env }) — when the sequence carried a top-level `jira:` block, the commander
// passes it here and each step posts a per-step progress comment (see JIRA / jiraAddendum above).
// The commander posts the started/done bookends + transitions itself, OUTSIDE this script.

try {
  // ---- A CLI step looks IDENTICAL to a skill step — just `run` instead of `skill`. ----
  // Use one as an early scaffolding stage or a late verification/commit gate, e.g.:
  //   setStatus(0, 'inprogress')
  //   phase('Stage 0 — scaffold svc-a')
  //   const s0 = await runStep(
  //     { run: 'sidekicks service add svc-a git@github.com:acme/svc-a.git' },  // work_dir omitted -> repo root
  //     handoffs, { phase: 'Stage 0 — scaffold svc-a' },
  //   )
  //   summary.push({ stage: 0, kind: 'cli', run: 'sidekicks service add svc-a <git-url>', ...s0 })
  //   stages[0].startedAt = s0.startedAt || ''; stages[0].completedAt = s0.completedAt || ''
  //   setStatus(0, s0.ok ? 'done' : 'failed', s0.completedAt || '')
  //   if (!s0.ok) return { status: 'halted', stage: 0, reason: s0.error, stages, summary }
  //   handoffs.push(s0.handoff)
  // Use the REAL CLI signature — `service add <name> [<git-url>]` (no `--project` flag): the NAME comes
  // FIRST, the opposite of `project add <git-url> [<name>]`, and a URL in the name slot is rejected by
  // the service-name pattern, so the step hard-fails instead of mis-registering. `add` only REGISTERS —
  // a remote-backed service needs a following `sidekicks service pull <name>` before any skill step
  // writes into `src/`. Set the active project with a prior `sidekicks project use <proj>` step.
  // Verify verbs against `node bin/sidekicks --help`.
  // (A verification gate is the same: { run: 'npm test', work_dir: 'projects/acme/services/svc-a/src' }.)
  // Registry-mutating CLI steps stay SEQUENTIAL — never put them in a parallel() wave.

  // ---- Stage 1: a single step (barrier by definition) ----
  setStatus(0, 'inprogress')
  phase('Stage 1 — sk-bmad-pm')
  const s1 = await runStep(
    { skill: 'sk-bmad-pm', work_dir: 'projects/acme/services/svc-a/src',
      instruction: 'Run the full planning pipeline from docs/plan.md.', inputs: ['docs/plan.md'] },
    handoffs, { phase: 'Stage 1 — sk-bmad-pm' },
  )
  summary.push({ stage: 1, kind: 'step', skill: 'sk-bmad-pm', ...s1 })
  stages[0].startedAt = s1.startedAt || ''; stages[0].completedAt = s1.completedAt || ''
  setStatus(0, s1.ok ? 'done' : 'failed', s1.completedAt || '')
  if (!s1.ok) return { status: 'halted', stage: 1, reason: s1.error, stages, summary }
  handoffs.push(s1.handoff)

  // ---- Stage 2: a parallel WAVE ----
  // Classify by work_dir (you do this at author time):
  //   • all members share one work_dir  -> same-scope -> NO isolation (settings.json converges)
  //   • members differ in work_dir       -> cross-scope -> isolation:'worktree' + integrate after
  //   • members sharing one docs_dir (field OR embedded in instructions) -> NEVER a wave: they
  //     write the same PRD/epics/sprint-status tree, and worktrees don't fix it (each commits a
  //     diverged copy of the same files -> integrate conflicts). Serialize those steps instead.
  // Below is the cross-scope case (three different services).
  const STAGE2 = 'Stage 2 — wave (3 services)'
  setStatus(1, 'inprogress')
  phase(STAGE2)
  const wave = [
    { skill: 'sk-bmad-developer', work_dir: 'projects/acme/services/svc-a/src', instruction: 'Implement every ready-for-dev story.' },
    { skill: 'sk-bmad-developer', work_dir: 'projects/acme/services/svc-b/src', instruction: 'Implement every ready-for-dev story.' },
    { skill: 'sk-bmad-developer', work_dir: 'projects/acme/services/svc-c/src', instruction: 'Implement every ready-for-dev story.' },
  ]
  const crossScope = true   // set false for a same-scope wave (drop isolation + integrate)
  const waveResults = await parallel(wave.map((m, i) => () =>
    runStep(m, handoffs, {
      phase: STAGE2,
      ...(crossScope ? { isolation: 'worktree', branch: `commander/${stamp}/stage2-m${i}` } : {}),
    }),
  ))
  // parallel() never rejects: a thrown thunk resolves to null. A failed step is ok:false.
  const done = waveResults.filter((r) => r && r.ok)
  const failedMember = waveResults.some((r) => !r || !r.ok)
  done.forEach((r) => handoffs.push(r.handoff))
  summary.push({ stage: 2, kind: 'wave', members: waveResults })
  // Wave timestamps: earliest startedAt across members, latest completedAt across members.
  // ISO-8601 strings compare lexicographically — no Date parsing needed.
  const waveStartedAt = waveResults.reduce((min, r) => (r && r.startedAt && (!min || r.startedAt < min) ? r.startedAt : min), '')
  const waveCompletedAt = waveResults.reduce((max, r) => (r && r.completedAt && (!max || r.completedAt > max) ? r.completedAt : max), '')
  stages[1].startedAt = waveStartedAt; stages[1].completedAt = waveCompletedAt
  setStatus(1, failedMember ? 'failed' : 'done', waveCompletedAt || '')

  // Integrate the SUCCEEDED members regardless (don't waste good work)...
  if (crossScope) {
    const ok = await integrate(done.map((r) => r.branch).filter(Boolean), STAGE2)
    if (!ok) return { status: 'halted', stage: 2, reason: 'worktree integration conflicted — wave was not independent', stages, summary }
  }
  // ...then halt BEFORE the barrier if any member failed (next stage depends on the whole wave).
  if (failedMember) return { status: 'halted', stage: 2, reason: 'a wave member failed after 3 attempts; barrier not crossed', stages, summary }

  // ---- Stage 3: single step, runs only after the whole wave integrated ----
  setStatus(2, 'inprogress')
  phase('Stage 3 — sk-bmad-code-review')
  const s3 = await runStep(
    { skill: 'sk-bmad-code-review', work_dir: 'projects/acme/services/svc-a/src',
      instruction: 'Senior review of all stories flagged ready-for-review.' },
    handoffs, { phase: 'Stage 3 — sk-bmad-code-review' },
  )
  summary.push({ stage: 3, kind: 'step', skill: 'sk-bmad-code-review', ...s3 })
  stages[2].startedAt = s3.startedAt || ''; stages[2].completedAt = s3.completedAt || ''
  setStatus(2, s3.ok ? 'done' : 'failed', s3.completedAt || '')
  if (!s3.ok) return { status: 'halted', stage: 3, reason: s3.error, stages, summary }
  handoffs.push(s3.handoff)

  return { status: 'completed', summary, stages, handoffs }
} catch (e) {
  // A genuinely missing precondition or runtime error: surface it, don't pretend success.
  return { status: 'halted', reason: String((e && e.message) || e), stages, summary }
}
