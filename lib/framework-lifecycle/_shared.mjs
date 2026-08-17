// lib/framework-lifecycle/_shared.mjs
// Shared helpers for the `sidekicks framework …` verbs: flag parsing and the one-line
// rendering used by list/show/doctor, so the three never describe a state differently.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { SidekicksError, EXIT_USAGE } from '../sk-cli/errors.mjs';

/**
 * Parse `--flag`, `--flag=value` and `--flag value` out of a raw argv slice.
 * Same shape as lib/memory-lifecycle/_shared.mjs parseMemoryFlags — the CLI's global
 * parseArgs runs with strict:false, so verb-local flags are re-read here where their
 * value/boolean nature is known.
 *
 * @param {string[]} argv
 * @param {string[]} booleans - flags that never take a value
 * @returns {Record<string, string|boolean>}
 */
export function parseFrameworkFlags(argv, booleans = []) {
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
 * Require the <id> positional.
 *
 * @param {string|undefined} id
 * @param {string} verb - e.g. 'framework show'
 * @returns {string}
 */
export function requireId(id, verb) {
  if (!id) {
    throw new SidekicksError(
      `${verb}: missing required argument <id> — run 'sidekicks framework list' to see the ids`,
      EXIT_USAGE
    );
  }
  return id;
}

/**
 * Human-readable state word for a resolved entry.
 *
 * @param {{enabled: boolean, floor: boolean}} r
 * @returns {string}
 */
export function stateWord(r) {
  if (r.floor) return 'enabled (floor)';
  return r.enabled ? 'enabled' : 'disabled';
}

/**
 * One aligned listing line: `<id>  <state>  [<source>]  owner: a, b`.
 *
 * @param {object} entry - registry entry
 * @param {{enabled: boolean, source: string, floor: boolean}} resolved
 * @param {number} idWidth
 * @returns {string}
 */
export function listLine(entry, resolved, idWidth) {
  const id = entry.id.padEnd(idWidth);
  const state = stateWord(resolved).padEnd(16);
  const from = `[${resolved.source}]`.padEnd(17);
  const owners = entry.owners && entry.owners.length ? `owner: ${entry.owners.join(', ')}` : '';
  return `${id}  ${state}  ${from}  ${owners}`.trimEnd();
}
