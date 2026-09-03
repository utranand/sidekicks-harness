// lib/catalog-lifecycle/tests/catalog.test.mjs
//
// Colocated under lib/ on purpose: `lib/` is copied WHOLE into a forged core, while `tests/` is not
// part of the forged surface at all. A contract suite the framework must be able to run about
// ITSELF has to travel with the framework — the `tests.contract` gate could not run in a mounted
// workspace while these files lived under tests/ (INC-2026-09-04-01, F-3). scripts/run-tests.mjs
// already discovers lib/<x>/tests, which is what a trimmed framework core ships.
// Contract tests for `sidekicks catalog show|rebuild|check`.
//
// Uses ONLY node:test + node:assert/strict + node:child_process + node:fs + node:path + node:os +
// node:url + node:crypto — the same stdlib-only shape as every other suite here.
//
// TWO KINDS OF TEST, ON PURPOSE.
//   * Against THIS repo, for the facts that must hold about the real declarations: the generated
//     files are current, the two JSON copies are byte-identical, rebuilding twice changes nothing,
//     nothing in the output carries a timestamp or a machine-absolute path.
//   * Against a FIXTURE repo — a temp directory carrying a real copy of `lib` and `bin` plus a
//     minimal `.sidekicks`/`.agents/skills` — for the failure modes. Each drift case has to be
//     PROVEN to fail, and none of them can be provoked in a healthy repo without breaking it.
//
// Both flag forms are covered deliberately. The dispatcher's global parseArgs runs with
// `strict: false` and declares only --help/--version/--verbose, so `--section cli` arrives as
// `{ section: true }` plus a positional, while `--section=cli` arrives as `{ section: 'cli' }`. A
// verb that reads only `flags` silently ignores the space form; a test for one form would not notice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync,
} from 'node:fs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const bin = join(repoRoot, 'bin', 'sidekicks');

const DOCS_JSON = join('docs', 'generated', 'framework-catalog.json');
const DOCS_MD = join('docs', 'generated', 'framework-catalog.md');
const SNAPSHOT = join('lib', 'catalog-lifecycle', 'framework-catalog.generated.json');

// This suite now travels INSIDE a forged core (`lib/` is copied whole), which is what lets the
// `tests.contract` gate run in a mounted workspace at all. A core is not the source repo: it has no
// `docs/`, and none of the source-repo config the fixture builder copies. Those cases are ABOUT the
// source repo, so they are skipped where there is no source repo to be about — while every
// mount-shaped case below still runs, which is the coverage that matters in a core.
const SOURCE_TREE = existsSync(join(repoRoot, 'docs'))
  && existsSync(join(repoRoot, '.sidekicks', 'config', 'cli-executors.json'));

/** Run the real CLI in a given root. */
function cli(cwd, args) {
  const r = spawnSync(process.execPath, [join(cwd, 'bin', 'sidekicks'), ...args], {
    cwd, encoding: 'utf8',
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Run the CLI in THIS repo. */
function sk(args) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** LF-normalized sha256 of a file, so a CRLF checkout compares equal. */
function digest(path) {
  const text = readFileSync(path, 'utf8').split('\r\n').join('\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A minimal but REAL Sidekicks repo in a temp directory: the actual `lib` and `bin` (so dispatch,
 * the framework registry, the config store and the packager all behave exactly as they do here),
 * plus the smallest `.sidekicks` / `.agents/skills` / `docs` that `catalog` and `package create`
 * require. `docs/` exists so the fixture is in SOURCE mode; a package built from it has none, which
 * is what puts the packaged branch of `catalog check` under test.
 */
function makeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sk-catalog-')));
  cpSync(join(repoRoot, 'lib'), join(root, 'lib'), { recursive: true });
  cpSync(join(repoRoot, 'bin'), join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, '.sidekicks', 'config', 'settings'), { recursive: true });
  mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  cpSync(
    join(repoRoot, '.sidekicks', 'config', 'cli-executors.json'),
    join(root, '.sidekicks', 'config', 'cli-executors.json'),
  );
  writeFileSync(join(root, '.sidekicks', 'RULES.md'), '# fixture rules\n');
  writeFileSync(join(root, 'AGENTS.md'), '# fixture\n');
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: 'sk-catalog-fixture', version: '0.0.0', private: true, type: 'module',
      engines: { node: '>=20' },
    }, null, 2)}\n`,
  );
  addSkill(root, 'fx-base');
  return root;
}

/** Add a skill to a fixture. `siblings` rows become its manifest's declared sibling edges. */
function addSkill(root, name, siblings = [], opts = {}) {
  const tree = opts.parked
    ? join(root, '.sidekicks', 'skill-offloaded')
    : join(root, '.agents', 'skills');
  const dir = join(tree, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: catalog fixture skill\n---\n\nFixture body.\n`,
  );
  if (siblings.length) {
    const lines = ['schema: 1', `skill: ${name}`, '', 'requires:', '  sibling_skills:'];
    for (const s of siblings) {
      lines.push(`    - skill: ${s.skill}`);
      lines.push(`      how: ${s.how}`);
      if (s.optional) lines.push('      optional: true');
      lines.push(`      degraded: 'fixture edge, nothing real breaks'`);
    }
    writeFileSync(join(dir, 'skill.manifest.yaml'), `${lines.join('\n')}\n`);
  }
  return dir;
}

