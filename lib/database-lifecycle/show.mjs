// lib/database-lifecycle/show.mjs
// Implements `sidekicks database show <name> [<version>]`.
//
// Resolves (name, version) from the active project manifest.
// Prints full metadata + resolved absolute path and tree.
// No writes — read-only verb.
//
// Zero npm dependencies — node:path + relative lib/ imports.

import { join } from 'node:path';

import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { assertUserProjectScope } from './scope-guard.mjs';
import { read as readManifest } from '../manifest-schema/manifest.mjs';
import { SidekicksError, EXIT_OK, EXIT_VALIDATION } from '../sk-cli/errors.mjs';

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(args) {
  if (!Array.isArray(args)) {
    // Dispatcher structured form: { name, rest, flags }
    const name = args && args.name != null ? String(args.name) : '';
    const rest = Array.isArray(args.rest) ? args.rest : [];
    // Version is the first non-flag positional in rest
    const version = rest.find((t) => !t.startsWith('--')) || null;
    return { name, version };
  }

  // Raw array form
  let name = '';
  let version = null;
  for (const tok of args) {
    if (tok.startsWith('--')) continue;
    if (!name) { name = tok; continue; }
    if (!version) { version = tok; continue; }
  }
  return { name, version };
}

// ── Main verb ─────────────────────────────────────────────────────────────────

/**
 * Execute the `database show <name> [<version>]` verb.
 *
 * @param {{ repoRoot: string }} ctx
 * @param {object|string[]} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on scope rejection or lookup failure.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  // ── Scope resolution ────────────────────────────────────────────────────────
  const settings = readSettings(repoRoot);
  const scope = resolveEffectiveScope(settings);

  // ── Precondition 1: reject root scope (AC 15) ──────────────────────────────
  assertUserProjectScope(scope);

  const { name, version: versionArg } = parseArgs(args);

  if (!name) {
    throw new SidekicksError(
      'usage: sidekicks database show <name> [<version>]',
      EXIT_VALIDATION
    );
  }

  // ── Read manifest ────────────────────────────────────────────────────────────
  const manifestPath = join(repoRoot, 'projects', scope.projectName, 'manifest.yaml');
  const manifest = readManifest(manifestPath);
  const databases = Array.isArray(manifest.databases) ? manifest.databases : [];

  // ── Resolve (name, version) (AC 4, 5) ────────────────────────────────────────
  const byName = databases.filter((e) => e.name === name);

  if (byName.length === 0) {
    throw new SidekicksError(
      `no database named \`${name}\` is registered in project \`${scope.projectName}\``,
      EXIT_VALIDATION
    );
  }

  let entry;

  if (versionArg) {
    entry = byName.find((e) => e.version === versionArg);
    if (!entry) {
      throw new SidekicksError(
        `no entry for \`${name}\` at version \`${versionArg}\` in project \`${scope.projectName}\``,
        EXIT_VALIDATION
      );
    }
  } else {
    if (byName.length === 1) {
      entry = byName[0];
    } else {
      // Multiple versions — version required
      const versionList = byName.map((e) => e.version).join(', ');
      throw new SidekicksError(
        `multiple versions of \`${name}\` registered (${versionList}); specify a version: sidekicks database show ${name} <version>`,
        EXIT_VALIDATION
      );
    }
  }

  // ── Resolve absolute paths (AC 4, 19) ────────────────────────────────────────
  const absolutePath = join(repoRoot, 'projects', scope.projectName, entry.path);
  const absoluteTree = join(repoRoot, 'projects', scope.projectName, entry.tree);

  // ── Build output ─────────────────────────────────────────────────────────────
  let stdout = `database: ${entry.name}  version: ${entry.version}\n`;
  stdout += `  source      : ${entry.source}\n`;
  stdout += `  captured_at : ${entry.captured_at}\n`;
  stdout += `  checksum    : ${entry.checksum}\n`;
  if (entry.schemas != null) {
    stdout += `  schemas     : ${entry.schemas}\n`;
  }
  if (entry.table_count != null) {
    stdout += `  table_count : ${entry.table_count}\n`;
  }
  stdout += `  path (abs)  : ${absolutePath}\n`;
  stdout += `  tree (abs)  : ${absoluteTree}\n`;

  return { stdout, exitCode: EXIT_OK };
}
