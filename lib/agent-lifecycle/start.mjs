// lib/agent-lifecycle/start.mjs
// `sidekicks agent start <name> [--role orchestrator|worker] [--cli claude|codex|gemini|antigravity] [--model <tier|id>] [--print] [--spawn]`
//
// Launches a NEW terminal session for a named agent, using the CLI configured
// in its charter (charter.cli), the bootstrap prompt appropriate to its role
// (charter.role, default 'worker'), and the model configured on its charter
// (charter.model, a tier keyword or an explicit model id — resolved to a
// concrete `--model <value>` flag here). There is no portable API to open a
// new integrated terminal running an interactive agent CLI that may itself be
// a shell function/alias (e.g. `claude`), so the reliable behavior is to
// PRINT a ready-to-run command; opening a new terminal window is best-effort
// on top and never the only output.
//
// Launch-mode precedence: --print (always print, never spawn) > no GUI session
// (a window CANNOT be hosted — explicit --spawn is REFUSED, auto degrades to
// print) > --spawn (force the spawn attempt even from inside the VS Code
// integrated terminal — this is what lets an orchestrator agent open a
// worker's window while itself running in an editor pane) > auto (spawn unless
// inside vscode or no terminal launcher is available on this platform, else
// print). The decision itself is a pure function (decideLaunchMode) so it is
// unit-testable without ever opening a real window;
// SIDEKICKS_AGENT_START_NO_EXEC=1 lets a caller (or a test) exercise the full
// spawn branch as a dry run — everything is resolved and reported, but the
// actual child_process.spawn is skipped.
//
// HONEST LAUNCH REPORTING (INC-20260726-01). A terminal spawn used to be
// fire-and-forget: the AppleScript/emulator child was spawned detached with
// its 'error' event swallowed, and the verb printed "A new Terminal.app window
// was opened" unconditionally. In a session with no GUI to host a window (a
// headless `agent delegate` wake, ssh, launchd) that line was a LIE — the
// worker never came online, and the orchestrator that believed it left a task
// unclaimed for 14 minutes. Two guards close that class of failure:
//   1. detectGuiSession() — refuse an explicit --spawn that cannot possibly
//      work, naming the lanes that DO work (--headless --force, or paste).
//   2. Verified launcher results — macOS runs osascript SYNCHRONOUSLY and
//      reports its real exit status/stderr; every launcher returns whether the
//      outcome was verified, and an unverified launch says so instead of
//      claiming success. `--wait-online[=secs]` closes the loop by polling
//      real presence and exiting non-zero when the agent never heartbeats.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawn, spawnSync } from 'node:child_process';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  parseMemoryFlags,
  validateAgentName,
  assertModelId,
  requireCharter,
  readControlStage,
  writeControlStage,
  readPresence,
  presenceState,
  AGENT_CLIS,
  CLI_LAUNCH,
  resolveCharterCli,
} from './_shared.mjs';
import { ensureCommsProcesses, spawnDaemon } from './_comms.mjs';
import { writePidFile, isDaemonRunning, readJsonFile, pidFilePath } from './_bridge.mjs';
import { composePrimaryPrompt } from './_primary-prompt.mjs';
import { privateSkillContext } from './_skill-store.mjs';
import { cmdEscapeArg } from './_win-argv.mjs';

const ROLES = ['orchestrator', 'worker'];

// charter.cli -> { bin, promptMode } now lives in _shared.mjs beside AGENT_CLIS
// (imported above) so the valid set, the launch descriptors and the charter
// validator cannot drift apart. promptMode captures how each CLI wants the
// bootstrap prompt handed to it — claude/codex/gemini all take it as a bare
// positional argument (gemini's positional form runs interactive by default),
// but Antigravity's `agy` has NO bare positional prompt: its
// interactive-with-prompt form is `agy -i "<prompt>"` (verified live).

// Tier → concrete model per CLI (CLAUDE.md's tier table: top/high/mid/low).
// Model ids drift as vendors release new versions — edit this map, not the
// resolution logic. The claude row is a verified `claude --model <alias>`
// mapping (fable/opus/sonnet/haiku are accepted directly by the CLI); the
// gemini/codex rows are best-effort defaults and may need updating.
export const TIER_MODELS = {
  claude: { top: 'fable', high: 'opus', mid: 'sonnet', low: 'haiku' },   // verified CLI aliases
  gemini: { top: 'gemini-2.5-pro', high: 'gemini-2.5-pro', mid: 'gemini-2.5-flash', low: 'gemini-2.5-flash-lite' },
  // Verified live against codex-cli 0.142.5 on a CHATGPT-ACCOUNT auth: both
  // `gpt-5-codex` and `gpt-5-codex-mini` are refused there with
  //   400 invalid_request_error: The 'gpt-5-codex' model is not supported when
  //   using Codex with a ChatGPT account.
  // …because those are API-key models. `gpt-5.5` (this install's own
  // config.toml default) runs clean, so it is what the tiers name.
  // On an OPENAI_API_KEY auth the gpt-5-codex family is the better fit — swap
  // the row if you move to one. Deliberately NO `top` key: codex is not a
  // top-tier seat, and `model: top` on a codex charter is a hard error at every
  // `agent start` rather than a silent downgrade.
  codex:  { high: 'gpt-5.5', mid: 'gpt-5.5', low: 'gpt-5.5' },
  // Ids came from a live `agy models` listing — the reasoning effort is
  // encoded in the id suffix (…-high/-medium/-low), so no separate --effort
  // flag is emitted. Drifts as Antigravity ships new models.
  antigravity: { top: 'gemini-3.1-pro-high', high: 'gemini-3.1-pro-high', mid: 'gemini-3.6-flash-medium', low: 'gemini-3.6-flash-low' },
};
const TIERS = ['top', 'high', 'mid', 'low'];

