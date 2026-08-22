// lib/goal-lifecycle/policy.mjs
// What goal approval authorizes, and — the part that matters — what it does not.
//
// APPROVING A PLAN IS NOT APPROVING ITS CONSEQUENCES. A goal approval authorizes repository edits
// inside the bound write roots and the test commands the plan named. It does not authorize a push, a
// pull request, a deployment, production access, a database mutation, a destructive filesystem
// command, a package publication, or a message to anyone outside this machine. Each of those is a
// separate boundary with its own blast radius, and each needs its own exact grant.
//
// WHY A TAXONOMY AND NOT A REGEX ON THE COMMAND. Because the enforcement point is not "did the model
// type `git push`" — an agent CLI with edit permissions can shell out however it likes. The taxonomy
// exists so that (a) the envelope can state, at approval time, which classes are hard-stopped, and
// (b) when an agent REPORTS that it needs one, the engine has a name for the thing to pause on and a
// digest to bind the grant to. The CLI's own policy surface plus Sidekicks' existing safety hooks are
// what stop the action; this module is what makes the boundary legible and the grant specific.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

/**
 * The action classes a goal approval never covers.
 *
 * Each entry says what it is, why it is out, and what reversing it costs — because a pause the
 * operator cannot evaluate is a pause they will wave through.
 */
export const HARD_STOPPED_ACTIONS = Object.freeze({
  push: Object.freeze({
    what: 'pushing commits to a remote',
    why: 'a push leaves this machine; other people and CI act on it immediately',
    reversal: 'a force-push, which rewrites history others may already have',
  }),
  'pull-request': Object.freeze({
    what: 'opening, updating or merging a pull request',
    why: 'a PR asks other people to spend attention, and a merge lands on a protected branch',
    reversal: 'closing it leaves the notifications and reviews already sent',
  }),
  deploy: Object.freeze({
    what: 'deploying, releasing, or applying infrastructure changes',
    why: 'it changes a running system real users are on',
    reversal: 'a rollback, which is a second deployment with its own risk',
  }),
  'db-write': Object.freeze({
    what: 'any INSERT, UPDATE, DELETE, TRUNCATE or DDL against a live database',
    why: 'data loss is not recoverable from a code review',
    reversal: 'a restore from backup, assuming one exists and is current',
  }),
  'prod-access': Object.freeze({
    what: 'connecting to a production database, cluster or secret store',
    why: 'a read can still exfiltrate, and a mistyped read is one keystroke from a write',
    reversal: 'none — the access happened',
  }),
  destructive: Object.freeze({
    what: 'deleting or overwriting outside the bound write roots: rm -rf, git reset --hard, '
      + 'git stash, git clean, dropping a branch, truncating a file the plan does not own',
    why: 'it destroys work that is not this run\'s, including work nobody has committed',
    reversal: 'often none; uncommitted work is unrecoverable',
  }),
  publish: Object.freeze({
    what: 'publishing a package, image or artifact to a registry',
    why: 'a published version is public and may be depended on within minutes',
    reversal: 'unpublishing is restricted, sometimes impossible, and breaks anyone who fetched it',
  }),
  'outward-message': Object.freeze({
    what: 'sending to Slack, email, Jira, Telegram or any external service',
    why: 'it reaches people, and may be indexed or cached even after deletion',
    reversal: 'none that unsends it',
  }),
  'credential-write': Object.freeze({
    what: 'writing, rotating or reading out a credential',
    why: 'a rotated credential breaks everything holding the old one; a read leaks it',
    reversal: 'rotating again, after finding everything that broke',
  }),
});

/** The class names, as the envelope stores them. */
export const HARD_STOPPED_CLASSES = Object.freeze(Object.keys(HARD_STOPPED_ACTIONS));

/**
 * The default action policy an envelope binds.
 *
 * `allowed_test_commands` is deliberately narrow and explicit: the plan's own `tests` entries are
 * what a node is verified by, and a node that wants to run something else is asking for a wider
 * permission than the plan described.
 *
 * @param {{allowedTestCommands?: string[]}} [opts]
 * @returns {{hard_stopped: string[], allowed_test_commands: string[]}}
 */
export function defaultActionPolicy(opts = {}) {
  return {
    hard_stopped: [...HARD_STOPPED_CLASSES],
    allowed_test_commands: [...(opts.allowedTestCommands || [])],
  };
}

/**
 * The default budgets an envelope binds.
 *
 * Three attempts per node is the framework's standing default. The wall-clock ceilings are generous
 * but finite — an unattended run with no time bound is the failure mode where a wedged session burns
 * a night. Zero means unbounded and is available, but never the default.
 *
 * @param {{attempts?: number, totalAttempts?: number, perAttemptMs?: number, totalMs?: number,
 *          breaker?: number}} [opts]
 * @returns {object}
 */
