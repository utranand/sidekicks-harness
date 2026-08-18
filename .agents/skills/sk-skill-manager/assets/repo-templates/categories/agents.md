# agents

Persistent delegate agents: creation, standby loops, mailbox bridge, journals, scheduling.

Agents are named, chartered runners that hold a standing role rather than a single task. The skills here create them, keep them online, route work to them over the file mailbox, and record what they did.

## Skills

<!-- GENERATED from catalog.yaml — do not hand-edit below this line. -->

_No skills published in this family yet._

| Skill | Version | Description |
|---|---|---|

<!-- END GENERATED -->

## Prerequisites

<!-- GENERATED prerequisites — do not hand-edit below this line. -->

<!-- END GENERATED prerequisites -->

## Notes

Skill folders live at `../../.agents/skills/<name>/`, never inside this directory — see
[LAYOUT.md](../../LAYOUT.md). This README is a browse view regenerated from `catalog.yaml`; it is
safe to delete and rebuild.

Family membership is defined by `audit-groups.yaml` in the source repo
(`.agents/skills/sk-skill-auditor/assets/`). Adding a skill here without adding it to a
group there leaves it unaudited at every destination.
