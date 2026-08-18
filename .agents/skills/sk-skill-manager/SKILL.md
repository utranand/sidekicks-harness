---
name: sk-skill-manager
description: >-
  Front door for a skill's whole life in Sidekicks: CREATE one (via skill-creator), ARCHITECT its
  work_dir=/docs_dir= anchors, VALIDATE one (skill doctor/verify/manifest), HEAL one (install
  deps, restore bundle), EXPORT/IMPORT skills to/from the configured skills repos
  (public/private), REMOVE one (delete it here and unwire it, or retract its published copy from a
  destination), DISCOVER an uninstalled skill by describing the task, report what is published
  where (DESTINATIONS), REVIEW drift and pick what to republish, ADVISE which siblings a skill
  needs. Use for "create a new skill", "is this skill built right", "this skill is broken",
  "publish these skills", "pull skill X in", "delete skill X", "unpublish X", "retract X from the
  skills repo", "is there a skill for X", "I need something that can
  do X", "find me a skill that", "nothing here does X", "what needs re-exporting / diff before I
  export", "what else do I need for X". NOT for offloading (sk-skill-offload), runtimes
  (sk-inherit), packaging (sk-packager), audits/evals (sk-skill-auditor),
  applying improvements (sk-self-improve), or CLI parity (sk-parity-keeper).
user-invocable: true
version: 0.3.0
sidekicks:
  logical-id: skill:sk-skill-manager
  depends-on:
    - skill:skill-creator
  provides:
    - skill-lifecycle
---

# sk-skill-manager

The skill that manages skills. It owns no engine of its own: every mode below drives a
`sidekicks` CLI verb or hands off to the skill that already owns that job. When a mode says
"delegate", delegate — do not reimplement it here.

**Read the structure guide, do not restate it.** Everything about what a skill *is* —
`SKILL.md` anatomy, `skill.yaml`, `skill.manifest.yaml`, the YAML subset, the 22 audit checks,
portability, the lifecycle verbs — lives in
[docs/guide/skill-architecture.md](../../../docs/guide/skill-architecture.md). This file is a
router over it.

**Never hardcode a flag list.** Every verb's real surface is `sidekicks skill --help` /
`sidekicks framework --help`. A copied flag roster in a skill body is drift waiting to happen.

## Where generated output lands (runs layout v2)

REVIEW's pick list, DISCOVER's search index, and IMPORT's force-overwrite backups are all generated
run output (facet `skill-manager`), resolved the standard way — never hand-joined:

```bash
ROOT="$PWD"; while [ "$ROOT" != "/" ] && [ ! -d "$ROOT/.sidekicks" ]; do ROOT="$(dirname "$ROOT")"; done
RUNBASE="$(node "$ROOT/bin/sidekicks" scope run-base sk-skill-manager ${work_item:+"$work_item"} 2>/dev/null)" \
  || RUNBASE="$(node "$ROOT/bin/sidekicks" scope artifacts-base)/artifacts/runs/skill-manager"   # pre-v2 CLI fallback
ARTIFACTSDIR="${artifacts_dir:-$RUNBASE}"
```

This skill has no unit of work of its own — managing skills is not a card, mission, or plan — so
most runs resolve to `_adhoc/sk-skill-manager/` by default; pass `work_item=<slug>` (both
scripts accept `--work-item`) only when a run is part of a larger tracked work item (e.g. a
skill-improvement pass driven from a Jira card). Runs written before runs layout v2 stay frozen at
`<artifacts-base>/artifacts/runs/skill-manager/` — valid read and resume targets, never write
targets.

## Mode routing

| The ask | Mode |
|---|---|
| "create a new skill", "I need a skill that does X" | **CREATE** |
| "is this skill built right", "add work_dir to X", "which anchors does X need" | **ARCHITECT** |
| "check my skills", "is X liftable", "why is doctor complaining" | **VALIDATE** |
| "X is broken", "reinstall X's dependencies", "restore X" | **HEAL** |
| "set up a new skills repo", "initialize a skills repository", "I need a second/private skills repo", "scaffold a destination" | **BOOTSTRAP** |
| "publish X to the skills repo" | **EXPORT** |
| "is there a skill for X", "I need something that can do X", "find me a skill that…", "nothing here does X" | **DISCOVER** |
| "pull X from the skills repo", "install skill X here" | **IMPORT** |
| "import this GitHub skills repo", "adopt X from the marketplace", "can we use someone else's skill here" | **IMPORT → ADOPT** |
| "delete skill X", "uninstall X", "remove X from this repo", "get rid of X for good" | **REMOVE** (local) |
| "unpublish X", "retract X from the skills repo", "X should not be published any more" | **REMOVE** (`--destination`) |
| "park X", "archive X", "turn X off but keep the files" | **OFFLOAD** — the verb is here, the judgement is `sk-skill-offload`'s |
| "where did X come from", "what did importing X turn on here", "which skills are not ours" | **REGISTRY** |
| "what's published where", "is the skills repo up to date", "did we ever export X" | **DESTINATIONS** |
| "what needs re-exporting", "what changed since I last published", "let me pick which skills to publish", "give me a list to choose from" | **REVIEW** |
| "what else do I need for X", "what depends on X", "I want the bmad skills" | **ADVISE** |
| "regenerate the modular category doc" | **CATALOG** |

Ambiguous between EXPORT and packaging? Ask once: *"Do you want these skills published to the
skills repository, or a portable runtime package?"* — the second is `sk-packager`.

---

## CREATE

1. **Decide it should exist.** Most "new skill" ideas are a missing verb on an existing skill.
   The signal that a skill is right-sized is that its `description` can say what it is **not**
   for and name the sibling that owns that instead. Read the neighbours first —
   `sidekicks skill list` and `docs/skill-modular-category.md` §2 for the families.
2. **Author it through `skill-creator`.** Invoke that skill; do not hand-write the folder file
   by file. `scripts/init_skill.py <name> --path .agents/skills [--resources …]` scaffolds
   it. Then **delete `agents/`** — that is a Codex-UI artifact, and only 4 of this repo's 120
   skills carry one, so it is not a convention here.
