// lib/worktree-lifecycle/link-deps.mjs
// Implements `sidekicks worktree link-deps [<worktree-path>] [--from <main-checkout>] [--check]
//                                          [--no-exclude] [--json]`.
//
// Point a linked worktree's `node_modules` at the main checkout's instead of installing a second
// copy of it. AGENTS.md → "Never install or build inside a worktree": a fresh worktree starts with
// no `node_modules`, and the reflexive `yarn install` there re-downloads the entire dependency set
// over a metered connection for a tree that already exists next door. A directory link costs
// nothing and is valid whenever both checkouts sit on a base with the same dependency set.
//
// Three things this verb does that a hand-written `ln -s` does not:
//
//   1. CROSS-PLATFORM. POSIX gets an absolute directory symlink, Windows an NTFS junction (no
//      admin or Developer Mode needed) — createDirLink() in lib/fs-safety/fsx.mjs, the same split
//      `project link` and the host skill links use. A bare `ln -s` in a runbook is macOS-only,
//      which the repo's one-implementation-for-both-OSes rule forbids.
//
//   2. MONOREPOS. It links every package directory that has a `node_modules` in the main checkout,
//      not just the root, so a workspace layout is covered without the caller enumerating paths.
//
//   3. THE LINK IS NOT IGNORED BY DEFAULT, and that is measured, not assumed. The near-universal
//      `.gitignore` spelling is `node_modules/` — a DIRECTORY pattern, which does not match a
//      symlink. Verified in this repo: with the link in place `git status` reports `?? node_modules`.
//      An untracked entry there is not cosmetic — it makes a machine-absolute symlink committable
//      (a portable-paths violation), and `git worktree remove` refuses a worktree carrying
//      untracked files. So the link is excluded locally unless `--no-exclude` says otherwise.
//      The exclude goes in the COMMON git dir's `info/exclude`: a linked worktree's own
//      `$GIT_DIR/info/exclude` is NOT read by git (measured — the entry had no effect), because
//      git resolves info/exclude against `$GIT_COMMON_DIR`. That file is per-clone and never
//      committed, and the entry is a no-op for the main checkout, whose real `node_modules`
//      directory its `.gitignore` already covers.
//
// Zero npm dependencies — node:* and relative lib/ imports only. All git spawns delegated to
// git-delegation/git.mjs; shell: false everywhere.

import {
  existsSync, lstatSync, readlinkSync, readFileSync, appendFileSync, mkdirSync, readdirSync,
} from 'node:fs';
import { join, resolve as resolvePath, relative, isAbsolute, dirname } from 'node:path';

import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { commonGitDir, topLevel, isPathIgnored } from '../git-delegation/git.mjs';
import { createDirLink, removeDirLink } from '../fs-safety/fsx.mjs';

/** Flags that never take a value — needed by the local argv re-parse below. */
const BOOLEANS = ['check', 'json', 'no-exclude', 'help', 'verbose', 'version'];

/** How deep below a checkout root a package directory is looked for. */
const MAX_DEPTH = 3;

/** Directories never descended into while looking for package dirs. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build',
  'coverage', '.cache', 'artifacts', 'runtimes', '.yarn',
]);

/** Lockfiles compared between the two checkouts, in the order they are reported. */
const LOCKFILES = ['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml', 'bun.lockb'];

/**
 * Parse `--flag`, `--flag=value` and `--flag value` out of the raw argv.
 *
 * A LOCAL copy rather than an import from another lifecycle's `_shared.mjs`, for the reason
 * catalog-, check- and scope-lifecycle each give: `package transfer` ships lib subsystems by
 * import closure, so a cross-subsystem import drags an unrelated toolchain along. The re-parse
 * itself is not optional — the dispatcher's parseArgs runs with `strict: false` and declares only
 * --help/--version/--verbose, so `--from /path` reaches a verb as `{ from: true }` plus a stray
 * positional, while `--from=/path` reaches it as `{ from: '/path' }`.
 *
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseFlags(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const tok = list[i];
    if (typeof tok !== 'string' || !tok.startsWith('--')) continue;
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      const key = body.slice(0, eq);
      out[key] = BOOLEANS.includes(key) ? true : body.slice(eq + 1);
      continue;
    }
    if (BOOLEANS.includes(body)) { out[body] = true; continue; }
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[body] = next; i += 1; }
    else out[body] = '';
  }
  return out;
}

/**
 * The positionals of the raw argv, flag VALUES excluded (see parseFlags for why the
 * dispatcher's own positional list cannot be trusted for a verb taking a valued flag).
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
function positionals(argv) {
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      if (body.includes('=') || BOOLEANS.includes(body)) continue;
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('--')) i += 1; // consumed as this flag's value
      continue;
    }
    out.push(tok);
  }
  return out;
}

/** POSIX-form relative path, so a report reads identically on macOS and Windows. */
const posixRel = (from, to) => relative(from, to).split(/[\\/]/).join('/');

