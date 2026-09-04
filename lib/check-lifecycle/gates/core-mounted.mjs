// lib/check-lifecycle/gates/core-mounted.mjs
// The `core.mounted` gate: mount a freshly forged core into a fresh workspace in a TEMPORARY
// directory, and drive ONLY the mounted entrypoint.
//
// WHY THIS SHAPE, AND WHY IT IS NOT THE SAME AS `core doctor` HERE. A framework core IS the mounted
// consumer behaviour, not the generated checkout. The release audit that tests/core-fresh-install.
// test.mjs was written for found `core doctor` green inside the generated core while
// framework/config/skill doctors failed in the workspace that mounted it — because those gates ran at
// the core's own root, where `scripts/` sits in place and there is no mount to resolve through. So
// this gate builds the two-repo shape (core repo + consumer workspace with the core as a submodule at
// `.sidekicks-core/`), initialises the workspace THROUGH the mounted binary, and then runs
// `core doctor --all` — the composed gate — with the WORKSPACE as cwd and
// `.sidekicks-core/bin/sidekicks` as the only entrypoint invoked. Nothing in the source repo is
// executed after the fixture is built.
//
// GIT IS REQUIRED, because a submodule mount is the thing under test. Without git the gate FAILS
// with that as its reason: silently passing a gate whose subject could not be constructed is the
// failure mode this whole runner exists to remove.
//
// Nothing machine-absolute leaves this gate: both temp roots are redacted out of every tail.
//
// Zero npm dependencies — node:* only; macOS + Windows.

import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { redactRoots } from '../_shared.mjs';
import { frameworkRootOf } from '../../sk-cli/core-mount.mjs';

/** Files and trees a mountable core carries. Missing ones are skipped, never fatal. */
const CORE_TREES = ['lib', 'bin', 'scripts'];
const CORE_WIRING = [
  join('.claude', 'settings.json'),
  join('.codex', 'config.toml'),
  join('.gemini', 'settings.json'),
  join('.agent', 'settings.json'),
];
/** Two real skills, so the skill overlay has an exact set to be complete about. */
const CORE_SKILLS = ['sk-hello', 'sk-scope-switch'];

/**
 * @param {{repoRoot: string, spawn: Function, timeoutMs: number, signal: AbortSignal}} ctx
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string, reason: string|null}>}
 */
