// lib/journal-lifecycle/incident.mjs
// `sidekicks journal incident add|list|resolve|show`
//
// L2 — one thing that broke, recorded the moment it is found: a dead worker
// holding a claim, a done-claim that failed verification, a rejected send that
// exposed a roster gap, a hard-gate escalation.
//
// `--promote` also opens the L3 issue in the same call. That flag exists because
// the two-step version ("write the incident, then remember to open an issue")
// is exactly the step that never happened.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import {
  requireJournalConfig,
  requireLayer,
  requireAgent,
  parseMemoryFlags,
  takeSubVerb,
  pickPositional,
  zonedTimestamp,
  stampParts,
  slugify,
  mintId,
  expandLayout,
  buildEntry,
  writeEntryFile,
  readEntry,
  patchEntryFrontmatter,
  appendIndexRow,
  updateIndexRow,
  filterIndex,
  findIndexRow,
  commitEntry,
  maybePush,
  renderRows,
  INCIDENT_STATUSES,
  SEVERITIES,
} from './_shared.mjs';
import { createIssue } from './issue.mjs';

const SUBS = ['add', 'list', 'show', 'resolve'];
const VALUE_FLAGS = [
  'subject', 'what', 'evidence', 'cause', 'handled', 'prevent', 'task', 'severity', 'status', 'how', 'since',
];

export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'promote']);
  const cfg = requireJournalConfig(repoRoot, 'journal incident');
  requireLayer(cfg, 'incident', 'journal incident');
  const { sub, rest } = takeSubVerb(args, SUBS, 'journal incident');

  if (sub === 'add') return addIncident(ctx, cfg, rest, flags);
  if (sub === 'list') return listIncidents(cfg, flags);
  if (sub === 'show') return showIncident(ctx, cfg, rest, flags);
  return resolveIncident(ctx, cfg, rest, flags);
}

