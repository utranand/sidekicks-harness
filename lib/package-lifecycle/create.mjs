// lib/package-lifecycle/create.mjs
// Verb entry for `sidekicks package create`.
// NOT barrel-exported — reached via the dispatcher's lazy import().

import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SidekicksError, EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, EXIT_IO } from "../sk-cli/errors.mjs";
import { validateSource, validatePackage } from "./validate.mjs";
import { overlayPackage } from "./overlay.mjs";
import { buildCopyPlan } from "./plan.mjs";
import { assemblePackage } from "./assemble.mjs";
import { generateCleanSettings } from "./config.mjs";
import { generatePackageManifest } from "./manifest.mjs";
import { mkdirp } from "../fs-safety/fsx.mjs";
import { frameworkRootOf } from "../sk-cli/core-mount.mjs";
import { isInside } from "../fs-safety/canonical-path.mjs";
import { catalogTreeKind, SNAPSHOT_REL } from "../catalog-lifecycle/commands.mjs";
import { buildCatalog } from "../catalog-lifecycle/model.mjs";
import { serializeCatalog } from "../catalog-lifecycle/render.mjs";

/**
 * Run the `package create` verb.
 * Orchestrates the 10-step assembly pipeline (Steps 1–8 in this epic).
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string|undefined, rest: string[], flags: object }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot, argv, log } = ctx;

  // WHAT IS BEING PACKAGED IS THE FRAMEWORK, WHICH IS NOT ALWAYS THE WORKSPACE.
  //
  // `resolveRepoRoot` deliberately walks PAST a mounted core, so in a consumer workspace `repoRoot`
  // is the workspace — which has no `lib/`, no `bin/`, no `.sidekicks/RULES.md`. Every check and
  // every copy here joined that root verbatim, so `package create` died at
  // "validateSource: lib/sk-cli not found", the `package.clean` gate failed, and `core.mounted` and
  // `golden.replay` were BLOCKED behind it — `check run release` scored 9/13 in every mount
  // (INC-2026-09-04-02, N-3). `frameworkRootOf` is the mount when there is one, else the repo root:
  // the same one-line answer `catalog check` and `framework doctor` already took.
  //
  // `repoRoot` itself still governs the OUTPUT guard (a package must not be written inside the
  // workspace the operator is standing in), so only the SOURCE moves.
  const sourceRoot = frameworkRootOf(repoRoot);

  // Per-verb flag parsing over the full ctx.argv.
  // Do NOT slice by a fixed offset — --verbose may precede/follow namespace.
  // Parse the whole argv, then drop the leading 'package create' positionals.
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output:            { type: "string" },
      "include-claude":  { type: "string" },  // bare → true, =false → false
      "include-gemini":  { type: "string" },
      "include-agent":   { type: "string" },
      "include-config":  { type: "string" },  // the root scope's committed family files
      "version-check":   { type: "boolean", default: false },
      "dry-run":         { type: "boolean", default: false },
      verbose:           { type: "boolean", default: false }, // re-declare so not left positional
    },
    allowPositionals: true,
    strict: false,
  });

  // positionals: ['package', 'create', ...extra]
  // Boolean-include flags: absent → true, =false → false
  const includeClaude = values["include-claude"] !== "false";
  const includeGemini = values["include-gemini"] !== "false";
  const includeAgent  = values["include-agent"]  !== "false";
  // The root scope's config/ family files. They are non-secret (credentials live in the
  // git-ignored .secret.yaml siblings, which never travel), but they DO carry this operator's
  // hosts, emails and aliases — so a package meant for someone else can leave them behind with
  // --include-config=false and still ship the directory's .gitignore and the block registry.
  const includeConfig = values["include-config"] !== "false";
  const dryRun        = !!values["dry-run"];
  const versionCheck  = !!values["version-check"];

  if (!values.output) {
    throw new SidekicksError(
      "package create: --output <path> is required",
      EXIT_USAGE
    );
  }

  const outputPath = resolve(values.output);

  log(`package create: output=${outputPath} dryRun=${dryRun}`);

  // Step 1: Validate source
  log("Step 1: validateSource");
  validateSource(sourceRoot);

  // buildCopyPlan's output guard now runs against the FRAMEWORK root, so in a mount it would no
  // longer refuse an output written into the surrounding workspace. Restate it here: neither root
  // may contain the package, for the same reason as before — a package assembled inside the tree it
  // is being assembled from copies itself.
  if (sourceRoot !== repoRoot && isInside(outputPath, repoRoot)) {
    throw new SidekicksError(
      `package create: --output '${outputPath}' is inside the workspace — must be an external path`,
      EXIT_VALIDATION
    );
  }

  // Step 2: Resolve & guard output (inside-repo check done by buildCopyPlan)
  log("Step 2: building copy plan");
  const plan = buildCopyPlan(sourceRoot, {
    output: outputPath,
    includeClaude,
    includeGemini,
    includeAgent,
    includeConfig,
    versionCheck,
    dryRun,
  });

  // --dry-run short-circuit: print plan and return
  if (dryRun) {
    const planText = _formatDryRunPlan(plan, outputPath);
    return { stdout: planText, exitCode: EXIT_OK };
  }

  // Step 2: Resolve & guard output
  // Check if output is an existing Sidekicks install (detection: bin/sidekicks + .sidekicks/settings.json)
  const isExistingInstall =
    existsSync(join(outputPath, "bin", "sidekicks")) &&
    existsSync(join(outputPath, ".sidekicks", "settings.json"));

  if (isExistingInstall) {
    log("Step 2: detected existing Sidekicks install — branching to overlay");
    let pkgVersionForOverlay = "0.0.0";
    try {
      pkgVersionForOverlay = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")).version ?? "0.0.0";
    } catch {}

    const overlayResult = overlayPackage(sourceRoot, outputPath, {
      versionCheck,
      includesClaude: includeClaude,
      includesGemini: includeGemini,
      includesAgent: includeAgent,
      packageVersion: pkgVersionForOverlay,
      log,
    });

    // Step 9: validate post-overlay
    log("Step 9: validating overlay result");
    try {
      validatePackage(outputPath, { overlay: true });
    } catch (err) {
      if (err instanceof SidekicksError) {
        throw new SidekicksError(
          `package create overlay: Step 9 validation failed — ${err.message}`,
          EXIT_VALIDATION
        );
      }
      throw err;
    }

    const overlaySummary = [
      `Package overlay applied successfully.`,
      "",
      `  Location:  ${outputPath}`,
      `  Components updated:`,
      ...overlayResult.lines,
      `  Validation: PASSED (all §7 checks)`,
      "",
    ].join("\n");

    return { stdout: overlaySummary, exitCode: EXIT_OK };
  }

  // Fresh install path
  log(`Step 2: creating output directory: ${outputPath}`);
  mkdirp(outputPath);

  // Enrich plan with clean settings
  plan.cleanSettings = generateCleanSettings();

  // Steps 3–7: Execute the copy plan
  log("Steps 3–7: assembling package");
  assemblePackage(plan, { log });

  // Step 7b: a package assembled FROM A CORE gets its catalog snapshot rebuilt for itself.
  //
  // `catalog check` in a packaged tree validates the snapshot by fingerprint against the live
  // declarations, and it is strict on purpose: the property it proves is that every declaration
  // travelled UNCHANGED from the repo that owns the snapshot. A core cannot make that claim about
  // its own snapshot — `core init` runs `framework sync --prune` inside the mount, so the four
  // environment-derived sections legitimately move after the forge, which is exactly why
  // `catalog check` omits them in a `core`/`mounted` tree. Copying that snapshot forward ships one
  // that describes neither the core's environment nor the package's, and the packaged check then
  // fails on a difference nothing did wrong (INC-2026-09-04-02, N-3: the two code-derived sections
  // matched byte for byte, all four environment-derived ones differed).
  //
  // So: from the SOURCE repo the snapshot is copied verbatim and the strict check keeps biting —
  // unchanged. From a core, the snapshot is rebuilt to describe the package, which is the only tree
  // anyone will ever run `catalog check` in.
  const sourceKind = catalogTreeKind(sourceRoot);
  if (!dryRun && (sourceKind === 'core' || sourceKind === 'mounted')) {
    try {
      writeFileSync(join(outputPath, ...SNAPSHOT_REL.split('/')),
        serializeCatalog(buildCatalog(outputPath)), 'utf8');
      log(`Step 7b: rebuilt ${SNAPSHOT_REL} for the package (assembled from a ${sourceKind} tree)`);
    } catch (err) {
      throw new SidekicksError(
        `package create: could not rebuild ${SNAPSHOT_REL} in the package (${err.message})`,
        EXIT_IO
      );
    }
  }

  // Step 8: Generate PACKAGE.md + regenerate .sidekicks/index.json
  log("Step 8: generating PACKAGE.md");
  let pkgJson = {};
  try {
    pkgJson = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  } catch {
    pkgJson = {};
  }

  const manifestEntry = plan.generated.find((g) => g.kind === "manifest");
  if (manifestEntry) {
    const manifestContent = generatePackageManifest({
      version: pkgJson.version ?? "0.0.0",
      includedComponents: [],
      includesClaude: includeClaude,
      includesGemini: includeGemini,
      includesAgent: includeAgent,
    });
    try {
      writeFileSync(manifestEntry.path, manifestContent, "utf8");
    } catch (err) {
      throw new SidekicksError(
        `package create: cannot write PACKAGE.md: ${err.message}`,
        EXIT_IO
      );
    }
  }

  log("Step 8: regenerating .sidekicks/index.json via package CLI");
  const nodeExe = process.execPath;
  const binPath = join(outputPath, "bin", "sidekicks");
  if (existsSync(binPath)) {
    const rebuildResult = spawnSync(nodeExe, [binPath, "index", "rebuild"], {
      cwd: outputPath,
      encoding: "utf8",
      timeout: 30000,
    });
    if (rebuildResult.status !== 0) {
      const hint = "Run `node bin/sidekicks index rebuild` from the package root to fix.";
      throw new SidekicksError(
        `package create: index rebuild failed (exit ${rebuildResult.status}).\n  ${hint}\n  ${rebuildResult.stderr || ""}`,
        EXIT_VALIDATION
      );
    }
    log("Step 8: index rebuild succeeded");
  } else {
    log("Step 8: bin/sidekicks not found in output — skipping index rebuild");
  }

  // Step 9: Validate the assembled package
  log("Step 9: validating package");
  try {
    validatePackage(outputPath);
    log("Step 9: validation passed");
  } catch (err) {
    if (err instanceof SidekicksError) {
      throw new SidekicksError(
        `package create: Step 9 validation failed — ${err.message}`,
        EXIT_VALIDATION
      );
    }
    throw err;
  }

  // Step 10: Summary
  log("Step 10: generating summary");
  const totalFiles = _countFiles(outputPath);

  const summary = [
    `Package assembled and validated successfully.`,
    "",
    `  Location:  ${outputPath}`,
    `  Copied:    ${plan.copies.length} items`,
    `  Symlinks:  ${plan.symlinks.length} recreated`,
    `  Generated: ${plan.generated.length} files`,
    `  Excluded:  ${plan.excluded.length} items`,
    `  Total files in package: ${totalFiles}`,
    `  Validation: PASSED (all §7 checks)`,
    "",
  ].join("\n");

  return { stdout: summary, exitCode: EXIT_OK };
}

/**
 * Count total files in a directory recursively.
 * @param {string} dir
 * @returns {number}
 */
function _countFiles(dir) {
  let count = 0;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const p = join(dir, entry);
      try {
        const s = statSync(p);
        if (s.isFile()) count++;
        else if (s.isDirectory()) count += _countFiles(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return count;
}

/**
 * Format a dry-run plan for display.
 * @param {object} plan
 * @param {string} outputPath
 * @returns {string}
 */
function _formatDryRunPlan(plan, outputPath) {
  const lines = [
    `DRY RUN — package create --output ${outputPath}`,
    "",
    `Would copy (${plan.copies.length}):`,
    ...plan.copies.map((c) => `  ${c.src} → ${c.dst}${c.preserveMode ? " [0755]" : ""}`),
    "",
    `Would create symlinks (${plan.symlinks.length}):`,
    ...plan.symlinks.map((s) => `  ${s.path} → ${s.target}`),
    "",
    `Would generate (${plan.generated.length}):`,
    ...plan.generated.map((g) => `  ${g.path} (${g.kind})`),
    "",
    `Excluded (${plan.excluded.length}):`,
    ...plan.excluded.map((e) => `  ${e}`),
    "",
    "(No files written — dry run)",
    "",
  ];
  return lines.join("\n");
}
