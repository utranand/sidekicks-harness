// lib/framework-settings/core-registry.mjs
// The framework-owned half of the rule/hook registry: entries that belong to the framework
// itself and therefore cannot be declared by a skill descriptor.
//
// TWO SOURCES, ONE REGISTRY (see registry.mjs):
//   - here: hooks (their scripts live in scripts/ and .sidekicks/hooks/ — framework
//     territory, not a skill folder) plus the framework-core rules that stay in AGENTS.md.
//   - skill descriptors (.agents/skills/<skill>/skill.yaml): the rules whose bodies were
//     extracted INTO the owning skill, discovered by scanning.
//
// Hook entries live here on purpose, even when a skill "owns" the behaviour: the gate must
// resolve identically whether or not the owning skill is present. hook.enforce-flow-headful
// is the proof case — its owning flow skills are offloaded, the gate stays wired.
//
// `owners` is always a LIST: the Teleport rule has four owning skills, BMAD-first five,
// "Official names" three. A single owner field cannot represent the real inventory.
//
// Zero npm dependencies, no imports beyond the floor constant.

import { LOCKED_IDS } from './floor.mjs';

/**
 * Every hook wired by the per-CLI settings files, keyed by framework id.
 *
 * `script` is repo-relative and is what `framework doctor` cross-checks against the
 * wiring in .claude/settings.json — a wired script with no entry here, or an entry whose
 * script is not wired, is drift and fails the doctor test.
 *
 * @type {ReadonlyArray<{id: string, script: string, title: string, owners: string[]}>}
 */
export const CORE_HOOKS = Object.freeze([
  {
    id: 'hook.skill-advisor',
    script: 'scripts/skill-advisor-hook.mjs',
    title: 'Suggest the fitting skill on Skill tool use',
    owners: [], // advises across all skills — no single owner
  },
  {
    id: 'hook.enforce-local-memory',
    script: 'scripts/enforce-local-memory.mjs',
    title: 'Block project memory writes to the per-CLI global store',
    owners: [],
  },
  {
    id: 'hook.rtk',
    script: '.sidekicks/hooks/rtk-hook.sh',
    title: 'Route Bash commands through the rtk token proxy',
    owners: [],
  },
  {
    id: 'hook.enforce-flow-headful',
    script: 'scripts/enforce-flow-headful.mjs',
    title: 'Refuse headless browser runs on a real Google account',
    owners: [], // owning flow skills are offloaded; the gate stays wired
  },
  {
    id: 'hook.enforce-branch-safety',
    script: 'scripts/enforce-branch-safety.mjs',
    title: 'Refuse git commands that hijack a shared working tree',
    owners: [], // enforces the framework-core protected-branch / worktree rules
  },
  {
    id: 'hook.recompile-validation-checklist',
    script: 'scripts/recompile-validation-checklist.mjs',
    title: 'Recompile the project validation checklist after rule edits',
    owners: ['sk-validation-gate'],
  },
  {
    id: 'hook.artifact-autotrigger',
    script: 'scripts/artifact-autotrigger-hook.mjs',
    title: 'Offer the matching artifact skill on a matching prompt',
    owners: ['sk-artifact-manager', 'sk-implementation-planner'],
  },
  {
    id: 'hook.enhance-prompt',
    script: 'scripts/enhance-prompt-hook.mjs',
    title: 'Sharpen a vague prompt on the ?? opt-in prefix',
    owners: [],
  },
  {
    id: 'hook.fable-escalation',
    script: 'scripts/fable-escalation-hook.mjs',
    title: 'Surface the fable-fleet escalation ladder when a condition fires',
    owners: ['sk-fable-council'],
  },
  {
    id: 'hook.gtd-orphan-watch',
    script: 'scripts/gtd-orphan-watch-hook.mjs',
    title: 'Report live get-things-done queues at session start',
    owners: ['sk-get-things-done'],
  },
  {
    id: 'hook.load-local-memory',
    script: 'scripts/load-local-memory-hook.mjs',
    title: 'Load the scope-resolved local memory store at session start',
    owners: [],
  },
  {
    id: 'hook.memory-trigger',
    script: 'scripts/memory-trigger-hook.mjs',
    title: 'Inject a memory scenario pack on the first action of its category',
    owners: [], // the store is framework-owned; no single skill owns a category
  },
  {
    id: 'hook.run-notify',
    script: 'scripts/run-notify-hook.mjs',
    title: 'Post deterministic run notifications for finished runs',
    owners: ['sk-slack-connector'],
  },
  {
    id: 'hook.office-viz',
    script: 'scripts/office-viz-hook.mjs',
    title: 'Refresh the Agent Office visualization from run artifacts',
    owners: ['sk-office-viz'],
  },
  {
    id: 'hook.artifact-liveness',
    script: 'scripts/artifact-liveness-hook.mjs',
    title: 'Refresh artifact liveness state',
    owners: ['sk-artifact-manager'],
  },
]);

