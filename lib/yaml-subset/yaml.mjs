// lib/yaml-subset/yaml.mjs
// Hand-rolled YAML subset parser/serializer.
// Zero npm dependencies — imports only from node:* builtins and the sanctioned errors.mjs back-edge.
// Handles: scalar strings/booleans/integers/floats/null, block mappings, block sequences,
//          inline comments, quoted strings (single + double), nested mappings, empty arrays.
// Explicitly rejects: YAML anchors/aliases, complex tags, multi-document streams.
// Does NOT handle: multi-line folded/literal scalars (|, >), flow mappings/sequences,
//                  merge keys (<<:), YAML 1.1 boolean variants (yes/no/on/off).

import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';

// ---------------------------------------------------------------------------
// Poison detection — the write-time mirror of rejectUnsupported (below)
// ---------------------------------------------------------------------------

// Constructs the pre-scan REJECTS on every RAW line — quoting does NOT protect
// (rejectUnsupported runs before quote extraction). Any writer that persists
// free text into a yaml-subset file must refuse these shapes up front, or it
// writes a file its own reader can never load again. Canonical list — the
// duplicate in _routines.mjs delegates here.
const POISON = [
  { re: /&\w/, what: "'&' followed by a word character", why: 'the yaml parser rejects anchors on read, even inside quotes' },
  { re: /\*\w/, what: "'*' followed by a word character", why: 'the yaml parser rejects aliases on read, even inside quotes' },
  { re: /!!|!<|!\w+\//, what: 'a YAML tag marker (!!, !<, or !word/)', why: 'the yaml parser rejects tags on read, even inside quotes' },
];

/**
 * Would this string value brick a yaml-subset file if serialized into it?
 * Returns { what, why } for the first poison shape found, or null when safe.
 */
export function findPoison(value) {
  const s = String(value ?? '');
  for (const p of POISON) {
    if (p.re.test(s)) return { what: p.what, why: p.why };
  }
  return null;
}

/**
 * Assert that already-serialized yaml text re-parses — the last-resort guard
 * for writers (a serialize→parse gate catches anything findPoison missed).
 * Throws SidekicksError(EXIT_VALIDATION) prefixed with `label` on failure.
 */
export function assertRoundTrips(text, label) {
  try {
    parse(text);
  } catch (err) {
    const first = String(err && err.message ? err.message : err).split('\n')[0];
    throw new SidekicksError(
      `${label}: serialized yaml does not re-parse: ${first} — refusing to write an unreadable file`,
      EXIT_VALIDATION
    );
  }
}

// ---------------------------------------------------------------------------
// Rejection guard — called once per line before parsing
// ---------------------------------------------------------------------------

/**
 * Throws SidekicksError(EXIT_VALIDATION) with a single-line message if the line
 * contains an unsupported YAML construct. Called for every non-blank non-comment line.
 *
 * @param {string} line     - the raw line text (including indentation)
 * @param {number} lineNum  - 1-based line number for the error message
 * @param {boolean} seenContent - whether any non-blank non-comment line was seen before this one
 */
function rejectUnsupported(line, lineNum, seenContent) {
  const stripped = line.trimStart();
  // The anchor/alias/tag checks below run on the line with any TRAILING COMMENT removed. They are
  // deliberately conservative regex scans, and a comment is prose: `# actual wait = base * 2**n`
  // reads as an alias, `# a & b` as an anchor. Rejecting a file because of a sentence in a comment
  // is a parser that punishes the one thing every config file is supposed to carry — and the
  // failure is opaque, because the reported construct is not in the data at all.
  //
  // A '#' inside quotes is not a comment, so the scan tracks quote state rather than using indexOf.
  let uncommented = line;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      uncommented = line.slice(0, i);
      break;
    }
  }

  // Multi-document stream: a "---" line that appears AFTER first content.
  // The very first "---" document-start marker (before any content) is tolerated.
  if (/^---(\s|$)/.test(stripped) && seenContent) {
    throw new SidekicksError(
      `YAML parse error at line ${lineNum}: multi-document stream (---) is not supported`,
      EXIT_VALIDATION
    );
  }

  // Anchors: "&anchor" at the start of a stripped line OR " &word" in the value part.
  // We detect "& followed by word char" anywhere in the line (outside of quoted strings
  // we do a conservative check — false positives here are acceptable as the manifest
  // schema never legitimately contains & in values).
  if (/&\w/.test(uncommented)) {
    throw new SidekicksError(
      `YAML parse error at line ${lineNum}: anchor (&) is not supported`,
      EXIT_VALIDATION
    );
  }

  // Aliases: "*word" — but NOT inside quoted strings. Conservative check: if the line
  // contains *<word-char> and is NOT a block-sequence item marker ("- "), raise.
  // We need to avoid false positives on URLs (https://...) — those have "/" not "*".
  // We check for *word (letter/digit/underscore immediately after *).
  if (/\*\w/.test(uncommented)) {
    throw new SidekicksError(
      `YAML parse error at line ${lineNum}: alias (*) is not supported`,
      EXIT_VALIDATION
    );
  }

  // Complex tags: "!!" or "!<" or "!word/" (e.g., !ruby/object).
  if (/!!|!<|!\w+\//.test(uncommented)) {
    throw new SidekicksError(
      `YAML parse error at line ${lineNum}: YAML tag (!) is not supported`,
      EXIT_VALIDATION
    );
  }
}

