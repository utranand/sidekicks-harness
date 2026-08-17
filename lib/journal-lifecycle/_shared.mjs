// lib/journal-lifecycle/_shared.mjs
// Shared helpers for the `sidekicks journal` verbs — the layered, trackable
// record of what named persistent agents actually did.
// NOT a dispatchable verb (no VERBS entry).
//
// Configuration is split by lifetime, not by topic:
//
//   <root scope>/config/agents.yaml → agent_memory        the config store
//       enabled | repository | timezone | git | node | per-agent layer overrides.
//       Resolved with `sidekicks config get agent_memory`; this block alone turns
//       the journal on or off. It used to be `persistent_agent_memory` inside the
//       git-ignored .sidekicks/settings.json — a durable decision parked in the
//       file whose only other job is remembering which project is active on THIS
//       machine, so half of it could never travel. That key is still read as a
//       DEPRECATED fallback (readAgentMemoryBlock).
//   .agents/skills/sk-agent-journal/assets/journal-config.yaml  COMMITTED
//       the store SHAPE — layers (dir/layout/enabled), index path, diary hour,
//       coordinator policy. It stays a skill asset because it is merged
//       LAYER-BY-LAYER (pickLayer), not block-wide the way a config layer would be.
//
// Precedence: the agent_memory block (legacy layer keys only) › skill asset › DEFAULT_LAYERS.
//
// Six layers:
//
//   L0 log       append-only JSONL, one row per completed task — the SPINE.
//                Written by `agent complete` itself, so the mechanical record
//                exists even when the model skips every prose step.
//   L1 retro     per-assignment self-review (worker)
//   L2 incident  one thing that broke (coordinator)
//   L3 issue     an open item tracked to closure (promoted from an incident)
//   L4 diary     one self-review per agent per day (coordinator)
//   L5 improve   a proposed change to an agent's CHARTER (distinct from
//                sk-self-improve, which covers SKILLS)
//   L6 lesson    a fleet-wide distilled rule ANY agent should know — bounded
//                (50 active) and injected into every delegate wake
//   L7 mission   an agent's own STANDING WORK: a goal, its plan, its progress,
//                its verdicts, its outcome. The only layer whose current state is
//                FOLDED from an append-only event log instead of read from
//                frontmatter, so two machines never rewrite the same file.
//
// Every write also appends one row to the store's index.jsonl, which is what
// makes the layers queryable (`journal report`, `journal doctor`) without
// walking directories — and rebuildable from disk (`journal rebuild`).
//
// Two hard properties every caller depends on:
//   1. NOTHING here may throw into a task completion. Writers return a note;
//      the caller decides whether to print it. A broken journal is a silent
//      journal, never a failed task.
//   2. Persisted paths are STORE-relative (never machine-absolute, never even
//      workspace-relative) so the store repo travels to another clone intact.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveBlock } from '../config-store/read.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
import { parseEntryFile, parseMemoryFlags, SLUG_RE } from '../memory-lifecycle/_shared.mjs';
import {
  isRepo,
  addPaths,
  hasStagedChanges,
  hasIdentity,
  commit as gitCommit,
  push as gitPush,
  hasUnpushedCommits,
} from '../git-delegation/git.mjs';

export { parseMemoryFlags };

// ---------------------------------------------------------------------------
// Enums + defaults
// ---------------------------------------------------------------------------

/** The layer kinds, in the order `journal report` renders them. */
export const LAYER_KINDS = ['log', 'retro', 'incident', 'issue', 'improve', 'diary', 'lesson', 'mission'];

/** Lifecycles. An issue is only ever in one of these; likewise an improvement. */
export const ISSUE_STATUSES = ['open', 'ack', 'fixed', 'wontfix'];
export const IMPROVE_STATUSES = ['proposed', 'applied', 'rejected'];
export const IMPROVE_TARGETS = ['charter', 'skill', 'routine'];
export const INCIDENT_STATUSES = ['open', 'resolved'];
export const SEVERITIES = ['low', 'medium', 'high'];
export const LESSON_STATUSES = ['active', 'retired'];

/**
 * L7 mission lifecycles.
 *
 * `rejected` is not `abandoned`: rejected never started (the user said no),
 * abandoned started and was given up. The decider's proposal cooldown and
 * `journal doctor` treat them differently, so they cannot be one status.
 *
 * A step has no `failed` state on purpose — a failed verification means the step
 * is not done, so `step.verify` with verdict `fail` returns it to `doing`.
 */
export const MISSION_STATUSES = ['proposed', 'approved', 'active', 'blocked', 'done', 'abandoned', 'rejected'];
export const MISSION_STEP_STATES = ['pending', 'doing', 'done', 'verified', 'dropped'];
export const MISSION_EVENT_TYPES = [
  'propose', 'approve', 'reject', 'start', 'block', 'unblock',
  'step.add', 'step.drop', 'step.start', 'step.done', 'step.verify',
  'note', 'ask', 'answer', 'close', 'declaration.bind',
];
/** Where a step's work actually lands. `user` is a step that is only a decision. */
export const MISSION_LANE_RE = /^(agent:[a-z0-9][a-z0-9-]*|subagent:[a-z0-9][a-z0-9-]*|handoff:[a-z0-9][a-z0-9-]*|user)$/;
export const MISSION_STEP_RE = /^s[1-9][0-9]*$/;

