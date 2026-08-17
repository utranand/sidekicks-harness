// lib/artifacts-lifecycle/liveness-config.mjs
// Centralized configuration for the artifact-liveness watcher + the scan staleness threshold.
//
// The liveness inventory is a SINGLE repo-wide artifact (.sidekicks/artifacts-inventory.*),
// so its config is ROOT-ONLY — a dedicated file .sidekicks/agents-liveness.yaml, NOT a
// per-project block (there is nothing per-project to tune: one scan folds every scope into
// one file). The file carries a single `artifact_liveness:` block; top-level keys are also
// accepted as a forgiving fallback.
//
// A MISSING or unparseable file is never an error — it falls back to the built-in defaults
// (this is why a fresh clone works with no config). Zero npm dependencies: node:* + the
// repo's own yaml-subset parser. Works on macOS and Windows (path.join, CRLF-tolerant).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../yaml-subset/yaml.mjs';
import { frameworkConfigPath, CONFIG_DIR } from '../config-store/paths.mjs';
import { STALE_RUNNING_SECONDS } from './_manage.mjs';

// Repo-relative location of the dedicated config file (documented in agents-liveness.example.yaml).
export const LIVENESS_CONFIG_REL = `.sidekicks/${CONFIG_DIR}/agents-liveness.yaml`;

// Default watcher debounce — min seconds between automatic inventory refreshes. 60s is well
// under the staleness threshold, so the cache never lags in a way that matters.
export const DEFAULT_DEBOUNCE_SECONDS = 60;

/** Absolute path to the config file for a repo root. */
export function livenessConfigPath(repoRoot) {
  return frameworkConfigPath(repoRoot, 'agents-liveness.yaml');
}

/**
 * Resolve the effective liveness config for a repo, merging the file over the defaults.
 * Always returns a complete, validated object — never throws.
 *
 * @param {string} repoRoot
 * @returns {{ enabled: boolean, staleSeconds: number, debounceSeconds: number, source: 'file'|'default' }}
 */
export function readLivenessConfig(repoRoot) {
  const defaults = {
    enabled: true,
    staleSeconds: STALE_RUNNING_SECONDS,
    debounceSeconds: DEFAULT_DEBOUNCE_SECONDS,
    source: 'default',
  };
  const p = livenessConfigPath(repoRoot);
  let raw;
  try {
    if (!existsSync(p)) return defaults;
    raw = parse(readFileSync(p, 'utf8').replace(/\r\n?/g, '\n'));
  } catch {
    return defaults; // unparseable hand-edited file must never break the hook / scan
  }
  if (!raw || typeof raw !== 'object') return defaults;

  // Prefer the `artifact_liveness:` block; tolerate a flat file that omits the wrapper.
  const b = (raw.artifact_liveness && typeof raw.artifact_liveness === 'object')
    ? raw.artifact_liveness
    : raw;

  const stale = Number(b.stale_seconds);
  const debounce = Number(b.debounce_seconds);
  return {
    // enabled defaults true (always-on); only an explicit `false` opts out.
    enabled: b.enabled === false ? false : true,
    staleSeconds: Number.isFinite(stale) && stale > 0 ? stale : defaults.staleSeconds,
    debounceSeconds: Number.isFinite(debounce) && debounce >= 0 ? debounce : defaults.debounceSeconds,
    source: 'file',
  };
}
