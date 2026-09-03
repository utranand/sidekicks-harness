// lib/scope-lifecycle/explain-model.mjs
// buildExplainModel(repoRoot, opts) — the EFFECTIVE COMPOSITION of this workspace, as one document.
//
// WHAT THIS IS FOR. Every layer of this substrate resolves something: the active scope resolves three
// anchors, the framework enable map resolves a rule against four layers, the configuration store
// resolves a block against eight, skill discovery resolves two trees, and a mounted core resolves the
// whole framework from somewhere else entirely. Each of those has a verb that answers ONE of the
// questions. Nothing answered "what is in effect HERE, right now, and which layer decided it" in a
// single pass, so the answer was assembled by hand from six commands, differently each time.
//
// IT REUSES THE RESOLVERS — IT DOES NOT REIMPLEMENT PRECEDENCE. This is the entire design constraint,
// and it is not a style preference: a second precedence implementation would drift from the first, and
// the drift would surface as a report that CONFIDENTLY disagrees with the behaviour it describes,
// which is worse than having no report. So:
//
//   anchors        resolveWorkingFolder / resolveRunBase   lib/active-scope/
//   skills         auditCatalog().model.skills             lib/catalog-lifecycle/model.mjs
//   framework      resolve() over loadLayers()             lib/framework-settings/resolve.mjs
//   configuration  resolveBlock() / listBlocks()           lib/config-store/read.mjs
//   executors      auditCatalog().model.executors          lib/catalog-lifecycle/model.mjs
//   core / package inspectCore / countSkills / auditWiring  lib/core-lifecycle/
//   findings       auditCatalog()                          lib/catalog-lifecycle/commands.mjs
//
// READ-ONLY, AND OFFLINE. Nothing here writes, and nothing here reaches the network: `core status`
// compares against the remote tip, and this report deliberately uses the pieces UNDER it
// (`inspectCore`, `countSkills`, `auditWiring`) instead of the verb, so an explain on a plane returns
// the same document as an explain in the office.
//
// TWO PROTECTED BEHAVIOURS, both structural rather than filtered:
//   1. NO CREDENTIAL VALUE, in any output mode, under any flag. There is no reveal flag here and no
//      code path that could forward one; `valueShape()` renders a shape and never a value, so a
//      credential under a key name no heuristic would flag still cannot escape.
//   2. NO MACHINE-ABSOLUTE PATH. Every path field goes through `repoRel()`, and ./explain.mjs scrubs
//      the root out of every string in the finished model as well, before either renderer runs — so a
//      path that reached a MESSAGE (from git, from an FS error) cannot escape either (./_shared.mjs).
//
// Zero npm dependencies — node:* + lib/ back-edges only; macOS + Windows.

import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SidekicksError } from '../sk-cli/errors.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveEffectiveScope, resolveWorkingFolder } from '../active-scope/scope.mjs';
import { resolveRunBase, deriveFacet, ADHOC_SEGMENT } from '../active-scope/run-base.mjs';
import { EXPOSURE_LINK_RELS, SKILLS_ROOT_REL } from '../sk-cli/skill-trees.mjs';
import { auditCatalog, isSourceTree } from '../catalog-lifecycle/commands.mjs';
import { loadLayers, resolve as resolveFrameworkEntry } from '../framework-settings/resolve.mjs';
import { HOOK_CONFIGS, wiredHookScripts } from '../framework-settings/registry.mjs';
import { resolveBlock } from '../config-store/read.mjs';
import { maskValue } from '../config-store/lint.mjs';
import { SECRET_KEY_RE } from '../skill-config/resolve.mjs';
import { CORE_DIR, coreDirOf } from '../sk-cli/core-mount.mjs';
import { inspectCore, shortSha } from '../core-lifecycle/_shared.mjs';
import { countSkills } from '../core-lifecycle/status.mjs';
import { auditWiring } from '../core-lifecycle/_wiring.mjs';
import { repoRel, sortBy, uniqSorted, valueShape } from './_shared.mjs';

/** The report's own schema version. Bumped only for a REMOVAL or rename — additions are free. */
export const EXPLAIN_SCHEMA_VERSION = 1;

/** The active-scope pointer every other lookup starts from (CLAUDE.md § Active Scope). */
const SETTINGS_REL = '.sidekicks/settings.json';

