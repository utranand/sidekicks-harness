// lib/artifacts-lifecycle/_manage.mjs
// Shared helpers for the artifact-management verbs: `scan`, `archive`, `restore`.
// NOT a dispatchable verb (leading underscore + no VERBS entry).
//
// Where the existing `_shared.mjs` scanner is Jira-only and anchored to the ACTIVE
// project (for the run-state index/timeline), THIS module scans the WHOLE repo for
// EVERY artifact type and groups them for a single consolidated inventory, and moves
// an artifact folder into a per-scope `artifacts/archived/` mirror. The two live side
// by side: `_shared` owns run.json headers + the Jira timeline; `_manage` owns the
// repo-wide by-type inventory + reversible archival.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { join, dirname, isAbsolute, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  nowBangkok,
  toRepoRel,
  fromRepoRel,
  readRun,
  inferHeader,
  writeAtomicJson,
  writeAtomicText,
} from './_shared.mjs';
import { statePath, STATE_DIR } from '../state-store/paths.mjs';
import { ADHOC_SEGMENT } from '../active-scope/run-base.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The folder each scope's clean-up moves artifacts into (a sibling of runs/sql/…
// under the same artifacts/ base). Excluded from the live inventory, so archiving a
// folder is exactly "make it stop showing up as live" while keeping every file + git
// history — reversible, never deletion (the sk-skill-offload model).
export const ARCHIVE_DIRNAME = 'archived';

// Container folders whose CHILDREN are the individual artifacts (vs. a folder that is
// itself one artifact, like office-viz/). `runs` nests one extra level (skill/slug).
export const CONTAINER_TYPES = Object.freeze(['runs', 'sql', 'command-sequence']);

// Ledger filenames that mark a folder as a "run" (carries execution status). Kept in
// sync with _shared.mjs LEDGER_FILES; a run also counts if it has a run.json.
const LEDGER_FILE_NAMES = Object.freeze([
  'batch.yaml',
  'ledger.yaml',
  'mission-status.yaml',
  'tasks.yaml',
]);

// Run statuses that BLOCK archiving unless --force is passed. A run that is still
// running/blocked/paused is likely in flight (or waiting to resume) — archiving it
// would hide active work. Terminal states (done/failed) and non-run artifacts archive
// freely. This is the "terminal-only gate" the skill promises.
export const ACTIVE_STATUSES = Object.freeze(['running', 'blocked', 'paused']);

// Default staleness cutoff for the derived liveness signal: how old a run's most-recent
// heartbeat/updated_at may be before an ACTIVE-status run is judged NOT actually running
// (a "stale / orphaned" zombie — worker crashed, was killed, or its session was /cleared).
// 1800s = 2× the get-things-done lease TTL (900s, see gtd-orphan-watch-hook.mjs), so a
// live GTD run heartbeating well inside its lease is never mislabeled, while a truly dead
// run is caught within a session. Overridable per scan (--stale-seconds / opts.staleSeconds).
export const STALE_RUNNING_SECONDS = 1800;

// Default age gate for the batch `archive --stale` clean-up: an active-status run must be
// orphaned for at least this long before it is swept automatically. Deliberately much wider
// than STALE_RUNNING_SECONDS (30 min) — a run that just went quiet mid-session is 'stale'
// immediately but likely to resume; only a run abandoned for days is safe to auto-archive.
// Overridable per call (--older-than <days>).
export const DEFAULT_STALE_ARCHIVE_DAYS = 7;

// Top-level names under an artifacts/ base that are derived caches / markers, never
// inventoried as artifacts in their own right.
const SKIP_ENTRIES = new Set(['index.json', 'ARTIFACTS.md']);

// ---------------------------------------------------------------------------
// Repo-wide base enumeration
// ---------------------------------------------------------------------------

/**
 * Enumerate every `artifacts/` base across the repo — the root store, each project's
 * store, and each service's `src/` store — returning only those that exist on disk.
 * Filesystem-walked (not index-derived) so an un-pulled or index-stale service can't
 * hide a store, and a fresh clone with no index still scans correctly.
 *
 * @param {string} repoRoot
 * @returns {Array<{ dir: string, scope: string }>} absolute base dir + scope label
 */
export function enumerateArtifactBases(repoRoot) {
  const bases = [];
  const push = (absBase, scope) => {
    if (existsSync(absBase)) bases.push({ dir: absBase, scope });
  };

  push(join(repoRoot, 'artifacts'), 'root');

  const projectsDir = join(repoRoot, 'projects');
  for (const proj of safeReaddir(projectsDir)) {
    if (!proj.isDirectory()) continue;
    const projName = proj.name;
    push(join(projectsDir, projName, 'artifacts'), `project:${projName}`);

    const servicesDir = join(projectsDir, projName, 'services');
    for (const svc of safeReaddir(servicesDir)) {
      if (!svc.isDirectory()) continue;
      // A service's artifacts base is the service ROOT — the whole artifacts/runs subtree
      // hangs off the service root, never src/ (CLAUDE.md "Artifacts folder"). Enumerate
      // src/artifacts too so the legacy tree from older skills still archives/inventories.
      push(join(servicesDir, svc.name, 'artifacts'), `service:${projName}/${svc.name}`);
      push(join(servicesDir, svc.name, 'src', 'artifacts'), `service:${projName}/${svc.name}`);
    }
  }
  return bases;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Run detection + status
// ---------------------------------------------------------------------------

/**
 * True if `absDir` is a run folder — it carries a run.json header or any known engine
 * ledger. Used to decide whether the archive terminal-gate applies.
 * @param {string} absDir
 * @returns {boolean}
 */
export function isRunDir(absDir) {
  if (existsSync(join(absDir, 'run.json'))) return true;
  return LEDGER_FILE_NAMES.some((f) => existsSync(join(absDir, f)));
}

/**
 * Effective status of a run folder, mapped onto the run-state enum (or 'unknown').
 * Prefers the run.json header; falls back to ledger inference (reuses _shared logic).
 * @param {string} absDir
 * @param {string} [skill]
 * @param {string} [slug]
 * @returns {string}
 */
export function runStatus(absDir, skill, slug) {
  const m = readRun(absDir);
  if (m && typeof m.status === 'string' && m.status) return m.status;
  return inferHeader(skill || '', slug || basename(absDir), absDir).status || 'unknown';
}

/**
 * Resolve a run folder's liveness INPUTS in one read: its effective status plus the most
 * recent liveness timestamp (a heartbeat / updated_at, falling back to folder mtime), as
 * both an ISO string and ms-since-epoch. This is the raw material the derived
 * "actually running vs stale/orphaned" classification is computed from — the ledger claims
 * a status, this says how fresh that claim is.
 *
 * For a run.json run the heartbeat is `heartbeat_at` › `lease.heartbeat_at` › `updated_at`
 * › `created_at`; for a legacy ledger run inferHeader already folds `lease.heartbeat_at`
 * into `updated_at`. Timestamps parse regardless of offset (Bangkok `+07:00` or `Z`) since
 * ms-since-epoch is an absolute instant. Pure/read-only.
 *
 * @param {string} absDir
 * @param {string} [skill]
 * @param {string} [slug]
 * @param {object|null} [manifest] - pre-read run.json (avoids a second read); omit to read here
 * @returns {{ status: string, heartbeatMs: number|null, heartbeatIso: string|null }}
 */
export function runLivenessInputs(absDir, skill, slug, manifest) {
  const m = manifest !== undefined ? manifest : readRun(absDir);
  let status, tsRaw;
  if (m && typeof m.status === 'string' && m.status) {
    status = m.status;
    tsRaw = m.heartbeat_at
      || (m.lease && m.lease.heartbeat_at)
      || m.updated_at
      || m.created_at
      || null;
  } else {
    const h = inferHeader(skill || '', slug || basename(absDir), absDir);
    status = h.status || 'unknown';
    tsRaw = h.updated_at || null; // inferHeader folds lease.heartbeat_at → updated_at, else mtime
  }
  let ms = tsRaw ? Date.parse(tsRaw) : NaN;
  if (!Number.isFinite(ms)) {
    try { ms = statSync(absDir).mtimeMs; } catch { ms = NaN; }
  }
  return {
    status,
    heartbeatMs: Number.isFinite(ms) ? ms : null,
    heartbeatIso: tsRaw || null,
  };
}

/**
 * Derive a run's liveness classification from its ledger-claimed status and heartbeat age.
 * Only ACTIVE_STATUSES runs (running/blocked/paused) can be 'live' or 'stale'; a terminal
 * run (done/failed/unknown) is 'terminal' and never enters the running/stale buckets.
 *
 * An active run with a fresh heartbeat (age ≤ staleSeconds) is 'live' — truly in flight.
 * An active run whose heartbeat is older than the threshold, OR whose heartbeat can't be
 * parsed at all, is 'stale' (orphaned): we cannot prove it is alive, and a live worker
 * always leaves a fresh timestamp behind, so absence of proof is treated as stale.
 *
 * @param {string} status - effective run status (from runLivenessInputs)
 * @param {number|null} heartbeatMs - ms-since-epoch of the most recent heartbeat
 * @param {number} nowMs - reference "now" (injected for determinism)
 * @param {number} [staleSeconds]
 * @returns {{ live: boolean, liveness: 'live'|'stale'|'terminal', heartbeat_age_seconds: number|null }}
 */
export function deriveLiveness(status, heartbeatMs, nowMs, staleSeconds = STALE_RUNNING_SECONDS) {
  if (!ACTIVE_STATUSES.includes(status)) {
    return { live: false, liveness: 'terminal', heartbeat_age_seconds: null };
  }
  const ageSec = Number.isFinite(heartbeatMs)
    ? Math.max(0, Math.round((nowMs - heartbeatMs) / 1000))
    : null;
  const fresh = ageSec != null && ageSec <= staleSeconds;
  return {
    live: fresh,
    liveness: fresh ? 'live' : 'stale',
    heartbeat_age_seconds: ageSec,
  };
}

// ---------------------------------------------------------------------------
// Inventory build
// ---------------------------------------------------------------------------

/**
 * Build the repo-wide, by-type artifact inventory.
 *
 * Each `runs` entry carries a DERIVED liveness classification on top of its ledger-claimed
 * `status`: `live` (true only for an ACTIVE-status run with a fresh heartbeat), `liveness`
 * ('live' | 'stale' | 'terminal'), and the heartbeat age. The top-level `activity` section
 * splits the ACTIVE runs into `running` (fresh — truly in flight) and `stale` (status says
 * running/blocked/paused but the heartbeat exceeds the threshold — an orphaned zombie), so
 * a human or skill can tell at a glance which running entries are real.
 *
 * @param {string} repoRoot
 * @param {{ nowMs?: number, staleSeconds?: number, watchRoots?: Array<{dir:string, rel:string, scope:string}> }} [opts]
 *   nowMs: reference "now" (injected for deterministic tests); staleSeconds: liveness cutoff;
 *   watchRoots: EXTRA runs-roots (children are <skill>/<slug>/ run dirs) from
 *   .sidekicks/agents-watch.yaml — resolved by the caller (resolveWatchRoots) so build
 *   stays pure; runs found there are folded into types.runs, deduped by path against the
 *   standard bases.
 * @returns {{
 *   schema_version: 1, scope: 'repo', built_at: string, stale_seconds_threshold: number,
 *   watch_roots: Array<{path:string, scope:string}>,
 *   totals: Record<string, number>,
 *   types: Record<string, Array<object>>,
 *   activity: { stale_seconds_threshold: number, running: Array<object>, stale: Array<object> },
 *   archived: { count: number, items: Array<object> }
 * }}
 */
export function buildInventory(repoRoot, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const staleSeconds = Number.isFinite(opts.staleSeconds) ? opts.staleSeconds : STALE_RUNNING_SECONDS;
  const livenessOpts = { nowMs, staleSeconds };
  const types = { runs: [], sql: [], 'command-sequence': [], 'office-viz': [], other: [] };
  const archived = [];

  for (const base of enumerateArtifactBases(repoRoot)) {
    for (const top of safeReaddir(base.dir)) {
      const name = top.name;
      if (SKIP_ENTRIES.has(name) || name.startsWith('.')) continue;

      // The archive mirror is inventoried separately (so restore is discoverable) and
      // never counted as live — nor liveness-classified (an archived run is out of flight).
      if (name === ARCHIVE_DIRNAME && top.isDirectory()) {
        collectArchived(repoRoot, base, join(base.dir, name), archived);
        continue;
      }

      const topAbs = join(base.dir, name);
      if (name === 'runs' && top.isDirectory()) {
        collectRuns(repoRoot, base, topAbs, types.runs, livenessOpts);
      } else if ((name === 'sql' || name === 'command-sequence') && top.isDirectory()) {
        for (const child of safeReaddir(topAbs)) {
          types[name].push(simpleItem(repoRoot, base, join(topAbs, child.name), child.name));
        }
      } else {
        const bucket = name === 'office-viz' ? 'office-viz' : 'other';
        types[bucket].push(simpleItem(repoRoot, base, topAbs, name));
      }
    }
  }

  // Configured EXTRA watch roots (agents-watch.yaml) — runs anchored outside the standard
  // bases (plan-centric trees, artifacts_dir overrides). Deduped by path: a watch root that
  // overlaps a standard base must not double-count its runs.
  const watchRoots = Array.isArray(opts.watchRoots) ? opts.watchRoots : [];
  if (watchRoots.length > 0) {
    const seenPaths = new Set(types.runs.map((r) => r.path));
    for (const wr of watchRoots) {
      const found = [];
      collectRuns(repoRoot, { scope: wr.scope }, wr.dir, found, livenessOpts);
      for (const r of found) {
        if (seenPaths.has(r.path)) continue;
        seenPaths.add(r.path);
        types.runs.push(r);
      }
    }
  }

  // Split ACTIVE runs into the two derived buckets for the at-a-glance activity view.
  const running = [];
  const stale = [];
  for (const r of types.runs) {
    if (r.liveness === 'live') running.push(activityRef(r));
    else if (r.liveness === 'stale') stale.push(activityRef(r));
  }

  const totals = {};
  for (const [k, v] of Object.entries(types)) totals[k] = v.length;
  totals.archived = archived.length;
  totals.running_live = running.length;
  totals.stale_running = stale.length;

  return {
    schema_version: 1,
    scope: 'repo',
    built_at: nowBangkok(),
    stale_seconds_threshold: staleSeconds,
    watch_roots: watchRoots.map((wr) => ({ path: wr.rel, scope: wr.scope })),
    totals,
    types,
    activity: { stale_seconds_threshold: staleSeconds, running, stale },
    archived: { count: archived.length, items: archived },
  };
}

function simpleItem(repoRoot, base, abs, name) {
  return { name, scope: base.scope, path: toRepoRel(repoRoot, abs) };
}

// Compact reference used in the activity buckets — enough to identify and locate a run
// without duplicating its whole record.
function activityRef(r) {
  return {
    skill: r.skill,
    slug: r.slug,
    status: r.status,
    scope: r.scope,
    path: r.path,
    heartbeat_at: r.heartbeat_at ?? null,
    heartbeat_age_seconds: r.heartbeat_age_seconds ?? null,
  };
}

/**
 * Record one run folder into `out`.
 *
 * `skill`/`slug` are the POSITIONAL guesses derived from the path; the run.json header wins
 * whenever it carries them, which is what lets one walker read both layouts:
 *   - v1 (frozen legacy): `runs/<skill>/<slug>/`  → positional guess is already correct
 *   - v2 (work-item first): `runs/<work-item>/<facet>/` → positional guess would be reversed,
 *     so the manifest's `skill`/`slug` is authoritative.
 */
function pushRun(repoRoot, base, runDir, skill, slug, out, opts) {
  const m = readRun(runDir);
  const effSkill = (m && typeof m.skill === 'string' && m.skill) || skill;
  const effSlug = (m && typeof m.slug === 'string' && m.slug) || slug;
  const { status, heartbeatMs, heartbeatIso } = runLivenessInputs(runDir, effSkill, effSlug, m);
  const item = {
    skill: effSkill,
    slug: effSlug,
    status,
    title: (m && m.title) || '',
    updated_at: (m && m.updated_at) || heartbeatIso || '',
    scope: base.scope,
    path: toRepoRel(repoRoot, runDir),
    ...(m && m.jira_card ? { jira_card: m.jira_card } : {}),
    ...(m && m.service ? { service: m.service } : {}),
  };
  if (opts) {
    const lv = deriveLiveness(status, heartbeatMs, opts.nowMs, opts.staleSeconds);
    item.live = lv.live;
    item.liveness = lv.liveness;
    item.heartbeat_at = heartbeatIso || null;
    item.heartbeat_age_seconds = lv.heartbeat_age_seconds;
  }
  out.push(item);
}

/**
 * Collect run folders under a `runs/` tree into `out` — reads BOTH layouts.
 *
 * v1 (frozen legacy) `runs/<skill>/<slug>/`, and v2 (runs layout v2):
 *   `runs/<work-item>/<facet>/`   a skill's facet of one work item
 *   `runs/<work-item>/`           `--bare`: the run IS the work item (engines)
 *   `runs/_adhoc/<skill-id>/`     a run with no work item
 *
 * Depth-1 dirs that are themselves run folders are recorded (bare v2 runs); beneath such a
 * folder only child dirs that are run folders are descended into, so a bare run's ordinary
 * subdirectories (`tools/`, `references/`, …) are never mistaken for runs. A depth-1 dir that
 * is NOT a run folder keeps the legacy behaviour of recording every child dir, so headerless
 * legacy runs stay visible.
 *
 * @param {object} [opts] - when `{ nowMs, staleSeconds }` is passed, each run is
 *   liveness-classified (live/liveness/heartbeat fields attached); when omitted (archived
 *   runs), the run is recorded without a liveness verdict — it is out of flight.
 */
function collectRuns(repoRoot, base, runsAbs, out, opts) {
  for (const topDir of safeReaddir(runsAbs)) {
    if (!topDir.isDirectory()) continue;
    const top = topDir.name;
    const topAbs = join(runsAbs, top);

    // v2 `_adhoc/` is a pass-through segment: each child IS a run base named for its skill.
    if (top === ADHOC_SEGMENT) {
      for (const child of safeReaddir(topAbs)) {
        if (!child.isDirectory()) continue;
        const childAbs = join(topAbs, child.name);
        if (isRunDir(childAbs)) {
          pushRun(repoRoot, base, childAbs, child.name, child.name, out, opts);
        }
        // A skill may still bucket several runs under its ad-hoc base.
        for (const leaf of safeReaddir(childAbs)) {
          if (!leaf.isDirectory()) continue;
          const leafAbs = join(childAbs, leaf.name);
          if (isRunDir(leafAbs)) {
            pushRun(repoRoot, base, leafAbs, child.name, leaf.name, out, opts);
          }
        }
      }
      continue;
    }

    // A depth-1 run folder is a v2 `--bare` run: the work item itself.
    const bare = isRunDir(topAbs);
    if (bare) pushRun(repoRoot, base, topAbs, top, top, out, opts);

    for (const childDir of safeReaddir(topAbs)) {
      if (!childDir.isDirectory()) continue;
      const childAbs = join(topAbs, childDir.name);
      // Under a bare run, only real run folders (its facets) count — never its work files.
      if (bare && !isRunDir(childAbs)) continue;
      // Positional guess: legacy <skill>/<slug>. A v2 facet's run.json overrides it in pushRun.
      pushRun(repoRoot, base, childAbs, top, childDir.name, out, opts);
    }
  }
}

// Tally archived leaves so `restore` targets are discoverable without a deep walk.
function collectArchived(repoRoot, base, archiveAbs, out) {
  for (const top of safeReaddir(archiveAbs)) {
    const name = top.name;
    const topAbs = join(archiveAbs, name);
    if (name === 'runs' && top.isDirectory()) {
      collectRuns(repoRoot, base, topAbs, out);
    } else if ((name === 'sql' || name === 'command-sequence') && top.isDirectory()) {
      for (const child of safeReaddir(topAbs)) {
        out.push(simpleItem(repoRoot, base, join(topAbs, child.name), child.name));
      }
    } else {
      out.push(simpleItem(repoRoot, base, topAbs, name));
    }
  }
}

// ---------------------------------------------------------------------------
// Inventory render + write
// ---------------------------------------------------------------------------

/**
 * Render the human-readable inventory Markdown, grouped by type.
 * @param {object} inv - buildInventory() output
 * @returns {string}
 */
export function renderInventoryMd(inv) {
  const lines = [
    '# Artifacts Inventory',
    '',
    'Repo-wide view of every skill-generated artifact, grouped by type, across the root',
    'store and every project + service store. Derived cache — rebuilt by',
    '`sidekicks artifacts scan`. Archive a folder with `sidekicks artifacts archive <path>`',
    'to move it out of the live set (reversible via `sidekicks artifacts restore`).',
    '',
    `Built: ${inv.built_at}`,
    '',
    '## Totals',
    '',
  ];
  for (const [k, n] of Object.entries(inv.totals)) lines.push(`- ${k}: ${n}`);
  lines.push('');

  // Derived liveness view — which "running" entries are actually in flight vs orphaned.
  // A run is judged by comparing its most-recent heartbeat/updated_at against the threshold;
  // the ledger's own status is what it CLAIMS, `liveness` is what the timestamp SHOWS.
  const act = inv.activity || { running: [], stale: [], stale_seconds_threshold: 0 };
  const mins = Math.round((act.stale_seconds_threshold || 0) / 60);
  const age = (s) => (s == null ? 'unknown' : `${s}s ago`);
  const actRun = (r) => `[${r.status}] ${r.skill}/${r.slug} — heartbeat ${age(r.heartbeat_age_seconds)}  \`${r.path}\``;

  lines.push(`## Actually running (${act.running.length})`, '');
  lines.push(`_Active-status runs with a fresh heartbeat (≤ ${mins}m) — truly in flight._`, '');
  if (act.running.length === 0) lines.push('_none_', '');
  else { for (const r of act.running) lines.push(`- ${actRun(r)}`); lines.push(''); }

  lines.push(`## Stale / orphaned (${act.stale.length})`, '');
  lines.push(
    `_Status says running/blocked/paused but the heartbeat exceeds ${mins}m (or is unreadable) —` +
    ` likely a crashed/killed/\`/clear\`ed worker. Verify before archiving with \`--force\`._`,
    '',
  );
  if (act.stale.length === 0) lines.push('_none_', '');
  else { for (const r of act.stale) lines.push(`- ${actRun(r)}`); lines.push(''); }

  const section = (title, items, fmt) => {
    lines.push(`## ${title} (${items.length})`, '');
    if (items.length === 0) {
      lines.push('_none_', '');
      return;
    }
    for (const it of items) lines.push(`- ${fmt(it)}`);
    lines.push('');
  };

  const liveMark = (r) => (r.liveness === 'live' ? ' ●live' : r.liveness === 'stale' ? ' ⚠stale' : '');
  section('runs', inv.types.runs, (r) => `[${r.status}${liveMark(r)}] ${r.skill}/${r.slug} — ${r.title || ''}  \`${r.path}\``);
  section('sql', inv.types.sql, (r) => `${r.name}  \`${r.path}\``);
  section('command-sequence', inv.types['command-sequence'], (r) => `${r.name}  \`${r.path}\``);
  section('office-viz', inv.types['office-viz'], (r) => `${r.name}  \`${r.path}\``);
  section('other', inv.types.other, (r) => `${r.name}  \`${r.path}\``);
  section('archived', inv.archived.items, (r) => `${r.skill ? `${r.skill}/${r.slug}` : r.name}  \`${r.path}\``);

  return lines.join('\n') + '\n';
}

/**
 * Absolute paths of the two consolidated inventory files (root singleton under
 * .sidekicks/state/, the derived-state directory — see lib/state-store/paths.mjs). CLI-mediated
 * writes, so writing under .sidekicks/ is in-contract.
 * @param {string} repoRoot
 */
export function inventoryPaths(repoRoot) {
  return {
    jsonPath: statePath(repoRoot, 'artifacts-inventory.json'),
    mdPath: statePath(repoRoot, 'artifacts-inventory.md'),
  };
}

/**
 * Atomically write both inventory files. Returns their repo-relative paths.
 * @param {string} repoRoot
 * @param {object} inv
 */
export function writeInventory(repoRoot, inv) {
  const { jsonPath, mdPath } = inventoryPaths(repoRoot);
  writeAtomicJson(jsonPath, inv);
  writeAtomicText(mdPath, renderInventoryMd(inv));
  return {
    jsonRel: toRepoRel(repoRoot, jsonPath),
    mdRel: toRepoRel(repoRoot, mdPath),
  };
}

// ---------------------------------------------------------------------------
// Centralized running-agents file — .sidekicks/state/running-agents.json
// ---------------------------------------------------------------------------

/**
 * Map an agent's ledger status + derived liveness onto a UI-facing state — the same
 * vocabulary the office-viz renderer uses for its officers, so the handoff file needs no
 * re-mapping on the consuming side. Terminal → offshift/failed; blocked → blocked;
 * paused → coffee; queued → idle; active → working (fresh) or asleep (stale heartbeat).
 *
 * @param {string} status
 * @param {'live'|'stale'|'terminal'|undefined} liveness
 * @returns {string}
 */
export function agentState(status, liveness) {
  const s = String(status || '').toLowerCase();
  if (s === 'failed' || s === 'error') return 'failed';
  if (['done', 'stopped', 'shipped', 'complete', 'completed', 'skipped'].includes(s)) return 'offshift';
  if (['blocked', 'halted', 'awaiting-merge'].includes(s)) return 'blocked';
  if (s === 'paused') return 'coffee';
  if (['pending', 'idle', 'todo', 'planned', 'ready'].includes(s)) return 'idle';
  // An unrecognized status that liveness already judged terminal (e.g. 'unknown') is off
  // the floor — only a genuinely ACTIVE run may read as working/asleep.
  if (liveness === 'terminal') return 'offshift';
  return liveness === 'stale' ? 'asleep' : 'working';
}

/**
 * Derive the CENTRALIZED running-agents view from a built inventory: one flat `agents`
 * list — every run unit across the standard bases AND the configured watch roots — each
 * carrying its identity (skill/slug/title/scope/path), its ledger-claimed `status`, the
 * derived `liveness` verdict + heartbeat, and a UI-facing `state`. This is the single
 * handoff artifact the office-viz live UI (and any other consumer) reads to know "who is
 * running and in what state" without re-walking the repo.
 *
 * @param {object} inv - buildInventory() output
 * @returns {{
 *   schema_version: 1, scope: 'repo', built_at: string, stale_seconds_threshold: number,
 *   watch_roots: Array<{path:string, scope:string}>,
 *   totals: { agents: number, working: number, asleep: number, blocked: number,
 *             coffee: number, idle: number, offshift: number, failed: number },
 *   agents: Array<object>
 * }}
 */
export function buildRunningAgents(inv) {
  const agents = [];
  const totals = { agents: 0, working: 0, asleep: 0, blocked: 0, coffee: 0, idle: 0, offshift: 0, failed: 0 };
  for (const r of inv.types.runs) {
    const state = agentState(r.status, r.liveness);
    agents.push({
      id: r.path, // repo-relative run path — unique + portable across clones
      skill: r.skill,
      slug: r.slug,
      title: r.title || '',
      status: r.status,
      state,
      live: r.live === true,
      liveness: r.liveness ?? 'terminal',
      heartbeat_at: r.heartbeat_at ?? null,
      heartbeat_age_seconds: r.heartbeat_age_seconds ?? null,
      updated_at: r.updated_at || '',
      scope: r.scope,
      path: r.path,
      ...(r.jira_card ? { jira_card: r.jira_card } : {}),
    });
    totals.agents += 1;
    if (state in totals) totals[state] += 1;
  }
  // Active agents first (working, then asleep/blocked/coffee), terminal last — the reader's
  // first screenful is the live floor.
  const order = { working: 0, asleep: 1, blocked: 2, coffee: 3, idle: 4, failed: 5, offshift: 6 };
  agents.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.path.localeCompare(b.path));
  return {
    schema_version: 1,
    scope: 'repo',
    built_at: inv.built_at,
    stale_seconds_threshold: inv.stale_seconds_threshold,
    watch_roots: inv.watch_roots || [],
    totals,
    agents,
  };
}

/**
 * Absolute path of the centralized running-agents file (root singleton under .sidekicks/state/,
 * CLI-mediated like the inventory).
 * @param {string} repoRoot
 */
export function runningAgentsPath(repoRoot) {
  return statePath(repoRoot, 'running-agents.json');
}

/**
 * Atomically write the running-agents file. Returns its repo-relative path.
 * @param {string} repoRoot
 * @param {object} ra - buildRunningAgents() output
 */
export function writeRunningAgents(repoRoot, ra) {
  const p = runningAgentsPath(repoRoot);
  writeAtomicJson(p, ra);
  return { jsonRel: toRepoRel(repoRoot, p) };
}

/**
 * Rebuild + persist the inventory AND the centralized running-agents file. Best-effort
 * caller convenience used after a move so the consolidated view never lags a scope change.
 * @param {string} repoRoot
 */
export function refreshInventory(repoRoot) {
  try {
    const inv = buildInventory(repoRoot);
    writeInventory(repoRoot, inv);
    writeRunningAgents(repoRoot, buildRunningAgents(inv));
  } catch {
    /* best-effort — a stale inventory is re-derivable with `artifacts scan` */
  }
}

/**
 * Ensure the repo's .gitignore ignores the two derived inventory files. Idempotent;
 * mirrors ensureRepoIgnore() in _shared.mjs so a fresh clone/package self-heals.
 * @param {string} repoRoot
 * @returns {{ changed: boolean }}
 */
export function ensureInventoryIgnore(repoRoot) {
  const gi = join(repoRoot, '.gitignore');
  // Both locations: the files live under .sidekicks/state/ now, and a checkout that has not moved
  // them yet still has the legacy top-level copies to keep ignored.
  const RULES = [
    `.sidekicks/${STATE_DIR}/artifacts-inventory.json`,
    `.sidekicks/${STATE_DIR}/artifacts-inventory.md`,
    `.sidekicks/${STATE_DIR}/running-agents.json`,
    '.sidekicks/artifacts-inventory.json',
    '.sidekicks/artifacts-inventory.md',
    '.sidekicks/running-agents.json',
  ];
  let current = '';
  if (existsSync(gi)) {
    try { current = readFileSync(gi, 'utf8'); } catch { current = ''; }
  }
  const normalized = current.replace(/\r\n?/g, '\n');
  const have = new Set(normalized.split('\n').map((l) => l.replace(/\r$/, '').trim()));
  const missing = RULES.filter((r) => !have.has(r) && !have.has('/' + r));
  if (missing.length === 0) return { changed: false };
  const block = [
    '',
    '# Artifacts inventory is a derived, repo-wide cache (rebuilt by `sidekicks artifacts scan`).',
    ...missing,
    '',
  ].join('\n');
  const next = normalized === '' || normalized.endsWith('\n')
    ? normalized + block.replace(/^\n/, '')
    : normalized + block;
  writeAtomicText(gi, next);
  return { changed: true };
}

// ---------------------------------------------------------------------------
// Archive / restore path resolution + move
// ---------------------------------------------------------------------------

/**
 * Split an artifact path (repo-relative or absolute) around its `artifacts/` segment.
 * @param {string} repoRoot
 * @param {string} inputPath
 * @returns {{ abs: string, rel: string, baseRel: string, sub: string[] } | null}
 *   null if the path is not under any `artifacts/` tree.
 */
export function splitArtifactPath(repoRoot, inputPath) {
  const abs = isAbsolute(inputPath) ? inputPath : join(repoRoot, inputPath);
  const rel = toRepoRel(repoRoot, abs);
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  const idx = parts.lastIndexOf('artifacts');
  if (idx === -1) return null;
  return {
    abs,
    rel,
    baseRel: parts.slice(0, idx + 1).join('/'),
    sub: parts.slice(idx + 1),
  };
}

/**
 * Find the git repo that owns `absPath` (walk up for a `.git`), so `git mv` runs in the
 * right repo (a service `src/` is its own repo). Falls back to repoRoot.
 * @param {string} absPath
 * @param {string} repoRoot
 * @returns {string}
 */
export function findOwnerRepo(absPath, repoRoot) {
  let cur = absPath;
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur;
    if (cur === repoRoot) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return repoRoot;
}

/**
 * Move a folder, preferring `git mv` (keeps history + stages the move) and falling
 * back to a plain rename. Creates the destination parent. Never commits.
 * @param {string} srcAbs
 * @param {string} dstAbs
 * @param {string} ownerRepo
 * @returns {'git' | 'mv'} which mechanism moved it
 */
export function moveFolder(srcAbs, dstAbs, ownerRepo) {
  mkdirSync(dirname(dstAbs), { recursive: true });
  try {
    execFileSync('git', ['-C', ownerRepo, 'mv', srcAbs, dstAbs], { stdio: 'ignore' });
    return 'git';
  } catch {
    renameSync(srcAbs, dstAbs);
    return 'mv';
  }
}

/**
 * Archive ONE artifact folder — the shared core behind both `archive <path>` and the
 * batch `archive --done`. Pure: does the validation + move but NEVER refreshes the
 * inventory (the caller does that once). Returns a structured result instead of throwing
 * so a batch can keep going past a single skipped item.
 *
 * @param {string} repoRoot
 * @param {string} inputPath - repo-relative or absolute artifact path
 * @param {{ force?: boolean }} [opts]
 * @returns {{ ok: boolean, from?: string, to?: string, method?: 'git'|'mv',
 *            skipped?: boolean, reason?: string }}
 */
export function archiveOne(repoRoot, inputPath, opts = {}) {
  const split = splitArtifactPath(repoRoot, inputPath);
  if (!split) return { ok: false, reason: `'${inputPath}' is not under an artifacts/ tree` };
  if (split.sub.length === 0) return { ok: false, reason: 'refusing to archive the whole artifacts/ store' };
  if (split.sub[0] === ARCHIVE_DIRNAME) return { ok: false, skipped: true, reason: `already archived: ${split.rel}` };
  if (!existsSync(split.abs)) return { ok: false, reason: `not found: ${split.rel}` };

  if (isRunDir(split.abs)) {
    const skill = split.sub[0] === 'runs' ? split.sub[1] : undefined;
    const slug = split.sub[0] === 'runs' ? split.sub[2] : undefined;
    const status = runStatus(split.abs, skill, slug);
    if (ACTIVE_STATUSES.includes(status) && !opts.force) {
      return { ok: false, skipped: true, reason: `active run (status '${status}') — needs --force: ${split.rel}` };
    }
  }

  const dstRel = `${split.baseRel}/${ARCHIVE_DIRNAME}/${split.sub.join('/')}`;
  const dstAbs = fromRepoRel(repoRoot, dstRel);
  if (existsSync(dstAbs)) return { ok: false, reason: `destination already exists: ${dstRel}` };

  const method = moveFolder(split.abs, dstAbs, findOwnerRepo(split.abs, repoRoot));
  return { ok: true, from: split.rel, to: dstRel, method };
}

/**
 * Repo-relative paths of every live run whose status is in `statuses` (default: done).
 * Terminal-run selection for the batch `archive --done`.
 * @param {string} repoRoot
 * @param {string[]} [statuses]
 * @returns {string[]}
 */
export function doneRunPaths(repoRoot, statuses = ['done']) {
  const set = new Set(statuses);
  return buildInventory(repoRoot).types.runs.filter((r) => set.has(r.status)).map((r) => r.path);
}

/**
 * Orphaned-run selection for the batch `archive --stale`: every run classified
 * `liveness === 'stale'` (active status, heartbeat past the scan's staleness threshold — see
 * deriveLiveness) whose heartbeat age also clears `olderThanSeconds` (default
 * DEFAULT_STALE_ARCHIVE_DAYS). A run with no parseable heartbeat at all (age `null`) is treated
 * as clearing the gate too — an unreadable heartbeat is itself evidence of an abandoned run, the
 * same "absence of proof is stale" reasoning deriveLiveness already applies.
 * @param {string} repoRoot
 * @param {{ olderThanSeconds?: number }} [opts]
 * @returns {Array<{ path: string, skill: string, slug: string, status: string, heartbeat_age_seconds: number|null }>}
 */
export function staleRunCandidates(repoRoot, opts = {}) {
  const olderThanSeconds = Number.isFinite(opts.olderThanSeconds)
    ? opts.olderThanSeconds
    : DEFAULT_STALE_ARCHIVE_DAYS * 86400;
  return buildInventory(repoRoot).types.runs
    .filter((r) => r.liveness === 'stale' && (r.heartbeat_age_seconds ?? Infinity) >= olderThanSeconds)
    .map((r) => ({
      path: r.path,
      skill: r.skill,
      slug: r.slug,
      status: r.status,
      heartbeat_age_seconds: r.heartbeat_age_seconds ?? null,
    }));
}

export { fromRepoRel };
