// lib/catalog-lifecycle/render.mjs
// The three faces of one model: machine JSON, human Markdown, and a fingerprint over either.
//
// serializeCatalog IS the byte contract. Two-space JSON with a terminal newline, and no
// re-ordering here: model.mjs already fixed both the key order (object-literal insertion order,
// which JSON.stringify preserves) and every array's sort. Anything that reorders at render time
// would make the file depend on which renderer ran, which is the drift the check exists to catch.
//
// Zero npm dependencies -- node:* only.

import { createHash } from 'node:crypto';
import { CATALOG_SECTIONS } from './model.mjs';

/**
 * The catalog's canonical JSON bytes -- what lands in both generated JSON files.
 *
 * @param {object} model
 * @returns {string}
 */
export function serializeCatalog(model) {
  return `${JSON.stringify(model, null, 2)}\n`;
}

/**
 * A content fingerprint over the catalog, optionally with whole sections omitted.
 *
 * `omitSections` exists for ONE caller: a packaged `catalog check`. An assembled package may be
 * built with `--include-config=false`, which legitimately drops
 * `.sidekicks/config/cli-executors.json`, so the packaged catalog's `executors` section resolves to
 * the built-in defaults alone. Comparing the full fingerprint would report that deliberate,
 * documented omission as drift. Omitting the one environment-derived section lets the packaged
 * check still prove that every DECLARATION-derived section travelled unchanged.
 *
 * @param {object} model
 * @param {{omitSections?: string[]}} [opts]
 * @returns {string} `sha256:<hex>`
 */
