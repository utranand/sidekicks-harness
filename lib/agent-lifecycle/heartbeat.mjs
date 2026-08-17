// lib/agent-lifecycle/heartbeat.mjs
// `sidekicks agent heartbeat <name> --session <sid> [--state standby|working] [--task <id>]`
//
// Upsert the agent's presence.json. Session ownership is enforced here: if a
// DIFFERENT session holds a FRESH presence (heartbeat within the 900s TTL),
// this session must not take over — exit 4, and the caller (a second standby
// tab on the same agent) stops itself. A stale or absent presence is claimable.
//
// Exit codes: 0 = presence written; 4 = another live session owns this agent.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_AGENT_FOREIGN_SESSION } from '../sk-cli/errors.mjs';
import {
  parseMemoryFlags,
  bangkokTimestamp,
  validateAgentName,
  requireCharter,
  ensureRuntimeTree,
  readPresence,
  writePresence,
  presenceState,
} from './_shared.mjs';

const ACTIVITY_STATES = ['standby', 'working'];

/**
 * Run `agent heartbeat`.
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
    throw new SidekicksError('agent heartbeat: --session <sid> is required', EXIT_VALIDATION);
  }

  const activity = flags.state ? String(flags.state) : 'standby';
  if (!ACTIVITY_STATES.includes(activity)) {
    throw new SidekicksError(
      `agent heartbeat: invalid --state '${activity}' — one of: ${ACTIVITY_STATES.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const existing = readPresence(repoRoot, name);
  if (
    existing
    && existing.session_id
    && existing.session_id !== session
    && presenceState(existing) === 'fresh'
  ) {
    return {
      stdout: `agent heartbeat: '${name}' is owned by live session ${existing.session_id} — this session must stop\n`,
      exitCode: EXIT_AGENT_FOREIGN_SESSION,
    };
  }

  ensureRuntimeTree(repoRoot, name);
  writePresence(repoRoot, name, {
    session_id: session,
    state: activity,
    task: flags.task ? String(flags.task) : null,
    heartbeat_at: bangkokTimestamp(),
  });

  return { stdout: `heartbeat ${name} (${activity}) session ${session}\n`, exitCode: EXIT_OK };
}
