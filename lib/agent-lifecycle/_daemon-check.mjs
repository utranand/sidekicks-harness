// lib/agent-lifecycle/_daemon-check.mjs
// Deterministic validator for the `agent_daemon` block — the substance behind
// `sidekicks agent daemon check <agent>`.
//
// WHY THIS EXISTS, and why it is not a skill or a doc paragraph.
//
// Every failure mode below is SILENT: the block still loads, the pacemaker still
// ticks, and the operator's intent is quietly discarded. Documentation cannot
// fail a build and a model-driven skill can skip a step; a deterministic check
// cannot. It also fires for hand edits to a git-ignored file, which is the only
// way this config is ever written and the one path no skill ever sees.
//
// The five silent modes, all reproduced by tests:
//
//   1. UNKNOWN KEY — the normaliser reads a fixed key set and merges DEFAULTS for
//      everything else. A typo (`min_sleep_second`) is not an error, it is the
//      default. Same for a lane declared under a misspelled agent name: it does
//      nothing, forever, and `status` looks healthy.
//   2. CLAMPED TO DEATH — `sleep_by_action` is clamped into
//      [min_sleep_seconds, max_sleep_seconds] with no comment, so
//      `verify_step: 120` under `min_sleep_seconds: 300` is a knob that cannot
//      move. It reads as configured and behaves as absent.
//   3. BLOCK TRUNCATED — readRootMessagingConfig slices this block from its
//      column-0 key to the NEXT column-0 key. A top-level line inserted mid-block
//      ends the slice early and everything after it is dropped.
//   4. POISON — the yaml subset rejects `&anchor`, `*alias` and `!!tag` on read,
//      quoting included. Inside this block that costs the whole block; elsewhere
//      it costs the whole-file parse and every block falls back to slicing.
//   5. DUPLICATE MISSION RISK — `reconcile` binds slug → MIS- id through a runtime
//      ledger ONLY. It never matches an existing mission by title, so declaring a
//      mission that already exists by hand opens a second one competing for the
//      same ticks.
//
// Everything here is PURE: raw text, the parsed block, the resolved config and the
// live facts all arrive as parameters. No filesystem, no clock, no repo. daemon.mjs
// gathers the inputs and formats the result.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { findPoison } from '../yaml-subset/yaml.mjs';
import { DEFAULTS, PACEMAKER_ACTIONS, clampSleepSeconds } from './_pacemaker.mjs';

export const CHECK_SCHEMA = 'agent-daemon-check/v1';

/** Severity order — worst first. `error` is the only level that changes exit code. */
export const LEVELS = ['error', 'warning', 'info'];

/** Recognized keys directly under `agent_daemon:`. */
export const BLOCK_KEYS = ['enabled', 'defaults', 'agents'];

/**
 * Recognized keys inside `defaults:` and inside `agents.<name>:` — the DEFAULTS
 * key set is the single source of truth, so a knob added there is never missing
 * from this check.
 */
export const LANE_KEYS = [...Object.keys(DEFAULTS), 'enabled', 'missions'];

export const TICK_KEYS = Object.keys(DEFAULTS.tick);
export const QUOTA_KEYS = Object.keys(DEFAULTS.quota);
export const DECISION_KEYS = Object.keys(DEFAULTS.decision);
export const MISSION_KEYS = [
  'id', 'enabled', 'title', 'why', 'goal', 'dod', 'dod_checks',
  'priority', 'standing', 'sleep_seconds', 'sleep_by_action',
];

/**
 * Keys distinctive enough to prove that an indented line belongs to THIS block
 * and not to whatever top-level block follows it. Deliberately excludes generic
 * names (`enabled`, `agents`, `id`, `title`, `priority`) that other blocks also
 * use — a truncation finding that fires on a healthy file is worse than none.
 */
const STRANDED_KEYS = new Set([
  'defaults', 'sleep_by_action', 'sleep_seconds', 'dod_checks', 'missions',
  'default_sleep_seconds', 'min_sleep_seconds', 'max_sleep_seconds',
  'startup_grace_seconds', 'active_hours', 'active_days', 'max_ticks_per_day',
  'pause_after_failures', 'jitter_seconds', 'log_heartbeat_minutes',
  'wake_warn_after_seconds', 'step_lease_seconds', 'quota', 'decision', 'tick',
]);

/** The reader's own block boundary rule (_bridge.mjs readRootMessagingConfig). */
const TOP_LEVEL_KEY = /^[A-Za-z_][\w-]*:/;

