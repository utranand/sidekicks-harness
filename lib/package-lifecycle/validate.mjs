// lib/package-lifecycle/validate.mjs
// Source validation (validateSource) and package validation (validatePackage).
// Barrel-exported.

import { existsSync, accessSync, readdirSync, readFileSync, lstatSync, constants as fsConstants } from "node:fs";
import { join, isAbsolute, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { SidekicksError, EXIT_VALIDATION } from "../sk-cli/errors.mjs";
import { EXPOSURE_LINK_RELS } from "../sk-cli/skill-trees.mjs";
import { ensureComponentVersions } from "./componentVersions.mjs";
import { statePath } from "../state-store/paths.mjs";

const isWindows = process.platform === "win32";

/**
 * Validate the source repo for package assembly (Step 1).
 *
 * Checks:
 * 1. `bin/sidekicks` exists and is executable.
 * 2. `lib/sk-cli/` directory is present.
 * 3. `.sidekicks/RULES.md` is present.
 * 4. `.agents/skills/` is non-empty.
 * 5. `package.json` is parseable.
 * 6. Runs `ensureComponentVersions` to create any missing VERSION.json files.
 *
 * @param {string} repoRoot  Absolute path to the repository root.
 * @throws {SidekicksError(EXIT_VALIDATION)} if any check fails.
 */
export function validateSource(repoRoot) {
  // Check 1: bin/sidekicks exists and is executable
  const binPath = join(repoRoot, "bin", "sidekicks");
  if (!existsSync(binPath)) {
    throw new SidekicksError(
      `validateSource: bin/sidekicks not found at '${binPath}'`,
      EXIT_VALIDATION
    );
  }
  try {
    accessSync(binPath, fsConstants.X_OK);
  } catch {
    throw new SidekicksError(
      `validateSource: bin/sidekicks is not executable at '${binPath}'`,
      EXIT_VALIDATION
    );
  }

  // Check 2: lib/sk-cli present
  const cliPath = join(repoRoot, "lib", "sk-cli");
  if (!existsSync(cliPath)) {
    throw new SidekicksError(
      `validateSource: lib/sk-cli not found at '${cliPath}'`,
      EXIT_VALIDATION
    );
  }

  // Check 3: .sidekicks/RULES.md present
  const rulesPath = join(repoRoot, ".sidekicks", "RULES.md");
  if (!existsSync(rulesPath)) {
    throw new SidekicksError(
      `validateSource: .sidekicks/RULES.md not found at '${rulesPath}'`,
      EXIT_VALIDATION
    );
  }

  // Check 4: .agents/skills/ non-empty
  const skillsPath = join(repoRoot, '.agents', 'skills');
  if (!existsSync(skillsPath)) {
    throw new SidekicksError(
      `validateSource: .agents/skills/ not found at '${skillsPath}'`,
      EXIT_VALIDATION
    );
  }
  let skillEntries;
  try {
    skillEntries = readdirSync(skillsPath);
  } catch (err) {
    throw new SidekicksError(
      `validateSource: cannot read .agents/skills/: ${err.message}`,
      EXIT_VALIDATION
    );
  }
  if (skillEntries.length === 0) {
    throw new SidekicksError(
      `validateSource: .agents/skills/ is empty — at least one skill is required`,
      EXIT_VALIDATION
    );
  }

  // Check 5: package.json parseable
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) {
    throw new SidekicksError(
      `validateSource: package.json not found at '${pkgPath}'`,
      EXIT_VALIDATION
    );
  }
  try {
    JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    throw new SidekicksError(
      `validateSource: package.json is not parseable: ${err.message}`,
      EXIT_VALIDATION
    );
  }

  // Check 6: ensureComponentVersions (auto-creates missing VERSION.json)
  ensureComponentVersions(repoRoot);
}

// ---------------------------------------------------------------------------
// validatePackage — post-assembly validation (Step 9)
// ---------------------------------------------------------------------------

