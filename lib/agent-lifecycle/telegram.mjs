// lib/agent-lifecycle/telegram.mjs
// `sidekicks agent telegram setup --token <bot-token> [--chat <id>] [--target <agent>]`
// `sidekicks agent telegram status`
// `sidekicks agent telegram serve [--once]`
//
// External-messenger relay: connects the agent mailbox substrate to the
// user's own Telegram chat, so the user can assign work and receive results
// from OUTSIDE the local network. Transport is Bot API LONG-POLLING
// (outbound HTTPS only — works behind NAT, no public IP, no webhook, no
// inbound port ever opened).
//
// The relay is itself a mailbox owner: a minimal agent charter `telegram`
// (categories: relay) is auto-created on first serve. Message flow:
//
//   user (Telegram chat) ──getUpdates──▶ relay ──agent send──▶ target inbox
//     `@steave fix the login bug` → task to steave, category auto-picked
//     from the target's charter (first category), --origin none (a human
//     message IS a fresh delegation chain). Default target: --target from
//     setup, else 'master'.
//     Routing is ACKNOWLEDGED in the chat immediately ("👍 Got it — <agent>
//     is on it") because the real answer can take minutes; `ack: false` (or
//     TELEGRAM_ACK=0) restores a silent chat. The detailed `→ <agent>
//     [<category>] <id>` line goes to the host log only. A routing FAILURE
//     always replies (the user must know their message went nowhere).
//
//     Replies post as Telegram HTML (headline + body + trailer, light
//     markdown in summaries rendered); a reply/signal carrying options
//     (`agent complete --option <label>` / `agent send --options "a;b"`)
//     gets an inline keyboard — a tap routes `@<agent> <label>` back through
//     the normal inbound path.
//
//   any agent ──agent send telegram / complete auto-reply──▶ relay inbox
//     ──sendMessage──▶ user's chat. The relay claims each message, posts it,
//     and completes it — so every worker completion routes back to the user.
//     File deliverables on the reply (attached via `agent complete
//     --deliverable <path>`) are additionally uploaded to the chat: images
//     (screenshot evidence) with sendPhoto, result files (reports, exports,
//     generated docs) with sendDocument — in-repo allowlisted files only,
//     best-effort per file.
//
// Security (external network — strict):
//   - Bot token + chat id live in .sidekicks/agents/.bridge/runtime/
//     telegram.json — git-ignored, machine-local, never committed.
//   - ONLY the configured chat id is served. While unconfigured, an inbound
//     message gets a one-line "authorize this chat id" hint; once configured,
//     any other chat is ignored silently. The configured chat id is the
//     user's standing pre-authorization for outbound sends to that chat.
//
// Zero npm dependencies — node:* + lib/ back-edges only (global fetch).

import { join, relative, resolve, sep, extname, basename } from 'node:path';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import {
  parseMemoryFlags,
  bangkokTimestamp,
  readCharter,
  listAgentNames,
  agentStatusRow,
  listMessageIds,
  readMessage,
  writePresence,
  ensureRuntimeTree,
  readControlStage,
  writeControlStage,
} from './_shared.mjs';
import {
  telegramConfigPath,
  readJsonFile,
  writeJsonFile,
  briefsDir,
  pruneBriefsDir,
  readRootMessagingConfig,
  readEnvFile,
  acquirePidFile,
  pidFilePath,
  isProcessAlive,
} from './_bridge.mjs';
import {
  DEFAULT_IDLE_GAP_MIN,
  resolveThread,
  appendTurn,
  noteMessageId,
  readThread,
  readDigest,
  digestIsStale,
  listThreads,
} from './_threads.mjs';
import { requeueOrphanedClaims } from './delegate.mjs';
import { run as sendRun } from './send.mjs';
import { run as claimRun } from './claim.mjs';
import { run as completeRun } from './complete.mjs';
import { run as createRun } from './create.mjs';

const RELAY = 'telegram';
// A lane (a `channels:` row) owns its OWN relay mailbox agent, named
// `telegram-<lane-id>`. That is what makes outbound routing free: inbound is
// sent `--from=telegram-<lane>`, so complete.mjs's autoReplyToSender already
// walks the reply home to the lane it came from — no lookup, no inference, and
// zero changes to send.mjs/complete.mjs. The DEFAULT lane keeps the bare
// `telegram` mailbox so a config migration never strands an in-flight reply.
const RELAY_PREFIX = 'telegram-';
// A lane id becomes an agent name — same shape `agent create` accepts.
const LANE_ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const DEFAULT_BOT_ID = 'default';
// The legacy channel matches ANY chat: today's inbound gate is authorization-
// only and never chat-scoped (a message from an unlisted chat whose USER is
// authorized still routes). Narrowing that during normalization would silently
// break every existing single-chat install.
const ANY_CHAT = '*';
const TG_TEXT_MAX = 4096;
const TG_CAPTION_MAX = 1024;
const TG_PHOTO_MAX_BYTES = 10 * 1024 * 1024; // Bot API upload cap for sendPhoto
const TG_DOC_MAX_BYTES = 50 * 1024 * 1024; // Bot API upload cap for sendDocument
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
// Result-file extensions worth shipping to the chat (research reports, exports,
// generated docs). Deliberately an allowlist: a deliverable naming a changed
// SOURCE file (lib/foo.mjs, src/…) records the change — it is not chat cargo.
const DOC_EXTS = new Set([
  '.md', '.txt', '.pdf', '.csv', '.tsv', '.json', '.yaml', '.yml', '.html',
  '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.zip',
]);
const LONG_GOAL_CHARS = 700; // longer inbound text rides as a body file
// A relay message that keeps dying mid-post is failed out rather than wedging
// every later reply behind it (same bound and reasoning as the delegate's).
const RELAY_REQUEUE_LIMIT = 3;

/**
 * Would uploading this repo-relative deliverable leak a secret to the chat?
 * The relay is a prompt-injection surface — an inbound task can ask a worker to
 * `agent complete --deliverable <path>`, and an allowlisted extension alone does
 * NOT make a file safe: `.sidekicks/config.yaml`, `.sidekicks/agents/.bridge/
 * runtime/bridge.json`, and `telegram.json` all end in `.yaml`/`.json` yet hold
 * the bearer token, bot token, and other credentials. Refuse the framework's
 * secret surfaces (`.sidekicks/`, `.git/`) and any secret-shaped path segment
 * (`.env`, a `secrets/` dir, a `*-token.json` name) regardless of extension.
 * `rel` is POSIX, repo-relative. Exported for tests.
 */
