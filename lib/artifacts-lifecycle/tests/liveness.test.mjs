// lib/artifacts-lifecycle/tests/liveness.test.mjs
// Unit tests for the derived run-liveness classification added to the artifact inventory:
// `deriveLiveness`, `runLivenessInputs`, and `buildInventory`'s activity buckets.
//
// nowMs + staleSeconds are injected so the "fresh vs stale" verdict is fully deterministic
// (no wall-clock dependence). node: stdlib only — no npm packages.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  deriveLiveness,
  runLivenessInputs,
  buildInventory,
  STALE_RUNNING_SECONDS,
} from '../_manage.mjs';

// A fixed reference "now" so seed timestamps are exact ages, not wall-clock-relative.
const NOW_MS = Date.parse('2026-07-05T12:00:00Z');
const iso = (ageSec) => new Date(NOW_MS - ageSec * 1000).toISOString();

function seed(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'sk-liveness-'));
  mkdirSync(join(root, '.sidekicks'), { recursive: true });
  return root;
}

describe('deriveLiveness — status + heartbeat-age → verdict', () => {
  test('active status + fresh heartbeat → live', () => {
    const v = deriveLiveness('running', NOW_MS - 60_000, NOW_MS, 1800);
    assert.equal(v.live, true);
    assert.equal(v.liveness, 'live');
    assert.equal(v.heartbeat_age_seconds, 60);
  });

  test('active status + heartbeat past threshold → stale', () => {
    const v = deriveLiveness('running', NOW_MS - 100_000_000, NOW_MS, 1800);
    assert.equal(v.live, false);
    assert.equal(v.liveness, 'stale');
    assert.ok(v.heartbeat_age_seconds > 1800);
  });

  test('active status + unparseable/absent heartbeat → stale (cannot prove alive)', () => {
    const v = deriveLiveness('blocked', null, NOW_MS, 1800);
    assert.equal(v.live, false);
    assert.equal(v.liveness, 'stale');
    assert.equal(v.heartbeat_age_seconds, null);
  });

  test('paused counts as active — fresh paused run is live', () => {
    assert.equal(deriveLiveness('paused', NOW_MS - 10_000, NOW_MS, 1800).liveness, 'live');
  });

  test('terminal status (done/failed/unknown) → terminal, never live', () => {
    for (const s of ['done', 'failed', 'unknown']) {
      const v = deriveLiveness(s, NOW_MS, NOW_MS, 1800);
      assert.equal(v.live, false);
      assert.equal(v.liveness, 'terminal');
      assert.equal(v.heartbeat_age_seconds, null);
    }
  });

  test('exactly at the threshold is still live (≤, not <)', () => {
    assert.equal(deriveLiveness('running', NOW_MS - 1800_000, NOW_MS, 1800).liveness, 'live');
  });

  test('default threshold constant is exported and sane', () => {
    assert.equal(typeof STALE_RUNNING_SECONDS, 'number');
    assert.ok(STALE_RUNNING_SECONDS > 0);
  });
});

