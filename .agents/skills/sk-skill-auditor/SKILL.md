---
name: sk-skill-auditor
description: >-
  Skill auditor — the DISCOVERER half of skill self-improvement. It SWEEPS skills to FIND weaknesses
  nobody has named yet, grounds each in evidence (SKILL.md, runtime_errors, eval misses), critiques
  against a six-point rubric, and TRIAGEs every finding (no evidence or input-caused → dropped).
  Classic mode files lessons as proposals a human reviews; autonomous mode (default) also
  self-verifies and auto-applies its OWN findings with no human — parking anything that softens a
  safety rule or fails verification. Scope a run to one named GROUP of skills (the user names which
  group, e.g. "audit the jira group", from the bundled manifest), every group, or one named skill.
  Use to "audit my skills", "audit the <name> group", "find what to improve", "find missing input
  guards". NOT for an improvement you ALREADY know about — filing, approving or applying one is
  sk-self-improve; additive changes across a list of skills is sk-auto-improve; optimizing a
  description's triggering, or creating a skill, is skill-creator.
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Write
  - Edit
  - Skill
  - Agent
version: 0.31.3
sidekicks:
  runtime-class: framework
  logical-id: skill:sk-skill-auditor
  depends-on:
    - skill:sk-self-improve
  provides:
    - skill-improvement-discovery
---

# sk-skill-auditor

The **discoverer** in the skill-improvement family. It answers the one question the other two
skills deliberately don't: *which skills need improving, and how?*

```
[sk-skill-auditor]   finds + files proposals   (PROPOSE — this skill)
        ↓
[human / the funnel]        approve / reject           (REVIEW — sk-self-improve)
        ↓
[sk-self-improve]    APPLY the approved ones, through skill-creator   (APPLY)
```

