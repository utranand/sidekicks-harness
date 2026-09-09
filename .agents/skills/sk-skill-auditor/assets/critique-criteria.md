# Audit criteria — the rubric the auditor critiques a skill against

This is the lens, not a checklist to satisfy. The job is not to find one issue per dimension — it
is to find the issues the **evidence actually supports** and ignore the rest. A skill that scores
clean on every dimension is a real, good outcome; manufacturing a finding to fill a row is the one
failure mode this whole skill exists to prevent.

For every dimension below: the **signal** tells you where to look, the **evidence bar** is what a
filed proposal must cite, and `kind`/`risk` is how the resulting `sk-self-improve` artifact
should be classified. If you cannot meet the evidence bar, the finding does not get filed — log it
as `no_file` and move on. (`auditor.sh evidence <skill>` gives you the cheap measured signals up
front; the SKILL.md read and any run-artifact grep give you the rest.)

## The non-negotiable gate (applies to every dimension)

Before a finding becomes a proposal it must pass the same two gates `sk-self-improve` TRIAGE
enforces — run them yourself first so you never hand TRIAGE an opinion:

1. **Evidence gate** — point at the concrete thing: the line/section in SKILL.md, the measured
   number, the `runtime_errors` entry, the eval miss, the duplicated script across two run
   transcripts. "This could read better" with no anchor is not evidence.
2. **Attribution gate** — the weakness must be the **skill's own**, not the input's. "It failed
   because the user gave a bad path" is input-caused → not a skill defect. The exception that flips
   it: the skill keeps getting hit by the same bad input *because it never guards against it* — then
   "the skill should validate this input up front" IS skill-attributable. File that, not the raw
   input error.

**Then rank by direction (the mission).** Of the findings that pass both gates, prefer the ones that
move the skill toward the **skill-improvement mission** in AGENTS.md (reliable, evidence-grounded,
lean, safe; converging, not churning). A real-but-off-mission finding is low priority; a finding that
would pull *against* the mission — above all, anything that softens a safety/irreversible rule — is
not filed for auto-apply at all (it hits the safety floor). The gates decide what's *true*; the
mission decides what's *worth doing*.

## 1. Description triggering (kind: description, risk: medium) — MEASURED, not eyeballed

This dimension is special: it is not judged by reading the description and forming an opinion. It is
**measured** by the triggering benchmark (see the SKILL.md phase "Triggering benchmark"), which scores
the description against a real should/should-not query set with `scripts/trigger_eval.py` and then
runs the optimize-until-it-can't-score-better loop. The benchmark *is* the evidence engine for this
dimension — a filed finding here carries a measured score delta, the strongest grounding the auditor
can produce **once it has replicated**. A delta from a single scoring run is NOT evidence: the same
description scored twice on this skill's own set gave 18/20 and 20/20, so step 2b.4 requires the
winner's worst score to beat the incumbent's best score across two runs before anything is filed.

- **Signal:** the measured `baseline_score` (current description, passed/total) from the benchmark;
  the specific queries that under-trigger (should fire, didn't) or over-trigger (a near-miss that
  fired); a concrete capability the body delivers that the description never mentions; or a measured
  `description_chars_approx` near/over the 1024 host cap.
- **Evidence bar (the empirical one):** a hand-authored candidate description that **strictly
  out-scores** the current one on the same query set (`baseline_score X/N → best_score Y/N`, Y > X),
  cited with the exact queries it fixed. That measured delta is the finding. If **no** candidate beats
  the current description after the loop converges, dimension 1 is **clean** — the current description
  is already optimal on the measured set; file nothing (the qualitative urge to "make it punchier"
  never overrides a tie or loss in the measurement).
