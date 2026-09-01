---
name: sk-commander
description: >-
  RUN a multi-step Sidekicks command-sequence — chain skill A, then a `sidekicks` CLI command, then
  skill B, each in its own subagent anchored to its own work_dir, fanning a stage out to MANY
  subagents in parallel when its steps are independent. Use when the user hands you a ready
  command-sequence and wants it executed, orchestrated, resumed, fanned out, or run
  unattended/overnight (ralph persistence). NOT a queue of headless delegations to external executor
  CLIs (sk-cli-orchestrator owns that loop) or the single-item executor invocation it drives
  (sk-cli-executor).
---

## Trigger guidance

Route ready execution requests here: "run this sequence", "orchestrate these", "run the whole
pipeline end to end", "run steps 1-5", "pipeline these work_dirs", "run these in parallel", "fan
out across services", "build all the services at once", "kick off the plan", or just "go" after a
sequence has been provided. Also trigger on a pasted ordered or numbered list of skills, a
command/plan file listing steps, or a sequence that interleaves CLI commands with skills when the
evident intent is to run it.

The strongest signal is any file or pasted block whose header carries "RUN THIS FILE WITH THE
sk-commander SKILL" or "RUN THIS WITH THE sk-commander SKILL"; execute that artifact
even when the accompanying message is only a path, only the pasted block, or "go". To draft,
validate, lint, or merge a sequence before running, use `sk-sequence-planner` first, then
bring the finished sequence here to run.

## What this skill is

You are a **conductor**. The user hands you a command-sequence and you **execute** it: parse it into an
ordered list of **stages**, decide what runs in parallel and what must wait, classify each wave for the
scope race, **author a Workflow script** that encodes all of that, run it, and report. You don't do the
work yourself; the sub-skills and commands do.

Each step is one of two kinds:

- a **skill step** — names a skill, an optional `work_dir`, and an instruction; the subagent invokes
  that skill (PM, developer, code-review, …) to completion.
- a **CLI step** — a literal shell command (`run:` in a file, `$ …` inline) and an optional `work_dir`
  (its cwd); the subagent runs **exactly that command** and reports the exit result. CLI steps scaffold
  structure (`sidekicks project create`, `service add <name> [<git-url>]` to REGISTER a service, `service pull <name>` to acquire its code into `src/`) *before*
  the skills write into it, set up deps or run migrations, gate the pipeline on tests/lint/build, or
  commit/tag/push to finalize.

A stage is either a **single step** (runs alone) or a **parallel group** — a "wave" of mutually
independent steps run concurrently, with a barrier before the next stage begins.

