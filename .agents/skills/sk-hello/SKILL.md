---
name: sk-hello
description: >-
  Orient an AI agent in a Sidekicks repo AND get a clone ready to work (first-run/resume setup). Use
  at session start; whenever the user asks where they are, what scope is active, what they can write,
  or what skills exist; whenever the user pulls a fresh clone, resumes on a new machine, switches OS
  (macOS↔Windows), or says "set me up", "get me ready to work", "prepare my environment", "pull the
  submodules/projects", "create my config", or "why aren't my skills/plugins/hooks working"; and
  whenever a project is used for the FIRST TIME, project skills were added or enhanced, or the user
  says "set up/regenerate my skill config", "configure jira/slack/database here", or asks which
  integrations are configured. A plain "where am I?" just reports scope via the CLI. On
  setup/resume it AUTO-APPLIES every idempotent fix (hooks, mirrors, skill links, submodules, config
  documentation, plugins, RTK, jq), then audits connector capabilities and documents the missing
  config blocks — via `sidekicks config sync`, from each installed skill's own config.defaults.yaml.
---

# Sidekicks Hello

You have just landed in a Sidekicks-managed repository and need to know your bearings before you
touch anything: which project and service are active, where you're allowed to write, and which
skills you can call on. This skill answers all of that in **one primary CLI call** — the root
index — and never by reading `.sidekicks/settings.json` yourself.

Invoke it with no arguments. It issues a single `index show --json` call, optionally a
drill-down `index show <project> --json` when services detail is needed, and renders a concise
orientation summary. When you are **getting the clone ready to work** — a fresh clone, a new
machine, a switched OS, or any "set me up / pull the projects / fix my environment" ask — it first
runs the **readiness step** (Step 0) so the things git does not carry across a clone are *prepared*
before you start work, not discovered halfway through it. And when a scope is being used for the
**first time** — or the user wants connectors set up — the **capability audit** (Step 0.5) maps
which Sidekicks skill capabilities are configured versus still locked, and guides initializing the
essential config blocks.

## Before you start

- **Run every command from the repo root.** The commands below use the relative path
  `node bin/sidekicks`; if your shell is elsewhere, `cd` to the repo root first. Sidekicks ships
  with zero install step (FR4.3) — there is no global `sidekicks` binary to fall back on, so always
  invoke `node bin/sidekicks`.
- **A single verb failing is not fatal.** If any verb exits non-zero, surface its full stderr to
  the user and continue with the remaining steps on best-effort information. Partial orientation
  beats none.
- **Never read `.sidekicks/settings.json` directly.** The index CLI is the authoritative scope
  resolver; reading the file yourself can disagree with the CLI's resolution logic.

## Step 0 — Environment readiness

Some of what makes a Sidekicks clone work is **not carried by git** and silently breaks when the
environment changes: the git hooks path is per-clone; the `AGENTS.md`/`GEMINI.md` mirrors of
`AGENTS.md` check out as 9-byte text stubs on Windows (so the Claude/Gemini CLIs read a stub instead
of the real instructions); the host skill links can be stubs before the first CLI call; registered
user projects wired as **git submodules** are **empty** after a clone made without
`--recurse-submodules`; each scope's **`config/<family>.secret.yaml` is git-ignored**, so a clone
carries the structure but none of the credentials, and a newly-installed skill's block stays
undocumented until a sync runs; host plugins must be installed locally; the **RTK token-killer CLI
proxy** (its binary and its
per-agent activation hook) is machine-local, so a clone has neither and rtk is silently inactive;
and **`jq`** — which host hooks shell out to (the ralph-loop plugin's Stop hook parses its stdin
payload with `jq -r`) — is machine-local too and absent from a stock macOS, so its hook dies with
`jq: command not found` on every Stop. One bundled, cross-platform (pure Node) check covers all of
it, in two modes.

**Choose the mode by what the user is doing — this is the one judgement call of the step:**

