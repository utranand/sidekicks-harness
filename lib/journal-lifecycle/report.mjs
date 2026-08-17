// lib/journal-lifecycle/report.mjs
// `sidekicks journal report [--agent <a>] [--since 7d] [--json]`
//
// The read surface the whole journal exists for: one view that answers "what did
// this agent do, what went wrong, and what is still open" without opening a
// single file. Everything is joined off the index — tasks (L0) to their
// retrospectives (L1) by task_id, incidents (L2) to their issues (L3) by the
// promotion link, plus the improvement proposals (L5) standing against the agent
// and the standing goals (L7) it is carrying.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import {
  requireJournalConfig,
  requireAgent,
  parseMemoryFlags,
  zonedTimestamp,
  parseSince,
  filterIndex,
  findIndexRow,
} from './_shared.mjs';
import { loadMissions, isLive } from './_mission.mjs';

export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json']);
  const cfg = requireJournalConfig(repoRoot, 'journal report');

  const agent = flags.agent ? requireAgent(repoRoot, String(flags.agent), 'journal report') : null;
  const now = zonedTimestamp(cfg.timezone);
  const since = parseSince(flags.since ?? '7d', now);
  const scope = { agent: agent || undefined, since: since || undefined };

  const tasks = filterIndex(cfg, { ...scope, kind: 'log' })
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const incidents = filterIndex(cfg, { ...scope, kind: 'incident' })
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const improvements = filterIndex(cfg, { ...scope, kind: 'improve' })
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const diaries = filterIndex(cfg, { ...scope, kind: 'diary' });
  // Issues are NOT agent-scoped the way events are — an issue's owner may be
  // empty, and an unowned open issue is precisely the one worth surfacing. Scope
  // it by the incidents in view instead of dropping it.
  const incidentIds = new Set(incidents.map((i) => i.id));
  const issues = filterIndex(cfg, { kind: 'issue' }).filter((i) =>
    (i.related || []).some((r) => incidentIds.has(r))
    || (!agent && (!since || String(i.date) >= since))
    || (agent && i.agent === agent));

  // L7 missions carry no status in the index (it is folded from their event
  // shards), so they are loaded rather than filtered — the roll-up wants the
  // CURRENT state, which only the fold knows.
  const missions = cfg.layers.mission?.enabled
    ? loadMissions(cfg, { agent: agent || undefined }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    : [];

  const taskRows = tasks.map((t) => ({
    ...t,
    retro: findIndexRow(cfg, 'retro', t.task_id),
    incidents: incidents.filter((i) => i.task_id === t.task_id).map((i) => i.id),
  }));

  const summary = {
    window: since ? `since ${since}` : 'all time',
    agent: agent || 'all agents',
    tasks: tasks.length,
    failed: tasks.filter((t) => t.status === 'failed').length,
    retros: taskRows.filter((t) => t.retro).length,
    missing_retros: taskRows.filter((t) => !t.retro).length,
    incidents: incidents.length,
    incidents_open: incidents.filter((i) => i.status === 'open').length,
    issues_open: issues.filter((i) => i.status === 'open' || i.status === 'ack').length,
    improvements_proposed: improvements.filter((i) => i.status === 'proposed').length,
    diaries: diaries.length,
    missions_live: missions.filter((m) => isLive(m.status)).length,
    missions_steps_verified: missions.reduce((n, m) => n + m.counts.verified, 0),
    missions_steps_unverified: missions.reduce((n, m) => n + m.counts.done_unverified, 0),
  };

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        summary, tasks: taskRows, incidents, issues, improvements, diaries,
        missions: missions.map((m) => ({
          id: m.id, agent: m.agent, status: m.status, title: m.title, priority: m.priority,
          counts: m.counts, last_activity_ts: m.last_activity_ts, path: m.path,
        })),
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const out = [];
  out.push(`Agent journal — ${summary.agent}, ${summary.window}`);
  out.push('');
  out.push(
    `  tasks ${summary.tasks} (${summary.failed} failed)   ` +
    `retros ${summary.retros}/${summary.tasks}   ` +
    `incidents ${summary.incidents} (${summary.incidents_open} open)   ` +
    `issues open ${summary.issues_open}   ` +
    `improvements proposed ${summary.improvements_proposed}   ` +
    `missions live ${summary.missions_live}`
  );

  const liveMissions = missions.filter((m) => isLive(m.status));
  if (liveMissions.length) {
    out.push('', 'Standing missions');
    for (const m of liveMissions) {
      out.push(`  ${m.id} [${m.status}] p${m.priority} ${m.agent}  ` +
        `${m.counts.verified}/${m.counts.total} verified` +
        `${m.counts.done_unverified ? `, ${m.counts.done_unverified} awaiting a verdict` : ''}  ` +
        `${String(m.title).slice(0, 44)}`);
      if (m.pending_question) out.push(`      waiting on the user since ${m.pending_question.ts}: ${m.pending_question.text}`);
      if (m.status === 'blocked') out.push(`      blocked: ${m.blocked_reason || 'reason not recorded'}`);
    }
  }

  if (taskRows.length) {
    out.push('', 'Tasks');
    for (const t of taskRows) {
      const marks = [
        t.retro ? 'retro' : 'NO RETRO',
        ...(t.incidents.length ? [`incidents: ${t.incidents.join(', ')}`] : []),
      ].join('  ');
      out.push(`  ${t.date} ${String(t.time).slice(0, 2)}:${String(t.time).slice(2)}  ` +
        `[${t.status}] ${t.agent}  ${String(t.title ?? '').slice(0, 48)}`);
      out.push(`      ${t.task_id}  ${marks}`);
    }
  }

  if (incidents.length) {
    out.push('', 'Incidents');
    for (const i of incidents) {
      const issue = (i.related || [])[0];
      const issueRow = issue ? findIndexRow(cfg, 'issue', issue) : null;
      const tail = issueRow ? `→ ${issueRow.id} [${issueRow.status}]` : '(not promoted to an issue)';
      out.push(`  ${i.date} [${i.status}] ${i.id} ${i.agent}  ${String(i.title ?? '').slice(0, 48)}  ${tail}`);
    }
  }

  const openIssues = issues.filter((i) => i.status === 'open' || i.status === 'ack');
  if (openIssues.length) {
    out.push('', 'Open issues');
    for (const i of openIssues) {
      out.push(`  ${i.id} [${i.status}] ${i.agent || 'unassigned'}  opened ${i.date}  ${String(i.title ?? '').slice(0, 52)}`);
    }
  }

  const proposed = improvements.filter((i) => i.status === 'proposed');
  if (proposed.length) {
    out.push('', 'Improvement proposals awaiting a decision');
    for (const i of proposed) {
      out.push(`  ${i.id} ${i.agent}  ${String(i.title ?? '').slice(0, 60)}`);
    }
  }

  if (summary.tasks === 0 && summary.incidents === 0 && issues.length === 0 && improvements.length === 0) {
    out.push('', '  (nothing recorded in this window)');
  }

  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
