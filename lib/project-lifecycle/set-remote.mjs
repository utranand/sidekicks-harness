// lib/project-lifecycle/set-remote.mjs
// Implements `sidekicks project set-remote <git-url>`.
//
// Records remote_source ONLY once a real git binding exists. The prior
// behavior wrote remote_source offline with no commit/push/verify, producing
// "lying" manifests (a project claiming a remote it was never pushed to).
//
// Preconditions in strict order (all fail-fast before any side effect):
//   1. active ≠ root → EXIT_VALIDATION
//   2. projects/<active>/ exists as a directory → EXIT_VALIDATION
//   3. manifest.read(projects/<active>/manifest.yaml) succeeds (probe) → EXIT_VALIDATION
//   4. git.whichGit() !== null → EXIT_GIT
//
// Then:
//   5. git.init(projectDir) if !git.isRepo(projectDir)   (isRepo = toplevel check;
//        a plain project dir inside the root repo is init'd as its OWN repo, NOT
//        skipped — the walk-up bug that clobbered the root repo's origin)
//   6. git.setRemote(projectDir, 'origin', url)          (local; origin != binding)
//   7. REQUIRE >=1 commit (git.hasCommits) — else refuse + guide to commit
//   8. VERIFY binding: read-only git.lsRemote(url) must advertise the project's
//        HEAD — else refuse + guide to push
//   9. manifest.setRemoteSource(manifestPath, url)  — atomic, ONLY when bound
//  10. STAGE the project as a submodule of the ROOT repo (stage 4), symmetric
//        with `project add`'s behavior: `git submodule add <url> projects/<name>`
//        run in repoRoot. Because projects/<name>/ already exists as its OWN repo
//        whose HEAD was just verified on the remote, git ADDS the existing repo to
//        the root index WITHOUT cloning, staging .gitmodules + the gitlink. NO commit
//        (the CLI never commits/pushes the root repo). Best-effort: the
//        binding (step 9) is already durably recorded, so a registration failure
//        is surfaced as a note, never a rollback (deinit would wipe the user's
//        working tree). Skipped when root is not a git repo or it is already
//        registered (idempotent re-run).
//
// Post-condition (on success): manifest.remote_source === url === git origin, the
// remote demonstrably holds the project's HEAD, AND (when root is a git repo)
// projects/<name>/ is staged as a root submodule awaiting the user's commit.
// NO commit. NO push. The ONE network op is the read-only ls-remote.
// Idempotent: pre-push run guides (no manifest write); post-push run records +
// stages the submodule; a second post-push run is a no-op on the registration.
//
// Zero npm dependencies — node:fs, node:path only (plus relative lib/ imports).

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_GIT } from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { read as readManifest, setRemoteSource } from '../manifest-schema/manifest.mjs';
import {
  whichGit,
  isRepo,
  init,
  setRemote,
  hasCommits,
  headCommit,
  currentBranch,
  lsRemote,
  submoduleAdd,
  rootSubmoduleHas,
} from '../git-delegation/git.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { rebuildRootIndex } from '../scope-index/index.mjs';