/**
 * Build the bootstrap prompt for a role. Deliberately free of embedded
 * double-quote characters so it can be single-quoted (POSIX) or wrapped in
 * double quotes (Windows cmd) without extra escaping.
 */
function bootstrapPrompt(name, role) {
  if (role === 'orchestrator') {
    return `You are agent '${name}'. Run the sk-agent-master skill as '${name}': it loads your charter and memory, then routes every assignment to a specialist agent or a session subagent — you never do domain work yourself.`;
  }
  return `Run the sk-agent-standby skill for agent '${name}'.`;
}

/** Single-quote a string for a POSIX shell (the only correct general form). */
function posixSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a string for Windows cmd.exe.
 *
 * Delegated to the one audited encoder (lib/agent-lifecycle/_win-argv.mjs). The previous form here
 * was `"${s.replace(/"/g, '\\"')}"` — a partial C-runtime convention that cmd.exe does not honour
 * for its own parse at all, so `& | % ! ^ ( )` in a charter or prompt reached the launch line as
 * syntax rather than as data.
 */
function windowsDoubleQuote(s) {
  return cmdEscapeArg(s);
}

/** Escape a string for embedding inside a double-quoted AppleScript literal. */
function appleScriptEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Synchronous "is this binary on PATH" check (`which`/`where`) — spawning a
 * missing terminal emulator does not throw synchronously (ENOENT surfaces as
 * an async 'error' event), so probing first is what makes the fallback chain
 * (x-terminal-emulator → gnome-terminal → konsole, wt.exe → cmd) actually work.
 */
