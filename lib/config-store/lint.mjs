// lib/config-store/lint.mjs
// Text-level checks on a scope configuration file. These run on the RAW text, never on a parsed
// value, because every defect they hunt is invisible after parsing:
//
//   - a duplicate top-level key silently last-wins in every YAML parser (PyYAML's safe_load
//     included), so by the time you hold an object the losing block is simply gone. This repo has
//     already paid for that once: two `teleport_cluster_ops:` blocks in projects/shp-sk/config.yaml
//     dropped `default_namespace: shph` from prod cluster-ops, recorded in the project memory entry
//     `shp-config-duplicate-top-level-keys`. Both blocks parse fine; only the text shows two.
//   - a credential in a COMMITTED file is a publish, and the pre-commit hook that catches it can
//     only see staged text.
//
// The line-splitting and block-boundary semantics — CRLF, a column-0 comment run belonging to the
// NEXT block, an indented comment being this block's own commented-out body — were once duplicated
// inside sk-hello so that skill stayed liftable, with tests pinning the two readings
// together. That copy is gone: the skill asks the CLI now, which is the only reading left.
//
// Zero npm dependencies — no imports at all, so a hook or a pre-commit shell-out can load this
// module alone.

/** A top-level `key:` line, the only shape a config block header may take. */
const TOP_LEVEL_KEY = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/;

/**
 * A `key: value` line at any indentation whose key looks like a credential.
 * Mirrors SECRET_KEY_RE in lib/skill-config/resolve.mjs and the grep in .githooks/pre-commit —
 * three places, one vocabulary.
 */
const SECRET_KEY_LINE =
  /^(\s*)([A-Za-z0-9_-]*(?:api_key|apikey|token|password|passwd|secret|pass)[A-Za-z0-9_-]*)\s*:(.*)$/i;

/** Values that mean "no credential here" — an empty or explicitly-null placeholder. */
const EMPTY_VALUE = /^(?:|""|''|null|~)$/;

/**
 * Normalize line endings and split. CRLF and lone-CR both occur in this repo's live configs
 * (Windows edits), and a check that reports a phantom `\r` in a key name is a check nobody trusts.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Every top-level key in the file, in order of appearance, with its 1-based line number.
 * A key appearing twice appears twice here — that is the point.
 *
 * @param {string} text
 * @returns {Array<{key: string, line: number}>}
 */
export function topLevelKeyLines(text) {
  const out = [];
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TOP_LEVEL_KEY);
    if (m) out.push({ key: m[1], line: i + 1 });
  }
  return out;
}

/**
 * Top-level keys declared more than once.
 *
 * @param {string} text
 * @returns {Array<{key: string, lines: number[]}>} sorted by first occurrence
 */
export function duplicateTopLevelKeys(text) {
  /** @type {Map<string, number[]>} */
  const seen = new Map();
  for (const { key, line } of topLevelKeyLines(text)) {
    const at = seen.get(key);
    if (at) at.push(line);
    else seen.set(key, [line]);
  }
  const dups = [];
  for (const [key, lines] of seen) {
    if (lines.length > 1) dups.push({ key, lines });
  }
  dups.sort((a, b) => a.lines[0] - b.lines[0]);
  return dups;
}

/**
 * Credential-shaped keys that carry an actual value, at any depth, with the top-level block they sit
 * under and the full key path to them. Commented lines are skipped: a commented `# api_token:` is
 * scaffold prose, not a leak.
 *
 * PUBLIC KEYS. The key-name vocabulary alone gets some keys wrong, and getting them wrong in this
 * direction is expensive: `cluster_ops.secret_name_map` holds AWS Secrets Manager PATHS and k8s Secret
 * NAMES — no values — under a 20-line rule comment written after a real prod mis-apply. Treating it as
 * a credential would move it (and the comment) out of git. So a block may declare `public_keys:`, and
 * a key named there is exempt TOGETHER WITH ITS WHOLE SUBTREE.
 *
 * @param {string} text
 * @param {{publicKeys?: Set<string>|((block: string|null) => Set<string>)}} [opts]
 * @returns {Array<{block: string|null, key: string, path: string[], line: number}>}
 */
export function secretValuedKeys(text, opts = {}) {
  const out = [];
  const lines = splitLines(text);
  let block = null;
  /** @type {Array<{indent: number, key: string}>} */
  let stack = [];

  const publicFor = (b) => {
    if (typeof opts.publicKeys === 'function') return opts.publicKeys(b) ?? new Set();
    return opts.publicKeys ?? new Set();
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const top = raw.match(TOP_LEVEL_KEY);
    if (top) {
      block = top[1];
      stack = [{ indent: -1, key: top[1] }];
    } else {
      const keyed = raw.match(/^(\s*)([A-Za-z0-9_."'-]+)\s*:/);
      if (keyed) {
        const indent = keyed[1].length;
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
        stack.push({ indent, key: keyed[2].replace(/['"]/g, '') });
      }
    }

    const m = raw.match(SECRET_KEY_LINE);
    if (!m) continue;
    // Strip a trailing inline comment before judging emptiness, never a mid-token '#'.
    let value = m[3].trim();
    const commentAt = value.indexOf(' #');
    if (commentAt !== -1) value = value.slice(0, commentAt).trim();
    if (EMPTY_VALUE.test(value)) continue;

    const path = stack.map((s) => s.key);
    const exempt = publicFor(block);
    // The block name itself never exempts; any key BETWEEN the block and this leaf does.
    if (path.slice(1).some((k) => exempt.has(k))) continue;
    out.push({ block: top ? null : block, key: m[2], path, line: i + 1 });
  }
  return out;
}

/**
 * Mask a resolved value for display. Never returns the value: the length is the most a reader may
 * learn, and it is enough to tell "configured" from "empty".
 *
 * A null/undefined value passes through AS null rather than as a mask string: there is nothing to
 * hide, and a consumer reading `--json` needs "not set" to stay distinguishable from "set to
 * something I am not being shown".
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function maskValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return '*** (nested)';
  const len = String(value).length;
  return len === 0 ? '"" (empty)' : `*** (len ${len})`;
}
