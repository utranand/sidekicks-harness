---
name: sk-config-doctor
description: >-
  VALIDATE, LINT, and SCAFFOLD the per-scope Sidekicks project config — the git-ignored config.yaml
  (root .sidekicks/config.yaml, user project projects/name/config.yaml) every connector skill reads
  (database_connector aliases, jira, slack, confluence, mail_sender, run_notify, image_generation).
  CHECK compares each block against the committed schemas and consumers' required fields, flags
  lookalike aliases, placeholders, and a live config that would commit; SCAFFOLD appends a
  correctly-shaped block or alias (confirmation-gated); PROBE delegates connectivity tests. Use
  mid-project for "check / lint / validate my config", "config doctor", "why doesn't the database
  connector see my env", "audit my env aliases", "add a new database env to config", or a connector
  reporting an alias it cannot resolve. NOT first-run onboarding or seeding a config
  (sk-hello); NOT operating the connectors (sk-database-connector /
  jira-connector / slack-connector); NOT BMAD's bmad/bmm/config.yaml.
---

# Sidekicks Config Doctor

`sk-hello` seeds a `config.yaml` once, at first run — then nothing ever looks at it
again. Months later an env alias is added by hand with a typo'd key, a `notifications:` block
points nowhere, a lookalike alias gets "corrected" to the wrong cluster, and the first symptom
is a connector failing mid-task. This skill is the mid-project diagnostician for that file:
it validates an existing config against the committed schemas and the consumers' real
requirements, lints for the traps that have cost real errors, and scaffolds new blocks
correctly — without ever printing a secret.

## Anchoring (config path resolution per scope)

Repo-anchored skill — run everything from the repo root. Resolve the target config by scope:

```bash
ROOT="$PWD"; while [ "$ROOT" != "/" ] && [ ! -d "$ROOT/.sidekicks" ]; do ROOT="$(dirname "$ROOT")"; done
node "$ROOT/bin/sidekicks" index show --json     # → active.project
```

| Active scope | Config path |
|---|---|
| Root project `sidekicks` | `.sidekicks/config.yaml` |
| User project `<active>` | `projects/<active>/config.yaml` |

- The user may name a project explicitly ("check shp-sk's config") — CHECK reads that
  project's `config.yaml` directly, no scope switch needed. SCAFFOLD writes only to the
  resolved target the user confirmed.
- **A missing config is never an error** (CLAUDE.md contract: skills fall back to bundled
  defaults). Report absence as "no config — every capability unconfigured; `sk-hello`
  apply mode seeds one", then stop or offer SCAFFOLD.
- **BMAD guard:** never read or write `bmad/bmm/config.yaml` or anything under a `bmad/`
  path as project config — that is the BMAD framework's file, a different thing entirely.
- **Schema sources** (what "correctly shaped" means): the root schema
  `.sidekicks/config.example.yaml` plus every connector skill's committed example —
  discover them dynamically so new connectors are picked up automatically:
  `ls "$ROOT"/.agents/skills/*/config.example.yaml`.
- **Parse with the repo-root venv** (PyYAML is already there): `PY="$ROOT/.venv/bin/python"`.
  `yaml.safe_load` tolerates `\r\n` line endings; never line-split the file yourself
  without normalizing `\r`.

## Safety rails (non-negotiable)

1. **Never print a secret.** Any value under a key matching
   `password|api_token|api_key|bot_token|user_token|smtp_pass|secret` is redacted to
   `*** (len N)` — in reports, in proposed diffs, in probe output, always. If the user
   pastes a secret, write it without echoing it back.
2. **CHECK and PROBE are read-only.** The only write verb is SCAFFOLD, and every SCAFFOLD
   write is confirmation-gated: show the exact block to be added, wait for a yes.
3. **Never delete or rewrite existing config content.** SCAFFOLD merges additively — a new
   block or a new alias under an existing block. Changing an existing value is shown as a
   before/after (secrets redacted) and confirmed; removing anything is the user's hand-edit.
4. **Absence ≠ failure.** A missing file or missing block is `MISSING` — a capability the
   user hasn't configured — never an error verdict.
5. **Write convention = hello's.** `config.yaml` is git-ignored and agent-written by
   established convention (`sk-hello` Step 0.5 writes blocks into it directly,
   additively, secrets left blank for hand-fill). Follow exactly that; never invent a CLI
   verb for it, never commit the file.
6. **Never "correct" one env alias into another.** Lookalike aliases are frequently distinct
   on purpose (see CHECK lint L2). Confirm the exact alias against the config; flag, don't fix.

## Verbs

### CHECK — validate + lint the resolved config (read-only)

1. **Resolve and parse.** Dump a redacted structure once, then reason over it:

```bash
"$PY" - "$CONFIG" <<'EOF'
import sys, re, yaml
SECRET = re.compile(r'password|api_token|api_key|bot_token|user_token|smtp_pass|secret', re.I)
def redact(k, v):
    if isinstance(v, dict):  return {k2: redact(k2, v2) for k2, v2 in v.items()}
    if isinstance(v, list):  return [redact(k, i) for i in v]
    if SECRET.search(str(k)): return f"*** (len {len(str(v))})" if v not in (None, "") else "(empty)"
    return v
data = yaml.safe_load(open(sys.argv[1], encoding="utf-8")) or {}
yaml.safe_dump({k: redact(k, v) for k, v in data.items()}, sys.stdout, sort_keys=False, allow_unicode=True)
EOF
```

   A YAML parse error is a whole-file `MALFORMED` — report the parser's line/column and stop.

