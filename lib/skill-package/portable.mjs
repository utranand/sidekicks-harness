// lib/skill-package/portable.mjs
// Copying a skill somewhere else, and the provenance that has to ride alongside it.
//
// THE BASELINE IS THE FILE LIST. `bundle{}` already records every file in the skill except the
// manifest itself (asserted by tests/skills/skill-manifest-materialize.test.mjs), each with an
// LF-normalized sha256. So an export does not need — and must not invent — a second policy about
// what travels: it copies exactly the recorded set, hash-verifying as it goes. That makes the copy
// verifiable by construction, and it means `skill verify` run against the destination is a real
// check rather than a re-statement of whatever the copier happened to do.
//
// The corollary is that a stale baseline BLOCKS an export rather than being papered over. An
// unrecorded file on disk is a question about what the skill is, and exporting past it just moves
// the drift somewhere it will be harder to see.
//
// BINARY SAFETY. Files are copied through readFileSync-with-no-encoding + writeAtomic, NOT through
// lib/fs-safety/fsx.mjs copyAtomic — that helper reads `'utf8'`, which silently mangles a PNG or a
// font through lossy replacement. writeAtomic passes a Buffer to writeFileSync unchanged (verified),
// so the Buffer path is byte-exact for both text and binary, and the recorded hash then matches at
// the destination. The BINARY_EXT denylist in lib/skill-manifest/hash.mjs exists precisely because
// skills do carry such files.
//
// MODE. Content is byte-exact but the source's file MODE is not read by default anywhere in this
// module's copy path — copyBundle asks fsx.execAwareMode() for a normalized destination mode (0o755
// if the source has any execute bit, else 0o644) and hands it to writeAtomic as `opts.mode`, applied
// to the temp file before the rename. Normalized, not a raw mode copy, so an export stays
// reproducible across umasks and platforms rather than dragging along whatever the source
// filesystem happened to carry.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic, execAwareMode } from '../fs-safety/fsx.mjs';
import { hashContent, isBinaryPath } from '../skill-manifest/hash.mjs';
import { readSkillManifest, MANIFEST_NAME } from '../skill-manifest/read.mjs';
import { walkSkillFiles } from '../skill-lifecycle/scan.mjs';
import { findPoison } from '../yaml-subset/yaml.mjs';

/**
 * The on-disk contract version of the skills repository — see the skill-manager's reference doc
 * (`references/skill-repo-layout.md`, §3 layout 1 and §3b layout 2).
 *
 * LAYOUT 3 (2026-08-18): a destination has ONE skill tree, `<root>/.agents/skills/`. Whether a skill
 * is parked HERE is a local fact about this repo's discovery, not a property of the published copy,
 * so a parked skill publishes to the same tree as an active one and a destination never carries
 * `.sidekicks/skill-offloaded/` at all. `publishedTreeFor()` stays a MAP rather than becoming a
 * constant: the local trees still do not share a parent, and a future local tree must be forced to
 * declare where it publishes instead of having a basename re-joined onto a prefix for it.
 *
 * LAYOUT 2 (2026-08-17): the active tree publishes to `<root>/.agents/skills/`, matching the
 * canonical location Rule 3 gave it in this repo, and the parked tree published to
 * `<root>/.sidekicks/skill-offloaded/`. Layout 1 published both under `<root>/.sidekicks/skills/`.
 *
 * This is stamped into `catalog.yaml` and every `origin.yaml`, and NOTHING branches on it when
 * reading: layout detection is a filesystem probe (`NATIVE_TREE_PATHS` in source-layout.mjs,
 * `DEST_TREES` in skill-lifecycle/destinations.mjs), and both carry every layout's trees. So a clone
 * published before this bump keeps importing and keeps reporting status, forever, with no migration —
 * the stamp records which layout wrote a tree, it does not gate reading one.
 */
export const LAYOUT_VERSION = 3;

/**
 * The files that make up one skill, and whether the baseline can be trusted.
 *
 * @param {string} repoRoot
 * @param {{skill: string, tree: string, dir: string}} entry
 * @returns {{
 *   skill: string, source: 'bundle'|'walk', files: string[],
 *   stale: Array<{rel: string, reason: 'missing'|'mismatch'|'unrecorded'}>,
 *   manifest: boolean,
 * }}
 */
