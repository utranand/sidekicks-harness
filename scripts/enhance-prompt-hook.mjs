#!/usr/bin/env node
// enhance-prompt-hook.mjs — UserPromptSubmit hook (GATED)
//
// Why this exists: blanket auto-enhancing every prompt is harmful — it taxes
// every turn and mangles literal signals (slash commands, bare card keys,
// one-word confirmations, pasted paths). So enhancement is OPT-IN per prompt:
// the user prefixes a request with the `??` marker to ask for it.
//
// On a `??`-prefixed prompt this injects a directive telling the agent to
// sharpen the request inline (clarify intent, surface missing params/scope,
// structure multi-step work), show the sharpened version, then act on it —
// asking first only when key facts are missing or the action is irreversible.
// The enhancement is done by the model itself (it already has full context);
// the hook does NOT shell out to a second LLM, so there is no extra latency or
// token cost on a normal prompt.
//
// It is intentionally silent on every prompt that does NOT start with `??` —
// no output, exit 0 — so it never interferes with normal use, slash commands,
// or path hand-offs. It never blocks a prompt: any error is swallowed.
//
// Wired via .claude/settings.json → hooks.UserPromptSubmit. Zero dependencies.

import { readFileSync } from 'node:fs';

// The opt-in marker. A prompt qualifies when its first non-whitespace
// characters are `??` (so "?? do X" fires; a mid-sentence "what?? " does not,
// and a lone "?" question does not).
const MARKER = /^\s*\?\?/;

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const DIRECTIVE =
  `[enhance-prompt] The user prefixed this prompt with the \`??\` opt-in marker, ` +
  `asking you to ENHANCE their request before acting on it. Treat the \`??\` purely ` +
  `as the marker — it is NOT part of the request; ignore it and work from the text ` +
  `after it. Steps: (1) Construct a SHARPENED version of their request — make the ` +
  `intent explicit, surface any missing parameters/scope/inputs a downstream skill ` +
  `would need, name the right skill or tool if one clearly fits, and structure ` +
  `multi-step work into ordered steps. (2) Show the sharpened prompt briefly so the ` +
  `user sees what you understood. (3) Then act on the sharpened version. ` +
  `BUT: if key facts are missing (e.g. an env alias, a target, an ambiguous scope) ` +
  `or the action is irreversible/risky, ASK for the missing piece or confirm BEFORE ` +
  `acting — do not invent values. Do not over-inflate a short, already-clear request; ` +
  `match the user's intent and keep it lean.`;

function main() {
  // Delegate wakes are exempt: the wake prompt is machine-built (delegate.mjs),
  // never `??`-prefixed by a human — skip deterministically instead of pattern-
  // matching a prompt no user wrote. Interactive sessions only.
  if (process.env.SIDEKICKS_DELEGATE_WAKE === '1') return;

  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    return; // malformed payload — stay out of the way
  }

  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt || !MARKER.test(prompt)) return; // not opted in — silent

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: DIRECTIVE,
      },
    })
  );
}

// Framework gate: `sidekicks framework disable <id>` makes this hook a no-op (exit 0).
await import('./lib/hook-gate.mjs')
  .then((gate) => gate.exitIfDisabled('hook.enhance-prompt'))
  .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

main();