/**
 * Framework-core rules and AGENTS.md criteria that are NOT skill-dependent, so their bodies
 * stay in AGENTS.md. Registered so every rule the agent is asked to follow has an id — the
 * floor ones so `disable` has something to refuse, the rest so they are honestly toggleable.
 *
 * `body_at` is 'AGENTS.md' for everything here: nothing in this list is extracted.
 *
 * `marker` IS THE BODY. Every entry carries one distinctive phrase from its own prose, and that
 * phrase — not the filename — is what proves the rule is still stated. The distinction is the whole
 * point of this field: `body_at` names a FILE, so `existsSync(body_at)` was a check AGENTS.md passed
 * by merely existing, and seven floor rules (Teleport-only prod access, the cluster-ops hard stop,
 * headful Google automation, outward-action confirmation, secret placement, forced-worktree consent,
 * the autonomous-auditor floor) went missing from the forged lightweight runtime while
 * `framework show` still reported `body_exists: true`.
 *
 * A marker must be UNIQUE within the surface it is checked against and must sit on ONE line —
 * AGENTS.md is hard-wrapped, so a phrase spanning a wrap never matches. `framework doctor` and
 * tests/framework-claude-md.test.mjs both read markers from here; that file used to keep its own
 * copy of this map, which is the two-hand-maintained-lists failure mode floor.mjs's header rejects.
 *
 * @type {ReadonlyArray<{id: string, title: string, owners: string[], marker: string}>}
 */
