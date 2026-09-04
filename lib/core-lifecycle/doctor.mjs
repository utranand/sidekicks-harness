// lib/core-lifecycle/doctor.mjs
// `sidekicks core doctor [--json]`
//
// The mount's health check: every property that, when broken, breaks SILENTLY. Exits non-zero on the
// first failure so it is usable as a gate (CI, a bootstrap's last step, a command-sequence step).
//
// Each check exists because of a specific observed or reasoned failure:
//
//   marker        — without it both root resolvers stop AT the core, and hooks read the core's
//                   memory/settings as if they were the workspace's (the leak recorded in
//                   .sidekicks/memory/inherited-runtime-scripts-must-be-copied.md).
//   shim          — bin/sidekicks pointing at a path that no longer exists gives "module not found"
//                   with no hint that the mount moved.
//   entrypoint    — the core must actually carry lib/sk-cli/cli.mjs; an empty or partial
//                   submodule checkout (a clone without --recurse-submodules) looks like a mount.
//   wiring        — a hook path that bypasses the mount resolves to <workspace>/scripts/, which does
//                   not exist: the CLI reports nothing, the hook simply never runs.
//   wiring present— a wiring file the copy never produced was invisible to the check above, which
//                   only judges files that exist. Every hook in it silently never runs.
//   overlay       — zero links while the core ships skills means skill discovery is empty.
//   overlay compl.— "at least one link" stays true with twelve of thirteen missing. The exact set
//                   is the property; anything less is a hole that reads as health.
//   escaping link — a link inside the workspace resolving outside BOTH the workspace and the core is
//                   the invariant `inherit verify` enforces for a runtime, restated for a mount.
//   push guard    — an unarmed guard means an accidental push can reach the framework remote.
//   tracked ref   — the branch key is written to .gitmodules with `git config -f`, which never
//                   stages. The index copy and the worktree copy diverged, so a commit recorded a
//                   pin with no tracked ref and a fresh clone fell back to main.
//   enable map    — an unlisted entry means the committed framework.yaml no longer shows what this
//                   workspace carries (the CLAUDE.md visibility rule).
//   node          — the framework requires Node >= 20; a lower runtime fails in unrelated places.
//
// `--all` adds the component doctors — `framework doctor`, `config doctor`, `skill verify --strict`
// — run from the WORKSPACE root. Without it a publisher can (and did) record a green `core doctor`
// beside a workspace whose framework, config and skill gates all fail: the mount was sound and the
// thing installed was not. Off by default so the per-install check stays cheap.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT_OK, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import * as git from '../git-delegation/git.mjs';
import { CORE_DIR, CORE_MARKER, isInsidePath } from '../sk-cli/core-mount.mjs';
import { frameworkDrift } from '../framework-settings/materialize.mjs';
import { SETTINGS_REL_DIR } from '../framework-settings/framework-config.mjs';
import { parseCoreFlags, requireCore, inspectCore } from './_shared.mjs';
import { inspectPushGuard } from './_guard.mjs';
import { auditWiring, WIRING_FILES, WIRING_DIRS } from './_wiring.mjs';
import { countSkills } from './status.mjs';

/**
 * Every entry under `dir` that IS a link and resolves to nothing.
 *
 * The residue a trimmed core upgrade leaves behind: the overlay used to create links additively and
 * never remove them, so a skill the new core dropped kept its link, pointing into the core at a
 * directory that no longer exists.
 *
 * @param {string} dir - absolute path of <workspace>/.agents/skills
 * @returns {string[]} link NAMES, sorted — names, not paths, because the repair is per skill
 */
function danglingSkillLinks(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    let st;
    // lstat, not the Dirent type: an NTFS junction is only reliably a link through lstat.
    try { st = lstatSync(abs); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    if (!existsSync(abs)) out.push(name);   // existsSync follows the link, so this IS "resolves to nothing"
  }
  return out.sort();
}

/**
 * Every link under `dir` whose realpath escapes both the workspace and the core.
 *
 * @param {string} dir - absolute directory to walk (non-recursive beyond skill folders)
 * @param {string[]} allowedRoots - absolute paths a link may resolve inside
 * @returns {string[]} offending link paths
 */
function escapingLinks(dir, allowedRoots) {
  const out = [];
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const roots = allowedRoots.map((r) => {
    try { return realpathSync(r); } catch { return r; }
  });
  for (const d of entries) {
    const abs = join(dir, d.name);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    let real;
    // A link that resolves to NOTHING is not an escape — it is the dangling-overlay state, reported
    // by danglingSkillLinks with a repair that actually applies. Counting it here too produced two
    // findings for one cause and pointed the operator at "remove the offending link" when the real
    // answer is `core init`.
    try { real = realpathSync(abs); } catch { continue; }
    // Case-folded on Windows via the shared helper — a byte-exact compare of realpath output
    // reported healthy NTFS mounts as escaping links.
    const inside = roots.some((r) => isInsidePath(real, r));
    if (!inside) out.push(abs);
  }
  return out;
}

