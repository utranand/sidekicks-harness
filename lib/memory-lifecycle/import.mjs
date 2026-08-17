// lib/memory-lifecycle/import.mjs
// `sidekicks memory import <dir> [--namespace <ns>] [--force] [--json]`
//
// Ingest a folder produced by `memory export` back into the central store. The inverse
// of export, and the other half of the trade the central store makes: knowledge can
// leave the workspace and come back without anyone hand-copying files.
//
// Refuses to overwrite an existing entry without --force, and reports every skip by
// name. A silent overwrite here would destroy the local refinement of a shared entry —
// exactly the thing the namespace collision rules exist to protect.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { layerForNamespace, storeRoot } from '../active-scope/memory-paths.mjs';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { parseMemoryFlags, parseEntryFile, SLUG_RE } from './_shared.mjs';
import { syncStoreFaces } from './_store.mjs';

/** Copy an evidence tree into the store, one file at a time (surface-gated). */
function importEvidence(repoRoot, from, toBase) {
  let n = 0;
  const walk = (src, dst) => {
    let items;
    try { items = readdirSync(src, { withFileTypes: true }); } catch { return; }
    mkdirp(dst);
    for (const it of items) {
      const s = join(src, it.name);
      const d = join(dst, it.name);
      if (it.isDirectory()) { walk(s, d); continue; }
      try {
        assertWritable(d, repoRoot);
        writeAtomic(d, readFileSync(s, 'utf8'));
        n += 1;
      } catch { /* skip unreadable/unwritable */ }
    }
  };
  walk(from, toBase);
  return n;
}

/**
 * Run `memory import`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args - args.name is the export folder
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'force']);
  const dirArg = args.name != null ? String(args.name).trim() : '';
  if (!dirArg) {
    throw new SidekicksError(
      "memory import: a <dir> is required — the folder 'sidekicks memory export' produced",
      EXIT_VALIDATION
    );
  }
  const dir = isAbsolute(dirArg) ? resolve(dirArg) : resolve(repoRoot, dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new SidekicksError(`memory import: '${dirArg}' is not a directory`, EXIT_NOT_FOUND);
  }

  // The manifest names the namespace the export came from; --namespace overrides it
  // (importing another workspace's project namespace into a differently-named project
  // is the ordinary case, not the exception).
  let manifest = null;
  const manifestPath = join(dir, 'index.json');
  if (existsSync(manifestPath)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { manifest = null; }
  }
  const namespace = flags.namespace ? String(flags.namespace) : (manifest?.namespace ?? null);
  if (!namespace) {
    throw new SidekicksError(
      'memory import: the folder carries no index.json namespace — pass --namespace <root|projects/<p>|agents/<n>>',
      EXIT_VALIDATION
    );
  }

  const entriesDir = existsSync(join(dir, 'entries')) ? join(dir, 'entries') : dir;
  let files;
  try {
    files = readdirSync(entriesDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'README.md');
  } catch (err) {
    throw new SidekicksError(`memory import: cannot read '${dirArg}' — ${err.message}`, EXIT_VALIDATION);
  }

  const layer = layerForNamespace(repoRoot, namespace);
  mkdirp(layer.baseDir);

  const imported = [];
  const skipped = [];
  const rejected = [];
  for (const f of files.sort()) {
    const slug = f.slice(0, -3);
    if (!SLUG_RE.test(slug)) { rejected.push(`${f} (not a kebab-case slug)`); continue; }
    let text;
    try { text = readFileSync(join(entriesDir, f), 'utf8'); } catch { rejected.push(`${f} (unreadable)`); continue; }
    // Anything without parseable frontmatter is not an entry — importing it would put a
    // file in the store that every reader silently skips.
    const { frontmatter } = parseEntryFile(text);
    if (!frontmatter || typeof frontmatter !== 'object' || !frontmatter.name) {
      rejected.push(`${f} (no entry frontmatter)`);
      continue;
    }
    const target = join(layer.baseDir, f);
    if (existsSync(target) && !flags.force) { skipped.push(slug); continue; }
    assertWritable(target, repoRoot);
    writeAtomic(target, text);
    imported.push(slug);
  }

  let evidence = 0;
  const evidenceFrom = join(dir, 'evidence');
  if (existsSync(evidenceFrom)) {
    evidence = importEvidence(
      repoRoot,
      evidenceFrom,
      join(storeRoot(repoRoot), 'evidence', ...namespace.split('/'))
    );
  }

  syncStoreFaces(repoRoot);

  if (flags.json) {
    return {
      stdout: JSON.stringify({ namespace, imported, skipped, rejected, evidence }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const out = [
    `imported ${imported.length} entr${imported.length === 1 ? 'y' : 'ies'} into '${namespace}' (${layer.baseDirRel}/)`
      + `${evidence ? ` + ${evidence} evidence file(s)` : ''}`,
  ];
  if (skipped.length) out.push(`skipped ${skipped.length} already present (pass --force to overwrite): ${skipped.join(', ')}`);
  if (rejected.length) out.push(`rejected ${rejected.length}: ${rejected.join(', ')}`);
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
