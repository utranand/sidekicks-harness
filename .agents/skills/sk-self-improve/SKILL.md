---
name: sk-self-improve
description: >-
  Central skill-improvement funnel for the Sidekicks ecosystem — every improvement to a skill
  parses through here. TRIAGE/ADVISE decides up front whether a lesson is worth filing; PROPOSE
  writes a structured improvement artifact under the target skill; APPLY takes approved artifacts
  and improves the skill by invoking skill-creator for every change — never hand-editing the target.
  Additive low-risk artifacts may auto-apply; anything changing behavior waits for human approval.
  Use when the user or another skill wants to "improve skill X", "file an improvement", "apply
  pending improvements", "harvest lessons from this run into the skill", or when
  sk-get-things-done's standing task fires. Also EXPORTs the proposed backlog to Jira
  ("create subtasks from skill improvements"): scans every skill, picks the artifacts awaiting human
  approval, and creates one Jira subtask per pick under a parent card to implement later. Covers the
  lifecycle: triage, propose, list, approve, apply, reject, export.
user-invocable: true
allowed-tools:
  - Read
  - Grep
  - Glob
  - Write
  - Edit
  - Bash
  - Skill
  - AskUserQuestion
version: 0.7.0
sidekicks:
  runtime-class: framework
  logical-id: skill:sk-self-improve
  depends-on:
    - skill:skill-creator
    - skill:sk-jira-connector
  provides:
    - skill-improvement
---

## Trigger guidance

Route here **only** for improvements to a **funnel-protected (opt-in) skill** — the set listed
under `self-improvement enabled for` in the repo's `CLAUDE.md`. For those skills this is the single
funnel: runs and other skills don't edit them, file ad-hoc TODOs, or scatter lessons into reports;
they parse their improvement intent into this skill, which first **triages** whether the lesson is
worth filing at all, records the worthy ones as an artifact, and (when approved) applies them.
Triggers: "improve skill X", "file an improvement against Y", "is this worth filing / should we
improve X from this run?" (→ TRIAGE/ADVISE), "harvest what we learned from this run into the skill",
"apply the pending improvements", "what improvements are waiting on Z?", "export the proposed
backlog / create Jira subtasks from skill improvements on <card>" (→ EXPORT) — and programmatic
callers, above all **`sk-get-things-done`'s standing improvement task**, which invokes this
skill at every queue close.

**Every skill NOT on that list is free-edit** — create or update it directly with `skill-creator`
(no PROPOSE artifact, no approval gate); do not route those changes here. If asked to "improve skill
X" and X is not protected, decline the funnel and point at `skill-creator` directly.

**One exception — the discoverer.** `sk-skill-auditor` may file PROPOSE artifacts against
**any** skill, protected or not. This doesn't contradict the free-edit rule: a proposal is inert
(it changes nothing until a human acts), so recording an evidenced suggestion against a non-protected
skill is always safe — a human is still free to edit that skill directly via `skill-creator` and
ignore the artifact. So when PROPOSE is invoked by the auditor, accept any target skill; the opt-in
gate only governs *automated applies*, which PROPOSE never performs.

Not for *creating* a new skill from scratch (invoke `skill-creator` directly, per the repo's skill
authoring guide) and not for improving non-skill things (code, plans, queues — those have their own
loops).

---

## Where things live — root scope, inside the target skill

Skills are root-project surface: resolve the repo root by walking up for `.sidekicks/` (never
`git rev-parse` — service `src/` dirs are their own repos), and anchor everything to it:

```bash
ROOT="$PWD"; while [ "$ROOT" != "/" ] && [ ! -d "$ROOT/.sidekicks" ]; do ROOT="$(dirname "$ROOT")"; done
TARGET="$ROOT/.agents/skills/<target-skill>"        # must exist — never invent a skill here
```

Improvement artifacts live **under the target skill**, so they travel with it (the same
portability boundary as `scripts/` and `assets/`):

```
.agents/skills/<target>/improvements/
├── INDEX.md                      # one line per artifact: id — status — hook
├── TRIAGE.md                     # append-only log of no-file triage verdicts: date — source — reason
└── <NNN>-<slug>.yaml             # the improvement artifacts, sequential NNN
```

This folder is the **only** place this skill writes directly. Every other byte of the target —
SKILL.md, description, `scripts/`, `assets/`, evals — changes exclusively through `skill-creator`
(see APPLY).

---

## The improvement artifact

