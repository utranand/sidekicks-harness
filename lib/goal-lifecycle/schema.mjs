// lib/goal-lifecycle/schema.mjs
// The JSON contracts the goal engine reads and writes, and the digests approval is bound to.
//
// WHY THIS IS A HAND-ROLLED VALIDATOR. Sidekicks is zero-dependency by contract, so there is no
// JSON-Schema library to lean on. The alternative — trusting a model's output because it "looks
// like" the shape — is exactly the failure this module exists to prevent: an implementation
// subprocess is dispatched from these structures, so a missing `acceptance` array or a node
// depending on an id that does not exist becomes an unbounded agent run, not a parse error.
//
// WHAT IS DIGESTED, AND WHY IT IS NOT `plan.json`. The user approves an APPROVAL ENVELOPE, not the
// plan alone. A plan digest binds what will be built; it says nothing about which repository, which
// base commit, which write roots, which executor/tier per node, what the budgets are, or which
// criterion belongs to which node. All of those change what an approved run may DO, so all of them
// are inside the canonical envelope, and the envelope's SHA-256 is the value `goal approve` takes.
// Changing any bound field changes the digest and clears approval — with exactly one exception,
// the budget-only amendment below, which exists so raising an attempt limit does not throw away
// completed work.
//
// CANONICALIZATION is borrowed, not re-derived: `canonicalJson` from lib/run-events/schema.mjs
// already sorts object keys by code point and preserves array order, and its portability
// primitives (`findAbsolutePath`) already encode every absolute-path spelling on both supported
// platforms. Two implementations of "the bytes we hash" is one too many.
//
// Zero npm dependencies — node:crypto plus lib/ back-edges only.

import { createHash } from 'node:crypto';
import { canonicalJson, findAbsolutePath } from '../run-events/schema.mjs';

/** The plan/envelope contract version this module reads and writes. */
export const GOAL_SCHEMA_VERSION = 1;

/**
 * Tiers a node may request. Deliberately a LOCAL list rather than an import of the executor
 * registry's `MODEL_TIERS`: this module validates a document's shape and must stay loadable with
 * nothing but the run-events back-edge, while the registry decides what a tier resolves to on this
 * machine. The invoker is where a tier with no mapping fails closed.
 */
export const GOAL_TIERS = Object.freeze(['top', 'high', 'mid', 'low']);

/** Roles a CLI session can be dispatched in. Each maps to a containment profile in Phase B. */
export const GOAL_ROLES = Object.freeze(['plan', 'implement', 'review', 'final-verify']);

/** Complexity marks that let an approved plan pull one node up from the default mid tier. */
export const NODE_COMPLEXITIES = Object.freeze(['normal', 'complex']);

/** Node and criterion ids become path segments and event ref ids — keep them slug-safe. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** An executor name, same charset the cli-executor registry enforces. */
const EXECUTOR_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A bare SHA-256 hex digest — the form `goal approve --digest` takes. */
export const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * The ONLY fields a post-approval envelope amendment may change.
 *
 * Everything else in the envelope describes what the run may do; these describe how much of it it
 * may spend doing so. See {@link classifyAmendment}.
 */
export const BUDGET_FIELDS = Object.freeze([
  'max_attempts_per_node',
  'max_total_attempts',
  'max_wall_clock_ms_per_attempt',
  'max_wall_clock_ms_total',
  'max_consecutive_failures',
]);

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

/**
 * SHA-256 of a value's canonical JSON, as bare lowercase hex.
 *
 * Bare hex rather than `sha256:<hex>` because this is the string a human retypes into
 * `goal approve --digest`; a prefix is one more thing to get wrong at a gate that must not be
 * guessable. Where a digest is stored INSIDE a document it keeps this same bare form, so the two
 * can be compared without normalizing.
 *
 * @param {unknown} value
 * @returns {string} 64 lowercase hex characters
 */
