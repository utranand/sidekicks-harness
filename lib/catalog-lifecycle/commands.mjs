// lib/catalog-lifecycle/commands.mjs
// The three `catalog` verbs, one function each: showCatalog, rebuildCatalog, checkCatalog.
//
// The thin per-verb entrypoints (./show.mjs, ./check.mjs, ./rebuild.mjs) exist only because dispatch
// is convention-based -- lib/sk-cli/cli.mjs imports `lib/<namespace>-lifecycle/<verb>.mjs` and calls
// its `run(ctx, args)`. All three delegate straight into here so the behaviour is testable without a
// dispatcher and shared without duplication.
//
// WHERE THE THREE OUTPUTS LIVE, AND WHY THREE
//   docs/generated/framework-catalog.json   the machine face, for the repo
//   docs/generated/framework-catalog.md     the human face, for the repo
//   lib/catalog-lifecycle/framework-catalog.generated.json   BYTE-IDENTICAL to the first
//
// The duplicate is not redundancy. `docs` is in lib/package-lifecycle/plan.mjs's FIXED_EXCLUDES on
// purpose -- an assembled runtime ships no documentation -- so a snapshot under docs/ alone would
// never reach a package, and a packaged `catalog check` would have nothing to validate against. A
// copy under lib/ travels with the `lib` include and needs no exception carved into the packager.
//
// Zero npm dependencies -- node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { buildCatalog, catalogIds, CATALOG_SECTIONS, EXECUTOR_REGISTRY_REL } from './model.mjs';
import { serializeCatalog, renderCatalogMarkdown, catalogFingerprint } from './render.mjs';
import { DURABLE_FORMATS } from './durable-formats.mjs';
import { sortBy } from './_shared.mjs';

/** The generated outputs, repo-relative and POSIX (split on `/` before joining). */
export const DOCS_JSON_REL = 'docs/generated/framework-catalog.json';
export const DOCS_MD_REL = 'docs/generated/framework-catalog.md';
export const SNAPSHOT_REL = 'lib/catalog-lifecycle/framework-catalog.generated.json';

/** Section names a caller may pass, in both the JSON key form and the CLI-friendly dashed form. */
const SECTION_ALIASES = new Map([
  ...CATALOG_SECTIONS.map((s) => [s, s]),
  ['durable-formats', 'durable_formats'],
  ['all', null],
]);

function abs(repoRoot, rel) {
  return join(repoRoot, ...rel.split('/'));
}

/**
 * Read a generated file for comparison, LF-normalized.
 *
 * The comparison is deliberately NOT byte-exact on line endings: a Windows checkout with
 * `core.autocrlf=true` receives the very same committed content with CRLF endings, and reporting
 * that as drift would make `catalog check` red on a correct clone. Everything else about the
 * comparison is exact.
 *
 * @param {string} path
 * @returns {string|null} null when the file is absent or unreadable
 */
function readNormalized(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8').split('\r\n').join('\n').split('\r').join('\n');
  } catch {
    return null;
  }
}

/** True when this tree carries its documentation -- i.e. it is the source repo, not a package. */
export function isSourceTree(repoRoot) {
  return existsSync(join(repoRoot, 'docs'));
}

/**
 * Resolve a `--section` value to a JSON key, or throw a usage error naming the valid set.
 *
 * @param {string|boolean|undefined|null} value
 * @returns {string|null} the section key, or null for the whole catalog
 */
