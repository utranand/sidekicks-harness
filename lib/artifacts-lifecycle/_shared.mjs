// lib/artifacts-lifecycle/_shared.mjs
// Shared helpers for the `sidekicks artifacts` verbs.
// NOT a dispatchable verb (no VERBS entry) — the dispatcher only resolves
// lib/artifacts-lifecycle/<verb>.mjs for entries in the VERBS table.
//
// The artifacts subsystem discovers, reads, writes, and chronologically lists the
// Jira run-state already on disk. Modeled on lib/memory-lifecycle/ (a thin verb per
// file over a shared core) and lib/index-lifecycle/ (rebuild-on-read for the hot path).
//
// Zero npm dependencies — node:* + lib/yaml-subset/ + lib/ back-edges only.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join, relative, sep, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveWorkingFolder } from '../active-scope/scope.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
import { SKILL_PREFIX, LEGACY_SKILL_PREFIX } from '../sk-cli/skill-trees.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The five-value status enum every run.json status (parent or subtask) must map onto.
export const STATUS_ENUM = Object.freeze(['running', 'done', 'blocked', 'failed', 'paused']);

// Verdict results for a subtask's verification.
export const VERDICT_RESULTS = Object.freeze(['pass', 'fail']);

// JIRA-ONLY filter (F11): a run is included only if it is Jira work — its folder is
// under a known Jira skill OR its run.json carries a non-empty jira_card. A single named
// constant so a new Jira-owning skill is one edit away.
export const JIRA_SKILLS = Object.freeze(['get-jira-done', 'jira-autopilot', 'jira-ready-gate']);

/**
 * True if a run belongs to a Jira-owning skill. Matches on the FACET (the skill id minus its
 * first-party prefix), because pre-v2 runs recorded the short name while runs layout v2 records
 * the full skill id — both must satisfy the same filter.
 *
 * BOTH PREFIXES ARE ACCEPTED, on purpose. This reads run records already written to disk, and every
 * run recorded before the sidekicks- → sk- rename carries the old id forever. Stripping only the
 * current prefix would drop those runs out of every Jira report the day the rename landed.
 * @param {string} [skill]
 * @returns {boolean}
 */
export function isJiraSkill(skill) {
  if (typeof skill !== 'string' || !skill) return false;
  const facet = skill.startsWith(SKILL_PREFIX) ? skill.slice(SKILL_PREFIX.length)
    : skill.startsWith(LEGACY_SKILL_PREFIX) ? skill.slice(LEGACY_SKILL_PREFIX.length)
      : skill;
  return JIRA_SKILLS.includes(facet);
}

// Lease tuning — best-effort, non-blocking. register must NEVER stall.
const LEASE_RETRIES = 3;
const LEASE_SLEEP_MS = 25;
const LEASE_STALE_MS = 5000;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Current time as an ISO-8601 string with the Asia/Bangkok (+07:00) offset.
 * Single source of truth for created_at / updated_at. Same convention as
 * lib/memory-lifecycle/_shared.mjs bangkokTimestamp.
 * @returns {string} e.g. "2026-06-29T01:52:08+07:00"
 */
