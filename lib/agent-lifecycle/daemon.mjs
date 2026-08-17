// lib/agent-lifecycle/daemon.mjs
// `sidekicks agent daemon <sleep|status|wake|reset> <agent> [flags]`
//
// PACEMAKER control for one lane. The pacemaker itself is not a process — it is
// the delegate's idle tick (lib/agent-lifecycle/_pacemaker.mjs); this verb is
// how a woken agent tells that tick how long to rest next, and how an operator
// inspects or overrides it.
//
//   sleep   record the ONE-SHOT budget before the next self-injected tick. The
//           agent names the DECIDER ACTION it just ran (`--action execute_step`)
//           and the seconds are resolved from config, so no duration ever lives
//           in a skill or a charter. `--seconds` overrides for the case the
//           agent genuinely knows better.
//   status  the effective budget, the pending request, the declared missions,
//           and whether a delegate is even there to consume any of it.
//   wake    arm the next idle tick to fire immediately (operator lever).
//   reset   drop a pending request; the lane reverts to the config default.
//   check   VALIDATE the config block. Every failure mode it reports is silent by
//           construction — an unknown key becomes a default, a clamped knob reads
//           as configured, a column-0 line mid-block truncates the reader's slice,
//           yaml poison drops the whole block, and reconcile's slug ledger will
//           happily open a duplicate mission. Documentation cannot fail a build
//           and a skill can skip a step, so the check is deterministic and fires
//           for hand edits too. Substance lives in _daemon-check.mjs.
//
// NOT the fleet comms daemons — those stay under `agent scheduler|telegram|serve`.
// `status` reports their liveness anyway, because someone typing `agent daemon
// status` expecting them should be answered rather than punished.
//
// TWO EXIT CODES ONLY, 0 and 2. A clamped request and a pacemaker-disabled lane
// are both exit 0: this is the closing housekeeping call of a wake, and a
// nonzero exit there teaches the model to retry, escalate, or ask — the exact
// behaviours the mission-loop skill's hard rule 3 forbids. The request is still
// written with `honoured: false` so enabling the lane later works and `status`
// can prove the agent did its part.
//
// Sub-verb shape follows `agent routine` (routine.mjs:10-11): the ACTION is
// args.name and everything else rides in the raw positionals.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { SidekicksError, EXIT_OK, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { declarationFingerprint } from './amend.mjs';
import {
  parseMemoryFlags,
  bangkokTimestamp,
  validateAgentName,
  requireCharter,
  readPresence,
  presenceState,
  runtimeDir,
  toRepoRel,
  listAgentNames,
} from './_shared.mjs';
import { readJsonFile, writeJsonFile, isDaemonRunning, readRootMessagingConfig } from './_bridge.mjs';
import { checkAgentDaemon, formatCheck, CHECK_SCHEMA } from './_daemon-check.mjs';
import {
  SLEEP_REQUEST_SCHEMA,
  PACEMAKER_ACTIONS,
  ABS_MAX_SLEEP_S,
  clampSleepSeconds,
  resolveAgentDaemonConfig,
  readPacemakerState,
  readSleepRequest,
  sleepRequestPath,
  missionLedgerPath,
  pacemakerDecision,
  formatPacemakerStatus,
  bangkokDayKey,
  ticksToday,
  humanIn,
} from './_pacemaker.mjs';
import { bangkokWall } from './_routines.mjs';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ACTIONS = ['sleep', 'status', 'wake', 'reset', 'reconcile', 'check'];
const BOOLEANS = ['json', 'dry-run'];

export const MISSION_LEDGER_SCHEMA = 'agent-daemon-missions/v1';

/**
 * Text flags that MUST use the --key=value form. `parseMemoryFlags` treats any
 * `--`-prefixed token as a new flag, so the space form silently shreds a value
 * containing `--` ("pass --force to the script") — same guard, same reasoning as
 * lib/journal-lifecycle/mission.mjs.
 */
const EQUALS_ONLY = ['reason'];

const MAX_REASON_LEN = 200;
const ADOPTABLE_PRIMARY_MISSION = 'MIS-20260809-mbp-01';

/** Stable, immutable link between a charter declaration and one journal row. */
export function declarationRef(name, declaration) {
  return `agent:${name}:primary_mission:${declaration.slug}`;
}

/**
 * Bind a charter primary declaration exactly once.  This is deliberately in
 * daemon reconcile, not in an agent prompt: selection of a near-match after a
 * crash would silently join unrelated work.
 */
