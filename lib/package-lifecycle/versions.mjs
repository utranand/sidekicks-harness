// lib/package-lifecycle/versions.mjs
// Verb entry for `sidekicks package versions`.
// Reached via the dispatcher's lazy import — intentionally NOT barrel-exported.
// Pure Node ESM, zero npm deps.

import { ensureComponentVersions } from "./componentVersions.mjs";
import { EXIT_OK } from "../sk-cli/errors.mjs";

/**
 * Run the `package versions` verb.
 * Calls ensureComponentVersions(repoRoot) and prints a created-vs-existing report.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string|undefined, rest: string[], flags: object }} args
 * @returns {{ stdout: string, exitCode: number }}
 */
export async function run(ctx, args) {
  const { repoRoot, log } = ctx;

  log("package versions: ensuring VERSION.json across libs and skills");

  const { created, existing } = ensureComponentVersions(repoRoot);

  const lines = [];
  lines.push("VERSION.json report:");
  lines.push("");

  if (created.length > 0) {
    lines.push(`Created (${created.length}):`);
    for (const p of created) {
      lines.push(`  + ${p}`);
    }
    lines.push("");
  }

  if (existing.length > 0) {
    lines.push(`Existing (${existing.length}):`);
    for (const p of existing) {
      lines.push(`  = ${p}`);
    }
    lines.push("");
  }

  if (created.length === 0 && existing.length === 0) {
    lines.push("  (no lib/* or .agents/skills/* components found)");
    lines.push("");
  }

  lines.push(
    `Summary: ${created.length} created, ${existing.length} already valid.`
  );
  lines.push("");

  const stdout = lines.join("\n");

  return { stdout, exitCode: EXIT_OK };
}