/**
 * Is `p` a link (POSIX symlink or NTFS junction)? Non-throwing.
 *
 * lstat, not the dirent type: a junction is a directory carrying a reparse point and is only
 * reliably reported as a link through lstat (the caveat skill-links.mjs and core-lifecycle
 * both note).
 *
 * @param {string} p
 * @returns {boolean}
 */
function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/**
 * Where a link points, resolved to an absolute path. null when `p` is not a link.
 *
 * @param {string} p
 * @returns {string|null}
 */
function linkTarget(p) {
  try {
    const raw = readlinkSync(p);
    return isAbsolute(raw) ? resolvePath(raw) : resolvePath(dirname(p), raw);
  } catch { return null; }
}

/**
 * Real path of `p` with a trailing separator folded away, for comparing two spellings of the
 * same directory. Falls back to the resolved input when it does not exist.
 *
 * @param {string} p
 * @returns {string}
 */
function samePathKey(p) {
  const abs = resolvePath(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * Every directory under `root` (depth-bounded) that CONTAINS a `node_modules` directory.
 * Returned as POSIX paths relative to `root`; the root itself is `''`.
 *
 * Driven off the main checkout's actual installs rather than off `package.json` files: a
 * workspace monorepo has a `package.json` in every package but hoists most installs to the root,
 * and linking a `node_modules` that does not exist in the source is how a dangling link is born.
 *
 * @param {string} root - absolute path of the main checkout
 * @returns {string[]}
 */
function packageDirsWithModules(root) {
  const found = [];
  const walk = (absDir, relDir, depth) => {
    if (existsSync(join(absDir, 'node_modules'))) found.push(relDir);
    if (depth >= MAX_DEPTH) return;
    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const name = entry.name;
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      // Never follow a link while walking: a linked project (`project link`) can point back into
      // the repo, and the walk would loop or wander onto another volume.
      if (entry.isSymbolicLink()) continue;
      walk(join(absDir, name), relDir ? `${relDir}/${name}` : name, depth + 1);
    }
  };
  walk(root, '', 0);
  return found;
}

/**
 * Dependency-shape comparison between the two copies of one package directory.
 *
 * Compares the `dependencies` / `devDependencies` / `optionalDependencies` / `peerDependencies`
 * blocks of `package.json` and the bytes of any lockfile present, and reports WHICH files differ.
 * A difference does not stop the link — a link is still the right thing, and only the operator
 * knows whether the skew matters — but it is stated loudly, because it is the one case where the
 * main checkout's tree is genuinely the wrong tree.
 *
 * @param {string} mainDir - absolute package dir in the main checkout
 * @param {string} wtDir   - absolute package dir in the worktree
 * @returns {string[]} names of the files whose dependency-relevant content differs
 */
function dependencySkew(mainDir, wtDir) {
  const differing = [];

  const depBlocks = (dir) => {
    let parsed;
    try { parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
    catch { return null; }
    const pick = {};
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      // Key order in package.json is not meaningful; sort so a re-ordered file is not "skew".
      const block = parsed && parsed[key];
      if (!block || typeof block !== 'object') continue;
      pick[key] = Object.keys(block).sort().map((k) => `${k}@${block[k]}`);
    }
    // `resolutions`/`overrides` change what actually lands in node_modules, so they count too.
    for (const key of ['resolutions', 'overrides']) {
      const block = parsed && parsed[key];
      if (block && typeof block === 'object') pick[key] = JSON.stringify(block);
    }
    return JSON.stringify(pick);
  };

  const mainDeps = depBlocks(mainDir);
  const wtDeps = depBlocks(wtDir);
  if (mainDeps !== wtDeps) differing.push('package.json');

  for (const lock of LOCKFILES) {
    const a = join(mainDir, lock);
    const b = join(wtDir, lock);
    const aExists = existsSync(a);
    const bExists = existsSync(b);
    if (!aExists && !bExists) continue;
    if (aExists !== bExists) { differing.push(lock); continue; }
    try {
      if (!readFileSync(a).equals(readFileSync(b))) differing.push(lock);
    } catch {
      differing.push(lock); // unreadable on one side is not evidence of sameness
    }
  }
  return differing;
}

/**
 * Append `entry` to the common git dir's `info/exclude` if it is not already listed.
 *
 * @param {string} commonDir - absolute path of the common git dir
 * @param {string} entry     - a gitignore pattern, e.g. `node_modules` or `packages/a/node_modules`
 * @returns {'added'|'present'|'failed'}
 */
function ensureExcluded(commonDir, entry) {
  const file = join(commonDir, 'info', 'exclude');
  try {
    let current = '';
    try { current = readFileSync(file, 'utf8'); } catch { /* not created yet */ }
    const lines = current.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(entry) || lines.includes(`/${entry}`)) return 'present';
    mkdirSync(dirname(file), { recursive: true });
    // Leading newline only when the file does not already end in one, so a file without a
    // trailing newline does not get the entry glued onto its last line.
    const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
    appendFileSync(file, `${prefix}${entry}\n`, 'utf8');
    return 'added';
  } catch {
    return 'failed';
  }
}

