// lib/memory-lifecycle/_sources.mjs
// EXTERNAL MEMORY SOURCES — the transport that replaced git for the central store.
//
// `.sidekicks/memory/` is git-ignored: the entries live on local disk and this repo's history
// carries none of them. That trade buys a store nobody has to merge, and it costs the one thing
// git was doing for free — getting the knowledge to another checkout. A *source* is what pays that
// cost back: a folder or a git repository the store can be pulled from (`memory sync`) and pushed
// to (`memory publish`).
//
// THE REGISTRY IS COMMITTED, THE STORE IS NOT. The source list lives in the `memory_sources`
// configuration block (`.sidekicks/config/memory.yaml`, declared in lib/config-store/core-families.mjs),
// which travels with the repo. It is the only breadcrumb a fresh clone has back to the memories —
// git-ignoring it too would leave a checkout that cannot even name where its knowledge went.
//
// FOUR SHAPES, ONE READER. A source folder is understood in exactly one place, so `import` and
// `sync` can never disagree about what a folder is:
//
//   export folder        index.json with schema memory-export/v1 + entries/   → namespace from manifest
//   live central store   MEMORY.md / store/ / bare *.md entries              → every namespace preserved
//   legacy scope tree    …/projects/<p>/memory | …/.sidekicks/agents/<n>/memory → namespace from the path
//   flat folder          *.md carrying entry frontmatter                     → caller must name the namespace
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, relative, isAbsolute, basename, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { EXIT_VALIDATION, EXIT_NOT_FOUND, EXIT_GIT, SidekicksError } from '../sk-cli/errors.mjs';
import { resolveBlock } from '../config-store/read.mjs';
import { writeBlock } from '../config-store/write.mjs';
import { layerForNamespace, storeRoot } from '../active-scope/memory-paths.mjs';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { parseEntryFile, SLUG_RE, byCodeUnit } from './_shared.mjs';
import { mergeEntry } from './_merge.mjs';

/** The configuration block that holds the registry, and the file it is written into. */
export const SOURCES_BLOCK = 'memory_sources';
export const SOURCES_FILE_REL = join('.sidekicks', 'config', 'memory.yaml');

/** Source kinds and collision strategies — validated at the edge so a bad value never reaches disk. */
export const SOURCE_KINDS = Object.freeze(['dir', 'git']);
export const STRATEGIES = Object.freeze(['merge', 'skip', 'overwrite']);
export const DEFAULT_STRATEGY = 'merge';

/** Detected shapes, in the order detectShape tries them. */
export const SHAPES = Object.freeze(['export', 'store', 'legacy', 'flat']);

const HEADER = [
  '# .sidekicks/config/memory.yaml — Local memory — external sources',
  '#',
  '# COMMITTED and non-secret. The memory STORE (.sidekicks/memory/) is git-ignored; this file is',
  '# the registry that tells a fresh clone where to sync it back from. Written only by',
  "# `sidekicks memory source add|remove` and `sidekicks config set` — never by hand (Rule 1).",
  '#',
  '# A credential a private source needs (an HTTPS token) belongs in the git-ignored sibling',
  '# memory.secret.yaml, never here.',
];

/**
 * Expand a leading `~` and resolve a source path against the repo root.
 * A source path is the user's own location, so `~` is the form they actually type.
 *
 * @param {string} repoRoot
 * @param {string} p
 * @returns {string} absolute path
 */
export function resolveSourcePath(repoRoot, p) {
  const raw = String(p ?? '').trim();
  if (!raw) return '';
  const expanded = raw === '~' || raw.startsWith(`~${sep}`) || raw.startsWith('~/')
    ? join(homedir(), raw.slice(1).replace(/^[\\/]/, ''))
    : raw;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(repoRoot, expanded);
}

/**
 * Render a path back into the most PORTABLE form that still resolves — repo-relative when it is
 * inside the repo, `~`-prefixed when it is under the home directory, absolute otherwise.
 *
 * The registry is committed and read on other machines, so a persisted `/Users/<someone>/…` is a
 * path that resolves for exactly one person. `~/memory` resolves for all of them.
 *
 * @param {string} repoRoot
 * @param {string} raw - the path as the user typed it (already `~`-expanded by the shell or not)
 * @returns {string}
 */
