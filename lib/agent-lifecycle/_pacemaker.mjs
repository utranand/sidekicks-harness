// lib/agent-lifecycle/_pacemaker.mjs
// Delegate PACEMAKER core — NOT a dispatchable verb.
//
// The pacemaker is the lane's own clock. It is not a process: `agent delegate
// <name>` already runs a ~2s idle tick, and this module makes that tick
// self-inject a mission tick into the agent's OWN mailbox once its sleep budget
// has elapsed. The delegate then wakes on it exactly as it wakes on a chat
// message, so there is no second daemon, no second pid file, and no second
// failure surface.
//
// WHY IT EXISTS. Autonomy used to come from a cron routine fired by the routine
// scheduler, which made it depend on a THIRD process being alive: the scheduler
// was dead from 2026-07-27 to 2026-08-04 and every tick in that window was
// recorded `missed`, not queued — the agent stopped thinking and nothing said
// so. Cron also fires at fixed wall-clock instants regardless of what the agent
// had just finished, so a tick could land seconds after a 40-minute wake. The
// pacemaker inverts both: the clock lives in the process that does the waking
// (if the delegate is up, autonomy is up), and the budget is measured from the
// END of the last wake, so the agent rests a real interval after finishing
// rather than at an appointment it cannot see.
//
// Split follows _routines.mjs ↔ scheduler.mjs exactly: every decision here is a
// PURE function taking `nowMs` as a parameter, so the whole mechanism is
// testable without a clock, a mailbox, or a spawn. Only injectPacemakerTick is
// impure.
//
// EVERY VALUE IS RE-READ ON EVERY TICK (readRootMessagingConfig measures
// ~0.16ms on the real config, and the delegate already calls it each tick via
// ensureCommsProcesses). Edit .sidekicks/config.yaml and the next tick uses the
// new number with no restart — that liveness is the point, which is also why the
// numeric knobs deliberately have NO env or flag form (env is fixed at process
// start).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readJsonFile, writeJsonFile, readRootMessagingConfig } from './_bridge.mjs';
import { runtimeDir } from './_shared.mjs';
import { bangkokTimestamp } from '../memory-lifecycle/_shared.mjs';
import {
  SCHEDULER_AGENT,
  MAX_GOAL_LEN,
  BKK_OFFSET_MS,
  bangkokParts,
  bangkokWall,
  parseDays,
} from './_routines.mjs';

export const PACEMAKER_STATE_SCHEMA = 'agent-daemon-pacemaker/v1';
export const SLEEP_REQUEST_SCHEMA = 'agent-daemon-sleep/v1';

/** The root config block this module owns. */
export const CONFIG_KEY = 'agent_daemon';

// Hard rails config cannot cross. A typo in a git-ignored, hand-edited file
// costs real money on a lane whose every wake is a fresh ~40k-token bootstrap,
// so no configuration may produce a wake-per-second loop (or a lane that sleeps
// past the point of being useful).
export const ABS_MIN_SLEEP_S = 60;
export const ABS_MAX_SLEEP_S = 604_800; // 7 days

/**
 * A previous process stamped `in_flight_since` and died before recording the
 * outcome. Treated as injected (at-most-once bias, same reasoning as the
 * scheduler's in_flight_instant_ms crash-window guard) until this window
 * passes, then treated as stale.
 */
export const IN_FLIGHT_STALE_MS = 120_000;

/**
 * Decider actions a wake may report, plus the two the decider never returns:
 * `user_reply` (a chat wake, not a tick) and `unknown` (the never-stall value
 * for a wake that cannot name what it did).
 *
 * Declared LOCALLY rather than imported from journal-lifecycle on purpose:
 * lib/journal-lifecycle/_mission.mjs already imports agent-lifecycle/_bridge.mjs,
 * so an agent→journal edge here would close a module cycle. A test asserts this
 * list stays a superset of NEXT_ACTIONS (tests may import both freely).
 */
export const PACEMAKER_ACTIONS = [
  'verify_step',
  'resume_blocked',
  'execute_step',
  'close_mission',
  'plan_steps',
  'await_approval',
  'propose_goal',
  'consolidate_day',
  'idle',
  'user_reply',
  'unknown',
];

/** Request sources. `wake` is the operator's immediate-tick lever. */
export const SLEEP_SOURCES = ['config', 'agent-request', 'wake'];

/**
 * Shipped defaults — the single source of truth for both the code and the
 * documented block in .sidekicks/config.example.yaml.
 */
export const DEFAULTS = {
  default_sleep_seconds: 3600,
  min_sleep_seconds: 300,
  max_sleep_seconds: 43_200,
  startup_grace_seconds: 120,
  active_hours: '',
  active_days: '',
  max_ticks_per_day: 24,
  // Deliberately EQUAL to the delegate's MAX_CONSECUTIVE_FAILURES, not lower.
  // Lower looks safer and is worse: the pacemaker is the lane's only tick
  // source, so a hold at 1 starves the very wakes that would have carried the
  // counter up to the delegate's restart-me exit — the lane stays alive and
  // silent forever. At parity the delegate exits first, a supervisor restarts
  // it, the counter clears, and the lane recovers on its own. The hot loop this
  // gate exists to prevent is still contained meanwhile, by the delegate's
  // 30s→300s backoff on every failed wake.
  pause_after_failures: 5,
  jitter_seconds: 0,
  log_heartbeat_minutes: 60,
  wake_warn_after_seconds: 900,
  step_lease_seconds: 0, // 0 = derive from the lane's --max-runtime
  sleep_by_action: {
    verify_step: 120,
    plan_steps: 300,
    execute_step: 600,
    close_mission: 300,
    resume_blocked: 1800,
    idle: 3600,
    user_reply: 900,
    await_approval: 7200,
    propose_goal: 21_600,
    consolidate_day: 43_200,
    unknown: 3600,
  },
  decision: {
    remind_after_hours: 24,
    shelve_after_hours: 72,
    max_signals_per_decision: 2,
  },
  quota: {
    enabled: true,
    default_cooldown_seconds: 3600,
    notify: true,
    patterns: [],
  },
  tick: {
    category: 'orchestration',
    priority: 2,
    // `auto` = each lane's OWN relay mailbox, resolved from the Telegram channel
    // table. That is what lets this be a FLEET default without cross-posting one
    // lane's tick reports into another lane's chat.
    notify: 'auto',
    goal: '',
    acceptance: '',
    work_dir: '',
  },
};

