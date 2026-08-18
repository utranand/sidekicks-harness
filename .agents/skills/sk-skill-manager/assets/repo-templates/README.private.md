# {{REPO_NAME}}

Private agent skills for [Sidekicks](https://github.com/utranand/{{CORE_REPO}}) and any file-based agent
CLI that reads `SKILL.md` — Claude Code, Codex CLI, Gemini CLI, Antigravity.

This is the private counterpart of
[{{PEER_REPO}}](https://github.com/utranand/{{PEER_REPO}}). Same layout, same tooling, same
install path; the difference is audience — skills here describe client- or project-specific systems
and internal processes, and the repo is not open source. Access to this repo is required to install
anything from it.

Every skill is a self-contained directory: a `SKILL.md` carrying YAML frontmatter for discovery and
Markdown instructions for execution, plus optional `scripts/`, `references/`, and `assets/`. Nothing
here needs a build step or a package manager — it is plain Markdown and YAML, so it is
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

The family set matches the public repo's on purpose — a skill's family comes from
`audit-groups.yaml` in the source repo, so it is the same either side of the public/private split. A
family folder with no published skills stays in place; an empty family is not an error.

<!-- GENERATED from catalog.yaml — do not hand-edit below this line. -->

| Family | What it covers | Skills |
|---|---|---|

<!-- END GENERATED -->

## Prerequisites

<!-- GENERATED prerequisites — do not hand-edit below this line. -->

<!-- END GENERATED prerequisites -->

## Installing

Cloning requires read access to this repo — use SSH or a token with `repo` scope. Never paste a
token into a committed file, a script, or a run artifact.

### Into a Sidekicks repo (recommended)

`sidekicks skill import` reconciles against each skill's recorded baseline rather than overwriting
blind — it reports `new` / `ff` / `up-to-date` / `conflict` / `local-only` and stops on the last
two:

```sh
git clone git@github.com:utranand/{{REPO_NAME}}.git /tmp/{{REPO_NAME}}
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

A skill here may declare a sibling that lives in the **public** repo. `--with-deps` cannot cross
repositories: clone both and import the missing sibling from whichever repo holds it.

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

A skill folder is self-contained, but four things are the destination repo's decision and are never
applied silently. Each is declared in the skill's `skill.manifest.yaml` with a `degraded:` sentence
saying whether its absence is expected or a break:

- `requires.framework_hooks` — the hook body ships to `meta/<name>/framework/` as reference; its
  wiring in `.claude/settings.json`, `.codex/config.toml`, `.gemini/settings.json`, and
  `.agent/settings.json` is a hand change, all four in the same commit.
- `requires.framework_files` — repo-root files the skill reads or runs; bodies ship as reference.
- `requires.host_paths` and `requires.binaries` — the host machine's, by definition.
- A matching block in the destination's scope `config.yaml` when the skill needs real values. The
  skill's own non-secret `config.defaults.yaml` does travel inside the folder.

Audit-group membership does not travel either — place an imported skill into a group or it lands
unaudited.

## What belongs here, and what does not

Private is not secret: repo permissions protect access, not committed content.

- **Belongs here:** skills whose instructions describe a private system — a client environment, an
  internal process, project-specific business rules.
- **Belongs in the public repo:** anything generally useful with no private detail in its text.
- **Belongs nowhere in git:** credentials, tokens, authenticated endpoints, customer data. Real
  config values live in the destination's scope `config.yaml`, which is never exported.

## Versioning

Releases are tagged semantically (`v1.0.0`) so a team can pin its agent configuration to a stable
snapshot of the whole collection. Per-skill versions live in each skill's `VERSION.json` and are
mirrored into `catalog.yaml` and `meta/<name>/origin.yaml`.

## Contributing

Skills are authored upstream in the [Sidekicks framework
core](https://github.com/utranand/{{CORE_REPO}}) under `.agents/skills/` and published here
by `sidekicks skill export`. Edit them upstream, not here — a hand edit in this repo breaks the
byte-identity guarantee that `skill verify` and `skill doctor` depend on, and the next export
overwrites it.

## License

Proprietary — all rights reserved. See [LICENSE](LICENSE).