/** Mission bounds. Every one of these refuses rather than degrading silently. */
export const MAX_ACTIVE_MISSIONS_PER_AGENT = 3;
export const MAX_STEPS_PER_MISSION = 40;
export const MAX_EVENTS_PER_MISSION = 2000;
export const MAX_MISSION_TITLE_LEN = 120;
export const MAX_MISSION_NOTE_LEN = 200;
export const MAX_MISSION_TEXT_LEN = 2000;
/**
 * Attempts allowed per step: the first execute plus ONE informed revision.
 * Matches the fleet-wide `cli-orchestrator-attempt-limit-default-2` decision —
 * only a human raises it, by unblocking the mission.
 */
export const MISSION_MAX_STEP_ATTEMPTS = 2;

/** Decider tuning, overridable per store in the skill asset. */
export const MISSION_PROPOSE_COOLDOWN_H = 24;
export const MISSION_BLOCK_RETRY_H = 48;
/**
 * How many step-actions a single wake may take before it must stop and wait for
 * the next tick. Default `1` is today's exact behavior (byte-identical for every
 * agent that doesn't set this); `0` means unlimited — keep looping the wake
 * until nothing actionable is left. This is a looping/protocol-level knob
 * consumed by the skill, not by decideNext() itself, which always returns
 * exactly one action per call regardless of this value.
 */
export const MAX_STEPS_PER_WAKE = 1;

/**
 * A machine id: kebab-case, <=16 chars. Short because it rides inside every
 * mission id and every event-shard filename.
 */
export const NODE_ID_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;

/** Push policies: never | boundary (diary/shutdown/explicit) | always. */
export const PUSH_POLICIES = ['never', 'boundary', 'always'];

/** Fallback committer identity — per-command only, never written to config. */
const JOURNAL_IDENTITY = { name: 'Sidekicks', email: 'sidekicks@local' };

const DEFAULT_LAYERS = Object.freeze({
  log:      { enabled: true, dir: 'src/logs',           layout: '<agent>/<YYYY-MM-DD>.jsonl' },
  retro:    { enabled: true, dir: 'src/retrospectives', layout: '<agent>/<YYYY-MM-DD>/<HHmm>-<slug>.md' },
  incident: { enabled: true, dir: 'src/incidents',      layout: '<agent>/<YYYY-MM-DD>/<HHmm>-<slug>.md' },
  issue:    { enabled: true, dir: 'src/issues',         layout: '<id>-<slug>.md' },
  improve:  { enabled: true, dir: 'src/improvements',   layout: '<agent>/<id>-<slug>.md' },
  diary:    { enabled: true, dir: 'src/diaries',        layout: '<agent>/<YYYY-MM-DD>.md' },
  // L6 lesson — fleet-wide, NOT per-agent-partitioned: a lesson is a distilled
  // rule any agent should know, so the store is one shared pool (source agent
  // rides in the frontmatter, not the path).
  lesson:   { enabled: true, dir: 'src/lessons',        layout: '<id>-<slug>.md' },
  // L7 mission — `layout` names a DIRECTORY, not a file: mission.md is immutable
  // and every mutation is one appended row in events/<node>.jsonl. That is what
  // keeps one writer per mutable file when several machines share the store.
  mission:  { enabled: true, dir: 'src/missions',        layout: '<agent>/<id>-<slug>' },
});

const DEFAULT_INDEX = 'src/index.jsonl';
const DEFAULT_TZ = 'Asia/Bangkok';
const DEFAULT_DIARY_AT = '18:00';
const DEFAULT_COORDINATOR_WRITE_ON = 'incident';

/**
 * The committed half of the configuration: the store's shape lives in the owning
 * skill, not in each machine's git-ignored settings file. Repo-relative on
 * purpose — join()ed against repoRoot so it resolves on Windows too.
 */
export const SKILL_CONFIG_REL = join(
  '.agents', 'skills', 'sk-agent-journal', 'assets', 'journal-config.yaml'
);

/**
 * Read the skill-bundled journal config. Absent, unreadable or malformed → `{}`,
 * never a throw: a typo in the asset must degrade to the built-in defaults, not
 * break a task completion (property 1 in the header).
 *
 * @param {string} repoRoot
 * @returns {object}
 */
