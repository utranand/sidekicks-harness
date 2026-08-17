// lib/journal-lifecycle/issue.mjs
// `sidekicks journal issue add|list|show|ack|close`
//
// L3 — the layer that makes a problem survive the moment it was noticed.
// An incident (L2) records that something broke; an issue is the open item
// tracked to closure, with a status, an owner, and a resolution. Before this
// layer existed, an incident was written once and then nothing ever asked
// whether it had been dealt with.
//
// Lifecycle: open → ack → fixed | wontfix. A closed issue keeps its file; the
// history is the point.
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
  ISSUE_STATUSES,
  SEVERITIES,
} from './_shared.mjs';

const SUBS = ['add', 'list', 'show', 'ack', 'close'];
const VALUE_FLAGS = ['title', 'detail', 'owner', 'severity', 'from-incident', 'status', 'resolution'];

/**
 * Create one issue. Exported so `journal incident --promote` opens the tracked
 * item in the same breath as recording the incident — the promotion path must
 * not be a second thing a human remembers to do.
 *
 * @returns {{ id: string, abs: string, storeRel: string, date: string }}
 */
export function createIssue(cfg, { title, detail, owner, severity, fromIncident, related = [] }) {
  const ts = zonedTimestamp(cfg.timezone);
  const { date, time, compact } = stampParts(ts);
  const id = mintId(cfg, 'issue', 'ISS', compact);
  const slug = slugify(title);
  const abs = expandLayout(cfg, 'issue', { agent: owner || 'unassigned', date, time, slug, id });

  const content = buildEntry(
    {
      id,
      kind: 'issue',
      title,
      status: 'open',
      severity: severity || 'medium',
      owner: owner || '',
      from_incident: fromIncident || '',
      opened_at: ts,
      closed_at: '',
      resolution: '',
    },
    [
      ['Detail', detail],
      ['Resolution', ''],
    ]
  );

  const { storeRel } = writeEntryFile(cfg, abs, content);
  appendIndexRow(cfg, {
    kind: 'issue',
    id,
    agent: owner || null,
    task_id: null,
    date,
    time,
    status: 'open',
    title,
    path: storeRel,
    related: fromIncident ? [fromIncident, ...related] : related,
    ts,
  });
  return { id, abs, storeRel, date };
}

export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'wontfix']);
  const cfg = requireJournalConfig(repoRoot, 'journal issue');
  requireLayer(cfg, 'issue', 'journal issue');
  const { sub, rest } = takeSubVerb(args, SUBS, 'journal issue');

  if (sub === 'add') return addIssue(ctx, cfg, flags);
  if (sub === 'list') return listIssues(cfg, flags);
  if (sub === 'show') return showIssue(ctx, cfg, rest, flags);
  if (sub === 'ack') return transition(ctx, cfg, rest, flags, 'ack');
  return transition(ctx, cfg, rest, flags, flags.wontfix ? 'wontfix' : 'fixed');
}

