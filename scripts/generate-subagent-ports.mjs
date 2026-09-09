#!/usr/bin/env node

// Generate host-specific subagent ports from the CLI-neutral definitions in
// .agents/subagents/. The canonical files intentionally describe capability
// names and model tiers, never a provider's tool names or model aliases.
//
// Supported output ports:
//   - Claude Code: .claude/agents/**/*.md
//   - Codex CLI: .codex/agents/*.toml
//   - Gemini CLI: .gemini/agents/*.md
//   - Antigravity: .agents/plugins/sidekicks-agents/agents/*/agent.json

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalRoot = join(repoRoot, '.agents', 'subagents');
const claudeRoot = join(repoRoot, '.claude', 'agents');
const codexRoot = join(repoRoot, '.codex', 'agents');
const geminiRoot = join(repoRoot, '.gemini', 'agents');
const pluginRoot = join(repoRoot, '.agents', 'plugins', 'sidekicks-agents', 'agents');

const MODEL_TO_TIER = { fable: 'top', opus: 'high', sonnet: 'mid', haiku: 'low', inherit: 'inherit' };
const TIER_TO_CLAUDE = { top: 'fable', high: 'opus', mid: 'sonnet', low: 'haiku', inherit: 'inherit' };
const TIER_TO_CODEX_EFFORT = { top: 'xhigh', high: 'high', mid: 'medium', low: 'low' };
const TOOL_TO_CAPABILITY = {
  Read: 'read',
  Grep: 'search',
  Glob: 'glob',
  Bash: 'shell',
  Edit: 'edit',
  Write: 'write',
  Skill: 'skills',
  WebSearch: 'web_search',
  WebFetch: 'web_fetch',
};
const CAPABILITY_TO_TOOL = Object.fromEntries(
  Object.entries(TOOL_TO_CAPABILITY).map(([tool, capability]) => [capability, tool]),
);
const CAPABILITY_TO_GEMINI_TOOL = {
  read: 'read_file',
  search: 'grep_search',
  glob: 'glob',
  shell: 'run_shell_command',
  edit: 'replace',
  write: 'write_file',
  skills: 'activate_skill',
  web_search: 'google_web_search',
  web_fetch: 'web_fetch',
};
const PORTABLE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Filesystem droppings the OS writes into any directory a user opens, ignored rather than validated.
 *
 * The walk below names EVERY entry it sees, on purpose: a stray file in the canonical tree is a
 * question worth asking. But `.DS_Store` is not a stray file, it is Finder, and it is git-ignored
 * precisely because nobody authored it. Validating it threw `name '.DS_Store' must be a lowercase
 * portable slug` out of the middle of the generator, which turned the Rule 6 parity suite red for
 * any macOS developer who had ever opened `.agents/subagents/` in a window — and that suite is
 * colocated under lib/, so it travels into a forged core and runs inside the release's mount gate,
 * where a red test blocks `skill.doctor`, `parity` and `package.clean` behind it. A gate that starts
 * red for a reason the developer cannot act on teaches people to ignore the gate.
 *
 * The same three names the packager and the workspace seed already exclude
 * (lib/package-lifecycle/plan.mjs, lib/core-lifecycle/_seed.mjs) — an enumerated set, not a
 * dotfile glob: a real authoring mistake still has to be reported.
 */
