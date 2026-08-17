// lib/package-lifecycle/closure.mjs
// Static import-closure analyzer for lib/ subsystems.
// Computes the transitive set of intra-lib/ dependencies for a given module.
// Barrel-exported.
//
// KNOWN LIMITATION: This is a static scan — it reads .mjs source files and extracts
// literal relative import specifiers. It CANNOT see dynamic imports built from string
// templates, such as the dispatcher's lazy-import pattern:
//   import(`../${namespace}-lifecycle/${verb}.mjs`)
// These string-built specifiers are a known blind spot for v1 static analysis.
// PRD Growth covers dynamic resolution tooling for future versions.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * Compute the transitive import closure for a lib/ module.
 * Returns the deduped set of intra-lib/ module names that the given module (and its
 * dependencies) import — including the module itself.
 *
 * The scan reads all `.mjs` files in the unit's directory and extracts relative imports
 * of the form `from '../<other>/...'` or `from "../../<other>/..."`. Only intra-lib/
 * dependencies (one level up from the module dir) are included.
 *
 * @param {string} repoRoot   Absolute path to the repository root.
 * @param {string} libModule  The lib/ module name to start from (e.g. "scope-lifecycle").
 * @returns {Set<string>}     Deduped set of lib/ module names in the closure.
 */
export function computeImportClosure(repoRoot, libModule) {
  const libDir = join(repoRoot, "lib");
  const visited = new Set();
  const queue = [libModule];

  while (queue.length > 0) {
    const mod = queue.shift();
    if (visited.has(mod)) continue;
    visited.add(mod);

    const modDir = join(libDir, mod);
    if (!existsSync(modDir)) continue;

    // Read all .mjs files in the module directory (non-recursive for v1)
    let files;
    try {
      files = readdirSync(modDir).filter((f) => f.endsWith(".mjs"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(modDir, file);
      let content;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }

      // Extract relative import specifiers: from '../<other>/...' or from "../../lib/<other>/..."
      // We look for patterns like: from '../<name>' or from '../<name>/'
      // This is a conservative static approximation.
      const importRe = /from\s+['"](\.\.[/\\][^'"]+)['"]/g;
      let match;
      while ((match = importRe.exec(content)) !== null) {
        const specifier = match[1];
        // Parse the module name from the relative path
        // Patterns:
        //   ../sk-cli/errors.mjs  → lib/sk-cli
        //   ../../lib/sk-cli/... → lib/sk-cli (if starting from a sub-sub dir)
        //   ../other-module/index.mjs   → lib/other-module
        const parts = specifier.split(/[/\\]/);
        // Find the first non-'..' part after the relative prefix
        const firstNonDotDot = parts.find((p) => p !== ".." && p !== ".");
        if (firstNonDotDot && firstNonDotDot !== "lib" && firstNonDotDot !== "") {
          // This looks like a sibling lib module
          const dep = firstNonDotDot;
          // Only add if it's actually a known lib/ directory
          if (existsSync(join(libDir, dep)) && !visited.has(dep)) {
            queue.push(dep);
          }
        }
      }
    }
  }

  return visited;
}
