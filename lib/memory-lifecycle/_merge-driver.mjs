// lib/memory-lifecycle/_merge-driver.mjs
// Registration of the `sidekicks-memory` git merge driver, and the post-merge hook that
// regenerates the store's faces after a merge.
//
// WHY THIS IS SELF-HEALING RATHER THAN A SETUP STEP: `.gitattributes` is committed, but the
// driver it names lives in `.git/config`, which is per-clone and NEVER committed. A merge in
// a clone where nobody ran an install verb silently falls back to git's text merge — i.e.
// the conflicts this whole design exists to end, in exactly the checkout least likely to
// notice. So `ensureMemoryMergeDriver` runs on every CLI invocation, next to the skill-link
// self-heal, and costs one readFileSync when the driver is already registered.
//
// Worktrees share `$GIT_COMMON_DIR`, so one registration covers every worktree of a clone —
// which is the multi-checkout case the store is being merged from in the first place.
//
// Best-effort by contract: nothing here throws into a verb. A missing git, a read-only
// `.git/`, a submodule-mounted core with no `bin/sidekicks` at the root — each degrades to
// "not registered", reported by `memory doctor`, never a failed command.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { CORE_DIR } from '../sk-cli/core-mount.mjs';

/** The driver name `.gitattributes` refers to (`merge=sidekicks-memory`). */
export const DRIVER_NAME = 'sidekicks-memory';

/** Marks a hook as ours, so we never overwrite somebody else's. */
export const HOOK_MARKER = '# sidekicks-memory-merge';

/** Hooks that leave the memory faces stale, and therefore want the rebuild. */
const HOOK_NAMES = ['post-merge', 'post-rewrite'];

/** The store path the merge machinery is about, repo-relative and forward-slashed for git. */
const STORE_REL = '.sidekicks/memory';

/**
 * Read one `[section] key` out of a git config FILE, last-wins, without spawning git.
 *
 * Deliberately a small parser rather than `git config --get`: this module is imported on every
 * CLI invocation, and the whole point of the hand-rolled path resolution above it is to stay at
 * a few file reads. What it handles is what git config files actually contain — a `[section]`
 * header (case-insensitive, `[core]` and `[CORE]` alike), `key = value` with any spacing,
 * `#`/`;` comments, and a double-quoted value. What it does not handle it does not need to: a
 * `[section "sub"]` subsection can never carry `core.hooksPath`, and an `include.path` chain is
 * rare enough that missing it degrades to "assume no override", which is the pre-existing
 * behaviour rather than a new failure.
 *
 * @param {string} file - path to a git config file
 * @param {string} section - e.g. 'core'
 * @param {string} key - e.g. 'hooksPath'
 * @returns {string|null} the last value set, or null when absent/unreadable
 */
export function readGitConfigValue(file, section, key) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const wantSection = section.toLowerCase();
  const wantKey = key.toLowerCase();
  let current = null;
  let found = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\s\]]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (header) {
      // A subsection is a different section — `[core "x"]` is not `[core]`.
      current = header[2] === undefined ? header[1].toLowerCase() : null;
      continue;
    }
    if (current !== wantSection) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim().toLowerCase() !== wantKey) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    if (quoted) {
      value = quoted[1].replace(/\\(.)/g, '$1');
    } else {
      // Strip a trailing comment only on an unquoted value — a `#` inside quotes is data.
      value = value.replace(/\s+[#;].*$/, '').trim();
    }
    if (value) found = value;
  }
  return found;
}

/**
 * The git config files that can set `core.hooksPath`, in git's own precedence order (later
 * wins). System config is skipped on purpose: reading it needs the git binary's compiled-in
 * prefix, and a system-wide `core.hooksPath` would be an unusual enough machine that reporting
 * "no override" — and so writing where we always used to — is the safer wrong answer.
 *
 * @param {string} commonDir - the shared git dir, whose `config` is this clone's local config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} existing paths, lowest precedence first
 */
function gitConfigFiles(commonDir, env = process.env) {
  const files = [];
  if (env.GIT_CONFIG_GLOBAL) {
    // The env override REPLACES both global files rather than adding to them.
    files.push(env.GIT_CONFIG_GLOBAL);
  } else {
    const home = env.HOME || env.USERPROFILE || homedir();
    const xdg = env.XDG_CONFIG_HOME
      ? join(env.XDG_CONFIG_HOME, 'git', 'config')
      : (home ? join(home, '.config', 'git', 'config') : null);
    if (xdg) files.push(xdg);
    if (home) files.push(join(home, '.gitconfig'));
  }
  files.push(join(commonDir, 'config'));
  return files;
}

