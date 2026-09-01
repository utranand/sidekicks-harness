#!/usr/bin/env node
// scripts/load-local-memory-hook.mjs
//
// Claude Code SessionStart hook that auto-loads THIS repo's local memory store
// into the session context — the same "it just knows" behavior the host/global
// MEMORY.md gets, but for the LOCAL, git-ignored `sidekicks memory` store (which reaches
// other checkouts through `memory publish` / `memory sync`, not through git).
// Pairs with scripts/enforce-local-memory.mjs (which makes project memory
// local-only): writes go local, and this makes them show up automatically.
//
// LAZY BY DEFAULT (criterion.memory-lazy-load). What this hook emits is the CATEGORY
// MAP — one line naming each category with its entry and rule counts, ~300 tokens —
// not the store's contents. The old behavior injected the whole listing into every
// session: ~36 KB / ~9k tokens that grew with every entry ever registered and that a
// given session almost never needed. Bodies now arrive on demand, when the session is
// about to act in a category:
//
//     node bin/sidekicks memory pack <category>
//
// In Claude Code that pull is automatic (scripts/memory-trigger-hook.mjs fires it on
// the first action of a category); on a CLI with no tool-call hook, the emitted text
// itself is the instruction, which is why it names the command explicitly.
//
// Disabling `criterion.memory-lazy-load` restores the pre-central verbatim listing —
// the escape hatch stays a setting flip rather than a code removal for one release.
//
// Headless delegate wakes (SIDEKICKS_DELEGATE_WAKE=1, injected by
// lib/agent-lifecycle/delegate.mjs runWakeSession) additionally get their own agent
// namespace's compact index and the RULE BODIES of the categories their charter
// attaches (`memory: attach:`) — an agent must not have to be told twice about a hard
// rule in its own domain. Non-attached bodies still wait for a trigger.
//
// Empty store → no context (silent). Best-effort: any error exits 0 with no output.
// Zero npm dependencies (node:* only).

import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// A mounted framework core (<workspace>/.sidekicks-core/) carries its own .sidekicks/ but is a
// read-only submodule, not a repo root. Stopping there would emit the CORE's memory store instead of
// the workspace's — the exact leak recorded in
// .sidekicks/memory/inherited-runtime-scripts-must-be-copied.md. Constant duplicated from
// lib/sk-cli/core-mount.mjs so this hook static-imports nothing outside node:*.
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