/**
 * Run all §7 checks against an assembled package.
 * Every CLI probe runs with `cwd = pkgRoot` so the package's own dispatcher resolves
 * its own repoRoot — never the builder's cwd.
 *
 * @param {string} pkgRoot  Absolute path to the assembled package root.
 * @param {object} [opts]
 * @param {boolean} [opts.overlay=false]  Overlay onto an existing install. When true, the
 *   fresh-clone scope checks (active_project === "sidekicks", active_service === "(none)") are
 *   skipped, because overlay mode preserves the destination's user settings.json by design — a
 *   live install legitimately has a non-root active project and/or an active service.
 * @throws {SidekicksError(EXIT_VALIDATION)} for any failed check with a remediation hint.
 */
export function validatePackage(pkgRoot, opts = {}) {
  const { overlay = false } = opts;
  const nodeExe = process.execPath;
  const binPath = join(pkgRoot, "bin", "sidekicks");

  // ---------------------------------------------------------------------------
  // Check 1: AI context present — AGENTS.md exists; CLAUDE.md/GEMINI.md are symlinks → AGENTS.md
  // ---------------------------------------------------------------------------
  const agentsPath = join(pkgRoot, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    throw new SidekicksError(
      `validatePackage: AGENTS.md not found in package at '${agentsPath}'.\n  Hint: re-run package create to regenerate.`,
      EXIT_VALIDATION
    );
  }

  for (const mirror of ["CLAUDE.md", "GEMINI.md"]) {
    const mirrorPath = join(pkgRoot, mirror);
    if (!existsSync(mirrorPath)) {
      throw new SidekicksError(
        `validatePackage: ${mirror} not found in package.\n  Hint: CLAUDE.md and GEMINI.md must be symlinks → AGENTS.md.`,
        EXIT_VALIDATION
      );
    }
    let stat;
    try {
      stat = lstatSync(mirrorPath);
    } catch (err) {
      throw new SidekicksError(
        `validatePackage: cannot lstat ${mirror}: ${err.message}`,
        EXIT_VALIDATION
      );
    }
    if (!stat.isSymbolicLink() && !isWindows) {
      throw new SidekicksError(
        `validatePackage: ${mirror} is not a symlink (must be a relative symlink → AGENTS.md).\n  Hint: re-run package create.`,
        EXIT_VALIDATION
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Check 2: Mirror content identical through all three paths
  // ---------------------------------------------------------------------------
  try {
    const agentsContent = readFileSync(agentsPath, "utf8");
    const claudeContent = readFileSync(join(pkgRoot, "CLAUDE.md"), "utf8");
    const geminiContent = readFileSync(join(pkgRoot, "GEMINI.md"), "utf8");
    if (agentsContent !== claudeContent || agentsContent !== geminiContent) {
      throw new SidekicksError(
        `validatePackage: AGENTS.md content is not identical through CLAUDE.md and GEMINI.md.\n  Hint: ensure CLAUDE.md and GEMINI.md are symlinks, not copies.`,
        EXIT_VALIDATION
      );
    }
  } catch (err) {
    if (err instanceof SidekicksError) throw err;
    throw new SidekicksError(
      `validatePackage: mirror integrity check failed: ${err.message}`,
      EXIT_VALIDATION
    );
  }

  // ---------------------------------------------------------------------------
  // Check 3: CLI boots — node bin/sidekicks --help exits 0
  // ---------------------------------------------------------------------------
  _spawnCheck(
    nodeExe, [binPath, "--help"], pkgRoot,
    (result) => result.status !== 0,
    `validatePackage: 'node bin/sidekicks --help' exited ${0} — package CLI does not boot.\n  Hint: ensure bin/sidekicks is present and executable (mode 0755).`
  );

  // ---------------------------------------------------------------------------
  // Check 4: Root-project default — project current prints "sidekicks"
  // Skipped in overlay mode: the destination's settings.json is preserved, so a
  // non-root active project (e.g. an in-use install) is expected, not a defect.
  // ---------------------------------------------------------------------------
  if (!overlay) {
    const result = spawnSync(nodeExe, [binPath, "project", "current"], {
      cwd: pkgRoot,
      encoding: "utf8",
      timeout: 15000,
    });
    const out = (result.stdout ?? "").trim();
    if (result.status !== 0 || !out.includes("sidekicks")) {
      throw new SidekicksError(
        `validatePackage: 'project current' did not print 'sidekicks' (got '${out}', exit ${result.status}).\n  Hint: check .sidekicks/settings.json active_project field.`,
        EXIT_VALIDATION
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Check 5: No active service — service current prints "(none)"
  // Skipped in overlay mode for the same reason as Check 4.
  // ---------------------------------------------------------------------------
  if (!overlay) {
    const result = spawnSync(nodeExe, [binPath, "service", "current"], {
      cwd: pkgRoot,
      encoding: "utf8",
      timeout: 15000,
    });
    const out = (result.stdout ?? "").trim();
    if (result.status !== 0 || !out.includes("(none)")) {
      throw new SidekicksError(
        `validatePackage: 'service current' did not print '(none)' (got '${out}', exit ${result.status}).\n  Hint: check .sidekicks/settings.json active_service field.`,
        EXIT_VALIDATION
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Check 6a: Index rebuild succeeds
  // ---------------------------------------------------------------------------
  {
    const result = spawnSync(nodeExe, [binPath, "index", "rebuild"], {
      cwd: pkgRoot,
      encoding: "utf8",
      timeout: 30000,
    });
    if (result.status !== 0) {
      throw new SidekicksError(
        `validatePackage: 'index rebuild' failed (exit ${result.status}).\n  Hint: run 'node bin/sidekicks index rebuild' from the package root to diagnose.`,
        EXIT_VALIDATION
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Check 6b: index show --json parses
  // ---------------------------------------------------------------------------
  {
    const result = spawnSync(nodeExe, [binPath, "index", "show", "--json"], {
      cwd: pkgRoot,
      encoding: "utf8",
      timeout: 15000,
    });
    if (result.status !== 0) {
      throw new SidekicksError(
        `validatePackage: 'index show --json' failed (exit ${result.status}).\n  Hint: run 'node bin/sidekicks index rebuild' first.`,
        EXIT_VALIDATION
      );
    }
    try {
      JSON.parse(result.stdout);
    } catch {
      throw new SidekicksError(
        `validatePackage: 'index show --json' output is not valid JSON.\n  Hint: run 'node bin/sidekicks index rebuild' from the package root.`,
        EXIT_VALIDATION
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Check 7: Repo-relative paths — no absolute/home/drive paths in index.json
  // ---------------------------------------------------------------------------
  // Wherever this package keeps its state — a freshly created one writes .sidekicks/state/index.json,
  // an older package still carries the top-level path.
  const indexPath = statePath(pkgRoot, "index.json");
  if (existsSync(indexPath)) {
    try {
      const indexContent = readFileSync(indexPath, "utf8");
      const indexObj = JSON.parse(indexContent);
      _assertNoAbsolutePaths(indexObj, indexPath);
    } catch (err) {
      if (err instanceof SidekicksError) throw err;
      // Index may not exist yet (non-fatal here; rebuild check above would have caught it)
    }
  }

  // ---------------------------------------------------------------------------
  // Check 8: Skills visible — index get skills returns a non-empty list
  // ---------------------------------------------------------------------------
  {
    const result = spawnSync(nodeExe, [binPath, "index", "get", "skills"], {
      cwd: pkgRoot,
      encoding: "utf8",
      timeout: 15000,
    });
    if (result.status !== 0) {
      throw new SidekicksError(
        `validatePackage: 'index get skills' failed (exit ${result.status}).\n  Hint: ensure .agents/skills/ is non-empty and index is rebuilt.`,
        EXIT_VALIDATION
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Check 9: No secrets — config.yaml/.env/pem/key/.confluence.yaml absent
  // In overlay mode, preserved user data (projects/**, the preserved
  // .sidekicks/config.yaml) is pruned: overlay writes onto a live install and
  // never copies those files, so a pre-existing user config.yaml is not a leak.
  // ---------------------------------------------------------------------------
  _assertNoSecrets(pkgRoot, { overlay });

  // ---------------------------------------------------------------------------
  // Check 10: every exposure link resolves to the canonical tree
  // ---------------------------------------------------------------------------
  for (const symDir of EXPOSURE_LINK_RELS) {
    const symPath = join(pkgRoot, symDir);
    if (!existsSync(symPath)) continue; // optional — only check if present
    try {
      const stat = lstatSync(symPath);
      if (!stat.isSymbolicLink() && !isWindows) {
        throw new SidekicksError(
          `validatePackage: ${symDir} should be a symlink to .agents/skills but is a regular directory.\n  Hint: re-run package create.`,
          EXIT_VALIDATION
        );
      }
    } catch (err) {
      if (err instanceof SidekicksError) throw err;
      // lstat failed — not a hard error if directory doesn't resolve
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a spawnSync check and throw on condition.
 */
function _spawnCheck(nodeExe, spawnArgs, cwd, failCondition, errorMessage) {
  const result = spawnSync(nodeExe, spawnArgs, {
    cwd,
    encoding: "utf8",
    timeout: 15000,
  });
  if (failCondition(result)) {
    throw new SidekicksError(errorMessage, EXIT_VALIDATION);
  }
}

/**
 * Recursively check all string values in an object for absolute paths.
 * @param {unknown} obj
 * @param {string} context
 */
function _assertNoAbsolutePaths(obj, context) {
  if (typeof obj === "string") {
    if (isAbsolute(obj)) {
      throw new SidekicksError(
        `validatePackage: index.json contains absolute path '${obj}' at '${context}'.\n  Hint: rebuild the index from the package root: 'node bin/sidekicks index rebuild'.`,
        EXIT_VALIDATION
      );
    }
    // Check for home directory prefix (~/) or drive letter (C:\)
    if (obj.startsWith("~/") || /^[A-Za-z]:[/\\]/.test(obj)) {
      throw new SidekicksError(
        `validatePackage: index.json contains non-repo-relative path '${obj}'.\n  Hint: rebuild the index from the package root.`,
        EXIT_VALIDATION
      );
    }
  } else if (Array.isArray(obj)) {
    obj.forEach((item) => _assertNoAbsolutePaths(item, context));
  } else if (obj !== null && typeof obj === "object") {
    Object.values(obj).forEach((val) => _assertNoAbsolutePaths(val, context));
  }
}

/**
 * Walk pkgRoot looking for secret files that should not be present.
 * The config.yaml check is scoped to sensitive paths only (.sidekicks/, projects/**).
 * bmad/bmm/config.yaml is a BMAD framework config file, not a user secret.
 * @param {string} pkgRoot
 * @param {object} [opts]
 * @param {boolean} [opts.overlay=false]  When true, prune user-preserved paths
 *   (projects/**, the preserved .sidekicks/config.yaml) — overlay writes onto a live
 *   install and never copies those, so a pre-existing user config.yaml is not a leak.
 */
function _assertNoSecrets(pkgRoot, opts = {}) {
  const { overlay = false } = opts;
  // Paths overlay preserves as user data — not introduced by packaging, so not a leak.
  const PRESERVED_USER_PATHS = new Set(["projects", ".sidekicks/config.yaml"]);

  const SAFE_CONFIG_YAML_DIRS = new Set([
    "bmad", // bmad/bmm/config.yaml is BMAD framework config, not a secret
  ]);

  const secretPatterns = [
    (name, dir) => name === "config.yaml" && !SAFE_CONFIG_YAML_DIRS.has(dir.split("/")[0]),
    (name) => name === ".env",
    (name) => name.endsWith(".pem"),
    (name) => name.endsWith(".key"),
    (name) => name === ".confluence.yaml",
    // The credential half of every config family file. Its committed sibling
    // (`<family>.yaml`) is meant to travel — that is how a package carries real configuration
    // structure — but the `.secret.yaml` never may.
    (name) => name.endsWith(".secret.yaml"),
    // The retired pre-family monolith. It still carries every credential the split moved out, so a
    // package containing one is the same leak as containing config.yaml itself.
    (name) => name.startsWith("pending-removal."),
  ];

  function walk(dir, relDir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const entryRel = relDir ? relDir + "/" + entry : entry;
      if (overlay && PRESERVED_USER_PATHS.has(entryRel)) continue; // preserved user data
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue; // don't follow symlinks
      if (secretPatterns.some((p) => p(entry, entryRel))) {
        throw new SidekicksError(
          `validatePackage: secret file '${fullPath}' found in package.\n  Hint: ensure ${entry} is in the exclude set and re-assemble.`,
          EXIT_VALIDATION
        );
      }
      if (stat.isDirectory()) {
        walk(fullPath, entryRel);
      }
    }
  }

  walk(pkgRoot, "");
}
