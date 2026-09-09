#!/usr/bin/env bash
# Deterministic helpers for sk-auto-improve.
# Root-scope: everything resolves from the git repo root (walk up for .sidekicks/ — NEVER
# `git rev-parse`, since a service src/ is its own repo). No work_dir/docs_dir.
#
# Subcommands:
#   root                         print the repo root (dir containing .sidekicks/)
#   now                          print an Asia/Bangkok ISO-8601 timestamp
#   exists <skill>               exit 0 if .agents/skills/<skill>/ is an ACTIVE skill, else 1
#   proposed <skill>             list this skill's PROPOSED improvement artifacts, one per line:
#                                  <id>\t<kind>\t<risk>\t<additive-safe?>
#                                additive-safe = (risk==low AND kind==assets). The final
#                                "purely-additive new file" judgment still belongs to the agent +
#                                sk-self-improve's auto-apply gate — this is a fast prefilter.
#   scaffold <slug> <a,b,c>      emit a fresh ledger.yaml (targets = the comma-list) to stdout
#   run-base <slug>              resolve this run's v2 folder (runs layout v2, --bare shape: the
#                                run slug IS the work item) via `scope run-base sk-auto-improve
#                                <slug> --bare`; falls back to the frozen pre-v2 path
#                                `<root>/artifacts/runs/auto-improve/<slug>` when the CLI verb is
#                                unavailable. Never hand-join the path elsewhere.
set -euo pipefail

repo_root() {
  local d="$PWD"
  while [ "$d" != "/" ] && [ ! -d "$d/.sidekicks" ]; do d="$(dirname "$d")"; done
  [ -d "$d/.sidekicks" ] || { echo "auto_improve: no .sidekicks/ found above $PWD" >&2; exit 2; }
  printf '%s\n' "$d"
}

now() { TZ=Asia/Bangkok date +%Y-%m-%dT%H:%M:%S+07:00; }

# run_base <slug> — the ONE place the v2 run-folder join lives for this skill. --bare: the run
# slug IS the work item, so this is the run's own folder with no facet layer beneath it.
run_base() {
  local slug="${1:?usage: run_base <slug>}" root out
  # A run resolves its base ONCE and exports it; later invocations then cost no subprocess.
  if [ -n "${SIDEKICKS_RUN_BASE:-}" ]; then printf '%s\n' "$SIDEKICKS_RUN_BASE"; return 0; fi
  root="$(repo_root)"
  out="$(node "$root/bin/sidekicks" scope run-base sk-auto-improve "$slug" --bare 2>/dev/null)" || out=""
  if [ -n "$out" ]; then printf '%s\n' "$out"; else printf '%s\n' "$root/artifacts/runs/auto-improve/$slug"; fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
  root) repo_root ;;

  now) now ;;

  exists)
    skill="${1:?usage: exists <skill>}"
    root="$(repo_root)"
    if [ -f "$root/.agents/skills/$skill/SKILL.md" ]; then exit 0; else exit 1; fi
    ;;

  proposed)
    skill="${1:?usage: proposed <skill>}"
    root="$(repo_root)"
    dir="$root/.agents/skills/$skill/improvements"
    [ -d "$dir" ] || exit 0
    for f in "$dir"/*.yaml; do
      [ -e "$f" ] || continue
      case "$(basename "$f")" in INDEX*|*.template.yaml) continue ;; esac
      status="$(grep -E '^status:' "$f" | head -1 | sed 's/^status:[[:space:]]*//; s/[[:space:]]*#.*//')"
      [ "$status" = "proposed" ] || continue
      id="$(grep -E '^id:' "$f" | head -1 | sed 's/^id:[[:space:]]*//; s/[[:space:]]*#.*//')"
      kind="$(grep -E '^kind:' "$f" | head -1 | sed 's/^kind:[[:space:]]*//; s/[[:space:]]*#.*//')"
      risk="$(grep -E '^risk:' "$f" | head -1 | sed 's/^risk:[[:space:]]*//; s/[[:space:]]*#.*//')"
      safe="no"; [ "$risk" = "low" ] && [ "$kind" = "assets" ] && safe="maybe"
      printf '%s\t%s\t%s\t%s\n' "$id" "$kind" "$risk" "$safe"
    done
    ;;

  scaffold)
    slug="${1:?usage: scaffold <slug> <skill,skill,...>}"
    list="${2:?usage: scaffold <slug> <skill,skill,...>}"
    ts="$(now)"
    rid="ai-$(date +%s)-$$"
    printf '# %s\n' "▶ LIVE LEDGER for sk-auto-improve — additive-only, never applies behavior changes ◀"
    printf 'run: %s\n' "$slug"
    printf 'created: %s\n' "$ts"
    printf 'mode: additive-only          # FIXED. Auto-applies ONLY risk:low + kind:assets + purely additive.\n'
    printf 'control:\n  stage: running             # running | pause | stop\n'
    printf '  lease:\n    run_id: %s\n    heartbeat_at: %s\n' "$rid" "$ts"
    printf 'status: running              # running | done\n'
    printf 'started_at: %s\nfinished_at: null\n' "$ts"
    printf 'summary:                     # rollup, filled at close\n'
    printf '  targets_total: 0\n  applied: 0\n  waiting: 0\n  clean: 0\n  failed: 0\n'
    printf 'notes: []\nruntime_errors: []\ntargets:\n'
    IFS=',' read -ra arr <<< "$list"
    for s in "${arr[@]}"; do
      s="$(echo "$s" | xargs)"; [ -n "$s" ] || continue
      printf '  - skill: %s\n' "$s"
      printf '    source: harvest          # "harvest" = scan its own proposed additive artifacts; or an evidence path\n'
      printf '    status: pending          # pending | in_progress | done | failed\n'
      printf '    outcome: null            # applied | waiting | clean | mixed\n'
      printf '    started_at: null\n    finished_at: null\n'
      printf '    applied_ids: []\n    waiting_ids: []\n    no_file: null\n'
      printf '    attempts: 0\n    max_attempts: 2\n    issues: []\n'
    done
    ;;

  run-base)
    slug="${1:?usage: run-base <slug>}"; run_base "$slug" ;;

  *)
    echo "usage: auto_improve.sh {root|now|exists <skill>|proposed <skill>|scaffold <slug> <a,b,c>|run-base <slug>}" >&2
    exit 64 ;;
esac
