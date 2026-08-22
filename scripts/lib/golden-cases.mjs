// scripts/lib/golden-cases.mjs
// The curated golden contracts — ONE definition, read by both readers.
//
// WHY THIS FILE EXISTS AND WHY IT IS NOT IN tests/fixtures/golden/.
// Two things consume these cases: the replay suite (tests/golden-contracts.test.mjs, which the
// `golden.replay` gate spawns) and the refresh command (scripts/update-golden-contracts.mjs, which a
// human runs deliberately). If each carried its own list, a case added to one would silently not be
// replayed by the other — a snapshot nobody compares is worse than no snapshot, because it reads as
// coverage. So the list lives here, once.
//
// It is NOT under tests/fixtures/golden/ because the gate counts that directory's non-dot entries to
// decide whether any fixture exists at all. A module sitting there would make the count non-zero
// forever, so "no fixtures yet" could never be detected again. The golden directory holds fixtures
// and nothing else.
//
// WHAT A GOLDEN IS HERE. A curated PRODUCT CONTRACT, not a dump. The plan's locked decision is
// explicit that snapshotting every output "would create churn and hide meaningful review signals",
// and two of these commands prove the point: `catalog show --json` and `scope explain --json` are
// ~100KB documents that change whenever any verb, skill or config block anywhere in the repo
// changes. Snapshotting them whole would mean a fixture diff on nearly every commit, which trains a
// reviewer to refresh without reading — the exact failure this suite exists to prevent. So for those
// two the fixture is the DERIVED CONTRACT: schema version, section names, key ordering, id prefixes,
// counts-as-shape, and the invariants (no timestamp, no absolute path, credentials masked). The
// payload is already gated by `catalog check` and by the Phase 3 tests; what is NOT otherwise gated
// is the SHAPE those documents promise to automation, and that is what is frozen here.
//
// NORMALIZATION IS DELIBERATELY NARROW — timestamps, temp roots, generated ids, path separators and
// line endings only. Command names, ordering, exit codes, error categories, missing fields and
// meaningful paths are NEVER normalized: those are the differences a reviewer must see.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Where the curated fixtures live. Must match lib/check-lifecycle/gates/golden-replay.mjs. */
export const GOLDEN_DIR = join('tests', 'fixtures', 'golden');

/**
 * Collapse the handful of genuinely volatile spellings, and nothing else.
 *
 * @param {string} text
 * @param {string[]} roots - absolute temp roots to redact (longest first, so nested ones win)
 * @returns {string}
 */
