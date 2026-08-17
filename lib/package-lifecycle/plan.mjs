// lib/package-lifecycle/plan.mjs
// Pure copy-plan builder for the package assembly engine.
// Returns {copies, symlinks, generated, excluded} without performing any writes.
// Barrel-exported.

import { readFileSync, existsSync } from "node:fs";
import { join, relative, normalize, sep } from "node:path";
import { SidekicksError, EXIT_USAGE } from "../sk-cli/errors.mjs";
import { isInside, realPartial } from "../fs-safety/canonical-path.mjs";
import { STATE_DIR } from "../state-store/paths.mjs";

// ---------------------------------------------------------------------------
// Fixed §5.2 exclude set (relative to repo root)
// ---------------------------------------------------------------------------

/**
 * Fixed exclude list from §5.2 — relative paths or patterns.
 * These are always excluded regardless of .gitignore.
 */
const FIXED_EXCLUDES = [
  ".git",
  "worktrees",
  "output",
  "tmp",
  ".bmad-cache",
  ".bmad/sessions",
  "memory",
  "todos",
  ".skill-state.yaml",
  "node_modules",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  "docs",
  "tests",
  ".DS_Store",
  "Thumbs.db",
  ".idea",
  ".vscode",
  "projects",  // project data; only projects/.gitkeep is generated
  ".sidekicks/config.yaml",              // retired by `config migrate --prune`; never packaged
  ".sidekicks/config/pending-removal.config.yaml",
  ".sidekicks/settings.local.json",
  "settings.local.json",
  ".sidekicks/settings.json", // generated fresh, not copied
  // Derived and per-machine STATE (lib/state-store/paths.mjs). None of it travels: the index is
  // regenerated in the package, the rest is a cache of the SOURCE machine's runs and agents. Both
  // locations are excluded so a source that has not moved its files yet cannot leak them either.
  ".sidekicks/state",
  ".sidekicks/index.json",
  ".sidekicks/running-agents.json",
  ".sidekicks/artifacts-inventory.json",
  ".sidekicks/artifacts-inventory.md",
];

/**
 * Parse a .gitignore file and return an array of non-negated patterns.
 * @param {string} gitignorePath
 * @returns {string[]}
 */
