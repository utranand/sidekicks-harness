// `sidekicks agent skill ...`
//
// A mediated private-skill store for named persistent agents. The shared
// .agents/skills tree remains the only native host-CLI root; this lifecycle
// resolves private owned versions and pinned grants without exposing either
// tree globally.

import {
  existsSync, lstatSync, readFileSync, readdirSync, chmodSync, mkdirSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { mkdirp, writeAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
import {
  addPaths, commit, currentBranch, hasIdentity, hasStagedChanges, isRepo, remoteUrl,
} from '../git-delegation/git.mjs';
import { resolveJournalConfig, filterIndex } from '../journal-lifecycle/_shared.mjs';
import {
  parseMemoryFlags, bangkokTimestamp, requireCharter, validateAgentName,
  validateCompleteCharter, writeCharter,
} from './_shared.mjs';
import {
  STORE_SCHEMA, GRANT_SCHEMA, assertSlug, assertVersion, resolveSkillStore,
  versionDir, releasePath, candidatePath, grantPath, readRelease, listOwned,
  readGrant, listGrants, effectiveCatalog, resolveAuthorizedRelease, privateSkillContext,
} from './_skill-store.mjs';

const SUBS = new Set(['learning', 'doctor', 'list', 'context', 'show', 'harvest', 'install', 'approve', 'retire', 'grant']);
const PROTECTED = /^(main|master|sit|uat|staging|prod|production|release\/.*)$/i;
const VALUE_FLAGS = new Set([
  'from', 'skill', 'version', 'auditor', 'by', 'to', 'alias', 'text', 'description',
  'categories', 'keywords', 'reuse-key',
]);
const SECRET_NAME = /(^|\/)(\.env(?:\.|$)|id_rsa|id_ed25519|.*\.pem$|.*\.key$|credentials?\b|secrets?\b)/i;
const SECRET_BODY = /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|(?:password|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s<]{8,})/i;
const SAFETY_SOFTENING = /(bypass|disable|ignore|skip).{0,40}(approval|permission|safety|transaction|protected branch)/i;
const HIGH_RISK = /(production|database|credential|permission|destructive|irreversible|network|https?:\/\/|install\b|dependency|hook\b|config\b|delete\b|write\b)/i;

function reject(message) {
  throw new SidekicksError(`agent skill: ${message}`, EXIT_VALIDATION);
}

function positionals(argv) {
  const out = [];
  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i]);
    if (!token.startsWith('--')) { out.push(token); continue; }
    const eq = token.indexOf('=');
    const key = token.slice(2, eq === -1 ? undefined : eq);
    if (eq === -1 && VALUE_FLAGS.has(key) && i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) i += 1;
  }
  return out;
}

function csv(value) {
  return String(value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

function ensureEnabled(repoRoot, name, verb = 'agent skill') {
  const charter = requireCharter(repoRoot, validateAgentName(name));
  if (charter.skill_learning?.enabled !== true) {
    reject(`${verb}: '${name}' has skill_learning.enabled = false; run 'sidekicks agent skill learning enable ${name}' first`);
  }
  return charter;
}

function ensureWritableStore(cfg) {
  if (!existsSync(cfg.root) || !isRepo(cfg.root)) {
    reject(`private store '${cfg.checkout}' must exist as its own Git checkout before writes are allowed`);
  }
  const branch = currentBranch(cfg.root);
  if (branch !== cfg.branch) reject(`private store is on '${branch}', expected configured branch '${cfg.branch}'`);
  if (PROTECTED.test(branch)) reject(`private store branch '${branch}' is protected; configure a nonprotected branch`);
}

function storeRel(cfg, path) {
  const rel = relative(cfg.root, path).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../')) reject('a private-store path escaped its checkout');
  return rel;
}

function assertStoreWritePath(cfg, path) {
  const rel = storeRel(cfg, path);
  let cursor = cfg.root;
  for (const segment of rel.split('/')) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      reject(`private-store path contains a symlink: ${storeRel(cfg, cursor)}`);
    }
  }
  return rel;
}

function writeYaml(cfg, path, value, label) {
  const text = yaml.serialize(value);
  yaml.assertRoundTrips(text, label);
  assertStoreWritePath(cfg, path);
  assertWritable(path, cfg.workspaceRoot);
  mkdirp(dirname(path));
  writeAtomic(path, text);
}

