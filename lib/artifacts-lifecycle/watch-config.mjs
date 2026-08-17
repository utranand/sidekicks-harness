// lib/artifacts-lifecycle/watch-config.mjs
// Centralized configuration of WHICH artifact folders the running-agents monitor watches.
//
// Skills can anchor run state outside the standard `<base>/artifacts/runs` bases
// (artifacts_dir overrides, plan-centric trees like
// `projects/<p>/docs/implementation-plans/<impl>/artifacts/runs`). This module reads the
// dedicated ROOT-ONLY config `.sidekicks/agents-watch.yaml` — a separate file from
// agents-liveness.yaml (thresholds/debounce) so "which folders to watch" and "how staleness
// is judged" evolve independently — and resolves its `watch_roots` entries into concrete
// on-disk runs-roots the inventory scan folds in. The SAME file is read by the office-viz
// generator, so the artifact-manager's monitoring coverage and the live office UI always
// watch the same folders.
//
// A MISSING or unparseable file is never an error — no config means no extra roots, and the
// standard bases are always scanned regardless (fresh clone needs no config). Zero npm
// dependencies: node:* + the repo's own yaml-subset parser. macOS + Windows portable
// (path.join, CRLF-tolerant, `/`-normalized repo-relative output).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { parse } from '../yaml-subset/yaml.mjs';
import { frameworkConfigPath, frameworkConfigRel, CONFIG_DIR } from '../config-store/paths.mjs';

// Repo-relative location of the dedicated config file (documented in agents-watch.example.yaml).
// It is FRAMEWORK CONFIGURATION, so it lives with the rest of it in `.sidekicks/config/`; a checkout
// that still keeps it at the old top-level path is read from there (see watchConfigPath).
export const WATCH_CONFIG_REL = `.sidekicks/${CONFIG_DIR}/agents-watch.yaml`;

/** Absolute path to the config file for a repo root (new location first, legacy as fallback). */
export function watchConfigPath(repoRoot) {
  return frameworkConfigPath(repoRoot, 'agents-watch.yaml');
}

/** The same path, repo-relative — for reports, which may never carry a machine-absolute path. */
export function watchConfigRel(repoRoot) {
  return frameworkConfigRel(repoRoot, 'agents-watch.yaml');
}

/**
 * Read the raw watch config. Always returns a complete object — never throws.
 * `watchRoots` entries keep their configured shape: a repo-relative path string (may carry
 * single-segment `*` wildcards), or `{ path, dept }` to pin the scope/department label.
 *
 * @param {string} repoRoot
 * @returns {{ enabled: boolean, watchRoots: Array<string|{path:string,dept?:string}>, source: 'file'|'default' }}
 */
export function readWatchConfig(repoRoot) {
  const defaults = { enabled: true, watchRoots: [], source: 'default' };
  const p = watchConfigPath(repoRoot);
  let raw;
  try {
    if (!existsSync(p)) return defaults;
    raw = parse(readFileSync(p, 'utf8').replace(/\r\n?/g, '\n'));
  } catch {
    return defaults; // an unparseable hand-edited file must never break scan / hooks
  }
  if (!raw || typeof raw !== 'object') return defaults;

  // Prefer the `agents_watch:` block; tolerate a flat file that omits the wrapper.
  const b = (raw.agents_watch && typeof raw.agents_watch === 'object') ? raw.agents_watch : raw;
  const roots = Array.isArray(b.watch_roots) ? b.watch_roots.filter((e) => {
    if (typeof e === 'string') return e.trim() !== '';
    return e && typeof e === 'object' && typeof e.path === 'string' && e.path.trim() !== '';
  }) : [];
  return {
    // enabled defaults true; only an explicit `false` opts the extra roots out.
    enabled: b.enabled === false ? false : true,
    watchRoots: roots,
    source: 'file',
  };
}

function dirs(p) {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Expand single-segment `*` wildcards in a repo-relative path against the filesystem
 * (a `*` segment matches every child directory at that level — one resolved path per
 * plan tree, say). No `**`; a literal segment must exist to keep matching. Returns
 * absolute paths. Mirrors the office-viz generator's expansion so both consumers
 * resolve a pattern identically.
 *
 * @param {string} repoRoot
 * @param {string} pattern
 * @returns {string[]}
 */
export function expandWatchPattern(repoRoot, pattern) {
  const segs = String(pattern).split('/').filter(Boolean);
  let acc = [repoRoot];
  for (const seg of segs) {
    const next = [];
    for (const base of acc) {
      if (seg === '*') for (const d of dirs(base)) next.push(join(base, d));
      else if (existsSync(join(base, seg))) next.push(join(base, seg));
    }
    acc = next;
    if (!acc.length) break;
  }
  return acc;
}

/**
 * Resolve the configured entries into concrete, existing runs-roots (children are
 * `<skill>/<slug>/` run dirs). Deduped by resolved absolute path. Each root carries a
 * scope label: the pinned `dept`, else derived from a `projects/<p>/` prefix, else
 * `watch:<rel>` so a watched run is distinguishable from a standard-base run.
 *
 * @param {string} repoRoot
 * @param {Array<string|{path:string,dept?:string}>} [entries] - omit to read the config file
 * @returns {Array<{ dir: string, rel: string, scope: string }>}
 */
export function resolveWatchRoots(repoRoot, entries) {
  const cfg = entries === undefined ? readWatchConfig(repoRoot) : { enabled: true, watchRoots: entries };
  if (!cfg.enabled) return [];
  const out = [];
  const seen = new Set();
  for (const entry of cfg.watchRoots) {
    const p = typeof entry === 'string' ? entry : entry.path;
    const pinned = (typeof entry === 'object' && entry.dept) ? String(entry.dept) : null;
    const paths = p.includes('*')
      ? expandWatchPattern(repoRoot, p)
      : [isAbsolute(p) ? p : resolve(repoRoot, p)];
    for (const abs of paths) {
      const key = resolve(abs);
      if (seen.has(key) || !existsSync(key)) continue;
      seen.add(key);
      const rel = relative(repoRoot, key).split(sep).join('/');
      let scope = pinned;
      if (!scope) {
        const m = /^projects\/([^/]+)\//.exec(rel);
        scope = m ? `project:${m[1]}` : `watch:${rel}`;
      }
      out.push({ dir: key, rel, scope });
    }
  }
  return out;
}
