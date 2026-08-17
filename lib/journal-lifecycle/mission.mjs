// lib/journal-lifecycle/mission.mjs
// `sidekicks journal mission open|propose|approve|reject|plan|event|verify|
//                       classify|resolve|close|next|list|show|doctor`
//
// L7 — an agent's own STANDING WORK: a goal, its plan, its progress, its
// verdicts, its outcome. The layer that lets a persistent agent on a CLI with no
// session resume pick up where it left off, because the answer to "what next"
// is on disk instead of in a context window that no longer exists.
//
// Three properties, in the order they matter:
//
//   1. THE SCRIPT DECIDES, NOT THE MODEL. `mission next` returns exactly one
//      action, and the wake obeys it. A cold session is then equivalent to a warm
//      one — it cannot improvise a plan the store does not hold.
//   2. THE RECORD IS THE SOURCE OF TRUTH. `mission.md` is written once and never
//      touched again; every mutation is one appended row in
//      `events/<node>.jsonl`. Current status is FOLDED (see _mission.mjs), never
//      read from frontmatter and never stored in the shared index — which is why
//      no write here ever rewrites a file another machine may own.
//   3. STATE LIVES ON DISK, NOT IN CONTEXT. A mission proposed in one wake is
//      almost always approved by a different, memory-less session, so every
//      binding is an explicit id in the text — never "the only open mission".
//
// `next` is READ-ONLY by contract: no write, no commit, no push, and exit 0 even
// when the answer is `idle`. Orientation that writes would make a wake's first
// act a git operation.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
import {
  requireJournalConfig,
  requireLayer,
  requireAgent,
  validateAgentSlug,
  parseMemoryFlags,
  takeSubVerb,
  pickPositional,
  zonedTimestamp,
  stampParts,
  slugify,
  mintNodeId,
  resolveNodeId,
  missionTuning,
  buildEntry,
  writeEntryFile,
  appendIndexRow,
  appendJsonl,
  filterIndex,
  commitEntry,
  maybePush,
  renderRows,
  MISSION_EVENT_TYPES,
  MISSION_LANE_RE,
  MISSION_STEP_RE,
  MISSION_STATUSES,
  MISSION_MAX_STEP_ATTEMPTS,
  MAX_STEPS_PER_MISSION,
  MAX_EVENTS_PER_MISSION,
  MAX_MISSION_TITLE_LEN,
  MAX_MISSION_NOTE_LEN,
  MAX_MISSION_TEXT_LEN,
} from './_shared.mjs';
import {
  foldStatus,
  decideNext,
  loadMission,
  loadMissions,
  missionDirAbs,
  missionEventsShard,
  resolveAgentLane,
  readMissionEvents,
  nextSeqForNode,
  nextStepId,
  isLive,
  stepLeaseState,
  stepLeaseTtlMs,
  diaryWrittenToday,
  missionFindings,
} from './_mission.mjs';
import { collectFindings } from './doctor.mjs';

const SUBS = [
  'open', 'propose', 'approve', 'reject', 'plan', 'event', 'verify',
  'classify', 'resolve', 'close', 'next', 'list', 'show', 'doctor',
];

/**
 * Flags whose space-form value `parseArgs` leaks into positionals, so
 * pickPositional can ignore it when hunting for the id on the line.
 */
const VALUE_FLAGS = [
  'title', 'why', 'goal', 'goal-file', 'dod', 'out-of-scope', 'origin', 'requested-by',
  'priority', 'due', 'tags', 'related', 'step', 'after', 'drop', 'type', 'verdict',
  'evidence', 'reason', 'note', 'question', 'answer', 'outcome', 'summary', 'by',
  'status', 'agent', 'lane', 'gate', 'acceptance', 'text', 'resolution', 'mode',
  'cooldown-hours', 'now', 'limit',
];

/**
 * Text-bearing flags MUST use the equals form.
 *
 * A goal, a reason or a verdict legitimately contains `--` (`--- a/file.txt`,
 * "pass --force to the script"), and parseMemoryFlags treats any `--`-prefixed
 * token as a new flag — so the space form silently shreds real text. thread.mjs
 * hit this first with chat messages; the same rule applies here, and it is
 * enforced rather than merely documented.
 */
const EQUALS_ONLY = ['title', 'why', 'goal', 'dod', 'out-of-scope', 'note', 'reason',
  'summary', 'question', 'answer', 'evidence', 'acceptance', 'text', 'step'];

/** The mission id token: MIS-YYYYMMDD-<node>-NN. Disjoint from the plan gate's P-xxx. */
export const MISSION_TOKEN_RE = /\bMIS-\d{8}-[a-z0-9][a-z0-9-]{0,15}-\d{2}\b/i;

/**
 * What a user may say to a mission decision. NONE of these is a bare affirmative
 * or negative, deliberately: `go`, `ok`, `yes`, `approve`, `proceed`, `confirm`,
 * `no`, `stop`, `abort` and `cancel` all live inside the dry-run plan gate's own
 * reply grammar, which binds a bare verdict to the sole pending plan across a
 * shared tree WITHOUT checking which agent recorded it. Zero lexical overlap is
 * cheaper than reasoning about precedence later.
 *
 *   accept | revise | shelve   answer a proposed goal
 *   close  | continue          answer a definition-of-done verdict
 *   release | hold             answer a gate on ONE named step (needs --step)
 */
const RESOLUTIONS = ['accept', 'revise', 'shelve', 'close', 'continue', 'release', 'hold'];

/** Resolutions recorded as an `answer` event rather than a status transition. */
const ANSWER_RESOLUTIONS = new Set(['close', 'continue', 'release', 'hold']);

/** Resolutions that only mean something against a specific step. */
const STEP_RESOLUTIONS = new Set(['release', 'hold']);

