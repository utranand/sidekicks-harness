// lib/check-lifecycle/runner.mjs
// The scheduler: run one profile's gates, respecting dependencies and a job bound, and return the
// versioned result document.
//
// EVERYTHING NON-DETERMINISTIC IS INJECTED — the process spawner, the clock, the job count, the
// signal registration, and the internal handler table. That is not a testing nicety: the only way to
// assert "a failed prerequisite blocks its dependents" or "SIGINT marks the running gate failed and
// the rest blocked" is to control when each gate finishes, and the only way to compare a whole result
// document byte-for-byte is to control the clock. Production simply passes the real implementations.
//
// THE SPAWN CONTRACT (one function, so a fake is a few lines):
//   spawn({ argv, cwd, timeoutMs, signal, env }) ->
//     Promise<{ exitCode: number|null, signal: string|null, stdout: string, stderr: string,
//               timedOut?: boolean }>
// `argv` is always an ARRAY and is never handed to a shell. `argv[0] === 'node'` means "the
// interpreter running this process", resolved at spawn time so a Windows `.exe` and a version-managed
// binary both work.
//
// Zero npm dependencies — node:* only; macOS + Windows.

import { spawn as spawnChild } from 'node:child_process';
import {
  GATES, PROFILES, PROFILE_TIMEOUT_MS, SCHEMA_VERSION,
  profileGates, validateRegistry, normalizeJobs, defaultJobCount,
} from './registry.mjs';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { tail, bangkokTimestamp } from './_shared.mjs';

/** Gate outcome vocabulary. Nothing outside this set ever reaches a result row. */
export const GATE_STATUS = Object.freeze(['passed', 'failed', 'blocked', 'skipped']);

/**
 * Spawn one argv array and capture bounded output. The default `spawn` dependency.
 *
 * @param {{argv: readonly string[], cwd: string, timeoutMs?: number, signal?: AbortSignal, env?: object}} opts
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function spawnArgv({ argv, cwd, timeoutMs, signal, env }) {
  return new Promise((resolve) => {
    const list = [...argv];
    const bin = list[0] === 'node' ? process.execPath : list[0];
    /** @type {Buffer[]} */ const out = [];
    /** @type {Buffer[]} */ const err = [];
    let settled = false;
    let timedOut = false;

    const child = spawnChild(bin, list.slice(1), {
      cwd,
      shell: false, // never a shell: a repo path with a space must not be re-split by anyone
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (exitCode, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener?.('abort', onAbort);
      resolve({
        exitCode,
        signal: sig ?? null,
        stdout: tail(Buffer.concat(out)),
        stderr: tail(Buffer.concat(err)),
        timedOut,
      });
    };

    child.stdout?.on('data', (d) => out.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
    child.stderr?.on('data', (d) => err.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));

    const kill = () => {
      // SIGTERM first, SIGKILL as the backstop. On Windows both map to a terminate; the escalation
      // costs nothing there and is what stops a wedged POSIX child from outliving the run.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2_000).unref?.();
    };

    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => { timedOut = true; kill(); }, timeoutMs)
      : null;
    timer?.unref?.();

    const onAbort = signal ? () => kill() : null;
    if (signal && onAbort) {
      if (signal.aborted) kill();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (e) => {
      err.push(Buffer.from(`spawn failed: ${e.message}\n`, 'utf8'));
      finish(null, null);
    });
    child.on('close', (code, sig) => finish(code, sig));
  });
}

/** The real internal-handler table, lazily imported so `quick` never loads the release machinery. */
async function defaultHandlers() {
  const [pkg, core, golden] = await Promise.all([
    import('./gates/package-clean.mjs'),
    import('./gates/core-mounted.mjs'),
    import('./gates/golden-replay.mjs'),
  ]);
  return {
    'package.clean': pkg.packageClean,
    'core.mounted': core.coreMounted,
    'golden.replay': golden.goldenReplay,
  };
}

/** The default clock: real epoch milliseconds. */
export const realClock = Object.freeze({ now: () => Date.now() });

/**
 * The default signal registration. Returns an unregister function.
 *
 * @param {(name: string) => void} onSignal
 * @returns {() => void}
 */
export function processSignals(onSignal) {
  const int = () => onSignal('SIGINT');
  const term = () => onSignal('SIGTERM');
  process.on('SIGINT', int);
  process.on('SIGTERM', term);
  return () => {
    process.off('SIGINT', int);
    process.off('SIGTERM', term);
  };
}

/** The exit code a signal name maps to (128 + signal number, as a shell would report it). */
export const SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

/**
 * Run one profile.
 *
 * @param {object} options
 * @param {string} options.repoRoot                    - the cwd every gate command runs in
 * @param {string} options.profile                     - quick | full | release
 * @param {number|string|null} [options.jobs]           - concurrency; bounded and validated here
 * @param {object} [options.deps]                      - injected dependencies (see file header)
 * @param {Function} [options.deps.spawn]
 * @param {{now: () => number}} [options.deps.clock]
 * @param {Record<string, Function>} [options.deps.handlers]
 * @param {(cb: (name: string) => void) => (() => void)} [options.deps.onSignal]
 * @param {number} [options.deps.timeoutMs]            - overrides the profile's per-gate ceiling
 * @param {ReadonlyArray<object>} [options.deps.gates] - overrides the static registry (tests only)
 * @param {Record<string, readonly string[]>} [options.deps.profiles]
 * @returns {Promise<{result: object, exitCode: number}>}
 */