function commandExists(bin) {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(finder, [bin], { stdio: 'ignore' });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/** Spawn detached + unref'd, swallowing any async 'error' event (best-effort). */
function spawnDetached(bin, spawnArgs, extraOptions = {}) {
  const child = spawn(bin, spawnArgs, { detached: true, stdio: 'ignore', ...extraOptions });
  child.on('error', () => {}); // never let a missing binary crash the process
  child.unref();
  return child;
}

// ---------------------------------------------------------------------------
// GUI-session detection — can this process host a terminal WINDOW at all?
// ---------------------------------------------------------------------------

/**
 * Pure classification of "is there a GUI session that can host a new window",
 * given already-probed inputs. Kept free of I/O so the whole decision table is
 * unit-testable on every platform regardless of the host running the test.
 *
 * Fails OPEN (assumes a GUI) whenever the platform signal is unavailable or
 * unrecognised: a false 'no GUI' would refuse launches that actually work,
 * which is worse than the (now loudly-reported) spawn attempt.
 *
 * @param {{ platform: string, env: object, macManagerName?: string|null }} opts
 *   macManagerName - `launchctl managername` output on darwin ('Aqua' in a
 *   real login session; 'Background'/'StandardIO' in a daemon/ssh context),
 *   or null when it could not be probed.
 * @returns {{ hasGui: boolean, reason: string }}
 */
export function classifyGuiSession({ platform, env = {}, macManagerName = null }) {
  const override = envGuiOverride(env);
  if (override != null) {
    return { hasGui: override, reason: `SIDEKICKS_AGENT_START_ASSUME_GUI=${override ? '1' : '0'} (override)` };
  }
  if (platform === 'darwin') {
    const mgr = macManagerName == null ? '' : String(macManagerName).trim();
    if (!mgr) return { hasGui: true, reason: 'launchctl managername unavailable — assuming a GUI session' };
    if (mgr === 'Aqua') return { hasGui: true, reason: 'macOS Aqua login session' };
    return { hasGui: false, reason: `macOS session type '${mgr}' (not Aqua) — no window server attached` };
  }
  if (platform === 'win32') {
    const session = String(env.SESSIONNAME || '').trim();
    if (session && /^services$/i.test(session)) {
      return { hasGui: false, reason: 'Windows service session (SESSIONNAME=Services) — session 0 has no desktop' };
    }
    return { hasGui: true, reason: 'Windows interactive session' };
  }
  // Linux/BSD: an X or Wayland display is the only reliable signal.
  if (env.DISPLAY || env.WAYLAND_DISPLAY) {
    return { hasGui: true, reason: env.WAYLAND_DISPLAY ? 'WAYLAND_DISPLAY set' : 'DISPLAY set' };
  }
  return { hasGui: false, reason: 'no DISPLAY/WAYLAND_DISPLAY — no X/Wayland session attached' };
}

/**
 * Read the operator override: SIDEKICKS_AGENT_START_ASSUME_GUI=1 forces "there
 * IS a GUI" (a host whose session type we misread), =0 forces "there is none"
 * (a headless box, and the lever tests use to exercise the refusal path).
 * @returns {boolean|null} null when unset/unrecognised — probe instead.
 */
export function envGuiOverride(env = {}) {
  const raw = env.SIDEKICKS_AGENT_START_ASSUME_GUI;
  if (raw == null || String(raw).trim() === '') return null;
  const v = String(raw).trim();
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  return null;
}

/**
 * Probe the host for a GUI session (the I/O half of classifyGuiSession).
 * Only darwin needs a subprocess; `launchctl managername` is cheap (<10ms) and
 * present on every macOS since 10.10.
 */
function detectGuiSession(platform, env = process.env) {
  let macManagerName = null;
  if (platform === 'darwin' && envGuiOverride(env) == null) {
    try {
      const r = spawnSync('launchctl', ['managername'], { encoding: 'utf8', timeout: 5000 });
      if (!r.error && r.status === 0) macManagerName = (r.stdout || '').trim();
    } catch {
      macManagerName = null; // fail open — classifyGuiSession assumes a GUI
    }
  }
  return classifyGuiSession({ platform, env, macManagerName });
}

/**
 * Resolve a charter/flag `model` spec into a concrete `--model` value, or
 * null when no --model flag should be emitted (empty spec — CLI default).
 *
 * @param {string} modelSpec - '' (no flag), a tier keyword, or an explicit id.
 * @param {string} cliName - the charter's cli ('claude' | 'codex' | 'gemini').
 * @returns {{ resolved: string, tier: string|null }|null}
 */
export function resolveModel(modelSpec, cliName) {
  if (!modelSpec) return null;
  const tier = modelSpec.toLowerCase();
  if (!TIERS.includes(tier)) {
    // Not a tier keyword — an explicit model id. Verbatim, but never unchecked: this value
    // is about to be interpolated into a shell command string by buildCommand(). A charter
    // validated by validateCompleteCharter() has already passed this, so the re-check only
    // fires for a --model flag or a hand-edited charter that bypassed the write path.
    assertModelId(modelSpec, (message) => {
      throw new SidekicksError(`agent start: ${message}`, EXIT_VALIDATION);
    });
    return { resolved: modelSpec, tier: null };
  }
  const resolved = TIER_MODELS[cliName] && TIER_MODELS[cliName][tier];
  if (!resolved) {
    throw new SidekicksError(
      `agent start: tier '${tier}' has no model mapping for cli '${cliName}' — set an explicit model id with --model <id> or on the charter`,
      EXIT_VALIDATION
    );
  }
  return { resolved, tier };
}

/**
 * Build the launch command shown to the user / fed to a spawned terminal.
 * Prompt AND resolved model are quoted per-platform so the underlying shell
 * sees the right argv split. The model used to be interpolated raw on the
 * assumption that it "is a simple identifier so it needs no escaping" — the
 * assumption held for every real model id and for nothing else, so a charter
 * value like `safe; echo INJECTED` became a second command at launch. It is
 * now quoted like any other untrusted token; assertModelId() (_shared.mjs)
 * independently refuses metacharacters upstream.
 *
 * promptMode controls how the CLI receives the prompt:
 *   'positional' → `<bin> [--model M] '<prompt>'` (claude/codex/gemini)
 *   'flag-i'     → `<bin> [--model M] -i '<prompt>'` (antigravity's agy —
 *                   no bare positional prompt; -i = --prompt-interactive)
 */
export function buildCommand(repoRoot, bin, prompt, resolvedModel, promptMode, platform) {
  const quote = platform === 'win32' ? windowsDoubleQuote : posixSingleQuote;
  const modelPart = resolvedModel ? `--model ${quote(resolvedModel)} ` : '';
  const promptFlagPart = promptMode === 'flag-i' ? '-i ' : '';
  const cdPart = platform === 'win32' ? `cd /d ${windowsDoubleQuote(repoRoot)}` : `cd ${posixSingleQuote(repoRoot)}`;
  return `${cdPart} && ${bin} ${modelPart}${promptFlagPart}${quote(prompt)}`;
}

/**
 * Pure launch-mode decision — no I/O, fully unit-testable.
 *
 * Precedence: printFlag > (explicit --spawn with no GUI session → 'blocked')
 * > spawnFlag > auto (vscode / no launcher / no GUI → print, else spawn).
 *
 * 'blocked' exists so an explicit --spawn that CANNOT work is a hard, loud
 * refusal instead of a window-that-never-opened reported as success — the
 * INC-20260726-01 failure. Auto mode (no flags) still degrades quietly to
 * print: nothing was promised, so nothing is broken.
 *
 * `hasGui` defaults to true so older callers/tests that omit it keep the
 * previous decision table exactly.
 *
 * @param {{ platform: string, termProgram: string|undefined, spawnFlag: boolean, printFlag: boolean, hasLauncher: boolean, hasGui?: boolean }} opts
 * @returns {'print'|'spawn'|'blocked'}
 */
export function decideLaunchMode({ platform, termProgram, spawnFlag, printFlag, hasLauncher, hasGui = true }) {
  if (printFlag) return 'print';
  if (spawnFlag) return hasGui ? 'spawn' : 'blocked';
  if (termProgram === 'vscode') return 'print';
  if (!hasLauncher) return 'print';
  if (!hasGui) return 'print';
  return 'spawn';
}

/**
 * Whether SOME terminal-launching mechanism is available on this platform —
 * feeds decideLaunchMode's auto-mode fallback. macOS ships osascript and
 * Windows ships cmd.exe's `start`, so both are always considered available;
 * Linux has no guaranteed emulator, so it is probed via commandExists.
 */
function detectHasLauncher(platform) {
  if (platform === 'darwin' || platform === 'win32') return true;
  return ['x-terminal-emulator', 'gnome-terminal', 'konsole'].some(commandExists);
}

// Every spawn* helper returns the SAME shape so run() can report honestly:
//   { terminal, ok, verified, error }
//     terminal - human name of the launcher, or null when none was available
//     ok       - the launch was issued without a known failure
//     verified - the launcher's own exit status was observed (macOS: osascript;
//                elsewhere the child outlives us, so the result is unverifiable)
//     error    - the launcher's failure text when ok === false

/**
 * Open a new macOS terminal window running `command`.
 *
 * osascript is run SYNCHRONOUSLY (not detached-and-forget): `do script` /
 * `create window` return as soon as the window exists, so its exit status is a
 * real verdict on whether a window opened. This is what turns the previously
 * silent failures — no window server (headless delegate/ssh/launchd), TCC
 * Apple-events permission denied, Terminal.app scripting disabled — into a
 * reported error instead of a false "window was opened".
 *
 * When `noExec` is set, resolves the terminal name WITHOUT running osascript
 * (dry-run — SIDEKICKS_AGENT_START_NO_EXEC).
 */
function spawnMac(command, noExec) {
  const iTerm = process.env.TERM_PROGRAM === 'iTerm.app';
  const terminal = iTerm ? 'iTerm' : 'Terminal.app';
  if (noExec) return { terminal, ok: true, verified: false, error: null };
  const script = iTerm
    ? `tell application "iTerm"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow
    write text "${appleScriptEscape(command)}"
  end tell
end tell`
    : `tell application "Terminal"
  activate
  do script "${appleScriptEscape(command)}"
end tell`;
  let r;
  try {
    // 30s covers a cold Terminal.app/iTerm launch; a hung osascript is itself
    // a failure to report, never a hang inside `agent start`.
    r = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 30_000 });
  } catch (err) {
    return { terminal, ok: false, verified: true, error: err.message };
  }
  if (r.error) {
    return { terminal, ok: false, verified: true, error: r.error.message };
  }
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().split('\n')[0] || `osascript exited ${r.status}`;
    return { terminal, ok: false, verified: true, error: detail };
  }
  return { terminal, ok: true, verified: true, error: null };
}