function parseGitignore(gitignorePath) {
  if (!existsSync(gitignorePath)) return [];
  try {
    return readFileSync(gitignorePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
  } catch {
    return [];
  }
}

/**
 * Normalize a gitignore pattern to a simple path-like string.
 * Strips leading / and trailing /, removes wildcards and returns the raw fragment.
 * This is a conservative approximation — we only handle simple path patterns.
 * @param {string} pattern
 * @returns {string}
 */
function normGitignorePattern(pattern) {
  return pattern.replace(/^\//, "").replace(/\/$/, "").split("*")[0].replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// §5.1 Include set — base paths
// ---------------------------------------------------------------------------

/**
 * Build the include set (relative to repoRoot) based on options.
 * @param {{ includeClaude: boolean, includeGemini: boolean, includeAgent: boolean }} opts
 * @returns {string[]}
 */
function buildIncludeSet(opts) {
  const { includeClaude, includeGemini, includeAgent, includeConfig = true } = opts;
  const includes = [
    "bin/sidekicks",
    "lib",
    ".sidekicks/RULES.md",
    // The framework enable map — SETTINGS, not configuration values. Without it an exported
    // framework would silently run all-enabled, losing every disable decision the source made. It
    // lives in its own directory inside .sidekicks/config/, listed INDIVIDUALLY rather than relying
    // on the config/ directory include, because --include-config=false must still ship the enable
    // map: dropping it would change behaviour, not just omit values.
    ".sidekicks/config/settings",
    // The pre-split monolith and its example, for a source repo that has not run
    // `framework sync --split` yet. A missing include is skipped silently, so listing both
    // layouts costs nothing and keeps an unmigrated source exporting its decisions.
    ".sidekicks/config/framework.yaml",
    ".sidekicks/config/framework.example.yaml",
    // Offloaded skills travel too: they own rule fragments and hook ownership in the registry
    // (hook.enforce-flow-headful's owners are offloaded), so dropping the tree would leave
    // `framework doctor` pointing at bodies that do not exist in the export.
    ".sidekicks/skill-offloaded",
    ".sidekicks/hooks",
    ".sidekicks/config.example.yaml",
    ".agents/skills",
    "AGENTS.md",
    "package.json",
    "README.md",
    "scripts",
    ".githooks",
  ];

  if (includeConfig) {
    // The root scope's family files: one per category, committed and non-secret. THIS is how real
    // configuration structure reaches a package instead of a hand-maintained example that drifts (the
    // old examples were 4 blocks behind at root and 10 in projects/shp-sk). Every credential lives in
    // a `<family>.secret.yaml` sibling, which lib/package-lifecycle/fs-copy.mjs refuses to copy by
    // suffix, and the directory's own .gitignore travels with it.
    //
    // Opt-out (--include-config=false) exists because a family file, while carrying no credential,
    // still carries the source operator's hosts, emails and env aliases.
    includes.push(".sidekicks/config");
  }

  if (includeClaude) {
    includes.push(".claude");
  }
  if (includeAgent) {
    includes.push(".agent");
  }
  if (includeGemini) {
    includes.push(".gemini");
    includes.push("bmad");
  }

  return includes;
}

// ---------------------------------------------------------------------------
// buildCopyPlan
// ---------------------------------------------------------------------------

/**
 * Build a pure copy plan for `sidekicks package create`.
 *
 * @param {string} repoRoot  Absolute path to the repository root.
 * @param {{
 *   output: string,              // Required: absolute path to the external output directory
 *   includeClaude?: boolean,     // Default: true
 *   includeGemini?: boolean,     // Default: true
 *   includeAgent?: boolean,      // Default: true
 *   includeConfig?: boolean,     // Default: true — the root scope's committed config/ family files
 *   versionCheck?: boolean,      // Default: false
 *   dryRun?: boolean,            // Default: false
 * }} opts
 * @returns {{
 *   copies: Array<{src: string, dst: string, preserveMode?: boolean}>,
 *   symlinks: Array<{path: string, target: string}>,
 *   generated: Array<{path: string, kind: string}>,
 *   excluded: string[],
 * }}
 */
export function buildCopyPlan(repoRoot, opts) {
  const {
    output,
    includeClaude = true,
    includeGemini = true,
    includeAgent = true,
    includeConfig = true,
  } = opts;

  // AC#3: Reject output equal to or inside repoRoot (create-only guard)
  if (!output) {
    throw new SidekicksError(
      "buildCopyPlan: --output is required for package create",
      EXIT_USAGE
    );
  }

  // Output must not be equal to repoRoot or inside it.
  //
  // Compared CANONICALLY, not lexically. The previous form was `resolve(output).startsWith(
  // resolve(repoRoot) + sep)`, which a symlink or an NTFS junction whose real target is the source
  // tree walks straight past: an external link pointing back at the repo was accepted, and the first
  // planned destination resolved through it to <repo>/bin/sidekicks. It also failed the mundane
  // macOS case, where /tmp is a symlink to /private/tmp so the two spellings of one directory never
  // matched. isInside() resolves both sides as far as they exist — the output usually does not yet —
  // and folds case on Windows, where NTFS does.
  if (isInside(output, repoRoot)) {
    throw new SidekicksError(
      `buildCopyPlan: --output '${output}' is inside or equal to repoRoot — must be an external path`
      + ' (checked through symlinks and junctions, so a link pointing back into the repo is caught)',
      EXIT_USAGE
    );
  }

  // Destinations are built from the CANONICAL output. Planning against the path as typed would put
  // the guard and the plan on two different directories — the guard clears `<link>`, the plan writes
  // through it — which is precisely the gap the check above closes.
  const resolvedOutput = realPartial(output);

  // Build include set
  const includeSet = buildIncludeSet({ includeClaude, includeGemini, includeAgent, includeConfig });

  // Build exclude set: fixed list + .gitignore
  const gitignorePatterns = parseGitignore(join(repoRoot, ".gitignore"));
  const excludeSet = new Set([
    ...FIXED_EXCLUDES,
    ...gitignorePatterns
      .map(normGitignorePattern)
      .filter((p) => p && !includeSet.some((inc) => inc === p || inc.startsWith(p + "/") || p.startsWith(inc + "/"))),
  ]);

  const copies = [];
  const symlinks = [];
  const generated = [];
  const excluded = [];

  // Process include set
  for (const rel of includeSet) {
    const srcPath = join(repoRoot, rel);
    const dstPath = join(resolvedOutput, rel);

    if (!existsSync(srcPath)) {
      // Optional items (e.g., .gemini/ might not exist)
      excluded.push(rel + " (not found in source)");
      continue;
    }

    // Special handling for symlink items
    if (rel === "CLAUDE.md" || rel === "GEMINI.md") {
      // These are recreated as relative symlinks → AGENTS.md
      symlinks.push({ path: join(resolvedOutput, rel), target: "AGENTS.md" });
      continue;
    }

    // bin/sidekicks — preserve mode 0755
    if (rel === "bin/sidekicks") {
      copies.push({ src: srcPath, dst: dstPath, preserveMode: true });
      continue;
    }

    copies.push({ src: srcPath, dst: dstPath });
  }

  // CLAUDE.md and GEMINI.md are always symlinks (recreated)
  if (!symlinks.find((s) => s.path.endsWith("CLAUDE.md"))) {
    symlinks.push({ path: join(resolvedOutput, "CLAUDE.md"), target: "AGENTS.md" });
  }
  if (!symlinks.find((s) => s.path.endsWith("GEMINI.md"))) {
    symlinks.push({ path: join(resolvedOutput, "GEMINI.md"), target: "AGENTS.md" });
  }

  // .claude/skills symlink (if includeClaude)
  if (includeClaude) {
    symlinks.push({
      path: join(resolvedOutput, ".claude", "skills"),
      target: join("..", '.agents', 'skills'),
    });
  }

  // .agent/skills symlink (if includeAgent)
  if (includeAgent) {
    symlinks.push({
      path: join(resolvedOutput, ".agent", "skills"),
      target: join("..", '.agents', 'skills'),
    });
  }

  // .gemini/skills symlink (if includeGemini). Missing while the other two were emitted, so a
  // Gemini-inclusive package shipped skills that Gemini could not discover.
  if (includeGemini) {
    symlinks.push({
      path: join(resolvedOutput, ".gemini", "skills"),
      target: join("..", '.agents', 'skills'),
    });
  }

  // Generated items
  generated.push({ path: join(resolvedOutput, ".sidekicks", "settings.json"), kind: "settings" });
  generated.push({ path: join(resolvedOutput, ".sidekicks", STATE_DIR, "index.json"), kind: "index" });
  generated.push({ path: join(resolvedOutput, "PACKAGE.md"), kind: "manifest" });
  generated.push({ path: join(resolvedOutput, "projects", ".gitkeep"), kind: "gitkeep" });

  return { copies, symlinks, generated, excluded };
}