/**
 * Where git will ACTUALLY look for hooks in this checkout.
 *
 * `core.hooksPath` is the whole reason this function exists. When it is set, git ignores
 * `$GIT_DIR/hooks` COMPLETELY — it does not fall back and it does not run both. A hook written
 * to `$GIT_DIR/hooks` in such a checkout is dead on arrival, and dead silently: the file is
 * there, executable, correct, and never invoked. This repo sets `core.hooksPath=.githooks`, so
 * that is exactly what happened to the post-merge rebuild — `memory merge status` reported the
 * hooks as `ours` while nothing could fire, and every merge shipped stale faces.
 *
 * A relative value resolves against the top of the WORKING TREE (git's rule), not against the
 * git dir — `.githooks` means `<repoRoot>/.githooks`. `~/` is expanded, as git does.
 *
 * @param {string} repoRoot
 * @param {string} commonDir
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ dir: string, setting: string|null, defaultDir: string }}
 */
export function resolveHooksDir(repoRoot, commonDir, env = process.env) {
  const defaultDir = join(commonDir, 'hooks');
  let setting = null;
  // Later file wins, matching git.
  for (const file of gitConfigFiles(commonDir, env)) {
    const value = readGitConfigValue(file, 'core', 'hooksPath');
    if (value) setting = value;
  }
  if (!setting) return { dir: defaultDir, setting: null, defaultDir };

  let raw = setting;
  if (raw === '~') raw = env.HOME || env.USERPROFILE || homedir() || raw;
  else if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    const home = env.HOME || env.USERPROFILE || homedir();
    if (home) raw = join(home, raw.slice(2));
  }
  return {
    dir: isAbsolute(raw) ? raw : resolve(repoRoot, raw),
    setting,
    defaultDir,
  };
}

/** Env escape hatch — user-sanctioned only, never self-granted (mirrors SIDEKICKS_BRANCH_SAFETY). */
export function mergeSelfHealDisabled(env = process.env) {
  return String(env?.SIDEKICKS_MEMORY_MERGE ?? '').trim().toLowerCase() === 'off';
}

/**
 * Locate this checkout's git dirs WITHOUT spawning git.
 *
 * `.git` is a directory in a normal clone and a `gitdir:` pointer file in a worktree or a
 * submodule; the shared half (config, hooks) is named by `commondir` inside the resolved
 * git dir. Doing this by hand rather than through `git rev-parse` keeps the every-invocation
 * check at two file reads.
 *
 * `hooksDir` is where git will really run hooks, which is NOT always `$GIT_DIR/hooks` — see
 * resolveHooksDir. `hooksDirDefault` is kept alongside it so status can report a hook stranded
 * in the ignored directory instead of claiming it is installed.
 *
 * @param {string} repoRoot
 * @returns {{ gitDir: string, commonDir: string, configPath: string, hooksDir: string,
 *   hooksDirDefault: string, hooksPathSetting: string|null }|null}
 */
export function resolveGitPaths(repoRoot) {
  const dotGit = join(repoRoot, '.git');
  if (!existsSync(dotGit)) return null;

  let gitDir = dotGit;
  try {
    if (!statSync(dotGit).isDirectory()) {
      const text = readFileSync(dotGit, 'utf8');
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (!m) return null;
      gitDir = isAbsolute(m[1]) ? m[1] : resolve(repoRoot, m[1]);
    }
  } catch {
    return null;
  }

  let commonDir = gitDir;
  try {
    const marker = join(gitDir, 'commondir');
    if (existsSync(marker)) {
      const rel = readFileSync(marker, 'utf8').trim();
      if (rel) commonDir = isAbsolute(rel) ? rel : resolve(gitDir, rel);
    }
  } catch { /* a worktree without commondir is just a plain clone here */ }

  const hooks = resolveHooksDir(repoRoot, commonDir);
  return {
    gitDir,
    commonDir,
    configPath: join(commonDir, 'config'),
    hooksDir: hooks.dir,
    hooksDirDefault: hooks.defaultDir,
    hooksPathSetting: hooks.setting,
  };
}

