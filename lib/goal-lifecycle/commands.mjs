// lib/goal-lifecycle/commands.mjs
// Shared plumbing for the `sidekicks goal` verbs: run ids, run-folder resolution, flag parsing, and
// the write-owner / branch-safety probe every dispatch has to pass.
//
// FLAG PARSING IS LOCAL, AND THAT IS NOT AN OVERSIGHT. The dispatcher calls `parseArgs` with
// booleans only and `strict: false`, so `--digest <sha>` arrives as `{digest: true}` plus a stray
// positional `<sha>`, while `--digest=<sha>` arrives as a string. A verb that reads `ctx.flags`
// therefore WORKS in one spelling and silently breaks in the other — no error, just a boolean where
// a 64-character digest was expected. Every valued flag on every goal verb is read from `ctx.argv`
// by the parser below, and every one has a test in both spellings.
//
// THE WRITE-OWNER PROBE IS A SAFETY GATE, NOT A CONVENIENCE. Before the first implementation attempt
// the engine has to know which Git checkouts will receive an intentional write, what branch each is
// on, and whether anything else is live in them. A protected branch, an unsafe dirty tree, or a
// target that no longer matches the approved envelope moves the run to `needs_user`. The engine never
// switches a branch, never stashes, never resets, and never creates a worktree — those are the
// operator's calls, and a run that cannot proceed says so instead of making one of them.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveRunBase } from '../active-scope/run-base.mjs';
import { EXIT_NOT_FOUND, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { bangkokTimestamp } from '../run-events/store.mjs';
import { goalPaths, readRunState } from './store.mjs';

/**
 * The skill identity the goal engine's runs anchor under.
 *
 * Deliberately the EXISTING orchestrator identity rather than a new one: it is already in the
 * run-event schema's frozen `ENGINES` list, so the version-1 event contract stays valid, and its
 * facet (`cli-orchestrator`) is where an operator already looks for orchestrated runs.
 */
export const GOAL_SKILL_ID = 'sk-cli-orchestrator';

/**
 * Branches that never receive implementation work directly.
 *
 * `release/*` is matched by prefix. This list is the framework's, not this module's invention — it
 * is the same set the branch-safety rule and its pre-flight hook enforce.
 */
export const PROTECTED_BRANCHES = Object.freeze(['main', 'master', 'sit', 'uat', 'staging', 'prod', 'production']);

/**
 * Is `branch` protected from direct implementation work?
 *
 * @param {string|null} branch
 * @returns {boolean}
 */
export function isProtectedBranch(branch) {
  if (!branch) return false;
  const b = String(branch).trim();
  if (PROTECTED_BRANCHES.includes(b)) return true;
  return b.startsWith('release/');
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/**
 * Parse `--key value`, `--key=value` and `--flag` out of a raw argv.
 *
 * A LOCAL copy, matching the per-lifecycle convention in this repo (catalog-, check-, scope-lifecycle
 * and run-events each carry one): `package transfer` ships lib subsystems by import closure, so a
 * cross-subsystem import for six lines of parsing would drag a whole unrelated subsystem into every
 * bundle that includes this one.
 *
 * @param {string[]} argv
 * @param {string[]} booleans - keys that take no value
 * @returns {Record<string, string|boolean>}
 */
export function parseGoalFlags(argv, booleans = []) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  const boolSet = new Set(booleans);
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const tok = list[i];
    if (typeof tok !== 'string' || !tok.startsWith('--')) continue;
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      const key = body.slice(0, eq);
      out[key] = boolSet.has(key) ? true : body.slice(eq + 1);
      continue;
    }
    if (boolSet.has(body)) { out[body] = true; continue; }
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[body] = next; i += 1; }
    else { out[body] = ''; }
  }
  return out;
}

/**
 * Positionals after `goal <verb>`, with every flag and flag VALUE removed.
 *
 * The value-stripping is the part that matters: because the dispatcher treats `--digest` as a
 * boolean, its value is sitting in the positional list, and a verb reading `positionals[0]` as a run
 * id would pick up a digest instead.
 *
 * @param {string[]} argv
 * @param {string[]} booleans
 * @returns {string[]}
 */
