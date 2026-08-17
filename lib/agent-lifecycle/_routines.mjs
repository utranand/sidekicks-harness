// lib/agent-lifecycle/_routines.mjs
// Shared core for scheduled agent routines — the schema, validation, due-math,
// state store, and the single fire path used by BOTH `agent routine run` and
// the `agent scheduler` daemon. NOT a dispatchable verb (no VERBS entry).
//
// Two files per agent:
//   .sidekicks/agents/<name>/routines/routines.yaml   COMMITTED schedule (flat scalars)
//   .sidekicks/agents/<name>/runtime/routines-state.json  GIT-IGNORED fire state
//
// Why the committed half is FLAT: lib/yaml-subset/yaml.mjs serialize() pushes
// every value of a sequence-of-mappings through serializeScalar (yaml.mjs:492-509,
// :458-473), which has no object/array branch — a nested mapping would be written
// as the literal `[object Object]` and an array as `a,b`, silently and
// irreversibly. Structure therefore lives in the JSON state file, never here.
//
// Why writes are guarded: the parser hard-REJECTS `&word`, `*word`, and YAML
// tags anywhere in a raw line (yaml.mjs:40-63) — even inside double quotes — so
// a goal containing "?a=1&b=2" would make the committed file unreadable on every
// later read. Rejecting at write time is the only place to catch it.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
import { parseCron, prevCronInstant, nextCronInstant, cronMinIntervalMinutes } from './_cron.mjs';
import { SLUG_RE } from '../memory-lifecycle/_shared.mjs';
import { readJsonFile, writeJsonFile } from './_bridge.mjs';
import {
  agentDir,
  runtimeDir,
  readCharter,
  requireCharter,
  bangkokTimestamp,
} from './_shared.mjs';
import { toPortablePath } from './send.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ROUTINES_SCHEMA = 'agent-routines/v1';
export const STATE_SCHEMA = 'agent-routines-state/v1';

/** The reserved sender agent. Owns no routines; every fired task comes FROM it. */
export const SCHEDULER_AGENT = 'scheduler';

export const WHENS = ['daily', 'weekly', 'once', 'cron', 'every'];

/** Where a routine's RESULT is delivered. '' = the scheduler's own inbox drain
 * (the default); 'telegram' fires the task FROM the relay agent so the
 * completion auto-replies straight into the user's chat; 'telegram:<lane>'
 * delivers into a specific channel-table lane instead of the default one. */
export const DELIVERS = ['', 'telegram'];

/** The relay mailbox owner (mirrors RELAY in telegram.mjs — a constant here
 * beats importing the 900-line relay module at load time). */
export const RELAY_AGENT = 'telegram';
const RELAY_PREFIX = 'telegram-';
const LANE_ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Is this a telegram delivery (default lane or a named one)? */
export function isTelegramDeliver(deliver) {
  const d = String(deliver ?? '').trim().toLowerCase();
  return d === RELAY_AGENT || d.startsWith(`${RELAY_AGENT}:`);
}

/**
 * The relay mailbox a `--deliver` value sends FROM. Mirrors relayAgentFor() in
 * telegram.mjs: the default lane keeps the bare `telegram` mailbox, a named
 * lane gets `telegram-<lane>`. Returns null when the routine is not delivered.
 */
export function relayAgentForDeliver(deliver) {
  const d = String(deliver ?? '').trim().toLowerCase();
  if (d === RELAY_AGENT) return RELAY_AGENT;
  if (!d.startsWith(`${RELAY_AGENT}:`)) return null;
  const lane = d.slice(RELAY_AGENT.length + 1);
  return lane ? RELAY_PREFIX + lane : null;
}

/** Validate a `--deliver` value's SHAPE (not whether the lane exists here). */
export function deliverShapeError(deliver) {
  const d = String(deliver ?? '').trim().toLowerCase();
  if (d === '' || d === RELAY_AGENT) return null;
  if (!d.startsWith(`${RELAY_AGENT}:`)) {
    return `--deliver '${deliver}' is invalid — one of: telegram, telegram:<lane> (omit for the scheduler's own inbox drain)`;
  }
  const lane = d.slice(RELAY_AGENT.length + 1);
  if (!LANE_ID_RE.test(lane)) {
    return `--deliver '${deliver}' is invalid — the lane id must be lowercase letters/digits/hyphens (it names the mailbox '${RELAY_PREFIX}<lane>')`;
  }
  return null;
}

/** `--when every` bounds: below 5 minutes the ~30s tick plus send cost makes
 * the job a daemon's, not a routine's; above a day it is daily/weekly/cron's. */
export const MIN_EVERY_MIN = 5;
export const MAX_EVERY_MIN = 1440;

/** Monday-first, matching the (getUTCDay() + 6) % 7 index used by bangkokParts. */
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DAY_ALIASES = {
  monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu',
  friday: 'fri', saturday: 'sat', sunday: 'sun',
  tues: 'tue', weds: 'wed', thur: 'thu', thurs: 'thu',
};

/**
 * Default grace per schedule kind, in minutes. A recurring job that is more
 * than an hour stale is usually better skipped than fired into a workday it no
 * longer fits; a one-shot is a specific intention worth honouring for a day.
 */
export const DEFAULT_GRACE_MIN = { daily: 60, weekly: 60, once: 1440, cron: 60, every: 60 };

export const MIN_GRACE_MIN = 1;
export const MAX_GRACE_MIN = 10080; // 7 days — past this a "late" fire is noise

/** Keeps one scheduler tick bounded regardless of how many agents exist. */
export const MAX_ROUTINES_PER_AGENT = 50;

export const MAX_GOAL_LEN = 500;
export const MAX_ACCEPTANCE_LEN = 500;
export const MAX_NOTE_LEN = 200;

export const DAY_MS = 86_400_000;