3. **Wire it, in the same change.** This is the part a scaffold cannot do, and skipping any leg
   trips a repo-wide test:

   | Leg | Where | Trips if skipped |
   |---|---|---|
   | audit group membership | `sk-skill-auditor/assets/audit-groups.yaml` | the skill is silently unaudited — omission *is* the opt-out |
   | dependency manifest | `sidekicks skill manifest <name> --apply`, then hand-write every `TODO` | `manifest-missing`, `manifest-todo` |
   | every **criterion** the skill owns, declared in `skill.yaml` `rules:` | the skill's own folder, body in `rules/<id>.md` | `framework doctor` → `entry-unlisted`; `skill doctor` → `undeclared-criterion` |
   | every **tunable value**, declared in `skill.yaml` `config:` + `config.defaults.yaml` | the skill's own folder | `skill doctor` → `hardcoded-default`; `config doctor` → `defaults-undeclared` |
   | `sidekicks framework sync` | `.sidekicks/config/settings/` | `tests/framework-cli.test.mjs` |
   | `sidekicks config sync` | the scope's `config/<family>.yaml` | `tests/config-sync.test.mjs` |
   | a Category-1 skill also joins §1 **and** the `framework` preset | `docs/skill-modular-category.md`, `sk-inherit/assets/presets.yaml` | `tests/skills/inherit-framework-preset.test.mjs` |
   | the anchors | see **ARCHITECT** | nothing today — which is why ARCHITECT exists |
   | destination intent, **only when the skill must not go everywhere** | `skill_repo: <name>` \| `none` in the skill's own `skill.yaml` | nothing — but a private skill with no intent is publishable to a public tree by accident |

4. **Gate it** with the VALIDATE sequence below before committing.

A skill that owns a rule keeps the body **inside its own folder** (`rules/<id>.md`), because a
lifted copy has to carry it — `tests/framework-export.test.mjs` asserts exactly that. A skill
may **not** redeclare a framework-core entry; to co-own one, add the skill to its `owners[]` in
`lib/framework-settings/core-registry.mjs`.

### Settings vs configuration — the gate every mode below applies

Full contract: [docs/guide/settings-vs-configuration.md](../../../docs/guide/settings-vs-configuration.md).
The decision rule, applied to every skill this mode creates or reviews:

> **If the answer is `true`/`false` and a user could reasonably want the behaviour off, it is a
> *setting*. If it is a number, string, path, list or credential, it is *configuration*.**

| | Settings | Configuration |
|---|---|---|
| Declared in | `skill.yaml` → `rules:` (+ body in `rules/<id>.md`) | `skill.yaml` → `config:` (+ `config.defaults.yaml`) |
| Lands in | `.sidekicks/config/settings/{rules,criteria,hooks}.yaml` | `.sidekicks/config/<family>.yaml` (+ git-ignored `.secret.yaml`) |
| Materialised by | `sidekicks framework sync` | `sidekicks config sync` |

Three failures to refuse, every time:

1. **A tunable literal in a script or SKILL.md.** `MAX_RETRIES = 5` in code is a value nobody can
   change per project. Move it to `config.defaults.yaml`, declare the block, and read it with
   `sidekicks config get <block> --json` — never by parsing the YAML in the skill.
2. **A policy stated only in SKILL.md prose.** "This skill ALWAYS posts a report" cannot be listed,
   reviewed or switched off. Declare `criterion.<skill-slug>`, move the prose to `rules/<id>.md`,
   and leave a one-line reference behind.
3. **A credential in a committed file.** `config.defaults.yaml` and the family file carry the key
   with an EMPTY value; only the git-ignored `<family>.secret.yaml` carries the value.

Two things this gate does **not** ask for. A **hard stop is not a setting** — anything on the safety
floor (`lib/framework-settings/floor.mjs`) stays where it is and never becomes a toggle. And a block
that is **empty by design** (keyed by an alias only the operator knows, like `slack:` or
`confluence:`) is correct as `{}` — record why in the descriptor comment so
`defaults-undeclared` reads as answered rather than pending.

**When the answer is "this is not declarable", record it — do not leave the notice standing.** Four
kinds qualify, and nothing else: a hard stop (Rule 4, prod, a credential); a restatement of a rule
the framework already owns ("Python is ALWAYS the repo-root `.venv`"); a required output shape a
downstream parser depends on; and a constant that only looks like a knob (a schema identity, a limit
the host imposes, a value already configurable one layer out). Each goes in the descriptor with its
reason:

```yaml
settings_split:
  policy_exempt:
    - quote: "NEVER connect to, query, or execute against a live database"
      why: "a hard stop under Rule 4 — generation reads a committed schema capture, and execution is the user's separately approved step."
  tunable_exempt:
    - name: MAX_SKILL_NAME_LENGTH
      why: "a limit the host CLI imposes, not a knob this repo may choose."
```

`why` is **required** — an exemption without one is a suppression, and the reader rejects it. Write
it on **one quoted line**: `lib/yaml-subset` does not fold `>-` inside a list item, and the reader
rejects that shape rather than let it swallow the entry after it. Matching is by TEXT, so an
exemption lapses when the sentence it excuses is reworded — that is deliberate.

**Never add `settings_split:` to a skill this repo did not author.** An externally-installed skill
never signed the contract and the next reinstall discards the edit; its findings stay reported, and
the fix belongs upstream or in a deliberate fork.

## ARCHITECT

Judgment work, on demand — deliberately **not** a repo-wide audit check. A new notice firing
across dozens of the 120 skills would fight the shrink-only ratchet in
`lib/skill-lifecycle/known-gaps.mjs` (`RECORDED_MAX` may only be lowered), and "does *this*
skill need an anchor at all" needs intent, not a grep.

Read [docs/guide/authoring-scope-aware-skills.md](../../../docs/guide/authoring-scope-aware-skills.md)
for the preamble; do not paraphrase it here. Then check the four things that actually go wrong:

1. **Does it need anchors at all?** A skill that reads and writes artifacts takes `work_dir=`;
   one that touches planning prose takes `docs_dir=` and must propagate it to every sub-skill;
   one that generates executable output or run state takes `artifacts_dir=`. A skill that only
   drives a CLI verb against an external `--output` path takes none — `sk-packager` says
   so in its own description, which is the pattern to copy.
2. **Is `RUNBASE` its own?** `artifacts/runs/<skill-id>/…` must name **this** skill. A
   copy-pasted preamble carrying another skill's id is the observed failure mode, and it silently
   files one skill's runs under another's.
3. **Is anything stacked?** `artifacts/runs/<skill-id>/runs/<engine>/…` is forbidden and nothing
   currently enforces it.
4. **`run_dir` is not a scope anchor.** It is an engine run-folder parameter, alongside
   `queue_dir` and `knowledge_dir` — a caller-owned folder for a mission ledger or a queue, which
   defaults off `$ARTIFACTSDIR`. Do not "fix" a skill by promoting it to an anchor.