2. **Per-block verdict.** For every top-level block, compare against its schema file (root
   `config.example.yaml` for `image_generation`/`run_notify`/`mail_sender`; the owning
   skill's `config.example.yaml` for connector blocks) **and** the consumer's documented
   requirements (its SKILL.md — e.g. jira-connector requires `jira_url` (`*.atlassian.net`),
   `jira_email`, non-empty `api_token` per alias; database-connector requires `host`,
   `port`, `user`, `dbname` per alias, password legitimately blank/out-of-band):

   | Verdict | Meaning |
   |---|---|
   | `OK` | shape matches, required fields live |
   | `MISSING` | block absent — capability unconfigured, **not an error** |
   | `MALFORMED` | wrong shape / unknown or missing required key — name the exact key |
   | `SUSPECT` | parses fine but a lint rule hit (below) |

3. **Lint rules** (each hit = `SUSPECT` with evidence):
   - **L1 placeholders** — `YOUR_...`, `your-domain`, `you@example.com`, `example.internal`,
     or a required secret that is empty: the block was scaffolded but never filled.
   - **L2 lookalike aliases** — alias pairs differing by one segment/char (`shph-sg-*` vs
     `shp-th-*`), or an alias whose name contradicts its `host`/`dbname` hints (alias says
     `prod`, host says `dev`; alias says `sg`, host region says Thailand). Report the pair
     side by side and state plainly: *these may be distinct clusters on purpose — a real
     error was once caused by "correcting" one to the other* (memory
     `shp-sk-sg-vs-th-env-aliases`). Never auto-resolve.
   - **L3 dead-end notifications** — a `notifications:` block (or `run_notify.enabled: true`)
     with no resolvable channel (`notifications.skills.*` → `notifications.channel` →
     `default_channel` all empty), or `run_notify` transports naming `slack`/`email` with no
     `slack:`/`mail_sender:` block reachable — **mind root inheritance**: a project inherits
     root's `slack:` and `run_notify:` wholesale when it has none of its own, so check
     `.sidekicks/config.yaml` before flagging a project.
4. **Git-ignore verification (secrets safety).** A live config that would commit is an
   **ALERT**, above every other finding:

```bash
git -C "$ROOT" check-ignore -v .sidekicks/config.yaml                 # root scope
git -C "$ROOT" check-ignore -v "projects/<p>/config.yaml" \
  || git -C "$ROOT/projects/<p>" check-ignore -v config.yaml          # submodule projects
```

   (A submodule project errors with `Pathspec ... is in submodule` from the root repo — the
   second form checks the submodule's own `.gitignore`.) No ignore rule matching → ALERT with
   the fix (add the ignore rule; if already committed with secrets, rotate them).
5. **Render** one table: `block | verdict | detail`, ALERT first, then SUSPECT/MALFORMED,
   then MISSING as an "unconfigured capabilities" footer listing what each would unlock.

### SCAFFOLD — add a missing block or env alias (confirmation-gated)

1. Read the owning schema file in full; build the new block/alias from **its** shape —
   placeholders for values the user hasn't supplied, secrets left blank for hand-fill (point
   at where the schema says to obtain them). Fill non-secret values the user gives
   (URLs, project keys, hosts, alias names).
2. Alias naming: apply lint L2 *before* writing — propose names that are unambiguous against
   existing aliases and consistent with the host/dbname they point at.
3. Show the exact YAML to be appended (secrets redacted/blank) and the target path; on yes,
   append/merge additively per Safety rail 3. Preserve the file's existing content byte-for-byte.
4. If the config file itself is absent, prefer handing off to `sk-hello` apply mode
   (it seeds the full commented scaffold); scaffold a single block into a fresh file only if
   the user asks for just that block.
5. Finish by re-running CHECK on the touched block and offering PROBE.

### PROBE — verify connectivity (delegate, never reimplement)

Each connector owns its test verb — invoke that skill / its documented command; never
hand-roll an HTTP call or DB connection here, and never let probe output leak a secret:

| Block | Delegate to |
|---|---|
| `database_connector` | sk-database-connector — `pg_export.py --list-envs`, `--test-connection -e <alias>` |
| `jira` | sk-jira-connector — `test-connection --env <alias>`, `list-envs` |
| `slack` | sk-slack-connector — its list-envs / connection check |
| `confluence` | sk-confluence-connector — its test/list verb |
| `mail_sender` | `"$PY" scripts/send-mail.py --subject test --body test --dry-run` (build only, no send) |

A failed probe is feedback on the values (report the connector's own error), not a blocker
for the rest — and not a license to edit the config unconfirmed.

## Standard session flow

1. Resolve scope + config path; **CHECK** → verdict table, ALERT first.
2. Walk the user through findings: evidence per SUSPECT/MALFORMED; what each MISSING block
   would unlock. Ask which to fix — never assume all (a docs-only project may need none).
3. **SCAFFOLD** each chosen fix, one confirmation each.
4. **PROBE** every touched connector, best-effort.
5. Re-run **CHECK** and show the after state — the proof is ALERT/SUSPECT going to zero and
   the connector seeing its alias.
