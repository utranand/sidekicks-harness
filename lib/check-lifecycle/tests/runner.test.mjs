// lib/check-lifecycle/tests/runner.test.mjs
//
// Colocated under lib/ on purpose: `lib/` is copied WHOLE into a forged core, while `tests/` is not
// part of the forged surface at all. A contract suite the framework must be able to run about
// ITSELF has to travel with the framework — the `tests.contract` gate could not run in a mounted
// workspace while these files lived under tests/ (INC-2026-09-04-01, F-3).
// Contract tests for `sidekicks check run` — the unified verification runner.
//
// Uses ONLY node:test + node:assert/strict + node:child_process + node:fs + node:path + node:os +
// node:url — the same stdlib-only shape as every other suite here.
//
// THREE KINDS OF TEST, ON PURPOSE.
//   * Against INJECTED dependencies (spawn, clock, gate set, profile map, signal registration), for
//     the scheduler's own behaviour: dependency order, the job bound, blocked propagation, signals,
//     and byte-identical JSON. None of that can be asserted against real gates — the whole point of
//     the injection is that "gate B never started because A failed" is a claim about ordering, which
//     needs controlled completion times, and a comparable result document needs a controlled clock.
//   * Against the REAL registry, for the facts the plan fixes: the gate table, its dependency edges,
//     the profile composition, the timeouts, and the bounds on --jobs.
//   * Against the REAL CLI, for argument handling — including BOTH spellings of every valued flag.
//     The dispatcher's global parseArgs is `strict: false` with only --help/--version/--verbose
//     declared, so `--profile quick` arrives as `{ profile: true }` plus a positional while
//     `--profile=quick` arrives as `{ profile: 'quick' }`. A test for one form would not notice a verb
//     that reads only `flags`.
//
// DELIBERATELY NOT TESTED HERE: a real `check run --profile quick`. The `tests.contract` gate runs
// THIS file, so a test that ran the profile would recurse into itself. The invalid-argument cases do
// invoke the real CLI, because they exit before any gate is spawned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

import {
  GATES, PROFILES, PROFILE_NAMES, PROFILE_TIMEOUT_MS, SCHEMA_VERSION,
  JOBS_MIN, JOBS_MAX, profileGates, validateRegistry, normalizeJobs, defaultJobCount,
} from '../registry.mjs';
import { runProfile, spawnArgv, SIGNAL_EXIT } from '../runner.mjs';
import { parseCheckRunArgs, checkRun, renderHuman } from '../commands.mjs';
import { tail, TAIL_BYTES, bangkokTimestamp, parseCheckFlags, positionalArgs } from '../_shared.mjs';
import { goldenReplay } from '../gates/golden-replay.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const bin = join(repoRoot, 'bin', 'sidekicks');

/** Run the real CLI in this repo. */
function sk(args) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// test doubles
// ---------------------------------------------------------------------------

/** A synthetic gate. Its argv carries its own id, so the fake spawn can tell them apart. */
function gate(id, dependencies = [], extra = {}) {
  return {
    id,
    command: ['node', '--gate', id],
    handler: null,
    dependencies,
    blocking: true,
    cost_ms: 1,
    summary: `synthetic gate ${id}`,
    ...extra,
  };
}

/** A handler-backed synthetic gate. */
function handlerGate(id, handler, dependencies = [], extra = {}) {
  return {
    id, command: null, handler, dependencies, blocking: true, cost_ms: 1,
    summary: `synthetic handler gate ${id}`, ...extra,
  };
}

/**
 * A fake spawn: resolves each synthetic gate from a script, records call order, and tracks how many
 * gates were in flight at once.
 *
 * @param {Record<string, {exitCode?: number, stdout?: string, stderr?: string, ticks?: number, signal?: string}>} script
 */
function fakeSpawn(script = {}) {
  const order = [];
  let active = 0;
  let peak = 0;
  const fn = async ({ argv, cwd, timeoutMs, signal }) => {
    const id = argv[2];
    order.push(id);
    active += 1;
    peak = Math.max(peak, active);
    const plan = script[id] || {};
    // `ticks` microtask turns before resolving: enough to interleave with siblings without a timer.
    for (let i = 0; i < (plan.ticks ?? 2); i++) await Promise.resolve();
    active -= 1;
    return {
      // `in` rather than `??`: a script that says `exitCode: null` means "no exit code" (a killed or
      // timed-out child), and `?? 0` would silently turn that into a pass.
      exitCode: 'exitCode' in plan ? plan.exitCode : 0,
      signal: plan.signal ?? null,
      stdout: plan.stdout ?? '',
      stderr: plan.stderr ?? '',
      timedOut: Boolean(plan.timedOut),
      cwd,
      timeoutMs,
      aborted: signal?.aborted ?? false,
    };
  };
  fn.order = order;
  fn.peak = () => peak;
  return fn;
}

/** A clock that advances a fixed step per read, from a fixed instant. */
function fakeClock(startMs = Date.UTC(2026, 0, 2, 3, 0, 0), stepMs = 1000) {
  let t = startMs - stepMs;
  return { now: () => (t += stepMs) };
}

/** A signal registration double: the test decides when (and whether) a signal arrives. */
function fakeSignals() {
  const box = { fire: () => {}, unregistered: false };
  box.register = (cb) => {
    box.fire = cb;
    return () => { box.unregistered = true; };
  };
  return box;
}