export function digestOf(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * Digest of the immutable goal record.
 *
 * @param {object} goal
 * @returns {string}
 */
export function goalDigest(goal) {
  return digestOf(canonicalGoal(goal));
}

/**
 * Digest of an approved plan graph.
 *
 * @param {object} plan
 * @returns {string}
 */
export function planDigest(plan) {
  return digestOf(canonicalPlan(plan));
}

/**
 * Digest of the approval envelope — the value the user approves.
 *
 * @param {object} envelope
 * @returns {string}
 */
export function envelopeDigest(envelope) {
  return digestOf(canonicalEnvelope(envelope));
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * Is `value` a non-empty single-line string with no machine-absolute path in it?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isLine(value) {
  if (typeof value !== 'string') return false;
  if (value.trim() === '') return false;
  if (/[\r\n]/.test(value)) return false;
  return findAbsolutePath(value) === null;
}

/**
 * Is `value` a non-empty string (newlines allowed) with no machine-absolute path in it?
 *
 * A goal statement, a rationale and a criterion text are prose and may wrap; a machine path in any
 * of them still makes the artifact non-portable, which is the part that matters.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isProse(value) {
  if (typeof value !== 'string') return false;
  if (value.trim() === '') return false;
  return findAbsolutePath(value) === null;
}

/**
 * Normalize a stored path to the one form the engine persists: POSIX separators, no trailing slash.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizePath(value) {
  const posix = String(value).split('\\').join('/');
  if (posix.length > 1 && posix.endsWith('/')) return posix.slice(0, -1);
  return posix;
}

/**
 * Is `value` a repo-relative portable path? `.` is legal (the repo root itself).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPortablePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (/[\r\n]/.test(value)) return false;
  const p = normalizePath(value);
  if (findAbsolutePath(p) !== null) return false;
  if (p.startsWith('/') || p.startsWith('~')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  return !p.split('/').includes('..');
}

/**
 * Validate an array of strings under one field name.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {string[]} errors
 * @param {{ required?: boolean, prose?: boolean }} [opts]
 * @returns {string[]} the validated list (empty when invalid — errors carry the detail)
 */
function stringList(value, field, errors, opts = {}) {
  if (value === undefined || value === null) {
    if (opts.required) errors.push(`${field}: required array of strings`);
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`${field}: must be an array of strings`);
    return [];
  }
  if (opts.required && value.length === 0) {
    errors.push(`${field}: must not be empty`);
  }
  const ok = opts.prose ? isProse : isLine;
  value.forEach((v, i) => {
    if (!ok(v)) {
      errors.push(`${field}[${i}]: must be a non-empty string with no machine-absolute path`);
    }
  });
  return value.filter((v) => ok(v)).map((v) => String(v));
}

// ---------------------------------------------------------------------------
// goal.json — the immutable intake record
// ---------------------------------------------------------------------------

/**
 * Validate the immutable intake record.
 *
 * @param {unknown} goal
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateGoal(goal) {
  /** @type {string[]} */
  const errors = [];
  if (goal === null || typeof goal !== 'object' || Array.isArray(goal)) {
    return { ok: false, errors: ['goal must be a JSON object'] };
  }
  const g = /** @type {Record<string, unknown>} */ (goal);

  if (g.schema_version !== GOAL_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${GOAL_SCHEMA_VERSION}`);
  }
  if (!isLine(g.run_id) || !ID_RE.test(String(g.run_id))) {
    errors.push('run_id must be a slug of [A-Za-z0-9._-] starting alphanumeric');
  }
  if (!isProse(g.goal)) {
    errors.push('goal must be a non-empty statement with no machine-absolute path');
  }
  if (!isLine(g.created_at)) errors.push('created_at must be a timestamp string');
  if (g.work_dir !== undefined && !isPortablePath(g.work_dir)) {
    errors.push('work_dir must be a repo-relative portable path');
  }
  if (g.requested_by !== undefined && !isLine(g.requested_by)) {
    errors.push('requested_by must be a single-line string when present');
  }
  stringList(g.requirement_docs, 'requirement_docs', errors);
  if (Array.isArray(g.requirement_docs)) {
    g.requirement_docs.forEach((p, i) => {
      if (!isPortablePath(p)) errors.push(`requirement_docs[${i}]: must be a repo-relative path`);
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The canonical (digested) projection of a goal record.
 *
 * `created_at` is deliberately EXCLUDED: two runs of the same goal in the same repo must produce
 * the same goal digest, and a clock reading is not part of what was asked for.
 *
 * @param {object} goal
 * @returns {object}
 */
export function canonicalGoal(goal) {
  const g = goal || {};
  return {
    schema_version: GOAL_SCHEMA_VERSION,
    goal: String(g.goal ?? ''),
    work_dir: normalizePath(g.work_dir ?? '.'),
    requirement_docs: (Array.isArray(g.requirement_docs) ? g.requirement_docs : [])
      .map((p) => normalizePath(p)),
  };
}

// ---------------------------------------------------------------------------
// plan.json — the immutable approved graph
// ---------------------------------------------------------------------------

/**
 * Validate the planning contract, structurally and referentially.
 *
 * Referential checks (dependency targets exist, criterion owners exist, ids are unique) live here
 * rather than in graph.mjs so that ONE call decides whether a model's output is admissible at all;
 * graph.mjs then answers ordering questions about a document already known to be well-formed.
 * Cycle detection is graph.mjs's job — see {@link ../goal-lifecycle/graph.mjs}.
 *
 * @param {unknown} plan
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validatePlan(plan) {
  /** @type {string[]} */
  const errors = [];
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, errors: ['plan must be a JSON object'] };
  }
  const p = /** @type {Record<string, unknown>} */ (plan);

  if (p.schema_version !== GOAL_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${GOAL_SCHEMA_VERSION}`);
  }
  if (!isProse(p.goal)) errors.push('goal must be a non-empty statement');

  stringList(p.assumptions, 'assumptions', errors, { prose: true });
  stringList(p.risks, 'risks', errors, { prose: true });
  stringList(p.out_of_scope, 'out_of_scope', errors, { prose: true });

  if (p.decisions !== undefined) {
    if (!Array.isArray(p.decisions)) {
      errors.push('decisions: must be an array of {choice, why, rejected[]}');
    } else {
      p.decisions.forEach((d, i) => {
        if (d === null || typeof d !== 'object' || Array.isArray(d)) {
          errors.push(`decisions[${i}]: must be an object`);
          return;
        }
        if (!isProse(d.choice)) errors.push(`decisions[${i}].choice: required non-empty string`);
        if (!isProse(d.why)) errors.push(`decisions[${i}].why: required non-empty string`);
        stringList(d.rejected, `decisions[${i}].rejected`, errors, { prose: true });
      });
    }
  }

  if (!Array.isArray(p.nodes) || p.nodes.length === 0) {
    errors.push('nodes: must be a non-empty array of implementation nodes');
    return { ok: errors.length === 0, errors };
  }

  /** @type {Set<string>} */
  const nodeIds = new Set();
  /** @type {Set<string>} */
  const criterionIds = new Set();

  p.nodes.forEach((node, i) => {
    const at = `nodes[${i}]`;
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const n = /** @type {Record<string, unknown>} */ (node);

    if (typeof n.id !== 'string' || !ID_RE.test(n.id)) {
      errors.push(`${at}.id: must be a slug of [A-Za-z0-9._-] starting alphanumeric`);
    } else if (nodeIds.has(n.id)) {
      errors.push(`${at}.id: duplicate node id ${JSON.stringify(n.id)}`);
    } else {
      nodeIds.add(n.id);
    }

    if (!isProse(n.title)) errors.push(`${at}.title: required non-empty string`);

    if (n.depends_on !== undefined) {
      if (!Array.isArray(n.depends_on)) {
        errors.push(`${at}.depends_on: must be an array of node ids`);
      } else {
        n.depends_on.forEach((dep, j) => {
          if (typeof dep !== 'string' || !ID_RE.test(dep)) {
            errors.push(`${at}.depends_on[${j}]: must be a node id`);
          } else if (dep === n.id) {
            errors.push(`${at}.depends_on[${j}]: a node may not depend on itself`);
          }
        });
      }
    }

    if (!isPortablePath(n.work_dir ?? '.')) {
      errors.push(`${at}.work_dir: must be a repo-relative portable path`);
    }
    if (typeof n.executor !== 'string' || !EXECUTOR_RE.test(n.executor)) {
      errors.push(`${at}.executor: must be a registered executor name`);
    }
    if (!GOAL_TIERS.includes(/** @type {string} */ (n.tier))) {
      errors.push(`${at}.tier: must be one of ${GOAL_TIERS.join(', ')}`);
    }
    if (n.complexity !== undefined && !NODE_COMPLEXITIES.includes(/** @type {string} */ (n.complexity))) {
      errors.push(`${at}.complexity: must be one of ${NODE_COMPLEXITIES.join(', ')}`);
    }

    if (!Array.isArray(n.affected_paths) || n.affected_paths.length === 0) {
      errors.push(`${at}.affected_paths: must be a non-empty array of repo-relative paths`);
    } else {
      n.affected_paths.forEach((path, j) => {
        if (!isPortablePath(path)) {
          errors.push(`${at}.affected_paths[${j}]: must be a repo-relative portable path`);
        }
      });
    }

    if (!Array.isArray(n.acceptance) || n.acceptance.length === 0) {
      errors.push(`${at}.acceptance: must be a non-empty array of criteria`);
    } else {
      n.acceptance.forEach((c, j) => {
        const cat = `${at}.acceptance[${j}]`;
        if (c === null || typeof c !== 'object' || Array.isArray(c)) {
          errors.push(`${cat}: must be an object with id, text and owner_node`);
          return;
        }
        const cc = /** @type {Record<string, unknown>} */ (c);
        if (typeof cc.id !== 'string' || !ID_RE.test(cc.id)) {
          errors.push(`${cat}.id: must be a slug of [A-Za-z0-9._-]`);
        } else if (criterionIds.has(cc.id)) {
          errors.push(`${cat}.id: duplicate criterion id ${JSON.stringify(cc.id)}`);
        } else {
          criterionIds.add(cc.id);
        }
        if (!isProse(cc.text)) errors.push(`${cat}.text: required non-empty string`);
        // owner_node is what final verification reopens on a rejected criterion, so it must name a
        // node — an unowned criterion is a verdict nobody can act on.
        if (typeof cc.owner_node !== 'string' || !ID_RE.test(cc.owner_node)) {
          errors.push(`${cat}.owner_node: must name the node that owns this criterion`);
        }
      });
    }

    stringList(n.tests, `${at}.tests`, errors);
  });

  // Referential pass — needs every id collected first.
  p.nodes.forEach((node, i) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    const n = /** @type {Record<string, unknown>} */ (node);
    const at = `nodes[${i}]`;
    if (Array.isArray(n.depends_on)) {
      n.depends_on.forEach((dep, j) => {
        if (typeof dep === 'string' && !nodeIds.has(dep)) {
          errors.push(`${at}.depends_on[${j}]: unknown node id ${JSON.stringify(dep)}`);
        }
      });
    }
    if (Array.isArray(n.acceptance)) {
      n.acceptance.forEach((c, j) => {
        if (c && typeof c === 'object' && typeof c.owner_node === 'string' && !nodeIds.has(c.owner_node)) {
          errors.push(
            `${at}.acceptance[${j}].owner_node: unknown node id ${JSON.stringify(c.owner_node)}`,
          );
        }
      });
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * The canonical (digested) projection of a plan.
 *
 * Only the fields that change what will be BUILT are included, in a fixed shape with defaults
 * applied, so a plan re-serialized by a different writer digests identically. Prose fields are
 * included too: `out_of_scope` is a commitment, and a silent edit to it is a scope change.
 *
 * @param {object} plan
 * @returns {object}
 */
export function canonicalPlan(plan) {
  const p = plan || {};
  return {
    schema_version: GOAL_SCHEMA_VERSION,
    goal: String(p.goal ?? ''),
    assumptions: (Array.isArray(p.assumptions) ? p.assumptions : []).map((s) => String(s)),
    decisions: (Array.isArray(p.decisions) ? p.decisions : []).map((d) => ({
      choice: String(d?.choice ?? ''),
      why: String(d?.why ?? ''),
      rejected: (Array.isArray(d?.rejected) ? d.rejected : []).map((s) => String(s)),
    })),
    nodes: (Array.isArray(p.nodes) ? p.nodes : []).map((n) => ({
      id: String(n?.id ?? ''),
      title: String(n?.title ?? ''),
      depends_on: (Array.isArray(n?.depends_on) ? n.depends_on : []).map((s) => String(s)),
      work_dir: normalizePath(n?.work_dir ?? '.'),
      executor: String(n?.executor ?? ''),
      tier: String(n?.tier ?? ''),
      complexity: String(n?.complexity ?? 'normal'),
      affected_paths: (Array.isArray(n?.affected_paths) ? n.affected_paths : [])
        .map((s) => normalizePath(s)),
      acceptance: (Array.isArray(n?.acceptance) ? n.acceptance : []).map((c) => ({
        id: String(c?.id ?? ''),
        text: String(c?.text ?? ''),
        owner_node: String(c?.owner_node ?? ''),
      })),
      tests: (Array.isArray(n?.tests) ? n.tests : []).map((s) => String(s)),
    })),
    risks: (Array.isArray(p.risks) ? p.risks : []).map((s) => String(s)),
    out_of_scope: (Array.isArray(p.out_of_scope) ? p.out_of_scope : []).map((s) => String(s)),
  };
}

/**
 * The criterion-id → owner-node map an approved plan binds.
 *
 * Final verification reopens work by criterion id, so this map is part of the envelope: if a
 * criterion silently changed owner between approval and verification, a rejected criterion would
 * reopen the wrong node.
 *
 * @param {object} plan
 * @returns {Record<string, string>} sorted by criterion id
 */
export function criterionOwners(plan) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const node of Array.isArray(plan?.nodes) ? plan.nodes : []) {
    for (const c of Array.isArray(node?.acceptance) ? node.acceptance : []) {
      if (typeof c?.id === 'string') map[c.id] = String(c.owner_node ?? node.id ?? '');
    }
  }
  /** @type {Record<string, string>} */
  const sorted = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key];
  return sorted;
}