/**
 * Open a new Windows terminal window running `command`.
 *
 * The launcher child keeps running for the window's lifetime, so it is spawned
 * detached and the outcome is NOT verifiable here (verified: false) — the
 * report says so rather than asserting a window exists.
 */
function spawnWindows(command, noExec, cwd = undefined) {
  // `command` already carries its data caret-escaped for cmd (buildCommand → cmdEscapeArg), so it
  // must reach cmd EXACTLY as built. Node's default Windows quoting would re-wrap it and escape the
  // quotes a second time with backslashes, which cmd does not unescape — the argument would arrive
  // mangled, and the caret escaping that makes it safe would be pointless. windowsVerbatimArguments
  // turns that re-quoting off and joins the argv with single spaces, which is the shape cmd's own
  // `/s /k <rest of line>` rule expects.
  //
  // `/d` also matters: without it cmd runs the AutoRun commands from
  // HKCU\Software\Microsoft\Command Processor, i.e. registry-controlled code, before ours.
  const verbatim = { windowsVerbatimArguments: true, ...(cwd ? { cwd } : {}) };

  // Prefer Windows Terminal (wt.exe) when it resolves; fall back to `start`.
  if (commandExists('wt.exe') || commandExists('wt')) {
    if (!noExec) spawnDetached('wt.exe', ['cmd', '/d', '/s', '/k', command], verbatim);
    return { terminal: 'Windows Terminal', ok: true, verified: false, error: null };
  }
  if (!noExec) {
    // Empty-string title arg avoids `start` swallowing a quoted `command` as its title.
    spawnDetached('cmd.exe', ['/d', '/s', '/c', 'start', '""', 'cmd', '/d', '/s', '/k', command], verbatim);
  }
  return { terminal: 'Command Prompt', ok: true, verified: false, error: null };
}

