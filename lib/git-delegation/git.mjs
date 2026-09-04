// lib/git-delegation/git.mjs
// The ONLY surface in the CLI that spawns `git`.
// Every call uses spawnSync('git', [...args], { shell: false, cwd }) — no shell interpolation.
// Throws SidekicksError(EXIT_GIT) on git failure; never string-interpolates URLs into args.
// Zero npm dependencies — node:child_process, node:fs, node:path only.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SidekicksError, EXIT_GIT } from '../sk-cli/errors.mjs';

// ---------------------------------------------------------------------------
// Overridable spawnSync reference — allows test stubs without patching globals.
// Tests can replace _spawnSync via setSpawnSync() to intercept git calls.
// ESM module namespace objects are sealed (assignment throws), so mutation
// goes through the setter rather than direct property assignment.
// ---------------------------------------------------------------------------
export let _spawnSync = spawnSync;

/**
 * Replace the internal spawnSync implementation used by all git functions.
 * Returns a restore function that reinstates the previous implementation.
 *
 * Intended for tests only — call in before()/after() hooks.
 *
 * @param {Function} impl - Replacement spawnSync(cmd, args, opts) implementation.
 * @returns {() => void} restoreFn — call to restore the previous implementation.
 */
export function setSpawnSync(impl) {
  const prev = _spawnSync;
  _spawnSync = impl;
  return () => { _spawnSync = prev; };
}

// ---------------------------------------------------------------------------
// Path normalization — git always speaks POSIX.
// ---------------------------------------------------------------------------
/**
 * Normalize a relative path to forward-slash (POSIX) form for use as a git
 * pathspec, submodule path, or `.gitmodules` section name. Callers build these
 * with `path.join`, which on Windows produces backslashes (e.g.
 * `services\mobile-compass\src`) — but git rejects backslash pathspecs and stores
 * submodule sections with forward slashes on every OS. Node's own `join`/`rmSync`
 * also accept forward slashes on Windows, so normalizing here is safe for the
 * `.git/modules/<relPath>` filesystem paths these helpers build too.
 *
 * @param {string} relPath
 * @returns {string}
 */
