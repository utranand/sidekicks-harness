---
name: sk-jira-connector
description: |
  Connect to a Jira Cloud project over the REST API to query or update it: JQL/board search, list
  your assigned tickets, render an epic timeline, drill into an issue (description + comments), and
  make changes — comment, attach a file, transition, edit, create, link, delete. Use whenever the
  user wants to look at a Jira board, find assigned tickets, read or update an issue, move a
  ticket's status, attach an evidence/result file, file/delete a ticket, or show an epic timeline —
  even if they only paste a board URL or an issue key like SDHPT-2 without saying "Jira". Trigger
  on: "my jira tickets", "what's assigned to me", "show the board", "search jira", "move this to
  done", "comment on the ticket". It only moves issue data in/out of Jira — NOT for: planning docs
  (PRD/stories/tech specs → BMAD); a local drag-drop board (jira-kanban); picking work across boards
  (jira-my-work); driving a card to done (jira-autopilot); readiness validation (jira-ready-gate);
  progress footprint comments (jira-footprint).
sidekicks:
  runtime-class: catalog-only
---

## Working folder — align scope, then resolve it, first

Every config lookup in this skill resolves through the **active scope**, and any file you
write (an exported list, a saved report) lands under the active scope's working folder
(`$WORKDIR`), *not* your current directory. Settle scope once via the ladder below before
running anything. (Most of this skill talks to Jira, not the filesystem, so $WORKDIR only
matters when you save output — but scope still selects *which* `config.yaml` is read.)

```bash
ROOT="$PWD"; while [ "$ROOT" != "/" ] && [ ! -d "$ROOT/.sidekicks" ]; do ROOT="$(dirname "$ROOT")"; done

# (1) Explicit work_dir=<path> (or a bare absolute path naming where output goes) WINS.
#     Align the active scope to it first so the right config.yaml is read: parse <project>
#     (and <service>, if a services/<service>/ segment follows) and switch — a work_dir
#     outside projects/ is root scope:
#       node "$ROOT/bin/sidekicks" project use <project>
#       node "$ROOT/bin/sidekicks" service use <service>
#     Then take work_dir verbatim as the anchor and SKIP step (3).

# (2) No work_dir, but handed a target path under projects/<project>/services/<service>/…?
#     Align the active scope to it the same way before resolving.

# (3) Otherwise resolve the working folder from the active scope as-is:
WORKDIR="$(node "$ROOT/bin/sidekicks" scope working-folder)"
```

