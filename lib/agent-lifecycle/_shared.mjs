// lib/agent-lifecycle/_shared.mjs
// Shared helpers for the `sidekicks agent` verbs — the named-persistent-agent
// registry (.sidekicks/agents/<name>/) and its file mailbox.
// NOT a dispatchable verb (no VERBS entry).
//
// Layout per agent:
//   .sidekicks/agents/<name>/
//     agent.yaml              COMMITTED charter (block-style yaml-subset)
//     memory/                 COMMITTED memory-lifecycle store
//     routines/routines.yaml  COMMITTED phase-2 stub
//     runtime/                GIT-IGNORED volatile state
//       presence.json         heartbeat + session ownership
//       control.json          { stage: running|pause|stop }
//       inbox/{new,claimed,done}/   msg-*.json — state IS the subdirectory
//
// Claim protocol: atomic renameSync new/<id>.json → claimed/<id>.json. Unique
// message ids mean the rename target never pre-exists (Windows-safe — rename
// over an existing file fails there); the loser of a race gets ENOENT and
// tries the next message.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import {
  readFileSync,
  readdirSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
import { SLUG_RE, bangkokTimestamp, parseMemoryFlags } from '../memory-lifecycle/_shared.mjs';
import { resolveAgentMemoryDir } from '../active-scope/memory-paths.mjs';

// Re-export the shared string-flag re-parser + timestamp so every agent verb
// imports them from one place (the dispatcher's parseArgs handles booleans only).
export { parseMemoryFlags, bangkokTimestamp };

// Presence freshness TTL — same 900s rationale as the get-things-done lease:
// a live standby session refreshes its heartbeat at least every wait tick, so
// anything older than 15 minutes is a dead or abandoned session.
export const PRESENCE_TTL_MS = 900_000;

// Message/state enums.
export const MSG_KINDS = ['task', 'reply', 'signal'];

// Cycle guard: the maximum task-hop depth a delegation chain may reach before
// `agent send` refuses a further task. Deep chains are legitimate (master →
// specialist → sub-specialist), but an unbounded one is the signature of a
// runaway agent-to-agent loop — 8 hops is far past any designed delegation
// tree while still cutting a loop off cheaply. A human re-originates past the
// cap deliberately with `--origin none` (fresh chain).
export const MAX_TASK_HOPS = 8;
export const INBOX_STATES = ['new', 'claimed', 'done'];
export const RESULT_STATUSES = ['done', 'failed'];
export const CONTROL_STAGES = ['running', 'pause', 'stop'];

// The agent CLIs a charter's `cli` field may name — shared by create.mjs
// (validates --cli at charter-write time) and start.mjs (validates the
// --cli launch override + resolves the per-CLI launch descriptor), so the
// valid set is defined exactly once.
export const AGENT_CLIS = ['claude', 'codex', 'gemini', 'antigravity'];
const AGENT_ROLES = ['orchestrator', 'worker'];
const AGENT_STATUSES = ['active', 'retired'];
export const PRIMARY_MISSION_STATE_POLICY = 'journal-only';

// Launch descriptor per CLI: the executable to run, and how that executable
// wants its prompt. Lives here beside AGENT_CLIS so the valid set and the
// launch data cannot drift apart, and so charter validation can name the CLI
// a stray BINARY name belongs to.
//   'positional' → `<bin> [--model M] '<prompt>'`
//   'flag-i'     → `<bin> [--model M] -i '<prompt>'`  (agy takes no positional)
export const CLI_LAUNCH = {
  claude:      { bin: 'claude', promptMode: 'positional' },
  codex:       { bin: 'codex',  promptMode: 'positional' },
  gemini:      { bin: 'gemini', promptMode: 'positional' },   // gemini [query..] is interactive by default
  antigravity: { bin: 'agy',    promptMode: 'flag-i' },       // agy: no positional; -i "<prompt>"
};

