// lib/skill-lifecycle/remove.mjs
// `sidekicks skill remove <skill> [--destination <name>] [--apply] [--force] [--purge-profile] [--json]`
//
// The reverse of CREATE (locally), the reverse of IMPORT (for a skill that came from elsewhere), and
// the reverse of EXPORT (at a destination).
//
// TWO MODES, ONE VERB. Without `--destination` it removes the skill from THIS repo and unwinds the
// wiring legs CREATE's checklist added. With `--destination <name>` it retracts the published copy
// from a configured skills repository. They are one verb because "remove skill X" is one intent,
// and splitting it would leave an operator who deleted locally with no obvious way to unpublish.
//
// REMOVAL IS ALSO THE REVERSE OF AN IMPORT, which is why the registry receipt is read here. An
// imported skill has a committed profile under `.sidekicks/registry/skills/` recording what THAT
// import turned on in this repo — the one question nothing on disk can answer after the fact, since
// a converted folder is indistinguishable from a hand-authored one and the source clone is gone. The
// receipt is RETIRED to `.sidekicks/registry/skills/removed/<skill>.yaml` rather than deleted, so a
// re-import can see the skill was here before; `--purge-profile` drops it outright instead. A skill
// authored here has no receipt, and its absence is stated rather than treated as a fault.
//
// NOT `skill offload`. Offload PARKS a skill into `.sidekicks/skill-offloaded/` and deliberately
// LEAVES its rule ids, config block and hook wiring in place, because the tree stays inside
// SKILL_TREES and the skill is coming back. Remove means the skill is gone, so everything pointing
// at it goes too.
//
// DRY RUN IS THE DEFAULT, `--apply` executes. Same convention as `skill import` and `skill heal` —
// the other two verbs here that destroy something. (`skill export` is the opposite way round, and
// deliberately: writing a copy is not the same risk as deleting an original.)
//
// NOTHING IS UNRECOVERABLE. The local folder is copied to a git-ignored backup under
// `artifacts/runs/skill-manager/backups/<stamp>/` BEFORE the delete, the same way `skill import`
// backs up what it overwrites. The config prune PARKS an undeclared block as
// `pending-removal.<family>.yaml` rather than dropping it (that is `config sync --prune`'s own
// contract, not something re-implemented here).
//
// THE FLOOR IS NOT REMOVABLE. The five required skills are read from the ONE place that defines
// them — sk-inherit's `presets.yaml` `required:` block — never from a second hardcoded list
// that could drift from it. `--force` does not open that door; it only covers the destination
// intent gate.
//
// WHAT THIS VERB WILL NOT TOUCH, on purpose:
//   - hook wiring in the four per-CLI configs (Rule 6). The wiring spans JSON and TOML, this repo
//     has no TOML writer, and the hook's registry entry lives in lib/framework-settings/
//     core-registry.mjs — outside the skill folder, so it survives the delete regardless. Reported
//     as an ordered manual step instead, the same stance `skill import` takes.
//   - AGENTS.md, docs and another skill's `depends-on`. Swept for and REPORTED as residue; a verb
//     that edited prose it does not own is how a removal breaks the repo it was tidying.
//   - git, at either end. No commit, no push — EXPORT's rule, for EXPORT's reason.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { isInside } from '../fs-safety/canonical-path.mjs';
import { execAwareMode, rmrf, writeAtomic } from '../fs-safety/fsx.mjs';
import { discoverSkills, readSkillDescriptor, derivedSections } from '../skill-manifest/read.mjs';
import { bundleFileList, yamlLine } from '../skill-package/portable.mjs';
import { nowBangkok } from '../artifacts-lifecycle/_shared.mjs';
import { run as configSyncRun } from '../config-lifecycle/sync.mjs';
import { readProfile, removeProfile } from '../skill-registry/store.mjs';
import { parseSkillFlags, positionalArgs, resolveTargets } from './_shared.mjs';
import { readPreset } from './export.mjs';
import { configuredDestinations, readDestinationIntent, DEST_TREES } from './destinations.mjs';
import { SKILLS_ROOT_SEGMENTS } from '../sk-cli/skill-trees.mjs';

/**
 * The three membership files a skill can appear in, relative to the repo root. These live in THIS
 * repo's skills tree (unlike DEST_TREES above, which names a destination repository), so they are
 * built from the canonical segments and follow it wherever it goes.
 */
const AUDIT_GROUPS_REL = [...SKILLS_ROOT_SEGMENTS, 'sk-skill-auditor', 'assets', 'audit-groups.yaml'];
const PRESETS_REL = [...SKILLS_ROOT_SEGMENTS, 'sk-inherit', 'assets', 'presets.yaml'];
const CATEGORIES_REL = [...SKILLS_ROOT_SEGMENTS, 'sk-skill-manager', 'assets', 'categories.yaml'];

