// lib/package-lifecycle/componentVersions.mjs
// Component version engine: ensure, compare, and check VERSION.json across libs and skills.
// Pure Node ESM — zero npm deps. Only imports SidekicksError/EXIT_* from lib/sk-cli/errors.mjs.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { SidekicksError, EXIT_IO } from "../sk-cli/errors.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a SKILL.md frontmatter block and extract the `description` field.
 * Returns the description string or null if not found.
 *
 * @param {string} skillMdPath
 * @returns {string|null}
 */
function readSkillDescription(skillMdPath) {
  if (!existsSync(skillMdPath)) return null;
  try {
    const content = readFileSync(skillMdPath, "utf8");
    // YAML frontmatter starts with "---" on the first line
    if (!content.startsWith("---")) return null;
    const end = content.indexOf("\n---", 3);
    if (end === -1) return null;
    const frontmatter = content.slice(3, end);
    const match = frontmatter.match(/^description\s*:\s*(.+)$/m);
    if (!match) return null;
    return match[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    return null;
  }
}

/**
 * Return a sorted list of top-level filenames in a directory (files only, not dirs).
 *
 * @param {string} dirPath
 * @returns {string[]}
 */
function topLevelFiles(dirPath) {
  try {
    return readdirSync(dirPath)
      .filter((entry) => {
        try {
          return statSync(join(dirPath, entry)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Validate a VERSION.json object.
 * A valid object must be parseable JSON with a `version` string field.
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
function isValidVersionObj(obj) {
  return (
    obj !== null &&
    typeof obj === "object" &&
    typeof obj.version === "string" &&
    obj.version.length > 0
  );
}

// ---------------------------------------------------------------------------
// ensureComponentVersions
// ---------------------------------------------------------------------------

/**
 * Ensure every lib/* and .agents/skills/* has a valid VERSION.json.
 * Creates one at 1.0.0 for any component that is missing or has an invalid file.
 * Existing valid files are left byte-stable.
 *
 * @param {string} repoRoot  Absolute path to the repository root.
 * @returns {{ created: string[], existing: string[] }}
 */
export function ensureComponentVersions(repoRoot) {
  const created = [];
  const existing = [];

  const scanDirs = [
    join(repoRoot, "lib"),
    join(repoRoot, '.agents', 'skills'),
  ];

  for (const scanDir of scanDirs) {
    if (!existsSync(scanDir)) continue;

    let entries;
    try {
      entries = readdirSync(scanDir);
    } catch (err) {
      throw new SidekicksError(
        `ensureComponentVersions: cannot read directory ${scanDir}: ${err.message}`,
        EXIT_IO
      );
    }

    for (const entry of entries) {
      const compDir = join(scanDir, entry);
      try {
        if (!statSync(compDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const versionPath = join(compDir, "VERSION.json");
      const name = basename(compDir);

      // Check if a valid VERSION.json already exists
      let valid = false;
      if (existsSync(versionPath)) {
        try {
          const parsed = JSON.parse(readFileSync(versionPath, "utf8"));
          valid = isValidVersionObj(parsed);
        } catch {
          valid = false;
        }
      }

      if (valid) {
        existing.push(versionPath);
        continue;
      }

      // Derive description
      const skillMdPath = join(compDir, "SKILL.md");
      const description =
        readSkillDescription(skillMdPath) ??
        `${name} library component`;

      // Derive files (top-level files in the component dir)
      const files = topLevelFiles(compDir);

      const versionObj = {
        name,
        version: "1.0.0",
        description,
        files,
      };

      try {
        writeFileSync(versionPath, JSON.stringify(versionObj, null, 2) + "\n", "utf8");
      } catch (err) {
        throw new SidekicksError(
          `ensureComponentVersions: cannot write ${versionPath}: ${err.message}`,
          EXIT_IO
        );
      }

      created.push(versionPath);
    }
  }

  return { created, existing };
}

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

/**
 * Compare two semver strings (major.minor.patch).
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
export function compareVersions(a, b) {
  const parse = (v) => v.split(".").map(Number);
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);

  if (aMaj !== bMaj) return aMaj > bMaj ? 1 : -1;
  if (aMin !== bMin) return aMin > bMin ? 1 : -1;
  if (aPat !== bPat) return aPat > bPat ? 1 : -1;
  return 0;
}

// ---------------------------------------------------------------------------
// checkComponentVersions
// ---------------------------------------------------------------------------

/**
 * Compare VERSION.json versions between srcRoot and destRoot component trees.
 * For each component found in srcRoot, classify as:
 *   "upgrade"   — src version > dest version (or dest doesn't exist at all)
 *   "same"      — src version === dest version
 *   "downgrade" — src version < dest version
 *   "new"       — component exists in src but not in dest (no VERSION.json at dest)
 *
 * @param {string} srcRoot   Absolute path to source repo root.
 * @param {string} destRoot  Absolute path to destination repo root.
 * @returns {Record<string, "upgrade"|"same"|"downgrade"|"new">}
 */
export function checkComponentVersions(srcRoot, destRoot) {
  /** @type {Record<string, "upgrade"|"same"|"downgrade"|"new">} */
  const result = {};

  const scanDirs = [
    ["lib"],
    ['.agents', 'skills'],
  ];

  for (const segments of scanDirs) {
    const srcScanDir = join(srcRoot, ...segments);
    if (!existsSync(srcScanDir)) continue;

    let entries;
    try {
      entries = readdirSync(srcScanDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const srcCompDir = join(srcScanDir, entry);
      try {
        if (!statSync(srcCompDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const srcVersionPath = join(srcCompDir, "VERSION.json");
      if (!existsSync(srcVersionPath)) continue;

      let srcVersion;
      try {
        const parsed = JSON.parse(readFileSync(srcVersionPath, "utf8"));
        if (!isValidVersionObj(parsed)) continue;
        srcVersion = parsed.version;
      } catch {
        continue;
      }

      const destVersionPath = join(destRoot, ...segments, entry, "VERSION.json");

      if (!existsSync(destVersionPath)) {
        result[entry] = "new";
        continue;
      }

      let destVersion;
      try {
        const parsed = JSON.parse(readFileSync(destVersionPath, "utf8"));
        if (!isValidVersionObj(parsed)) {
          result[entry] = "new";
          continue;
        }
        destVersion = parsed.version;
      } catch {
        result[entry] = "new";
        continue;
      }

      const cmp = compareVersions(srcVersion, destVersion);
      if (cmp > 0) result[entry] = "upgrade";
      else if (cmp < 0) result[entry] = "downgrade";
      else result[entry] = "same";
    }
  }

  return result;
}
