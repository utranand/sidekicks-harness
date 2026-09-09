---
name: sk-inherit
description: "Forge and maintain a standalone lightweight Sidekicks RUNTIME: a self-contained folder and git repo, placed anywhere via --target, carrying a hand-picked subset of skills, optionally named DELEGATE AGENTS (charter + routines only), a generated AGENTS.md, copies of bin/lib/scripts, and its OWN freshly built Python .venv — never a symlink back to the source. Verbs: plan, create, add, drift/check (which inherited skills went STALE after the source changed), patch (fast-forward clean skills, never clobber ones edited in the runtime), venv (recompute requirements.txt, rebuild), verify (prove it is self-contained and runnable), forget. --as-core forges a framework core users mount as a git submodule. Skills may come from the skill-offloaded archive, activating them in the runtime only. Use for a minimal, lean or trimmed-down Sidekicks, a spin-off repo with only certain skills, bootstrapping a new workspace, or checking/syncing/patching/verifying a runtime. One-way into the target; run from the sidekicks root."
allowed-tools:
  - Bash
  - Read
sidekicks:
  runtime-class: framework
---

# sk-inherit

Build a **runtime**: a new folder that is a complete, standalone Sidekicks repo carrying only the
skills you choose. It gets its own git remote, its own generated `AGENTS.md`, its own `.venv`, and
an empty memory store. `git clone` + `node bin/sidekicks --help` works with nothing else present.

