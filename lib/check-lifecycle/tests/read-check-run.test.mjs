// lib/check-lifecycle/tests/read-check-run.test.mjs
// `readCheckRun` — the one reader of a `check run --json` result (INC-2026-09-09).
//
// The two cases that matter are the two the framework-core release gate got wrong by reading the
// result itself, and they pull in opposite directions:
//
//   1. A profile that PASSED still exits 1 when a non-blocking gate skipped. A reader that trusts
//      the exit code refuses a green release on every machine without `pwsh`.
//   2. A profile that FAILED must name WHICH gate and WHY, and the failing row is in the middle of
//      the document — the end holds the trailing skips and the gates blocked behind the failure.
//
// So a reader that only looked at `status` would be wrong too: the skips have to travel out, and the
// failure has to arrive with the test output attached. Both are asserted here against the row shape
// renderRow actually emits.
//
// Colocated under lib/ so it travels into a forged core (INC-2026-09-04-02, N-3), and hermetic — it
// reads no tree, so it means the same thing in a checkout, a mount and a package.
// node:test + node:assert/strict only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCheckRun } from '../_shared.mjs';

/** One row in renderRow's field order, so a shape change here fails rather than silently passes. */
const row = (id, status, extra = {}) => ({
  id,
  status,
  dependencies: [],
  blocking: true,
  started_at: '2026-09-09T22:06:36+07:00',
  ended_at: '2026-09-09T22:08:22+07:00',
  duration_ms: 106000,
  exit_code: status === 'passed' ? 0 : null,
  signal: null,
  stdout_tail: '',
  stderr_tail: '',
  reason: null,
  ...extra,
});

const envelope = (status, gates) => JSON.stringify({
  schema_version: 1,
  profile: 'full',
  started_at: '2026-09-09T22:06:36+07:00',
  ended_at: '2026-09-09T22:08:22+07:00',
  duration_ms: 106000,
  status,
  gates,
}, null, 2);

test('a PASSED profile with a non-blocking skip is passed, and the skip is reported', () => {
  // The exact shape that made the mount gate red on every host without PowerShell Core: the runner
  // exits 1 for the skip while its own verdict is `passed`.
  const text = envelope('passed', [
    row('tests.all', 'passed'),
    row('installer.pwsh', 'skipped', {
      blocking: false,
      reason: 'pwsh is not on PATH, so the PowerShell PARSER did not run',
    }),
  ]);
  const r = readCheckRun(text);
  assert.equal(r.status, 'passed');
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(r.skipped.map((g) => g.id), ['installer.pwsh'],
    'a skip must reach the caller — a reader that drops it turns "not checked" into "checked"');
});

test('a FAILED profile names the failing gate and carries its captured output', () => {
  const text = envelope('failed', [
    row('tests.all', 'failed', {
      exit_code: 1,
      reason: 'exit 1',
      stdout_tail: 'ℹ fail 1\n\n✖ failing tests:\n\ntest at lib/check-lifecycle/tests/x.test.mjs:130:1\n'
        + "✖ a tree with no template is not_applicable, not a failure\n",
    }),
    row('skill.doctor', 'blocked', { reason: "dependency 'tests.all' did not pass" }),
    row('parity', 'blocked', { reason: "dependency 'tests.all' did not pass" }),
    row('installer.pwsh', 'skipped', { blocking: false, reason: 'pwsh is not on PATH' }),
  ]);
  const r = readCheckRun(text);
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.failed.map((g) => g.id), ['tests.all']);
  assert.deepEqual(r.blocked.map((g) => g.id), ['skill.doctor', 'parity']);

  // The whole point: the tail leads with the cause, not with the dependency notices that follow it.
  assert.match(r.tail, /^── tests\.all: FAILED \(exit 1\)/);
  assert.match(r.tail, /a tree with no template is not_applicable/,
    'the failing TEST name must survive — its absence is what left the incident with no cause');
  assert.ok(r.tail.indexOf('tests.all: FAILED') < r.tail.indexOf('blocked behind the above'),
    'the blocked list comes last; leading with it is what buried the cause');
});

test('output that is not a readable result is null, never an assumed pass', () => {
  for (const text of ['', 'Error: cannot resolve profile\n', '{ not json', '{"status":"passed"}',
    '{"gates":[]}']) {
    assert.equal(readCheckRun(text), null, `must not be read as a result: ${JSON.stringify(text)}`);
  }
  assert.equal(readCheckRun(undefined), null);
});

test('human lines before the json are tolerated, so a combined capture still reads', () => {
  // Callers hand it `stdout + stderr` from one spawn; a warning on stderr must not blind the reader.
  const text = `warning: pwsh not found\n${envelope('passed', [row('tests.all', 'passed')])}\n`;
  const r = readCheckRun(text);
  assert.equal(r.status, 'passed');
  assert.deepEqual(r.failed, []);
});
