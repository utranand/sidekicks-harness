// lib/agent-lifecycle/complete.mjs
// `sidekicks agent complete <name> <id> --status done|failed [--summary <s>]
//    [--branch <b>] [--deliverable <path>]... [--option <label>]... [--no-reply]`
//
// Stamp the result onto a CLAIMED message, move it claimed/ → done/ (atomic
// rename, unique id), then auto-route a `reply` message into the ORIGINAL
// SENDER's inbox/new/ carrying reply_to + summary + branch + deliverables —
// that reply is how the assigning agent learns the task finished.
// Replies are only auto-sent for kind=task (replying to a reply would ping-pong).
//
// This verb is ALSO where the agent journal's L0 event row is written — see
// lib/journal-lifecycle/. Doing it here rather than in a skill is the whole
// point: the mechanical record of what an agent did must not depend on a model
// remembering to write it.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import {
  parseMemoryFlags,
  bangkokTimestamp,
  validateAgentName,
  requireCharter,
  readCharter,
  ensureRuntimeTree,
  readMessage,
  writeMessage,
  moveToDone,
  newMessageId,
  RESULT_STATUSES,
} from './_shared.mjs';
import { appendEvent } from '../journal-lifecycle/log.mjs';

/**
 * Collect every occurrence of a repeatable `--<flag> <value>` from argv
 * (parseMemoryFlags keeps only the last occurrence, so repeats need a hand-scan).
 */
function collectRepeatable(argv, flag) {
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === flag && list[i + 1] && !list[i + 1].startsWith('--')) {
      out.push(list[i + 1]);
      i++;
    } else if (typeof list[i] === 'string' && list[i].startsWith(flag + '=')) {
      out.push(list[i].slice(flag.length + 1));
    }
  }
  return out.filter(Boolean);
}

/**
 * Auto-route a `reply` message into the original sender's inbox/new carrying
 * reply_to + the result. Shared by `agent complete` and the delegate loop's
 * requeue fail-out (both close a task the same way, so the reply schema is
 * defined exactly once). Only kind=task messages from a still-existing,
 * different sender get a reply — a reply to a reply would ping-pong.
 *
 * @returns {{ replyId: string|null, note: string }} note is display suffix text.
 */
export function autoReplyToSender(repoRoot, name, msg, id, result) {
  if (!(msg.kind === 'task' && msg.from && msg.from !== name)) {
    return { replyId: null, note: '' };
  }
  if (!readCharter(repoRoot, msg.from)) {
    return { replyId: null, note: ` (no reply sent — sender '${msg.from}' no longer exists)` };
  }
  const now = bangkokTimestamp();
  const reply = {
    schema: 'agent-msg/v1',
    id: newMessageId(now),
    kind: 'reply',
    from: name,
    to: msg.from,
    category: null,
    priority: msg.priority ?? 2,
    reply_to: id,
    // Carry the CONVERSATION binding verbatim. This one line is what makes the
    // outbound half of a transcript work: the relay posts this reply to the
    // chat, and without the thread id it would have no conversation to record
    // the agent's turn in — the user's question and the answer would land in
    // different places, or the answer nowhere at all.
    thread_id: msg.thread_id ?? null,
    // Carry the delegation lineage verbatim: the reply closes this hop, so
    // the chain is NOT extended here — send.mjs appends only task origins.
    hops: Number.isInteger(msg.hops) ? msg.hops : 0,
    chain: Array.isArray(msg.chain) ? msg.chain : [],
    created_at: now,
    brief: {
      goal: result.summary || `result of ${id}`,
      acceptance_criteria: [],
      work_dir: msg.brief?.work_dir ?? '',
      isolation: 'shared',
      constraints: [],
      body_file: null,
    },
    claim: null,
    result,
  };
  ensureRuntimeTree(repoRoot, msg.from);
  writeMessage(repoRoot, msg.from, 'new', reply);
  return { replyId: reply.id, note: ` — reply ${reply.id} → ${msg.from}` };
}

/**
 * Run `agent complete`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string, rest?: string[] }} args - rest[0] = message id.
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = validateAgentName(args.name);
  const flags = parseMemoryFlags(ctx.argv, ['no-reply']);
  requireCharter(repoRoot, name);

  // Prefix-gated id pick: parseArgs leaks space-form flag values (`--status
  // done`) into positionals, so only a msg-shaped token is the message id.
  const id = args.rest && args.rest.find((t) => typeof t === 'string' && t.startsWith('msg-'));
  if (!id) {
    throw new SidekicksError('agent complete: a message <id> is required (the claimed message being finished)', EXIT_VALIDATION);
  }

  const status = flags.status ? String(flags.status) : '';
  if (!RESULT_STATUSES.includes(status)) {
    throw new SidekicksError(
      `agent complete: --status is required — one of: ${RESULT_STATUSES.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const msg = readMessage(repoRoot, name, 'claimed', id);
  if (!msg) {
    throw new SidekicksError(
      `agent complete: '${id}' is not in ${name}/inbox/claimed — only a claimed message can be completed`,
      EXIT_NOT_FOUND
    );
  }

  // Options are the choices offered back to the ORIGINAL sender — on a
  // telegram-originated task the relay renders them as tap-to-answer inline
  // buttons under the reply. Only present when given (compatible extension).
  const options = collectRepeatable(ctx.argv, '--option');
  const result = {
    status,
    summary: flags.summary ? String(flags.summary) : '',
    branch: flags.branch ? String(flags.branch) : null,
    deliverables: collectRepeatable(ctx.argv, '--deliverable'),
    ...(options.length ? { options } : {}),
    completed_at: bangkokTimestamp(),
  };

  writeMessage(repoRoot, name, 'claimed', { ...msg, result });
  moveToDone(repoRoot, name, id);

  // Auto-reply to the original sender (best-effort: a vanished sender is
  // reported, never fatal — the completed message in done/ is the record).
  const replyNote = flags['no-reply'] ? '' : autoReplyToSender(repoRoot, name, msg, id, result).note;

  // L0 journal event — the deterministic spine. appendEvent never throws and
  // is a no-op when the journal is unconfigured, so an unwired machine behaves
  // exactly as before. Kept AFTER the mailbox transition on purpose: the
  // completion is already durable, so the journal can only ever add to it.
  const journal = appendEvent(repoRoot, { agent: name, msg, result });

  return {
    stdout: `completed ${id} [${status}]${replyNote}${journal.note}${journal.retroHint}\n`,
    exitCode: EXIT_OK,
  };
}
