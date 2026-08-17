// lib/agent-lifecycle/_office.mjs
// Pure snapshot collectors for `sidekicks agent office` — NOT a dispatchable
// verb (no VERBS entry). Every exported collector is BEST-EFFORT: a corrupt
// file, a missing directory, or an unreadable charter degrades the affected
// row rather than throwing — the same doctrine scheduler.mjs's tickOnce
// applies to a daemon tick (one bad file must never take the whole snapshot
// down). The office dashboard is read-only, so nothing here ever writes.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { readFileSync, readdirSync, existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import {
  bangkokTimestamp,
  PRESENCE_TTL_MS,
  listAgentNames,
  agentsRoot,
  runtimeDir,
  readCharter,
  readPresence,
  readControlStage,
  agentStatusRow,
  listMessageIds,
  readMessage,
} from './_shared.mjs';
import { readJsonFile, isDaemonRunning, bridgeRuntimeDir } from './_bridge.mjs';
import { listThreads, digestIsStale } from './_threads.mjs';
import {
  SCHEDULER_AGENT,
  readRoutinesFile,
  partitionRoutines,
  readState,
  nextScheduledInstant,
  bangkokWall,
} from './_routines.mjs';
import { effectiveTelegramConfig } from './telegram.mjs';
import { resolveJournalConfig } from '../journal-lifecycle/_shared.mjs';

export const OFFICE_SNAPSHOT_SCHEMA = 'agent-office-snapshot/v1';

// Mirrors the skill's plan.mjs:131 — lib/ MUST NOT import from a skill, so the
// path is duplicated here rather than imported. Keep in sync by hand; a repo
// missing this tree is not an error (planGateRows degrades to empty).
export const PLANS_REL = 'artifacts/runs/sidekicks-agent-dry-run/plans';

// Runs layout v2 location of the same tree (a work-item-less skill lands under
// `_adhoc/<skill-id>/`). Both are read: pre-v2 plans stay frozen at PLANS_REL.
export const PLANS_REL_V2 = 'artifacts/runs/_adhoc/sk-agent-dry-run/plans';

/** Both plan-store locations, v2 first. */
export const PLANS_RELS = Object.freeze([PLANS_REL_V2, PLANS_REL]);

// Plan statuses that are no longer awaiting a decision (see PLAN_STATUSES in
// the skill's plan.mjs — mirrored here for the same lib/skill-boundary reason
// as PLANS_REL above).
const PLAN_TERMINAL = new Set(['closed', 'expired', 'rejected', 'superseded', 'stale', 'dispatched']);

const RESCAN_MS = 10_000;

/**
 * Read one JSON file, or null on any failure (missing, unreadable, torn).
 * Deliberately duplicated from the readJson pattern in _shared.mjs / _bridge.mjs
 * (readJsonFile) rather than re-exported — this module never writes, so it
 * only ever needs the read half.
 */
