// lib/memory-lifecycle/source.mjs
// `sidekicks memory source <add|list|show|remove> …`
//
// The registry of EXTERNAL memory sources — where an untracked store syncs from and publishes to.
// The store itself is git-ignored; this registry is not, because it is the only thing that tells a
// fresh clone where its knowledge lives. See lib/memory-lifecycle/_sources.mjs for the contract.
//
// Writes go through the config writer (`memory_sources` block in .sidekicks/config/memory.yaml), so
// the file keeps its banner, never grows a duplicate key, and has exactly one writer (Rule 1).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { EXIT_OK, EXIT_VALIDATION, EXIT_NOT_FOUND, SidekicksError } from '../sk-cli/errors.mjs';
import { parseMemoryFlags, SLUG_RE } from './_shared.mjs';
import {
  readSources, writeSources, resolveSourcePath, portableSourcePath, sourceCacheDir,
  SOURCE_KINDS, STRATEGIES, DEFAULT_STRATEGY, SOURCES_FILE_REL,
} from './_sources.mjs';

const SUBS = ['add', 'list', 'show', 'remove'];

/** Render one source as a human line block. */
function renderSource(s, repoRoot) {
  const lines = [`${s.name}  [${s.kind}]`];
  if (s.kind === 'git') {
    lines.push(`  url:        ${s.url}`);
    lines.push(`  ref:        ${s.ref}`);
    const cache = sourceCacheDir(repoRoot, s.name);
    lines.push(`  cache:      .sidekicks/state/memory-sources/${s.name}${existsSync(cache) ? '' : '  (not cloned yet)'}`);
  } else {
    const abs = resolveSourcePath(repoRoot, s.path);
    lines.push(`  path:       ${s.path}${existsSync(abs) ? '' : '  (absent)'}`);
  }
  if (s.subdir) lines.push(`  subdir:     ${s.subdir}`);
  lines.push(`  namespaces: ${s.namespaces.join(', ')}`);
  if (s.as) lines.push(`  as:         ${s.as}`);
  return lines;
}