/** Rule 6: instructions are canonical at AGENTS.md; every other CLI inherits through a mirror. */
const INSTRUCTIONS_CANONICAL = 'AGENTS.md';
const INSTRUCTION_MIRRORS = Object.freeze(['CLAUDE.md', 'GEMINI.md']);

/**
 * Finding severities, in report order. A single digit each, so the ordering key
 * (`<rank> <code> <subject>`) sorts lexicographically and still means severity-first.
 */
const SEVERITY_RANK = Object.freeze({ error: 0, warning: 1, info: 2 });

/** Every finding code this report can raise itself, exported so a caller asserts codes, not prose. */
export const EXPLAIN_CODES = Object.freeze([
  'active-service-missing',    // an active service is named but its directory is absent
  'service-not-pulled',        // the active service is registered but its src/ has not been acquired
  'instructions-mirror-drift', // a per-CLI instruction mirror exists but does not resolve to AGENTS.md
  'skills-exposure-drift',     // a host-level skills link exists but does not resolve to .agents/skills
]);

/**
 * Catalog finding codes this report deliberately DROPS, and why each one.
 *
 * The first three are generated-file freshness: `docs/generated/…` and the packaged lib snapshot are
 * `catalog check`'s subject, and Phase 3's contract is that composition inspection must not depend on
 * a generated file being current — an explain that failed because someone had not re-run
 * `catalog rebuild` would report a problem about a document, not about the composition.
 *
 * `dangling-reference` is dropped OUTSIDE a source tree only (see below). The reason has NARROWED:
 * `catalog check` now resolves framework paths through the mount (lib/sk-cli/core-mount.mjs
 * `resolveOwned`), so in a mounted workspace those subjects resolve and there is nothing left to
 * suppress — the suppression was standing in for a resolution bug that is now fixed
 * (INC-2026-09-04-01, F-3). What remains is a `packaged` tree, which carries a subset of `lib/**`
 * by design and where an absent dispatch module is a packaging choice rather than a defect.
 */
const DROPPED_CATALOG_CODES = Object.freeze(['stale-generated', 'missing-generated', 'snapshot-drift']);
const SOURCE_TREE_ONLY_CATALOG_CODES = Object.freeze(['dangling-reference']);

/**
 * The reported shape of one configuration key, and whether it is credential-shaped.
 *
 * BOTH BRANCHES ARE VALUE-FREE, which is the point: the `secret` flag exists so a reader can SEE
 * which keys are credentials, not so a filter can decide which ones are safe to print. `maskValue`
 * is used for the credential-shaped ones purely so the output says `*** (len 40)` in the place a
 * reader of a masking guarantee will look for it; `valueShape` covers everything else and is equally
 * value-free, so a credential stored under a key no heuristic would flag (`dsn`, `handle`) is still
 * unprintable. The guarantee therefore does not depend on SECRET_KEY_RE being complete.
 *
 * @param {string} key
 * @param {unknown} value
 * @param {Set<string>} publicKeys - keys the block declares public (credential-SHAPED but not secret)
 * @returns {{secret: boolean, shape: string}}
 */
function keyShape(key, value, publicKeys) {
  if (publicKeys.has(key) || !SECRET_KEY_RE.test(key)) {
    return { secret: false, shape: valueShape(value) };
  }
  // maskValue returns null for an absent value, where "not set" must stay distinguishable.
  const masked = maskValue(value);
  return { secret: true, shape: masked === null ? valueShape(value) : masked };
}

/** True when `abs` is an existing directory. Never throws. */
function isDir(abs) {
  try { return statSync(abs).isDirectory(); } catch { return false; }
}

/**
 * How a repo-relative link-ish path relates to a target: present at all, a link, and resolving there.
 *
 * @param {string} repoRoot
 * @param {string} rel - repo-relative POSIX path
 * @param {string|null} targetRel - repo-relative POSIX path it should resolve to, or null to skip
 * @returns {{path: string, present: boolean, link: boolean, resolves: boolean|null}}
 */
function linkStatus(repoRoot, rel, targetRel) {
  const abs = join(repoRoot, ...rel.split('/'));
  let st = null;
  try { st = lstatSync(abs); } catch { st = null; }
  // An ABSENT path resolves to nothing rather than to the wrong thing: `resolves: false` would
  // read as drift, and absence is a legitimate state (a workspace wires only the CLIs it uses).
  if (!st) return { path: rel, present: false, link: false, resolves: null };
  const link = st.isSymbolicLink();
  if (!targetRel) return { path: rel, present: true, link, resolves: null };
  const targetAbs = join(repoRoot, ...targetRel.split('/'));
  let resolves = false;
  try {
    resolves = existsSync(targetAbs) && realpathSync(abs) === realpathSync(targetAbs);
  } catch { resolves = false; }
  return { path: rel, present: true, link, resolves };
}