`sk-self-improve` APPLY is where an approved artifact actually lands — including the
autonomous lane this skill drives itself. `sk-auto-improve` is a **side branch, not the main
path**: an applier **driven by a list you hand it** that can only *auto-apply* an artifact which is
`proposed` + `risk: low` + `kind: assets` + a new file under the target's `assets/` — a shape this
rubric rarely files, since dimensions 1-6 produce `description` / `instructions` / `scripts` and the
one `kind: assets` filing (the 2b.1 eval set) lands in `evals/`, outside that lane. Neither of them
decides what to improve. This skill fills exactly that gap: it roams the registry, reasons about each skill's own
weaknesses **from evidence**, and files proposals. In its **classic** mode it then stops — output
lands as `proposed` artifacts a human reviews. In its **autonomous** mode (`autonomous: true`,
shipped on) it goes the rest of the way with **no human in the loop**: it adversarially
self-verifies each finding and auto-applies the survivors — but only **below a hard safety floor**;
anything that would soften a safety/irreversible rule, or that fails verification, it **parks** as a
`proposed` artifact for a human. The verification + the floor are what make autonomy safe; see
[The discipline](#the-discipline--why-this-skill-is-so-careful) and the per-skill flow below.

## The discipline — why this skill is so careful

A discoverer that "thinks up" improvements with no grounding produces plausible-but-wrong proposals:
confident rewrites of rules that were already correct, "cleanups" that delete load-bearing
instructions, restructures nobody needed. That failure mode is the entire reason the evidence and
attribution gates exist. So this skill's governing rule is: **every filed proposal cites concrete
evidence from the audited skill, and the weakness is the skill's own — not the input's.** A finding
that can't meet that bar is *dropped*, not softened into a vague suggestion. Auditing a skill and
filing nothing is the expected outcome for a healthy skill, and it is success.

This is also why the **gate runs at the strongest model tier** (high — `claude-opus-*` or the active
CLI's top reasoning model; resolve by tier, see AGENTS.md). Deciding what files is the
highest-judgment, highest-leverage, highest-risk work in the whole improvement loop — its output
shapes every future run of the skills it touches, so it never runs below the strongest model.

**Discovery, though, fans out across tiers — the gate does not.** Auditing a skill is a
find-then-verify split: a *discovery panel* of subagents at several tiers (high/mid/low, from
`audit-config.yaml`) each critiques the same evidence and surfaces candidate findings — different
tiers genuinely see different real issues, so the cheap ones buy breadth. Then **every candidate,
whatever tier raised it, is verified at the `verify_tier` (strong) against the evidence and
attribution gates before anything is filed.** Breadth is cheap and parallel; the deciding stays
strong and central. A low-tier subagent can *suggest*; only the strong gate *files*.

**Why auto-applying (autonomous mode) is still safe.** Removing the human raises the stakes — a
plausible-but-wrong finding could ship — so autonomy does not relax the discipline; it stacks two
more layers on top of it. (1) **Adversarial self-verification:** before any finding auto-applies,
`verify_votes` *independent* subagents each try to *refute* it (defaulting to "reject if uncertain");
it survives only on a majority of confirmations — the machine standing in for the human reviewer,
deliberately biased toward rejection. (2) **The hard safety floor:** a change that would soften a
**target skill's** safety/irreversible/permission rule (DB writes — Rule 4 — never-prod, hard stops),
or whose loss is not cleanly git-reversible, is **never** auto-applied no matter how confident the
votes — it is parked for a human, and the floor is enforced twice (here and again at APPLY). The
floor is deliberately scoped to **genuine safety guards in the skills being improved**: it does
**not** park a change merely because it touches the auditor's own machinery (this rubric, the
verification step) — those auto-apply like any other verified finding. Everything that lands is
git-reversible, and **the git diff is the review** for everything below the floor. So the autonomy is
real but bounded: ship every verified change below the floor unattended, park only the genuine
target-skill safety edits for a human. When in doubt about a *safety guard*, it parks.

## Scope — root, the framework skill registry

This operates on the framework skill registry, resolved from the git repo root (walk up for
`.sidekicks/` — **never `git rev-parse`**; a service `src/` is its own repo). *Which skills* it
audits never depends on the active project/service, and it needs **no** `work_dir` / `docs_dir`.
**But where it WRITES does:** every run is its own **work item** — the audit-run **slug** — and it
resolves **--bare** (runs layout v2: the run IS the work item, no facet layer beneath it) through
`sidekicks scope run-base sk-skill-auditor <run-slug> --bare`, wrapped by
`bash "$AUD" run-base <slug>` (falls back to the frozen pre-v2 path
`<root>/artifacts/runs/skill-auditor/<run-slug>/` when the CLI verb is unavailable — never
hand-join the path yourself). That CLI verb anchors at the **active project**, so the run inherits
the active project's artifacts base — and **the scope must not change mid-run**, or the base moves
under the run and its state splits across two trees.

**So START pins the base and exports it, and the pin travels into every prompt** (`SIDEKICKS_RUN_BASE`
— `auditor.sh run_base` returns it verbatim and skips resolution entirely):

```sh
export SIDEKICKS_RUN_BASE="$(bash "$AUD" run-base "$slug")"
export SIDEKICKS_RUN_SLUG="$slug"     # WHICH run the pin belongs to — export both, always
```

**Export the companion, not just the pin.** `run_base` returns the pin *verbatim* and never looks at
the slug it was handed, so a pinned shell would otherwise answer for the pinned run no matter which
slug a verb was given — and two verbs make that expensive: `clean <other-slug>` deletes the **pinned**
run's `trigger/` while printing the other slug's name, and `takeover <other-slug>` rewrites the
**pinned** run's lease once its ledger ages past the TTL. `SIDEKICKS_RUN_SLUG` is what lets `run_base`
tell "my run" from "some other run": on a mismatch it warns and resolves normally instead of silently
answering for the wrong one. It deliberately does **not** fail hard — `assert` reaches `run_base`
through `read_base` under `set -euo pipefail`, so a nonzero return there would kill `assert` with that
status, and the ralph prompt reads 1 and 4 as *"superseded or cancelled: stop, no writes, no promise"*.
Failing soft keeps a healthy audit alive; failing hard would abandon it. With the companion absent the
pin is honored unchanged, so older callers and the test harness are unaffected.

This is not belt-and-braces. Measured across real runs: 4 slugs ended up with folders under **two**
bases (`<root>/artifacts/runs/<slug>/` and `projects/<p>/artifacts/runs/<slug>/`) — one with a
separate `ledger.yaml` on *each* side — after `.sidekicks/settings.json` flipped `active_project`
mid-run with no human input; and the single run that did export the pin was the only one that stayed
whole. Reading is defended separately: `read_base` tries the resolved base, then the frozen pre-v2
path, then `<root>/artifacts/runs/<slug>/` — the last rung is why `report` can still render a run
written while root scope was active.

Everything a run persists lives under that resolved `$RUNBASE`:

| Artifact | What it is |
|---|---|
| `ledger.yaml` | live resumable state — the run's only source of truth (mutated every round) |
| `log/<skill>.log` | per-skill timestamped trail, appended as the loop goes (`auditor.sh logline`) |
| `audit-report.md` | the run's **readable result** — prose, for the human deciding whether the branch merges |
| `audit-record.json` | the same result normalized — for the next run / trend tooling |
| `trigger/<skill>-<label>.json` | each retained triggering-benchmark score, so step 2b can re-read earlier runs (`auditor.sh score`; swept by `clean <slug>`) |

The last two are **derived from `ledger.yaml`** by `bash "$AUD" report <slug>` (see
[Reporting the result](#reporting-the-result)), never hand-authored, so they cannot disagree with the
run. Runs scaffolded before runs layout v2 stay frozen at
`<root>/artifacts/runs/skill-auditor/<run-slug>/` — valid read and resume targets, never write
targets; `auditor.sh run-base` is the only place that decides which shape a given slug resolves to
(honoring the pin when `SIDEKICKS_RUN_SLUG` says it belongs to that slug — see below).

```sh
AUD=.agents/skills/sk-skill-auditor/scripts/auditor.sh
ROOT="$(bash "$AUD" root)"          # repo root (dir containing .sidekicks/)
RUNBASE="$(bash "$AUD" run-base <slug>)"   # this run's --bare v2 folder (or its frozen pre-v2 path)
export SIDEKICKS_RUN_BASE="$RUNBASE"       # PIN it — every later call for THIS slug skips re-resolution
export SIDEKICKS_RUN_SLUG=<slug>           # …and say which run the pin is for (see above)
```

### What's in scope — named groups (bundled default, AGENTS.md overrides)

Coverage is set by **named groups** alone — the sole which-skills policy (`bash "$AUD" groups` /
`group <name>`). The manifest is a **portable default bundled in this skill** at
[assets/audit-groups.yaml](assets/audit-groups.yaml), so the auditor travels self-contained and a
fresh clone audits a sensible set with no external wiring. The repo's `AGENTS.md` **may override** it:
if AGENTS.md carries its own `skill-auditing groups:` block, that block **wins wholesale** (the
bundled default is ignored — a whole-block replacement, not a merge); otherwise the bundled default is
used. `group_md` in `auditor.sh` resolves the effective source, so every group command is
source-agnostic. Edit the bundled asset to change the standing default; add a block to AGENTS.md to
retune coverage for one repo without touching the skill.

- **groups** (`skill-auditing groups:`) — the **audit manifest**: named clusters of related skills
  (e.g. `jira`, `planning`, `delivery`). A skill is auditable only if it belongs to some group; to
  keep one out of audits, leave it out of every group (there is no separate opt-out list). A run
  targets **one named group** (its base set = that group's members) — the preferred, bounded way to
  run; see START for the **name-the-group** requirement. An **ungrouped** run (no name given) sweeps
  the **union of every group** — the whole manifest.

`bash "$AUD" targets [group]` returns the resolved set: base (the named group's members when a
`group` is given, else the union of all groups; or every active skill only if no groups are defined
at all), minus anything in the `.sidekicks/skill-offloaded/` archive — which sits OUTSIDE the scanned
`.agents/skills/` tree, so it never enters the base set in the first place (the literal
`skill-offloaded` name filters in `auditor.sh` are a no-op backstop, not the operative exclusion).
**The auditor excludes itself by default** (auditing
yourself is opt-in dogfooding, not a surprise in a whole-manifest run) — it is kept when either the
additive **`audit_self` knob** (`audit-config.yaml`, **`false` by default** — self-audit is opt-in) is
turned on, which injects it into an *ungrouped*
sweep, *or* it is explicitly placed in the named group being run, so it can audit and propose
improvements to its own SKILL.md/rubric/scripts like any other target. A run can be scoped narrower
still by handing an explicit skill list to START.

#### The reserved `single` group — a rotating cursor over the whole manifest

`single` is a **reserved** group name, not a members list. Auditing it audits **exactly one skill**
— the one a persisted *cursor* points at — and then advances the cursor to the **next** skill, so
running `audit the single group` again and again rolls through the entire registry **one skill per
run**, always resuming where the last run stopped. It is the bite-sized counterpart to a full
ungrouped sweep: same coverage over time, but one small auditable chunk at a time.

- **Pool & order.** The cursor rotates through the **union of every other group** — `bash "$AUD"
  single-pool` (group-file order, deduped; self filtered **unless a pooled group lists it or `audit_self`
  is on — the pool mirrors `targets` on keep-self, including the inject-when-ungrouped path**, and the
  offloaded archive already absent —
it lives outside the scanned tree). The `single` block in
  `audit-groups.yaml` is excluded from this union and its literal member is ignored.
- **Cursor state.** Persisted at `artifacts/runs/skill-auditor/single-rotation.yaml` — git-ignored
  run state, durable on disk across runs (it does not travel between clones; that is fine — rotation
  position is local). `bash "$AUD" single-current` prints the skill to audit now (falls back to the
  first pooled skill when there is no state or the saved cursor has left the pool); `single-advance`
  moves it past the just-audited skill, wrapping at the end; `single-status` shows cursor /
  last-audited / position; `single-reset [skill]` steers it (no arg → first pooled skill).
- **Resolution.** `bash "$AUD" targets single` and `group single` both resolve to the **one** cursor
  skill, so the standard START scaffold audits exactly it this run.

### How an audit runs — the config asset

The *which-skills* policy is the bundled [assets/audit-groups.yaml](assets/audit-groups.yaml)
(AGENTS.md overrides); the *how* is in
[assets/audit-config.yaml](assets/audit-config.yaml) (`bash "$AUD" config`): the `tiers` that form
the discovery panel, the strong `verify_tier` that gates, `dry_rounds_to_converge` +
`max_rounds_per_skill` (the loop-until-converged controls — how many consecutive dry rounds end a
skill, and the hard backstop on total rounds), and `audit_self` (keep the auditor in the sweep — see
the scope note above). Defaults are sane; a run may override any knob and the ledger records what it
used.

## The audit criteria

The rubric — six dimensions, each with its evidence bar and how to classify the resulting artifact —
lives in [assets/critique-criteria.md](assets/critique-criteria.md). **Read it before auditing your
first skill** and keep it in mind for the rest of the run. The short version: description triggering,
rigidity-without-the-why, repeated work that should be bundled, missing input guards,
progressive-disclosure bloat, dead/contradictory content — and over every one of them, the evidence
gate and the attribution gate. Don't file what you can't ground.

**Dimension 1 is special — it is MEASURED, not eyeballed.** Description triggering is settled by the
**triggering benchmark** (step 2b below): score the description against a real should/should-not query
set with `scripts/trigger_eval.py`, then run the optimize-until-it-can't-score-better loop, with the
auditor agent hand-authoring candidates (manual loop, **never an API key**). The measured score delta
is the evidence. The other five dimensions are judged in the discovery rounds.

## How a single skill is audited

For each in-scope skill, do exactly this. Every write to a target goes through
`sk-self-improve` — this skill **never** hand-edits a target or writes into its
`improvements/` folder directly. **Log every round** with `bash "$AUD" logline <slug> <skill>
"<msg>"` so each skill's audit carries a timestamped trail (tier, candidates, filed, dropped) — and
mirror the structured version into the target's `rounds` list in the ledger.

1. **Confirm it's active.** `bash "$AUD" exists <skill>` — if not, mark the target `failed` with the
   issue ("not an active skill") and move on. Never invent a skill.
2. **Gather evidence (once, shared by the panel).** `bash "$AUD" evidence <skill>` prints the
   manifest — SKILL.md path + line count, approximate description length, the rigid-imperative count,
   and pointers to `evals/`, prior `improvements/INDEX.md`, `scripts/`, `assets/`, and the
   run-artifact globs. Then actually **read** what matters: the SKILL.md in full, the prior
   INDEX/TRIAGE log (so you dedup, never re-file a known lesson), and — the highest-value source —
   grep the run-artifact globs for this skill's name to find `runtime_errors` / ledger `issues` it
   left behind. Evidence first; opinion never.

   **Also capture the target's health baseline now, before anything is applied:**
   `node bin/sidekicks skill doctor <skill>` — record its error/notice counts in the target's
   `doctor_before`. Step 7 compares against this after each auto-apply; without a pre-run reading
   there is nothing to compare to, and a regression this run caused is indistinguishable from
   breakage it inherited.

   **2b. Triggering benchmark — MEASURE dimension 1, then optimize until it can't score better.**
   This runs **once per skill, always** (there is no knob to skip it) — it is how dimension 1
   (description triggering) is decided: by *measurement*, not by reading the description and forming an
   opinion. It is a self-contained loop that produces **at most one** `kind: description` finding,
   which then rides the same verify → auto-apply machinery as discovery findings (steps 6–7). The
   whole loop is the **manual loop** AGENTS.md mandates — `scripts/trigger_eval.py` *scores* (it shells
   `claude -p`); **you** are the proposer. **Never** `run_loop.py` / the `anthropic` SDK / an
   `ANTHROPIC_API_KEY` — the auditor doesn't even bundle that path. **Resumability:** if the target's
   `trigger_eval.baseline_score` is already set from a prior interrupted attempt, skip straight to
   whatever step it stopped at; never re-score from scratch — a score is the run's most expensive call
   (a live `claude -p` per query x `runs_per_query`, minutes per invocation), and re-running one under a
   label it already used **overwrites** the retained `trigger/<skill>-<label>.json` that 2b.4's replicated
   comparison reads. The collision counter only protects an *unlabelled* score, so re-scoring `baseline`
   destroys one of the four observations the replication bar needs.

   ```sh
   # $1 = candidate description (empty string = the CURRENT one) · $2 = label for the retained JSON.
   # The candidate slot is ALWAYS passed, even empty: the label is auditor.sh's 4th positional arg,
   # so dropping an empty $1 would slide the label into the candidate slot and score the label text.
   score() { bash "$AUD" score "$slug" "$skill" "${1-}" ${2:+"$2"}; }
   score "" baseline            # the incumbent description
   score "$cand" cand-1         # a candidate, scored WITHOUT editing the skill
   ```

   **Always pass a label.** Each score is retained at `$RUNBASE/trigger/<skill>-<label>.json` (the
   path is echoed on stderr; the JSON still comes back on stdout), and 2b.3 and 2b.4 below *re-read*
   earlier scores — the failing-query list and the replicated pair. Without labels the retained files
   are numbered `1, 2, 3…` and which is which stops being recoverable, which is how three earlier runs
   each invented their own filenames. Suggested labels: `baseline`, `cand-N`, `baseline-r`, `cand-N-r`.

   That one verb settles the whole deterministic half: it resolves the repo-root venv interpreter
   (POSIX **and** Windows), the skill's `evals/trigger-eval.json`, the **neutral trigger-root** (so the
   live installed skill can't compete for its own trigger and poison the score), and every `trigger_*`
   knob — then execs `scripts/trigger_eval.py` and passes its JSON through. Keep it that way: the
   invariants it enforces are `--num-workers 1` (a rate scored above one worker cannot be trusted) and
   **scores only, never proposes** — you are the proposer, and no API-key path exists anywhere in it.
   Exit codes: `1` not a skill · `3` no repo-root `.venv` · `4` no eval set committed yet (do 2b.1
   first). A second argument is a **candidate** description, scored *without editing the skill*.

   1. **Resolve the query set.** If `.agents/skills/<skill>/evals/trigger-eval.json` exists (the path
      the `score` verb resolves, and `bash "$AUD" eval-set <skill>` prints), use it. If **not**, GENERATE
      ~`trigger_eval_set_size` realistic queries — ~half `should_trigger: true` (varied phrasings, casual
      + formal, uncommon uses, cases where this skill competes with a neighbor but should win) and ~half
      `should_trigger: false` **near-misses** (share keywords/concepts but a neighbor should win; the
      tricky ones, never trivially-irrelevant). Make them concrete and detailed (paths, names, values),
      the way a real user types. Then **file the set via `sk-self-improve` PROPOSE** as
      `kind: assets, risk: low` (purely additive test scaffolding) so it commits to that path; record the
      id in `trigger_eval.eval_set_id`. Read it back from disk to score. **Be accurate about the lane:**
      the destination is `evals/`, which is *outside* the `assets/`-scoped additive auto-apply lane — so in
      autonomous mode it rides the autonomous-verified lane like any other finding (verify it per steps
      6–7 before applying), and in **classic** mode it waits for a human, which means a skill with no
      committed query set cannot finish 2b unattended in classic mode. Say so rather than assuming a lane. **In classic mode, say what happens next too:** the set stays
      `proposed`, `score` exits 4, so 2b cannot complete — append `2b-blocked-on-eval-set (classic)` to
      the target's `issues` (a RENDERED field; an unrecognised `trigger_eval` key renders as `—`, which
      is indistinguishable from a benchmark never attempted), skip 2b, and audit the other five
      dimensions. This is the majority case, not an edge: 91 of 122 skills carry no committed set.
      (Filing through self-improve keeps the single-write-path invariant: the auditor still never
      hand-writes into a target.)
   2. **Score the baseline.** `score` with no candidate → the current description's `passed/total`.
      Record `trigger_eval.baseline_score` and `eval_set_size`. If it is already **perfect**
      (`passed == total`), dimension 1 is **clean** — log it, set `best_score == baseline`,
      `converged: true`, file no description finding, and finish 2b. (A noisy run can *fake* a
      non-perfect baseline and send you into the loop below for nothing — that costs candidates, but it
      errs toward filing nothing, which is why this exit stays single-sample. The dangerous direction is
      the other one, which step 4 gates.)
   3. **Optimize until it can't score better** (the "do until cannot get better" loop). Track
      `best` (= baseline to start), `best_desc` (= current), a `dry` streak, and `tried`. Each pass:
      read the **failing** queries from the last score's retained JSON (`$RUNBASE/trigger/<skill>-<label>.json`), then **hand-author** a candidate description
      that keeps everything the skill genuinely does, fixes the misses (more *pushy/discoverable*
      against under-trigger; sharper *boundaries vs. the named neighbor* against an over-triggering
      near-miss), and stays **≤ 1024 chars**. Score it with `score "<candidate>"` (this tests it
      **without** editing the skill). `tried++`. If it **strictly** beats `best` → adopt it
      (`best`/`best_desc` updated, `dry = 0`); else `dry++`. **Stop** when `best == total` (perfect),
      **or** `dry == trigger_score_dry_to_converge` (score plateaued — converged), **or**
      `tried == trigger_max_candidates` (backstop → record `converged: false`). The bar never relaxes:
      a candidate that ties or loses is **not** an improvement.
   4. **File the winner — or record clean. REPLICATE FIRST; a single-run delta is not evidence.**
      Before filing anything, re-score BOTH the incumbent description and the winning candidate once more
      on the same set (2 extra `score` runs, only ever on this branch) — label them `baseline-r` and
      `cand-N-r` so all four scores stay side by side under `$RUNBASE/trigger/` and the comparison is
      re-checkable after the run. **Re-score both on the SAME scorer code:** if `scripts/trigger_eval.py`
      or the `score` verb changed since the first pair, the earlier numbers are not comparable — discard
      them and re-run the pair. File only if the winner's **worst**
      observed score still strictly beats the incumbent's **best** observed score. If it does not, dimension
      1 is clean — record both scores and file nothing.

      *Why, measured on this skill's own set:* scoring the identical shipped description twice gave
      **18/20 then 20/20** — three of twenty queries moved and both "failures" flipped to pass. At
      `runs_per_query: 3` and threshold 0.5 the only rates are 0, ⅓, ⅔, 1, so a sample that moves a query
      already sitting at ⅓ or ⅔ flips its verdict; pooling both runs, two queries sat at exactly p≈0.5.
      Taking the best of `trigger_max_candidates` candidates then makes it *likely* that one scores perfect
      under a null of zero real improvement — a winner's-curse selector. A run of this skill filed such a
      finding and it was rejected on replication (`improvements/038-…`). Two further noise sources live in
      `trigger_eval.py` and are worth knowing when a rate looks wrong: a per-query **timeout** silently
      counts as *not triggered*, and a first tool call that is not Skill/Read counts as *not triggered*.

      If the replicated bar is cleared, the measured delta **is** the evidence: invoke `sk-self-improve` PROPOSE with `kind: description`, the **winning
      description text**, and the observation citing `baseline X/N → best Y/N` and the exact queries it
      fixed. Add the id to `filed_ids` **and** `trigger_eval.winning_desc_id`; it then goes through
      steps 6–7 (adversarial verify — a refuter checks the rewrite doesn't over-claim or soften
      anything — then auto-apply, since a description is below the safety floor and git-reversible). If
      **nothing beat baseline**, dimension 1 is **clean**: append a `no_file` note ("description already
      optimal on measured set — X/N") and file nothing. Either way write the full `trigger_eval` block
      and `logline` the scores.

   Dimension 1 is now settled by measurement; the rounds below (steps 3–8) cover the **other five**
   rubric dimensions. (A round may still raise a *non-triggering* description issue — e.g. an over-cap
   length pairing with `sk-skill-description-trimmer` — but it never re-litigates triggering,
   which the benchmark already measured.)
3. **Audit in rounds — loop until the skill converges.** Audit each skill as a *sequence* of rounds,
   round index `R` from 0, continuing until it converges (step 5). **Round 0 is the full discovery
   panel:** read `bash "$AUD" config tiers` and spawn **one `Agent` per tier** (concurrently, up to
   `panel_wave` per wave), each `subagent_type: general-purpose` at the tier's `model` (resolve
   high/mid/low to the CLI's family, see AGENTS.md), handed the evidence manifest + the paths to read,
   the rubric ([assets/critique-criteria.md](assets/critique-criteria.md)), and the instruction to
   return **structured candidate findings only** — each with its concrete evidence anchor, a proposed
   change, and a guessed `kind`/`risk`. A subagent cannot spawn further subagents and files nothing;
   it just surfaces candidates. **Each later round `R≥1` is a probing round:** pick its tier with
   `bash "$AUD" tier-for <R>` (varied across tiers) and a **fresh focus angle** — point the probing
   `Agent`(s) at a *different* rubric dimension than prior rounds, or tell them to re-examine the
   densest evidence harder — so each round explores ground the earlier ones didn't. Log every round
   (tier, focus, candidate count).
4. **Gate at the strong tier — YOU, in the top-level session.** Each round, merge its candidates and
   **dedup hard**: drop any that duplicate a finding already filed/applied/parked/dropped *this run*
   or living in the skill's existing `improvements/`. (This dedup is what makes the loop converge —
   without it the same finding would re-file forever.) For every genuinely-**new** survivor run the
   **evidence gate** and **attribution gate** yourself (criteria doc) at `verify_tier` strength; a
   candidate that fails either → append to `no_file` with its reason, never file it. A new candidate
   that passes → invoke **`sk-self-improve` PROPOSE** (via `Skill`) with the target, the
   distilled observation **with its evidence**, the precise proposal, and an honest `kind`/`risk`;
   record the id in `filed_ids`. In **autonomous** mode, immediately verify + (auto-apply or park)
   each newly filed finding per steps 6–7 **before the next round**, so the next round's dedup already
   sees what landed. Log what filed, applied, parked, and dropped.
5. **Convergence — loop until nothing new can be improved.** This is the exit condition (there is no
   fixed round count). Track a **dry streak**: a round is *dry* when it files nothing new (every
   candidate was a dup or failed the gate); the first new grounded finding **resets** the streak to
   0. Keep running rounds until **either** the dry streak reaches `dry_rounds_to_converge` consecutive
   dry rounds → the skill has **converged** (genuinely nothing left to improve — the normal, expected
   exit), **or** total rounds reach `max_rounds_per_skill` (when non-zero) → stop on the **backstop**
   and record `hit-round-cap` in the target's `issues` (it did *not* converge — stay honest; the cap
   only fires in a pathological non-drying loop). **The gates never relax to end or extend the loop:**
   more rounds only widen the angle and vary the tier; a finding with no evidence stays dropped no
   matter how many rounds have run, and the loop **never invents a finding to avoid going dry**.
   Convergence is the well running dry, not patience running out.

   **Honor the live control gate between rounds.** `control.stage` is live-editable *while the loop
   runs* — the ledger calls it "the loop gate" precisely so a user can halt a run in flight. Because a
   single skill's loop can run many rounds, re-read `control.stage` at the **top of each round** (and
   refresh `lease.heartbeat_at` so the ledger shows the run is alive), not just at the iteration
   boundary in RESUME step 1: `stop` → persist the rounds completed so far to the target, leave it
   `in_progress`, and go straight to **Finalize** this turn (don't start another round); `pause` →
   persist progress, report, and stop the turn without the promise. Otherwise continue. This keeps a
   halt responsive within a long per-skill loop instead of forcing the user to wait out up to
   `max_rounds_per_skill` rounds before the next boundary check sees their stop.
6. **Adversarial self-verification (autonomous mode).** Run this (and step 7) for **each new finding a
   round files in step 4, before the next round.** Read the run's **`mode`** from the ledger
   (`autonomous` | `classic`) — it was pinned at START and is deliberately **not** re-read from
   `audit-config.yaml` mid-run, so an in-flight edit to the auditor's own config (which the safety floor
   deliberately does not protect) cannot escalate a classic run into auto-applying, and a missing or blank
   value fails closed. If it is **not** `autonomous`, SKIP steps 6–7 — every filed finding stays `proposed` and waits for a human
   (classic funnel); jump to step 8. If it **is** `true`, this is the machine substitute for human
   review: for each finding in `filed_ids`, spawn `verify_votes` (config) **independent** verifier
   `Agent`s at `verify_tier` (`general-purpose`), each prompted to **REFUTE** it — "try to prove this
   finding is wrong, or its proposed change incorrect/harmful; default to refuted=true if uncertain."

   **Every subagent brief this skill authors — verifiers here, the discovery panel in step 3, the
   benchmark in step 2b — is READ-ONLY.** Brief them to verify from evidence: source, bundled
   scripts, committed artifacts, and non-mutating commands (`grep`, `git show`, `--help`,
   `--dry-run`). **Never instruct a subagent to execute an outward-facing or state-mutating command
   to prove a claim** — sending a message, posting/commenting, creating or transitioning an issue,
   writing a database, deploying, or any verb that cannot distinguish a probe from real traffic. A
   claim that looks like it needs such a probe is verified from the source that implements it
   instead; if it genuinely cannot be, the finding is parked for a human. *Why:* a real run's
   verification brief told a refuter to execute `agent send telegram` to prove a fix, and the live
   relay irreversibly delivered two probe messages to the user's own chat — the claim was fully
   provable from source. Autonomous mode never asks permission, so the only place this can be
   stopped is here, in the brief.

   Each verifier returns `{refuted: bool, reason}` **and** a safety-floor judgment
   `{floor_hit: bool, why}`: does the change soften/remove/make-optional a **target skill's** safety,
   irreversible, permission, or destructive-guard rule (DB writes — AGENTS.md Rule 4 — never-prod,
   hard stops, irreversible-action confirmations), **or** is its loss not cleanly git-reversible?
   (Scope note: the floor guards genuine safety guards in the skill being improved — a change is
   **not** floor-hitting merely because it edits the auditor's own machinery, this rubric, or the
   verification step; those auto-apply like any other verified finding.) A finding is **VERIFIED**
   only on a strict **majority of non-refuted** votes. Record the tally; add verified ids to
   `verified_ids`; log it.
7. **Safety floor, then auto-apply (autonomous mode).** For each finding:
   - **Floor hit** — if **any** verifier set `floor_hit` (conservative: one flag is enough), or the
     change otherwise touches the floor → **PARK it**: leave the artifact `proposed`, add to
     `parked_ids` (reason `safety-floor`), log it. A human decides these. Never auto-apply.
   - **Failed verification** — majority refuted → **PARK** (`parked_ids`, reason `unverified`).
   - **Verified AND below the floor** → **AUTO-APPLY**: set the artifact `approved_by: auto-verified`
     (record the vote tally + floor clearance in `applied_notes`), then invoke **`sk-self-improve`
     APPLY** (via `Skill`) for it. APPLY re-checks the safety floor as a hard stop and routes the
     edit through `skill-creator`. On APPLY refusal/verify-mismatch → leave `proposed` and add to
     `parked_ids` with reason **`apply-failed`** — name the reason, because `audit_report.py` prints
     a reasonless park as the literal `unspecified` in the report's *Why parked* column, which is
     exactly the column a human reads to tell an apply failure from a safety-floor park.
   - **Then check the apply against the target itself — the applier's self-report is a claim
     (AGENTS.md practice 5).** An apply writes files into the target's `improvements/` and edits its
     `SKILL.md`, but **nothing in the write chain re-records the target's bundle baseline** — not
     this skill, not `sk-self-improve` APPLY, not `skill-creator` — so the target this run then
     commits is left `bundle-stale` and `sidekicks skill export` refuses a stale tree. That is not
     hypothetical: audit runs have left three skills committed-stale, and a later run had to file the
     breakage as somebody else's pre-existing test failure. So after each successful APPLY:
     ```sh
     node bin/sidekicks skill manifest <target> --apply    # re-record the bundle baseline (derived block)
     node bin/sidekicks skill doctor   <target>            # then compare against the step-2 baseline
     ```
     Step 2's evidence gather captures the target's pre-run doctor error/notice counts as
     `doctor_before`; record the post-apply counts as `doctor_after`. **Order matters:** re-record
     FIRST, then run doctor — once the manifest is refreshed `bundle-stale` can no longer be the
     regression signal, so what you are looking for is everything *else* doctor newly reports. A
     regression against `doctor_before` is an apply **failure**, not a success: leave the edit on the
     branch (it is git-reversible and the diff is the review) but move the id out of `applied_ids`
     into `parked_ids` with reason **`apply-broke-target`**, so the human sees it in the report. Only
     a non-regressing apply counts → `applied_ids`. This whole step runs with **no human and no
     prompts**.
8. **Set the outcome.** Once the loop has converged (or hit the backstop), set the target outcome.
   Autonomous: `applied` (≥1 applied, none parked), `parked` (all filed findings parked —
   floor/unverified, awaiting a human), `mixed` (some of each), or `clean` (nothing filed across the
   whole loop). Classic: `filed` or `clean`. Also record **how it ended**: `rounds_run`, the final
   `dry_streak`, and `converged: true|false` (false ⇒ stopped on `max_rounds_per_skill` — also leave
   the `hit-round-cap` issue from step 5). Stamp `finished_at`, `status: done`, write the `rounds` /
   `verified_ids` / `applied_ids` / `parked_ids` / `trigger_eval` summaries, and append a closing
   `logline`. (`trigger_eval` was already filled by step 2b — confirm it is recorded, not overwritten.)

**Autonomous vs classic — the one safety invariant.** With `autonomous: true` this skill verifies
and applies its own findings **below the safety floor**, no human in the loop and no permission
prompts — but it **parks** (never applies) anything floor-hitting or unverified, and the floor is
enforced **again** at `sk-self-improve` APPLY (defense in depth). With `autonomous: false` it
only files `proposed` artifacts; humans approve and apply. The floor is not a knob — it holds in both
modes.

## Reporting the result

The ledger is *state*, not a *result*: a flat mutable YAML with nested ids, no narrative, and a
hand-written `summary:` rollup. Handing that to the human who must decide whether the branch merges —
or to the next run that wants to trend registry health — buries the answer. So the run **renders** its
result from the ledger:

```sh
bash "$AUD" report <slug>                          # writes audit-report.md + audit-record.json
bash "$AUD" report <slug> --branch "$branch"        # name the branch explicitly (else read from notes)
bash "$AUD" report <slug> --md-only --quiet         # prose only
```

- **Derived, never authored.** Writing the ledger accurately is the loop's *only* logging obligation.
  Never hand-write or hand-patch either file — if a number looks wrong, **the ledger is wrong.**
- **Idempotent.** Safe mid-sweep (it labels the run unfinished and counts what is still pending) and at
  Finalize; regenerating overwrites in place.
- **It cross-checks the run against itself.** The `summary:` rollup is hand-maintained and can drift
  from `targets:`; `report` recomputes every count, leads with the recomputed numbers, and prints the
  disagreement as `summary_mismatch` instead of hiding it.
- **It never launders a half-run.** A `pending`/`in_progress` target reports "not audited", never
  `clean`; a `failed` target counts as audited *and* failed; `converged: false` is called out.
- Leads with the **parked findings** — the only part of an autonomous run that needs a human.

Needs the repo-root `.venv` (PyYAML) — resolved on POSIX **and** Windows, failing loudly (exit 3)
rather than silently skipping the report. Behavior is pinned by
`tests/skills/skill-auditor-report.test.mjs`.

## START — build the ledger and arm the loop

**Input:** a **group name** to audit (preferred), or an explicit narrower skill list. Run from the
**repo root** in the **top-level session** (ralph Pattern 2 — never from a subagent), at the **high**
model tier.

1. **Pick the scope — name the group.** Audits run **by group**: the user names which group to sweep.
   - If the user already named a group (e.g. "audit the `jira` group") or handed an explicit skill
     list, use that.
   - **`single` (the rotating cursor)** — when the chosen group is `single`, this is a one-skill
     rotating run: `bash "$AUD" targets single` resolves to the **single** cursor skill, so the
     scaffold below builds a one-target ledger and ralph needs only `1 + 2` iterations. Note in the
     ledger `notes` that this is a `single`-rotation run (so Finalize knows to advance the cursor),
     and tell the user which skill is up this run (`bash "$AUD" single-status`).
   - Otherwise, list the defined groups with `bash "$AUD" groups` and **ask the user which one to
     audit** — do not guess a cluster. Only fall back to the full ungrouped scope (`bash "$AUD"
     targets` — the union of every group) if the user explicitly asks for "all skills" / "the whole
     registry"; if no groups are defined at all, that union resolves to every active skill.

   Then **resolve the target list, create a feature branch in the current checkout, and scaffold the ledger** (`<group>` is the chosen group name, or
   omit it for the full scope):
   ```sh
   slug=<kebab-run-slug>                              # e.g. audit-jira-2026-06-22
   list="$(bash "$AUD" targets <group> | paste -sd, -)"   # group members; omit <group> for full scope
   #   or your explicit comma-list
   
   # Isolate the run's auto-applied edits on a feature branch IN THE CURRENT CHECKOUT — NO worktree.
   # ralph is armed in THIS session, so its Stop-hook state file lives at the session-launch cwd
   # (the repo root); a worktree would split work from persistence and lose the repo-root .venv.
   # For CONCURRENT group audits, see PARALLEL below (references/parallel-and-spawn.md).
   branch="chore/audit-${slug}"
   git switch -c "$branch"            # create + switch; the audit and its commits ride this branch
   
   # Scaffold the ledger at this run's resolved base (v2 --bare: the slug IS the work item; falls
   # back to the frozen pre-v2 path when the CLI verb is unavailable — see auditor.sh run-base):
   RUNBASE="$(bash "$AUD" run-base "$slug")"
   export SIDEKICKS_RUN_BASE="$RUNBASE"   # PIN the base for the WHOLE run — see Scope. Without this
                                          # a mid-run active-project flip splits the run across two trees.
   export SIDEKICKS_RUN_SLUG="$slug"      # …and which run it is for, so a verb handed a DIFFERENT slug
                                          # is not silently answered from this run's folder.
   mkdir -p "$RUNBASE"
   bash "$AUD" scaffold "$slug" "$list" > "$RUNBASE/ledger.yaml"
   rid="$(awk '/run_id:/{print $2; exit}' "$RUNBASE/ledger.yaml")"   # this run's lease identity

   # LOCK the checkout, then CLAIM every target — the multi-session coordination gate (PARALLEL below).
   bash "$AUD" checkout-lock "$slug" "$rid"       # exit 4 → ANOTHER audit is live in this checkout:
                                                  # delete $RUNBASE, tell the user, point at PARALLEL — never run two here.
   bash "$AUD" claim-batch "$slug" "$rid" "$list" # exit 4 → some targets are claimed by another live run
   ```
   On a `claim-batch` conflict it prints every conflicted skill and its owning run. **Never silently
   shrink the scope:** tell the user which targets are held and by whom, and let them choose — drop
   the conflicted members (re-scaffold with the reduced list, then re-run `claim-batch`) or abort
   this run (then `checkout-unlock` and delete `$RUNBASE`).
   Record the chosen `group` (or "full scope" / the explicit list) in the ledger `notes` so the run's scope
   is reproducible, and record the branch as its **own canonical note line** — exactly
   `branch: <name>` — because `report` recovers it from `notes` for the "nothing landed on `main`"
   paragraph and free prose around it (parentheses, `branch=`) either mangles the name or loses the
   paragraph on the mid-run refresh, which passes no `--branch`. Also record
   `coordination: <path>` (from `bash "$AUD" coord`) so a later session can find the claims registry.
   **Per-run mode override:** the scaffold stamps `mode:` from the shipped `autonomous` knob. To run this
   one **classic**, edit the scaffolded ledger's `mode: classic` before arming ralph — step 6 reads the
   ledger, so that is what actually pins it.
2. **Read the rubric and config** once now — [assets/critique-criteria.md](assets/critique-criteria.md)
   and `bash "$AUD" config` (the panel `tiers`, `verify_tier`, the convergence controls
   `dry_rounds_to_converge` / `max_rounds_per_skill`, and `autonomous` / `verify_votes`). Record the
   effective knobs in the ledger `notes` (or honor any per-run override the user passed) so the run is
   reproducible.
3. **Arm ralph** on this session — at the repo root. Ralph anchors its Stop-hook state to the
   session's launch cwd (`<cwd>/.claude/ralph-loop.local.md`), so it MUST run in the same checkout the
   audit runs in; that is why START uses a feature branch here, not a worktree. max-iterations =
   `targets + 2`, with a **self-contained** prompt (the hook re-feeds the prompt text, not the skill
   body — so it must name the skill and the ledger):
   ```
   FIRST `export SIDEKICKS_RUN_BASE=<RUNBASE>` and `export SIDEKICKS_RUN_SLUG=<slug>` (substitute the
   resolved path and the slug) — the base MUST be pinned in every iteration, because each ralph
   iteration is a fresh shell and re-resolving it can land somewhere else if the active project has
   changed; the slug companion is what stops a pinned shell answering for a different run. Then invoke the sk-skill-auditor skill in
   RESUME mode against the ledger at
   <RUNBASE>/ledger.yaml (the run's v2 --bare folder resolved via `auditor.sh run-base <slug>` —
   substitute the actual resolved path here; it falls back to
   artifacts/runs/skill-auditor/<slug>/ledger.yaml on a pre-v2 checkout). FIRST run
   `bash <auditor.sh> assert <slug> <run-id>` (substitute this run's literal run_id here — the
   ledger's copy can be rewritten by a takeover, the prompt's copy is what detects it): exit 4 or 1
   means this run was superseded or cancelled — stop immediately, write nothing, and do NOT emit
   the completion promise. Audit exactly ONE pending skill this iteration at the
   strongest model tier. FIRST run the triggering benchmark (step 2b) for the skill: resolve or
   generate+commit its evals/trigger-eval.json, score the current description with scripts/trigger_eval.py
   from a neutral trigger-root (num-workers 1), then hand-author candidate descriptions and re-score
   until the score cannot improve (manual loop — NEVER run_loop.py or an ANTHROPIC_API_KEY), filing the
   winning description (if any beat baseline) via sk-self-improve as kind:description. IF the skill has no committed evals/trigger-eval.json AND the ledger's mode is
   classic, 2b CANNOT complete unattended — filing the set leaves it `proposed` and score exits 4 — so
   file the generated set via sk-self-improve, append `2b-blocked-on-eval-set (classic)` to the target's
   issues, skip 2b and continue. In autonomous mode 2b ALWAYS runs; never skip it there. THEN audit
   the other five rubric dimensions in rounds until it CONVERGES: round 0 is the multi-tier discovery
   panel, each later round is a probing round on a varied tier + fresh focus angle; gate every
   candidate against the evidence + attribution gates AND dedup against everything already
   filed/applied/parked/dropped this run or in the skill's improvements/, and file only
   evidence-backed, skill-attributable, genuinely-NEW findings via sk-self-improve PROPOSE.
   Keep running rounds until dry_rounds_to_converge consecutive rounds file nothing new (converged) or
   max_rounds_per_skill is hit (backstop). The evidence bar never relaxes to keep the loop going or to
   end it. If autonomous mode is on, then for each newly filed finding adversarially self-verify it
   (verify_votes refuters) and auto-apply the verified ones that are BELOW the safety floor via
   sk-self-improve APPLY before the next round, parking floor-hitting or unverified findings as
   proposals for a human. Never ask the user for permission and never pause for input — run fully
   unattended. Log each round with auditor.sh logline, and after writing the skill's outcome back run
   `bash <auditor.sh> report <slug> --quiet` to refresh the run's audit-report.md + audit-record.json
   from the ledger. When the ledger has no pending targets (and control.stage is not stop), finalize the
   run summary, set status: done, render the final report the same way (with --branch <branch>), and
   output <promise>SKILL-AUDIT DONE</promise>. Never output the promise while any target is still pending.
   ```
   Invoke `ralph-loop:ralph-loop` with that prompt, `--completion-promise "SKILL-AUDIT DONE"`,
   `--max-iterations <targets+2>`. One skill per iteration keeps context small — true Ralph.
4. Tell the user the run is armed, where the ledger is, and that they can `/cancel-ralph` or set
   `control.stage: stop` to halt it.

### Running several group audits at once — PARALLEL and SPAWN

Two modes exist for auditing more than one group concurrently, and both live in
[references/parallel-and-spawn.md](references/parallel-and-spawn.md) — operator-only procedure the
single-session path never reads:

- **PARALLEL** — one worktree and one session per group, launched by you. Needs no extra skills.
- **SPAWN** — the driven form: one command and one confirmation fan the fleet out to N headless
  worktree sessions. **Extra precondition:** it reuses `sk-loop-fleet` (`scripts/fleet.py`,
  `scripts/loop.sh`) and `sk-cli-executor`, which must be installed as siblings; manual PARALLEL
  needs neither.

**The invariant that stays here, because START enforces it:** never run two group audits from one
session or one checkout — ralph keys its Stop-hook state to `<session-launch-cwd>/.claude/ralph-loop.local.md`,
so two runs in one checkout share one state file and one working tree for the auto-applied edits and
clobber each other. START's `checkout-lock` **exits 4** rather than let that happen; the fix is a
worktree, per the reference. Merging any branch a fleet pushes stays the operator's call.
## RESUME — audit the next pending skill (one per iteration)

This is what each ralph iteration runs. Keep it tight:

1. **Assert the lease, then read the ledger.** `bash "$AUD" assert <slug> <run-id>` runs FIRST,
   before any read or write: exit 4 = this run was superseded by a takeover, exit 1 = the ledger is
   gone (cancelled) — either way **stop immediately: no writes, no promise** (the successor session
   owns the run now). Exit 0 → read the ledger. `control.stage: stop` → finalize and emit the
   promise. `pause` → report and stop the turn without the promise.
2. Pick the target to work — the **first target that is `pending` *or* `in_progress`**, top to bottom.
   Resuming an `in_progress` target is what makes the resumability promise real: a run killed
   *mid-skill* leaves that target `in_progress` (neither `pending` nor `done`), and a strict
   "first pending" rule would skip straight past it and finalize the run with that skill half-audited.
   **Guard against a poison skill:** if the chosen target is already `in_progress` *and* its
   `attempts >= max_attempts`, it has died mid-audit too many times — mark it `failed` (record why in
   `issues`), then take the next target instead of retrying forever. No `pending`/`in_progress` target
   left → **finalize** (below) and emit the promise.
3. Prepare the chosen target. If it *was* `pending` (a fresh start): mark it `in_progress`, stamp
   `started_at`, bump `attempts`. If it *was already* `in_progress` (you're resuming an interrupted
   audit): keep `started_at`, bump `attempts`, and **read its existing `rounds` / `filed_ids` /
   `applied_ids` / `dry_streak`** so the loop continues from where it stopped rather than re-auditing
   from round 0 (re-filing already-applied findings). Either way, refresh `lease.heartbeat_at` and
   re-claim the target — `bash "$AUD" claim <slug> <run-id> <skill>` — which refreshes the claim's
   heartbeat so a long audit round never ages past `lease_ttl_seconds` into takeover territory.
4. Audit it per **How a single skill is audited** above.
5. Write the outcome back (`filed_ids` / `verified_ids` / `applied_ids` / `parked_ids` / `no_file` /
   `rounds` / `trigger_eval` / `outcome` / `status: done`) and append a one-line `notes` entry; the per-skill log under
   `$RUNBASE/log/<skill>.log` (resolve `$RUNBASE` via `auditor.sh run-base <slug>` if not already
   held) is written as you go (step "Log every round"). On an
   unexpected failure, append to the target's `issues` and the run's `runtime_errors`; if
   `attempts >= max_attempts`, mark it `failed`. Then **refresh the result snapshot** —
   `bash "$AUD" report <slug> --quiet` — so a run that is killed before Finalize still leaves a readable
   result for everything audited so far (it costs one deterministic script call and overwrites in place).
6. If more targets remain, **stop the turn** (do not emit the promise) — ralph re-feeds for the next.
   Resumability is free: the ledger is the only state, so a killed run resumes at the next `pending`.

## Finalize — the dry-sweep exit-status

When no target is `pending`, roll up `summary` (`audited` / `applied` / `parked` / `clean` /
`failed`, and `filed` — the count of findings filed, rolled up in **both** modes; in autonomous mode it
is the superset of applied + parked, and the scaffold and `report` both track it unconditionally, so a
classic-only rollup would make the run disagree with its own report), set `status: done`, stamp
`finished_at`, clear the lease, **release this run's coordination holds** —
`bash "$AUD" release <slug> <run-id>` (all claims) and `bash "$AUD" checkout-unlock <slug> <run-id>` —
also on a `control.stage: stop` finalize (a crashed run's claims simply age out via `lease_ttl_seconds`;
no janitor exists or is needed),
and write a closing `notes` line. The **dry sweep is the exit condition**: the run ends once every
in-scope skill has been audited.

**Then render the result — `bash "$AUD" report <slug> --branch "$branch"`.** This writes
`audit-report.md` + `audit-record.json` beside the ledger ([Reporting the result](#reporting-the-result))
and is the last **rollup** logging act, done immediately after the rollup so the final numbers reach disk
even if the commit-and-push block below fails partway. It is deliberately NOT the run's last write: step 0
of that block re-records each touched target and may append to a target's `issues`, which the report
renders — so if step 0 records anything new, re-run `report` before handing the human the file, or say in
the chat summary what the report does not yet carry. (Keep the render here rather than moving it after
step 0: a crash inside step 0's per-target `manifest`/`doctor` loop would otherwise leave no final report
at all, which is a worse failure than one late `issues` line.)
If its `summary_mismatch` is non-empty, the rollup you just wrote disagrees with the targets — **fix the
ledger and re-run `report`**; never leave the discrepancy standing or paper over it in the chat report.

**`single`-rotation runs — advance the cursor.** If this was a `single`-rotation run (recorded in
`notes` at START), the one target is now terminal (`done` or `failed`). Advance the cursor exactly
once: `bash "$AUD" single-advance` — this rolls past the audited skill to the next pooled skill
(wrapping at the end) and persists it, so the next `audit single` run picks up there. Advance
regardless of the target's outcome (even `failed`), so rotation never sticks on a poison skill.
Report both the skill just audited and the next cursor (`bash "$AUD" single-status`). **A run with nothing applied or parked is a first-class outcome** —
"N skills audited, nothing the evidence justified improving," exactly what a healthy registry looks
like. 

**Commit and push the feature branch — never merge to `main` yourself:**
After the audit is complete and any changes have been auto-applied on the feature branch:
0. **Re-record every touched target's manifest LAST, then gate on `skill doctor` — before anything is
   staged.** Step 7 already re-records after each auto-apply, and that stays: it is what lets the
   per-finding regression check work. But it is keyed to *an apply*, so it never fires for the writes
   that have no apply behind them — a `proposed` artifact a later round filed, a parked or unverified
   finding, a target RESUME marked `failed`, or the artifact-closing writes and `INDEX.md` line that
   land after the last apply. Every one of those writes into the target's `improvements/`, and
   `skill export` refuses a tree with an **unrecorded extra file** exactly as it refuses a moved hash
   (`lib/skill-lifecycle/export.mjs`), so staging without this leaves the skill unexportable and
   breaks the repo-wide export tests for everyone:
   ```sh
   for t in <every target this run touched>; do
     node bin/sidekicks skill manifest "$t" --apply
     node bin/sidekicks skill doctor   "$t"     # must be clean before staging
   done
   ```
   This is **per target**, not one skill. If doctor still reports anything for a target, fix it or
   record it in that target's `issues` — never stage a stale tree.
1. Stage the improvements (`git add .agents/skills/`) and commit them to the feature branch.
2. **Push the branch to the remote** (`git push -u origin <branch>`) and **stop there.** Do **NOT**
   merge to `main`, do **NOT** delete the branch. The whole point of isolating the run on its own
   branch is that **the human decides whether it merges** — the autonomous run's authority ends at a
   pushed branch. The git diff on that branch is what the user reviews before merging.
3. If the commit or push fails, leave the branch in place and report it — never force; the work stays
   preserved on the branch for the human (a local-only branch is still a valid handoff if the push
   itself is what failed).

Report to the user (the run itself never asked them anything): counts; **what was auto-applied and
pushed to branch `<branch>`** (grouped by skill — these are committed on the branch, **not yet on
`main`**, awaiting the user's review-and-merge); and — the part that genuinely needs them — the
**`parked_ids` awaiting a human** (safety-floor or unverified), since the autonomous floor
deliberately refused to touch those. State plainly that **nothing landed on `main`** and the user
must merge the branch themselves when satisfied. Give the branch name, the **`audit-report.md` path**
(the readable result — lead with it; it holds the per-skill detail the chat summary compresses), and the
ledger path. Then emit `<promise>SKILL-AUDIT DONE</promise>`.

**Run reporting (when skill-auditor is on the opt-in list).** Run reporting is triggered *externally* by
`AGENTS.md`, not wired into this skill — but when `sk-skill-auditor` is on the run-reporting
opt-in list, the contract is: with the **final report above** (the dry sweep completing,
`status: done`) send a completion report via **`sk-slack-connector`** (`report --skill
sk-skill-auditor`) to the skill's configured notification channel (resolved
`notifications.skills.<name>` → `notifications.channel` → `default_channel` in the scope config's
`slack:` block), summarizing the audited / applied / parked / failed counts **taken from the rendered
`audit-record.json`** (so the Slack body, the report, and the ledger can't tell three different
stories), the feature branch pushed (awaiting the user's review-and-merge), and the `parked_ids`
awaiting a human — body-only, never attaching the ledger or the report (cite their paths); and on a
**critical event mid-sweep** — the run aborting outright, or a commit/
push failure leaving the branch local-only — send a critical-alert immediately (`--status fail`). These
reports go only to the configured channel and are pre-authorized by that policy, so they send
automatically (never ask permission); an arbitrary channel or recipient is not covered and still needs
an explicit OK.

## What this skill does NOT do

- **It never crosses the safety floor.** In autonomous mode it self-verifies and auto-applies
  findings **below** the floor — but a change that softens a **target skill's**
  safety/irreversible/permission rule (DB writes — Rule 4 — never-prod, hard stops), or whose loss is
  not cleanly git-reversible, is **always parked** for a human, however confident the verifiers were.
  The floor is scoped to genuine safety guards in the skills being improved; it does **not** park a
  change just because it edits the auditor's own machinery (this rubric, the verification step) —
  those auto-apply like any other verified finding, with the git diff as the review. The floor holds
  in both modes; APPLY re-enforces it. (In classic mode it applies nothing at all — every finding
  waits for a human.)
- **It never auto-applies an unverified finding.** Auto-apply requires a majority of independent
  refuters to confirm; anything that fails verification is parked, not shipped.
- **It never has a subagent execute an outward-facing or state-mutating command.** Every brief it
  authors (verifiers, the discovery panel, the benchmark) verifies read-only, from source and
  non-mutating commands — a claim that seems to need a live send/write/deploy probe is verified from
  the code that implements it, or parked for a human (step 6).
- **It never files an opinion.** No evidence → dropped; input-caused → dropped (the recurring-unguarded
  exception aside). The `no_file` list records what it considered and rejected, so a healthy clean
  sweep is distinguishable from a sweep that never ran.
- **It never hand-edits a skill.** Every write to a target goes through `sk-self-improve`
  (which goes through `skill-creator`). This skill reads skills and writes only its own ledger.
- **It doesn't create skills.** New skills are `skill-creator`.
- **It doesn't audit non-skills.** Code, plans, queues, and documents have their own loops.

## Composition

| Direction | Skill | Role |
|---|---|---|
| files into | `sk-self-improve` | TRIAGE re-gates each finding; PROPOSE records the artifact — this skill's only write path to a target |
| drives (autonomous mode) | `sk-self-improve` APPLY | auto-applies verified, below-floor findings via the `auto-verified` lane; APPLY re-enforces the safety floor as a hard stop |
| feeds (downstream) | `sk-auto-improve` | an optional side branch: hand it a list and it can auto-apply a `proposed` artifact that is `risk: low` + `kind: assets` + a new file under `assets/` — it **never approves**, and it cannot take this rubric's usual `description`/`instructions`/`scripts` filings |
| executes the write (transitively) | `skill-creator` | the only hands that touch a target skill's files — at APPLY time, whether human- or auto-verified-approved |
| pairs with | `sk-skill-description-trimmer` | the cap discipline a `kind: description` over-length finding points at |
| persistence | `ralph-loop` | re-feeds the RESUME prompt each iteration so a long sweep survives crashes and resumes from the ledger |
| reports through | `sk-slack-connector` | when opt-in, sends the completion body built from the rendered `audit-record.json` (paths only, never the files) |