Apply a repair through `sk-self-improve` → `skill-creator`. Never hand-edit the target
skill; that rule is the funnel's, and it applies to this skill too.

## VALIDATE

```sh
node bin/sidekicks skill doctor <skill>        # drift: undeclared deps, stale baseline, derived drift
node bin/sidekicks skill verify <skill>        # integrity: is what it DECLARED present and unchanged
node bin/sidekicks skill show <skill>          # declared vs detected, with file:line evidence per edge
node bin/sidekicks skill manifest <skill> --apply   # then AGAIN — the second run must produce no diff
node bin/sidekicks framework doctor            # registry + wiring drift, unlisted entries
node bin/sidekicks framework config <skill>    # the effective config, and which layer decided it
node bin/sidekicks config doctor               # undeclared blocks, credentials in committed files
node bin/sidekicks config sync --check         # is every declared block documented in this scope
```

Reading the output:

- **`verify` vs `doctor`.** `verify` asks only "is what this skill declared present and
  unchanged"; `doctor` asks "has everything been declared yet". That split is what lets `verify`
  be a hard gate while the declaration backfill drains through `doctor`'s notices.
- **`manifest-todo` is a question, not a bug.** Three fields cannot be derived from code —
  `optional`, `install_hint`, `degraded`. Write the sentence; inventing plausible text there
  launders an unanswered question into a passing gate.
- **Do not gate on `skill manifest --all --check`.** It exits 2 today: eight vendor skills have
  a manifest pending `create`. Gate on the skill you touched.
- **`hardcoded-default` and `undeclared-criterion` are the split's backfill.** Both are notices
  with file:line evidence, and both mean the same thing: something is baked into the skill that
  belongs in a declaration. Act on them here — they are the whole reason the CREATE gate exists.
  They never fail a build, because a heuristic that gates CI across every skill is a gate nobody
  can pass; that does not make them optional when you are already editing the skill. Coverage is
  **per item**: declaring one block does not silence the skill's other literals, and declaring one
  criterion does not silence its other policies. A finding is answered by declaring the key, by
  removing the policy from SKILL.md, or by a recorded `settings_split:` exemption with its reason —
  never by leaving it standing.
- **`defaults-undeclared` is a question.** A block with no defaults resolves to nothing unless a
  scope configures it. Either add `config.defaults.yaml`, or record in the descriptor comment why
  the block is empty by design — an answered question reads differently from a pending one.
- **Deep quality review is not this skill's job** — hand a rubric critique to
  `sk-skill-auditor`, which owns the coverage groups and the eval loop.

## HEAL

```sh
node bin/sidekicks skill heal <skill>                      # report: what it would install
node bin/sidekicks skill heal <skill> --restore            # also: what it would put back
node bin/sidekicks skill heal <skill> --restore --apply    # do it
```

Reports by default; writes only on `--apply`. Two lanes: install `requires.python` into the
single repo-root `.venv` (a skill's own `requirements.txt` wins, because it carries the `==`
pins), and `--restore` recorded `bundle{}` content from git, verified against the recorded hash
before anything is written.

Three things to explain rather than work around:

- **A hash mismatch without `--restore` is deliberate.** Heal hands the ambiguity back because
  the edit may be the intended new state — then the right verb is `skill manifest --apply`, not
  a restore that reverts somebody's work. Decide which one the user meant; do not guess.
- **Residue is the answer, not a failure.** The four non-installable sections
  (`sibling_skills`, `host_paths`, `framework_files`, `framework_hooks`) come back with their
  `degraded:` sentence. Read it out — it says what the absence actually costs. A missing sibling
  is an **IMPORT**; a missing hook wiring is `sidekicks framework sync` plus Rule 6 propagation.
- **`no-content-source` means it is not repairable here.** A lifted copy with no git has nowhere
  to read recorded content from. A lifted skill can be verified; it cannot be healed.

Heal never writes `skill.manifest.yaml`. If you want the current state recorded instead of
reverted, that is `skill manifest --apply` — the other half of the pair.

## BOOTSTRAP

A skills repository is not created by exporting into an empty directory. `skill export` writes
exactly three things — the skill folders, `meta/<name>/origin.yaml`, and a wholesale-regenerated
`catalog.yaml`; everything else is authored, and the README generators **fill** a scaffold rather
than create one. So `git init` + `skill export` produces a tree no generator will touch. Five legs,
in this order:

```sh
node bin/sidekicks skill repo init <path> [--private] [--name <n>] [--remote <url>] [--json]
```

1. **Scaffold.** The verb above writes `.gitignore`, `LICENSE`, `LAYOUT.md`, `README.md`,
   `.sidekicks/.gitkeep` (the root marker), `meta/.gitkeep`, one `categories/<family>/README.md` per
   family, and the variant-specific rollup file. Each file is written only when **absent** and the
   report says `created` or `kept` per path, so a re-run is legible and never re-templates prose
   somebody hand-edited. `<path>` is normally outside this repo.
2. **Create and push the git repository — the user's, not yours.** `repo init` deliberately does not
   run `git init`: creating and pushing a repository is outward-facing
   (`rule.irreversible-outward-confirm`). The report states `git_initialised: false` rather than
   leaving you to assume.
3. **Register the destination**, so `--destination <name>` resolves instead of a typed path:
   ```sh
   node bin/sidekicks config set skill_manager.skill_repo.<name>.remote   <url>  --root
   node bin/sidekicks config set skill_manager.skill_repo.<name>.checkout <path> --root
   ```
   `--root` is not optional when a user project is active — without it the destination lands in that
   project's `config/skills.yaml` and no other scope can see it. `source_repo:` is optional here and
   overrides `export.source_repo` for this destination only, which is how a public and a private
   destination get attributed differently. Never hand-edit `skills.yaml` (Rule 1).
4. **First real export** — that is **EXPORT** below, and it is what writes `catalog.yaml`.
   `repo init` never writes one: an empty repo with a stale catalog is worse than one with none,
   because `skill destinations` would compare against rows describing nothing.
5. **Fill the generated regions**, which ship empty but correctly marked:
   ```sh
   node .agents/skills/sk-skill-manager/scripts/skill-repo-readmes-public.mjs  --dest <root>   # or
   node .agents/skills/sk-skill-manager/scripts/skill-repo-readmes-private.mjs --dest <root>
   node .agents/skills/sk-skill-manager/scripts/skill-repo-not-carried.mjs --report <export.json> --out <root>
   ```
   `skill-repo-not-carried.mjs` is public-only, and reads the **real** (non-dry-run) export's own
   `--json` report — a dry run's report describes a copy that never happened. Then verify:
   `skill destinations --destination <name>`.

