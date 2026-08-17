// lib/skill-lifecycle/destinations.mjs
// `sidekicks skill destinations [<skill>] [--destination <name>] [--json]`
//
// Answers "which skills are published to which skills repository, and are those copies current?"
//
// THE ANSWER IS DERIVED, NEVER STORED. `skill export` is a one-way write: it reads nothing at the
// destination and records nothing back here, so before this verb the source repo held no trace of
// what had been published where. The fix is deliberately NOT a hand-maintained registry — every
// fact already exists at the destination (`catalog.yaml`, `meta/<skill>/origin.yaml`) and in the
// local bundle baseline, so this verb reads those and computes the status. A registry file would
// only add a fifth thing to keep in step.
//
// Statuses, per skill x destination:
//   in-sync           the destination's copy is byte-identical to the local baseline
//   stale             it is there but differs (or the destination is missing files the baseline has)
//   retracted         it WAS published there and has been withdrawn (`skill remove --destination`)
//   never-exported    the local skill has no copy at that destination
//   destination-only  the destination carries a skill this repo does not have
//
// `retracted` and `never-exported` are the same absence from the file system and a very different
// fact, which is why the retraction leaves a tombstone behind: `meta/<skill>/origin.yaml` rewritten
// with `retracted: true`. Nothing else at a destination records a withdrawal — `catalog.yaml` is
// regenerated wholesale by the next export — so without the tombstone a deliberate unpublish would
// read forever as "nobody has gotten around to publishing this".
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { discoverSkills } from '../skill-manifest/read.mjs';
import { bundleFileList } from '../skill-package/portable.mjs';
import { resolveSkillConfig } from '../skill-config/resolve.mjs';
import { parse } from '../yaml-subset/yaml.mjs';
import { parseSkillFlags, positionalArgs } from './_shared.mjs';

/** The skill that owns the `skill_manager` config block the destinations are declared in. */
const OWNER_SKILL = 'sk-skill-manager';

/**
 * Where a skill from each LOCAL tree is PUBLISHED inside a destination repository — layout 2.
 *
 * A MAP, not a prefix swap, and that is the whole point. Layout 1 published both trees under one
 * parent, so export could take a local tree's basename and re-join it onto a literal `'.sidekicks'`.
 * Rule 3 moved the active tree to `.agents/skills` while the parked tree stayed at
 * `.sidekicks/skill-offloaded`, so the two no longer share a parent and a basename no longer
 * determines a destination path. Re-joining one is the bug shape that already bit
 * `lib/skill-package/source-layout.mjs` (see probe()'s comment) and `import.mjs applyRenames`: it
 * resolves to a directory that does not exist and reads EMPTY rather than failing.
 *
 * Keys are this repo's trees; values are the destination's. They happen to be equal today, and that
 * is a coincidence of layout 2 rather than a rule — a destination is a separate repository on its own
 * release cadence, so the two sides are allowed to diverge and this map is where that is expressed.
 */
export const PUBLISHED_TREES = Object.freeze({
  '.agents/skills': '.agents/skills',
  '.sidekicks/skill-offloaded': '.sidekicks/skill-offloaded',
});

/** Layout-1 trees, read-only. Kept forever: a clone published before the layout 2 bump must resolve. */
const LEGACY_DEST_TREES = Object.freeze(['.sidekicks/skills']);

/**
 * The trees a skills REPOSITORY mirrors, in lookup order.
 *
 * NOT this repo's skill trees, and deliberately NOT built from lib/sk-cli/skill-trees.mjs.
 * These name the on-disk layout of a *destination* — a separate git repository with its own release
 * cadence (utranand/sidekicks-skills, …). This repo relocating its canonical tree does not move a
 * byte over there, so binding the two would silently make every published skill read as
 * `never-exported` the day the local tree moves.
 *
 * So the list carries BOTH layouts and every use is a first-hit-wins probe: a destination still on
 * layout 1 resolves, one written at layout 2 resolves, and no caller needs to know which.
 *
 * READ ORDER AGREES WITH WRITE ORDER BY CONSTRUCTION. It is built from `PUBLISHED_TREES` — what
 * `skill export` actually writes — with the layout-1 trees appended as read tolerance behind them.
 * Before this it was a hand-ordered literal with a comment asking the next editor to keep the two in
 * step, which is exactly the kind of instruction that goes stale: a probe that finds a layout-1 copy
 * first would report status against a tree nothing updates any more.
 *
 * Exported because remove.mjs needs exactly this list and used to carry a second copy of it.
 */
export const DEST_TREES = Object.freeze([
  ...new Set(Object.values(PUBLISHED_TREES)),
  ...LEGACY_DEST_TREES,
]);