> **This skill RUNS sequences — it does not author or vet them.** Drafting a sequence from a
> plain-language goal, and validating/linting a sequence before it runs, are the
> **sk-sequence-planner**'s job (read-only, no execution). If the user asks you to "draft",
> "generate", "validate", "check", or "lint" a sequence — or the invocation is tentative ("what would
> this look like") — that's the planner; hand it over rather than running anything. The natural chain is
> **generate → validate (planner) → run (here)**. You may still do a tight safety [pre-flight](#run-procedure-do-this)
> before running, but full authoring/validation lives in the planner.

The whole reason this exists: chaining skills by hand is error-prone — scope drifts between steps,
outputs of one step get lost before the next, a mid-pipeline failure leaves things half-done with no
record, and the obvious win of running independent work at the same time (build three services at once)
either never happens or happens unsafely and corrupts shared state. The commander makes a multi-skill
run repeatable, legible, resumable, and as fast as its dependency structure allows.

### The engine: a Workflow, not hand-rolled dispatch

You execute the sequence by **authoring and running a Workflow** (the `Workflow` tool), not by spawning
and tracking subagents one by one in your own context. The orchestration mechanics that are tedious and
fragile to do by hand — a true barrier across a parallel wave, isolating each cross-scope member in its
own git worktree, retrying a failed step, threading handoffs forward, and above all **journaling every
step so an interrupted run resumes instead of redoing expensive work** — are exactly what the Workflow
runtime does deterministically. You stay a thin conductor: you supply the *intelligence* (parse, classify
waves, write the step briefs, decide what serializes), the runtime supplies the *machinery*. The user
invoking the commander to "run / orchestrate / pipeline" a sequence **is** the request to run that
Workflow — author it and go; don't ask permission per stage.

> **Precondition — the `Workflow` tool is top-level-only.** Only the main session agent has the
> `Workflow` tool; agents spawned *inside* another agent do not. **Check at the start whether you have a
> `Workflow` tool.** If you do, use it. If you don't — you're nested inside a subagent, or in an
> environment without it — use the [Fallback](#fallback--when-the-workflow-tool-isnt-available) instead.
> Don't pretend to run a Workflow you can't call.

The complete, ready-to-adapt script lives in
[`references/commander-workflow-template.js`](references/commander-workflow-template.js). Read it before
you author — it carries the shared helpers (step-brief builder, retry loop, worktree integrator, the
per-step result schema) verbatim, and a worked three-stage example (single step → cross-scope wave →
single step) you adapt the STAGES section of.

---

## Input — parsing a sequence

Accept **either** shape. Parse flexibly — recover an ordered list of **stages**, each being one step or
a parallel group. Every step is one of two shapes:
- **skill step** — `{ skill, work_dir?, docs_dir?, work_item?, instruction, inputs?, model? }`
- **CLI step** — `{ run, work_dir?, model? }`, where `run` is the literal command and `work_dir` is its
  cwd (defaults to the repo root). A step carries `skill` **or** `run`, never both.

**File-relative anchors (relocatable bundles).** A `work_dir`, `docs_dir`, or `artifacts_dir` whose
value is `.` or `..`, or begins with `./`, `../`, `.\` or `..\` (a **leading-dot relative path**), is
resolved **relative to the directory of the command-sequence file** — not the repo root. This is what lets a generated bundle
(launcher + SQL + its own `*.commander.yaml`, all carrying `work_dir: .`) be moved anywhere inside the
repo and still run. Any other relative value (`projects/…`, `.sidekicks/…`, a bare name) stays
**repo-root-relative** as before; absolute stays absolute. Real repo-relative paths never start with
`.`, so the marker is unambiguous. You resolve these at **parse time** (run-procedure step 3a below),
converting each to a repo-relative path *before* authoring the Workflow script — the Workflow runtime
has **no filesystem access**, so it cannot resolve them itself. Leading-dot anchors apply only to a
sequence run **from a file**: an **inline / pasted** sequence has no file to anchor against, so a
leading-dot anchor there is an error — halt and tell the author to use a repo-relative path.

`docs_dir?` is the **artifact anchor** for plan-centric `sk-bmad-*` steps: the skill keeps its
planning artifacts (PRD, epics, sprint-status, stories) at that path while its code work anchors at
`work_dir`. It usually arrives **embedded in the instruction text** (`docs_dir=<path> …` — the
implementation-planner emits it that way) rather than as a YAML key; treat both forms as the same
field, keep it **verbatim** in the step's instruction, and never strip or rewrite it. Steps sharing a
`docs_dir` share artifacts — see the scope-race section below for why that constrains waves.

`work_item?` is the **runs-layout-v2 work-item slug** — a Jira card key, a plan/mission/queue name —
this step's run belongs to. It rides alongside `docs_dir` exactly the same way: usually embedded in the
instruction text (`docs_dir=<path> work_item=<slug> …`) rather than as a separate YAML key, verbatim,
never stripped or rewritten. **You never invent one** — you only carry forward what the sequence
already carries (from the sequence's own top-level context, or a value the sequence's author emitted on
a step's instruction); a step with neither `docs_dir` nor `work_item` simply lets its skill self-derive
or fall back to `_adhoc/`.

`model?` is an optional model id for that step (e.g. `claude-haiku-4-5-20251001`); `runStep` passes it
into the agent spawn so the step runs on that model. Omit it and the step inherits the session model —
the usual right choice. Set it to put a trivial CLI/verification step on a cheap model, or a heavy
planning step on a stronger one.

**A) Inline (pasted in the prompt)** — one step per line, pipe-delimited:
`<skill-name> | work_dir=<path> | docs_dir=<path> | work_item=<slug> | model=<id> | <instruction>`.
`work_dir=`, `docs_dir=`, `work_item=`, and `model=` are optional
tokens before the instruction (any order); a `model=<id>` token sets that step's `model` (e.g.
`model_tier=mid`, common on the build (`sk-bmad-developer`) and review
(`sk-bmad-code-review`) steps), and the instruction is the final pipe segment. A **CLI step** is a line whose command is prefixed with
`$`; everything from the `$` to end-of-line is the literal command (don't split it on `|` — commands
contain pipes), and an optional `work_dir=<path> |` before the `$` sets its cwd (else repo root).
**Numbering carries structure:** a plain integer (`1.`, `2.`) is a sequential stage; steps sharing an
integer with a letter suffix (`2a.`, `2b.`, `2c.`) form **one parallel wave**, and the next stage waits
for all of them.

**B) Command file (path passed in)** — a `.yaml`/`.yml`/`.md` plan with a `steps:` list. Each entry is a
`skill:` step, a `run:` step, or a `parallel:` mapping whose value is a list of steps (a wave). A markdown
file using the same numbered-line shape as (A) is equally valid.

**Top-level keys.** Besides `steps:`, a file may carry `persistence: ralph` (an unattended-run hint —
see *Unattended runs*), a `jira: { card, env }` block (the tracking card progress mirrors to — see
[Jira tracking](#jira-tracking--mirror-each-step-to-the-bound-card)), and `work_item: <slug>` — the
runs-layout-v2 work item the **whole run** belongs to, which is what binds `WORK_ITEM` for the run
folder and the event sidecar (see [Run events](#run-events--the-diagnostic-sidecar)). All three are
top-level only, and a `work_item=` handed in by an orchestrating caller **wins** over the file's own.
The per-step `work_item?` above is unchanged — it stays what that step's own skill anchors to.

> The full input-format spec, the fillable templates, and the *when-to-parallelize* rules live with the
> **sk-sequence-planner** (`assets/*.template.yaml`, `assets/command-sequence.inline.txt`). If a
> user wants to *write* or *vet* a sequence, point them there. Here, you parse a finished sequence to run
> it.

---

## The scope race — what drives isolation

This is the one thing you must classify correctly before fanning anything out. Every Sidekicks sub-skill
aligns scope by running `sidekicks project use` / `service use`, which **write the shared
`.sidekicks/settings.json`**. A sub-skill handed an explicit `work_dir` then anchors to that literal path,
so its own writes are correct regardless — which makes the rule clean:

- **Same `work_dir` on every member of a wave** → all align to the *same* scope; concurrent
  `settings.json` writes converge. Safe. Run as **plain parallel agents** — no isolation.
- **Different `work_dir`s in one wave** (cross-scope) → members write *different* values into the one
  shared `settings.json` at once; a mid-run scope re-read can observe a sibling's clobbered scope (the
  classic "writes leak into the wrong service" failure). Run each member with **`isolation: 'worktree'`**
  — a private checkout (and private `settings.json`) no sibling can touch — committing its disjoint
  subtree to a branch, then merge the branches back after the barrier.

Sequential stages never race (each stage's alignment completes before the next begins). The race exists
only *within* a parallel group with members targeting different scopes.

**CLI steps:** same race surface, plus one sharper hazard worktrees do **not** fix — **registry-mutating**
commands (`sidekicks project create/add/remove/use/set-remote`, `service add/pull/remove/use`) write the shared
`.sidekicks/` registry, not a disjoint `projects/<svc>/` subtree. Two in isolated worktrees would commit
conflicting registry edits and the post-wave merge would conflict. So **registry-mutating CLI steps must
be sequential — never fan them out**; sequence them as their own early stages.

**Verification / build / install CLI steps are EXEMPT from worktree isolation.** A raw `run:` step —
`npm test`, `lint`, `build`, `tsc`, any install — never executes `sidekicks project use` /
`service use`, so it has no shared `.sidekicks/settings.json` race to isolate against, and each such
command touches only its own service tree. So fan such steps out **plain-parallel in the main
checkout** — never as `isolation: 'worktree'` members. A freshly created worktree carries no
`node_modules` (and for a service that is its own repo/submodule, no checked-out `src/` at all), and
CLAUDE.md's hard rule forbids the install that would follow: *"Never install or build inside a
worktree … dev server, tests, builds and type checks execute in the primary local checkout."* Place a
verification stage **after** the post-barrier branch merge of any preceding cross-scope wave — run
before that merge, it tests a tree the wave's changes have not reached.

**A shared `docs_dir` is the same class of hazard — worktrees do NOT fix it.** Two bmad steps carrying
the **same** `docs_dir` (in the step field or embedded in their instructions) write the same
`PRD/epics/sprint-status.yaml` tree. Run plain-parallel they race those files directly; run in isolated
worktrees they each commit a *diverged copy* of the same files and the post-wave `integrate` merge
conflicts — the disjoint-subtrees assumption is broken either way. So **steps sharing a `docs_dir`
never share a wave**; serialize them. Members with *different* `docs_dir` values (or none) follow the
normal `work_dir` classification.

**The same reasoning applies when steps share a `work_item` with no explicit `docs_dir`.** Runs layout
v2 resolves the `sk-bmad-*` family to one shared `bmad` facet under its work item, so two bmad
steps carrying the **same `work_item`** (and no differing explicit `docs_dir`) resolve to the same run
base exactly as if they'd shared a literal `docs_dir` — same hazard, same fix: never wave them,
serialize instead. Steps for **different** skill facets (e.g. a `sk-database-analyst` step and a
`sk-bmad-pm` step sharing one `work_item`) do NOT collide — each skill's facet is its own
subfolder of the work item, so they may still share a wave on their own merits.

---

## Execution model — author a Workflow, then run it

Once the sequence is parsed and classified, translate it into a Workflow script by adapting
[`references/commander-workflow-template.js`](references/commander-workflow-template.js). The mapping is
mechanical:

| Parsed shape | In the script |
|---|---|
| The whole sequence | one `meta` with a literal phase title per stage |
| A single-step stage (skill **or** CLI) | `phase(title)` then `await runStep(step, handoffs, { phase })` — `runStep` builds a skill brief or a CLI brief from whether the step has `skill` or `run` |
| A **same-scope** wave (all members one `work_dir`) | `parallel(members.map(m => () => runStep(m, handoffs, { phase })))` — **no** isolation |
| A **cross-scope** wave (members differ in `work_dir`) | same, but each `runStep(..., { phase, isolation: 'worktree', branch })`, then `integrate(branches)` after the barrier |
| Threading outputs forward | push each successful step's `handoff` onto `handoffs`; later briefs include it |
| Per-step success/failure | the `STEP` schema's `ok` flag — `runStep` retries 3× then returns `ok:false` |
| Per-step timestamps | the `STEP` schema's `startedAt`/`completedAt` ISO strings (each subagent runs `date -u` before/after work); `setStatus` logs them to `/workflows` live; wave timestamps are min/max across members |
| A step pinned to a model | the step's optional `model` flows through `runStep` into the `agent()` spawn; pass `{ model }` in opts to pin a whole wave from the call site (omit → session model) |
| A stage's status transition | `await transition(idx, next, ts, { event, status, step, detail })` — `setStatus` (the legacy mutation) **then** the run event, in that order. See [Run events](#run-events--the-diagnostic-sidecar) |

Things the template already encodes for you (don't re-derive them):

- **The step brief** — each agent gets clean, isolated context: its `work_dir`, instruction, inputs, and
  the accumulated handoffs of prior stages, plus an instruction to invoke the named skill and report
  back tersely via the `STEP` schema. Clean context per step is why one step's scope alignment can't
  bleed into another's. **For a CLI step** the brief tells the agent to run *exactly* that command in its
  `work_dir` (no improvising), set `ok=true` only on exit 0 — or when the command's effect already holds
  (a re-run `service add` reporting "already exists" is a benign success, keeping the 3× retry
  idempotent) — and put the exit/stderr detail in `error` when it fails. Only **failure** detail is
  captured: the `STEP` schema has no success-output field, and a stdout tail never rides in `handoff`
  (one line, interpolated into every later brief).
- **Cross-scope isolation + integration** — worktree members commit their disjoint subtree to a named
  branch; after the wave's barrier, one `integrate` agent merges those branches into the working tree
  (disjoint subtrees ⇒ no conflict) and removes the worktrees. A merge conflict there is proof the wave
  wasn't independent → the script halts and reports it rather than forcing a resolution.
- **Retry then halt** — a failed step retries up to 3× with the prior error fed back. Still failing, a
  single step halts the run; a failed wave member lets its siblings finish, integrates the ones that
  succeeded, then halts **before** crossing the barrier (the next stage depends on the whole wave).
- **Halt, don't fake success** — the script returns `{ status: 'halted', stage, reason, summary }` on
  any unrecoverable failure (including a missing precondition caught by `try/catch`), and
  `{ status: 'completed', summary }` only when every stage's success condition was met.
- **The run-event sidecar** — `transition()`, `emit()`, `emitFinal()` and `reconcileOnResume()` are the
  dual-write legs, already in the right order. You only pass `args.events`; see
  [Run events](#run-events--the-diagnostic-sidecar).
Author the `meta`, the `stages` tracking array, and the STAGES section to match the real parsed sequence;
keep the helpers verbatim. The `stages` array must mirror `meta.phases` exactly (same titles, same count)
so `setStatus(idx, …)` log lines stay coherent with the live progress display. Live status transitions
(`todo → inprogress → done/failed`) are emitted via `log()` and visible in `/workflows` during execution;
a `stages` snapshot is always included in the returned result for the post-run summary.

Pass a timestamp through `args` for branch namespacing — Workflow scripts can't call `Date.now()`:

```
Workflow({ script: "<the adapted script>", args: { runStamp: "<YYYYMMDD-HHMMSS, Asia/Bangkok>" } })
```

Get the stamp with `date '+%Y%m%d-%H%M%S'` before you call the tool.

> **Why subagents and not inline** — the sub-skills (PM, developer, validate-*) are large, multi-phase
> workflows that each consume a lot of context and each rewrite the active scope. Running each in its own
> Workflow agent keeps the commander a thin, durable conductor whose context doesn't balloon — and for a
> cross-scope wave, isolation is also what keeps their `settings.json` writes from colliding.

> **Caveat — services that are their own git repo / submodule.** Worktree isolation isolates the *root*
> repo's tree. If a service's files live in a nested independent repo or submodule, changes there won't
> ride back on a root-repo branch merge. For such a service, run it in its **own sequential stage**
> instead of inside a cross-scope wave, or warn the user its changes must be committed/pushed within that
> nested repo. When unsure whether a service is nested, serialize it.

---

## Resume — via the Workflow journal

A multi-stage pipeline can take a long time and can halt mid-way (a step exhausts retries, the user
interrupts, the process dies). The Workflow runtime **journals every `agent()` call**, so you never re-do
completed work: relaunch with the **same script** and the prior **run ID** and every unchanged step
replays from cache instantly, with the first incomplete step (and everything after it) running live.

When you run the Workflow, the tool returns a **`scriptPath`** and a **`Run ID`** (`wf_…`). To resume:

```
Workflow({ scriptPath: "<the returned path>", resumeFromRunId: "<the returned wf_ id>" })
```

Always **cite both the scriptPath and the run ID in your report** so a resume is one step away. If the
prior run is still alive, stop it first (the tool will tell you). Resume replays cached agents only when
the script is unchanged — if the user edits the plan, author a fresh script and run it new (announce that
the plan changed, so stale cache isn't silently mapped onto different steps).

**Reconcile the event sidecar on every resume** (when events are on). Pass `args` again — the same
`runStamp`/`jira`/`events` — with `events.reconcile` filled in from the halted run's returned `stages`,
so the script's `reconcileOnResume()` fires before its first transition:

```
Workflow({ scriptPath: "<path>", resumeFromRunId: "<wf_id>", args: { runStamp: "<same stamp>",
  events: { runDir: "<repo-relative run dir>", runId: "<same run id>", workItem: "<slug>",
            model: "<optional low-tier model id — the resume path uses it too>",
            reconcile: { currentState: "stage-1:done|stage-2:failed", legacyJson: "<the stages array as JSON>",
                         expectEvent: "step.failed", expectStep: "stage-2" } } } })
```

Resume replays cached `agent()` calls, and that includes the event emitters — so a transition whose
event *was* recorded is not re-appended, and one whose emitter never completed re-runs live and lands
under the same deterministic id. Reconciliation covers the case replay cannot: the run that halted
**because** the append failed, or a fresh launch of the same script in a new session. It appends
`run.reconciled` with the legacy-state digest and never back-fills the events that were missed.

Re-running a step always restarts it from scratch — we can't resume *inside* a sub-skill, and a step that
died mid-run may have written partial artifacts. The sub-skills are idempotent enough to re-enter (they
re-read `work_dir` and reconcile), so re-running a half-done step is safe; resuming into its middle is
not. (`resumeFromRunId` is same-session; across sessions the script file persists on disk — re-run it and
the idempotent sub-skills reconcile, skipping work that's already complete.)

---

## Run events — the diagnostic sidecar

Every stage transition is also appended to a versioned append-only sidecar,
`<run-dir>/events.v1.jsonl`, through the framework CLI (`sidekicks artifacts events`, contract:
[docs/guide/v1.5/run-events.md](../../../docs/guide/v1.5/run-events.md)). The commander is the **pilot
engine** for it.

> **It changes nothing about resume.** The Workflow journal plus the `stages` array remain the source of
> truth; no code path reads an event back to decide where a run continues, and no legacy state is
> rewritten, replayed from, or deleted. The sidecar answers *"what happened, in order, and who did it"*
> for a human or a doctor reading a finished run — and it is **not** memory, the journal, the transcript,
> the agent inbox, or conversation history.

**The run dir and the run id** — resolved once, in your shell, at [step 1](#run-procedure-do-this):

```bash
WORK_ITEM="<the work item this run belongs to: a work_item= handed in by an orchestrating caller WINS; else the sequence's own top-level work_item, or the value every step shares; empty when there is none>"
STAGES_N="<the stage count — fill it from the parse (step 2); leave the --detail off if you are opening the sidecar before you have it>"
RUNDIR="$(node "$ROOT/bin/sidekicks" scope run-base sk-commander ${WORK_ITEM:+"$WORK_ITEM"})"
RUNREL="${RUNDIR#"$ROOT"/}"          # repo-relative — never bake a machine-absolute path into the script
RUNID="commander-$STAMP"             # portable, stable across resumes of the same run
```

**Bind those two explicitly — they are not ambient.** Both come from the parse
([step 2](#run-procedure-do-this)): the sequence's top-level `work_item` and its stage count. Leave
`WORK_ITEM` empty when the sequence carries none (the `${WORK_ITEM:+…}` form below then simply omits the
flag). Skip the binding and it is left implicit, so a run can fall into `_adhoc/sk-commander` even when
its sequence names a work item.

**The five legs, in the order the framework fixes them** (`lib/run-events/schema.mjs`
`DUAL_WRITE_STEPS`). All of them go through the skill's own helper, which builds the intent and hands
the write to the CLI:

| Leg | Who runs it | Command |
|---|---|---|
| 1. preflight | you, in your shell, **before** the first transition | `run-event.mjs preflight --run-dir "$RUNDIR" --json` |
| 2. mutate legacy first | the script | `setStatus(...)`, inside `transition()` |
| 3. append with a deterministic id | the script | `transition(...)` → `emit()` → `run-event.mjs append …` |
| 4. halt on divergence | the script | `transition()` throws; the run halts as `event-sidecar-diverged` |
| 5. reconcile before resume | the script on a resume launch (you, in the [Fallback](#fallback--when-the-workflow-tool-isnt-available)) | `run-event.mjs reconcile --expect-event … --legacy-json …` |

```bash
RE="$ROOT/.agents/skills/sk-commander/scripts/run-event.mjs"
node "$RE" preflight --run-dir "$RUNDIR" --json     # exit 0 = on; exit 4 = OFF for this run
node "$RE" append --run-dir "$RUNDIR" --run-id "$RUNID" --event run.created --status pending \
  ${WORK_ITEM:+--work-item "$WORK_ITEM"} --detail "stages=$STAGES_N" --json
node "$RE" append --run-dir "$RUNDIR" --run-id "$RUNID" --event run.started --status running --json
```

Make the whole `--work-item` **flag** conditional, not just its value, and keep `--detail` quoted:
unquoted `stages=<n>` is shell **redirection**, not a placeholder — the shell reads `<n>` and `>` and
creates a file named `--json`.

Then pass the binding into the Workflow and the template does the rest:

```
args: { runStamp, jira: { card, env }, events: { runDir: "<RUNREL>", runId: "<RUNID>", workItem: "<slug>",
        model: "<optional low-tier model id>" } }
```

`events.model` is **optional**: a **low-tier** model for the event emitters, which each run one literal
command and report an exit code (CLAUDE.md's tier table — Low = mechanical/bulk fan-out). Resolve that
tier to an id that exists in *this* runtime and verify it resolves before passing it; omit the field and
the emitters inherit the session model. It is the per-step `model?` field above applied to the sidecar's
own writes — read that for how a pin behaves — and the [resume](#resume--via-the-workflow-journal) path
passes it again with the rest of `args.events`.

**The two failure modes are answered differently, and the difference is the whole design:**

- **Preflight exits 4 — the subsystem is not available here** (an older CLI, a lifted skill copy in a
  repo without `lib/run-events`, or a pre-existing corrupt sidecar). **Omit `args.events` entirely, run
  the sequence normally, and say so in the report.** A missing *diagnostic* never blocks real work.
- **An append fails after a successful preflight — `event-sidecar-diverged` (exit 3).** The script
  halts **before its next transition** and reports it. Legacy state is authoritative and the run is
  resumable; diagnose with `sidekicks artifacts events check <run-dir>`, then resume — the resume
  reconciles. Never "carry on and catch up later": a trail with an unrecorded gap that nobody noticed
  is worse than a halt, because it reads as complete.

`run.approved` is **not** emitted: the commander has no separate approval gate (it proceeds
autonomously once the pre-flight passes), and inventing the event would put a decision in the trail
that nobody made. Terminal events map `completed` → `run.completed`, a retry-exhausted or
integration-conflict halt → `run.failed`, and a wave barrier that was never crossed → `run.blocked`.

---

## Unattended runs — ralph persistence (optional)

A long pipeline normally needs the human only when it halts — but in an unattended run ("ralph this
sequence", "run it overnight", "keep going even if you stop", or a top-level `persistence: ralph` key in
the sequence file, which the sequence-planner can author) there is nobody present to relaunch after a
session exit or to type the resume call after a transient halt. **Ralph persistence** closes that gap:
arm the `ralph-loop` plugin's Stop hook so an exit attempt re-enters the run, and let the journal-based
resume above do the actual recovery.

**Preconditions.** The plugin is Claude Code-only — verify it exists before arming, and fall back to a
normal run (noting it in the report) when absent:

```bash
RALPH_SETUP=$(ls ~/.claude/plugins/cache/claude-plugins-official/ralph-loop/*/scripts/setup-ralph-loop.sh 2>/dev/null | sort -V | tail -1)
```

Arm **only at the top level** (if you lack the `Workflow` tool you are nested in a subagent — never arm
from there: a subagent's exit doesn't fire the Stop hook, and the state file would hijack the *main*
session's exits instead). Arm **from the repo root** (`$ROOT`) — the state file
`.claude/ralph-loop.local.md` is CWD-relative — and only one loop per repo: if a state file already
exists, don't arm a second.

**Arming — at run start, always with both a cap and a promise:**

```bash
# Guard the two preconditions above IN the arm itself: skip (run normally) if the plugin is absent
# ($RALPH_SETUP empty), and don't arm a second loop if one is already armed for this repo.
if [ -z "$RALPH_SETUP" ]; then
  echo "ralph-loop plugin not found — running without persistence (note it in the report)"
elif [ -f "$ROOT/.claude/ralph-loop.local.md" ]; then
  echo "a ralph loop is already armed for this repo — not arming a second"
else
  cd "$ROOT" && "$RALPH_SETUP" \
    "Invoke the sk-commander skill on the command-sequence at <abs path>. A prior run may already exist in this session — resume it via its Workflow journal (the scriptPath + run ID reported earlier) instead of starting fresh. Attempt at most ONE resume per distinct halt cause; if the same halt repeats, stop trying. When the run completes, or a halt persists after its resume attempt, output <promise>SEQUENCE RUN ENDED</promise>." \
    --max-iterations 5 \
    --completion-promise "SEQUENCE RUN ENDED"
fi
```

**The promise means "the run ended", not "the run succeeded".** Output it truthfully when the Workflow
returns `completed`, **or** when a halt survives its one resume attempt — a structural halt (bad input,
conflicting wave, failed step needing a human fix) is a *result*, and re-running it identically would
burn iterations masking it. The run summary still reports the real status either way; ralph only decides
who restarts the work after an exit, never whether a failure counts as success. Disarm early with
`/cancel-ralph` or `rm "$ROOT/.claude/ralph-loop.local.md"`.

---

## Fallback — when the `Workflow` tool isn't available

If you don't have a `Workflow` tool (you're nested inside a subagent, or in an environment without it),
execute the same plan **by hand** with the `Agent`/Task tool. The *intelligence* is identical — parse,
classify waves, thread handoffs, retry-then-halt — only the machinery is manual. The journal is gone, so
resume relies on the sub-skills being idempotent (they re-read `work_dir` and reconcile); re-invoking on
the same sequence safely re-runs from the start, skipping nothing automatically but not corrupting
completed work.

Walk the stages **in order** (a stage is a barrier — never start stage N+1 until stage N is fully done):

- **Single step** → spawn one subagent with the **step brief** (below), wait for it, capture its handoff,
  thread it forward. Retry a failed step up to 3× (feed the prior error back), then halt.
- **Same-scope wave** (members share one `work_dir`) → spawn all members **concurrently in one turn** as
  plain subagents (no isolation — their scope converges). Barrier: wait for all, then proceed.
- **Cross-scope wave** (members differ in `work_dir`) → spawn all members concurrently, **each with
  `isolation: "worktree"`** and the worktree addendum so it commits its disjoint subtree to a named
  branch. After the barrier, merge those branches into the working tree (disjoint subtrees ⇒ no conflict;
  a conflict means the wave wasn't independent — halt and report). Remove the worktrees.
- **Failure in a wave** → let the other members finish, integrate the ones that succeeded, then halt
  **before** crossing the barrier (the next stage depends on the whole wave).

**The step brief** (the subagent prompt — same content the Workflow template builds):

```
Invoke the skill "<skill>" to accomplish ONE step of a larger orchestrated sequence.

- work_dir: <work_dir, or "none — use the skill's normal scope resolution">
- docs_dir: <docs_dir, or "none — the skill defaults its artifacts to its own run base (runs layout v2: a work_item facet, else _adhoc/<skill-id>/docs)">
- work_item: <work_item, or "none — the skill self-derives one, or falls back to _adhoc/">
- Instruction: <the step's instruction>
- Inputs to read: <inputs, or "none">
- Context from earlier stages (already complete): <one line per prior step: what it produced + paths;
  omit if first stage>

Pass the anchors above that have a value (`work_dir=…`, `docs_dir=…`, `work_item=…`) to the skill so it
anchors there; if none are set, pass no anchor flags and let the skill use its own scope resolution.
Then run it to completion. Report tersely
for an orchestrator, not a human: (a) success or failure (success ONLY if the skill's success condition
is genuinely met), (b) the absolute paths you wrote/changed, (c) the one-line handoff for the next stage.

If you hit a genuine judgment fork — an architecture tradeoff, two viable implementations — that your
inputs don't settle: you have no Agent tool to fan out alternatives, so reason the fork through
yourself. Decide, record the choice and its one-line
rationale in your report, and keep moving — don't stall the step on a tradeoff.
```

**The CLI step brief** (use this instead when the step is a `run` command, not a `skill`):

```
Run EXACTLY this shell command as ONE step of a larger orchestrated sequence. Do not improvise, add
steps, or run anything else.

- Command: <run>
- Working directory: <work_dir, or "repo root">
- Context from earlier stages (already complete): <one line per prior step; omit if first stage>

cd into the working directory (if given) and run the command. Report tersely for an orchestrator:
(a) success or failure — ok=true ONLY if it exited 0, OR its effect already holds (e.g. a `service add`
that reports the target already exists is a benign success on a re-run), (b) any paths it created/changed,
(c) a one-line handoff (the command and its outcome) for the next stage. On failure, put the
stderr/exit detail in the error field.
```

**Worktree addendum** (append for cross-scope members):

```
You are running in an isolated git worktree so your scope alignment (the skill runs `sidekicks project
use` / `service use`, which write the shared .sidekicks/settings.json) cannot collide with siblings
running at the same instant. Work normally. BEFORE you return, commit everything you changed to a branch
named exactly "<branch>":  git add -A && git commit -m "commander: <skill> @ <work_dir>"
Report the branch name. Do not push, merge, or touch anything outside your work_dir's service directory.
```

**Jira progress addendum** (append to every step brief — skill *and* CLI — when a card is bound, so
each step mirrors as it lands, exactly like the Workflow path's `jiraAddendum`):

```
PROGRESS TRACKING (best-effort — never fail the step over this): once this step's work is verified
complete, post a one-line progress note to Jira card <card>. Resolve the repo root (walk up for a
.sidekicks/ dir), then run:
  "$ROOT/.venv/bin/python" "$ROOT/.agents/skills/sk-jira-footprint/scripts/footprint.py" \
    progress --card <card> --env <env> --task "<step label>" --title "<=8-word summary of what this step produced>"
If it errors (exit 3 or anything), ignore it and proceed — the step's real result stands.
```

The commander still posts the `started`/`done` bookends itself, around the whole fallback run — see
[Jira tracking](#jira-tracking--mirror-each-step-to-the-bound-card).

**Run events in the fallback path — you run all five legs yourself** (there is no script and no journal,
so nothing can do it for you). Same helper, same order, same meanings as
[Run events](#run-events--the-diagnostic-sidecar): preflight before the first stage; for each stage,
record the transition in your own head/notes **first** and then append `step.started` /
`step.completed` / `step.failed` with `--step stage-<n>`; on an append failing (exit 3) **stop before the
next stage** and report `event-sidecar-diverged`; and because re-invoking on the same sequence re-runs
from the start, **reconcile first** whenever a sidecar already exists for this run dir:

```bash
node "$RE" reconcile --run-dir "$RUNDIR" --run-id "$RUNID" --current-state "<stage-n:status|…>" \
  --legacy-json '<the stage-status array as JSON>' --expect-event <the transition you are about to make> --json
```

Close with `run.completed` / `run.failed` / `run.blocked` exactly as the Workflow path does.

Report exactly as the [Run summary](#run-summary-always-end-with-this) describes — minus the Workflow
run ID/scriptPath (there is none); cite the worktree paths of any un-integrated members instead.

---

## Run procedure (do this)

1. **Resolve `ROOT`** so you can call the CLI, and get a run stamp: `date '+%Y%m%d-%H%M%S'`.

   ```bash
   ROOT="$PWD"; while [ "$ROOT" != "/" ] && [ ! -d "$ROOT/.sidekicks" ]; do ROOT="$(dirname "$ROOT")"; done
   STAMP="$(date '+%Y%m%d-%H%M%S')"
   ```

   Then open the **run-event sidecar** — [preflight and `run.created`](#run-events--the-diagnostic-sidecar),
   *before* any stage transitions. `preflight` exiting **4** means the subsystem is unavailable here:
   run with recording OFF (omit `args.events`) and note it in the report; never halt over it.

   **Check whether you have a `Workflow` tool** — if not, switch to the
   [Fallback](#fallback--when-the-workflow-tool-isnt-available) for steps 4–6 (everything else is identical).
2. **Parse the sequence** from the inline list or command file into an ordered list of stages (single
   steps and parallel groups). **Read the top-level `jira:` block** if present, and pick up the
   top-level `work_item:` and the **stage count** — those two bind `WORK_ITEM` and `STAGES_N` for the
   sidecar ([Run events](#run-events--the-diagnostic-sidecar)). If there is **none** and
   the user hasn't said to skip tracking, ask **once**: *"Track this run on a Jira card? Give me the
   issue key + env alias, or say none."* A card (given or already bound) turns on mirroring; "none"/skip
   leaves it off. Never block the run on the answer. See
   [Jira tracking](#jira-tracking--mirror-each-step-to-the-bound-card).
3. **Tight safety pre-flight** — a finished sequence may not have been through the planner's full
   validate, so run these *run-blocking* checks before authoring a doomed script (the full checklist
   lives with the **sk-sequence-planner** — if the user wants a complete lint, point them there):
   - every `skill` is in the live available-skills list (unknown skill → halt);
   - every named `inputs:` / referenced plan file exists on disk (missing input → halt);
   - **no dependency inside a wave**, **no two registry-mutating CLI steps in one wave**, and **no two
     bmad steps sharing the same `docs_dir` (or the same `work_item` with neither carrying an explicit,
     differing `docs_dir`) in one wave** (check step fields AND `docs_dir=`/`work_item=` embedded in
     instructions; any of these → halt);
   - each `run` step isn't an obviously destructive command (`rm -rf`, `git push --force`, piping a remote
     script to a shell) the user didn't clearly intend (→ halt and confirm);
   - classify each wave same-scope vs cross-scope (drives isolation — this is information, not a failure).

   On a hard fail, report it and stop — don't author a script that will halt at step one. Otherwise echo
   the parsed plan back as a numbered list, showing waves explicitly (e.g. "Stage 2 (parallel, cross-scope,
   3 members in isolated worktrees): …") so the user sees what will run at what concurrency, and **proceed
   autonomously** — don't ask for confirmation between stages. (If the invocation was clearly tentative —
   "draft a sequence", "what would this look like", "validate this" — that's the
   sk-sequence-planner; hand it over instead of running.)
   3a. **Resolve file-relative anchors** (only when the sequence came from a **file**). For every step,
   rewrite any leading-dot `work_dir` / `docs_dir` / `artifacts_dir` (`.`, `..`, `./…`, `../…`, `.\…`,
   `..\…`; also `docs_dir=` / `artifacts_dir=` embedded in instruction text) to a **repo-relative** path
   before authoring the script — the Workflow runtime has no filesystem access, so this must happen now, in
   your shell. The bundled helper is deterministic + cross-platform and passes repo-relative and
   absolute values through unchanged — but it takes ONE **already-extracted** anchor value as `$VALUE`,
   it does **not** parse tokens. So resolve each anchor by where it lives:
   - **Bare anchor** (a YAML `work_dir:` / `docs_dir:` value) → hand the value straight to the helper.
   - **Embedded anchor** (`docs_dir=<value>` / `artifacts_dir=<value>` inside instruction text) → first
     **extract** the value after the `=`, pass **only** that value as `$VALUE`, then **splice the
     resolved path back** into the instruction string in place of the original. Handing the helper the
     whole `docs_dir=../x` token leaves it unchanged (it isn't a leading-dot value), so the embedded
     anchor would stay unresolved — extract first.

   With `SEQ` = the sequence file's absolute path and `ROOT` from step 1:

   ```bash
   resolved="$(node "$ROOT/.agents/skills/sk-commander/scripts/resolve-anchor.mjs" "$SEQ" "$VALUE" "$ROOT")"
   [ -z "$VALUE" ] || [ -n "$resolved" ] || { echo "resolve-anchor returned nothing for '$VALUE' — halt, do not bake an empty work_dir"; exit 1; }
   # bake `resolved` into the step in place of the original anchor value
   ```

   The emptiness guard is not decoration: an empty anchor is indistinguishable from *no* anchor, so a
   step that silently loses its `work_dir` re-derives scope on its own and can write into the wrong
   service. Only a **non-empty** `$VALUE` is guarded — the helper documents that an empty/undefined
   value returns `''` (the step omits the anchor), and `resolveAnchor` never returns `''` for a
   non-empty input.

   For an **inline / pasted** sequence there is no file — a leading-dot anchor is an error: halt and
   tell the author to use a repo-relative path.
4. **Author the Workflow script** by adapting the template: literal `meta` phases, the STAGES section
   matching the parsed sequence, helpers kept verbatim, cross-scope waves marked for isolation. Every
   `work_dir`/`docs_dir` baked into the script is now repo-relative or absolute (step 3a already
   resolved any leading-dot anchors) — never write a literal `.`/`./…`/`../…` into the script.
5. **If a card is bound, post the `started` bookend** (card → in-progress) *before* launching — see
   [Jira tracking](#jira-tracking--mirror-each-step-to-the-bound-card) — **append `run.started`** when
   events are on, then **run it** via the `Workflow` tool with
   `args: { runStamp, jira: { card, env }, events: { runDir, runId, workItem, model } }` (`model` is the
   optional low-tier emitter model described in [Run events](#run-events--the-diagnostic-sidecar) — omit
   it and the emitters inherit the session model; omit `jira` when
   unbound, omit `events` when preflight said the sidecar is unavailable). It runs in the background and
   notifies you on completion; the user can watch live with `/workflows`.
6. **On completion**, read the workflow's returned `{ status, summary, event_sidecar, … }` and report
   (below). `event_sidecar: 'diverged'` means the trail has a gap — say so, and name
   `sidekicks artifacts events check <run-dir>`; a resume reconciles it. **If a
   card is bound, post the closing bookend**: `done` + transition when `status: completed`, else
   `failed`/`blocked` (no done-transition) with the halt reason — see
   [Jira tracking](#jira-tracking--mirror-each-step-to-the-bound-card). On a halt, the returned
   `stage`/`reason` and the run ID are what the user needs to fix and resume.

   **Diagnose an unclear halt before surfacing it — this is YOUR job, not the template's.** The script
   returns the halt and stops; it contains no diagnosis dispatch. So when a halt's cause cannot be read
   from the journal (not a hard stop, not a missing human input), make **one bounded
   `sk-fable-resolver` dispatch** with the failed step's brief and error tail: it root-causes and
   applies the smallest fix, then resume from the halted stage with
   `Workflow({ scriptPath, resumeFromRunId })` — the journal replays everything already done. **One
   dispatch per stage, ever**: a second identical halt surfaces to the user with the resolver's
   evidence attached.

---

## Run summary (always end with this)

Show the stage structure, marking waves. Members of a wave nest under their stage.

Each stage carries an explicit **Status** label — the live transitions (`todo → inprogress → done`) are
logged in real time via the Workflow engine (visible in `/workflows` while the run is in flight); the
table below reflects the **final state** of each stage:

| Status label | Meaning |
|---|---|
| `todo` | not started (shown during live run only; a stage still `todo` at run end appears as `pending`) |
| `inprogress` | currently executing (live only — transitions to `done` or `failed` on completion) |
| `done` | completed successfully |
| `failed` | exhausted retries without meeting the success condition |
| `pending` | never started because a prior stage failed and the barrier was not crossed |

```
# Commander run — 3 stages (1 wave)

| Stage | Skill | work_dir | Status | Started | Completed | Key outputs |
|-------|-------|----------|--------|---------|-----------|-------------|
| 1 | sk-bmad-pm | …/svc-a/src | ✅ done | 15:10:03Z | 15:22:47Z | docs/PRD.md, docs/epics/, sprint-status.yaml |
| 2 ▸ parallel (cross-scope, 3 in worktrees) | | | ⛔ failed | 15:23:01Z | 16:05:33Z | |
| 2a | sk-bmad-developer | …/svc-a/src | ✅ done | 15:23:01Z | 15:59:14Z | 7 stories → done (merged) |
| 2b | sk-bmad-developer | …/svc-b/src | ✅ done | 15:23:02Z | 16:05:33Z | 4 stories → done (merged) |
| 2c | sk-bmad-developer | …/svc-c/src | ⛔ failed | 15:23:01Z | 15:47:22Z | retries exhausted: <reason> |
| 3 | sk-bmad-code-review | …/svc-a/src | ⏸ pending | — | — | (barrier not crossed) |

Halted in stage 2, member 2c — <one-line reason>. Members 2a/2b are complete and merged; stage 3 did
not start. Final active scope: <project>/<service>.

Resume: Workflow({ scriptPath: "<path>", resumeFromRunId: "<wf_id>" }) — members 2a/2b replay from
cache, only 2c re-runs, then stage 3.
```

If every stage succeeded, say so plainly and list what landed where (and which waves ran in parallel).
Always cite the **scriptPath + run ID** (so the user can inspect or resume) and the **final active
scope**, since the last step left `settings.json` pointing at its `work_dir`.

Add one line for the **run-event sidecar**: its run dir and whether recording was `on`, `off`
(preflight said unavailable — name the reason) or `diverged` (a gap the next resume reconciles). Read it
back with `sidekicks artifacts events show <run-dir>`. Never present it as the resume handle — the
scriptPath and run ID are.

**Run reporting (when commander is on the opt-in list).** Run reporting is triggered *externally* by
`CLAUDE.md`, not wired into this skill — but when `sk-commander` is on the run-reporting opt-in
list, the contract is: alongside the **run summary above** (the sequence completing, halting on a failed
stage, or being stopped) send a completion report via **`sk-slack-connector`** (`report --skill
sk-commander`) to the skill's configured notification channel (resolved
`notifications.skills.<name>` → `notifications.channel` → `default_channel` in the scope config's
`slack:` block), summarizing the stage table's final state (done / failed / pending) and the resume
handle (scriptPath + run ID) — body-only, never attaching the sequence file; and on a **critical event
mid-run** — a stage member exhausting retries (`failed`), or the run halting at a barrier — send a
critical-alert immediately (`--status fail`). These reports go only to the configured channel and are
pre-authorized by that policy, so they send automatically (never ask permission); an arbitrary channel
or recipient is not covered and still needs an explicit OK. **Top-level runs only:** when this sequence
run is itself a step inside a reporting orchestrator's run (a get-things-done queue task, a
get-plan-done mission), skip both report kinds — the caller's own report covers the run, and a second
notification would be redundant.

---

## Jira tracking — mirror each step to the bound card

When the sequence carries a top-level `jira: { card, env }` block (or the user named a card at step 2),
the run mirrors progress to that card so the user can watch their work move on the board step by step.
The commander never builds comment bodies itself — every update goes through **`sk-jira-footprint`**
(which posts via `sk-jira-connector`, the single owner of Jira auth). Resolve it once:

```bash
FP="$ROOT/.agents/skills/sk-jira-footprint/scripts/footprint.py"
"$ROOT/.venv/bin/pip" install -q -r \
  "$ROOT/.agents/skills/sk-jira-footprint/requirements.txt"   # once per run
```

**Two bookends (you post these) + per-step progress (the steps post themselves):**

- **`started` + transition — before launching the Workflow** (so the card flips to in-progress the
  moment the run opens):
  ```bash
  "$ROOT/.venv/bin/python" "$FP" started --card <card> --env <env> \
    --task "commander run" --title "<goal one-liner>" --transition
  ```
- **Per-step `progress` — emitted by each step's own executor**, not by you: pass the binding into the
  Workflow as `args.jira: { card, env }` and the template's `jiraAddendum` adds the post to every step
  brief; in the [Fallback](#fallback--when-the-workflow-tool-isnt-available) path, append the *Jira
  progress addendum* to each brief instead. This is what makes the board update **as each step lands**.
- **Closing bookend — after the run returns:** on `status: completed`, `done` + transition (card → done);
  on a halt, `failed` (or `blocked` if a step was waiting on a human) **without** a done-transition, with
  the halt reason:
  ```bash
  # completed:
  "$ROOT/.venv/bin/python" "$FP" done   --card <card> --env <env> --task "commander run" \
    --title "Sequence complete" --evidence "<n> stages done" --transition
  # halted:
  "$ROOT/.venv/bin/python" "$FP" failed --card <card> --env <env> --task "commander run" \
    --reason "halted in stage <n>: <reason>"
  ```

**Best-effort, never blocking — same contract as GTD/GPD.** The delegate exits `3` on a Jira failure
with the body still printed; note it and carry on — a broken board never stalls or fails the run, and
the run's real result is authoritative. The card binding is the user's standing pre-authorization for
`comment`/`transition` on **that** card only (delete + other-issue edits stay gated), so this mirroring
is **not** the outward-facing hard stop. If the sequence is run **through GTD/GPD** instead of directly,
those skills already mirror (per-task / per-mission) — don't double-bind; let the engine that owns the
run do the mirroring.

---

## Examples

**Example 1 — inline pipeline, one service end to end (all sequential)**

Input:
```
Run this sequence:
1. sk-bmad-pm           | work_dir=projects/acme/services/acme-log-api/src | plan in docs/plan.md
2. sk-bmad-validate-prd | work_dir=projects/acme/services/acme-log-api/src
3. sk-bmad-developer    | work_dir=projects/acme/services/acme-log-api/src | implement everything ready-for-dev
```
Action: parse 3 single-step stages → pre-flight → echo plan → author a Workflow with three sequential
`runStep` stages, threading "PRD + epics + sprint-status written under …/src/docs" into validate-prd,
then into developer → run it → report. No wave, no isolation.

**Example 2 — fan-out across services (cross-scope wave)**

Input:
```
Run this sequence:
1.  sk-bmad-pm          | work_dir=projects/acme/services/svc-a/src | plan from docs/plan.md
2a. sk-bmad-developer   | work_dir=projects/acme/services/svc-a/src | implement ready-for-dev
2b. sk-bmad-developer   | work_dir=projects/acme/services/svc-b/src | implement ready-for-dev
2c. sk-bmad-developer   | work_dir=projects/acme/services/svc-c/src | implement ready-for-dev
3.  sk-bmad-code-review | work_dir=projects/acme/services/svc-a/src | model_tier=mid | review svc-a
```
Action: stage 1 runs alone. Stage 2 is a wave with three different `work_dir`s → **cross-scope** → in the
script, `parallel(...)` of `runStep` calls each with `isolation: 'worktree'` and branch
`commander/<stamp>/stage2-m{0,1,2}`. After the barrier, `integrate` merges the three disjoint branches (no
conflict) and removes the worktrees. Stage 3 runs alone after. Report shows the wave.

**Example 3 — same-scope wave (no isolation)**

Two independent skills on one service that don't share inputs (e.g. drafting stories for two unrelated
epics in the same service). All members share one `work_dir`, so scope converges → `parallel(...)` of
plain `runStep` calls (no `isolation`, no `integrate` step).

**Example 4 — command file with a wave**

Input: `Orchestrate the steps in projects/acme/services/svc-a/src/docs/pipeline.yaml`
Action: read the YAML, parse `steps` (a `parallel:` mapping becomes a wave), pre-flight, author the
matching Workflow, run it, report.

**Example 5 — resuming a halted wave**

A prior run halted in stage 2 (a 3-service wave) with members 2a/2b done and 2c failed. The user fixed
2c's tech spec and says "run it again." Action: relaunch with `Workflow({ scriptPath, resumeFromRunId })`
using the path + run ID from the first run — the journal replays stage 1 and members 2a/2b from cache,
re-runs only 2c (fresh worktree), integrates it, then runs stage 3. Nothing already-done re-executes.

**Example 6 — mixed CLI + skill pipeline (scaffold → plan → build → verify → commit)**

Input:
```
Run this sequence:
1. $ sidekicks project use acme
2. $ sidekicks service add acme-foo git@github.com:acme/acme-foo.git
3. $ sidekicks service pull acme-foo
4. sk-bmad-pm        | work_dir=projects/acme/services/acme-foo/src | Plan from docs/plan.md
5. sk-bmad-developer | work_dir=projects/acme/services/acme-foo/src | Implement every ready-for-dev story
6. work_dir=projects/acme/services/acme-foo/src | $ npm test
7. work_dir=projects/acme/services/acme-foo/src | $ git add -A && git commit -m "feat: acme-foo"
```
Action: seven sequential single-step stages — no wave (every step depends on the prior). Stages 1–3 are
**CLI steps** that scaffold the service — `project use` selects the scope, `service add` **registers**
the service (name FIRST, git-url optional; it records the remote and creates `docs/`, it does **not**
fetch code), and `service pull` is what actually populates `…/src` so the skill steps have somewhere to
write. All three are registry-mutating, so they are correctly sequential and first — three sequential
registry-mutating stages break no rule; only two *within one wave* would.
`runStep` builds each a CLI brief and runs it at the repo root. Stages 4–5 are skill steps. Stage 6 is a
verification gate — a non-zero `npm test` exit halts the run before the commit. Stage 7 finalizes. The
handoff threads forward (e.g. "service acme-foo registered under acme, code pulled into src/" → PM →
developer).

**Example 7 — plan-centric sequence (shared docs_dir → PM stages serialize, one consolidated build)**

Input (emitted by the implementation-planner in its default `docs_mode: plan`, work item `visit-sync`):
```
Run this sequence:
1.  sk-bmad-pm        | work_dir=projects/acme/services/svc-a/src | docs_dir=projects/acme/artifacts/runs/visit-sync/implementation-planner/docs | work_item=visit-sync | Plan svc-a from 02-svc-a/plan.md; record story_targets; write PRD-02-svc-a.md
2.  sk-bmad-pm        | work_dir=projects/acme/services/svc-b/src | docs_dir=projects/acme/artifacts/runs/visit-sync/implementation-planner/docs | work_item=visit-sync | Plan svc-b from 03-svc-b/plan.md; record story_targets; write PRD-03-svc-b.md
3.  sk-bmad-developer | work_dir=projects/acme | docs_dir=projects/acme/artifacts/runs/visit-sync/implementation-planner/docs | work_item=visit-sync | model_tier=mid | Implement every ready-for-dev story; route each story's code to its story_targets entry
```
Action: both PM steps carry the **same `docs_dir`** (and the same `work_item`) — one shared plan docs
tree → they may **never share a wave** even though their `work_dir`s differ — run them as sequential
stages 1 and 2. Stage 3 is one consolidated developer run: it reads the single sprint-status at the
shared docs tree and routes each story's code to its `story_targets` service; cross-service parallelism
happens *inside* that skill, not in the commander's waves. The `docs_dir=`/`work_item=` tokens are
passed through to each skill verbatim.

---

## What this skill does NOT do

- It does not author or validate sequences. Drafting a sequence from a goal, and linting one before it
  runs, are the **sk-sequence-planner**'s job — this skill executes a finished sequence (after a
  tight safety pre-flight).
- It does not parallelize **dependent** steps. A wave is only for mutually independent work touching
  disjoint paths; a chain (PM → validate → story → dev → review) stays sequential. When in doubt, it
  serializes and says why.
- It does not run a cross-scope wave on shared state. Cross-scope members are isolated in worktrees so
  they can't clobber each other's `settings.json`; same-scope members run plain because their scope
  converges.
- It does not write the sub-skills' artifacts itself — each step's skill owns its `work_dir` and writes
  there. For cross-scope members the workflow only *integrates* (merges worktree branches).
- It does not invent or improvise steps. A CLI step runs *exactly* the command the sequence names; if a
  skill is unknown, an input is missing, or a worktree merge conflicts (proof the wave wasn't
  independent), it halts and reports rather than guessing. It won't silently run destructive commands.
- It does not resume from the run-event sidecar, and never makes it authoritative. `events.v1.jsonl` is
  a diagnostic audit trail written *alongside* the Workflow journal; the journal and the `stages` array
  decide where a run continues. It also never rewrites, replays from, or deletes a prior run's events —
  a missing transition is recorded as `run.reconciled`, never back-filled.
