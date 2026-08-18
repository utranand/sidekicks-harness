// lib/check-lifecycle/gates/package-clean.mjs
// The `package.clean` gate: assemble a package into a TEMPORARY directory and drive ONLY the
// packaged entrypoint.
//
// WHY THE TEMP DIRECTORY IS THE POINT. The failure this gate exists to catch is source-tree leakage:
// a packaged module that resolves an import, a template or a config file by reaching back into the
// repo it was built from. Assembling into the repo (or running the source `bin/sidekicks` against the
// package) hides exactly that, because the leaked path still exists. So the package is built somewhere
// with no relationship to the repo, every command runs with the PACKAGE as cwd, and `bin/sidekicks`
// under that package root is the only entrypoint invoked. The temp tree is removed either way.
//
// Nothing machine-absolute leaves this gate: the temp root is redacted out of every captured tail
// (CLAUDE.md § Portable paths).
//
// Zero npm dependencies — node:* only; macOS + Windows.

import { mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { redactRoots } from '../_shared.mjs';

/**
 * @param {{repoRoot: string, spawn: Function, timeoutMs: number, signal: AbortSignal}} ctx
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string, reason: string|null}>}
 */
export async function packageClean({ repoRoot, spawn, timeoutMs, signal }) {
  let base;
  try {
    // realpathSync: on macOS mkdtemp hands back /var/folders/... while a child process reports the
    // resolved /private/var/folders/..., and redacting the unresolved form would leave half of a
    // machine-absolute path in the tail.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'sk-check-pkg-')));
  } catch (err) {
    return {
      exitCode: null, signal: null, stdout: '', stderr: '',
      reason: `could not create a temporary directory: ${err.message}`,
    };
  }
  const pkgRoot = join(base, 'package');
  const log = [];
  /** @param {string} label @param {object} r */
  const record = (label, r) => {
    log.push(`--- ${label} -> exit ${r.exitCode ?? 'null'}${r.signal ? ` (${r.signal})` : ''}`);
    if (r.stdout) log.push(r.stdout.trimEnd());
    if (r.stderr) log.push(r.stderr.trimEnd());
  };
  const done = (r, reason) => ({
    exitCode: r === null ? 1 : (r.exitCode ?? 1),
    signal: r === null ? null : (r.signal ?? null),
    stdout: redactRoots(log.join('\n'), [base]),
    stderr: '',
    reason: reason ? redactRoots(reason, [base]) : null,
  });

  try {
    // 1. Assemble. Run from the repo, because this is the only step that legitimately reads it.
    const create = await spawn({
      argv: ['node', 'bin/sidekicks', 'package', 'create', '--output', pkgRoot],
      cwd: repoRoot,
      timeoutMs,
      signal,
    });
    record('package create --output <tmp>/package', create);
    if (create.exitCode !== 0) return done(create, 'package create failed');

    const pkgBin = join(pkgRoot, 'bin', 'sidekicks');
    if (!existsSync(pkgBin)) {
      return done({ exitCode: 1 }, 'the assembled package has no bin/sidekicks entrypoint');
    }

    // 2. Drive the PACKAGED entrypoint only, with the package as cwd. Three probes, cheapest first:
    //    help proves dispatch resolves inside the package; `catalog check` proves the packaged
    //    catalog snapshot matches the runtime that shipped with it; `package versions` proves every
    //    shipped component carries its VERSION.json.
    for (const [label, argv] of [
      ['packaged --help', ['node', pkgBin, '--help']],
      ['packaged catalog check', ['node', pkgBin, 'catalog', 'check', '--json']],
      ['packaged package versions', ['node', pkgBin, 'package', 'versions']],
    ]) {
      const r = await spawn({ argv, cwd: pkgRoot, timeoutMs, signal });
      record(label, r);
      if (r.exitCode !== 0) return done(r, `${label} failed inside the assembled package`);
    }

    // 3. No source-tree leakage. Importing the packaged CLI module graph with the package as cwd
    //    fails loudly if any packaged module resolves a sibling that did not travel with it — the
    //    exact defect a run against the source tree cannot see, because there the sibling exists.
    const probe = 'import(process.argv[1]).then(() => process.exit(0))'
      + '.catch((e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1); });';
    const leak = await spawn({
      argv: ['node', '-e', probe, pathToFileURL(join(pkgRoot, 'lib', 'sk-cli', 'cli.mjs')).href],
      cwd: pkgRoot,
      timeoutMs,
      signal,
    });
    record('packaged cli.mjs imports standalone', leak);
    if (leak.exitCode !== 0) return done(leak, 'the packaged CLI module graph does not load standalone');

    return done({ exitCode: 0 }, null);
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