/**
 * How each membership file names the thing a skill belongs TO — the three files disagree, and
 * getting this wrong reports the wrong container back to the operator.
 *
 * An indented `key:` is a nested GROUP HEADER in audit-groups.yaml (`planning:` under
 * `skill-auditing groups:`), but a labelled SECTION in the other two (presets' `skills:`/
 * `delegates:`, categories' `members:`) where the real container is the column-0 name above it.
 * `sections` lists the labelled ones per file; `skipSections` lists the ones whose items are not
 * skills at all.
 */
const MEMBERSHIP_FILES = Object.freeze({
  audit_groups: { rel: AUDIT_GROUPS_REL, opts: {} },
  presets: { rel: PRESETS_REL, opts: { sections: ['skills', 'delegates'], skipSections: ['delegates'] } },
  categories: { rel: CATEGORIES_REL, opts: { sections: ['members'] } },
});

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

/**
 * The skills no runtime may be forged without, read from the file that defines them.
 *
 * `readPreset` is export.mjs's narrow reader for that same file, and `required:` parses as a preset
 * even though it is not one — which is exactly why it can be reused here instead of a second reader.
 * An absent or unreadable presets.yaml yields an EMPTY floor rather than an error: a lean runtime
 * may carry this verb without carrying sk-inherit, and refusing every removal in that repo
 * would be worse than protecting nothing there.
 *
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
export function requiredFloor(repoRoot) {
  return new Set(readPreset(repoRoot, 'required') || []);
}

// ---------------------------------------------------------------------------
// Narrow line editing of the three membership files
// ---------------------------------------------------------------------------

/** The end-of-line this file already uses, so an edit never rewrites every line on Windows. */
function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Every `- <name>` membership line for one skill, with the header block it sits under.
 *
 * PARSED THE SAME NARROW WAY THE READERS DO. `export.mjs` (groupOf/categoryOf) and `import.mjs`
 * (groupedSkills) read these three files line by line, not through a YAML parser, because two
 * independent readers already depend on that exact shape. An edit here has to survive the same
 * readers, so it uses the same rules — and comments, which a re-serialising YAML writer would
 * destroy, are simply never touched.
 *
 * `skipSections` is what keeps presets.yaml honest: its `delegates:` subsection names AGENTS, not
 * skills, and a skill name that happened to match an agent name must not take the agent with it.
 *
 * @param {string} text
 * @param {string} name
 * @param {{sections?: string[], skipSections?: string[]}} [opts] - see MEMBERSHIP_FILES
 * @returns {Array<{index: number, header: string|null}>}
 */
export function findMembershipLines(text, name, opts = {}) {
  const sections = new Set(opts.sections || []);
  const skip = new Set(opts.skipSections || []);
  const lines = text.split(/\r?\n/);
  const hits = [];
  let header = null;
  let section = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    // A column-0 line ends whatever block was open — the rule every reader of these files applies.
    if (/^\S/.test(line)) {
      header = /:\s*$/.test(line) ? line.replace(/:\s*$/, '') : null;
      section = null;
      continue;
    }
    const sub = line.match(/^\s+([a-z][a-z0-9_-]*):\s*$/);
    if (sub) {
      section = sub[1];
      // A LABELLED section leaves the container name alone (it is the column-0 name above); any
      // other indented key IS the container (an audit group).
      if (!sections.has(sub[1])) header = sub[1];
      continue;
    }
    const item = line.match(/^\s+-\s+(\S+)/);
    if (!item || item[1] !== name) continue;
    if (section && skip.has(section)) continue;
    hits.push({ index: i, header });
  }
  return hits;
}

/**
 * Drop every membership line for one skill. Returns the new text and what was dropped.
 *
 * EMPTY CONTAINERS ARE LEFT STANDING, and reported instead. An emptied audit group audits nothing
 * and an emptied `members:` falls back to the audit group, so neither is a defect — while presets'
 * `delegates:` is deliberately empty in the shipped file, which proves an empty section is normal
 * here. A pruner could not tell those apart, so it does not try.
 *
 * @param {string} text
 * @param {string} name
 * @param {{sections?: string[], skipSections?: string[]}} [opts]
 * @returns {{text: string, headers: string[], changed: boolean}}
 */
export function dropMembership(text, name, opts = {}) {
  const hits = findMembershipLines(text, name, opts);
  if (!hits.length) return { text, headers: [], changed: false };
  const drop = new Set(hits.map((h) => h.index));
  const eol = eolOf(text);
  const kept = text.split(/\r?\n/).filter((_, i) => !drop.has(i));
  return {
    text: kept.join(eol),
    headers: [...new Set(hits.map((h) => h.header).filter(Boolean))],
    changed: true,
  };
}

