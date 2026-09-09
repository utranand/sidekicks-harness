// lib/framework-lifecycle/tests/multi-cli-parity.test.mjs
// Enforces Rule 6 — Multi-CLI Parity (.sidekicks/RULES.md): the repo must work
// identically across every supported agent CLI (Claude Code, Codex, Gemini,
// Antigravity). Shared definitions are canonical on CLI-neutral surfaces;
// every host CLI inherits them through symlinks, generated ports, or wiring.
//
// What this suite pins down:
//   1. Skill exposure links — one per CLI — resolve to .agents/skills/
//      (after the same self-heal the CLI runs on every invocation).
//   2. The links are git-ignored and never tracked (a committed symlink checks
//      out as a text stub on Windows and silently breaks skill discovery).
//   3. Every hook script referenced by any CLI's hook config exists on disk.
//   4. Every neutral subagent has deterministic Claude, Codex, Gemini, and
//      Antigravity ports.
//
// The instruction mirrors (CLAUDE.md / GEMINI.md → AGENTS.md) are enforced
// separately by agent-context-mirror.test.mjs, beside this file.
//
// WHY IT LIVES UNDER lib/ (INC-2026-09-04-02, N-3). It used to sit in repo-root tests/, which
// travels into neither a forged core nor a package — so the `parity` gate named two files that a
// mounted workspace could not possibly have, and `check run full` was RED in every consumer install
// while it was green here. `lib/` is copied whole into a core, so colocating it makes the gate
// runnable exactly where it matters most: a core ships per-CLI wiring, and whether THAT wiring is
// consistent is a question its consumer must be able to ask. Same move `tests.contract`'s suites
// already made for the same reason.
//
// Maintenance contract: docs/guide/pending-update/multi-cli-compatibility.md.
// Uses only node:test + node:assert/strict — no third-party imports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  parseDefinition,
  isOsNoise,
  markdownFiles,
  renderCodex,
  validatePortableSubagentName,
} from '../../../scripts/generate-subagent-ports.mjs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { ensureSkillLinks } from '../../sk-cli/skill-links.mjs';
import { SKILL_TREES, EXPOSURE_LINK_RELS } from '../../sk-cli/skill-trees.mjs';
import {
  CANONICAL_SUBAGENT_ROOT,
  CLI_CONFIG_PATHS,
  CLI_SURFACES,
  LOGICAL_HOOKS,
} from '../cli-surfaces.mjs';

// lib/framework-lifecycle/tests/ -> lib/framework-lifecycle -> lib -> the framework root. In a
// mounted workspace that root is the CORE, which is the tree whose parity is being judged.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const isWindows = process.platform === 'win32';

// One skill exposure link per supported CLI. Keep in sync with EXPOSURE_LINKS in
// lib/sk-cli/skill-trees.mjs and the ignore block in .gitignore.
//
// `.agents/skills` is NOT here: it is the CANONICAL tree — a real, committed, tracked directory that
// the AGENTS.md-standard CLIs read directly. It is asserted separately below, with the opposite
// expectations, because listing it here would demand it be ignored and untracked.
const SKILL_LINKS = [
  ['.claude/skills', 'Claude Code'],
  ['.agent/skills', 'Antigravity'],
  ['.gemini/skills', 'Gemini CLI'],
];

// Hook config files, one per CLI. Every scripts/*.mjs or .sidekicks/hooks/*
// path they mention must exist — a dangling reference means that CLI's hook
// silently no-ops (or errors) after a rename.
const HOOK_CONFIGS = CLI_CONFIG_PATHS;

// ---------------------------------------------------------------------------
// 1. Skill exposure links resolve to the canonical skills folder
// ---------------------------------------------------------------------------

// Run the same self-heal the CLI runs on every invocation, so this test is
// meaningful on a fresh clone (the links are git-ignored, hence absent).
ensureSkillLinks(repoRoot);

const canonicalSkills = realpathSync(join(repoRoot, '.agents', 'skills'));

test('private per-agent store is absent from native discovery and exposure roots', () => {
  for (const value of [...SKILL_TREES, ...EXPOSURE_LINK_RELS]) {
    assert.doesNotMatch(value, /persistent-agent-skills|agent_skill_store/);
  }
  assert.deepEqual(SKILL_TREES, ['.agents/skills', '.sidekicks/skill-offloaded']);
});