export async function bindDeclaration(repoRoot, name, { adopt = null, dryRun = false, deferCliValidation = false } = {}) {
  const charter = requireCharter(repoRoot, name, { deferCliValidation });
  const declaration = charter.primary_mission;
  if (!declaration) return { action: 'none', mission_id: null, declaration: null };
  const { resolveJournalConfig } = await import('../journal-lifecycle/_shared.mjs');
  const { loadMissions, readMissionEvents, isLive } = await import('../journal-lifecycle/_mission.mjs');
  const jcfg = resolveJournalConfig(repoRoot);
  if (!jcfg || jcfg.layers?.mission?.enabled === false) {
    throw new SidekicksError('agent daemon reconcile: journal mission layer is required before binding a primary declaration', EXIT_VALIDATION);
  }
  const ref = declarationRef(name, declaration);
  const fingerprint = declarationFingerprint(declaration);
  const missions = loadMissions(jcfg, { agent: name });
  const rows = [];
  for (const mission of missions) {
    for (const event of readMissionEvents(jcfg, mission.dirAbs).rows) {
      if (event?.type === 'declaration.bind') rows.push({ mission, event, data: event.data || {} });
    }
  }
  const sameRef = rows.filter(({ data }) => String(data.declaration_ref ?? '') === ref);
  if (sameRef.length > 1) throw new SidekicksError(`agent daemon reconcile: declaration '${declaration.slug}' has duplicate bindings — repair journal before start`, EXIT_VALIDATION);
  if (sameRef.length === 1) {
    const found = sameRef[0];
    if (String(found.data.fingerprint) !== fingerprint || Number(found.data.revision) !== 1 || found.mission.declaration?.conflict || !isLive(found.mission.status)) {
      throw new SidekicksError(`agent daemon reconcile: declaration '${declaration.slug}' binding is unhealthy (fingerprint, revision, conflict, or terminal mission) — repair journal before start`, EXIT_VALIDATION);
    }
    return { action: 'in-sync', mission_id: found.mission.id, declaration: { ref, fingerprint } };
  }
  let mission;
  let recovered = false;
  const requestedAdoption = adopt ? String(adopt) : '';
  if (requestedAdoption) {
    // The one legacy record predates creation refs, so adoption is the only
    // route that may bind a mission this declaration did not open.
    if (requestedAdoption !== ADOPTABLE_PRIMARY_MISSION) {
      throw new SidekicksError(`agent daemon reconcile: only ${ADOPTABLE_PRIMARY_MISSION} may be explicitly adopted`, EXIT_VALIDATION);
    }
    mission = missions.find((m) => m.id === requestedAdoption);
    if (!mission || !isLive(mission.status)) throw new SidekicksError(`agent daemon reconcile: adoption target ${requestedAdoption} is missing or terminal`, EXIT_VALIDATION);
    if (mission.agent !== name) throw new SidekicksError(`agent daemon reconcile: adoption target ${requestedAdoption} belongs to '${mission.agent}', not '${name}'`, EXIT_VALIDATION);
  } else {
    // Crash recovery, exact-identity only. A mission this declaration opened
    // carries an immutable creation ref; a crash between open and bind is
    // resumed by binding THAT record. Prose is never matched — a look-alike
    // mission is left alone rather than silently joined.
    const sameCreationRef = missions.filter((m) => m.declaration_ref === ref);
    const candidates = sameCreationRef.filter((m) => m.declaration_revision === 1 && m.declaration_fingerprint === fingerprint);
    if (candidates.length > 1) {
      throw new SidekicksError(`agent daemon reconcile: declaration '${declaration.slug}' has ${candidates.length} unbound records carrying its creation ref (${candidates.map((m) => m.id).join(', ')}) — repair journal before start`, EXIT_VALIDATION);
    }
    if (!candidates.length && sameCreationRef.length) {
      throw new SidekicksError(`agent daemon reconcile: declaration '${declaration.slug}' has a record whose creation ref disagrees on revision or fingerprint (${sameCreationRef.map((m) => m.id).join(', ')}) — repair journal before start`, EXIT_VALIDATION);
    }
    if (candidates.length === 1) {
      mission = candidates[0];
      recovered = true;
      if (!isLive(mission.status)) {
        throw new SidekicksError(`agent daemon reconcile: declaration '${declaration.slug}' candidate ${mission.id} is terminal — repair journal before start`, EXIT_VALIDATION);
      }
      if (dryRun) return { action: 'would-recover-bind', mission_id: mission.id, declaration: { ref, fingerprint } };
    } else {
      if (dryRun) return { action: 'would-open-bind', mission_id: null, declaration: { ref, fingerprint } };
      const { run: missionRun } = await import('../journal-lifecycle/mission.mjs');
      const opened = await missionRun({
        repoRoot,
        declarationRef: { ref, revision: 1, fingerprint },
        argv: ['--title=' + declaration.title, '--why=primary declaration reconcile', '--goal=' + declaration.goal, '--json'],
        flags: {},
      }, { name: 'open', rest: [name] });
      const id = JSON.parse(String(opened.stdout)).id;
      mission = loadMissions(jcfg, { agent: name }).find((m) => m.id === id);
      if (!mission) throw new SidekicksError('agent daemon reconcile: journal open did not yield a readable mission — refuse to bind', EXIT_VALIDATION);
    }
  }
  if (dryRun) return { action: 'would-adopt-bind', mission_id: mission.id, declaration: { ref, fingerprint } };
  const { run: missionRun } = await import('../journal-lifecycle/mission.mjs');
  await missionRun({
    repoRoot,
    declarationBind: true,
    argv: [
      `--type=declaration.bind`, `--declaration-ref=${ref}`, `--slug=${declaration.slug}`,
      `--fingerprint=${fingerprint}`, '--revision=1', `--adopted=${requestedAdoption ? 'true' : 'false'}`,
      `--dod-checks=${(requestedAdoption ? declaration.dod_checks : []).join('\u001f')}`,
    ],
    flags: {},
  }, { name: 'event', rest: [mission.id] });
  const action = requestedAdoption ? 'adopted-bound' : (recovered ? 'recovered-bound' : 'opened-bound');
  return { action, mission_id: mission.id, declaration: { ref, fingerprint } };
}