function addIssue(ctx, cfg, flags) {
  const title = String(flags.title ?? '').trim();
  if (!title) {
    throw new SidekicksError('journal issue add: --title <s> is required', EXIT_VALIDATION);
  }
  const severity = flags.severity ? String(flags.severity) : 'medium';
  if (!SEVERITIES.includes(severity)) {
    throw new SidekicksError(
      `journal issue add: invalid --severity '${severity}' — one of: ${SEVERITIES.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  const owner = flags.owner ? requireAgent(ctx.repoRoot, String(flags.owner), 'journal issue add') : '';
  const fromIncident = flags['from-incident'] ? String(flags['from-incident']) : '';
  if (fromIncident && !findIndexRow(cfg, 'incident', fromIncident)) {
    throw new SidekicksError(
      `journal issue add: --from-incident '${fromIncident}' is not a recorded incident`,
      EXIT_NOT_FOUND
    );
  }

  const issue = createIssue(cfg, {
    title,
    detail: flags.detail,
    owner,
    severity,
    fromIncident,
  });

  const note = commitEntry(cfg, [issue.abs, cfg.indexAbs], `journal: issue ${issue.id} ${slugify(title)}`).note;
  const pushNote = maybePush(cfg, { boundary: false }).note;

  if (flags.json) {
    return { stdout: JSON.stringify({ id: issue.id, status: 'open', path: issue.storeRel }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `issue ${issue.id} [open] → ${issue.storeRel}${note}${pushNote}\n`, exitCode: EXIT_OK };
}

function listIssues(cfg, flags) {
  const status = flags.status ? String(flags.status) : null;
  if (status && !ISSUE_STATUSES.includes(status)) {
    throw new SidekicksError(
      `journal issue list: invalid --status '${status}' — one of: ${ISSUE_STATUSES.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  const rows = filterIndex(cfg, { kind: 'issue', status: status || undefined })
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  if (flags.json) return { stdout: JSON.stringify(rows, null, 2) + '\n', exitCode: EXIT_OK };
  if (rows.length === 0) return { stdout: 'journal issue: none match\n', exitCode: EXIT_OK };
  return {
    stdout: renderRows(rows, [
      { header: 'ID',     get: (r) => r.id },
      { header: 'STATUS', get: (r) => r.status },
      { header: 'OWNER',  get: (r) => r.agent || '-' },
      { header: 'OPENED', get: (r) => r.date },
      { header: 'FROM',   get: (r) => (r.related || []).find((x) => String(x).startsWith('INC-')) || '-' },
      { header: 'TITLE',  get: (r) => String(r.title ?? '').slice(0, 56) },
    ]),
    exitCode: EXIT_OK,
  };
}

function showIssue(ctx, cfg, rest, flags) {
  const id = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  const row = id ? findIndexRow(cfg, 'issue', id) : null;
  if (!row) throw new SidekicksError(`journal issue show: no issue '${id ?? ''}'`, EXIT_NOT_FOUND);
  const entry = readEntry(cfg, row.path);
  if (!entry) {
    throw new SidekicksError(
      `journal issue show: index points at '${row.path}' but the file is gone — run 'sidekicks journal rebuild'`,
      EXIT_NOT_FOUND
    );
  }
  if (flags.json) {
    return { stdout: JSON.stringify({ ...row, frontmatter: entry.frontmatter, body: entry.body }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `${row.path}\n\n${entry.body}\n`, exitCode: EXIT_OK };
}

function transition(ctx, cfg, rest, flags, to) {
  const id = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  const row = id ? findIndexRow(cfg, 'issue', id) : null;
  if (!row) throw new SidekicksError(`journal issue: no issue '${id ?? ''}'`, EXIT_NOT_FOUND);

  if (row.status === to) {
    return { stdout: `issue ${id} is already [${to}]\n`, exitCode: EXIT_OK };
  }
  const closing = to === 'fixed' || to === 'wontfix';
  const resolution = String(flags.resolution ?? '').trim();
  if (closing && !resolution) {
    throw new SidekicksError(
      `journal issue close: --resolution <s> is required — an issue closed without one is indistinguishable ` +
      'from an issue everyone stopped looking at',
      EXIT_VALIDATION
    );
  }

  const ts = zonedTimestamp(cfg.timezone);
  const patched = patchEntryFrontmatter(cfg, row.path, {
    status: to,
    ...(closing ? { closed_at: ts, resolution } : {}),
  });
  if (!patched) {
    throw new SidekicksError(
      `journal issue: index points at '${row.path}' but the file is gone — run 'sidekicks journal rebuild'`,
      EXIT_NOT_FOUND
    );
  }
  updateIndexRow(cfg, 'issue', id, { status: to });

  const note = commitEntry(cfg, [patched.abs, cfg.indexAbs], `journal: issue ${id} → ${to}`).note;
  const pushNote = maybePush(cfg, { boundary: false }).note;
  return { stdout: `issue ${id} [${row.status} → ${to}]${note}${pushNote}\n`, exitCode: EXIT_OK };
}
