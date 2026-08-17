// lib/project-lifecycle/link.mjs
// Implements `sidekicks project link <path> [<name>]`.
//
// Registers an EXISTING out-of-tree directory (typically a repo on another volume,
// e.g. an external drive) as a user project by creating a directory link at
// projects/<name> pointing to it — a POSIX symlink or a Windows junction. Unlike
// `project add` (which clones/submodules a remote INTO the tree) or `project create`
// (which scaffolds a fresh tree), `link` leaves the content exactly where it lives
// and only establishes a local binding:
//
//   1. Link            projects/<name>  ->  <absolute external path>   (junction on Windows)
//   2. Seed metadata   writes manifest.yaml + config.yaml INTO the external dir when
//                       absent (remote_source auto-detected from its git origin), so the
//                       project's sidekicks metadata travels with the linked repo.
//   3. Ignore the link the symlink target is machine-specific, so projects/<name> is
//                       added to a managed .gitignore block — never committed.
//   4. Activate + index-rebuild, exactly like `project create`.
//
// Idempotent: re-linking the same path under the same name (e.g. on a second machine,
// or after `unlink`) re-establishes the binding without clobbering a travelled manifest.
//
// Discovery of the resulting symlinked project is handled by fsx.isDirLikeDirent in
// project list + the index scan (a directory-symlink dirent reports isDirectory()=false).
//
// Zero npm dependencies — node:fs, node:path only (plus relative lib/ imports).

import { existsSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, basename, sep } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { writeAtomic, createDirLink } from '../fs-safety/fsx.mjs';
import { setActiveProject } from '../settings-store/settings.mjs';
import { serialize } from '../yaml-subset/yaml.mjs';
import { isRepo, remoteUrl } from '../git-delegation/git.mjs';
import { rebuildRootIndex, rebuildProjectIndex } from '../scope-index/index.mjs';
import { addExternalIgnore, isSymlink } from './external-links.mjs';

// Reserved project names owned by the root project.
const RESERVED_NAMES = new Set(['sidekicks']);

// Valid kebab-case name pattern (matches project create / manifest schema).
const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Derive a kebab-case project name from a directory path, or use the explicit override.
 * @param {string} absTarget - Absolute path of the external directory.
 * @param {string|undefined} optName
 * @returns {string} the resolved (un-validated) name
 */
function resolveName(absTarget, optName) {
  if (optName !== undefined && optName !== null && optName !== '') return optName;
  let raw = basename(absTarget).toLowerCase();
  raw = raw.replace(/[^a-z0-9]+/g, '-'); // non-alnum → dash
  raw = raw.replace(/^-+|-+$/g, '');      // trim dashes
  return raw;
}

