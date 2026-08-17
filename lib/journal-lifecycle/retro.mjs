// lib/journal-lifecycle/retro.mjs
// `sidekicks journal retro add|list|show`
//
// L1 — the per-assignment retrospective a worker files after a substantive task.
// One entry per task, keyed by the mailbox message id, so it joins straight onto
// the L0 event row without any extra bookkeeping.
//
// The assignment context (who assigned it, what the goal was) is READ BACK from
// the L0 row rather than re-typed: the CLI already knows those facts, and every
// fact a model has to restate is a fact it can restate wrong.
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
  parseSince,
  slugify,
  expandLayout,
  buildEntry,
  writeEntryFile,
  readEntry,
  appendIndexRow,
  filterIndex,
  findIndexRow,
  commitEntry,
  maybePush,
  renderRows,
} from './_shared.mjs';

const SUBS = ['add', 'list', 'show'];
const STATUSES = ['done', 'failed'];

const VALUE_FLAGS = [
  'task', 'status', 'problems', 'assignment', 'improve-self', 'do', 'dont', 'since', 'agent',
];

export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'force']);
  const cfg = requireJournalConfig(repoRoot, 'journal retro');
  requireLayer(cfg, 'retro', 'journal retro');
  const { sub, rest } = takeSubVerb(args, SUBS, 'journal retro');

  if (sub === 'add') return addRetro(ctx, cfg, rest, flags);
  if (sub === 'list') return listRetros(ctx, cfg, rest, flags);
  return showRetro(ctx, cfg, rest, flags);
}

function addRetro(ctx, cfg, rest, flags) {
  const { repoRoot } = ctx;
  const agentTok = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  const agent = requireAgent(repoRoot, agentTok, 'journal retro add');

  const taskId = String(flags.task ?? '').trim();
  if (!taskId) {
    throw new SidekicksError(
      'journal retro add: --task <message-id> is required — a retrospective is ABOUT one assignment ' +
      "(use --task interactive for a direct user command)",
      EXIT_VALIDATION
    );
  }
  const status = String(flags.status ?? '').trim();
  if (!STATUSES.includes(status)) {
    throw new SidekicksError(
      `journal retro add: --status is required — one of: ${STATUSES.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  const problems = String(flags.problems ?? '').trim();
  if (!problems) {
    throw new SidekicksError(
      'journal retro add: --problems is required — an honest "Nothing notable." is a valid answer, ' +
      'an empty one is not',
      EXIT_VALIDATION
    );
  }

  // Refuse a second retrospective for the same task: two conflicting accounts of
  // one assignment are worse than one, and a re-file is nearly always a mistake.
  const existing = findIndexRow(cfg, 'retro', taskId);
  if (existing && !flags.force) {
    throw new SidekicksError(
      `journal retro add: '${taskId}' already has a retrospective (${existing.path}) — ` +
      'pass --force to overwrite it',
      EXIT_VALIDATION
    );
  }

  // Inherit the assignment facts the L0 row already recorded.
  const event = findIndexRow(cfg, 'log', taskId);
  const logRow = event ? readLogRow(cfg, event) : null;
  const assignment = String(flags.assignment ?? '').trim() || logRow?.goal || '(not recorded)';
  const assigner = logRow?.assigner || 'user';

  const ts = zonedTimestamp(cfg.timezone);
  const { date, time } = stampParts(ts);
  const slug = slugify(assignment);
  const abs = expandLayout(cfg, 'retro', { agent, date, time, slug, id: taskId });

  const content = buildEntry(
    {
      agent,
      datetime: ts,
      kind: 'retrospective',
      task_id: taskId,
      assigner,
      assignment,
      status,
    },
    [
      ['Assignment', assignment],
      ['Problems found', problems],
      ['What can be improved (self)', flags['improve-self']],
      ['What should be done', flags.do],
      ['What should not be done', flags.dont],
    ]
  );

  const { storeRel } = writeEntryFile(cfg, abs, content);
  appendIndexRow(cfg, {
    kind: 'retro',
    id: taskId,
    agent,
    task_id: taskId,
    date,
    time,
    status,
    title: assignment,
    path: storeRel,
    related: [],
    ts,
  });

  const note = commitEntry(cfg, [abs, cfg.indexAbs],
    `journal(${agent}): retro ${date} ${slug}`).note;
  const pushNote = maybePush(cfg, { boundary: false }).note;

  if (flags.json) {
    return { stdout: JSON.stringify({ kind: 'retro', id: taskId, agent, path: storeRel }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `retro ${taskId} → ${storeRel}${note}${pushNote}\n`, exitCode: EXIT_OK };
}

function listRetros(ctx, cfg, rest, flags) {
  const { repoRoot } = ctx;
  const agentTok = pickPositional(rest, ctx.argv, VALUE_FLAGS) || flags.agent;
  const agent = agentTok ? requireAgent(repoRoot, agentTok, 'journal retro list') : null;
  const since = parseSince(flags.since, zonedTimestamp(cfg.timezone));

  const rows = filterIndex(cfg, { kind: 'retro', agent: agent || undefined, since: since || undefined })
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  if (flags.json) return { stdout: JSON.stringify(rows, null, 2) + '\n', exitCode: EXIT_OK };
  if (rows.length === 0) return { stdout: 'journal retro: none recorded\n', exitCode: EXIT_OK };
  return {
    stdout: renderRows(rows, [
      { header: 'DATE',   get: (r) => `${r.date} ${String(r.time).slice(0, 2)}:${String(r.time).slice(2)}` },
      { header: 'AGENT',  get: (r) => r.agent },
      { header: 'STATUS', get: (r) => r.status },
      { header: 'TASK',   get: (r) => r.task_id },
      { header: 'ASSIGNMENT', get: (r) => String(r.title ?? '').slice(0, 56) },
    ]),
    exitCode: EXIT_OK,
  };
}

function showRetro(ctx, cfg, rest, flags) {
  const id = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  if (!id) throw new SidekicksError('journal retro show: a task id is required', EXIT_VALIDATION);
  const row = findIndexRow(cfg, 'retro', id);
  if (!row) {
    throw new SidekicksError(`journal retro show: no retrospective for '${id}'`, EXIT_NOT_FOUND);
  }
  const entry = readEntry(cfg, row.path);
  if (!entry) {
    throw new SidekicksError(
      `journal retro show: index points at '${row.path}' but the file is gone — run 'sidekicks journal rebuild'`,
      EXIT_NOT_FOUND
    );
  }
  if (flags.json) {
    return { stdout: JSON.stringify({ ...row, frontmatter: entry.frontmatter, body: entry.body }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `${row.path}\n\n${entry.body}\n`, exitCode: EXIT_OK };
}

/** Read the full L0 event row an index pointer refers to (or null). */
function readLogRow(cfg, pointer) {
  const entry = readRawJsonl(cfg, pointer.path);
  return entry.find((r) => r.task_id === pointer.task_id) || null;
}

function readRawJsonl(cfg, storeRel) {
  const e = readEntry(cfg, storeRel);
  // readEntry parses frontmatter; a .jsonl has none, so its whole text is `body`.
  if (!e) return [];
  const out = [];
  for (const line of String(e.body).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return out;
}