- **Two ways a description finding still files without a score delta:** (a) a concrete capability the
  body delivers that the description omits entirely (callers can't discover it) — propose adding it,
  then *let the benchmark confirm the rewrite doesn't cost triggering*; (b) a measured over-cap length
  — that pairs with `sk-skill-description-trimmer`; say so in the proposal.
- **Discipline of the loop:** candidates are HAND-AUTHORED by the auditor agent and scored with
  `auditor.sh score <slug> <skill> "<candidate>"`, which wraps `trigger_eval.py` and already pins the
  neutral trigger-root, `--num-workers 1` and every `trigger_*` knob — never re-assemble the invocation
  by hand, and never `run_loop.py` / an `anthropic` SDK / an `ANTHROPIC_API_KEY` (AGENTS.md:
  "Skill optimization — manual loop only, never an API key"). A winning description is a normal
  `kind: description` finding: in autonomous mode it is below the safety floor and auto-applies after
  adversarial verification (a refuter checks the rewrite doesn't over-claim or soften anything).

## 2. Rigidity without the why (kind: instructions, risk: medium)

- **Signal:** `rigid_imperatives` count from the evidence manifest; ALL-CAPS MUST/NEVER/ALWAYS in
  SKILL.md.
- **Evidence bar:** a specific rule stated as a bare ALL-CAPS command **with no reasoning given**.
  The unexplained rule, quoted from SKILL.md, **is itself the evidence** — you do **not** need a run
  demonstrating a misread to file it. (Such a run *strengthens* the finding, but requiring one would
  make this dimension inert: almost no skill carries a transcript that proves a rule was misread, yet
  the bare unexplained imperative is a real, citable defect on its own.) File it as a reframe that
  **preserves the constraint and adds the missing why**.
- **Two carve-outs that DROP, not file** (this is the discipline that keeps the dimension from
  becoming "flag every MUST"):
  1. **The reasoning is already there** — the rule carries a `because…` / `so that…` clause, or the
     why is plainly stated right beside it. Nothing to add → drop.
  2. **It's a genuine safety / irreversible-action rule** — DB writes, never-prod, hard stops,
     boundary guards. These are *meant* to be firm and terse; a one-line safety MUST is correct as
     is. Never propose softening one → drop.
- So the test is simple: **bare + unexplained + not-a-safety-rule → file** (add the why, keep the
  constraint); **explained, or safety/irreversible → drop**. "Not every MUST is a defect" — but an
  unexplained, non-safety imperative is exactly the one this dimension exists to catch, and the
  absence of the why is sufficient evidence to file.

## 3. Repeated work that should be bundled (kind: scripts → risk: medium; or kind: assets → risk: low)

- **Signal:** two or more run transcripts/artifacts of this skill independently writing the same
  helper (a `create_x.py`, the same multi-step shell dance), or the SKILL.md telling the model to
  re-derive something deterministic every run.
- **Evidence bar:** cite the repetition concretely — the same script reinvented across ≥2 runs, or a
  deterministic step the body re-explains that a bundled script would settle once. A NEW script the
  skill will *call* is `kind: scripts` (behavior — waits for a human). A pure additive *template /
  reference asset* (no behavior change) is `kind: assets, risk: low`.

## 4. Missing input-validation guard (kind: instructions, risk: medium)

- **Signal:** `runtime_errors` / ledger `issues` showing the skill broke on a malformed or missing
  input, especially the **same** failure across runs.
- **Evidence bar:** a recurring input-caused failure the skill never guards — this is the attribution
  exception above. Propose the up-front check (validate the path/scope/env before the first real
  action), citing the failures it would have caught. A one-off input failure with no recurrence is
  input-caused → `no_file`.

## 5. Progressive-disclosure bloat (kind: instructions, risk: medium)

- **Signal:** `skill_md_lines` well over ~500; large inline reference material that the model only
  needs sometimes; long verbatim duplication of content that lives in another file.
- **Evidence bar:** name what should move out and where (a `references/` or `assets/` file) and why
  it's not always needed — the bloat must be load-bearing on context, not cosmetic. Splitting must
  preserve the trigger-time essentials in SKILL.md; don't bury something the model needs every run.

## 6. Dead or contradictory content (kind: scripts/assets removal or kind: instructions, risk: medium)

- **Signal:** a bundled script/asset nothing references; an instruction that contradicts another
  section or the repo's AGENTS.md; a bundled-asset path that no longer resolves.
- **Evidence bar:** prove the deadness — grep shows zero references to the script/asset; quote the
  two lines that contradict; show the broken path.
- **Carve-out that DROPS:** a script/asset referenced by a **sibling** script rather than by SKILL.md is
  **not** dead. Scope the grep to the skill's whole directory (`grep -rn <basename> <skill-dir>/`), not
  just SKILL.md, before claiming zero references — the benchmark ships a hard control fixture that fails
  exactly this shortcut. Removal/repair of real dead weight is a clean,
  high-value finding; "I'm not sure this is used" is not — verify before filing.

---

## Classifying for the funnel

Every finding you file becomes one `sk-self-improve` artifact. Set `risk` honestly — it
records how far the change reaches. In **classic** mode (autonomous off) `risk` gates the lane:
`risk: low` + `kind: assets` + purely additive can ride the additive auto-apply lane; every behavior
touch (instructions, scripts, description) waits for a human.

In **autonomous** mode (the shipped default) the auditor decides for itself: every finding that
passes adversarial self-verification auto-applies — **regardless of kind or risk** — with the **git
diff as the review** (auto-applies are git-reversible, so a bad change is caught and reverted at
commit time rather than gated behind up-front approval). The **one** exception is the safety floor: a
change that softens a *target skill's* genuine safety / irreversible / permission guard (DB writes —
Rule 4 — never-prod, hard stops), or whose loss is not cleanly git-reversible, is parked as
`proposed` for a human. The floor does **not** park a change merely because it edits the auditor's
own machinery (this rubric, the verification step). When unsure whether a change touches a real
safety guard, mark it so it parks.
