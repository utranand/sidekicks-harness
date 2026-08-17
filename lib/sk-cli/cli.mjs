// lib/sk-cli/cli.mjs
// Primary dispatcher for the sidekicks CLI.
// Exports main(argv): Promise<void>.
// Side effects: writes to process.stdout / process.stderr; calls process.exit(code).
// Throws nothing — converts SidekicksError to exit code, formats single-line, writes to stderr.
//
// Verb dispatch uses lazy import() so each verb's dependency closure is loaded only
// when that verb is invoked — keeping cold-start times within the 200ms budget.

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { VERBS, NAMESPACES, renderHelp } from "./help.mjs";
import { SidekicksError, EXIT_OK, EXIT_USAGE } from "./errors.mjs";
import { resolveRepoRoot } from "./paths.mjs";
import { ensureSkillLinks, ensureCoreSkillOverlay } from "./skill-links.mjs";

// Resolve package.json once at module load (static — will not change at runtime).
const _pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
const _pkg = JSON.parse(readFileSync(_pkgPath, "utf8"));
const _version = _pkg.version ?? "0.0.0-pre-mvp";

/**
 * Write to a stream, then exit — WITHOUT truncating buffered output.
 *
 * `process.exit()` drops any bytes still draining to a PIPE (a SessionStart hook,
 * `$(...)` capture, `| grep`) — it is only safe on a TTY, where stdout is
 * synchronous. A piped consumer therefore silently loses the tail of large output
 * (e.g. `memory list`, `--help`). The write callback fires only after the chunk is
 * flushed to the OS, so exiting from inside it guarantees the full payload is out.
 * The pending write keeps the event loop alive until then; callers MUST `return`
 * after calling this so synchronous code below does not run before the exit.
 *
 * @param {NodeJS.WritableStream} stream - process.stdout or process.stderr
 * @param {string} data - payload to write (may be empty)
 * @param {number} code - process exit code
 */
function writeThenExit(stream, data, code) {
  if (!data) { process.exit(code); return; }
  stream.write(data, () => process.exit(code));
}

/**
 * Main dispatcher entry point.
 *
 * @param {string[]} argv - process.argv.slice(2) — the raw argument list.
 * @returns {Promise<void>}
 */
