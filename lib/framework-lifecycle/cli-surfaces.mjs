// CLI-neutral contract for framework surfaces adapted by each supported host.
// Object keys identify adapters; their order is never a routing preference.

export const CLI_SURFACES = Object.freeze({
  antigravity: Object.freeze({
    config: '.agent/settings.json',
    subagents: '.agents/plugins/sidekicks-agents/agents',
  }),
  claude: Object.freeze({ config: '.claude/settings.json', subagents: '.claude/agents' }),
  codex: Object.freeze({ config: '.codex/config.toml', subagents: '.codex/agents' }),
  gemini: Object.freeze({ config: '.gemini/settings.json', subagents: '.gemini/agents' }),
});

export const CANONICAL_SUBAGENT_ROOT = '.agents/subagents';

const omitted = (reason) => Object.freeze({ reason });
const hook = (path, omit = {}) => Object.freeze({ path, omit: Object.freeze(omit) });

export const LOGICAL_HOOKS = Object.freeze([
  hook('.sidekicks/hooks/rtk-hook.mjs', {
    antigravity: omitted('Antigravity exposes no tool-call hook event'),
  }),
  hook('scripts/artifact-autotrigger-hook.mjs'),
  hook('scripts/artifact-liveness-hook.mjs'),
  hook('scripts/enforce-branch-safety.mjs', {
    antigravity: omitted('library branch guards enforce this without tool-call hooks'),
  }),
  hook('scripts/enforce-flow-headful.mjs', {
    antigravity: omitted('flowlib.assert_headful() enforces this without tool-call hooks'),
  }),
  hook('scripts/enforce-local-memory.mjs', {
    antigravity: omitted('this host does not use the guarded Claude global store'),
    codex: omitted('this host does not use the guarded Claude global store'),
    gemini: omitted('this host does not use the guarded Claude global store'),
  }),
  hook('scripts/enhance-prompt-hook.mjs'),
  hook('scripts/fable-escalation-hook.mjs'),
  hook('scripts/gtd-orphan-watch-hook.mjs', {
    antigravity: omitted('the host exposes no session-start event'),
  }),
  hook('scripts/load-local-memory-hook.mjs', {
    antigravity: omitted('the host exposes no session-start event; AGENTS.md carries the fallback'),
  }),
  hook('scripts/memory-trigger-hook.mjs', {
    antigravity: omitted('the host exposes no tool-call event; AGENTS.md carries the fallback'),
  }),
  hook('scripts/office-viz-hook.mjs'),
  hook('scripts/recompile-validation-checklist.mjs', {
    antigravity: omitted('the host exposes no post-tool event'),
    codex: omitted('the host exposes no post-tool event'),
    gemini: omitted('no verified post-tool event mapping exists yet'),
  }),
  hook('scripts/run-notify-hook.mjs'),
  hook('scripts/skill-advisor-hook.mjs', {
    antigravity: omitted('the host exposes no tool-call hook event'),
    codex: omitted('inline skill activation exposes no tool-call event'),
  }),
]);

export const CLI_CONFIG_PATHS = Object.freeze(
  Object.values(CLI_SURFACES).map((surface) => surface.config).sort(),
);