- **Setup / resume / "get me ready" intent** → run **apply mode**. This is a fresh clone, a new
  machine, an OS switch, or any "set me up", "prepare my environment", "first time on this project",
  "pull the submodules/projects", "fix my symlinks", or "why isn't X working" ask. Apply mode
  **performs** every idempotent fix so work can start without a second prompt:

  ```
  node .agents/skills/sk-hello/scripts/readiness.mjs --apply
  ```

  It installs the git hooks, recreates the **OS-correct** symlinks (real symlinks on POSIX;
  junctions + file-symlink-or-copy on Windows, via the shared `setup-windows.mjs`), self-heals the
  host skill links, runs `git submodule update --init` for **only the uninitialized** submodules
  (pulling those registered projects into the workspace), **documents every declared config block**
  in each scope's `config/<family>.yaml` by delegating to `sidekicks config sync --scope all` — the
  CLI verb that composes each block from **the owning skill's own `config.defaults.yaml`**, writing
  it **inert** (commented out) so the block keeps resolving to that skill's defaults until a human
  uncomments a key. It is additive by construction: a block carrying live values is never rewritten
  in any mode, so this is safe as a side effect of readiness in a way seeding a whole file never
  was. It also **installs any missing host plugins** declared
  in `.claude/settings.json` (and their marketplaces) via the non-interactive `claude plugin` CLI,
  and **activates the RTK token-killer**: installs the `rtk` binary when missing (best-effort via
  `brew install rtk`; a host without brew, e.g. Windows, is reported with the manual install path
  instead of failing), then wires rtk's activation hook per agent — a **project-local** hook for
  Claude Code in the git-ignored `.claude/settings.local.json`, and the **global** hook for Gemini
  via `rtk init --gemini --global` (rtk supports no project-local Gemini hook; Codex has no rtk hook
  and is reported N/A), and **installs `jq`** when missing — `brew install jq` where brew exists,
  otherwise the official single-file release binary downloaded (via `curl`) into `~/.local/bin`, then
  verified by running it. Relay its report verbatim (it lists what it applied and what, if anything,
  still needs attention).

  **Prompt for any plugin setup the report flags.** Installing a plugin's package does not always
  make it work — some need a one-time interactive setup the script deliberately does **not** run.
  When the report prints a **`Plugin setup needed`** section (e.g. `claude-hud — run
  /claude-hud:setup …`), surface it and **ask the user whether to run that setup now**; on yes,
  invoke the named setup (e.g. the `/claude-hud:setup` skill). Never run it unprompted — it rewrites
  the host's statusline/config and needs a Claude Code restart to take effect. No section, nothing to
  ask. (This section also appears in report mode if a plugin is installed but never configured.)

- **Plain "where am I?" orientation, nothing obviously broken** → run **report mode** (no flag). It
  detects and prints state, mutating nothing, and stays fast (no network). If everything is green,
  don't paste the block — just set the **Environment** field in the summary (Step 3) to `ready`. If
  it surfaces `[FIX]` rows and the user wants them fixed, re-run with `--apply`.

**Three safety properties to rely on, not re-litigate:**

- **Apply never clobbers in-progress work.** It only *initializes* submodules that are not yet
  checked out (an already-populated submodule — even one with local edits — is left untouched), and
  it only *appends* config blocks a scope does not document yet — a block carrying live values is
  never rewritten in any mode, and the git-ignored `<family>.secret.yaml` holding real credentials
  is never touched at all.
- **Host plugins ARE auto-installed (additively).** Apply mode runs the non-interactive
  `claude plugin marketplace add` + `claude plugin install` for the declared-but-missing plugins —
  both verbs are idempotent and purely additive (they never remove or downgrade an existing plugin).
  When the `claude` CLI is absent — running under another agent CLI where plugins do not exist — the
  plugins row is reported **N/A** instead of installed, so it is never a standing failure.
