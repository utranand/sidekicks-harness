---
name: sk-scope-switch
description: Switch the active Sidekicks project/service scope so edits, new files, and downstream skills land in the correct working folder. Use when the user names a project/service target or provides a path under `projects/<project>/services/<service>/...` that implies scope.
---

# Sidekicks Scope Switch

## Trigger guidance

Route requests here when the user names a target to work in: "switch me to the api service", "work
on the auth service", "point my skills at X", "jump into project foo", "get me set up in X", "I'm in
the wrong scope", "everything I write lands in the wrong place", or "take me back to root" even if
they never say "switch" or "scope".

Also trigger when the user hands over a path under `projects/<project>/services/<service>/...`, such
as "implement projects/foo/services/api/src/docs/plan.md", "take a look at
projects/foo/services/auth/src/handlers/login.go", "build out the spec at <path>", or just a pasted
path. Infer the project and service from the path segments and align active scope before touching the
file. Trigger proactively when correct scope is a precondition for another task, such as before
running a dev/PRD/review workflow on a story or spec under a service.

Do not use this skill to create, add, or remove a project or service; switch a service's git branch;
sync a service to git; edit a file whose path already resolves to the current active scope; answer
"where am I" or "what's my active project" (`sk-hello`); or list command verbs
(`sk-cli`).

## Why this skill exists

In a Sidekicks repo, *where your work lands* is decided entirely by two pointers in
`.sidekicks/settings.json`: `active_project` and `active_service`. Skills don't write to a
folder because they happen to live there — they write to whatever the **active scope** resolves
to. So when someone says "make my skills work on the api service's `/src`", the move is **not** to
reach down into that folder from wherever you are. The move is to *switch the active scope to that
service*, after which every skill naturally operates inside it.

The active pointers resolve like this:

| active_project | active_service | scope resolves to | where work actually lands |
|---|---|---|---|
| `sidekicks` (root) | (ignored) | repo root | repo root |
| `foo` | (none) | `projects/foo/` | `projects/foo/` |
| `foo` | `api` | `projects/foo/services/api/` | `projects/foo/services/api/src/` |

The subtlety in that last row matters: **when a service is active, the real working folder is its
`src/` subfolder, not the service root.** The service root holds metadata (`service.yaml`, config);
the source you actually edit lives under `src/`. The CLI only lets you pin the active-service
pointer at the *service* level — there is no sub-path verb — but the place edits should land, and
the place you report to the user, is `projects/<project>/services/<service>/src/`. (If a service
happens to have no `src/`, the service root is the working folder — don't invent a `src/`.)

Your job: take a loosely-worded target — a name ("the api service", "foo's auth service"), or a
**file path the user hands you** ("here's the spec at `projects/foo/services/api/src/docs/plan.md`",
or just a pasted path) — turn it into a concrete `(project, service)` pair that actually exists, flip
the pointers with the CLI, and report the `src/` working folder.

The path case is worth calling out because it often arrives *implicitly*: the user isn't asking to
"switch scope," they're handing you a document to implement, review, or extend, and the path itself
tells you which scope that work belongs to. Reading the scope out of the path and aligning to it —
before you touch the file — is what makes the rest of the work land in the right place. The same is
true when another skill is about to run against a path-addressed artifact (a story, a tech spec):
align scope to that path *first*, so the downstream skill inherits the correct working folder.

## The one sequencing rule that matters

`project use <name>` **resets `active_service` to null** every time it runs. That's deliberate — a
service from project A is meaningless under project B. The consequence for you:

> To land on a service, always run `project use <project>` **first**, then `service use <service>`.
> Never the reverse — switching the project afterward would wipe the service you just set.

`service use` also refuses to run while root (`sidekicks`) is active, and validates that the
service directory exists. So the project-first order isn't just tidy, it's required.

## How to switch

All switching goes through the CLI — it's the only thing allowed to write `settings.json`, and it
validates the target exists so you don't end up with a scope pointing at nothing.

```bash
# Target a service (the common case):
node bin/sidekicks project use <project>     # activates project, clears any old service
node bin/sidekicks service use <service>     # activates service within that project

# Target a project, no specific service:
node bin/sidekicks project use <project>

# Go back to root:
node bin/sidekicks project use sidekicks
```

After switching, confirm and report:

```bash
node bin/sidekicks project current        # -> project name
node bin/sidekicks service current        # -> service name or (none)
node bin/sidekicks scope working-folder   # -> absolute working folder (the service's src/)
```

Lead with what `scope working-folder` prints — it is the canonical working folder (the service's
`src/`, where edits and artifacts land). Don't hand-build that path; the verb resolves it from the
active scope you just set, so it's always right.

## Resolving the target

The user rarely hands you a clean `(project, service)` pair. Resolve from whatever they gave you
against the *live* layout — never assume a name exists.

**Discover what's actually there** (read-only; there is no `service list` verb, so read the disk
directly):

