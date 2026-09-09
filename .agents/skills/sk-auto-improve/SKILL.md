---
name: sk-auto-improve
description: >-
  Autonomous, additive-only skill improver — runs unattended across a LIST of target skills,
  sequentially, applying ONLY changes that cannot break anything: an improvement that is risk:low
  AND kind:assets AND purely additive (a new file under the target's assets/) rides
  sk-self-improve's auto-apply lane with NO human. Anything that changes existing behavior
  (instructions, description, scripts, any edit) is filed as a proposed artifact that WAITS for a
  human — never applied here. Persists with a ralph-loop over a resumable ledger
  (artifacts/runs/auto-improve/<slug>/ledger.yaml) that doubles as the exit-status artifact: a run where
  every skill comes back clean is recorded as "N checked, 0 applied, 0 waiting, N clean". Use when
  the user wants to "auto-improve these skills", "apply the safe improvements across skills X, Y, Z
  unattended", or "harvest and auto-apply additive lessons overnight". NOT for behavior changes
  (use sk-self-improve, human-approved) and not for creating skills (skill-creator).
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Skill
version: 0.1.1
sidekicks:
  runtime-class: framework
  logical-id: skill:sk-auto-improve
  depends-on:
    - skill:sk-self-improve
  provides:
    - automated-skill-improvement
---

# sk-auto-improve

The one automated improver that is **safe to run unattended**, because by construction it can only
*add* a new asset file to a skill — it never touches behavior. It drives
[`sk-self-improve`](../sk-self-improve/SKILL.md)'s existing **auto-apply lane**
(`risk:low` + `kind:assets` + purely additive → `approved_by: auto`, no human) across a **list** of
target skills, one at a time, persisted by a **ralph-loop** so a long list survives crashes and
resumes exactly where it stopped.

It is an **applier driven by a list**, not a discoverer: you hand it the target skills (and,
optionally, an evidence source per skill); it does not roam the repo deciding what to improve.

## Scope — root, framework registry

This operates on the framework skill registry, resolved from the git repo root (walk up for
`.sidekicks/` — **never `git rev-parse`**, a service `src/` is its own repo). It does **not** depend
on the active project/service and needs **no** `work_dir` / `docs_dir`. Every run is its own **work
item** — the run **slug** — so it resolves **--bare** (runs layout v2: the run IS the work item, no
facet layer beneath it): `sidekicks scope run-base sk-auto-improve <run-slug> --bare`,
wrapped by `bash "$AI" run-base <slug>` (falls back to the frozen pre-v2 path
`<root>/artifacts/runs/auto-improve/<run-slug>/` when the CLI verb is unavailable). The run ledger
lives at `$RUNBASE/ledger.yaml`. Runs scaffolded before runs layout v2 stay frozen at
`<root>/artifacts/runs/auto-improve/<run-slug>/` — valid read and resume targets, never write targets.

```sh
AI=.agents/skills/sk-auto-improve/scripts/auto_improve.sh
ROOT="$(bash "$AI" root)"        # repo root
RUNBASE="$(bash "$AI" run-base <slug>)"   # this run's --bare v2 folder (or its frozen pre-v2 path)
```

## The hard invariant — the entire safety case

**Auto-apply ONLY when the artifact is `risk:low` AND `kind:assets` AND purely additive** (it adds a
*new* file under the target's `assets/`, editing nothing that exists). That is precisely
self-improve's auto-apply lane, and this skill **never widens it**. For everything else — any
`kind: instructions | description | scripts`, any `risk: medium | high`, any edit to an existing
file — this skill **files a proposed artifact and stops**; the change WAITS for a human via the
normal funnel. "When in doubt, it waits."

This is why no human gate is needed in the loop: the loop is *incapable* of changing behavior. If
you ever find yourself reaching for an approval here, the change doesn't belong in this skill.

## How a single target is processed

For each target skill, in order, do exactly this (delegating every write to a skill through
`sk-self-improve` — this skill never hand-edits a target):

1. **Verify it's an active skill.** `bash "$AI" exists <skill>` — if not, mark the target
   `failed` with an issue ("not an active skill") and move on; never invent a skill.
2. **Gather candidates** by the target's `source`:
   - `source: harvest` (default) — `bash "$AI" proposed <skill>` lists the skill's own
     **already-filed `proposed`** artifacts with a fast additive prefilter (`risk==low &&
     kind==assets → maybe`). These are candidates to auto-apply.
   - `source: <path>` — an evidence file (a run artifact, eval report). Invoke **`sk-self-improve`
     TRIAGE** on it. A `no-file` verdict → record `no_file: <reason>`, outcome `clean`, done. A
     `file` verdict → it becomes a candidate (self-improve PROPOSE writes the artifact).
3. **Classify each candidate** against the hard invariant:
   - **Additive-safe** (`risk:low` + `kind:assets` + purely additive new file) → invoke
     **`sk-self-improve` APPLY** for that artifact via its **auto-apply lane** (no human).
     Record the id in `applied_ids`.
   - **Anything else** → ensure it is filed as a `proposed` artifact (PROPOSE if not already), and
     record its id in `waiting_ids`. Do **not** apply it. Do **not** approve it.
4. **Set the target outcome:** `applied` (only additive-safe applied), `waiting` (only behavior
   changes filed, nothing applied), `mixed` (both), or `clean` (nothing to apply or file). Stamp
   `finished_at`, set `status: done`.

The deterministic prefilter is a fast first pass only — self-improve's APPLY auto-apply lane is the
authoritative gate and re-checks "purely additive" before writing. Defense in depth: this skill
*selects* additive-safe, self-improve *confirms* it.

## START — build the ledger and arm the loop

**Input:** a list of target skills (and optionally a per-skill source). Run from the **repo root**
in the **top-level session** (ralph Pattern 2 — never from a subagent or with a non-root CWD).

1. **Scaffold the ledger:**
   ```sh
   slug=<kebab-run-slug>
   RUNBASE="$(bash "$AI" run-base "$slug")"
   mkdir -p "$RUNBASE"
   bash "$AI" scaffold "$slug" "skillA,skillB,skillC" > "$RUNBASE/ledger.yaml"
   ```
   Then edit any `source:` fields that should be an evidence path instead of `harvest`, and set
   `summary.targets_total`.
2. **Arm ralph** on the main session, max-iterations = `targets + 2`, with a **self-contained**
   prompt that re-invokes THIS skill in RESUME mode each iteration (the hook re-feeds the prompt as
   plain text, not the skill body — so the prompt must name the skill and the ledger):
   ```
   Invoke the sk-auto-improve skill in RESUME mode against the ledger at <RUNBASE>/ledger.yaml
   (the run's v2 --bare folder resolved via `auto_improve.sh run-base <slug>` — substitute the
   actual resolved path here; it falls back to artifacts/runs/auto-improve/<slug>/ledger.yaml on a
   pre-v2 checkout). Process exactly ONE pending target this iteration, honoring
   its additive-only invariant. When the ledger has no pending targets (and control.stage is not
   stop), finalize the run summary, set status: done, and output <promise>AUTO-IMPROVE DONE</promise>.
   Never output the promise while any target is still pending.
   ```
   Invoke `ralph-loop:ralph-loop` with that prompt, `--completion-promise "AUTO-IMPROVE DONE"`,
   `--max-iterations <targets+2>`. (One target per iteration keeps context small — true Ralph.)
3. Tell the user the run is armed, where the ledger is, and that they can `/cancel-ralph` or set
   `control.stage: stop` to halt it.

## RESUME — process the next pending target (one per iteration)

This is what each ralph iteration runs. Keep it tight:

1. Read the ledger. If `control.stage` is `stop` → finalize and emit the promise. If `pause` →
   report and stop the turn without the promise.
2. Pick the **first `pending`** target. None left → **finalize** (below) and emit the promise.
3. Mark it `in_progress`, stamp `started_at`, bump `attempts`, refresh `lease.heartbeat_at`.
4. Process it per **How a single target is processed** above.
5. Write the outcome back to the ledger (`applied_ids` / `waiting_ids` / `no_file` / outcome /
   `status: done`), and append a one-line note to `notes`. On an unexpected failure, append to the
   target's `issues` and `runtime_errors`; if `attempts >= max_attempts`, mark `failed`.
6. If more targets remain, **stop the turn** (do not emit the promise) — ralph re-feeds for the
   next one. Resumability is free: the ledger is the only state, so a killed run picks up at the
   next `pending` target.

## Finalize — the exit-status artifact

When no target is `pending`, roll up `summary` (`applied` / `waiting` / `clean` / `failed` counts
from the targets), set `status: done`, stamp `finished_at`, clear the lease, and write a closing
`notes` line. **A run with `applied: 0 && waiting: 0` is a first-class outcome**, not a failure —
the ledger records "N skills checked, nothing needed an additive change." Report to the user:
counts, the `waiting_ids` that now need their attention (behavior changes the funnel is holding),
and the ledger path. Then emit `<promise>AUTO-IMPROVE DONE</promise>`.

**Run reporting (when auto-improve is on the opt-in list).** Run reporting is triggered *externally* by
`CLAUDE.md`, not wired into this skill — but when `sk-auto-improve` is on the run-reporting
opt-in list, the contract is: with the **final report above** (no target left `pending`,
`status: done`) send a completion report via **`sk-slack-connector`** (`report --skill
sk-auto-improve`) to the skill's configured notification channel (resolved
`notifications.skills.<name>` → `notifications.channel` → `default_channel` in the scope config's
`slack:` block), summarizing the applied / waiting / clean / failed counts and the `waiting_ids` that
now need the user's attention — body-only, never attaching the ledger; and on a **critical event
mid-run** — the run aborting before the sweep completes — send a critical-alert immediately
(`--status fail`). These reports go only to the configured channel and are pre-authorized by that
policy, so they send automatically (never ask permission); an arbitrary channel or recipient is not
covered and still needs an explicit OK.

## What this skill does NOT do

- **It never applies a behavior change.** No instructions/description/scripts edits, no `medium`/
  `high` risk, no edit to an existing file — those are filed and left for a human. The auto-apply
  lane is additive assets only.
- **It never hand-edits a skill.** Every write to a target goes through `sk-self-improve`
  (which goes through `skill-creator`). This skill only reads skills and writes its own ledger.
- **It never approves.** It applies the auto-lane (`approved_by: auto`) and files the rest as
  `proposed`; a human still approves anything that waits.
- **It doesn't discover work.** You give it the target list; it doesn't crawl the repo choosing
  skills to improve.
- **It doesn't create skills.** New skills are `skill-creator`.

## Composition

| Direction | Skill | Role |
|---|---|---|
| drives (per artifact) | `sk-self-improve` | TRIAGE / PROPOSE / APPLY — the funnel; this skill only ever uses its **auto-apply lane** for the safe ones and PROPOSE for the rest |
| executes the write (transitively) | `skill-creator` | the only hands that touch a target skill's files |
| persistence | `ralph-loop` | re-feeds the RESUME prompt each iteration so a long list survives crashes and resumes from the ledger |
