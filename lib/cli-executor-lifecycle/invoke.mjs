// lib/cli-executor-lifecycle/invoke.mjs
// `sidekicks cli-executor invoke` — run ONE agent-CLI session in a named role, and the reusable API
// the goal engine dispatches through.
//
// ASYNCHRONOUS, ALWAYS. Every long-running agent call uses `spawn`, never `spawnSync`: the parent
// has to persist the child's pid and native session id BEFORE it blocks, or a crash mid-attempt
// leaves a run that cannot tell "this child is still alive" from "this child never started" — and
// the wrong answer there means a duplicate dispatch. `spawnSync` survives in exactly one place: the
// sub-millisecond `where`/`which` probe that resolves the binary.
//
// WINDOWS IS NOT A FOOTNOTE. Agent CLIs install as `.cmd` shims, and since the CVE-2024-24576
// hardening Node REFUSES to spawn a batch shim with `shell: false` — it is a hard EINVAL, so a
// naive port does not degrade, it never launches. The fix is a `cmd.exe` layer built from an audited
// encoder, and this module IMPORTS that encoder (lib/agent-lifecycle/_win-argv.mjs) rather than
// carrying a second copy: model- and user-derived text reaches this argv verbatim, so one reviewed
// escaping implementation is worth more than a tidier dependency graph. `shell: true` is never the
// answer — it would hand the same text to a shell one layer further out.
//
// THE PARENT IS THE ONLY WRITER. This function writes nothing under the run folder. It captures,
// parses and RETURNS; the caller persists. That is what makes a parallel fan-out (the plan contest)
// safe without a second lock.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { read as readSettings } from '../settings-store/settings.mjs';
import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { cmdShimSpawn, isCmdShim } from '../agent-lifecycle/_win-argv.mjs';
import { parseFlags, readEffectiveRegistry, effectiveExecutors } from './_shared.mjs';
import {
  ROLES,
  WINDOWS_COMMAND_LIMIT,
  buildInvocation,
  containmentNote,
} from './profiles.mjs';

/** Keep only enough stdout in memory to parse a result; the transcript is the caller's business. */
const STDOUT_CAP = 4 * 1024 * 1024;
/** Enough stderr to classify a failure (a quota wall vs a crash) without unbounded growth. */
const STDERR_CAP = 64 * 1024;
/** Default per-attempt ceiling. Long, because a real implementation turn is slow; still bounded. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Grace between SIGTERM and SIGKILL on a timeout. */
const KILL_GRACE_MS = 10_000;

/**
 * Resolve the spawnable binary for a CLI name.
 *
 * On Windows the `.cmd` form is probed FIRST, because that is what an npm install actually puts on
 * PATH; resolving the bare name there yields something `spawn` cannot execute.
 *
 * @param {string} bin
 * @returns {{bin: string, resolved: string|null, shim: boolean}}
 */
export function resolveExecutorBinary(bin) {
  // An absolute path is already the answer. `which`/`where` on an absolute path is inconsistent
  // across platforms and shells, and a registry entry is allowed to name a binary outside PATH.
  if (isAbsolute(bin) && existsSync(bin)) {
    return { bin, resolved: bin, shim: isCmdShim(bin) };
  }
  if (process.platform === 'win32') {
    for (const candidate of [`${bin}.cmd`, `${bin}.bat`, bin]) {
      const probe = spawnSync('where', [candidate], { encoding: 'utf8', windowsHide: true });
      if (!probe.error && probe.status === 0) {
        const first = String(probe.stdout || '').split(/\r?\n/).find((l) => l.trim() !== '');
        const resolved = first ? first.trim() : candidate;
        return { bin: resolved, resolved, shim: isCmdShim(resolved) };
      }
    }
    return { bin, resolved: null, shim: false };
  }
  const probe = spawnSync('which', [bin], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) {
    const resolved = String(probe.stdout || '').trim();
    return { bin: resolved || bin, resolved: resolved || bin, shim: false };
  }
  return { bin, resolved: null, shim: false };
}

/**
 * Parse a CLI's stdout into the structured result, session id and usage figures it exposes.
 *
 * Deliberately tolerant about SHAPE and strict about SOURCE: only documented terminal output is
 * read, and anything not found comes back null so the caller's own validator fails closed rather
 * than this function inventing a plausible value.
 *
 * @param {string} parser - one of profiles.mjs OUTPUT_PARSERS
 * @param {string} stdout
 * @returns {{result: unknown, text: string|null, sessionId: string|null,
 *            usage: {tokens: number|null, usd: number|null}, parseError: string|null}}
 */