```bash
node bin/sidekicks project list          # projects, active marked with *
ls -d projects/*/services/*/ 2>/dev/null # every service, as <project>/services/<service>/
```

Then match by input shape:

- **Service name only** ("switch me to api") → find which project owns a service called `api` by
  scanning the `ls` output. Exactly one owner → that's your pair. Then switch.
- **Project + service** ("the auth service in foo") → you already have both; just confirm both
  directories exist, then switch.
- **A path** — whether it's a bare folder ("projects/foo/services/api/src"), a deep file the user
  wants you to work on ("projects/foo/services/api/src/docs/sample-implementation.md"), an absolute
  path, or a path with a `.sidekicks`-rooted prefix — extract the scope from the **path segments**,
  not from how deep the path goes:
    - Find the `projects/<project>/` segment → that's the project.
    - If a `services/<service>/` segment follows it → that's the service. Switch at the service
      level (all the CLI can pin); everything after `services/<service>/` (`/src`, `/src/docs/...`,
      the filename) is *inside* the working folder, so discard it for the switch but use it to
      confirm you read the path right.
    - If there's a `projects/<project>/` segment but **no** `services/<service>/` after it (e.g.
      `projects/foo/docs/notes.md`) → switch the project only, leave the service cleared.
    - If the path is **not** under `projects/` at all → it's root scope; `project use sidekicks`.
  Parse structurally — the target *file* need not exist yet (the user may be about to create it),
  but the `projects/<project>/` and `services/<service>/` **directories must exist**; validate them
  against the `ls` output before switching, since the CLI rejects a non-existent project/service.
  **If the path already resolves to the current active scope, don't re-switch** — just confirm the
  scope is already correct and proceed. A trailing `/src` or a deep doc path isn't noise: it's the
  user naming where their work lives, which is exactly where the switch lands. Report the `src/`
  working folder back so they see you understood.
- **Project only** ("switch to project foo", "go to root") → just `project use`. Leaving the
  service cleared is correct, not an oversight — say so.

## When the target is fuzzy, missing, or ambiguous

Resolution won't always be clean. The guiding instinct: **a scope switch silently changes where
all future work lands, so a wrong guess is expensive — when you're not certain, show your pick and
get a yes before writing.** Concretely:

- **Exact, unambiguous match** → just switch and report. No need to ask; the user told you plainly
  and there's only one thing it can mean.
- **Typo or no exact match** ("swith me to teh api srvice", "the athu service") → pick the closest
  real service from the `ls` output, show it ("Closest match: `auth` in project `foo` — switch?"),
  and confirm before switching.
- **Same service name in multiple projects** → the name alone can't decide it. Show the candidates
  with their projects and ask which one. Don't pick arbitrarily.
- **Genuinely nothing close** → say so and list the real projects/services, rather than inventing a
  target. The CLI would reject a non-existent name anyway, so guessing just wastes a round-trip.

The aim isn't to interrogate the user — most switches are a clean one-shot. It's to avoid the one
bad outcome: quietly pointing their scope somewhere they didn't mean.

## Reporting back

After a successful switch, give a compact confirmation so the user knows their next edit will land
correctly. Lead with the working folder — that's the answer to the question they were really
asking — and for an active service that means the **`src/`** folder, not the service root.

**Example — name:**
Input: "switch me to the api service"
Output:
```
Active scope → project `foo`, service `api`
Working folder: projects/foo/services/api/src/
Your skills and edits now write here.
```

**Example — path handoff:**
Input: "implement projects/foo/services/api/src/docs/sample-implementation.md"
(Parsed: project `foo`, service `api`; the `src/docs/...` tail is inside the working folder.)
Output:
```
Read the scope from that path → project `foo`, service `api`
Active scope aligned. Working folder: projects/foo/services/api/src/
That doc lives under the working folder, so I'm set up to work on it.
```
Then proceed to the work the user actually asked for (implementing the doc), now that scope is right.

If the service has no `src/`, report the service root instead (and don't pretend a `src/` exists).
If you only switched a project (no service), or returned to root, say which working folder that
maps to (`projects/foo/` or the repo root) and that no service is active.
