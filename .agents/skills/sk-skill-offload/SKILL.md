---
name: sk-skill-offload
description: "Safely offload (archive/deactivate) a Sidekicks skill — first verify no OTHER active skill references it, then move it from .agents/skills/<name>/ into .sidekicks/skill-offloaded/<name>/ so skill discovery no longer loads it while its files stay in the repo and git history. Use whenever the user wants to offload, archive, retire, deactivate, mothball, shelve, or 'turn off' a skill, clear out a superseded/redundant skill, or trim the active skill set — even if they just hand over a skill name or path like .agents/skills/<name>. Also restores an offloaded skill back into the active set, and lists what is currently offloaded. Operates on the framework skill registry (root scope); needs no work_dir/docs_dir."
allowed-tools:
  - Bash
  - Read
sidekicks:
  runtime-class: framework
---

# sk-skill-offload

Offload a skill = take it out of the active discovery surface without deleting it. Skills are
discovered **one level deep** (`.claude/skills/*/SKILL.md`, where `.claude/skills` symlinks to
`.agents/skills`). Moving a skill into `.sidekicks/skill-offloaded/<name>/` takes its `SKILL.md`
out of the scanned `.agents/skills` tree entirely, so it stops loading — but every file stays in
the repo and in git history, so it can be restored at any time. Offloading is **reversible
archiving, not deletion.**

This is a framework-registry operation: it always acts on `.agents/skills/` resolved from the
git repo root. It does **not** depend on the active project/service and needs no `work_dir` or
`docs_dir`.

## The one hard rule — never break another skill

Before moving anything, **verify no other active skill references the target by name.** Offloading
a skill that another skill invokes or depends on would silently break that skill. The bundled
script enforces this: it refuses to move a skill while another **active** skill names it, and only
proceeds past a blocker with an explicit `--force` (which you use only after the user confirms).

References fall into two buckets:

- **Blocking** — any *other active skill* (`.agents/skills/<other>/…`) names the target. These
  stop the offload. The target referencing *itself* and any *already-offloaded* skill don't count.
- **Soft (warnings)** — the nickname registry (`skill-nickname/assets/nicknames.yaml`), docs,
  command-sequences, and the opt-in lists in `CLAUDE.md` (self-improvement / run-reporting). These
  are reported so you (or the user) can clean them up, but they do **not** block the move.

## Offload is NOT uninstall — decide which one the user means

The mistake worth catching before anything moves. `.sidekicks/skill-offloaded/` is inside
`SKILL_TREES` **deliberately** (`lib/framework-settings/registry.mjs`), because a retired skill's
rule fragment must stay addressable and its hook may still be wired — `hook.enforce-flow-headful` is
the live case. So a parked skill keeps:

- its ids in `.sidekicks/config/settings/{rules,criteria}.yaml`
- its config block, still discovered by `config sync`
- its hook wiring across all four CLI configs
- its line in `audit-groups.yaml`, and any `CLAUDE.md` lines naming it

If the user wants those gone too, they want **`sidekicks skill remove`** — it backs the folder up
first, drops the audit-group line, prunes the orphaned settings ids, and prints what only a human may
unwire. Ask once when it is ambiguous: *"park it so it can come back, or uninstall it?"*

## Workflow

The engine is a CLI verb. Never re-derive the scan by hand, and never `mv` the folder yourself:

```sh
node bin/sidekicks skill offload <skill-name>                      # CHECK — reports, moves nothing
node bin/sidekicks skill offload <skill-name> --apply              # move it
node bin/sidekicks skill offload <skill-name> --apply --force      # only after the user says so
node bin/sidekicks skill offload <skill-name> --restore --apply    # back into the active set
node bin/sidekicks skill offload --list                            # what is parked, plus strays
```

1. **Check first — always.** The bare form *is* the check: it prints the blocking and soft references
   and moves nothing. Relay both lists verbatim. If there are blockers, the skill should not be
   offloaded as-is — name *which* skills depend on it, read out any `degraded:` sentence the report
   carries, and let the user decide (rework the dependents, or override).
2. **Offload when clean** with `--apply`. It re-runs the scan and refuses if blockers reappeared, and
   refuses if the target does not exist or is already offloaded.
3. **`--force` is user-confirmed, never your initiative** — it leaves dangling references in other
   skills. Only after the user has seen the blocking list and said so.
4. **`--list`** also warns about **STRAY** archives at a non-canonical path (a hand-move, or an older
   convention — the archive has previously lived at `.agents/skills/skill-offloaded/` and
   `.agents/skills-offloaded/`). `--restore` and `--list` are blind to those until they are moved
   into the canonical `.sidekicks/skill-offloaded/`, so consolidate a stray there first.

`scripts/offload_skill.sh` is now a **shim** over the verb, kept so existing command-sequences and
lifted copies keep working. Do not extend it. The scan it used to perform lives in
`lib/skill-lifecycle/references.mjs`, shared with `skill remove` — a `grep -rIlE` engine could not
run on Windows and could not tell a wired invocation from a passing mention.

## Accepting a path instead of a name

The user may hand over a path (`.agents/skills/<name>`, or the host-symlinked
`.claude/skills/<name>`) rather than a bare name. Take the **last path segment** as `<skill-name>`
and pass that to the verb — it resolves the tree itself.

## What to report back

After a successful offload, tell the user: the skill is deactivated (won't load on the next
session), where it now lives (`.sidekicks/skill-offloaded/<name>/`), how to restore it, and
list any **soft references** still pointing at it that they may want to clean up (especially
`CLAUDE.md` opt-in lists). Do not commit the move unless the user asks — leave it staged for them
to review.
