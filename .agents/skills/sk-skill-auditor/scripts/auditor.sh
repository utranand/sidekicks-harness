#!/usr/bin/env bash
# Deterministic helpers for sk-skill-auditor.
# Root-scope: everything resolves from the git repo root (walk up for .sidekicks/ — NEVER
# `git rev-parse`, since a service src/ is its own repo). No work_dir/docs_dir.
#
# This script ONLY gathers facts (which skills are in scope, what evidence each carries, the
# operational knobs) and scaffolds/logs the run. It never reasons about WHAT to improve and never
# writes to a target skill — that judgment is the agent's, and every write goes through
# sk-self-improve. Keeping the deciding out of the script is the point: a discoverer that
# mechanically pattern-matched would file junk; the evidence inventory below just says where to LOOK.
#
# Subcommands:
#   root                       repo root (dir containing .sidekicks/)
#   now                        Asia/Bangkok ISO-8601 timestamp
#   exists <skill>             exit 0 if .agents/skills/<skill>/ is an ACTIVE skill, else 1
#   groups                     print the NAMES of the `skill-auditing groups:` (one per line). Source =
#                              AGENTS.md's block if it has one (override), else the skill's bundled
#                              assets/audit-groups.yaml (portable default).
#   group <name>               print the members of one named audit group (exit 3 if unknown/empty)
#   targets [group]            print the resolved in-scope skill list. With a <group> arg, base =
#                              that group's members (exit 3 if the group is unknown/empty). Without
#                              it, base = the UNION of every defined group's members (the standing
#                              manifest); if no groups are defined at all, every active skill. Either
#                              way the .sidekicks/skill-offloaded/ archive is out of scope because it sits
#                              OUTSIDE the scanned .agents/skills/ tree (the literal skill-offloaded name
#                              filters below are a no-op backstop); self is excluded by default
#                              but kept when explicitly named (in the base set) or audit_self=true.
#   single-pool                print the rotation POOL for the reserved `single` group: the union of
#                              every OTHER group's members (group-file order, deduped).
#   single-current             print the ONE skill the rotating cursor points at now (falls back to the
#                              first pooled skill when there is no state or the cursor left the pool).
#   single-advance             move the cursor past the just-audited skill, wrapping at the end (locked,
#                              so concurrent `single` runs advance one shared rotation, not two).
#   single-reset [skill]       steer the cursor; no arg = the first pooled skill.
#   single-status              cursor / last-audited / position / state-file path.
#                              (The reserved `single` group audits exactly one skill per run and then
#                              advances — see SKILL.md "The reserved `single` group".)
#   config [key]               print the audit-config knobs — the whole file, or the value of ONE key.
#                              Any top-level key in assets/audit-config.yaml resolves (the reader is
#                              key-generic): the panel/gate knobs, the convergence controls, audit_self,
#                              autonomous/verify_votes, and the whole trigger_eval_* / trigger_* set the
#                              benchmark phase reads. That file is the live list — deliberately NOT
#                              re-enumerated here, since an enumerated copy drifts every time a knob is
#                              added (it already did, twice).
#   evidence <skill>           print an evidence manifest for <skill> (key<TAB>value lines)
#   tier-for <round-index>     print the tier to use for round N, varied across the configured tiers
#   eval-set <skill>           print the path to <skill>'s evals/trigger-eval.json (whether or not it
#                              exists yet) — the triggering benchmark reads it, or generates+commits it
#   score <slug> <skill> [desc] [label]  run the triggering benchmark's SCORER for <skill> — resolves the venv
#                              interpreter, the eval set, the neutral trigger-root and every trigger_*
#                              knob, then execs trigger_eval.py and passes its JSON through. Optional
#                              third arg scores a CANDIDATE description WITHOUT editing the skill.
#                              Scores only — never proposes, never writes a skill, no API-key path.
#                              Exit 1 not-a-skill · 3 no repo-root .venv · 4 no eval set yet. A
#                              scorer fault PROPAGATES the scorer's own status and retains nothing
#                              (it produces no JSON until it succeeds).
#                              Also RETAINS the JSON at <run-base>/trigger/<skill>-<label>.json
#                              (label defaults to a counter) and echoes that path on stderr, so
#                              step 2b.3/2b.4 can re-read earlier scores; stdout is unchanged.
#   trigger-root [slug]        provision (idempotent) a NEUTRAL scratch root with an empty
#                              .claude/commands/ and print its path. Score the triggering benchmark
#                              from here via trigger_eval.py --project-root <this> so the live
#                              installed skill can't compete for the trigger and poison the result.
#   run-base <slug>            resolve this audit run's v2 folder (runs layout v2, --bare shape:
#                              the audit-run slug IS the work item) via `scope run-base
#                              sk-skill-auditor <slug> --bare`; falls back to the frozen
#                              pre-v2 path `<root>/artifacts/runs/skill-auditor/<slug>` when the
#                              CLI verb is unavailable. Every command below resolves through this —
#                              never hand-join `artifacts/runs/skill-auditor/$slug` again.
#   logline <slug> <skill> <msg...>   append a timestamped line to the per-skill audit log
#   report <slug> [args...]    render the run's RESULT from its ledger: audit-report.md (prose, for
#                              the human deciding whether the branch merges) + audit-record.json
#                              (normalized, for the next run / trending). Both derived from
#                              ledger.yaml, so they cannot drift from it; safe to re-run at any
#                              point (idempotent overwrite). Extra args pass through to
#                              audit_report.py (--branch <name>, --md-only, --json-only, --quiet).
#   scaffold <slug> <a,b,c>    emit a fresh ledger.yaml (targets = the comma-list) to stdout
#   clean [slug]               remove TRANSIENT benchmark run outputs (evals/bench/ + trigger-roots).
#                              With a <slug>, sweep ONLY that run's trigger-roots — the safe form
#                              while other audit sessions are live. Bare `clean` refuses the
#                              whole-tree sweep when any live claim exists. Durable records are
#                              kept either way: committed evals (fixtures/grade.py/ground-truth/
#                              benchmark.md) and any audit-run ledger.yaml + log/ under
#                              artifacts/runs/skill-auditor/ (the exit-status artifact + the per-skill trail).
#
# Multi-session coordination (see SKILL.md "PARALLEL"). Claims + locks live under a COORDINATION
# root shared by every checkout/worktree of this repo (claims must be visible across worktrees, and
# artifacts/runs/ is git-ignored so each worktree has its own — hence the main-checkout derivation):
#   coord                      print the shared coordination root: $SIDEKICKS_AUDIT_COORD override,
#                              else <main-checkout>/artifacts/runs/skill-auditor/coordination/
#                              (main checkout derived via `git rev-parse --git-common-dir`; falls
#                              back to this checkout when derivation fails — single-checkout = today).
#   claim <slug> <run-id> <skill>       atomically claim ONE target skill for this run (mkdir-based).
#                              Ours already → refresh heartbeat, exit 0 (idempotent). Held by a
#                              LIVE foreign run → exit 4 (prints the owner). Stale (heartbeat older
#                              than lease_ttl_seconds) → archived to claims/.stale/ and taken over;
#                              a lost takeover race exits 5.
#   claim-batch <slug> <run-id> <a,b,c> claim EVERY listed skill or NONE: conflicts are collected,
#                              everything acquired by THIS call is released, exit 4 listing every
#                              conflicted skill + its owner. Exit 0 = all held.
#   release <slug> <run-id> [skill]     release claim(s) whose recorded run_id matches. Without a
#                              skill, releases ALL claims owned by <run-id> (Finalize). A foreign
#                              claim is never touched (warn, exit 4).
#   assert <slug> <run-id>     the ledger-lease guard every RESUME iteration runs FIRST. Exit 0 the
#                              lease is ours; 1 the ledger is gone (run cancelled); 4 the ledger's
#                              control.lease.run_id differs (this run was superseded by a takeover —
#                              stop immediately, write nothing, emit no promise).
#   takeover <slug>            adopt an ABANDONED run: when the ledger's heartbeat (file mtime) is
#                              older than lease_ttl_seconds, write a fresh run_id into the lease,
#                              re-stamp the old run's claims, print the new run_id. A FRESH foreign
#                              lease is refused (exit 4) — taking over a live run is the user's
#                              call, never this script's.
#   checkout-lock <slug> <run-id>       per-CHECKOUT exclusivity: ralph keys its state to the
#                              session cwd and auto-applied edits land in ONE working tree, so two
#                              audits in one checkout always clobber each other. Live foreign lock →
#                              exit 4 (the fix is a worktree — see SKILL.md "PARALLEL"); stale →
#                              taken over like `claim`.
#   checkout-unlock <slug> <run-id>     release this checkout's lock (run_id must match; exit 4 if foreign).
set -euo pipefail

SELF="sk-skill-auditor"
SKILL_DIR_REL=".agents/skills/$SELF"
# The RESERVED rotating-cursor group. `single` is not a normal members list: it audits exactly ONE
# skill per run (the cursor) and auto-advances through the union of every OTHER group after each run.
# Its literal members in audit-groups.yaml are IGNORED for resolution (see single-* subcommands).
SINGLE_GROUP="single"