One file per improvement, from [assets/improvement.template.yaml](assets/improvement.template.yaml):

```yaml
id: <NNN>-<slug>                  # e.g. 003-tighten-verify-brief
target_skill: <name>
created: <YYYY-MM-DDTHH:mm:ss+07:00>     # Asia/Bangkok
source: <where this came from — queue artifact path, mission path, user feedback, eval report>
kind: instructions | description | scripts | assets | evals
observation: >-
  What actually happened, with evidence — the failing pattern, the repeated manual fix, the
  trigger miss, the harvested template-worthy shape. Concrete, citable.
proposal: >-
  The precise change to make: which file/section, what it should say or contain instead, or the
  template/asset to add. Written so skill-creator can act on it without re-deriving the intent.
expected_effect: <why the skill is better after — one or two lines>
risk: low | medium | high         # low = additive, no behavior change; high = changes core flow
status: proposed                  # proposed → approved → applied | rejected
jira_subtask: null                # optional — the Jira subtask key once EXPORTed (presence = already on the backlog)
jira_exported_at: null            # optional — Asia/Bangkok, stamped at EXPORT
approved_by: null                 # the human; "auto" (additive lane); or "auto-verified" (autonomous auditor, below the safety floor)
applied_at: null                  # Asia/Bangkok, stamped the moment the apply lands
applied_notes: null               # filled at apply: what skill-creator did, eval/description checks
changes:                          # filled at apply — the change-tracking record
  files: []                       #   paths touched, relative to the target skill dir
  version_from: null              #   target's frontmatter version before…
  version_to: null                #   …and after (bumped as part of the apply)
  commit: null                    #   git SHA once committed
```

The artifact is the contract between the moment a lesson is learned and the moment it lands —
inert until applied, auditable forever after. `observation` carries the evidence; `proposal`
carries the change; the status chain carries accountability; `changes` carries the diff trail.
Together the `improvements/` folder **is the target skill's changelog**: every applied artifact
answers *what changed, when, why, and at which version* — read it newest-first to track how the
skill evolved.

---

## TRIAGE / ADVISE — decide whether to improve at all (runs first)

Before any artifact is written, triage the incoming lesson. This is the explicit *"does this even
warrant an improvement?"* gate — the judgment that used to live silently inside PROPOSE's first
step, now its own deliberate act so the standing automated harvest can't slide straight into
filing junk. A caller (above all the standing automated harvest) hands a lesson + its source;
TRIAGE returns one verdict: **file** or **no-file**.

Two gates decide it, in order:

