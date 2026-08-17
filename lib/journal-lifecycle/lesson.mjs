// lib/journal-lifecycle/lesson.mjs
// `sidekicks journal lesson add|list|show|retire`
//
// L6 — the FLEET lesson pool: distilled rules any agent should know.
//
// Every other layer is per-agent-partitioned (logs/<agent>/, diaries/<agent>/,
// improvements/<agent>/), which is exactly why the same lesson kept being
// re-derived: an agent had nowhere to file "this is true for everyone". A
// lesson lives in one shared directory, names its source agent in frontmatter,
// and rides every delegate wake via renderLessonsBlock (bounded, newest-first).
//
// Bounded by design — MAX_ACTIVE_LESSONS. Past the cap, `add` refuses until
// something is retired: curation is forced, not optional, because an unbounded
// lesson pile degrades into noise no wake budget can carry.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
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
  LESSON_STATUSES,
} from './_shared.mjs';

const SUBS = ['add', 'list', 'show', 'retire'];
const VALUE_FLAGS = ['title', 'body', 'context', 'tags', 'why', 'status', 'agent', 'limit'];

/** The curation bound: `add` refuses past this many ACTIVE lessons. */
export const MAX_ACTIVE_LESSONS = 50;

/** Wake-injection budget (see renderLessonsBlock). Sized against the Windows
 * cmd.exe 8191-char prompt bound documented in _threads.mjs: base wake prompt
 * + conversation context (3000B) + this leaves >3KB headroom. */
export const MAX_LESSONS_BYTES = 1200;
export const MAX_WAKE_LESSONS = 5;

export async function run(ctx, args) {
  const flags = parseMemoryFlags(ctx.argv, ['json']);
  const cfg = requireJournalConfig(ctx.repoRoot, 'journal lesson');
  requireLayer(cfg, 'lesson', 'journal lesson');
  const { sub, rest } = takeSubVerb(args, SUBS, 'journal lesson');

  if (sub === 'add') return addLesson(ctx, cfg, rest, flags);
  if (sub === 'list') return listLessons(ctx, cfg, rest, flags);
  if (sub === 'show') return showLesson(ctx, cfg, rest, flags);
  return retireLesson(ctx, cfg, rest, flags);
}

function activeLessons(cfg) {
  return filterIndex(cfg, { kind: 'lesson', status: 'active' });
}

/** Newest first — ts, tie-broken by id (LES-YYYYMMDD-NN is monotonic, and
 * `ts` has only second granularity, so same-second adds would tie). */
function newestFirst(a, b) {
  return String(b.ts).localeCompare(String(a.ts)) || String(b.id).localeCompare(String(a.id));
}