export function catalogFingerprint(model, opts = {}) {
  const omit = new Set(opts.omitSections || []);
  let subject = model;
  if (omit.size) {
    subject = { schema_version: model.schema_version };
    for (const name of CATALOG_SECTIONS) {
      if (omit.has(name)) continue;
      subject[name] = model[name];
    }
  }
  return `sha256:${createHash('sha256').update(serializeCatalog(subject), 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** Escape the one character that would break a Markdown table cell. */
function cell(value) {
  if (value === null || value === undefined) return '';
  return String(value).split('|').join('\\|').split('\n').join(' ').split('\r').join('');
}

function table(headers, rows) {
  const out = [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
  ];
  for (const row of rows) out.push(`| ${row.map(cell).join(' | ')} |`);
  return out;
}

/**
 * The human face. One section per catalog section, every count derived from the model rather than
 * written by hand -- which is the whole point: a count in prose is a count nothing checks.
 *
 * @param {object} model
 * @param {{section?: string}} [opts] - render only one section (JSON key form)
 * @returns {string} Markdown, LF-terminated
 */
export function renderCatalogMarkdown(model, opts = {}) {
  const only = opts.section || null;
  const lines = [];

  if (!only) {
    lines.push('# Sidekicks framework catalog');
    lines.push('');
    lines.push('<!-- GENERATED FILE -- do not edit by hand. -->');
    lines.push('');
    lines.push('Produced by `sidekicks catalog rebuild` from the declarations that already govern');
    lines.push('each surface (`lib/catalog-lifecycle/`). It carries **no timestamp** and every array');
    lines.push('is sorted by id, so regenerating it on any machine yields identical bytes --');
    lines.push('`sidekicks catalog check` fails when this file and the live declarations disagree.');
    lines.push('');
    lines.push(`Catalog schema version: **${model.schema_version}**`);
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push(...table(['Section', 'Count', 'Authority'], [
      [`[CLI commands](#cli-commands)`, model.cli.command_count, '`lib/sk-cli/help.mjs` (`VERBS`, `NAMESPACES`)'],
      [`[Framework entries](#framework-entries)`, model.framework.entry_count, '`lib/framework-settings/{core-registry,registry}.mjs`'],
      [`[Skills](#skills)`, model.skills.active_count + model.skills.parked_count, '`lib/skill-manifest/read.mjs`'],
      [`[Config blocks](#config-blocks)`, model.config.block_count, '`lib/config-store/read.mjs` (`listBlocks`)'],
      [`[Executors](#executors)`, model.executors.executor_count, '`lib/cli-executor-lifecycle/_shared.mjs`'],
      [`[Durable formats](#durable-formats)`, model.durable_formats.format_count, '`lib/catalog-lifecycle/durable-formats.mjs`'],
    ]));
    lines.push('');
  }

  if (!only || only === 'cli') {
    const s = model.cli;
    lines.push('## CLI commands');
    lines.push('');
    lines.push(`${s.command_count} verbs across ${s.namespace_count} namespaces. Id form `
      + '`cli:<namespace>/<verb>`. Dispatch is convention-based: `lib/sk-cli/cli.mjs` lazily imports'
      + ' `lib/<namespace>-lifecycle/<verb>.mjs` and calls its exported `run(ctx, args)`.');
    lines.push('');
    lines.push(...table(['Namespace', 'Verbs'], s.namespaces.map((n) => [n.namespace, n.command_count])));
    lines.push('');
    for (const ns of s.namespaces) {
      lines.push(`### \`${ns.namespace}\``);
      lines.push('');
      lines.push(...table(['id', 'args', 'summary', 'status'],
        s.commands.filter((c) => c.namespace === ns.namespace)
          .map((c) => [`\`${c.id}\``, c.args ? `\`${c.args}\`` : '', c.summary, c.status])));
      lines.push('');
    }
  }

  if (!only || only === 'framework') {
    const s = model.framework;
    lines.push('## Framework entries');
    lines.push('');
    lines.push(`${s.entry_count} entries: ${s.rule_count} rules, ${s.criterion_count} criteria, `
      + `${s.hook_count} hooks (${s.floor_count} safety-floor ids, which no setting can disable).`);
    lines.push('');
    lines.push(...table(['id', 'kind', 'floor', 'owners', 'body / script', 'source'],
      s.entries.map((e) => [
        `\`${e.id}\``, e.kind, e.floor ? 'yes' : '',
        e.owners.length ? e.owners.join(', ') : '(framework)',
        e.script ? `\`${e.script}\`` : (e.body_at ? `\`${e.body_at}\`` : ''),
        e.source,
      ])));
    lines.push('');
  }

  if (!only || only === 'skills') {
    const s = model.skills;
    lines.push('## Skills');
    lines.push('');
    lines.push(`${s.active_count} active, ${s.parked_count} parked in `
      + '`.sidekicks/skill-offloaded/`. '
      + `${s.edge_count} declared sibling edges, ${s.hard_edge_count} of them hard edges between `
      + 'active skills. Only active hard edges can fail `catalog check`; an `import` cycle is a '
      + 'failure, while mutual composition across a process or handoff boundary is reported here as '
      + 'data.');
    lines.push('');
    lines.push(...table(['id', 'tree', 'manifest', 'skill.yaml', 'hard depends-on'],
      [...s.active, ...s.parked].map((r) => [
        `\`${r.id}\``, r.tree, r.manifest ? 'yes' : '', r.descriptor ? 'yes' : '',
        r.hard_depends_on.length ? r.hard_depends_on.join(', ') : '',
      ])));
    lines.push('');
    lines.push('### Mutual composition (reported, not a failure)');
    lines.push('');
    if (s.mutual_composition.length === 0) {
      lines.push('None.');
    } else {
      for (const c of s.mutual_composition) lines.push(`- ${c.cycle.join(' -> ')} -> ${c.cycle[0]}`);
    }
    lines.push('');
  }

  if (!only || only === 'config') {
    const s = model.config;
    lines.push('## Config blocks');
    lines.push('');
    lines.push(`${s.block_count} blocks across ${s.family_count} family files. Id form `
      + '`config:<block>`. A block nothing declares resolves to nothing and fails `config doctor`.');
    lines.push('');
    lines.push(...table(['id', 'family', 'owners', 'scope', 'inherits root', 'merge', 'defaults'],
      s.blocks.map((b) => [
        `\`${b.id}\``, b.family, b.owners.length ? b.owners.join(', ') : '(framework)',
        b.scope || '', b.inherits_root ? 'yes' : '', b.merge || '',
        b.defaults ? `\`${b.defaults}\`` : '',
      ])));
    lines.push('');
  }

  if (!only || only === 'executors') {
    const s = model.executors;
    lines.push('## Executors');
    lines.push('');
    lines.push(`${s.executor_count} executors resolved from \`${s.registry_file}\` `
      + `(${s.registry_present ? 'present' : 'absent -- built-in defaults only'}) merged over the `
      + 'built-in defaults. Id form `executor:<name>`. Launch fields (`binary`, `invoke`, '
      + '`brief_stdin`) are deliberately NOT cataloged: they can carry a machine-absolute path.');
    if (s.routing_prefer.length) {
      lines.push('');
      lines.push(`Routing preference chain: ${s.routing_prefer.map((n) => `\`${n}\``).join(' > ')}`);
    }
    lines.push('');
    lines.push(...table(['id', 'builtin', 'registered', 'enabled', 'transport', 'sandbox', 'model tiers'],
      s.executors.map((e) => [
        `\`${e.id}\``, e.builtin ? 'yes' : '', e.registered ? 'yes' : '', e.enabled ? 'yes' : 'no',
        e.transport || '', e.sandbox || '', e.model_tiers.join(', '),
      ])));
    lines.push('');
  }

  if (!only || only === 'durable_formats') {
    const s = model.durable_formats;
    lines.push('## Durable formats');
    lines.push('');
    lines.push(`${s.format_count} durable on-disk formats. Id form \`format:<id>\`. This is the one `
      + 'AUTHORED section -- a durable format has no declaration elsewhere to derive it from -- so '
      + '`catalog check` proves every owner, reader and writer path in it still exists.');
    lines.push('');
    lines.push(...table(['id', 'schema', 'path pattern', 'owner', 'reader', 'writer'],
      s.formats.map((f) => [
        `\`${f.id}\``, f.schema_version === null ? '(unversioned)' : String(f.schema_version),
        `\`${f.path_pattern}\``, `\`${f.owner}\``, `\`${f.reader}\``,
        f.writer ? `\`${f.writer}\`` : '',
      ])));
    lines.push('');
    lines.push(...table(['id', 'compatibility'], s.formats.map((f) => [`\`${f.id}\``, f.compatibility])));
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
