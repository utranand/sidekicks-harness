// lib/config-lifecycle/migrate.mjs
// `sidekicks config migrate [--scope <name>|--all] [--dry-run] [--prune] [--json]`
//
// Splits a scope's legacy monolith `config.yaml` into one family file per category, routing every
// credential into the git-ignored `<family>.secret.yaml` sibling.
//
// THREE PROPERTIES THIS VERB GUARANTEES, because a configuration migration that silently changes a
// resolved value is worse than no migration at all:
//
//   1. IT REFUSES A DUPLICATED BLOCK. A monolith declaring a block twice cannot be split safely — the
//      loser is already invisible, and picking one would bless a defect. (This repo has paid for that
//      once: memory `shp-config-duplicate-top-level-keys`.)
//   2. IT PROVES EQUIVALENCE PER BLOCK. For every block it moves, the value read back from the new
//      pair of files must deep-equal the value read from the monolith. Any difference aborts the
//      block, and `--prune` refuses to run at all.
//   3. IT IS ADDITIVE. The monolith is left in place, still read as the lowest scope layer, so nothing
//      breaks mid-migration. `--prune` RETIRES it — renamed to config/pending-removal.config.yaml,
//      git-ignored, read by nothing — and only after every block proved equivalent both in memory and
//      re-read from disk. It is never deleted: a configuration file is the one thing a fresh clone
//      cannot reconstruct.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { buildFamilies, CONFIG_DIR, LEGACY_FILE, FAMILIES } from '../config-store/families.mjs';
import { readBlock } from '../config-store/block.mjs';
import {
  splitSecrets, writeBlock, ensureSecretIgnore, ensurePendingIgnore, PENDING_PREFIX,
} from '../config-store/write.mjs';
import { duplicateTopLevelKeys, topLevelKeyLines } from '../config-store/lint.mjs';
import { parseConfigFlags } from './_shared.mjs';

