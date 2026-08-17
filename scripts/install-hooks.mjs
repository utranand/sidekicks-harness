#!/usr/bin/env node
// scripts/install-hooks.mjs — point git at the committed .githooks directory.
//
// Run once after cloning:  node scripts/install-hooks.mjs
// Idempotent: re-running just re-confirms the setting.
//
// This sets core.hooksPath to the repo-relative `.githooks` dir so the committed
// pre-commit hook (which guards the CLAUDE.md / GEMINI.md → AGENTS.md mirror)
// runs for everyone, with no per-developer copying into .git/hooks.

import { spawnSync } from 'node:child_process';
import { existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hooksDir = join(repoRoot, '.githooks');
const preCommit = join(hooksDir, 'pre-commit');

if (!existsSync(preCommit)) {
  console.error(`✖ Expected hook not found at ${preCommit}`);
  process.exit(1);
}

// Ensure the hook is executable (git requires this; clones may lose the bit).
// On Windows, chmod is a no-op — Git for Windows handles hook executability itself.
if (process.platform !== 'win32') {
  chmodSync(preCommit, 0o755);
}

const res = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (res.status !== 0) {
  console.error('✖ Failed to set core.hooksPath. Is this a git repo?');
  process.exit(res.status ?? 1);
}

console.log('✔ Git hooks installed: core.hooksPath → .githooks');
console.log('  pre-commit now guards the CLAUDE.md / GEMINI.md → AGENTS.md mirror.');
