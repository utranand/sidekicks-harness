#!/usr/bin/env bash
# Universal RTK hook dispatcher for AI CLI agents
# Acts as a single source of truth for routing commands through rtk

# Read the JSON hook payload from stdin
INPUT=$(cat)

# ── Framework gate (hook.rtk) ────────────────────────────────────────────────
# `sidekicks framework disable hook.rtk` turns this dispatcher into a pass-through.
# This hook fires on EVERY Bash tool call, so the gate has a deliberate fast path: it
# only spawns node when the committed enable map actually mentions the id. With no
# framework.yaml (a fresh clone) or no `rtk:` entry, nothing is spawned at all.
#
# It FAILS OPEN in every direction — an unreadable settings file, a missing node, a
# broken resolver: rtk still runs. Only the ONE exit code that means "disabled" (1)
# stands the hook down; 2 (malformed id), 127 (no node) and anything else fall through,
# because a settings subsystem must never be able to wedge the user's Bash.
#
# Standing down means producing NO output and exiting 0 — the CLI's "no opinion" shape
# for a hook. Echoing the payload back would look like hook output and be parsed as one.
_sk_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
_sk_framework="$_sk_root/.sidekicks/framework.yaml"
if [ -n "$_sk_root" ] && [ -f "$_sk_framework" ] && grep -Eq '^[[:space:]]+rtk[[:space:]]*:' "$_sk_framework"; then
  node "$_sk_root/bin/sidekicks" framework check hook.rtk --quiet >/dev/null 2>&1
  _sk_gate=$?
  if [ "$_sk_gate" -eq 1 ]; then
    exit 0
  fi
fi

# Sniff the payload to determine which CLI sent it
if echo "$INPUT" | grep -q '"tool_name":"Bash"'; then
  # Claude Code matches "Bash" tool calls
  echo "$INPUT" | rtk hook claude
elif echo "$INPUT" | grep -q '"run_command"'; then
  # Antigravity (Gemini CLI) matches "run_command" tool calls
  echo "$INPUT" | rtk hook gemini
else
  # Codex's PreToolUse payload has the same documented {tool_name, tool_input}
  # envelope as Claude, but RTK currently ships no `hook codex` processor.
  # Route the compatible envelope through its Claude processor; unknown payloads
  # retain the historical fail-open behavior.
  echo "$INPUT" | rtk hook claude
fi
