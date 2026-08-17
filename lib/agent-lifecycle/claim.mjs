// lib/agent-lifecycle/claim.mjs
// `sidekicks agent claim <name> [<id>] --session <sid>` — atomically claim one
// message: renameSync new/<id>.json → claimed/<id>.json (unique ids mean the
// target never pre-exists — Windows-safe). Without an <id>, claims the OLDEST
// message; the loser of a claim race gets ENOENT and simply tries the next.
// On success the claimed file is stamped with {session_id, claimed_at} and
// the message JSON is printed for the claiming session to execute — pruned
// of null/empty fields (token-lean; the on-disk file keeps the full schema).
//
// Exit codes: 0 = claimed; 2 = nothing claimable (empty inbox or lost every race).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import {
  parseMemoryFlags,
  bangkokTimestamp,
  validateAgentName,
  requireCharter,
  ensureRuntimeTree,
  listMessageIds,
  readMessage,
  writeMessage,
  claimRename,
} from './_shared.mjs';

/**
 * Token-lean print view: recursively drop null / '' values and empty arrays
 * or objects from a COPY of the message. The claiming session reads this
 * output as its brief, so every field it does not need (result: null,
 * chain: [], body_file: null, …) is pure token cost in the agent's context.
 * The on-disk claimed file keeps the full schema — only stdout is pruned.
 */
function pruneForPrint(value) {
  if (Array.isArray(value)) {
    const arr = value.map(pruneForPrint).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const p = pruneForPrint(v);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (value === null || value === '') return undefined;
  return value;
}

/**
 * Run `agent claim`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string, rest?: string[] }} args - rest[0] = optional message id.
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = validateAgentName(args.name);
  const flags = parseMemoryFlags(ctx.argv, []);
  requireCharter(repoRoot, name);

  const session = flags.session ? String(flags.session) : '';
  if (!session) {
    throw new SidekicksError('agent claim: --session <sid> is required (claims record their owner)', EXIT_VALIDATION);
  }

  ensureRuntimeTree(repoRoot, name);

  // Explicit id detection is prefix-gated: the dispatcher's parseArgs leaks
  // space-form flag VALUES (`--session std-1`) into positionals, so only a
  // token shaped like a message id (msg-...) counts as one.
  const explicitId = args.rest && args.rest.find((t) => typeof t === 'string' && t.startsWith('msg-'));
  const candidates = explicitId ? [explicitId] : listMessageIds(repoRoot, name, 'new');

  for (const id of candidates) {
    if (!claimRename(repoRoot, name, id)) continue; // race loser → next
    const msg = readMessage(repoRoot, name, 'claimed', id) || { id };
    const claimed = { ...msg, claim: { session_id: session, claimed_at: bangkokTimestamp() } };
    writeMessage(repoRoot, name, 'claimed', claimed);
    return { stdout: JSON.stringify(pruneForPrint(claimed) ?? { id }, null, 2) + '\n', exitCode: EXIT_OK };
  }

  return {
    stdout: explicitId
      ? `agent claim: message '${explicitId}' is not claimable (already claimed, done, or unknown)\n`
      : `agent claim: no claimable message in ${name}/inbox/new\n`,
    exitCode: EXIT_NOT_FOUND,
  };
}