repo_root() {
  local d="$PWD"
  while [ "$d" != "/" ] && [ ! -d "$d/.sidekicks" ]; do d="$(dirname "$d")"; done
  [ -d "$d/.sidekicks" ] || { echo "auditor: no .sidekicks/ found above $PWD" >&2; exit 2; }
  printf '%s\n' "$d"
}

# run_base <slug> — resolve the v2 run base for one audit RUN (runs layout v2, --bare shape: the
# audit-run SLUG IS the work item, so this is the run's own folder, no facet layer beneath it).
# Falls back to the pre-v2 repo-root path (`<root>/artifacts/runs/skill-auditor/<slug>`) when the
# CLI verb is unavailable (older checkout) or resolution otherwise fails — never hard-fails a
# script call over it. This is the ONE place the join lives; every command below calls it instead
# of hand-joining `artifacts/runs/skill-auditor/$slug` against the repo root.
# read_base <slug> — like run_base, but for READING an existing run: falls back to the frozen
# pre-v2 location when the v2 base carries no ledger, so `report` still renders an audit run
# written before runs layout v2. Writers always use run_base.
read_base() {
  local slug="${1:?usage: read_base <slug>}" v2 legacy rootbase
  v2="$(run_base "$slug")"
  [ -f "$v2/ledger.yaml" ] && { printf '%s\n' "$v2"; return 0; }
  legacy="$(repo_root)/artifacts/runs/skill-auditor/$slug"
  [ -f "$legacy/ledger.yaml" ] && { printf '%s\n' "$legacy"; return 0; }
  # THIRD rung: the v2 --bare shape anchored at the REPO ROOT. `run_base` resolves through
  # `scope run-base`, which anchors at the ACTIVE PROJECT — so a run written while root scope was
  # active (or before the active project was switched) leaves its ledger here, where neither rung
  # above can see it. Measured: 7 of 8 real audit ledgers sat at this path and `report` failed with
  # "no ledger" on every one of them. This rung is LAST on purpose: it can only turn a hard failure
  # into a success, never redirect a resolution that already succeeded.
  rootbase="$(repo_root)/artifacts/runs/$slug"
  [ -f "$rootbase/ledger.yaml" ] && { printf '%s\n' "$rootbase"; return 0; }
  printf '%s\n' "$v2"    # none exists: report the v2 path in the error
}

run_base() {
  local slug="${1:?usage: run_base <slug>}" root out
  # $SIDEKICKS_RUN_BASE IS THE PIN, AND START MUST EXPORT IT. Without it this falls through to
  # `scope run-base`, which anchors at the ACTIVE PROJECT — so if the active project changes at any
  # point during a run (a scope switch, another session, or a scope-switching skill being itself an
  # audit target), later calls resolve a DIFFERENT base than the scaffold did and the state splits:
  # ledger under one tree, log/ under another. Measured across real runs: 4 slugs ended up under two
  # bases, one with a separate ledger.yaml on each side. The single run that exported the pin was the
  # only one that stayed whole. Export it once at START; every later invocation then also costs no
  # subprocess at all.
  root="$(repo_root)"
  if [ -n "${SIDEKICKS_RUN_BASE:-}" ]; then
    # The pin must belong to the run being asked about. Identity comes from the companion
    # SIDEKICKS_RUN_SLUG that START exports beside the pin — NOT from the base's basename, which is
    # not a reliable signal (a legitimate pin can point at any directory; the test harness pins at
    # `<tmp>/run`). When the companion is absent the pin is honored unchanged, so every existing
    # caller keeps working. A mismatch means this shell is pinned to a DIFFERENT run — and the slug
    # argument would
    # otherwise be silently discarded, which on `clean` ends in `rm -rf` against the pinned run's
    # trigger/ while printing the other slug's name, and on `takeover` rewrites the pinned run's lease.
    # On mismatch: warn and fall through to normal resolution. Deliberately NOT an error exit —
    # `assert` reaches here through read_base under `set -euo pipefail`, so a nonzero return would kill
    # assert with that status, and the ralph prompt reads 1 and 4 as "superseded or cancelled: stop, no
    # writes, no promise". Falling through fails safe; refusing would silently abandon a healthy audit.
    if [ -z "${SIDEKICKS_RUN_SLUG:-}" ] || [ "${SIDEKICKS_RUN_SLUG}" = "$slug" ]; then
      printf '%s\n' "$SIDEKICKS_RUN_BASE"; return 0
    fi
    printf 'auditor: WARNING — this shell is pinned to run %s (SIDEKICKS_RUN_SLUG) but the call asked for %s; ignoring the pin and resolving %s normally. Use a fresh shell, or unset SIDEKICKS_RUN_BASE/SIDEKICKS_RUN_SLUG, to act on another run.\n' \
      "$SIDEKICKS_RUN_SLUG" "$slug" "$slug" >&2
  fi
  out="$(node "$root/bin/sidekicks" scope run-base "$SELF" "$slug" --bare 2>/dev/null)" || out=""
  if [ -n "$out" ]; then printf '%s\n' "$out"; else printf '%s\n' "$root/artifacts/runs/skill-auditor/$slug"; fi
}

now() { TZ=Asia/Bangkok date +%Y-%m-%dT%H:%M:%S+07:00; }

# mtime_epoch <file> — the file's mtime as a unix epoch. BSD stat (macOS) first, GNU stat (Linux /
# Git Bash) second. mtime is the ONE portable heartbeat clock this script uses for staleness math:
# ISO-8601→epoch conversion differs between BSD and GNU `date`, but "when was this file last
# written" is the same question everywhere, and every heartbeat refresh rewrites its file anyway.
mtime_epoch() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }

# main_root — the MAIN checkout's repo root, from any worktree. `git rev-parse --git-common-dir`
# points at the shared .git directory, whose parent is the main checkout; keep it only when it
# really is a sidekicks root, else fall back to THIS checkout (single-checkout = identical to
# repo_root, so nothing changes for the non-worktree case). This is safe alongside the header's
# "never git rev-parse" rule: that rule guards SCOPE resolution from an arbitrary cwd (a service
# src/ is its own repo) — here git runs against the already-resolved sidekicks root itself.
main_root() {
  local root gcd parent
  root="$(repo_root)"
  gcd="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || gcd=""
  if [ -n "$gcd" ]; then
    parent="$(dirname "$gcd")"
    [ -d "$parent/.sidekicks" ] && { printf '%s\n' "$parent"; return 0; }
  fi
  printf '%s\n' "$root"
}

# coord_root — the SHARED coordination root every concurrent audit session agrees on. Env override
# first (what SPAWN mode exports into each headless session), else derived from the main checkout —
# artifacts/runs/ is git-ignored, so a worktree-local path would NOT be shared and claims would be
# invisible across sessions.
coord_root() {
  if [ -n "${SIDEKICKS_AUDIT_COORD:-}" ]; then printf '%s\n' "${SIDEKICKS_AUDIT_COORD%/}"; return 0; fi
  printf '%s\n' "$(main_root)/artifacts/runs/skill-auditor/coordination"
}

lease_ttl() {
  local ttl; ttl="$(config_get lease_ttl_seconds 2>/dev/null || true)"
  case "$ttl" in (''|*[!0-9]*) ttl=3600 ;; esac
  printf '%s\n' "$ttl"
}

# write_lock_owner <dir> <run-id> <slug> — (re)write a lock/claim dir's owner record atomically
# (tmp + mv). The rewrite also refreshes the file's mtime — that IS the heartbeat.
write_lock_owner() {
  local dir="$1" rid="$2" slug="$3" owner="$1/owner.tsv" tmp claimed
  claimed="$(awk -F'\t' '$1=="claimed_at"{print $2; exit}' "$owner" 2>/dev/null || true)"
  [ -n "$claimed" ] || claimed="$(now)"
  tmp="$owner.tmp.$$"
  {
    printf 'run_id\t%s\n' "$rid"
    printf 'slug\t%s\n' "$slug"
    printf 'host\t%s\n' "$(hostname 2>/dev/null || echo unknown)"
    printf 'pid\t%s\n' "$$"
    printf 'claimed_at\t%s\n' "$claimed"
    printf 'heartbeat_at\t%s\n' "$(now)"
  } > "$tmp"
  mv -f "$tmp" "$owner"
}

lock_owner_field() { awk -F'\t' -v k="$1" '$1==k{print $2; exit}' "$2" 2>/dev/null || true; }

