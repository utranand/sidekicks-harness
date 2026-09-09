// lib/check-lifecycle/tests/installer-pwsh.test.mjs
// The `installer.pwsh` gate (INC-2026-09-05-05, W-2/R-3).
//
// The gate exists because NOTHING executes install.ps1: the recovery suite skips the `.sh` path on
// win32 and asserts the PowerShell twin only by grepping it for a few identifiers, which a script
// with a genuine syntax error would satisfy. These cases pin the two properties that make the gate
// worth having rather than decorative:
//
//   1. It FAILS on a malformed template — verified by perturbing real content, not a toy string.
//   2. A skip is never a silent pass, and it names its reason.
//
// Colocated under lib/ so it travels into a forged core and a consumer can run it (same reason the
// parity suites moved — INC-2026-09-04-02, N-3). node:test + node:assert/strict only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installerPwsh, lintTemplate, unbalanced, renderForCheck, PS1_TMPL } from '../gates/installer-pwsh.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tmplPath = join(repoRoot, PS1_TMPL);
const haveTemplate = existsSync(tmplPath);

/** A spawn stub: `pwsh` is reported absent unless `pwsh` is given an exit code. */
const spawnStub = ({ pwsh = null } = {}) => async ({ argv }) => {
  if (argv[0] === 'pwsh') return { exitCode: pwsh === null ? 127 : pwsh, stdout: '', stderr: '', signal: null };
  return { exitCode: 0, stdout: '', stderr: '', signal: null };
};

// ── the structural lint ────────────────────────────────────────────────────────

test('the real install.ps1.tmpl passes the structural lint', { skip: !haveTemplate }, () => {
  assert.deepEqual(lintTemplate(readFileSync(tmplPath, 'utf8')), [],
    'the shipped template must be clean — a gate that starts red teaches people to ignore it');
});

test('braces inside strings and comments are not counted', () => {
  // The reason this is hand-rolled rather than a regex: PowerShell puts braces in strings
  // constantly, and a naive counter reports a defect on every correct file.
  assert.deepEqual(unbalanced('$p = "${env:ProgramFiles}\\nodejs"\n'), []);
  assert.deepEqual(unbalanced("$s = 'a { b'\n"), []);
  assert.deepEqual(unbalanced('# a comment with { and (\n'), []);
  assert.deepEqual(unbalanced('<# block { comment #>\nfunction A { }\nA\n'), []);
  assert.deepEqual(unbalanced('$q = "she said ""hi"" { "\n'), []);
  assert.deepEqual(unbalanced('$e = "a `" { b"\n'), [], 'a backtick-escaped quote does not end the string');
});

test('a real imbalance IS reported, with the line it opened on', () => {
  const problems = unbalanced('function A {\n  if ($true) {\n  }\n');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'\{' opened at line 1 is never closed/);
});

test('a mismatched closer is reported, and a stray one is reported as stray', () => {
  // Two different defects with two different messages: a `(` that a `}` closes is nesting damage,
  // while a `}` with nothing open is a leftover from a deleted block.
  assert.match(unbalanced('if ($true }\n')[0], /closed by '\}'/);
  assert.match(unbalanced('if ($true) }\n')[0], /stray '\}'/);
});

test('an unterminated string is reported rather than swallowing the rest of the file', () => {
  assert.match(unbalanced('$s = "never closed\n')[0], /unterminated double-quoted string/);
});

test('a surviving placeholder is a defect — it would reach the installed script verbatim', () => {
  const { unresolved } = renderForCheck('$Ref = "{{core-tag}}"\n');
  assert.deepEqual(unresolved, ['{{core-tag}}'],
    'renderTemplate substitutes {{UPPER_SNAKE}} only, so a lowercase key is never replaced');
  assert.match(lintTemplate('param($X)\n$Ref = "{{core-tag}}"\n')[0], /unrendered placeholder/);
});

test('an UPPER_SNAKE placeholder is substituted and does not trip the lint', () => {
  const { rendered, unresolved } = renderForCheck('$Ref = "{{CORE_TAG}}"\n');
  assert.deepEqual(unresolved, []);
  assert.equal(rendered.includes('{{'), false);
});

test('a missing param() block is a defect', () => {
  assert.match(lintTemplate('Write-Output "hi"\n').join(' '), /no param\(\) block/);
});

test('a function that lost its only call site is reported', () => {
  // The shape of the bug this is really for: Cleanup-Mount going uncalled leaves a failed install's
  // partial mount on disk with nothing reporting it, and every text-parity grep still passes.
  const problems = lintTemplate('param($X)\nfunction Cleanup-Mount {\n  Write-Output "x"\n}\n');
  assert.match(problems.join(' '), /function Cleanup-Mount is declared but never called/);
  assert.deepEqual(
    lintTemplate('param($X)\nfunction Cleanup-Mount {\n  Write-Output "x"\n}\nCleanup-Mount\n'),
    [], 'a called function is fine');
});

// ── the gate ───────────────────────────────────────────────────────────────────

