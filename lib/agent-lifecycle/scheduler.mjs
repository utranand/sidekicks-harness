// lib/agent-lifecycle/scheduler.mjs
// `sidekicks agent scheduler <serve|status|stop> [--interval 30] [--once] [--json]`
//
// The fleet-wide routine scheduler. One daemon watches EVERY agent's committed
// routines.yaml and, when an occurrence comes due, enqueues a normal task into
// that agent's mailbox through the validated `agent send` path. From there the
// existing machinery takes over unchanged: a running delegate wakes on the
// inbox/new count, or a standby session claims it on its next wait tick.
//
// Why a daemon rather than a per-agent self-check: day-of-week + wall-clock
// firing needs a clock that ticks whether or not the target agent happens to be
// online, at a resolution finer than a wait cycle. ~30s means 09:30 means 09:30.
//
// Ownership is a pidfile (`scheduler`), so exactly one loop per repo can fire —
// that single-writer property is what makes the state file race-free.
//
// The daemon writes ONLY git-ignored runtime state. routines.yaml is mutated
// exclusively by `agent routine`, i.e. by a human, so a schedule change is
// always visible in git.

import { setTimeout as sleep } from 'node:timers/promises';
import { relative, join } from 'node:path';
import { rmSync } from 'node:fs';
import { SidekicksError, EXIT_OK, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  parseMemoryFlags,
  bangkokTimestamp,
  listAgentNames,
  readCharter,
  readControlStage,
  writeControlStage,
  writePresence,
  readPresence,
  presencePath,
  ensureRuntimeTree,
  listMessageIds,
  readMessage,
  claimRename,
  moveToDone,
} from './_shared.mjs';
import {
  acquirePidFile,
  isDaemonRunning,
  pidFilePath,
  readJsonFile,
  writeJsonFile,
  bridgeRuntimeDir,
} from './_bridge.mjs';
import {
  SCHEDULER_AGENT,
  readRoutinesFile,
  partitionRoutines,
  readState,
  routineDue,
  nextScheduledInstant,
  markMissed,
  markError,
  bangkokWall,
  graceMinutes,
  fireRoutine,
  retiresOnFire,
} from './_routines.mjs';
import { run as createRun } from './create.mjs';

const ACTIONS = ['serve', 'status', 'stop'];
const DAEMON = 'scheduler';
const DEFAULT_INTERVAL_S = 30;
const MIN_INTERVAL_S = 5;
const MAX_INTERVAL_S = 3600;
const LOG_NAME = 'scheduler.log';

/** Recent-fire ring kept in state for `status` (the log is for humans). */
const RECENT_CAP = 10;

export function schedulerLogPath(repoRoot) {
  return join(bridgeRuntimeDir(repoRoot), 'logs', LOG_NAME);
}

/** Fleet-level scheduler state (distinct from each agent's routine state). */
export function schedulerStatePath(repoRoot) {
  return join(bridgeRuntimeDir(repoRoot), 'scheduler.json');
}

/**
 * One log line. Timestamped, unlike the delegate log: this log's entire subject
 * IS time ("late 35m" vs "missed 92m > grace 60m" is meaningless without an
 * absolute instant), it is read forensically days later as the only durable
 * record that a routine ran, and it spans daemon restarts and machine sleeps —
 * so line order alone cannot reconstruct when anything happened.
 */
function log(msg) {
  process.stdout.write(`${bangkokTimestamp()} scheduler: ${msg}\n`);
}

function numberFlag(flags, key, fallback, { min, max }) {
  if (flags[key] == null || flags[key] === '') return fallback;
  const n = Number(flags[key]);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new SidekicksError(
      `agent scheduler: invalid --${key} '${flags[key]}' — a whole number between ${min} and ${max}`,
      EXIT_VALIDATION
    );
  }
  return n;
}

/**
 * `SIDEKICKS_SCHEDULER_NOW` pins the clock for deterministic tests. Honoured
 * ONLY with --once: a long-running loop frozen in time would spin forever
 * re-evaluating the same instant.
 */
function resolveNow(env, once) {
  const raw = String(env.SIDEKICKS_SCHEDULER_NOW || '').trim();
  if (!raw) return null;
  if (!once) {
    throw new SidekicksError(
      'agent scheduler: SIDEKICKS_SCHEDULER_NOW only applies with --once (a continuous loop cannot run with a frozen clock)',
      EXIT_VALIDATION
    );
  }
  // Bangkok wall clock (YYYY-MM-DDTHH:MM[:SS]) or any Date-parseable instant.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (m) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 7 * 3_600_000;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new SidekicksError(
      `agent scheduler: SIDEKICKS_SCHEDULER_NOW '${raw}' is not a valid instant — use YYYY-MM-DDTHH:MM (Asia/Bangkok)`,
      EXIT_VALIDATION
    );
  }
  return parsed;
}