function commitStorePaths(cfg, paths, message) {
  const rels = paths.map((p) => storeRel(cfg, p));
  addPaths(cfg.root, rels);
  if (!hasStagedChanges(cfg.root)) return '';
  commit(cfg.root, message, hasIdentity(cfg.root) ? {} : {
    identity: { name: 'Sidekicks Agent Skills', email: 'sidekicks-agent-skills@local.invalid' },
  });
  return ' [committed locally; push remains never]';
}

function render(rows) {
  if (!rows.length) return 'agent skill: none\n';
  const lines = ['ACCESS   NAME                       VERSION    STATUS'];
  for (const row of rows) {
    lines.push(`${String(row.access || '-').padEnd(8)} ${String(row.exposed_as || row.skill).padEnd(26)} ${String(row.version).padEnd(10)} ${row.status}`);
  }
  return `${lines.join('\n')}\n`;
}

function publicRow(row) {
  const { path: _path, dir: _dir, ...portable } = row;
  return portable;
}

function metadataLine(value, fallback = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 180) || fallback;
}

function metadataSlugs(value, label) {
  return csv(value).map((item) => assertSlug(item, label));
}

function learning(ctx, pos, flags) {
  const action = pos[1];
  if (!['enable', 'disable'].includes(action)) reject('learning expects enable or disable');
  const name = validateAgentName(pos[2]);
  const charter = requireCharter(ctx.repoRoot, name);
  const enabled = action === 'enable';
  const next = { ...charter, skill_learning: { enabled } };
  validateCompleteCharter(next, name, 'agent skill learning');
  writeCharter(ctx.repoRoot, name, next, 'agent skill learning');
  const result = { agent: name, skill_learning: { enabled } };
  return { stdout: flags.json ? `${JSON.stringify(result, null, 2)}\n` : `agent skill learning: ${name} → ${enabled ? 'enabled' : 'disabled'}\n`, exitCode: EXIT_OK };
}

function doctor(ctx, pos, flags) {
  const cfg = resolveSkillStore(ctx.repoRoot);
  const issues = [];
  const branch = existsSync(cfg.root) && isRepo(cfg.root) ? currentBranch(cfg.root) : null;
  if (!existsSync(cfg.root)) issues.push(`store checkout missing: ${cfg.checkout}`);
  else if (!isRepo(cfg.root)) issues.push(`store is not its own Git root: ${cfg.checkout}`);
  if (branch && branch !== cfg.branch) issues.push(`store branch is ${branch}; expected ${cfg.branch}`);
  if (branch && PROTECTED.test(branch)) issues.push(`store branch ${branch} is protected`);
  if (cfg.push !== 'never') issues.push('push policy is not never');
  const storeRemote = existsSync(cfg.root) ? remoteUrl(cfg.root, cfg.remote) : null;
  if (existsSync(cfg.root) && !storeRemote) issues.push(`store remote '${cfg.remote}' is missing`);
  const journal = resolveJournalConfig(ctx.repoRoot);
  const journalRemote = journal && existsSync(journal.storeRoot) ? remoteUrl(journal.storeRoot, journal.git.remote) : null;
  if (journalRemote && storeRemote && journalRemote !== storeRemote) issues.push('store remote differs from the configured journal remote');
  const name = pos[1];
  if (name) {
    const charter = requireCharter(ctx.repoRoot, validateAgentName(name));
    if (charter.skill_learning?.enabled !== true) issues.push(`agent '${name}' has skill learning disabled`);
  }
  const result = { ok: issues.length === 0, checkout: cfg.checkout, branch, remote: storeRemote, journal_remote: journalRemote, issues };
  return {
    stdout: flags.json ? `${JSON.stringify(result, null, 2)}\n` : (issues.length ? `agent skill doctor:\n${issues.map((v) => `- ${v}`).join('\n')}\n` : 'agent skill doctor: clean\n'),
    exitCode: issues.length ? EXIT_VALIDATION : EXIT_OK,
  };
}

function list(ctx, pos, flags) {
  const name = validateAgentName(pos[1]);
  ensureEnabled(ctx.repoRoot, name, 'list');
  const cfg = resolveSkillStore(ctx.repoRoot);
  let rows;
  if (flags.owned) rows = listOwned(cfg, name, { all: true });
  else if (flags.granted) rows = listGrants(cfg, name, { includeInactive: true }).map((row) => ({ ...row, access: 'granted', exposed_as: row.alias || row.skill }));
  else rows = effectiveCatalog(cfg, name);
  return { stdout: flags.json ? `${JSON.stringify(rows.map(publicRow), null, 2)}\n` : render(rows), exitCode: EXIT_OK };
}

