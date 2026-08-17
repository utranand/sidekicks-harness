// lib/sk-cli/skill-links.mjs
// Self-healing host-level skill links.
//
// Skills are canonical at .agents/skills/ (RULES.md Rule 3). The host-level
// exposure directories — one per supported agent CLI (.claude/skills for Claude
// Code, .agent/skills for Antigravity, .agents/skills for the AGENTS.md-standard
// CLIs such as Codex, .gemini/skills for Gemini CLI) — are folder-level links
// pointing at that canonical folder. They are NOT tracked in git — a committed
// symlink checks out as a plain-text stub on Windows (core.symlinks=false),
// which silently breaks skill discovery — so the CLI (re)creates them locally
// on every invocation instead. Adding support for a new CLI means adding one
// LINKS entry here (see docs/guide/multi-cli-compatibility.md).
//
// Cross-platform by design (CLAUDE.md "develop on both macOS and Windows"):
//   - Windows  → NTFS junction (no admin/Developer-Mode privilege required).
//   - POSIX    → relative directory symlink.
//
// Idempotent and best-effort: a correct link is left untouched; a missing,
// broken, or stub link is replaced; a genuine non-link directory is left alone
// (never destroy real data). All failures are swallowed via the caller's log —
// link upkeep must never break a CLI verb.
//
// A second pass, ensureCoreSkillOverlay, applies the same mechanics one level down: when the
// framework is mounted as a submodule at .sidekicks-core/, its skills are projected into
// .agents/skills as per-skill links so Rule 3's single canonical location still holds.

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { coreDirOf, readCoreMarker } from "./core-mount.mjs";
import { EXPOSURE_LINKS, SKILLS_ROOT_SEGMENTS } from "./skill-trees.mjs";

// The delimiters of the managed .gitignore block that lists the overlay links (written by
// lib/core-lifecycle/_seed.mjs). Duplicated as literals rather than imported, to keep
// lib/sk-cli/ — which cli.mjs loads on EVERY invocation — free of a back-edge into
// lib/core-lifecycle/. tests/core-cli.test.mjs asserts the two spellings stay identical.
const GITIGNORE_BLOCK_BEGIN = "BEGIN sidekicks core (managed by `sidekicks core init`)";
const GITIGNORE_BLOCK_END = "END sidekicks core";

// Host-level link → canonical skills folder. All point at the same target, so the pairs are derived
// from the two constants rather than restated four times (skill-trees.mjs owns both halves).
const LINKS = EXPOSURE_LINKS.map((link) => ({ link, target: SKILLS_ROOT_SEGMENTS }));

const isWindows = process.platform === "win32";

/**
 * True when `linkPath` resolves to the same real location as `absTarget`.
 * Comparison is case-insensitive on Windows (NTFS is case-insensitive).
 * Returns false on any resolution error (broken link, missing path).
 */
