#!/usr/bin/env node
// knowledge.mjs — zero-dependency store engine for the sk-knowledge skill.
// Manages a committed knowledge store (.knowledge/) under the active scope's artifacts base:
//   entries/<slug>.md   — AI-consumer document; its YAML frontmatter is the CANONICAL metadata
//   entries/<slug>.html — human-consumer rendering (metadata card + rendered markdown)
//   reports/<slug>.html — shareable report, presentation-grade (scripts/report.mjs)
//   index.json          — machine index, DERIVED from frontmatter (self-healing via reindex)
//   INDEX.md            — AI quick-scan index
//   index.html          — human browse page
// All persisted paths are repo-relative (never machine-absolute); store-internal refs are
// store-relative. Cross-platform: node path APIs only, \r\n-tolerant parsing, git via spawnSync.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

// Sibling modules inside THIS skill — never another skill's (tests/skill-config.test.mjs asserts it).
import { escapeHtml, mdToHtml, short, htmlShell } from './md.mjs';
import { buildReportHtml, normalizeLang, UnportablePathError } from './report.mjs';

// ---------- generic helpers ----------

function fail(msg, code = 1) {
  process.stderr.write(`knowledge: ${msg}\n`);
  process.exit(code);
}

// A slug is joined straight into a path by register/show/check/render/remove, and `remove` deletes
// what that join resolves to (fs.rmSync). Unvalidated, `remove ../../../../AGENTS` leaves the store
// entirely and deletes a real repo file — and SKILL.md's "git history keeps it recoverable" only
// holds for a committed store entry, not for whatever a traversal reaches. loadEntries derives every
// slug as a flat filename (`f.slice(0, -3)`), so the flat kebab shape below IS the store's model:
// anything else could not be indexed even if it were written. The file already guards its other
// path input this way (fileSnapshot's "source outside the repo" check); this closes the gap.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
function requireSlug(slug, verb) {
  if (!slug) fail(`${verb} needs a <slug>`, 1);
  if (!SLUG_RE.test(slug)) {
    fail(`invalid slug ${JSON.stringify(slug)} — must be kebab-case [a-z0-9-], no path separators`, 1);
  }
  return slug;
}

function findRepoRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, '.sidekicks'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const ROOT = findRepoRoot(process.cwd());
if (!ROOT) fail('not inside a sidekicks repo (no .sidekicks/ found walking up)', 1);

function toPosix(p) { return p.split(path.sep).join('/'); }

function repoRel(abs) {
  const rel = path.relative(ROOT, abs);
  if (rel === '') return '.';
  return toPosix(rel);
}

function fromRepoRel(rel) {
  if (path.isAbsolute(rel)) return rel;
  return path.resolve(ROOT, rel);
}

// Asia/Bangkok ISO timestamp, e.g. 2026-07-21T14:03:05+07:00
function nowBangkok() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok', hour12: false });
  return s.replace(' ', 'T') + '+07:00';
}

function gitIn(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

// git + hash provenance for one file. Persisted paths are ALWAYS repo-relative — a
// machine-absolute path would break the knowledge the moment the repo is cloned elsewhere,
// so a source outside the repo is refused (record it as a non-file source: type/ref/note).
function fileSnapshot(abs) {
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    fail(`source outside the repo: ${abs}\n  knowledge sources must live inside the repo so paths stay portable;\n  record external evidence as a non-file source (type: url|db|command, ref:, note:)`, 1);
  }
  const src = { path: repoRel(abs) };
  if (!fs.existsSync(abs)) { src.missing = true; return src; }
  src.sha256 = sha256File(abs);
  const top = gitIn(path.dirname(abs), ['rev-parse', '--show-toplevel']);
  if (top) {
    const topAbs = path.resolve(top);
    if (topAbs === ROOT || topAbs.startsWith(ROOT + path.sep)) {
      src.repo = repoRel(topAbs);
      src.branch = gitIn(topAbs, ['rev-parse', '--abbrev-ref', 'HEAD']) || undefined;
      src.commit = gitIn(topAbs, ['rev-parse', 'HEAD']) || undefined;
      const relInRepo = toPosix(path.relative(topAbs, abs));
      src.file_commit = gitIn(topAbs, ['log', '-1', '--format=%H', '--', relInRepo]) || undefined;
    }
    // a git toplevel ABOVE the sidekicks root would persist as an absolute/..-path — omit instead
  }
  for (const k of Object.keys(src)) if (src[k] === undefined) delete src[k];
  return src;
}

// Portability gate — no persisted path may be machine-absolute or escape the repo root.
function portabilityOffenders(meta) {
  const bad = [];
  const isUnportable = (v) => typeof v === 'string' && v !== '' &&
    (path.isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v) || v === '..' || v.startsWith('../') || v.startsWith('..\\'));
  if (isUnportable(meta.scope)) bad.push(`scope: ${meta.scope}`);
  for (const s of meta.sources || []) {
    if (!s || typeof s !== 'object') continue;
    if (isUnportable(s.path)) bad.push(`sources.path: ${s.path}`);
    if (isUnportable(s.repo)) bad.push(`sources.repo: ${s.repo}`);
    if (isUnportable(s.ref)) bad.push(`sources.ref: ${s.ref}`);
  }
  return bad;
}

// ---------- this skill's configuration ----------