export function nowBangkok() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((p) => [p.type, p.value])
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}+07:00`;
}

// ---------------------------------------------------------------------------
// Path-invariant helpers (per owning repo)
// ---------------------------------------------------------------------------

/**
 * Convert an absolute (or relative) path to a path RELATIVE to `repoRoot`,
 * normalized to forward slashes (machine-independent, Windows-safe).
 * A path already inside repoRoot resolves cleanly; '.' denotes the repo root.
 * @param {string} repoRoot
 * @param {string} p
 * @returns {string}
 */
export function toRepoRel(repoRoot, p) {
  if (p == null || p === '') return p;
  const abs = isAbsolute(p) ? p : join(repoRoot, p);
  let rel = relative(repoRoot, abs);
  if (rel === '') rel = '.';
  // Normalize to forward slashes regardless of platform.
  return rel.split(sep).join('/');
}

/**
 * Resolve a repo-relative path back to an absolute path under `repoRoot`.
 * @param {string} repoRoot
 * @param {string} rel
 * @returns {string}
 */
export function fromRepoRel(repoRoot, rel) {
  if (rel == null || rel === '') return repoRoot;
  if (isAbsolute(rel)) return rel;
  return join(repoRoot, rel.split('/').join(sep));
}

// ---------------------------------------------------------------------------
// Store / scan-root resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the project working folder for the index/timeline anchor and build the
 * set of scan roots (the project's own artifacts/runs PLUS each registered service's
 * src/artifacts/runs). Mirrors the WORKING FOLDER, not memory's two-path model (F6).
 *
 * Never errors on a missing store — returns resolved paths whether or not they exist.
 *
 * @param {{ repoRoot: string }} ctx
 * @param {{ artifacts_dir?: string }} [opts]
 * @returns {{
 *   repoRoot: string,
 *   project: string,
 *   projectWorkdir: string,   // absolute — the project-level anchor (repo root for root project)
 *   projectStoreDir: string,  // absolute — <base>/artifacts (the caller's own store base)
 *   indexPath: string,        // absolute — <projectWorkdir>/artifacts/index.json
 *   timelinePath: string,     // absolute — <projectWorkdir>/artifacts/ARTIFACTS.md
 *   scanRoots: Array<{ root: string, repoRoot: string, label: string }>
 * }}
 */
export function resolveStores(ctx, opts = {}) {
  const { repoRoot } = ctx;
  const settings = readSettings(repoRoot);
  const wf = resolveWorkingFolder(settings, repoRoot);

  // The caller's working folder is the store base (header co-locates with the ledger).
  // The index/ARTIFACTS.md anchor at the PROJECT level (projectPath; repo root for root).
  const projectWorkdir = wf.projectPath; // repoRoot for root project
  const artifactsDirOverride = opts.artifacts_dir
    ? (isAbsolute(opts.artifacts_dir) ? opts.artifacts_dir : join(repoRoot, opts.artifacts_dir))
    : null;

  // The store base (where register writes) is the caller's working folder unless overridden.
  const callerBase = artifactsDirOverride || join(wf.workdir, 'artifacts');
  // The project-level anchor base (index/timeline) is the project workdir's artifacts,
  // unless artifacts_dir overrides — then index lives beside the override base.
  const anchorBase = artifactsDirOverride || join(projectWorkdir, 'artifacts');

  const indexPath = join(anchorBase, 'index.json');
  const timelinePath = join(anchorBase, 'ARTIFACTS.md');

  // Build scan roots: project's own runs + each registered service's src/artifacts/runs.
  // Under runs layout v2 every new run lands in the PROJECT runs root below, so no new root
  // is needed; the service roots stay because pre-v2 service-scope runs are frozen there.
  const scanRoots = [];
  const projectRunsRoot = join(projectWorkdir, 'artifacts', 'runs');
  scanRoots.push({ root: projectRunsRoot, repoRoot: projectWorkdir, label: 'project' });

  // If artifacts_dir overrides, also scan that base's runs (it may differ from project).
  if (artifactsDirOverride) {
    const overrideRuns = join(artifactsDirOverride, 'runs');
    if (overrideRuns !== projectRunsRoot) {
      scanRoots.push({ root: overrideRuns, repoRoot, label: 'override' });
    }
  }

  // Service scan roots — services come from `index show <project> --json` (the one
  // surface that spans submodules + service repos). Best-effort; missing index → none.
  // A service's artifacts base is the service ROOT (artifacts/runs hangs off the service
  // root, never src/ — CLAUDE.md "Artifacts folder"). Scan the service root, and the src/
  // working folder too so the legacy src/artifacts/runs tree still surfaces (deduped).
  for (const svc of listServices(repoRoot, wf.projectName)) {
    // svc paths are repo-relative (per index invariant) to the repo root.
    const seen = new Set();
    for (const rel of [svc.serviceRoot, svc.workingFolder]) {
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      const svcBase = fromRepoRel(repoRoot, rel);
      scanRoots.push({ root: join(svcBase, 'artifacts', 'runs'), repoRoot: svcBase, label: `service:${svc.name}` });
    }
  }

  return {
    repoRoot,
    project: wf.projectName,
    projectWorkdir,
    projectStoreDir: callerBase,
    indexPath,
    timelinePath,
    scanRoots,
  };
}

/**
 * List a project's services from the root index (`index show <project> --json`).
 * Best-effort: any failure (no index, not a user project, parse error) → [].
 * @param {string} repoRoot
 * @param {string} projectName
 * @returns {Array<{ name: string, workingFolder: string, serviceRoot: string }>}
 */
export function listServices(repoRoot, projectName) {
  if (!projectName || projectName === 'sidekicks') return [];
  const projDir = join(repoRoot, 'projects', projectName);
  if (!existsSync(projDir)) return [];
  let json;
  try {
    const bin = join(repoRoot, 'bin', 'sidekicks');
    const out = execFileSync(process.execPath, [bin, 'index', 'show', projectName, '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    json = JSON.parse(out);
  } catch {
    return [];
  }
  const services = json && json.services && typeof json.services === 'object' ? json.services : {};
  const out = [];
  for (const [name, entry] of Object.entries(services)) {
    if (!entry || typeof entry !== 'object') continue;
    const wf = entry.working_folder || entry.path;
    if (typeof wf === 'string' && wf) out.push({ name, workingFolder: wf, serviceRoot: entry.path || wf });
  }
  return out;
}

// ---------------------------------------------------------------------------
// run.json read / write (atomic)
// ---------------------------------------------------------------------------

/**
 * Read + parse a run.json from a run directory. Tolerates CRLF/lone CR.
 * @param {string} runDir - absolute path to the run folder.
 * @returns {object|null} the parsed manifest, or null if absent/unreadable/invalid.
 */
export function readRun(runDir) {
  const p = join(runDir, 'run.json');
  if (!existsSync(p)) return null;
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text.replace(/\r\n?/g, '\n'));
  } catch {
    return null;
  }
}

/**
 * Atomically write a run.json (temp-file + renameSync, same-volume atomic).
 * Preserves created_at if already present in the manifest object passed in.
 * Refreshes updated_at to now. Validates status against the 5-enum.
 *
 * @param {string} runDir - absolute path to the run folder (created if absent).
 * @param {object} manifest - the full manifest object to write.
 * @returns {object} the manifest as written (with timestamps applied).
 * @throws {Error} on an invalid status (caller decides fatality).
 */
export function writeRunAtomic(runDir, manifest) {
  const m = { ...manifest };
  if (m.status != null && !STATUS_ENUM.includes(m.status)) {
    throw new Error(`invalid status '${m.status}' — one of: ${STATUS_ENUM.join(', ')}`);
  }
  if (!m.created_at) m.created_at = nowBangkok();
  m.updated_at = nowBangkok();
  writeAtomicJson(join(runDir, 'run.json'), m);
  return m;
}

/**
 * Atomic JSON write: temp-file in the same dir + renameSync. Creates parent dirs.
 * @param {string} absPath
 * @param {object} obj
 */
export function writeAtomicJson(absPath, obj) {
  mkdirSync(dirOf(absPath), { recursive: true });
  const tmp = join(dirOf(absPath), `.art-tmp-${randomBytes(8).toString('hex')}`);
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, absPath);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Atomic text write (for ARTIFACTS.md): temp-file + renameSync.
 * @param {string} absPath
 * @param {string} text
 */
export function writeAtomicText(absPath, text) {
  mkdirSync(dirOf(absPath), { recursive: true });
  const tmp = join(dirOf(absPath), `.art-tmp-${randomBytes(8).toString('hex')}`);
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, absPath);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function dirOf(p) {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf(sep));
  return idx === -1 ? '.' : p.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Lease — best-effort, NON-BLOCKING advisory lock for the rare same-run double-write
// ---------------------------------------------------------------------------

/**
 * Run `fn()` under a best-effort advisory lease on `<runDir>/run.json.lock`.
 *
 * Tries to create the lock via O_EXCL ('wx'); on contention retries a tiny bounded
 * budget, reclaims a stale lock (mtime past TTL), and — if still held — PROCEEDS
 * ANYWAY rather than block (register must never stall the skill's real work, F9).
 * Guards only the same-run case; different runs touch different lock files. Never
 * guards the index (the index is never written by register).
 *
 * @param {string} runDir
 * @param {() => T} fn
 * @returns {T}
 * @template T
 */
export function withRunLease(runDir, fn) {
  mkdirSync(runDir, { recursive: true });
  const lockPath = join(runDir, 'run.json.lock');
  let held = false;
  let fd = null;
  for (let attempt = 0; attempt <= LEASE_RETRIES; attempt++) {
    try {
      fd = openSync(lockPath, 'wx');
      held = true;
      break;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Reclaim a stale lock (mtime past TTL).
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > LEASE_STALE_MS) {
            rmSync(lockPath, { force: true });
            continue; // retry immediately after reclaim
          }
        } catch { /* race on stat — fall through to retry */ }
        if (attempt < LEASE_RETRIES) {
          sleepMs(LEASE_SLEEP_MS);
          continue;
        }
        // Budget exhausted, lock still held by a live writer → PROCEED ANYWAY.
        break;
      }
      // Any other error (e.g. dir vanished) → proceed without the lock.
      break;
    }
  }
  try {
    return fn();
  } finally {
    if (held && fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
      try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
    }
  }
}

// Synchronous tiny sleep without a foreground `sleep` shell (cross-platform).
function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy-wait the tiny budget */ }
}

// ---------------------------------------------------------------------------
// Subtask-tree mutator (F12/F13)
// ---------------------------------------------------------------------------

/**
 * Upsert one subtask row in the parent's subtasks[] (the dynamic-expansion mutator).
 * Reads the parent run.json, finds/creates the row with key===childKey, merges
 * `fields`, sets the row updated_at and bubbles the parent updated_at. Handles the
 * bidirectional expands_from / expanded_into lineage. Validates child status + verdict.
 * Atomic write. Caller wraps this in withRunLease(parentDir, ...).
 *
 * @param {string} parentDir - absolute path to the parent run folder.
 * @param {string} childKey
 * @param {object} fields - merge fields. Recognized: title,status,goal,kind,reason,
 *   origin,expands_from,attempts,bumpAttempts(bool),remove(bool),
 *   verdict{result,evidence}, pointer{name:relpath...}
 * @returns {object} the written parent manifest.
 * @throws {Error} on invalid child status / verdict result, or missing parent run.json.
 */
export function upsertChild(parentDir, childKey, fields = {}) {
  const parent = readRun(parentDir);
  if (!parent) {
    throw new Error(`parent run.json not found at ${parentDir}`);
  }
  if (fields.status != null && !STATUS_ENUM.includes(fields.status)) {
    throw new Error(`invalid subtask status '${fields.status}' — one of: ${STATUS_ENUM.join(', ')}`);
  }
  if (fields.verdict && fields.verdict.result != null
      && !VERDICT_RESULTS.includes(fields.verdict.result)) {
    throw new Error(`invalid verdict.result '${fields.verdict.result}' — one of: ${VERDICT_RESULTS.join(', ')}`);
  }

  if (!Array.isArray(parent.subtasks)) parent.subtasks = [];
  const now = nowBangkok();

  let row = parent.subtasks.find((r) => r && r.key === childKey);

  // Removal — drop the row.
  if (fields.remove) {
    parent.subtasks = parent.subtasks.filter((r) => !(r && r.key === childKey));
    parent.updated_at = now;
    writeAtomicJson(join(parentDir, 'run.json'), parent);
    return parent;
  }

  if (!row) {
    // Dynamic expansion: a never-seen key just appends a fresh row.
    row = { key: childKey, created_at: now };
    parent.subtasks.push(row);
  }

  // Merge scalar fields.
  for (const k of ['title', 'status', 'goal', 'kind', 'reason', 'origin', 'expands_from']) {
    if (fields[k] != null) row[k] = fields[k];
  }

  // Attempts — set or bump.
  if (fields.bumpAttempts) {
    row.attempts = (typeof row.attempts === 'number' ? row.attempts : 0) + 1;
  } else if (fields.attempts != null) {
    row.attempts = Number(fields.attempts);
  }

  // Verdict — {result, evidence, checked_at}.
  if (fields.verdict && (fields.verdict.result != null || fields.verdict.evidence != null)) {
    row.verdict = {
      result: fields.verdict.result ?? (row.verdict ? row.verdict.result : undefined),
      evidence: fields.verdict.evidence ?? (row.verdict ? row.verdict.evidence : undefined),
      checked_at: now,
    };
  }

  // Pointers — merge name→relpath.
  if (fields.pointer && typeof fields.pointer === 'object') {
    row.pointer = { ...(row.pointer || {}), ...fields.pointer };
  }

  row.updated_at = now;

  // Bidirectional lineage: expands_from=<P> ⇒ append childKey to row <P>'s expanded_into.
  if (fields.expands_from) {
    const parentRow = parent.subtasks.find((r) => r && r.key === fields.expands_from);
    if (parentRow) {
      if (!Array.isArray(parentRow.expanded_into)) parentRow.expanded_into = [];
      if (!parentRow.expanded_into.includes(childKey)) {
        parentRow.expanded_into.push(childKey);
        parentRow.updated_at = now;
      }
    }
  }

  // Bubble the parent's own updated_at so a child change moves the epic on the timeline.
  parent.updated_at = now;
  writeAtomicJson(join(parentDir, 'run.json'), parent);
  return parent;
}

/**
 * Compute whether a parent run is exitable, purely from its run.json:
 * exitable iff every subtask status==done AND verdict.result==pass AND
 * exit_check.remaining / exit_check.unmet are empty. A leaf run (no subtasks)
 * is exitable iff its own status==done and remaining/unmet empty.
 *
 * @param {object} manifest
 * @returns {{ exitable: boolean, reasons: string[] }}
 */
export function computeExitable(manifest) {
  const reasons = [];
  const subtasks = Array.isArray(manifest.subtasks) ? manifest.subtasks : [];
  for (const st of subtasks) {
    if (st.status !== 'done') reasons.push(`subtask ${st.key} status=${st.status ?? 'unset'}`);
    else if (!st.verdict || st.verdict.result !== 'pass') {
      reasons.push(`subtask ${st.key} verdict=${st.verdict ? st.verdict.result : 'none'}`);
    }
  }
  if (subtasks.length === 0 && manifest.status !== 'done') {
    reasons.push(`run status=${manifest.status ?? 'unset'}`);
  }
  const ec = manifest.exit_check || {};
  const remaining = Array.isArray(ec.remaining) ? ec.remaining : [];
  const unmet = Array.isArray(ec.unmet) ? ec.unmet : [];
  if (remaining.length) reasons.push(`remaining: ${remaining.join(',')}`);
  if (unmet.length) reasons.push(`unmet: ${unmet.join(',')}`);
  return { exitable: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Discovery — scanRuns / inferHeader (Jira-only filter, F11)
// ---------------------------------------------------------------------------

/**
 * Enumerate runs from ALL scan roots. For each <root>/<short-skill>/<slug>/ directory,
 * return its manifest: the parsed run.json if present, else an inferred header.
 * Keyed on the SHORT skill name (F8). Tags each run with its source root so cross-repo
 * paths resolve. Applies the JIRA-ONLY filter (F11): keep a run only if its skill is in
 * JIRA_SKILLS OR its run.json carries a non-empty jira_card.
 *
 * @param {Array<{ root: string, repoRoot: string, label: string }>} scanRoots
 * @returns {Array<object>} runs, each { skill, slug, runDir, sourceRoot, sourceRepoRoot,
 *   sourceLabel, inferred, ...manifestFields }
 */
export function scanRuns(scanRoots) {
  const runs = [];
  for (const sr of scanRoots) {
    if (!existsSync(sr.root)) continue;
    let skillDirs;
    try {
      skillDirs = readdirSync(sr.root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sd of skillDirs) {
      if (!sd.isDirectory()) continue;
      const skill = sd.name;
      const skillPath = join(sr.root, skill);

      // Runs layout v2 `--bare`: the work-item folder at depth 1 IS the run. Legacy skill-id
      // folders carry no run.json/ledger of their own, so this never fires for them.
      const bareManifest = readRun(skillPath);
      const bareHasLedger = !bareManifest && hasLedger(skillPath);
      if (bareManifest || bareHasLedger) {
        const bare = bareManifest
          ? { ...bareManifest, inferred: false, skill: bareManifest.skill || skill, slug: bareManifest.slug || skill }
          : { ...inferHeader(skill, skill, skillPath), inferred: true };
        bare.runDir = skillPath;
        bare.sourceRoot = sr.root;
        bare.sourceRepoRoot = sr.repoRoot;
        bare.sourceLabel = sr.label;
        pushIfJira(runs, bare);
      }

      let slugDirs;
      try {
        slugDirs = readdirSync(skillPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const slugDir of slugDirs) {
        if (!slugDir.isDirectory()) continue;
        const slug = slugDir.name;
        const runDir = join(skillPath, slug);
        const manifest = readRun(runDir);
        let entry;
        if (manifest) {
          entry = { ...manifest, inferred: false };
          entry.skill = manifest.skill || skill;
          entry.slug = manifest.slug || slug;
        } else {
          entry = { ...inferHeader(skill, slug, runDir), inferred: true };
        }
        entry.runDir = runDir;
        entry.sourceRoot = sr.root;
        entry.sourceRepoRoot = sr.repoRoot;
        entry.sourceLabel = sr.label;

        pushIfJira(runs, entry);
      }
    }
  }
  return runs;
}

/** True if `absDir` carries one of the bespoke engine ledgers — i.e. it IS a run folder. */
function hasLedger(absDir) {
  return LEDGER_FILES.some((f) => existsSync(join(absDir, f)));
}

/** JIRA-ONLY filter (F11) — keep a run only if its skill owns Jira work or it names a card. */
function pushIfJira(runs, entry) {
  const isJira = isJiraSkill(entry.skill)
    || (typeof entry.jira_card === 'string' && entry.jira_card.trim() !== '');
  if (isJira) runs.push(entry);
}

// Map a bespoke ledger status onto the 5-value enum (F10/N2). Explicit table.
const STATUS_MAP = Object.freeze({
  // open / in-flight
  running: 'running',
  executing: 'running',
  'in-progress': 'running',
  'awaiting-approval': 'running',
  'awaiting-merge': 'running',
  'awaiting-build': 'running',
  reviewing: 'running',
  fixing: 'running',
  planning: 'running',
  expanded: 'running',
  // terminal
  done: 'done',
  complete: 'done',
  completed: 'done',
  shipped: 'done',
  // held
  blocked: 'blocked',
  paused: 'paused',
  halted: 'blocked',
  // failed
  failed: 'failed',
  error: 'failed',
});

/**
 * Map an arbitrary ledger status string onto the 5-enum.
 * @param {string|undefined} raw
 * @returns {string} one of STATUS_ENUM, or 'unknown' when nothing parses.
 */
export function mapStatus(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return 'unknown';
  const key = raw.trim().toLowerCase();
  if (STATUS_MAP[key]) return STATUS_MAP[key];
  // awaiting-* / *-pending family → still open.
  if (key.startsWith('awaiting') || key.endsWith('pending')) return 'running';
  return 'unknown';
}

// Bespoke ledger filenames inference reads, in priority order.
const LEDGER_FILES = Object.freeze([
  'batch.yaml',
  'ledger.yaml',
  'mission-status.yaml',
  'tasks.yaml',
]);

/**
 * Infer a legacy run header when no run.json exists (READ-ONLY — never writes a
 * run.json into a legacy folder, so rebuild is non-destructive, F10/c7).
 * Reads the bespoke ledger's own status and MAPS it onto the 5-enum; title/updated_at
 * best-effort; timestamps fall back to folder mtime.
 *
 * @param {string} skill - short skill name (from path)
 * @param {string} slug  - run slug (from path)
 * @param {string} runDir
 * @returns {object} { skill, slug, status, title, created_at, updated_at, jira_card? }
 */
export function inferHeader(skill, slug, runDir) {
  let ledger = null;
  for (const fname of LEDGER_FILES) {
    const fpath = join(runDir, fname);
    if (!existsSync(fpath)) continue;
    try {
      const parsed = yaml.parse(readFileSync(fpath, 'utf8').replace(/\r\n?/g, '\n'));
      if (parsed && typeof parsed === 'object') { ledger = parsed; break; }
    } catch { /* keep trying the next candidate */ }
  }

  let rawStatus, title, updatedAt, createdAt, jiraCard;
  if (ledger) {
    rawStatus = ledger.status
      || (ledger.mission && ledger.mission.status)
      || ledger.state;
    title = ledger.title || ledger.goal || ledger.objective
      || (ledger.mission && ledger.mission.goal);
    updatedAt = ledger.updated_at || ledger.updatedAt
      || (ledger.lease && ledger.lease.heartbeat_at);
    createdAt = ledger.created_at || ledger.createdAt
      || (ledger.lease && ledger.lease.claimed_at);
    jiraCard = ledger.jira_card
      || (ledger.jira && ledger.jira.card)
      || ledger.card;
  }

  // Folder mtime fallback for timestamps.
  let mtimeIso;
  try {
    const st = statSync(runDir);
    mtimeIso = new Date(st.mtimeMs).toISOString();
  } catch {
    mtimeIso = nowBangkok();
  }

  return {
    skill,
    slug,
    status: mapStatus(rawStatus),
    title: typeof title === 'string' ? title : '',
    created_at: createdAt || mtimeIso,
    updated_at: updatedAt || mtimeIso,
    ...(jiraCard ? { jira_card: String(jiraCard) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Aggregation — buildIndex / renderTimeline
// ---------------------------------------------------------------------------

/**
 * Sort runs newest-updated first. Stable for ties on slug.
 * @param {Array<object>} runs
 * @returns {Array<object>} a new sorted array
 */
export function sortRuns(runs) {
  return [...runs].sort((a, b) => {
    const av = String(a.updated_at || '');
    const bv = String(b.updated_at || '');
    if (av === bv) return String(a.slug).localeCompare(String(b.slug));
    return av < bv ? 1 : -1; // descending
  });
}

/**
 * Build the aggregated index.json object from a scan result.
 * Each run carries its source root (repo-relative to the project anchor) so a reader
 * can resolve across repos.
 *
 * @param {Array<object>} scan - scanRuns() output
 * @param {{ project: string, projectWorkdir: string }} meta
 * @returns {object} { schema_version:1, scope:"project", project, built_at, runs:[...] }
 */
export function buildIndex(scan, meta) {
  const sorted = sortRuns(scan);
  const runs = sorted.map((r) => ({
    skill: r.skill,
    slug: r.slug,
    status: r.status ?? 'unknown',
    title: r.title ?? '',
    created_at: r.created_at ?? '',
    updated_at: r.updated_at ?? '',
    inferred: !!r.inferred,
    source_label: r.sourceLabel,
    // run dir relative to the project anchor (forward-slash, machine-independent)
    run_dir: toRepoRel(meta.projectWorkdir, r.runDir),
    ...(r.jira_card ? { jira_card: r.jira_card } : {}),
    ...(Array.isArray(r.subtasks) ? { subtask_count: r.subtasks.length } : {}),
  }));
  return {
    schema_version: 1,
    scope: 'project',
    project: meta.project,
    built_at: nowBangkok(),
    runs,
  };
}

/**
 * Render the ARTIFACTS.md body: one line per run, newest updated_at first:
 *   - [<status>] <short-skill>/<slug> — <title>  (<updated_at>)
 *
 * @param {Array<object>} scan - scanRuns() output
 * @param {{ project: string }} meta
 * @returns {string}
 */
export function renderTimeline(scan, meta) {
  const sorted = sortRuns(scan);
  const header = [
    `# Artifacts Timeline — ${meta.project}`,
    '',
    'Chronological view of every Jira run across this project and its service repos,',
    'newest first. Derived from run.json + inferred legacy headers. Rebuilt by',
    '`sidekicks artifacts rebuild`; read live by `sidekicks artifacts timeline`.',
    '',
    '',
  ].join('\n');
  const lines = sorted.map(
    (r) => `- [${r.status ?? 'unknown'}] ${r.skill}/${r.slug} — ${r.title ?? ''}  (${r.updated_at ?? ''})`
  );
  return header + lines.join('\n') + (lines.length ? '\n' : '');
}