function readJsonSafe(absPath) {
  return readJsonFile(absPath);
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/**
 * One row per agent: the shared status row (name, specialty, categories, cli,
 * role, status, presence, inbox counts — degrades to {broken:true,error} on a
 * poisoned charter) plus office-only fields: control stage, raw heartbeat
 * timestamp, model tier, the current claimed task (if any), and delegate
 * runtime stats (null when the agent has never run headless).
 */
export function rosterRows(repoRoot, nowMs = Date.now()) {
  return listAgentNames(repoRoot).map((name) => {
    const row = agentStatusRow(repoRoot, name); // already broken-safe
    const presence = readPresence(repoRoot, name);
    let charter = null;
    try {
      charter = readCharter(repoRoot, name);
    } catch {
      charter = null; // poisoned charter — agentStatusRow already flagged `broken`
    }
    let control = 'running';
    try {
      control = readControlStage(repoRoot, name);
    } catch {
      control = 'running';
    }

    let currentTask = null;
    try {
      const claimedIds = listMessageIds(repoRoot, name, 'claimed');
      if (claimedIds.length > 0) {
        const msg = readMessage(repoRoot, name, 'claimed', claimedIds[0]);
        if (msg) {
          currentTask = {
            id: msg.id ?? claimedIds[0],
            goal: msg.brief?.goal ?? '',
            from: msg.from ?? null,
            category: msg.category ?? null,
          };
        }
      }
    } catch {
      currentTask = null;
    }

    // Path mirrors delegateStatePath (delegate.mjs) without importing the
    // 52k-line delegate runner into a read-only snapshot collector.
    const delegateState = readJsonSafe(join(runtimeDir(repoRoot, name), 'delegate.json'));
    const delegate = delegateState
      ? {
          running: isDaemonRunning(repoRoot, `delegate-${name}`),
          last_run_at: delegateState.last_run_at ?? null,
          last_wake_tokens: delegateState.last_wake_tokens ?? null,
          last_context_tokens: delegateState.last_context_tokens ?? null,
          consecutive_failures: delegateState.consecutive_failures ?? 0,
        }
      : null;

    return {
      ...row,
      control,
      heartbeat_at: presence?.heartbeat_at ?? null,
      model: charter?.model || null,
      current_task: currentTask,
      delegate,
    };
  });
}

// ---------------------------------------------------------------------------
// Activity feed (journal L0, with an inbox-scan fallback)
// ---------------------------------------------------------------------------

/**
 * Newest-first activity rows. Prefers the journal L0 event log (one JSONL row
 * per completed task, written by `agent complete` — see journal-lifecycle/log.mjs)
 * when persistent_agent_memory is configured; otherwise falls back to scanning
 * every agent's inbox done/ messages so the panel is never empty on a machine
 * that never turned the journal on.
 */
export function activityFeed(repoRoot, limit = 50) {
  try {
    let cfg = null;
    try {
      cfg = resolveJournalConfig(repoRoot);
    } catch {
      cfg = null;
    }
    if (cfg && cfg.layers?.log?.enabled && cfg.layers.log.dirAbs) {
      const rows = readJournalLogRows(cfg.layers.log.dirAbs, limit);
      if (rows.length > 0 || existsSync(cfg.layers.log.dirAbs)) {
        return rows
          .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
          .slice(0, limit)
          .map((r) => ({
            ts: r.ts ?? null,
            agent: r.agent ?? null,
            status: r.status ?? null,
            goal: r.goal ?? '',
            summary: r.summary ?? '',
            assigner: r.assigner ?? null,
            category: r.category ?? null,
            duration_s: Number.isFinite(r.duration_s) ? r.duration_s : null,
            deliverables: Array.isArray(r.deliverables) ? r.deliverables : [],
          }));
      }
    }
  } catch {
    // fall through to the inbox-scan fallback below
  }
  return inboxActivityFallback(repoRoot, limit);
}

/** Walk `<store>/src/logs/<agent>/<date>.jsonl`, newest date files first. */
function readJournalLogRows(dirAbs, limit) {
  const rows = [];
  let agentDirs = [];
  try {
    agentDirs = readdirSync(dirAbs, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return rows;
  }
  for (const agent of agentDirs) {
    const adir = join(dirAbs, agent);
    let files = [];
    try {
      files = readdirSync(adir).filter((f) => f.endsWith('.jsonl')).sort().reverse(); // newest date first
    } catch {
      continue;
    }
    // Bounded scan — a handful of the newest per-agent files is always enough
    // to fill `limit` across the whole fleet without reading years of history.
    for (const f of files.slice(0, 10)) {
      let text;
      try {
        text = readFileSync(join(adir, f), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          // torn line — skip
        }
      }
      if (rows.length >= limit * 4) break; // comfortably enough to sort+slice from
    }
  }
  return rows;
}

/** Fallback when the journal is unconfigured: inbox done/ messages, newest-first. */
function inboxActivityFallback(repoRoot, limit) {
  const rows = [];
  for (const agent of listAgentNames(repoRoot)) {
    const ids = listMessageIds(repoRoot, agent, 'done').slice().reverse(); // chronological → newest-first
    for (const id of ids.slice(0, limit)) {
      const msg = readMessage(repoRoot, agent, 'done', id);
      if (!msg) continue;
      rows.push({
        ts: msg.result?.completed_at ?? msg.claim?.claimed_at ?? msg.created_at ?? null,
        agent,
        status: msg.result?.status ?? null,
        goal: msg.brief?.goal ?? '',
        summary: msg.result?.summary ?? '',
        assigner: msg.from ?? null,
        category: msg.category ?? null,
        duration_s: null,
        deliverables: Array.isArray(msg.result?.deliverables) ? msg.result.deliverables : [],
      });
    }
  }
  return rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Conversation threads
// ---------------------------------------------------------------------------

/** Open conversation threads across every agent, newest per-agent first. */
export function conversationRows(repoRoot, perAgentLimit = 5) {
  const rows = [];
  for (const agent of listAgentNames(repoRoot)) {
    let threads = [];
    try {
      threads = listThreads(repoRoot, agent, { openOnly: true, limit: perAgentLimit });
    } catch {
      threads = [];
    }
    for (const t of threads) {
      let stale = false;
      try {
        stale = digestIsStale(repoRoot, agent, t.id, t);
      } catch {
        stale = false;
      }
      rows.push({
        agent,
        id: t.id,
        title: t.title || '',
        status: t.status ?? null,
        channel: t.channel ?? null,
        turns: t.turns ?? 0,
        user_turns: t.user_turns ?? 0,
        last_activity_at: t.last_activity_at ?? null,
        digest_stale: stale,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Dry-run plan gate
// ---------------------------------------------------------------------------

/**
 * Pending + recently-closed dry-run plans (sk-agent-dry-run/plan.mjs
 * records — see PLANS_REL above). Field names are read straight off the real
 * plan.json schema (agent-plan-gate/v1): intake[0].goal_digest for the goal
 * digest, approval.expires_at for the countdown, units[].{n,title}.
 */
export function planGateRows(repoRoot) {
  const rows = [];
  const seen = new Set(); // a plan id present in both trees is reported once (v2 wins)
  for (const rel of PLANS_RELS) {
    const dir = join(repoRoot, rel);
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // a missing tree is never an error — the other one may still exist
    }
    for (const d of entries) {
      if (!d.isDirectory() || !d.name.startsWith('P-')) continue;
      let doc;
      try {
        doc = JSON.parse(readFileSync(join(dir, d.name, 'plan.json'), 'utf8'));
      } catch {
        continue; // corrupt/partial plan directory — skip it
      }
      const planId = doc.plan_id ?? d.name;
      if (seen.has(planId)) continue;
      seen.add(planId);
      rows.push({
        plan_id: planId,
        agent: doc.agent ?? null,
        channel: doc.channel ?? null,
        status: doc.status ?? null,
        goal: doc.intake?.[0]?.goal_digest ?? '',
        created_at: doc.created_at ?? null,
        expires_at: doc.approval?.expires_at ?? null,
        units: Array.isArray(doc.units)
          ? doc.units.map((u) => ({ n: u.n, title: u.title }))
          : [],
      });
    }
  }
  const pending = rows.filter((r) => !PLAN_TERMINAL.has(r.status));
  const recent_closed = rows
    .filter((r) => PLAN_TERMINAL.has(r.status))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 5);
  return { pending, recent_closed };
}

// ---------------------------------------------------------------------------
// Scheduler panel
// ---------------------------------------------------------------------------

/**
 * scheduler.json's daemon liveness/recent ring + a live re-scan of every
 * agent's routines.yaml for aggregate counts and the next 5 upcoming fires.
 * schedulerStatePath is mirrored here (`bridgeRuntimeDir/scheduler.json`)
 * rather than imported from scheduler.mjs — that module also carries the
 * whole daemon-loop implementation, which a read-only snapshot has no reason
 * to load.
 */
export function schedulerPanel(repoRoot, nowMs = Date.now()) {
  const daemon_running = isDaemonRunning(repoRoot, 'scheduler');
  const state = readJsonSafe(join(bridgeRuntimeDir(repoRoot), 'scheduler.json')) || {};
  const updated_at = state.updated_at ?? null;
  const recent = Array.isArray(state.recent) ? state.recent : [];

  let total = 0;
  let enabled = 0;
  const candidates = [];
  for (const agent of listAgentNames(repoRoot)) {
    if (agent === SCHEDULER_AGENT) continue;
    let doc;
    try {
      doc = readRoutinesFile(repoRoot, agent);
    } catch {
      continue;
    }
    const { ok } = partitionRoutines(doc);
    if (ok.length === 0) continue;
    total += ok.length;
    enabled += ok.filter((r) => r.enabled !== false).length;

    let st = { routines: {} };
    try {
      st = readState(repoRoot, agent);
    } catch {
      st = { routines: {} };
    }
    for (const r of ok) {
      if (r.enabled === false) continue;
      const entry = st.routines?.[String(r.id)] || null;
      if (entry?.retired_at) continue;
      let next = null;
      try {
        next = nextScheduledInstant(r, nowMs);
      } catch {
        next = null;
      }
      if (next == null) continue;
      candidates.push({
        agent,
        id: String(r.id),
        when: r.when ?? null,
        at: r.at ?? null,
        deliver: r.deliver || '',
        next_at: bangkokWall(next),
        _sort: next,
      });
    }
  }
  candidates.sort((a, b) => a._sort - b._sort);
  const next_fires = candidates.slice(0, 5).map(({ _sort, ...rest }) => rest);

  return { daemon_running, updated_at, recent, routines: { total, enabled }, next_fires };
}

// ---------------------------------------------------------------------------
// Comms liveness (booleans only — never a token value)
// ---------------------------------------------------------------------------

/**
 * Liveness strip for every comms daemon. `configured` is a BOOLEAN cast of
 * the effective bot token — the token string itself must never appear in a
 * snapshot (it is served over HTTP, and a snapshot may be logged/cached).
 */
export function commsPanel(repoRoot) {
  let botTokenPresent = false;
  let channelCount = 0;
  let botCount = 0;
  try {
    const tg = effectiveTelegramConfig(repoRoot);
    botTokenPresent = Boolean(tg?.bot_token);
    channelCount = Array.isArray(tg?.channels) ? tg.channels.length : 0;
    botCount = Array.isArray(tg?.bots) ? tg.bots.length : 0;
  } catch {
    botTokenPresent = false;
  }
  return {
    bridge: { running: isDaemonRunning(repoRoot, 'bridge') },
    telegram: {
      running: isDaemonRunning(repoRoot, 'telegram'),
      configured: botTokenPresent,
      channels: channelCount,
      bots: botCount,
    },
    scheduler: { running: isDaemonRunning(repoRoot, 'scheduler') },
    office: { running: isDaemonRunning(repoRoot, 'office') },
    delegates: listAgentNames(repoRoot).map((agent) => ({
      agent,
      running: isDaemonRunning(repoRoot, `delegate-${agent}`),
    })),
  };
}

// ---------------------------------------------------------------------------
// Full snapshot
// ---------------------------------------------------------------------------

/** Run one collector, swallowing any escaped error into a safe fallback. */
function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Assemble the full office snapshot. Every field is produced by a best-effort
 * collector above; a failure in any one of them degrades to an empty/neutral
 * value rather than taking down the whole snapshot (`--once` and the live
 * server both depend on this never throwing).
 */
export function buildSnapshot(repoRoot, { nowMs = Date.now(), activityLimit = 50, threadsPerAgent = 5 } = {}) {
  return {
    schema: OFFICE_SNAPSHOT_SCHEMA,
    generated_at: bangkokTimestamp(),
    presence_ttl_ms: PRESENCE_TTL_MS,
    roster: safe(() => rosterRows(repoRoot, nowMs), []),
    activity: safe(() => activityFeed(repoRoot, activityLimit), []),
    threads: safe(() => conversationRows(repoRoot, threadsPerAgent), []),
    plans: safe(() => planGateRows(repoRoot), { pending: [], recent_closed: [] }),
    scheduler: safe(() => schedulerPanel(repoRoot, nowMs), {
      daemon_running: false, updated_at: null, recent: [], routines: { total: 0, enabled: 0 }, next_fires: [],
    }),
    comms: safe(() => commsPanel(repoRoot), {
      bridge: { running: false }, telegram: { running: false, configured: false },
      scheduler: { running: false }, office: { running: false }, delegates: [],
    }),
  };
}

// ---------------------------------------------------------------------------
// Filesystem watch targets
// ---------------------------------------------------------------------------

/** Directories worth watching for a change that should refresh the snapshot. */
export function watchTargets(repoRoot) {
  const targets = [agentsRoot(repoRoot), ...PLANS_RELS.map((rel) => join(repoRoot, rel))];
  let cfg = null;
  try {
    cfg = resolveJournalConfig(repoRoot);
  } catch {
    cfg = null;
  }
  if (cfg?.layers?.log?.dirAbs) targets.push(cfg.layers.log.dirAbs);
  return targets.filter((t) => existsSync(t));
}

/**
 * Watch every office-relevant directory for changes, same fallback ladder as
 * the office-viz skill's watchRuns (.agents/skills/sk-office-viz/
 * scripts/agent-office-viz.mjs): prefer one recursive fs.watch per target;
 * when the platform rejects `{ recursive: true }` (older Linux), fall back to
 * one watcher per directory, re-walked on a slow interval so new subdirs
 * (a freshly created agent, a new plan folder) start being watched without a
 * restart.
 */
export function createOfficeWatcher(repoRoot, onEvent) {
  const watched = new Map(); // absolute dir -> FSWatcher
  let recursiveOk = true;

  function tryWatch(dir, recursive) {
    try {
      const w = watch(dir, recursive ? { recursive: true } : {}, onEvent);
      w.on('error', () => {
        try { w.close(); } catch { /* already dead */ }
        watched.delete(dir);
      });
      watched.set(dir, w);
      return true;
    } catch (err) {
      if (recursive && err && err.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') return false;
      return true; // dir vanished between scan and watch — the next ensure() retries
    }
  }

  function subDirs(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  }

  function walkDirs(dir, acc) {
    acc.push(dir);
    for (const name of subDirs(dir)) walkDirs(join(dir, name), acc);
  }

  function ensure() {
    for (const dir of watchTargets(repoRoot)) {
      if (recursiveOk) {
        if (!watched.has(dir) && !tryWatch(dir, true)) {
          recursiveOk = false; // this platform rejects recursive — fall through below
        }
      }
      if (!recursiveOk) {
        const all = [];
        walkDirs(dir, all);
        for (const d of all) if (!watched.has(d)) tryWatch(d, false);
      }
    }
  }

  ensure();
  const rescan = setInterval(ensure, RESCAN_MS);
  rescan.unref();
  return {
    ensure,
    close() {
      clearInterval(rescan);
      for (const w of watched.values()) {
        try { w.close(); } catch { /* noop */ }
      }
      watched.clear();
    },
  };
}
