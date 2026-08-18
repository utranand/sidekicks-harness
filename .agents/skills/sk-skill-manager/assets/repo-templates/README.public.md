# {{REPO_NAME}}

Installable agent skills for [Sidekicks](https://github.com/utranand/sidekicks) and any
file-based agent CLI that reads `SKILL.md` — Claude Code, Codex CLI, Gemini CLI, Antigravity.

Every skill is a self-contained directory: a `SKILL.md` carrying YAML frontmatter for discovery
and Markdown instructions for execution, plus optional `scripts/`, `references/`, and `assets/`.
Nothing here needs a build step or a package manager — it is plain Markdown and YAML, so it is
version-controllable, auditable, and diffable.

> **Generated, not hand-maintained.** Skill folders, `catalog.yaml` and the per-family tables
> below are all written by `sidekicks skill export` from the source repo — never by hand. A
> freshly scaffolded repo carries none of them until the first export; `catalog.yaml` then records
> the source commit each copy came from. Counts live in the generated regions rather than in this
> prose, so nothing here can go quietly stale.

## Layout

```
{{REPO_NAME}}/
  LAYOUT.md                             the layout contract — read this first
  catalog.yaml                          generated index, one row per skill
  .agents/skills/<name>/                CANONICAL skill folders — the ONE skill tree, whether or not
                                        a skill is parked in the repo that published it
  .sidekicks/.gitkeep                   the root marker every sidekicks verb walks up to find
  meta/<name>/                          provenance, dependency pins, reference copies
  categories/<family>/README.md         browse view by family — links only, no skill content
```

Skills live under `.agents/skills/` and **not** under `categories/`. That mirrors the shape the
Sidekicks engines already scan, so `skill verify`, `skill doctor`, `skill heal`, and the auditor run
against this repo verbatim with its root passed as `repoRoot`. `categories/` is a browse surface
regenerated from `catalog.yaml`. Full rationale: [LAYOUT.md](LAYOUT.md).

## Categories

<!-- GENERATED from catalog.yaml — do not hand-edit below this line. -->

| Family | What it covers | Skills |
|---|---|---|

<!-- END GENERATED -->

## Prerequisites

<!-- GENERATED prerequisites — do not hand-edit below this line. -->

<!-- END GENERATED prerequisites -->

## Installing

### Into a Sidekicks repo (recommended)

`sidekicks skill import` reconciles against each skill's recorded baseline rather than overwriting
blind — it reports `new` / `ff` / `up-to-date` / `conflict` / `local-only` and stops on the last
two:

```sh
git clone https://github.com/utranand/{{REPO_NAME}}.git /tmp/{{REPO_NAME}}
sidekicks skill import <name> --from /tmp/{{REPO_NAME}}            # one skill
sidekicks skill import <name> --from /tmp/{{REPO_NAME}} --with-deps # plus its declared siblings
```

Then, in order:

```sh
sidekicks framework sync
sidekicks skill manifest <name> --apply
sidekicks skill doctor <name>
sidekicks skill heal <name> --apply
```

An import that leaves `framework doctor` red is a failed import, not a finished one.

### Into any other agent CLI

Copy the skill folder into whichever directory your agent scans:

```sh
cp -R .agents/skills/<name> /path/to/project/.claude/skills/<name>
```

Equivalent target directories: `.claude/skills/`, `.agent/skills/`, `.agents/skills/`,
`.gemini/skills/`, `.github/skills/`. Symlinking one canonical copy into several of them keeps a
single source of truth.

### Verifying an install

`skill verify` needs no git, no registry, and no network — it reads a manifest and hashes files:

```sh
sidekicks skill verify <name>
```

A tree it calls clean is a tree that arrived intact.

## What does not travel automatically

A skill folder is self-contained, but four things are the destination repo's decision and are
never applied silently. Each is declared in the skill's `skill.manifest.yaml` with a `degraded:`
sentence saying whether its absence is expected or a break:

- `requires.framework_hooks` — the hook body ships to `meta/<name>/framework/` as reference; its
  wiring in `.claude/settings.json`, `.codex/config.toml`, `.gemini/settings.json`, and
  `.agent/settings.json` is a hand change, all four in the same commit.
- `requires.framework_files` — repo-root files the skill reads or runs; bodies ship as reference.
- `requires.host_paths` and `requires.binaries` — the host machine's, by definition.
- A matching block in the destination's scope `config.yaml` when the skill needs real values. The
  skill's own non-secret `config.defaults.yaml` does travel inside the folder.

Audit-group membership does not travel either — place an imported skill into a group or it lands
unaudited.

## Versioning

Releases are tagged semantically (`v1.0.0`) so a team can pin its agent configuration to a stable
snapshot of the whole collection. Per-skill versions live in each skill's `VERSION.json` and are
mirrored into `catalog.yaml` and `meta/<name>/origin.yaml`.

## Contributing

Skills are authored in the [sidekicks](https://github.com/utranand/sidekicks) repo under
`.agents/skills/` and published here by `sidekicks skill export`. Edit them there, not here — a
hand edit in this repo breaks the byte-identity guarantee that `skill verify` and `skill doctor`
depend on, and the next export overwrites it.

## License

MIT — see [LICENSE](LICENSE).