/**
 * The scheduler's own charter must exist: `agent complete` DROPS the completion
 * reply when the sender has no charter (complete.mjs:55-61), so without it every
 * routine result would vanish silently. Same bootstrap as the Telegram relay.
 */
export async function ensureSchedulerAgent(repoRoot) {
  if (readCharter(repoRoot, SCHEDULER_AGENT)) return false;
  await createRun(
    {
      repoRoot,
      argv: [
        'agent', 'create', SCHEDULER_AGENT,
        '--specialty=Routine scheduler — fires each agent\'s scheduled routines into its mailbox at the appointed time',
        '--categories=scheduling',
        '--role=worker',
      ],
      flags: {},
    },
    { name: SCHEDULER_AGENT }
  );
  return true;
}

// ---------------------------------------------------------------------------
// One tick
// ---------------------------------------------------------------------------

/**
 * Evaluate every agent's routines once and fire what is due.
 * Never throws for a per-agent or per-routine problem — a daemon tick must
 * survive one unreadable file or one broken routine.
 *
 * @returns {Promise<{fired:number, missed:number, errors:number, skipped:number, recent:object[]}>}
 */
export async function tickOnce(repoRoot, { nowMs, noSend = false } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const summary = { fired: 0, missed: 0, errors: 0, skipped: 0, recent: [] };

  for (const agent of listAgentNames(repoRoot)) {
    if (agent === SCHEDULER_AGENT) continue;

    const charter = readCharter(repoRoot, agent);
    if (!charter || String(charter.status || 'active') !== 'active') continue;

    let doc;
    try {
      doc = readRoutinesFile(repoRoot, agent);
    } catch (err) {
      log(`unreadable ${agent}/routines.yaml — ${err.message}`);
      summary.errors++;
      continue;
    }
    const { ok: routines, bad } = partitionRoutines(doc);
    if (bad.length > 0) {
      log(`skipped ${bad.length} hand-nested routine(s) for ${agent} (${bad.map((b) => b.id).join(', ')}) — flatten them with 'agent routine list ${agent}'`);
    }
    if (routines.length === 0) continue;

    // A stopped or paused agent must not accumulate scheduled work: the
    // occurrence is consumed (marker advanced) and logged as gated.
    const stage = readControlStage(repoRoot, agent);
    if (stage === 'stop' || stage === 'pause') {
      let gated = 0;
      const state = readState(repoRoot, agent);
      for (const r of routines) {
        const verdict = routineDue(r, state.routines[String(r.id)] || null, now);
        if (verdict.action === 'fire' || verdict.action === 'miss') {
          // Consume the occurrence so a paused agent does not accumulate a
          // backlog that all lands at once on resume.
          if (!noSend) {
            markMissed(repoRoot, agent, String(r.id), {
              instantMs: verdict.instantMs,
              retire: retiresOnFire(r),
            });
          }
          gated++;
        }
      }
      if (gated > 0) {
        summary.skipped += gated;
        log(`gated ${agent} (control stage ${stage}) — ${gated} occurrence(s) skipped`);
      }
      continue;
    }

    for (const r of routines) {
      const id = String(r.id);
      // State is re-read per routine: a fire mutates it, and the next routine
      // must see that write.
      const state = readState(repoRoot, agent);
      const verdict = routineDue(r, state.routines[id] || null, now);

      if (verdict.action === 'skip') {
        summary.skipped++;
        continue;
      }

      if (verdict.action === 'miss') {
        // The marker ADVANCES so the miss is logged once, not on every tick
        // forever — but a dry run must leave state untouched.
        if (!noSend) {
          markMissed(repoRoot, agent, id, { instantMs: verdict.instantMs, retire: retiresOnFire(r) });
        }
        summary.missed++;
        log(`${noSend ? '[dry-run] would record ' : ''}missed ${agent}/${id} (${r.when} ${r.at}${r.days ? ` ${r.days}` : ''}, instant ${bangkokWall(verdict.instantMs)}, late ${Math.round(verdict.lateMs / 60000)}m > grace ${graceMinutes(r)}m) — skipped`);
        summary.recent.push({ at: bangkokTimestamp(), agent, id, status: 'missed', detail: `late ${Math.round(verdict.lateMs / 60000)}m > grace ${graceMinutes(r)}m` });
        continue;
      }

      // fire
      const res = await fireRoutine(repoRoot, agent, r, { instantMs: verdict.instantMs, noSend });
      if (noSend) {
        summary.fired++;
        log(`[dry-run] would fire ${agent}/${id} (${r.when} ${r.at}${r.days ? ` ${r.days}` : ''}, instant ${bangkokWall(verdict.instantMs)}) [${r.category}]`);
        continue;
      }
      if (res.ok) {
        summary.fired++;
        const lateS = Math.round(verdict.lateMs / 1000);
        const payloadNote = r.sequence ? ` → sequence ${r.sequence}` : '';
        const deliverNote = r.deliver ? ` → deliver ${r.deliver}` : '';
        log(`fired ${agent}/${id} (${r.when} ${r.at}${r.days ? ` ${r.days}` : ''}, instant ${bangkokWall(verdict.instantMs)}, late ${lateS}s)${payloadNote}${deliverNote} → ${res.messageId || '(id unknown)'} [${r.category}]`);
        summary.recent.push({ at: bangkokTimestamp(), agent, id, status: 'fired', detail: res.messageId || '' });
      } else {
        summary.errors++;
        // The marker was advanced by markError: a permanently broken routine
        // (category removed from the charter, sequence file deleted) must not
        // retry every tick forever. last_status:'error' surfaces it instead.
        log(`error ${agent}/${id} (${res.error}) — marker advanced, fix it and re-enable`);
        summary.recent.push({ at: bangkokTimestamp(), agent, id, status: 'error', detail: String(res.error).slice(0, 160) });
      }
    }
  }

  return summary;
}

