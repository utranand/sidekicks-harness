# Skill auditing — coverage, groups, autonomous mode

> Framework criterion `criterion.skill-auditing`, owned by `sk-skill-auditor`.
> Extracted from `AGENTS.md` (AAP-93). Inspect with
> `sidekicks framework show criterion.skill-auditing`; turn it off with
> `sidekicks framework disable criterion.skill-auditing`.
> **The autonomous-mode SAFETY FLOOR is deliberately NOT part of this file** — it is
> `rule.auditor-autonomous-safety-floor`, a locked rule whose body stays in the always-loaded
> `AGENTS.md` and which no setting can disable.

`sk-skill-auditor` discovers weaknesses and files them through `sk-self-improve`. It is a
find-then-verify split, not a single-tier run: **discovery** fans a panel out across the tiers in
`assets/audit-config.yaml` (high/mid/low — cheaper tiers buy breadth and genuinely surface different
real issues), while the **gate** that decides what actually files runs at the strong `verify_tier`.
A low-tier subagent may suggest; only the strong gate files.

**Coverage** = the named groups in the bundled
`.agents/skills/sk-skill-auditor/assets/audit-groups.yaml`. An `AGENTS.md`
`skill-auditing groups:` block, if one is present, overrides that manifest **wholesale**.

> **Trap:** `scripts/auditor.sh` treats *any* line matching
> `^[[:space:]]*skill-auditing groups[[:space:]]*:` in `AGENTS.md` as such an override —
> indentation does not save you. Never write that phrase at the start of a line unless you
> intend to replace the whole manifest; a stray example would silently empty audit coverage.
> `tests/framework-claude-md.test.mjs` asserts `AGENTS.md` contains no matching line.

**Autonomous mode** (shipped on) self-verifies adversarially and auto-applies the survivors,
bounded by the safety floor named above.

**Skill optimization loop:** the auditor's bundled `scripts/trigger_eval.py` **is** the scorer — a
self-contained, zero-dependency adaptation of `skill-creator`'s `run_eval.py`, inlined so the auditor
depends on no per-machine plugin-cache path and can add the two things the score needs and the original
lacks: a `--project-root` neutral trigger-root, and a one-worker default (the upstream copy defaults to
10, and a rate scored above one worker cannot be trusted). Invoke it through `auditor.sh score`, never
`run_eval.py` — which is not in this repo at all. Run it as a manual loop only — see
`criterion.self-improvement`, owned by `sk-self-improve`.
