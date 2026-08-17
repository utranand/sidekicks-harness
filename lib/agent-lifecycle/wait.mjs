// lib/agent-lifecycle/wait.mjs
// `sidekicks agent wait <name> --session <sid> [--timeout 540] [--interval 2]`
//
// The standby primitive: BLOCK this process (an async setTimeout poll loop —
// no npm deps, no busy-wait) until one of four outcomes, refreshing the
// presence heartbeat on every tick so a waiting session always looks live.
//
// Exit codes (verb-local semantics — the standby loop branches on these):
//   0  inbox/new has at least one message (and control is not paused)
//   2  timeout elapsed with nothing to do (loop: just wait again)
//   3  control stage is 'stop' (loop: deregister and end the session)
//   4  a DIFFERENT session holds a fresh presence (loop: this tab must stop)
//
// control 'pause' keeps the wait blocking WITHOUT reporting messages — the
// GTD idiom: paused means "don't pick up work", not "shut down".
//
// The Bash tool timeout wrapping this call MUST exceed --timeout (e.g.
// 590000ms > 540s) or the harness kills the wait and the loop misreads it.
//
// All timers resolve before run() returns, so writeThenExit's pending-write
// exit semantics hold (nothing keeps the event loop alive afterwards).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import {
  SidekicksError,
  EXIT_VALIDATION,
  EXIT_AGENT_MESSAGES,
  EXIT_AGENT_TIMEOUT,
  EXIT_AGENT_STOP,
  EXIT_AGENT_FOREIGN_SESSION,
} from '../sk-cli/errors.mjs';
import {
  parseMemoryFlags,
  bangkokTimestamp,
  validateAgentName,
  requireCharter,
  ensureRuntimeTree,
  readPresence,
  writePresence,
  presenceState,
  readControlStage,
  listMessageIds,
} from './_shared.mjs';
import { ensureCommsProcesses } from './_comms.mjs';

const DEFAULT_TIMEOUT_S = 540;
const DEFAULT_INTERVAL_S = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `agent wait`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = validateAgentName(args.name);
  const flags = parseMemoryFlags(ctx.argv, []);
  requireCharter(repoRoot, name);

  const session = flags.session ? String(flags.session) : '';
  if (!session) {
    throw new SidekicksError('agent wait: --session <sid> is required (waits own the presence heartbeat)', EXIT_VALIDATION);
  }

  const timeoutS = flags.timeout != null && flags.timeout !== '' ? Number(flags.timeout) : DEFAULT_TIMEOUT_S;
  const intervalS = flags.interval != null && flags.interval !== '' ? Number(flags.interval) : DEFAULT_INTERVAL_S;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    throw new SidekicksError(`agent wait: invalid --timeout '${flags.timeout}' — seconds > 0`, EXIT_VALIDATION);
  }
  if (!Number.isFinite(intervalS) || intervalS <= 0) {
    throw new SidekicksError(`agent wait: invalid --interval '${flags.interval}' — seconds > 0`, EXIT_VALIDATION);
  }

  ensureRuntimeTree(repoRoot, name);

  // Comms auto-start hook: a standby session coming online (or looping) keeps
  // the messaging daemons alive per the env/config auto-restart switches.
  // Cheap when all quiet (pidfile + signal-0 probe); notes go to stderr so the
  // wait's stdout/exit-code contract stays untouched.
  for (const note of ensureCommsProcesses(repoRoot)) process.stderr.write(note + '\n');

  const deadline = Date.now() + timeoutS * 1000;

  // Poll loop: check first, then sleep — a message already waiting returns
  // immediately, and a stop signal is honored on the very first pass.
  for (;;) {
    // 1. Foreign live session → this tab must stop (one session per agent).
    const presence = readPresence(repoRoot, name);
    if (
      presence
      && presence.session_id
      && presence.session_id !== session
      && presenceState(presence) === 'fresh'
    ) {
      return {
        stdout: `wait: '${name}' is owned by live session ${presence.session_id} — this session must stop\n`,
        exitCode: EXIT_AGENT_FOREIGN_SESSION,
      };
    }

    // 2. Own the presence — every tick refreshes the heartbeat, so a waiting
    //    session never looks dead (900s TTL vs a tick every few seconds).
    writePresence(repoRoot, name, {
      session_id: session,
      state: 'standby',
      task: null,
      heartbeat_at: bangkokTimestamp(),
    });

    // 3. Control gate.
    const stage = readControlStage(repoRoot, name);
    if (stage === 'stop') {
      return { stdout: 'wait: control stop — close the session\n', exitCode: EXIT_AGENT_STOP };
    }

    // 4. Work available (unless paused — paused idles without assigning).
    if (stage !== 'pause') {
      const pending = listMessageIds(repoRoot, name, 'new').length;
      if (pending > 0) {
        return { stdout: `wait: ${pending} message(s) in inbox/new — claim now\n`, exitCode: EXIT_AGENT_MESSAGES };
      }
    }

    // 5. Timeout.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { stdout: 'wait: timeout — nothing to do, wait again\n', exitCode: EXIT_AGENT_TIMEOUT };
    }

    await sleep(Math.min(intervalS * 1000, remaining));
  }
}
