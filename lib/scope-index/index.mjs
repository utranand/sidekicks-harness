// lib/scope-index/index.mjs
// Shadow Index — module scaffold, schemas, and six exported functions.
// Pure, dependency-free module (no npm). Provides:
//   buildRootIndex     — build the root registry object (Story 1.2)
//   buildProjectIndex  — build a project's service-inventory object (Story 1.3)
//   readRootIndex      — self-healing root-index read (Epic 2, Story 2.2)
//   readProjectIndex   — read project index from disk (stub; hardens in Epic 2)
//   writeIndex         — atomic, boundary-compliant index write (Epic 2, Story 2.1)
//   getEntry           — drill-down resolver (Story 1.4)
//
// Zero new runtime dependencies — node:fs / node:path only (plus existing lib/).
// Reuses existing readers rather than re-parsing.

import {
  readdirSync,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import * as manifest from '../manifest-schema/manifest.mjs';
import * as settings from '../settings-store/settings.mjs';
import { resolveEffectiveScope, resolveWorkingFolder } from '../active-scope/scope.mjs';
import { headCommit } from '../git-delegation/git.mjs';
import { writeAtomic, mkdirp, isDirLikeDirent } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { statePath } from '../state-store/paths.mjs';

// ---------------------------------------------------------------------------
// Schema version — single source of truth for self-heal gating in Epic 2.
// ---------------------------------------------------------------------------

/**
 * Current schema version for both the root and project index shapes.
 * Readers in Epic 2 will trigger a rebuild when they encounter an index
 * whose `schema_version` differs from this constant.
 */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Schema documentation (authoritative in-module contracts)
// ---------------------------------------------------------------------------

/**
 * ROOT INDEX SCHEMA — `.sidekicks/index.json` (schema_version: 1)
 *
 * Project registry only — NO service data. Each user project carries an
 * `index` pointer to its own per-project index file.
 *
 * @typedef {object} RootIndex
 * @property {number} schema_version          - Always `SCHEMA_VERSION` (1).
 * @property {string} generated_at            - ISO 8601 timestamp with +07:00 offset.
 * @property {"root"} scope                   - Literal discriminator.
 * @property {object} active                  - Effective active scope at build time.
 * @property {string} active.project          - Active project name (e.g. "sidekicks").
 * @property {string|null} active.service     - Active service name or null.
 * @property {string} active.working_folder   - Working folder path, relative to the repository
 *                                              root (`.` for root scope). Kept relative so the
 *                                              index is machine-independent and consistent with
 *                                              the relative paths used everywhere else.
 * @property {Object.<string, RootProjectEntry>} projects - Map of all known projects.
 * @property {string[]} skills                - Names of skills in .agents/skills/.
 *
 * @typedef {object} RootProjectEntry
 * @property {"root"|"user"} kind             - "root" for the sidekicks project, "user" for all others.
 * @property {string} path                    - Relative path from repo root ("." or "projects/<p>").
 * @property {string|null} [remote_source]    - (user projects only) git remote URL or null.
 * @property {string} [index]                 - (user projects only) relative path to per-project index.
 *
 * Shape example:
 * {
 *   "schema_version": 1,
 *   "generated_at": "2026-06-01T12:00:00+07:00",
 *   "scope": "root",
 *   "active": { "project": "my-app", "service": null, "working_folder": "projects/my-app" },
 *   "projects": {
 *     "sidekicks": { "kind": "root", "path": "." },
 *     "my-app": {
 *       "kind": "user",
 *       "path": "projects/my-app",
 *       "remote_source": "https://github.com/org/my-app.git",
 *       "index": "projects/my-app/index.json"
 *     }
 *   },
 *   "skills": ["sk-bmad-developer", "sk-commander"]
 * }
 */

/**
 * PROJECT INDEX SCHEMA — `projects/<name>/index.json` (schema_version: 1)
 *
 * Per-project service inventory only — no data about other projects.
 * `state` is "pulled" iff the service's `src/` directory exists on disk,
 * else "registered" (covers both unpulled and freed/pinned-but-no-src cases).
 *
 * @typedef {object} ProjectIndex
 * @property {number} schema_version          - Always `SCHEMA_VERSION` (1).
 * @property {string} generated_at            - ISO 8601 timestamp with +07:00 offset.
 * @property {"project"} scope                - Literal discriminator.
 * @property {string} project                 - Project name.
 * @property {string|null} built_at_commit    - HEAD SHA of the project repo at build time, or null.
 * @property {Object.<string, ProjectServiceEntry>} services - Map of service name → entry.
 *
 * @typedef {object} ProjectServiceEntry
 * @property {string} path                    - Relative path from repo root.
 * @property {string} working_folder          - Relative path to the service's working folder.
 * @property {string} service_yaml            - Relative path to service.yaml.
 * @property {string|null} remote_source      - Git remote URL or null.
 * @property {string|null} branch             - Pinned branch or null.
 * @property {string|null} commit             - Pinned commit SHA or null.
 * @property {"pulled"|"registered"} state    - "pulled" iff src/ exists, else "registered".
 *
 * Shape example:
 * {
 *   "schema_version": 1,
 *   "generated_at": "2026-06-01T12:00:00+07:00",
 *   "scope": "project",
 *   "project": "my-app",
 *   "built_at_commit": "abc123...",
 *   "services": {
 *     "api": {
 *       "path": "projects/my-app/services/api",
 *       "working_folder": "projects/my-app/services/api/src",
 *       "service_yaml": "projects/my-app/services/api/service.yaml",
 *       "remote_source": "https://github.com/org/api.git",
 *       "branch": "main",
 *       "commit": "def456...",
 *       "state": "pulled"
 *     }
 *   }
 * }
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return the current ISO 8601 timestamp with +07:00 offset (Asia/Bangkok).
 * @returns {string}
 */
function nowISO() {
  const now = new Date();
  // Shift to +07:00 manually (UTC + 7 hours).
  const offsetMs = 7 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offsetMs);
  // toISOString gives "YYYY-MM-DDTHH:mm:ss.mmmZ"; replace Z with +07:00.
  return local.toISOString().replace('Z', '+07:00');
}