export function normalize(text, roots = []) {
  let out = String(text ?? '');

  // Line endings first: every later pattern is written against \n.
  out = out.split('\r\n').join('\n');

  // Temp roots, longest first — a nested root must not be half-redacted by its parent.
  for (const root of [...roots].filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const form of [root, root.split('\\').join('/')]) {
      out = out.split(form).join('<tmp>');
    }
  }

  // Windows separators in the paths we just redacted, so one fixture serves both platforms.
  out = out.replace(/<tmp>[\\/][^\s:,'"]*/g, (m) => m.split('\\').join('/'));

  // Timestamps: ISO-8601 with an explicit offset or Z, and the compact Bangkok stamp used in
  // recovery filenames.
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, '<ts>');
  out = out.replace(/\d{8}T\d{6}[+-]\d{4}/g, '<stamp>');

  // Derived ids. A catalog fingerprint changes on ANY surface change anywhere in the repo, so
  // keeping the literal digest would make every fixture here churn on unrelated commits while
  // telling a reviewer nothing this suite is not already asserting structurally.
  out = out.replace(/sha256:[0-9a-f]{64}/g, 'sha256:<digest>');

  // Git object ids of a THROWAWAY repo. The mounted-core case builds a fresh core repository in a
  // temp directory and commits into it, so its HEAD is a new sha on every run — this fixture failed
  // on its very first replay for exactly that reason. The sha is a generated id in the plan's sense:
  // it identifies nothing a reviewer can act on, and no behaviour change can be read from it. Full
  // 40-hex ids collapse anywhere; short ids only in the `@ <sha> (` spelling the core-init line uses,
  // so an ordinary 7-character hex word elsewhere in a transcript is left alone.
  out = out.replace(/\b[0-9a-f]{40}\b/g, '<sha>');
  out = out.replace(/@ [0-9a-f]{7,12} \(/g, '@ <sha> (');

  // Wall-clock durations the runner prints.
  out = out.replace(/\(\d+(?:\.\d+)?ms\)/g, '(<ms>)');
  out = out.replace(/\b\d+(?:\.\d+)?s\b/g, '<s>');

  // The mounted-core doctor reports the Node runtime that happened to execute the fixture. Its
  // presence and semantic shape matter; the developer machine's exact version does not.
  out = out.replace(/(\bnode\s+node\s+)\d+\.\d+\.\d+\b/g, '$1<version>');

  return out.trimEnd() + '\n';
}

/**
 * Run a command and return a normalized, snapshot-ready transcript INCLUDING the exit code.
 *
 * The exit code is part of the fixture on purpose: a command that starts failing while printing the
 * same text is exactly the regression a stdout-only snapshot sleeps through.
 *
 * @param {{argv: string[], cwd: string, roots?: string[], env?: Record<string,string>}} spec
 * @returns {string}
 */
export function transcript({ argv, cwd, roots = [], env = {} }) {
  const bin = argv[0] === 'node' ? process.execPath : argv[0];
  const r = spawnSync(bin, argv.slice(1), {
    cwd,
    shell: false,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const parts = [
    `$ ${argv.join(' ')}`,
    `exit ${r.status ?? 'null'}${r.signal ? ` (${r.signal})` : ''}`,
  ];
  if (r.stdout) parts.push('--- stdout', r.stdout.trimEnd());
  if (r.stderr) parts.push('--- stderr', r.stderr.trimEnd());
  return normalize(parts.join('\n'), roots);
}

/** Sorted key list of an object, one line each — a stable, reviewable shape. */
function keyShape(obj, prefix = '') {
  if (obj === null || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return [];
  return Object.keys(obj).map((k) => `${prefix}${k}: ${describe(obj[k])}`);
}

/** One-word description of a value's shape — never its content. */
function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array[${v.length === 0 ? 'empty' : 'n'}]`;
  switch (typeof v) {
    case 'object': return 'object';
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return String(v);
    default: return typeof v;
  }
}

/** Run a CLI verb and parse its --json output. Throws with context so a fixture never lies. */
function json(argv, cwd) {
  const bin = argv[0] === 'node' ? process.execPath : argv[0];
  const r = spawnSync(bin, argv.slice(1), {
    cwd, shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`${argv.join(' ')} exited ${r.status}: ${r.stderr}`);
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`${argv.join(' ')} did not emit JSON: ${e.message}`);
  }
}

/**
 * The curated cases. Each `produce` returns the fixture body as a string.
 *
 * @type {ReadonlyArray<{name: string, file: string, why: string, produce: (ctx: {repoRoot: string}) => string}>}
 */
export const CASES = Object.freeze([
  {
    name: 'help-top',
    file: 'help-top.txt',
    why: 'the whole advertised surface, in first-appearance namespace order — a reordered or vanished namespace is a breaking change for every script that reads --help',
    produce: ({ repoRoot }) => transcript({ argv: ['node', 'bin/sidekicks', '--help'], cwd: repoRoot }),
  },
  {
    name: 'help-catalog',
    file: 'help-catalog.txt',
    why: "one namespace in full, including each verb's args spelling — the args string IS the contract a caller reads",
    produce: ({ repoRoot }) => transcript({ argv: ['node', 'bin/sidekicks', 'catalog', '--help'], cwd: repoRoot }),
  },
  {
    name: 'usage-error',
    file: 'usage-error.txt',
    why: 'the failure path, with its exit code: error TEXT and error CODE are both promises, and a usage error silently becoming exit 1 breaks every caller that distinguishes 2',
    produce: ({ repoRoot }) => [
      transcript({ argv: ['node', 'bin/sidekicks', 'catalog', 'show', '--section=nope'], cwd: repoRoot }),
      transcript({ argv: ['node', 'bin/sidekicks', 'check', 'run', '--profile=nope'], cwd: repoRoot }),
      transcript({ argv: ['node', 'bin/sidekicks', 'scope', 'explain', '--work-item=x'], cwd: repoRoot }),
      transcript({ argv: ['node', 'bin/sidekicks', 'scope', 'explain', '--reveal'], cwd: repoRoot }),
    ].join('\n'),
  },
  {
    name: 'catalog-json-contract',
    file: 'catalog-json-contract.txt',
    why: 'the machine contract of the generated catalog — its sections, its key order, its id prefixes and the absence of a timestamp. The payload is gated by `catalog check`; the SHAPE automation depends on is gated only here',
    produce: ({ repoRoot }) => {
      const doc = json(['node', 'bin/sidekicks', 'catalog', 'show', '--json'], repoRoot);
      const lines = ['# catalog show --json — machine contract', ''];
      lines.push(`schema_version: ${doc.schema_version}`);
      lines.push(`top-level keys (in order): ${Object.keys(doc).join(', ')}`);
      lines.push('');

      // Each section is an OBJECT of counts plus its inner arrays, so the contract has to descend one
      // level. A first draft of this case rendered every section as the word "object" and computed
      // "every id unique" over zero ids — a fixture that would have passed forever while asserting
      // nothing. Descend, and name the row-key order and id prefixes that automation actually reads.
      const rows = [];
      for (const section of Object.keys(doc)) {
        if (section === 'schema_version') continue;
        const val = doc[section];
        lines.push(`${section}`);
        for (const key of Object.keys(val)) {
          const inner = val[key];
          if (!Array.isArray(inner)) {
            lines.push(`  ${key}: ${describe(inner)}`);
            continue;
          }
          const prefixes = [...new Set(inner.map((r) => String(r?.id ?? '').split(':')[0]))]
            .filter(Boolean).sort();
          lines.push(`  ${key}: array, id prefix(es) ${prefixes.join('|') || '(no id field)'}`);
          if (inner[0] && typeof inner[0] === 'object' && !Array.isArray(inner[0])) {
            lines.push(`    row keys (in order): ${Object.keys(inner[0]).join(', ')}`);
          }
          for (const r of inner) if (r && r.id) rows.push(String(r.id));
        }
      }

      lines.push('');
      lines.push('INVARIANTS');
      const raw = JSON.stringify(doc);
      lines.push(`  ids counted (must be > 0 or this contract is vacuous): ${rows.length > 0}`);
      lines.push(`  every id unique: ${rows.length === new Set(rows).size}`);
      lines.push(`  every id carries a '<kind>:' prefix: ${rows.every((id) => id.includes(':'))}`);
      lines.push(`  carries no timestamp field: ${!/"(generated_at|timestamp|created)":/.test(raw)}`);
      lines.push(`  carries no machine-absolute path: ${!/"\/(Users|home)\//.test(raw) && !/[A-Za-z]:\\\\/.test(raw)}`);
      return normalize(lines.join('\n'));
    },
  },
  {
    name: 'scope-explain-contract',
    file: 'scope-explain-contract.txt',
    why: "the composition report's machine contract, and its two hard promises: credentials masked to a shape, and not one machine-absolute path. A regression in either is a leak, not a diff",
    produce: ({ repoRoot }) => {
      const doc = json(['node', 'bin/sidekicks', 'scope', 'explain', '--json'], repoRoot);
      const raw = JSON.stringify(doc);
      const lines = ['# scope explain --json — machine contract', ''];
      lines.push(`schema_version: ${doc.schema_version}`);
      lines.push(`top-level keys (in order): ${Object.keys(doc).join(', ')}`);
      lines.push('');
      lines.push('anchors');
      for (const l of keyShape(doc.anchors, '  ')) lines.push(l);
      lines.push('');
      // Credential contract. A first draft asserted "every shape contains ***" and recorded FALSE:
      // `shape` is carried by ordinary values too ("boolean", "mapping (16 keys)"), and in a git
      // worktree the *.secret.yaml files do not exist at all, so the real secret keys are honestly
      // EMPTY rather than masked. Freezing that false line would have been worse than omitting it.
      // What actually matters, and is true in both cases: a secret-flagged key never carries a raw
      // value field, only a shape.
      const blocks = Array.isArray(doc.configuration?.blocks) ? doc.configuration.blocks : [];
      const keys = blocks.flatMap((b) => (Array.isArray(b.keys) ? b.keys : []));
      const secrets = keys.filter((k) => k?.secret === true);

      lines.push('configuration');
      lines.push(`  block keys (in order): ${blocks[0] ? Object.keys(blocks[0]).join(', ') : '(none)'}`);
      lines.push(`  key entry keys (in order): ${keys[0] ? Object.keys(keys[0]).join(', ') : '(none)'}`);
      lines.push('');
      lines.push('INVARIANTS');
      lines.push(`  run_base_pattern present: ${typeof doc.anchors?.run_base_pattern === 'string'}`);
      lines.push(`  resolved_run_base is null without --skill-id: ${doc.anchors?.resolved_run_base === null}`);
      lines.push(`  no machine-absolute path anywhere: ${!/"\/(Users|home)\//.test(raw) && !/[A-Za-z]:\\\\/.test(raw)}`);
      lines.push(`  values_masked flag set: ${doc.configuration?.values_masked === true}`);
      lines.push(`  secret keys found (must be > 0 or the next line is vacuous): ${secrets.length > 0}`);
      lines.push(`  no secret key carries a raw value field: ${secrets.every((k) => !('value' in k))}`);
      lines.push(`  every secret key reports a shape instead: ${secrets.every((k) => typeof k.shape === 'string')}`);
      return normalize(lines.join('\n'));
    },
  },
  {
    name: 'package-help',
    file: 'package-help.txt',
    why: "the ASSEMBLED product, driven through ONLY its own bin/sidekicks in a temp directory. This is the one case that catches source-tree import leakage: a package that silently reaches back into the repo it was built from works here and fails on a user's machine",
    produce: ({ repoRoot }) => {
      let base = null;
      try {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'sk-golden-pkg-')));
        const pkgRoot = join(base, 'package');
        const create = spawnSync(process.execPath,
          ['bin/sidekicks', 'package', 'create', '--output', pkgRoot],
          { cwd: repoRoot, shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (create.status !== 0) {
          throw new Error(`package create exited ${create.status}: ${create.stderr}`);
        }
        const pkgBin = join(pkgRoot, 'bin', 'sidekicks');
        if (!existsSync(pkgBin)) throw new Error('assembled package has no bin/sidekicks');
        return transcript({
          argv: ['node', pkgBin, '--help'],
          cwd: pkgRoot,
          roots: [pkgRoot, base, repoRoot],
        });
      } finally {
        if (base) { try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } }
      }
    },
  },
  {
    name: 'mounted-core-workflow',
    file: 'mounted-core-workflow.txt',
    why: "a fresh core mounted into a fresh workspace and driven through ONLY its mounted entrypoint. Reuses the release gate's own handler rather than a second mount implementation, so the golden and the gate can never disagree about what mounting means",
    produce: ({ repoRoot }) => {
      const result = mountedCoreResult(repoRoot);
      const lines = [
        '# core.mounted — mounted-core workflow transcript',
        `exit ${result.exitCode ?? 'null'}`,
        result.reason ? `reason: ${result.reason}` : 'reason: (none)',
        '--- log',
        result.stdout ?? '',
      ];
      return normalize(lines.join('\n'), [repoRoot]);
    },
  },
]);