/**
 * Resolve a charter's `cli:` field to a valid CLI name, or throw.
 *
 * `agent create` validates the `--cli` FLAG, but a charter is a hand-edited
 * file — nothing validated what landed in it. An invalid value used to fall
 * through to the launcher and fail far downstream with a misleading message:
 * a charter reading `cli: agy` (the BINARY for antigravity, not the cli name)
 * produced "tier 'mid' has no model mapping for cli 'agy'" and, with no
 * CLI_LAUNCH row, silently fell back to positional prompt mode that `agy`
 * does not accept. Validating at the point of use names the real problem.
 *
 * @param {object} charter - the parsed agent.yaml
 * @param {string} name    - agent name, for the message and the file path
 * @param {string} verb    - calling verb, e.g. 'agent start'
 * @returns {string} a name guaranteed to be in AGENT_CLIS ('' / absent → 'claude')
 */
export function resolveCharterCli(charter, name, verb) {
  const raw = charter && charter.cli != null ? String(charter.cli).trim() : '';
  if (!raw) return 'claude';
  if (AGENT_CLIS.includes(raw)) return raw;
  // A binary name is the likely mistake — say which cli it belongs to.
  const owner = AGENT_CLIS.find((c) => CLI_LAUNCH[c] && CLI_LAUNCH[c].bin === raw);
  const hint = owner
    ? ` — '${raw}' is the BINARY for cli '${owner}', not a cli name`
    : '';
  throw new SidekicksError(
    `${verb}: agent '${name}' has an invalid charter cli '${raw}'${hint}. `
    + `Edit .sidekicks/agents/${name}/agent.yaml and set 'cli:' to one of: ${AGENT_CLIS.join(', ')}`,
    EXIT_VALIDATION
  );
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function agentsRoot(repoRoot) {
  return join(repoRoot, '.sidekicks', 'agents');
}

export function agentDir(repoRoot, name) {
  return join(agentsRoot(repoRoot), name);
}

export function charterPath(repoRoot, name) {
  return join(agentDir(repoRoot, name), 'agent.yaml');
}

/**
 * An agent's memory namespace inside the CENTRAL store
 * (`.sidekicks/memory/store/agents/<name>/`) — NOT `.sidekicks/agents/<name>/memory/`.
 *
 * Delegated to memory-paths so there is ONE definition of where memory lives. This used
 * to be a second, independent construction of the same path, which is precisely the
 * two-hands-maintained duplication that would have kept 18 agent stores scattered after
 * the central store landed. A pre-central `.sidekicks/agents/<n>/memory/` folder stays
 * on disk, dormant — nothing reads it and nothing writes to it.
 */
export function agentMemoryDir(repoRoot, name) {
  return resolveAgentMemoryDir(repoRoot, name).baseDir;
}

export function runtimeDir(repoRoot, name) {
  return join(agentDir(repoRoot, name), 'runtime');
}

export function presencePath(repoRoot, name) {
  return join(runtimeDir(repoRoot, name), 'presence.json');
}

export function controlPath(repoRoot, name) {
  return join(runtimeDir(repoRoot, name), 'control.json');
}

export function inboxDir(repoRoot, name, state) {
  return join(runtimeDir(repoRoot, name), 'inbox', state);
}

/**
 * Convert an absolute path to a repo-relative, forward-slash form (`.` = root).
 * Persisted artifact paths are always repo-relative — never machine-absolute.
 */
export function toRepoRel(repoRoot, abs) {
  const rel = relative(repoRoot, abs).replace(/\\/g, '/');
  return rel === '' ? '.' : rel;
}

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

/**
 * Validate an agent name (kebab-case slug, same shape as memory slugs).
 * @throws {SidekicksError(EXIT_VALIDATION)} on a bad name.
 */
export function validateAgentName(name) {
  if (!name || typeof name !== 'string') {
    throw new SidekicksError('agent: an agent <name> is required', EXIT_VALIDATION);
  }
  if (!SLUG_RE.test(name)) {
    throw new SidekicksError(
      `agent: invalid agent name '${name}' — must be kebab-case matching ${SLUG_RE.source}`,
      EXIT_VALIDATION
    );
  }
  return name;
}

/**
 * A model spec is a tier keyword, an explicit vendor model id, or '' (no --model flag).
 *
 * The grammar is an ALLOW-list on purpose. `agent start`'s GUI path builds a shell command
 * string, so a charter value carrying `;`, `&`, `|`, `$()`, a backtick, a quote or a newline
 * was command injection at launch time — a committed charter or an imported agent pack could
 * run arbitrary commands when a maintainer started that agent. Every real vendor id (
 * `claude-opus-5`, `gpt-5-codex`, `gemini-2.5-pro`, `us.anthropic.claude-opus-5:0`,
 * `openai/gpt-5`) is inside this set; nothing that a shell treats as syntax is.
 *
 * The launcher ALSO quotes the resolved value (lib/agent-lifecycle/start.mjs). That is
 * deliberate belt-and-braces: this grammar makes the quoting a no-op today, and the quoting
 * keeps the launcher safe if the grammar is ever widened for a new vendor's naming rules.
 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+_-]{0,127}$/;

/**
 * Validate a `--model` / charter `model` spec.
 *
 * @param {unknown} value - the spec ('' / absent means "no --model flag").
 * @param {(message: string) => never} fail - how to report a bad value (verb-specific prefix).
 * @returns {string} the accepted spec.
 */
export function assertModelId(value, fail) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') fail('model must be a string');
  if (!MODEL_ID_RE.test(value)) {
    // Name the offending character rather than only echoing the value — the whole point is
    // that the reader can see WHY it was refused.
    const bad = [...value].find((ch) => !/[A-Za-z0-9._:@/+_-]/.test(ch));
    const shown = bad === undefined
      ? (value.length > 128 ? 'is longer than 128 characters' : 'does not start with a letter or digit')
      : `contains ${JSON.stringify(bad)}`;
    fail(
      `model '${value}' ${shown} — a model id must match ${MODEL_ID_RE.source} `
      + '(a tier keyword or a vendor model id; shell metacharacters are never valid)'
    );
  }
  return value;
}