/** Asia/Bangkok is a FIXED +07:00 with no DST — the whole due-math rests on this. */
export const BKK_OFFSET_MS = 7 * 3_600_000;

/**
 * Canonical key order for a routine entry. Every key is always emitted (empty
 * string for not-applicable) so diffs stay stable and readers never have to
 * reconstruct defaults.
 */
export const ROUTINE_KEYS = [
  'id', 'enabled', 'when', 'at', 'days', 'category', 'priority',
  'goal', 'sequence', 'work_dir', 'acceptance', 'grace_minutes',
  'deliver', 'note', 'created_at',
];

/** Boolean flags shared by the routine + scheduler verbs (parseMemoryFlags). */
export const ROUTINE_BOOLEANS = ['json', 'force', 'disabled', 'enabled', 'once', 'dry-run', 'all'];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

// Poison shapes the yaml-subset parser rejects on read live canonically in
// yaml.findPoison — quoting does not protect against them (the pre-scan runs
// on raw lines), so every free-text writer refuses them at write time.

/** Secret shapes worth a warning — routines.yaml is COMMITTED. */
const SECRET_RE = /(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-|Bearer\s+[A-Za-z0-9._-]{8,}|(?:password|api[_-]?key|secret|token)\s*[=:]\s*\S{6,})/i;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function routinesPath(repoRoot, agent) {
  return join(agentDir(repoRoot, agent), 'routines', 'routines.yaml');
}

export function routinesStatePath(repoRoot, agent) {
  return join(runtimeDir(repoRoot, agent), 'routines-state.json');
}

// ---------------------------------------------------------------------------
// Bangkok wall clock — fixed offset, so no Intl and no host-timezone leakage
// ---------------------------------------------------------------------------

/**
 * Split an epoch-ms instant into Asia/Bangkok wall-clock parts.
 * Uses the getUTC* accessors on a shifted instant, so the result is identical
 * regardless of the host TZ (a getHours() based version would silently differ
 * per machine — that is the bug this shape exists to prevent).
 *
 * @param {number} ms
 * @returns {{ y:number, m:number, d:number, hh:number, mm:number, dow:string }}
 */
export function bangkokParts(ms) {
  const d = new Date(ms + BKK_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    dow: DAYS[(d.getUTCDay() + 6) % 7], // getUTCDay: 0=Sun → Monday-first index
  };
}

/**
 * Inverse of bangkokParts: Bangkok wall-clock parts → epoch ms.
 * Date.UTC absorbs every calendar rollover (month, year, leap day).
 */
export function bangkokWallToMs({ y, m, d, hh, mm }) {
  return Date.UTC(y, m - 1, d, hh, mm, 0, 0) - BKK_OFFSET_MS;
}

/** Format an instant as Bangkok wall clock `YYYY-MM-DDTHH:MM` (no offset). */
export function bangkokWall(ms) {
  const p = bangkokParts(ms);
  const z = (n, w = 2) => String(n).padStart(w, '0');
  return `${z(p.y, 4)}-${z(p.m)}-${z(p.d)}T${z(p.hh)}:${z(p.mm)}`;
}

// ---------------------------------------------------------------------------
// Schedule parsing
// ---------------------------------------------------------------------------

// parseCron is pure but not free — the daemon re-resolves every routine each
// ~30s tick, so specs are memoized per expression string.
const cronSpecCache = new Map();

/**
 * Parse a routine's `at` into wall-clock parts.
 * - daily/weekly → `{ hh, mm }` (time of day only)
 * - once → `{ y, m, d, hh, mm }` (a specific instant)
 * - cron → the parsed cron spec (memoized; see _cron.mjs)
 * - every → `{ everyMin }` (interval minutes)
 * @returns {object|null} null when unparseable
 */
export function parseAt(when, at) {
  const raw = String(at ?? '').trim();
  if (when === 'cron') {
    if (cronSpecCache.has(raw)) return cronSpecCache.get(raw);
    let spec = null;
    try {
      spec = parseCron(raw);
    } catch {
      spec = null;
    }
    cronSpecCache.set(raw, spec);
    return spec;
  }
  if (when === 'every') {
    const min = parseEvery(raw);
    return min == null ? null : { everyMin: min };
  }
  if (when === 'once') {
    const m = DATETIME_RE.exec(raw);
    if (!m) return null;
    return { y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5] };
  }
  const m = TIME_RE.exec(raw);
  if (!m) return null;
  return { hh: +m[1], mm: +m[2] };
}

/**
 * Parse an interval token (`30m`, `2h`, `1d`) into minutes, or null when
 * malformed or out of the MIN/MAX_EVERY bounds.
 */
export function parseEvery(raw) {
  const m = /^(\d+)(m|h|d)$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const minutes = m[2] === 'm' ? n : m[2] === 'h' ? n * 60 : n * 1440;
  if (!Number.isInteger(minutes) || minutes < MIN_EVERY_MIN || minutes > MAX_EVERY_MIN) return null;
  return minutes;
}

/** Parse a routine's `days` into a Monday-first ordered, deduped list. */
export function parseDays(days) {
  const seen = new Set();
  for (const part of String(days ?? '').split(',')) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    seen.add(DAY_ALIASES[t] || t);
  }
  return DAYS.filter((d) => seen.has(d));
}

export function graceMinutes(routine) {
  const g = Number(routine?.grace_minutes);
  if (Number.isInteger(g) && g >= MIN_GRACE_MIN && g <= MAX_GRACE_MIN) return g;
  return DEFAULT_GRACE_MIN[String(routine?.when)] ?? DEFAULT_GRACE_MIN.daily;
}

// ---------------------------------------------------------------------------
// Due-math — PURE. `nowMs` is always a parameter, never read from the clock,
// which is what lets the tests cover every edge case with no fake timers
// (same shape as presenceState(presence, nowMs) in _shared.mjs:223).
// ---------------------------------------------------------------------------