// The LAST layer of the resolution chain: what a copy of this skill falls back to when nothing
// configures it and the CLI is not reachable. Mirrors config.defaults.yaml on purpose.
const CONFIG_BLOCK = 'knowledge';
const BUILTIN_CONFIG = {
  always_generate: true,          // write reports/<slug>.html on register/reindex/render/check
  confirm_before_generate: false, // AGENT-level only (see below) — the engine cannot ask anyone
  result_language: 'Thai',        // which `## Report (<lang>)` block and chrome labels to use
};

/**
 * This skill's knobs, resolved through the CLI, over BUILTIN_CONFIG.
 *
 * THE CLI IS THE RESOLVER: a scope's configuration is a folder — the committed family file, its
 * git-ignored '.secret.yaml' sibling, the retired monolith below them, and this skill's
 * config.defaults.yaml — and only `sidekicks config get` knows that chain. Re-deriving it here (or
 * parsing the YAML directly) is how non-CLI readers in this repo have disagreed with the engine.
 *
 * Every failure mode — no repo root, no CLI, an unreadable payload, a value of the wrong type —
 * returns the built-ins rather than throwing. Rendering a store must still work on a checkout that
 * has never been configured, and a knob is never worth failing a reindex over.
 *
 * `confirm_before_generate` is resolved here for completeness but the ENGINE IGNORES IT: asking the
 * user is an agent act, so SKILL.md gates on it. Honouring it here would mean silently skipping the
 * report instead of asking, which is not the same thing at all.
 */
function loadConfig() {
  const values = { ...BUILTIN_CONFIG };
  const r = spawnSync(
    process.execPath, [path.join(ROOT, 'bin', 'sidekicks'), 'config', 'get', CONFIG_BLOCK, '--json'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true }
  );
  if (r.error || r.status !== 0) return values;
  let cfg;
  try {
    cfg = JSON.parse(String(r.stdout ?? '')).config;
  } catch {
    return values;
  }
  if (!cfg || typeof cfg !== 'object') return values;
  for (const [key, fallback] of Object.entries(BUILTIN_CONFIG)) {
    const value = cfg[key];
    if (typeof fallback === 'boolean' && typeof value === 'boolean') values[key] = value;
    else if (typeof fallback === 'string' && typeof value === 'string' && value.trim()) values[key] = value;
  }
  return values;
}

// Resolved once per process: every verb in a single run reports in the same language.
let CONFIG = null;
function config() { return (CONFIG ??= loadConfig()); }

/** Whether this run writes reports: an explicit flag wins, otherwise `always_generate`. */
function reportsOn(opts) {
  return typeof opts.report === 'boolean' ? opts.report : config().always_generate === true;
}

// ---------- store resolution ----------

function resolveStoreDir(opts) {
  if (opts.dir) return fromRepoRel(opts.dir);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'sidekicks'), 'scope', 'artifacts-base'], { encoding: 'utf8' });
  const base = r.status === 0 ? (r.stdout || '').trim() : '';
  return path.join(base || ROOT, '.knowledge');
}

function storePaths(storeDir) {
  return {
    dir: storeDir,
    entries: path.join(storeDir, 'entries'),
    index: path.join(storeDir, 'index.json'),
    indexMd: path.join(storeDir, 'INDEX.md'),
    indexHtml: path.join(storeDir, 'index.html'),
    reports: path.join(storeDir, 'reports'),
  };
}

// ---------- minimal YAML frontmatter parse (constrained format, documented in SKILL.md) ----------
// Supports: `key: scalar`, `key: [a, b]`, and block lists of flat maps:
//   sources:
//     - path: x
//       sha256: y
// Scalars may be single/double-quoted. \r\n tolerated. No nested maps beyond list items.

function stripQuotes(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseScalar(v) {
  v = v.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => stripQuotes(s));
  }
  return stripQuotes(v);
}

function parseFrontmatter(text) {
  const norm = text.replace(/\r\n?/g, '\n');
  if (!norm.startsWith('---\n')) return { meta: null, body: norm };
  const end = norm.indexOf('\n---', 4);
  if (end === -1) return { meta: null, body: norm };
  const block = norm.slice(4, end);
  const body = norm.slice(norm.indexOf('\n', end + 1) + 1);
  const lines = block.split('\n');
  const meta = {};
  let listKey = null;   // key currently collecting a block list
  let current = null;   // current list item (map)
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!m) continue;
      const [, key, rest] = m;
      if (rest === '') { meta[key] = []; listKey = key; current = null; }
      else { meta[key] = parseScalar(rest); listKey = null; current = null; }
    } else if (listKey) {
      if (line.startsWith('- ')) {
        const itemRest = line.slice(2);
        const m = itemRest.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        current = {};
        if (m) current[m[1]] = parseScalar(m[2]);
        else if (itemRest.trim()) { meta[listKey].push(parseScalar(itemRest)); current = null; continue; }
        meta[listKey].push(current);
      } else if (current) {
        const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (m) current[m[1]] = parseScalar(m[2]);
      }
    }
  }
  return { meta, body };
}

// ---------- the entry twin's own palette ----------
// The renderer itself lives in ./md.mjs, shared with report.mjs; only the look is local. This is
// the plain twin: a metadata card over the raw markdown, for reading and diffing — the designed,
// shareable page is reports/<slug>.html.