describe('runLivenessInputs — heartbeat source precedence', () => {
  test('run.json: heartbeat_at wins over updated_at', () => {
    const root = makeRepo();
    try {
      const dir = 'artifacts/runs/get-plan-done/r1';
      seed(root, `${dir}/run.json`, JSON.stringify({
        skill: 'get-plan-done', slug: 'r1', status: 'running',
        heartbeat_at: iso(30), updated_at: iso(9999),
      }));
      const inp = runLivenessInputs(join(root, dir), 'get-plan-done', 'r1');
      assert.equal(inp.status, 'running');
      assert.equal(inp.heartbeatIso, iso(30));
      assert.equal(Math.round((NOW_MS - inp.heartbeatMs) / 1000), 30);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('ledger (no run.json): lease.heartbeat_at feeds the age via inferHeader', () => {
    const root = makeRepo();
    try {
      const dir = 'artifacts/runs/get-things-done/q1';
      seed(root, `${dir}/tasks.yaml`, `status: running\nlease:\n  heartbeat_at: "${iso(50000)}"\n`);
      const inp = runLivenessInputs(join(root, dir), 'get-things-done', 'q1');
      assert.equal(inp.status, 'running');
      assert.equal(Math.round((NOW_MS - inp.heartbeatMs) / 1000), 50000);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('buildInventory — activity buckets + per-run liveness', () => {
  function seededRepo() {
    const root = makeRepo();
    // live: running + fresh heartbeat
    seed(root, 'artifacts/runs/get-plan-done/live-run/run.json', JSON.stringify({
      skill: 'get-plan-done', slug: 'live-run', status: 'running', title: 'in flight', heartbeat_at: iso(60),
    }));
    // stale: running but updated_at is ancient (no heartbeat_at → falls to updated_at)
    seed(root, 'artifacts/runs/get-plan-done/stale-run/run.json', JSON.stringify({
      skill: 'get-plan-done', slug: 'stale-run', status: 'running', updated_at: iso(200000),
    }));
    // live: paused + fresh (paused is an ACTIVE status)
    seed(root, 'artifacts/runs/get-plan-done/paused-fresh/run.json', JSON.stringify({
      skill: 'get-plan-done', slug: 'paused-fresh', status: 'paused', heartbeat_at: iso(120),
    }));
    // terminal: done — never in a bucket
    seed(root, 'artifacts/runs/get-plan-done/done-run/run.json', JSON.stringify({
      skill: 'get-plan-done', slug: 'done-run', status: 'done',
    }));
    // stale ledger run: status running via tasks.yaml, ancient lease heartbeat
    seed(root, 'artifacts/runs/get-things-done/ledger-stale/tasks.yaml',
      `status: running\nlease:\n  heartbeat_at: "${iso(300000)}"\n`);
    return root;
  }

  test('splits active runs into running (fresh) vs stale (orphaned); terminal excluded', () => {
    const root = seededRepo();
    try {
      const inv = buildInventory(root, { nowMs: NOW_MS, staleSeconds: 1800 });

      assert.equal(inv.stale_seconds_threshold, 1800);
      assert.equal(inv.totals.running_live, 2, 'live-run + paused-fresh');
      assert.equal(inv.totals.stale_running, 2, 'stale-run + ledger-stale');

      const runningSlugs = inv.activity.running.map((r) => r.slug).sort();
      assert.deepEqual(runningSlugs, ['live-run', 'paused-fresh']);
      const staleSlugs = inv.activity.stale.map((r) => r.slug).sort();
      assert.deepEqual(staleSlugs, ['ledger-stale', 'stale-run']);

      // done-run is terminal — in neither bucket
      const done = inv.types.runs.find((r) => r.slug === 'done-run');
      assert.equal(done.liveness, 'terminal');
      assert.equal(done.live, false);

      // per-run fields present and coherent
      const live = inv.types.runs.find((r) => r.slug === 'live-run');
      assert.equal(live.live, true);
      assert.equal(live.liveness, 'live');
      assert.equal(live.heartbeat_age_seconds, 60);

      // activity refs carry the locating fields
      const staleRef = inv.activity.stale.find((r) => r.slug === 'stale-run');
      assert.equal(staleRef.status, 'running');
      assert.ok(staleRef.path.endsWith('runs/get-plan-done/stale-run'));
      assert.ok(staleRef.heartbeat_age_seconds > 1800);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a wider threshold reclassifies a would-be-stale run as live', () => {
    const root = seededRepo();
    try {
      // stale-run is 200000s old; ledger-stale 300000s. Threshold 250000 keeps only ledger-stale stale.
      const inv = buildInventory(root, { nowMs: NOW_MS, staleSeconds: 250000 });
      assert.equal(inv.totals.stale_running, 1);
      assert.equal(inv.activity.stale[0].slug, 'ledger-stale');
      assert.equal(inv.totals.running_live, 3, 'live-run + paused-fresh + stale-run (now under threshold)');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