Three things to explain rather than work around:

- **`--private` is a variant, not a fork.** The two share every template except the licence, the
  private-only sections of `LAYOUT.md`/`README.md`, and `NOT-CARRIED.md` (public — generated from an
  export report) versus `meta/export-notes.md` (private — prose about why a skill is private, which
  no report can derive). Two forked template sets is exactly how the two published repos once
  drifted into different README region topologies.
- **The path is the authorization, with one refusal.** `<path>` is not `assertWritable()`-checked —
  the same treatment `skill export --output` and `sk-inherit --target` get. What *is* refused is a
  path resolving inside this repo's own `.sidekicks/` or `.agents/skills/`: scaffolding into the tree
  the exporter reads would corrupt the source.
- **Never let the new repo ignore `.agents/skills`.** From layout 2 on that is where published skills
  land, so ignoring it stages zero skill folders while the export truly reports every one written —
  silent and total. The bundled `assets/repo-templates/gitignore` is correct (it ignores only the
  three exposure links). If a repo was forged before that fix, test the outcome —
  `git -C <root> add -An` — not the file.

The on-disk contract is [references/skill-repo-layout.md](references/skill-repo-layout.md) §3c;
which repo a given skill may be published to at all is
[references/publication-split.md](references/publication-split.md).

## EXPORT

```sh
node bin/sidekicks skill export <skill>… | --category <family> | --preset <p> [--with-deps] [--dry-run]
                                          [--destination <name> | --output <path>] [--source-repo <url>]
```

**Always `--dry-run` first.** The interesting output is not "it copied 21 folders", it is the two
lists underneath: what the closure pulled in, and what does **not** travel. Read both aloud to the
user before writing anything.

Arriving here without a named skill — "export what's changed", "publish the updates" — means the
selection has not been made yet. That is **REVIEW**; run it and come back with the picks. Dry-run
is a copy plan, not a diff: it says *how many files travel*, never *what changed inside them*, so
it cannot stand in for the review.

- **Publish a family with `--category <family>`, never `--preset`.** A **category** is what a
  *repository* publishes; a **preset** is what a *runtime* carries, and a preset may legitimately
  include vendored skills that travel into a runtime but may not be republished (`--preset framework`
  carries `skill-creator`). The intent gate refuses a preset-driven publish — correctly, but only
  after the wrong command was typed. Families and their membership:
  [assets/categories.yaml](assets/categories.yaml).
- **`--with-deps` carries the declared sibling closure**, transitively. Without it, siblings are
  reported and not carried — the choice stays the caller's, because a deliberately partial export
  (one family, to be merged with another) is legitimate.
- **Prefer `--destination <name>` over a typed `--output` path.** There is more than one skills
  repository (`skill_manager.skill_repo:` is a map — `public`, `private`, …), and a bare path cannot
  answer *"may this skill be published here"*. The name resolves to that destination's `checkout:`
  and switches on the intent gate below. An `--output` that happens to land on a configured checkout
  is recognised as that destination anyway, so the gate is not bypassable by typing the path; the two
  flags are mutually exclusive.
- **Destination intent is enforced, per skill.** A skill's own `skill.yaml` may declare
  `skill_repo: <destination-name>` (publishable only there) or `skill_repo: none` (published
  nowhere). Export refuses rather than publishing against it. **Unset is not `none`** — unset means
  nobody has declared an intent and the skill exports anywhere, which is exactly the distinction that
  separates a deliberately withheld skill from one nobody has gotten around to publishing. Every
  vendored skill carries `skill_repo: none`; add it in the same change that vendors one
  ([references/publication-split.md](references/publication-split.md)).
- **Named ≠ reached.** A withheld skill the caller **named** is a hard refusal. One the **closure**
  pulled in via `--with-deps` is dropped and listed under `withheld` instead, because vendored work
  is routinely a legitimate dependency of publishable skills — the framework family declares
  `skill-creator` — and refusing there would mean that family could never be published at all. Read
  the `withheld` list to the user: it names what a consumer of the destination must obtain elsewhere.
- **Export refuses a stale tree.** If a skill's `bundle{}` no longer matches disk, exporting would
  just relocate the drift. Fix it first, and the fix is a decision: `skill heal --restore --apply`
  to put the recorded content back, or `skill manifest --apply` to record the current state.
- **`[no baseline: copy is UNVERIFIED]`** means that skill ships no manifest, so the copy fell back
  to a directory walk. Say so rather than implying it was checked.
- **Both halves of the split travel; a scope's values never do.** `skill.yaml`, every `rules/*.md`
  body and `config.defaults.yaml` are inside the skill folder, which *is* the export set, and they
  are recorded in the manifest as `requires.framework_rules` and `requires.config`. What must NOT
  appear in an export is a `config/<family>.yaml` or any `*.secret.yaml` — those are the HOST's
  configured values, not the skill's defaults. If you ever see one in a dry-run listing, stop: the
  export is carrying credentials.
- **Re-record before exporting a skill whose criteria changed.** `requires.framework_rules` is
  DERIVED from `skill.yaml`; a stale copy is a `derived-drift` error, and export refuses a stale
  tree anyway. `sidekicks skill manifest <skill> --apply` first.
- **The "does NOT travel" list is the handover.** Repo-root files, hooks (plus wiring in four CLI
  configs — Rule 6), host paths and binaries are the destination's business. They are copied into
  `meta/<skill>/framework/` as **reference only**, never applied.
- **Provenance comes from config; check it, do not retype it.** `source_repo` lands in the
  destination's `catalog.yaml` and in every `meta/<skill>/origin.yaml`, so it must name a repo a
  reader of a *published* tree can actually reach — the framework core, never the private working
  repo the export happened to run in. Resolution, most specific first:

  | | Source | When to use it |
  |---|---|---|
  | 1 | `--source-repo <url>` | a one-off; `--source-repo=''` records no source repo at all |
  | 2 | the destination's own `source_repo:` | public and private attributed differently |
  | 3 | `skill_manager.export.source_repo` | the normal answer — already configured |
  | 4 | this repo's git remote | only when nothing above is set |

  Layers 2 and 3 exist because this was once flag-only, and one export run without the flag
  published the private working repo's URL across `catalog.yaml` and every `origin.yaml`. **Always
  read `source_repo` back from the `--json` report before committing the destination** — the
  provenance is published bytes, and a wrong one is only visible there.