for (const [link, cli] of SKILL_LINKS) {
  test(`${link} resolves to .agents/skills (${cli})`, () => {
    const linkPath = join(repoRoot, link);
    assert.ok(
      existsSync(linkPath),
      `${link} is missing even after self-heal — check LINKS in lib/sk-cli/skill-links.mjs`,
    );
    const resolved = realpathSync(linkPath);
    const same = isWindows
      ? resolved.toLowerCase() === canonicalSkills.toLowerCase()
      : resolved === canonicalSkills;
    assert.ok(same, `${link} resolves to ${resolved}, expected ${canonicalSkills}`);
  });
}

// ---------------------------------------------------------------------------
// 2. Exposure links are git-ignored and never tracked
// ---------------------------------------------------------------------------

test('skill exposure links are git-ignored and untracked', (t) => {
  const probe = spawnSync('git', ['--version'], { cwd: repoRoot });
  if (probe.status !== 0) {
    t.skip('git unavailable');
    return;
  }

  for (const [link] of SKILL_LINKS) {
    const ignored = spawnSync('git', ['check-ignore', '-q', link], { cwd: repoRoot });
    assert.equal(
      ignored.status,
      0,
      `${link} is not git-ignored — add it to the exposure-link block in .gitignore`,
    );

    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', link], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    assert.notEqual(
      tracked.status,
      0,
      `${link} is tracked by git — a committed symlink breaks on Windows; git rm --cached it`,
    );
  }
});

test('the canonical skills tree is tracked, and is not a link', (t) => {
  const probe = spawnSync('git', ['--version'], { cwd: repoRoot });
  if (probe.status !== 0) {
    t.skip('git unavailable');
    return;
  }

  // The exact inverse of the exposure-link expectations above, and the reason `.agents/skills` is
  // absent from SKILL_LINKS. If it ever became ignored, a fresh clone would carry no skills at all
  // while every CLI still resolved its link into the empty space where they used to be.
  const ignored = spawnSync('git', ['check-ignore', '-q', '.agents/skills'], { cwd: repoRoot });
  assert.notEqual(
    ignored.status,
    0,
    '.agents/skills is git-ignored — it is the canonical tree, not an exposure link. Remove it '
    + 'from .gitignore, and never add an `.agents/*` pattern (that would also swallow .agents/plugins).',
  );

  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '.agents/skills'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  assert.equal(tracked.status, 0, '.agents/skills has no tracked files — the skills tree is missing');

  assert.ok(
    statSync(join(repoRoot, '.agents', 'skills')).isDirectory()
      && !lstatSync(join(repoRoot, '.agents', 'skills')).isSymbolicLink(),
    '.agents/skills is a link — the canonical tree must be a real directory',
  );
});

// ---------------------------------------------------------------------------
// 3. Every hook script referenced by any CLI config exists
// ---------------------------------------------------------------------------

