// lib/manifest-schema/service.mjs
// Service-name derivation (kebab-case canonical algorithm) + service.yaml reads/writes.
// Zero npm dependencies — node:path, node:fs only (plus relative lib/ imports).

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { SidekicksError, EXIT_VALIDATION, EXIT_IO } from '../sk-cli/errors.mjs';
import { parse, serialize } from '../yaml-subset/yaml.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';

// Reserved names (may not be used as a service name).
const RESERVED = new Set(['sidekicks']);

// Valid kebab-case pattern: one or more [a-z0-9-] characters, no leading/trailing dash.
const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^[a-z0-9]$/;

/**
 * Derive (or validate) a service name from a git URL and an optional explicit name.
 *
 * If `optName` is provided, it is validated without derivation.
 * If `optName` is absent, the canonical algorithm is applied to `url`:
 *   1. Strip trailing slash
 *   2. Strip ".git" suffix
 *   3. Take last path segment (split on '/' and ':')
 *   4. Lowercase
 *   5. Replace [^a-z0-9]+ with "-"
 *   6. Strip leading/trailing "-"
 *
 * The caller supplies `servicesDir` (absolute path to `projects/<active>/services/`)
 * so existence can be checked without the function needing repoRoot.
 *
 * @param {string}  url          - Git URL (used for derivation when optName is absent).
 * @param {string|undefined} optName    - Explicit name override (optional).
 * @param {string}  servicesDir  - Absolute path to the active project's services/ directory.
 * @returns {string}             - The validated kebab-case service name.
 * @throws {SidekicksError(EXIT_VALIDATION)} on any validation failure.
 */
export function deriveName(url, optName, servicesDir) {
  let name;

  if (optName !== undefined && optName !== null && optName !== '') {
    // Explicit name — use as-is, skip derivation.
    name = optName;
  } else {
    // Derivation algorithm.
    let raw = url;

    // Step 1: strip trailing slash
    raw = raw.replace(/\/+$/, '');

    // Step 2: strip ".git" suffix
    if (raw.endsWith('.git')) {
      raw = raw.slice(0, -4);
    }

    // Step 3: take last path segment (split on '/' and ':')
    const parts = raw.split(/[/:]/);
    raw = parts[parts.length - 1] || '';

    // Step 4: lowercase
    raw = raw.toLowerCase();

    // Step 5: replace [^a-z0-9]+ with "-"
    raw = raw.replace(/[^a-z0-9]+/g, '-');

    // Step 6: strip leading/trailing "-"
    raw = raw.replace(/^-+|-+$/g, '');

    name = raw;
  }

  // Validate pattern
  if (!name || !NAME_PATTERN.test(name)) {
    throw new SidekicksError(
      `service name '${name}' is invalid — must match [a-z0-9-] (no leading/trailing dashes)`,
      EXIT_VALIDATION
    );
  }

  // Validate not reserved
  if (RESERVED.has(name)) {
    throw new SidekicksError(
      `service name '${name}' is reserved and cannot be used`,
      EXIT_VALIDATION
    );
  }

  // Validate does not already exist
  if (servicesDir) {
    const candidateDir = join(servicesDir, name);
    if (existsSync(candidateDir)) {
      throw new SidekicksError(
        `service '${name}' already exists under services/`,
        EXIT_VALIDATION
      );
    }
  }

  return name;
}

/**
 * Atomically write a service.yaml file with the five canonical fields.
 *
 * Fields written: name, remote_source, branch, commit, overrides: {}
 *
 * `remote_source`, `branch`, and `commit` default to `null` when absent. A freshly
 * added service that has not been pulled yet records `remote_source` (when a URL was
 * supplied) but leaves `branch`/`commit` null — they are populated by `service pull`
 * once a working tree exists to read git state from.
 *
 * @param {string} absPath - Absolute path to service.yaml.
 * @param {{ name: string, remote_source?: string|null, branch?: string|null, commit?: string|null }} data
 * @throws {SidekicksError(EXIT_IO)} on I/O failure.
 */
export function write(absPath, data) {
  const obj = {
    name: data.name,
    remote_source: data.remote_source ?? null,
    branch: data.branch ?? null,
    commit: data.commit ?? null,
    overrides: {},
  };
  try {
    // Derive repoRoot: projects/<name>/services/<service-name>/service.yaml -> repoRoot (5 hops)
    const repoRoot = dirname(dirname(dirname(dirname(dirname(absPath)))));
    assertWritable(absPath, repoRoot);
    writeAtomic(absPath, serialize(obj));
  } catch (err) {
    if (err instanceof SidekicksError) throw err;
    throw new SidekicksError(
      `service.write: failed to write '${absPath}': ${err.message}`,
      EXIT_IO
    );
  }
}

/**
 * Atomically rewrite only `branch` and `commit` fields in an existing service.yaml.
 * All other fields (name, remote_source, overrides) are preserved intact.
 *
 * @param {string} absPath  - Absolute path to service.yaml.
 * @param {string} branch   - New branch value (may be "HEAD" for detached state).
 * @param {string} commit   - New full HEAD SHA.
 * @throws {SidekicksError(EXIT_IO)} on I/O failure.
 */
export function setBranchCommit(absPath, branch, commit) {
  if (!existsSync(absPath)) {
    throw new SidekicksError(
      `service.setBranchCommit: file not found: '${absPath}'`,
      EXIT_IO
    );
  }

  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch (err) {
    throw new SidekicksError(
      `service.setBranchCommit: failed to read '${absPath}': ${err.message}`,
      EXIT_IO
    );
  }

  let obj;
  try {
    obj = parse(text);
  } catch (err) {
    throw new SidekicksError(
      `service.setBranchCommit: '${absPath}' is not valid YAML: ${err.message}`,
      EXIT_IO
    );
  }

  const updated = { ...obj, branch, commit };
  try {
    // Derive repoRoot: projects/<name>/services/<service-name>/service.yaml -> repoRoot (5 hops)
    const repoRoot = dirname(dirname(dirname(dirname(dirname(absPath)))));
    assertWritable(absPath, repoRoot);
    writeAtomic(absPath, serialize(updated));
  } catch (err) {
    if (err instanceof SidekicksError) throw err;
    throw new SidekicksError(
      `service.setBranchCommit: failed to write '${absPath}': ${err.message}`,
      EXIT_IO
    );
  }
}
