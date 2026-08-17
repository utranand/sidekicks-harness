#!/usr/bin/env node
// scripts/enforce-flow-headful.mjs
//
// Tool-call hook that DENIES any shell command trying to run the
// sk-flow-automator OR sk-youtube-automator browser in HEADLESS mode.
// Policy (each skill's headful hard rule and CLAUDE.md → "Google-account browser
// automation — headful only"): headless Chrome is the loudest bot-detection signal
// there is, and both automators drive the user's REAL logged-in Google account —
// a bot flag or lockout lands on them.
//
// Defense-in-depth layering (the hook is NOT the primary enforcement):
//   1. flowlib.assert_headful() / ytlib.assert_headful() hard-stop any headless
//      launch/reuse IN CODE — those guards travel with the skills and apply on
//      EVERY agent CLI.
//   2. This hook is the fast, deterministic pre-flight for CLIs with tool-call
//      hooks, wired per Rule 6:
//        - Claude Code : .claude/settings.json  → PreToolUse (matcher: Bash)
//        - Gemini CLI  : .gemini/settings.json  → BeforeTool (matcher: run_command)
//        - Codex CLI   : .codex/config.toml     → PreToolUse
//      Antigravity has no tool-call hook events — it is covered by layer 1 plus
//      the shared AGENTS.md/CLAUDE.md convention.
//
// A command is denied only when it BOTH references one of the automators (their
// scripts or config blocks) AND tries to enable headless ( --headless flag, or
// writing headless: true / headless=true into config). Everything else passes
// untouched.
//
// Contract: BEST-EFFORT. On any internal error it ALLOWS the call (never wedges
// the agent) — layer 1 still catches what slips through. Zero npm dependencies.
//
// Direct test mode (prints the decision it WOULD return):
//   node scripts/enforce-flow-headful.mjs --command "<shell command>"

import { readFileSync } from 'node:fs';

const AUTOMATOR_REF =
  /flow-automator|flowctl\.py|storyboard\.py|flow_automator|youtube-automator|ytctl\.py|ytlib\.py|youtube_automator|trend-scout|trendctl\.py|trend_scout/i;
// generate.py / upload.py / manifest.py are too generic as filenames to key on alone —
// but any real invocation carries the skill path, which AUTOMATOR_REF matches.
const HEADLESS_ENABLE = new RegExp(
  [
    String.raw`--headless\b`,                       // CLI flag (removed, but old muscle memory)
    String.raw`headless\s*[:=]\s*(true|1|yes|on)`,  // config edit / env / yaml or py literal
    String.raw`["']headless["']\s*:\s*(true|True)`, // json / python dict literal
  ].join('|'),
  'i',
);

function extractCommand(evt) {
  const ti = evt?.tool_input ?? {};
  // Claude Bash / Gemini run_command: string. Codex shell: may be an argv array.
  const raw = ti.command ?? ti.cmd ?? ti.script ?? '';
  if (Array.isArray(raw)) return raw.join(' ');
  return String(raw ?? '');
}

function decide(command) {
  if (!command || !AUTOMATOR_REF.test(command)) return null;
  if (!HEADLESS_ENABLE.test(command)) return null;
  return {
    reason:
      'BLOCKED: the sidekicks flow/youtube automators (and trend-scout browser reads) must never run headless (policy ' +
      '— headless Chrome is the loudest bot-detection signal and risks the user\'s ' +
      'real Google account; see each skill\'s headful hard rule). Run the same command ' +
      'without headless — batch runs sit fine in a background tab of the headful ' +
      'automation Chrome.',
  };
}

function main() {
  // Direct test mode
  const flagIdx = process.argv.indexOf('--command');
  if (flagIdx !== -1) {
    const d = decide(process.argv[flagIdx + 1] ?? '');
    console.log(JSON.stringify(d ?? { allow: true }));
    process.exit(0);
  }

  let evt;
  try {
    evt = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // unreadable stdin — allow
  }
  const d = decide(extractCommand(evt));
  if (!d) process.exit(0); // allow
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: d.reason,
    },
  }));
  process.exit(0);
}

// Framework gate: `sidekicks framework disable <id>` makes this hook a no-op (exit 0).
await import('./lib/hook-gate.mjs')
  .then((gate) => gate.exitIfDisabled('hook.enforce-flow-headful'))
  .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

try {
  main();
} catch {
  process.exit(0); // best-effort: never wedge the agent
}