export function portableSourcePath(repoRoot, raw) {
  const typed = String(raw ?? '').trim();
  if (!typed) return '';
  // A path the user already typed portably stays exactly as typed.
  if (typed.startsWith('~') || !isAbsolute(typed)) return typed.replace(/\\/g, '/');
  const abs = resolve(typed);
  const inRepo = relative(repoRoot, abs);
  if (inRepo && !inRepo.startsWith('..') && !isAbsolute(inRepo)) return inRepo.replace(/\\/g, '/');
  const inHome = relative(homedir(), abs);
  if (inHome && !inHome.startsWith('..') && !isAbsolute(inHome)) return `~/${inHome.replace(/\\/g, '/')}`;
  return abs;
}

/**
 * Read the source registry. A missing block is never an error — it means no source is registered
 * yet, which is the state every checkout starts in.
 *
 * @param {string} repoRoot
 * @returns {{ default_strategy: string, sources: Array<object> }}
 */
export function readSources(repoRoot) {
  let cfg = {};
  try {
    cfg = resolveBlock(repoRoot, SOURCES_BLOCK).config ?? {};
  } catch {
    // Block undeclared (an older checkout of lib/config-store) — behave as "no sources".
    cfg = {};
  }
  const raw = Array.isArray(cfg.sources) ? cfg.sources : [];
  const sources = raw
    .filter((s) => s && typeof s === 'object' && typeof s.name === 'string' && s.name)
    .map((s) => ({
      name: String(s.name),
      kind: SOURCE_KINDS.includes(s.kind) ? s.kind : 'dir',
      path: typeof s.path === 'string' ? s.path : '',
      url: typeof s.url === 'string' ? s.url : '',
      ref: typeof s.ref === 'string' && s.ref ? s.ref : 'main',
      subdir: typeof s.subdir === 'string' ? s.subdir : '',
      namespaces: Array.isArray(s.namespaces) && s.namespaces.length
        ? s.namespaces.map(String)
        : ['*'],
      as: typeof s.as === 'string' ? s.as : '',
    }));
  const strategy = STRATEGIES.includes(cfg.default_strategy) ? cfg.default_strategy : DEFAULT_STRATEGY;
  return { default_strategy: strategy, sources };
}

/**
 * Write the registry back through the config writer — one writer path, so the file keeps its
 * banner and never grows a duplicate key.
 *
 * @param {string} repoRoot
 * @param {{ default_strategy: string, sources: Array<object> }} value
 * @returns {{ path: string, created: boolean }}
 */
export function writeSources(repoRoot, value) {
  const body = {
    default_strategy: value.default_strategy ?? DEFAULT_STRATEGY,
    sources: (value.sources ?? []).map((s) => {
      const row = { name: s.name, kind: s.kind };
      if (s.kind === 'git') {
        row.url = s.url ?? '';
        row.ref = s.ref || 'main';
      } else {
        row.path = s.path ?? '';
      }
      if (s.subdir) row.subdir = s.subdir;
      row.namespaces = s.namespaces && s.namespaces.length ? s.namespaces : ['*'];
      if (s.as) row.as = s.as;
      return row;
    }),
  };
  const out = writeBlock(repoRoot, SOURCES_FILE_REL, SOURCES_BLOCK, body, { header: HEADER });
  return { path: out.path, created: out.created };
}

/**
 * Find one registered source by name, or throw with the names that do exist.
 *
 * @param {string} repoRoot
 * @param {string} name
 * @returns {object}
 */
export function requireSource(repoRoot, name) {
  const { sources } = readSources(repoRoot);
  const found = sources.find((s) => s.name === name);
  if (!found) {
    const have = sources.map((s) => s.name);
    throw new SidekicksError(
      `memory: no source '${name}' is registered${have.length ? ` — have: ${have.join(', ')}` : ''}`
        + " — register one with 'sidekicks memory source add <name> --kind dir --path <p>'",
      EXIT_NOT_FOUND
    );
  }
  return found;
}

/** Where a git source's working clone is cached — derived state, git-ignored, safe to delete. */
export function sourceCacheDir(repoRoot, name) {
  return join(repoRoot, '.sidekicks', 'state', 'memory-sources', name);
}

/**
 * Run one git command against a directory. `shell: false` on purpose — a source URL is user data
 * and must never reach a shell.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ ok: boolean, stdout: string, stderr: string, status: number|null }}
 */
