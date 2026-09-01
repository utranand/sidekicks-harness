// lib/memory-lifecycle/publish.mjs
// `sidekicks memory publish <name> [--namespaces a,b] [--message <m>] [--push] [--dry-run] [--json]`
//
// PUSH: send the local store OUT to a registered source. The other half of `memory sync`, and the
// reason untracking the store does not strand it: git no longer carries the entries off this
// machine, so something has to, and this is it.
//
// The published folder is written in the LIVE STORE SHAPE — root entries at the top level, the
// other namespaces under `store/`, evidence under `evidence/` — so a `memory sync` of the same
// source reads it back with every namespace intact. A flattened export would need a namespace
// argument on the way back in and would lose the distinction between two namespaces holding the
// same slug.
//
// PUSHING IS NOT THE DEFAULT. A git push publishes to a remote other people read; that is an
// outward-facing action, and this verb never takes it on its own initiative. Without `--push` the
// commit is made in the local cache clone and the exact push command is printed for a human to
// approve. `--push` is that approval, passed explicitly.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION, EXIT_GIT, SidekicksError } from '../sk-cli/errors.mjs';
import { layerForNamespace, storeRoot } from '../active-scope/memory-paths.mjs';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { parseMemoryFlags, listNamespaces, listEntrySlugs, byCodeUnit } from './_shared.mjs';
import { readIndexJson } from './_store.mjs';
import { requireSource, refreshSource, resolveSourcePath, namespaceAllowed, git } from './_sources.mjs';

/** Where a namespace's entries sit inside a published folder — the live store layout. */
function publishedDirFor(base, namespace) {
  return namespace === 'root' ? base : join(base, 'store', ...namespace.split('/'));
}

/** Recursively copy a tree with plain fs — no shell, identical on macOS and Windows. */
function copyTree(from, to, dryRun) {
  let items;
  try { items = readdirSync(from, { withFileTypes: true }); } catch { return 0; }
  if (!dryRun) mkdirp(to);
  let n = 0;
  for (const it of items) {
    const src = join(from, it.name);
    const dst = join(to, it.name);
    if (it.isDirectory()) { n += copyTree(src, dst, dryRun); continue; }
    try {
      if (!dryRun) writeAtomic(dst, readFileSync(src, 'utf8'));
      n += 1;
    } catch { /* skip unreadable */ }
  }
  return n;
}

/**
 * Mirror the selected namespaces of the local store into a destination folder.
 * Entries that no longer exist locally are removed from the destination, so a publish is a mirror
 * rather than an append-only pile — an entry deleted here must not come back on the next sync.
 *
 * @returns {{ written: string[], removed: string[], evidence: number }}
 */
function mirrorStore(repoRoot, dest, namespaces, dryRun) {
  const written = [];
  const removed = [];

  for (const namespace of namespaces) {
    const layer = layerForNamespace(repoRoot, namespace);
    const slugs = listEntrySlugs(layer.baseDir);
    const outDir = publishedDirFor(dest, namespace);
    if (!dryRun && slugs.length) mkdirp(outDir);

    const keep = new Set(slugs.map((s) => `${s}.md`));
    for (const slug of slugs) {
      const src = join(layer.baseDir, `${slug}.md`);
      const dst = join(outDir, `${slug}.md`);
      let text;
      try { text = readFileSync(src, 'utf8'); } catch { continue; }
      let current = null;
      try { current = readFileSync(dst, 'utf8'); } catch { current = null; }
      if (current === text) continue;
      if (!dryRun) writeAtomic(dst, text);
      written.push(`${namespace}/${slug}`);
    }

    // Prune only the entry files this namespace owns — never a README, never the manifest.
    if (existsSync(outDir)) {
      let present = [];
      try { present = readdirSync(outDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'README.md'); } catch { present = []; }
      for (const f of present.sort(byCodeUnit)) {
        if (keep.has(f)) continue;
        if (!dryRun) { try { rmSync(join(outDir, f)); } catch { /* ignore */ } }
        removed.push(`${namespace}/${f.slice(0, -3)}`);
      }
    }
  }

  let evidence = 0;
  const evidenceFrom = join(storeRoot(repoRoot), 'evidence');
  if (existsSync(evidenceFrom)) {
    for (const namespace of namespaces) {
      const from = join(evidenceFrom, ...namespace.split('/'));
      if (!existsSync(from)) continue;
      evidence += copyTree(from, join(dest, 'evidence', ...namespace.split('/')), dryRun);
    }
  }

  return { written, removed, evidence };
}