const CSS = `
:root{--bg:#fff;--fg:#1a1d21;--muted:#5c6570;--line:#e2e6ea;--card:#f6f8fa;--accent:#0b6bcb;--fresh:#0a7d33;--stale:#b3540a;--code:#f0f2f5}
@media (prefers-color-scheme: dark){:root{--bg:#101418;--fg:#e6e9ec;--muted:#98a2ad;--line:#2a3138;--card:#181e24;--accent:#5aa2e8;--fresh:#4cc273;--stale:#e8a05a;--code:#1c232a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,'Segoe UI',Roboto,sans-serif}
main{max-width:900px;margin:0 auto;padding:2rem 1.25rem}
h1,h2,h3{line-height:1.3}a{color:var(--accent)}
code{background:var(--code);padding:.1em .35em;border-radius:4px;font-size:.9em}
pre{background:var(--code);padding:1rem;border-radius:8px;overflow-x:auto}pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:1rem 0;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:.4rem .6rem;text-align:left;font-size:.92em}
blockquote{border-left:3px solid var(--line);margin:1rem 0;padding:.2rem 1rem;color:var(--muted)}
.meta{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.5rem;font-size:.9em}
.meta dt{font-weight:600;color:var(--muted);text-transform:uppercase;font-size:.75em;letter-spacing:.04em}
.meta dd{margin:0 0 .6rem 0}.meta dl{margin:0}
.badge{display:inline-block;padding:.1em .6em;border-radius:999px;font-size:.85em;font-weight:600}
.badge.fresh{color:var(--fresh);border:1px solid var(--fresh)}
.badge.stale{color:var(--stale);border:1px solid var(--stale)}
.badge.unknown{color:var(--muted);border:1px solid var(--muted)}
.tag{display:inline-block;background:var(--code);border-radius:999px;padding:.05em .6em;margin-right:.3em;font-size:.85em}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88em}
footer{margin-top:2rem;color:var(--muted);font-size:.85em;border-top:1px solid var(--line);padding-top:1rem}
pre.mermaid{text-align:center;overflow-x:auto}pre.mermaid svg{max-width:100%;height:auto}
h2.section{border-bottom:1px solid var(--line);padding-bottom:.3rem;margin-top:2.2rem}
`;