const byId = (result, id) => result.gates.find((g) => g.id === id);

// ---------------------------------------------------------------------------
// the real registry
// ---------------------------------------------------------------------------

test('the static registry is structurally valid and matches the specified gate table', () => {
  assert.deepEqual(validateRegistry(), [], 'the shipped registry must have no structural problems');

  assert.deepEqual(GATES.map((g) => g.id), [
    'catalog.check', 'tests.contract', 'framework.doctor', 'config.doctor', 'tests.all',
    'framework.sync', 'config.sync', 'skill.doctor', 'parity', 'skill.verify',
    'package.clean', 'core.mounted', 'golden.replay',
  ]);

  const deps = Object.fromEntries(GATES.map((g) => [g.id, [...g.dependencies]]));
  assert.deepEqual(deps, {
    'catalog.check': [],
    'tests.contract': [],
    'framework.doctor': [],
    'config.doctor': [],
    'tests.all': ['catalog.check'],
    'framework.sync': ['framework.doctor'],
    'config.sync': ['config.doctor'],
    'skill.doctor': ['tests.all'],
    parity: ['tests.all'],
    'skill.verify': ['skill.doctor'],
    'package.clean': ['tests.all', 'catalog.check'],
    'core.mounted': ['package.clean'],
    'golden.replay': ['package.clean', 'core.mounted'],
  });

  // Every gate is EITHER an argv array or an internal handler — never a shell command string.
  for (const g of GATES) {
    const hasCommand = Array.isArray(g.command);
    assert.equal(hasCommand !== (typeof g.handler === 'string'), true, `${g.id}: exactly one form`);
    if (hasCommand) {
      assert.ok(g.command.length >= 2, `${g.id}: an argv array, not a string`);
      assert.equal(g.command.some((t) => /[&|;><]/.test(t) && t !== '--'), false,
        `${g.id}: no shell metacharacters — nothing here is ever handed to a shell`);
    }
    assert.equal(g.blocking, true, 'the initial registry has only blocking gates');
  }
  // The three test-running gates are handlers, not argv rows, and that is load-bearing: a command
  // gate is spawned with cwd = the WORKSPACE, so a repo-relative path to a framework FILE resolves
  // to nothing in a mounted workspace. See gates/framework-tests.mjs (INC-2026-09-04-01, F-3).
  assert.deepEqual(GATES.filter((g) => g.handler).map((g) => g.handler),
    ['tests.contract', 'tests.all', 'parity', 'package.clean', 'core.mounted', 'golden.replay']);
});

test('the three profiles compose as specified, each a superset of the last', () => {
  assert.deepEqual([...PROFILE_NAMES], ['quick', 'full', 'release']);
  assert.deepEqual([...PROFILES.quick],
    ['catalog.check', 'tests.contract', 'framework.doctor', 'config.doctor']);
  assert.deepEqual([...PROFILES.full], [...PROFILES.quick,
    'tests.all', 'framework.sync', 'config.sync', 'skill.doctor', 'parity']);
  assert.deepEqual([...PROFILES.release], [...PROFILES.full,
    'skill.verify', 'package.clean', 'core.mounted', 'golden.replay']);

  // profileGates returns REGISTRY order (not profile order) and pulls in every transitive dependency.
  const full = profileGates('full').map((g) => g.id);
  assert.deepEqual(full, GATES.map((g) => g.id).filter((id) => full.includes(id)));
  for (const g of profileGates('release')) {
    for (const dep of g.dependencies) {
      assert.ok(profileGates('release').some((x) => x.id === dep), `${g.id} needs ${dep}`);
    }
  }
  assert.equal(profileGates('release').length, GATES.length, 'release runs the whole registry');
});

test('per-gate timeouts are 120s / 900s / 1200s and jobs are bounded 1..8', () => {
  assert.equal(PROFILE_TIMEOUT_MS.quick, 120_000);
  assert.equal(PROFILE_TIMEOUT_MS.full, 900_000);
  assert.equal(PROFILE_TIMEOUT_MS.release, 1_200_000);
  assert.equal(JOBS_MIN, 1);
  assert.equal(JOBS_MAX, 8);
  assert.equal(TAIL_BYTES, 65_536);
  assert.equal(SCHEMA_VERSION, 1);

  assert.equal(defaultJobCount(1), 1);
  assert.equal(defaultJobCount(2), 2);
  assert.equal(defaultJobCount(64), 4, 'the default is min(4, availableParallelism())');
  assert.ok(defaultJobCount() >= 1 && defaultJobCount() <= 4);
});

test('an invalid registry is rejected rather than partially run', async () => {
  const cyclic = [gate('a', ['b']), gate('b', ['a'])];
  assert.match(validateRegistry(cyclic).join(' '), /dependency cycle/);
  await assert.rejects(
    () => runProfile({
      repoRoot, profile: 'p', deps: { gates: cyclic, profiles: { p: ['a'] }, spawn: fakeSpawn() },
    }),
    (err) => err.exitCode === 2 && /registry is invalid/.test(err.message),
  );

  assert.match(validateRegistry([gate('a', ['nope'])]).join(' '), /unknown gate 'nope'/);
  assert.match(validateRegistry([gate('a'), gate('a')]).join(' '), /duplicate gate id 'a'/);
  assert.match(
    validateRegistry([{ id: 'x', command: ['node'], handler: 'h', dependencies: [], blocking: true }]).join(' '),
    /both a command and a handler/,
  );
  assert.match(
    validateRegistry([{ id: 'x', command: null, handler: null, dependencies: [], blocking: true }]).join(' '),
    /neither a command nor a handler/,
  );
});

