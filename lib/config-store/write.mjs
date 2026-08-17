// lib/config-store/write.mjs
// The line-level writer for scope configuration files — the piece that did not exist before.
//
// WHY IT MATTERS. Rule 1 says the CLI mediates every structural write under `.sidekicks/` and
// `projects/`, yet until now the only writer for a scope config lived inside a SKILL
// (sk-hello's since-retired config-init.mjs), and every other change was a hand edit. That is how three
// duplicate top-level keys appeared in one project's config, and how a credential ends up in the
// wrong half of a split. `config set` and `config migrate` write through here.
//
// WHY LINE-LEVEL, NOT PARSE-AND-REEMIT. Same reason lib/framework-settings/framework-config.mjs works
// this way, doubled: (1) lib/yaml-subset's serializer drops every comment, and a live config is half
// comments — banners saying which skill reads a block, `# CONFIRM (handoff §B1)` notes, commented-out
// alternates; (2) its parser rejects a whole file on any `&word`/`*word`, which real passwords in this
// repo contain. So a write touches only the lines it must, and everything else — comments, ordering,
// CRLF — survives byte-for-byte.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { writeAtomic, writeSecretAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { duplicateTopLevelKeys } from './lint.mjs';

/** Keys whose values are credentials. One vocabulary, shared with lint.mjs and resolve.mjs. */
const SECRET_KEY_RE = /(api_key|apikey|token|password|passwd|secret|pass)/i;

/** Bare scalars that must be quoted, or they would parse as something else. */
const NEEDS_QUOTES = /^(?:|~|null|true|false|yes|no|on|off|-?\d+(?:\.\d+)?)$|^[\s&*#!|>%@`[{]|[:#]\s|\s$/i;

/**
 * Render one scalar the way this repo's configs spell it.
 *
 * QUOTE STYLE IS CHOSEN FOR THE READER, not for looks. The tolerant reader in block.mjs takes the
 * first closing quote it finds and does not honour backslash escapes, so a value containing a double
 * quote must be single-quoted or it will not read back as itself. This is not hypothetical: a config
 * in this repo writes flow mappings (`account1: { cdp_port: 9231, label: "x@y.com" }`), which the
 * reader hands back as the raw string `{ cdp_port: 9231, label: "x@y.com" }` — double-quoting that on
 * the way out changed the value, and `config migrate`'s equivalence check caught it.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function renderScalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const s = String(value);
  if (s === '') return '""';

  // A FLOW COLLECTION is emitted verbatim, unquoted. The tolerant reader in block.mjs does not parse
  // flow syntax and hands `[telegram, scheduler]` back as a raw string; quoting it on the way out would
  // round-trip fine through THIS reader while changing the file's meaning for every full-YAML one —
  // PyYAML would start seeing a string where it used to see a list. That is exactly how
  // `agent_tray.autostart` briefly lost all three of its members.
  if (/^\[[^\n]*\]$/.test(s.trim()) || /^\{[^\n]*\}$/.test(s.trim())) return s.trim();

  if (!NEEDS_QUOTES.test(s)) return s;
  const hasDouble = s.includes('"');
  const hasSingle = s.includes("'");
  if (hasDouble && !hasSingle) return `'${s}'`;
  if (!hasDouble) return `"${s}"`;
  // Both quote characters present: YAML's single-quote escape (doubling) is what the reader
  // implements, so that is the only form that survives a round trip.
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Render a value as the indented body lines of a block. Mappings nest; a list of scalars becomes a
 * block sequence; an empty mapping becomes `{}` on the parent's line (handled by the caller).
 *
 * @param {object} value
 * @param {number} depth - indentation level (1 = the block's own children)
 * @returns {string[]}
 */
export function renderBody(value, depth = 1) {
  const pad = '  '.repeat(depth);
  const out = [];
  for (const [key, v] of Object.entries(value)) {
    if (Array.isArray(v)) {
      if (!v.length) { out.push(`${pad}${key}: []`); continue; }
      out.push(`${pad}${key}:`);
      for (const item of v) {
        // A mapping ROW is written as `- k: v` plus its siblings aligned under the key — the shape
        // every reader here parses. Rendering it through renderScalar would stringify the object.
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const rows = renderBody(item, depth + 2);
          if (!rows.length) { out.push(`${pad}  - {}`); continue; }
          out.push(`${pad}  - ${rows[0].trim()}`);
          for (const row of rows.slice(1)) out.push(row);
          continue;
        }
        out.push(`${pad}  - ${renderScalar(item)}`);
      }
      continue;
    }
    if (v && typeof v === 'object') {
      if (!Object.keys(v).length) { out.push(`${pad}${key}: {}`); continue; }
      out.push(`${pad}${key}:`);
      out.push(...renderBody(v, depth + 1));
      continue;
    }
    out.push(`${pad}${key}: ${renderScalar(v)}`);
  }
  return out;
}

