// lib/project-lifecycle/remove.mjs
// Implements `sidekicks project remove <name> [--force]`.
//
// Sequence:
//   1. Validate (reject reserved/unknown) — BEFORE prompt
//   2. Assess git state (guarded? dirty?) — only to TAILOR the warning message
//   3. ALWAYS confirm before deleting any project: refuse non-TTY without --force,
//      prompt on TTY, skip ONLY with the explicit --force flag. Removal is
//      destructive, so the default path never deletes without an affirmative yes.
//   4. Read rootSubmoduleHas (read-only) — BEFORE rmrf
//   5. Read effective active scope — BEFORE rmrf
//   6. assertWritable + (if isRootSubmodule: submoduleDeregister) + fsx.rmrf(projects/<name>/)
//   7. If removed name was active: setActiveProject(repoRoot, "sidekicks") — nulls active_service
//   8. If isRootSubmodule: emit informational notice to stderr (NOT a prompt)
//
// Zero npm dependencies — node:*, relative lib/ imports only.

import { statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_IO } from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { rmrf } from '../fs-safety/fsx.mjs';
import { read as readSettings, setActiveProject } from '../settings-store/settings.mjs';
import {
  rootSubmoduleHas,
  submoduleDeregister,
  isRepo,
  hasUncommittedChanges,
} from '../git-delegation/git.mjs';
import { rebuildRootIndex } from '../scope-index/index.mjs';
import { isSymlink } from './external-links.mjs';
import { run as unlinkExternal } from './unlink.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Prompt for confirmation on a TTY stdin.
 * Returns true only if the user types 'y' or 'Y'.
 *
 * @param {string} question - The prompt text to display (written to stderr).
 * @returns {Promise<boolean>}
 */
