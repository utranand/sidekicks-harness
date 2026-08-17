// lib/framework-lifecycle/_body.mjs
// Where a framework entry's BODY and SCRIPT actually live, in a source checkout and in a mounted
// consumer workspace alike.
//
// Why this module exists. Every registry entry records `body_at` / `script` as a REPO-RELATIVE path,
// which was true for exactly one of the two places the framework runs. In a mounted workspace
// `core init` rewrites hook wiring to `.sidekicks-core/scripts/...` (lib/core-lifecycle/_wiring.mjs)
// and puts an `@.sidekicks-core/CLAUDE.framework.md` import into the workspace CLAUDE.md
// (lib/core-lifecycle/_seed.mjs) — so the file the entry names is real, just not under the workspace
// root. `framework doctor` and `framework show` both resolved against the workspace root only, which
// reported seven framework-owned hooks missing in a perfectly healthy consumer install, and reported
// `body_exists: true` for floor rules whose prose had been dropped from the forged runtime.
//
// Two separate questions, two functions:
//   - resolveOwnedFile — does this file exist anywhere the framework legitimately keeps it?
//   - bodyTexts        — what text could carry this entry's prose? (existence is not the answer;
//                        thirty core entries share one CLAUDE.md, so only content distinguishes them)
//
// Zero npm dependencies — node:* only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The core's own instruction surface, which carries the framework rule bodies under a mount. */
const CORE_INSTRUCTION_DOC = 'CLAUDE.framework.md';

/**
 * Resolve a framework-owned file that may live in the workspace OR in the mounted core.
 *
 * @param {string} repoRoot
 * @param {string|null} coreDir - absolute path of the mounted core, or null when not mounted
 * @param {string[]} segments - path segments relative to whichever root holds the file
 * @returns {string|null} the absolute path that exists, or null when neither root has it
 */
export function resolveOwnedFile(repoRoot, coreDir, segments) {
  const inWorkspace = join(repoRoot, ...segments);
  if (existsSync(inWorkspace)) return inWorkspace;
  if (!coreDir) return null;
  const inCore = join(coreDir, ...segments);
  return existsSync(inCore) ? inCore : null;
}

/**
 * Every readable text that could carry `bodyAt`'s prose, workspace first.
 *
 * Searching the whole candidate set rather than one resolved path is what makes a marker check true
 * in a source checkout AND a consumer install without teaching the registry about mounts.
 *
 * @param {string} repoRoot
 * @param {string|null} coreDir
 * @param {string} bodyAt - repo-relative path recorded on the entry
 * @returns {Array<{rel: string, text: string}>} empty when the body exists nowhere
 */
export function bodyTexts(repoRoot, coreDir, bodyAt) {
  const segments = bodyAt.split(/[\\/]/);
  /** @type {Array<[string, string]>} */
  const candidates = [[bodyAt, join(repoRoot, ...segments)]];
  if (coreDir) {
    // CLAUDE.framework.md first: it is the core's own instruction surface, and the core's plain
    // instruction file is the same body without the mount preamble.
    //
    // Both names are accepted: entries now record 'AGENTS.md' (the canonical instruction file since
    // the Rule 6 symlink inversion), but a core forged BEFORE that flip records 'CLAUDE.md'. A
    // consumer install must resolve either, or upgrading the framework would silently orphan every
    // core-entry body.
    if (segments.length === 1 && (segments[0] === 'AGENTS.md' || segments[0] === 'CLAUDE.md')) {
      candidates.push([
        `.sidekicks-core/${CORE_INSTRUCTION_DOC}`,
        join(coreDir, CORE_INSTRUCTION_DOC),
      ]);
    }
    candidates.push([`.sidekicks-core/${segments.join('/')}`, join(coreDir, ...segments)]);
  }
  const out = [];
  for (const [rel, abs] of candidates) {
    if (!existsSync(abs)) continue;
    try {
      out.push({ rel, text: readFileSync(abs, 'utf8') });
    } catch { /* unreadable is the same as absent for this check */ }
  }
  return out;
}

/**
 * Whether an entry's prose is still present wherever its body lives.
 *
 * @param {{body_at: string|null, body_marker: string|null}} entry
 * @param {string} repoRoot
 * @param {string|null} coreDir
 * @returns {{ fileFound: boolean, markerFound: boolean|null, searched: string[] }}
 *   `markerFound` is null when the entry records no marker — nothing to assert, not a failure.
 */
export function inspectBody(entry, repoRoot, coreDir) {
  if (!entry.body_at) return { fileFound: false, markerFound: null, searched: [] };
  const bodies = bodyTexts(repoRoot, coreDir, entry.body_at);
  const searched = bodies.map((b) => b.rel);
  if (!bodies.length) return { fileFound: false, markerFound: null, searched };
  if (!entry.body_marker) return { fileFound: true, markerFound: null, searched };
  return {
    fileFound: true,
    markerFound: bodies.some((b) => b.text.includes(entry.body_marker)),
    searched,
  };
}
