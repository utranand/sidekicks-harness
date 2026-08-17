#!/usr/bin/env node
// scripts/enforce-local-memory.mjs
//
// Claude Code PreToolUse hook (matcher: Write) that enforces LOCAL-ONLY project
// memory for this repo. When the agent tries to Write a PROJECT-relevant memory
// entry into the host/global store (~/.claude/.../memory/<slug>.md), this hook:
//   1. redirects the content into THIS repo's committed local store via
//      `sidekicks memory add` (so it travels with git, reaches every CLI), then
//   2. DENIES the global Write — so project memory never persists globally.
//
// It deliberately does NOT touch personal/global-only memory: a `user`-type entry
// (facts about the person), an unclassifiable entry, or the global MEMORY.md index
// are ALLOWED through to the global store as before. Only the project-relevant
// types (project / reference / feedback) are redirected + blocked.
//
// Cross-CLI note: a .claude/ hook only fires in Claude Code; the CLAUDE.md
// "Local memory" convention is what makes Gemini/Codex/etc. write local-only too.
// This hook is the deterministic Claude-Code enforcement of that policy.
//
// Contract: BEST-EFFORT. On any internal error it ALLOWS the write (never wedges
// the agent). Zero npm dependencies (node:* + lib/ only).
//
// Direct test mode (prints the decision it WOULD return as JSON):
//   node scripts/enforce-local-memory.mjs --file <path-to-global-memory.md>

import { readFileSync, existsSync } from 'node:fs';
import { dirname, basename, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as yaml from '../lib/yaml-subset/yaml.mjs';

// Global memory type → local entry type. Only these PROJECT-relevant types are
// redirected to the local store + blocked globally. `user` (personal facts) is
// intentionally absent → such writes are ALLOWED through to global, unchanged.
const TYPE_MAP = {
  project: 'context',
  reference: 'reference',
  feedback: 'convention',
};

/** Resolve the repo root by walking up for `.sidekicks/` (never git rev-parse). */
// A mounted framework core (<workspace>/.sidekicks-core/) carries its own .sidekicks/ but is a
// read-only submodule, not a repo root — walk past it so this guard compares against the workspace.
// Constant duplicated from lib/sk-cli/core-mount.mjs: this is a floor hook wired as
// PreToolUse(Write), so it static-imports nothing that a partial checkout could be missing.
const CORE_MARKER = '.sidekicks-core.json';
const CORE_DIR = '.sidekicks-core';
// NTFS is case-insensitive, so a byte-exact basename compare would silently defeat the skip on Windows.
const sameName = (a, b) => (process.platform === 'win32'
  ? String(a).toLowerCase() === String(b).toLowerCase()
  : a === b);   // only a core AT the mount point is skipped

function resolveRepoRoot(startDir) {
  let dir = startDir;
  let coreFallback = null;
  while (dir && dir !== dirname(dir)) {
    const hasSidekicks = existsSync(resolve(dir, '.sidekicks'));
    const isCore = sameName(basename(dir), CORE_DIR) && existsSync(resolve(dir, CORE_MARKER));
    if (hasSidekicks && !isCore) return dir;
    // A workspace that has MOUNTED a core is a root even before `core init` gives it a .sidekicks/,
    // and it beats any .sidekicks/ further up ($HOME/.sidekicks, which skills create for their own
    // state). Same nearness rule as lib/sk-cli/paths.mjs.
    if (existsSync(resolve(dir, CORE_DIR, CORE_MARKER))) return dir;
    if (coreFallback === null && hasSidekicks && isCore) coreFallback = dir;
    dir = dirname(dir);
  }
  return coreFallback;   // a STANDALONE core is its own root; a mounted one defers to the workspace
}

/** Normalize a host-memory name into a valid local kebab-case slug. */
function toSlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Split a markdown file into { frontmatter (parsed obj|null), body }. */
function splitFrontmatter(text) {
  const norm = String(text).replace(/\r\n?/g, '\n');
  if (!norm.startsWith('---\n')) return { frontmatter: null, body: norm };
  const end = norm.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: null, body: norm };
  const fmText = norm.slice(4, end);
  const after = norm.slice(end + 4).replace(/^\n+/, '');
  let frontmatter = null;
  try {
    frontmatter = yaml.parse(fmText);
  } catch {
    frontmatter = null;
  }
  return { frontmatter, body: after };
}

/**
 * Is `filePath` a HOST/global memory ENTRY file (not the MEMORY.md index)?
 * Its parent dir is `memory`, it's a `.md` that isn't MEMORY.md, it sits OUTSIDE
 * this repo (the local store is inside — also prevents any self-mirror loop), and
 * it's under a `.claude`/`.config` host dir.
 */
