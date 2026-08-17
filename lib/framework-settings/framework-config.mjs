// lib/framework-settings/framework-config.mjs
// Reader/writer for the COMMITTED team-default layer of the framework enable map — the
// SETTINGS half of `.sidekicks/config/`.
//
// SETTINGS ARE NOT CONFIGURATION. Both live under a scope's `config/` directory, and until
// this split they lived in it the same way, which is why "where do I put this" had no
// obvious answer. They are governed differently:
//
//   settings       booleans only — is a rule / criterion / hook ON?
//                  .sidekicks/config/settings/{rules,criteria,hooks}.yaml
//                  written by `sidekicks framework enable|disable|sync`
//   configuration  values — tunables, endpoints, credentials
//                  .sidekicks/config/<family>.yaml (+ git-ignored <family>.secret.yaml)
//                  written by `sidekicks config set|sync|migrate`
//
// ONE FILE PER KIND, AND THE FILE'S TOP LEVEL *IS* THE SLUG MAP. `settings/rules.yaml`
// starts at `bmad-first: true` — there is no `rules:` wrapper, because the filename already
// said which kind these are. That is what makes the separation structural rather than
// cosmetic: you cannot put a criterion in rules.yaml without it looking wrong.
//
// THE MONOLITH IS STILL READ, ONE STEP LOWER. `.sidekicks/config/framework.yaml` (and, older
// still, `.sidekicks/framework.yaml`) carried all three blocks in one file. Both are read
// BELOW the split files, exactly the compatibility window `config.yaml` → family files uses,
// so an unmigrated checkout keeps resolving identically. `framework sync --split` migrates
// it and parks it as the git-ignored `pending-removal.framework.yaml`.
//
// WHY A COMMITTED FILE AND NOT settings.json: .sidekicks/settings.json is git-ignored
// (.gitignore) and per-machine, so an enable map living only there would not survive a
// clone or a `sidekicks package create` — and "the user may re-enable a moved rule any
// time" would be false for everyone but the machine that disabled it. settings.json keeps
// its documented role (per-machine pointers) and additionally carries an OPTIONAL
// per-machine `framework` override block, resolved above this file (see resolve.mjs).
//
// WRITES ARE LINE-LEVEL, NEVER parse+re-emit. Every one of these files is committed and
// documented: serializing a parsed object back over one would delete its comments. The same
// stance the skills' config handling already takes with a live config.yaml.
//
// Zero npm dependencies — node:fs/node:path + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { parse } from '../yaml-subset/yaml.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { frameworkConfigPath, CONFIG_DIR, SETTINGS_DIR } from '../config-store/paths.mjs';

// The pre-split monolith. Still READ (one layer below the per-kind files) so a checkout that has
// not migrated resolves identically; never written to any more.
export const FRAMEWORK_REL = join('.sidekicks', CONFIG_DIR, 'framework.yaml');
export const FRAMEWORK_EXAMPLE_REL = join('.sidekicks', CONFIG_DIR, 'framework.example.yaml');

/** The settings directory, repo-relative. Configuration values live one level up, beside it. */
export const SETTINGS_REL_DIR = join('.sidekicks', CONFIG_DIR, SETTINGS_DIR);

/** The three toggleable kinds and the settings block each one lives in. */
export const KIND_BLOCK = Object.freeze({
  rule: 'rules',
  criterion: 'criteria',
  hook: 'hooks',
});

export const BLOCKS = Object.freeze(['rules', 'criteria', 'hooks']);

/** Inverse of KIND_BLOCK — the kind an entry in a given block belongs to. */
export const BLOCK_KIND = Object.freeze({
  rules: 'rule',
  criteria: 'criterion',
  hooks: 'hook',
});

/** The per-kind settings file each block lives in, basename inside SETTINGS_REL_DIR. */
export const SETTINGS_FILES = Object.freeze({
  rules: 'rules.yaml',
  criteria: 'criteria.yaml',
  hooks: 'hooks.yaml',
});

/** Human title written into a settings file this code creates from scratch. */
const SETTINGS_TITLES = Object.freeze({
  rules: 'framework rules',
  criteria: 'behavioural criteria',
  hooks: 'wired hooks',
});

