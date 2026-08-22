// lib/goal-lifecycle/graph.mjs
// Ordering questions about an already-well-formed plan graph.
//
// DIVISION OF LABOUR with schema.mjs: that module decides whether a document is admissible at all
// (types, unique ids, dependency targets that exist). This module answers "in what order, and what
// may run next", and owns the one structural check that needs a traversal rather than a scan —
// cycles. Keeping cycles here rather than in the validator is deliberate: the traversal that finds a
// cycle is the same traversal that produces the order, so doing it twice would be the only way for
// the two answers to disagree.
//
// DETERMINISM IS THE POINT. Two runs of the same plan must select the same node, in the same order,
// on any machine — a resumed run derives its next action from `run.json` plus this order and nothing
// else. So the topological sort is Kahn's algorithm with a lexicographic tie-break on node id: no
// insertion-order dependence, no Set iteration order leaking into a decision.
//
// Release one executes ONE node at a time (plan.md design constraint 5). `readyNodes` therefore
// returns every eligible node and `selectReadyNode` picks exactly one; the plural form exists
// because a report must be able to say what else was eligible, and because deferred parallel
// execution will consume it unchanged.
//
// Pure computation — no filesystem, no process. Zero npm dependencies.

/** Node states the runner assigns. `plan.json` is immutable; this lives in `run.json`. */
export const NODE_STATES = Object.freeze(['pending', 'running', 'completed', 'failed', 'blocked']);

/**
 * Index a plan's nodes by id.
 *
 * @param {object} plan
 * @returns {Map<string, object>}
 */
export function nodeIndex(plan) {
  /** @type {Map<string, object>} */
  const map = new Map();
  for (const node of Array.isArray(plan?.nodes) ? plan.nodes : []) {
    if (node && typeof node.id === 'string') map.set(node.id, node);
  }
  return map;
}

/**
 * A node's declared dependencies, de-duplicated and sorted.
 *
 * @param {object} node
 * @returns {string[]}
 */
export function dependenciesOf(node) {
  const raw = Array.isArray(node?.depends_on) ? node.depends_on : [];
  return [...new Set(raw.filter((d) => typeof d === 'string'))].sort();
}

/**
 * Deterministic topological order, or the cycle that prevents one.
 *
 * @param {object} plan
 * @returns {{ok: true, order: string[]} | {ok: false, cycle: string[], errors: string[]}}
 */
export function topoOrder(plan) {
  const nodes = nodeIndex(plan);
  /** @type {Map<string, number>} */
  const indegree = new Map();
  /** @type {Map<string, string[]>} */
  const forward = new Map();

  for (const id of nodes.keys()) {
    indegree.set(id, 0);
    forward.set(id, []);
  }
  for (const [id, node] of nodes) {
    for (const dep of dependenciesOf(node)) {
      // An unknown dependency is schema.mjs's error to report; here it simply contributes no edge,
      // so this function stays total rather than throwing on a document already known to be bad.
      if (!nodes.has(dep)) continue;
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      forward.get(dep).push(id);
    }
  }

  // Lexicographic frontier: a plain array kept sorted, not a Set — Set iteration order would make
  // the result depend on insertion history.
  const frontier = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  /** @type {string[]} */
  const order = [];

  while (frontier.length > 0) {
    const id = frontier.shift();
    order.push(id);
    for (const next of forward.get(id).slice().sort()) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) {
        frontier.push(next);
        frontier.sort();
      }
    }
  }

  if (order.length === nodes.size) return { ok: true, order };

  const remaining = [...nodes.keys()].filter((id) => !order.includes(id)).sort();
  const cycle = findCycle(nodes, new Set(remaining));
  return {
    ok: false,
    cycle,
    errors: [
      cycle.length > 0
        ? `nodes: dependency cycle ${cycle.join(' → ')} → ${cycle[0]}`
        : `nodes: dependency cycle among ${remaining.join(', ')}`,
    ],
  };
}

/**
 * One concrete cycle among `candidates`, for a message a human can act on.
 *
 * Reporting the actual ring rather than "there is a cycle somewhere in these nine nodes" is the
 * difference between a fixable planner correction and a re-plan.
 *
 * @param {Map<string, object>} nodes
 * @param {Set<string>} candidates
 * @returns {string[]}
 */
