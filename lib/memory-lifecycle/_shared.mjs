// lib/memory-lifecycle/_shared.mjs
// Shared helpers for the `sidekicks memory` verbs.
// NOT a dispatchable verb (no VERBS entry) — the dispatcher only resolves
// lib/memory-lifecycle/<verb>.mjs for entries in the VERBS table.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
import {
  resolveAgentMemoryDir,
  storeRoot,
  namespaceDir,
  humanIndexPath,
} from '../active-scope/memory-paths.mjs';

// Slug pattern — same shape the manifest uses for names.
export const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Current time as an ISO-8601 string with the Asia/Bangkok (+07:00) offset.
 * Same convention as lib/schema-extractor/extractor.mjs / stamp.mjs.
 * @returns {string} e.g. "2026-06-25T15:30:00+07:00"
 */
export function bangkokTimestamp() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((p) => [p.type, p.value])
  );
  // hour12:false can yield "24" at midnight in some ICU builds — normalize to "00".
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}+07:00`;
}

// Valid entry types. `rule` is sugar: it stores as type `convention` + `rule: true`,
// so a stale checkout that knows only the original four still reads the entry.
export const ENTRY_TYPES = ['decision', 'context', 'reference', 'convention', 'rule'];

/**
 * The ACTION CATEGORY an entry serves — the unit a scenario pack loads and a trigger
 * fires on. Fixed starter set; `.sidekicks/memory/triggers.yaml` may name more.
 * An unknown category WARNS, never fails: a stale checkout must still read the store.
 */
export const MEMORY_CATEGORIES = [
  'implementation',
  'database',
  'jira',
  'deploy',
  'cluster',
  'agents',
  'framework',
  'general',
];

/** Category assigned when an entry declares none (every pre-central entry). */
export const DEFAULT_CATEGORY = 'general';

/** Typed graph-edge relations (§4.6). */
export const LINK_RELS = ['derived-from', 'supersedes', 'relates', 'applies-to', 'blocks'];

/**
 * Durable lineage anchor forms. `artifacts/runs/…` is deliberately absent: runs are a
 * TEMPORARY surface (cleaned, re-anchored, per-machine), so a pointer into one is a
 * dangling reference waiting to happen. Decisive run content is snapshotted into
 * `evidence/` at add time instead.
 */
export const SOURCE_FORMS = 'commit:<sha> | journal:<id> | evidence/… | a committed repo-relative path';

/**
 * Validate an entry slug; throw EXIT_VALIDATION on a bad slug.
 * @param {string} name
 * @returns {string} the validated slug
 */
export function validateSlug(name) {
  if (!name || typeof name !== 'string') {
    throw new SidekicksError(
      'memory: an entry <name> is required',
      EXIT_VALIDATION
    );
  }
  if (!SLUG_RE.test(name)) {
    throw new SidekicksError(
      `memory: invalid entry name '${name}' — must be kebab-case matching ${SLUG_RE.source}`,
      EXIT_VALIDATION
    );
  }
  return name;
}

/**
 * Parse memory-verb flags from the raw argv, supporting BOTH `--key=value`
 * and `--key value` forms (the cli.mjs parser only handles `--key=value`
 * reliably, so we re-parse here — see the known flag-collision gotcha).
 *
 * Boolean flags (no value consumed): those listed in `booleans`.
 * Every other `--key` consumes the following token as its value (unless the
 * next token starts with `--`, in which case the flag is treated as present
 * with an empty string value).
 *
 * @param {string[]} argv - the full argv list (ctx.argv).
 * @param {string[]} [booleans=[]] - flag names that take no value.
 * @returns {Record<string, string|boolean>}
 */
export function parseMemoryFlags(argv, booleans = []) {
  const out = {};
  const boolSet = new Set(booleans);
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string' || !tok.startsWith('--')) continue;
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      // --key=value form
      const key = body.slice(0, eq);
      const val = body.slice(eq + 1);
      out[key] = boolSet.has(key) ? true : val;
      continue;
    }
    // --key  (boolean) or --key value (space form)
    const key = body;
    if (boolSet.has(key)) {
      out[key] = true;
      continue;
    }
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = '';
    }
  }
  return out;
}

/**
 * Resolve the `--agent <name>` memory layer, validating the agent exists
 * (its charter at .sidekicks/agents/<name>/agent.yaml). Charter existence is
 * checked here directly — importing agent-lifecycle would create an import
 * cycle (agent-lifecycle already imports this module).
 *
 * @param {string} repoRoot
 * @param {string} agentName
 * @returns {ReturnType<typeof resolveAgentMemoryDir>}
 * @throws {SidekicksError(EXIT_NOT_FOUND)} when no such agent exists.
 */
export function requireAgentLayer(repoRoot, agentName) {
  const name = String(agentName);
  if (!SLUG_RE.test(name)) {
    throw new SidekicksError(
      `memory: invalid --agent '${name}' — must be kebab-case matching ${SLUG_RE.source}`,
      EXIT_VALIDATION
    );
  }
  const charter = join(repoRoot, '.sidekicks', 'agents', name, 'agent.yaml');
  if (!existsSync(charter)) {
    throw new SidekicksError(
      `memory: no agent named '${name}' — create one first with 'sidekicks agent create ${name} ...'`,
      EXIT_NOT_FOUND
    );
  }
  return resolveAgentMemoryDir(repoRoot, name);
}

/**
 * Build the entry-file content (frontmatter + body).
 *
 * @param {object} p
 * @param {string} p.name        - slug
 * @param {string} p.description - one-line summary
 * @param {string} p.type        - entry type
 * @param {string} p.created     - ISO 8601 timestamp (+07:00)
 * @param {string} p.body        - prose body (markdown, NOT YAML)
 * @returns {string}
 */
export function buildEntryFile({ name, description, type, created, body, category, rule, source, links }) {
  // `type: rule` is sugar — it stores as convention + rule:true so a checkout that
  // knows only the original four types still reads the entry.
  const storedType = type === 'rule' ? 'convention' : type;
  const isRule = rule === true || type === 'rule';

  // Every new key is OMITTED when absent, so an add that passes none produces the
  // exact bytes the pre-central builder produced. That is what keeps the adopted
  // root entries valid without touching a single file.
  const metadata = { type: storedType, created };
  if (category) metadata.category = category;
  if (isRule) metadata.rule = true;
  if (source) metadata.source = source;
  if (Array.isArray(links) && links.length) {
    metadata.links = links.map((l) => ({ rel: l.rel, to: l.to }));
  }

  // Frontmatter via the existing YAML-subset serializer (single-line values only;
  // block scalars are not folded inside a sequence item, so links stay short scalars).
  const fm = yaml.serialize({ name, description, metadata });
  // A sequence-of-mappings is the one shape here the serializer could round-trip
  // wrong — prove it before the bytes reach disk (same guard writeCharter uses).
  yaml.assertRoundTrips(fm, `memory entry '${name}' frontmatter`);
  // fm ends with a trailing newline. Compose: ---\n<fm>---\n\n<body>\n
  const bodyText = (body ?? '').replace(/\s+$/, '');
  return `---\n${fm}---\n\n${bodyText}\n`;
}

/**
 * Validate an action category. Unknown categories WARN rather than fail — the whole
 * point of the warn-not-fail choice is that a checkout predating a new category must
 * still read every entry.
 *
 * @param {string|undefined} category
 * @param {string[]} [known=MEMORY_CATEGORIES]
 * @returns {{ category: string, warning: string|null }}
 */
export function validateCategory(category, known = MEMORY_CATEGORIES) {
  const c = (category == null || category === '') ? DEFAULT_CATEGORY : String(category);
  if (!SLUG_RE.test(c)) {
    throw new SidekicksError(
      `memory: invalid --category '${c}' — must be kebab-case matching ${SLUG_RE.source}`,
      EXIT_VALIDATION
    );
  }
  if (known.includes(c)) return { category: c, warning: null };
  return {
    category: c,
    warning: `warning: unknown category '${c}' — known: ${known.join(', ')} `
      + `(recorded anyway; declare it in .sidekicks/memory/triggers.yaml to make it fire)`,
  };
}

/**
 * Validate a lineage anchor. REFUSES the two forms that do not survive:
 *   - anything under `artifacts/runs/` — a temporary surface, cleaned and re-anchored
 *   - a machine-absolute path — never portable (CLAUDE.md portable-paths rule)
 *
 * @param {string|undefined} source
 * @returns {string|null} the validated source, or null when none was given
 */
export function validateSource(source) {
  if (source == null || source === '') return null;
  const s = String(source).trim();
  if (/^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(s)) {
    throw new SidekicksError(
      `memory: --source '${s}' is a machine-absolute path — lineage must be portable. `
        + `Use one of: ${SOURCE_FORMS}`,
      EXIT_VALIDATION
    );
  }
  if (/(^|\/)artifacts\/runs\//.test(s.replace(/\\/g, '/'))) {
    throw new SidekicksError(
      `memory: --source '${s}' points into artifacts/runs/ — a TEMPORARY surface, so the `
        + `pointer dangles the moment the run folder is cleaned. Pass --snapshot <path> instead: `
        + `it copies the decisive content into the store's evidence/ folder and anchors there. `
        + `Durable forms: ${SOURCE_FORMS}`,
      EXIT_VALIDATION
    );
  }
  return s;
}

