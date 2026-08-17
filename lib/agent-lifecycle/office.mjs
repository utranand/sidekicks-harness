// lib/agent-lifecycle/office.mjs
// `sidekicks agent office [--port 4690] [--bind 127.0.0.1] [--once] [--json]
//                          [--replace] [--open]`
//
// A READ-ONLY live web dashboard over the persistent-agent office: one page
// showing roster + presence, the activity feed, open conversation threads,
// the dry-run plan approval gate, the fleet scheduler, and comms liveness —
// everything `agent list` / `agent thread list` / `agent scheduler status`
// otherwise require six separate commands to see.
//
// Security posture — deliberately the INVERSE of `agent serve`:
//   - loopback by default (127.0.0.1), so no token is needed for the common
//     case (a human on the same machine watching their own fleet);
//   - a non-loopback --bind (0.0.0.0, a LAN IP) mints/reuses the SAME bearer
//     token `agent serve` uses (.sidekicks/agents/.bridge/runtime/bridge.json)
//     — one secret to rotate, not two;
//   - every request is still private-address-gated (isPrivateAddress), same
//     as the LAN bridge — this never serves the public internet;
//   - the query-string `?token=` form exists ONLY because EventSource cannot
//     set an Authorization header; it is timing-safe-compared like the header.
//
// Never writes: no send, no claim, no charter edit — a pure projection of
// _office.mjs's collectors. `--once` prints the JSON snapshot and exits,
// which is what makes this scriptable (`sidekicks agent office --once | jq`).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { timingSafeEqual } from 'node:crypto';
import { rmSync } from 'node:fs';
import { SidekicksError, EXIT_OK, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { parseMemoryFlags, bangkokTimestamp } from './_shared.mjs';
import {
  ensureBridgeToken,
  isPrivateAddress,
  bearerMatches,
  maskToken,
  sendJson,
  readRootMessagingConfig,
  acquirePidFile,
  pidFilePath,
  isProcessAlive,
  readJsonFile,
} from './_bridge.mjs';
import { buildSnapshot, createOfficeWatcher } from './_office.mjs';

export const DEFAULT_PORT = 4690;
export const WATCH_DEBOUNCE_MS = 300;
export const POLL_MS = 15_000;
export const SSE_HEARTBEAT_MS = 25_000;
const DAEMON = 'office';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective office options: flag > root config.yaml `office:`
 * block > built-in default. Unlike `agent serve`, the token is loopback-aware:
 * a plain `sidekicks agent office` on localhost needs no secret at all — one
 * is only minted (or reused from the LAN bridge's own token) the moment the
 * bind address leaves loopback.
 */
export function resolveOfficeConfig(repoRoot, flags) {
  const cfg = readRootMessagingConfig(repoRoot).office || {};
  const rawPort = flags.port != null && flags.port !== '' ? flags.port : (cfg.port ?? DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new SidekicksError(`agent office: invalid --port '${rawPort}'`, EXIT_VALIDATION);
  }
  const bind = flags.bind ? String(flags.bind) : (cfg.bind ? String(cfg.bind) : '127.0.0.1');
  const loopback = LOOPBACK_HOSTS.has(bind);
  const token = flags.token
    ? String(flags.token)
    : (cfg.token ? String(cfg.token) : (loopback ? null : ensureBridgeToken(repoRoot)));
  return { port, bind, token };
}

// ---------------------------------------------------------------------------
// HTML shell (self-contained — no external assets, one embedded template)
// ---------------------------------------------------------------------------

/** Escape text for safe interpolation into the HTML template. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the single-page dashboard. BOOT is the initial snapshot, serialized
 * with every `<` escaped to `<` — the standard guard against a goal/
 * summary string containing `</script>` breaking out of the inline JSON
 * literal (the snapshot embeds arbitrary agent-authored text: goals,
 * summaries, plan titles).
 */
export function renderOfficeHTML(snapshot) {
  const boot = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sidekicks Agent Office</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --ink: #1b1f24; --muted: #6b7280;
    --border: #e2e5ea; --accent: #2563eb; --ok: #16a34a; --warn: #d97706; --bad: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0f1216; --panel: #171b21; --ink: #e6e9ee; --muted: #8b93a1; --border: #2a2f37; }
  }
  html[data-theme="dark"] {
    --bg: #0f1216; --panel: #171b21; --ink: #e6e9ee; --muted: #8b93a1; --border: #2a2f37;
  }
  html[data-theme="light"] {
    --bg: #f6f7f9; --panel: #ffffff; --ink: #1b1f24; --muted: #6b7280; --border: #e2e5ea;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 12px; padding: 10px 16px;
    border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 5;
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .spacer { flex: 1; }
  #live { font-size: 12px; color: var(--muted); }
  #gen-at { font-size: 12px; color: var(--muted); }
  select#theme-sel { font-size: 12px; }
  main { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 12px; padding: 12px 16px; }
  section.panel {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px; min-width: 0;
  }
  section.panel h2 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .row { border-bottom: 1px dashed var(--border); padding: 6px 0; }
  .row:last-child { border-bottom: none; }
  .card { display: flex; flex-direction: column; gap: 3px; }
  .card .top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .name { font-weight: 600; }
  .chip { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
  .dot.fresh { background: var(--ok); }
  .dot.stale { background: var(--warn); }
  .dot.offline { background: var(--muted); }
  .dot.on { background: var(--ok); }
  .dot.off { background: var(--muted); }
  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .broken { color: var(--bad); }
  code { font-size: 12px; background: var(--bg); padding: 1px 4px; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  table th, table td { text-align: left; padding: 3px 4px; border-bottom: 1px dashed var(--border); }
  ul.units { margin: 4px 0 0; padding-left: 18px; }
  .empty { color: var(--muted); font-style: italic; padding: 6px 0; }
</style>
</head>
<body>
<header>
  <h1>Sidekicks Agent Office</h1>
  <span id="gen-at"></span>
  <span id="live" hidden></span>
  <span class="spacer"></span>
  <select id="theme-sel" title="theme">
    <option value="auto">auto</option>
    <option value="light">light</option>
    <option value="dark">dark</option>
  </select>
</header>
<main>
  <section class="panel" id="roster"><h2>Roster</h2><div class="body"></div></section>
  <section class="panel" id="activity"><h2>Activity</h2><div class="body"></div></section>
  <section class="panel" id="threads"><h2>Conversations</h2><div class="body"></div></section>
  <section class="panel" id="plans"><h2>Plan gate</h2><div class="body"></div></section>
  <section class="panel" id="scheduler"><h2>Scheduler</h2><div class="body"></div></section>
  <section class="panel" id="comms"><h2>Comms</h2><div class="body"></div></section>
</main>
<script>
const BOOT = ${boot};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtAge(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
function fmtCountdown(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'expired';
  return fmtAge(-ms).replace(' ago', '') + ' left';
}
// Mirrors presenceState(presence, nowMs) in _shared.mjs: fresh within the TTL,
// stale past it but present, offline with no heartbeat at all.
function presenceClass(heartbeatAt, ttlMs) {
  if (!heartbeatAt) return 'offline';
  const age = Date.now() - Date.parse(heartbeatAt);
  if (Number.isNaN(age)) return 'offline';
  return age <= ttlMs ? 'fresh' : 'stale';
}

function renderRoster(data) {
  const ttl = data.presence_ttl_ms;
  if (!data.roster.length) return '<div class="empty">no agents yet</div>';
  return data.roster.map(function (a) {
    if (a.broken) {
      return '<div class="row card"><div class="top"><span class="name broken">' + esc(a.name) +
        '</span><span class="chip broken">broken</span></div><div class="small muted">' + esc(a.error) + '</div></div>';
    }
    const cls = presenceClass(a.heartbeat_at, ttl);
    const age = a.heartbeat_at ? fmtAge(Date.now() - Date.parse(a.heartbeat_at)) : 'offline';
    const task = a.current_task
      ? '<div class="small">working: ' + esc(a.current_task.goal || '(no goal)') + '</div>'
      : '';
    const delegate = a.delegate
      ? '<div class="small muted">delegate <span class="dot ' + (a.delegate.running ? 'on' : 'off') + '"></span>' +
        (a.delegate.running ? 'running' : 'stopped') +
        ' · last wake ' + esc(a.delegate.last_wake_tokens ?? '?') + 'tok / ctx ' + esc(a.delegate.last_context_tokens ?? '?') + 'tok' +
        (a.delegate.consecutive_failures ? ' · ' + a.delegate.consecutive_failures + ' failure(s)' : '') +
        '</div>'
      : '';
    return '<div class="row card">' +
      '<div class="top"><span class="dot ' + cls + '"></span><span class="name">' + esc(a.name) + '</span>' +
      (a.role ? '<span class="chip">' + esc(a.role) + '</span>' : '') +
      (a.model ? '<span class="chip">' + esc(a.model) + '</span>' : '') +
      (a.cli ? '<span class="chip">' + esc(a.cli) + '</span>' : '') +
      '<span class="chip">' + esc(a.control) + '</span>' +
      '<span class="small muted">' + esc(age) + '</span></div>' +
      '<div class="small muted">inbox new ' + a.inbox.new + ' · claimed ' + a.inbox.claimed + ' · done ' + a.inbox.done + '</div>' +
      task + delegate +
      '</div>';
  }).join('');
}

function renderActivity(data) {
  if (!data.activity.length) return '<div class="empty">no activity yet</div>';
  return data.activity.map(function (e) {
    const ok = e.status === 'done' ? '✓' : (e.status === 'failed' ? '✗' : '·');
    return '<div class="row small">' + ok + ' <b>' + esc(e.agent) + '</b> ' + esc(e.goal || '') +
      (e.summary ? ' → ' + esc(e.summary) : '') +
      (e.duration_s != null ? ' <span class="muted">(' + e.duration_s + 's)</span>' : '') +
      '<div class="muted">' + esc(e.ts || '') + '</div></div>';
  }).join('');
}

function renderThreads(data) {
  if (!data.threads.length) return '<div class="empty">no open conversations</div>';
  return data.threads.map(function (t) {
    return '<div class="row small"><b>' + esc(t.agent) + '</b> ' + esc(t.title || '(untitled)') +
      ' <span class="chip">' + esc(t.channel) + '</span>' +
      (t.digest_stale ? '<span class="chip warn">stale digest</span>' : '') +
      '<div class="muted">' + t.turns + ' turns · last ' + esc(t.last_activity_at || '') + '</div></div>';
  }).join('');
}

function renderPlans(data) {
  const pending = data.plans.pending || [];
  const closed = data.plans.recent_closed || [];
  let html = '';
  if (!pending.length) {
    html += '<div class="empty">no plans pending approval</div>';
  } else {
    html += pending.map(function (p) {
      const units = (p.units || []).map(function (u) { return '<li>' + esc(u.title) + '</li>'; }).join('');
      return '<div class="row small"><b>' + esc(p.plan_id) + '</b> ' + esc(p.agent) +
        ' <span class="chip">' + esc(p.status) + '</span> <span class="muted">' + esc(fmtCountdown(p.expires_at)) + '</span>' +
        '<div>' + esc(p.goal) + '</div><ul class="units">' + units + '</ul></div>';
    }).join('');
  }
  if (closed.length) {
    html += '<div class="small muted" style="margin-top:8px">recently closed</div>';
    html += closed.map(function (p) {
      return '<div class="row small">' + esc(p.plan_id) + ' ' + esc(p.agent) + ' <span class="chip">' + esc(p.status) + '</span></div>';
    }).join('');
  }
  return html;
}

function renderScheduler(data) {
  const s = data.scheduler;
  let html = '<div class="small"><span class="dot ' + (s.daemon_running ? 'on' : 'off') + '"></span>' +
    (s.daemon_running ? 'running' : 'stopped') + ' · ' + s.routines.enabled + '/' + s.routines.total + ' routines enabled</div>';
  if (s.next_fires && s.next_fires.length) {
    html += '<table><tr><th>agent</th><th>routine</th><th>next</th></tr>' +
      s.next_fires.map(function (f) {
        return '<tr><td>' + esc(f.agent) + '</td><td>' + esc(f.id) + '</td><td>' + esc(f.next_at) + '</td></tr>';
      }).join('') + '</table>';
  }
  if (s.recent && s.recent.length) {
    html += '<div class="small muted" style="margin-top:6px">recent</div>' +
      s.recent.map(function (r) {
        return '<div class="row small">' + esc(r.at) + ' ' + esc(r.status) + ' ' + esc(r.agent) + '/' + esc(r.id) + '</div>';
      }).join('');
  }
  return html;
}

function renderComms(data) {
  const c = data.comms;
  const strip = function (label, live) {
    return '<span class="chip"><span class="dot ' + (live.running ? 'on' : 'off') + '"></span>' + label + '</span>';
  };
  let html = '<div class="small">' +
    strip('bridge', c.bridge) +
    strip('telegram' + (c.telegram.configured ? '' : ' (unconfigured)'), c.telegram) +
    strip('scheduler', c.scheduler) +
    strip('office', c.office) +
    '</div>';
  if (c.delegates && c.delegates.length) {
    html += '<div class="small" style="margin-top:6px">' +
      c.delegates.map(function (d) { return strip(d.agent, d); }).join(' ') + '</div>';
  }
  return html;
}

let lastData = BOOT;
function render(data) {
  lastData = data;
  document.getElementById('gen-at').textContent = data.generated_at || '';
  document.getElementById('roster').querySelector('.body').innerHTML = renderRoster(data);
  document.getElementById('activity').querySelector('.body').innerHTML = renderActivity(data);
  document.getElementById('threads').querySelector('.body').innerHTML = renderThreads(data);
  document.getElementById('plans').querySelector('.body').innerHTML = renderPlans(data);
  document.getElementById('scheduler').querySelector('.body').innerHTML = renderScheduler(data);
  document.getElementById('comms').querySelector('.body').innerHTML = renderComms(data);
}

render(BOOT);

// Theme toggle — stamps data-theme on <html>; 'auto' clears the override and
// falls back to the @media prefers-color-scheme rule above.
(function () {
  const KEY = 'sidekicks-office-theme';
  const sel = document.getElementById('theme-sel');
  let saved = 'auto';
  try { saved = localStorage.getItem(KEY) || 'auto'; } catch (e) { /* best-effort */ }
  sel.value = saved;
  if (saved !== 'auto') document.documentElement.setAttribute('data-theme', saved);
  sel.addEventListener('change', function () {
    try { localStorage.setItem(KEY, sel.value); } catch (e) { /* best-effort */ }
    if (sel.value === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', sel.value);
  });
})();

// Live updates over SSE (the query string carries ?token= when the server was
// started on a non-loopback bind — EventSource cannot set a header).
const liveEl = document.getElementById('live');
if (window.EventSource) {
  const es = new EventSource('/events' + location.search);
  es.onopen = function () { liveEl.hidden = false; liveEl.textContent = '🔴 live'; };
  es.onerror = function () { liveEl.hidden = false; liveEl.textContent = '⚪ reconnecting…'; };
  es.onmessage = function (ev) {
    try { render(JSON.parse(ev.data)); } catch (e) { /* malformed frame — skip */ }
  };
}

// Recompute presence ages + countdowns once a second by re-rendering the last
// received snapshot — every fmt* helper reads Date.now() at call time, so a
// re-render alone (no refetch) is enough to age the clock forward.
setInterval(function () { render(lastData); }, 1000);
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// HTTP handling
// ---------------------------------------------------------------------------

/** Constant-time compare of a bearer token against a raw (non-"Bearer ") value. */
function tokenMatches(raw, token) {
  const a = Buffer.from(String(raw || ''));
  const b = Buffer.from(String(token || ''));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Handle one request. Exported for tests.
 * @param {string} repoRoot
 * @param {{ token: string|null, snapshot: () => object, addClient: (res: import('node:http').ServerResponse) => void }} opts
 */
export async function handleRequest(repoRoot, opts, req, res) {
  const remote = req.socket?.remoteAddress || '';
  if (!isPrivateAddress(remote)) {
    sendJson(res, 403, { error: `refused: '${remote}' is not a private-network address — the office serves the local network only` });
    return;
  }

  if (opts.token) {
    const url = new URL(req.url || '/', 'http://office');
    const auth = String(req.headers['authorization'] || '');
    const queryToken = url.searchParams.get('token');
    const authorized = bearerMatches(auth, opts.token) || (queryToken != null && tokenMatches(queryToken, opts.token));
    if (!authorized) {
      sendJson(res, 401, { error: 'missing or invalid bearer token (Authorization header or ?token=)' });
      return;
    }
  }

  const url = new URL(req.url || '/', 'http://office');

  if (req.method === 'GET' && url.pathname === '/') {
    const html = renderOfficeHTML(opts.snapshot());
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/snapshot') {
    sendJson(res, 200, opts.snapshot());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(opts.snapshot())}\n\n`);
    opts.addClient(res);
    return;
  }

  sendJson(res, 404, { error: `unknown endpoint ${req.method} ${url.pathname}` });
}

// ---------------------------------------------------------------------------
// Live server
// ---------------------------------------------------------------------------

/** Best-effort platform browser opener — never throws, never blocks. */
function openBrowser(url) {
  try {
    const [cmd, args] = process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    // no browser opener available on this host — the printed URL still works
  }
}

/**
 * Start the live office server: HTTP + SSE, a filesystem watcher (debounced),
 * and a slow poll (catches state a watcher event alone would miss — a dead
 * pid, presence going stale with no file write at all).
 */
export async function startOfficeServer(repoRoot, { port, bind, token, log = () => {} }) {
  let clients = [];
  let lastCore = '';

  function snapshot() {
    return buildSnapshot(repoRoot);
  }

  function broadcastIfChanged() {
    const snap = snapshot();
    const core = JSON.stringify({ ...snap, generated_at: null });
    if (core === lastCore) return;
    lastCore = core;
    const line = `data: ${JSON.stringify(snap)}\n\n`;
    for (const c of clients) c.write(line);
  }

  const server = createServer((req, res) => {
    handleRequest(repoRoot, {
      token,
      snapshot,
      addClient: (res) => {
        clients.push(res);
        req.on('close', () => { clients = clients.filter((c) => c !== res); });
      },
    }, req, res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        reject(new SidekicksError(
          `agent office: port ${port} is already in use — pass a different --port, or 'sidekicks agent office --replace' to take over the running one`,
          EXIT_VALIDATION
        ));
        return;
      }
      reject(err);
    });
    server.listen(port, bind, resolve);
  });

  let debounce = null;
  const watcher = createOfficeWatcher(repoRoot, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { watcher.ensure(); broadcastIfChanged(); }, WATCH_DEBOUNCE_MS);
  });

  const poll = setInterval(broadcastIfChanged, POLL_MS);
  poll.unref();

  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();

  return {
    server,
    close() {
      clearInterval(poll);
      clearInterval(heartbeat);
      clearTimeout(debounce);
      watcher.close();
      for (const c of clients) { try { c.end(); } catch { /* noop */ } }
      server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Verb
// ---------------------------------------------------------------------------

export async function run(ctx) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['once', 'json', 'replace', 'open']);

  if (flags.once || flags.json) {
    const snap = buildSnapshot(repoRoot);
    return { stdout: `${JSON.stringify(snap, null, 2)}\n`, exitCode: EXIT_OK };
  }

  const { port, bind, token } = resolveOfficeConfig(repoRoot, flags);

  if (flags.replace) {
    const rec = readJsonFile(pidFilePath(repoRoot, DAEMON));
    if (rec && isProcessAlive(rec.pid) && rec.pid !== process.pid) {
      try { process.kill(rec.pid); } catch { /* already gone */ }
      for (let i = 0; i < 30 && isProcessAlive(rec.pid); i++) await sleep(100); // bounded ~3s
      try { rmSync(pidFilePath(repoRoot, DAEMON), { force: true }); } catch { /* best-effort */ }
    }
  }

  const claim = acquirePidFile(repoRoot, DAEMON, process.pid);
  if (!claim.ok) {
    throw new SidekicksError(
      `agent office: already running (pid ${claim.pid}) — stop it or rerun with --replace to take over`,
      EXIT_VALIDATION
    );
  }

  const { close } = await startOfficeServer(repoRoot, { port, bind, token });

  const url = `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}/`;
  const isTty = Boolean(process.stdout.isTTY);
  const lines = [
    `agent office live at ${url} (Ctrl-C to stop)`,
    token
      ? isTty
        ? `token: ${token} (non-loopback bind — append ?token=${token} to the URL, or set Authorization: Bearer ${token})`
        : `token: ${maskToken(token)} (full token in .sidekicks/agents/.bridge/runtime/bridge.json)`
      : 'no token required — loopback bind',
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');

  if (flags.open) openBrowser(url + (token ? `?token=${token}` : ''));

  const onSignal = () => {
    close();
    try {
      const rec = readJsonFile(pidFilePath(repoRoot, DAEMON));
      if (rec && rec.pid === process.pid) rmSync(pidFilePath(repoRoot, DAEMON), { force: true });
    } catch { /* best-effort */ }
    process.exit(EXIT_OK);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Serve until Ctrl-C — never resolve (same pattern as `agent serve`/`agent
  // scheduler serve`; the dispatcher would writeThenExit and tear it down).
  return new Promise(() => {});
}