/**
 * Convert an absolute path to one relative to `repoRoot`.
 *
 * Returns `"."` when `abs` is the repo root itself (so the root scope reads `"."`
 * rather than an empty string). Keeping index paths relative makes the index
 * machine-independent and consistent with every other path it records.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string} abs      - Absolute path to convert.
 * @returns {string}
 */
function toRepoRelative(repoRoot, abs) {
  const rel = relative(repoRoot, abs);
  // Normalize to forward slashes so index paths are consistent across platforms.
  const normalized = rel.replace(/\\/g, '/');
  return normalized === '' ? '.' : normalized;
}

/**
 * List direct subdirectory names of `dir`. Returns [] if `dir` is absent or unreadable.
 * @param {string} dir
 * @returns {string[]}
 */
function listDirs(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => isDirLikeDirent(e, dir))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Minimal flat-mapping YAML parser for service.yaml.
 * service.yaml is always a flat key: value mapping produced by service.write().
 * Parsed line-by-line to avoid a circular import with yaml-subset.
 *
 * @param {string} text - Raw service.yaml content.
 * @returns {Object.<string, string|null>}
 */
function parseServiceYaml(text) {
  const result = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();
    if (rawVal === 'null' || rawVal === '~' || rawVal === '') {
      result[key] = null;
    } else if (
      (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
      (rawVal.startsWith("'") && rawVal.endsWith("'"))
    ) {
      result[key] = rawVal.slice(1, -1);
    } else {
      result[key] = rawVal;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the root registry index object.
 *
 * Pure function — reads `projects/`, each project's `manifest.yaml`, the active
 * settings, and `.agents/skills/`. Never reads any `service.yaml`. Skips
 * project dirs that lack a parseable manifest (mirrors `project list` behavior).
 * `active.working_folder` comes from `resolveWorkingFolder`, stored relative to
 * `repoRoot` (`.` for root scope) so the index is machine-independent.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @returns {RootIndex}
 */
export function buildRootIndex(repoRoot) {
  const s = settings.read(repoRoot);
  const scope = resolveEffectiveScope(s);

  // Resolve working folder — fall back gracefully if service dir is missing.
  let workingFolder = repoRoot;
  try {
    const wf = resolveWorkingFolder(s, repoRoot);
    workingFolder = wf.workdir;
  } catch {
    // Service dir missing — fall back to project dir or repo root.
    if (scope.projectRelPath) {
      workingFolder = join(repoRoot, scope.projectRelPath);
    }
  }

  // Enumerate user projects.
  const projectsDir = join(repoRoot, 'projects');
  const projectDirs = listDirs(projectsDir);

  const projects = {
    sidekicks: { kind: 'root', path: '.' },
  };

  for (const name of projectDirs) {
    const manifestPath = join(projectsDir, name, 'manifest.yaml');
    try {
      const raw = manifest.read(manifestPath);
      // Note: `databases[]` in the manifest is intentionally NOT included in the root
      // index entry here. The per-database `index.json` committed beside each artifact
      // at `projects/<name>/databases/<name-ver>/index.json` serves fast table lookup
      // for this increment. A future R4 enhancement could surface a `databases` pointer
      // map here (name+version → the per-database `index.json` path), mirroring how
      // `index` already points to `projects/<name>/index.json`; deferred per impl plan §9.
      projects[name] = {
        kind: 'user',
        path: `projects/${name}`,
        remote_source: raw.remote_source ?? null,
        index: `projects/${name}/index.json`,
      };
    } catch {
      // Skip dirs with missing or unparseable manifest (mirrors project list).
    }
  }

  // Enumerate skills from .agents/skills/.
  const skillsDir = join(repoRoot, '.agents', 'skills');
  const skillNames = listDirs(skillsDir);

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: nowISO(),
    scope: 'root',
    active: {
      project: scope.projectName,
      service: scope.serviceName,
      // Stored relative to repoRoot (`.` for root) — keeps the index machine-independent.
      working_folder: toRepoRelative(repoRoot, workingFolder),
    },
    projects,
    skills: skillNames,
  };
}

/**
 * Build the per-project service-inventory index object.
 *
 * Pure function — reads the project's `manifest.yaml` and each service's
 * `service.yaml`; computes `working_folder` and `state`. `state` is `"pulled"`
 * iff `src/` exists on disk, else `"registered"`. Freed services (pins set,
 * no `src/`) and unpulled services (no pins, no `src/`) both report `"registered"`.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string} project  - Project name (must exist under `projects/`).
 * @returns {ProjectIndex}
 */
export function buildProjectIndex(repoRoot, project) {
  const projectDir = join(repoRoot, 'projects', project);

  // HEAD commit of the project dir — null if not its own repo or no commits.
  let builtAtCommit = null;
  try {
    builtAtCommit = headCommit(projectDir);
  } catch {
    // Not a repo or no commits.
  }

  const servicesDir = join(projectDir, 'services');
  const serviceDirs = listDirs(servicesDir);

  const services = {};

  for (const svcName of serviceDirs) {
    const svcPath = join(servicesDir, svcName);
    const serviceYamlPath = join(svcPath, 'service.yaml');

    let remoteSource = null;
    let branch = null;
    let commit = null;

    if (existsSync(serviceYamlPath)) {
      try {
        const text = readFileSync(serviceYamlPath, 'utf8');
        const parsed = parseServiceYaml(text);
        remoteSource = parsed.remote_source ?? null;
        branch = parsed.branch ?? null;
        commit = parsed.commit ?? null;
      } catch {
        // Malformed service.yaml — record nulls.
      }
    }

    // state: "pulled" iff src/ directory exists on disk.
    const srcDir = join(svcPath, 'src');
    const state = existsSync(srcDir) ? 'pulled' : 'registered';

    const relSvcPath = `projects/${project}/services/${svcName}`;
    const workingFolder = state === 'pulled'
      ? `${relSvcPath}/src`
      : relSvcPath;

    services[svcName] = {
      path: relSvcPath,
      working_folder: workingFolder,
      service_yaml: `${relSvcPath}/service.yaml`,
      remote_source: remoteSource,
      branch,
      commit,
      state,
    };
  }

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: nowISO(),
    scope: 'project',
    project,
    built_at_commit: builtAtCommit,
    services,
  };
}

// ---------------------------------------------------------------------------
// Internal staleness helpers (used by readRootIndex)
// ---------------------------------------------------------------------------

/**
 * Safely return the mtime (ms since epoch) of a filesystem path.
 * Returns 0 if the path does not exist or stat fails.
 * @param {string} fsPath
 * @returns {number}
 */
function safeMtimeMs(fsPath) {
  try {
    return statSync(fsPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Determine if a root index is stale relative to the repository state.
 *
 * Returns true (needs rebuild) when any of the following holds:
 *   1. The index is absent or unparseable.
 *   2. The parsed `schema_version` does not equal SCHEMA_VERSION.
 *   3. The `generated_at` timestamp predates the newest of:
 *        - `projects/` directory mtime
 *        - `.sidekicks/settings.json` mtime
 *
 * @param {string} repoRoot   - Absolute path to the repository root.
 * @param {string} indexPath  - Absolute path to `.sidekicks/index.json`.
 * @returns {{ stale: true } | { stale: false, parsed: RootIndex }}
 */
function rootIndexStaleness(repoRoot, indexPath) {
  // 1. Absent or unreadable.
  if (!existsSync(indexPath)) return { stale: true };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    return { stale: true };
  }

  // 2. Schema mismatch.
  if (parsed.schema_version !== SCHEMA_VERSION) return { stale: true };

  // 3. Mtime check — compare generated_at against projects/ and settings.json.
  const generatedMs = new Date(parsed.generated_at).getTime();
  if (isNaN(generatedMs)) return { stale: true };

  const projectsDirMtime = safeMtimeMs(join(repoRoot, 'projects'));
  const settingsMtime = safeMtimeMs(join(repoRoot, '.sidekicks', 'settings.json'));
  const newestSourceMs = Math.max(projectsDirMtime, settingsMtime);

  if (generatedMs < newestSourceMs) return { stale: true };

  return { stale: false, parsed };
}

/**
 * Read the root index from disk, self-healing on staleness.
 *
 * Returns the cached `.sidekicks/index.json` when it is fresh (schema matches and
 * `generated_at` is no older than `projects/` mtime and `settings.json` mtime).
 *
 * Triggers a rebuild via `buildRootIndex` when the index is:
 *   - absent (fresh clone)
 *   - `schema_version` mismatches SCHEMA_VERSION
 *   - `generated_at` predates the newest of `projects/` mtime and `settings.json` mtime
 *
 * Because the root index is git-ignored, the rebuilt copy is persisted on read
 * (it dirties no tracked file). Pass `{ persist: false }` to suppress persistence
 * (for testing only).
 *
 * @param {string} repoRoot                  - Absolute path to the repository root.
 * @param {{ persist?: boolean }} [opts]     - Options; `persist` defaults to true.
 * @returns {RootIndex}
 */
export function readRootIndex(repoRoot, { persist = true } = {}) {
  const indexPath = statePath(repoRoot, 'index.json');
  const result = rootIndexStaleness(repoRoot, indexPath);

  if (!result.stale) {
    // Cache is fresh — return as-is.
    return result.parsed;
  }

  // Rebuild from authoritative sources.
  const rebuilt = buildRootIndex(repoRoot);

  // Persist (safe — root index is git-ignored).
  if (persist) {
    try {
      writeIndex(indexPath, rebuilt, repoRoot);
    } catch {
      // Best-effort: a write failure on a derived cache must not block the read.
    }
  }

  return rebuilt;
}

// ---------------------------------------------------------------------------
// Internal staleness helpers (used by readProjectIndex)
// ---------------------------------------------------------------------------

/**
 * Determine if a project index is stale relative to the repository state.
 *
 * Returns true (needs rebuild) when any of the following holds:
 *   1. The index is absent or unparseable.
 *   2. The parsed `schema_version` does not equal SCHEMA_VERSION.
 *   3. `built_at_commit` differs from the current HEAD of the project's repo
 *      (detects branch switches and out-of-band checkout/sync).
 *   4. `generated_at` predates the newest mtime of:
 *        - projects/<name>/manifest.yaml
 *        - any projects/<name>/services/<svc>/service.yaml
 *      This catches uncommitted, same-HEAD edits the HEAD check alone would miss.
 *
 * @param {string} repoRoot   - Absolute path to the repository root.
 * @param {string} project    - Project name.
 * @param {string} indexPath  - Absolute path to projects/<name>/index.json.
 * @returns {{ stale: true } | { stale: false, parsed: ProjectIndex }}
 */
function projectIndexStaleness(repoRoot, project, indexPath) {
  // 1. Absent or unreadable.
  if (!existsSync(indexPath)) return { stale: true };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    return { stale: true };
  }

  // 2. Schema mismatch.
  if (parsed.schema_version !== SCHEMA_VERSION) return { stale: true };

  const projectDir = join(repoRoot, 'projects', project);

  // 3. HEAD commit check — built_at_commit vs current HEAD of the project repo.
  let currentHead = null;
  try {
    currentHead = headCommit(projectDir);
  } catch {
    // Not a repo or no commits — treat null == null as equal (both null → no HEAD trigger).
  }
  if (parsed.built_at_commit !== currentHead) return { stale: true };

  // 4. Mtime check — generated_at vs manifest.yaml + all service.yaml files.
  const generatedMs = new Date(parsed.generated_at).getTime();
  if (isNaN(generatedMs)) return { stale: true };

  // Collect all relevant source mtimes.
  const manifestMtime = safeMtimeMs(join(projectDir, 'manifest.yaml'));
  let newestSourceMs = manifestMtime;

  const servicesDir = join(projectDir, 'services');
  for (const svcName of listDirs(servicesDir)) {
    const serviceYamlMtime = safeMtimeMs(join(servicesDir, svcName, 'service.yaml'));
    if (serviceYamlMtime > newestSourceMs) newestSourceMs = serviceYamlMtime;
  }

  if (generatedMs < newestSourceMs) return { stale: true };

  return { stale: false, parsed };
}

/**
 * Read the project index from disk, self-healing on staleness.
 *
 * Returns the committed `projects/<name>/index.json` when it is fresh (schema
 * matches, `built_at_commit` equals the project repo's current HEAD, and
 * `generated_at` is no older than `manifest.yaml` + all `service.yaml` mtimes).
 *
 * Triggers a rebuild via `buildProjectIndex` when the index is:
 *   - absent
 *   - `schema_version` mismatches SCHEMA_VERSION
 *   - `built_at_commit` ≠ current HEAD (branch switch / out-of-band checkout)
 *   - `generated_at` predates the mtime of `manifest.yaml` or any `service.yaml`
 *     (catches uncommitted, same-HEAD edits)
 *
 * Because the project index IS tracked by git, the rebuilt copy is returned
 * in-memory and NOT persisted on read (to avoid dirtying the tracked file and
 * breaking `service free`'s clean-tree gate). Pass `{ persist: true }` only
 * from `index rebuild` (Epic 3) and maintenance hooks (Epic 4).
 *
 * @param {string} repoRoot                  - Absolute path to the repository root.
 * @param {string} project                   - Project name.
 * @param {{ persist?: boolean }} [opts]     - Options; `persist` defaults to false.
 * @returns {ProjectIndex}
 */
export function readProjectIndex(repoRoot, project, { persist = false } = {}) {
  const indexPath = join(repoRoot, 'projects', project, 'index.json');
  const result = projectIndexStaleness(repoRoot, project, indexPath);

  if (!result.stale) {
    // Cache is fresh — return as-is.
    return result.parsed;
  }

  // Rebuild from authoritative sources.
  const rebuilt = buildProjectIndex(repoRoot, project);

  // Persist only when explicitly requested (index rebuild / hooks).
  // Default: memory-only, never written, so the project tree stays clean.
  if (persist) {
    try {
      writeIndex(indexPath, rebuilt, repoRoot);
    } catch {
      // Best-effort: a write failure must not block the read.
    }
  }

  return rebuilt;
}

/**
 * Write an index object to disk atomically within the CLI write surface.
 *
 * Calls `assertWritable(filePath, repoRoot)` to enforce boundary compliance
 * (Rule 1: only `.sidekicks/` and `projects/<name>/` are permitted) then
 * delegates to `writeAtomic` (temp-file + rename) to prevent concurrent-writer
 * corruption (R-4). Matches the same write pattern used by `settings.json` and
 * `manifest.yaml`.
 *
 * @param {string} filePath             - Absolute path to the target .json file.
 * @param {RootIndex|ProjectIndex} indexObj - The index object to serialize.
 * @param {string} repoRoot             - Absolute path to the repository root (for boundary check).
 * @throws {SidekicksError(EXIT_VALIDATION)} if `filePath` is outside the CLI write surface.
 * @throws {SidekicksError(EXIT_IO)}         on any filesystem failure during the write.
 */
export function writeIndex(filePath, indexObj, repoRoot) {
  assertWritable(filePath, repoRoot);
  // The root index lives in the scope's `state/` directory, which is git-ignored and therefore ABSENT
  // on a fresh clone. Without this the self-healing write fails on ENOENT — and because
  // rebuildRootIndex swallows failures by design, it would fail silently and the index would never
  // persist, turning every read into a full rebuild.
  mkdirp(dirname(filePath));
  writeAtomic(filePath, JSON.stringify(indexObj, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Epic 4 — Maintenance hook helpers (Story 4.1 / 4.2)
// ---------------------------------------------------------------------------

/**
 * Rebuild and persist the root index — best-effort, off-critical-path (Story 4.3).
 *
 * Convenience wrapper for hook tail-calls: builds the root index and writes it
 * to `.sidekicks/state/index.json` atomically. Always persists (hooks are on already-
 * mutating verb paths). Any failure is caught, warned to stderr, and silently
 * discarded so the calling verb still exits 0 — the index is a regenerable cache
 * and a rebuild failure must never fail an already-completed mutation (plan §7
 * failure policy; R-3). A subsequent self-healing read will repair the index.
 *
 * Rebuild is always full (not incremental) — drift-proof and idempotent.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @returns {void}
 */
export function rebuildRootIndex(repoRoot) {
  try {
    // Full (not incremental) rebuild — always drift-proof and idempotent.
    const rootIndex = buildRootIndex(repoRoot);
    const indexPath = statePath(repoRoot, 'index.json');
    writeIndex(indexPath, rootIndex, repoRoot);
  } catch (e) {
    // Best-effort: warn to stderr; verb still exits 0.
    process.stderr.write(`[sidekicks] Warning: root index rebuild failed — ${e?.message ?? e}\n`);
  }
}

/**
 * Rebuild and persist a project's index — best-effort, off-critical-path (Story 4.3).
 *
 * Convenience wrapper for hook tail-calls: builds the project index and writes
 * it to `projects/<project>/index.json` atomically (persist: true, so it lands
 * on disk). Any failure is caught, warned to stderr, and silently discarded so the
 * calling verb still exits 0 — the index is a regenerable cache and a rebuild
 * failure must never fail an already-completed mutation (plan §7 failure policy;
 * R-3). A subsequent self-healing read will repair the index.
 *
 * Rebuild is always full (not incremental) — drift-proof and idempotent.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string} project  - Project name (must exist under `projects/`).
 * @returns {void}
 */
export function rebuildProjectIndex(repoRoot, project) {
  try {
    // Full (not incremental) rebuild — always drift-proof and idempotent.
    const projectIndex = buildProjectIndex(repoRoot, project);
    const indexPath = join(repoRoot, 'projects', project, 'index.json');
    writeIndex(indexPath, projectIndex, repoRoot);
  } catch (e) {
    // Best-effort: warn to stderr; verb still exits 0.
    process.stderr.write(`[sidekicks] Warning: project index rebuild failed (${project}) — ${e?.message ?? e}\n`);
  }
}

/**
 * Resolve an index entry by key from the root index.
 *
 * Supported key forms:
 *   - `"active"`                    → root index `active` object
 *   - `"project:<p>"`               → `projects[<p>]` entry from root index
 *   - `"skills"`                    → root index `skills` array
 *   - `"project:<p>:service:<s>"`   → service entry from the project's index pointer
 *
 * For the service form, the function reads the project's index JSON (via the
 * `index` pointer in the root index) and returns the named service entry.
 *
 * Returns `{ found: false, key }` for unknown/malformed keys without throwing.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string} key      - One of the four key forms above.
 * @returns {{ found: true, entry: * } | { found: false, key: string }}
 */
export function getEntry(repoRoot, key) {
  if (!key || typeof key !== 'string') {
    return { found: false, key: String(key) };
  }

  const rootIndex = readRootIndex(repoRoot);
  if (!rootIndex) {
    return { found: false, key };
  }

  // "active"
  if (key === 'active') {
    return { found: true, entry: rootIndex.active };
  }

  // "skills"
  if (key === 'skills') {
    return { found: true, entry: rootIndex.skills };
  }

  // "project:<p>"
  const projectMatch = key.match(/^project:([^:]+)$/);
  if (projectMatch) {
    const p = projectMatch[1];
    const entry = rootIndex.projects && rootIndex.projects[p];
    if (entry === undefined) return { found: false, key };
    return { found: true, entry };
  }

  // "project:<p>:service:<s>"
  const serviceMatch = key.match(/^project:([^:]+):service:([^:]+)$/);
  if (serviceMatch) {
    const p = serviceMatch[1];
    const s = serviceMatch[2];

    const projectEntry = rootIndex.projects && rootIndex.projects[p];
    if (!projectEntry || !projectEntry.index) return { found: false, key };

    // Drill down: read the project's index via its pointer.
    const projectIndexPath = join(repoRoot, projectEntry.index);
    let projectIndex = null;
    try {
      projectIndex = JSON.parse(readFileSync(projectIndexPath, 'utf8'));
    } catch {
      return { found: false, key };
    }

    const serviceEntry = projectIndex.services && projectIndex.services[s];
    if (serviceEntry === undefined) return { found: false, key };
    return { found: true, entry: serviceEntry };
  }

  // Unknown key form.
  return { found: false, key };
}
