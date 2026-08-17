// lib/artifacts-lifecycle/child.mjs
// `artifacts child <parent-skill> <parent-slug> <child-key> [field=value ...] [--remove] [--bump-attempts]`
//
// Upserts ONE subtask row in the parent's subtasks[] via upsertChild — adding the row
// on first sight (dynamic expansion, F12) and bubbling the parent updated_at. Records
// goal / verdict / lineage (origin, expands_from → bidirectional expanded_into) / attempts.
// Writes ONLY the parent's own run.json, never the index. Best-effort, never-stall.
//
// args.name = parent-skill, args.rest[0] = parent-slug, args.rest[1] = child-key,
// args.rest[2..] = field=value positionals. Flags (--remove, --bump-attempts) read
// from raw argv so they work in either position.
//
// Recognized fields: status, title, goal, kind, reason, origin, expands_from, attempts,
//   verdict_result (pass|fail), verdict_evidence, pointer.<n>=<rel>.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { join } from 'node:path';
import { SidekicksError, EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, EXIT_IO } from '../sk-cli/errors.mjs';
import {
  resolveStores,
  withRunLease,
  upsertChild,
  parseFieldPositionals,
  parseArtifactFlags,
  toRepoRel,
} from './_shared.mjs';

/**
 * Run `artifacts child ...`.
 * @param {{ repoRoot: string, argv: string[], flags: object, log: Function }} ctx
 * @param {{ name?: string, rest?: string[], flags?: object }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on all failure paths.
 */
export async function run(ctx, args) {
  const parentSkill = args.name;
  const parentSlug = args.rest && args.rest[0];
  const childKey = args.rest && args.rest[1];
  if (!parentSkill || !parentSlug || !childKey) {
    throw new SidekicksError(
      'artifacts child: usage: artifacts child <parent-skill> <parent-slug> <child-key> [field=value ...] [--remove] [--bump-attempts]',
      EXIT_USAGE
    );
  }

  const boolFlags = parseArtifactFlags(ctx.argv, ['remove', 'bump-attempts']);
  const { fields, pointer } = parseFieldPositionals(args.rest.slice(2));

  // Assemble the merge fields object for upsertChild.
  const merge = {};
  for (const k of ['status', 'title', 'goal', 'kind', 'reason', 'origin', 'expands_from']) {
    if (fields[k] != null) merge[k] = fields[k];
  }
  if (fields.attempts != null) merge.attempts = fields.attempts;
  if (boolFlags['bump-attempts']) merge.bumpAttempts = true;
  if (boolFlags.remove) merge.remove = true;
  if (Object.keys(pointer).length) merge.pointer = pointer;
  if (fields.verdict_result != null || fields.verdict_evidence != null) {
    merge.verdict = {
      result: fields.verdict_result ?? undefined,
      evidence: fields.verdict_evidence ?? undefined,
    };
  }

  try {
    const stores = resolveStores(ctx, readArtifactsDir(ctx));
    const runsBase = join(stores.projectStoreDir, 'runs');
    const parentDir = join(runsBase, parentSkill, parentSlug);

    const written = withRunLease(parentDir, () => upsertChild(parentDir, childKey, merge));
    const rel = toRepoRel(ctx.repoRoot, join(parentDir, 'run.json'));
    const verb = merge.remove ? 'removed' : 'upserted';
    return {
      stdout: `${verb} subtask ${childKey} on ${parentSkill}/${parentSlug} (${written.subtasks ? written.subtasks.length : 0} subtasks) → ${rel}\n`,
      exitCode: EXIT_OK,
    };
  } catch (err) {
    if (ctx.log) ctx.log(`artifacts child: ${err.message}`);
    if (/invalid (subtask status|verdict)/.test(err.message)) {
      throw new SidekicksError(`artifacts child: ${err.message}`, EXIT_VALIDATION);
    }
    throw new SidekicksError(`artifacts child: non-fatal failure: ${err.message}`, EXIT_IO);
  }
}

function readArtifactsDir(ctx) {
  const flags = ctx.flags || {};
  const ad = flags.artifacts_dir || flags['artifacts-dir'];
  return ad ? { artifacts_dir: String(ad) } : {};
}
