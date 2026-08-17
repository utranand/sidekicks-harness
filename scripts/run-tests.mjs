#!/usr/bin/env node
// scripts/run-tests.mjs
// The repo's ONE test entrypoint — `npm test` and every forged runtime's `npm test` run this.
//
// WHY THIS EXISTS. `node --test 'tests/**/*.test.mjs'` looks like a test command and behaves like
// one only when the glob happens to match:
//
//   * Node 22 expands its own glob argument. When nothing matches it runs zero tests, prints
//     `# tests 0`, and EXITS 0. A repo with no top-level tests/ therefore reports a passing suite.
//     That is what the v2.0.0 framework core did: `npm test` was green while its 89 real tests —
//     living under lib/artifacts-lifecycle/tests/ — were never loaded.
//   * Node 20 does not expand it, so the same command exits 1 with a module-not-found. Two
//     supported runtimes, two different meanings, neither of them "the tests passed".
//   * In package.json the quoting differs again between sh and PowerShell.
//
// So: discover the files here, hand Node an explicit argv, and make an empty discovery a LOUD
// failure rather than a silent pass. Zero tests is a broken runner, never a green suite.
//
// Usage:
//   node scripts/run-tests.mjs [--list] [--json] [--] [<extra node --test flag> ...]
//
//   --list   print the discovered files and exit 0 without running anything
//   --json   print the discovery result as JSON (with --list) — for gates that want the count
//
// Exit codes: whatever `node --test` returns, except 3 for a discovery/runner failure.
//
// Zero npm dependencies; node:* only; macOS + Windows.

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Directory names never walked, wherever they appear. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__',
  // A forged runtime lives under runtimes/ and carries its own copy of everything, including its
  // own tests. Walking into it would run another repo's suite as if it were ours.
  'runtimes',
  // projects/ holds user projects and service checkouts — their suites are gated separately
  // (sk-test-gate against the service working folder), never by the framework's own gate.
  'projects',
  // Sibling worktrees are sometimes symlinked or nested by mistake; never ours to run.
  'worktrees', 'artifacts', 'output',
]);

/**
 * Every `*.test.mjs` under `dir`, recursively.
 *
 * @param {string} dir - absolute directory
 * @param {string[]} [acc]
 * @returns {string[]} absolute file paths
 */
function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.sidekicks') continue;
    const abs = join(dir, e.name);
    // Never follow a link out of the tree: a Dirent for a symlinked directory is not isDirectory(),
    // so this is conservative by construction on both platforms.
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, acc);
    } else if (e.isFile() && e.name.endsWith('.test.mjs')) {
      acc.push(abs);
    }
  }
  return acc;
}

/**
 * The roots that may hold this repo's own tests.
 *
 * Two shapes are supported because both exist in practice: a top-level `tests/` tree (the source
 * repo) and per-subsystem `lib/<x>/tests/` trees (what a trimmed framework core ships). Discovery
 * covers both so a repo cannot report green by having its tests in the shape the gate forgot.
 *
 * @returns {string[]} absolute directories that exist
 */
function testRoots() {
  const roots = [];
  const top = join(ROOT, 'tests');
  if (existsSync(top)) roots.push(top);

  const lib = join(ROOT, 'lib');
  if (existsSync(lib)) {
    let subs = [];
    try { subs = readdirSync(lib, { withFileTypes: true }); } catch { subs = []; }
    for (const e of subs) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const t = join(lib, e.name, 'tests');
      if (existsSync(t)) roots.push(t);
    }
  }
  return roots;
}

/**
 * @returns {{files: string[], roots: string[]}} repo-relative POSIX paths, sorted and deduped
 */
export function discover() {
  const roots = testRoots();
  const seen = new Set();
  for (const r of roots) {
    for (const f of walk(r)) {
      try { if (!statSync(f).isFile()) continue; } catch { continue; }
      seen.add(relative(ROOT, f).split(sep).join('/'));
    }
  }
  return {
    files: [...seen].sort(),
    roots: roots.map((r) => relative(ROOT, r).split(sep).join('/')).sort(),
  };
}

const argv = process.argv.slice(2);
const wantList = argv.includes('--list');
const wantJson = argv.includes('--json');
const passthrough = argv.filter((a) => a !== '--list' && a !== '--json' && a !== '--');

const { files, roots } = discover();

if (files.length === 0) {
  const msg = `run-tests: discovered NO test files under ${roots.length ? roots.join(', ') : 'tests/ or lib/*/tests/'}\n`
    + 'run-tests: zero tests is a runner failure, not a passing suite — check that the test files travelled.\n';
  if (wantJson) process.stdout.write(`${JSON.stringify({ ok: false, count: 0, roots, files: [] }, null, 2)}\n`);
  process.stderr.write(msg);
  process.exit(3);
}

if (wantList) {
  if (wantJson) process.stdout.write(`${JSON.stringify({ ok: true, count: files.length, roots, files }, null, 2)}\n`);
  else {
    process.stdout.write(`run-tests: ${files.length} file(s) under ${roots.join(', ')}\n`);
    for (const f of files) process.stdout.write(`  ${f}\n`);
  }
  process.exit(0);
}

// Explicit argv, never a glob: no shell is involved and neither Node's own glob expansion nor the
// host shell's gets a say in what runs.
//
// NODE_TEST_CONTEXT is stripped deliberately. Node's test runner sets it in the processes it
// spawns, and it makes a nested `node --test` report as a CHILD of that run — no TAP summary, no
// usable exit semantics. It leaks in whenever this launcher is invoked from inside a test (which
// is exactly how the launcher itself is tested), and the symptom is a run that looks empty.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

const res = spawnSync(process.execPath, ['--test', ...passthrough, ...files], {
  cwd: ROOT,
  stdio: 'inherit',
  env,
});

if (res.error) {
  process.stderr.write(`run-tests: could not start the test runner: ${res.error.message}\n`);
  process.exit(3);
}
process.exit(res.status ?? 3);