/** Rebuild, then run check, returning the parsed --json payload. */
function checkJson(root) {
  const r = cli(root, ['catalog', 'check', '--json']);
  return { status: r.status, payload: JSON.parse(r.stdout), stderr: r.stderr };
}

function codes(payload) {
  return [...new Set(payload.findings.map((f) => f.code))].sort();
}

// ---------------------------------------------------------------------------
// show — human and JSON
// ---------------------------------------------------------------------------

test('catalog show renders the human catalog with every section', () => {
  const { status, stdout, stderr } = sk(['catalog', 'show']);
  assert.equal(status, 0, `expected exit 0, got ${status}\nstderr: ${stderr}`);
  assert.match(stdout, /^# Sidekicks framework catalog/, 'must open with the document title');
  for (const heading of [
    '## Summary', '## CLI commands', '## Framework entries', '## Skills',
    '## Config blocks', '## Executors', '## Durable formats',
  ]) {
    assert.ok(stdout.includes(heading), `human output must contain '${heading}'`);
  }
});

test('catalog show --json is versioned, section-complete, and parses', () => {
  const { status, stdout } = sk(['catalog', 'show', '--json']);
  assert.equal(status, 0);
  const model = JSON.parse(stdout);
  assert.equal(model.schema_version, 1, 'the JSON contract is versioned');
  for (const section of ['cli', 'framework', 'skills', 'config', 'executors', 'durable_formats']) {
    assert.ok(Object.prototype.hasOwnProperty.call(model, section), `missing section '${section}'`);
  }
  // Counts are DERIVED, never restated: each declared count must equal its own array length.
  assert.equal(model.cli.command_count, model.cli.commands.length);
  assert.equal(model.cli.namespace_count, model.cli.namespaces.length);
  assert.equal(model.framework.entry_count, model.framework.entries.length);
  assert.equal(model.config.block_count, model.config.blocks.length);
  assert.equal(model.executors.executor_count, model.executors.executors.length);
  assert.equal(model.durable_formats.format_count, model.durable_formats.formats.length);
  assert.equal(model.skills.active_count, model.skills.active.length);
  assert.equal(model.skills.parked_count, model.skills.parked.length);
});

test('every catalog array is sorted by id, by code point', () => {
  const model = JSON.parse(sk(['catalog', 'show', '--json']).stdout);
  const arrays = [
    ['cli.commands', model.cli.commands.map((r) => r.id)],
    ['framework.entries', model.framework.entries.map((r) => r.id)],
    ['skills.active', model.skills.active.map((r) => r.id)],
    ['skills.parked', model.skills.parked.map((r) => r.id)],
    ['config.blocks', model.config.blocks.map((r) => r.id)],
    ['executors.executors', model.executors.executors.map((r) => r.id)],
    ['durable_formats.formats', model.durable_formats.formats.map((r) => r.id)],
  ];
  for (const [label, ids] of arrays) {
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(ids, sorted, `${label} must be sorted by id`);
    assert.equal(new Set(ids).size, ids.length, `${label} must carry no duplicate id`);
  }
});

test('the ids use their declared stable forms', () => {
  const model = JSON.parse(sk(['catalog', 'show', '--json']).stdout);
  for (const c of model.cli.commands) {
    assert.equal(c.id, `cli:${c.namespace}/${c.verb}`);
  }
  for (const b of model.config.blocks) assert.equal(b.id, `config:${b.block}`);
  for (const e of model.executors.executors) assert.equal(e.id, `executor:${e.name}`);
  for (const f of model.durable_formats.formats) assert.equal(f.id, `format:${f.format}`);
  for (const s of [...model.skills.active, ...model.skills.parked]) {
    assert.equal(s.id, s.logical_id ? s.logical_id : `skill:${s.folder}`);
  }
});

test('the generated model carries no timestamp and no machine-absolute path', () => {
  const text = sk(['catalog', 'show', '--json']).stdout;
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'no ISO timestamp may enter the catalog');
  assert.ok(!text.includes(repoRoot.replace(/[/\\]$/, '')), 'the repo root must never be persisted');
  assert.doesNotMatch(text, /"[A-Za-z]:\\\\/, 'no Windows absolute path may be persisted');
  assert.doesNotMatch(text, /"\/(Users|home|private|var)\//, 'no POSIX absolute path may be persisted');
  // Every path field is POSIX, so a native backslash separator never reaches the file either.
  const model = JSON.parse(text);
  for (const e of model.framework.entries) {
    for (const v of [e.body_at, e.script]) {
      if (v) assert.ok(!v.includes('\\'), `path '${v}' must use POSIX separators`);
    }
  }
  for (const s of [...model.skills.active, ...model.skills.parked]) {
    assert.ok(!s.tree.includes('\\'), `tree '${s.tree}' must use POSIX separators`);
  }
});

// ---------------------------------------------------------------------------
// show — the two flag forms and the invalid section
// ---------------------------------------------------------------------------

test('--section=cli, --section cli and the bare positional all select the same section', () => {
  const eq = sk(['catalog', 'show', '--section=cli']);
  const space = sk(['catalog', 'show', '--section', 'cli']);
  const bare = sk(['catalog', 'show', 'cli']);
  for (const [label, r] of [['--section=cli', eq], ['--section cli', space], ['bare', bare]]) {
    assert.equal(r.status, 0, `${label} must exit 0 (stderr: ${r.stderr})`);
    assert.match(r.stdout, /^## CLI commands/, `${label} must render only the CLI section`);
    assert.ok(!r.stdout.includes('## Durable formats'), `${label} must not render other sections`);
  }
  assert.equal(space.stdout, eq.stdout, 'the space form must equal the equals form');
  assert.equal(bare.stdout, eq.stdout, 'the bare positional must equal the equals form');
});

test('--section with --json returns only that section, still versioned', () => {
  for (const args of [['--section=framework', '--json'], ['--section', 'framework', '--json']]) {
    const r = sk(['catalog', 'show', ...args]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.schema_version, 1);
    assert.equal(payload.section, 'framework');
    assert.ok(payload.framework.entries.length > 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'cli'), 'no other section may ride along');
  }
});

test('durable-formats is accepted in both the dashed and underscored spelling', () => {
  const dashed = sk(['catalog', 'show', '--section=durable-formats']);
  const under = sk(['catalog', 'show', '--section=durable_formats']);
  assert.equal(dashed.status, 0, dashed.stderr);
  assert.equal(under.status, 0, under.stderr);
  assert.equal(dashed.stdout, under.stdout);
  assert.match(dashed.stdout, /^## Durable formats/);
});

test('an invalid section name is a usage error naming the valid set — in both flag forms', () => {
  for (const args of [['--section=nope'], ['--section', 'nope']]) {
    const r = sk(['catalog', 'show', ...args]);
    assert.equal(r.status, 1, `expected EXIT_USAGE (1), got ${r.status}`);
    assert.match(r.stderr, /unknown section 'nope'/);
    assert.match(r.stderr, /valid sections: cli, framework, skills, config, executors/);
    assert.equal(r.stdout, '', 'a usage error writes nothing to stdout');
  }
});

// ---------------------------------------------------------------------------
// this repo: check is green, the two JSON copies agree, rebuild is idempotent
// ---------------------------------------------------------------------------

test('catalog check passes on this repo', () => {
  const human = sk(['catalog', 'check']);
  assert.equal(human.status, 0, `catalog check must be green here\n${human.stdout}${human.stderr}`);
  assert.match(human.stdout, /^catalog check: OK/);

  const r = sk(['catalog', 'check', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.schema_version, 1);
  assert.match(payload.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(payload.findings, [], 'a green repo produces no findings');
});

test('the docs JSON and the packaged lib snapshot are byte-identical', { skip: !SOURCE_TREE }, () => {
  const docs = readFileSync(join(repoRoot, DOCS_JSON), 'utf8');
  const snapshot = readFileSync(join(repoRoot, SNAPSHOT), 'utf8');
  assert.equal(snapshot, docs, 'the snapshot that travels in a package must be the docs JSON exactly');
  assert.ok(docs.endsWith('}\n'), 'the JSON must end with a terminal newline');
  assert.ok(docs.includes('\n  "schema_version": 1'), 'two-space indentation');
});

test('catalog rebuild is idempotent: running it twice leaves the bytes unchanged', { skip: !SOURCE_TREE }, () => {
  const paths = [DOCS_JSON, DOCS_MD, SNAPSHOT].map((rel) => join(repoRoot, rel));
  const before = paths.map(digest);

  const first = sk(['catalog', 'rebuild']);
  assert.equal(first.status, 0, first.stderr);
  const mid = paths.map(digest);

  const second = sk(['catalog', 'rebuild']);
  assert.equal(second.status, 0, second.stderr);
  const after = paths.map(digest);

  assert.deepEqual(mid, before, 'rebuilding a current catalog must not change a byte');
  assert.deepEqual(after, mid, 'a second rebuild must not change a byte either');
  assert.match(second.stdout, /written:\s+\(nothing\)/, 'the second run reports nothing written');
});

test('catalog rebuild --dry-run writes nothing and still reports the fingerprint', { skip: !SOURCE_TREE }, () => {
  const paths = [DOCS_JSON, DOCS_MD, SNAPSHOT].map((rel) => join(repoRoot, rel));
  const before = paths.map(digest);
  const r = sk(['catalog', 'rebuild', '--dry-run', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.dry_run, true);
  assert.match(payload.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(paths.map(digest), before, '--dry-run must not touch a file');
});

// ---------------------------------------------------------------------------
// fixture: the drift and graph failures
// ---------------------------------------------------------------------------

test('a fixture repo rebuilds and checks green before anything is broken', { skip: !SOURCE_TREE }, () => {
  const root = makeFixture();
  try {
    const rebuild = cli(root, ['catalog', 'rebuild']);
    assert.equal(rebuild.status, 0, rebuild.stderr);
    for (const rel of [DOCS_JSON, DOCS_MD, SNAPSHOT]) {
      assert.ok(existsSync(join(root, rel)), `${rel} must be written`);
    }
    assert.equal(
      readFileSync(join(root, SNAPSHOT), 'utf8'),
      readFileSync(join(root, DOCS_JSON), 'utf8'),
      'the two JSON copies must be byte-identical in any tree',
    );
    const { status, payload } = checkJson(root);
    assert.equal(status, 0, `fixture must start green: ${JSON.stringify(payload.findings)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stale generated file fails catalog check', { skip: !SOURCE_TREE }, () => {
  const root = makeFixture();
  try {
    assert.equal(cli(root, ['catalog', 'rebuild']).status, 0);

    // Tamper with the docs JSON only: one changed count is enough, and it proves the comparison is
    // against the live declarations rather than against the sibling copy.
    const jsonPath = join(root, DOCS_JSON);
    const tampered = readFileSync(jsonPath, 'utf8').replace('"schema_version": 1', '"schema_version": 1, "tampered": true');
    writeFileSync(jsonPath, tampered);

    const { status, payload } = checkJson(root);
    assert.equal(status, 2, 'stale generated output is a validation failure');
    assert.equal(payload.ok, false);
    assert.ok(codes(payload).includes('stale-generated'), JSON.stringify(codes(payload)));
    assert.ok(
      payload.findings.some((f) => f.code === 'stale-generated' && f.subject.endsWith('framework-catalog.json')),
      'the finding must name the file that went stale',
    );

    // And a rebuild is the documented fix.
    assert.equal(cli(root, ['catalog', 'rebuild']).status, 0);
    assert.equal(checkJson(root).status, 0, 'rebuild must clear the drift');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stale human document fails catalog check too', { skip: !SOURCE_TREE }, () => {
  const root = makeFixture();
  try {
    assert.equal(cli(root, ['catalog', 'rebuild']).status, 0);
    writeFileSync(join(root, DOCS_MD), '# not the catalog\n');
    const { status, payload } = checkJson(root);
    assert.equal(status, 2);
    assert.ok(
      payload.findings.some((f) => f.code === 'stale-generated' && f.subject.endsWith('framework-catalog.md')),
      JSON.stringify(payload.findings.map((f) => [f.code, f.subject])),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing generated file fails catalog check', { skip: !SOURCE_TREE }, () => {
  const root = makeFixture();
  try {
    assert.equal(cli(root, ['catalog', 'rebuild']).status, 0);
    rmSync(join(root, SNAPSHOT));
    const { status, payload } = checkJson(root);
    assert.equal(status, 2);
    assert.ok(codes(payload).includes('missing-generated'), JSON.stringify(codes(payload)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an orphaned hard dependency fails catalog check', { skip: !SOURCE_TREE }, () => {
  const root = makeFixture();
  try {
    addSkill(root, 'fx-orphan', [{ skill: 'fx-ghost', how: 'subprocess' }]);
    assert.equal(cli(root, ['catalog', 'rebuild']).status, 0);
    const { status, payload } = checkJson(root);
    assert.equal(status, 2);
    assert.ok(codes(payload).includes('missing-target'), JSON.stringify(codes(payload)));
    const finding = payload.findings.find((f) => f.code === 'missing-target');
    assert.match(finding.message, /fx-ghost/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an OPTIONAL dependency on an absent skill is informational, not a failure', { skip: !SOURCE_TREE }, () => {
  const root = makeFixture();
  try {
    addSkill(root, 'fx-soft', [{ skill: 'fx-ghost', how: 'subprocess', optional: true }]);
    assert.equal(cli(root, ['catalog', 'rebuild']).status, 0);
    const { status, payload } = checkJson(root);
    assert.equal(status, 0, `optional absence must not fail: ${JSON.stringify(payload.findings)}`);
    const model = JSON.parse(cli(root, ['catalog', 'show', '--json']).stdout);
    const row = model.skills.active.find((s) => s.folder === 'fx-soft');
    assert.deepEqual(row.informational_refs, ['fx-ghost']);
    assert.deepEqual(row.hard_depends_on, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a duplicate skill id fails catalog check', { skip: !SOURCE_TREE }, () => {
  const root = makeFixture();
  try {
    // The same folder name in the active tree AND the offloaded tree — a half-finished offload.
    addSkill(root, 'fx-twin');
    addSkill(root, 'fx-twin', [], { parked: true });
    assert.equal(cli(root, ['catalog', 'rebuild']).status, 0);
    const { status, payload } = checkJson(root);
    assert.equal(status, 2);
    assert.ok(codes(payload).includes('duplicate-id'), JSON.stringify(codes(payload)));
    assert.ok(payload.findings.some((f) => f.code === 'duplicate-id' && f.subject.includes('fx-twin')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an in-process import cycle between active skills fails catalog check', { skip: !SOURCE_TREE }, () => {
  const root = makeFixture();
  try {
    addSkill(root, 'fx-cyc-a', [{ skill: 'fx-cyc-b', how: 'import' }]);
    addSkill(root, 'fx-cyc-b', [{ skill: 'fx-cyc-a', how: 'import' }]);
    assert.equal(cli(root, ['catalog', 'rebuild']).status, 0);
    const { status, payload } = checkJson(root);
    assert.equal(status, 2);
    assert.ok(codes(payload).includes('dependency-cycle'), JSON.stringify(codes(payload)));
    const finding = payload.findings.find((f) => f.code === 'dependency-cycle');
    assert.match(finding.message, /fx-cyc-a/);
    assert.match(finding.message, /fx-cyc-b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutual composition across a process boundary is reported, not failed', { skip: !SOURCE_TREE }, () => {
  const root = makeFixture();
  try {
    // Two skills that spawn each other's script. This is a shipped pattern in this repo (a driver
    // skill and its verification skill each name the other), so it must NOT be a gate failure —
    // it appears in the catalog as data instead.
    addSkill(root, 'fx-pair-a', [{ skill: 'fx-pair-b', how: 'subprocess' }]);
    addSkill(root, 'fx-pair-b', [{ skill: 'fx-pair-a', how: 'handoff' }]);
    assert.equal(cli(root, ['catalog', 'rebuild']).status, 0);
    const { status, payload } = checkJson(root);
    assert.equal(status, 0, `subprocess/handoff mutuality must not fail: ${JSON.stringify(payload.findings)}`);
    const model = JSON.parse(cli(root, ['catalog', 'show', '--json']).stdout);
    assert.deepEqual(model.skills.acquisition_cycles, []);
    assert.ok(
      model.skills.mutual_composition.some((c) => c.cycle.includes('fx-pair-a') && c.cycle.includes('fx-pair-b')),
      'the mutual pair must be recorded in the catalog',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a registered verb whose dispatch module is gone is a dangling reference', { skip: !SOURCE_TREE }, () => {
  const root = makeFixture();
  try {
    assert.equal(cli(root, ['catalog', 'rebuild']).status, 0);
    rmSync(join(root, 'lib', 'index-lifecycle', 'get.mjs'));
    const { status, payload } = checkJson(root);
    assert.equal(status, 2);
    assert.ok(codes(payload).includes('dangling-reference'), JSON.stringify(codes(payload)));
    assert.ok(payload.findings.some((f) => f.subject === 'cli:index/get'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// package: the snapshot travels, and validates without docs/
// ---------------------------------------------------------------------------

test('a clean package carries the lib snapshot and passes catalog check without docs/', { skip: !SOURCE_TREE }, () => {
  const root = makeFixture();
  const outParent = realpathSync(mkdtempSync(join(tmpdir(), 'sk-catalog-pkg-')));
  const out = join(outParent, 'runtime');
  try {
    assert.equal(cli(root, ['catalog', 'rebuild']).status, 0);

    const created = cli(root, [
      'package', 'create', '--output', out,
      '--include-claude=false', '--include-gemini=false', '--include-agent=false',
    ]);
    assert.equal(created.status, 0, `package create failed:\n${created.stdout}${created.stderr}`);

    // docs/ is excluded on purpose (lib/package-lifecycle/plan.mjs FIXED_EXCLUDES) — which is the
    // whole reason the snapshot lives under lib/ and needs no packager exception.
    assert.ok(!existsSync(join(out, 'docs')), 'an assembled package ships no docs/');
    const packaged = join(out, SNAPSHOT);
    assert.ok(existsSync(packaged), 'the lib snapshot must travel into the package');
    assert.equal(
      readFileSync(packaged, 'utf8'),
      readFileSync(join(root, SNAPSHOT), 'utf8'),
      'the packaged snapshot must be byte-identical to the source snapshot',
    );

    const check = cli(out, ['catalog', 'check', '--json']);
    assert.equal(check.status, 0, `packaged catalog check failed:\n${check.stdout}${check.stderr}`);
    const payload = JSON.parse(check.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.counts.source_tree, false, 'the package must take the packaged branch');

    // And the packaged branch must actually BITE: corrupt the travelled snapshot and it fails.
    writeFileSync(packaged, readFileSync(packaged, 'utf8').replace('"schema_version": 1', '"schema_version": 1, "tampered": true'));
    const broken = cli(out, ['catalog', 'check', '--json']);
    assert.equal(broken.status, 2, 'a tampered packaged snapshot must fail');
    assert.ok(codes(JSON.parse(broken.stdout)).includes('snapshot-drift'), broken.stdout.slice(0, 400));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outParent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// the module surface itself
// ---------------------------------------------------------------------------

test('the catalog verbs are registered in the VERBS table with dispatchable modules', async () => {
  const { VERBS, NAMESPACES } = await import('../../sk-cli/help.mjs');
  const rows = VERBS.filter((v) => v.namespace === 'catalog');
  assert.deepEqual(rows.map((v) => v.verb).sort(), ['check', 'rebuild', 'show']);
  for (const row of rows) {
    assert.equal(row.status, 'implemented');
    assert.ok(row.summary && row.summary.length > 10, 'every verb row needs a real summary');
    const mod = await import(`../${row.verb}.mjs`);
    assert.equal(typeof mod.run, 'function', `${row.verb}.mjs must export run(ctx, args)`);
  }
  // Appended at the END of the table, so no PRE-EXISTING namespace's help position moved. The
  // assertion is "after everything that came before it", not "last in the table": `check` was
  // appended after `catalog` for the same reason, and pinning the tail to one name would turn every
  // future append into a failure of this test rather than of the thing it guards.
  const journalAt = NAMESPACES.indexOf('journal');
  const catalogAt = NAMESPACES.indexOf('catalog');
  assert.ok(journalAt >= 0 && catalogAt === journalAt + 1,
    `catalog must sit immediately after the namespaces that predate it, got ${NAMESPACES.join(',')}`);
});

test('serializeCatalog is deterministic and catalogFingerprint tracks it', { skip: !SOURCE_TREE }, async () => {
  const { buildCatalog } = await import('../model.mjs');
  const { serializeCatalog, catalogFingerprint } = await import('../render.mjs');
  const a = serializeCatalog(buildCatalog(repoRoot));
  const b = serializeCatalog(buildCatalog(repoRoot));
  assert.equal(a, b, 'two builds of one tree must serialize identically');
  assert.equal(a, readFileSync(join(repoRoot, DOCS_JSON), 'utf8'), 'the committed file must be current');

  const model = buildCatalog(repoRoot);
  const full = catalogFingerprint(model);
  const withoutExecutors = catalogFingerprint(model, { omitSections: ['executors'] });
  assert.match(full, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(full, withoutExecutors, 'omitting a section must change the fingerprint');
  assert.equal(withoutExecutors, catalogFingerprint(model, { omitSections: ['executors'] }));
});

test('every durable format names an owner, a reader and an existing path', async () => {
  const { DURABLE_FORMATS } = await import('../durable-formats.mjs');
  assert.ok(DURABLE_FORMATS.length > 0);
  const ids = DURABLE_FORMATS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'format ids must be unique');
  for (const f of DURABLE_FORMATS) {
    assert.ok(f.owner, `${f.id} needs an owner`);
    assert.ok(f.path_pattern, `${f.id} needs a path_pattern`);
    assert.ok(f.compatibility && f.compatibility.length > 20, `${f.id} needs a compatibility note`);
    assert.ok(f.schema_version === null || Number.isInteger(f.schema_version));
    for (const rel of [f.owner, f.reader, f.writer]) {
      if (!rel) continue;
      assert.ok(!rel.includes('\\'), `'${rel}' must be POSIX`);
      assert.ok(existsSync(join(repoRoot, ...rel.split('/'))), `${f.id} points at missing '${rel}'`);
    }
  }
});

// ---------------------------------------------------------------------------
// mounted + standalone cores (INC-2026-09-04-01, F-3)
// ---------------------------------------------------------------------------
// `catalog check` resolved every framework path against the workspace root, which is right in a
// source checkout and wrong in every mount: the framework lives at .sidekicks-core/ there. The verb
// reported 159 dispatch modules and a shipped snapshot as missing in a perfectly healthy consumer
// install, and `check run quick` was red in every mounted workspace as a result.
//
// The temptation was to suppress those codes outside a source tree, the way `scope explain` does.
// These tests exist to make that impossible: green in a mount is asserted BESIDE four negatives
// proving the check still bites through the mount.

/**
 * A workspace with a forged-shaped core mounted at .sidekicks-core/, both carrying real lib+bin.
 *
 * Built the way a real core is: the snapshot is generated while the tree still LOOKS like a source
 * repo (that is where the forge runs `catalog rebuild`), and only then does it become a core —
 * docs/ dropped, marker added. Generating it after the conversion would test a tree no forge
 * produces.
 */
function makeMountedFixture() {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'sk-catalog-mount-')));
  const core = join(ws, '.sidekicks-core');

  // ── the core, still source-shaped ──
  cpSync(join(repoRoot, 'lib'), join(core, 'lib'), { recursive: true });
  cpSync(join(repoRoot, 'bin'), join(core, 'bin'), { recursive: true });
  mkdirSync(join(core, '.sidekicks', 'config', 'settings'), { recursive: true });
  mkdirSync(join(core, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(core, 'docs'), { recursive: true });
  writeFileSync(join(core, '.sidekicks', 'RULES.md'), '# core rules\n');
  writeFileSync(join(core, 'AGENTS.md'), '# core\n');
  writeFileSync(
    join(core, 'package.json'),
    `${JSON.stringify({
      name: 'sk-catalog-core-fixture', version: '0.0.0', private: true, type: 'module',
      engines: { node: '>=20' },
    }, null, 2)}\n`,
  );
  addSkill(core, 'fx-base');
  assert.equal(cli(core, ['catalog', 'rebuild']).status, 0, 'the snapshot is built while the tree is still source-shaped');

  // ── now it is a core: no docs/, and a marker ──
  rmSync(join(core, 'docs'), { recursive: true, force: true });
  writeFileSync(
    join(core, '.sidekicks-core.json'),
    `${JSON.stringify({ schema: 1, name: 'fx-core', version: '1.0.0', layout: 1 }, null, 2)}\n`,
  );

  // ── the workspace around it ──
  mkdirSync(join(ws, '.sidekicks', 'config', 'settings'), { recursive: true });
  mkdirSync(join(ws, '.agents', 'skills'), { recursive: true });
  writeFileSync(join(ws, 'AGENTS.md'), '# workspace\n');
  // The skill the workspace sees is the core's. A real directory rather than a link: `core doctor`'s
  // `overlay complete` check permits either.
  cpSync(join(core, '.agents', 'skills', 'fx-base'), join(ws, '.agents', 'skills', 'fx-base'),
    { recursive: true });

  return { ws, core };
}

/** Run the MOUNTED CLI with the workspace as cwd — exactly how a consumer invokes it. */
function mounted(ws, args) {
  const r = spawnSync(process.execPath, [join(ws, '.sidekicks-core', 'bin', 'sidekicks'), ...args], {
    cwd: ws, encoding: 'utf8',
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('catalog check is GREEN in a mounted workspace, and knows it is one', () => {
  const { ws } = makeMountedFixture();
  try {
    const r = mounted(ws, ['catalog', 'check', '--json']);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.counts.tree_kind, 'mounted');
    assert.equal(
      payload.findings.filter((f) => f.code === 'dangling-reference').length,
      0,
      'every lib/ path the catalog names lives in the mount — none of them is dangling',
    );
    assert.equal(
      payload.findings.filter((f) => f.code === 'missing-generated').length,
      0,
      'the snapshot travelled; it is simply under .sidekicks-core/',
    );
    assert.equal(r.status, 0, `a healthy mount must check green: ${JSON.stringify(payload.findings)}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a mounted workspace with its OWN docs/ is not asked for the generated pair', () => {
  // The old proxy was `existsSync('docs')`, and a consumer workspace normally HAS docs/ — so it was
  // classified as the source repo and told to run `catalog rebuild` for files it can never own.
  const { ws } = makeMountedFixture();
  try {
    mkdirSync(join(ws, 'docs'), { recursive: true });
    const payload = JSON.parse(mounted(ws, ['catalog', 'check', '--json']).stdout);
    assert.equal(payload.counts.tree_kind, 'mounted', 'the mount is checked before docs/');
    assert.ok(
      !payload.findings.some((f) => String(f.subject).startsWith('docs/')),
      'a consumer workspace must never be asked for docs/generated/*',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a framework module missing from BOTH roots is still a dangling reference, named where it looked', () => {
  const { ws, core } = makeMountedFixture();
  try {
    // A registered verb whose dispatch module exists nowhere. Resolving through the mount must not
    // become "resolving away": this is the assertion that keeps the fix from being a suppression.
    // Deliberately NOT one of the catalog verbs — deleting the module this very command dispatches
    // to would test the dispatcher, not the check.
    rmSync(join(core, 'lib', 'goal-lifecycle', 'plan.mjs'), { force: true });
    const payload = JSON.parse(mounted(ws, ['catalog', 'check', '--json']).stdout);
    const dangling = payload.findings.filter((f) => f.code === 'dangling-reference');
    assert.equal(dangling.length, 1, `expected exactly one: ${JSON.stringify(dangling)}`);
    assert.match(dangling[0].message, /lib\/goal-lifecycle\/plan\.mjs/);
    assert.match(
      dangling[0].message,
      /exists in neither the workspace nor \.sidekicks-core\//,
      'a finding must say where it looked — a bare path reads as a workspace file',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a snapshot missing from BOTH roots still reports missing-generated, naming both', () => {
  const { ws, core } = makeMountedFixture();
  try {
    rmSync(join(core, SNAPSHOT), { force: true });
    const payload = JSON.parse(mounted(ws, ['catalog', 'check', '--json']).stdout);
    const missing = payload.findings.filter((f) => f.code === 'missing-generated');
    assert.equal(missing.length, 1);
    assert.match(missing[0].message, /exists in neither the workspace nor \.sidekicks-core\//);
    assert.match(missing[0].message, /did not travel/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('code-derived drift inside a core is still caught, though environment sections are not compared', () => {
  const { ws, core } = makeMountedFixture();
  try {
    // durable_formats is code-derived: it must match the shipped snapshot byte for byte. The
    // narrowed compare exists for framework/skills/config/executors, which `core init` re-syncs
    // inside the mount — narrowing it any further would make the check decorative.
    const formats = join(core, 'lib', 'catalog-lifecycle', 'durable-formats.mjs');
    const text = readFileSync(formats, 'utf8');
    writeFileSync(formats, text.replace(/id: '([a-z-]+)'/, "id: 'fx-renamed-format'"));

    const payload = JSON.parse(mounted(ws, ['catalog', 'check', '--json']).stdout);
    assert.ok(
      payload.findings.some((f) => f.code === 'snapshot-drift'),
      `a changed durable format must still be drift: ${JSON.stringify(payload.findings)}`,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

/** A core checkout that is NOT mounted under a workspace — a clone, or the service checkout. */
function makeStandaloneCore() {
  const core = realpathSync(mkdtempSync(join(tmpdir(), 'sk-catalog-core-')));
  cpSync(join(repoRoot, 'lib'), join(core, 'lib'), { recursive: true });
  cpSync(join(repoRoot, 'bin'), join(core, 'bin'), { recursive: true });
  mkdirSync(join(core, '.sidekicks', 'config', 'settings'), { recursive: true });
  mkdirSync(join(core, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(core, 'docs'), { recursive: true });
  writeFileSync(join(core, '.sidekicks', 'RULES.md'), '# core rules\n');
  writeFileSync(join(core, 'AGENTS.md'), '# core\n');
  writeFileSync(
    join(core, 'package.json'),
    `${JSON.stringify({
      name: 'sk-catalog-standalone-fixture', version: '0.0.0', private: true, type: 'module',
      engines: { node: '>=20' },
    }, null, 2)}\n`,
  );
  addSkill(core, 'fx-base');
  assert.equal(cli(core, ['catalog', 'rebuild']).status, 0);
  rmSync(join(core, 'docs'), { recursive: true, force: true });
  writeFileSync(
    join(core, '.sidekicks-core.json'),
    `${JSON.stringify({ schema: 1, name: 'fx-core', version: '1.0.0', layout: 1 }, null, 2)}\n`,
  );
  return core;
}

test('a STANDALONE core checks green — its snapshot speaks for the framework, not the environment', () => {
  // Red before this change, and NOT caused by F-3: the forge builds the snapshot in the SOURCE repo,
  // then `core init` runs `framework sync --prune` inside the core, so the environment-derived
  // sections legitimately differ from the ones it shipped with. Comparing all of them made
  // `catalog check` fail inside every forged core.
  const core = makeStandaloneCore();
  try {
    const payload = JSON.parse(cli(core, ['catalog', 'check', '--json']).stdout);
    assert.equal(payload.counts.tree_kind, 'core');
    assert.equal(payload.findings.length, 0, JSON.stringify(payload.findings));

    // Move an environment-derived section and prove it is tolerated — while the code-derived
    // sections stay under the exact comparison asserted above.
    addSkill(core, 'fx-added-after-the-forge');
    const after = JSON.parse(cli(core, ['catalog', 'check', '--json']).stdout);
    assert.ok(
      !after.findings.some((f) => f.code === 'snapshot-drift'),
      `a skill re-synced after the forge is not drift: ${JSON.stringify(after.findings)}`,
    );
  } finally {
    rmSync(core, { recursive: true, force: true });
  }
});
