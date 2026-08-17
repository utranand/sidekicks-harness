// lib/core-lifecycle/_derive.mjs
// Everything in a workspace that is DERIVED from the mounted core, in one place.
//
// Why one place: `core init` and `core update` must apply exactly the same set. When they did not, a
// new framework skill arriving via `core update` got its overlay link created but never added to the
// managed .gitignore block — so the link showed up as a file to commit, which is the opposite of the
// rule that overlay links never travel. Any future derived surface is added here once and both verbs
// inherit it.
//
// Everything here is idempotent and safe to re-run: that is what makes `core update` unattended-safe.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { ensureCoreSkillOverlay, ensureSkillLinks } from '../sk-cli/skill-links.mjs';
import { materializeFramework } from '../framework-settings/materialize.mjs';
import { armPushGuard } from './_guard.mjs';
import { applyWiring } from './_wiring.mjs';
import {
  BLOCK_BEGIN, BLOCK_END, WORKSPACE_IGNORE, coreSkillIgnoreLines, upsertBlock,
} from './_seed.mjs';
import { countSkills } from './status.mjs';

/**
 * Names of the skill directories the core ships.
 *
 * @param {string} coreDir
 * @returns {string[]}
 */
export function coreSkillNames(coreDir) {
  const dir = join(coreDir, '.agents', 'skills');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Names under <workspace>/.agents/skills that are LINKS into the core.
 *
 * Read back from disk rather than derived from the core's skill list, because the two differ exactly
 * where it matters: a workspace-authored skill shadowing a core skill of the same name is a real
 * directory here, and must stay committable.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function overlayLinkNames(repoRoot) {
  const dir = join(repoRoot, '.agents', 'skills');
  if (!existsSync(dir)) return [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  // lstat per entry, NOT readdirSync's Dirent type. On Windows an overlay link is an NTFS junction —
  // a directory carrying a reparse point — and junctions are only reliably reported as links through
  // lstat (the same caveat skill-links.mjs notes). Trusting the dirent type would drop junctions from
  // this list, the managed .gitignore block would stop excluding them, and the next `git add -A` would
  // commit the framework core's skill tree into the workspace's own history.
  return names.filter((name) => {
    try {
      return lstatSync(join(dir, name)).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

/**
 * Insert or refresh the managed .gitignore block, including one ignore line per overlay link.
 *
 * @param {string} repoRoot
 * @param {string[]} linkNames - overlay link names (see overlayLinkNames)
 * @returns {{changed: boolean, action: string}}
 */
export function applyGitignore(repoRoot, linkNames) {
  const path = join(repoRoot, '.gitignore');
  const block = [
    `# ${BLOCK_BEGIN}`,
    ...WORKSPACE_IGNORE,
    ...coreSkillIgnoreLines(linkNames),
    `# ${BLOCK_END}`,
  ].join('\n');

  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { /* absent */ }

  const res = upsertBlock(text, block, 'bottom');
  if (res.changed) writeAtomic(path, res.text);
  return { changed: res.changed, action: res.action };
}

/**
 * Re-apply every workspace surface derived from the core.
 *
 * @param {string} repoRoot
 * @param {string} coreDir
 * @param {(msg: string) => void} [log]
 * @returns {{
 *   skills: {linked: number, own: number, coreShips: number}, repaired: number,
 *   wiring: {files: string[], dirs: string[], skipped: string[]},
 *   gitignore: {changed: boolean, action: string},
 *   sync: {added: string[], pruned: string[]}|null,
 *   guard: {pushUrl: boolean, pushDefault: boolean, hook: boolean, errors: string[]},
 *   notes: string[],
 * }}
 */
export function applyDerived(repoRoot, coreDir, log = () => {}) {
  const notes = [];

  // Wiring first: it is the only surface that can fail loudly, and a workspace with hooks pointing at
  // nothing is worse than one with a stale ignore block.
  const wiring = applyWiring(repoRoot, coreDir);
  if (wiring.skipped.length) {
    notes.push(`the core ships no ${wiring.skipped.join(', ')} — those CLIs are unwired here`);
  }

  // Overlay BEFORE the ignore block, and the ordering is now load-bearing in BOTH directions: the
  // block enumerates the links that exist, so a link created here appears in it and a link PRUNED
  // here disappears from it, with no separate bookkeeping.
  //
  // `prune: true` is passed only from this function — never from the per-invocation self-heal in
  // cli.mjs. Reconciliation is what an upgrade needs (a trimmed core left 13 dangling links behind,
  // and re-running `core init` could not clear them because the overlay step was additive only), and
  // it is also the one part of the overlay that DELETES. Confining it to init/update means it only
  // ever runs where a rollback exists: `core update` restores the previous SHA and re-runs
  // applyDerived, which recreates from the old core's dir listing. Prune-then-recreate is
  // self-healing here; on the ambient path it would have no recovery at all.
  const repaired = ensureCoreSkillOverlay(repoRoot, log, { prune: true });
  ensureSkillLinks(repoRoot, log);

  // Read AFTER the overlay pass so pruned names are already gone from the enumeration.
  const gitignore = applyGitignore(repoRoot, overlayLinkNames(repoRoot));

  // The enable map must describe THIS workspace's registry (core skills + the workspace's own), not
  // the set the core was built with.
  let sync = null;
  try {
    sync = materializeFramework(repoRoot, { prune: false });
  } catch (err) {
    notes.push(`framework sync deferred: ${err.message}`);
  }

  const guard = armPushGuard(coreDir);
  for (const e of guard.errors) notes.push(`push guard: ${e}`);

  return {
    skills: countSkills(repoRoot, coreDir),
    repaired,
    wiring,
    gitignore,
    sync,
    guard,
    notes,
  };
}
