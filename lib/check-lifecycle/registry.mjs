// lib/check-lifecycle/registry.mjs
// The STATIC gate registry and the named profiles built from it.
//
// WHY A REGISTRY RATHER THAN MORE npm SCRIPTS. A script list cannot express what this substrate's
// verification actually is: `skill doctor` is worth nothing if the suite it reads is already broken,
// `parity` re-running after a red `tests.all` is noise, and a human reading a wall of red cannot
// tell which failure caused the other nine. Dependencies encode that, so a failed prerequisite marks
// its dependents `blocked` instead of running them and reporting a second, derived failure.
//
// TWO KINDS OF GATE, AND NEVER A SHELL STRING. A gate is either an argv ARRAY spawned with
// `shell: false`, or an internal handler function. There is deliberately no third form: a command
// string would have to be word-split by someone, and the only correct splitter for
// `C:\Users\a b\repo` differs from the one for `/Users/a b/repo`. `argv[0] === 'node'` is resolved to
// `process.execPath` at spawn time, so the running interpreter (and its `.exe` suffix on Windows) is
// the one the gate uses.
//
// Zero npm dependencies — node:* only.

import { availableParallelism, cpus as cpuList } from 'node:os';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';

/** The schema version of the result document. Bumped when a field's meaning changes. */
export const SCHEMA_VERSION = 1;

/** Jobs bounds, inclusive. Below 1 is meaningless; above 8 buys nothing on the machines this runs on. */
export const JOBS_MIN = 1;
export const JOBS_MAX = 8;

/** Per-gate wall-clock ceiling, by profile. A gate that outlives it is a failure, never a hang. */
export const PROFILE_TIMEOUT_MS = Object.freeze({
  quick: 120_000,
  full: 900_000,
  release: 1_200_000,
});

/**
 * Every gate, in REGISTRY ORDER — the order gate rows appear in, in both renderings, regardless of
 * the order they finished in. A completion-ordered report changes shape run to run and cannot be
 * diffed; this one can.
 *
 * `cost_ms` is an ESTIMATE, used only to start the expensive gates first when several are ready and
 * a job slot frees up. It is never asserted against and never reported as a measurement.
 *
 * @type {ReadonlyArray<{id: string, command: readonly string[]|null, handler: string|null, dependencies: readonly string[], blocking: boolean, cost_ms: number, summary: string}>}
 */
