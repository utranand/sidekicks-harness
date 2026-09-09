---
name: sk-skill-description-trimmer
description: Keep Sidekicks skill frontmatter descriptions within the host limits by moving excess trigger/routing detail into each SKILL.md body — Claude's per-description 1024-char cap and Codex's ~8000-char aggregate budget across all skills. Use when the user asks to review, trim, shorten, or enforce maximum description length across skills.
allowed-tools:
  - Read
  - Edit
  - Write
  - Bash(node *)
  - Bash(find *)
  - Bash(git *)
user-invocable: true
version: 1.1.0
sidekicks:
  runtime-class: framework
  logical-id: skill:sk-skill-description-trimmer
  provides:
    - skill-description-trimming
---

# Sidekicks Skill Description Trimmer

Keep skill frontmatter descriptions short enough for the host while preserving the operational
detail that made the skill trigger well. The description is only the always-loaded routing summary;
long examples, detailed mode selection, options, exclusions, and caveats belong in the body.

## Host limits — why we trim, and why front-loading matters

Both hosts route on the `description` ONLY. The `## Trigger guidance` body is **not** read at routing
time — it loads only after the skill already triggered, so it is documentation, not a triggering
signal. That is why trimming must keep the real trigger words *in the description*.

The same `.agents/skills/<name>/SKILL.md` feeds every host through folder symlinks
(`.claude/skills`, `.agent/skills`, **`.agents/skills`** — the plural path is the one Codex actually
scans; `.codex/skills` is NOT read by Codex). One description serves all hosts, so it must satisfy the
*tighter* of two different limits:

| Host | Limit | Behavior when over |
|---|---|---|
| Claude | **1024 chars per description** (hard) | Truncates the tail of that one description |
| Codex | **~8000 chars aggregate** across ALL installed skills' name+description (2% of context, or 8000 when unknown) | Auto-shortens the longest descriptions first |

Both keep the **front** of the text. So the rule for every trimmed description: **front-load the core
"what it does" + the strongest trigger words in the first sentence**, so the skill still matches after
either truncation. A per-host description swap is unnecessary — neither host needs different *content*,
both need the same short, front-loaded description.

Per-description 1024 is a hard cap (always fix). The 8000 aggregate is a shared budget: with many
skills installed, even individually-legal descriptions can collectively overflow it, so shorter is
better across the board. Report the aggregate; only trim mid-length descriptions toward it when the
user asks for broader cleanup, since over-trimming a legal description can cost real trigger signal.

## Trigger guidance

Use this skill when the user asks to:

- Review all skills for long frontmatter descriptions.
- Enforce a maximum description length — Claude's `1024` per-description cap and/or Codex's `8000`
  aggregate budget.
- Move extra frontmatter text into `SKILL.md` body sections.
- Shorten skill descriptions without losing trigger/routing knowledge.
- Clean up skill metadata after a host truncates or shortens oversized descriptions, or when Codex
  isn't seeing/matching skills.

Do not use this skill for general skill design, eval generation, or trigger optimization from scratch;
use `skill-creator` for that broader workflow.

## Defaults

- Per-description hard cap: `1024` characters (Claude). Aggregate budget: `8000` characters across
  all skills' name+description (Codex). Both overridable if the user names a different limit.
- Target directory: `.agents/skills/`.
- Edit only `SKILL.md` files whose parsed description exceeds the per-description `1024` cap.
- Leave descriptions at or under `1024` unchanged unless the user explicitly asks to trim toward the
  `8000` aggregate; in that case, trim the longest legal descriptions first and stop as soon as the
  aggregate fits, to avoid stripping trigger signal from descriptions that did not need it.
- Every rewritten description must **front-load** the core "what" + strongest trigger words in the
  first sentence, so it survives Claude's tail-truncation and Codex's longest-first shortening.
- Preserve each skill's `name`, frontmatter fields, body content, and intent.
- Report `SKILL.md` files with no YAML frontmatter, but do not invent frontmatter unless the user asks.

## Workflow

### 1. Resolve repo root and active write area

Find the repo root by walking up for `.sidekicks/`, not with `git rev-parse`, because service `src/`
folders can be nested git repositories.

If the user gives an explicit skills directory, use it. Otherwise use `.agents/skills/` from the
repo root. If active scope was temporarily changed to inspect or edit root skills, restore the
original active scope before finishing.

### 2. Inventory descriptions empirically

Scan every `SKILL.md` under the target skills directory. Parse YAML frontmatter rather than relying on
line length. Handle all of these description styles:

- Single-line `description: text`
- Folded blocks: `description: >` and `description: >-`
- Literal blocks: `description: |` and `description: |-`

Measure the normalized description text in characters. Produce two outputs: (a) the list of
descriptions over the `1024` per-description cap (the must-fix set), and (b) the **aggregate** sum of
`len(name) + len(description)` across every skill, compared against the `8000` Codex budget. Report
the aggregate even when no single description is over `1024`, since the budget is a shared ceiling.

### 3. Rewrite each over-limit skill

For each over-limit skill:

1. Replace the frontmatter description with a concise routing summary under `1024`, with the core
   "what" + strongest trigger words **front-loaded in the first sentence**.
2. Keep enough in the description to identify what the skill does and the broad trigger — remember the
   body is never read at routing time, so a trigger word that only lives in the body no longer fires.
3. Move removed examples, detailed trigger phrases, modes, options, exclusions, and routing caveats
   into a `## Trigger guidance` section near the top of the body (documentation, not a trigger signal).
4. If a `## Trigger guidance` section already exists, merge into it instead of duplicating headings.
5. Preserve all other frontmatter fields exactly unless they must be reflowed by the edit.
6. Preserve exact technical terms, command names, skill names, paths, and safety constraints.

Prefer body text like:

```markdown
## Trigger guidance

Route requests here for "...", "...", or "...".

Use `option=<value>` when ...

Do not use this skill for ...; use `other-skill` instead.
```

### 4. Verify

After editing:

1. Re-run the frontmatter parser and confirm no parsed description exceeds the `1024` per-description
   cap.
2. Recompute the `8000` aggregate and report the new total and remaining headroom (or overflow).
3. List any `SKILL.md` files missing frontmatter separately.
4. Run `git diff --check -- <skills-dir>` to catch whitespace issues.
5. Review `git diff --stat` and the affected file list to ensure only intended skills changed.
6. Confirm Codex exposure exists: a `.agents/skills` (plural) symlink to `.agents/skills/`. If it
   is missing, Codex sees no skills regardless of description length — report it. (`.codex/skills` is
   not scanned by Codex.)
7. If the skill index needs freshness, run `node bin/sidekicks index rebuild` or report that the new
   skill will be picked up by the next index rebuild.

## Reporting format

Finish with:

- Changed skill files.
- Verification result: no parsed descriptions over the `1024` per-description cap, or list remaining
  failures.
- Aggregate name+description total vs the `8000` Codex budget (before → after), with headroom or
  overflow.
- Codex exposure status: whether `.agents/skills` → `.agents/skills/` exists.
- Any files skipped because they had no frontmatter.
- Any unrelated dirty worktree entries left untouched.