function findCycle(nodes, candidates) {
  /** @type {Map<string, number>} */
  const state = new Map(); // 0 unvisited, 1 on stack, 2 done
  /** @type {string[]} */
  const stack = [];

  const visit = (id) => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return stack.slice(stack.indexOf(id));
    state.set(id, 1);
    stack.push(id);
    for (const dep of dependenciesOf(nodes.get(id))) {
      if (!candidates.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const id of [...candidates].sort()) {
    const found = visit(id);
    if (found) return found;
  }
  return [];
}

/**
 * Structural validation that needs the traversal: cycles.
 *
 * @param {object} plan
 * @returns {{ok: boolean, errors: string[], order: string[]}}
 */
export function validateGraph(plan) {
  const t = topoOrder(plan);
  if (t.ok) return { ok: true, errors: [], order: t.order };
  return { ok: false, errors: t.errors, order: [] };
}

/**
 * Every node eligible to run now, in topological order.
 *
 * A node is eligible when it is not already `completed` and every dependency IS `completed`. A
 * `failed` node is eligible again — that is what "reopen the same node" means, and the attempt
 * budget, not the graph, is what stops a failure from being retried forever.
 *
 * A dependency that is `failed` or `blocked` does NOT make its dependents eligible: work whose
 * foundation did not land must not proceed on the hope that it did.
 *
 * @param {object} plan
 * @param {Record<string, string>} nodeStates - node id → one of NODE_STATES (absent = pending)
 * @returns {string[]}
 */
export function readyNodes(plan, nodeStates = {}) {
  const t = topoOrder(plan);
  if (!t.ok) return [];
  const stateOf = (id) => nodeStates[id] ?? 'pending';
  return t.order.filter((id) => {
    if (stateOf(id) === 'completed') return false;
    if (stateOf(id) === 'running') return false;
    const node = nodeIndex(plan).get(id);
    return dependenciesOf(node).every((dep) => stateOf(dep) === 'completed');
  });
}

/**
 * The ONE node the runner dispatches next, or null when there is none.
 *
 * @param {object} plan
 * @param {Record<string, string>} nodeStates
 * @returns {string|null}
 */
export function selectReadyNode(plan, nodeStates = {}) {
  const ready = readyNodes(plan, nodeStates);
  return ready.length > 0 ? ready[0] : null;
}

/**
 * Is every node in the plan `completed`?
 *
 * @param {object} plan
 * @param {Record<string, string>} nodeStates
 * @returns {boolean}
 */
export function allNodesComplete(plan, nodeStates = {}) {
  const ids = [...nodeIndex(plan).keys()];
  if (ids.length === 0) return false;
  return ids.every((id) => (nodeStates[id] ?? 'pending') === 'completed');
}

/**
 * Nodes that depend on `nodeId`, transitively, in topological order.
 *
 * Reopening a node invalidates the work built on top of it — this is the set a corrective or
 * final-verification reopen has to reconsider.
 *
 * @param {object} plan
 * @param {string} nodeId
 * @returns {string[]}
 */
export function descendantsOf(plan, nodeId) {
  const nodes = nodeIndex(plan);
  /** @type {Set<string>} */
  const hit = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, node] of nodes) {
      if (hit.has(id)) continue;
      const deps = dependenciesOf(node);
      if (deps.includes(nodeId) || deps.some((d) => hit.has(d))) {
        hit.add(id);
        grew = true;
      }
    }
  }
  const t = topoOrder(plan);
  const order = t.ok ? t.order : [...nodes.keys()].sort();
  return order.filter((id) => hit.has(id));
}

/**
 * The criterion ids a node owns, per the plan's own acceptance list.
 *
 * @param {object} plan
 * @param {string} nodeId
 * @returns {string[]}
 */
export function criteriaOf(plan, nodeId) {
  const node = nodeIndex(plan).get(nodeId);
  return (Array.isArray(node?.acceptance) ? node.acceptance : [])
    .map((c) => c?.id)
    .filter((id) => typeof id === 'string');
}
