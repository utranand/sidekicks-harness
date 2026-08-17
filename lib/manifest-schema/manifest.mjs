// lib/manifest-schema/manifest.mjs
// Project manifest schema enforcement + targeted RMW operations.
// Reads/writes projects/<name>/manifest.yaml using the yaml-subset parser.
// Zero npm dependencies — node:fs, node:path only (plus relative lib/ imports).
// Consumed by: project set-remote, service add

import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, serialize } from '../yaml-subset/yaml.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';

// Known top-level keys for manifest.yaml (strict-reject unknown).
const KNOWN_KEYS = new Set(['name', 'remote_source', 'services', 'overrides', 'databases']);

// Valid kebab-case pattern for manifest name field.
const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^[a-z0-9]$/;

/**
 * Read and validate a manifest.yaml file.
 *
 * Throws SidekicksError(EXIT_VALIDATION) if:
 *   - the file is absent
 *   - the file is not parseable YAML
 *   - required field `name` is missing or invalid
 *   - any field has a wrong type
 *   - any unknown top-level key is present (strict-reject)
 *
 * @param {string} absPath - Absolute path to manifest.yaml.
 * @returns {object} - The validated manifest object.
 * @throws {SidekicksError(EXIT_VALIDATION)} on any validation failure.
 */
export function read(absPath) {
  if (!existsSync(absPath)) {
    throw new SidekicksError(
      `manifest: file not found: '${absPath}'`,
      EXIT_VALIDATION
    );
  }

  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch (err) {
    throw new SidekicksError(
      `manifest: failed to read '${absPath}': ${err.message}`,
      EXIT_VALIDATION
    );
  }

  let obj;
  try {
    obj = parse(text);
  } catch (err) {
    // Re-wrap parse errors (SidekicksError from yaml.mjs) with manifest context.
    throw new SidekicksError(
      `manifest: '${absPath}' is not valid YAML: ${err.message}`,
      EXIT_VALIDATION
    );
  }

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new SidekicksError(
      `manifest: '${absPath}' must be a YAML mapping at top level`,
      EXIT_VALIDATION
    );
  }

  validate(obj);
  return obj;
}

/**
 * Validate a manifest object in memory.
 * Strict-reject: unknown top-level keys are rejected.
 *
 * @param {object} obj - The parsed manifest object.
 * @throws {SidekicksError(EXIT_VALIDATION)} on any violation.
 */
