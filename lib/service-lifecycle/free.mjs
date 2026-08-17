// lib/service-lifecycle/free.mjs
// Implements `sidekicks service free [<service-name>] [--force]`.
//
// Reclaim disk by deleting a service's pulled src/ working tree while KEEPING the
// service registered (docs/, service.yaml, manifest entry, active scope) so it can be
// re-acquired later with `service pull`. The inverse of pull's acquisition; distinct
// from `service remove`, which deletes the whole service.
//
// Git-status safety — verified BEFORE any deletion: freeing pulled code is only safe
// when that code can be re-pulled from the remote without losing local work. free
// therefore refuses (without --force) whenever src/ holds work that is NOT recoverable:
//   • src/ is not a git working tree   → contents untracked, unrecoverable
//   • src/ has uncommitted changes     → staged/unstaged/untracked work would be lost
//   • src/ has unpushed local commits  → commits exist only locally
//   • the service records no remote    → nothing to re-pull from afterwards
// On a TTY the user is prompted; on non-TTY --force is required. A clean, pushed,
// re-pullable service frees without a prompt.
//
// Submodule-backed src/ is emptied via `git submodule deinit` (registration kept, no
// commit needed); a plain clone is removed via rmrf. Either way `service pull`
// re-populates it.
//
// Zero npm dependencies — node:*, relative lib/ imports only.
// All git spawns delegated to git-delegation/git.mjs; shell: false everywhere.

import { statSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import {
  SidekicksError,
  EXIT_OK,
  EXIT_VALIDATION,
  EXIT_GIT,
  EXIT_IO,
} from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { rmrf } from '../fs-safety/fsx.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { parse } from '../yaml-subset/yaml.mjs';
import {
  whichGit,
  isRepo,
  rootSubmoduleHas,
  hasUncommittedChanges,
  hasUnpushedCommits,
  submoduleDeinit,
} from '../git-delegation/git.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { rebuildProjectIndex } from '../scope-index/index.mjs';

/**
 * Prompt for confirmation on a TTY stdin. Resolves true only on 'y'/'Y'.
 * (Mirrors the prompt used by `service remove`.)
 */
async function promptConfirm(question, inputStream = process.stdin) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    const rl = createInterface({ input: inputStream, output: process.stderr, terminal: false });
    process.stderr.write(question);
    rl.once('line', (line) => {
      const answer = (line || '').trim();
      settle(answer === 'y' || answer === 'Y');
      rl.close();
    });
    rl.once('close', () => settle(false));
  });
}

/** Whether `dir` exists and contains no entries (an emptied/deinit'd working tree). */
function isEmptyDir(dir) {
  try { return readdirSync(dir).length === 0; } catch { return false; }
}

