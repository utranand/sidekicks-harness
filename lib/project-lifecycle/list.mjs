// lib/project-lifecycle/list.mjs
// `project list` verb implementation.
// Prints all projects under projects/ with the active one marked.
// Zero npm dependencies — node:fs, node:path only (plus relative lib/ imports).

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDirLikeDirent } from '../fs-safety/fsx.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';

/**
 * `project list` verb handler.
 *
 * Reads projects/ directory, parses each manifest.yaml, and builds a sorted listing.
 * Active project is prefixed with "* "; others with "  ".
 * Root project line is always last.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: Function }} ctx
 * @param {object} _args - unused (project list takes no arguments)
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on corrupt .sidekicks/settings.json (EXIT_VALIDATION).
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;

  // Read settings and resolve active project.
  // settings.read throws SidekicksError(EXIT_VALIDATION) on corrupt JSON — propagate as-is.
  const settingsObj = readSettings(repoRoot);
  const activeProject = settingsObj.active_project ?? null;
  // Effective active is "sidekicks" (root) when unset, null, or the literal "sidekicks".
  const effectiveActive = (activeProject === null || activeProject === 'sidekicks')
    ? 'sidekicks'
    : activeProject;

  // Scan projects/ directory (single readdir).
  const projectsDir = join(repoRoot, 'projects');
  let dirents = [];
  if (existsSync(projectsDir)) {
    try {
      dirents = readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => isDirLikeDirent(d, projectsDir));
    } catch {
      // If readdir fails treat as empty.
      dirents = [];
    }
  }

  // For each candidate directory, require manifest.yaml to exist.
  // The list command only needs project presence, not manifest contents.
  const validEntries = []; // { name: string }
  const excludedNames = new Set(); // dirs that do not have manifest.yaml

  for (const dirent of dirents) {
    const name = dirent.name;
    const manifestPath = join(projectsDir, name, 'manifest.yaml');
    try {
      if (existsSync(manifestPath)) {
        validEntries.push({ name });
      } else {
        excludedNames.add(name);
      }
    } catch {
      // Missing or unreadable manifest — exclude silently.
      excludedNames.add(name);
    }
  }

  // Sort alphabetically by name.
  validEntries.sort((a, b) => a.name.localeCompare(b.name));

  // Active-but-manifestless edge case.
  // If active_project is set, is not root, and was excluded from the listing, emit warning.
  let activeManifestMissing = false;
  if (
    effectiveActive !== 'sidekicks' &&
    excludedNames.has(effectiveActive)
  ) {
    // Verify it actually exists as a directory (not just an absent name).
    const activeDir = join(projectsDir, effectiveActive);
    if (existsSync(activeDir)) {
      activeManifestMissing = true;
      process.stderr.write(
        `warning: active project '${effectiveActive}' has missing or unparseable manifest.yaml\n`
      );
    }
  }

  // Assemble the listing output.
  const lines = [];

  // Sorted user-project lines.
  for (const entry of validEntries) {
    const isActive = entry.name === effectiveActive;
    const prefix = isActive ? '* ' : '  ';
    lines.push(`${prefix}${entry.name}`);
  }

  // Insert active-but-manifestless entry at the right sorted position (after valid entries
  // that sort before it alphabetically, before those that sort after).
  if (activeManifestMissing) {
    // We need to insert "* <name>  (manifest missing)" in sorted order.
    // The validEntries list is already sorted; find the insertion position.
    let insertIdx = lines.length; // default: end of valid entries
    for (let i = 0; i < validEntries.length; i++) {
      if (effectiveActive.localeCompare(validEntries[i].name) < 0) {
        insertIdx = i;
        break;
      }
    }
    lines.splice(insertIdx, 0, `* ${effectiveActive}  (manifest missing)`);
  }

  // If no valid entries and no active-but-manifestless, emit friendly message.
  if (lines.length === 0) {
    lines.unshift('(no projects yet)');
  }

  // Root line always last.
  const rootActive = effectiveActive === 'sidekicks';
  const rootPrefix = rootActive ? '* ' : '  ';
  lines.push(`${rootPrefix}(root) sidekicks — implicit, default`);

  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}