// ── The two dynamic imports and the async bridge ──────────────────────────────
// `produce` is synchronous by design: the refresh script and the replay suite both want a plain
// string, and a sync contract keeps a fixture from being half-written when something throws. The
// mounted-core gate is async, so it needs a bridge; deasync is not available and must not be, so the
// bridge is a child process that prints the gate's result as JSON.

/**
 * Run the mounted-core gate in a child process and return its result document.
 *
 * The gate is async and `produce` is sync, so the bridge is a short Node program that imports the
 * gate, awaits it with the REAL spawn, and prints the result as JSON. Keeping `produce` synchronous
 * is what stops a fixture being half-written when something throws mid-way. The child also isolates
 * the mount: a gate that leaves a stray temp tree behind cannot leak into this process.
 *
 * @param {string} repoRoot
 * @returns {{exitCode: number|null, reason: string|null, stdout: string}}
 */
function mountedCoreResult(repoRoot) {
  const program = [
    "const { coreMounted } = await import('./lib/check-lifecycle/gates/core-mounted.mjs');",
    "const { spawnArgv } = await import('./lib/check-lifecycle/runner.mjs');",
    'const r = await coreMounted({ repoRoot: process.cwd(), spawn: spawnArgv,',
    '  timeoutMs: 600000, signal: new AbortController().signal });',
    'process.stdout.write(JSON.stringify({ exitCode: r.exitCode ?? null,',
    '  reason: r.reason ?? null, stdout: r.stdout ?? "" }));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: repoRoot, shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`mounted-core bridge exited ${r.status}: ${r.stderr || r.stdout}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`mounted-core bridge emitted no JSON: ${e.message}\n${r.stdout}`);
  }
}

/**
 * Read a fixture from disk, or null when it does not exist.
 *
 * @param {string} repoRoot
 * @param {string} file
 * @returns {string|null}
 */
export function readFixture(repoRoot, file) {
  const p = join(repoRoot, GOLDEN_DIR, file);
  return existsSync(p) ? readFileSync(p, 'utf8').split('\r\n').join('\n') : null;
}
