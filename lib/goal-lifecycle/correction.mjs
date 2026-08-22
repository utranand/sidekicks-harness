// lib/goal-lifecycle/correction.mjs
// The brief that turns a failed verdict into the next attempt.
//
// WHY THIS IS A FILE AND NOT A CONVERSATION. The next attempt may be a fresh session on a CLI with no
// resume surface at all — which, for three of the four built-ins, it is. So everything the next
// attempt needs has to exist on disk: the exact criteria that failed, the reviewer's evidence, what
// the previous attempts already tried, what is unchanged, and how much budget is left. A correction
// that only makes sense as a reply to a message the next session never saw is not a correction.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not restate the goal as a new goal, it does not add
// criteria the plan never approved, and it does not widen the write footprint. A correction reopens
// the SAME node against the SAME approved scope — if the finding implies the plan was wrong, that is
// a re-plan, and the final verifier is what escalates it.
//
// Zero npm dependencies — node:* only.

/**
 * Build the correction brief for the next attempt on a node.
 *
 * @param {{node: object, verdict: object, attemptNumber: number, maxAttempts: number,
 *          priorAttempts: object[], diff?: string, testOutput?: string,
 *          attemptPaths?: string[]}} input
 * @returns {string}
 */
export function buildCorrectionBrief(input) {
  const { node, verdict } = input;
  const failed = (verdict.criteria || []).filter((c) => c.status !== 'met');
  const met = (verdict.criteria || []).filter((c) => c.status === 'met');
  const remaining = Math.max(0, input.maxAttempts - input.attemptNumber + 1);

  const lines = [];
  lines.push(`Your previous attempt on node ${node.id} was reviewed and REJECTED by an independent`);
  lines.push('reviewer that did not write the code. Fix exactly what is listed below.');
  lines.push('');
  lines.push(`Reviewer's summary: ${verdict.summary}`);
  lines.push('');

  lines.push('## Criteria that FAILED — each must be met for this node to complete');
  lines.push('');
  for (const c of failed) {
    const criterion = (node.acceptance || []).find((a) => a.id === c.criterion_id);
    lines.push(`### ${c.criterion_id} — ${c.status}`);
    lines.push('');
    lines.push(`Requirement: ${criterion ? criterion.text : '(see the plan)'}`);
    lines.push('');
    lines.push("What the reviewer found:");
    for (const e of c.evidence || []) lines.push(`  - ${e}`);
    if (c.status === 'unverifiable') {
      lines.push('');
      lines.push('NOTE: `unverifiable` does not mean the code is wrong — it means the reviewer could');
      lines.push('not tell from the tree and the command output. Make it CHECKABLE: a test that fails');
      lines.push('without the change, output that shows the behaviour, or the code in a place the');
      lines.push('reviewer will read.');
    }
    lines.push('');
  }

  if (met.length > 0) {
    lines.push('## Criteria already accepted — do not undo these');
    lines.push('');
    for (const c of met) {
      lines.push(`  - ${c.criterion_id} (met): ${(c.evidence || []).join('; ')}`);
    }
    lines.push('');
  }

  if (input.priorAttempts && input.priorAttempts.length > 0) {
    lines.push('## What has already been tried on this node');
    lines.push('');
    for (const a of input.priorAttempts) {
      const outcome = a.result === 'passed' ? 'passed' : (a.error || a.result || 'failed');
      lines.push(`  - attempt ${a.n} (${a.executor} · ${a.tier}): ${outcome}`);
    }
    lines.push('');
    lines.push('Do not repeat an approach that already failed. If the same fix keeps being rejected,');
    lines.push('the problem is probably not where you have been looking.');
    lines.push('');
  }

  if (Array.isArray(input.attemptPaths) && input.attemptPaths.length > 0) {
    lines.push('## Evidence on disk from the previous attempt');
    lines.push('');
    for (const p of input.attemptPaths) lines.push(`  - ${p}`);
    lines.push('');
  }

  lines.push('## What has NOT changed');
  lines.push('');
  lines.push('- The goal, the approved plan, and this node\'s criteria are the same. You are not being');
  lines.push('  asked to do more, and you may not do less.');
  lines.push('- The files this node may touch are the same:');
  for (const p of node.affected_paths || []) lines.push(`    - ${p}`);
  lines.push('- Every action outside repository edits and the listed test commands is still off');
  lines.push('  limits, and still needs its own separate grant.');
  lines.push('');
  lines.push('## Budget');
  lines.push('');
  lines.push(
    `This is attempt ${input.attemptNumber} of ${input.maxAttempts} for this node — `
    + `${remaining} left, including this one. After that the run stops and asks a human, so a `
    + 'partial fix now is worse than a complete one.',
  );

  return lines.join('\n');
}

/**
 * The one-line failure summary a later attempt (and the report) reads.
 *
 * @param {object} verdict
 * @returns {string}
 */
export function summarizeFailure(verdict) {
  const failed = (verdict?.criteria || []).filter((c) => c.status !== 'met');
  if (failed.length === 0) return String(verdict?.summary ?? 'rejected with no criterion named');
  return failed.map((c) => `${c.criterion_id} ${c.status}`).join(', ');
}

/**
 * Should the next attempt RESUME the implementation session, or start fresh?
 *
 * Resume is only ever an optimization, and it is refused unless the CLI can re-assert its containment
 * on the resumed command line. The correction brief is written to disk either way, so a fresh session
 * loses nothing but the model's own recollection — which is not evidence.
 *
 * @param {{resumeSupported: boolean, sessionId: string|null}} input
 * @returns {{resume: boolean, reason: string}}
 */
export function decideResume(input) {
  if (!input.sessionId) {
    return { resume: false, reason: 'the previous attempt reported no resumable session id' };
  }
  if (!input.resumeSupported) {
    return {
      resume: false,
      reason: 'this executor cannot resume with its containment intact, so the correction starts a '
        + 'fresh session from the persisted brief',
    };
  }
  return { resume: true, reason: 'resuming the implementation session with containment re-asserted' };
}
