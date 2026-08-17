// lib/journal-lifecycle/doctor.mjs
// `sidekicks journal doctor [--agent <a>] [--since 7d] [--stale-days 7] [--json]`
//
// The gap report. `report` says what IS recorded; `doctor` says what is MISSING
// — which is the failure mode this whole subsystem was built to fix. Every
// finding names the exact command that clears it, because a gap report nobody
// can act on is just a second thing to ignore.
//
// Exit code is 0 even with findings: gaps are information, not a broken CLI.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../sk-cli/errors.mjs';
import { hasUnpushedCommits } from '../git-delegation/git.mjs';
import {
  requireJournalConfig,
  requireAgent,
  parseMemoryFlags,
  zonedTimestamp,
  parseSince,
  filterIndex,
  findIndexRow,
  readIndex,
  storeGitRoot,
  nodeIdIsUnstable,
} from './_shared.mjs';
import { missionFindings } from './_mission.mjs';

/**
 * Collect every finding, as data.
 *
 * Split out from `run` so another verb can consume the gap report without
 * spawning a subprocess or parsing stdout — `journal mission next` uses it as
 * the source of proposal candidates. Every finding carries `ref` (the entity id
 * it is about) and `agent`, because a consumer that has to regex the prose
 * `subject` for an id has a guess, not a contract.
 *
 * @returns {{kind: string, severity: string, subject: string, fix: string, ref: string|null, agent: string|null}[]}
 */
