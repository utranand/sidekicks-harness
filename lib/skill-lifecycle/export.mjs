// lib/skill-lifecycle/export.mjs
// `sidekicks skill export <skill>… | --preset <p> [--output <path>] [--with-deps] [--scope runtime|all]
//                        [--source-repo <url>] [--dry-run] [--strict] [--json]`
//
// Copy skills, with everything they declare, into a skills-repository tree.
//
// REPORTS FIRST. `--dry-run` prints the closure table and writes nothing; that is the mode to run
// before the first real export, because the interesting output is not "it copied 21 folders" but
// "these are the 21 folders, and these four things they need do NOT travel".
//
// NO GIT. This verb writes files and stops. Committing and pushing is the operator's, for the same
// reason `sk-inherit create` and `package create` leave it alone: publishing to a remote is
// outward-facing and irreversible, and it may be cached or indexed even if later deleted. Pushing to
// a shared `main` from inside a copy verb is not a thing this repo does.
//
// --output IS THE AUTHORIZATION to write outside the repo, so assertWritable() is deliberately NOT
// called on the destination (the guard permits only `projects/<name>/`, `.sidekicks/` and
// `.agents/skills/`). Same treatment as `package create --output` and inherit's `--target`. The
// destinations that ARE refused are the two the export READS — this repo's own `.sidekicks/` and its
// `.agents/skills/` — because writing into the tree being read would mutate the source.
//
// LAYOUT. A destination receives `<output>/.agents/skills/<name>` for an active skill and
// `<output>/.sidekicks/skill-offloaded/<name>` for a parked one (layout 2, LAYOUT_VERSION in
// lib/skill-package/portable.mjs). The two are looked up through `publishedTreeFor()` rather than
// derived from a tree basename: they no longer share a parent, and re-joining a basename onto a fixed
// prefix writes to a directory nothing reads while reporting success.
//
// PROVENANCE IS PUBLISHED, so it is overridable. `source_repo` lands in the destination's
// `catalog.yaml` and in every `meta/<skill>/origin.yaml`, i.e. in a repo that may be public while
// the tree being exported from is not. Defaulting it to this repo's git remote is right for the
// common case and wrong for a private source publishing to a public destination, so
// `--source-repo <url>` names the repo the copies should be attributed to (the published framework
// core), and `--source-repo=''` records no source repo at all.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawnSync } from 'node:child_process';
import { SKILLS_ROOT_SEGMENTS } from '../sk-cli/skill-trees.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION, EXIT_USAGE, SidekicksError } from '../sk-cli/errors.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
// Containment lives in one place now (lib/fs-safety/canonical-path.mjs): these two helpers were
// this file's private copy, and `package create`/`package transfer` each had a weaker one.
import { isInside, sameDir } from '../fs-safety/canonical-path.mjs';
import { discoverSkills, readSkillManifest, readSkillDescriptor, derivedSections } from '../skill-manifest/read.mjs';
import { skillClosure } from '../skill-package/closure.mjs';
import {
  bundleFileList, copyBundle, renderOrigin, renderCatalog, pinRequirements, LAYOUT_VERSION,
} from '../skill-package/portable.mjs';
import { headCommit, currentBranch, remoteUrl } from '../git-delegation/git.mjs';
// Imported rather than re-derived: a THIRD copy of the Asia/Bangkok formatting would be one more
// place for the repo's timestamp convention to drift, and this one is already public-exported.
import { nowBangkok } from '../artifacts-lifecycle/_shared.mjs';
import { parseSkillFlags, positionalArgs } from './_shared.mjs';
import {
  configuredDestinations, readDestinationIntent, exportSettings, publishedTreeFor,
} from './destinations.mjs';

/** Resolve `--preset <name>` against sk-inherit's preset file — one preset list, not two. */
export function readPreset(repoRoot, name) {
  const abs = join(repoRoot, ...SKILLS_ROOT_SEGMENTS, 'sk-inherit', 'assets', 'presets.yaml');
  if (!existsSync(abs)) return null;
  const out = [];
  let inTarget = false;
  for (const raw of readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const header = line.match(/^([a-z][a-z0-9-]*):\s*$/);
    if (header) { inTarget = header[1] === name; continue; }
    if (!inTarget) continue;
    const item = line.match(/^\s+-\s+(\S+)/);
    if (item) out.push(item[1]);
  }
  return out.length ? out : null;
}

