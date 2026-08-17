// lib/service-lifecycle/remove.mjs
// Implements `sidekicks service remove <service-name> [--force]`.
// Symmetric counterpart to service add.
//
// A service lives at projects/<active>/services/<name>/ with the actual repo at
// services/<name>/src — a git submodule (when the project has remote_source) or a
// plain clone (when it does not). Removal must therefore:
//   • deregister the submodule from the PROJECT repo (.gitmodules + gitlink +
//     .git/modules/<path>) when src/ is a submodule — staging the change
//   • delete the whole services/<name>/ tree (service.yaml + src/)
//   • drop the entry from the manifest's services: list
//   • null active_service when the removed service was the active one
//
// Risk model mirrors `project remove`: confirmation is required only when the
// deletion is not git-recoverable — src/ is not its own repo, or it is but has
// uncommitted changes. A clean, git-guarded service removes without a prompt.
// (Scoped to working-tree cleanliness; does NOT inspect push state.)
//
// Zero npm dependencies — node:*, relative lib/ imports only.
// All git spawns delegated to git-delegation/git.mjs; shell: false everywhere.

import { statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import {
  SidekicksError,
  EXIT_OK,
  EXIT_VALIDATION,
  EXIT_IO,
} from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { rmrf } from '../fs-safety/fsx.mjs';
import { read as readSettings, setActiveService } from '../settings-store/settings.mjs';
import { read as readManifest, removeService } from '../manifest-schema/manifest.mjs';
import {
  rootSubmoduleHas,
  submoduleDeregister,
  isRepo,
  hasUncommittedChanges,
} from '../git-delegation/git.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { rebuildProjectIndex } from '../scope-index/index.mjs';

/**
 * Prompt for confirmation on a TTY stdin. Resolves true only on 'y'/'Y'.
 *
 * @param {string} question - Prompt text (written to stderr).
 * @param {NodeJS.ReadableStream} [inputStream] - Override stdin (for unit testing).
 * @returns {Promise<boolean>}
 */
async function promptConfirm(question, inputStream = process.stdin) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const rl = createInterface({
      input: inputStream,
      output: process.stderr,
      terminal: false,
    });

    process.stderr.write(question);

    rl.once('line', (line) => {
      const answer = (line || '').trim();
      settle(answer === 'y' || answer === 'Y');
      rl.close();
    });

    rl.once('close', () => settle(false));
  });
}