/**
 * The dispatcher's non-strict parseArgs leaks a space-form flag VALUE
 * (`--seconds 300`) into the positional list, so args.rest would carry '300' as
 * if it were the agent name. Re-derive the true positionals from raw argv with
 * the same consumption rule parseMemoryFlags applies.
 */
function cleanPositionals(argv, booleans) {
  const boolSet = new Set([...booleans, 'verbose', 'help', 'version']);
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      if (!body.includes('=') && !boolSet.has(body)) {
        const next = list[i + 1];
        if (next !== undefined && !next.startsWith('--')) i++; // the flag's value token
      }
      continue;
    }
    out.push(tok);
  }
  return out;
}

function assertEqualsForm(argv, action) {
  const list = Array.isArray(argv) ? argv : [];
  for (const key of EQUALS_ONLY) {
    if (list.includes(`--${key}`)) {
      throw new SidekicksError(
        `agent daemon ${action}: use --${key}=<value> (the space form shreds any text containing '--')`,
        EXIT_VALIDATION
      );
    }
  }
}

function cleanReason(raw, action) {
  const s = String(raw ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!s) return '';
  if (s.length > MAX_REASON_LEN) {
    throw new SidekicksError(
      `agent daemon ${action}: --reason is ${s.length} chars — keep it under ${MAX_REASON_LEN}`,
      EXIT_VALIDATION
    );
  }
  return s;
}

/** The declared-mission ledger, `{ "<slug>": { mission_id, … } }`. Absent = {}. */
function readMissionLedger(repoRoot, name) {
  const rec = readJsonFile(missionLedgerPath(repoRoot, name));
  return rec && typeof rec === 'object' && rec.missions && typeof rec.missions === 'object'
    ? rec.missions
    : {};
}

/**
 * Find the declared mission a `--mission` value refers to. Accepts either the
 * minted `MIS-…` id (matched through the ledger) or the config slug, because a
 * cold wake knows the mission id and an operator knows the slug.
 */
export function findDeclaredMission(cfg, ledger, missionRef) {
  const ref = String(missionRef || '').trim();
  if (!ref) return null;
  const bySlug = cfg.missions.find((m) => m.id === ref);
  if (bySlug) return bySlug;
  for (const [slug, rec] of Object.entries(ledger || {})) {
    if (rec && String(rec.mission_id || '') === ref) {
      return cfg.missions.find((m) => m.id === slug) || null;
    }
  }
  return null;
}

/**
 * Resolve the seconds a request asks for.
 *
 * Precedence, most specific first — this is what makes a PER-MISSION budget
 * real while the decider stays the authority on WHICH mission runs:
 *   1. `--seconds` (explicit override)
 *   2. the declared mission's own sleep_by_action[<action>]
 *   3. the declared mission's own sleep_seconds
 *   4. the agent's sleep_by_action[<action>]
 *   5. the agent's default_sleep_seconds
 */
export function resolveRequestedSeconds(cfg, { action, seconds, mission }) {
  if (seconds != null) {
    return { raw: seconds, source: 'seconds', via: 'explicit --seconds' };
  }
  const act = String(action || '');
  if (mission) {
    if (mission.sleep_by_action && mission.sleep_by_action[act] != null) {
      return { raw: mission.sleep_by_action[act], source: `action:${act}`, via: `mission ${mission.id} sleep_by_action.${act}` };
    }
    if (mission.sleep_seconds != null) {
      return { raw: mission.sleep_seconds, source: `action:${act}`, via: `mission ${mission.id} sleep_seconds` };
    }
  }
  if (cfg.sleep_by_action[act] != null) {
    return { raw: cfg.sleep_by_action[act], source: `action:${act}`, via: `sleep_by_action.${act}` };
  }
  return { raw: cfg.default_sleep_seconds, source: `action:${act}`, via: 'default_sleep_seconds' };
}

/** Is a delegate there to consume a request at all? */
function consumerNote(repoRoot, name) {
  const running = isDaemonRunning(repoRoot, `delegate-${name}`);
  if (running) return null;
  const p = readPresence(repoRoot, name);
  const state = presenceState(p);
  return `no delegate is running for '${name}'${state === 'fresh' ? ' (an interactive session owns the lane)' : ''} — nothing will consume this until 'sidekicks agent delegate ${name}'`;
}

