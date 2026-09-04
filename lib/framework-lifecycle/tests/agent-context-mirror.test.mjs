// lib/framework-lifecycle/tests/agent-context-mirror.test.mjs
// Enforces the agent-context mirror invariant: CLAUDE.md (Claude Code) and
// GEMINI.md (Gemini CLI) must be symlinks pointing at AGENTS.md, so every
// agent tool reads identical bytes and the files can never drift.
//
// AGENTS.md is the canonical instruction file (Rule 6): it is the CLI-neutral
// standard filename, read directly by Codex and Antigravity.
//
// On Windows with core.symlinks=false, git checks out symlinks as plain text
// files containing the target path. The test handles this gracefully: it
// verifies the placeholder target is correct and that content matches AGENTS.md
// when real symlinks exist (either natively or after running setup-windows.mjs).
//
// If a contributor replaces a symlink with a divergent copy, this test fails.
//
// Colocated under lib/ so it travels into a forged core: the `parity` gate names it, and a mounted
// workspace could not run a suite that lives only in repo-root tests/ (INC-2026-09-04-02, N-3).
// .githooks/pre-commit still runs this file where it exists and falls back to checking the invariant
// directly where it does not, so the pre-commit path is unaffected by the move.
// Uses only node:test + node:assert/strict — no third-party imports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readlinkSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// lib/framework-lifecycle/tests/ -> lib/framework-lifecycle -> lib -> the framework root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const isWindows = process.platform === 'win32';

// Mirror files keyed by the CLI tool that consumes them.
const MIRRORS = [
  ['CLAUDE.md', 'Claude Code'],
  ['GEMINI.md', 'Gemini CLI'],
];

for (const [name, tool] of MIRRORS) {
  test(`${name} mirrors AGENTS.md as a symlink (${tool})`, () => {
    const path = join(repoRoot, name);

    assert.ok(existsSync(path), `${name} is missing — ${tool} needs it as a mirror of AGENTS.md`);

    const stat = lstatSync(path);

    if (stat.isSymbolicLink()) {
      // Real symlink — full verification (works on all platforms).
      assert.equal(
        readlinkSync(path),
        'AGENTS.md',
        `${name} must point at AGENTS.md (relative), so the mirror survives clone/move.`,
      );

      // Defensive: resolved content is byte-identical to AGENTS.md.
      assert.equal(
        readFileSync(path, 'utf8'),
        readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8'),
        `${name} content diverges from AGENTS.md — the symlink target is wrong.`,
      );
    } else if (isWindows) {
      // Windows without symlink privilege (core.symlinks=false, no Developer Mode).
      // Two states are valid here, both produced by the project's own tooling:
      //   1. Git symlink placeholder — a tiny text file whose content is the
      //      target path 'AGENTS.md' (the pre-setup checkout state).
      //   2. Copy fallback — a regular file byte-identical to AGENTS.md, which
      //      scripts/setup-windows.mjs writes when it cannot create a symlink.
      //      This is the BEST available mirror on such hosts (Codex/Gemini read
      //      real content), so the test must accept the state its own setup
      //      script creates — rejecting it would make every commit impossible.
      const content = readFileSync(path, 'utf8');
      const isPlaceholder = content.trim() === 'AGENTS.md';
      const isCopy = content === readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
      assert.ok(
        isPlaceholder || isCopy,
        `${name} on Windows must be either the git placeholder 'AGENTS.md' or a copy ` +
          `byte-identical to AGENTS.md. It is neither (it has drifted). ` +
          `Run 'node scripts/setup-windows.mjs' to restore the mirror.`,
      );
    } else {
      // Non-Windows, non-symlink — this is always an error.
      assert.fail(
        `${name} must be a symlink to AGENTS.md, not a copy. A copy can drift; ` +
          `recreate it with: ln -sf AGENTS.md ${name}`,
      );
    }
  });
}