export function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, shell: false, encoding: 'utf8' });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? r.error?.message ?? '').trim(),
  };
}

/**
 * Bring a source's working directory up to date and return it.
 *
 * `dir` sources resolve to the path as given. `git` sources clone into the state cache on first
 * use and fetch + hard-reset onto the tracked ref afterwards — the cache is derived, so a reset is
 * the correct repair, not a data loss.
 *
 * @param {string} repoRoot
 * @param {object} source
 * @param {{ offline?: boolean }} [opts] - offline reuses an existing clone without touching the network
 * @returns {{ dir: string, refreshed: boolean, head: string|null, note: string|null }}
 */
export function refreshSource(repoRoot, source, opts = {}) {
  if (source.kind === 'dir') {
    const dir = resolveSourcePath(repoRoot, source.path);
    if (!dir || !existsSync(dir)) {
      throw new SidekicksError(
        `memory source '${source.name}': '${source.path}' does not exist`,
        EXIT_NOT_FOUND
      );
    }
    const inner = source.subdir ? join(dir, source.subdir) : dir;
    return { dir: inner, refreshed: false, head: null, note: null };
  }

  if (!source.url) {
    throw new SidekicksError(`memory source '${source.name}': kind 'git' needs a --url`, EXIT_VALIDATION);
  }
  const cache = sourceCacheDir(repoRoot, source.name);
  const ref = source.ref || 'main';
  let note = null;

  if (!existsSync(join(cache, '.git'))) {
    if (opts.offline) {
      throw new SidekicksError(
        `memory source '${source.name}': no local clone yet and --offline was requested`,
        EXIT_GIT
      );
    }
    mkdirp(dirname(cache));
    const cloned = git(['clone', '--quiet', source.url, cache], repoRoot);
    if (!cloned.ok) {
      throw new SidekicksError(
        `memory source '${source.name}': clone failed — ${cloned.stderr || `git exited ${cloned.status}`}`,
        EXIT_GIT
      );
    }
    note = 'cloned';
  } else if (!opts.offline) {
    const fetched = git(['fetch', '--quiet', 'origin', ref], cache);
    if (!fetched.ok) {
      // A source that is unreachable right now is a degraded read, not a failure: the cached clone
      // still carries the last state anyone published, and refusing would make a flaky network
      // look like missing memory.
      note = `fetch failed (${fetched.stderr || `git exited ${fetched.status}`}) — using the cached clone`;
    } else {
      note = 'fetched';
    }
  } else {
    note = 'offline — using the cached clone';
  }

  if (note === 'cloned' || note === 'fetched') {
    const checkedOut = git(['checkout', '--quiet', '-B', ref, `origin/${ref}`], cache);
    if (!checkedOut.ok) {
      // A brand-new remote has no branch yet; leave whatever HEAD the clone produced.
      note = `${note} (ref '${ref}' not on origin yet)`;
    }
  }

  const head = git(['rev-parse', '--short', 'HEAD'], cache);
  const inner = source.subdir ? join(cache, source.subdir) : cache;
  return { dir: inner, refreshed: true, head: head.ok ? head.stdout : null, note };
}

/** Is this file text an entry (frontmatter with a `name`)? */
function isEntryText(text) {
  const { frontmatter } = parseEntryFile(text);
  return !!(frontmatter && typeof frontmatter === 'object' && frontmatter.name);
}

/** Entry-looking `*.md` filenames in a directory (never MEMORY.md / README.md). */
function entryFileNames(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'README.md')
    .sort(byCodeUnit);
}

/**
 * Infer a namespace from a path that looks like a pre-central store — `projects/<p>/memory` or
 * `.sidekicks/agents/<n>/memory`. Returns null when the path says nothing.
 *
 * @param {string} dir - absolute
 * @returns {string|null}
 */
export function namespaceFromLegacyPath(dir) {
  const parts = String(dir).split(/[\\/]/).filter(Boolean);
  const i = parts.lastIndexOf('memory');
  if (i < 2) return null;
  const owner = parts[i - 1];
  const group = parts[i - 2];
  if (!SLUG_RE.test(owner)) return null;
  if (group === 'projects') return `projects/${owner}`;
  if (group === 'agents') return `agents/${owner}`;
  return null;
}

