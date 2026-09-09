#!/usr/bin/env bash
# offload_skill.sh — SHIM. The engine is now `sidekicks skill offload`.
#
# This script used to BE the engine: a `grep -rIlE` reference scan plus `git mv`. Both halves were
# replaced, for reasons that are not stylistic:
#
#   - PORTABILITY. BSD and GNU grep disagree on flags, and bash is not guaranteed on Windows. The
#     framework has to run identically on macOS and Windows from one implementation, and a shell
#     script is the one thing that cannot.
#   - PRECISION. A text grep cannot tell a wired invocation (a whole quoted literal) from the same
#     word inside a sentence, and it matched `artifacts/runs/<skill>/` paths as if they were
#     dependencies. lib/skill-lifecycle/references.mjs draws both distinctions, and is shared with
#     `sidekicks skill remove` so the two verbs cannot drift apart.
#   - RULE 1. Offloading now updates the skill's registration profile under `.sidekicks/registry/`,
#     and only the CLI may write there.
#
# The shim stays because command-sequences, lifted copies and muscle memory still call it. Its
# output still contains the BLOCKING / "OK — no active skill references" tokens the old one printed.
#
# Usage (unchanged):
#   offload_skill.sh check   <skill-name>
#   offload_skill.sh offload <skill-name> [--force]
#   offload_skill.sh restore <skill-name>
#   offload_skill.sh list
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$ROOT" ] || { echo "ERROR: not inside a git repo — run from within the Sidekicks repo." >&2; exit 1; }

SUB="${1:-}"
shift || true

echo "note: offload_skill.sh is a shim — the engine is 'sidekicks skill offload'." >&2

case "$SUB" in
  check)
    [ $# -ge 1 ] || { echo "ERROR: check needs a skill name" >&2; exit 1; }
    exec node "$ROOT/bin/sidekicks" skill offload "$1"
    ;;
  offload)
    [ $# -ge 1 ] || { echo "ERROR: offload needs a skill name" >&2; exit 1; }
    NAME="$1"; shift
    if [ "${1:-}" = "--force" ]; then
      exec node "$ROOT/bin/sidekicks" skill offload "$NAME" --apply --force
    fi
    exec node "$ROOT/bin/sidekicks" skill offload "$NAME" --apply
    ;;
  restore)
    [ $# -ge 1 ] || { echo "ERROR: restore needs a skill name" >&2; exit 1; }
    exec node "$ROOT/bin/sidekicks" skill offload "$1" --restore --apply
    ;;
  list)
    exec node "$ROOT/bin/sidekicks" skill offload --list
    ;;
  *)
    echo "ERROR: unknown sub-command '${SUB}' — check | offload | restore | list" >&2
    exit 1
    ;;
esac