export async function runProfile({ repoRoot, profile, jobs = null, deps = {} } = {}) {
  const gatesAll = deps.gates || GATES;
  const profiles = deps.profiles || PROFILES;

  const registryProblems = validateRegistry(gatesAll);
  if (registryProblems.length > 0) {
    throw new SidekicksError(
      `check run: the gate registry is invalid — ${registryProblems.join('; ')}`,
      EXIT_VALIDATION,
    );
  }

  // profileGates() validates the profile name against the STATIC table; a test-injected profile map
  // is resolved here against the same shape so an unknown name fails identically either way.
  const selected = deps.profiles
    ? resolveInjectedProfile(profile, profiles, gatesAll)
    : profileGates(profile, gatesAll);

  const jobCount = normalizeJobs(jobs, defaultJobCount());
  const clock = deps.clock || realClock;
  const spawn = deps.spawn || spawnArgv;
  const timeoutMs = deps.timeoutMs ?? PROFILE_TIMEOUT_MS[profile] ?? PROFILE_TIMEOUT_MS.full;
  const handlers = deps.handlers || (selected.some((g) => g.handler) ? await defaultHandlers() : {});

  /** @type {Map<string, {gate: object, status: string, startedMs: number|null, endedMs: number|null, exitCode: number|null, signal: string|null, stdout: string, stderr: string, reason: string|null}>} */
  const rows = new Map();
  for (const gate of selected) {
    rows.set(gate.id, {
      gate,
      status: 'pending',
      startedMs: null,
      endedMs: null,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      reason: null,
    });
  }

  /** @type {Map<string, Promise<void>>} */ const inFlight = new Map();
  /** Ids currently executing. Kept SEPARATELY from `inFlight`, and populated BEFORE the gate starts:
   *  a gate's first spawn happens synchronously inside its own promise body, so a signal raised by
   *  that spawn would arrive before the promise could be recorded anywhere. */
  /** @type {Set<string>} */ const running = new Set();
  const abort = new AbortController();
  /** @type {string|null} */ let signalled = null;
  /** Gates that were RUNNING when the signal arrived — recorded at signal time rather than inferred
   *  later, because their spawn promise settles with whatever the kill produced (`SIGTERM` from the
   *  child, or nothing at all), and the signal that belongs on the row is the RUN's signal. */
  /** @type {Set<string>} */ const interrupted = new Set();
  const unregister = (deps.onSignal || processSignals)((name) => {
    if (signalled) return;
    signalled = name === 'SIGTERM' ? 'SIGTERM' : 'SIGINT';
    for (const id of running) interrupted.add(id);
    abort.abort();
  });

  const startedMs = clock.now();

  try {
    for (;;) {
      // 0. A signal ends the scheduling loop here, BEFORE dependency propagation, so an unstarted
      //    gate is reported as "not started — run interrupted" rather than as blocked by the gate the
      //    signal happened to kill. A gate already blocked by a real failure keeps that reason.
      if (signalled) break;

      // 1. Propagate failure downwards before choosing anything to run: a gate whose dependency did
      //    not pass is BLOCKED, and its own dependents block on the next pass.
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows.values()) {
          if (row.status !== 'pending') continue;
          const bad = row.gate.dependencies.find((d) => {
            const dep = rows.get(d);
            return dep && dep.status !== 'pending' && dep.status !== 'running' && dep.status !== 'passed';
          });
          if (bad) {
            row.status = 'blocked';
            row.reason = `dependency '${bad}' did not pass`;
            changed = true;
          }
        }
      }

      // 2. Start ready gates, most expensive first, up to the job bound. Ties break on registry
      //    order, so a fixture run schedules identically every time.
      const ready = selected
        .map((g) => rows.get(g.id))
        .filter((row) => row.status === 'pending'
          && row.gate.dependencies.every((d) => rows.get(d)?.status === 'passed'))
        .sort((a, b) => (b.gate.cost_ms || 0) - (a.gate.cost_ms || 0));

      while (inFlight.size < jobCount && ready.length > 0) {
        const row = ready.shift();
        row.status = 'running';
        row.startedMs = clock.now();
        const id = row.gate.id;
        running.add(id);
        inFlight.set(id, executeGate({
          row, repoRoot, spawn, handlers, timeoutMs, clock, signal: abort.signal,
        }).finally(() => { inFlight.delete(id); running.delete(id); }));
      }

      if (inFlight.size === 0) break; // nothing running and nothing startable: the run is done
      await Promise.race([...inFlight.values()]);
    }

    // A signal aborts the children; wait for them so nothing outlives the run, then rewrite their
    // rows: a gate that was running when the signal arrived FAILED with the signal recorded, and
    // everything not started is blocked by it.
    if (signalled) {
      await Promise.allSettled([...inFlight.values()]);
      for (const row of rows.values()) {
        if (row.status === 'running' || interrupted.has(row.gate.id)) {
          row.status = 'failed';
          row.signal = signalled;
          row.endedMs = row.endedMs ?? clock.now();
          row.reason = `interrupted by ${signalled}`;
        } else if (row.status === 'pending') {
          row.status = 'blocked';
          row.reason = `not started — run interrupted by ${signalled}`;
        }
      }
    }
  } finally {
    unregister?.();
  }

  const endedMs = clock.now();
  const gateRows = selected.map((g) => renderRow(rows.get(g.id)));

  // A BLOCKING gate that is anything other than `passed` fails the profile — including `skipped`.
  // A skip is not a pass and can never be reported as one; the initial registry has only blocking
  // gates, so today every non-pass fails.
  const failed = gateRows.some((r) => r.blocking && r.status !== 'passed');
  const anyNotPassed = gateRows.some((r) => r.status !== 'passed');

  const result = {
    schema_version: SCHEMA_VERSION,
    profile,
    started_at: bangkokTimestamp(startedMs),
    ended_at: bangkokTimestamp(endedMs),
    duration_ms: Math.max(0, endedMs - startedMs),
    status: failed ? 'failed' : 'passed',
    gates: gateRows,
  };

  const exitCode = signalled
    ? (SIGNAL_EXIT[signalled] ?? 1)
    : (failed || anyNotPassed ? 1 : 0);

  return { result, exitCode };
}