function sourcesTable(sources) {
  if (!Array.isArray(sources) || !sources.length) return '<p class="mono">no tracked sources</p>';
  const rows = sources.map((s) => {
    if (s.type && s.type !== 'file') {
      return `<tr><td>${escapeHtml(s.type)}</td><td class="mono">${escapeHtml(s.ref || s.path || '')}</td><td colspan="3">${escapeHtml(s.note || '')}</td></tr>`;
    }
    return `<tr><td>file</td><td class="mono">${escapeHtml(s.path || '')}</td><td class="mono">${escapeHtml(s.branch || '')}</td><td class="mono">${short(s.file_commit || s.commit)}</td><td class="mono">${short(s.sha256)}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>type</th><th>source</th><th>branch</th><th>commit</th><th>sha256</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderEntryHtml(store, slug, meta, body) {
  const status = meta.status || 'unknown';
  const tags = (Array.isArray(meta.tags) ? meta.tags : []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  const metaCard = `<div class="meta"><dl>
<dt>status</dt><dd><span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span> <span class="tag">${escapeHtml(meta.section || 'general')}</span> ${tags}</dd>
${meta.target ? `<dt>target</dt><dd class="mono">${escapeHtml(meta.target)}</dd>` : ''}
<dt>question</dt><dd>${escapeHtml(meta.question || '')}</dd>
<dt>created / updated</dt><dd class="mono">${escapeHtml(meta.created_at || '')} &nbsp;/&nbsp; ${escapeHtml(meta.updated_at || '')}</dd>
<dt>captured at</dt><dd class="mono">branch ${escapeHtml(meta.captured_branch || '?')} @ ${short(meta.captured_commit)}</dd>
<dt>scope</dt><dd class="mono">${escapeHtml(meta.scope || '')}</dd>
<dt>evidence sources</dt><dd>${sourcesTable(meta.sources)}</dd>
</dl></div>`;
  const html = htmlShell(meta.title || slug,
    `<p><a href="../index.html">&larr; knowledge index</a></p><h1>${escapeHtml(meta.title || slug)}</h1>${metaCard}${mdToHtml(body)}<footer>sk-knowledge entry <span class="mono">${escapeHtml(slug)}</span> &middot; markdown twin: <span class="mono">entries/${escapeHtml(slug)}.md</span></footer>`, CSS);
  fs.writeFileSync(path.join(store.entries, `${slug}.html`), html);
}

/**
 * Write (or remove) reports/<slug>.html — the shareable, presentation-grade twin.
 *
 * Derived output like the entry html, so it is rewritten by every verb that re-renders an entry and
 * deleted by `remove`. When generation is off the existing file is deleted rather than left behind:
 * a stale report is worse than none, because nothing on its face says it no longer matches.
 *
 * An unportable path is reported and the report skipped — never fatal. `register` already
 * hard-fails unportable FRONTMATTER; a machine path buried in a body must not be able to break a
 * whole-store `reindex`, so the entry still renders and the operator gets a named warning.
 *
 * @returns {boolean} whether reports/<slug>.html exists after the call
 */
function renderReportFile(store, slug, meta, body, opts) {
  const target = path.join(store.reports, `${slug}.html`);
  if (!reportsOn(opts)) {
    if (fs.existsSync(target)) fs.rmSync(target);
    return false;
  }
  let html;
  try {
    html = buildReportHtml({ slug, meta, body, lang: opts.lang || config().result_language });
  } catch (err) {
    if (!(err instanceof UnportablePathError)) throw err;
    process.stderr.write(`knowledge: warning — no report for ${slug}: ${err.message}\n`);
    if (fs.existsSync(target)) fs.rmSync(target);
    return false;
  }
  fs.mkdirSync(store.reports, { recursive: true });
  fs.writeFileSync(target, html);
  return true;
}

/** Whether a rendered report is on disk for this slug — what the index links on. */
function hasReport(store, slug) {
  return fs.existsSync(path.join(store.reports, `${slug}.html`));
}

// ---------- fast lookup: keywords + cross-store catalog ----------
// The catalog is a DERIVED, git-ignored cache (delete-safe, rebuilt on demand) that lets
// `find` answer "does knowledge on X exist anywhere in this repo?" from ONE file read —
// no filesystem rescan. Candidate store locations come from bounded readdirs of
// projects/*/ and projects/*/services/*/ (never a tree walk); a store is re-ingested only
// when its index.json mtime changed, and every register/check/remove writes through.

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  'how', 'what', 'when', 'where', 'why', 'which', 'does', 'into', 'each', 'has', 'have', 'had',
  'not', 'but', 'all', 'any', 'can', 'its', 'via', 'per', 'use', 'used', 'uses', 'you', 'your']);

function tokenize(...texts) {
  const out = new Set();
  for (const t of texts) {
    if (!t) continue;
    const s = Array.isArray(t) ? t.join(' ') : String(t);
    for (const w of s.toLowerCase().split(/[^a-z0-9_-]+/)) {
      if (w.length >= 3 && !STOP.has(w)) out.add(w);
    }
  }
  return [...out].slice(0, 64);
}

// Runs layout v2: this catalog carries no work item (it indexes every .knowledge/
// store in the repo, not one unit of work), so it resolves to the work-item-less
// `_adhoc/<skill-id>/` shape — fixed at the repo ROOT like PLANS_REL in
// sk-agent-dry-run/scripts/plan.mjs, never scope-resolved (this is a
// cross-project cache, not a per-project artifact). `legacyCatalogPath()` is the
// pre-v2 location: read as a one-time fallback, never written again.
function catalogPath() { return path.join(ROOT, 'artifacts', 'runs', '_adhoc', 'sk-knowledge', 'catalog.json'); }
function legacyCatalogPath() { return path.join(ROOT, 'artifacts', 'runs', 'sk-knowledge', 'catalog.json'); }

function loadCatalog() {
  try { return JSON.parse(fs.readFileSync(catalogPath(), 'utf8')); } catch { /* fall through to legacy */ }
  try { return JSON.parse(fs.readFileSync(legacyCatalogPath(), 'utf8')); } catch { return { schema_version: 1, kind: 'sk-knowledge-catalog', stores: {} }; }
}

function saveCatalog(cat) {
  cat.built_at = nowBangkok();
  fs.mkdirSync(path.dirname(catalogPath()), { recursive: true });
  fs.writeFileSync(catalogPath(), JSON.stringify(cat, null, 2) + '\n');
}

function upsertCatalog(store, idx) {
  const key = repoRel(store.dir);
  if (key.startsWith('..') || path.isAbsolute(key)) return; // out-of-repo store: not catalogable
  const cat = loadCatalog();
  cat.stores[key] = {
    index_mtime_ms: fs.statSync(store.index).mtimeMs,
    scope: idx.scope,
    entries: idx.entries,
  };
  saveCatalog(cat);
}

// Candidate .knowledge/ locations without walking the tree: repo root, every project dir,
// every service root — three bounded readdir levels, mirroring the scope model.
function discoverStoreCandidates() {
  const out = ['.knowledge'];
  const projectsDir = path.join(ROOT, 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const p of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!p.isDirectory()) continue;
      out.push(toPosix(path.join('projects', p.name, '.knowledge')));
      const svcDir = path.join(projectsDir, p.name, 'services');
      if (fs.existsSync(svcDir)) {
        for (const s of fs.readdirSync(svcDir, { withFileTypes: true })) {
          if (s.isDirectory()) out.push(toPosix(path.join('projects', p.name, 'services', s.name, '.knowledge')));
        }
      }
    }
  }
  return out;
}

function refreshCatalog() {
  const cat = loadCatalog();
  const candidates = new Set(discoverStoreCandidates());
  for (const k of Object.keys(cat.stores)) candidates.add(k); // keep custom-dir stores known via write-through
  let changed = false;
  for (const key of candidates) {
    const idxPath = path.join(fromRepoRel(key), 'index.json');
    if (!fs.existsSync(idxPath)) {
      if (cat.stores[key]) { delete cat.stores[key]; changed = true; }
      continue;
    }
    const mtime = fs.statSync(idxPath).mtimeMs;
    if (cat.stores[key] && cat.stores[key].index_mtime_ms === mtime) continue;
    try {
      const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
      if (idx.kind !== 'sk-knowledge') continue;
      cat.stores[key] = { index_mtime_ms: mtime, scope: idx.scope, entries: idx.entries };
      changed = true;
    } catch { /* unreadable index — leave any stale copy; reindex heals it */ }
  }
  if (changed) saveCatalog(cat);
  return cat;
}

// ---------- index ----------

function loadEntries(store) {
  if (!fs.existsSync(store.entries)) return {};
  const entries = {};
  for (const f of fs.readdirSync(store.entries).sort()) {
    if (!f.endsWith('.md')) continue;
    const slug = f.slice(0, -3);
    const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(store.entries, f), 'utf8'));
    if (!meta) continue;
    entries[slug] = { meta, body };
  }
  return entries;
}

function buildIndex(store, entries) {
  const idx = {
    schema_version: 1,
    kind: 'sk-knowledge',
    scope: repoRel(path.dirname(store.dir)),
    updated_at: nowBangkok(),
    entries: {},
  };
  for (const [slug, { meta, body }] of Object.entries(entries)) {
    const headings = (body.match(/^#{1,6}\s+(.*)$/gm) || []).join(' ');
    idx.entries[slug] = {
      keywords: tokenize(slug, meta.title, meta.summary, meta.question, meta.tags, meta.target, meta.section, headings),
      title: meta.title || slug,
      summary: meta.summary || '',
      question: meta.question || '',
      section: meta.section || 'general',
      target: meta.target || '',
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      created_at: meta.created_at || '',
      updated_at: meta.updated_at || '',
      checked_at: meta.checked_at || '',
      status: meta.status || 'unknown',
      captured_branch: meta.captured_branch || '',
      captured_commit: meta.captured_commit || '',
      sources: (meta.sources || []).length,
      md: `entries/${slug}.md`,
      html: `entries/${slug}.html`,
    };
  }
  fs.writeFileSync(store.index, JSON.stringify(idx, null, 2) + '\n');
  // group by section — 'general' sorts last, everything else alphabetical
  const bySection = {};
  for (const [slug, e] of Object.entries(idx.entries)) (bySection[e.section] ||= []).push([slug, e]);
  const sections = Object.keys(bySection).sort((a, b) =>
    (a === 'general') - (b === 'general') || a.localeCompare(b));
  // INDEX.md — AI quick scan
  const mdLines = ['# Knowledge index', '', `Scope: \`${idx.scope}\` · rebuilt ${idx.updated_at}`];
  for (const sec of sections) {
    mdLines.push('', `## ${sec}`, '');
    for (const [slug, e] of bySection[sec]) {
      const rpt = hasReport(store, slug) ? ` · [report](reports/${slug}.html)` : '';
      mdLines.push(`- [${e.title}](entries/${slug}.md)${rpt}${e.target ? ` \`${e.target}\`` : ''} — ${e.summary} _(status: ${e.status}, updated: ${e.updated_at}, branch: ${e.captured_branch} @ ${short(e.captured_commit)}, tags: ${e.tags.join(', ') || '—'})_`);
    }
  }
  fs.writeFileSync(store.indexMd, mdLines.join('\n') + '\n');
  // index.html — human browse, one table per section
  const blocks = sections.map((sec) => {
    const rows = bySection[sec].map(([slug, e]) =>
      `<tr><td><a href="entries/${escapeHtml(slug)}.html">${escapeHtml(e.title)}</a>${hasReport(store, slug) ? ` <a href="reports/${escapeHtml(slug)}.html">(report)</a>` : ''}${e.target ? `<br><span class="mono">${escapeHtml(e.target)}</span>` : ''}</td><td>${escapeHtml(e.summary)}</td><td>${e.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</td><td class="mono">${escapeHtml(e.updated_at)}</td><td class="mono">${escapeHtml(e.captured_branch)} @ ${short(e.captured_commit)}</td><td><span class="badge ${escapeHtml(e.status)}">${escapeHtml(e.status)}</span></td></tr>`).join('\n');
    return `<h2 class="section">${escapeHtml(sec)}</h2>
<table><thead><tr><th>title</th><th>summary</th><th>tags</th><th>updated</th><th>captured</th><th>status</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('\n');
  fs.writeFileSync(store.indexHtml, htmlShell('Knowledge index',
    `<h1>Knowledge index</h1><p class="mono">scope: ${escapeHtml(idx.scope)} · rebuilt ${escapeHtml(idx.updated_at)}</p>
${blocks}
<footer>machine index: <span class="mono">index.json</span> · AI index: <span class="mono">INDEX.md</span></footer>`, CSS));
  upsertCatalog(store, idx); // write-through: `find` stays warm with zero rescans
  return idx;
}

// Persist a frontmatter field change back into the md file (used by `check` for status/checked_at).
function patchFrontmatterField(mdPath, key, value) {
  let text = fs.readFileSync(mdPath, 'utf8');
  const norm = text.replace(/\r\n?/g, '\n');
  const end = norm.indexOf('\n---', 4);
  if (!norm.startsWith('---\n') || end === -1) return;
  let block = norm.slice(4, end);
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(block)) block = block.replace(re, `${key}: ${value}`);
  else block = block.replace(/\s*$/, '') + `\n${key}: ${value}`;
  fs.writeFileSync(mdPath, `---\n${block}\n---${norm.slice(end + 4)}`);
}

// ---------- verbs ----------

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--yaml') opts.yaml = true;
    else if (a === '--tag') opts.tag = argv[++i];
    else if (a === '--section') opts.section = argv[++i];
    else if (a === '--stale') opts.stale = true;
    else if (a === '--report') opts.report = true;        // force generation, whatever config says
    else if (a === '--no-report') opts.report = false;    // suppress it for this run
    else if (a === '--lang') opts.lang = argv[++i];       // override result_language
    else opts._.push(a);
  }
  return opts;
}

function cmdInit(store) {
  fs.mkdirSync(store.entries, { recursive: true });
  fs.mkdirSync(store.reports, { recursive: true });
  if (!fs.existsSync(store.index)) buildIndex(store, loadEntries(store));
  process.stdout.write(store.dir + '\n');
}

function cmdNow() { process.stdout.write(nowBangkok() + '\n'); }

function cmdSnapshot(store, opts) {
  if (!opts._.length) fail('snapshot needs one or more file paths', 1);
  const snaps = opts._.map((p) => fileSnapshot(fromRepoRel(p)));
  if (opts.yaml) {
    const lines = ['sources:'];
    for (const s of snaps) {
      const keys = Object.entries(s);
      keys.forEach(([k, v], i) => lines.push(`${i === 0 ? '  - ' : '    '}${k}: ${v}`));
    }
    process.stdout.write(lines.join('\n') + '\n');
  } else {
    process.stdout.write(JSON.stringify(snaps, null, 2) + '\n');
  }
}

function cmdRegister(store, opts) {
  const slug = requireSlug(opts._[0], 'register');
  const mdPath = path.join(store.entries, `${slug}.md`);
  if (!fs.existsSync(mdPath)) fail(`entry not found: ${repoRel(mdPath)} — author the markdown first`, 2);
  const entries = loadEntries(store);
  const entry = entries[slug];
  if (!entry) fail(`frontmatter missing or unparseable in ${repoRel(mdPath)}`, 1);
  const missing = ['title', 'summary', 'created_at', 'updated_at'].filter((k) => !entry.meta[k]);
  if (missing.length) fail(`frontmatter missing required field(s): ${missing.join(', ')}`, 1);
  const offenders = portabilityOffenders(entry.meta);
  if (offenders.length) {
    fail(`unportable path(s) in frontmatter — use repo-relative paths ('.' = repo root):\n  ${offenders.join('\n  ')}`, 1);
  }
  const homeish = entry.body.match(/(\/Users\/[\w.-]+|\/home\/[\w.-]+|[A-Za-z]:\\Users\\[\w.-]+)/);
  if (homeish) process.stderr.write(`knowledge: warning — body mentions a machine-local path (${homeish[1]}); prefer repo-relative citations\n`);
  renderEntryHtml(store, slug, entry.meta, entry.body);
  const wrote = renderReportFile(store, slug, entry.meta, entry.body, opts);
  const idx = buildIndex(store, entries);
  process.stdout.write(`registered ${slug} (${Object.keys(idx.entries).length} entries in index)\n`);
  process.stdout.write(`  md:     ${repoRel(path.join(store.entries, slug + '.md'))}\n`);
  process.stdout.write(`  html:   ${repoRel(path.join(store.entries, slug + '.html'))}\n`);
  if (wrote) process.stdout.write(`  report: ${repoRel(path.join(store.reports, slug + '.html'))}\n`);
}

function cmdReindex(store, opts) {
  const entries = loadEntries(store);
  for (const [slug, { meta }] of Object.entries(entries)) {
    const offenders = portabilityOffenders(meta);
    if (offenders.length) process.stderr.write(`knowledge: warning — ${slug} has unportable path(s): ${offenders.join(', ')}\n`);
  }
  let reports = 0;
  for (const [slug, { meta, body }] of Object.entries(entries)) {
    renderEntryHtml(store, slug, meta, body);
    if (renderReportFile(store, slug, meta, body, opts)) reports++;
  }
  const idx = buildIndex(store, entries);
  process.stdout.write(`reindexed ${Object.keys(idx.entries).length} entries (${reports} reports) at ${repoRel(store.dir)}\n`);
}

function readIndex(store) {
  if (!fs.existsSync(store.index)) {
    if (!fs.existsSync(store.entries)) return null;
    return buildIndex(store, loadEntries(store)); // self-heal
  }
  return JSON.parse(fs.readFileSync(store.index, 'utf8'));
}

function cmdList(store, opts) {
  const idx = readIndex(store);
  if (!idx || !Object.keys(idx.entries).length) { process.stdout.write(opts.json ? '{}\n' : 'no knowledge entries\n'); return; }
  let items = Object.entries(idx.entries);
  if (opts.tag) items = items.filter(([, e]) => e.tags.includes(opts.tag));
  if (opts.section) items = items.filter(([, e]) => e.section === opts.section);
  if (opts.stale) items = items.filter(([, e]) => e.status === 'stale');
  if (opts.json) { process.stdout.write(JSON.stringify(Object.fromEntries(items), null, 2) + '\n'); return; }
  for (const [slug, e] of items) {
    process.stdout.write(`${slug}  [${e.status}]  (${e.section})  ${e.title}${e.target ? `  <${e.target}>` : ''}\n    ${e.summary}\n    updated ${e.updated_at} · ${e.captured_branch} @ ${short(e.captured_commit)} · tags: ${e.tags.join(', ') || '—'}\n`);
  }
}

function cmdSearch(store, opts) {
  const terms = opts._.map((t) => t.toLowerCase());
  if (!terms.length) fail('search needs one or more terms', 1);
  const entries = loadEntries(store);
  const hits = [];
  for (const [slug, { meta, body }] of Object.entries(entries)) {
    const hay = [meta.title, meta.summary, meta.question, (meta.tags || []).join(' ')].join(' ').toLowerCase();
    const bodyLower = body.toLowerCase();
    const score = terms.reduce((n, t) => n + (hay.includes(t) ? 2 : 0) + (bodyLower.includes(t) ? 1 : 0), 0);
    if (score > 0) hits.push({ slug, score, title: meta.title, summary: meta.summary, status: meta.status || 'unknown' });
  }
  hits.sort((a, b) => b.score - a.score);
  if (opts.json) { process.stdout.write(JSON.stringify(hits, null, 2) + '\n'); return; }
  if (!hits.length) { process.stdout.write('no matches\n'); return; }
  for (const h of hits) process.stdout.write(`${h.slug}  [${h.status}]  ${h.title}\n    ${h.summary}\n`);
}

function cmdShow(store, opts) {
  const slug = requireSlug(opts._[0], 'show');
  const mdPath = path.join(store.entries, `${slug}.md`);
  if (!fs.existsSync(mdPath)) fail(`no entry: ${slug}`, 2);
  const { meta } = parseFrontmatter(fs.readFileSync(mdPath, 'utf8'));
  if (opts.json) { process.stdout.write(JSON.stringify({ slug, md: repoRel(mdPath), ...meta }, null, 2) + '\n'); return; }
  process.stdout.write(fs.readFileSync(mdPath, 'utf8'));
}

function cmdCheck(store, opts) {
  const entries = loadEntries(store);
  // `check` takes ZERO OR MORE slugs — no argument means scan the whole store, so validate the
  // supplied list per element and never demand one (a blanket requireSlug here would kill the
  // documented full-store scan and the exit-3 staleness contract with it).
  if (opts._.length) opts._.forEach((s) => requireSlug(s, 'check'));
  const targets = opts._.length ? opts._ : Object.keys(entries);
  const report = [];
  let anyStale = false;
  for (const slug of targets) {
    const entry = entries[slug];
    if (!entry) fail(`no entry: ${slug}`, 2);
    const drift = [];
    let unverifiable = 0;
    for (const s of entry.meta.sources || []) {
      if (s.type && s.type !== 'file') { unverifiable++; continue; }
      if (!s.path) continue;
      const abs = fromRepoRel(s.path);
      if (!fs.existsSync(abs)) { drift.push({ path: s.path, reason: 'missing' }); continue; }
      const now = fileSnapshot(abs);
      if (s.sha256 && now.sha256 !== s.sha256) {
        drift.push({ path: s.path, reason: 'content changed', was: short(s.sha256), now: short(now.sha256), was_commit: short(s.file_commit), now_commit: short(now.file_commit) });
      }
    }
    const status = drift.length ? 'stale' : 'fresh';
    if (drift.length) anyStale = true;
    const mdPath = path.join(store.entries, `${slug}.md`);
    patchFrontmatterField(mdPath, 'status', status);
    patchFrontmatterField(mdPath, 'checked_at', nowBangkok());
    report.push({ slug, status, drift, unverifiable_sources: unverifiable });
  }
  // re-render + reindex so status is visible everywhere
  const fresh = loadEntries(store);
  for (const slug of targets) {
    if (!fresh[slug]) continue;
    renderEntryHtml(store, slug, fresh[slug].meta, fresh[slug].body);
    renderReportFile(store, slug, fresh[slug].meta, fresh[slug].body, opts);
  }
  buildIndex(store, fresh);
  if (opts.json) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); }
  else {
    for (const r of report) {
      process.stdout.write(`${r.slug}: ${r.status.toUpperCase()}${r.unverifiable_sources ? ` (${r.unverifiable_sources} unverifiable non-file source(s))` : ''}\n`);
      for (const d of r.drift) process.stdout.write(`    ${d.path} — ${d.reason}${d.now ? ` (sha ${d.was}→${d.now}, commit ${d.was_commit || '?'}→${d.now_commit || '?'})` : ''}\n`);
    }
  }
  process.exitCode = anyStale ? 3 : 0;
}

