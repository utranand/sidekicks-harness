// Private per-agent skill catalog. This tree is deliberately separate from
// .agents/skills/: host CLIs keep seeing the shared canonical tree, while only
// Sidekicks resolves owned and explicitly granted private versions.

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SidekicksError, EXIT_NOT_FOUND, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { resolveBlock } from '../config-store/read.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';

export const STORE_SCHEMA = 'agent-skill-release/v1';
export const GRANT_SCHEMA = 'agent-skill-grant/v1';
export const DEFAULT_SKILL_STORE = Object.freeze({
  checkout: 'projects/global/services/persistent-agent-skills/src',
  branch: 'agent-skills',
  remote: 'origin',
  push: 'never',
  repeat_threshold: 2,
  repeat_window_days: 30,
  candidate_cooldown_days: 7,
  max_generated_per_harvest: 1,
  context_limit: 5,
});

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export function assertSlug(value, label) {
  const text = String(value ?? '').trim();
  if (!SLUG_RE.test(text)) {
    throw new SidekicksError(`${label} must be a kebab-case slug`, EXIT_VALIDATION);
  }
  return text;
}

export function assertVersion(value) {
  const text = String(value ?? '').trim();
  if (!SEMVER_RE.test(text)) {
    throw new SidekicksError('agent skill: --version must be semantic version x.y.z', EXIT_VALIDATION);
  }
  return text;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function contained(repoRoot, rel, label) {
  const value = String(rel ?? '').trim().replace(/\\/g, '/');
  if (!value || isAbsolute(value) || value.split('/').includes('..')) {
    throw new SidekicksError(`${label} must be a portable repo-relative path`, EXIT_VALIDATION);
  }
  const abs = resolve(repoRoot, value);
  const back = relative(repoRoot, abs);
  if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new SidekicksError(`${label} escapes the repository`, EXIT_VALIDATION);
  }
  return { rel: value, abs };
}

export function resolveSkillStore(repoRoot) {
  let configured = {};
  try {
    configured = resolveBlock(repoRoot, 'agent_skill_store').config || {};
  } catch {
    configured = {};
  }
  const merged = { ...DEFAULT_SKILL_STORE, ...configured };
  const checkout = contained(repoRoot, merged.checkout, 'agent_skill_store.checkout');
  const push = String(merged.push ?? 'never');
  if (push !== 'never') {
    throw new SidekicksError(
      "agent_skill_store.push must remain 'never'; publishing is an explicit human boundary",
      EXIT_VALIDATION
    );
  }
  return {
    ...merged,
    workspaceRoot: repoRoot,
    checkout: checkout.rel,
    root: checkout.abs,
    branch: String(merged.branch || 'agent-skills'),
    remote: String(merged.remote || 'origin'),
    push,
    repeat_threshold: positiveInt(merged.repeat_threshold, DEFAULT_SKILL_STORE.repeat_threshold),
    repeat_window_days: positiveInt(merged.repeat_window_days, DEFAULT_SKILL_STORE.repeat_window_days),
    candidate_cooldown_days: positiveInt(merged.candidate_cooldown_days, DEFAULT_SKILL_STORE.candidate_cooldown_days),
    max_generated_per_harvest: positiveInt(merged.max_generated_per_harvest, DEFAULT_SKILL_STORE.max_generated_per_harvest),
    context_limit: positiveInt(merged.context_limit, DEFAULT_SKILL_STORE.context_limit),
  };
}

export function versionDir(cfg, owner, skill, version) {
  return join(cfg.root, 'agents', owner, 'skills', skill, 'versions', version);
}

export function releasePath(cfg, owner, skill, version) {
  return join(versionDir(cfg, owner, skill, version), 'release.yaml');
}

export function candidatePath(cfg, agent, reuseKey) {
  return join(cfg.root, 'candidates', agent, `${reuseKey}.yaml`);
}

export function grantPath(cfg, grantId) {
  return join(cfg.root, 'grants', `${grantId}.yaml`);
}

function readYaml(path, label) {
  try {
    return yaml.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new SidekicksError(
      `${label}: cannot read '${path}': ${String(err.message || err).split('\n')[0]}`,
      EXIT_VALIDATION
    );
  }
}

export function readRelease(cfg, owner, skill, version) {
  assertSlug(owner, 'agent skill release owner');
  assertSlug(skill, 'agent skill release id');
  assertVersion(version);
  const path = releasePath(cfg, owner, skill, version);
  if (!existsSync(path)) return null;
  const row = readYaml(path, 'agent skill release');
  if (!row || row.schema !== STORE_SCHEMA || row.owner !== owner || row.skill !== skill || row.version !== version) {
    throw new SidekicksError(`agent skill: invalid release manifest at ${relative(cfg.root, path)}`, EXIT_VALIDATION);
  }
  return { ...row, path, dir: versionDir(cfg, owner, skill, version) };
}

export function readGrant(cfg, grantId) {
  assertSlug(grantId, 'grant id');
  const path = grantPath(cfg, grantId);
  if (!existsSync(path)) return null;
  const row = readYaml(path, 'agent skill grant');
  const valid = row
    && row.schema === GRANT_SCHEMA
    && row.grant_id === grantId
    && SLUG_RE.test(String(row.owner || ''))
    && SLUG_RE.test(String(row.recipient || ''))
    && SLUG_RE.test(String(row.skill || ''))
    && SEMVER_RE.test(String(row.version || ''))
    && (!row.alias || SLUG_RE.test(String(row.alias)))
    && ['proposed', 'approved', 'revoked'].includes(row.status);
  if (!valid) {
    throw new SidekicksError(`agent skill: invalid grant manifest at ${relative(cfg.root, path)}`, EXIT_VALIDATION);
  }
  return { ...row, path };
}