/**
 * Drain the scheduler's own inbox. Completion replies from fired routines land
 * here; without this they accumulate forever in a git-ignored directory and the
 * roster shows an ever-rising `new:` count. Logging them turns that liability
 * into the outcome journal for scheduled work.
 */
function drainOwnInbox(repoRoot) {
  let drained = 0;
  for (const id of listMessageIds(repoRoot, SCHEDULER_AGENT, 'new')) {
    const msg = readMessage(repoRoot, SCHEDULER_AGENT, 'new', id);
    if (!claimRename(repoRoot, SCHEDULER_AGENT, id)) continue;
    const r = msg?.result || {};
    const from = msg?.from || '?';
    const summary = String(r.summary || '').slice(0, 200);
    log(`reply from ${from} re ${msg?.reply_to || id} — ${r.status || 'no status'}${summary ? `: ${summary}` : ''}`);
    moveToDone(repoRoot, SCHEDULER_AGENT, id);
    drained++;
  }
  return drained;
}

function readFleetState(repoRoot) {
  const s = readJsonFile(schedulerStatePath(repoRoot));
  return s && typeof s === 'object' ? s : {};
}

/**
 * Merge a patch into the fleet state file, keeping a bounded ring of recent
 * events. `status` reads its `recent:` block from HERE, never by parsing the
 * log — the log is for humans, state is the API.
 */
function persistFleet(repoRoot, patch, recent) {
  const prev = readFleetState(repoRoot);
  const merged = {
    ...prev,
    ...patch,
    recent: [...(recent || []), ...(Array.isArray(prev.recent) ? prev.recent : [])].slice(0, RECENT_CAP),
    updated_at: bangkokTimestamp(),
  };
  writeJsonFile(repoRoot, schedulerStatePath(repoRoot), merged);
  return merged;
}

// ---------------------------------------------------------------------------
// Verb
// ---------------------------------------------------------------------------

