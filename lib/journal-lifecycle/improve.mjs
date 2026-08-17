// lib/journal-lifecycle/improve.mjs
// `sidekicks journal improve add|list|show|apply|reject`
//
// L5 — agent self-improvement: a proposed change to an AGENT's charter.
//
// This is deliberately NOT the same funnel as `sk-self-improve`, which
// improves SKILLS. The two are different objects with different blast radii: a
// skill change affects every caller in the repo; a charter change affects one
// agent's standing behavior. Until now the charter side had no mechanism at all
// — `improvement: { enabled: false }` was written into every charter by
// `agent create` and read by nothing. `apply` below is its first real reader.
//
// The gate is the charter's own switch: an agent whose `improvement.enabled` is
// false can still HAVE proposals filed against it (a proposal is inert), but
// nothing will edit its charter automatically. That keeps "record the lesson"
// cheap and "change the agent" deliberate.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { readCharter, writeCharter, charterPath } from '../agent-lifecycle/_shared.mjs';
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
  IMPROVE_TARGETS,
  IMPROVE_STATUSES,
} from './_shared.mjs';

const SUBS = ['add', 'list', 'show', 'apply', 'reject'];
const VALUE_FLAGS = ['target', 'title', 'change', 'why', 'field', 'status', 'agent'];

// Charter fields a proposal may touch. List fields APPEND the change; scalar
// fields REPLACE it. Everything else (name, status, categories, cli, model) is
// structural — those move through `agent create`/`agent retire`, never here.
const LIST_FIELDS = ['goals', 'principles', 'routines', 'expertise'];
const SCALAR_FIELDS = ['specialty', 'persona', 'mission', 'output_contract'];
const APPLIABLE_FIELDS = [...LIST_FIELDS, ...SCALAR_FIELDS];

export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json']);
  const cfg = requireJournalConfig(repoRoot, 'journal improve');
  requireLayer(cfg, 'improve', 'journal improve');
  const { sub, rest } = takeSubVerb(args, SUBS, 'journal improve');

  if (sub === 'add') return addImprovement(ctx, cfg, rest, flags);
  if (sub === 'list') return listImprovements(ctx, cfg, rest, flags);
  if (sub === 'show') return showImprovement(ctx, cfg, rest, flags);
  if (sub === 'apply') return applyImprovement(ctx, cfg, rest, flags);
  return rejectImprovement(ctx, cfg, rest, flags);
}