- **RTK activation is idempotent and never double-wires.** The Claude hook is considered already
  active when *any* settings source Claude merges — global `~/.claude/settings.json`, the committed
  repo `.claude/settings.json`, or the project `.claude/settings.local.json` — already runs it, so
  apply adds the project-local hook only when none exists (two matching PreToolUse Bash hooks would
  run rtk twice per command). The hooks are wired only once the binary is present (a hook shelling
  out to a missing `rtk` would error on every command), the project-local patch preserves the rest of
  `settings.local.json`, and the binary install is best-effort — a host without brew degrades to a
  reported manual install, never a crash.
- **The `jq` install never fakes a green.** Apply downloads the platform+arch-matched release asset
  only (an unrecognised platform reports the manual path instead), then *runs* the downloaded binary
  before calling it installed — a truncated file or an HTML error page never passes. When the binary
  is present but `~/.local/bin` is not on PATH, the row stays `[FIX]` with "add it to PATH" as the
  remedy rather than re-downloading, because a hook still cannot reach it.

### Third-party skills are installed, never bundled

Some skills this repo *uses* are not ours to redistribute. They are declared as host plugins in
`.claude/settings.json` (`enabledPlugins` + `extraKnownMarketplaces`) and installed from upstream —
the skill folder itself does not travel in a distributed framework core (see
[docs/guide/v1.5/framework-as-submodule.md](../../../docs/guide/v1.5/framework-as-submodule.md)).

The **Host plugins** readiness row is that guidance: it names each declared plugin the host is
missing and prints the exact `claude plugin marketplace add …  &&  claude plugin install …` pair,
which `--apply` runs for the user. Nothing extra to explain — but when a workspace was just
bootstrapped from a mounted core, say so out loud, because the missing plugin is the reason a
declared comms mode or command is not responding yet.

The live case is **`caveman`** (`JuliusBrussee/caveman`, MIT). AGENTS.md loads it at session start as
the default comms mode, yet a freshly mounted workspace has the *declaration* and not the *package*.
If that row is `[FIX]`, tell the user plainly: caveman is third-party, install it with the printed
command (or `--apply`), and until then responses come back in normal prose. Do **not** offer to copy
the skill folder in from somewhere — that is the redistribution this split exists to avoid.

### BMAD Method — a required dependency, not a plugin

AGENTS.md's `rule.bmad-first` makes the BMAD chain mandatory for service code, and every
`sk-bmad-*` skill is a **thin driver**: it activates a BMAD slash command
(`/bmad:bmm:agents:pm`, `/bmad:bmm:workflows:prd`, …) rather than implementing the workflow itself.
BMAD is **not** a Claude plugin — it is absent from `.claude/settings.json`, so the Host-plugins row
above can never cover it, and it installs by cloning
[BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) and running its own **interactive**
installer. That is why the row is **report-only**: `--apply` never clones or installs it.

The row appears **only** where BMAD is expected — a repo carrying bmad-family skills or bmad command
stubs — and distinguishes three not-ready states, because they need different remedies:

| Row says | Means | Tell the user |
|---|---|---|
| `not installed — no bmad/ tree and no command stubs` | BMAD was never installed here | clone + run the installer; until then every bmad-family skill is unusable |
| `command stub(s) present but bmad/ module tree MISSING` | the `/bmad:…` commands exist and will be offered, then **fail at step 1** loading `{project-root}/bmad/core/tasks/workflow.xml` | this is the **freshly mounted framework core** case — the core carries `.claude/commands/` (so the stubs travel) but not `bmad/`. Say the commands are dangling, not that the skill is broken |
| `bmad/ ✓ but NO command stubs on any CLI` | the module tree is there but nothing exposes it | re-run the BMAD installer to wire this repo's IDE commands |

The middle case is the one worth calling out unprompted after a bootstrap: the failure names a
missing file, so it reads like a bug in the skill rather than a missing install.

### Framework core release debt

