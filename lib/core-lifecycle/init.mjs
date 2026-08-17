// lib/core-lifecycle/init.mjs
// `sidekicks core init [--json] [--dry-run]`
//
// Seed (or re-seed) a workspace around a framework core mounted at .sidekicks-core/. This is the verb
// the curl bootstrap calls once the submodule is in place, and it is safe to re-run at any time —
// which is what makes it the second half of `core update` too.
//
// It never commits and never pushes: the workspace repo's history belongs to its owner. Files are
// classified System / User / Managed (lib/core-lifecycle/_seed.mjs) so a re-run cannot eat a
// customized workspace.
//
// Deliberately NOT done here:
//   - `core.hooksPath` is left alone. The framework's .githooks/pre-commit runs
//     tests/agent-context-mirror.test.mjs, which a workspace does not have — pointing a workspace at
//     it would fail every commit. Workspace-side git hooks are the workspace owner's business.
//   - `.sidekicks/settings.json` is not written. It is git-ignored per-clone scope state, and an
//     absent file already means "root scope" (AGENTS.md: a missing settings file is never an error).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, symlinkSync, lstatSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EXIT_OK } from '../sk-cli/errors.mjs';
import { CORE_DIR } from '../sk-cli/core-mount.mjs';
import { mkdirp, writeAtomic } from '../fs-safety/fsx.mjs';
import { parseCoreFlags, requireCore, inspectCore, shortSha, agentPackHint } from './_shared.mjs';
import { applyDerived, coreSkillNames } from './_derive.mjs';
import {
  binShim, workspaceAgentsMd, workspacePackageJson, managedBlock, upsertBlock,
  emptyMemoryIndex, writeIfAbsent, writeSystem,
} from './_seed.mjs';
import { frameworkConfigPath, frameworkConfigRel } from '../config-store/paths.mjs';
import {
  BLOCKS,
  SETTINGS_FILES,
  SETTINGS_REL_DIR,
} from '../framework-settings/framework-config.mjs';

/**
 * Repo-relative path of the core's framework instruction file, preferring CLAUDE.framework.md and
 * falling back to the core's CLAUDE.md so an older core still gets a working import line.
 *
 * @param {string} coreDir
 * @returns {string|null}
 */
function frameworkDocRel(coreDir) {
  for (const name of ['CLAUDE.framework.md', 'CLAUDE.md']) {
    if (existsSync(join(coreDir, name))) return `${CORE_DIR}/${name}`;
  }
  return null;
}

/**
 * Move a pre-inversion workspace onto the current layout: AGENTS.md is the real instruction file,
 * CLAUDE.md and GEMINI.md are mirrors of it (Rule 6).
 *
 * A workspace initialised before the flip has it the other way round — a regular CLAUDE.md with an
 * AGENTS.md symlink beside it. Renaming is what preserves the user's own prose: seeding a fresh
 * AGENTS.md instead would leave everything they wrote stranded in a file nothing points at.
 *
 * Does nothing when AGENTS.md is already a regular file, or when BOTH are regular files — two real
 * files are the owner's deliberate arrangement, not drift to repair.
 *
 * @param {string} repoRoot
 * @returns {string|null} a note when the surface was migrated
 */
export function migrateInstructionSurface(repoRoot) {
  const agentsPath = join(repoRoot, 'AGENTS.md');
  const claudePath = join(repoRoot, 'CLAUDE.md');

  let agentsSt = null;
  try { agentsSt = lstatSync(agentsPath); } catch { /* absent */ }
  if (agentsSt && !agentsSt.isSymbolicLink()) return null;   // already the real file

  let claudeSt = null;
  try { claudeSt = lstatSync(claudePath); } catch { /* absent */ }
  if (!claudeSt || claudeSt.isSymbolicLink()) return null;   // nothing to promote

  try {
    if (agentsSt) rmSync(agentsPath, { force: true });       // drop the stale mirror first
    renameSync(claudePath, agentsPath);
    return 'CLAUDE.md was promoted to AGENTS.md (the instruction surface is canonical there now)';
  } catch {
    return null;                                             // reported by core doctor
  }
}

