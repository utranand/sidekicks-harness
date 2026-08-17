// lib/agent-lifecycle/_comms.mjs
// Comms auto-start hook — NOT a dispatchable verb.
//
// Fired whenever an agent comes online (`agent start`, and the standby loop's
// `agent wait`): checks whether the communication daemons are running (pidfile
// + live-pid probe) and, when the matching auto-restart switch is on, spawns
// the missing daemon detached so agents and the user stay reachable without a
// manual `serve` in a separate terminal.
//
// Switches (env wins over the root config.yaml block; .env file < process env):
//   TELEGRAM_AUTO_RESTART=true   | telegram:  auto_restart: true  → telegram relay
//   BRIDGE_AUTO_RESTART=true     | bridge:    auto_restart: true  → LAN bridge listener
//   SCHEDULER_AUTO_RESTART=true  | scheduler: auto_restart: true  → routine scheduler
//
// The telegram relay is only auto-started when a bot token is actually
// configured — an auto-restart switch without credentials is reported, not an
// error. Everything here is best-effort: a failure to auto-start NEVER breaks
// the verb that triggered the hook.
//
// Daemon stdout/err goes to .sidekicks/agents/.bridge/runtime/logs/<name>.log
// (git-ignored). SIDEKICKS_COMMS_NO_EXEC=1 dry-runs the spawn (tests).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirp } from '../fs-safety/fsx.mjs';
import {
  readEnvFile,
  readRootMessagingConfig,
  bridgeRuntimeDir,
  isDaemonRunning,
  writePidFile,
} from './_bridge.mjs';
import { effectiveTelegramConfig } from './telegram.mjs';
import { readControlStage } from './_shared.mjs';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function truthy(v) {
  return v === true || TRUTHY.has(String(v ?? '').toLowerCase());
}

/**
 * Spawn `sidekicks <args>` detached, logging to the comms log dir. Returns pid.
 * Exported for reuse by start.mjs's --headless branch (the delegate runner is
 * launched with the exact same detach + log idiom as the comms daemons).
 */
export function spawnDaemon(repoRoot, args, logName, noExec) {
  if (noExec) return 0; // dry-run — resolved and reported, nothing spawned
  const logDir = join(bridgeRuntimeDir(repoRoot), 'logs');
  mkdirp(logDir);
  const out = openSync(join(logDir, logName), 'a');
  const child = spawn(process.execPath, [join(repoRoot, 'bin', 'sidekicks'), ...args], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.on('error', () => {}); // best-effort — never crash the calling verb
  child.unref();
  return child.pid;
}

/**
 * Ensure the configured comms daemons are running. Returns human-readable
 * notes for anything it DID or could not do ([] when all quiet — the common
 * case). Never throws.
 *
 * @param {string} repoRoot
 * @param {{ env?: object }} [opts] - env injectable for tests.
 * @returns {string[]}
 */
export function ensureCommsProcesses(repoRoot, opts = {}) {
  const notes = [];
  try {
    const env = { ...readEnvFile(repoRoot), ...(opts.env || process.env) };
    const cfg = readRootMessagingConfig(repoRoot);
    const noExec = truthy(env.SIDEKICKS_COMMS_NO_EXEC);

    const tgAuto = env.TELEGRAM_AUTO_RESTART != null && env.TELEGRAM_AUTO_RESTART !== ''
      ? truthy(env.TELEGRAM_AUTO_RESTART)
      : truthy(cfg.telegram.auto_restart);
    if (tgAuto && !isDaemonRunning(repoRoot, 'telegram')) {
      const tg = effectiveTelegramConfig(repoRoot, env);
      // INTERLOCK: same reasoning as the scheduler arm below. This hook fires
      // from every delegate idle tick and standby wait, and delegate.mjs runs it
      // BEFORE reading its own control gate — so without honouring the relay's
      // gate here, a deliberate `agent stop telegram` (or the tray's Stop) was
      // undone within one tick and the relay could not be turned off at all.
      // Cleared by an explicit `telegram serve` or `agent stop --stage resume telegram`.
      if (readControlStage(repoRoot, 'telegram') === 'stop') {
        notes.push('comms: telegram relay is stopped by its control gate — not auto-restarted (resume: sidekicks agent stop --stage resume telegram)');
      } else if (!tg.bot_token) {
        notes.push('comms: TELEGRAM_AUTO_RESTART is on but no bot token is configured — relay not started');
      } else {
        const pid = spawnDaemon(repoRoot, ['agent', 'telegram', 'serve'], 'telegram.log', noExec);
        if (pid) writePidFile(repoRoot, 'telegram', pid); // provisional; daemon re-stamps
        notes.push(noExec
          ? 'comms: [dry-run] would auto-start the telegram relay'
          : `comms: telegram relay auto-started (pid ${pid}, log .sidekicks/agents/.bridge/runtime/logs/telegram.log)`);
      }
    }

    const brAuto = env.BRIDGE_AUTO_RESTART != null && env.BRIDGE_AUTO_RESTART !== ''
      ? truthy(env.BRIDGE_AUTO_RESTART)
      : truthy(cfg.bridge.auto_restart);
    if (brAuto && !isDaemonRunning(repoRoot, 'bridge')) {
      const pid = spawnDaemon(repoRoot, ['agent', 'serve'], 'bridge.log', noExec);
      if (pid) writePidFile(repoRoot, 'bridge', pid);
      notes.push(noExec
        ? 'comms: [dry-run] would auto-start the LAN bridge'
        : `comms: LAN bridge auto-started (pid ${pid}, log .sidekicks/agents/.bridge/runtime/logs/bridge.log)`);
    }

    const scAuto = env.SCHEDULER_AUTO_RESTART != null && env.SCHEDULER_AUTO_RESTART !== ''
      ? truthy(env.SCHEDULER_AUTO_RESTART)
      : truthy(cfg.scheduler.auto_restart);
    if (scAuto && !isDaemonRunning(repoRoot, 'scheduler')) {
      // INTERLOCK: `agent scheduler stop` writes the scheduler's control gate,
      // and this hook fires from every delegate idle tick and standby wait —
      // without honouring the gate here, a deliberate stop would be undone
      // within seconds and the scheduler could not be turned off at all
      // without editing config. A stop is respected until an explicit
      // `scheduler serve` (or `agent stop --stage resume scheduler`) clears it.
      if (readControlStage(repoRoot, 'scheduler') === 'stop') {
        notes.push('comms: routine scheduler is stopped by its control gate — not auto-restarted');
      } else {
        const pid = spawnDaemon(repoRoot, ['agent', 'scheduler', 'serve'], 'scheduler.log', noExec);
        if (pid) writePidFile(repoRoot, 'scheduler', pid);
        notes.push(noExec
          ? 'comms: [dry-run] would auto-start the routine scheduler'
          : `comms: routine scheduler auto-started (pid ${pid}, log .sidekicks/agents/.bridge/runtime/logs/scheduler.log)`);
      }
    }
  } catch (err) {
    notes.push(`comms: auto-start check failed (${err.message}) — continuing`);
  }
  return notes;
}
