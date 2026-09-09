// lib/check-lifecycle/gates/installer-pwsh.mjs
// The `installer.pwsh` gate: prove the PowerShell installer template is at least syntactically real.
//
// WHY THIS EXISTS (INC-2026-09-05-05, W-2). `install.ps1` is a faithful twin of `install.sh` and
// drives the same cross-platform `core init`, but NOTHING EXECUTES IT. The recovery suite that does
// run — tests/core-install-recovery.test.mjs — skips itself on win32 for the `.sh` path, and its only
// assertion about the PowerShell twin is TEXT PARITY: that the file *contains* /Cleanup-Mount/,
// /MountAdded/, /ls-remote --tags --refs/. A broken `Checkout-Ref`, a quoting bug in the `^{commit}`
// rev-parse, or a cleanup that removes the wrong path would satisfy every one of those greps and
// pass every automated check in the repo. The audit read the script closely and found no such bug;
// the gap is that nothing would catch one tomorrow.
//
// TWO LAYERS, because the honest answer depends on the host:
//   1. A STRUCTURAL LINT that always runs — zero dependencies, no PowerShell needed. It catches the
//      class of damage a careless edit actually produces: unbalanced braces or parens, a `param()`
//      block that went missing, a `{{PLACEHOLDER}}` that survived rendering, a `function` nobody
//      calls. It is not a parser and does not pretend to be one.
//   2. A REAL PARSE when `pwsh` is on PATH. PowerShell Core runs on macOS and Linux, so a developer
//      or a CI leg that has it gets an actual AST check over the RENDERED template — the only thing
//      that catches a genuine syntax regression.
//
// A SKIP IS NOT A PASS, and it says why. Where `pwsh` is absent the gate reports `skipped` with that
// as its reason rather than quietly grading the structural lint as a full check — the failure mode
// recorded in .sidekicks/memory/golden-gate-can-pass-vacuously.md, where a gate that counts inputs
// and trusts an exit code passes vacuously for whoever forgot to provide the inputs. The structural
// lint still runs and can still FAIL in that state: a skip means "the parser did not run", never
// "nothing was checked".
//
// This gate never executes the installer. Running it mounts a submodule and writes a workspace,
// which is a CI step (.github/workflows/ci.yml, windows leg), not something a local `check run` may
// do to a developer's machine.
//
// Zero npm dependencies — node:* only; macOS + Windows.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { frameworkRootOf } from '../../sk-cli/core-mount.mjs';

/** The PowerShell installer template, and the POSIX twin it must stay in parity with. */
export const PS1_TMPL = join('.agents', 'skills', 'sk-inherit', 'assets', 'install.ps1.tmpl');

/**
 * Render a template the way sk-inherit's `renderTemplate` does — plain `{{KEY}}` substitution.
 *
 * The values are placeholders, not real ones: this gate is checking the SHAPE of the script, and a
 * parser needs the braces filled with something syntactically inert. Quotes and backticks are
 * deliberately absent from the substitute so a rendered value cannot itself break the parse and be
 * reported as a template defect.
 *
 * @param {string} text
 * @returns {{rendered: string, unresolved: string[]}}
 */
export function renderForCheck(text) {
  const rendered = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, 'sk-check-placeholder');
  const unresolved = [...new Set((rendered.match(/\{\{[^}]*\}\}/g) || []))];
  return { rendered, unresolved };
}

/**
 * Balance braces, parens and brackets outside strings and comments.
 *
 * Hand-rolled rather than regex-per-line because PowerShell puts `{` and `}` inside strings all the
 * time (`"${env:ProgramFiles}\nodejs"`), and a counter that does not know it is inside a string
 * reports a defect on every correct file. Handles: `#` line comments, `<# #>` block comments,
 * single-quoted (no escapes, `''` is a literal quote) and double-quoted (backtick escapes) strings.
 *
 * @param {string} text
 * @returns {string[]} one message per problem; empty when balanced
 */