function context(ctx, pos, flags) {
  const name = validateAgentName(pos[1]);
  const charter = ensureEnabled(ctx.repoRoot, name, 'context');
  const text = privateSkillContext(ctx.repoRoot, charter, flags.text || '');
  if (flags.json) return { stdout: `${JSON.stringify({ agent: name, context: text }, null, 2)}\n`, exitCode: EXIT_OK };
  return { stdout: text ? `${text}\n` : 'PRIVATE SKILL CATALOG: no authorized match\n', exitCode: EXIT_OK };
}

function show(ctx, pos, flags) {
  const name = validateAgentName(pos[1]);
  ensureEnabled(ctx.repoRoot, name, 'show');
  const requested = assertSlug(pos[2], 'private skill name');
  const cfg = resolveSkillStore(ctx.repoRoot);
  const row = resolveAuthorizedRelease(cfg, name, requested, flags.version ? assertVersion(flags.version) : null);
  const skillPath = join(row.dir, 'SKILL.md');
  if (!existsSync(skillPath)) reject(`authorized release ${row.skill}@${row.version} has no SKILL.md`);
  const body = readFileSync(skillPath, 'utf8');
  if (flags.json) return { stdout: `${JSON.stringify({ release: publicRow(row), body }, null, 2)}\n`, exitCode: EXIT_OK };
  return { stdout: `${row.skill}@${row.version} (${row.access})\n\n${body}`, exitCode: EXIT_OK };
}

function harvest(ctx, pos, flags) {
  const name = validateAgentName(pos[1]);
  ensureEnabled(ctx.repoRoot, name, 'harvest');
  const cfg = resolveSkillStore(ctx.repoRoot);
  ensureWritableStore(cfg);
  const journal = resolveJournalConfig(ctx.repoRoot);
  if (!journal) reject('harvest requires the configured agent journal');
  const cutoff = Date.now() - cfg.repeat_window_days * 86_400_000;
  const rows = filterIndex(journal, { kind: 'retro', agent: name, status: 'done' })
    .filter((row) => row.reuse_key && row.reuse_key !== 'none' && Date.parse(row.ts) >= cutoff);
  const grouped = new Map();
  for (const row of rows) {
    let reuseKey;
    try { reuseKey = assertSlug(row.reuse_key, 'retrospective reuse key'); } catch { continue; }
    const bucket = grouped.get(reuseKey) || [];
    if (!bucket.some((item) => item.task_id === row.task_id)) bucket.push(row);
    grouped.set(reuseKey, bucket);
  }
  const written = [];
  for (const [reuseKey, matches] of [...grouped.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    if (matches.length < cfg.repeat_threshold) continue;
    const path = candidatePath(cfg, name, reuseKey);
    let previous = null;
    if (existsSync(path)) {
      try { previous = yaml.parse(readFileSync(path, 'utf8')); } catch { previous = null; }
    }
    const last = previous?.last_harvested_at ? Date.parse(previous.last_harvested_at) : 0;
    if (last && Date.now() - last < cfg.candidate_cooldown_days * 86_400_000) continue;
    const candidate = {
      schema: 'agent-skill-candidate/v1', agent: name, reuse_key: reuseKey,
      status: 'eligible', occurrences: matches.length,
      task_ids: matches.map((row) => row.task_id).sort(),
      summary: matches[matches.length - 1].reuse_summary || matches[matches.length - 1].title,
      first_seen_at: matches.map((row) => row.ts).sort()[0],
      last_seen_at: matches.map((row) => row.ts).sort().at(-1),
      last_harvested_at: bangkokTimestamp(),
    };
    writeYaml(cfg, path, candidate, 'agent skill candidate');
    written.push(path);
  }
  const note = written.length ? commitStorePaths(cfg, written, `agent-skill(${name}): harvest ${written.length} candidate(s)`) : '';
  const result = { agent: name, candidates: written.map((path) => storeRel(cfg, path)) };
  return { stdout: flags.json ? `${JSON.stringify(result, null, 2)}\n` : `agent skill harvest: ${written.length} candidate(s)${note}\n`, exitCode: EXIT_OK };
}

function sourceFiles(root, dir = root, out = []) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1);
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs).replace(/\\/g, '/');
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) reject(`source bundle contains a symlink: ${rel}`);
    if (stat.isDirectory()) sourceFiles(root, abs, out);
    else if (stat.isFile()) out.push({ abs, rel, mode: stat.mode });
    else reject(`source bundle contains unsupported file type: ${rel}`);
  }
  return out;
}