export function validate(obj) {
  // Reject unknown top-level keys (strict-reject).
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new SidekicksError(
        `manifest: unknown field '${key}' — only [${[...KNOWN_KEYS].join(', ')}] are permitted`,
        EXIT_VALIDATION
      );
    }
  }

  // `name` is required and must match kebab-case.
  if (obj.name === undefined || obj.name === null) {
    throw new SidekicksError(
      `manifest: missing required field 'name'`,
      EXIT_VALIDATION
    );
  }
  if (typeof obj.name !== 'string' || !NAME_PATTERN.test(obj.name)) {
    throw new SidekicksError(
      `manifest: field 'name' must be a kebab-case string matching [a-z0-9-]; got '${obj.name}'`,
      EXIT_VALIDATION
    );
  }

  // `remote_source`: string or null (optional).
  if (obj.remote_source !== undefined && obj.remote_source !== null) {
    if (typeof obj.remote_source !== 'string') {
      throw new SidekicksError(
        `manifest: field 'remote_source' must be a string or null; got ${typeof obj.remote_source}`,
        EXIT_VALIDATION
      );
    }
  }

  // `services`: list of strings (optional, advisory only).
  if (obj.services !== undefined && obj.services !== null) {
    if (!Array.isArray(obj.services)) {
      throw new SidekicksError(
        `manifest: field 'services' must be a list of strings; got ${typeof obj.services}`,
        EXIT_VALIDATION
      );
    }
    for (let i = 0; i < obj.services.length; i++) {
      if (typeof obj.services[i] !== 'string') {
        throw new SidekicksError(
          `manifest: field 'services[${i}]' must be a string; got ${typeof obj.services[i]}`,
          EXIT_VALIDATION
        );
      }
    }
  }

  // `overrides`: mapping or null (optional).
  if (obj.overrides !== undefined && obj.overrides !== null) {
    if (typeof obj.overrides !== 'object' || Array.isArray(obj.overrides)) {
      throw new SidekicksError(
        `manifest: field 'overrides' must be a mapping or null; got ${Array.isArray(obj.overrides) ? 'array' : typeof obj.overrides}`,
        EXIT_VALIDATION
      );
    }
  }

  // `databases`: list of database entry objects (optional).
  if (obj.databases !== undefined && obj.databases !== null) {
    if (!Array.isArray(obj.databases)) {
      throw new SidekicksError(
        `manifest: field 'databases' must be an array; got ${typeof obj.databases}`,
        EXIT_VALIDATION
      );
    }

    const REQUIRED_STRING_FIELDS = ['name', 'version', 'path', 'tree', 'source', 'captured_at', 'checksum'];
    // Fields where a JS number value (product of yaml-subset numeric coercion) must be rejected.
    const NON_NUMERIC_FIELDS = ['name', 'version', 'source'];

    for (let i = 0; i < obj.databases.length; i++) {
      const entry = obj.databases[i];

      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new SidekicksError(
          `manifest: databases[${i}] must be a mapping object`,
          EXIT_VALIDATION
        );
      }

      // Required string fields: must be present and of type string.
      for (const field of REQUIRED_STRING_FIELDS) {
        if (entry[field] === undefined || entry[field] === null) {
          throw new SidekicksError(
            `manifest: databases[${i}] missing required field '${field}'`,
            EXIT_VALIDATION
          );
        }
        if (typeof entry[field] !== 'string') {
          throw new SidekicksError(
            `manifest: databases[${i}].${field} must be a string; got ${typeof entry[field]}`,
            EXIT_VALIDATION
          );
        }
      }

      // name, version, source must be non-numeric (guard against yaml-subset coercion trap).
      // The check above already rejects a JS number (typeof !== 'string'), but this guard
      // provides the explicit rejection message referencing the non-digit requirement.
      for (const field of NON_NUMERIC_FIELDS) {
        // Already confirmed string above; this branch handles the coercion case where
        // an all-digit input survived as a number — caught by the typeof check above.
        // Left as defense-in-depth: if somehow a numeric string reaches here, still reject.
        if (!/[^0-9]/.test(entry[field])) {
          throw new SidekicksError(
            `manifest: databases[${i}].${field} must contain at least one non-digit character (got '${entry[field]}'); database ${field} must not be purely numeric`,
            EXIT_VALIDATION
          );
        }
      }

      // `schemas`: optional; if present must be a string (not an array).
      if (entry.schemas !== undefined && entry.schemas !== null) {
        if (Array.isArray(entry.schemas)) {
          throw new SidekicksError(
            `manifest: databases[${i}].schemas must be a comma-joined string, not an array`,
            EXIT_VALIDATION
          );
        }
        if (typeof entry.schemas !== 'string') {
          throw new SidekicksError(
            `manifest: databases[${i}].schemas must be a string; got ${typeof entry.schemas}`,
            EXIT_VALIDATION
          );
        }
      }

      // `table_count`: optional; if present must be a non-negative integer number (not string, not float, not negative).
      if (entry.table_count !== undefined && entry.table_count !== null) {
        if (typeof entry.table_count === 'string') {
          throw new SidekicksError(
            `manifest: databases[${i}].table_count must be a number, not a string; use a bare YAML integer`,
            EXIT_VALIDATION
          );
        }
        if (typeof entry.table_count !== 'number') {
          throw new SidekicksError(
            `manifest: databases[${i}].table_count must be a non-negative integer number; got ${typeof entry.table_count}`,
            EXIT_VALIDATION
          );
        }
        if (!Number.isInteger(entry.table_count)) {
          throw new SidekicksError(
            `manifest: databases[${i}].table_count must be an integer; got ${entry.table_count}`,
            EXIT_VALIDATION
          );
        }
        if (entry.table_count < 0) {
          throw new SidekicksError(
            `manifest: databases[${i}].table_count must be a non-negative integer; got ${entry.table_count}`,
            EXIT_VALIDATION
          );
        }
      }
    }
  }
}

/**
 * Atomically add a service relative path to the manifest's `services:` list.
 * Idempotent — does not add duplicates.
 *
 * @param {string} absPath   - Absolute path to manifest.yaml.
 * @param {string} relPath   - Relative path to add, e.g. "services/my-api".
 * @throws {SidekicksError} on read/write failure.
 */