/** Run a `sidekicks` verb, returning trimmed stdout or '' on any failure. */
function sk(repoRoot, args) {
  const res = spawnSync(process.execPath, [resolve(repoRoot, 'bin', 'sidekicks'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (res.status !== 0) return '';
  return (res.stdout || '').trim();
}

/**
 * Is lazy loading on? Resolved through the framework settings the same way the hook
 * gate resolves its own id, and it FAILS LAZY: a settings layer that cannot be read
 * must not silently re-inject 36 KB into every session.
 */
async function lazyLoadEnabled(repoRoot) {
  try {
    const mod = await import('../lib/framework-settings/resolve.mjs');
    return mod.isEnabled(repoRoot, 'criterion.memory-lazy-load') !== false;
  } catch {
    return true;
  }
}

/**
 * The categories an agent's charter attaches. Read straight from the charter rather
 * than through a verb: this runs on every wake, and the charter is one small file.
 */
function attachedCategories(repoRoot, agent) {
  if (!agent) return [];
  const out = sk(repoRoot, ['agent', 'show', agent, '--json']);
  if (!out) return [];
  try {
    const parsed = JSON.parse(out);
    const attach = parsed?.charter?.memory?.attach ?? parsed?.memory?.attach;
    return Array.isArray(attach) ? attach.map(String) : [];
  } catch {
    return [];
  }
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolveRepoRoot(here);
  if (!repoRoot) process.exit(0);

  const isDelegateWake = process.env.SIDEKICKS_DELEGATE_WAKE === '1';
  const agent = isDelegateWake ? (process.env.SIDEKICKS_DELEGATE_AGENT || '') : '';
  const lazy = await lazyLoadEnabled(repoRoot);

  // The escape hatch: `sidekicks framework disable criterion.memory-lazy-load` puts the
  // pre-central verbatim listing back, unchanged, for one release.
  if (!lazy) {
    const listing = sk(repoRoot, isDelegateWake ? ['memory', 'list', '--compact'] : ['memory', 'list']);
    if (!listing || listing.startsWith('No local-memory entries')) process.exit(0);
    emit(
      `# Project local memory (sidekicks memory)\n\n`
      + `This project keeps LOCAL-ONLY, git-ignored memory in its central store (distinct from the host/global `
      + `~/.claude memory). Project memory is LOCAL-ONLY here — register decisions with \`sidekicks memory add\` `
      + `and read full entries with \`sidekicks memory show <slug>\`. Effective entries for the active scope:\n\n`
      + listing + `\n`
    );
    return;
  }

  const map = sk(repoRoot, ['memory', 'map']);
  // The empty-store message starts with "No local-memory entries".
  if (!map || map.startsWith('No local-memory entries')) {
    // An empty store is silent EXCEPT in the one case where it is a mistake rather than a fact: the
    // store is git-ignored, so a fresh clone starts empty while its knowledge sits in whatever
    // sources the committed registry names. Saying nothing there is how a session runs a whole task
    // without the memory that would have changed it. It stays a HINT — hydrating pulls from a
    // remote, and starting a network clone unasked at session start is not this hook's call.
    const registered = sk(repoRoot, ['memory', 'source', 'list', '--json']);
    let names = [];
    try { names = (JSON.parse(registered || '{}').sources ?? []).map((s) => s.name); } catch { names = []; }
    if (names.length) {
      emit(
        '# Project local memory (sidekicks memory) — EMPTY, not hydrated\n\n'
        + 'The memory store (.sidekicks/memory/) is git-ignored and holds no entries in this '
        + `checkout, but ${names.length} external source(s) are registered: ${names.join(', ')}.\n\n`
        + 'Hydrate before relying on "there is no memory about this":\n\n'
        + '  node bin/sidekicks memory sync\n'
      );
      return;
    }
    process.exit(0);
  }

  const parts = [
    '# Project local memory (sidekicks memory) — index only',
    '',
    'Memory lives in this repo\'s central store (distinct from the host/global ~/.claude memory). '
      + 'Project memory is LOCAL-ONLY here — register decisions with `sidekicks memory add`, never in '
      + 'the per-CLI global store. The store is also git-ignored: it reaches other checkouts through '
      + '`sidekicks memory publish` / `sync` against a registered source (`memory source list`), not '
      + 'through this repo.',
    '',
    map,
    '',
    'Bodies are NOT loaded. Before performing an action of a listed category, load its pack:',
    '',
    '  node bin/sidekicks memory pack <category>',
    '',
    'Hard rules in a triggered category are mandatory reading. Find one entry with '
      + '`node bin/sidekicks memory query <term>`; read it with `node bin/sidekicks memory show <slug>`.',
  ];

  if (isDelegateWake && agent) {
    const own = sk(repoRoot, ['memory', 'list', '--agent', agent, '--compact']);
    if (own && !own.startsWith('No local-memory entries')) {
      parts.push('', '## Your own memory namespace', '', own);
    }
    // Attached categories: RULE bodies at wake, not on trigger. A standing agent works
    // inside these categories by charter, so a hard rule there is not something it
    // should have to be told about a second time.
    for (const cat of attachedCategories(repoRoot, agent)) {
      const pack = sk(repoRoot, ['memory', 'pack', cat, '--agent', agent]);
      if (!pack) continue;
      const rulesOnly = pack.split('\n## Other entries')[0].trim();
      if (rulesOnly.includes('## Hard rules')) {
        parts.push('', `## Attached category '${cat}' — hard rules (mandatory)`, '', rulesOnly);
      }
    }
  }

  emit(parts.join('\n') + '\n');
}

/** Write the SessionStart additionalContext payload and exit. */
function emit(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    })
  );
  process.exit(0);
}

// Framework gate: `sidekicks framework disable <id>` makes this hook a no-op (exit 0).
await import('./lib/hook-gate.mjs')
  .then((gate) => gate.exitIfDisabled('hook.load-local-memory'))
  .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

await main();
