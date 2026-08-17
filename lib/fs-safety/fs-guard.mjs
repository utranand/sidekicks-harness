// lib/fs-safety/fs-guard.mjs
// Write-surface guard — centralized path enforcement.
// Only three write surfaces are permitted:
//   repoRoot/projects/<kebab-name>/   (project trees)
//   repoRoot/.sidekicks/              (framework settings, state, memory, parked skills)
//   repoRoot/.agents/skills/          (the canonical skills tree — Rule 3)
// Everything else is blocked before reaching the filesystem.
//
// The third surface is `.agents/skills` and NOT `.agents`: the skills tree moved out of
// `.sidekicks/` when `.agents/skills/` became canonical, but the rest of `.agents/` — the per-CLI
// plugin ports — stays ordinary agent territory that the CLI has no business writing.
//
// Git-internal artifacts under projects/<active>/.git/ are produced by
// delegated `git` commands and therefore bypass this guard by virtue of
// being git's writes, not CLI writes.
//
// Zero npm dependencies — node:path only.

import { relative, sep, join } from 'node:path';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { SKILLS_ROOT_SEGMENTS, SKILLS_ROOT_REL } from '../sk-cli/skill-trees.mjs';

/**
 * Assert that `absPath` is within the CLI's permitted write surface.
 *
 * Permitted prefixes:
 *   - <repoRoot>/projects/<name>/ (must be inside a named project subdirectory)
 *   - <repoRoot>/.sidekicks/      (the framework settings directory)
 *   - <repoRoot>/.agents/skills/  (the canonical skills tree)
 *
 * Uses `path.relative` to detect `..`-traversal escapes.
 *
 * @param {string} absPath   - Absolute path being written.
 * @param {string} repoRoot  - Absolute path to the repository root.
 * @throws {SidekicksError(EXIT_VALIDATION)} if the path is outside the write surface.
 */
export function assertWritable(absPath, repoRoot) {
  // Check projects/ surface: must be under projects/<name>/
  const relProjects = relative(join(repoRoot, 'projects'), absPath);
  const firstSegment = relProjects.split(sep)[0];
  const projectsAllowed = !relProjects.startsWith('..') && firstSegment !== '' && firstSegment !== '.';

  if (projectsAllowed) return;

  // Check .sidekicks/ surface.
  const relSidekicks = relative(join(repoRoot, '.sidekicks'), absPath);
  const sidekicksAllowed = !relSidekicks.startsWith('..');

  if (sidekicksAllowed) return;

  // Check the canonical skills tree. Deliberately joined as two segments so `.agents/plugins/` and
  // anything else under `.agents/` stays outside the surface.
  const relSkills = relative(join(repoRoot, ...SKILLS_ROOT_SEGMENTS), absPath);
  if (!relSkills.startsWith('..')) return;

  throw new SidekicksError(
    "path '" + absPath + "' is outside the CLI write surface "
    + "(allowed: projects/<name>/, .sidekicks/ or " + SKILLS_ROOT_REL + "/)",
    EXIT_VALIDATION
  );
}
