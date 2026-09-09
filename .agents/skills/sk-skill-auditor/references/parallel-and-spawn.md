# PARALLEL and SPAWN — running several group audits at once

> Operator-only procedure, lifted out of SKILL.md so the default single-session path does not pay
> context for it on every invocation. The single-session START -> RESUME -> Finalize loop never needs
> anything in here. Read this only when auditing several groups CONCURRENTLY.
>
> The one fact that stays in SKILL.md, because START's own error path depends on it: never run two
> group audits from one session or one checkout — ralph keys its Stop-hook state to the
> session-launch cwd, so two runs in one checkout share one state file and one working tree and
> clobber each other. That is what `checkout-lock` exits 4 to prevent.

### PARALLEL — several audits at once, one session per worktree

A single self-armed run uses a feature branch in this checkout (SKILL.md, START step 1) — simplest, and it keeps
ralph's state file, the ledger, and the auto-applied edits coherent in one place. **Do NOT run two
group audits concurrently from one session or one checkout:** ralph keys its Stop-hook state to
`<session-launch-cwd>/.claude/ralph-loop.local.md`, so two runs in the same checkout share one state
file (and one working tree for the auto-applied edits) and clobber each other. START's
`checkout-lock` **enforces** this now — a second START in a busy checkout exits 4 and points here.

To audit several groups **at once**, give each its own worktree AND its own session **launched inside
that worktree**, so each session's launch cwd — its ralph root — is a distinct directory:

```sh
# per group, from the repo root:
git worktree add -b chore/audit-<group> ../worktrees/audit-<group> main
cd ../worktrees/audit-<group> && claude     # NEW session, ROOTED in the worktree
# inside that fresh session: invoke sk-skill-auditor for <group>
```

Each session then has its own ralph state file (cwd-relative → isolated), its own working tree for
the edits, its own `.sidekicks/settings.json` (git-ignored → absent in a fresh worktree → active
scope defaults to root, so sessions never race on the active-scope pointer), and its own per-slug
ledger; each run **commits and pushes its own branch** when it finishes (SKILL.md, Finalize) — **merging each
branch to `main` is the operator's call, never the run's.** You launch the sessions yourself (START
never auto-creates a worktree); SPAWN, further down this file, is the driven form.

**What coordinates the sessions** (all automatic once each session runs START normally):

- **The coordination root is shared.** Claims and locks live at
  `<main-checkout>/artifacts/runs/skill-auditor/coordination/` — derived from any worktree via
  `git rev-parse --git-common-dir`, printable with `bash "$AUD" coord`, overridable with
  `SIDEKICKS_AUDIT_COORD`. It must be the MAIN checkout because `artifacts/runs/` is git-ignored:
  a worktree-local registry would be invisible to every other session.
- **Per-target claims stop double audits.** START `claim-batch`es every target; a skill already
  claimed by a live run conflicts (exit 4) instead of being audited twice. The invariant this buys:
  **at most one live session per target skill, so the sk-self-improve `improvements/NNN` id
  allocation and `INDEX.md` prepend can never race.** Claims age out after `lease_ttl_seconds`
  (audit-config.yaml) — a crashed session needs no cleanup.
- **The ledger lease is enforced.** Every RESUME iteration `assert`s first; `takeover <slug>`
  adopts an abandoned run (heartbeat older than the TTL) and supersedes its old session, which
  self-aborts at its next `assert`. A fresh foreign lease is never taken automatically.
- **The `single` rotation cursor is shared and atomic.** It lives at the main checkout and
  `single-advance` runs under a lock, so concurrent `single` runs advance one rotation, not two
  private ones.
- **The repo-root `.venv` resolves from the main checkout.** A worktree has no `.venv` of its own
  (git-ignored, and installs never happen in a worktree); `score` and `report` fall back to the
  main checkout's automatically.
- **Trigger-root hygiene:** while any other session is live, sweep only your own scratch —
  `bash "$AUD" clean <slug>`; the bare whole-tree `clean` refuses while a live claim exists.

### SPAWN — one command, N headless sessions (one per group)

The driven form of PARALLEL: the interactive session you are in becomes the **launcher**; each group
gets a worktree + a headless executor session looping RESUME until its run finalizes. **Extra
sibling requirement:** SPAWN reuses `sk-loop-fleet`'s engine (`scripts/fleet.py` ledger +
`scripts/loop.sh` external-ralph runner) and `sk-cli-executor` (headless `claude -p` invocation) —
both must be installed as siblings; manual PARALLEL needs neither.