function assessBundle(files) {
  const reasons = [];
  let hardReject = null;
  for (const file of files) {
    if (SECRET_NAME.test(file.rel)) { hardReject = `secret-shaped filename '${file.rel}'`; break; }
    const body = readFileSync(file.abs, 'utf8');
    if (SECRET_BODY.test(body)) { hardReject = `secret-shaped content in '${file.rel}'`; break; }
    if (SAFETY_SOFTENING.test(body)) { hardReject = `safety-softening instruction in '${file.rel}'`; break; }
    if ((file.mode & 0o111) !== 0) reasons.push(`${file.rel} is executable`);
    if (file.rel.startsWith('scripts/') || file.rel.startsWith('hooks/')) reasons.push(`${file.rel} contains executable behavior`);
    if (!/^(SKILL\.md|references\/|assets\/)/.test(file.rel)) reasons.push(`${file.rel} is outside the low-risk instruction/reference surface`);
    if (HIGH_RISK.test(body)) reasons.push(`${file.rel} mentions privileged or state-changing behavior`);
  }
  if (hardReject) return { decision: 'rejected', reasons: [hardReject] };
  return { decision: reasons.length ? 'review' : 'low', reasons: [...new Set(reasons)] };
}

function copyBundle(cfg, files, dest) {
  const written = [];
  for (const file of files) {
    if (file.rel === 'release.yaml') continue;
    const path = join(dest, ...file.rel.split('/'));
    assertStoreWritePath(cfg, path);
    assertWritable(path, cfg.workspaceRoot);
    mkdirp(dirname(path));
    writeAtomic(path, readFileSync(file.abs));
    if (process.platform !== 'win32') chmodSync(path, file.mode & 0o666);
    written.push(path);
  }
  return written;
}

function install(ctx, pos, flags) {
  const owner = validateAgentName(pos[1]);
  ensureEnabled(ctx.repoRoot, owner, 'install');
  const skill = assertSlug(flags.skill || basename(String(flags.from || '')), 'private skill id');
  const version = assertVersion(flags.version);
  const source = String(flags.from || '').trim();
  if (!source) reject('install requires --from <generated-skill-directory>');
  const sourceAbs = isAbsolute(source) ? resolve(source) : resolve(ctx.repoRoot, source);
  if (!existsSync(sourceAbs) || !lstatSync(sourceAbs).isDirectory() || lstatSync(sourceAbs).isSymbolicLink()) {
    reject('--from must name a real directory, not a symlink');
  }
  const files = sourceFiles(sourceAbs);
  if (!files.some((row) => row.rel === 'SKILL.md')) reject('source bundle must contain SKILL.md');
  const description = metadataLine(flags.description, `Learned procedure ${skill}`);
  const categories = metadataSlugs(flags.categories, 'private skill category');
  const keywords = metadataSlugs(flags.keywords, 'private skill keyword');
  const assessment = assessBundle(files);
  if (SECRET_BODY.test(description)) {
    assessment.decision = 'rejected';
    assessment.reasons.push('secret-shaped release description');
  }
  if (SAFETY_SOFTENING.test(description)) {
    assessment.decision = 'rejected';
    assessment.reasons.push('safety-softening release description');
  }
  if (assessment.decision !== 'rejected' && HIGH_RISK.test(description)) {
    assessment.decision = 'review';
    assessment.reasons.push('release description mentions privileged or state-changing behavior');
  }
  if (assessment.decision === 'rejected') reject(`bundle rejected: ${assessment.reasons.join('; ')}`);
  const auditor = flags.auditor ? validateAgentName(flags.auditor) : '';
  if (auditor) requireCharter(ctx.repoRoot, auditor);
  if (flags['attested-low-risk'] && (!auditor || auditor === owner)) {
    reject('--attested-low-risk requires an independent --auditor distinct from the owner');
  }
  const status = assessment.decision === 'low' && flags['attested-low-risk'] ? 'active' : 'pending_review';
  const cfg = resolveSkillStore(ctx.repoRoot);
  const dest = versionDir(cfg, owner, skill, version);
  if (existsSync(dest)) reject(`${skill}@${version} already exists; private versions are immutable`);
  const release = {
    schema: STORE_SCHEMA, owner, skill, version, description,
    categories, keywords,
    status, risk: assessment.decision, risk_reasons: assessment.reasons,
    auditor: auditor || '', attested_low_risk: Boolean(flags['attested-low-risk']),
    source_reuse_key: String(flags['reuse-key'] || ''),
    created_at: bangkokTimestamp(), activated_at: status === 'active' ? bangkokTimestamp() : '', retired_at: '',
  };
  const preview = { release, files: files.map((row) => row.rel), destination: storeRel(cfg, dest) };
  if (!flags.apply) {
    return { stdout: flags.json ? `${JSON.stringify(preview, null, 2)}\n` : `agent skill install dry-run: ${skill}@${version} → ${status}\n`, exitCode: EXIT_OK };
  }
  ensureWritableStore(cfg);
  // Claim the immutable version directory before copying. A second installer
  // racing this one gets EEXIST and cannot overwrite even one byte. A failed
  // copy removes only the directory this invocation just created.
  assertStoreWritePath(cfg, dest);
  mkdirp(dirname(dest));
  try { mkdirSync(dest); } catch (err) {
    if (err && err.code === 'EEXIST') reject(`${skill}@${version} already exists; private versions are immutable`);
    throw err;
  }
  let written;
  const manifest = releasePath(cfg, owner, skill, version);
  try {
    written = copyBundle(cfg, files, dest);
    writeYaml(cfg, manifest, release, 'agent skill release');
    written.push(manifest);
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }
  const note = commitStorePaths(cfg, written, `agent-skill(${owner}): install ${skill}@${version}`);
  return { stdout: flags.json ? `${JSON.stringify({ ...preview, committed: Boolean(note) }, null, 2)}\n` : `agent skill install: ${skill}@${version} → ${status}${note}\n`, exitCode: EXIT_OK };
}