export const CORE_RULES = Object.freeze([
  // ── Floor: the six boundary rules ──────────────────────────────────────────
  { id: 'rule.boundary-cli-write-surface',      title: 'Rule 1 — CLI write surface', owners: [], marker: 'Rule 1 — CLI Write Surface' },
  { id: 'rule.boundary-agent-write-surface',    title: 'Rule 2 — agent free-write surface', owners: [], marker: 'Rule 2 — Agent Free-Write Surface' },
  { id: 'rule.boundary-skills-location',        title: 'Rule 3 — skills canonical location', owners: [], marker: 'Rule 3 — Skills Canonical Location' },
  { id: 'rule.boundary-db-write-safety',        title: 'Rule 4 — database write safety', owners: [], marker: 'Rule 4 — Database Write Safety' },
  { id: 'rule.boundary-empirical-verification', title: 'Rule 5 — empirical verification', owners: [], marker: 'Rule 5 — Empirical Verification' },
  { id: 'rule.boundary-multi-cli-parity',       title: 'Rule 6 — multi-CLI parity', owners: [], marker: 'Rule 6 — Multi-CLI Parity' },

  // ── Floor: hard stops with owning skills, body stays in AGENTS.md ──────────
  {
    id: 'rule.teleport-prod-access',
    title: 'Production access — Teleport skills only',
    owners: [
      'sk-teleport-cluster-ops',
      'sk-teleport-database-connector',
      'sk-cluster-ops',
      'sk-database-connector',
    ],
    marker: 'Production access — Teleport skills only',
  },
  {
    id: 'rule.cluster-ops-prod-hardstop',
    title: 'sk-cluster-ops hard-stops on prod — never override',
    owners: ['sk-cluster-ops'],
    marker: 'hard-stops on prod — never override',
  },
  {
    id: 'rule.headful-google-automation',
    title: 'Google-account browser automation — headful only',
    owners: [],
    marker: 'headful only',
  },
  { id: 'rule.protected-branches',            title: 'Never implement on a protected branch', owners: [], marker: 'Protected branches — never implement on them' },
  { id: 'rule.irreversible-outward-confirm',  title: 'Confirm irreversible / outward-facing actions', owners: [], marker: 'Irreversible / outward-facing actions' },
  { id: 'rule.local-only-project-memory',     title: 'Project memory is local-only', owners: [], marker: 'LOCAL-ONLY' },
  { id: 'rule.portable-artifact-paths',       title: 'Portable artifact paths only', owners: [], marker: 'Portable paths' },
  { id: 'rule.secrets-never-under-artifacts', title: 'Secret-bearing manifests never under artifacts/', owners: [], marker: 'Secret-bearing manifests' },
  { id: 'rule.worktree-force-consent',        title: 'Worktree --force removal needs user consent', owners: [], marker: 'removal only after the user OKs' },
  {
    id: 'rule.auditor-autonomous-safety-floor',
    title: 'Skill-auditor autonomous mode parks safety-softening changes',
    owners: ['sk-skill-auditor'],
    // Not the bare 'parked for a human': that phrase also appears in the skill-owned-rules table's
    // description of the same policy, and a marker matching two rules proves neither.
    marker: 'parked for a human — never auto-applied',
  },

  // ── Non-floor framework core (toggleable, body stays in AGENTS.md) ─────────
  { id: 'rule.scope-anchors',            title: 'Scope alignment and the three anchors', owners: [], marker: 'Three anchors' },
  { id: 'rule.branch-naming',            title: 'Branch naming <type>/<key>-<slug>', owners: [], marker: 'Branch naming:' },
  { id: 'rule.worktree-sibling-layout',  title: 'Worktrees are siblings of the repo', owners: [], marker: 'Layout: always a **sibling**' },
  { id: 'rule.single-venv',              title: 'The single repo-root .venv only', owners: [], marker: 'the single repo-root `.venv` only' },
  { id: 'rule.timezone-bangkok',         title: 'Asia/Bangkok for all timestamps', owners: [], marker: '`Asia/Bangkok` (UTC+07:00) for ALL timestamps' },
  { id: 'rule.cross-platform',           title: 'One implementation running on macOS and Windows', owners: [], marker: 'never an OS fork' },
  { id: 'rule.incident-reports',         title: 'Incident reports committed under the affected scope', owners: [], marker: 'Incident reports — one document under the affected scope' },
  { id: 'rule.local-memory-register',    title: 'Register durable decisions in local memory', owners: [], marker: 'Local memory — register decisions that matter' },
  { id: 'criterion.memory-lazy-load',    title: 'Load the memory category map at session start, bodies on trigger', owners: [], marker: 'Memory loads lazily' },
  { id: 'criterion.session-practices',   title: 'The ten standing session practices', owners: [], marker: 'Session working practices — ten standing defaults' },
  // Owned by sk-skill-manager (AAP-96): that skill IS this checklist's front door, and its
  // CREATE mode walks the wiring legs the body lists. Ownership is claimed HERE rather than in the
  // skill's descriptor because a descriptor redeclaring a framework-core entry is refused by
  // buildRegistry() — `owners[]` is the co-ownership mechanism, and it costs no framework.yaml
  // entry because this id is already listed.
  { id: 'criterion.new-skill-checklist', title: 'New-skill checklist and skill portability', owners: ['sk-skill-manager'], marker: '**New skill checklist:**' },
  { id: 'criterion.model-tier-substitution', title: 'Subagent model selection by tier', owners: [], marker: 'Subagent model selection — by tier, never exact ID' },
]);

/**
 * Core entries in registry shape (see registry.mjs for the full merged form).
 *
 * `body_marker` is carried alongside `body_at` rather than folded into it as a
 * `AGENTS.md#<id>` fragment: six call sites treat `body_at` as a plain path and feed it straight to
 * `join(repoRoot, entry.body_at)`, so a fragment would turn every one of them into a lookup for a
 * file that cannot exist. A separate field addresses the body without changing what the path means.
 * Skill-owned entries (registry.mjs) carry `body_marker: null` — their body IS a whole file, so its
 * existence is already a real check.
 *
 * @returns {Array<{id: string, kind: string, title: string, owners: string[], body_at: string|null, body_marker: string|null, script: string|null, floor: boolean, source: 'core'}>}
 */
export function coreEntries() {
  const rules = CORE_RULES.map((r) => ({
    id: r.id,
    kind: r.id.startsWith('criterion.') ? 'criterion' : 'rule',
    title: r.title,
    owners: [...r.owners],
    body_at: 'AGENTS.md',
    body_marker: r.marker,
    script: null,
    floor: LOCKED_IDS.has(r.id),
    source: /** @type {'core'} */ ('core'),
  }));
  const hooks = CORE_HOOKS.map((h) => ({
    id: h.id,
    kind: 'hook',
    title: h.title,
    owners: [...h.owners],
    body_at: null,
    body_marker: null,
    script: h.script,
    floor: LOCKED_IDS.has(h.id),
    source: /** @type {'core'} */ ('core'),
  }));
  return [...rules, ...hooks];
}