/**
 * Validate the whole parsed charter, rather than validating only a caller's
 * patch. This is deliberately shared by reads and writes: a charter accepted
 * by create/amend is one start/delegate/show can safely consume.
 * Unknown top-level fields remain forward-compatible and are preserved.
 */
export function validateCompleteCharter(charter, expectedName, verb = 'agent', { deferCliValidation = false, deferModelValidation = false } = {}) {
  const fail = (message) => {
    throw new SidekicksError(`${verb}: invalid charter${expectedName ? ` for '${expectedName}'` : ''} — ${message}`, EXIT_VALIDATION);
  };
  if (!charter || typeof charter !== 'object' || Array.isArray(charter)) fail('must be a mapping');
  if (charter.schema !== 'agent-charter/v1') fail("schema must be 'agent-charter/v1'");
  if (typeof charter.name !== 'string' || !SLUG_RE.test(charter.name)) fail('name must be a kebab-case slug');
  if (expectedName && charter.name !== expectedName) fail(`name must equal '${expectedName}'`);
  if (typeof charter.specialty !== 'string' || charter.specialty.trim() === '') fail('specialty is required');
  if (!Array.isArray(charter.categories) || charter.categories.length === 0 || charter.categories.some((v) => typeof v !== 'string' || !v.trim())) fail('categories must be a non-empty string list');
  if (!deferCliValidation && !AGENT_CLIS.includes(charter.cli)) fail(`cli must be one of: ${AGENT_CLIS.join(', ')}`);
  if (!AGENT_ROLES.includes(charter.role)) fail(`role must be one of: ${AGENT_ROLES.join(', ')}`);
  // Refused at every WRITE, before any launcher runs: a malicious charter or imported agent
  // pack must never reach the command builder at all.
  //
  // The READ path defers it (deferModelValidation). readCharter() validates on every read, so a
  // charter whose model failed the grammar would take the agent out of `agent list`, `agent
  // show` and the whole roster — this module already documents that failure mode as one to
  // avoid ("a poisoned write bricks the charter for every later read"). Deferring costs nothing
  // because the dangerous sink re-checks: resolveModel() refuses the value at `agent start`, and
  // buildCommand() quotes it regardless.
  if ('model' in charter) {
    if (deferModelValidation) { if (typeof charter.model !== 'string') fail('model must be a string'); }
    else assertModelId(charter.model, fail);
  }
  if (!AGENT_STATUSES.includes(charter.status)) fail(`status must be one of: ${AGENT_STATUSES.join(', ')}`);
  if (typeof charter.created_at !== 'string' || charter.created_at.trim() === '') fail('created_at is required');
  if ('default_work_dir' in charter && typeof charter.default_work_dir !== 'string') fail('default_work_dir must be a string');
  for (const key of ['persona', 'mission', 'output_contract']) {
    if (key in charter && typeof charter[key] !== 'string') fail(`${key} must be a string`);
  }
  for (const key of ['goals', 'expertise', 'principles', 'routines']) {
    if (key in charter && (!Array.isArray(charter[key]) || charter[key].some((v) => typeof v !== 'string'))) fail(`${key} must be a string list`);
  }
  if ('improvement' in charter && (!charter.improvement || typeof charter.improvement !== 'object' || Array.isArray(charter.improvement) || typeof charter.improvement.enabled !== 'boolean')) {
    fail('improvement.enabled must be a boolean');
  }
  if ('skill_learning' in charter && (!charter.skill_learning || typeof charter.skill_learning !== 'object' || Array.isArray(charter.skill_learning) || typeof charter.skill_learning.enabled !== 'boolean')) {
    fail('skill_learning.enabled must be a boolean');
  }
  if ('memory' in charter) validateMemoryAttach(charter.memory, fail);
  if ('pack' in charter) validatePackProvenance(charter.pack, fail);
  if ('primary_mission' in charter) validatePrimaryMission(charter.primary_mission, fail);
  return charter;
}

