// lib/sk-cli/core-mount.mjs
// The core-mount contract: what makes a directory a mounted FRAMEWORK CORE rather than a workspace.
//
// A workspace repo consumes the framework as a git submodule at <repoRoot>/.sidekicks-core/. That
// checkout is a forged Sidekicks runtime, so it carries its OWN top-level .sidekicks/ (RULES.md,
// hooks/, framework.example.yaml, config.example.yaml, skills/). Both root resolvers key on
// "nearest ancestor containing .sidekicks/":
//
//   - lib/sk-cli/paths.mjs  resolveRepoRoot() — walks up from process.cwd()
//   - scripts/lib/hook-gate.mjs    hookRepoRoot()    — walks up from the SCRIPT's own location
//
// Without a marker, a hook living at .sidekicks-core/scripts/*.mjs resolves .sidekicks-core as its
// root and binds to the CORE's state instead of the workspace's. That is not hypothetical: the same
// class of leak was observed with a symlinked scripts/ and is recorded in
// .sidekicks/memory/inherited-runtime-scripts-must-be-copied.md — a runtime with an empty
// .sidekicks/memory/ emitted the source repo's entire memory store as SessionStart context.
//
// So a core checkout carries a marker file at its root, and both resolvers walk PAST any directory
// that carries it: "I am a core, my root is my parent."
//
// Zero third-party imports — node:* only.

import { existsSync, readFileSync } from "node:fs";
import { basename, join, sep } from "node:path";

/**
 * Marker file at the root of a framework-core checkout.
 *
 * DUPLICATED, deliberately, in scripts/lib/hook-gate.mjs: that module must not static-import from
 * lib/ (its contract is to survive a partial checkout and fail open). Change both together.
 */
export const CORE_MARKER = ".sidekicks-core.json";

/** Mount point of the core submodule, relative to a workspace repo root. */
export const CORE_DIR = ".sidekicks-core";

/** Marker schema version this build writes and understands. */
export const CORE_MARKER_SCHEMA = 1;

/**
 * Is `dir` a framework-core checkout (as opposed to a workspace repo root)?
 *
 * Presence of the marker file is the whole test — cheap enough to run on every ancestor during a
 * root walk, and it never reads or parses the file.
 *
 * @param {string} dir Absolute path of a candidate directory.
 * @returns {boolean}
 */
export function isCoreCheckout(dir) {
  return existsSync(join(dir, CORE_MARKER));
}

/**
 * Is `dir` a core checkout that is MOUNTED — i.e. sitting at the mount point of the repo above it?
 *
 * Both conditions are required, and the name is not decoration. A framework core can legitimately be
 * checked out somewhere that is NOT a mount: a standalone clone, or the service checkout inside the
 * Sidekicks source repo (`projects/global/services/sidekicks-harness/src`) where it is forged. Those
 * are their own roots and must keep running their own CLI — demoting every marked directory broke
 * exactly that, silently resolving the SOURCE repo instead.
 *
 * Only a core at `<parent>/.sidekicks-core/` is being consumed by the repo above it, and only that one
 * gets skipped during a root walk.
 *
 * @param {string} dir Absolute path of a candidate directory.
 * @returns {boolean}
 */
export function isMountedCore(dir) {
  return samePathName(basename(dir), CORE_DIR) && isCoreCheckout(dir);
}

/**
 * Compare two path components the way the filesystem does: case-sensitively on POSIX,
 * case-insensitively on Windows (NTFS is case-insensitive, case-preserving).
 *
 * This matters more than it looks. `isMountedCore` is the mechanism that stops a hook from reading the
 * CORE's memory store instead of the workspace's. A byte-exact compare against the literal
 * `.sidekicks-core` means a path segment that surfaces with different casing — from a user's `cd`, or
 * from an OS-canonicalized `process.cwd()` — silently defeats the skip and re-opens that leak on
 * Windows only. Same rule as linkResolvesTo in lib/sk-cli/skill-links.mjs.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function samePathName(a, b) {
  return process.platform === "win32"
    ? String(a).toLowerCase() === String(b).toLowerCase()
    : a === b;
}

/**
 * Is `real` the same path as `root`, or inside it? Case-folded on Windows.
 *
 * Shared so `core doctor`'s escaped-link check and the link healer answer containment the same way —
 * a doctor-specific reimplementation was reporting healthy Windows mounts as broken.
 *
 * @param {string} real Absolute, already-realpath'd path.
 * @param {string} root Absolute directory it should live in.
 * @returns {boolean}
 */
export function isInsidePath(real, root) {
  if (process.platform === "win32") {
    const r = String(real).toLowerCase();
    const b = String(root).toLowerCase();
    return r === b || r.startsWith(b + sep);
  }
  return real === root || real.startsWith(root + sep);
}

