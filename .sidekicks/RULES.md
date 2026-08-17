# Sidekicks Boundary Contract

This file is the **canonical source** of the Sidekicks boundary contract. `AGENTS.md` and all agent-facing skills **MUST mirror** the boundary rules verbatim from this file.

## The Six Boundary Rules

**Rule 1 — CLI Write Surface**
The CLI mediates all structural writes. The CLI-managed write surface is `projects/<name>/`, `.sidekicks/`
and `.agents/skills/`. Only `sidekicks` CLI verbs may create, modify, or delete files under these paths.
`.agents/skills/` is named explicitly because the skills tree lives OUTSIDE `.sidekicks/`: it is the canonical
skills location (Rule 3), and the rest of `.agents/` — the per-CLI plugin ports — is ordinary agent territory.

**Rule 2 — Agent Free-Write Surface**
The agent's free-write surface is bounded by the active scope:
- Root project (`sidekicks`) active → repo root, excluding `.sidekicks/`, `.agents/skills/` and `projects/`
- User project active → `projects/<active>/` only

**Rule 3 — Skills Canonical Location**
Skills are canonical at `.agents/skills/` — the CLI-neutral standard location, a real committed directory and
never a link. Host-level exposure directories, one per supported agent CLI that does not read that path directly
(`.claude/skills/`, `.agent/skills/`, `.gemini/skills/`) — are folder-level links pointing at `.agents/skills/`.
They are git-ignored and self-healed by the CLI on every invocation (junction on Windows,
symlink on POSIX; `lib/sk-cli/skill-links.mjs`), and are outside the framework's write scope.
The parked tree `.sidekicks/skill-offloaded/` deliberately does NOT move: an offloaded skill must stay invisible
to skill discovery, and parking it beside the canonical tree is exactly what a host CLI would pick up.

