// lib/settings-store/settings.mjs
// Workspace settings.json read/write.
// Reads .sidekicks/settings.json via JSON.parse (NOT the yaml-subset parser).
// Unknown top-level keys are PRESERVED across RMW (forward-compat).
// Zero npm dependencies — node:fs, node:path only.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';

const SETTINGS_REL = '.sidekicks/settings.json';

/**
 * Read .sidekicks/settings.json from repoRoot.
 * Returns {} if the file is absent (never an error for missing file).
 * Throws SidekicksError(EXIT_VALIDATION) if the file is present but unparseable or
 * its top-level value is not a plain object.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @returns {object} - The parsed settings object (may be {}).
 * @throws {SidekicksError} on corrupt JSON or non-object top-level.
 */
export function read(repoRoot) {
  const settingsPath = join(repoRoot, SETTINGS_REL);
  if (!existsSync(settingsPath)) {
    return {};
  }
  let text;
  try {
    text = readFileSync(settingsPath, 'utf8');
  } catch (err) {
    throw new SidekicksError(
      `settings: failed to read '${settingsPath}': ${err.message}`,
      EXIT_VALIDATION
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SidekicksError(
      `settings: '${settingsPath}' contains invalid JSON: ${err.message}`,
      EXIT_VALIDATION
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SidekicksError(
      `settings: '${settingsPath}' top-level value must be a plain object`,
      EXIT_VALIDATION
    );
  }
  return parsed;
}

/**
 * Atomically set active_project and null out active_service.
 * Preserves all other top-level keys (RMW — forward-compat).
 * Creates the file (and .sidekicks/ dir) if absent.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string} name     - Project name to activate (use "sidekicks" for root).
 */
export function setActiveProject(repoRoot, name) {
  const settingsPath = join(repoRoot, SETTINGS_REL);
  const current = read(repoRoot);
  const updated = { ...current, active_project: name, active_service: null };
  assertWritable(settingsPath, repoRoot);
  writeAtomic(settingsPath, JSON.stringify(updated, null, 2) + '\n');
}

/**
 * Atomically set active_service.
 * Preserves active_project and all other top-level keys (RMW — forward-compat).
 * Creates the file (and .sidekicks/ dir) if absent.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string|null} name - Service name to activate, or null to clear.
 */
export function setActiveService(repoRoot, name) {
  const settingsPath = join(repoRoot, SETTINGS_REL);
  const current = read(repoRoot);
  const updated = { ...current, active_service: name };
  assertWritable(settingsPath, repoRoot);
  writeAtomic(settingsPath, JSON.stringify(updated, null, 2) + '\n');
}