/**
 * Try a sequence of Linux terminal emulators. Like Windows, the emulator child
 * outlives this process, so the launch is issued detached and reported as
 * unverified; `terminal: null` when no emulator is on PATH at all.
 */
function spawnLinux(command, noExec) {
  const candidates = [
    ['x-terminal-emulator', ['-e', 'sh', '-c', command]],
    ['gnome-terminal', ['--', 'sh', '-c', command]],
    ['konsole', ['-e', 'sh', '-c', command]],
  ];
  for (const [bin, spawnArgs] of candidates) {
    if (!commandExists(bin)) continue;
    if (!noExec) spawnDetached(bin, spawnArgs);
    return { terminal: bin, ok: true, verified: false, error: null };
  }
  return { terminal: null, ok: false, verified: true, error: 'no terminal emulator found on PATH' };
}

// ---------------------------------------------------------------------------
// --wait-online — close the loop on a launch by polling REAL presence
// ---------------------------------------------------------------------------

export const WAIT_ONLINE_DEFAULT_SECONDS = 90;

/**
 * Parse the `--wait-online[=SECONDS]` flag value.
 * Bare flag ('') → the default window; a positive integer → that many seconds.
 * @returns {number|null} seconds to wait, or null when the flag is absent.
 */
export function parseWaitOnline(raw) {
  if (raw == null || raw === false) return null;
  if (raw === true || String(raw).trim() === '') return WAIT_ONLINE_DEFAULT_SECONDS;
  const secs = Number(String(raw).trim());
  if (!Number.isFinite(secs) || !Number.isInteger(secs) || secs <= 0) {
    throw new SidekicksError(
      `agent start: invalid --wait-online '${raw}' — a positive whole number of seconds (default ${WAIT_ONLINE_DEFAULT_SECONDS})`,
      EXIT_VALIDATION
    );
  }
  return secs;
}

/**
 * Poll the agent's presence until it is 'fresh' or the window elapses.
 * A launched session heartbeats within its first standby/delegate tick, so a
 * fresh presence is the ONLY trustworthy proof that the agent came online.
 *
 * Exported for tests — the polling + verdict wording is the load-bearing part
 * of the fix and must be assertable without launching a real session.
 *
 * @returns {Promise<{ online: boolean, waitedMs: number, state: string }>}
 */