function finding(level, code, message, extra = {}) {
  return { level, code, message, ...extra };
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Split raw config text the way the reader does. Returns line numbers as 1-based
 * for human output, and indices as 0-based for scanning.
 *
 * @param {string} rawText whole .sidekicks/config.yaml contents ('' when absent)
 * @param {string} blockKey column-0 key to locate (default `agent_daemon`)
 */
export function locateBlock(rawText, blockKey = 'agent_daemon') {
  const lines = String(rawText ?? '').replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${blockKey}:`));
  if (start === -1) return { lines, start: -1, end: -1 };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (TOP_LEVEL_KEY.test(lines[i])) { end = i; break; }
  }
  return { lines, start, end };
}

/**
 * Mode 3 — content stranded past the slice boundary.
 *
 * The intruder is the column-0 key at `end`. Anything indented AFTER it, up to
 * the next column-0 key, is text the operator wrote inside `agent_daemon` that
 * the reader will never see. Only distinctive keys count as proof (STRANDED_KEYS),
 * so a healthy `agent_daemon:` followed by `agent_tray:` reports nothing.
 */
export function scanTruncation(lines, start, end) {
  if (start === -1 || end >= lines.length) return [];
  const stranded = [];
  for (let i = end + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (TOP_LEVEL_KEY.test(line)) break;
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s+([A-Za-z_][\w-]*):/.exec(line);
    if (m && STRANDED_KEYS.has(m[1])) stranded.push({ line: i + 1, key: m[1] });
  }
  if (!stranded.length) return [];
  const intruder = lines[end].split(':')[0];
  return [finding(
    'error',
    'block-truncated',
    `line ${end + 1} '${intruder}:' sits at column 0 INSIDE the agent_daemon block, which ends the `
      + `reader's slice there — ${plural(stranded.length, 'later line')} `
      + `(${stranded.slice(0, 4).map((s) => `${s.key} at line ${s.line}`).join(', ')}`
      + `${stranded.length > 4 ? ', …' : ''}) belong to agent_daemon and are being dropped. `
      + `Indent that line into the block, or move it above 'agent_daemon:'`,
    { line: end + 1, stranded }
  )];
}

/**
 * Mode 4 — yaml-subset poison. Replicates the parser's own guard exactly: whole
 * -line comments are skipped, everything else is scanned RAW (quoting does not
 * protect, and a trailing comment is part of the line).
 */
export function scanPoison(lines, start, end) {
  const out = [];
  const inBlock = (i) => start !== -1 && i >= start && i < end;
  let outsideCount = 0;
  let firstOutside = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    if (!stripped || stripped.startsWith('#')) continue;
    const poison = findPoison(line);
    if (!poison) continue;
    if (inBlock(i)) {
      out.push(finding(
        'error',
        'poison-in-block',
        `line ${i + 1} contains ${poison.what} — ${poison.why}. Inside agent_daemon this makes the `
          + `whole block unreadable, so the pacemaker silently runs on shipped defaults`,
        { line: i + 1 }
      ));
    } else {
      outsideCount += 1;
      if (firstOutside === null) firstOutside = { line: i + 1, what: poison.what };
    }
  }
  if (outsideCount) {
    out.push(finding(
      'warning',
      'poison-outside-block',
      `${plural(outsideCount, 'line')} elsewhere in the file contain unsupported yaml `
        + `(first: line ${firstOutside.line}, ${firstOutside.what}) — the whole-file parse fails, so `
        + `EVERY block including agent_daemon is arriving through the more fragile slice fallback. `
        + `That is survivable and is why block contiguity matters`,
      { line: firstOutside.line, count: outsideCount }
    ));
  }
  return out;
}

/**
 * Mode 1 — keys nobody reads. Walks the RAW block, because the resolved config
 * has already replaced every unknown key with a default.
 *
 * @param {object} rawBlock the `agent_daemon` value as the reader returned it
 * @param {string} agentName lane being checked
 * @param {string[]} knownAgents every agent with a charter — a lane declared
 *   under a name outside this list is a typo that does nothing forever
 */
