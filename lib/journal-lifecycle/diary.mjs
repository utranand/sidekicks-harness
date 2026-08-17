// lib/journal-lifecycle/diary.mjs
// `sidekicks journal diary write|show`
//
// L4 — one self-review per agent per day. Unlike the other layers this is
// per-DAY, not per-event: a second write on the same day appends an addendum
// section rather than creating a second file, so "the day" stays one document.
//
// The diary is also the natural PUSH BOUNDARY. Under `git.push: "boundary"` the
// per-entry writes only commit; this is the call that ships the day's record to
// the remote, so a headless agent is not doing an outward network write once per
// completed task.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
import { parseEntryFile, stripEmbeddedFrontmatter } from '../memory-lifecycle/_shared.mjs';
import { resolveAgentMemoryDir } from '../active-scope/memory-paths.mjs';
import {
  requireJournalConfig,
  requireLayer,
  requireAgent,
  parseMemoryFlags,
  takeSubVerb,
  pickPositional,
  zonedTimestamp,
  stampParts,
  expandLayout,
  buildEntry,
  writeEntryFile,
  readEntry,
  toStoreRel,
  appendIndexRow,
  updateIndexRow,
  filterIndex,
  findIndexRow,
  commitEntry,
  maybePush,
} from './_shared.mjs';

const SUBS = ['write', 'show'];
const VALUE_FLAGS = ['day', 'incidents', 'well', 'improve', 'tomorrow', 'date'];
const BUFFER_SLUG = 'diary-buffer';

export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'from-buffer']);
  const cfg = requireJournalConfig(repoRoot, 'journal diary');
  requireLayer(cfg, 'diary', 'journal diary');
  const { sub, rest } = takeSubVerb(args, SUBS, 'journal diary');

  if (sub === 'write') return writeDiary(ctx, cfg, rest, flags);
  return showDiary(ctx, cfg, rest, flags);
}

