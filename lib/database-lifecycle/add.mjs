// lib/database-lifecycle/add.mjs
// Implements `sidekicks database add <name> --file <path> [--env <alias>]
//   [--schema <s>]... [--version <v>] [--force]`.
//
// Verb skeleton mirrors lib/project-lifecycle/set-remote.mjs.
// Zero npm dependencies — node:crypto, node:fs, node:path + relative lib/ imports.

import { createHash } from 'node:crypto';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { copyAtomic, writeAtomic, mkdirp, rmrf } from '../fs-safety/fsx.mjs';
import {
  read as readManifest,
  addDatabase,
} from '../manifest-schema/manifest.mjs';
import { rebuildRootIndex } from '../scope-index/index.mjs';
import { serialize as yamlSerialize } from '../yaml-subset/yaml.mjs';
import { assertUserProjectScope } from './scope-guard.mjs';
import { formatBangkokStamp } from './stamp.mjs';
import {
  parseSchemaSql,
  renderTableMarkdown,
  renderDatabaseIndex,
  buildDatabaseIndexJson,
} from '../schema-extractor/extractor.mjs';
import {
  SidekicksError,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_VALIDATION,
} from '../sk-cli/errors.mjs';

// ── Constants ────────────────────────────────────────────────────────────────

// Valid kebab-case pattern for database name field (matches manifest.mjs NAME_PATTERN).
const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^[a-z0-9]$/;

// Valid version pattern.
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// §5 recipe template — printed for --env-alone guidance path.
function buildRecipe(name, alias) {
  return `To register a live database schema, run:

  ROOT="$(git rev-parse --show-toplevel)"
  PY="$ROOT/.venv/bin/python"
  SKILL_DIR="$ROOT/.agents/skills/sk-database-connector"

  "$PY" "$SKILL_DIR/scripts/pg_export.py" -e ${alias} --schema-only -o "$ROOT/tmp/dbreg"

  node "$ROOT/bin/sidekicks" database add ${name} \\
       --env ${alias} --schema <schema> \\
       --file "$ROOT/tmp/dbreg/db-exports/${alias}/schemas/${alias}_schema_<ts>.sql"
`;
}

// ── Bangkok ISO-8601 timestamp (captured_at) ─────────────────────────────────

