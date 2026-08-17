// lib/agent-lifecycle/_pack.mjs
// The AGENT PACK format (`agent-pack/v1`) — discovery, validation, and the state of an install.
// NOT a dispatchable verb (no VERBS entry); `pack.mjs` is the verb that drives this.
//
// A pack is a versioned, PORTABLE bundle of agent charters that ships INSIDE a framework release
// and is never installed for a user without them asking. It declares the skills its agents need;
// it never embeds, duplicates or fetches one. Layout:
//
//   .sidekicks/agent-packs/<pack-id>/
//     pack.yaml                       the manifest (schema: agent-pack/v1)
//     agents/<name>/agent.yaml        one charter per agent, validated exactly like a live one
//     agents/<name>/routines/routines.yaml   optional
//
// WHY A SEPARATE DIRECTORY, not `.sidekicks/agents/`. The forge deliberately never bulk-copies
// `.sidekicks/agents/` — that guarantee is STRUCTURAL (`.sidekicks` is not a copy surface), and an
// operator's live agents carry Telegram relay wiring, pacemaker knobs and personal memory that must
// not be published. Packs are authored, sanitized content in their own named directory, so shipping
// them costs the live-agent guarantee nothing.
//
// WHERE INSTALL STATE LIVES. In the installed charter itself, as a `pack:` block — not in a state
// file. `.sidekicks/state/` is git-ignored and per-machine, so a state-file record would report
// every pack as not-installed on a fresh clone of a workspace whose agents ARE committed and
// present. This also matches the roster's own rule: scan-on-read, no index file to drift
// (see listAgentNames in ./_shared.mjs).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { coreDirOf, isCoreCheckout } from '../sk-cli/core-mount.mjs';
import { discoverSkills } from '../skill-manifest/read.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
import { SLUG_RE } from '../memory-lifecycle/_shared.mjs';
import { validateCompleteCharter, listAgentNames, readCharter, charterPath } from './_shared.mjs';

/** Directory, relative to a repo/core root, that holds agent packs. */
export const PACKS_DIR_REL = join('.sidekicks', 'agent-packs');

/** The manifest filename inside a pack directory. */
export const PACK_MANIFEST = 'pack.yaml';

/** The only manifest schema this build writes and understands. */
export const PACK_SCHEMA = 'agent-pack/v1';

/** Where a pack's agent charters live, relative to the pack directory. */
export const PACK_AGENTS_DIR = 'agents';

/** `source:` values a dependency row may carry. */
export const DEP_SOURCES = ['skills-repo', 'none'];

/** Install states of one agent within a pack. */
export const AGENT_STATES = ['absent', 'installed', 'customized', 'conflict', 'invalid'];

/** Install states of a whole pack. */
export const PACK_STATES = ['ready', 'degraded', 'not-installed', 'invalid'];

/** Stamped into an installed charter's `pack.source`, so provenance names the channel. */
export const PACK_SOURCE = 'framework-core';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// Charter text that makes a pack agent NON-portable. Each entry is a thing a public workspace does
// not have, so an agent that references it would either fail or — worse — describe a capability it
// cannot exercise. Matched case-insensitively against every string leaf of the charter.
//
// Deliberately NOT a generic "looks like a secret" scan: the poison here is INTEGRATION wiring, and
// a credential-shaped value is caught separately by CREDENTIAL_KEY_RE below.
//
// Equally deliberately, SAFETY prose is not on this list. A principle reading "Teleport-only prod
// access stays live" names a rule, not a wire — banning the word would push a pack author to delete
// a safety sentence in order to pass a portability check, which is the opposite of the point. What
// is banned is machinery that carries credentials or per-machine config and would therefore either
// fail or, worse, describe a capability the agent cannot exercise.
const NON_PORTABLE_PATTERNS = Object.freeze([
  { re: /\btelegram\b/i, what: 'a Telegram integration' },
  { re: /\bagent[_ -]?daemon\b/i, what: 'the agent_daemon pacemaker config' },
  { re: /\bpacemaker\b/i, what: 'the delegate pacemaker' },
  { re: /\bagent[- ]bridge\b|\bLAN bridge\b/i, what: 'the LAN agent bridge' },
  { re: /\bcron\b/i, what: 'a schedule' },
]);

