// `sidekicks agent amend <name> --patch-file=<repo-relative-yaml> --dry-run|--apply [--json]`
//
// Lossless instruction-only charter amendment. It never recreates an agent:
// runtime, mailboxes, routines, memory, and history are outside this write path.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
import {
  parseMemoryFlags,
  validateAgentName,
  requireCharter,
  validateCompleteCharter,
  writeCharter,
} from './_shared.mjs';

const PATCH_FIELDS = new Set([
  'persona', 'mission', 'goals', 'expertise', 'principles', 'routines',
  'output_contract', 'primary_mission',
  // `memory: attach: [...]` — which scenario categories this agent works within. Amendable
  // because what an agent works on shifts over time; the alternative was create --force,
  // which is a lossy full rewrite.
  'memory',
]);

/** Exact declaration identity bytes shared with the journal bind contract. */
export function declarationFingerprint(declaration) {
  const fixed = {
    slug: declaration.slug,
    title: declaration.title,
    goal: declaration.goal,
    standing: declaration.standing,
    dod_checks: declaration.dod_checks,
    state_policy: declaration.state_policy,
  };
  return createHash('sha256').update(JSON.stringify(fixed), 'utf8').digest('hex');
}

function reject(message) {
  throw new SidekicksError(`agent amend: ${message}`, EXIT_VALIDATION);
}

function readContainedPatch(repoRoot, raw) {
  const value = String(raw ?? '').trim();
  if (!value) reject('--patch-file is required');
  if (isAbsolute(value)) reject('--patch-file must be repo-relative');
  const abs = resolve(repoRoot, value);
  const rel = relative(repoRoot, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) reject('--patch-file escapes the repository');
  let stat;
  try { stat = lstatSync(abs); } catch { reject(`patch file '${value}' does not exist`); }
  if (stat.isSymbolicLink()) reject('--patch-file must not be a symlink');
  if (!stat.isFile()) reject('--patch-file must be a file');
  let realRoot, realPatch;
  try { realRoot = realpathSync(repoRoot); realPatch = realpathSync(abs); } catch { reject(`cannot resolve patch file '${value}'`); }
  const realRel = relative(realRoot, realPatch);
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) reject('--patch-file resolves outside the repository');
  let patch;
  try { patch = yaml.parse(readFileSync(abs, 'utf8')); } catch (err) {
    reject(`patch file '${value}' failed to parse: ${String(err.message || err).split('\n')[0]}`);
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) reject('patch must be a YAML mapping');
  const bad = Object.keys(patch).filter((key) => !PATCH_FIELDS.has(key));
  if (bad.length) reject(`patch may change instruction fields only; refused: ${bad.join(', ')}`);
  if (Object.keys(patch).length === 0) reject('patch must contain at least one instruction field');
  return patch;
}

/**
 * Best-effort reader for already-persisted declaration.bind events. The event
 * data has deliberately redundant names while mixed-version stores converge;
 * an unrecognizable binding is treated as immutable rather than ignored.
 */
async function boundFingerprint(repoRoot, name, slug) {
  const { resolveJournalConfig } = await import('../journal-lifecycle/_shared.mjs');
  const { loadMissions, readMissionEvents } = await import('../journal-lifecycle/_mission.mjs');
  const cfg = resolveJournalConfig(repoRoot);
  if (!cfg) return null;
  for (const mission of loadMissions(cfg, { agent: name })) {
    const events = readMissionEvents(cfg, mission.dirAbs).rows;
    for (const event of events) {
      if (event.type !== 'declaration.bind') continue;
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      const eventSlug = data.slug ?? data.declaration_slug ?? data.declaration?.slug;
      if (eventSlug !== slug) continue;
      return data.fingerprint ?? data.declaration_fingerprint ?? data.declaration?.fingerprint ?? '__bound-without-fingerprint__';
    }
  }
  return null;
}

export async function run(ctx, args) {
  const name = validateAgentName(args.name);
  const flags = parseMemoryFlags(ctx.argv, ['dry-run', 'apply', 'json']);
  if (Boolean(flags['dry-run']) === Boolean(flags.apply)) {
    reject('pass exactly one of --dry-run or --apply');
  }
  const before = requireCharter(ctx.repoRoot, name);
  const patch = readContainedPatch(ctx.repoRoot, flags['patch-file']);
  const after = { ...before, ...patch };
  validateCompleteCharter(after, name, 'agent amend');

  const oldDeclaration = before.primary_mission;
  const oldFingerprint = oldDeclaration ? declarationFingerprint(oldDeclaration) : null;
  const bound = oldDeclaration ? await boundFingerprint(ctx.repoRoot, name, oldDeclaration.slug) : null;
  if (bound) {
    const nextFingerprint = after.primary_mission ? declarationFingerprint(after.primary_mission) : null;
    if (!nextFingerprint || nextFingerprint !== oldFingerprint || bound !== oldFingerprint) {
      reject(`primary_mission '${oldDeclaration.slug}' is already bound and cannot be removed or fingerprint-changed`);
    }
  }

  const payload = { agent: name, before, after };
  if (flags.apply) writeCharter(ctx.repoRoot, name, after, 'agent amend');
  if (flags.json) return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: EXIT_OK };
  return {
    stdout: `${flags.apply ? 'applied' : 'dry-run'} amendment for '${name}'\nbefore:\n${yaml.serialize(before)}after:\n${yaml.serialize(after)}`,
    exitCode: EXIT_OK,
  };
}