/** The audit group a skill belongs to, for the catalog row. Null when ungrouped (external). */
function groupOf(repoRoot, skill) {
  const abs = join(
    repoRoot, ...SKILLS_ROOT_SEGMENTS, 'sk-skill-auditor', 'assets', 'audit-groups.yaml'
  );
  if (!existsSync(abs)) return null;
  let current = null;
  for (const raw of readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s+-\s+(\S+)/);
    if (item) { if (item[1] === skill && current !== 'single') return current; continue; }
    const header = line.match(/^\s+([a-z][a-z0-9-]*):\s*$/);
    if (header) { current = header[1]; continue; }
    if (/^\S/.test(line)) current = null;
  }
  return null;
}

/**
 * The PUBLICATION family a skill browses under, which is not the same question as its audit group.
 *
 * `.agents/skills/sk-skill-manager/assets/categories.yaml` may name a skill explicitly;
 * otherwise its audit group is its family. Overloading `group` instead would have made the auditor's
 * coverage and the published taxonomy able to move each other silently — see that file's header.
 *
 * Parsed with the same narrow line reader as groupOf() rather than the YAML subset, because the two
 * files have the same shape and one reader is easier to keep honest than two.
 *
 * @returns {string|null} family name, or null when the skill has neither an entry nor a group
 */
function categoryOf(repoRoot, skill) {
  const abs = join(
    repoRoot, ...SKILLS_ROOT_SEGMENTS, 'sk-skill-manager', 'assets', 'categories.yaml'
  );
  if (existsSync(abs)) {
    let current = null;
    for (const raw of readFileSync(abs, 'utf8').split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const item = line.match(/^\s+-\s+(\S+)/);
      if (item) { if (item[1] === skill) return current; continue; }
      const header = line.match(/^([a-z][a-z0-9-]*):\s*$/);
      if (header) { current = header[1]; continue; }
    }
  }
  return groupOf(repoRoot, skill);
}

/**
 * Every skill in a publication family, in name order.
 *
 * The counterpart to `--preset`, and needed as its own selector because the two answer different
 * questions and give different answers. `--preset framework` is what a RUNTIME carries, and it
 * includes `skill-creator` — vendored work that travels into a runtime but may not be republished,
 * so a preset-driven publish is refused by the intent gate. `--category framework` is what the
 * PUBLIC family holds, which is the set an export actually wants.
 *
 * Derived rather than listed: a family's membership is `categoryOf()` over every discovered skill,
 * so an explicit entry in categories.yaml and an audit-group default are resolved the same way and
 * cannot drift apart.
 *
 * @returns {string[]|null} member names, or null when no skill claims the family
 */
export function readCategory(repoRoot, name) {
  const members = discoverSkills(repoRoot)
    .filter((entry) => categoryOf(repoRoot, entry.skill) === name)
    .map((entry) => entry.skill);
  return members.length ? members : null;
}

