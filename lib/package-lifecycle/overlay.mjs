// lib/package-lifecycle/overlay.mjs
// Upgrade-safe overlay for an existing Sidekicks installation.
// System files always overwrite; user files are never overwritten; generated files are regenerated.
// Barrel-exported.

import { existsSync, readdirSync, lstatSync, writeFileSync, unlinkSync, rmSync, copyFileSync, chmodSync, symlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { copyTree } from "./fs-copy.mjs";
import { checkComponentVersions } from "./componentVersions.mjs";
import { generateCleanSettings } from "./config.mjs";
import { generatePackageManifest } from "./manifest.mjs";
import { mkdirp } from "../fs-safety/fsx.mjs";
import { STATE_DIR } from "../state-store/paths.mjs";
import { SidekicksError, EXIT_VALIDATION, EXIT_IO } from "../sk-cli/errors.mjs";
import { SKILLS_ROOT_REL, SKILLS_ROOT_SEGMENTS, EXPOSURE_LINK_RELS } from "../sk-cli/skill-trees.mjs";

/**
 * The two directories whose immediate children are versioned COMPONENTS — lib modules and skills.
 * Named once because three separate loops below walk exactly this pair, and they drifted apart in
 * the past. path.join normalises the POSIX slash on Windows, so the `*_REL` spelling is safe here.
 */
const COMPONENT_TREES = Object.freeze(["lib", SKILLS_ROOT_REL]);

const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------
// Classification sets (relative to repo root)
// ---------------------------------------------------------------------------

const SYSTEM_PATHS = [
  "bin/sidekicks",
  // lib/** and .agents/skills/** are handled by the per-component loop below
  // (to preserve orphans and do per-component version handling)
  ".sidekicks/RULES.md",
  ".sidekicks/config.example.yaml",
  // The framework enable map — SETTINGS (booleans), not configuration values. It lives in its own
  // directory inside .sidekicks/config/; listed as a SYSTEM path (not user data) because an overlay
  // that kept the destination's copy would run the new framework against an enable map that
  // predates its entries. The monolith paths cover a destination that has not run
  // `framework sync --split` yet.
  ".sidekicks/config/settings",
  ".sidekicks/config/framework.yaml",
  ".sidekicks/config/framework.example.yaml",
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".claude",
  ".agent",
  ".gemini",
  "bmad",
  ".githooks",
  "scripts",
  "package.json",
  "README.md",
];

const USER_PATHS = new Set([
  ".sidekicks/settings.json",
  ".sidekicks/config.yaml",
  ".sidekicks/settings.local.json",
  // The destination's own configuration folder: its family files, their git-ignored credential
  // siblings, and its retired monolith. An overlay upgrades the FRAMEWORK; it must never replace the
  // values an install is configured with. (config/settings/ is the deliberate exception above — it
  // is the framework's own enable map, not a value the install owns.)
  ".sidekicks/config",
  "projects",
]);

// Local/runtime files that live INSIDE a directory otherwise classified as a
// system path (e.g. ".claude" is wholesale rm+copied below). Wholesale replacing
// that directory would clobber these with the SOURCE repo's own machine-local
// state (permissions history, session PID/lock) — they must survive the overlay
// exactly as the destination had them, never travel from source to dest.
const NESTED_USER_PATHS = [
  ".claude/settings.local.json",
  ".claude/scheduled_tasks.lock",
];

const GENERATED_PATHS = new Set([
  // The index is rebuilt in the destination, wherever that checkout keeps its state.
  `.sidekicks/${STATE_DIR}/index.json`,
  ".sidekicks/index.json",
  "PACKAGE.md",
]);

/**
 * Overlay-upgrade an existing Sidekicks installation.
 * Detection: dest contains both `bin/sidekicks` AND `.sidekicks/settings.json`.
 *
 * @param {string} srcRoot   Absolute path to the source repo (the newer version).
 * @param {string} destRoot  Absolute path to the existing package to upgrade.
 * @param {{
 *   versionCheck?: boolean,
 *   includesClaude?: boolean,
 *   includesGemini?: boolean,
 *   includesAgent?: boolean,
 *   packageVersion?: string,
 *   removeOrphans?: boolean,   // Default false (keep); must be explicitly set to true to remove
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {{ lines: string[], orphans: string[] }} Per-component summary + orphan list
 */
export function overlayPackage(srcRoot, destRoot, opts = {}) {
  const {
    versionCheck = false,
    includesClaude = true,
    includesGemini = false,
    includesAgent = true,
    removeOrphans = false,  // default keep — never auto-delete without explicit confirmation
    packageVersion = "0.0.0",
    log = () => {},
  } = opts;

  const summaryLines = [];
  const orphanList = [];

  // ---------------------------------------------------------------------------
  // System files: always overwrite
  // ---------------------------------------------------------------------------

  log("overlay: copying system files");

  for (const rel of SYSTEM_PATHS) {
    const srcPath = join(srcRoot, rel);
    const dstPath = join(destRoot, rel);

    if (!existsSync(srcPath)) {
      log(`overlay: system path not found in source, skipping: ${rel}`);
      continue;
    }

    // Skip AI context mirrors (CLAUDE.md/GEMINI.md handled as symlinks below)
    if (rel === "CLAUDE.md" || rel === "GEMINI.md") continue;

    // Skip conditional paths
    if (rel === ".claude" && !includesClaude) continue;
    if (rel === ".agent" && !includesAgent) continue;
    if (rel === ".gemini" && !includesGemini) continue;
    if (rel === "bmad" && !includesGemini) continue;

    const preserveMode = rel === "bin/sidekicks";

    try {
      mkdirp(dirname(dstPath));
      const stat = lstatSync(srcPath);
      if (stat.isDirectory()) {
        // Snapshot any nested user/local files under this dir BEFORE wiping it,
        // so they can be restored verbatim after the fresh copy (never let the
        // source repo's own local/runtime state leak into the destination).
        const nestedSnapshots = _snapshotNestedUserPaths(rel, destRoot);

        // Remove existing destination dir then copy fresh
        if (existsSync(dstPath)) {
          rmSync(dstPath, { recursive: true, force: true });
        }
        copyTree(srcPath, dstPath, { preserveMode });

        _restoreNestedUserPaths(nestedSnapshots, destRoot);
      } else {
        // Regular file — copy directly (do NOT use copyTree on the parent dir)
        copyFileSync(srcPath, dstPath);
        if (preserveMode) {
          chmodSync(dstPath, stat.mode & 0o7777);
        }
      }
    } catch (err) {
      if (err instanceof SidekicksError) throw err;
      throw new SidekicksError(
        `overlay: failed to copy system file '${rel}': ${err.message}`,
        EXIT_IO
      );
    }
    log(`overlay: system → ${rel}`);
  }

  // Recreate CLAUDE.md/GEMINI.md as symlinks → AGENTS.md (copy fallback on Windows)
  for (const mirror of ["CLAUDE.md", "GEMINI.md"]) {
    const mirrorPath = join(destRoot, mirror);
    try {
      if (existsSync(mirrorPath)) {
        unlinkSync(mirrorPath);
      }
      try {
        symlinkSync("AGENTS.md", mirrorPath);
      } catch (symErr) {
        if (isWindows && symErr.code === "EPERM") {
          // Fall back to copying AGENTS.md on Windows without Developer Mode
          copyFileSync(join(destRoot, "AGENTS.md"), mirrorPath);
        } else {
          throw symErr;
        }
      }
    } catch { /* ignore — already correct */ }
  }

  // ---------------------------------------------------------------------------
  // Components: lib/* and .agents/skills/* with version handling
  // ---------------------------------------------------------------------------

  if (versionCheck) {
    log("overlay: applying version-check for components");
    const componentClassifications = checkComponentVersions(srcRoot, destRoot);

    for (const [name, classification] of Object.entries(componentClassifications)) {
      const srcLib = join(srcRoot, "lib", name);
      const dstLib = join(destRoot, "lib", name);
      const srcSkill = join(srcRoot, ...SKILLS_ROOT_SEGMENTS, name);
      const dstSkill = join(destRoot, ...SKILLS_ROOT_SEGMENTS, name);

      const srcPath = existsSync(srcLib) ? srcLib : srcSkill;
      const dstPath = existsSync(srcLib) ? dstLib : dstSkill;

      switch (classification) {
        case "upgrade":
          summaryLines.push(`  ↑ ${name}`);
          copyTree(srcPath, dstPath);
          break;
        case "same":
          summaryLines.push(`  = ${name}`);
          copyTree(srcPath, dstPath);
          break;
        case "new":
          summaryLines.push(`  + ${name}`);
          mkdirp(dstPath);
          copyTree(srcPath, dstPath);
          break;
        case "downgrade":
          throw new SidekicksError(
            `overlay: component '${name}' would be downgraded (source < dest). Use without --version-check to force.\n  Hint: remove --version-check to allow overwriting regardless of version.`,
            EXIT_VALIDATION
          );
      }
    }
  } else {
    // Default: replace all components regardless of version
    log("overlay: replacing all components (no version-check)");

    for (const dir of COMPONENT_TREES) {
      const srcDir = join(srcRoot, dir);
      if (!existsSync(srcDir)) continue;
      const entries = readdirSync(srcDir);
      for (const entry of entries) {
        const srcComp = join(srcDir, entry);
        const dstComp = join(destRoot, dir, entry);
        try {
          const stat = lstatSync(srcComp);
          if (!stat.isDirectory()) continue;
        } catch { continue; }

        const destExists = existsSync(dstComp);
        summaryLines.push(`  ${destExists ? "!" : "+"} ${entry}`);
        copyTree(srcComp, dstComp);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // User files: never overwrite (log what we're preserving)
  // ---------------------------------------------------------------------------

  for (const rel of USER_PATHS) {
    const dstPath = join(destRoot, rel);
    if (existsSync(dstPath)) {
      log(`overlay: preserving user file: ${rel}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Generated files: always regenerate
  // ---------------------------------------------------------------------------

  // Regenerate .sidekicks/index.json by shelling to package CLI
  const nodeExe = process.execPath;
  const binPath = join(destRoot, "bin", "sidekicks");
  if (existsSync(binPath)) {
    log("overlay: regenerating index.json via package CLI");
    const rebuildResult = spawnSync(nodeExe, [binPath, "index", "rebuild"], {
      cwd: destRoot,
      encoding: "utf8",
      timeout: 30000,
    });
    if (rebuildResult.status !== 0) {
      log(`overlay: index rebuild warning: exit ${rebuildResult.status}`);
    }
  }

  // Regenerate PACKAGE.md
  const manifestPath = join(destRoot, "PACKAGE.md");
  const manifestContent = generatePackageManifest({
    version: packageVersion,
    includedComponents: [],
    includesClaude,
    includesGemini,
    includesAgent,
  });
  try {
    writeFileSync(manifestPath, manifestContent, "utf8");
  } catch (err) {
    throw new SidekicksError(
      `overlay: cannot write PACKAGE.md: ${err.message}`,
      EXIT_IO
    );
  }

  // ---------------------------------------------------------------------------
  // Orphan detection: dest-present, source-absent components
  // Default: keep; removal only when removeOrphans=true (explicit confirmation)
  // ---------------------------------------------------------------------------

  for (const dir of COMPONENT_TREES) {
    const srcDir = join(srcRoot, dir);
    const dstDir = join(destRoot, dir);
    if (!existsSync(dstDir)) continue;

    let dstEntries;
    try {
      dstEntries = readdirSync(dstDir);
    } catch { continue; }

    for (const entry of dstEntries) {
      const srcComp = join(srcDir, entry);
      if (!existsSync(srcComp)) {
        // This component is an orphan — present in dest but not in source
        orphanList.push(entry);

        if (removeOrphans) {
          // Remove the orphan component directory
          const dstComp = join(dstDir, entry);
          _removeOrphan(dstComp, destRoot, entry, log);
          summaryLines.push(`  ✗ ${entry} (orphan — removed)`);
          log(`overlay: removed orphan: ${entry}`);
        } else {
          summaryLines.push(`  ? ${entry} (orphan — kept; not in source)`);
          log(`overlay: orphan detected (keeping): ${entry}`);
        }
      }
    }
  }

  return { lines: summaryLines, orphans: orphanList };
}

/**
 * Snapshot nested user/local files (NESTED_USER_PATHS) that live under a
 * system directory about to be wholesale rm+copied, so they can be restored
 * after the copy instead of being overwritten by the source's own copies.
 * @param {string} systemRel  The system path being replaced, e.g. ".claude".
 * @param {string} destRoot
 * @returns {Array<{ rel: string, content: Buffer, mode: number }>}
 */
function _snapshotNestedUserPaths(systemRel, destRoot) {
  const prefix = `${systemRel}/`;
  const snapshots = [];
  for (const rel of NESTED_USER_PATHS) {
    if (!rel.startsWith(prefix)) continue;
    const abs = join(destRoot, rel);
    if (!existsSync(abs)) continue;
    try {
      const stat = lstatSync(abs);
      if (!stat.isFile()) continue;
      snapshots.push({ rel, content: readFileSync(abs), mode: stat.mode & 0o7777 });
    } catch { /* ignore — nothing to preserve */ }
  }
  return snapshots;
}

/**
 * Restore files snapshotted by _snapshotNestedUserPaths after the system
 * directory has been recreated from source.
 * @param {Array<{ rel: string, content: Buffer, mode: number }>} snapshots
 * @param {string} destRoot
 */
function _restoreNestedUserPaths(snapshots, destRoot) {
  for (const { rel, content, mode } of snapshots) {
    const abs = join(destRoot, rel);
    try {
      mkdirp(dirname(abs));
      writeFileSync(abs, content);
      chmodSync(abs, mode);
    } catch { /* ignore — best-effort restore */ }
  }
}

/**
 * Remove an orphan component directory and clean up dangling skill symlinks.
 * @param {string} compPath  Absolute path to the orphan component directory.
 * @param {string} pkgRoot   Absolute path to the package root.
 * @param {string} name      Component name.
 * @param {Function} log
 */
function _removeOrphan(compPath, pkgRoot, name, log) {
  // Remove the component directory
  try {
    rmSync(compPath, { recursive: true, force: true });
  } catch { /* ignore */ }

  // Remove dangling skill symlinks from every exposure directory. Driven off EXPOSURE_LINK_RELS
  // rather than a hand-written pair, which had already fallen behind: it listed .claude and .agent
  // and silently skipped .gemini, leaving a dangling link there after every component removal.
  for (const hostDir of EXPOSURE_LINK_RELS) {
    const symlinkPath = join(pkgRoot, hostDir, name);
    if (existsSync(symlinkPath)) {
      try {
        unlinkSync(symlinkPath);
        log(`overlay: removed dangling symlink: ${hostDir}/${name}`);
      } catch { /* ignore */ }
    }
  }
}