/**
 * The `memory: attach: [<category>, …]` block — the scenario categories this agent works
 * within by charter.
 *
 * Validated rather than tolerated as an unknown field because the delegate wake READS it
 * to decide which hard-rule bodies to load before the agent acts. A typo'd shape there
 * would silently mean "attach nothing", and an agent quietly missing the hard rules of
 * its own domain is the one failure this block exists to prevent.
 *
 * Attach affects READS only — an agent's memory still has no write inheritance.
 */
function validateMemoryAttach(value, fail) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('memory must be a mapping');
  const extra = Object.keys(value).filter((key) => key !== 'attach');
  if (extra.length) fail(`memory may contain only: attach (got ${extra.join(', ')})`);
  if (!('attach' in value)) fail('memory.attach is required when memory is present');
  if (!Array.isArray(value.attach) || value.attach.some((v) => typeof v !== 'string' || !SLUG_RE.test(v))) {
    fail('memory.attach must be a list of kebab-case category names');
  }
}

/**
 * The `pack:` block an agent installed by `sidekicks agent pack install` carries.
 *
 * This block IS the installed-pack record — there is no state file. `.sidekicks/state/` is
 * git-ignored and per-machine, so a record kept there would report every pack as not-installed on
 * a fresh clone of a workspace whose agents are committed and present. Validated here rather than
 * merely tolerated as an unknown field, because `agent pack status` reads it to decide whether an
 * existing agent belongs to a pack or is somebody else's work that must never be overwritten.
 *
 * Kept in this file, not in _pack.mjs, so charter validation never imports the pack subsystem.
 */
function validatePackProvenance(value, fail) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('pack must be a mapping');
  const required = ['id', 'version', 'source', 'installed_at', 'checksum'];
  const missing = required.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !required.includes(key));
  if (missing.length || extra.length) fail(`pack must contain exactly: ${required.join(', ')}`);
  if (typeof value.id !== 'string' || !SLUG_RE.test(value.id)) fail('pack.id must be a kebab-case slug');
  for (const key of ['version', 'source', 'installed_at']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) fail(`pack.${key} is required`);
  }
  if (typeof value.checksum !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.checksum)) {
    fail('pack.checksum must be sha256:<64 hex>');
  }
}