export async function waitForPresence(repoRoot, name, seconds, sleep = defaultSleep) {
  const deadline = Date.now() + seconds * 1000;
  let state = presenceState(readPresence(repoRoot, name));
  const startedAt = Date.now();
  while (state !== 'fresh' && Date.now() < deadline) {
    await sleep(2000);
    state = presenceState(readPresence(repoRoot, name));
  }
  return { online: state === 'fresh', waitedMs: Date.now() - startedAt, state };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `agent start`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = validateAgentName(args.name);
  const flags = parseMemoryFlags(ctx.argv, ['print', 'spawn', 'headless', 'force']);
  // --wait-online is deliberately NOT in the boolean list: bare `--wait-online`
  // parses to '' (the default window) and `--wait-online=120` to '120'.
  const waitSeconds = parseWaitOnline(flags['wait-online']);

  // Keep full charter validation, except defer cli to resolveCharterCli below
  // so hand-edited values retain this command's contextual diagnostic.
  const charter = requireCharter(repoRoot, name, { deferCliValidation: true });
  if (charter.status === 'retired') {
    throw new SidekicksError(
      `agent start: agent '${name}' is retired — retired agents do not come online`,
      EXIT_VALIDATION
    );
  }

  // Starting an agent supersedes an earlier 'agent stop': clear a leftover
  // stop gate or the launched session (delegate loop / `agent wait`) shuts
  // down on its first control check. A 'pause' gate is left alone — a paused
  // agent may come online and idle.
  if (readControlStage(repoRoot, name) === 'stop') {
    writeControlStage(repoRoot, name, 'running');
  }

  let role = flags.role ? String(flags.role) : (charter.role || 'worker');
  if (flags.role && !ROLES.includes(String(flags.role))) {
    throw new SidekicksError(
      `agent start: invalid --role '${flags.role}' — one of: ${ROLES.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  if (!ROLES.includes(role)) role = 'worker'; // tolerate a stray charter.role value

  // A --cli flag on `start` overrides the charter's cli for THIS launch only
  // — it never mutates the charter (e.g. a one-off `agent start molly --cli
  // antigravity` without changing molly's default claude charter).
  let cliName;
  if (flags.cli) {
    cliName = String(flags.cli);
    if (!AGENT_CLIS.includes(cliName)) {
      throw new SidekicksError(
        `agent start: invalid --cli '${cliName}' — one of: ${AGENT_CLIS.join(', ')}`,
        EXIT_VALIDATION
      );
    }
  } else {
    // A charter is hand-edited, so its `cli:` is validated here rather than
    // trusted — an invalid value used to surface as a confusing tier error.
    cliName = resolveCharterCli(charter, name, 'agent start');
  }
  // Every reachable name is now in AGENT_CLIS, so the row always exists; the
  // fallback stays as a belt-and-braces guard rather than a silent wrong mode.
  const launch = CLI_LAUNCH[cliName] || { bin: cliName, promptMode: 'positional' };
  const bin = launch.bin;
  // Reconcile is a startup gate: an interactive launch must not become a way
  // around the journal authority that direct delegates enforce.
  const { bindDeclaration } = await import('./daemon.mjs');
  let binding;
  try {
    // --print is a preview: it must still fail closed on a broken declaration,
    // but it may never open or bind a journal mission as a side effect.
    binding = await bindDeclaration(repoRoot, name, {
      deferCliValidation: Boolean(flags.cli),
      dryRun: Boolean(flags.print),
    });
  } catch (err) {
    throw new SidekicksError(
      `agent start: primary declaration readiness failed: ${err.message}. Correct with 'node bin/sidekicks agent daemon reconcile ${name}'`,
      EXIT_VALIDATION
    );
  }
  const skillContext = privateSkillContext(repoRoot, charter, charter.categories?.join(' ') || '');
  const prompt = `${bootstrapPrompt(name, role)}\n\n${composePrimaryPrompt(charter, binding, skillContext)}`;

  // A --model flag on `start` overrides the charter's model.
  const modelSpec = (flags.model != null ? String(flags.model) : (charter.model || '')).trim();
  const modelInfo = resolveModel(modelSpec, cliName);

  // ── --headless: launch the DELEGATE runner instead of a terminal window ──
  // The delegate (lib/agent-lifecycle/delegate.mjs) is a detached Node loop
  // that watches the agent's inbox and wakes a non-interactive agent-CLI
  // session to drain it — no terminal, no window. Spawned with the same
  // detach + log idiom as the comms daemons.
  if (flags.headless) {
    // Lazy import — delegate.mjs imports resolveModel from this module, so a
    // static import here would be a cycle.
    const { HEADLESS_CLIS } = await import('./delegate.mjs');
    if (!HEADLESS_CLIS.includes(cliName)) {
      throw new SidekicksError(
        `agent start: --headless supports cli ${HEADLESS_CLIS.join(', ')} only — '${cliName}' has no headless adapter yet`,
        EXIT_VALIDATION
      );
    }
    // Standing policy (mirrors the delegate's own gate, so the refusal lands
    // HERE at launch instead of in a detached child's log): one delegate —
    // the user-facing orchestrator only; specialists are session subagents
    // or brought online on demand (`--spawn`). --force overrides.
    if (role !== 'orchestrator' && !flags.force) {
      throw new SidekicksError(
        `agent start: '${name}' is a worker charter — the standing policy is one delegate for the user-facing orchestrator only; reach specialists as the orchestrator's session subagents or bring them online on demand ('sidekicks agent start ${name} --spawn', which needs a GUI session to host the window). From a headless session (delegate wake, ssh, launchd) --spawn cannot work at all: use '--headless --force' here, or hand the task to a session subagent.`,
        EXIT_VALIDATION
      );
    }
    const daemonName = `delegate-${name}`;
    if (isDaemonRunning(repoRoot, daemonName)) {
      const rec = readJsonFile(pidFilePath(repoRoot, daemonName));
      throw new SidekicksError(
        `agent start: a delegate for '${name}' is already running (pid ${rec.pid}) — stop it with 'sidekicks agent stop ${name}'`,
        EXIT_VALIDATION
      );
    }
    const noExec = Boolean(process.env.SIDEKICKS_AGENT_START_NO_EXEC);
    const delegateArgs = ['agent', 'delegate', name];
    if (flags.model != null) delegateArgs.push('--model', String(flags.model));
    if (flags['permission-mode']) delegateArgs.push('--permission-mode', String(flags['permission-mode']));
    if (flags.force) delegateArgs.push('--force'); // forwarded so the child's own gate agrees
    const pid = spawnDaemon(repoRoot, delegateArgs, `delegate-${name}.log`, noExec);
    if (pid) writePidFile(repoRoot, daemonName, pid); // provisional; the delegate re-stamps its own pid
    const headlessLines = [
      `agent:  ${name}`,
      `cli:    ${cliName}${flags.cli ? ' (override)' : ''}`,
      `mode:   headless (delegate runner)`,
      modelInfo
        ? `model:  ${modelInfo.resolved}${modelInfo.tier ? ` (from tier '${modelInfo.tier}')` : ''}`
        : 'model:  (cli default)',
      '',
      noExec
        ? '[SIDEKICKS_AGENT_START_NO_EXEC] would start the headless delegate runner (no process spawned).'
        : `Headless delegate runner started (pid ${pid}, log .sidekicks/agents/.bridge/runtime/logs/delegate-${name}.log).`,
      `Status: sidekicks agent delegate ${name} --status`,
      `Stop:   sidekicks agent stop ${name}`,
    ];
    for (const note of ensureCommsProcesses(repoRoot)) headlessLines.push(note);
    // --wait-online works for the delegate too: the loop owns presence while
    // idle, so a fresh heartbeat proves the runner really came up (a delegate
    // that dies on its first tick leaves a pid file behind but no presence).
    if (waitSeconds != null && !noExec) {
      const verdict = await waitForPresence(repoRoot, name, waitSeconds);
      headlessLines.push('');
      headlessLines.push(...onlineVerdictLines(
        name,
        verdict,
        waitSeconds,
        `read why it died — tail -f .sidekicks/agents/.bridge/runtime/logs/delegate-${name}.log (usual causes: the agent CLI binary missing from the daemon PATH, or a non-bypass permission mode stalling headless), then hand the work to a session subagent meanwhile.`
      ));
      headlessLines.push('');
      return { stdout: headlessLines.join('\n'), exitCode: verdict.online ? EXIT_OK : EXIT_VALIDATION };
    }
    headlessLines.push('');
    return { stdout: headlessLines.join('\n'), exitCode: EXIT_OK };
  }

  const command = buildCommand(repoRoot, bin, prompt, modelInfo ? modelInfo.resolved : null, launch.promptMode, process.platform);

  const lines = [
    `agent:  ${name}`,
    `cli:    ${cliName}${flags.cli ? ' (override)' : ''}`,
    `role:   ${role}`,
    modelInfo
      ? `model:  ${modelInfo.resolved}${modelInfo.tier ? ` (from tier '${modelInfo.tier}')` : ''}`
      : 'model:  (cli default)',
    '',
    'Run this in a fresh terminal session:',
    '',
    `  ${command}`,
    '',
  ];

  const printFlag = Boolean(flags.print);
  const spawnFlag = Boolean(flags.spawn);
  const platform = process.platform;
  const termProgram = process.env.TERM_PROGRAM;
  const noExec = Boolean(process.env.SIDEKICKS_AGENT_START_NO_EXEC);
  // An explicit ASSUME_GUI override always wins. Otherwise a dry run must be
  // able to exercise the spawn branch on any host (including CI with no
  // display), so the probe is skipped under NO_EXEC — nothing is launched.
  const guiOverride = envGuiOverride(process.env);
  const gui = printFlag
    ? { hasGui: true, reason: 'not probed (--print)' }
    : guiOverride != null
      ? { hasGui: guiOverride, reason: `SIDEKICKS_AGENT_START_ASSUME_GUI=${guiOverride ? '1' : '0'} (override)` }
      : noExec
        ? { hasGui: true, reason: 'not probed (dry run)' }
        : detectGuiSession(platform);
  const mode = decideLaunchMode({
    platform,
    termProgram,
    spawnFlag,
    printFlag,
    hasLauncher: detectHasLauncher(platform),
    hasGui: gui.hasGui,
  });

  // ── Explicit --spawn in a session with no GUI: refuse, don't pretend ──
  // This is the INC-20260726-01 guard. A headless caller (delegate wake, ssh,
  // launchd) gets a non-zero exit and the lanes that actually work, instead of
  // a "window was opened" line and an agent that never comes online.
  if (mode === 'blocked') {
    const headlessLane = role === 'orchestrator'
      ? `sidekicks agent start ${name} --headless`
      : `sidekicks agent start ${name} --headless --force`;
    throw new SidekicksError(
      `agent start: --spawn cannot open a terminal window here — ${gui.reason}. `
      + `Nothing was launched (refusing rather than reporting a window that would never appear). `
      + `Bring '${name}' online without a GUI: '${headlessLane}'`
      + `${role === 'orchestrator' ? '' : " (worker charters need --force — the standing one-delegate policy)"}; `
      + `or run it in a real terminal: 'sidekicks agent start ${name} --print' and paste the command there. `
      + `If this host DOES have a usable GUI session, re-run with SIDEKICKS_AGENT_START_ASSUME_GUI=1.`,
      EXIT_VALIDATION
    );
  }

  if (printFlag && spawnFlag) {
    lines.push('note: --print takes precedence over --spawn — printing only, no window opened.');
  }

  // { terminal, ok, verified, error } from the platform launcher, or null when
  // no spawn was attempted at all.
  let spawned = null;

  if (mode === 'spawn') {
    // Escape hatch for tests/dry-runs: resolve + report the launch fully,
    // but never actually exec a child process.
    try {
      if (platform === 'darwin') {
        spawned = spawnMac(command, noExec);
      } else if (platform === 'win32') {
        // repoRoot is passed as the child's cwd as well as appearing in the `cd /d` the printed
        // command shows: the launched window then lands in the right place even if the cd is ever
        // altered, and the path stops being the only thing standing between a directory name and
        // the shell parser.
        spawned = spawnWindows(command, noExec, repoRoot);
      } else {
        spawned = spawnLinux(command, noExec);
      }
    } catch (err) {
      spawned = { terminal: null, ok: false, verified: true, error: err.message };
    }
  }

  // Comms auto-start hook: an agent coming online should find the messaging
  // daemons (telegram relay / LAN bridge) running when the env/config
  // auto-restart switches say so. Best-effort — never blocks the launch.
  for (const note of ensureCommsProcesses(repoRoot)) lines.push(note);

  const launchIssued = Boolean(spawned && spawned.ok);
  let launchFailed = false;

  if (spawned && spawned.ok && noExec) {
    lines.push(`[SIDEKICKS_AGENT_START_NO_EXEC] would open a new ${spawned.terminal} window running the command above (no process spawned).`);
  } else if (spawned && spawned.ok && spawned.verified) {
    lines.push(`A new ${spawned.terminal} window was opened running the command above.`);
    lines.push(`Opening a window is NOT proof the agent came online — the session still has to reach its standby loop.`);
    lines.push(`Verify: sidekicks agent show ${name} --json  (presence must read 'fresh'), or re-run with --wait-online.`);
  } else if (spawned && spawned.ok) {
    // Launcher outlives us (Windows/Linux) — issued, but unverifiable here.
    lines.push(`Launch handed to ${spawned.terminal} — this platform cannot confirm the window opened.`);
    lines.push(`Verify: sidekicks agent show ${name} --json  (presence must read 'fresh'), or re-run with --wait-online.`);
  } else if (spawned) {
    // A REAL launcher failure — reported, never swallowed.
    launchFailed = true;
    lines.push(`Failed to open ${spawned.terminal || 'a terminal window'}: ${spawned.error}`);
    lines.push(`'${name}' did NOT come online. Open a fresh terminal tab and paste the command above,`);
    lines.push(`or bring it online without a GUI: sidekicks agent start ${name} --headless${role === 'orchestrator' ? '' : ' --force'}`);
  } else if (!printFlag && !gui.hasGui) {
    // Auto mode in a headless session: degrade to print, but say WHY, so the
    // caller does not read silence as "a window is coming". Checked BEFORE the
    // vscode note — a delegate inherits TERM_PROGRAM=vscode from the editor
    // that started it, and "no GUI at all" is the load-bearing fact there.
    lines.push(`No GUI session to host a terminal window (${gui.reason}) — printing only.`);
    lines.push(`Open a fresh terminal tab and paste the command above, or use --headless${role === 'orchestrator' ? '' : ' --force'}.`);
  } else if (termProgram === 'vscode' && !printFlag) {
    lines.push('Running inside the VS Code integrated terminal — not opening an external window.');
    lines.push('Open a fresh terminal tab and paste the command above.');
  } else {
    lines.push('Open a fresh terminal tab and paste the command above.');
  }

  // --wait-online: poll real presence so the caller learns within `waitSeconds`
  // whether the agent is actually reachable, instead of discovering an
  // unclaimed task minutes later.
  if (waitSeconds != null && launchIssued && !noExec) {
    const verdict = await waitForPresence(repoRoot, name, waitSeconds);
    lines.push('');
    lines.push(...onlineVerdictLines(
      name,
      verdict,
      waitSeconds,
      `bring it up another way ('sidekicks agent start ${name} --headless${role === 'orchestrator' ? '' : ' --force'}'), or hand the task to a session subagent instead.`
    ));
    lines.push('');
    return { stdout: lines.join('\n'), exitCode: verdict.online ? EXIT_OK : EXIT_VALIDATION };
  }
  if (waitSeconds != null && !launchIssued && !noExec) {
    lines.push('');
    lines.push('--wait-online: nothing was launched from here, so there is nothing to wait for.');
  }
  lines.push('');

  // A launcher that demonstrably failed is a failed launch — exit non-zero so
  // a scripted/agent caller branches instead of assuming success.
  return { stdout: lines.join('\n'), exitCode: launchFailed ? EXIT_VALIDATION : EXIT_OK };
}

/**
 * Report lines for a --wait-online verdict (shared by the window and headless
 * launch paths). Online → one confirmation line; not online → the observed
 * presence state plus the fallback lane, because a caller that waited and got
 * nothing needs a next move, not a retry. Exported for tests.
 */
export function onlineVerdictLines(name, verdict, waitSeconds, nextLine) {
  const secs = Math.round(verdict.waitedMs / 1000);
  if (verdict.online) {
    return [`--wait-online: '${name}' is ONLINE (presence fresh after ${secs}s).`];
  }
  return [
    `--wait-online: '${name}' did NOT come online within ${waitSeconds}s (presence: ${verdict.state}).`,
    `The launch did not produce a live session — do NOT wait on work routed to '${name}'.`,
    `Next: ${nextLine}`,
  ];
}