# lock_acquire <dir> <run-id> <slug> — the ONE atomic lock primitive (mkdir is atomic on POSIX and
# NTFS; no flock — Git Bash has none). Exit 0 acquired/refreshed · 4 live foreign (owner printed
# on stderr) · 5 lost the stale-takeover race. A stale lock (owner heartbeat older than
# lease_ttl_seconds, or an unreadable owner record) is ARCHIVED beside the registry — mv is atomic,
# so exactly one contender wins the takeover and the loser's retry fails cleanly.
lock_acquire() {
  local dir="$1" rid="$2" slug="$3" owner="$1/owner.tsv"
  if mkdir "$dir" 2>/dev/null; then write_lock_owner "$dir" "$rid" "$slug"; return 0; fi
  local held; held="$(lock_owner_field run_id "$owner")"
  if [ -n "$held" ] && [ "$held" = "$rid" ]; then write_lock_owner "$dir" "$rid" "$slug"; return 0; fi
  local m nowe ttl; ttl="$(lease_ttl)"; nowe="$(date +%s)"
  m="$(mtime_epoch "$owner" 2>/dev/null || true)"
  if [ -n "$m" ] && [ $((nowe - m)) -lt "$ttl" ]; then
    echo "auditor: '$(basename "$dir")' is held by run '$(lock_owner_field slug "$owner")' (run_id ${held:-unknown}, heartbeat $((nowe - m))s ago, TTL ${ttl}s)" >&2
    return 4
  fi
  local stale_base; stale_base="$(dirname "$dir")/.stale"
  mkdir -p "$stale_base"
  mv "$dir" "$stale_base/$(basename "$dir")-$(date +%s)-$$" 2>/dev/null || return 5
  mkdir "$dir" 2>/dev/null || return 5
  write_lock_owner "$dir" "$rid" "$slug"
}

# lock_release <dir> <run-id> — remove a lock/claim we own. Exit 0 released or already gone · 4 the
# recorded owner is a DIFFERENT run (never touched).
lock_release() {
  local dir="$1" rid="$2"
  [ -d "$dir" ] || return 0
  local held; held="$(lock_owner_field run_id "$dir/owner.tsv")"
  if [ -n "$held" ] && [ "$held" != "$rid" ]; then
    echo "auditor: refusing to release '$(basename "$dir")' — owned by run_id $held, not $rid" >&2
    return 4
  fi
  rm -rf "$dir"
}

claims_dir() { printf '%s\n' "$(coord_root)/claims"; }
checkout_lock_dir() { printf '%s\n' "$(repo_root)/artifacts/runs/skill-auditor/checkout.lock"; }

# ledger_run_id <ledger> — the control.lease.run_id recorded in a ledger (first run_id line).
ledger_run_id() {
  awk '/^[[:space:]]*run_id[[:space:]]*:/ {v=$0; sub(/^[[:space:]]*run_id[[:space:]]*:[[:space:]]*/, "", v); sub(/[[:space:]]*#.*$/, "", v); gsub(/[[:space:]]+$/, "", v); print v; exit}' "$1" 2>/dev/null || true
}

# The single repo-root .venv interpreter (AGENTS.md: never a per-skill venv, never system Python).
# POSIX puts it in bin/, Windows in Scripts/ — probe both so the same call works on either host.
# A WORKTREE has no .venv (it is git-ignored, and installs never happen in a worktree), so fall
# back to the MAIN checkout's .venv — same repo, same dependency set.
venv_python() {
  local root="$1" cand base
  for base in "$root" "$(main_root)"; do
    for cand in "$base/.venv/bin/python" "$base/.venv/bin/python3" \
                "$base/.venv/Scripts/python.exe" "$base/.venv/Scripts/python3.exe"; do
      [ -x "$cand" ] && { printf '%s\n' "$cand"; return 0; }
    done
  done
  return 1
}

# Parse the NESTED `skill-auditing groups:` block — the sole which-skills policy. Groups are two
# levels deep — an indented `<name>:` header, then its `- skill` members:
#
#   skill-auditing groups:
#     jira:
#       - sk-jira-connector
#       - sk-jira-my-work
#     planning:
#       - sk-implementation-planner
#
# The block ends at the first non-indented line (a closing ``` fence, the next heading, or a column-0
# comment). Blank and indented comment lines are tolerated inside it, so a group can be commented out
# member-by-member.
#
# SOURCE RESOLUTION — bundled default, AGENTS.md overrides. The skill bundles a PORTABLE DEFAULT
# manifest at assets/audit-groups.yaml so it travels self-contained (a fresh clone audits a sensible
# set out of the box). The repo's AGENTS.md MAY OVERRIDE it: if AGENTS.md carries its OWN
# `skill-auditing groups:` block, that block WINS WHOLESALE and the bundled default is ignored;
# otherwise the bundled default is used. `group_md` returns whichever file is the effective source so
# every parser below is source-agnostic.
has_groups_block() {
  local f="${1:-}"
  [ -n "$f" ] && [ -f "$f" ] && grep -qE '^[[:space:]]*skill-auditing groups[[:space:]]*:' "$f"
}

group_md() {
  local root; root="$(repo_root)"
  local md="$root/AGENTS.md"
  local def="$root/$SKILL_DIR_REL/assets/audit-groups.yaml"
  if has_groups_block "$md"; then printf '%s\n' "$md"; return 0; fi   # AGENTS.md override wins
  [ -f "$def" ] && printf '%s\n' "$def"                               # else bundled portable default
}

