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
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.wasm', '.dylib', '.so',
]);

/** @param {string} p @returns {boolean} */
export function isBinaryPath(p) {
  return BINARY_EXT.has(extname(p).toLowerCase());
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