/**
 * Build the effective-composition model.
 *
 * @param {string} repoRoot - absolute repo root
 * @param {{skillId?: string|null, workItem?: string|null}} [opts]
 *   - skillId: resolve the concrete run base for this skill; without it `resolved_run_base` is null.
 *   - workItem: the work-item slug the run base hangs off. Only meaningful with skillId — the caller
 *     (./explain.mjs) rejects it on its own, because "which arguments combine" is a usage question.
 * @returns {object} the report model (fixed key order, sorted arrays, repo-relative paths)
 * @throws {SidekicksError} EXIT_VALIDATION on a corrupt settings.json, or on a bad skill-id /
 *   work-item slug (propagated from resolveRunBase — the same validation `scope run-base` applies).
 */
export function buildExplainModel(repoRoot, opts = {}) {
  const skillId = opts.skillId ?? null;
  const workItem = opts.workItem ?? null;

  /** @type {Array<{code: string, severity: string, subject: string, message: string}>} */
  const findings = [];
  const add = (code, severity, subject, message) => findings.push({ code, severity, subject, message });

  // ── active scope ─────────────────────────────────────────────────────────────
  // read() returns {} for a missing file — a missing settings file is never an error (CLAUDE.md),
  // it is simply root scope. Only a CORRUPT file throws.
  const settings = readSettings(repoRoot);
  const settingsPresent = existsSync(join(repoRoot, ...SETTINGS_REL.split('/')));
  const scope = resolveEffectiveScope(settings);

  // resolveWorkingFolder THROWS when an active service names a directory that is not there. For every
  // other verb that is right — writing into a scope that does not exist is the bug. For a DIAGNOSTIC
  // it is the opposite: that is exactly the state a reader runs explain to understand, so the throw
  // becomes an error finding and the anchors fall back to the project base.
  let wf;
  try {
    wf = resolveWorkingFolder(settings, repoRoot);
  } catch (err) {
    if (!(err instanceof SidekicksError)) throw err;
    const projectPath = scope.projectRelPath
      ? join(repoRoot, ...scope.projectRelPath.split('/'))
      : repoRoot;
    wf = {
      projectName: scope.projectName,
      projectPath,
      serviceName: scope.serviceName,
      servicePath: scope.serviceName ? join(projectPath, 'services', scope.serviceName) : null,
      workdir: projectPath,
      artifactsbase: projectPath,
    };
    add('active-service-missing', 'error', `${scope.projectName}/${scope.serviceName}`,
      `the active service directory 'projects/${scope.projectName}/services/${scope.serviceName}/' `
      + "does not exist — register it with 'sidekicks service add', or clear it with "
      + "'sidekicks service use' / by removing active_service from " + SETTINGS_REL);
  }

  const servicePresent = wf.servicePath !== null && isDir(wf.servicePath);
  const srcPresent = servicePresent && isDir(join(wf.servicePath, 'src'));
  const serviceState = wf.serviceName === null
    ? null
    : !servicePresent ? 'missing' : srcPresent ? 'pulled' : 'registered (not pulled)';
  if (serviceState === 'registered (not pulled)') {
    add('service-not-pulled', 'warning', `${wf.projectName}/${wf.serviceName}`,
      `service '${wf.serviceName}' is registered but its src/ has not been acquired — the working `
      + "folder falls back to the service root; run 'sidekicks service pull' to get the code");
  }

  const active = {
    root_project: 'sidekicks',
    project: wf.projectName,
    project_path: repoRel(repoRoot, wf.projectPath),
    service: wf.serviceName,
    service_path: repoRel(repoRoot, wf.servicePath),
    service_state: serviceState,
    settings_file: SETTINGS_REL,
    settings_present: settingsPresent,
  };

  // ── anchors ──────────────────────────────────────────────────────────────────
  // The runs root is ALWAYS the project base, never the service root: a service's runs fold into its
  // project's tree and the service association travels in metadata (lib/active-scope/run-base.mjs).
  const runsRootRel = repoRel(repoRoot, join(wf.projectPath, 'artifacts', 'runs'));
  const anchors = {
    working_folder: repoRel(repoRoot, wf.workdir),
    artifacts_base: repoRel(repoRoot, wf.artifactsbase),
    runs_root: runsRootRel,
    run_base_pattern: `${runsRootRel}/<work-item>/<facet>`,
    run_base_bare_pattern: `${runsRootRel}/<work-item>`,
    run_base_adhoc_pattern: `${runsRootRel}/${ADHOC_SEGMENT}/<skill-id>`,
    skill_id: skillId,
    work_item: workItem,
    facet: skillId ? deriveFacet(skillId) : null,
    resolved_run_base: null,
    resolved_run_base_adhoc: null,
  };
  if (skillId) {
    // The SAME resolver `scope run-base` prints from — one join, one validation, one answer.
    const r = resolveRunBase(settings, repoRoot, { skillId, workItem, bare: false });
    anchors.resolved_run_base = repoRel(repoRoot, r.runBase);
    anchors.resolved_run_base_adhoc = r.adhoc;
    anchors.facet = r.facet;
  }

  // ── the catalog-derived inventories, plus its findings ───────────────────────
  // ONE call: auditCatalog returns the model it audited, so the inventories and the findings below
  // describe the same snapshot rather than two reads that could disagree.
  const audit = auditCatalog(repoRoot);
  const catalog = audit.model;
  const sourceTree = isSourceTree(repoRoot);
  for (const f of audit.findings) {
    if (DROPPED_CATALOG_CODES.includes(f.code)) continue;
    if (!sourceTree && SOURCE_TREE_ONLY_CATALOG_CODES.includes(f.code)) continue;
    findings.push({ code: f.code, severity: f.severity, subject: f.subject, message: f.message });
  }

  // ── resolved skills ─────────────────────────────────────────────────────────
  // Logical id, active/parked state, descriptor and manifest presence, declared HARD dependencies.
  // NO skill body, and no descriptor content: what a skill DOES is its own file's business, and a
  // report that inlined 122 bodies would be a copy of the tree rather than a description of it.
  const skillRow = (row, state) => ({
    id: row.id,
    folder: row.folder,
    tree: row.tree,
    state,
    logical_id: row.logical_id,
    descriptor: row.descriptor,
    manifest: row.manifest,
    hard_depends_on: uniqSorted(row.hard_depends_on),
  });
  const skills = sortBy(
    [
      ...catalog.skills.active.map((r) => skillRow(r, 'active')),
      ...catalog.skills.parked.map((r) => skillRow(r, 'parked')),
    ],
    (r) => `${r.id} ${r.folder}`,
  );
  const resolvedSkills = {
    trees: uniqSorted(skills.map((s) => s.tree)),
    active_count: catalog.skills.active_count,
    parked_count: catalog.skills.parked_count,
    hard_edge_count: catalog.skills.hard_edge_count,
    missing_target_count: catalog.skills.missing_targets.length,
    skills,
  };

  // ── effective framework entries ─────────────────────────────────────────────
  // Layers are loaded ONCE and passed back into resolve() for every id, so a 50-entry report reads
  // each settings file exactly once (the contract loadLayers documents).
  const layers = loadLayers(repoRoot);
  const frameworkEntries = sortBy(
    catalog.framework.entries.map((e) => {
      const r = resolveFrameworkEntry(repoRoot, e.id, layers);
      return {
        id: e.id,
        kind: e.kind,
        title: e.title,
        enabled: r.enabled,
        deciding_layer: r.source,
        floor: Boolean(e.floor),
        owners: uniqSorted(e.owners),
      };
    }),
    (r) => r.id,
  );
  const framework = {
    entry_count: frameworkEntries.length,
    rule_count: frameworkEntries.filter((r) => r.kind === 'rule').length,
    criterion_count: frameworkEntries.filter((r) => r.kind === 'criterion').length,
    hook_count: frameworkEntries.filter((r) => r.kind === 'hook').length,
    floor_count: frameworkEntries.filter((r) => r.floor).length,
    disabled_count: frameworkEntries.filter((r) => !r.enabled).length,
    entries: frameworkEntries,
  };

  // ── effective configuration ─────────────────────────────────────────────────
  // Block and family names, the owning skills, the deciding layer, and the masked value SHAPE.
  // A block resolving to its owning skill's defaults is HEALTHY, not a gap: that is what "missing
  // optional configuration is never an error at any layer" means, so it reports status 'default' and
  // raises nothing. `status: 'unset'` means no layer at all carried it, which is still not an error —
  // `config doctor` owns the judgement about whether a specific block ought to be filled in.
  const configBlocks = sortBy(
    catalog.config.blocks.map((b) => {
      const resolved = resolveBlock(repoRoot, b.block);
      const deciding = resolved.layers.find((l) => l.present) ?? null;
      const status = deciding === null
        ? 'unset'
        : (deciding.layer === 'project-config' || deciding.layer === 'root-config')
          ? 'configured'
          : 'default';
      const publicKeys = new Set(resolved.public_keys || []);
      const keys = sortBy(
        Object.keys(resolved.config).map((key) => {
          const { secret, shape } = keyShape(key, resolved.config[key], publicKeys);
          return { key, layer: resolved.sources[key] ?? null, secret, shape };
        }),
        (r) => r.key,
      );
      return {
        block: b.block,
        family: b.family,
        family_file: b.file,
        secret_file: b.secret_file,
        owners: uniqSorted(b.owners),
        scope: b.scope,
        inherits_root: Boolean(b.inherits_root),
        merge: b.merge,
        status,
        deciding_layer: deciding ? deciding.layer : null,
        deciding_file: deciding ? repoRel(repoRoot, join(repoRoot, deciding.path ?? '')) : null,
        defaults_file: b.defaults,
        key_count: keys.length,
        keys,
      };
    }),
    (r) => r.block,
  );
  const configuration = {
    family_count: catalog.config.family_count,
    block_count: configBlocks.length,
    configured_count: configBlocks.filter((b) => b.status === 'configured').length,
    default_count: configBlocks.filter((b) => b.status === 'default').length,
    unset_count: configBlocks.filter((b) => b.status === 'unset').length,
    // Stated in the document so a reader of the JSON never has to infer it from the absence of a flag.
    values_masked: true,
    families: sortBy(
      catalog.config.families.map((f) => ({ family: f.family, block_count: f.block_count })),
      (r) => r.family,
    ),
    blocks: configBlocks,
  };

  // ── package health / mounted core ───────────────────────────────────────────
  const packageHealth = buildPackageHealth(repoRoot, sourceTree);

  // ── registered executors ────────────────────────────────────────────────────
  // Straight from the catalog's executor section, which deliberately excludes `binary`, `invoke` and
  // `brief_stdin` — the three fields that can carry an absolute path or an operator's argv.
  const executors = {
    registry_file: catalog.executors.registry_file,
    registry_present: catalog.executors.registry_present,
    executor_count: catalog.executors.executor_count,
    routing_prefer: catalog.executors.routing_prefer,
    executors: sortBy(
      catalog.executors.executors.map((e) => ({
        name: e.name,
        builtin: e.builtin,
        registered: e.registered,
        kind: e.kind,
        enabled: e.enabled,
        transport: e.transport,
        sandbox: e.sandbox,
        model_tiers: uniqSorted(e.model_tiers),
      })),
      (r) => r.name,
    ),
  };

  // ── multi-CLI wiring (Rule 6) ───────────────────────────────────────────────
  // ABSENCE IS NOT A FINDING. A consumer workspace legitimately wires only the CLIs it uses, so the
  // presence columns are reported as STATE. Only DRIFT is a finding: a mirror or exposure link that
  // exists and points somewhere other than the canonical file it is supposed to inherit from, which
  // is the failure mode Rule 6 exists to prevent (switching CLI silently loses instructions/skills).
  const mirrors = INSTRUCTION_MIRRORS.map((rel) => linkStatus(repoRoot, rel, INSTRUCTIONS_CANONICAL));
  for (const m of mirrors) {
    if (m.present && m.resolves === false) {
      add('instructions-mirror-drift', 'warning', m.path,
        `'${m.path}' exists but does not resolve to ${INSTRUCTIONS_CANONICAL} — Rule 6 keeps `
        + `instructions canonical there; restore it with 'ln -sf ${INSTRUCTIONS_CANONICAL} ${m.path}'`);
    }
  }
  const exposure = EXPOSURE_LINK_RELS.map((rel) => linkStatus(repoRoot, rel, SKILLS_ROOT_REL));
  for (const e of exposure) {
    if (e.present && e.resolves === false) {
      add('skills-exposure-drift', 'warning', e.path,
        `'${e.path}' exists but does not resolve to ${SKILLS_ROOT_REL} — Rule 3 keeps skills `
        + 'canonical there; the CLI re-heals the link on the next invocation unless a real '
        + 'directory is sitting in its place');
    }
  }
  const multiCli = {
    instructions: {
      canonical: INSTRUCTIONS_CANONICAL,
      present: existsSync(join(repoRoot, INSTRUCTIONS_CANONICAL)),
      mirrors,
    },
    skills: {
      canonical: SKILLS_ROOT_REL,
      present: isDir(join(repoRoot, ...SKILLS_ROOT_REL.split('/'))),
      exposure_links: exposure,
    },
    hooks: HOOK_CONFIGS.map((rel) => {
      const posixRel = rel.split('\\').join('/');
      return {
        config: posixRel,
        present: existsSync(join(repoRoot, rel)),
        wired_hook_count: wiredHookScripts(repoRoot, rel).length,
      };
    }),
  };

  // ── findings, ordered severity → code → subject ─────────────────────────────
  const ordered = sortBy(
    findings,
    (f) => `${SEVERITY_RANK[f.severity] ?? 9} ${f.code} ${f.subject}`,
  );
  const errorCount = ordered.filter((f) => f.severity === 'error').length;

  return {
    schema_version: EXPLAIN_SCHEMA_VERSION,
    ok: errorCount === 0,
    active,
    anchors,
    resolved_skills: resolvedSkills,
    framework,
    configuration,
    package_health: packageHealth,
    executors,
    multi_cli: multiCli,
    findings: ordered,
    finding_counts: {
      error: errorCount,
      warning: ordered.filter((f) => f.severity === 'warning').length,
      info: ordered.filter((f) => f.severity === 'info').length,
    },
  };
}

