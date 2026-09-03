// lib/skill-lifecycle/import.mjs
// `sidekicks skill import <skill>… | --all --from <path> [--adopt] [--apply] [--force] [--json]`
//
// Bring a skill in from ANY repository that holds skills, reconciling against what is already here.
//
// THE BASELINE IS FOUND, NOT INVENTED. A three-way compare needs a reference distinct from both
// sides, and the local skill's own `bundle{}` IS "the state a human last blessed": `skill verify` is
// precisely the question "has the local copy drifted from it". So the three sides are local-disk,
// local-recorded and incoming-recorded, and for a manifested skill nothing has to be written down to
// make that work. (sk-inherit maintains .sidekicks/inherit.json for the same job because it
// predates AAP-100 and its baseline covers non-skill surfaces too.)
//
// A skill that legitimately needs no manifest has no such baseline, and used to be refused for it —
// 23 of 107 rows against this repo's own two skills repositories. Those fall back to comparing
// CONTENT, which is weaker and says so per row (`verified: false`).
//
// FOREIGN SOURCES. `--from` no longer has to be a sidekicks skills repository. source-layout.mjs
// detects the shape (flat `skills/<n>/`, nested, `.claude/skills/`, bare root) and `--adopt` is the
// explicit consent required to convert one. Nothing about a foreign skill is rewritten: the folder
// is copied byte-exact, and everything a human must decide is emitted as plan lines by adopt.mjs.
//
// The statuses use inherit's STATUS_ORDER vocabulary deliberately, so an operator who has read one
// drift report can read the other. Shared WORDS, not shared code — a lib/ module may not import a
// skill's script, and a relative cross-skill reach is an audit error.
//
// WHAT AN IMPORT DID IS RECORDED. Every applied row writes a registration profile under
// `.sidekicks/registry/skills/` (lib/skill-registry/), because the side-effects of an import —
// where it came from, which criteria it turned on here, whether it was converted — are not
// derivable from the folder afterwards, and `skill remove` needs them. That is a receipt for an
// event, not a cache of facts that already exist elsewhere.
//
// IT NEVER WRITES OUTSIDE .sidekicks/. Hook wiring, repo-root files, AGENTS.md lines and audit-group
// membership come out as an ordered APPLY PLAN on stdout, for the operator to walk with the skill.
// A hook needs the same change in four per-CLI config files (Rule 6) and group membership is a
// judgement call; a verb that guessed at either would break the repo it was extending.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { SKILLS_ROOT_SEGMENTS, SKILLS_ROOT_REL, SKILL_TREE_BY_BASENAME } from '../sk-cli/skill-trees.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_OK, EXIT_VALIDATION, EXIT_USAGE, SidekicksError } from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { writeAtomic, execAwareMode } from '../fs-safety/fsx.mjs';
import {
  discoverSkills, readSkillManifest, readSkillDescriptor, MANIFEST_NAME,
} from '../skill-manifest/read.mjs';
import { parseManifest } from '../skill-manifest/schema.mjs';
import { hashContent, isBinaryPath } from '../skill-manifest/hash.mjs';
import { bundleFileList } from '../skill-package/portable.mjs';
import { readSource, LAYOUTS } from '../skill-package/source-layout.mjs';
import { adoptionPlan, marketplacePlugins } from '../skill-package/adopt.mjs';
import { recordProfile, mirrorFacts, fileHashes } from '../skill-registry/store.mjs';
import { buildRegistry } from '../framework-settings/registry.mjs';
import { configuredDestinations } from './destinations.mjs';
import { isRepo, remoteUrl, headCommit, currentBranch } from '../git-delegation/git.mjs';
import { nowBangkok } from '../artifacts-lifecycle/_shared.mjs';
import { scanSkill, walkSkillFiles, manifestRequired } from './scan.mjs';
import { parseSkillFlags, positionalArgs, backupSkillDir, collectRepeated } from './_shared.mjs';

/**
 * The reconcile statuses, in the order a report should present them — worst first, so a reader sees
 * what needs a decision before what needs nothing. Same vocabulary as sk-inherit's drift
 * report.
 */
export const STATUS_ORDER = Object.freeze([
  'broken', 'conflict', 'local-only', 'unversioned', 'new', 'ff', 'up-to-date',
]);

/** Statuses that refuse to proceed without --force. */
const NEEDS_FORCE = Object.freeze(new Set(['conflict', 'local-only', 'unversioned']));

/**
 * Statuses `--force` does NOT open.
 *
 * `--force` means "I accept losing the local side" — it has never meant "I accept importing
 * something corrupt". An incoming copy that contradicts its own manifest would be written next to
 * that manifest, so the very first `skill doctor` reports `bundle-stale` and the next export
 * refuses; the operator would have forced their way into a skill that cannot be published. The
 * answer is at the source: re-export it.
 */
const NEVER_APPLY = Object.freeze(new Set(['broken']));

/**
 * Every skill directory in a NATIVE incoming tree, keyed by name.
 *
 * Kept as the layout-1 shorthand over the general reader, because a native source is the only one
 * that needs no decisions: it already has the trees, the names and the manifests. Any other shape
 * goes through `readSource` with a layout, and through the `--adopt` gate.
 */
export function readIncoming(fromRoot) {
  return readSource(fromRoot, { layout: 'sidekicks' }).entries;
}