export function addService(absPath, relPath) {
  const obj = read(absPath);
  const services = Array.isArray(obj.services) ? [...obj.services] : [];
  if (!services.includes(relPath)) {
    services.push(relPath);
  }
  const updated = { ...obj, services };

  // Derive repoRoot: manifest.yaml -> projects/<name>/ -> projects/ -> repoRoot
  const repoRoot = dirname(dirname(dirname(absPath)));
  assertWritable(absPath, repoRoot);
  writeAtomic(absPath, serialize(updated));
}

/**
 * Atomically remove a service relative path from the manifest's `services:` list.
 * Idempotent — a no-op (still rewrites) if the path is absent.
 *
 * @param {string} absPath   - Absolute path to manifest.yaml.
 * @param {string} relPath   - Relative path to remove, e.g. "services/my-api".
 * @throws {SidekicksError} on read/write failure.
 */
export function removeService(absPath, relPath) {
  const obj = read(absPath);
  const services = Array.isArray(obj.services)
    ? obj.services.filter((s) => s !== relPath)
    : [];
  const updated = { ...obj, services };

  // Derive repoRoot: manifest.yaml -> projects/<name>/ -> projects/ -> repoRoot
  const repoRoot = dirname(dirname(dirname(absPath)));
  assertWritable(absPath, repoRoot);
  writeAtomic(absPath, serialize(updated));
}

/**
 * Atomically set the `remote_source` field in the manifest.
 *
 * @param {string} absPath - Absolute path to manifest.yaml.
 * @param {string} url     - The git URL to record.
 * @throws {SidekicksError} on read/write failure.
 */
export function setRemoteSource(absPath, url) {
  const obj = read(absPath);
  const updated = { ...obj, remote_source: url };

  // Derive repoRoot: manifest.yaml -> projects/<name>/ -> projects/ -> repoRoot
  const repoRoot = dirname(dirname(dirname(absPath)));
  assertWritable(absPath, repoRoot);
  writeAtomic(absPath, serialize(updated));
}

/**
 * Atomically append (or replace in place) a databases[] entry in the manifest.
 *
 * If an entry with the same (name, version) already exists, it is replaced at its
 * current index position (--force semantics, preserving list order). Otherwise the
 * entry is appended.
 *
 * Pattern mirrors addService / removeService.
 *
 * @param {string} absPath - Absolute path to manifest.yaml.
 * @param {object} entry   - The databases[] entry object to add or replace.
 * @throws {SidekicksError} on read/write failure or validation error.
 */
export function addDatabase(absPath, entry) {
  const obj = read(absPath);
  const databases = Array.isArray(obj.databases) ? [...obj.databases] : [];
  const idx = databases.findIndex((d) => d.name === entry.name && d.version === entry.version);
  if (idx >= 0) {
    databases[idx] = entry; // replace in place (--force semantics)
  } else {
    databases.push(entry);
  }
  const updated = { ...obj, databases };

  // Derive repoRoot: manifest.yaml -> projects/<name>/ -> projects/ -> repoRoot
  const repoRoot = dirname(dirname(dirname(absPath)));
  assertWritable(absPath, repoRoot);
  writeAtomic(absPath, serialize(updated));
}

/**
 * Atomically remove a databases[] entry by (name, version) from the manifest.
 *
 * Idempotent — a no-op (still rewrites) when the (name, version) pair is absent.
 * Pattern mirrors removeService.
 *
 * @param {string} absPath  - Absolute path to manifest.yaml.
 * @param {string} name     - The database name to remove.
 * @param {string} version  - The database version to remove.
 * @throws {SidekicksError} on read/write failure.
 */
export function removeDatabase(absPath, name, version) {
  const obj = read(absPath);
  const databases = Array.isArray(obj.databases)
    ? obj.databases.filter((d) => !(d.name === name && d.version === version))
    : [];
  const updated = { ...obj, databases };

  // Derive repoRoot: manifest.yaml -> projects/<name>/ -> projects/ -> repoRoot
  const repoRoot = dirname(dirname(dirname(absPath)));
  assertWritable(absPath, repoRoot);
  writeAtomic(absPath, serialize(updated));
}