/**
 * Upsert one whole top-level block into a config file's text, preserving every other line.
 *
 * Three cases, in order:
 *   1. the block is absent           → it is appended, after one blank separator
 *   2. the block exists              → its body is replaced in place; the header line, and any
 *                                      comment banner above it, are kept
 *   3. the block exists inline (`x: {}`) → the header is normalized and the body inserted
 *
 * The block's textual extent stops before a trailing blank run and before a trailing column-0
 * comment run, because such a run is the banner of the NEXT block, never this block's tail — the
 * same boundary rule the readers use.
 *
 * Line endings are preserved; the result ends in exactly one newline.
 *
 * @param {string} text - current file text ('' for a new file)
 * @param {string} block
 * @param {object} value - the block's new body ({} writes `block: {}`)
 * @returns {string}
 */
export function upsertBlock(text, block, value) {
  const crlf = /\r\n/.test(text);
  const eol = crlf ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const body = Object.keys(value || {}).length ? renderBody(value, 1) : null;
  const headerLines = body ? [`${block}:`, ...body] : [`${block}: {}`];

  const headerRe = new RegExp(`^${block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:(.*)$`);
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { at = i; break; }
  }

  if (at === -1) {
    const out = [...lines];
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    if (out.length) out.push('');
    out.push(...headerLines);
    return out.join(eol) + eol;
  }

  // Find the end of the block's extent.
  let end = at + 1;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) {
      if (line.startsWith('#')) continue; // a column-0 comment belongs to the NEXT block
      break;
    }
  }
  // Walk back over the trailing blank / column-0-comment run so it stays with the next block.
  let stop = end;
  while (stop > at + 1) {
    const line = lines[stop - 1];
    if (line.trim() === '' || /^#/.test(line)) { stop--; continue; }
    break;
  }

  const out = [...lines.slice(0, at), ...headerLines, ...lines.slice(stop)];
  return out.join(eol) + eol;
}

/**
 * Remove one whole top-level block from a config file's text. Idempotent.
 *
 * @param {string} text
 * @param {string} block
 * @returns {string}
 */
export function removeBlock(text, block) {
  if (text === '') return text;
  const crlf = /\r\n/.test(text);
  const eol = crlf ? '\r\n' : '\n';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const headerRe = new RegExp(`^${block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:(.*)$`);
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { at = i; break; }
  }
  if (at === -1) return text;

  let end = at + 1;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) {
      if (line.startsWith('#')) continue;
      break;
    }
  }
  let stop = end;
  while (stop > at + 1) {
    const line = lines[stop - 1];
    if (line.trim() === '' || /^#/.test(line)) { stop--; continue; }
    break;
  }
  // Also drop the comment banner directly above the header — it documents the block being removed.
  let start = at;
  while (start > 0 && /^#/.test(lines[start - 1])) start--;
  const out = [...lines.slice(0, start), ...lines.slice(stop)];
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.length ? out.join(eol) + eol : '';
}

/**
 * Split a block's value into its non-secret and secret halves, keeping the nesting path of every
 * credential so the two files overlay cleanly.
 *
 * THE PLAIN HALF KEEPS AN EMPTY PLACEHOLDER for every credential it hands over (`api_token: ""`).
 * Without it a fresh clone would receive the committed family file and have no way to learn WHICH
 * credentials the block needs — the key name is structure, not a secret. An empty value is exempt
 * from both the pre-commit scan and `config doctor`, and the `.secret.yaml` sibling overrides it.
 *
 * PUBLIC KEYS. A key listed in the block's `public_keys` is NOT a credential however much its name
 * looks like one, and neither is anything beneath it. `cluster_ops.secret_name_map` is the case that
 * forced this: it maps services to AWS Secrets Manager paths and k8s Secret NAMES — no values — under
 * a rule comment written after a real prod mis-apply. Moving it into a git-ignored file would take
 * both the mapping and the warning out of git.
 *
 * @param {object} value
 * @param {string[]|Set<string>} [publicKeys]
 * @returns {{plain: object, secret: object}}
 */
/** Does this value hold a credential-shaped key anywhere beneath it (arrays included)? */
function containsSecret(value, exempt) {
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, exempt));
  if (!value || typeof value !== 'object') return false;
  for (const [key, v] of Object.entries(value)) {
    if (exempt.has(key)) continue;
    if (SECRET_KEY_RE.test(key)) return true;
    if (containsSecret(v, exempt)) return true;
  }
  return false;
}