/** Which containers in one file carry the skill (read-only — the plan half). */
function membershipOf(repoRoot, file, name) {
  const abs = join(repoRoot, ...file.rel);
  if (!existsSync(abs)) return { path: file.rel.join('/'), headers: [], present: false };
  const hits = findMembershipLines(readFileSync(abs, 'utf8'), name, file.opts);
  return {
    path: file.rel.join('/'),
    headers: [...new Set(hits.map((h) => h.header).filter(Boolean))],
    present: hits.length > 0,
  };
}

/** Apply the drop to one file. Returns the containers it was removed from. */
function applyMembership(repoRoot, file, name) {
  const abs = join(repoRoot, ...file.rel);
  if (!existsSync(abs)) return [];
  const result = dropMembership(readFileSync(abs, 'utf8'), name, file.opts);
  if (!result.changed) return [];
  assertWritable(abs, repoRoot);
  writeAtomic(abs, result.text);
  return result.headers;
}

// ---------------------------------------------------------------------------
// Residue — what stays behind, named rather than guessed at
// ---------------------------------------------------------------------------

/**
 * Remaining references to the skill's name across tracked files.
 *
 * `git grep` rather than a hand-rolled walk: it is already required by this repo, it honours
 * .gitignore (so generated artifacts and backups never turn up as "residue"), and it is the same
 * tool on macOS and Windows. Best-effort — a repo with no git, or no matches, yields an empty list
 * rather than a failure, because residue is a REPORT and never a gate.
 *
 * @param {string} repoRoot
 * @param {string} name
 * @param {string} ownRelDir - the skill's own folder, whose hits are not residue
 * @returns {Array<{path: string, line: number, text: string}>}
 */
