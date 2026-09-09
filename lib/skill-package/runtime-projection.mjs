// lib/skill-package/runtime-projection.mjs
// "Which files of this skill folder actually ship in a runtime, and what does its metadata say
//  about them afterwards?"
//
// ONE ANSWER, FOUR CONSUMERS. The copy, the hash baseline, the drift comparison and the release
// gate must agree about the projected set or they cannot be reconciled: sk-inherit hashes the
// RUNTIME copy as its drift baseline and compares it against the SOURCE tree, so any filter applied
// on one side and not the other is a permanent false fast-forward that no patch can close. That is
// not hypothetical — `denyFilterHashes` in sk-inherit exists because exactly that happened once.
// So this module returns the file list, the baseline, AND the derived metadata content, and nothing
// downstream re-derives any of them.
//
// WHY A SKILL FOLDER IS NOT ITS RUNTIME. A skill's folder is a source tree: `improvements/` holds
// the funnel's evidence, `evals/` holds trigger fixtures and reports, `tests/` holds its harness.
// None of it is reachable from an invoked runtime path, and none of it travels usefully — the
// forged core's test runner discovers root `tests/` and `lib/*/tests`, never a skill's own. The
// canonical tree keeps all of it; only forged and published copies are projected.
//
// FIRST SEGMENT ONLY, NEVER A BARE SEGMENT AT ANY DEPTH. sk-inherit's DENY set learned this the
// expensive way: a bare `agents` segment matched at any depth ate 41 Antigravity subagents, four
// skills' own `agents/` directories, and produced a permanent false FF because the baseline was
// hashed from the truncated copy while drift compared the full source. A legitimate runtime fixture
// nested at `assets/tests/case.json` must survive; only a TOP-LEVEL `tests/` is development
// evidence.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { walkSkillFiles } from '../skill-lifecycle/scan.mjs';
import { hashContent, isBinaryPath, looksBinary } from '../skill-manifest/hash.mjs';
import { recordModes } from '../skill-manifest/mode.mjs';
import { MANIFEST_NAME, parseManifest } from '../skill-manifest/schema.mjs';
import { upsertManifest } from '../skill-manifest/materialize.mjs';

/**
 * Top-level directories that are skill-development evidence rather than runtime payload.
 *
 * Exported so a gate can name the same three surfaces it refuses, instead of keeping a second copy
 * that drifts from this one.
 */
export const RUNTIME_EXCLUDED_DIRS = Object.freeze(['improvements', 'evals', 'tests']);

/** The component version file, projected alongside the manifest because it also names paths. */
export const VERSION_NAME = 'VERSION.json';

const byteSort = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Compile one skill-relative POSIX glob.
 *
 * Supported, deliberately and only: `**` (any number of segments), `*` (within one segment) and
 * `?` (one character within one segment). A pattern naming a directory matches everything under it,
 * because "exclude improvements" and "exclude improvements/**" are the same intent and demanding
 * the suffix would only produce silently-empty rules.
 */