function approve(ctx, pos, flags) {
  const owner = validateAgentName(pos[1]);
  const skill = assertSlug(pos[2], 'private skill id');
  const version = assertVersion(pos[3]);
  ensureEnabled(ctx.repoRoot, owner, 'approve');
  const by = String(flags.by || '').trim();
  if (!by) reject('approve requires --by <human-approver>');
  const cfg = resolveSkillStore(ctx.repoRoot);
  ensureWritableStore(cfg);
  const release = readRelease(cfg, owner, skill, version);
  if (!release) reject(`no release ${skill}@${version} owned by ${owner}`);
  if (release.status !== 'pending_review') reject(`release status is ${release.status}; only pending_review can be approved`);
  const next = { ...release };
  delete next.path; delete next.dir; delete next.access; delete next.exposed_as;
  next.status = 'active'; next.approved_by = by; next.activated_at = bangkokTimestamp();
  const path = releasePath(cfg, owner, skill, version);
  writeYaml(cfg, path, next, 'agent skill release');
  const note = commitStorePaths(cfg, [path], `agent-skill(${owner}): approve ${skill}@${version}`);
  return { stdout: `agent skill approve: ${skill}@${version} active by ${by}${note}\n`, exitCode: EXIT_OK };
}

function retire(ctx, pos) {
  const owner = validateAgentName(pos[1]);
  const skill = assertSlug(pos[2], 'private skill id');
  const version = assertVersion(pos[3]);
  ensureEnabled(ctx.repoRoot, owner, 'retire');
  const cfg = resolveSkillStore(ctx.repoRoot);
  ensureWritableStore(cfg);
  const release = readRelease(cfg, owner, skill, version);
  if (!release) reject(`no release ${skill}@${version} owned by ${owner}`);
  const next = { ...release };
  delete next.path; delete next.dir; delete next.access; delete next.exposed_as;
  next.status = 'retired'; next.retired_at = bangkokTimestamp();
  const path = releasePath(cfg, owner, skill, version);
  writeYaml(cfg, path, next, 'agent skill release');
  const note = commitStorePaths(cfg, [path], `agent-skill(${owner}): retire ${skill}@${version}`);
  return { stdout: `agent skill retire: ${skill}@${version}${note}\n`, exitCode: EXIT_OK };
}