**Rule 4 — Database Write Safety (Mandatory Permission & Transaction)**
Before executing any command that modifies a database (including `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, or `ALTER`/`DROP` DDL), or using the `--confirm-write` flag, the agent **MUST** obtain explicit user permission. This rule applies even in YOLO/Autonomous mode. Describe the intended modification and wait for user confirmation before proceeding. **All execution on a live database MUST be performed within a transaction scope and be capable of rolling back upon error to protect the database.**

**Rule 5 — Empirical Verification (No Assumptions)**
Before proposing schema changes, reporting on data characteristics, or making technical claims about file contents, the agent **MUST** perform empirical verification (e.g., `grep` scans, SQL queries, targeted `read_file`). Never assume limits or requirements based on intuition or partial headers; always ground suggestions in concrete evidence found within the active project.

**Rule 6 — Multi-CLI Parity (instructions canonical at AGENTS.md)**
The repo **MUST** work identically across every supported agent CLI — Claude Code (primary), Codex CLI, Gemini CLI, Antigravity, and any CLI added later — switching CLIs must never lose instructions, skills, hooks, subagents, or memory. Instructions are canonical at `AGENTS.md` — the CLI-neutral standard filename — and Claude Code stays the canonical authoring surface for hooks, subagents and skill wiring; every CLI **inherits** shared surfaces, never carries a divergent copy: instructions via the `CLAUDE.md`/`GEMINI.md` symlinks to `AGENTS.md`, skills via the Rule 3 exposure links to `.agents/skills/`, hooks and subagents via committed per-CLI ports of the Claude wiring (`.codex/config.toml`, `.gemini/settings.json`, `.agent/settings.json`, `.codex/agents/`, `.agents/plugins/`). Any change to a shared surface **MUST** propagate to all supported CLIs in the same change, and every script involved **MUST** run on both macOS and Windows. Parity is enforced by `tests/multi-cli-parity.test.mjs` and `tests/agent-context-mirror.test.mjs`; the maintenance contract (parity matrix, per-surface checklists, how to add a new CLI) is `docs/guide/multi-cli-compatibility.md`.

## Active Scope & Working-Folder Resolution

**Active Scope:**
1. `.sidekicks/settings.json` → `active_project` field.
2. If missing, root project `sidekicks` is the fallback (never an error). Use `sidekicks project current` to inspect.

**Scope alignment from a supplied path (required):** When a task hands a **file path** to a skill
that reads or writes artifacts — e.g. "implement `projects/foo/services/api/src/docs/plan.md`", or a
path passed into a dev/PRD/review workflow — that path *names the scope the work belongs to*. Before
the first artifact read or write, **align the active scope to the path first**: parse `<project>`
(and `<service>`, when a `services/<service>/` segment follows) out of the
`projects/<project>/services/<service>/...` segments and switch to it — `sidekicks project use
<project>` then `sidekicks service use <service>` (the `sk-scope-switch` skill does exactly
this). *Then* resolve the working folder and proceed. Skipping this is the classic failure mode: the
skill resolves the working folder from a **stale** active scope and reads/writes into the wrong
service. If the supplied path already resolves to the current active scope, no switch is needed; a
path outside `projects/` is root scope. This precedes working-folder resolution — align first, then
anchor.

**Explicit `work_dir` (highest precedence):** A caller may hand a skill an explicit working folder —
invoked as `work_dir=<path>`, or simply an absolute path that names where artifacts should land. When
present, `work_dir` **is** the working folder: the skill anchors every relative path to it and
**skips** `sidekicks scope working-folder` entirely. It still aligns the active scope to that path
first (parse `<project>`/`<service>` from any `projects/<project>/services/<service>/…` segments and
`project use` / `service use` — a `work_dir` outside `projects/` is root scope), so the Rule 2
boundary stays consistent with where writes actually land. Precedence is therefore: explicit
`work_dir` › supplied target path › active scope as-is. The first two both *drive* the scope; only the
last reads it unchanged.

**Working-Folder Resolution (required):** Any skill that **reads or writes artifacts MUST resolve the
working folder first** — before its first artifact read or write — and anchor every relative path to
it, never to the current directory. This is what makes a skill correct regardless of where it is
invoked. (Author guide with the drop-in preamble: `docs/authoring-scope-aware-skills.md`.) Resolve it
one of two ways:

- **From a skill (any language, any cwd):** run `sidekicks scope working-folder`. It prints the
  absolute working folder, resolving the repo root by walking up for `.sidekicks/` — so it is
  correct regardless of where the skill is invoked. This is the preferred handle for agent-facing
  skills, which can be commanded from any location.
- **From framework code (ESM):** call `resolveWorkingFolder(settings, repoRoot)` from
  `lib/active-scope/scope.mjs` and read its `workdir` field.

```javascript
import { resolveWorkingFolder } from './lib/active-scope/scope.mjs';
// const { workdir, servicePath, projectPath } = resolveWorkingFolder(settings, repoRoot);
```

| Active scope | `workdir` (code — anchor edits here) | `artifactsbase` (generated artifacts/runs anchor here) | Free-write boundary |
|---|---|---|---|
| `project=foo`, `service=api` | `projects/foo/services/api/src/` (falls back to the service root if no `src/`) | `projects/foo/services/api/` (the service ROOT, not `src/`) | `projects/foo/services/api/` |
| `project=foo`, `service=(none)` | `projects/foo/` | `projects/foo/` | `projects/foo/` |
| `project=sidekicks` (root) | `<repoRoot>/` | `<repoRoot>/` | repo root, excl. `.sidekicks/` and `projects/` |

For an active service the canonical working folder is its **`src/`** subfolder: **source lives under
`src/`**, while the service root holds metadata (`service.yaml`). **Generated artifacts and run state
do NOT go under `src/`** — they anchor at `artifactsbase` (the service ROOT for a service, else equal
to `workdir`), so a skill's output never pollutes the source tree. The free-write *boundary* remains
the service root (`servicePath`) — writing outside `src/` is still legal. A service with no `src/`
resolves `workdir` to the service root (where it coincides with `artifactsbase`). Resolving an
active-but-missing service directory throws `SidekicksError(EXIT_NOT_FOUND)`. Skills resolve these
from any cwd via `sidekicks scope working-folder` (code) and `sidekicks scope artifacts-base`
(artifacts); framework code reads the `workdir` / `artifactsbase` fields of `resolveWorkingFolder`.

**Note:** A skill's installation scope (framework/project/service) does NOT affect the working-folder output; resolution is driven solely by the active project/service pointers.

**Two artifact anchors layer on top of one run base, and the run base is WORK-ITEM-first
(runs layout v2).** A unit of work — a Jira card, a mission, a plan, a queue — owns ONE folder, and
each skill that touches it contributes a **facet** beneath it, so everything produced for that work
item is found in one place instead of scattered across per-skill trees:

```
RUNSROOT = <projectPath>/artifacts/runs          # the repo root when root scope is active
RUNBASE  = $RUNSROOT/<work-item>/<facet>/        # a skill's facet of one work item
         = $RUNSROOT/<work-item>/                # --bare: the run IS the work item (engines)
         = $RUNSROOT/_adhoc/<skill-id>/          # no work item (full id kept, so grep still finds it)
```

Resolve it — never hand-join it — with `sidekicks scope run-base <skill-id> [<work-item>] [--bare]
[--json]`, the single place the join lives (`lib/active-scope/run-base.mjs` from framework code).

- **Per-project bases.** The base is `projectPath`, **never** the service root: a service's runs
  fold into its project's runs tree, and the service association travels in metadata
  (`run-base --json` → `service`; `artifacts register … service=<name>`), never in the path. This is
  the one place v2 departs from `artifactsbase`, which still governs the free-write boundary and
  every pre-v2 read.
- **Facet** = the skill id minus its `sidekicks-` prefix, except the `sk-bmad-*` family, which
  shares the single facet **`bmad`** (its skills form one pipeline reading each other's documents, so
  they must resolve the SAME tree by default).
- **`--bare`** belongs to the engines whose run IS the work item — get-things-done, get-plan-done,
  skill-auditor, auto-improve. Never stack a second run layer beneath a facet
  (`runs/<item>/<facet>/runs/…` is always wrong).
- **Work-item slug ladder**, highest first: an explicit `run_dir=`/`queue_dir=` (verbatim folder,
  unchanged) › `work_item=<slug>` (universal parameter; orchestrators MUST propagate it to every
  sub-skill, exactly like `docs_dir`, and it never drives scope) › self-derived (card key verbatim,
  mission/plan/queue slug) › none, which lands in `_adhoc/`. Slugs are `[A-Za-z0-9._-]`, no
  separators.
- **Pre-v2 runs stay frozen** at `<artifacts-base>/artifacts/runs/<skill-id>/` — valid read and
  resume targets, never write targets. Every reader (`artifacts scan|list|timeline`) reads both.

Planning **prose** (PRD, stories, tech specs) anchors at `$DOCSDIR` (`docs_dir`, default
`$RUNBASE/docs`). Anything **generated to be executed or replayed** (SQL scripts, command-sequences)
and orchestration **run state** (get-things-done queues, get-plan-done missions, auditor ledgers)
anchors at `$ARTIFACTSDIR` (`artifacts_dir`; with an explicit `docs_dir` the default is its sibling
`$DOCSDIR/../artifacts` so plan-centric runs keep `<impl>/docs` + `<impl>/artifacts` together,
otherwise `$RUNBASE` itself) — **never under `docs/`**. Neither anchor drives scope. Full contract +
drop-in preamble: `AGENTS.md` → *Docs folder* / *Artifacts folder* and
`docs/guide/pending-update/authoring-scope-aware-skills.md`; the per-skill map is
`docs/guide/v1.5/skill-output-folders.md`.

### Portable artifact paths — repo-relative, never machine-absolute

**The invariant: no path a skill PERSISTS into a generated artifact may be machine-absolute.** Run-state
ledgers, queue files (`tasks.yaml`), mission files, sequence files, and any `work_dir=` / `docs_dir=` /
`artifacts_dir=` parameter embedded inside a task's `run:` prompt MUST record a *relative* path — never a
machine-absolute one (`/Users/...`, `/home/...`, `C:\...`). The reason is portability: these artifacts
travel — they are committed, copied between machines and users, and resumed on a different clone. A
machine-absolute path is correct only on the box that wrote it and breaks the instant the folder moves; a
relative path resolves identically everywhere.

Choose the relative form by **how the consumer resolves it** — prefer the more-relative form, fall back to
repo-relative, never machine-absolute:

1. **Folder-relative** — for a reference the consuming skill already anchors to `$WORKDIR` (e.g.
   `input=inputs/...`, `work/artifacts/sql/...` inside a run folder). This is the most portable: the whole
   run folder can be relocated anywhere and the reference still resolves. Use it wherever the consumer
   anchors to the folder.
   A `work_item=` slug is inherently portable — it is a name, never a path, so it is passed as-is.
2. **Repo-relative** — for the anchor fields themselves (`work_dir`, `docs_dir`, `artifacts_dir`,
   `engine_artifact`, per-task `work_dir`) and any cross-tree reference (e.g. a schema capture under another
   project path). These are resolved **against the repo root**, not the artifact's folder — the documented
   explicit-`work_dir=`/`docs_dir=`/`artifacts_dir=` contract already accepts "absolute, *or resolved
   against the repo root*" — so their portable form is repo-relative (`projects/<p>/...`, `.` = repo root),
   exactly as the index-path invariant already mandates ("Index paths are repo-relative — never absolute").
   A folder-relative form would resolve against the wrong base here, so don't use it for anchors.
3. **Machine-absolute** — never acceptable in a persisted artifact.

**At consumption time, resolve a repo-relative path against the repo root** (walk up for `.sidekicks/`, or
`git rev-parse --show-toplevel`) — never against the current directory. **When persisting, normalize first:**
if a skill is handed a machine-absolute `work_dir=`/`docs_dir=`/`artifacts_dir=` (the runtime resolves these
to absolute for its own use, which is fine), it MUST strip the repo-root prefix before WRITING the value into
any artifact it persists, so the on-disk record stays repo-relative. Skills that emit these fields
(jira-autopilot ledger, GTD/GPD queues & missions, the importers' embedded params, sequence files) own this
normalization.

## Overrides Precedence

Two distinct override chains share the same shape: the project layer always wins.

**1. Framework rules, AGENTS.md criteria and hooks** — the enable map (`sidekicks framework …`).
Implemented in `lib/framework-settings/resolve.mjs`; full contract in
`docs/guide/framework-settings.md`.

| Level | Source | Priority |
|---|---|---|
| Safety floor | `lib/framework-settings/floor.mjs` (`LOCKED_IDS`) — **code, not a setting** | Absolute (cannot be disabled) |
| Project | `projects/<active>/manifest.yaml` → `overrides.framework.{rules,criteria,hooks}.<slug>` | High (Wins) |
| Machine | `.sidekicks/settings.json` → `framework.{rules,criteria,hooks}.<slug>` (git-ignored) | Medium |
| Framework | `.sidekicks/framework.yaml` → `{rules,criteria,hooks}.<slug>` (committed) | Low |
| Built-in | — | Enabled |

A missing or empty file at any level contributes nothing and is **never an error**. A floor id
present in any of those data layers is a validation error, not a silent no-op. Values are booleans
only.

**2. CLI knobs** — unchanged in meaning:

| Level | Source | Priority |
|---|---|---|
| Project | `manifest.overrides` | High (Wins) |
| Framework | `.sidekicks/settings.json` `framework_defaults` (`output_dir`, `manifest_filename`) | Low |

**3. Skill configuration** — `sidekicks framework config <skill>`, implemented in
`lib/skill-config/resolve.mjs`, merged **per key**:

| Level | Source |
|---|---|
| Project | `projects/<active>/config.yaml` → the skill's block |
| Root | `.sidekicks/config.yaml` → the same block, only for blocks that inherit root (`slack`, `run_notify`) |
| Skill defaults | `.agents/skills/<skill>/config.defaults.yaml` (committed, never secret-bearing) |
| Skill built-in | the `config.builtin` mapping in the skill's `skill.yaml` |


## Skill Scope & Format Contract

- **Scopes (Visibility only):** service scope (`.../services/<svc>/.agents/skills/`) > project scope (`.../.agents/skills/`) > framework scope (`.agents/skills/`). 
- **Scope is inferred from directory location:** No per-skill scope declaration is required; the location determines visibility. More-specific scope wins on name collision (Shadowing).
- **Format:** `SKILL.md` with Claude-Code-native YAML frontmatter (`name`, `description`). The CLI never reads the body.
- **Two Meanings of "Skill":** 
  - *Agent-facing:* Markdown bundles (`.agents/skills/<name>/SKILL.md`) run by Claude Code.
  - *Framework logic:* ESM modules (`lib/<name>/*.mjs`) run by `bin/sidekicks`. Do NOT confuse these.
  - **Host exposure:** Host-level exposure directories (`.claude/skills/`, `.agent/skills/`, `.agents/skills/`, `.gemini/skills/`) are CLI-self-healed links (Rule 3).

## Index Files — Canonical Lookup Surface

Two CLI-owned, self-healing index files give agents a single call for orientation and drill-down
lookups. Prefer these over separate `project list` / `service current` / `scope working-folder`
calls.

### The two index files

| File | Scope | Persistence | Schema key |
|---|---|---|---|
| `.sidekicks/state/index.json` | Root registry | **Git-ignored** — derived cache; rebuilt on demand or on self-heal. Lives in the scope's `state/` directory with the other derived files (`running-agents.json`, `artifacts-inventory.*`); the pre-move top-level path is still read. | `schema_version: 1`, `scope: "root"` |
| `projects/<name>/index.json` | Per-project service index | **Committed** — travels with the project | `schema_version: 1`, `scope: "project"` |

**Root index (`schema_version: 1`, `scope: "root"`)** — fields:
- `active` — the live `{ project, service, working_folder }` triple
- `projects` — map of project name → `{ kind, path, remote_source?, index? }`; `kind` is `"root"` or `"user"`
- `skills` — flat list of all visible skill names

**Project index (`schema_version: 1`, `scope: "project"`)** — fields:
- `project` — project name
- `built_at_commit` — commit SHA at rebuild time (staleness signal)
- `services` — map of service name → `{ path, working_folder, service_yaml, remote_source, branch, commit, state }`

### Boundary / travel invariants

- The **root index** is git-ignored — it is a local derived cache safe to persist and self-heal; it
  is never committed and never travels between clones.
- **Project indexes** are committed inside `projects/<name>/` and travel with the project when it
  moves between agents or machines. They may be stale (built at a past commit); rebuild explicitly
  when freshness matters.

### Canonical drill-down verbs

```
sidekicks index show [<project>] [--json]   # root registry or a project's service index
sidekicks index get <key>                   # resolve one entry by key:
                                            #   active | project:<p> | skills | project:<p>:service:<s>
sidekicks scope inventory                   # human-readable snapshot of the active scope
sidekicks index rebuild [<project>]         # force-rebuild root (and all project) indexes, or one project
```

**Orientation pattern (preferred):** call `index show --json` once to get the full root registry,
then call `index show <project>` only when you need that project's services.

## Additional Boundary Resolutions

- **Mixed State Contract:** Mixed clone/submodule state within one project is legitimate. Acquisition mode (`clone` or `submodule`) depends on the project's git identity. Submodule wiring is user/agent git work the CLI recognizes but never commits.
- **Validation:** Framework validates service manifests permissively (warns, no hard-error).
- **Name collision:** More-specific skill scope wins (service > project > framework).
- **Visibility:** Framework-scope skills always visible regardless of active project.
- **Multi-service writes:** Writing to multiple service directories in one session is at skill discretion.
