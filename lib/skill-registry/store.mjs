// lib/skill-registry/store.mjs
// Where registration profiles live, and the only code that writes them.
//
// `.sidekicks/registry/skills/<name>.yaml`, COMMITTED. Three placements were available and two are
// wrong:
//   - `.sidekicks/state/` is git-ignored and rebuildable (lib/state-store/paths.mjs). A receipt that
//     vanishes on a fresh clone cannot drive a removal on a fresh clone.
//   - `.sidekicks/config/` holds configuration VALUES and boolean settings, written only by
//     `sidekicks config` / `framework sync` (CLAUDE.md). A receipt is neither.
//   - Inside the skill folder is impossible: `bundle{}` covers every file there, so the profile
//     would report `bundle-stale` on the first `skill doctor` and block the next export. That is the
//     same reason `skill export` puts provenance in a sibling `meta/<skill>/` tree.
// So: authored content at the top level of `.sidekicks/`, beside `memory/` and `agents/`.
//
// Removed skills leave a TOMBSTONE under `removed/`, because "this repo used to carry X, here is
// what was undone and where the backup went" is the one question a deleted file cannot answer.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { hashContent, isBinaryPath } from '../skill-manifest/hash.mjs';
import { discoverSkills, readSkillManifest, readSkillDescriptor } from '../skill-manifest/read.mjs';
import { walkSkillFiles } from '../skill-lifecycle/scan.mjs';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { renderProfile, parseProfile, UNKNOWN } from './profile.mjs';

/** Repo-relative, POSIX. Recorded into reports, so never machine-absolute. */
export const REGISTRY_REL = '.sidekicks/registry/skills';
const REMOVED_REL = `${REGISTRY_REL}/removed`;

/** Where one skill's profile lives. */
export function profilePath(repoRoot, name) {
  return join(repoRoot, ...REGISTRY_REL.split('/'), `${name}.yaml`);
}

/** Where one skill's tombstone lives once it has been removed. */
export function tombstonePath(repoRoot, name) {
  return join(repoRoot, ...REMOVED_REL.split('/'), `${name}.yaml`);
}

/**
 * Write (or replace) one profile.
 *
 * Refuses to record a skill that is not actually on disk: a receipt for something that was never
 * installed is worse than no receipt, because `--check` would then report a phantom orphan forever.
 *
 * @param {string} repoRoot
 * @param {object} facts
 * @returns {{path: string, created: boolean}}
 */
export function recordProfile(repoRoot, facts) {
  const name = facts.skill;
  if (!name) throw new SidekicksError('skill registry: a profile needs a skill name', EXIT_VALIDATION);
  const entry = discoverSkills(repoRoot).find((e) => e.skill === name);
  if (!entry) {
    throw new SidekicksError(
      `skill registry: refusing to record '${name}' — it is not installed under either skill tree`,
      EXIT_VALIDATION
    );
  }
  const abs = profilePath(repoRoot, name);
  const created = !existsSync(abs);
  assertWritable(abs, repoRoot);
  writeAtomic(abs, renderProfile({ ...facts, mirror: facts.mirror || mirrorFacts(repoRoot, entry) }));
  return { path: `${REGISTRY_REL}/${name}.yaml`, created };
}

/** One profile, or null. Never throws on absence — most skills legitimately have none. */
export function readProfile(repoRoot, name, { removed = false } = {}) {
  const abs = removed ? tombstonePath(repoRoot, name) : profilePath(repoRoot, name);
  if (!existsSync(abs)) return null;
  const { profile, errors } = parseProfile(readFileSync(abs, 'utf8'), name);
  return profile ? { ...profile, _errors: errors } : null;
}