test('a malformed template FAILS the gate, and the stderr names the problem', { skip: !haveTemplate }, async () => {
  // Perturbation over REAL content, so the case cannot pass by testing a toy string the gate would
  // never see (.sidekicks/memory/golden-gate-can-pass-vacuously.md).
  const raw = readFileSync(tmplPath, 'utf8');
  const problems = lintTemplate(`${raw}\nfunction Broken-Thing {\n  if ($true) {\n`);
  assert.ok(problems.length >= 2, `a truncated function must be caught: ${JSON.stringify(problems)}`);
  assert.match(problems.join('\n'), /is never closed/);
});

test('no pwsh ⇒ SKIPPED with the reason named, never a silent pass', { skip: !haveTemplate }, async () => {
  const r = await installerPwsh({ repoRoot, spawn: spawnStub(), timeoutMs: 5000, signal: null });
  assert.equal(r.status, 'skipped');
  assert.equal(r.exitCode, null, 'a skip must not masquerade as exit 0');
  assert.match(r.reason, /pwsh is not on PATH/);
  assert.match(r.reason, /brace counter, not a parser/,
    'the reason must say what was NOT checked — that is the whole point of not calling it a pass');
});

test('pwsh present and parsing cleanly ⇒ the gate passes', { skip: !haveTemplate }, async () => {
  const r = await installerPwsh({ repoRoot, spawn: spawnStub({ pwsh: 0 }), timeoutMs: 5000, signal: null });
  assert.equal(r.exitCode, 0);
  assert.equal(r.reason, null);
});

test('a parse error fails the gate and says no other gate would have caught it', { skip: !haveTemplate }, async () => {
  const spawn = async ({ argv }) => (argv.includes('$PSVersionTable.PSVersion.Major')
    ? { exitCode: 0, stdout: '7', stderr: '', signal: null }
    : { exitCode: 1, stdout: 'line 12: unexpected token', stderr: '', signal: null });
  const r = await installerPwsh({ repoRoot, spawn, timeoutMs: 5000, signal: null });
  assert.equal(r.exitCode, 1);
  assert.match(r.reason, /does not parse as PowerShell/);
});

test('a tree with no template is not_applicable, not a failure', async (t) => {
  // A REAL EMPTY DIRECTORY, not `dirname(repoRoot)` (INC-2026-09-09). The parent of a source
  // checkout happens to hold no framework, so that fixture read as "a tree with no template" here
  // and nowhere else: in a MOUNTED workspace the framework root is `<ws>/.sidekicks-core`, its
  // parent is the workspace, and `frameworkRootOf(<ws>)` resolves straight back into the core — so
  // the template WAS found, the gate answered `skipped`, and this case was red in every mount. It
  // took `tests.all` down with it and, through the dependency chain, `skill.doctor`, `parity` and
  // `package.clean`, which is what halted a release at the mount gate with no named cause.
  //
  // A tmp dir has no `.sidekicks-core` and no `.agents/skills/`, so the fixture means the same thing
  // in a source checkout, a mount, and a packaged tree — which is the only way a suite colocated
  // under lib/ can assert this at all.
  const empty = mkdtempSync(join(tmpdir(), 'sk-installer-pwsh-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  // A packaged or trimmed tree legitimately carries no skill assets, and grading that as failed is
  // what made golden.replay red in every consumer install.
  const r = await installerPwsh({ repoRoot: empty, spawn: spawnStub(), timeoutMs: 5000, signal: null });
  assert.equal(r.status, 'not_applicable');
});

test('in a MOUNT the template is found in the core, not judged absent from the workspace',
  { skip: !haveTemplate }, async (t) => {
    // The other half of the case above, and the semantics that made the old `dirname(repoRoot)`
    // fixture wrong (INC-2026-09-09). A workspace is nearly empty by design — the framework lives at
    // `.sidekicks-core/` — so `frameworkRootOf` steps INTO the mount, and "the workspace has no
    // .agents/skills/" is never a reason to grade this gate not_applicable. Pinning it here means a
    // future author cannot re-derive an "absent framework" fixture from a workspace path without a
    // red test in the source repo, instead of a red mount gate at ship time.
    const ws = mkdtempSync(join(tmpdir(), 'sk-installer-pwsh-mount-'));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    const core = join(ws, '.sidekicks-core');
    mkdirSync(join(core, dirname(PS1_TMPL)), { recursive: true });
    // The marker is what makes a directory a core; without it `.sidekicks-core` is someone else's
    // folder and the resolution deliberately does not step into it.
    writeFileSync(join(core, '.sidekicks-core.json'), '{"schema":1}\n');
    writeFileSync(join(core, PS1_TMPL), readFileSync(tmplPath, 'utf8'));

    const r = await installerPwsh({ repoRoot: ws, spawn: spawnStub(), timeoutMs: 5000, signal: null });
    assert.notEqual(r.status, 'not_applicable',
      'the template is in the mounted core — reporting "nothing to check" would be a vacuous pass');
    assert.equal(r.status, 'skipped', 'pwsh is stubbed absent, so the parser leg skips');
  });

test('an unmarked .sidekicks-core is not a mount, so an empty workspace stays not_applicable',
  async (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'sk-installer-pwsh-unmarked-'));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    mkdirSync(join(ws, '.sidekicks-core'), { recursive: true });
    const r = await installerPwsh({ repoRoot: ws, spawn: spawnStub(), timeoutMs: 5000, signal: null });
    assert.equal(r.status, 'not_applicable');
  });