/** Deep structural equality — the equivalence proof, not a JSON string compare (key order differs). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/** Merge the secret half over the plain half, per key, at any depth — what the resolver does. */
function overlay(plain, secret) {
  if (!secret) return plain;
  if (!plain) return secret;
  const out = { ...plain };
  for (const [key, value] of Object.entries(secret)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = overlay(out[key], value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** The retired monolith of a scope, relative to repoRoot — read by nothing, kept for recovery. */
function retiredRelFor(base) {
  return join(base, CONFIG_DIR, `${PENDING_PREFIX}config.yaml`);
}

/**
 * The monolith a scope should be migrated FROM, or null.
 *
 * With `retired`, a scope whose live monolith is already gone falls back to the retired copy. That is
 * the recovery path for a migration that wrote a block WRONG: the retired file is the last faithful
 * record of the pre-split values (it is never deleted for exactly this reason), so re-running against
 * it re-splits the block with today's reader instead of asking a human to retype credentials.
 */
function legacySourceFor(repoRoot, base, retired) {
  if (existsSync(join(repoRoot, base, LEGACY_FILE))) {
    return { rel: join(base, LEGACY_FILE), retired: false };
  }
  if (retired && existsSync(join(repoRoot, retiredRelFor(base)))) {
    return { rel: retiredRelFor(base), retired: true };
  }
  return null;
}

/** Every scope with a monolith to migrate, root first. */
function scopesWithLegacy(repoRoot, { retired = false } = {}) {
  const out = [];
  const rootSource = legacySourceFor(repoRoot, '.sidekicks', retired);
  if (rootSource) out.push({ scope: 'sidekicks', base: '.sidekicks', ...rootSource });
  const projects = join(repoRoot, 'projects');
  if (!existsSync(projects)) return out;
  let entries = [];
  try {
    entries = readdirSync(projects, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of entries) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    const base = join('projects', dirent.name);
    const source = legacySourceFor(repoRoot, base, retired);
    if (source) out.push({ scope: dirent.name, base, ...source });
  }
  return out;
}

/**
 * Plan (and optionally perform) one scope's migration.
 *
 * @param {string} repoRoot
 * @param {{scope: string, base: string}} target
 * @param {{dryRun: boolean, prune: boolean}} opts
 * @returns {object}
 */
function migrateScope(repoRoot, target, opts) {
  const legacyRel = target.rel ?? join(target.base, LEGACY_FILE);
  const legacyText = readFileSync(join(repoRoot, legacyRel), 'utf8');

  const dups = duplicateTopLevelKeys(legacyText);
  if (dups.length) {
    throw new SidekicksError(
      `config migrate: '${legacyRel}' declares ${dups.length} block(s) more than once `
      + `(${dups.map((d) => `${d.key} at lines ${d.lines.join(', ')}`).join('; ')}). Every YAML `
      + 'parser already keeps only the last one, so splitting the file would bless whichever copy '
      + 'happens to win. Merge them by hand first, then re-run.',
      EXIT_VALIDATION
    );
  }

  const { byBlock } = buildFamilies(repoRoot);
  const blockNames = [...new Set(topLevelKeyLines(legacyText).map((k) => k.key))];

  const undeclared = blockNames.filter((name) => {
    if (byBlock.has(name)) return false;
    for (const entry of byBlock.values()) if (entry.aliases.includes(name)) return false;
    return true;
  });
  if (undeclared.length) {
    throw new SidekicksError(
      `config migrate: '${legacyRel}' carries block(s) nothing declares: ${undeclared.join(', ')}. `
      + "Declare each in the owning skill's skill.yaml (or in lib/config-store/core-families.mjs when "
      + 'framework code reads it) so the migrator knows which family file it belongs in.',
      EXIT_VALIDATION
    );
  }

  /** family file → { plain: {block: value}, secret: {block: value} } */
  const byFile = new Map();
  const moves = [];
  for (const name of blockNames) {
    let entry = byBlock.get(name) ?? null;
    if (!entry) {
      for (const candidate of byBlock.values()) {
        if (candidate.aliases.includes(name)) { entry = candidate; break; }
      }
    }
    const value = readBlock(legacyText, name);
    if (value === null) {
      // A header whose body is entirely commented carries no value: nothing to move, and writing
      // `block: {}` would turn "documented but unset" into "explicitly empty".
      moves.push({ block: name, family: entry.family, file: entry.file, skipped: 'no live value' });
      continue;
    }
    const { plain, secret } = splitSecrets(value, entry.public_keys);
    const bucket = byFile.get(entry.file) ?? { plain: new Map(), secret: new Map(), entry };
    bucket.plain.set(name, plain);
    if (Object.keys(secret).length) bucket.secret.set(name, secret);
    byFile.set(entry.file, bucket);

    const roundTrip = overlay(plain, Object.keys(secret).length ? secret : null);
    const equivalent = deepEqual(roundTrip, value);
    moves.push({
      block: name,
      family: entry.family,
      file: join(target.base, CONFIG_DIR, entry.file),
      secret_file: Object.keys(secret).length
        ? join(target.base, CONFIG_DIR, entry.secret)
        : null,
      keys: Object.keys(value).length,
      secret_keys: countSecretLeaves(secret),
      equivalent,
    });
  }

  const failed = moves.filter((m) => m.equivalent === false);
  const written = [];
  if (!opts.dryRun && !failed.length) {
    // The directory ignores its own secret files before any of them exists — a project may be a
    // submodule or a symlinked external directory, where the repo-root .gitignore does not reach.
    if (byFile.size) {
      const ignore = ensureSecretIgnore(repoRoot, join(target.base, CONFIG_DIR));
      if (ignore.created || !ignore.already) written.push(ignore.path);
    }
    for (const [file, bucket] of byFile) {
      const plainRel = join(target.base, CONFIG_DIR, file);
      const known = FAMILIES.find((f) => f.family === bucket.entry.family);
      for (const [block, value] of bucket.plain) {
        writeBlock(repoRoot, plainRel, block, value, {
          header: [
            `# ${plainRel} — ${known ? known.title : bucket.entry.family}`,
            '#',
            '# COMMITTED and non-secret. Split out of the legacy monolith by `sidekicks config migrate`;',
            `# every credential lives in the git-ignored sibling '${bucket.entry.secret}'.`,
          ],
        });
      }
      written.push(plainRel);
      if (bucket.secret.size) {
        const secretRel = join(target.base, CONFIG_DIR, bucket.entry.secret);
        for (const [block, value] of bucket.secret) {
          writeBlock(repoRoot, secretRel, block, value, {
            header: [
              `# ${secretRel} — GIT-IGNORED credential half of ${file}.`,
              '# Split out of the legacy monolith by `sidekicks config migrate`. Never commit this file.',
            ],
          });
        }
        written.push(secretRel);
      }
    }
  }

  // Re-read from disk: the in-memory round-trip proves the split, this proves the WRITE.
  const verified = [];
  if (!opts.dryRun && !failed.length) {
    for (const move of moves) {
      if (move.skipped) continue;
      const plainText = readFileSync(join(repoRoot, move.file), 'utf8');
      const secretText = move.secret_file && existsSync(join(repoRoot, move.secret_file))
        ? readFileSync(join(repoRoot, move.secret_file), 'utf8')
        : null;
      const onDisk = overlay(
        readBlock(plainText, move.block),
        secretText ? readBlock(secretText, move.block) : null
      );
      const original = readBlock(legacyText, move.block);
      verified.push({ block: move.block, equivalent: deepEqual(onDisk, original) });
    }
  }

  const diskFailures = verified.filter((v) => !v.equivalent);
  /** @type {string|false} — the retired path, or false when the monolith stayed put. */
  let pruned = false;
  if (opts.prune && !opts.dryRun && target.retired) {
    // Re-running against the retired copy: there is nothing left to retire, and renaming the file
    // onto itself would only look like progress.
    pruned = false;
  } else if (opts.prune && !opts.dryRun) {
    if (failed.length || diskFailures.length) {
      throw new SidekicksError(
        `config migrate: refusing --prune for '${target.scope}' — `
        + `${failed.length + diskFailures.length} block(s) did not resolve identically after the split`,
        EXIT_VALIDATION
      );
    }
    // RENAMED, NOT DELETED. Every block proved equivalent, but a configuration file is the one thing
    // a fresh clone cannot reconstruct, so the monolith is retired to
    // `<scope>/config/pending-removal.config.yaml` — inside the directory whose .gitignore already
    // refuses `pending-removal.*`, because it still holds every credential the split moved out. No
    // reader looks at that name (the store reads `<scope>/config.yaml` and `config/<family>.yaml`), and
    // `config doctor` treats it as inert. Delete it by hand once the split has lived a release.
    const abs = join(repoRoot, legacyRel);
    const retiredRel = join(target.base, CONFIG_DIR, `${PENDING_PREFIX}config.yaml`);
    const retiredAbs = join(repoRoot, retiredRel);
    ensureSecretIgnore(repoRoot, join(target.base, CONFIG_DIR));
    ensurePendingIgnore(repoRoot, join(target.base, CONFIG_DIR));
    assertWritable(abs, repoRoot);
    assertWritable(retiredAbs, repoRoot);
    renameSync(abs, retiredAbs);
    pruned = retiredRel;
  }

  return {
    scope: target.scope,
    legacy: legacyRel,
    from_retired: Boolean(target.retired),
    blocks: moves.length,
    moves,
    written,
    verified,
    equivalence_failures: [...failed.map((f) => f.block), ...diskFailures.map((d) => d.block)],
    pruned,
    dry_run: Boolean(opts.dryRun),
  };
}

/** How many credential leaves a secret half carries, for the report. */
function countSecretLeaves(secret) {
  let n = 0;
  for (const value of Object.values(secret || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) n += countSecretLeaves(value);
    else n++;
  }
  return n;
}

/**
 * Run `config migrate`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseConfigFlags(ctx.argv, ['dry-run', 'prune', 'json', 'all', 'from-retired']);
  const wanted = args.name || (flags.scope ? String(flags.scope) : null);
  const fromRetired = Boolean(flags['from-retired']);

  let targets = scopesWithLegacy(repoRoot, { retired: fromRetired });
  if (wanted) {
    targets = targets.filter((t) => t.scope === wanted);
    if (!targets.length) {
      throw new SidekicksError(
        `config migrate: scope '${wanted}' has no ${LEGACY_FILE} to migrate`
        + (fromRetired ? ' and no retired copy under config/ either' : '')
        + (fromRetired ? '' : ` — pass --from-retired to re-split from ${PENDING_PREFIX}config.yaml`),
        EXIT_VALIDATION
      );
    }
  } else if (!flags.all) {
    throw new SidekicksError(
      'config migrate: name a scope, or pass --all. Migrating every scope at once is opt-in because '
      + 'each one should be verified before its monolith is pruned. Scopes with a legacy config: '
      + `${targets.map((t) => t.scope).join(', ') || '(none)'}`,
      EXIT_VALIDATION
    );
  }

  const results = targets.map((t) => migrateScope(repoRoot, t, {
    dryRun: Boolean(flags['dry-run']),
    prune: Boolean(flags.prune),
  }));
  const problems = results.reduce((n, r) => n + r.equivalence_failures.length, 0);
  const exitCode = problems ? EXIT_VALIDATION : EXIT_OK;

  if (flags.json) {
    return { stdout: JSON.stringify({ scopes: results, problems }, null, 2) + '\n', exitCode };
  }

  const out = [];
  for (const r of results) {
    out.push(`${r.scope}  (${r.legacy})${r.dry_run ? '   [dry run — nothing written]' : ''}`);
    for (const m of r.moves) {
      if (m.skipped) {
        out.push(`  ${m.block.padEnd(28)} skipped — ${m.skipped}`);
        continue;
      }
      const secret = m.secret_keys ? `  + ${m.secret_keys} credential(s) → ${m.secret_file}` : '';
      out.push(`  ${m.block.padEnd(28)} → ${m.file}${secret}`);
      if (m.equivalent === false) out.push(`  ${''.padEnd(28)} !! does NOT resolve identically`);
    }
    if (r.written.length) {
      out.push('', `  wrote: ${[...new Set(r.written)].join(', ')}`);
    }
    if (r.verified.length) {
      const ok = r.verified.filter((v) => v.equivalent).length;
      out.push(`  verified on disk: ${ok}/${r.verified.length} blocks resolve identically`);
    }
    if (r.pruned) out.push(`  retired: ${r.legacy} → ${r.pruned}   (git-ignored, read by nothing — delete it by hand once you are sure)`);
    else if (!r.dry_run && r.from_retired) {
      out.push(`  source: ${r.legacy}   (already retired — read by nothing, kept only as the `
        + 'pre-split record; nothing to prune)');
    } else if (!r.dry_run) {
      out.push(`  kept:   ${r.legacy}   (still read as the lowest scope layer — `
        + 're-run with --prune once you are satisfied)');
    }
    out.push('');
  }
  if (problems) {
    out.push(`${problems} block(s) did not resolve identically after the split — nothing was pruned.`);
  }
  return { stdout: out.join('\n'), exitCode };
}