export const GATES = Object.freeze([
  {
    id: 'catalog.check',
    command: Object.freeze(['node', 'bin/sidekicks', 'catalog', 'check', '--json']),
    handler: null,
    dependencies: Object.freeze([]),
    blocking: true,
    cost_ms: 6_000,
    summary: 'Generated framework catalog is current and internally consistent',
  },
  {
    id: 'tests.contract',
    command: Object.freeze([
      'node', '--test',
      'tests/catalog-lifecycle/catalog.test.mjs',
      'tests/check-lifecycle/runner.test.mjs',
    ]),
    handler: null,
    dependencies: Object.freeze([]),
    blocking: true,
    cost_ms: 30_000,
    summary: 'The contract suites for the catalog and this runner',
  },
  {
    id: 'framework.doctor',
    command: Object.freeze(['node', 'bin/sidekicks', 'framework', 'doctor', '--json']),
    handler: null,
    dependencies: Object.freeze([]),
    blocking: true,
    cost_ms: 4_000,
    summary: 'Rule/criterion/hook registry and wiring drift',
  },
  {
    id: 'config.doctor',
    command: Object.freeze(['node', 'bin/sidekicks', 'config', 'doctor', '--json']),
    handler: null,
    dependencies: Object.freeze([]),
    blocking: true,
    cost_ms: 4_000,
    summary: 'Config health: duplicate blocks, credentials in committed files, undeclared blocks',
  },
  {
    id: 'tests.all',
    command: Object.freeze(['node', 'scripts/run-tests.mjs']),
    handler: null,
    // The whole suite reads the generated catalog. Running it against stale generated output would
    // report the drift as a suite failure somewhere else, so the cheap gate goes first.
    dependencies: Object.freeze(['catalog.check']),
    blocking: true,
    cost_ms: 420_000,
    summary: 'The complete test suite (scripts/run-tests.mjs)',
  },
  {
    id: 'framework.sync',
    command: Object.freeze(['node', 'bin/sidekicks', 'framework', 'sync', '--check', '--json']),
    handler: null,
    dependencies: Object.freeze(['framework.doctor']),
    blocking: true,
    cost_ms: 4_000,
    summary: 'Every toggleable entry is listed in .sidekicks/config/settings/ (read-only)',
  },
  {
    id: 'config.sync',
    command: Object.freeze(['node', 'bin/sidekicks', 'config', 'sync', '--check', '--json']),
    handler: null,
    dependencies: Object.freeze(['config.doctor']),
    blocking: true,
    cost_ms: 8_000,
    summary: 'Every installed skill\'s declared config block is documented (read-only)',
  },
  {
    id: 'skill.doctor',
    command: Object.freeze(['node', 'bin/sidekicks', 'skill', 'doctor', '--strict', '--json']),
    handler: null,
    dependencies: Object.freeze(['tests.all']),
    blocking: true,
    cost_ms: 30_000,
    summary: 'Per-skill dependency drift, strict',
  },
  {
    id: 'parity',
    command: Object.freeze([
      'node', '--test',
      'tests/multi-cli-parity.test.mjs',
      'tests/agent-context-mirror.test.mjs',
    ]),
    handler: null,
    dependencies: Object.freeze(['tests.all']),
    blocking: true,
    cost_ms: 15_000,
    summary: 'Rule 6 shared-surface parity across every supported agent CLI',
  },
  {
    id: 'skill.verify',
    command: Object.freeze(['node', 'bin/sidekicks', 'skill', 'verify', '--strict', '--json']),
    handler: null,
    dependencies: Object.freeze(['skill.doctor']),
    blocking: true,
    cost_ms: 60_000,
    summary: 'Bundle-hash baselines across every skill, strict',
  },
  {
    id: 'package.clean',
    command: null,
    handler: 'package.clean',
    dependencies: Object.freeze(['tests.all', 'catalog.check']),
    blocking: true,
    cost_ms: 90_000,
    summary: 'Assemble a package in a temp directory and drive ONLY its packaged entrypoint',
  },
  {
    id: 'core.mounted',
    command: null,
    handler: 'core.mounted',
    dependencies: Object.freeze(['package.clean']),
    blocking: true,
    cost_ms: 120_000,
    summary: 'Mount a fresh core in a temp workspace and drive ONLY its mounted entrypoint',
  },
  {
    id: 'golden.replay',
    command: null,
    handler: 'golden.replay',
    dependencies: Object.freeze(['package.clean', 'core.mounted']),
    blocking: true,
    cost_ms: 60_000,
    summary: 'Replay the curated golden fixtures — comparison only, never an update',
  },
]);

/** Gate ids per profile. Each profile is a SUPERSET of the one before it. */
const QUICK = ['catalog.check', 'tests.contract', 'framework.doctor', 'config.doctor'];
const FULL = [...QUICK, 'tests.all', 'framework.sync', 'config.sync', 'skill.doctor', 'parity'];
const RELEASE = [...FULL, 'skill.verify', 'package.clean', 'core.mounted', 'golden.replay'];

export const PROFILES = Object.freeze({
  quick: Object.freeze([...QUICK]),
  full: Object.freeze([...FULL]),
  release: Object.freeze([...RELEASE]),
});

/** Profile names, in escalation order. */
export const PROFILE_NAMES = Object.freeze(Object.keys(PROFILES));

/**
 * The gate definitions a profile selects, in REGISTRY order (not in the order the profile lists
 * them), with every transitive dependency present.
 *
 * @param {string} profile
 * @param {ReadonlyArray<object>} [gates]
 * @returns {ReadonlyArray<object>}
 * @throws {SidekicksError} EXIT_VALIDATION on an unknown profile or an unsatisfiable one
 */
export function profileGates(profile, gates = GATES) {
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)) {
    throw new SidekicksError(
      `check run: unknown profile '${profile ?? ''}' — expected one of ${PROFILE_NAMES.join(', ')}`,
      EXIT_VALIDATION,
    );
  }
  const byId = new Map(gates.map((g) => [g.id, g]));
  const want = new Set();
  /** @param {string} id */
  const add = (id) => {
    if (want.has(id)) return;
    const gate = byId.get(id);
    if (!gate) {
      throw new SidekicksError(
        `check run: profile '${profile}' names gate '${id}', which the registry does not define`,
        EXIT_VALIDATION,
      );
    }
    want.add(id);
    for (const dep of gate.dependencies) add(dep);
  };
  for (const id of PROFILES[profile]) add(id);
  return Object.freeze(gates.filter((g) => want.has(g.id)));
}

