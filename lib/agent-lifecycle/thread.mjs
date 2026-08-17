// lib/agent-lifecycle/thread.mjs
// `sidekicks agent thread <action> <agent> [<thread-id>] [flags]`
//
// The conversation-memory verb. All logic lives in _threads.mjs; this file is
// argument handling and presentation, so the relay, the delegate, and the model
// all project the SAME record through one renderer.
//
// Actions — machine-facing (called by CLI code paths: the relay and delegate):
//   resolve   resolve-or-open the thread a message belongs to (idle gap, /new,
//             reply-to rebinding, native channel threads)
//   append    record one turn
//   context   render the wake-context block
//   prune     retention sweep
// Actions — agent-facing (what the master/standby skill calls):
//   show      paged verbatim transcript — the "older turns on demand" surface
//   list      recent threads
//   search    flashback across titles, digests, and turn text
//   digest    write/refresh the durable digest
//   close     end a conversation explicitly
//   rebuild   self-heal records from disk
//
// TEXT ARGUMENTS MUST USE THE EQUALS FORM: --text=<value>, not --text <value>.
// parseMemoryFlags treats any '--'-prefixed token as a flag, so a chat message
// containing '--status done' or starting with '--- a/file' would be shredded by
// the space form. routeInbound already uses `--goal=${body}` for this reason.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { readFileSync } from 'node:fs';
import { parseMemoryFlags, validateAgentName, requireCharter } from './_shared.mjs';
import {
  DEFAULT_CONTEXT_TURNS,
  DEFAULT_IDLE_GAP_MIN,
  MAX_CONTEXT_BYTES,
  isThreadId,
  resolveThread,
  appendTurn,
  noteMessageId,
  readThread,
  readTurns,
  readDigest,
  digestIsStale,
  listThreads,
  searchThreads,
  renderContextBlock,
  setDigest,
  writeAutoDigest,
  closeThread,
  pruneThreads,
  rebuildThreads,
} from './_threads.mjs';

const ACTIONS = ['resolve', 'append', 'context', 'show', 'list', 'search', 'digest', 'close', 'prune', 'rebuild'];

/**
 * Re-derive positionals. The dispatcher's parseArgs runs non-strict, so the
 * VALUE of a space-form flag leaks into args.rest — only a token that looks
 * like what we want may be treated as a positional.
 */
function pickThreadId(rest) {
  const list = Array.isArray(rest) ? rest : [];
  return list.find((t) => typeof t === 'string' && isThreadId(t)) || null;
}

/** Collect a repeatable --deliverable flag (parseMemoryFlags keeps only the last). */
function collectDeliverables(argv) {
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '--deliverable' && list[i + 1] && !String(list[i + 1]).startsWith('--')) {
      out.push(list[i + 1]);
      i++;
    } else if (typeof list[i] === 'string' && list[i].startsWith('--deliverable=')) {
      out.push(list[i].slice('--deliverable='.length));
    }
  }
  return out.filter(Boolean);
}

/** Text from --<key>=<value>, or from --<key>-file=<path>. */
function textArg(flags, key) {
  if (flags[key] != null && flags[key] !== true) return String(flags[key]);
  const fileKey = `${key}-file`;
  if (flags[fileKey] != null && flags[fileKey] !== true) {
    try { return readFileSync(String(flags[fileKey]), 'utf8'); } catch (err) {
      throw new SidekicksError(`agent thread: cannot read --${fileKey} '${flags[fileKey]}': ${err.message}`, EXIT_VALIDATION);
    }
  }
  return null;
}

function num(flags, key, fallback) {
  const raw = flags[key];
  if (raw == null || raw === '' || raw === true) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new SidekicksError(`agent thread: invalid --${key} '${raw}' — a number >= 0`, EXIT_VALIDATION);
  }
  return n;
}