/**
 * The incoming skill's recorded bundle, whether its files match it, and how far it can be trusted.
 *
 * FOUR TRUST STATES, because "no manifest" is two entirely different facts and conflating them is
 * what blocked 23 of 107 rows against this repo's own skills repositories:
 *
 * - `intact`     — a manifest that parses and whose every hash matches. The only state with a
 *                  baseline to reason from.
 * - `broken`     — a manifest that is present but fails validation, or contradicts its own files.
 *                  Never importable; see NEVER_APPLY.
 * - `undeclared` — no manifest, and `manifestRequired()` says one IS required (the skill has
 *                  scripts/, third-party imports, sibling edges, binaries or a descriptor). Its
 *                  dependency closure is genuinely unknown, so this still stops.
 * - `walk`       — no manifest, and none is required. `manifestRequired` (scan.mjs) and
 *                  `skill doctor` both call this skill complete; only import used to call it
 *                  unversioned. There is no baseline, so comparison falls back to file CONTENT,
 *                  which is a weaker but perfectly real answer.
 *
 * A NON-NATIVE (foreign-layout) entry is always `walk`: an upstream repo has no reason to ship a
 * sidekicks manifest, and the apply plan generates one with `skill manifest --apply` after the copy.
 * Holding a foreign skill to `undeclared` would mean no foreign skill could ever be imported.
 *
 * The scan is LAZY — it only runs in the no-manifest lane, so a native `--all` over 84 manifested
 * rows pays nothing for it.
 */
function readIncomingState(entry, ctx = {}) {
  const abs = join(entry.dir, MANIFEST_NAME);
  if (existsSync(abs)) {
    const { manifest, errors } = parseManifest(readFileSync(abs, 'utf8'), entry.skill, entry.relDir);
    if (!manifest || errors.length) {
      return { bundle: null, trust: 'broken', intact: false, mismatches: errors };
    }
    const bundle = manifest.bundle || {};
    const mismatches = [];
    for (const [rel, recorded] of Object.entries(bundle)) {
      const f = join(entry.dir, ...rel.split('/'));
      if (!existsSync(f)) { mismatches.push(`${rel} (absent)`); continue; }
      if (hashContent(readFileSync(f), isBinaryPath(rel)) !== recorded) mismatches.push(`${rel} (hash)`);
    }
    return {
      bundle: mismatches.length ? null : bundle,
      trust: mismatches.length ? 'broken' : 'intact',
      intact: mismatches.length === 0,
      mismatches,
      requires: manifest.requires,
    };
  }

  if (entry.native === false) {
    return { bundle: null, trust: 'walk', intact: false, mismatches: [], because: [] };
  }
  const files = walkSkillFiles(entry.dir);
  const scan = scanSkill(ctx.fromRoot || entry.dir, entry, ctx.universe || new Set(), { files });
  const descriptor = readSkillDescriptor(ctx.fromRoot || entry.dir, entry);
  const { required, because } = manifestRequired(scan, Boolean(descriptor));
  return {
    bundle: null, trust: required ? 'undeclared' : 'walk', intact: false, mismatches: [], because,
  };
}

/**
 * The files an import would write, and whether that list came from a verified baseline.
 *
 * `source: 'walk'` is the honest half: nothing checked those bytes against a recording, and the
 * report says so per row rather than letting a walk-sourced copy look like a verified one. Same
 * distinction `bundleFileList` draws locally and `origin.yaml` records as `bundle_verified`.
 *
 * walkSkillFiles (not a raw readdir) because it already skips `node_modules`, `__pycache__`,
 * `.venv`, `.git` and `.pytest_cache` — exactly what a foreign checkout arrives carrying, and
 * exactly what must never be copied into `.sidekicks/`.
 */
function incomingFileList(entry, inState) {
  if (inState.bundle) {
    return { files: [...Object.keys(inState.bundle), MANIFEST_NAME].sort(), source: 'bundle' };
  }
  return { files: walkSkillFiles(entry.dir).map((f) => f.rel).sort(), source: 'walk' };
}

/** A stable fingerprint of a recorded bundle, for comparing two baselines. */
function bundleKey(bundle) {
  if (!bundle) return null;
  return Object.keys(bundle).sort().map((k) => `${k}=${bundle[k]}`).join('\n');
}

/**
 * A content fingerprint of a skill folder, EXCLUDING the manifest.
 *
 * The fallback discriminator when at least one side has no recorded baseline. The manifest is left
 * out on purpose: it is the thing being compared *with*, and one side lacking it is the very case
 * this exists to answer.
 */
function contentKey(dir) {
  const rows = [];
  for (const f of walkSkillFiles(dir)) {
    if (f.rel === MANIFEST_NAME) continue;
    rows.push(`${f.rel}=${hashContent(readFileSync(f.abs), isBinaryPath(f.rel))}`);
  }
  return rows.sort().join('\n');
}

/**
 * Classify one incoming skill against the local tree. Pure.
 *
 * @param {string} repoRoot
 * @param {object} incoming - an entry from readIncoming()
 * @param {Map<string, object>} localByName
 * @returns {{skill: string, status: string, detail: string, files: string[], incoming: object}}
 */
