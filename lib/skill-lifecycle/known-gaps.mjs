// lib/skill-lifecycle/known-gaps.mjs
// The ratchet that lets `skill doctor` be a CI gate from the day it lands.
//
// WHY THIS EXISTS. A doctor that starts red is a doctor everyone learns to ignore, and the backfill
// it gates spans ~75 skills across a dozen commits. So the gate goes green immediately against a
// recorded snapshot of the gaps that already exist, and the ONLY permitted movement is downward:
// tests/skills/skill-doctor.test.mjs asserts the list never grows past RECORDED_MAX. A new gap in a
// new commit therefore fails CI, while the historical backlog is drained one reviewable batch at a
// time.
//
// GRANULARITY is `<skill>|<check>`, not per-detail. Per-detail keys would make this file churn on
// every unrelated edit and would let a second instance of the same gap hide inside a suppressed
// key; per-skill-per-check is coarse enough to stay readable and fine enough to ratchet.
//
// THIS FILE IS DELETED IN THE PHASE THAT FLIPS THE GATE. It is scaffolding for the migration, not
// a permanent allowlist — an allowlist with no expiry date is how a gate rots.
//
// Zero npm dependencies — no imports at all.

/**
 * Recorded gaps, `<skill>|<check>`. Seeded from the first real `skill doctor --json` run on this
 * repo. Remove entries as each backfill batch lands; never add one to make a new commit pass.
 *
 * @type {ReadonlyArray<string>}
 */
export const KNOWN_GAPS = Object.freeze([
  // caveman|manifest-missing — CLOSED. The skill owns `criterion.caveman`, so recording the
  // settings half (requires.framework_rules) gave it a manifest along the way.
  'deploy-android-wireless|skill-named-in-comment',
  // Seven gaps CLOSED 2026-08-17 by the repos reforge, all as a side effect of the same change:
  // extract-static-html|manifest-missing, react-components|manifest-missing,
  // react-components|undeclared-node, react-native|manifest-missing, react-native|undeclared-node,
  // shadcn-ui|manifest-missing, upload-to-stitch|manifest-missing.
  //
  // Declaring the publication split gave each vendored skill a `skill.yaml`, which makes a manifest
  // REQUIRED, so `skill manifest --apply` recorded one — and recording it declared the node
  // dependencies the two react skills' package.json already carried. The `duplicate-basename` gaps
  // below are untouched: those are two files sharing a name inside one skill, which a manifest
  // records rather than resolves.
  'react-components|duplicate-basename',
  'react-native|duplicate-basename',
  'sk-agent-dry-run|skill-named-in-comment',
  'sk-agent-mission-loop|skill-named-in-comment',
  'sk-cli-executor|skill-named-in-comment',
  'sk-cli-orchestrator|duplicate-basename',
  'sk-cli-orchestrator|skill-named-in-comment',
  'sk-confluence-connector|duplicate-basename',
  'sk-database-connector|duplicate-basename',
  'sk-database-connector|skill-named-in-comment',
  'sk-database-schema-sync|skill-named-in-comment',
  'sk-database-transfer|duplicate-basename',
  'sk-database-transfer|skill-named-in-comment',
  'sk-flow-automator|duplicate-basename',
  'sk-get-jira-done|skill-named-in-comment',
  'sk-image-generator|duplicate-basename',
  'sk-inherit|skill-named-in-comment',
  'sk-jira-autopilot|duplicate-basename',
  'sk-jira-connector|duplicate-basename',
  'sk-jira-connector|skill-named-in-comment',
  'sk-jira-footprint|duplicate-basename',
  'sk-jira-subtask-consolidator|duplicate-basename',
  'sk-loop-fleet|skill-named-in-comment',
  'sk-nanobanana-generator|duplicate-basename',
  'sk-slack-connector|duplicate-basename',
  'sk-teleport-cluster-ops|duplicate-basename',
  'sk-teleport-database-connector|duplicate-basename',
  'sk-teleport-database-connector|skill-named-in-comment',
]);

/**
 * The high-water mark. `KNOWN_GAPS.length` must never exceed this, and this number must only ever
 * be lowered — the test that asserts it is what makes the ratchet a ratchet rather than a comment.
 */
export const RECORDED_MAX = 29;

/** @param {string} skill @param {string} check @returns {boolean} */
export function isKnownGap(skill, check) {
  return KNOWN_GAPS.includes(`${skill}|${check}`);
}