In the repo that **publishes** the framework core — the discriminator is the **core service**
(`projects/global/services/sidekicks-harness/src`), since `scripts/framework-core-publish.mjs`
itself travels into a forged core — one more report-only row answers "does the core owe a
release?" — pending core-bound commits since the last publish, core-bound files still uncommitted,
and whether the release log and the forged marker agree on the version. It is the publish script's
own `status --json`, surfaced on every orientation so the release log stays automatic instead of
remembered.

Never offer to publish as part of orientation — forging and tagging a release is outward-facing.
Report the row and, if the user wants it, hand them
`node scripts/framework-core-publish.mjs status` (then `… publish`). A mounted core carries the
script but no core service of its own, so the row is absent there — correct, because a mounted core
publishes nothing.

The step is best-effort and always exits 0 — if the script errors, surface its stderr and continue
with orientation. Carry the result into the summary's **Environment** field: `ready`, `prepared`
(apply ran and all green), or `N item(s) need attention — see above`. When the only outstanding rows
are report-only (BMAD, release debt, plugins-N/A) the script says so and does **not** offer
`--apply` — don't offer it either; it cannot fix them.

**Handoff to Step 0.5:** when apply mode just **documented blocks** for the active scope, that scope
is being used for the first time (or its skills grew) — run the capability audit (Step 0.5) next, so
the user learns which capabilities are still locked before starting work. Documenting a block is not
configuring it: an inert block resolves to the owning skill's defaults, and only the audit says
which connectors still have no values.

## Step 0.5 — Capability audit + config generation (first-time use, new/enhanced skills)

An environment can be fully *ready* (Step 0 green) while the scope's skills are still *locked*:
connector skills (Jira, Slack, Confluence, database, Teleport) read their settings from the scope's
configuration and quietly fall back to "not configured" until a value exists. This step answers
"what CAN the Sidekicks skill family do here, and what still needs configuring?" — then **documents**
the missing blocks from the skills' own defaults so the user only fills in values.

**Configuration is a FOLDER, and the split matters here.** Each scope keeps one **committed** file
per family — `.sidekicks/config/jira.yaml`, `…/comms.yaml`, … (or `projects/<active>/config/…`) —
carrying the structure with every credential key present but empty, beside a **git-ignored**
`<family>.secret.yaml` sibling that carries the values. Booleans live somewhere else again
(`config/settings/`); this step never touches those. Full contract:
[docs/guide/settings-vs-configuration.md](../../../docs/guide/settings-vs-configuration.md).

**Run it when** (skip on a plain orientation where none of these hold):

- a scope is being used for the **first time** — its `config/` is absent, or documents blocks but
  carries no values anywhere (including right after Step 0 apply documents them);
- **skills were added or enhanced** — a new or updated skill may declare a new config block; both
  the audit and the sync discover blocks dynamically, so re-running them picks new capabilities up
  automatically. This is the "regenerate my config for the skills I now have" path;
- the user asks to **set up / initialize / regenerate connector config**, configure
  jira/slack/database/confluence, or asks **what the skills can do here / which integrations are
  configured**.

The audit reports; the sync writes. Always audit first.

```
node .agents/skills/sk-hello/scripts/capability.mjs
```

Report-only, always exits 0, never touches configuration. **It derives nothing itself** — it asks
`sidekicks config list --json` and `sidekicks config sync --dry-run --json` and renders the join, so
its answer is the CLI's answer. (It used to keep its own copy of the resolution chain and went
silently stale the moment configuration became a folder, reporting every configured connector in the
repo as unconfigured. An audit that is confidently wrong is worse than no audit.) Each block is
classified as:

- `[SET]` configured — the block carries live values in this scope;
- `[INH]` inherited from root — only blocks declaring `inherits_root` (today `slack`, `run_notify`);
- `[tpl]` documented — the block is present but entirely commented out: the **inert** scaffold, which
  still resolves to the owning skill's `config.defaults.yaml`;
- `[ - ]` absent — not documented here yet; a sync would add it;
- `[ ? ]` no defaults — the owning skill ships none, so there is nothing to document; use
  `sidekicks config example <block>` for a starting shape;