export function classifyIncoming(repoRoot, incoming, localByName, ctx = {}) {
  const inState = readIncomingState(incoming, ctx);
  const { files, source } = incomingFileList(incoming, inState);
  // The row is keyed by the name the skill lands under HERE. `upstream` is what the source calls
  // it, which is what a later re-import has to match on and what the profile records — the two
  // differ exactly when --rename resolved a collision.
  const localName = incoming.target || incoming.skill;
  const base = {
    skill: localName, upstream: incoming.skill, incoming, files, verified: source === 'bundle',
    file_source: source, requires: inState.requires,
  };

  // ── The two incoming states that stop before the local side is even looked at ────────────────
  if (inState.trust === 'broken') {
    return {
      ...base, status: 'broken',
      detail: inState.mismatches.length && inState.bundle === null && inState.intact === false
        ? `the incoming copy is not self-consistent: ${inState.mismatches.join(', ')}`
        : 'the incoming manifest does not validate, so nothing about this copy can be trusted',
    };
  }
  if (inState.trust === 'undeclared') {
    return {
      ...base, status: 'unversioned',
      detail: `the incoming copy carries no manifest but needs one (${
        (inState.because || []).join('; ')}) — its dependency closure is undeclared`,
    };
  }

  const local = localByName.get(localName);
  if (!local) return { ...base, status: 'new', detail: 'not present locally' };

  const localRead = readSkillManifest(repoRoot, local);
  const localBaselined = Boolean(localRead.present && localRead.manifest);
  // What the LOCAL baseline records. Carried on every row so applyOne can prune a file the incoming
  // version dropped — recorded-then-dropped is a deletion; an unrecorded stray is not ours to touch.
  // With no local baseline it stays empty, so nothing is prunable: there is nothing recorded to have
  // been dropped, and treating every untracked file as deletable is the opposite of that rule.
  const local_recorded = localBaselined
    ? [...Object.keys(localRead.manifest.bundle || {}), MANIFEST_NAME].sort()
    : [];
  const row = { ...base, local_recorded };

  // ── Both sides baselined: the original three-way reconcile, unchanged ────────────────────────
  if (inState.trust === 'intact' && localBaselined) {
    const localList = bundleFileList(repoRoot, local);
    const localClean = localList.stale.length === 0;
    const sameBaseline = bundleKey(localRead.manifest.bundle) === bundleKey(inState.bundle);

    if (localClean && sameBaseline) {
      return { ...row, status: 'up-to-date', detail: 'identical baselines, local is clean' };
    }
    if (localClean && !sameBaseline) {
      return {
        ...row, status: 'ff',
        detail: 'local matches its own baseline and the incoming baseline differs — a clean fast-forward',
      };
    }
    if (!localClean && sameBaseline) {
      return {
        ...row, status: 'local-only',
        detail: `local has uncommitted edits the export does not contain (${
          localList.stale.map((s) => `${s.rel} ${s.reason}`).join(', ')})`,
      };
    }
    return {
      ...row, status: 'conflict',
      detail: `both sides moved: local is stale against its own baseline (${
        localList.stale.map((s) => s.rel).join(', ')}) and the incoming baseline differs`,
    };
  }

  // ── At least one side has no baseline: fall back to comparing CONTENT ────────────────────────
  //
  // Weaker than a three-way compare and openly so — identical bytes mean there is nothing to do,
  // and that is a real answer no matter how it was reached. What content CANNOT say is who moved,
  // which is why every differing case below either resolves to an improvement (`ff`) or stops.
  const sameContent = contentKey(incoming.dir) === contentKey(local.dir);

  if (inState.trust === 'intact' && !localBaselined) {
    if (sameContent) {
      return {
        ...row, status: 'ff',
        detail: 'the local copy has the same bytes but no manifest — the import adds the baseline',
      };
    }
    return {
      ...row, status: 'unversioned',
      detail: 'the LOCAL copy carries no manifest, so there is nothing to attribute the difference to',
    };
  }

  // inState.trust === 'walk' — the incoming copy legitimately needs no manifest.
  if (sameContent) {
    return {
      ...row, status: 'up-to-date',
      detail: localBaselined
        ? 'byte-identical content; neither side needs a manifest the other has'
        : 'byte-identical content, and neither copy requires a manifest',
    };
  }
  if (localBaselined) {
    const localStale = bundleFileList(repoRoot, local).stale;
    if (!localStale.length) {
      // Local is baselined and clean; the incoming copy has no manifest at all. The difference is
      // work the export predates — `sk-squad` is the live case, having gained skill.yaml,
      // rules/ and a manifest since it was last published. Importing would delete all three.
      return {
        ...row, status: 'local-only',
        detail: 'local is baselined and clean while the incoming copy carries no manifest — '
          + 'the export predates local work; EXPORT rather than import',
      };
    }
    return {
      ...row, status: 'conflict',
      detail: `the incoming copy carries no manifest and local is stale against its own (${
        localStale.map((s) => s.rel).join(', ')})`,
    };
  }
  // Neither side records anything and the bytes differ. Content cannot say who moved, so this is
  // the one place the honest answer is "stop" — an overwrite here destroys local edits that nothing
  // in the repo would show you had existed.
  return {
    ...row, status: 'unversioned',
    detail: 'neither copy has a baseline and their content differs, so there is nothing to '
      + 'attribute the change to',
  };
}

/**
 * The plan for a whole import.
 *
 * @param {string} repoRoot
 * @param {string} fromRoot
 * @param {string[]|null} names - null means every skill in the incoming tree
 * @returns {{rows: object[], unknown: string[], apply_plan: string[]}}
 */