/**
 * Mirror AGENTS.md as CLAUDE.md / GEMINI.md (Rule 6 — one instruction surface, several CLIs).
 * Symlink on POSIX; on Windows without the privilege for symlinks, fall back to a copy and say so.
 *
 * @param {string} repoRoot
 * @returns {{created: string[], copied: string[]}}
 */
function ensureInstructionMirrors(repoRoot) {
  const created = [];
  const copied = [];
  for (const name of ['CLAUDE.md', 'GEMINI.md']) {
    const linkPath = join(repoRoot, name);
    let st = null;
    try { st = lstatSync(linkPath); } catch { /* absent */ }
    if (st && st.isSymbolicLink()) continue;         // already mirrored
    if (st) continue;                                // a real file the owner put there — leave it
    try {
      symlinkSync('AGENTS.md', linkPath, 'file');
      created.push(name);
    } catch {
      try {
        writeAtomic(linkPath, readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8'));
        copied.push(name);
      } catch { /* nothing more to try — reported by core doctor */ }
    }
  }
  return { created, copied };
}

/**
 * Run `core init`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: Function }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseCoreFlags(ctx.argv, ['json', 'dry-run']);
  const dryRun = flags['dry-run'] === true;

  const coreDir = requireCore(repoRoot, 'core init');
  const info = inspectCore(repoRoot, coreDir);

  /** @type {{system: string[], created: string[], kept: string[], blocks: string[], notes: string[]}} */
  const report = { system: [], created: [], kept: [], blocks: [], notes: [] };

  const docRel = frameworkDocRel(coreDir);
  const skills = coreSkillNames(coreDir);

  if (dryRun) {
    const planned = [
      'bin/sidekicks (system)',
      ...(docRel ? ['AGENTS.md (user, if absent) + managed import block'] : []),
      'CLAUDE.md, GEMINI.md (mirrors of AGENTS.md)',
      'package.json (user, if absent)',
      '.gitignore (managed block)',
      '.sidekicks/config/.gitignore (user, if absent — keeps *.secret.yaml out of git)',
      '.sidekicks/config/framework.yaml (user, if absent) then framework sync',
      '.sidekicks/memory/MEMORY.md (user, if absent)',
      'projects/.gitkeep',
      'per-CLI wiring, hook paths re-pointed at the mount (system)',
      `${skills.length} core skill overlay link(s) + the four host skill links`,
      'push guard: origin push url, push.default, pre-push hook',
    ];
    const out = [
      `core init --dry-run: ${info.coreRel} @ ${info.describe || shortSha(info.head)}`,
      ...planned.map((p) => `  would write  ${p}`),
    ];
    return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
  }

  // ── System: the bin shim ────────────────────────────────────────────────────────────────────────
  if (writeSystem(join(repoRoot, 'bin', 'sidekicks'), binShim())) report.system.push('bin/sidekicks');
  if (process.platform !== 'win32') {
    try { chmodSync(join(repoRoot, 'bin', 'sidekicks'), 0o755); } catch { /* non-fatal */ }
  }

  // ── User: AGENTS.md, then the managed import block either way ──────────────────────────────────
  // Promote a pre-inversion CLAUDE.md first, so the upsert lands in the file the mirrors point at.
  const migrated = migrateInstructionSurface(repoRoot);
  if (migrated) report.notes.push(migrated);

  const agentsPath = join(repoRoot, 'AGENTS.md');
  if (docRel) {
    if (writeIfAbsent(agentsPath, workspaceAgentsMd(repoRoot, docRel))) {
      report.created.push('AGENTS.md');
    } else {
      const current = readFileSync(agentsPath, 'utf8');
      const res = upsertBlock(current, managedBlock(docRel), 'top');
      if (res.changed) {
        writeAtomic(agentsPath, res.text);
        report.blocks.push(`AGENTS.md import block ${res.action}`);
      } else {
        report.kept.push('AGENTS.md');
      }
    }
  } else {
    report.notes.push(
      'the core ships neither CLAUDE.framework.md nor CLAUDE.md — no framework instruction import '
      + 'was wired; update the core to a build that carries one'
    );
    if (writeIfAbsent(agentsPath, `# ${basename(repoRoot)} — Agent Bootstrap\n`)) {
      report.created.push('AGENTS.md');
    }
  }

  const mirrors = ensureInstructionMirrors(repoRoot);
  for (const n of mirrors.created) report.created.push(`${n} -> AGENTS.md`);
  for (const n of mirrors.copied) {
    report.created.push(`${n} (copy — symlinks unavailable)`);
    report.notes.push(`${n} is a COPY, not a link: re-run after enabling symlinks to restore parity`);
  }

  // ── User: package.json ─────────────────────────────────────────────────────────────────────────
  if (writeIfAbsent(join(repoRoot, 'package.json'), workspacePackageJson(repoRoot))) {
    report.created.push('package.json');
  } else {
    report.kept.push('package.json');
  }

  // ── User: scope config, enable map, memory store, projects/ ─────────────────────────────────────
  //
  // NOTHING is seeded into .sidekicks/config.yaml, deliberately.
  //
  // This used to copy the core's `config.example.yaml` there. That file is the PRE-FAMILY MONOLITH,
  // and seeding it did two bad things to a brand-new workspace: it created a legacy-layout file that
  // `config doctor` reports as a migration notice on a repo that has nothing to migrate, and it
  // carried whatever blocks the SOURCE repo documented — including `image_generation`, which no
  // shipped skill declares, so a fresh install failed `config doctor` with an undeclared block and
  // `config migrate --all --dry-run` refused to run at all.
  //
  // Seeding nothing is the contract-honest answer: missing configuration is never an error at any
  // layer, and `config get <block>` falls back to the owning skill's config.defaults.yaml. A user who
  // wants a starting point reads the core's config.example.yaml, which still ships.
  //
  // What DOES get seeded is the ignore rule below — the one part of config/ that must exist before
  // anything is written there.
  const coreConfigIgnore = join(coreDir, '.sidekicks', 'config', '.gitignore');
  if (existsSync(coreConfigIgnore)) {
    // Without this, a workspace's config/ directory happily stages a *.secret.yaml. The rule lives
    // INSIDE config/ rather than in the repo-root .gitignore precisely so it travels with the
    // directory into whatever repo it ends up in — but the core shipping it is not the same as the
    // workspace having it, and only the workspace's copy protects the workspace's credentials.
    const rel = join('.sidekicks', 'config', '.gitignore');
    if (writeIfAbsent(join(repoRoot, rel), readFileSync(coreConfigIgnore, 'utf8'))) {
      report.created.push(`${rel} (keeps *.secret.yaml out of git)`);
    } else {
      report.kept.push(rel);
    }
  }

  // The enable map lives in the scope's config/ directory. frameworkConfigPath() resolves BOTH
  // sides of the copy through the same one-release compatibility window: the core is read wherever
  // it carries the file (a core built before the move still has it at the top level), and the
  // workspace is seeded at config/ unless it already has a legacy one to keep.
  const coreFrameworkYaml = frameworkConfigPath(coreDir, 'framework.yaml', { base: '.sidekicks' });
  if (existsSync(coreFrameworkYaml)) {
    const dst = frameworkConfigPath(repoRoot, 'framework.yaml');
    const dstRel = frameworkConfigRel(repoRoot, 'framework.yaml');
    if (writeIfAbsent(dst, readFileSync(coreFrameworkYaml, 'utf8'))) {
      report.created.push(dstRel);
    } else {
      report.kept.push(dstRel);
    }
  }

  // The per-kind SETTINGS files, seeded the same way and for the same reason: without them a
  // workspace resolves every entry to the built-in default, silently re-enabling whatever the core
  // deliberately disabled. Seeded per file rather than as a directory so an existing decision in
  // one kind is never overwritten because another kind was missing.
  for (const block of BLOCKS) {
    const coreSettings = join(coreDir, SETTINGS_REL_DIR, SETTINGS_FILES[block]);
    if (!existsSync(coreSettings)) continue;
    const rel = join(SETTINGS_REL_DIR, SETTINGS_FILES[block]);
    if (writeIfAbsent(join(repoRoot, rel), readFileSync(coreSettings, 'utf8'))) {
      report.created.push(rel);
    } else {
      report.kept.push(rel);
    }
  }

  if (writeIfAbsent(join(repoRoot, '.sidekicks', 'memory', 'MEMORY.md'), emptyMemoryIndex())) {
    report.created.push('.sidekicks/memory/MEMORY.md');
  } else {
    report.kept.push('.sidekicks/memory/MEMORY.md');
  }

  mkdirp(join(repoRoot, 'projects'));
  if (writeIfAbsent(join(repoRoot, 'projects', '.gitkeep'), '')) report.created.push('projects/.gitkeep');

  // ── Everything derived from the core (wiring, overlay, .gitignore block, enable map, guard) ─────
  // Shared with `core update` so the two can never drift — see lib/core-lifecycle/_derive.mjs.
  const derived = applyDerived(repoRoot, coreDir, ctx.log);
  for (const f of derived.wiring.files) report.system.push(f);
  for (const d of derived.wiring.dirs) report.system.push(`${d}/`);
  if (derived.gitignore.changed) report.blocks.push(`.gitignore block ${derived.gitignore.action}`);
  else report.kept.push('.gitignore');
  report.notes.push(...derived.notes);

  const skillState = derived.skills;
  const synced = derived.sync;
  const guard = derived.guard;

  // Optional agent packs are REPORTED, never installed. See agentPackHint — an init that created
  // agents would switch on a thing that acts, for somebody who never asked for it.
  const packs = agentPackHint(repoRoot);

  if (flags.json) {
    const payload = {
      ok: true,
      core: { path: info.coreRel, head: info.head, ref: info.describe || info.branch },
      system: report.system,
      created: report.created,
      kept: report.kept,
      blocks: report.blocks,
      skills: { ...skillState, repaired: derived.repaired },
      framework_sync: synced ? { added: synced.added.length, listed: synced.added } : null,
      push_guard: { pushUrl: guard.pushUrl, pushDefault: guard.pushDefault, hook: guard.hook },
      agent_packs: { available: packs.count, installed: 0 },
      notes: report.notes,
    };
    return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: EXIT_OK };
  }

  const out = [
    `core init: ${info.coreRel} @ ${info.describe || shortSha(info.head)}`
    + (info.marker ? ` (framework ${info.marker.version || 'unknown'})` : ''),
  ];
  if (report.created.length) {
    out.push('  created:');
    for (const f of report.created) out.push(`    + ${f}`);
  }
  if (report.system.length) {
    out.push('  framework-owned (rewritten on every init/update):');
    for (const f of report.system) out.push(`    = ${f}`);
  }
  if (report.blocks.length) {
    out.push('  managed blocks:');
    for (const f of report.blocks) out.push(`    ~ ${f}`);
  }
  if (report.kept.length) {
    out.push(`  kept untouched: ${report.kept.join(', ')}`);
  }
  out.push(`  skills: ${skillState.linked} linked from the core, ${skillState.own} authored here `
    + `(core ships ${skillState.coreShips})`);
  if (synced && synced.added.length) {
    out.push(`  framework sync: listed ${synced.added.length} entr(ies) in ${frameworkConfigRel(repoRoot, 'framework.yaml')}`);
  }
  out.push(
    `  push guard: ${guard.pushUrl ? 'origin push url' : 'origin push url FAILED'}, `
    + `${guard.pushDefault ? 'push.default=nothing' : 'push.default FAILED'}, `
    + `${guard.hook ? 'pre-push hook' : 'pre-push hook FAILED'}`
  );
  if (packs.line) out.push(`  ${packs.line}`);
  for (const n of report.notes) out.push(`  NOTE: ${n}`);
  out.push('');
  out.push('Next:');
  out.push('  node bin/sidekicks --help');
  out.push('  node bin/sidekicks core status');
  out.push('  node bin/sidekicks project create <name>');
  if (packs.count) out.push('  node bin/sidekicks agent pack list');

  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
