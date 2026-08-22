// lib/cli-executor-lifecycle/_shared.mjs
// Shared helpers for the `sidekicks cli-executor` verb namespace — the machine-local
// registry of external agent CLIs that sk-cli-executor / sk-cli-orchestrator
// delegate to. The registry answers "which CLIs exist on this machine and how do I invoke
// each headlessly", so the executor family reads it instead of guessing among a hardcoded
// triple.
//
// STORAGE — a dedicated JSON file, scope-resolved, under the CLI write surface (Rule 1):
//   - root project `sidekicks` (default) → `.sidekicks/cli-executors.json`
//   - user project `<active>`            → `projects/<active>/cli-executors.json`
// JSON (not the config.yaml YAML subset) is deliberate: it round-trips losslessly in BOTH
// Node and Python stdlib, so the Python side (scripts/registry.py) needs no PyYAML, and it
// never touches config.yaml's live secrets or hand-written comments.
//
// The Python mirror is `.agents/skills/sk-cli-executor/scripts/registry.py` — the
// schema below (BUILTIN_DEFAULTS, spec fields, effectiveExecutors merge rule) is the shared
// contract; keep the two in lockstep.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { SidekicksError, EXIT_VALIDATION, EXIT_IO } from '../sk-cli/errors.mjs';
import { frameworkConfigPath } from '../config-store/paths.mjs';

// v2 adds per-tier reasoning efforts and a separately discovered catalog.  Readers deliberately
// keep accepting v1: a read must never rewrite a user's registry merely because the CLI updated.
export const SCHEMA_VERSION = 2;
export const CANDIDATE_VERSION = 1;

// The executors that ship with native Python adapters (adapter_claude/codex/gemini/antigravity).
// They are always addressable unless a registry entry explicitly disables one; a registry never
// has to list them to keep today's behavior (a repo with no registry file works exactly as before).
export const BUILTIN_DEFAULTS = Object.freeze({
  claude:      Object.freeze({ kind: 'builtin', enabled: true, transport: 'json',       sandbox: 'cli-sandbox',           usage_exposed: true }),
  codex:       Object.freeze({ kind: 'builtin', enabled: true, transport: 'json',       sandbox: 'kernel-sandbox',        usage_exposed: true }),
  gemini:      Object.freeze({ kind: 'builtin', enabled: true, transport: 'print-mode', sandbox: 'cli-sandbox',           usage_exposed: false }),
  antigravity: Object.freeze({ kind: 'builtin', enabled: true, transport: 'print-mode', sandbox: 'vm-isolation',          usage_exposed: false }),
});

export const BUILTIN_NAMES = Object.freeze(Object.keys(BUILTIN_DEFAULTS));

export const TRANSPORTS = Object.freeze(['print-mode', 'json']);
export const SANDBOX_LEVELS = Object.freeze([
  'kernel-sandbox', 'vm-isolation', 'cli-sandbox', 'constraint-block-only', 'unknown',
]);

// Complexity tiers an item can request (CLAUDE.md → "Subagent model selection — resolve by tier,
// not by exact ID"). An executor's `models` block maps a tier to the CONCRETE vendor model id to
// pass that CLI (e.g. codex `{ high: 'gpt-5-codex', mid: 'gpt-5', low: 'gpt-5-mini' }`). The ids are
// machine/account-specific CONFIG — never hard-coded here — so the orchestrator picks a tier by task
// complexity and the executor resolves tier→id at invoke time. An absent/empty map means "no model
// flag" → the CLI's own default, exactly the pre-feature behavior.
// `top` is the Fable/Mythos-class rung ABOVE high (CLAUDE.md → "Fable fallback"): map it only where
// the CLI truly offers a class above its high tier (Claude Code: 'fable'); leave it unmapped
// elsewhere — the orchestrator then routes top-shaped work to an executor that maps it, or requests
// `high` explicitly, rather than letting a top request fall to the CLI default.
export const MODEL_TIERS = Object.freeze(['top', 'high', 'mid', 'low']);
export const CAPABILITY_STATUSES = Object.freeze(['complete', 'partial', 'unavailable', 'unsupported']);

// A registered CLI name must be a short, portable slug — it becomes a ledger `executor` value,
// an argparse choice, and a run-folder segment, so keep it filesystem- and enum-safe.
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// A canonical model FAMILY — the vendor/model lineage two seats would share. Same charset as a
// name, because it too becomes a run-folder segment (plan-candidates/<family>/).
//
// WHY THIS FIELD EXISTS. Independence, not labelling. Two registrations backed by the same vendor
// CLI are not independent contestants or judges, and nothing else in this schema can tell them
// apart: `kind`, `binary` and `transport` are all happily identical across two aliases of the same
// tool. The built-ins get fixed families in lib/cli-executor-lifecycle/profiles.mjs; a generic
// executor declares one with `register --family <f>`.
//
// AND WHY THIS IS NOT A SCHEMA-VERSION BUMP. `family` and `profile` are purely additive: this
// validator builds its output object key by key, so an entry without them is unchanged, and both the
// Node and Python readers carry unknown keys through untouched. Bumping SCHEMA_VERSION would make
// every subsequent registry WRITE unreadable by a lagging copy of the Python mirror — a real
// regression bought for no compatibility gain, since a reader that wants to know whether families
// are declared can simply look for the field.
const FAMILY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Parse `--key value` / `--key=value` / `--flag` tokens (mirrors memory-lifecycle's parser).
 * @param {string[]} argv
 * @param {string[]} booleans - keys treated as boolean flags
 * @returns {Record<string, string|boolean>}
 */
export function parseFlags(argv, booleans = []) {
  const out = {};
  const boolSet = new Set(booleans);
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string' || !tok.startsWith('--')) continue;
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      const key = body.slice(0, eq);
      out[key] = boolSet.has(key) ? true : body.slice(eq + 1);
      continue;
    }
    const key = body;
    if (boolSet.has(key)) { out[key] = true; continue; }
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else { out[key] = ''; }
  }
  return out;
}