- `[rt ]` root-scoped — framework infrastructure read at root only, listed so a project scope does
  not look like it is missing something.

Blocks marked `*` are the **essential connectors** (jira, slack, confluence, database_connector)
that gate whole skill families. It also reports **drift**: a `[SET]` block that does not override
every key its skill's current defaults document. Drift is **not a defect** — an un-overridden key
resolves from the skill, which is the contract — it is a prompt to look at what the skill grew.

### Documenting the blocks (`sidekicks config sync`)

Do **not** hand-write connector blocks into a family file. The CLI composes them from the same
declarations the audit reads, so a skill that was added or enhanced is picked up with no list to
maintain:

```
sidekicks config sync --dry-run              # the plan — always show this first
sidekicks config sync                        # perform it
sidekicks config sync --only=jira,slack      # narrowed to what the user asked for
```

Flags: `--scope active|root|all|<project>` (default `active`), `--only=jira,slack`, `--dry-run`,
`--refresh`, `--prune`, `--json`. **`--dry-run` is the plan the user approves; `--check` is the CI
gate** — same output, but `--check` exits non-zero when a sync would close a gap, so never use it as
the interactive preview.

Three actions, in strict order of safety:

| Action | When | Effect |
|---|---|---|
| `add` | block absent | appended as an inert, documented scaffold |
| `refresh` | block present but **entirely commented out** (no live value to lose) | regenerated from the current defaults — this is how an enhanced skill's new keys arrive. Opt-in via `--refresh` |
| `keep` | block carries **live values** | never touched in any mode; keys the defaults document that it does not override are reported as drift for the user to merge by hand |

Everything generated is **commented out**, and that is the whole safety model: a live default written
into a scope file would permanently **shadow** the skill's own default, so the skill could never
improve it again. Inert, the block documents the schema while still resolving to the owning skill —
and no placeholder can be actuated as a real credential. Nothing is ever deleted; `--prune` *moves*
an undeclared block to a git-ignored `pending-removal.<family>.yaml` rather than dropping it.

**Then guide the fill-in (the human decides, the agent does the legwork):**

1. Relay the audit, leading with the open essential connectors and what each unlocks. Ask which the
   user wants for this scope — never assume all of them; a docs-only project may need none. Narrow
   the run with `--only=` rather than documenting everything.
2. Run the sync for the chosen blocks, then write the **non-secret** values the user supplies (URLs,
   project keys, channel names, alias names) with `sidekicks config set <block>.<key> <value>`.
3. **Leave secret keys for the user to fill by hand** (`api_token`, `bot_token`, passwords). Prefer
   hand-editing over pasting secrets into chat — the transcript persists. If the user pastes one
   anyway, write it with `sidekicks config set <block>.<key> <value> --secret`, which routes it to
   the git-ignored `<family>.secret.yaml`, and do not echo it back. Never put a credential in the
   committed family file; `config doctor` fails the build if one lands there.
4. **Report drift, never auto-merge it.** Show the un-overridden keys and let the user decide — each
   already resolves from the skill.