/**
 * Parse a repeatable `--link <rel>:<slug>` flag value into edge records.
 * Accepts a single string or an array (parseMemoryFlags keeps the last value, so
 * callers collect repeats from argv themselves — see collectLinkFlags).
 *
 * @param {string} raw - e.g. "derived-from:shph-bulk-update-lesson"
 * @returns {{ rel: string, to: string }}
 */
export function parseLink(raw) {
  const s = String(raw ?? '');
  const idx = s.indexOf(':');
  if (idx <= 0) {
    throw new SidekicksError(
      `memory: invalid --link '${s}' — expected <rel>:<slug>, rel one of: ${LINK_RELS.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  const rel = s.slice(0, idx);
  const to = s.slice(idx + 1);
  if (!LINK_RELS.includes(rel)) {
    throw new SidekicksError(
      `memory: invalid link relation '${rel}' — one of: ${LINK_RELS.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  validateSlug(to);
  return { rel, to };
}

/**
 * Collect EVERY `--link` occurrence from raw argv. parseMemoryFlags keeps only the
 * last value for a repeated key, and a link flag is repeatable by design.
 *
 * @param {string[]} argv
 * @returns {Array<{rel: string, to: string}>}
 */
export function collectLinkFlags(argv) {
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (tok === '--link') {
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.push(parseLink(next));
        i++;
      }
      continue;
    }
    if (tok.startsWith('--link=')) out.push(parseLink(tok.slice('--link='.length)));
  }
  return out;
}

/**
 * Build the structured decision body from --what/--why/--alt.
 * Any missing piece is rendered with a "(none)" placeholder so the shape survives.
 *
 * @param {{ what?: string, why?: string, alt?: string }} p
 * @returns {string}
 */
export function buildDecisionBody({ what, why, alt }) {
  return [
    `**What:** ${what || '(unspecified)'}`,
    '',
    `**Why:** ${why || '(unspecified)'}`,
    '',
    `**Alternative rejected:** ${alt || '(none)'}`,
  ].join('\n');
}

/**
 * Split a file's text into frontmatter (parsed) + body, tolerating \r\n / lone \r.
 * Returns { frontmatter, body }. If no frontmatter delimiters are present,
 * frontmatter is {} and the whole text is the body.
 *
 * @param {string} text
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseEntryFile(text) {
  const normalized = (text ?? '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') {
    return { frontmatter: {}, body: normalized.replace(/^\n+/, '').replace(/\n+$/, '') };
  }
  // Find the closing '---'.
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // Malformed — no closing delimiter; treat everything as body.
    return { frontmatter: {}, body: normalized };
  }
  const fmText = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
  let frontmatter = {};
  try {
    frontmatter = yaml.parse(fmText);
  } catch {
    frontmatter = {};
  }
  return { frontmatter, body };
}

/**
 * Drop EMBEDDED frontmatter blocks from an entry body — the damage left by a
 * model-held read-modify-write cycle (`memory show` prints the file verbatim,
 * frontmatter included; re-`add --force` with that held text then wraps a
 * fresh header around the old one, stacking a header per cycle — and a lossy
 * reproduction tears one). Two shapes are repaired:
 *   1. a full '---' <memory-frontmatter keys> '---' block inside the body
 *   2. a torn fragment — frontmatter-key lines running straight into a '---'
 * A markdown horizontal rule ('---' with no frontmatter keys behind it)
 * survives untouched. Narrative text is never dropped.
 *
 * @param {string} body
 * @returns {string}
 */
export function stripEmbeddedFrontmatter(body) {
  const FM_KEY = /^(name|description|metadata):(\s|$)|^\s{2,}(type|created):\s/;
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    // Full embedded block: '---', only fm-key/blank lines, closing '---'.
    if (t === '---') {
      let j = i + 1;
      let sawKey = false;
      let clean = true;
      while (j < lines.length && lines[j].trim() !== '---') {
        if (FM_KEY.test(lines[j])) sawKey = true;
        else if (lines[j].trim() !== '') { clean = false; break; }
        j++;
      }
      if (sawKey && clean && j < lines.length && lines[j].trim() === '---') {
        i = j + 1;
        continue;
      }
    }
    // Torn fragment: fm-key lines (no opening '---' survived) into a '---'.
    if (FM_KEY.test(lines[i])) {
      let j = i;
      while (j < lines.length && (FM_KEY.test(lines[j]) || lines[j].trim() === '')) j++;
      if (j < lines.length && lines[j].trim() === '---') {
        i = j + 1;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
}

/**
 * Read an entry's name + description (from frontmatter) for one entry file.
 * Returns null if the file can't be read.
 *
 * @param {string} absPath
 * @param {string} fallbackName - slug derived from filename (used if frontmatter lacks name).
 * @returns {{ name: string, description: string, type: string } | null}
 */
export function readEntryMeta(absPath, fallbackName, { withBody = false } = {}) {
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const { frontmatter, body } = parseEntryFile(text);
  const fm = frontmatter && typeof frontmatter === 'object' ? frontmatter : {};
  const meta = fm.metadata && typeof fm.metadata === 'object' ? fm.metadata : {};
  const links = Array.isArray(meta.links)
    ? meta.links
      .filter((l) => l && typeof l === 'object' && typeof l.rel === 'string' && typeof l.to === 'string')
      .map((l) => ({ rel: l.rel, to: l.to }))
    : [];
  const out = {
    name: typeof fm.name === 'string' && fm.name ? fm.name : fallbackName,
    description: typeof fm.description === 'string' ? fm.description : '',
    type: typeof meta.type === 'string' ? meta.type : '',
    // A pre-central entry declares none of the following — it reads as an uncategorized
    // non-rule entry with no lineage, which is exactly what it is.
    category: typeof meta.category === 'string' && meta.category ? meta.category : DEFAULT_CATEGORY,
    rule: meta.rule === true,
    source: typeof meta.source === 'string' && meta.source ? meta.source : null,
    links,
  };
  if (withBody) out.body = body;
  return out;
}

/**
 * Harvest `[[slug]]` wiki-links from an entry body — the zero-friction authoring path
 * (it matches the convention the per-CLI global memory store already uses). Harvested
 * occurrences become `relates` edges.
 *
 * @param {string} body
 * @returns {string[]} distinct slugs, in first-appearance order
 */
export function harvestWikiLinks(body) {
  const out = [];
  const seen = new Set();
  const re = /\[\[([a-z0-9][a-z0-9-]*)\]\]/g;
  let m;
  while ((m = re.exec(String(body ?? ''))) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

/**
 * Every namespace that currently has a directory in the central store, in stable
 * order: `root` first, then `projects/*`, then `agents/*` (each alphabetical).
 *
 * Scan-on-read: there is no namespace registry to drift out of date.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function listNamespaces(repoRoot) {
  const out = ['root'];
  for (const group of ['projects', 'agents']) {
    const dir = join(storeRoot(repoRoot), 'store', group);
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }
    for (const n of names) out.push(`${group}/${n}`);
  }
  return out;
}

/**
 * Scan the WHOLE central store and return one record per entry. This is the single
 * generator behind `index.json`, `graph.json` and `MEMORY.md` — three faces, one scan,
 * so they cannot disagree.
 *
 * @param {string} repoRoot
 * @param {{ withBody?: boolean }} [opts]
 * @returns {Array<{
 *   slug: string, namespace: string, category: string, type: string, rule: boolean,
 *   description: string, source: string|null, links: Array<{rel:string,to:string}>,
 *   file: string, body?: string,
 * }>}
 */
export function scanStore(repoRoot, { withBody = false } = {}) {
  const entries = [];
  for (const namespace of listNamespaces(repoRoot)) {
    const baseDir = namespaceDir(repoRoot, namespace);
    for (const slug of listEntrySlugs(baseDir)) {
      const meta = readEntryMeta(join(baseDir, `${slug}.md`), slug, { withBody });
      if (!meta) continue;
      const rec = {
        slug,
        namespace,
        category: meta.category,
        type: meta.type,
        rule: meta.rule,
        description: meta.description,
        source: meta.source,
        links: meta.links,
        // Store-relative (not repo-relative): the central index lives inside the store,
        // so its links resolve without repeating `.sidekicks/memory/` on every line.
        file: namespace === 'root'
          ? `${slug}.md`
          : `store/${namespace}/${slug}.md`,
      };
      if (withBody) rec.body = meta.body;
      entries.push(rec);
    }
  }
  return entries;
}

/**
 * List entry slugs in baseDir (all *.md except MEMORY.md), sorted ascending.
 *
 * @param {string} baseDir - absolute path to the memory store dir.
 * @returns {string[]} slugs (filename without .md), sorted.
 */
export function listEntrySlugs(baseDir) {
  if (!existsSync(baseDir)) return [];
  let names;
  try {
    names = readdirSync(baseDir);
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    .map((f) => f.slice(0, -3))
    .sort((a, b) => a.localeCompare(b));
}

// Index header — what every MEMORY.md starts with.
// Ends with a blank line (\n\n) so pointer lines sit one blank line below the prose.
function indexHeader(scopeLabel) {
  return [
    `# Local Memory — ${scopeLabel}`,
    '',
    'One file per entry under this folder. Registered via `sidekicks memory add`; read via',
    '`sidekicks memory show <name>`. Every line: `- [<name>](<name>.md) — <description>`.',
    '',
    '',
  ].join('\n');
}

/**
 * Format a single index pointer line for an entry.
 * @param {string} name
 * @param {string} description
 * @returns {string}
 */
export function indexLine(name, description) {
  return `- [${name}](${name}.md) — ${description}`;
}

/**
 * Read the current MEMORY.md index text, or null if absent.
 * @param {string} indexPath
 * @returns {string|null}
 */
export function readIndex(indexPath) {
  if (!existsSync(indexPath)) return null;
  try {
    return readFileSync(indexPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Compute a MEMORY.md index text by applying an upsert / delete of one entry's
 * line via read-modify-write over the EXISTING index text. Other entries' lines
 * are preserved byte-faithfully (only the targeted line is changed/removed).
 *
 * Tolerates \r\n and lone \r when splitting (Windows clones); re-emits with \n.
 *
 * @param {object} p
 * @param {string|null} p.currentText - existing MEMORY.md text (null if absent).
 * @param {string} p.scopeLabel       - scope label for the header (used if rebuilding header).
 * @param {string} p.name             - the entry slug being upserted/removed.
 * @param {string|null} p.description - description for upsert; null to DELETE the line.
 * @returns {string} the new index text.
 */
export function applyIndexLine({ currentText, scopeLabel, name, description }) {
  const header = indexHeader(scopeLabel);
  // Regex to recognize a pointer line for a given slug: `- [name](name.md) — ...`
  const lineMatches = (line, slug) => {
    const trimmed = line.replace(/\r$/, '');
    return trimmed.startsWith(`- [${slug}](${slug}.md)`);
  };

  if (currentText === null || currentText.trim() === '') {
    // Fresh index — just header + (the one line if upserting).
    if (description === null) return header + '\n';
    return header + indexLine(name, description) + '\n';
  }

  const lines = currentText.replace(/\r\n?/g, '\n').split('\n');

  // Collect existing pointer lines (in order), skipping the header block.
  // We rebuild as: header + each surviving/updated pointer line.
  const pointerLines = lines.filter((l) => /^- \[[^\]]+\]\([^)]+\.md\)/.test(l.replace(/\r$/, '')));

  let found = false;
  const result = [];
  for (const l of pointerLines) {
    if (lineMatches(l, name)) {
      found = true;
      if (description !== null) {
        result.push(indexLine(name, description));
      }
      // if description === null → drop (delete)
    } else {
      result.push(l.replace(/\r$/, ''));
    }
  }
  if (!found && description !== null) {
    result.push(indexLine(name, description));
  }

  return header + result.join('\n') + (result.length ? '\n' : '');
}

/**
 * Regenerate the WHOLE index text by scanning on-disk entry frontmatter.
 *
 * @param {string} baseDir    - absolute path to the memory store dir.
 * @param {string} scopeLabel - scope label for the header.
 * @returns {string} the rebuilt MEMORY.md text.
 */
export function rebuildIndexText(baseDir, scopeLabel) {
  const header = indexHeader(scopeLabel);
  const slugs = listEntrySlugs(baseDir);
  const lines = [];
  for (const slug of slugs) {
    const meta = readEntryMeta(join(baseDir, `${slug}.md`), slug);
    const desc = meta ? meta.description : '';
    lines.push(indexLine(slug, desc));
  }
  return header + lines.join('\n') + (lines.length ? '\n' : '');
}

// ---------------------------------------------------------------------------
// The ONE central human index
// ---------------------------------------------------------------------------

/**
 * Render the central `MEMORY.md` — every namespace, grouped namespace → category.
 *
 * Regenerated WHOLESALE on every write rather than line-upserted. With one shared
 * index the old read-modify-write could not stay correct: the same slug legitimately
 * exists in two namespaces (a project entry overriding root), so a slug-keyed upsert
 * would rewrite the wrong line. A deterministic regeneration from one scan cannot.
 *
 * @param {string} repoRoot
 * @param {ReturnType<typeof scanStore>} [entries] - a scan to reuse; scanned if omitted
 * @returns {string}
 */
export function rebuildCentralIndexText(repoRoot, entries) {
  const all = entries ?? scanStore(repoRoot);
  const out = [
    '# Local Memory — central store',
    '',
    'One file per entry under `.sidekicks/memory/`. Registered via `sidekicks memory add`;',
    'read via `sidekicks memory show <name>`. Grouped by namespace, then action category.',
    'A **rule** entry loads in full whenever its category is triggered.',
    '',
    'Machine faces of this same store: `index.json` (query) and `graph.json` (links).',
    'Regenerated by `sidekicks memory rebuild` — never hand-edited (Rule 1).',
    '',
  ];

  const byNamespace = new Map();
  for (const e of all) {
    if (!byNamespace.has(e.namespace)) byNamespace.set(e.namespace, []);
    byNamespace.get(e.namespace).push(e);
  }

  // listNamespaces order (root, projects, agents) so the file is stable across machines.
  const order = listNamespaces(repoRoot).filter((ns) => byNamespace.has(ns));
  for (const ns of order) {
    out.push(`## ${ns}`, '');
    const byCategory = new Map();
    for (const e of byNamespace.get(ns)) {
      if (!byCategory.has(e.category)) byCategory.set(e.category, []);
      byCategory.get(e.category).push(e);
    }
    const categories = [...byCategory.keys()].sort((a, b) => a.localeCompare(b));
    for (const cat of categories) {
      const items = byCategory.get(cat).sort((a, b) => a.slug.localeCompare(b.slug));
      const rules = items.filter((e) => e.rule).length;
      out.push(`### ${cat}${rules ? ` — ${rules} rule${rules === 1 ? '' : 's'}` : ''}`, '');
      for (const e of items) {
        out.push(`- [${e.slug}](${e.file}) — ${e.description}${e.rule ? '  **[rule]**' : ''}`);
      }
      out.push('');
    }
  }

  if (order.length === 0) out.push('_(empty store)_', '');
  return out.join('\n');
}