export function isSecretDeliverable(rel) {
  const segs = String(rel || '').toLowerCase().split('/').filter(Boolean);
  if (!segs.length) return false;
  if (segs[0] === '.sidekicks' || segs[0] === '.git') return true;
  const base = segs[segs.length - 1];
  if (base === '.env' || base.startsWith('.env.')) return true;
  return segs.some((s) => /(?:^|[._-])(secrets?|credentials?|password|token)(?:$|[._-])/.test(s));
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse an inbound chat text into {target, text}:
 *   '@steave fix the bug'  → { target: 'steave', text: 'fix the bug' }
 *   '/to steave fix ...'   → { target: 'steave', text: 'fix ...' }
 *   anything else          → { target: defaultTarget, text }
 */
export function parseTargetText(raw, defaultTarget) {
  const text = String(raw || '').trim();
  let m = text.match(/^@([a-z0-9][a-z0-9-]*)\s+(.*)$/s);
  if (m) return { target: m[1], text: m[2].trim() };
  m = text.match(/^\/to\s+([a-z0-9][a-z0-9-]*)\s+(.*)$/s);
  if (m) return { target: m[1], text: m[2].trim() };
  return { target: defaultTarget, text };
}

/** Escape the three characters Telegram HTML parse mode reserves. */
export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render the light markdown agents naturally write in a summary into Telegram
 * HTML: ``` fences → <pre>, `code` → <code>, **bold** → <b>, # headings → a
 * bold line, - / * bullets → •. Escapes first, so a summary can never inject
 * markup. Deliberately no full markdown parser — anything unrecognized stays
 * visible as written. Exported for tests.
 */
export function mdToChatHtml(s) {
  let t = escapeHtml(s || '');
  t = t.replace(/```[a-z]*\n?([\s\S]*?)```/g, (_, code) => `<pre>${code.replace(/\n+$/, '')}</pre>`);
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  t = t.replace(/^(\s*)[-*]\s+/gm, '$1• ');
  return t;
}

/** Strip chat HTML back to plain text — the parse-failure fallback and the transcript form. */
export function chatHtmlToPlain(html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Format one relay-inbox message for the chat as Telegram HTML (bounded to
 * TG_TEXT_MAX): a status headline (icon + bold agent + status), a blank line,
 * the summary body with its newlines/markdown rendered instead of mashed into
 * one line, then branch/deliverable trailer lines. Sent with parse_mode HTML;
 * chatHtmlToPlain(text) is the same message for a plain-text fallback.
 */
export function formatForChat(msg) {
  const parts = [];
  if (msg.kind === 'reply' && msg.result) {
    const icon = msg.result.status === 'done' ? '✅' : '❌';
    parts.push(`${icon} <b>${escapeHtml(msg.from)}</b> — ${escapeHtml(msg.result.status)}`);
    const body = mdToChatHtml(msg.result.summary || msg.brief?.goal || msg.reply_to || '');
    if (body) parts.push(body);
    const trailer = [];
    if (msg.result.branch) trailer.push(`🌿 <code>${escapeHtml(msg.result.branch)}</code>`);
    for (const d of msg.result.deliverables || []) trailer.push(`📎 ${escapeHtml(d)}`);
    if (trailer.length) parts.push(trailer.join('\n'));
  } else {
    parts.push(`📨 <b>${escapeHtml(msg.from)}</b>`);
    const body = mdToChatHtml(msg.brief?.goal || '');
    if (body) parts.push(body);
  }
  const text = parts.join('\n\n');
  return text.length > TG_TEXT_MAX ? text.slice(0, TG_TEXT_MAX - 1) + '…' : text;
}

// Telegram caps callback_data at 64 BYTES; a longer payload is refused by the
// Bot API, so option routing data is truncated to fit (labels stay full).
const TG_CALLBACK_MAX_BYTES = 64;

/**
 * Build the inline-keyboard reply_markup for a message that carries choices:
 * `result.options` on a reply (`agent complete --option <label>`...) or
 * `brief.options` on a signal/task (`agent send --options "a;b"`). Each option
 * becomes one tap-to-answer button; the callback routes `@<author> <label>`
 * back through the normal inbound path, so a tap answers the agent that asked.
 * Returns null when the message carries no options. Exported for tests.
 */
export function chatKeyboard(msg) {
  const raw = (msg?.result?.options?.length ? msg.result.options : msg?.brief?.options) || [];
  const rows = [];
  for (const o of raw) {
    if (typeof o !== 'string' || !o.trim()) continue;
    const label = o.trim();
    let data = `@${msg.from} ${label}`;
    while (Buffer.byteLength(data, 'utf8') > TG_CALLBACK_MAX_BYTES) data = data.slice(0, -1);
    rows.push([{ text: label, callback_data: data }]);
  }
  return rows.length ? { inline_keyboard: rows } : null;
}

/**
 * Send a formatted chat message: HTML parse mode first, plain-text fallback
 * when Telegram rejects the entities (e.g. the TG_TEXT_MAX cut landed inside
 * a tag). Keyboard (when given) rides both attempts.
 */
async function sendChatHtml(api, chatId, html, keyboard, topicId = null) {
  const markup = keyboard ? { reply_markup: keyboard } : {};
  // Only when non-null: the Bot API REJECTS message_thread_id on a chat that is
  // not a forum, so a blanket field would break every ordinary lane.
  const topic = topicId == null ? {} : { message_thread_id: Number(topicId) };
  try {
    return await api.sendMessage(chatId, html, { parse_mode: 'HTML', ...topic, ...markup });
  } catch {
    return await api.sendMessage(chatId, chatHtmlToPlain(html), { ...topic, ...markup });
  }
}

/**
 * Resolve a message's deliverables to files safe to upload into the chat:
 * images (screenshot evidence → sendPhoto) and result files (research
 * reports, exports, generated docs → sendDocument). Each file must resolve
 * INSIDE the repo root (deliverables are repo-relative by the portable-path
 * rule — an absolute or traversing path that escapes the repo is refused,
 * never uploaded), exist on disk, and fit Telegram's per-method upload cap.
 * Source-code deliverables (a changed lib/foo.mjs) are not chat cargo — only
 * the image/document allowlists ship. Secret-bearing paths (see
 * isSecretDeliverable — `.sidekicks/` credentials, `.env`, `secrets/`) are
 * refused regardless of extension. Returns [{ abs, rel, size, kind }],
 * kind 'photo' | 'document'. Exported for tests.
 */
export function fileDeliverables(repoRoot, msg) {
  const out = [];
  const root = resolve(repoRoot);
  for (const d of msg?.result?.deliverables || []) {
    if (typeof d !== 'string' || !d) continue;
    const ext = extname(d).toLowerCase();
    const kind = IMAGE_EXTS.has(ext) ? 'photo' : DOC_EXTS.has(ext) ? 'document' : null;
    if (!kind) continue;
    const abs = resolve(root, d);
    if (abs !== root && !abs.startsWith(root + sep)) continue; // outside the repo
    const rel = relative(root, abs).replace(/\\/g, '/');
    if (isSecretDeliverable(rel)) continue; // never ship secret-bearing files to the chat
    let st;
    try { st = statSync(abs); } catch { continue; }
    const cap = kind === 'photo' ? TG_PHOTO_MAX_BYTES : TG_DOC_MAX_BYTES;
    if (!st.isFile() || st.size === 0 || st.size > cap) continue;
    out.push({ abs, rel, size: st.size, kind });
  }
  return out;
}

/**
 * One-line roster summary for the /agents command. Every relay mailbox agent is
 * hidden — they are transport endpoints, not people you can assign work to.
 * `relays` comes from the live channel table; without it only the legacy
 * `telegram` mailbox is hidden.
 */
export function rosterSummary(repoRoot, relays = null) {
  const skip = new Set(Array.isArray(relays) && relays.length ? relays : [RELAY]);
  const rows = listAgentNames(repoRoot)
    .filter((n) => !skip.has(n))
    .map((n) => agentStatusRow(repoRoot, n));
  if (!rows.length) return 'no agents yet';
  return rows
    .map((r) => `${r.name} (${r.presence}) — ${r.categories.join(', ')}`)
    .join('\n');
}

/** Persist a long inbound text as a git-ignored brief file (repo-relative). */
function writeBriefFile(repoRoot, text) {
  const dir = briefsDir(repoRoot);
  mkdirp(dir);
  const name = `tg-${bangkokTimestamp().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${Math.random().toString(16).slice(2, 6)}.md`;
  const abs = join(dir, name);
  assertWritable(abs, repoRoot);
  writeAtomic(abs, String(text));
  pruneBriefsDir(repoRoot); // cap disk use — newest briefs survive
  return relative(repoRoot, abs).replace(/\\/g, '/');
}

/**
 * Route one inbound user text into an agent's mailbox. Returns
 * { line, target, id }: `line` is the ack for the HOST LOG, `target`/`id`
 * feed the chat acknowledgement (see processUpdates). Throws SidekicksError
 * with a user-readable message on a routing failure (unknown agent, retired, …).
 */
export async function routeInbound(repoRoot, text, defaultTarget, meta = {}, opts = {}) {
  const { target, text: body } = parseTargetText(text, defaultTarget);
  if (!body) throw new SidekicksError('empty message — nothing to route', EXIT_VALIDATION);
  const charter = readCharter(repoRoot, target);
  if (!charter) {
    throw new SidekicksError(`no agent named '${target}' — /agents lists the roster`, EXIT_VALIDATION);
  }
  const cats = Array.isArray(charter.categories) ? charter.categories : [];
  if (!cats.length) {
    throw new SidekicksError(`agent '${target}' has no charter categories — cannot route a task`, EXIT_VALIDATION);
  }
  // Which conversation is this? Threads are per (agent, channel, chat), so a
  // mid-conversation `@steave …` correctly gets its own thread. resolveThread
  // never throws and returns a null thread when there is no channel at all
  // (a three-argument call, the routine scheduler, an agent-to-agent task).
  const { thread } = resolveThread(repoRoot, target, { ...meta, channel: meta.channel || 'telegram' });

  // --from is the LANE's relay mailbox: complete.mjs auto-replies to the sender,
  // so this is the single field that walks the answer back to the chat (and
  // topic) the request came from.
  const fromAgent = opts.fromAgent || RELAY;
  const argv = ['agent', 'send', target, '--from=' + fromAgent, '--kind=task', `--category=${cats[0]}`, '--origin=none', '--json'];
  if (thread) argv.push(`--thread=${thread.id}`);
  if (body.length > LONG_GOAL_CHARS) {
    argv.push(`--goal=${body.slice(0, 120)}…`, `--body-file=${writeBriefFile(repoRoot, body)}`);
  } else {
    argv.push(`--goal=${body}`);
  }
  // Send FIRST, record second: a send that fails (unknown agent, category
  // mismatch) means the message went nowhere, and a transcript must not claim
  // the user said something to an agent that never received it. The returned id
  // is also what makes the turn idempotent against a later requeue.
  const result = await sendRun({ repoRoot, argv, flags: {} }, { name: target });
  const msg = JSON.parse(result.stdout);
  if (thread) {
    appendTurn(repoRoot, target, thread.id, {
      role: 'user',
      text: body,
      msg_id: msg.id,
      channel_message_id: meta.channelMessageId ?? null,
      kind: 'task',
    });
    noteMessageId(repoRoot, target, thread.id, msg.id);
  }
  return {
    line: `→ ${target} [${msg.category}] ${msg.id}${thread ? ` (thread ${thread.id})` : ''}`,
    target,
    id: msg.id,
  };
}

/**
 * One-line answer for `/thread` — which conversation the chat is currently in.
 * Read-only; never opens or closes anything.
 */
export function threadStatusLine(repoRoot, agent, chatId) {
  const open = listThreads(repoRoot, agent, { openOnly: true })
    .find((t) => t.channel === 'telegram' && (chatId == null || t.chat_id === String(chatId)));
  if (!open) return `no open conversation with ${agent} — your next message starts one`;
  const d = readDigest(repoRoot, agent, open.id);
  return [
    `thread ${open.id}`,
    `title:  ${open.title || '(untitled)'}`,
    `opened: ${open.opened_at}`,
    `turns:  ${open.turns} (${open.user_turns} from you)`,
    `digest: ${d ? `by ${d.by} through turn ${d.through_seq}${digestIsStale(repoRoot, agent, open.id, open) ? ' (stale)' : ''}` : 'none yet'}`,
  ].join('\n');
}

/**
 * Process a batch of Telegram updates. api = { sendMessage(chatId, text) }.
 * Returns the highest update_id seen (for offset persistence), or null.
 * Exported for tests — no network, no loop.
 */
export async function processUpdates(repoRoot, cfg, updates, api, bot = null) {
  let maxId = null;
  // Defensive: callers that hand-build a cfg (tests, the routine scheduler)
  // never went through effectiveTelegramConfig, so synthesize the legacy lane
  // here. Idempotent, so the serve loop pays nothing for it.
  if (!Array.isArray(cfg.channels) || !cfg.channels.length) normalizeTelegramConfig(cfg);
  const botId = bot?.id || cfg.channels.find((c) => c.default)?.bot || DEFAULT_BOT_ID;
  const botUsername = bot?.username || cfg.bot_username || null;
  // Same derivation as before the channel table: an explicit allowed_ids list,
  // else the configured chat id alone. effectiveTelegramConfig always sets
  // allowed_ids, so this fallback only serves hand-built cfg objects.
  const globalAllowed = Array.isArray(cfg.allowed_ids)
    ? cfg.allowed_ids.map(String)
    : (cfg.chat_id ? [String(cfg.chat_id)] : []);
  // Nothing authorized ANYWHERE — globally or on any lane. That is the setup
  // window, and it is checked before channel matching so a fresh install still
  // learns its own chat id.
  const nothingConfigured = !globalAllowed.length && !cfg.channels.some((c) => c.allowed_ids?.length);
  // Same authorization contract as before, now evaluated against whichever list
  // the matched lane puts in force: a user id always works; a chat id works only
  // for a PRIVATE chat (a group chat id represents every member and never grants
  // control by itself).
  const authorized = (chat, fromId, allowed) => {
    const isGroup = chat && (chat.type === 'group' || chat.type === 'supergroup');
    const userOk = fromId != null && allowed.includes(String(fromId));
    const chatOk = chat != null && allowed.includes(String(chat.id));
    return userOk || (chatOk && !isGroup);
  };
  // Post into the originating forum topic. Keeps the two-argument call shape
  // when there is nothing to add, so existing call assertions are untouched.
  const say = (chatId, text, extra = null, topicId = null) => {
    const t = topicId == null ? null : { message_thread_id: Number(topicId) };
    if (!t && !extra) return api.sendMessage(chatId, text);
    return api.sendMessage(chatId, text, { ...(t || {}), ...(extra || {}) });
  };
  for (const u of updates || []) {
    if (Number.isInteger(u.update_id)) maxId = maxId == null ? u.update_id : Math.max(maxId, u.update_id);

    // Inline-keyboard tap: the callback data is a routable inbound text
    // (`@<agent> <label>`, built by chatKeyboard). Answer the callback so the
    // client stops its spinner, clear the tapped keyboard so a second tap
    // cannot double-dispatch, then route it exactly like a typed message —
    // and echo the choice into the chat, because a tap leaves no user-visible
    // trace of what was picked otherwise.
    const cq = u.callback_query;
    if (cq && typeof cq.data === 'string' && cq.data.trim()) {
      const chat = cq.message && cq.message.chat;
      const cqChatId = chat && chat.id;
      const cqTopic = cq.message?.message_thread_id ?? null;
      const cqChannel = matchChannel(cfg, botId, cqChatId, cqTopic);
      const cqAllowed = allowedIdsFor(cfg, cqChannel, globalAllowed);
      if (nothingConfigured || !authorized(chat, cq.from && cq.from.id, cqAllowed)) {
        api.log?.(`ignored callback from non-authorized chat ${cqChatId} / user ${cq.from?.id}`);
        continue;
      }
      if (!cqChannel) {
        api.log?.(`ignored callback from unmapped chat ${cqChatId}${cqTopic != null ? ` topic ${cqTopic}` : ''} (bot ${botId})`);
        continue;
      }
      try { await api.answerCallbackQuery?.(cq.id); } catch { /* best-effort */ }
      try { await api.editMessageReplyMarkup?.(cqChatId, cq.message?.message_id); } catch { /* best-effort */ }
      const cqMeta = {
        channel: 'telegram',
        botId,
        chatId: cqChatId,
        userId: cq.from?.id ?? null,
        username: cq.from?.username || null,
        channelMessageId: cq.message?.message_id ?? null,
        channelThreadKey: cqTopic,
        replyToMessageId: null,
        idleGapMin: cfg.thread_idle_gap_minutes ?? DEFAULT_IDLE_GAP_MIN,
      };
      const cqDefault = cqChannel.target || cfg.default_target || 'master';
      try {
        const routed = await routeInbound(repoRoot, cq.data, cqDefault, cqMeta, { fromAgent: cqChannel.relay });
        api.log?.(routed.line);
        const { text: choice } = parseTargetText(cq.data, cqDefault);
        await say(cqChatId, `▶️ <b>${escapeHtml(choice)}</b> → ${escapeHtml(routed.target)} is on it.`, { parse_mode: 'HTML' }, cqTopic);
      } catch (err) {
        await say(cqChatId, `⚠️ ${err.message}`, null, cqTopic);
      }
      continue;
    }

    const m = u.message;
    if (!m || typeof m.text !== 'string') continue;
    const chatId = m.chat && m.chat.id;

    const fromId = m.from && m.from.id;

    if (nothingConfigured) {
      // Setup window: tell the sender their ids so the user can authorize them,
      // and log locally too (api.log is optional — tests pass a bare api). The
      // host log always fires (that is how the user learns the id); the CHAT
      // reply is sent at most ONCE per chat id per serve process, so a stranger
      // spamming an unconfigured bot can't use it as a reflection amplifier.
      api.log?.(`unauthorized chat ${chatId} (user ${m.from?.username || fromId || 'unknown'}) — authorize: TELEGRAM_ALLOWED_USERS=${fromId ?? chatId} or setup --chat ${chatId}`);
      const greeted = (api._greeted ||= new Set());
      if (!greeted.has(String(chatId))) {
        greeted.add(String(chatId));
        await api.sendMessage(chatId, `Sidekicks relay: not authorized yet. Chat id: ${chatId}, user id: ${fromId ?? 'unknown'}\nAuthorize on the host: sidekicks agent telegram setup --chat ${chatId} (or TELEGRAM_ALLOWED_USERS in .env)`);
      }
      continue;
    }
    // Which lane serves this (bot, chat, topic)? Matched BEFORE authorization,
    // because a lane's own `allowed_users` replaces the global list — that is
    // what lets one lane be locked to one person while another stays open.
    const topicId = m.message_thread_id ?? null;
    const channel = matchChannel(cfg, botId, chatId, topicId);
    const allowed = allowedIdsFor(cfg, channel, globalAllowed);

    // A group chat id represents EVERY member, so authorizing it would grant all
    // members agent control. Authorize a group only by an explicit USER id — the
    // group's own chat id in the whitelist is never enough. Private chats: the
    // chat id IS the single user, so chat-id auth is fine there.
    const isGroup = m.chat && (m.chat.type === 'group' || m.chat.type === 'supergroup');
    const userOk = fromId != null && allowed.includes(String(fromId));
    const chatOk = allowed.includes(String(chatId));
    if (!(userOk || (chatOk && !isGroup))) {
      if (chatOk && isGroup && !userOk) {
        api.log?.(`group chat ${chatId} authorized by chat id only — ignoring; whitelist member user ids via TELEGRAM_ALLOWED_USERS (user ${fromId})`);
      } else {
        api.log?.(`ignored message from non-authorized chat ${chatId} / user ${fromId}`);
      }
      continue; // stranger (or group-chat-id-only) — no reply
    }

    // Authorized, but no lane claims this chat. NEVER fall back to the default
    // lane: dropping one domain's request into another domain's orchestrator is
    // a silent misroute, the worst failure this table can produce. Name the ids
    // instead — Telegram's UI does not show a topic id anywhere else, so this
    // hint is also how a lane gets configured. One reply per (chat, topic) per
    // process, and only AFTER authorization, so it is not a reflection amplifier.
    if (!channel) {
      api.log?.(`unmapped chat ${chatId}${topicId != null ? ` topic ${topicId}` : ''} (bot ${botId}) — add a telegram.channels row to route it`);
      const seen = (api._unmapped ||= new Set());
      const key = `${chatId}:${topicId ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        await say(chatId, [
          'Sidekicks relay: this chat is authorized but no lane serves it yet.',
          `  bot:   ${botId}`,
          `  chat:  ${chatId}`,
          ...(topicId != null ? [`  topic: ${topicId}`] : []),
          'Add a telegram.channels row on the host to route it to an orchestrator.',
        ].join('\n'), null, topicId);
      }
      continue;
    }

    let text = m.text.trim();
    // require_mention: in GROUP chats only react when the bot is @mentioned
    // (strip the mention before routing); private chats never need one.
    const requireMention = channel.require_mention != null ? channel.require_mention : cfg.require_mention;
    if (isGroup && requireMention) {
      const mention = botUsername ? `@${botUsername}` : null;
      if (!mention || !text.toLowerCase().includes(mention.toLowerCase())) {
        api.log?.(`group message without @mention ignored (require_mention)`);
        continue;
      }
      text = text.replace(new RegExp(mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '').trim();
    }
    if (text === '/help' || text === '/start') {
      await say(chatId, [
        'Sidekicks agent relay.',
        `<text> → ${channel.target}`,
        '@<agent> <text> → that agent',
        '/agents → roster',
        '/thread → which conversation you are in',
        '/new → start a fresh conversation',
      ].join('\n'), null, topicId);
      continue;
    }
    if (text === '/agents') {
      await say(chatId, rosterSummary(repoRoot, relayAgentNames(cfg)), null, topicId);
      continue;
    }

    // Conversation metadata Telegram gives us that used to be dropped on the
    // floor. message_id is what makes a later reply-to rebind possible;
    // message_thread_id is a native forum topic (a thread in its own right, and
    // the idle gap must never split one).
    // The lane's target owns plain messages here; an explicit `@agent` prefix
    // still wins inside parseTargetText, and the global default_target is only
    // the fallback for a lane that names none.
    const defaultTarget = channel.target || cfg.default_target || 'master';
    const meta = {
      channel: 'telegram',
      botId,
      chatId,
      userId: fromId ?? null,
      username: (m.from && m.from.username) || null,
      channelMessageId: m.message_id ?? null,
      channelThreadKey: topicId,
      replyToMessageId: (m.reply_to_message && m.reply_to_message.message_id) ?? null,
      idleGapMin: cfg.thread_idle_gap_minutes ?? DEFAULT_IDLE_GAP_MIN,
    };

    if (text === '/thread') {
      await say(chatId, threadStatusLine(repoRoot, defaultTarget, chatId), null, topicId);
      continue;
    }
    if (text === '/new') {
      const { thread } = resolveThread(repoRoot, defaultTarget, { ...meta, forceNew: true });
      await say(chatId, thread
        ? `new conversation ${thread.id} — the previous one is archived and searchable`
        : 'could not start a new conversation (see the host log)', null, topicId);
      continue;
    }

    try {
      // Acknowledge routing IMMEDIATELY (cfg.ack, default on): the answer can
      // take minutes, and a silent gap reads as "the bot ate my message". The
      // detailed `→ agent [category] id` line still goes to the host log only;
      // ack: false restores the fully silent chat.
      const routed = await routeInbound(repoRoot, text, defaultTarget, meta, { fromAgent: channel.relay });
      api.log?.(routed.line);
      if (cfg.ack !== false) {
        await say(chatId, `👍 Got it — <b>${escapeHtml(routed.target)}</b> is on it. I'll post the result here.`, { parse_mode: 'HTML' }, topicId);
      }
    } catch (err) {
      await say(chatId, `⚠️ ${err.message}`, null, topicId);
    }
  }
  return maxId;
}