/**
 * The repo-relative path to the CLI entry point, or null when there is none to call.
 *
 * Relative on purpose: git runs a merge driver and a hook from the top of the working tree,
 * so a relative command is both correct and free of a machine-absolute path. A workspace
 * that consumes the framework as a submodule has no `bin/sidekicks` at its root — there the
 * mounted core's copy is the one that can answer.
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function cliRelPath(repoRoot) {
  if (existsSync(join(repoRoot, 'bin', 'sidekicks'))) return 'bin/sidekicks';
  const mounted = join(repoRoot, CORE_DIR, 'bin', 'sidekicks');
  if (existsSync(mounted)) return `${CORE_DIR}/bin/sidekicks`;
  return null;
}

/**
 * The `merge.<name>.driver` command git will run. `%O %A %B` are the base/ours/theirs temp
 * files, `%P` the path being merged (the driver decides face-vs-entry from it) and `%L` the
 * conflict-marker size.
 *
 * @param {string} cliRel
 * @returns {string}
 */
export function driverCommand(cliRel) {
  return `node ${cliRel} memory merge driver --base %O --ours %A --theirs %B --path %P --marker-size %L`;
}

/**
 * Is the driver registered in this clone's config? A plain substring read — `git config
 * --get` would be a subprocess on every CLI invocation, which is the one cost this check
 * cannot afford.
 *
 * @param {string} configPath
 * @returns {boolean}
 */
