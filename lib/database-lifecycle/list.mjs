// lib/database-lifecycle/list.mjs
// Implements `sidekicks database list [--json]`.
//
// Reads databases[] from the active project manifest.
// Flags orphaned on-disk databases/<name-ver>/ directories.
// No writes — read-only verb.
//
// Zero npm dependencies — node:fs, node:path + relative lib/ imports.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { assertUserProjectScope } from './scope-guard.mjs';
import { read as readManifest } from '../manifest-schema/manifest.mjs';
import { EXIT_OK } from '../sk-cli/errors.mjs';

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(args) {
  if (!Array.isArray(args)) {
    const flags = args && args.flags ? args.flags : {};
    return { json: Boolean(flags.json) };
  }
  return { json: args.includes('--json') };
}

// ── Table formatting ──────────────────────────────────────────────────────────

/**
 * Format a simple padded text table from an array of row objects.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
function formatTable(headers, rows) {
  if (rows.length === 0) return '';

  // Compute column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] || '').length))
  );

  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const header = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  const lines = rows.map((r) => r.map((c, i) => (c || '').padEnd(widths[i])).join('  '));

  return [header, sep, ...lines].join('\n') + '\n';
}

// ── Main verb ─────────────────────────────────────────────────────────────────

/**
 * Execute the `database list [--json]` verb.
 *
 * @param {{ repoRoot: string }} ctx
 * @param {object|string[]} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on scope rejection.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  // ── Scope resolution ────────────────────────────────────────────────────────
  const settings = readSettings(repoRoot);
  const scope = resolveEffectiveScope(settings);

  // ── Precondition 1: reject root scope (AC 15) ──────────────────────────────
  assertUserProjectScope(scope);

  const { json } = parseArgs(args);

  // ── Read manifest ────────────────────────────────────────────────────────────
  const manifestPath = join(repoRoot, 'projects', scope.projectName, 'manifest.yaml');
  const manifest = readManifest(manifestPath);
  const databases = Array.isArray(manifest.databases) ? manifest.databases : [];

  // ── Orphan detection (AC 3) ──────────────────────────────────────────────────
  const databasesDir = join(repoRoot, 'projects', scope.projectName, 'databases');
  const registeredKeys = new Set(databases.map((e) => `${e.name}-${e.version}`));

  let orphanNames = [];
  if (existsSync(databasesDir)) {
    let entries;
    try {
      entries = readdirSync(databasesDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      // Only flag subdirectories
      try {
        const s = statSync(join(databasesDir, entry));
        if (s.isDirectory() && !registeredKeys.has(entry)) {
          orphanNames.push(entry);
        }
      } catch { /* ignore stat errors */ }
    }
  }

  // ── JSON output (AC 2) ───────────────────────────────────────────────────────
  if (json) {
    const orphans = orphanNames.map((name) => ({
      name,
      orphaned: true,
      note: 'orphaned — files kept',
    }));
    const stdout = JSON.stringify({ databases, orphans }, null, 2) + '\n';
    return { stdout, exitCode: EXIT_OK };
  }

  // ── Text table output (AC 1) ─────────────────────────────────────────────────
  if (databases.length === 0 && orphanNames.length === 0) {
    return {
      stdout: `No databases registered for project \`${scope.projectName}\`.\n`,
      exitCode: EXIT_OK,
    };
  }

  const headers = ['name', 'version', 'source', 'captured_at', 'table_count'];
  const rows = databases.map((e) => [
    e.name || '',
    e.version || '',
    e.source || '',
    e.captured_at || '',
    e.table_count != null ? String(e.table_count) : '',
  ]);

  // Append orphan rows
  for (const orphanName of orphanNames) {
    rows.push([orphanName, '(orphaned — files kept)', '', '', '']);
  }

  const stdout = formatTable(headers, rows);
  return { stdout, exitCode: EXIT_OK };
}