function writeDiary(ctx, cfg, rest, flags) {
  const { repoRoot } = ctx;
  const agentTok = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  const agent = requireAgent(repoRoot, agentTok, 'journal diary write');

  const ts = zonedTimestamp(cfg.timezone);
  const { date, time } = stampParts(ts);

  // The day's narrative: explicit --day wins; otherwise consolidate the agent's
  // intraday buffer, which is what survives a session death.
  const buffer = flags['from-buffer'] ? readBuffer(repoRoot, agent) : null;
  const day = String(flags.day ?? '').trim() || buffer?.body || '';
  if (!day) {
    throw new SidekicksError(
      'journal diary write: --day <s> is required (or --from-buffer to consolidate the agent\'s ' +
      'diary-buffer memory entry)',
      EXIT_VALIDATION
    );
  }

  // Today's incidents, auto-linked — the agent should not have to remember what
  // it filed hours ago, and a hand-typed list is a list that goes stale.
  const todaysIncidents = filterIndex(cfg, { kind: 'incident', agent, since: date })
    .filter((r) => r.date === date);
  const autoIncidents = todaysIncidents.length
    ? todaysIncidents.map((r) => `- ${r.id} — ${r.title} (\`${r.path}\`)`).join('\n')
    : 'None.';
  const incidents = String(flags.incidents ?? '').trim()
    ? `${String(flags.incidents).trim()}\n\n${autoIncidents}`
    : autoIncidents;

  const abs = expandLayout(cfg, 'diary', { agent, date, time, slug: date, id: date });
  const storeRel = toStoreRel(cfg, abs);
  const existing = readEntry(cfg, storeRel);

  let content;
  let verb;
  if (existing) {
    // One diary per day — a later session appends, never forks the record.
    const addendum = [
      `## Addendum (${ts.slice(11, 16)})`,
      '',
      day.trim(),
      ...(String(flags.well ?? '').trim() ? ['', `**Went well:** ${String(flags.well).trim()}`] : []),
      ...(String(flags.improve ?? '').trim() ? ['', `**Improve:** ${String(flags.improve).trim()}`] : []),
      ...(String(flags.tomorrow ?? '').trim() ? ['', `**Tomorrow:** ${String(flags.tomorrow).trim()}`] : []),
    ].join('\n');
    const fm = { ...(existing.frontmatter || {}), updated_at: ts };
    content = `---\n${yaml.serialize(fm)}---\n\n${existing.body}\n\n${addendum}\n`;
    verb = 'addendum';
  } else {
    content = buildEntry(
      { agent, date, kind: 'diary', written_at: ts, updated_at: ts },
      [
        ['The day', day],
        ['Incidents', incidents],
        ['What went well', flags.well],
        ['What can be improved (self)', flags.improve],
        ['Tomorrow — do / don\'t', flags.tomorrow],
      ]
    );
    verb = 'diary';
  }

  writeEntryFile(cfg, abs, content);
  if (existing) {
    updateIndexRow(cfg, 'diary', `${agent}/${date}`, { ts, status: 'addendum' });
  } else {
    appendIndexRow(cfg, {
      kind: 'diary',
      id: `${agent}/${date}`,
      agent,
      task_id: null,
      date,
      time,
      status: 'written',
      title: `diary ${date}`,
      path: storeRel,
      related: todaysIncidents.map((r) => r.id),
      ts,
    });
  }

  // Consolidated — reset the buffer so tomorrow starts clean. Only the body is
  // rewritten; the entry's frontmatter and MEMORY.md pointer stay valid.
  let bufferNote = '';
  if (buffer) {
    bufferNote = resetBuffer(repoRoot, buffer, date) ? ' — buffer reset' : ' — buffer NOT reset (write failed)';
  }

  const note = commitEntry(cfg, [abs, cfg.indexAbs], `journal(${agent}): ${verb} ${date}`).note;
  // THE boundary: this is where a `push: "boundary"` store reaches its remote.
  const pushNote = maybePush(cfg, { boundary: true }).note;

  if (flags.json) {
    return { stdout: JSON.stringify({ agent, date, path: storeRel, mode: verb }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `${verb} ${agent} ${date} → ${storeRel}${bufferNote}${note}${pushNote}\n`, exitCode: EXIT_OK };
}

function showDiary(ctx, cfg, rest, flags) {
  const { repoRoot } = ctx;
  const tokens = rest.filter((t) => typeof t === 'string');
  const agentTok = pickPositional(tokens, ctx.argv, VALUE_FLAGS);
  const agent = requireAgent(repoRoot, agentTok, 'journal diary show');
  const date = tokens.find((t) => /^\d{4}-\d{2}-\d{2}$/.test(t))
    || String(flags.date ?? '').trim()
    || stampParts(zonedTimestamp(cfg.timezone)).date;

  const row = findIndexRow(cfg, 'diary', `${agent}/${date}`);
  if (!row) {
    throw new SidekicksError(`journal diary show: no diary for ${agent} on ${date}`, EXIT_NOT_FOUND);
  }
  const entry = readEntry(cfg, row.path);
  if (!entry) {
    throw new SidekicksError(
      `journal diary show: index points at '${row.path}' but the file is gone — run 'sidekicks journal rebuild'`,
      EXIT_NOT_FOUND
    );
  }
  if (flags.json) {
    return { stdout: JSON.stringify({ ...row, frontmatter: entry.frontmatter, body: entry.body }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `${row.path}\n\n${entry.body}\n`, exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------
// Intraday buffer — the agent's own memory entry, read here and reset on
// consolidation. Read/written directly (not through `sidekicks memory`) because
// only the BODY changes: the frontmatter and the MEMORY.md pointer line stay
// exactly as the memory verbs wrote them.
// ---------------------------------------------------------------------------

function bufferPath(repoRoot, agent) {
  // Resolved through memory-paths, not rebuilt here: this was a third independent
  // construction of the agent memory location, and the kind of duplication that quietly
  // keeps reading the pre-central directory after the store has moved.
  return join(resolveAgentMemoryDir(repoRoot, agent).baseDir, `${BUFFER_SLUG}.md`);
}

function readBuffer(repoRoot, agent) {
  const abs = bufferPath(repoRoot, agent);
  if (!existsSync(abs)) {
    throw new SidekicksError(
      `journal diary write: --from-buffer needs a '${BUFFER_SLUG}' memory entry for '${agent}' — ` +
      `create it with 'sidekicks memory add ${BUFFER_SLUG} --agent ${agent} --type=context ` +
      `--description="intraday diary buffer" --body="..."'`,
      EXIT_NOT_FOUND
    );
  }
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new SidekicksError(`journal diary write: cannot read the diary buffer: ${err.message}`, EXIT_VALIDATION);
  }
  const parsed = parseEntryFile(text);
  // Repair-on-read: a buffer damaged by a past model-held read-modify-write
  // cycle carries stacked/torn frontmatter blocks inside the body — strip them
  // so they never get consolidated into a diary as header junk.
  return { abs, frontmatter: parsed.frontmatter, body: stripEmbeddedFrontmatter(parsed.body) };
}

function resetBuffer(repoRoot, buffer, date) {
  try {
    assertWritable(buffer.abs, repoRoot);
    const fm = yaml.serialize(buffer.frontmatter || {});
    writeAtomic(buffer.abs, `---\n${fm}---\n\n(empty — consolidated ${date})\n`);
    return true;
  } catch {
    return false;
  }
}
