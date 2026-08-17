// lib/journal-lifecycle/rebuild.mjs
// `sidekicks journal rebuild [--dry-run] [--json]`
//
// Re-derive index.jsonl from what is actually on disk. The index is a cache of
// the entry frontmatter, so disk always wins: this is the self-heal after a
// manual edit, a partial sync, a merge, or a torn append.
//
// Mirrors `sidekicks memory rebuild` in intent — same "regenerate the index from
// entry frontmatter" contract, applied across six layers instead of one store.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../sk-cli/errors.mjs';
import {
  requireJournalConfig,
  parseMemoryFlags,
  readEntry,
  readIndex,
  writeIndex,
  walkLayerFiles,
  commitEntry,
  zonedTimestamp,
} from './_shared.mjs';

export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'dry-run']);
  const cfg = requireJournalConfig(repoRoot, 'journal rebuild');

  const rows = [];

  // L0 — one row per event line, across every daily .jsonl.
  if (cfg.layers.log.enabled) {
    for (const rel of walkLayerFiles(cfg, 'log', ['.jsonl'])) {
      const abs = join(cfg.storeRoot, rel);
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const ts = String(e.ts ?? '');
        rows.push({
          kind: 'log',
          id: e.task_id ?? null,
          agent: e.agent ?? null,
          task_id: e.task_id ?? null,
          date: ts.slice(0, 10),
          time: ts.slice(11, 13) + ts.slice(14, 16),
          status: e.status ?? null,
          title: e.summary || e.goal || '',
          path: rel,
          related: [],
          ts,
        });
      }
    }
  }

  // L1–L5 — one row per markdown entry, read straight from its frontmatter.
  for (const [kind, derive] of Object.entries(DERIVERS)) {
    if (!cfg.layers[kind]?.enabled) continue;
    for (const rel of walkLayerFiles(cfg, kind, ['.md'])) {
      const entry = readEntry(cfg, rel);
      if (!entry) continue;
      const fm = entry.frontmatter && typeof entry.frontmatter === 'object' ? entry.frontmatter : {};
      const row = derive(fm, rel);
      if (row) rows.push({ ...row, kind, path: rel });
    }
  }

  // Time-ordered so the file reads like a history and `mintId` sees the max.
  rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const before = readIndex(cfg).length;
  const summary = { before, after: rows.length, by_kind: countBy(rows) };

  if (flags['dry-run']) {
    return {
      stdout: flags.json
        ? JSON.stringify({ dry_run: true, ...summary }, null, 2) + '\n'
        : `journal rebuild --dry-run: ${before} → ${rows.length} rows (${renderCounts(summary.by_kind)})\n`,
      exitCode: EXIT_OK,
    };
  }

  writeIndex(cfg, rows);
  const note = commitEntry(cfg, [cfg.indexAbs], `journal: rebuild index (${rows.length} rows)`).note;

  if (flags.json) {
    return { stdout: JSON.stringify(summary, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return {
    stdout: `journal rebuild: ${before} → ${rows.length} rows (${renderCounts(summary.by_kind)})${note}\n`,
    exitCode: EXIT_OK,
  };
}

// Per-layer frontmatter → index row. Each layer's id convention is defined here
// and nowhere else, so a rebuild reproduces the ids the write verbs minted
// rather than renumbering history.
const DERIVERS = {
  retro: (fm, rel) => ({
    id: fm.task_id ?? relSlug(rel),
    agent: fm.agent ?? null,
    task_id: fm.task_id ?? null,
    date: stampDate(fm.datetime),
    time: stampTime(fm.datetime),
    status: fm.status ?? null,
    title: fm.assignment ?? '',
    related: [],
    ts: fm.datetime ?? '',
  }),
  incident: (fm, rel) => ({
    // Entries hand-written before the id convention carry no `id`. Falling back
    // to the filename keeps them addressable — a row with a null id is a row no
    // `show`/`resolve` can ever reach, which is worse than an unconventional id.
    id: fm.id ?? relSlug(rel),
    agent: fm.agent ?? null,
    task_id: fm.task_id || null,
    date: stampDate(fm.datetime),
    time: stampTime(fm.datetime),
    status: fm.status ?? 'open',
    title: fm.subject ?? '',
    related: fm.issue ? [fm.issue] : [],
    ts: fm.datetime ?? '',
  }),
  issue: (fm, rel) => ({
    id: fm.id ?? relSlug(rel),
    agent: fm.owner || null,
    task_id: null,
    date: stampDate(fm.opened_at),
    time: stampTime(fm.opened_at),
    status: fm.status ?? 'open',
    title: fm.title ?? '',
    related: fm.from_incident ? [fm.from_incident] : [],
    ts: fm.opened_at ?? '',
  }),
  improve: (fm, rel) => ({
    id: fm.id ?? relSlug(rel),
    agent: fm.agent ?? null,
    task_id: null,
    date: stampDate(fm.datetime),
    time: stampTime(fm.datetime),
    status: fm.status ?? 'proposed',
    title: fm.title ?? '',
    related: [],
    ts: fm.datetime ?? '',
  }),
  diary: (fm, rel) => ({
    id: fm.agent && fm.date ? `${fm.agent}/${fm.date}` : rel.replace(/\.md$/, '').split('/').slice(-2).join('/'),
    agent: fm.agent ?? null,
    task_id: null,
    date: fm.date ?? stampDate(fm.written_at),
    time: stampTime(fm.written_at),
    status: fm.updated_at && fm.updated_at !== fm.written_at ? 'addendum' : 'written',
    title: `diary ${fm.date ?? ''}`.trim(),
    related: [],
    ts: fm.written_at ?? '',
  }),
  lesson: (fm, rel) => ({
    id: fm.id ?? relSlug(rel),
    agent: fm.agent ?? null,
    task_id: null,
    date: stampDate(fm.datetime),
    time: stampTime(fm.datetime),
    status: fm.status ?? 'active',
    title: fm.title ?? '',
    related: [],
    ts: fm.datetime ?? '',
  }),
  // L7 — the one deriver that emits NO `status`. A mission's current state is
  // folded from its event shards, so a status in the shared index would be a
  // second, stale answer that nobody could keep current without rewriting the
  // whole index on every step.
  mission: (fm, rel) => ({
    id: fm.id ?? relSlug(rel),
    agent: fm.agent ?? null,
    task_id: null,
    date: stampDate(fm.created_at),
    time: stampTime(fm.created_at),
    initial_status: fm.initial_status ?? 'proposed',
    title: fm.title ?? '',
    related: Array.isArray(fm.related) ? fm.related : [],
    ts: fm.created_at ?? '',
    node: fm.node ?? '',
  }),
};

function stampDate(ts) { return String(ts ?? '').slice(0, 10); }
function stampTime(ts) { const s = String(ts ?? ''); return s.slice(11, 13) + s.slice(14, 16); }
function relSlug(rel) { return String(rel).split('/').pop().replace(/\.md$/, ''); }

function countBy(rows) {
  const out = {};
  for (const r of rows) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}
function renderCounts(by) {
  const parts = Object.entries(by).map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(', ') : 'empty';
}