function compileGlob(pattern) {
  const escaped = pattern
    .split('')
    .map((ch) => {
      if (ch === '*' || ch === '?') return ch;
      return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    })
    .join('')
    // A NUL placeholder, not a space: a space is a legal (if unusual) character in a path, so
    // reusing one would silently turn 'my dir/*' into a match-anything pattern.
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}(?:/.*)?$`);
}

/** Does `rel` sit inside a top-level development directory? Returns the class, or null. */
function developmentClass(rel) {
  const segments = rel.split('/');
  if (segments.length < 2) return null;             // a FILE named `tests` is not a directory
  return RUNTIME_EXCLUDED_DIRS.includes(segments[0]) ? segments[0] : null;
}

/**
 * Rewrite a component `VERSION.json` so its `files` list names only what actually shipped.
 *
 * Ten skills' VERSION.json name `evals/trigger-eval.json`, so projecting the manifest alone would
 * leave a shipped contract pointing at a file the runtime does not carry. Entries are FILTERED, not
 * replaced wholesale: the list is a curated statement about a component, and turning it into a
 * complete file listing would change what it means as a side effect of this change.
 *
 * @returns {string|null} the rewritten text, or null when nothing needed rewriting
 */
function projectVersionJson(text, carried) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;                                    // unreadable is componentVersions' problem
  }
  if (!parsed || !Array.isArray(parsed.files)) return null;
  const kept = parsed.files.filter((f) => typeof f === 'string' && carried.has(f));
  if (kept.length === parsed.files.length) return null;
  return `${JSON.stringify({ ...parsed, files: kept }, null, 2)}\n`;
}

/**
 * Project one skill folder onto the files a runtime carries, with the metadata to match.
 *
 * Errors are RETURNED rather than thrown, so a forge can render every problem across every selected
 * skill in one pass and then fail closed — the same stance `resolveFrameworkPreset` takes.
 *
 * @param {string} skillDir - absolute path to the skill folder
 * @param {{skill?: string, requireManifest?: boolean, deny?: (rel: string) => boolean}} [opts]
 *   `deny` is the caller's structural refusal, applied before policy and unrestorable by an include
 * @returns {{
 *   skill: string,
 *   files: string[],
 *   excluded: Array<{path: string, reason: string, bytes: number}>,
 *   counts: object,
 *   bundle: Record<string, string>,
 *   modes: Record<string, number>,
 *   derived: Record<string, string>,
 *   errors: string[],
 * }}
 */
export function projectSkillRuntime(skillDir, opts = {}) {
  const skill = opts.skill || skillDir.split(/[\\/]/).filter(Boolean).pop() || skillDir;
  const errors = [];
  // A symlink is REFUSED, not quietly skipped. `walkSkillFiles` never returns one as a file row,
  // which is safe — nothing is dereferenced — but silence is the wrong answer here: the copy engine
  // this feeds used to throw on one, because dereferencing an innocuous-looking in-tree link can
  // carry a denied file in under an allowed name, and preserving it would bind the runtime back to
  // its source checkout. Losing the refusal would turn a loud "this skill cannot travel" into a
  // runtime that is quietly missing a file, with a baseline that agrees it was never there.
  const rows = walkSkillFiles(skillDir, {
    onSymlink: (link) => errors.push(
      `skill '${skill}' contains a symlink at '${link.rel}'`
      + `${link.target ? ` -> ${link.target}` : ''} — a skill folder must be self-contained to travel`
    ),
  }).sort((a, b) => byteSort(a.rel, b.rel));

  // ── the authored exception, if any ──────────────────────────────────────────
  let manifest = null;
  let manifestText = null;
  const manifestAbs = join(skillDir, MANIFEST_NAME);
  if (existsSync(manifestAbs)) {
    try {
      manifestText = readFileSync(manifestAbs, 'utf8');
      const read = parseManifest(manifestText, skill, `${skill}/${MANIFEST_NAME}`);
      manifest = read.manifest;
      for (const error of read.errors) errors.push(error);
    } catch (err) {
      errors.push(`skill '${skill}' ${MANIFEST_NAME} is unreadable (${err.message})`);
    }
  } else if (opts.requireManifest) {
    errors.push(
      `skill '${skill}' has no ${MANIFEST_NAME}, so a runtime projection has no baseline to `
      + `describe what it carried — run 'sidekicks skill manifest ${skill} --apply'`
    );
  }

  const authored = manifest?.distribution?.runtime || { exclude: [], include: [] };
  const excludeGlobs = authored.exclude.map((p) => ({ pattern: p, re: compileGlob(p) }));
  const includeGlobs = authored.include.map((p) => ({ pattern: p, re: compileGlob(p) }));

  // ── the caller's own structural refusal, first and unrestorable ────────────
  //
  // A copy engine may refuse a path for reasons that have nothing to do with distribution policy —
  // sk-inherit will not carry a `.log`, a `*.secret.yaml` or a `.env` into any runtime, ever. Those
  // paths must leave the projection too, or the bundle baseline would record a file the copy never
  // wrote and `skill verify` would fail inside the forged core on a file nobody could have shipped.
  // An authored include cannot restore one: this is a safety refusal, not a default.
  const deny = typeof opts.deny === 'function' ? opts.deny : null;

  // ── built-in excludes, then authored excludes, then authored includes ───────
  const excluded = [];
  const kept = [];
  const includeUsed = new Set();
  for (const row of rows) {
    const measure = () => {
      try { return statSync(row.abs).size; } catch { return 0; }
    };
    if (deny && deny(row.rel)) {
      excluded.push({ path: row.rel, reason: 'denied', bytes: measure() });
      continue;
    }
    const devClass = developmentClass(row.rel);
    const authoredHit = excludeGlobs.find((g) => g.re.test(row.rel));
    let reason = null;
    if (devClass) reason = devClass;
    else if (authoredHit) reason = `authored:${authoredHit.pattern}`;

    if (reason) {
      const restore = includeGlobs.find((g) => g.re.test(row.rel));
      if (restore) {
        includeUsed.add(restore.pattern);
        kept.push(row);
        continue;
      }
      excluded.push({ path: row.rel, reason, bytes: measure() });
      continue;
    }
    kept.push(row);
  }

  // An include that restores nothing is dead configuration presented as a reviewed exception. Say
  // so rather than letting it sit in the file implying a decision nobody is making any more.
  for (const g of includeGlobs) {
    if (!includeUsed.has(g.pattern)) {
      errors.push(
        `skill '${skill}' distribution.runtime.include pattern '${g.pattern}' restores nothing — `
        + 'an include is an exception to a default exclusion, not a general allow rule'
      );
    }
  }

  const carried = new Set(kept.map((r) => r.rel));

  // ── protected metadata: validated AFTER includes are applied ───────────────
  //
  // The order matters. A protected path that a built-in exclusion removed is recoverable by an
  // explicit include; checking before includes would make that impossible, and checking nothing
  // would let a manifest ship an entrypoint the runtime does not carry.
  const present = new Set(rows.map((r) => r.rel));
  const protect = (rel, field) => {
    if (!rel || typeof rel !== 'string') return;
    if (!present.has(rel)) return;             // never in the source: not this projection's problem
    if (carried.has(rel)) return;
    errors.push(
      `skill '${skill}' projects away '${rel}', which ${field} names — add it to `
      + 'distribution.runtime.include (with a runtime smoke covering it) or stop naming it'
    );
  };
  protect('SKILL.md', 'the skill body');
  protect(MANIFEST_NAME, 'the manifest itself');
  protect(VERSION_NAME, 'the component version file');
  for (const row of manifest?.entrypoints || []) protect(row.path, 'requires an entrypoint that');
  protect(manifest?.requires?.config?.defaults, 'requires.config.defaults');
  for (const row of manifest?.requires?.framework_rules || []) protect(row.body, 'a framework rule body that');
  for (const row of manifest?.requires?.framework_hooks || []) protect(row.script, 'a framework hook script that');
  for (const row of manifest?.requires?.framework_files || []) protect(row.path, 'requires.framework_files');

  // ── derived metadata content ───────────────────────────────────────────────
  //
  // CONTENT, not files written: the caller decides where a projected copy lands and how it hashes
  // (sk-inherit's tree hasher emits bare hex, the manifest baseline emits 'sha256:<hex>'), and both
  // must see the same bytes or drift reports a change nobody made.
  const derived = {};
  const versionAbs = join(skillDir, VERSION_NAME);
  if (carried.has(VERSION_NAME) && existsSync(versionAbs)) {
    const rewritten = projectVersionJson(readFileSync(versionAbs, 'utf8'), carried);
    if (rewritten !== null) derived[VERSION_NAME] = rewritten;
  }

  const bundle = {};
  const contentFor = (row) => (
    Object.hasOwn(derived, row.rel) ? Buffer.from(derived[row.rel], 'utf8') : readFileSync(row.abs)
  );
  for (const row of kept) {
    if (row.rel === MANIFEST_NAME) continue;         // a manifest never hashes itself
    try {
      const content = contentFor(row);
      bundle[row.rel] = hashContent(content, isBinaryPath(row.rel) || looksBinary(content));
    } catch (err) {
      errors.push(`skill '${skill}' cannot hash '${row.rel}' (${err.message})`);
    }
  }

  const modes = recordModes(skillDir, kept.filter((r) => r.rel !== MANIFEST_NAME));

  if (manifestText !== null && carried.has(MANIFEST_NAME)) {
    // `upsertManifest` is line-level and idempotent, so a skill that lost nothing gets its own
    // bytes back. Recording only a REAL difference keeps `derived` meaning "this file is not its
    // source copy" — which is exactly the question the drift side has to ask.
    const projected = upsertManifest(manifestText, {
      add: { python: [], node: [], binaries: [], framework_files: [], sibling_skills: [] },
      derived: null,
      derivedChanged: false,
      bundle,
      bundleChanged: true,
      modes,
      modesChanged: true,
    });
    if (projected !== manifestText) derived[MANIFEST_NAME] = projected;
  }

  // ── counts, byte-stable ────────────────────────────────────────────────────
  const byClass = {};
  for (const name of RUNTIME_EXCLUDED_DIRS) byClass[name] = { files: 0, bytes: 0 };
  byClass.authored = { files: 0, bytes: 0 };
  byClass.denied = { files: 0, bytes: 0 };
  for (const row of excluded) {
    const key = row.reason.startsWith('authored:') ? 'authored' : row.reason;
    byClass[key].files += 1;
    byClass[key].bytes += row.bytes;
  }
  let copiedBytes = 0;
  for (const row of kept) {
    if (Object.hasOwn(derived, row.rel)) {
      copiedBytes += Buffer.byteLength(derived[row.rel], 'utf8');
      continue;
    }
    try { copiedBytes += statSync(row.abs).size; } catch { /* counted as zero, reported nowhere else */ }
  }

  return {
    skill,
    files: kept.map((r) => r.rel).sort(byteSort),
    excluded: excluded.sort((a, b) => byteSort(a.path, b.path)),
    counts: {
      copied_files: kept.length,
      copied_bytes: copiedBytes,
      excluded_files: excluded.length,
      excluded_bytes: excluded.reduce((sum, r) => sum + r.bytes, 0),
      by_class: byClass,
    },
    bundle,
    modes,
    derived,
    errors: [...new Set(errors)].sort(byteSort),
  };
}

/**
 * The projected source-side hash map, in the bare-hex shape sk-inherit's tree hasher produces.
 *
 * THIS IS THE HALF THAT MAKES DRIFT HONEST. The runtime copy carries DERIVED metadata — a manifest
 * whose bundle describes the projected files, a VERSION.json whose list names only what shipped —
 * so hashing the source folder as-is would report `skill.manifest.yaml` and `VERSION.json` as
 * changed on every single run, for ever, on every skill. Both sides must be hashed through the same
 * projection.
 *
 * @param {ReturnType<typeof projectSkillRuntime>} projection
 * @param {string} skillDir
 * @param {(abs: string, derivedContent: Buffer|null) => string} hashFn - the caller's hasher
 * @returns {Record<string, string>} posix rel -> hash, exactly the runtime's own key set
 */
export function projectedSourceHashes(projection, skillDir, hashFn) {
  const out = {};
  for (const rel of projection.files) {
    const derivedContent = Object.hasOwn(projection.derived, rel)
      ? Buffer.from(projection.derived[rel], 'utf8')
      : null;
    const hash = hashFn(join(skillDir, ...rel.split('/')), derivedContent);
    if (hash !== null && hash !== undefined) out[rel] = hash;
  }
  return out;
}