export function bundleFileList(repoRoot, entry) {
  const read = readSkillManifest(repoRoot, entry);
  const onDisk = walkSkillFiles(entry.dir)
    .map((f) => f.rel)
    .filter((rel) => rel !== MANIFEST_NAME);

  if (!read.present || !read.manifest || !Object.keys(read.manifest.bundle || {}).length) {
    // 41 skills ship no manifest, and a skills repository that refused to carry them would be
    // useless. Falling back to the walk is correct — but `source` says so, so a caller can report
    // that this skill's copy is unverifiable rather than implying it was checked.
    return { skill: entry.skill, source: 'walk', files: onDisk.sort(), stale: [], manifest: read.present };
  }

  const bundle = read.manifest.bundle;
  const stale = [];
  for (const [rel, recorded] of Object.entries(bundle)) {
    const abs = join(entry.dir, rel);
    if (!existsSync(abs)) { stale.push({ rel, reason: 'missing' }); continue; }
    const actual = hashContent(readFileSync(abs), isBinaryPath(rel));
    if (actual !== recorded) stale.push({ rel, reason: 'mismatch' });
  }
  for (const rel of onDisk) {
    if (!(rel in bundle)) stale.push({ rel, reason: 'unrecorded' });
  }

  return {
    skill: entry.skill,
    source: 'bundle',
    files: [...Object.keys(bundle), MANIFEST_NAME].sort(),
    stale,
    manifest: true,
  };
}

/**
 * Copy one skill's files into `destSkillDir`, byte-exact.
 *
 * @param {{dir: string}} entry
 * @param {string} destSkillDir
 * @param {string[]} files - skill-relative paths
 * @returns {{copied: string[], skipped: string[]}}
 */
export function copyBundle(entry, destSkillDir, files) {
  const copied = [];
  const skipped = [];
  for (const rel of files) {
    const src = join(entry.dir, ...rel.split('/'));
    if (!existsSync(src)) { skipped.push(rel); continue; }
    writeAtomic(join(destSkillDir, ...rel.split('/')), readFileSync(src), { mode: execAwareMode(src) });
    copied.push(rel);
  }
  return { copied, skipped };
}

/**
 * Quote a value for the YAML subset: one line, single-quoted, apostrophes doubled.
 *
 * Not a general serializer — a deliberate narrow one, because the three constraints it enforces are
 * each a bug this repo has already been bitten by (docs/guide/skill-architecture.md §6): a block
 * scalar is read as the literal indicator and the folded body then parsed as STRUCTURE, a wrapped
 * quoted value is truncated at its first line, and `&`/`*` are refused anywhere on a line.
 */
export function yamlLine(value) {
  const flat = String(value === null || value === undefined ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[&*]/g, '+');
  return `'${flat.replace(/'/g, "''")}'`;
}

/**
 * The provenance sidecar for one exported skill.
 *
 * Lives in `meta/<skill>/`, NOT inside the skill folder — two independent reasons, either of which
 * is sufficient. It cannot go in `skill.manifest.yaml` because ROW_KEYS is a closed set and an
 * unknown key is a validation error across all 97 manifests. And it cannot sit next to SKILL.md
 * because `bundle{}` covers every file in the folder, so the sidecar itself would produce a
 * `bundle-stale` finding on the destination's first `skill doctor` — the exported folder has to stay
 * byte-identical to its source for the baseline to mean anything.
 *
 * @param {object} facts
 * @returns {string}
 */
export function renderOrigin(facts) {
  const lines = [
    '# origin.yaml — where this skill came from. Generated by `sidekicks skill export`.',
    '#',
    '# One long single-quoted line per prose value, apostrophes doubled, no & or * anywhere: the',
    '# yaml-subset reader refuses those and has no multi-line scalars at all.',
    '',
    'schema: 1',
    `layout: ${LAYOUT_VERSION}`,
    `skill: ${yamlLine(facts.skill)}`,
    `version: ${yamlLine(facts.version)}`,
    `tree: ${yamlLine(facts.tree)}`,
    `source_repo: ${yamlLine(facts.source_repo)}`,
    `source_commit: ${yamlLine(facts.source_commit)}`,
    `source_branch: ${yamlLine(facts.source_branch)}`,
    `exported_at: ${yamlLine(facts.exported_at)}`,
    `bundle_verified: ${facts.bundle_verified ? 'true' : 'false'}`,
    `file_count: ${facts.file_count}`,
    // Both taxonomies travel with the copy — see renderCatalogRow for why they are two fields.
    `group: ${yamlLine(facts.group || '')}`,
    `category: ${yamlLine(facts.category || facts.group || '')}`,
  ];
  // The outward edges a destination has to reconcile by hand. Recorded flat and comma-joined,
  // because the subset reader has no multi-line scalars and a nested list buys nothing here.
  lines.push('outside_edges:');
  for (const key of ['sibling_skills', 'framework_files', 'framework_hooks', 'host_paths', 'binaries']) {
    lines.push(`  ${key}: ${yamlLine((facts.outside_edges[key] || []).join(', '))}`);
  }
  const text = lines.join('\n') + '\n';
  const poison = findPoison(text);
  if (poison) {
    throw new Error(`renderOrigin produced a value the yaml-subset reader refuses: ${poison}`);
  }
  return text;
}

