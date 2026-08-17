// lib/agent-lifecycle/inbox.mjs
// `sidekicks agent inbox <name> [--state new|claimed|done] [--json]`
// List one agent's messages in a state (default new), oldest-first.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  parseMemoryFlags,
  validateAgentName,
  requireCharter,
  listMessageIds,
  readMessage,
  INBOX_STATES,
} from './_shared.mjs';

/**
 * Run `agent inbox`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = validateAgentName(args.name);
  const flags = parseMemoryFlags(ctx.argv, ['json']);
  requireCharter(repoRoot, name);

  const state = flags.state ? String(flags.state) : 'new';
  if (!INBOX_STATES.includes(state)) {
    throw new SidekicksError(
      `agent inbox: invalid --state '${state}' — one of: ${INBOX_STATES.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const messages = listMessageIds(repoRoot, name, state)
    .map((id) => readMessage(repoRoot, name, state, id))
    .filter(Boolean);

  if (flags.json) {
    return { stdout: JSON.stringify(messages, null, 2) + '\n', exitCode: EXIT_OK };
  }

  if (messages.length === 0) {
    return { stdout: `inbox ${name}/${state}: empty\n`, exitCode: EXIT_OK };
  }

  const lines = [`inbox ${name}/${state} (${messages.length}, oldest first):`, ''];
  for (const m of messages) {
    const head = `  ${m.id} [${m.kind}] from ${m.from}${m.category ? ` (${m.category})` : ''}`;
    const tail = m.result ? ` → ${m.result.status}` : '';
    lines.push(head + tail);
    if (m.brief?.goal) lines.push(`      ${m.brief.goal}`);
  }
  lines.push('');
  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}
