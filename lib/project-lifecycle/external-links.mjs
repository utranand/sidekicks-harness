// lib/project-lifecycle/external-links.mjs
// Shared helpers for external (symlinked) projects — projects created by
// `sidekicks project link <path>` that point at an out-of-tree directory
// (typically another volume). Reused by link / unlink / remove.
//
// A linked project's symlink target is a machine-specific absolute path, so the
// link itself must never be committed — it would check out broken on every other
// clone. These helpers keep a single managed block in the repo-root .gitignore
// listing each linked project's path, and add/remove entries idempotently.
//
// All text handling is CRLF-tolerant (a .gitignore cloned on Windows carries \r),
// and every write goes through writeAtomic. Zero npm dependencies.

import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../fs-safety/fsx.mjs';

export const BLOCK_BEGIN =
  '# BEGIN sidekicks external project links (managed by `sidekicks project link`)';
export const BLOCK_END = '# END sidekicks external project links';

const BLOCK_HEADER = [
  BLOCK_BEGIN,
  '# Each entry is a projects/<name> symlink to an out-of-tree directory. The target path is',
  '# local to this machine, so the link is never committed — re-run `sidekicks project link',
  '# <path> <name>` on another machine to recreate the binding. The project\'s own metadata',
  '# (manifest.yaml, config.yaml, index.json) travels inside the linked repo.',
];

/**
 * Split text into lines, tolerating CRLF / lone-CR line endings.
 * @param {string} text
 * @returns {string[]}
 */
function toLines(text) {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Read the repo-root .gitignore as a line array (empty array if absent).
 * @param {string} repoRoot
 * @returns {string[]}
 */
function readGitignoreLines(repoRoot) {
  const p = join(repoRoot, '.gitignore');
  if (!existsSync(p)) return [];
  try {
    return toLines(readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Locate the managed block within `lines`.
 * @param {string[]} lines
 * @returns {{ start: number, end: number } | null} inclusive indices, or null if absent.
 */
function findBlock(lines) {
  const start = lines.findIndex((l) => l.trim() === BLOCK_BEGIN);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && l.trim() === BLOCK_END);
  if (end === -1) return null;
  return { start, end };
}

/**
 * The current entries inside the managed block (path lines only, comments excluded).
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function listExternalIgnores(repoRoot) {
  const lines = readGitignoreLines(repoRoot);
  const block = findBlock(lines);
  if (!block) return [];
  return lines
    .slice(block.start + 1, block.end)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/**
 * Write `lines` back to the repo-root .gitignore (trailing newline enforced).
 * @param {string} repoRoot
 * @param {string[]} lines
 */
function writeGitignoreLines(repoRoot, lines) {
  // Collapse any trailing blank lines, then guarantee exactly one final newline.
  const trimmed = [...lines];
  while (trimmed.length && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
  writeAtomic(join(repoRoot, '.gitignore'), trimmed.join('\n') + '\n');
}

/**
 * Idempotently add `relPath` (e.g. "projects/evo-sk") to the managed .gitignore block,
 * creating the block if it does not yet exist. No-op if the entry is already present.
 *
 * @param {string} repoRoot
 * @param {string} relPath - repo-relative, forward-slash path of the linked project.
 */
export function addExternalIgnore(repoRoot, relPath) {
  const entry = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const ignoreLine = `/${entry}`;
  let lines = readGitignoreLines(repoRoot);
  const block = findBlock(lines);

  if (!block) {
    // Append a fresh block at the end.
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(...BLOCK_HEADER, ignoreLine, BLOCK_END);
    writeGitignoreLines(repoRoot, lines);
    return;
  }

  const body = lines.slice(block.start + 1, block.end);
  if (body.some((l) => l.trim() === ignoreLine)) return; // already present
  lines.splice(block.end, 0, ignoreLine); // insert just before END
  writeGitignoreLines(repoRoot, lines);
}

/**
 * Remove `relPath` from the managed .gitignore block. Drops the whole block when it
 * becomes empty. No-op if the block or entry is absent.
 *
 * @param {string} repoRoot
 * @param {string} relPath
 */
export function removeExternalIgnore(repoRoot, relPath) {
  const entry = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const ignoreLine = `/${entry}`;
  let lines = readGitignoreLines(repoRoot);
  const block = findBlock(lines);
  if (!block) return;

  // Filter the entry out of the block body.
  const kept = [];
  for (let i = block.start + 1; i < block.end; i++) {
    if (lines[i].trim() === ignoreLine) continue;
    kept.push(lines[i]);
  }

  const remainingEntries = kept.filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  const before = lines.slice(0, block.start);
  const after = lines.slice(block.end + 1);

  if (remainingEntries.length === 0) {
    // Block is now empty of real entries — remove the whole block.
    writeGitignoreLines(repoRoot, [...before, ...after]);
    return;
  }

  writeGitignoreLines(repoRoot, [...before, lines[block.start], ...kept, lines[block.end], ...after]);
}

/**
 * True if `absPath` is a symlink (or Windows junction), non-throwing.
 * @param {string} absPath
 * @returns {boolean}
 */
export function isSymlink(absPath) {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}