**Never push from a verb, and the verb cannot** — it imports only read-only git helpers. The
operator commits and pushes, to a **branch**, after reading the diff. Never to `sidekicks-skills`'
`main`.

Full repository contract: [references/skill-repo-layout.md](references/skill-repo-layout.md).

## DESTINATIONS

```sh
node bin/sidekicks skill destinations [<skill>] [--destination <name>] [--json]
```

**Export is one-way and records nothing back here.** It reads no destination state, so the source
repo holds no trace of what was published where — "is the skills repo current?" is not answerable
from a memory this repo keeps. This verb answers it by **derivation**: it reads each configured
checkout's `catalog.yaml` and `meta/<skill>/origin.yaml` and compares the copies against the local
bundle baseline, byte for byte. Nothing new is maintained by hand, so nothing new can go stale.

| Status | Meaning |
|---|---|
| `in-sync` | the destination's copy is byte-identical to what an export would write today |
| `stale` | it differs — files changed, missing there, **or left behind** (export never deletes) |
| `retracted` | it **was** published there and was withdrawn (`skill remove --destination`) — read from the `meta/<skill>/origin.yaml` tombstone |
| `never-exported` | this repo has the skill; that destination does not, and never did |
| `destination-only` | that destination carries a skill this repo does not have |
| `unreachable` | the destination's `checkout:` is unset or absent — nothing to compare, never read as "not exported" |

Read it before an update export (what actually needs republishing) and after one (did the diff land
where you thought). A `stale` row listing files *left behind* is the failure mode a git diff cannot
show you: `copyBundle` only writes, so a file deleted from a skill lingers at the destination
forever.

## REVIEW

The **operator picks; the agent does the reading.** DESTINATIONS answers *which* skills drifted;
this mode answers *what changed inside each one*, turns it into a tickable pick list, and turns the
ticks back into export commands. Four steps, in order — do not skip to EXPORT.

**1. Build the pick list.** One call — it wraps `skill destinations --json`, so do not run that
first as well:

```sh
node .agents/skills/sk-skill-manager/scripts/export-picklist.mjs plan \
  [--destination <name>] [--stale-only] [--all] [--out <dir>] [--json]
```

It writes `picklist.md` (the checkboxes) and `picklist.json` (the machine record) under
`$ARTIFACTSDIR/export-review-<stamp>/`; `artifacts_dir=` from the caller maps to `--out` (and
`work_item=` maps to `--work-item`). Two sections, kept apart on purpose:

- **§1 re-export candidates** — `stale` rows, each carrying its version delta, changed/new/left-behind
  counts, a dirty-tree flag and the exact `diff -ru` command.
- **§2 never published anywhere** — `never-exported` with no `intent`. "We have not published it
  yet" and "our published copy is out of date" are different questions and only the second has an
  obvious answer, so never fold §2 into §1.

Rows the script hides — a skill already `in-sync` at another destination, one whose `intent` points
elsewhere, one that exists only at the destination — land under *Suppressed* with the reason.
`--all` lists them inline. `destination-only` and `unreachable` are reported, never offered.

**2. Read the diff for every §1 row before offering it.** The row prints the command; the content
lives at the destination checkout, laid out the same as here. **Summarise the behaviour change**:
what a consumer of the published copy gets that they did not have. Pasting the raw diff back is not
a review — it hands the reading job straight back to the operator, which is the thing this mode
exists to prevent.

The script flags the three things that change the decision; explain each one it raised rather than
repeating the flag:

- **`left behind` files.** Export never deletes, so a file removed here lingers at the destination
  forever. They must be removed **at the destination by hand** — a report that omits them describes
  a re-export as complete when it is not.
- **`UNCOMMITTED`.** Export copies what is on disk but records the current commit as `source_commit`
  in the destination's `origin.yaml`, so exporting a dirty tree publishes bytes attributed to a
  commit that does not contain them. Committing first is the fix, not a nicety.
- **`VERSION UNCHANGED`.** A changed body under an unchanged version means the bump was forgotten —
  the published copy will look current to everything that reads the version.

**3. Present the picks and get the ticks.** Show one row per candidate — skill, destination, version
delta, the one-sentence behaviour change, and any flag from step 2 — then either let the user tick
`[x]` in `picklist.md` themselves, or tick it for them from their answer in chat. Offer the sweep
("all of them") as an option, never as the default. §2 rows are asked about separately; a skill the
user wants withheld permanently gets `skill_repo: none` in its own `skill.yaml`, which is a skill
edit through the improvement funnel, not a checkbox here.

**4. Resolve the ticks, then export.**

```sh
node .agents/skills/sk-skill-manager/scripts/export-picklist.mjs resolve <picklist-folder>
```

It prints one grouped `skill export` command per destination — `--dry-run` first, `--destination`,
`--with-deps` and `--source-repo` already filled from the resolved config — plus a warning per
picked row that is dirty, version-stale or leaving files behind. It **never exports**; run the
commands through **EXPORT**, dry-run first. Exit 3 means nothing was ticked. Afterwards re-run
`skill destinations`: every picked row must read `in-sync`, and one that does not is the export
having refused something you reported as done.

**Before ticking a row, run the split gate on it.** A review is the last cheap moment to catch a
skill that is about to publish a hard-coded tunable or an undeclared policy to another repo:

```sh
node bin/sidekicks skill doctor <skill>   # hardcoded-default / undeclared-criterion, with evidence
```

Both are notices, so nothing stops the export — which is why it has to be a human step here. A skill
whose behaviour is baked in exports that bakedness to every repo that imports it.

## DISCOVER

The intent-driven half of ADVISE. `skill advise <name>` takes **names**, so it only helps once you
already know what the thing is called; DISCOVER answers the question that comes first — *is there a
skill for this at all?* — by matching a plain-English task description against the `description`
frontmatter of every skill that exists in a configured destination but is not installed here.

```sh
node .agents/skills/sk-skill-manager/scripts/skill-search.mjs index [--destination <name>] [--out <dir>] [--json]
node .agents/skills/sk-skill-manager/scripts/skill-search.mjs find "<intent>" [--index <path>] [--limit <n>] [--json]
```

`find` builds the index in memory, so `index` is only needed to keep one (it writes
`search-index.json` under `$ARTIFACTSDIR/skill-search-<stamp>/`; `artifacts_dir=` maps to `--out`,
`work_item=` maps to `--work-item`). **Both search every configured destination by default** — narrow
with `--destination`, but do not assume public is the interesting one: on this repo public
contributes **zero** candidates (its whole catalog is installed) and all 18 live in `private`.