/**
 * Execute the `service free [<service-name>] [--force]` verb.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string|undefined, rest: string[], flags: object }} args
 *   - args.name → [<service-name>] (optional; defaults to the active service)
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  const optServiceName =
    args && args.name != null && String(args.name).trim() !== ''
      ? String(args.name).trim()
      : null;
  const force = Boolean(
    (args && args.flags && args.flags.force) || (ctx.flags && ctx.flags.force)
  );

  // ── Precondition 1: active project ≠ root ─────────────────────────────────
  const settings = readSettings(repoRoot);
  const scope = resolveEffectiveScope(settings);
  if (scope.projectName === 'sidekicks') {
    throw new SidekicksError(
      "service free requires an active user project; switch with 'project use <name>' first",
      EXIT_VALIDATION
    );
  }

  // ── Precondition 2: resolve target service name ────────────────────────────
  const target = optServiceName || settings.active_service || null;
  if (!target) {
    throw new SidekicksError(
      "service free requires an active service or a <service-name> argument; " +
        "activate one with 'service use <name>' or pass the name explicitly",
      EXIT_VALIDATION
    );
  }

  // ── Precondition 3: service directory must exist ───────────────────────────
  const projectDir = join(repoRoot, 'projects', scope.projectName);
  const serviceDir = join(projectDir, 'services', target);
  let sStat;
  try { sStat = statSync(serviceDir); } catch { sStat = null; }
  if (!sStat || !sStat.isDirectory()) {
    throw new SidekicksError(
      `service directory 'projects/${scope.projectName}/services/${target}/' does not exist`,
      EXIT_VALIDATION
    );
  }

  const srcDir = join(serviceDir, 'src');
  const relPath = join('services', target, 'src');
  const isSubmodule = rootSubmoduleHas(projectDir, relPath);

  // ── Idempotent no-ops: nothing pulled, or already freed ───────────────────
  // src/ absent → never pulled (or already freed via rmrf). A registered submodule
  // that's already been deinit'd leaves an empty src/ dir — also nothing to free.
  if (!existsSync(srcDir) || (isSubmodule && !isRepo(srcDir) && isEmptyDir(srcDir))) {
    return {
      stdout: `service '${target}' has no pulled src/ to free (run 'service pull ${target}' to acquire it).\n`,
      exitCode: EXIT_OK,
    };
  }

  // ── Precondition 4: git on PATH — required to verify status before deleting ─
  if (whichGit() === null) {
    throw new SidekicksError(
      "git is required for 'service free' (it verifies git status before reclaiming src/) — install git and ensure it is on PATH",
      EXIT_GIT
    );
  }

  // ── Read the recorded remote so we can tell whether re-pull is even possible ─
  const serviceYamlPath = join(serviceDir, 'service.yaml');
  let remoteSource = null;
  try {
    const obj = parse(readFileSync(serviceYamlPath, 'utf8'));
    remoteSource = obj && obj.remote_source ? String(obj.remote_source) : null;
  } catch { remoteSource = null; }

  // ── Verify git status — classify recoverability BEFORE touching the disk ───
  const guarded = isRepo(srcDir);            // populated git working tree
  const dirty = guarded && hasUncommittedChanges(srcDir);
  const unpushed = guarded && hasUnpushedCommits(srcDir);
  const noRemote = !remoteSource;

  // Risky = the deletion is not safely reversible by a later `service pull`.
  const risky = !guarded || dirty || unpushed || noRemote;

  if (risky && !force) {
    const reason =
      !guarded ? `services/${target}/src/ is not a git working tree — its contents cannot be recovered after deletion`
      : dirty ? `services/${target}/src/ has uncommitted changes that will be permanently lost`
      : unpushed ? `services/${target}/src/ has local commits that are not pushed to its remote — they will be permanently lost`
      : /* noRemote */ `service '${target}' records no remote_source — once freed, its src/ cannot be re-pulled`;

    const stdinStream = ctx._stdin || process.stdin;
    if (!stdinStream.isTTY) {
      throw new SidekicksError(
        `${reason}. Re-run with --force to free it anyway.`,
        EXIT_VALIDATION
      );
    }
    const confirmed = await promptConfirm(`${reason}. Free src/ anyway? [y/N] `, stdinStream);
    if (!confirmed) {
      throw new SidekicksError('free cancelled', EXIT_VALIDATION);
    }
  }

  // ── Reclaim src/ ──────────────────────────────────────────────────────────
  assertWritable(srcDir, repoRoot);

  if (isSubmodule) {
    // Submodule: deinit empties the working tree but keeps the registration so a
    // later `service pull` re-populates it offline (no re-add, no commit).
    submoduleDeinit(relPath, projectDir);
    // deinit removes tracked files but may leave the now-empty dir behind; clearing
    // it fully reclaims the slot (the registration lives in .gitmodules, not here).
    try { rmrf(srcDir); } catch { /* best-effort — empty dir */ }
  } else {
    // Plain clone (or untracked content): remove the whole src/ tree.
    try {
      rmrf(srcDir);
    } catch (err) {
      throw new SidekicksError(
        `failed to reclaim services/${target}/src/; run manually: rm -rf ${srcDir}  (${err.message})`,
        EXIT_IO
      );
    }
  }

  // ── Rebuild project index (Epic 4, Story 4.2) ────────────────────────────
  // Tail-call after src/ is deleted. `buildProjectIndex` now reads src/ as absent
  // and will set state: "registered" for the freed service (AC#3). Only the owning
  // project's index is rebuilt; the root index is left untouched (service verbs are
  // project-level). Best-effort wrapping is added in Story 4.3 — errors propagate here.
  rebuildProjectIndex(repoRoot, scope.projectName);

  const how = isSubmodule ? 'submodule deinit' : 'removed working tree';
  return {
    stdout: `Freed src/ for '${target}' (${how}). Re-acquire with 'service pull ${target}'.\n`,
    exitCode: EXIT_OK,
  };
}
