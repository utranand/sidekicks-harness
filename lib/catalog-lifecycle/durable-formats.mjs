// lib/catalog-lifecycle/durable-formats.mjs
// The ONE explicit registry of durable on-disk formats this substrate reads and writes.
//
// WHY A REGISTRY AND NOT A SCAN. Every other catalog section is derived from a declaration that
// already exists (the VERBS table, the framework registry, skill manifests, config families, the
// executor registry) — deriving it is what keeps the catalog from drifting. A durable FORMAT has no
// such declaration: the fact that `.agents/skills/<skill>/skill.manifest.yaml` is schema 1, that
// lib/skill-manifest/read.mjs reads it and lib/skill-manifest/materialize.mjs writes it, and that a
// consumer may only ADD fields at schema 1, lives in prose across three files and nowhere a machine
// can check. So this table is authored — and `catalog check` proves every path in it exists, which
// is what stops it from rotting into the hand-maintained catalog this whole phase replaces.
//
// FIELDS
//   id              stable, kebab-case; the catalog id is `format:<id>` and MUST NOT be renamed
//   owner           the lib subsystem that defines the format (repo-relative, POSIX)
//   path_pattern    where instances live; `<skill>` / `<project>` / `<agent>` are placeholders
//   schema_version  the integer the format stamps into its own files, or null when it carries none
//   reader          the module that parses it (repo-relative, POSIX)
//   writer          the module that produces it, or null when nothing in-tree writes it
//   compatibility   what a change may and may not do without a schema bump
//
// A row whose `owner`, `reader` or `writer` path no longer exists is a `dangling-reference` finding;
// a row with an empty owner is a `missing-owner` finding. Both fail `catalog check`.
//
// Zero npm dependencies — this module is pure data.

/**
 * @type {ReadonlyArray<{
 *   id: string, owner: string, path_pattern: string, schema_version: number|null,
 *   reader: string, writer: string|null, compatibility: string,
 * }>}
 */