This is a framework-registry operation driven from the repo root. It needs no `work_dir=`,
`docs_dir=`, or `artifacts_dir=` — the runtime's location is its own anchor: `runtimes/<name>/` by
default, or anywhere you point `--target`. What the engine generates INSIDE a runtime (`patch`'s
pre-overwrite backups) resolves through **that runtime's own** `sidekicks scope run-base
sk-inherit` (runs layout v2, facet `inherit`; no `--bare` — this skill is not one of the four
engines, and a patch run has no unit of work, so it lands under the runtime's own
`_adhoc/sk-inherit/`) — never this repo's. Falls back to the frozen pre-v2
`<runtimeRoot>/artifacts/runs/inherit/` when the runtime predates `scope run-base` (an older-forged
runtime) or carries no CLI at all yet.

## Two hard invariants

**1. Copies only — never a link back to the source repo.** Every surface is a real file in the
runtime. This is not a style preference: hook scripts resolve their repo root from
`dirname(fileURLToPath(import.meta.url))`, and Node resolves a symlink to its *realpath*. A linked
`scripts/` therefore binds the runtime's hooks to the **source** repo — verified once by a runtime
whose empty memory store still emitted the source repo's full memory as SessionStart context. The
only links a runtime carries are internal: its own `.claude/skills` exposure links (Rule 3) and its
`CLAUDE.md`/`GEMINI.md` mirrors. `verify` asserts this.

**2. Inheritance is one-way: source → runtime.** The sidekicks root is the only source of truth.
Run every verb **from the sidekicks root** — the engine refuses to run from inside a runtime. A
runtime's local edits are *detected* so they are never silently destroyed, but they are never
promoted upstream. A local improvement worth keeping must be made in the source repo.

## Framework-core configuration

`create --as-core` discovers its safe configuration surface rather than maintaining a filename
list. Adjacent `config/*.example.yaml` and `*.example.json` files are copied and initialize their
canonical filenames; settings and `config/.gitignore` also travel. Canonical source values, secret
siblings, state and retired files never travel. A standalone canonical file without an adjacent
example is an incomplete publication contract and `inherit verify` names the required initializer.

## The engine

One script does all the work. Drive it; do not hand-copy files.

```sh
IH=".agents/skills/sk-inherit/scripts/inherit.mjs"
node "$IH" help
```

| Verb | Purpose |
|---|---|
| `skills` | List what is inheritable — skills (active + offloaded), delegate agents, the required floor and the presets |
| `list` | List every known runtime and where it lives (registry + `runtimes/` scan) |
| `plan` | Show what `create` would copy and the Python requirements it resolves — no writes |
| `create` | Forge the runtime: copy skills + substrate, generate `AGENTS.md`, build its venv, `git init` |
| `add` | Inherit more skills into an existing runtime, regenerate `AGENTS.md` |
| `drift` (`check`) | Three-way compare source vs runtime vs baseline |
| `patch` | Push clean fast-forwards; hold back anything edited in the runtime |
| `venv` | Recompute `requirements.txt` and rebuild the runtime's own venv |
| `verify` | Assert the runtime is self-contained and actually runnable |
| `forget` | Drop a runtime's registry entry (leaves its files untouched) |

Selection is `--skills a,b,c` and/or `--preset <name>`, deduped. Static presets are ordinary named
lists; `framework` is resolved from per-skill runtime declarations plus hard dependencies. Delegate
agents are selected separately with `--delegates a,b` (see below). Exit codes: `0` ok, `2` usage, `3` state, `4` unknown
skill or delegate, `10` drift or held-back work, `11` venv problem, `12` verify failed.

### The required floor — six skills you do not select

Every runtime carries `sk-hello`, `sk-cli`, `sk-commander`,
`sk-scope-switch`, `sk-config-doctor` and `sk-skill-manager`, unioned into whatever you asked for.
**There is no flag that drops them.** A runtime that cannot orient itself, drive a CLI verb, execute
a command-sequence, align scope, validate its config or manage the skills it carries is a defect
rather than a lean build, so this is not a choice the operator gets to make — the same stance as
`scripts/lib/`, which always travels because every hook imports `hook-gate.mjs`.

`sk-commander` is the executor half only: a command-sequence file is run, never read as a
document, and no other skill can run one. Authoring a sequence is `sk-sequence-planner`,
which is deliberately **not** floor — select it when the runtime writes sequences as well as runs
them.

`sk-skill-manager` is floor because a runtime's skill set keeps moving after the forge: it validates,
heals, imports, removes and discovers skills, which is exactly what a mounted core's consumer does
from day one. Its siblings are **not** dragged in with it — without `skill-creator` the manager
cannot CREATE or apply an ARCHITECT repair, and without `sk-skill-auditor` CATALOG loses its
family/first-party half; everything else works, and both absences are stated in the manager's
manifest rather than discovered at runtime. That is why neither sibling sits in the manager's own
SKILL.md frontmatter `depends-on`: this section's dependency-closed claim is about the hard,
forge-blocking edges `declaredDependencies()` reads from frontmatter, not about a skill's own
manifest-declared *optional* siblings — an optional sibling may be legitimately absent with a stated
degraded behavior, and never produces a `MISSING DEP`/`UNMET declared depends-on` line.

The floor is the `required:` block in `assets/presets.yaml`. It is **not** a preset: `--preset
required` is rejected, and `--preset core` is how you ask for these six *and nothing else*.

| Path that could drop it | What actually happens |
|---|---|
| `--skills` / `--preset` naming none of them | unioned in; `plan` and `create` mark each `[required]` |
| `--prune-skills` | never deletes one, whatever the selection |
| deleted from the runtime by hand | `verify` FAILS (exit 12); `drift` reports `MISSING REQUIRED` |
| never inherited (runtime predates the floor) | same `MISSING REQUIRED` row, even with no manifest unit |
| restoring it | `patch --name N` — no `--force`, there is no runtime-side work to protect |

An empty `--skills`/`--preset` selection still exits `2`. The floor fills a selection; it never
substitutes for one, so it cannot forge a runtime nobody asked for.

## Where a runtime lives — anywhere

The default is `runtimes/<name>/`, but `--target` puts a runtime **any** location: an absolute path,
a path relative to the repo root (resolved from the repo root, not your cwd), or a directory
entirely outside the repo — a sibling folder, another volume, a checkout somewhere else.

**The location is remembered.** `create` records it, and any verb given an explicit `--target`
adopts that location too, so afterwards `--name` alone is enough:

```sh
node "$IH" create --name edge-rt --target ~/work/runtimes/edge-rt --preset core
node "$IH" drift  --name edge-rt          # finds it — no --target needed
node "$IH" list                           # shows every known runtime and where it lives
```

The registry is run state at `artifacts/runs/inherit/runtimes.json` (git-ignored), and stores each
path **relative to the repo root** — including the `../..` form for an out-of-tree target — because
no machine-absolute path may be persisted into an artifact. Consequences worth knowing:

- Pass `--target` again to **move** a runtime's registered location, or to **adopt** one this repo
  has not seen before (someone else's clone, a runtime restored from backup).
- `list` marks an entry `MISSING` when its directory is gone; clear it with `forget`.
- A runtime placed **outside** the repo is outside the free-write surface — passing `--target` is
  the authorization for that write, mirroring how `sk-packager` treats its `--output`. The
  parent repo neither tracks nor ignores it, so `/runtimes/` is only added to the source
  `.gitignore` when the target actually lands in `runtimes/`. `create` says so explicitly.
- Refused targets: the source repo itself, and any **ancestor** of it (a runtime that would swallow
  the repo).

## Creating a runtime

1. **Confirm root scope** when the runtime lands inside this repo — Rule 2 grants the repo root as
   free-write only at root scope. `sidekicks project current`; switch with
   `sidekicks project use sidekicks` if a user project is active. The engine prints a notice rather
   than blocking, and skips it entirely for an out-of-repo `--target`.

2. **Agree the skill set with the user — do not guess it.** Show what is available:

   ```sh
   node "$IH" skills
   ```

   Offloaded skills are eligible: inheriting one **activates it in the runtime** and leaves the
   source repo's archive untouched. That is the supported way to give a runtime a capability this
   repo has retired.

   Presets are dependency-closed as shipped — every preset plans with zero `MISSING DEP` (that
   includes `core`: `sk-skill-manager`'s own optional siblings, `skill-creator` and
   `sk-skill-auditor`, are declared in its manifest, not its frontmatter `depends-on`, so their
   absence from `core` is a stated degraded mode, never a `MISSING DEP` line). Three are
   worth naming. One set is **not** in any preset and is not meant to be: a `--as-core` forge also
   derives the skills its shipped agent packs declare (`--pack-skills declared|closure|none`,
   default `declared`), reported under its own heading in `plan`. Those travel because the core
   ships the packs, never because the floor grew — so a pack that starts needing another skill is
   picked up with no edit to `presets.yaml`, and `--pack-skills declared` deliberately stops at the
   declared rows, which is why a `MISSING DEP` line can appear against one of them. `framework` is the Sidekicks framework itself — every Category-1 skill from
   [docs/skill-modular-category.md](../../../docs/skill-modular-category.md) §1, plus only the two
   dependencies `sk-self-improve` declares — `skill-creator` and `sk-jira-connector`
   — and no other skill outside §1 (see the recipe below). `improvement` is the auditor/auto-improve → self-improve funnel,
   dead without `skill-creator` to apply the edit. `prod-access` is the Teleport skills — the
   **only** sanctioned route to a production database or cluster; `database` and the nonprod cluster
   skills hard-stop on a prod target and name the Teleport skill as the route, so a runtime that
   will ever see prod needs `--preset database,prod-access` or it points its agent at a skill it
   does not carry. `goal` is `delivery` plus the autonomous conductor (`sk-get-plan-done`) and the
   inseparable multi-CLI pair (`sk-cli-orchestrator` + `sk-cli-executor`) — **BMAD-free on purpose**:
   the skills in it treat BMAD as a detected capability (probe `framework check rule.bmad-first`
   plus the skill directory, then take a named fallback route), so the preset closes without the
   family. Compose `--preset goal,bmad` to get the lifecycle back.

3. **Plan first, always.** `plan` writes nothing and surfaces the two things that bite later —
   skills whose bundled scripts point at skills you did not select, and Python imports with no
   known distribution:

   ```sh
   node "$IH" plan --name sidekicks-minimal --preset core --skills sk-database-connector
   ```

   `plan` prints `<name>  NOT FOUND` for a member it cannot resolve and suppresses every other line
   for that member — the top of the ladder, and a mistyped `--skills`/`--delegates` name rather than a
   composition gap. `create` and `add` refuse such a name in pre-flight (exit 4), reporting every
   unresolvable name at once and leaving nothing behind ("Nothing was written."). For members that DO
   resolve, `plan` reports three tiers of composition gap, strongest first — relay them accordingly.
   A composition gap never changes the exit code; exit 2 still means a usage error.

   | Line | Confidence | What to do |
   |---|---|---|
   | `MISSING DEP (declared depends-on)` | **authoritative** — the skill's own frontmatter says it needs this | add it, or the depending skill fails at that step |
   | `wired to (not selected)` | strong — a bundled `scripts/` file names it in **code** | usually add it; check what the code does with it |
   | `named in script comments only` | weak — the name is in a comment/docstring | often bare provenance ("adapted from X"); judge it |

   Only `scripts/` counts as wired; a name in prose or an `assets/` catalogue is a `--verbose`
   mention, because a data file legitimately listing many skills is not a dependency. An
   `UNMAPPED` import means the venv will be incomplete until the module is added to
   `assets/module-distribution.json`.

4. **Create.** Pass `--remote` when the user has a repo URL ready:

   ```sh
   node "$IH" create --name sidekicks-minimal \
     --preset core --skills sk-database-connector \
     --remote https://github.com/utranand/sidekicks-minimal.git
   ```

   `create` refuses an existing target unless `--force` (which rebuilds it), records the location,
   and — only when the runtime lands in `runtimes/` — adds `/runtimes/` to the source `.gitignore`
   so the parent repo never tracks it. It **does not commit or push** — review the result, then
   commit inside the runtime.

5. **Verify, then report.** Never claim a runtime works without this:

   ```sh
   node "$IH" verify --name sidekicks-minimal
   cd runtimes/sidekicks-minimal && node bin/sidekicks index show --json
   ```

Useful flags: `--target <path>` (put the runtime anywhere — see above), `--no-venv` (write
`requirements.txt`, skip the install — offline), `--delegates a,b` / `--all-delegates` /
`--delegate-memory` / `--prune-delegates` (delegate agents — see below; **not** the same as
`--no-agents`, which drops the CLI-neutral `.agents/subagents/` definitions and every generated host port), `--no-agents` /
`--no-commands` (drop the
subagent/command sets), `--full-scripts` (copy every `scripts/` file and subdirectory
instead of only what the framework floor or a selected skill owns — `verify` then reports unowned
entries as informational), `--prune-skills` (see below).

### `--prune-skills` — make the skill set exact

`create` copies the skills you selected; it does **not** remove ones an earlier inherit left behind.
So a plain `create --force` re-forge yields *at least* your selection, never *exactly* it.
`--prune-skills` deletes every skill in the runtime that is not in the selection and drops its
manifest unit, so `create --force --prune-skills` is reproducible: same command, same skill set,
every time.

It is opt-in for a reason — a runtime legitimately grows skills that were never inherited (`drift`
classifies those `untracked` and never touches them), and an implicit prune would delete the
operator's own work. The **required floor is exempt**: a prune never removes one, so "exactly the
selection" means the selection plus those five. `plan` previews exactly what would go before
anything is written:

```sh
node "$IH" plan   --name N --preset framework --prune-skills   # lists what would be DELETED
node "$IH" create --name N --preset framework --force --prune-skills
```

`add` **refuses** the flag (exit 2): its selection names only the *new* skills, so pruning against
it would delete the rest of the runtime. Re-forge with `create` instead.

After a prune, the `framework sync --prune` that `create` already runs drops the enable-map keys
owned by the removed skills — so the runtime's `.sidekicks/config/framework.yaml` shrinks to match.

## Delegate agents — inherited by name, never in bulk

A runtime can carry the **named persistent agents** (`.sidekicks/agents/<name>/`, driven by the
`sidekicks agent` verbs — official name *delegate agents*). None travel unless you name them:

```sh
node "$IH" skills                                    # lists the available delegate agents too
node "$IH" plan   --name N --preset core --delegates briony,debby
node "$IH" create --name N --preset core --delegates briony,debby
node "$IH" add    --name N --delegates vera          # later, into an existing runtime
```

`--all-delegates` takes every agent the source carries. A preset can name agents too, through a
`delegates:` section in `assets/presets.yaml` (the flat list form still means "all skills"); the
shipped `delegate-crew` preset carries the agent-driving *skills* with an empty delegate list, so
compose `--preset core,delegate-crew --delegates <your crew>`.

**Per agent, only two things travel:**

| Surface | Travels? | Why |
|---|---|---|
| `agent.yaml` (charter) | yes | the agent |
| `routines/` | yes | its scheduled work |
| `memory/` | only with `--delegate-memory` | an agent's memory records the **source** repo's decisions — the same reason `.sidekicks/memory/` never travels. Some entries are behavioral ("always report in this shape") and worth carrying; most are not. Decide per runtime; the choice is recorded per agent in the manifest |
| `runtime/` | **never** | presence, control gate, mailbox, threads, PIDs — per-clone volatile state, git-ignored at the source too |
| `.bridge/` | **never** | the shared agent bridge. It holds the bridge token and the Telegram `bot_token`/`chat_id` — the same safety class as `.sidekicks/config.yaml` — plus PID files that would make the runtime believe another machine's daemons are alive. `verify` FAILS (exit 12) if a runtime contains one |

Nothing is lost by that: `lib/agent-lifecycle/` recreates `runtime/` and `.bridge/` in the runtime on
first use. The `sidekicks agent` verbs themselves ride in `lib/`, which travels whole, so inherited
agents are operable even with no `sk-agent-*` skill selected — `create` says so as a warning
rather than blocking, since the skills are the documentation layer, not the mechanism.

**Carrying an agent also claims the scripts that operate one.** These travel because the runtime has
agents, not because a skill declared them — a runtime can carry a crew before it carries the skills
that document them and must still be able to start and supervise it:

| Script | What it gives the runtime |
|---|---|
| `scripts/start-agent-delegate.sh` | one-command headless delegate runner (`agent start <a> --headless`) |
| `scripts/install-delegate-launchagent.sh`, `uninstall-…` | LaunchAgent so a delegate survives logout/reboot (`launchctl bootstrap` — a real system change, so run it deliberately) |
| `scripts/agent-tray.sh` | launcher for the menu-bar Agent Tray |
| `scripts/launchd/com.sidekicks.agent-{delegate,tray}.plist` | the `__REPO_ROOT__`/`__AGENT__` token templates the installers fill in |

Each **script** resolves its **own** root from its own location, so no script binds back to the source
repo, and the plist **templates** carry no absolute path — though the INSTALLED unit does:
`install-delegate-launchagent.sh` substitutes `__REPO_ROOT__` into `WorkingDirectory`,
`ProgramArguments` and both log paths. The LaunchAgent label, however, is
`com.sidekicks.<agent>-delegate` — per-user and root-agnostic. An inherited agent keeps its name, so
installing from a runtime REPLACES the source repo's unit for that same agent name (nothing warns you
— the plist is overwritten unconditionally, and the printed `plist:` path is `$HOME`-anchored,
identical from any root), and `uninstall-delegate-launchagent.sh --all` removes every root's units, not
just this runtime's. Check `launchctl print gui/$UID/com.sidekicks.<agent>-delegate` before installing,
or rename the agent in the runtime. `verify` FAILS when a runtime holds agents but not these scripts;
`add --name <n> --delegates <a>` re-registers the surface even when there is nothing new to inherit
(`patch` cannot — it syncs units, not the scripts surface).

Two are only *prepared*, not yet functional, until their skill arrives: `agent-tray.sh` execs
`sk-agent-tray/scripts/agent_tray.py`, and the tray plist points at the same file. Both fail
with a plain "no such file" until that skill is inherited — that is the intended staging, not a defect.

Two things to relay when they appear:

- A charter whose `default_work_dir` is set points at the **source** repo's layout (the runtime has no
  `projects/` at all). `plan` and `create` name the agent and the value; re-point or clear it in the
  runtime through `sidekicks agent`.
- Agents are **drift-tracked** exactly like skills, over the inherited surface only — so the
  `runtime/` state a live delegate writes never reads as a local edit. Charters are amended in place,
  so `local-only` and `CONFLICT` are the *normal* states here; `patch` holds both back and `--force`
  backs the runtime's copy up to `<runtime's resolved run base>/backups/<stamp>/agents/<name>/`
  first (same runs-layout-v2 resolution as a skill backup, above). A
  `patch` never touches the runtime's own `runtime/` state.
- `--prune-delegates` (create only, like `--prune-skills`) makes the agent set EXACTLY the selection,
  including deleting agents created in the runtime — `plan` previews what would go. `add` refuses it.

## Forging the Sidekicks framework runtime

The `framework` preset builds a runtime that is *the Sidekicks framework and nothing else*: it can
orient itself, drive every CLI verb, switch scope, validate config, record knowledge, audit /
improve / offload its own skills, and forge further runtimes — with no bmad, database, git or ops
skills, and no jira workflow beyond the `sk-jira-connector` the funnel's EXPORT stage
depends on.

Membership is dynamic: every active skill declaring `sidekicks.runtime-class: framework`, the
immutable required floor, and the transitive closure of frontmatter `depends-on` plus non-optional
runtime manifest siblings. Missing legacy metadata means `catalog-only`. A missing, offloaded,
private-only, or source-only dependency fails the plan; `skill_repo: none` is allowed only when the
dependency carries `license.txt`. The current approved closure is 18 skills: the 16 declared roots
plus `skill-creator` and `sk-jira-connector`, pulled by `sk-self-improve`.

`plan` prints deterministic `declared`, `required-floor`, and `dependency-of:<skill>` reasons, and
`create` stores the same reasons beside each skill unit in `.sidekicks/inherit.json`. Do not edit a
framework roster in `assets/presets.yaml`; its empty `framework:` entry is only the named-preset
sentinel. Classify the owning `SKILL.md` or fix the dependency edge.

**Use the publish script** to build or re-release this runtime — it wraps the whole sequence,
derives the version, and writes the release log:

```sh
node scripts/framework-core-publish.mjs status                 # does the core owe a release?
node scripts/framework-core-publish.mjs publish --dry-run      # show the forge + the log entry
node scripts/framework-core-publish.mjs publish --bump patch   # forge, stamp, verify, log
```

**There is no hand recipe to fall back on.** `inherit.mjs` now REFUSES `--as-core` without
`--core-version` (exit 2), because the default it used to take was the source `package.json`
version, which tracks the *repo* and not the core's own version line — package.json sat at `1.1.0`
against a distributed marker of `1.4.1`, so a hand forge silently downgraded every consumer's marker
by three minors and then hard-failed the next `publish` with exit 3. A hand forge also writes no
release log, and `publish` refuses to reconcile a marker someone stamped by hand.

The script is the supported path, and the only one. Full contract:
[docs/guide/v1.5/framework-as-submodule.md](../../../docs/guide/v1.5/framework-as-submodule.md) §
"Building and releasing a core", whose *The hand sequence (what publish runs)* block is the one
correct rendering of the underlying commands — read it there rather than re-deriving it here, so
there is a single copy to keep true. The script itself is not this skill's own surface — it rides
into the forged runtime because `sk-hello` claims it (`skill.manifest.yaml` →
`requires.framework_files`), not because `sk-inherit` does.

**The runtime is assembled with inert configuration templates, not live configuration.** `create`
and `add` run the runtime's own `sidekicks config sync`, which discovers every carried skill's
declared block and writes commented family-file templates under `.sidekicks/config/`. Commented,
git-ignored credential skeletons may accompany them, but source values and usable credentials never
travel. The templates keep resolving to each skill's defaults until the runtime owner explicitly
sets a value with `sidekicks config set`; do not report a connector as configured merely because its
template exists.

Nothing is committed or pushed by the engine. Registering the runtime as a submodule of the parent
repo is a separate, explicit step.

### `--as-core` — forge a runtime users can MOUNT

The `framework` preset turns on `--as-core`, which adds the files that make the forged runtime a
distributable **framework core**: a repo a user mounts as a git submodule at
`<workspace>/.sidekicks-core/` and updates with `sidekicks core update`. Pass `--as-core` to opt any
other selection in, `--no-as-core` to opt the framework preset out.

| Generated | Why |
|---|---|
| `.sidekicks-core.json` | The **mount marker**. Both root resolvers (`resolveRepoRoot`, from cwd; every hook, from its own file location) walk up looking for a `.sidekicks/` — and a mounted core has one. The marker is what makes them walk *past* it to the workspace. Without it, every hook reads the CORE's memory and settings instead of the workspace's. |
| `install.sh`, `install.ps1` | The one-line bootstrap: preflight git + Node ≥ 20, mount the submodule, then hand off to `sidekicks core init`. Idempotent — re-running updates. |
| `AGENTS.framework.md` | The generated `AGENTS.md` plus a mount preamble. A workspace's own `AGENTS.md` imports it through a managed block, so the framework's rules follow the pinned version while the workspace's own instructions stay untouched. (This is what AAP-106 asks for.) Named after `AGENTS.md` because that is the canonical instruction file (Rule 6); a core forged before the rename ships it as `CLAUDE.framework.md`, which every reader still accepts. |
| `README.md` | Install / update / uninstall, the honest scope of the push guard, and a **release delta** derived from the destination (below). Written last, once every file it describes is on disk. |

`--core-version <v>` stamps the marker (default: the source `package.json` version). `--core-ref <ref>`
sets the ref the generated install commands default to (default `main`).

**The README reports what the release changed, and it is derived — never prose.** A core is
regenerated wholesale, so the tree in the destination is the only record of the release being
replaced, and `--force` destroys it. The forge therefore **scans the destination before its first
write** (`snapshotCoreTree`), diffs it against the finished tree, and renders a
`## Changes in this release` section: previous version and source commit, an added/changed/removed
count per surface (`lib/`, per-skill, hooks, per-CLI wiring, instructions, installers, packaging),
and skills added or removed — a removal being the one that costs a consumer something at
`core update`. Same source twice reports **"No shipped file changed"**: every generated file carries
a forge timestamp and the source commit, so those bytes are masked before hashing (`maskVolatile`) —
version strings are deliberately not, because a version bump inside a shipped file is real news.

Two things follow from *derived*: nothing in the README may name a filename or surface a maintainer
has to remember to update, and no one hand-edits the table. The rule this replaced: the README named
`CLAUDE.md` as the workspace's instruction file for every release after Rule 6 made it a symlink to
`AGENTS.md`, and nothing in the pipeline could notice, because the name was prose.

**A core stays self-runnable.** `resolveRepoRoot` treats a marked core as a *last-resort* root, so a
standalone clone or a freshly forged core still runs its own CLI — which is how this engine self-heals
what it just built. Mounting it is what flips the answer to the workspace.

**Not generated:** a `.githooks/pre-push` refusing pushes. It would fire in a legitimate contributor
clone of the framework repo too, blocking the very people meant to push. The push guard belongs to the
mount, where "mounted" is distinguishable from "cloned" — `sidekicks core init` installs it into the
submodule's own git dir. Contract: [docs/guide/v1.5/framework-as-submodule.md](../../../docs/guide/v1.5/framework-as-submodule.md).

## Keeping a runtime current

After skills change in the source repo, `drift` answers what the runtime should be patched to.
Every inherited skill — and every inherited delegate agent, reported in its own table — is compared
three ways: source now, runtime now, and the **baseline hashes recorded at inherit time**, because a
bare source↔runtime diff cannot tell "the source moved" from "the runtime was edited".

```sh
node "$IH" drift --name sidekicks-minimal          # add --json for a machine-readable report
node "$IH" patch --name sidekicks-minimal --dry-run
node "$IH" patch --name sidekicks-minimal
```

| Status | Meaning | `patch` behavior |
|---|---|---|
| `up to date` | all three agree | skipped |
| `FF` | source moved, runtime untouched | **applied** |
| `local-only` | runtime edited, nothing upstream | held back |
| `CONFLICT` | both sides changed | held back |
| `MISSING IN SOURCE` | skill gone from the source repo | held back |
| `MISSING IN RUNTIME` | in the manifest, deleted from the runtime | held back (restore with `--force`) |
| `untracked` | in the runtime, never inherited | never touched |

`patch` applies fast-forwards only. `drift` and a `patch` that held anything back both exit `10`.

**Overriding is the user's call, not yours.** `--force` also overwrites `local-only` and `CONFLICT`
skills, backing the runtime's copy up to `<runtime's resolved run base>/backups/<timestamp>/<skill>/`
first (see the runs-layout-v2 note above; the report's `patched:` line names the exact path). Present
the conflict and the local edits, then let the user decide. Scope a targeted update with `--only a,b`.

## Python: a fresh venv, never a copied one

The source `.venv` is ~514 MB and **not relocatable** — dozens of files in `.venv/bin` hardcode the
source interpreter's absolute path in their shebangs, so a copied venv is a broken venv. Instead the
engine scans the selected skills' `.py` files for imports, drops stdlib and skill-local modules, maps
what remains through `assets/module-distribution.json`, and pins each distribution to the version
`pip freeze` reports in the source venv. A `core` + database runtime lands around 20 MB.

Two behaviors reported on a **successful** build (exit `0`) — relay them accurately, but neither
one is what exit `11` means:

- **`UNMAPPED` import** — no distribution is known for it, so it is reported rather than silently
  dropped. Add it to `assets/module-distribution.json` (key = import name, value = PyPI
  distribution; `null` means "deliberately not a dependency") and re-run `venv`.
- **`UNPINNED …`** — the source venv holds a version PyPI does not serve. Because pip resolves a
  requirements file as a unit, one such pin would fail every package, so the engine relaxes *only*
  the unsatisfiable pins and retries. The runtime then has a **different version** than the source
  repo. Say so; do not report it as a clean pinned build.

Exit `11` itself has four real causes — recover per cause:

- **no python on PATH** — install Python 3, then re-run `node "$IH" venv --name N`
  (`requirements.txt` was already written, so nothing is lost).
- **`python -m venv` failed, or venv created but pip is missing** — rebuild from scratch with
  `node "$IH" venv --name N --rebuild` (`rmSync`s the stale `.venv` before rebuilding).
- **pip install failed (often offline or proxied)** — check connectivity and retry `venv`, or use
  `--no-venv` to write `requirements.txt` and defer the install.

## What travels and what never does

**A skill travels as a RUNTIME PROJECTION, not as its folder.** Each selected skill's top-level
`improvements/`, `evals/` and `tests/` stay behind: they are the improvement funnel's evidence,
trigger fixtures and a harness the forged core's own test runner never discovers (it looks in root
`tests/` and `lib/*/tests`). The canonical `.agents/skills/` tree keeps all of it — projection
changes only forged copies. Matching is on the FIRST path segment, so a legitimate runtime fixture
at `assets/tests/case.json` still travels; a bare segment matched at any depth is what once ate 41
subagents and four skills' own `agents/` folders.

The copied `skill.manifest.yaml` and `VERSION.json` are REGENERATED so their `bundle`, `modes` and
`files` describe exactly what was carried — otherwise a shipped core would name files it does not
have, and `skill verify` inside it would fail. The drift comparison hashes the source side through
the same projection, which is why a re-forge is clean and an edit confined to excluded evidence is
not a source change a runtime can fast-forward to.

A skill that genuinely needs a runtime path under one of those directories declares a reviewed
exception in its own manifest, and a protected path (`SKILL.md`, the manifest, `VERSION.json`, a
declared entrypoint, a rule body, config defaults) that the projection would drop is a hard error
naming the field that wanted it:

```yaml
distribution:
  runtime:
    exclude: []                                   # withhold something else from the runtime
    include: [tests/fixtures/runtime-case.json]   # restore one path a default exclusion removed
