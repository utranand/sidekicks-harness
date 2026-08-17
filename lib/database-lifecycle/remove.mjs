// lib/database-lifecycle/remove.mjs
// Implements `sidekicks database remove <name> [<version>] [--purge] [--keep-files] [--force]`.
//
// Deregisters a databases[] entry from the manifest (keep files by default).
// Opt-in deletion via --purge or a TTY prompt (yes answer).
// rebuildRootIndex is called on every code path that mutates the manifest.
//
// promptConfirm is defined locally (copied from lib/project-lifecycle/remove.mjs) —
// NOT imported from any other lifecycle module (AC 14).
//
// Zero npm dependencies — node:path, node:readline + relative lib/ imports.

import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { assertUserProjectScope } from './scope-guard.mjs';
import {
  read as readManifest,
  removeDatabase,
} from '../manifest-schema/manifest.mjs';
import { rebuildRootIndex } from '../scope-index/index.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { rmrf } from '../fs-safety/fsx.mjs';
import { SidekicksError, EXIT_OK, EXIT_VALIDATION } from '../sk-cli/errors.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Prompt for confirmation on a TTY stdin.
 * Returns true only if the user types 'y' or 'Y'.
 *
 * Copied verbatim from lib/project-lifecycle/remove.mjs — NOT imported (AC 14).
 *
 * @param {string} question  - The prompt text (written to stderr).
 * @param {NodeJS.ReadableStream} [inputStream] - Override stdin (for unit testing).
 * @returns {Promise<boolean>}
 */
async function promptConfirm(question, inputStream = process.stdin) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const rl = createInterface({
      input: inputStream,
      output: process.stderr,
      terminal: false,
    });

    process.stderr.write(question);

    rl.once('line', (line) => {
      // Settle BEFORE rl.close() — rl.close() fires 'close' synchronously,
      // which would otherwise call settle(false) before we can settle(true).
      const answer = (line || '').trim();
      settle(answer === 'y' || answer === 'Y');
      rl.close();
    });

    rl.once('close', () => {
      // stdin closed without a line (EOF) — treat as 'no'.
      settle(false);
    });
  });
}

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(args) {
  if (!Array.isArray(args)) {
    // Dispatcher structured form: { name, rest, flags }
    const name = args && args.name != null ? String(args.name) : '';
    const rest = Array.isArray(args.rest) ? args.rest : [];
    const flags = args && args.flags ? args.flags : {};

    // Version is the first non-flag positional in rest
    const version = rest.find((t) => !t.startsWith('--')) || null;

    let purge = Boolean(flags.purge);
    let keepFiles = Boolean(flags['keep-files'] || flags.keepFiles);
    let force = Boolean(flags.force);

    // Also scan rest for flags
    for (const tok of rest) {
      if (tok === '--purge') purge = true;
      if (tok === '--keep-files') keepFiles = true;
      if (tok === '--force') force = true;
    }

    return { name, version, purge, keepFiles, force };
  }

  // Raw array form
  let name = '';
  let version = null;
  let purge = false;
  let keepFiles = false;
  let force = false;

  for (const tok of args) {
    if (tok === '--purge') { purge = true; continue; }
    if (tok === '--keep-files') { keepFiles = true; continue; }
    if (tok === '--force') { force = true; continue; }
    if (tok.startsWith('--')) continue;
    if (!name) { name = tok; continue; }
    if (!version) { version = tok; continue; }
  }

  return { name, version, purge, keepFiles, force };
}

// ── Main verb ─────────────────────────────────────────────────────────────────

