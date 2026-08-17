#!/usr/bin/env node
// scripts/memory-trigger-hook.mjs — PreToolUse hook (matchers: Skill, Bash)
//
// Why this exists: SessionStart now loads only the CATEGORY MAP (~300 tokens), not the
// store's contents. That trade is only safe if the bodies actually arrive when they
// matter. This hook is the "when they matter" half: the FIRST time a session performs
// an action belonging to a category, it injects that category's scenario pack —
// every hard rule in full, plus index lines for the rest — as additionalContext,
// BEFORE the tool call runs.
//
// Once per category per session. A dedup marker under `.sidekicks/state/` (git-ignored,
// per-machine, never repo content and never `artifacts/runs/`) records which categories
// a session already received, so the second database action costs nothing. The whole
// design would collapse into eager loading again without that.
//
// Cross-CLI action resolution (the only thing that differs between CLIs):
//   Claude Code → tool_name 'Skill',         skill in tool_input.skill
//   Gemini CLI  → tool_name 'activate_skill', skill in tool_input.name
//   Claude/Gemini shell → 'Bash' / 'run_command', command in tool_input.command
//                         (string OR argv array — same shape enforce-branch-safety reads)
//   Codex CLI   → reads SKILL.md inline, so no PreToolUse fires on skill activation;
//                 its shell calls still match the command path.
// Antigravity has no tool-call event at all — there the SessionStart map text carries
// the instruction instead (documented in tests/multi-cli-parity.test.mjs).
//
// It NEVER blocks a tool call and never denies: it either adds context or says nothing.
// Any error is swallowed and treated as "no trigger". Zero npm dependencies.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// A mounted framework core (<workspace>/.sidekicks-core/) carries its own .sidekicks/ but is a
// read-only submodule, not a repo root. Constants duplicated from lib/sk-cli/core-mount.mjs
// so this hook static-imports nothing outside node:* (same reason load-local-memory-hook does).
const CORE_MARKER = '.sidekicks-core.json';
const CORE_DIR = '.sidekicks-core';
const sameName = (a, b) => (process.platform === 'win32'
  ? String(a).toLowerCase() === String(b).toLowerCase()
  : a === b);

function resolveRepoRoot(startDir) {
  let dir = startDir;
  let coreFallback = null;
  while (dir && dir !== dirname(dir)) {
    const hasSidekicks = existsSync(resolve(dir, '.sidekicks'));
    const isCore = sameName(basename(dir), CORE_DIR) && existsSync(resolve(dir, CORE_MARKER));
    if (hasSidekicks && !isCore) return dir;
    if (existsSync(resolve(dir, CORE_DIR, CORE_MARKER))) return dir;
    if (coreFallback === null && hasSidekicks && isCore) coreFallback = dir;
    dir = dirname(dir);
  }
  return coreFallback;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Normalize a command payload: a string, or an argv array joined back into one line. */
function commandOf(toolInput) {
  const raw = toolInput.command ?? toolInput.cmd ?? toolInput.script;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(String).join(' ');
  return null;
}

/**
 * Which categories a session has already been given. Keyed by the CLI's session id when
 * it hands one over, else by parent pid — the point is only that repeated calls inside
 * ONE session collapse, so a coarse key is correct and a persisted one would be wrong.
 */
function dedupPath(repoRoot, sessionId) {
  const key = String(sessionId || `pid-${process.ppid}`).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
  return join(repoRoot, '.sidekicks', 'state', 'memory-trigger', `${key}.json`);
}

function readDelivered(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed.categories) ? new Set(parsed.categories) : new Set();
  } catch {
    return new Set();
  }
}

function writeDelivered(file, set) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ categories: [...set] }) + '\n');
  } catch {
    // Unwritable state dir — the pack is still injected, it just may repeat. Losing the
    // dedup is a cost; losing the rules would be a correctness failure.
  }
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolveRepoRoot(here);
  if (!repoRoot) return;

  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    return; // malformed payload — stay out of the way
  }

  const ti = input.tool_input || {};
  let skill = null;
  let command = null;
  if (input.tool_name === 'Skill') skill = ti.skill ?? null;
  else if (input.tool_name === 'activate_skill') skill = ti.name ?? null;
  else if (input.tool_name === 'Bash' || input.tool_name === 'run_command') command = commandOf(ti);
  else return; // not an action this hook reads — silent

  if (!skill && !command) return;

  const { resolveTriggers, categoriesFor } = await import('../lib/memory-lifecycle/_triggers.mjs');
  const categories = categoriesFor(resolveTriggers(repoRoot), { skill, command });
  if (categories.length === 0) return;

  const marker = dedupPath(repoRoot, input.session_id);
  const delivered = readDelivered(marker);
  const fresh = categories.filter((c) => !delivered.has(c));
  if (fresh.length === 0) return; // already paid for this session

  const bin = resolve(repoRoot, 'bin', 'sidekicks');
  const blocks = [];
  for (const cat of fresh) {
    const res = spawnSync(process.execPath, [bin, 'memory', 'pack', cat], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (res.status !== 0) continue;
    const text = (res.stdout || '').trim();
    // An empty pack means the store knows nothing about this category — record it as
    // delivered anyway so the same empty lookup is not repeated all session.
    delivered.add(cat);
    if (text) blocks.push(text);
  }
  writeDelivered(marker, delivered);
  if (blocks.length === 0) return;

  const context = [
    'MEMORY TRIGGER [hook]: this action belongs to a category this repo has registered memory for.',
    'The pack below is loaded ONCE per session. Any entry under "Hard rules" is mandatory reading',
    'and constrains what you are about to do — obey it before proceeding. Read a non-rule entry',
    'on demand with `node bin/sidekicks memory show <slug>`.',
    '',
    blocks.join('\n\n'),
  ].join('\n');

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: context,
      },
    })
  );
}

// Framework gate: `sidekicks framework disable <id>` makes this hook a no-op (exit 0).
await import('./lib/hook-gate.mjs')
  .then((gate) => gate.exitIfDisabled('hook.memory-trigger'))
  .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

// Best-effort in every path: a PreToolUse hook that exits non-zero BLOCKS the tool call
// on Claude Code, so "nothing to say" and "something went wrong" must look identical.
try {
  await main();
} catch {
  // fall through to a clean exit
}
process.exit(0);