// ---------------------------------------------------------------------------
// Per-repo .gitignore self-heal helper (F3)
// ---------------------------------------------------------------------------

/**
 * Ensure the OWNING repo's .gitignore ignores `artifacts/index.json`. Idempotent:
 * no-op if a rule already covers it. Run on first register/rebuild in a given repo.
 * Tolerates CRLF. Best-effort — any failure is swallowed by the caller.
 *
 * The rule written is `artifacts/index.json` (repo-relative within the owning repo),
 * which is what `git check-ignore -v` resolves inside that repo's working tree.
 *
 * @param {string} ownerRepoRoot - absolute path to the repo that holds the store.
 * @returns {{ changed: boolean, gitignorePath: string }}
 */
export function ensureRepoIgnore(ownerRepoRoot) {
  const gi = join(ownerRepoRoot, '.gitignore');
  const RULE = 'artifacts/index.json';
  let current = '';
  if (existsSync(gi)) {
    try { current = readFileSync(gi, 'utf8'); } catch { current = ''; }
  }
  const normalized = current.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n').map((l) => l.replace(/\r$/, '').trim());
  // Already covered by an exact rule or the root-form `/artifacts/index.json`.
  if (lines.includes(RULE) || lines.includes('/' + RULE)) {
    return { changed: false, gitignorePath: gi };
  }
  const block = [
    '',
    '# Artifacts index is a derived, git-ignored cache (ARTIFACTS.md + run.json ARE tracked).',
    RULE,
    '',
  ].join('\n');
  const next = normalized.endsWith('\n') || normalized === ''
    ? normalized + block.replace(/^\n/, '')
    : normalized + block;
  writeAtomicText(gi, next);
  return { changed: true, gitignorePath: gi };
}

