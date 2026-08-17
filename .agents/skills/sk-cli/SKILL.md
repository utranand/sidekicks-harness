---
name: sk-cli
description: >-
  Retrieve the live Sidekicks CLI verb surface by running `node bin/sidekicks --help` and answer
  from that output. Use whenever you need to know which `sidekicks` verbs exist, a verb's signature
  or arguments, what a verb does, or how to perform a project/service operation with the CLI. This
  is the source of truth for the verb surface — never answer from memory or a hardcoded list,
  because the CLI evolves and a static answer drifts silently.
---

# Sidekicks CLI Reference

## Trigger guidance

Route requests here for "what sidekicks commands are there", "how do I create a project", "what's
the signature of `service add`", or "list the CLI verbs".

Do not use this skill for current-scope or orientation questions — active project/service, working
folder, what's writable, which skills are available — that is `sk-hello`; nor for editing the
CLI's source code, general git operations, or BMAD story/PRD/review work.

The Sidekicks CLI prints its own complete verb surface. Your job is to read that live output and
answer from it — not to recite a list from memory. The canonical verb metadata lives in
`lib/sk-cli/help.mjs` (the `VERBS` table, Decision D13); `--help` renders it. Any verb list
written into this skill would drift the moment a verb is added or renamed (FR5.4), so this skill
deliberately contains none.

## The one command you need

```
node bin/sidekicks --help
```

This single call prints **everything**: global flags, every namespace, and every verb under each
namespace with its signature and one-line description. There is no deeper per-verb help — running
`node bin/sidekicks <namespace> --help` only reprints a subset of this same output, so reach for it
only when you want to show a user just one namespace. Default to the top-level call.

Run it, then use the result as your source of truth: present it verbatim when the user wants the
full reference, or quote the relevant lines when they asked about a specific verb or operation.

> **Always invoke `node bin/sidekicks`** — never a global `sidekicks` binary. Sidekicks ships with
> zero install step (FR4.3); the repo clone plus Node ≥ 20 is the whole contract, and a global
> binary may be absent or stale.

## If the command fails

`--help` is expected to succeed every time. If it doesn't (non-zero exit or an error on stderr),
surface the full stderr to the user verbatim rather than guessing — a real failure here usually
means the wrong working directory or a broken checkout, and inventing verb names would only mask
it.

---

For write-surface boundaries and working-folder resolution rules (which the verbs operate within),
see `.sidekicks/RULES.md`.