function grant(ctx, pos, flags) {
  const action = pos[1];
  const cfg = resolveSkillStore(ctx.repoRoot);
  ensureWritableStore(cfg);
  if (action === 'propose') {
    const owner = validateAgentName(pos[2]);
    const skill = assertSlug(pos[3], 'private skill id');
    const version = assertVersion(pos[4]);
    const recipient = validateAgentName(flags.to);
    const proposedBy = String(flags.by || '').trim();
    if (!proposedBy) reject('grant propose requires --by <proposer>');
    ensureEnabled(ctx.repoRoot, owner, 'grant propose');
    ensureEnabled(ctx.repoRoot, recipient, 'grant propose');
    const release = readRelease(cfg, owner, skill, version);
    if (!release || release.status !== 'active') reject('only an active owned release can be granted');
    const alias = flags.alias ? assertSlug(flags.alias, 'grant alias') : '';
    const exposed = alias || skill;
    if (effectiveCatalog(cfg, recipient).some((row) => row.exposed_as === exposed)) {
      reject(`recipient already resolves '${exposed}'; choose a non-colliding --alias`);
    }
    const versionSlug = version.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const versionHash = createHash('sha256').update(version).digest('hex').slice(0, 8);
    const grantId = `grant-${owner}-${skill}-${versionSlug}-${versionHash}-to-${recipient}`;
    const path = grantPath(cfg, grantId);
    if (existsSync(path)) reject(`grant '${grantId}' already exists`);
    const row = {
      schema: GRANT_SCHEMA, grant_id: grantId, owner, recipient, skill, version, alias,
      status: 'proposed', proposed_by: proposedBy, proposed_at: bangkokTimestamp(),
      approved_by: '', approved_at: '', revoked_by: '', revoked_at: '',
    };
    writeYaml(cfg, path, row, 'agent skill grant');
    const note = commitStorePaths(cfg, [path], `agent-skill: propose ${grantId}`);
    return { stdout: `agent skill grant: proposed ${grantId}${note}\n`, exitCode: EXIT_OK };
  }
  const grantId = assertSlug(pos[2], 'grant id');
  const path = grantPath(cfg, grantId);
  const row = readGrant(cfg, grantId);
  if (!row) reject(`no grant '${grantId}'`);
  delete row.path;
  const by = String(flags.by || '').trim();
  if (!by) reject(`grant ${action} requires --by <human-approver>`);
  if (action === 'approve') {
    if (row.status !== 'proposed') reject(`grant '${grantId}' is ${row.status}, not proposed`);
    ensureEnabled(ctx.repoRoot, row.owner, 'grant approve');
    ensureEnabled(ctx.repoRoot, row.recipient, 'grant approve');
    const release = readRelease(cfg, row.owner, row.skill, row.version);
    if (!release || release.status !== 'active') reject(`grant '${grantId}' no longer points to an active release`);
    const exposed = row.alias || row.skill;
    if (effectiveCatalog(cfg, row.recipient).some((item) => item.exposed_as === exposed)) {
      reject(`recipient now resolves '${exposed}'; revoke the collision or propose a new alias`);
    }
    row.status = 'approved'; row.approved_by = by; row.approved_at = bangkokTimestamp();
  } else if (action === 'revoke') {
    if (row.status !== 'approved') reject(`grant '${grantId}' is ${row.status}, not approved`);
    row.status = 'revoked'; row.revoked_by = by; row.revoked_at = bangkokTimestamp();
  } else reject('grant expects propose, approve, or revoke');
  writeYaml(cfg, path, row, 'agent skill grant');
  const note = commitStorePaths(cfg, [path], `agent-skill: ${action} ${grantId}`);
  return { stdout: `agent skill grant: ${action}d ${grantId} by ${by}${note}\n`, exitCode: EXIT_OK };
}

export async function run(ctx) {
  const flags = parseMemoryFlags(ctx.argv, ['json', 'apply', 'owned', 'granted', 'effective', 'attested-low-risk']);
  const pos = positionals(ctx.argv);
  const sub = pos[0];
  if (!SUBS.has(sub)) reject(`expected one of: ${[...SUBS].join(', ')}`);
  if (sub === 'learning') return learning(ctx, pos, flags);
  if (sub === 'doctor') return doctor(ctx, pos, flags);
  if (sub === 'list') return list(ctx, pos, flags);
  if (sub === 'context') return context(ctx, pos, flags);
  if (sub === 'show') return show(ctx, pos, flags);
  if (sub === 'harvest') return harvest(ctx, pos, flags);
  if (sub === 'install') return install(ctx, pos, flags);
  if (sub === 'approve') return approve(ctx, pos, flags);
  if (sub === 'retire') return retire(ctx, pos, flags);
  return grant(ctx, pos, flags);
}