function validatePrimaryMission(value, fail) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('primary_mission must be a mapping');
  const required = ['slug', 'title', 'goal', 'standing', 'dod_checks', 'state_policy'];
  const extra = Object.keys(value).filter((key) => !required.includes(key));
  const missing = required.filter((key) => !(key in value));
  if (extra.length || missing.length) fail(`primary_mission must contain exactly: ${required.join(', ')}`);
  if (typeof value.slug !== 'string' || !SLUG_RE.test(value.slug)) fail('primary_mission.slug must be a kebab-case slug');
  if (typeof value.title !== 'string' || !value.title.trim()) fail('primary_mission.title is required');
  if (typeof value.goal !== 'string' || !value.goal.trim()) fail('primary_mission.goal is required');
  if (typeof value.standing !== 'boolean') fail('primary_mission.standing must be boolean');
  if (!Array.isArray(value.dod_checks) || value.dod_checks.length === 0 || value.dod_checks.some((v) => typeof v !== 'string' || !v.trim())) fail('primary_mission.dod_checks must be a non-empty string list');
  if (value.state_policy !== PRIMARY_MISSION_STATE_POLICY) fail(`primary_mission.state_policy must be '${PRIMARY_MISSION_STATE_POLICY}'`);
}

// ---------------------------------------------------------------------------
// Charter I/O (agent.yaml — block-style yaml-subset)
// ---------------------------------------------------------------------------

/**
 * Read + parse an agent's charter, or null when the agent does not exist.
 * A charter that exists but fails to parse throws a NAMED, actionable error —
 * the bare parser error ("YAML parse error at line 50") says nothing about
 * which of 14 files is broken or how to fix it.
 * @returns {object|null}
 */
export function readCharter(repoRoot, name, { deferCliValidation = false } = {}) {
  const p = charterPath(repoRoot, name);
  if (!existsSync(p)) return null;
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  try {
    return validateCompleteCharter(yaml.parse(text), name, 'agent',
      { deferCliValidation, deferModelValidation: true });
  } catch (err) {
    const first = String(err && err.message ? err.message : err).split('\n')[0];
    throw new SidekicksError(
      `agent: charter for '${name}' (.sidekicks/agents/${name}/agent.yaml) failed to parse: ${first} — fix the file by hand (the yaml subset rejects & / * before a word character and ! tags, even inside quotes)`,
      EXIT_VALIDATION
    );
  }
}

/**
 * Read a charter or throw EXIT_NOT_FOUND with a helpful message.
 */
export function requireCharter(repoRoot, name, options) {
  const charter = readCharter(repoRoot, name, options);
  if (!charter) {
    throw new SidekicksError(
      `agent: no agent named '${name}' — create one with 'sidekicks agent create ${name} --specialty "..." --categories a,b'`,
      EXIT_NOT_FOUND
    );
  }
  return charter;
}

/**
 * Walk every string leaf of a charter (values, list items, nested objects)
 * and refuse yaml-subset poison — the parser's pre-scan rejects & / * before
 * a word character and ! tags on RAW lines, so quoting does not protect, and
 * a poisoned write bricks the charter for every later read (`agent list`
 * dies fleet-wide). This is the guard whose absence let `**bold**` prose
 * brick ethan's charter; it also fronts `journal improve apply`, which pushes
 * arbitrary proposal text into charters.
 */
