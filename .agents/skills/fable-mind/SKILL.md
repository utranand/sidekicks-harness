---
name: fable-mind
description: >-
  Turns this repo's ten standing session defaults into explicit checkpoints a fixed-thinking model
  actually runs — depth-by-stakes triage, re-grounding the plan after every tool result, parallel
  dispatch, independent and adversarial verification, long-horizon coherence, outcome-first
  reporting. Load at the START of any substantive, multi-step, or high-stakes session whenever the
  driving model is NOT Fable/Mythos-class (Claude Opus, Sonnet, Haiku, or any GPT/Gemini model) —
  before the first plan, investigation, review, debug, or build step, even if the user never
  mentions Fable. Also trigger on "think like fable", "fable mode", "fable mind", "/fable-mind",
  "emulate fable", "fable-quality rigor", or when the user asks why results feel shallower than a
  Fable session.
sidekicks:
  runtime-class: framework
---

# Fable Mind — Think Like Fable on Any Model

## What this skill is

`AGENTS.md` → *Session working practices* already states the ten defaults, and they are always in
your context. **This skill does not restate them.** It exists because knowing a principle and
running it at the right moment are different things: Fable applies these natively (adaptive
thinking concentrates depth on hard steps; interleaved thinking re-weighs the plan after every
tool result), while a fixed-thinking model reads the same list and then executes on habit.

What follows is only the **delta** — the two behaviors with no counterpart in the defaults, the
failure mode for each default a non-Fable model actually drops, and the checkpoint ritual that
converts the list into a procedure.

**Applicability check (do this first).** Identify the model driving this session. Fable/Mythos-class
→ these are native; treat this file as a self-audit checklist, not new instruction. Any other model
→ adopt everything below as your operating mode for the whole session, not just the current task.

## The operating loop

```
TRIAGE (stakes?) → GROUND (orient, gather evidence in parallel) → ACT →
RE-GROUND (did this result change the plan?) → … → VERIFY (independently) → REPORT (outcome first)
```

`RE-GROUND` is the station the defaults don't name, and the one most often skipped.

---

## Delta 1 — Re-ground after every meaningful tool result

Opus-era sessions made a plan once and kept executing it after the ground had shifted. Fable
re-weighs the plan against each new result before the next call.

**Standing checkpoint after each meaningful tool result: "does this change my plan?"** If a result
contradicts an assumption the plan rests on, revise *now* — the cheapest moment to correct course
is the moment the evidence arrives. This is Rule 5 applied continuously rather than only at the
start, and it is the single highest-yield habit in this file.

## Delta 2 — Long-horizon coherence

Opus sessions tended to compress or wrap up early under context pressure, and to re-derive facts
already established.

- Do not conclude early because the session is long — the harness summarizes context and the work
  continues. Finish the task or state the genuine blocker.
- Do not re-derive established facts or re-open decisions the user already made. Once the user
  confirms the key decisions or gives a power-through signal, don't re-ask
  (`.sidekicks/memory/feedback-yolo-after-decisions.md`).

---

## Where each default actually gets dropped

The defaults themselves are in `AGENTS.md`; this is the failure mode to watch for in yourself.

| Default | How a fixed-thinking model drops it |
|---|---|
| 1 — Orient once | Serial discovery calls; writing before aligning scope to a supplied `projects/<p>/services/<s>/…` path — this repo's classic failure. |
| 2 — Depth by stakes | Spending evenly, so the irreversible step gets the same thought as a rename. Write out competing options and the deciding evidence *before* choosing. |
| 3 — Parallelize | Serializing by habit. Before every dispatch ask which upcoming calls depend on each other's output; batch the rest. A commander wave is a flat barrier with no intra-wave ordering (`.sidekicks/memory/commander-wave-no-intra-order.md`) — phase-split multi-step builds. |
| 4 — Evidence before claims | Presenting an assumption in the same voice as a verified fact. Mark observed vs assumed explicitly; the reader cannot tell otherwise. |
| 5 — Verify independently | Trusting a worker's transcript. Thirteen of thirteen fan-out deliverables once failed verification after confident reports (`.sidekicks/memory/gtd-api-documenter-subagents-unreliable.md`). Applies to your own work: exercise the artifact, don't re-read your intention. |
| 6 — Adversarial check | Reporting a finding you never tried to kill. Say what would have falsified it. |
| 7 / 8 — Outcome-first, faithful | Narrating chronology ("First I looked at…"); "should work now" without verification. |
| 9 — Persist decisions | Never reading the store back. Load it before the first substantive task if no SessionStart hook did (`sidekicks memory list`). |
| 10 — Plan → execute → verify | Improvising one long session instead of reaching for the resumable engines (BMAD, commander, GTD, GPD). Note: Workflow/Agent tools exist only at a session's top level (`.sidekicks/memory/workflow-tool-top-level-only.md`) — fan-out designs need a sequential fallback. |

**Hard floors are never traded for speed or autonomy** — Rule 4 DB writes, Teleport-only prod
access, and irreversible/outward actions without standing pre-authorization stay firm on every
model in every mode. Emulating Fable's autonomy never means softening a gate.

---

## The checkpoint ritual

Recite at the three natural checkpoints. This is the whole skill in 30 seconds:

**Before acting on a step:**
1. Stakes? High → deliberate options + evidence first (route high-tier if the CLI supports
   subagents; resolve by the `AGENTS.md` tier table, never a pinned model ID). Mechanical → just
   do it.
2. Which upcoming calls are independent? Batch them.

**After each meaningful tool result:**
3. Does this result change the plan? If yes, revise now.
4. Am I about to state something I haven't verified? Verify or mark it assumed.

**Before reporting / marking done:**
5. Did I check the real artifact/behavior, not the executor's (or my own) claim?
6. For a significant finding: did I try to refute it? What would have falsified it?
7. Is the outcome in my first sentence? Is observed vs assumed marked? Is anything hedged that was
   actually verified — or stated flat that wasn't?
8. Any decision worth `sidekicks memory add`?

---

## Deeper reference

The evidence behind every behavior — published vs observed, the Opus/Fable split, per-CLI
degradation notes — is `docs/guide/fable-era-session-practices.md`. Read it for the *why*, or when
re-validating after a model/harness change. Where this skill and `AGENTS.md` disagree, `AGENTS.md`
wins.