/** Sub-objects merged one level deep rather than replaced wholesale. */
const NESTED_KEYS = ['sleep_by_action', 'decision', 'quota', 'tick'];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The loop's bookkeeping — written ONLY by the delegate. */
export function pacemakerStatePath(repoRoot, name) {
  return join(runtimeDir(repoRoot, name), 'daemon-pacemaker.json');
}

/** The agent's sleep request — written ONLY by `agent daemon`. */
export function sleepRequestPath(repoRoot, name) {
  return join(runtimeDir(repoRoot, name), 'daemon-sleep.json');
}

/** The declared-mission ledger — written ONLY by `agent daemon reconcile`. */
export function missionLedgerPath(repoRoot, name) {
  return join(runtimeDir(repoRoot, name), 'daemon-missions.json');
}

// ---------------------------------------------------------------------------
// Config normalisation
// ---------------------------------------------------------------------------

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function truthy(v) {
  return v === true || TRUTHY.has(String(v ?? '').toLowerCase());
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A number that came out of hand-edited YAML. Returns null for anything that is
 * not a finite number (including the numeric-looking strings yaml-subset hands
 * back for quoted values, which ARE accepted — `"3600"` is a typo class we can
 * safely honour, `"1h"` is not).
 */
function numeric(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function clampInt(value, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

/** Merge `over` onto `base`, one level deep for NESTED_KEYS. */
function mergeBlock(base, over) {
  const out = { ...base };
  if (!isPlainObject(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (NESTED_KEYS.includes(k) && isPlainObject(v) && isPlainObject(base[k])) {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Clamp a requested sleep into the effective bounds. Never refuses — a clamp is
 * a normal, reported outcome: the agent's request is ADVISORY, config is
 * AUTHORITY, and a housekeeping call must never fail in a way that teaches the
 * model to retry or escalate.
 *
 * `wake` (seconds 0) is exempt from the floor — it is a request for a tick, not
 * for a sleep.
 *
 * @returns {{seconds:number, clamped:boolean, reason:string|null}}
 */
export function clampSleepSeconds(seconds, cfg, { source = 'agent-request' } = {}) {
  const raw = numeric(seconds);
  if (raw === null) {
    return { seconds: cfg.default_sleep_seconds, clamped: true, reason: 'not a number' };
  }
  if (source === 'wake' && raw === 0) return { seconds: 0, clamped: false, reason: null };
  const lo = cfg.min_sleep_seconds;
  const hi = cfg.max_sleep_seconds;
  if (raw < lo) return { seconds: lo, clamped: true, reason: `below min_sleep_seconds ${lo}` };
  if (raw > hi) return { seconds: hi, clamped: true, reason: `above max_sleep_seconds ${hi}` };
  return { seconds: Math.round(raw), clamped: false, reason: null };
}

/**
 * Fold the raw `agent_daemon:` block into one effective config for ONE agent.
 *
 * Never throws: every bad value degrades to a documented fallback and pushes a
 * warning, because this runs on a daemon tick that must survive one hand-edited
 * number (same contract as the scheduler's tickOnce).
 *
 * Precedence: DEFAULTS < block.defaults < block.agents[<agent>].
 * `enabled` resolves per-agent-wins, so a fleet-wide `false` with one lane
 * opted in is the normal shape.
 */
export function normalizeAgentDaemonConfig(rawBlock, agentName) {
  const warnings = [];
  const block = isPlainObject(rawBlock) ? rawBlock : {};
  const agents = isPlainObject(block.agents) ? block.agents : {};
  const own = isPlainObject(agents[String(agentName)]) ? agents[String(agentName)] : {};

  const merged = mergeBlock(mergeBlock(DEFAULTS, block.defaults), own);

  // Per-agent `enabled` wins over the fleet switch in BOTH directions: it is
  // how one lane opts in while the fleet stays off, and how one lane is
  // exempted while the fleet is on.
  const enabled = own.enabled !== undefined ? truthy(own.enabled) : truthy(block.enabled);

  const num = (key, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const v = numeric(merged[key]);
    if (v === null) {
      if (merged[key] !== undefined && merged[key] !== '' && merged[key] !== DEFAULTS[key]) {
        warnings.push(`${key} '${merged[key]}' is not a number — using ${DEFAULTS[key]}`);
      }
      return DEFAULTS[key];
    }
    const c = clampInt(v, min, max);
    if (c !== Math.round(v)) warnings.push(`${key} ${v} clamped to ${c}`);
    return c;
  };

  let minSleep = num('min_sleep_seconds', { min: ABS_MIN_SLEEP_S, max: ABS_MAX_SLEEP_S });
  let maxSleep = num('max_sleep_seconds', { min: ABS_MIN_SLEEP_S, max: ABS_MAX_SLEEP_S });
  if (minSleep > maxSleep) {
    warnings.push(`min_sleep_seconds ${minSleep} exceeds max_sleep_seconds ${maxSleep} — swapped`);
    [minSleep, maxSleep] = [maxSleep, minSleep];
  }

  let defaultSleep = num('default_sleep_seconds', { min: ABS_MIN_SLEEP_S, max: ABS_MAX_SLEEP_S });
  if (defaultSleep < minSleep || defaultSleep > maxSleep) {
    const c = clampInt(defaultSleep, minSleep, maxSleep);
    warnings.push(`default_sleep_seconds ${defaultSleep} outside [${minSleep}, ${maxSleep}] — using ${c}`);
    defaultSleep = c;
  }

  let jitter = num('jitter_seconds', { min: 0, max: ABS_MAX_SLEEP_S });
  const jitterCap = Math.floor(defaultSleep / 2);
  if (jitter > jitterCap) {
    warnings.push(`jitter_seconds ${jitter} is at least half the budget — using ${jitterCap}`);
    jitter = jitterCap;
  }

  const window = parseActiveHours(merged.active_hours);
  const badRanges = badActiveHours(merged.active_hours);
  if (badRanges.length) {
    // A typo must not silence the lane forever — the good ranges stand and 24h is
    // the safe reading when none parse.
    warnings.push(
      `active_hours: ${badRanges.map((r) => `'${r}'`).join(', ')} unparseable`
      + (window ? ' — ignored, the other window(s) still apply' : ' — treating as 24h')
    );
  }

  const sleepByAction = {};
  const rawByAction = isPlainObject(merged.sleep_by_action) ? merged.sleep_by_action : {};
  for (const action of PACEMAKER_ACTIONS) {
    const v = numeric(rawByAction[action]);
    if (v === null) {
      if (rawByAction[action] !== undefined) {
        warnings.push(`sleep_by_action.${action} '${rawByAction[action]}' is not a number — ignored`);
      }
      continue;
    }
    sleepByAction[action] = clampInt(v, ABS_MIN_SLEEP_S, ABS_MAX_SLEEP_S);
  }
  for (const key of Object.keys(rawByAction)) {
    if (!PACEMAKER_ACTIONS.includes(key)) {
      warnings.push(`sleep_by_action.${key} is not a known action — ignored`);
    }
  }

  const rawTick = isPlainObject(merged.tick) ? merged.tick : {};
  let goal = oneLine(rawTick.goal ?? DEFAULTS.tick.goal);
  if (!goal) goal = defaultTickGoal(agentName);
  if (goal.length > MAX_GOAL_LEN) {
    warnings.push(`tick.goal is ${goal.length} chars — truncated to ${MAX_GOAL_LEN}`);
    goal = `${goal.slice(0, MAX_GOAL_LEN - 1)}…`;
  }

  const tickPriority = numeric(rawTick.priority);
  const tick = {
    category: String(rawTick.category ?? DEFAULTS.tick.category).trim() || DEFAULTS.tick.category,
    priority: tickPriority === null ? DEFAULTS.tick.priority : clampInt(tickPriority, 1, 5),
    notify: String(rawTick.notify ?? DEFAULTS.tick.notify).trim(),
    goal,
    acceptance: oneLine(rawTick.acceptance ?? DEFAULTS.tick.acceptance),
    work_dir: String(rawTick.work_dir ?? DEFAULTS.tick.work_dir).trim(),
  };

  const rawQuota = isPlainObject(merged.quota) ? merged.quota : {};
  const quota = {
    enabled: rawQuota.enabled === undefined ? DEFAULTS.quota.enabled : truthy(rawQuota.enabled),
    default_cooldown_seconds: clampInt(
      numeric(rawQuota.default_cooldown_seconds) ?? DEFAULTS.quota.default_cooldown_seconds,
      ABS_MIN_SLEEP_S,
      ABS_MAX_SLEEP_S
    ),
    notify: rawQuota.notify === undefined ? DEFAULTS.quota.notify : truthy(rawQuota.notify),
    patterns: Array.isArray(rawQuota.patterns) ? rawQuota.patterns.map((p) => String(p)) : [],
  };

  const rawDecision = isPlainObject(merged.decision) ? merged.decision : {};
  const decision = {
    remind_after_hours: numeric(rawDecision.remind_after_hours) ?? DEFAULTS.decision.remind_after_hours,
    shelve_after_hours: numeric(rawDecision.shelve_after_hours) ?? DEFAULTS.decision.shelve_after_hours,
    max_signals_per_decision:
      numeric(rawDecision.max_signals_per_decision) ?? DEFAULTS.decision.max_signals_per_decision,
  };

  const missions = normalizeMissions(own.missions ?? merged.missions, warnings);

  return {
    agent: String(agentName),
    enabled,
    default_sleep_seconds: defaultSleep,
    min_sleep_seconds: minSleep,
    max_sleep_seconds: maxSleep,
    startup_grace_seconds: num('startup_grace_seconds', { min: 0, max: ABS_MAX_SLEEP_S }),
    active_hours: window === null ? '' : String(merged.active_hours || '').trim(),
    active_window: window,
    active_days: parseDays(merged.active_days),
    max_ticks_per_day: num('max_ticks_per_day', { min: 0, max: 10_000 }),
    pause_after_failures: num('pause_after_failures', { min: 1, max: 100 }),
    jitter_seconds: jitter,
    log_heartbeat_minutes: num('log_heartbeat_minutes', { min: 0, max: 1440 }),
    wake_warn_after_seconds: num('wake_warn_after_seconds', { min: 0, max: ABS_MAX_SLEEP_S }),
    step_lease_seconds: num('step_lease_seconds', { min: 0, max: ABS_MAX_SLEEP_S }),
    sleep_by_action: sleepByAction,
    decision,
    quota,
    tick,
    missions,
    warnings,
  };
}

/**
 * Resolve an agent's OWN Telegram relay mailbox from the channel table.
 *
 * This is what makes `notify: auto` safe as a FLEET default. The lanes do not
 * share a mailbox: the DEFAULT channel keeps the bare `telegram` mailbox while a
 * named lane gets `telegram-<channel id>` — so `ethan` posts through `telegram`
 * and `angely` through `telegram-angely`. A hardcoded fleet-wide value would send
 * every lane's tick reports into ONE agent's chat.
 *
 * Resolved from the same config the relay itself reads, and duplicated here
 * rather than imported so this module keeps no edge into telegram.mjs (which
 * pulls the whole relay in). Returns '' when the agent has no chat surface at
 * all — the correct answer for a headless build lane, and the tick then simply
 * carries no notify instruction.
 */
export function resolveOwnRelayMailbox(repoRoot, agentName) {
  const name = String(agentName ?? '');
  if (!name) return '';
  let tg = {};
  try {
    tg = readRootMessagingConfig(repoRoot).telegram || {};
  } catch {
    return '';
  }
  const channels = Array.isArray(tg.channels) ? tg.channels : [];
  const own = channels.find((c) => c && String(c.target ?? '') === name);
  if (own) {
    const id = String(own.id ?? '').trim();
    return own.default === true || id === '' ? 'telegram' : `telegram-${id}`;
  }
  // No row of its own: the table's fallback target still reaches the default lane.
  if (String(tg.default_target ?? '') === name) return 'telegram';
  return '';
}

/** One-line, trimmed, control characters stripped. */
function oneLine(v) {
  return String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** The shipped tick goal, used when config names none. */
export function defaultTickGoal(agentName) {
  return (
    'MISSION TICK (PACEMAKER). Run the sk-agent-mission-loop skill as '
    + `${agentName}: run 'node bin/sidekicks journal mission next ${agentName} --json' and execute `
    + 'the ONE action it returns. Stamp its event, then complete this message naming the action and '
    + 'mission id. If idle: complete with idle and exit. Never ask a question; a gate or a user '
    + 'decision becomes one signal, then exit.'
  );
}

/** Normalize the declared-mission list (Phase 2 consumes it; shape is stable here). */
function normalizeMissions(raw, warnings) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push('missions must be a list of mappings — ignored');
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      warnings.push('a missions entry is not a mapping — ignored');
      continue;
    }
    const id = String(entry.id ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
      warnings.push(`missions entry id '${entry.id ?? ''}' is not a slug (a-z0-9-, ≤40) — ignored`);
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`missions entry '${id}' is declared twice — the later one is ignored`);
      continue;
    }
    seen.add(id);
    const title = oneLine(entry.title);
    if (!title) {
      warnings.push(`missions entry '${id}' has no title — ignored`);
      continue;
    }
    const priority = numeric(entry.priority);
    const sleepSeconds = numeric(entry.sleep_seconds);
    const byAction = {};
    if (isPlainObject(entry.sleep_by_action)) {
      for (const [k, v] of Object.entries(entry.sleep_by_action)) {
        const n = numeric(v);
        if (n !== null && PACEMAKER_ACTIONS.includes(k)) {
          byAction[k] = clampInt(n, ABS_MIN_SLEEP_S, ABS_MAX_SLEEP_S);
        }
      }
    }
    out.push({
      id,
      enabled: entry.enabled === undefined ? true : truthy(entry.enabled),
      title,
      why: oneLine(entry.why),
      goal: oneLine(entry.goal) || title,
      dod: oneLine(entry.dod),
      dod_checks: Array.isArray(entry.dod_checks) ? entry.dod_checks.map((c) => oneLine(c)).filter(Boolean) : [],
      priority: priority === null ? 3 : clampInt(priority, 1, 5),
      standing: truthy(entry.standing),
      sleep_seconds: sleepSeconds === null ? null : clampInt(sleepSeconds, ABS_MIN_SLEEP_S, ABS_MAX_SLEEP_S),
      sleep_by_action: byAction,
    });
  }
  return out;
}

/**
 * Read + normalize the effective pacemaker config for one agent.
 *
 * An absent file, an absent block, or an unparseable block all arrive here as
 * `{}` from readRootMessagingConfig and resolve to `enabled: false` — the
 * pacemaker degrades to OFF, never to defaults-on. That direction is
 * deliberate: this feature spends tokens on every tick, so a mis-parsed block
 * must stop the agent and say why rather than invent a schedule nobody wrote.
 */
export function resolveAgentDaemonConfig(repoRoot, agentName) {
  let raw = {};
  try {
    raw = readRootMessagingConfig(repoRoot)[CONFIG_KEY] || {};
  } catch {
    raw = {};
  }
  const cfg = normalizeAgentDaemonConfig(raw, agentName);
  // `auto` is resolved HERE rather than in the pure normaliser, which has no
  // repo to read the channel table from.
  if (cfg.tick.notify === 'auto') {
    cfg.tick.notify = resolveOwnRelayMailbox(repoRoot, agentName);
    cfg.tick.notify_resolved_from = 'auto';
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Active window
// ---------------------------------------------------------------------------

/** One `HH:MM-HH:MM` range → minute-of-day bounds, or null when unparseable. */
function parseOneRange(raw) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
  if (!m) return null;
  const [h1, m1, h2, m2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const from = h1 * 60 + m1;
  const to = h2 * 60 + m2;
  // A range that ends where it starts is 24h, not a zero-length window — that
  // reading makes `00:00-00:00` mean "always", which is what anyone writing it
  // intends, rather than "never".
  if (from === to) return { from: 0, to: 1440, wraps: false };
  return { from, to, wraps: to < from };
}

/**
 * Parse the working window(s). Accepts ONE range or a comma/semicolon-separated
 * list, so a split working day is expressible without a second config key:
 *
 *   ""                       → null (24h, the default)
 *   "06:00-21:00"            → one window
 *   "06:00-12:00,13:00-21:00" → two (a lunch gap)
 *   "22:00-06:00"            → wraps midnight
 *
 * Returns null for empty input AND for input where no range parses — the caller
 * treats null as 24h, because a typo must not silence a lane forever. A list
 * where SOME ranges parse keeps the good ones and reports the rest.
 */
export function parseActiveHours(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const parts = s.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  const windows = [];
  for (const part of parts) {
    const w = parseOneRange(part);
    if (w) windows.push(w);
  }
  return windows.length ? windows : null;
}

/** The ranges in `raw` that did NOT parse, for a config warning. */
export function badActiveHours(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  return s.split(/[,;]/).map((p) => p.trim()).filter(Boolean).filter((p) => !parseOneRange(p));
}

/**
 * Is `nowMs` inside the configured working window? Empty hours = 24h, empty days
 * = every day, and with several windows ANY of them counts. Asia/Bangkok fixed
 * +07:00, like every other wall-clock decision in the repo.
 */
export function inActiveWindow(cfg, nowMs) {
  const parts = bangkokParts(nowMs);
  const days = Array.isArray(cfg.active_days) ? cfg.active_days : [];
  if (days.length && !days.includes(parts.dow)) return false;
  const windows = cfg.active_window;
  if (!windows || !windows.length) return true;
  const minute = parts.hh * 60 + parts.mm;
  return windows.some((w) => (w.wraps
    ? (minute >= w.from || minute < w.to)
    : (minute >= w.from && minute < w.to)));
}

/** Bangkok calendar-day key (`YYYY-MM-DD`) for the daily tick cap. */
export function bangkokDayKey(nowMs) {
  return bangkokWall(nowMs).slice(0, 10);
}

/**
 * Full Bangkok stamp for an ARBITRARY instant — `YYYY-MM-DDTHH:MM:SS+07:00`.
 *
 * Log lines stamp the instant the decision was evaluated, not "now": under a
 * pinned clock those differ, and a line that reports wall-clock-now while
 * deciding about a pinned instant is both misleading and non-reproducible.
 */
export function bangkokStamp(ms) {
  const p = bangkokParts(ms);
  const secs = Math.floor(((ms + BKK_OFFSET_MS) % 60_000) / 1000);
  const z = (n, w = 2) => String(n).padStart(w, '0');
  return `${z(p.y, 4)}-${z(p.m)}-${z(p.d)}T${z(p.hh)}:${z(p.mm)}:${z(secs)}+07:00`;
}

/**
 * Deterministic ± spread so a future multi-lane fleet does not wake every
 * orchestrator at the same instant. Derived from the agent name and the budget
 * baseline — never from a random source, so a dry run stays byte-reproducible
 * and a test never flakes.
 */
export function jitterFor(cfg, baselineMs) {
  const span = cfg.jitter_seconds;
  if (!span) return 0;
  let h = 2166136261;
  const seed = `${cfg.agent}:${baselineMs}`;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const unit = (h >>> 0) / 0xffffffff;
  return Math.round((unit * 2 - 1) * span);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function blankState() {
  return {
    schema: PACEMAKER_STATE_SCHEMA,
    updated_at: null,
    last_wake_end_at: null,
    last_wake_end_ms: null,
    last_tick_at: null,
    last_tick_ms: null,
    last_tick_message_id: null,
    last_tick_sleep_seconds: null,
    last_tick_source: null,
    consumed_sleep_request_at_ms: null,
    ticks_day: null,
    ticks_today: 0,
    in_flight_since_ms: null,
    last_error: null,
    quota: null,
  };
}

/** Never throws; an absent or corrupt file reads as a blank state. */
export function readPacemakerState(repoRoot, name) {
  const rec = readJsonFile(pacemakerStatePath(repoRoot, name));
  if (!rec || typeof rec !== 'object' || rec.schema !== PACEMAKER_STATE_SCHEMA) return blankState();
  return { ...blankState(), ...rec };
}

export function writePacemakerState(repoRoot, name, patch) {
  const next = {
    ...readPacemakerState(repoRoot, name),
    ...patch,
    schema: PACEMAKER_STATE_SCHEMA,
    updated_at: bangkokTimestamp(),
  };
  writeJsonFile(repoRoot, pacemakerStatePath(repoRoot, name), next);
  return next;
}

/**
 * Stamp the end of a wake — the budget baseline.
 *
 * EVERY wake resets it, including a failed one: that is what stops a failing
 * wake from being immediately re-ticked into a loop the delegate's own backoff
 * exists to contain.
 */
export function markWakeEnd(repoRoot, name, nowMs) {
  return writePacemakerState(repoRoot, name, {
    last_wake_end_at: bangkokTimestamp(),
    last_wake_end_ms: nowMs,
  });
}

/** Stamp the intent to inject BEFORE the send (crash-window guard). */
export function markTickIntent(repoRoot, name, nowMs) {
  return writePacemakerState(repoRoot, name, { in_flight_since_ms: nowMs });
}

/** Record a completed injection and advance the day counter. */
export function markTickInjected(repoRoot, name, { nowMs, messageId, sleepSeconds, source, requestedAtMs }) {
  const state = readPacemakerState(repoRoot, name);
  const day = bangkokDayKey(nowMs);
  const sameDay = state.ticks_day === day;
  return writePacemakerState(repoRoot, name, {
    last_tick_at: bangkokTimestamp(),
    last_tick_ms: nowMs,
    last_tick_message_id: messageId ?? null,
    last_tick_sleep_seconds: sleepSeconds ?? null,
    last_tick_source: source ?? null,
    consumed_sleep_request_at_ms: requestedAtMs ?? state.consumed_sleep_request_at_ms ?? null,
    ticks_day: day,
    ticks_today: (sameDay ? state.ticks_today || 0 : 0) + 1,
    in_flight_since_ms: null,
    last_error: null,
  });
}

/**
 * Record a failed injection. The day counter still advances: a permanently
 * misconfigured tick (a category the charter does not claim, say) must not
 * retry every single budget forever — same reasoning as the scheduler advancing
 * its marker on markError.
 */
export function markTickError(repoRoot, name, { nowMs, error }) {
  const state = readPacemakerState(repoRoot, name);
  const day = bangkokDayKey(nowMs);
  const sameDay = state.ticks_day === day;
  return writePacemakerState(repoRoot, name, {
    last_tick_at: bangkokTimestamp(),
    last_tick_ms: nowMs,
    ticks_day: day,
    ticks_today: (sameDay ? state.ticks_today || 0 : 0) + 1,
    in_flight_since_ms: null,
    last_error: String(error || 'unknown'),
  });
}

/** Ticks recorded for the Bangkok day containing `nowMs`. */
export function ticksToday(state, nowMs) {
  return state.ticks_day === bangkokDayKey(nowMs) ? (state.ticks_today || 0) : 0;
}

// ---------------------------------------------------------------------------
// The sleep request (read-only here — `agent daemon` is its only writer)
// ---------------------------------------------------------------------------

/**
 * Read the agent's pending sleep request.
 *
 * Returns `{ request, warning }`. Anything malformed yields `request: null` and
 * a warning STRING the caller logs once — the delegate trusts nothing it did not
 * write, and a corrupt request must degrade to the config default rather than
 * crash a tick.
 */
export function readSleepRequest(repoRoot, name, { nowMs = Date.now() } = {}) {
  const path = sleepRequestPath(repoRoot, name);
  const rec = readJsonFile(path);
  if (!rec) {
    // readJsonFile folds ENOENT and a parse error into the same null, so absent
    // and corrupt would be indistinguishable — and a corrupt request must be
    // REPORTED, not silently treated as "no request pending".
    if (existsSync(path)) return { request: null, warning: `unreadable or wrong schema in ${path}` };
    return { request: null, warning: null }; // absent is the steady state
  }
  if (rec.schema !== SLEEP_REQUEST_SCHEMA) {
    return { request: null, warning: `unreadable or wrong schema in ${path}` };
  }
  if (String(rec.agent || '') !== String(name)) {
    return { request: null, warning: `${path} names agent '${rec.agent}' — ignored` };
  }
  const seconds = numeric(rec.seconds);
  if (seconds === null || seconds < 0) {
    return { request: null, warning: `${path} carries no usable seconds — ignored` };
  }
  const requestedAtMs = numeric(rec.requested_at_ms);
  if (requestedAtMs === null) {
    return { request: null, warning: `${path} carries no usable requested_at_ms — ignored` };
  }
  const ttl = numeric(rec.ttl_seconds) ?? 86_400;
  if (nowMs - requestedAtMs > ttl * 1000) {
    return { request: null, warning: `${path} is stale (older than ${ttl}s) — ignored` };
  }
  return { request: { ...rec, seconds, requested_at_ms: requestedAtMs }, warning: null };
}

/**
 * The budget for the NEXT tick.
 *
 * One-shot semantics fall out of a comparison rather than a mutation: the
 * request is honoured only while its `requested_at_ms` is newer than the last
 * one the delegate consumed. That is why the delegate never writes the request
 * file — two processes mutating one JSON across a wake boundary is a
 * lost-update race, and re-running the verb (a fresh timestamp) re-arms it.
 */
export function resolveSleepSeconds(cfg, request, state, { nowMs = Date.now() } = {}) {
  const warnings = [];
  if (!request) {
    return { seconds: cfg.default_sleep_seconds, source: 'config', warnings, request: null };
  }
  const consumed = numeric(state?.consumed_sleep_request_at_ms) ?? 0;
  if (request.requested_at_ms <= consumed) {
    return { seconds: cfg.default_sleep_seconds, source: 'config', warnings, request: null };
  }
  const source = String(request.source || '') === 'wake' ? 'wake' : 'agent-request';
  const { seconds, clamped, reason } = clampSleepSeconds(request.seconds, cfg, { source });
  if (clamped) {
    warnings.push(`clamped requested sleep ${request.seconds}s → ${seconds}s (${reason})`);
  }
  return { seconds, source, warnings, request };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Should this idle tick inject a mission tick?
 *
 * PURE — `nowMs` and every piece of state arrive as parameters, so every gate is
 * table-testable without a clock or a filesystem.
 *
 * Gate order is the reporting order: the first failing gate becomes `reason`,
 * which is also what the delegate logs (and only when it CHANGES, so a 2s tick
 * does not write ~43k lines a day).
 */
export function pacemakerDecision(input) {
  const {
    cfg,
    nowMs,
    state,
    request = null,
    processStartMs = 0,
    controlStage = 'running',
    stopRequested = false,
    disabledByFlag = false,
    inboxNew = 0,
    inboxClaimed = 0,
    consecutiveFailures = 0,
  } = input || {};

  const skip = (reason, extra = {}) => ({ action: 'skip', reason, sleepSeconds: null, source: null, ...extra });

  if (!cfg || !cfg.enabled) return skip('pacemaker is disabled for this agent');
  if (disabledByFlag) return skip('disabled by --no-pacemaker');
  if (stopRequested) return skip('shutting down');

  // NOT redundant with the inbox gate: the delegate forces its pending list to
  // [] while an agent is paused, so a paused agent with a FULL mailbox looks
  // idle here. Without this check the pacemaker would pile ticks on top of a
  // backlog that all lands at once on resume.
  if (controlStage !== 'running') return skip(`control stage is '${controlStage}'`);

  if (inboxNew > 0) return skip(`inbox/new has ${inboxNew} message(s)`);
  // claimed/ is normally emptied by the requeue step just above the call site,
  // so anything left here means a requeue could not complete — the agent is not
  // idle and must not be fed more work.
  if (inboxClaimed > 0) return skip(`inbox/claimed has ${inboxClaimed} message(s)`);

  if (consecutiveFailures >= cfg.pause_after_failures) {
    return skip(
      `${consecutiveFailures} consecutive failed wake(s) (pause_after_failures ${cfg.pause_after_failures}); a successful wake re-arms it`
    );
  }

  const quota = state?.quota;
  const quotaUntil = numeric(quota?.resume_at_ms);
  if (quotaUntil !== null && nowMs < quotaUntil) {
    return skip(`quota pause until ${bangkokWall(quotaUntil)}`, { quotaUntilMs: quotaUntil });
  }

  const graceUntil = processStartMs + cfg.startup_grace_seconds * 1000;
  if (nowMs < graceUntil) {
    return skip(`inside the ${cfg.startup_grace_seconds}s startup grace`);
  }

  if (!inActiveWindow(cfg, nowMs)) {
    const win = cfg.active_hours || '24h';
    const days = cfg.active_days.length ? cfg.active_days.join(',') : 'every day';
    return skip(`outside the active window (${days} ${win} Asia/Bangkok)`);
  }

  const used = ticksToday(state, nowMs);
  if (cfg.max_ticks_per_day > 0 && used >= cfg.max_ticks_per_day) {
    return skip(`daily cap reached (${used}/${cfg.max_ticks_per_day} on ${bangkokDayKey(nowMs)})`);
  }

  const inFlight = numeric(state?.in_flight_since_ms);
  if (inFlight !== null && nowMs - inFlight <= IN_FLIGHT_STALE_MS) {
    return skip('in-flight from a previous process — treated as injected');
  }

  const resolved = resolveSleepSeconds(cfg, request, state, { nowMs });

  // Baseline = the most recent thing that means "the lane was busy". A wake END
  // (not its start) is what the budget measures from, so a user conversation
  // resets the clock and the agent never ticks on top of itself.
  //
  // The process start is deliberately NOT one of these candidates, only the
  // fallback when there is no history at all: a `--once` run (and any freshly
  // restarted delegate) starts NOW, so including it in the max() would reset the
  // budget on every process generation and the lane could never become due.
  // Too-early ticks are already prevented by the startup-grace gate above.
  const history = [numeric(state?.last_wake_end_ms), numeric(state?.last_tick_ms)]
    .filter((v) => v !== null);
  // A baseline in the FUTURE means the wall clock stepped backwards (NTP, a
  // laptop resume). Dropping it beats trusting it: otherwise the pacemaker is
  // dead until the clock catches up.
  const sane = history.filter((v) => v <= nowMs);
  const clockWentBackwards = sane.length !== history.length;
  const baselineMs = sane.length ? Math.max(...sane) : graceUntil;

  const jitter = jitterFor(cfg, baselineMs);
  const dueAtMs = baselineMs + Math.max(0, resolved.seconds + jitter) * 1000;
  const remainingMs = dueAtMs - nowMs;

  const common = {
    sleepSeconds: resolved.seconds,
    source: resolved.source,
    baselineMs,
    dueAtMs,
    remainingMs,
    jitterSeconds: jitter,
    warnings: resolved.warnings,
    request: resolved.request,
    clockWentBackwards,
  };

  if (remainingMs > 0) {
    return {
      action: 'skip',
      reason: `sleeping ${Math.ceil(remainingMs / 1000)}s of ${resolved.seconds}s (next tick not before ${bangkokWall(dueAtMs)})`,
      ...common,
    };
  }

  return { action: 'inject', reason: 'budget elapsed', ...common };
}

// ---------------------------------------------------------------------------
// The injected tick
// ---------------------------------------------------------------------------

/**
 * The mailbox payload for one pacemaker tick.
 *
 * `from: scheduler` is FIXED and deliberately not configurable. The agent's
 * charter and the sk-agent-mission-loop skill both route on it ("from
 * scheduler → a routine tick, no human attached"), and every safety floor in
 * that skill hangs off it being unforgeable from chat. A `deliver: telegram`
 * style sender would arrive as `from: telegram`, which the same table
 * classifies as USER-ORIGINATED — the tick would then be pushed through the
 * dry-run plan gate as if a human had typed it. (That is a live defect in the
 * cron routine this replaces.)
 */
export function buildTickPayload(agentName, cfg, { nowMs } = {}) {
  const stamp = Number.isFinite(nowMs) ? bangkokWall(nowMs) : 'pacemaker';
  // The tail is assembled first and never truncated: the notify instruction is
  // an INSTRUCTION (dropping it silently loses the user's chat line) and the
  // stamp is how a wake tells a scheduled tick from a manual one. Only the
  // configured body is trimmed to fit the send path's goal cap.
  // An unresolved `auto` means the lane has no chat surface (or this is the pure
  // path, which has no repo to resolve against) — never instruct the agent to
  // post to a mailbox literally named "auto".
  const notify = cfg.tick.notify === 'auto' ? '' : cfg.tick.notify;
  const tail = (notify
    ? ` On completion send ONE line to ${notify} naming the action, the mission id and your next sleep.`
    : '') + ` (pacemaker tick ${stamp})`;
  const room = MAX_GOAL_LEN - tail.length;
  let body = cfg.tick.goal;
  if (body.length > room) body = `${body.slice(0, Math.max(0, room - 1))}…`;
  const goal = body + tail;

  return {
    to: String(agentName),
    from: SCHEDULER_AGENT,
    kind: 'task',
    category: cfg.tick.category,
    goal,
    acceptance: cfg.tick.acceptance,
    work_dir: cfg.tick.work_dir,
    priority: cfg.tick.priority,
    // Always a fresh chain: without this a sender holding exactly one claimed
    // message would have the tick silently grafted onto that unrelated
    // delegation chain.
    origin: 'none',
    body_file: '',
  };
}

/**
 * Inject one tick into the agent's own mailbox.
 *
 * Goes through the PROGRAMMATIC SEND PATH (buildSendArgv + send.run) rather
 * than writing mailbox JSON, so every send guarantee applies unchanged: charter
 * existence and active status, category-∈-charter, the cycle guard, and id and
 * timestamp minting. Same precedent as fireRoutine.
 *
 * Never throws — the caller is a daemon tick that must survive a misconfigured
 * category.
 */
export async function injectPacemakerTick(repoRoot, name, cfg, { nowMs, noSend = false, sleepSeconds, source, requestedAtMs } = {}) {
  const payload = buildTickPayload(name, cfg, { nowMs });
  if (noSend) return { ok: true, messageId: null, error: null, dryRun: true, payload };

  markTickIntent(repoRoot, name, nowMs);

  let messageId = null;
  try {
    // Without the scheduler's own charter, `agent complete` DROPS the tick's
    // completion reply, so the outcome would vanish silently.
    const { ensureSchedulerAgent } = await import('./scheduler.mjs');
    await ensureSchedulerAgent(repoRoot);
    const { buildSendArgv } = await import('./serve.mjs');
    const { run: sendRun } = await import('./send.mjs');
    const res = await sendRun({ repoRoot, argv: buildSendArgv(payload), flags: {} }, { name });
    try {
      messageId = JSON.parse(String(res?.stdout || '{}')).id ?? null;
    } catch {
      messageId = null;
    }
  } catch (err) {
    const error = err && err.message ? err.message : String(err);
    markTickError(repoRoot, name, { nowMs, error });
    return { ok: false, messageId: null, error, payload };
  }

  markTickInjected(repoRoot, name, { nowMs, messageId, sleepSeconds, source, requestedAtMs });
  return { ok: true, messageId, error: null, payload };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Human "in 2h 15m" from a millisecond delta. */
export function humanIn(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const past = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  const bits = [];
  if (d) bits.push(`${d}d`);
  if (h) bits.push(`${h}h`);
  if (!d && m) bits.push(`${m}m`);
  if (!bits.length) bits.push('<1m');
  return past ? `${bits.join(' ')} ago` : `in ${bits.join(' ')}`;
}

/**
 * `agent delegate --status` / `agent daemon status` lines.
 *
 * An OFF state always names its CAUSE, never just the state — "off" with no
 * reason is the shape that let a dead scheduler look intentional for a week.
 */
export function formatPacemakerStatus(cfg, state, request, nowMs, { disabledByFlag = false } = {}) {
  const lines = [];
  if (disabledByFlag) {
    lines.push('pacemaker: off (--no-pacemaker)');
    return lines;
  }
  if (!cfg.enabled) {
    lines.push(`pacemaker: off (agent_daemon is not enabled for '${cfg.agent}' — set agents.${cfg.agent}.enabled: true in .sidekicks/config.yaml)`);
    return lines;
  }

  const win = cfg.active_hours || '24h';
  const days = cfg.active_days.length ? cfg.active_days.join(',') : 'every day';
  const decision = pacemakerDecision({
    cfg, nowMs, state, request, processStartMs: 0, controlStage: 'running',
  });
  lines.push(`pacemaker: on — ${decision.sleepSeconds ?? cfg.default_sleep_seconds}s (${decision.source ?? 'config'}), window ${days} ${win} Asia/Bangkok`);
  if (decision.action === 'inject') {
    lines.push('next tick: due now');
  } else if (Number.isFinite(decision.dueAtMs)) {
    lines.push(`next tick: ${bangkokWall(decision.dueAtMs)} (${humanIn(decision.dueAtMs - nowMs)})`);
  } else {
    lines.push(`next tick: held — ${decision.reason}`);
  }
  lines.push(`ticks today: ${ticksToday(state, nowMs)}/${cfg.max_ticks_per_day || '∞'}   last tick: ${state.last_tick_message_id || '(none)'}${state.last_tick_at ? ` at ${state.last_tick_at}` : ''}`);
  lines.push(`agent-set: ${request ? `${request.seconds}s (${request.source}${request.action ? ` ${request.action}` : ''}) requested ${request.requested_at || '?'}` : 'none pending'}`);
  if (state.quota && Number.isFinite(state.quota.resume_at_ms)) {
    lines.push(`quota: paused until ${bangkokWall(state.quota.resume_at_ms)} (${humanIn(state.quota.resume_at_ms - nowMs)}) — ${state.quota.evidence || 'no evidence recorded'}`);
  }
  if (state.last_error) lines.push(`last error: ${state.last_error}`);
  for (const w of cfg.warnings) lines.push(`config warning: ${w}`);
  return lines;
}
