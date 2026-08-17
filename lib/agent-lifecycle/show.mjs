// lib/agent-lifecycle/show.mjs
// `sidekicks agent show <name> [--json]` — one agent's charter, presence,
// inbox depths, and its most recent completed messages.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import {
  parseMemoryFlags,
  validateAgentName,
  requireCharter,
  agentStatusRow,
  listMessageIds,
  readMessage,
  readControlStage,
} from './_shared.mjs';

const RECENT_DONE = 5;

/**
 * Run `agent show`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = validateAgentName(args.name);
  const flags = parseMemoryFlags(ctx.argv, ['json']);

  const charter = requireCharter(repoRoot, name);
  const row = agentStatusRow(repoRoot, name);
  const stage = readControlStage(repoRoot, name);

  const doneIds = listMessageIds(repoRoot, name, 'done');
  const recent = doneIds.slice(-RECENT_DONE).reverse().map((id) => {
    const m = readMessage(repoRoot, name, 'done', id) || {};
    return {
      id,
      kind: m.kind ?? '',
      from: m.from ?? '',
      status: m.result?.status ?? '',
      summary: m.result?.summary ?? '',
      completed_at: m.result?.completed_at ?? '',
    };
  });

  if (flags.json) {
    return {
      stdout: JSON.stringify({ ...row, control: stage, charter, recent_done: recent }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const lines = [
    `agent ${name} [${row.status}] — control: ${stage}`,
    `  specialty:  ${row.specialty}`,
    `  categories: ${row.categories.join(', ')}`,
    `  cli:        ${row.cli}`,
    `  role:       ${charter.role || 'worker'}`,
    `  model:      ${charter.model || '(cli default)'}`,
    `  presence:   ${row.presence}${row.session ? ` (session ${row.session}, ${row.activity})` : ''}`,
    `  inbox:      new:${row.inbox.new} claimed:${row.inbox.claimed} done:${row.inbox.done}`,
  ];
  if (charter.default_work_dir) lines.push(`  work_dir:   ${charter.default_work_dir}`);
  if (charter.mission) lines.push(`  mission:    ${charter.mission}`);
  if (charter.persona) lines.push(`  persona:    ${charter.persona}`);
  if (Array.isArray(charter.expertise) && charter.expertise.length) {
    lines.push(`  expertise:  ${charter.expertise.join(', ')}`);
  }
  if (Array.isArray(charter.goals) && charter.goals.length) {
    lines.push('  goals:');
    for (const g of charter.goals) lines.push(`    - ${g}`);
  }
  if (Array.isArray(charter.principles) && charter.principles.length) {
    lines.push('  principles:');
    for (const p of charter.principles) lines.push(`    - ${p}`);
  }
  if (Array.isArray(charter.routines) && charter.routines.length) {
    lines.push('  routines:');
    for (const r of charter.routines) lines.push(`    - ${r}`);
  }
  if (charter.output_contract) lines.push(`  output:     ${charter.output_contract}`);
  if (recent.length) {
    lines.push('  recent done:');
    for (const r of recent) {
      lines.push(`    ${r.id} [${r.status}] from ${r.from} — ${r.summary}`);
    }
  }
  lines.push('');
  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}
