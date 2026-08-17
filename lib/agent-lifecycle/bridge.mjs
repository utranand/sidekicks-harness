// lib/agent-lifecycle/bridge.mjs
// `sidekicks agent bridge <list|show|inbox|send> [...] --host <ip:port> [--token <t>]`
//
// Client half of the local-network messenger: talks to an `agent serve`
// bridge on another machine (or another terminal on this one). Runs from any
// Sidekicks clone; terminals without a clone use curl against the same
// endpoints (the serve banner prints a ready example).
//
//   agent bridge list --host 192.168.1.7:7787 --token <t>
//   agent bridge show steave --host ... --token ...
//   agent bridge inbox steave [--state new] --host ... --token ...
//   agent bridge send steave --from remote --category development \
//     --goal "..." [--acceptance "a;b"] [--kind task|reply|signal] \
//     [--priority <n>] [--work-dir <p>] [--isolation worktree|shared] \
//     [--body-file <local .md>]   (file content travels inline — the server
//                                  persists it; no shared filesystem needed)
//
// --host/--token fall back to SIDEKICKS_BRIDGE_HOST / SIDEKICKS_BRIDGE_TOKEN.
//
// Zero npm dependencies — node:* + lib/ back-edges only (global fetch).

import { readFileSync } from 'node:fs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { parseMemoryFlags } from './_shared.mjs';

const ACTIONS = ['list', 'show', 'inbox', 'send'];

async function request(base, token, method, path, body) {
  let res;
  try {
    res = await fetch(`http://${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new SidekicksError(
      `agent bridge: cannot reach http://${base} — is 'sidekicks agent serve' running there? (${err.message})`,
      EXIT_VALIDATION
    );
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new SidekicksError(`agent bridge: ${res.status} — ${json.error || text}`, EXIT_VALIDATION);
  }
  return json;
}

/**
 * Run `agent bridge`.
 * args.name = action; args.rest[0] = agent name for show/inbox/send.
 */
export async function run(ctx, args) {
  const flags = parseMemoryFlags(ctx.argv, ['json']);
  const action = args.name ? String(args.name) : '';
  if (!ACTIONS.includes(action)) {
    throw new SidekicksError(
      `agent bridge: an action is required — one of: ${ACTIONS.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const host = flags.host ? String(flags.host) : (process.env.SIDEKICKS_BRIDGE_HOST || '');
  if (!host) {
    throw new SidekicksError('agent bridge: --host <ip:port> is required (or SIDEKICKS_BRIDGE_HOST)', EXIT_VALIDATION);
  }
  const token = flags.token ? String(flags.token) : (process.env.SIDEKICKS_BRIDGE_TOKEN || '');
  if (!token) {
    throw new SidekicksError('agent bridge: --token <t> is required (or SIDEKICKS_BRIDGE_TOKEN) — printed by agent serve', EXIT_VALIDATION);
  }

  // Positional agent name: first msg-unlike, flag-unlike token after the action.
  const target = (args.rest || []).find((t) => typeof t === 'string' && !t.startsWith('--'));

  if (action === 'list') {
    const rows = await request(host, token, 'GET', '/v1/list');
    if (flags.json) return { stdout: JSON.stringify(rows, null, 2) + '\n', exitCode: EXIT_OK };
    const lines = rows.map((r) =>
      `  ${r.name} [${r.status}] — ${r.presence} — new:${r.inbox.new} claimed:${r.inbox.claimed} — ${r.categories.join(', ')}`);
    return { stdout: [`Agents @ ${host}:`, ...lines, ''].join('\n'), exitCode: EXIT_OK };
  }

  if (action === 'show' || action === 'inbox') {
    if (!target) {
      throw new SidekicksError(`agent bridge ${action}: an agent <name> is required`, EXIT_VALIDATION);
    }
    const path = action === 'show'
      ? `/v1/agents/${target}`
      : `/v1/agents/${target}/inbox?state=${flags.state ? String(flags.state) : 'new'}`;
    const out = await request(host, token, 'GET', path);
    return { stdout: JSON.stringify(out, null, 2) + '\n', exitCode: EXIT_OK };
  }

  // send
  if (!target) {
    throw new SidekicksError('agent bridge send: a recipient <name> is required', EXIT_VALIDATION);
  }
  const payload = {
    to: target,
    from: flags.from ? String(flags.from) : 'remote',
    kind: flags.kind ? String(flags.kind) : undefined,
    category: flags.category ? String(flags.category) : undefined,
    goal: flags.goal ? String(flags.goal) : undefined,
    acceptance: flags.acceptance ? String(flags.acceptance) : undefined,
    work_dir: flags['work-dir'] ? String(flags['work-dir']) : undefined,
    isolation: flags.isolation ? String(flags.isolation) : undefined,
    priority: flags.priority != null && flags.priority !== '' ? Number(flags.priority) : undefined,
    reply_to: flags['reply-to'] ? String(flags['reply-to']) : undefined,
  };
  if (flags['body-file']) {
    // Read the LOCAL file and ship its content inline — the server persists
    // it on its side; sender and server need no shared filesystem.
    payload.body = readFileSync(String(flags['body-file']), 'utf8');
  }
  const msg = await request(host, token, 'POST', '/v1/send', payload);
  return {
    stdout: `sent ${msg.id} (${msg.kind}) ${msg.from} → ${msg.to}${msg.category ? ` [${msg.category}]` : ''} via ${host}\n`,
    exitCode: EXIT_OK,
  };
}
