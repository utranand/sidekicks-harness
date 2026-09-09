# Repo-root `scripts/` — add, move and remove by ownership

> Framework rule `rule.repo-root-scripts-lifecycle`, owned by `sk-inherit`.
> Inspect with `sidekicks framework show rule.repo-root-scripts-lifecycle`; turn it off with
> `sidekicks framework disable rule.repo-root-scripts-lifecycle`.

Repo-root `scripts/` is **framework surface that travels by ownership**, not a scratch drawer. When
`sk-inherit` forges a standalone runtime or a mountable framework core,
`resolveScriptOwnership()` copies a top-level `scripts/` entry only when something *present in that
forge* claims it:

1. a `CORE_HOOKS` entry with `owners: []` — the framework floor, always travels;
2. a `CORE_HOOKS` entry whose `owners` intersect the shipped skill set;
3. a shipped skill's `skill.manifest.yaml` → `requires.framework_files[].path` or
   `requires.framework_hooks[].script`.

`scripts/lib/` always travels (`SCRIPT_SUBDIR_FLOOR`) because every hook imports
`scripts/lib/hook-gate.mjs` and fails open without it. Other subdirectories travel only through
`SCRIPT_SUBDIR_OWNERS`, **as a single unit** — the gate resolves top-level files individually but
does not walk inside a subdirectory to gate its contents file by file.

An unclaimed file is invisible to every consumer: it never reaches a forged core or a mounted
workspace, so anything that depends on it there is broken by construction. The inverse failure is
worse and already happened — framework core v1.1.0 shipped 17 unowned `scripts/` files, 7 of them
hooks that stayed wired and enabled with no owning skill (incident report:
`projects/global/services/sidekicks-framework/artifacts/runs/incident-reports/framework-core-scripts-payload-20260813/incident-report.md`).

## Default: the script belongs inside its skill

Put a helper in `.agents/skills/<name>/scripts/` unless it cannot live there. A skill-folder
script travels through **both** distribution channels — `inherit` and `skill export`/`import` —
needs no ownership declaration, and cannot be orphaned. Only three things genuinely belong at the
repo root:

- a script that imports repo `lib/` (a skill folder must run when copied to another repo);
- a script shared by several owning skills, or by none;
- a hook, which fires when no skill is invoked and is wired by repo-relative path in the four
  per-CLI configs.

Duplicating a script into both places is not a compromise — the repo-root copy silently rots. The
canonical copy is the one the skill bundles.

## Adding a script to `scripts/`

Declare the owner **in the same change**, or the next forge parks it:

- **Skill helper** — add the path to that skill's `skill.manifest.yaml` under
  `requires.framework_files`, most easily with `sidekicks skill manifest <skill> --apply` (it
  records what the skill actually spawns). `sidekicks skill audit <skill>` flags an undeclared
  repo-root spawn.
- **Hook** — add a `CORE_HOOKS` entry in `lib/framework-settings/core-registry.mjs`, import
  `scripts/lib/hook-gate.mjs` so it can be gated off, wire it in **all four** per-CLI configs
  (`.claude/settings.json`, `.codex/config.toml`, `.gemini/settings.json`, `.agent/settings.json`)
  in the same change (Rule 6), then run `sidekicks framework sync` so the id is listed in
  `.sidekicks/framework.yaml`.

## Moving or parking a script

Park **only** a script nothing claims. Unclaimed, non-hook scripts kept for reference live in
`scripts/legacy/` — a directory with no `SCRIPT_SUBDIR_OWNERS` entry, so it never travels. See
`scripts/legacy/README.md` for the contents and the revive procedure.

Never park a *claimed* script: because a subdirectory is one gate unit, it would stop travelling
without any check failing, and its owning skill would ship broken. Confirm first:

```sh
git grep -n "path: scripts/\|script: scripts/" -- .agents/skills/*/skill.manifest.yaml
grep -n "script: 'scripts/" lib/framework-settings/core-registry.mjs
```

Moving a claimed script — including moving it into a skill folder, which is usually the right
answer — means updating every reference in the same change: the owning manifests, `CORE_HOOKS`, all
four CLI configs, `package.json` scripts, tests, and any committed guide that spells the path.
Re-record with `sidekicks skill manifest <skill> --apply` afterwards.

Foldering the *claimed* set is blocked until `resolveScriptOwnership`, `copyScriptsSurface` and
`inherit verify`'s check 9a resolve nested paths. Until then, keep claimed scripts top-level.

## Removing a script

1. Find every claim and every wiring reference with the two commands above, plus `git grep` for the
   bare filename.
2. Drop the claim: remove the row from each owning `skill.manifest.yaml` (or re-run
   `sidekicks skill manifest <skill> --apply` once the spawn is gone).
3. If it is a hook: remove its `CORE_HOOKS` entry **and** its wiring from all four per-CLI configs
   in the same change (Rule 6), then `sidekicks framework sync --prune` to drop the orphaned key
   from `.sidekicks/framework.yaml`.
4. Update committed docs that name the path. A stale path in a guide is a bug report waiting to be
   filed.

A rename is a remove plus an add — do both halves, not just the `git mv`.

## Verify before you call it done

```sh
sidekicks framework doctor            # hook wiring vs registry, unlisted entries
sidekicks skill doctor                # manifest claims vs reality
node --test tests/skills/inherit-scripts-ownership.test.mjs
node --test tests/framework-cli.test.mjs lib/framework-lifecycle/tests/multi-cli-parity.test.mjs
```

`inherit verify --name <runtime>` is the end-to-end check: it fails when a forged runtime ships a
`scripts/` entry nothing present claims, and when a hook whose every owner is absent still ships a
script or wiring.