/**
 * Absolute path of the core mount inside a workspace, or null when nothing is mounted.
 *
 * A directory at .sidekicks-core/ that does NOT carry the marker is not treated as a core — it is
 * someone else's directory, and claiming it would be worse than reporting "not mounted".
 *
 * @param {string} repoRoot Absolute path of the workspace repo root.
 * @returns {string|null}
 */
export function coreDirOf(repoRoot) {
  const abs = join(repoRoot, CORE_DIR);
  return isCoreCheckout(abs) ? abs : null;
}

/**
 * Read and shallow-validate a core checkout's marker.
 *
 * Returns null for "no marker" and for "marker present but unreadable/unparseable" alike: callers
 * are diagnostics (`core status`, `core doctor`) that report the absence, and none of them should
 * die on a corrupt file.
 *
 * @param {string} dir Absolute path of the core checkout.
 * @returns {{schema: number, name: string, version: string, layout: number,
 *            forged_at: string|null, source_commit: string|null}|null}
 */
export function readCoreMarker(dir) {
  const abs = join(dir, CORE_MARKER);
  if (!existsSync(abs)) return null;
  let obj;
  try {
    obj = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  return {
    schema: typeof obj.schema === "number" ? obj.schema : 0,
    name: typeof obj.name === "string" ? obj.name : "",
    version: typeof obj.version === "string" ? obj.version : "",
    layout: typeof obj.layout === "number" ? obj.layout : 0,
    forged_at: typeof obj.forged_at === "string" ? obj.forged_at : null,
    source_commit: typeof obj.source_commit === "string" ? obj.source_commit : null,
  };
}

/**
 * The roots that may hold FRAMEWORK-owned files, most specific first.
 *
 * Framework code lives in exactly one of two places and the caller almost never knows which: at the
 * repo root in a source checkout or a standalone core, and under `.sidekicks-core/` in a consumer
 * workspace. Every caller that resolved a `lib/...` path against `repoRoot` alone was therefore
 * correct in one of those worlds and wrong in the other — `catalog check` reported 159 dispatch
 * modules and a packaged snapshot as missing in a perfectly healthy mount (INC-2026-09-04-01, F-3).
 *
 * `resolveRepoRoot()` deliberately answers the OTHER question ("which workspace am I in") and walks
 * past a mount; this is its counterpart, and the two must not be conflated.
 *
 * @param {string} repoRoot Absolute path of the workspace repo root.
 * @returns {ReadonlyArray<{root: string, origin: 'workspace'|'core', label: string}>}
 *   `label` is the display prefix for a hit under that root ('' for the repo root), kept separate
 *   from `origin` so a message can name WHERE it looked.
 */
export function frameworkRoots(repoRoot) {
  const roots = [
    // A standalone core checkout IS the framework, so root 0's origin depends on what it is, not on
    // its position. Reporting it as 'workspace' would make a core's own findings read as a
    // consumer's.
    { root: repoRoot, origin: isCoreCheckout(repoRoot) ? "core" : "workspace", label: "" },
  ];
  const mounted = coreDirOf(repoRoot);
  if (mounted) roots.push({ root: mounted, origin: "core", label: CORE_DIR });
  return Object.freeze(roots);
}

/**
 * The single root that holds framework CODE — the mount when there is one, else the repo root.
 *
 * For callers that must build one absolute path (a gate's argv, a spawn target) rather than search:
 * there is no "try the other one" for an argv.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function frameworkRootOf(repoRoot) {
  return coreDirOf(repoRoot) || repoRoot;
}

/**
 * Find a framework-owned file across `frameworkRoots()`, workspace first.
 *
 * Takes the ROOTS array rather than a repoRoot on purpose: a single catalog audit resolves a couple
 * of hundred paths, and re-deriving the mount for each one turns one `existsSync` into two.
 *
 * @param {ReadonlyArray<{root: string, origin: string, label: string}>} roots
 * @param {string[]} segments Path segments relative to whichever root holds the file.
 * @returns {{abs: string, origin: string, rel: string}|null} null when no root has it.
 *   `rel` is the POSIX display path, prefixed with the root's label ('.sidekicks-core/lib/x.mjs').
 */
export function resolveOwned(roots, segments) {
  for (const { root, origin, label } of roots) {
    const abs = join(root, ...segments);
    if (!existsSync(abs)) continue;
    return { abs, origin, rel: label ? `${label}/${segments.join("/")}` : segments.join("/") };
  }
  return null;
}

/** How `resolveOwned` describes the places it looked, for a finding that has to name them. */
export function describeRoots(roots) {
  return roots.map((r) => (r.label ? `${r.label}/` : "the workspace")).join(" nor ");
}