export async function run(ctx, args) {
  const flags = parseMemoryFlags(ctx.argv, ['json', 'events', 'all', 'force', 'start', 'standing']);
  const cfg = requireJournalConfig(ctx.repoRoot, 'journal mission');
  requireLayer(cfg, 'mission', 'journal mission');
  const { sub, rest } = takeSubVerb(args, SUBS, 'journal mission');
  assertEqualsForm(ctx.argv, `journal mission ${sub}`);

  if (sub === 'next') return cmdNext(ctx, cfg, rest, flags);
  if (sub === 'list') return cmdList(ctx, cfg, rest, flags);
  if (sub === 'show') return cmdShow(ctx, cfg, rest, flags);
  if (sub === 'doctor') return cmdDoctor(ctx, cfg, rest, flags);
  if (sub === 'classify') return cmdClassify(ctx, cfg, rest, flags);

  // Everything below WRITES, so it needs a usable node id.
  const node = requireNode(cfg);
  if (sub === 'open' || sub === 'propose') return cmdCreate(ctx, cfg, rest, flags, node, sub);
  if (sub === 'plan') return cmdPlan(ctx, cfg, rest, flags, node);
  if (sub === 'event') return cmdEvent(ctx, cfg, rest, flags, node);
  if (sub === 'verify') return cmdVerify(ctx, cfg, rest, flags, node);
  if (sub === 'approve') return cmdSimple(ctx, cfg, rest, flags, node, 'approve');
  if (sub === 'reject') return cmdSimple(ctx, cfg, rest, flags, node, 'reject');
  if (sub === 'resolve') return cmdResolve(ctx, cfg, rest, flags, node);
  return cmdClose(ctx, cfg, rest, flags, node);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function assertEqualsForm(argv, verb) {
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string' || !tok.startsWith('--') || tok.includes('=')) continue;
    const key = tok.slice(2);
    if (!EQUALS_ONLY.includes(key)) continue;
    const next = list[i + 1];
    if (next === undefined || next.startsWith('--')) continue;
    throw new SidekicksError(
      `${verb}: use --${key}=<value>, not --${key} <value> — the space form shreds any text ` +
      `containing '--' (a diff header, a flag name), and that text is the record`,
      EXIT_VALIDATION
    );
  }
}

/**
 * Every occurrence of a repeatable flag, in order, in BOTH forms.
 *
 * parseMemoryFlags is last-wins, so `--step=a --step=b` would silently keep only
 * `b` — and a plan that quietly lost half its steps is worse than a refusal.
 * Same shape as `collectRepeatable` in agent-lifecycle/complete.mjs.
 */
function collectRepeatable(argv, name) {
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (tok.startsWith(`--${name}=`)) {
      out.push(tok.slice(name.length + 3));
      continue;
    }
    if (tok === `--${name}`) {
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.push(next); i++; }
      else out.push('');
    }
  }
  return out;
}

/** A one-line value: no control characters, bounded length. */
function oneLine(verb, key, raw, max) {
  const s = String(raw ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      throw new SidekicksError(
        `${verb}: --${key} must be one line — it contains a control character at offset ${i}`,
        EXIT_VALIDATION
      );
    }
  }
  if (s.length > max) {
    throw new SidekicksError(`${verb}: --${key} is ${s.length} characters (max ${max})`, EXIT_VALIDATION);
  }
  return s;
}

/** Frontmatter-bound text: poison would brick the entry file for every reader. */
function safeForFrontmatter(verb, key, value) {
  const p = yaml.findPoison(value);
  if (p) {
    throw new SidekicksError(
      `${verb}: --${key} contains ${p.what} — ${p.why}; rephrase without it`,
      EXIT_VALIDATION
    );
  }
  return value;
}

function requireNode(cfg) {
  if (cfg.node?.source === 'invalid') {
    // Re-resolve so the user gets the real message instead of a fallback id: an
    // unusable node id would fork the store's partition silently.
    resolveNodeId({ id: 'refuse-me-loudly' }, { SIDEKICKS_JOURNAL_NODE: '' });
  }
  return cfg.node.id;
}

function requireMission(cfg, rest, argv, verb) {
  const id = pickPositional(rest, argv, VALUE_FLAGS);
  const m = id ? loadMission(cfg, id) : null;
  if (!m) {
    throw new SidekicksError(
      `${verb}: no mission '${id ?? ''}' — 'sidekicks journal mission list' shows them` +
      (id ? ` (a missing file after a move needs 'sidekicks journal rebuild')` : ''),
      EXIT_NOT_FOUND
    );
  }
  return m;
}

// ---------------------------------------------------------------------------
// Event appending — the one write path
// ---------------------------------------------------------------------------

/**
 * Append one event row to THIS node's shard and return the row.
 *
 * `seq` is per-(mission, node) monotonic, so it is only ever compared within one
 * shard — the fold's total order puts `node` ahead of it for exactly that reason.
 */
function appendEvent(cfg, m, node, { type, step = null, by, note = '', data = {} }) {
  const events = readMissionEvents(cfg, m.dirAbs);
  if (events.rows.length >= MAX_EVENTS_PER_MISSION) {
    throw new SidekicksError(
      `journal mission: ${m.id} already holds ${events.rows.length} events (cap ${MAX_EVENTS_PER_MISSION}) — ` +
      'close it and open a follow-up mission with related: [<this id>]',
      EXIT_VALIDATION
    );
  }
  const row = {
    seq: nextSeqForNode(events.rows, node),
    ts: zonedTimestamp(cfg.timezone),
    node,
    mission: m.id,
    agent: m.agent,
    type,
    step,
    by: by || m.agent,
    note: oneLine('journal mission event', 'note', note, MAX_MISSION_NOTE_LEN),
    data,
  };
  const abs = missionEventsShard(cfg, m.dirAbs, node);
  appendJsonl(cfg, abs, row);
  return { row, abs };
}

/** Commit the touched files; push ONLY at a boundary (a mission reaching an outcome). */
function persist(cfg, absPaths, message, { boundary = false } = {}) {
  const note = commitEntry(cfg, absPaths, message).note;
  const pushNote = maybePush(cfg, { boundary }).note;
  return note + pushNote;
}

// ---------------------------------------------------------------------------
// open | propose — the two origins of a mission
// ---------------------------------------------------------------------------

