// lib/framework-lifecycle/tests/lib-suite-mount-safety.test.mjs
// Every suite colocated under lib/ must MEAN THE SAME THING in a mounted workspace (INC-2026-09-09).
//
// The suites under `lib/**/tests/` are there so they travel into a forged core and a consumer can
// run them (INC-2026-09-04-02, N-3). That places them in two different layouts:
//
//   source checkout   <repo>/lib/check-lifecycle/tests/x.test.mjs      parent of the root: unrelated
//   mounted workspace <ws>/.sidekicks-core/lib/check-lifecycle/tests/  parent of the root: the WORKSPACE
//
// A fixture that walks UP from the framework root therefore lands on unrelated ground in a checkout
// and on the workspace in a mount — and `frameworkRootOf(<ws>)` resolves the workspace straight back
// into the core, so "a tree with no framework" becomes "the framework, again". That is exactly how
// installer-pwsh.test.mjs shipped a case that was green in the source repo and red in every mount:
// it built its "no template here" tree as `dirname(repoRoot)`. It failed `tests.all` inside the
// release's mount gate, took `skill.doctor`, `parity` and `package.clean` down as blocked, and
// halted a release whose only recorded cause was `mount-check-tests.all-dependency-failed`.
//
// The rule this pins: reach DOWN from the framework root, never up. A tree that must not contain the
// framework is a `mkdtempSync` directory — hermetic, and identical in both layouts.
//
// Zero npm dependencies — node:* only; macOS + Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from '../../skill-lifecycle/scan.mjs';

const HERE = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(HERE), '..', '..', '..');
const LIB = join(repoRoot, 'lib');

/**
 * The ways a suite can name its own framework root's PARENT. Each is matched as source text, which
 * is the only form available: the offending expression is a fixture argument, so no amount of
 * running the suite in this layout reveals what it would mean in the other one.
 *
 * Matched against COMMENT-STRIPPED source. A file that explains why it stopped doing this — and the
 * one that fixed it says exactly that — must not be flagged for the prose.
 */
const UPWARD = Object.freeze([
  { pattern: /\bdirname\(\s*repoRoot\s*\)/, why: "dirname(repoRoot) is the framework root's parent" },
  { pattern: /\b(?:join|resolve)\(\s*repoRoot\s*,\s*(['"])\.\.\1/, why: "joining '..' onto repoRoot leaves the framework" },
  { pattern: /new URL\(\s*(['"])\.\.\/\.\.\/\.\.\/\.\.\//, why: "four levels up from lib/<x>/tests/ is above the framework root" },
  { pattern: /(['"])\.\.\1\s*,\s*(['"])\.\.\2\s*,\s*(['"])\.\.\3\s*,\s*(['"])\.\.\4/, why: "four '..' segments from lib/<x>/tests/ is above the framework root" },
]);

/** Every `*.test.mjs` colocated under lib/, framework-root-relative. */
function libSuites() {
  const found = [];
  for (const family of readdirSync(LIB, { withFileTypes: true })) {
    if (!family.isDirectory()) continue;
    const dir = join(LIB, family.name, 'tests');
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.test.mjs')) found.push(join(dir, entry.name));
    }
  }
  return found;
}

test('no suite under lib/ resolves a path above its own framework root', () => {
  const suites = libSuites();
  assert.ok(suites.length >= 2, `expected the colocated suites to be discoverable under ${LIB}`);

  const offenders = [];
  for (const abs of suites) {
    // This file carries the patterns as literals, so it is the one file that cannot be its own subject.
    if (abs === HERE) continue;
    const text = stripComments(readFileSync(abs, 'utf8'), abs);
    for (const { pattern, why } of UPWARD) {
      if (pattern.test(text)) {
        offenders.push(`${relative(repoRoot, abs).split(sep).join('/')}: ${why}`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    'a suite that travels into a core may only reach DOWN from the framework root — in a mount the '
    + 'parent of that root is the consumer\'s workspace, and it resolves back into the core. Use a '
    + 'mkdtempSync directory for a tree that must not contain the framework:\n  '
    + offenders.join('\n  '));
});

test('the patterns bite — each offending shape is matched, and the hermetic one is not', () => {
  // A gate that only ever sees clean input passes vacuously for whoever removed its teeth
  // (.sidekicks/memory/golden-gate-can-pass-vacuously.md). These are the four shapes above, written
  // out, plus the fixture they are supposed to leave alone.
  const offenders = [
    'const r = await gate({ repoRoot: dirname(repoRoot) });',
    "const outside = join(repoRoot, '..', 'somewhere');",
    "const outside = resolve(repoRoot, '..');",
    "const up = new URL('../../../../', import.meta.url);",
    "const up = resolve(here, '..', '..', '..', '..');",
  ];
  for (const src of offenders) {
    assert.ok(UPWARD.some(({ pattern }) => pattern.test(src)), `not matched: ${src}`);
  }

  const hermetic = [
    "const empty = mkdtempSync(join(tmpdir(), 'sk-'));",
    "const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');",
    "const asset = join(repoRoot, '.agents', 'skills', 'sk-inherit');",
  ];
  for (const src of hermetic) {
    assert.equal(UPWARD.some(({ pattern }) => pattern.test(src)), false, `false positive: ${src}`);
  }
});
