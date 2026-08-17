// lib/schema-extractor/extractor.mjs
// Pure, zero-dependency ESM parser module: converts a combined PostgreSQL schema dump
// into structured per-table data including foreign keys, renderers for Markdown fragments,
// and a machine-readable index.json join graph.
//
// Zero external imports — uses only Node.js built-ins (Intl.DateTimeFormat).
// No filesystem access — all outputs are plain objects and strings.
//
// Parser logic ported from cortex/bin/lib/cortex-operator/extractor.js (NOT imported).
// FK extraction (D6) is an extension not present in cortex.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Schema version for the database index.json.
 * Independent of lib/scope-index's SCHEMA_VERSION — both happen to be 1
 * but are not coupled and may diverge independently.
 */
export const DATABASE_INDEX_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// normalizeIdentifier(id)
// ---------------------------------------------------------------------------

/**
 * Normalize a PostgreSQL identifier to snake_case.
 * - Strips surrounding double-quotes if present.
 * - Converts camelCase to snake_case (inserts _ before each uppercase letter
 *   following a lowercase letter).
 * - Lowercases the entire result.
 *
 * Mirrors cortex extractor.js normalizeIdentifier convention.
 *
 * @param {string} id - Raw identifier (possibly quoted or camelCase).
 * @returns {string} Normalized snake_case identifier.
 */
export function normalizeIdentifier(id) {
  // Strip surrounding double-quotes
  let result = id.replace(/^"(.*)"$/, '$1');
  // Insert _ before an uppercase letter that follows a lowercase letter (camelCase → snake_case)
  result = result.replace(/([a-z])([A-Z])/g, '$1_$2');
  // Lowercase all
  result = result.toLowerCase();
  return result;
}

// ---------------------------------------------------------------------------
// parseSchemaSql(sqlText)
// ---------------------------------------------------------------------------

/**
 * Parse a combined PostgreSQL schema dump (pg_dump --schema-only output) into
 * a structured array of table entries.
 *
 * Returns an object: { tables: Array<TableEntry>, warnings: string[] }
 *
 * TableEntry shape:
 *   {
 *     schema: string,           // normalized schema name (default 'public')
 *     table: string,            // normalized table name
 *     body: string,             // raw CREATE TABLE body (between outer parentheses)
 *     description: string,      // COMMENT ON TABLE text, or '' if absent
 *     columns: Record<string, string>,  // key: normalized col name, value: comment text
 *     foreignKeys: Array<{
 *       columns: string[],          // normalized column name(s)
 *       referencesTable: string,    // schema-qualified normalized: "<schema>.<table>"
 *       referencesColumns: string[] // normalized reference column name(s)
 *     }>
 *   }
 *
 * The warnings array contains strings for:
 *   - identifier collisions (two identifiers normalizing to the same fragment path)
 *   - dangling FKs (FK references a table not in the captured set)
 *
 * @param {string} sqlText - Full SQL text of the combined schema dump.
 * @returns {{ tables: Array, warnings: string[] }}
 */
