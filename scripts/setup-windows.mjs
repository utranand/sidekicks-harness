#!/usr/bin/env node
// scripts/setup-windows.mjs — Recreate symlinks on Windows.
//
// On Windows with core.symlinks=false (the default), git checks out symlinks as
// plain text files containing the target path. This script replaces those text
// placeholders with real filesystem links:
//   - Directory symlinks (.claude/skills, .agent/skills) use junctions (no admin
//     required, work on all Windows versions with NTFS).
//   - File symlinks (CLAUDE.md, GEMINI.md) use file symlinks (requires Developer
//     Mode on Windows 10+, or admin privileges; falls back to file copy).
//
// Idempotent: re-running is safe — existing valid symlinks are left alone.
// Run once after cloning:  node scripts/setup-windows.mjs

import { existsSync, lstatSync, readFileSync, unlinkSync, symlinkSync, rmSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { ensureSkillLinks } from '../lib/sk-cli/skill-links.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'win32') {
  console.log('Not Windows — symlinks are handled natively by git. Nothing to do.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Symlink definitions
// ---------------------------------------------------------------------------

const FILE_LINKS = [
  { link: join(repoRoot, 'CLAUDE.md'), target: 'AGENTS.md' },
  { link: join(repoRoot, 'GEMINI.md'), target: 'AGENTS.md' },
];

let errors = 0;

// ---------------------------------------------------------------------------
// Directory links — delegate to the shared, self-healing CLI implementation
// (junctions on Windows). This is the SAME code the `sidekicks` CLI runs on
// every invocation, so there is one cross-platform implementation, not a
// Windows-only fork. These links are not tracked in git.
// ---------------------------------------------------------------------------

ensureSkillLinks(repoRoot, (msg) => console.log(`  ${msg}`));
console.log('  OK  .claude/skills, .agent/skills, .agents/skills, .gemini/skills (ensured via shared skill-links)');

// ---------------------------------------------------------------------------
// File links — try symlink first, fall back to copy
// ---------------------------------------------------------------------------

for (const { link, target } of FILE_LINKS) {
  const relLink = link.slice(repoRoot.length + 1);
  try {
    const stat = lstatSync(link);
    if (stat.isSymbolicLink()) {
      console.log(`  OK  ${relLink} (already a symlink)`);
      continue;
    }
    // Check if it's a git placeholder (small file containing the target name).
    const content = readFileSync(link, 'utf8').trim();
    const absTarget = resolve(dirname(link), target);
    const targetContent = readFileSync(absTarget, 'utf8');

    if (content === targetContent) {
      // Already a valid copy (perhaps from a previous run with copy fallback).
      console.log(`  OK  ${relLink} (content matches ${target})`);
      continue;
    }

    if (content === target) {
      // Git placeholder — remove it.
      console.log(`  FIX ${relLink} (was text placeholder: '${content}')`);
      unlinkSync(link);
    } else {
      // Divergent copy — replace.
      console.log(`  FIX ${relLink} (divergent content — replacing)`);
      unlinkSync(link);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`  ERR ${relLink}: ${err.message}`);
      errors++;
      continue;
    }
  }

  const absTarget = resolve(dirname(link), target);
  if (!existsSync(absTarget)) {
    console.error(`  ERR ${relLink}: target '${absTarget}' does not exist`);
    errors++;
    continue;
  }

  // Try file symlink first (requires Developer Mode or admin).
  try {
    symlinkSync(target, link, 'file');
    console.log(`  OK  ${relLink} -> ${target} (symlink created)`);
    continue;
  } catch {
    // Symlink not available — fall back to copy.
  }

  // Fallback: copy the file content.
  try {
    copyFileSync(absTarget, link);
    console.log(`  OK  ${relLink} (copied from ${target} — symlink unavailable, using copy fallback)`);
    console.log(`      Note: edits to ${target} must be manually copied to ${relLink}`);
  } catch (err) {
    console.error(`  ERR ${relLink}: failed to copy: ${err.message}`);
    errors++;
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
if (errors > 0) {
  console.error(`Done with ${errors} error(s). Some symlinks may not be set up correctly.`);
  console.error('Try running this script from an elevated (admin) terminal, or enable Developer Mode.');
  process.exit(1);
} else {
  console.log('All symlinks set up successfully.');
  console.log('');
  console.log('If file symlinks used copy fallback, keep CLAUDE.md and GEMINI.md in sync');
  console.log('with AGENTS.md manually. Enable Developer Mode in Windows Settings to get');
  console.log('real symlinks on the next run.');
}