/**
 * The destination path for a skill living in `localTree`.
 *
 * Throws rather than guessing. An unmapped tree means a new local tree was added without deciding
 * where its skills publish, and the failure mode of guessing — re-joining a basename onto a fixed
 * prefix — writes to a directory nothing reads and reports success.
 *
 * @param {string} localTree - a repo-relative POSIX tree path, e.g. `.agents/skills`
 * @returns {string} the destination-relative POSIX tree path
 */
export function publishedTreeFor(localTree) {
  const dest = PUBLISHED_TREES[localTree];
  if (dest) return dest;
  throw new SidekicksError(
    `skill export: no published location is declared for the local tree '${localTree}' — `
    + `add it to PUBLISHED_TREES in lib/skill-lifecycle/destinations.mjs `
    + `(known: ${Object.keys(PUBLISHED_TREES).join(', ')})`,
    EXIT_VALIDATION
  );
}

/** Block-level keys that are settings, not destinations. */
const NON_DESTINATION_KEYS = Object.freeze(new Set(['layout']));

/**
 * Normalise the `skill_manager.skill_repo` block into a list of named destinations.
 *
 * BACKWARD COMPATIBLE ON PURPOSE. The block used to be a single flat repo (`remote:` + `checkout:`
 * at the top), and a lifted copy of this skill may still carry that shape — it resolves to one
 * destination named `default` rather than an error, because a config written before the map existed
 * is not a misconfiguration.
 *
 * @param {object|null|undefined} skillRepo
 * @returns {Array<{name: string, remote: string, checkout: string}>}
 */