// `<kind>.<kebab-slug>` — e.g. rule.protected-branches, hook.office-viz.
const ID_RE = /^(rule|criterion|hook)\.([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/**
 * Split a framework id into its kind, settings block and slug.
 *
 * @param {string} id
 * @returns {{ id: string, kind: 'rule'|'criterion'|'hook', block: string, slug: string }}
 * @throws {SidekicksError} EXIT_VALIDATION when the id is malformed.
 */
export function parseId(id) {
  const m = typeof id === 'string' ? id.match(ID_RE) : null;
  if (!m) {
    throw new SidekicksError(
      `framework: invalid id '${id}' — expected <kind>.<kebab-slug> where kind is `
      + 'rule, criterion or hook (e.g. hook.office-viz)',
      EXIT_VALIDATION
    );
  }
  const kind = /** @type {'rule'|'criterion'|'hook'} */ (m[1]);
  return { id, kind, block: KIND_BLOCK[kind], slug: m[2] };
}

/**
 * Compose an id from a kind and a slug (inverse of parseId).
 *
 * @param {'rule'|'criterion'|'hook'} kind
 * @param {string} slug
 * @returns {string}
 */
export function makeId(kind, slug) {
  return `${kind}.${slug}`;
}

/**
 * Absolute path of the committed framework settings file.
 *
 * `.sidekicks/config/framework.yaml` is canonical; a checkout that still keeps the file at the old
 * top-level `.sidekicks/framework.yaml` is read (and written) there until it moves, so the relocation
 * needs no coordinated flag day.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function frameworkPath(repoRoot) {
  return frameworkConfigPath(repoRoot, 'framework.yaml');
}

/**
 * Read .sidekicks/framework.yaml.
 *
 * A missing file returns {} — never an error (fresh-clone equivalence: absent file means
 * "everything enabled", exactly like the pre-AAP-93 behaviour). An empty file is also {}.
 *
 * @param {string} repoRoot
 * @returns {object} parsed mapping (possibly {})
 * @throws {SidekicksError} EXIT_VALIDATION on unreadable/invalid YAML or a non-mapping top level.
 */
export function readFrameworkFile(repoRoot) {
  const abs = frameworkPath(repoRoot);
  if (!existsSync(abs)) return {};
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new SidekicksError(
      `framework: failed to read '${FRAMEWORK_REL}': ${err.message}`,
      EXIT_VALIDATION
    );
  }
  const parsed = parse(text); // throws SidekicksError(EXIT_VALIDATION) on invalid YAML
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SidekicksError(
      `framework: '${FRAMEWORK_REL}' top-level value must be a mapping`,
      EXIT_VALIDATION
    );
  }
  return parsed;
}

/**
 * Absolute path of one per-kind settings file.
 *
 * Unlike frameworkPath() there is no fallback here: this IS the canonical location. The monolith is
 * a separate, lower source (see committedSources) rather than an alternative spelling of this file.
 *
 * @param {string} repoRoot
 * @param {'rules'|'criteria'|'hooks'} block
 * @returns {string}
 */
export function settingsPath(repoRoot, block) {
  return join(repoRoot, SETTINGS_REL_DIR, SETTINGS_FILES[block]);
}

/**
 * The same path, repo-relative — for messages and for anything persisted (no machine-absolute
 * path may ever be written into an artifact).
 *
 * @param {'rules'|'criteria'|'hooks'} block
 * @returns {string}
 */
export function settingsRel(block) {
  return join(SETTINGS_REL_DIR, SETTINGS_FILES[block]);
}

/**
 * Read one per-kind settings file.
 *
 * The file's top level IS the slug map, so the result is validated through the same toggleMap()
 * every other layer uses by wrapping it in its block name first — one validator, one error shape.
 *
 * A missing file yields `{ present: false, map: {} }` and is never an error: with no settings files
 * at all every id resolves to the built-in default, which is fresh-clone equivalence.
 *
 * @param {string} repoRoot
 * @param {'rules'|'criteria'|'hooks'} block
 * @returns {{ present: boolean, map: Record<string, boolean>, rel: string }}
 */
export function readSettingsBlockFile(repoRoot, block) {
  const rel = settingsRel(block);
  const abs = settingsPath(repoRoot, block);
  if (!existsSync(abs)) return { present: false, map: {}, rel };
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new SidekicksError(
      `framework: failed to read '${rel}': ${err.message}`,
      EXIT_VALIDATION
    );
  }
  const parsed = parse(text); // throws SidekicksError(EXIT_VALIDATION) on invalid YAML
  if (parsed === null) return { present: true, map: {}, rel }; // an empty file has no opinion
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SidekicksError(
      `framework: '${rel}' top-level value must be a mapping of <slug>: true|false`,
      EXIT_VALIDATION
    );
  }
  return { present: true, map: toggleMap({ [block]: parsed }, block, rel), rel };
}