/**
 * Prompt for confirmation on a TTY stdin.
 * Returns true only if the user types 'y' or 'Y'.
 *
 * @param {string} question  - The prompt text (written to stderr).
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
      // Settle BEFORE rl.close() — rl.close() fires 'close' synchronously,
      // which would otherwise call settle(false) before we can settle(true).
      const answer = (line || '').trim();
      settle(answer === 'y' || answer === 'Y');
      rl.close();
    });

    rl.once('close', () => {
      // stdin closed without a line (EOF) — treat as 'no'.
      settle(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute the `project remove <name> [--force]` verb.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string, flags: object }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on all failure paths.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = args && args.name != null ? String(args.name) : '';
  const force = Boolean((args && args.flags && args.flags.force) || (ctx.flags && ctx.flags.force));

  // ── Step 1: Validation (BEFORE prompt or any FS/git operations) ───────────

  if (!name) {
    throw new SidekicksError(
      'usage: sidekicks project remove <name> [--force]',
      EXIT_VALIDATION
    );
  }

  // Reject reserved root project name.
  if (name === 'sidekicks') {
    throw new SidekicksError(
      "cannot remove the reserved root project 'sidekicks'",
      EXIT_VALIDATION
    );
  }

  const projectDir = join(repoRoot, 'projects', name);

  // External-project links (created by `project link`) are removed NON-destructively:
  // delete only the symlink and its .gitignore entry, never the out-of-tree target.
  // Detect the symlink up front — before any prompt or rmrf — and delegate to the
  // dedicated unlink path so remove's tree-deletion semantics can never reach a linked
  // external directory. This also handles a broken link (statSync below would ENOENT).
  if (isSymlink(projectDir)) {
    return unlinkExternal(ctx, { name });
  }

  // Reject unknown project names (directory must exist).
  let stat;
  try { stat = statSync(projectDir); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) {
    throw new SidekicksError(
      `project '${name}' does not exist (projects/${name}/ not found)`,
      EXIT_VALIDATION
    );
  }

  // ── Step 2: Assess git state (to TAILOR the confirmation message only) ────
  // A project is "git-guarded" when projects/<name>/ is its OWN git repo (its own
  // working tree, including a root submodule) — its committed history is recoverable
  // from git. We inspect this NOT to decide whether to confirm (we always do), but
  // only to phrase the warning accurately:
  //   • not git-guarded       → no git backing; deletion is unrecoverable
  //   • git-guarded but dirty → staged/unstaged/untracked work would be lost
  //   • git-guarded + clean   → committed history is recoverable, but still confirm
  const guarded = isRepo(projectDir);
  const dirty = guarded && hasUncommittedChanges(projectDir);

  // ── Step 3: Confirmation — ALWAYS required unless --force is passed ───────
  // Removing a project permanently deletes its tree, so the default path never
  // deletes without an explicit yes. --force is the documented non-interactive
  // escape hatch (scripts/CI) and is the ONLY way to skip the prompt.
  // ctx._stdin allows unit tests to inject a TTY-flagged Readable instead of process.stdin.
  const stdinStream = ctx._stdin || process.stdin;

  if (!force) {
    if (!stdinStream.isTTY) {
      throw new SidekicksError(
        `removing project '${name}' is destructive and requires confirmation; ` +
        're-run in an interactive terminal to confirm, or pass --force to confirm non-interactively',
        EXIT_VALIDATION
      );
    }

    const question = dirty
      ? `projects/${name}/ has uncommitted changes that will be permanently lost. Delete anyway? [y/N] `
      : guarded
        ? `projects/${name}/ will be permanently deleted (committed history is recoverable from git). Delete? [y/N] `
        : `projects/${name}/ is not tracked by git — its contents cannot be recovered after deletion. Delete anyway? [y/N] `;

    const confirmed = await promptConfirm(question, stdinStream);
    if (!confirmed) {
      throw new SidekicksError('removal cancelled', EXIT_VALIDATION);
    }
  }

  // ── Step 4: Read submodule status (read-only) BEFORE deletion ─────────────
  // rootSubmoduleHas returns false if .gitmodules absent or git not on PATH.
  const isRootSubmodule = rootSubmoduleHas(repoRoot, `projects/${name}`);

  // ── Step 5: Check if removed project is the active one BEFORE deletion ───
  const settings = readSettings(repoRoot);
  const wasActive = settings.active_project === name;

  // ── Step 6: Guard, deregister submodule, execute deletion ─────────────────
  // write-surface guard — projects/<name>/ is on the allowed surface;
  // this call is a mechanical invariant that confirms compliance.
  assertWritable(projectDir, repoRoot);

  // If the project is a root submodule, deregister it BEFORE the rmrf. Leaving the
  // project dir alone would strand a dangling registration (.gitmodules section +
  // gitlink in the index); deregistration removes both (staged, not committed).
  // It must run first because `git submodule deinit` re-creates the
  // (now-empty) project directory, which the rmrf below then clears. Best-effort:
  // never throws, so a deregistration hiccup can't fail the removal.
  if (isRootSubmodule) {
    submoduleDeregister(`projects/${name}`, repoRoot);
  }

  try {
    rmrf(projectDir);
  } catch (err) {
    throw new SidekicksError(
      `partial deletion failure for projects/${name}/; run manually: rm -rf projects/${name}/  (${err.message})`,
      EXIT_IO
    );
  }

  // ── Step 7: Post-deletion settings update (only if wasActive) ─────────────
  if (wasActive) {
    // setActiveProject also nulls active_service.
    setActiveProject(repoRoot, 'sidekicks');
  }

  // ── Step 8: Post-deletion submodule notice (only if isRootSubmodule) ──────
  // NOT a prompt — unconditional stderr output. The deregistration in
  // Step 6 staged the removal; the user still needs to commit it.
  if (isRootSubmodule) {
    process.stderr.write(
      `${name} was a root submodule — deregistered from .gitmodules and staged its ` +
      `removal. Run: git commit -m "Remove project ${name}"\n`
    );
  }

  // ── Step 9: Rebuild root index only (Epic 4, Story 4.1 / 4.3) ──────────────
  // The removed project's index departs with projects/<name>/ — only the root
  // index is rebuilt so it no longer references the departed project. We do NOT
  // call rebuildProjectIndex: the directory no longer exists. Best-effort wrapping
  // (try/catch + warn) lives inside rebuildRootIndex (Story 4.3).
  rebuildRootIndex(repoRoot);

  return { stdout: '', exitCode: EXIT_OK };
}
