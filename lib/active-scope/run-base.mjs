// lib/active-scope/run-base.mjs
// resolveRunBase — the ONE place the v2 run-folder join lives (runs layout v2).
//
// v2 contract (work-item-first, per-project bases):
//   RUNSROOT = <projectPath>/artifacts/runs          (repo root when root scope is active)
//   RUNBASE  = RUNSROOT/<work-item>/<facet>/         skill contributes a facet to a work item
//            = RUNSROOT/<work-item>/                 --bare: the run IS the work item (engines)
//            = RUNSROOT/_adhoc/<skill-id>/           no work item (full id kept for greppability)
//
// The base is ALWAYS the project base (never the service root): service-scope runs fold into
// the project's runs tree, and the service association travels in metadata (`service` field of
// this result / `service=` on `artifacts register`), never in the path.
//
// Facet derivation: the skill id minus its first-party prefix; the whole `sk-bmad-*` family shares
// the single facet `bmad` so one work item's planning pipeline stays in one tree.
// Pre-v2 runs stay frozen at `<artifacts-base>/artifacts/runs/<skill-id>/` — read targets only.
//
// Pure path computation — no FS writes, no mkdir. Zero npm dependencies.

import { join } from 'node:path';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { BMAD_FAMILY_ID, stripSkillPrefix } from '../sk-cli/skill-trees.mjs';
import { resolveWorkingFolder } from './scope.mjs';

// Slug charset shared by skill ids and work-item slugs: portable on every FS, no separators.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Reserved first segment for runs without a work item.
export const ADHOC_SEGMENT = '_adhoc';

/**
 * Derive a skill's facet name — the folder it contributes under a work item.
 *
 * @param {string} skillId - full skill id (the skill's directory name).
 * @returns {string} `bmad` for the sk-bmad-* family, else the id minus the first-party prefix.
 */
export function deriveFacet(skillId) {
  if (skillId === BMAD_FAMILY_ID || skillId.startsWith(`${BMAD_FAMILY_ID}-`)) return 'bmad';
  return stripSkillPrefix(skillId);
}

/**
 * Resolve the v2 run base for a skill in the active scope.
 *
 * @param {object} settings - Parsed .sidekicks/settings.json (may be {}).
 * @param {string} repoRoot - Absolute repository root.
 * @param {{ skillId: string, workItem?: string | null, bare?: boolean }} opts
 *   - skillId: full skill id; validated against the slug charset.
 *   - workItem: work-item slug (card key, mission/plan/queue slug). null/absent → _adhoc.
 *   - bare: the run IS the work item — no facet layer (engines: get-things-done,
 *     get-plan-done, skill-auditor, auto-improve). Requires workItem.
 * @returns {{
 *   runBase: string, runsRoot: string, facet: string, workItem: string | null,
 *   projectName: string, serviceName: string | null, adhoc: boolean
 * }}
 * @throws {SidekicksError(EXIT_VALIDATION)} on a bad skill id / work-item slug, or --bare
 *   without a work item.
 * @throws {SidekicksError(EXIT_NOT_FOUND)} propagated when an active service dir is missing.
 */
export function resolveRunBase(settings, repoRoot, { skillId, workItem = null, bare = false }) {
  if (!skillId || !SLUG_RE.test(skillId)) {
    throw new SidekicksError(
      `run-base: invalid skill id '${skillId ?? ''}' — [A-Za-z0-9._-], no separators`,
      EXIT_VALIDATION
    );
  }
  if (workItem != null) {
    if (!SLUG_RE.test(workItem) || workItem === ADHOC_SEGMENT) {
      throw new SidekicksError(
        `run-base: invalid work-item slug '${workItem}' — [A-Za-z0-9._-], no separators, not '${ADHOC_SEGMENT}'`,
        EXIT_VALIDATION
      );
    }
  }
  if (bare && workItem == null) {
    throw new SidekicksError(
      'run-base: --bare requires a work-item slug (the run IS the work item)',
      EXIT_VALIDATION
    );
  }

  // Per-project base: projectPath, never the service root (service rides in metadata).
  const { projectName, projectPath, serviceName } = resolveWorkingFolder(settings, repoRoot);
  const runsRoot = join(projectPath, 'artifacts', 'runs');

  const facet = deriveFacet(skillId);
  let runBase;
  let adhoc = false;
  if (workItem == null) {
    // Ad-hoc keeps the FULL id, so a grep for the skill name still finds its runs.
    runBase = join(runsRoot, ADHOC_SEGMENT, skillId);
    adhoc = true;
  } else if (bare) {
    runBase = join(runsRoot, workItem);
  } else {
    runBase = join(runsRoot, workItem, facet);
  }

  return { runBase, runsRoot, facet, workItem, projectName, serviceName, adhoc };
}