5. **Offer verification** once a connector is filled in: each connector skill has a read-only check
   (e.g. jira/slack `list-envs`, database-connector's connection test). Best-effort — a failed check
   is feedback on the values, not a blocker for the rest.

Carry the result into the summary's **Capabilities** field: `N configured, M open (essential:
<names>)` — or `all essential connectors covered`.

## Step 1 — Read the root index (primary orientation call)

```
node bin/sidekicks index show --json
```

This single call returns everything needed for cold-start orientation. Parse the JSON output and
extract:

- `active.project` — the active project name (`sidekicks` = root project active).
- `active.service` — the active service name, or `null` when no service is active.
- `active.working_folder` — the working folder path, **relative to the repo root** (`.` = repo
  root); **anchor all writes to this path** (resolve it from the repo root).
- `projects` — an object mapping project names to their entries (kind, path, remote_source, index).
- `skills` — an array of framework-scope skill names (from `.agents/skills/`).

**Do not issue separate `project list`, `service current`, or `scope working-folder` calls** —
the root index provides all of this data in a single, self-healing read.

If `active.project` is `sidekicks`, the **root project** is active — the default on a fresh
clone, with no manifest to read; skip Step 2. Any other value is a named user project; continue
to Step 2 only if you need that project's services detail.

## Step 2 — Drill into the project index (named-project case only, when services are needed)

*Skip entirely when the root project (`sidekicks`) is active — the root has no services.*
*Also skip when services detail is not required for the task at hand.*

When the active project is a named user project and you need its services list, run:

```
node bin/sidekicks index show <active-project> --json
```

Parse the JSON output and extract:

- `services` — an object mapping service names to their entries (path, working_folder,
  service_yaml, remote_source, branch, commit, state).

Use `active.service` from Step 1 to highlight which service is active (or `null`/`(none)` if
none is active).

Also check whether `projects/<active-project>/.gitmodules` exists. If it does, the project uses
git submodules — include the submodule caveat in the summary (see Step 3).

## Step 3 — Render the summary

Lead with the working folder, because that is what bounds your next action. Keep each field to a
line or two.

```markdown
## Sidekicks Orientation

**You can write within:** <active.working_folder from Step 1>
<one line on what that means — e.g. "repo root, excluding .sidekicks/ and projects/" or
"projects/<name>/ only">

**Environment:** ready | prepared | <N> item(s) need attention — see Step 0   ← from the readiness step
**Capabilities:** <N> configured, <M> open (essential: <names>) | all essential connectors covered   ← only when Step 0.5 ran

### Scope
- **Active project:** <active.project>  (root | named)
- **Active service:** <active.service> | (none)

### Projects
<formatted list derived from the `projects` object in the root index JSON>
<reproduce the same format as `project list` output: "* <name>" for active, "  <name>" for others>
<include "[root]" marker for kind=="root" entries>
<if projects contains only the root entry, also show "(no projects yet)" above it>

### Visible skills
- **Framework** (`.agents/skills/`): <names from `skills` array in root index>
- **Project** (`projects/<active>/.agents/skills/`): <names> | (none) | n/a (root active)
- **Service** (`projects/<active>/services/<svc>/.agents/skills/`): <names> | (none) | n/a (no active service)

### Manifest  ← named project only
- **remote_source:** <projects[active].remote_source | null>
- **services:** <list of service names from project index, or [] if none / not loaded>

### ⚠️ Submodules  ← only when projects/<active>/.gitmodules exists
This project nests git submodules of its own. To populate them without re-cloning, Step 0's
apply mode (`readiness.mjs --apply`) initializes any uninitialized submodules — including these —
or run `git submodule update --init --recursive` by hand. A fresh clone can also pull everything up
front with `git clone --recurse-submodules <remote_source>`.
```

**Reconstructing the projects list:** derive it from the `projects` object in the root index
JSON. Mark the active project with `* `. Mark root-kind entries with `(root) sidekicks — implicit, default`.
If no user-project entries exist (only the root entry), prepend `(no projects yet)`.

**Project-scope and service-scope skills:** the root index `skills` array covers only the
framework scope. To enumerate project-scope and service-scope skills, use the filesystem guard
(a skill is a directory containing a `SKILL.md`):

```
for d in <skills-dir>/*/; do [ -f "$d/SKILL.md" ] && basename "$d"; done
```

Run it for:

1. **Project scope** (only when a named project is active): `projects/<active-project>/.agents/skills/`
   — report `(none)` if the directory is absent or holds no skills.
2. **Service scope** (only when a service is active): `projects/<active-project>/services/<active-service>/.agents/skills/`
   — report `(none)` if absent or empty.

**Shadowing:** when a name appears at more than one scope, the more-specific scope wins —
service > project > framework (FR5.5).

Once rendered, you are oriented and may operate within the resolved working folder per the
free-write rules in `.sidekicks/RULES.md`.