/**
 * Structural problems in a gate set: duplicate ids, dangling dependencies, a gate that is neither a
 * command nor a handler (or is both), and dependency cycles.
 *
 * Returned rather than thrown, so a caller can report every problem at once.
 *
 * @param {ReadonlyArray<object>} gates
 * @returns {string[]} human-readable problems; empty means healthy
 */
export function validateRegistry(gates = GATES) {
  const problems = [];
  const seen = new Set();
  for (const gate of gates) {
    if (!gate || typeof gate.id !== 'string' || gate.id === '') {
      problems.push('a gate has no id');
      continue;
    }
    if (seen.has(gate.id)) problems.push(`duplicate gate id '${gate.id}'`);
    seen.add(gate.id);
    const hasCommand = Array.isArray(gate.command) && gate.command.length > 0;
    const hasHandler = typeof gate.handler === 'string' && gate.handler !== '';
    if (hasCommand && hasHandler) problems.push(`gate '${gate.id}' declares both a command and a handler`);
    if (!hasCommand && !hasHandler) problems.push(`gate '${gate.id}' declares neither a command nor a handler`);
    if (hasCommand && gate.command.some((tok) => typeof tok !== 'string')) {
      problems.push(`gate '${gate.id}' has a non-string token in its argv`);
    }
    if (typeof gate.blocking !== 'boolean') problems.push(`gate '${gate.id}' has no blocking flag`);
    if (!Array.isArray(gate.dependencies)) problems.push(`gate '${gate.id}' has no dependency list`);
  }
  const byId = new Map(gates.map((g) => [g && g.id, g]));
  for (const gate of gates) {
    for (const dep of (gate && gate.dependencies) || []) {
      if (!byId.has(dep)) problems.push(`gate '${gate.id}' depends on unknown gate '${dep}'`);
    }
  }
  // Cycles — depth-first, with the path kept so the report names the loop rather than its existence.
  const state = new Map();
  /** @param {string} id @param {string[]} path */
  const walk = (id, path) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      problems.push(`dependency cycle: ${[...path, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'open');
    for (const dep of (byId.get(id) || { dependencies: [] }).dependencies || []) {
      if (byId.has(dep)) walk(dep, [...path, id]);
    }
    state.set(id, 'done');
  };
  for (const gate of gates) if (gate && gate.id) walk(gate.id, []);
  return problems;
}

/**
 * Coerce and bound the `--jobs` value.
 *
 * @param {unknown} raw - the flag value, or null/undefined for the default
 * @param {number} [defaultJobs]
 * @returns {number}
 * @throws {SidekicksError} EXIT_VALIDATION on a non-integer or an out-of-range value
 */
export function normalizeJobs(raw, defaultJobs) {
  if (raw === undefined || raw === null || raw === '' || raw === true) {
    if (raw === true) {
      throw new SidekicksError(
        'check run: --jobs needs a value (use --jobs=N or --jobs N)',
        EXIT_VALIDATION,
      );
    }
    return defaultJobs ?? defaultJobCount();
  }
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new SidekicksError(
      `check run: --jobs must be a whole number between ${JOBS_MIN} and ${JOBS_MAX} (got '${text}')`,
      EXIT_VALIDATION,
    );
  }
  const n = Number(text);
  if (n < JOBS_MIN || n > JOBS_MAX) {
    throw new SidekicksError(
      `check run: --jobs must be between ${JOBS_MIN} and ${JOBS_MAX} (got ${n})`,
      EXIT_VALIDATION,
    );
  }
  return n;
}

/**
 * The default job count: min(4, os.availableParallelism()).
 *
 * Four is the ceiling on purpose: the expensive gates are themselves test runners that fan out
 * internally, so more outer slots mostly buys contention. `availableParallelism` exists on every
 * Node >= 18.14; `cpus().length` is the fallback for a runtime that lacks it.
 *
 * @param {number} [parallelism] - injected for tests; the machine's own value when omitted
 * @returns {number}
 */
export function defaultJobCount(parallelism) {
  let cpus = parallelism;
  if (typeof cpus !== 'number' || !Number.isFinite(cpus)) {
    try {
      cpus = typeof availableParallelism === 'function' ? availableParallelism() : cpuList().length;
    } catch {
      cpus = 1;
    }
  }
  const n = Number.isFinite(cpus) && cpus >= 1 ? Math.floor(cpus) : 1;
  return Math.max(JOBS_MIN, Math.min(4, n));
}
