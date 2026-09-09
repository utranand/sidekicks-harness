// lib/agent-lifecycle/_harvest.mjs
// Turn LIVE agents into a PORTABLE agent pack — the missing path from `.sidekicks/agents/<name>/`
// to `.sidekicks/agent-packs/<id>/agents/<name>/`.
//
// NOT a dispatchable verb; `pack.mjs` drives this as `agent pack harvest`.
//
// WHY THIS EXISTS. A framework core ships its agent packs and never ships `.sidekicks/agents/` —
// that bar is structural (`.sidekicks` is not a copy surface) and it is load-bearing: a live tree
// carries the operator's Telegram relay, bridge tokens, session logs and personal memory. Until now
// the only way to put an agent into a pack was to retype its charter by hand, so an operator with a
// crew they actually use had no route to publishing it. This is that route, and it keeps the bar
// intact by producing a separate, sanitized, portability-checked artifact rather than a copy.
//
// SANITIZE MECHANICALLY, THEN REFUSE — never rewrite prose. Three things are per-INSTALL rather
// than per-AGENT and are dropped without asking (the `pack:` provenance block, a pinned
// `default_work_dir`, and the `routines/` folder, whose every entry is a schedule). Everything else
// that fails the portability gate is REPORTED, not repaired: a principle that names the Telegram
// lane is part of what that agent is, and silently deleting the sentence would ship an agent
// describing a role it no longer has. The operator edits the charter, or leaves that agent out.
//
// SKILLS ARE DERIVED, NEVER BUNDLED. A charter has no `skills:` field (see validateCompleteCharter's
// accepted key set), so the seeds are the skill names its own prose uses, matched against the skills
// this repo actually carries. Those seeds are then run through the declared-dependency closure, so a
// pack that needs sk-implementation-planner also declares whatever that skill declares. The rows
// name skills; they never carry one.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { discoverSkills } from '../skill-manifest/read.mjs';
import { skillClosure } from '../skill-package/closure.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
import { requireCharter, validateCompleteCharter, toRepoRel } from './_shared.mjs';
import {
  PACKS_DIR_REL,
  PACK_MANIFEST,
  PACK_SCHEMA,
  PACK_AGENTS_DIR,
  assertPortableCharter,
  validatePackManifest,
  listPackAgentDirs,
} from './_pack.mjs';

/** The default skills repository a derived dependency row is installable from. */
const DEFAULT_SKILLS_REPO = 'https://github.com/utranand/sidekicks-skills.git';

/**
 * Absolute path of a pack directory in this repo's own packs tree.
 * @param {string} repoRoot
 * @param {string} packId
 */
export function workspacePackDir(repoRoot, packId) {
  return join(repoRoot, PACKS_DIR_REL, packId);
}

/**
 * Strip the per-install fields from a live charter.
 *
 * @param {object} charter
 * @returns {{charter: object, dropped: string[]}}
 */
function sanitizeCharter(charter) {
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(charter)) {
    if (k === 'pack') { dropped.push('pack (provenance is stamped at install time)'); continue; }
    if (k === 'default_work_dir') {
      if (typeof v === 'string' && v.trim()) dropped.push(`default_work_dir (was '${v}')`);
      out[k] = '';
      continue;
    }
    out[k] = v;
  }
  if (!('default_work_dir' in out)) out.default_work_dir = '';
  return { charter: out, dropped };
}

/**
 * Every skill name this repo carries that the charter's prose actually names.
 *
 * Word-boundary matching against the real skill universe, so `sk-task-planner` counts and a bare
 * "task planner" does not — a guess here would put a skill into a published pack's requirements and
 * make `agent pack install` refuse over something no agent needs.
 *
 * @param {object} charter
 * @param {string[]} universe every skill name in this repo
 * @returns {string[]} sorted
 */