> **Nothing triggers this mode on a skill's *absence*.** An absent skill contributes no description
> to the context, so a bare "do X" with X's skill uninstalled degrades silently. DISCOVER fires when
> someone asks for it, or when the agent notices no local skill covers the ask. Deciding that is a
> judgment step, not an automatic one.

The steps:

1. **Confirm nothing local already covers it.** Check the installed skills first. Recommending an
   import when a present skill already does the job is this feature's main failure mode.
2. **Search** with `find "<intent>"`. Every result prints the terms that earned it — read those, not
   just the order. Exit 3 means nothing scored above the floor, and that is an answer: say nothing
   matched and treat CREATE as the next step, rather than offering the least-bad row.
3. **Read the top candidate's actual `SKILL.md`** at the path the result prints. A description match
   is a hint, not a verdict — the body says what the skill really does and what it explicitly is
   **not** for.
4. **Advise with the cost stated.** Name the skill, what it does, which destination it lives in
   (and whether it is `offloaded` there — parked deliberately, not merely unknown), its declared
   sibling closure, and the parts of the apply plan `skill import` prints but does **not** perform:
   repo-root files, hook wiring across four CLI configs (Rule 6), config-block values, audit-group
   membership.
5. **Hand over the import command**, then walk that printed plan with the user. An import that
   leaves `framework doctor` red is a failed import, not a finished one.

**Do not confuse this with the two existing safety nets**, which are manifest-driven and only ever
cover dependencies of skills that are already installed: **ADVISE** reports a *present* skill's
declared-but-missing siblings with their `degraded:` sentences, and **HEAL** surfaces those same
siblings as non-installable residue. Neither can see a standalone skill nobody has installed —
that gap is what DISCOVER fills.

## IMPORT

```sh
node bin/sidekicks skill import <skill>… | --all --from <path> [--apply] [--force]
```

`--from` takes a path, so name the destination's configured `checkout:` — read them out of
`skill_manager.skill_repo:` (`sidekicks framework config sk-skill-manager`) rather than
retyping a clone path from memory, which is how a skill gets imported from the wrong repository.

**Read the statuses before reaching for `--force`.** Four of the seven mean *stop*, and one of those
is never importable at all:

| Status | What it means | What to do |
|---|---|---|
| `new` | not here yet | import it |
| `ff` | nothing recorded here would be lost | clean fast-forward, import it |
| `up-to-date` | identical baselines, or byte-identical content | nothing |
| `conflict` | **both** sides moved | resolve the difference; `--force` discards the local side |
| `local-only` | local has work the export predates | usually EXPORT instead |
| `unversioned` | no baseline can attribute the difference, or the closure is undeclared | investigate |
| `broken` | the incoming copy contradicts its own manifest | **`--force` does not open this** — re-export it at the source |

**A missing manifest is not automatically a problem.** `manifestRequired()` says a skill with no
`scripts/`, no third-party import, no sibling edge, no binary and no `skill.yaml` needs none, and
`skill doctor` agrees. Those rows reconcile on file CONTENT and every row says whether its file list
came from a recorded baseline (`verified: false` in `--json`, `(unverified)` in the report). What
still stops is `unversioned` for a skill that *does* need a manifest and has not got one — its
dependency closure is genuinely unknown.

A `--force` overwrite always backs the previous copy up under
`$ARTIFACTSDIR/backups/<stamp>/<skill>/` first, and the report names the path. That
backup is the only thing that makes a wrong import recoverable — say where it went.

**The verb writes nothing outside `.sidekicks/`, deliberately.** It prints an ordered apply plan
instead: repo-root files, hook wiring across all four CLI configs (Rule 6), the criteria and config
blocks the incoming skills brought, audit-group membership, then `framework sync` → `config sync` →
`skill manifest <name> --apply` → `skill doctor` → `skill heal --apply`. Walk that plan with the
user; an import that leaves `framework doctor` red is a failed import, not a finished one.

**An imported criterion arrives ENABLED — say so out loud.** An unlisted id resolves to the built-in
default, and `framework sync` then writes it as `true`, so importing a skill turns its policies on in
this repo unless someone decides otherwise. The apply plan names each one with the
`sidekicks framework disable <id>` that turns it off; do not skim past those lines. Its config block
is the gentler half: `config sync` documents it INERT, so it keeps resolving to the skill's own
defaults until a key is uncommented or `config set` overrides one.

**Every applied row writes a registration profile** under `.sidekicks/registry/skills/<name>.yaml` —
where it came from, which criteria the import turned on *here*, whether it was converted. That is
what `skill remove` later reads; see **REGISTRY** below.

Full reconcile contract: [references/skill-repo-layout.md](references/skill-repo-layout.md) §6.

## IMPORT → ADOPT

`--from` no longer has to be a sidekicks skills repository. Point it at any repo that holds skills —
an Anthropic-style `skills/<name>/`, a category-nested tree, a bare `.claude/skills/`, a plugin
marketplace — and the layout is detected. **Look before you convert:**

```sh
node bin/sidekicks skill import --list --from <path>            # no --adopt needed; writes nothing
node bin/sidekicks skill import <skill> --adopt --from <path>   # plan
node bin/sidekicks skill import <skill> --adopt --from <path> --apply
```

`--adopt` is mandatory for any non-sidekicks layout, because importing from one CONVERTS a
third-party skill into this repo. Ambiguity between two layouts is an error naming both; settle it
with `--layout`. A name that already exists here is refused rather than merged — the two folders
share a name and no history — so pass `--rename <upstream>=<local>`.

**Conversion synthesizes nothing.** The folder is copied byte-exact, which is what lets a later
re-import reconcile as `up-to-date` instead of as a conflict that can never be resolved. No
`skill.yaml` is written (its `rules:`/`hooks:`/`config:` are claims about *this* repo that only a
human may make, and an otherwise-empty descriptor would force a ceremonial manifest), no frontmatter
is corrected — a `name:` that disagrees with the folder is reported, and the folder wins.

Walk the plan it prints. Four things routinely need you: the manifest (`skill manifest <name>
--apply`, then answer its `TODO`s), python dependencies (`skill heal <name> --apply`, into the
single repo-root `.venv`, which it will not create for you), attribution (a licence at the source
ROOT does not travel — import never writes outside `.sidekicks/`), and whether a skill you did not
write is yours to republish (`skill_repo: none`).

> **Where should a third-party skill land?** `skill doctor` is a CI gate over THIS repo, so adopting
> a pile of foreign skills here turns it red with findings nobody intends to fix. Adopt into the
> consumer repo that needs them, or park them on arrival with `--into skill-offloaded`.