/**
 * Where the framework this workspace runs actually comes from.
 *
 * Three states, checked in this order:
 *   source-tree   this IS the framework repo (it carries its own docs/)
 *   mounted-core  the framework lives in a submodule at .sidekicks-core/, and the summary is the one
 *                 `core status` renders — from the SAME pieces, minus its network read
 *   not-mounted   neither: a workspace running a packaged copy, or one whose mount is gone
 *
 * A source tree can also carry a mount (the harness service checkout does), so the core summary is
 * attached whenever a core is present regardless of which state won.
 *
 * @param {string} repoRoot
 * @param {boolean} sourceTree
 * @returns {object}
 */
function buildPackageHealth(repoRoot, sourceTree) {
  const coreDir = coreDirOf(repoRoot);
  const state = sourceTree ? 'source-tree' : coreDir ? 'mounted-core' : 'not-mounted';
  const out = {
    state,
    source_tree: sourceTree,
    core_mount_dir: CORE_DIR,
    core_mounted: coreDir !== null,
    core: null,
  };
  if (!coreDir) return out;

  // Every read below is non-throwing on purpose, for the reason `core status` gives: status must be
  // able to DESCRIBE a broken mount rather than die on it.
  let info = null;
  try { info = inspectCore(repoRoot, coreDir); } catch { info = null; }
  let skills = { linked: 0, own: 0, coreShips: 0 };
  try { skills = countSkills(repoRoot, coreDir); } catch { /* unreadable — reported as zeros */ }
  let wiringProblems = [];
  try { wiringProblems = auditWiring(repoRoot); } catch { wiringProblems = []; }

  out.core = {
    // repoRel is applied even though inspectCore already relativizes: one guarantee, one place.
    path: info ? repoRel(repoRoot, join(repoRoot, info.coreRel)) : CORE_DIR,
    version: info && info.marker ? (info.marker.version || null) : null,
    name: info && info.marker ? (info.marker.name || null) : null,
    head: info && info.head ? shortSha(info.head) : null,
    ref: info ? (info.describe || info.branch || null) : null,
    dirty: info ? Boolean(info.dirty) : null,
    skills_linked: skills.linked,
    skills_own: skills.own,
    skills_shipped_by_core: skills.coreShips,
    wiring_problem_count: wiringProblems.length,
    wiring_problems: uniqSorted(wiringProblems.map((p) => (typeof p === 'string' ? p : (p && p.file) || String(p)))),
  };
  return out;
}