function toGitPath(relPath) {
  return String(relPath).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Internal helper — run git and surface errors as SidekicksError(EXIT_GIT).
// ---------------------------------------------------------------------------
function runGit(args, cwd, { allowNonZero = false } = {}) {
  const result = _spawnSync('git', args, {
    shell: false,
    cwd,
    encoding: 'utf8',
  });

  if (result.error) {
    // spawnSync error — git binary not found or process spawn failed.
    throw new SidekicksError(
      `git: failed to spawn 'git': ${result.error.message}`,
      EXIT_GIT
    );
  }

  if (!allowNonZero && result.status !== 0) {
    // Git exited non-zero — surface first line of stderr as the error message.
    const stderrSummary = (result.stderr || '').split('\n')[0].trim();
    throw new SidekicksError(
      `git ${args[0]} failed: ${stderrSummary || '(no output)'}`,
      EXIT_GIT
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Locate the system `git` binary.
 * Returns the path string from `which git` (or `where git` on Windows) on success,
 * or null if git is not on PATH.
 *
 * @returns {string | null}
 */
export function whichGit() {
  const isWindows = process.platform === 'win32';
  const result = _spawnSync(isWindows ? 'where' : 'which', ['git'], {
    shell: false,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '').split('\n')[0].trim() || null;
}

/**
 * Initialize a git repository at `cwd` (git init).
 * No-op if already a git repository (git init is idempotent).
 *
 * @param {string} cwd - Absolute path to the directory to initialize.
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function init(cwd) {
  runGit(['init'], cwd);
}

/**
 * Set a remote on the git repository at `cwd`.
 * Tries `git remote add <name> <url>` first; if origin exists, falls back to
 * `git remote set-url <name> <url>` — idempotent on re-run.
 *
 * @param {string} cwd  - Absolute path to the repository.
 * @param {string} name - Remote name (e.g., "origin").
 * @param {string} url  - Remote URL.
 * @throws {SidekicksError(EXIT_GIT)} on persistent failure.
 */
export function setRemote(cwd, name, url) {
  const addResult = _spawnSync('git', ['remote', 'add', name, url], {
    shell: false,
    cwd,
    encoding: 'utf8',
  });

  if (addResult.error) {
    throw new SidekicksError(
      `git: failed to spawn 'git': ${addResult.error.message}`,
      EXIT_GIT
    );
  }

  if (addResult.status === 0) return; // success

  // Non-zero — likely "remote already exists"; try set-url instead.
  runGit(['remote', 'set-url', name, url], cwd);
}

/**
 * Clone `url` into `destPath`, optionally pinning a branch.
 *
 * When `branch` is supplied, `--branch <branch>` is passed so the working tree
 * checks out that ref directly. If the ref does not exist on the remote, git
 * exits non-zero and the error surfaces as EXIT_GIT — the caller can then advise
 * passing an explicit branch.
 *
 * @param {string} url      - Git URL to clone from.
 * @param {string} destPath - Absolute destination path.
 * @param {string} [branch] - Optional branch to check out (`--branch`).
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function clone(url, destPath, branch) {
  const args = branch
    ? ['clone', '--branch', branch, url, destPath]
    : ['clone', url, destPath];
  runGit(args, process.cwd());
}

/**
 * Stage every change in the working tree at `cwd` (`git add -A`).
 *
 * @param {string} cwd - Absolute path to the repository working tree.
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function addAll(cwd) {
  runGit(['add', '-A'], cwd);
}

/**
 * Stage ONLY the named paths at `cwd` (`git add -- <path>...`).
 *
 * Unlike addAll, this leaves every other modification in the working tree
 * untouched — the journal writes one entry plus its index row into a store repo
 * a human may also be editing, and sweeping their work into an agent's commit
 * would be a silent theft of their changes.
 *
 * @param {string} cwd - Absolute path to the repository working tree.
 * @param {string[]} relPaths - Repo-relative paths to stage (POSIX-normalized here).
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function addPaths(cwd, relPaths) {
  const paths = (Array.isArray(relPaths) ? relPaths : [])
    .filter(Boolean)
    .map(toGitPath);
  if (paths.length === 0) return;
  runGit(['add', '--', ...paths], cwd);
}

/**
 * Move a tracked path, staging the rename.
 *
 * `git mv` rather than a bare rename so the move lands in the index as a RENAME and the history of
 * every file inside it stays followable — which is the entire value of offloading a skill instead
 * of deleting and re-adding it.
 *
 * Falls back to a plain filesystem rename when git refuses: an untracked folder, a repo with no
 * commits, or no git at all are all normal states for a fresh checkout, and none of them is a
 * reason to refuse the move. Returns which path was taken so the caller can say so.
 *
 * @param {string} cwd - repository working tree
 * @param {string} fromRel - source path, repo-relative
 * @param {string} toRel - destination path, repo-relative
 * @returns {{staged: boolean}} staged=true when git performed the move
 */
export function mv(cwd, fromRel, toRel) {
  const dest = join(cwd, ...toRel.split('/'));
  // Neither `git mv` nor renameSync creates the destination's parent, and the first offload into a
  // repo is exactly the case where it does not exist yet.
  mkdirSync(dirname(dest), { recursive: true });
  const r = _spawnSync('git', ['mv', '--', toGitPath(fromRel), toGitPath(toRel)], {
    shell: false, cwd, encoding: 'utf8',
  });
  if (r && r.status === 0) return { staged: true };
  renameSync(join(cwd, ...fromRel.split('/')), dest);
  return { staged: false };
}

/**
 * Return whether the index at `cwd` holds anything to commit
 * (`git diff --cached --quiet` exits 1 when staged changes exist).
 *
 * Returns a boolean — does NOT throw. `commit` fails loudly on an empty index,
 * so best-effort writers check this first rather than swallowing the error.
 *
 * @param {string} cwd - Absolute path to the repository working tree.
 * @returns {boolean}
 */
export function hasStagedChanges(cwd) {
  const r = _spawnSync('git', ['diff', '--cached', '--quiet'], {
    shell: false, cwd, encoding: 'utf8',
  });
  if (r.error) return false;
  return r.status === 1;
}

/**
 * Return whether a committer identity (user.name AND user.email) is configured
 * and resolvable from `cwd` (reads local → global → system git config).
 *
 * Returns a boolean — does NOT throw. Used to decide whether a fallback identity
 * must be injected at commit time so the seed-an-empty-remote path works even on
 * a machine with no global git identity (e.g. CI).
 *
 * @param {string} cwd - Absolute path to the repository working tree.
 * @returns {boolean}
 */
export function hasIdentity(cwd) {
  const probe = (key) => {
    const r = _spawnSync('git', ['config', key], { shell: false, cwd, encoding: 'utf8' });
    return !r.error && r.status === 0 && (r.stdout || '').trim() !== '';
  };
  return probe('user.name') && probe('user.email');
}

/**
 * Create a commit from the current index at `cwd` (`git commit -m <message>`).
 *
 * When `opts.identity` is provided, the name/email are injected via per-command
 * `-c user.name=… -c user.email=…` flags (NOT written to any config file) so a
 * commit succeeds on a host with no configured git identity without mutating the
 * user's global config.
 *
 * @param {string} cwd     - Absolute path to the repository working tree.
 * @param {string} message - Commit message.
 * @param {{ identity?: { name: string, email: string } }} [opts]
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function commit(cwd, message, opts = {}) {
  const args = [];
  if (opts.identity) {
    args.push('-c', `user.name=${opts.identity.name}`, '-c', `user.email=${opts.identity.email}`);
  }
  args.push('commit', '-m', message);
  runGit(args, cwd);
}

/**
 * Force-rename the current branch at `cwd` to `name` (`git branch -M <name>`).
 * Normalizes the seeded project's initial branch (which may be `master` or `main`
 * depending on the host's `init.defaultBranch`) to a deterministic name.
 *
 * @param {string} cwd  - Absolute path to the repository working tree.
 * @param {string} name - Target branch name.
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function renameBranch(cwd, name) {
  runGit(['branch', '-M', name], cwd);
}

/**
 * Check out `branch` in the working tree at `cwd`.
 *
 * When `opts.create` is true, the branch is created and switched to in one step
 * (`git checkout -b <branch>`) — fails if the branch already exists. When false,
 * switches to an existing branch (`git checkout <branch>`) — fails if it does not
 * exist. In both cases git's own refusal (e.g. uncommitted changes that would be
 * overwritten, invalid branch name) surfaces as SidekicksError(EXIT_GIT).
 *
 * `branch` is passed as a positional arg, shell:false — no interpolation.
 *
 * @param {string} cwd    - Absolute path to the repository working tree.
 * @param {string} branch - Branch name to switch to (or create).
 * @param {{ create?: boolean }} [opts]
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function checkout(cwd, branch, opts = {}) {
  const args = ['checkout'];
  if (opts.create) args.push('-b');
  args.push(branch);
  runGit(args, cwd);
}

/**
 * Create a new branch named `name` at `cwd` WITHOUT switching to it
 * (`git branch <name>`). The working tree stays on the current branch — use
 * `checkout(cwd, name)` afterwards, or `checkout(cwd, name, { create: true })`,
 * to create-and-switch in one step. Fails if the branch already exists or the
 * name is invalid (surfaces as EXIT_GIT).
 *
 * `name` is passed as a positional arg, shell:false — no interpolation.
 *
 * @param {string} cwd  - Absolute path to the repository working tree.
 * @param {string} name - Branch name to create.
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function createBranch(cwd, name) {
  runGit(['branch', name], cwd);
}

/**
 * Delete the branch named `name` at `cwd`.
 *
 * With `opts.force` false (default) uses the safe `git branch -d`, which refuses
 * to delete a branch whose commits are not merged into its upstream/HEAD. With
 * `opts.force` true uses `git branch -D` (force delete, even if unmerged). In
 * both cases git refuses to delete the currently checked-out branch — that
 * refusal surfaces as EXIT_GIT.
 *
 * `name` is passed as a positional arg, shell:false — no interpolation.
 *
 * @param {string} cwd  - Absolute path to the repository working tree.
 * @param {string} name - Branch name to delete.
 * @param {{ force?: boolean }} [opts]
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function deleteBranch(cwd, name, opts = {}) {
  runGit(['branch', opts.force ? '-D' : '-d', name], cwd);
}

/**
 * List the local branch names in the repository at `cwd`.
 *
 * Uses `git for-each-ref refs/heads/` rather than parsing `git branch` output, so
 * the result is clean branch names with no `* ` current-marker prefix and no
 * `(HEAD detached …)` pseudo-entry. Pair with `currentBranch(cwd)` to determine
 * which (if any) is checked out.
 *
 * @param {string} cwd - Absolute path to the repository working tree.
 * @returns {string[]} - Local branch names (empty array if the repo has no branches yet).
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function listBranches(cwd) {
  const result = runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], cwd);
  return (result.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Push `branch` from `cwd` to `remote`, setting upstream (`git push -u <remote> <branch>`).
 * This is a sanctioned WRITE network operation used only by the
 * seed-an-empty-remote path of `project add`.
 *
 * @param {string} cwd    - Absolute path to the repository working tree.
 * @param {string} remote - Remote name (e.g. "origin").
 * @param {string} branch - Branch to push.
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function push(cwd, remote, branch) {
  runGit(['push', '-u', remote, branch], cwd);
}

/**
 * Run `git submodule add <url> <relPath>` within `cwd` (stages .gitmodules + gitlink;
 * does NOT commit).
 *
 * Passes `-c protocol.file.allow=always` to handle post-CVE-2022-39253 hardened git
 * defaults that block file:// submodule transports.
 * For non-file:// URLs this flag is a no-op.
 *
 * @param {string} url     - Git URL.
 * @param {string} relPath - Relative path for the submodule within `cwd`.
 * @param {string} cwd     - Absolute path to the parent repository root.
 * @param {string} [branch] - Optional branch to track (`-b <branch>`).
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function submoduleAdd(url, relPath, cwd, branch) {
  relPath = toGitPath(relPath);
  const sub = branch
    ? ['submodule', 'add', '-b', branch, url, relPath]
    : ['submodule', 'add', url, relPath];
  runGit(['-c', 'protocol.file.allow=always', ...sub], cwd);
}

/**
 * Read `submodule.<relPath>.branch` from a repository's committed `.gitmodules`.
 *
 * This is where a submodule's TRACKING INTENT belongs, and git has had the field all along. It is
 * committed, so it travels with the workspace to another clone — unlike repository-local config, and
 * unlike anything under a git-ignored state directory. Read-only and non-throwing: an unset key, a
 * missing file, or a repository with no submodules are all "no recorded branch", not failures.
 *
 * @param {string} repoRoot - Absolute path to the parent repository root.
 * @param {string} relPath  - Submodule path as recorded in .gitmodules.
 * @returns {string | null}
 */
export function submoduleBranch(repoRoot, relPath) {
  const result = _spawnSync('git',
    ['config', '-f', '.gitmodules', '--get', `submodule.${toGitPath(relPath)}.branch`],
    { shell: false, cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const value = (result.stdout || '').trim();
  return value || null;
}

/**
 * The same key, read from the INDEX copy of `.gitmodules` rather than the worktree copy.
 *
 * These two answers came apart and nobody could see it (INC-2026-09-04-02, N-2). `git submodule add`
 * stages `.gitmodules` with `path` and `url`; the branch key is written afterwards with
 * `git config -f`, which edits the file on disk and never touches the index. So `git commit` with no
 * `-a` records a pin whose tracked ref is missing from the committed file, and a fresh clone reads
 * no branch key at all — which is precisely the fallback-to-main this field exists to prevent.
 *
 * `git show :.gitmodules` reads stage 0 of the index. Parsing is deliberately minimal and matches
 * git's own config grammar loosely: section headers are case-insensitive on the section name but the
 * submodule NAME is case-sensitive, and `git config` writes one `key = value` per line.
 *
 * Read-only and non-throwing, like `submoduleBranch`: a repository with no index entry for
 * `.gitmodules`, no such section, or no such key all read as "nothing recorded in the index".
 *
 * @param {string} repoRoot - Absolute path to the parent repository root.
 * @param {string} relPath  - Submodule path as recorded in .gitmodules.
 * @returns {string | null}
 */
export function submoduleBranchInIndex(repoRoot, relPath) {
  const result = _spawnSync('git', ['show', ':.gitmodules'],
    { shell: false, cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const want = toGitPath(relPath);
  let inSection = false;
  for (const raw of (result.stdout || '').split('\n')) {
    const line = raw.trim();
    const header = /^\[submodule\s+"(.*)"\]$/i.exec(line);
    if (header) { inSection = header[1] === want; continue; }
    if (line.startsWith('[')) { inSection = false; continue; }
    if (!inSection) continue;
    const kv = /^branch\s*=\s*(.*)$/i.exec(line);
    if (kv) {
      const value = kv[1].trim();
      return value || null;
    }
  }
  return null;
}

/**
 * Record `submodule.<relPath>.branch` in a repository's `.gitmodules`.
 *
 * Writes the file but does NOT stage or commit it — same contract as every other write in this
 * layer: the CLI never commits the workspace's history.
 *
 * @param {string} repoRoot - Absolute path to the parent repository root.
 * @param {string} relPath  - Submodule path as recorded in .gitmodules.
 * @param {string} branch   - The ref to record (a tag or SHA is legal here too; git only reads this
 *                            field for `submodule update --remote`, which this repo never runs).
 * @returns {boolean} whether the write succeeded
 */
export function setSubmoduleBranch(repoRoot, relPath, branch) {
  const result = _spawnSync('git',
    ['config', '-f', '.gitmodules', `submodule.${toGitPath(relPath)}.branch`, branch],
    { shell: false, cwd: repoRoot, encoding: 'utf8' });
  return !result.error && result.status === 0;
}

/**
 * Best-effort submodule abort sequence:
 *   1. git submodule deinit -f <relPath>
 *   2. git rm --cached <relPath>
 *   3. git config -f .gitmodules --remove-section submodule.<relPath>
 *   4. if removing the last section left .gitmodules empty, delete the file
 *   5. remove the orphaned git dir at .git/modules/<relPath> (left behind by a
 *      failed `git submodule add` — deinit/rm do NOT delete it, and its presence
 *      makes a later `submodule add` of the same path fail)
 *
 * Each step is run independently; failures are swallowed (best-effort).
 * After all steps, the index should be clean, no stray empty .gitmodules is left
 * behind (only when this was the only submodule), and no orphaned module dir
 * remains.
 *
 * @param {string} relPath - Relative submodule path (e.g., "services/my-api/src").
 * @param {string} cwd     - Parent repository root.
 */
export function submoduleAbort(relPath, cwd) {
  relPath = toGitPath(relPath);
  // Step 1: deinit
  _spawnSync('git', ['submodule', 'deinit', '-f', relPath], {
    shell: false, cwd, encoding: 'utf8',
  });
  // Step 2: rm --cached
  _spawnSync('git', ['rm', '--cached', relPath], {
    shell: false, cwd, encoding: 'utf8',
  });
  // Step 3: remove .gitmodules section
  _spawnSync('git', ['config', '-f', '.gitmodules', '--remove-section', `submodule.${relPath}`], {
    shell: false, cwd, encoding: 'utf8',
  });
  // Step 4: if that removed the last section, .gitmodules is now empty (or
  // whitespace-only) — a meaningless artifact. Unstage it (in case the failed
  // `submodule add` staged it) and delete it from the working tree so the abort
  // leaves no trace. A .gitmodules with other submodules retains content and is
  // left untouched. Best-effort: swallow any error.
  const gitmodulesPath = join(cwd, '.gitmodules');
  if (existsSync(gitmodulesPath)) {
    let content = '';
    try { content = readFileSync(gitmodulesPath, 'utf8'); } catch { /* best-effort */ }
    if (content.trim() === '') {
      // -f for the same reason as submoduleDeregister: a prior staged-add of
      // .gitmodules in this session leaves an index blob that differs from both
      // HEAD and the empty working file, which `git rm --cached` refuses without
      // -f. Safe to force: an empty .gitmodules has no remaining submodule.
      _spawnSync('git', ['rm', '--cached', '-f', '--ignore-unmatch', '.gitmodules'], {
        shell: false, cwd, encoding: 'utf8',
      });
      try { unlinkSync(gitmodulesPath); } catch { /* best-effort */ }
    }
  }
  // Step 5: remove the orphaned git dir under .git/modules/<relPath>. A failed
  // `git submodule add` clones into here BEFORE wiring the index; deinit/rm leave
  // it behind, and it would block a later add of the same path. Best-effort.
  try {
    rmSync(join(cwd, '.git', 'modules', relPath), { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/**
 * Deregister an intentionally-removed root submodule.
 *
 * Unlike submoduleAbort (which unwinds a *failed* add), this is for removing a
 * fully-committed submodule when its project is deleted. The project's working
 * tree has typically already been deleted by the caller (rmrf), so every step is
 * index/metadata-only and must NOT depend on the working tree still existing
 * (`--cached`, not a working-tree `git rm`).
 *
 * Sequence (mirrors the canonical `git submodule` removal, minus the commit —
 * staging-only; the user commits):
 *   1. git submodule deinit -f <relPath>          (clears the .git/config entry)
 *   2. rm -rf .git/modules/<relPath>              (removes the submodule's git dir)
 *   3. git rm --cached -r <relPath>               (removes the gitlink from the index)
 *   4. git config -f .gitmodules --remove-section submodule.<relPath>
 *   5. stage the .gitmodules change so the user's commit captures it:
 *        - if it is now empty → unstage + delete it (no stray empty file)
 *        - otherwise          → git add .gitmodules (stage the section removal)
 *
 * Each step is best-effort; failures are swallowed (deregistration must
 * never block or fail the project removal that already succeeded). Returns nothing.
 *
 * @param {string} relPath - Relative submodule path (e.g., "projects/alpha").
 * @param {string} cwd     - Root repository path.
 */
export function submoduleDeregister(relPath, cwd) {
  relPath = toGitPath(relPath);
  const run = (args) => _spawnSync('git', args, { shell: false, cwd, encoding: 'utf8' });

  // Step 1: deinit (clears submodule.<name> from .git/config; tolerant of a
  // missing working tree since the caller already deleted projects/<name>/).
  run(['submodule', 'deinit', '-f', relPath]);
  // Step 2: remove the submodule's own git dir under .git/modules/<relPath>.
  try {
    rmSync(join(cwd, '.git', 'modules', relPath), { recursive: true, force: true });
  } catch { /* best-effort */ }
  // Step 3: remove the gitlink from the index (--cached: index-only).
  run(['rm', '--cached', '-r', relPath]);
  // Step 4: remove the [submodule "<relPath>"] section from .gitmodules.
  run(['config', '-f', '.gitmodules', '--remove-section', `submodule.${relPath}`]);
  // Step 5: stage the .gitmodules change. If this was the last submodule the file
  // is now empty — unstage and delete it. Otherwise stage the section removal so
  // the user's commit includes it (`git config --remove-section` edits the working
  // file but does not stage it).
  const gitmodulesPath = join(cwd, '.gitmodules');
  if (existsSync(gitmodulesPath)) {
    let content = '';
    try { content = readFileSync(gitmodulesPath, 'utf8'); } catch { /* best-effort */ }
    if (content.trim() === '') {
      // -f: when an earlier deregistration in the same (uncommitted) session left
      // .gitmodules staged-as-added, its index blob differs from both HEAD (absent)
      // and the now-empty working file — without -f, `git rm --cached` refuses with
      // "staged content different from both the file and the HEAD" and the swallowed
      // failure would strand a stale section in the index. Safe to force: an empty
      // .gitmodules has no remaining submodule to lose.
      run(['rm', '--cached', '-f', '--ignore-unmatch', '.gitmodules']);
      try { unlinkSync(gitmodulesPath); } catch { /* best-effort */ }
    } else {
      run(['add', '.gitmodules']);
    }
  }
}

/**
 * Empty a registered submodule's working tree to reclaim disk, KEEPING its
 * registration intact (`git submodule deinit -f <relPath>`). Unlike
 * submoduleDeregister, this leaves `.gitmodules`, the gitlink, and
 * `.git/modules/<relPath>` in place, so the submodule can be re-populated later with
 * a network-free `submoduleUpdateInit` (no re-add, no commit). This is the disk-
 * reclaim primitive behind `service free` for submodule-backed services.
 *
 * @param {string} relPath - Relative submodule path (e.g., "services/my-api/src").
 * @param {string} cwd     - Parent (project) repository root.
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function submoduleDeinit(relPath, cwd) {
  runGit(['submodule', 'deinit', '-f', toGitPath(relPath)], cwd);
}

/**
 * Re-populate a registered-but-deinit'd submodule's working tree from its recorded
 * URL (`git submodule update --init <relPath>`). The inverse of submoduleDeinit:
 * fetches the pinned commit back into `relPath` using the existing `.gitmodules`
 * registration. Passes `-c protocol.file.allow=always` like submoduleAdd so file://
 * submodule transports work under post-CVE-2022-39253 hardened git.
 *
 * @param {string} relPath - Relative submodule path (e.g., "services/my-api/src").
 * @param {string} cwd     - Parent (project) repository root.
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function submoduleUpdateInit(relPath, cwd) {
  runGit(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', toGitPath(relPath)], cwd);
}

/**
 * Return the current branch name in the repository at `repoPath`.
 * In detached-HEAD state, returns the literal string "HEAD".
 *
 * @param {string} repoPath - Absolute path to the git repository working tree.
 * @returns {string}
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function currentBranch(repoPath) {
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  return (result.stdout || '').trim();
}

/**
 * Return the HEAD commit SHA (full 40-hex) in the repository at `repoPath`.
 *
 * @param {string} repoPath - Absolute path to the git repository working tree.
 * @returns {string}
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function headCommit(repoPath) {
  const result = runGit(['rev-parse', 'HEAD'], repoPath);
  return (result.stdout || '').trim();
}

/**
 * Return whether the repository at `repoPath` has at least one commit
 * (i.e., `HEAD` resolves to a commit). Returns a boolean — does NOT throw;
 * a fresh `git init`'d repo with no commits returns false.
 *
 * @param {string} repoPath - Absolute path to the git working tree.
 * @returns {boolean}
 */
export function hasCommits(repoPath) {
  const result = _spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
    shell: false,
    cwd: repoPath,
    encoding: 'utf8',
  });
  return !result.error && result.status === 0;
}

/**
 * Return whether the git working tree at `repoPath` has uncommitted changes —
 * staged, unstaged, OR untracked files (i.e. `git status --porcelain` is non-empty).
 * Untracked files count because they are not in git history and would be lost on
 * deletion.
 *
 * Returns a boolean — does NOT throw. If git is absent or the command fails,
 * returns false. Call this ONLY when `repoPath` is its own repo (see isRepo): run
 * from inside a plain subdir, `git status` walks up and reports the PARENT repo.
 *
 * @param {string} repoPath - Absolute path to the git working tree.
 * @returns {boolean}
 */
export function hasUncommittedChanges(repoPath) {
  const result = _spawnSync('git', ['status', '--porcelain'], {
    shell: false,
    cwd: repoPath,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return false;
  return (result.stdout || '').trim() !== '';
}

/**
 * Return whether the working tree at `repoPath` has uncommitted changes to TRACKED files —
 * staged or unstaged, untracked files and submodule state excluded.
 *
 * This is the narrower sibling of hasUncommittedChanges, and it answers a different question:
 * "would moving HEAD here disturb work that is not in git yet?". Untracked files survive a
 * checkout untouched, and a modified submodule POINTER is chronic in a repo of submodules —
 * counting either would refuse every switch forever. Tracked modifications are the ones a
 * HEAD move carries across branches, exposing whatever else is live in this shared checkout
 * (a second agent session, a dev server, a build) to files changing underneath it.
 *
 * Returns a boolean — does NOT throw; a git failure answers false (callers must not be
 * wedged by an unreadable tree). Call this ONLY when `repoPath` is its own repo (see isRepo).
 *
 * @param {string} repoPath - Absolute path to the git working tree.
 * @returns {boolean}
 */
export function hasTrackedChanges(repoPath) {
  const result = _spawnSync('git', ['status', '--porcelain', '--ignore-submodules=all'], {
    shell: false,
    cwd: repoPath,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return false;
  return String(result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => !line.startsWith('??'));
}

/**
 * Return whether the checked-out branch at `repoPath` has local commits NOT present
 * on its upstream — i.e. work that exists ONLY locally and would be permanently lost
 * if the working tree were deleted (`git rev-list @{upstream}..HEAD` is non-empty).
 *
 * Conservative by design: this returns TRUE whenever it CANNOT prove the local HEAD
 * is on the remote — no upstream is configured, HEAD is detached, or the rev-list
 * fails. Callers use this to gate a destructive reclaim (`service free`); when in
 * doubt, treat the source as unrecoverable and refuse without --force.
 *
 * Returns a boolean — does NOT throw. Call this ONLY when `repoPath` is its own repo
 * (see isRepo). A repo with no commits at all returns false (nothing to lose).
 *
 * @param {string} repoPath - Absolute path to the git working tree.
 * @returns {boolean}
 */
export function hasUnpushedCommits(repoPath) {
  // No commits yet → nothing local to lose.
  if (!hasCommits(repoPath)) return false;

  // Resolve the upstream tracking ref. Absent upstream / detached HEAD → cannot
  // prove pushed → conservative true.
  const upstream = _spawnSync(
    'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { shell: false, cwd: repoPath, encoding: 'utf8' }
  );
  if (upstream.error || upstream.status !== 0) return true;
  const ref = (upstream.stdout || '').trim();
  if (!ref) return true;

  // Count commits reachable from HEAD but not from the upstream.
  const ahead = _spawnSync(
    'git', ['rev-list', '--count', `${ref}..HEAD`],
    { shell: false, cwd: repoPath, encoding: 'utf8' }
  );
  if (ahead.error || ahead.status !== 0) return true; // cannot determine → conservative
  return (ahead.stdout || '').trim() !== '0';
}

/**
 * Read-only `git ls-remote <url>` — list the refs the remote advertises, without
 * cloning or fetching objects. This is the binding-verification probe used by
 * `project set-remote`: the CLI checks whether the remote holds the
 * project's HEAD before recording `remote_source`.
 *
 * `url` is passed as a positional arg, `shell:false` — no interpolation.
 * This is one of the few sanctioned network operations, and it is a READ.
 *
 * @param {string} url - Git URL to query.
 * @returns {Array<{ sha: string, ref: string }>} - advertised refs (empty array
 *          if the remote is reachable but has no refs).
 * @throws {SidekicksError(EXIT_GIT)} if the remote is unreachable / git fails.
 */
export function lsRemote(url) {
  const result = runGit(['ls-remote', url], process.cwd());
  const lines = (result.stdout || '').split('\n');
  const refs = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "<sha>\t<ref>"
    const tab = trimmed.indexOf('\t');
    if (tab === -1) continue;
    refs.push({
      sha: trimmed.slice(0, tab).trim(),
      ref: trimmed.slice(tab + 1).trim(),
    });
  }
  return refs;
}

/**
 * The commit a remote serves for a ref name, looking it up as a BRANCH and then as a TAG.
 *
 * `core status` asked `refs/heads/<want>` only, so a mount pinned to `v1.4.2` — the normal state for
 * a released core, and what every installer produces — never matched anything and reported the
 * remote as unreadable while `git ls-remote` from the same directory succeeded
 * (INC-2026-09-04-02, N-1).
 *
 * The `^{}` fallback is the annotated-tag peel: `ls-remote` advertises the TAG OBJECT at
 * `refs/tags/v1.4.2` and the COMMIT it points at as `refs/tags/v1.4.2^{}`. Comparing a checked-out
 * commit against a tag object's sha never matches, so the peeled form is preferred and the bare form
 * is the lightweight-tag case. Same shape as `scripts/framework-core-publish.mjs`'s `remoteTagSha`,
 * which cannot be imported (it is a standalone script with its own git wrapper).
 *
 * @param {Array<{sha: string, ref: string}>} refs - as returned by `lsRemote`
 * @param {string} want - a bare ref NAME ('main', 'v1.4.2'), not a full refname
 * @returns {{sha: string, kind: 'branch'|'tag'} | null}
 */
export function findRemoteRef(refs, want) {
  if (!Array.isArray(refs) || !want) return null;
  const at = (full) => {
    const hit = refs.find((r) => r && r.ref === full);
    return hit ? hit.sha : null;
  };
  const branch = at(`refs/heads/${want}`);
  if (branch) return { sha: branch, kind: 'branch' };
  const tag = at(`refs/tags/${want}^{}`) || at(`refs/tags/${want}`);
  if (tag) return { sha: tag, kind: 'tag' };
  return null;
}

/** `v1.4.10` -> [1, 4, 10]. Null for anything that is not a bare `vMAJOR.MINOR.PATCH` tag. */
function semverParts(tagName) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tagName);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The highest `vX.Y.Z` release tag a remote serves that is strictly newer than `current`.
 *
 * Numeric per component, never lexicographic: `v1.10.0` sorts BELOW `v1.9.0` as a string, and the
 * installers' own tag listing avoids `sort -V` for the same reason (it is not POSIX). Pre-release
 * and suffixed tags are deliberately not matched — "is there a newer release" must not be answered
 * with a release candidate.
 *
 * @param {Array<{sha: string, ref: string}>} refs - as returned by `lsRemote`
 * @param {string} current - the tag this mount is pinned to, e.g. 'v1.4.2'
 * @returns {string | null} the tag name, or null when `current` is the newest (or is not a release tag)
 */
export function newerReleaseTag(refs, current) {
  const from = semverParts(current || '');
  if (!from || !Array.isArray(refs)) return null;
  let best = null;
  let bestParts = from;
  for (const r of refs) {
    if (!r || typeof r.ref !== 'string') continue;
    if (!r.ref.startsWith('refs/tags/')) continue;
    const name = r.ref.slice('refs/tags/'.length).replace(/\^\{\}$/, '');
    const parts = semverParts(name);
    if (!parts) continue;
    for (let i = 0; i < 3; i += 1) {
      if (parts[i] > bestParts[i]) { best = name; bestParts = parts; break; }
      if (parts[i] < bestParts[i]) break;
    }
  }
  return best;
}

/**
 * Return whether `path` is the TOP LEVEL of its OWN git working tree.
 *
 * IMPORTANT: this deliberately does NOT use `git rev-parse --git-dir`, which
 * succeeds for ANY directory *inside* a git repo (it walks up the tree). Because
 * `projects/<name>/` lives inside the substrate's own root repo, that walk-up made
 * the framework unable to tell "this project is its own repo" from "this is a plain
 * folder inside root" — causing `set-remote`/`service add` to operate on the ROOT
 * repo (e.g. clobbering its `origin`). Instead we compare the repo's top level to
 * `path`: only when they are the same directory is `path` its own repo.
 *
 * Returns a boolean — does NOT throw; any failure is treated as false.
 *
 * @param {string} path - Absolute path to check.
 * @returns {boolean}
 */
export function isRepo(path) {
  const result = _spawnSync('git', ['rev-parse', '--show-toplevel'], {
    shell: false,
    cwd: path,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return false;
  const toplevel = (result.stdout || '').trim();
  if (!toplevel) return false;
  try {
    // Resolve both sides (symlinks, macOS /tmp → /private/tmp) before comparing.
    return realpathSync(toplevel) === realpathSync(path);
  } catch {
    return false;
  }
}

/**
 * Return the URL of remote `name` (default "origin") for the repo at `cwd`,
 * or null when there is no such remote, `cwd` is not a git repo, or git is absent.
 * Read-only and non-throwing — used to seed a linked project's remote_source.
 *
 * @param {string} cwd - Absolute path to a directory inside the repo.
 * @param {string} [name="origin"] - Remote name to resolve.
 * @returns {string | null}
 */
export function remoteUrl(cwd, name = 'origin') {
  const result = _spawnSync('git', ['remote', 'get-url', name], {
    shell: false,
    cwd,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  const url = (result.stdout || '').trim();
  return url || null;
}

/**
 * List all tracked files in the git repository at `cwd` using `git ls-files`.
 *
 * Gates on `isRepo` toplevel-equality before running git: if `cwd` is not the
 * top level of its own repository, returns an empty array and does NOT spawn git.
 * This prevents the known R-2 "git ops leak to root" failure where a path inside
 * the substrate's root repo would return root-repo files instead of the service's.
 *
 * A non-repo `cwd` is handled cleanly: isRepo returns false → empty array returned,
 * no git spawn, no crash.
 *
 * @param {string} cwd - Absolute path to the git working tree top level.
 * @returns {string[]} - Tracked file paths relative to the repository toplevel.
 *                       Empty array if `cwd` is not its own repo toplevel.
 * @throws {SidekicksError(EXIT_GIT)} if git ls-files itself fails (repo exists but git errors).
 */
export function lsFiles(cwd) {
  if (!isRepo(cwd)) return [];
  const result = runGit(['ls-files'], cwd);
  return (result.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Revisions that touched `relPath`, newest first, capped at `limit`.
 *
 * Read-only and non-throwing: a missing git, a non-repo `cwd` and a path git has never seen all
 * return an empty array, because every caller (today: `skill heal`'s content resolver) treats
 * "no candidate revision" and "git cannot answer" identically — it reports the file unhealable
 * either way rather than inventing content.
 *
 * @param {string} cwd - Absolute path inside the repo.
 * @param {string} relPath - Repo-relative path (POSIX or native separators).
 * @param {number} [limit=20] - Maximum revisions to return.
 * @returns {string[]} Commit SHAs, newest first.
 */
export function logRevs(cwd, relPath, limit = 20) {
  const result = _spawnSync(
    'git',
    ['log', '--format=%H', '-n', String(limit), '--', toGitPath(relPath)],
    { shell: false, cwd, encoding: 'utf8' }
  );
  if (result.error || result.status !== 0) return [];
  return (result.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * The bytes of `relPath` as recorded at `rev` (`git show <rev>:<path>`), or null when that path
 * does not exist at that revision.
 *
 * Returns a Buffer, NOT a string — every other read here passes `encoding: 'utf8'`, which would
 * silently mangle a PNG or a wheel through lossy UTF-8 replacement. The caller re-hashes the bytes
 * against a recorded sha256 before writing anything, and a mangled buffer would fail that check
 * for a reason the operator could not act on.
 *
 * Read-only and non-throwing, for the same reason as `logRevs`.
 *
 * @param {string} cwd - Absolute path inside the repo.
 * @param {string} rev - Any revision git accepts (`HEAD`, a SHA, a tag).
 * @param {string} relPath - Repo-relative path (POSIX or native separators).
 * @returns {Buffer | null}
 */
export function showBlob(cwd, rev, relPath) {
  const result = _spawnSync('git', ['show', `${rev}:${toGitPath(relPath)}`], {
    shell: false,
    cwd,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const out = result.stdout;
  if (out === null || out === undefined) return null;
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

/**
 * Read-only `.gitmodules` lookup: return whether `relPath` is registered as a
 * submodule in the root repo at `repoRoot`.
 *
 * Implementation reads `.gitmodules` directly (no git spawn needed) for robustness
 * when `git` may be absent.  If `.gitmodules` is absent or cannot be parsed, returns false.
 * Never throws — git absent → false.
 *
 * @param {string} repoRoot - Absolute path to the root repository.
 * @param {string} relPath  - Relative path to check (e.g., "projects/my-app").
 * @returns {boolean}
 */
export function rootSubmoduleHas(repoRoot, relPath) {
  const gitmodulesPath = join(repoRoot, '.gitmodules');
  if (!existsSync(gitmodulesPath)) return false;

  let content;
  try {
    content = readFileSync(gitmodulesPath, 'utf8');
  } catch {
    return false;
  }

  // Look for a [submodule "..."] section where the path = relPath.
  // We parse line by line: find a [submodule] section header and then check
  // for a `path = <relPath>` key in that section.
  const lines = content.split('\n');
  let inSubmoduleSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[submodule')) {
      inSubmoduleSection = true;
      continue;
    }
    if (inSubmoduleSection) {
      if (trimmed.startsWith('[')) {
        // New section — reset.
        inSubmoduleSection = false;
        continue;
      }
      // Check for `path = <relPath>`
      const match = trimmed.match(/^path\s*=\s*(.+)$/);
      if (match) {
        // Normalize path separators for comparison.
        const entryPath = match[1].trim().replace(/\\/g, '/');
        const normalRelPath = relPath.replace(/\\/g, '/');
        if (entryPath === normalRelPath) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Absolute path of the git directory backing the working tree at `repoPath`.
 *
 * Needed because a submodule's `.git` is a FILE containing `gitdir: ../../.git/modules/<path>`, so
 * the hooks directory is not `<repoPath>/.git/hooks`. Read-only and non-throwing — returns null when
 * `repoPath` is not a repo or git is absent.
 *
 * @param {string} repoPath - Absolute path inside the working tree.
 * @returns {string | null}
 */
export function gitDir(repoPath) {
  const result = _spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
    shell: false,
    cwd: repoPath,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  const dir = (result.stdout || '').trim();
  return dir || null;
}

/**
 * Fetch from `remote` in the repo at `cwd`.
 *
 * @param {string} cwd - Absolute path to the repository working tree.
 * @param {string} [remote="origin"] - Remote name.
 * @param {{ tags?: boolean, prune?: boolean }} [opts] - `tags` also fetches tags (default true).
 * @throws {SidekicksError(EXIT_GIT)} on failure (offline, auth, unknown remote).
 */
export function fetch(cwd, remote = 'origin', opts = {}) {
  const { tags = true, prune = false } = opts;
  const args = ['fetch'];
  if (tags) args.push('--tags');
  if (prune) args.push('--prune');
  args.push(remote);
  runGit(args, cwd);
}

/**
 * Set the PUSH url of remote `name` independently of its fetch url
 * (`git remote set-url --push`).
 *
 * This is how a read-only consumer checkout is made unpushable while staying fetchable: the fetch
 * url keeps working, the push url points at something git cannot reach.
 *
 * @param {string} cwd  - Absolute path to the repository working tree.
 * @param {string} name - Remote name (e.g. "origin").
 * @param {string} url  - Push url to set.
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function setPushUrl(cwd, name, url) {
  runGit(['remote', 'set-url', '--push', name, url], cwd);
}

/**
 * Read a repository-local git config value, or null when unset.
 * Read-only and non-throwing — an unset key exits 1, which is not an error here.
 *
 * @param {string} cwd - Absolute path to the repository working tree.
 * @param {string} key - Config key (e.g. "push.default").
 * @returns {string | null}
 */
export function getLocalConfig(cwd, key) {
  const result = _spawnSync('git', ['config', '--local', '--get', key], {
    shell: false,
    cwd,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  const value = (result.stdout || '').trim();
  return value || null;
}

/**
 * Write a repository-local git config value.
 *
 * @param {string} cwd   - Absolute path to the repository working tree.
 * @param {string} key   - Config key.
 * @param {string} value - Value to set.
 * @throws {SidekicksError(EXIT_GIT)} on failure.
 */
export function setLocalConfig(cwd, key, value) {
  runGit(['config', '--local', key, value], cwd);
}

/**
 * Resolve `ref` to a full commit SHA in the repo at `cwd`, or null when it does not exist.
 * Read-only and non-throwing — an unknown ref is a normal answer, not a failure.
 *
 * @param {string} cwd - Absolute path to the repository working tree.
 * @param {string} ref - Any revision (branch, tag, SHA, "origin/main", "HEAD").
 * @returns {string | null}
 */
export function revParse(cwd, ref) {
  const result = _spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    shell: false,
    cwd,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  const sha = (result.stdout || '').trim();
  return sha || null;
}

/**
 * How far `local` is ahead of and behind `upstream` in the repo at `cwd`.
 * Read-only and non-throwing — returns null when either ref is unknown.
 *
 * @param {string} cwd      - Absolute path to the repository working tree.
 * @param {string} local    - Local revision (e.g. "HEAD").
 * @param {string} upstream - Upstream revision (e.g. "origin/main").
 * @returns {{ ahead: number, behind: number } | null}
 */
export function aheadBehind(cwd, local, upstream) {
  const result = _spawnSync('git', ['rev-list', '--left-right', '--count', `${upstream}...${local}`], {
    shell: false,
    cwd,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  const parts = (result.stdout || '').trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
  return { ahead, behind };
}

/**
 * Check out an arbitrary revision (tag, SHA, remote-tracking ref) in the repo at `cwd`.
 *
 * Distinct from `checkout(cwd, branch)`: that verb is for named local branches. A pinned core
 * checkout is normally on a detached HEAD at a tag, which is exactly what a submodule wants.
 *
 * @param {string} cwd - Absolute path to the repository working tree.
 * @param {string} rev - Revision to check out.
 * @throws {SidekicksError(EXIT_GIT)} on failure (unknown rev, dirty tree that would be overwritten).
 */
export function checkoutRev(cwd, rev) {
  runGit(['checkout', '--detach', rev], cwd);
}

/**
 * Split the working-tree state at `repoPath` into TRACKED modifications and UNTRACKED files.
 *
 * The distinction matters wherever a checkout is about to happen: `git checkout` overwrites tracked
 * modifications (they are lost) but leaves untracked files alone. Treating the two the same either
 * destroys work or refuses to proceed over harmless residue — `__pycache__` inside a read-only
 * consumer checkout being the concrete case.
 *
 * Returns empty arrays — does NOT throw — when git is absent or the command fails. Call this ONLY
 * when `repoPath` is its own repo (see isRepo): from a plain subdir, `git status` walks up and
 * reports the PARENT repo.
 *
 * @param {string} repoPath - Absolute path to the git working tree.
 * @returns {{ tracked: string[], untracked: string[] }} paths relative to the repo toplevel
 */
export function worktreeState(repoPath) {
  const result = _spawnSync('git', ['status', '--porcelain'], {
    shell: false,
    cwd: repoPath,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return { tracked: [], untracked: [] };

  const tracked = [];
  const untracked = [];
  for (const line of (result.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    // Porcelain v1: "XY <path>", where "??" marks untracked.
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (!path) continue;
    if (code === '??') untracked.push(path);
    else tracked.push(path);
  }
  return { tracked, untracked };
}

/**
 * Absolute path of the COMMON git directory backing the working tree at `repoPath` —
 * `.git` of the main checkout, shared by every linked worktree cut from it.
 *
 * The pair (gitDir, commonGitDir) is what distinguishes a linked worktree from a main
 * checkout: in a main checkout the two are the same directory, while in a linked worktree
 * gitDir is `<common>/worktrees/<name>`. Nothing else answers that question reliably —
 * a path convention (`../worktrees/<slug>`) is only this repo's habit, and `git worktree
 * list` has to be parsed and matched, which fails on a symlinked prefix.
 *
 * `--path-format=absolute` is passed because the bare `--git-common-dir` answer is
 * relative to the working tree's toplevel in a main checkout (`.git`) and absolute in a
 * linked worktree — comparing those two spellings would report every main checkout as a
 * worktree. It needs git >= 2.31; when it is unsupported the command fails and this
 * returns null, which callers treat as "cannot tell" rather than "is a worktree".
 *
 * Read-only and non-throwing — returns null when `repoPath` is not a repo or git is absent.
 *
 * @param {string} repoPath - Absolute path inside the working tree.
 * @returns {string | null}
 */
export function commonGitDir(repoPath) {
  const result = _spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    shell: false,
    cwd: repoPath,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  const dir = (result.stdout || '').trim();
  return dir || null;
}

/**
 * Absolute toplevel of the working tree containing `repoPath` (its own toplevel when it IS
 * one). Read-only and non-throwing — returns null outside a repo or when git is absent.
 *
 * @param {string} repoPath - Absolute path inside the working tree.
 * @returns {string | null}
 */
export function topLevel(repoPath) {
  const result = _spawnSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel'], {
    shell: false,
    cwd: repoPath,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  const top = (result.stdout || '').trim();
  return top || null;
}

/**
 * Is `relPath` ignored by the repo at `repoPath`?
 *
 * `check-ignore -q` exits 0 for an ignored path, 1 for a non-ignored one and 128 on error, so
 * the three outcomes are distinguishable — an error returns null ("cannot tell"), never false.
 * The path is normalized to POSIX because git rejects backslash pathspecs on every OS.
 *
 * `--no-index` is NOT passed: a path already tracked in the index is deliberately reported as
 * NOT ignored, which is the honest answer for the question callers ask (would this file be
 * committable here?).
 *
 * @param {string} repoPath - Absolute path inside the working tree.
 * @param {string} relPath  - Path relative to the working tree's toplevel.
 * @returns {boolean | null}
 */
export function isPathIgnored(repoPath, relPath) {
  const result = _spawnSync('git', ['check-ignore', '-q', '--', toGitPath(relPath)], {
    shell: false,
    cwd: repoPath,
    encoding: 'utf8',
  });
  if (result.error) return null;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}