/**
 * The catalog row for one skill — the file ADVISE reads so "what do I need for X" never has to
 * clone 84 skill folders. Generated, therefore checkable for staleness rather than hand-maintained.
 *
 * @param {object} facts
 * @returns {string[]} lines
 */
export function renderCatalogRow(facts) {
  return [
    `  - name: ${yamlLine(facts.skill)}`,
    `    version: ${yamlLine(facts.version)}`,
    // TWO taxonomies, on purpose. `group` is the AUDIT group — what the skill-auditor sweeps
    // together, and what `first_party` is derived from. `category` is the PUBLICATION family — what
    // a reader browses together, and what the categories/<family>/README pages are built from. They
    // agree for most skills and cannot be made to agree for all: the framework's own skills audit
    // in four different groups and must browse as one. See sk-skill-manager's
    // assets/categories.yaml.
    `    group: ${yamlLine(facts.group || '')}`,
    `    category: ${yamlLine(facts.category || facts.group || '')}`,
    `    first_party: ${facts.first_party ? 'true' : 'false'}`,
    `    manifest: ${facts.manifest ? 'true' : 'false'}`,
    `    siblings: ${yamlLine((facts.outside_edges.sibling_skills || []).join(', '))}`,
    `    python: ${yamlLine((facts.python || []).join(', '))}`,
    `    binaries: ${yamlLine((facts.outside_edges.binaries || []).join(', '))}`,
    `    config_block: ${yamlLine(facts.config_block || '')}`,
    `    bundle_files: ${facts.file_count}`,
  ];
}

/**
 * The whole `catalog.yaml`.
 *
 * @param {{source_repo: string, source_commit: string, generated_at: string}} header
 * @param {object[]} rows - facts objects, one per skill
 * @returns {string}
 */
export function renderCatalog(header, rows) {
  const lines = [
    '# catalog.yaml — the generated index of this skills repository.',
    '#',
    '# GENERATED. Every field is derived from the skill s own skill.manifest.yaml, skill.yaml,',
    '# VERSION.json, the audit groups and the publication categories, so this file is checkable for',
    '# staleness rather than maintained by hand. Do not edit it; re-run `sidekicks skill export`.',
    '#',
    '# group    = the AUDIT group (what the skill-auditor sweeps together).',
    '# category = the PUBLICATION family (what categories/<family>/README.md lists). Usually the',
    '#            same; deliberately different where a family browses across audit groups.',
    '',
    'schema: 1',
    `layout: ${LAYOUT_VERSION}`,
    `generated_at: ${yamlLine(header.generated_at)}`,
    `source_repo: ${yamlLine(header.source_repo)}`,
    `source_commit: ${yamlLine(header.source_commit)}`,
    `skill_count: ${rows.length}`,
    'skills:',
  ];
  for (const r of [...rows].sort((a, b) => (a.skill < b.skill ? -1 : 1))) {
    lines.push(...renderCatalogRow(r));
  }
  const text = lines.join('\n') + '\n';
  const poison = findPoison(text);
  if (poison) {
    throw new Error(`renderCatalog produced a value the yaml-subset reader refuses: ${poison}`);
  }
  return text;
}

/**
 * Resolve `==` pins for the declared packages from the repo-root .venv.
 *
 * A declared package that the venv does not hold is emitted as `# UNRESOLVED <pkg>` rather than
 * dropped: an unpinned dependency that LOOKS pinned is worse than one that admits it, and the same
 * honesty contract is what sk-inherit uses for its UNMAPPED / UNPINNED markers.
 *
 * @param {string[]} packages
 * @param {string} freezeOutput - the raw output of `pip freeze` (caller spawns it; '' when no venv)
 * @returns {string}
 */
export function pinRequirements(packages, freezeOutput) {
  const pinned = new Map();
  for (const line of String(freezeOutput || '').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9._-]+)\s*==\s*(\S+)\s*$/);
    if (m) pinned.set(m[1].toLowerCase().replace(/[_.]/g, '-'), `${m[1]}==${m[2]}`);
  }
  const out = [
    '# requirements.lock.txt — the source .venv s resolved pins at export time.',
    '# A skill s OWN requirements.txt is the canonical carrier; this is for a destination that has',
    '# no .venv yet. An UNRESOLVED line is a real gap, deliberately not hidden.',
    '',
  ];
  if (!freezeOutput) out.push('# NO VENV at export time — nothing could be resolved.');
  for (const pkg of [...new Set(packages)].sort()) {
    const key = pkg.toLowerCase().replace(/[_.]/g, '-');
    out.push(pinned.has(key) ? pinned.get(key) : `# UNRESOLVED ${pkg}`);
  }
  return out.join('\n') + '\n';
}
