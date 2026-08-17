// lib/config-store/block.mjs
// Reading ONE top-level block out of a configuration file, line by line.
//
// WHY NOT lib/yaml-subset/yaml.mjs HERE: that parser REJECTS a whole file when any line contains
// `&word` or `*word`, because in the manifest schema those can only be an anchor or an alias.
// A live scope config is different — those characters legitimately appear inside comments
// ("People & Blogs") and inside quoted passwords (`">V#8]&ye3o(:[8wO"`). Verified on this repo's
// own projects/*/config.yaml. Handing such a file to the strict parser would make a whole scope's
// configuration unreadable because of a character in a password, so this reads ONE top-level block
// line-by-line instead — never let a strict re-parse decide the fate of a live secrets file.
//
// MOVED HERE FROM lib/skill-config/resolve.mjs, which now re-exports these functions: the reader is
// shared by the resolver, the linter, the migrator and the writer, so it belongs to the store rather
// than to one of its callers. Behaviour is unchanged and pinned by tests/skill-config.test.mjs.
//
// Zero npm dependencies — node:* only.

import { existsSync, readFileSync } from 'node:fs';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';

/** Coerce a bare scalar the way YAML 1.2's core schema does. */
function coerce(raw) {
  const v = raw.trim();
  if (v === '' ) return '';
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

/** Parse a `key: value` value part: quoted string, inline empty map/list, or bare scalar. */
export function parseValue(rawValue) {
  const v = rawValue.trim();
  if (v.startsWith('"')) {
    const end = v.indexOf('"', 1);
    return end === -1 ? v.slice(1) : v.slice(1, end).replace(/\\"/g, '"');
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    return end === -1 ? v.slice(1) : v.slice(1, end).replace(/''/g, "'");
  }
  // Strip a trailing inline comment (" #..."), never a mid-token '#'. This happens BEFORE the
  // empty-collection test on purpose: `statuses: []   # none by default` is an empty LIST, and reading
  // it as the string "[]" — which is what testing first did — hands every consumer a two-character
  // string where it expects a collection. Found by `config migrate`'s equivalence check.
  const commentAt = v.indexOf(' #');
  const bare = commentAt === -1 ? v : v.slice(0, commentAt).trim();
  if (bare === '{}') return {};
  if (bare === '[]') return [];
  // A non-empty FLOW SEQUENCE is a list, and every full-YAML reader of these files (PyYAML in the
  // skills, lib/yaml-subset in the agent readers) sees one. Returning the raw string "[a, b]" instead
  // handed consumers a string where they tested Array.isArray — which is how `telegram.allowed_users:
  // [<id>]` normalised to an EMPTY allow-list while looking correct in the file.
  // Flow MAPPINGS stay strings on purpose: nothing in this repo writes one through the store, and the
  // agent readers reject them loudly (telegram.mjs looksLikeFlowMapping) rather than guessing.
  if (bare.length > 2 && bare.startsWith('[') && bare.endsWith(']')) {
    return splitFlowItems(bare.slice(1, -1)).map((item) => parseValue(item));
  }
  return coerce(bare);
}

/**
 * Split a flow sequence's inner text on top-level commas, honouring quotes and one level of nesting.
 * Quoted items keep their quotes here and are unwrapped by `coerce` (via parseValue's quote handling
 * in the caller's map), so `["a, b", c]` stays two items.
 *
 * @param {string} inner - the text between `[` and `]`
 * @returns {string[]} trimmed items, empty ones dropped
 */
function splitFlowItems(inner) {
  const items = [];
  let buf = '';
  let quote = null;
  let depth = 0;
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '[' || ch === '{') { depth += 1; buf += ch; continue; }
    if (ch === ']' || ch === '}') { depth -= 1; buf += ch; continue; }
    if (ch === ',' && depth === 0) { items.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  items.push(buf.trim());
  return items.filter((s) => s !== '');
}

/**
 * Parse an indented region into a nested object. `lines` are the block's child lines with their
 * original indentation.
 *
 * A `- ` sequence row carrying a MAPPING is parsed into an object, together with its deeper-indented
 * continuation lines. Keeping such a row as a raw scalar was silently LOSSY in both directions: only
 * the row's own line survived (`- id: default` + `bot_token: …` became the string "id: default", and
 * the token vanished), and a consumer testing `Array.isArray`/`row.id` got a string. Writing that
 * parse back through the writer is how the root `telegram:` block lost both of its lane tables and
 * both per-lane bot tokens during `config migrate` — the migration's equivalence gate could not see
 * it, because it compared the same lossy parse on both sides.
 *
 * A scalar row (`- ms_master`) stays a scalar. A row whose remainder is a FLOW mapping
 * (`- { bot: main }`) also stays a string on purpose — the agent readers reject that shape loudly
 * (telegram.mjs `looksLikeFlowMapping`) rather than guessing at it.
 *
 * @param {string[]} lines
 * @param {number} indent - the indentation of this level's keys
 * @returns {object|Array<any>}
 */
export function parseRegion(lines, indent) {
  /** @type {Record<string, any>} */
  const out = {};
  /** @type {string[]} */
  const seq = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent !== indent) continue; // deeper lines are consumed below; shallower cannot occur
    if (trimmed.startsWith('- ')) {
      const rest = trimmed.slice(2).trim();
      // Continuation lines of THIS row: everything indented deeper, up to the next row.
      const cont = [];
      let k = i + 1;
      for (; k < lines.length; k++) {
        const cl = lines[k];
        if (cl.trim() === '') { cont.push(cl); continue; }
        if (cl.length - cl.trimStart().length <= indent) break;
        cont.push(cl);
      }
      const isMappingRow = !rest.startsWith('{') && /^(?:"[^"]*"|'[^']*'|[^:#'"]+):(\s|$)/.test(rest);
      if (isMappingRow) {
        const firstReal = cont.find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
        // YAML puts the row's own key two columns in ('- key:'); trust a sibling's real indentation
        // when there is one, so an unusually indented file still parses as one item.
        const itemIndent = firstReal ? firstReal.length - firstReal.trimStart().length : indent + 2;
        seq.push(parseRegion([' '.repeat(itemIndent) + rest, ...cont], itemIndent));
      } else {
        seq.push(parseValue(rest));
      }
      i = k - 1;
      continue;
    }
    const m = trimmed.match(/^([^:]+):(.*)$/);
    if (!m) continue;
    const key = m[1].trim().replace(/^['"]|['"]$/g, '');
    const valuePart = m[2].trim();
    if (valuePart !== '' && !valuePart.startsWith('#')) {
      out[key] = parseValue(valuePart);
      continue;
    }
    // Nested region: every following line indented deeper than this key.
    const child = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const cl = lines[j];
      if (cl.trim() === '') { child.push(cl); continue; }
      const ci = cl.length - cl.trimStart().length;
      if (ci <= indent) break;
      child.push(cl);
    }
    const meaningful = child.filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    if (meaningful.length === 0) {
      out[key] = null; // a key whose body is entirely commented out carries no value
    } else {
      const childIndent = meaningful[0].length - meaningful[0].trimStart().length;
      out[key] = parseRegion(child, childIndent);
    }
    i = j - 1;
  }
  return seq.length && Object.keys(out).length === 0 ? seq : out;
}