const OS_NOISE = Object.freeze(new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']));

/** AppleDouble sidecars (`._name`), which a copy to a non-HFS volume scatters beside every file. */
const APPLEDOUBLE_RE = /^\._/;

/** Is this entry OS-generated noise rather than something a human put here? */
export function isOsNoise(entry) {
  return OS_NOISE.has(entry) || APPLEDOUBLE_RE.test(entry);
}

/** Reject names that can escape, alias, or collide in a host-specific output tree. */
export function validatePortableSubagentName(name, source = 'subagent', seen = null) {
  if (!PORTABLE_NAME_RE.test(name) || name.endsWith('.') || name === '.' || name === '..') {
    throw new Error(`${source}: name '${name}' must be a lowercase portable slug (letters, digits, dot, underscore, hyphen; maximum 64 characters)`);
  }
  if (WINDOWS_DEVICE_RE.test(name)) {
    throw new Error(`${source}: name '${name}' is reserved on Windows`);
  }
  const folded = name.toLowerCase();
  if (seen?.has(folded)) {
    throw new Error(`${source}: name '${name}' collides with ${seen.get(folded)} on a case-insensitive filesystem`);
  }
  seen?.set(folded, source);
  return name;
}

export function markdownFiles(root) {
  if (!existsSync(root)) return [];
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) throw new Error(`${root}: canonical subagent root must not be a symlink`);
  if (!rootStat.isDirectory()) throw new Error(`${root}: canonical subagent root must be a directory`);
  const result = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const rel = relative(root, path).split('\\').join('/');
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error(`${rel}: symlinks are not allowed in canonical subagents`);
      if (!st.isDirectory() && isOsNoise(entry)) continue;
      if (!st.isDirectory() && entry === 'README.md') continue;
      const segment = st.isDirectory() ? entry : basename(entry, extname(entry));
      validatePortableSubagentName(segment, rel);
      if (st.isDirectory()) walk(path);
      else if (extname(entry) === '.md') result.push(path);
    }
  };
  walk(root);
  return result;
}

export function parseDefinition(text, source) {
  const normalized = text.replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) throw new Error(`${source}: expected YAML-style frontmatter`);

  const metadata = {};
  for (const line of match[1].split('\n')) {
    const field = /^([a-z_]+):(?:\s*(.*))?$/.exec(line);
    if (!field) throw new Error(`${source}: unsupported frontmatter line '${line}'`);
    metadata[field[1]] = field[2] ?? '';
  }
  if (!metadata.name || !metadata.description) {
    throw new Error(`${source}: name and description are required`);
  }
  validatePortableSubagentName(metadata.name, source);
  const modelTier = metadata.model_tier || 'inherit';
  if (!(modelTier in TIER_TO_CLAUDE)) {
    throw new Error(`${source}: unknown model_tier '${modelTier}'`);
  }
  const capabilities = (metadata.capabilities || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const capability of capabilities) {
    if (!(capability in CAPABILITY_TO_TOOL)) {
      throw new Error(`${source}: unknown capability '${capability}'`);
    }
  }
  return {
    ...metadata,
    modelTier,
    capabilities,
    body: `${match[2].replace(/^\n+|\n+$/g, '')}\n`,
  };
}

function neutralize(text) {
  return text
    .replaceAll('per CLAUDE.md', 'per AGENTS.md')
    .replaceAll('CLAUDE.md', 'AGENTS.md')
    .replaceAll('Claude hooks', 'agent hooks')
    .replaceAll("host `.claude/skills/` is a symlink", 'host-specific skill exposure folders link to it')
    .replaceAll('Fable/Mythos-class', 'top-tier')
    .replaceAll('Fable-tier', 'top-tier');
}

function migrateClaudeDefinition(file) {
  const source = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`${file}: expected YAML-style frontmatter`);
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = /^([a-z_]+):(?:\s*(.*))?$/.exec(line);
    if (!field) throw new Error(`${file}: unsupported frontmatter line '${line}'`);
    fields[field[1]] = field[2] ?? '';
  }
  const tools = (fields.tools || '').split(',').map((value) => value.trim()).filter(Boolean);
  const capabilities = tools.map((tool) => {
    const capability = TOOL_TO_CAPABILITY[tool];
    if (!capability) throw new Error(`${file}: no neutral capability mapping for '${tool}'`);
    return capability;
  });
  const tier = MODEL_TO_TIER[fields.model || 'inherit'];
  if (!tier) throw new Error(`${file}: no neutral tier mapping for '${fields.model}'`);
  return [
    '---',
    `name: ${fields.name}`,
    `description: ${neutralize(fields.description)}`,
    `capabilities: ${capabilities.join(', ')}`,
    `model_tier: ${tier}`,
    '---',
    '',
    neutralize(match[2]).replace(/^\n+|\n+$/g, ''),
    '',
  ].join('\n');
}

function renderClaude(definition) {
  const tools = definition.capabilities.map((value) => CAPABILITY_TO_TOOL[value]);
  return [
    '---',
    `name: ${definition.name}`,
    `description: ${definition.description}`,
    `tools: ${tools.join(', ')}`,
    `model: ${TIER_TO_CLAUDE[definition.modelTier]}`,
    '---',
    '',
    definition.body.replace(/\n+$/, ''),
    '',
  ].join('\n');
}

