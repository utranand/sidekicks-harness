// lib/skill-manifest/hash.mjs
// LF-normalized content hashing for skill manifests.
//
// WHY NORMALIZE. The baseline is committed and compared on both macOS and Windows. A Windows
// checkout with core.autocrlf=true rewrites every text file's line endings on the way to disk,
// so a raw byte hash would report a phantom drift for every text file in the repo the moment
// anyone verified on Windows. `.sidekicks/inherit.json` already hashes this way; this module is
// the lib/ equivalent so the framework and the inherit skill agree on what "same file" means
// (asserted by tests/skills/skill-manifest.test.mjs).
//
// Binary files are hashed raw: normalizing them would corrupt the very bytes being pinned.
//
// Zero npm dependencies — node:* only.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

// Extensions hashed raw. Anything not listed is treated as text and LF-normalized.
// Deliberately a denylist of KNOWN binaries rather than an allowlist of known text: a new text
// extension appearing in a skill must hash consistently across platforms without an edit here,
// whereas a new binary type is rare and visibly wrong if it lands in the text path.
// Extended 2026-09-05 with the compiled, archive and Windows formats the original list missed.
// Hashing one of these as text is deterministic but LOSSY: a `\r\n` byte pair inside a .pyc, a
// .whl or a .dll is DATA, and normalizing it to `\n` makes two different files hash the same. The
// original list was written from this repo's own POSIX corpus, and a Windows-authored skill is the
// likeliest carrier of what it missed (INC-2026-09-05-02, X-6).
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.wasm', '.dylib', '.so',
  '.exe', '.dll', '.pyd', '.pyc', '.bin', '.jar', '.whl', '.tar', '.7z', '.node', '.class',
]);

/** @param {string} p @returns {boolean} */
export function isBinaryPath(p) {
  return BINARY_EXT.has(extname(p).toLowerCase());
}

/**
 * Does this content hold bytes no text file would?
 *
 * A denylist can only know the extensions somebody thought of. A NUL byte is the standard, cheap
 * "this is not text" signal — what `git` and `file(1)` both use — and it is consulted ONLY when the
 * extension said nothing, so a known-text file is never re-examined and a known-binary one never
 * needs to be. First 8KB, because a file that is binary is binary near its start.
 *
 * @param {Buffer|string} content
 * @returns {boolean}
 */
export function looksBinary(content) {
  if (typeof content === 'string') return content.includes('\u0000');
  const n = Math.min(content.length, 8192);
  for (let i = 0; i < n; i++) if (content[i] === 0) return true;
  return false;
}

/**
 * Hash a buffer/string the way the baseline records it.
 *
 * @param {Buffer|string} content
 * @param {boolean} binary - hash raw bytes instead of normalizing line endings
 * @returns {string} `sha256:<hex>`
 */
export function hashContent(content, binary = false) {
  const h = createHash('sha256');
  // The extension is the fast path; the NUL sniff is the backstop for one it does not name.
  if (!binary && looksBinary(content)) binary = true;
  if (binary) {
    h.update(content);
  } else {
    const text = typeof content === 'string' ? content : content.toString('utf8');
    // CRLF and lone CR both collapse to LF. A file that differs ONLY in line endings
    // must hash identically, or the Windows checkout reports the whole tree as drifted.
    h.update(text.replace(/\r\n?/g, '\n'), 'utf8');
  }
  return `sha256:${h.digest('hex')}`;
}

/**
 * Hash one file on disk. Returns null when the file cannot be read — callers distinguish
 * "absent" from "different", so an unreadable file must not masquerade as a hash mismatch.
 *
 * @param {string} absPath
 * @returns {string|null}
 */
export function hashFile(absPath) {
  try {
    const binary = isBinaryPath(absPath);
    return hashContent(readFileSync(absPath), binary);
  } catch {
    return null;
  }
}
