---
name: sk-packager
description: >-
  Assemble, distribute, export, bundle, or transfer a portable Sidekicks runtime package or
  individual components. Use for packaging Sidekicks for deployment, exporting a subsystem to
  another repo, upgrade-safe overlay onto an existing install, or transferring skills/libraries.
  Triggers on package, bundle, distribute, export, transfer a subsystem, export a skill, and
  sidekicks package create/transfer/preview/versions. Writes only to the external --output path
  (outside the free-write surface); resolves the active scope for context only — no
  work_dir=/docs_dir=/artifacts_dir= anchors.
sidekicks:
  runtime-class: framework
---

# sk-packager

A CLI-driving skill that fronts both `sidekicks package create` (full portable runtime) and
`sidekicks package transfer` (individual lib/skill export). Writes no artifacts into the active
scope — output goes to the external `--output` path outside the free-write surface.

## Intent Routing

**Whole-runtime ask** (packaging Sidekicks itself, distributing to another machine, upgrade-safe
overlay of an existing install) → use `sidekicks package create --output <path>`.

**Component ask** (exporting a lib subsystem or skill to reuse in another repo, transfer a module
with its dependencies) → use `sidekicks package transfer <unit> [--with-deps]`.

**Ambiguous?** Ask the user once: "Do you want to package the full Sidekicks runtime, or export
specific components (libs/skills)?"

---

## Working Folder Note

Before any other step, resolve the active scope with `sidekicks scope working-folder` to get
context (project/service). However, **this skill writes to the external `--output` path**, which is
*outside* the free-write surface (Rule 2). The boundary rules do not apply to the destination —
do not confuse the external `--output` with the active scope's write surface.

---

## Command Surface

### `sidekicks package create`

Assemble a clean, portable Sidekicks runtime package.

```bash
sidekicks package create \
  --output <external-path>         # Required; must be outside repo root
  [--include-claude[=false]]       # Include .claude/ config (default: true)
  [--include-gemini[=false]]       # Include .gemini/ + bmad/ (default: true)
  [--include-agent[=false]]        # Include .agent/ config (default: true)
  [--version-check]                # Skip component downgrades (default: false)
  [--dry-run]                      # Print plan without writing (default: false)
```

### `sidekicks package transfer`

Bundle individual lib subsystems and/or skills into a portable folder.

```bash
sidekicks package transfer \
  <unit>... | --all                # Named lib/skill or all sidekicks-* skills
  [--output <path>]                # Default: output/transfer/ (in-repo, git-ignored)
  [--with-deps]                    # Include closure of intra-lib/ dependencies
  [--version-check]                # Block downgrades to existing dest
  [--dry-run]                      # Print plan without writing
```

### `sidekicks package preview`

Alias for `package create --dry-run`. Prints copy plan, writes nothing.

```bash
sidekicks package preview --output <path>
```

### `sidekicks package versions`

Ensure and report `VERSION.json` across all `lib/*` and `.agents/skills/*`.

```bash
sidekicks package versions
```

---

## What Goes Into a Package (`create`)

### Included

| Component | Handling |
|---|---|
| `bin/sidekicks` | Copy, preserve mode 0755 |
| `lib/**` | Full recursive copy; carries `VERSION.json` per module |
| `.sidekicks/RULES.md` | Copy |
| `.sidekicks/config.example.yaml` | Copy (key-free schema doc) |
| `.agents/skills/**` | Full copy; carries `VERSION.json` per skill |
| `AGENTS.md` | Copy |
| `CLAUDE.md`, `GEMINI.md` | Recreated as relative symlinks → AGENTS.md |
| `.claude/**` | Optional (`--include-claude`); `.claude/skills/` → symlink |
| `.agent/**` | Optional (`--include-agent`); `.agent/skills/` → symlink |
| `.gemini/**` + `bmad/**` | Optional (`--include-gemini`); only if present |
| `.githooks/` + `scripts/` | Always copied |
| `package.json`, `README.md` | Copy |
| `PACKAGE.md` | Generated (version, contents, Node ≥ 20 prerequisite, quick start) |
| `projects/.gitkeep` | Generated (empty placeholder) |

### Excluded

| Item | Reason |
|---|---|
| `projects/**` (user data) | Users create their own |
| `.sidekicks/config.yaml` | Contains live API keys |
| `settings.local.json` | User-specific local overrides |
| `.git/`, `worktrees/` | Repo metadata |
| `output/`, `tmp/`, `.bmad-cache/` | Volatile |
| `docs/`, `tests/` | Dev-only |
| `.venv/`, `__pycache__/` | Machine-specific |
| `.DS_Store`, `.idea/`, `.vscode/` | OS/IDE noise |

---

## Clean Configuration Defaults

`settings.json` is **generated** (not copied) so the package boots tied to no individual:

```json
{
  "active_project": "sidekicks",
  "active_service": null
}
```

`config.yaml` is **not** generated — relies on skill defaults and `config.example.yaml`.

---

## Component Version Verification

Before assembly, `ensureComponentVersions` creates missing/invalid `VERSION.json` files at `1.0.0`
for every `lib/*` and `.agents/skills/*`. With `--version-check`, components where the source
version < destination version are skipped (downgrade blocked → `EXIT_VALIDATION`).

Check current state:

```bash
sidekicks package versions
```

---

## Assembly Pipeline (10 Steps)

