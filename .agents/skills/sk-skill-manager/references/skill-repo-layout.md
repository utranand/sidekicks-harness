# The `sidekicks-skills` repository contract — layouts 1 to 3

Read this when exporting to or importing from `github.com/utranand/sidekicks-skills`, or when
deciding what has to travel with a skill by hand while `skill export` / `skill import` are still
being built.

**Layout 3 is what export writes today** (§3c) — since 2026-08-18. Layouts 1 (§3) and 2 (§3b) are
**historical, and still read, forever**: layout 1 describes every clone published before 2026-08-17,
layout 2 those written between 2026-08-17 and 2026-08-18. The differences are where the active skill
folders sit and whether the destination carries a parked tree, which layout 3 retires.

## Contents

1. [What a skill has to carry to be liftable](#1-what-a-skill-has-to-carry-to-be-liftable)
2. [What `package transfer` does NOT carry today](#2-what-package-transfer-does-not-carry-today)
3. [Layout 1](#3-layout-1)
3b. [Layout 2](#3b-layout-2)
3c. [Layout 3 — the current write target](#3c-layout-3--the-current-write-target)
4. [Why the sidecars sit outside the skill folder](#4-why-the-sidecars-sit-outside-the-skill-folder)
5. [Version-pinned Python dependencies](#5-version-pinned-python-dependencies)
6. [Importing: reconcile before you overwrite](#6-importing-reconcile-before-you-overwrite)

---

## 1. What a skill has to carry to be liftable

The manifest already answers this, which is the point: `skill.manifest.yaml` is the closure
declaration, so nothing here has to re-derive it.

| Travels inside the folder | Section |
|---|---|
| every file the baseline pins | `bundle{}` — LF-normalized sha256 per file, exhaustive except the manifest itself |
| pinned Python packages | the skill's own `requirements.txt`, itself a `bundle{}` entry |
| a rule body | `rules/<id>.md`, skill-relative — `tests/framework-export.test.mjs` asserts a lifted copy keeps it |
| non-secret config defaults | `config.defaults.yaml` |

| Does NOT travel — must be reconciled at the destination | Section |
|---|---|
| another skill in the same repo | `requires.sibling_skills` |
| a repo-root file the skill reads or runs | `requires.framework_files` |
| a hook body **and** its wiring in four per-CLI config files | `requires.framework_hooks` |
| something on the host machine | `requires.host_paths` |
| an external binary | `requires.binaries` |

Those five are exactly the sections the schema forces to carry a `degraded:` sentence (`host_paths`,
`sibling_skills`, `framework_files`, `framework_hooks`) or an `install_hint` (`binaries`) — because
the sentence is what tells the destination whether an absence is expected or a break. Read them out
when reporting an import; do not silently install past them.

## 2. What travels automatically, and what is still a handover

`sidekicks skill export` carries the recorded baseline plus, with `--with-deps`, the transitive
declared sibling closure. `sidekicks package transfer <skill> --with-deps` now computes the same
closure — both read `lib/skill-package/closure.mjs`, so they cannot disagree. (Until AAP-96 they
did: `transfer.mjs` skipped skills with the comment `// skills are self-contained`, which was untrue
of every skill carrying a manifest, and omitted siblings while reporting success.)

What is still a handover at the destination, because no copy can settle it:

- every `requires.framework_hooks` script's **wiring** in `.claude/settings.json`,
  `.codex/config.toml`, `.gemini/settings.json` and `.agent/settings.json` — Rule 6, all four in the
  same change, never one. The script BODY is exported into `meta/<skill>/framework/` as reference.
- every `requires.framework_files` path — the body is exported as reference, but whether the
  destination repo should carry that file is its own decision.
- a matching block in the destination's scope `config.yaml` when the skill needs real values (the
  skill's own non-secret `config.defaults.yaml` travels inside the folder).
- audit-group membership, or the skill lands unaudited at the destination.
- `requires.host_paths` and `requires.binaries` — the host's, by definition.

The check that tells you whether it worked is `skill verify` run **with the destination as repo
root** — it reads a manifest and hashes files, so it needs no git, no registry and no network. An
exported tree it calls clean is a tree that arrived intact.

## 3. Layout 1

> **Historical, and still read.** This is the shape of every clone published before 2026-08-17.
> `skill export` writes [layout 3](#3c-layout-3--the-current-write-target) now; the differences are
> where the skill folders sit and nothing else. Everything below about `meta/`, `catalog.yaml`,
> `categories/` and the sidecars applies unchanged to every layout.

The destination mirrors the shape `discoverSkills()` scanned when this layout was written —
`<root>/.sidekicks/skills` and `<root>/.sidekicks/skill-offloaded`. That is not cosmetic: it means
every existing engine (`readSkillManifest`, `scanSkill`, `auditSkills`, `skill verify`) works against
the skills repo verbatim by passing it as `repoRoot`, with no second code path to keep in step. Rule 3
later moved this repo's active tree to `.agents/skills`, which is what made layout 2 necessary — the
mirror is the property, and the path is only how it is spelled.

```
sidekicks-skills/
  LAYOUT.md                             the layout-1 contract, hand-authored once
  README.md                             generated
  catalog.yaml                          generated index — one row per skill, the file ADVISE reads
  .sidekicks/skills/<name>/             BYTE-IDENTICAL to the source skill folder
  .sidekicks/skill-offloaded/<name>/    reserved
  meta/<name>/
    origin.yaml                         schema, layout, skill, version, tree, source_repo, source_commit, source_branch, exported_at, bundle_verified, file_count, outside_edges, group, category
    requirements.lock.txt               `==` pins resolved from the source .venv at export time
    framework/<repo-relative-path>      REFERENCE copies of framework_files and hook bodies
  categories/<family>/README.md         browse page per family — links into .sidekicks/skills/,
                                        holds no skill content of its own
```

`catalog.yaml` exists so "what do I need for X" can be answered without cloning 84 skill folders.
Every field in it is derivable from `skill.manifest.yaml` + `skill.yaml` + `VERSION.json` +
`audit-groups.yaml` + `categories.yaml`, which is what makes it regenerable and therefore checkable
for staleness rather than hand-maintained and quietly wrong.

**`group` and `category` are two different taxonomies and both travel.** `group` is the AUDIT group
(what the skill-auditor sweeps together, and what `first_party` is derived from). `category` is the
PUBLICATION family (what `categories/<family>/README.md` lists, and what `skill export --category`
selects). A category defaults to the audit group, so they are identical for most skills; the
`framework` family is the exception that requires the split, since its members audit under
core/skill-improvement/ops/jira and browse as one. Membership and family blurbs live in the skill's
own [`assets/categories.yaml`](../assets/categories.yaml).

`categories/` carries **no skill content** — only a README per family linking into
`.sidekicks/skills/`. A category-nested skill folder would break the byte-identical copy and the
exposure links. It is a browse surface, regenerable from `catalog.yaml`, and safe to delete and
rebuild — except that the generators FILL a hand-authored scaffold rather than creating one, so a
new family needs its `categories/<name>/README.md` created in the destination in the same change.

`source_repo` in `catalog.yaml` and in every `origin.yaml` is **published provenance, not a local
fact**: it must name a repo a reader of the destination can reach — the published framework core,
never whatever working repo the export ran in. **Do not retype the URL from here**: read the resolved
value with `sidekicks framework config sk-skill-manager`, which is authoritative
(`config.defaults.yaml` -> `skill_manager.export.source_repo`, or a destination's own `source_repo:`).
It is currently `https://github.com/utranand/sidekicks-harness.git`; the earlier
`.../sidekicks-framework` name was retired on 2026-08-17 and now 404s. `skill export` resolves it from `--source-repo`, then the destination's own `source_repo:`,
then `skill_manager.export.source_repo`, then the source repo's git remote — so the normal case needs
no flag. Still check the `source_repo` echoed back in the `--json` report before committing: it was
flag-only once, and a single run without the flag published the private working repo's URL across
`catalog.yaml` and every `origin.yaml`.

`meta/<name>/framework/` is **reference only** — never auto-applied. A repo-root file and a hook are
the destination's business, and copying one in blind is how an import breaks a repo it was meant to
extend.

Two constraints on every generated YAML file here, both learned the hard way and both enforced by
the reader in `lib/yaml-subset/yaml.mjs`: no `&` or `*` anywhere on a line (comments included), and
**no block scalars** — `degraded: >-` parses as the literal string `">-"` and the folded body lines
are then read as *structure*, which inside a sequence swallows the following items. One long
single-quoted line per sentence, apostrophes doubled.

## 3b. Layout 2

> **Historical, and still read.** Written between 2026-08-17 and 2026-08-18. Superseded by
> [layout 3](#3c-layout-3--the-current-write-target), which retires the destination's parked tree.

Layout 2 moved one thing:

| | layout 1 | layout 2 |
|---|---|---|
| ACTIVE skill folders | `<root>/.sidekicks/skills/<name>/` | **`<root>/.agents/skills/<name>/`** |
| PARKED skill folders | `<root>/.sidekicks/skill-offloaded/<name>/` | unchanged |
| `meta/`, `catalog.yaml`, `categories/`, the hand-authored files | — | unchanged |

**Why.** Rule 3 made `.agents/skills/` the canonical, CLI-neutral skills location in this repo, and a
destination mirrors the shape `discoverSkills()` scans — that mirroring is what lets every engine
(`readSkillManifest`, `scanSkill`, `auditSkills`, `skill verify`) work against a skills repo verbatim
by passing its root as `repoRoot`, with no second code path. Once the source tree moved, layout 1
stopped being that mirror. The reforge onto fresh repositories was the moment to fix it: a repository
that does not exist yet has no consumers to break, and being born at the old layout guarantees
migrating it later.

**It is a MAP, not a prefix swap.** The two trees no longer share a parent, so nothing may take a
tree's basename and re-join it onto a fixed prefix — that resolves to a directory which does not exist
and reads **empty rather than failing**. The mapping lives in exactly one place,
`PUBLISHED_TREES` in `lib/skill-lifecycle/destinations.mjs`, and `publishedTreeFor()` **throws** on an
unmapped tree rather than guessing.

**Layout 1 is read forever.** Nothing branches on the stamped `layout:` value when reading — layout
detection is a filesystem probe (`NATIVE_TREE_PATHS` in `lib/skill-package/source-layout.mjs`,
`DEST_TREES` in `destinations.mjs`), and both lists carry both layouts with first-hit-wins. So an
older clone still imports and still reports status, with no migration. `DEST_TREES` is **derived**
from `PUBLISHED_TREES` with the layout-1 paths appended behind them, because read order must agree
with write order: a probe that found a layout-1 copy first would report status against a tree nothing
updates any more.

**The `.sidekicks/` root marker is written explicitly.** `resolveRepoRoot` identifies a repository
root by walking up for a `.sidekicks/` directory, and layout 1 satisfied that as a side effect of
putting skills under it. A destination that publishes into `.agents/skills/` would have no marker, and
`skill verify` run inside it would walk up into whatever repository happens to contain it. Layout 2
wrote the placeholder at `<root>/.sidekicks/skill-offloaded/.gitkeep`; layout 3 writes
`<root>/.sidekicks/.gitkeep` instead.

**Where the stamp shows up.** `layout:` in `catalog.yaml` and in every `meta/<name>/origin.yaml`, and
`skill_manager.skill_repo.layout` in config. All three are records of which contract wrote a tree, not
switches: no reader consults them.

`origin.yaml`'s `tree:` field also changed in layout 2, from a bare basename (`skills`) to the **full**
published path (`.agents/skills`). Nothing parses it — `destinationSkillDir` probes `DEST_TREES` rather
than trusting it — and the basename was exactly the lossy form that made the trap possible.

## 3c. Layout 3 — the current write target

Since **2026-08-18**, `skill export` writes layout 3. The destination has **one** skill tree:

| | layout 2 | layout 3 |
|---|---|---|
| ACTIVE skill folders | `<root>/.agents/skills/<name>/` | unchanged |
| PARKED skill folders | `<root>/.sidekicks/skill-offloaded/<name>/` | **`<root>/.agents/skills/<name>/`** — no parked tree exists |
| root marker | `<root>/.sidekicks/skill-offloaded/.gitkeep` | **`<root>/.sidekicks/.gitkeep`** |
| `meta/`, `catalog.yaml`, `categories/`, the hand-authored files | — | unchanged |

**Why.** Being parked is a fact about the SOURCE repo's skill discovery — `.sidekicks/skill-offloaded/`
exists here so a host CLI stops loading a skill — and it is not a property of the published copy. A
destination is a library, not a mirror of one consumer's load state. Layout 2 published a parked skill
into a directory whose entire purpose is to be ignored: the browse pages did not link it, `skill
import`'s foreign-layout probe reached it only by carrying a third native tree path, and a reader
cloning the repo saw skills hidden under a dot-directory named "offloaded" for reasons that were true
in another repository. Layout 3 puts every published skill where every reader already looks.

**Still a MAP, and `publishedTreeFor()` still throws.** `PUBLISHED_TREES` in
`lib/skill-lifecycle/destinations.mjs` now maps BOTH local trees to `.agents/skills`, but it stays a
map rather than collapsing to a constant: the local trees do not share a parent, so a basename can
never say where a skill publishes, and the throw is what forces a NEW local tree to declare its
destination instead of inheriting one.

**Nothing migrates on read.** `DEST_TREES` carries `.agents/skills`, then layout 2's
`.sidekicks/skill-offloaded`, then layout 1's `.sidekicks/skills`, first-hit-wins, so a clone published
at any layout still reports status, still imports, and can still be retracted from with
`skill remove --destination`. A destination is migrated by moving the folders and re-exporting the
**full** set for that destination — a partial export rewrites `catalog.yaml` from its own units alone.

## 4. Why the sidecars sit outside the skill folder

Provenance cannot go into `skill.manifest.yaml`: `ROW_KEYS` (`lib/skill-manifest/schema.mjs`) is a
closed key set and an unknown key is reported as a validation **error**, so a `source_commit:` field
would make all 97 manifests fail to validate.

It cannot go *inside* the skill folder either. `bundle{}` covers every file except the manifest, so
an `origin.yaml` dropped next to `SKILL.md` produces a `bundle-stale` finding on the very first
`skill doctor` after import — the exported folder would no longer be byte-identical to its source.

Hence `meta/<name>/`: outside the folder, so the folder stays byte-identical and the baseline stays
true.

## 5. Version-pinned Python dependencies

`requires.python` has **no version field**, and adding one is not on the table: it would break the
validator, the byte-stability guarantee of `skill manifest --apply`, and every existing manifest.

The mechanism is the one already in use by seven skills:

1. **The skill's own `requirements.txt` with `==` pins** is the canonical carrier. It travels inside
   `bundle{}`, so the pins are hashed and verified like any other file, and `skill heal` prefers it
   over the unpinned package list. This is what "bundle the pinned dependency with the skill"
   means in practice.
2. `meta/<name>/requirements.lock.txt` is the export-time snapshot of the source `.venv`, for a
   destination that has no `.venv` yet. A declared package absent from `pip freeze` is written as
   `# UNRESOLVED <pkg>` rather than omitted — an unpinned dependency that looks pinned is worse
   than one that admits it.
3. `-r ../…` in a `requirements.txt` is an **error** (`requirements-escapes-skill`): the dependency
   manifest itself would escape the folder, so the folder stops being liftable.

The hazard this cannot design away: one `.venv` cannot hold two versions of one package. Two skills
pinning the same package differently is a real conflict, and the honest handling is to surface both
pins rather than let whichever installs last silently reshape the environment. Do **not** answer it
with a second venv — the single repo-root `.venv` is a framework rule.

## 6. Importing: reconcile before you overwrite

The baseline for a three-way comparison already exists and does not need a new store: the local
skill's own `bundle{}` **is** "the state a human last blessed", and `skill verify` answers "has the
local copy drifted from it".

**A MISSING MANIFEST IS TWO DIFFERENT FACTS**, and conflating them made this table wrong for 23 of
107 rows against this repo's own two skills repositories. `manifestRequired()`
(`lib/skill-lifecycle/scan.mjs`) says a skill with no `scripts/`, no third-party import, no sibling
edge, no binary and no descriptor needs **no** manifest, and `skill doctor` agrees. Import used to
call that absence "no baseline to reason from" and stop — and `--force` on any such row crashed.

So the incoming copy is classified into four trust states first:

| trust | meaning |
|---|---|
| `intact` | manifest present, parses, every hash matches |
| `broken` | manifest present but invalid, or contradicting its own files |
| `undeclared` | no manifest, and one **is** required — the closure is genuinely unknown |
| `walk` | no manifest, and none is required. A foreign-layout skill is always this |

With `L` = local files on disk, `Lb` = local recorded bundle, `Ib` = incoming recorded bundle, and
`content(I) == content(L)` = byte equality over both folders, excluding the manifest:

| Condition | Status | What to do |
|---|---|---|
| incoming `broken` | `broken` | **stop** — and `--force` does not open it |
| incoming `undeclared` | `unversioned` | **stop** — declare the closure at the source |
| local absent | `new` | copy it in |
| both baselined, `L == Lb`, `Ib != Lb` | `ff` | back up, then replace — a clean fast-forward |
| both baselined, `L == Lb`, `Ib == Lb` | `up-to-date` | skip |
| both baselined, `L != Lb`, `Ib != Lb` | `conflict` | **stop and ask** — both sides moved |
| both baselined, `L != Lb`, `Ib == Lb` | `local-only` | **stop** — your edits post-date the export |
| only incoming baselined, `content ==` | `ff` | the import adds the baseline; nothing is lost |
| only incoming baselined, content differs | `unversioned` | **stop** — nothing attributes the difference |
| only local baselined, local clean | `local-only` | **stop** — EXPORT instead |
| only local baselined, local stale | `conflict` | **stop and ask** |
| neither baselined, `content ==` | `up-to-date` | skip |
| neither baselined, content differs | `unversioned` | **stop** — nothing attributes the difference |

Every row also reports whether its file list came from a recorded baseline (`verified` in `--json`).
A content comparison is weaker than a three-way compare, and the report says so rather than letting
an unverified import read as a verified one.

`broken` is the one status `--force` will not open. `--force` means "I accept losing the local
side"; it has never meant "I accept importing corruption". A copy that contradicts its own manifest
would be written next to that manifest, so the first `skill doctor` reports `bundle-stale` and the
next export refuses — the operator would have forced their way into an unpublishable skill.

Those status names are deliberately the same words `sk-inherit` uses for runtime drift, so
one vocabulary covers both surfaces. Shared words, not shared code — a `lib/` module may not import
a skill's script, and a relative cross-skill import is an error.

After any import, in this order: `sidekicks framework sync` → `sidekicks skill manifest <name> --apply`
→ `sidekicks skill doctor <name>` → `sidekicks skill heal <name> --apply`. An import that leaves
`framework doctor` red is a failed import, not a finished one.

## 7. Importing a tree that is not layout 1

`--from` accepts any repository that holds skills, not only a layout-1 destination.
`lib/skill-package/source-layout.mjs` probes five shapes in priority order and the first that yields
a `SKILL.md` wins:

| id | shape |
|---|---|
| `sidekicks` | `.agents/skills/<name>/SKILL.md`, then `.sidekicks/{skills,skill-offloaded}/<name>/SKILL.md` |
| `claude` | `.claude/skills/<name>/SKILL.md` |
| `flat` | `skills/<name>/SKILL.md` |
| `nested` | `skills/<category>/<name>/SKILL.md` |
| `root` | `<name>/SKILL.md` |

**Full contract — probe rules and their guards, the `--adopt` / `--layout` / `--rename` / `--into`
gates, what conversion refuses to synthesize, and the install receipt:**
[docs/guide/skill-import-adapters.md](../../../../docs/guide/skill-import-adapters.md).
Read it there rather than restating it here; two copies of a contract is one copy that has stopped
being true.

The two facts that belong to *this* document, because they are about the skills-repository
relationship specifically:

- **A native source short-circuits detection.** This layout is probed first and, when it hits,
  nothing else is consulted — a layout-1 destination also carries `.claude/skills` (the Rule 3
  exposure link) and reading it as foreign would strip the provenance in `meta/<name>/origin.yaml`
  and re-adopt skills that are already ours.
- **`--rename` is refused for a native source.** A skill from a skills repository already shares this
  namespace; renaming it would fork it from its own history *and* from its published copy, so
  `skill destinations` would never match the two again. Collisions are only a foreign-source problem.
