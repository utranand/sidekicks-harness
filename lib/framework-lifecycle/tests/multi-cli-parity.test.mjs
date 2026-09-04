// lib/framework-lifecycle/tests/multi-cli-parity.test.mjs
// Enforces Rule 6 — Multi-CLI Parity (.sidekicks/RULES.md): the repo must work
// identically across every supported agent CLI (Claude Code, Codex, Gemini,
// Antigravity). Claude Code is canonical; the other CLIs inherit each shared
// surface via symlinks, self-healed links, or committed ports.
//
// What this suite pins down:
//   1. Skill exposure links — one per CLI — resolve to .agents/skills/
//      (after the same self-heal the CLI runs on every invocation).
//   2. The links are git-ignored and never tracked (a committed symlink checks
//      out as a text stub on Windows and silently breaks skill discovery).
//   3. Every hook script referenced by any CLI's hook config exists on disk.
//   4. Every Claude subagent has its Codex TOML port and its plugin-format port.
//
// The instruction mirror (AGENTS.md / GEMINI.md → CLAUDE.md) is enforced
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
import { existsSync, realpathSync, readFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { ensureSkillLinks } from '../../sk-cli/skill-links.mjs';
import { SKILL_TREES, EXPOSURE_LINK_RELS } from '../../sk-cli/skill-trees.mjs';

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
const HOOK_CONFIGS = [
  '.claude/settings.json',
  '.codex/config.toml',
  '.gemini/settings.json',
  '.agent/settings.json',
];

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
    // strings: scripts/foo-hook.mjs, .sidekicks/hooks/rtk-hook.sh, ...
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
const UNIVERSAL_HOOKS = [
  'scripts/artifact-autotrigger-hook.mjs',
  'scripts/run-notify-hook.mjs',
  'scripts/office-viz-hook.mjs',
  'scripts/artifact-liveness-hook.mjs',
];

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
// 4b. Every Claude-wired hook is ported to each CLI — or documented as omitted
// ---------------------------------------------------------------------------
// Section 4 pins the universal set; this section closes the remaining gap:
// a hook wired in .claude/settings.json (the canonical config) must appear in
// every other CLI config UNLESS that (cli, hook) pair is listed here with a
// reason. This map IS the documented-omission record for configs that cannot
// carry comments (JSON); .codex/config.toml additionally documents its own
// omissions inline. Removing a wired hook from a CLI config without adding an
// entry here is a Rule 6 violation and fails this test.
const DOCUMENTED_OMISSIONS = {
  '.codex/config.toml': {
    'scripts/enforce-local-memory.mjs':
      "guards Claude's own ~/.claude global store, which Codex doesn't use",
    'scripts/skill-advisor-hook.mjs':
      'impossible on Codex — skill activation is an inline read, no tool call fires',
    'scripts/recompile-validation-checklist.mjs':
      'Codex has no post-tool hook event',
  },
  '.gemini/settings.json': {
    'scripts/enforce-local-memory.mjs':
      "guards Claude's own ~/.claude global store, which Gemini doesn't use",
    'scripts/recompile-validation-checklist.mjs':
      'no verified Gemini post-tool event mapping yet',
  },
  '.agent/settings.json': {
    'scripts/enforce-local-memory.mjs':
      "guards Claude's own ~/.claude global store, which Antigravity doesn't use",
    'scripts/skill-advisor-hook.mjs':
      'Antigravity has no tool-call hook events (per CLAUDE.md)',
    '.sidekicks/hooks/rtk-hook.sh': 'Antigravity has no tool-call hook events',
    'scripts/enforce-flow-headful.mjs':
      'Antigravity has no tool-call hook events — flowlib.assert_headful() is the enforcement layer there',
    'scripts/enforce-branch-safety.mjs':
      'Antigravity has no tool-call hook events — the CLAUDE.md protected-branch rule plus the '
      + '`branch switch` / `service checkout` dirty guards in lib/ are the enforcement layer there',
    'scripts/recompile-validation-checklist.mjs': 'Antigravity has no post-tool hook event',
    'scripts/gtd-orphan-watch-hook.mjs':
      'Antigravity has no SessionStart event — orphan queues surface via the next Claude/Codex/Gemini session',
    'scripts/load-local-memory-hook.mjs':
      'Antigravity has no SessionStart event — memory loads by written convention (CLAUDE.md practice 9)',
    'scripts/memory-trigger-hook.mjs':
      'Antigravity has no tool-call hook events — the memory category map names '
      + '`sidekicks memory pack <category>` so the pack is pulled by written instruction there',
  },
};

const claudeHookRefs = () => {
  const text = readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf8');
  return [...new Set(text.match(/(?:scripts|\.sidekicks\/hooks)\/[\w.-]+\.(?:mjs|sh|py)/g) ?? [])];
};

for (const config of HOOK_CONFIGS.filter((c) => c !== '.claude/settings.json')) {
  test(`${config}: ports every Claude-wired hook or documents the omission`, () => {
    const text = readFileSync(join(repoRoot, config), 'utf8');
    const omissions = DOCUMENTED_OMISSIONS[config] ?? {};
    const gaps = [];
    for (const hook of claudeHookRefs()) {
      const name = hook.split('/').pop();
      if (!text.includes(name) && !(hook in omissions)) gaps.push(hook);
    }
    assert.deepEqual(
      gaps,
      [],
      `${config} neither wires nor documents these Claude-wired hooks — port each on the CLI's nearest event, or add a reasoned entry to DOCUMENTED_OMISSIONS (Rule 6):\n  ${gaps.join('\n  ')}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 5. Every Claude subagent has its per-CLI ports
// ---------------------------------------------------------------------------

function claudeAgentNames() {
  const names = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (entry.endsWith('.md')) {
        const m = readFileSync(p, 'utf8').match(/^name:\s*(\S+)/m);
        if (m) names.push(m[1]);
      }
    }
  };
  walk(join(repoRoot, '.claude', 'agents'));
  return names;
}

test('every Claude agent has a Codex TOML port and a plugin-format port', () => {
  const names = claudeAgentNames();
  assert.ok(names.length > 0, 'no Claude agents found under .claude/agents');

  const missing = [];
  for (const name of names) {
    if (!existsSync(join(repoRoot, '.codex', 'agents', `${name}.toml`))) {
      missing.push(`.codex/agents/${name}.toml`);
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
    `subagent ports missing — regenerate them per docs/guide/pending-update/multi-cli-compatibility.md:\n  ${missing.join('\n  ')}`,
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
  for (const name of claudeAgentNames()) {
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