export function resolveSection(value) {
  if (value === undefined || value === null || value === '' || value === true) return null;
  const key = String(value).trim().toLowerCase();
  if (key === '') return null;
  if (!SECTION_ALIASES.has(key)) {
    throw new SidekicksError(
      `catalog: unknown section '${value}' -- valid sections: `
      + `${[...CATALOG_SECTIONS, 'durable-formats', 'all'].join(', ')}`,
      EXIT_USAGE,
    );
  }
  return SECTION_ALIASES.get(key);
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

/**
 * `sidekicks catalog show [<section>] [--section <s>] [--json]`
 *
 * @param {string} repoRoot
 * @param {{section?: string|boolean|null, json?: boolean}} [opts]
 * @returns {{stdout: string, exitCode: number}}
 */
export function showCatalog(repoRoot, opts = {}) {
  const section = resolveSection(opts.section);
  const model = buildCatalog(repoRoot);

  if (opts.json) {
    if (!section) return { stdout: serializeCatalog(model), exitCode: EXIT_OK };
    return {
      stdout: serializeCatalog({
        schema_version: model.schema_version,
        section,
        [section]: model[section],
      }),
      exitCode: EXIT_OK,
    };
  }

  return {
    stdout: renderCatalogMarkdown(model, section ? { section } : {}),
    exitCode: EXIT_OK,
  };
}

// ---------------------------------------------------------------------------
// rebuild
// ---------------------------------------------------------------------------

/**
 * `sidekicks catalog rebuild [--dry-run] [--json]`
 *
 * Writes the three generated outputs atomically (lib/fs-safety writeAtomic: temp file in the same
 * directory, then rename), so a crash mid-write can never leave a half-written catalog that the next
 * `catalog check` would read as drift.
 *
 * In a tree with no `docs/` -- an assembled package -- only the lib snapshot is written, and the
 * report says so. That is not a degraded mode: a package has no documentation surface to keep in
 * sync, and inventing a `docs/` directory inside one would put a file where the packager
 * deliberately excludes the whole tree.
 *
 * @param {string} repoRoot
 * @param {{json?: boolean, dryRun?: boolean}} [opts]
 * @returns {{stdout: string, exitCode: number}}
 */
export function rebuildCatalog(repoRoot, opts = {}) {
  const model = buildCatalog(repoRoot);
  const json = serializeCatalog(model);
  const markdown = renderCatalogMarkdown(model);
  const fingerprint = catalogFingerprint(model);
  const source = isSourceTree(repoRoot);

  const targets = source
    ? [
      { rel: DOCS_JSON_REL, content: json },
      { rel: DOCS_MD_REL, content: markdown },
      { rel: SNAPSHOT_REL, content: json },
    ]
    : [{ rel: SNAPSHOT_REL, content: json }];

  const written = [];
  const unchanged = [];
  for (const t of targets) {
    const path = abs(repoRoot, t.rel);
    const current = readNormalized(path);
    if (current === t.content) { unchanged.push(t.rel); continue; }
    if (!opts.dryRun) writeAtomic(path, t.content);
    written.push(t.rel);
  }

  const payload = {
    ok: true,
    dry_run: Boolean(opts.dryRun),
    source_tree: source,
    schema_version: model.schema_version,
    fingerprint,
    written,
    unchanged,
  };

  if (opts.json) return { stdout: `${JSON.stringify(payload, null, 2)}\n`, exitCode: EXIT_OK };

  const lines = [
    opts.dryRun ? 'catalog rebuild (dry run)' : 'catalog rebuild: OK',
    `  fingerprint: ${fingerprint}`,
    `  ${opts.dryRun ? 'would write' : 'written'}:   ${written.length ? written.join(', ') : '(nothing)'}`,
    `  unchanged:   ${unchanged.length ? unchanged.join(', ') : '(none)'}`,
  ];
  if (!source) {
    lines.push('  note:        no docs/ in this tree (assembled package) -- lib snapshot only');
  }
  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/**
 * Every finding the catalog gate can raise. Exported so a caller can assert against the codes
 * instead of matching on prose.
 */
export const CHECK_CODES = Object.freeze([
  'stale-generated',      // a generated file exists but no longer matches the live declarations
  'missing-generated',    // a generated file is absent entirely
  'snapshot-drift',       // packaged: the lib snapshot disagrees with the live packaged declarations
  'duplicate-id',         // one id claimed by two catalog rows
  'missing-owner',        // a row that must name an owner names none
  'dangling-reference',   // a row points at a path that does not exist
  'missing-target',       // an active skill hard-depends on a skill that is not active
  'dependency-cycle',     // an in-process import cycle between active skills
]);

/**
 * Collect every catalog finding. Exported so the suite asserts the same checks the verb runs, rather
 * than a re-implementation of them (the arrangement lib/framework-lifecycle/doctor.mjs uses).
 *
 * @param {string} repoRoot
 * @returns {{findings: Array<{code: string, severity: string, subject: string, message: string}>,
 *            model: object, counts: object}}
 */
export function auditCatalog(repoRoot) {
  const findings = [];
  const model = buildCatalog(repoRoot);
  const json = serializeCatalog(model);
  const markdown = renderCatalogMarkdown(model);
  const source = isSourceTree(repoRoot);

  const add = (code, subject, message, severity = 'error') =>
    findings.push({ code, severity, subject, message });

  // 1 -- generated output is current.
  const expected = source
    ? [
      { rel: DOCS_JSON_REL, content: json },
      { rel: DOCS_MD_REL, content: markdown },
      { rel: SNAPSHOT_REL, content: json },
    ]
    : [];
  for (const t of expected) {
    const current = readNormalized(abs(repoRoot, t.rel));
    if (current === null) {
      add('missing-generated', t.rel, `'${t.rel}' does not exist -- run 'sidekicks catalog rebuild'`);
      continue;
    }
    if (current !== t.content) {
      add('stale-generated', t.rel,
        `'${t.rel}' no longer matches the live declarations -- run 'sidekicks catalog rebuild'`);
    }
  }

  // 1b -- packaged: no docs/ to compare, so the snapshot is validated by fingerprint against the
  // live PACKAGED declarations. `--include-config=false` legitimately drops the executor registry,
  // so when it is absent the environment-derived section is omitted from both sides and every
  // declaration-derived section is still proved to have travelled unchanged.
  if (!source) {
    const snapshotText = readNormalized(abs(repoRoot, SNAPSHOT_REL));
    if (snapshotText === null) {
      add('missing-generated', SNAPSHOT_REL,
        `'${SNAPSHOT_REL}' does not exist -- the packaged catalog snapshot did not travel`);
    } else {
      let snapshot = null;
      try {
        snapshot = JSON.parse(snapshotText);
      } catch (err) {
        add('snapshot-drift', SNAPSHOT_REL, `'${SNAPSHOT_REL}' is not valid JSON (${err.message})`);
      }
      if (snapshot) {
        const omit = model.executors.registry_present ? [] : ['executors'];
        const live = catalogFingerprint(model, { omitSections: omit });
        const packaged = catalogFingerprint(snapshot, { omitSections: omit });
        if (live !== packaged) {
          add('snapshot-drift', SNAPSHOT_REL,
            `packaged snapshot fingerprint ${packaged} does not match the live packaged `
            + `declarations ${live}${omit.length ? ` (executors omitted: ${EXECUTOR_REGISTRY_REL} `
              + 'is absent in this package)' : ''}`);
        }
      }
    }
  }

  // 2 -- ids are globally unique across every section.
  const byId = new Map();
  for (const row of catalogIds(model)) {
    const prior = byId.get(row.id);
    if (prior) {
      add('duplicate-id', row.id,
        `id '${row.id}' is claimed by both the ${prior} and ${row.section} sections`);
      continue;
    }
    byId.set(row.id, row.section);
  }

  // 3 -- owners. A durable format MUST name the subsystem that defines it; a skill-declared config
  // block MUST name the skill that declared it. A framework-core block legitimately has none.
  for (const f of model.durable_formats.formats) {
    if (!f.owner) add('missing-owner', f.id, `durable format '${f.id}' names no owning subsystem`);
  }
  for (const b of model.config.blocks) {
    if (b.source !== 'core' && b.owners.length === 0) {
      add('missing-owner', b.id,
        `config block '${b.block}' is skill-declared but names no owning skill`);
    }
  }

  // 4 -- dangling references: every path any row points at must exist.
  for (const c of model.cli.commands) {
    if (!existsSync(abs(repoRoot, c.module))) {
      add('dangling-reference', c.id,
        `'${c.id}' is registered in lib/sk-cli/help.mjs but '${c.module}' does not exist, so the `
        + 'dispatcher cannot resolve it');
    }
  }
  for (const f of model.durable_formats.formats) {
    for (const [field, rel] of [['owner', f.owner], ['reader', f.reader], ['writer', f.writer]]) {
      if (!rel) continue;
      if (!existsSync(abs(repoRoot, rel))) {
        add('dangling-reference', f.id, `durable format '${f.id}' names ${field} '${rel}', which does not exist`);
      }
    }
  }
  for (const b of model.config.blocks) {
    if (b.defaults && !existsSync(abs(repoRoot, b.defaults))) {
      add('dangling-reference', b.id,
        `config block '${b.block}' names defaults '${b.defaults}', which does not exist`);
    }
  }

  // 5 -- the active skill graph.
  for (const m of model.skills.missing_targets) {
    add('missing-target', m.from,
      `active skill '${m.from}' hard-depends on '${m.to}'${m.how ? ` (how: ${m.how})` : ''}, `
      + 'which is not an active skill');
  }
  for (const c of model.skills.acquisition_cycles) {
    add('dependency-cycle', c.cycle[0],
      `in-process import cycle between active skills: ${c.cycle.join(' -> ')} -> ${c.cycle[0]}`);
  }

  const ordered = sortBy(findings, (f) => `${f.severity === 'error' ? '0' : '1'} ${f.code} ${f.subject}`);
  return {
    findings: ordered,
    model,
    counts: {
      source_tree: source,
      ids: byId.size,
      cli_commands: model.cli.command_count,
      framework_entries: model.framework.entry_count,
      active_skills: model.skills.active_count,
      parked_skills: model.skills.parked_count,
      config_blocks: model.config.block_count,
      executors: model.executors.executor_count,
      durable_formats: model.durable_formats.format_count,
      declared_formats: DURABLE_FORMATS.length,
      mutual_composition: model.skills.mutual_composition.length,
      errors: ordered.filter((f) => f.severity === 'error').length,
    },
  };
}

/**
 * `sidekicks catalog check [--json]`
 *
 * @param {string} repoRoot
 * @param {{json?: boolean}} [opts]
 * @returns {{stdout: string, exitCode: number}}
 */
export function checkCatalog(repoRoot, opts = {}) {
  const { findings, model, counts } = auditCatalog(repoRoot);
  const errors = findings.filter((f) => f.severity === 'error');

  if (opts.json) {
    const payload = {
      ok: errors.length === 0,
      schema_version: model.schema_version,
      fingerprint: catalogFingerprint(model),
      counts,
      findings,
    };
    return {
      stdout: `${JSON.stringify(payload, null, 2)}\n`,
      exitCode: errors.length ? EXIT_VALIDATION : EXIT_OK,
    };
  }

  if (errors.length) {
    const lines = findings.map((f) => `  [${f.code}] ${f.subject}: ${f.message}`);
    throw new SidekicksError(
      `catalog check: ${errors.length} problem(s) found\n${lines.join('\n')}`,
      EXIT_VALIDATION,
    );
  }

  const out = [
    'catalog check: OK',
    `  fingerprint: ${catalogFingerprint(model)}`,
    `  ids:         ${counts.ids} unique across 6 sections`,
    `  cli:         ${counts.cli_commands} verbs, every dispatch module present`,
    `  framework:   ${counts.framework_entries} entries`,
    `  skills:      ${counts.active_skills} active, ${counts.parked_skills} parked, no missing hard target, no import cycle`,
    `  config:      ${counts.config_blocks} blocks, every declared defaults file present`,
    `  executors:   ${counts.executors} resolved`,
    `  formats:     ${counts.durable_formats} durable formats, every owner/reader/writer present`,
    `  generated:   ${counts.source_tree ? `${DOCS_JSON_REL}, ${DOCS_MD_REL}, ${SNAPSHOT_REL} current`
      : `${SNAPSHOT_REL} matches the live packaged declarations (no docs/ in this tree)`}`,
  ];
  if (counts.mutual_composition > 0) {
    out.push(`  note:        ${counts.mutual_composition} mutual-composition cycle(s) reported in `
      + 'the catalog (process/handoff boundary -- not a failure)');
  }
  return { stdout: `${out.join('\n')}\n`, exitCode: EXIT_OK };
}