function assertCharterSafe(verb, charter) {
  const walk = (node, path) => {
    if (typeof node === 'string') {
      const p = yaml.findPoison(node);
      if (p) {
        throw new SidekicksError(
          `${verb}: charter field '${path}' contains ${p.what} — ${p.why}; rephrase without it`,
          EXIT_VALIDATION
        );
      }
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(charter, '');
}

/**
 * Serialize + atomically write a charter (surface-gated).
 * yaml.serialize emits BLOCK sequences/mappings — the only style the
 * yaml-subset parser accepts (flow `[a, b]` / `{k: v}` are rejected).
 * Poison-guarded and round-trip-checked: a charter this function accepts is
 * one readCharter can always load back.
 */
export function writeCharter(repoRoot, name, charter, verb = 'agent') {
  validateCompleteCharter(charter, name, verb);
  assertCharterSafe(verb, charter);
  const text = yaml.serialize(charter);
  yaml.assertRoundTrips(text, `${verb}: charter for '${name}'`);
  const p = charterPath(repoRoot, name);
  assertWritable(p, repoRoot);
  writeAtomic(p, text);
}

/**
 * List all agent names — a scan over each .sidekicks/agents/<name>/agent.yaml
 * (scan-on-read; no roster index file to drift). Sorted ascending.
 * @returns {string[]}
 */
export function listAgentNames(repoRoot) {
  const root = agentsRoot(repoRoot);
  if (!existsSync(root)) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'agent.yaml')))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Presence (runtime/presence.json)
// ---------------------------------------------------------------------------

/**
 * Read presence, or null when absent/unreadable.
 * Shape: { session_id, state: 'standby'|'working', task, heartbeat_at }
 */
export function readPresence(repoRoot, name) {
  return readJson(presencePath(repoRoot, name));
}

/**
 * Upsert presence atomically (surface-gated).
 */
export function writePresence(repoRoot, name, presence) {
  const p = presencePath(repoRoot, name);
  assertWritable(p, repoRoot);
  writeAtomic(p, JSON.stringify(presence, null, 2) + '\n');
}

/**
 * Classify presence freshness: 'fresh' (heartbeat within TTL), 'stale'
 * (heartbeat present but past TTL), 'offline' (no presence at all).
 * ISO strings carry the +07:00 offset, so Date.parse compares correctly.
 */
export function presenceState(presence, nowMs = Date.now()) {
  if (!presence || !presence.heartbeat_at) return 'offline';
  const beat = Date.parse(presence.heartbeat_at);
  if (Number.isNaN(beat)) return 'offline';
  return nowMs - beat <= PRESENCE_TTL_MS ? 'fresh' : 'stale';
}

// ---------------------------------------------------------------------------
// Control (runtime/control.json)
// ---------------------------------------------------------------------------

/**
 * Read the control stage; a missing/unreadable file means 'running'
 * (a fresh clone has no runtime/ at all — never an error).
 */
export function readControlStage(repoRoot, name) {
  const c = readJson(controlPath(repoRoot, name));
  return c && CONTROL_STAGES.includes(c.stage) ? c.stage : 'running';
}

