// lib/skill-lifecycle/offload.mjs
// `sidekicks skill offload [<skill>] [--check] [--apply] [--restore] [--list] [--force] [--json]`
//
// Park a skill: move it out of `.agents/skills/` into `.sidekicks/skill-offloaded/` so discovery
// stops loading it, while every file stays in the repo and in git history. Reversible archiving.
//
// OFFLOAD IS NOT UNINSTALL, and the difference is not cosmetic. `lib/framework-settings/registry.mjs`
// scans the offloaded tree DELIBERATELY (SKILL_TREES includes it), because a retired skill's rule
// fragment must stay addressable and its hook may still be wired — `hook.enforce-flow-headful` is
// the live case. So a parked skill keeps its ids in `.sidekicks/config/settings/`, keeps its config
// block discoverable, and keeps its hook wiring. The report says all of that out loud, because an
// operator who believes "offloaded" means "gone" will go looking for the wrong thing later.
// `sidekicks skill remove` is the verb that actually uninstalls.
//
// WHY THIS REPLACED A BASH SCRIPT. sk-skill-offload shipped its own `offload_skill.sh`, whose
// engine was `grep -rIlE` plus `git mv`. Two problems: BSD/GNU grep divergence and Git-Bash make it
// a portability liability on Windows, and a text grep cannot tell a wired invocation from a passing
// mention. The scan now lives in references.mjs, shared with `skill remove`. The script remains as a
// thin shim so existing command-sequences keep working.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION, EXIT_USAGE, EXIT_NOT_FOUND, SidekicksError } from '../sk-cli/errors.mjs';
import { SKILLS_ROOT_REL, OFFLOAD_ROOT_REL } from '../sk-cli/skill-trees.mjs';
import { discoverSkills } from '../skill-manifest/read.mjs';
import { mv } from '../git-delegation/git.mjs';
import { nowBangkok } from '../artifacts-lifecycle/_shared.mjs';
import { readProfile, recordProfile } from '../skill-registry/store.mjs';
import { referencesTo } from './references.mjs';
import { parseSkillFlags, positionalArgs } from './_shared.mjs';

const ACTIVE = SKILLS_ROOT_REL;
const PARKED = OFFLOAD_ROOT_REL;

/**
 * What offloading (or restoring) one skill involves. Pure — reads, decides, writes nothing.
 *
 * @param {string} repoRoot
 * @param {string} name
 * @param {{restore?: boolean}} opts
 */
export function offloadPlan(repoRoot, name, opts = {}) {
  const entry = discoverSkills(repoRoot).find((e) => e.skill === name);
  if (!entry) {
    throw new SidekicksError(
      `skill offload: unknown skill '${name}' — run 'sidekicks skill list' to see them`,
      EXIT_NOT_FOUND
    );
  }
  const restore = Boolean(opts.restore);
  if (restore && !entry.offloaded) {
    throw new SidekicksError(`skill offload: '${name}' is already active — nothing to restore`, EXIT_VALIDATION);
  }
  if (!restore && entry.offloaded) {
    throw new SidekicksError(`skill offload: '${name}' is already offloaded`, EXIT_VALIDATION);
  }

  const fromRel = `${restore ? PARKED : ACTIVE}/${name}`;
  const toRel = `${restore ? ACTIVE : PARKED}/${name}`;
  if (existsSync(join(repoRoot, ...toRel.split('/')))) {
    throw new SidekicksError(
      `skill offload: '${toRel}' already exists — consolidate the two copies before moving`,
      EXIT_VALIDATION
    );
  }

  // Restoring cannot break anything: it puts a skill back. Only the outbound move needs the gate.
  const refs = restore ? { blocking: [], soft: [], declared: [] } : referencesTo(repoRoot, name);
  return { entry, restore, fromRel, toRel, refs };
}

/** Skills currently parked, plus archives sitting at a non-canonical path. */
function parkedInventory(repoRoot) {
  const parked = discoverSkills(repoRoot).filter((e) => e.offloaded).map((e) => e.skill);
  // Older conventions that existed before `.sidekicks/skill-offloaded/` settled. `restore` and this
  // listing are blind to all of them, so a stray has to be reported rather than quietly missed.
  //
  // These are spelled the way they were spelled WHEN THEY WERE WRITTEN — they name folders that may
  // still be sitting in an old checkout, not paths this version would ever create. Rewriting them to
  // the current tree would make the detector look for something that has never existed and silently
  // stop finding the archives it exists to surface. `.agents/skills/skill-offloaded` is listed too,
  // because a checkout that offloaded a skill after the move but before this fix could have one.
  const strays = [];
  for (const rel of [
    '.sidekicks/skills/skill-offloaded',
    '.sidekicks/skills-offloaded',
    '.agents/skills/skill-offloaded',
  ]) {
    if (existsSync(join(repoRoot, ...rel.split('/')))) strays.push(rel);
  }
  return { parked, strays };
}

/**
 * Run `skill offload`.
 *
 * @param {{repoRoot: string, argv: string[]}} ctx
 */