/** A deep copy with every credential leaf emptied — the structure without the values. */
function blankSecrets(value, exempt) {
  if (Array.isArray(value)) return value.map((item) => blankSecrets(item, exempt));
  if (!value || typeof value !== 'object') return value;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (exempt.has(key)) { out[key] = v; continue; }
    if (SECRET_KEY_RE.test(key)) { out[key] = v && typeof v === 'object' ? {} : ''; continue; }
    out[key] = blankSecrets(v, exempt);
  }
  return out;
}

export function splitSecrets(value, publicKeys = []) {
  const exempt = publicKeys instanceof Set ? publicKeys : new Set(publicKeys);
  /** @type {Record<string, any>} */
  const plain = {};
  /** @type {Record<string, any>} */
  const secret = {};
  for (const [key, v] of Object.entries(value || {})) {
    if (exempt.has(key)) {
      plain[key] = v; // the whole subtree stays committed
      continue;
    }
    if (SECRET_KEY_RE.test(key)) {
      secret[key] = v;
      plain[key] = v && typeof v === 'object' ? {} : '';
      continue;
    }
    if (Array.isArray(v)) {
      // A SEQUENCE carrying credentials is handed over WHOLE, not element by element: the layers
      // overlay per key and a higher layer's array REPLACES the lower one, so a secret file holding
      // only `[{bot_token: …}]` would erase the ids beside it. The committed half keeps the same
      // sequence with every credential blanked, which is what makes the structure travel —
      // `telegram.bots[].bot_token` is the case that forced this; splitting arrays not at all meant a
      // per-lane bot token stayed in the COMMITTED file.
      if (containsSecret(v, exempt)) {
        secret[key] = v;
        plain[key] = blankSecrets(v, exempt);
      } else {
        plain[key] = v;
      }
      continue;
    }
    if (v && typeof v === 'object') {
      const nested = splitSecrets(v, exempt);
      if (Object.keys(nested.secret).length) secret[key] = nested.secret;
      // A mapping whose ONLY content was a credential still belongs in the plain file as an empty
      // mapping: the alias name is structure, not a secret, and dropping it would lose the fact that
      // the alias exists at all.
      plain[key] = nested.plain;
      continue;
    }
    plain[key] = v;
  }
  return { plain, secret };
}

/** The self-contained ignore rule every `config/` directory carries. */
export const SECRET_IGNORE_PATTERN = '*.secret.yaml';

/**
 * Is this the credential half of a family split?
 *
 * One predicate for the whole store, so "which files hold secrets" is answered in exactly one
 * place — the ignore rule, the permission decision and any future check all read the same
 * convention rather than three near-identical regexes.
 */
export function isSecretFileName(relPath) {
  return /\.secret\.yaml$/i.test(String(relPath).split('\\').join('/'));
}

const SECRET_IGNORE_FILE = [
  '# Committed on purpose, and it must stay committed: this is what keeps the credential half of',
  '# every family file out of git NO MATTER WHICH REPO this directory ends up in.',
  '#',
  '# The repo-root .gitignore cannot be relied on here. A project may be a git SUBMODULE with its own',
  '# ignore rules (projects/shp-sk, projects/workspace-sk) or a symlink to an out-of-tree directory —',
  '# in both cases the root rule does not apply and `git add config/` would have staged the secrets.',
  '# A .gitignore inside the directory travels with it.',
  SECRET_IGNORE_PATTERN,
  '',
].join('\n');

/**
 * Make sure a `config/` directory ignores its own secret files, whatever repo it belongs to.
 *
 * @param {string} repoRoot
 * @param {string} dirRel - repo-relative path of the config directory
 * @returns {{path: string, created: boolean, already: boolean}}
 */