// ---------------------------------------------------------------------------
// dependency ordering
// ---------------------------------------------------------------------------

test('a gate starts only after every dependency passed', async () => {
  const gates = [gate('a'), gate('b', ['a']), gate('c', ['b']), gate('d', ['a'])];
  const spawn = fakeSpawn();
  const { result, exitCode } = await runProfile({
    repoRoot,
    profile: 'chain',
    jobs: 4,
    deps: { gates, profiles: { chain: ['c', 'd'] }, spawn, clock: fakeClock(), onSignal: fakeSignals().register },
  });

  assert.equal(exitCode, 0);
  assert.equal(result.status, 'passed');
  assert.equal(spawn.order[0], 'a', 'the root gate runs first');
  assert.ok(spawn.order.indexOf('b') < spawn.order.indexOf('c'), 'c waits for b');
  assert.ok(spawn.order.indexOf('a') < spawn.order.indexOf('d'), 'd waits for a');
  // Rows stay in REGISTRY order, never completion order.
  assert.deepEqual(result.gates.map((g) => g.id), ['a', 'b', 'c', 'd']);
});

test('a failed prerequisite marks its dependents blocked, and they never run', async () => {
  const gates = [gate('a'), gate('b', ['a']), gate('c', ['b']), gate('independent')];
  const spawn = fakeSpawn({ a: { exitCode: 4, stderr: 'a exploded\n' } });
  const { result, exitCode } = await runProfile({
    repoRoot,
    profile: 'chain',
    jobs: 4,
    deps: { gates, profiles: { chain: ['c', 'independent'] }, spawn, clock: fakeClock(), onSignal: fakeSignals().register },
  });

  assert.equal(exitCode, 1);
  assert.equal(result.status, 'failed');
  assert.equal(byId(result, 'a').status, 'failed');
  assert.equal(byId(result, 'a').exit_code, 4);
  assert.equal(byId(result, 'a').stderr_tail, 'a exploded\n');
  assert.equal(byId(result, 'b').status, 'blocked');
  assert.match(byId(result, 'b').reason, /dependency 'a' did not pass/);
  assert.equal(byId(result, 'c').status, 'blocked');
  assert.match(byId(result, 'c').reason, /dependency 'b' did not pass/);
  assert.equal(byId(result, 'independent').status, 'passed', 'an unrelated gate still runs');
  assert.equal(spawn.order.includes('b'), false, 'a blocked gate is never spawned');
  assert.equal(spawn.order.includes('c'), false);
  // A blocked row carries no timings and no exit code — it did not happen.
  assert.equal(byId(result, 'b').started_at, null);
  assert.equal(byId(result, 'b').ended_at, null);
  assert.equal(byId(result, 'b').duration_ms, null);
  assert.equal(byId(result, 'b').exit_code, null);
});

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

test('concurrency never exceeds --jobs', async () => {
  const gates = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => gate(id, [], { cost_ms: 1 }));
  for (const jobs of [1, 2, 3]) {
    const spawn = fakeSpawn(Object.fromEntries(gates.map((g) => [g.id, { ticks: 6 }])));
    const { result } = await runProfile({
      repoRoot,
      profile: 'wide',
      jobs,
      deps: {
        gates, profiles: { wide: gates.map((g) => g.id) }, spawn,
        clock: fakeClock(), onSignal: fakeSignals().register,
      },
    });
    assert.equal(result.status, 'passed');
    assert.equal(spawn.order.length, 6, 'every gate ran exactly once');
    assert.ok(spawn.peak() <= jobs, `jobs=${jobs}: peak concurrency was ${spawn.peak()}`);
    if (jobs > 1) assert.ok(spawn.peak() > 1, `jobs=${jobs}: independent gates must actually overlap`);
  }
});

test('the most expensive ready gate starts first, ties on registry order', async () => {
  const gates = [gate('cheap', [], { cost_ms: 1 }), gate('dear', [], { cost_ms: 999 })];
  const spawn = fakeSpawn();
  await runProfile({
    repoRoot,
    profile: 'two',
    jobs: 1,
    deps: { gates, profiles: { two: ['cheap', 'dear'] }, spawn, clock: fakeClock(), onSignal: fakeSignals().register },
  });
  assert.deepEqual(spawn.order, ['dear', 'cheap']);
});

// ---------------------------------------------------------------------------
// skipped blocking gates
// ---------------------------------------------------------------------------

