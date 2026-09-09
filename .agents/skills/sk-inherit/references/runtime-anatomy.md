# Runtime anatomy

Reference for `sk-inherit`. Read this when changing what a runtime carries, debugging a
drift result, or adding a new inheritable surface.

## Contents

- [Where a runtime lives](#where-a-runtime-lives)
- [Layout of a forged runtime](#layout-of-a-forged-runtime)
- [Surface classification](#surface-classification)
- [Delegate agents](#delegate-agents)
- [Why copies and not links](#why-copies-and-not-links)
- [The manifest](#the-manifest)
- [The drift algorithm](#the-drift-algorithm)
- [Python venv resolution](#python-venv-resolution)
- [The generated AGENTS.md](#the-generated-agentsmd)
- [Adding a new inheritable surface](#adding-a-new-inheritable-surface)
- [Failure modes worth recognizing](#failure-modes-worth-recognizing)

## Where a runtime lives

The default is `runtimes/<name>/`. `--target` overrides it with any absolute path, any path relative
to the **repo root** (not the cwd), or a directory outside the repo entirely.

Because a runtime can be anywhere, the source repo keeps a registry so later verbs do not need the
path repeated:

```
artifacts/runs/inherit/runtimes.json      # run state, git-ignored, never in .sidekicks/ (Rule 1)
{
  "schema": 1,
  "runtimes": {
    "sidekicks-minimal": { "path_rel": "runtimes/sidekicks-minimal", "outside_repo": false, "registered_at": "…" },
    "edge-rt":           { "path_rel": "../sk-runtimes/edge-rt",     "outside_repo": true,  "registered_at": "…" }
  }
}
```

`path_rel` is always **relative to the repo root**, including the `../..` form for an out-of-tree
target — the portable-paths rule forbids persisting a machine-absolute path into an artifact.

Resolution precedence in `resolveRuntime()`:

1. explicit `--target`
2. the registered location for that name
3. the default `runtimes/<name>/`

`create` registers the location. Every verb that requires a manifest (`add`, `drift`, `patch`,
`venv`, `verify`) calls `adoptIfTargeted()`, so an explicit `--target` also *moves or adopts* the
registration — passing it once is enough, from any entry point. Adoption is idempotent and only
happens for a confirmed runtime, so a typo'd path cannot register garbage.

`cmdList()` shows the union of the registry and a scan of `runtimes/`, so a runtime created before
the registry existed, or made by hand, is still listed (`known via runtimes/`). An entry whose
directory has vanished is reported `MISSING`; `forget` drops it without touching any files.

Two location guards, both in `resolveRuntime()`:

| Refused target | Why |
|---|---|
| the source repo itself | a runtime cannot be its own source |
| any **ancestor** of the source repo (e.g. `--target ..`) | the runtime would contain the repo it inherits from |

Placing a runtime outside the repo puts the write outside the Rule 2 free-write surface. Passing
`--target` is the operator's authorization, the same contract `sk-packager` uses for its
`--output`; `create` states plainly that the target is outside and that the parent repo neither
tracks nor ignores it. `/runtimes/` is added to the source `.gitignore` only when the resolved
target actually lands inside `runtimes/` — keyed on the real path, not on whether `--target` was
passed, so an explicit `--target runtimes/foo` still gets the ignore rule.

## Layout of a forged runtime

```
runtimes/<name>/
├── bin/sidekicks                 copy — the CLI entry point
├── lib/                          copy, WHOLE (see below)
├── scripts/                      copy by OWNERSHIP — floor hooks + files a selected skill claims;
│                                 scripts/lib/ always; subdirs only when a skill owns one (AAP-111)
├── .githooks/pre-commit          copy — scripts/install-hooks.mjs points core.hooksPath here
├── .sidekicks/
│   ├── skills/<selected>/        copy — one directory per inherited skill
│   ├── hooks/                    copy
│   ├── RULES.md                  copy — canonical boundary contract
│   ├── config.example.yaml       copy — seed for the legacy git-ignored config.yaml
│   ├── config/framework.yaml     copy, then re-synced with `framework sync --prune` in the runtime
│   ├── config/framework.example.yaml  copy — documented template for the enable map
│   ├── config/<family>.yaml      GENERATED — inert blocks declared by inherited skills
│   ├── config/<family>.secret.yaml GENERATED when defaults expose credential fields; git-ignored,
│   │                                  commented skeletons only
│   ├── settings.json             GENERATED — root scope, no active project
│   ├── memory/MEMORY.md          GENERATED — empty store
│   └── inherit.json              GENERATED — the baseline manifest
├── .claude/
│   ├── agents/, commands/        copy (drop with --no-agents / --no-commands)
│   ├── settings.json             copy, then hook entries with missing scripts are pruned (all four
│   │                             per-CLI configs get the same prune — Rule 6)
│   └── skills -> ../.agents/skills   internal link, self-healed by the runtime's own CLI
├── .codex/, .gemini/, .agent/, .agents/ copy — per-CLI wiring for Rule 6 parity
├── .venv/                        BUILT FRESH — never copied
├── AGENTS.md                     GENERATED — minimal, regenerated on add/patch
├── CLAUDE.md, GEMINI.md          internal symlinks to AGENTS.md (copies on Windows w/o privilege)
├── requirements.txt              GENERATED — pinned from the source venv
├── package.json, .gitignore      GENERATED
└── .git/                         git init, origin set from --remote; nothing committed
```

With `--as-core` (on by default for `--preset framework`) five more files are generated, turning the
runtime into a mountable framework core:

```
├── .sidekicks-core.json          GENERATED — the mount marker (see below)
├── install.sh, install.ps1       GENERATED — the curl/irm bootstrap
├── AGENTS.framework.md           GENERATED — AGENTS.md + a mount preamble; what a workspace imports
└── README.md                     GENERATED — install / update / uninstall + the release delta
```

`README.md` is written **last**, after the hook prune, the manifest and the index rebuild, because its
`## Changes in this release` table is derived by diffing the destination as it was *before* the forge
(snapshotted at the very first step) against the finished tree. Rendering it any earlier reports those
final steps as changes on every release.

**The marker is the load-bearing one.** A mounted core sits at `<workspace>/.sidekicks-core/` and
carries its own `.sidekicks/`, so both root resolvers would stop there — the CLI's (walking up from
cwd) and every hook's (walking up from its own file location). The marker makes them walk past it, and
`resolveRepoRoot` treats a marked core as a **last-resort** root so a standalone clone still runs. That
last-resort tier is not cosmetic: without it this engine cannot self-heal the core it just forged
(`refreshRuntimeIndex` and `syncRuntimeFramework` both shell out to the runtime's own CLI).

`verify` checks the distribution when the marker is present: marker parses with a schema and version,
all five files exist, and `install.sh` has no unsubstituted `{{PLACEHOLDER}}`.

`lib/` is copied **whole** deliberately. The CLI dispatcher lazy-imports by string template
(`../${namespace}-lifecycle/${verb}.mjs`), which static import-closure analysis cannot resolve — a
documented blind spot in `lib/package-lifecycle/closure.mjs`. A partial `lib/` produces a CLI that
works until the first unanalyzed verb, then dies. At ~1.9 MB the whole tree is not worth trimming.

## Surface classification

Three categories, defined at the top of `scripts/inherit.mjs`:

| Constant | Contents | Notes |
|---|---|---|
| `CORE_SURFACES` | `bin`, `lib`, `.githooks`, `.sidekicks/RULES.md`, `.sidekicks/hooks`, `config.example.yaml`, `config/framework.yaml`, `config/framework.example.yaml` (plus their pre-migration top-level paths) | always copied; `.sidekicks/config/` itself is **not** a copy surface — source values stay behind. `create`/`add` then run the runtime's `config sync` to generate inert templates only. |
| `OPTIONAL_SURFACES` | `.agents/subagents`, `.claude/agents`, `.codex/agents`, `.gemini/agents`, `.agents/plugins`, `.claude/commands`, `.gemini/commands` | the neutral subagent source and all host ports are dropped together by `--no-agents`; command ports by `--no-commands` |
| `CLI_WIRING` | `.claude/settings.json`, `.codex/config.toml`, `.gemini/settings.json`, `.agent/settings.json` | Rule 6 hook parity; missing entries skipped silently |
| `SCRIPT_SUBDIR_OWNERS` | maps a `scripts/` subdirectory to the skills that need it | `--full-scripts` copies all |
| `SCRIPT_SUBDIR_FLOOR` | `scripts/` subdirs that ALWAYS travel (`lib` — hook-gate.mjs) | without it runtime hooks cannot be gated |
| `DENY` | never copied, at any depth | the safety boundary — see below |
| `DENY_PATTERNS` | path-segment patterns never copied (`*.log`) | build residue; NOT bypassed by `--full-scripts` |
| `DENY_EXCEPTIONS` | paths whose basename is in `DENY` but which are wanted | e.g. `.claude/settings.json` |

Top-level `scripts/` **files** travel by ownership (`resolveScriptOwnership`, AAP-111): a file is
copied only when (a) it is a `CORE_HOOKS` script with `owners: []` (framework floor), (b) a
`CORE_HOOKS` script whose owners intersect the selection, or (c) a selected skill's manifest claims
it (`requires.framework_files` / `framework_hooks`, aggregated by `lib/skill-package/closure.mjs`).
When subagents travel, `generate-subagent-ports.mjs` travels with their neutral source as its
deterministic maintenance command.
Unowned files — orphan hook scripts, demo/personal helpers — stay behind, and the hook wiring that
referenced them is pruned from all four per-CLI configs. `--full-scripts` bypasses the ownership
gate (never `DENY`/`DENY_PATTERNS`); `verify` then reports unowned entries as informational instead
of failing. `add` re-runs the ownership copy for the full tracked set and refreshes the four wiring
configs from source, so a later-installed skill registers its scripts back into `scripts/`.

`DENY` is matched against **every path segment**, so `memory` blocks `.sidekicks/memory/` wherever
it appears. It covers three distinct risks:

1. **Secrets** — `.env`, `.sidekicks/config.yaml`, `settings.local.json`.
2. **Machine-local state** — `running-agents.json`, `index.json`, `scheduled_tasks.lock`, `.venv`,
   `node_modules`, `.git`.
3. **Another project's context** — `projects/`, `artifacts/`, and `.sidekicks/memory/`. A runtime
   inheriting the source repo's memory would feed a different codebase's decisions to its agent as
   SessionStart context. This was an observed failure, not a hypothetical.

`agents` and `.bridge` are both in `DENY`, which is what stops `.sidekicks/agents/` from being swept
in as a directory. A **selected** delegate agent is copied surface by surface instead
(`inheritDelegates`), a path `DENY` never walks — see below.

## Delegate agents

The named persistent agents at `.sidekicks/agents/<name>/`. They are a **second unit kind**, selected
independently of skills (`--delegates a,b`, `--all-delegates`, or a preset's `delegates:` section) and
tracked in the manifest under `agents/<name>` with `kind: "agent"`.

| Constant (`scripts/inherit.mjs`) | Meaning |
|---|---|
| `DELEGATE_SURFACES` | what travels per agent: `agent.yaml`, `routines/` |
| `DELEGATE_MEMORY_DIR` | `memory` — travels only under `--delegate-memory`, recorded per unit as `include_memory` |
| `BRIDGE_DIRNAME` | `.bridge` — never travels; `cmdVerify` check 10 fails (exit 12) if present |
| `DELEGATE_SKILL_RE` | `/^sidekicks-agent-/` — a selection with agents but no such skill gets a warning, not a refusal (the `sidekicks agent` verbs live in `lib/`, which travels whole) |
| `DELEGATE_SCRIPT_FILES` / `DELEGATE_SCRIPT_SUBDIRS` | the operating surface claimed by carrying agents: `start-agent-delegate.sh`, `install-/uninstall-delegate-launchagent.sh`, `agent-tray.sh`, `launchd/` |

**Script ownership has a third source because of this.** Alongside `CORE_HOOKS` (framework floor) and
the skill closure, `resolveScriptOwnership(repoRoot, skillNames, { hasDelegates })` claims the
delegate operating surface when the runtime carries agents. That inverts the usual rule deliberately:
those scripts are the operating surface of an *agent*, not of a skill, and "skills arrive later" is a
normal staging order. Consequences:

- `create` passes `hasDelegates: delegates.length > 0`; `add` uses `trackedDelegates(manifest)`;
  `verify` uses tracked ∪ physically-present agents, so an agent created inside the runtime justifies
  the scripts too.
- Only scripts that **exist in the source** are claimed, so retiring one upstream does not turn every
  later `verify` into a failure over a phantom claim.
- `verify` check 10 fails when agents are present and the scripts are not. `patch` cannot repair that
  (it syncs units), so `add` falls through to re-register the surface when nothing is fresh and the
  claim is unsatisfied — the one case where a no-op `add` still writes.
- `agent-tray.sh` and the tray plist both exec `sk-agent-tray/scripts/agent_tray.py`, which
  only arrives with that skill. The launcher is *prepared*, not functional, until then.

Three decisions worth keeping straight:

1. **The flag is `--delegates`, not `--agents`.** `--no-agents` already means "drop
   `.agents/subagents/` and its generated host ports", the *subagent* definitions. Two different surfaces, so two different words —
   the official names are *delegate agents* vs *subagents*.
2. **`runtime/` is never copied and never compared.** A live delegate writes presence, control gate,
   mailbox and threads there. `hashDelegateSurface()` therefore hashes only the inherited surface, on
   **both** sides of the comparison — using `hashTree(agentDir)` would report every agent as
   `local-only` the moment the runtime's own daemon ticked once. `applyDelegatePatch` replaces the
   inherited surfaces one by one for the same reason: an `rm -rf` of the agent directory would kill a
   running delegate's state.
3. **`.bridge/` is a credential boundary, not an optimization.** It holds the bridge token and the
   Telegram `bot_token`/`chat_id`, plus PID files that would make the runtime believe another
   machine's daemons are alive. `lib/agent-lifecycle/_bridge.mjs` `mkdirp`s it on demand, so its
   presence in a runtime can only mean it was copied — hence a hard `verify` failure rather than a
   warning.

`--prune-delegates` mirrors `--prune-skills` exactly, including deleting agents that were created in
the runtime (`untracked`) — which is why both are opt-in and `plan` previews the list. `add` refuses
both flags: its selection names only the new units.

## Why copies and not links

Linking is cheaper and was tried first. It fails for a specific, non-obvious reason.

The CLI resolves the repo root from `process.cwd()`, so a linked `bin/` would in fact be safe. But
**hook scripts** resolve it from `dirname(fileURLToPath(import.meta.url))`, and Node resolves a
symlinked module to its **realpath**. A linked `scripts/` therefore makes every hook compute the
*source* repo as its root. The observable symptom: a runtime with a completely empty
`.sidekicks/memory/` emitted the source repo's entire memory store as SessionStart context.

Once `scripts/` must be a real copy, a mixed link/copy design carries the same failure risk for any
surface later moved between the two categories, with no benefit — the non-venv surfaces total under
25 MB. So: everything is a copy, and `verify` asserts that no link inside the runtime resolves
outside it.

## The manifest

`.sidekicks/inherit.json` in the runtime. It exists to make **"who changed what"** answerable.

```json
{
  "schema": 1,
  "runtime": "sidekicks-minimal",
  "direction": "one-way: sidekicks source -> this runtime",
  "source": {
    "repo": "sidekicks",
    "commit": "b077dd6",
    "inherited_at": "2026-08-07T01:05:12+07:00",
    "tool": "sk-inherit",
    "last_patch_commit": "c91af02",
    "last_patch_at": "2026-08-07T09:41:00+07:00"
  },
  "units": {
    "skills/sk-hello": {
      "kind": "skill",
      "origin": "active",
      "version": "1.4.0",
      "source_path": ".agents/skills/sk-hello",
      "source_commit": "b077dd6",
      "inherited_at": "2026-08-07T01:05:12+07:00",
      "files": { "SKILL.md": "<sha256>", "scripts/readiness.mjs": "<sha256>" }
    },
    "agents/briony": {
      "kind": "agent",
      "source_path": ".sidekicks/agents/briony",
      "source_commit": "b077dd6",
      "inherited_at": "2026-08-07T01:05:12+07:00",
      "include_memory": false,
      "files": { "agent.yaml": "<sha256>", "routines/routines.yaml": "<sha256>" }
    }
  }
}
```

- `origin` records whether the skill came from `.agents/skills/` or `.sidekicks/skill-offloaded/`.
- `kind` selects the unit type: `skill` (`skills/<name>`) or `agent` (`agents/<name>`, a delegate
  agent). `include_memory` records whether `memory/` travelled, because the drift baseline covers
  whichever surface actually did — a later run must not have to guess.
- `files` is the **baseline**: the hash of every file at the moment it was inherited.
- `source_path` is **repo-relative**. No machine-absolute path may be persisted (portable-paths
  rule); `verify` checks for `/Users/…` and `C:\…` in the manifest.
- All timestamps are Asia/Bangkok with an explicit `+07:00` offset.

Hashes are **line-ending normalized**: text files are converted to LF before hashing, binaries (a
NUL byte in the first 8 KB) are hashed raw. Without this, a Windows checkout materializing CRLF
would report every inherited file as locally modified.

**The manifest describes what was inherited, not what the runtime holds.** A skill can be in the
runtime without a unit (added there by hand — `drift` calls it `untracked`), and `create --force`
re-copies only the current selection, leaving earlier skills in place with their units intact. The
skill set is exact only under `--prune-skills`, which deletes the unselected directories *and* their
`skills/<name>` units in one pass — dropping the directory alone would leave the unit behind and
`drift` would report it `MISSING IN RUNTIME` forever. `add` refuses the flag: its selection names
only the new skills, so pruning against it would delete the rest of the runtime.

**The required floor is outside all of that.** The `required:` block of `assets/presets.yaml` is
unioned into every selection, `unselectedSkills()` filters its members out so no prune can reach
them, and their absence is judged from disk rather than from the manifest — a runtime forged before
the floor existed has no unit to classify, which is exactly the case that has to be caught.

## The drift algorithm

For each `skills/<name>` and `agents/<name>` unit, three hash trees are compared (for an agent, over
the inherited surface only — `hashDelegateSurface`, see [Delegate agents](#delegate-agents)):

- **B** — baseline, from the manifest
- **S** — the source skill directory now
- **R** — the runtime skill directory now

| Condition | Status | Patchable |
|---|---|---|
| `S == B` and `R == B` | `up-to-date` | n/a |
| `S != B` and `R == B` | `ff` | yes |
| `S == B` and `R != B` | `local-only` | only with `--force` |
| `S != B` and `R != B` | `conflict` | only with `--force` |
| source directory absent | `missing-source` | no |
| runtime directory absent | `missing-runtime` | only with `--force` |
| runtime directory absent, and the skill is in `required:` | `missing-required` | yes, no `--force` |
| in the runtime, not in the manifest | `untracked` | never |

`missing-required` outranks `missing-runtime` for a floor skill, tracked or not, and patches like a
clean fast-forward: there is no runtime-side work to protect (the directory is gone) and the floor is
not the operator's to opt out of, so demanding `--force` would only stand between a broken runtime
and its repair.

The baseline is what makes this a real classification rather than a guess. A two-way source↔runtime
diff cannot distinguish an upstream change from a local edit, so it must either clobber local work
or refuse everything.

`patch` applies `ff` unconditionally. For `local-only` and `conflict` under `--force`, the runtime's
copy is first copied to `artifacts/runs/inherit/backups/<stamp>/<skill>/` and the backup path is
reported runtime-relative. Version numbers in the report come from each skill's `VERSION.json` and
are a **label**, not the comparison key — hashes decide. A skill whose content changed without a
version bump is still detected.

## Python venv resolution

`resolveRequirements()` runs this pipeline:

1. Walk the selected skills for `.py` files; collect top-level imports with a line regex over
   `import X` / `from X import`.
2. Collect **local** names: every `.py` basename and every directory containing `__init__.py` inside
   those skills. This is what keeps skill-internal helpers (`scope`, `common`, `flowlib`,
   `config_loader`) out of the requirements.
3. Drop stdlib names, taken from the live interpreter's `sys.stdlib_module_names` and falling back to
   `assets/py-stdlib.json` on Python < 3.10. The bundled list includes modules removed by 3.13
   (`distutils`, `imp`, `telnetlib`, …) so an older interpreter does not produce false `UNMAPPED`.
4. Map the remainder through `assets/module-distribution.json`. A missing key is reported as
   `UNMAPPED`; an explicit `null` value means "deliberately not a dependency" and is silent.
5. Pin each distribution to the version `pip freeze` reports in the **source** venv, matching on the
   normalized name (lowercase, `[-_.]+` → `-`) so `ImageIO` matches `imageio`.

`buildVenv()` then writes `requirements.txt`, runs `python -m venv`, and `pip install -r`. Two
behaviors matter:

- **Idempotence.** If `requirements.txt` is unchanged and the venv has a working `pip`, the install
  is skipped. `pip install` is the slowest step and `patch` would otherwise re-run it every time.
  `--rebuild` forces a full recreate.
- **Pin relaxation.** pip resolves a requirements file as a unit, so a single unsatisfiable pin fails
  every package. When that happens the engine parses the unsatisfiable names out of pip's error,
  relaxes **only those** to name-only, records them in a `# UNPINNED` comment in
  `requirements.txt`, and retries (up to 5 rounds). The result is reported explicitly, because the
  runtime then has a different version than the source repo. This is not rare: a source venv can
  hold local, pre-release, or withdrawn builds that PyPI does not serve.

The scan is a regex, not a full parse: a conditional or function-local import is still caught (the
regex is not anchored to the top of the file), but a fully dynamic `importlib.import_module(name)`
built from a variable is not. Verify a media/ML-heavy runtime by importing in its venv.

## The generated AGENTS.md

Rendered from `assets/AGENTS.min.md.tmpl` by `{{PLACEHOLDER}}` substitution. Placeholders:
`RUNTIME_NAME`, `GENERATED_AT`, `SOURCE_COMMIT`, `SKILL_COUNT`, `SKILL_TABLE`, `DELEGATE_SECTION`,
`PYTHON_SECTION`.

The skill table's descriptions are extracted from each inherited skill's frontmatter `description`,
flattened to one sentence, capped at 170 characters, with `|` escaped so the markdown table survives.

The template deliberately **restates** Rules 1–2 rather than copying them from `RULES.md`: a runtime
has no `projects/` tree, so the source wording ("root project active → repo root, excluding
`.sidekicks/` and `projects/`") describes a scope that does not exist there yet. Rules 3–6 are
verbatim. It also carries the rules a lean runtime still needs — protected branches, Asia/Bangkok
timestamps, portable paths, the venv rule, evidence-before-claims, and local-only memory.

Regenerated on `create`, `add`, and `patch`. Hand edits are lost; `AGENTS.local.md`, referenced from
`AGENTS.md` by an `@AGENTS.local.md` line, is the escape hatch — named after `AGENTS.md` so every CLI
reaches it through the mirrors (Rule 6), not just the one that auto-loads `CLAUDE.local.md`.

## Adding a new inheritable surface

1. Add the repo-relative path to `CORE_SURFACES`, `OPTIONAL_SURFACES`, or `CLI_WIRING` in
   `scripts/inherit.mjs`.
2. If it contains machine-local state or secrets, add the basename to `DENY` — and if a wanted path
   collides with a denied basename, add the exact relative path to `DENY_EXCEPTIONS`.
3. If it is a `scripts/` subdirectory needed by specific skills only, add it to
   `SCRIPT_SUBDIR_OWNERS` instead of copying it unconditionally.
4. A new top-level `scripts/` FILE must be CLAIMED or it will not travel (AAP-111): register it as
   a `CORE_HOOKS` entry (hook scripts), or declare it in the owning skill's `skill.manifest.yaml`
   under `requires.framework_files` (with a `degraded:` line). An unclaimed file is exactly what
   the ownership gate exists to keep out of a distribution.
5. Re-run `plan` (it prints the surface list) and `verify` on a rebuilt runtime.

A surface that describes the SOURCE's registry (as `config/framework.yaml` does) needs one more step:
reconcile it against the runtime after the copy, the way `syncRuntimeFramework()` runs the
runtime's own `framework sync --prune` at the end of `create`/`add`, and `verify` re-checks with
`framework sync --check`. Copying such a file untouched leaves it describing skills the runtime
does not have.

Adding a surface does **not** make it drift-tracked. `skills/<name>` **and** `agents/<name>` units
carry baseline hashes — `delegateUnitRecord` records `files: hashDelegateSurface(...)` for its
`kind: "agent"` units — while core substrate is refreshed wholesale by `create --force`. If a core
surface needs per-file drift tracking, extend `manifest.units` with a new `kind` and give it its own
classifier alongside `classifySkills`, the way `classifyDelegates` already does for agents.

## Failure modes worth recognizing

| Symptom | Cause |
|---|---|
| `is an inherited RUNTIME, not the sidekicks source repo` | run from inside a runtime; sync is one-way — run from the source root |
| `contains the sidekicks source repo` | `--target` named an ancestor of the repo |
| `list` shows `MISSING` | the registered directory is gone — `forget` the entry, or re-adopt with `--target` |
| `does not look like a sidekicks source repo` | anchored on a directory with `.sidekicks/` but no `lib/sk-cli/` |
| `NOT FOUND` in `plan` | the named skill or agent does not exist in the source — a mistyped `--skills`/`--delegates` name; it suppresses every other line for that member, and `create`/`add` refuse it in pre-flight (exit 4) with nothing written |
| `MISSING DEP (declared depends-on)` in `plan` | the skill's SKILL.md frontmatter declares a skill you did not select — authoritative, add it |
| `wired to (not selected)` in `plan` | a bundled script names a skill you did not select, in code — likely a real gap |
| `named in script comments only` in `plan` | the name appears under `scripts/` but only in a comment/docstring — often provenance ("adapted from X"), judge it |
| `UNMAPPED` import | no distribution known; add it to `module-distribution.json` or the venv is incomplete |
| `UNPINNED …` | the source venv's version is not on PyPI; the runtime got a different one |
| `verify` reports a link escaping the runtime | the no-link-back invariant is broken — the runtime is not standalone |
| hooks pruned on create | a hook referenced a `scripts/` file that did not travel; add the surface or accept the prune |
| everything shows as `local-only` right after create | line-ending normalization bypassed, or the runtime was rebuilt without updating the manifest |