function dirs(path) {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort(codeUnit);
  } catch {
    return [];
  }
}

function files(path) {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => entry.name)
      .sort(codeUnit);
  } catch {
    return [];
  }
}

function codeUnit(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function compareVersions(a, b) {
  const pa = SEMVER_RE.exec(a) || [];
  const pb = SEMVER_RE.exec(b) || [];
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i] || 0) - Number(pb[i] || 0);
    if (d) return d;
  }
  if (!pa[4] && pb[4]) return 1;
  if (pa[4] && !pb[4]) return -1;
  return codeUnit(String(pa[4] || ''), String(pb[4] || ''));
}

export function listOwned(cfg, owner, { all = false } = {}) {
  const root = join(cfg.root, 'agents', owner, 'skills');
  const rows = [];
  for (const skill of dirs(root)) {
    const versions = dirs(join(root, skill, 'versions')).sort(compareVersions).reverse();
    for (const version of versions) {
      const release = readRelease(cfg, owner, skill, version);
      if (!release || (!all && release.status !== 'active')) continue;
      rows.push({ ...release, access: 'owned', exposed_as: skill });
      if (!all) break;
    }
  }
  return rows;
}

export function listGrants(cfg, recipient, { includeInactive = false } = {}) {
  const rows = [];
  for (const name of files(join(cfg.root, 'grants'))) {
    const grant = readGrant(cfg, name.slice(0, -'.yaml'.length));
    if (!grant || grant.recipient !== recipient) continue;
    if (!includeInactive && grant.status !== 'approved') continue;
    rows.push(grant);
  }
  return rows.sort((a, b) => codeUnit(String(a.grant_id), String(b.grant_id)));
}

export function effectiveCatalog(cfg, agent) {
  const out = [];
  const names = new Set();
  for (const release of listOwned(cfg, agent)) {
    names.add(release.skill);
    out.push(release);
  }
  for (const grant of listGrants(cfg, agent)) {
    const release = readRelease(cfg, grant.owner, grant.skill, grant.version);
    if (!release || release.status !== 'active') continue;
    const exposed = grant.alias || grant.skill;
    if (names.has(exposed)) continue;
    names.add(exposed);
    out.push({ ...release, access: 'granted', exposed_as: exposed, grant_id: grant.grant_id });
  }
  return out.sort((a, b) => codeUnit(a.exposed_as, b.exposed_as));
}

export function resolveAuthorizedRelease(cfg, agent, requested, version = null) {
  const own = listOwned(cfg, agent, { all: true })
    .filter((row) => row.status === 'active' && row.skill === requested && (!version || row.version === version));
  if (own.length) return own.sort((a, b) => compareVersions(b.version, a.version))[0];
  const grants = listGrants(cfg, agent).filter((grant) => (grant.alias || grant.skill) === requested);
  for (const grant of grants) {
    if (version && grant.version !== version) continue;
    const release = readRelease(cfg, grant.owner, grant.skill, grant.version);
    if (release && release.status === 'active') {
      return { ...release, access: 'granted', exposed_as: grant.alias || grant.skill, grant_id: grant.grant_id };
    }
  }
  throw new SidekicksError(
    `agent skill: '${agent}' is not authorized for private skill '${requested}'${version ? ` at ${version}` : ''}`,
    EXIT_NOT_FOUND
  );
}

function tokens(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9-]+/).filter((v) => v.length > 1));
}

export function privateSkillContext(repoRoot, charter, text = '') {
  if (!charter || charter.skill_learning?.enabled !== true) return '';
  let cfg;
  try { cfg = resolveSkillStore(repoRoot); } catch { return ''; }
  if (!existsSync(cfg.root)) return '';
  const categoryTokens = new Set((charter.categories || []).map((v) => String(v).toLowerCase()));
  const textTokens = tokens(text);
  const matched = effectiveCatalog(cfg, charter.name).filter((row) => {
    const categories = Array.isArray(row.categories) ? row.categories.map((v) => String(v).toLowerCase()) : [];
    const keywords = [row.skill, row.description, ...(Array.isArray(row.keywords) ? row.keywords : [])];
    const categoryMatch = categories.some((v) => categoryTokens.has(v));
    const tokenMatch = [...tokens(keywords.join(' '))].some((v) => textTokens.has(v));
    return categoryMatch || tokenMatch;
  }).slice(0, cfg.context_limit);
  if (!matched.length) return '';
  const lines = matched.map((row) =>
    `- ${row.exposed_as}@${row.version} (${row.access}): ${String(row.description || '').replace(/\s+/g, ' ').trim().slice(0, 180)}; load: sidekicks agent skill show ${charter.name} ${row.exposed_as}`
  );
  return `PRIVATE SKILL CATALOG (authorized metadata only; load a body on demand):\n${lines.join('\n')}`;
}

export function assertRealDirectory(path, label) {
  if (!existsSync(path)) throw new SidekicksError(`${label} does not exist: ${path}`, EXIT_NOT_FOUND);
  let real;
  try { real = realpathSync(path); } catch { real = null; }
  if (!real) throw new SidekicksError(`${label} cannot be resolved: ${path}`, EXIT_VALIDATION);
  return real;
}