/**
 * Extract one top-level block from a config file's text.
 *
 * @param {string} text
 * @param {string} block
 * @returns {object|null} null when the block is absent or carries no live value
 */
export function readBlock(text, block) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const header = new RegExp(`^${block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(header);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline === '{}') return {};
    if (inline !== '' && !inline.startsWith('#')) return null; // a scalar block is not a mapping
    const child = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') { child.push(line); continue; }
      if (/^\S/.test(line)) {
        if (line.startsWith('#')) continue; // a column-0 comment belongs to the NEXT block
        break;
      }
      child.push(line);
    }
    const meaningful = child.filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    if (meaningful.length === 0) return null; // header present, body fully commented ⇒ no value
    const indent = meaningful[0].length - meaningful[0].trimStart().length;
    const parsed = parseRegion(child, indent);
    return Array.isArray(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Read one block from a file, tolerating absence. A legacy alias is tried only after the canonical
 * name, so a scope carrying both is read the way its owning script reads it: canonical first.
 *
 * @param {string} abs
 * @param {string} label - repo-relative path, for the error message
 * @param {string} block
 * @param {string[]} [aliases]
 * @returns {object|null}
 */
export function blockFromFile(abs, label, block, aliases = []) {
  if (!existsSync(abs)) return null;
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new SidekicksError(
      `config: failed to read '${label}': ${err.message}`,
      EXIT_VALIDATION
    );
  }
  for (const name of [block, ...aliases]) {
    const found = readBlock(text, name);
    if (found !== null) return found;
  }
  return null;
}