function cmdCreate(ctx, cfg, rest, flags, node, sub) {
  const verb = `journal mission ${sub}`;
  const agentName = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  const agent = requireAgent(ctx.repoRoot, agentName, verb);

  const title = safeForFrontmatter(verb, 'title',
    oneLine(verb, 'title', String(flags.title ?? '').trim(), MAX_MISSION_TITLE_LEN));
  if (!title) throw new SidekicksError(`${verb}: --title=<one line> is required`, EXIT_VALIDATION);
  const why = String(flags.why ?? '').trim();
  if (!why) {
    throw new SidekicksError(
      `${verb}: --why=<why now> is required — a goal nobody justified gets re-proposed next week`,
      EXIT_VALIDATION
    );
  }

  const goal = readText(verb, flags, 'goal') || title;
  const dod = readText(verb, flags, 'dod');
  const outOfScope = readText(verb, flags, 'out-of-scope');

  const priority = Number(flags.priority ?? 3);
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    throw new SidekicksError(`${verb}: --priority must be an integer 1..5 (1 = most urgent)`, EXIT_VALIDATION);
  }
  const due = String(flags.due ?? '').trim();
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    throw new SidekicksError(`${verb}: --due must be YYYY-MM-DD`, EXIT_VALIDATION);
  }
  const tags = splitList(flags.tags).map((t) => safeForFrontmatter(verb, 'tags', slugify(t, 24)));
  const related = splitList(flags.related).map((r) => safeForFrontmatter(verb, 'related', r));

  // The active-mission cap: an agent with nine standing goals has none. Per-agent,
  // because a user-facing orchestrator and a quiet build agent do not carry the
  // same load.
  const cap = missionTuning(cfg, agent).maxActive;
  const live = loadMissions(cfg, { agent }).filter((m) => isLive(m.status));
  if (live.length >= cap && !flags.force) {
    throw new SidekicksError(
      `${verb}: ${agent} already has ${live.length} live mission(s) (cap ${cap}: ` +
      `${live.map((m) => m.id).join(', ')}) — close one first, or pass --force and say why in --why`,
      EXIT_VALIDATION
    );
  }

  const ts = zonedTimestamp(cfg.timezone);
  const { date, time, compact } = stampParts(ts);
  const id = mintNodeId(cfg, 'mission', 'MIS', compact, node);
  const slug = slugify(title, 40);
  const dirAbs = missionDirAbs(cfg, { agent, id, slug });
  const entryAbs = join(dirAbs, 'mission.md');

  const origin = sub === 'open' ? 'user' : 'agent';
  const requestedBy = safeForFrontmatter(verb, 'requested-by',
    oneLine(verb, 'requested-by', String(flags['requested-by'] ?? (origin === 'user' ? 'user' : '')), 48));
  // Standing is only meaningful for an already-active mission — a `propose`d one
  // isn't live yet, so the flag is silently a no-op there rather than refused:
  // rung 4 only ever reads `standing` off a live mission's folded state.
  const standing = sub === 'open' && flags.standing === true;

  // Reconcile-internal creation marker. It is the ONLY way a primary
  // declaration recovers the mission it opened when the process died before
  // the bind event landed — without it the next reconcile has no exact identity
  // and would have to title-match, which is forbidden. Never a CLI flag: a
  // free-form journal caller must not be able to forge a binding candidate.
  if (flags['declaration-ref'] != null) {
    throw new SidekicksError(
      `${verb}: --declaration-ref is reconcile-internal — run 'node bin/sidekicks agent daemon reconcile ${agent}'`,
      EXIT_VALIDATION
    );
  }
  const declRef = ctx.declarationRef ?? null;
  const declarationFrontmatter = declRef ? {
    declaration_ref: String(declRef.ref),
    declaration_revision: Number(declRef.revision),
    declaration_fingerprint: String(declRef.fingerprint),
  } : {};

  const content = buildEntry(
    {
      id,
      kind: 'mission',
      agent,
      node,
      title,
      slug,
      origin,
      requested_by: requestedBy,
      ...declarationFrontmatter,
      // INITIAL ONLY. Current status is folded from events/*.jsonl — the key is
      // named this way so no reader can mistake the file for current truth.
      initial_status: sub === 'open' ? 'approved' : 'proposed',
      created_at: ts,
      priority,
      due,
      tags,
      related,
      standing,
    },
    [
      ['Goal', goal],
      ['Why now', why],
      ['Definition of done', dod],
      ['Out of scope', outOfScope],
    ]
  );
  yaml.assertRoundTrips(content.split('---\n')[1] ?? '', verb);
  writeEntryFile(cfg, entryAbs, content);

  appendIndexRow(cfg, {
    kind: 'mission',
    id,
    agent,
    task_id: null,
    date,
    time,
    // No `status` key, deliberately: keeping one current would mean rewriting the
    // shared index on every step, which is the collision the node partition
    // exists to prevent. `filterIndex({status})` therefore never matches a
    // mission, so nobody can query mission state off the index by accident.
    initial_status: sub === 'open' ? 'approved' : 'proposed',
    title,
    path: `${cfg.layers.mission.dir}/${agent}/${id}-${slug}/mission.md`.replace(/^\/+/, ''),
    related,
    ts,
    node,
  });

  const m = loadMission(cfg, id);
  const written = [entryAbs];
  const prelude = sub === 'open'
    ? ['propose', 'approve', ...(flags.start ? ['start'] : [])]
    : ['propose'];
  for (const type of prelude) {
    const { abs } = appendEvent(cfg, m, node, {
      type,
      by: type === 'approve' ? (requestedBy || 'user') : agent,
      note: type === 'propose' ? title : '',
      data: type === 'propose' ? { origin } : {},
    });
    if (!written.includes(abs)) written.push(abs);
  }

  const note = persist(cfg, [...written, cfg.indexAbs], `journal(${agent}): mission ${id} ${sub}`);
  const state = loadMission(cfg, id);
  if (flags.json) {
    return {
      stdout: JSON.stringify({ id, agent, status: state.status, path: state.path, node }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  const hint = sub === 'propose'
    ? `\nawaiting the user: offer '${id} accept', '${id} revise', '${id} shelve'`
    : `\nnext: node bin/sidekicks journal mission plan ${id} --step=<title> --lane <lane>`;
  return { stdout: `mission ${id} [${state.status}] → ${state.path}${note}${hint}\n`, exitCode: EXIT_OK };
}

function readText(verb, flags, key) {
  const fileKey = `${key}-file`;
  if (flags[fileKey]) {
    const p = String(flags[fileKey]);
    if (!existsSync(p)) throw new SidekicksError(`${verb}: --${fileKey} '${p}' does not exist`, EXIT_NOT_FOUND);
    return readFileSync(p, 'utf8').slice(0, MAX_MISSION_TEXT_LEN);
  }
  const raw = String(flags[key] ?? '');
  if (raw.length > MAX_MISSION_TEXT_LEN) {
    throw new SidekicksError(
      `${verb}: --${key} is ${raw.length} characters (max ${MAX_MISSION_TEXT_LEN}) — use --${key}-file=<path>`,
      EXIT_VALIDATION
    );
  }
  return raw;
}

function splitList(raw) {
  return String(raw ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// approve | reject
// ---------------------------------------------------------------------------

function cmdSimple(ctx, cfg, rest, flags, node, type) {
  const verb = `journal mission ${type}`;
  const m = requireMission(cfg, rest, ctx.argv, verb);
  if (!MISSION_STATUSES.includes(m.status)) throw new SidekicksError(`${verb}: ${m.id} has no folded status`, EXIT_VALIDATION);

  const reason = String(flags.reason ?? '').trim();
  if (type === 'reject' && !reason) {
    throw new SidekicksError(
      `${verb}: --reason=<why not> is required — a rejection nobody explained gets re-proposed next week`,
      EXIT_VALIDATION
    );
  }
  const { abs } = appendEvent(cfg, m, node, {
    type,
    by: String(flags.by ?? 'user'),
    note: type === 'reject' ? '' : String(flags.note ?? ''),
    data: type === 'reject' ? { reason: oneLine(verb, 'reason', reason, MAX_MISSION_NOTE_LEN) } : {},
  });
  const note = persist(cfg, [abs], `journal(${m.agent}): mission ${m.id} ${type}`);
  const after = loadMission(cfg, m.id);
  if (flags.json) {
    return { stdout: JSON.stringify({ id: m.id, status: after.status }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `mission ${m.id} [${m.status} → ${after.status}]${note}\n`, exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------
// plan — add or drop steps
// ---------------------------------------------------------------------------

function cmdPlan(ctx, cfg, rest, flags, node) {
  const verb = 'journal mission plan';
  const m = requireMission(cfg, rest, ctx.argv, verb);
  const drop = String(flags.drop ?? '').trim();
  const titles = collectRepeatable(ctx.argv, 'step').filter((t) => t.trim() !== '');

  if (!drop && titles.length === 0) {
    throw new SidekicksError(`${verb}: pass --step=<title> (repeatable) or --drop <sN>`, EXIT_VALIDATION);
  }
  if (!isLive(m.status)) {
    throw new SidekicksError(
      `${verb}: ${m.id} is [${m.status}] — plan steps on a live mission (approved | active | blocked)`,
      EXIT_VALIDATION
    );
  }

  const touched = [];
  let state = m;
  if (drop) {
    if (!MISSION_STEP_RE.test(drop)) throw new SidekicksError(`${verb}: --drop must name a step like s2`, EXIT_VALIDATION);
    if (!state.steps.some((s) => s.id === drop)) {
      throw new SidekicksError(`${verb}: ${m.id} has no step '${drop}'`, EXIT_NOT_FOUND);
    }
    const reason = String(flags.reason ?? '').trim();
    if (!reason) throw new SidekicksError(`${verb}: dropping a step needs --reason=<why>`, EXIT_VALIDATION);
    const { abs } = appendEvent(cfg, state, node, {
      type: 'step.drop',
      step: drop,
      by: state.agent,
      data: { reason: oneLine(verb, 'reason', reason, MAX_MISSION_NOTE_LEN) },
    });
    touched.push(abs);
    state = loadMission(cfg, m.id);
  }

  const lane = String(flags.lane ?? '').trim();
  if (lane && !MISSION_LANE_RE.test(lane)) {
    throw new SidekicksError(
      `${verb}: invalid --lane '${lane}' — agent:<name> | subagent:<name> | handoff:<skill> | user`,
      EXIT_VALIDATION
    );
  }
  const after = String(flags.after ?? '').trim();
  if (after && !MISSION_STEP_RE.test(after)) {
    throw new SidekicksError(`${verb}: --after must name a step like s2`, EXIT_VALIDATION);
  }
  const gate = String(flags.gate ?? '').trim();
  const acceptance = oneLine(verb, 'acceptance', String(flags.acceptance ?? ''), MAX_MISSION_TEXT_LEN);

  const added = [];
  for (const raw of titles) {
    if (state.steps.length >= MAX_STEPS_PER_MISSION) {
      throw new SidekicksError(
        `${verb}: ${m.id} already holds ${state.steps.length} steps (cap ${MAX_STEPS_PER_MISSION}) — ` +
        'a plan that long is two missions',
        EXIT_VALIDATION
      );
    }
    const title = oneLine(verb, 'step', raw.trim(), MAX_MISSION_TITLE_LEN);
    const stepId = nextStepId(state);
    const { abs } = appendEvent(cfg, state, node, {
      type: 'step.add',
      step: stepId,
      by: state.agent,
      note: title,
      data: {
        title,
        after: added.length === 0 ? after : added[added.length - 1],
        lane,
        gate,
        acceptance,
      },
    });
    if (!touched.includes(abs)) touched.push(abs);
    added.push(stepId);
    state = loadMission(cfg, m.id);
  }

  // A planned mission is a started mission: rung 3 only looks at `active`, and a
  // plan that never starts would sit in `approved` forever.
  if (state.status === 'approved') {
    const { abs } = appendEvent(cfg, state, node, { type: 'start', by: state.agent });
    if (!touched.includes(abs)) touched.push(abs);
    state = loadMission(cfg, m.id);
  }

  const note = persist(cfg, touched, `journal(${m.agent}): mission ${m.id} plan ${added.join(' ') || `drop ${drop}`}`);
  if (flags.json) {
    return {
      stdout: JSON.stringify({ id: m.id, status: state.status, added, dropped: drop || null, steps: state.steps }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  return {
    stdout: `mission ${m.id} [${state.status}] ${added.length ? `+${added.join(' +')}` : `-${drop}`}` +
      ` (${state.counts.verified}/${state.counts.total} verified)${note}\n`,
    exitCode: EXIT_OK,
  };
}

// ---------------------------------------------------------------------------
// event — the general append, and the intent stamp that makes a kill recoverable
// ---------------------------------------------------------------------------

function cmdEvent(ctx, cfg, rest, flags, node) {
  const verb = 'journal mission event';
  const m = requireMission(cfg, rest, ctx.argv, verb);
  const type = String(flags.type ?? '').trim();
  if (!MISSION_EVENT_TYPES.includes(type)) {
    throw new SidekicksError(
      `${verb}: invalid --type '${type}' — one of: ${MISSION_EVENT_TYPES.join(' ')}`,
      EXIT_VALIDATION
    );
  }
  if (type === 'declaration.bind' && ctx.declarationBind !== true) {
    throw new SidekicksError(
      `${verb}: declaration.bind is reconcile-only — run 'node bin/sidekicks agent daemon reconcile ${m.agent}'`,
      EXIT_VALIDATION
    );
  }
  if (type === 'step.add') {
    throw new SidekicksError(`${verb}: add steps with 'journal mission plan --step=<title>'`, EXIT_VALIDATION);
  }
  if (type === 'step.verify') {
    throw new SidekicksError(`${verb}: record a verdict with 'journal mission verify <id> --step <sN> --verdict pass|fail'`, EXIT_VALIDATION);
  }
  if (type === 'close') {
    throw new SidekicksError(`${verb}: close with 'journal mission close <id> --outcome done|abandoned --summary=<s>'`, EXIT_VALIDATION);
  }

  const stepId = String(flags.step ?? '').trim();
  const stepScoped = type.startsWith('step.');
  if (stepScoped && !stepId) throw new SidekicksError(`${verb}: --type ${type} needs --step=<sN>`, EXIT_VALIDATION);
  const step = stepId ? m.steps.find((s) => s.id === stepId) : null;
  if (stepId && !step) throw new SidekicksError(`${verb}: ${m.id} has no step '${stepId}'`, EXIT_NOT_FOUND);

  let stepOwner = '';
  if (type === 'step.start') {
    // A `user` lane means the HUMAN does the work. Starting it would burn one of
    // the step's two attempts on a wake that cannot do anything, and two ticks
    // later the step would be exhausted without anyone having tried.
    if (step.lane === 'user') {
      throw new SidekicksError(
        `${verb}: ${m.id} ${step.id} is lane 'user' — the human does this step, so a wake asks instead of starting it: ` +
        `'journal mission event ${m.id} --type ask --step ${step.id} --question=<what you need from them>'`,
        EXIT_VALIDATION
      );
    }
    if (step.gate) {
      throw new SidekicksError(
        `${verb}: ${m.id} ${step.id} carries gate '${step.gate}' — a gated step is never started by a tick. ` +
        `Ask the human: 'journal mission event ${m.id} --type ask --step ${step.id} --question=<the gate>'`,
        EXIT_VALIDATION
      );
    }
    if (step.attempts >= MISSION_MAX_STEP_ATTEMPTS) {
      throw new SidekicksError(
        `${verb}: ${m.id} ${step.id} has already used its ${MISSION_MAX_STEP_ATTEMPTS} attempts — ` +
        'only a human raises that bound, by unblocking the mission',
        EXIT_VALIDATION
      );
    }
    // THE LEASE. Two callers stamping step.start on one step take it from 0 to
    // its 2-attempt bound in a single round, and the mission then auto-blocks for
    // a human who saw nothing actually fail. The attempt counter cannot tell that
    // apart from two real tries, so the second caller is refused here.
    //
    // Same owner = a re-attach, which is allowed and does NOT spend an attempt.
    // A lease older than the TTL cannot belong to a live wake (the delegate kills
    // at --max-runtime), so it is claimable — which is what makes a crashed wake
    // recoverable without a human.
    const owner = String(flags.owner ?? '').trim();
    const ttlMs = stepLeaseTtlMs(ctx.repoRoot);
    const lease = stepLeaseState(step, Date.now(), ttlMs);
    if (lease === 'held' && String(step.owner) !== owner && !flags.force) {
      throw new SidekicksError(
        `${verb}: ${m.id} ${step.id} is already held by '${step.owner}' since ${step.started_ts} `
        + `(lease ${Math.round(ttlMs / 1000)}s) — a second executor never starts a leased step. `
        + 'Re-attach by passing the same --owner, wait for the lease to expire, or override with --force.',
        EXIT_VALIDATION
      );
    }
    stepOwner = owner;
  }
  if (type === 'step.done' && !String(flags.evidence ?? '').trim()) {
    throw new SidekicksError(
      `${verb}: --evidence=<repo-relative path> is required on step.done — a step with no evidence ` +
      'file is unverifiable, and unverifiable is not done',
      EXIT_VALIDATION
    );
  }

  const data = {};
  const put = (key, value, max = MAX_MISSION_NOTE_LEN) => {
    const v = oneLine(verb, key, value, max);
    if (v.trim()) data[key] = v;
  };
  put('reason', flags.reason ?? '');
  put('question', flags.question ?? '', MAX_MISSION_TEXT_LEN);
  put('answer', flags.answer ?? '', MAX_MISSION_TEXT_LEN);
  put('evidence', assertPortable(verb, flags.evidence ?? ''));
  put('lane', flags.lane ?? '');
  put('ref', flags.ref ?? '');
  if (type === 'declaration.bind') {
    data.declaration_ref = oneLine(verb, 'declaration-ref', flags['declaration-ref'], 200);
    data.slug = oneLine(verb, 'slug', flags.slug, 80);
    data.fingerprint = oneLine(verb, 'fingerprint', flags.fingerprint, 64);
    data.revision = Number(flags.revision);
    data.adopted = String(flags.adopted) === 'true';
    const checks = String(flags['dod-checks'] ?? '');
    data.dod_checks = checks ? checks.split('\u001f').map(String) : [];
    if (!data.declaration_ref || !data.slug || !/^[a-f0-9]{64}$/.test(data.fingerprint) || data.revision !== 1) {
      throw new SidekicksError(`${verb}: internal declaration bind payload is invalid`, EXIT_VALIDATION);
    }
  }
  // The lease owner rides on the event, so the fold can tell a re-attach (same
  // owner, no attempt spent) from a genuine second try.
  if (stepOwner) put('owner', stepOwner);
  if (type === 'block' && !data.reason) {
    throw new SidekicksError(`${verb}: --type block needs --reason=<what is in the way>`, EXIT_VALIDATION);
  }
  if (type === 'ask' && !data.question) {
    throw new SidekicksError(`${verb}: --type ask needs --question=<what the human must decide>`, EXIT_VALIDATION);
  }

  const { abs } = appendEvent(cfg, m, node, {
    type,
    step: stepId || null,
    by: String(flags.by ?? m.agent),
    note: String(flags.note ?? ''),
    data,
  });
  const note = persist(cfg, [abs], `journal(${m.agent}): mission ${m.id} ${type}${stepId ? ` ${stepId}` : ''}`);
  const after = loadMission(cfg, m.id);
  if (flags.json) {
    return {
      stdout: JSON.stringify({ id: m.id, status: after.status, type, step: stepId || null, steps: after.steps }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  return { stdout: `mission ${m.id} [${after.status}] ${type}${stepId ? ` ${stepId}` : ''}${note}\n`, exitCode: EXIT_OK };
}

/** Persisted paths are repo-relative — never a machine-absolute path. */
function assertPortable(verb, raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^([a-zA-Z]:[\\/]|\/)/.test(s)) {
    throw new SidekicksError(
      `${verb}: --evidence must be repo-relative, not '${s}' — an absolute path does not survive another clone`,
      EXIT_VALIDATION
    );
  }
  return s.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// verify — the independent grade
// ---------------------------------------------------------------------------

function cmdVerify(ctx, cfg, rest, flags, node) {
  const verb = 'journal mission verify';
  const m = requireMission(cfg, rest, ctx.argv, verb);
  const stepId = String(flags.step ?? '').trim();
  const step = m.steps.find((s) => s.id === stepId);
  if (!step) throw new SidekicksError(`${verb}: ${m.id} has no step '${stepId || ''}' — pass --step=<sN>`, EXIT_NOT_FOUND);
  const verdict = String(flags.verdict ?? '').trim();
  if (verdict !== 'pass' && verdict !== 'fail') {
    throw new SidekicksError(`${verb}: --verdict must be pass or fail`, EXIT_VALIDATION);
  }
  const reason = oneLine(verb, 'reason', String(flags.reason ?? ''), MAX_MISSION_TEXT_LEN);
  if (verdict === 'fail' && !reason) {
    throw new SidekicksError(
      `${verb}: a failing verdict needs --reason=<what is missing> — attempt 2 is informed by it, ` +
      'or it is a coin flip',
      EXIT_VALIDATION
    );
  }
  const evidence = assertPortable(verb, flags.evidence ?? step.evidence);
  if (verdict === 'pass' && !evidence) {
    throw new SidekicksError(
      `${verb}: --evidence=<repo-relative path> is required to pass a step — a pass with no artifact ` +
      'is the unverified done-claim this layer exists to stop',
      EXIT_VALIDATION
    );
  }

  const touched = [];
  const first = appendEvent(cfg, m, node, {
    type: 'step.verify',
    step: step.id,
    by: String(flags.by ?? 'verifier'),
    note: String(flags.note ?? ''),
    data: { verdict, ...(reason ? { reason } : {}), ...(evidence ? { evidence } : {}) },
  });
  touched.push(first.abs);

  // Attempts exhausted is a different failure from "not done yet": it needs a
  // human, so the mission blocks instead of inviting a third try.
  let blocked = false;
  if (verdict === 'fail' && step.attempts >= MISSION_MAX_STEP_ATTEMPTS) {
    const after = loadMission(cfg, m.id);
    const second = appendEvent(cfg, after, node, {
      type: 'block',
      step: step.id,
      by: after.agent,
      data: { reason: `${step.id} failed verification on attempt ${step.attempts} of ${MISSION_MAX_STEP_ATTEMPTS}` },
    });
    if (!touched.includes(second.abs)) touched.push(second.abs);
    blocked = true;
  }

  const note = persist(cfg, touched, `journal(${m.agent}): mission ${m.id} step.verify ${step.id} ${verdict}`);
  const state = loadMission(cfg, m.id);
  if (flags.json) {
    return {
      stdout: JSON.stringify({ id: m.id, step: step.id, verdict, status: state.status, blocked, steps: state.steps }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  return {
    stdout: `mission ${m.id} ${step.id} ${verdict === 'pass' ? 'verified' : 'rejected'}` +
      `${blocked ? ' → mission blocked (attempts exhausted)' : ''} ` +
      `(${state.counts.verified}/${state.counts.total} verified)${note}\n`,
    exitCode: EXIT_OK,
  };
}

// ---------------------------------------------------------------------------
// classify | resolve — binding a human's answer to a mission
// ---------------------------------------------------------------------------

/**
 * Extract the mission binding from a raw inbound text.
 *
 * TOKEN ONLY — there is deliberately no "the only open mission" fallback. The
 * plan gate's equivalent shortcut binds by sole-pending across a shared tree and
 * is agent-blind, which means one lane's bare "go" can approve another lane's
 * plan. A false non-binding costs one round trip; a false binding commits work
 * the user never authorized.
 */
export function classifyMissionReply(text) {
  const raw = String(text ?? '');
  const token = MISSION_TOKEN_RE.exec(raw);
  if (!token) return { token: null, verb: 'none', refusal: 'no mission id in the text — treat it as new work' };
  // Normalize the way the id is MINTED: `MIS-` upper, everything after it lower
  // (the node segment is kebab-case by NODE_ID_RE). A user who shouts the id back
  // must still bind to the same mission.
  const id = `MIS-${token[0].slice(4).toLowerCase()}`;
  const tail = raw.slice(token.index + token[0].length).toLowerCase();
  const found = RESOLUTIONS.find((r) => new RegExp(`\\b${r}\\b`).test(tail));
  if (!found) {
    return { token: id, verb: 'none', refusal: `'${id}' names a mission but no verb (${RESOLUTIONS.join(' | ')}) follows it` };
  }
  return { token: id, verb: found, refusal: '' };
}

function cmdClassify(ctx, cfg, rest, flags) {
  const verb = 'journal mission classify';
  const agentName = pickPositional(rest, ctx.argv, VALUE_FLAGS);
  const agent = agentName ? validateAgentSlug(agentName, verb) : '';
  const text = String(flags.text ?? '');
  if (!text) throw new SidekicksError(`${verb}: --text=<the inbound message, verbatim> is required`, EXIT_VALIDATION);

  const got = classifyMissionReply(text);
  const m = got.token ? loadMission(cfg, got.token) : null;
  const out = {
    schema: 'journal-mission-classify/v1',
    token: got.token,
    verb: got.verb,
    mission: m ? { id: m.id, agent: m.agent, status: m.status, title: m.title } : null,
    refusal: got.refusal || (got.token && !m ? `'${got.token}' is not a recorded mission` : ''),
  };
  if (m && agent && m.agent !== agent) {
    out.verb = 'none';
    out.refusal = `'${m.id}' belongs to ${m.agent}, not ${agent} — never resolve another lane's mission`;
  }
  if (flags.json) return { stdout: JSON.stringify(out, null, 2) + '\n', exitCode: EXIT_OK };
  return {
    stdout: out.verb === 'none'
      ? `none — ${out.refusal}\n`
      : `${out.verb} ${out.token} (${out.mission.agent}, [${out.mission.status}])\n`,
    exitCode: EXIT_OK,
  };
}

function cmdResolve(ctx, cfg, rest, flags, node) {
  const verb = 'journal mission resolve';
  const m = requireMission(cfg, rest, ctx.argv, verb);
  const resolution = String(flags.resolution ?? '').trim();
  if (!RESOLUTIONS.includes(resolution)) {
    throw new SidekicksError(`${verb}: --resolution must be one of: ${RESOLUTIONS.join(' | ')}`, EXIT_VALIDATION);
  }
  const rawText = oneLine(verb, 'text', String(flags.text ?? ''), MAX_MISSION_TEXT_LEN);

  // A gate answer is meaningless without the step it applies to, and releasing
  // "the mission" would release every gate at once — the exact blanket
  // authorization hard rule 4 exists to prevent.
  let step = null;
  if (STEP_RESOLUTIONS.has(resolution)) {
    step = String(flags.step ?? '').trim();
    if (!MISSION_STEP_RE.test(step)) {
      throw new SidekicksError(
        `${verb}: --resolution ${resolution} needs --step=sN — a gate is released for ONE named step, never for a whole mission`,
        EXIT_VALIDATION
      );
    }
    const target = m.steps.find((s) => s.id === step);
    if (!target) {
      throw new SidekicksError(`${verb}: ${m.id} has no step '${step}'`, EXIT_VALIDATION);
    }
    if (resolution === 'release' && !target.gate) {
      throw new SidekicksError(
        `${verb}: ${m.id} ${step} carries no gate — nothing to release`,
        EXIT_VALIDATION
      );
    }
  }

  const touched = [];
  let type;
  let data = { resolution, ...(rawText ? { raw_text: rawText } : {}) };
  if (resolution === 'accept') type = 'approve';
  else if (resolution === 'shelve') { type = 'reject'; data.reason = rawText || 'shelved by the user'; }
  else if (ANSWER_RESOLUTIONS.has(resolution)) type = 'answer';
  else { type = 'ask'; data.question = rawText || 'the user asked for a revision — restate the goal and re-propose'; }

  const first = appendEvent(cfg, m, node, { type, step, by: 'user', note: '', data });
  touched.push(first.abs);
  const note = persist(cfg, touched, `journal(${m.agent}): mission ${m.id} resolve ${resolution}`);
  const after = loadMission(cfg, m.id);
  if (flags.json) {
    return { stdout: JSON.stringify({ id: m.id, resolution, status: after.status }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `mission ${m.id} ${resolution} → [${after.status}]${note}\n`, exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------
// close — the one write that pushes
// ---------------------------------------------------------------------------

function cmdClose(ctx, cfg, rest, flags, node) {
  const verb = 'journal mission close';
  const m = requireMission(cfg, rest, ctx.argv, verb);
  const outcome = String(flags.outcome ?? '').trim();
  if (outcome !== 'done' && outcome !== 'abandoned') {
    throw new SidekicksError(`${verb}: --outcome must be done or abandoned`, EXIT_VALIDATION);
  }
  const summary = oneLine(verb, 'summary', String(flags.summary ?? '').trim(), MAX_MISSION_TEXT_LEN);
  if (!summary) {
    throw new SidekicksError(
      `${verb}: --summary=<what actually happened> is required — it is what a later session reads instead ` +
      'of replaying every event',
      EXIT_VALIDATION
    );
  }
  const unverified = m.steps.filter((s) => s.state === 'done' && !s.verified);
  const adoptedChecks = m.declaration?.dod_checks ?? [];
  if (outcome === 'done' && adoptedChecks.length) {
    const verified = m.steps.filter((s) => s.state === 'verified' && s.evidence);
    const unmatched = adoptedChecks.filter((check) => !verified.some((s) => s.acceptance === check));
    const used = new Set();
    const duplicate = adoptedChecks.some((check) => {
      const step = verified.find((s) => s.acceptance === check && !used.has(s.id));
      if (!step) return true;
      used.add(step.id);
      return false;
    });
    if (unmatched.length || duplicate) {
      throw new SidekicksError(
        `${verb}: adopted declaration DoD requires one distinct verified, evidence-backed step with exact acceptance per check — --force cannot bypass it`,
        EXIT_VALIDATION
      );
    }
  }
  if (outcome === 'done' && unverified.length && !flags.force) {
    throw new SidekicksError(
      `${verb}: ${m.id} has ${unverified.length} done-but-unverified step(s) (${unverified.map((s) => s.id).join(', ')}) — ` +
      'verify them or close --outcome abandoned; --force records a done with unverified claims',
      EXIT_VALIDATION
    );
  }

  const { abs } = appendEvent(cfg, m, node, {
    type: 'close',
    by: String(flags.by ?? m.agent),
    data: { outcome, summary },
  });
  // A mission reaching an outcome is a boundary in the same sense the day's diary
  // is: the natural end of a unit of work. Every other mission write is the
  // middle of one, so this is the only one that pushes.
  const note = persist(cfg, [abs], `journal(${m.agent}): mission ${m.id} close ${outcome}`, { boundary: true });
  const after = loadMission(cfg, m.id);
  if (flags.json) {
    return { stdout: JSON.stringify({ id: m.id, status: after.status, outcome, summary }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `mission ${m.id} [${after.status}] ${summary}${note}\n`, exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------
// next — THE DECIDER (read-only)
// ---------------------------------------------------------------------------

function resolveNow(cfg, raw) {
  const value = String(raw ?? process.env.SIDEKICKS_JOURNAL_NOW ?? '').trim();
  if (!value) return Date.now();
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (m) {
    const iso = `${m[1]}T${m[2]}:${m[3]}:00${tzSuffix(cfg)}`;
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  const t = Date.parse(value);
  if (Number.isFinite(t)) return t;
  throw new SidekicksError(
    `journal mission next: invalid --now '${value}' — use YYYY-MM-DDTHH:MM (store wall clock) or a full ISO instant`,
    EXIT_VALIDATION
  );
}

/** The store zone's current offset, as +HH:MM — derived, never hard-coded. */
function tzSuffix(cfg) {
  const ts = zonedTimestamp(cfg.timezone);
  return ts.slice(-6);
}

/**
 * An instant rendered in the STORE's timezone, not UTC.
 *
 * Every other timestamp in this repo is Asia/Bangkok wall clock; a decider that
 * reported UTC would have the operator comparing its "now" against a diary hour
 * seven hours away.
 */
function zonedFrom(cfg, ms) {
  const shifted = new Date(ms + tzOffsetMinutes(cfg) * 60_000).toISOString();
  return `${shifted.slice(0, 19)}${tzSuffix(cfg)}`;
}

function tzOffsetMinutes(cfg) {
  const suffix = tzSuffix(cfg);
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(suffix);
  if (!m) return 420;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

async function cmdNext(ctx, cfg, rest, flags) {
  const verb = 'journal mission next';
  const agentName = pickPositional(rest, ctx.argv, VALUE_FLAGS) || String(flags.agent ?? '');
  const agent = validateAgentSlug(agentName, verb);
  const nowMs = resolveNow(cfg, flags.now);
  const mode = String(flags.mode ?? '').trim();
  if (mode && mode !== 'consolidate') {
    throw new SidekicksError(`${verb}: --mode accepts only 'consolidate'`, EXIT_VALIDATION);
  }

  const missions = loadMissions(cfg, { agent });
  // An agent the store knows but this clone has no charter for: report, do not
  // refuse — a shared store legitimately carries other machines' agents.
  const foreign = !existsSync(join(ctx.repoRoot, '.sidekicks', 'agents', agent, 'agent.yaml'));

  let backlog = [];
  if (!mode) {
    try {
      backlog = collectFindings(ctx.repoRoot, cfg, { agent, since: null, staleDays: 7 });
    } catch {
      // Orientation must never fail over its own diagnostics: a decision is
      // still better than an error, and rung 6 simply finds no candidate.
      backlog = [];
    }
  }

  const { date } = stampParts(zonedTimestamp(cfg.timezone));
  const tuning = missionTuning(cfg, agent);
  // An explicit `relay` in the agent's tuning wins over the channel table — that
  // is the escape hatch for a lane the table cannot describe, and `relay: ''`
  // deliberately means "this agent has no chat surface".
  const lane = tuning.relay === null ? resolveAgentLane(ctx.repoRoot, agent) : { mailbox: tuning.relay, channel: '', chatOut: '' };
  const action = decideNext({
    missions,
    backlog,
    nowMs,
    opts: {
      agent,
      relay: lane.mailbox,
      mode: mode || undefined,
      cooldownH: tuning.proposeCooldownH,
      blockRetryH: tuning.blockRetryH,
      maxAttempts: MISSION_MAX_STEP_ATTEMPTS,
      // The step lease. `--owner=<token>` lets a caller identify itself, so its
      // OWN in-flight step reads as a re-attach rather than as someone else's
      // work — without it, every held step is treated as foreign, which is the
      // safe direction.
      leaseTtlMs: stepLeaseTtlMs(ctx.repoRoot),
      owner: String(flags.owner ?? ''),
      diaryAt: tuning.diaryAt,
      tzOffsetMinutes: tzOffsetMinutes(cfg),
      diaryWrittenToday: diaryWrittenToday(cfg, agent, date),
    },
  });

  const live = missions.filter((m) => isLive(m.status));
  const out = {
    schema: 'journal-mission-next/v1',
    agent,
    node: cfg.node.id,
    now: zonedFrom(cfg, nowMs),
    ...action,
    lane: { relay: lane.mailbox, channel: lane.channel, chat_out: lane.chatOut },
    tuning: {
      propose_cooldown_hours: tuning.proposeCooldownH,
      block_retry_hours: tuning.blockRetryH,
      max_active: tuning.maxActive,
      max_steps_per_wake: tuning.maxStepsPerWake,
      diary_at: tuning.diaryAt,
    },
    candidates_considered: backlog.length,
    state_digest: `${missions.length} mission(s): ` + (missions.length
      ? summarize(missions)
      : 'none on record'),
    foreign,
  };
  if (flags.json) return { stdout: JSON.stringify(out, null, 2) + '\n', exitCode: EXIT_OK };

  const lines = [
    `next for ${agent} (${cfg.node.id}) @ ${zonedFrom(cfg, nowMs).slice(0, 16).replace('T', ' ')} (${cfg.timezone})`,
    `  action  ${out.action}`,
    `  why     ${out.reason}`,
  ];
  if (out.mission) {
    lines.push(`  mission ${out.mission.id}  [${out.mission.status}]  ` +
      `${out.mission.progress.verified}/${out.mission.progress.total} verified  ${out.mission.title}`);
  }
  if (out.step) lines.push(`  step    ${out.step.id}  ${out.step.title}  [${out.step.state}${out.step.verified ? ', verified' : ''}]`);
  if (out.command) lines.push(`  run     ${out.command}`);
  for (const s of out.suppressed) lines.push(`  skipped ${s.action}: ${s.why}`);
  lines.push(`  live    ${live.length} of ${missions.length}`);
  // Exit 0 even on idle: "nothing to do" is a decision, not a failure, and a
  // `set -e` wake must not read it as one.
  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}

function summarize(missions) {
  const counts = new Map();
  for (const m of missions) counts.set(m.status, (counts.get(m.status) ?? 0) + 1);
  return [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', ');
}

// ---------------------------------------------------------------------------
// list | show | doctor
// ---------------------------------------------------------------------------

function cmdList(ctx, cfg, rest, flags) {
  const verb = 'journal mission list';
  const agentName = pickPositional(rest, ctx.argv, VALUE_FLAGS) || String(flags.agent ?? '');
  const agent = agentName ? validateAgentSlug(agentName, verb) : '';
  const status = String(flags.status ?? '').trim();
  if (status && !MISSION_STATUSES.includes(status)) {
    throw new SidekicksError(
      `${verb}: invalid --status '${status}' — one of: ${MISSION_STATUSES.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  const limit = Number(flags.limit ?? 20);
  let rows = loadMissions(cfg, { agent: agent || undefined })
    .filter((m) => (status ? m.status === status : (flags.all ? true : isLive(m.status))))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);

  if (flags.json) {
    return {
      stdout: JSON.stringify(rows.map((m) => ({
        id: m.id, agent: m.agent, status: m.status, title: m.title, priority: m.priority,
        standing: m.standing, counts: m.counts, last_activity_ts: m.last_activity_ts, path: m.path,
        pending_question: m.pending_question, related: m.related,
      })), null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  if (rows.length === 0) {
    return { stdout: `journal mission: none match${flags.all ? '' : " (live only — pass --all for closed ones)"}\n`, exitCode: EXIT_OK };
  }
  return {
    stdout: renderRows(rows, [
      { header: 'ID',       get: (m) => m.id },
      { header: 'AGENT',    get: (m) => m.agent },
      { header: 'STATUS',   get: (m) => m.status },
      { header: 'PRI',      get: (m) => m.priority },
      { header: 'STEPS',    get: (m) => `${m.counts.verified}/${m.counts.total}` },
      { header: 'ACTIVITY', get: (m) => String(m.last_activity_ts ?? '').slice(0, 16).replace('T', ' ') },
      { header: 'TITLE',    get: (m) => String(m.title).slice(0, 48) },
    ]),
    exitCode: EXIT_OK,
  };
}

function cmdShow(ctx, cfg, rest, flags) {
  const m = requireMission(cfg, rest, ctx.argv, 'journal mission show');
  const events = flags.events ? readMissionEvents(cfg, m.dirAbs) : null;
  if (flags.json) {
    return {
      stdout: JSON.stringify({
        id: m.id, agent: m.agent, node: m.node, title: m.title, status: m.status,
        initial_status: m.initial_status, origin: m.origin, priority: m.priority, due: m.due,
        standing: m.standing, related: m.related, path: m.path, dir: m.dir, created_at: m.created_at,
        status_ts: m.status_ts, closed_at: m.closed_at, outcome: m.outcome, summary: m.summary,
        blocked_reason: m.blocked_reason, pending_question: m.pending_question,
        counts: m.counts, steps: m.steps, shards: m.shards,
        event_count: m.event_count, torn_rows: m.torn_rows, after_close: m.after_close,
        body: m.body,
        ...(events ? { events: events.rows } : {}),
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  const lines = [
    `${m.id}  [${m.status}]  ${m.title}`,
    `${m.path}`,
    '',
    ...(m.steps.length
      ? m.steps.map((s) => `  ${s.id}  ${s.state.padEnd(9)} ${s.gate ? `GATE:${s.gate} ` : ''}${s.lane ? `${s.lane} ` : ''}${s.title}`)
      : ['  (no steps planned)']),
    '',
    m.body,
  ];
  if (events) {
    lines.push('', 'EVENTS', ...events.rows.map((r) => `  ${r.ts} ${r.node} ${r.type}${r.step ? ` ${r.step}` : ''} ${r.note ?? ''}`));
  }
  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}

function cmdDoctor(ctx, cfg, rest, flags) {
  const verb = 'journal mission doctor';
  const agentName = pickPositional(rest, ctx.argv, VALUE_FLAGS) || String(flags.agent ?? '');
  const agent = agentName ? validateAgentSlug(agentName, verb) : '';
  const findings = missionFindings(cfg, { agent: agent || undefined });
  if (flags.json) {
    return { stdout: JSON.stringify({ agent: agent || null, findings }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  if (findings.length === 0) return { stdout: 'journal mission doctor: clean\n', exitCode: EXIT_OK };
  return {
    stdout: renderRows(findings, [
      { header: 'SEV',     get: (f) => f.severity },
      { header: 'KIND',    get: (f) => f.kind },
      { header: 'SUBJECT', get: (f) => f.subject },
      { header: 'FIX',     get: (f) => f.fix },
    ]),
    exitCode: EXIT_OK,
  };
}
