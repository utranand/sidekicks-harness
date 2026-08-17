// lib/agent-lifecycle/stop.mjs
// `sidekicks agent stop <name>|--all [--stage stop|pause|resume]` — write the
// control gate from ANY session. The standby loop reads control.json on every
// wait tick, so a stop lands within one interval; a graceful close, no signal
// delivery needed. `pause` idles the loop without assigning; `resume` sets the
// stage back to running. Pending messages in inbox/new are NOT touched — they
// persist for the next session.
//
// `--all` writes the same gate to EVERY non-retired agent in one call (a
// fleet-wide stop / pause / resume). Retired agents are skipped — they do not
// come online, so there is no loop to gate.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  parseMemoryFlags,
  validateAgentName,
  requireCharter,
  ensureRuntimeTree,
  writeControlStage,
  listAgentNames,
  readCharter,
} from './_shared.mjs';

// The verb speaks user language (resume); the file stores loop language (running).
const STAGE_BY_FLAG = { stop: 'stop', pause: 'pause', resume: 'running' };

/**
 * Run `agent stop`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['all']);

  const flag = flags.stage ? String(flags.stage) : 'stop';
  const stage = STAGE_BY_FLAG[flag];
  if (!stage) {
    throw new SidekicksError(
      `agent stop: invalid --stage '${flag}' — one of: ${Object.keys(STAGE_BY_FLAG).join(', ')}`,
      EXIT_VALIDATION
    );
  }

  // Fleet-wide: gate every non-retired agent in one call.
  if (flags.all) {
    const acted = [];
    const skipped = [];
    for (const n of listAgentNames(repoRoot)) {
      const charter = readCharter(repoRoot, n);
      if (charter && charter.status === 'retired') {
        skipped.push(n);
        continue;
      }
      ensureRuntimeTree(repoRoot, n);
      writeControlStage(repoRoot, n, stage);
      acted.push(n);
    }
    const lines = [
      `control ${stage} → ${acted.length} agent(s)${acted.length ? `: ${acted.join(', ')}` : ''}`,
    ];
    if (skipped.length) lines.push(`skipped (retired): ${skipped.join(', ')}`);
    lines.push('the standby loops pick this up within one wait tick');
    return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
  }

  // Single agent.
  const name = validateAgentName(args.name);
  requireCharter(repoRoot, name);
  ensureRuntimeTree(repoRoot, name);
  writeControlStage(repoRoot, name, stage);
  return { stdout: `control ${name} → ${stage} (the standby loop picks this up within one wait tick)\n`, exitCode: EXIT_OK };
}
