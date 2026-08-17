// lib/artifacts-lifecycle/register.mjs
// `artifacts register <skill> <slug> [field=value ...]`
//
// The single mediated writer of the PARENT/LEAF run.json. Resolves the caller's
// working folder (so the header co-locates with the skill's bespoke ledger), ensures
// <base>/artifacts/runs/<short-skill>/<slug>/, then under withRunLease upserts run.json
// (create with created_at if new; merge fields + refresh updated_at if existing).
//
// Writes NOTHING but its own run.json — never touches index.json / ARTIFACTS.md (F9).
// Idempotent; best-effort: any failure logs and returns non-fatally so the calling
// skill never stalls.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { join, isAbsolute } from 'node:path';
import { SidekicksError, EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, EXIT_IO } from '../sk-cli/errors.mjs';
import {
  resolveStores,
  withRunLease,
  readRun,
  writeRunAtomic,
  ensureRepoIgnore,
  parseFieldPositionals,
  toRepoRel,
  nowBangkok,
  STATUS_ENUM,
} from './_shared.mjs';

/**
 * Run `artifacts register <skill> <slug> [field=value ...]`.
 * args.name = skill, args.rest[0] = slug, args.rest[1..] = field=value positionals.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: Function }} ctx
 * @param {{ name?: string, rest?: string[], flags?: object }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on all failure paths.
 */
export async function run(ctx, args) {
  const skill = args.name;
  const slug = args.rest && args.rest[0];
  if (!skill || !slug) {
    throw new SidekicksError(
      'artifacts register: usage: artifacts register <skill> <slug> [field=value ...]',
      EXIT_USAGE
    );
  }

  try {
    const stores = resolveStores(ctx, readArtifactsDir(ctx));
    // The store base co-locates with the caller's working folder.
    const runsBase = join(stores.projectStoreDir, 'runs');

    const { fields, pointer } = parseFieldPositionals(args.rest.slice(1));

    // `dir=` — the caller already resolved its run folder (runs layout v2, where the shape is
    // runs/<work-item>/<facet>/ rather than runs/<skill>/<slug>/, so the join cannot be
    // recomputed from skill+slug here). Without it the legacy join is used, byte-identical to
    // every pre-v2 invocation. Relative values resolve against the project store's runs base.
    const runDir = fields.dir
      ? (isAbsolute(fields.dir) ? fields.dir : join(runsBase, fields.dir))
      : join(runsBase, skill, slug);

    // Best-effort: ensure the owning repo ignores artifacts/index.json on first write.
    try { ensureRepoIgnore(stores.projectWorkdir); } catch { /* never stall */ }

    const written = withRunLease(runDir, () => {
      const existing = readRun(runDir) || {};
      const manifest = { ...existing };
      manifest.skill = skill;
      manifest.slug = slug;

      // Scalar header fields. `service` carries the service association under runs layout v2,
      // where run folders anchor at the PROJECT base and the service never appears in the path.
      for (const k of ['title', 'status', 'kind', 'jira_card', 'goal', 'service']) {
        if (fields[k] != null) manifest[k] = fields[k];
      }
      // work_dir is recorded repo-relative to the owning repo.
      if (fields.work_dir != null) {
        manifest.work_dir = toRepoRel(stores.projectWorkdir, fields.work_dir);
      }
      // max_attempts — numeric convergence guard.
      if (fields.max_attempts != null) {
        manifest.max_attempts = Number(fields.max_attempts);
      }
      // Pointers.
      if (Object.keys(pointer).length) {
        manifest.pointer = { ...(manifest.pointer || {}), ...pointer };
      }

      // Ralph-loop exit_check fields (F13): exitable / remaining / unmet.
      if (fields.exitable != null || fields.remaining != null || fields.unmet != null) {
        const ec = { ...(manifest.exit_check || {}) };
        if (fields.exitable != null) ec.exitable = parseBool(fields.exitable);
        if (fields.remaining != null) ec.remaining = splitList(fields.remaining);
        if (fields.unmet != null) ec.unmet = splitList(fields.unmet);
        ec.checked_at = nowBangkok();
        manifest.exit_check = ec;
      }

      return writeRunAtomic(runDir, manifest);
    });

    const rel = toRepoRel(ctx.repoRoot, join(runDir, 'run.json'));
    return {
      stdout: `registered ${written.skill}/${written.slug} [${written.status ?? 'unset'}] → ${rel}\n`,
      exitCode: EXIT_OK,
    };
  } catch (err) {
    // Best-effort, never-stall: surface the failure but exit non-fatally so the
    // calling skill keeps working. Use EXIT_IO but with the body printed.
    if (ctx.log) ctx.log(`artifacts register: ${err.message}`);
    // A validation error (e.g. bad status) is worth surfacing distinctly.
    if (STATUS_ENUM && /invalid status/.test(err.message)) {
      throw new SidekicksError(`artifacts register: ${err.message}`, EXIT_VALIDATION);
    }
    throw new SidekicksError(`artifacts register: non-fatal failure: ${err.message}`, EXIT_IO);
  }
}

function parseBool(v) {
  if (typeof v === 'boolean') return v;
  return /^(1|true|yes|y)$/i.test(String(v).trim());
}

function splitList(v) {
  if (Array.isArray(v)) return v;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function readArtifactsDir(ctx) {
  // Allow artifacts_dir via either a --flag or env. Default none.
  const flags = ctx.flags || {};
  const ad = flags.artifacts_dir || flags['artifacts-dir'];
  return ad ? { artifacts_dir: String(ad) } : {};
}