// ---------------------------------------------------------------------------
// Scalar coercion
// ---------------------------------------------------------------------------

/**
 * Coerce a bare (unquoted) scalar string to the appropriate JS type.
 * Per YAML 1.2 core schema:
 *   true / false → boolean
 *   null / ~ → null
 *   integer matching /^-?\d+$/ → number
 *   float matching /^-?\d+\.\d+$/ → number
 *   everything else → string
 *
 * @param {string} value - trimmed bare scalar string (no surrounding quotes)
 * @returns {string|boolean|number|null}
 */
function coerceScalar(value) {
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}

// ---------------------------------------------------------------------------
// Quoted string extraction
// ---------------------------------------------------------------------------

/**
 * If rawValue starts with a single or double quote, extract the quoted content
 * (stripping the surrounding quotes and unescaping basic sequences).
 * Returns { quoted: true, value: string } or { quoted: false } if not quoted.
 *
 * @param {string} rawValue - the raw value portion (after the ": " separator), trimmed
 * @returns {{ quoted: boolean, value?: string }}
 */
function extractQuotedString(rawValue) {
  if (rawValue.startsWith("'")) {
    // Single-quoted: no escape sequences; '' represents a literal single-quote.
    //
    // The closing quote is the first `'` that is NOT part of a `''` pair. Scanning for the first
    // `'` at all (which is what this did) ends the string ON the escape: `'the skill''s job'`
    // closed at the doubled pair and silently yielded "the skill", discarding the rest of the
    // value with no error anywhere. The `.replace(/''/g, "'")` below shows the intent was always
    // to support the escape; only the terminator search disagreed. Prose values are exactly where
    // apostrophes live, so this truncated authored reasons mid-sentence and left a shorter, still
    // plausible-looking sentence behind — the worst shape a data-loss bug can take.
    let end = -1;
    for (let i = 1; i < rawValue.length; i += 1) {
      if (rawValue[i] !== "'") continue;
      if (rawValue[i + 1] === "'") { i += 1; continue; }   // an escaped quote, keep scanning
      end = i;
      break;
    }
    if (end === -1) {
      // An unclosed quote is REFUSED, not relaxed. In this subset a quoted scalar always closes on
      // its own line, so the only ways to get here are a typo or a multi-line quoted scalar — and
      // the latter used to be accepted, truncated to its first line, after which the continuation
      // lines were re-read as structure and could destroy the enclosing mapping (a whole
      // `requires:` block vanished from a skill manifest this way, while `skill doctor` went on
      // reporting the manifest as present). Failing at authoring time is the only version of this
      // that anyone can act on.
      throw new SidekicksError(
        `YAML parse error: unterminated single-quoted string: ${rawValue.slice(0, 60)}`
        + ' — a quoted value must open and close on ONE line (this subset has no multi-line'
        + ' scalars); keep the value on a single line, however long',
        EXIT_VALIDATION
      );
    }
    return { quoted: true, value: rawValue.slice(1, end).replace(/''/g, "'") };
  }
  if (rawValue.startsWith('"')) {
    // Double-quoted: support \" and \\ escape sequences. The terminator is the first `"` that is
    // not backslash-escaped (the single-quoted note above applies here in its own spelling).
    let end = -1;
    for (let i = 1; i < rawValue.length; i += 1) {
      if (rawValue[i] === '\\') { i += 1; continue; }
      if (rawValue[i] === '"') { end = i; break; }
    }
    if (end === -1) {
      throw new SidekicksError(
        `YAML parse error: unterminated double-quoted string: ${rawValue.slice(0, 60)}`
        + ' — a quoted value must open and close on ONE line (this subset has no multi-line'
        + ' scalars); keep the value on a single line, however long',
        EXIT_VALIDATION
      );
    }
    return {
      quoted: true,
      value: rawValue.slice(1, end)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t'),
    };
  }
  return { quoted: false };
}

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/**
 * Strip trailing inline comment from an unquoted value part.
 * A comment is " #" (space then hash) followed by any text.
 * If the value is quoted, the # inside the quote is NOT a comment.
 *
 * @param {string} valuePart - the raw value portion after "key: " (not yet parsed)
 * @returns {string} - the value part with the inline comment stripped, trimmed
 */