export function skillsNamedIn(charter, universe) {
  const hits = new Set();
  // Longest first: matching `sk-jira-connector` before `sk-jira` prevents a shorter name that is a
  // prefix of a longer one from claiming the same text.
  const names = [...universe].sort((a, b) => b.length - a.length);
  const walk = (node) => {
    if (typeof node === 'string') {
      for (const n of names) {
        if (hits.has(n)) continue;
        const re = new RegExp(`(^|[^A-Za-z0-9_-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`);
        if (re.test(node)) hits.add(n);
      }
    } else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(charter);
  return [...hits].sort();
}

/**
 * Expand seed skills through their DECLARED sibling dependencies.
 *
 * @param {string} repoRoot
 * @param {string[]} seeds
 * @returns {{all: string[], added: string[]}}
 */
export function expandSkillSeeds(repoRoot, seeds) {
  if (!seeds.length) return { all: [], added: [] };
  let selected = [];
  try {
    selected = skillClosure(repoRoot, seeds, { scope: 'runtime' }).selected.map((s) => s.skill);
  } catch {
    return { all: [...seeds].sort(), added: [] };   // a closure that cannot run must not lose the seeds
  }
  const seedSet = new Set(seeds);
  const all = [...new Set([...seeds, ...selected.filter(Boolean)])].sort();
  return { all, added: all.filter((s) => !seedSet.has(s)) };
}

/**
 * Read an existing pack manifest, or null when the pack is new.
 * @param {string} packDir
 * @param {string} packId
 */
function readExistingManifest(packDir, packId) {
  const p = join(packDir, PACK_MANIFEST);
  if (!existsSync(p)) return null;
  try {
    return validatePackManifest(yaml.parse(readFileSync(p, 'utf8')), packId, listPackAgentDirs(packDir));
  } catch {
    return null;      // an unreadable manifest is REPLACED by the harvest, not merged into
  }
}

/** Bump the patch component of a semver string. */
function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.0';
}

/**
 * Harvest live agents into a portable pack.
 *
 * Nothing is written until every named agent has passed both the charter validator and the
 * portability gate — a half-written pack is worse than none, because `agent pack list` would then
 * show it as shippable.
 *
 * @param {string} repoRoot
 * @param {string} packId
 * @param {{agents: string[], version?: string, displayName?: string, summary?: string,
 *          skillsRepo?: string, dryRun?: boolean}} opts
 * @returns {object} the plan (also the shape `--json` prints)
 */