export function parseExecutorOutput(parser, stdout) {
  const empty = { result: null, text: null, sessionId: null, usage: { tokens: null, usd: null }, parseError: null };
  const raw = String(stdout ?? '');
  if (raw.trim() === '') return { ...empty, parseError: 'the CLI produced no stdout' };

  /** Try to read a JSON document out of possibly-noisy stdout. */
  const asObject = () => {
    try {
      return JSON.parse(raw);
    } catch { /* fall through to a bounded recovery */ }
    // Some CLIs prepend a banner line. Recover the outermost object, and nothing cleverer.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  };

  /** A payload that may be a JSON string OR an object already. */
  const unwrap = (value) => {
    if (value === null || value === undefined) return { result: null, text: null };
    if (typeof value === 'object') return { result: value, text: null };
    const text = String(value);
    try {
      return { result: JSON.parse(text), text };
    } catch {
      return { result: null, text };
    }
  };

  if (parser === 'codex-jsonl') {
    let sessionId = null;
    let tokens = null;
    let usd = null;
    let last = null;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || !trimmed.startsWith('{')) continue;
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      // Session/thread identity, in each spelling the installed CLI has used.
      for (const key of ['session_id', 'thread_id', 'conversation_id']) {
        if (typeof rec[key] === 'string') sessionId = rec[key];
        if (rec.msg && typeof rec.msg[key] === 'string') sessionId = rec.msg[key];
        if (rec.item && typeof rec.item[key] === 'string') sessionId = rec.item[key];
      }
      const usage = rec.usage || rec.msg?.usage || rec.item?.usage || rec.info?.total_token_usage;
      if (usage && typeof usage === 'object') {
        const total = Number(
          usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
        );
        if (Number.isFinite(total) && total > 0) tokens = total;
      }
      // The final assistant payload, in each documented spelling.
      const candidate = rec.msg?.message ?? rec.item?.text ?? rec.item?.message ?? rec.message ?? null;
      if (typeof candidate === 'string' && candidate.trim() !== '') last = candidate;
      if (typeof rec.msg?.last_agent_message === 'string') last = rec.msg.last_agent_message;
    }
    const { result, text } = unwrap(last);
    return {
      result,
      text,
      sessionId,
      usage: { tokens, usd },
      parseError: last === null ? 'no agent message found in the JSONL event stream' : null,
    };
  }

  const doc = asObject();
  if (doc === null) {
    return { ...empty, text: raw.slice(0, STDERR_CAP), parseError: 'stdout is not JSON' };
  }

  if (parser === 'claude-json') {
    const { result, text } = unwrap(doc.result ?? doc.response ?? null);
    const usageObj = doc.usage || {};
    const tokens = Number(
      usageObj.total_tokens
      ?? ((usageObj.input_tokens ?? 0) + (usageObj.output_tokens ?? 0)),
    );
    return {
      result,
      text,
      sessionId: typeof doc.session_id === 'string' ? doc.session_id : null,
      usage: {
        tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : null,
        usd: Number.isFinite(Number(doc.total_cost_usd)) ? Number(doc.total_cost_usd) : null,
      },
      parseError: doc.is_error === true ? String(doc.result ?? 'the CLI reported is_error') : null,
    };
  }

  if (parser === 'gemini-json' || parser === 'agy-json') {
    const { result, text } = unwrap(doc.response ?? doc.result ?? doc.output ?? null);
    const stats = doc.stats || doc.usage || {};
    const tokens = Number(stats.total_tokens ?? stats.totalTokens ?? NaN);
    return {
      result,
      text,
      sessionId: typeof doc.session_id === 'string' ? doc.session_id : null,
      usage: { tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : null, usd: null },
      parseError: result === null && text === null ? 'no response field in the JSON output' : null,
    };
  }

  // 'text' — the whole stdout is the payload.
  const { result, text } = unwrap(raw);
  return { result, text, sessionId: null, usage: { tokens: null, usd: null }, parseError: null };
}

/**
 * The spawn triple for a resolved binary — the ONE place the Windows shim decision is made.
 *
 * Exported and platform-explicit so the argv boundary is testable on either OS: the failure mode
 * being guarded (a metacharacter in model- or user-derived text escaping the quoted region and
 * appending commands to the launch line) is not reproducible only on the machine that has the shim.
 *
 * @param {string} bin - the RESOLVED executable path
 * @param {string[]} args
 * @returns {{command: string, args: string[], options: object, shim: boolean}}
 */
