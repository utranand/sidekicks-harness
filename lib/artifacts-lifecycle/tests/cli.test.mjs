// lib/artifacts-lifecycle/tests/cli.test.mjs
// Subprocess (dispatch + integration) tests for `sidekicks artifacts ...`.
// node:test + node:assert/strict + node:child_process + stdlib only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { sk, makeRepo, writeRunJson, writeLedger, cleanup, repoRoot } from './helpers.mjs';
import { VERBS } from '../../sk-cli/help.mjs';

// ---------------------------------------------------------------------------
// c1 — help + dispatch
// ---------------------------------------------------------------------------

// The verb list is DERIVED from the registry, never hand-counted. This block said "all six verbs"
// and checked six while the namespace had grown to nine (scan, archive, restore) — a doc-and-test
// drift the audit caught, and one that made the coverage claim quietly false. Deriving it means a
// tenth verb is covered by the check the day it is registered.
const ARTIFACTS_VERBS = VERBS.filter((v) => v.namespace === 'artifacts').map((v) => v.verb);

describe(`c1 — namespace help + all ${ARTIFACTS_VERBS.length} verbs dispatch`, () => {
  test('artifacts --help lists EVERY registered artifacts verb', () => {
    const root = makeRepo({});
    try {
      const { status, stdout } = sk(root, ['artifacts', '--help']);
      assert.equal(status, 0);
      assert.ok(stdout.includes('sidekicks artifacts commands'));
      const absent = ARTIFACTS_VERBS.filter((v) => !stdout.includes(v));
      assert.deepEqual(absent, [], `help omits registered verb(s): ${absent.join(', ')}`);
    } finally {
      cleanup(root);
    }
  });

  test('no registered verb answers "not yet implemented"', () => {
    // Dispatch only — several verbs need arguments and will exit non-zero on a usage error, which
    // is a real answer. The failure this catches is a verb in the table with no module behind it.
    const root = makeRepo({});
    try {
      for (const v of ARTIFACTS_VERBS) {
        const r = sk(root, ['artifacts', v]);
        assert.ok(!`${r.stdout}${r.stderr}`.includes('not yet implemented'),
          `artifacts ${v} has no implementation behind it`);
      }
    } finally {
      cleanup(root);
    }
  });

  test('top-level help lists the artifacts namespace', () => {
    const root = makeRepo({});
    try {
      const { stdout } = sk(root, ['--help']);
      assert.ok(stdout.includes('artifacts'));
      assert.ok(stdout.includes('artifacts commands:'));
    } finally {
      cleanup(root);
    }
  });

  test('each verb dispatches (no "not yet implemented")', () => {
    const root = makeRepo({});
    try {
      // rebuild on an empty store
      const reb = sk(root, ['artifacts', 'rebuild']);
      assert.equal(reb.status, 0, reb.stderr);
      assert.ok(!reb.stderr.includes('not yet implemented'));
      // list / timeline on empty store
      assert.equal(sk(root, ['artifacts', 'list']).status, 0);
      assert.equal(sk(root, ['artifacts', 'timeline']).status, 0);
      // register
      const reg = sk(root, ['artifacts', 'register', 'jira-autopilot', 'AAP-1', 'status=running', 'title=hi']);
      assert.equal(reg.status, 0, reg.stdout + reg.stderr);
      // child
      const ch = sk(root, ['artifacts', 'child', 'jira-autopilot', 'AAP-1', 'AAP-2', 'status=running']);
      assert.equal(ch.status, 0, ch.stdout + ch.stderr);
      // show
      const sh = sk(root, ['artifacts', 'show', 'AAP-1']);
      assert.equal(sh.status, 0, sh.stdout + sh.stderr);
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// c3 — register create + merge; scan-on-read without manual rebuild
// ---------------------------------------------------------------------------

describe('c3 — register create/merge + scan-on-read', () => {
  test('creates run.json; second register preserves created_at, updates status; shows in timeline without rebuild', () => {
    const root = makeRepo({});
    try {
      sk(root, ['artifacts', 'register', 'jira-autopilot', 'AAP-1', 'status=running', 'title=epic']);
      const rjPath = join(root, 'artifacts', 'runs', 'jira-autopilot', 'AAP-1', 'run.json');
      assert.ok(existsSync(rjPath), 'run.json created co-located');
      const m1 = JSON.parse(readFileSync(rjPath, 'utf8'));
      assert.equal(m1.status, 'running');
      assert.ok(/\+07:00$/.test(m1.created_at), 'Bangkok timestamp');
      const created = m1.created_at;

      sk(root, ['artifacts', 'register', 'jira-autopilot', 'AAP-1', 'status=done']);
      const m2 = JSON.parse(readFileSync(rjPath, 'utf8'));
      assert.equal(m2.created_at, created, 'created_at preserved');
      assert.equal(m2.status, 'done');

      // scan-on-read: timeline reflects it without a manual rebuild
      const tl = sk(root, ['artifacts', 'timeline', '--json']);
      const runs = JSON.parse(tl.stdout);
      assert.ok(runs.find((r) => r.slug === 'AAP-1' && r.status === 'done'));
    } finally {
      cleanup(root);
    }
  });

  test('register does NOT write index.json or ARTIFACTS.md (F9)', () => {
    const root = makeRepo({});
    try {
      sk(root, ['artifacts', 'register', 'jira-autopilot', 'AAP-1', 'status=running']);
      assert.ok(!existsSync(join(root, 'artifacts', 'index.json')), 'register must not write the index');
      assert.ok(!existsSync(join(root, 'artifacts', 'ARTIFACTS.md')), 'register must not write the timeline');
    } finally {
      cleanup(root);
    }
  });

  test('invalid status is rejected', () => {
    const root = makeRepo({});
    try {
      const r = sk(root, ['artifacts', 'register', 'jira-autopilot', 'X', 'status=bogus']);
      assert.notEqual(r.status, 0);
      assert.ok((r.stdout + r.stderr).includes('invalid status'));
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// c8 — subtask tree via CLI
// ---------------------------------------------------------------------------

describe('c8 — subtask tree via child + show', () => {
  test('child adds row, updates in place, appends new key; show renders the tree', () => {
    const root = makeRepo({});
    try {
      sk(root, ['artifacts', 'register', 'get-jira-done', 'AAP-1', 'status=running', 'goal=all done']);
      sk(root, ['artifacts', 'child', 'get-jira-done', 'AAP-1', 'AAP-2', 'status=running', 'title=two']);
      sk(root, ['artifacts', 'child', 'get-jira-done', 'AAP-1', 'AAP-2', 'status=done']);
      sk(root, ['artifacts', 'child', 'get-jira-done', 'AAP-1', 'AAP-7', 'status=running', 'title=seven']);

      const sh = sk(root, ['artifacts', 'show', 'AAP-1', '--skill', 'get-jira-done', '--json']);
      const m = JSON.parse(sh.stdout);
      assert.equal(m.subtasks.length, 2);
      assert.equal(m.subtasks.find((r) => r.key === 'AAP-2').status, 'done');
      assert.ok(m.subtasks.find((r) => r.key === 'AAP-7'));

      const human = sk(root, ['artifacts', 'show', 'AAP-1', '--skill', 'get-jira-done']);
      assert.ok(human.stdout.includes('subtasks:'));
      assert.ok(human.stdout.includes('AAP-2'));
    } finally {
      cleanup(root);
    }
  });

  test('--bump-attempts and --remove via CLI flags', () => {
    const root = makeRepo({});
    try {
      sk(root, ['artifacts', 'register', 'get-jira-done', 'AAP-1', 'status=running']);
      sk(root, ['artifacts', 'child', 'get-jira-done', 'AAP-1', 'AAP-2', 'status=running', 'attempts=1']);
      sk(root, ['artifacts', 'child', 'get-jira-done', 'AAP-1', 'AAP-2', '--bump-attempts']);
      let m = JSON.parse(sk(root, ['artifacts', 'show', 'AAP-1', '--skill', 'get-jira-done', '--json']).stdout);
      assert.equal(m.subtasks[0].attempts, 2);
      sk(root, ['artifacts', 'child', 'get-jira-done', 'AAP-1', 'AAP-2', '--remove']);
      m = JSON.parse(sk(root, ['artifacts', 'show', 'AAP-1', '--skill', 'get-jira-done', '--json']).stdout);
      assert.equal((m.subtasks || []).length, 0);
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// c9 — ralph exit fields round-trip via CLI
// ---------------------------------------------------------------------------

describe('c9 — ralph-loop exit fields round-trip', () => {
  test('parent goal/max_attempts/exit_check + subtask verdict/origin/expands_from/expanded_into', () => {
    const root = makeRepo({});
    try {
      sk(root, ['artifacts', 'register', 'get-jira-done', 'AAP-1',
        'status=running', 'goal=ship epic', 'max_attempts=3',
        'exitable=false', 'remaining=AAP-2,AAP-3', 'unmet=c1']);
      const m = JSON.parse(sk(root, ['artifacts', 'show', 'AAP-1', '--skill', 'get-jira-done', '--json']).stdout);
      assert.equal(m.goal, 'ship epic');
      assert.equal(m.max_attempts, 3);
      assert.equal(m.exit_check.exitable, false);
      assert.deepEqual(m.exit_check.remaining, ['AAP-2', 'AAP-3']);
      assert.deepEqual(m.exit_check.unmet, ['c1']);
      assert.ok(m.exit_check.checked_at);

      sk(root, ['artifacts', 'child', 'get-jira-done', 'AAP-1', 'AAP-3', 'status=failed', 'origin=parent']);
      sk(root, ['artifacts', 'child', 'get-jira-done', 'AAP-1', 'AAP-7',
        'status=done', 'origin=expansion', 'expands_from=AAP-3',
        'verdict_result=pass', 'verdict_evidence=tests green', 'goal=follow-up']);
      const m2 = JSON.parse(sk(root, ['artifacts', 'show', 'AAP-1', '--skill', 'get-jira-done', '--json']).stdout);
      const r3 = m2.subtasks.find((r) => r.key === 'AAP-3');
      const r7 = m2.subtasks.find((r) => r.key === 'AAP-7');
      assert.deepEqual(r3.expanded_into, ['AAP-7']);
      assert.equal(r7.expands_from, 'AAP-3');
      assert.equal(r7.verdict.result, 'pass');
      assert.equal(r7.goal, 'follow-up');
    } finally {
      cleanup(root);
    }
  });

  test('invalid verdict.result is rejected', () => {
    const root = makeRepo({});
    try {
      sk(root, ['artifacts', 'register', 'get-jira-done', 'AAP-1', 'status=running']);
      const r = sk(root, ['artifacts', 'child', 'get-jira-done', 'AAP-1', 'AAP-2', 'verdict_result=maybe']);
      assert.notEqual(r.status, 0);
      assert.ok((r.stdout + r.stderr).includes('invalid verdict'));
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// c2 — rebuild + timeline across roots; legacy inference; Jira-only filter
// ---------------------------------------------------------------------------

describe('c2 — rebuild + timeline (legacy inference, Jira-only filter)', () => {
  test('lists every Jira run newest-first; excludes non-Jira folders; infers legacy headers', () => {
    const root = makeRepo({});
    try {
      const runsRoot = join(root, 'artifacts', 'runs');
      writeRunJson(runsRoot, 'jira-autopilot', 'AAP-1', { status: 'running', title: 'a', updated_at: '2026-06-01T00:00:00+07:00' });
      writeLedger(runsRoot, 'get-jira-done', 'AAP-9', 'batch.yaml', 'status: done\ntitle: legacy batch\nupdated_at: "2026-07-01T00:00:00+07:00"\n');
      // non-Jira folders present on disk → must NOT be listed
      writeRunJson(runsRoot, 'skill-auditor', 'audit-1', { status: 'done', updated_at: '2026-08-01T00:00:00+07:00' });
      writeLedger(runsRoot, 'get-plan-done', 'mission-x', 'mission-status.yaml', 'status: done\n');

      const reb = sk(root, ['artifacts', 'rebuild']);
      assert.equal(reb.status, 0, reb.stderr);
      assert.ok(/inferred/.test(reb.stdout));

      // The derived files were written by rebuild (only).
      assert.ok(existsSync(join(root, 'artifacts', 'index.json')));
      assert.ok(existsSync(join(root, 'artifacts', 'ARTIFACTS.md')));

      const tl = sk(root, ['artifacts', 'timeline', '--json']);
      const runs = JSON.parse(tl.stdout);
      const keys = runs.map((r) => `${r.skill}/${r.slug}`);
      assert.ok(keys.includes('jira-autopilot/AAP-1'));
      assert.ok(keys.includes('get-jira-done/AAP-9'));
      assert.ok(!keys.includes('skill-auditor/audit-1'), 'non-Jira excluded');
      assert.ok(!keys.includes('get-plan-done/mission-x'), 'non-Jira mission excluded');
      // newest first: AAP-9 (2026-07) before AAP-1 (2026-06)
      assert.ok(keys.indexOf('get-jira-done/AAP-9') < keys.indexOf('jira-autopilot/AAP-1'));
      // legacy inference marked + status mapped
      const inferred = runs.find((r) => r.slug === 'AAP-9');
      assert.equal(inferred.inferred, true);
      assert.equal(inferred.status, 'done');
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// list + show filters / disambiguation
// ---------------------------------------------------------------------------

describe('list filters + show deterministic disambiguation', () => {
  test('list --skill / --status filter', () => {
    const root = makeRepo({});
    try {
      const runsRoot = join(root, 'artifacts', 'runs');
      writeRunJson(runsRoot, 'jira-autopilot', 'A', { status: 'running', updated_at: '2026-06-01T00:00:00+07:00' });
      writeRunJson(runsRoot, 'get-jira-done', 'B', { status: 'done', updated_at: '2026-06-02T00:00:00+07:00' });
      let runs = JSON.parse(sk(root, ['artifacts', 'list', '--json', '--skill', 'get-jira-done']).stdout);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].slug, 'B');
      runs = JSON.parse(sk(root, ['artifacts', 'list', '--json', '--status', 'running']).stdout);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].slug, 'A');
    } finally {
      cleanup(root);
    }
  });

  test('show ambiguous slug → all matches in --json; --skill resolves one; human non-zero', () => {
    const root = makeRepo({});
    try {
      const runsRoot = join(root, 'artifacts', 'runs');
      // same slug under two Jira skills
      writeRunJson(runsRoot, 'jira-autopilot', 'AAP-5', { status: 'running', jira_card: 'AAP-5', updated_at: '2026-06-01T00:00:00+07:00' });
      writeRunJson(runsRoot, 'get-jira-done', 'AAP-5', { status: 'done', jira_card: 'AAP-5', updated_at: '2026-06-02T00:00:00+07:00' });

      const amb = sk(root, ['artifacts', 'show', 'AAP-5', '--json']);
      const arr = JSON.parse(amb.stdout);
      assert.ok(Array.isArray(arr) && arr.length === 2, 'ambiguous --json returns all matches');

      const humanAmb = sk(root, ['artifacts', 'show', 'AAP-5']);
      assert.notEqual(humanAmb.status, 0, 'ambiguous human exits non-zero');

      const one = sk(root, ['artifacts', 'show', 'AAP-5', '--skill', 'jira-autopilot', '--json']);
      const m = JSON.parse(one.stdout);
      assert.equal(m.skill, 'jira-autopilot');
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// c4 — concurrency
// ---------------------------------------------------------------------------

describe('c4 — concurrency', () => {
  test('N concurrent registers on DIFFERENT runs never lose data; a read interleaved is consistent', async () => {
    const root = makeRepo({});
    try {
      const N = 12;
      const procs = [];
      for (let i = 0; i < N; i++) {
        procs.push(new Promise((resolve) => {
          const r = spawnSync(process.execPath,
            [join(repoRoot, 'bin/sidekicks'), 'artifacts', 'register', 'jira-autopilot', `AAP-${i}`, 'status=running', `title=t${i}`],
            { cwd: root, encoding: 'utf8' });
          resolve(r.status ?? 1);
        }));
      }
      const codes = await Promise.all(procs);
      assert.ok(codes.every((c) => c === 0), 'all concurrent registers exit 0');

      // All N run.json present and parseable (no torn files).
      for (let i = 0; i < N; i++) {
        const p = join(root, 'artifacts', 'runs', 'jira-autopilot', `AAP-${i}`, 'run.json');
        assert.ok(existsSync(p), `AAP-${i} present`);
        assert.doesNotThrow(() => JSON.parse(readFileSync(p, 'utf8')), `AAP-${i} not torn`);
      }
      // Interleaved read returns a consistent in-memory rebuild of all N.
      const runs = JSON.parse(sk(root, ['artifacts', 'list', '--json']).stdout);
      assert.equal(runs.length, N);
    } finally {
      cleanup(root);
    }
  });

  test('two registers on the SAME run serialize without corruption (lease) and never block', async () => {
    const root = makeRepo({});
    try {
      const a = new Promise((resolve) => {
        const r = spawnSync(process.execPath,
          [join(repoRoot, 'bin/sidekicks'), 'artifacts', 'register', 'jira-autopilot', 'SAME', 'status=running', 'title=A'],
          { cwd: root, encoding: 'utf8' });
        resolve(r.status ?? 1);
      });
      const b = new Promise((resolve) => {
        const r = spawnSync(process.execPath,
          [join(repoRoot, 'bin/sidekicks'), 'artifacts', 'register', 'jira-autopilot', 'SAME', 'status=done', 'title=B'],
          { cwd: root, encoding: 'utf8' });
        resolve(r.status ?? 1);
      });
      const [ca, cb] = await Promise.all([a, b]);
      assert.ok(ca === 0 && cb === 0);
      const p = join(root, 'artifacts', 'runs', 'jira-autopilot', 'SAME', 'run.json');
      const m = JSON.parse(readFileSync(p, 'utf8')); // must parse — not torn
      assert.ok(['running', 'done'].includes(m.status));
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// c5 — per-repo .gitignore helper inside a temp git repo (check-ignore inside that repo)
// ---------------------------------------------------------------------------

describe('c5 — per-repo .gitignore helper (real git check-ignore inside the owning repo)', () => {
  function gitOk() {
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
  }

  test('register inside a temp project repo makes artifacts/index.json ignored THERE; run.json + ARTIFACTS.md NOT ignored', { skip: !gitOk() }, () => {
    const root = makeRepo({ active_project: 'acme' });
    try {
      // Build a user project whose dir is its OWN git repo (the submodule reality).
      const projDir = join(root, 'projects', 'acme');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'manifest.yaml'), 'name: acme\nremote_source: null\nservices: []\noverrides: {}\n');
      execFileSync('git', ['init', '-q'], { cwd: projDir });

      // First register creates the store + self-heals the project repo's .gitignore.
      const reg = sk(root, ['artifacts', 'register', 'jira-autopilot', 'AAP-1', 'status=running', 'jira_card=AAP-1']);
      assert.equal(reg.status, 0, reg.stdout + reg.stderr);
      // rebuild writes the index there
      sk(root, ['artifacts', 'rebuild']);

      assert.ok(existsSync(join(projDir, '.gitignore')), 'project repo .gitignore created');

      // check-ignore INSIDE the owning repo (projDir), not the root.
      const ignored = (rel) => {
        const r = spawnSync('git', ['check-ignore', rel], { cwd: projDir, encoding: 'utf8' });
        return r.status === 0; // exit 0 == ignored
      };
      assert.ok(ignored('artifacts/index.json'), 'index.json ignored in owning repo');
      assert.ok(!ignored('artifacts/ARTIFACTS.md'), 'ARTIFACTS.md NOT ignored');
      assert.ok(!ignored('artifacts/runs/jira-autopilot/AAP-1/run.json'), 'run.json NOT ignored');
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// c7 — inference is read-only (legacy ledgers untouched)
// ---------------------------------------------------------------------------

describe('c7 — inference is read-only', () => {
  test('rebuild does not write run.json into a legacy folder nor modify the ledger', () => {
    const root = makeRepo({});
    try {
      const runsRoot = join(root, 'artifacts', 'runs');
      const dir = writeLedger(runsRoot, 'jira-autopilot', 'AAP-9', 'batch.yaml', 'status: executing\ntitle: legacy\n');
      const before = readFileSync(join(dir, 'batch.yaml'), 'utf8');
      sk(root, ['artifacts', 'rebuild']);
      assert.ok(!existsSync(join(dir, 'run.json')), 'no run.json written into legacy folder');
      assert.equal(readFileSync(join(dir, 'batch.yaml'), 'utf8'), before, 'ledger byte-identical');
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// runs layout v2 — `dir=` (caller-resolved run folder) + `service=`
// ---------------------------------------------------------------------------

describe('runs layout v2 — register dir= / service=', () => {
  test('dir= writes run.json at the caller-resolved v2 folder, not the legacy join', () => {
    const root = makeRepo({});
    try {
      const v2Rel = join('artifacts', 'runs', 'DSHPH2-5398', 'jira-ready-gate');
      const r = sk(root, ['artifacts', 'register', 'sk-jira-ready-gate', 'DSHPH2-5398',
        `dir=${join(root, v2Rel)}`, 'status=running', 'service=pcu-ms-master-data-api']);
      assert.equal(r.status, 0, r.stderr);

      const written = join(root, v2Rel, 'run.json');
      assert.ok(existsSync(written), 'run.json written at the v2 folder');
      const m = JSON.parse(readFileSync(written, 'utf8'));
      assert.equal(m.skill, 'sk-jira-ready-gate');
      assert.equal(m.slug, 'DSHPH2-5398');
      assert.equal(m.service, 'pcu-ms-master-data-api', 'service association recorded in metadata');

      // The legacy skill/slug join must NOT have been created.
      assert.ok(
        !existsSync(join(root, 'artifacts', 'runs', 'sk-jira-ready-gate', 'DSHPH2-5398', 'run.json')),
        'dir= replaces the legacy join outright'
      );
    } finally {
      cleanup(root);
    }
  });

  test('a relative dir= resolves against the runs base', () => {
    const root = makeRepo({});
    try {
      const r = sk(root, ['artifacts', 'register', 'sk-get-things-done', 'aap-113-sync',
        'dir=aap-113-sync', 'status=running']);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(root, 'artifacts', 'runs', 'aap-113-sync', 'run.json')), 'bare v2 run folder');
    } finally {
      cleanup(root);
    }
  });

  test('without dir= the legacy join is unchanged', () => {
    const root = makeRepo({});
    try {
      sk(root, ['artifacts', 'register', 'jira-autopilot', 'AAP-1', 'status=running']);
      assert.ok(existsSync(join(root, 'artifacts', 'runs', 'jira-autopilot', 'AAP-1', 'run.json')));
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// runs layout v2 — index scanner (list/timeline path) reads both layouts
// ---------------------------------------------------------------------------

describe('runs layout v2 — scanRuns dual-read', () => {
  test('a v2 facet run is kept by the Jira filter even though it records the FULL skill id', () => {
    const root = makeRepo({});
    try {
      // Pre-v2 run.json recorded the short name ('jira-ready-gate'); v2 records the full id.
      // The filter must match on the facet, or the run silently vanishes from `list`.
      const dir = join(root, 'artifacts', 'runs', 'DSHPH2-5398', 'jira-ready-gate');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'run.json'), JSON.stringify({
        skill: 'sk-jira-ready-gate', slug: 'DSHPH2-5398', status: 'running', title: 'Gate',
      }));   // deliberately NO jira_card — the skill id alone must carry it through the filter

      const r = sk(root, ['artifacts', 'rebuild']);
      assert.equal(r.status, 0, r.stderr);
      const out = sk(root, ['artifacts', 'list']).stdout;
      assert.match(out, /sk-jira-ready-gate\/DSHPH2-5398/);
    } finally {
      cleanup(root);
    }
  });

  test('a v2 --bare run (ledger at the work-item root, no run.json) is found', () => {
    const root = makeRepo({});
    try {
      const dir = join(root, 'artifacts', 'runs', 'DSHPH2-7001');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ledger.yaml'),
        'status: running\njira_card: DSHPH2-7001\ngoal: bare engine run\n');

      assert.equal(sk(root, ['artifacts', 'rebuild']).status, 0);
      const out = sk(root, ['artifacts', 'list']).stdout;
      assert.match(out, /DSHPH2-7001/, 'the bare work-item folder is itself the run');
    } finally {
      cleanup(root);
    }
  });

  test('a legacy skill-id folder is NOT mistaken for a bare run', () => {
    const root = makeRepo({});
    try {
      // Legacy shape: runs/<skill>/<slug>/ — the skill folder itself carries no ledger.
      writeRunJson(join(root, 'artifacts', 'runs'), 'jira-autopilot', 'AAP-1',
        { skill: 'jira-autopilot', slug: 'AAP-1', status: 'running' });

      assert.equal(sk(root, ['artifacts', 'rebuild']).status, 0);
      const out = sk(root, ['artifacts', 'list']).stdout;
      assert.match(out, /jira-autopilot\/AAP-1/);
      assert.ok(!/jira-autopilot\/jira-autopilot/.test(out), 'skill folder must not surface as a run');
    } finally {
      cleanup(root);
    }
  });
});