test('a SKIPPED blocking gate fails the profile — it is never reported as success', async () => {
  const gates = [handlerGate('maybe', 'h.skip')];
  const { result, exitCode } = await runProfile({
    repoRoot,
    profile: 'one',
    deps: {
      gates,
      profiles: { one: ['maybe'] },
      spawn: fakeSpawn(),
      clock: fakeClock(),
      onSignal: fakeSignals().register,
      handlers: {
        'h.skip': async () => ({
          exitCode: null, signal: null, stdout: '', stderr: '',
          status: 'skipped', reason: 'nothing to compare against',
        }),
      },
    },
  });
  assert.equal(byId(result, 'maybe').status, 'skipped');
  assert.equal(byId(result, 'maybe').reason, 'nothing to compare against');
  assert.equal(result.status, 'failed', 'a skipped BLOCKING gate fails the profile');
  assert.equal(exitCode, 1);
  assert.match(renderHuman(result), /SKIPPED blocking gate fails the profile/);
});

test('a skipped gate blocks its dependents like any other non-pass', async () => {
  const gates = [handlerGate('root', 'h.skip'), gate('after', ['root'])];
  const { result } = await runProfile({
    repoRoot,
    profile: 'one',
    deps: {
      gates,
      profiles: { one: ['after'] },
      spawn: fakeSpawn(),
      clock: fakeClock(),
      onSignal: fakeSignals().register,
      handlers: { 'h.skip': async () => ({ exitCode: null, status: 'skipped', reason: 'no fixtures' }) },
    },
  });
  assert.equal(byId(result, 'after').status, 'blocked');
  assert.equal(result.status, 'failed');
});

test('a missing handler is a failure, not a silent pass', async () => {
  const { result, exitCode } = await runProfile({
    repoRoot,
    profile: 'one',
    deps: {
      gates: [handlerGate('orphan', 'h.absent')],
      profiles: { one: ['orphan'] },
      spawn: fakeSpawn(),
      clock: fakeClock(),
      onSignal: fakeSignals().register,
      handlers: {},
    },
  });
  assert.equal(byId(result, 'orphan').status, 'failed');
  assert.match(byId(result, 'orphan').reason, /no handler registered/);
  assert.equal(exitCode, 1);
});

test('a handler that throws fails its gate instead of crashing the run', async () => {
  const { result, exitCode } = await runProfile({
    repoRoot,
    profile: 'one',
    deps: {
      gates: [handlerGate('boom', 'h.throw'), gate('after', ['boom'])],
      profiles: { one: ['after'] },
      spawn: fakeSpawn(),
      clock: fakeClock(),
      onSignal: fakeSignals().register,
      handlers: { 'h.throw': async () => { throw new Error('handler blew up'); } },
    },
  });
  assert.equal(byId(result, 'boom').status, 'failed');
  assert.match(byId(result, 'boom').reason, /gate threw: handler blew up/);
  assert.equal(byId(result, 'after').status, 'blocked');
  assert.equal(exitCode, 1);
});

// ---------------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------------

for (const [name, code] of Object.entries(SIGNAL_EXIT)) {
  test(`${name} terminates children and exits ${code}; running gates fail, dependents block`, async () => {
    const signals = fakeSignals();
    const gates = [gate('slow'), gate('after', ['slow']), gate('never')];
    let sawAbort = false;
    const spawn = async ({ argv, signal }) => {
      if (argv[2] === 'slow') {
        signals.fire(name);                       // the signal arrives mid-gate
        await new Promise((resolve) => {
          if (signal.aborted) { sawAbort = true; resolve(); return; }
          signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true });
        });
        return { exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '' };
      }
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    };

    const { result, exitCode } = await runProfile({
      repoRoot,
      profile: 'sig',
      jobs: 1,
      deps: {
        gates, profiles: { sig: ['after', 'never'] }, spawn,
        clock: fakeClock(), onSignal: signals.register,
      },
    });

    assert.equal(sawAbort, true, 'the running child must be told to stop');
    assert.equal(exitCode, code);
    assert.equal(byId(result, 'slow').status, 'failed');
    assert.equal(byId(result, 'slow').signal, name, 'the RUN\'s signal is what the row records');
    assert.match(byId(result, 'slow').reason, new RegExp(`interrupted by ${name}`));
    assert.equal(byId(result, 'after').status, 'blocked');
    assert.match(byId(result, 'after').reason, /not started — run interrupted/);
    assert.equal(byId(result, 'never').status, 'blocked');
    assert.equal(result.status, 'failed');
    assert.equal(signals.unregistered, true, 'the handler is removed when the run ends');
  });
}

// ---------------------------------------------------------------------------
// deterministic JSON
// ---------------------------------------------------------------------------