/**
 * Understand a folder: which shape it is, and every entry it offers with the namespace that entry
 * belongs to. Reading stops at detection + enumeration — nothing here writes.
 *
 * @param {string} dir - absolute path to the source folder
 * @param {{ namespace?: string|null, as?: string|null }} [opts]
 *   namespace — the namespace to use when the folder itself does not say (flat shape)
 *   as        — remap: every enumerated namespace is replaced by this one
 * @returns {{
 *   shape: string, dir: string, evidenceRoot: string|null,
 *   items: Array<{ namespace: string, slug: string, path: string }>,
 *   rejected: string[],
 * }}
 */
export function detectShape(dir, opts = {}) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new SidekicksError(`memory: '${dir}' is not a directory`, EXIT_NOT_FOUND);
  }
  const rejected = [];
  const items = [];
  const remap = opts.as ? String(opts.as) : null;
  const push = (namespace, slug, path) => {
    items.push({ namespace: remap ?? namespace, slug, path });
  };

  const collectFlat = (from, namespace) => {
    for (const f of entryFileNames(from)) {
      const slug = f.slice(0, -3);
      const abs = join(from, f);
      if (!SLUG_RE.test(slug)) { rejected.push(`${f} (not a kebab-case slug)`); continue; }
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch { rejected.push(`${f} (unreadable)`); continue; }
      if (!isEntryText(text)) { rejected.push(`${f} (no entry frontmatter)`); continue; }
      push(namespace, slug, abs);
    }
  };

  // 1. An export folder announces itself in its manifest.
  const manifestPath = join(dir, 'index.json');
  let manifest = null;
  if (existsSync(manifestPath)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { manifest = null; }
  }
  const manifestShape = manifest && typeof manifest.shape === 'string' ? manifest.shape : null;
  if (manifest && typeof manifest.schema === 'string' && manifest.schema.startsWith('memory-export/')
      && manifestShape !== 'store') {
    // `memory export` emits ONE namespace as a flat entries/ folder. A manifest that declares
    // `shape: store` came from `memory publish`, which mirrors the whole store layout — falling
    // into this branch would read only the root namespace and silently drop every other one.
    const namespace = opts.namespace || manifest.namespace || 'root';
    const entriesDir = existsSync(join(dir, 'entries')) ? join(dir, 'entries') : dir;
    collectFlat(entriesDir, namespace);
    const evidence = existsSync(join(dir, 'evidence')) ? join(dir, 'evidence') : null;
    return { shape: 'export', dir, evidenceRoot: evidence, items, rejected };
  }

  // 2. A live central store: root entries sit at the top level, the other namespaces under store/.
  const storeSub = join(dir, 'store');
  const looksLikeStore = manifestShape === 'store'
    || existsSync(join(dir, 'MEMORY.md')) || existsSync(storeSub);
  if (looksLikeStore) {
    collectFlat(dir, 'root');
    for (const group of ['projects', 'agents']) {
      const groupDir = join(storeSub, group);
      if (!existsSync(groupDir)) continue;
      let names = [];
      try {
        names = readdirSync(groupDir, { withFileTypes: true })
          .filter((d) => d.isDirectory()).map((d) => d.name).sort(byCodeUnit);
      } catch { names = []; }
      for (const n of names) collectFlat(join(groupDir, n), `${group}/${n}`);
    }
    const evidence = existsSync(join(dir, 'evidence')) ? join(dir, 'evidence') : null;
    return { shape: 'store', dir, evidenceRoot: evidence, items, rejected };
  }

  // 3. A dormant pre-central tree names its namespace in its own path.
  const legacy = namespaceFromLegacyPath(dir);
  if (legacy && !opts.namespace) {
    collectFlat(dir, legacy);
    return { shape: 'legacy', dir, evidenceRoot: null, items, rejected };
  }

  // 4. Anything else is a flat folder of entries and the caller has to say where they go.
  const namespace = opts.namespace || legacy;
  if (!namespace) {
    throw new SidekicksError(
      `memory: '${basename(dir)}' is a plain folder of entries — pass --namespace `
        + '<root|projects/<p>|agents/<n>> to say where they belong',
      EXIT_VALIDATION
    );
  }
  collectFlat(dir, namespace);
  return { shape: 'flat', dir, evidenceRoot: null, items, rejected };
}

