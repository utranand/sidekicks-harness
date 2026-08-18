// lib/catalog-lifecycle/_shared.mjs
// Shared primitives for the `sidekicks catalog …` verbs.
//
// Two jobs, and both exist for a reason the generated output depends on:
//
//   1. FLAG PARSING. The CLI's global parseArgs runs with `strict: false` and declares only the
//      three global booleans, so `--section cli` comes back as `{ section: true }` plus a stray
//      positional `cli` while `--section=cli` comes back as `{ section: 'cli' }`. Every verb family
//      that takes a valued flag therefore re-reads the raw argv where the value/boolean nature of
//      each flag is known (lib/skill-lifecycle/_shared.mjs, lib/framework-lifecycle/_shared.mjs,
//      lib/memory-lifecycle/_shared.mjs all do the same). A LOCAL copy rather than an import from
//      one of those: `package transfer` ships individual lib subsystems by import closure, and a
//      catalog that dragged skill-lifecycle in would carry the whole skill toolchain with it.
//
//   2. DETERMINISM HELPERS. The generated catalog is compared byte-for-byte against a regenerated
//      one, on macOS and on Windows, so nothing may reach it that varies by platform or locale:
//      `posix()` strips the native separator out of every path field, and `cmp()` sorts by code
//      point rather than `localeCompare` (whose collation depends on the ICU build in use).
//
// Zero npm dependencies — node:* only.

/**
 * Parse `--flag`, `--flag=value` and `--flag value` out of a raw argv slice.
 *
 * @param {string[]} argv - the raw argv the dispatcher was handed (ctx.argv)
 * @param {string[]} booleans - flags that never take a value
 * @returns {Record<string, string|boolean>}
 */
export function parseCatalogFlags(argv, booleans = []) {
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
 * A repo-relative path with POSIX separators, so the same catalog is generated on both platforms.
 *
 * @param {string|null|undefined} p
 * @returns {string|null}
 */
export function posix(p) {
  if (p === null || p === undefined || p === '') return null;
  return String(p).split('\\').join('/');
}

/**
 * Code-point comparison — the sort every catalog array uses.
 *
 * `localeCompare` is deliberately avoided: its result depends on the ICU data the running Node was
 * built with, which would make the generated file differ between two machines that agree on every
 * input. A code-point sort is the same everywhere.
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
