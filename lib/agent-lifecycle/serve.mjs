// lib/agent-lifecycle/serve.mjs
// `sidekicks agent serve [--port 7787] [--bind 0.0.0.0] [--token <t>]`
//
// The local-network agent messenger: a zero-dependency HTTP bridge that lets
// OTHER terminals on the same private network read the roster and drop
// messages into agent mailboxes. Every write goes through the same mediated
// path as a local `agent send` (send.run — category contract, cycle guard,
// portable paths all enforced identically).
//
// Security (both checks on every request, no opt-out):
//   1. Bearer token — minted + persisted on first run at
//      .sidekicks/agents/.bridge/runtime/bridge.json (git-ignored);
//      requests without `Authorization: Bearer <token>` get 401.
//   2. Private-network-only — a remote address outside loopback/RFC1918/
//      link-local/ULA ranges gets 403. The bridge is a LAN messenger by
//      construction, never an internet-facing API.
//
// Endpoints (JSON):
//   GET  /v1/list                     roster (agentStatusRow per agent)
//   GET  /v1/agents/<name>            one agent's status row + control stage
//   GET  /v1/agents/<name>/inbox      ?state=new|claimed|done (default new)
//   POST /v1/send                     {to, from, kind?, category?, goal?,
//                                      acceptance?, work_dir?, isolation?,
//                                      priority?, reply_to?, body?}
//     `body` (inline long brief) is written to a git-ignored brief file and
//     passed as --body-file, so remote senders need no repo write access.
//
// The verb runs until Ctrl-C — run() intentionally never resolves.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join, relative } from 'node:path';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import {
  parseMemoryFlags,
  bangkokTimestamp,
  listAgentNames,
  agentStatusRow,
  readControlStage,
  listMessageIds,
  readMessage,
  INBOX_STATES,
} from './_shared.mjs';
import {
  ensureBridgeToken,
  isPrivateAddress,
  bearerMatches,
  maskToken,
  readJsonBody,
  sendJson,
  briefsDir,
  pruneBriefsDir,
  readRootMessagingConfig,
  writePidFile,
} from './_bridge.mjs';
import { run as sendRun } from './send.mjs';

const DEFAULT_PORT = 7787;

/** Persist an inline `body` as a git-ignored, repo-relative brief file. */
function writeBriefFile(repoRoot, text) {
  const dir = briefsDir(repoRoot);
  mkdirp(dir);
  const name = `brief-${bangkokTimestamp().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${Math.random().toString(16).slice(2, 6)}.md`;
  const abs = join(dir, name);
  assertWritable(abs, repoRoot);
  writeAtomic(abs, String(text));
  pruneBriefsDir(repoRoot); // cap disk use — newest briefs survive
  return relative(repoRoot, abs).replace(/\\/g, '/');
}

/** Build a send.run argv from a JSON payload (reuses ALL send validation). */
export function buildSendArgv(payload) {
  const p = payload || {};
  const argv = ['agent', 'send', String(p.to || '')];
  const flag = (k, v) => { if (v != null && v !== '') argv.push(`--${k}=${v}`); };
  flag('from', p.from);
  flag('kind', p.kind);
  flag('category', p.category);
  flag('goal', p.goal);
  const acc = Array.isArray(p.acceptance) ? p.acceptance.join(';') : p.acceptance;
  flag('acceptance', acc);
  flag('work-dir', p.work_dir);
  flag('isolation', p.isolation);
  flag('priority', p.priority);
  flag('reply-to', p.reply_to);
  // Conversation binding. This whitelist is a fixed allow-list, so an omission
  // here means the LAN bridge silently DROPS the field rather than erroring —
  // bridge conversations would get no memory while Telegram's did.
  flag('thread', p.thread_id);
  flag('origin', p.origin);
  flag('body-file', p.body_file);
  argv.push('--json');
  return argv;
}

/**
 * Handle one request. Exported for tests (no listening socket needed).
 * @returns {Promise<void>} always responds on `res`.
 */