export function scanUnknownKeys(rawBlock, agentName, knownAgents = []) {
  const out = [];
  if (!isPlainObject(rawBlock)) return out;

  const unknownIn = (obj, allowed, where, level = 'warning') => {
    if (!isPlainObject(obj)) return;
    for (const key of Object.keys(obj)) {
      if (allowed.includes(key)) continue;
      out.push(finding(
        level,
        'unknown-key',
        `${where}.${key} is not a recognized key — it is read by nothing and the shipped default `
          + `applies instead`,
        { key: `${where}.${key}` }
      ));
    }
  };

  unknownIn(rawBlock, BLOCK_KEYS, 'agent_daemon');

  const lanes = [['agent_daemon.defaults', rawBlock.defaults]];
  const agents = isPlainObject(rawBlock.agents) ? rawBlock.agents : {};
  for (const [name, lane] of Object.entries(agents)) {
    lanes.push([`agent_daemon.agents.${name}`, lane]);
    if (knownAgents.length && !knownAgents.includes(name)) {
      out.push(finding(
        'error',
        'unknown-agent',
        `agent_daemon.agents.${name} has no charter (.sidekicks/agents/${name}/agent.yaml) — this `
          + `whole override is dead config. Known lanes: ${knownAgents.join(', ')}`,
        { key: `agent_daemon.agents.${name}` }
      ));
    }
  }

  for (const [where, lane] of lanes) {
    unknownIn(lane, LANE_KEYS, where);
    if (!isPlainObject(lane)) continue;
    unknownIn(lane.tick, TICK_KEYS, `${where}.tick`);
    unknownIn(lane.quota, QUOTA_KEYS, `${where}.quota`);
    unknownIn(lane.decision, DECISION_KEYS, `${where}.decision`);
    if (Array.isArray(lane.missions)) {
      lane.missions.forEach((m, i) => {
        unknownIn(m, MISSION_KEYS, `${where}.missions[${i}]`);
      });
    }
  }

  // The lane being checked is the only one whose absence is worth mentioning:
  // inheriting the fleet defaults is the normal, intended state.
  if (isPlainObject(agents) && !Object.keys(agents).length && rawBlock.agents !== undefined) {
    out.push(finding('info', 'no-overrides', `agent_daemon.agents is empty — ${agentName} inherits the fleet defaults`));
  }
  return out;
}

/**
 * Mode 2 plus the arithmetic nobody does by hand: knobs whose configured value
 * cannot survive the clamp, and the failure gate that can wedge the lane.
 *
 * @param {object} cfg resolved config from resolveAgentDaemonConfig
 * @param {object} opts.maxConsecutiveFailures the delegate's self-restart ceiling
 * @param {object} opts.rawBlock raw block, used to tell a value the operator WROTE
 *   from one inherited from DEFAULTS. Both are equally dead, but only one is the
 *   operator's mistake — nagging a stock config about a conflict it did not create
 *   is how a check gets ignored, so an inherited clash is reported as info.
 * @param {string} opts.agentName lane whose per-agent override also counts as written
 */
export function scanKnobs(cfg, { maxConsecutiveFailures = 0, rawBlock = {}, agentName = '' } = {}) {
  const out = [];
  if (!cfg) return out;

  // Did the operator write this action's budget, or is it inherited? A per-agent
  // override and a fleet default both count as written; DEFAULTS does not.
  const writtenActions = new Set();
  for (const lane of [rawBlock?.defaults, rawBlock?.agents?.[agentName]]) {
    const table = isPlainObject(lane?.sleep_by_action) ? lane.sleep_by_action : null;
    if (table) for (const key of Object.keys(table)) writtenActions.add(key);
  }

  for (const action of PACEMAKER_ACTIONS) {
    const raw = cfg.sleep_by_action?.[action];
    if (raw === undefined) continue;
    const { seconds } = clampSleepSeconds(raw, cfg);
    if (seconds === raw) continue;
    const low = raw < seconds;
    const boundKey = low ? 'min_sleep_seconds' : 'max_sleep_seconds';
    const bound = `${boundKey} ${low ? cfg.min_sleep_seconds : cfg.max_sleep_seconds}`;
    const written = writtenActions.has(action);
    out.push(finding(
      written ? 'warning' : 'info',
      'dead-knob',
      `sleep_by_action.${action} ${raw}s can never take effect — ${bound} clamps it to ${seconds}s`
        + (written
          ? `. Lower ${boundKey} or raise the action's value; as written the knob reads as configured `
            + `and behaves as absent`
          : `. Both values are inherited defaults, so nothing you wrote is being lost — but the `
            + `${action} cadence this implies is not reachable until ${boundKey} comes down`),
      { key: `sleep_by_action.${action}`, configured: raw, effective: seconds, written }
    ));
  }

  if (maxConsecutiveFailures > 0 && cfg.pause_after_failures < maxConsecutiveFailures) {
    out.push(finding(
      'error',
      'failure-gate-deadlock',
      `pause_after_failures ${cfg.pause_after_failures} is below the delegate's self-restart ceiling `
        + `(${maxConsecutiveFailures}). The pacemaker is this lane's only tick source, so the gate `
        + `holds before the counter can ever reach the restart that would clear it — one failed wake `
        + `then leaves the lane alive and silent forever. Set it to ${maxConsecutiveFailures}`,
      { key: 'pause_after_failures', configured: cfg.pause_after_failures, required: maxConsecutiveFailures }
    ));
  }

  // Is the daily fuse doing anything? Both answers are useful and neither is a
  // defect, so this is info: an unreachable cap is a decorative fuse, and a cap
  // that binds first silences the lane before its window closes.
  const windowMinutes = cfg.active_window
    ? cfg.active_window.reduce((sum, w) => sum + Math.max(0, w.to - w.from), 0)
    : 1440;
  const fits = Math.floor((windowMinutes * 60) / Math.max(1, cfg.default_sleep_seconds));
  if (cfg.max_ticks_per_day > 0 && fits > 0) {
    out.push(cfg.max_ticks_per_day > fits
      ? finding('info', 'cap-unreachable',
        `max_ticks_per_day ${cfg.max_ticks_per_day} cannot be reached — ${windowMinutes} window `
          + `minutes at the ${cfg.default_sleep_seconds}s default budget fit at most ${fits} ticks. `
          + `The fuse is decorative at this budget`,
        { cap: cfg.max_ticks_per_day, fits })
      : finding('info', 'cap-binds-first',
        `max_ticks_per_day ${cfg.max_ticks_per_day} binds before the window closes — the window fits `
          + `${fits} ticks at the ${cfg.default_sleep_seconds}s default budget, so the lane goes quiet `
          + `for the rest of the day once the cap is spent`,
        { cap: cfg.max_ticks_per_day, fits }));
  }

  if (cfg.tick?.notify === '' && cfg.tick?.notify_resolved_from === 'auto') {
    out.push(finding(
      'warning',
      'notify-unresolved',
      `tick.notify is 'auto' but ${cfg.agent} has no relay mailbox in the telegram channel table — `
        + `every tick report it writes goes nowhere. Add a channel row targeting ${cfg.agent}, or set `
        + `tick.notify to a mailbox explicitly`,
      { key: 'tick.notify' }
    ));
  }
  return out;
}

