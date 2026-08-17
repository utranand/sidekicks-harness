// lib/journal-lifecycle/log.mjs
// `sidekicks journal log <agent> [--task <id>] [--since 7d] [--limit 50] [--json]`
//
// L0 — the event log, and the SPINE of the whole journal. One append-only JSONL
// row per completed task, written by `agent complete` itself (see appendEvent
// below) rather than by a model following instructions. Every other layer joins
// back to these rows through `task_id`.
//
// Why deterministic: the layers this replaces were prose steps in two SKILL.md
// files, and an audit found zero retrospectives on disk after months of runs. A
// record that depends on the model remembering is a record that does not exist.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { EXIT_OK } from '../sk-cli/errors.mjs';
import {
  resolveJournalConfig,
  requireJournalConfig,
  requireLayer,
  requireAgent,
  parseMemoryFlags,
  zonedTimestamp,
  stampParts,
  parseSince,
  expandLayout,
  toStoreRel,
  appendJsonl,
  appendIndexRow,
  filterIndex,
  commitEntry,
  maybePush,
  renderRows,
  pickPositional,
} from './_shared.mjs';

/**
 * Append one L0 event row for a completed task.
 *
 * CONTRACT: this never throws and never returns a rejected promise. It is
 * called from inside `agent complete`, where any failure would turn a finished
 * task into a failed CLI invocation — the exact opposite of what a journal is
 * for. Every error path collapses to a note string.
 *
 * @param {string} repoRoot
 * @param {{ agent: string, msg: object, result: object }} p
 * @returns {{ logged: boolean, note: string, retroHint: string }}
 */
export function appendEvent(repoRoot, { agent, msg, result }) {
  const quiet = { logged: false, note: '', retroHint: '' };
  let cfg;
  try {
    cfg = resolveJournalConfig(repoRoot);
  } catch {
    return quiet;
  }
  if (!cfg) return quiet;
  const layer = cfg.layers.log;
  if (!layer || !layer.enabled) return quiet;

  try {
    const ts = zonedTimestamp(cfg.timezone);
    const { date, time } = stampParts(ts);
    const claimedAt = msg?.claim?.claimed_at ?? null;
    const started = claimedAt ? Date.parse(claimedAt) : NaN;
    const ended = Date.parse(result?.completed_at ?? ts);

    const row = {
      ts,
      agent,
      task_id: msg?.id ?? null,
      msg_kind: msg?.kind ?? null,
      category: msg?.category ?? null,
      assigner: msg?.from ?? null,
      goal: msg?.brief?.goal ?? '',
      isolation: msg?.brief?.isolation ?? null,
      status: result?.status ?? null,
      summary: result?.summary ?? '',
      branch: result?.branch ?? null,
      deliverables: Array.isArray(result?.deliverables) ? result.deliverables : [],
      claimed_at: claimedAt,
      completed_at: result?.completed_at ?? ts,
      duration_s: Number.isFinite(started) && Number.isFinite(ended)
        ? Math.max(0, Math.round((ended - started) / 1000))
        : null,
    };

    const abs = expandLayout(cfg, 'log', { agent, date, time });
    appendJsonl(cfg, abs, row);

    appendIndexRow(cfg, {
      kind: 'log',
      id: row.task_id,
      agent,
      task_id: row.task_id,
      date,
      time,
      status: row.status,
      title: row.summary || row.goal,
      path: toStoreRel(cfg, abs),
      related: [],
      ts,
    });

    const { note } = commitEntry(cfg, [abs, cfg.indexAbs],
      `journal(${agent}): log ${row.task_id} [${row.status}]`);
    // Never a boundary — a completion is the middle of a session, not its end.
    const pushNote = maybePush(cfg, { boundary: false }).note;

    const retroHint = cfg.layers.retro?.enabled
      ? `\nretro pending: sidekicks journal retro add ${agent} --task ${row.task_id} ` +
        `--status ${row.status} --problems "..."`
      : '';

    return { logged: true, note: note + pushNote, retroHint };
  } catch {
    return quiet;
  }
}

/**
 * Run `journal log` — read the event rows back.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string, rest?: string[] }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json']);
  const cfg = requireJournalConfig(repoRoot, 'journal log');
  requireLayer(cfg, 'log', 'journal log');

  const tokens = [args?.name, ...(args?.rest ?? [])].filter((t) => typeof t === 'string');
  const agentTok = pickPositional(tokens, ctx.argv, ['task', 'since', 'limit', 'status']);
  const agent = agentTok ? requireAgent(repoRoot, agentTok, 'journal log') : null;

  const now = zonedTimestamp(cfg.timezone);
  const since = parseSince(flags.since, now);
  const limit = Number.isInteger(Number(flags.limit)) && Number(flags.limit) > 0
    ? Number(flags.limit) : 50;

  // Read the JSONL files the index points at, so the payload is the full event
  // row (the index only carries the queryable subset).
  const pointers = filterIndex(cfg, {
    kind: 'log',
    agent: agent || undefined,
    since: since || undefined,
    task: flags.task ? String(flags.task) : undefined,
  });

  const wanted = new Set(pointers.map((p) => p.task_id));
  const files = [...new Set(pointers.map((p) => p.path))];
  const events = [];
  for (const rel of files) {
    const abs = `${cfg.storeRoot}/${rel}`.replace(/\\/g, '/');
    if (!existsSync(abs)) continue;
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (wanted.has(row.task_id)) events.push(row);
      } catch { /* skip torn line */ }
    }
  }
  events.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const shown = events.slice(0, limit);

  if (flags.json) {
    return { stdout: JSON.stringify(shown, null, 2) + '\n', exitCode: EXIT_OK };
  }
  if (shown.length === 0) {
    return { stdout: 'journal log: no events match\n', exitCode: EXIT_OK };
  }
  const table = renderRows(shown, [
    { header: 'WHEN',   get: (r) => `${String(r.ts).slice(0, 10)} ${String(r.ts).slice(11, 16)}` },
    { header: 'AGENT',  get: (r) => r.agent },
    { header: 'STATUS', get: (r) => r.status },
    { header: 'SECS',   get: (r) => (r.duration_s == null ? '-' : r.duration_s) },
    { header: 'TASK',   get: (r) => r.task_id },
    { header: 'SUMMARY',get: (r) => (r.summary || r.goal || '').slice(0, 60) },
  ]);
  const more = events.length > shown.length ? `\n(${events.length - shown.length} older hidden — raise --limit)\n` : '';
  return { stdout: table + more, exitCode: EXIT_OK };
}
