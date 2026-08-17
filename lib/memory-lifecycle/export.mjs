// lib/memory-lifecycle/export.mjs
// `sidekicks memory export <namespace> [--dir <path>] [--json]`
//
// Emit ONE namespace as a portable folder — its entry files, its evidence, and a
// filtered index — so a project that leaves this workspace can take its knowledge with
// it. This is the mitigation for the trade the central store makes: memory now belongs
// to the workspace rather than to the project's own repo, so there has to be a way out
// that is not "copy files by hand and hope".
//
// Writes OUTSIDE the CLI write surface by design (an export target is the user's own
// path), so it refuses a target inside `.sidekicks/` or `projects/` — those are the
// CLI's territory and an export there would look like a second live store.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { layerForNamespace, storeRoot } from '../active-scope/memory-paths.mjs';
import { parseMemoryFlags, listEntrySlugs, listNamespaces } from './_shared.mjs';
import { readIndexJson } from './_store.mjs';

/** Recursively copy a directory with plain fs — no shell, works on Windows. */
function copyTree(from, to) {
  let items;
  try { items = readdirSync(from, { withFileTypes: true }); } catch { return 0; }
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const it of items) {
    const src = join(from, it.name);
    const dst = join(to, it.name);
    if (it.isDirectory()) n += copyTree(src, dst);
    else {
      try { writeFileSync(dst, readFileSync(src)); n += 1; } catch { /* skip unreadable */ }
    }
  }
  return n;
}

/**
 * Run `memory export`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args - args.name is the namespace ('root' | 'projects/<p>' | 'agents/<n>')
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json']);
  const namespace = args.name != null ? String(args.name).trim() : '';
  if (!namespace) {
    throw new SidekicksError(
      `memory export: a <namespace> is required — one of: ${listNamespaces(repoRoot).join(', ')}`,
      EXIT_VALIDATION
    );
  }
  if (!listNamespaces(repoRoot).includes(namespace)) {
    throw new SidekicksError(
      `memory export: no namespace '${namespace}' in the store — have: ${listNamespaces(repoRoot).join(', ')}`,
      EXIT_NOT_FOUND
    );
  }

  const layer = layerForNamespace(repoRoot, namespace);
  const slugs = listEntrySlugs(layer.baseDir);

  // Default target: a sibling of the repo, never inside it — an export that lands in
  // the repo reads as a second live store the next time somebody greps for entries.
  const slug = namespace.replace(/\//g, '-');
  const target = flags.dir
    ? (isAbsolute(String(flags.dir)) ? resolve(String(flags.dir)) : resolve(repoRoot, String(flags.dir)))
    : resolve(repoRoot, '..', `memory-export-${slug}`);

  const inside = target === repoRoot || target.startsWith(repoRoot + sep);
  if (inside) {
    const relTarget = relative(repoRoot, target).replace(/\\/g, '/');
    if (relTarget.startsWith('.sidekicks') || relTarget.startsWith('projects/')) {
      throw new SidekicksError(
        `memory export: refusing to write into '${relTarget}' — that is the CLI's own write surface `
          + `(Rule 1), and an export there would look like a second live store. Pass --dir <path> outside it.`,
        EXIT_VALIDATION
      );
    }
  }

  mkdirSync(join(target, 'entries'), { recursive: true });
  let copied = 0;
  for (const s of slugs) {
    const src = join(layer.baseDir, `${s}.md`);
    try { writeFileSync(join(target, 'entries', `${s}.md`), readFileSync(src)); copied += 1; } catch { /* skip */ }
  }

  // Evidence travels with the entries it anchors — an exported entry whose lineage
  // stayed behind is an entry whose `source:` dangles the moment it lands elsewhere.
  const evidenceFrom = join(storeRoot(repoRoot), 'evidence', ...namespace.split('/'));
  let evidenceFiles = 0;
  if (existsSync(evidenceFrom)) evidenceFiles = copyTree(evidenceFrom, join(target, 'evidence'));

  const index = readIndexJson(repoRoot);
  const rows = index.entries.filter((e) => e.namespace === namespace);
  const manifest = {
    schema: 'memory-export/v1',
    namespace,
    exported_from: 'sidekicks central memory store (.sidekicks/memory/)',
    count: rows.length,
    entries: rows,
  };
  writeFileSync(join(target, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(target, 'README.md'), [
    `# Memory export — ${namespace}`,
    '',
    `${copied} entr${copied === 1 ? 'y' : 'ies'}${evidenceFiles ? ` + ${evidenceFiles} evidence file(s)` : ''}.`,
    '',
    'Ingest into another workspace with:',
    '',
    '```sh',
    `sidekicks memory import <this-folder> --namespace ${namespace}`,
    '```',
    '',
    'Entry files are plain markdown with YAML frontmatter — readable without the CLI.',
    '',
  ].join('\n'));

  const targetShown = isAbsolute(String(flags.dir ?? '')) ? target : relative(repoRoot, target).replace(/\\/g, '/');

  if (flags.json) {
    return {
      stdout: JSON.stringify({ namespace, target: targetShown, entries: copied, evidence: evidenceFiles }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  return {
    stdout: `exported ${copied} entr${copied === 1 ? 'y' : 'ies'} from '${namespace}' to ${targetShown}/`
      + `${evidenceFiles ? ` (+${evidenceFiles} evidence file(s))` : ''}\n`,
    exitCode: EXIT_OK,
  };
}