/** The manifest + README a published folder carries, so it is legible without the CLI. */
function writeManifest(repoRoot, dest, namespaces, counts, dryRun) {
  const index = readIndexJson(repoRoot);
  const rows = index.entries.filter((e) => namespaces.includes(e.namespace));
  const manifest = {
    schema: 'memory-export/v1',
    shape: 'store',
    namespaces,
    count: rows.length,
    published_from: 'sidekicks central memory store (.sidekicks/memory/)',
    entries: rows,
  };
  const readme = [
    '# Sidekicks memory — published store',
    '',
    `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} across ${namespaces.length} namespace(s):`,
    ...namespaces.map((n) => `- \`${n}\` — ${counts[n] ?? 0}`),
    '',
    'This folder is a mirror of a live store, in the same layout: root entries at the top level,',
    'other namespaces under `store/`, lineage snapshots under `evidence/`.',
    '',
    'Pull it into another checkout with:',
    '',
    '```sh',
    'sidekicks memory source add <name> --kind dir --path <this-folder>   # or --kind git --url <repo>',
    'sidekicks memory sync <name>',
    '```',
    '',
    'Entry files are plain markdown with YAML frontmatter — readable without the CLI.',
    '',
  ].join('\n');

  if (!dryRun) {
    mkdirp(dest);
    writeAtomic(join(dest, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeAtomic(join(dest, 'README.md'), readme);
  }
  return rows.length;
}

/**
 * Run `memory publish`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args - args.name is the source name
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'dry-run', 'push', 'offline']);
  const dryRun = flags['dry-run'] === true;
  const name = args.name != null ? String(args.name).trim() : '';
  if (!name) {
    throw new SidekicksError(
      "memory publish: a <source> is required — 'sidekicks memory source list' shows them",
      EXIT_VALIDATION
    );
  }
  const source = requireSource(repoRoot, name);

  const requested = String(flags.namespaces ?? '').trim()
    ? String(flags.namespaces).split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const namespaces = listNamespaces(repoRoot)
    .filter((ns) => (requested ? requested.includes(ns) : namespaceAllowed(ns, source.namespaces)));
  if (!namespaces.length) {
    throw new SidekicksError(
      `memory publish: no namespace to publish — the store has ${listNamespaces(repoRoot).join(', ')}`,
      EXIT_VALIDATION
    );
  }

  // Destination: a `dir` source is the folder itself (created on first publish); a `git` source is
  // its cache clone, which is refreshed first so the commit lands on top of what the remote has.
  let dest;
  let cache = null;
  if (source.kind === 'dir') {
    dest = resolveSourcePath(repoRoot, source.path);
    if (source.subdir) dest = join(dest, source.subdir);
    if (!dryRun) mkdirp(dest);
  } else {
    const refreshed = refreshSource(repoRoot, source, { offline: flags.offline === true });
    dest = refreshed.dir;
    cache = refreshed.dir;
  }

  const counts = {};
  for (const ns of namespaces) counts[ns] = listEntrySlugs(layerForNamespace(repoRoot, ns).baseDir).length;

  const mirrored = mirrorStore(repoRoot, dest, namespaces, dryRun);
  const total = writeManifest(repoRoot, dest, namespaces, counts, dryRun);

  const result = {
    source: source.name,
    kind: source.kind,
    dest: dest.startsWith(repoRoot) ? relative(repoRoot, dest).replace(/\\/g, '/') : dest,
    namespaces,
    entries: total,
    written: mirrored.written.length,
    removed: mirrored.removed.length,
    evidence: mirrored.evidence,
    dry_run: dryRun,
  };

  const out = [
    `published ${total} entr${total === 1 ? 'y' : 'ies'} (${namespaces.join(', ')}) to ${result.dest}`
      + `${dryRun ? '  (dry run — nothing written)' : ''}`,
    `  ${mirrored.written.length} updated, ${mirrored.removed.length} removed`
      + `${mirrored.evidence ? `, ${mirrored.evidence} evidence file(s)` : ''}`,
  ];

  if (source.kind === 'git' && !dryRun) {
    const ref = source.ref || 'main';
    const staged = git(['add', '-A', '.'], cache);
    if (!staged.ok) {
      throw new SidekicksError(
        `memory publish: git add failed in the cache clone — ${staged.stderr}`,
        EXIT_GIT
      );
    }
    const pending = git(['status', '--porcelain'], cache);
    if (!pending.stdout) {
      out.push('  the remote already carries this — no commit needed');
      result.committed = false;
    } else {
      const message = String(flags.message ?? '').trim()
        || `memory: publish ${total} entries (${namespaces.join(', ')})`;
      const committed = git(['commit', '--quiet', '-m', message], cache);
      if (!committed.ok) {
        throw new SidekicksError(
          `memory publish: git commit failed in the cache clone — ${committed.stderr}`,
          EXIT_GIT
        );
      }
      const head = git(['rev-parse', '--short', 'HEAD'], cache);
      result.committed = true;
      result.commit = head.ok ? head.stdout : null;
      out.push(`  committed ${result.commit ?? ''} in the cache clone`.trimEnd());
    }

    if (flags.push === true) {
      const pushed = git(['push', 'origin', `HEAD:${ref}`], cache);
      if (!pushed.ok) {
        throw new SidekicksError(
          `memory publish: push to ${source.url} (${ref}) failed — ${pushed.stderr}`,
          EXIT_GIT
        );
      }
      result.pushed = true;
      out.push(`  pushed to ${source.url} (${ref})`);
    } else if (result.committed) {
      result.pushed = false;
      // Never push unasked: this reaches a remote other people read. The command is printed so a
      // human can approve it, or re-run with --push.
      out.push(
        '',
        `NOT pushed — pushing publishes to ${source.url}, which other people read.`,
        `  re-run with --push, or push by hand:  git -C .sidekicks/state/memory-sources/${source.name} push origin HEAD:${ref}`
      );
    }
  }

  if (flags.json) return { stdout: JSON.stringify(result, null, 2) + '\n', exitCode: EXIT_OK };
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