export function normalizeDestinations(skillRepo) {
  if (!skillRepo || typeof skillRepo !== 'object' || Array.isArray(skillRepo)) return [];

  // Flat legacy shape: `remote:` sitting directly in the block.
  if (typeof skillRepo.remote === 'string') {
    return [{
      name: 'default',
      remote: String(skillRepo.remote || ''),
      checkout: String(skillRepo.checkout || ''),
      source_repo: String(skillRepo.source_repo || ''),
    }];
  }

  const out = [];
  for (const [name, value] of Object.entries(skillRepo)) {
    if (NON_DESTINATION_KEYS.has(name)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    out.push({
      name,
      remote: String(value.remote || ''),
      checkout: String(value.checkout || ''),
      // Optional per-destination provenance override. A public destination and a private one are
      // routinely attributed to different repos, and `export.source_repo` alone cannot say that.
      // Empty means "no destination-specific answer", which falls through to the block-level one.
      source_repo: String(value.source_repo || ''),
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The configured destinations for this repo, each with its checkout resolved to an absolute path.
 *
 * A missing skill-manager descriptor or config block is NOT an error: a lean runtime may carry the
 * export machinery without ever configuring a destination, and this verb should say "none
 * configured" rather than fail.
 *
 * @param {string} repoRoot
 * @returns {Array<{name: string, remote: string, checkout: string, dir: string|null, present: boolean}>}
 */
export function configuredDestinations(repoRoot) {
  let config = null;
  try {
    config = resolveSkillConfig(repoRoot, OWNER_SKILL).config;
  } catch {
    return [];
  }
  return normalizeDestinations(config && config.skill_repo).map((d) => {
    const dir = d.checkout ? (isAbsolute(d.checkout) ? d.checkout : join(repoRoot, d.checkout)) : null;
    let present = false;
    try {
      present = dir !== null && statSync(dir).isDirectory();
    } catch {
      present = false;
    }
    return { ...d, dir, present };
  });
}

/**
 * The `skill_manager.export` settings block, or `{}` when nothing is configured.
 *
 * Read through the same resolver as the destinations so a project-level override, the root config
 * and the skill's own defaults all apply identically. A missing skill, block or config file is not
 * an error — the caller's own fallback is the answer in that case.
 *
 * @param {string} repoRoot
 * @returns {{source_repo?: string, with_deps?: boolean, require_clean_bundle?: boolean}}
 */
export function exportSettings(repoRoot) {
  try {
    const config = resolveSkillConfig(repoRoot, OWNER_SKILL).config;
    const block = config && config.export;
    return block && typeof block === 'object' && !Array.isArray(block) ? block : {};
  } catch {
    return {};
  }
}

/**
 * A skill's declared destination intent, read from its own `skill.yaml`.
 *
 * `skill_repo: <destination-name>` pins it to one destination; `skill_repo: none` withholds it from
 * every destination. Unset (the common case — most skills ship no descriptor at all) means "no
 * declared intent", which is NOT the same as `none`: unset exports anywhere, `none` exports nowhere.
 * That distinction is the whole point — it separates a deliberately withheld skill from one nobody
 * has published yet.
 *
 * @param {{dir: string}} entry
 * @returns {string|null}
 */
export function readDestinationIntent(entry) {
  const abs = join(entry.dir, 'skill.yaml');
  if (!existsSync(abs)) return null;
  let obj;
  try {
    obj = parse(readFileSync(abs, 'utf8'));
  } catch {
    return null;                       // a malformed descriptor is the registry's finding, not ours
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const value = obj.skill_repo;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Where a skill sits inside a layout-1 destination tree, or null when it is not there. */
function destinationSkillDir(destDir, skill) {
  for (const tree of DEST_TREES) {
    const dir = join(destDir, ...tree.split('/'), skill);
    if (existsSync(join(dir, 'SKILL.md'))) return dir;
  }
  return null;
}

/** The `meta/<skill>/origin.yaml` facts a destination recorded at export time. */
function readOrigin(destDir, skill) {
  const abs = join(destDir, 'meta', skill, 'origin.yaml');
  if (!existsSync(abs)) return null;
  try {
    const obj = parse(readFileSync(abs, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** Every skill name a destination's generated catalog claims to carry. */
function catalogSkills(destDir) {
  const abs = join(destDir, 'catalog.yaml');
  if (!existsSync(abs)) return null;
  try {
    const obj = parse(readFileSync(abs, 'utf8'));
    const rows = obj && Array.isArray(obj.skills) ? obj.skills : [];
    return new Set(rows.map((r) => (r && typeof r.name === 'string' ? r.name : '')).filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Compare one local skill against one destination copy, file by file.
 *
 * Byte comparison, not hash comparison against the manifest: `copyBundle` writes byte-exact copies,
 * so anything other than byte equality means the destination has drifted from what this repo would
 * export today — which is exactly the question. Files the destination carries that the baseline no
 * longer lists are counted too, because export never deletes (copyBundle only writes), so a file
 * removed from a skill lingers at the destination and nothing else would notice.
 *
 * @returns {{status: 'in-sync'|'stale', differing: string[], missing: string[], extra: string[]}}
 */
function compareCopy(repoRoot, entry, destSkillDir) {
  const { files } = bundleFileList(repoRoot, entry);
  const differing = [];
  const missing = [];
  for (const rel of files) {
    const src = join(entry.dir, ...rel.split('/'));
    if (!existsSync(src)) continue;                    // not carried by export either
    const dest = join(destSkillDir, ...rel.split('/'));
    if (!existsSync(dest)) { missing.push(rel); continue; }
    if (!readFileSync(src).equals(readFileSync(dest))) differing.push(rel);
  }
  const carried = new Set(files);
  const extra = walkRelative(destSkillDir).filter((rel) => !carried.has(rel));
  const status = differing.length + missing.length + extra.length === 0 ? 'in-sync' : 'stale';
  return { status, differing, missing, extra };
}

/** Every file under a directory, as skill-relative POSIX paths. */
function walkRelative(dir, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkRelative(abs, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * The full status matrix: every local skill against every configured destination, plus whatever a
 * destination carries that this repo does not.
 *
 * @param {string} repoRoot
 * @param {{skill?: string|null, destination?: string|null}} [opts]
 */
export function destinationStatus(repoRoot, opts = {}) {
  const wanted = opts.skill || null;
  const destName = opts.destination || null;

  let destinations = configuredDestinations(repoRoot);
  if (destName) {
    const known = destinations.map((d) => d.name);
    destinations = destinations.filter((d) => d.name === destName);
    if (destinations.length === 0) {
      throw new SidekicksError(
        `skill destinations: unknown destination '${destName}' — configured: ${known.join(', ') || '(none)'}`,
        EXIT_VALIDATION
      );
    }
  }

  const local = discoverSkills(repoRoot);
  const localByName = new Map(local.map((e) => [e.skill, e]));
  const targets = wanted ? local.filter((e) => e.skill === wanted) : local;
  if (wanted && targets.length === 0) {
    throw new SidekicksError(
      `skill destinations: no skill named '${wanted}' in this repo`,
      EXIT_VALIDATION
    );
  }

  const catalogs = new Map();
  for (const d of destinations) {
    catalogs.set(d.name, d.present && d.dir ? catalogSkills(d.dir) : null);
  }

  const rows = [];
  for (const entry of targets) {
    const intent = readDestinationIntent(entry);
    const per = [];
    for (const d of destinations) {
      if (!d.present || !d.dir) {
        per.push({ destination: d.name, status: 'unreachable', checkout: d.checkout });
        continue;
      }
      const destSkillDir = destinationSkillDir(d.dir, entry.skill);
      if (!destSkillDir) {
        // A retraction tombstone is the only thing that separates "withdrawn" from "never sent".
        const tomb = readOrigin(d.dir, entry.skill);
        if (tomb && (tomb.retracted === true || String(tomb.retracted) === 'true')) {
          per.push({
            destination: d.name,
            status: 'retracted',
            retracted_at: tomb.retracted_at || null,
            exported_version: tomb.version || null,
          });
          continue;
        }
        per.push({ destination: d.name, status: 'never-exported' });
        continue;
      }
      const cmp = compareCopy(repoRoot, entry, destSkillDir);
      const origin = readOrigin(d.dir, entry.skill);
      const cat = catalogs.get(d.name);
      per.push({
        destination: d.name,
        status: cmp.status,
        differing: cmp.differing,
        missing: cmp.missing,
        extra: cmp.extra,
        exported_at: origin ? origin.exported_at || null : null,
        exported_version: origin ? origin.version || null : null,
        source_commit: origin ? origin.source_commit || null : null,
        in_catalog: cat ? cat.has(entry.skill) : null,
      });
    }
    rows.push({ skill: entry.skill, intent, destinations: per });
  }

  // What a destination carries that this repo does not — the other half of the drift, invisible
  // from the source side until now.
  const orphans = [];
  if (!wanted) {
    for (const d of destinations) {
      if (!d.present || !d.dir) continue;
      const seen = new Set();
      for (const tree of DEST_TREES) {
        const abs = join(d.dir, ...tree.split('/'));
        for (const name of walkTopLevel(abs)) {
          if (seen.has(name) || localByName.has(name)) continue;
          if (!existsSync(join(abs, name, 'SKILL.md'))) continue;
          seen.add(name);
          orphans.push({ skill: name, destination: d.name, status: 'destination-only' });
        }
      }
    }
  }

  return {
    destinations: destinations.map((d) => ({
      name: d.name, remote: d.remote, checkout: d.checkout, present: d.present,
    })),
    skills: rows,
    orphans,
  };
}

/** Directory names directly under `dir` (empty when it does not exist). */
function walkTopLevel(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Run `skill destinations`.
 *
 * @param {{repoRoot: string, argv: string[], flags: object}} ctx
 * @param {{name?: string}} args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, args) {
  const flags = parseSkillFlags(ctx.argv, ['json']);
  const names = positionalArgs(ctx.argv, ['destination']);
  const skill = args && args.name ? args.name : (names[0] || null);
  const destination = typeof flags.destination === 'string' && flags.destination
    ? String(flags.destination)
    : null;

  const report = destinationStatus(ctx.repoRoot, { skill, destination });

  if (flags.json) {
    return { stdout: JSON.stringify(report, null, 2) + '\n', exitCode: EXIT_OK };
  }

  const out = [];
  if (report.destinations.length === 0) {
    out.push('skill destinations: no destination configured');
    out.push('');
    out.push("  Declare them under `skill_manager.skill_repo:` — one named block per repository,");
    out.push('  each with `remote:` and a `checkout:` path. Inspect the resolved result with');
    out.push(`  'sidekicks framework config ${OWNER_SKILL}'.`);
    return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
  }

  out.push(`Destinations (${report.destinations.length}):`);
  for (const d of report.destinations) {
    out.push(`  ${d.name.padEnd(10)} ${d.checkout || '(no local checkout)'}`
      + `${d.present ? '' : '  [UNREACHABLE — nothing to compare against]'}`);
  }
  out.push('');

  const counts = { 'in-sync': 0, stale: 0, retracted: 0, 'never-exported': 0, unreachable: 0 };
  for (const row of report.skills) {
    const parts = row.destinations.map((p) => `${p.destination}: ${p.status}`);
    for (const p of row.destinations) {
      if (p.status in counts) counts[p.status] += 1;
    }
    const intent = row.intent ? `  intent: ${row.intent}` : '';
    out.push(`  ${row.skill.padEnd(42)} ${parts.join('  |  ')}${intent}`);
    for (const p of row.destinations) {
      if (p.status === 'retracted') {
        out.push(`      ${p.destination}: withdrawn${p.retracted_at ? ` at ${p.retracted_at}` : ''}`
          + `${p.exported_version ? ` (last published ${p.exported_version})` : ''}`);
        continue;
      }
      if (p.status !== 'stale') continue;
      const bits = [];
      if (p.differing && p.differing.length) bits.push(`${p.differing.length} differing`);
      if (p.missing && p.missing.length) bits.push(`${p.missing.length} missing at destination`);
      if (p.extra && p.extra.length) bits.push(`${p.extra.length} left behind (export never deletes)`);
      out.push(`      ${p.destination}: ${bits.join(', ')}`);
    }
  }

  if (report.orphans.length) {
    out.push('', `Destination-only (${report.orphans.length}) — carried there, absent here:`);
    for (const o of report.orphans) out.push(`  ${o.skill.padEnd(42)} ${o.destination}`);
  }

  out.push('', `in-sync ${counts['in-sync']}  stale ${counts.stale}  retracted ${counts.retracted}`
    + `  never-exported ${counts['never-exported']}`);
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
