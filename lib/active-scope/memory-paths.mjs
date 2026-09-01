// lib/active-scope/memory-paths.mjs
// Resolve the CENTRAL local-memory store: one tree, several namespaces.
//
// ONE STORE (rev 2). Everything the memory verbs read or write lives under
// `.sidekicks/memory/` — always on local disk, always in the framework repo, wholly
// owned by the `sidekicks memory` verbs (Rule 1). The old per-scope locations
// (`projects/<p>/memory/`, `.sidekicks/agents/<n>/memory/`) are no longer read; they
// stay on disk, dormant, and no verb writes to them.
//
// LOCAL, AND GIT-IGNORED (rev 3). The store is not committed: entries belong to a checkout, and
// they reach another one through `sidekicks memory publish` / `memory sync` against a registered
// external source — never through this repo's history. What IS committed is the source registry
// (`.sidekicks/config/memory.yaml`), because a fresh clone with an empty store and no registry
// cannot even name where its knowledge went. Contract: lib/memory-lifecycle/_sources.mjs.
// A git source's working clone is cached, rebuildably, at
// `.sidekicks/state/memory-sources/<name>/` — derived state, safe to delete.
//
//   .sidekicks/memory/
//     <slug>.md                  namespace `root`   — adopted IN PLACE (pre-central entries)
//     MEMORY.md                  ONE human index, grouped namespace -> category
//     index.json                 ONE machine index, whole store
//     graph.json                 knowledge-graph adjacency
//     triggers.yaml              category trigger registry
//     store/projects/<p>/<slug>.md   namespace `projects/<p>`
//     store/agents/<n>/<slug>.md     namespace `agents/<n>`
//     evidence/<namespace>/<slug>/…  durable lineage snapshots
//
// SCOPE IS A NAMESPACE, NOT A LOCATION. The resolution semantics are unchanged:
//   - root project `sidekicks` (default) → namespace `root`
//   - user project `<active>`            → namespace `projects/<active>`, inheriting root
// resolveMemoryChain() returns the ordered lookup chain (most-specific first):
//   - root active    → [root]
//   - project active → [project, root]
// Read verbs merge over this chain with the project layer winning on a name collision;
// write verbs act on the ACTIVE layer only. A named agent's namespace does NOT inherit —
// an agent's memory is its own brain, not a scope layer.
//
// Pure: takes an already-read settings object and the repoRoot, derives the scope with
// resolveEffectiveScope (no FS), and returns BOTH absolute paths and their repo-relative
// forms (for display / recording — no absolute home paths).
//
// Zero npm dependencies — node:path only (plus lib/ back-edges).

import { join, relative } from 'node:path';
import { resolveEffectiveScope } from './scope.mjs';

/** The central store's own file names — every consumer resolves them from here. */
export const STORE_DIR_NAME = 'memory';
export const HUMAN_INDEX_NAME = 'MEMORY.md';
export const MACHINE_INDEX_NAME = 'index.json';
export const GRAPH_NAME = 'graph.json';
export const TRIGGERS_NAME = 'triggers.yaml';

/**
 * Convert an absolute path to a repo-relative, forward-slash-normalized form.
 * `.` denotes the repo root itself. Mirrors the index's toRepoRelative convention.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string} abs      - Absolute path to convert.
 * @returns {string}
 */
function toRepoRelative(repoRoot, abs) {
  const rel = relative(repoRoot, abs);
  const normalized = rel.replace(/\\/g, '/');
  return normalized === '' ? '.' : normalized;
}

/**
 * The central store root: `<repoRoot>/.sidekicks/memory`.
 * @param {string} repoRoot
 * @returns {string}
 */
export function storeRoot(repoRoot) {
  return join(repoRoot, '.sidekicks', STORE_DIR_NAME);
}

/** Absolute path to the ONE human index (`.sidekicks/memory/MEMORY.md`). */
export function humanIndexPath(repoRoot) {
  return join(storeRoot(repoRoot), HUMAN_INDEX_NAME);
}

/** Absolute path to the ONE machine index (`.sidekicks/memory/index.json`). */
export function machineIndexPath(repoRoot) {
  return join(storeRoot(repoRoot), MACHINE_INDEX_NAME);
}

/** Absolute path to the knowledge graph (`.sidekicks/memory/graph.json`). */
export function graphPath(repoRoot) {
  return join(storeRoot(repoRoot), GRAPH_NAME);
}

/** Absolute path to the trigger registry (`.sidekicks/memory/triggers.yaml`). */
export function triggersPath(repoRoot) {
  return join(storeRoot(repoRoot), TRIGGERS_NAME);
}

/**
 * Absolute path to an entry's evidence folder
 * (`.sidekicks/memory/evidence/<namespace>/<slug>/`).
 *
 * @param {string} repoRoot
 * @param {string} namespace - 'root' | 'projects/<p>' | 'agents/<n>'
 * @param {string} slug
 * @returns {string}
 */
export function evidenceDir(repoRoot, namespace, slug) {
  return join(storeRoot(repoRoot), 'evidence', ...String(namespace).split('/'), slug);
}

