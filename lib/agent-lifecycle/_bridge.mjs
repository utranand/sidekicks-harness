// lib/agent-lifecycle/_bridge.mjs
// Shared helpers for the network bridge verbs (`agent serve`, `agent bridge`,
// `agent telegram`) — NOT a dispatchable verb.
//
// Bridge state lives at .sidekicks/agents/.bridge/runtime/ — inside the
// git-ignored `agents/*/runtime/` pattern, and invisible to the roster scan
// (no agent.yaml). Nothing here is ever committed: the bearer token and the
// Telegram bot token are machine-local secrets.
//
// Security model (local-network messenger):
//   - every HTTP request must carry the bearer token (401 otherwise);
//   - every remote address must be loopback or a private-range IP (403
//     otherwise) — the bridge REFUSES public-internet peers by construction.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirp, writeSecretAtomic, tightenSecretMode } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
import { agentsRoot } from './_shared.mjs';

export function bridgeRuntimeDir(repoRoot) {
  return join(agentsRoot(repoRoot), '.bridge', 'runtime');
}

export function bridgeConfigPath(repoRoot) {
  return join(bridgeRuntimeDir(repoRoot), 'bridge.json');
}

export function telegramConfigPath(repoRoot) {
  return join(bridgeRuntimeDir(repoRoot), 'telegram.json');
}

export function briefsDir(repoRoot) {
  return join(bridgeRuntimeDir(repoRoot), 'briefs');
}

export function readJsonFile(absPath) {
  if (!existsSync(absPath)) return null;
  // Repair on read: a repo that already has a world-readable bridge.json from before the
  // owner-only writer existed would otherwise keep it until the file happened to be rewritten.
  // Best-effort and silent — a permissions repair must never break the read it rode in on.
  tightenSecretMode(absPath, { privateDir: true });
  try {
    return JSON.parse(readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write a bridge runtime file, owner-only.
 *
 * Everything under .bridge/runtime/ is private: bridge.json carries the LAN bearer token,
 * telegram.json the bot credentials, and the rest is per-machine agent state. They were written
 * at the umask default (0644 in a 0755 directory), so any other local account could read the
 * token that grants mailbox read/send authority. Git-ignore was never the control that mattered
 * here — this is.
 */
export function writeJsonFile(repoRoot, absPath, obj) {
  assertWritable(absPath, repoRoot);
  // privateDir: .bridge/runtime/ holds ONLY the bearer token, bot credentials and private
  // per-machine agent state — there is no shared or committed file in it to lock away.
  writeSecretAtomic(absPath, JSON.stringify(obj, null, 2) + '\n', { privateDir: true });
}

/**
 * Read the ROOT project config's messaging blocks (`bridge:`, `telegram:`)
 * from .sidekicks/config.yaml. Agents are a repo-level (root) surface, so the
 * bridge always reads root config — never a project's.
 *
 * Whole-file parse first; on failure fall back to slicing each needed
 * column-0 block out of the raw text and parsing it independently — real
 * config.yaml files carry full-YAML constructs (flow arrays etc.) in
 * unrelated blocks that yaml-subset rejects, and that must not silently
 * disable messaging config (same pattern as scripts/run-notify-hook.mjs).
 *
 * `agent_daemon` is the delegate PACEMAKER block (lib/agent-lifecycle/_pacemaker.mjs)
 * — the per-lane clock that replaces a cron mission-tick routine.
 *
 * @returns {{ bridge: object, telegram: object, scheduler: object, office: object, agent_daemon: object }}
 */
export function readRootMessagingConfig(repoRoot) {
  const out = { bridge: {}, telegram: {}, scheduler: {}, office: {}, agent_daemon: {} };

  // The family files come first: after `sidekicks config migrate`, bridge/scheduler/office/agent_daemon
  // live in .sidekicks/config/agents.yaml and telegram in config/comms.yaml, with its bot_token in the
  // git-ignored comms.secret.yaml. A scope whose monolith has been pruned resolves only from these.
  //
  // WHY THIS READS THE FILES ITSELF INSTEAD OF CALLING lib/config-store/read.mjs: the store's reader is
  // deliberately more tolerant than lib/yaml-subset, and the tolerance changes answers this subsystem
  // pins on purpose — an unparseable `agent_daemon` block must stay EMPTY (a half-read pacemaker lane
  // is worse than none), and a flow-form channel table must be REJECTED rather than guessed at. So the
  // parser stays yaml-subset here; only the set of files widens.
  for (const { file, blocks } of [
    { file: join(repoRoot, '.sidekicks', 'config', 'agents.secret.yaml'), blocks: ['bridge', 'scheduler', 'office', 'agent_daemon'] },
    { file: join(repoRoot, '.sidekicks', 'config', 'agents.yaml'), blocks: ['bridge', 'scheduler', 'office', 'agent_daemon'] },
    { file: join(repoRoot, '.sidekicks', 'config', 'comms.secret.yaml'), blocks: ['telegram'] },
    { file: join(repoRoot, '.sidekicks', 'config', 'comms.yaml'), blocks: ['telegram'] },
  ]) {
    if (!existsSync(file)) continue;
    const found = readBlocksFrom(file, blocks);
    for (const [key, value] of Object.entries(found)) {
      out[key] = Object.keys(out[key]).length ? fillMissingDeep(out[key], value) : value;
    }
  }

  // The legacy monolith, below the family files: a scope part-way through `config migrate` must
  // resolve exactly what it did before the split.
  const legacy = join(repoRoot, '.sidekicks', 'config.yaml');
  if (existsSync(legacy)) {
    const found = readBlocksFrom(legacy, Object.keys(out));
    for (const [key, value] of Object.entries(found)) {
      out[key] = Object.keys(out[key]).length ? fillMissingDeep(out[key], value) : value;
    }
  }
  return out;
}

/**
 * Read the named top-level blocks out of one config file.
 *
 * Whole-file parse first; on failure fall back to slicing each needed column-0 block out of the raw
 * text and parsing it independently — real config files carry full-YAML constructs (flow arrays etc.)
 * in unrelated blocks that yaml-subset rejects, and that must not silently disable messaging config
 * (same pattern as scripts/run-notify-hook.mjs).
 *
 * A block that is itself unparseable is OMITTED, never half-read: for the pacemaker a partially read
 * lane is worse than an absent one.
 *
 * @param {string} file
 * @param {string[]} blocks
 * @returns {Record<string, object>} only the blocks actually found
 */
function readBlocksFrom(file, blocks) {
  /** @type {Record<string, object>} */
  const found = {};
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return found; }
  let whole = null;
  try { whole = yaml.parse(text); } catch { /* full-YAML constructs — slice below */ }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (const key of blocks) {
    if (whole && typeof whole === 'object' && whole[key] && typeof whole[key] === 'object') {
      found[key] = whole[key];
      continue;
    }
    // Slice fallback — used both when the whole-file parse THREW and when it succeeded but dropped
    // this block (yaml-subset silently truncates the document after some constructs, e.g. a sequence
    // at the same indent as its sibling keys), so a missing key alone triggers it.
    const start = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (start === -1) continue;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^[A-Za-z_][\w-]*:/.test(lines[i])) { end = i; break; }
    }
    try {
      const slice = yaml.parse(lines.slice(start, end).join('\n'));
      if (slice && typeof slice === 'object' && slice[key]) found[key] = slice[key];
    } catch { /* this block itself is unparseable — leave it out */ }
  }
  return found;
}