// find — the existence probe. Answers from the catalog only (one JSON read + cheap mtime
// validation); never opens an entry .md. Exit 0 = hits, 2 = nothing recorded anywhere.
function cmdFind(opts) {
  const terms = opts._.map((t) => t.toLowerCase());
  const cat = refreshCatalog();
  if (!terms.length) { // no terms: orientation — list every store with entry counts
    const stores = Object.entries(cat.stores).map(([key, s]) => ({ store: key, scope: s.scope, entries: Object.keys(s.entries || {}).length }));
    if (opts.json) process.stdout.write(JSON.stringify(stores, null, 2) + '\n');
    else if (!stores.length) process.stdout.write('no knowledge stores in this repo\n');
    else for (const s of stores) process.stdout.write(`${s.store}  (${s.entries} entries, scope ${s.scope})\n`);
    process.exitCode = stores.length ? 0 : 2;
    return;
  }
  const hits = [];
  for (const [storeKey, s] of Object.entries(cat.stores)) {
    for (const [slug, e] of Object.entries(s.entries || {})) {
      const kw = new Set(e.keywords || []);
      const hay = [slug, e.title, e.summary, e.target, (e.tags || []).join(' '), e.section].join(' ').toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (kw.has(t)) score += 2;
        else if (hay.includes(t)) score += 2;
        else for (const k of kw) if (k.includes(t) || t.includes(k)) { score += 1; break; }
      }
      if (score) hits.push({ score, store: storeKey, slug, title: e.title, summary: e.summary, section: e.section, status: e.status, updated_at: e.updated_at, md: `${storeKey}/entries/${slug}.md` });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  if (opts.json) process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
  else if (!hits.length) process.stdout.write('no existing knowledge matches — CAPTURE it\n');
  else for (const h of hits) process.stdout.write(`${h.slug}  [${h.status}]  (${h.section})  ${h.title}\n    ${h.summary}\n    ${h.md}\n`);
  process.exitCode = hits.length ? 0 : 2;
}

function cmdRender(store, opts) {
  const slug = requireSlug(opts._[0], 'render');
  const entries = loadEntries(store);
  if (!entries[slug]) fail(`no entry: ${slug}`, 2);
  renderEntryHtml(store, slug, entries[slug].meta, entries[slug].body);
  const wrote = renderReportFile(store, slug, entries[slug].meta, entries[slug].body, opts);
  buildIndex(store, entries);
  process.stdout.write(`rendered ${repoRel(path.join(store.entries, slug + '.html'))}\n`);
  if (wrote) process.stdout.write(`rendered ${repoRel(path.join(store.reports, slug + '.html'))}\n`);
}

// report — the EXPLICIT ask. `always_generate: false` turns the automatic writes off; this verb
// (and `--report` on any rendering verb) is how a report is still produced on request.
function cmdReport(store, opts) {
  const slug = requireSlug(opts._[0], 'report');
  const entries = loadEntries(store);
  if (!entries[slug]) fail(`no entry: ${slug}`, 2);
  const wrote = renderReportFile(store, slug, entries[slug].meta, entries[slug].body,
    { ...opts, report: opts.report !== false });
  if (!wrote) fail(`no report written for ${slug} — see the warning above`, 1);
  buildIndex(store, entries);
  process.stdout.write(`${repoRel(path.join(store.reports, slug + '.html'))}\n`);
}

function cmdRemove(store, opts) {
  const slug = requireSlug(opts._[0], 'remove');
  const mdPath = path.join(store.entries, `${slug}.md`);
  if (!fs.existsSync(mdPath)) fail(`no entry: ${slug}`, 2);
  fs.rmSync(mdPath);
  const htmlPath = path.join(store.entries, `${slug}.html`);
  if (fs.existsSync(htmlPath)) fs.rmSync(htmlPath);
  const reportPath = path.join(store.reports, `${slug}.html`);
  if (fs.existsSync(reportPath)) fs.rmSync(reportPath);
  buildIndex(store, loadEntries(store));
  process.stdout.write(`removed ${slug}\n`);
}

// ---------- main ----------

const [verb, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);

if (verb === 'now') { cmdNow(); process.exit(0); }
if (verb === 'find') { cmdFind(opts); process.exit(process.exitCode || 0); } // store-independent: catalog only

const store = storePaths(resolveStoreDir(opts));

switch (verb) {
  case 'init': cmdInit(store); break;
  case 'snapshot': cmdSnapshot(store, opts); break;
  case 'register': cmdRegister(store, opts); break;
  case 'reindex': cmdReindex(store, opts); break;
  case 'list': cmdList(store, opts); break;
  case 'search': cmdSearch(store, opts); break;
  case 'show': cmdShow(store, opts); break;
  case 'check': cmdCheck(store, opts); break;
  case 'render': cmdRender(store, opts); break;
  case 'report': cmdReport(store, opts); break;
  case 'remove': cmdRemove(store, opts); break;
  default:
    process.stdout.write(`usage: node knowledge.mjs <verb> [args] [--dir <knowledge_dir>] [--json]
       rendering verbs also take [--report | --no-report] [--lang <language>]

verbs:
  init                      ensure the store exists; print its absolute path
  now                       print Asia/Bangkok ISO timestamp (for frontmatter stamps)
  snapshot <path...>        provenance for source files: repo, branch, commit, file_commit, sha256
                            (--yaml prints a paste-ready frontmatter sources: block)
  register <slug>           validate frontmatter, render html + report, rebuild index
                            (md is canonical; mermaid fences render as live diagrams)
  find [<terms...>]         FAST existence probe across ALL stores in the repo — answers from
                            the derived catalog (one JSON read + mtime checks; no fs rescan,
                            no .md reads). No terms: list every store. Exit 0 = hits, 2 = none.
  list [--tag t] [--section s] [--stale]  list entries from the index
  search <terms...>         rank entries matching terms (title/summary/tags/question/body)
  show <slug>               print the entry markdown (--json: metadata only)
  check [<slug>...]         staleness check: rehash sources, stamp status/checked_at,
                            re-render + reindex; exit 3 when anything is stale
  render <slug>             regenerate the html twin + report + index files
  report <slug>             write reports/<slug>.html on explicit ask, even with
                            always_generate: false; prints the path
  reindex                   rebuild index.json/INDEX.md/index.html + all html + all reports
  remove <slug>             delete an entry (md + html + report) and reindex

config (block 'knowledge', resolved via: sidekicks config get knowledge --json):
  always_generate           write the report on register/reindex/render/check (default true)
  result_language           which '## Report (<lang>)' block and chrome labels to use
                            (default Thai) — selects prose, never translates it
  confirm_before_generate   AGENT-level gate, honoured by SKILL.md; this engine ignores it
`);
    process.exit(verb ? 1 : 0);
}