/** Every profile, sorted. `.yaml` only, and tombstones excluded unless asked for. */
export function listProfiles(repoRoot, { includeRemoved = false } = {}) {
  const out = [];
  for (const [rel, removed] of [[REGISTRY_REL, false], [REMOVED_REL, true]]) {
    if (removed && !includeRemoved) continue;
    let entries;
    try { entries = readdirSync(join(repoRoot, ...rel.split('/')), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.yaml')) continue;
      const name = e.name.slice(0, -5);
      const p = readProfile(repoRoot, name, { removed });
      if (p) out.push({ ...p, _removed: removed });
    }
  }
  return out.sort((a, b) => (a.skill < b.skill ? -1 : 1));
}

/**
 * Retire a profile.
 *
 * The default leaves a tombstone: after the folder is gone, the tombstone is the only thing that can
 * say what was undone and where the backup went. `{tombstone:false}` purges outright, which is what
 * a mistaken import wants.
 */
export function removeProfile(repoRoot, name, { tombstone = true, facts = null } = {}) {
  const live = profilePath(repoRoot, name);
  const existing = existsSync(live) ? readProfile(repoRoot, name) : null;
  if (tombstone) {
    const abs = tombstonePath(repoRoot, name);
    assertWritable(abs, repoRoot);
    writeAtomic(abs, renderProfile({
      ...(existing || { skill: name, provenance: UNKNOWN }),
      ...(facts || {}),
      skill: name,
      status: 'removed',
      history: [...((existing && existing.history) || []), ...(((facts || {}).history) || [])],
    }));
  }
  if (existsSync(live)) {
    assertWritable(live, repoRoot);
    rmSync(live, { force: true });
  }
  return { path: tombstone ? `${REMOVED_REL}/${name}.yaml` : null, had: Boolean(existing) };
}

/** The mirror block, recomputed from disk. The only fields `--check` is allowed to argue about. */
export function mirrorFacts(repoRoot, entry) {
  const files = walkSkillFiles(entry.dir);
  let version = '';
  try {
    version = String(JSON.parse(readFileSync(join(entry.dir, 'VERSION.json'), 'utf8')).version || '');
  } catch { version = ''; }
  return {
    tree: entry.tree,
    version,
    manifest_present: readSkillManifest(repoRoot, entry).present,
    descriptor_present: Boolean(readSkillDescriptor(repoRoot, entry)),
    file_count: files.length,
  };
}

/** The recorded content hashes of a skill folder, for `files:`. */
export function fileHashes(entry) {
  const out = {};
  for (const f of walkSkillFiles(entry.dir)) {
    out[f.rel] = hashContent(readFileSync(f.abs), isBinaryPath(f.rel));
  }
  return out;
}

/**
 * Every skill and every profile, reconciled.
 *
 * `untracked` — a skill with no profile — is NOT an error and never fails a check. Most skills in
 * this repo were authored here; only imported ones carry a receipt, which is the whole scope of the
 * store.
 *
 * @returns {Array<{skill: string, status: string, detail: string}>}
 */
export function profileDrift(repoRoot) {
  const skills = new Map(discoverSkills(repoRoot).map((e) => [e.skill, e]));
  const profiles = new Map(listProfiles(repoRoot).map((p) => [p.skill, p]));
  const rows = [];

  for (const [name, p] of profiles) {
    const entry = skills.get(name);
    if (!entry) {
      rows.push({
        skill: name, status: 'missing-runtime',
        detail: 'a profile with no skill — the folder was removed without `sidekicks skill remove`',
      });
      continue;
    }
    if (incomplete(p)) {
      rows.push({
        skill: name, status: 'incomplete',
        detail: `backfilled: ${countUnknown(p)} recorded field(s) are '${UNKNOWN}' because nobody can know them after the fact`,
      });
      continue;
    }
    const now = mirrorFacts(repoRoot, entry);
    const mismatch = Object.keys(now).filter((k) => String(now[k]) !== String((p.mirror || {})[k]));
    if (mismatch.length) {
      rows.push({
        skill: name, status: 'tree-drift',
        detail: `mirror disagrees with disk on ${mismatch.join(', ')} — disk wins; re-record it`,
      });
      continue;
    }
    const changed = changedSince(entry, p.files || {});
    if (changed.length) {
      rows.push({
        skill: name, status: 'local-only',
        detail: `${changed.length} file(s) edited since import (${changed.slice(0, 3).join(', ')})`,
      });
      continue;
    }
    rows.push({ skill: name, status: 'up-to-date', detail: 'as imported' });
  }

  for (const name of skills.keys()) {
    if (profiles.has(name)) continue;
    rows.push({
      skill: name, status: 'untracked',
      detail: 'no import receipt — expected for a skill authored in this repo',
    });
  }

  return rows.sort((a, b) => (a.skill < b.skill ? -1 : 1));
}

/** Files whose bytes differ from what the profile recorded at import time. */
function changedSince(entry, recorded) {
  const out = [];
  const now = fileHashes(entry);
  for (const rel of Object.keys(recorded)) {
    if (now[rel] !== recorded[rel]) out.push(rel);
  }
  return out.sort();
}

function countUnknown(p) {
  let n = 0;
  for (const block of [p.source, p.upstream, p.adapter, p.licence, p.imported_by]) {
    if (!block || typeof block !== 'object') continue;
    for (const v of Object.values(block)) if (v === UNKNOWN) n++;
  }
  if (p.imported_at === UNKNOWN) n++;
  return n;
}

function incomplete(p) {
  return p.provenance === 'backfilled' || countUnknown(p) > 0;
}
