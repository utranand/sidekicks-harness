---
name: skill-nickname
description: >-
  Resolve a short nickname/alias to its full Sidekicks skill name and invoke that skill with any
  trailing arguments. Use whenever the user launches a skill by a shorthand instead of its literal
  name — "run gtd", "nick dba", "fire up cr" — or hands a known abbreviation (gtd, gpd, dba, pm,
  dev, cr, seq, cmd, arch…) to launch the real sidekicks-* skill. Also trigger when the user asks to
  list the skill nicknames, what an alias maps to, add or repoint a nickname (even when its target
  is a full skill name — a registry edit, not a launch), or wants a shorter way to call long skill
  names. Aliases come from a bundled map plus the project's config.yaml overrides. Do NOT trigger
  when the user asks to run or launch a skill written out in full — a literal sidekicks-<name> or
  bmad:<…> to execute — invoke that skill directly, since the resolver is only for short aliases;
  and not when pm, cli, scope, or review are ordinary words (person's nickname, shell alias, project
  scope, doc review), not a skill shorthand.
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Skill
version: 0.1.0
sidekicks:
  runtime-class: framework
  logical-id: skill:skill-nickname
  provides:
    - resolved-skill-invocation
---

# skill-nickname — alias → real skill resolver

Sidekicks skill names are long and exact (`sk-get-things-done`,
`sk-database-analyst`). Typing them in full is friction, and a near-miss
("get-things" / "db analyst") triggers nothing. This skill is the shorthand layer:
the user names a skill by a short **alias**, you resolve it to the canonical skill
name, and you **invoke that skill** for them — forwarding whatever else they typed
as its input. It is a thin dispatcher; it never does the target skill's work itself.

## 1. Parse the request

The user's input is `<alias> [args…]`:

- **`<alias>`** — the first token after the trigger (e.g. in "run gtd implement story 3.2",
  the alias is `gtd`). A leading `/` and case are ignored.
- **`[args…]`** — everything after the alias. This is the input you forward verbatim to the
  resolved skill (here: "implement story 3.2"). May be empty.

Two non-dispatch intents to recognize:

- **List** — "list the nicknames", "what aliases are there" → run the resolver with `--list`
  and show the table; do not invoke anything.
- **Explain** — "what does `dba` map to" → resolve the single alias and report the name; only
  invoke if they also asked you to run it.

## 2. Resolve the alias (deterministic — use the script)

Resolution merges the bundled default map with the active project's overrides. Don't do that
merge by hand — the bundled script does it deterministically and reports good suggestions on a
miss. Resolve the repo-root virtualenv by **absolute path** (a bare `python` may not exist in a
fresh shell, and `source activate` does not persist to a subprocess):

```sh
ROOT="$(git rev-parse --show-toplevel)"
PY="$ROOT/.venv/bin/python"
SKILL="$ROOT/.agents/skills/skill-nickname"

# resolve one alias → prints the full skill name on stdout (exit 0), or
# suggestions on stderr (exit 1):
"$PY" "$SKILL/scripts/resolve_nickname.py" gtd

# list every alias → skill mapping:
"$PY" "$SKILL/scripts/resolve_nickname.py" --list
```

The script reads its bundled `assets/nicknames.yaml`, then layers the active project's config
overrides on top (project wins), so the resolution always reflects the current scope.

## 3. Act on the result

- **Exit 0 (resolved).** stdout is the canonical skill name. **Invoke it now** with the `Skill`
  tool, passing the forwarded `[args…]` as its input. Say one line first so the user sees the
  hop, e.g. *"`gtd` → `sk-get-things-done`; launching."* Then invoke. If the script also
  printed a `warn: … not found in the current skills index` line, surface it — the alias may
  point at a skill that was renamed or isn't visible in this scope — and confirm before invoking.
- **Exit 1 (unknown alias).** Do **not** guess a skill. Show the script's `did you mean: …`
  suggestions (or the `--list` table if there were none) and ask which they meant. Resolving the
  wrong skill and running it is worse than asking — a mis-dispatch can do real work against the
  wrong target.

Forward the args, but let the **target** skill own its own behaviour — scope resolution
(`work_dir`/`docs_dir`), confirmations, safety gates all belong to it. This skill adds none of
its own; it only picks the door and passes the user through.

## Adding or overriding aliases

Defaults live in this skill's `assets/nicknames.yaml`. To add or change aliases for a project
without touching the skill, put them in the active project's **Sidekicks config** — `config.yaml`
for a user project, `.sidekicks/config.yaml` for the root project — under either shape (both are
read; project entries override the bundled defaults):

```yaml
# projects/<active>/config.yaml
skill_nickname:
  aliases:
    ship: sk-get-plan-done      # project-local shorthand
    gtd: sk-get-things-done     # (re)confirm or repoint a default
```

A missing config is never an error — the bundled defaults stand alone. When the user asks to
"add a nickname", edit the **project config** (not the bundled map) unless they explicitly want a
new ecosystem-wide default, which is a change to this skill's `assets/nicknames.yaml`.

## Boundaries

- **No ambient hijacking.** Only resolve when the user is clearly naming a skill by shorthand.
  A bare common word in an ordinary sentence is not an alias — when unsure, ask rather than
  dispatch.
- **Never invent a target.** Every invocation must come from a registry hit; an unknown alias is
  a question back to the user, never a best-guess skill launch.
- **Read-only.** This skill produces no artifacts and needs no working folder; the only writes
  are alias edits the user explicitly requests, made in the project config.