/**
 * Relay the `telegram` agent's own inbox to the chat: claim each new message,
 * post it, complete it (a task completion auto-replies delivery to its
 * sender). Returns the number of messages relayed. Exported for tests.
 */
export async function relayInbox(repoRoot, cfg, api, session, lane = null) {
  let count = 0;
  // One lane = one mailbox + one destination. Without a lane this is the legacy
  // single-chat relay, byte-for-byte as before.
  const RELAY_AGENT = lane?.relay || RELAY;
  const chatOut = lane ? lane.chat_out : cfg.chat_id;
  const topicOut = lane?.topic ?? null;
  if (!chatOut) return count;
  // Crash recovery for the RELAY's own mailbox. The delegate requeues orphaned
  // claims for its own agent only, so nothing ever rescued a message stranded
  // in telegram/inbox/claimed by a relay crash between claim and complete — the
  // loop reads `new` only, so it sat there forever. Now it also costs the
  // outbound turn of a transcript, so recover first, every pass.
  const recovered = requeueOrphanedClaims(repoRoot, RELAY_AGENT, RELAY_REQUEUE_LIMIT);
  for (const id of recovered.requeued) api.log?.(`requeued stranded relay claim ${id}`);
  for (const id of recovered.failedOut) api.log?.(`relay message ${id} abandoned after ${RELAY_REQUEUE_LIMIT} interrupted passes`);

  for (;;) {
    const ids = listMessageIds(repoRoot, RELAY_AGENT, 'new');
    if (!ids.length) return count;
    const claim = await claimRun(
      { repoRoot, argv: ['agent', 'claim', RELAY_AGENT, `--session=${session}`], flags: {} },
      { name: RELAY_AGENT, rest: [] }
    );
    if (claim.exitCode !== EXIT_OK) return count;
    const claimed = JSON.parse(claim.stdout);
    const full = readMessage(repoRoot, RELAY_AGENT, 'claimed', claimed.id) || claimed;
    const chatText = formatForChat(full);
    const keyboard = chatKeyboard(full);
    const files = fileDeliverables(repoRoot, full);
    // A message with nothing to show — no goal or result summary, no option
    // buttons, no uploadable deliverables — is consumed without posting: a bare
    // "📨 name" placeholder tells the user nothing and reads as a bug. `agent
    // send` refuses goalless signals at write time; this catches everything
    // that arrives by another path.
    const renderable = Boolean(
      (full.kind === 'reply' && full.result) ||
      String(full.brief?.goal || '').trim() ||
      keyboard || files.length
    );
    if (!renderable) {
      api.log?.(`skipped empty ${full.kind || 'message'} ${claimed.id} from ${full.from} — no text, options, or deliverables`);
      await completeRun(
        { repoRoot, argv: ['agent', 'complete', RELAY_AGENT, claimed.id, '--status=done', '--summary=skipped: empty message (no text, options, or deliverables)'], flags: {} },
        { name: RELAY_AGENT, rest: [claimed.id] }
      );
      continue;
    }
    // HTML-formatted post; options on the message become tap-to-answer
    // inline-keyboard buttons (see chatKeyboard / the callback_query branch).
    const sent = await sendChatHtml(api, chatOut, chatText, keyboard, topicOut);
    // Evidence & result files: image deliverables ride the reply as photo
    // uploads, document deliverables (reports, exports) as file uploads.
    // Best-effort per file — a failed upload is logged, never blocks the relay.
    for (const f of files) {
      const send = f.kind === 'photo' ? api.sendPhoto : api.sendDocument;
      if (typeof send !== 'function') continue;
      try {
        await send(chatOut, f.abs, `${full.from}: ${f.rel}`.slice(0, TG_CAPTION_MAX), topicOut);
      } catch (err) {
        api.log?.(`send ${f.kind} ${f.rel} failed: ${err.message}`);
      }
    }
    // Record the AGENT's turn — the bytes the user actually saw, not the raw
    // result object. That is what makes the transcript a dialogue record rather
    // than a second copy of the mailbox. Appended only AFTER the send succeeded:
    // a turn the user never received must not appear in the conversation.
    //
    // A signal (a plan notice) can never auto-reply, so this is the ONLY place
    // that knows it reached the chat. The thread id rode here on the reply via
    // autoReplyToSender; a proactive signal from a worker that never saw a
    // thread falls back to the user's currently open conversation — and if there
    // is none, it is simply not recorded. The outbound path NEVER opens a
    // thread; only an inbound user message does.
    const author = full.from;
    let threadId = full.thread_id && readThread(repoRoot, author, full.thread_id) ? full.thread_id : null;
    if (!threadId) {
      const open = listThreads(repoRoot, author, { openOnly: true })
        .find((t) => t.channel === 'telegram' && (!chatOut || t.chat_id === String(chatOut)));
      threadId = open ? open.id : null;
    }
    if (threadId) {
      appendTurn(repoRoot, author, threadId, {
        role: 'agent',
        // Plain form of what the chat saw — transcripts are read by models and
        // humans, and HTML entities/tags are noise there.
        text: chatHtmlToPlain(chatText),
        // Idempotency key: the message being relayed. A requeued relay pass
        // re-posts, and must not double-record the answer.
        msg_id: full.id,
        channel_message_id: sent?.message_id ?? null,
        kind: full.kind || null,
        status: full.result?.status ?? null,
        deliverables: full.result?.deliverables ?? [],
      });
    }

    await completeRun(
      { repoRoot, argv: ['agent', 'complete', RELAY_AGENT, claimed.id, '--status=done', '--summary=relayed to telegram chat'], flags: {} },
      { name: RELAY_AGENT, rest: [claimed.id] }
    );
    count++;
  }
}