/**
 * The most recent scheduled instant at or before `nowMs`, or null when the
 * routine has no such instant yet (a future one-shot, or an unparseable schedule).
 *
 * @param {object} routine
 * @param {number} nowMs
 * @returns {number|null} epoch ms
 */
export function lastScheduledInstant(routine, nowMs) {
  const when = String(routine?.when ?? '');
  const at = parseAt(when, routine?.at);
  if (!at) return null;

  if (when === 'once') {
    const t = bangkokWallToMs(at);
    return t <= nowMs ? t : null;
  }

  if (when === 'daily') {
    const today = bangkokParts(nowMs);
    const t = bangkokWallToMs({ ...today, hh: at.hh, mm: at.mm });
    // Subtracting a flat day is exact: the offset is fixed, so there is no DST
    // correction to make, and we are subtracting from an INSTANT (calendar
    // rollover is Date.UTC's problem, already solved on the way in).
    return t <= nowMs ? t : t - DAY_MS;
  }

  if (when === 'weekly') {
    const days = parseDays(routine?.days);
    if (days.length === 0) return null;
    // k must reach 7, not 6: when today IS a listed day but `at` is still
    // ahead, the previous occurrence of a once-a-week routine is today - 7.
    for (let k = 0; k <= 7; k++) {
      const p = bangkokParts(nowMs - k * DAY_MS);
      if (!days.includes(p.dow)) continue;
      const t = bangkokWallToMs({ ...p, hh: at.hh, mm: at.mm });
      if (t <= nowMs) return t;
    }
    return null;
  }

  if (when === 'cron') {
    return prevCronInstant(at, nowMs);
  }

  if (when === 'every') {
    // Bangkok-midnight grid: occurrences are midnight + k·interval within the
    // current wall-clock day. Stateless — no anchor field, so the display path
    // and the daemon compute the identical instant, and a restart changes
    // nothing. The grid resets at each midnight (a 7h interval fires 00:00,
    // 07:00, 14:00, 21:00, then 00:00 again — divisors of 24h have no seam).
    const p = bangkokParts(nowMs);
    const midnight = bangkokWallToMs({ ...p, hh: 0, mm: 0 });
    const step = at.everyMin * 60_000;
    return midnight + Math.floor((nowMs - midnight) / step) * step;
  }

  return null;
}

/**
 * The next scheduled instant strictly after `nowMs`, or null when none remains
 * (a spent one-shot). Display only — never gates a fire.
 */
export function nextScheduledInstant(routine, nowMs) {
  const when = String(routine?.when ?? '');
  const at = parseAt(when, routine?.at);
  if (!at) return null;

  if (when === 'once') {
    const t = bangkokWallToMs(at);
    return t > nowMs ? t : null;
  }

  if (when === 'daily') {
    const today = bangkokParts(nowMs);
    const t = bangkokWallToMs({ ...today, hh: at.hh, mm: at.mm });
    return t > nowMs ? t : t + DAY_MS;
  }

  if (when === 'weekly') {
    const days = parseDays(routine?.days);
    if (days.length === 0) return null;
    for (let k = 0; k <= 7; k++) {
      const p = bangkokParts(nowMs + k * DAY_MS);
      if (!days.includes(p.dow)) continue;
      const t = bangkokWallToMs({ ...p, hh: at.hh, mm: at.mm });
      if (t > nowMs) return t;
    }
    return null;
  }

  if (when === 'cron') {
    return nextCronInstant(at, nowMs);
  }

  if (when === 'every') {
    // Same midnight grid as lastScheduledInstant, clamped to the NEXT midnight
    // when the step would overshoot the day (the grid resets there).
    const p = bangkokParts(nowMs);
    const midnight = bangkokWallToMs({ ...p, hh: 0, mm: 0 });
    const step = at.everyMin * 60_000;
    const next = midnight + (Math.floor((nowMs - midnight) / step) + 1) * step;
    return next >= midnight + DAY_MS ? midnight + DAY_MS : next;
  }

  return null;
}

/**
 * Decide what to do with one routine on this tick.
 *
 * The idempotence key is the SCHEDULED INSTANT, never the fire time: a tick
 * that runs 3 seconds or 3 minutes late still resolves to the same instant and
 * therefore skips. That is what makes a 30s tick safe.
 *
 * @param {object} routine
 * @param {object|null} stateEntry - state.routines[id], or null on cold start
 * @param {number} nowMs
 * @returns {{ action:'fire'|'skip'|'miss', instantMs:number|null,
 *            lateMs:number, graceMs:number, reason:string }}
 */
export function routineDue(routine, stateEntry, nowMs) {
  const none = (reason) => ({ action: 'skip', instantMs: null, lateMs: 0, graceMs: 0, reason });

  if (!routine || typeof routine !== 'object') return none('not a routine');
  if (routine.enabled === false) return none('disabled');

  const st = stateEntry && typeof stateEntry === 'object' ? stateEntry : null;
  if (st && st.retired_at) return none('one-shot already spent');

  const t = lastScheduledInstant(routine, nowMs);
  if (t === null) return none('no scheduled instant yet');

  const graceMs = graceMinutes(routine) * 60_000;
  const lateMs = nowMs - t;

  if (st && Number.isFinite(st.last_instant_ms) && st.last_instant_ms >= t) {
    return { action: 'skip', instantMs: t, lateMs, graceMs, reason: 'already fired' };
  }
  // Crash-window guard: markIntent stamped this instant but markFired never
  // ran (the process died between the send and the state write). Bias to
  // at-most-once — a duplicated digest is noise, a duplicated command-sequence
  // job could double-commit.
  if (st && Number.isFinite(st.in_flight_instant_ms) && st.in_flight_instant_ms === t) {
    return { action: 'skip', instantMs: t, lateMs, graceMs, reason: 'in-flight from a previous process — treated as fired' };
  }

  if (lateMs > graceMs) {
    return { action: 'miss', instantMs: t, lateMs, graceMs, reason: 'past grace' };
  }
  return { action: 'fire', instantMs: t, lateMs, graceMs, reason: 'due' };
}