export function buildLaunch(bin, args) {
  if (isCmdShim(bin)) {
    const shim = cmdShimSpawn([bin, ...args]);
    return { ...shim, shim: true };
  }
  return { command: bin, args: args.slice(), options: {}, shim: false };
}

/**
 * A floor on the command-line length the OS will see, in characters.
 *
 * A floor rather than an exact figure: on Windows the caret escaping in `cmdCommandLine` expands
 * metacharacters, so the real line is at least this long and usually longer. Comparing a floor
 * against the ceiling is the safe direction — it can refuse a command that would just have fitted,
 * never accept one that would have been truncated.
 *
 * @param {string} bin
 * @param {string[]} args
 * @returns {number}
 */
export function commandLineFloor(bin, args) {
  return [bin, ...args].reduce((n, a) => n + String(a).length + 3, 0);
}

/**
 * Refuse an over-length command line before dispatch.
 *
 * Truncation is not a degraded mode: a schema cut in half is a DIFFERENT schema, and a prompt cut in
 * half is a different instruction. Both would run, and both would look like a model failure.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{platform?: string, role?: string, limit?: number}} [opts]
 * @throws {SidekicksError} EXIT_VALIDATION
 */
export function assertCommandLength(bin, args, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return;
  const limit = opts.limit ?? WINDOWS_COMMAND_LIMIT;
  const floor = commandLineFloor(bin, args);
  if (floor <= limit) return;
  throw new SidekicksError(
    `cli-executor invoke: the ${opts.role || 'agent'} command line is at least ${floor} characters, past `
    + `the Windows ${limit} ceiling. Shrink the inline schema or move the prompt to a file — it is `
    + 'never truncated silently, because a schema cut in half is a different schema.',
    EXIT_VALIDATION,
  );
}

/**
 * Merge caller environment over the parent's, case-insensitively for PATH.
 *
 * WINDOWS SPELLS IT `Path`. A plain `{...process.env, ...extra}` with `extra.PATH` set leaves BOTH keys
 * in the object there, and which one the child sees is not something to rely on — a caller that
 * prepends a directory to PATH would find its addition silently ignored. Since the whole point of
 * setting PATH here is the goal engine's command guard, "silently ignored" is a boundary that is not
 * there.
 *
 * @param {Record<string, string|undefined>} base
 * @param {Record<string, string>|undefined} extra
 * @returns {Record<string, string|undefined>}
 */
