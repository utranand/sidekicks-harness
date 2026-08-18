#!/usr/bin/env bash
# Universal RTK hook dispatcher for AI CLI agents
# Acts as a single source of truth for routing commands through rtk

# Read the JSON hook payload from stdin
INPUT=$(cat)

# rtk is the user's own binary and is not a dependency of this repo. A fresh clone on a machine
# without it must not turn every Bash call into a failed hook, so an absent rtk stands the
# dispatcher down silently — same "no opinion" shape as the framework gate below.
command -v rtk >/dev/null 2>&1 || exit 0

# ── Framework gate (hook.rtk) ────────────────────────────────────────────────
# `sidekicks framework disable hook.rtk` turns this dispatcher into a pass-through.
# This hook fires on EVERY Bash tool call, so the gate has a deliberate fast path: it
# only spawns node when the committed enable map actually mentions the id. With no
# enable map (a fresh clone) or no `rtk:` entry, nothing is spawned at all.
#
# TWO map paths, and the second is the legacy one. Settings moved from the `.sidekicks/framework.yaml`
# monolith into `.sidekicks/config/settings/hooks.yaml`, where the top level IS the slug map — so the
# entry is `rtk:` at column 0, not indented under a `hooks:` key. The old pattern required leading
# whitespace and looked only at the old path, so on every migrated checkout the fast path never
# matched, node was never spawned, and `framework disable hook.rtk` was silently a no-op.
#
# It FAILS OPEN in every direction — an unreadable settings file, a missing node, a
# broken resolver: rtk still runs. Only the ONE exit code that means "disabled" (1)
# stands the hook down; 2 (malformed id), 127 (no node) and anything else fall through,
# because a settings subsystem must never be able to wedge the user's Bash.
#
# Standing down means producing NO output and exiting 0 — the CLI's "no opinion" shape
# for a hook. Echoing the payload back would look like hook output and be parsed as one.
_sk_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
for _sk_map in \
  "$_sk_root/.sidekicks/config/settings/hooks.yaml" \
  "$_sk_root/.sidekicks/framework.yaml"
do
  [ -n "$_sk_root" ] && [ -f "$_sk_map" ] || continue
  grep -Eq '^[[:space:]]*rtk[[:space:]]*:' "$_sk_map" || continue
  # No CLI to ask, no opinion to read. `framework check` answers "disabled" with exit 1 — and so
  # does node when the module is missing, so spawning it without the file present would read
  # "there is no CLI here" as "the operator turned this off". Fail OPEN instead.
  [ -f "$_sk_root/bin/sidekicks" ] || break
  node "$_sk_root/bin/sidekicks" framework check hook.rtk --quiet >/dev/null 2>&1
  _sk_gate=$?
  if [ "$_sk_gate" -eq 1 ]; then
    exit 0
  fi
  break
done

# ── PreToolUse contract repair ───────────────────────────────────────────────
# rtk (through 0.42.3) emits a PreToolUse payload carrying `updatedInput` and a
# `permissionDecisionReason` but NO `permissionDecision`. Claude Code rejects exactly that
# combination — "PreToolUse hook returned updatedInput without permissionDecision:allow" — so
# the hook is reported as failed and the rewrite is lost. The contract pairs the two: an input
# rewrite is only honoured together with an explicit allow, so the allow is added here rather
# than the rewrite being dropped.
#
# CONSEQUENCE, stated because it is a real widening: `allow` means the rewritten command skips
# the permission prompt it would otherwise have raised. Other PreToolUse hooks still run, so a
# deny from one of them still wins, but the user's Bash allowlist no longer sees the call.
# Set SIDEKICKS_RTK_AUTOALLOW=off to keep the prompts instead — the rewrite is then dropped and
# the original command runs unchanged: no failed hook, no token saving.
#
# Only the Claude-shaped output goes through this; Antigravity's envelope is a different
# contract and is passed through untouched.
_sk_emit() {
  _sk_out=$1
  # Nothing to repair: no rewrite, or the decision is already there. `"permissionDecision"`
  # carries its closing quote on purpose — `"permissionDecisionReason"` must not match it.
  case $_sk_out in
    *'"updatedInput"'*) ;;
    *) printf '%s\n' "$_sk_out"; return ;;
  esac
  case $_sk_out in
    *'"permissionDecision"'*) printf '%s\n' "$_sk_out"; return ;;
  esac
  if [ "${SIDEKICKS_RTK_AUTOALLOW:-on}" = "off" ]; then
    return
  fi
  # Two anchors, tried in order, because the key order inside hookSpecificOutput is rtk's to
  # choose: after the event name when it is present, otherwise immediately inside the object.
  _sk_fixed=$(printf '%s\n' "$_sk_out" | sed 's/\("hookEventName"[[:space:]]*:[[:space:]]*"PreToolUse"\)/\1,"permissionDecision":"allow"/')
  case $_sk_fixed in
    *'"permissionDecision"'*) printf '%s\n' "$_sk_fixed"; return ;;
  esac
  _sk_fixed=$(printf '%s\n' "$_sk_out" | sed 's/\("hookSpecificOutput"[[:space:]]*:[[:space:]]*{\)/\1"permissionDecision":"allow",/')
  case $_sk_fixed in
    *'"permissionDecision"'*) printf '%s\n' "$_sk_fixed"; return ;;
  esac
  # Neither anchor found. Emitting the payload unchanged would reproduce the very failure this
  # exists to prevent, so stand down and let the original command run.
  return
}

# Preserve rtk's exit code: 2 is how a PreToolUse hook blocks a call, and a command
# substitution would swallow it.
_sk_route_claude() {
  _sk_raw=$(printf '%s' "$INPUT" | rtk hook claude)
  _sk_rc=$?
  _sk_emit "$_sk_raw"
  return $_sk_rc
}

# Sniff the payload to determine which CLI sent it
if echo "$INPUT" | grep -q '"tool_name":"Bash"'; then
  # Claude Code matches "Bash" tool calls
  _sk_route_claude
elif echo "$INPUT" | grep -q '"run_command"'; then
  # Antigravity (Gemini CLI) matches "run_command" tool calls
  printf '%s' "$INPUT" | rtk hook gemini
else
  # Codex's PreToolUse payload has the same documented {tool_name, tool_input}
  # envelope as Claude, but RTK currently ships no `hook codex` processor.
  # Route the compatible envelope through its Claude processor; unknown payloads
  # retain the historical fail-open behavior.
  _sk_route_claude
fi
