# `{{REPO_NAME}}` — layout 1 (hybrid)

The hand-authored contract for this repository. Read it before adding, exporting, importing, or
relocating anything here.

Canonical source of the contract's first half: `.agents/skills/sk-skill-manager/references/skill-repo-layout.md`
in the [sidekicks](https://github.com/utranand/sidekicks) repo. This file restates it at the
destination and adds the `categories/` browse layer, which exists only here.

## 1. The tree

```
{{REPO_NAME}}/
  LAYOUT.md                             this contract, hand-authored
  README.md                             public catalog + install guide (generated)
  LICENSE
  catalog.yaml                          generated index — one row per skill; the file ADVISE reads
  .agents/skills/<name>/             CANONICAL skill folder, byte-identical to its source — the ONE
                                        skill tree; a parked source skill publishes here too
  .sidekicks/.gitkeep                   the root marker every sidekicks verb walks up to find
  meta/<name>/
    origin.yaml                         schema, layout, skill, version, tree, source_repo, source_commit, source_branch, exported_at, bundle_verified, file_count, outside_edges
    requirements.lock.txt               `==` pins resolved from the source .venv at export time
    framework/<repo-relative-path>      REFERENCE copies of framework_files and hook bodies
  categories/<family>/README.md         browse view — links into .agents/skills, holds no skill
```

## 2. Why skills live under `.agents/skills/`, not under `categories/`

The destination mirrors the shape `discoverSkills()` already scans in the source repo. That is not
cosmetic: every existing engine — `readSkillManifest`, `scanSkill`, `auditSkills`,
`sidekicks skill verify` — works against this repo verbatim by passing its root as `repoRoot`, with
no second code path to keep in step. `sidekicks skill export` writes exactly this shape
(`lib/skill-lifecycle/export.mjs`), and `sidekicks skill import` reads it.

A category-nested skill folder would break all of the above. So `categories/` carries **no skill
content** — only a README per family that links into `.agents/skills/`. It is a browse surface,
regenerable from `catalog.yaml`, and safe to delete and rebuild.

## 3. Why the sidecars sit outside the skill folder

Provenance cannot go into `skill.manifest.yaml`: `ROW_KEYS` is a closed key set and an unknown key
is a validation **error**, so a `source_commit:` field would make every manifest fail to validate.

It cannot go inside the skill folder either. `bundle{}` covers every file except the manifest, so an
`origin.yaml` dropped next to `SKILL.md` produces a `bundle-stale` finding on the first
`skill doctor` after import — the exported folder would no longer be byte-identical to its source.

Hence `meta/<name>/`: outside the folder, so the folder stays byte-identical and the baseline stays
true.

`meta/<name>/framework/` is **reference only** — never auto-applied. A repo-root file and a hook are
the destination's business; copying one in blind is how an import breaks a repo it was meant to
extend.

## 4. Families

`categories/` uses the families defined by `audit-groups.yaml` in
`.agents/skills/sk-skill-auditor/assets/` — the same grouping `catalog.yaml` derives its
`group` column from, so the two cannot disagree. `catalog.yaml` carries no `description` field: the
generated per-family README's Description column is sourced from each skill's own `SKILL.md`
frontmatter `description`, not from `catalog.yaml`.

| Family | What it covers |
|---|---|
| `agents` | Persistent delegate agents: creation, standby loops, mailbox bridge, journals, scheduling |
| `architecture` | Architecture authoring, rules documents, API cartography, validation gates |
| `bmad` | The BMAD delivery pipeline: PRD, architecture, epic tech context, stories, dev, code review |
| `core` | CLI substrate, scope, config, knowledge store, communication modes |
| `database` | PostgreSQL connectors, analysis, transfer, import, drift and schema sync |
| `delivery` | Autonomous delivery engines, orchestrators, executors, test gates |
| `git` | Branches, worktrees, shipping, sweeps, release notes |
| `integrations` | Outward connectors: Confluence, Slack, run reporting |
| `jira` | Jira card lifecycle: read/write, readiness gates, subtasks, autopilot, verification |
| `ops` | Cluster ops, security remediation, packaging, UI capture, run and artifact doctors |
| `planning` | Implementation, sequence and task planning, feasibility probes, advisory councils |
| `skill-improvement` | The skill lifecycle itself: improvement funnel, offload, inherit, manager |

Two names in `audit-groups.yaml` are deliberately absent from `categories/`:

- `single` — a reserved rotating audit cursor, not a family.
- `sk-skill-auditor` — ungrouped by design in the source repo. When exported here it carries
  `group: ''` in `catalog.yaml` and is listed in `README.md` under *Ungrouped*.

## 5. What travels with a skill, and what does not

`skill.manifest.yaml` is the closure declaration — nothing here re-derives it.

| Travels inside the folder | Manifest section |
|---|---|
| Every file the baseline pins | `bundle{}` — LF-normalized sha256 per file, exhaustive except the manifest itself |
| Pinned Python packages | The skill's own `requirements.txt`, itself a `bundle{}` entry |
| A rule body | `rules/<id>.md`, skill-relative |
| Non-secret config defaults | `config.defaults.yaml` |

| Must be reconciled at the destination | Manifest section |
|---|---|
| Another skill in the same repo | `requires.sibling_skills` |
| A repo-root file the skill reads or runs | `requires.framework_files` |
| A hook body **and** its wiring in four per-CLI config files | `requires.framework_hooks` |
| Something on the host machine | `requires.host_paths` |
| An external binary | `requires.binaries` |

Each of those five carries a `degraded:` sentence (or an `install_hint` for binaries). Read them out
when reporting an import; do not silently install past them.

## 6. Constraints on every generated YAML file here

Both enforced by the reader in `lib/yaml-subset/yaml.mjs` in the source repo, both learned the hard
way:

- No `&` or `*` anywhere on a line, comments included.
- **No block scalars.** `degraded: >-` parses as the literal string `">-"`, and the folded body
  lines are then read as *structure* — inside a sequence that swallows the following items. Use one
  long single-quoted line per sentence, apostrophes doubled.

## 7. Importing: reconcile before you overwrite

The baseline for a three-way comparison already exists: the local skill's own `bundle{}` is "the
state a human last blessed", and `skill verify` answers "has the local copy drifted from it".

With `L` = local files on disk, `Lb` = local recorded bundle, `Ib` = incoming recorded bundle:

| Condition | Status | What to do |
|---|---|---|
| Local absent | `new` | Copy it in |
| `L == Lb`, `Ib != Lb` | `ff` | Back up, then replace — a clean fast-forward |
| `L == Lb`, `Ib == Lb` | `up-to-date` | Skip |
| `L != Lb`, `Ib != Lb` | `conflict` | **Stop and ask** — both sides moved |
| `L != Lb`, `Ib == Lb` | `local-only` | **Stop** — local edits post-date the export |
| Local has no manifest | `unversioned` | **Stop** — there is no baseline to reason from |

After any import, in this order: `sidekicks framework sync` → `sidekicks skill manifest <name> --apply`
→ `sidekicks skill doctor <name>` → `sidekicks skill heal <name> --apply`. An import that leaves
`framework doctor` red is a failed import, not a finished one.

## 8. Versioning

Semantic version tags on this repo (`v1.0.0`) let a consumer pin to a stable snapshot of the whole
collection. Per-skill versions live in each skill's own `VERSION.json` and are mirrored into
`catalog.yaml` and `meta/<name>/origin.yaml`.