export function defaultBudgets(opts = {}) {
  return {
    max_attempts_per_node: Number(opts.attempts ?? 3),
    max_total_attempts: Number(opts.totalAttempts ?? 0),
    max_wall_clock_ms_per_attempt: Number(opts.perAttemptMs ?? 30 * 60 * 1000),
    max_wall_clock_ms_total: Number(opts.totalMs ?? 8 * 60 * 60 * 1000),
    max_consecutive_failures: Number(opts.breaker ?? 3),
  };
}

/**
 * Classify an action an implementation session reported it needs.
 *
 * The class is taken from the agent's own `action_class` where it names a known one, and otherwise
 * INFERRED from the target and reason — because an agent that says it needs to "ship this to the
 * cluster" has described a deploy whether or not it used that word. An unrecognised class does not
 * become "allowed": it becomes `unclassified`, which pauses the same way. Failing open here would
 * mean an action nobody named executes unreviewed.
 *
 * @param {object} request - the session's `action_request`
 * @returns {{action_class: string, known: boolean, inferred: boolean, description: string,
 *            reversal: string}}
 */
export function classifyAction(request) {
  const declared = String(request?.action_class ?? '').trim().toLowerCase();
  if (HARD_STOPPED_ACTIONS[declared]) {
    return {
      action_class: declared,
      known: true,
      inferred: false,
      description: HARD_STOPPED_ACTIONS[declared].what,
      reversal: HARD_STOPPED_ACTIONS[declared].reversal,
    };
  }

  const haystack = `${declared} ${request?.target ?? ''} ${request?.reason ?? ''}`.toLowerCase();
  const patterns = [
    ['push', /\bgit push\b|\bpush(ing)? (to|the) (remote|origin|branch)\b|\bforce[- ]push\b/],
    ['pull-request', /\bpull request\b|\bmerge request\b|\bPR\b|\bgh pr\b/i],
    ['deploy', /\bdeploy|\brelease to\b|\bkubectl apply\b|\bhelm (install|upgrade)\b|\bterraform apply\b|\brollout\b/],
    ['db-write', /\binsert\b|\bupdate .*\bset\b|\bdelete from\b|\btruncate\b|\bdrop (table|database)\b|\balter table\b|\bmigrat/],
    ['prod-access', /\bproduction\b|\bprod\b/],
    ['destructive', /\brm -rf\b|\bgit reset --hard\b|\bgit stash\b|\bgit clean\b|\bdelete the branch\b|\bforce delete\b/],
    ['publish', /\bnpm publish\b|\bdocker push\b|\bpublish (the )?(package|image|artifact)\b|\bpypi\b/],
    ['outward-message', /\bslack\b|\bemail\b|\bjira\b|\btelegram\b|\bnotify\b|\bcomment on\b/],
    ['credential-write', /\brotate\b.*\b(secret|credential|token|key)\b|\bwrite .*\bsecret\b|\bread .*\bcredential\b/],
  ];
  for (const [cls, re] of patterns) {
    if (re.test(haystack)) {
      return {
        action_class: cls,
        known: true,
        inferred: true,
        description: HARD_STOPPED_ACTIONS[cls].what,
        reversal: HARD_STOPPED_ACTIONS[cls].reversal,
      };
    }
  }

  return {
    action_class: 'unclassified',
    known: false,
    inferred: false,
    description: declared || 'an action the session did not name in a recognised class',
    reversal: 'unknown — treat as irreversible until the operator says otherwise',
  };
}

/**
 * Build the canonical action request the operator's grant is bound to.
 *
 * The digest covers the class, the target and the run — so a grant authorizes THAT action on THAT
 * target in THAT run, and nothing else. It deliberately excludes the reason prose: a grant should not
 * be invalidated by a reworded justification, and it should not be transferable to a different target
 * by keeping the words.
 *
 * @param {{runId: string, node: string, attemptId: string, request: object,
 *          requestId: string}} input
 * @returns {{request: object, canonical: object}}
 */
export function buildActionRequest(input) {
  const classified = classifyAction(input.request);
  const canonical = {
    schema_version: 1,
    run_id: input.runId,
    request_id: input.requestId,
    node: input.node,
    action_class: classified.action_class,
    target: String(input.request?.target ?? '').trim(),
  };
  return {
    canonical,
    request: {
      ...canonical,
      attempt_id: input.attemptId,
      declared_class: String(input.request?.action_class ?? ''),
      classified_by: classified.inferred ? 'inferred from the target and reason' : 'as declared',
      description: classified.description,
      reason: String(input.request?.reason ?? '').slice(0, 2048),
      reversible: input.request?.reversible === true,
      reversal_cost: classified.reversal,
      safety_procedure: input.request?.safety_procedure
        ? String(input.request.safety_procedure).slice(0, 2048)
        : null,
      // A database write carries Rule 4 on top of the grant: a transaction that can roll back, and
      // explicit permission. Stated on the request so the operator sees it at decision time.
      extra_requirements: classified.action_class === 'db-write'
        ? ['must run inside a transaction that can roll back', 'production requires explicit permission']
        : [],
    },
  };
}

