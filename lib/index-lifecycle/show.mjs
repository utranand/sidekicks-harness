// lib/index-lifecycle/show.mjs
// `index show [<project>] [--json]` verb implementation.
//
// Prints the root registry (no arg) or a project's service index (with <project>).
// `--json` emits the raw index object for machine consumption (e.g. sk-hello).
//
// Invocation forms:
//   index show                     — print root registry (human-readable summary)
//   index show <project>           — print project's service index (human-readable)
//   index show [<project>] --json  — emit the raw index object as JSON
//
// The project read MUST use the memory-only path (readProjectIndex default persist=false)
// so that a stale-on-read index is rebuilt in memory without dirtying the tracked tree.
// (This is FR5 / Story 2.4's memory-only rule.)
//
// Unknown project name → non-zero exit + clean stderr message.
// No dispatcher change required — cli.mjs resolves `index show` to this module via
// the existing `lib/${namespace}-lifecycle/${verb}.mjs` convention.
//
// Zero npm dependencies — node:fs + node:path only (plus relative lib/ imports).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  readRootIndex,
  readProjectIndex,
} from '../scope-index/index.mjs';
import { SidekicksError, EXIT_OK, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';

// ---------------------------------------------------------------------------
// Human-readable formatters
// ---------------------------------------------------------------------------

/**
 * Format a root index as a human-readable summary string.
 *
 * @param {import('../scope-index/index.mjs').RootIndex} rootIndex
 * @returns {string}
 */
function formatRootIndex(rootIndex) {
  const lines = [];
  lines.push(`Root Index (schema_version: ${rootIndex.schema_version})`);
  lines.push(`Generated: ${rootIndex.generated_at}`);
  lines.push('');

  // Active scope block.
  const active = rootIndex.active;
  lines.push('Active scope:');
  lines.push(`  project:        ${active.project}`);
  lines.push(`  service:        ${active.service ?? '(none)'}`);
  lines.push(`  working_folder: ${active.working_folder}`);
  lines.push('');

  // Projects block.
  const projectEntries = Object.entries(rootIndex.projects);
  lines.push(`Projects (${projectEntries.length}):`);
  for (const [name, entry] of projectEntries) {
    const marker = entry.kind === 'root' ? ' [root]' : '';
    lines.push(`  ${name}${marker}`);
    lines.push(`    path: ${entry.path}`);
    if (entry.kind === 'user') {
      lines.push(`    remote_source: ${entry.remote_source ?? '(none)'}`);
      lines.push(`    index: ${entry.index}`);
    }
  }
  lines.push('');

  // Skills block.
  const skills = rootIndex.skills ?? [];
  lines.push(`Skills (${skills.length}):`);
  if (skills.length === 0) {
    lines.push('  (none)');
  } else {
    for (const skill of skills) {
      lines.push(`  ${skill}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a project index as a human-readable summary string.
 *
 * @param {import('../scope-index/index.mjs').ProjectIndex} projectIndex
 * @returns {string}
 */
function formatProjectIndex(projectIndex) {
  const lines = [];
  lines.push(`Project Index: ${projectIndex.project} (schema_version: ${projectIndex.schema_version})`);
  lines.push(`Generated: ${projectIndex.generated_at}`);
  lines.push(`Built at commit: ${projectIndex.built_at_commit ?? '(none)'}`);
  lines.push('');

  const serviceEntries = Object.entries(projectIndex.services ?? {});
  lines.push(`Services (${serviceEntries.length}):`);
  if (serviceEntries.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [name, entry] of serviceEntries) {
      lines.push(`  ${name} [${entry.state}]`);
      lines.push(`    path:           ${entry.path}`);
      lines.push(`    working_folder: ${entry.working_folder}`);
      lines.push(`    service_yaml:   ${entry.service_yaml}`);
      lines.push(`    remote_source:  ${entry.remote_source ?? '(none)'}`);
      lines.push(`    branch:         ${entry.branch ?? '(none)'}`);
      lines.push(`    commit:         ${entry.commit ?? '(none)'}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main verb handler
// ---------------------------------------------------------------------------

/**
 * Run `index show [<project>] [--json]`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name?: string, rest: string[], flags: object }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} if a named project does not exist (EXIT_NOT_FOUND).
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const project = args.name ?? null;
  const jsonFlag = args.flags?.json ?? false;

  if (project !== null && project !== undefined) {
    // `index show <project>` — show that project's service index.
    const projectDir = join(repoRoot, 'projects', project);
    if (!existsSync(projectDir)) {
      throw new SidekicksError(
        `index show: unknown project '${project}' — no directory at projects/${project}`,
        EXIT_NOT_FOUND
      );
    }

    // Memory-only read — persist defaults to false in readProjectIndex.
    // A stale index is rebuilt in memory; the tracked file is never written.
    // This preserves the clean-tree invariant required by Story 2.4 / FR5.
    const projectIndex = readProjectIndex(repoRoot, project);

    const stdout = jsonFlag
      ? JSON.stringify(projectIndex, null, 2) + '\n'
      : formatProjectIndex(projectIndex) + '\n';

    return { stdout, exitCode: EXIT_OK };
  }

  // Bare `index show` — show the root registry.
  const rootIndex = readRootIndex(repoRoot);

  const stdout = jsonFlag
    ? JSON.stringify(rootIndex, null, 2) + '\n'
    : formatRootIndex(rootIndex) + '\n';

  return { stdout, exitCode: EXIT_OK };
}