1. **PLAN.** The user names the groups (or "every group"). Resolve each group's members
   (`bash "$AUD" targets <group>`); if a skill appears in two chosen groups, **ask the user which
   group keeps it** — one fleet must never audit a skill twice. Per group derive:
   `slug=audit-<group>-<date>` · `branch=chore/audit-<slug>` · `worktree=../worktrees/audit-<group>`
   · `max_iter=<targets>+2`. Then create the fleet ledger in the MAIN repo —
   `fleet.py init --slug audit-fleet-<date> --base-branch main --permission-mode skip` and one
   `fleet.py add --ledger <fleet.yaml> --id <group> --goal "audit the <group> group"
   --promise "SKILL-AUDIT DONE" --branch <branch> --worktree <worktree> --max-iter <n>` per group.
   Nothing else touches disk yet.
2. **CONFIRM — the single human gate** (this is the never-silent-worktree ask and the fleet launch
   gate in one). Show one table: per group — branch, worktree destination, target count, max_iter.
   State plainly: (a) executor sessions run with permission mode `skip` — the loop cannot stop to
   ask; (b) **missions do NOT push** — the launcher pushes each branch after the fleet settles;
   (c) N parallel headless sessions = N concurrent `claude -p` streams — rate limits may bite at
   large N. One yes launches everything; no answer, no worktree.
3. **Pre-spawn, per mission** (you, the launcher, still interactive):
   ```sh
   git worktree add ../worktrees/audit-<group> -b chore/audit-<slug> main
   cd ../worktrees/audit-<group>
   COORD="$(bash "$AUD" coord)"                       # same value in every worktree — the shared registry
   # claim + scaffold exactly as START does (checkout-lock, scaffold, extract rid, claim-batch);
   # a claim conflict here marks THIS mission failed in fleet.yaml (note the conflict) and skips
   # it — the rest of the fleet still launches.
   ```
   Then write the mission's **prompt file**: the START step-3 RESUME prompt with the resolved
   `$RUNBASE`, slug, and literal run_id substituted, prefixed with
   `export SIDEKICKS_AUDIT_COORD=<COORD>` **and `export SIDEKICKS_RUN_BASE=<abs RUNBASE>`** as
   instructions, plus two extra sentences: *"Do NOT
   push any branch — the launcher pushes after the fleet settles."* and the assert-first sentence
   it already carries. No ralph plugin arming — `loop.sh` IS the loop; no `git switch` — the branch
   came from `worktree add -b`.
4. **Spawn + monitor.** One `loop.sh` per worktree, each via the Bash tool with
   `run_in_background: true`, from THIS session (never a subagent). `loop.sh` runs the loop in its
   **CWD** — start it from inside the worktree (absolute paths for everything it is handed):
   ```sh
   cd ../worktrees/audit-<group> && bash <abs sk-loop-fleet>/scripts/loop.sh --id <group> \
     --prompt-file <abs prompt> --promise "SKILL-AUDIT DONE" --max-iter <n> --mode skip \
     --executor claude --executor-script <abs sk-cli-executor>/scripts/executor.py \
     --artifacts-dir <abs RUNBASE>/loop --timeout 3600 \
     --ledger <abs fleet.yaml> --fleet-py <abs sk-loop-fleet>/scripts/fleet.py
   ```
   Watch `fleet.py status --ledger <fleet.yaml> --json` until `all_terminal`.
5. **Settle.** For each **converged** mission: `git -C ../worktrees/audit-<group> push -u origin
   chore/audit-<slug>` (the launcher pushes — keeps loop-fleet's "loops never push" and this
   skill's push-never-merge in one hand). Then report a **fleet rollup in prose** built from each
   worktree's rendered `audit-record.json` — per group: audited / applied / parked / failed counts
   + the pushed branch — and lead with every `parked_ids` entry across the fleet (the human's
   part). For failed/capped missions: release their claims (`bash "$AUD" release <slug> <rid>`),
   report what stopped them, leave their worktrees for inspection. Worktree removal afterwards is
   the operator's call (offer `git worktree remove` per merged branch). **Merging any branch to
   `main` stays the operator's call — the fleet's authority ends at pushed branches.**