Full contract — every probe rule, every gate, what conversion refuses to synthesize, and how to add a
sixth layout: [docs/guide/skill-import-adapters.md](../../../docs/guide/skill-import-adapters.md).

## REGISTRY

```sh
node bin/sidekicks skill registry [<skill>] [--check] [--json]
node bin/sidekicks skill registry --backfill --assume-imported <skill> --apply
```

The receipt an import leaves. It records what is **not derivable afterwards** — source repo, commit
and path, the layout adapter, whether it was converted, which framework ids the import enabled *in
this repo*, the licence, and the as-installed file hashes. It deliberately records nothing already
answerable from `bundle{}`, `catalog.yaml` or `origin.yaml`.

`--check` recomputes the mirrored half from disk; **where they disagree, the filesystem is right.**
A skill with no profile reads `untracked` and never fails a check — most skills here were authored
here. `--backfill` needs `--assume-imported` because nothing on disk says which direction a skill
travelled (`skill export` writes to a destination too), and it writes `unknown` for everything it
cannot know rather than guessing.

## OFFLOAD

```sh
node bin/sidekicks skill offload <skill> [--apply] [--restore] [--list] [--force]
```

**OFFLOAD parks — it is not REMOVE**, and the difference is easy to get wrong. The skill moves to
`.sidekicks/skill-offloaded/` and discovery stops loading it, but the offloaded tree is inside
`SKILL_TREES` **on purpose** — so its rule ids stay listed, its config block stays discoverable and
its hook stays wired. Reversible with `--restore`. The judgement around it (when to park, when a
blocker means rework instead) belongs to `sk-skill-offload`; this is only the engine.

## REMOVE

```sh
node bin/sidekicks skill remove <skill> [--apply] [--purge-profile] [--json]     # from this repo
node bin/sidekicks skill remove <skill> --destination <name> [--apply] [--force] # from a skills repo
```

Two modes, because "remove skill X" is one intent with two halves — deleting it here does **not**
retract the copy already published to a skills repository, and `skill export` has no delete path at
all (`copyBundle` only writes). Ask which one is meant when the user has not said.

**Dry run is the default; `--apply` executes.** The opposite of EXPORT, and deliberately — this
verb destroys an original. Read the plan aloud before applying: the interesting part is never "it
deleted a folder", it is the residue list underneath.

### Local

This is the exact reverse of CREATE's wiring table — and, for a skill that came from elsewhere, of
IMPORT's. It unwires as much of both as a verb safely can:

| Leg | Done by `--apply` |
|---|---|
| the skill folder | deleted, after a full copy to `artifacts/runs/skill-manager/backups/<stamp>/<skill>/` |
| `audit-groups.yaml`, `presets.yaml`, `categories.yaml` | the `- <name>` line dropped from each container it sits in |
| rule / criterion entries in `.sidekicks/config/settings/` | pruned |
| its config block | parked as `pending-removal.<family>.yaml` in every scope that carried it — never deleted |
| its registration receipt | retired to `.sidekicks/registry/skills/removed/<skill>.yaml` — see below |
| hook wiring in the four CLI configs | **reported, never edited** — see below |
| CLAUDE.md prose, docs, another skill's `depends-on` | **reported, never edited** |

- **The required floor is not removable, and `--force` does not open that door.** The five skills in
  `sk-inherit/assets/presets.yaml` → `required:` travel into every forged runtime whatever
  the operator selected; removing one produces runtimes that cannot manage themselves.
- **The receipt becomes a tombstone, not a deletion.** For an imported skill it is the only record
  of where the skill came from and what its import turned on here, so retiring it keeps a later
  re-import able to see the skill was here before. `--purge-profile` drops it outright instead.
  A skill authored here has no receipt, and the report says so rather than treating it as a fault —
  when there is none, everything in the plan is derived from the skill's declarations on disk.
  `--purge-profile` is refused alongside `--destination`: the receipt is a record about **this**
  repo, and a retraction neither reads nor writes it.
- **The prune legs run in process** — one `--apply` leaves `framework doctor` and `config doctor`
  clean, rather than handing back a checklist that leaves the repo red until someone walks it.
- **Hook wiring is the one leg left to a human.** It spans JSON and TOML across four configs
  (Rule 6) and the hook's registry entry lives in `lib/framework-settings/core-registry.mjs`,
  outside the skill folder — so it survives the delete regardless. Same stance IMPORT takes, for the
  same reason. The report names each file to edit.
- **An emptied audit group or `members:` list is left standing and named.** An empty group audits
  nothing and an empty `members:` falls back to the audit group — neither is a defect, and presets
  ship a deliberately empty `delegates:`, so a pruner could not tell those apart.
- **Residue is a report, not a gate.** `git grep` for the name, minus the skill's own folder and
  `artifacts/runs/` (a run record is frozen history — editing one to erase a name falsifies it).
  Walk the list with the user; those edits are theirs to make.

### Destination

Retracts the published copy: the skill's folder, its `meta/<skill>/` contents, and its
`catalog.yaml` row (with `skill_count` decremented).

- **A tombstone is left behind on purpose.** `meta/<skill>/origin.yaml` is rewritten with
  `retracted: true`, `retracted_at:` and the last published version. Without it, a deliberate
  unpublish is indistinguishable from a skill nobody ever exported — `catalog.yaml` cannot carry the
  record because the next export regenerates it wholesale. After a retraction,
  `skill destinations` reports **`retracted`**.
- **A skill pinned to that destination needs `--force`.** `skill_repo: <name>` in its own
  `skill.yaml` means that repository is the only place it may live, so retracting it there
  unpublishes it entirely — a bigger decision than a republish. Unset and `none` do not trip the
  gate; neither makes a destination the skill's only home.
- **Never commits, never pushes** — EXPORT's rule, EXPORT's reason. The report prints the
  destination's `git status`; the operator reviews the diff and commits, to a **branch**.

## ADVISE

```sh
node bin/sidekicks skill advise <skill>… [--from <skills-repo-clone>]
```

**It takes names, not intents.** "What does *this* skill need" is this mode; "is there a skill for
*this task*" is **DISCOVER**.

Four buckets, **separate on purpose** — merging them is the mistake this mode exists to avoid,
because it would promote a "see also" to a hard requirement:

1. **required (declared)** — authoritative, from `requires.sibling_skills`. Carries `how:`,
   `scope:` and `degraded:`. When a sibling is MISSING, read its `degraded:` sentence out: that is
   the only place saying what the absence actually costs.