/** Resolve the thread an action targets: an explicit id, else the open one. */
function targetThread(repoRoot, agent, id) {
  if (id) {
    const t = readThread(repoRoot, agent, id);
    if (!t) throw new SidekicksError(`agent thread: no thread '${id}' for agent '${agent}'`, EXIT_NOT_FOUND);
    return t;
  }
  const open = listThreads(repoRoot, agent, { limit: 1, openOnly: true })[0];
  if (!open) {
    throw new SidekicksError(
      `agent thread: '${agent}' has no open conversation — name a thread id, or see 'sidekicks agent thread list ${agent}'`,
      EXIT_NOT_FOUND
    );
  }
  return open;
}

function threadRow(t) {
  return `${t.id}  ${String(t.status).padEnd(6)} ${String(t.turns).padStart(4)} turns  `
    + `${String(t.opened_at).slice(0, 16)}  ${t.title || '(untitled)'}`;
}

export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'new', 'auto', 'open', 'force']);
  const action = args.name ? String(args.name) : '';
  if (!ACTIONS.includes(action)) {
    throw new SidekicksError(
      `agent thread: an action is required — one of: ${ACTIONS.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  // The agent name is the first positional AFTER the action.
  const rest = Array.isArray(args.rest) ? args.rest : [];
  const agentName = rest.find((t) => typeof t === 'string' && !t.startsWith('--') && !isThreadId(t));
  const agent = validateAgentName(agentName);
  requireCharter(repoRoot, agent);
  const wantJson = Boolean(flags.json);
  const id = pickThreadId(rest) || (flags.thread && flags.thread !== true ? String(flags.thread) : null);

  // ── resolve ──────────────────────────────────────────────────────────────
  if (action === 'resolve') {
    const { thread, opened, note } = resolveThread(repoRoot, agent, {
      channel: flags.channel && flags.channel !== true ? String(flags.channel) : 'telegram',
      chatId: flags.chat && flags.chat !== true ? String(flags.chat) : null,
      userId: flags.user && flags.user !== true ? String(flags.user) : null,
      username: flags.username && flags.username !== true ? String(flags.username) : null,
      channelThreadKey: flags['channel-thread'] && flags['channel-thread'] !== true ? String(flags['channel-thread']) : null,
      replyToMessageId: flags['reply-to-message'] && flags['reply-to-message'] !== true ? String(flags['reply-to-message']) : null,
      idleGapMin: num(flags, 'idle-gap', DEFAULT_IDLE_GAP_MIN),
      threadId: id,
      forceNew: Boolean(flags.new),
      title: textArg(flags, 'title') || '',
    });
    if (!thread) {
      // No channel → no conversation. Exit 2 so a caller can branch cheaply.
      return { stdout: wantJson ? JSON.stringify({ thread: null, note }) + '\n' : `no conversation${note ? ` — ${note}` : ''}\n`, exitCode: 2 };
    }
    if (wantJson) return { stdout: JSON.stringify({ ...thread, opened, note }, null, 2) + '\n', exitCode: EXIT_OK };
    // BARE ID on stdout. This is a machine action whose output is captured
    // (`TID=$(… thread resolve …)`), so decoration would corrupt the caller —
    // `--json` is where the opened flag and the note live.
    return { stdout: `${thread.id}\n`, exitCode: EXIT_OK };
  }

  // ── append ───────────────────────────────────────────────────────────────
  if (action === 'append') {
    const t = targetThread(repoRoot, agent, id);
    const text = textArg(flags, 'text');
    if (text == null) {
      throw new SidekicksError("agent thread append: --text=<value> (or --text-file=<path>) is required", EXIT_VALIDATION);
    }
    const role = flags.role && flags.role !== true ? String(flags.role) : 'user';
    if (!['user', 'agent'].includes(role)) {
      throw new SidekicksError(`agent thread append: invalid --role '${role}' — user or agent`, EXIT_VALIDATION);
    }
    const res = appendTurn(repoRoot, agent, t.id, {
      role,
      text,
      msg_id: flags['msg-id'] && flags['msg-id'] !== true ? String(flags['msg-id']) : null,
      channel_message_id: flags['channel-message-id'] && flags['channel-message-id'] !== true ? String(flags['channel-message-id']) : null,
      kind: flags.kind && flags.kind !== true ? String(flags.kind) : null,
      status: flags.status && flags.status !== true ? String(flags.status) : null,
      deliverables: collectDeliverables(ctx.argv),
    });
    if (flags['msg-id'] && flags['msg-id'] !== true) noteMessageId(repoRoot, agent, t.id, String(flags['msg-id']));
    if (wantJson) return { stdout: JSON.stringify({ thread: t.id, ...res }) + '\n', exitCode: EXIT_OK };
    return {
      // The note rides on the SUCCESS line too. A rotation that deferred or failed leaves the
      // turn recorded, so it used to be reported only through --json — which meant a thread
      // stuck over its size cap, or a real IO failure on the archive, was invisible to a human.
      stdout: res.appended
        ? `appended turn ${res.seq} [${role}] to ${t.id}${res.note ? ` — ${res.note}` : ''}\n`
        : `no turn appended${res.note ? ` — ${res.note}` : ''}\n`,
      exitCode: EXIT_OK,
    };
  }

  // ── context ──────────────────────────────────────────────────────────────
  if (action === 'context') {
    // Lazily ensure a digest exists — the extractive one costs no model tokens,
    // and it is what guarantees context is never empty just because the model
    // never got round to writing prose.
    const open = id ? readThread(repoRoot, agent, id) : listThreads(repoRoot, agent, { limit: 1, openOnly: true })[0];
    if (open && digestIsStale(repoRoot, agent, open.id, open)) {
      writeAutoDigest(repoRoot, agent, open.id);
    }
    const block = renderContextBlock(repoRoot, agent, {
      threadId: id,
      turns: num(flags, 'turns', DEFAULT_CONTEXT_TURNS),
      maxBytes: num(flags, 'max-bytes', MAX_CONTEXT_BYTES),
    });
    if (wantJson) {
      return {
        stdout: JSON.stringify({
          thread: open ? open.id : null,
          bytes: Buffer.byteLength(block, 'utf8'),
          block,
        }, null, 2) + '\n',
        exitCode: block ? EXIT_OK : 2,
      };
    }
    return { stdout: block ? block + '\n' : 'no open conversation\n', exitCode: block ? EXIT_OK : 2 };
  }

  // ── show ─────────────────────────────────────────────────────────────────
  if (action === 'show') {
    const t = targetThread(repoRoot, agent, id);
    const from = num(flags, 'from', 1);
    const limit = num(flags, 'limit', 20);
    const turns = readTurns(repoRoot, agent, t.id).filter((x) => x.seq >= from).slice(0, limit);
    const digest = readDigest(repoRoot, agent, t.id);
    if (wantJson) {
      return { stdout: JSON.stringify({ thread: t, digest, turns }, null, 2) + '\n', exitCode: EXIT_OK };
    }
    const lines = [
      `${t.id} — ${t.title || '(untitled)'}`,
      `${t.channel}${t.chat_id ? ` chat ${t.chat_id}` : ''} · ${t.status} · opened ${t.opened_at} · ${t.turns} turns`,
      digest?.body ? `\ndigest (through ${digest.through_seq}, by ${digest.by}):\n${digest.body}` : '',
      '',
      ...turns.map((x) => `[${x.seq}] ${x.role === 'agent' ? 'agent' : 'user '} ${String(x.ts).slice(11, 16)}  ${x.text}`),
      '',
    ];
    return { stdout: lines.filter((l) => l !== '').join('\n') + '\n', exitCode: EXIT_OK };
  }

  // ── list ─────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const rows = listThreads(repoRoot, agent, {
      limit: num(flags, 'limit', 20),
      openOnly: Boolean(flags.open),
    });
    if (wantJson) return { stdout: JSON.stringify(rows, null, 2) + '\n', exitCode: EXIT_OK };
    if (!rows.length) return { stdout: `no conversations for '${agent}'\n`, exitCode: EXIT_OK };
    return { stdout: rows.map(threadRow).join('\n') + '\n', exitCode: EXIT_OK };
  }

  // ── search ───────────────────────────────────────────────────────────────
  if (action === 'search') {
    const query = textArg(flags, 'text');
    if (!query) {
      throw new SidekicksError("agent thread search: --text=<keywords> is required", EXIT_VALIDATION);
    }
    const hits = searchThreads(repoRoot, agent, query, {
      limit: num(flags, 'limit', 10),
      scope: flags.in && flags.in !== true ? String(flags.in) : 'all',
    });
    if (wantJson) return { stdout: JSON.stringify(hits, null, 2) + '\n', exitCode: hits.length ? EXIT_OK : 2 };
    if (!hits.length) return { stdout: `no conversation matches '${query}'\n`, exitCode: 2 };
    return {
      stdout: hits.map((h) => `${h.id}  ${String(h.when).slice(0, 16)}  ${h.title || '(untitled)'}\n    ${h.snippet}`).join('\n') + '\n',
      exitCode: EXIT_OK,
    };
  }

  // ── digest ───────────────────────────────────────────────────────────────
  if (action === 'digest') {
    const t = targetThread(repoRoot, agent, id);
    const body = textArg(flags, 'set');
    if (body == null && !flags.auto) {
      throw new SidekicksError(
        "agent thread digest: --set=<text> (or --set-file=<path>, or --auto for the extractive digest) is required",
        EXIT_VALIDATION
      );
    }
    const ok = body != null
      ? setDigest(repoRoot, agent, t.id, body)
      : writeAutoDigest(repoRoot, agent, t.id, { force: true });
    const digest = readDigest(repoRoot, agent, t.id);
    if (wantJson) return { stdout: JSON.stringify({ thread: t.id, written: ok, digest }, null, 2) + '\n', exitCode: EXIT_OK };
    return { stdout: `digest ${ok ? 'written' : 'unchanged'} for ${t.id} (by ${digest?.by ?? 'none'})\n`, exitCode: EXIT_OK };
  }

  // ── close ────────────────────────────────────────────────────────────────
  if (action === 'close') {
    const t = targetThread(repoRoot, agent, id);
    const reason = flags.reason && flags.reason !== true ? String(flags.reason) : 'explicit';
    const closed = closeThread(repoRoot, agent, t.id, reason);
    if (wantJson) return { stdout: JSON.stringify({ thread: t.id, closed, reason }) + '\n', exitCode: EXIT_OK };
    return { stdout: closed ? `closed ${t.id} (${reason})\n` : `${t.id} was already closed\n`, exitCode: EXIT_OK };
  }

  // ── prune ────────────────────────────────────────────────────────────────
  if (action === 'prune') {
    const res = pruneThreads(repoRoot, agent, {
      keepThreads: num(flags, 'keep-threads', undefined),
      turnsTtlDays: num(flags, 'turns-ttl-days', undefined),
    });
    if (wantJson) return { stdout: JSON.stringify(res, null, 2) + '\n', exitCode: EXIT_OK };
    return {
      stdout: `pruned: ${res.turnsDropped.length} transcript(s) reclaimed, ${res.threadsRemoved.length} thread(s) removed\n`,
      exitCode: EXIT_OK,
    };
  }

  // ── rebuild ──────────────────────────────────────────────────────────────
  const res = rebuildThreads(repoRoot, agent);
  if (wantJson) return { stdout: JSON.stringify(res, null, 2) + '\n', exitCode: EXIT_OK };
  return {
    stdout: `rebuilt: ${res.repaired.length} record(s) repaired${res.orphans.length ? `, ${res.orphans.length} empty thread(s) skipped` : ''}\n`,
    exitCode: EXIT_OK,
  };
}