export async function run(ctx, args) {
  const flags = parseMemoryFlags(ctx.argv, ['json', 'once', 'force']);
  const action = args.name ? String(args.name) : '';
  if (!ACTIONS.includes(action)) {
    throw new SidekicksError(
      `agent scheduler: an action is required — one of: ${ACTIONS.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  const { repoRoot } = ctx;

  if (action === 'status') return statusReport(repoRoot, flags);
  if (action === 'stop') {
    writeControlStage(repoRoot, SCHEDULER_AGENT, 'stop');
    return {
      stdout:
        `scheduler: stop requested — the loop exits within one tick\n` +
        `  auto-restart stays off until 'sidekicks agent scheduler serve' or 'sidekicks agent stop --stage resume ${SCHEDULER_AGENT}'\n`,
      exitCode: EXIT_OK,
    };
  }

  return serve(repoRoot, ctx, flags);
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

async function serve(repoRoot, ctx, flags) {
  const env = process.env;
  const once = Boolean(flags.once);
  const intervalS = numberFlag(flags, 'interval', DEFAULT_INTERVAL_S, { min: MIN_INTERVAL_S, max: MAX_INTERVAL_S });
  const pinnedNow = resolveNow(env, once);
  const noSend = env.SIDEKICKS_SCHEDULER_NO_SEND === '1';

  // A dry run is a REHEARSAL and must leave the repo byte-identical: no sender
  // charter, no runtime tree, no control-gate rewrite, no pidfile. Bootstrapping
  // an agent directory is exactly the kind of side effect that makes a "safe to
  // re-run" claim false, so all of it is gated behind !noSend.
  if (!noSend) {
    const created = await ensureSchedulerAgent(repoRoot);
    ensureRuntimeTree(repoRoot, SCHEDULER_AGENT);
    if (created) log(`created the '${SCHEDULER_AGENT}' sender charter`);

    // An explicit serve clears a stale stop gate (agent start does the same,
    // start.mjs:275-281) — otherwise a previous `scheduler stop` would make the
    // daemon exit on its first tick with no explanation.
    if (readControlStage(repoRoot, SCHEDULER_AGENT) === 'stop') {
      writeControlStage(repoRoot, SCHEDULER_AGENT, 'running');
    }

    const claim = acquirePidFile(repoRoot, DAEMON, process.pid);
    if (!claim.ok) {
      throw new SidekicksError(
        `agent scheduler serve: already running (pid ${claim.pid}) — stop it with 'sidekicks agent scheduler stop'`,
        EXIT_VALIDATION
      );
    }
  }

  let stopRequested = false;
  const onSignal = () => { stopRequested = true; };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  const sessionId = `sch-${process.pid}-${Date.now()}`;
  const counts = countRoutines(repoRoot);
  log(`online — interval ${intervalS}s, ${counts.agents} agent(s), ${counts.enabled} enabled routine(s)${noSend ? ' [dry-run: no sends]' : ''}${once ? ' [--once]' : ''}`);

  try {
    for (;;) {
      if (stopRequested) {
        log('signal received — shutting down');
        break;
      }
      if (readControlStage(repoRoot, SCHEDULER_AGENT) === 'stop') {
        log('control stop — shutting down');
        break;
      }

      if (!noSend) {
        writePresence(repoRoot, SCHEDULER_AGENT, {
          session_id: sessionId,
          state: 'standby',
          task: null,
          heartbeat_at: bangkokTimestamp(),
        });
        drainOwnInbox(repoRoot);
      }

      const summary = await tickOnce(repoRoot, { nowMs: pinnedNow ?? Date.now(), noSend });
      // A dry run is a rehearsal: it must leave BOTH the mailbox and every state
      // file exactly as it found them, so the same command can be re-run.
      if (!noSend) {
        persistFleet(repoRoot, {
          pid: process.pid,
          interval_s: intervalS,
          last_tick_at: bangkokTimestamp(),
          ticks: (readFleetState(repoRoot).ticks || 0) + 1,
          last_summary: { fired: summary.fired, missed: summary.missed, errors: summary.errors },
        }, summary.recent);
      }

      if (once) break;

      // Sleep in <=1s slices so a stop lands promptly rather than after a full
      // interval (same responsiveness rule as the delegate's backoff).
      const until = Date.now() + intervalS * 1000;
      while (Date.now() < until) {
        if (stopRequested || readControlStage(repoRoot, SCHEDULER_AGENT) === 'stop') break;
        await sleep(Math.min(1000, until - Date.now()));
      }
    }
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    if (!noSend) cleanup(repoRoot, sessionId);
  }

  return { stdout: '', exitCode: EXIT_OK };
}

/**
 * Release the pidfile and presence only when they still name US — a rival that
 * legitimately took over must not have its lock deleted by our exit.
 */
function cleanup(repoRoot, sessionId) {
  try {
    const rec = readJsonFile(pidFilePath(repoRoot, DAEMON));
    if (rec && rec.pid === process.pid) rmSync(pidFilePath(repoRoot, DAEMON), { force: true });
  } catch { /* best effort */ }
  try {
    const p = readPresence(repoRoot, SCHEDULER_AGENT);
    if (p && p.session_id === sessionId) rmSync(presencePath(repoRoot, SCHEDULER_AGENT), { force: true });
  } catch { /* best effort */ }
}

function countRoutines(repoRoot) {
  let agents = 0;
  let enabled = 0;
  let total = 0;
  for (const a of listAgentNames(repoRoot)) {
    if (a === SCHEDULER_AGENT) continue;
    let doc;
    try { doc = readRoutinesFile(repoRoot, a); } catch { continue; }
    const { ok } = partitionRoutines(doc);
    if (ok.length === 0) continue;
    agents++;
    total += ok.length;
    enabled += ok.filter((r) => r.enabled !== false).length;
  }
  return { agents, enabled, total };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function statusReport(repoRoot, flags) {
  const rec = readJsonFile(pidFilePath(repoRoot, DAEMON));
  const running = isDaemonRunning(repoRoot, DAEMON);
  const fleet = readFleetState(repoRoot);
  const control = readControlStage(repoRoot, SCHEDULER_AGENT);
  const nowMs = Date.now();

  const agents = [];
  let nextBest = null;
  for (const agent of listAgentNames(repoRoot)) {
    if (agent === SCHEDULER_AGENT) continue;
    let doc;
    try { doc = readRoutinesFile(repoRoot, agent); } catch { continue; }
    const { ok } = partitionRoutines(doc);
    if (ok.length === 0) continue;
    const state = readState(repoRoot, agent);
    const rows = ok.map((r) => {
      const st = state.routines[String(r.id)] || null;
      const next = st?.retired_at ? null : nextScheduledInstant(r, nowMs);
      if (next != null && r.enabled !== false && (nextBest == null || next < nextBest.ms)) {
        nextBest = { ms: next, agent, id: String(r.id) };
      }
      return {
        id: String(r.id),
        enabled: r.enabled !== false,
        when: String(r.when || ''),
        at: String(r.at || ''),
        days: String(r.days || ''),
        category: String(r.category || ''),
        payload: r.sequence ? 'sequence' : 'goal',
        next_fire: next != null ? bangkokWall(next) : null,
        last_status: st?.last_status ?? null,
        last_fired_at: st?.last_fired_at ?? null,
        last_error: st?.last_error || '',
        retired_at: st?.retired_at ?? null,
      };
    });
    agents.push({ name: agent, routines: rows });
  }

  const counts = countRoutines(repoRoot);
  const logRel = relative(repoRoot, schedulerLogPath(repoRoot)).replace(/\\/g, '/');
  const recent = Array.isArray(fleet.recent) ? fleet.recent : [];

  if (flags.json) {
    return {
      stdout: `${JSON.stringify({
        running,
        pid: running && rec ? rec.pid : null,
        control,
        interval_s: fleet.interval_s ?? null,
        log: logRel,
        ticks: fleet.ticks ?? 0,
        last_tick_at: fleet.last_tick_at ?? null,
        counts,
        next_fire: nextBest ? { at: bangkokWall(nextBest.ms), agent: nextBest.agent, id: nextBest.id } : null,
        agents,
        recent,
      }, null, 2)}\n`,
      exitCode: EXIT_OK,
    };
  }

  const lines = [
    'scheduler:  fleet',
    `running:    ${running && rec ? `yes (pid ${rec.pid})` : 'no'}`,
    `control:    ${control}`,
    `interval:   ${fleet.interval_s ? `${fleet.interval_s}s` : '(not yet run)'}`,
    `log:        ${logRel}`,
    `routines:   ${counts.enabled} enabled / ${counts.total} total across ${counts.agents} agent(s)`,
    `last tick:  ${fleet.last_tick_at || '(never)'}${fleet.ticks ? `   ticks: ${fleet.ticks}` : ''}`,
    nextBest
      ? `next fire:  ${bangkokWall(nextBest.ms)} (+07:00)  ${nextBest.agent}/${nextBest.id}`
      : 'next fire:  (nothing scheduled)',
  ];
  if (recent.length > 0) {
    lines.push('recent:');
    for (const r of recent) {
      lines.push(`  ${r.at}  ${String(r.status).padEnd(6)}  ${r.agent}/${r.id}${r.detail ? `  ${r.detail}` : ''}`);
    }
  }
  if (!running && control !== 'stop') {
    lines.push(`note: start it with 'sidekicks agent scheduler serve' — nothing fires while it is down`);
  }
  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
}