function addIncident(ctx, cfg, rest, flags) {
  const { repoRoot } = ctx;
  const agentTok = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  const agent = requireAgent(repoRoot, agentTok, 'journal incident add');

  const subject = String(flags.subject ?? '').trim();
  if (!subject) {
    throw new SidekicksError(
      'journal incident add: --subject <s> is required — one line naming what went wrong',
      EXIT_VALIDATION
    );
  }
  const what = String(flags.what ?? '').trim();
  if (!what) {
    throw new SidekicksError(
      'journal incident add: --what <s> is required — the observable failure, in order',
      EXIT_VALIDATION
    );
  }
  const severity = flags.severity ? String(flags.severity) : 'medium';
  if (!SEVERITIES.includes(severity)) {
    throw new SidekicksError(
      `journal incident add: invalid --severity '${severity}' — one of: ${SEVERITIES.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const ts = zonedTimestamp(cfg.timezone);
  const { date, time, compact } = stampParts(ts);
  const id = mintId(cfg, 'incident', 'INC', compact);
  const slug = slugify(subject);
  const abs = expandLayout(cfg, 'incident', { agent, date, time, slug, id });
  const taskId = flags.task ? String(flags.task) : '';

  const content = buildEntry(
    {
      id,
      agent,
      datetime: ts,
      kind: 'incident',
      subject,
      severity,
      task_id: taskId,
      status: 'open',
      resolved_at: '',
      issue: '',
    },
    [
      ['What happened', what],
      ['Evidence', flags.evidence],
      ['Root cause', flags.cause],
      ['How it was handled', flags.handled],
      ['How to spot or prevent it earlier', flags.prevent],
    ]
  );

  const { storeRel } = writeEntryFile(cfg, abs, content);
  appendIndexRow(cfg, {
    kind: 'incident',
    id,
    agent,
    task_id: taskId || null,
    date,
    time,
    status: 'open',
    title: subject,
    path: storeRel,
    related: [],
    ts,
  });

  const written = [abs];
  let promoted = null;
  if (flags.promote) {
    requireLayer(cfg, 'issue', 'journal incident add --promote');
    promoted = createIssue(cfg, {
      title: subject,
      detail: `Promoted from incident ${id} (${storeRel}).\n\n${what}`,
      owner: agent,
      severity,
      fromIncident: id,
    });
    // Back-link so the incident names its issue, not only the reverse.
    patchEntryFrontmatter(cfg, storeRel, { issue: promoted.id });
    updateIndexRow(cfg, 'incident', id, { related: [promoted.id] });
    written.push(promoted.abs);
  }

  const note = commitEntry(cfg, [...written, cfg.indexAbs],
    `journal(${agent}): incident ${id} ${slug}${promoted ? ` + issue ${promoted.id}` : ''}`).note;
  const pushNote = maybePush(cfg, { boundary: false }).note;

  if (flags.json) {
    return {
      stdout: JSON.stringify({ id, agent, path: storeRel, issue: promoted?.id ?? null }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  const promo = promoted ? ` — issue ${promoted.id} [open]` : '';
  return { stdout: `incident ${id} → ${storeRel}${promo}${note}${pushNote}\n`, exitCode: EXIT_OK };
}

function listIncidents(cfg, flags) {
  const status = flags.status ? String(flags.status) : null;
  if (status && !INCIDENT_STATUSES.includes(status)) {
    throw new SidekicksError(
      `journal incident list: invalid --status '${status}' — one of: ${INCIDENT_STATUSES.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  const rows = filterIndex(cfg, { kind: 'incident', status: status || undefined })
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  if (flags.json) return { stdout: JSON.stringify(rows, null, 2) + '\n', exitCode: EXIT_OK };
  if (rows.length === 0) return { stdout: 'journal incident: none match\n', exitCode: EXIT_OK };
  return {
    stdout: renderRows(rows, [
      { header: 'ID',      get: (r) => r.id },
      { header: 'STATUS',  get: (r) => r.status },
      { header: 'AGENT',   get: (r) => r.agent },
      { header: 'DATE',    get: (r) => r.date },
      { header: 'ISSUE',   get: (r) => (r.related || [])[0] || '-' },
      { header: 'SUBJECT', get: (r) => String(r.title ?? '').slice(0, 56) },
    ]),
    exitCode: EXIT_OK,
  };
}

function showIncident(ctx, cfg, rest, flags) {
  const id = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  const row = id ? findIndexRow(cfg, 'incident', id) : null;
  if (!row) throw new SidekicksError(`journal incident show: no incident '${id ?? ''}'`, EXIT_NOT_FOUND);
  const entry = readEntry(cfg, row.path);
  if (!entry) {
    throw new SidekicksError(
      `journal incident show: index points at '${row.path}' but the file is gone — run 'sidekicks journal rebuild'`,
      EXIT_NOT_FOUND
    );
  }
  if (flags.json) {
    return { stdout: JSON.stringify({ ...row, frontmatter: entry.frontmatter, body: entry.body }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `${row.path}\n\n${entry.body}\n`, exitCode: EXIT_OK };
}

function resolveIncident(ctx, cfg, rest, flags) {
  const id = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  const row = id ? findIndexRow(cfg, 'incident', id) : null;
  if (!row) throw new SidekicksError(`journal incident resolve: no incident '${id ?? ''}'`, EXIT_NOT_FOUND);
  if (row.status === 'resolved') {
    return { stdout: `incident ${id} is already [resolved]\n`, exitCode: EXIT_OK };
  }
  const ts = zonedTimestamp(cfg.timezone);
  const patched = patchEntryFrontmatter(cfg, row.path, {
    status: 'resolved',
    resolved_at: ts,
    ...(flags.how ? { resolution: String(flags.how) } : {}),
  });
  if (!patched) {
    throw new SidekicksError(
      `journal incident resolve: index points at '${row.path}' but the file is gone — run 'sidekicks journal rebuild'`,
      EXIT_NOT_FOUND
    );
  }
  updateIndexRow(cfg, 'incident', id, { status: 'resolved' });

  // An incident that spawned an issue is NOT closed by resolving the incident —
  // the issue is the thing tracked to closure, and silently closing it here
  // would erase the distinction the two layers exist to draw.
  const openIssue = (row.related || []).find((x) => {
    const r = findIndexRow(cfg, 'issue', x);
    return r && r.status !== 'fixed' && r.status !== 'wontfix';
  });
  const issueNote = openIssue
    ? `\nnote: issue ${openIssue} is still open — close it with 'sidekicks journal issue close ${openIssue} --resolution "..."'`
    : '';

  const note = commitEntry(cfg, [patched.abs, cfg.indexAbs], `journal: incident ${id} → resolved`).note;
  const pushNote = maybePush(cfg, { boundary: false }).note;
  return { stdout: `incident ${id} [resolved]${note}${pushNote}${issueNote}\n`, exitCode: EXIT_OK };
}