function linkResolvesTo(linkPath, absTarget) {
  try {
    const a = realpathSync(linkPath);
    const b = realpathSync(absTarget);
    return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

/**
 * Ensure a single host link points at the canonical skills folder.
 * @param {string} linkPath  Absolute path of the link to create/repair.
 * @param {string} absTarget Absolute path of the canonical target directory.
 * @param {(msg: string) => void} log
 */
function ensureOneLink(linkPath, absTarget, log) {
  // Nothing to point at — leave the host alone rather than create a dangling link.
  if (!existsSync(absTarget)) return;

  // A link onto its own target would be replaced by a symlink pointing at itself — i.e. the entire
  // skills tree deleted and swapped for a loop. EXPOSURE_LINKS deliberately omits the canonical
  // directory (see skill-trees.mjs), so this can only fire if someone adds it back; it costs one
  // comparison and the failure it prevents is unrecoverable.
  if (linkPath === absTarget) {
    log(`skill-link: refusing to link ${linkPath} onto itself (it is the canonical tree)`);
    return;
  }

  let st;
  try {
    st = lstatSync(linkPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  if (st) {
    if (st.isSymbolicLink()) {
      // Junctions also report as symbolic links via lstat on Windows.
      if (linkResolvesTo(linkPath, absTarget)) return; // already correct
      removeLink(linkPath); // broken or pointing elsewhere — replace
    } else if (st.isDirectory()) {
      // A genuine directory (not a link). Don't destroy real data — leave it.
      log(`skill-link: ${linkPath} is a real directory, leaving as-is`);
      return;
    } else {
      // Regular file — almost certainly a git text-stub placeholder. Replace it.
      unlinkSync(linkPath);
    }
  }

  mkdirSync(dirname(linkPath), { recursive: true });

  if (isWindows) {
    // Junction target must be absolute; needs no special privilege.
    symlinkSync(absTarget, linkPath, "junction");
  } else {
    // Relative symlink so it stays valid across clones and machines.
    symlinkSync(relative(dirname(linkPath), absTarget), linkPath, "dir");
  }
  log(`skill-link: created ${linkPath}`);
}

/**
 * (Re)create the host-level skill links under repoRoot, self-healing any that
 * are missing, broken, or checked out as text stubs. Best-effort: never throws.
 *
 * @param {string} repoRoot Absolute path of the repository root.
 * @param {(msg: string) => void} [log] Optional verbose logger.
 */
export function ensureSkillLinks(repoRoot, log = () => {}) {
  for (const { link, target } of LINKS) {
    const linkPath = join(repoRoot, ...link);
    const absTarget = join(repoRoot, ...target);
    try {
      ensureOneLink(linkPath, absTarget, log);
    } catch (err) {
      log(`skill-link: could not ensure ${link.join("/")}: ${err.message}`);
    }
  }
}

/**
 * Project a mounted framework core's skills into the workspace's canonical skills folder.
 *
 * When the framework is consumed as a submodule, the framework-shipped skills live at
 * .sidekicks-core/.agents/skills/ — or at .sidekicks-core/.sidekicks/skills/ if that core predates
 * the move, which is why the lookup below tries both. Rule 3 keeps ONE canonical location per repo,
 * and every CLI's exposure link points at <repoRoot>/.agents/skills — so the core's skills are
 * surfaced there as per-skill directory links, alongside the workspace's own real skill directories.
 *
 * Three properties, all deliberate:
 *   1. A REAL directory in the workspace always wins. A user who authors (or copies in) a skill of
 *      the same name owns that name; the core's version is not linked over it and nothing is
 *      deleted. This is what makes `core update` safe for a customized workspace.
 *   2. The links are NOT tracked in git — same reason as the host-level links above (a committed
 *      symlink checks out as a text stub on Windows) — so they are recreated on every CLI run.
 *   3. Best-effort. No mounted core, an unreadable core skills tree, or a failing link is a no-op:
 *      link upkeep must never break a CLI verb.
 *
 * Symlinked skill directories are already first-class downstream: lib/framework-settings/registry.mjs
 * accepts a link where it expects a skill folder, and lib/skill-lifecycle/scan.mjs stats through it.
 *
 * RECONCILIATION IS OPT-IN (`{ prune: true }`), and only `applyDerived` — i.e. `core init` and
 * `core update` — asks for it. Creating a link is idempotent and safe to attempt on every CLI
 * invocation; DELETING one is not. This function runs from cli.mjs before every verb, including
 * `sidekicks --help`, with its errors swallowed into a log, and a partially-mounted core (submodule
 * directory present, `git submodule update --init` not yet run) presents a readable but incomplete
 * skills tree. Pruning on that path would silently delete the whole overlay at the worst possible
 * moment. Same reason `applyDerived` calls `materializeFramework(repoRoot, { prune: false })`.
 *
 * @param {string} repoRoot Absolute path of the workspace repository root.
 * @param {(msg: string) => void} [log] Optional verbose logger.
 * @param {{prune?: boolean}} [opts] `prune: true` also REMOVES overlay links the core no longer
 *        ships — see reconcileCoreSkillOverlay for the three conditions a link must meet.
 * @returns {number} Count of links created, repaired or removed (0 when nothing is mounted).
 */
export function ensureCoreSkillOverlay(repoRoot, log = () => {}, opts = {}) {
  const coreDir = coreDirOf(repoRoot);
  if (!coreDir) return 0;

  // The CORE's skills tree, which is NOT necessarily spelled the way this workspace spells its own.
  // A core is a separate repository on its own release cadence: one published before skills moved to
  // .agents/ still ships them at .sidekicks/skills, and a workspace on the new CLI must keep mounting
  // it. So the canonical location is tried first and the legacy one is the fallback — resolving the
  // core by what is THERE, never by what this repo happens to use.
  const coreSkills = [
    join(coreDir, ...SKILLS_ROOT_SEGMENTS),
    join(coreDir, ".sidekicks", "skills"),
  ].find((p) => existsSync(p));
  if (!coreSkills) return 0;

  const wsSkills = join(repoRoot, ...SKILLS_ROOT_SEGMENTS);

  let entries;
  try {
    entries = readdirSync(coreSkills, { withFileTypes: true });
  } catch (err) {
    log(`core-overlay: could not read ${coreSkills}: ${err.message}`);
    return 0;
  }

  let touched = 0;
  for (const dirent of entries) {
    // A skill folder in the core may itself be a directory or a link — accept both, skip files.
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;

    const linkPath = join(wsSkills, dirent.name);
    const absTarget = join(coreSkills, dirent.name);

    // Property 1: a real (non-link) directory here is workspace-owned. Leave it entirely alone.
    try {
      const st = lstatSync(linkPath);
      if (st.isDirectory() && !st.isSymbolicLink()) continue;
    } catch (err) {
      if (err.code !== "ENOENT") {
        log(`core-overlay: could not stat ${linkPath}: ${err.message}`);
        continue;
      }
    }

    try {
      const before = existsSync(linkPath) && linkResolvesTo(linkPath, absTarget);
      ensureOneLink(linkPath, absTarget, log);
      if (!before) touched += 1;
    } catch (err) {
      log(`core-overlay: could not ensure ${dirent.name}: ${err.message}`);
    }
  }

  if (touched > 0) log(`core-overlay: linked ${touched} core skill(s) into .agents/skills`);

  if (opts.prune) {
    touched += reconcileCoreSkillOverlay(repoRoot, wsSkills, entries, log);
  }
  return touched;
}

/**
 * Remove overlay links for skills the mounted core no longer ships.
 *
 * THE DEFECT THIS CLOSES. The overlay was additive only: it created and repaired links for what the
 * core ships now, and never removed one for a skill it used to ship. Upgrading a v1.2.0 workspace to
 * the trimmed v2.0.0 core therefore left 13 links pointing at directories that no longer exist —
 * skill discovery went inconsistent, and `core doctor` stayed red through the documented repair
 * (`core init`), because re-running an additive step cannot undo anything.
 *
 * THE PREDICATE IS A NAME-SET DIFFERENCE, NOT A PATH COMPARISON. "Dangling into the core" is simply
 * "the core does not ship a skill by this name", which needs no normalization, survives a moved or
 * cloned workspace, and behaves identically on both platforms. Comparing readlink() targets instead
 * would fail twice over: an NTFS junction stores the ABSOLUTE target from creation time (so a moved
 * workspace never matches and the residue survives), and a lexically-resolved link target does not
 * equal a realpath'd core path on macOS, where the temp dirs the tests use are /var → /private/var.
 *
 * Three conditions, all required:
 *   1. lstat says the entry is a symlink. Junctions report as symlinks through lstat, which is why
 *      readdir's Dirent type is not used here (same reason as _derive.mjs overlayLinkNames).
 *   2. The core does not ship that name.
 *   3. The name is listed in the managed .gitignore overlay block — the framework's OWN record that
 *      it created this link. Without it the function would be guessing about a link a human made.
 *
 * A real directory fails (1) and is never touched, which preserves the workspace-authored-skill-wins
 * guarantee. So does a link somebody pointed somewhere else, since it fails (3).
 *
 * @param {string} repoRoot
 * @param {string} wsSkills Absolute path of <repoRoot>/.agents/skills
 * @param {import('node:fs').Dirent[]} coreEntries What the core ships right now
 * @param {(msg: string) => void} log
 * @returns {number} Count of links removed
 */
function reconcileCoreSkillOverlay(repoRoot, wsSkills, coreEntries, log) {
  // Guard: a core that reports zero skills is far more likely to be half-checked-out than to be a
  // core that genuinely ships none, and the difference here is "delete the entire overlay".
  if (!coreEntries.length) {
    log("core-overlay: the core lists no skills — skipping reconciliation rather than clearing the overlay");
    return 0;
  }
  // Guard: the marker is the forge's own "this is a complete core" signal. No marker, no pruning.
  const coreDir = coreDirOf(repoRoot);
  if (!coreDir || !readCoreMarker(coreDir)) {
    log("core-overlay: no readable core marker — skipping reconciliation");
    return 0;
  }

  const shipped = new Set(coreEntries.map((d) => d.name));
  const managed = managedOverlayNames(repoRoot);
  if (!managed.size) return 0;   // nothing was ever recorded as ours

  let names;
  try {
    names = readdirSync(wsSkills);
  } catch {
    return 0;                     // no workspace skills dir yet — nothing to reconcile
  }

  let removed = 0;
  for (const name of names) {
    if (shipped.has(name)) continue;          // (2)
    if (!managed.has(name)) continue;         // (3)
    const linkPath = join(wsSkills, name);
    try {
      if (!lstatSync(linkPath).isSymbolicLink()) continue;   // (1)
    } catch {
      continue;
    }
    try {
      removeLink(linkPath);
      removed += 1;
      log(`core-overlay: removed ${name} — the core no longer ships it`);
    } catch (err) {
      log(`core-overlay: could not remove ${linkPath}: ${err.message}`);
    }
  }
  if (removed > 0) {
    log(`core-overlay: reconciled ${removed} stale link(s) out of .agents/skills`);
  }
  return removed;
}

/**
 * The overlay link names the managed .gitignore block records — the framework's own written record
 * of which entries under .agents/skills it created.
 *
 * Read directly rather than through _seed.mjs to keep lib/sk-cli/ free of a back-edge into
 * lib/core-lifecycle/ (this module is imported by cli.mjs on every invocation).
 *
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
function managedOverlayNames(repoRoot) {
  const out = new Set();
  let text;
  try {
    text = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  } catch {
    return out;
  }
  const begin = text.indexOf(GITIGNORE_BLOCK_BEGIN);
  if (begin === -1) return out;
  const end = text.indexOf(GITIGNORE_BLOCK_END, begin);
  const block = text.slice(begin, end === -1 ? undefined : end);
  for (const line of block.split(/\r?\n/)) {
    // BOTH tree spellings. This reads a .gitignore block written by an EARLIER `core init`/`core
    // update` in a workspace that may predate the move to .agents/skills. Matching only the current
    // spelling would make this function report "I manage nothing", and reconcile would then leave
    // every stale overlay link in place with no error — the silent failure this block exists to
    // prevent. `core update` rewrites the block to the current spelling on its way through.
    const m = /^\/\.(?:agents|sidekicks)\/skills\/(.+?)\s*$/.exec(line.trim());
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * Delete a link, whichever kind it is.
 *
 * `unlinkSync` throws EPERM on a Windows JUNCTION, because a junction is a directory reparse point
 * and Windows wants it removed as a directory. `rmSync` with recursive:false removes the reparse
 * point without following it — it never touches the target.
 *
 * @param {string} linkPath
 */
function removeLink(linkPath) {
  try {
    unlinkSync(linkPath);
  } catch (err) {
    if (err.code !== "EPERM" && err.code !== "EISDIR") throw err;
    rmSync(linkPath, { recursive: false, force: false });
  }
}