export function unbalanced(text) {
  const pairs = { '}': '{', ')': '(', ']': '[' };
  const stack = [];
  const problems = [];
  let i = 0;
  let line = 1;

  while (i < text.length) {
    const c = text[i];
    if (c === '\n') { line += 1; i += 1; continue; }

    // Block comment.
    if (c === '<' && text[i + 1] === '#') {
      const end = text.indexOf('#>', i + 2);
      if (end === -1) { problems.push(`unterminated block comment opened at line ${line}`); break; }
      for (let k = i; k < end; k += 1) if (text[k] === '\n') line += 1;
      i = end + 2;
      continue;
    }
    // Line comment.
    if (c === '#') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    // Single-quoted: no escapes at all; '' is one literal quote.
    if (c === "'") {
      i += 1;
      for (;;) {
        if (i >= text.length) { problems.push(`unterminated single-quoted string at line ${line}`); break; }
        if (text[i] === '\n') line += 1;
        if (text[i] === "'") {
          if (text[i + 1] === "'") { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    // Double-quoted: backtick escapes, "" is one literal quote.
    if (c === '"') {
      i += 1;
      for (;;) {
        if (i >= text.length) { problems.push(`unterminated double-quoted string at line ${line}`); break; }
        if (text[i] === '\n') line += 1;
        if (text[i] === '`') { i += 2; continue; }
        if (text[i] === '"') {
          if (text[i + 1] === '"') { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (c === '{' || c === '(' || c === '[') stack.push({ c, line });
    else if (pairs[c]) {
      const top = stack.pop();
      if (!top) problems.push(`stray '${c}' at line ${line}`);
      else if (top.c !== pairs[c]) problems.push(`'${top.c}' at line ${top.line} closed by '${c}' at line ${line}`);
    }
    i += 1;
  }

  for (const open of stack) problems.push(`'${open.c}' opened at line ${open.line} is never closed`);
  return problems;
}

/**
 * The structural checks that need no PowerShell.
 *
 * @param {string} raw - the template, unrendered
 * @returns {string[]} problems; empty when the template looks structurally sound
 */
export function lintTemplate(raw) {
  const problems = [];
  const { rendered, unresolved } = renderForCheck(raw);

  problems.push(...unbalanced(rendered));

  if (unresolved.length) {
    problems.push(`unrendered placeholder(s) survive substitution: ${unresolved.join(', ')} — `
      + 'renderTemplate only replaces {{UPPER_SNAKE}}, so this one reaches the installed script verbatim');
  }
  if (!/^\s*param\s*\(/m.test(raw)) {
    problems.push('no param() block — the installer takes -Dir/-Ref/-Remote/-NoInit/-Help');
  }

  // Every declared function must be called somewhere. A function that lost its only call site is
  // dead recovery code, which is exactly the shape of the bug this gate is here for: Cleanup-Mount
  // going uncalled would leave a failed install's partial mount on disk with nothing reporting it.
  for (const m of raw.matchAll(/^\s*function\s+([A-Za-z][\w-]*)\b/gm)) {
    const name = m[1];
    const calls = raw.split(new RegExp(`\\b${name}\\b`)).length - 1;
    if (calls < 2) problems.push(`function ${name} is declared but never called`);
  }

  return problems;
}

/**
 * @param {{repoRoot: string, spawn: Function, timeoutMs: number, signal: AbortSignal}} ctx
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string, reason: string|null, status?: string}>}
 */
export async function installerPwsh({ repoRoot, spawn, timeoutMs, signal }) {
  // The template belongs to the FRAMEWORK, so it is looked for at the framework root — in a mount
  // that is the core, not the workspace. Same resolution golden.replay makes, for the same reason.
  const root = frameworkRootOf(repoRoot);
  const abs = join(root, PS1_TMPL);

  if (!existsSync(abs)) {
    // A packaged or trimmed tree legitimately carries no skill assets. That is a check with no
    // subject, not a check that failed.
    return {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      status: 'not_applicable',
      reason: `${PS1_TMPL} is not in this tree — nothing to check`,
    };
  }

  const raw = readFileSync(abs, 'utf8');
  const problems = lintTemplate(raw);
  if (problems.length) {
    return {
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: problems.map((p) => `  ${p}`).join('\n') + '\n',
      reason: `${PS1_TMPL} fails the structural check (${problems.length} problem(s)) — see stderr`,
    };
  }

  // Layer 2: a real parse, where a parser exists.
  const { rendered } = renderForCheck(raw);
  const script = 'param($Path)\n'
    + '$text = [System.IO.File]::ReadAllText($Path)\n'
    + '$errors = $null\n'
    + '[void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$errors)\n'
    + 'if ($errors -and $errors.Count -gt 0) {\n'
    + '  foreach ($e in $errors) { Write-Output ("{0} line {1}: {2}" -f $Path, $e.Extent.StartLineNumber, $e.Message) }\n'
    + '  exit 1\n'
    + '}\n'
    + 'exit 0\n';

  const probe = await spawn({ argv: ['pwsh', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], cwd: repoRoot, timeoutMs, signal });
  if (probe.exitCode !== 0) {
    return {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      status: 'skipped',
      reason: 'pwsh is not on PATH, so the PowerShell PARSER did not run — the structural check above '
        + 'passed, but it is a brace counter, not a parser, and a real syntax regression can slip past '
        + 'it. Install PowerShell Core (it runs on macOS and Linux) or dispatch the Windows CI leg '
        + '(`gh workflow run ci.yml`) before cutting a release.',
    };
  }

  // The rendered text goes through a temp file rather than the command line: the template is ~240
  // lines and quoting it through an argv would be its own source of false failures.
  const tmp = join(repoRoot, `.sk-installer-pwsh-${process.pid}.ps1`);
  const { writeFileSync, rmSync } = await import('node:fs');
  try {
    writeFileSync(tmp, rendered, 'utf8');
    const r = await spawn({ argv: ['pwsh', '-NoProfile', '-Command', script, '-Path', tmp], cwd: repoRoot, timeoutMs, signal });
    return {
      exitCode: r.exitCode,
      signal: r.signal ?? null,
      stdout: r.stdout,
      stderr: r.stderr,
      reason: r.exitCode === 0
        ? null
        : `${PS1_TMPL} does not parse as PowerShell — the installer would fail at its first line on `
          + 'a real Windows host, and no other gate in this repo would have noticed',
    };
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}
