// lib/config-store/core-families.mjs
// The FAMILY taxonomy (which file a configuration block lives in) and the framework-owned half of
// the block registry.
//
// TWO SOURCES, ONE REGISTRY (see families.mjs) — the same shape lib/framework-settings/registry.mjs
// uses for rules and hooks:
//   1. here      — families, plus the blocks that belong to framework CODE and therefore cannot be
//                  declared by a skill descriptor (lib/agent-lifecycle/*, scripts/*-hook.mjs).
//   2. skill.yaml — every block a skill declares, discovered by scanning both skill trees.
//
// WHY A FAMILY LAYER AT ALL. A scope's configuration used to be one file per scope: 11 unrelated
// concerns at root, ~9 in projects/shp-sk/config.yaml across 1135 lines, with `database_connector`
// alone taking 48% of it. One file per concern makes a block findable, reviewable and — the point —
// distributable: a repo that only needs Jira carries config/jira.yaml and nothing else.
//
// FAMILY = FILE, BLOCK = UNIT. The family names the file; the block keeps its existing top-level
// key inside that file, unchanged. So migration is a cut-paste, the tolerant reader in block.mjs is
// unchanged, and a skill that declares `block: jira` needs to know nothing about families.
//
// Zero npm dependencies — no imports at all.

/**
 * Every family, in the order a human should read them. `file` is the basename inside a scope's
 * `config/` directory; `secret` names the git-ignored sibling that carries the credentials.
 *
 * @type {ReadonlyArray<{family: string, file: string, secret: string, title: string}>}
 */
export const FAMILIES = Object.freeze([
  { family: 'jira', title: 'Jira — auth, boards, my-work, footprint, ready gate' },
  { family: 'confluence', title: 'Confluence — spaces and publish targets' },
  { family: 'database', title: 'PostgreSQL — direct and Teleport-proxied connections' },
  { family: 'kubernetes', title: 'Kubernetes — nonprod cluster ops, Teleport prod access' },
  { family: 'aws', title: 'AWS — KMS keys and IAM credentials' },
  { family: 'argocd', title: 'ArgoCD — GitOps applications, sync and diagnosis' },
  { family: 'comms', title: 'Notifications — Slack, Telegram, mail, run reporting' },
  { family: 'agents', title: 'Persistent agents — daemon, tray, bridge, scheduler, office' },
  { family: 'media', title: 'Media generation and publishing' },
  { family: 'delivery', title: 'Delivery engines — get-plan-done, get-things-done' },
  { family: 'skills', title: 'Skill tooling — skills repository, nicknames' },
  { family: 'memory', title: 'Local memory — the external sources the store syncs from and publishes to' },
  { family: 'figma', title: 'Figma — design files and plans' },
].map((f) => Object.freeze({
  ...f,
  file: `${f.family}.yaml`,
  secret: `${f.family}.secret.yaml`,
})));

/** Family names, for validation. */
export const FAMILY_NAMES = Object.freeze(new Set(FAMILIES.map((f) => f.family)));

/**
 * Blocks owned by framework code rather than by a skill.
 *
 * `readers` records who actually consumes the block, because a block with no reader is dead config
 * and a block whose reader nobody recorded is how `.sidekicks/config.yaml` grew 14 undeclared
 * blocks. It is documentation with a test behind it, not decoration.
 *
 * `scope`:
 *   'root' — per-machine infrastructure. Only the root layers are consulted, whatever project is
 *            active, because there is exactly one daemon / tray / bot per checkout. A project may
 *            not override it, so the project layers are not read at all.
 *   'any'  — per-scope configuration. Project layers first; the root layers follow only when
 *            `inherits_root` is true (or when root IS the active scope).
 *   'project' — the inverse of 'root': configuration that belongs to a project and has no root
 *            home at all. The root layers are never read, `config sync` does not document the
 *            block at root, and `config set --root` is refused. With no project active it resolves
 *            to the owning skill's defaults, which is honest rather than half-inherited.
 *
 * `merge`:
 *   'per_key'     — the default: the highest layer that carries a KEY owns that key.
 *   'whole_block' — the highest layer that carries the BLOCK owns all of it. `run_notify` needs
 *                   this: a project setting `enabled: false` must switch reporting off wholesale
 *                   rather than inherit root's transports (tests/run-notify-hook.test.mjs).
 *
 * @type {ReadonlyArray<{
 *   block: string, family: string, title: string, readers: string[],
 *   scope: 'root'|'any', inherits_root: boolean, merge: 'per_key'|'whole_block',
 * }>}
 */