2. **comes along transitively** — what an import would additionally pull in. A different question
   from "what does this need", so never present it as the answer to that one.
3. **consider (detected, undeclared)** — the scanner's opinion. `wired` is a real edge someone
   forgot to declare (worth an improvement); `code-comment` is usually a provenance note. A `prose`
   mention is **not** a dependency and is not reported here at all.
4. **cannot be installed** — repo-root files, hooks (wiring in four CLI configs, Rule 6), host
   paths, binaries. State the cost; do not work around it.

`--from <clone>` adds the operational half — whether a missing sibling is **available in the skills
repository** — by reading that tree's generated `catalog.yaml` instead of cloning folders to find
out.

**bmad:** the family lists live in `audit-groups.yaml`, but the bmad agents and workflows are
**CLI plugin skills** (`bmad:bmm:agents:pm`, `bmad:bmm:workflows:prd`, …) — nothing under
`.agents/skills/` provides them and no scanner can see them. `advise` says so and points at
`git clone https://github.com/bmad-code-org/BMAD-METHOD.git`. Guidance only; never auto-install.

BMAD installs in **two halves**, and importing a bmad-family skill supplies neither: the command
stubs (`.claude/commands/bmad/**`, `.gemini/commands/bmad-*.toml`) and the `bmad/` module tree those
stubs load by `{project-root}`-relative path. Either can be present without the other — a mounted
framework core carries the stubs (`.claude/commands/` is core substrate) but not `bmad/`, so the
slash commands are offered and then fail at step 1. When advising a bmad import, say the install is
required and point at **`sk-hello`'s BMAD readiness row**, which distinguishes the three
states and prints the matching remedy; do not re-derive that diagnosis here. The install itself is
still the user's — upstream's installer is interactive.

## CATALOG

`docs/skill-modular-category.md` is this skill's to maintain, and the mechanical half is a script:

```sh
node .agents/skills/sk-skill-manager/scripts/category-doc.mjs --check   # exit 2 on drift
node .agents/skills/sk-skill-manager/scripts/category-doc.mjs --apply
```

It regenerates the header counts, §1, §3 and the Appendix, and is byte-stable — `--apply` over a
current doc changes nothing. What it will **not** do, each for a stated reason:

- **§2's family lists.** Its bullets carry hand-written annotations (`— needs sk-bmad`) that
  no scan produces, so a generator would delete them. Membership is gated by
  `tests/skills/skill-modular-category.test.mjs` instead, which is the useful half.
- **§4's modularity audit.** Judgement. The doc's own header records a machine pass that got a
  family verdict *wrong* until a human noticed shared `sprint-status.yaml` state.
- **Remove a §1 member the classification rule does not derive.** §1 is what
  `sk-inherit`'s `framework` preset forges, so deleting a line changes what a runtime is
  built from. The script reports it under "needing a human" and leaves it in place.

That last one is live: §1 lists 16 skills while the rule (`core` + `skill-improvement` + the
auditor) yields 15, because `sk-packager` sits in the `ops` group yet appears in §1. Either
the rule or the list is wrong — it is a taxonomy decision, so it is recorded rather than edited.
Do not "tidy" it without deciding it.

When you do edit §1, edit `sk-inherit/assets/presets.yaml`'s `framework` preset in the same
change: the preset must stay a superset of §1, and a test enforces it.

### Three taxonomies, and which question each answers

They overlap enough to be confused and are governed separately on purpose. Never edit one expecting
another to follow.

| Taxonomy | File | Answers | Changing it moves |
|---|---|---|---|
| **audit group** | `sk-skill-auditor/assets/audit-groups.yaml` | what the auditor sweeps together | audit coverage, and `first_party` in the catalog |
| **publication category** | [assets/categories.yaml](assets/categories.yaml) | what a reader browses together | `catalog.yaml`'s `category`, the `categories/<family>/` pages, `--category` |
| **runtime preset** | `sk-inherit/assets/presets.yaml` | what a forged runtime carries | what `inherit create` copies |

A category defaults to the skill's audit group, so 12 of the 13 families list no members at all. The
`framework` family is the one that must be explicit: its members audit under four different groups
and browse as one. That is the whole reason the publication layer is separate — before it, changing
what the public repo showed meant changing what the auditor swept.

Adding a family means adding it here **and** creating `categories/<name>/README.md` in each
destination repo: the generators fill a hand-authored scaffold and print `skip:` for a family whose
README is absent, so the skills would appear on no browse page at all.

## References

- [docs/guide/skill-import-adapters.md](../../../docs/guide/skill-import-adapters.md) — importing
  from a repository this framework did not lay out: the five layouts and their probe guards, the
  `--adopt`/`--layout`/`--rename`/`--into` gates, why conversion synthesizes nothing, and the
  registration receipt. Read it before touching `source-layout.mjs` or adding a layout.
- [references/skill-repo-layout.md](references/skill-repo-layout.md) — the `sidekicks-skills`
  repository contract, the reconcile status table, and what `package transfer` does not carry today.
- [references/publication-split.md](references/publication-split.md) — the standing rule for which
  skills go to which repository, and which are published nowhere.
- [assets/categories.yaml](assets/categories.yaml) — the publication families, their blurbs, and the
  explicit membership of the `framework` family.
- [scripts/export-picklist.mjs](scripts/export-picklist.mjs) — REVIEW's pick list: `plan` classifies
  and enriches the drift, `resolve` turns the ticks into export commands. Its header records what it
  refuses to do (summarise a diff, export, write a skill's intent) and why.
- [scripts/skill-search.mjs](scripts/skill-search.mjs) — DISCOVER's search: `index` inventories every
  skill available in a destination but not installed here, `find "<intent>"` ranks them by term
  match and prints the import command. It refuses to import, to write to a destination checkout, to
  use embeddings (the ranking has to be explainable), and to return a least-bad row below the floor.
- [docs/guide/skill-architecture.md](../../../docs/guide/skill-architecture.md) — the structure,
  the schema, every audit check. The authority; this file never restates it.
- [docs/guide/authoring-scope-aware-skills.md](../../../docs/guide/authoring-scope-aware-skills.md)
  — the anchor preamble ARCHITECT checks against.
- [docs/guide/framework-settings.md](../../../docs/guide/framework-settings.md) — rules,
  criteria, hooks, and the four config layers.
- [docs/guide/settings-vs-configuration.md](../../../docs/guide/settings-vs-configuration.md) — the
  contract every mode above gates on: which half a thing belongs in, how a skill declares each, the
  `framework sync` / `config sync` pair, and what travels on export versus what must never.