/**
 * Mode 5 — reconcile's ledger binding vs missions that already exist.
 *
 * @param {object} cfg resolved config (cfg.missions are the declarations)
 * @param {object} opts.ledger slug → { mission_id } map ({} when no ledger yet)
 * @param {Array} opts.liveMissions [{ id, title }] live missions for this agent
 * @param {number} opts.cap live-mission cap for this agent (0 = unknown)
 */
export function scanMissions(cfg, { ledger = {}, liveMissions = [], cap = 0 } = {}) {
  const out = [];
  const declared = (cfg?.missions || []).filter((m) => m.enabled);
  const unbound = declared.filter((m) => !ledger[m.id]);

  if (unbound.length && liveMissions.length) {
    out.push(finding(
      'warning',
      'duplicate-mission-risk',
      `${plural(unbound.length, 'declaration')} (${unbound.map((m) => m.id).join(', ')}) `
        + `${unbound.length === 1 ? 'has' : 'have'} no ledger binding while `
        + `${plural(liveMissions.length, 'mission')} `
        + `(${liveMissions.map((m) => m.id).join(', ')}) ${liveMissions.length === 1 ? 'is' : 'are'} `
        + `already live. reconcile binds slug → MIS- id through the ledger ONLY and never matches an `
        + `existing mission by title, so it will OPEN new ones alongside these and both compete for `
        + `the same ticks. Close the hand-made mission first, or accept the duplicate deliberately`,
      { unbound: unbound.map((m) => m.id), live: liveMissions.map((m) => m.id) }
    ));
  }

  if (cap > 0) {
    const after = liveMissions.length + unbound.length;
    if (after > cap) {
      out.push(finding(
        'warning',
        'mission-cap-exceeded',
        `reconcile would want ${after} live missions (${liveMissions.length} live + ${unbound.length} `
          + `to open) against a cap of ${cap} — it refuses past the cap rather than forcing, so `
          + `${after - cap} ${after - cap === 1 ? 'declaration' : 'declarations'} will be skipped`,
        { after, cap }
      ));
    }
  }

  for (const decl of cfg?.missions || []) {
    if (decl.enabled) continue;
    const bound = ledger[decl.id];
    if (!bound) continue;
    out.push(finding(
      'info',
      'declaration-disabled',
      `${decl.id} is disabled but ${bound.mission_id} is still open — a disabled declaration stops `
        + `ticks toward it and never closes work. Close it by hand if it is finished`,
      { key: decl.id }
    ));
  }
  return out;
}