function stripInlineComment(valuePart) {
  const trimmed = valuePart.trim();
  // If the value starts with a quote, don't strip anything (the comment, if any, is after
  // the closing quote — the extractQuotedString function handles that already).
  if (trimmed.startsWith("'") || trimmed.startsWith('"')) {
    return trimmed;
  }
  // Strip " #..." — a space before # is required to avoid stripping URLs like
  // "https://example.com/#anchor" (but those wouldn't appear as bare scalars anyway).
  const commentIdx = trimmed.indexOf(' #');
  if (commentIdx !== -1) {
    return trimmed.slice(0, commentIdx).trim();
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Core line-oriented parser
// ---------------------------------------------------------------------------

/**
 * Parse a YAML subset text into a JS value.
 * Only handles the subset required for manifest.yaml and service.yaml.
 *
 * @param {string} text - YAML text to parse
 * @returns {object|Array} - parsed JS value; empty input → {}
 * @throws {SidekicksError(EXIT_VALIDATION)} on unsupported constructs or parse errors
 */
export function parse(text) {
  if (typeof text !== 'string' || text.trim() === '') return {};

  // Normalize line endings first: a CRLF file (e.g. a repo cloned on Windows with
  // core.autocrlf, or an editor that writes \r\n) would otherwise leave a trailing
  // \r on every value — so `overrides: {}\r` fails the inline `{}` check and is
  // mis-parsed as the scalar string "{}". Collapse CRLF and lone CR to \n up front.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const n = lines.length;

  // seenContent: tracks whether we've seen at least one non-blank, non-comment content line.
  // Used to detect multi-document streams.
  let seenContent = false;

  // Pre-scan for unsupported constructs.
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    const stripped = line.trimStart();
    // Skip blank and comment-only lines for rejection checks.
    if (stripped === '' || stripped.startsWith('#')) continue;
    rejectUnsupported(line, i + 1, seenContent);
    seenContent = true;
  }

  // Reset for actual parsing.
  seenContent = false;

  // We use a recursive-descent approach driven by an index into the lines array.
  // `pos` is a shared mutable object so recursive calls can advance it.
  const pos = { i: 0 };

  /**
   * Skip blank and comment-only lines at the current position.
   */
  function skipBlanks() {
    while (pos.i < n) {
      const stripped = lines[pos.i].trimStart();
      if (stripped === '' || stripped.startsWith('#')) {
        pos.i++;
      } else {
        break;
      }
    }
  }

  /**
   * Get the indentation (leading space count) of a line.
   * @param {string} line
   * @returns {number}
   */
  function indentOf(line) {
    let count = 0;
    while (count < line.length && line[count] === ' ') count++;
    return count;
  }

  /**
   * Parse a scalar value from a raw value string.
   * Handles quoted strings and bare coercion.
   * @param {string} rawValue
   * @returns {string|boolean|number|null}
   */
  function parseScalarValue(rawValue) {
    const trimmedRaw = rawValue.trim();
    const q = extractQuotedString(trimmedRaw);
    if (q.quoted) return q.value;
    // Strip inline comment for bare scalars.
    const stripped = stripInlineComment(trimmedRaw);
    return coerceScalar(stripped);
  }

  /**
   * Parse a block mapping starting at the current position,
   * where all keys have indentation === `indent`.
   *
   * @param {number} indent - expected indentation level of keys in this mapping
   * @returns {object}
   */
  function parseMapping(indent) {
    const result = {};

    while (pos.i < n) {
      skipBlanks();
      if (pos.i >= n) break;

      const line = lines[pos.i];
      const lineIndent = indentOf(line);

      // Stop if we've gone back to a shallower indent level.
      if (lineIndent < indent) break;
      // Stop if at a different (deeper or same-but-different) indent that isn't ours.
      // For the top-level call indent=0, so lineIndent >= 0 always matches.
      if (lineIndent !== indent) break;

      const stripped = line.trimStart();

      // Block sequence item at this level — should not happen inside a mapping; bail.
      if (stripped.startsWith('- ') || stripped === '-') break;

      // Look for "key: " or "key:" pattern.
      // Keys can be quoted.
      let keyEnd = -1;
      let rawKey = '';
      if (stripped.startsWith("'") || stripped.startsWith('"')) {
        // Quoted key
        const q = extractQuotedString(stripped);
        rawKey = q.value ?? '';
        // Find the colon after the closing quote.
        // The quote ends at the 2nd occurrence of the quote char + rawKey.length + 2.
        const quoteChar = stripped[0];
        const closeQuote = stripped.indexOf(quoteChar, 1);
        keyEnd = closeQuote + 1; // position after closing quote
        // Expect ':' immediately or ': ' after.
        if (stripped[keyEnd] !== ':') {
          pos.i++;
          continue;
        }
      } else {
        // Bare key — ends at first ':' that is followed by space, newline, or end.
        const colonIdx = stripped.indexOf(':');
        if (colonIdx === -1) {
          // Not a key-value line — skip.
          pos.i++;
          continue;
        }
        rawKey = stripped.slice(0, colonIdx).trim();
        keyEnd = colonIdx;
      }

      const afterColon = stripped.slice(keyEnd + 1); // everything after ":"
      const valuePart = afterColon.trimStart();

      pos.i++; // consume this key line
      seenContent = true;

      // Determine what follows:
      if (valuePart === '' || valuePart.startsWith('#')) {
        // No inline value — look ahead for nested content.
        skipBlanks();
        if (pos.i < n) {
          const nextLine = lines[pos.i];
          const nextIndent = indentOf(nextLine);
          const nextStripped = nextLine.trimStart();

          if (nextIndent > indent && nextStripped.startsWith('- ')) {
            // Block sequence.
            result[rawKey] = parseSequence(nextIndent);
          } else if (nextIndent > indent && !nextStripped.startsWith('- ')) {
            // Nested mapping.
            result[rawKey] = parseMapping(nextIndent);
          } else {
            // Nothing nested — null value.
            result[rawKey] = null;
          }
        } else {
          result[rawKey] = null;
        }
      } else if (valuePart === '[]') {
        // Explicit empty sequence (inline form: `services: []`).
        result[rawKey] = [];
      } else if (valuePart === '{}') {
        // Explicit empty mapping (inline form: `overrides: {}`).
        result[rawKey] = {};
      } else {
        // Inline scalar or quoted value.
        result[rawKey] = parseScalarValue(valuePart);
      }
    }

    return result;
  }

  /**
   * Parse a block sequence starting at the current position,
   * where all `- ` items have indentation === `indent`.
   *
   * @param {number} indent - expected indentation of the sequence markers
   * @returns {Array}
   */
  function parseSequence(indent) {
    const result = [];

    while (pos.i < n) {
      skipBlanks();
      if (pos.i >= n) break;

      const line = lines[pos.i];
      const lineIndent = indentOf(line);

      if (lineIndent < indent) break;
      if (lineIndent !== indent) break;

      const stripped = line.trimStart();
      if (!stripped.startsWith('- ') && stripped !== '-') break;

      pos.i++; // consume the "- " line
      seenContent = true;

      if (stripped === '-') {
        // Empty item — null.
        result.push(null);
        continue;
      }

      const itemRaw = stripped.slice(2).trim(); // everything after "- "

      if (itemRaw === '' || itemRaw.startsWith('#')) {
        // Item value is on the next line(s) — look ahead for a nested mapping.
        skipBlanks();
        if (pos.i < n && indentOf(lines[pos.i]) > indent) {
          result.push(parseMapping(indentOf(lines[pos.i])));
        } else {
          result.push(null);
        }
      } else if (itemRaw.includes(':') && !itemRaw.startsWith("'") && !itemRaw.startsWith('"')) {
        // Inline mapping item: `- key: value`, possibly followed by sibling keys at
        // indent + 2 whose values may themselves be nested mappings or sequences.
        // Re-anchor the item line as a plain mapping line at indent + 2 and let
        // parseMapping handle the full value semantics — a scalar-only sibling loop
        // here used to silently terminate the sequence at the first nested block,
        // dropping every remaining item.
        pos.i--; // un-consume the "- " line
        lines[pos.i] = ' '.repeat(indent + 2) + itemRaw;
        result.push(parseMapping(indent + 2));
      } else {
        result.push(parseScalarValue(itemRaw));
      }
    }

    return result;
  }

  // Parse the top-level document.
  skipBlanks();
  if (pos.i >= n) return {};

  const firstLine = lines[pos.i];
  const firstIndent = indentOf(firstLine);
  const firstStripped = firstLine.trimStart();

  if (firstStripped.startsWith('- ') || firstStripped === '-') {
    // Top-level is a sequence.
    return parseSequence(firstIndent);
  } else {
    // Top-level is a mapping.
    return parseMapping(firstIndent);
  }
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Determine whether a string value can be emitted as a bare scalar
 * (no quoting required).
 *
 * A bare scalar is safe if:
 *   - it matches /^[a-zA-Z0-9 _\-\.\/\+\:@]+$/  (common URL/path/name chars)
 *   - AND it is not one of the reserved YAML literals: true, false, null, ~
 *   - AND it does not start with a special YAML character (-, #, &, *, !, etc.)
 *   - AND it does not contain "# " (which would be interpreted as a comment on re-parse)
 *
 * @param {string} s
 * @returns {boolean}
 */
function isBareScalarSafe(s) {
  if (s === '' || s === 'true' || s === 'false' || s === 'null' || s === '~') return false;
  if (/[^a-zA-Z0-9 _\-\.\/\+\:@]/.test(s)) return false;
  // Cannot start with '-' (would be parsed as a sequence item) or '#' (comment)
  if (s[0] === '-' || s[0] === '#') return false;
  // Prevent inline comment misparse
  if (s.includes(' #')) return false;
  // Prevent "key: value" misparse — a colon followed by a space is a YAML key separator
  if (s.includes(': ')) return false;
  // Prevent a trailing colon (would be parsed as a key with empty value)
  if (s.endsWith(':')) return false;
  return true;
}

/**
 * Serialize a scalar JS value to a YAML-safe string representation.
 *
 * @param {string|boolean|number|null} value
 * @returns {string}
 */
function serializeScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    // No trailing ".0" for integers stored as floats.
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === 'string') {
    if (isBareScalarSafe(value)) return value;
    // Double-quote wrap: escape internal double-quotes and backslashes.
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  // Fallback: coerce to string.
  return String(value);
}

/**
 * Serialize a JS object or array to a YAML subset string.
 * The output is always parseable by `parse()` (round-trip purity).
 *
 * @param {object|Array} value - the JS value to serialize
 * @param {number} [indent=0]  - current indentation level (spaces)
 * @returns {string}
 */
export function serialize(value, indent = 0) {
  const pad = ' '.repeat(indent);
  let out = '';

  if (Array.isArray(value)) {
    if (value.length === 0) {
      // Inline empty array — handled at the key level, but if called directly:
      return '[]\n';
    }
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        // Sequence of mappings.
        const entries = Object.entries(item);
        if (entries.length === 0) {
          out += `${pad}- {}\n`;
        } else {
          const [firstKey, firstVal] = entries[0];
          out += `${pad}- ${firstKey}: ${serializeScalar(firstVal)}\n`;
          for (let i = 1; i < entries.length; i++) {
            const [k, v] = entries[i];
            out += `${pad}  ${k}: ${serializeScalar(v)}\n`;
          }
        }
      } else {
        out += `${pad}- ${serializeScalar(item)}\n`;
      }
    }
    return out;
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      if (Array.isArray(val)) {
        if (val.length === 0) {
          // Inline empty array: `services: []`
          out += `${pad}${key}: []\n`;
        } else {
          out += `${pad}${key}:\n`;
          out += serialize(val, indent + 2);
        }
      } else if (val !== null && typeof val === 'object') {
        if (Object.keys(val).length === 0) {
          // Inline empty mapping: `overrides: {}`
          out += `${pad}${key}: {}\n`;
        } else {
          out += `${pad}${key}:\n`;
          out += serialize(val, indent + 2);
        }
      } else {
        out += `${pad}${key}: ${serializeScalar(val)}\n`;
      }
    }
    return out;
  }

  // Scalar at top level (unusual but handle gracefully).
  return `${serializeScalar(value)}\n`;
}