/** Does a namespace pass a source's `namespaces:` filter? `*` matches everything. */
export function namespaceAllowed(namespace, filter) {
  const list = Array.isArray(filter) && filter.length ? filter : ['*'];
  return list.includes('*') || list.includes(namespace);
}

/**
 * Apply enumerated entries to the local store under one collision strategy.
 *
 * merge (default) — reuse the semantic entry merge the git driver uses: links union, `rule: true`
 *                   wins, earliest `created`, bodies unioned and stamped `metadata.merge_review`.
 *                   Nothing is lost, and `memory doctor` lists what still needs reading.
 * skip            — the local entry always wins; the incoming one is reported by name.
 * overwrite       — the incoming entry replaces the local one wholesale.
 *
 * The caller regenerates the store faces once, after every source has been applied — regenerating
 * per entry would rescan the whole store for each file.
 *
 * @param {string} repoRoot
 * @param {Array<{namespace: string, slug: string, path: string}>} items
 * @param {{ strategy?: string, dryRun?: boolean }} [opts]
 * @returns {{ added: string[], merged: string[], skipped: string[], overwritten: string[],
 *            unchanged: string[], rejected: string[], reviews: string[] }}
 */
export function applyEntries(repoRoot, items, opts = {}) {
  const strategy = STRATEGIES.includes(opts.strategy) ? opts.strategy : DEFAULT_STRATEGY;
  const dryRun = opts.dryRun === true;
  const out = {
    added: [], merged: [], skipped: [], overwritten: [], unchanged: [], rejected: [], reviews: [],
  };

  for (const item of items) {
    let incoming;
    try { incoming = readFileSync(item.path, 'utf8'); } catch {
      out.rejected.push(`${item.namespace}/${item.slug} (unreadable)`);
      continue;
    }
    const layer = layerForNamespace(repoRoot, item.namespace);
    const target = join(layer.baseDir, `${item.slug}.md`);
    const label = `${item.namespace}/${item.slug}`;

    if (!existsSync(target)) {
      if (!dryRun) {
        mkdirp(layer.baseDir);
        assertWritable(target, repoRoot);
        writeAtomic(target, incoming);
      }
      out.added.push(label);
      continue;
    }

    const local = readFileSync(target, 'utf8');
    if (local === incoming) { out.unchanged.push(label); continue; }

    if (strategy === 'skip') { out.skipped.push(label); continue; }

    if (strategy === 'overwrite') {
      if (!dryRun) { assertWritable(target, repoRoot); writeAtomic(target, incoming); }
      out.overwritten.push(label);
      continue;
    }

    // merge — no common ancestor is available across two independent stores, so the merge is
    // two-sided: everything both sides carry is kept, and a diverged body is flagged rather than
    // silently picked.
    const result = mergeEntry({ base: null, ours: local, theirs: incoming });
    if (!dryRun) { assertWritable(target, repoRoot); writeAtomic(target, result.text); }
    out.merged.push(label);
    if (result.review) out.reviews.push(label);
  }

  return out;
}

/**
 * Copy an evidence tree into the store, one file at a time (surface-gated).
 * Evidence travels with the entries it anchors — a `source:` pointing at evidence that stayed
 * behind dangles the moment the entry lands here.
 *
 * @param {string} repoRoot
 * @param {string} from - absolute source evidence root
 * @param {string|null} namespace - when set, only that namespace's subtree is copied
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {number} files copied
 */
export function importEvidence(repoRoot, from, namespace, opts = {}) {
  const dryRun = opts.dryRun === true;
  const dest = namespace
    ? join(storeRoot(repoRoot), 'evidence', ...namespace.split('/'))
    : join(storeRoot(repoRoot), 'evidence');
  let n = 0;
  const walk = (src, dst) => {
    let entries;
    try { entries = readdirSync(src, { withFileTypes: true }); } catch { return; }
    if (!dryRun) mkdirp(dst);
    for (const it of entries) {
      const s = join(src, it.name);
      const d = join(dst, it.name);
      if (it.isDirectory()) { walk(s, d); continue; }
      try {
        if (!dryRun) {
          assertWritable(d, repoRoot);
          writeAtomic(d, readFileSync(s, 'utf8'));
        }
        n += 1;
      } catch { /* skip unreadable/unwritable */ }
    }
  };
  if (existsSync(from)) walk(from, dest);
  return n;
}