function tomlString(value) {
  return JSON.stringify(value);
}

export function renderCodex(definition, sourceRel) {
  const capabilityNote = definition.capabilities.length > 0
    ? `Requested capabilities: ${definition.capabilities.join(', ')}. Enforce them behaviorally when the host cannot restrict tools.`
    : 'No capability restriction is requested.';
  const instructions = [
    `Generated from ${sourceRel}.`,
    capabilityNote,
    `Requested model tier: ${definition.modelTier}.`,
    '',
    definition.body.replace(/\n+$/, ''),
  ].join('\n');
  const lines = [
    '# Generated from the CLI-neutral Sidekicks subagent definition.',
    '',
    `name = ${tomlString(definition.name)}`,
    `description = ${tomlString(definition.description)}`,
  ];
  const effort = TIER_TO_CODEX_EFFORT[definition.modelTier];
  if (effort) lines.push(`model_reasoning_effort = ${tomlString(effort)}`);
  lines.push(
    '',
    `developer_instructions = ${tomlString(instructions)}`,
    '',
  );
  return lines.join('\n');
}

function renderGemini(definition, sourceRel) {
  const tools = definition.capabilities.map((value) => CAPABILITY_TO_GEMINI_TOOL[value]);
  return [
    '---',
    `name: ${definition.name}`,
    `description: ${JSON.stringify(definition.description)}`,
    'kind: local',
    'model: inherit',
    'tools:',
    ...tools.map((tool) => `  - ${tool}`),
    '---',
    '',
    `Generated from ${sourceRel}.`,
    `Requested model tier: ${definition.modelTier}. Resolve the tier through the active executor registry when this host supports a per-agent model override.`,
    '',
    definition.body.replace(/\n+$/, ''),
    '',
  ].join('\n');
}

function renderPlugin(definition) {
  return `${JSON.stringify({
    name: definition.name,
    description: definition.description,
    hidden: false,
    config: {
      customAgent: {
        systemPromptSections: [{
          title: 'System Instructions',
          content: [
            `Requested model tier: ${definition.modelTier}.`,
            '',
            definition.body.replace(/\n+$/, ''),
          ].join('\n'),
        }],
      },
    },
  }, null, 2)}\n`;
}

function expectedOutputs() {
  const seenNames = new Map();
  return markdownFiles(canonicalRoot).flatMap((file) => {
    const sourceRel = relative(repoRoot, file).split('\\').join('/');
    const definition = parseDefinition(readFileSync(file, 'utf8'), sourceRel);
    const stem = basename(file, '.md');
    if (definition.name !== stem && !definition.name.endsWith(`-${stem}`)) {
      throw new Error(`${sourceRel}: filename stem '${stem}' must match the declared name '${definition.name}' or its provider-neutral suffix`);
    }
    validatePortableSubagentName(definition.name, sourceRel, seenNames);
    const canonicalRel = relative(canonicalRoot, file);
    return [
      [join(claudeRoot, canonicalRel), renderClaude(definition)],
      [join(codexRoot, `${definition.name}.toml`), renderCodex(definition, sourceRel)],
      [join(geminiRoot, `${definition.name}.md`), renderGemini(definition, sourceRel)],
      [join(pluginRoot, definition.name, 'agent.json'), renderPlugin(definition)],
    ];
  });
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function migrate() {
  for (const file of markdownFiles(claudeRoot)) {
    const target = join(canonicalRoot, relative(claudeRoot, file));
    write(target, migrateClaudeDefinition(file));
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--migrate-from-claude')) migrate();
  const outputs = expectedOutputs();
  if (outputs.length === 0) throw new Error('no canonical subagents found under .agents/subagents');

  const drift = outputs.filter(([path, content]) => !existsSync(path) || readFileSync(path, 'utf8') !== content);
  if (args.has('--check')) {
    if (drift.length > 0) {
      for (const [path] of drift) process.stderr.write(`out of date: ${relative(repoRoot, path)}\n`);
      process.exitCode = 1;
    }
    return;
  }
  for (const [path, content] of drift) write(path, content);
  process.stdout.write(`generated ${outputs.length} ports from ${outputs.length / 4} neutral definitions\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