```

`plan --json` reports copied and excluded files and bytes per skill and in total. Forging a CORE
additionally requires every selected skill to have a complete `skill.manifest.yaml`: a projection
needs a baseline that says which files were left out on purpose, and a directory walk cannot tell
that apart from a file gone missing. Ordinary runtimes keep the walk fallback.

Copied: the selected skills (projected as above), `bin/`, all of `lib/` (whole — the CLI dispatcher lazy-imports by
string template, so a partial `lib/` dies on its first unanalyzed verb), the **owned** part of
`scripts/` (AAP-111: framework-floor hook scripts, scripts a `CORE_HOOKS` owner or a selected
skill's manifest claims, `scripts/lib/` always — unowned files stay behind and their hook wiring is
pruned from all four per-CLI configs), `.sidekicks/RULES.md`, `.sidekicks/hooks/`,
`config.example.yaml`, **`config/framework.yaml` + `config/framework.example.yaml`** (the enable
map), the
per-CLI wiring for Rule 6 parity, the neutral `.agents/subagents/` source with its generated
Claude/Codex/Gemini/Antigravity ports, and the host command stubs.

`add` re-registers the scripts surface for the grown skill set: the new skill's owned scripts come
back into `scripts/`, and the four hook-wiring configs are refreshed verbatim from the source, then
re-pruned. Those four configs are inherited surface — runtime-local edits to them are overwritten
by `add`.

Because that gate decides what a consumer ever sees, adding, moving or deleting a repo-root script
is governed by this skill's framework rule **`rule.repo-root-scripts-lifecycle`**
(`rules/rule.repo-root-scripts-lifecycle.md`, or `sidekicks framework show
rule.repo-root-scripts-lifecycle`): declare the owner in the same change, prefer the skill's own
folder, park only unclaimed scripts in `scripts/legacy/`, and remove a claim and its four-CLI wiring
together.

**Never copied — this list is a safety boundary, not an optimization:** `.env`,
`.sidekicks/config.yaml` (credentials), `settings.local.json`, `running-agents.json`, `projects/`,
`artifacts/`, `.git`, `.venv`, `node_modules`, **`.sidekicks/memory/`**, and
**`.sidekicks/agents/.bridge/`** (bridge token, Telegram credentials, PIDs — `verify` fails on it).
A runtime starts with an empty memory store on purpose: the source repo's memory describes a
different codebase, and inheriting it would feed another project's decisions to the runtime's agent as
SessionStart context. `.sidekicks/agents/` is likewise never copied *wholesale* — a delegate agent
travels only when named, surface by surface (see *Delegate agents* above).

Generated fresh per runtime: a **minimal `AGENTS.md`** (the boundary rules restated for a
project-less root scope, plus a table of only the skills present), `CLAUDE.md`/`GEMINI.md` mirrors,
`.gitignore`, `package.json`, `requirements.txt`, an empty memory store, and
`.sidekicks/inherit.json` — the manifest holding the baseline hashes. Hook entries in
`.claude/settings.json` whose script did not travel are pruned so the runtime has no dangling hooks.

`AGENTS.md` is **regenerated on every `add` and `patch`** — hand edits to it are lost. Runtime-
specific instructions belong in `AGENTS.local.md`, referenced from `AGENTS.md` by an
`@AGENTS.local.md` line. The reference is the load-bearing half: every CLI sees it, because
`CLAUDE.md`/`GEMINI.md` mirror `AGENTS.md` (Rule 6), whereas a `CLAUDE.local.md` is auto-loaded by
Claude Code and by nothing else.

### The framework enable map travels, then is re-synced

`.sidekicks/config/framework.yaml` is copied, not regenerated: without it every rule, criterion and hook
would resolve to the built-in default, so anything the source deliberately **disabled** would come
back on in the runtime, silently. `create` and `add` then run the runtime's OWN
`sidekicks framework sync --prune`, which re-materialises the map against the runtime's smaller
registry:

- keys owned by skills that **did** travel keep their recorded value — a `false` stays `false`;
- keys owned by skills that **did not** travel are pruned (re-inheriting that skill later re-adds
  the id at the built-in default, enabled — the source's `false` does not come back with it);
- entries the runtime has but the copied file lacked are added, so the map stays complete.

`verify` fails (exit 12) when the map is missing or out of sync. Fix it in the runtime with
`node bin/sidekicks framework sync --prune`, never by hand (Rule 1). Contract:
[docs/guide/framework-settings.md](../../../docs/guide/framework-settings.md).

### Configuration templates are generated from carried skills

The copied enable map is **settings**; configuration values are a separate concern. After `create`
and after `add`, the runtime runs `node bin/sidekicks config sync` against itself. It generates only
the families and blocks its inherited skills declare, keeping each block commented so the skill's
bundled defaults remain effective. `verify` runs `config sync --check` and fails if a declared block
is absent. To repair a runtime manually, run `node bin/sidekicks config sync` from its root; never
copy `.sidekicks/config/` from the source repository.

## Reference

Read [references/runtime-anatomy.md](references/runtime-anatomy.md) for the full layout, the
manifest schema, the drift algorithm, and how to add a new inheritable surface.