// A machine-absolute path persisted into a published artifact (portable-paths floor rule).
const ABSOLUTE_PATH_RE = /(^|[\s"'(])(?:\/(?:Users|home|opt|var)\/|[A-Za-z]:[\\/])/;

// Credential-shaped charter keys. Same vocabulary as lib/config-store/write.mjs, restated here
// rather than imported so a pack check never depends on the config subsystem loading.
const CREDENTIAL_KEY_RE = /(api_key|apikey|token|password|passwd|secret|pass)/i;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Every root that may hold agent packs, most-specific first.
 *
 *   1. the workspace's own `.sidekicks/agent-packs/` — packs the user authored
 *   2. the mounted core's, when one is mounted at `.sidekicks-core/`
 *
 * When `repoRoot` IS a core checkout (a standalone clone, or the service checkout where the core is
 * forged) case 1 already names its packs, so no third case is needed — `coreDirOf` returns null
 * there and the single root is correct.
 *
 * @param {string} repoRoot
 * @returns {Array<{root: string, origin: 'workspace'|'core'}>}
 */
export function resolvePackRoots(repoRoot) {
  const roots = [{ root: join(repoRoot, PACKS_DIR_REL), origin: isCoreCheckout(repoRoot) ? 'core' : 'workspace' }];
  const core = coreDirOf(repoRoot);
  if (core) roots.push({ root: join(core, PACKS_DIR_REL), origin: 'core' });
  return roots;
}

/**
 * Discover every pack visible from `repoRoot`, workspace packs shadowing core packs of the same id.
 *
 * A pack whose manifest does not parse or does not validate is RETURNED, not skipped, carrying
 * `valid: false` and `errors[]` — `agent pack list` must be able to show an invalid pack, because a
 * pack that silently disappears is indistinguishable from one that was never shipped.
 *
 * @param {string} repoRoot
 * @returns {Array<PackRecord>}
 */
export function discoverPacks(repoRoot) {
  /** @type {Map<string, PackRecord>} */
  const byId = new Map();
  for (const { root, origin } of resolvePackRoots(repoRoot)) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;                        // an absent packs directory is never an error
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const dir = join(root, e.name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(join(dir, PACK_MANIFEST))) continue;   // a pack is defined by having one
      if (byId.has(e.name)) continue;                        // first root wins — workspace shadows core
      byId.set(e.name, readPack(dir, e.name, origin));
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Read one pack directory into a record. Never throws — a broken pack becomes `valid: false`.
 *
 * @param {string} dir     absolute path of the pack directory
 * @param {string} dirName the directory's name, which the manifest's `id` must equal
 * @param {'workspace'|'core'} origin
 * @returns {PackRecord}
 */
export function readPack(dir, dirName, origin = 'workspace') {
  /** @type {PackRecord} */
  const rec = {
    id: dirName,
    dir,
    origin,
    valid: false,
    errors: [],
    manifest: null,
    agents: [],                        // [{name, dir, charter, error}]
  };

  let parsed;
  try {
    parsed = yaml.parse(readFileSync(join(dir, PACK_MANIFEST), 'utf8'));
  } catch (err) {
    rec.errors.push(`${PACK_MANIFEST} failed to parse: ${firstLine(err)}`);
    return rec;
  }

  try {
    rec.manifest = validatePackManifest(parsed, dirName);
  } catch (err) {
    rec.errors.push(firstLine(err));
    return rec;
  }

  rec.id = rec.manifest.id;
  for (const name of rec.manifest.agents) {
    const agentDirAbs = join(dir, PACK_AGENTS_DIR, name);
    const entry = { name, dir: agentDirAbs, charter: null, error: null };
    const yamlPath = join(agentDirAbs, 'agent.yaml');
    if (!existsSync(yamlPath)) {
      entry.error = `pack '${rec.id}' declares agent '${name}' but ${PACK_AGENTS_DIR}/${name}/agent.yaml is missing`;
      rec.errors.push(entry.error);
    } else {
      try {
        const charter = validateCompleteCharter(yaml.parse(readFileSync(yamlPath, 'utf8')), name, 'agent pack');
        assertPortableCharter(rec.id, name, charter);
        entry.charter = charter;
      } catch (err) {
        entry.error = firstLine(err);
        rec.errors.push(entry.error);
      }
    }
    rec.agents.push(entry);
  }

  rec.valid = rec.errors.length === 0;
  return rec;
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

/**
 * Validate a parsed `pack.yaml`, returning the normalized manifest.
 *
 * @param {unknown} manifest
 * @param {string} [expectedId] the pack directory name, which `id` must equal
 * @returns {PackManifest}
 * @throws {SidekicksError(EXIT_VALIDATION)}
 */
export function validatePackManifest(manifest, expectedId) {
  const fail = (message) => {
    throw new SidekicksError(
      `agent pack: invalid ${PACK_MANIFEST}${expectedId ? ` for '${expectedId}'` : ''} — ${message}`,
      EXIT_VALIDATION
    );
  };
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('must be a mapping');
  if (manifest.schema !== PACK_SCHEMA) fail(`schema must be '${PACK_SCHEMA}'`);
  if (typeof manifest.id !== 'string' || !SLUG_RE.test(manifest.id)) fail('id must be a kebab-case slug');
  if (expectedId && manifest.id !== expectedId) fail(`id must equal the directory name '${expectedId}'`);
  if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) fail('version must be semver (X.Y.Z)');
  if (typeof manifest.display_name !== 'string' || !manifest.display_name.trim()) fail('display_name is required');
  if ('summary' in manifest && typeof manifest.summary !== 'string') fail('summary must be a string');

  if (!Array.isArray(manifest.agents) || manifest.agents.length === 0) fail('agents must be a non-empty list');
  const seen = new Set();
  for (const a of manifest.agents) {
    if (typeof a !== 'string' || !SLUG_RE.test(a)) fail(`agent name '${a}' must be a kebab-case slug`);
    if (seen.has(a)) fail(`agent '${a}' is listed twice`);
    seen.add(a);
  }

  const deps = manifest.requires_skills ?? [];
  if (!Array.isArray(deps)) fail('requires_skills must be a list');
  const depSeen = new Set();
  for (const d of deps) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) fail('each requires_skills entry must be a mapping');
    if (typeof d.name !== 'string' || !d.name.trim()) fail('each requires_skills entry needs a name');
    if (depSeen.has(d.name)) fail(`skill '${d.name}' is required twice`);
    depSeen.add(d.name);
    if ('required' in d && typeof d.required !== 'boolean') fail(`requires_skills '${d.name}': required must be a boolean`);
    const source = d.source ?? 'skills-repo';
    if (!DEP_SOURCES.includes(source)) {
      fail(`requires_skills '${d.name}': source must be one of: ${DEP_SOURCES.join(', ')}`);
    }
    // An OPTIONAL dependency is what makes a degraded install legible, so it must say what is lost.
    if (d.required === false && (typeof d.degraded !== 'string' || !d.degraded.trim())) {
      fail(`requires_skills '${d.name}': an optional dependency must carry a 'degraded:' sentence saying what stops working without it`);
    }
  }

  // Any dependency that can be installed needs somewhere to install it FROM. A mounted core carries
  // no skill-manager configuration, so the remediation cannot be resolved from config — the pack
  // has to state the repository itself or the message would be unactionable.
  const installable = deps.some((d) => (d.source ?? 'skills-repo') === 'skills-repo');
  if (installable && (typeof manifest.skills_repo !== 'string' || !manifest.skills_repo.trim())) {
    fail("skills_repo is required when any requires_skills entry has source 'skills-repo' — it is what the remediation command clones");
  }
  if (manifest.skills_repo != null && typeof manifest.skills_repo !== 'string') fail('skills_repo must be a string');

  return {
    schema: manifest.schema,
    id: manifest.id,
    version: manifest.version,
    display_name: manifest.display_name,
    summary: typeof manifest.summary === 'string' ? manifest.summary : '',
    agents: [...manifest.agents],
    requires_skills: deps.map((d) => ({
      name: d.name,
      required: d.required !== false,
      source: d.source ?? 'skills-repo',
      degraded: typeof d.degraded === 'string' ? d.degraded : '',
    })),
    skills_repo: typeof manifest.skills_repo === 'string' ? manifest.skills_repo : '',
  };
}

/**
 * Refuse a pack charter that could not travel to a stranger's machine.
 *
 * A live agent charter may legitimately name the operator's Telegram relay, pacemaker knobs or
 * absolute paths. A PUBLISHED one may not: none of it exists in a fresh workspace, so the agent
 * would either fail or describe a capability it cannot exercise. Enforced here rather than only in
 * a test, so a hand-authored pack cannot ship past it.
 *
 * @param {string} packId
 * @param {string} name
 * @param {object} charter
 * @throws {SidekicksError(EXIT_VALIDATION)}
 */
export function assertPortableCharter(packId, name, charter) {
  const fail = (message) => {
    throw new SidekicksError(
      `agent pack: pack '${packId}' agent '${name}' is not portable — ${message}`,
      EXIT_VALIDATION
    );
  };

  if (charter.default_work_dir) fail("default_work_dir must be empty — a published charter cannot pin one workspace's folder");
  if ('pack' in charter) fail("a pack's source charter must not carry a 'pack:' block — provenance is stamped at install time");

  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (ABSOLUTE_PATH_RE.test(node)) fail(`'${path}' contains a machine-absolute path`);
      for (const { re, what } of NON_PORTABLE_PATTERNS) {
        if (re.test(node)) fail(`'${path}' references ${what}, which a fresh workspace does not have`);
      }
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (CREDENTIAL_KEY_RE.test(k)) fail(`'${path ? `${path}.` : ''}${k}' is a credential-shaped key`);
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(charter, '');
}

// ---------------------------------------------------------------------------
// Dependency + install state
// ---------------------------------------------------------------------------

/**
 * Grade every declared skill dependency against what this repo actually carries.
 *
 * @param {string} repoRoot
 * @param {PackManifest} manifest
 * @returns {Array<{name: string, required: boolean, source: string, degraded: string,
 *                  status: 'available'|'missing-installable'|'unavailable'}>}
 */
export function dependencyStatuses(repoRoot, manifest) {
  const present = new Set(discoverSkills(repoRoot).map((s) => s.skill));
  return manifest.requires_skills.map((d) => ({
    ...d,
    status: present.has(d.name)
      ? 'available'
      : (d.source === 'skills-repo' ? 'missing-installable' : 'unavailable'),
  }));
}

/**
 * The exact commands that would make a missing dependency available.
 *
 * Self-contained on purpose: a mounted core carries no `sk-skill-manager`, therefore no
 * configured skills-repo destination, so a message saying "import it" without naming the clone
 * would be unactionable exactly where it matters most.
 *
 * @param {PackManifest} manifest
 * @param {string[]} missing skill names with status 'missing-installable'
 * @param {string} [clone] where to clone to (a placeholder path, never persisted)
 * @returns {string[]}
 */
export function remediationCommands(manifest, missing, clone = '/tmp/sidekicks-skills') {
  if (!missing.length) return [];
  const out = [`git clone ${manifest.skills_repo} ${clone}`];
  for (const name of missing) out.push(`sidekicks skill import ${name} --from ${clone} --with-deps`);
  out.push('sidekicks framework sync');
  for (const name of missing) out.push(`sidekicks skill doctor ${name}`);
  return out;
}

/**
 * The stable content hash of a pack charter, as stamped into `pack.checksum` at install time.
 *
 * Computed over the SERIALIZED charter with any `pack:` block removed, so the value a later run
 * recomputes from an installed agent is comparable to the one computed from the pack source. Line
 * endings are normalized to LF first — the same reason skill bundles do it: a CRLF checkout must
 * not read as a customized agent.
 *
 * @param {object} charter
 * @returns {string} `sha256:<hex>`
 */
export function charterChecksum(charter) {
  const { pack: _drop, ...rest } = charter;
  const text = yaml.serialize(rest).replace(/\r\n/g, '\n');
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Grade one pack agent against what is installed in this repo.
 *
 * `conflict` and `customized` are DIFFERENT answers and both refuse to write:
 *   - conflict   — an agent of that name exists with no provenance from this pack. Somebody else's
 *                  agent; installing over it would destroy work the pack never owned.
 *   - customized — provenance matches, but the charter no longer hashes to what the pack shipped.
 *                  The user edited a pack agent, which is allowed and is theirs to keep.
 *
 * @param {string} repoRoot
 * @param {PackRecord} pack
 * @param {{name: string, charter: object|null, error: string|null}} entry
 * @returns {{name: string, state: string, detail: string, installed_version: string|null}}
 */
export function agentInstallState(repoRoot, pack, entry) {
  if (!entry.charter) {
    return { name: entry.name, state: 'invalid', detail: entry.error || 'charter did not validate', installed_version: null };
  }
  if (!existsSync(charterPath(repoRoot, entry.name))) {
    return { name: entry.name, state: 'absent', detail: 'not installed', installed_version: null };
  }

  let installed;
  try {
    installed = readCharter(repoRoot, entry.name, { deferCliValidation: true });
  } catch (err) {
    return { name: entry.name, state: 'conflict', detail: `an agent named '${entry.name}' exists but its charter does not parse: ${firstLine(err)}`, installed_version: null };
  }

  const prov = installed && installed.pack;
  if (!prov || prov.id !== pack.id) {
    return {
      name: entry.name,
      state: 'conflict',
      detail: prov
        ? `an agent named '${entry.name}' is already installed from pack '${prov.id}'`
        : `an agent named '${entry.name}' already exists and was not installed from a pack`,
      installed_version: prov ? String(prov.version || '') : null,
    };
  }

  const want = charterChecksum(entry.charter);
  const have = charterChecksum(installed);
  if (have !== want) {
    return {
      name: entry.name,
      state: 'customized',
      detail: `installed from pack '${pack.id}' v${prov.version} and edited since — left untouched`,
      installed_version: String(prov.version || ''),
    };
  }
  return {
    name: entry.name,
    state: 'installed',
    detail: `installed from pack '${pack.id}' v${prov.version}`,
    installed_version: String(prov.version || ''),
  };
}

/**
 * The whole status of one pack: per-agent states, per-dependency states, and the single word that
 * answers "can I use this".
 *
 *   invalid       — the pack itself does not validate. Nothing else is meaningful.
 *   not-installed — no agent of the pack is present.
 *   degraded      — installed, but an OPTIONAL dependency is missing, or an agent could not be
 *                   installed (conflict), so the pack is not delivering what it declares.
 *   ready         — every agent present and every required dependency available.
 *
 * A missing REQUIRED dependency on an installed pack is `degraded` rather than a fourth word: the
 * install gate refuses to create that situation, so reaching it means a skill was removed after the
 * fact, and the honest report is "installed, not fully working".
 *
 * @param {string} repoRoot
 * @param {PackRecord} pack
 * @returns {PackStatus}
 */
export function packStatus(repoRoot, pack) {
  if (!pack.valid) {
    return {
      id: pack.id, version: pack.manifest ? pack.manifest.version : null, origin: pack.origin,
      state: 'invalid', agents: [], dependencies: [], errors: [...pack.errors],
      display_name: pack.manifest ? pack.manifest.display_name : '',
    };
  }
  const agents = pack.agents.map((e) => agentInstallState(repoRoot, pack, e));
  const dependencies = dependencyStatuses(repoRoot, pack.manifest);

  const anyPresent = agents.some((a) => a.state === 'installed' || a.state === 'customized');
  const allPresent = agents.every((a) => a.state === 'installed' || a.state === 'customized');
  const depsSatisfied = dependencies.every((d) => d.status === 'available');

  let state;
  if (!anyPresent) state = 'not-installed';
  else if (allPresent && depsSatisfied) state = 'ready';
  else state = 'degraded';

  return {
    id: pack.id,
    version: pack.manifest.version,
    display_name: pack.manifest.display_name,
    origin: pack.origin,
    state,
    agents,
    dependencies,
    errors: [],
  };
}

/**
 * Find one pack by id, or throw a message that names how to see the list.
 *
 * @param {string} repoRoot
 * @param {string} id
 * @returns {PackRecord}
 */
export function requirePack(repoRoot, id) {
  const hit = discoverPacks(repoRoot).find((p) => p.id === id);
  if (!hit) {
    throw new SidekicksError(
      `agent pack: no pack '${id}' — run 'sidekicks agent pack list' to see what this installation carries`,
      EXIT_VALIDATION
    );
  }
  return hit;
}

/**
 * Names of agents this repo already has, for callers that want the roster without a second scan.
 *
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
export function installedAgentNames(repoRoot) {
  return new Set(listAgentNames(repoRoot));
}

function firstLine(err) {
  return String(err && err.message ? err.message : err).split('\n')[0];
}

/**
 * @typedef {{schema: string, id: string, version: string, display_name: string, summary: string,
 *            agents: string[],
 *            requires_skills: Array<{name: string, required: boolean, source: string, degraded: string}>,
 *            skills_repo: string}} PackManifest
 * @typedef {{id: string, dir: string, origin: 'workspace'|'core', valid: boolean, errors: string[],
 *            manifest: PackManifest|null,
 *            agents: Array<{name: string, dir: string, charter: object|null, error: string|null}>}} PackRecord
 * @typedef {{id: string, version: string|null, display_name: string, origin: string, state: string,
 *            agents: Array<{name: string, state: string, detail: string, installed_version: string|null}>,
 *            dependencies: Array<{name: string, required: boolean, source: string, degraded: string, status: string}>,
 *            errors: string[]}} PackStatus
 */