function formatBangkokIso() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+07:00`;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse a flat args array into a structured object.
 * Handles: positional name, --file, --env, --schema (repeatable), --version, --force.
 */
function parseArgs(args) {
  // args may come in as: { name, rest, flags } from the dispatcher, or as a raw array.
  // The dispatcher passes structured args — but we also accept raw arrays for testability.
  if (!Array.isArray(args)) {
    // Structured dispatcher form: { name, rest: string[], flags: {} }
    const name = args.name != null ? String(args.name) : '';
    const rest = Array.isArray(args.rest) ? args.rest : [];
    const flags = args.flags || {};

    // Collect --schema flags from rest (the dispatcher may not collect repeating flags).
    // Also support flags object carrying them.
    let file = flags.file || null;
    let env = flags.env || null;
    let version = flags.version || null;
    let force = Boolean(flags.force);
    let schemas = [];

    // flags.schema may be a string (single) or array (multiple); also scan rest.
    if (flags.schema) {
      schemas = Array.isArray(flags.schema) ? flags.schema.map(String) : [String(flags.schema)];
    }

    // Parse rest for any flags the dispatcher didn't collect.
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok === '--file' && rest[i + 1]) { file = rest[++i]; }
      else if (tok === '--env' && rest[i + 1]) { env = rest[++i]; }
      else if (tok === '--schema' && rest[i + 1]) { schemas.push(rest[++i]); }
      else if (tok === '--version' && rest[i + 1]) { version = rest[++i]; }
      else if (tok === '--force') { force = true; }
      else if (tok.startsWith('--file=')) { file = tok.slice(7); }
      else if (tok.startsWith('--env=')) { env = tok.slice(6); }
      else if (tok.startsWith('--schema=')) { schemas.push(tok.slice(9)); }
      else if (tok.startsWith('--version=')) { version = tok.slice(10); }
    }

    return { name, file, env, version, force, schemas };
  }

  // Raw array form (used by tests that pass a plain argv array).
  let name = '';
  let file = null;
  let env = null;
  let version = null;
  let force = false;
  const schemas = [];

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--file' && args[i + 1]) { file = args[++i]; }
    else if (tok === '--env' && args[i + 1]) { env = args[++i]; }
    else if (tok === '--schema' && args[i + 1]) { schemas.push(args[++i]); }
    else if (tok === '--version' && args[i + 1]) { version = args[++i]; }
    else if (tok === '--force') { force = true; }
    else if (tok.startsWith('--file=')) { file = tok.slice(7); }
    else if (tok.startsWith('--env=')) { env = tok.slice(6); }
    else if (tok.startsWith('--schema=')) { schemas.push(tok.slice(9)); }
    else if (tok.startsWith('--version=')) { version = tok.slice(10); }
    else if (!tok.startsWith('--') && !name) { name = tok; }
  }

  return { name, file, env, version, force, schemas };
}

// ── Main verb ─────────────────────────────────────────────────────────────────

/**
 * Execute the `database add <name> ...` verb.
 *
 * @param {{ repoRoot: string, argv?: string[], flags?: object, _stdin?: object }} ctx
 * @param {object|string[]} args - Dispatcher-structured args or raw argv array.
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;

  // ── Scope resolution ────────────────────────────────────────────────────────
  const settings = readSettings(repoRoot);
  const scope = resolveEffectiveScope(settings);

  // ── Precondition 1: reject root scope ──────────────────────────────────────
  assertUserProjectScope(scope);

  // ── Parse arguments ─────────────────────────────────────────────────────────
  const { name, file, env, version: versionArg, force, schemas } = parseArgs(args);

  // ── Precondition 2: projects/<active>/ must exist ──────────────────────────
  const projectDir = join(repoRoot, 'projects', scope.projectName);
  let pStat;
  try { pStat = statSync(projectDir); } catch { pStat = null; }
  if (!pStat || !pStat.isDirectory()) {
    throw new SidekicksError(
      `active project directory projects/${scope.projectName}/ does not exist (stale pointer)`,
      EXIT_VALIDATION
    );
  }

  // ── Precondition 3: manifest must be readable ──────────────────────────────
  const manifestPath = join(projectDir, 'manifest.yaml');
  readManifest(manifestPath); // throws EXIT_VALIDATION on failure

  // ── Precondition 4: name validation ───────────────────────────────────────
  if (!name || !NAME_PATTERN.test(name) || !/[^0-9]/.test(name)) {
    throw new SidekicksError(
      `invalid database name '${name}': must match [a-z0-9-] kebab pattern and contain a non-digit, e.g. db1`,
      EXIT_VALIDATION
    );
  }

  // ── Precondition 5: at least one of --file / --env ─────────────────────────
  if (!file && !env) {
    throw new SidekicksError(
      'usage: sidekicks database add <name> (--file <path> | --env <alias> | --env <alias> --file <path>) [--schema <s>]... [--version <v>] [--force]',
      EXIT_USAGE
    );
  }

  // ── Precondition 5a: --env alias must be non-numeric ──────────────────────
  if (env !== null && !/[^0-9]/.test(env)) {
    throw new SidekicksError(
      `invalid environment alias '${env}': environment alias must contain a non-digit; rename the env (e.g. \`prod-2024\`) or pass \`--file\` alone`,
      EXIT_VALIDATION
    );
  }

  // ── Branch: --env-alone guidance path ─────────────────────────────────────
  if (env !== null && file === null) {
    const recipe = buildRecipe(name, env);
    return { stdout: recipe, exitCode: EXIT_OK };
  }

  // ── From here: ingesting run (file is set) ────────────────────────────────

  // ── Precondition 6: source must be a single existing readable .sql file ───
  if (!file || typeof file !== 'string') {
    throw new SidekicksError(
      `--file requires a single .sql file path`,
      EXIT_VALIDATION
    );
  }
  // Reject glob patterns (contains *, ?, {, [)
  if (/[*?{[\]]/.test(file)) {
    throw new SidekicksError(
      `--file must be a single file path, not a glob: '${file}'`,
      EXIT_VALIDATION
    );
  }
  // Reject multiple paths (contains space + another path segment or comma)
  if (file.trim().includes(' ') && file.trim().split(/\s+/).length > 1) {
    throw new SidekicksError(
      `--file must be a single file path, not multiple paths: '${file}'`,
      EXIT_VALIDATION
    );
  }
  // Must end with .sql
  if (extname(file).toLowerCase() !== '.sql') {
    throw new SidekicksError(
      `--file must point to a .sql file; got '${file}'`,
      EXIT_VALIDATION
    );
  }
  // Must exist and be a file
  let fStat;
  try { fStat = statSync(file); } catch { fStat = null; }
  if (!fStat) {
    throw new SidekicksError(
      `--file '${file}' does not exist or is not readable`,
      EXIT_VALIDATION
    );
  }
  if (!fStat.isFile()) {
    throw new SidekicksError(
      `--file '${file}' is a directory, not a file`,
      EXIT_VALIDATION
    );
  }

  // ── Precondition 7: --version validation ──────────────────────────────────
  if (versionArg !== null && versionArg !== undefined) {
    if (!VERSION_PATTERN.test(versionArg) || !/[^0-9]/.test(versionArg)) {
      throw new SidekicksError(
        `invalid version '${versionArg}': version must match [A-Za-z0-9._-] and contain a non-digit, e.g. v1`,
        EXIT_VALIDATION
      );
    }
  }

  // ── Resolve version ────────────────────────────────────────────────────────
  const version = (versionArg != null && versionArg !== '') ? versionArg : formatBangkokStamp();

  // ── Precondition 8: duplicate (name, version) check ────────────────────────
  const currentManifest = readManifest(manifestPath);
  const existingDatabases = Array.isArray(currentManifest.databases) ? currentManifest.databases : [];
  const isDuplicate = existingDatabases.some(d => d.name === name && d.version === version);
  if (isDuplicate && !force) {
    throw new SidekicksError(
      `database '${name}' version '${version}' is already registered; use --force to overwrite`,
      EXIT_VALIDATION
    );
  }

  // ── Compute paths ───────────────────────────────────────────────────────────
  const dbDirName = `${name}-${version}`;
  const destDir = join(repoRoot, 'projects', scope.projectName, 'databases', dbDirName);
  const destSql = join(destDir, 'schema.sql');
  const treeDir = join(destDir, 'schema');
  const indexMdPath = join(destDir, 'index.md');
  const indexJsonPath = join(destDir, 'index.json');
  const metaYamlPath = join(destDir, 'meta.yaml');

  // ── assertWritable gate (before any structural write) ─────────────────────
  assertWritable(destSql, repoRoot);

  // ── --force pre-purge of stale derived artifacts ───────────────────────────
  if (force) {
    assertWritable(treeDir, repoRoot);
    rmrf(treeDir);
    assertWritable(indexMdPath, repoRoot);
    rmrf(indexMdPath);
    assertWritable(indexJsonPath, repoRoot);
    rmrf(indexJsonPath);
  }

  // ── Copy schema.sql atomically ─────────────────────────────────────────────
  mkdirp(destDir);
  copyAtomic(file, destSql);

  // ── Compute checksum ────────────────────────────────────────────────────────
  const sqlContent = readFileSync(destSql, 'utf8');
  const hex = createHash('sha256').update(sqlContent).digest('hex');
  const checksum = `sha256:${hex}`;

  // ── Parse SQL ───────────────────────────────────────────────────────────────
  const { tables, warnings: parseWarnings } = parseSchemaSql(sqlContent);

  // ── Group tables by schema ─────────────────────────────────────────────────
  // tablesBySchema: Map<schemaName, Map<tableName, entry>>
  const tablesBySchema = new Map();
  for (const entry of tables) {
    if (!tablesBySchema.has(entry.schema)) {
      tablesBySchema.set(entry.schema, new Map());
    }
    tablesBySchema.get(entry.schema).set(entry.table, entry);
  }

  const allWarnings = [...parseWarnings];

  // ── Write per-table fragments ───────────────────────────────────────────────
  for (const [schema, tableMap] of tablesBySchema) {
    for (const [table, entry] of tableMap) {
      const fragPath = join(treeDir, schema, 'tables', `${table}.md`);
      assertWritable(fragPath, repoRoot);
      mkdirp(join(treeDir, schema, 'tables'));
      writeAtomic(fragPath, renderTableMarkdown(entry));
    }
  }

  // ── Write index.md ─────────────────────────────────────────────────────────
  assertWritable(indexMdPath, repoRoot);
  // Post-review follow-up note: renderDatabaseIndex prepends 'v' to version,
  // so pass version as-is; if it already has a 'v' prefix that produces 'vv1'.
  // Per tech-spec Post-Review Follow-ups (Story 1.3): add.mjs should pass bare version
  // OR strip a leading 'v' before passing. We strip a leading 'v' here.
  const versionForIndex = version.startsWith('v') ? version.slice(1) : version;
  writeAtomic(indexMdPath, renderDatabaseIndex(name, versionForIndex, tablesBySchema));

  // ── Write index.json ───────────────────────────────────────────────────────
  assertWritable(indexJsonPath, repoRoot);
  const indexObj = buildDatabaseIndexJson(
    name,
    version,
    checksum,
    scope.projectRelPath,
    tablesBySchema,
    parseWarnings   // pass parse warnings so dangling-FK warnings are not double-reported
  );
  // Collect any warnings from the index builder (zero-table warning etc.)
  if (Array.isArray(indexObj.warnings)) {
    for (const w of indexObj.warnings) {
      if (!allWarnings.includes(w)) allWarnings.push(w);
    }
  }
  writeAtomic(indexJsonPath, JSON.stringify(indexObj, null, 2));

  // ── Zero-table handling ────────────────────────────────────────────────────
  if (tables.length === 0) {
    allWarnings.push('0 tables parsed — source preserved in schema.sql');
  }

  // ── Assemble entry (single source of truth for meta.yaml + manifest) ───────
  const source = env !== null ? env : 'file';
  const entryPath = `databases/${dbDirName}/schema.sql`;   // project-relative
  const entryTree = `databases/${dbDirName}/schema`;       // project-relative
  const capturedAt = formatBangkokIso();

  const entry = {
    name,
    version,
    path: entryPath,
    tree: entryTree,
    source,
    captured_at: capturedAt,
    checksum,
  };

  // Optional fields: only include when present/non-zero
  if (schemas.length > 0) {
    entry.schemas = schemas.join(',');
  }
  if (tables.length > 0) {
    entry.table_count = tables.length; // bare JS number — round-trips as number
  }
  // Note: table_count is intentionally omitted when tables.length === 0

  // ── Write meta.yaml (bare YAML map) ────────────────────────────────────────
  assertWritable(metaYamlPath, repoRoot);
  writeAtomic(metaYamlPath, yamlSerialize(entry));

  // ── Register in manifest + rebuild index ───────────────────────────────────
  addDatabase(manifestPath, entry);
  rebuildRootIndex(repoRoot);

  // ── Build stdout summary ────────────────────────────────────────────────────
  const tableCountMsg = tables.length > 0
    ? `${tables.length} table(s) parsed`
    : '0 tables parsed — source preserved in schema.sql';

  let stdout = `database add: '${name}' version '${version}'\n`;
  stdout += `  schema.sql : ${entryPath}\n`;
  stdout += `  tree       : ${entryTree}\n`;
  stdout += `  index.json : databases/${dbDirName}/index.json\n`;
  stdout += `  tables     : ${tableCountMsg}\n`;
  stdout += `  checksum   : ${checksum}\n`;

  if (allWarnings.length > 0) {
    stdout += `\nWarnings:\n`;
    for (const w of allWarnings) {
      stdout += `  ! ${w}\n`;
    }
  }

  stdout += `\nDon't forget to commit these files to version-control to make the schema travel with the project.\n`;

  return { stdout, exitCode: EXIT_OK };
}