function addImprovement(ctx, cfg, rest, flags) {
  const { repoRoot } = ctx;
  const agentTok = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  const agent = requireAgent(repoRoot, agentTok, 'journal improve add');

  const target = String(flags.target ?? '').trim();
  if (!IMPROVE_TARGETS.includes(target)) {
    throw new SidekicksError(
      `journal improve add: --target is required — one of: ${IMPROVE_TARGETS.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  const title = String(flags.title ?? '').trim();
  const change = String(flags.change ?? '').trim();
  const why = String(flags.why ?? '').trim();
  for (const [flag, value] of [['--title', title], ['--change', change], ['--why', why]]) {
    if (!value) {
      throw new SidekicksError(
        `journal improve add: ${flag} <s> is required — a proposal without it cannot be judged later`,
        EXIT_VALIDATION
      );
    }
  }

  const field = flags.field ? String(flags.field).trim() : '';
  if (target === 'charter' && field && !APPLIABLE_FIELDS.includes(field)) {
    throw new SidekicksError(
      `journal improve add: --field '${field}' is not applicable — one of: ${APPLIABLE_FIELDS.join(', ')} ` +
      '(structural fields change through `agent create` / `agent retire`)',
      EXIT_VALIDATION
    );
  }

  const ts = zonedTimestamp(cfg.timezone);
  const { date, time, compact } = stampParts(ts);
  const id = mintId(cfg, 'improve', 'IMP', compact);
  const slug = slugify(title);
  const abs = expandLayout(cfg, 'improve', { agent, date, time, slug, id });

  const content = buildEntry(
    {
      id,
      agent,
      datetime: ts,
      kind: 'improvement',
      target,
      field,
      title,
      status: 'proposed',
      decided_at: '',
    },
    [
      ['Proposed change', change],
      ['Why', why],
      ['Decision', ''],
    ]
  );

  const { storeRel } = writeEntryFile(cfg, abs, content);
  appendIndexRow(cfg, {
    kind: 'improve',
    id,
    agent,
    task_id: null,
    date,
    time,
    status: 'proposed',
    title,
    path: storeRel,
    related: [],
    ts,
  });

  const note = commitEntry(cfg, [abs, cfg.indexAbs], `journal(${agent}): improve ${id} ${slug}`).note;
  const pushNote = maybePush(cfg, { boundary: false }).note;

  if (flags.json) {
    return { stdout: JSON.stringify({ id, agent, target, field, path: storeRel }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `improve ${id} [proposed] → ${storeRel}${note}${pushNote}\n`, exitCode: EXIT_OK };
}

function listImprovements(ctx, cfg, rest, flags) {
  const { repoRoot } = ctx;
  const agentTok = pickPositional(rest, ctx.argv, VALUE_FLAGS) || flags.agent;
  const agent = agentTok ? requireAgent(repoRoot, agentTok, 'journal improve list') : null;
  const status = flags.status ? String(flags.status) : null;
  if (status && !IMPROVE_STATUSES.includes(status)) {
    throw new SidekicksError(
      `journal improve list: invalid --status '${status}' — one of: ${IMPROVE_STATUSES.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  const rows = filterIndex(cfg, { kind: 'improve', agent: agent || undefined, status: status || undefined })
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  if (flags.json) return { stdout: JSON.stringify(rows, null, 2) + '\n', exitCode: EXIT_OK };
  if (rows.length === 0) return { stdout: 'journal improve: none match\n', exitCode: EXIT_OK };
  return {
    stdout: renderRows(rows, [
      { header: 'ID',     get: (r) => r.id },
      { header: 'STATUS', get: (r) => r.status },
      { header: 'AGENT',  get: (r) => r.agent },
      { header: 'DATE',   get: (r) => r.date },
      { header: 'TITLE',  get: (r) => String(r.title ?? '').slice(0, 60) },
    ]),
    exitCode: EXIT_OK,
  };
}

function showImprovement(ctx, cfg, rest, flags) {
  const { row, entry } = requireEntry(ctx, cfg, rest, 'journal improve show');
  if (flags.json) {
    return { stdout: JSON.stringify({ ...row, frontmatter: entry.frontmatter, body: entry.body }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `${row.path}\n\n${entry.body}\n`, exitCode: EXIT_OK };
}

function applyImprovement(ctx, cfg, rest, flags) {
  const { repoRoot } = ctx;
  const { row, entry } = requireEntry(ctx, cfg, rest, 'journal improve apply');
  const fm = entry.frontmatter || {};

  if (row.status !== 'proposed') {
    throw new SidekicksError(
      `journal improve apply: ${row.id} is already [${row.status}] — only a proposed improvement can be applied`,
      EXIT_VALIDATION
    );
  }
  if (fm.target !== 'charter') {
    throw new SidekicksError(
      `journal improve apply: ${row.id} targets '${fm.target}', which this verb does not edit — ` +
      (fm.target === 'skill'
        ? 'route skill changes through the sk-self-improve funnel'
        : "change scheduled routines with 'sidekicks agent routine'"),
      EXIT_VALIDATION
    );
  }
  const field = String(fm.field ?? '');
  if (!APPLIABLE_FIELDS.includes(field)) {
    throw new SidekicksError(
      `journal improve apply: ${row.id} names no applicable charter field ` +
      `(frontmatter field: '${field || '(none)'}') — re-file it with --field <${APPLIABLE_FIELDS.join('|')}>`,
      EXIT_VALIDATION
    );
  }

  const charter = readCharter(repoRoot, row.agent);
  if (!charter) {
    throw new SidekicksError(`journal improve apply: agent '${row.agent}' no longer exists`, EXIT_NOT_FOUND);
  }
  // THE gate. `improvement.enabled` finally decides something.
  if (!charter.improvement || charter.improvement.enabled !== true) {
    throw new SidekicksError(
      `journal improve apply: '${row.agent}' has improvement.enabled = false in its charter, so its ` +
      'behavior is not auto-editable — the proposal stays on file. Flip the switch in ' +
      `${charterPath(repoRoot, row.agent).split(/[\\/]/).slice(-4).join('/')} to allow applies.`,
      EXIT_VALIDATION
    );
  }

  const change = extractSection(entry.body, 'Proposed change');
  if (!change) {
    throw new SidekicksError(
      `journal improve apply: ${row.id} has no readable 'Proposed change' section`,
      EXIT_VALIDATION
    );
  }

  const before = charter[field];
  if (LIST_FIELDS.includes(field)) {
    const list = Array.isArray(before) ? [...before] : [];
    if (list.includes(change)) {
      return { stdout: `improve ${row.id}: '${change}' is already in ${field} — nothing to apply\n`, exitCode: EXIT_OK };
    }
    list.push(change);
    charter[field] = list;
  } else {
    charter[field] = change;
  }
  // Poison-guarded: a proposal whose change text would brick the charter yaml
  // throws HERE, before the entry flips to applied — it safely stays proposed.
  writeCharter(repoRoot, row.agent, charter, 'journal improve apply');

  const ts = zonedTimestamp(cfg.timezone);
  patchEntryFrontmatter(cfg, row.path, { status: 'applied', decided_at: ts });
  updateIndexRow(cfg, 'improve', row.id, { status: 'applied' });

  const note = commitEntry(cfg, [`${cfg.storeRoot}/${row.path}`, cfg.indexAbs],
    `journal(${row.agent}): improve ${row.id} → applied`).note;
  const pushNote = maybePush(cfg, { boundary: false }).note;

  // The charter itself lives in the WORKSPACE repo, not the journal store, so it
  // is left staged-free for the human to review and commit with the rest of
  // their work — an agent must not quietly commit a change to its own behavior.
  return {
    stdout:
      `improve ${row.id} [applied] — ${row.agent}.${field} updated${note}${pushNote}\n` +
      `charter edit is UNCOMMITTED in the workspace repo — review it: ` +
      `git diff -- .sidekicks/agents/${row.agent}/agent.yaml\n`,
    exitCode: EXIT_OK,
  };
}

function rejectImprovement(ctx, cfg, rest, flags) {
  const { row } = requireEntry(ctx, cfg, rest, 'journal improve reject');
  const why = String(flags.why ?? '').trim();
  if (!why) {
    throw new SidekicksError(
      'journal improve reject: --why <s> is required — a rejection nobody explained gets re-proposed next week',
      EXIT_VALIDATION
    );
  }
  if (row.status !== 'proposed') {
    throw new SidekicksError(
      `journal improve reject: ${row.id} is already [${row.status}]`,
      EXIT_VALIDATION
    );
  }
  const ts = zonedTimestamp(cfg.timezone);
  patchEntryFrontmatter(cfg, row.path, { status: 'rejected', decided_at: ts, rejected_because: why });
  updateIndexRow(cfg, 'improve', row.id, { status: 'rejected' });

  const note = commitEntry(cfg, [`${cfg.storeRoot}/${row.path}`, cfg.indexAbs],
    `journal(${row.agent}): improve ${row.id} → rejected`).note;
  const pushNote = maybePush(cfg, { boundary: false }).note;
  return { stdout: `improve ${row.id} [rejected]${note}${pushNote}\n`, exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------

function requireEntry(ctx, cfg, rest, verb) {
  const id = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  const row = id ? findIndexRow(cfg, 'improve', id) : null;
  if (!row) throw new SidekicksError(`${verb}: no improvement '${id ?? ''}'`, EXIT_NOT_FOUND);
  const entry = readEntry(cfg, row.path);
  if (!entry) {
    throw new SidekicksError(
      `${verb}: index points at '${row.path}' but the file is gone — run 'sidekicks journal rebuild'`,
      EXIT_NOT_FOUND
    );
  }
  return { row, entry };
}

/** Pull one `## Heading` section's text out of an entry body. */
function extractSection(body, heading) {
  const lines = String(body ?? '').split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break;
    out.push(lines[i]);
  }
  const text = out.join('\n').trim();
  return text === '_(not recorded)_' ? '' : text;
}