export const DURABLE_FORMATS = Object.freeze([
  Object.freeze({
    id: 'cli-executor-registry',
    owner: 'lib/cli-executor-lifecycle',
    path_pattern: '.sidekicks/config/cli-executors.json',
    schema_version: 1,
    reader: 'lib/cli-executor-lifecycle/_shared.mjs',
    writer: 'lib/cli-executor-lifecycle/_shared.mjs',
    compatibility:
      'A missing file is never an error — it resolves to the built-in defaults. New executor '
      + 'spec keys may be added at schema 1; removing or repurposing one requires a bump.',
  }),
  Object.freeze({
    id: 'config-family-file',
    owner: 'lib/config-store',
    path_pattern: '<scope>/config/<family>.yaml (+ git-ignored <family>.secret.yaml sibling)',
    schema_version: null,
    reader: 'lib/config-store/read.mjs',
    writer: 'lib/config-store/write.mjs',
    compatibility:
      'Unversioned by design: a family file is a bag of declared blocks and a missing file, block '
      + 'or key is never an error — resolution falls through to the owning skill defaults.',
  }),
  Object.freeze({
    id: 'framework-catalog',
    owner: 'lib/catalog-lifecycle',
    path_pattern: 'docs/generated/framework-catalog.json',
    schema_version: 1,
    reader: 'lib/catalog-lifecycle/commands.mjs',
    writer: 'lib/catalog-lifecycle/commands.mjs',
    compatibility:
      'Additive at schema 1: a new section, or a new field on an existing row, is a rebuild. '
      + 'Removing or renaming a section, a row field, or an id form requires a schema bump.',
  }),
  Object.freeze({
    id: 'framework-catalog-snapshot',
    owner: 'lib/catalog-lifecycle',
    path_pattern: 'lib/catalog-lifecycle/framework-catalog.generated.json',
    schema_version: 1,
    reader: 'lib/catalog-lifecycle/commands.mjs',
    writer: 'lib/catalog-lifecycle/commands.mjs',
    compatibility:
      'Byte-identical to the docs JSON. It exists because an assembled package excludes docs/, so '
      + 'this is the copy that travels and the one a packaged `catalog check` validates against.',
  }),
  Object.freeze({
    id: 'framework-enable-map',
    owner: 'lib/framework-settings',
    path_pattern: '.sidekicks/config/settings/{rules,criteria,hooks}.yaml',
    schema_version: null,
    reader: 'lib/framework-settings/resolve.mjs',
    writer: 'lib/framework-settings/materialize.mjs',
    compatibility:
      'Top level IS the slug map — the filename carries the kind, so there is no wrapper key. A '
      + 'missing key and an explicit `true` both mean enabled; a safety-floor id in any layer is a '
      + 'validation error.',
  }),
  Object.freeze({
    id: 'journal-index',
    owner: 'lib/journal-lifecycle',
    path_pattern: '<journal-store>/index.jsonl',
    schema_version: null,
    reader: 'lib/journal-lifecycle/_shared.mjs',
    writer: 'lib/journal-lifecycle/rebuild.mjs',
    compatibility:
      'Derived: re-deriveable from the entry frontmatter by `journal rebuild`, so it is a cache '
      + 'and never the authority for anything.',
  }),
  Object.freeze({
    id: 'memory-store',
    owner: 'lib/memory-lifecycle',
    path_pattern: '.sidekicks/memory/store/**/<slug>.md (+ index.json, graph.json, MEMORY.md)',
    schema_version: null,
    reader: 'lib/memory-lifecycle/_store.mjs',
    writer: 'lib/memory-lifecycle/add.mjs',
    compatibility:
      'Entries are the authority; the three generated faces are regenerated and are never merged. '
      + 'Field-level merge semantics live in lib/memory-lifecycle/_merge.mjs.',
  }),
  Object.freeze({
    id: 'project-service-index',
    owner: 'lib/index-lifecycle',
    path_pattern: 'projects/<project>/index.json',
    schema_version: null,
    reader: 'lib/index-lifecycle/show.mjs',
    writer: 'lib/index-lifecycle/rebuild.mjs',
    compatibility:
      'Committed and may be stale — every recorded path is repo-relative and resolved against the '
      + 'repo root. Rebuilt by `index rebuild`, never hand-edited.',
  }),
  Object.freeze({
    id: 'root-index',
    owner: 'lib/index-lifecycle',
    path_pattern: '.sidekicks/state/index.json',
    schema_version: null,
    reader: 'lib/index-lifecycle/show.mjs',
    writer: 'lib/index-lifecycle/rebuild.mjs',
    compatibility:
      'Git-ignored derived state (lib/state-store/paths.mjs). Regenerated, never migrated: a shape '
      + 'change costs nothing because no instance of it is ever carried forward.',
  }),
  Object.freeze({
    id: 'run-events-sidecar',
    owner: 'lib/run-events',
    path_pattern: '<run-dir>/events.v1.jsonl (+ events.v1.lock, events.v1.recovery/)',
    schema_version: 1,
    reader: 'lib/run-events/store.mjs',
    writer: 'lib/run-events/store.mjs',
    compatibility:
      'DIAGNOSTIC, never authoritative: each engine\'s own ledger stays the resume source. The '
      + 'version is in the FILENAME, so a v2 file sits beside a v1 one rather than migrating it. At '
      + 'schema 1 a reader refuses an unknown REQUIRED schema_version and skips only rows a writer '
      + 'marked `ignorable: true`; only a truncated FINAL line is ever repaired, and it is archived '
      + 'under events.v1.recovery/ rather than dropped.',
  }),
  Object.freeze({
    id: 'skill-manifest',
    owner: 'lib/skill-manifest',
    path_pattern: '.agents/skills/<skill>/skill.manifest.yaml',
    schema_version: 1,
    reader: 'lib/skill-manifest/read.mjs',
    writer: 'lib/skill-manifest/materialize.mjs',
    compatibility:
      '`requires:` is AUTHORED and `config:`/`framework_hooks:`/`bundle:` are DERIVED — a hand edit '
      + 'to a derived section is drift. New authored keys may be added at schema 1.',
  }),
  Object.freeze({
    id: 'skill-registry-receipt',
    owner: 'lib/skill-registry',
    path_pattern: '.sidekicks/registry/skills/<skill>.yaml',
    schema_version: null,
    reader: 'lib/skill-registry/store.mjs',
    writer: 'lib/skill-registry/store.mjs',
    compatibility:
      'One committed receipt per IMPORTED skill, recording an event nothing on disk can '
      + 'reconstruct afterwards. Append-only in spirit: `skill remove` retires a receipt rather '
      + 'than deleting the history.',
  }),
]);