export function goalPositionals(argv, booleans = []) {
  const boolSet = new Set(booleans);
  /** @type {string[]} */
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      if (body.includes('=') || boolSet.has(body)) continue;
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('--')) i += 1; // swallow the value
      continue;
    }
    out.push(tok);
  }
  // Drop the namespace and verb.
  return out.slice(2);
}

/**
 * A flag's value as a trimmed non-empty string, or ''.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function flagString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// ---------------------------------------------------------------------------
// Run identity and location
// ---------------------------------------------------------------------------

/** Run ids are slug-safe (they become a work-item path segment) and sort chronologically. */
const RUN_ID_RE = /^goal-\d{8}-\d{6}-[0-9a-f]{4}$/;

/**
 * Mint a run id.
 *
 * Chronological, so `ls` on the runs root is a history; suffixed with four random hex characters,
 * because two runs started in the same second must not collide on a directory name.
 *
 * @param {{now?: () => number, rand?: () => string}} [opts]
 * @returns {string}
 */
export function newRunId(opts = {}) {
  const now = opts.now || Date.now;
  // The Bangkok stamp, reduced to digits: 2026-08-21T14:30:12+07:00 → 20260821-143012.
  const stamp = bangkokTimestamp(now()).replace(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
  const rand = opts.rand ? opts.rand() : Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `goal-${stamp}-${rand}`;
}

/**
 * Validate a run id supplied on the command line.
 *
 * @param {string} runId
 * @returns {string}
 * @throws {SidekicksError} EXIT_VALIDATION
 */
export function assertRunId(runId) {
  if (!RUN_ID_RE.test(String(runId || ''))) {
    throw new SidekicksError(
      `goal: '${runId}' is not a run id (expected goal-YYYYMMDD-HHMMSS-xxxx) — 'goal status' with no `
      + 'id lists the runs in this scope',
      EXIT_VALIDATION,
    );
  }
  return runId;
}

/**
 * Resolve the run folder for a run id in the active scope.
 *
 * The join itself lives in `resolveRunBase` — the ONE place runs-layout v2 is implemented — so this
 * function only supplies the work item (the run id) and the skill identity.
 *
 * @param {string} repoRoot
 * @param {string} runId
 * @returns {{runDir: string, runsRoot: string, project: string, service: string|null}}
 */
export function resolveGoalRunDir(repoRoot, runId) {
  const settings = readSettings(repoRoot);
  const r = resolveRunBase(settings, repoRoot, {
    skillId: GOAL_SKILL_ID,
    workItem: runId,
    bare: false,
  });
  return { runDir: r.runBase, runsRoot: r.runsRoot, project: r.projectName, service: r.serviceName };
}

/**
 * Load an existing run: its folder and its authoritative state.
 *
 * @param {string} repoRoot
 * @param {string} runId
 * @returns {{runDir: string, state: object, project: string, service: string|null}}
 * @throws {SidekicksError} EXIT_NOT_FOUND
 */
export function loadRun(repoRoot, runId) {
  assertRunId(runId);
  const { runDir, project, service } = resolveGoalRunDir(repoRoot, runId);
  if (!existsSync(goalPaths(runDir).state)) {
    throw new SidekicksError(
      `goal: no run '${runId}' in this scope (looked for ${RELATIVE(repoRoot, runDir)}) — 'goal status' `
      + 'with no id lists what is here',
      EXIT_NOT_FOUND,
    );
  }
  return { runDir, state: readRunState(runDir), project, service };
}

/**
 * Every goal run in the active scope, newest first.
 *
 * Scan-on-read, deliberately: a derived index would be one more thing to rebuild, and a runs root
 * holds tens of entries, not thousands.
 *
 * @param {string} repoRoot
 * @returns {{run_id: string, run_dir: string, phase: string, updated_at: string|null}[]}
 */
export function listGoalRuns(repoRoot) {
  const { runsRoot } = resolveGoalRunDir(repoRoot, 'goal-19700101-000000-0000');
  if (!existsSync(runsRoot)) return [];
  /** @type {{run_id: string, run_dir: string, phase: string, updated_at: string|null}[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!RUN_ID_RE.test(entry.name)) continue;
    const runDir = join(runsRoot, entry.name, 'cli-orchestrator');
    if (!existsSync(goalPaths(runDir).state)) continue;
    try {
      const state = readRunState(runDir);
      out.push({
        run_id: entry.name,
        run_dir: RELATIVE(repoRoot, runDir),
        phase: String(state.phase ?? 'unknown'),
        updated_at: state.updated_at ?? null,
      });
    } catch {
      out.push({ run_id: entry.name, run_dir: RELATIVE(repoRoot, runDir), phase: 'unreadable', updated_at: null });
    }
  }
  return out.sort((a, b) => (a.run_id < b.run_id ? 1 : -1));
}

/**
 * A repo-relative, POSIX-separator path — the ONLY form persisted into an artifact.
 *
 * Named in shouting case because it is used as an assertion as much as a conversion: anywhere this
 * appears, an absolute path was about to be written and was not.
 *
 * @param {string} repoRoot
 * @param {string} abs
 * @returns {string}
 */
export function RELATIVE(repoRoot, abs) {
  const rel = relative(repoRoot, abs).split(sep).join('/');
  return rel === '' ? '.' : rel;
}

// ---------------------------------------------------------------------------
// Git write owners
// ---------------------------------------------------------------------------

/**
 * Run a short git probe. `spawnSync` is correct here and nowhere else in this engine: these are
 * sub-millisecond local reads with no model on the other end.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string|null} trimmed stdout, or null when git failed
 */
function git(cwd, args) {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout ?? '').trim();
  } catch {
    return null;
  }
}