// ---------------------------------------------------------------------------
// routines.yaml I/O
// ---------------------------------------------------------------------------

/** An empty, valid document. A missing file is never an error. */
export function emptyRoutinesDoc() {
  return { schema: ROUTINES_SCHEMA, routines: [] };
}

/**
 * Read + parse an agent's routines file.
 * @returns {{ schema:string, routines:object[] }} an empty doc when absent
 * @throws {SidekicksError} when the file exists but does not parse
 */
export function readRoutinesFile(repoRoot, agent) {
  const p = routinesPath(repoRoot, agent);
  if (!existsSync(p)) return emptyRoutinesDoc();
  let doc;
  try {
    doc = yaml.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new SidekicksError(
      `agent routine: ${routinesPath(repoRoot, agent)} does not parse — ${err.message}`,
      EXIT_VALIDATION
    );
  }
  if (!doc || typeof doc !== 'object') return emptyRoutinesDoc();
  const routines = Array.isArray(doc.routines) ? doc.routines : [];
  return { schema: doc.schema || ROUTINES_SCHEMA, routines };
}

/**
 * The routine entries that are safe to act on, plus the ones that are not.
 * A hand-written nested value parses fine but CANNOT be rewritten (the
 * serializer would flatten it to `[object Object]`), so it is quarantined
 * rather than silently mangled.
 *
 * @returns {{ ok: object[], bad: {index:number, id:string, key:string}[] }}
 */
export function partitionRoutines(doc) {
  const ok = [];
  const bad = [];
  const entries = Array.isArray(doc?.routines) ? doc.routines : [];
  entries.forEach((r, index) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      bad.push({ index, id: String(r ?? ''), key: '(entry)' });
      return;
    }
    const nested = Object.keys(r).find(
      (k) => r[k] !== null && typeof r[k] === 'object'
    );
    if (nested) bad.push({ index, id: String(r.id ?? `#${index}`), key: nested });
    else ok.push(r);
  });
  return { ok, bad };
}

/**
 * Serialize + atomically write a routines document, gated three ways:
 *  1. no nested values anywhere (the serializer cannot represent them),
 *  2. a full serialize→parse round-trip must reproduce the document — this
 *     catches every corrupting construct, including ones not enumerated in
 *     YAML_POISON, turning "silently bricks a committed file" into "refused",
 *  3. assertWritable before writeAtomic (the repo-wide order).
 */
export function writeRoutinesFile(repoRoot, agent, doc, verb = 'agent routine') {
  const routines = Array.isArray(doc?.routines) ? doc.routines : [];

  const { bad } = partitionRoutines({ routines });
  if (bad.length > 0) {
    const b = bad[0];
    throw new SidekicksError(
      `${verb}: routine '${b.id}' has a nested value at '${b.key}' — routine entries must be flat scalars (the yaml serializer would write it as "[object Object]"); flatten it by hand in ${routinesPath(repoRoot, agent)} first`,
      EXIT_VALIDATION
    );
  }

  const out = { schema: ROUTINES_SCHEMA, routines };
  const text = yaml.serialize(out);

  let reparsed;
  try {
    reparsed = yaml.parse(text);
  } catch (err) {
    throw new SidekicksError(
      `${verb}: the resulting file would not parse back (${err.message}) — rephrase the value without YAML special characters`,
      EXIT_VALIDATION
    );
  }
  const drift = roundTripDrift(out, reparsed);
  if (drift) {
    throw new SidekicksError(
      `${verb}: value at ${drift} would not survive the yaml round-trip — rephrase it without special characters (&word, *word, !tag, backslashes, newlines)`,
      EXIT_VALIDATION
    );
  }

  const p = routinesPath(repoRoot, agent);
  assertWritable(p, repoRoot);
  writeAtomic(p, text);
  return p;
}

/**
 * Compare a document against its serialize→parse image. Returns a dotted path
 * to the first divergence, or null when the round-trip is faithful. Numbers and
 * booleans are compared after String() because the parser coerces scalars.
 */
