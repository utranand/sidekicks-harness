#!/usr/bin/env node
// .sidekicks/hooks/rtk-hook.mjs — the PreToolUse dispatcher that routes shell calls through rtk.
//
// Universal across the CLIs that have tool-call hook events (Claude Code, Gemini, Codex); Antigravity
// has none and is a documented omission in lib/framework-lifecycle/tests/multi-cli-parity.test.mjs.
//
// WHY THIS IS NODE AND NOT BASH (INC-2026-09-05-05, W-1). It shipped as `rtk-hook.sh`, a
// `#!/usr/bin/env bash` script with no Windows spelling, wired unconditionally into three CLIs. On a
// Windows box whose CLI cannot execute a POSIX script that line errors or is skipped on EVERY shell
// call — and this hook fires on every one of them. Every other framework hook is already
// `node "$X_PROJECT_DIR/..."`, which runs identically on both platforms, so the port removes the one
// POSIX-only executable in the wiring rather than adding a second dispatcher to keep in sync.
//
// Two things got safer on the way across, both previously forced by shell:
//   - the payload is PARSED, not grepped. The old sniff was `grep '"tool_name":"Bash"'`, which
//     depends on a CLI emitting no space after the colon; a re-serialisation with different spacing
//     would have silently taken the wrong branch. Raw-substring matching survives as the fallback
//     for a payload that will not parse, so nothing regresses.
//   - the permissionDecision repair is an object insertion instead of two `sed` anchors.
//
// WHAT DID NOT CHANGE, and must not: the emitted payload is still ONE line plus a newline, the
// process still exits with rtk's own code (2 is how a PreToolUse hook blocks a call), and every
// stand-down still produces NO output at all. Pinned by tests/rtk-hook-contract.test.mjs.
//
// Zero npm dependencies — node:* plus the shared hook gate.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The framework gate lives in the script, not in the per-CLI wiring — the recorded convention every
// other Node hook follows (.sidekicks/memory/hook-gates-live-in-scripts.md), and what keeps the four
// CLI configs byte-identical. `exitIfDisabled` is exit-0-and-silent when off and FAILS OPEN on any
// resolver error, which is the same three-property contract the old inline shell gate hand-rolled.
//
// Imported DYNAMICALLY for the same reason the gate imports its own resolver that way: a fixture or
// a partial checkout that copies this hook without scripts/lib/ must still route commands rather
// than crash at module-load time.
await import('../../scripts/lib/hook-gate.mjs')
  .then(({ exitIfDisabled }) => exitIfDisabled('hook.rtk'))
  .catch(() => { /* no gate to ask — fail open, exactly as the shell version did */ });

const input = readStdin();
if (!input) process.exit(0);

// Sniff the payload to determine which CLI sent it.
const parsed = tryParse(input);
const toolName = parsed && typeof parsed.tool_name === 'string' ? parsed.tool_name : null;
const isBash = toolName !== null
  ? toolName === 'Bash'
  : /"tool_name"\s*:\s*"Bash"/.test(input);
const isRunCommand = parsed
  ? Object.prototype.hasOwnProperty.call(parsed, 'run_command')
    || Object.prototype.hasOwnProperty.call(parsed.tool_input ?? {}, 'run_command')
  : input.includes('"run_command"');

if (!isBash && isRunCommand) {
  // Antigravity / Gemini CLI. A different envelope and a different contract — passed through
  // untouched, because the PreToolUse repair below is Claude-shaped and would corrupt it.
  process.exit(route('gemini').code);
}

// Claude Code matches "Bash" tool calls. Codex's PreToolUse payload carries the same documented
// {tool_name, tool_input} envelope but rtk ships no `hook codex` processor, so the compatible
// envelope goes through the Claude one; an unrecognised payload keeps the historical fail-open path.
const claude = route('claude');
emit(claude.stdout);
process.exit(claude.code);

// ── helpers ──────────────────────────────────────────────────────────────────

/** @returns {string} the whole hook payload from stdin, or '' when there is none. */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** @param {string} text @returns {object|null} */
function tryParse(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Hand the payload to rtk's processor for one CLI.
 *
 * The exit code is preserved and returned rather than swallowed: 2 is how a PreToolUse hook BLOCKS
 * a call, and the shell version needed a named function to stop `$(...)` from eating it.
 *
 * ABSENT rtk IS THE SAME PATH. rtk is the user's own binary, not a dependency of this repo, so a
 * fresh clone on a machine without it must not turn every shell call into a failed hook. The spawn
 * error (ENOENT) is the probe — no `command -v` / `where` shell-out, which is one fewer process per
 * tool call and one fewer platform difference. It yields no output and exit 0: the CLI's "no
 * opinion" shape, identical to a stand-down.
 *
 * @param {'claude'|'gemini'} cli
 * @returns {{stdout: string, code: number}}
 */
function route(cli) {
  const r = spawnSync('rtk', ['hook', cli], { input, encoding: 'utf8', windowsHide: true });
  if (r.error) return { stdout: '', code: 0 };
  return { stdout: r.stdout || '', code: typeof r.status === 'number' ? r.status : 0 };
}

/**
 * Emit rtk's output, repairing the PreToolUse contract on the way.
 *
 * rtk (through 0.42.3) emits a payload carrying `updatedInput` and a `permissionDecisionReason` but
 * NO `permissionDecision`. Claude Code rejects exactly that combination — "PreToolUse hook returned
 * updatedInput without permissionDecision:allow" — so the hook is reported as failed and the rewrite
 * is lost. The contract pairs the two: an input rewrite is only honoured together with an explicit
 * allow, so the allow is ADDED here rather than the rewrite being dropped.
 *
 * CONSEQUENCE, stated because it is a real widening: `allow` means the rewritten command skips the
 * permission prompt it would otherwise have raised. Other PreToolUse hooks still run, so a deny from
 * one of them still wins, but the user's Bash allowlist no longer sees the call. Set
 * SIDEKICKS_RTK_AUTOALLOW=off to keep the prompts instead — the rewrite is then dropped and the
 * original command runs unchanged: no failed hook, no token saving.
 *
 * @param {string} out - rtk's stdout
 */
function emit(out) {
  if (!out) return;

  // Nothing to repair: no rewrite at all.
  if (!out.includes('"updatedInput"')) { write(out); return; }
  // The decision is already there. `"permissionDecision"` carries its closing quote ON PURPOSE —
  // `"permissionDecisionReason"` contains the bare key as a prefix and must not match it.
  if (out.includes('"permissionDecision"')) { write(out); return; }

  if ((process.env.SIDEKICKS_RTK_AUTOALLOW ?? 'on') === 'off') return;

  const payload = tryParse(out);
  const hso = payload?.hookSpecificOutput;
  if (hso && typeof hso === 'object' && !Array.isArray(hso)) {
    // Structured insertion. `hookEventName` first when present, so the emitted key order matches
    // what the shell version's first sed anchor produced.
    payload.hookSpecificOutput = hso.hookEventName !== undefined
      ? { hookEventName: hso.hookEventName, permissionDecision: 'allow', ...hso }
      : { permissionDecision: 'allow', ...hso };
    write(JSON.stringify(payload));
    return;
  }

  // Unparseable, or shaped in a way this does not recognise. Emitting it unchanged would reproduce
  // the very failure this exists to prevent, so stand down with no output and let the original
  // command run.
}

/** @param {string} text - always one line plus a newline; the CLI reads it as a single payload. */
function write(text) {
  process.stdout.write(`${text.replace(/\r?\n/g, '')}\n`);
}