export async function main(argv) {
  // Parse flags — booleans only; allow unknown positionals via allowPositionals.
  let flags, positionals;
  try {
    const result = parseArgs({
      args: argv,
      options: {
        help:    { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
        verbose: { type: "boolean",              default: false },
      },
      allowPositionals: true,
      strict: false,
    });
    flags = result.values;
    positionals = result.positionals;
  } catch (err) {
    writeThenExit(process.stderr, `error: ${err.message}\n`, EXIT_USAGE);
    return;
  }

  // Tie-breaking rule: --help short-circuits before --version.
  // Both short-circuit before ctx / resolveRepoRoot so they work outside a Sidekicks repo.

  if (flags.help) {
    // Namespace-scoped help: `sidekicks project --help`, `service --help`, or `scope --help`.
    const ns = positionals[0];
    // No dispatcher change is needed beyond this topic-check extension: the existing
    // lazy-import at L110 (`import(\`../${namespace}-lifecycle/${verb}.mjs\`)`) already
    // resolves lib/database-lifecycle/{verb}.mjs for any registered VERBS entry — dispatch
    // is automatic for any namespace registered in VERBS. NAMESPACES is derived from VERBS
    // (help.mjs), so a newly-registered namespace never needs a second edit here.
    const topic = NAMESPACES.includes(ns) ? ns : null;
    writeThenExit(process.stdout, renderHelp(topic) + "\n", EXIT_OK);
    return;
  }

  if (flags.version) {
    writeThenExit(process.stdout, _version + "\n", EXIT_OK);
    return;
  }

  // Bare invocation — no args after flags stripped.
  if (positionals.length === 0) {
    writeThenExit(process.stderr, renderHelp() + "\n", EXIT_USAGE);
    return;
  }

  // Build ctx — resolveRepoRoot is called here, after the early exits above.
  let repoRoot;
  try {
    repoRoot = resolveRepoRoot();
  } catch (err) {
    if (err instanceof SidekicksError) {
      const msg = flags.verbose
        ? `error: ${err.message}\n${err.stack}\n`
        : `error: ${err.message}\n`;
      writeThenExit(process.stderr, msg, err.exitCode);
      return;
    }
    throw err;
  }

  const log = (msg) => {
    if (flags.verbose) {
      process.stderr.write(msg + "\n");
    }
  };

  const ctx = { repoRoot, argv, flags, log };

  // Self-heal skill exposure. Both passes are untracked-and-recreated for the same reason (a
  // committed symlink checks out as a text stub on Windows) and both are best-effort: link upkeep
  // never breaks a verb.
  //
  // Order matters. The overlay populates .agents/skills from a mounted framework core
  // (.sidekicks-core/), so it must run BEFORE the host-level links, whose ensureOneLink refuses to
  // create a dangling link at a target that does not exist yet.
  ensureCoreSkillOverlay(repoRoot, log);
  ensureSkillLinks(repoRoot, log);

  // Verb dispatch.
  const namespace = positionals[0];
  const verb      = positionals[1];
  // Positional args after namespace + verb (e.g., the <name> in `project create <name>`).
  const verbArgs  = positionals.slice(2);

  // Check if the invocation matches a known verb from the VERBS table.
  const knownVerb = VERBS.find(
    (v) => v.namespace === namespace && v.verb === verb
  );

  if (knownVerb) {
    // Lazy-load the verb module — keeps cold-start within the cold-start budget.
    let verbModule;
    try {
      verbModule = await import(`../${namespace}-lifecycle/${verb}.mjs`);
    } catch (err) {
      // Module not yet implemented.
      writeThenExit(
        process.stderr,
        `error: verb '${namespace} ${verb}' not yet implemented — run 'sidekicks --help'\n`,
        EXIT_USAGE
      );
      return;
    }

    // Build args object: first positional becomes `name`, remaining become `rest`.
    // Individual verb modules may refine this mapping; this is the baseline shape.
    const args = {
      name:  verbArgs[0],
      rest:  verbArgs.slice(1),
      flags,
    };

    let result;
    try {
      result = await verbModule.run(ctx, args);
    } catch (err) {
      if (err instanceof SidekicksError) {
        const msg = flags.verbose
          ? `error: ${err.message}\n${err.stack}\n`
          : `error: ${err.message}\n`;
        writeThenExit(process.stderr, msg, err.exitCode);
        return;
      }
      throw err;
    }

    const code = result ? (result.exitCode ?? EXIT_OK) : EXIT_OK;
    writeThenExit(process.stdout, result && result.stdout ? result.stdout : "", code);
    return;
  }

  // Not a known (namespace, verb) pair. Three distinct situations hid behind one message —
  // `sidekicks definitely-not-a-namespace` reported "unknown verb", which sends the reader
  // hunting for a typo in a word that was never a verb. Each gets its own diagnostic, and each
  // points at the help that can actually answer it.
  const nsKnown = NAMESPACES.includes(namespace);

  if (!nsKnown) {
    const near = nearestNamespace(namespace);
    writeThenExit(
      process.stderr,
      `error: unknown namespace '${namespace}'${near ? ` — did you mean '${near}'?` : ''}`
        + ` — run 'sidekicks --help' to list namespaces\n`,
      EXIT_USAGE
    );
    return;
  }

  if (!verb) {
    writeThenExit(
      process.stderr,
      `error: namespace '${namespace}' needs a verb — run 'sidekicks ${namespace} --help'\n`,
      EXIT_USAGE
    );
    return;
  }

  const known = VERBS.filter((v) => v.namespace === namespace).map((v) => v.verb);
  writeThenExit(
    process.stderr,
    `error: unknown verb '${verb}' in namespace '${namespace}' — known verbs: ${known.join(', ')}`
      + ` — run 'sidekicks ${namespace} --help'\n`,
    EXIT_USAGE
  );
}

/**
 * The closest namespace to a typo, or null when nothing is close.
 *
 * Deliberately cheap: a prefix/substring relation plus a length-bounded edit distance. The point
 * is to catch `projct` and `serivce`, not to be a spell checker — a wrong suggestion is worse
 * than none, so the threshold is tight and an unrelated word yields null.
 *
 * @param {string} word - the namespace the user typed
 * @returns {string|null}
 */
function nearestNamespace(word) {
  const w = String(word || '').toLowerCase();
  if (w.length < 3) return null;
  let best = null;
  let bestScore = Infinity;
  for (const ns of NAMESPACES) {
    if (ns.startsWith(w) || w.startsWith(ns)) return ns;
    const d = editDistance(w, ns);
    if (d < bestScore) { bestScore = d; best = ns; }
  }
  // At most a third of the word may differ, and never more than two edits.
  const limit = Math.min(2, Math.floor(w.length / 3));
  return bestScore <= limit ? best : null;
}

/**
 * Levenshtein distance over two short strings (two-row DP — no allocation per cell).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}