/**
 * Split a comma-separated list flag (`--invoke '-p,{brief}'`) into a trimmed string array.
 * Empty/undefined → undefined so a caller can distinguish "not given" from "given empty".
 * @param {string|undefined} value
 * @returns {string[]|undefined}
 */
export function splitListFlag(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Convert an absolute path to a repo-relative, forward-slash form (`.` = repo root).
 * @param {string} repoRoot
 * @param {string} abs
 * @returns {string}
 */
function toRepoRelative(repoRoot, abs) {
  const rel = relative(repoRoot, abs).replace(/\\/g, '/');
  return rel === '' ? '.' : rel;
}

/**
 * Resolve the scope-resolved registry file location.
 *
 * @param {string} repoRoot
 * @param {object} settings - parsed .sidekicks/settings.json (may be {})
 * @returns {{ path: string, pathRel: string, scopeLabel: string }}
 */
export function resolveRegistryPath(repoRoot, settings, { root = false } = {}) {
  const scope = resolveEffectiveScope(settings);
  const isRoot = root || scope.projectName === 'sidekicks';
  // The registry is configuration, so it lives in the scope's config/ directory with everything else;
  // a checkout that still keeps it at the scope root is read from there.
  const base = isRoot ? '.sidekicks' : join('projects', scope.projectName);
  const path = frameworkConfigPath(repoRoot, 'cli-executors.json', { base });
  return {
    path,
    pathRel: toRepoRelative(repoRoot, path),
    scopeLabel: isRoot ? 'sidekicks (root)' : scope.projectName,
  };
}

/** Resolve both persistent layers.  The root layer is always part of an active user project. */
export function resolveRegistryLayers(repoRoot, settings) {
  const root = resolveRegistryPath(repoRoot, settings, { root: true });
  const active = resolveRegistryPath(repoRoot, settings);
  return { root, project: active.scopeLabel === 'sidekicks (root)' ? null : active };
}

/**
 * Read the registry file, returning a normalized `{ schema_version, executors }` object.
 * A missing file is NOT an error — it yields an empty registry (built-in defaults still apply
 * via effectiveExecutors). A malformed file IS an error (better to fail loudly than silently
 * lose a user's registration).
 *
 * @param {string} path
 * @returns {{ schema_version: number, executors: Record<string, object> }}
 */
export function readRegistry(path) {
  if (!existsSync(path)) {
    return { schema_version: SCHEMA_VERSION, executors: {} };
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new SidekicksError(`cli-executor: cannot read registry ${path}: ${err.message}`, EXIT_IO);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SidekicksError(
      `cli-executor: registry ${path} is not valid JSON (${err.message}) — fix or remove it`,
      EXIT_VALIDATION
    );
  }
  if (parsed?.schema_version !== undefined && (!Number.isInteger(parsed.schema_version) || parsed.schema_version < 1 || parsed.schema_version > SCHEMA_VERSION)) {
    throw new SidekicksError(`cli-executor: registry ${path} has unsupported schema_version '${parsed.schema_version}'`, EXIT_VALIDATION);
  }
  const executors = (parsed && typeof parsed.executors === 'object' && !Array.isArray(parsed.executors) && parsed.executors) || {};
  const routing = (parsed && typeof parsed.routing === 'object' && parsed.routing) || undefined;
  return { schema_version: parsed?.schema_version ?? SCHEMA_VERSION, executors, routing };
}

/** Read and compose built-ins < root < active-project. */
export function readEffectiveRegistry(repoRoot, settings, { rootOnly = false } = {}) {
  const layers = resolveRegistryLayers(repoRoot, settings);
  const root = readRegistry(layers.root.path);
  const project = !rootOnly && layers.project ? readRegistry(layers.project.path) : null;
  return effectiveRegistry(root, project);
}

/**
 * The routing preference chain (`routing.prefer`) as an ordered name array — the auto-routing
 * policy: "prefer the first, fall back to the next if unavailable". Empty array when unset.
 * @param {{ routing?: object }} registry
 * @returns {string[]}
 */
export function routingPolicy(registry) {
  const prefer = registry && registry.routing && registry.routing.prefer;
  return Array.isArray(prefer) ? prefer.slice() : [];
}

/**
 * Validate a routing chain before it is written: every name must be a KNOWN executor (built-in or
 * registered), and the chain must be non-empty with no duplicates. Resolution skips a disabled or
 * currently-unavailable entry at run time, so disabled names are allowed here (a warning, not an
 * error) — but an unknown name is a typo that would silently never match, so it is rejected.
 * @param {string[]} names
 * @param {Record<string, object>} effective - effectiveExecutors() output
 * @returns {string[]}
 */
export function validateRoutingChain(names, effective) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new SidekicksError('cli-executor route set: name at least one executor for the chain', EXIT_VALIDATION);
  }
  const seen = new Set();
  for (const name of names) {
    if (!effective[name]) {
      throw new SidekicksError(
        `cli-executor route set: unknown executor '${name}' — known: ${Object.keys(effective).sort().join(', ')}`,
        EXIT_VALIDATION
      );
    }
    if (seen.has(name)) {
      throw new SidekicksError(`cli-executor route set: '${name}' appears twice in the chain`, EXIT_VALIDATION);
    }
    seen.add(name);
  }
  return names.slice();
}

