# Publication split — which skills go to which skills repository

The standing rule `sidekicks skill export` is run against. Originally decided 2026-08-13
(Asia/Bangkok) under AAP-113/AAP-114 and signed off by the operator in session; **amended
2026-08-16** (test 1 reversed, see below). It lived in that card's run folder until the amendment; a
run folder records what one run did, and this is a policy every later export obeys, so it now sits
with the skill that enforces it.

## The rule

A skill's destination is decided by **two tests, applied in order** — the first that matches wins:

1. **Is it third-party work vendored into this repo?** → **EXCLUDED from every destination.** We do
   not redistribute someone else's skill. The precedent is `caveman` (MIT,
   github.com/JuliusBrussee/caveman), removed from the framework preset for the same reason.
   **16 skills** — `caveman`, `skill-creator`, and the Google-Stitch / shadcn / Remotion family.
   The evidence is never the name: it is vendor-namespaced frontmatter (`stitch::…`,
   `react:components`), an `allowed-tools` entry granting a vendor tool namespace (`stitch*:*`,
   `shadcn*:*`, `StitchMCP`, or the foreign host tool `web_fetch`), or a bundled `license.txt`.
   Cross-check: `docs/skill-modular-category.md` §Classification derives the same 16 independently —
   the skills in no `audit-groups.yaml` group, minus its one documented exception
   (`sk-skill-auditor`, ungrouped by design and first-party). Two of the 16 have plain names
   (`caveman`, `skill-creator`) and two first-party skills lack the `sk-` prefix (`fable-mind`,
   `skill-nickname`), which is exactly why the prefix is not the test.

   > This said **15** until 2026-08-17, when the reforge derived the buckets and found the count
   > stale by one against both `audit-groups.yaml` and `docs/skill-modular-category.md`.

2. **Otherwise it is first-party** → it goes to a repository:
   - **`sidekicks-skills-private`** when it is **offloaded** (archived) **or** **client-specific**
     (the `sk-shp-*` family — a named provincial health system).
   - **`sidekicks-skills`** (public) in every other case — but **only after client identifiers are
     removed from its content** (see *Sanitization* below).

### Every bucket is now DECLARED, not selected at export time

Until 2026-08-17 this document was the only record of the split: the destination was chosen by the
operator typing `--destination` on each run, and the sole durable trace was membership in the two
destination repos' `catalog.yaml`. That trace does not survive a reforge — the reforge that
established this section had to recover it from git bundles, because both remotes had been reset.

So the rule now lives in the skills themselves. Every skill in a restricted bucket carries the
verdict in its own `skill.yaml`, and `skill export`'s destination-intent gate enforces it
(`lib/skill-lifecycle/export.mjs`):

| Bucket | Declaration | Rows |
|---|---|---|
| vendored | `skill_repo: none` | 16 |
| offloaded or client-specific | `skill_repo: private` | 24 |
| everything else first-party | *unset* — publishable anywhere | the remainder |

**Unset still means "no declared intent", not "public".** The absence is what distinguishes a skill
nobody has restricted from one deliberately withheld, and that distinction is why the default is not
spelled `skill_repo: public`.

**Adding a skill means declaring its bucket in the same change** — the same duty as adding it to an
audit group. `skill destinations --json` reports the resolved `intent` per skill and is the check:
the expected rollup is 16 `none`, 24 `private`, the rest `null`.

### Amendment 2026-08-16 — the framework core is published, under its own family

The original rule had a **first** test: *"is it part of the published framework core? → excluded
from both skill repos"*, on the grounds that the `sidekicks-framework` core repo already ships it.
That test is **removed**. The framework's own first-party skills are published to the public
`sidekicks-skills` repository like any other first-party skill, in a dedicated `framework` family.

Why the reversal:

- Shipping inside a core repo is a *distribution* answer; being findable in the catalog is a
  *discovery* one. Excluding the framework meant the public repo could not describe the thing every
  skill in it runs on, and `categories/core/` and `categories/skill-improvement/` were permanently
  empty pages.