/**
 * Wiring the core SHIPS but the workspace does not have.
 *
 * `auditWiring` only inspects files that exist, so a wiring file the copy never produced was
 * silently clean: the hooks it carries simply never run and nothing says so. What the core ships is
 * the expectation — a CLI the core has no wiring for is not missing anything.
 *
 * @param {string} repoRoot
 * @param {string} coreDir
 * @returns {string[]} repo-relative paths, sorted
 */
function missingWiring(repoRoot, coreDir) {
  const out = [];
  for (const rel of [...WIRING_FILES, ...WIRING_DIRS]) {
    if (!existsSync(join(coreDir, rel))) continue;      // the core ships no such wiring — nothing owed
    if (!existsSync(join(repoRoot, rel))) out.push(rel.split('\\').join('/'));
  }
  return out.sort();
}

/**
 * Skills the core ships that the workspace exposes through neither a link nor a real directory.
 *
 * The `overlay` check passes on "at least one link exists", which stays true when all but one are
 * absent. This one is the exact set: every skill the core ships must be reachable at
 * `.agents/skills/<name>`, whether by the overlay link or by a workspace-authored directory
 * shadowing it (a shadow is a deliberate override, not a hole).
 *
 * @param {string} repoRoot
 * @param {string} coreDir
 * @returns {string[]} skill names, sorted
 */
function unexposedCoreSkills(repoRoot, coreDir) {
  const coreSkills = join(coreDir, '.agents', 'skills');
  if (!existsSync(coreSkills)) return [];
  let names;
  try {
    names = readdirSync(coreSkills, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const wsSkills = join(repoRoot, '.agents', 'skills');
  const out = [];
  for (const name of names) {
    const abs = join(wsSkills, name);
    // existsSync follows a link, so this is "reachable", which is the property that matters.
    if (existsSync(abs)) continue;
    out.push(name);
  }
  return out.sort();
}

/**
 * The component doctors, run from the WORKSPACE root — the thing a consumer actually installs.
 *
 * F-09: a green `core doctor` next to a failing `framework doctor` is exactly the contradiction the
 * v2.0.0 release gate shipped on, because the publisher ran only the first. Composing them is
 * opt-in (`--all`) rather than default so the cheap mount check stays cheap; the release gate uses
 * `--all`.
 *
 * @param {string} repoRoot
 * @returns {Array<{check: string, ok: boolean, detail: string, fix: string|null}>}
 */
function componentDoctors(repoRoot) {
  const cli = join(repoRoot, 'bin', 'sidekicks');
  const rows = [];
  /** @type {Array<[string, string[]]>} */
  const suite = [
    // Cheapest first, and its failure explains the others: a stale or unreachable catalog is what
    // every downstream doctor is reading. It is here at all because `catalog check` was red inside
    // every forged core and in every mounted workspace, and nothing in the composed verdict asked
    // (INC-2026-09-04-01, F-3 and its sibling).
    ['catalog check', ['catalog', 'check']],
    ['framework doctor', ['framework', 'doctor']],
    ['config doctor', ['config', 'doctor']],
    ['skill verify', ['skill', 'verify', '--strict']],
  ];
  for (const [label, args] of suite) {
    if (!existsSync(cli)) {
      rows.push({ check: label, ok: false, detail: 'bin/sidekicks is missing — cannot run it',
        fix: 'sidekicks core init' });
      continue;
    }
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: 'utf8' });
    const text = `${r.stdout || ''}${r.stderr || ''}`.trimEnd();
    const lastLine = text.split('\n').filter((l) => l.trim()).pop() || `exit ${r.status}`;
    rows.push({
      check: label,
      ok: r.status === 0,
      detail: r.status === 0 ? lastLine : `exit ${r.status}: ${lastLine}`,
      fix: r.status === 0 ? null : `sidekicks ${args.join(' ')}`,
    });
  }
  return rows;
}

/**
 * Every check that judges the MOUNT itself — the set a bare `core doctor` runs, without the
 * composed component doctors `--all` adds.
 *
 * Exported because `core update` runs it as its closing act (INC-2026-09-04-03, R-2). An update that
 * moved the mount is exactly the moment a wiring or tracked-ref fault appears, and the operator was
 * told nothing: `core update` printed a success line and stopped, so the two defects an upgrade from
 * v1.4.2 leaves behind sat there until somebody happened to run the doctor. Calling this rather than
 * spawning `core doctor` keeps one definition of the check set — a copy would drift the moment a
 * check is added here.
 *
 * @param {string} repoRoot
 * @param {string} coreDir
 * @param {object} info - the inspectCore() snapshot, so a caller that already has one pays once
 * @returns {Array<{check: string, ok: boolean, detail: string, fix: string|null}>}
 */