export function ensureSecretIgnore(repoRoot, dirRel) {
  const rel = join(dirRel, '.gitignore');
  const abs = join(repoRoot, rel);
  if (existsSync(abs)) {
    const text = readFileSync(abs, 'utf8');
    const has = text.split(/\r?\n/).some((l) => l.trim() === SECRET_IGNORE_PATTERN);
    if (has) return { path: rel, created: false, already: true };
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    const next = (text.endsWith('\n') ? text : text + eol) + SECRET_IGNORE_PATTERN + eol;
    assertWritable(abs, repoRoot);
    writeAtomic(abs, next);
    return { path: rel, created: false, already: false };
  }
  mkdirSync(dirname(abs), { recursive: true });
  assertWritable(abs, repoRoot);
  writeAtomic(abs, SECRET_IGNORE_FILE);
  return { path: rel, created: true, already: false };
}

/** Filename prefix for the retired pre-family monolith, and the ignore rule that covers it. */
export const PENDING_PREFIX = 'pending-removal.';
const PENDING_IGNORE_PATTERN = 'pending-removal.*';

const PENDING_IGNORE_NOTE = [
  '',
  '# The pre-family monolith, kept for one release as a rollback reference after',
  '# `sidekicks config migrate` proved every block resolves identically. It still holds every',
  '# credential the split moved into the .secret.yaml siblings, so it is ignored just as hard.',
  '# Nothing reads it any more: the store reads <scope>/config.yaml and config/<family>.yaml,',
  '# and this name matches neither.',
  PENDING_IGNORE_PATTERN,
  '',
].join('\n');

/**
 * Make sure a `config/` directory also ignores the retired monolith it is about to receive.
 *
 * @param {string} repoRoot
 * @param {string} dirRel
 * @returns {{path: string, already: boolean}}
 */
export function ensurePendingIgnore(repoRoot, dirRel) {
  const rel = join(dirRel, '.gitignore');
  const abs = join(repoRoot, rel);
  const text = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  if (text.split(/\r?\n/).some((l) => l.trim() === PENDING_IGNORE_PATTERN)) {
    return { path: rel, already: true };
  }
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const next = (text === '' || text.endsWith('\n') ? text : text + eol)
    + PENDING_IGNORE_NOTE.split('\n').join(eol);
  mkdirSync(dirname(abs), { recursive: true });
  assertWritable(abs, repoRoot);
  writeAtomic(abs, next);
  return { path: rel, already: false };
}

/**
 * Write one block into a config file, creating the file (and its directory) when absent.
 *
 * Refuses to write a file that would end up with a duplicate top-level key — the writer must never
 * create the defect the doctor exists to catch.
 *
 * @param {string} repoRoot
 * @param {string} relPath - repo-relative
 * @param {string} block
 * @param {object} value
 * @param {{header?: string[]}} [opts] - comment banner for a NEW file
 * @returns {{path: string, created: boolean, text: string}}
 */
export function writeBlock(repoRoot, relPath, block, value, opts = {}) {
  const abs = join(repoRoot, relPath);
  const created = !existsSync(abs);
  let text = created ? '' : readFileSync(abs, 'utf8');
  if (created && opts.header && opts.header.length) {
    text = opts.header.join('\n') + '\n';
  }
  const next = upsertBlock(text, block, value);
  const dups = duplicateTopLevelKeys(next);
  if (dups.length) {
    throw new SidekicksError(
      `config: writing '${block}' into '${relPath}' would leave a duplicate top-level key `
      + `(${dups.map((d) => `${d.key} at lines ${d.lines.join(', ')}`).join('; ')}) — resolve the `
      + 'existing duplication first',
      EXIT_VALIDATION
    );
  }
  mkdirSync(dirname(abs), { recursive: true });
  assertWritable(abs, repoRoot);
  // The `.secret.yaml` half is where every credential lives, and it was being written at the
  // umask default — 0644, readable by any other account on the machine. Git-ignore keeps it out
  // of a commit and says nothing about local read access. The committed half deliberately keeps
  // ordinary permissions: it carries structure with empty credential keys, and locking it down
  // would only make the repo awkward to share for no gain. The filename is the discriminator
  // because it is the contract every reader already relies on (SECRET_IGNORE_PATTERN).
  if (isSecretFileName(relPath)) writeSecretAtomic(abs, next);
  else writeAtomic(abs, next);
  return { path: relPath, created, text: next };
}