/**
 * Run `memory source`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string, rest?: string[] }} args - name = sub-verb, rest[0] = source name
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'force']);
  const sub = args.name || 'list';
  if (!SUBS.includes(sub)) {
    throw new SidekicksError(
      `memory source: expected one of ${SUBS.join(', ')} — e.g. 'sidekicks memory source list'`,
      EXIT_VALIDATION
    );
  }
  const sourceName = Array.isArray(args.rest) ? (args.rest[0] ?? '') : '';
  const registry = readSources(repoRoot);

  if (sub === 'list') {
    if (flags.json) {
      return { stdout: JSON.stringify(registry, null, 2) + '\n', exitCode: EXIT_OK };
    }
    if (!registry.sources.length) {
      return {
        stdout: 'no memory source registered — the store is local-only and nothing can sync it.\n'
          + "  register one:  sidekicks memory source add <name> --kind dir --path <folder>\n"
          + "                 sidekicks memory source add <name> --kind git --url <repo>\n",
        exitCode: EXIT_OK,
      };
    }
    const out = [`memory sources (${registry.sources.length}) — default strategy: ${registry.default_strategy}`, ''];
    for (const s of registry.sources) out.push(...renderSource(s, repoRoot), '');
    out.push(`registry: ${SOURCES_FILE_REL}`);
    return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
  }

  if (sub === 'show') {
    if (!sourceName) {
      throw new SidekicksError('memory source show: a <name> is required', EXIT_VALIDATION);
    }
    const found = registry.sources.find((s) => s.name === sourceName);
    if (!found) {
      throw new SidekicksError(
        `memory source show: no source '${sourceName}' — have: ${registry.sources.map((s) => s.name).join(', ') || '(none)'}`,
        EXIT_NOT_FOUND
      );
    }
    if (flags.json) return { stdout: JSON.stringify(found, null, 2) + '\n', exitCode: EXIT_OK };
    return { stdout: renderSource(found, repoRoot).join('\n') + '\n', exitCode: EXIT_OK };
  }

  if (sub === 'remove') {
    if (!sourceName) {
      throw new SidekicksError('memory source remove: a <name> is required', EXIT_VALIDATION);
    }
    if (!registry.sources.some((s) => s.name === sourceName)) {
      throw new SidekicksError(
        `memory source remove: no source '${sourceName}' is registered`,
        EXIT_NOT_FOUND
      );
    }
    const next = registry.sources.filter((s) => s.name !== sourceName);
    writeSources(repoRoot, { default_strategy: registry.default_strategy, sources: next });
    // The cached clone is deliberately LEFT on disk: it is the last copy of whatever that remote
    // held, and deleting it on a de-registration nobody framed as destructive is not this verb's
    // call. It is derived state under .sidekicks/state/ and safe to delete by hand.
    const msg = `removed memory source '${sourceName}' (${next.length} left)`;
    if (flags.json) {
      return { stdout: JSON.stringify({ removed: sourceName, remaining: next.map((s) => s.name) }, null, 2) + '\n', exitCode: EXIT_OK };
    }
    return { stdout: `${msg}\n`, exitCode: EXIT_OK };
  }

  // add
  if (!sourceName) {
    throw new SidekicksError(
      "memory source add: a <name> is required — e.g. 'sidekicks memory source add home --kind git --url <repo>'",
      EXIT_VALIDATION
    );
  }
  if (!SLUG_RE.test(sourceName)) {
    throw new SidekicksError(
      `memory source add: '${sourceName}' is not a kebab-case name (a-z, 0-9, dashes)`,
      EXIT_VALIDATION
    );
  }
  const url = String(flags.url ?? '').trim();
  // The registry is committed and read on other machines, so an absolute home path is stored back
  // in its portable form (repo-relative, or `~`-prefixed) rather than as one person's /Users/… .
  const path = portableSourcePath(repoRoot, flags.path ?? '');
  let kind = String(flags.kind ?? '').trim();
  if (!kind) kind = url ? 'git' : 'dir';
  if (!SOURCE_KINDS.includes(kind)) {
    throw new SidekicksError(
      `memory source add: --kind must be one of ${SOURCE_KINDS.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  if (kind === 'git' && !url) {
    throw new SidekicksError("memory source add: --kind git needs --url <repo>", EXIT_VALIDATION);
  }
  if (kind === 'dir' && !path) {
    throw new SidekicksError("memory source add: --kind dir needs --path <folder>", EXIT_VALIDATION);
  }

  const existing = registry.sources.find((s) => s.name === sourceName);
  if (existing && !flags.force) {
    throw new SidekicksError(
      `memory source add: '${sourceName}' is already registered — pass --force to replace it`,
      EXIT_VALIDATION
    );
  }

  const namespaces = String(flags.namespaces ?? '').trim()
    ? String(flags.namespaces).split(',').map((s) => s.trim()).filter(Boolean)
    : ['*'];
  const record = {
    name: sourceName,
    kind,
    url: kind === 'git' ? url : '',
    path: kind === 'dir' ? path : '',
    ref: String(flags.ref ?? '').trim() || 'main',
    subdir: String(flags.subdir ?? '').trim(),
    namespaces,
    as: String(flags.as ?? '').trim(),
  };

  // A `dir` source that does not exist yet is allowed — `memory publish` creates it. Saying so is
  // better than refusing: registering the destination before the first publish is the ordinary order.
  let note = null;
  if (kind === 'dir' && !existsSync(resolveSourcePath(repoRoot, path))) {
    note = `note: '${path}' does not exist yet — 'sidekicks memory publish ${sourceName}' will create it`;
  }

  const strategy = String(flags.strategy ?? '').trim();
  if (strategy && !STRATEGIES.includes(strategy)) {
    throw new SidekicksError(
      `memory source add: --strategy must be one of ${STRATEGIES.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const next = registry.sources.filter((s) => s.name !== sourceName).concat([record]);
  const written = writeSources(repoRoot, {
    default_strategy: strategy || registry.default_strategy || DEFAULT_STRATEGY,
    sources: next,
  });

  if (flags.json) {
    return {
      stdout: JSON.stringify({ added: record, registry: written.path, replaced: !!existing }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  const out = [
    `${existing ? 'replaced' : 'registered'} memory source '${sourceName}' [${kind}] in ${written.path}`,
  ];
  if (note) out.push(note);
  out.push(`next: sidekicks memory ${kind === 'dir' && note ? 'publish' : 'sync'} ${sourceName}`);
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