// ---------------------------------------------------------------------------
// Read-verb flag parser (memory-style ctx.argv re-parse — the parseArgs gotcha)
// ---------------------------------------------------------------------------

/**
 * Parse artifacts read-verb flags from raw argv, supporting both `--key=value`
 * and `--key value`. Same shape as memory-lifecycle parseMemoryFlags.
 *
 * @param {string[]} argv
 * @param {string[]} [booleans=[]]
 * @returns {Record<string, string|boolean>}
 */
export function parseArtifactFlags(argv, booleans = []) {
  const out = {};
  const boolSet = new Set(booleans);
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string' || !tok.startsWith('--')) continue;
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      const key = body.slice(0, eq);
      out[key] = boolSet.has(key) ? true : body.slice(eq + 1);
      continue;
    }
    const key = body;
    if (boolSet.has(key)) { out[key] = true; continue; }
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = '';
  }
  return out;
}

/**
 * Parse `field=value` bare positionals (NOT --flags) into an object. Repeated
 * `pointer.<name>=<rel>` collect into a `pointer` sub-object. Used by register/child.
 *
 * @param {string[]} positionals
 * @returns {{ fields: Record<string,string>, pointer: Record<string,string> }}
 */
export function parseFieldPositionals(positionals) {
  const fields = {};
  const pointer = {};
  for (const tok of positionals || []) {
    if (typeof tok !== 'string') continue;
    const eq = tok.indexOf('=');
    if (eq === -1) continue;
    const key = tok.slice(0, eq);
    const val = tok.slice(eq + 1);
    if (key.startsWith('pointer.')) {
      pointer[key.slice('pointer.'.length)] = val;
    } else {
      fields[key] = val;
    }
  }
  return { fields, pointer };
}