export async function run(ctx) {
  const flags = parseSkillFlags(ctx.argv, ['apply', 'force', 'json', 'check', 'restore', 'list']);
  const [name] = positionalArgs(ctx.argv, []);

  if (flags.list) {
    const inv = parkedInventory(ctx.repoRoot);
    if (flags.json) {
      return { stdout: JSON.stringify({ ok: true, ...inv }, null, 2) + '\n', exitCode: EXIT_OK };
    }
    const out = [`skill offload --list: ${inv.parked.length} skill(s) parked`];
    for (const s of inv.parked) out.push(`  ${s}`);
    if (inv.strays.length) {
      out.push('', 'STRAY — an archive at a non-canonical path, invisible to restore and list:');
      for (const s of inv.strays) out.push(`  ${s}  (consolidate into ${PARKED}/)`);
    }
    return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
  }

  if (!name) {
    throw new SidekicksError(
      'skill offload: name a skill, or pass --list to see what is parked', EXIT_USAGE
    );
  }

  const plan = offloadPlan(ctx.repoRoot, name, { restore: flags.restore });
  const { refs } = plan;
  const blocked = !plan.restore && (refs.blocking.length > 0 || refs.declared.length > 0);

  let moved = false;
  if (flags.apply && (!blocked || flags.force)) {
    mv(ctx.repoRoot, plan.fromRel, plan.toRel);
    moved = true;
    // Keep the receipt in step for an imported skill. A skill with no profile offloads perfectly
    // well — most skills here were authored in this repo and have none.
    const profile = readProfile(ctx.repoRoot, name);
    if (profile) {
      try {
        recordProfile(ctx.repoRoot, {
          ...profile,
          history: [
            ...(profile.history || []),
            { at: nowBangkok(), action: plan.restore ? 'restore' : 'offload', detail: plan.toRel },
          ],
          mirror: null,
        });
      } catch { /* a receipt is bookkeeping; the move already succeeded */ }
    }
  }

  const exitCode = blocked && !flags.force ? EXIT_VALIDATION : EXIT_OK;

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        ok: exitCode === EXIT_OK, skill: name, restore: plan.restore, moved,
        from: plan.fromRel, to: plan.toRel,
        blocking: refs.blocking, declared: refs.declared, soft: refs.soft.map((s) => s.path),
      }, null, 2) + '\n',
      exitCode,
    };
  }

  const out = [];
  out.push(moved
    ? `skill offload: ${plan.restore ? 'restored' : 'offloaded'} ${name} — ${plan.fromRel} -> ${plan.toRel}`
    : `skill offload: ${name} would move ${plan.fromRel} -> ${plan.toRel} (nothing moved)`);

  if (refs.declared.length) {
    out.push('', `BLOCKING — ${refs.declared.length} skill(s) DECLARE ${name} as a sibling:`);
    for (const d of refs.declared) {
      out.push(`  ${d.skill} (how: ${d.how})`);
      if (d.degraded) out.push(`      without it: ${d.degraded}`);
    }
  }
  if (refs.blocking.length) {
    const bySkill = new Map();
    for (const b of refs.blocking) {
      if (!bySkill.has(b.skill)) bySkill.set(b.skill, []);
      bySkill.get(b.skill).push(b);
    }
    out.push('', `BLOCKING — ${bySkill.size} active skill(s) name ${name}:`);
    for (const [skill, hits] of bySkill) {
      out.push(`  ${skill}: ${hits.slice(0, 3).map((h) => h.path).join(', ')}`
        + `${hits.length > 3 ? ` (+${hits.length - 3} more)` : ''}`);
    }
  }
  if (refs.soft.length) {
    out.push('', `SOFT — ${refs.soft.length} mention(s) outside the skill trees; these never block:`);
    for (const s of refs.soft.slice(0, 12)) out.push(`  ${s.path}`);
    if (refs.soft.length > 12) out.push(`  … +${refs.soft.length - 12} more`);
  }
  if (!refs.declared.length && !refs.blocking.length && !plan.restore) {
    out.push('', 'OK — no active skill references it.');
  }

  if (blocked && !flags.force) {
    out.push('', 'REFUSED. Rework or retire the dependents first. --force moves it anyway and '
      + 'leaves those references dangling — only after the user has seen this list and said so.');
  } else if (!flags.apply) {
    out.push('', `  apply with 'sidekicks skill offload ${name}`
      + `${plan.restore ? ' --restore' : ''}${blocked ? ' --force' : ''} --apply'`);
  }

  if (moved && !plan.restore) {
    out.push(
      '',
      'PARKED, NOT UNINSTALLED. The offloaded tree is inside SKILL_TREES on purpose',
      '(lib/framework-settings/registry.mjs), so this skill keeps:',
      `  - its ids in .sidekicks/config/settings/{rules,criteria}.yaml`,
      '  - its config block, still discovered by `config sync`',
      '  - its hook wiring in all four CLI configs',
      `  - its line in audit-groups.yaml, and any AGENTS.md lines naming it`,
      `For a real uninstall: sidekicks skill remove ${name}`,
      '',
      `Restore it with 'sidekicks skill offload ${name} --restore --apply'. The move is staged, `
      + 'not committed — review it before you commit.'
    );
  }

  if (exitCode !== EXIT_OK) throw new SidekicksError(out.join('\n'), exitCode);
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
