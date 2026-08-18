// lib/scope-lifecycle/_shared.mjs
// Shared primitives for the `sidekicks scope …` verbs.
//
// Three jobs, each one a thing a report contract depends on:
//
//   1. FLAG PARSING. The dispatcher's global parseArgs runs with `strict: false` and declares only
//      --help/--version/--verbose, so `--skill-id sk-commander` arrives at a verb as
//      `{ 'skill-id': true }` plus a stray positional `sk-commander`, while `--skill-id=sk-commander`
//      arrives as `{ 'skill-id': 'sk-commander' }`. Every verb family that takes a valued flag
//      therefore re-reads the raw argv, where the value/boolean nature of each flag is known
//      (lib/skill-lifecycle/_shared.mjs, lib/catalog-lifecycle/_shared.mjs and
//      lib/check-lifecycle/_shared.mjs all do the same). A LOCAL copy rather than an import from one
//      of those, for the reason catalog and check both give: `package transfer` ships individual lib
//      subsystems by import closure, and a scope verb that dragged skill-lifecycle in would carry
//      the whole skill toolchain with it.
//
//   2. PORTABLE PATHS. No artifact and no report may carry a machine-absolute path (CLAUDE.md,
//      *Portable artifact paths*). `repoRel()` turns any absolute path inside the repo into a
//      repo-relative POSIX path ('.' for the root itself), and `scrubRoot()` is the belt-and-braces
//      pass over rendered text, so a path that reached a message from a git or FS error — where this
//      module never got to format it — still cannot escape.
//
//   3. DETERMINISM. A report that is diffed between two runs, or between two machines, must order
//      identically: `cmp()` sorts by code point rather than `localeCompare`, whose collation depends
//      on the ICU build the running Node was compiled with.
//
// Zero npm dependencies — node:* only; macOS + Windows.

import { relative, sep } from 'node:path';

/**
 * Parse `--flag`, `--flag=value` and `--flag value` out of a raw argv slice.
 *
 * @param {string[]} argv - the raw argv the dispatcher was handed (ctx.argv)
 * @param {string[]} booleans - flags that never take a value
 * @returns {Record<string, string|boolean>}
 */
export function parseScopeFlags(argv, booleans = []) {
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
      i += 1;
    } else {
      out[body] = '';
    }
  }
  return out;
}

/**
 * The positionals of a raw argv slice, in order (flag VALUES excluded).
 *
 * The dispatcher's own positional list cannot be trusted here: with `strict: false` the value of a
 * space-form valued flag lands there too, so `scope explain --skill-id sk-commander` would otherwise
 * look like `scope explain <positional>`. Re-derived where the boolean set is known.
 *
 * @param {string[]} argv
 * @param {string[]} booleans
 * @returns {string[]}
 */
export function positionalArgs(argv, booleans = []) {
  const boolSet = new Set(booleans);
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      if (body.includes('=') || boolSet.has(body)) continue;
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('--')) i += 1; // consumed as this flag's value
      continue;
    }
    out.push(tok);
  }
  return out;
}

/**
 * A repo-relative POSIX path for an absolute path inside the repo. The repo root itself is '.'.
 *
 * Both separators are folded to '/' so the same report is produced on macOS and on Windows. A path
 * that is NOT inside the repo would relativize to something starting with '..'; that is returned as
 * given rather than invented, and callers that could hit it emit a finding instead.
 *
 * @param {string} repoRoot - absolute repo root
 * @param {string|null|undefined} abs
 * @returns {string|null}
 */
export function repoRel(repoRoot, abs) {
  if (abs === null || abs === undefined || abs === '') return null;
  const rel = relative(repoRoot, String(abs));
  if (rel === '') return '.';
  return rel.split(sep).join('/').split('\\').join('/');
}

/**
 * Replace every spelling of an absolute root with '.', in already-rendered text.
 *
 * The last line of defence for the portable-path rule: a message that came out of git, out of an FS
 * error, or out of a lib module this file never formatted can still carry the machine's own path.
 * Both the native form and the POSIX form are replaced, because a Windows path reaches a message as
 * `C:\repo` from `node:path` and as `C:/repo` from anything that normalized it first.
 *
 * Applied to VALUES, never to serialized JSON — see {@link deepScrub} for why that distinction is
 * load-bearing on Windows.
 *
 * @param {string} text
 * @param {string} repoRoot - absolute repo root
 * @returns {string}
 */
export function scrubRoot(text, repoRoot) {
  let out = String(text);
  const native = String(repoRoot);
  const posixForm = native.split('\\').join('/');
  for (const form of new Set([native, posixForm])) {
    if (!form) continue;
    // A separator or a string end must follow, so a SIBLING directory whose name merely starts with
    // the root's ('/tmp/x' vs '/tmp/xyz') is left alone instead of being mangled into './yz'.
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${escaped}[/\\\\]`, 'g'), '');
    out = out.replace(new RegExp(`${escaped}(?![A-Za-z0-9._~-])`, 'g'), '.');
  }
  return out;
}

/**
 * `scrubRoot` applied to every string in a structure, returning a copy.
 *
 * WHY THE MODEL AND NOT THE RENDERED JSON. Scrubbing the serialized JSON text would be a correctness
 * bug on Windows: `JSON.stringify` escapes each separator, so the document carries `C:\\repo\\lib`
 * while the root is spelled `C:\repo` — the literal never matches, and a scrub written to match the
 * ESCAPED form would cut a lone `\` out of an escape pair and emit invalid JSON. Scrubbing the values
 * first and serializing afterwards lets JSON.stringify escape whatever is left, correctly.
 *
 * Key names are left alone: they are authored identifiers, never paths.
 *
 * @template T
 * @param {T} value
 * @param {string} repoRoot - absolute repo root
 * @returns {T}
 */
export function deepScrub(value, repoRoot) {
  if (typeof value === 'string') return /** @type {any} */ (scrubRoot(value, repoRoot));
  if (Array.isArray(value)) return /** @type {any} */ (value.map((v) => deepScrub(v, repoRoot)));
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepScrub(v, repoRoot);
    return /** @type {any} */ (out);
  }
  return value;
}

/**
 * Code-point comparison — the sort every report array uses.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function cmp(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Sort a copy of `rows` by one string field, by code point.
 *
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => string} key
 * @returns {T[]}
 */
export function sortBy(rows, key) {
  return [...rows].sort((a, b) => cmp(key(a), key(b)));
}

/** A sorted, de-duplicated copy of a string list. */
export function uniqSorted(list) {
  return [...new Set((list || []).map((s) => String(s)))].sort(cmp);
}

/**
 * The SHAPE of a configuration value — never the value.
 *
 * `scope explain` reports what is configured, not what it is configured TO. Emitting a shape rather
 * than a value is what makes the no-credential-leak guarantee structural instead of a filter that
 * has to be right about which key names look like secrets: a credential stored under a key nothing
 * would recognise as one (`dsn`, `handle`, `b`) still cannot escape, because no value is ever
 * rendered. Nested containers are summarized at their own level and never descended into, so a
 * secret two levels down has no path to the output either.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function valueShape(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `list (${value.length})`;
  if (typeof value === 'object') return `mapping (${Object.keys(value).length} keys)`;
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  const len = String(value).length;
  return len === 0 ? 'string (empty)' : `string (len ${len})`;
}
