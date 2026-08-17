// lib/artifacts-lifecycle/tests/running-agents.test.mjs
// Unit tests for the centralized running-agents view: buildInventory's watchRoots folding,
// agentState mapping, buildRunningAgents derivation, and writeRunningAgents persistence.
// node: stdlib only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  buildInventory,
  buildRunningAgents,
  writeRunningAgents,
  runningAgentsPath,
  ensureInventoryIgnore,
  agentState,
} from '../_manage.mjs';
import { resolveWatchRoots } from '../watch-config.mjs';

const NOW_MS = Date.parse('2026-07-05T12:00:00Z');
const iso = (ageSec) => new Date(NOW_MS - ageSec * 1000).toISOString();

function seed(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'sk-ragents-'));
  mkdirSync(join(root, '.sidekicks'), { recursive: true });
  return root;
}

describe('agentState — status + liveness → UI state', () => {
  test('maps the office-viz vocabulary', () => {
    assert.equal(agentState('running', 'live'), 'working');
    assert.equal(agentState('running', 'stale'), 'asleep');
    assert.equal(agentState('paused', 'live'), 'coffee');
    assert.equal(agentState('blocked', 'stale'), 'blocked');
    assert.equal(agentState('done', 'terminal'), 'offshift');
    assert.equal(agentState('failed', 'terminal'), 'failed');
    assert.equal(agentState('pending', undefined), 'idle');
    assert.equal(agentState('unknown', 'terminal'), 'offshift', 'unrecognized terminal status never reads as working');
  });
});

describe('buildInventory — watchRoots folding', () => {
  test('runs under a watch root join types.runs with the watch scope; dedup vs standard bases', () => {
    const root = makeRepo();
    try {
      // standard base run
      seed(root, 'artifacts/runs/get-plan-done/std-run/run.json', JSON.stringify({
        skill: 'get-plan-done', slug: 'std-run', status: 'running', heartbeat_at: iso(60),
      }));
      // plan-centric run outside the standard bases
      seed(root, 'docs/plans/alpha/artifacts/runs/get-things-done/plan-run/run.json', JSON.stringify({
        skill: 'get-things-done', slug: 'plan-run', status: 'running', heartbeat_at: iso(30),
      }));
      // a watch root that OVERLAPS the standard base must not double-count
      seed(root, '.sidekicks/agents-watch.yaml',
        'agents_watch:\n  watch_roots:\n    - docs/plans/*/artifacts/runs\n    - artifacts/runs\n');

      const watchRoots = resolveWatchRoots(root);
      const inv = buildInventory(root, { nowMs: NOW_MS, staleSeconds: 1800, watchRoots });

      assert.equal(inv.types.runs.length, 2, 'std-run + plan-run, no duplicates');
      const planRun = inv.types.runs.find((r) => r.slug === 'plan-run');
      assert.ok(planRun, 'watch-root run collected');
      assert.equal(planRun.scope, 'watch:docs/plans/alpha/artifacts/runs');
      assert.equal(planRun.liveness, 'live', 'watch-root runs get the same liveness derivation');
      assert.deepEqual(inv.watch_roots.map((w) => w.path).sort(), [
        'artifacts/runs',
        'docs/plans/alpha/artifacts/runs',
      ]);
      // the watched run participates in the activity buckets too
      assert.ok(inv.activity.running.some((r) => r.slug === 'plan-run'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('no watchRoots → watch_roots is empty, behavior unchanged', () => {
    const root = makeRepo();
    try {
      const inv = buildInventory(root, { nowMs: NOW_MS });
      assert.deepEqual(inv.watch_roots, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('buildRunningAgents — the centralized handoff view', () => {
  function seededInventory(root) {
    seed(root, 'artifacts/runs/get-plan-done/w1/run.json', JSON.stringify({
      skill: 'get-plan-done', slug: 'w1', status: 'running', title: 'building', heartbeat_at: iso(60),
    }));
    seed(root, 'artifacts/runs/get-plan-done/z1/run.json', JSON.stringify({
      skill: 'get-plan-done', slug: 'z1', status: 'running', updated_at: iso(200000),
    }));
    seed(root, 'artifacts/runs/get-things-done/d1/run.json', JSON.stringify({
      skill: 'get-things-done', slug: 'd1', status: 'done', jira_card: 'AAP-9',
    }));
    seed(root, 'artifacts/runs/get-things-done/f1/run.json', JSON.stringify({
      skill: 'get-things-done', slug: 'f1', status: 'failed',
    }));
    return buildInventory(root, { nowMs: NOW_MS, staleSeconds: 1800 });
  }

  test('one agent per run with identity, status, liveness, state; totals + ordering', () => {
    const root = makeRepo();
    try {
      const ra = buildRunningAgents(seededInventory(root));
      assert.equal(ra.schema_version, 1);
      assert.equal(ra.totals.agents, 4);
      assert.equal(ra.totals.working, 1);
      assert.equal(ra.totals.asleep, 1);
      assert.equal(ra.totals.offshift, 1);
      assert.equal(ra.totals.failed, 1);

      // active first, terminal last
      assert.equal(ra.agents[0].slug, 'w1');
      assert.equal(ra.agents[0].state, 'working');
      assert.equal(ra.agents[ra.agents.length - 1].state, 'offshift');

      const w1 = ra.agents.find((a) => a.slug === 'w1');
      assert.equal(w1.skill, 'get-plan-done');
      assert.equal(w1.title, 'building');
      assert.equal(w1.live, true);
      assert.equal(w1.liveness, 'live');
      assert.equal(w1.heartbeat_age_seconds, 60);
      assert.equal(w1.id, w1.path, 'id is the repo-relative run path');
      assert.ok(!w1.path.startsWith('/'), 'paths are repo-relative, never machine-absolute');

      const d1 = ra.agents.find((a) => a.slug === 'd1');
      assert.equal(d1.jira_card, 'AAP-9', 'jira binding rides along');
      assert.equal(d1.liveness, 'terminal');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('writeRunningAgents persists to .sidekicks/state/running-agents.json; ignore rule appended', () => {
    const root = makeRepo();
    try {
      const ra = buildRunningAgents(seededInventory(root));
      const { jsonRel } = writeRunningAgents(root, ra);
      assert.equal(jsonRel, join('.sidekicks', 'state', 'running-agents.json'));
      const onDisk = JSON.parse(readFileSync(runningAgentsPath(root), 'utf8'));
      assert.equal(onDisk.totals.agents, 4);

      ensureInventoryIgnore(root);
      const gi = readFileSync(join(root, '.gitignore'), 'utf8');
      assert.ok(gi.includes('.sidekicks/state/running-agents.json'), 'derived cache is git-ignored');
      assert.ok(existsSync(runningAgentsPath(root)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