/**
 * Fill what `target` lacks from `source`, recursively; an empty string or null in `target` counts as
 * missing, because the committed family file keeps `bot_token: ""` as a placeholder so a fresh clone
 * can see what it must supply.
 *
 * DEEP on purpose: a shallow merge would let `comms.secret.yaml`'s `telegram` mapping replace the
 * committed one outright, dropping every non-secret key beside the token.
 *
 * @param {object} target - mutated and returned
 * @param {object} source
 * @returns {object}
 */
function fillMissingDeep(target, source) {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    const bothMappings = existing && typeof existing === 'object' && !Array.isArray(existing)
      && value && typeof value === 'object' && !Array.isArray(value);
    if (bothMappings) { fillMissingDeep(existing, value); continue; }
    const absent = !Object.prototype.hasOwnProperty.call(target, key);
    if (absent || ((existing === '' || existing === null) && value !== '' && value !== null)) {
      target[key] = value;
    }
  }
  return target;
}

/**
 * Parse the git-ignored repo-root `.env` file (KEY=VALUE lines; # comments and
 * blank lines skipped; surrounding quotes stripped). Returns {} when absent.
 */
export function readEnvFile(repoRoot) {
  const p = join(repoRoot, '.env');
  let text;
  try { text = readFileSync(p, 'utf8'); } catch { return {}; }
  const out = {};
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Mint a URL-safe bearer token (32 hex chars — 128 bits). */
export function newBridgeToken() {
  return randomBytes(16).toString('hex');
}

/**
 * Constant-time check of an `Authorization` header against the expected bearer.
 * A plain `===` short-circuits on the first mismatching byte, leaking timing;
 * the token is 128-bit so this is belt-and-suspenders, but cheap. Unequal
 * lengths return false without a timingSafeEqual call (it throws on a length
 * mismatch — and the expected length is not a secret).
 */
export function bearerMatches(authHeader, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(String(authHeader || ''));
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

/** Mask a secret for display/logs: first 4 + last 2 chars, or `***` if short. */
export function maskToken(t) {
  const s = String(t || '');
  return s.length <= 8 ? '***' : `${s.slice(0, 4)}…${s.slice(-2)}`;
}

// Inbound-brief retention: each remote/telegram body is persisted as one file
// under briefs/. Cap the directory so an authorized peer cannot fill the disk
// with long bodies — the newest KEEP survive (they map to recent/live tasks;
// the pruned ones belong to long-finished messages).
export const MAX_BRIEF_FILES = 1000;

/** Prune the briefs dir to the newest `keep` files (by mtime). Best-effort. */
export function pruneBriefsDir(repoRoot, keep = MAX_BRIEF_FILES) {
  const dir = briefsDir(repoRoot);
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  const files = names.filter((f) => f.endsWith('.md'));
  if (files.length <= keep) return 0;
  const withTime = files.map((f) => {
    let mt = 0;
    try { mt = statSync(join(dir, f)).mtimeMs; } catch { /* vanished — treat as oldest */ }
    return { f, mt };
  }).sort((a, b) => a.mt - b.mt);
  let removed = 0;
  for (const { f } of withTime.slice(0, files.length - keep)) {
    try { rmSync(join(dir, f)); removed++; } catch { /* best-effort */ }
  }
  return removed;
}

/**
 * Load the persisted bridge token, minting + persisting one on first use.
 */
export function ensureBridgeToken(repoRoot) {
  const p = bridgeConfigPath(repoRoot);
  const cfg = readJsonFile(p) || {};
  if (cfg.token && typeof cfg.token === 'string') return cfg.token;
  const token = newBridgeToken();
  writeJsonFile(repoRoot, p, { ...cfg, token });
  return token;
}

/**
 * Is `addr` a loopback or private-network address? The bridge serves the
 * LOCAL network only — anything else is refused. Handles IPv4, IPv6, and
 * IPv4-mapped IPv6 (`::ffff:192.168.1.7`).
 *
 * Private/loopback ranges accepted:
 *   127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
 *   ::1, fe80::/10 (link-local), fc00::/7 (unique-local)
 */
export function isPrivateAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7); // IPv4-mapped IPv6
  if (a === '::1') return true;
  if (a.includes(':')) {
    // IPv6: link-local fe80::/10, unique-local fc00::/7
    return /^fe[89ab]/.test(a) || /^f[cd]/.test(a);
  }
  const parts = a.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [o1, o2] = parts;
  if (o1 === 127 || o1 === 10) return true;
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
  if (o1 === 192 && o2 === 168) return true;
  if (o1 === 169 && o2 === 254) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Daemon pidfiles (comms liveness — telegram relay + LAN bridge)
// ---------------------------------------------------------------------------

export function pidFilePath(repoRoot, daemon) {
  return join(bridgeRuntimeDir(repoRoot), `${daemon}.pid.json`);
}

/** Is a pid alive? signal-0 probe — works on macOS, Linux, and Windows. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM'; // alive but not ours
  }
}

/** Record a daemon's pid (called by the daemon itself and by the auto-starter). */
export function writePidFile(repoRoot, daemon, pid) {
  writeJsonFile(repoRoot, pidFilePath(repoRoot, daemon), { pid, written_at: new Date().toISOString() });
}

/** Is the named comms daemon running? (pidfile present AND pid alive) */
export function isDaemonRunning(repoRoot, daemon) {
  const rec = readJsonFile(pidFilePath(repoRoot, daemon));
  return Boolean(rec && isProcessAlive(rec.pid));
}

/**
 * Atomically claim a daemon's pid file — the mutual-exclusion lock that keeps
 * two copies of the same daemon (e.g. two delegate runners for one agent,
 * started from different terminals/apps) from running together. A plain
 * read-check-then-write pair is a TOCTOU race: two claimants can both see "no
 * file" and both write. This uses an exclusive create (`wx` — fails with
 * EEXIST if the file appears between the read and the write), so exactly one
 * claimant wins.
 *
 * Returns { ok: true } when `pid` now owns the file, else
 * { ok: false, pid: <live owner> }. A pre-existing file already naming `pid`
 * (the provisional stamp `agent start --headless` writes for the child it
 * spawned) counts as owned; a file naming a dead pid is stale and reclaimed.
 */
export function acquirePidFile(repoRoot, daemon, pid = process.pid) {
  const p = pidFilePath(repoRoot, daemon);
  const body = JSON.stringify({ pid, written_at: new Date().toISOString() }, null, 2) + '\n';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rec = readJsonFile(p);
    if (rec && rec.pid === pid) return { ok: true };
    if (rec && isProcessAlive(rec.pid)) return { ok: false, pid: rec.pid };
    if (existsSync(p)) {
      // Stale (dead pid) or unparseable — clear it so the exclusive create
      // below can decide the winner.
      try { rmSync(p, { force: true }); } catch { /* raced — resolved below */ }
    }
    try {
      assertWritable(p, repoRoot);
      mkdirp(join(p, '..'));
      writeFileSync(p, body, { flag: 'wx' });
      return { ok: true };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      // Lost the create race — loop once to read who won.
    }
  }
  const winner = readJsonFile(p);
  return { ok: false, pid: winner ? winner.pid : null };
}

/**
 * Read a request body (bounded) and parse as JSON.
 * @returns {Promise<object>} rejects on oversize or bad JSON.
 */
export function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) { resolve({}); return; }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Write a JSON response. */
export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2) + '\n';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