/**
 * Absolute path to a namespace's entry directory.
 *
 * `root` is deliberately the store root itself: the pre-central root entries were
 * already `.sidekicks/memory/*.md`, so adopting them in place costs nothing and keeps
 * every existing entry live. Only the project and agent namespaces moved.
 *
 * @param {string} repoRoot
 * @param {string} namespace - 'root' | 'projects/<p>' | 'agents/<n>'
 * @returns {string}
 */
export function namespaceDir(repoRoot, namespace) {
  const ns = String(namespace);
  if (ns === 'root') return storeRoot(repoRoot);
  return join(storeRoot(repoRoot), 'store', ...ns.split('/'));
}

/**
 * Build one memory layer descriptor.
 *
 * @param {string} repoRoot
 * @param {'root'|'project'|'agent'} kind
 * @param {string|null} name - the user-project name (kind 'project') or agent name (kind 'agent')
 * @returns {{
 *   kind: 'root'|'project'|'agent',
 *   namespace: string,      // 'root' | 'projects/<p>' | 'agents/<n>' — the index/graph key
 *   baseDir: string,        // absolute path to this namespace's entry directory
 *   indexPath: string,      // absolute path to the ONE central MEMORY.md
 *   scopeLabel: string,     // human label, e.g. "sidekicks (root)" / "alpha" / "agent:debby"
 *   baseDirRel: string,     // repo-relative form of baseDir
 *   indexPathRel: string,   // repo-relative form of indexPath
 * }}
 */
function buildLayer(repoRoot, kind, name) {
  let namespace;
  let scopeLabel;
  if (kind === 'root') {
    namespace = 'root';
    scopeLabel = 'sidekicks (root)';
  } else if (kind === 'agent') {
    namespace = `agents/${name}`;
    scopeLabel = `agent:${name}`;
  } else {
    namespace = `projects/${name}`;
    scopeLabel = String(name);
  }
  const baseDir = namespaceDir(repoRoot, namespace);
  // ONE index for the whole store — every layer points at the same file.
  const indexPath = humanIndexPath(repoRoot);
  return {
    kind,
    namespace,
    baseDir,
    indexPath,
    scopeLabel,
    baseDirRel: toRepoRelative(repoRoot, baseDir),
    indexPathRel: toRepoRelative(repoRoot, indexPath),
  };
}

/**
 * Resolve the memory layer for the ACTIVE scope.
 * This is the layer that `add` / `remove` / `rebuild` write to.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {object} settings - Parsed .sidekicks/settings.json (may be {}).
 * @returns {ReturnType<typeof buildLayer>}
 */
export function resolveMemoryDir(repoRoot, settings) {
  const scope = resolveEffectiveScope(settings);
  const kind = scope.projectName === 'sidekicks' ? 'root' : 'project';
  return buildLayer(repoRoot, kind, scope.projectName);
}

/**
 * Resolve the ordered INHERITANCE CHAIN of memory layers — most-specific first.
 *   - root active    → [root]
 *   - project active → [project, root]
 * Read verbs merge over this with index 0 (the active/project layer) winning a
 * name collision; the root layer is the inherited shared base.
 *
 * @param {string} repoRoot
 * @param {object} settings
 * @returns {{
 *   active: ReturnType<typeof buildLayer>,   // chain[0]
 *   root: ReturnType<typeof buildLayer>,     // the base layer (=== active when root is active)
 *   chain: Array<ReturnType<typeof buildLayer>>,
 *   inherits: boolean,                       // true when a project inherits root
 * }}
 */
export function resolveMemoryChain(repoRoot, settings) {
  const active = resolveMemoryDir(repoRoot, settings);
  if (active.kind === 'root') {
    return { active, root: active, chain: [active], inherits: false };
  }
  const root = buildLayer(repoRoot, 'root', null);
  return { active, root, chain: [active, root], inherits: true };
}

/**
 * Resolve a NAMED AGENT's memory layer — the `--agent <name>` override on the memory
 * verbs. Pure path building; the verb validates the agent's charter exists before
 * writing. Agent memory does not inherit root: chain = [agent] only.
 *
 * @param {string} repoRoot
 * @param {string} agentName
 * @returns {ReturnType<typeof buildLayer>}
 */
export function resolveAgentMemoryDir(repoRoot, agentName) {
  return buildLayer(repoRoot, 'agent', agentName);
}

/**
 * Resolve the ROOT layer directly, without consulting the active scope.
 * Used by whole-store operations (index/graph rebuild, map, query).
 *
 * @param {string} repoRoot
 * @returns {ReturnType<typeof buildLayer>}
 */
export function resolveRootMemoryDir(repoRoot) {
  return buildLayer(repoRoot, 'root', null);
}

/**
 * Build a layer descriptor from a namespace key — the inverse of `layer.namespace`.
 * Whole-store readers hold namespace strings (from index.json) and need the paths back.
 *
 * @param {string} repoRoot
 * @param {string} namespace - 'root' | 'projects/<p>' | 'agents/<n>'
 * @returns {ReturnType<typeof buildLayer>}
 */
export function layerForNamespace(repoRoot, namespace) {
  const ns = String(namespace);
  if (ns === 'root') return buildLayer(repoRoot, 'root', null);
  const [head, ...rest] = ns.split('/');
  const name = rest.join('/');
  if (head === 'agents') return buildLayer(repoRoot, 'agent', name);
  return buildLayer(repoRoot, 'project', name);
}
