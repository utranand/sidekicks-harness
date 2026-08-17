// lib/project-lifecycle/add.mjs
// Implements `sidekicks project add <git-url> [<name>]`.
//
// Acquires an existing git repository as a user project AND registers it as a
// git submodule of the ROOT repo, in one delegated step:
//   git submodule add <git-url> projects/<name>   (cwd = repoRoot)
// This clones the repo into projects/<name>/ and STAGES .gitmodules + the gitlink
// in the root index — the CLI never commits. The user commits.
//
// This is the project-scope analogue of `service add`'s submodule mode:
// the SAME git-delegation helpers (submoduleAdd / submoduleAbort) are reused at
// root scope — no new git-delegation function is introduced.
//
// EMPTY-REMOTE SEEDING: a reachable remote with ZERO refs (a freshly-created,
// never-pushed repo) cannot be checked out by `git submodule add`. Rather than
// failing, the verb scaffolds a fresh project tree in place (mirroring `project
// create`), commits it, and pushes to seed the remote — then registers it as a
// root submodule WITHOUT re-cloning (symmetric with `set-remote` step 10). This
// is the one path where the CLI commits/pushes, and it establishes a real git
// binding before recording remote_source.
//
// On failure: fsx.rmrf(projects/<name>/) + git.submoduleAbort(projects/<name>, repoRoot)
//   → clean root index/.gitmodules → EXIT_GIT.
// On success: manifest reconcile (setRemoteSource or fresh default) + activate.
//
// Zero npm dependencies — node:fs, node:path only (plus relative lib/ imports).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  SidekicksError,
  EXIT_OK,
  EXIT_VALIDATION,
  EXIT_GIT,
} from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { writeAtomic, rmrf, mkdirp } from '../fs-safety/fsx.mjs';
import { setActiveProject } from '../settings-store/settings.mjs';
import { read as readManifest, setRemoteSource } from '../manifest-schema/manifest.mjs';
import { serialize } from '../yaml-subset/yaml.mjs';
import {
  whichGit,
  isRepo,
  submoduleAdd,
  submoduleAbort,
  lsRemote,
  init,
  setRemote,
  addAll,
  commit,
  renameBranch,
  push,
  hasIdentity,
} from '../git-delegation/git.mjs';
import { rebuildRootIndex, rebuildProjectIndex } from '../scope-index/index.mjs';

// Branch the seed-an-empty-remote path normalizes the initial project branch to.
const SEED_BRANCH = 'main';

// Fallback committer identity injected (per-command, never written to config) when
// the host has no configured git identity — keeps the seed path working on CI.
const SEED_IDENTITY = { name: 'Sidekicks', email: 'sidekicks@local' };

/**
 * Scaffold a fresh project tree at `projectDir` (mirrors `project create`):
 *   manifest.yaml (with remote_source pre-set), config.yaml, docs/, output/, assets/
 * Each subdir is seeded with an empty .gitkeep. All writes go through the fs-guard.
 *
 * @param {string} projectDir - Absolute path to the project directory to create.
 * @param {string} name       - Project name.
 * @param {string} url        - Remote URL to record as remote_source.
 * @param {string} repoRoot   - Root repo (for the write-surface guard).
 */
function scaffoldProject(projectDir, name, url, repoRoot) {
  mkdirp(projectDir);
  for (const sub of ['docs', 'output', 'assets']) {
    const gitkeep = join(projectDir, sub, '.gitkeep');
    assertWritable(gitkeep, repoRoot);
    mkdirp(join(projectDir, sub));
    writeAtomic(gitkeep, '');
  }
  const manifestPath = join(projectDir, 'manifest.yaml');
  assertWritable(manifestPath, repoRoot);
  writeAtomic(
    manifestPath,
    serialize({ name, remote_source: url, services: [], overrides: {} })
  );
  const configPath = join(projectDir, 'config.yaml');
  assertWritable(configPath, repoRoot);
  writeAtomic(configPath, '');
}

