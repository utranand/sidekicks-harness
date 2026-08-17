// lib/scope-lifecycle/inventory.mjs
// `scope inventory` — git-derived file inventory for a service scope.
//
// Resolves the target working folder (active scope, or --project/--service overrides),
// checks whether the service's src/ has been pulled, and emits a file list, count,
// top-level directories, and an entry-point tech hint.
//
// Never reads file contents; writes nothing; reads only git and the file system.
// Tolerates a registered-but-not-yet-pulled service: reports state "registered (not pulled)"
// and exits 0 without invoking git.
//
// Joins the `scope` namespace: `scope inventory` → lib/scope-lifecycle/inventory.mjs.
// Zero npm dependencies — node:fs, node:path only (plus lib/ back-edges).

import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { EXIT_OK } from '../sk-cli/errors.mjs';
import { read } from '../settings-store/settings.mjs';
import { resolveEffectiveScope, resolveWorkingFolder } from '../active-scope/scope.mjs';
import { lsFiles } from '../git-delegation/git.mjs';

// ---------------------------------------------------------------------------
// Entry-point heuristic — presence of well-known marker files → tech hint.
// ---------------------------------------------------------------------------
const ENTRY_POINT_MARKERS = [
  { file: 'package.json',    hint: 'Node.js project (package.json)' },
  { file: 'go.mod',          hint: 'Go module (go.mod)' },
  { file: 'Dockerfile',      hint: 'Container project (Dockerfile)' },
  { file: 'pyproject.toml',  hint: 'Python project (pyproject.toml)' },
  { file: 'setup.py',        hint: 'Python project (setup.py)' },
  { file: 'Cargo.toml',      hint: 'Rust project (Cargo.toml)' },
  { file: 'pom.xml',         hint: 'Java/Maven project (pom.xml)' },
  { file: 'build.gradle',    hint: 'Java/Gradle project (build.gradle)' },
  { file: 'composer.json',   hint: 'PHP project (composer.json)' },
  { file: 'Gemfile',         hint: 'Ruby project (Gemfile)' },
];

/**
 * Derive a one-line tech hint from the files present in `workdir`.
 * Checks each marker in order; returns the hint for the first match, or null.
 *
 * @param {string} workdir - Absolute path to the working folder.
 * @returns {string | null}
 */
function entryPointHint(workdir) {
  for (const { file, hint } of ENTRY_POINT_MARKERS) {
    if (existsSync(join(workdir, file))) {
      return hint;
    }
  }
  return null;
}

/**
 * Compute the unique top-level directories from a list of relative file paths.
 * For files in the root (no directory component), they are omitted from the dirs list.
 *
 * @param {string[]} files - Relative file paths.
 * @returns {string[]} - Sorted unique top-level directory names.
 */
function topDirs(files) {
  const dirs = new Set();
  for (const f of files) {
    const d = dirname(f);
    if (d && d !== '.') {
      // Only the first path segment is the "top-level dir".
      dirs.add(d.split('/')[0]);
    }
  }
  return Array.from(dirs).sort();
}

/**
 * Run `scope inventory`.
 *
 * Flags consumed from args.flags:
 *   --project <p>   Override the target project (skips active scope's project).
 *   --service <s>   Override the target service.
 *   --json          Emit JSON output instead of human-readable text.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {object} args - { flags }
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = args.flags ?? {};

  // ── 1. Resolve target scope ──────────────────────────────────────────────
  // Allow --project and --service to override the active scope.
  // parseArgs (in cli.mjs) uses strict:false, so we re-parse from raw argv.
  const rawArgv = ctx.argv ?? [];
  let targetProject = null;
  let targetService = null;

  for (let i = 0; i < rawArgv.length; i++) {
    const next = rawArgv[i + 1];
    const nextIsValue = next && !next.startsWith('--');
    if (rawArgv[i] === '--project' && nextIsValue) {
      targetProject = next;
      i++;
    } else if (rawArgv[i] === '--service' && nextIsValue) {
      targetService = next;
      i++;
    }
  }

  // Build the effective settings, possibly overriding the active scope.
  const activeSettings = read(repoRoot);
  let settings = activeSettings;

  if (targetProject !== null || targetService !== null) {
    // Build a synthetic settings snapshot for the supplied --project/--service.
    const base = resolveEffectiveScope(activeSettings);
    const proj = targetProject ?? base.projectName;
    const svc = targetService ?? base.serviceName;
    settings = {
      ...activeSettings,
      active_project: proj === 'sidekicks' ? null : proj,
      active_service: svc,
    };
  }

  // Resolve the working folder — throws EXIT_NOT_FOUND if service dir missing.
  const { projectName, serviceName, servicePath, workdir } = resolveWorkingFolder(settings, repoRoot);

  // ── 2. Detect pulled vs registered-only ─────────────────────────────────
  // A service is "pulled" when its src/ directory exists. For non-service scopes
  // (project or root) we treat the workdir itself as the relevant directory.
  let isPulled;
  if (servicePath) {
    const srcPath = join(servicePath, 'src');
    isPulled = existsSync(srcPath) && statSync(srcPath).isDirectory();
  } else {
    // Project or root scope: always treat as "pulled" (workdir is the project/repo root).
    isPulled = true;
  }

  const state = isPulled ? 'pulled' : 'registered (not pulled)';

  // ── 3. If not pulled, report and exit 0 without running git ─────────────
  if (!isPulled) {
    const scope = { project: projectName, service: serviceName };
    if (flags.json) {
      const out = {
        scope,
        state,
        working_folder: workdir,
        files: [],
        file_count: 0,
        top_dirs: [],
        entry_point_hint: null,
      };
      return { stdout: JSON.stringify(out, null, 2) + '\n', exitCode: EXIT_OK };
    }
    const lines = [
      `scope:   ${projectName}${serviceName ? ' / ' + serviceName : ''}`,
      `state:   ${state}`,
      `folder:  ${workdir}`,
      '',
    ];
    return { stdout: lines.join('\n'), exitCode: EXIT_OK };
  }

  // ── 4. Run lsFiles in the working folder's git toplevel ─────────────────
  const files = lsFiles(workdir);

  const fileCount = files.length;
  const dirs = topDirs(files);
  const hint = entryPointHint(workdir);
  const scope = { project: projectName, service: serviceName };

  // ── 5. Emit ──────────────────────────────────────────────────────────────
  if (flags.json) {
    const out = {
      scope,
      state,
      working_folder: workdir,
      files,
      file_count: fileCount,
      top_dirs: dirs,
      entry_point_hint: hint,
    };
    return { stdout: JSON.stringify(out, null, 2) + '\n', exitCode: EXIT_OK };
  }

  // Human-readable output.
  const lines = [
    `scope:   ${projectName}${serviceName ? ' / ' + serviceName : ''}`,
    `state:   ${state}`,
    `folder:  ${workdir}`,
    `files:   ${fileCount}`,
  ];
  if (dirs.length > 0) {
    lines.push(`top dirs: ${dirs.join(', ')}`);
  }
  if (hint) {
    lines.push(`hint:    ${hint}`);
  }
  lines.push('');
  if (files.length > 0) {
    for (const f of files) {
      lines.push(`  ${f}`);
    }
    lines.push('');
  }

  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}