/**
 * Execute the `project link <path> [<name>]` verb.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string, rest: string[], flags: object }} args
 *   - args.name    → <path>   (the external directory to link)
 *   - args.rest[0] → [<name>] (optional explicit project name)
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  const rawPath = args && args.name != null ? String(args.name) : '';
  const optName =
    args && args.rest && args.rest[0] != null ? String(args.rest[0]) : undefined;

  // ── Precondition 1: path non-empty ────────────────────────────────────────
  if (!rawPath || rawPath.trim() === '') {
    throw new SidekicksError(
      'usage: sidekicks project link <path> [<name>]',
      EXIT_VALIDATION
    );
  }

  // Resolve the target against the current working directory, then canonicalize.
  const absTargetRaw = resolve(process.cwd(), rawPath);

  // ── Precondition 2: target exists and is a directory ──────────────────────
  let targetStat;
  try { targetStat = statSync(absTargetRaw); } catch { targetStat = null; }
  if (!targetStat) {
    throw new SidekicksError(
      `link target does not exist: ${absTargetRaw}`,
      EXIT_VALIDATION
    );
  }
  if (!targetStat.isDirectory()) {
    throw new SidekicksError(
      `link target is not a directory: ${absTargetRaw}`,
      EXIT_VALIDATION
    );
  }
  // Canonicalize (resolves any symlink components) for a stable link target.
  const absTarget = realpathSync(absTargetRaw);

  // ── Precondition 3: target must be OUTSIDE the repo tree ──────────────────
  // Linking a path already inside projects/ would be a real project, not an
  // external binding — the caller wants create/add, not link.
  const repoReal = realpathSync(repoRoot);
  if (absTarget === repoReal || absTarget.startsWith(repoReal + sep)) {
    throw new SidekicksError(
      `link target is inside the repository (${absTarget}); use 'project create' or 'project add' for in-tree projects`,
      EXIT_VALIDATION
    );
  }

  // ── Precondition 4: resolve + validate name ───────────────────────────────
  const name = resolveName(absTarget, optName);
  if (!name || !NAME_PATTERN.test(name)) {
    throw new SidekicksError(
      `project name '${name}' is invalid: must match [a-z0-9-] (no leading/trailing dashes) — pass an explicit <name>`,
      EXIT_VALIDATION
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new SidekicksError(`'${name}' is a reserved project name`, EXIT_VALIDATION);
  }

  const projectDir = join(repoRoot, 'projects', name);
  const relPath = `projects/${name}`;

  // Early write-surface guard for the link path (also rejects out-of-surface names).
  assertWritable(projectDir + '/', repoRoot);

  // ── Precondition 5: collision handling (idempotent re-link) ───────────────
  let alreadyLinked = false;
  if (existsSync(projectDir) || isSymlink(projectDir)) {
    if (isSymlink(projectDir)) {
      // A symlink already sits here — idempotent only if it points at the SAME target.
      let existingTarget = null;
      try { existingTarget = realpathSync(projectDir); } catch { existingTarget = null; }
      if (existingTarget === absTarget) {
        alreadyLinked = true; // re-link: repair metadata/ignore/activation below
      } else {
        throw new SidekicksError(
          `projects/${name} is already a link to a different target (${existingTarget ?? 'broken'}); ` +
          `run 'sidekicks project unlink ${name}' first`,
          EXIT_VALIDATION
        );
      }
    } else {
      throw new SidekicksError(`projects/${name}/ already exists`, EXIT_VALIDATION);
    }
  }

  // ── Step 1: create the directory link (skip if already correctly linked) ──
  if (!alreadyLinked) {
    createDirLink(absTarget, projectDir);
  }

  // ── Step 2: seed sidekicks metadata INTO the external dir when absent ─────
  // The metadata lives in the linked repo so it travels with it; a manifest that
  // is already there (a prior link on another machine) is preserved untouched.
  const manifestPath = join(absTarget, 'manifest.yaml');
  if (!existsSync(manifestPath)) {
    const remote = isRepo(absTarget) ? remoteUrl(absTarget) : null;
    writeAtomic(
      manifestPath,
      serialize({ name, remote_source: remote, services: [], overrides: {} })
    );
  }
  const configPath = join(absTarget, 'config.yaml');
  if (!existsSync(configPath)) {
    writeAtomic(configPath, '');
  }

  // ── Step 3: ignore the machine-specific link ──────────────────────────────
  addExternalIgnore(repoRoot, relPath);

  // ── Step 4: activate + rebuild indexes (mirrors project create) ───────────
  setActiveProject(repoRoot, name);
  rebuildRootIndex(repoRoot);
  rebuildProjectIndex(repoRoot, name);

  const verb = alreadyLinked ? 're-linked' : 'Linked';
  const stdout =
    `${verb} external project '${name}' and set it active.\n` +
    `  projects/${name} -> ${absTarget}\n` +
    `\n` +
    `The link is machine-specific and git-ignored; its manifest/config/index live in the\n` +
    `linked repo and travel with it. Re-run 'sidekicks project link ${absTarget} ${name}'\n` +
    `on another machine to recreate the binding. Use 'sidekicks project unlink ${name}' to\n` +
    `remove the binding without touching the external contents.\n`;

  return { stdout, exitCode: EXIT_OK };
}
