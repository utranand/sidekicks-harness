// lib/agent-lifecycle/list.mjs
// `sidekicks agent list [--json] [--category <c>]` — the roster view.
//
// Scan-on-read over .sidekicks/agents/*/agent.yaml (no roster index file to
// drift), each charter merged with live presence (fresh/stale/offline vs the
// 900s TTL) and inbox depths.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { parseMemoryFlags, listAgentNames, agentStatusRow } from './_shared.mjs';

/**
 * Run `agent list`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json']);

  let rows = listAgentNames(repoRoot).map((n) => agentStatusRow(repoRoot, n));
  if (flags.category) {
    const cat = String(flags.category);
    rows = rows.filter((r) => r.categories.includes(cat));
  }

  if (flags.json) {
    return { stdout: JSON.stringify(rows, null, 2) + '\n', exitCode: EXIT_OK };
  }

  if (rows.length === 0) {
    return {
      stdout: "No agents registered. Create one with 'sidekicks agent create <name> --specialty \"...\" --categories a,b'.\n",
      exitCode: EXIT_OK,
    };
  }

  const lines = ['Agents (.sidekicks/agents/)', ''];
  for (const r of rows) {
    if (r.broken) {
      // A charter that fails to parse still gets a row — hiding it would make
      // the agent silently vanish from the roster while its mailbox lives on.
      lines.push(`  ${r.name} [broken] — charter unreadable: ${r.error}`);
      continue;
    }
    const live = r.presence === 'offline'
      ? 'offline'
      : `${r.presence}/${r.activity ?? 'standby'}`;
    const inbox = `new:${r.inbox.new} claimed:${r.inbox.claimed} done:${r.inbox.done}`;
    lines.push(`  ${r.name} [${r.status}] — ${live} — ${inbox} — categories: ${r.categories.join(', ')}`);
    lines.push(`      ${r.specialty}`);
  }
  lines.push('');
  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}