export function collectFindings(repoRoot, cfg, { agent = null, since = null, staleDays = 7 } = {}) {
  const now = zonedTimestamp(cfg.timezone);
  const staleBefore = parseSince(`${staleDays}d`, now);
  const scope = { agent: agent || undefined, since: since || undefined };

  const findings = [];

  // 1. A completed task with no retrospective — the exact gap the audit found.
  for (const t of filterIndex(cfg, { ...scope, kind: 'log' })) {
    if (findIndexRow(cfg, 'retro', t.task_id)) continue;
    findings.push({
      kind: 'missing-retro',
      severity: t.status === 'failed' ? 'high' : 'medium',
      subject: `${t.agent} completed ${t.task_id} [${t.status}] on ${t.date} with no retrospective`,
      fix: `sidekicks journal retro add ${t.agent} --task ${t.task_id} --status ${t.status} --problems "..."`,
      ref: t.task_id ?? null,
      agent: t.agent ?? null,
    });
  }

  // 2. An open incident that never became a tracked issue — it will be forgotten.
  for (const i of filterIndex(cfg, { ...scope, kind: 'incident', status: 'open' })) {
    if ((i.related || []).some((r) => String(r).startsWith('ISS-'))) continue;
    findings.push({
      kind: 'unpromoted-incident',
      severity: 'medium',
      subject: `incident ${i.id} (${i.agent}, ${i.date}) is open and has no issue tracking it`,
      fix: `sidekicks journal issue add --title "${String(i.title ?? '').replace(/"/g, "'")}" --from-incident ${i.id} --owner ${i.agent}`,
      ref: i.id ?? null,
      agent: i.agent ?? null,
    });
  }

  // 3. An issue left open past the staleness window.
  for (const i of filterIndex(cfg, { kind: 'issue' })) {
    if (i.status !== 'open' && i.status !== 'ack') continue;
    if (agent && i.agent !== agent) continue;
    if (staleBefore && String(i.date) >= staleBefore) continue;
    findings.push({
      kind: 'stale-issue',
      severity: 'medium',
      subject: `issue ${i.id} has been [${i.status}] since ${i.date} (> ${staleDays}d)`,
      fix: `sidekicks journal issue close ${i.id} --resolution "..."   # or --wontfix`,
      ref: i.id ?? null,
      agent: i.agent ?? null,
    });
  }

  // 4. Improvement proposals nobody has decided on.
  for (const p of filterIndex(cfg, { ...scope, kind: 'improve', status: 'proposed' })) {
    findings.push({
      kind: 'undecided-improvement',
      severity: 'low',
      subject: `improvement ${p.id} against ${p.agent} is still [proposed]: ${String(p.title ?? '').slice(0, 50)}`,
      fix: `sidekicks journal improve show ${p.id}   # then apply or reject <id> --why "..."`,
      ref: p.id ?? null,
      agent: p.agent ?? null,
    });
  }

  // 5. Index drift — a row pointing at a file that is no longer on disk.
  for (const row of readIndex(cfg)) {
    if (agent && row.agent && row.agent !== agent) continue;
    if (!row.path) continue;
    if (existsSync(join(cfg.storeRoot, row.path))) continue;
    findings.push({
      kind: 'index-drift',
      severity: 'high',
      subject: `index row ${row.kind}/${row.id} points at '${row.path}', which does not exist`,
      fix: 'sidekicks journal rebuild',
      ref: row.id ?? null,
      agent: row.agent ?? null,
    });
  }

  // 6. Commits the store never shipped — the state this replaced (2 ahead, forever).
  const gitCwd = storeGitRoot(cfg);
  if (gitCwd && hasUnpushedCommits(gitCwd)) {
    findings.push({
      kind: 'unpushed-store',
      severity: cfg.git.push === 'never' ? 'low' : 'medium',
      subject: `the journal store has commits its remote has never seen (push policy: ${cfg.git.push})`,
      fix: 'sidekicks journal push',
      ref: null,
      agent: null,
    });
  }

  // 7. L7 missions — stalled, unverified, planless, torn.
  if (cfg.layers.mission?.enabled) {
    for (const f of missionFindings(cfg, { agent: agent || undefined, staleDays })) findings.push(f);

    // 8. A node id nobody chose. Only raised once missions exist: unset is
    // harmless until something is partitioned by it, and a warning on a store
    // that has no partitioned layer is noise that trains people to ignore
    // doctor. IP-shaped is HIGH — it changes with the network, so the same
    // laptop would write under two ids and fork the partition silently.
    const missions = filterIndex(cfg, { kind: 'mission' });
    const derived = cfg.node?.source !== 'env' && cfg.node?.source !== 'config';
    if (missions.length > 0 && derived) {
      const unstable = nodeIdIsUnstable(cfg.node);
      findings.push({
        kind: 'journal-node-unset',
        severity: unstable ? 'high' : 'medium',
        subject: `this machine's node id '${cfg.node.id}' is ${cfg.node.source}-derived` +
          (unstable ? ' and looks like an IP address, which changes with the network' : ''),
        fix: 'sidekicks config set agent_memory.node.id <kebab-case, <=16 chars>',
        ref: null,
        agent: null,
      });
    }
  }

  return findings;
}

export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json']);
  const cfg = requireJournalConfig(repoRoot, 'journal doctor');

  const agent = flags.agent ? requireAgent(repoRoot, String(flags.agent), 'journal doctor') : null;
  const now = zonedTimestamp(cfg.timezone);
  const since = parseSince(flags.since ?? '30d', now);
  const staleDays = Number.isInteger(Number(flags['stale-days'])) && Number(flags['stale-days']) > 0
    ? Number(flags['stale-days']) : 7;

  const findings = collectFindings(repoRoot, cfg, { agent, since, staleDays });

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        agent: agent || 'all agents',
        window: since ? `since ${since}` : 'all time',
        counts: bySeverity,
        findings,
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  if (findings.length === 0) {
    return { stdout: `journal doctor: no gaps (${agent || 'all agents'}, since ${since ?? 'always'})\n`, exitCode: EXIT_OK };
  }

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const out = [
    `journal doctor — ${agent || 'all agents'}, since ${since ?? 'always'}`,
    `  ${bySeverity.high} high  ${bySeverity.medium} medium  ${bySeverity.low} low`,
    '',
  ];
  for (const f of findings) {
    out.push(`[${f.severity}] ${f.kind}`);
    out.push(`  ${f.subject}`);
    out.push(`  fix: ${f.fix}`);
    out.push('');
  }
  return { stdout: out.join('\n'), exitCode: EXIT_OK };
}