export function importPlan(repoRoot, fromRoot, names, opts = {}) {
  const incoming = opts.incoming || readIncoming(fromRoot);
  const localByName = new Map(discoverSkills(repoRoot).map((e) => [e.skill, e]));
  // Sibling claims are resolved against every skill either side knows about, so an incoming skill
  // reaching a skill that exists only here is a real edge, not an unknown name.
  const ctx = {
    fromRoot,
    // scanSkill matches names with Array#includes. Keep this as an array: a foreign skill that
    // carries a descriptor takes the manifest-free scan path during adoption, and a Set here
    // previously crashed that otherwise valid import before it could produce a plan.
    universe: [...new Set([...incoming.keys(), ...localByName.keys()])],
  };

  const wanted = names && names.length ? names : [...incoming.keys()].sort();
  const unknown = wanted.filter((n) => !incoming.has(n));
  const rows = wanted
    .filter((n) => incoming.has(n))
    .map((n) => classifyIncoming(repoRoot, incoming.get(n), localByName, ctx))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

  // Everything the verb will NOT do, in the order it has to be done. Derived from what the incoming
  // skills declare, so a hook or a repo-root file cannot be forgotten just because it is invisible
  // inside a folder copy.
  const apply_plan = [];
  const outward = {
    framework_files: new Set(),
    framework_hooks: new Set(),
    config_blocks: new Set(),
    framework_rules: new Set(),
  };
  for (const row of rows) {
    if (row.status === 'up-to-date') continue;
    // Read off the row rather than calling readIncomingState again: that function re-parses the
    // manifest AND re-hashes every file in the skill, so re-calling it here doubled the hashing work
    // for an `--all` run over a whole skills repository.
    const req = row.requires;
    if (!req) continue;
    for (const f of req.framework_files) outward.framework_files.add(f.path);
    for (const h of req.framework_hooks) outward.framework_hooks.add(h.id);
    if (req.config && req.config.block) outward.config_blocks.add(req.config.block);
    for (const r of req.framework_rules || []) outward.framework_rules.add(r.id);
  }
  for (const p of outward.framework_files) {
    apply_plan.push(`review meta/<skill>/framework/${p} and decide whether this repo carries ${p}`);
  }
  for (const id of outward.framework_hooks) {
    apply_plan.push(
      `wire hook ${id} in ALL FOUR CLI configs (.claude/settings.json, .codex/config.toml, `
      + '.gemini/settings.json, .agent/settings.json) — Rule 6, same change'
    );
  }
  // A criterion arrives ENABLED — an unlisted id resolves to the built-in default, and `framework
  // sync` then writes it as `true`. Importing a skill therefore turns its policies on in this repo
  // without anyone deciding to, which is exactly the thing worth naming on a checklist.
  for (const id of outward.framework_rules) {
    apply_plan.push(
      `review '${id}' — it arrived with the skill and resolves ENABLED here; turn it off with `
      + `'sidekicks framework disable ${id}' if this repo does not want it`
    );
  }
  for (const b of outward.config_blocks) {
    apply_plan.push(
      `decide what this scope needs for the '${b}' config block — 'sidekicks config sync' documents `
      + "it inert, so it keeps resolving to the skill's own defaults; "
      + `'sidekicks config set ${b}.<key> <value>' overrides one key and routes any credential to `
      + 'the git-ignored secret file'
    );
  }
  // A CONVERTED skill brings its own questions — attribution, python dependencies, whether it is
  // even yours to republish — and none of them is visible in a manifest, because it has none. The
  // plan is built per row by adopt.mjs, which reads the upstream folder and decides nothing.
  const adoptions = [];
  for (const row of rows) {
    if (row.status === 'up-to-date' || row.incoming.native !== false) continue;
    const a = adoptionPlan(fromRoot, row.incoming);
    adoptions.push(a);
    row.adoption = a;
    for (const step of a.steps) apply_plan.push(step);
  }

  // Only for a skill that is NOT already grouped here. A checklist step that is already done is
  // how a checklist trains people to skim it.
  const grouped = groupedSkills(repoRoot);
  for (const row of rows) {
    if (row.status === 'up-to-date' || grouped.has(row.skill)) continue;
    apply_plan.push(`place ${row.skill} in an audit group in audit-groups.yaml, or it lands unaudited`);
  }
  // Both halves of config/: the settings files list the incoming criteria, the family files
  // document the incoming blocks. See docs/guide/settings-vs-configuration.md.
  apply_plan.push('sidekicks framework sync');
  apply_plan.push('sidekicks config sync');
  for (const row of rows) {
    if (row.status === 'up-to-date') continue;
    apply_plan.push(`sidekicks skill manifest ${row.skill} --apply`);
  }
  apply_plan.push('sidekicks skill doctor');
  apply_plan.push('sidekicks skill heal --all --apply');

  const warnings = adoptions.flatMap((a) => a.warnings);
  return { rows, unknown, apply_plan, adoptions, warnings };
}