export function parseSchemaSql(sqlText) {
  const warnings = [];
  // Map from normalized "<schema>.<table>" → TableEntry (last-writer-wins)
  const tableMap = new Map();
  // Track collision: normalized key → array of original identifiers seen
  const seenOriginals = new Map();

  // -------------------------------------------------------------------------
  // Step 1: Extract CREATE TABLE blocks
  // -------------------------------------------------------------------------
  // Regex: matches CREATE TABLE [IF NOT EXISTS] [schema.]table ( body )
  // The body capture uses a balanced-paren approach via a manual scan below.
  // First, capture the table header and then extract the body manually.
  const createTableHeaderRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/gi;

  let match;
  while ((match = createTableHeaderRe.exec(sqlText)) !== null) {
    const rawSchema = match[1] || 'public';
    const rawTable = match[2];
    const normSchema = normalizeIdentifier(rawSchema);
    const normTable = normalizeIdentifier(rawTable);
    const normKey = `${normSchema}.${normTable}`;

    // Extract the body between the outer parentheses
    const openParenPos = match.index + match[0].length - 1; // position of the '('
    const body = extractBalancedBody(sqlText, openParenPos);

    const originalId = `${rawSchema}.${rawTable}`;

    // Collision detection
    if (tableMap.has(normKey)) {
      const prevOriginal = seenOriginals.get(normKey);
      warnings.push(
        `identifier collision: '${prevOriginal}' and '${originalId}' both normalize to '${normKey}'`
      );
    }

    // Last-writer-wins
    const entry = {
      schema: normSchema,
      table: normTable,
      body,
      description: '',
      columns: {},
      foreignKeys: [],
    };
    tableMap.set(normKey, entry);
    seenOriginals.set(normKey, originalId);
  }

  // -------------------------------------------------------------------------
  // Step 2: Extract COMMENT ON TABLE statements
  // -------------------------------------------------------------------------
  // COMMENT ON TABLE [schema.]table IS 'text';
  const commentTableRe = /COMMENT\s+ON\s+TABLE\s+(?:"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+IS\s+'((?:[^'\\]|\\.|'')*)'\s*;/gi;

  while ((match = commentTableRe.exec(sqlText)) !== null) {
    const rawSchema = match[1] || 'public';
    const rawTable = match[2];
    const text = match[3].replace(/''/g, "'");
    const normKey = `${normalizeIdentifier(rawSchema)}.${normalizeIdentifier(rawTable)}`;
    if (tableMap.has(normKey)) {
      tableMap.get(normKey).description = text;
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Extract COMMENT ON COLUMN statements
  // -------------------------------------------------------------------------
  // COMMENT ON COLUMN [schema.]table.col IS 'text';
  const commentColRe = /COMMENT\s+ON\s+COLUMN\s+(?:"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s+IS\s+'((?:[^'\\]|\\.|'')*)'\s*;/gi;

  while ((match = commentColRe.exec(sqlText)) !== null) {
    const rawSchema = match[1] || 'public';
    const rawTable = match[2];
    const rawCol = match[3];
    const text = match[4].replace(/''/g, "'");
    const normKey = `${normalizeIdentifier(rawSchema)}.${normalizeIdentifier(rawTable)}`;
    const normCol = normalizeIdentifier(rawCol);
    if (tableMap.has(normKey)) {
      tableMap.get(normKey).columns[normCol] = text;
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Extract foreign keys — standalone ALTER TABLE form
  // -------------------------------------------------------------------------
  // ALTER TABLE [ONLY] [schema.]table ADD CONSTRAINT name FOREIGN KEY (cols)
  //   REFERENCES [schema.]reftable (refcols) [ON DELETE action] [ON UPDATE action];
  // Use 's' (dotAll) flag for multi-line matching.
  const alterFkRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ADD\s+CONSTRAINT\s+"?[A-Za-z_][A-Za-z0-9_]*"?\s+FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+(?:"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(([^)]+)\)[^;]*;/gis;

  while ((match = alterFkRe.exec(sqlText)) !== null) {
    const rawSchema = match[1] || 'public';
    const rawTable = match[2];
    const colsRaw = match[3];
    const refSchemaRaw = match[4]; // may be undefined
    const refTableRaw = match[5];
    const refColsRaw = match[6];

    const normOwnerSchema = normalizeIdentifier(rawSchema);
    const normOwnerTable = normalizeIdentifier(rawTable);
    const normKey = `${normOwnerSchema}.${normOwnerTable}`;

    if (!tableMap.has(normKey)) continue;

    const cols = colsRaw.split(',').map(c => normalizeIdentifier(c.trim()));
    const refCols = refColsRaw.split(',').map(c => normalizeIdentifier(c.trim()));

    // Schema qualification for reference table
    const normRefSchema = refSchemaRaw
      ? normalizeIdentifier(refSchemaRaw)
      : (normOwnerSchema || 'public');
    const normRefTable = normalizeIdentifier(refTableRaw);
    const referencesTable = `${normRefSchema}.${normRefTable}`;

    tableMap.get(normKey).foreignKeys.push({
      columns: cols,
      referencesTable,
      referencesColumns: refCols,
    });
  }

  // -------------------------------------------------------------------------
  // Step 5: Extract foreign keys — inline REFERENCES form within CREATE TABLE body
  // -------------------------------------------------------------------------
  // For each table entry, scan its body for inline REFERENCES clauses.
  // Pattern: column_def ... REFERENCES [schema.]reftable (refcol)
  for (const [normKey, entry] of tableMap) {
    const inlineFkRe = /"?([A-Za-z_][A-Za-z0-9_]*)"?\s+[A-Za-z][A-Za-z0-9_ ,()]*?\s+REFERENCES\s+(?:"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\)/gi;
    let m;
    while ((m = inlineFkRe.exec(entry.body)) !== null) {
      const rawCol = m[1];
      const refSchemaRaw = m[2]; // may be undefined
      const refTableRaw = m[3];
      const refColRaw = m[4];

      const normCol = normalizeIdentifier(rawCol);
      const normRefSchema = refSchemaRaw
        ? normalizeIdentifier(refSchemaRaw)
        : (entry.schema || 'public');
      const normRefTable = normalizeIdentifier(refTableRaw);
      const referencesTable = `${normRefSchema}.${normRefTable}`;
      const normRefCol = normalizeIdentifier(refColRaw);

      entry.foreignKeys.push({
        columns: [normCol],
        referencesTable,
        referencesColumns: [normRefCol],
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Detect dangling FKs
  // -------------------------------------------------------------------------
  const allTableKeys = new Set(tableMap.keys());
  for (const [normKey, entry] of tableMap) {
    for (const fk of entry.foreignKeys) {
      if (!allTableKeys.has(fk.referencesTable)) {
        warnings.push(
          `dangling FK: table '${normKey}' references '${fk.referencesTable}' which is not in the captured set`
        );
      }
    }
  }

  return { tables: Array.from(tableMap.values()), warnings };
}

// ---------------------------------------------------------------------------
// Internal helper: extract balanced parenthesis body
// ---------------------------------------------------------------------------

/**
 * Extract the content between a matched opening '(' and its balanced closing ')'.
 *
 * @param {string} text - Full SQL text.
 * @param {number} openPos - Index of the opening '(' in `text`.
 * @returns {string} The content between the outer parentheses (exclusive).
 */
function extractBalancedBody(text, openPos) {
  let depth = 0;
  let start = -1;
  for (let i = openPos; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
      if (depth === 1) start = i + 1;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i);
      }
    } else if (ch === "'") {
      // Skip string literals to avoid counting parens inside strings
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2; // escaped single quote
        } else if (text[i] === "'") {
          break;
        } else {
          i++;
        }
      }
    } else if (ch === '-' && text[i + 1] === '-') {
      // Skip line comment
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      // Skip block comment
      i += 2;
      while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// renderTableMarkdown(entry)
// ---------------------------------------------------------------------------

/**
 * Render a single table entry as a Markdown fragment.
 *
 * Produces five sections:
 *   # Schema: <schema>.<table>
 *   ## Goal
 *   ## Table Definition
 *   ## Columns
 *   ## Relationships
 *
 * Consumes raw camelCase parser fields (foreignKeys, referencesTable, referencesColumns).
 * Does NOT translate to snake_case — that is buildDatabaseIndexJson's sole responsibility.
 *
 * @param {object} entry - TableEntry from parseSchemaSql.
 * @returns {string} Markdown content.
 */
export function renderTableMarkdown(entry) {
  const lines = [];

  // Section 1: Title
  lines.push(`# Schema: ${entry.schema}.${entry.table}`);
  lines.push('');

  // Section 2: Goal
  lines.push('## Goal');
  lines.push('');
  if (entry.description) {
    lines.push(entry.description);
  } else {
    lines.push('');
  }
  lines.push('');

  // Section 3: Table Definition
  lines.push('## Table Definition');
  lines.push('');
  lines.push('```sql');
  lines.push(entry.body.trim());
  lines.push('```');
  lines.push('');

  // Section 4: Columns
  lines.push('## Columns');
  lines.push('');
  const colEntries = Object.entries(entry.columns);
  if (colEntries.length === 0) {
    lines.push('_No column comments defined._');
  } else {
    lines.push('| Column | Description |');
    lines.push('|--------|-------------|');
    for (const [col, desc] of colEntries) {
      lines.push(`| ${col} | ${desc} |`);
    }
  }
  lines.push('');

  // Section 5: Relationships — consume raw camelCase fields (AC 5)
  lines.push('## Relationships');
  lines.push('');
  if (entry.foreignKeys.length === 0) {
    lines.push('_No foreign keys defined._');
  } else {
    for (const fk of entry.foreignKeys) {
      const cols = fk.columns.join(', ');
      const refCols = fk.referencesColumns.join(', ');
      lines.push(`- \`${cols}\` → \`${fk.referencesTable}(${refCols})\``);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderDatabaseIndex(name, version, tablesBySchema)
// ---------------------------------------------------------------------------

/**
 * Render a human-readable Table of Contents (index.md) for a database capture.
 *
 * @param {string} name - Database name (kebab).
 * @param {string} version - Version string.
 * @param {Map<string, Map<string, object>>|object} tablesBySchema
 *   A map/object of schema → map/object of table → entry.
 * @returns {string} Markdown index content.
 */
export function renderDatabaseIndex(name, version, tablesBySchema) {
  const lines = [];

  lines.push(`# Database Index: ${name} v${version}`);
  lines.push('');
  lines.push('> This is a derived structural view. `schema.sql` is the complete source of truth.');
  lines.push('');

  const schemas = tablesBySchema instanceof Map
    ? [...tablesBySchema.entries()]
    : Object.entries(tablesBySchema);

  if (schemas.length === 0) {
    lines.push('_0 tables parsed (source preserved in schema.sql)._');
    lines.push('');
    return lines.join('\n');
  }

  for (const [schema, tables] of schemas) {
    const tableEntries = tables instanceof Map
      ? [...tables.entries()]
      : Object.entries(tables);
    lines.push(`## ${schema}`);
    lines.push('');
    lines.push(`_${tableEntries.length} table(s)_`);
    lines.push('');
    for (const [table] of tableEntries) {
      lines.push(`- [${table}](schema/${schema}/tables/${table}.md)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// buildDatabaseIndexJson(name, version, checksum, projectRelPath, tablesBySchema)
// ---------------------------------------------------------------------------

/**
 * Build the machine-readable index.json object for a database capture.
 *
 * This function is the SOLE translator from camelCase parser field names
 * (foreignKeys, referencesTable, referencesColumns) to the snake_case
 * names required by index.json (foreign_keys, references_table, references_columns).
 *
 * @param {string} name - Database name (kebab).
 * @param {string} version - Version string.
 * @param {string} checksum - sha256 checksum string (e.g. "sha256:abc123…").
 * @param {string} projectRelPath - Repo-relative project path (e.g. "projects/shp-sk").
 * @param {Map<string, Map<string, object>>|object} tablesBySchema
 *   A map/object of schema → map/object of table → entry (with foreignKeys array).
 * @param {string[]} [extraWarnings] - Additional warnings from parseSchemaSql to merge in.
 * @returns {object} The index object (caller does JSON.stringify(obj, null, 2)).
 */
export function buildDatabaseIndexJson(name, version, checksum, projectRelPath, tablesBySchema, extraWarnings = []) {
  const generatedAt = formatBangkokTimestamp();
  const warnings = [...extraWarnings];

  const schemas = tablesBySchema instanceof Map
    ? [...tablesBySchema.entries()]
    : Object.entries(tablesBySchema);

  // Check for zero tables
  const totalTables = schemas.reduce((sum, [, tables]) => {
    const t = tables instanceof Map ? tables.size : Object.keys(tables).length;
    return sum + t;
  }, 0);

  if (totalTables === 0) {
    return {
      schema_version: DATABASE_INDEX_SCHEMA_VERSION,
      generated_at: generatedAt,
      scope: 'database',
      database: name,
      version,
      built_from_checksum: checksum,
      schemas: {},
      warnings: ['0 tables parsed (source preserved in schema.sql)', ...warnings],
    };
  }

  // Build schemas map
  const schemasObj = {};
  for (const [schema, tables] of schemas) {
    const tableEntries = tables instanceof Map
      ? [...tables.entries()]
      : Object.entries(tables);

    schemasObj[schema] = { tables: {} };
    for (const [table, entry] of tableEntries) {
      // Repo-relative path invariant: full projects/<name>/… prefix
      const path = `${projectRelPath}/databases/${name}-${version}/schema/${schema}/tables/${table}.md`;

      // camelCase → snake_case translation (only here — AC 5, AC 13)
      // Note: dangling FK detection is NOT repeated here — it is performed once in
      // parseSchemaSql (Step 6) and surfaced via extraWarnings. Repeating it would
      // produce duplicate warnings when the caller passes parseWarnings as extraWarnings.
      const foreignKeys = (entry.foreignKeys || []).map(fk => {
        return {
          columns: fk.columns,
          references_table: fk.referencesTable,       // camelCase → snake_case
          references_columns: fk.referencesColumns,   // camelCase → snake_case
        };
      });

      schemasObj[schema].tables[table] = {
        path,
        description: entry.description || '',
        columns: Object.keys(entry.columns || {}),
        foreign_keys: foreignKeys,                   // camelCase → snake_case
      };
    }
  }

  return {
    schema_version: DATABASE_INDEX_SCHEMA_VERSION,
    generated_at: generatedAt,
    scope: 'database',
    database: name,
    version,
    built_from_checksum: checksum,
    schemas: schemasObj,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Internal: Bangkok ISO-8601 timestamp
// ---------------------------------------------------------------------------

/**
 * Return current time as an ISO-8601 string with Asia/Bangkok (+07:00) offset.
 * Uses Intl.DateTimeFormat — same convention as formatBangkokStamp in stamp.mjs.
 *
 * @returns {string} e.g. "2026-06-03T15:30:00+07:00"
 */
function formatBangkokTimestamp() {
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
  // Compose ISO-8601 string with +07:00 offset
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+07:00`;
}
