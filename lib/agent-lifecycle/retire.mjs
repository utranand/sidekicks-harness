// lib/agent-lifecycle/retire.mjs
// `sidekicks agent retire <name> [--force]` — mark an agent retired.
//
// Retiring is a charter status flip, not a deletion — memory and history stay.
// Refuses while the agent looks alive (fresh presence) or still has unclaimed
// work (inbox/new non-empty) unless --force, so work is never silently orphaned.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  parseMemoryFlags,
  validateAgentName,
  requireCharter,
  writeCharter,
  readPresence,
  presenceState,
  listMessageIds,
} from './_shared.mjs';

/**
 * Run `agent retire`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = validateAgentName(args.name);
  const flags = parseMemoryFlags(ctx.argv, ['force']);

  const charter = requireCharter(repoRoot, name);

  if (!flags.force) {
    const alive = presenceState(readPresence(repoRoot, name)) === 'fresh';
    if (alive) {
      throw new SidekicksError(
        `agent retire: '${name}' has a fresh presence (a session looks live) — stop it first ('sidekicks agent stop ${name}') or pass --force`,
        EXIT_VALIDATION
      );
    }
    const pending = listMessageIds(repoRoot, name, 'new').length;
    if (pending > 0) {
      throw new SidekicksError(
        `agent retire: '${name}' still has ${pending} unclaimed message(s) in inbox/new — reassign or drain them, or pass --force`,
        EXIT_VALIDATION
      );
    }
  }

  if (charter.status === 'retired') {
    return { stdout: `agent '${name}' is already retired\n`, exitCode: EXIT_OK };
  }

  writeCharter(repoRoot, name, { ...charter, status: 'retired' }, 'agent retire');
  return { stdout: `retired agent '${name}' (charter status flipped; memory and history kept)\n`, exitCode: EXIT_OK };
}