export const CORE_BLOCKS = Object.freeze([
  {
    block: 'run_notify',
    family: 'comms',
    title: 'Run reporting — which transports announce a finished run',
    readers: ['scripts/run-notify-hook.mjs'],
    scope: 'any',
    inherits_root: true,
    merge: 'whole_block',
  },
  {
    block: 'mail_sender',
    family: 'comms',
    title: 'SMTP sender for reports and run notifications',
    readers: ['scripts/send-mail.py', '.agents/skills/sk-report'],
    scope: 'root',
    inherits_root: true,
    merge: 'per_key',
  },
  {
    block: 'telegram',
    family: 'comms',
    title: 'Telegram bots, channels and routing targets',
    readers: ['lib/agent-lifecycle/telegram.mjs', 'lib/agent-lifecycle/_comms.mjs'],
    scope: 'root',
    inherits_root: true,
    merge: 'per_key',
  },
  {
    block: 'bridge',
    family: 'agents',
    title: 'Agent bridge HTTP listener',
    readers: ['lib/agent-lifecycle/_bridge.mjs', 'lib/agent-lifecycle/bridge.mjs'],
    scope: 'root',
    inherits_root: true,
    merge: 'per_key',
  },
  {
    block: 'scheduler',
    family: 'agents',
    title: 'Agent routine scheduler',
    readers: ['lib/agent-lifecycle/scheduler.mjs'],
    scope: 'root',
    inherits_root: true,
    merge: 'per_key',
  },
  {
    block: 'agent_daemon',
    family: 'agents',
    title: 'Delegate-agent daemon lanes and pacemaker',
    readers: ['lib/agent-lifecycle/daemon.mjs', 'lib/agent-lifecycle/_pacemaker.mjs',
      'lib/agent-lifecycle/_daemon-check.mjs'],
    scope: 'root',
    inherits_root: true,
    merge: 'per_key',
  },
  {
    block: 'agent_tray',
    family: 'agents',
    title: 'Sidekicks Agent Tray menu-bar app',
    readers: ['.agents/skills/sk-agent-tray/scripts/agentwatch.py'],
    scope: 'root',
    inherits_root: true,
    merge: 'per_key',
  },
  {
    block: 'office',
    family: 'agents',
    title: 'Agent Office visualisation roots',
    readers: ['lib/agent-lifecycle/_office.mjs', 'lib/agent-lifecycle/office.mjs'],
    scope: 'root',
    inherits_root: true,
    merge: 'per_key',
  },
  {
    block: 'agent_skill_store',
    family: 'agents',
    title: 'Private per-agent learned skills — isolated version store and harvest policy',
    readers: ['lib/agent-lifecycle/skill.mjs', 'lib/agent-lifecycle/_primary-prompt.mjs'],
    scope: 'root',
    inherits_root: true,
    merge: 'per_key',
    builtin: {
      checkout: 'projects/global/services/persistent-agent-skills/src',
      branch: 'agent-skills',
      remote: 'origin',
      push: 'never',
      repeat_threshold: 2,
      repeat_window_days: 30,
      candidate_cooldown_days: 7,
      max_generated_per_harvest: 1,
      context_limit: 5,
    },
  },
  {
    block: 'memory_sources',
    family: 'memory',
    title: 'Local memory — external sources the store syncs from and publishes to',
    readers: ['lib/memory-lifecycle/source.mjs', 'lib/memory-lifecycle/sync.mjs',
      'lib/memory-lifecycle/publish.mjs', 'lib/memory-lifecycle/import.mjs',
      'lib/memory-lifecycle/doctor.mjs'],
    scope: 'root',
    inherits_root: true,
    // whole_block: a project that names its own sources replaces the list rather than appending to
    // root's — a half-inherited source list would sync from somewhere nobody chose.
    merge: 'whole_block',
    builtin: {
      default_strategy: 'merge',
      sources: [],
    },
  },
  {
    block: 'teleport',
    family: 'kubernetes',
    title: 'Teleport login identity shared by both teleport_* blocks',
    readers: ['.agents/skills/sk-teleport-cluster-ops',
      '.agents/skills/sk-teleport-database-connector'],
    scope: 'any',
    inherits_root: false,
    merge: 'per_key',
  },
  {
    block: 'figma',
    family: 'figma',
    title: 'Figma files, plans and the active file alias',
    readers: ['agent (Figma MCP), via SKILL prose'],
    scope: 'any',
    inherits_root: false,
    merge: 'per_key',
  },
]);