/** Names already placed in an audit group here — read from the auditor's bundled groups file. */
function groupedSkills(repoRoot) {
  const abs = join(
    repoRoot, ...SKILLS_ROOT_SEGMENTS, 'sk-skill-auditor', 'assets', 'audit-groups.yaml'
  );
  const out = new Set();
  if (!existsSync(abs)) return out;
  for (const raw of readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const m = raw.replace(/\s+$/, '').match(/^\s+-\s+(\S+)/);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * Copy one incoming skill in, backing up whatever was there and pruning what the new version
 * dropped.
 *
 * The backup goes under `artifacts/runs/skill-manager/backups/` — git-ignored, recorded
 * repo-relative (`rule.portable-artifact-paths`), and the one thing that makes a wrong import
 * recoverable. It is taken BEFORE any write or delete, unconditionally.
 *
 * THE SKILL LANDS IN THE TREE IT CAME FROM. An incoming copy under `.sidekicks/skill-offloaded/`
 * is a PARKED skill, and writing it into the active tree would un-park it — a decision
 * `sk-skill-offload` owns after a reference scan, not something an import should do as a
 * side effect of a path join.
 *
 * PRUNING IS NARROW, ON PURPOSE. A file the LOCAL baseline recorded and the incoming baseline does
 * not is a file the new version deleted, so leaving it behind produces a skill that is in drift the
 * moment the import finishes (`bundle-stale`, and a later export refuses it). But a file on disk
 * that NEITHER baseline records is a stray nobody has agreed about, and deleting that would be
 * destroying something no declaration covers. So: prune recorded-then-dropped, keep strays.
 *
 * MODE. Both writes below copy real skill file content (the backup and the incoming apply), the
 * same round trip `copyBundle` makes on the way out — so both carry `fsx.execAwareMode()` the same
 * way copyBundle does, or a script `chmod +x`'d on export would silently lose that bit again on the
 * way back in.
 */
function applyOne(repoRoot, row, stamp) {
  // The destination tree. For a native row this is the tree the copy came FROM; a foreign row has
  // no tree of its own and the adapter has already resolved one.
  const localDir = join(repoRoot, ...row.incoming.tree.split('/'), row.skill);
  const backed = existsSync(localDir)
    ? backupSkillDir(repoRoot, localDir, stamp, row.skill)
    : null;

  // Never null: a row with no incoming bundle carries the walk of its folder instead. It used to be
  // null, and `--force --apply` on any manifest-free skill died here with a TypeError — after the
  // backup, so the operator lost the report as well.
  const files = row.files || [];
  for (const rel of files) {
    const src = join(row.incoming.dir, ...rel.split('/'));
    if (!existsSync(src)) continue;
    const dest = join(localDir, ...rel.split('/'));
    // Rule 1: everything under .sidekicks/ is written through the CLI, and through the guard.
    assertWritable(dest, repoRoot);
    writeAtomic(dest, readFileSync(src), { mode: execAwareMode(src) });
  }

  const incomingSet = new Set(files);
  const pruned = [];
  for (const rel of row.local_recorded || []) {
    if (incomingSet.has(rel)) continue;
    // A WALK-SOURCED import has no manifest to offer, which is not the same as having deleted one.
    // Pruning it would destroy the hand-authored `why` / `degraded` / `optional` prose that
    // `skill manifest --apply` is explicitly built never to re-decide. It reads stale for exactly
    // one command, and that command is already on the apply plan.
    if (rel === MANIFEST_NAME && row.file_source === 'walk') continue;
    const abs = join(localDir, ...rel.split('/'));
    if (!existsSync(abs)) continue;
    assertWritable(abs, repoRoot);
    rmSync(abs, { force: true });
    pruned.push(rel);
  }

  return { skill: row.skill, backup: backed, files: files.length, pruned };
}

/** Every framework rule/criterion id this repo's registry currently knows about. */
function frameworkIds(repoRoot) {
  try {
    const reg = buildRegistry(repoRoot);
    return new Set((reg.entries || []).map((e) => e.id));
  } catch {
    // A registry that will not build is a pre-existing problem for `framework doctor`, not a reason
    // to fail an import. An empty set just means the profile records no enabled ids.
    return new Set();
  }
}

/**
 * The facts a registration profile records for one applied row.
 *
 * Split deliberately: `source`/`upstream`/`adapter`/`enabled_here`/`licence` are what nothing on
 * disk can reconstruct afterwards; `mirror` is recomputed and only kept for legibility; `files` is
 * the as-installed baseline that lets a later removal tell a file this import brought from one
 * added since.
 */
function profileFacts(repoRoot, row, o) {
  const entry = discoverSkills(repoRoot).find((e) => e.skill === row.skill);
  const a = row.adoption || { facts: {}, carries: [] };
  const git = sourceGit(o.fromRoot);
  const req = row.requires || {};
  return {
    skill: row.skill,
    status: 'installed',
    provenance: 'imported',
    source: {
      kind: o.src.native ? 'sidekicks' : o.src.source_kind,
      destination: destinationNameFor(repoRoot, o.fromRoot),
      remote: git.remote,
      commit: git.commit,
      branch: git.branch,
    },
    upstream: {
      name: row.upstream,
      path: row.incoming.upstreamRel,
      version: a.facts.upstream_version || '',
      description: a.facts.upstream_description || '',
    },
    adapter: {
      layout: row.incoming.layout,
      converted: row.incoming.native === false,
      category: row.incoming.category || '',
      // Import synthesizes nothing. The field exists because a later `skill manifest --apply` may,
      // and a removal has to know whether a manifest came from upstream or from this framework.
      synthesized: '',
    },
    enabled_here: {
      framework_rules: (o.enabled || []).join(', '),
      config_blocks: req.config && req.config.block ? req.config.block : '',
      hooks_requested: (req.framework_hooks || []).map((h) => h.id).join(', '),
      repo_root_files: (req.framework_files || []).map((f) => f.path).join(', '),
      audit_group: groupOfSkill(repoRoot, row.skill),
    },
    licence: {
      declared: a.facts.license || '',
      carried: (a.carries || []).join(', '),
      not_carried: (a.steps || []).some((s) => s.includes('did NOT travel'))
        ? 'a licence at the source ROOT did not travel — see the import report'
        : '',
    },
    imported_at: o.at,
    imported_by: { tool: 'sidekicks skill import', cli_version: cliVersion() },
    mirror: entry ? mirrorFacts(repoRoot, entry) : null,
    files_recorded_at: 'import',
    files: entry ? fileHashes(entry) : {},
    history: [{ at: o.at, action: 'import', detail: row.status }],
  };
}

/**
 * Where the source tree came from, as git sees it.
 *
 * Best effort by design: a source may be a plain folder, an unpushed clone, or a marketplace
 * checkout with no remote. An unknown commit is recorded as empty and the receipt stays honest —
 * it is never a reason to fail an import that has already copied the files.
 */
function sourceGit(fromRoot) {
  const safe = (fn) => { try { return fn() || ''; } catch { return ''; } };
  if (!safe(() => isRepo(fromRoot))) return { remote: '', commit: '', branch: '' };
  return {
    remote: safe(() => remoteUrl(fromRoot)),
    commit: safe(() => headCommit(fromRoot)),
    branch: safe(() => currentBranch(fromRoot)),
  };
}

/** The configured destination NAME a path corresponds to, or '' — never the checkout path itself. */
function destinationNameFor(repoRoot, fromRoot) {
  try {
    for (const d of configuredDestinations(repoRoot)) {
      if (d.dir && resolve(d.dir) === resolve(fromRoot)) return d.name;
    }
  } catch { /* an unreadable config is not an import failure */ }
  return '';
}

/** Which audit group a skill sits in here, or ''. */
function groupOfSkill(repoRoot, name) {
  const abs = join(
    repoRoot, ...SKILLS_ROOT_SEGMENTS, 'sk-skill-auditor', 'assets', 'audit-groups.yaml'
  );
  if (!existsSync(abs)) return '';
  let group = '';
  for (const raw of readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const g = raw.match(/^\s{2}([A-Za-z0-9_-]+):\s*$/);
    if (g) { group = g[1]; continue; }
    const m = raw.replace(/\s+$/, '').match(/^\s+-\s+(\S+)/);
    if (m && m[1] === name && group !== 'single') return group;
  }
  return '';
}

/**
 * The version of the CLI DOING the import — resolved from this module, not from the target repo.
 *
 * The target of an import is frequently not a sidekicks checkout at all (that is rather the point),
 * so reading its package.json records an empty version for every real adoption.
 */
function cliVersion() {
  try {
    const pkg = fileURLToPath(new URL('../../package.json', import.meta.url));
    return String(JSON.parse(readFileSync(pkg, 'utf8')).version || '');
  } catch { return ''; }
}

/** `--rename upstream=local`, repeatable, parsed into a Map. */
function parseRenames(raw) {
  const out = new Map();
  for (const spec of raw) {
    const eq = spec.indexOf('=');
    if (eq < 1 || eq === spec.length - 1) {
      throw new SidekicksError(
        `skill import: --rename takes <upstream>=<local>, not '${spec}'`, EXIT_USAGE
      );
    }
    out.set(spec.slice(0, eq), spec.slice(eq + 1));
  }
  return out;
}

/**
 * Re-key the incoming map by the name each skill will land under here.
 *
 * The entry keeps `skill` as the UPSTREAM name — that is what the source calls it and what a later
 * re-import has to match on — and gains `target`, the local folder. Renaming is only offered for a
 * foreign source: a native one shares this framework's namespace already, and renaming there would
 * fork a skill from its own history.
 */
function applyRenames(entries, renames, into, native) {
  if (!renames.size) return entries;
  if (native) {
    throw new SidekicksError(
      'skill import: --rename is for adopting a foreign skill. A skill from a sidekicks skills '
      + 'repository already shares this namespace, and renaming it would fork it from its own '
      + 'history and its published copy.',
      EXIT_USAGE
    );
  }
  const out = new Map();
  // `--into` speaks basenames (`skills` | `skill-offloaded`); the two trees no longer share a
  // parent, so resolve rather than re-join onto a fixed prefix. readSource did the same already —
  // this only has to agree with it, or a rename would land the copy in a different tree.
  const tree = SKILL_TREE_BY_BASENAME[into] || SKILLS_ROOT_REL;
  for (const [name, entry] of entries) {
    const target = renames.get(name) || name;
    out.set(target, { ...entry, target, tree, relDir: `${tree}/${target}` });
  }
  for (const upstream of renames.keys()) {
    if (!entries.has(upstream)) {
      throw new SidekicksError(
        `skill import: --rename names '${upstream}', which is not in this source`, EXIT_VALIDATION
      );
    }
  }
  return out;
}

/** The refusal for a `--from` that holds no skills, saying what was actually found. */
function notASkillsTree(fromRoot, src) {
  const lines = [`skill import: found no skills under '${fromRoot}'.`];
  if (src.detection.ambiguous.length) {
    return new SidekicksError(
      `skill import: '${fromRoot}' matches more than one layout — ${src.detection.evidence}. `
      + `Pick one explicitly with --layout <${LAYOUTS.join('|')}>.`,
      EXIT_VALIDATION
    );
  }
  if (src.source_kind === 'plugin-marketplace') {
    const plugins = marketplacePlugins(fromRoot);
    lines.push(
      'It looks like a CLI plugin marketplace (.claude-plugin/). A plugin bundles commands, agents,'
      + ' hooks and skills, and this verb has standing over the skills only.'
    );
    if (plugins.length) {
      lines.push(`Point --from at one of its skills trees instead: ${plugins.join(', ')}`);
    }
  } else {
    const top = readdirSync(fromRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name).slice(0, 12);
    lines.push(
      `Looked for: .agents/skills/<name>/, .sidekicks/skill-offloaded/<name>/, .claude/skills/<name>/, `
      + 'skills/<name>/, skills/<category>/<name>/, <name>/ — each with a SKILL.md inside.'
    );
    if (top.length) lines.push(`Top-level directories here: ${top.join(', ')}`);
  }
  return new SidekicksError(lines.join('\n  '), EXIT_VALIDATION);
}

/** `--list`: what a source holds, without reconciling or writing anything. */
function listSource(fromRoot, src, flags) {
  const rows = [...src.entries.values()].map((e) => ({
    skill: e.skill, layout: e.layout, category: e.category, path: e.upstreamRel,
  }));
  if (flags.json) {
    return {
      stdout: JSON.stringify({
        ok: true, from: fromRoot, layout: src.layout, native: src.native,
        source_kind: src.source_kind, skills: rows, rejected: src.rejected,
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  const out = [
    `skill import --list: ${src.detection.evidence || `${rows.length} skill(s)`} in ${fromRoot}`,
    `  layout: ${src.layout}${src.native ? ' (native — no conversion)' : '  source: ' + src.source_kind}`,
    '',
  ];
  for (const r of rows) out.push(`  ${r.skill}${r.category ? `  [${r.category}]` : ''}  ${r.path}`);
  if (src.rejected.length) {
    out.push('', 'SKIPPED — found but not usable as a skill directory:');
    for (const r of src.rejected) out.push(`  ${r.path}: ${r.reason}`);
  }
  if (!src.native) {
    out.push('', "Nothing is imported by --list. Adopt with '--adopt <skill>… --apply'.");
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}

/**
 * Run `skill import`.
 *
 * @param {{repoRoot: string, argv: string[]}} ctx
 */
export async function run(ctx) {
  const flags = parseSkillFlags(
    ctx.argv, ['apply', 'force', 'json', 'all', 'dry-run', 'adopt', 'list']
  );
  // EVERY value flag has to be listed here too. The dispatcher's parseArgs runs strict:false with
  // no option config, so an omitted one turns `--layout flat` into a positional and the verb
  // reports "not present in <path>: flat".
  const names = positionalArgs(ctx.argv, ['from', 'layout', 'into', 'rename']);
  const renames = parseRenames(collectRepeated(ctx.argv, 'rename'));

  if (typeof flags.from !== 'string' || !flags.from) {
    throw new SidekicksError(
      'skill import: --from <path> is required — the tree to import from (a skills repository, or '
      + 'any repository holding skills)',
      EXIT_USAGE
    );
  }
  const fromRoot = resolve(String(flags.from));
  if (flags.layout && !LAYOUTS.includes(String(flags.layout)) && flags.layout !== 'auto'
      && flags.layout !== 'flat+nested') {
    throw new SidekicksError(
      `skill import: unknown --layout '${flags.layout}' — one of ${LAYOUTS.join(', ')}, or auto`,
      EXIT_USAGE
    );
  }
  const into = flags.into ? String(flags.into) : 'skills';
  if (!['skills', 'skill-offloaded'].includes(into)) {
    throw new SidekicksError(
      `skill import: --into takes 'skills' or 'skill-offloaded', not '${into}'`, EXIT_USAGE
    );
  }

  const src = readSource(fromRoot, { layout: flags.layout ? String(flags.layout) : null, into });
  if (!src.layout) throw notASkillsTree(fromRoot, src);

  // --list comes BEFORE the adopt gate on purpose: it writes nothing, and the gate's own advice is
  // to look at the source first. A refusal that forbids the inspection it recommends is a loop.
  if (flags.list) return listSource(fromRoot, src, flags);

  // ADOPTING IS AN EXPLICIT ACT. Auto-detection is what makes a foreign repo reachable at all, and
  // an explicit gate is what keeps a mistyped --from from converting some unrelated checkout.
  if (!src.native && !flags.adopt) {
    throw new SidekicksError(
      `skill import: '${fromRoot}' is in the '${src.layout}' layout, not a sidekicks skills `
      + `repository (${src.detection.evidence}). Importing from it CONVERTS third-party skills into `
      + "this repo, so it needs --adopt. Run the same command with '--list' to see exactly what "
      + 'would come across.',
      EXIT_VALIDATION
    );
  }

  if (!names.length && !flags.all) {
    throw new SidekicksError(
      'skill import: name at least one skill or pass --all (add --list to see what is there)',
      EXIT_USAGE
    );
  }

  const incoming = applyRenames(src.entries, renames, into, src.native);
  // A name on the command line is whatever the operator saw in `--list`, i.e. the UPSTREAM name.
  // The map is keyed by the local name a rename resolved to, so translate before looking anything
  // up — otherwise `--rename x=y x` reports that x is not in the source it just came from.
  const targets = names.map((n) => renames.get(n) || n);

  // A foreign skill arriving under a name this repo already uses is a collision, not a reconcile:
  // the two folders have no shared history, so "fast-forward" would mean overwriting an unrelated
  // skill. A NATIVE source is the opposite case — the same name IS the same skill.
  if (!src.native) {
    const local = new Set(discoverSkills(ctx.repoRoot).map((e) => e.skill));
    const wanted = targets.length ? targets : [...incoming.keys()];
    const clash = wanted.filter((n) => incoming.has(n) && local.has(n));
    if (clash.length) {
      throw new SidekicksError(
        `skill import: ${clash.length} incoming skill(s) already exist here: ${clash.join(', ')}. `
        + 'They are unrelated folders that happen to share a name, so nothing is overwritten. Give '
        + `each one a local name: ${clash.map((n) => `--rename ${
          incoming.get(n).skill}=<local-name>`).join(' ')}`,
        EXIT_VALIDATION
      );
    }
  }

  const plan = importPlan(ctx.repoRoot, fromRoot, flags.all ? null : targets, { incoming, src });
  if (plan.unknown.length) {
    throw new SidekicksError(
      `skill import: not present in ${fromRoot}: ${plan.unknown.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const unforceable = plan.rows.filter((r) => NEVER_APPLY.has(r.status));
  const blocked = plan.rows.filter(
    (r) => NEVER_APPLY.has(r.status) || (NEEDS_FORCE.has(r.status) && !flags.force)
  );
  const actionable = plan.rows.filter(
    (r) => !NEVER_APPLY.has(r.status)
      && (r.status === 'new' || r.status === 'ff' || (NEEDS_FORCE.has(r.status) && flags.force))
  );

  let applied = [];
  const receipts = [];
  if (flags.apply && !blocked.length && actionable.length) {
    const at = nowBangkok();
    const stamp = at.replace(/[:+]/g, '-');
    // What this repo's framework registry lists BEFORE the copy. The diff after is the only way to
    // know which of an incoming skill's declared ids this import actually turned on here — after
    // the fact, rules.yaml cannot tell an id the import enabled from one that was already listed.
    const before = frameworkIds(ctx.repoRoot);
    applied = actionable.map((r) => applyOne(ctx.repoRoot, r, stamp));
    const after = frameworkIds(ctx.repoRoot);
    const enabled = [...after].filter((id) => !before.has(id));

    for (const r of actionable) {
      // A receipt is bookkeeping; the skill is the deliverable. A profile that cannot be written
      // must never undo a copy that succeeded — it degrades to a warning that
      // `skill registry --backfill` can settle later.
      try {
        receipts.push(recordProfile(ctx.repoRoot, profileFacts(ctx.repoRoot, r, {
          src, fromRoot, at, enabled, applied: applied.find((a) => a.skill === r.skill),
        })));
      } catch (err) {
        plan.warnings.push(
          `${r.skill}: imported, but its registration profile was not recorded (${err.message}). `
          + `Run 'sidekicks skill registry --backfill --assume-imported ${r.skill} --apply'.`
        );
      }
    }
  }

  const exitCode = blocked.length ? EXIT_VALIDATION : EXIT_OK;

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        ok: exitCode === EXIT_OK,
        from: fromRoot,
        applied: Boolean(flags.apply),
        rows: plan.rows.map((r) => ({
          skill: r.skill, status: r.status, detail: r.detail, files: r.files ? r.files.length : 0,
          // Whether that file list came from a recorded baseline or from walking the folder. A
          // walk-sourced copy was never checked against anything, and a report that hid the
          // difference would let an unverified import read as a verified one.
          verified: Boolean(r.verified),
        })),
        layout: src.layout,
        adopted: !src.native,
        blocked: blocked.map((r) => r.skill),
        unforceable: unforceable.map((r) => r.skill),
        warnings: plan.warnings || [],
        wrote: applied,
        apply_plan: plan.apply_plan,
      }, null, 2) + '\n',
      exitCode,
    };
  }

  const out = [];
  out.push(flags.apply && applied.length
    ? `skill import: applied ${applied.length} skill(s) from ${fromRoot}`
    : `skill import: ${plan.rows.length} skill(s) in ${fromRoot} (nothing written)`);
  // Name the detection in the first lines. Auto-detection is only safe if the operator can see
  // which shape it decided on before deciding whether to trust the rest of the report.
  out.push(`  layout: ${src.layout}${src.native
    ? ' (native sidekicks skills repository — no conversion)'
    : `  ADOPTING third-party skills (source: ${src.source_kind})`}`);
  if (src.rejected.length) {
    out.push(`  skipped ${src.rejected.length} director${src.rejected.length === 1 ? 'y' : 'ies'} `
      + 'that could not be a skill — add --list to see them');
  }
  out.push('');
  for (const r of plan.rows) {
    out.push(`  [${r.status}] ${r.skill}${r.verified ? '' : '  (unverified — no recorded baseline)'}`);
    out.push(`      ${r.detail}`);
  }
  if (applied.length) {
    out.push('', 'Written:');
    for (const a of applied) {
      out.push(`  + ${a.skill} (${a.files} files)${a.backup ? `, previous copy backed up to ${a.backup}` : ''}`);
      // A delete is never silent, even though the backup makes it recoverable.
      if (a.pruned && a.pruned.length) {
        out.push(`      removed ${a.pruned.length} file(s) the new version dropped: ${a.pruned.join(', ')}`);
      }
    }
  }
  if (blocked.length) {
    out.push('', `REFUSED — ${blocked.length} skill(s) need a decision, not an overwrite:`);
    for (const r of blocked) out.push(`  ${r.skill}: ${r.status}`);
    if (blocked.length > unforceable.length) {
      out.push('  Resolve the difference, or pass --force to overwrite (a backup is taken either way).');
    }
    if (unforceable.length) {
      out.push(
        `  ${unforceable.map((r) => r.skill).join(', ')}: --force does NOT open this one. The `
        + 'incoming copy contradicts its own manifest, so forcing it in writes files whose hashes '
        + 'will not match the manifest landing beside them — `skill doctor` reports bundle-stale '
        + 'immediately and the next export refuses. Re-export it at the source instead.'
      );
    }
  } else if (!flags.apply && actionable.length) {
    // Echo back every flag the run actually needs — a suggested command that drops --adopt or
    // --rename is a command that refuses when the operator pastes it.
    const echo = [
      flags.all ? '--all' : names.join(' '),
      `--from ${flags.from}`,
      src.native ? '' : '--adopt',
      flags.layout ? `--layout ${flags.layout}` : '',
      flags.into ? `--into ${flags.into}` : '',
      ...[...renames].map(([u, l]) => `--rename ${u}=${l}`),
      '--apply',
    ].filter(Boolean);
    out.push('', `  apply with 'sidekicks skill import ${echo.join(' ')}'`);
  }
  if (plan.warnings && plan.warnings.length) {
    out.push('', 'WARNINGS — read before applying; none of these is corrected for you:');
    for (const w of plan.warnings) out.push(`  ! ${w}`);
  }
  out.push('', 'Then, in this order — none of it is done by this verb:');
  for (const step of plan.apply_plan) out.push(`  - ${step}`);

  if (blocked.length) throw new SidekicksError(out.join('\n'), EXIT_VALIDATION);
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