/**
 * Every committed source of the enable map, LOWEST precedence first.
 *
 * Two sources, in this order:
 *   1. the pre-split monolith (`config/framework.yaml`, or the older top-level file) — carries all
 *      three blocks under `rules:` / `criteria:` / `hooks:` keys
 *   2. the per-kind settings files — one file per block, top level is the slug map
 *
 * Returning them as an ordered list rather than a merged object is deliberate: the caller
 * validates the safety floor per source, so the error message can name the file that actually
 * carries the offending id instead of "the committed layer".
 *
 * @param {string} repoRoot
 * @returns {Array<{ label: string, blocks: Record<string, object>, kind: 'monolith'|'settings' }>}
 */
export function committedSources(repoRoot) {
  const out = [];

  const monolithAbs = frameworkPath(repoRoot);
  if (existsSync(monolithAbs)) {
    const rel = monolithAbs.startsWith(join(repoRoot, '.sidekicks', CONFIG_DIR))
      ? FRAMEWORK_REL
      : join('.sidekicks', 'framework.yaml');
    const parsed = readFrameworkFile(repoRoot);
    /** @type {Record<string, Record<string, boolean>>} */
    const blocks = {};
    // Normalised to the same shape the split files return, so every consumer can treat the two
    // sources identically instead of knowing which one it is holding.
    for (const block of BLOCKS) blocks[block] = toggleMap(parsed, block, rel);
    out.push({ label: rel, rel, blocks, kind: 'monolith' });
  }

  /** @type {Record<string, Record<string, boolean>>} */
  const split = { rules: {}, criteria: {}, hooks: {} };
  const labels = [];
  for (const block of BLOCKS) {
    const { present, map, rel } = readSettingsBlockFile(repoRoot, block);
    if (!present) continue;
    split[block] = map;
    labels.push(rel);
  }
  if (labels.length) {
    out.push({ label: labels.join(', '), rel: SETTINGS_REL_DIR, blocks: split, kind: 'settings' });
  }

  return out;
}

/**
 * Extract the toggle map for one block out of an already-parsed settings mapping,
 * validating that every value is a boolean.
 *
 * A block that is absent, null or `{}` yields {} — silence means "no opinion", which
 * resolves to the layer below.
 *
 * @param {object} parsed - a parsed framework.yaml / settings.json `framework` object
 * @param {string} block  - 'rules' | 'criteria' | 'hooks'
 * @param {string} label  - source label used in error messages
 * @returns {Record<string, boolean>}
 * @throws {SidekicksError} EXIT_VALIDATION on a non-mapping block or non-boolean value.
 */
export function toggleMap(parsed, block, label) {
  const raw = parsed ? parsed[block] : undefined;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SidekicksError(
      `framework: '${label}' field '${block}' must be a mapping of <slug>: true|false`,
      EXIT_VALIDATION
    );
  }
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const [slug, value] of Object.entries(raw)) {
    if (typeof value !== 'boolean') {
      throw new SidekicksError(
        `framework: '${label}' ${block}.${slug} must be true or false; got `
        + (value === null ? 'null' : typeof value),
        EXIT_VALIDATION
      );
    }
    out[slug] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line-level write
// ---------------------------------------------------------------------------

/**
 * Upsert `<block>: { <slug>: <value> }` into framework.yaml text, preserving every
 * existing line (comments included).
 *
 * Three cases, in order:
 *   1. the block exists and already carries the slug → the value on that line is replaced
 *   2. the block exists without the slug            → the entry is appended to the block
 *   3. the block does not exist                     → the block + entry are appended
 *
 * A block written as the inline empty mapping (`rules: {}`) is expanded in place.
 * Line endings are preserved: a file that uses CRLF keeps CRLF. The result always ends in
 * exactly one newline.
 *
 * @param {string} text  - current file text ('' for a new file)
 * @param {string} block - 'rules' | 'criteria' | 'hooks'
 * @param {string} slug
 * @param {boolean} value
 * @returns {string} the new file text
 */
export function upsertToggle(text, block, slug, value) {
  const crlf = /\r\n/.test(text);
  const eol = crlf ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n');
  // A file ending in a newline splits with a trailing '' — drop it (and any accumulated
  // blank tail) so the single trailing newline is added once, at the end, by every branch
  // below. Without this the writer would grow one blank line per write.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const blockRe = new RegExp(`^${block}\\s*:(.*)$`);
  const entryRe = new RegExp(`^(\\s+)${slug}\\s*:`);

  let blockAt = -1;
  let inlineEmpty = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(blockRe);
    if (m) {
      blockAt = i;
      inlineEmpty = m[1].trim() === '{}';
      break;
    }
  }

  const entryLine = `  ${slug}: ${value}`;

  if (blockAt === -1) {
    // Case 3 — append the block. Keep exactly one blank line before it when the file
    // already has content, and never leave a trailing blank run.
    const body = [...lines];
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    if (body.length) body.push('');
    body.push(`${block}:`, entryLine);
    return body.join(eol) + eol;
  }

  if (inlineEmpty) {
    // `rules: {}` → expand to a real block carrying the entry.
    const body = [...lines];
    body[blockAt] = `${block}:`;
    body.splice(blockAt + 1, 0, entryLine);
    return body.join(eol) + eol;
  }

  // Walk the block's own indented entries.
  let end = blockAt + 1;
  let found = -1;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue; // blank/comment: still inside
    if (!/^\s/.test(line)) break; // a new top-level key ends the block
    if (found === -1 && entryRe.test(line)) found = end;
  }

  const body = [...lines];
  if (found !== -1) {
    // Case 1 — replace the value, preserving the line's indentation.
    const indent = body[found].match(/^(\s*)/)[1];
    body[found] = `${indent}${slug}: ${value}`;
  } else {
    // Case 2 — insert after the block's last non-blank line so a trailing comment or
    // blank separator before the next top-level key is not swallowed.
    let insertAt = end;
    while (insertAt > blockAt + 1 && body[insertAt - 1].trim() === '') insertAt--;
    body.splice(insertAt, 0, entryLine);
  }
  return body.join(eol) + eol;
}