/**
 * Compose every scan. All inputs are parameters — no I/O, no clock.
 *
 * @param {object} input.rawText whole config.yaml text ('' when the file is absent)
 * @param {object} input.rawBlock parsed `agent_daemon` block as the reader saw it
 * @param {object} input.cfg resolved config from resolveAgentDaemonConfig
 * @param {string} input.agentName lane under check
 * @param {string[]} input.knownAgents agents with a charter
 * @param {object} input.ledger mission ledger slugs
 * @param {Array} input.liveMissions live missions for this agent
 * @param {number} input.missionCap live-mission cap
 * @param {number} input.maxConsecutiveFailures delegate self-restart ceiling
 * @param {boolean} input.delegateRunning is anything consuming ticks
 * @param {string|null} input.parseError whole-file parse error, first line only
 */
export function checkAgentDaemon(input = {}) {
  const {
    rawText = '',
    rawBlock = {},
    cfg = null,
    agentName = '',
    knownAgents = [],
    ledger = {},
    liveMissions = [],
    missionCap = 0,
    maxConsecutiveFailures = 0,
    delegateRunning = null,
    configPresent = true,
  } = input;

  const findings = [];
  const { lines, start, end } = locateBlock(rawText);

  if (!configPresent) {
    findings.push(finding('info', 'no-config', 'no .sidekicks/config.yaml — every knob is a shipped default'));
  } else if (start === -1) {
    findings.push(finding(
      'warning',
      'block-absent',
      'no agent_daemon: block in .sidekicks/config.yaml — the pacemaker runs entirely on shipped '
        + 'defaults (see .sidekicks/config.example.yaml for the documented block)'
    ));
  } else {
    findings.push(...scanTruncation(lines, start, end));
  }
  findings.push(...scanPoison(lines, start, end));

  if (configPresent && start !== -1 && !Object.keys(rawBlock || {}).length) {
    findings.push(finding(
      'error',
      'block-unreadable',
      `the agent_daemon block is present at line ${start + 1} but arrived empty — it did not parse, `
        + `so every knob in it is being ignored in favour of the shipped defaults`,
      { line: start + 1 }
    ));
  }

  findings.push(...scanUnknownKeys(rawBlock, agentName, knownAgents));
  findings.push(...scanKnobs(cfg, { maxConsecutiveFailures, rawBlock, agentName }));
  findings.push(...scanMissions(cfg, { ledger, liveMissions, cap: missionCap }));

  // The normaliser's own warnings are real findings — surfacing them here is what
  // makes `check` a superset of `status` rather than a second opinion.
  for (const w of cfg?.warnings || []) {
    findings.push(finding('warning', 'normalizer', w));
  }

  if (cfg?.enabled && delegateRunning === false) {
    findings.push(finding(
      'warning',
      'no-consumer',
      `the pacemaker is enabled but no delegate is running for ${agentName} — nothing consumes a `
        + `tick. Start one with 'sidekicks agent start ${agentName} --headless'`
    ));
  }
  if (cfg && !cfg.enabled) {
    findings.push(finding('info', 'disabled', `the pacemaker is disabled for ${agentName} — no tick is self-injected`));
  }

  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.level] = (counts[f.level] || 0) + 1;
  return { findings: sortFindings(findings), counts, ok: counts.error === 0 };
}

/** Worst level first, stable within a level so output order is deterministic. */
export function sortFindings(findings) {
  return [...findings].sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
}

const ICONS = { error: 'ERROR  ', warning: 'WARN   ', info: 'info   ' };

/** Human output. One finding per block, wrapped, worst first. */
export function formatCheck(result, { agent, configPath = '.sidekicks/config.yaml' } = {}) {
  const { findings, counts, ok } = result;
  const head = `check: ${agent} — ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info (${configPath})`;
  if (!findings.length) return `${head}\n  clean — nothing silently discarded\n`;
  const lines = [head];
  for (const f of findings) {
    const prefix = `  ${ICONS[f.level] || f.level} [${f.code}] `;
    lines.push(`${prefix}${wrap(f.message, prefix.length)}`);
  }
  lines.push(ok
    ? '  no errors — nothing is being silently discarded'
    : '  fix the error(s): config written above them is not reaching the pacemaker');
  lines.push('');
  return lines.join('\n');
}

/**
 * Soft-wrap a message, continuation lines aligned under the first. `indent` is the
 * printed prefix length, so alignment holds whatever the finding code is called.
 */
function wrap(text, indent, width = 100) {
  const pad = ' '.repeat(indent);
  const avail = Math.max(40, width - indent);
  const words = String(text).split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > avail) { out.push(line); line = w; continue; }
    line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.join(`\n${pad}`);
}
