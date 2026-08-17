// lib/core-lifecycle/_shared.mjs
// Shared helpers for the `sidekicks core …` verbs — the namespace that manages a framework core
// mounted as a git submodule at <workspace>/.sidekicks-core/ (AAP-110).
//
// The distinction from the `framework` namespace matters: `framework …` operates the enable map
// (which rules/criteria/hooks are on). `core …` operates the MOUNT — is a core there, at which ref,
// is it pushable, is the workspace wired to it.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SidekicksError, EXIT_USAGE, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { CORE_DIR, CORE_MARKER, coreDirOf, readCoreMarker } from '../sk-cli/core-mount.mjs';
import * as git from '../git-delegation/git.mjs';
import { discoverPacks } from '../agent-lifecycle/_pack.mjs';

export { CORE_DIR, CORE_MARKER };

/** Push url written into a mounted core so an accidental `git push` cannot reach the real remote. */
export const NO_PUSH_URL = 'no-push://sidekicks-core-is-read-only';

/**
 * Parse `--flag`, `--flag=value` and `--flag value` out of a raw argv slice.
 * Same shape as lib/framework-lifecycle/_shared.mjs parseFrameworkFlags — the CLI's global parseArgs
 * runs with strict:false, so verb-local flags are re-read here where their value/boolean nature is
 * known.
 *
 * @param {string[]} argv
 * @param {string[]} booleans - flags that never take a value
 * @returns {Record<string, string|boolean>}
 */
export function parseCoreFlags(argv, booleans = []) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  const boolSet = new Set(booleans);
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string' || !tok.startsWith('--')) continue;
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      const key = body.slice(0, eq);
      out[key] = boolSet.has(key) ? true : body.slice(eq + 1);
      continue;
    }
    if (boolSet.has(body)) {
      out[body] = true;
      continue;
    }
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[body] = next;
      i++;
    } else {
      out[body] = '';
    }
  }
  return out;
}

/**
 * Resolve the mounted core, or throw a message that says how to get one.
 *
 * @param {string} repoRoot
 * @param {string} verb - e.g. 'core status'
 * @returns {string} absolute path of the core checkout
 * @throws {SidekicksError(EXIT_VALIDATION)} when nothing is mounted
 */
export function requireCore(repoRoot, verb) {
  const dir = coreDirOf(repoRoot);
  if (dir) return dir;

  const present = existsSync(join(repoRoot, CORE_DIR));
  const detail = present
    ? `${CORE_DIR}/ exists but carries no ${CORE_MARKER} — it is not a framework core checkout`
    : `no framework core is mounted at ${CORE_DIR}/`;

  throw new SidekicksError(
    `${verb}: ${detail}.\n`
    + 'Mount one with:\n'
    + `  git submodule add <framework-remote> ${CORE_DIR}\n`
    + '  git submodule update --init\n'
    + `  node ${CORE_DIR}/bin/sidekicks core init`,
    EXIT_VALIDATION
  );
}

/**
 * Everything the `core` verbs report about a mount, gathered once.
 *
 * Every git read here is non-throwing: `core status` and `core doctor` must describe a broken mount
 * rather than die on it.
 *
 * @param {string} repoRoot
 * @param {string} coreDir
 * @returns {{
 *   coreDir: string, coreRel: string, marker: object|null,
 *   head: string|null, branch: string|null, describe: string|null,
 *   fetchUrl: string|null, pushUrl: string|null,
 *   upstream: {ahead: number, behind: number}|null,
 *   dirty: boolean, untracked: number, gitDir: string|null,
 * }}
 */
export function inspectCore(repoRoot, coreDir) {
  const head = git.revParse(coreDir, 'HEAD');
  let branch = null;
  try {
    branch = git.currentBranch(coreDir);
  } catch { /* detached HEAD or not a repo — reported as null */ }

  const trackingBranch = branch && branch !== 'HEAD' ? branch : null;
  const upstream = trackingBranch
    ? git.aheadBehind(coreDir, 'HEAD', `origin/${trackingBranch}`)
    : null;

  // `dirty` means TRACKED modifications only. Untracked residue (a skill's __pycache__, a built
  // .venv) is normal in a consumer checkout, is never discarded by a checkout, and must not read as
  // "someone is editing the core".
  const state = git.worktreeState(coreDir);

  return {
    coreDir,
    coreRel: relative(repoRoot, coreDir).split(sep).join('/'),
    marker: readCoreMarker(coreDir),
    head,
    branch,
    describe: describeExact(coreDir),
    fetchUrl: git.remoteUrl(coreDir, 'origin'),
    pushUrl: pushUrlOf(coreDir),
    upstream,
    dirty: state.tracked.length > 0,
    untracked: state.untracked.length,
    gitDir: git.gitDir(coreDir),
  };
}

/**
 * The tag HEAD points at exactly, or null. Used so `core status` can say "v1.2.0" instead of a SHA.
 *
 * @param {string} coreDir
 * @returns {string|null}
 */
function describeExact(coreDir) {
  const res = git._spawnSync('git', ['describe', '--tags', '--exact-match'], {
    shell: false,
    cwd: coreDir,
    encoding: 'utf8',
  });
  if (res.error || res.status !== 0) return null;
  const tag = (res.stdout || '').trim();
  return tag || null;
}

/**
 * The PUSH url of origin, which may differ from the fetch url (that is the point of the guard).
 *
 * @param {string} coreDir
 * @returns {string|null}
 */
export function pushUrlOf(coreDir) {
  const res = git._spawnSync('git', ['remote', 'get-url', '--push', 'origin'], {
    shell: false,
    cwd: coreDir,
    encoding: 'utf8',
  });
  if (res.error || res.status !== 0) return null;
  const url = (res.stdout || '').trim();
  return url || null;
}

/**
 * Short SHA for display, or '(none)'.
 *
 * @param {string|null} sha
 * @returns {string}
 */
export function shortSha(sha) {
  return sha ? sha.slice(0, 7) : '(none)';
}

/**
 * Reject an empty required positional.
 *
 * @param {string|undefined} value
 * @param {string} verb
 * @param {string} name
 * @returns {string}
 */
export function requirePositional(value, verb, name) {
  if (!value) {
    throw new SidekicksError(`${verb}: missing required argument ${name}`, EXIT_USAGE);
  }
  return value;
}

/**
 * How many optional agent packs are visible, and the one line `core init` / `core update` say
 * about them.
 *
 * A HINT, and nothing more. `core init` and `core update` must never create an agent: they run
 * unattended (an update in particular), and an agent is a thing that acts — installing one on the
 * user's behalf is the difference between shipping a capability and switching it on for somebody
 * who never asked. So the whole integration between the core lifecycle and agent packs is this
 * function: count them, name the verb, write nothing.
 *
 * Deliberately best-effort. A malformed pack must never fail an init — the packs are optional and
 * `agent pack list` is where their problems belong.
 *
 * @param {string} repoRoot
 * @returns {{count: number, line: string|null}}
 */
export function agentPackHint(repoRoot) {
  let packs = [];
  try {
    packs = discoverPacks(repoRoot);
  } catch {
    return { count: 0, line: null };            // swallowed on purpose — see above
  }
  if (!packs.length) return { count: 0, line: null };
  return {
    count: packs.length,
    line: `${packs.length} optional agent pack(s) available and NOT installed — `
      + "run 'sidekicks agent pack list' (nothing here creates an agent)",
  };
}