export function residueReferences(repoRoot, name, ownRelDir) {
  const r = spawnSync('git', ['grep', '-n', '--fixed-strings', '--', name], {
    cwd: repoRoot, encoding: 'utf8', shell: false,
  });
  // git grep exits 1 on "no matches", which is not an error.
  if (r.error || (r.status !== 0 && r.status !== 1)) return [];
  const skipPrefixes = [
    `${ownRelDir}/`,
    AUDIT_GROUPS_REL.join('/'),
    PRESETS_REL.join('/'),
    CATEGORIES_REL.join('/'),
  ];
  const out = [];
  for (const raw of String(r.stdout || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = raw.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const path = m[1].split('\\').join('/');
    if (skipPrefixes.some((p) => path === p || path.startsWith(p))) continue;
    // A run artifact is a FROZEN RECORD of what happened, not wiring — editing one to erase a
    // skill's name would falsify history, so it is never residue a human has to act on. Some
    // repos commit `artifacts/`, so the filter is on the path shape, not on gitignore.
    if (/(^|\/)artifacts\/runs\//.test(path)) continue;
    out.push({ path, line: Number(m[2]), text: m[3].trim().slice(0, 160) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Local removal
// ---------------------------------------------------------------------------

/**
 * Plan a local removal. Pure: reads, decides, writes nothing.
 *
 * @param {string} repoRoot
 * @param {{skill: string, tree: string, dir: string, relDir: string}} entry
 * @returns {object}
 */
export function localPlan(repoRoot, entry) {
  const list = bundleFileList(repoRoot, entry);
  const descriptor = readSkillDescriptor(repoRoot, entry);
  const derived = derivedSections(descriptor, entry.skill);

  return {
    skill: entry.skill,
    tree: entry.tree,
    dir: entry.relDir,
    files: list.files.length,
    source: list.source,
    audit_groups: membershipOf(repoRoot, MEMBERSHIP_FILES.audit_groups, entry.skill),
    presets: membershipOf(repoRoot, MEMBERSHIP_FILES.presets, entry.skill),
    categories: membershipOf(repoRoot, MEMBERSHIP_FILES.categories, entry.skill),
    rules: (descriptor ? descriptor.rules : []).map((r) => r.id),
    config_block: derived.config ? derived.config.block : null,
    hooks: derived.framework_hooks.map((h) => h.id),
    references: residueReferences(repoRoot, entry.skill, entry.relDir),
    // Null for a skill authored here, or one imported before the registry existed. Absence is a
    // fact about provenance, never a fault — see the header.
    profile: readProfile(repoRoot, entry.skill),
  };
}

/**
 * Copy the skill's folder to the git-ignored backup tree before it is deleted.
 *
 * The exec bit travels (`execAwareMode`) for the same reason `skill import`'s backup carries it: a
 * restored script that lost `+x` is a broken skill that LOOKS restored.
 *
 * @returns {string} repo-relative backup path (portable-paths rule — never machine-absolute)
 */
function backupSkill(repoRoot, entry, stamp) {
  const rel = join('artifacts', 'runs', 'skill-manager', 'backups', stamp, entry.skill);
  for (const f of walkFiles(entry.dir)) {
    writeAtomic(join(repoRoot, rel, ...f.rel.split('/')), readFileSync(f.abs), {
      mode: execAwareMode(f.abs),
    });
  }
  return rel.split('\\').join('/');
}

/** Every file under a directory, as folder-relative POSIX paths. */
function walkFiles(dir, prefix = '') {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(abs, rel));
    else out.push({ abs, rel });
  }
  return out;
}

/**
 * Prune the settings and configuration halves, in process.
 *
 * `config sync --scope all --prune` is invoked as a FUNCTION, not re-implemented: it walks live
 * skill declarations (there is no catalog), parks the now-undeclared config block as
 * `pending-removal.<family>.yaml` in every scope that carried it, and calls
 * `materializeFramework(repoRoot, {prune})` itself — so one call drops the skill's rule/criterion
 * ids from `.sidekicks/config/settings/` too. `--scope all` rather than the active scope because a
 * root skill's block may have been configured inside a project.
 *
 * Best-effort by design: a repo whose config is already unhealthy must still be able to delete a
 * skill. The failure is reported, never thrown.
 *
 * @returns {{ok: boolean, config: string[], settings: string[], error: string|null}}
 */
async function pruneDeclarations(repoRoot) {
  try {
    const result = await configSyncRun(
      { repoRoot, argv: ['config', 'sync', '--scope', 'all', '--prune', '--json'], flags: {} },
      {}
    );
    const payload = JSON.parse(result.stdout);
    const config = (payload.scopes || []).flatMap((s) => s.pruned || []);
    const settings = (payload.settings && payload.settings.pruned) || [];
    return { ok: true, config, settings, error: null };
  } catch (err) {
    return { ok: false, config: [], settings: [], error: err.message };
  }
}

/**
 * The steps this verb deliberately leaves to a human, in the order they should be walked.
 *
 * @param {object} plan
 * @returns {string[]}
 */
function manualSteps(plan) {
  const steps = [];
  for (const id of plan.hooks) {
    steps.push(`unwire hook '${id}' from .claude/settings.json, .codex/config.toml, `
      + '.gemini/settings.json and .agent/settings.json (Rule 6 — all four, same change), then drop '
      + `its entry from lib/framework-settings/core-registry.mjs`);
  }
  if (plan.references.length) {
    steps.push(`review ${plan.references.length} remaining reference(s) to '${plan.skill}' listed `
      + 'above — AGENTS.md prose, docs, another skill\'s depends-on and tests are not edited by this verb');
  }
  steps.push("re-run 'sidekicks framework doctor' and 'sidekicks config doctor', then commit");
  return steps;
}

/**
 * Execute the local half.
 *
 * @param {{repoRoot: string}} ctx
 * @param {object} entry
 * @param {{apply: boolean, json: boolean, purgeProfile?: boolean}} opts
 */
async function runLocal(ctx, entry, opts) {
  const { repoRoot } = ctx;
  const plan = localPlan(repoRoot, entry);

  const report = {
    ok: true,
    mode: 'local',
    skill: entry.skill,
    dry_run: !opts.apply,
    applied: false,
    tree: entry.tree,
    dir: entry.relDir,
    files: plan.files,
    source: plan.source,
    backup: null,
    memberships: {
      audit_groups: plan.audit_groups.headers,
      presets: plan.presets.headers,
      categories: plan.categories.headers,
    },
    declared: { rules: plan.rules, config_block: plan.config_block, hooks: plan.hooks },
    pruned: { settings: [], config: [] },
    emptied: [],
    imported_from: plan.profile ? (plan.profile.source || null) : null,
    profile_provenance: plan.profile ? (plan.profile.provenance || null) : null,
    profile_retired: null,
    residue: { hooks: plan.hooks, references: plan.references },
    manual: manualSteps(plan),
  };

  if (opts.apply) {
    const stamp = nowBangkok().replace(/[:+]/g, '-');
    report.backup = backupSkill(repoRoot, entry, stamp);

    assertWritable(entry.dir, repoRoot);
    rmrf(entry.dir);

    report.memberships.audit_groups = applyMembership(repoRoot, MEMBERSHIP_FILES.audit_groups, entry.skill);
    report.memberships.presets = applyMembership(repoRoot, MEMBERSHIP_FILES.presets, entry.skill);
    report.memberships.categories = applyMembership(repoRoot, MEMBERSHIP_FILES.categories, entry.skill);
    // A container the skill was the last member of is left standing and named — see dropMembership.
    report.emptied = emptiedContainers(repoRoot, report.memberships);

    // After the folder is gone, so a crash mid-removal leaves the receipt pointing at a skill that
    // is still there rather than the reverse — a stale receipt is recoverable, a lost one is not.
    const at = nowBangkok();
    const retired = removeProfile(repoRoot, entry.skill, {
      tombstone: !opts.purgeProfile,
      facts: {
        removed_at: at,
        history: [{ at, action: 'remove', detail: report.backup || 'no files to back up' }],
      },
    });
    report.profile_retired = retired.had ? retired.path : null;

    const prune = await pruneDeclarations(repoRoot);
    report.pruned = { settings: prune.settings, config: prune.config };
    if (!prune.ok) {
      report.ok = false;
      report.manual.unshift(
        `'sidekicks config sync --scope all --prune' failed in process (${prune.error}) — `
        + 'run it yourself; the skill folder is already gone'
      );
    }
    report.applied = true;
  }

  if (opts.json) {
    return { stdout: JSON.stringify(report, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: renderLocal(report) + '\n', exitCode: EXIT_OK };
}

/** Containers the removal left with no members — reported, never auto-pruned. */
function emptiedContainers(repoRoot, memberships) {
  const out = [];
  for (const [key, file] of Object.entries(MEMBERSHIP_FILES)) {
    const headers = memberships[key] || [];
    const abs = join(repoRoot, ...file.rel);
    if (!existsSync(abs) || !headers.length) continue;
    const text = readFileSync(abs, 'utf8');
    for (const header of headers) {
      if (!containerHasMembers(text, header, file.opts)) out.push(`${file.rel.join('/')} → ${header}`);
    }
  }
  return out;
}

/**
 * Does a named container still carry at least one `- item`?
 *
 * Uses the same container rule as findMembershipLines — a labelled section (`members:`, `skills:`)
 * belongs to the column-0 name above it, anything else indented IS the container — so the two can
 * never disagree about what "empty" means.
 */
function containerHasMembers(text, header, opts = {}) {
  const sections = new Set(opts.sections || []);
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\S/.test(line)) {
      current = /:\s*$/.test(line) ? line.replace(/:\s*$/, '') : null;
      continue;
    }
    const sub = line.match(/^\s+([a-z][a-z0-9_-]*):\s*$/);
    if (sub) {
      if (!sections.has(sub[1])) current = sub[1];
      continue;
    }
    if (current === header && /^\s+-\s+\S/.test(line)) return true;
  }
  return false;
}

/** The human-facing local report. */
function renderLocal(r) {
  const out = [];
  out.push(r.dry_run
    ? `DRY RUN — skill remove ${r.skill} (nothing written)`
    : `skill remove: removed ${r.skill} from ${r.dir}`);
  out.push('');
  out.push(`  folder      ${r.dir} (${r.files} files${r.source === 'walk' ? ', no baseline' : ''})`);
  if (r.backup) out.push(`  backup      ${r.backup}`);
  const say = (label, list) => {
    if (list.length) out.push(`  ${label.padEnd(11)} ${list.join(', ')}`);
  };
  say('audit group', r.memberships.audit_groups);
  say('presets', r.memberships.presets);
  say('categories', r.memberships.categories);
  say('rules', r.declared.rules);
  if (r.declared.config_block) out.push(`  config      ${r.declared.config_block}`);
  say('hooks', r.declared.hooks);
  if (r.imported_from) out.push(`  imported    ${r.imported_from}`);

  if (!r.profile_provenance) {
    out.push('', 'NOTE — no import receipt for this skill, so everything above is derived from its '
      + 'declarations on disk: it was authored here, or it predates the registry.');
  }
  if (r.dry_run) {
    if (r.profile_provenance === 'backfilled') {
      out.push('', "Its receipt was BACKFILLED, not written by an import — what the import turned on "
        + 'here is inferred, so re-check the settings ids and audit group above before applying.');
    }
  }

  if (!r.dry_run) {
    out.push('');
    out.push('Pruned:');
    out.push(`  settings entries  ${r.pruned.settings.length ? r.pruned.settings.join(', ') : '(none)'}`);
    out.push(`  config blocks     ${r.pruned.config.length ? `${r.pruned.config.join(', ')} (parked as pending-removal.*, not deleted)` : '(none)'}`);
    out.push(`  receipt           ${r.profile_retired ? `retired to ${r.profile_retired}` : '(none to retire)'}`);
    if (r.emptied.length) {
      out.push('', `Left standing but now empty (${r.emptied.length}) — tidy by hand if you want them gone:`);
      for (const e of r.emptied) out.push(`  ${e}`);
    }
  }

  if (r.residue.references.length) {
    out.push('', `Still references '${r.skill}' (${r.residue.references.length}) — NOT edited by this verb:`);
    for (const ref of r.residue.references.slice(0, 20)) {
      out.push(`  ${ref.path}:${ref.line}  ${ref.text}`);
    }
    if (r.residue.references.length > 20) {
      out.push(`  … and ${r.residue.references.length - 20} more`);
    }
  }

  out.push('', 'Then, in this order — none of it is done by this verb:');
  for (const step of r.manual) out.push(`  - ${step}`);
  if (r.dry_run) out.push('', `  apply with 'sidekicks skill remove ${r.skill} --apply'`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Destination removal
// ---------------------------------------------------------------------------

/** Where a skill sits inside a layout-1 destination tree, or null. Mirrors destinations.mjs. */
function destinationSkillDir(destDir, skill) {
  for (const tree of DEST_TREES) {
    const dir = join(destDir, ...tree.split('/'), skill);
    if (existsSync(join(dir, 'SKILL.md'))) return dir;
  }
  return null;
}

/**
 * Rewrite `meta/<skill>/origin.yaml` as a RETRACTION record.
 *
 * THE TOMBSTONE IS THE ONLY DURABLE PLACE. `skill export` regenerates `catalog.yaml` wholesale
 * (renderCatalog), so a retraction recorded there is wiped by the next unrelated export. It only
 * ever writes `meta/<skill>/` for skills it CARRIES, so a retracted skill's meta folder is never
 * touched again — which is what lets `skill destinations` keep answering "was there, now isn't"
 * instead of collapsing back to `never-exported`.
 *
 * Rendered under renderOrigin's discipline: single-quoted one-liners, no multi-line scalars, because
 * the yaml-subset reader that reads it back has neither.
 *
 * @param {object|null} previous - the origin facts being replaced, when readable
 * @param {string} skill
 * @param {string} at - Asia/Bangkok timestamp
 * @returns {string}
 */
export function renderRetraction(previous, skill, at) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  return [
    '# origin.yaml — RETRACTED. This skill was published here and has been withdrawn.',
    '#',
    '# Written by `sidekicks skill remove --destination`. It is deliberately durable: `skill export`',
    '# only rewrites meta/ for skills it carries, so this record survives later exports and keeps',
    '# `sidekicks skill destinations` able to say "retracted" rather than "never exported".',
    '',
    'schema: 1',
    `skill: ${yamlLine(skill)}`,
    'retracted: true',
    `retracted_at: ${yamlLine(at)}`,
    `version: ${yamlLine(prev.version || '')}`,
    `source_repo: ${yamlLine(prev.source_repo || '')}`,
    `source_commit: ${yamlLine(prev.source_commit || '')}`,
    `exported_at: ${yamlLine(prev.exported_at || '')}`,
  ].join('\n') + '\n';
}

/**
 * Drop one skill's row from a destination's catalog.yaml and fix `skill_count`.
 *
 * Line-level, like every other edit here: the file is generated but carries a comment header that a
 * re-render from partial facts could not reproduce, and this verb does not hold the facts for the
 * OTHER rows anyway.
 *
 * @param {string} text
 * @param {string} skill
 * @returns {{text: string, changed: boolean}}
 */
export function dropCatalogRow(text, skill) {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const out = [];
  let dropping = false;
  let dropped = false;
  for (const line of lines) {
    const isRowStart = /^\s+-\s+name:\s*/.test(line);
    if (isRowStart) {
      const m = line.match(/^\s+-\s+name:\s*'?([^']*)'?\s*$/);
      dropping = Boolean(m && m[1] === skill);
      if (dropping) { dropped = true; continue; }
    } else if (dropping) {
      // Continuation lines of the row being dropped are deeper-indented `key: value` pairs.
      if (/^\s{3,}\S/.test(line) && !/^\s+-\s/.test(line)) continue;
      dropping = false;
    }
    out.push(line);
  }
  if (!dropped) return { text, changed: false };
  const fixed = out.map((line) => {
    const m = line.match(/^skill_count:\s*(\d+)\s*$/);
    return m ? `skill_count: ${Math.max(0, Number(m[1]) - 1)}` : line;
  });
  return { text: fixed.join(eol), changed: true };
}

/** `git status --short` at a destination checkout — read-only, best-effort. */
function gitStatusShort(dir) {
  const r = spawnSync('git', ['status', '--short'], { cwd: dir, encoding: 'utf8', shell: false });
  if (r.error || r.status !== 0) return '';
  return String(r.stdout || '').trimEnd();
}

/** Read a destination's origin facts, or null. */
function readOriginFacts(destDir, skill) {
  const abs = join(destDir, 'meta', skill, 'origin.yaml');
  if (!existsSync(abs)) return null;
  const facts = {};
  for (const raw of readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^([a-z_]+):\s*'?(.*?)'?\s*$/);
    if (m) facts[m[1]] = m[2];
  }
  return facts;
}

/**
 * Execute the destination half.
 *
 * @param {{repoRoot: string}} ctx
 * @param {object} entry - the local skill (may be null when it is already gone from here)
 * @param {string} skill
 * @param {{destination: string, apply: boolean, force: boolean, json: boolean}} opts
 */
async function runDestination(ctx, entry, skill, opts) {
  const { repoRoot } = ctx;
  const configured = configuredDestinations(repoRoot);
  const target = configured.find((d) => d.name === opts.destination) || null;
  if (!target) {
    throw new SidekicksError(
      `skill remove: unknown destination '${opts.destination}' — configured: `
      + `${configured.map((d) => d.name).join(', ') || '(none)'} `
      + "(see 'sidekicks framework config sk-skill-manager')",
      EXIT_VALIDATION
    );
  }
  if (!target.dir) {
    throw new SidekicksError(
      `skill remove: destination '${opts.destination}' has no local checkout configured — `
      + 'set its `checkout:` path before retracting anything from it',
      EXIT_VALIDATION
    );
  }
  const destDir = resolve(isAbsolute(target.checkout) ? target.checkout : join(repoRoot, target.checkout));
  // EXPORT's inverse guard, for the inverse reason: a "destination" resolving inside this repo's
  // own .sidekicks/ would make a retraction delete the source it was published from.
  if (isInside(destDir, join(repoRoot, '.sidekicks'))) {
    throw new SidekicksError(
      `skill remove: destination '${opts.destination}' resolves inside this repo's own .sidekicks/ `
      + `(${destDir}) — that is the source tree, not a published copy`,
      EXIT_VALIDATION
    );
  }
  if (!target.present) {
    throw new SidekicksError(
      `skill remove: destination '${opts.destination}' checkout is absent (${target.checkout}) — `
      + 'clone it before retracting anything from it',
      EXIT_VALIDATION
    );
  }

  // INTENT GATE. A skill pinned to exactly this destination has nowhere else it is allowed to live,
  // so retracting it there un-publishes it everywhere. That is a bigger decision than a republish
  // and it takes an explicit --force. `skill_repo: none` (published nowhere) and unset (publishable
  // anywhere) do not trip it — neither makes this destination the skill's only home.
  const intent = entry ? readDestinationIntent(entry) : null;
  if (intent === opts.destination && !opts.force) {
    throw new SidekicksError(
      `skill remove: ${skill} declares 'skill_repo: ${opts.destination}' — that destination is the `
      + 'ONLY place it is allowed to live, so removing it there unpublishes it entirely.\n'
      + "  Pass --force if that is the intent, or change the skill's own skill.yaml first.",
      EXIT_VALIDATION
    );
  }

  const skillDir = destinationSkillDir(destDir, skill);
  const metaDir = join(destDir, 'meta', skill);
  const catalogPath = join(destDir, 'catalog.yaml');
  const hasCatalogRow = existsSync(catalogPath)
    && dropCatalogRow(readFileSync(catalogPath, 'utf8'), skill).changed;

  if (!skillDir && !existsSync(metaDir) && !hasCatalogRow) {
    throw new SidekicksError(
      `skill remove: destination '${opts.destination}' does not carry ${skill} — nothing to retract `
      + `(run 'sidekicks skill destinations ${skill}' to see what it does carry)`,
      EXIT_VALIDATION
    );
  }

  const report = {
    ok: true,
    mode: 'destination',
    skill,
    destination: opts.destination,
    checkout: target.checkout,
    dry_run: !opts.apply,
    applied: false,
    forced: Boolean(opts.force),
    intent,
    removes: {
      folder: skillDir ? relativeTo(destDir, skillDir) : null,
      meta: existsSync(metaDir) ? `meta/${skill}` : null,
      catalog_row: hasCatalogRow,
    },
    tombstone: `meta/${skill}/origin.yaml`,
    git_status: '',
  };

  if (opts.apply) {
    const at = nowBangkok();
    const previous = readOriginFacts(destDir, skill);
    if (skillDir) rmrf(skillDir);
    // The whole meta folder goes — requirements.lock.txt and the framework/ reference copies too —
    // and then the tombstone is written back into it. Order matters: rmrf first, write second.
    rmrf(metaDir);
    writeAtomic(join(metaDir, 'origin.yaml'), renderRetraction(previous, skill, at));
    if (hasCatalogRow) {
      const next = dropCatalogRow(readFileSync(catalogPath, 'utf8'), skill);
      if (next.changed) writeAtomic(catalogPath, next.text);
    }
    report.applied = true;
    report.retracted_at = at;
    report.git_status = gitStatusShort(destDir);
  }

  if (opts.json) {
    return { stdout: JSON.stringify(report, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: renderDestination(report) + '\n', exitCode: EXIT_OK };
}

/** A path relative to the destination root, in POSIX form. */
function relativeTo(base, abs) {
  const b = base.endsWith('/') || base.endsWith('\\') ? base : `${base}/`;
  const s = abs.split('\\').join('/');
  const bb = b.split('\\').join('/');
  return s.startsWith(bb) ? s.slice(bb.length) : s;
}

/** The human-facing destination report. */
function renderDestination(r) {
  const out = [];
  out.push(r.dry_run
    ? `DRY RUN — skill remove ${r.skill} --destination ${r.destination} (nothing written)`
    : `skill remove: retracted ${r.skill} from destination '${r.destination}'`);
  out.push('');
  out.push(`  checkout    ${r.checkout}`);
  if (r.removes.folder) out.push(`  delete      ${r.removes.folder}`);
  if (r.removes.meta) out.push(`  delete      ${r.removes.meta}/ (except the tombstone below)`);
  if (r.removes.catalog_row) out.push('  edit        catalog.yaml — drop the row, decrement skill_count');
  out.push(`  tombstone   ${r.tombstone} — 'retracted: true', so 'skill destinations' reports`);
  out.push("              'retracted' rather than 'never-exported'");
  if (r.intent) out.push(`  intent      the skill declares 'skill_repo: ${r.intent}'${r.forced ? ' (--force given)' : ''}`);

  if (!r.dry_run) {
    out.push('', 'Destination git status — NOTHING was committed or pushed:');
    if (r.git_status) {
      for (const line of r.git_status.split('\n')) out.push(`  ${line}`);
    } else {
      out.push('  (clean, or not a git checkout)');
    }
    out.push('', '  Review the diff, then commit and push it yourself — to a BRANCH, never main.');
  } else {
    out.push('', `  apply with 'sidekicks skill remove ${r.skill} --destination ${r.destination} --apply'`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run `skill remove`.
 *
 * @param {{repoRoot: string, argv: string[], flags: object}} ctx
 * @param {{name?: string}} args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, args) {
  const flags = parseSkillFlags(ctx.argv, ['apply', 'force', 'json', 'dry-run', 'purge-profile']);
  // Read positionals from argv: the dispatcher cannot know --destination takes a value, so it
  // hands the destination name on as a positional (see _shared.mjs positionalArgs).
  const names = positionalArgs(ctx.argv, ['destination']);
  const skill = names[0] || (args && args.name) || null;

  if (!skill) {
    throw new SidekicksError(
      "skill remove: missing required argument <skill> — run 'sidekicks skill list' to see them",
      EXIT_USAGE
    );
  }
  if (names.length > 1) {
    throw new SidekicksError(
      `skill remove: one skill at a time — got ${names.join(', ')}. Removal unwinds wiring and `
      + 'prunes settings, and a partial failure across a batch is not recoverable in one report.',
      EXIT_USAGE
    );
  }

  const destination = typeof flags.destination === 'string' && flags.destination
    ? String(flags.destination)
    : null;
  const apply = Boolean(flags.apply);
  const json = Boolean(flags.json);

  if (apply && flags['dry-run']) {
    throw new SidekicksError(
      'skill remove: --apply and --dry-run are opposites — dry run is already the default, so pass '
      + 'neither to plan and --apply to execute',
      EXIT_USAGE
    );
  }

  if (destination) {
    if (flags['purge-profile']) {
      throw new SidekicksError(
        'skill remove: --purge-profile is a LOCAL concern — the registration receipt records what an '
        + 'import did in THIS repo, and retracting a published copy neither reads nor writes it. Drop '
        + 'the flag, or run the local removal separately.',
        EXIT_USAGE
      );
    }
    // The skill may already be gone from here — retracting a copy of something this repo no longer
    // has is the whole point of a cleanup pass, so a missing local entry is not an error.
    const entry = discoverSkills(ctx.repoRoot).find((s) => s.skill === skill) || null;
    return runDestination(ctx, entry, skill, { destination, apply, force: Boolean(flags.force), json });
  }

  const [entry] = resolveTargets(ctx.repoRoot, skill, { all: false, verb: 'skill remove' });

  const floor = requiredFloor(ctx.repoRoot);
  if (floor.has(skill)) {
    throw new SidekicksError(
      `skill remove: '${skill}' is on the REQUIRED floor — every forged runtime carries it whatever `
      + 'the operator selected, and no flag turns that off.\n'
      + `  Floor: ${[...floor].join(', ')}\n`
      + '  Source: .agents/skills/sk-inherit/assets/presets.yaml → `required:`\n'
      + '  Removing it would produce runtimes that cannot manage themselves. --force does not apply here.',
      EXIT_VALIDATION
    );
  }

  return runLocal(ctx, entry, { apply, json, purgeProfile: Boolean(flags['purge-profile']) });
}