export function mergeEnv(base, extra) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (key.toLowerCase() === 'path') {
      for (const existing of Object.keys(merged)) {
        if (existing.toLowerCase() === 'path') delete merged[existing];
      }
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * Signal a child AND everything it spawned.
 *
 * An agent CLI shells out constantly, and `child.kill()` reaches only the CLI itself — its
 * grandchildren reparent to pid 1 and keep burning CPU. POSIX gets the process group (the child is
 * spawned `detached`, so it leads one); Windows has neither groups nor real signals, so `taskkill
 * /T /F` is the equivalent tree walk.
 *
 * @param {import('node:child_process').ChildProcess|null} child
 * @param {'SIGTERM'|'SIGKILL'} signal
 */
export function signalTree(child, signal) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/**
 * Run one agent-CLI session to completion.
 *
 * @param {{name: string, spec: object, role: string, tier: string, prompt: string, cwd: string,
 *          schemaPath?: string|null, schemaJson?: string|null, resumeSession?: string|null,
 *          timeoutMs?: number, env?: Record<string, string>,
 *          onSpawn?: (info: {pid: number|null, bin: string, args: string[]}) => void,
 *          spawnImpl?: Function, now?: () => number}} input
 * @returns {Promise<object>}
 */
export async function invokeExecutor(input) {
  const invocation = buildInvocation({
    name: input.name,
    spec: input.spec,
    role: input.role,
    tier: input.tier,
    prompt: input.prompt,
    schemaPath: input.schemaPath ?? null,
    schemaJson: input.schemaJson ?? null,
    resumeSession: input.resumeSession ?? null,
  });

  const resolved = resolveExecutorBinary(invocation.bin);
  if (resolved.resolved === null) {
    throw new SidekicksError(
      `cli-executor invoke: '${invocation.bin}' is not on PATH — install the CLI or register a `
      + 'different executor. A missing binary fails closed rather than falling back to another CLI.',
      EXIT_VALIDATION,
    );
  }

  // The ceiling is checked with the RESOLVED binary in hand, because the shim path is part of what
  // has to fit.
  assertCommandLength(resolved.bin, invocation.args, { role: input.role });

  const launch = buildLaunch(resolved.bin, invocation.args);

  const timeoutMs = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const spawnFn = input.spawnImpl || spawn;
  const now = input.now || Date.now;
  const startedAt = now();

  return new Promise((settle) => {
    const child = spawnFn(launch.command, launch.args, {
      ...launch.options,
      cwd: input.cwd,
      env: mergeEnv(process.env, input.env),
      // stdin is `pipe` ONLY when there is something to write. An OPEN, empty stdin makes
      // `codex exec` wait for EOF forever; 'ignore' is EOF immediately.
      stdio: [invocation.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    // The pid is handed back BEFORE any await, so the caller can persist it and a crash here leaves
    // a recoverable record rather than an invisible child.
    if (input.onSpawn) {
      try {
        input.onSpawn({ pid: child.pid ?? null, bin: launch.command, args: launch.args });
      } catch { /* a caller's bookkeeping failure must not kill the session */ }
    }

    let out = '';
    let err = '';
    let killed = false;
    let timedOut = false;
    let settled = false;

    if (invocation.stdin !== null && child.stdin) {
      child.stdin.on('error', () => { /* the CLI closed stdin early; the prompt is already flushed */ });
      child.stdin.end(invocation.stdin);
    }

    child.stdout.on('data', (chunk) => {
      if (out.length < STDOUT_CAP) out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      err = (err + chunk.toString()).slice(-STDERR_CAP);
    });

    const killTimer = setTimeout(() => {
      killed = true;
      timedOut = true;
      signalTree(child, 'SIGTERM');
      const hard = setTimeout(() => signalTree(child, 'SIGKILL'), KILL_GRACE_MS);
      if (hard.unref) hard.unref();
    }, timeoutMs);
    if (killTimer.unref) killTimer.unref();

    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const parsed = parseExecutorOutput(invocation.parser, out);
      settle({
        ok: code === 0 && !timedOut && !spawnError && parsed.parseError === null,
        executor: input.name,
        role: input.role,
        tier: input.tier,
        model: invocation.model,
        effort: invocation.effort,
        family: invocation.family,
        containment: invocation.containment,
        containment_note: containmentNote(input.name, input.spec, input.role),
        schema_transport: invocation.schema,
        resumed: invocation.resumed,
        bin: launch.command,
        args: launch.args,
        pid: child.pid ?? null,
        exit_code: code,
        killed,
        timed_out: timedOut,
        duration_ms: Math.max(0, now() - startedAt),
        stdout: out,
        stderr: err,
        result: parsed.result,
        result_text: parsed.text,
        session_id: parsed.sessionId,
        usage: parsed.usage,
        parse_error: parsed.parseError,
        error: spawnError ? String(spawnError.message || spawnError) : null,
      });
    };

    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code, null));
  });
}

// ---------------------------------------------------------------------------
// The CLI verb
// ---------------------------------------------------------------------------

/**
 * `sidekicks cli-executor invoke --executor <n> --tier <t> --role <r> [--work-dir <p>]
 *  --prompt-file <p> [--output-schema <p>] [--timeout <ms>] [--dry-run] [--json]`
 *
 * Every valued flag is read by re-parsing `ctx.argv`: the dispatcher's own `parseArgs` is
 * booleans-only with `strict: false`, so `--role plan` would otherwise arrive as `{role: true}` plus
 * a stray positional `plan` — silently working in the `--role=plan` spelling and silently breaking
 * in the other.
 *
 * @param {{repoRoot: string, argv: string[], flags: object, log: Function}} ctx
 * @param {object} _args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, _args) {
  const flags = parseFlags(ctx.argv, ['json', 'dry-run', 'root']);

  const executor = str(flags.executor);
  const role = str(flags.role);
  const tier = str(flags.tier);
  const promptFile = str(flags['prompt-file']);
  const schemaFile = str(flags['output-schema']);
  const workDir = str(flags['work-dir']) || ctx.repoRoot;

  if (!executor || !role || !tier || !promptFile) {
    throw new SidekicksError(
      'cli-executor invoke: usage: cli-executor invoke --executor <name> --tier <top|high|mid|low> '
      + '--role <plan|implement|review|final-verify> --prompt-file <path> [--work-dir <path>] '
      + '[--output-schema <path>] [--timeout <ms>] [--dry-run] [--json]',
      EXIT_USAGE,
    );
  }
  if (!ROLES.includes(role)) {
    throw new SidekicksError(
      `cli-executor invoke: --role must be one of ${ROLES.join(', ')} (got '${role}')`,
      EXIT_VALIDATION,
    );
  }

  const settings = readSettings(ctx.repoRoot);
  const registry = readEffectiveRegistry(ctx.repoRoot, settings);
  const executors = effectiveExecutors(registry);
  const spec = executors[executor];
  if (!spec) {
    throw new SidekicksError(
      `cli-executor invoke: unknown executor '${executor}' — 'cli-executor list' shows the effective `
      + 'set. An unknown executor fails closed; nothing is substituted for it.',
      EXIT_VALIDATION,
    );
  }
  if (spec.enabled === false) {
    throw new SidekicksError(`cli-executor invoke: executor '${executor}' is disabled in this scope`, EXIT_VALIDATION);
  }

  const promptPath = isAbsolute(promptFile) ? promptFile : resolvePath(ctx.repoRoot, promptFile);
  if (!existsSync(promptPath)) {
    throw new SidekicksError(`cli-executor invoke: --prompt-file not found: ${promptFile}`, EXIT_VALIDATION);
  }
  const prompt = readFileSync(promptPath, 'utf8');

  let schemaPath = null;
  let schemaJson = null;
  if (schemaFile) {
    const abs = isAbsolute(schemaFile) ? schemaFile : resolvePath(ctx.repoRoot, schemaFile);
    if (!existsSync(abs)) {
      throw new SidekicksError(`cli-executor invoke: --output-schema not found: ${schemaFile}`, EXIT_VALIDATION);
    }
    schemaPath = abs;
    // An inline-schema CLI needs the compact JSON text, not the path. Reading it here means the
    // caller passes ONE flag regardless of which transport the CLI uses.
    schemaJson = JSON.stringify(JSON.parse(readFileSync(abs, 'utf8')));
  }

  if (flags['dry-run']) {
    const invocation = buildInvocation({
      name: executor, spec, role, tier, prompt, schemaPath, schemaJson,
    });
    const resolved = resolveExecutorBinary(invocation.bin);
    const payload = {
      executor,
      role,
      tier,
      model: invocation.model,
      effort: invocation.effort,
      family: invocation.family,
      containment: invocation.containment,
      containment_note: containmentNote(executor, spec, role),
      schema_transport: invocation.schema,
      binary: resolved.resolved,
      cmd_shim: resolved.shim,
      argv: invocation.args,
      prompt_on_stdin: invocation.stdin !== null,
      command_length: invocation.commandLength,
    };
    return { stdout: `${JSON.stringify(payload, null, 2)}\n`, exitCode: EXIT_OK };
  }

  const result = await invokeExecutor({
    name: executor,
    spec,
    role,
    tier,
    prompt,
    cwd: workDir,
    schemaPath,
    schemaJson,
    timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
  });

  if (flags.json) {
    // stdout/stderr are deliberately NOT in the JSON payload: a transcript belongs in a file, not in
    // a machine-readable summary a caller may log wholesale.
    const { stdout, stderr, ...summary } = result;
    return { stdout: `${JSON.stringify(summary, null, 2)}\n`, exitCode: result.ok ? EXIT_OK : EXIT_VALIDATION };
  }

  const lines = [
    `${executor} ${role} [${result.containment}] model=${result.model}`
    + `${result.effort ? ` effort=${result.effort}` : ''} exit=${result.exit_code}`
    + `${result.timed_out ? ' TIMED OUT' : ''} ${result.duration_ms}ms`,
    result.parse_error ? `parse: ${result.parse_error}` : null,
    result.error ? `error: ${result.error}` : null,
    result.result_text ? result.result_text : (result.result ? JSON.stringify(result.result, null, 2) : null),
  ].filter(Boolean);

  return { stdout: `${lines.join('\n')}\n`, exitCode: result.ok ? EXIT_OK : EXIT_VALIDATION };
}

/**
 * A flag value as a non-empty string, or ''. `parseFlags` yields `''` for a valued flag given with
 * no value and `true` for a boolean, so both collapse to "not supplied".
 *
 * @param {unknown} value
 * @returns {string}
 */
function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}