/**
 * A stable request id — `<node>#<attempt>-<class>`.
 *
 * Deterministic so a retried pause does not mint a second id for the same held action.
 *
 * @param {string} attemptId
 * @param {string} actionClass
 * @returns {string}
 */
export function actionRequestId(attemptId, actionClass) {
  return `${String(attemptId).replace('#', '-')}-${actionClass}`;
}

/**
 * The one unspent grant this node may use, or null.
 *
 * A GRANT IS BOUND TO ITS NODE. The operator approved a push for node B; node C asking for the same
 * class on the same target is a different decision, and letting C spend B's grant is precisely the
 * class-wide authorization this design refuses. Oldest-first, so a run that somehow holds two
 * consumes them in the order they were granted rather than in map order.
 *
 * @param {object} state
 * @param {string} nodeId
 * @returns {object|null}
 */
export function pendingGrantFor(state, nodeId) {
  const grants = Array.isArray(state?.action_grants) ? state.action_grants : [];
  return grants.find((g) => g && g.node === nodeId && !g.consumed_by) ?? null;
}

/**
 * The grant paragraph injected into the attempt that may spend it.
 *
 * Stated as ONE action on ONE target, with the safety procedure the request itself named, and with the
 * boundary restated immediately afterwards — because an attempt told "you may push now" reads that as
 * a general loosening unless the sentence after it says otherwise.
 *
 * @param {object} grant
 * @returns {string}
 */
export function renderGrantBlock(grant) {
  const lines = [];
  lines.push('## The operator granted ONE action for this attempt');
  lines.push('');
  lines.push(`  action: ${grant.action_class}`);
  lines.push(`  target: ${grant.target}`);
  lines.push(`  request: ${grant.request_id}`);
  lines.push('');
  lines.push('You asked for this on a previous attempt and it was approved. It is available exactly');
  lines.push('once, for exactly that target, on this attempt only. Everything else in the forbidden');
  lines.push('list above is still forbidden, including the same action against any other target.');
  if (grant.safety_procedure) {
    lines.push('');
    lines.push('Required procedure, as stated in your own request:');
    lines.push(`  ${grant.safety_procedure}`);
  }
  if ((grant.extra_requirements || []).length > 0) {
    lines.push('');
    lines.push('Still required regardless of the grant:');
    for (const req of grant.extra_requirements) lines.push(`  - ${req}`);
  }
  lines.push('');
  lines.push('Take the action, verify it did what the node needs, and report `result: "completed"`.');
  lines.push('If you decide it is no longer necessary, say so in your summary and do not take it.');
  return lines.join('\n');
}

/**
 * The policy paragraph injected into every implementation prompt.
 *
 * Stated as a boundary the session cannot cross rather than advice it may weigh, and it names the
 * escape hatch: report the need, do not take the action. An agent with no sanctioned way to say "I
 * need to push" will either do it or stall silently.
 *
 * @param {{writeRoots: string[], tests: string[], hardStopped?: string[]}} input
 * @returns {string}
 */
export function renderPolicyBlock(input) {
  const lines = [];
  lines.push('## What this session may and may not do');
  lines.push('');
  lines.push('You may create and edit files inside these repo-relative roots, and nowhere else:');
  for (const root of input.writeRoots) lines.push(`  - ${root}`);
  lines.push('');
  if (input.tests.length) {
    lines.push('The engine will run these approved commands after you return; do not run them yourself:');
    for (const t of input.tests) lines.push(`  - ${t}`);
  } else {
    lines.push('This node named no test commands; the engine will run none.');
  }
  lines.push('');
  lines.push('You may NOT do any of the following. They are not covered by the approval that started');
  lines.push('this run, and each needs its own separate grant from the operator:');
  lines.push('');
  for (const cls of input.hardStopped || HARD_STOPPED_CLASSES) {
    const row = HARD_STOPPED_ACTIONS[cls];
    if (!row) continue;
    lines.push(`  - ${cls}: ${row.what}`);
  }
  lines.push('');
  lines.push('If your work genuinely cannot be completed without one of them, STOP and report it:');
  lines.push('state the exact action, its target, why it is needed, and whether it is reversible.');
  lines.push('Do not take the action and mention it afterwards. Reporting the need is a successful');
  lines.push('outcome for this session; taking the action is not.');
  return lines.join('\n');
}