/**
 * Validate an executor's optional `models` tier→id map before it is written. Every key must be a
 * known tier (high/mid/low) and every value a non-empty model-id string. Returns the normalized map
 * (tier-key-sorted for stable diffs), or undefined when there is nothing to store. Rejecting an
 * unknown tier here is a real guard — a typo like `{ higch: '...' }` would otherwise silently never
 * resolve, so the item would fall through to the CLI default with no signal.
 * @param {string} name
 * @param {unknown} models
 * @returns {Record<string,string>|undefined}
 */
export function validateModels(name, models) {
  if (models === undefined || models === null) return undefined;
  if (typeof models !== 'object' || Array.isArray(models)) {
    throw new SidekicksError(`cli-executor: '${name}' models must be an object of tier→model-id`, EXIT_VALIDATION);
  }
  const out = {};
  for (const tier of MODEL_TIERS) {
    const val = models[tier];
    if (val === undefined || val === null || val === '') continue;
    if (typeof val !== 'string') {
      throw new SidekicksError(`cli-executor: '${name}' models.${tier} must be a model-id string`, EXIT_VALIDATION);
    }
    out[tier] = val;
  }
  for (const key of Object.keys(models)) {
    if (!MODEL_TIERS.includes(key)) {
      throw new SidekicksError(
        `cli-executor: '${name}' models has unknown tier '${key}' — use one of ${MODEL_TIERS.join(', ')}`,
        EXIT_VALIDATION
      );
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Validate the optional tier -> effort map. Empty values are intentionally omitted. */
export function validateEfforts(name, efforts) {
  if (efforts === undefined || efforts === null) return undefined;
  if (typeof efforts !== 'object' || Array.isArray(efforts)) {
    throw new SidekicksError(`cli-executor: '${name}' efforts must be an object of tier→effort`, EXIT_VALIDATION);
  }
  const out = {};
  for (const key of Object.keys(efforts)) {
    if (!MODEL_TIERS.includes(key)) throw new SidekicksError(`cli-executor: '${name}' efforts has unknown tier '${key}'`, EXIT_VALIDATION);
    const value = efforts[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') throw new SidekicksError(`cli-executor: '${name}' efforts.${key} must be a string`, EXIT_VALIDATION);
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Normalise a complete discovered snapshot; this is also the sync input guard. */
export function validateCapabilities(name, capabilities) {
  if (capabilities === undefined || capabilities === null) return undefined;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new SidekicksError(`cli-executor: '${name}' capabilities must be an object`, EXIT_VALIDATION);
  }
  if (!CAPABILITY_STATUSES.includes(capabilities.status)) {
    throw new SidekicksError(`cli-executor: '${name}' capabilities has invalid status`, EXIT_VALIDATION);
  }
  const source = capabilities.source;
  if (!source || !['cli-metadata', 'headless-agent', 'hybrid'].includes(source.kind) || typeof source.command !== 'string') {
    throw new SidekicksError(`cli-executor: '${name}' capabilities requires a valid source`, EXIT_VALIDATION);
  }
  if (typeof capabilities.discovered_at !== 'string' || typeof capabilities.cli_version !== 'string' || !Array.isArray(capabilities.models)) {
    throw new SidekicksError(`cli-executor: '${name}' capabilities has invalid required fields`, EXIT_VALIDATION);
  }
  const ids = new Set();
  const models = capabilities.models.map((row) => {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id || ids.has(row.id)) {
      throw new SidekicksError(`cli-executor: '${name}' capabilities has duplicate or invalid model id`, EXIT_VALIDATION);
    }
    ids.add(row.id);
    if (row.supported_efforts !== undefined && (!Array.isArray(row.supported_efforts) || !row.supported_efforts.every((x) => typeof x === 'string'))) {
      throw new SidekicksError(`cli-executor: '${name}' capabilities model '${row.id}' has malformed effort list`, EXIT_VALIDATION);
    }
    if (row.effort_mode !== undefined && !['flag', 'embedded', 'none'].includes(row.effort_mode)) {
      throw new SidekicksError(`cli-executor: '${name}' capabilities model '${row.id}' has invalid effort_mode`, EXIT_VALIDATION);
    }
    return { ...row, aliases: Array.isArray(row.aliases) ? row.aliases.slice() : [], hidden: row.hidden === true };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { ...capabilities, source: { kind: source.kind, command: source.command }, models };
}

/**
 * Validate an executor's optional `specialties` list before it is written — short capability phrases
 * ("code implementation", "long-context research", "frontend/UI work") that tell the orchestrator
 * which kind of task each CLI is best at, so it can route an item to the best-fit executor instead of
 * guessing. Every entry must be a non-empty string; blanks are dropped and duplicates collapsed.
 * Returns the normalized list, or undefined when there is nothing to store. It is advisory metadata —
 * unlike `models` it drives no flag, so there is no closed vocabulary to enforce (a free phrase is
 * exactly what lets the orchestrator reason about fit).
 * @param {string} name
 * @param {unknown} specialties
 * @returns {string[]|undefined}
 */
export function validateSpecialties(name, specialties) {
  if (specialties === undefined || specialties === null) return undefined;
  if (!Array.isArray(specialties)) {
    throw new SidekicksError(`cli-executor: '${name}' specialties must be a list of capability phrases`, EXIT_VALIDATION);
  }
  const out = [];
  const seen = new Set();
  for (const item of specialties) {
    if (typeof item !== 'string') {
      throw new SidekicksError(`cli-executor: '${name}' specialties entries must be strings`, EXIT_VALIDATION);
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length ? out : undefined;
}

/**
 * Validate an executor's optional `model_specialties` tier→phrase-list map before it is written —
 * the "right job on the right model" pairing: for each configured model tier, the kinds of task
 * THAT tier's model is best at (e.g. codex `{ high: ['complex implementation', 'deep debugging'],
 * low: ['boilerplate', 'bulk mechanical edits'] }`). The orchestrator reads this next to `models`
 * to pick an item's `model_tier` by fit, not just by generic "complexity". Keys must be known
 * tiers (same guard rationale as validateModels — a typo'd tier would silently never inform
 * routing); values follow the specialty-phrase rules (non-empty strings, trimmed, deduped).
 * Returns the normalized map, or undefined when there is nothing to store.
 * @param {string} name
 * @param {unknown} value
 * @returns {Record<string,string[]>|undefined}
 */
export function validateModelSpecialties(name, value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SidekicksError(
      `cli-executor: '${name}' model_specialties must be an object of tier→phrase-list`,
      EXIT_VALIDATION
    );
  }
  for (const key of Object.keys(value)) {
    if (!MODEL_TIERS.includes(key)) {
      throw new SidekicksError(
        `cli-executor: '${name}' model_specialties has unknown tier '${key}' — use one of ${MODEL_TIERS.join(', ')}`,
        EXIT_VALIDATION
      );
    }
  }
  const out = {};
  for (const tier of MODEL_TIERS) {
    if (value[tier] === undefined || value[tier] === null) continue;
    const list = validateSpecialties(`${name} model_specialties.${tier}`, value[tier]);
    if (list) out[tier] = list;
  }
  return Object.keys(out).length ? out : undefined;
}

// A skill-routing key names a task kind or skill (e.g. `image-generation`) — same slug shape as an
// executor name so it stays enum-, table-, and filesystem-safe wherever it is echoed.
const TASK_KIND_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The per-task-kind recommendation map (`routing.skills`) — "which executors work BEST for this
 * kind of job, in order, and which to avoid". Empty object when unset.
 * @param {{ routing?: object }} registry
 * @returns {Record<string, { prefer: string[], avoid?: string[], note?: string }>}
 */
export function skillRouting(registry) {
  const skills = registry && registry.routing && registry.routing.skills;
  return (skills && typeof skills === 'object' && !Array.isArray(skills)) ? { ...skills } : {};
}

/**
 * Validate one skill-routing entry before it is written. `prefer` is the ordered best-fit chain
 * (validated like the global routing chain — unknown names are typos that would silently never
 * match); `avoid` names executors that should NOT take this task kind (e.g. claude for
 * image-generation) and may not overlap `prefer`; `note` is a free one-liner explaining why.
 * @param {string} taskKind
 * @param {string[]} prefer
 * @param {string[]|undefined} avoid
 * @param {string|undefined} note
 * @param {Record<string, object>} effective - effectiveExecutors() output
 * @returns {{ prefer: string[], avoid?: string[], note?: string }}
 */
export function validateSkillRoute(taskKind, prefer, avoid, note, effective) {
  if (!TASK_KIND_RE.test(taskKind)) {
    throw new SidekicksError(
      `cli-executor route skill: invalid task kind '${taskKind}' — use a short slug of [a-z0-9._-] starting alphanumeric`,
      EXIT_VALIDATION
    );
  }
  const chain = validateRoutingChain(prefer, effective); // throws on unknown/dupe/empty
  const entry = { prefer: chain };
  if (avoid !== undefined && avoid !== null) {
    if (!Array.isArray(avoid) || !avoid.every((n) => typeof n === 'string')) {
      throw new SidekicksError(`cli-executor route skill: --avoid must be a list of executor names`, EXIT_VALIDATION);
    }
    const cleaned = [];
    const seen = new Set();
    for (const name of avoid) {
      const trimmed = name.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      if (!effective[trimmed]) {
        throw new SidekicksError(
          `cli-executor route skill: unknown executor '${trimmed}' in --avoid — known: ${Object.keys(effective).sort().join(', ')}`,
          EXIT_VALIDATION
        );
      }
      if (chain.includes(trimmed)) {
        throw new SidekicksError(
          `cli-executor route skill: '${trimmed}' cannot be both preferred and avoided for '${taskKind}'`,
          EXIT_VALIDATION
        );
      }
      seen.add(trimmed);
      cleaned.push(trimmed);
    }
    if (cleaned.length) entry.avoid = cleaned;
  }
  if (note !== undefined && note !== null && String(note).trim() !== '') {
    entry.note = String(note).trim();
  }
  return entry;
}

/**
 * Merge built-in defaults with the on-disk registry into the EFFECTIVE executor set — the
 * single source of truth the executor family reads. A registry entry overrides the built-in
 * default for its name (so a built-in can be disabled or re-annotated); generic entries are
 * added. This is the exact rule scripts/registry.py mirrors.
 *
 * @param {{ executors: Record<string, object> }} registry
 * @returns {Record<string, object>} name -> effective spec (with `enabled`, `kind`, …)
 */
export function effectiveExecutors(registry) {
  const out = {};
  for (const [name, def] of Object.entries(BUILTIN_DEFAULTS)) {
    out[name] = { name, ...def };
  }
  for (const [name, spec] of Object.entries(registry.executors || {})) {
    out[name] = { name, ...(out[name] || {}), ...spec };
  }
  return out;
}

function mergeTierMap(base, override) {
  const out = { ...(base || {}) };
  if (!override || typeof override !== 'object') return out;
  for (const tier of MODEL_TIERS) {
    if (!(tier in override)) continue;
    if (override[tier] === null || override[tier] === '') delete out[tier];
    else out[tier] = override[tier];
  }
  return out;
}

function mergeExecutor(base, override) {
  if (override === null) return null;
  const out = { ...(base || {}), ...(override || {}) };
  for (const key of ['models', 'efforts', 'model_specialties']) out[key] = mergeTierMap(base?.[key], override?.[key]);
  if (Object.keys(out.models).length === 0) delete out.models;
  if (Object.keys(out.efforts).length === 0) delete out.efforts;
  if (Object.keys(out.model_specialties).length === 0) delete out.model_specialties;
  if (override && Object.prototype.hasOwnProperty.call(override, 'capabilities')) out.capabilities = override.capabilities;
  if (override && Object.prototype.hasOwnProperty.call(override, 'specialties')) out.specialties = override.specialties;
  return out;
}

/** Field-aware two-layer merge used by list and the Python parity fixtures. */
export function effectiveRegistry(rootRegistry = {}, projectRegistry = null) {
  const effective = effectiveExecutors(rootRegistry);
  const provenance = { executors: {}, routing: {} };
  for (const name of Object.keys(effective)) provenance.executors[name] = { source: 'builtin' };
  for (const [name, spec] of Object.entries(rootRegistry.executors || {})) {
    effective[name] = mergeExecutor(effective[name], spec);
    if (effective[name]) effective[name].name = name;
    provenance.executors[name] = { source: 'root' };
  }
  for (const [name, spec] of Object.entries(projectRegistry?.executors || {})) {
    const merged = mergeExecutor(effective[name], spec);
    if (merged) { merged.name = name; effective[name] = merged; provenance.executors[name] = { source: 'project' }; }
    else { delete effective[name]; delete provenance.executors[name]; }
  }
  const rootRouting = rootRegistry.routing || {};
  const projectRouting = projectRegistry?.routing || {};
  const routing = { ...rootRouting };
  if (Object.prototype.hasOwnProperty.call(projectRouting, 'prefer')) routing.prefer = projectRouting.prefer;
  routing.skills = { ...(rootRouting.skills || {}), ...(projectRouting.skills || {}) };
  for (const [key, val] of Object.entries(routing.skills)) if (val === null) delete routing.skills[key];
  if (!Object.keys(routing.skills).length) delete routing.skills;
  return { schema_version: SCHEMA_VERSION, executors: effective, routing, provenance };
}

/**
 * Validate a generic executor spec before it is written. Built-in entries only carry
 * `kind`/`enabled` (+ optional annotation) and skip the binary/invoke requirements.
 *
 * @param {string} name
 * @param {object} spec
 * @returns {object} the normalized spec ready to persist
 */
export function validateSpec(name, spec) {
  if (!NAME_RE.test(name)) {
    throw new SidekicksError(
      `cli-executor: invalid name '${name}' — use a short slug of [a-z0-9._-] starting alphanumeric`,
      EXIT_VALIDATION
    );
  }
  const kind = spec.kind || 'generic';
  if (kind !== 'builtin' && kind !== 'generic') {
    throw new SidekicksError(`cli-executor: kind must be 'builtin' or 'generic', got '${kind}'`, EXIT_VALIDATION);
  }
  const out = { kind, enabled: spec.enabled !== false };
  if (spec.description) out.description = String(spec.description);

  // Canonical family — valid on a built-in (to correct one pointed at another vendor's models) and
  // on a generic. Absent is legal: the executor stays fully usable for ordinary execution and is
  // simply ineligible for anything that needs independence.
  const family = validateFamily(name, spec.family);
  if (family) out.family = family;

  // Optional per-tier model map — valid on both builtin and generic entries.
  const models = validateModels(name, spec.models);
  if (models) out.models = models;
  const efforts = validateEfforts(name, spec.efforts);
  if (efforts) out.efforts = efforts;
  const capabilities = validateCapabilities(name, spec.capabilities);
  if (capabilities) out.capabilities = capabilities;

  // Optional capability hints the orchestrator routes tasks against — builtin and generic alike.
  const specialties = validateSpecialties(name, spec.specialties);
  if (specialties) out.specialties = specialties;

  // Optional per-tier model specialties — pairs each configured model with the jobs it is best at,
  // so the orchestrator picks the right model for the job, not just a generic complexity tier.
  const modelSpecialties = validateModelSpecialties(name, spec.model_specialties);
  if (modelSpecialties) out.model_specialties = modelSpecialties;

  if (kind === 'builtin') {
    // A built-in's role invocation profile is compiled in (profiles.mjs) and empirically verified
    // against the installed CLI, so accepting a declared one here would create the illusion of an
    // override that nothing reads. Refuse it instead of silently ignoring it.
    if (spec.profile !== undefined) {
      throw new SidekicksError(
        `cli-executor: built-in '${name}' has a compiled role profile — a declared 'profile' would be `
        + 'silently ignored, so it is refused. Register it as kind=generic under a different name if '
        + 'you need a different invocation.',
        EXIT_VALIDATION,
      );
    }
    // A builtin entry re-annotates a native adapter; it must name a real built-in.
    if (!BUILTIN_NAMES.includes(name)) {
      throw new SidekicksError(
        `cli-executor: '${name}' is not a built-in (${BUILTIN_NAMES.join(', ')}) — register it as kind=generic`,
        EXIT_VALIDATION
      );
    }
    return out;
  }

  // Generic: binary + invoke template are mandatory (this is what removes the guessing).
  if (BUILTIN_NAMES.includes(name)) {
    throw new SidekicksError(
      `cli-executor: '${name}' is a reserved built-in name — choose a different name for a generic CLI`,
      EXIT_VALIDATION
    );
  }
  if (!spec.binary || typeof spec.binary !== 'string') {
    throw new SidekicksError(`cli-executor: generic '${name}' requires --binary <exe>`, EXIT_VALIDATION);
  }
  out.binary = spec.binary;

  const invoke = spec.invoke;
  if (!Array.isArray(invoke) || invoke.length === 0 || !invoke.every((a) => typeof a === 'string')) {
    throw new SidekicksError(
      `cli-executor: generic '${name}' requires --invoke as a non-empty arg template (strings)`,
      EXIT_VALIDATION
    );
  }
  out.invoke = invoke.slice();

  const briefStdin = spec.brief_stdin === true;
  out.brief_stdin = briefStdin;
  // The brief must reach the CLI somehow: either piped on stdin, or via a {brief}/{brief_file}
  // placeholder in the invoke template. Refusing this at registration time is a real input guard —
  // a template that references neither would silently run the CLI with no task.
  const joined = invoke.join(' ');
  if (!briefStdin && !joined.includes('{brief}') && !joined.includes('{brief_file}')) {
    throw new SidekicksError(
      `cli-executor: generic '${name}' invoke template must contain {brief} or {brief_file} ` +
      `(or pass --brief-stdin to pipe the brief on stdin)`,
      EXIT_VALIDATION
    );
  }

  if (spec.probe !== undefined) {
    if (!Array.isArray(spec.probe) || !spec.probe.every((a) => typeof a === 'string')) {
      throw new SidekicksError(`cli-executor: --probe must be an arg list (strings)`, EXIT_VALIDATION);
    }
    out.probe = spec.probe.slice();
  }

  if (spec.capabilities_command !== undefined) {
    if (!Array.isArray(spec.capabilities_command) || !spec.capabilities_command.length || !spec.capabilities_command.every((a) => typeof a === 'string')) {
      throw new SidekicksError(`cli-executor: generic '${name}' capabilities_command must be a non-empty arg list`, EXIT_VALIDATION);
    }
    out.capabilities_command = spec.capabilities_command.slice();
  }
  if (spec.auth !== undefined) {
    if (!spec.auth || typeof spec.auth !== 'object' || Array.isArray(spec.auth)) {
      throw new SidekicksError(`cli-executor: generic '${name}' auth must be an object`, EXIT_VALIDATION);
    }
    const auth = {};
    for (const key of ['status_command', 'renew_command']) {
      if (spec.auth[key] === undefined) continue;
      if (!Array.isArray(spec.auth[key]) || !spec.auth[key].length || !spec.auth[key].every((a) => typeof a === 'string')) {
        throw new SidekicksError(`cli-executor: generic '${name}' auth.${key} must be a non-empty arg list`, EXIT_VALIDATION);
      }
      auth[key] = spec.auth[key].slice();
    }
    if (spec.auth.interactive === true) auth.interactive = true;
    if (Object.keys(auth).length) out.auth = auth;
  }

  const transport = spec.transport || 'print-mode';
  if (!TRANSPORTS.includes(transport)) {
    throw new SidekicksError(`cli-executor: transport must be one of ${TRANSPORTS.join(', ')}`, EXIT_VALIDATION);
  }
  out.transport = transport;

  const sandbox = spec.sandbox || 'constraint-block-only';
  if (!SANDBOX_LEVELS.includes(sandbox)) {
    throw new SidekicksError(`cli-executor: sandbox must be one of ${SANDBOX_LEVELS.join(', ')}`, EXIT_VALIDATION);
  }
  out.sandbox = sandbox;

  out.usage_exposed = spec.usage_exposed === true;

  const profile = validateRoleProfile(name, spec.profile);
  if (profile) out.profile = profile;

  return out;
}

/**
 * Validate an optional canonical family value.
 *
 * @param {string} name
 * @param {unknown} family
 * @returns {string|undefined} the normalized family, or undefined when none was given
 */
export function validateFamily(name, family) {
  if (family === undefined || family === null || family === '') return undefined;
  if (typeof family !== 'string' || !FAMILY_RE.test(family)) {
    throw new SidekicksError(
      `cli-executor: '${name}' family must be a short slug of [a-z0-9._-] starting alphanumeric `
      + "(e.g. 'anthropic', 'openai', 'google') — it names the vendor/model lineage two seats would "
      + 'share, so it becomes a run-folder segment too',
      EXIT_VALIDATION,
    );
  }
  return family;
}

/** How a role profile may transport its prompt. */
export const PROMPT_TRANSPORTS = Object.freeze(['flag:-p', 'stdin', 'stdin-dash', 'positional']);
/** How a role profile may pass a structured-output schema. */
export const PROFILE_SCHEMA_TRANSPORTS = Object.freeze(['file', 'inline', 'none']);
/** How a role profile's stdout is parsed. */
export const PROFILE_PARSERS = Object.freeze(['claude-json', 'gemini-json', 'agy-json', 'codex-jsonl', 'text']);
/**
 * How a role profile may REFUSE a command before it runs.
 *
 * Mirrors `ENFORCEMENT_MECHANISMS` in profiles.mjs — kept here so the registry can validate a
 * declared profile without importing the profile compiler.
 */
export const PROFILE_ENFORCEMENT_MECHANISMS = Object.freeze(['tool-deny', 'tool-allowlist', 'os-sandbox']);

/**
 * Validate a GENERIC executor's role invocation profile.
 *
 * This is the block that makes a registered CLI dispatchable for a goal role, and every field in it
 * exists because the alternative is inference. Nothing here is guessed from an `invoke` template: a
 * template says how to hand the CLI a brief, not whether the resulting session can write to the
 * tree — and treating an unknown invocation as plan-safe or as writable is precisely the mistake
 * that would let a "read-only" reviewer edit the code it is grading.
 *
 * Every key is optional, and an absent one narrows what the executor may do rather than widening it:
 * no `read_only_args` means it can never hold a review role, no `edit_args` means it can never
 * implement, and an absent `resume_roles` means every correction relaunches a fresh session.
 *
 * @param {string} name
 * @param {unknown} profile
 * @returns {object|undefined}
 */
export function validateRoleProfile(name, profile) {
  if (profile === undefined || profile === null) return undefined;
  if (typeof profile !== 'object' || Array.isArray(profile)) {
    throw new SidekicksError(`cli-executor: '${name}' profile must be an object`, EXIT_VALIDATION);
  }
  const out = {};

  for (const key of ['lead_args', 'read_only_args', 'edit_args', 'base_args']) {
    const value = profile[key];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value) || !value.every((a) => typeof a === 'string')) {
      throw new SidekicksError(
        `cli-executor: '${name}' profile.${key} must be an array of argument strings`,
        EXIT_VALIDATION,
      );
    }
    out[key] = value.slice();
  }
  if (out.read_only_args === undefined && out.edit_args === undefined) {
    throw new SidekicksError(
      `cli-executor: '${name}' profile declares neither read_only_args nor edit_args, so it could hold `
      + 'no goal role at all — declare at least one containment invocation',
      EXIT_VALIDATION,
    );
  }

  if (profile.prompt !== undefined) {
    if (!PROMPT_TRANSPORTS.includes(profile.prompt)) {
      throw new SidekicksError(
        `cli-executor: '${name}' profile.prompt must be one of ${PROMPT_TRANSPORTS.join(', ')}`,
        EXIT_VALIDATION,
      );
    }
    out.prompt = profile.prompt;
  }

  for (const key of ['model_flag', 'effort_flag', 'schema_flag', 'resume_flag']) {
    if (profile[key] === undefined || profile[key] === null) continue;
    if (typeof profile[key] !== 'string' || profile[key] === '') {
      throw new SidekicksError(`cli-executor: '${name}' profile.${key} must be a flag string`, EXIT_VALIDATION);
    }
    out[key] = profile[key];
  }

  if (profile.schema !== undefined) {
    if (!PROFILE_SCHEMA_TRANSPORTS.includes(profile.schema)) {
      throw new SidekicksError(
        `cli-executor: '${name}' profile.schema must be one of ${PROFILE_SCHEMA_TRANSPORTS.join(', ')}`,
        EXIT_VALIDATION,
      );
    }
    if (profile.schema !== 'none' && !out.schema_flag) {
      throw new SidekicksError(
        `cli-executor: '${name}' profile.schema is '${profile.schema}' but no schema_flag is declared`,
        EXIT_VALIDATION,
      );
    }
    out.schema = profile.schema;
  }

  if (profile.parser !== undefined) {
    if (!PROFILE_PARSERS.includes(profile.parser)) {
      throw new SidekicksError(
        `cli-executor: '${name}' profile.parser must be one of ${PROFILE_PARSERS.join(', ')}`,
        EXIT_VALIDATION,
      );
    }
    out.parser = profile.parser;
  }

  if (profile.resume_roles !== undefined && profile.resume_roles !== null) {
    if (!Array.isArray(profile.resume_roles) || !profile.resume_roles.every((r) => typeof r === 'string')) {
      throw new SidekicksError(
        `cli-executor: '${name}' profile.resume_roles must be an array of role names`,
        EXIT_VALIDATION,
      );
    }
    if (profile.resume_roles.length > 0 && !out.resume_flag) {
      throw new SidekicksError(
        `cli-executor: '${name}' profile declares resume_roles but no resume_flag — resume is refused `
        + 'unless the flag that re-asserts containment is named',
        EXIT_VALIDATION,
      );
    }
    out.resume_roles = profile.resume_roles.slice();
  }

  // An enforcement block is what makes a generic executor eligible to IMPLEMENT, so it is validated
  // strictly and never partially accepted: a block whose mechanism this build does not know is a claim
  // of enforcement that nothing checks, and dropping it silently would leave the operator believing a
  // boundary exists.
  if (profile.enforcement !== undefined && profile.enforcement !== null) {
    const block = profile.enforcement;
    if (typeof block !== 'object' || Array.isArray(block)) {
      throw new SidekicksError(
        `cli-executor: '${name}' profile.enforcement must be an object`,
        EXIT_VALIDATION,
      );
    }
    if (!PROFILE_ENFORCEMENT_MECHANISMS.includes(block.mechanism)) {
      throw new SidekicksError(
        `cli-executor: '${name}' profile.enforcement.mechanism must be one of `
        + `${PROFILE_ENFORCEMENT_MECHANISMS.join(', ')} — a prompt that asks the model to behave is `
        + 'not a mechanism, and declaring one here is what lets this executor implement',
        EXIT_VALIDATION,
      );
    }
    for (const key of ['args', 'enforces', 'gaps']) {
      const value = block[key];
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        throw new SidekicksError(
          `cli-executor: '${name}' profile.enforcement.${key} must be an array of strings`,
          EXIT_VALIDATION,
        );
      }
    }
    if (!Array.isArray(block.enforces) || block.enforces.length === 0) {
      throw new SidekicksError(
        `cli-executor: '${name}' profile.enforcement declares no 'enforces' classes — name the `
        + 'hard-stopped action classes this mechanism actually refuses',
        EXIT_VALIDATION,
      );
    }
    out.enforcement = {
      mechanism: block.mechanism,
      args: Array.isArray(block.args) ? block.args.slice() : [],
      enforces: block.enforces.slice(),
      gaps: Array.isArray(block.gaps) ? block.gaps.slice() : [],
      note: typeof block.note === 'string' ? block.note : '',
    };
  }
  if (typeof profile.enforcement_gap === 'string' && profile.enforcement_gap !== '') {
    out.enforcement_gap = profile.enforcement_gap;
  }

  return out;
}

/**
 * Persist the registry atomically (surface-gated). Executors are key-sorted so diffs stay stable.
 *
 * @param {string} path
 * @param {{ schema_version?: number, executors: Record<string, object> }} registry
 * @param {string} repoRoot
 */
export function writeRegistry(path, registry, repoRoot) {
  const sorted = {};
  for (const key of Object.keys(registry.executors).sort()) sorted[key] = registry.executors[key];
  const payload = { schema_version: SCHEMA_VERSION, executors: sorted };
  // Preserve the routing policy across executor register/remove writes (they mutate only .executors).
  // BOTH routing keys ride along: `prefer` (the global fallback chain) and `skills` (the per-task-kind
  // recommendation map) — dropping either here would silently lose config on the next verb write.
  const routing = {};
  if (registry.routing && Array.isArray(registry.routing.prefer) && registry.routing.prefer.length) {
    routing.prefer = registry.routing.prefer.slice();
  }
  const skills = skillRouting(registry);
  if (Object.keys(skills).length) {
    const sortedSkills = {};
    for (const key of Object.keys(skills).sort()) sortedSkills[key] = skills[key];
    routing.skills = sortedSkills;
  }
  if (Object.keys(routing).length) payload.routing = routing;
  assertWritable(path, repoRoot);
  writeAtomic(path, JSON.stringify(payload, null, 2) + '\n');
}