export function coreChecks(repoRoot, coreDir, info = inspectCore(repoRoot, coreDir)) {
  /** @type {Array<{check: string, ok: boolean, detail: string, fix: string|null}>} */
  const checks = [];
  const add = (check, ok, detail, fix = null) => checks.push({ check, ok, detail, fix });

  // marker
  add('marker', info.marker !== null,
    info.marker
      ? `${CORE_MARKER} schema ${info.marker.schema}, version ${info.marker.version || '(unset)'}`
      : `${CORE_DIR}/${CORE_MARKER} is missing or unparseable`,
    info.marker ? null : 'update the core to a build that ships the marker (sidekicks core update)');

  // entrypoint
  const entry = join(coreDir, 'lib', 'sk-cli', 'cli.mjs');
  add('entrypoint', existsSync(entry),
    existsSync(entry) ? `${CORE_DIR}/lib/sk-cli/cli.mjs present` : 'the core carries no CLI',
    existsSync(entry) ? null : `git submodule update --init ${info.coreRel}`);

  // shim
  const shimPath = join(repoRoot, 'bin', 'sidekicks');
  let shimOk = false;
  let shimDetail = 'bin/sidekicks is missing';
  if (existsSync(shimPath)) {
    const text = readFileSync(shimPath, 'utf8');
    shimOk = text.includes(`${CORE_DIR}/lib/sk-cli/cli.mjs`);
    shimDetail = shimOk ? 'bin/sidekicks forwards into the mount' : 'bin/sidekicks does not point at the mount';
  }
  add('shim', shimOk, shimDetail, shimOk ? null : 'sidekicks core init');

  // wiring
  const wiringProblems = auditWiring(repoRoot);
  add('wiring', wiringProblems.length === 0,
    wiringProblems.length === 0
      ? 'every hook path routes through the mount'
      : wiringProblems.map((p) => `${p.file}: ${p.offenders.join(', ')}`).join('; '),
    wiringProblems.length === 0 ? null : 'sidekicks core init');

  // wiring present: auditWiring only judges files that EXIST, so a wiring file the copy never
  // produced passed silently while every hook it carries never ran.
  const wiringGone = missingWiring(repoRoot, coreDir);
  add('wiring present', wiringGone.length === 0,
    wiringGone.length === 0
      ? `every wiring surface the core ships is in the workspace (${WIRING_FILES.length} file(s), ${WIRING_DIRS.length} dir(s) checked)`
      : `the core ships these but the workspace does not have them: ${wiringGone.join(', ')}`,
    wiringGone.length === 0 ? null : 'sidekicks core init');

  // overlay
  const skills = countSkills(repoRoot, coreDir);
  const overlayOk = skills.coreShips === 0 || skills.linked > 0;
  add('overlay', overlayOk,
    `${skills.linked} linked, ${skills.own} authored here, core ships ${skills.coreShips}`,
    overlayOk ? null : 'sidekicks core init');

  // overlay complete: the EXACT set, not "at least one". `overlay` above stays true with a single
  // surviving link beside twelve absent ones — which is how a trimmed upgrade looked healthy.
  const unexposed = unexposedCoreSkills(repoRoot, coreDir);
  add('overlay complete', unexposed.length === 0,
    unexposed.length === 0
      ? 'every skill the core ships is reachable under .agents/skills'
      : `${unexposed.length} core skill(s) reachable through neither a link nor a directory: ${unexposed.join(', ')}`,
    unexposed.length === 0 ? null : 'sidekicks core init');

  // dangling overlay links: an entry under .agents/skills that IS a link and resolves to nothing.
  //
  // This is the state a trimmed-core upgrade used to leave behind, and the reason it went unnoticed
  // for a whole major release is that no check looked for it: `overlay` above passes on "at least
  // one link exists", which stays true with thirteen broken ones beside it. Reported rather than
  // repaired here, because `core doctor` is read-only — the repair is `core init`, which now
  // reconciles the overlay as a set (lib/sk-cli/skill-links.mjs).
  const dangling = danglingSkillLinks(join(repoRoot, '.agents', 'skills'));
  add('overlay links resolve', dangling.length === 0,
    dangling.length === 0
      ? 'every link under .agents/skills resolves to something that exists'
      : `${dangling.length} dangling: ${dangling.join(', ')}`,
    dangling.length === 0 ? null : 'sidekicks core init');

  // escaping links
  const escapes = escapingLinks(join(repoRoot, '.agents', 'skills'), [repoRoot, coreDir]);
  add('links', escapes.length === 0,
    escapes.length === 0
      ? 'no link under .agents/skills escapes the workspace or the core'
      : escapes.map((p) => relative(repoRoot, p)).join(', '),
    escapes.length === 0 ? null : 'remove the offending link, then sidekicks core init');

  // push guard
  const guard = inspectPushGuard(coreDir);
  const guardBits = [
    guard.pushUrl ? 'push-url' : 'push-url MISSING',
    guard.pushDefault ? 'push.default' : 'push.default MISSING',
    guard.hook ? 'pre-push hook' : 'pre-push hook MISSING',
  ];
  add('push guard', guard.armed, guardBits.join(', '), guard.armed ? null : 'sidekicks core init');

  // core worktree: tracked modifications only. Untracked residue is normal and never blocks.
  add('core worktree', !info.dirty,
    info.dirty
      ? 'the core has modified TRACKED files — it is meant to be read-only'
      : `clean${info.untracked ? ` (${info.untracked} untracked file(s), which is fine)` : ''}`,
    info.dirty ? `git -C ${info.coreRel} status` : null);

  // tracked ref: the INDEX copy of .gitmodules must agree with the worktree copy.
  //
  // `git config -f .gitmodules` writes a file; `git submodule add` staged that file BEFORE the branch
  // key existed. So the two copies diverged silently and `git commit` recorded a pin with no tracked
  // ref — a fresh clone then read nothing and `core update` fell back to main, retargeting the
  // workspace to a version it never asked for (INC-2026-09-04-02, N-2).
  //
  // Absent from BOTH is fine and must stay fine: a mount made with a bare `git submodule add` has no
  // branch key anywhere, which is "nothing recorded", not disagreement. Only a difference is a fault.
  const refOnDisk = git.submoduleBranch(repoRoot, info.coreRel);
  const refInIndex = git.submoduleBranchInIndex(repoRoot, info.coreRel);
  add('tracked ref', refOnDisk === refInIndex,
    refOnDisk === refInIndex
      ? (refOnDisk
        ? `.gitmodules records '${refOnDisk}' in both the index and the worktree`
        : 'no branch key recorded (the ladder falls through to main)')
      : `.gitmodules disagrees with itself — worktree ${refOnDisk ? `'${refOnDisk}'` : '(unset)'}, `
        + `index ${refInIndex ? `'${refInIndex}'` : '(unset)'}; a commit would record the index copy`,
    refOnDisk === refInIndex ? null : 'git add .gitmodules');

  // enable map
  let sync = null;
  try { sync = frameworkDrift(repoRoot); } catch { /* reported below */ }
  add('enable map', sync ? sync.missing.length === 0 : false,
    sync
      ? `${sync.listed.length}/${sync.toggleable} entries listed in ${SETTINGS_REL_DIR}/`
        + (sync.missing.length ? `; unlisted: ${sync.missing.join(', ')}` : '')
      : 'the framework registry could not be read',
    sync && sync.missing.length === 0 ? null : 'sidekicks framework sync');

  // node
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20, `node ${process.versions.node}`,
    major >= 20 ? null : 'install Node 20 or newer');

  return checks;
}