// Reserved project names that cannot be used (owned by the root project).
const RESERVED_NAMES = new Set(['sidekicks']);

// Valid kebab-case name pattern (matches project create / manifest schema).
const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Derive a kebab-case project name from a git URL (canonical algorithm),
 * or use the explicit override when provided.
 *
 * @param {string} url
 * @param {string|undefined} optName
 * @returns {string} the resolved (un-validated) name
 */
function resolveName(url, optName) {
  if (optName !== undefined && optName !== null && optName !== '') {
    return optName;
  }
  let raw = url.replace(/\/+$/, '');           // strip trailing slash
  if (raw.endsWith('.git')) raw = raw.slice(0, -4); // strip .git
  const parts = raw.split(/[/:]/);             // last path segment (split on / and :)
  raw = (parts[parts.length - 1] || '').toLowerCase();
  raw = raw.replace(/[^a-z0-9]+/g, '-');       // non-alnum → dash
  raw = raw.replace(/^-+|-+$/g, '');           // trim dashes
  return raw;
}

/**
 * Execute the `project add <git-url> [<name>]` verb.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string, rest: string[], flags: object }} args
 *   - args.name   → <git-url>  (first positional after the verb)
 *   - args.rest[0] → [<name>]  (optional explicit project name)
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  const url = args && args.name != null ? String(args.name) : '';
  const optName =
    args && args.rest && args.rest[0] != null ? String(args.rest[0]) : undefined;

  // ── Precondition 1: URL non-empty ─────────────────────────────────────────
  if (!url || url.trim() === '') {
    throw new SidekicksError(
      'usage: sidekicks project add <git-url> [<name>]',
      EXIT_VALIDATION
    );
  }

  // ── Precondition 2: resolve + validate name ───────────────────────────────
  const name = resolveName(url, optName);
  if (!name || !NAME_PATTERN.test(name)) {
    throw new SidekicksError(
      `project name '${name}' is invalid: must match [a-z0-9-] (no leading/trailing dashes)`,
      EXIT_VALIDATION
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new SidekicksError(
      `'${name}' is a reserved project name`,
      EXIT_VALIDATION
    );
  }
  const projectDir = join(repoRoot, 'projects', name);
  if (existsSync(projectDir)) {
    throw new SidekicksError(
      `projects/${name}/ already exists`,
      EXIT_VALIDATION
    );
  }

  // Early write-surface guard — also rejects out-of-surface names.
  assertWritable(projectDir + '/', repoRoot);

  // ── Precondition 3: git on PATH ───────────────────────────────────────────
  if (whichGit() === null) {
    throw new SidekicksError(
      "git is required for 'project add' — install git and ensure it is on PATH",
      EXIT_GIT
    );
  }

  // ── Precondition 4: root must be a git working tree ───────────────────────
  // Registering a submodule of root requires the root itself to be a git repo.
  // The CLI does NOT auto-init the root (a larger structural act outside scope).
  if (!isRepo(repoRoot)) {
    throw new SidekicksError(
      "project add registers a submodule of the root repo, but the repository root is not a git working tree; run 'git init' at the repo root first",
      EXIT_GIT
    );
  }

  // ── Precondition 5: probe the remote (read-only ls-remote) ────────────────
  // Distinguishes three cases up front, before any side effect:
  //   - unreachable / nonexistent  → ls-remote throws  → surface EXIT_GIT
  //   - reachable but ZERO refs    → EMPTY repo         → seed it (below)
  //   - reachable WITH refs        → existing content   → normal submodule add
  const relPath = `projects/${name}`;
  let remoteRefs;
  try {
    remoteRefs = lsRemote(url); // read-only network op
  } catch (err) {
    if (err instanceof SidekicksError) throw err;
    throw new SidekicksError(err.message || 'git ls-remote failed', EXIT_GIT);
  }

  // ── Empty remote → scaffold a fresh project, then push to initialize it ────
  // The remote exists but holds no commits, so `git submodule add` would have
  // nothing to check out. Instead we scaffold the project tree in place, commit
  // it, and push to seed the remote — establishing a real git binding before
  // registration (see [[feedback_remote_source_needs_git_binding]]). After the
  // push, projects/<name>/ is its OWN repo whose HEAD lives on the remote, so the
  // SAME `git submodule add <url> projects/<name>` below ADDS it to the root index
  // WITHOUT re-cloning — symmetric with `set-remote` step 10.
  if (remoteRefs.length === 0) {
    try {
      scaffoldProject(projectDir, name, url, repoRoot);
      init(projectDir);
      addAll(projectDir);
      const identity = hasIdentity(projectDir) ? undefined : SEED_IDENTITY;
      commit(projectDir, `Initialize project ${name}`, { identity });
      renameBranch(projectDir, SEED_BRANCH);
      setRemote(projectDir, 'origin', url);
      push(projectDir, 'origin', SEED_BRANCH); // sanctioned WRITE
    } catch (err) {
      // Nothing has been staged in the root index yet, so rollback is just the
      // scaffolded working tree. The remote is untouched on a pre-push failure;
      // if the push itself failed, re-running `project add` retries cleanly.
      try { rmrf(projectDir); } catch { /* best-effort */ }
      if (err instanceof SidekicksError) throw err;
      throw new SidekicksError(
        `failed to initialize empty remote ${url}: ${err.message || 'unknown error'}`,
        EXIT_GIT
      );
    }
  }

  // ── Acquire + register: git submodule add <url> projects/<name> (cwd=root) ─
  // Normal path: clones the repo into projects/<name>/. Seed path: projects/<name>/
  // already exists as its own repo (pushed above), so git ADDS it without cloning.
  // Either way this stages .gitmodules + the gitlink in the root index. NO commit.
  // relPath is POSIX-style for git/.gitmodules.
  try {
    submoduleAdd(url, relPath, repoRoot);
  } catch (err) {
    // Rollback: remove partial working tree + clean the root index.
    try { rmrf(projectDir); } catch { /* best-effort */ }
    submoduleAbort(relPath, repoRoot); // 3-step best-effort; never throws
    if (err instanceof SidekicksError) throw err;
    throw new SidekicksError(
      err.message || 'git submodule add failed',
      EXIT_GIT
    );
  }

  // ── Reconcile manifest (remote_source = url) ──────────────────────────────
  // If the acquired repo already carries a valid manifest, set its remote_source;
  // otherwise write a fresh default manifest so the dir is recognized as a project.
  // Do NOT clobber the acquired repo's other content.
  const manifestPath = join(projectDir, 'manifest.yaml');
  assertWritable(manifestPath, repoRoot);
  let hasValidManifest = false;
  if (existsSync(manifestPath)) {
    try {
      readManifest(manifestPath); // validates schema; throws if malformed
      hasValidManifest = true;
    } catch {
      hasValidManifest = false; // present-but-malformed → overwrite with default
    }
  }
  if (hasValidManifest) {
    setRemoteSource(manifestPath, url);
  } else {
    writeAtomic(
      manifestPath,
      serialize({ name, remote_source: url, services: [], overrides: {} })
    );
  }

  // ── Activate the new project (nulls active_service) ──────────────────
  setActiveProject(repoRoot, name);

  // ── Rebuild indexes (Epic 4, Story 4.1) ─────────────────────────────────────
  // Tail-call after all mutations succeed. Root index reflects the added project;
  // also build the added project's index once (restores/creates its service set).
  // Best-effort wrapping is added in Story 4.3 — errors propagate here.
  rebuildRootIndex(repoRoot);
  rebuildProjectIndex(repoRoot, name);

  return { stdout: '', exitCode: EXIT_OK };
}