export function readSkillJournalConfig(repoRoot) {
  const abs = join(repoRoot, SKILL_CONFIG_REL);
  if (!existsSync(abs)) return {};
  try {
    const parsed = yaml.parse(readFileSync(abs, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Time — honors the configured timezone, defaulting to Asia/Bangkok
// ---------------------------------------------------------------------------

/**
 * ISO-8601 timestamp in `timeZone` with its real UTC offset, e.g.
 * "2026-07-25T14:03:22+07:00". Mirrors memory-lifecycle's bangkokTimestamp but
 * honors the store's configured zone instead of hard-coding one.
 *
 * An unknown zone falls back to Asia/Bangkok rather than throwing — a typo in
 * settings must not be able to break a task completion.
 *
 * @param {string} [timeZone]
 * @returns {string}
 */
export function zonedTimestamp(timeZone = DEFAULT_TZ) {
  let parts;
  let offset = '+07:00';
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      timeZoneName: 'longOffset',
    });
    const got = fmt.formatToParts(new Date());
    parts = Object.fromEntries(got.map((p) => [p.type, p.value]));
    // "GMT+07:00" → "+07:00"; "GMT" (UTC) → "+00:00".
    const raw = String(parts.timeZoneName || '').replace('GMT', '').trim();
    offset = raw === '' ? '+00:00' : (raw.includes(':') ? raw : `${raw}:00`);
  } catch {
    return zonedTimestamp(DEFAULT_TZ);
  }
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${offset}`;
}

/** Split a zoned timestamp into the pieces the layouts interpolate. */
export function stampParts(ts) {
  return {
    ts,
    date: ts.slice(0, 10),               // YYYY-MM-DD
    time: ts.slice(11, 13) + ts.slice(14, 16), // HHmm
    compact: ts.slice(0, 10).replace(/-/g, ''), // YYYYMMDD
  };
}

/**
 * Parse a `--since` window (`7d`, `24h`, `30m`, or a bare YYYY-MM-DD) into the
 * earliest date string it admits. Returns null when absent/unparseable — the
 * caller then applies no window rather than silently showing nothing.
 *
 * @param {string|undefined} value
 * @param {string} nowTs - the current zoned timestamp
 * @returns {string|null} an inclusive YYYY-MM-DD lower bound
 */
export function parseSince(value, nowTs) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = /^(\d+)\s*([dhm])$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  const unitMs = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2].toLowerCase()];
  const base = Date.parse(nowTs);
  if (Number.isNaN(base)) return null;
  return new Date(base - n * unitMs).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Slugs + ids
// ---------------------------------------------------------------------------

/**
 * Reduce free text to a kebab-case slug safe for a filename on every OS
 * (Windows rejects <>:"/\|?* and trailing dots). Empty input yields 'entry'.
 *
 * @param {string} text
 * @param {number} [max=48]
 * @returns {string}
 */
export function slugify(text, max = 48) {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'entry';
}

/** Validate an agent name without importing agent-lifecycle (would cycle). */
export function validateAgentSlug(name, verb = 'journal') {
  const n = String(name ?? '');
  if (!n) throw new SidekicksError(`${verb}: an agent <name> is required`, EXIT_VALIDATION);
  if (!SLUG_RE.test(n)) {
    throw new SidekicksError(
      `${verb}: invalid agent name '${n}' — must be kebab-case matching ${SLUG_RE.source}`,
      EXIT_VALIDATION
    );
  }
  return n;
}

/**
 * Require that an agent charter exists. Journal entries are ABOUT agents; an
 * entry filed against a typo'd name would be invisible to every later query.
 */
export function requireAgent(repoRoot, name, verb = 'journal') {
  const n = validateAgentSlug(name, verb);
  if (!existsSync(join(repoRoot, '.sidekicks', 'agents', n, 'agent.yaml'))) {
    throw new SidekicksError(
      `${verb}: no agent named '${n}' — 'sidekicks agent list' shows the roster`,
      EXIT_NOT_FOUND
    );
  }
  return n;
}

/**
 * Mint the next stable id for a kind: PREFIX-YYYYMMDD-NN, sequence per day.
 * Derived from the index (the one place that already knows every entry), so a
 * rebuild reproduces the same ids rather than renumbering history.
 *
 * @param {object} cfg
 * @param {string} kind - index `kind` to count
 * @param {string} prefix - INC | ISS | IMP
 * @param {string} compactDate - YYYYMMDD
 * @returns {string}
 */
export function mintId(cfg, kind, prefix, compactDate) {
  const head = `${prefix}-${compactDate}-`;
  let max = 0;
  for (const row of readIndex(cfg)) {
    if (row.kind !== kind) continue;
    const id = String(row.id ?? '');
    if (!id.startsWith(head)) continue;
    const n = Number(id.slice(head.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return head + String(max + 1).padStart(2, '0');
}

/**
 * Mint the next id for a NODE-PARTITIONED kind: PREFIX-YYYYMMDD-NODE-NN,
 * sequence per (kind, day, node).
 *
 * Separate from mintId because that one does `Number(id.slice(head.length))`,
 * and for `MIS-20260803-mbp-01` that slice is `mbp-01` → NaN, so reusing it
 * would silently mint `-01` forever. Counting only this node's ids is also what
 * makes the mint contention-free: two machines never race for the same number.
 *
 * @param {object} cfg
 * @param {string} kind - index `kind` to count
 * @param {string} prefix - MIS
 * @param {string} compactDate - YYYYMMDD
 * @param {string} node - this machine's id
 * @returns {string}
 */
export function mintNodeId(cfg, kind, prefix, compactDate, node) {
  const head = `${prefix}-${compactDate}-${node}-`;
  let max = 0;
  for (const row of readIndex(cfg)) {
    if (row.kind !== kind) continue;
    const id = String(row.id ?? '');
    if (!id.startsWith(head)) continue;
    const n = Number(id.slice(head.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return head + String(max + 1).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Node identity — which machine is writing
// ---------------------------------------------------------------------------

/**
 * Resolve this machine's node id.
 *
 * THE SINGLE SWAP POINT for node identity: every path, id and shard filename
 * that carries a machine dimension gets it from here, so the multi-node store
 * redesign changes one function rather than every layer.
 *
 * Precedence: SIDEKICKS_JOURNAL_NODE › settings `node.id` › slugified hostname ›
 * 'local'. Pure over its two arguments so a test pins it without touching the
 * machine. A configured id that is not NODE_ID_RE is REFUSED (naming the settings
 * key) rather than slugified: a silently corrected id would partition the store
 * differently on the next machine that spells it the same wrong way. A *derived*
 * id is slugified and truncated instead, because there is nobody to tell.
 *
 * @param {object|null} block - the agent_memory block's `node` mapping
 * @param {object} [env]
 * @returns {{id: string, label: string, source: 'env'|'config'|'hostname'|'fallback'}}
 */
export function resolveNodeId(block, env = process.env) {
  const label = block && typeof block === 'object' && typeof block.label === 'string' ? block.label : '';

  const fromEnv = String(env?.SIDEKICKS_JOURNAL_NODE ?? '').trim();
  if (fromEnv) {
    if (!NODE_ID_RE.test(fromEnv)) {
      throw new SidekicksError(
        `journal: invalid SIDEKICKS_JOURNAL_NODE '${fromEnv}' — must match ${NODE_ID_RE.source}`,
        EXIT_VALIDATION
      );
    }
    return { id: fromEnv, label, source: 'env' };
  }

  const configured = block && typeof block === 'object' ? String(block.id ?? '').trim() : '';
  if (configured) {
    if (!NODE_ID_RE.test(configured)) {
      throw new SidekicksError(
        `journal: invalid agent_memory.node.id '${configured}' — ` +
        `must match ${NODE_ID_RE.source} (kebab-case, at most 16 characters)`,
        EXIT_VALIDATION
      );
    }
    return { id: configured, label, source: 'config' };
  }

  let host = '';
  try {
    host = String(hostname() ?? '');
  } catch { /* a hostname lookup must never break a write */ }
  const derived = slugify(host.split('.')[0] || '', 16);
  if (derived && derived !== 'entry') return { id: derived, label: label || host, source: 'hostname' };
  return { id: 'local', label, source: 'fallback' };
}

/**
 * Is a resolved node id one that would silently FORK the partition?
 *
 * An IP-shaped or all-numeric hostname changes with the network, so two sessions
 * on the same laptop would write under two different node ids — the exact failure
 * the partition exists to prevent. Reported by `journal doctor`, never guessed at
 * automatically, because only a human can say what this machine is called.
 */
export function nodeIdIsUnstable(node) {
  const id = String(node?.id ?? '');
  if (node?.source === 'env' || node?.source === 'config') return false;
  return /^\d+(-\d+)*$/.test(id);
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Merge the committed and per-machine `agents:` override maps for one layer.
 * Per-machine wins per KEY, not per agent, so a settings file that overrides one
 * number does not silently drop the asset's other three.
 */
function mergeAgentBlocks(fromSkill, fromSettings) {
  const out = {};
  for (const src of [fromSkill, fromSettings]) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const [name, block] of Object.entries(src)) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      out[name] = { ...(out[name] ?? {}), ...block };
    }
  }
  return out;
}

/**
 * The mission tuning that applies to ONE agent: the fleet defaults with that
 * agent's overrides on top.
 *
 * Every caller resolves through here rather than reading `cfg.mission` directly,
 * so adding a second (or fifth) agent to the loop is a config edit and never a
 * code change.
 *
 * @param {object} cfg
 * @param {string} agent
 * @returns {{proposeCooldownH: number, blockRetryH: number, maxActive: number,
 *           maxStepsPerWake: number, diaryAt: string, relay: string|null,
 *           cadence: string}}
 */
export function missionTuning(cfg, agent) {
  const base = cfg?.mission ?? {};
  const own = (base.agents && base.agents[String(agent)]) || {};
  // `relay` and `cadence` are advisory: relay pins the chat mailbox when the
  // channel table cannot be trusted to name it (or '' for an agent with no chat
  // surface at all), cadence is what `arm-mission-loop` writes into the routine.
  const relay = typeof own.relay === 'string' ? own.relay.trim() : null;
  return {
    proposeCooldownH: positiveNumber(own.propose_cooldown_hours, base.proposeCooldownH, MISSION_PROPOSE_COOLDOWN_H),
    blockRetryH: positiveNumber(own.block_retry_hours, base.blockRetryH, MISSION_BLOCK_RETRY_H),
    maxActive: positiveNumber(own.max_active_per_agent, base.maxActivePerAgent, MAX_ACTIVE_MISSIONS_PER_AGENT),
    // 0 is a deliberate "unlimited" value, not "unset" — nonNegativeNumber (unlike
    // positiveNumber) must accept it rather than falling through to the default.
    maxStepsPerWake: nonNegativeNumber(own.max_steps_per_wake, base.maxStepsPerWake, MAX_STEPS_PER_WAKE),
    diaryAt: firstString(own.diary_at, cfg?.diaryAt) ?? DEFAULT_DIARY_AT,
    relay,
    cadence: firstString(own.cadence) ?? '',
  };
}

/** First positive finite number among the candidates; the last one is the default. */
function positiveNumber(...candidates) {
  for (const c of candidates) {
    const n = typeof c === 'string' ? Number(c) : c;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n;
  }
  return candidates[candidates.length - 1];
}

/**
 * First non-negative finite number among the candidates (0 included — it is a
 * deliberate value, "unlimited", never treated as absent); the last one is the
 * default. Mirrors positiveNumber()'s shape but with `>= 0` instead of `> 0`.
 */
function nonNegativeNumber(...candidates) {
  for (const c of candidates) {
    const n = typeof c === 'string' ? Number(c) : c;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n;
  }
  return candidates[candidates.length - 1];
}

/** First non-empty string among the candidates, in precedence order; else null. */
function firstString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c;
  }
  return null;
}

/** Overlay one partial layer spec onto a resolved one. Absent keys keep `base`. */
function mergeLayer(base, given) {
  if (!given || typeof given !== 'object') return base;
  return {
    enabled: given.enabled === false ? false : base.enabled,
    dir: typeof given.dir === 'string' && given.dir ? given.dir : base.dir,
    layout: typeof given.layout === 'string' && given.layout ? given.layout : base.layout,
  };
}

function pickLayer(kind, layersBlock, skillLayers, legacy) {
  // built-in default ← skill asset (committed shape) ← settings (per-machine)
  const base = mergeLayer(DEFAULT_LAYERS[kind], skillLayers && skillLayers[kind]);
  const given = layersBlock && typeof layersBlock[kind] === 'object' ? layersBlock[kind] : null;
  if (given) return mergeLayer(base, given);
  // No `layers.<kind>` on this machine — fall back to the flat pre-layers keys so
  // a settings file written before this feature keeps working untouched.
  const l = legacy[kind] || {};
  return mergeLayer(base, { dir: l.dir, layout: l.layout });
}

/**
 * The `agent_memory` block: whether there is a journal, which repository holds it, how it is committed,
 * and this machine's node identity.
 *
 * WHERE IT LIVES. `agent_memory` in the root scope's `config/agents.yaml`, resolved through the config
 * store like every other block. It used to be `persistent_agent_memory` in `.sidekicks/settings.json` —
 * a durable, shareable decision parked inside the git-ignored file whose only other job is remembering
 * which project is active on this machine, so half the setting could never travel. That key is still
 * read as a DEPRECATED fallback so a machine that has not migrated keeps its journal.
 *
 * Never throws: a corrupt file must not break a completion, so every failure resolves to null and the
 * writers become no-ops — the same disabled path an unconfigured machine takes.
 *
 * @param {string} repoRoot
 * @returns {object|null}
 */
function readAgentMemoryBlock(repoRoot) {
  try {
    const resolved = resolveBlock(repoRoot, 'agent_memory');
    if (resolved && resolved.config && Object.keys(resolved.config).length) return resolved.config;
  } catch {
    // An unparseable descriptor set makes buildRegistry throw repo-wide; the journal must not die
    // with it, so fall through to the legacy key.
  }
  try {
    const settings = readSettings(repoRoot);
    return settings && typeof settings.persistent_agent_memory === 'object'
      ? settings.persistent_agent_memory
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the journal configuration, or null when the store is switched off.
 *
 * Two sources, merged: the per-machine settings block decides WHETHER there is a
 * journal and where/how it is committed; the skill-bundled asset decides its
 * SHAPE. Layer/index/diary/coordinator keys are still honored in settings.json
 * for backward compatibility, but they are deprecated there — the canonical home
 * is `SKILL_CONFIG_REL`.
 *
 * Returning null (rather than throwing) IS the disabled path: every writer
 * checks for null and becomes a no-op, so an unconfigured machine runs agents
 * exactly as before.
 *
 * @param {string} repoRoot
 * @returns {object|null}
 */
export function resolveJournalConfig(repoRoot) {
  const block = readAgentMemoryBlock(repoRoot);
  if (!block || block.enabled !== true) return null;

  const repository = String(block.repository ?? '').trim();
  if (!repository || isAbsolute(repository) || repository.split(/[\\/]/).includes('..')) {
    return null; // must be a repo-relative path inside the workspace
  }
  const storeRoot = join(repoRoot, repository);

  const skill = readSkillJournalConfig(repoRoot);
  const skillLayers = skill.layers && typeof skill.layers === 'object' ? skill.layers : null;
  const skillCoord = skill.coordinator && typeof skill.coordinator === 'object' ? skill.coordinator : {};

  const coord = block.coordinator && typeof block.coordinator === 'object' ? block.coordinator : {};
  const legacy = {
    retro:    { dir: block.retrospectives_dir, layout: block.entry_layout },
    incident: { dir: coord.incidents_dir,      layout: coord.incident_layout },
    diary:    { dir: coord.diary_dir,          layout: coord.diary_layout },
  };
  const layersBlock = block.layers && typeof block.layers === 'object' ? block.layers : null;

  const layers = {};
  for (const kind of LAYER_KINDS) {
    const l = pickLayer(kind, layersBlock, skillLayers, legacy);
    layers[kind] = { ...l, dirAbs: join(storeRoot, l.dir) };
  }

  const gitBlock = block.git && typeof block.git === 'object' ? block.git : {};
  const push = PUSH_POLICIES.includes(gitBlock.push) ? gitBlock.push : 'never';

  const indexRel = firstString(block.index, skill.index) ?? DEFAULT_INDEX;

  // An unusable node id must not disable the journal — L0 logging has no node
  // dimension and must keep working. It is recorded as source 'invalid' so
  // `journal doctor` raises and the mission verbs (the only node-partitioned
  // ones) refuse with the real message by calling resolveNodeId themselves.
  const nodeBlock = block.node && typeof block.node === 'object' ? block.node : null;
  let node;
  try {
    node = resolveNodeId(nodeBlock);
  } catch {
    node = { id: 'local', label: '', source: 'invalid' };
  }

  // Mission tuning: committed shape (skill asset) over per-machine settings, same
  // precedence as every other layer key. Read outside mergeLayer, which carries
  // only enabled/dir/layout.
  const missionSkill = skillLayers?.mission && typeof skillLayers.mission === 'object' ? skillLayers.mission : {};
  const missionSettings = layersBlock?.mission && typeof layersBlock.mission === 'object' ? layersBlock.mission : {};

  return {
    enabled: true,
    repoRoot,
    repository,
    storeRoot,
    timezone: typeof block.timezone === 'string' && block.timezone ? block.timezone : DEFAULT_TZ,
    indexRel,
    indexAbs: join(storeRoot, indexRel),
    // Hour after which the coordinator writes the day's diary. Prose-enforced by
    // sk-agent-master (no timer reads it) — the value is config so the two
    // sides agree on one number.
    diaryAt: firstString(layersBlock?.diary?.at, coord.diary_time, skillLayers?.diary?.at)
      ?? DEFAULT_DIARY_AT,
    // Which event obliges the coordinator to write. Prose-enforced, same as above.
    coordinator: {
      writeOn: firstString(coord.write_on, skillCoord.write_on) ?? DEFAULT_COORDINATOR_WRITE_ON,
    },
    node,
    mission: {
      proposeCooldownH: positiveNumber(
        missionSettings.propose_cooldown_hours, missionSkill.propose_cooldown_hours, MISSION_PROPOSE_COOLDOWN_H),
      blockRetryH: positiveNumber(
        missionSettings.block_retry_hours, missionSkill.block_retry_hours, MISSION_BLOCK_RETRY_H),
      maxActivePerAgent: positiveNumber(
        missionSettings.max_active_per_agent, missionSkill.max_active_per_agent, MAX_ACTIVE_MISSIONS_PER_AGENT),
      // 0 is a deliberate "unlimited" value here too — see nonNegativeNumber().
      maxStepsPerWake: nonNegativeNumber(
        missionSettings.max_steps_per_wake, missionSkill.max_steps_per_wake, MAX_STEPS_PER_WAKE),
      // Per-agent overrides, merged on read by missionTuning(). Two lanes on one
      // store legitimately want different numbers — a chatty user-facing
      // orchestrator and a quiet build agent do not share a cadence — and a
      // fleet-wide value is the wrong place to say so.
      agents: mergeAgentBlocks(missionSkill.agents, missionSettings.agents),
    },
    git: {
      commit: gitBlock.commit !== false,
      push,
      remote: typeof gitBlock.remote === 'string' && gitBlock.remote ? gitBlock.remote : 'origin',
      branch: typeof gitBlock.branch === 'string' && gitBlock.branch ? gitBlock.branch : 'main',
    },
    layers,
  };
}

/**
 * Resolve config or throw — for the interactive verbs, where silence would be
 * confusing ("I ran it and nothing happened"). The auto-writers use the
 * nullable form instead.
 */
export function requireJournalConfig(repoRoot, verb = 'journal') {
  const cfg = resolveJournalConfig(repoRoot);
  if (!cfg) {
    throw new SidekicksError(
      `${verb}: the agent journal is not configured — run ` +
      "'sidekicks config set agent_memory.enabled true' and " +
      "'sidekicks config set agent_memory.repository <repo-relative path>' " +
      "(inspect it with 'sidekicks config get agent_memory')",
      EXIT_VALIDATION
    );
  }
  return cfg;
}

/** A layer's config, refusing when that layer is switched off. */
export function requireLayer(cfg, kind, verb = 'journal') {
  const layer = cfg.layers[kind];
  if (!layer || !layer.enabled) {
    throw new SidekicksError(
      `${verb}: the '${kind}' layer is switched off — set layers.${kind}.enabled: true in ` +
      `${SKILL_CONFIG_REL.replace(/\\/g, '/')} (or clear the agent_memory.layers.${kind} override; ` +
      "'sidekicks config get agent_memory' shows which layer decided it)",
      EXIT_VALIDATION
    );
  }
  return layer;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Store-relative, forward-slash path — the ONLY form persisted anywhere. */
export function toStoreRel(cfg, abs) {
  return relative(cfg.storeRoot, abs).replace(/\\/g, '/');
}

/**
 * Expand a layer layout into an absolute path.
 * Tokens: <agent> <YYYY-MM-DD> <HHmm> <slug> <task-slug> <id>
 *
 * @param {object} cfg
 * @param {string} kind
 * @param {{agent?: string, date?: string, time?: string, slug?: string, id?: string}} vars
 * @returns {string} absolute path
 */
export function expandLayout(cfg, kind, vars) {
  const layer = cfg.layers[kind];
  const map = {
    '<agent>': vars.agent ?? 'unknown',
    '<YYYY-MM-DD>': vars.date ?? '',
    '<HHmm>': vars.time ?? '',
    '<slug>': vars.slug ?? 'entry',
    '<task-slug>': vars.slug ?? 'entry',
    '<id>': vars.id ?? '',
  };
  const segments = String(layer.layout)
    .split('/')
    .map((seg) => seg.replace(/<[^>]+>/g, (tok) => (tok in map ? map[tok] : tok)))
    .filter((seg) => seg !== '');
  return join(layer.dirAbs, ...segments);
}

/**
 * The git working tree that owns `absPath`: the nearest ancestor (at or below
 * the store root) that is its own repo. The store's code conventionally lives
 * in `<service>/src`, which is its own repo — but a store laid out differently
 * must still commit, so this is discovered rather than assumed.
 *
 * @returns {string|null} absolute path, or null when nothing there is a repo
 */
export function resolveGitCwd(cfg, absPath) {
  let dir = existsSync(absPath) && safeIsDir(absPath) ? absPath : dirname(absPath);
  const stop = dirname(cfg.storeRoot);
  while (dir && dir !== stop && dir.length >= cfg.storeRoot.length) {
    if (isRepo(dir)) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return isRepo(cfg.storeRoot) ? cfg.storeRoot : null;
}

function safeIsDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * The store's own git working tree.
 *
 * Anchored on the INDEX file, not on the store root: the store's code
 * conventionally lives in a `src/` subdirectory that is itself the repo, and
 * resolveGitCwd only ever walks UP — asking it from the store root would walk
 * straight past the repo and find nothing. The index sits beside the entries, so
 * it is always inside whatever tree the commits belong to.
 *
 * @returns {string|null}
 */
export function storeGitRoot(cfg) {
  return resolveGitCwd(cfg, cfg.indexAbs);
}

// ---------------------------------------------------------------------------
// Index (JSONL — one row per entry, across every layer)
// ---------------------------------------------------------------------------

/**
 * Read the whole index. A malformed line is SKIPPED, never fatal — a truncated
 * write (killed mid-append) must not make every later query fail.
 *
 * @returns {object[]}
 */
export function readIndex(cfg) {
  if (!cfg || !existsSync(cfg.indexAbs)) return [];
  let text;
  try {
    text = readFileSync(cfg.indexAbs, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && typeof row === 'object') out.push(row);
    } catch { /* skip a torn line */ }
  }
  return out;
}

/**
 * Append one JSON row to a JSONL file. Uses appendFileSync (not writeAtomic)
 * deliberately: an append of a single short line is what keeps concurrent agents
 * from clobbering each other's rows the way a read-modify-write would, and it is
 * what makes a `*.jsonl merge=union` gitattribute honest.
 */
export function appendJsonl(cfg, abs, row) {
  assertWritable(abs, cfg.repoRoot);
  mkdirp(dirname(abs));
  appendFileSync(abs, JSON.stringify(row) + '\n', 'utf8');
}

/**
 * Read one JSONL file. A malformed line is SKIPPED, never fatal — a truncated
 * write (killed mid-append) must not make every later query fail. Torn lines are
 * counted so a caller can report them instead of pretending the file was clean.
 *
 * @returns {{rows: object[], torn: number}}
 */
export function readJsonlFile(abs) {
  if (!existsSync(abs)) return { rows: [], torn: 0 };
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return { rows: [], torn: 0 };
  }
  const rows = [];
  let torn = 0;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
      else torn += 1;
    } catch {
      torn += 1;
    }
  }
  return { rows, torn };
}

/**
 * Union every `*.jsonl` shard in a directory, tagging each row with the file it
 * came from. One file per writer is the whole point — the union is the read side
 * of that partition.
 *
 * @returns {{rows: object[], torn: number, files: string[]}}
 */
export function readJsonlDir(abs) {
  let names;
  try {
    names = readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return { rows: [], torn: 0, files: [] };
  }
  const rows = [];
  let torn = 0;
  for (const name of names) {
    const got = readJsonlFile(join(abs, name));
    torn += got.torn;
    for (const row of got.rows) rows.push({ ...row, _shard: name });
  }
  return { rows, torn, files: names };
}

/**
 * Append one index row.
 * @see appendJsonl for why this is an append and not an atomic rewrite.
 */
export function appendIndexRow(cfg, row) {
  appendJsonl(cfg, cfg.indexAbs, row);
}

/** Rewrite the whole index (rebuild + status transitions only). */
export function writeIndex(cfg, rows) {
  assertWritable(cfg.indexAbs, cfg.repoRoot);
  mkdirp(dirname(cfg.indexAbs));
  writeAtomic(cfg.indexAbs, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

/**
 * Update the index row identified by kind+id (status changes: issue close,
 * incident resolve, improvement apply/reject). Returns the updated row or null.
 */
export function updateIndexRow(cfg, kind, id, patch) {
  const rows = readIndex(cfg);
  let updated = null;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === kind && rows[i].id === id) {
      rows[i] = { ...rows[i], ...patch };
      updated = rows[i];
    }
  }
  if (updated) writeIndex(cfg, rows);
  return updated;
}

/** Find one row by kind + id. */
export function findIndexRow(cfg, kind, id) {
  return readIndex(cfg).find((r) => r.kind === kind && r.id === id) || null;
}

/**
 * Filter index rows by the flags every read verb shares.
 * @param {{kind?: string, agent?: string, since?: string, status?: string, task?: string}} f
 */
export function filterIndex(cfg, f = {}) {
  return readIndex(cfg).filter((r) => {
    if (f.kind && r.kind !== f.kind) return false;
    if (f.agent && r.agent !== f.agent) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.task && r.task_id !== f.task) return false;
    if (f.since && String(r.date ?? '') < f.since) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Entry writing (markdown + frontmatter) and reading
// ---------------------------------------------------------------------------

/**
 * Compose an entry file: yaml-subset frontmatter + markdown sections.
 * `sections` is an ordered [heading, text] list; an empty text renders the
 * honest placeholder rather than being dropped, so a later reader can tell
 * "nothing notable" apart from "never filled in".
 */
export function buildEntry(frontmatter, sections) {
  const fm = yaml.serialize(frontmatter);
  const body = sections
    .map(([heading, text]) => `## ${heading}\n\n${String(text ?? '').trim() || '_(not recorded)_'}`)
    .join('\n\n');
  return `---\n${fm}---\n\n${body}\n`;
}

/**
 * Write an entry file into a layer (surface-gated, atomic) and return its paths.
 *
 * @returns {{abs: string, storeRel: string}}
 */
export function writeEntryFile(cfg, absPath, content) {
  assertWritable(absPath, cfg.repoRoot);
  mkdirp(dirname(absPath));
  writeAtomic(absPath, content);
  return { abs: absPath, storeRel: toStoreRel(cfg, absPath) };
}

/** Read an entry's frontmatter + body from a store-relative path. */
export function readEntry(cfg, storeRel) {
  const abs = join(cfg.storeRoot, storeRel);
  if (!existsSync(abs)) return null;
  try {
    return { abs, ...parseEntryFile(readFileSync(abs, 'utf8')) };
  } catch {
    return null;
  }
}

/**
 * Patch an existing entry's frontmatter in place, preserving the body verbatim.
 * Used by every status transition (issue close, incident resolve, improve apply).
 */
export function patchEntryFrontmatter(cfg, storeRel, patch) {
  const entry = readEntry(cfg, storeRel);
  if (!entry) return null;
  const fm = { ...(entry.frontmatter || {}), ...patch };
  const content = `---\n${yaml.serialize(fm)}---\n\n${entry.body}\n`;
  assertWritable(entry.abs, cfg.repoRoot);
  writeAtomic(entry.abs, content);
  return { abs: entry.abs, storeRel, frontmatter: fm };
}

/**
 * Walk a layer directory for entry files — the rebuild path, and the only code
 * that trusts disk over the index.
 *
 * @returns {string[]} store-relative paths, sorted
 */
export function walkLayerFiles(cfg, kind, exts = ['.md']) {
  const root = cfg.layers[kind]?.dirAbs;
  if (!root || !existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(toStoreRel(cfg, p));
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Git policy — commit always (when enabled), push only at a boundary
// ---------------------------------------------------------------------------

/**
 * Stage + commit the given absolute paths in the store's own repo.
 *
 * Best-effort by contract: every failure becomes a note string. The entry file
 * is already on disk by the time this runs, so a failed commit loses nothing
 * but the history — never the record.
 *
 * @returns {{ committed: boolean, note: string }}
 */
export function commitEntry(cfg, absPaths, message) {
  if (!cfg.git.commit) return { committed: false, note: '' };
  const paths = absPaths.filter(Boolean);
  if (paths.length === 0) return { committed: false, note: '' };
  const cwd = resolveGitCwd(cfg, paths[0]);
  if (!cwd) return { committed: false, note: ' (not committed — the store is not a git repo)' };
  try {
    const rels = paths.map((p) => relative(cwd, p).replace(/\\/g, '/'));
    addPaths(cwd, rels);
    if (!hasStagedChanges(cwd)) return { committed: false, note: '' };
    gitCommit(cwd, message, { identity: hasIdentity(cwd) ? undefined : JOURNAL_IDENTITY });
    return { committed: true, note: '' };
  } catch (err) {
    return { committed: false, note: ` (not committed — ${firstLine(err)})` };
  }
}

/**
 * Push the store when the policy allows it.
 *
 * `boundary` marks the natural end of a unit of work (a diary write, an
 * explicit `journal push`, a session shutdown). Policy `always` pushes on every
 * entry; `boundary` only at those points; `never` not at all. A push is an
 * OUTWARD network write — it happens solely because the user configured it.
 *
 * @param {object} cfg
 * @param {{ boundary?: boolean }} opts
 * @returns {{ pushed: boolean, note: string }}
 */
export function maybePush(cfg, { boundary = false } = {}) {
  const policy = cfg.git.push;
  if (policy === 'never') return { pushed: false, note: '' };
  if (policy === 'boundary' && !boundary) return { pushed: false, note: '' };

  const cwd = storeGitRoot(cfg);
  if (!cwd) return { pushed: false, note: '' };
  if (!hasUnpushedCommits(cwd)) return { pushed: false, note: '' };
  try {
    gitPush(cwd, cfg.git.remote, cfg.git.branch);
    return { pushed: true, note: ` — pushed to ${cfg.git.remote}/${cfg.git.branch}` };
  } catch (err) {
    // Never retried in a loop and never fatal: the commits are safe locally.
    return { pushed: false, note: ` (push failed — ${firstLine(err)}; commits are safe locally)` };
  }
}

function firstLine(err) {
  return String(err && err.message ? err.message : err).split('\n')[0];
}

// ---------------------------------------------------------------------------
// Shared verb plumbing
// ---------------------------------------------------------------------------

/**
 * Pull the sub-verb (add|list|show|…) out of the positionals, tolerating the
 * dispatcher's habit of leaking space-form flag VALUES into positionals.
 *
 * @param {object} args - the dispatcher's { name, rest } shape
 * @param {string[]} allowed
 * @param {string} verb
 * @returns {{ sub: string, rest: string[] }}
 */
export function takeSubVerb(args, allowed, verb) {
  const tokens = [args?.name, ...(args?.rest ?? [])].filter((t) => typeof t === 'string');
  const sub = tokens[0];
  if (!sub || !allowed.includes(sub)) {
    throw new SidekicksError(
      `${verb}: expected one of: ${allowed.join(' | ')}${sub ? ` — got '${sub}'` : ''}`,
      EXIT_VALIDATION
    );
  }
  return { sub, rest: tokens.slice(1) };
}

/**
 * First positional that is NOT a flag value. `parseArgs` leaks `--status done`
 * as the positional `done`, so callers pass the flag names whose values must be
 * ignored when picking a name off the line.
 */
export function pickPositional(rest, argv, skipFlags = []) {
  const leaked = new Set();
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string' || !tok.startsWith('--')) continue;
    const key = tok.slice(2);
    if (!skipFlags.includes(key)) continue;
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) leaked.add(next);
  }
  return (rest || []).find((t) => typeof t === 'string' && !leaked.has(t)) || null;
}

/** Render a table-ish list for human stdout; `--json` callers bypass this. */
export function renderRows(rows, columns) {
  if (rows.length === 0) return '';
  const widths = columns.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [
    line(columns.map((c) => c.header)),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(columns.map((c) => c.get(r)))),
  ].join('\n') + '\n';
}
