// lib/framework-settings/floor.mjs
// The consent-gated safety floor — framework rule/hook ids that cannot be persistently disabled.
//
// WHY THIS IS CODE AND NOT DATA: lib/fs-safety/fs-guard.mjs assertWritable permits any
// path under .sidekicks/, so it is a write-SURFACE guard, not per-file protection. A
// `locked: true` key inside a committed YAML file therefore protects nothing — anyone
// (agent or human) can flip it. The floor is a frozen constant here, consulted before any
// settings file is read, so no data file can contradict it. A user can still waive one
// floor rule for one precisely disclosed action under AGENTS.md's explicit per-action waiver
// contract; that conversational consent is deliberately not persisted here. There is no
// `locked:` key in any data file: two sources of truth with undefined precedence is the
// bug this design avoids.
//
// Every id below is a default hard stop taken from .sidekicks/RULES.md (the six boundary
// rules) or from AGENTS.md's hard-rule language. Adding or removing an id is a safety change
// that needs explicit human review; a one-action waiver never mutates this set.
//
// Zero npm dependencies, zero imports — a leaf module.

/**
 * Ids that always resolve enabled. `framework disable <id>` refuses persistent disablement,
 * and their presence in any settings layer is a validation error (never a silent no-op).
 *
 * @type {ReadonlySet<string>}
 */
export const LOCKED_IDS = Object.freeze(new Set([
  // The six boundary rules (.sidekicks/RULES.md, inlined verbatim in AGENTS.md).
  'rule.boundary-cli-write-surface',        // Rule 1
  'rule.boundary-agent-write-surface',      // Rule 2
  'rule.boundary-skills-location',          // Rule 3
  'rule.boundary-db-write-safety',          // Rule 4
  'rule.boundary-empirical-verification',   // Rule 5
  'rule.boundary-multi-cli-parity',         // Rule 6

  // Production access routing: direct is allowed, Teleport is the fallback when the
  // direct route is unreachable, and every run must state which path it took. The id is
  // unchanged from when this rule read "Teleport skills only" (superseded 2026-08-17,
  // operator-directed) so existing settings files and memory entries keep resolving.
  // sk-cluster-ops' companion "hard-stops on prod — never override" floor entry was
  // retired in the same change: that skill now reaches prod directly.
  'rule.teleport-prod-access',

  // Never run a real logged-in Google account headless (headless = bot flag on the user).
  'rule.headful-google-automation',

  // No implementation work committed directly on main/sit/uat/staging/prod/release-*.
  'rule.protected-branches',

  // Confirm-before-acting on irreversible/outward-facing actions. The run-reporting
  // carve-out that QUALIFIES this stop is part of the same rule and stays with it.
  'rule.irreversible-outward-confirm',

  // Project/work memory never leaves for a per-CLI global store.
  'rule.local-only-project-memory',

  // No machine-absolute path may be persisted into any artifact.
  'rule.portable-artifact-paths',

  // Secret-bearing manifests never committed under artifacts/.
  'rule.secrets-never-under-artifacts',

  // `git worktree remove --force` only after the user OKs unmerged loss.
  'rule.worktree-force-consent',

  // sk-skill-auditor autonomous mode parks anything that softens a
  // safety/permission rule for a human.
  'rule.auditor-autonomous-safety-floor',

  // Hooks that ENFORCE a floor rule. Gating these off would silently remove the
  // enforcement while the rule text still claims it is enforced.
  'hook.enforce-local-memory',
  'hook.enforce-flow-headful',
]));

/** Machine-readable form of AGENTS.md's one-action waiver contract. */
export const FLOOR_WAIVER = Object.freeze({
  mode: 'explicit-per-action',
  persistent: false,
  requires: Object.freeze([
    'rule',
    'action-and-target',
    'skipped-protection-and-risk',
    'recovery-or-containment',
    'explicit-user-approval',
  ]),
});

/**
 * @param {string} id
 * @returns {boolean} true when `id` is in the safety floor.
 */
export function isFloor(id) {
  return LOCKED_IDS.has(id);
}

/**
 * The single message used everywhere a floor id is refused, so the CLI, the resolver and
 * the doctor all explain it identically.
 *
 * @param {string} id
 * @returns {string}
 */
export function floorReason(id) {
  return `'${id}' is part of the consent-gated framework safety floor and cannot be `
    + 'persistently disabled through settings. One precisely scoped action may proceed only after '
    + 'the agent discloses its target, skipped protection, risk and recovery plan and the user '
    + 'explicitly approves it (AGENTS.md: Explicit per-action waiver)';
}