/**
 * Execute the `project set-remote <git-url>` verb.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name: string, rest: string[], flags: object }} args
 *   - args.name is the first positional arg after the verb (the git URL).
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  // The URL is passed as args.name (first positional after `project set-remote`).
  const url = args && args.name != null ? String(args.name) : '';

  if (!url || url.trim() === '') {
    throw new SidekicksError(
      "usage: sidekicks project set-remote <git-url>",
      EXIT_VALIDATION
    );
  }

  // ── Precondition 1: active ≠ root ─────────────────────────────────────────
  const settings = readSettings(repoRoot);
  const scope = resolveEffectiveScope(settings);

  if (scope.projectName === 'sidekicks') {
    throw new SidekicksError(
      "project set-remote requires an active user project; switch with 'project use <name>' first",
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

  // ── Precondition 3: manifest readable (probe) ──────────────────────────────
  // readManifest throws EXIT_VALIDATION if absent or malformed.
  // This prevents the corrupt half-state where .git/ and origin are set but
  // remote_source was never recorded (per tech-spec Reliability section).
  const manifestPath = join(projectDir, 'manifest.yaml');
  readManifest(manifestPath); // throws on failure

  // ── Precondition 4: git on PATH ───────────────────────────────────────────
  if (whichGit() === null) {
    throw new SidekicksError(
      "git is required for 'project set-remote' — install git and ensure it is on PATH",
      EXIT_GIT
    );
  }

  // ── All preconditions pass — execute side effects ─────────────────────────

  // Step 5: Conditional git init. isRepo is the toplevel-equality check, so a
  // plain project dir INSIDE the root repo is correctly init'd as its OWN repo
  // (NOT skipped — the walk-up bug that clobbered the root repo's origin).
  if (!isRepo(projectDir)) {
    init(projectDir);
  }

  // Step 6: Set origin remote (add-then-fallback-to-set-url — idempotent, local).
  // Setting origin is harmless and enables the push guidance below; it does NOT
  // by itself record the binding (manifest.remote_source is written only once
  // the binding is verified).
  setRemote(projectDir, 'origin', url);

  // Step 7: Require project content (>=1 commit) — else refuse and guide.
  // Without a commit there is nothing to push and nothing a remote could hold,
  // so recording remote_source would produce a "lying" manifest.
  if (!hasCommits(projectDir)) {
    throw new SidekicksError(
      `projects/${scope.projectName}/ has no commits — commit its content first ` +
        `(git -C projects/${scope.projectName} add -A && ` +
        `git -C projects/${scope.projectName} commit -m "init"), then re-run set-remote`,
      EXIT_VALIDATION
    );
  }

  // Step 8: Verify the binding with a read-only ls-remote — else refuse and guide.
  // The remote must advertise the project's current HEAD (it has been pushed).
  const head = headCommit(projectDir);
  let branch;
  try { branch = currentBranch(projectDir); } catch { branch = 'main'; }

  let remoteRefs;
  try {
    remoteRefs = lsRemote(url); // read-only network (exception)
  } catch {
    // Unreachable / auth / nonexistent remote → not bound yet. Guide to push.
    remoteRefs = null;
  }
  const bound = Array.isArray(remoteRefs) && remoteRefs.some((r) => r.sha === head);
  if (!bound) {
    throw new SidekicksError(
      `remote ${url} isn't bound yet (it does not contain projects/${scope.projectName}'s HEAD) — ` +
        `push to establish the binding (git -C projects/${scope.projectName} push -u origin ${branch}). ` +
        `The remote MUST be empty (no README/license/initial commit) for this first push to ` +
        `succeed without forcing — force-pushing over existing history is exactly the data loss ` +
        `this verify-gate guards against. After a clean push, re-run set-remote`,
      EXIT_VALIDATION
    );
  }

  // Step 9: Binding verified — atomic manifest write (fs-guard first).
  assertWritable(manifestPath, repoRoot);
  setRemoteSource(manifestPath, url);

  // Step 10: Stage the project as a submodule of the ROOT repo (stage 4),
  // symmetric with `project add`: stage `.gitmodules` + the gitlink, NEVER
  // commit. projects/<name>/ already exists as its own repo whose HEAD
  // was just verified on the remote, so `git submodule add <url> projects/<name>`
  // ADDS the existing repo to the root index WITHOUT re-cloning. Best-effort: the
  // binding above is already durably recorded, so any failure here is reported as
  // a note rather than rolled back (a rollback via deinit would wipe the user's
  // working tree). Skipped when root is not its own git repo, or it is already
  // registered (idempotent re-run).
  const relPath = `projects/${scope.projectName}`;
  let stdout = `Bound projects/${scope.projectName} to ${url} (remote verified).\n`;

  if (!isRepo(repoRoot)) {
    stdout +=
      `note: the repository root is not a git working tree, so projects/${scope.projectName} ` +
      `was not registered as a submodule. Run 'git init' at the root, then re-run set-remote ` +
      `(or register manually: git submodule add ${url} ${relPath}).\n`;
  } else if (rootSubmoduleHas(repoRoot, relPath)) {
    stdout += `projects/${scope.projectName} is already registered as a root submodule.\n`;
  } else {
    try {
      submoduleAdd(url, relPath, repoRoot);
      stdout +=
        `Staged projects/${scope.projectName} as a submodule of the root repo (.gitmodules + gitlink).\n` +
        `Commit the registration: git add .gitmodules ${relPath} && ` +
        `git commit -m "Add project ${scope.projectName}"\n`;
    } catch (err) {
      const detail = err && err.message ? err.message : 'unknown error';
      stdout +=
        `note: could not auto-register projects/${scope.projectName} as a root submodule (${detail}). ` +
        `Register it manually: git submodule add ${url} ${relPath}\n`;
    }
  }

  // ── Rebuild root index (Epic 4, Story 4.1) ───────────────────────────────────
  // remote_source in the manifest changed — the root index carries a pointer to
  // each project's manifest, so the root index must reflect the updated URL.
  // Best-effort wrapping is added in Story 4.3 — errors propagate here.
  rebuildRootIndex(repoRoot);

  return { stdout, exitCode: EXIT_OK };
}