1. **Evidence gate.** Read the cited source. Is there concrete, citable evidence — a pattern that
   repeated, a step re-derived, a rule that misfired? No evidence → **`no-file`** (an improvement
   that can't cite its observation is an opinion, not a lesson).
2. **Attribution gate.** Is the failure attributable to the **skill's own behavior**, or to the
   **input/request condition**?
   - **Skill's own behavior** failed — a rule misfired, a brief needed correcting, a
     `runtime_errors` entry shows the skill's own flow broke or was terminated → **`file`**.
   - **Input-caused** — a bad/missing path the user supplied, the wrong scope handed in, an unset
     environment, a malformed input file, a user-controlled prerequisite → **`no-file`**: record
     it, but it is not a skill defect. **The one nuance:** an input-caused failure that *recurs
     because the skill never guarded against it* IS skill-attributable — `file` *that* ("the skill
     should validate/catch this input up front"), not the raw input error.

**The two verdicts:**

- **`file`** → hand straight to PROPOSE (below) with the distilled observation. The evidence and
  attribution are already cleared, so PROPOSE just records them.
- **`no-file`** → stop; do not write an artifact. Report the verdict + reason in chat. So a harvest
  that *ran and decided no* stays distinguishable from one that *never ran*, append one dated line
  to `improvements/TRIAGE.md` when invoked from a standing/automated caller (e.g.
  `sk-get-things-done`'s queue-close task): `<YYYY-MM-DDTHH:mm:ss+07:00> — <source> — no-file: <reason>`.
  Ad-hoc chat triage just reports; no log line needed.

**Direction check (after the two gates).** A lesson that clears both gates is *true*; weigh whether
it is *worth filing* against the **skill-improvement mission** in CLAUDE.md (reliable,
evidence-grounded, lean, safe; converge, don't churn). A real lesson that pulls toward the mission is
a confident `file`; one that's real but off-mission is a weak `file` — sharpen it toward the mission
or note it as low priority. This never turns a `file` into a `no-file` on its own (evidence +
attribution decide that); it ranks and aims what survives.

TRIAGE writes nothing but that optional `TRIAGE.md` line, so it is as safe as PROPOSE to run as a
standing step. It is also the **ADVISE** entry point: "should we improve skill X from this run?" /
"is this worth filing?" is a TRIAGE call that returns its verdict and stops — no artifact, no
change, just the judgment.

---

## PROPOSE — record the lesson (safe, always allowed)

**Input:** a `file` verdict from TRIAGE — a target skill + the lesson, in whatever shape it arrived
(a queue/mission artifact harvested, a user's complaint or wish, an eval report, "the run kept
doing X by hand").

1. **Ground it.** TRIAGE has already cleared the evidence + attribution gates; here, distill that
   evidence into the artifact's `observation` — what repeated, what failed, what was re-derived
   that should have been remembered. Cite the source concretely. (If PROPOSE is invoked directly
   without a prior TRIAGE, run those gates here first — no evidence or input-caused → stop and
   record a `no-file` verdict instead of filing.)
2. **Check for an existing artifact** covering the same lesson (read `improvements/INDEX.md`) —
   sharpen that one instead of filing a duplicate.
3. **Write the artifact** (`status: proposed`) + its INDEX line. Set `risk` honestly: a new
   library template is `low`; a reworded brief is `medium`; a changed loop rule or safety text is
   `high`.
4. **Say what was filed** — id, target, one-line proposal, risk — and whether it qualifies for the
   auto-apply lane (below) or waits for approval.

PROPOSE never touches the target's operative files, so any caller may invoke it at any time —
that's what makes it safe as a standing, automated step.

---

## REVIEW — list, approve, reject

"What's pending on skill X?" → read `improvements/` and present the artifacts compactly (id, kind,
risk, one-line proposal, age). Approval is normally a **human** act: the user says "approve 003" (or
"reject 003 — wrong diagnosis", recorded with the reason). Flip `status` and `approved_by`
accordingly. Never nag: pending artifacts surface when asked, at APPLY time, and in callers'
close-out reports — they don't expire and they don't auto-escalate.

**The one machine-approval path — `sk-skill-auditor` in autonomous mode.** When the
autonomous auditor (see its `audit_self`/`autonomous` config) hands an artifact it has already put
through its adversarial self-verification (a majority of independent refuters confirmed it) AND
cleared against the safety floor, it sets `approved_by: auto-verified` and records the verdicts in
`applied_notes`. That is a legitimate approval for APPLY — the verification stands in for the human.
It is the **only** non-human approval beyond the additive auto-apply lane, and it is still bounded
by the safety-floor hard stop below.

---

## EXPORT — file the proposed backlog as Jira subtasks (pick later)

The funnel accumulates `proposed` artifacts across **every** skill — far more than anyone reviews
in one sitting. EXPORT turns that scattered backlog into a single, pickable surface on a Jira card:
scan all skills for `status: proposed`, let the human pick, and create **one Jira subtask per pick
under a parent card** so the work can be triaged and implemented later from the board. It records
the subtask key back into each artifact, so a re-run never double-creates.

EXPORT is a **mirror, not a decision** — it neither approves nor applies anything. The artifact stays
`proposed`; the subtask is just a visible handle. Implementing one *later* = REVIEW (approve) → APPLY
on the artifact the subtask points back at.

**Creating Jira issues is an outward-facing write** — not pre-authorized like footprint comments on a
bound card. So EXPORT always runs human-in-the-loop: the human picks which artifacts and confirms the
batch + parent card **before** any subtask is created. Never auto-export.

The flow (resolve `$ROOT` as above; the script uses the repo-root `.venv` by absolute path):

1. **Capture the target once (ask, don't guess).** Ask for the **parent card key** (e.g.
   `SDHPT-190`) and the **connector `env` alias** (default the project's single configured alias).
   The parent's project is where the subtasks land.
2. **Scan.** `"$ROOT/.venv/bin/python" "$ROOT/.agents/skills/sk-self-improve/scripts/export_to_jira.py" scan`
   lists every `status: proposed` artifact across all skills (already-exported ones hidden unless
   `--include-exported`; add `--json` to drive a picker). It surfaces malformed artifacts via a
   loose parse and warns to fix them — they are never silently dropped.
3. **Pick + confirm.** Present the list; let the human choose refs (or "all"). Show the count and the
   parent card, and get an explicit go-ahead — this is the outward-write gate.
4. **Export.** `export_to_jira.py export --parent <CARD> --env <alias> --refs <ref1,ref2,…>`
   creates one subtask per ref via the **`sk-jira-connector` CLI** (no second Jira client),
   then writes `jira_subtask` + `jira_exported_at` back into each artifact and tags its INDEX line
   `[jira:KEY]`. Each subtask carries the observation, proposal, risk, and the artifact path so the
   implementer can find it. Per-item best-effort: a connector failure on one ref is reported and the
   rest continue. Use `--dry-run` to preview without touching Jira; `--type` if the project names
   subtasks something other than `Sub-task`; `--force` to re-create an already-exported one.
5. **Report** created / skipped / failed. The subtasks are now the pick-later surface.

---

## APPLY — improve the skill, exclusively through skill-creator

**Input:** a target skill and which artifacts to apply ("apply 003", "apply everything approved").

**The mandate: every action on the skill is done by invoking `skill-creator`** (via the `Skill`
tool). This skill never edits the target's SKILL.md, scripts, assets, or description itself — not
even for a one-word change. Why: skill-creator is the discipline — it knows skill anatomy,
progressive disclosure, description caps and triggering, eval harnesses; improvements applied
through it inherit that rigor, while hand-edits silently rot it. The flow:

1. **Gate.** Only `approved` artifacts apply — whether approved by a human or, for the autonomous
   auditor, `approved_by: auto-verified` (above) — plus `proposed` ones eligible for the additive
   auto-apply lane. Anything else: stop and run REVIEW. **Safety-floor hard stop:** regardless of
   how it was approved, an artifact whose change softens/removes/makes-optional a **target skill's**
   safety, irreversible, permission, or destructive-guard instruction (DB writes — CLAUDE.md Rule 4 —
   never-prod, hard stops, irreversible-action confirmations), or whose loss is not cleanly
   git-reversible, is **never auto-applied**. If such an artifact arrives `auto-verified`, refuse the
   auto-apply, drop it back to `proposed` with a note, and leave it for a human. Auto-verification can
   confirm a finding is real; it can never license crossing the floor. The floor guards **genuine
   safety guards in the skills being improved** — it no longer parks a change merely because it edits
   the auditor's own autonomous machinery; those auto-apply like any other verified finding, with the
   git diff as the review (every auto-apply is git-reversible).
2. **Brief skill-creator.** Invoke `skill-creator` with: the target skill path, the artifact(s) —
   observation, proposal, expected effect verbatim — and the instruction to apply them as an
   improvement pass to the existing skill (not a rewrite). For `kind: description`, have it run
   its description-optimization flow; for `kind: evals`, its eval harness.
3. **Verify the result.** After skill-creator returns: the frontmatter description still fits the
   host cap (≤1024 chars — measure it), the SKILL.md parses, bundled asset paths still resolve,
   and the change matches the proposal. A mismatch → revert via skill-creator, mark the artifact
   back to `approved` with a note.
4. **Close the artifact — the change-tracking write.** The moment the apply lands, update the
   artifact so the skill's evolution stays trackable from the artifact alone:
   - `status: applied`, `applied_at` (Asia/Bangkok), `approved_by` confirmed;
   - `applied_notes` — what skill-creator did and which checks ran;
   - `changes.files` — every path skill-creator touched, relative to the target skill dir;
   - `changes.version_from` / `version_to` — have skill-creator **bump the target's frontmatter
     `version`** as part of the apply (patch for `low`, minor for `medium`/`high`), and record
     both sides here;
   - `changes.commit` — fill with the git SHA when the change is committed (leave `null` until
     then; backfill on the commit that includes it);
   - the INDEX line gains the applied date: `id — applied <date> — hook`.

   This closing write is **not optional** — an applied improvement with an unupdated artifact is
   untracked change, exactly what the funnel exists to prevent. Offer — don't force — a follow-up
   eval run for `medium`/`high` risk changes.

**The auto-apply lane (additive only).** An artifact that is `risk: low` AND `kind: assets` AND
purely additive (a new file under the target's `assets/` — e.g. a harvested queue template, a new
reference) may apply immediately in the same invocation, still via skill-creator, with
`approved_by: auto`. Everything that *changes existing behavior* — instructions, description,
scripts, any edit to an existing file — waits for a human **unless it arrives on the
autonomous-verified lane below**. When in doubt, it waits.

**The autonomous-verified lane (`sk-skill-auditor` only).** When `autonomous` mode drives a
finding here `approved_by: auto-verified`, APPLY may apply it — including a behavior change
(instructions/description/scripts) — **provided it passes the safety-floor hard stop in step 1**.
The auditor's adversarial self-verification (majority of independent refuters) is what earns this;
the safety floor is what bounds it. Record the verifier verdicts in `applied_notes`. This lane is
exclusive to the autonomous auditor — no other caller may self-approve a behavior change, and even
this one cannot cross the floor. With autonomous mode off, this lane does not exist and every
behavior change waits for a human as before.

---

## How other skills parse into this funnel

When a run learns something about a **funnel-protected (opt-in) skill**, it does **not** act on it
directly — it invokes this skill (for any skill off the list, edit via `skill-creator` instead):

- **`sk-get-things-done`** — its standing improvement task (`origin: system`) invokes
  **TRIAGE** targeting `sk-get-things-done` itself, handing the queue artifact as `source`.
  A `no-file` verdict (input-caused, or no new pattern) is logged to `TRIAGE.md` and that's the
  end of it; a `file` verdict flows into PROPOSE: harvested templates file as
  `kind: assets / risk: low` (auto-apply lane → land in `assets/library/`), behavior lessons as
  `kind: instructions` proposals that wait. Its close-out report lists the triage verdict, what was
  filed, and what's pending.
- **`sk-get-plan-done`** missions, eval runs, review sessions — same pattern: cite the
  source, file the artifact, let the lifecycle carry it.
- **`sk-skill-auditor`** — the discoverer. It sweeps the skill registry, critiques each skill
  from evidence, runs **TRIAGE** on every finding, and **PROPOSE**s the survivors. It targets any
  skill (see the discoverer exception above). In its **classic** mode every artifact it files waits
  for a human, like any other PROPOSE. In its **autonomous** mode it adversarially self-verifies each
  finding and drives APPLY itself via the autonomous-verified lane — but only below the safety floor;
  anything floor-hitting (or that fails verification) it parks as a `proposed` artifact for a human.
- **A human in chat** — "this skill keeps getting X wrong" is a PROPOSE; "fix it now" is a
  PROPOSE + approve + APPLY in one conversation, gates intact.

The funnel is the point: one place where every lesson about a skill is recorded, reviewed,
applied, and auditable — instead of N skills each inventing their own way to mutate themselves.

---

## What this skill does NOT do

- **It doesn't hand-edit skills.** Every change to a target's operative files goes through
  `skill-creator` — no exceptions, including trivial ones.
- **It doesn't apply unapproved behavior changes.** The additive auto-apply lane is assets-only; a
  behavior change waits for a human "approve" — with one bounded exception: the autonomous auditor's
  `auto-verified` lane, which still cannot cross the safety floor (safety/irreversible/permission
  edits always wait for a human, however they were approved).
- **It doesn't create skills.** New skills are `skill-creator` directly; this skill improves what
  exists.
- **It doesn't file opinions.** TRIAGE drops `no-file` lessons (no evidence, or input-caused) up
  front — logging the reason for automated runs — so only skill-attributable, evidenced lessons
  ever become artifacts.
- **It doesn't lose lessons — or leave changes untracked.** Rejected artifacts keep their reason;
  applied ones carry `applied_at` + the full `changes` record (files, version bump, commit); the
  INDEX is the audit trail and the `improvements/` folder is the skill's changelog.
- **It doesn't improve non-skills.** Code, queues, plans, and documents have their own loops.

---

## Composition

| Direction | Skill | Role |
|---|---|---|
| executes ALL skill changes | `skill-creator` | the only hands that touch a target skill's files: applies proposals, optimizes descriptions, runs evals |
| caller (standing) | `sk-get-things-done` | its improvement task PROPOSEs here at every queue close; template harvest rides the auto-apply lane |
| caller (discoverer) | `sk-skill-auditor` | evidence-driven registry sweep: TRIAGEs + PROPOSEs findings against any skill; never approves/applies |
| caller (ad-hoc) | any skill / mission / the user | files lessons as artifacts instead of editing skills or scattering TODOs |
| delegate (EXPORT) | `sk-jira-connector` | the only Jira client — EXPORT shells out to its CLI to create one subtask per proposed artifact under a parent card |
| guards | `sk-skill-description-trimmer` | the description-cap discipline APPLY re-checks after skill-creator runs |
