// lib/project-lifecycle/create.mjs
// Implements `sidekicks project create <name>`.
//
// Scaffolds projects/<name>/{manifest.yaml, config.yaml, docs/, output/, assets/}
// (each subdir seeded with an empty .gitkeep) and immediately activates the project
// via settings.setActiveProject (which also nulls active_service).
//
// All-or-nothing on failures — no partial scaffold rollback (report-and-instruct stance
// per architecture notes; existence check prevents re-running on partial dirs).
//
// Zero npm dependencies — node:fs, node:path only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { setActiveProject } from '../settings-store/settings.mjs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { serialize } from '../yaml-subset/yaml.mjs';
import { rebuildRootIndex, rebuildProjectIndex } from '../scope-index/index.mjs';

// Reserved project names that cannot be used.
const RESERVED_NAMES = new Set(['sidekicks']);

// Valid kebab-case name pattern: starts and ends with alphanumeric; hyphens only in between.
// Leading/trailing hyphens are rejected (e.g. "--bad", "-foo", "bar-" are invalid).
const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Execute the `project create <name>` verb.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on validation failure or I/O error.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = args && args.name != null ? String(args.name) : '';

  // ── Input validation ────────────────────────────────────────────
  if (!name || name.trim() === '') {
    throw new SidekicksError(
      'project create requires a <name> argument',
      EXIT_VALIDATION
    );
  }

  if (!NAME_PATTERN.test(name)) {
    throw new SidekicksError(
      `project name '${name}' is invalid: must match [a-z0-9-]`,
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

  // ── Early write-surface guard ───────────────────────────────────
  // This check also serves as an early-exit guard for out-of-surface paths.
  assertWritable(projectDir + '/', repoRoot);

  // ── Existence check ─────────────────────────────────────────────
  if (existsSync(projectDir)) {
    throw new SidekicksError(
      `projects/${name}/ already exists`,
      EXIT_VALIDATION
    );
  }

  // ── Scaffold directory tree ───────────────────────────
  // Create the project root directory (assertWritable already called at line 67).
  mkdirp(projectDir);

  // Subdirectories with .gitkeep seeds (services/ is NOT scaffolded).
  const subdirs = ['docs', 'output', 'assets'];
  for (const sub of subdirs) {
    const subDir = join(projectDir, sub);
    const gitkeep = join(subDir, '.gitkeep');
    assertWritable(gitkeep, repoRoot);
    mkdirp(subDir);
    writeAtomic(gitkeep, '');
  }

  // ── Write manifest.yaml ─────────────────────────────────────────
  // Canonical initial content per data model.
  const manifestPath = join(projectDir, 'manifest.yaml');
  assertWritable(manifestPath, repoRoot);
  const manifestContent = serialize({
    name,
    remote_source: null,
    services: [],
    overrides: {},
  });
  writeAtomic(manifestPath, manifestContent);

  // ── Write config.yaml as empty 0-byte file ─────────────────────
  // Framework-opaque — never read, parsed, or validated by the framework.
  const configPath = join(projectDir, 'config.yaml');
  assertWritable(configPath, repoRoot);
  writeAtomic(configPath, '');

  // ── Activate the new project ────────────────────────────────────
  // setActiveProject writes {active_project: name, active_service: null} atomically
  // and creates .sidekicks/settings.json if absent.
  setActiveProject(repoRoot, name);

  // ── Rebuild indexes (Epic 4, Story 4.1) ─────────────────────────────────────
  // Tail-call after all mutations succeed. Root index reflects the new project;
  // also build the new project's index once (its initial service set is empty,
  // but the index file is created so readers don't self-heal-rebuild on first read).
  // Best-effort wrapping is added in Story 4.3 — errors propagate here.
  rebuildRootIndex(repoRoot);
  rebuildProjectIndex(repoRoot, name);

  // ── Next-step guidance ────────────────────────────────────────────────────
  // The next structural step after scaffolding is binding a git remote. We emit
  // this hint here (rather than in a skill) so it stays version-locked with the
  // actual set-remote contract and reaches agent and human alike. The empty-repo
  // requirement is surfaced up front because it is a precondition of the very
  // first push that set-remote verifies — a non-empty remote rejects that push.
  const hint =
    `Created project '${name}' and set it active.\n` +
    `\n` +
    `Next — bind a git remote (optional, when you want to push this project):\n` +
    `  1. Create an EMPTY remote repo (no README, no .gitignore, no license).\n` +
    `  2. node bin/sidekicks project set-remote <git-url>\n` +
    `Then follow set-remote's prompts: it guides you to commit, push, and re-run.\n` +
    `It records remote_source only after verifying the remote holds your pushed HEAD.\n`;

  return { stdout: hint, exitCode: EXIT_OK };
}