/** Resolve a test-injected profile map, with the same unknown-name error the static path gives. */
function resolveInjectedProfile(profile, profiles, gates) {
  if (typeof profile !== 'string' || !Object.hasOwn(profiles, profile)) {
    throw new SidekicksError(
      `check run: unknown profile '${profile ?? ''}' — expected one of ${Object.keys(profiles).join(', ')}`,
      EXIT_VALIDATION,
    );
  }
  const byId = new Map(gates.map((g) => [g.id, g]));
  const want = new Set();
  const add = (id) => {
    if (want.has(id)) return;
    const gate = byId.get(id);
    if (!gate) {
      throw new SidekicksError(
        `check run: profile '${profile}' names gate '${id}', which the registry does not define`,
        EXIT_VALIDATION,
      );
    }
    want.add(id);
    for (const dep of gate.dependencies) add(dep);
  };
  for (const id of profiles[profile]) add(id);
  return gates.filter((g) => want.has(g.id));
}

/** Run one gate to completion and write its outcome onto the row. Never throws. */
async function executeGate({ row, repoRoot, spawn, handlers, timeoutMs, clock, signal }) {
  const gate = row.gate;
  try {
    let out;
    if (Array.isArray(gate.command) && gate.command.length > 0) {
      out = await spawn({ argv: gate.command, cwd: repoRoot, timeoutMs, signal });
    } else {
      const handler = handlers[gate.handler];
      if (typeof handler !== 'function') {
        out = {
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          reason: `no handler registered for '${gate.handler}'`,
          status: 'failed',
        };
      } else {
        out = await handler({ repoRoot, spawn, timeoutMs, signal, gate });
      }
    }
    row.endedMs = clock.now();
    row.exitCode = out.exitCode ?? null;
    row.signal = out.signal ?? null;
    row.stdout = tail(out.stdout);
    row.stderr = tail(out.stderr);
    if (out.status && out.status !== 'passed' && out.status !== 'failed') {
      // A handler may report `skipped` — golden.replay does, when there are no fixtures to replay.
      row.status = out.status;
    } else {
      row.status = out.exitCode === 0 && !out.signal ? 'passed' : 'failed';
    }
    row.reason = out.reason
      ?? (row.status === 'passed'
        ? null
        : out.timedOut
          ? `timed out after ${timeoutMs} ms`
          : out.signal
            ? `terminated by ${out.signal}`
            : `exit ${out.exitCode ?? 'unknown'}`);
  } catch (err) {
    row.endedMs = clock.now();
    row.status = 'failed';
    row.exitCode = null;
    row.reason = `gate threw: ${err && err.message ? err.message : String(err)}`;
    row.stderr = tail(row.stderr + (err && err.stack ? `${err.stack}\n` : ''));
  }
}

/** One gate's public row, in the schema's field order. */
function renderRow(row) {
  const started = row.startedMs;
  const ended = row.endedMs;
  return {
    id: row.gate.id,
    status: row.status === 'pending' || row.status === 'running' ? 'blocked' : row.status,
    dependencies: [...row.gate.dependencies],
    blocking: Boolean(row.gate.blocking),
    started_at: started === null ? null : bangkokTimestamp(started),
    ended_at: ended === null ? null : bangkokTimestamp(ended),
    duration_ms: started === null || ended === null ? null : Math.max(0, ended - started),
    exit_code: row.exitCode,
    signal: row.signal,
    stdout_tail: row.stdout,
    stderr_tail: row.stderr,
    reason: row.reason,
  };
}
