// lib/artifacts-lifecycle/tests/watch-config.test.mjs
// Unit tests for the .sidekicks/agents-watch.yaml loader + watch-root resolution.
// node: stdlib only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readWatchConfig, resolveWatchRoots, expandWatchPattern } from '../watch-config.mjs';

function repoWith(yamlText) {
  const root = mkdtempSync(join(tmpdir(), 'sk-wcfg-'));
  mkdirSync(join(root, '.sidekicks'), { recursive: true });
  if (yamlText != null) writeFileSync(join(root, '.sidekicks', 'agents-watch.yaml'), yamlText, 'utf8');
  return root;
}

describe('readWatchConfig', () => {
  test('absent file → enabled, no extra roots (fresh clone needs no config)', () => {
    const root = repoWith(null);
    try {
      assert.deepEqual(readWatchConfig(root), { enabled: true, watchRoots: [], source: 'default' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('reads the agents_watch: block — strings and { path, dept } entries', () => {
    const root = repoWith(
      'agents_watch:\n  watch_roots:\n    - docs/plans/*/artifacts/runs\n    - path: projects/p1/custom/runs\n      dept: p1\n',
    );
    try {
      const c = readWatchConfig(root);
      assert.equal(c.source, 'file');
      assert.equal(c.enabled, true);
      assert.deepEqual(c.watchRoots, [
        'docs/plans/*/artifacts/runs',
        { path: 'projects/p1/custom/runs', dept: 'p1' },
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('tolerates a flat file with no agents_watch wrapper', () => {
    const root = repoWith('watch_roots:\n  - extra/runs\n');
    try {
      assert.deepEqual(readWatchConfig(root).watchRoots, ['extra/runs']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('enabled: false opts out; invalid entries are dropped', () => {
    const root = repoWith('agents_watch:\n  enabled: false\n  watch_roots:\n    - ""\n    - real/runs\n');
    try {
      const c = readWatchConfig(root);
      assert.equal(c.enabled, false);
      assert.deepEqual(c.watchRoots, ['real/runs']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('unparseable / garbage file → safe fallback (never throws, no roots)', () => {
    const root = repoWith(':\n  : not valid : yaml : @#$\n\t- broken');
    try {
      const c = readWatchConfig(root); // parser may salvage an object or bail — either way: safe
      assert.equal(c.enabled, true);
      assert.deepEqual(c.watchRoots, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('expandWatchPattern', () => {
  test('single-segment * expands to every child dir; literal segments must exist', () => {
    const root = repoWith(null);
    try {
      mkdirSync(join(root, 'docs', 'plans', 'a', 'artifacts', 'runs'), { recursive: true });
      mkdirSync(join(root, 'docs', 'plans', 'b', 'artifacts', 'runs'), { recursive: true });
      mkdirSync(join(root, 'docs', 'plans', 'c'), { recursive: true }); // no artifacts/runs
      const hits = expandWatchPattern(root, 'docs/plans/*/artifacts/runs').sort();
      assert.deepEqual(hits, [
        join(root, 'docs', 'plans', 'a', 'artifacts', 'runs'),
        join(root, 'docs', 'plans', 'b', 'artifacts', 'runs'),
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('resolveWatchRoots', () => {
  test('resolves existing roots only, dedupes, labels scope', () => {
    const root = repoWith(
      'agents_watch:\n  watch_roots:\n    - docs/plans/*/artifacts/runs\n    - docs/plans/a/artifacts/runs\n    - missing/runs\n    - path: projects/p1/custom/runs\n      dept: p1-room\n    - projects/p2/extra/runs\n',
    );
    try {
      mkdirSync(join(root, 'docs', 'plans', 'a', 'artifacts', 'runs'), { recursive: true });
      mkdirSync(join(root, 'projects', 'p1', 'custom', 'runs'), { recursive: true });
      mkdirSync(join(root, 'projects', 'p2', 'extra', 'runs'), { recursive: true });
      const roots = resolveWatchRoots(root);
      const byRel = Object.fromEntries(roots.map((r) => [r.rel, r.scope]));
      assert.equal(roots.length, 3, 'duplicate + missing entries dropped');
      assert.equal(byRel['docs/plans/a/artifacts/runs'], 'watch:docs/plans/a/artifacts/runs');
      assert.equal(byRel['projects/p1/custom/runs'], 'p1-room', 'pinned dept wins');
      assert.equal(byRel['projects/p2/extra/runs'], 'project:p2', 'derived from projects/<p>/ prefix');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('enabled: false → no roots even when dirs exist', () => {
    const root = repoWith('agents_watch:\n  enabled: false\n  watch_roots:\n    - extra/runs\n');
    try {
      mkdirSync(join(root, 'extra', 'runs'), { recursive: true });
      assert.deepEqual(resolveWatchRoots(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