// ---------------------------------------------------------------------------
// The approval envelope
// ---------------------------------------------------------------------------

/**
 * Build the canonical approval envelope from its parts.
 *
 * Every field here is load-bearing at dispatch time, which is the test for whether something
 * belongs in the envelope at all:
 *
 * - `goal_digest` / `plan_digest` — what was asked for, and what will be built.
 * - `scope` — which project/service the run is anchored to (a different scope resolves different
 *   config, different run base, different working folder).
 * - `checkouts` — for EVERY write-owning Git checkout: its repo-relative path, the branch the run
 *   expects to find, and the base commit it starts from. This is what makes "the branch moved under
 *   us" a detectable drift rather than a surprise.
 * - `write_roots` — the repo-relative roots an implementation attempt may write inside.
 * - `routing` — per node: executor, family, tier, role profile. Approving a plan is approving WHO
 *   runs it; swapping a mid-tier implementer for a top-tier one is a cost and blast-radius change.
 * - `budgets` — the only amendable half (see {@link classifyAmendment}).
 * - `action_policy` — which outward/destructive classes are hard-stopped. Never widened silently.
 * - `criterion_owners` — see {@link criterionOwners}.
 *
 * @param {{goal_digest: string, plan_digest: string, scope: object, checkouts: object[],
 *          write_roots: string[], routing: object[], budgets: object, action_policy: object,
 *          criterion_owners: Record<string, string>}} parts
 * @returns {object}
 */