/**
 * Execute the `service remove <service-name> [--force]` verb.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string, rest: string[], flags: object }} args
 *   - args.name → <service-name> (first positional after the verb)
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = args && args.name != null ? String(args.name) : '';
  const force = Boolean(
    (args && args.flags && args.flags.force) || (ctx.flags && ctx.flags.force)
  );

  // ── Step 1: Validation ────────────────────────────────────────────────────
  if (!name || name.trim() === '') {
    throw new SidekicksError(
      'usage: sidekicks service remove <service-name> [--force]',
      EXIT_VALIDATION
    );
  }

  // ── Precondition: active scope must be a user project (not root) ───────────
  const settings = readSettings(repoRoot);
  const scope = resolveEffectiveScope(settings);
  if (scope.projectName === 'sidekicks') {
    throw new SidekicksError(
      "service remove requires an active user project; switch with 'project use <name>' first",
      EXIT_VALIDATION
    );
  }

  // ── Precondition: projects/<active>/ exists ───────────────────────────────
  const projectDir = join(repoRoot, 'projects', scope.projectName);
  let pStat;
  try { pStat = statSync(projectDir); } catch { pStat = null; }
  if (!pStat || !pStat.isDirectory()) {
    throw new SidekicksError(
      `active project directory projects/${scope.projectName}/ does not exist (stale pointer)`,
      EXIT_VALIDATION
    );
  }

  // ── Precondition: the service exists ──────────────────────────────────────
  const serviceDir = join(projectDir, 'services', name);
  let sStat;
  try { sStat = statSync(serviceDir); } catch { sStat = null; }
  if (!sStat || !sStat.isDirectory()) {
    throw new SidekicksError(
      `service '${name}' does not exist (projects/${scope.projectName}/services/${name}/ not found)`,
      EXIT_VALIDATION
    );
  }

  // ── Precondition: manifest readable (fail BEFORE any deletion) ────────────
  // Read it now so a malformed manifest aborts the command before we delete the
  // tree, never leaving the manifest and filesystem out of sync.
  const manifestPath = join(projectDir, 'manifest.yaml');
  readManifest(manifestPath);

  // ── Step 2: Assess git-recoverability risk ────────────────────────────────
  // The service's repo is src/. It is git-guarded when src/ is its own working
  // tree (submodule or clone). Confirmation is required only for risky cases:
  //   • not git-guarded       → no git backing; deletion is unrecoverable
  //   • git-guarded but dirty → staged/unstaged/untracked work would be lost
  const srcDir = join(serviceDir, 'src');
  const guarded = isRepo(srcDir);
  const dirty = guarded && hasUncommittedChanges(srcDir);
  const risky = !guarded || dirty;

  // ── Step 3: Confirmation (only when risky, unless --force) ────────────────
  const stdinStream = ctx._stdin || process.stdin;
  if (risky && !force) {
    if (!stdinStream.isTTY) {
      throw new SidekicksError(
        'non-TTY stdin requires --force to remove this service; re-run with --force to confirm',
        EXIT_VALIDATION
      );
    }
    const question = dirty
      ? `services/${name}/ has uncommitted changes that will be permanently lost. Delete anyway? [y/N] `
      : `services/${name}/ is not tracked by git — its contents cannot be recovered after deletion. Delete anyway? [y/N] `;
    const confirmed = await promptConfirm(question, stdinStream);
    if (!confirmed) {
      throw new SidekicksError('removal cancelled', EXIT_VALIDATION);
    }
  }

  // ── Step 4: Read submodule + active state (read-only) BEFORE deletion ─────
  // The submodule (when present) is registered in the PROJECT repo at the
  // services/<name>/src path — deregistration runs with cwd = projectDir.
  const submodRelPath = `services/${name}/src`;
  const isSubmodule = rootSubmoduleHas(projectDir, submodRelPath);
  const wasActive = settings.active_service === name;

  // ── Step 5: Guard, deregister submodule, delete the tree ──────────────────
  // Write-surface guard — services/<name>/ is on the allowed surface.
  assertWritable(serviceDir, repoRoot);

  // Deregister BEFORE the rmrf: `git submodule deinit` re-creates the (now-empty)
  // submodule directory, which the rmrf below then clears. Best-effort — never
  // throws, so a deregistration hiccup can't fail a removal in progress.
  if (isSubmodule) {
    submoduleDeregister(submodRelPath, projectDir);
  }

  try {
    rmrf(serviceDir);
  } catch (err) {
    throw new SidekicksError(
      `partial deletion failure for services/${name}/; run manually: rm -rf projects/${scope.projectName}/services/${name}/  (${err.message})`,
      EXIT_IO
    );
  }

  // ── Step 6: Drop the manifest entry (atomic, idempotent) ──────────────────
  assertWritable(manifestPath, repoRoot);
  removeService(manifestPath, `services/${name}`);

  // ── Step 7: Null active_service if the removed service was active ─
  if (wasActive) {
    setActiveService(repoRoot, null);
  }

  // ── Step 8: Rebuild project index (Epic 4, Story 4.2) ────────────────────
  // Tail-call after all mutations succeed. Only the owning project's index is
  // rebuilt; the root index is left untouched (service verbs are project-level).
  // Best-effort wrapping is added in Story 4.3 — errors propagate here.
  rebuildProjectIndex(repoRoot, scope.projectName);

  // ── Step 9: Submodule notice (NOT a prompt) ───────────────────────────────
  // The deregistration in Step 5 staged the removal; the user still must commit.
  if (isSubmodule) {
    process.stderr.write(
      `${name} was a submodule — deregistered from .gitmodules and staged its ` +
      `removal in projects/${scope.projectName}/. Run: git commit -m "Remove service ${name}"\n`
    );
  }

  return { stdout: '', exitCode: EXIT_OK };
}