/**
 * Run `core doctor`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseCoreFlags(ctx.argv, ['json', 'all']);

  const coreDir = requireCore(repoRoot, 'core doctor');
  const info = inspectCore(repoRoot, coreDir);

  const checks = coreChecks(repoRoot, coreDir, info);

  // --all: the composed release gate. Everything above judges the mount; these judge whether the
  // WORKSPACE the mount produced is actually healthy, which is the question a publisher must ask.
  if (flags.all) {
    for (const row of componentDoctors(repoRoot)) checks.push(row);
  }

  const failed = checks.filter((c) => !c.ok);

  if (flags.json) {
    const payload = { ok: failed.length === 0, path: info.coreRel, composed: Boolean(flags.all), checks };
    return {
      stdout: JSON.stringify(payload, null, 2) + '\n',
      exitCode: failed.length === 0 ? EXIT_OK : EXIT_VALIDATION,
    };
  }

  const width = Math.max(...checks.map((c) => c.check.length));
  const out = [`core doctor: ${info.coreRel}${flags.all ? ' (--all: component doctors composed)' : ''}`];
  for (const c of checks) {
    out.push(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.check.padEnd(width)}  ${c.detail}`);
    if (!c.ok && c.fix) out.push(`        ${' '.repeat(width)}  fix: ${c.fix}`);
  }
  out.push('');
  out.push(failed.length === 0
    ? `core doctor: ${checks.length} checks passed`
    : `core doctor: ${failed.length} of ${checks.length} checks FAILED`);

  return {
    stdout: out.join('\n') + '\n',
    exitCode: failed.length === 0 ? EXIT_OK : EXIT_VALIDATION,
  };
}
