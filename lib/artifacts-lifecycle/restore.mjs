// lib/artifacts-lifecycle/restore.mjs
// `artifacts restore <path>`
//
// The inverse of `artifacts archive`: move an artifact folder back out of a scope's
// artifacts/archived/ mirror to its original live location. Accepts either the archived
// path (…/artifacts/archived/<sub>) or the original live path (…/artifacts/<sub>) — it
// resolves to the archived source either way. Uses `git mv` (staged, never committed).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { SidekicksError, EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import {
  splitArtifactPath,
  findOwnerRepo,
  moveFolder,
  refreshInventory,
  ARCHIVE_DIRNAME,
  fromRepoRel,
} from './_manage.mjs';

const USAGE = 'artifacts restore: usage: artifacts restore <path>';

/**
 * Run `artifacts restore`.
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on all failure paths.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const target = args.name;
  if (!target) throw new SidekicksError(USAGE, EXIT_USAGE);

  const split = splitArtifactPath(repoRoot, target);
  if (!split) {
    throw new SidekicksError(`artifacts restore: '${target}' is not under an artifacts/ tree`, EXIT_VALIDATION);
  }

  // Normalize to the archived sub-path (accept both the archived and the live form).
  const archivedSub = split.sub[0] === ARCHIVE_DIRNAME ? split.sub.slice(1) : split.sub;
  if (archivedSub.length === 0) {
    throw new SidekicksError('artifacts restore: name a specific archived artifact, not the archive root', EXIT_VALIDATION);
  }

  const srcRel = `${split.baseRel}/${ARCHIVE_DIRNAME}/${archivedSub.join('/')}`;
  const dstRel = `${split.baseRel}/${archivedSub.join('/')}`;
  const srcAbs = fromRepoRel(repoRoot, srcRel);
  const dstAbs = fromRepoRel(repoRoot, dstRel);

  if (!existsSync(srcAbs)) {
    throw new SidekicksError(`artifacts restore: not archived: ${srcRel}`, EXIT_NOT_FOUND);
  }
  if (existsSync(dstAbs)) {
    throw new SidekicksError(`artifacts restore: destination already exists (a live copy is in the way): ${dstRel}`, EXIT_VALIDATION);
  }

  const ownerRepo = findOwnerRepo(srcAbs, repoRoot);
  const method = moveFolder(srcAbs, dstAbs, ownerRepo);
  refreshInventory(repoRoot);

  const stagedNote = method === 'git'
    ? 'Staged (git mv) — commit yourself when ready.'
    : 'Moved (plain mv — not a git repo, or git unavailable).';
  return {
    stdout: `restored: ${srcRel} → ${dstRel}\n${stagedNote}\n`,
    exitCode: EXIT_OK,
  };
}