function isHostMemoryEntry(filePath, repoRoot) {
  if (!filePath) return false;
  const abs = resolve(filePath);
  if (extname(abs).toLowerCase() !== '.md') return false;
  if (basename(abs) === 'MEMORY.md') return false;
  if (basename(dirname(abs)) !== 'memory') return false;
  if (repoRoot && (abs === repoRoot || abs.startsWith(repoRoot + sep))) return false;
  if (!abs.includes(`${sep}.claude${sep}`) && !abs.includes(`${sep}.config${sep}`)) return false;
  return true;
}

/**
 * Add the memory into the local store via `sidekicks memory add`.
 * @returns {{ ok: boolean, detail: string }}
 */
function addLocal(repoRoot, slug, localType, description, body) {
  const bin = resolve(repoRoot, 'bin', 'sidekicks');
  const res = spawnSync(
    process.execPath,
    [bin, 'memory', 'add', slug, `--type=${localType}`, `--description=${description}`, `--body=${body}`, '--force'],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  if (res.status === 0) return { ok: true, detail: `${slug} (-> ${localType})` };
  return { ok: false, detail: (res.stderr || '').trim().split('\n')[0] || `exit ${res.status}` };
}

/** Build the PreToolUse decision object for the host-memory Write at `filePath`. */
function decide(filePath, content, repoRoot) {
  // Not a redirectable project-memory entry → allow (covers MEMORY.md index,
  // non-memory writes, writes inside the repo, etc.).
  if (!repoRoot || !isHostMemoryEntry(filePath, repoRoot)) return { allow: true };

  const text = content != null ? content : (existsSync(filePath) ? readFileSync(filePath, 'utf8') : '');
  const { frontmatter, body } = splitFrontmatter(text);
  const gType = frontmatter?.metadata?.type;
  const localType = gType ? TYPE_MAP[gType] : undefined;

  // user-type / unclassifiable → personal or unknown: leave it to the global store.
  if (!localType) return { allow: true };

  // Project-relevant memory → redirect into the local store, then BLOCK the global write.
  const slug = toSlug(frontmatter.name || basename(filePath, '.md'));
  const description = String(frontmatter.description || '').trim() || `mirrored ${gType} memory`;
  const res = slug ? addLocal(repoRoot, slug, localType, description, body) : { ok: false, detail: 'empty slug' };

  const reason = res.ok
    ? `Project memory is LOCAL-ONLY in this repo. Saved to the committed local store instead ` +
      `(sidekicks memory: ${res.detail}) — it travels with git and reaches every CLI. Global memory was NOT written. ` +
      `Do not retry; use 'sidekicks memory' for project memory. (Personal 'user'-type memory still goes to global.)`
    : `Project memory is LOCAL-ONLY in this repo, so this global write is blocked — but the auto-redirect FAILED (${res.detail}). ` +
      `Please save it yourself: sidekicks memory add ${slug || '<slug>'} --type=${localType} --description="..." --body="...".`;

  return { allow: false, reason };
}

/** Emit the PreToolUse hook decision and exit. */
function emit(decision) {
  if (decision.allow) process.exit(0); // no output = allow
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    })
  );
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolveRepoRoot(here);

  // Direct test mode: --file <path> → print the decision as JSON.
  const argv = process.argv.slice(2);
  const fileIdx = argv.indexOf('--file');
  if (fileIdx !== -1 && argv[fileIdx + 1]) {
    const fp = resolve(argv[fileIdx + 1]);
    const d = decide(fp, null, repoRoot);
    process.stdout.write(JSON.stringify(d.allow ? { allow: true } : { deny: d.reason }) + '\n');
    process.exit(0);
  }

  const raw = readStdin();
  if (!raw.trim()) process.exit(0); // allow
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    process.exit(0); // allow on parse failure (best-effort)
  }
  if (evt?.tool_name !== 'Write') process.exit(0); // allow non-Write
  const filePath = evt?.tool_input?.file_path;
  const content = evt?.tool_input?.content;
  const root = repoRoot || (evt?.cwd ? resolveRepoRoot(resolve(evt.cwd)) : null);

  emit(decide(filePath, content, root));
}

// Framework gate: `sidekicks framework disable <id>` makes this hook a no-op (exit 0).
await import('./lib/hook-gate.mjs')
  .then((gate) => gate.exitIfDisabled('hook.enforce-local-memory'))
  .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

main();