export function isRegistered(configPath) {
  let text;
  try { text = readFileSync(configPath, 'utf8'); } catch { return false; }
  const idx = text.search(new RegExp(`^\\[merge "${DRIVER_NAME}"\\]`, 'm'));
  if (idx === -1) return false;
  // Only the driver's OWN section counts — a `driver =` belonging to the next section is
  // not this one's, and a section left behind with no driver line does not merge anything.
  const rest = text.slice(idx);
  const next = rest.slice(1).search(/^\[/m);
  const block = next === -1 ? rest : rest.slice(0, next + 1);
  return /^\s*driver\s*=\s*\S/m.test(block);
}

/** The body of the regenerate-after-merge hook. */
function hookBody(cliRel) {
  return [
    '#!/bin/sh',
    HOOK_MARKER,
    '# Regenerates .sidekicks/memory/{MEMORY.md,index.json,graph.json} after git rewrote the',
    '# entry files. The driver cannot do it: git merges paths in an unspecified order, so the',
    '# entries are not final while it runs. Safe to delete — every memory read also self-heals.',
    'command -v node >/dev/null 2>&1 || exit 0',
    `out=$(node ${cliRel} memory rebuild --if-stale 2>/dev/null) || exit 0`,
    '# Say so when it actually regenerated: the merge commit recorded the PRE-merge faces, so',
    '# they are now modified in the working tree and want a follow-up commit.',
    'case "$out" in',
    "  rebuilt*) printf 'sidekicks: memory faces regenerated after the merge — commit them (git add .sidekicks/memory)\\n' ;;",
    'esac',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Install the post-merge / post-rewrite hooks, never overwriting a foreign one.
 *
 * Writes to `paths.hooksDir`, which honours `core.hooksPath` — the only directory git will
 * actually run. Two consequences worth knowing before reading a diff that contains them:
 *
 *   - When `core.hooksPath` points INSIDE the working tree (this repo: `.githooks`), the hooks
 *     become ordinary repo files and show up as untracked on the first run. That is intended:
 *     they belong beside the `.githooks/pre-commit` such a repo already commits, and committing
 *     them is what gives every clone the rebuild without an install verb.
 *   - The directory is created when missing. A `core.hooksPath` naming a directory that does
 *     not exist makes git run NO hooks at all, silently, so writing the file without the
 *     mkdir would reproduce the bug this function was fixed for.
 *
 * These are plain writes rather than guarded ones: `$GIT_DIR/hooks` is git's own directory and
 * assertWritable would (correctly) refuse it, and a hooks directory chosen by config is not a
 * path the CLI-managed write surface describes either.
 *
 * @param {{ hooksDir: string }} paths
 * @param {string} cliRel
 * @returns {{ written: string[], blocked: string[] }}
 */
export function ensureHooks(paths, cliRel) {
  const written = [];
  const blocked = [];
  const want = hookBody(cliRel);
  try {
    if (!existsSync(paths.hooksDir)) mkdirSync(paths.hooksDir, { recursive: true });
  } catch {
    // Unwritable hooks directory — every hook is blocked, reported, never thrown.
    return { written, blocked: [...HOOK_NAMES] };
  }
  for (const name of HOOK_NAMES) {
    const abs = join(paths.hooksDir, name);
    try {
      if (existsSync(abs)) {
        const have = readFileSync(abs, 'utf8');
        if (!have.includes(HOOK_MARKER)) { blocked.push(name); continue; }
        if (have === want) continue;
      }
      writeFileSync(abs, want, 'utf8');
      try { chmodSync(abs, 0o755); } catch { /* Windows has no exec bit */ }
      written.push(name);
    } catch {
      blocked.push(name);
    }
  }
  return { written, blocked };
}

/**
 * Register the driver (and its hooks) if this clone does not have it yet.
 * Best-effort: every failure path returns a reason instead of throwing.
 *
 * @param {string} repoRoot
 * @param {(msg: string) => void} [log]
 * @returns {{ ok: boolean, reason?: string, installed?: boolean, hooks?: {written: string[], blocked: string[]} }}
 */
export function ensureMemoryMergeDriver(repoRoot, log = () => {}) {
  if (mergeSelfHealDisabled()) return { ok: false, reason: 'SIDEKICKS_MEMORY_MERGE=off' };
  let paths;
  try { paths = resolveGitPaths(repoRoot); } catch { return { ok: false, reason: 'no git dir' }; }
  if (!paths) return { ok: false, reason: 'not a git checkout' };

  const cliRel = cliRelPath(repoRoot);
  if (!cliRel) return { ok: false, reason: 'no bin/sidekicks to call' };

  if (isRegistered(paths.configPath)) {
    // Already registered — the hooks are cheap to keep honest, but never re-written unless
    // they are ours and stale.
    const hooks = ensureHooks(paths, cliRel);
    if (hooks.written.length) log(`memory merge: refreshed hook(s) ${hooks.written.join(', ')}`);
    return { ok: true, installed: false, hooks };
  }

  // Raw spawn rather than git-delegation's setLocalConfig: this module is imported on EVERY
  // CLI invocation for the cheap already-registered check, and pulling in git.mjs (45 KB) to
  // parse on the hot path for a call that fires once per clone is the wrong trade.
  for (const [key, value] of [
    [`merge.${DRIVER_NAME}.name`, 'Sidekicks memory store — semantic entry merge, generated faces regenerated'],
    [`merge.${DRIVER_NAME}.driver`, driverCommand(cliRel)],
  ]) {
    const r = spawnSync('git', ['config', '--local', key, value], {
      cwd: repoRoot, shell: false, encoding: 'utf8',
    });
    if (r.error || r.status !== 0) {
      return { ok: false, reason: `git config ${key} failed — ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}` };
    }
  }
  const hooks = ensureHooks(paths, cliRel);
  log(`memory merge: registered the '${DRIVER_NAME}' merge driver for this clone`);
  return { ok: true, installed: true, hooks };
}

/**
 * Drop the registration (and our hooks). The `.gitattributes` lines stay — an unregistered
 * `merge=<name>` simply falls back to git's text merge.
 *
 * @param {string} repoRoot
 * @returns {{ ok: boolean, reason?: string, removedHooks: string[] }}
 */
export function removeMemoryMergeDriver(repoRoot) {
  const paths = resolveGitPaths(repoRoot);
  if (!paths) return { ok: false, reason: 'not a git checkout', removedHooks: [] };
  let ok = true;
  let reason;
  // `--remove-section` exits 128 when the section is absent — "already gone", not a failure,
  // which is why this is a raw spawn rather than the throwing runGit wrapper.
  const r = spawnSync('git', ['config', '--local', '--remove-section', `merge.${DRIVER_NAME}`], {
    cwd: repoRoot, shell: false, encoding: 'utf8',
  });
  if (r.error || (r.status !== 0 && r.status !== 128 && r.status !== 5)) {
    ok = false;
    reason = (r.stderr || r.error?.message || `git exited ${r.status}`).trim();
  }
  const removedHooks = [];
  for (const name of HOOK_NAMES) {
    const abs = join(paths.hooksDir, name);
    try {
      if (!existsSync(abs)) continue;
      if (!readFileSync(abs, 'utf8').includes(HOOK_MARKER)) continue;
      writeFileSync(abs, `#!/bin/sh\nexit 0\n`, 'utf8');
      removedHooks.push(name);
    } catch { /* a hook we cannot rewrite is reported by status, not fatal here */ }
  }
  return { ok, reason, removedHooks };
}

/**
 * What is (and is not) wired in this clone — the shape `memory merge status` prints and
 * `memory doctor` reports on.
 *
 * `hooks` describes the directory git will really run. `strayHooks` names hooks sitting in the
 * IGNORED `$GIT_DIR/hooks` while `core.hooksPath` points elsewhere — files that look installed
 * and can never fire, which is precisely how the stale-faces bug stayed invisible.
 *
 * @param {string} repoRoot
 * @returns {{
 *   git: boolean, registered: boolean, cli: string|null, command: string|null,
 *   attributes: boolean, hooks: Array<{name: string, state: 'ours'|'foreign'|'absent'}>,
 *   hooksDir: string|null, hooksPath: string|null, strayHooks: string[],
 *   disabled: boolean,
 * }}
 */
/**
 * Does the memory store TRAVEL IN GIT in this checkout?
 *
 * The store is git-ignored by default (lib/memory-lifecycle/_sources.mjs explains the trade), and
 * every piece of merge machinery below only has a surface when git carries it: git never merges an
 * ignored path, so an unregistered driver, a missing `.gitattributes` route and a stale
 * `post-merge` hook are all findings about nothing. Reporting them anyway trains a reader to ignore
 * `memory doctor`, which is the one outcome a doctor cannot afford.
 *
 * TWO PROBES, because neither alone is the question. "Is it tracked?" is false in a repo whose
 * store is simply still empty — and registering the driver only after the first entry is committed
 * is exactly the clone that then conflicts. "Is it ignored?" is true for a moment in a repo that
 * tracks files a new ignore rule now matches, and git keeps merging those. So the store travels
 * when it is tracked OR not ignored, and only a store that is both ignored and untracked is out.
 *
 * Cached per process: at most two `git` calls, once per repo root.
 *
 * @param {string} repoRoot
 * @returns {boolean}
 */
const travelsCache = new Map();
export function storeTravelsInGit(repoRoot) {
  if (travelsCache.has(repoRoot)) return travelsCache.get(repoRoot);
  let travels = false;
  try {
    const tracked = spawnSync('git', ['ls-files', '--', STORE_REL], {
      cwd: repoRoot, shell: false, encoding: 'utf8', maxBuffer: 1024 * 1024,
    });
    if (tracked.status === 0 && (tracked.stdout ?? '').trim() !== '') {
      travels = true;
    } else {
      // `--no-index` asks about the ignore PATTERNS alone. Exit 0 = a pattern matches.
      const ignored = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', STORE_REL], {
        cwd: repoRoot, shell: false, encoding: 'utf8',
      });
      // status 0 ignored · 1 not ignored · 128 not a git repo (nothing to merge either way)
      travels = ignored.status === 1;
    }
  } catch {
    travels = false;
  }
  travelsCache.set(repoRoot, travels);
  return travels;
}

export function driverStatus(repoRoot) {
  const paths = resolveGitPaths(repoRoot);
  const cli = cliRelPath(repoRoot);
  const out = {
    git: Boolean(paths),
    registered: Boolean(paths) && isRegistered(paths.configPath),
    cli,
    command: cli ? driverCommand(cli) : null,
    attributes: false,
    hooks: [],
    hooksDir: paths ? paths.hooksDir : null,
    hooksPath: paths ? paths.hooksPathSetting : null,
    strayHooks: [],
    disabled: mergeSelfHealDisabled(),
  };
  try {
    const attrs = readFileSync(join(repoRoot, '.gitattributes'), 'utf8');
    out.attributes = new RegExp(`merge=${DRIVER_NAME}`).test(attrs);
  } catch { /* no .gitattributes — reported as attributes:false */ }
  if (paths) {
    for (const name of HOOK_NAMES) {
      const abs = join(paths.hooksDir, name);
      let state = 'absent';
      try {
        if (existsSync(abs)) {
          state = readFileSync(abs, 'utf8').includes(HOOK_MARKER) ? 'ours' : 'foreign';
        }
      } catch { state = 'foreign'; }
      out.hooks.push({ name, state });
      // Only interesting when the two directories differ: a hook in the ignored one is inert.
      if (paths.hooksDir !== paths.hooksDirDefault) {
        try {
          const stray = join(paths.hooksDirDefault, name);
          if (existsSync(stray) && readFileSync(stray, 'utf8').includes(HOOK_MARKER)) {
            out.strayHooks.push(name);
          }
        } catch { /* unreadable — not worth reporting as a stray */ }
      }
    }
  }
  return out;
}