/**
 * The nearest enclosing Git checkout of `absPath`, or null.
 *
 * For a path that does not exist yet (a file a node will CREATE) the walk starts at its nearest
 * existing parent — which is the whole point: the owner of a write is decided before the write.
 *
 * @param {string} absPath
 * @returns {string|null}
 */
export function nearestCheckout(absPath) {
  let dir = absPath;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    return null;
  }
  for (;;) {
    // `.git` is a directory in a normal clone and a FILE in a worktree or submodule — both count.
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the DISTINCT Git checkouts a set of repo-relative paths would write into, with the live
 * state of each.
 *
 * Live git state is authoritative, not configuration: an index or a manifest can say which repo owns
 * a path, but only `git branch --show-current` knows what is checked out right now.
 *
 * @param {string} repoRoot
 * @param {string[]} repoRelativePaths
 * @returns {{path: string, abs: string, branch: string|null, head: string|null,
 *            dirty_tracked: string[], protected: boolean}[]}
 */
export function resolveWriteOwners(repoRoot, repoRelativePaths) {
  /** @type {Map<string, object>} */
  const owners = new Map();
  for (const rel of repoRelativePaths) {
    const abs = isAbsolute(rel) ? rel : resolvePath(repoRoot, rel);
    const checkout = nearestCheckout(abs);
    if (checkout === null) continue;
    if (owners.has(checkout)) continue;
    const branch = git(checkout, ['branch', '--show-current']);
    const head = git(checkout, ['rev-parse', 'HEAD']);
    const status = git(checkout, ['status', '--porcelain']) ?? '';
    // A dirty SUBMODULE gitlink is not an intentional write by this run — it is the enclosing repo
    // observing that a nested checkout moved. Only tracked file changes count as someone else's
    // work in progress.
    const dirtyTracked = status
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('??'))
      .map((l) => l.replace(/^..\s+/, ''));
    owners.set(checkout, {
      path: RELATIVE(repoRoot, checkout),
      abs: checkout,
      branch,
      head,
      dirty_tracked: dirtyTracked,
      protected: isProtectedBranch(branch),
    });
  }
  return [...owners.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * The dirty-tracked-file baseline, captured once at approval time.
 *
 * WHY A BASELINE AND NOT "IS THE TREE DIRTY". Because the run's own attempts make it dirty. Checking
 * for modified tracked files before every attempt — which is what a naive gate does — means the first
 * attempt's own uncommitted change blocks the second one, and the engine deadlocks against itself
 * with a message blaming the operator. So "someone else's work" is defined as what was already
 * modified when the operator approved the run, and that set is frozen then.
 *
 * @param {string} repoRoot
 * @param {object[]} owners - from resolveWriteOwners
 * @returns {Record<string, string[]>} owner path → the tracked files already modified there
 */
export function captureDirtyBaseline(repoRoot, owners) {
  /** @type {Record<string, string[]>} */
  const baseline = {};
  for (const owner of owners) baseline[owner.path] = [...owner.dirty_tracked];
  return baseline;
}

/**
 * Decide whether implementation may proceed against these owners.
 *
 * Returns findings rather than throwing, because the caller's response is a state transition to
 * `needs_user` with the reasons recorded — not an exception that loses them.
 *
 * `notes` are things worth reporting that do NOT block: a tracked file that became dirty AFTER
 * approval is almost always this run's own work, and refusing to continue on it would stop the engine
 * on its own output. It is still surfaced, because the one case where it is not ours — another session
 * editing the same checkout mid-run — is worth an operator seeing.
 *
 * @param {object[]} owners - from resolveWriteOwners
 * @param {{expected?: {path: string, branch: string, base_commit: string}[],
 *          baseline?: Record<string, string[]>|null}} [opts]
 * @returns {{ok: boolean, findings: string[], notes: string[]}}
 */
export function assessWriteOwners(owners, opts = {}) {
  /** @type {string[]} */
  const findings = [];
  /** @type {string[]} */
  const notes = [];
  const baseline = opts.baseline ?? null;

  for (const owner of owners) {
    if (owner.branch === null) {
      findings.push(
        `${owner.path}: HEAD is detached or git could not report a branch — implementation needs a `
        + 'named work branch',
      );
      continue;
    }
    if (owner.protected) {
      findings.push(
        `${owner.path}: on protected branch '${owner.branch}' — implementation work never lands there `
        + 'directly. Create a work branch (<type>/<slug>) yourself; the engine will not switch, stash '
        + 'or create a worktree on your behalf.',
      );
    }

    if (owner.dirty_tracked.length === 0) continue;

    if (baseline === null) {
      // No baseline yet — this is the pre-approval check, where every modified tracked file is
      // someone else's by definition.
      findings.push(
        `${owner.path}: ${owner.dirty_tracked.length} tracked file(s) already modified `
        + `(${owner.dirty_tracked.slice(0, 3).join(', ')}${owner.dirty_tracked.length > 3 ? ', …' : ''}) — `
        + 'that work is not this run\'s and will not be touched. Commit or set it aside first.',
      );
      continue;
    }

    const preExisting = baseline[owner.path] ?? [];
    const stillForeign = owner.dirty_tracked.filter((f) => preExisting.includes(f));
    const sinceApproval = owner.dirty_tracked.filter((f) => !preExisting.includes(f));

    if (stillForeign.length > 0) {
      findings.push(
        `${owner.path}: ${stillForeign.length} tracked file(s) were already modified when this run was `
        + `approved (${stillForeign.slice(0, 3).join(', ')}${stillForeign.length > 3 ? ', …' : ''}) — `
        + 'that work is not this run\'s and will not be touched. Commit or set it aside first.',
      );
    }
    if (sinceApproval.length > 0) {
      notes.push(
        `${owner.path}: ${sinceApproval.length} tracked file(s) changed since approval `
        + `(${sinceApproval.slice(0, 3).join(', ')}${sinceApproval.length > 3 ? ', …' : ''}) — expected, `
        + 'these are this run\'s own attempts',
      );
    }
  }

  // Drift against what was approved. The envelope bound a branch and a base commit per checkout; if
  // either moved, the approval was granted against a different starting point.
  for (const expected of opts.expected || []) {
    const owner = owners.find((o) => o.path === expected.path);
    if (!owner) {
      findings.push(`${expected.path}: bound by the approved envelope but no longer resolves to a checkout`);
      continue;
    }
    if (owner.branch !== expected.branch) {
      findings.push(
        `${expected.path}: approved on branch '${expected.branch}' but now on '${owner.branch}' — the `
        + 'approval was granted against a different starting point',
      );
    }
  }

  return { ok: findings.length === 0, findings, notes };
}

/**
 * Assemble the canonical approval envelope from live state plus an approved-shape plan.
 *
 * This is where "what the user approves" is actually decided, so each derivation is deliberate:
 *
 * - `checkouts` comes from resolving every node's `affected_paths` to its owning Git checkout and
 *   reading the branch and HEAD that are there RIGHT NOW. Binding the live commit is what makes a
 *   later branch move detectable as drift rather than absorbed silently.
 * - `write_roots` is derived from the affected paths too, collapsed to their common directories, so
 *   the approval says which parts of the tree may change — not merely which files the plan happened
 *   to name.
 * - `routing` is copied per node from the plan. Approving a plan approves WHO runs it: swapping a
 *   mid-tier implementer for a top-tier one is a cost and blast-radius change, so it invalidates.
 *
 * @param {{repoRoot: string, plan: object, goalDigest: string, planDigest: string,
 *          scope: {project: string, service: string|null}, budgets: object, actionPolicy: object,
 *          criterionOwners: Record<string, string>, familyOf?: (n: string) => string|null}} input
 * @returns {{envelope: object, owners: object[]}}
 */
export function assembleEnvelope(input) {
  const nodes = Array.isArray(input.plan?.nodes) ? input.plan.nodes : [];
  const affected = [...new Set(nodes.flatMap((n) => (Array.isArray(n.affected_paths) ? n.affected_paths : [])))];
  const owners = resolveWriteOwners(input.repoRoot, affected);

  const envelope = {
    schema_version: 1,
    goal_digest: input.goalDigest,
    plan_digest: input.planDigest,
    scope: input.scope,
    checkouts: owners.map((o) => ({
      path: o.path,
      branch: o.branch ?? '(detached)',
      base_commit: o.head ?? '0000000',
    })),
    write_roots: deriveWriteRoots(affected),
    routing: nodes.map((n) => ({
      node: n.id,
      executor: n.executor,
      family: input.familyOf ? (input.familyOf(n.executor) ?? '') : '',
      tier: n.tier,
      role: 'implement',
    })),
    budgets: input.budgets,
    action_policy: input.actionPolicy,
    criterion_owners: input.criterionOwners,
  };
  return { envelope, owners };
}

/**
 * The minimal set of directory roots covering every affected path.
 *
 * Minimal, not exhaustive: a root that is a prefix of another absorbs it, so approving
 * `lib/goal-lifecycle` does not also need every file under it listed. A path at the repo root
 * collapses to `.` — which is honest about how wide that approval is, rather than hiding a
 * repo-wide write behind a long file list.
 *
 * @param {string[]} paths - repo-relative
 * @returns {string[]} sorted
 */
export function deriveWriteRoots(paths) {
  const dirs = new Set();
  for (const p of paths) {
    const posix = String(p).split('\\').join('/');
    const parts = posix.split('/').filter((s) => s !== '' && s !== '.');
    if (parts.length <= 1) { dirs.add('.'); continue; }
    // A path's directory is its write root; a bare top-level directory stays itself.
    dirs.add(parts.slice(0, -1).join('/'));
  }
  const list = [...dirs].sort();
  // Collapse anything contained by a shorter root already in the list.
  return list.filter((d) => !list.some((other) => other !== d && (other === '.' || d.startsWith(`${other}/`))));
}

/**
 * Assert a run is in one of the phases a verb accepts, with a message that says what to do instead.
 *
 * @param {object} state
 * @param {string[]} allowed
 * @param {string} verb
 * @throws {SidekicksError} EXIT_USAGE
 */
export function assertPhase(state, allowed, verb) {
  if (allowed.includes(state.phase)) return;
  throw new SidekicksError(
    `goal ${verb}: run is in phase '${state.phase}', which this verb does not act on `
    + `(expects ${allowed.join(' | ')}). 'goal status ${state.run_id}' explains where it is.`,
    EXIT_USAGE,
  );
}