export function buildEnvelope(parts) {
  const p = parts || {};
  return canonicalEnvelope({
    schema_version: GOAL_SCHEMA_VERSION,
    goal_digest: p.goal_digest,
    plan_digest: p.plan_digest,
    scope: p.scope,
    checkouts: p.checkouts,
    write_roots: p.write_roots,
    routing: p.routing,
    budgets: p.budgets,
    action_policy: p.action_policy,
    criterion_owners: p.criterion_owners,
  });
}

/**
 * The canonical projection of an envelope: fixed shape, defaults applied, lists sorted where their
 * order carries no meaning (write roots, checkouts, routing) so two writers agree byte-for-byte.
 *
 * @param {object} envelope
 * @returns {object}
 */
export function canonicalEnvelope(envelope) {
  const e = envelope || {};
  const budgets = e.budgets || {};
  const policy = e.action_policy || {};
  return {
    schema_version: GOAL_SCHEMA_VERSION,
    goal_digest: String(e.goal_digest ?? ''),
    plan_digest: String(e.plan_digest ?? ''),
    scope: {
      project: String(e.scope?.project ?? ''),
      service: e.scope?.service == null ? null : String(e.scope.service),
    },
    checkouts: (Array.isArray(e.checkouts) ? e.checkouts : [])
      .map((c) => ({
        path: normalizePath(c?.path ?? '.'),
        branch: String(c?.branch ?? ''),
        base_commit: String(c?.base_commit ?? ''),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    write_roots: (Array.isArray(e.write_roots) ? e.write_roots : [])
      .map((r) => normalizePath(r))
      .sort(),
    routing: (Array.isArray(e.routing) ? e.routing : [])
      .map((r) => ({
        node: String(r?.node ?? ''),
        executor: String(r?.executor ?? ''),
        family: String(r?.family ?? ''),
        tier: String(r?.tier ?? ''),
        role: String(r?.role ?? 'implement'),
      }))
      .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0)),
    budgets: {
      max_attempts_per_node: Number(budgets.max_attempts_per_node ?? 3),
      max_total_attempts: Number(budgets.max_total_attempts ?? 0),
      max_wall_clock_ms_per_attempt: Number(budgets.max_wall_clock_ms_per_attempt ?? 0),
      max_wall_clock_ms_total: Number(budgets.max_wall_clock_ms_total ?? 0),
      max_consecutive_failures: Number(budgets.max_consecutive_failures ?? 3),
    },
    action_policy: {
      hard_stopped: (Array.isArray(policy.hard_stopped) ? policy.hard_stopped : []).map(String).sort(),
      allowed_test_commands: (Array.isArray(policy.allowed_test_commands)
        ? policy.allowed_test_commands
        : []).map(String),
    },
    criterion_owners: (() => {
      const src = e.criterion_owners || {};
      /** @type {Record<string, string>} */
      const out = {};
      for (const key of Object.keys(src).sort()) out[key] = String(src[key]);
      return out;
    })(),
  };
}

/**
 * Validate an envelope before it is offered for approval.
 *
 * @param {unknown} envelope
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateEnvelope(envelope) {
  /** @type {string[]} */
  const errors = [];
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, errors: ['envelope must be a JSON object'] };
  }
  const e = /** @type {Record<string, any>} */ (envelope);

  if (e.schema_version !== GOAL_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${GOAL_SCHEMA_VERSION}`);
  }
  if (!DIGEST_RE.test(String(e.goal_digest ?? ''))) errors.push('goal_digest must be a sha256 hex digest');
  if (!DIGEST_RE.test(String(e.plan_digest ?? ''))) errors.push('plan_digest must be a sha256 hex digest');

  if (!e.scope || typeof e.scope !== 'object' || !isLine(e.scope.project)) {
    errors.push('scope.project must name the active project');
  }

  if (!Array.isArray(e.checkouts) || e.checkouts.length === 0) {
    errors.push('checkouts: at least one write-owning checkout must be bound');
  } else {
    e.checkouts.forEach((c, i) => {
      if (!isPortablePath(c?.path)) errors.push(`checkouts[${i}].path: must be repo-relative`);
      if (!isLine(c?.branch)) errors.push(`checkouts[${i}].branch: required`);
      if (!/^[0-9a-f]{7,40}$/.test(String(c?.base_commit ?? ''))) {
        errors.push(`checkouts[${i}].base_commit: must be a git commit id`);
      }
    });
  }

  if (!Array.isArray(e.write_roots) || e.write_roots.length === 0) {
    errors.push('write_roots: at least one allowed write root must be bound');
  } else {
    e.write_roots.forEach((r, i) => {
      if (!isPortablePath(r)) errors.push(`write_roots[${i}]: must be repo-relative`);
    });
  }

  if (!Array.isArray(e.routing) || e.routing.length === 0) {
    errors.push('routing: every node must have a bound executor/tier');
  } else {
    e.routing.forEach((r, i) => {
      if (typeof r?.node !== 'string' || !ID_RE.test(r.node)) errors.push(`routing[${i}].node: must be a node id`);
      if (typeof r?.executor !== 'string' || !EXECUTOR_RE.test(r.executor)) {
        errors.push(`routing[${i}].executor: must be an executor name`);
      }
      if (!GOAL_TIERS.includes(r?.tier)) errors.push(`routing[${i}].tier: must be one of ${GOAL_TIERS.join(', ')}`);
      if (!GOAL_ROLES.includes(r?.role ?? 'implement')) {
        errors.push(`routing[${i}].role: must be one of ${GOAL_ROLES.join(', ')}`);
      }
    });
  }

  const b = e.budgets || {};
  if (!Number.isInteger(b.max_attempts_per_node) || b.max_attempts_per_node < 1) {
    errors.push('budgets.max_attempts_per_node must be an integer >= 1');
  }
  if (!Number.isInteger(b.max_consecutive_failures) || b.max_consecutive_failures < 1) {
    errors.push('budgets.max_consecutive_failures must be an integer >= 1');
  }
  for (const field of ['max_total_attempts', 'max_wall_clock_ms_per_attempt', 'max_wall_clock_ms_total']) {
    if (b[field] !== undefined && (!Number.isInteger(b[field]) || b[field] < 0)) {
      errors.push(`budgets.${field} must be a non-negative integer (0 = unbounded)`);
    }
  }

  if (!e.action_policy || !Array.isArray(e.action_policy.hard_stopped) || e.action_policy.hard_stopped.length === 0) {
    errors.push('action_policy.hard_stopped must list the classes that pause for a separate grant');
  }

  if (!e.criterion_owners || typeof e.criterion_owners !== 'object' || Array.isArray(e.criterion_owners)) {
    errors.push('criterion_owners must be a criterion-id → node-id map');
  } else if (Object.keys(e.criterion_owners).length === 0) {
    errors.push('criterion_owners must not be empty — a criterion nobody owns cannot be reopened');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Classify a replacement envelope against the approved one.
 *
 * This is the resolution of a genuine conflict in the design: budgets are BOUND by the envelope (so
 * they cannot be edited silently), but a user raising an exhausted attempt limit must not lose the
 * nodes already completed. So a new envelope that differs ONLY in budget fields is an amendment —
 * recorded append-only, node state preserved — and anything else is a re-plan.
 *
 * @param {object} approved - the currently approved canonical envelope
 * @param {object} next - the proposed canonical envelope
 * @returns {{kind: 'identical'|'amendment'|'replan', changed: string[]}}
 */
export function classifyAmendment(approved, next) {
  const a = canonicalEnvelope(approved);
  const b = canonicalEnvelope(next);
  if (canonicalJson(a) === canonicalJson(b)) return { kind: 'identical', changed: [] };

  /** @type {string[]} */
  const changed = [];
  for (const key of Object.keys(a)) {
    if (key === 'budgets') continue;
    if (canonicalJson(a[key]) !== canonicalJson(b[key])) changed.push(key);
  }
  for (const field of Object.keys(a.budgets)) {
    if (a.budgets[field] !== b.budgets[field]) changed.push(`budgets.${field}`);
  }

  const nonBudget = changed.filter((c) => !c.startsWith('budgets.'));
  return { kind: nonBudget.length === 0 ? 'amendment' : 'replan', changed };
}

// ---------------------------------------------------------------------------
// Model response contracts
// ---------------------------------------------------------------------------

/** Per-criterion verdict values a reviewer may return. Anything but `met` fails the attempt. */
export const CRITERION_STATUSES = Object.freeze(['met', 'unmet', 'unverifiable']);

/**
 * Validate an attempt reviewer's verdict.
 *
 * `evidence` is required on every criterion and must be non-empty, including on `met`: an
 * unevidenced "met" is the single most expensive thing a reviewer can return, because it completes
 * a node on the reviewer's word.
 *
 * @param {unknown} verdict
 * @param {string[]} [expectedCriteria] - criterion ids the node owns; when given, coverage is checked
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateReviewVerdict(verdict, expectedCriteria) {
  /** @type {string[]} */
  const errors = [];
  if (verdict === null || typeof verdict !== 'object' || Array.isArray(verdict)) {
    return { ok: false, errors: ['review verdict must be a JSON object'] };
  }
  const v = /** @type {Record<string, any>} */ (verdict);

  if (v.result !== 'pass' && v.result !== 'fail') errors.push("result must be 'pass' or 'fail'");
  if (!isProse(v.summary)) errors.push('summary must be a non-empty string');
  if (v.reviewer_family !== undefined && !isLine(v.reviewer_family)) {
    errors.push('reviewer_family must be a single-line string when present');
  }

  /** @type {Set<string>} */
  const seen = new Set();
  if (!Array.isArray(v.criteria) || v.criteria.length === 0) {
    errors.push('criteria: must be a non-empty array of per-criterion verdicts');
  } else {
    v.criteria.forEach((c, i) => {
      const at = `criteria[${i}]`;
      if (c === null || typeof c !== 'object' || Array.isArray(c)) {
        errors.push(`${at}: must be an object`);
        return;
      }
      if (typeof c.criterion_id !== 'string' || !ID_RE.test(c.criterion_id)) {
        errors.push(`${at}.criterion_id: must be a criterion id`);
      } else {
        if (seen.has(c.criterion_id)) errors.push(`${at}.criterion_id: duplicate ${c.criterion_id}`);
        seen.add(c.criterion_id);
      }
      if (!CRITERION_STATUSES.includes(c.status)) {
        errors.push(`${at}.status: must be one of ${CRITERION_STATUSES.join(', ')}`);
      }
      const ev = stringList(c.evidence, `${at}.evidence`, errors, { required: true, prose: true });
      if (ev.length === 0 && Array.isArray(c.evidence) && c.evidence.length > 0) {
        // stringList already reported the per-entry problem; nothing to add.
      }
    });
  }

  if (Array.isArray(expectedCriteria) && expectedCriteria.length > 0 && errors.length === 0) {
    const missing = expectedCriteria.filter((id) => !seen.has(id));
    if (missing.length > 0) {
      errors.push(`criteria: no verdict for ${missing.join(', ')} — every owned criterion must be judged`);
    }
    const extra = [...seen].filter((id) => !expectedCriteria.includes(id));
    if (extra.length > 0) {
      errors.push(`criteria: ${extra.join(', ')} are not owned by this node`);
    }
  }

  // A `pass` whose criteria are not all `met` is self-contradictory; trust the criteria, refuse the
  // verdict, rather than quietly downgrading it.
  if (errors.length === 0 && v.result === 'pass') {
    const unmet = v.criteria.filter((c) => c.status !== 'met').map((c) => c.criterion_id);
    if (unmet.length > 0) {
      errors.push(`result 'pass' contradicts non-met criteria: ${unmet.join(', ')}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Outcomes a final verifier may return. */
export const FINAL_RESULTS = Object.freeze(['approved', 'rejected-in-scope', 'rejected-scope-change']);

/**
 * Validate the final verifier's verdict.
 *
 * A `rejected-in-scope` verdict MUST name at least one failed criterion id: that id is what selects
 * the node to reopen, so a rejection without one cannot be acted on and is refused rather than
 * escalated into a re-plan.
 *
 * @param {unknown} verdict
 * @param {string[]} [knownCriteria]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateFinalVerdict(verdict, knownCriteria) {
  /** @type {string[]} */
  const errors = [];
  if (verdict === null || typeof verdict !== 'object' || Array.isArray(verdict)) {
    return { ok: false, errors: ['final verdict must be a JSON object'] };
  }
  const v = /** @type {Record<string, any>} */ (verdict);

  if (!FINAL_RESULTS.includes(v.result)) {
    errors.push(`result must be one of ${FINAL_RESULTS.join(', ')}`);
  }
  if (!isProse(v.summary)) errors.push('summary must be a non-empty string');
  stringList(v.evidence, 'evidence', errors, { required: true, prose: true });

  const failed = Array.isArray(v.failed_criteria) ? v.failed_criteria : [];
  failed.forEach((id, i) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      errors.push(`failed_criteria[${i}]: must be a criterion id`);
    } else if (Array.isArray(knownCriteria) && knownCriteria.length > 0 && !knownCriteria.includes(id)) {
      errors.push(`failed_criteria[${i}]: ${id} is not an approved criterion`);
    }
  });

  if (v.result === 'rejected-in-scope' && failed.length === 0) {
    errors.push(
      "result 'rejected-in-scope' requires failed_criteria — the criterion id is what selects the "
      + 'node to reopen',
    );
  }
  if (v.result === 'rejected-scope-change' && !isProse(v.scope_change_reason)) {
    errors.push("result 'rejected-scope-change' requires scope_change_reason");
  }
  if (v.result === 'approved' && failed.length > 0) {
    errors.push(`result 'approved' contradicts failed_criteria: ${failed.join(', ')}`);
  }

  return { ok: errors.length === 0, errors };
}