# group_names — list every defined group name, one per line.
group_names() {
  local md; md="$(group_md)" || return 0
  [ -n "$md" ] && [ -f "$md" ] || return 0
  awk '
    $0 ~ /^[[:space:]]*skill-auditing groups[[:space:]]*:/ { grab=1; next }
    grab==1 {
      if ($0 ~ /^[^[:space:]]/) { grab=0; next }                 # non-indented line ends the block (incl. ``` fence)
      if ($0 ~ /^[[:space:]]*$/) next                            # tolerate blank lines
      if ($0 ~ /^[[:space:]]*#/) next                            # tolerate commented-out lines
      if ($0 ~ /^[[:space:]]+-[[:space:]]/) next                 # member line — not a name
      if ($0 ~ /^[[:space:]]+[A-Za-z0-9_.-]+[[:space:]]*:[[:space:]]*$/) {
        h=$0; sub(/[[:space:]]*:[[:space:]]*$/, "", h); gsub(/^[[:space:]]+/, "", h)
        if (h != "") print h
      }
    }
  ' "$md"
}

# group_members <name> — list the skills belonging to one named group, one per line.
group_members() {
  local g="$1" md; md="$(group_md)" || return 0
  [ -n "$md" ] && [ -f "$md" ] || return 0
  awk -v g="$g" '
    $0 ~ /^[[:space:]]*skill-auditing groups[[:space:]]*:/ { grab=1; next }
    grab==1 {
      if ($0 ~ /^[^[:space:]]/) { grab=0; next }
      if ($0 ~ /^[[:space:]]*$/) next
      if ($0 ~ /^[[:space:]]*#/) next
      if ($0 ~ /^[[:space:]]+[A-Za-z0-9_.-]+[[:space:]]*:[[:space:]]*$/) {       # group header toggles current
        h=$0; sub(/[[:space:]]*:[[:space:]]*$/, "", h); gsub(/^[[:space:]]+/, "", h)
        cur=(h==g)?1:0; next
      }
      if (cur==1 && $0 ~ /^[[:space:]]*-[[:space:]]*[^[:space:]]/) {
        line=$0; sub(/^[[:space:]]*-[[:space:]]*/, "", line)
        sub(/[[:space:]]*#.*$/, "", line); gsub(/[[:space:]]+$/, "", line)
        if (line != "") print line
      }
    }
  ' "$md"
}

# all_group_members — the UNION of every defined group's members (order-preserving, deduped). This
# is the standing audit manifest: with groups now the single source of which skills are in scope, an
# ungrouped `targets` run sweeps exactly the skills that belong to some group. A skill in two groups
# appears once.
all_group_members() {
  local g
  group_names | while read -r g; do
    [ -n "$g" ] || continue
    [ "$g" = "$SINGLE_GROUP" ] && continue   # reserved rotating-cursor group — never part of the union
    group_members "$g"
  done | awk '!seen[$0]++'
}

# ---- `single` reserved rotating-cursor group ---------------------------------------------------
# `single` audits ONE skill per run and remembers where it left off, rolling through the union of
# every OTHER group across separate runs. The cursor (the skill to audit NEXT) is persisted as run
# state under artifacts/ — git-ignored, durable on disk, Rule-1 compliant (auditor.sh must not write
# under .sidekicks/). Deleting the state file resets rotation to the first pooled skill.

# The cursor is SHARED across worktrees (anchored at the main checkout via main_root — in a single
# checkout that IS repo_root, so nothing moves for the non-worktree case): two `single` runs from
# two sessions must advance ONE rotation, not two private ones.
single_state_file() {
  printf '%s\n' "$(main_root)/artifacts/runs/skill-auditor/single-rotation.yaml"
}

# single_state_read_file — where to READ rotation state: the shared file, else the legacy
# per-checkout location (pre-sharing runs wrote it under THIS checkout's artifacts/), else the
# shared path (so a missing-file read stays a clean no-op). Writers always use single_state_file.
single_state_read_file() {
  local shared legacy
  shared="$(single_state_file)"
  [ -f "$shared" ] && { printf '%s\n' "$shared"; return 0; }
  legacy="$(repo_root)/artifacts/runs/skill-auditor/single-rotation.yaml"
  [ -f "$legacy" ] && { printf '%s\n' "$legacy"; return 0; }
  printf '%s\n' "$shared"
}

# single_pool — the ordered rotation pool: the union of every group EXCEPT `single`, minus the
# offloaded archive and (by default) the auditor itself, keeping only real installed skills. Order
# is group-file order, deduped — this is the sequence the cursor advances through.
single_pool() {
  local root; root="$(repo_root)"
  local keep_self="no" pool
  pool="$(all_group_members || true)"
  # KEEP-SELF MUST MIRROR `targets` EXACTLY. It used to honor `audit_self` alone, which silently put the
  # auditor outside the rotation under BOTH shapes the docs support — reproduced: with the auditor placed
  # in a group, `targets <group>` audited it while `single-pool` omitted it; and with `audit_self: true`
  # but the auditor in no group, the ungrouped `targets` INJECTS it (see the targets arm) while the pool
  # still omitted it. Either way SKILL.md's promise that the rotation gives "same coverage over time" as a
  # full sweep was false with no diagnostic. So both of `targets`' keep-self paths are honored here:
  #   (1) explicit membership in any pooled group — the documented per-group opt-in; and
  #   (2) audit_self=true, which also INJECTS self when it belongs to no group at all.
  if printf '%s\n' "$pool" | grep -qxF "$SELF"; then keep_self="yes"; fi
  if [ "$(config_get audit_self 2>/dev/null)" = "true" ]; then
    keep_self="yes"
    printf '%s\n' "$pool" | grep -qxF "$SELF" || pool="$(printf '%s\n%s' "$pool" "$SELF")"
  fi
  printf '%s\n' "$pool" | while read -r s; do
    [ -n "$s" ] || continue
    [ "$s" = "skill-offloaded" ] && continue
    [ "$s" = "$SELF" ] && [ "$keep_self" != "yes" ] && continue
    [ -f "$root/.agents/skills/$s/SKILL.md" ] || continue
    printf '%s\n' "$s"
  done
}

single_read_cursor() {
  local f; f="$(single_state_read_file)"
  [ -f "$f" ] || return 0
  awk -F: '/^cursor[[:space:]]*:/ {v=$2; gsub(/[[:space:]]/,"",v); if(v!="" && v!="null") print v; exit}' "$f"
}

single_read_last() {
  local f; f="$(single_state_read_file)"
  [ -f "$f" ] || { printf 'null\n'; return 0; }
  awk -F: '/^last_audited[[:space:]]*:/ {v=$2; gsub(/[[:space:]]/,"",v); print (v==""?"null":v); exit}' "$f"
}

# single_resolve_current — the skill to audit NOW: the persisted cursor when it is still a member of
# the live pool, else the first pooled skill (also the no-state and stale-cursor fallback).
single_resolve_current() {
  local cur pool; pool="$(single_pool)"
  [ -n "$pool" ] || { echo "auditor: single rotation pool is empty (no non-single groups defined?)" >&2; return 3; }
  cur="$(single_read_cursor)"
  if [ -n "$cur" ] && printf '%s\n' "$pool" | grep -qxF "$cur"; then
    printf '%s\n' "$cur"
  else
    printf '%s\n' "$pool" | head -1
  fi
}

single_write() {   # single_write <cursor> <last_audited> — atomic (tmp + mv): a reader in another
                   # session never sees a truncated file mid-write.
  local cursor="$1" last="${2:-null}" f tmp; f="$(single_state_file)"
  mkdir -p "$(dirname "$f")"
  tmp="$f.tmp.$$"
  {
    printf '# Rotating cursor for the reserved `single` audit group (auditor.sh single-current / single-advance).\n'
    printf '# Holds the skill to audit on the NEXT `audit single` run; auto-advanced through the union of\n'
    printf '# every OTHER skill-auditing group after each single-group audit finishes. Run state under\n'
    printf '# artifacts/ (git-ignored) — persistent on disk across runs; delete this file to reset to the\n'
    printf '# first pooled skill, or run `auditor.sh single-reset [skill]` to set it explicitly.\n'
    printf '# Anchored at the MAIN checkout so every worktree session advances ONE shared rotation.\n'
    printf 'cursor: %s\n' "$cursor"
    printf 'last_audited: %s\n' "$last"
    printf 'updated_at: %s\n' "$(now)"
  } > "$tmp"
  mv -f "$tmp" "$f"
}

# single_lock / single_unlock — serialize the single-advance read-modify-write across sessions.
# Plain mkdir lock (no owner record: the critical section is milliseconds); a leftover lock older
# than 60s is a crashed holder and is reclaimed.
single_lock() {
  local lock; lock="$(coord_root)/single-rotation.lock"
  mkdir -p "$(dirname "$lock")"
  local tries=0 m nowe
  while ! mkdir "$lock" 2>/dev/null; do
    m="$(mtime_epoch "$lock" 2>/dev/null || true)"; nowe="$(date +%s)"
    if [ -n "$m" ] && [ $((nowe - m)) -gt 60 ]; then rmdir "$lock" 2>/dev/null || true; continue; fi
    tries=$((tries + 1))
    [ "$tries" -ge 50 ] && { echo "auditor: could not acquire single-rotation lock at $lock" >&2; return 4; }
    sleep 0.1 2>/dev/null || sleep 1
  done
  printf '%s\n' "$lock"
}
single_unlock() { rmdir "$1" 2>/dev/null || true; }

# trigger_root <slug> — a NEUTRAL scratch root for scoring the triggering benchmark. It carries an
# empty .claude/commands/ and NOTHING else, so when `claude -p` discovers its project root here it
# sees none of the repo's real installed skills (exposed via the repo .claude/skills symlink) — the
# one under test would otherwise compete for its own trigger and poison the score. Lives in the OS
# temp dir (no .claude ancestor), keyed by slug so every candidate-description scoring in one skill's
# optimize loop reuses the same root. Idempotent. Shared by the `trigger-root` and `score` verbs.
trigger_root() {
  local slug="${1:-adhoc}" base troot
  base="${TMPDIR:-/tmp}"; base="${base%/}"
  troot="$base/sk-auditor-trigger/$slug"
  mkdir -p "$troot/.claude/commands"
  printf '%s\n' "$troot"
}

active_skills() {
  local root; root="$(repo_root)"
  local d
  for d in "$root"/.agents/skills/*/; do
    [ -f "${d}SKILL.md" ] || continue
    basename "$d"
  done
}

config_file() {
  local root; root="$(repo_root)"
  printf '%s\n' "$root/$SKILL_DIR_REL/assets/audit-config.yaml"
}

# Read a scalar (or comma-joined sequence) value from audit-config.yaml for a top-level key.
config_get() {
  local key="$1" f; f="$(config_file)"
  [ -f "$f" ] || return 0
  awk -v key="$key" '
    $0 ~ ("^" key "[[:space:]]*:") {
      val=$0; sub("^" key "[[:space:]]*:[[:space:]]*", "", val)
      # A QUOTED scalar is handled FIRST, before any comment-stripping. A quoted YAML scalar excludes
      # its quotes (`trigger_eval_model: ""` is the EMPTY string, not two characters) and may legally
      # contain a `#` — so stripping comments first would silently truncate `x: "abc#def"` to `"abc`.
      # Take the content up to the MATCHING closing quote, then drop any trailing `# comment` that
      # follows it. Print immediately and never fall through to the block-sequence branch: the key WAS
      # found, its value just happens to be empty. That is what lets a caller expansion of the form
      # ${VAR:+--flag "$VAR"} correctly OMIT the flag instead of passing a literal "" as its value.
      # NOTE: no apostrophes in this awk program — it is single-quoted in the shell, so one would end it.
      # POSIX awk only (substr/length/index/sprintf), so it also runs under Git Bash on Windows.
      q1="\""; q2=sprintf("%c", 39)
      first=substr(val, 1, 1)
      if (first==q1 || first==q2) {
        rest=substr(val, 2); close_at=index(rest, first)
        if (close_at > 0) { print substr(rest, 1, close_at-1); found=1; exit }
        # Unterminated quote — malformed YAML. Fall through and print it literally rather than guess.
      }
      sub(/[[:space:]]*#.*$/, "", val); gsub(/[[:space:]]+$/, "", val)
      # inline flow sequence  [a, b, c]
      if (val ~ /^\[.*\]$/) { gsub(/[][]/, "", val); gsub(/[[:space:]]/, "", val); print val; found=1; exit }
      if (val != "") { print val; found=1; exit }
      block=1; next                            # block sequence on following lines
    }
    block==1 {
      if ($0 ~ /^[[:space:]]*-[[:space:]]*[^[:space:]]/) {
        item=$0; sub(/^[[:space:]]*-[[:space:]]*/, "", item); sub(/[[:space:]]*#.*$/, "", item)
        gsub(/[[:space:]]+$/, "", item); seq=(seq=="")?item:(seq "," item); next
      }
      if ($0 ~ /^[[:space:]]*$/) next
      block=0; if (seq!="") print seq
    }
    END { if (block==1 && seq!="") print seq }
  ' "$f"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  root) repo_root ;;
  now) now ;;

  exists)
    skill="${1:?usage: exists <skill>}"; root="$(repo_root)"
    [ -f "$root/.agents/skills/$skill/SKILL.md" ] && exit 0 || exit 1 ;;

  groups) group_names ;;

  group)
    g="${1:?usage: group <name>}"
    # `single` is the reserved rotating-cursor group: its "member" is whatever skill the cursor
    # currently points at, NOT the literal list in audit-groups.yaml.
    if [ "$g" = "$SINGLE_GROUP" ]; then single_resolve_current; exit $?; fi
    members="$(group_members "$g" || true)"
    if [ -z "$members" ]; then
      echo "auditor: unknown or empty audit group: '$g' — defined groups: $(group_names | paste -sd, - 2>/dev/null)" >&2
      exit 3
    fi
    printf '%s\n' "$members" ;;

  targets)
    # Optional <group> arg scopes the base set to one named AGENTS.md group; without it, the base is
    # the UNION of every defined group (the standing manifest), or — only if no groups are defined at
    # all — every active skill. `explicit` is the explicitly-named base set (a group's members, or the
    # union of groups) — empty only on the no-groups-defined fallback — and drives two things below:
    # whether self is kept, and whether a named entry that isn't a real skill is an error worth warning.
    grp="${1:-}"
    explicit=""
    # `single` resolves to exactly one skill — the rotating cursor — so a `targets single` run (and
    # thus START's scaffold) audits just that skill this run.
    if [ "$grp" = "$SINGLE_GROUP" ]; then single_resolve_current; exit $?; fi
    if [ -n "$grp" ]; then
      base="$(group_members "$grp" || true)"
      if [ -z "$base" ]; then
        echo "auditor: unknown or empty audit group: '$grp' — defined groups: $(group_names | paste -sd, - 2>/dev/null)" >&2
        exit 3
      fi
      explicit="$base"
    else
      base="$(all_group_members || true)"
      if [ -n "$base" ]; then explicit="$base"; else base="$(active_skills)"; fi
      # audit_self dogfood: include the auditor in a full (ungrouped, union) sweep even though it sits
      # in no group — its standing "audit me too on a whole-registry run" lever. A NAMED-group run
      # stays precise (self appears only if that group lists it), so this injection is ungrouped-only.
      if [ "$(config_get audit_self 2>/dev/null)" = "true" ] && ! printf '%s\n' "$base" | grep -qxF "$SELF"; then
        base="$(printf '%s\n%s' "$base" "$SELF")"
      fi
    fi
    # The auditor is excluded from sweeps by DEFAULT (auditing yourself is opt-in dogfooding, not a
    # surprise side effect of a whole-registry run). It is KEPT when either: it's EXPLICITLY named in
    # the base set (a named group, or the union of groups), OR the additive `audit_self: true` knob
    # (audit-config.yaml) is set — see the ungrouped injection just above.
    keep_self="no"
    if [ -n "$explicit" ] && printf '%s\n' "$explicit" | grep -qxF "$SELF"; then keep_self="yes"; fi
    [ "$(config_get audit_self 2>/dev/null)" = "true" ] && keep_self="yes"
    printf '%s\n' "$base" | while read -r s; do
      [ -n "$s" ] || continue
      [ "$s" = "$SELF" ] && [ "$keep_self" != "yes" ] && continue   # self only when explicitly named or audit_self
      [ "$s" = "skill-offloaded" ] && continue
      # group-named entries must be real skills
      if [ -n "$explicit" ] && ! { root="$(repo_root)"; [ -f "$root/.agents/skills/$s/SKILL.md" ]; }; then
        echo "auditor: group skill not found, skipping: $s" >&2; continue
      fi
      printf '%s\n' "$s"
    done ;;

  single-pool)   single_pool ;;
  single-current) single_resolve_current ;;

  single-advance)
    # Advance the cursor PAST the skill that was just audited (the current cursor) to the next skill
    # in the pool, wrapping at the end. Called at Finalize of a `single` run, once the one target is
    # terminal (done or failed) — so rotation always progresses, never sticking on a poison skill.
    # The read-modify-write is serialized under the coordination lock: two concurrent `single`
    # finalizes must produce TWO advances, not one lost update.
    pool="$(single_pool)" || exit $?
    n="$(printf '%s\n' "$pool" | grep -c . || true)"
    [ "${n:-0}" -gt 0 ] || { echo "auditor: single rotation pool is empty" >&2; exit 3; }
    lock="$(single_lock)" || exit $?
    trap 'single_unlock "$lock"' EXIT
    cur="$(single_resolve_current)" || { rc=$?; single_unlock "$lock"; trap - EXIT; exit "$rc"; }
    next="$(printf '%s\n' "$pool" | awk -v c="$cur" '
      {a[NR]=$0}
      END{ idx=0; for(i=1;i<=NR;i++) if(a[i]==c){idx=i;break}
           if(idx==0) print a[1]; else print a[(idx % NR)+1] }')"
    single_write "$next" "$cur"
    single_unlock "$lock"; trap - EXIT
    printf '%s\n' "$next" ;;

  single-reset)
    # Steer the rotation: set the cursor to a named pooled skill, or (no arg) back to the first one.
    arg="${1:-}"; pool="$(single_pool)" || exit $?
    if [ -n "$arg" ]; then
      printf '%s\n' "$pool" | grep -qxF "$arg" || {
        echo "auditor: '$arg' is not in the single rotation pool — see 'auditor.sh single-pool'" >&2; exit 3; }
      target="$arg"
    else
      target="$(printf '%s\n' "$pool" | head -1)"
    fi
    single_write "$target" "null"
    printf '%s\n' "$target" ;;

  single-status)
    pool="$(single_pool)" || exit $?
    n="$(printf '%s\n' "$pool" | grep -c . || true)"
    cur="$(single_resolve_current)" || exit $?
    pos="$(printf '%s\n' "$pool" | awk -v c="$cur" '{if($0==c){print NR; exit}}')"
    printf 'cursor\t%s\n' "$cur"
    printf 'last_audited\t%s\n' "$(single_read_last)"
    printf 'position\t%s/%s\n' "${pos:-?}" "${n:-0}"
    printf 'state_file\t%s\n' "$(single_state_file)" ;;

  coord) coord_root ;;

  claim)
    slug="${1:?usage: claim <slug> <run-id> <skill>}"; rid="${2:?usage: claim <slug> <run-id> <skill>}"
    skill="${3:?usage: claim <slug> <run-id> <skill>}"
    mkdir -p "$(claims_dir)"
    lock_acquire "$(claims_dir)/$skill" "$rid" "$slug" ;;

  claim-batch)
    slug="${1:?usage: claim-batch <slug> <run-id> <a,b,c>}"; rid="${2:?usage: claim-batch <slug> <run-id> <a,b,c>}"
    list="${3:?usage: claim-batch <slug> <run-id> <a,b,c>}"
    mkdir -p "$(claims_dir)"
    acquired=""; conflicts=""
    IFS=',' read -ra arr <<< "$list"
    for raw in "${arr[@]}"; do
      s="$(echo "$raw" | xargs)"; [ -n "$s" ] || continue
      # A pre-existing claim by THIS run counts as held, not newly acquired — a rollback must not
      # release what an earlier claim-batch of the same run already owns.
      pre_held="no"
      if [ -f "$(claims_dir)/$s/owner.tsv" ] && [ "$(lock_owner_field run_id "$(claims_dir)/$s/owner.tsv")" = "$rid" ]; then pre_held="yes"; fi
      if lock_acquire "$(claims_dir)/$s" "$rid" "$slug" 2>/dev/null; then
        [ "$pre_held" = "yes" ] || acquired="$acquired $s"
      else
        owner_file="$(claims_dir)/$s/owner.tsv"
        conflicts="$conflicts$s (held by run '$(lock_owner_field slug "$owner_file")', run_id $(lock_owner_field run_id "$owner_file"))\n"
      fi
    done
    if [ -n "$conflicts" ]; then
      for s in $acquired; do lock_release "$(claims_dir)/$s" "$rid" || true; done
      echo "auditor: claim-batch conflict — every claim acquired by this call was rolled back. Conflicted targets:" >&2
      printf '%b' "$conflicts" >&2
      exit 4
    fi
    echo "claimed: $(printf '%s\n' "$list" | tr ',' ' ' | xargs)" ;;

  release)
    slug="${1:?usage: release <slug> <run-id> [skill]}"; rid="${2:?usage: release <slug> <run-id> [skill]}"
    skill="${3:-}"
    if [ -n "$skill" ]; then
      lock_release "$(claims_dir)/$skill" "$rid"
    else
      # Release every claim recorded under this run_id (Finalize / crash sweep). Foreign claims and
      # the .stale/ archive are never touched.
      cdir="$(claims_dir)"
      [ -d "$cdir" ] || exit 0
      released=0
      for d in "$cdir"/*/; do
        [ -d "$d" ] || continue
        [ "$(lock_owner_field run_id "${d%/}/owner.tsv")" = "$rid" ] || continue
        rm -rf "${d%/}"; released=$((released + 1))
      done
      echo "released: $released claim(s) owned by $rid"
    fi ;;

  assert)
    # The RESUME guard. Runs FIRST every iteration: exit 0 = this run still owns its ledger;
    # 1 = ledger gone (run cancelled — stop, write nothing); 4 = the lease's run_id is no longer
    # ours (a takeover superseded this run — stop immediately, no promise, no writes).
    slug="${1:?usage: assert <slug> <run-id>}"; rid="${2:?usage: assert <slug> <run-id>}"
    ledger="$(read_base "$slug")/ledger.yaml"
    [ -f "$ledger" ] || { echo "auditor: ledger gone at $ledger — run cancelled" >&2; exit 1; }
    held="$(ledger_run_id "$ledger")"
    if [ -n "$held" ] && [ "$held" != "$rid" ]; then
      echo "auditor: superseded — ledger lease run_id is $held, this session is $rid. Stop now: no writes, no promise." >&2
      exit 4
    fi
    exit 0 ;;

  takeover)
    # Adopt an ABANDONED run: only when the ledger has not been written for lease_ttl_seconds
    # (every RESUME pass rewrites it, so mtime IS the heartbeat). A fresh foreign lease is refused —
    # taking over a live run is the user's decision, never this script's (GTD rule).
    slug="${1:?usage: takeover <slug>}"
    ledger="$(read_base "$slug")/ledger.yaml"
    [ -f "$ledger" ] || { echo "auditor: no ledger for run '$slug'" >&2; exit 1; }
    old_rid="$(ledger_run_id "$ledger")"
    m="$(mtime_epoch "$ledger")"; nowe="$(date +%s)"; ttl="$(lease_ttl)"
    if [ -n "$m" ] && [ $((nowe - m)) -lt "$ttl" ]; then
      echo "auditor: refusing takeover — ledger heartbeat is $((nowe - m))s old (< ${ttl}s TTL); the run may be live. If you are SURE it is dead, wait out the TTL or let the user decide." >&2
      exit 4
    fi
    new_rid="au-$(date +%s)-$$"
    tmp="$ledger.tmp.$$"
    awk -v rid="$new_rid" -v hb="$(now)" '
      !did_rid && $0 ~ /^[[:space:]]*run_id[[:space:]]*:/ { sub(/run_id[[:space:]]*:.*/, "run_id: " rid); did_rid=1 }
      !did_hb && $0 ~ /^[[:space:]]*heartbeat_at[[:space:]]*:/ { sub(/heartbeat_at[[:space:]]*:.*/, "heartbeat_at: " hb); did_hb=1 }
      { print }
    ' "$ledger" > "$tmp" && mv -f "$tmp" "$ledger"
    # Re-stamp the old run's claims so the adopted run keeps its targets.
    if [ -n "$old_rid" ] && [ -d "$(claims_dir)" ]; then
      for d in "$(claims_dir)"/*/; do
        [ -d "$d" ] || continue
        [ "$(lock_owner_field run_id "${d%/}/owner.tsv")" = "$old_rid" ] || continue
        write_lock_owner "${d%/}" "$new_rid" "$slug"
      done
    fi
    printf '%s\n' "$new_rid" ;;

  checkout-lock)
    slug="${1:?usage: checkout-lock <slug> <run-id>}"; rid="${2:?usage: checkout-lock <slug> <run-id>}"
    mkdir -p "$(dirname "$(checkout_lock_dir)")"
    if ! lock_acquire "$(checkout_lock_dir)" "$rid" "$slug"; then
      echo "auditor: another audit run is live in THIS checkout — two audits per checkout always clobber each other (shared ralph state + working tree). Run the second audit from its own worktree: see SKILL.md 'PARALLEL'." >&2
      exit 4
    fi ;;

  checkout-unlock)
    slug="${1:?usage: checkout-unlock <slug> <run-id>}"; rid="${2:?usage: checkout-unlock <slug> <run-id>}"
    lock_release "$(checkout_lock_dir)" "$rid" ;;

  config)
    key="${1:-}"
    if [ -n "$key" ]; then config_get "$key"; else
      f="$(config_file)"; [ -f "$f" ] && cat "$f" || echo "auditor: no audit-config.yaml" >&2
    fi ;;

  tier-for)
    idx="${1:?usage: tier-for <round-index>}"
    tiers="$(config_get tiers)"; [ -n "$tiers" ] || tiers="high,mid,low"
    IFS=',' read -ra arr <<< "$tiers"
    n="${#arr[@]}"; [ "$n" -gt 0 ] || { echo high; exit 0; }
    printf '%s\n' "${arr[$(( idx % n ))]}" ;;

  eval-set)
    skill="${1:?usage: eval-set <skill>}"; root="$(repo_root)"
    [ -f "$root/.agents/skills/$skill/SKILL.md" ] || { echo "auditor: not a skill: $skill" >&2; exit 1; }
    # Path only — never created here. The triggering benchmark reads it if it exists, else generates
    # the query set and files it via sk-self-improve (kind: assets) so it lands at this path.
    printf '%s\n' ".agents/skills/$skill/evals/trigger-eval.json" ;;

  trigger-root) trigger_root "${1:-adhoc}" ;;

  score)
    # Run the triggering benchmark's SCORER for one skill — the whole DETERMINISTIC half of step 2b in
    # one call. It resolves the venv interpreter (POSIX + Windows), the skill's eval set, the neutral
    # trigger-root, and every trigger_* knob, then execs scripts/trigger_eval.py and passes its JSON
    # straight through. Bundled deliberately: the composition is identical for every skill of every
    # run, and hand-reassembling it in prose is where flags got silently dropped.
    #
    # It SCORES ONLY. It never proposes a description, never writes a skill, and carries no API-key
    # path — the auditor agent is the proposer (AGENTS.md: "Skill optimization — manual loop only,
    # never an API key"). Third arg = a CANDIDATE description scored WITHOUT editing the skill.
    #
    # FOURTH arg = a <label> for the retained copy of the JSON. Step 2b must re-read earlier scores
    # (2b.3 reads the failing queries from the last score; 2b.4 compares a replicated pair worst-vs-
    # best), so the output has to survive the call — and when it did not, three real runs invented
    # three different conventions (run-root baseline.json/cand1.json…, a run-local bench/, a
    # log-trigger-baseline.json) that `clean` swept none of. So every score is ALSO written to
    #     <run-base>/trigger/<skill>-<label>.json
    # with the path echoed on stderr and the JSON still passed through on stdout unchanged, so
    # existing callers that redirect stdout keep working. Label defaults to a per-skill counter.
    slug="${1:?usage: score <slug> <skill> [candidate-description] [label]}"
    skill="${2:?usage: score <slug> <skill> [candidate-description] [label]}"; cand="${3:-}"; label="${4:-}"
    root="$(repo_root)"
    [ -f "$root/.agents/skills/$skill/SKILL.md" ] || { echo "auditor: not a skill: $skill" >&2; exit 1; }
    eset="$root/.agents/skills/$skill/evals/trigger-eval.json"
    [ -f "$eset" ] || { echo "auditor: no eval set at .agents/skills/$skill/evals/trigger-eval.json — generate it and file it via sk-self-improve (kind: assets) first" >&2; exit 4; }
    py="$(venv_python "$root" || true)"
    [ -n "$py" ] || { echo "auditor: no repo-root .venv python found at $root/.venv (also tried the main checkout's .venv at $(main_root)/.venv — the triggering benchmark needs it)" >&2; exit 3; }
    # KEEP num-workers AT 1 — higher concurrency silently turns true-positives into false-negatives,
    # so a rate scored above one worker cannot be trusted (see audit-config.yaml).
    rpq="$(config_get trigger_eval_runs_per_query)"; nw="$(config_get trigger_eval_num_workers)"
    th="$(config_get trigger_eval_threshold)"; model="$(config_get trigger_eval_model)"
    # Retained copy: <run-base>/trigger/<skill>-<label>.json. No `exec` any more — we must outlive
    # the scorer to keep its EXIT STATUS, which callers rely on (1 not-a-skill, 3 no venv, 4 no eval
    # set). `tee` would report ITS OWN status, so capture to the file and cat it back instead.
    tdir="$(run_base "$slug")/trigger"; mkdir -p "$tdir"
    if [ -z "$label" ]; then
      n=1; while [ -e "$tdir/$skill-$n.json" ]; do n=$((n+1)); done; label="$n"
    fi
    out="$tdir/$skill-$label.json"
    # `|| rc=$?` is load-bearing, and the FORM matters — get it wrong twice and you get two different
    # bugs. This file runs under `set -euo pipefail` (see the top), so an UNGUARDED nonzero exit from
    # the scorer kills the shell here and every line below becomes dead code (bug 1, found by 066).
    # But `if ! cmd; then rc=$?; fi` does NOT fix it: inside the `then` branch `$?` is the status of the
    # NEGATED pipeline, which is 0 precisely when the command failed — so rc was always 0, the failure
    # branch was unreachable, and a crashed scorer reported SUCCESS with truncated JSON (bug 2, found by
    # 067, strictly worse than bug 1 because it is silent). `cmd || rc=$?` is the form that both survives
    # errexit and captures the real status; it is the idiom this file already uses elsewhere.
    rc=0
    "$py" "$root/$SKILL_DIR_REL/scripts/trigger_eval.py" \
      --eval-set "$eset" --skill-path "$root/.agents/skills/$skill" \
      --project-root "$(trigger_root "$slug-$skill")" \
      --num-workers "${nw:-1}" --runs-per-query "${rpq:-3}" \
      ${th:+--trigger-threshold "$th"} ${model:+--model "$model"} ${cand:+--description "$cand"} \
      --verbose > "$out" || rc=$?
    if [ "$rc" -ne 0 ]; then
      # PROPAGATE the scorer's own status — do NOT substitute one of our own; overwriting rc would
      # destroy the property this guard exists to preserve. Note honestly that the codes are NOT fully
      # distinguishable: a Python traceback also exits 1, which collides with the not-a-skill pre-check.
      # Propagating the truth is still better than inventing a code, and the stderr line below says
      # which side failed.
      # Also remove the output: trigger_eval.py prints its JSON only at the very end (--verbose goes to
      # stderr), so a failed run leaves a ZERO-BYTE file — and leaving it would occupy label N in the
      # counter below, making the next score silently pick N+1 and a later re-read find nothing.
      rm -f "$out"
      echo "auditor: the scorer FAILED (exit $rc) — no JSON produced, nothing retained for label '$label'." >&2
      exit "$rc"
    fi
    cat "$out"
    echo "auditor: score retained at ${out#"$root/"}" >&2
    exit 0 ;;

  evidence)
    skill="${1:?usage: evidence <skill>}"; root="$(repo_root)"
    base="$root/.agents/skills/$skill"; rel=".agents/skills/$skill"
    [ -d "$base" ] || { echo "auditor: not a skill: $skill" >&2; exit 1; }
    if [ -f "$base/SKILL.md" ]; then
      printf 'skill_md\t%s\n' "$rel/SKILL.md"
      printf 'skill_md_lines\t%s\n' "$(wc -l < "$base/SKILL.md" | tr -d ' ')"
      # Measure the RENDERED frontmatter description, not the raw YAML block. The folded/block
      # scalar (`description: >-`) spreads the value across indented continuation lines; counting
      # the raw block (key line + indentation + newlines) overcounts by tens of chars and can flip
      # a sub-1024-cap description to a reported over-cap value (a false dimension-1 finding).
      # Primary: parse the value with the repo-root .venv PyYAML. Fallback (no venv/PyYAML): strip
      # the key line, dedent continuation lines, join with single spaces.
      desc_chars=""
      py="$(venv_python "$root" || true)"
      if [ -n "$py" ] && desc_chars="$("$py" - "$base/SKILL.md" 2>/dev/null <<'PYEOF'
import sys, re, yaml
t = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'^---\n(.*?)\n---', t, re.S)
print(len(yaml.safe_load(m.group(1)).get('description', '')) if m else 0)
PYEOF
)"
      then
        :
      fi
      if [ -z "$desc_chars" ]; then
        desc_chars="$(awk '/^description:/{f=1; next} f&&/^[a-zA-Z_-]+:/{exit} f{sub(/^[ \t]+/,""); s=(s==""?$0:s" "$0)} END{printf "%s", s}' "$base/SKILL.md" | LC_ALL=C.UTF-8 wc -m | tr -d ' ')"
      fi
      printf 'description_chars_approx\t%s\n' "$desc_chars"
      printf 'rigid_imperatives\t%s\n' "$(grep -oE '\b(MUST|NEVER|ALWAYS)\b' "$base/SKILL.md" | wc -l | tr -d ' ')"
    fi
    [ -d "$base/evals" ] && printf 'evals_dir\t%s\n' "$rel/evals"
    # Surface the eval-results file regardless of which naming convention the skill uses. Two names
    # coexist in the registry: `evals.json` (skill-creator's default) and `trigger-eval.json`
    # (triggering-optimization output). A skill may carry either or both, so emit a distinct key per
    # file — never reuse `evals_json` for trigger-eval.json or a both-files skill would emit the key
    # twice and a naive key→value consumer would collapse it.
    [ -f "$base/evals/evals.json" ] && printf 'evals_json\t%s\n' "$rel/evals/evals.json"
    [ -f "$base/evals/trigger-eval.json" ] && printf 'evals_trigger_json\t%s\n' "$rel/evals/trigger-eval.json"
    [ -f "$base/improvements/INDEX.md" ] && printf 'improvements_index\t%s\n' "$rel/improvements/INDEX.md"
    [ -f "$base/improvements/TRIAGE.md" ] && printf 'triage_log\t%s\n' "$rel/improvements/TRIAGE.md"
    [ -d "$base/scripts" ] && printf 'scripts_dir\t%s\n' "$rel/scripts"
    [ -d "$base/assets" ] && printf 'assets_dir\t%s\n' "$rel/assets"
    [ -d "$base/references" ] && printf 'references_dir\t%s\n' "$rel/references"
    # Recursive (`**`) so ONE glob finds a skill's runs under EITHER layout: the v2 shape
    # (artifacts/runs/<work-item>/<facet-or-bare>/ledger.yaml — an engine's --bare run has no
    # facet segment) and the frozen pre-v2 shape (artifacts/runs/<skill-id>/<slug>/ledger.yaml).
    # Search from every base a run could anchor at: the repo root AND each project's own tree
    # (projects/*/artifacts/runs/**), since v2 bases are per-project, not per-service.
    printf 'run_artifact_globs\tartifacts/runs/**/ledger.yaml artifacts/runs/**/tasks.yaml artifacts/runs/**/mission*.yaml projects/*/artifacts/runs/**/ledger.yaml projects/*/artifacts/runs/**/tasks.yaml projects/*/artifacts/runs/**/mission*.yaml\n' ;;

  run-base)
    slug="${1:?usage: run-base <slug>}"; run_base "$slug" ;;

  logline)
    slug="${1:?usage: logline <slug> <skill> <msg...>}"; skill="${2:?usage: logline <slug> <skill> <msg...>}"; shift 2
    dir="$(run_base "$slug")/log"; mkdir -p "$dir"
    printf '%s  %s\n' "$(now)" "$*" >> "$dir/$skill.log"
    printf '%s\n' "$dir/$skill.log" ;;

  report)
    # Render the run's RESULT from its ledger. Deliberately derived, never hand-authored: the ledger is
    # the only state, so a report generated from it cannot disagree with the run (and it cross-checks
    # the ledger's own hand-written summary: rollup against the targets, surfacing drift instead of
    # smoothing it over). Idempotent — re-run mid-sweep for a progress snapshot, or at Finalize for the
    # exit-status artifact.
    slug="${1:?usage: report <slug> [--branch <name>] [--md-only|--json-only] [--quiet]}"; shift
    root="$(repo_root)"; dir="$(read_base "$slug")"
    ledger="$dir/ledger.yaml"
    [ -f "$ledger" ] || { echo "auditor: no ledger at $ledger" >&2; exit 1; }
    py="$(venv_python "$root" || true)"
    [ -n "$py" ] || { echo "auditor: no repo-root .venv python found at $root/.venv (also tried the main checkout's .venv at $(main_root)/.venv — report needs it for PyYAML)" >&2; exit 3; }
    "$py" "$root/$SKILL_DIR_REL/scripts/audit_report.py" --ledger "$ledger" "$@" ;;

  scaffold)
    slug="${1:?usage: scaffold <slug> <skill,skill,...>}"; list="${2:?usage: scaffold <slug> <skill,skill,...>}"
    ts="$(now)"; rid="au-$(date +%s)-$$"; rb="$(run_base "$slug")"
    auto="$(config_get autonomous 2>/dev/null)"; [ -n "$auto" ] || auto="false"
    IFS=',' read -ra arr <<< "$list"
    targets_total=0
    for raw in "${arr[@]}"; do
      s="$(echo "$raw" | xargs)"
      [ -n "$s" ] && targets_total=$((targets_total + 1))
    done
    printf '# %s\n' "▶ LIVE LEDGER for sk-skill-auditor — discover → verify → (autonomous) auto-apply below the safety floor ◀"
    printf 'run: %s\n' "$slug"
    printf 'created: %s\n' "$ts"
    # The base this run PINNED, repo-relative (portable-paths rule). Audit trail + cross-check:
    # if a later iteration's $SIDEKICKS_RUN_BASE disagrees with this line, the scope moved and the
    # run is about to split — stop and re-pin rather than writing to two trees.
    # Repo-relative only (AGENTS.md portable-paths rule). A pin pointing OUTSIDE the repo would survive
    # the prefix strip as a machine-absolute path, so refuse to persist that rather than write it.
    rb_rel="${rb#"$(repo_root)/"}"
    case "$rb_rel" in
      /*) printf 'run_base: null   # pin resolved outside the repo root — not persisted (portable-paths rule)\n' ;;
      *)  printf 'run_base: %s\n' "$rb_rel" ;;
    esac
    printf 'mode: %s          # autonomous → self-verify + auto-apply below the safety floor; classic → file proposals, human applies.\n' "$([ "$auto" = "true" ] && echo autonomous || echo classic)"
    printf 'control:\n  stage: running             # running | pause | stop\n'
    printf '  # The lease is ENFORCED: every RESUME iteration runs `auditor.sh assert <slug> <run_id>` FIRST\n'
    printf '  # (exit 4 = superseded by a takeover, exit 1 = cancelled — stop, no writes, no promise).\n'
    printf '  # `auditor.sh takeover <slug>` adopts an abandoned run once the heartbeat outlives lease_ttl_seconds.\n'
    printf '  lease:\n    run_id: %s\n    claimed_at: %s\n    host: %s\n    heartbeat_at: %s\n' "$rid" "$ts" "$(hostname 2>/dev/null || echo unknown)" "$ts"
    printf 'status: running              # running | done\n'
    printf 'started_at: %s\nfinished_at: null\n' "$ts"
    printf 'summary:                     # rollup, filled at finalize\n'
    printf '  targets_total: %s\n  audited: 0\n  filed: 0\n  applied: 0\n  parked: 0\n  clean: 0\n  failed: 0\n' "$targets_total"
    printf 'notes: []\nruntime_errors: []\ntargets:\n'
    for s in "${arr[@]}"; do
      s="$(echo "$s" | xargs)"; [ -n "$s" ] || continue
      printf '  - skill: %s\n' "$s"
      printf '    status: pending          # pending | in_progress | done | failed\n'
      printf '    outcome: null            # autonomous: applied | parked | mixed | clean   (classic: filed | clean)\n'
      printf '    started_at: null\n    finished_at: null\n'
      printf '    log: log/%s.log            # relative to this run'\''s base — resolve with `auditor.sh run-base %s`\n' "$s" "$slug"
      printf '    filed_ids: []            # all improvement artifact ids filed for this skill\n'
      printf '    verified_ids: []         # autonomous: ids that passed adversarial self-verification\n'
      printf '    applied_ids: []          # autonomous: ids AUTO-APPLIED (verified AND below the safety floor)\n'
      printf '    parked_ids: []           # autonomous: {id, reason: safety-floor|unverified|apply-failed|apply-broke-target} — WAIT for a human\n'
      printf '    no_file: []              # findings TRIAGE dropped: {finding, reason}\n'
      printf '    rounds: []               # one entry per audit round: {at, tier, focus, candidates, filed, verified, applied, parked}\n'
      printf '    rounds_run: 0            # total audit rounds this skill took to converge\n'
      printf '    dry_streak: 0            # consecutive rounds that filed nothing new (loop ends at dry_rounds_to_converge)\n'
      printf '    converged: null          # true = stopped on the dry streak (nothing left to improve); false = stopped on max_rounds_per_skill\n'
      printf '    trigger_eval:            # the measured triggering benchmark for this skill (always run)\n'
      printf '      eval_set_size: null    # number of should/should-not queries scored\n'
      printf '      eval_set_id: null      # self-improve asset id if the set was generated+committed this run\n'
      printf '      baseline_score: null   # current description: passed/total (FIRST run)\n'
      printf '      baseline_score_replicated: null  # the SAME description re-scored — a delta counts only once replicated\n'
      printf '      best_score_replicated: null      # the winner re-scored; file only if its WORST beats baseline BEST\n'
      printf '      best_score: null       # best candidate: passed/total (== baseline if nothing beat it)\n'
      printf '      candidates_tried: 0    # hand-authored candidate descriptions scored (no API key)\n'
      printf '      winning_desc_id: null  # self-improve kind:description id when a candidate measurably won\n'
      printf '      converged: null        # true = score stopped improving / hit perfect; false = hit candidate backstop\n'
      printf '    doctor_before: null      # `skill doctor <target>` error/notice counts BEFORE any apply (step 2)\n'
    printf '    doctor_after: null       # the same counts after the last auto-apply + `skill manifest --apply` (step 7)\n'
    printf '    attempts: 0\n    max_attempts: 2\n    issues: []\n'
    done ;;

  clean)
    # Remove ONLY transient benchmark run outputs. This is deliberately narrow: the auditor's
    # real-run ledger.yaml and log/ under artifacts/runs/skill-auditor/ are the durable exit-status + audit
    # trail and are NEVER deleted here, nor are the committed eval assets. "Clean up after the
    # improvement is done" = drop the throwaway iteration outputs, keep the record.
    #
    # With a <slug> arg, the trigger-root sweep is scoped to THAT run only — the safe form while
    # other audit sessions are live (trigger-roots are keyed "<slug>-<skill>", so a whole-tree
    # rm -rf would yank a concurrent run's scratch mid-score). Bare `clean` keeps the whole-tree
    # sweep but REFUSES it while any live claim exists in the shared coordination registry.
    clean_slug="${1:-}"
    root="$(repo_root)"
    bench="$root/$SKILL_DIR_REL/evals/bench"
    if [ -d "$bench" ]; then
      n="$(find "$bench" -type f 2>/dev/null | wc -l | tr -d ' ')"
      rm -rf "$bench"
      echo "cleaned: $SKILL_DIR_REL/evals/bench/ ($n transient file(s) removed)"
    else
      echo "nothing to clean: no $SKILL_DIR_REL/evals/bench/ present"
    fi
    # With a <slug>, also drop that run's retained score JSONs (<run-base>/trigger/). They are the
    # step-2b working set — needed WHILE the optimize loop runs, throwaway once it has converged and
    # the scores are recorded in the ledger's trigger_eval block. Scoped to the named run only: never
    # swept by the bare form, which cannot know whose loop is still mid-flight.
    if [ -n "$clean_slug" ]; then
      sdir="$(run_base "$clean_slug")/trigger"
      if [ -d "$sdir" ]; then
        sn="$(find "$sdir" -type f 2>/dev/null | wc -l | tr -d ' ')"
        rm -rf "$sdir"
        echo "cleaned: ${sdir#"$root/"}/ ($sn retained score file(s) removed for run '$clean_slug')"
      fi
    fi
    # Also sweep the transient NEUTRAL trigger-roots used to score the triggering benchmark. These
    # are scratch (.claude/commands/ only) under the OS temp dir and carry no durable record.
    tbase="${TMPDIR:-/tmp}"; tbase="${tbase%/}/sk-auditor-trigger"
    if [ -d "$tbase" ]; then
      if [ -n "$clean_slug" ]; then
        tn=0
        for d in "$tbase/$clean_slug" "$tbase/$clean_slug-"*/; do
          [ -e "${d%/}" ] || continue
          rm -rf "${d%/}"; tn=$((tn + 1))
        done
        echo "cleaned: $tbase/$clean_slug* ($tn trigger-root(s) removed for run '$clean_slug')"
      else
        live=""
        cdir="$(claims_dir)"; ttl="$(lease_ttl)"; nowe="$(date +%s)"
        if [ -d "$cdir" ]; then
          for d in "$cdir"/*/; do
            [ -f "${d%/}/owner.tsv" ] || continue
            m="$(mtime_epoch "${d%/}/owner.tsv" 2>/dev/null || true)"
            [ -n "$m" ] && [ $((nowe - m)) -lt "$ttl" ] && { live="$(lock_owner_field slug "${d%/}/owner.tsv")"; break; }
          done
        fi
        if [ -n "$live" ]; then
          echo "auditor: refusing whole-tree trigger-root sweep — another audit run ('$live') is live. Run 'clean <slug>' to sweep only your run's roots." >&2
          exit 4
        fi
        tn="$(find "$tbase" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
        rm -rf "$tbase"
        echo "cleaned: $tbase ($tn transient trigger-root(s) removed)"
      fi
    fi
    echo "kept (durable): committed evals (fixtures, grade.py, ground-truth.yaml, benchmark.md, trigger-eval.json); each audit run's ledger.yaml + log/ + audit-report.md + audit-record.json at its resolved run base (retained score JSONs under <run-base>/trigger/ are swept only by the scoped 'clean <slug>' form)"
    ;;

  *)
    echo "usage: auditor.sh {root|now|exists|groups|group <name>|targets [group]|single-pool|single-current|single-advance|single-reset [skill]|single-status|coord|claim <slug> <rid> <skill>|claim-batch <slug> <rid> <a,b,c>|release <slug> <rid> [skill]|assert <slug> <rid>|takeover <slug>|checkout-lock <slug> <rid>|checkout-unlock <slug> <rid>|config [key]|evidence <skill>|tier-for <n>|eval-set <skill>|trigger-root [slug]|score <slug> <skill> [desc] [label]|run-base <slug>|logline <slug> <skill> <msg>|report <slug> [args]|scaffold <slug> <a,b,c>|clean [slug]}" >&2
    exit 64 ;;
esac