// ---------------------------------------------------------------------------
// Real Telegram transport
// ---------------------------------------------------------------------------

function tgApi(botToken) {
  const base = `https://api.telegram.org/bot${botToken}`;
  // Multipart upload via the Node-global FormData/Blob — still zero npm deps.
  async function upload(method, field, chatId, absPath, caption, threadId = null) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    // Forum topic, when the lane has one — same non-null rule as sendMessage.
    if (threadId != null) form.append('message_thread_id', String(threadId));
    if (caption) form.append('caption', String(caption).slice(0, TG_CAPTION_MAX));
    form.append(field, new Blob([readFileSync(absPath)]), basename(absPath));
    const res = await fetch(`${base}/${method}`, { method: 'POST', body: form });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`${method}: ${json.description || res.status}`);
  }
  return {
    async getMe() {
      const res = await fetch(`${base}/getMe`);
      const json = await res.json();
      if (!json.ok) throw new Error(`getMe: ${json.description || res.status}`);
      return json.result || {};
    },
    async getUpdates(offset, timeoutS) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), (timeoutS + 10) * 1000);
      try {
        const res = await fetch(`${base}/getUpdates?timeout=${timeoutS}${offset != null ? `&offset=${offset}` : ''}`, { signal: ac.signal });
        const json = await res.json();
        if (!json.ok) throw new Error(`getUpdates: ${json.description || res.status}`);
        return json.result || [];
      } finally {
        clearTimeout(t);
      }
    },
    async sendMessage(chatId, text, extra = {}) {
      // extra: { parse_mode, reply_markup } — parse_mode HTML renders the
      // formatted replies, reply_markup carries the inline choice keyboard.
      const res = await fetch(`${base}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, TG_TEXT_MAX), ...extra }),
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(`sendMessage: ${json.description || res.status}`);
      // Return the posted Message so the caller can record its message_id —
      // that id is what lets the user reply to this message later and have the
      // relay rebind to the conversation it belongs to. Callers must treat it
      // as optional (test fakes return undefined).
      return json.result || null;
    },
    async answerCallbackQuery(callbackQueryId) {
      const res = await fetch(`${base}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callback_query_id: String(callbackQueryId) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(`answerCallbackQuery: ${json.description || res.status}`);
    },
    async editMessageReplyMarkup(chatId, messageId) {
      // Clears the tapped keyboard (no reply_markup in the body = remove it).
      const res = await fetch(`${base}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(`editMessageReplyMarkup: ${json.description || res.status}`);
    },
    sendPhoto: (chatId, absPath, caption, threadId) => upload('sendPhoto', 'photo', chatId, absPath, caption, threadId),
    sendDocument: (chatId, absPath, caption, threadId) => upload('sendDocument', 'document', chatId, absPath, caption, threadId),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ensure the relay agent charter exists (auto-create, like master).
 * Exported: a `--deliver telegram` routine fires FROM this agent, so the
 * scheduler bootstraps it the same way `telegram serve` does. */
export async function ensureRelayAgent(repoRoot, name = RELAY, lane = '') {
  if (readCharter(repoRoot, name)) return;
  const specialty = name === RELAY
    ? 'Telegram relay — bridges the agent mailbox to the user\'s Telegram chat'
    : `Telegram relay for the '${lane || name}' lane — bridges the agent mailbox to that lane's Telegram chat`;
  await createRun(
    {
      repoRoot,
      argv: [
        'agent', 'create', name,
        `--specialty=${specialty}`,
        '--categories=relay',
      ],
      flags: {},
    },
    { name }
  );
}

/** Every relay mailbox agent this config owns (the legacy one always included). */
export function relayAgentNames(cfg) {
  const names = new Set([RELAY]);
  for (const c of (Array.isArray(cfg?.channels) ? cfg.channels : [])) names.add(relayAgentFor(c));
  return [...names];
}

// ---------------------------------------------------------------------------
// Verb
// ---------------------------------------------------------------------------

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

// ---------------------------------------------------------------------------
// Channel table — (bot, chat, topic) → target orchestrator
// ---------------------------------------------------------------------------

/**
 * The relay mailbox agent that owns a lane's outbound side. The default lane
 * keeps the bare `telegram` mailbox (migration safety); every other lane gets
 * `telegram-<id>`. Exported for tests and for the routine scheduler.
 */
export function relayAgentFor(channel) {
  if (!channel) return RELAY;
  if (channel.relay) return String(channel.relay);
  return channel.default ? RELAY : RELAY_PREFIX + channel.id;
}

/**
 * `lib/yaml-subset` does not support FLOW mappings and fails SILENTLY:
 *   `- { bot: main, chat: "1" }`  parses to  `{ '{ bot': 'main, chat: "1"…' }`
 * A row shaped like that is a copy-paste of flow syntax, not a lane — say so
 * instead of quietly building a junk channel out of the wreckage.
 */
function looksLikeFlowMapping(row) {
  return Object.keys(row).some((k) => k.trim().startsWith('{'));
}

function coerceIdList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (v == null || v === '') return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Fold the raw merged config into the canonical multi-lane shape, in place:
 *
 *   cfg.bots     [{ id, bot_token, username }]
 *   cfg.channels [{ id, bot, chat, topic, target, relay, chat_out,
 *                   allowed_ids, require_mention, default }]
 *   cfg.offsets  { <bot-id>: <getUpdates offset> }
 *
 * With no `channels:` declared it SYNTHESIZES the legacy single-lane shape from
 * the scalar `bot_token` / `chat_id` / `default_target`, so an existing install
 * keeps behaving byte-identically. `cfg.bot_token` is always left pointing at
 * the default bot's token — that one line is what keeps `_comms.mjs`,
 * `_office.mjs` and the `serve` gate working with no edits at all.
 *
 * Never throws: validation problems come back on `cfg.channel_errors` (fatal
 * for `serve`) and `cfg.channel_warnings`. It runs on the hot path of the comms
 * auto-start hook, where a throw would take down every agent launch.
 *
 * Idempotent, and safe on a hand-built cfg object. `env` is injectable.
 */
export function normalizeTelegramConfig(cfg, env = {}) {
  const merged = cfg && typeof cfg === 'object' ? cfg : {};
  const errors = [];
  const warnings = [];
  // A present-but-unparsed key is the other SILENT yaml-subset trap: a sequence
  // indented at the SAME level as its key parses to null rather than erroring
  //     channels:          →  { channels: null }      (WRONG, silent)
  //     - id: ops
  // Items must be indented DEEPER than the key. Without this check the table
  // would simply vanish and the relay would serve the legacy lane instead.
  for (const key of ['bots', 'channels']) {
    // `null` here means PRESENT BUT UNPARSED (that is what the same-indent case
    // yields); `undefined`/absent is the ordinary single-lane install.
    if (key in merged && merged[key] !== undefined && !Array.isArray(merged[key])) {
      errors.push(`telegram.${key}: not a block sequence — indent its "- " items DEEPER than the "${key}:" key (a same-indent sequence is silently read as empty)`);
      merged[key] = [];
    }
  }
  const declared = Array.isArray(merged.channels) && merged.channels.length > 0;

  // ── bots ────────────────────────────────────────────────────────────────
  const bots = [];
  const seenBot = new Set();
  const rawBots = Array.isArray(merged.bots) ? merged.bots : [];
  for (let i = 0; i < rawBots.length; i++) {
    const b = rawBots[i];
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      errors.push(`telegram.bots[${i}]: not a mapping`);
      continue;
    }
    if (looksLikeFlowMapping(b)) {
      errors.push(`telegram.bots[${i}]: flow mapping "{ … }" is not supported by the config parser — use block form (one "key: value" per indented line)`);
      continue;
    }
    const id = String(b.id ?? '').trim() || DEFAULT_BOT_ID;
    if (!LANE_ID_RE.test(id)) {
      errors.push(`telegram.bots[${i}]: id '${id}' must be lowercase letters/digits/hyphens (it names a bot in the channel table)`);
      continue;
    }
    if (seenBot.has(id)) {
      errors.push(`telegram.bots[${i}]: duplicate bot id '${id}'`);
      continue;
    }
    seenBot.add(id);
    bots.push({ id, bot_token: b.bot_token ? String(b.bot_token) : '', username: null });
  }
  if (!bots.length) {
    bots.push({ id: DEFAULT_BOT_ID, bot_token: merged.bot_token ? String(merged.bot_token) : '', username: null });
    seenBot.add(DEFAULT_BOT_ID);
  }

  // Env tokens. A per-bot key always beats the generic one, so N tokens have a
  // clean .env story; the generic key keeps meaning "the default bot".
  const generic = env.TELEGRAM_BOT_TOKEN ? String(env.TELEGRAM_BOT_TOKEN) : '';
  const genericTarget = bots.find((b) => b.id === DEFAULT_BOT_ID) || bots[0];
  if (generic && genericTarget) genericTarget.bot_token = generic;
  for (const b of bots) {
    const key = `TELEGRAM_BOT_TOKEN_${b.id.toUpperCase().replace(/-/g, '_')}`;
    if (env[key]) b.bot_token = String(env[key]);
  }

  // ── channels ────────────────────────────────────────────────────────────
  const channels = [];
  const seenChan = new Set();
  const seenTuple = new Set();
  const rawChannels = declared ? merged.channels : [];
  for (let i = 0; i < rawChannels.length; i++) {
    const c = rawChannels[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errors.push(`telegram.channels[${i}]: not a mapping`);
      continue;
    }
    if (looksLikeFlowMapping(c)) {
      errors.push(`telegram.channels[${i}]: flow mapping "{ … }" is not supported by the config parser — use block form (one "key: value" per indented line)`);
      continue;
    }
    const id = String(c.id ?? '').trim();
    if (!id) {
      errors.push(`telegram.channels[${i}]: 'id' is required — it names the lane's relay mailbox agent`);
      continue;
    }
    if (!LANE_ID_RE.test(id)) {
      errors.push(`telegram.channels[${i}]: id '${id}' must be lowercase letters/digits/hyphens (it becomes the agent name '${RELAY_PREFIX}${id}')`);
      continue;
    }
    if (seenChan.has(id)) {
      errors.push(`telegram.channels[${i}]: duplicate channel id '${id}'`);
      continue;
    }
    const chat = c.chat == null || c.chat === '' ? '' : String(c.chat).trim();
    if (!chat) {
      errors.push(`telegram.channels[${i}] ('${id}'): 'chat' is required — the Telegram chat id this lane serves`);
      continue;
    }
    const botId = String(c.bot ?? '').trim() || (bots.length === 1 ? bots[0].id : '');
    if (!botId || !seenBot.has(botId)) {
      errors.push(`telegram.channels[${i}] ('${id}'): unknown bot '${botId || '(unset)'}' — declare it under telegram.bots`);
      continue;
    }
    const topic = c.topic == null || c.topic === '' ? null : String(c.topic).trim();
    const tuple = `${botId} ${chat} ${topic ?? ''}`;
    if (seenTuple.has(tuple)) {
      errors.push(`telegram.channels[${i}] ('${id}'): another channel already serves bot '${botId}' chat ${chat}${topic ? ` topic ${topic}` : ''}`);
      continue;
    }
    seenChan.add(id);
    seenTuple.add(tuple);
    const allowed = coerceIdList(c.allowed_users);
    channels.push({
      id,
      bot: botId,
      chat,
      topic,
      target: String(c.target ?? '').trim() || String(merged.default_target || '').trim() || 'master',
      chat_out: c.chat_out != null && c.chat_out !== '' ? String(c.chat_out) : (chat === ANY_CHAT ? (merged.chat_id ? String(merged.chat_id) : '') : chat),
      allowed_ids: allowed,
      require_mention: c.require_mention == null ? null : (c.require_mention === true || TRUTHY.has(String(c.require_mention).toLowerCase())),
      default: c.default === true || TRUTHY.has(String(c.default ?? '').toLowerCase()),
      relay: c.relay ? String(c.relay) : null,
    });
  }

  if (!channels.length) {
    // Legacy synthesis. chat '*' preserves the authorization-only inbound gate.
    channels.push({
      id: DEFAULT_BOT_ID,
      bot: bots[0].id,
      chat: ANY_CHAT,
      topic: null,
      target: String(merged.default_target || '').trim() || 'master',
      chat_out: merged.chat_id ? String(merged.chat_id) : '',
      allowed_ids: [],
      require_mention: null,
      default: true,
      relay: RELAY,
    });
    if (declared) warnings.push('telegram.channels: every declared channel was rejected — falling back to the legacy single-chat lane');
  } else {
    const defaults = channels.filter((c) => c.default);
    if (defaults.length > 1) {
      errors.push(`telegram.channels: ${defaults.length} channels are marked 'default: true' — exactly one lane owns the legacy '${RELAY}' mailbox`);
      for (const c of defaults.slice(1)) c.default = false;
    } else if (!defaults.length) {
      channels[0].default = true;
    }
  }
  for (const c of channels) c.relay = relayAgentFor(c);

  const defaultChannel = channels.find((c) => c.default) || channels[0];

  // ── offsets ─────────────────────────────────────────────────────────────
  const offsets = (merged.offsets && typeof merged.offsets === 'object' && !Array.isArray(merged.offsets))
    ? { ...merged.offsets }
    : {};
  // Migrate the pre-multi-bot scalar cursor onto whichever bot the default lane
  // uses, so an upgrade never re-delivers the backlog as duplicate tasks.
  if (Number.isInteger(merged.offset) && offsets[defaultChannel.bot] == null) {
    offsets[defaultChannel.bot] = merged.offset;
  }
  for (const k of Object.keys(offsets)) {
    if (!Number.isInteger(offsets[k])) delete offsets[k];
  }

  merged.bots = bots;
  merged.channels = channels;
  merged.offsets = offsets;
  merged.default_channel_id = defaultChannel.id;
  merged.channel_errors = errors;
  merged.channel_warnings = warnings;
  // Compatibility: everything that still reads the scalar token (the comms
  // auto-start hook, the office snapshot, the `serve` gate) keeps working.
  const defaultBot = bots.find((b) => b.id === defaultChannel.bot) || bots[0];
  if (defaultBot && defaultBot.bot_token) merged.bot_token = defaultBot.bot_token;
  return merged;
}

/**
 * Next runtime-file state after one bot advances its getUpdates cursor, or null
 * when there is nothing to write. Offsets only ever move FORWARD: a stale lower
 * maxId must never lower a stored cursor, because re-delivering old updates
 * re-routes them as DUPLICATE TASKS.
 *
 * Pure and exported so the highest-consequence arithmetic in this file is
 * testable without a network. The caller must apply it with a read-modify-write
 * that contains no `await` — concurrent per-bot polls would otherwise interleave
 * and clobber each other.
 */
export function advanceOffsets(cur, botId, next, defaultBotId) {
  const base = cur && typeof cur === 'object' ? cur : {};
  const offsets = (base.offsets && typeof base.offsets === 'object' && !Array.isArray(base.offsets))
    ? { ...base.offsets }
    : {};
  const prev = Number.isInteger(offsets[botId]) ? offsets[botId] : -1;
  if (!Number.isInteger(next) || next <= prev) return null;
  offsets[botId] = next;
  const patch = { ...base, offsets };
  // Mirror the default bot onto the legacy scalar so a downgrade is harmless.
  if (botId === defaultBotId) patch.offset = next;
  return patch;
}

/**
 * Pick the lane serving an inbound update, most specific first:
 *   1. exact (bot, chat, topic)      — a forum topic bound to its own lane
 *   2. (bot, chat) with no topic     — the chat's catch-all
 *   3. (bot, chat '*')               — the legacy/wildcard lane
 *   4. null                          — UNMAPPED; never falls back to the
 *      default lane, because a silent misroute would drop one domain's work
 *      into another domain's orchestrator.
 * Exported for tests.
 */
export function matchChannel(cfg, botId, chatId, topicId = null) {
  const chans = Array.isArray(cfg?.channels) ? cfg.channels : [];
  const bot = String(botId ?? DEFAULT_BOT_ID);
  const chat = chatId == null ? null : String(chatId);
  const topic = topicId == null ? null : String(topicId);
  const forBot = chans.filter((c) => c.bot === bot);
  if (topic != null) {
    const exact = forBot.find((c) => c.chat === chat && c.topic != null && c.topic === topic);
    if (exact) return exact;
  }
  const catchAll = forBot.find((c) => c.chat === chat && c.topic == null);
  if (catchAll) return catchAll;
  return forBot.find((c) => c.chat === ANY_CHAT) || null;
}

/**
 * The authorization whitelist in force for a lane: a channel's own
 * `allowed_users` REPLACES the global list (never unions it), so a lane can be
 * locked to one person even when the global list is wide.
 */
export function allowedIdsFor(cfg, channel, fallback = null) {
  if (channel && Array.isArray(channel.allowed_ids) && channel.allowed_ids.length) {
    return channel.allowed_ids.map(String);
  }
  if (Array.isArray(fallback)) return fallback.map(String);
  return Array.isArray(cfg?.allowed_ids) ? cfg.allowed_ids.map(String) : [];
}

/**
 * Effective relay config, merged lowest-to-highest:
 *   runtime json (`telegram setup`) < root config.yaml `telegram:` block
 *   < environment (git-ignored repo-root .env file < process env).
 *
 * Env keys: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS (comma-separated
 * user/chat ids), TELEGRAM_DEFAULT_TARGET, TELEGRAM_REQUIRE_MENTION,
 * TELEGRAM_ACK (routing acknowledgement in the chat — default on).
 *
 * Normalized output adds:
 *   allowed_ids — the authorization whitelist ([]= nobody authorized yet):
 *     allowed_users when set, else [chat_id];
 *   chat_id — the primary outbound chat (first allowed id when unset);
 *   require_mention — boolean; in GROUP chats the bot only reacts when
 *     @mentioned (private chats never need a mention).
 *
 * The runtime file always supplies mutable state (offset). Exported for tests
 * (`env` injectable).
 */
export function effectiveTelegramConfig(repoRoot, env = process.env) {
  const runtime = readJsonFile(telegramConfigPath(repoRoot)) || {};
  const root = readRootMessagingConfig(repoRoot).telegram || {};
  const merged = { ...runtime };
  for (const k of ['bot_token', 'chat_id', 'default_target']) {
    if (root[k] != null && root[k] !== '') merged[k] = String(root[k]);
  }
  if (Array.isArray(root.allowed_users) && root.allowed_users.length) {
    merged.allowed_users = root.allowed_users.map(String);
  }
  if (root.require_mention != null) {
    merged.require_mention = root.require_mention === true || TRUTHY.has(String(root.require_mention).toLowerCase());
  }
  if (root.ack != null) {
    merged.ack = root.ack === true || TRUTHY.has(String(root.ack).toLowerCase());
  }
  if (root.thread_idle_gap_minutes != null && root.thread_idle_gap_minutes !== '') {
    merged.thread_idle_gap_minutes = Number(root.thread_idle_gap_minutes);
  }
  // The multi-lane table is config.yaml-shaped (block sequences). It must live
  // in ONE contiguous `telegram:` block: readRootMessagingConfig recovers this
  // section by slicing to the next column-0 key, so an interrupting top-level
  // line would truncate the table.
  // Copied even when malformed, so normalizeTelegramConfig can NAME the problem
  // rather than silently serving the legacy lane.
  if ('bots' in root) merged.bots = root.bots;
  if ('channels' in root) merged.channels = root.channels;

  const e = { ...readEnvFile(repoRoot), ...env };
  if (e.TELEGRAM_BOT_TOKEN) merged.bot_token = String(e.TELEGRAM_BOT_TOKEN);
  if (e.TELEGRAM_ALLOWED_USERS) {
    merged.allowed_users = String(e.TELEGRAM_ALLOWED_USERS).split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (e.TELEGRAM_DEFAULT_TARGET) merged.default_target = String(e.TELEGRAM_DEFAULT_TARGET);
  if (e.TELEGRAM_REQUIRE_MENTION != null && e.TELEGRAM_REQUIRE_MENTION !== '') {
    merged.require_mention = TRUTHY.has(String(e.TELEGRAM_REQUIRE_MENTION).toLowerCase());
  }
  if (e.TELEGRAM_ACK != null && e.TELEGRAM_ACK !== '') {
    merged.ack = TRUTHY.has(String(e.TELEGRAM_ACK).toLowerCase());
  }
  if (e.TELEGRAM_THREAD_IDLE_GAP != null && e.TELEGRAM_THREAD_IDLE_GAP !== '') {
    merged.thread_idle_gap_minutes = Number(e.TELEGRAM_THREAD_IDLE_GAP);
  }

  merged.allowed_ids = (merged.allowed_users && merged.allowed_users.length)
    ? merged.allowed_users.map(String)
    : (merged.chat_id ? [String(merged.chat_id)] : []);
  if (!merged.chat_id && merged.allowed_ids.length) merged.chat_id = merged.allowed_ids[0];
  merged.require_mention = Boolean(merged.require_mention);
  merged.ack = merged.ack !== false; // default ON — silence is opt-in
  if (!Number.isFinite(merged.thread_idle_gap_minutes) || merged.thread_idle_gap_minutes < 0) {
    merged.thread_idle_gap_minutes = DEFAULT_IDLE_GAP_MIN;
  }
  // Last, so the channel table sees the fully merged scalars (including the env
  // layer) when it synthesizes the legacy lane. A malformed table degrades to
  // that lane rather than throwing: this runs inside the comms auto-start hook,
  // where a throw would break every `agent start`.
  try {
    normalizeTelegramConfig(merged, e);
  } catch (err) {
    // Degrade to the legacy lane and keep the reason visible — normalize()
    // rewrites channel_errors, so the note is re-attached after the retry.
    merged.channels = [];
    merged.bots = [];
    merged.offsets = {};
    normalizeTelegramConfig(merged, e);
    merged.channel_errors = [
      `telegram: channel table could not be read (${err.message}) — using the legacy single-chat lane`,
    ];
  }
  return merged;
}

export async function run(ctx, args) {
  const { repoRoot } = ctx;
  // 'json' MUST be declared boolean here, or `--json` would swallow the next
  // argv token as its value.
  const flags = parseMemoryFlags(ctx.argv, ['once', 'json']);
  const action = args.name ? String(args.name) : '';
  const cfgPath = telegramConfigPath(repoRoot);
  const cfg = effectiveTelegramConfig(repoRoot);

  if (action === 'setup') {
    // Setup writes the RUNTIME file only — base it on the raw runtime state,
    // never on config-derived merged values (config.yaml stays the override).
    const next = { ...(readJsonFile(cfgPath) || {}) };
    const botId = flags.bot ? String(flags.bot).trim().toLowerCase() : '';
    const laneId = flags.lane ? String(flags.lane).trim().toLowerCase() : '';
    if (botId && !LANE_ID_RE.test(botId)) {
      throw new SidekicksError(`agent telegram setup: --bot '${botId}' must be lowercase letters/digits/hyphens`, EXIT_VALIDATION);
    }
    if (laneId && !LANE_ID_RE.test(laneId)) {
      throw new SidekicksError(`agent telegram setup: --lane '${laneId}' must be lowercase letters/digits/hyphens (it becomes the agent name '${RELAY_PREFIX}${laneId}')`, EXIT_VALIDATION);
    }
    if (flags.token && botId) {
      // A named bot keeps its token in the bots table, not the scalar.
      const bots = Array.isArray(next.bots) ? next.bots.map((b) => ({ ...b })) : [];
      const bi = bots.findIndex((b) => String(b.id) === botId);
      if (bi >= 0) bots[bi].bot_token = String(flags.token);
      else bots.push({ id: botId, bot_token: String(flags.token) });
      next.bots = bots;
    } else if (flags.token) {
      next.bot_token = String(flags.token);
    }
    if (laneId) {
      // Merge BY LANE KEY — a blind spread would make the second lane's setup
      // wipe the first.
      const chans = Array.isArray(next.channels) ? next.channels.map((c) => ({ ...c })) : [];
      const ci = chans.findIndex((c) => String(c.id).trim().toLowerCase() === laneId);
      const row = ci >= 0 ? chans[ci] : { id: laneId };
      if (botId) row.bot = botId;
      if (flags.chat) row.chat = String(flags.chat);
      if (flags.topic) row.topic = String(flags.topic);
      if (flags.target) row.target = String(flags.target);
      if (ci >= 0) chans[ci] = row; else chans.push(row);
      next.channels = chans;
    } else {
      if (flags.chat) next.chat_id = String(flags.chat);
      if (flags.target) next.default_target = String(flags.target);
    }
    const anyToken = next.bot_token || cfg.bot_token || (next.bots || []).some((b) => b.bot_token);
    if (!anyToken) {
      // cfg is the effective merge — a bot_token in root config.yaml satisfies setup too.
      throw new SidekicksError(
        'agent telegram setup: --token <bot-token> is required (create a bot with @BotFather), or set telegram.bot_token in .sidekicks/config.yaml',
        EXIT_VALIDATION
      );
    }
    writeJsonFile(repoRoot, cfgPath, next);
    const lines = [`telegram relay configured (${relative(repoRoot, cfgPath)} — git-ignored)`];
    if (laneId) {
      const row = next.channels.find((c) => String(c.id).trim().toLowerCase() === laneId);
      lines.push(
        `  lane:           ${laneId} → ${row.target || cfg.default_target || 'master'}  (mailbox ${laneId === cfg.default_channel_id ? RELAY : RELAY_PREFIX + laneId})`,
        `  bot:            ${row.bot || '(single configured bot)'}`,
        `  chat id:        ${row.chat || '(unset — message the bot once; the reply shows the id)'}${row.topic ? `  topic ${row.topic}` : ''}`,
        `  lanes total:    ${next.channels.length}`
      );
    } else {
      lines.push(
        `  bot token:      ${String(next.bot_token || cfg.bot_token || '').slice(0, 8)}… (${next.bot_token ? 'stored' : 'from config.yaml'})`,
        `  chat id:        ${next.chat_id || cfg.chat_id || '(unset — message the bot once; the reply shows the id)'}`,
        `  default target: ${next.default_target || cfg.default_target || 'master'}`
      );
      if (Array.isArray(cfg.channels) && cfg.channels.length > 1) {
        lines.push('  note:           a channels: table is in effect — these scalars apply only to the default lane');
      }
    }
    lines.push('', 'Start the relay: sidekicks agent telegram serve', '');
    return { stdout: lines.join('\n'), exitCode: EXIT_OK };
  }

  if (action === 'status') {
    const rootTg = readRootMessagingConfig(repoRoot).telegram || {};
    const envAll = { ...readEnvFile(repoRoot), ...process.env };
    const autoRestart = envAll.TELEGRAM_AUTO_RESTART != null && envAll.TELEGRAM_AUTO_RESTART !== ''
      ? TRUTHY.has(String(envAll.TELEGRAM_AUTO_RESTART).toLowerCase())
      : (rootTg.auto_restart === true || TRUTHY.has(String(rootTg.auto_restart ?? '').toLowerCase()));

    if (flags.json) {
      // The machine-readable surface the agent tray consumes instead of
      // re-parsing config.yaml in Python. It carries NO bot token, ever — this
      // output lands in logs and process listings.
      return {
        stdout: JSON.stringify({
          configured: Boolean(cfg.bot_token),
          auto_restart: autoRestart,
          control_stage: readControlStage(repoRoot, RELAY) || 'running',
          default_target: cfg.default_target || 'master',
          default_channel_id: cfg.default_channel_id || null,
          errors: cfg.channel_errors || [],
          warnings: cfg.channel_warnings || [],
          bots: cfg.bots.map((b) => ({
            id: b.id,
            username: b.username || null,
            token_configured: Boolean(b.bot_token),
            offset: Number.isInteger(cfg.offsets?.[b.id]) ? cfg.offsets[b.id] : null,
          })),
          channels: cfg.channels.map((c) => ({
            id: c.id,
            bot: c.bot,
            chat_id: c.chat,
            topic_id: c.topic == null ? null : Number(c.topic),
            target: c.target,
            relay_agent: c.relay,
            chat_out: c.chat_out || null,
            default: Boolean(c.default),
            scoped_allow_list: Boolean(c.allowed_ids?.length),
          })),
        }, null, 2) + '\n',
        exitCode: EXIT_OK,
      };
    }

    const out = [
      `configured: ${cfg.bot_token ? 'yes' : 'no'}`,
      `allowed:    ${cfg.allowed_ids && cfg.allowed_ids.length ? cfg.allowed_ids.join(', ') : '(none yet)'}`,
      `mention:    ${cfg.require_mention ? 'required in groups' : 'not required'}`,
      `ack:        ${cfg.ack ? 'on (routing is acknowledged in the chat)' : 'off (silent routing)'}`,
      `idle gap:   ${cfg.thread_idle_gap_minutes} min (a longer silence starts a new conversation; /new forces one)`,
      `auto-start: ${autoRestart ? 'on' : 'off'}   control gate: ${readControlStage(repoRoot, RELAY) || 'running'}`,
      '',
      `bots (${cfg.bots.length}):`,
      ...cfg.bots.map((b) => `  ${b.id}${b.bot_token ? '' : '  (NO TOKEN — its lanes are inbound-dead)'}   offset ${cfg.offsets?.[b.id] ?? '(none)'}`),
      '',
      `lanes (${cfg.channels.length}):`,
      ...cfg.channels.map((c) => [
        `  ${c.id}${c.default ? ' *' : ''}`,
        `bot ${c.bot}`,
        `chat ${c.chat}${c.topic != null ? ` topic ${c.topic}` : ''}`,
        `→ ${c.target}`,
        `mailbox ${c.relay}${readCharter(repoRoot, c.relay) ? '' : ' (auto-created on first serve)'}`,
        ...(c.allowed_ids?.length ? [`allow ${c.allowed_ids.join(',')}`] : []),
      ].join('   ')),
    ];
    if ((cfg.channel_warnings || []).length) out.push('', 'warnings:', ...cfg.channel_warnings.map((w) => `  ${w}`));
    if ((cfg.channel_errors || []).length) out.push('', 'ERRORS (serve will refuse to start):', ...cfg.channel_errors.map((e) => `  ${e}`));
    out.push('');
    return { stdout: out.join('\n'), exitCode: EXIT_OK };
  }

  if (action !== 'serve') {
    throw new SidekicksError(
      "agent telegram: an action is required — one of: setup, status, serve",
      EXIT_VALIDATION
    );
  }

  // ── serve ────────────────────────────────────────────────────────────────
  if (!cfg.bot_token) {
    throw new SidekicksError(
      "agent telegram serve: not configured — run 'sidekicks agent telegram setup --token <bot-token>' first",
      EXIT_VALIDATION
    );
  }
  // A malformed channel table is fatal HERE (and only here): `status` reports it
  // and the comms hook degrades, but serving half a routing table would send
  // someone's work to the wrong orchestrator.
  for (const line of cfg.channel_warnings || []) process.stderr.write(`telegram relay: ${line}\n`);
  if ((cfg.channel_errors || []).length) {
    throw new SidekicksError(
      ['agent telegram serve: the channel table is invalid —', ...cfg.channel_errors.map((e) => `  ${e}`)].join('\n'),
      EXIT_VALIDATION
    );
  }
  // Every lane's relay mailbox must exist BEFORE the first update is processed:
  // inbound now sends `--from=telegram-<lane>` and send.mjs refuses an unknown
  // charter. The legacy `telegram` mailbox is always created too, so a config
  // migration never strands an in-flight reply.
  await ensureRelayAgent(repoRoot);
  ensureRuntimeTree(repoRoot, RELAY);
  for (const ch of cfg.channels) {
    await ensureRelayAgent(repoRoot, ch.relay, ch.id);
    ensureRuntimeTree(repoRoot, ch.relay);
  }

  // An explicit serve clears a stale stop gate (same reasoning as
  // scheduler.mjs) — otherwise a previous `agent stop telegram` would make the
  // relay exit on its first pass with no explanation.
  if (readControlStage(repoRoot, RELAY) === 'stop') writeControlStage(repoRoot, RELAY, 'running');

  // EXCLUSIVE claim, not a bare write. Telegram allows exactly one poller per
  // token, and the old writePidFile let a second relay overwrite the first's
  // record — orphaning a live process the tray could no longer reach.
  const claim = acquirePidFile(repoRoot, 'telegram', process.pid);
  if (!claim.ok) {
    throw new SidekicksError(
      `agent telegram serve: already running (pid ${claim.pid}) — stop it with 'sidekicks agent telegram stop' or the agent tray`,
      EXIT_VALIDATION
    );
  }
  const pidPath = pidFilePath(repoRoot, 'telegram');
  const dropPidFile = () => {
    // Only if it still names us — never delete a successor's claim.
    try {
      const rec = readJsonFile(pidPath);
      if (rec && rec.pid === process.pid) unlinkSync(pidPath);
    } catch { /* best-effort */ }
  };
  let stopRequested = false;
  const onSignal = () => { stopRequested = true; dropPidFile(); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // The bot token is embedded in every api.telegram.org URL — scrub EVERY
  // configured token from any line we print, so a transport error echoing bot
  // 2's URL cannot leak bot 2's token into the git-ignored telegram.log.
  const tokens = cfg.bots.map((b) => b.bot_token).filter(Boolean);
  const redact = (s) => {
    let out = String(s);
    for (const t of tokens) out = out.split(t).join('***');
    return out;
  };

  const session = `tg-${Date.now()}`;
  const once = Boolean(flags.once);
  const defaultBotId = cfg.channels.find((c) => c.default)?.bot || cfg.bots[0].id;

  // One transport per bot, each with its own cursor and its own failure state:
  // a revoked token or a sticky 409 on one bot must not stall the others.
  const botStates = cfg.bots.map((b) => {
    const api = b.bot_token ? tgApi(b.bot_token) : null;
    if (api) api.log = (line) => process.stdout.write(`telegram relay[${b.id}]: ${redact(line)}\n`);
    return {
      id: b.id,
      api,
      offset: Number.isInteger(cfg.offsets?.[b.id]) ? cfg.offsets[b.id] : null,
      username: null,
      disabled: !b.bot_token,
      backoffMs: 0,
      nextAttempt: 0,
      failed: false,
    };
  });
  for (const st of botStates) {
    if (st.disabled) process.stderr.write(`telegram relay: bot '${st.id}' has no token — its lanes are inbound-dead until one is configured\n`);
  }

  // Bot username feeds the require_mention gate (group chats). Best-effort:
  // without it, mention-gated group messages are ignored until getMe works.
  await Promise.allSettled(botStates.map(async (st) => {
    if (!st.api) return;
    try {
      const me = await st.api.getMe();
      if (me.username) st.username = me.username;
    } catch (err) {
      process.stderr.write(redact(`telegram relay: getMe failed for bot '${st.id}' (${err.message}) — group @mention matching disabled there\n`));
    }
  }));
  if (botStates.length === 1 && botStates[0].username) cfg.bot_username = botStates[0].username;

  /**
   * Persist one bot's cursor. Read-modify-write in ONE synchronous block: the
   * per-bot polls run concurrently, and an interleaved await here would let two
   * bots clobber each other's offset — which re-delivers old updates as
   * DUPLICATE TASKS, the worst failure this file can produce. Offsets only ever
   * move forward.
   */
  const persistOffset = (botId, next) => {
    const patch = advanceOffsets(readJsonFile(cfgPath) || {}, botId, next, defaultBotId);
    if (patch) writeJsonFile(repoRoot, cfgPath, patch);
  };

  const pollBot = async (st) => {
    st.failed = false;
    if (st.disabled || !st.api) return;
    if (st.nextAttempt && Date.now() < st.nextAttempt) return;
    try {
      const updates = await st.api.getUpdates(st.offset, once ? 0 : 50);
      const maxId = await processUpdates(repoRoot, cfg, updates, st.api, { id: st.id, username: st.username });
      if (maxId != null) {
        st.offset = maxId + 1;
        persistOffset(st.id, st.offset);
      }
      st.backoffMs = 0;
      st.nextAttempt = 0;
    } catch (err) {
      st.failed = true;
      const msg = err.message || String(err);
      // A rejected token never recovers on its own — retrying it every second is
      // pure log noise. Say so once and stand the bot down for this process.
      if (/\b(401|404)\b/.test(msg) || /unauthorized|not found/i.test(msg)) {
        st.disabled = true;
        process.stderr.write(redact(`telegram relay: bot '${st.id}' rejected the token (${msg}) — disabled for this process; fix the token and restart\n`));
        return;
      }
      process.stderr.write(redact(`telegram relay: bot '${st.id}': ${msg}\n`));
      if (/Conflict/i.test(msg)) {
        // An operator problem, not a transient blip — name the fix instead of
        // letting the same line scroll forever.
        process.stderr.write(
          `telegram relay: another relay is polling bot '${st.id}' — stop the duplicate instance ` +
            "(check 'sidekicks agent telegram status' / the telegram pid file on every machine sharing the token); "
            + "this bot's inbound messages are being split between instances — outbound replies still post from here\n"
        );
      }
      st.backoffMs = Math.min(st.backoffMs ? st.backoffMs * 2 : 5000, 30000);
      st.nextAttempt = Date.now() + st.backoffMs;
    }
  };

  // Outbound runs as a SIBLING of the poll set, never behind it: a non-`--once`
  // poll blocks for up to 50s, so draining after the polls would hold every
  // reply hostage to the slowest bot.
  const drainLanes = async () => {
    for (const ch of cfg.channels) {
      const st = botStates.find((b) => b.id === ch.bot);
      if (!st || !st.api || st.disabled) continue;
      try {
        await relayInbox(repoRoot, cfg, st.api, session, ch);
      } catch (err) {
        process.stderr.write(redact(`telegram relay: outbound drain for lane '${ch.id}' failed (${err.message}) — retrying next pass\n`));
      }
    }
  };

  const laneList = cfg.channels
    .map((c) => `${c.id}→${c.target}${c.topic != null ? ` (topic ${c.topic})` : ''}`)
    .join(', ');
  process.stdout.write(
    `telegram relay online — ${cfg.bots.length} bot(s), ${cfg.channels.length} lane(s): ${laneList || '(none)'} — Ctrl-C to stop\n`
  );

  let lastPresence = 0;
  try {
    for (;;) {
      if (stopRequested) {
        process.stdout.write('telegram relay: signal received — shutting down\n');
        return { stdout: '', exitCode: EXIT_OK };
      }
      // A deliberate `agent stop telegram` is a REAL stop now, not just
      // suppression of the comms hook's auto-restart.
      if (readControlStage(repoRoot, RELAY) === 'stop') {
        process.stdout.write('telegram relay: control stop — shutting down\n');
        return { stdout: '', exitCode: EXIT_OK };
      }
      // If the pid file has come to name a different LIVE process, that relay
      // owns the token now — yield rather than fight it into a 409 standoff.
      const rec = readJsonFile(pidPath);
      if (rec && rec.pid && rec.pid !== process.pid && isProcessAlive(rec.pid)) {
        process.stdout.write(`telegram relay: pid file now names live pid ${rec.pid} — yielding\n`);
        return { stdout: '', exitCode: EXIT_OK };
      }

      // Presence heartbeat for every lane mailbox — throttled, because the TTL
      // is 900s and N lanes × one write per pass is pointless disk churn.
      if (Date.now() - lastPresence > 60_000) {
        lastPresence = Date.now();
        for (const name of relayAgentNames(cfg)) {
          writePresence(repoRoot, name, {
            session_id: session, state: 'standby', task: null, heartbeat_at: bangkokTimestamp(),
          });
        }
      }

      await Promise.allSettled([...botStates.map((st) => pollBot(st)), drainLanes()]);

      if (once) return { stdout: 'telegram relay: single pass done\n', exitCode: EXIT_OK };
      await sleep(botStates.some((st) => st.failed) ? 5000 : 1000);
    }
  } finally {
    dropPidFile();
  }
}