The config file is selected by scope: root scope → `.sidekicks/config.yaml`; user project
`<active>` → `projects/<active>/config.yaml` (see [Configuration](#configuration)).

---

## Pre-flight

Run once before any command. Locates the repo root, ensures the repo-root `.venv` exists
with Python 3.13+, and installs the skill's two pinned dependencies into that single
shared venv.

```bash
ROOT="$PWD"
while [ "$ROOT" != "/" ] && [ ! -d "$ROOT/.sidekicks" ]; do ROOT="$(dirname "$ROOT")"; done
if [ ! -d "$ROOT/.sidekicks" ]; then
  echo "ERROR: Cannot find repo root (.sidekicks/ not found). Run from inside the repo." >&2
  exit 1
fi
PYTHON="$ROOT/.venv/bin/python"
if [ ! -x "$PYTHON" ]; then
  echo "ERROR: Repo-root .venv not found at $ROOT/.venv. Bootstrap: python3.13 -m venv $ROOT/.venv" >&2
  exit 1
fi
SKILL_DIR="$ROOT/.agents/skills/sk-jira-connector"
"$ROOT/.venv/bin/pip" install -q -r "$SKILL_DIR/requirements.txt"
CLI="$SKILL_DIR/scripts/cli.py"
```

Dependencies are tiny (`requests`, `PyYAML` — both already in the repo venv), so this is
near-instant after the first run.

---

## Invocation

Every mode is dispatched through **`scripts/cli.py`** with the repo-root venv Python.
Always invoke by absolute path so it works from any directory:

```bash
"$PYTHON" "$CLI" <command> --env <alias> [options]
```

Run `"$PYTHON" "$CLI" --help` (or `<command> --help`) for the live flag surface — it is
the source of truth if this document and the code ever disagree.

**Commands:** `search` · `my-tasks` · `issue` · `timeline` · `projects` · `whoami` ·
`comment` · `attach` · `transition` · `edit` · `create` · `link` · `delete` · `test-connection` · `list-envs`

**`--env <alias>`** is required on every Jira-touching command; it names a block under
`jira:` in the scope config. `list-envs` needs no `--env`.

**Exit codes:** `0` success · `1` config/operation error · `2` write blocked by a safety
guard (`delete` without `--yes`, or a `comment --id` edit without `--yes`).

**Pick the right command — don't write ad-hoc JQL when a named mode exists.** `my-tasks`,
`timeline`, and `issue` already encode the grouping/ordering/rendering the user wants; use
`search --jql` only for genuinely custom queries.

---

## Safety contract for writes (read this before any mutating command)

`comment`, `attach`, `transition`, `edit`, `create`, and `link` change a shared, externally-visible
system — other people see them immediately and there is no clean undo (`attach` adds content to the
card, the same low-risk class as a comment; there is no delete-attachment verb, so attach the right
file). This skill is configured for
**autonomous writes**: for these routine operations you may proceed without a
confirmation prompt **once the user's intent is unambiguous** (they named the issue and the
change, or you are acting inside a task they already approved). You do not need to re-ask
permission for each one.

Three lines you do **not** cross autonomously:

1. **`delete` is irreversible** — the CLI refuses it without `--yes`, and you must get an
   explicit go-ahead from the user before passing `--yes`. Never delete an issue to "clean
   up" on your own initiative. With `--delete-subtasks` a single delete cascades to all child
   subtasks, so confirm the blast radius with the user before passing both `--yes` and
   `--delete-subtasks`.
2. **Editing an existing comment overwrites what somebody wrote.** `comment <KEY> --id <ID>`
   replaces that comment's body — the previous text is gone, the API surfaces no version
   history, and the author is not notified that their words changed. The CLI refuses it
   without `--yes`, printing the current body first so you see exactly what is about to be
   destroyed. Adding a comment is the default and stays autonomous; *editing* one needs the
   user to have asked for that specific correction. Prefer a new comment that says what
   changed — reserve the edit for when a stale line would actively mislead a reader, and say
   in the corrected text that it was corrected rather than rewriting history silently.
3. **Bulk or ambiguous writes pause once.** If a request would mutate **many** issues
   (e.g. "close all the stale tickets", a transition/edit loop over a search result), or
   the target/intent is unclear, state what you are about to do and how many issues it
   touches, and get one confirmation before the batch. This is the "safety never traded
   away" floor — autonomy covers the unambiguous single write, not a sweeping change you
   inferred.

When in doubt, a read is always free — show the user the issue first, then write.

---

## Modes

### 1. search — JQL or filtered browse

```bash
"$PYTHON" "$CLI" search --env <alias> --jql "project = SDHPT AND status = 'In Progress' ORDER BY updated DESC"
# or build it from filters (project defaults to config default_project):
"$PYTHON" "$CLI" search --env <alias> --status "In Progress" --assignee me --max 50
```

Returns a compact `| Key | Type | Status | Priority | Summary |` table. The client sends a
lean `fields` allow-list, so even a 100-issue board stays small — you never hit the
oversized-response wall that the raw Atlassian API/MCP hits when it returns full
descriptions for every row. Raise `--max` only when you truly need more rows.

Add `--json` to emit a JSON array of `{key, summary, status, issuetype}` instead of the table —
for tools that act on each hit programmatically (e.g. `sk-jira-ready-gate` /
`sk-jira-autopilot` fanning over a `parent = <KEY>` subtask query).

### 2. my-tasks — your assigned work, grouped by type then priority

```bash
"$PYTHON" "$CLI" my-tasks --env <alias>                 # the configured user (or API user)
"$PYTHON" "$CLI" my-tasks --env <alias> --assignee me   # force the authenticated account
"$PYTHON" "$CLI" my-tasks --env <alias> --include-done   # also show closed issues
"$PYTHON" "$CLI" my-tasks --env <alias> --project SDHPT   # restrict to one project key (default: all)
```

Open issues (Done-category excluded by default) for `default_assignee` from config, or the
authenticated user when that's blank, or an explicit `--assignee <accountId>`. Output is
grouped into `### Epic / Story / Task / Bug / Subtask` sections and ordered by priority
within each — the personal-worklist shape, not a flat list.

### 3. timeline — epic timeline by created date

```bash
"$PYTHON" "$CLI" timeline --env <alias>                  # project from config
"$PYTHON" "$CLI" timeline --env <alias> --with-children   # add a per-epic child status rollup
```

Jira's native Timeline needs start/due dates on epics; when those aren't populated this
creation-ordered table (with status + last-activity) is the honest substitute. Say so to
the user rather than implying a planned schedule exists. `--with-children` adds one extra
query per epic, so reserve it for when the rollup is actually wanted.

### 4. issue — single-issue drill-down

```bash
"$PYTHON" "$CLI" issue SDHPT-2 --env <alias>              # header + description + comments
"$PYTHON" "$CLI" issue SDHPT-2 --env <alias> --no-comments
"$PYTHON" "$CLI" issue SDHPT-2 --env <alias> --raw        # unrendered issue JSON (incl. description ADF)
```

Renders the rich-text description and comments from ADF (Atlassian Document Format) to
readable Markdown — tables, lists, code, links, panels are preserved.

Pass `--raw` for the unrendered issue JSON (the full field tree including the description ADF)
instead of Markdown — used by sibling skills such as `sk-jira-ready-gate` for its ADF
description merge and Confluence-link discovery.

### 5. comment / attach / transition / edit / create — writes (see the safety contract above)

```bash
"$PYTHON" "$CLI" comment SDHPT-2 --env <alias> --body "Deployed to SIT, verifying."
"$PYTHON" "$CLI" comment SDHPT-2 --env <alias> --list                 # ids + first lines
"$PYTHON" "$CLI" comment SDHPT-2 --env <alias> --list --json          # incl. each raw ADF body
"$PYTHON" "$CLI" comment SDHPT-2 --env <alias> --id 111572 --body "Corrected: …" --yes
"$PYTHON" "$CLI" attach SDHPT-2 --env <alias> --file docs/investigation.md   # upload evidence/result file(s)
"$PYTHON" "$CLI" transition SDHPT-2 --env <alias> --list            # discover valid targets first
"$PYTHON" "$CLI" transition SDHPT-2 --env <alias> --to "In Progress"
"$PYTHON" "$CLI" edit SDHPT-2 --env <alias> --summary "New title" --priority High
"$PYTHON" "$CLI" create --env <alias> --type Task --summary "Investigate report API 500s" \
    --description "Seen on SIT since the AWS-TH cutover." --priority High
```

- **comment** adds by default (`--body` plain text, or `--body-adf <file.json>` for a
  pre-built document). `--list` prints each comment's **id** — the issue drill-down renders
  comments without ids, so this is the only way to get the one an edit needs; `--list --json`
  adds each comment's **raw ADF body**, which is what makes the real edit workflow possible:
  read a body, transform its text nodes, write it back with `--body-adf`, and the author's
  formatting survives. `--id <ID>` edits that comment instead of adding one and is `--yes`-gated
  (see the safety contract). `--max` (default 50) bounds the fetch for both `--list` and the
  `--id` lookup; an id outside that window errors rather than silently missing.
- **attach** uploads one or more files to the issue as Jira attachments — the way to put a
  *generated artifact* (an investigation/research report, an exported CSV, a screenshot proving a
  UI fix, a log capture) onto the card so the evidence lives with the ticket instead of only on
  disk. Repeat `--file` for several files in one call: `attach SDHPT-2 --env <alias> --file
  report.md --file result.csv`. It leaves a comment un-posted — pair it with a `comment` (or a
  `sk-jira-footprint done`) that references what the attachment proves. Path is resolved
  as given (anchor it to the working folder yourself); a missing file errors rather than posting a
  half-upload.
- **transition** matches `--to` against the *target status name*; run `--list` first when
  unsure, because available transitions depend on the issue's current workflow state.
- **edit** takes `--summary/--description/--priority/--assignee` or repeatable `--set field=value`
  for anything else. `--description` sets the body from plain text; `--description-adf <file.json>`
  passes a raw ADF document through verbatim (used by sibling skills such as ready-gate).
  `--assignee` is an accountId (get one from `whoami` or an issue dump).
- **create** needs `--type` and `--summary`; project defaults to `default_project`. Use
  `--parent <KEY>` to make it a subtask or an epic's child.
- **link** connects two issues. Convenience flags read in plain English — `link <KEY> --blocks <OTHER>`
  (KEY blocks OTHER), `link <KEY> --blocked-by <OTHER>` (KEY is blocked by OTHER), `link <KEY>
  --relates-to <OTHER>`; or generic `link <KEY> --type "<name>" --to <OTHER> [--inward]`. `link
  --list-types` prints the link types this Jira defines. Used by sibling skills (e.g. ready-gate PREP)
  to wire a dependency DAG between subtasks.

```bash
"$PYTHON" "$CLI" link SDHPT-201 --env <alias> --blocked-by SDHPT-200   # 201 is blocked by 200
"$PYTHON" "$CLI" link --env <alias> --list-types                       # discover link type names
```

### delete sub-mode — irreversible, gated

```bash
"$PYTHON" "$CLI" delete SDHPT-2 --env <alias> --yes
```

Refuses without `--yes` (exit 2). Get an explicit user go-ahead before passing it.

`--delete-subtasks` also deletes every subtask of the issue (the API's `deleteSubtasks=true`) —
same `--yes` gate, wider irreversible blast radius. Omit it to delete only the issue.

### Utility

```bash
"$PYTHON" "$CLI" whoami --env <alias>            # your accountId/displayName (for assignee filters)
"$PYTHON" "$CLI" projects --env <alias> [--query <substring>]   # visible projects; --query filters by name/key substring
"$PYTHON" "$CLI" test-connection --env <alias>   # verify reachability + auth, writes nothing
"$PYTHON" "$CLI" list-envs                        # configured aliases (no secrets)
```

---

## Jira ↔ Sidekicks bridge

This skill is the seam between a Jira project and the Sidekicks/BMAD planning pipeline.
Two common directions:

- **Pull tickets into planning.** Use `issue <KEY>` / `search --jql` to read an epic and
  its children, then hand the rendered Markdown to `sk-implementation-planner` or
  `sk-bmad-pm` as source material for a plan, PRD, or stories. The connector
  produces the artifact; the planning skills own the transformation — don't reinvent their
  job here.
- **Report Sidekicks results back to Jira.** After a run (a dev wave, a DB transfer, a
  review), `comment` the outcome onto the tracking issue, or `transition` it. Treat these
  as the outward-facing writes they are (safety contract above). For *progress* and
  *implementation-decision* comments — the recurring "task started / decision made / done"
  updates GTD/GPD post as work moves — don't hand-roll the body here: delegate to
  **`sk-jira-footprint`**, which renders a standardized comment with a traceable
  footprint (scope · branch @ commit, files) and logs decisions, then posts through this
  connector. Use a raw `comment` here only for genuine one-off notes.

Keep this skill's responsibility narrow: it *moves issue data in and out of Jira*. Anything
that reasons about the data (planning, validation, reporting prose) belongs to the skill
that owns that job, reached through the normal funnel.

---

## Configuration

The skill reads its config from the active scope's config file (resolved by `scope.py`):

| Active scope | Config path |
|---|---|
| Root project (`sidekicks`) | `.sidekicks/config.yaml` |
| User project `<active>` | `projects/<active>/config.yaml` |

The file must contain a `jira:` block keyed by alias. See `config.example.yaml`:

```yaml
jira:
  my-board:
    jira_url: https://your-domain.atlassian.net
    jira_email: you@example.com
    api_token:                 # REQUIRED, config-only — blank in the committed example
    default_project: PROJ      # default for search / my-tasks / timeline / create
    default_assignee:          # optional accountId; my-tasks falls back to the API user
    cloud_id:                  # optional; not needed for the REST client
```

- **Select an alias** with `--env <name>`; list configured aliases (token omitted) via
  `list-envs`.
- **`--config <path>`** overrides scope resolution. The BMAD-exclusion guard still applies —
  `--config` can never point at a `bmad/…` file.
- **Get an API token** at <https://id.atlassian.com/manage-profile/security/api-tokens>. The
  same Atlassian token works for both Jira and Confluence.
- **Test auth** without writing: `test-connection --env <alias>`.

---

## Security posture

- **Config-only token.** `api_token` is read from the scope config file, passed in-process
  to the REST client, and never written to logs, reports, stdout, or argv. `list-envs` and
  `whoami` never print it.
- **No env-var secrets.** `JIRA_*`, `ATLASSIAN_*`, and similar environment variables are
  not read.
- **`ANTHROPIC_API_KEY` is not read or used.** The skill makes no Anthropic API calls.
- **`bmad/…` config paths are excluded.** The resolver hard-excludes `bmad/bmm/config.yaml`
  and any path under `bmad/`.
- **`config.yaml` is git-ignored.** Only `config.example.yaml` (blank `api_token`) is
  committed. If you ever commit a live token, rotate it immediately.
- **Cloud only.** The client refuses non-`*.atlassian.net` URLs (Server/DC differ).

---

## File layout

```
.agents/skills/sk-jira-connector/
├── SKILL.md                # this file — agent-facing entry
├── VERSION.json            # bundle metadata
├── requirements.txt        # exact-pinned Python dependencies (requests, PyYAML)
├── config.example.yaml     # committed key-free config schema
└── scripts/
    ├── cli.py              # ★ dispatcher / entry point — resolves scope, builds client, runs modes
    ├── scope.py            # repo-root / .venv / $WORKDIR / config-path resolver (.sidekicks walk-up)
    ├── config_loader.py    # jira: block + alias resolution + config-only token
    ├── jira_client.py      # Cloud REST API v3, Basic auth, lean fields, pagination, 429 backoff
    ├── adf.py              # Atlassian Document Format <-> Markdown (descriptions, comments)
    ├── render.py           # list / my-tasks / timeline / issue Markdown views
    └── tests/              # offline pytest suite (mocked client); run via repo-root .venv
```

Run the test suite: `"$PYTHON" -m pytest "$SKILL_DIR/scripts/tests/" -q`

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERROR: Cannot find repo root` | Invoked outside the repo | `cd` into the Sidekicks repo |
| `ERROR: Repo-root .venv not found` | `.venv` not initialized | `python3.13 -m venv $ROOT/.venv` |
| `api_token is not set` | Token missing from config | Add `api_token:` to the alias block |
| `not a Jira Cloud URL` | Server/DC URL configured | This skill supports Jira Cloud only (`*.atlassian.net`) |
| `Authentication failed (HTTP 401)` | Wrong email or token | Check `jira_email` and `api_token` |
| `Authorization failed (HTTP 403)` | Insufficient project permissions | Grant the API user access to the project |
| `no transition to 'X'` | Target not valid from current status | Run `transition --list` to see valid targets |
| exit 2 on delete | Irreversible-write guard | Re-run with `--yes` after user confirms |
