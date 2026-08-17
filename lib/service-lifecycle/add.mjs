// lib/service-lifecycle/add.mjs
// Implements `sidekicks service add <name> [<git-url>]`.
//
// Registers a service WITHOUT acquiring its code. `add` is now a lightweight,
// network-free structural operation:
//   - scaffolds projects/<active>/services/<name>/{docs/, service.yaml}
//   - records remote_source (the optional <git-url>) so a later pull knows where to fetch
//   - leaves branch/commit null until `service pull` populates a src/ working tree
//
// The actual clone/submodule acquisition is deferred to `service pull [<name>] [<branch>]`,
// which the user runs on demand when the code is actually needed. This keeps `add` fast,
// offline, and free of partial-checkout rollback concerns: a failed network fetch can never
// leave a half-registered service behind, because add never touches the network.
//
// On success: docs/ scaffold + service.write + manifest.addService + settings.setActiveService.
//
// Zero npm dependencies — node:fs, node:path only (plus relative lib/ imports).

import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SidekicksError,
  EXIT_OK,
  EXIT_VALIDATION,
} from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { mkdirp, writeAtomic } from '../fs-safety/fsx.mjs';
import { read as readSettings, setActiveService } from '../settings-store/settings.mjs';
import { read as readManifest, addService } from '../manifest-schema/manifest.mjs';
import { deriveName, write as writeService } from '../manifest-schema/service.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { rebuildProjectIndex } from '../scope-index/index.mjs';

/**
 * Execute the `service add <name> [<git-url>]` verb.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string, rest: string[], flags: object }} args
 *   - args.name    → <name>      (first positional after the verb — required)
 *   - args.rest[0] → [<git-url>] (optional remote source; recorded but NOT pulled)
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  // Extract positional args from the cli.mjs arg shape:
  //   args.name  = verbArgs[0]  = <name>
  //   args.rest  = verbArgs.slice(1), so args.rest[0] = optional <git-url>
  const optName = args && args.name != null ? String(args.name).trim() : '';
  const url =
    args && args.rest && args.rest[0] != null ? String(args.rest[0]).trim() : null;

  if (!optName) {
    throw new SidekicksError(
      'usage: sidekicks service add <name> [<git-url>]',
      EXIT_VALIDATION
    );
  }

  // ── Precondition 1: active ≠ root ─────────────────────────────────────────
  const settings = readSettings(repoRoot);
  const scope = resolveEffectiveScope(settings);

  if (scope.projectName === 'sidekicks') {
    throw new SidekicksError(
      "service add requires an active user project; switch with 'project use <name>' first",
      EXIT_VALIDATION
    );
  }

  // ── Precondition 2: projects/<active>/ exists as a directory ───────────────
  const projectDir = join(repoRoot, 'projects', scope.projectName);
  let stat;
  try { stat = statSync(projectDir); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) {
    throw new SidekicksError(
      `active project directory projects/${scope.projectName}/ does not exist (stale pointer)`,
      EXIT_VALIDATION
    );
  }

  // ── Precondition 3: name validation (no derivation — name is explicit) ─────
  // deriveName validates the explicit name: pattern, reserved, and not-exists checks.
  const servicesDir = join(projectDir, 'services');
  const name = deriveName('', optName, servicesDir);

  // ── Precondition 4: manifest readable (must exist for addService) ──────────
  // readManifest throws EXIT_VALIDATION if absent or malformed.
  const manifestPath = join(projectDir, 'manifest.yaml');
  readManifest(manifestPath);

  // ── Scaffold the service tree (structural write, no network) ──────────────
  const serviceDir = join(servicesDir, name);
  assertWritable(serviceDir, repoRoot);

  // docs/ is owned by every service from creation — seeded with .gitkeep so the
  // empty directory is tracked. src/ is intentionally NOT created here; it is
  // populated on demand by `service pull`.
  const docsGitkeep = join(serviceDir, 'docs', '.gitkeep');
  assertWritable(docsGitkeep, repoRoot);
  mkdirp(join(serviceDir, 'docs'));
  writeAtomic(docsGitkeep, '');

  // ── Write service.yaml (atomic) ───────────────────────────────────────────
  // branch/commit are null until `service pull` reads git state from a real src/.
  const serviceYamlPath = join(serviceDir, 'service.yaml');
  assertWritable(serviceYamlPath, repoRoot);
  writeService(serviceYamlPath, {
    name,
    remote_source: url || null,
    branch: null,
    commit: null,
  });

  // ── Manifest addService (atomic, idempotent) ──────────────────────────────
  assertWritable(manifestPath, repoRoot);
  addService(manifestPath, `services/${name}`);

  // ── settings.setActiveService (RMW, preserves active_project) ─────────────
  setActiveService(repoRoot, name);

  // ── Rebuild project index (Epic 4, Story 4.2) ────────────────────────────
  // Tail-call after all mutations succeed. Only the owning project's index is
  // rebuilt; the root index is left untouched (service verbs are project-level).
  // Best-effort wrapping is added in Story 4.3 — errors propagate here.
  rebuildProjectIndex(repoRoot, scope.projectName);

  // ── Next-step guidance ────────────────────────────────────────────────────
  const lines = [`Added service '${name}' and set it active. Created docs/.`];
  if (url) {
    lines.push('');
    lines.push('Source not yet pulled. When you need the code, fetch it on demand:');
    lines.push(`  node bin/sidekicks service pull ${name} [<branch>]   # branch defaults to main`);
  } else {
    lines.push('');
    lines.push('No remote recorded — this is a local-only service. Write its docs/ and src/ directly,');
    lines.push("or record a remote_source in service.yaml later and run 'service pull'.");
  }

  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}