export function harvestPack(repoRoot, packId, opts) {
  const names = [...new Set(opts.agents || [])];
  if (!names.length) {
    throw new SidekicksError(
      "agent pack harvest: --agents <a,b> is required — name the live agents to harvest",
      EXIT_VALIDATION
    );
  }

  const packDir = workspacePackDir(repoRoot, packId);
  const existing = readExistingManifest(packDir, packId);
  const universe = discoverSkills(repoRoot).map((s) => s.skill);

  const harvested = [];
  const refusals = [];
  for (const name of names) {
    let live;
    try {
      live = requireCharter(repoRoot, name, { deferCliValidation: true });
    } catch (err) {
      refusals.push(`${name}: ${firstLine(err)}`);
      continue;
    }
    const { charter, dropped } = sanitizeCharter(live);
    try {
      validateCompleteCharter(charter, name, 'agent pack harvest');
      assertPortableCharter(packId, name, charter);
    } catch (err) {
      refusals.push(`${name}: ${firstLine(err)}`);
      continue;
    }
    const seeds = skillsNamedIn(charter, universe);
    harvested.push({ name, charter, dropped, seeds });
  }

  if (refusals.length) {
    throw new SidekicksError(
      [
        `agent pack harvest: ${refusals.length} of ${names.length} agent(s) cannot travel — nothing was written.`,
        ...refusals.map((r) => `  - ${r}`),
        '',
        'A charter is refused, never rewritten: the offending text is part of what that agent IS,',
        'and deleting it here would publish an agent describing a role it no longer has. Edit the',
        'live charter (or leave the agent out of --agents) and run harvest again.',
      ].join('\n'),
      EXIT_VALIDATION
    );
  }

  // Carry an existing pack's agents forward: harvest ADDS to a pack, it does not silently shrink one.
  const carried = existing
    ? existing.agents.filter((a) => !harvested.some((h) => h.name === a))
    : [];
  const agentNames = [...new Set([...carried, ...harvested.map((h) => h.name)])].sort();

  // Seeds from the newly harvested charters, plus whatever the pack already declared, so a carried
  // agent does not lose its requirements.
  const seeds = [...new Set([
    ...harvested.flatMap((h) => h.seeds),
    ...(existing ? existing.requires_skills.map((d) => d.name) : []),
  ])].sort();
  const { all: skills, added: closureAdded } = expandSkillSeeds(repoRoot, seeds);

  const prevByName = new Map((existing?.requires_skills ?? []).map((d) => [d.name, d]));
  const requiresSkills = skills.map((name) => prevByName.get(name) ?? {
    name, required: true, source: 'skills-repo', degraded: '',
  });

  const version = opts.version
    ?? (existing ? bumpPatch(existing.version) : '1.0.0');
  const manifest = {
    schema: PACK_SCHEMA,
    id: packId,
    version,
    display_name: opts.displayName || existing?.display_name || `${packId} pack`,
    summary: opts.summary || existing?.summary || '',
    agents: agentNames,
    requires_skills: requiresSkills.map((d) => {
      const row = { name: d.name, required: d.required !== false, source: d.source || 'skills-repo' };
      if (d.degraded) row.degraded = d.degraded;
      return row;
    }),
    skills_repo: opts.skillsRepo || existing?.skills_repo || DEFAULT_SKILLS_REPO,
  };
  if (!manifest.summary) delete manifest.summary;

  // Validate the manifest we are about to write against the agent set it will have on disk, so a
  // harvest can never produce a pack that `agent pack list` then grades invalid.
  validatePackManifest(manifest, packId, agentNames);

  const plan = {
    pack: packId,
    dir: toRepoRel(repoRoot, packDir),
    created: !existing,
    version,
    previous_version: existing?.version ?? null,
    agents: harvested.map((h) => ({ name: h.name, dropped: h.dropped, skills_named: h.seeds })),
    carried_agents: carried,
    requires_skills: manifest.requires_skills.map((d) => d.name),
    skills_from_closure: closureAdded,
    files: [],
    dry_run: Boolean(opts.dryRun),
  };

  const files = [
    `${PACKS_DIR_REL}/${packId}/${PACK_MANIFEST}`,
    ...harvested.map((h) => `${PACKS_DIR_REL}/${packId}/${PACK_AGENTS_DIR}/${h.name}/agent.yaml`),
  ];
  plan.files = files;
  if (opts.dryRun) return plan;

  for (const h of harvested) {
    const dst = join(packDir, PACK_AGENTS_DIR, h.name, 'agent.yaml');
    const text = yaml.serialize(h.charter);
    yaml.assertRoundTrips(text, `agent pack harvest: charter for '${h.name}'`);
    assertWritable(dst, repoRoot);
    mkdirp(join(packDir, PACK_AGENTS_DIR, h.name));
    writeAtomic(dst, text);
    // Routines are schedules; a published charter may not carry one, so a re-harvest into a pack
    // that used to hold them clears the folder rather than leaving a stale copy.
    rmSync(join(packDir, PACK_AGENTS_DIR, h.name, 'routines'), { recursive: true, force: true });
  }

  const manifestPath = join(packDir, PACK_MANIFEST);
  const manifestText = renderManifest(manifest);
  assertWritable(manifestPath, repoRoot);
  mkdirp(packDir);
  writeAtomic(manifestPath, manifestText);

  return plan;
}

/**
 * Render `pack.yaml` with its standing header.
 *
 * Hand-rolled rather than yaml.serialize'd for one reason: the header explains why a pack declares
 * skills instead of carrying them, and a serializer would drop it on every re-harvest.
 */
function renderManifest(manifest) {
  const header = [
    `# ${manifest.display_name} — an agent pack shipped inside the framework core.`,
    '#',
    '# OPTIONAL. Shipping it is not installing it: `core init` and `core update` write no agent, ever.',
    '# A user opts in with `sidekicks agent pack install ' + manifest.id + '`.',
    '#',
    '# GENERATED by `sidekicks agent pack harvest` from live agents, then sanitized: no credentials,',
    '# no Telegram relay, no pacemaker or daemon knobs, no schedules, no absolute paths.',
    '# `lib/agent-lifecycle/_pack.mjs` re-checks that at read time, so a charter that drifts cannot ship.',
    '#',
    '# The skills below are DECLARED, never bundled — they travel through the public skills repository',
    '# and its `sidekicks skill import` path, and a pack carrying its own copies would fork them.',
    '# They are DERIVED from the charters plus each skill\'s declared siblings, so an agent that starts',
    '# using another skill adds it here on the next harvest.',
    '',
    '',
  ].join('\n');
  return `${header}${yaml.serialize(manifest)}`;
}

function firstLine(err) {
  return String(err && err.message ? err.message : err).split('\n')[0];
}