test('an injected clock and spawn make the whole result document byte-identical', async () => {
  const gates = [gate('a'), gate('b', ['a'])];
  const run = () => runProfile({
    repoRoot,
    profile: 'two',
    jobs: 1,
    deps: {
      gates,
      profiles: { two: ['b'] },
      spawn: fakeSpawn({ a: { stdout: 'ok\n' }, b: { stdout: 'ok\n' } }),
      clock: fakeClock(),
      onSignal: fakeSignals().register,
    },
  });
  const first = await run();
  const second = await run();
  assert.equal(JSON.stringify(first.result), JSON.stringify(second.result));

  const r = first.result;
  assert.deepEqual(Object.keys(r),
    ['schema_version', 'profile', 'started_at', 'ended_at', 'duration_ms', 'status', 'gates']);
  assert.equal(r.schema_version, 1);
  assert.equal(r.profile, 'two');
  assert.equal(r.status, 'passed');
  assert.match(r.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
  assert.match(r.ended_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
  assert.equal(typeof r.duration_ms, 'number');
  for (const row of r.gates) {
    assert.deepEqual(Object.keys(row), [
      'id', 'status', 'dependencies', 'blocking', 'started_at', 'ended_at', 'duration_ms',
      'exit_code', 'signal', 'stdout_tail', 'stderr_tail', 'reason',
    ]);
    assert.ok(['passed', 'failed', 'blocked', 'skipped'].includes(row.status));
    assert.match(row.started_at, /\+07:00$/);
  }
  // Nothing machine-absolute is ever persisted into the document.
  assert.equal(JSON.stringify(r).includes(repoRoot), false);
});

test('timestamps are Asia/Bangkok with an explicit +07:00 offset', () => {
  // 2026-01-02T03:00:00Z is 10:00 the same day in Bangkok.
  assert.equal(bangkokTimestamp(Date.UTC(2026, 0, 2, 3, 0, 0)), '2026-01-02T10:00:00+07:00');
  // 17:30Z rolls over the date locally — the offset must be applied, not appended.
  assert.equal(bangkokTimestamp(Date.UTC(2026, 0, 2, 17, 30, 0)), '2026-01-03T00:30:00+07:00');
});

// ---------------------------------------------------------------------------
// output capture: CRLF, bounds
// ---------------------------------------------------------------------------

test('CRLF output is normalized, so a Windows child and a macOS child produce the same row', async () => {
  const { result } = await runProfile({
    repoRoot,
    profile: 'one',
    deps: {
      gates: [gate('a')],
      profiles: { one: ['a'] },
      spawn: fakeSpawn({ a: { stdout: 'line1\r\nline2\r\n', stderr: 'warn\r\n' } }),
      clock: fakeClock(),
      onSignal: fakeSignals().register,
    },
  });
  assert.equal(byId(result, 'a').stdout_tail, 'line1\nline2\n');
  assert.equal(byId(result, 'a').stderr_tail, 'warn\n');
  assert.equal(renderHuman(result).includes('\r'), false, 'the human rendering carries no CR');

  assert.equal(tail('a\r\nb'), 'a\nb');
  assert.equal(tail('a\rb'), 'a\nb', 'a lone CR (old-Mac output) is normalized too');
  assert.equal(tail(undefined), '');
  assert.equal(tail(null), '');
});

test('captured output is bounded to the FINAL 65536 bytes per stream', () => {
  const big = `${'x'.repeat(TAIL_BYTES + 4096)}TAILEND`;
  const cut = tail(big);
  assert.equal(Buffer.byteLength(cut, 'utf8'), TAIL_BYTES);
  assert.ok(cut.endsWith('TAILEND'), 'the END is what is kept — the failing tail is the useful half');
});

// ---------------------------------------------------------------------------
// the real spawner: no shell, spaces, exit codes, timeouts
// ---------------------------------------------------------------------------

test('spawnArgv runs in a path containing spaces and never invokes a shell', async () => {
  const base = mkdtempSync(join(tmpdir(), 'sk-check-space-'));
  const dir = join(base, 'a dir with spaces');
  mkdirSync(dir, { recursive: true });
  try {
    const r = await spawnArgv({
      argv: ['node', '-e', 'process.stdout.write(process.cwd())'],
      cwd: dir,
      timeoutMs: 60_000,
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('a dir with spaces'), r.stdout);

    // A shell would expand these; argv + shell:false hands them through untouched.
    const hostile = await spawnArgv({
      argv: ['node', '-e', 'process.stdout.write(process.argv[1])', '$(echo pwned) && echo also; `nope`'],
      cwd: dir,
      timeoutMs: 60_000,
    });
    assert.equal(hostile.exitCode, 0, hostile.stderr);
    assert.equal(hostile.stdout, '$(echo pwned) && echo also; `nope`');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('spawnArgv propagates the child exit code and captures both streams', async () => {
  const r = await spawnArgv({
    argv: ['node', '-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(7)'],
    cwd: repoRoot,
    timeoutMs: 60_000,
  });
  assert.equal(r.exitCode, 7);
  assert.equal(r.signal, null);
  assert.equal(r.stdout, 'out');
  assert.equal(r.stderr, 'err');
});

test('a gate exit code reaches its row, and any non-zero fails the profile', async () => {
  for (const code of [1, 2, 3, 7, 130]) {
    const { result, exitCode } = await runProfile({
      repoRoot,
      profile: 'one',
      deps: {
        gates: [gate('a')],
        profiles: { one: ['a'] },
        spawn: fakeSpawn({ a: { exitCode: code } }),
        clock: fakeClock(),
        onSignal: fakeSignals().register,
      },
    });
    assert.equal(byId(result, 'a').exit_code, code);
    assert.equal(byId(result, 'a').status, 'failed');
    assert.equal(byId(result, 'a').reason, `exit ${code}`);
    assert.equal(result.status, 'failed');
    assert.equal(exitCode, 1, 'the CLI reports 1 for a failed gate, whatever the gate returned');
  }
});

test('spawnArgv kills a child that outlives the timeout and reports it as a timeout', async () => {
  const r = await spawnArgv({
    argv: ['node', '-e', 'setInterval(() => {}, 1000)'],
    cwd: repoRoot,
    timeoutMs: 400,
  });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.exitCode, 0);
});

test('a timed-out gate says so in its reason', async () => {
  const { result } = await runProfile({
    repoRoot,
    profile: 'one',
    deps: {
      gates: [gate('a')],
      profiles: { one: ['a'] },
      spawn: fakeSpawn({ a: { exitCode: null, timedOut: true } }),
      clock: fakeClock(),
      onSignal: fakeSignals().register,
      timeoutMs: 1234,
    },
  });
  assert.equal(byId(result, 'a').status, 'failed');
  assert.match(byId(result, 'a').reason, /timed out after 1234 ms/);
});

// ---------------------------------------------------------------------------
// argument handling — BOTH spellings of every valued flag
// ---------------------------------------------------------------------------

test('--profile parses in the = form, the space form, and as a bare positional', () => {
  for (const argv of [
    ['check', 'run', '--profile=quick'],
    ['check', 'run', '--profile', 'quick'],
    ['check', 'run', 'quick'],
  ]) {
    assert.equal(parseCheckRunArgs(argv).profile, 'quick', argv.join(' '));
  }
  assert.equal(parseCheckRunArgs(['check', 'run']).profile, 'quick', 'quick is the default profile');
  assert.equal(parseCheckRunArgs(['check', 'run', '--profile=full']).profile, 'full');
  assert.equal(parseCheckRunArgs(['check', 'run', '--profile', 'release']).profile, 'release');
});

test('--jobs parses in the = form and the space form', () => {
  for (const argv of [
    ['check', 'run', '--profile=quick', '--jobs=2'],
    ['check', 'run', '--profile=quick', '--jobs', '2'],
    ['check', 'run', '--profile', 'quick', '--jobs', '2'],
    ['check', 'run', '--jobs', '2', '--profile', 'quick'],
  ]) {
    const parsed = parseCheckRunArgs(argv);
    assert.equal(parsed.jobs, 2, argv.join(' '));
    assert.equal(parsed.profile, 'quick', argv.join(' '));
  }
  assert.equal(parseCheckRunArgs(['check', 'run', '--profile=quick', '--jobs=8']).jobs, 8);
  assert.equal(parseCheckRunArgs(['check', 'run', '--profile=quick', '--jobs=1']).jobs, 1);
  assert.ok(parseCheckRunArgs(['check', 'run', '--profile=quick']).jobs >= 1, 'jobs defaults');
});

test('--json parses in both positions and stays a boolean', () => {
  assert.equal(parseCheckRunArgs(['check', 'run', '--profile=quick', '--json']).json, true);
  assert.equal(parseCheckRunArgs(['check', 'run', '--json', '--profile', 'quick']).json, true);
  assert.equal(parseCheckRunArgs(['check', 'run', 'quick', '--json']).json, true);
  assert.equal(parseCheckRunArgs(['check', 'run', '--profile=quick']).json, false);
});

test('the raw-argv readers agree on what is a flag value and what is a positional', () => {
  const argv = ['check', 'run', '--profile', 'quick', '--jobs', '2', '--json'];
  assert.deepEqual(parseCheckFlags(argv, ['json']), { profile: 'quick', jobs: '2', json: true });
  assert.deepEqual(positionalArgs(argv, ['json']), ['check', 'run'],
    'a space-form flag VALUE is not a positional');
  assert.deepEqual(positionalArgs(['check', 'run', 'quick', '--json'], ['json']), ['check', 'run', 'quick']);
});

test('invalid arguments are rejected with exit 2, before any gate runs', () => {
  for (const args of [
    ['check', 'run', '--profile=nope'],
    ['check', 'run', 'nope'],
    ['check', 'run', '--profile=quick', '--jobs=0'],
    ['check', 'run', '--profile=quick', '--jobs', '0'],
    ['check', 'run', '--profile=quick', '--jobs=9'],
    ['check', 'run', '--profile=quick', '--jobs', '9'],
    ['check', 'run', '--profile=quick', '--jobs=abc'],
    ['check', 'run', '--profile=quick', '--jobs=-1'],
    ['check', 'run', '--profile=quick', '--jobs=2.5'],
    ['check', 'run', 'quick', 'extra'],
  ]) {
    assert.throws(() => parseCheckRunArgs(args), (err) => err.exitCode === 2,
      `${args.join(' ')} must be rejected with EXIT_VALIDATION`);
    const r = sk(args.slice(0));
    assert.equal(r.status, 2, `${args.join(' ')} -> expected exit 2, got ${r.status}\n${r.stderr}`);
    assert.equal(r.stdout, '', 'an invalid invocation runs nothing and prints no report');
  }
});

test('normalizeJobs bounds the value and names the range it wanted', () => {
  assert.equal(normalizeJobs('4'), 4);
  assert.equal(normalizeJobs(null, 3), 3);
  assert.equal(normalizeJobs(undefined, 3), 3);
  for (const bad of ['0', '9', '-1', 'abc', '2.5', '', ' ']) {
    if (bad === '') {
      assert.equal(normalizeJobs(bad, 3), 3, 'an empty value falls back to the default');
      continue;
    }
    assert.throws(() => normalizeJobs(bad), (err) => err.exitCode === 2 && /--jobs/.test(err.message), bad);
  }
  assert.throws(() => normalizeJobs(true), (err) => /needs a value/.test(err.message));
});

test('the CLI registers `check run` and its help mentions the profiles', async () => {
  const { VERBS, NAMESPACES } = await import('../../sk-cli/help.mjs');
  const rows = VERBS.filter((v) => v.namespace === 'check');
  assert.deepEqual(rows.map((v) => v.verb), ['run']);
  assert.equal(rows[0].status, 'implemented');
  // `framework check` is a DIFFERENT, unrelated verb; the new namespace must not have moved it.
  assert.ok(VERBS.some((v) => v.namespace === 'framework' && v.verb === 'check'),
    '`framework check` must still exist, untouched');
  // The invariant is that appending a namespace never MOVES an existing one — NAMESPACES is derived
  // from VERBS in first-appearance order, so a row inserted higher would reorder everything below it
  // in `--help`. Asserting "check is last" tested that only while `check` happened to be the newest
  // namespace; a later append (`goal`) satisfies the invariant and broke the assertion. So freeze the
  // prefix through `check` instead, which is the property, and leave later appends free.
  const expectedPrefix = [
    'project', 'service', 'branch', 'scope', 'index', 'framework', 'config', 'skill', 'core',
    'package', 'database', 'memory', 'artifacts', 'cli-executor', 'agent', 'journal', 'catalog',
    'check',
  ];
  assert.deepEqual(
    NAMESPACES.slice(0, expectedPrefix.length),
    expectedPrefix,
    'no existing namespace changed position in --help; a new one is APPENDED after these',
  );

  const help = sk(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^ {2}check {9}Run a named verification profile/m);
  assert.match(help.stdout, /check commands:/);

  const scoped = sk(['--help', 'check']);
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.match(scoped.stdout, /quick\|full\|release/);
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test('checkRun renders JSON when asked and a human report otherwise', async () => {
  const deps = {
    gates: [gate('a'), gate('b', ['a'])],
    profiles: { two: ['b'] },
    spawn: fakeSpawn({ a: { exitCode: 5, stderr: 'nope\n' } }),
    clock: fakeClock(),
    onSignal: fakeSignals().register,
  };
  const asJson = await checkRun(repoRoot, { profile: 'two', jobs: 2, json: true, deps });
  assert.equal(asJson.exitCode, 1);
  const parsed = JSON.parse(asJson.stdout);
  assert.equal(parsed.status, 'failed');
  assert.equal(parsed.gates.length, 2);

  const asText = await checkRun(repoRoot, { profile: 'two', jobs: 2, json: false, deps });
  assert.equal(asText.exitCode, 1);
  assert.match(asText.stdout, /check run — profile two, jobs 2/);
  assert.match(asText.stdout, /FAIL {2}a/);
  assert.match(asText.stdout, /BLOCK b/);
  assert.match(asText.stdout, /FAILED — 0 passed, 1 failed, 1 blocked, 0 skipped/);
  assert.match(asText.stdout, /nope/, 'a failing gate shows its captured tail');
});

// ---------------------------------------------------------------------------
// the golden-replay gate: replay only, and honest about absent fixtures
// ---------------------------------------------------------------------------

test('golden.replay SKIPS (and therefore fails the profile) when there are no fixtures', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'sk-check-golden-'));
  try {
    const r = await goldenReplay({
      repoRoot: empty,
      spawn: async () => { throw new Error('must not spawn anything when there is nothing to replay'); },
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /nothing to replay/);
    assert.match(r.reason, /never creates fixtures/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('golden.replay has NO update path at all', () => {
  const src = readFileSync(join(repoRoot, 'lib', 'check-lifecycle', 'gates', 'golden-replay.mjs'), 'utf8');
  // Every write primitive, by name. A gate that can refresh its own expectations cannot fail.
  for (const forbidden of ['writeFileSync', 'writeFile', 'appendFile', 'cpSync', 'copyFile',
    'mkdirSync', 'rmSync', 'unlink', 'renameSync', 'createWriteStream']) {
    assert.equal(src.includes(forbidden), false, `golden-replay.mjs must never reference ${forbidden}`);
  }
  // And its fs import pulls read-only functions only, so a future edit cannot quietly gain one.
  const fsImport = /import\s*\{([^}]*)\}\s*from\s*'node:fs'/.exec(src);
  assert.ok(fsImport, 'the gate reads the filesystem, so it must import from node:fs explicitly');
  const names = fsImport[1].split(',').map((n) => n.trim()).filter(Boolean);
  assert.deepEqual(names.filter((n) => !['existsSync', 'readdirSync', 'readFileSync', 'statSync'].includes(n)), [],
    `golden-replay.mjs imports a non-read fs function: ${names.join(', ')}`);
  // No flag that a refresh script would take may be PASSED by this gate (mentions in prose are fine).
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n');
  for (const flag of ['--apply', '--update', '--write']) {
    assert.equal(code.includes(flag), false, `golden-replay.mjs must never pass ${flag}`);
  }
});

// ---------------------------------------------------------------------------
// zero-dependency and portability contracts
// ---------------------------------------------------------------------------

test('every check-lifecycle module imports only node: built-ins and lib/ siblings', () => {
  const files = [
    'registry.mjs', 'runner.mjs', 'commands.mjs', 'run.mjs', '_shared.mjs',
    join('gates', 'package-clean.mjs'), join('gates', 'core-mounted.mjs'), join('gates', 'golden-replay.mjs'),
  ];
  for (const rel of files) {
    const path = join(repoRoot, 'lib', 'check-lifecycle', rel);
    assert.ok(existsSync(path), `${rel} must exist`);
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1];
      assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'),
        `${rel} imports '${spec}' — the repo has zero runtime dependencies`);
    }
    // Windows and macOS from one implementation: no POSIX-only path assumptions in the source.
    assert.equal(/require\(['"]child_process['"]\)/.test(src), false, `${rel}: ESM only`);
    assert.equal(/shell:\s*true/.test(src), false, `${rel}: never a shell`);
  }
  const version = JSON.parse(readFileSync(join(repoRoot, 'lib', 'check-lifecycle', 'VERSION.json'), 'utf8'));
  assert.equal(version.name, 'check-lifecycle');
  assert.match(version.version, /^\d+\.\d+\.\d+$/);
  for (const f of version.files) {
    assert.ok(existsSync(join(repoRoot, 'lib', 'check-lifecycle', ...f.split('/'))), `VERSION.json lists ${f}`);
  }
});

test('package.json still declares no runtime dependency', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'this phase adds no runtime dependency');
});

// Skipped inside a forged core: `.github/` is not part of the forged surface, and this case is
// about the SOURCE repo's CI wiring.
test('CI calls the release profile and stays manual-dispatch only',
  { skip: !existsSync(join(repoRoot, '.github')) }, () => {
  const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
    .split('\r\n').join('\n');
  const body = ci.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.match(body, /check run --profile[= ]release/, 'the gate must call the release profile');
  assert.match(body, /^on:\n(\s*#[^\n]*\n)*\s*workflow_dispatch:\s*$/m,
    'workflow_dispatch must remain the ONLY trigger — runner minutes here are metered');
  assert.equal(/^\s*push:/m.test(body), false, 'no push trigger');
  assert.equal(/^\s*pull_request:/m.test(body), false, 'no pull_request trigger');
});


// ---------------------------------------------------------------------------
// The test-running gates resolve against the FRAMEWORK root (INC-2026-09-04-01, F-3)
// ---------------------------------------------------------------------------
// `check run quick` was red in every mounted workspace because `tests.contract` was an argv of
// repo-relative paths spawned with cwd = the workspace, where the framework's own files do not
// live. These assertions pin the resolution, and pin that a MISSING file fails loudly rather than
// skipping — a blocking gate that skips fails the profile anyway, so a skip is a failure that has
// lost its explanation.

test('the contract gate builds an argv under the MOUNT, not under the workspace', async () => {
  const { testsContract, CONTRACT_SUITES } = await import('../gates/framework-tests.mjs');

  const ws = mkdtempSync(join(tmpdir(), 'sk-gate-mount-'));
  try {
    const core = join(ws, '.sidekicks-core');
    mkdirSync(core, { recursive: true });
    writeFileSync(join(core, '.sidekicks-core.json'), '{"schema":1,"version":"1.0.0"}\n');
    for (const rel of CONTRACT_SUITES) {
      mkdirSync(join(core, rel, '..'), { recursive: true });
      writeFileSync(join(core, rel), '// present\n');
    }

    let seen = null;
    const spawn = async (opts) => {
      seen = opts;
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    };
    const out = await testsContract({ repoRoot: ws, spawn, timeoutMs: 1000, signal: null });
    assert.equal(out.exitCode, 0);

    for (const rel of CONTRACT_SUITES) {
      assert.ok(
        seen.argv.includes(join(core, rel)),
        `the argv must name ${rel} inside the mount, not under the workspace root`
      );
    }
    assert.equal(seen.cwd, ws, 'cwd stays the workspace — only the FILE locations came from the core');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a contract suite missing from the framework FAILS, and names what is missing', async () => {
  const { testsContract } = await import('../gates/framework-tests.mjs');
  const empty = mkdtempSync(join(tmpdir(), 'sk-gate-empty-'));
  try {
    let spawned = false;
    const spawn = async () => { spawned = true; return { exitCode: 0, signal: null, stdout: '', stderr: '' }; };
    const out = await testsContract({ repoRoot: empty, spawn, timeoutMs: 1000, signal: null });

    assert.equal(out.exitCode, 1, 'a missing suite is a failure, never a skip');
    assert.equal(out.status, undefined, "it must not report 'skipped' — that would lose the reason");
    assert.match(out.reason, /catalog\.test\.mjs/);
    assert.match(out.reason, /the framework itself is incomplete/);
    assert.equal(spawned, false, 'nothing is spawned when the files are not there');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('a quick run loads no release gate module', async () => {
  // The lazy import exists so `quick` never drags in package-clean / core-mounted / golden-replay.
  // Adding handler gates to `quick` would have quietly undone that if the table were loaded whole.
  const { PROFILES, GATES: G } = await import('../registry.mjs');
  const quick = new Set(PROFILES.quick);
  const handlers = G.filter((g) => quick.has(g.id) && g.handler).map((g) => g.handler);
  assert.deepEqual(handlers, ['tests.contract'], 'quick has exactly one handler gate today');
  for (const releaseOnly of ['package.clean', 'core.mounted', 'golden.replay']) {
    assert.equal(quick.has(releaseOnly), false, `${releaseOnly} must stay out of quick`);
  }
});