for (const config of HOOK_CONFIGS) {
  test(`${config}: every referenced hook script exists`, () => {
    const configPath = join(repoRoot, config);
    assert.ok(existsSync(configPath), `${config} is missing — that CLI lost its hook wiring`);

    const text = readFileSync(configPath, 'utf8');
    // Matches repo-relative script references in both JSON and TOML command
    // strings: scripts/foo-hook.mjs, .sidekicks/hooks/rtk-hook.mjs, ...
    const refs = text.match(/(?:scripts|\.sidekicks\/hooks)\/[\w.-]+\.(?:mjs|sh|py)/g) ?? [];
    assert.ok(refs.length > 0, `${config} references no hook scripts — wiring looks gutted`);

    for (const ref of new Set(refs)) {
      assert.ok(
        existsSync(join(repoRoot, ...ref.split('/'))),
        `${config} references '${ref}' which does not exist — rename/move must update every CLI config`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// 4. Universal hooks are wired in EVERY CLI config
// ---------------------------------------------------------------------------
// Section 3 only proves that whatever a config references exists — it cannot
// catch a config that omits a hook entirely. These hooks have no CLI-specific
// dependency (they read repo state and never touch a CLI-private surface), so
// per Rule 6 every CLI config must wire them (on that CLI's nearest event).
// Extend this list when a new universally-portable hook lands; hooks that are
// deliberately per-CLI (skill-advisor, enforce-local-memory, ...) stay out and
// document their omission in the config itself.
const UNIVERSAL_HOOKS = LOGICAL_HOOKS
  .filter((hook) => Object.keys(hook.omit).length === 0)
  .map((hook) => hook.path);

// A universal hook whose SCRIPT did not travel is not a parity violation. `scripts/` travels by
// ownership (AAP-111) and `pruneHookWiring` then strips the wiring for anything held back, so a
// trimmed framework core legitimately carries none of these four — none is owned by the six skills
// the `core` preset ships. Asserting the source repo's full set here would fail every forged core
// for doing exactly what it was told to do. The parity property that still holds, and is the one
// this section is about, is that every CLI agrees: a hook present in this tree is wired everywhere,
// and one absent from it is wired nowhere (INC-2026-09-04-02, N-3).
const shippedUniversalHooks = () =>
  UNIVERSAL_HOOKS.filter((h) => existsSync(join(repoRoot, h)));

for (const config of HOOK_CONFIGS) {
  test(`${config}: wires every universal hook this tree carries`, () => {
    const text = readFileSync(join(repoRoot, config), 'utf8');
    for (const hook of shippedUniversalHooks()) {
      assert.ok(
        text.includes(hook),
        `${config} does not wire '${hook}' — a universal hook must be ported to every CLI config in the same change (Rule 6)`,
      );
    }
  });
}

test('a universal hook that did not travel is wired by NO cli config', () => {
  // The other half, and the one that catches a real defect: wiring that outlives its script is a
  // hook that silently never runs, which is the failure `wiring present` in core doctor exists for.
  const absent = UNIVERSAL_HOOKS.filter((h) => !existsSync(join(repoRoot, h)));
  for (const hook of absent) {
    for (const config of HOOK_CONFIGS) {
      const text = readFileSync(join(repoRoot, config), 'utf8');
      assert.ok(
        !text.includes(hook),
        `${config} wires '${hook}', which is not in this tree — the wiring outlived the script, so `
        + 'the hook silently never runs',
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 4b. Every logical hook is ported to each CLI — or declared omitted
// ---------------------------------------------------------------------------
// The manifest is canonical. No host config serves as another host's baseline.
for (const [host, surface] of Object.entries(CLI_SURFACES)) {
  test(`${surface.config}: follows the neutral logical-hook manifest (${host})`, () => {
    const text = readFileSync(join(repoRoot, surface.config), 'utf8');
    const mismatches = [];
    const manifestedNames = new Set(LOGICAL_HOOKS.map((hook) => hook.path.split('/').pop()));
    const configured = text.match(/(?:scripts|\.sidekicks\/hooks)\/[\w.-]+\.(?:mjs|sh|py)/g) ?? [];
    for (const ref of new Set(configured)) {
      if (!manifestedNames.has(ref.split('/').pop())) mismatches.push(`unmanifested ${ref}`);
    }
    for (const hook of LOGICAL_HOOKS) {
      const shipped = existsSync(join(repoRoot, ...hook.path.split('/')));
      const wired = text.includes(hook.path.split('/').pop());
      const intentionalOmission = host in hook.omit;
      if (shipped && !intentionalOmission && !wired) mismatches.push(`missing ${hook.path}`);
      if ((!shipped || intentionalOmission) && wired) {
        mismatches.push(
          `unexpected ${hook.path}${intentionalOmission ? ' (declared omitted)' : ' (script absent)'}`,
        );
      }
    }
    assert.deepEqual(
      mismatches,
      [],
      `${surface.config} diverges from lib/framework-lifecycle/cli-surfaces.mjs:\n  ${mismatches.join('\n  ')}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 5. Every neutral subagent has deterministic per-CLI ports
// ---------------------------------------------------------------------------

test('canonical subagent names are portable output slugs', () => {
  assert.equal(validatePortableSubagentName('sk-code-reviewer'), 'sk-code-reviewer');
  for (const invalid of ['foo\\bar', 'CON', 'aux.notes', 'Foo', 'trailing.']) {
    assert.throws(() => validatePortableSubagentName(invalid, 'fixture'), /portable slug|reserved on Windows/);
  }
  const seen = new Map();
  validatePortableSubagentName('same-name', 'first.md', seen);
  assert.throws(
    () => validatePortableSubagentName('same-name', 'second.md', seen),
    /case-insensitive filesystem/,
  );
});

test('the walker skips OS droppings and still reports a real stray file', () => {
  // `.DS_Store` in .agents/subagents/ used to throw out of the middle of the generator, which turned
  // THIS suite red for any macOS developer who had opened the folder in Finder — and since it is
  // colocated under lib/, it travels into a forged core and runs inside the release's mount gate,
  // where a red test blocks skill.doctor, parity and package.clean behind it.
  //
  // Both halves are asserted, because the fix must not become "ignore anything odd": an enumerated
  // noise set still leaves a genuine authoring mistake reportable.
  for (const noise of ['.DS_Store', 'Thumbs.db', 'desktop.ini', '._sk-code-reviewer.md']) {
    assert.equal(isOsNoise(noise), true, `${noise} is OS-generated, not authored`);
  }
  for (const real of ['sk-code-reviewer.md', 'README.md', 'Foo.md', 'notes.txt']) {
    assert.equal(isOsNoise(real), false, `${real} is not OS noise and must still be judged`);
  }

  const fixture = mkdtempSync(join(tmpdir(), 'sk-subagent-noise-'));
  try {
    writeFileSync(join(fixture, '.DS_Store'), 'finder\n');
    writeFileSync(join(fixture, 'sk-real-agent.md'), '# agent\n');
    assert.deepEqual(markdownFiles(fixture), [join(fixture, 'sk-real-agent.md')],
      'the dropping is skipped and the authored definition is still found');

    writeFileSync(join(fixture, 'Not-Portable.md'), '# agent\n');
    assert.throws(() => markdownFiles(fixture), /portable slug/,
      'a real stray must still fail — a walker that shrugs at everything checks nothing');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('canonical subagent walker refuses a symlinked root', {
  skip: process.platform === 'win32' ? 'symlink creation needs Developer Mode or elevation' : false,
}, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'sk-subagent-root-'));
  try {
    const external = join(fixture, 'external');
    mkdirSync(external);
    const linkedRoot = join(fixture, 'subagents');
    symlinkSync(external, linkedRoot, 'dir');
    assert.throws(() => markdownFiles(linkedRoot), /root must not be a symlink/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function canonicalAgents() {
  const definitions = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (entry.endsWith('.md') && entry !== 'README.md') {
        const text = readFileSync(p, 'utf8');
        const name = text.match(/^name:\s*(\S+)/m)?.[1];
        const tier = text.match(/^model_tier:\s*(\S+)/m)?.[1];
        if (name) definitions.push({ name, tier, path: p, text });
      }
    }
  };
  walk(join(repoRoot, ...CANONICAL_SUBAGENT_ROOT.split('/')));
  return definitions;
}

test('canonical subagents use only neutral model tiers and instruction references', () => {
  const definitions = canonicalAgents();
  assert.ok(definitions.length > 0, 'no canonical agents found under .agents/subagents');

  const offenders = [];
  for (const definition of definitions) {
    const rel = relative(repoRoot, definition.path).split('\\').join('/');
    if (!['top', 'high', 'mid', 'low', 'inherit'].includes(definition.tier)) {
      offenders.push(`${rel}: invalid or missing model_tier '${definition.tier ?? ''}'`);
    }
    if (!/^capabilities:/m.test(definition.text)) offenders.push(`${rel}: missing capabilities`);
    if (/^tools:/m.test(definition.text)) offenders.push(`${rel}: provider tool field`);
    if (/^model:/m.test(definition.text)) offenders.push(`${rel}: provider model field`);
    if (/CLAUDE\.md|\.claude\//.test(definition.text)) offenders.push(`${rel}: provider-specific path`);
  }
  assert.deepEqual(offenders, [], `canonical subagents are not CLI-neutral:\n  ${offenders.join('\n  ')}`);
});

test('every canonical subagent has Claude, Codex, Gemini, and Antigravity ports', () => {
  const definitions = canonicalAgents();

  const missing = [];
  for (const { name, path } of definitions) {
    const claudeRel = relative(join(repoRoot, ...CANONICAL_SUBAGENT_ROOT.split('/')), path);
    if (!existsSync(join(repoRoot, '.claude', 'agents', claudeRel))) {
      missing.push(`.claude/agents/${claudeRel.split('\\').join('/')}`);
    }
    if (!existsSync(join(repoRoot, '.codex', 'agents', `${name}.toml`))) {
      missing.push(`.codex/agents/${name}.toml`);
    }
    if (!existsSync(join(repoRoot, '.gemini', 'agents', `${name}.md`))) {
      missing.push(`.gemini/agents/${name}.md`);
    }
    if (
      !existsSync(
        join(repoRoot, '.agents', 'plugins', 'sidekicks-agents', 'agents', name, 'agent.json'),
      )
    ) {
      missing.push(`.agents/plugins/sidekicks-agents/agents/${name}/agent.json`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `subagent ports missing — run node scripts/generate-subagent-ports.mjs:\n  ${missing.join('\n  ')}`,
  );
});

test('generated host ports contain no provider-owned extra subagents', () => {
  const expected = canonicalAgents().map(({ name }) => name).sort();
  const claude = [];
  const walkClaude = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walkClaude(path);
      else if (entry.endsWith('.md')) {
        const name = readFileSync(path, 'utf8').match(/^name:\s*(\S+)/m)?.[1];
        if (name) claude.push(name);
      }
    }
  };
  walkClaude(join(repoRoot, '.claude', 'agents'));
  const codex = readdirSync(join(repoRoot, '.codex', 'agents'))
    .filter((name) => name.endsWith('.toml'))
    .map((name) => name.slice(0, -'.toml'.length))
    .sort();
  const gemini = readdirSync(join(repoRoot, '.gemini', 'agents'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort();
  const antigravity = readdirSync(
    join(repoRoot, '.agents', 'plugins', 'sidekicks-agents', 'agents'),
  ).filter((name) => existsSync(
    join(repoRoot, '.agents', 'plugins', 'sidekicks-agents', 'agents', name, 'agent.json'),
  )).sort();

  assert.deepEqual(claude.sort(), expected, 'Claude port has missing or provider-owned agents');
  assert.deepEqual(codex, expected, 'Codex port has missing or provider-owned agents');
  assert.deepEqual(gemini, expected, 'Gemini port has missing or provider-owned agents');
  assert.deepEqual(antigravity, expected, 'Antigravity port has missing or provider-owned agents');
});

test('Gemini ports preserve neutral model-tier intent and use only native tool names', () => {
  const allowed = new Set(Object.values({
    read: 'read_file', search: 'grep_search', glob: 'glob', shell: 'run_shell_command',
    edit: 'replace', write: 'write_file', skills: 'activate_skill',
    web_search: 'google_web_search', web_fetch: 'web_fetch',
  }));
  const offenders = [];
  for (const { name, tier } of canonicalAgents()) {
    const path = join(repoRoot, '.gemini', 'agents', `${name}.md`);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (!text.includes(`Requested model tier: ${tier}.`)) offenders.push(`${name}: tier`);
    for (const tool of [...text.matchAll(/^  - (\S+)$/gm)].map((match) => match[1])) {
      if (!allowed.has(tool)) offenders.push(`${name}: tool ${tool}`);
    }
  }
  assert.deepEqual(offenders, [], `Gemini ports lost neutral intent:\n  ${offenders.join('\n  ')}`);
});

test('Antigravity ports preserve neutral model-tier intent in their prompt', () => {
  const missing = [];
  for (const { name, tier } of canonicalAgents()) {
    const path = join(
      repoRoot,
      '.agents',
      'plugins',
      'sidekicks-agents',
      'agents',
      name,
      'agent.json',
    );
    if (!existsSync(path)) continue;
    const port = JSON.parse(readFileSync(path, 'utf8'));
    const prompt = port.config?.customAgent?.systemPromptSections?.[0]?.content ?? '';
    if (!prompt.includes(`Requested model tier: ${tier}.`)) missing.push(name);
  }
  assert.deepEqual(
    missing,
    [],
    `Antigravity ports lost model-tier intent:\n  ${missing.join('\n  ')}`,
  );
});

test('generated subagent ports match their neutral definitions', (t) => {
  const generator = join(repoRoot, 'scripts', 'generate-subagent-ports.mjs');
  if (!existsSync(generator)) {
    t.skip('generator not included in this trimmed framework core');
    return;
  }
  const check = spawnSync(process.execPath, [generator, '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(
    check.status,
    0,
    `generated subagent ports drifted from .agents/subagents:\n${check.stderr || check.stdout}`,
  );
});

test('every Codex TOML port has parseable quoted values (an unescaped quote silently drops the agent)', () => {
  // Existence is not enough. A basic (double-quoted) TOML string containing an
  // unescaped `"` makes codex REFUSE that whole role — it logs
  //   Ignoring malformed agent role definition: … TOML parse error at line N
  // and carries on, so the agent just silently does not exist for Codex while
  // the file sits there looking correct. Found live on sk-fable-researcher and
  // sk-feasibility-investigator, whose descriptions quote phrases inline.
  const offenders = [];
  for (const { name } of canonicalAgents()) {
    const file = join(repoRoot, '.codex', 'agents', `${name}.toml`);
    if (!existsSync(file)) continue; // the test above owns that failure
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const m = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*"(.*)"\s*$/.exec(line);
      if (!m) return;
      // Any `"` inside the value that is not preceded by a backslash.
      if (/(^|[^\\])"/.test(m[1])) {
        offenders.push(`.codex/agents/${name}.toml:${i + 1}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `unescaped double quote inside a TOML string — escape it as \\" or codex drops the agent:\n  ${offenders.join('\n  ')}`,
  );
});

const TOML_PARSE_SCRIPT = [
  'import pathlib,sys',
  'try:',
  '    import tomllib',
  'except ModuleNotFoundError:',
  '    import tomli as tomllib',
  'for p in sys.argv[1:]: tomllib.loads(pathlib.Path(p).read_text(encoding="utf-8"))',
].join('\n');

function repoPython() {
  let python = process.platform === 'win32'
    ? join(repoRoot, '.venv', 'Scripts', 'python.exe')
    : join(repoRoot, '.venv', 'bin', 'python');
  if (!existsSync(python)) {
    python = process.platform === 'win32'
      ? join(process.cwd(), '.venv', 'Scripts', 'python.exe')
      : join(process.cwd(), '.venv', 'bin', 'python');
  }
  return python;
}

test('every generated Codex port parses as TOML with the repo-root Python', (t) => {
  const python = repoPython();
  if (!existsSync(python)) {
    t.skip('repo-root .venv is not present in this trimmed framework core');
    return;
  }
  const files = canonicalAgents().map(({ name }) => join(repoRoot, '.codex', 'agents', `${name}.toml`));
  const parsed = spawnSync(python, [
    '-c',
    TOML_PARSE_SCRIPT,
    ...files,
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
});

test('Codex TOML validation falls back to tomli when tomllib is unavailable', (t) => {
  const python = repoPython();
  if (!existsSync(python)) {
    t.skip('repo-root .venv is not present in this trimmed framework core');
    return;
  }
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sidekicks-tomli-fallback-'));
  try {
    writeFileSync(join(fixtureDir, 'tomllib.py'), 'raise ModuleNotFoundError("forced missing tomllib")\n');
    writeFileSync(join(fixtureDir, 'tomli.py'), 'def loads(value):\n    assert value\n    return {}\n');
    const fixture = join(fixtureDir, 'agent.toml');
    writeFileSync(fixture, 'name = "fixture"\n');
    const pythonPath = process.env.PYTHONPATH
      ? `${fixtureDir}${delimiter}${process.env.PYTHONPATH}`
      : fixtureDir;
    const parsed = spawnSync(python, ['-c', TOML_PARSE_SCRIPT, fixture], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: pythonPath },
    });
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('Codex rendering keeps triple quotes and newlines inside one TOML value', () => {
  const definition = parseDefinition([
    '---',
    'name: sk-injection-fixture',
    'description: Injection fixture',
    'capabilities: read',
    'model_tier: high',
    '---',
    "Body closes ''' then tries to add a key:\nowned = true",
  ].join('\n'), 'fixture.md');
  const rendered = renderCodex(definition, '.agents/subagents/fixture.md');
  assert.equal((rendered.match(/^developer_instructions\s*=/gm) || []).length, 1);
  assert.equal((rendered.match(/^owned\s*=/gm) || []).length, 0);
  assert.match(rendered, /\\nowned = true/);
});