export async function handleRequest(repoRoot, token, req, res) {
  const remote = req.socket?.remoteAddress || '';
  if (!isPrivateAddress(remote)) {
    sendJson(res, 403, { error: `refused: '${remote}' is not a private-network address — the bridge serves the local network only` });
    return;
  }
  const auth = String(req.headers['authorization'] || '');
  if (!bearerMatches(auth, token)) {
    sendJson(res, 401, { error: 'missing or invalid bearer token' });
    return;
  }

  const url = new URL(req.url || '/', 'http://bridge');
  const parts = url.pathname.split('/').filter(Boolean); // ['v1', ...]

  try {
    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'list' && parts.length === 2) {
      const rows = listAgentNames(repoRoot).map((n) => agentStatusRow(repoRoot, n));
      sendJson(res, 200, rows);
      return;
    }

    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts.length === 3) {
      const name = parts[2];
      if (!listAgentNames(repoRoot).includes(name)) {
        sendJson(res, 404, { error: `no agent named '${name}'` });
        return;
      }
      sendJson(res, 200, { ...agentStatusRow(repoRoot, name), control: readControlStage(repoRoot, name) });
      return;
    }

    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'agents' && parts[2] && parts[3] === 'inbox') {
      const name = parts[2];
      if (!listAgentNames(repoRoot).includes(name)) {
        sendJson(res, 404, { error: `no agent named '${name}'` });
        return;
      }
      const state = url.searchParams.get('state') || 'new';
      if (!INBOX_STATES.includes(state)) {
        sendJson(res, 400, { error: `invalid state '${state}' — one of: ${INBOX_STATES.join(', ')}` });
        return;
      }
      const msgs = listMessageIds(repoRoot, name, state).map((id) => readMessage(repoRoot, name, state, id)).filter(Boolean);
      sendJson(res, 200, msgs);
      return;
    }

    if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'send' && parts.length === 2) {
      const payload = await readJsonBody(req);
      if (payload.body && !payload.body_file) {
        payload.body_file = writeBriefFile(repoRoot, payload.body);
      }
      const argv = buildSendArgv(payload);
      const ctx = { repoRoot, argv, flags: {} };
      const result = await sendRun(ctx, { name: String(payload.to || '') });
      sendJson(res, 200, JSON.parse(result.stdout));
      return;
    }

    sendJson(res, 404, { error: `unknown endpoint ${req.method} ${url.pathname}` });
  } catch (err) {
    if (err instanceof SidekicksError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    sendJson(res, 400, { error: String(err && err.message ? err.message : err) });
  }
}

/** Enumerate this machine's private IPv4 addresses (for the startup banner). */
function privateIPv4s() {
  const out = [];
  const ifs = networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const i of list || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal && isPrivateAddress(i.address)) {
        out.push(i.address);
      }
    }
  }
  return out;
}

/** This machine's non-private (public) IPv4 addresses — a bind:0.0.0.0 warning. */
function publicIPv4s() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal && !isPrivateAddress(i.address)) {
        out.push(i.address);
      }
    }
  }
  return out;
}

/**
 * Resolve the effective serve options: flag > root config.yaml `bridge:` block
 * > built-in default (token: > persisted auto-minted). Exported for tests.
 */
export function resolveServeConfig(repoRoot, flags) {
  const cfg = readRootMessagingConfig(repoRoot).bridge || {};
  const rawPort = flags.port != null && flags.port !== '' ? flags.port : (cfg.port ?? DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new SidekicksError(`agent serve: invalid port '${rawPort}'`, EXIT_VALIDATION);
  }
  const bind = flags.bind ? String(flags.bind) : (cfg.bind ? String(cfg.bind) : '0.0.0.0');
  const token = flags.token
    ? String(flags.token)
    : (cfg.token ? String(cfg.token) : ensureBridgeToken(repoRoot));
  return { port, bind, token };
}

/**
 * Run `agent serve` — starts the HTTP bridge and blocks until Ctrl-C.
 */
export async function run(ctx) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, []);
  const { port, bind, token } = resolveServeConfig(repoRoot, flags);

  const server = createServer((req, res) => {
    handleRequest(repoRoot, token, req, res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, resolve);
  });
  writePidFile(repoRoot, 'bridge', process.pid); // comms liveness (auto-start hook)

  const hosts = bind === '0.0.0.0' ? privateIPv4s() : [bind];
  // Only print the token in the clear to an interactive terminal. When the
  // bridge is auto-started detached, stdout is redirected to the git-ignored
  // bridge.log — writing the full token there is needless plaintext-at-rest
  // (it already lives in bridge.json), so mask it and point at the source.
  const isTty = Boolean(process.stdout.isTTY);
  const warn = (bind === '0.0.0.0' && publicIPv4s().length)
    ? [`warning: this host has a public IP (${publicIPv4s().join(', ')}). The bridge binds all`,
       '  interfaces (bind 0.0.0.0) and refuses non-private peers by IP — but pin `bridge.bind`',
       '  to a private address in .sidekicks/config.yaml to avoid listening on the public one.',
       '']
    : [];
  const lines = isTty
    ? [
        `agent bridge serving on port ${port} (bind ${bind}) — local network only, Ctrl-C to stop`,
        `token: ${token}`,
        '',
        ...warn,
        'From another terminal on this network:',
        ...hosts.map((h) => `  sidekicks agent bridge list --host ${h}:${port} --token ${token}`),
        '',
        'Or with curl:',
        ...hosts.slice(0, 1).map((h) =>
          `  curl -s -H "Authorization: Bearer ${token}" -X POST http://${h}:${port}/v1/send \\\n` +
          `    -d '{"to":"steave","from":"remote","category":"development","goal":"..."}'`),
        '',
      ]
    : [
        `agent bridge serving on port ${port} (bind ${bind}) — local network only`,
        `token: ${maskToken(token)} (full token in .sidekicks/agents/.bridge/runtime/bridge.json)`,
        ...(hosts.length ? [`hosts: ${hosts.map((h) => `${h}:${port}`).join(', ')}`] : []),
        ...warn,
      ];
  process.stdout.write(lines.join('\n') + '\n');

  // Serve until the process is killed — never resolve (the dispatcher would
  // writeThenExit and tear the server down).
  return new Promise(() => {});
}