/**
 * Execute the `database remove <name> [<version>] [--purge] [--keep-files] [--force]` verb.
 *
 * @param {{ repoRoot: string, _stdin?: object }} ctx
 * @param {object|string[]} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on scope rejection or validation failure.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  // ── Scope resolution ────────────────────────────────────────────────────────
  const settings = readSettings(repoRoot);
  const scope = resolveEffectiveScope(settings);

  // ── Precondition 1: reject root scope (AC 15) ──────────────────────────────
  assertUserProjectScope(scope);

  const { name, version: versionArg, purge, keepFiles } = parseArgs(args);

  if (!name) {
    throw new SidekicksError(
      'usage: sidekicks database remove <name> [<version>] [--purge] [--keep-files]',
      EXIT_VALIDATION
    );
  }

  // ── Read manifest ────────────────────────────────────────────────────────────
  const manifestPath = join(repoRoot, 'projects', scope.projectName, 'manifest.yaml');
  const manifest = readManifest(manifestPath);
  const databases = Array.isArray(manifest.databases) ? manifest.databases : [];

  // ── Resolve (name, version) ───────────────────────────────────────────────────
  const byName = databases.filter((e) => e.name === name);

  let resolvedVersion = versionArg;
  let entryFound = false;

  if (!versionArg) {
    if (byName.length === 0) {
      // No manifest entry — might still have on-disk dir for orphan purge
      // resolvedVersion remains null; handled below
    } else if (byName.length === 1) {
      resolvedVersion = byName[0].version;
      entryFound = true;
    } else {
      // Multiple entries — version required (AC 7)
      const versionList = byName.map((e) => e.version).join(', ');
      throw new SidekicksError(
        `multiple versions of \`${name}\` registered (${versionList}); specify a version: sidekicks database remove ${name} <version>`,
        EXIT_VALIDATION
      );
    }
  } else {
    entryFound = byName.some((e) => e.version === versionArg);
    if (!entryFound && byName.length > 0) {
      // Name exists but version not found
      throw new SidekicksError(
        `no entry for \`${name}\` at version \`${versionArg}\` in project \`${scope.projectName}\``,
        EXIT_VALIDATION
      );
    }
    // If byName.length === 0, no entry exists — orphan purge path
  }

  // If still no resolvedVersion (name not in manifest at all, no versionArg)
  // and not purging an orphan by a specific version, we can't determine destDir.
  if (!resolvedVersion) {
    throw new SidekicksError(
      `no database named \`${name}\` is registered in project \`${scope.projectName}\``,
      EXIT_VALIDATION
    );
  }

  // ── Compute destination dir ────────────────────────────────────────────────
  const dbDirName = `${name}-${resolvedVersion}`;
  const destDir = join(repoRoot, 'projects', scope.projectName, 'databases', dbDirName);

  // ── Orphan purge path (AC 13) ─────────────────────────────────────────────
  // If the entry is not in the manifest but --purge is set and the dir exists,
  // just delete the dir — no manifest mutation, no index rebuild.
  if (!entryFound && purge) {
    if (existsSync(destDir)) {
      assertWritable(destDir, repoRoot);
      rmrf(destDir);
      return {
        stdout: `Removed \`databases/${dbDirName}/\` (orphaned directory purged).\n`,
        exitCode: EXIT_OK,
      };
    } else {
      return {
        stdout: `databases/${dbDirName}/ does not exist; nothing to purge.\n`,
        exitCode: EXIT_OK,
      };
    }
  }

  // If entry not found and no purge flag, nothing to do
  if (!entryFound) {
    return {
      stdout: `No manifest entry for \`${name}\` at version \`${resolvedVersion}\`; nothing to deregister.\n`,
      exitCode: EXIT_OK,
    };
  }

  // ── Deregister from manifest (AC 6) ──────────────────────────────────────────
  removeDatabase(manifestPath, name, resolvedVersion);

  // ── Rebuild root index — every manifest-mutating path (AC 12) ────────────────
  rebuildRootIndex(repoRoot);

  // ── Deletion decision tree ────────────────────────────────────────────────────
  const stdinStream = ctx._stdin || process.stdin;
  let stdout = '';

  if (purge) {
    // --purge: delete whole directory without prompting (AC 9)
    assertWritable(destDir, repoRoot);
    rmrf(destDir);
    stdout = `Deregistered \`${name}@${resolvedVersion}\`. Removed \`databases/${dbDirName}/\`.\n`;
  } else if (keepFiles) {
    // --keep-files: skip prompt, keep directory (AC 10)
    stdout = `Deregistered \`${name}@${resolvedVersion}\`. Files remain at \`databases/${dbDirName}/\`.\n`;
  } else if (stdinStream.isTTY) {
    // TTY: prompt user (AC 8)
    const confirmed = await promptConfirm(
      `Also delete the dump directory at databases/${dbDirName}/? [y/N] `,
      stdinStream
    );
    if (confirmed && existsSync(destDir)) {
      assertWritable(destDir, repoRoot);
      rmrf(destDir);
      stdout = `Deregistered \`${name}@${resolvedVersion}\`. Removed \`databases/${dbDirName}/\`.\n`;
    } else {
      stdout = `Deregistered \`${name}@${resolvedVersion}\`. Files remain at \`databases/${dbDirName}/\`.\n`;
    }
  } else {
    // Non-TTY, no flags: keep files and print hint (AC 11)
    stdout = `Deregistered \`${name}@${resolvedVersion}\`. Files remain at \`databases/${dbDirName}/\`; run \`database remove ${name} ${resolvedVersion} --purge\` to delete them later.\n`;
  }

  return { stdout, exitCode: EXIT_OK };
}
