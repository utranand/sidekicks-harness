// lib/package-lifecycle/transfer.mjs
// Verb entry for `sidekicks package transfer`.
// NOT barrel-exported — reached via the dispatcher's lazy import().

import { parseArgs } from "node:util";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SidekicksError, EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, EXIT_NOT_FOUND } from "../sk-cli/errors.mjs";
import { ensureComponentVersions, checkComponentVersions, compareVersions } from "./componentVersions.mjs";
import { computeImportClosure } from "./closure.mjs";
import { skillClosure } from "../skill-package/closure.mjs";
import { copyTree } from "./fs-copy.mjs";
import { mkdirp } from "../fs-safety/fsx.mjs";
import { isInside, badPathComponent } from "../fs-safety/canonical-path.mjs";
// Skill prefix for `--all` enumeration.
import { SKILL_PREFIX } from "../sk-cli/skill-trees.mjs";

/**
 * Run the `package transfer` verb.
 * Exports named libs/skills into a portable output folder with optional closure resolution.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string|undefined, rest: string[], flags: object }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot, argv, log } = ctx;

  // Per-verb flag parsing over the full ctx.argv
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output:          { type: "string" },
      all:             { type: "boolean", default: false },
      "with-deps":     { type: "boolean", default: false },
      "version-check": { type: "boolean", default: false },
      "dry-run":       { type: "boolean", default: false },
      verbose:         { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  // positionals: ['package', 'transfer', ...unitNames]
  const unitArgs = positionals.slice(2); // drop 'package', 'transfer'
  const doAll = values.all;
  const withDeps = values["with-deps"];
  const versionCheck = values["version-check"];
  const dryRun = values["dry-run"];

  // Step 1: Determine units
  const libDir = join(repoRoot, "lib");
  const skillsDir = join(repoRoot, '.agents', 'skills');

  let units = [];
  if (doAll) {
    // All lib/* subsystems + every first-party skill (SKILL_PREFIX)
    if (existsSync(libDir)) {
      units.push(...readdirSync(libDir).filter((e) => {
        try { return existsSync(join(libDir, e)) && !e.startsWith("."); } catch { return false; }
      }).map((e) => ({ name: e, kind: "lib" })));
    }
    if (existsSync(skillsDir)) {
      units.push(...readdirSync(skillsDir)
        .filter((e) => e.startsWith(SKILL_PREFIX))
        .map((e) => ({ name: e, kind: "skill" })));
    }
  } else {
    if (unitArgs.length === 0) {
      throw new SidekicksError(
        "package transfer: at least one <unit> is required, or use --all",
        EXIT_USAGE
      );
    }
    for (const name of unitArgs) {
      // A unit name is ONE path component, and nothing else. Existence was previously the only
      // check, which answers a different question: join() collapses `..` before the stat, so
      // `package transfer ../scripts` found <repo>/scripts, classified it as a lib unit, and copied
      // it to join(outputBase, '../scripts') — outside the directory the caller asked for, and the
      // command still exited 0. Reject the shape first; then the existence probe can only ever be
      // about a real unit.
      const bad = badPathComponent(name);
      if (bad) {
        throw new SidekicksError(
          `package transfer: '${name}' is not a unit name — it ${bad}. A unit is a single directory `
          + "name under lib/ or .agents/skills/, never a path.",
          EXIT_USAGE
        );
      }
      const inLib = existsSync(join(libDir, name));
      const inSkills = existsSync(join(skillsDir, name));
      if (!inLib && !inSkills) {
        throw new SidekicksError(
          `package transfer: unknown unit '${name}' — not found in lib/ or .agents/skills/`,
          EXIT_NOT_FOUND
        );
      }
      units.push({ name, kind: inLib ? "lib" : "skill" });
    }
  }

  // Step 2: Determine output folder (default: output/transfer/ in-repo; --output overrides)
  const outputBase = values.output
    ? resolve(values.output)
    : join(repoRoot, "output", "transfer");

  log(`package transfer: output=${outputBase} withDeps=${withDeps} versionCheck=${versionCheck}`);

  // Step 3: Existing-content check
  const alreadyPresent = [];
  for (const { name } of units) {
    const dstPath = join(outputBase, name);
    if (existsSync(dstPath)) {
      alreadyPresent.push(name);
    }
  }
  if (alreadyPresent.length > 0) {
    log(`package transfer: units already at destination (will overwrite): ${alreadyPresent.join(", ")}`);
  }

  // Step 4: Version pre-flight
  log("Step 4: version pre-flight");
  ensureComponentVersions(repoRoot);
  if (existsSync(outputBase)) {
    const classifications = checkComponentVersions(repoRoot, outputBase);
    for (const { name } of units) {
      const cls = classifications[name];
      if (!cls) continue; // new unit — fine
      if (versionCheck && cls === "downgrade") {
        throw new SidekicksError(
          `package transfer: unit '${name}' would be a downgrade (source < dest). Remove --version-check to force.\n  Hint: bump the source version or remove --version-check.`,
          EXIT_VALIDATION
        );
      }
    }
  }

  const closureMap = new Map();   // lib unit name → Set of lib deps
  const omittedDeps = new Set();  // display strings, already prefixed with lib/ or skills/

  // Step 5a: Skill closure, from what each skill's manifest DECLARES.
  //
  // This used to read `if (kind !== "lib") continue; // skills are self-contained`, which was not
  // true of any skill carrying a manifest: `package transfer <skill> --with-deps` silently omitted
  // its sibling skills, its rule bodies, its config defaults and every repo-root file it reads, and
  // reported success. AAP-100 gave skills a declaration; AAP-96 gave the repo one closure function;
  // this consumes it rather than keeping a fourth opinion about what a skill needs.
  const skillUnits = units.filter((u) => u.kind === "skill").map((u) => u.name);
  const skillNotes = [];
  if (skillUnits.length > 0) {
    const closure = skillClosure(repoRoot, skillUnits, { scope: "runtime" });
    const present = new Set(units.map((u) => u.name));
    const siblings = closure.selected
      .map((s) => s.skill)
      .filter((s) => !present.has(s));

    if (withDeps) {
      for (const dep of siblings) {
        units.push({ name: dep, kind: "skill" });
        present.add(dep);
      }
    } else {
      for (const dep of siblings) omittedDeps.add(`skills/${dep}`);
    }

    // The sections that cannot travel with a folder no matter what --with-deps does. Reported
    // rather than copied: a repo-root file and a hook belong to the DESTINATION repo, and a hook
    // additionally needs wiring in four per-CLI configs (Rule 6). Staying silent about them is what
    // makes a transfer look complete when it is not.
    for (const f of closure.framework_files) skillNotes.push(`framework file  ${f.path}`);
    for (const h of closure.framework_hooks) {
      skillNotes.push(`hook            ${h.id}  (plus wiring in 4 CLI configs — Rule 6)`);
    }
    for (const h of closure.host_paths) skillNotes.push(`host path       ${h.path}`);
    for (const b of closure.binaries) skillNotes.push(`binary          ${b.name}`);
    for (const m of closure.missing) {
      skillNotes.push(`MISSING sibling ${m.skill}  (needed by ${m.needed_by.join(", ")})`);
    }
  }

  // Step 5b: Import closure for lib/ units — a DIFFERENT graph (static .mjs imports between lib
  // modules), which is why closure.mjs stays as it is rather than being folded into skillClosure.
  for (const { name, kind } of units) {
    if (kind !== "lib") continue;
    const closure = computeImportClosure(repoRoot, name);
    // Remove the unit itself from deps
    closure.delete(name);
    // Remove deps that are already in the unit list
    const unitNames = new Set(units.map((u) => u.name));
    const siblings = [...closure].filter((dep) => !unitNames.has(dep));

    if (withDeps) {
      // Add sibling deps to units
      for (const dep of siblings) {
        if (!unitNames.has(dep)) {
          units.push({ name: dep, kind: "lib" });
          unitNames.add(dep);
        }
      }
      closureMap.set(name, new Set(siblings));
    } else {
      // Report omitted deps
      for (const dep of siblings) {
        omittedDeps.add(`lib/${dep}`);
      }
    }
  }

  if (dryRun) {
    const lines = [
      `DRY RUN — package transfer`,
      "",
      `Units to transfer (${units.length}):`,
      ...units.map((u) => `  ${u.kind === "lib" ? "lib/" : "skills/"}${u.name}`),
    ];
    if (omittedDeps.size > 0) {
      lines.push("", `Dependencies omitted (use --with-deps to include):`);
      for (const d of omittedDeps) lines.push(`  ${d}`);
    }
    if (skillNotes.length > 0) {
      lines.push("", `Does NOT travel with a skill folder — reconcile at the destination:`);
      for (const n of skillNotes) lines.push(`  ${n}`);
    }
    lines.push("", `Output: ${outputBase}`, "", "(No files written — dry run)");
    return { stdout: lines.join("\n") + "\n", exitCode: EXIT_OK };
  }

  // Step 6: Copy each unit
  mkdirp(outputBase);

  // Build exclude set for copy
  const excludePatterns = new Set([".venv", "__pycache__", "node_modules"]);

  const transferredFiles = [];
  for (const { name, kind } of units) {
    const srcDir =
      kind === "lib"
        ? join(libDir, name)
        : join(skillsDir, name);
    const dstDir = join(outputBase, name);

    if (!existsSync(srcDir)) continue;

    // Containment is re-checked HERE, on the paths actually about to be read and written, rather
    // than trusted from the name validation above. The two checks are deliberately independent: the
    // name check is a syntactic filter on argv, and this one is the last thing between a resolved
    // path and copyTree — which by design carries no guard of its own (fs-copy.mjs: "MUST NOT call
    // assertWritable — the external destination is outside the guarded surface"). A symlinked unit
    // directory or a symlinked outputBase makes the syntactic answer and the real answer differ, and
    // only this one is about where the bytes land.
    const base = kind === "lib" ? libDir : skillsDir;
    if (!isInside(srcDir, base)) {
      throw new SidekicksError(
        `package transfer: unit '${name}' resolves outside ${kind === "lib" ? "lib/" : ".agents/skills/"} — refusing to copy it`,
        EXIT_VALIDATION
      );
    }
    if (!isInside(dstDir, outputBase)) {
      throw new SidekicksError(
        `package transfer: destination for '${name}' resolves outside the requested output `
        + `'${outputBase}' — refusing to write there`,
        EXIT_VALIDATION
      );
    }

    copyTree(srcDir, dstDir, { exclude: excludePatterns });
    transferredFiles.push(name);
    log(`transfer: ${kind}/${name} → ${dstDir}`);
  }

  // Step 7: Report
  const lines = [
    `Transfer complete.`,
    "",
    `  Output:    ${outputBase}`,
    `  Transferred (${transferredFiles.length}):`,
    ...transferredFiles.map((n) => `    ${n}`),
  ];

  if (omittedDeps.size > 0) {
    lines.push(
      "",
      `  Dependencies NOT transferred (use --with-deps to include):`,
      ...[...omittedDeps].map((d) => `    ${d}`)
    );
  }

  if (skillNotes.length > 0) {
    lines.push(
      "",
      `  Does NOT travel with a skill folder — reconcile at the destination:`,
      ...skillNotes.map((n) => `    ${n}`)
    );
  }

  if (withDeps && closureMap.size > 0) {
    lines.push("", `  Resolved closure deps included:`);
    for (const [unit, deps] of closureMap) {
      if (deps.size > 0) {
        lines.push(`    ${unit}: ${[...deps].join(", ")}`);
      }
    }
  }

  lines.push(
    "",
    `  Integration steps:`,
    `    1. Copy the output/ contents into target repo's lib/ or .agents/skills/`,
    `    2. Run \`node bin/sidekicks package versions\` to ensure VERSION.json files`,
    `    3. Run \`node bin/sidekicks index rebuild\` to update the registry`,
    ""
  );

  return { stdout: lines.join("\n"), exitCode: EXIT_OK };
}