function writeRequest(repoRoot, name, rec) {
  writeJsonFile(repoRoot, sleepRequestPath(repoRoot, name), rec);
}

// ---------------------------------------------------------------------------

async function cmdSleep(repoRoot, name, cfg, flags, argv) {
  assertEqualsForm(argv, 'sleep');

  const hasSeconds = flags.seconds != null && flags.seconds !== '';
  const hasAction = flags.action != null && flags.action !== '';
  if (hasSeconds === hasAction) {
    throw new SidekicksError(
      `agent daemon sleep: pass exactly one of --action <decider-action> or --seconds <n> — `
      + `actions: ${PACEMAKER_ACTIONS.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  let seconds = null;
  if (hasSeconds) {
    const n = Number(flags.seconds);
    if (!Number.isInteger(n) || n <= 0 || n > ABS_MAX_SLEEP_S) {
      throw new SidekicksError(
        `agent daemon sleep: --seconds must be a whole number of seconds between 1 and ${ABS_MAX_SLEEP_S} (got '${flags.seconds}')`,
        EXIT_VALIDATION
      );
    }
    seconds = n;
  }

  const action = hasAction ? String(flags.action).trim() : '';
  if (hasAction && !PACEMAKER_ACTIONS.includes(action)) {
    throw new SidekicksError(
      `agent daemon sleep: --action '${action}' is not a known decider action — one of: ${PACEMAKER_ACTIONS.join(', ')} `
      + `(use 'unknown' when this wake ran no decider action)`,
      EXIT_VALIDATION
    );
  }

  const reason = cleanReason(flags.reason, 'sleep');
  const missionRef = String(flags.mission || '').trim();
  const ledger = readMissionLedger(repoRoot, name);
  const mission = findDeclaredMission(cfg, ledger, missionRef);

  const resolved = resolveRequestedSeconds(cfg, { action, seconds, mission });
  const clamp = clampSleepSeconds(resolved.raw, cfg);
  const nowMs = Date.now();

  const rec = {
    schema: SLEEP_REQUEST_SCHEMA,
    agent: name,
    seconds: clamp.seconds,
    requested_seconds: Number(resolved.raw),
    clamped: clamp.clamped,
    clamp_reason: clamp.reason,
    source: resolved.source,
    action: action || null,
    mission: missionRef || null,
    resolved_via: resolved.via,
    reason,
    honoured: cfg.enabled,
    requested_at: bangkokTimestamp(),
    requested_at_ms: nowMs,
    wake_after: bangkokWall(nowMs + clamp.seconds * 1000),
    wake_after_ms: nowMs + clamp.seconds * 1000,
    session: String(flags.session || ''),
    ttl_seconds: 86_400,
  };
  writeRequest(repoRoot, name, rec);

  const note = consumerNote(repoRoot, name);
  if (flags.json) {
    return {
      stdout: `${JSON.stringify({
        ...rec,
        config: {
          enabled: cfg.enabled,
          default_sleep_seconds: cfg.default_sleep_seconds,
          min_sleep_seconds: cfg.min_sleep_seconds,
          max_sleep_seconds: cfg.max_sleep_seconds,
        },
        delegate_running: isDaemonRunning(repoRoot, `delegate-${name}`),
        state_file: toRepoRel(repoRoot, sleepRequestPath(repoRoot, name)),
        note,
      }, null, 2)}\n`,
      exitCode: EXIT_OK,
    };
  }

  const lines = [
    `pacemaker: ${name} will sleep ${rec.seconds}s (${humanIn(rec.seconds * 1000).replace('in ', '')}) before the next tick`
    + ` — one-shot, then back to the ${cfg.default_sleep_seconds}s default`,
    `  resolved:  ${resolved.raw}s via ${resolved.via}`,
  ];
  if (clamp.clamped) {
    lines.push(`  clamped:   ${resolved.raw}s → ${rec.seconds}s (${clamp.reason})`);
  }
  if (reason) lines.push(`  reason:    ${reason}`);
  lines.push(`  next tick: ${rec.wake_after} (+07:00)`);
  if (!cfg.enabled) {
    lines.push(`  note: the pacemaker is disabled for '${name}' — recorded anyway, so enabling it later honours this`);
  }
  if (note) lines.push(`  note: ${note}`);
  lines.push('');
  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}

async function cmdWake(repoRoot, name, cfg, flags, argv) {
  assertEqualsForm(argv, 'wake');
  const reason = cleanReason(flags.reason, 'wake');
  const nowMs = Date.now();
  const rec = {
    schema: SLEEP_REQUEST_SCHEMA,
    agent: name,
    seconds: 0,
    requested_seconds: 0,
    clamped: false,
    clamp_reason: null,
    source: 'wake',
    action: null,
    mission: null,
    resolved_via: 'operator wake lever',
    reason,
    honoured: cfg.enabled,
    requested_at: bangkokTimestamp(),
    requested_at_ms: nowMs,
    wake_after: bangkokWall(nowMs),
    wake_after_ms: nowMs,
    session: String(flags.session || ''),
    ttl_seconds: 86_400,
  };
  writeRequest(repoRoot, name, rec);
  const note = consumerNote(repoRoot, name);
  if (flags.json) {
    return { stdout: `${JSON.stringify({ ...rec, note }, null, 2)}\n`, exitCode: EXIT_OK };
  }
  return {
    stdout: [
      `pacemaker: ${name} will tick on its next idle pass (sleep budget bypassed — one-shot)`,
      ...(reason ? [`  reason: ${reason}`] : []),
      ...(note ? [`  note: ${note}`] : []),
      '',
    ].join('\n'),
    exitCode: EXIT_OK,
  };
}

async function cmdReset(repoRoot, name, cfg, flags) {
  const path = sleepRequestPath(repoRoot, name);
  const existed = readJsonFile(path) != null;
  if (existed) {
    try { rmSync(path, { force: true }); } catch { /* best-effort — absent is the goal */ }
  }
  if (flags.json) {
    return {
      stdout: `${JSON.stringify({
        schema: 'agent-daemon-reset/v1',
        agent: name,
        cleared: existed,
        default_sleep_seconds: cfg.default_sleep_seconds,
      }, null, 2)}\n`,
      exitCode: EXIT_OK,
    };
  }
  return {
    stdout: existed
      ? `pacemaker: cleared ${name}'s pending sleep request — the next tick uses the ${cfg.default_sleep_seconds}s default\n`
      : `pacemaker: ${name} had no pending sleep request — already on the ${cfg.default_sleep_seconds}s default\n`,
    exitCode: EXIT_OK,
  };
}

async function cmdStatus(repoRoot, name, cfg, flags) {
  const nowMs = Date.now();
  const state = readPacemakerState(repoRoot, name);
  const { request, warning } = readSleepRequest(repoRoot, name, { nowMs });
  const ledger = readMissionLedger(repoRoot, name);
  const delegateRunning = isDaemonRunning(repoRoot, `delegate-${name}`);
  const schedulerRunning = isDaemonRunning(repoRoot, 'scheduler');

  const missions = cfg.missions.map((m) => ({
    id: m.id,
    enabled: m.enabled,
    title: m.title,
    priority: m.priority,
    standing: m.standing,
    sleep_seconds: m.sleep_seconds,
    dod_checks: m.dod_checks.length,
    mission_id: ledger[m.id]?.mission_id ?? null,
  }));

  // v2 is deliberately a read model, not a second mission engine.  The journal
  // owns folds and `decideNext`; this command only joins those authoritative
  // reads with the daemon facts already reported by v1.
  let missionProjection = {
    binding: null, live: null, next_action: null,
    evidence: { journal: null, mission: null, event_shards: [] },
    error: null,
  };
  try {
    const charter = requireCharter(repoRoot, name);
    const { resolveJournalConfig } = await import('../journal-lifecycle/_shared.mjs');
    const { loadMissions, decideNext } = await import('../journal-lifecycle/_mission.mjs');
    const journal = resolveJournalConfig(repoRoot);
    if (journal?.layers?.mission?.enabled !== false) {
      const folded = loadMissions(journal, { agent: name });
      const declared = charter.primary_mission || null;
      const ref = declared ? declarationRef(name, declared) : null;
      const bindingMission = ref
        ? folded.find((m) => m.declaration?.ref === ref && !m.declaration?.conflict) || null
        : null;
      const binding = declared ? {
        declaration_ref: ref,
        slug: declared.slug,
        // Primary bindings live in the immutable journal event, not the
        // daemon's config-mission ledger (which only maps `missions:` rows).
        mission_id: bindingMission?.id ?? null,
        declaration: declared,
      } : null;
      const bound = binding?.mission_id ? folded.find((m) => m.id === binding.mission_id) || null : null;
      const live = bound || folded.find((m) => m.status === 'active' || m.status === 'blocked' || m.status === 'approved' || m.status === 'proposed') || null;
      const next = decideNext({ missions: folded, nowMs, opts: { agent: name } });
      missionProjection = {
        binding,
        live: live ? {
          id: live.id, title: live.title, status: live.status, priority: live.priority,
          standing: live.standing, progress: live.counts, step: next.mission?.id === live.id ? next.step : null,
          last_activity_at: live.last_activity_ts, path: live.path, open_target: live.dirAbs,
        } : null,
        next_action: next,
        evidence: {
          journal: journal.storeRel || null,
          mission: live?.path ?? null,
          event_shards: live?.shards ?? [],
        },
        error: null,
      };
    }
  } catch (err) {
    // Status must remain available when optional journal evidence is broken.
    missionProjection.error = String(err?.message || err).slice(0, 300);
  }

  if (flags.json) {
    const decision = pacemakerDecision({ cfg, nowMs, state, request, processStartMs: 0 });
    return {
      stdout: `${JSON.stringify({
        schema: 'agent-daemon-status/v2',
        agent: name,
        now: bangkokTimestamp(),
        enabled: cfg.enabled,
        decision: {
          action: decision.action,
          reason: decision.reason,
          sleep_seconds: decision.sleepSeconds,
          source: decision.source,
          due_at: Number.isFinite(decision.dueAtMs) ? bangkokWall(decision.dueAtMs) : null,
          due_at_ms: Number.isFinite(decision.dueAtMs) ? decision.dueAtMs : null,
        },
        config: {
          default_sleep_seconds: cfg.default_sleep_seconds,
          min_sleep_seconds: cfg.min_sleep_seconds,
          max_sleep_seconds: cfg.max_sleep_seconds,
          startup_grace_seconds: cfg.startup_grace_seconds,
          active_hours: cfg.active_hours,
          active_days: cfg.active_days,
          max_ticks_per_day: cfg.max_ticks_per_day,
          pause_after_failures: cfg.pause_after_failures,
          jitter_seconds: cfg.jitter_seconds,
          wake_warn_after_seconds: cfg.wake_warn_after_seconds,
          step_lease_seconds: cfg.step_lease_seconds,
          sleep_by_action: cfg.sleep_by_action,
          decision: cfg.decision,
          quota: cfg.quota,
          tick: cfg.tick,
        },
        warnings: cfg.warnings,
        request,
        request_warning: warning,
        ticks_today: ticksToday(state, nowMs),
        day: bangkokDayKey(nowMs),
        state,
        missions,
        delegate_running: delegateRunning,
        scheduler_running: schedulerRunning,
        state_file: toRepoRel(repoRoot, runtimeDir(repoRoot, name)),
        freshness: { observed_at: bangkokTimestamp(), observed_at_ms: nowMs, stale: false },
        mission: missionProjection,
      }, null, 2)}\n`,
      exitCode: EXIT_OK,
    };
  }

  const lines = [
    `daemon: ${name}`,
    ...formatPacemakerStatus(cfg, state, request, nowMs),
    `delegate: ${delegateRunning ? 'running' : 'NOT running — nothing consumes a tick'}   scheduler: ${schedulerRunning ? 'running' : 'not running'}`,
  ];
  if (warning) lines.push(`request: ignored — ${warning}`);
  if (missions.length) {
    lines.push('missions:');
    for (const m of missions) {
      lines.push(
        `  ${m.enabled ? '●' : '○'} ${m.id}  ${m.mission_id || '(not opened)'}  p${m.priority}`
        + `${m.standing ? ' standing' : ''}${m.sleep_seconds ? ` sleep ${m.sleep_seconds}s` : ''}`
        + `  dod checks: ${m.dod_checks}`
      );
    }
  } else {
    lines.push('missions: none declared (agent_daemon.agents.' + name + '.missions in .sidekicks/config.yaml)');
  }
  lines.push('');
  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------

/**
 * Reconcile the DECLARED missions in root config against the real L7 journal
 * missions, opening whatever is missing.
 *
 * Idempotency is the whole problem here: mission ids are MINTED by the journal
 * (there is no `--id` flag), so a second reconcile would open a second copy of
 * every declared mission. The ledger under runtime/ maps the config's stable
 * slug to the minted `MIS-…` id, and that mapping — not the title, not the goal
 * text — is what makes this verb safe to run on every tick.
 *
 * Two things it deliberately does NOT do:
 *   - It never passes `--force` past the journal's live-mission cap. It opens in
 *     declaration order and REPORTS what it skipped, because raising the cap is a
 *     deliberate journal-config decision and more concurrent missions is not more
 *     parallelism anyway (the decider is rung-first, mission-second).
 *   - It never CLOSES anything. `enabled: false` stops a mission being opened and
 *     stops it being ticked; closing needs a summary, is the store's push
 *     boundary, and is a human act.
 *
 * Journal writes are lazily imported so this module keeps no static edge into
 * journal-lifecycle (which already imports agent-lifecycle/_bridge.mjs).
 */
async function cmdReconcile(repoRoot, name, cfg, flags) {
  const dryRun = Boolean(flags['dry-run']);
  const { resolveJournalConfig, missionTuning } = await import('../journal-lifecycle/_shared.mjs');
  const jcfg = resolveJournalConfig(repoRoot);
  if (!jcfg) {
    throw new SidekicksError(
      'agent daemon reconcile: the journal store is disabled — run `sidekicks config set agent_memory.enabled true` '
      + 'in .sidekicks/settings.json before declaring missions',
      EXIT_VALIDATION
    );
  }
  if (jcfg.layers?.mission?.enabled === false) {
    throw new SidekicksError(
      'agent daemon reconcile: the mission layer is disabled in the journal config',
      EXIT_VALIDATION
    );
  }

  const primary = await bindDeclaration(repoRoot, name, {
    adopt: flags.adopt,
    dryRun,
  });

  const { loadMissions, isLive } = await import('../journal-lifecycle/_mission.mjs');
  const cap = missionTuning(jcfg, name).maxActive;

  const ledgerRec = readJsonFile(missionLedgerPath(repoRoot, name));
  const ledger = ledgerRec && typeof ledgerRec.missions === 'object' ? { ...ledgerRec.missions } : {};

  const all = loadMissions(jcfg, { agent: name });
  const byId = new Map(all.map((m) => [m.id, m]));
  let liveCount = all.filter((m) => isLive(m.status)).length;

  const results = [];
  if (primary.action !== 'none') {
    results.push({
      id: requireCharter(repoRoot, name).primary_mission.slug,
      action: primary.action,
      mission_id: primary.mission_id,
      note: 'journal declaration binding',
    });
  }
  for (const decl of cfg.missions) {
    const bound = ledger[decl.id];
    const existing = bound ? byId.get(String(bound.mission_id)) : null;

    if (!decl.enabled) {
      results.push({
        id: decl.id,
        action: 'disabled',
        mission_id: existing ? existing.id : null,
        note: existing && isLive(existing.status)
          ? `${existing.id} is left open — a disabled declaration stops ticks, never closes work`
          : 'not opened',
      });
      continue;
    }

    if (existing && isLive(existing.status)) {
      results.push({ id: decl.id, action: 'in-sync', mission_id: existing.id, note: `[${existing.status}]` });
      continue;
    }

    const reopening = Boolean(bound);
    if (liveCount >= cap) {
      results.push({
        id: decl.id,
        action: 'skipped',
        mission_id: null,
        note: `${name} is at its live-mission cap (${cap}) — raise layers.mission.agents.${name}.max_active_per_agent to open more`,
      });
      continue;
    }

    if (dryRun) {
      results.push({
        id: decl.id,
        action: reopening ? 'would-reopen' : 'would-open',
        mission_id: null,
        note: existing ? `${existing.id} is [${existing.status}]` : 'no live mission bound to this slug',
      });
      liveCount += 1;
      continue;
    }

    const argv = ['journal', 'mission', 'open', name,
      `--title=${decl.title}`,
      `--why=${decl.why || `declared in agent_daemon.agents.${name}.missions`}`,
      `--goal=${decl.goal}`,
      '--priority', String(decl.priority),
    ];
    if (decl.dod) argv.push(`--dod=${decl.dod}`);
    if (decl.standing) argv.push('--standing');
    argv.push('--json');

    let missionId = null;
    try {
      const { run: missionRun } = await import('../journal-lifecycle/mission.mjs');
      const res = await missionRun({ repoRoot, argv, flags: {} }, { name: 'open', rest: [name] });
      missionId = JSON.parse(String(res?.stdout || '{}')).id ?? null;
    } catch (err) {
      results.push({
        id: decl.id,
        action: 'failed',
        mission_id: null,
        note: err && err.message ? err.message : String(err),
      });
      continue;
    }

    ledger[decl.id] = {
      mission_id: missionId,
      opened_at: bangkokTimestamp(),
      title: decl.title,
      standing: decl.standing,
    };
    liveCount += 1;
    results.push({
      id: decl.id,
      action: reopening ? 'reopened' : 'opened',
      mission_id: missionId,
      note: decl.standing ? 'standing' : 'terminates on its definition of done',
    });
  }

  // Ledger entries whose declaration is gone: reported, never acted on. A slug
  // removed from config is a config edit, not an instruction to close work.
  for (const slug of Object.keys(ledger)) {
    if (cfg.missions.some((m) => m.id === slug)) continue;
    const m = byId.get(String(ledger[slug].mission_id));
    results.push({
      id: slug,
      action: 'orphaned',
      mission_id: ledger[slug].mission_id,
      note: m
        ? `no longer declared in config, mission is [${m.status}] — close it by hand if it is finished`
        : 'no longer declared in config and its mission is gone from the store',
    });
  }

  if (!dryRun) {
    writeJsonFile(repoRoot, missionLedgerPath(repoRoot, name), {
      schema: MISSION_LEDGER_SCHEMA,
      agent: name,
      updated_at: bangkokTimestamp(),
      missions: ledger,
    });
  }

  if (flags.json) {
    return {
      stdout: `${JSON.stringify({
        schema: 'agent-daemon-reconcile/v1',
        agent: name,
        dry_run: dryRun,
        cap,
        live_before: all.filter((m) => isLive(m.status)).length,
        declared: cfg.missions.length,
        results,
        warnings: cfg.warnings,
      }, null, 2)}\n`,
      exitCode: EXIT_OK,
    };
  }

  const lines = [`reconcile: ${name} — ${cfg.missions.length} declared, cap ${cap}${dryRun ? ' (dry run — nothing written)' : ''}`];
  if (!results.length) lines.push('  nothing declared (agent_daemon.agents.' + name + '.missions in .sidekicks/config.yaml)');
  for (const r of results) {
    lines.push(`  ${r.action.padEnd(12)} ${r.id}${r.mission_id ? ` → ${r.mission_id}` : ''}${r.note ? `  — ${r.note}` : ''}`);
  }
  for (const w of cfg.warnings) lines.push(`  config warning: ${w}`);
  lines.push('');
  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}

/**
 * Gather the live facts `checkAgentDaemon` needs, then report.
 *
 * Every input is collected here so the scanning itself stays pure and testable:
 * the raw text (to see what the reader's slice does to it), the parsed block (to
 * see keys the resolved config has already replaced with defaults), the resolved
 * config, the roster (a lane declared under a typo'd name), the mission ledger and
 * the live missions (reconcile's duplicate risk), and the delegate's liveness.
 *
 * EXIT 2 only on an `error` finding — config the operator wrote that is not
 * reaching the pacemaker. Warnings and info exit 0, so this is safe in a hook or
 * a pre-flight without turning every dead knob into a hard stop.
 */
async function cmdCheck(repoRoot, name, cfg, flags) {
  const configPath = join(repoRoot, '.sidekicks', 'config.yaml');
  const configPresent = existsSync(configPath);
  let rawText = '';
  if (configPresent) {
    try { rawText = readFileSync(configPath, 'utf8'); } catch { rawText = ''; }
  }

  let rawBlock = {};
  try { rawBlock = readRootMessagingConfig(repoRoot).agent_daemon || {}; } catch { rawBlock = {}; }

  // The delegate module is imported lazily for ONE constant: a static import would
  // pull the whole wake loop into every `agent daemon` invocation.
  let maxConsecutiveFailures = 0;
  try {
    ({ MAX_CONSECUTIVE_FAILURES: maxConsecutiveFailures } = await import('./delegate.mjs'));
  } catch { maxConsecutiveFailures = 0; }

  let liveMissions = [];
  let missionCap = 0;
  try {
    const { resolveJournalConfig, missionTuning } = await import('../journal-lifecycle/_shared.mjs');
    const jcfg = resolveJournalConfig(repoRoot);
    if (jcfg && jcfg.layers?.mission?.enabled !== false) {
      const { loadMissions, isLive } = await import('../journal-lifecycle/_mission.mjs');
      liveMissions = loadMissions(jcfg, { agent: name })
        .filter((m) => isLive(m.status))
        .map((m) => ({ id: m.id, title: m.title }));
      missionCap = missionTuning(jcfg, name).maxActive;
    }
  } catch { /* a disabled or broken journal store is reconcile's problem to report, not check's */ }

  const result = checkAgentDaemon({
    rawText,
    rawBlock,
    cfg,
    agentName: name,
    knownAgents: listAgentNames(repoRoot),
    ledger: readMissionLedger(repoRoot, name),
    liveMissions,
    missionCap,
    maxConsecutiveFailures,
    delegateRunning: isDaemonRunning(repoRoot, `delegate-${name}`),
    configPresent,
  });

  const exitCode = result.ok ? EXIT_OK : EXIT_VALIDATION;
  if (flags.json) {
    return {
      stdout: `${JSON.stringify({
        schema: CHECK_SCHEMA,
        agent: name,
        config: toRepoRel(repoRoot, configPath),
        ok: result.ok,
        counts: result.counts,
        findings: result.findings,
      }, null, 2)}\n`,
      exitCode,
    };
  }
  return { stdout: formatCheck(result, { agent: name, configPath: toRepoRel(repoRoot, configPath) }), exitCode };
}

// ---------------------------------------------------------------------------

export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, BOOLEANS);
  const action = args.name ? String(args.name) : '';
  if (!ACTIONS.includes(action)) {
    throw new SidekicksError(
      `agent daemon: an action is required — one of: ${ACTIONS.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  // positionals: ['agent','daemon',<action>,<agent>]
  const positionals = cleanPositionals(ctx.argv, BOOLEANS).slice(3);
  const agentArg = positionals[0] ? String(positionals[0]) : '';
  if (!agentArg) {
    throw new SidekicksError(
      `agent daemon ${action}: an agent name is required — 'sidekicks agent daemon ${action} <agent>'`,
      EXIT_VALIDATION
    );
  }
  const name = validateAgentName(agentArg);
  requireCharter(repoRoot, name); // exit 2 naming the charter path when absent

  const cfg = resolveAgentDaemonConfig(repoRoot, name);

  switch (action) {
    case 'sleep': return cmdSleep(repoRoot, name, cfg, flags, ctx.argv);
    case 'wake': return cmdWake(repoRoot, name, cfg, flags, ctx.argv);
    case 'reset': return cmdReset(repoRoot, name, cfg, flags);
    case 'status': return cmdStatus(repoRoot, name, cfg, flags);
    case 'reconcile': return cmdReconcile(repoRoot, name, cfg, flags);
    case 'check': return cmdCheck(repoRoot, name, cfg, flags);
    default:
      throw new SidekicksError(`agent daemon: unhandled action '${action}'`, EXIT_VALIDATION);
  }
}