export async function coreMounted({ repoRoot, spawn, timeoutMs, signal }) {
  const log = [];
  const roots = [];
  /** @param {string} label @param {object} r */
  const record = (label, r) => {
    log.push(`--- ${label} -> exit ${r.exitCode ?? 'null'}${r.signal ? ` (${r.signal})` : ''}`);
    if (r.stdout) log.push(r.stdout.trimEnd());
    if (r.stderr) log.push(r.stderr.trimEnd());
  };
  /** Record a `check run --json` result as one line per gate id and status, and nothing volatile. */
  const recordVerdicts = (label, r) => {
    log.push(`--- ${label} -> exit ${r.exitCode ?? 'null'}${r.signal ? ` (${r.signal})` : ''}`);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout || ''); } catch { /* fall through to the raw tail */ }
    if (parsed && Array.isArray(parsed.gates)) {
      log.push(`profile ${parsed.profile}: ${parsed.status}`);
      for (const g of parsed.gates) log.push(`  ${g.status.padEnd(8)} ${g.id}`);
      // A failure has to stay diagnosable, so the reason survives even in the compact form.
      for (const g of parsed.gates) {
        if (g.status !== 'passed' && g.reason) log.push(`  ${g.id}: ${g.reason}`);
      }
      return;
    }
    if (r.stdout) log.push(r.stdout.trimEnd());
    if (r.stderr) log.push(r.stderr.trimEnd());
  };
  const done = (r, reason) => ({
    exitCode: r === null ? 1 : (r.exitCode ?? 1),
    signal: r === null ? null : (r.signal ?? null),
    stdout: redactRoots(log.join('\n'), roots),
    stderr: '',
    reason: reason ? redactRoots(reason, roots) : null,
  });

  const git = (args, cwd, { allowFile = false } = {}) => spawn({
    argv: ['git', ...(allowFile ? ['-c', 'protocol.file.allow=always'] : []), ...args],
    cwd,
    timeoutMs,
    signal,
  });

  const haveGit = await spawn({ argv: ['git', '--version'], cwd: repoRoot, timeoutMs, signal });
  if (haveGit.exitCode !== 0) {
    record('git --version', haveGit);
    return done({ exitCode: 1 }, 'git is unavailable, so a submodule mount cannot be built — the mounted-core gate cannot be honestly evaluated');
  }

  let base;
  try {
    // realpathSync for the reason gates/package-clean.mjs gives: an unresolved /var/... prefix would
    // survive redaction as half a machine-absolute path.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'sk-check-core-')));
  } catch (err) {
    return done({ exitCode: 1 }, `could not create a temporary directory: ${err.message}`);
  }
  roots.push(base);
  const coreRepo = join(base, 'framework-core');
  const ws = join(base, 'workspace');

  try {
    // ── 1. A core-shaped repo: the framework code, its wiring, its settings, its marker ──────────
    mkdirSync(join(coreRepo, '.sidekicks', 'config', 'settings'), { recursive: true });
    mkdirSync(join(coreRepo, '.agents', 'skills'), { recursive: true });
    // The fixture core is built from the FRAMEWORK, and in a mounted workspace that is the mount —
    // `repoRoot` there has no lib/, bin/ or scripts/ to copy. Same one-line answer the other mount
    // fixes take (INC-2026-09-04-02, N-3).
    const src0 = frameworkRootOf(repoRoot);
    for (const tree of CORE_TREES) {
      const src = join(src0, tree);
      if (existsSync(src)) cpSync(src, join(coreRepo, tree), { recursive: true });
    }
    cpSync(join(src0, 'package.json'), join(coreRepo, 'package.json'));
    for (const rel of [join('.sidekicks', 'RULES.md'), join('.sidekicks', 'hooks'),
      join('.sidekicks', 'config', '.gitignore'), join('.sidekicks', 'agent-packs')]) {
      const src = join(src0, rel);
      if (existsSync(src)) cpSync(src, join(coreRepo, rel), { recursive: true });
    }
    for (const f of ['rules.yaml', 'criteria.yaml', 'hooks.yaml']) {
      const src = join(src0, '.sidekicks', 'config', 'settings', f);
      if (existsSync(src)) cpSync(src, join(coreRepo, '.sidekicks', 'config', 'settings', f));
    }
    for (const rel of CORE_WIRING) {
      const src = join(src0, rel);
      if (!existsSync(src)) continue;
      mkdirSync(join(coreRepo, dirname(rel)), { recursive: true });
      cpSync(src, join(coreRepo, rel));
    }
    for (const s of CORE_SKILLS) {
      const src = join(src0, '.agents', 'skills', s);
      if (existsSync(src)) cpSync(src, join(coreRepo, '.agents', 'skills', s), { recursive: true });
    }
    // The instruction surface travels as AGENTS.framework.md — framework doctor checks its CONTENT.
    if (existsSync(join(src0, 'AGENTS.md'))) {
      cpSync(join(src0, 'AGENTS.md'), join(coreRepo, 'AGENTS.framework.md'));
    }
    writeFileSync(join(coreRepo, '.sidekicks-core.json'), `${JSON.stringify({
      schema: 1,
      name: 'sidekicks-framework',
      version: '0.0.0-check',
      layout: 1,
      // A fixed instant, not `new Date()`: nothing this gate writes may vary run to run.
      forged_at: '2026-01-01T00:00:00+07:00',
      source_commit: 'check-run',
    }, null, 2)}\n`, 'utf8');
    writeFileSync(join(coreRepo, '.gitignore'), '.venv/\nartifacts/\n', 'utf8');

    // The forge re-syncs the enable map against the RUNTIME's own registry before shipping; without
    // it a trimmed core carries entries for skills it does not have, and every one is drift.
    const sync = await spawn({
      argv: ['node', join(coreRepo, 'bin', 'sidekicks'), 'framework', 'sync', '--prune'],
      cwd: coreRepo, timeoutMs, signal,
    });
    record('core: framework sync --prune', sync);
    if (sync.exitCode !== 0) return done(sync, 'the forged core could not sync its own enable map');

    for (const [label, args] of [
      ['git init', ['init', '-q', '-b', 'main', '.']],
      ['git config email', ['config', 'user.email', 'check@sidekicks.invalid']],
      ['git config name', ['config', 'user.name', 'sidekicks check']],
      ['git add', ['add', '-A']],
      ['git commit', ['commit', '-qm', 'core']],
    ]) {
      const r = await git(args, coreRepo);
      if (r.exitCode !== 0) { record(`core: ${label}`, r); return done(r, `building the core repo failed at ${label}`); }
    }

    // ── 2. A consumer workspace that MOUNTS it ───────────────────────────────────────────────────
    mkdirSync(ws, { recursive: true });
    for (const [label, args, opts] of [
      ['git init', ['init', '-q', '.'], {}],
      ['git config email', ['config', 'user.email', 'check@sidekicks.invalid'], {}],
      ['git config name', ['config', 'user.name', 'sidekicks check'], {}],
      ['submodule add', ['submodule', 'add', '-q', coreRepo, '.sidekicks-core'], { allowFile: true }],
    ]) {
      const r = await git(args, ws, opts);
      if (r.exitCode !== 0) { record(`workspace: ${label}`, r); return done(r, `building the workspace failed at ${label}`); }
    }

    // ── 3. From here on, ONLY the mounted entrypoint runs, with the workspace as cwd ─────────────
    const mounted = join('.sidekicks-core', 'bin', 'sidekicks');
    const init = await spawn({ argv: ['node', mounted, 'core', 'init'], cwd: ws, timeoutMs, signal });
    record('mounted: core init', init);
    if (init.exitCode !== 0) return done(init, 'core init failed in a freshly mounted workspace');

    const doctor = await spawn({
      argv: ['node', mounted, 'core', 'doctor', '--all'], cwd: ws, timeoutMs, signal,
    });
    record('mounted: core doctor --all', doctor);
    if (doctor.exitCode !== 0) return done(doctor, 'core doctor --all failed in a freshly mounted workspace');

    // The workspace must pass its OWN gates, not just the doctors. This is F-3 asserted at release
    // time: `check run quick` was red in every mounted workspace — catalog.check resolved framework
    // paths against the workspace root, and tests.contract named files the mount does not have at
    // that path — and nothing in the release path had ever asked a mount that question.
    //
    // `quick`, deliberately, and this is a boundary worth stating because the obvious next move is
    // wrong. The core built above is SYNTHETIC and minimal on purpose — two skills, four wiring
    // files, no instruction mirrors, no agent surfaces — because what this gate judges is the MOUNT
    // MECHANICS: does a core mount, seed, and pass its own cheap gates. `full` would run the whole
    // framework suite inside that stub and fail on everything the stub was built not to have, which
    // is noise, not signal. The question "does the REAL forged artifact pass `full` in a mount" is
    // asked where the real artifact exists: `mountCheck()` in scripts/framework-core-publish.mjs
    // mounts it and runs `full` there (INC-2026-09-04-02, N-3).
    const check = await spawn({
      argv: ['node', mounted, 'check', 'run', 'quick', '--json'], cwd: ws, timeoutMs, signal,
    });
    // Recorded as VERDICTS, not as the raw run. The full `--json` carries per-gate durations and the
    // entire stdout of a nested `node --test`, so freezing it would make this golden drift on every
    // timing jitter and on every test name added anywhere in the two contract suites. What the
    // contract is actually about is which gates a mounted workspace passes.
    recordVerdicts('mounted: check run quick', check);
    if (check.exitCode !== 0) return done(check, 'check run quick failed in a freshly mounted workspace');

    // `package.clean` is a release-profile gate, so `full` above does not reach it — and it is the
    // one that died in a mount with "validateSource: lib/sk-cli not found", taking core.mounted and
    // golden.replay down with it as BLOCKED. Running `package create` directly is the cheap,
    // non-recursive way to ask the same question from inside the mount.
    const pkg = await spawn({
      argv: ['node', mounted, 'package', 'create', '--output', join(base, 'package-smoke'), '--dry-run'],
      cwd: ws,
      timeoutMs,
      signal,
    });
    // Exit code only: a dry-run plan lists every file it would copy, which would make this golden
    // churn on any change to the copy plan. What the contract is about is that it RESOLVES.
    log.push(`--- mounted: package create --dry-run -> exit ${pkg.exitCode ?? 'null'}`);
    if (pkg.exitCode !== 0) {
      record('mounted: package create --dry-run (failure detail)', pkg);
      return done(pkg, 'package create could not resolve the framework from a mounted workspace');
    }

    const status = await spawn({
      argv: ['node', mounted, 'core', 'status', '--offline', '--json'], cwd: ws, timeoutMs, signal,
    });
    record('mounted: core status --offline --json', status);
    if (status.exitCode !== 0) return done(status, 'core status failed in a freshly mounted workspace');

    return done({ exitCode: 0 }, null);
  } catch (err) {
    return done({ exitCode: 1 }, `mounted-core fixture failed: ${err.message}`);
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