| Step | Action |
|---|---|
| 1 | Validate source (bin exists, lib/sk-cli present, RULES.md, skills non-empty, package.json parseable, ensureComponentVersions) |
| 2 | Resolve & guard output (require --output outside repo; detect existing install → overlay) |
| 3 | Copy engine (bin/sidekicks 0755, package.json, README.md) |
| 4 | Copy subsystems + skills (lib/**, .sidekicks/RULES.md, config.example.yaml, skills/**) |
| 5 | Generate clean settings.json |
| 6 | Copy AI context + recreate CLAUDE.md/GEMINI.md symlinks |
| 7 | Conditional IDE/framework configs + .githooks/ + scripts/ |
| 8 | Generate PACKAGE.md + regenerate index.json (shelled to package CLI, cwd=pkgRoot) |
| 9 | Validate package (all §7 checks) |
| 10 | Output summary (location, file counts, validation results) |

`--dry-run` short-circuits after Step 1 + plan, writing nothing.

---

## Component Transfer (units, closure, exclusions)

### Units

- **Lib subsystem:** `lib/<module>/` (e.g., `scope-lifecycle`)
- **Skill:** `.agents/skills/<skill>/` (e.g., `sk-hello`)
- **All sidekicks-* skills:** `--all`

### Closure Resolution (`--with-deps`)

Lib modules import siblings (`from '../<other>/...'`). Without `--with-deps`, the transfer reports
omitted dependencies. With `--with-deps`, siblings are included automatically.

```bash
# See deps without copying
sidekicks package transfer scope-lifecycle --dry-run

# Include all deps
sidekicks package transfer scope-lifecycle --with-deps --output /path/to/target/lib
```

### Exclusions

`.venv/`, `__pycache__/`, `*.pyc`, `.gitignore`-matched secrets. `.example` and `.template` files
are always included.

---

## Dry-Run

```bash
sidekicks package create --output /tmp/preview --dry-run
# or
sidekicks package preview --output /tmp/preview
```

Prints the full copy plan (copies, symlinks, generated, excluded). Writes nothing.

---

## Upgrade-Safe Overlay

When `--output` points at an existing Sidekicks install (detected by `bin/sidekicks` +
`.sidekicks/settings.json` both present), the pipeline branches to overlay mode:

| Category | Behavior | Examples |
|---|---|---|
| System | Always overwrite | bin/sidekicks, lib/**, skills/**, AGENTS.md, scripts/ |
| User | **Never overwrite** | settings.json, config.yaml, projects/** |
| Generated | Always regenerate | index.json, PACKAGE.md |

### Summary Symbols

| Symbol | Meaning |
|---|---|
| `↑` | Upgraded (src > dest) |
| `+` | New component |
| `=` | Replaced same-version |
| `↓` | Skipped (version-check: downgrade) |
| `!` | Overwritten older |
| `✗` | Orphan removed (with explicit confirmation) |
| `?` | Orphan kept (default) |

### Orphan Detection

Components present at destination but absent in source are reported as orphans. Default is
**keep** — no auto-delete without explicit confirmation (`--remove-orphans`).

---

## Package Validation

After assembly (Step 9), the pipeline automatically validates:

- `AGENTS.md` present; `CLAUDE.md`/`GEMINI.md` are symlinks → AGENTS.md
- Mirror content identical through all three paths
- `node bin/sidekicks --help` exits 0
- `project current` → `sidekicks`; `service current` → `(none)`
- `index rebuild` succeeds; `index show --json` parses
- No absolute paths in index.json
- Skills visible via `index get skills`
- No `config.yaml`/`.env`/`*.pem`/`*.key` present
- `.claude/skills`/`.agent/skills` → `.agents/skills` when included

Any failed check aborts with `EXIT_VALIDATION` and a remediation hint.

---

## Workflow Examples

### Assemble a portable runtime

```bash
# Preview first
sidekicks package preview --output /tmp/sk-runtime

# Assemble (validation included automatically)
sidekicks package create --output ~/deliveries/sidekicks-v1

# Upgrade an existing install
sidekicks package create --output ~/deliveries/sidekicks-v1
# (detected as existing install → overlay mode automatically)
```

### Export a lib subsystem to another repo

```bash
# See what would be copied + what deps would be omitted
sidekicks package transfer scope-lifecycle --dry-run

# Transfer with all intra-lib/ deps
sidekicks package transfer scope-lifecycle --with-deps \
  --output /path/to/target-repo/lib
```

### Export a skill

```bash
sidekicks package transfer sk-hello \
  --output /path/to/target-repo/.agents/skills
```

---

## After-Unpacking Quick Start

**Requires Node.js >= 20.**

```bash
cd sidekicks-package/           # or wherever you unpacked it
node --version                  # must be >= 20

node bin/sidekicks --help       # verify the CLI boots
node bin/sidekicks project list # should show empty list (fresh clone state)

# Wire git hooks (optional but recommended):
node scripts/install-hooks.mjs
```

---

## Implementation Reference

- `lib/package-lifecycle/` — all verbs and engine modules
- `lib/package-lifecycle/componentVersions.mjs` — ensure/compare/check VERSION.json
- `lib/package-lifecycle/plan.mjs` — pure copy-plan builder
- `lib/package-lifecycle/assemble.mjs` — execute the copy plan
- `lib/package-lifecycle/create.mjs` — `package create` verb
- `lib/package-lifecycle/preview.mjs` — `package preview` verb
- `lib/package-lifecycle/transfer.mjs` — `package transfer` verb
- `lib/package-lifecycle/versions.mjs` — `package versions` verb
- `lib/package-lifecycle/overlay.mjs` — upgrade-safe overlay
- `lib/package-lifecycle/validate.mjs` — `validateSource` + `validatePackage`
- `lib/package-lifecycle/closure.mjs` — import-closure analyzer
- `lib/package-lifecycle/index.mjs` — barrel (pure engine functions only)