function addLesson(ctx, cfg, rest, flags) {
  const { repoRoot } = ctx;
  const agentTok = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  const agent = requireAgent(repoRoot, agentTok, 'journal lesson add');

  const title = String(flags.title ?? '').trim();
  const body = String(flags.body ?? '').trim();
  for (const [flag, value] of [['--title', title], ['--body', body]]) {
    if (!value) {
      throw new SidekicksError(
        `journal lesson add: ${flag} <s> is required — a lesson is a distilled rule, not a placeholder`,
        EXIT_VALIDATION
      );
    }
  }
  // The title lands in yaml frontmatter — poison would brick the entry file
  // for readEntry/rebuild. The body is markdown BELOW the frontmatter and
  // needs no guard.
  const p = yaml.findPoison(title);
  if (p) {
    throw new SidekicksError(
      `journal lesson add: --title contains ${p.what} — ${p.why}; rephrase without it`,
      EXIT_VALIDATION
    );
  }

  const active = activeLessons(cfg);
  if (active.length >= MAX_ACTIVE_LESSONS) {
    throw new SidekicksError(
      `journal lesson add: the fleet pool already holds ${active.length} active lessons (cap ${MAX_ACTIVE_LESSONS}) — ` +
      "retire one first ('sidekicks journal lesson retire <LES-id> --why ...'): a bounded pool is what keeps lessons worth reading",
      EXIT_VALIDATION
    );
  }

  const tags = String(flags.tags ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const ts = zonedTimestamp(cfg.timezone);
  const { date, time, compact } = stampParts(ts);
  const id = mintId(cfg, 'lesson', 'LES', compact);
  const slug = slugify(title);
  const abs = expandLayout(cfg, 'lesson', { agent, date, time, slug, id });

  const content = buildEntry(
    {
      id,
      kind: 'lesson',
      agent,
      datetime: ts,
      title,
      slug,
      status: 'active',
      tags,
      retired_at: '',
    },
    [
      ['Lesson', body],
      ['Context', String(flags.context ?? '').trim()],
    ]
  );

  const { storeRel } = writeEntryFile(cfg, abs, content);
  appendIndexRow(cfg, {
    kind: 'lesson',
    id,
    agent,
    task_id: null,
    date,
    time,
    status: 'active',
    title,
    path: storeRel,
    related: [],
    ts,
  });

  const note = commitEntry(cfg, [abs, cfg.indexAbs], `journal(${agent}): lesson ${id} ${slug}`).note;
  const pushNote = maybePush(cfg, { boundary: false }).note;

  if (flags.json) {
    return { stdout: JSON.stringify({ id, agent, title, path: storeRel }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `lesson ${id} [active] → ${storeRel} (${active.length + 1}/${MAX_ACTIVE_LESSONS})${note}${pushNote}\n`, exitCode: EXIT_OK };
}

function listLessons(ctx, cfg, rest, flags) {
  const { repoRoot } = ctx;
  const agentTok = pickPositional(rest, ctx.argv, VALUE_FLAGS) || flags.agent;
  const agent = agentTok ? requireAgent(repoRoot, agentTok, 'journal lesson list') : null;
  const status = flags.status ? String(flags.status) : null;
  if (status && !LESSON_STATUSES.includes(status)) {
    throw new SidekicksError(
      `journal lesson list: invalid --status '${status}' — one of: ${LESSON_STATUSES.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  let rows = filterIndex(cfg, { kind: 'lesson', agent: agent || undefined, status: status || undefined })
    .sort(newestFirst);
  const limit = flags.limit != null && flags.limit !== '' ? Number(flags.limit) : null;
  if (limit != null) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new SidekicksError(`journal lesson list: invalid --limit '${flags.limit}' — a positive integer`, EXIT_VALIDATION);
    }
    rows = rows.slice(0, limit);
  }

  if (flags.json) return { stdout: JSON.stringify(rows, null, 2) + '\n', exitCode: EXIT_OK };
  if (rows.length === 0) return { stdout: 'journal lesson: none match\n', exitCode: EXIT_OK };
  return {
    stdout: renderRows(rows, [
      { header: 'ID',     get: (r) => r.id },
      { header: 'STATUS', get: (r) => r.status },
      { header: 'FROM',   get: (r) => r.agent },
      { header: 'DATE',   get: (r) => r.date },
      { header: 'TITLE',  get: (r) => String(r.title ?? '').slice(0, 60) },
    ]),
    exitCode: EXIT_OK,
  };
}

function requireLessonEntry(ctx, cfg, rest, verb) {
  const id = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  if (!id || !id.startsWith('LES-')) {
    throw new SidekicksError(`${verb}: a lesson <LES-id> is required — 'journal lesson list' shows them`, EXIT_VALIDATION);
  }
  const row = findIndexRow(cfg, 'lesson', id);
  if (!row) {
    throw new SidekicksError(`${verb}: no lesson '${id}' in the index — 'journal lesson list' shows them`, EXIT_VALIDATION);
  }
  const entry = readEntry(cfg, row.path);
  if (!entry) {
    throw new SidekicksError(`${verb}: the entry file for '${id}' (${row.path}) is missing — run 'journal rebuild'`, EXIT_VALIDATION);
  }
  return { row, entry };
}

function showLesson(ctx, cfg, rest, flags) {
  const { row, entry } = requireLessonEntry(ctx, cfg, rest, 'journal lesson show');
  if (flags.json) {
    return { stdout: JSON.stringify({ ...row, frontmatter: entry.frontmatter, body: entry.body }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `${row.path}\n\n${entry.body}\n`, exitCode: EXIT_OK };
}

function retireLesson(ctx, cfg, rest, flags) {
  const { row } = requireLessonEntry(ctx, cfg, rest, 'journal lesson retire');
  const why = String(flags.why ?? '').trim();
  if (!why) {
    throw new SidekicksError(
      'journal lesson retire: --why <s> is required — the retirement reason is what stops the lesson being re-filed',
      EXIT_VALIDATION
    );
  }
  if (row.status === 'retired') {
    return { stdout: `lesson ${row.id} is already retired — nothing to do\n`, exitCode: EXIT_OK };
  }
  const ts = zonedTimestamp(cfg.timezone);
  patchEntryFrontmatter(cfg, row.path, { status: 'retired', retired_at: ts, retired_because: why });
  updateIndexRow(cfg, 'lesson', row.id, { status: 'retired' });
  const note = commitEntry(cfg, [`${cfg.storeRoot}/${row.path}`, cfg.indexAbs], `journal(${row.agent}): lesson ${row.id} → retired`).note;
  return { stdout: `lesson ${row.id} [retired] — ${why}${note}\n`, exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------
// Wake injection — the read half of the loop
// ---------------------------------------------------------------------------

/**
 * Render the FLEET LESSONS block a delegate wake is primed with: the newest
 * `limit` active lessons, one clipped line each, hard-capped at `maxBytes`.
 * Pure over cfg (null cfg → ''), never throws — a broken lesson pool must not
 * cost a wake. The first line of each lesson's body rides along so the wake
 * gets the rule itself, not just a title to go look up.
 */
export function renderLessonsBlock(cfg, { limit = MAX_WAKE_LESSONS, maxBytes = MAX_LESSONS_BYTES } = {}) {
  if (!cfg) return '';
  let rows;
  try {
    rows = filterIndex(cfg, { kind: 'lesson', status: 'active' })
      .sort(newestFirst)
      .slice(0, limit);
  } catch {
    return '';
  }
  if (!rows.length) return '';

  const lines = ['FLEET LESSONS (standing guidance distilled from past runs — more: node bin/sidekicks journal lesson list):'];
  for (const row of rows) {
    let rule = '';
    try {
      const entry = readEntry(cfg, row.path);
      const m = /## Lesson\s*\n+([^\n]+)/.exec(entry?.body || '');
      rule = m ? m[1].trim() : '';
    } catch { /* title-only line */ }
    if (rule === '_(not recorded)_') rule = '';
    const line = `- [${row.id}] ${row.title}${rule ? `: ${rule}` : ''}`;
    lines.push(clipLine(line, 220));
  }

  let block = lines.join('\n');
  while (Buffer.byteLength(block, 'utf8') > maxBytes && lines.length > 1) {
    lines.pop();
    block = lines.join('\n');
  }
  return Buffer.byteLength(block, 'utf8') > maxBytes ? '' : block;
}

/** Clip one line to a byte budget without splitting a UTF-8 sequence. */
function clipLine(line, maxBytes) {
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return line;
  let s = line;
  while (Buffer.byteLength(s, 'utf8') > maxBytes - 1) s = s.slice(0, -1);
  return s + '…';
}
