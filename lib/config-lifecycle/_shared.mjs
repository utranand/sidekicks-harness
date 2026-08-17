// lib/config-lifecycle/_shared.mjs
// Shared helpers for the `sidekicks config …` verbs: flag parsing, redaction, and the one-line
// rendering list/get/where use, so the three never describe the same state differently.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { SidekicksError, EXIT_USAGE } from '../sk-cli/errors.mjs';
import { SECRET_KEY_RE } from '../skill-config/resolve.mjs';
import { maskValue } from '../config-store/lint.mjs';

/**
 * Parse `--flag`, `--flag=value` and `--flag value` out of a raw argv slice.
 * Same shape as lib/framework-lifecycle/_shared.mjs parseFrameworkFlags — the CLI's global parseArgs
 * runs with strict:false, so verb-local flags are re-read here where their nature is known.
 *
 * @param {string[]} argv
 * @param {string[]} booleans - flags that never take a value
 * @returns {Record<string, string|boolean>}
 */
export function parseConfigFlags(argv, booleans = []) {
  /** @type {Record<string, string|boolean>} */
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
    if (boolSet.has(body)) {
      out[body] = true;
      continue;
    }
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[body] = next;
      i++;
    } else {
      out[body] = '';
    }
  }
  return out;
}

/**
 * Require the <block> positional.
 *
 * @param {string|undefined} block
 * @param {string} verb - e.g. 'config get'
 * @returns {string}
 */
export function requireBlock(block, verb) {
  if (!block) {
    throw new SidekicksError(
      `${verb}: missing required argument <block> — run 'sidekicks config list' to see the blocks`,
      EXIT_USAGE
    );
  }
  return block;
}

/**
 * Replace credential-shaped values with a mask, at any depth. Returns a copy.
 *
 * @param {any} value
 * @param {boolean} [keyIsSecret] - the enclosing key already matched
 * @returns {any}
 */
export function redact(value, keyIsSecret = false, publicKeys = []) {
  if (keyIsSecret) return maskValue(value);
  if (Array.isArray(value)) {
    // A SEQUENCE is walked, not returned whole: `telegram.bots` is a list of lane mappings, each with
    // its own `bot_token`, and stopping at the array printed every one of them in clear text.
    return value.map((item) => redact(item, false, publicKeys));
  }
  if (!value || typeof value !== 'object') return value;
  const exempt = publicKeys instanceof Set ? publicKeys : new Set(publicKeys);
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    // A key the block declares public is not a credential, and neither is its subtree — that is why
    // the recursion stops here instead of descending with the exempt set.
    if (exempt.has(key)) { out[key] = v; continue; }
    out[key] = redact(v, SECRET_KEY_RE.test(key), exempt);
  }
  return out;
}

/** The reminder printed whenever anything was masked. */
export const MASK_NOTE = '(credential-shaped values are masked — pass --reveal to print them)';

/**
 * Did redaction change anything? Used to decide whether to print MASK_NOTE.
 *
 * @param {object} obj
 * @returns {boolean}
 */
export function hasSecretKey(obj, publicKeys = []) {
  if (Array.isArray(obj)) return obj.some((item) => hasSecretKey(item, publicKeys));
  if (!obj || typeof obj !== 'object') return false;
  const exempt = publicKeys instanceof Set ? publicKeys : new Set(publicKeys);
  for (const [key, value] of Object.entries(obj)) {
    if (exempt.has(key)) continue;
    if (SECRET_KEY_RE.test(key)) return true;
    if (hasSecretKey(value, exempt)) return true;
  }
  return false;
}

/**
 * Read one dotted key path out of a resolved config object.
 *
 * @param {object} config
 * @param {string} path - e.g. 'shp.jira_url'
 * @returns {{found: boolean, value: any}}
 */
export function pluck(config, path) {
  let cursor = config;
  for (const part of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || !(part in cursor)) return { found: false, value: undefined };
    cursor = cursor[part];
  }
  return { found: true, value: cursor };
}