export function writeControlStage(repoRoot, name, stage) {
  const p = controlPath(repoRoot, name);
  assertWritable(p, repoRoot);
  writeAtomic(p, JSON.stringify({ stage, updated_at: bangkokTimestamp() }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Messages (runtime/inbox/{new,claimed,done}/msg-*.json)
// ---------------------------------------------------------------------------

/**
 * Mint a unique, lexicographically time-ordered message id from the Bangkok
 * timestamp: msg-YYYYMMDD-HHMMSS-<4hex>. Uniqueness (the hex suffix) is what
 * makes the claim rename Windows-safe — the target path never pre-exists.
 */
export function newMessageId(ts = bangkokTimestamp()) {
  const compact = ts.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `msg-${compact}-${randomBytes(2).toString('hex')}`;
}

/**
 * List message ids in one inbox state, oldest-first (ids embed a zero-padded
 * timestamp, so lexicographic order IS chronological order).
 * @returns {string[]} ids (filename without .json)
 */
export function listMessageIds(repoRoot, name, state) {
  const dir = inboxDir(repoRoot, name, state);
  if (!existsSync(dir)) return [];
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.startsWith('msg-') && f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Read one message from a given state dir, or null when absent/unparsable.
 */
export function readMessage(repoRoot, name, state, id) {
  return readJson(join(inboxDir(repoRoot, name, state), `${id}.json`));
}

/**
 * Atomically write a message into an inbox state dir (surface-gated).
 */
export function writeMessage(repoRoot, name, state, msg) {
  const p = join(inboxDir(repoRoot, name, state), `${msg.id}.json`);
  assertWritable(p, repoRoot);
  writeAtomic(p, JSON.stringify(msg, null, 2) + '\n');
}

/**
 * Atomically claim one message: renameSync new/<id>.json → claimed/<id>.json.
 * Returns true on success, false when the message was already claimed by a
 * racing session (ENOENT on the source). Any other error propagates.
 */
export function claimRename(repoRoot, name, id) {
  const src = join(inboxDir(repoRoot, name, 'new'), `${id}.json`);
  const dst = join(inboxDir(repoRoot, name, 'claimed'), `${id}.json`);
  assertWritable(dst, repoRoot);
  mkdirp(inboxDir(repoRoot, name, 'claimed'));
  try {
    renameSync(src, dst);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false; // race loser — try next
    throw new SidekicksError(
      `agent claim: failed to claim '${id}': ${err.message}`,
      EXIT_VALIDATION
    );
  }
}

/**
 * Move a claimed message to done/ (unique id → target never pre-exists).
 */
export function moveToDone(repoRoot, name, id) {
  const src = join(inboxDir(repoRoot, name, 'claimed'), `${id}.json`);
  const dst = join(inboxDir(repoRoot, name, 'done'), `${id}.json`);
  assertWritable(dst, repoRoot);
  mkdirp(inboxDir(repoRoot, name, 'done'));
  renameSync(src, dst);
}

/**
 * Ensure the volatile runtime tree exists (a fresh clone carries none of it —
 * runtime/ is git-ignored). Idempotent; called by every mailbox/presence verb.
 */
export function ensureRuntimeTree(repoRoot, name) {
  for (const state of INBOX_STATES) {
    mkdirp(inboxDir(repoRoot, name, state));
  }
}

// ---------------------------------------------------------------------------
// Small shared utilities
// ---------------------------------------------------------------------------

function readJson(absPath) {
  if (!existsSync(absPath)) return null;
  try {
    return JSON.parse(readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Split a comma-separated flag value into a clean list.
 */
export function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Split a semicolon-separated flag value into a clean list. Used for the
 * charter's prose list fields (--goals/--expertise/--principles/--routines)
 * whose individual items may themselves contain commas — splitList's comma
 * delimiter would incorrectly break those apart, so these fields use `;`
 * instead. splitList stays comma-based for --categories.
 */
export function splitSemi(value) {
  return String(value ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * One agent's merged status row: charter + presence + inbox depths.
 * Shared by `list` and `show`. A charter that fails to PARSE degrades to a
 * `broken: true` row instead of throwing — one bad file must never take down
 * the whole roster scan (presence and inbox depths don't need the charter,
 * so they are still real).
 */
export function agentStatusRow(repoRoot, name) {
  let charter = {};
  let broken = null;
  try {
    charter = readCharter(repoRoot, name) || {};
  } catch (err) {
    broken = String(err && err.message ? err.message : err).split('\n')[0];
  }
  const presence = readPresence(repoRoot, name);
  const state = presenceState(presence);
  return {
    name,
    ...(broken ? { broken: true, error: broken } : {}),
    specialty: charter.specialty || '',
    categories: Array.isArray(charter.categories) ? charter.categories : [],
    cli: charter.cli || '',
    role: charter.role || '',
    status: broken ? 'broken' : charter.status || 'active',
    presence: state,
    session: state === 'offline' ? null : presence.session_id ?? null,
    activity: state === 'offline' ? null : presence.state ?? null,
    inbox: {
      new: listMessageIds(repoRoot, name, 'new').length,
      claimed: listMessageIds(repoRoot, name, 'claimed').length,
      done: listMessageIds(repoRoot, name, 'done').length,
    },
  };
}