function versionOf(entry) {
  const abs = join(entry.dir, 'VERSION.json');
  if (!existsSync(abs)) return '0.0.0';
  try { return JSON.parse(readFileSync(abs, 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

/**
 * Plan an export. Pure: reads, hashes, decides — writes nothing.
 *
 * @param {string} repoRoot
 * @param {string[]} names
 * @param {{scope?: string, withDeps?: boolean}} [opts]
 */
export function exportPlan(repoRoot, names, opts = {}) {
  const closure = skillClosure(repoRoot, names, { scope: opts.scope });
  const seeds = new Set(names);
  // Without --with-deps the export carries only what was ASKED for, and REPORTS the rest. Same
  // convention as `package transfer` — a silently-widened copy is as surprising as a silently
  // narrowed one, so the choice stays the caller's.
  const carried = opts.withDeps
    ? closure.selected
    : closure.selected.filter((s) => seeds.has(s.skill));
  const omitted = opts.withDeps
    ? []
    : closure.selected.filter((s) => !seeds.has(s.skill)).map((s) => s.skill);

  const units = [];
  const blocked = [];
  for (const entry of carried) {
    const list = bundleFileList(repoRoot, entry);
    // A recorded file that is MISSING or whose hash MOVED means the baseline no longer describes the
    // folder, and copying past that just relocates the drift. An unrecorded extra file is the same
    // question from the other side. Both stop the export and name the fix.
    if (list.stale.length) {
      blocked.push({ skill: entry.skill, stale: list.stale });
      continue;
    }
    const read = readSkillManifest(repoRoot, entry);
    const descriptor = readSkillDescriptor(repoRoot, entry);
    // `null` is passed THROUGH, not short-circuited. Hook ownership is derived from the registry's
    // `owners` list, not from the skill's descriptor, so `derivedSections(null, skill)` still returns
    // the hooks that skill owns — every other caller relies on exactly that. Guarding on the
    // descriptor made a skill with no skill.yaml report zero hooks: `sk-artifact-manager` (two) and
    // `sk-validation-gate` (one) published an origin.yaml claiming no outward hook edges at all.
    const derived = derivedSections(descriptor, entry.skill);
    const req = (read.manifest && read.manifest.requires) || null;
    units.push({
      entry,
      skill: entry.skill,
      tree: entry.tree,
      version: versionOf(entry),
      group: groupOf(repoRoot, entry.skill),
      category: categoryOf(repoRoot, entry.skill),
      first_party: Boolean(groupOf(repoRoot, entry.skill)) || entry.skill === 'sk-skill-auditor',
      files: list.files,
      source: list.source,
      manifest: list.manifest,
      config_block: derived.config ? derived.config.block : null,
      python: req ? req.python.map((p) => p.package || p.import) : [],
      // The hook SCRIPT paths, kept beside the ids rather than in place of them. `outside_edges`
      // records ids because that is what a destination reconciles — a hook is its wiring in four CLI
      // configs (Rule 6), and an id is what names that. But the id alone cannot be copied, and every
      // document that describes this repo's layout says the body ships to `meta/<skill>/framework/`
      // as reference. Dropping the script path here is what made that claim false for seven hooks.
      hook_scripts: derived.framework_hooks.map((h) => h.script).filter(Boolean),
      outside_edges: {
        sibling_skills: req ? req.sibling_skills.map((s) => s.skill) : [],
        framework_files: req ? req.framework_files.map((f) => f.path) : [],
        framework_hooks: derived.framework_hooks.map((h) => h.id),
        host_paths: req ? req.host_paths.map((h) => h.path) : [],
        binaries: req ? req.binaries.map((b) => b.name) : [],
      },
    });
  }

  return { closure, units, omitted, blocked };
}

/**
 * Run `skill export`.
 *
 * @param {{repoRoot: string, argv: string[]}} ctx
 * @param {{name?: string, rest?: string[]}} args
 */
export async function run(ctx, args) {
  const flags = parseSkillFlags(ctx.argv, ['with-deps', 'dry-run', 'json', 'strict']);
  // Read positionals from argv rather than args.name/args.rest: the dispatcher cannot know that
  // --preset, --output and --scope take values, so it hands their values on as positionals.
  let names = positionalArgs(ctx.argv, ['preset', 'category', 'output', 'scope', 'source-repo', 'destination']);
  if (typeof flags.preset === 'string' && flags.preset) {
    const preset = readPreset(ctx.repoRoot, flags.preset);
    if (!preset) {
      throw new SidekicksError(
        `skill export: unknown preset '${flags.preset}' — see `
        + '.agents/skills/sk-inherit/assets/presets.yaml',
        EXIT_USAGE
      );
    }
    names = [...new Set([...names, ...preset])];
  }
  // --category is the publication-side selector. Use it rather than --preset to publish a family:
  // a preset is what a RUNTIME carries and may legitimately include vendored skills that must not
  // be republished, which the intent gate below then refuses — correctly, but after the operator
  // has already typed the wrong command.
  if (typeof flags.category === 'string' && flags.category) {
    const members = readCategory(ctx.repoRoot, flags.category);
    if (!members) {
      throw new SidekicksError(
        `skill export: no skill is in category '${flags.category}' — see `
        + '.agents/skills/sk-skill-manager/assets/categories.yaml',
        EXIT_VALIDATION
      );
    }
    names = [...new Set([...names, ...members])];
  }
  if (!names.length) {
    throw new SidekicksError(
      'skill export: name at least one skill, or pass --category <family> (publication) or '
      + "--preset <name> (runtime set) — run 'sidekicks skill list'",
      EXIT_USAGE
    );
  }

  const known = new Set(discoverSkills(ctx.repoRoot).map((s) => s.skill));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length) {
    throw new SidekicksError(
      `skill export: unknown skill(s): ${unknown.join(', ')} — run 'sidekicks skill list'`,
      EXIT_VALIDATION
    );
  }

  const scope = flags.scope === 'all' ? 'all' : 'runtime';
  const withDeps = Boolean(flags['with-deps']);
  const dryRun = Boolean(flags['dry-run']);

  const plan = exportPlan(ctx.repoRoot, names, { scope, withDeps });

  // --strict refuses to produce a tree with a KNOWN hole in it. Off by default, because a
  // deliberately partial export (one family, to be merged with another) is legitimate.
  if (flags.strict && (plan.closure.missing.length || plan.omitted.length)) {
    throw new SidekicksError(
      'skill export --strict: the closure is incomplete\n'
      + plan.closure.missing.map((m) => `  missing sibling: ${m.skill} (needed by ${m.needed_by.join(', ')})`).join('\n')
      + (plan.omitted.length ? `\n  not carried without --with-deps: ${plan.omitted.join(', ')}` : ''),
      EXIT_VALIDATION
    );
  }
  if (plan.blocked.length) {
    throw new SidekicksError(
      'skill export: refusing to export a stale tree — the recorded baseline does not describe the folder\n'
      + plan.blocked.map((b) => `  ${b.skill}: `
        + b.stale.map((s) => `${s.rel} (${s.reason})`).join(', ')).join('\n')
      + "\n  fix with 'sidekicks skill heal <skill> --restore --apply' (put the recorded content back)"
      + "\n  or   'sidekicks skill manifest <skill> --apply' (record the current state)",
      EXIT_VALIDATION
    );
  }

  // WHICH repository this export is aimed at, by name. `--output <path>` stays the raw form, but a
  // path alone cannot answer "may this skill be published here" — so a configured destination is
  // resolvable by name, and an --output that lands on a configured checkout is recognised as that
  // destination rather than treated as anonymous.
  const configured = configuredDestinations(ctx.repoRoot);
  const namedDestination = typeof flags.destination === 'string' && flags.destination
    ? String(flags.destination)
    : null;
  if (namedDestination && flags.output) {
    throw new SidekicksError(
      'skill export: pass --destination <name> or --output <path>, not both — the destination '
      + 'names a configured checkout, which IS the output path',
      EXIT_USAGE
    );
  }
  let target = null;
  if (namedDestination) {
    target = configured.find((d) => d.name === namedDestination) || null;
    if (!target) {
      throw new SidekicksError(
        `skill export: unknown destination '${namedDestination}' — configured: `
        + `${configured.map((d) => d.name).join(', ') || '(none)'} `
        + "(see 'sidekicks framework config sk-skill-manager')",
        EXIT_VALIDATION
      );
    }
    if (!target.dir) {
      throw new SidekicksError(
        `skill export: destination '${namedDestination}' has no local checkout configured — `
        + 'set its `checkout:` path, or pass --output <path>',
        EXIT_VALIDATION
      );
    }
  }

  const outputBase = target
    ? resolve(target.dir)
    : (flags.output ? resolve(String(flags.output)) : join(ctx.repoRoot, 'output', 'skills'));

  // An --output that resolves to a configured checkout is that destination — recognising it is what
  // keeps the intent gate below honest for the existing --output workflow.
  const destination = target || configured.find((d) => d.dir && sameDir(d.dir, outputBase)) || null;
  const destinationName = destination ? destination.name : null;

  // DESTINATION INTENT — the gate that separates a deliberately withheld skill from an unexported
  // one. `skill_repo: none` in a skill's own skill.yaml means it is published nowhere;
  // `skill_repo: <name>` pins it to one repository. Unset means no declared intent, which exports
  // anywhere, so this gate only ever fires on a skill whose author said something.
  //
  // WHAT THE OPERATOR NAMED IS AN ERROR; WHAT THE CLOSURE PULLED IN IS A REPORT. Asking to publish a
  // withheld skill is a mistake worth stopping for. Reaching one through `--with-deps` is not:
  // vendored work is routinely a legitimate DEPENDENCY of publishable skills (the framework family
  // declares `skill-creator` in `depends-on`), and refusing there would mean a family could never be
  // published at all. So a closure-only withheld skill is dropped from the copy and named in the
  // report — the same treatment as any other edge that cannot travel.
  const seeds = new Set(names);
  const violations = [];
  const withheld = [];
  for (const u of plan.units) {
    const intent = readDestinationIntent(u.entry);
    if (!intent) continue;
    const reason = intent === 'none'
      ? "declares 'skill_repo: none' — withheld from every destination"
      : (destinationName && intent !== destinationName
        ? `declares 'skill_repo: ${intent}' but this export targets '${destinationName}'`
        : null);
    if (!reason) continue;
    if (seeds.has(u.skill)) violations.push(`${u.skill}: ${reason}`);
    else withheld.push({ skill: u.skill, intent, reason });
  }
  if (violations.length) {
    throw new SidekicksError(
      'skill export: refusing to publish against declared destination intent\n'
      + violations.map((v) => `  ${v}`).join('\n')
      + "\n  fix the skill's own skill.yaml `skill_repo:` value, or export to the destination it names",
      EXIT_VALIDATION
    );
  }
  if (withheld.length) {
    const drop = new Set(withheld.map((w) => w.skill));
    plan.units = plan.units.filter((u) => !drop.has(u.skill));
  }
  // Compared through realpath on BOTH sides. A plain string prefix check misses the case that
  // matters: on macOS `/tmp` and `/var` are symlinks to `/private/...`, so process.cwd() reports the
  // resolved form while an --output the operator typed does not — and the guard silently passed a
  // destination inside the source tree.
  //
  // BOTH source trees are guarded, not just `.sidekicks/`. When the canonical tree lived under
  // `.sidekicks/skills` one check covered everything an export reads; Rule 3 moved the active tree to
  // `.agents/skills`, leaving the tree that holds 122 of the 140 skills outside the only guard there
  // was. `.agents/skills` is named as its own segments rather than `.agents`, matching fs-guard.mjs:
  // `.agents/plugins/` is ordinary agent territory and a legitimate export destination.
  for (const forbidden of [join(ctx.repoRoot, '.sidekicks'), join(ctx.repoRoot, ...SKILLS_ROOT_SEGMENTS)]) {
    if (!isInside(outputBase, forbidden)) continue;
    throw new SidekicksError(
      `skill export: --output must not resolve inside this repo's own `
      + `${relative(ctx.repoRoot, forbidden) || '.'}/ (${outputBase}) — `
      + 'an export writing into the tree it is reading would mutate the source',
      EXIT_VALIDATION
    );
  }

  const exportedAt = nowBangkok();
  // Provenance is a nicety, not a requirement: a skills tree exported from a repo with no git, no
  // commits or no remote is still a valid skills tree. These three throw EXIT_GIT on a non-repo, so
  // they are contained here rather than turning "no git" into a failed export.
  const provenance = gitProvenance(ctx.repoRoot);
  const { sourceCommit, sourceBranch } = provenance;
  // WHO THE COPIES ARE ATTRIBUTED TO, most specific answer first:
  //   1. --source-repo, which wins even when empty: `--source-repo=''` is how an operator says
  //      "attribute these to no repo at all", and a fallback would silently overrule that.
  //   2. the destination's own `source_repo:`, when public and private differ.
  //   3. `skill_manager.export.source_repo` — the published framework core.
  //   4. this repo's git remote.
  //
  // The config layers exist because forgetting the flag once publishes the PRIVATE working repo's
  // URL into a public catalog.yaml and every meta/<skill>/origin.yaml. That is not a hypothetical:
  // it happened on 2026-08-15, and it happened because the config already carried the right answer
  // and nothing read it.
  const configuredSourceRepo = (destination && destination.source_repo)
    || exportSettings(ctx.repoRoot).source_repo
    || '';
  const sourceRepo = 'source-repo' in flags
    ? String(flags['source-repo'])
    : (configuredSourceRepo || provenance.sourceRepo);

  const report = {
    ok: true,
    layout: LAYOUT_VERSION,
    output: dryRun ? null : outputBase,
    destination: destinationName,
    dry_run: dryRun,
    source_repo: sourceRepo,
    scope,
    with_deps: withDeps,
    carried: plan.units.map((u) => ({
      skill: u.skill, version: u.version, files: u.files.length, source: u.source,
      group: u.group, category: u.category,
    })),
    omitted: plan.omitted,
    // Reached through the closure but withheld by its own `skill_repo:` — carried by no export to
    // this destination, so a reader of the destination has to obtain it elsewhere.
    withheld: withheld.map((w) => ({ skill: w.skill, intent: w.intent, why: w.reason })),
    missing_siblings: plan.closure.missing,
    no_manifest: plan.closure.no_manifest,
    outside: {
      framework_files: plan.closure.framework_files.map((f) => f.path),
      framework_hooks: plan.closure.framework_hooks.map((h) => h.id),
      host_paths: plan.closure.host_paths.map((h) => h.path),
      binaries: plan.closure.binaries.map((b) => b.name),
    },
    python: plan.closure.python.map((p) => p.package),
    wrote: [],
    // Separate from `wrote` on purpose. `wrote` lists what the destination PUBLISHES; these are inert
    // reference copies under meta/ that the destination must reconcile by hand and must never apply.
    // Collapsing them into one list is how "we shipped the hook" gets read as "the hook is wired".
    reference_copies: [],
  };

  if (!dryRun) {
    const freeze = pipFreeze(ctx.repoRoot);
    // THE DESTINATION'S ROOT MARKER. `resolveRepoRoot` (lib/sk-cli/paths.mjs) finds a repo root by
    // walking up for a `.sidekicks/`, and running `skill verify` INSIDE the destination is the whole
    // integrity check — a hash-only pass needing no git, no network and no registry, which is what
    // makes "the copy arrived intact" a checkable claim rather than an assertion.
    //
    // Layout 1 satisfied that by accident: it wrote every skill under `.sidekicks/skills/`, so the
    // directory always existed. Layout 2 publishes active skills to `.agents/skills/`, so a
    // destination holding only active skills would have no `.sidekicks/` at all and every verb run
    // there would die with "not inside a Sidekicks repository" — walking up out of the destination
    // and into whatever repo happens to contain it, which is worse than failing.
    //
    // So the placeholder is written explicitly. Both published repos already carry exactly this file,
    // so this is the existing on-disk shape rather than a new one.
    writeAtomic(join(outputBase, '.sidekicks', 'skill-offloaded', '.gitkeep'), '');
    for (const u of plan.units) {
      // The WHOLE tree path is mapped, never a basename re-joined onto a fixed prefix. `.agents/skills`
      // and `.sidekicks/skill-offloaded` do not share a parent, so a basename cannot say where a skill
      // publishes — and the failure mode of pretending it can is a write to a directory nothing reads,
      // reported as success. `tree:` in origin.yaml carries the same full path for the same reason.
      const publishedTree = publishedTreeFor(u.tree);
      const destSkill = join(outputBase, ...publishedTree.split('/'), u.skill);
      const { copied } = copyBundle(u.entry, destSkill, u.files);
      report.wrote.push(`${publishedTree}/${u.skill} (${copied.length} files)`);

      const facts = {
        skill: u.skill, version: u.version, tree: publishedTree,
        source_repo: sourceRepo, source_commit: sourceCommit, source_branch: sourceBranch,
        exported_at: exportedAt, bundle_verified: u.source === 'bundle',
        file_count: u.files.length, outside_edges: u.outside_edges,
        group: u.group, category: u.category, first_party: u.first_party, manifest: u.manifest,
        python: u.python, config_block: u.config_block,
      };
      writeAtomic(join(outputBase, 'meta', u.skill, 'origin.yaml'), renderOrigin(facts));
      if (u.python.length) {
        writeAtomic(
          join(outputBase, 'meta', u.skill, 'requirements.lock.txt'),
          pinRequirements(u.python, freeze)
        );
      }
      // REFERENCE copies of the outward files, never auto-applied at the destination: a repo-root
      // file and a hook belong to the destination repo, and copying one in blind is how an import
      // breaks the repo it meant to extend.
      //
      // Hook BODIES travel by the same path, which is what SKILL.md, references/skill-repo-layout.md,
      // the generated NOT-CARRIED.md and docs/guide/v1.5 all already promised — and what nothing did:
      // only framework_files were copied, so 0 of 7 hook bodies reached either published repo while
      // four documents said otherwise. The body is reference material precisely because it is inert
      // without the four-CLI wiring the id names; shipping it lets a destination read what it has to
      // reconcile instead of guessing. A script listed BOTH as a framework_file and as a hook body
      // copies once — same bytes, same destination path.
      for (const rel of new Set([...u.outside_edges.framework_files, ...u.hook_scripts])) {
        const src = join(ctx.repoRoot, ...rel.split('/'));
        if (existsSync(src)) {
          writeAtomic(join(outputBase, 'meta', u.skill, 'framework', ...rel.split('/')), readFileSync(src));
          report.reference_copies.push(`meta/${u.skill}/framework/${rel}`);
        }
      }
    }

    writeAtomic(
      join(outputBase, 'catalog.yaml'),
      renderCatalog(
        { generated_at: exportedAt, source_repo: sourceRepo, source_commit: sourceCommit },
        plan.units.map((u) => ({
          skill: u.skill, version: u.version, group: u.group, category: u.category,
          first_party: u.first_party,
          manifest: u.manifest, python: u.python, config_block: u.config_block,
          file_count: u.files.length, outside_edges: u.outside_edges,
        }))
      )
    );
    report.wrote.push('catalog.yaml');
  }

  if (flags.json) {
    return { stdout: JSON.stringify(report, null, 2) + '\n', exitCode: EXIT_OK };
  }

  const out = [];
  out.push(dryRun
    ? `DRY RUN — skill export (layout ${LAYOUT_VERSION}, scope ${scope})`
    : `skill export: wrote ${plan.units.length} skill(s) to ${outputBase}`);
  out.push('');
  out.push(`Carried (${plan.units.length}):`);
  for (const u of plan.units) {
    out.push(`  ${u.skill} ${u.version} — ${u.files.length} files`
      + `${u.source === 'walk' ? '  [no baseline: copy is UNVERIFIED]' : ''}`);
  }
  if (plan.omitted.length) {
    out.push('', `Declared siblings NOT carried (pass --with-deps to include ${plan.omitted.length}):`);
    for (const s of plan.omitted) out.push(`  ${s}`);
  }
  if (report.withheld.length) {
    out.push('', `WITHHELD by their own skill.yaml — reached through the closure, published nowhere here (${report.withheld.length}):`);
    for (const w of report.withheld) out.push(`  ${w.skill}  (${w.why})`);
    out.push('  Skills that depend on one still declare it; the destination must obtain it elsewhere.');
  }
  if (plan.closure.missing.length) {
    out.push('', 'Declared siblings that exist in NEITHER tree:');
    for (const m of plan.closure.missing) out.push(`  ${m.skill} (needed by ${m.needed_by.join(', ')})`);
  }
  const outside = report.outside;
  if (outside.framework_files.length || outside.framework_hooks.length
    || outside.host_paths.length || outside.binaries.length) {
    out.push('', 'Does NOT travel — reconcile these at the destination:');
    for (const p of outside.framework_files) out.push(`  framework file  ${p}`);
    for (const h of outside.framework_hooks) out.push(`  hook            ${h}  (plus wiring in 4 CLI configs — Rule 6)`);
    for (const p of outside.host_paths) out.push(`  host path       ${p}`);
    for (const b of outside.binaries) out.push(`  binary          ${b}`);
  }
  if (report.reference_copies.length) {
    out.push('', `Reference copies under meta/ (${report.reference_copies.length}) — inert, never applied:`);
    out.push('  framework files and hook bodies, so the destination can READ what it must reconcile.');
  }
  if (plan.closure.no_manifest.length) {
    out.push('', `Declared nothing (their closure cannot be checked): ${plan.closure.no_manifest.join(', ')}`);
  }
  out.push('');
  out.push(dryRun
    ? '  (nothing written — drop --dry-run to export)'
    : "  Next: review the tree, then commit and push it yourself — to a BRANCH, never main.");
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}


/**
 * Source repo, commit and branch — each independently optional.
 *
 * Every one of these throws EXIT_GIT on a directory that is not a git repository, which would turn a
 * perfectly valid export into a failure for a reason that has nothing to do with the skills.
 */
function gitProvenance(repoRoot) {
  const safe = (fn) => { try { return fn() || ''; } catch { return ''; } };
  return {
    sourceRepo: safe(() => remoteUrl(repoRoot)),
    sourceCommit: safe(() => headCommit(repoRoot)),
    sourceBranch: safe(() => currentBranch(repoRoot)),
  };
}

/** `pip freeze` from the repo-root .venv, or '' when there is none. */
function pipFreeze(repoRoot) {
  const pip = process.platform === 'win32'
    ? join(repoRoot, '.venv', 'Scripts', 'pip.exe')
    : join(repoRoot, '.venv', 'bin', 'pip');
  if (!existsSync(pip)) return '';
  const r = spawnSync(pip, ['freeze'], { shell: false, cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '') : '';
}