function roundTripDrift(expected, actual, path = '') {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return path || '(root)';
    for (let i = 0; i < expected.length; i++) {
      const d = roundTripDrift(expected[i], actual[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (expected !== null && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return path || '(root)';
    for (const k of Object.keys(expected)) {
      const d = roundTripDrift(expected[k], actual[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  // Scalars: '' round-trips as '', numbers/booleans as themselves.
  if (expected === '' && (actual === '' || actual === null)) return null;
  if (String(expected) !== String(actual)) return path || '(root)';
  return null;
}

// ---------------------------------------------------------------------------
// State (runtime/routines-state.json) — git-ignored, never travels
// ---------------------------------------------------------------------------

export function readState(repoRoot, agent) {
  const s = readJsonFile(routinesStatePath(repoRoot, agent));
  if (!s || typeof s !== 'object') return { schema: STATE_SCHEMA, updated_at: null, routines: {} };
  return {
    schema: s.schema || STATE_SCHEMA,
    updated_at: s.updated_at ?? null,
    routines: s.routines && typeof s.routines === 'object' ? s.routines : {},
  };
}

export function writeState(repoRoot, agent, state) {
  const abs = routinesStatePath(repoRoot, agent);
  writeJsonFile(repoRoot, abs, {
    schema: STATE_SCHEMA,
    updated_at: bangkokTimestamp(),
    routines: state?.routines && typeof state.routines === 'object' ? state.routines : {},
  });
  return abs;
}

function blankEntry() {
  return {
    last_instant_ms: null,
    last_instant_wall: null,
    last_fired_at: null,
    last_message_id: null,
    last_status: null,
    last_error: '',
    fire_count: 0,
    miss_count: 0,
    in_flight_instant_ms: null,
    retired_at: null,
    last_manual_run_at: null,
  };
}

/** Read-modify-write one routine's state entry. */
export function updateEntry(repoRoot, agent, id, mutate) {
  const state = readState(repoRoot, agent);
  const entry = { ...blankEntry(), ...(state.routines[id] || {}) };
  mutate(entry);
  state.routines[id] = entry;
  writeState(repoRoot, agent, state);
  return entry;
}

/** Stamp the intent to fire BEFORE sending (crash-window guard). */
export function markIntent(repoRoot, agent, id, instantMs) {
  return updateEntry(repoRoot, agent, id, (e) => {
    e.in_flight_instant_ms = instantMs;
  });
}

export function markFired(repoRoot, agent, id, { instantMs, messageId, retire }) {
  return updateEntry(repoRoot, agent, id, (e) => {
    e.last_instant_ms = instantMs;
    e.last_instant_wall = bangkokWall(instantMs);
    e.last_fired_at = bangkokTimestamp();
    e.last_message_id = messageId || null;
    e.last_status = 'fired';
    e.last_error = '';
    e.fire_count = (Number(e.fire_count) || 0) + 1;
    e.in_flight_instant_ms = null;
    if (retire) e.retired_at = bangkokTimestamp();
  });
}

/**
 * A due instant that fell outside grace. The marker ADVANCES so the miss is
 * logged once rather than on every subsequent tick forever.
 */
export function markMissed(repoRoot, agent, id, { instantMs, retire }) {
  return updateEntry(repoRoot, agent, id, (e) => {
    e.last_instant_ms = instantMs;
    e.last_instant_wall = bangkokWall(instantMs);
    e.last_status = 'missed';
    e.miss_count = (Number(e.miss_count) || 0) + 1;
    e.in_flight_instant_ms = null;
    if (retire) e.retired_at = bangkokTimestamp();
  });
}

/**
 * A fire that failed (charter drifted, category removed, sequence file gone).
 * The marker ADVANCES too: a permanently broken routine must not retry every
 * 30 seconds forever. `last_status: 'error'` surfaces it in `routine list`
 * and `scheduler status` instead.
 */
export function markError(repoRoot, agent, id, { instantMs, error }) {
  return updateEntry(repoRoot, agent, id, (e) => {
    if (Number.isFinite(instantMs)) {
      e.last_instant_ms = instantMs;
      e.last_instant_wall = bangkokWall(instantMs);
    }
    e.last_status = 'error';
    e.last_error = String(error || '').slice(0, 300);
    e.in_flight_instant_ms = null;
  });
}

export function markManualRun(repoRoot, agent, id, messageId) {
  return updateEntry(repoRoot, agent, id, (e) => {
    e.last_manual_run_at = bangkokTimestamp();
    // Deliberately does NOT touch last_instant_ms — a manual test fire must not
    // suppress the real scheduled occurrence.
    if (messageId) e.last_message_id = messageId;
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function reject(verb, msg) {
  throw new SidekicksError(`${verb}: ${msg}`, EXIT_VALIDATION);
}

/** Reject any string that cannot safely round-trip through the yaml subset. */
export function assertYamlSafe(verb, field, value) {
  const raw = String(value ?? '');
  if (raw === '') return raw;
  const p = yaml.findPoison(raw);
  if (p) {
    reject(verb, `--${field} contains ${p.what} — ${p.why}, which would make routines.yaml unreadable; rephrase without it`);
  }
  if (raw.includes('\\')) {
    reject(verb, `--${field} contains a backslash — backslashes do not survive the yaml round-trip (the reader turns an escaped \\n into a real newline); use forward slashes`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(raw)) {
    reject(verb, `--${field} contains a newline or control character — a routine value must be a single line; put long content in a --sequence file instead`);
  }
  return raw;
}

/**
 * Validate + normalize one routine against the target agent's charter.
 * Returns the canonical entry (all ROUTINE_KEYS, flat scalars).
 *
 * @param {string[]} existingIds - ids already in the file (uniqueness check)
 * @param {string[]} warnings - appended to, never thrown (advisories)
 */
export function validateRoutine(repoRoot, agent, input, existingIds = [], verb = 'agent routine add', warnings = []) {
  // Checked BEFORE requireCharter so the message is always the real reason,
  // whether or not the scheduler's own charter has been bootstrapped yet.
  if (agent === SCHEDULER_AGENT) {
    reject(verb, `'${SCHEDULER_AGENT}' is the reserved routine sender and owns no routines — attach this routine to the agent that should DO the work`);
  }

  const charter = requireCharter(repoRoot, agent);
  if (String(charter.status || 'active') !== 'active') {
    reject(verb, `agent '${agent}' is ${charter.status} — only an active agent can carry routines`);
  }

  // --- id ---
  const id = String(input.id ?? '').trim();
  if (!id) reject(verb, '--id is required (a kebab-case slug, e.g. --id=morning-standup)');
  if (!SLUG_RE.test(id)) reject(verb, `--id '${id}' must be kebab-case matching ${SLUG_RE.source}`);
  if (existingIds.includes(id)) {
    reject(verb, `routine '${id}' already exists for '${agent}' — remove it first with 'sidekicks agent routine remove ${agent} ${id}' or pick another --id`);
  }
  if (existingIds.length >= MAX_ROUTINES_PER_AGENT) {
    reject(verb, `'${agent}' already has ${existingIds.length} routines (max ${MAX_ROUTINES_PER_AGENT}) — remove one first`);
  }

  // --- when (with --cron / --every shorthand: giving one implies its kind) ---
  let when = String(input.when ?? '').trim().toLowerCase();
  const cronGiven = String(input.cron ?? '').trim();
  const everyGiven = String(input.every ?? '').trim();
  if (cronGiven && everyGiven) {
    reject(verb, '--cron and --every are mutually exclusive — pick one schedule shape');
  }
  if (!when && cronGiven) when = 'cron';
  if (!when && everyGiven) when = 'every';
  if (cronGiven && when !== 'cron') {
    reject(verb, `--cron only applies to --when=cron (this routine is --when=${when})`);
  }
  if (everyGiven && when !== 'every') {
    reject(verb, `--every only applies to --when=every (this routine is --when=${when})`);
  }
  if (!WHENS.includes(when)) {
    reject(verb, `--when '${input.when ?? ''}' is invalid — one of: ${WHENS.join(', ')}`);
  }

  // --- at (cron/every ride in the same stored field) ---
  let atRaw = String(input.at ?? '').trim();
  if (when === 'cron' || when === 'every') {
    const flagName = when === 'cron' ? '--cron' : '--every';
    const given = when === 'cron' ? cronGiven : everyGiven;
    if (atRaw && given && atRaw !== given) {
      reject(verb, `--at and ${flagName} were both given with different values — the expression rides in one field, pass ${flagName} only`);
    }
    atRaw = given || atRaw;
    if (!atRaw) {
      reject(verb, when === 'cron'
        ? '--cron "<m h dom mon dow>" is required (numeric 5-field, Asia/Bangkok wall clock; e.g. --cron="*/30 9-18 * * 1-5")'
        : `--every <interval> is required (${MIN_EVERY_MIN}m–1d; e.g. --every=30m, --every=2h)`);
    }
  } else if (!atRaw) {
    reject(verb, when === 'once'
      ? '--at is required for a one-shot (e.g. --at=2026-08-01T14:30, Asia/Bangkok wall clock)'
      : '--at is required (e.g. --at=09:30, Asia/Bangkok wall clock)');
  }
  if (when === 'cron') {
    // Re-parse OUTSIDE parseAt for the real error text (parseAt returns null).
    try {
      const spec = parseCron(atRaw);
      atRaw = spec.canonical;
      if (nextCronInstant(spec, Date.now()) === null) {
        reject(verb, `--cron '${atRaw}' never fires (no matching calendar day within 4 years) — check the dom/month combination`);
      }
      const minGap = cronMinIntervalMinutes(spec, Date.now());
      if (minGap != null && minGap < MIN_EVERY_MIN) {
        warnings.push(`this cron fires every ~${minGap} minute(s) — consider whether a routine (30s tick, mailbox send per fire) is the right tool at that rate`);
      }
    } catch (err) {
      if (err instanceof SidekicksError) throw err;
      reject(verb, `--cron '${atRaw}' is invalid — ${err.message}`);
    }
    // Defence in depth: the expression is stored in committed yaml.
    assertYamlSafe(verb, 'cron', atRaw);
  }
  if (when === 'every' && parseEvery(atRaw) == null) {
    reject(verb, `--every '${atRaw}' is invalid — an interval like 30m, 2h or 1d (${MIN_EVERY_MIN} minutes to 1 day)`);
  }
  if (when === 'once') {
    // A trailing Bangkok offset is accepted and stripped; any OTHER offset is
    // refused rather than silently reinterpreted.
    const off = /([+-]\d{2}:\d{2})$/.exec(atRaw);
    if (off) {
      if (off[1] !== '+07:00') {
        reject(verb, `--at '${atRaw}' carries offset ${off[1]} — routine times are Asia/Bangkok (+07:00) wall clock; drop the offset`);
      }
      atRaw = atRaw.slice(0, -6);
    }
    // Tolerate a seconds field by dropping it (HH:MM:SS → HH:MM); routine
    // resolution is one minute.
    atRaw = atRaw.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}$/, '$1');
  } else {
    // Accept H:MM and zero-pad it.
    const loose = /^(\d{1,2}):(\d{2})$/.exec(atRaw);
    if (loose) atRaw = `${String(+loose[1]).padStart(2, '0')}:${loose[2]}`;
  }
  const at = parseAt(when, atRaw);
  if (!at) {
    reject(verb, when === 'once'
      ? `--at '${input.at}' is invalid — expected YYYY-MM-DDTHH:MM (24-hour, Asia/Bangkok)`
      : `--at '${input.at}' is invalid — expected HH:MM (24-hour, 00:00–23:59)`);
  }
  if (when === 'once') {
    // The regex accepts 2026-02-30; a parts round-trip does not.
    const rt = bangkokParts(bangkokWallToMs(at));
    if (rt.y !== at.y || rt.m !== at.m || rt.d !== at.d || rt.hh !== at.hh || rt.mm !== at.mm) {
      reject(verb, `--at '${input.at}' is not a real date`);
    }
  }

  // --- days ---
  const daysGiven = String(input.days ?? '').trim();
  let days = '';
  if (when === 'weekly') {
    if (!daysGiven) {
      reject(verb, `--days is required for --when=weekly (e.g. --days=mon,wed,fri; one of ${DAYS.join(', ')})`);
    }
    const parsed = parseDays(daysGiven);
    const raw = daysGiven.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = raw.find((d) => !DAYS.includes(DAY_ALIASES[d] || d));
    if (unknown) reject(verb, `--days contains unknown day '${unknown}' — use ${DAYS.join(', ')}`);
    const canon = raw.map((d) => DAY_ALIASES[d] || d);
    if (new Set(canon).size !== canon.length) reject(verb, '--days contains a duplicate day');
    if (parsed.length === 0) reject(verb, '--days resolved to no days');
    days = parsed.join(',');
  } else if (daysGiven) {
    reject(verb, `--days only applies to --when=weekly (this routine is --when=${when}) — a silently ignored schedule field is worse than an error`);
  }

  // --- payload: exactly one of goal / sequence ---
  const goal = assertYamlSafe(verb, 'goal', input.goal ?? '');
  let sequence = String(input.sequence ?? '').trim();
  if (goal && sequence) {
    reject(verb, '--goal and --sequence are mutually exclusive — a routine fires either an inline prompt or a command-sequence file');
  }
  if (!goal && !sequence) {
    reject(verb, 'a payload is required — either --goal "<prompt>" or --sequence <path-to-command-sequence-file>');
  }
  if (goal.length > MAX_GOAL_LEN) {
    reject(verb, `--goal is ${goal.length} characters (max ${MAX_GOAL_LEN}) — put a longer brief in a --sequence file`);
  }
  if (sequence) {
    sequence = assertYamlSafe(verb, 'sequence', toPortablePath(repoRoot, sequence, '--sequence', verb));
    const abs = join(repoRoot, sequence);
    if (!existsSync(abs)) {
      reject(verb, `--sequence '${sequence}' does not exist (resolved against the repo root) — create the command-sequence file first`);
    }
    if (!statSync(abs).isFile()) {
      reject(verb, `--sequence '${sequence}' is not a file`);
    }
  }

  // --- category (must be claimed by the target charter) ---
  const category = String(input.category ?? '').trim();
  if (!category) {
    reject(verb, `--category is required — '${agent}' claims: ${(charter.categories || []).join(', ') || '(none)'}`);
  }
  assertYamlSafe(verb, 'category', category);
  const claimed = Array.isArray(charter.categories) ? charter.categories : [];
  if (!claimed.includes(category)) {
    reject(verb, `--category '${category}' is not in '${agent}' charter categories (${claimed.join(', ') || 'none'}) — the fire would be refused by 'agent send'`);
  }

  // --- optional scalars ---
  const priority = input.priority == null || input.priority === '' ? 2 : Number(input.priority);
  if (!Number.isInteger(priority) || priority < 0) {
    reject(verb, `--priority '${input.priority}' must be a non-negative integer`);
  }
  const work_dir = input.work_dir
    ? assertYamlSafe(verb, 'work-dir', toPortablePath(repoRoot, String(input.work_dir).trim(), '--work-dir', verb))
    : '';
  const acceptance = assertYamlSafe(verb, 'acceptance', input.acceptance ?? '');
  if (acceptance.length > MAX_ACCEPTANCE_LEN) {
    reject(verb, `--acceptance is ${acceptance.length} characters (max ${MAX_ACCEPTANCE_LEN})`);
  }
  const note = assertYamlSafe(verb, 'note', input.note ?? '');
  if (note.length > MAX_NOTE_LEN) {
    reject(verb, `--note is ${note.length} characters (max ${MAX_NOTE_LEN})`);
  }

  // --- deliver ---
  const deliver = String(input.deliver ?? '').trim().toLowerCase();
  const shapeErr = deliverShapeError(deliver);
  if (shapeErr) reject(verb, shapeErr);
  const deliverRelay = relayAgentForDeliver(deliver);
  if (deliverRelay && agent === deliverRelay) {
    reject(verb, `--deliver ${deliver} on the '${deliverRelay}' agent itself would make the relay task itself — attach the routine to the agent that should do the work`);
  }
  // A routines file is authored on one machine and fired on another, and the
  // channel table is machine-local — so an unknown lane WARNS rather than
  // rejects. The charter is auto-created at fire time either way.
  if (deliverRelay && !readCharter(repoRoot, deliverRelay)) {
    warnings.push(`the '${deliverRelay}' relay agent does not exist yet — it is auto-created at fire time, but the result only reaches your chat while 'sidekicks agent telegram serve' is running`);
  }

  // --- grace ---
  let grace_minutes;
  if (input.grace == null || input.grace === '') {
    grace_minutes = DEFAULT_GRACE_MIN[when];
    // A fast-recurring schedule must not carry an hour of grace: firing an
    // occurrence several intervals stale is worse than recording the miss.
    if (when === 'every') {
      grace_minutes = Math.max(MIN_GRACE_MIN, Math.min(DEFAULT_GRACE_MIN.every, parseEvery(atRaw)));
    } else if (when === 'cron') {
      const gap = cronMinIntervalMinutes(parseAt('cron', atRaw), Date.now());
      if (gap != null) grace_minutes = Math.max(MIN_GRACE_MIN, Math.min(DEFAULT_GRACE_MIN.cron, gap));
    }
  } else {
    const g = Number(input.grace);
    if (!Number.isInteger(g)) reject(verb, `--grace '${input.grace}' must be a whole number of minutes`);
    if (g === 0) {
      reject(verb, '--grace 0 would let the ~30s tick skip the occurrence entirely — use --grace 1 for "essentially exact"');
    }
    if (g < MIN_GRACE_MIN || g > MAX_GRACE_MIN) {
      reject(verb, `--grace '${g}' is out of range — ${MIN_GRACE_MIN}–${MAX_GRACE_MIN} minutes (7 days)`);
    }
    grace_minutes = g;
  }

  // --- advisories (never fatal) ---
  if (SECRET_RE.test(goal) || SECRET_RE.test(note) || SECRET_RE.test(acceptance)) {
    warnings.push('this routine looks like it contains a credential — routines.yaml is COMMITTED; move secrets into the environment or a git-ignored file');
  }
  if (String(charter.role || '') === 'worker') {
    warnings.push(`'${agent}' is a worker charter — a fired job waits in its inbox until a session claims it ('agent delegate' is orchestrator-only); consider attaching this routine to an orchestrator that dispatches instead`);
  }
  if (sequence) {
    const head = readHead(join(repoRoot, sequence));
    if (head && !/sk-commander/i.test(head)) {
      warnings.push(`'${sequence}' has no "RUN THIS FILE WITH THE sk-commander SKILL" banner in its first lines — the receiving agent may not route it to the commander`);
    }
    if (String(charter.role || '') === 'worker') {
      warnings.push('sk-agent-standby has no Workflow tool, so sk-commander will run its non-journaled fallback path for this sequence');
    }
  }

  const entry = {
    id,
    enabled: input.enabled === false ? false : true,
    when,
    at: atRaw,
    days,
    category,
    priority,
    goal,
    sequence,
    work_dir,
    acceptance,
    grace_minutes,
    deliver,
    note,
    created_at: bangkokTimestamp(),
  };
  // Canonical key order.
  const ordered = {};
  for (const k of ROUTINE_KEYS) ordered[k] = entry[k];
  return { entry: ordered, warnings };
}

/** First bytes of a file, for the commander-banner advisory. Never throws. */
function readHead(abs, bytes = 600) {
  try {
    return readFileSync(abs, 'utf8').slice(0, bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Firing — ONE path, shared by the daemon and `routine run`
// ---------------------------------------------------------------------------

/**
 * The send payload for a routine occurrence. Kept separate from the send itself
 * so tests can assert the mapping without a mailbox.
 */
export function buildRoutinePayload(agent, routine, { instantMs } = {}) {
  // A manual `routine run` passes no instant — the goal says so explicitly, so
  // the receiving agent can tell a test fire from a scheduled one.
  const stamp = Number.isFinite(instantMs) ? bangkokWall(instantMs) : 'manual run';
  const seq = String(routine.sequence || '');
  const goal = seq
    ? `RUN THIS FILE WITH THE sk-commander SKILL — command-sequence ${seq} (routine ${routine.id}, scheduled ${stamp})`
    : String(routine.goal || '');

  return {
    to: agent,
    // `deliver: telegram` fires the task FROM the relay agent: the worker's
    // completion then auto-replies into the relay's inbox (complete.mjs
    // autoReplyToSender) and relayInbox posts it to the user's chat with the
    // full existing rendering — HTML, option buttons, file uploads — with no
    // new relay code. The trade-off is deliberate: the outcome lands in the
    // chat instead of the scheduler's inbox drain.
    from: relayAgentForDeliver(routine.deliver) || SCHEDULER_AGENT,
    kind: 'task',
    category: String(routine.category || ''),
    goal,
    acceptance: String(routine.acceptance || ''),
    work_dir: String(routine.work_dir || ''),
    priority: routine.priority,
    // A scheduled job is ALWAYS a fresh chain. Without this, a sender that
    // happens to hold exactly one claimed message would have the job silently
    // grafted onto that unrelated delegation chain (send.mjs:135-138).
    origin: 'none',
    body_file: seq || '',
  };
}

/** True when this occurrence retires the routine (a one-shot never repeats). */
export function retiresOnFire(routine) {
  return String(routine?.when) === 'once';
}

/**
 * Fire one routine occurrence into the target agent's mailbox.
 *
 * Goes through the PROGRAMMATIC SEND PATH (buildSendArgv + send.run) rather than
 * writing mailbox JSON, so every send guarantee applies unchanged: charter
 * existence and active status, category-∈-charter, body-file normalisation and
 * existence, the cycle guard, and the id/timestamp minting. Same precedent as
 * the LAN bridge (serve.mjs:154-157) and the Telegram relay (telegram.mjs:219).
 *
 * State is stamped around the send: markIntent BEFORE (so a crash between the
 * send and the success write cannot re-fire), markFired/markError after.
 *
 * A scheduled fire is never allowed to throw — the caller is a daemon tick that
 * must survive one broken routine. `{ ok:false, error }` is returned instead.
 *
 * @returns {Promise<{ok:boolean, messageId:string|null, error:string|null}>}
 */
export async function fireRoutine(repoRoot, agent, routine, { instantMs, manual = false, noSend = false } = {}) {
  const id = String(routine.id);
  const payload = buildRoutinePayload(agent, routine, manual ? {} : { instantMs });

  if (noSend) {
    return { ok: true, messageId: null, error: null, dryRun: true, payload };
  }

  const scheduled = !manual && Number.isFinite(instantMs);
  if (scheduled) markIntent(repoRoot, agent, id, instantMs);

  let messageId = null;
  try {
    // A delivered routine sends FROM the relay agent — auto-create its charter
    // if the relay has never run (same bootstrap `telegram serve` performs).
    // After the noSend early-return above, so dry runs stay byte-identical.
    const fireRelay = relayAgentForDeliver(routine.deliver);
    if (fireRelay) {
      const { ensureRelayAgent } = await import('./telegram.mjs');
      await ensureRelayAgent(repoRoot, fireRelay, String(routine.deliver).split(':')[1] || '');
    }
    const { buildSendArgv } = await import('./serve.mjs');
    const { run: sendRun } = await import('./send.mjs');
    const argv = buildSendArgv(payload);
    const res = await sendRun({ repoRoot, argv, flags: {} }, { name: agent });
    try {
      messageId = JSON.parse(String(res?.stdout || '{}')).id ?? null;
    } catch {
      messageId = null;
    }
  } catch (err) {
    const error = err && err.message ? err.message : String(err);
    if (scheduled) markError(repoRoot, agent, id, { instantMs, error });
    return { ok: false, messageId: null, error };
  }

  if (scheduled) {
    markFired(repoRoot, agent, id, { instantMs, messageId, retire: retiresOnFire(routine) });
  }
  return { ok: true, messageId, error: null };
}

/** Is the scheduler's own charter present? Its absence drops completion replies. */
export function schedulerAgentExists(repoRoot) {
  return readCharter(repoRoot, SCHEDULER_AGENT) != null;
}
