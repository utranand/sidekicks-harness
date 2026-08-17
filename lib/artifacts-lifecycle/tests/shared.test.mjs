// lib/artifacts-lifecycle/tests/shared.test.mjs
// Unit tests for the artifacts-lifecycle core (_shared.mjs).
// node:test + node:assert/strict + stdlib only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import {
  resolveStores,
  scanRuns,
  buildIndex,
  renderTimeline,
  inferHeader,
  mapStatus,
  computeExitable,
  toRepoRel,
  fromRepoRel,
  writeRunAtomic,
  readRun,
  upsertChild,
  withRunLease,
  ensureRepoIgnore,
  JIRA_SKILLS,
  STATUS_ENUM,
} from '../_shared.mjs';
import { makeRepo, addProject, writeRunJson, writeLedger, cleanup } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Store + scan-root resolution
// ---------------------------------------------------------------------------

describe('resolveStores — scope-driven anchoring', () => {
  test('root project: anchor + scan root at repo root', () => {
    const root = makeRepo({});
    try {
      const s = resolveStores({ repoRoot: root }, {});
      assert.equal(s.project, 'sidekicks');
      assert.equal(s.projectWorkdir, root);
      assert.equal(s.indexPath, join(root, 'artifacts', 'index.json'));
      assert.equal(s.timelinePath, join(root, 'artifacts', 'ARTIFACTS.md'));
      assert.ok(s.scanRoots.some((r) => r.root === join(root, 'artifacts', 'runs')));
    } finally {
      cleanup(root);
    }
  });

  test('user project: anchor at projects/<p>, no services → single scan root', () => {
    const root = makeRepo({ active_project: 'acme' });
    addProject(root, 'acme');
    try {
      const s = resolveStores({ repoRoot: root }, {});
      assert.equal(s.project, 'acme');
      assert.equal(s.projectWorkdir, join(root, 'projects', 'acme'));
      assert.equal(s.indexPath, join(root, 'projects', 'acme', 'artifacts', 'index.json'));
      // No real index → listServices returns [] → only the project scan root.
      assert.ok(s.scanRoots.length >= 1);
    } finally {
      cleanup(root);
    }
  });

  test('artifacts_dir override wins for the base + anchor', () => {
    const root = makeRepo({});
    try {
      const s = resolveStores({ repoRoot: root }, { artifacts_dir: 'custom/store' });
      assert.equal(s.indexPath, join(root, 'custom', 'store', 'index.json'));
      assert.equal(s.projectStoreDir, join(root, 'custom', 'store'));
    } finally {
      cleanup(root);
    }
  });

  test('never errors on a missing store', () => {
    const root = makeRepo({});
    try {
      assert.doesNotThrow(() => resolveStores({ repoRoot: root }, {}));
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// repo-relative path invariant
// ---------------------------------------------------------------------------

describe('toRepoRel / fromRepoRel', () => {
  test('absolute → forward-slash relative; round-trips', () => {
    const root = '/tmp/repo';
    const abs = join(root, 'artifacts', 'runs', 'x', 'y');
    const rel = toRepoRel(root, abs);
    assert.equal(rel, 'artifacts/runs/x/y');
    assert.equal(fromRepoRel(root, rel), abs);
  });
  test('repo root itself is "."', () => {
    assert.equal(toRepoRel('/tmp/repo', '/tmp/repo'), '.');
  });
});

// ---------------------------------------------------------------------------
// status mapping (F10/N2)
// ---------------------------------------------------------------------------

describe('mapStatus — 5-enum mapping', () => {
  test('open variants → running', () => {
    for (const s of ['executing', 'running', 'awaiting-approval', 'reviewing', 'planning', 'expanded', 'in-progress']) {
      assert.equal(mapStatus(s), 'running', s);
    }
  });
  test('terminal/held/failed', () => {
    assert.equal(mapStatus('done'), 'done');
    assert.equal(mapStatus('completed'), 'done');
    assert.equal(mapStatus('blocked'), 'blocked');
    assert.equal(mapStatus('paused'), 'paused');
    assert.equal(mapStatus('halted'), 'blocked');
    assert.equal(mapStatus('failed'), 'failed');
  });
  test('unknown / empty → unknown', () => {
    assert.equal(mapStatus('frobnicate'), 'unknown');
    assert.equal(mapStatus(''), 'unknown');
    assert.equal(mapStatus(undefined), 'unknown');
  });
  test('every mapped value is in the enum', () => {
    for (const s of ['running', 'done', 'blocked', 'paused', 'failed', 'awaiting-x']) {
      const m = mapStatus(s);
      assert.ok(m === 'unknown' || STATUS_ENUM.includes(m));
    }
  });
});

// ---------------------------------------------------------------------------
// inferHeader — READ-ONLY legacy inference
// ---------------------------------------------------------------------------

describe('inferHeader — non-destructive legacy inference', () => {
  test('reads ledger status + maps it; never writes run.json', () => {
    const root = makeRepo({});
    try {
      const runsRoot = join(root, 'artifacts', 'runs');
      const dir = writeLedger(runsRoot, 'jira-autopilot', 'AAP-9', 'ledger.yaml',
        'status: executing\ntitle: legacy run\nupdated_at: "2026-06-01T10:00:00+07:00"\n');
      const h = inferHeader('jira-autopilot', 'AAP-9', dir);
      assert.equal(h.status, 'running');
      assert.equal(h.title, 'legacy run');
      assert.equal(h.updated_at, '2026-06-01T10:00:00+07:00');
      // No run.json written.
      assert.ok(!existsSync(join(dir, 'run.json')), 'inference must not write run.json');
    } finally {
      cleanup(root);
    }
  });

  test('mission-status.yaml nested mission status + lease timestamps', () => {
    const root = makeRepo({});
    try {
      const runsRoot = join(root, 'artifacts', 'runs');
      const dir = writeLedger(runsRoot, 'get-plan-done', 'foo', 'mission-status.yaml',
        'status: done\ngoal: ship it\nlease:\n  claimed_at: "2026-05-01T00:00:00+07:00"\n  heartbeat_at: "2026-05-02T00:00:00+07:00"\n');
      const h = inferHeader('get-plan-done', 'foo', dir);
      assert.equal(h.status, 'done');
      assert.equal(h.title, 'ship it');
      assert.equal(h.updated_at, '2026-05-02T00:00:00+07:00');
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// scanRuns — multi-root + Jira-only filter (F11)
// ---------------------------------------------------------------------------

describe('scanRuns — Jira-only filter (F11)', () => {
  test('includes Jira-skill runs; excludes non-Jira folders; includes jira_card-bearing runs under any folder', () => {
    const root = makeRepo({});
    try {
      const runsRoot = join(root, 'artifacts', 'runs');
      // Jira skill folder → included
      writeRunJson(runsRoot, 'jira-autopilot', 'AAP-1', { status: 'running', updated_at: '2026-06-01T00:00:00+07:00' });
      // get-jira-done → included
      writeRunJson(runsRoot, 'get-jira-done', 'AAP-2', { status: 'done', updated_at: '2026-06-02T00:00:00+07:00' });
      // non-Jira skill, no jira_card → EXCLUDED
      writeRunJson(runsRoot, 'skill-auditor', 'audit-x', { status: 'done', updated_at: '2026-06-03T00:00:00+07:00' });
      // non-Jira legacy ledger → EXCLUDED
      writeLedger(runsRoot, 'get-plan-done', 'no-card', 'mission-status.yaml', 'status: done\n');
      // get-plan-done WITH a jira_card → INCLUDED
      writeRunJson(runsRoot, 'get-plan-done', 'AAP-5', { status: 'running', jira_card: 'AAP-5', updated_at: '2026-06-04T00:00:00+07:00' });

      const scanRoots = [{ root: runsRoot, repoRoot: root, label: 'project' }];
      const runs = scanRuns(scanRoots);
      const keys = runs.map((r) => `${r.skill}/${r.slug}`).sort();
      assert.deepEqual(keys, ['get-jira-done/AAP-2', 'get-plan-done/AAP-5', 'jira-autopilot/AAP-1']);
      // non-Jira excluded
      assert.ok(!keys.includes('skill-auditor/audit-x'));
      assert.ok(!keys.includes('get-plan-done/no-card'));
    } finally {
      cleanup(root);
    }
  });

  test('scans across multiple roots', () => {
    const root = makeRepo({});
    try {
      const r1 = join(root, 'artifacts', 'runs');
      const r2 = join(root, 'svc', 'src', 'artifacts', 'runs');
      writeRunJson(r1, 'jira-autopilot', 'A-1', { status: 'running', updated_at: '2026-06-01T00:00:00+07:00' });
      writeRunJson(r2, 'jira-autopilot', 'B-1', { status: 'done', updated_at: '2026-06-02T00:00:00+07:00' });
      const runs = scanRuns([
        { root: r1, repoRoot: root, label: 'project' },
        { root: r2, repoRoot: join(root, 'svc', 'src'), label: 'service:svc' },
      ]);
      assert.equal(runs.length, 2);
      assert.ok(runs.find((r) => r.slug === 'B-1' && r.sourceLabel === 'service:svc'));
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// buildIndex / renderTimeline ordering
// ---------------------------------------------------------------------------

describe('buildIndex / renderTimeline — newest first', () => {
  test('runs sorted by updated_at descending', () => {
    const root = makeRepo({});
    try {
      const runsRoot = join(root, 'artifacts', 'runs');
      writeRunJson(runsRoot, 'jira-autopilot', 'OLD', { status: 'done', title: 'old', updated_at: '2026-01-01T00:00:00+07:00' });
      writeRunJson(runsRoot, 'jira-autopilot', 'NEW', { status: 'running', title: 'new', updated_at: '2026-12-01T00:00:00+07:00' });
      const scan = scanRuns([{ root: runsRoot, repoRoot: root, label: 'project' }]);
      const idx = buildIndex(scan, { project: 'sidekicks', projectWorkdir: root });
      assert.equal(idx.schema_version, 1);
      assert.equal(idx.scope, 'project');
      assert.equal(idx.runs[0].slug, 'NEW');
      assert.equal(idx.runs[1].slug, 'OLD');
      assert.equal(idx.runs[0].run_dir, 'artifacts/runs/jira-autopilot/NEW');

      const tl = renderTimeline(scan, { project: 'sidekicks' });
      const newIdx = tl.indexOf('NEW');
      const oldIdx = tl.indexOf('OLD');
      assert.ok(newIdx !== -1 && oldIdx !== -1 && newIdx < oldIdx, 'NEW must precede OLD');
      assert.ok(tl.includes('- [running] jira-autopilot/NEW — new'));
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// writeRunAtomic — create / merge / status validation / created_at preservation
// ---------------------------------------------------------------------------

describe('writeRunAtomic', () => {
  test('creates created_at + updated_at; preserves created_at on rewrite', () => {
    const root = makeRepo({});
    try {
      const dir = join(root, 'artifacts', 'runs', 'jira-autopilot', 'X');
      mkdirSync(dir, { recursive: true });
      const first = writeRunAtomic(dir, { skill: 'jira-autopilot', slug: 'X', status: 'running' });
      assert.ok(first.created_at);
      const created = first.created_at;
      const read1 = readRun(dir);
      const second = writeRunAtomic(dir, { ...read1, status: 'done' });
      assert.equal(second.created_at, created, 'created_at preserved');
      assert.equal(second.status, 'done');
    } finally {
      cleanup(root);
    }
  });

  test('rejects an invalid status', () => {
    const root = makeRepo({});
    try {
      const dir = join(root, 'artifacts', 'runs', 'jira-autopilot', 'Y');
      mkdirSync(dir, { recursive: true });
      assert.throws(() => writeRunAtomic(dir, { status: 'bogus' }), /invalid status/);
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// upsertChild — subtask tree (F12) + ralph fields (F13)
// ---------------------------------------------------------------------------

describe('upsertChild — subtask tree + lineage', () => {
  function parent(root) {
    const dir = join(root, 'artifacts', 'runs', 'get-jira-done', 'AAP-1');
    mkdirSync(dir, { recursive: true });
    writeRunAtomic(dir, { skill: 'get-jira-done', slug: 'AAP-1', status: 'running', goal: 'all done' });
    return dir;
  }

  test('creates subtasks[] on first child; appends new key; updates in place; bubbles parent updated_at', () => {
    const root = makeRepo({});
    try {
      const dir = parent(root);

      // first child creates the array
      const p1 = upsertChild(dir, 'AAP-2', { status: 'running', title: 'two', goal: 'g2' });
      assert.equal(p1.subtasks.length, 1);
      assert.equal(p1.subtasks[0].key, 'AAP-2');
      // bubble semantics: a child change moves the parent updated_at to the same
      // instant as the child row's updated_at (timestamps are 1s-granular).
      assert.equal(p1.updated_at, p1.subtasks[0].updated_at, 'parent updated_at bubbled to the child instant');

      // update in place
      const p2 = upsertChild(dir, 'AAP-2', { status: 'done' });
      assert.equal(p2.subtasks.length, 1);
      assert.equal(p2.subtasks[0].status, 'done');

      // new key appends (dynamic expansion)
      const p3 = upsertChild(dir, 'AAP-7', { status: 'running' });
      assert.equal(p3.subtasks.length, 2);
      assert.ok(p3.subtasks.find((r) => r.key === 'AAP-7'));
    } finally {
      cleanup(root);
    }
  });

  test('validates child status and verdict.result', () => {
    const root = makeRepo({});
    try {
      const dir = parent(root);
      assert.throws(() => upsertChild(dir, 'AAP-2', { status: 'nope' }), /invalid subtask status/);
      assert.throws(() => upsertChild(dir, 'AAP-2', { verdict: { result: 'maybe' } }), /invalid verdict/);
    } finally {
      cleanup(root);
    }
  });

  test('verdict round-trips with checked_at', () => {
    const root = makeRepo({});
    try {
      const dir = parent(root);
      const p = upsertChild(dir, 'AAP-2', { status: 'done', verdict: { result: 'pass', evidence: 'tests green' } });
      const row = p.subtasks[0];
      assert.equal(row.verdict.result, 'pass');
      assert.equal(row.verdict.evidence, 'tests green');
      assert.ok(row.verdict.checked_at);
    } finally {
      cleanup(root);
    }
  });

  test('expands_from writes bidirectional expanded_into (idempotent)', () => {
    const root = makeRepo({});
    try {
      const dir = parent(root);
      upsertChild(dir, 'AAP-3', { status: 'failed', origin: 'parent' });
      const p = upsertChild(dir, 'AAP-7', { status: 'running', origin: 'expansion', expands_from: 'AAP-3' });
      const r3 = p.subtasks.find((r) => r.key === 'AAP-3');
      const r7 = p.subtasks.find((r) => r.key === 'AAP-7');
      assert.deepEqual(r3.expanded_into, ['AAP-7']);
      assert.equal(r7.expands_from, 'AAP-3');
      // idempotent — re-applying does not duplicate
      const p2 = upsertChild(dir, 'AAP-7', { expands_from: 'AAP-3' });
      assert.deepEqual(p2.subtasks.find((r) => r.key === 'AAP-3').expanded_into, ['AAP-7']);
    } finally {
      cleanup(root);
    }
  });

  test('attempts: set then --bump-attempts increments', () => {
    const root = makeRepo({});
    try {
      const dir = parent(root);
      upsertChild(dir, 'AAP-2', { attempts: 2 });
      assert.equal(readRun(dir).subtasks[0].attempts, 2);
      upsertChild(dir, 'AAP-2', { bumpAttempts: true });
      assert.equal(readRun(dir).subtasks[0].attempts, 3);
    } finally {
      cleanup(root);
    }
  });

  test('--remove drops the row', () => {
    const root = makeRepo({});
    try {
      const dir = parent(root);
      upsertChild(dir, 'AAP-2', { status: 'running' });
      upsertChild(dir, 'AAP-3', { status: 'running' });
      const p = upsertChild(dir, 'AAP-2', { remove: true });
      assert.equal(p.subtasks.length, 1);
      assert.equal(p.subtasks[0].key, 'AAP-3');
    } finally {
      cleanup(root);
    }
  });

  test('leaf run (register-only) has no subtasks key', () => {
    const root = makeRepo({});
    try {
      const dir = join(root, 'artifacts', 'runs', 'jira-autopilot', 'LEAF');
      mkdirSync(dir, { recursive: true });
      writeRunAtomic(dir, { skill: 'jira-autopilot', slug: 'LEAF', status: 'done' });
      const m = readRun(dir);
      assert.ok(!('subtasks' in m), 'leaf run must omit subtasks');
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// computeExitable — the exit predicate (F13)
// ---------------------------------------------------------------------------

describe('computeExitable — exit predicate', () => {
  test('exitable iff every subtask done+pass AND remaining/unmet empty', () => {
    const ok = {
      status: 'running',
      subtasks: [
        { key: 'a', status: 'done', verdict: { result: 'pass' } },
        { key: 'b', status: 'done', verdict: { result: 'pass' } },
      ],
      exit_check: { remaining: [], unmet: [] },
    };
    assert.equal(computeExitable(ok).exitable, true);
  });

  test('not exitable when a subtask is not done', () => {
    const m = { subtasks: [{ key: 'a', status: 'running' }] };
    assert.equal(computeExitable(m).exitable, false);
  });

  test('not exitable when verified fail', () => {
    const m = { subtasks: [{ key: 'a', status: 'done', verdict: { result: 'fail' } }] };
    assert.equal(computeExitable(m).exitable, false);
  });

  test('not exitable with non-empty remaining/unmet', () => {
    const m = {
      subtasks: [{ key: 'a', status: 'done', verdict: { result: 'pass' } }],
      exit_check: { unmet: ['c3'] },
    };
    assert.equal(computeExitable(m).exitable, false);
  });

  test('convergence guard: attempts==max_attempts without pass is detectable', () => {
    const m = {
      max_attempts: 3,
      subtasks: [{ key: 'a', status: 'failed', attempts: 3, verdict: { result: 'fail' } }],
    };
    const st = m.subtasks[0];
    assert.ok(st.attempts === m.max_attempts && (!st.verdict || st.verdict.result !== 'pass'));
    assert.equal(computeExitable(m).exitable, false);
  });
});

// ---------------------------------------------------------------------------
// withRunLease — non-blocking, stale reclaim, same-run serialize
// ---------------------------------------------------------------------------

describe('withRunLease', () => {
  test('runs fn and cleans up the lock', () => {
    const root = makeRepo({});
    try {
      const dir = join(root, 'artifacts', 'runs', 'jira-autopilot', 'L');
      let ran = false;
      withRunLease(dir, () => { ran = true; });
      assert.ok(ran);
      assert.ok(!existsSync(join(dir, 'run.json.lock')), 'lock released');
    } finally {
      cleanup(root);
    }
  });

  test('proceeds (non-blocking) even when a fresh lock is held by another writer', () => {
    const root = makeRepo({});
    try {
      const dir = join(root, 'artifacts', 'runs', 'jira-autopilot', 'L2');
      mkdirSync(dir, { recursive: true });
      // Simulate a live foreign lock (fresh mtime).
      writeFileSync(join(dir, 'run.json.lock'), 'held');
      let ran = false;
      const start = Date.now();
      withRunLease(dir, () => { ran = true; });
      const elapsed = Date.now() - start;
      assert.ok(ran, 'must proceed anyway, never block');
      assert.ok(elapsed < 2000, 'bounded retry budget — never blocks indefinitely');
    } finally {
      cleanup(root);
    }
  });

  test('reclaims a stale lock', () => {
    const root = makeRepo({});
    try {
      const dir = join(root, 'artifacts', 'runs', 'jira-autopilot', 'L3');
      mkdirSync(dir, { recursive: true });
      const lock = join(dir, 'run.json.lock');
      writeFileSync(lock, 'old');
      // Backdate the lock mtime well past the TTL.
      const past = new Date(Date.now() - 60000);
      utimesSync(lock, past, past);
      let ran = false;
      withRunLease(dir, () => { ran = true; });
      assert.ok(ran);
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// ensureRepoIgnore — per-repo .gitignore self-heal (F3)
// ---------------------------------------------------------------------------

describe('ensureRepoIgnore', () => {
  test('adds artifacts/index.json rule when absent; idempotent', () => {
    const root = makeRepo({});
    try {
      const r1 = ensureRepoIgnore(root);
      assert.equal(r1.changed, true);
      const gi = readFileSync(join(root, '.gitignore'), 'utf8');
      assert.ok(/^artifacts\/index\.json$/m.test(gi));
      // idempotent
      const r2 = ensureRepoIgnore(root);
      assert.equal(r2.changed, false);
    } finally {
      cleanup(root);
    }
  });

  test('no-op when a root-form /artifacts/index.json rule already exists', () => {
    const root = makeRepo({});
    try {
      writeFileSync(join(root, '.gitignore'), '/artifacts/index.json\n');
      const r = ensureRepoIgnore(root);
      assert.equal(r.changed, false);
    } finally {
      cleanup(root);
    }
  });
});

describe('JIRA_SKILLS constant', () => {
  test('is the named filter set', () => {
    assert.deepEqual([...JIRA_SKILLS].sort(), ['get-jira-done', 'jira-autopilot', 'jira-ready-gate']);
  });
});