- It left real dangling edges. `sk-jira-connector` and `sk-scope-switch` are declared
  siblings of published skills, so every export reported them as not carried and the README had to
  explain their absence.
- Nothing was actually protected by the exclusion: these are first-party skills we already publish
  the source of.

What did **not** change: vendored work stays excluded, and it is now the *only* exclusion. Note the
consequence for `skill-creator` — it is in `sk-inherit`'s `framework` **preset** because a
runtime needs it to run the improvement funnel's APPLY stage, and it is **not** in the `framework`
**category**, because it is not ours to publish. Travelling into a runtime and being published are
different questions.

## Selecting the set to export

Publish a family with `--category`, never `--preset`:

```sh
node bin/sidekicks skill export --category framework --destination public --with-deps --dry-run
```

A preset is what a **runtime** carries and may legitimately include vendored skills; a category is
what a **repository** publishes. Naming a preset for an export is refused by the intent gate — after
you have already typed the wrong command. The category map is
[`assets/categories.yaml`](../assets/categories.yaml).

A vendored skill reached through `--with-deps` (the framework family declares `skill-creator`) is
**dropped and reported** under `withheld` rather than being fatal — otherwise a family that depends
on vendored work could never be published at all. A vendored skill you name **explicitly** is still
a hard refusal.

## Sanitization (why a phase 2 existed)

Some first-party skills are generic in function but carry **client identifiers as documentation
examples** — Jira project keys (`SDHPT`, `DSHPH2`), database aliases (`shp-th-province-prod-ret`),
and schema/table names (`ms_pharmacy.ms_pharmacy_drug`). These are not credentials (live config is
git-ignored), but publishing them exposes a client's internal naming to a public repo.

They are **sanitized in this source repo**, never at export time, because `skill export` copies
byte-identical and hash-verifies against `skill.manifest.yaml`; rewriting content in transit would
break the baseline that makes an exported copy verifiable (see
[skill-repo-layout.md](skill-repo-layout.md) §2–§3). Replace examples with neutral placeholders
(`SDHPT-190` → `ABC-123`, `shp-th-province-prod-ret` → `acme-prod-db`, `ms_pharmacy.*` →
`app_schema.*`), re-record the manifest with `sidekicks skill manifest <skill> --apply`, then export
normally.

A `teleport.*` scan hit on the two Teleport skills was checked and **dismissed as a false positive**
— the matches are code identifiers (`teleport.find`, `teleport.sh`), not hostnames.

## Committing at the destination

Export writes files and stops; it never commits and never pushes. The operator commits, **on a
branch, never to a destination repo's `main`** — and never on a detached HEAD, which is how a
destination checkout has ended up carrying work no branch points at.

## Bucket counts

Re-derived 2026-08-17 for the repos reforge. They move whenever a skill is added, offloaded or
sanitized, so treat them as a snapshot and re-derive from a `--dry-run --json` report rather than
citing them as current.

| Destination | Count |
|---|---|
| PUBLIC `sidekicks-skills` — the `framework` family | 18 |
| PUBLIC `sidekicks-skills` — everything else first-party and clean | 82 |
| PUBLIC total | **100** |
| PRIVATE `sidekicks-skills-private` — offloaded or client-specific | 24 |
| EXCLUDED — vendored third-party (`skill_repo: none`) | 16 |

100 + 24 + 16 = 140 = every skill both trees hold.

Two things make these credible rather than remembered. The private 24 is **set-identical** to what
the retired private repo actually published — `diff` is empty both ways after mapping through the
phase-1 `sidekicks-*` → `sk-*` rename. And the public 100 is the retired repo's 83 **plus exactly
17, dropping nothing**: the `framework` family members withheld before the 2026-08-16 amendment. The
family has 18 members and the eighteenth, `sk-commander`, was already in the 83 — which is why the
rows above read 18 and 82 rather than 17 and 83.