/**
 * Delete `<block>.<slug>` from framework.yaml text, preserving every other line.
 *
 * A slug the block does not carry (or a block that is absent) returns the text unchanged —
 * removal is idempotent. The block itself is kept even when it empties out, so the file keeps
 * its documented three-block shape (`rules:` with no entries parses as an empty block).
 *
 * @param {string} text
 * @param {string} block - 'rules' | 'criteria' | 'hooks'
 * @param {string} slug
 * @returns {string} the new file text
 */
export function removeToggle(text, block, slug) {
  if (text === '') return text;
  const crlf = /\r\n/.test(text);
  const eol = crlf ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const blockRe = new RegExp(`^${block}\\s*:(.*)$`);
  const entryRe = new RegExp(`^(\\s+)${slug}\\s*:`);

  let blockAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (blockRe.test(lines[i])) { blockAt = i; break; }
  }
  if (blockAt === -1) return text;

  for (let i = blockAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) break; // a new top-level key ends the block
    if (entryRe.test(line)) {
      lines.splice(i, 1);
      return lines.join(eol) + eol;
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Line-level write — per-kind settings files (top level IS the slug map)
// ---------------------------------------------------------------------------

/** The header a settings file this code creates from scratch carries. */
function settingsHeader(block) {
  const rel = settingsRel(block);
  return [
    `# ${rel} — which ${SETTINGS_TITLES[block]} are ON in this repo (COMMITTED, team default).`,
    '#',
    '# SETTINGS, not configuration: booleans only. Values — tunables, endpoints, credentials — live',
    `# in the family files one directory up (.sidekicks/${CONFIG_DIR}/<family>.yaml). See`,
    '# docs/guide/settings-vs-configuration.md.',
    '#',
    `# The top level IS the slug map: an entry is \`<slug>: true|false\`, and the ${BLOCK_KIND[block]}`,
    `# kind comes from the filename, so an id like \`${BLOCK_KIND[block]}.example-slug\` is written here`,
    '# as `example-slug`.',
    '#',
    '# Managed by `sidekicks framework enable|disable <id>` and materialised by `sidekicks framework',
    '# sync`. Never hand-edit it (Rule 1). An absent or empty file means "everything enabled" and is',
    '# never an error.',
    '#',
    '# Safety-floor ids cannot appear here (lib/framework-settings/floor.mjs) — writing one is a',
    '# validation error, not a silent no-op.',
    '',
  ].join('\n');
}

/**
 * Upsert `<slug>: <value>` at the TOP LEVEL of a settings file's text, preserving every existing
 * line (comments included).
 *
 * The block-scoped upsertToggle() above cannot serve here: these files have no `rules:` wrapper to
 * find, so "the block" is the whole document and entries carry no indentation.
 *
 * @param {string} text - current file text ('' for a new file)
 * @param {string} slug
 * @param {boolean} value
 * @returns {string}
 */
export function upsertTopLevelToggle(text, slug, value) {
  const crlf = /\r\n/.test(text);
  const eol = crlf ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const entryRe = new RegExp(`^${slug}\\s*:`);
  const entryLine = `${slug}: ${value}`;

  for (let i = 0; i < lines.length; i++) {
    if (entryRe.test(lines[i])) {
      lines[i] = entryLine;
      return lines.join(eol) + eol;
    }
  }
  lines.push(entryLine);
  return lines.join(eol) + eol;
}

/**
 * Delete a top-level `<slug>:` entry from a settings file's text. Idempotent: a slug the file does
 * not carry returns the text unchanged.
 *
 * @param {string} text
 * @param {string} slug
 * @returns {string}
 */
export function removeTopLevelToggle(text, slug) {
  if (text === '') return text;
  const crlf = /\r\n/.test(text);
  const eol = crlf ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const entryRe = new RegExp(`^${slug}\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (entryRe.test(lines[i])) {
      lines.splice(i, 1);
      return lines.join(eol) + eol;
    }
  }
  return text;
}

/**
 * Apply many toggle writes/removals to the per-kind settings files in ONE atomic write per file.
 *
 * The per-id path (writeToggle) re-reads and re-writes the file for every id, which is fine
 * for a single `framework enable` but wrong for a 50-id materialisation. Ops are applied in
 * order against the in-memory text, so the file is only ever seen by others complete.
 *
 * Callers MUST have refused floor ids first — a floor id present in the file is a validation
 * error at resolve time.
 *
 * @param {string} repoRoot
 * @param {Array<{ id: string, value?: boolean, remove?: boolean }>} ops
 * @returns {{ path: string, created: boolean, changed: number }}
 */
export function writeToggles(repoRoot, ops) {
  // Group by kind first: three files, at most three writes, regardless of how many ids.
  /** @type {Map<string, Array<{slug: string, value?: boolean, remove?: boolean}>>} */
  const byBlock = new Map();
  for (const op of ops) {
    const { block, slug } = parseId(op.id);
    if (!byBlock.has(block)) byBlock.set(block, []);
    byBlock.get(block).push({ slug, value: op.value, remove: op.remove });
  }

  const paths = [];
  let createdAny = false;
  let changed = 0;

  for (const [block, blockOps] of byBlock) {
    const abs = settingsPath(repoRoot, block);
    const created = !existsSync(abs);
    const before = created ? settingsHeader(block) : readFileSync(abs, 'utf8');
    let next = before;
    for (const op of blockOps) {
      next = op.remove
        ? removeTopLevelToggle(next, op.slug)
        : upsertTopLevelToggle(next, op.slug, op.value === true);
    }
    // No change means no write. For a file that does not exist yet, `before` is the header alone,
    // so this also stops `sync --prune` from CREATING a header-only file with no decision in it.
    if (next === before) continue;
    assertWritable(abs, repoRoot);
    writeAtomic(abs, next);
    paths.push(settingsRel(block));
    createdAny = createdAny || created;
    changed += blockOps.length;
  }

  // `path` stays a single string because every caller prints it; with the split there may be up to
  // three, so they are joined rather than silently reporting only the first.
  return {
    path: paths.length ? paths.join(', ') : SETTINGS_REL_DIR,
    paths,
    created: createdAny,
    changed,
  };
}

/**
 * Remove ids from the pre-split monolith, in ONE atomic write.
 *
 * `writeToggles` only ever touches the per-kind files, so pruning an id that a repo still carries
 * only in `config/framework.yaml` needs this. It writes nothing when the monolith is absent —
 * a migrated repo has nothing here to prune.
 *
 * @param {string} repoRoot
 * @param {string[]} ids
 * @returns {{ path: string|null, changed: number }}
 */
export function removeMonolithToggles(repoRoot, ids) {
  const abs = frameworkPath(repoRoot);
  if (!existsSync(abs) || ids.length === 0) return { path: null, changed: 0 };
  const before = readFileSync(abs, 'utf8');
  let next = before;
  for (const id of ids) {
    const { block, slug } = parseId(id);
    next = removeToggle(next, block, slug);
  }
  if (next === before) return { path: null, changed: 0 };
  assertWritable(abs, repoRoot);
  writeAtomic(abs, next);
  return { path: FRAMEWORK_REL, changed: ids.length };
}

/**
 * Write the toggle for `id` into its per-kind settings file (creating the file if absent).
 *
 * Callers MUST have refused floor ids first (resolve.mjs setEnabled does).
 *
 * @param {string} repoRoot
 * @param {string} id
 * @param {boolean} value
 * @returns {{ path: string, created: boolean }}
 */
export function writeToggle(repoRoot, id, value) {
  const { block, slug } = parseId(id);
  const abs = settingsPath(repoRoot, block);
  const created = !existsSync(abs);
  const current = created ? settingsHeader(block) : readFileSync(abs, 'utf8');
  const next = upsertTopLevelToggle(current, slug, value);
  assertWritable(abs, repoRoot);
  writeAtomic(abs, next);
  return { path: settingsRel(block), created };
}