/**
 * Execute the `worktree link-deps` verb.
 *
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @param {{ name: string|undefined, rest: string[], flags: object }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const argv = (ctx && ctx.argv) || [];
  const flags = parseFlags(argv);
  const pos = positionals(argv);
  // argv positionals still carry the namespace and verb; the verb's own argument follows them.
  const nsIdx = pos.indexOf('worktree');
  const target = nsIdx !== -1 ? pos.slice(nsIdx + 2)[0] : (args && args.name);

  const checkOnly = Boolean(flags.check);
  const asJson = Boolean(flags.json);
  const doExclude = !flags['no-exclude'];

  // ---- resolve the worktree -----------------------------------------------------
  const startDir = target
    ? (isAbsolute(String(target)) ? String(target) : resolvePath(process.cwd(), String(target)))
    : process.cwd();

  if (!existsSync(startDir)) {
    throw new SidekicksError(`worktree link-deps: no such directory: ${startDir}`, EXIT_VALIDATION);
  }

  const worktreeRoot = topLevel(startDir);
  if (!worktreeRoot) {
    throw new SidekicksError(
      `worktree link-deps: '${startDir}' is not inside a git working tree`,
      EXIT_VALIDATION
    );
  }

  const commonDir = commonGitDir(worktreeRoot);
  if (!commonDir) {
    throw new SidekicksError(
      `worktree link-deps: cannot resolve the git common dir for '${worktreeRoot}' — ` +
        'git >= 2.31 is required (rev-parse --path-format)',
      EXIT_VALIDATION
    );
  }

  // ---- resolve the main checkout ------------------------------------------------
  // `--from` wins; otherwise the common git dir's parent IS the main checkout, which holds for a
  // separate git dir too (`git init --separate-git-dir`) only when the caller passes --from — so
  // the derived answer is verified as a working tree before it is used.
  let mainRoot;
  if (flags.from && String(flags.from).trim() !== '') {
    const fromArg = String(flags.from).trim();
    const fromAbs = isAbsolute(fromArg) ? fromArg : resolvePath(process.cwd(), fromArg);
    mainRoot = topLevel(fromAbs);
    if (!mainRoot) {
      throw new SidekicksError(
        `worktree link-deps: --from '${fromArg}' is not inside a git working tree`,
        EXIT_VALIDATION
      );
    }
  } else {
    const derived = dirname(commonDir);
    mainRoot = topLevel(derived);
    if (!mainRoot) {
      throw new SidekicksError(
        `worktree link-deps: cannot derive the main checkout from '${commonDir}' — ` +
          'pass --from <main-checkout>',
        EXIT_VALIDATION
      );
    }
  }

  if (samePathKey(mainRoot) === samePathKey(worktreeRoot)) {
    throw new SidekicksError(
      `worktree link-deps: '${worktreeRoot}' IS the main checkout, not a linked worktree — ` +
        'installs belong here, and this is the tree every worktree links back to. Run this ' +
        'inside the worktree (or pass its path), not here.',
      EXIT_VALIDATION
    );
  }

  // ---- per-package-dir work -----------------------------------------------------
  const dirs = packageDirsWithModules(mainRoot);
  /** @type {{dir: string, state: string, detail?: string, skew?: string[], exclude?: string}[]} */
  const results = [];

  for (const relDir of dirs) {
    const sourceModules = join(mainRoot, relDir, 'node_modules');
    const linkPath = join(worktreeRoot, relDir, 'node_modules');
    const relLink = relDir ? `${relDir}/node_modules` : 'node_modules';
    // ONE object per site, pushed once at the end of the iteration: an earlier version pushed a
    // spread copy and then set `exclude` on the local, so the exclude never reached the report.
    const entry = { dir: relDir || '.', link: relLink, state: 'missing' };
    results.push(entry);

    // The worktree may not carry this package dir at all (a branch that deleted it, or a
    // sparse checkout). Nothing to link into.
    if (!existsSync(join(worktreeRoot, relDir))) {
      entry.state = 'absent-in-worktree';
      continue;
    }

    entry.skew = dependencySkew(join(mainRoot, relDir), join(worktreeRoot, relDir));

    const linked = isLink(linkPath);
    if (!linked && existsSync(linkPath)) {
      // A REAL directory — someone already installed here. Never deleted: that is the caller's
      // call, and deleting an install is the one irreversible thing this verb could do.
      entry.state = 'real-directory';
      continue;
    }

    if (linked) {
      const current = linkTarget(linkPath);
      if (current && samePathKey(current) === samePathKey(sourceModules)) {
        entry.state = 'already-linked';
        if (!checkOnly && doExclude) entry.exclude = maybeExclude(worktreeRoot, commonDir, relLink);
        continue;
      }
      entry.detail = current || '(unreadable)';
      if (checkOnly) { entry.state = 'linked-elsewhere'; continue; }
      // Repointing a link is cheap and reversible — nothing is removed but the pointer itself.
      try {
        removeDirLink(linkPath);
        createDirLink(sourceModules, linkPath);
        entry.state = 'repointed';
      } catch (err) {
        entry.state = 'failed';
        entry.detail = err.message;
        continue;
      }
      if (doExclude) entry.exclude = maybeExclude(worktreeRoot, commonDir, relLink);
      continue;
    }

    if (checkOnly) { entry.state = 'missing'; continue; }

    try {
      createDirLink(sourceModules, linkPath);
      entry.state = 'linked';
    } catch (err) {
      entry.state = 'failed';
      entry.detail = err.message;
      continue;
    }
    if (doExclude) entry.exclude = maybeExclude(worktreeRoot, commonDir, relLink);
  }

  // ---- report -------------------------------------------------------------------
  const unlinked = results.filter((r) => ['missing', 'linked-elsewhere', 'failed'].includes(r.state));
  const exitCode = checkOnly && unlinked.length > 0 ? EXIT_VALIDATION : EXIT_OK;

  if (asJson) {
    return {
      stdout: `${JSON.stringify({
        worktree: worktreeRoot,
        main: mainRoot,
        mode: checkOnly ? 'check' : 'link',
        sites: results,
      }, null, 2)}\n`,
      exitCode,
    };
  }

  const lines = [];
  lines.push(`worktree : ${worktreeRoot}`);
  lines.push(`main     : ${mainRoot}`);
  if (results.length === 0) {
    lines.push('');
    lines.push(`No node_modules found anywhere in the main checkout (searched ${MAX_DEPTH} levels).`);
    lines.push('Nothing to link — install once in the main checkout first, then re-run this.');
    return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
  }

  lines.push('');
  for (const r of results) {
    const where = r.dir === '.' ? 'node_modules' : `${r.dir}/node_modules`;
    lines.push(`${STATE_LABEL[r.state] ?? r.state}  ${where}${r.detail ? `  (${r.detail})` : ''}`);
    if (r.exclude === 'added') {
      lines.push(`    excluded locally — appended '${r.link}' to ${posixRel(mainRoot, join(commonDir, 'info/exclude'))}`);
    }
    if (r.skew && r.skew.length > 0) {
      lines.push(`    WARNING: ${r.skew.join(', ')} differ${r.skew.length === 1 ? 's' : ''} between this branch and the main checkout.`);
      lines.push('    The linked tree is the MAIN checkout\'s install, so it may be missing or holding back a dependency.');
      lines.push('    Fix it in the main checkout (check that branch out there and install once) — never install here.');
    }
  }

  if (checkOnly && unlinked.length > 0) {
    lines.push('');
    lines.push(`${unlinked.length} site(s) not linked — run without --check to link them.`);
  }
  if (results.some((r) => r.state === 'real-directory')) {
    lines.push('');
    lines.push('A real node_modules directory was left untouched — this verb never deletes an install.');
    lines.push('Delete it yourself if you want it replaced by a link, then re-run.');
  }

  return { stdout: `${lines.join('\n')}\n`, exitCode };
}

/** Human labels for each site state, padded so the paths line up. */
const STATE_LABEL = Object.freeze({
  linked:              'linked        ',
  'already-linked':    'already linked',
  repointed:           'repointed     ',
  missing:             'MISSING       ',
  'linked-elsewhere':  'WRONG TARGET  ',
  'real-directory':    'real directory',
  'absent-in-worktree':'absent        ',
  failed:              'FAILED        ',
});

/**
 * Exclude `relLink` locally when git would otherwise report it as untracked.
 *
 * Only when it is NOT already ignored: the common `.gitignore` spelling `node_modules/` is a
 * directory pattern that does not match a symlink, but a repo spelling it `node_modules` needs
 * nothing added.
 *
 * @param {string} worktreeRoot
 * @param {string} commonDir
 * @param {string} relLink
 * @returns {'added'|'present'|'failed'|'not-needed'|'unknown'}
 */
function maybeExclude(worktreeRoot, commonDir, relLink) {
  const ignored = isPathIgnored(worktreeRoot, relLink);
  if (ignored === true) return 'not-needed';
  if (ignored === null) return 'unknown';
  return ensureExcluded(commonDir, relLink);
}
