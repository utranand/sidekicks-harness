// lib/framework-lifecycle/show.mjs
// `sidekicks framework show <id> [--json]`
//
// One entry in full: state, the layer that decided it, its owning skill(s), where its body
// lives after extraction, and — for a hook — the script the gate guards. This is the verb an
// agent uses to find the body of a rule AGENTS.md only references.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_NOT_FOUND, SidekicksError } from '../sk-cli/errors.mjs';
import { coreDirOf } from '../sk-cli/core-mount.mjs';
import { buildRegistry } from '../framework-settings/registry.mjs';
import { resolve } from '../framework-settings/resolve.mjs';
import { floorReason, FLOOR_WAIVER } from '../framework-settings/floor.mjs';
import { inspectBody } from './_body.mjs';
import { parseFrameworkFlags, requireId, stateWord } from './_shared.mjs';

/**
 * Is a hook's script actually on disk in this checkout?
 *
 * Two places, because a mounted workspace has no root `scripts/` of its own — the hook bodies live
 * inside the core and the wiring routes through the mount. Answering from the workspace alone would
 * report every hook as missing there (memory: framework-scripts-are-absent-in-a-mounted-workspace).
 *
 * A hook whose script is absent from BOTH still resolves as `enabled`, which is exactly the reading
 * INC-2026-09-06-06 (B-2) found misleading: a trimmed core said `enabled` for hooks that can never
 * fire. `null` for an entry that names no script (rules and criteria).
 *
 * @param {string|null|undefined} script - repo-relative script path from the registry
 * @param {string} repoRoot
 * @param {string|null} coreDir
 * @returns {boolean|null}
 */
function scriptPresent(script, repoRoot, coreDir) {
  if (!script) return null;
  const rel = String(script).split('/');
  if (existsSync(join(repoRoot, ...rel))) return true;
  return Boolean(coreDir && existsSync(join(coreDir, ...rel)));
}

/**
 * Run `framework show <id>`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseFrameworkFlags(ctx.argv, ['json']);
  const id = requireId(args.name, 'framework show');

  const { byId } = buildRegistry(repoRoot);
  const entry = byId.get(id);
  if (!entry) {
    throw new SidekicksError(
      `framework show: unknown id '${id}' — run 'sidekicks framework list' to see the ids`,
      EXIT_NOT_FOUND
    );
  }

  const resolved = resolve(repoRoot, id);
  const coreDir = coreDirOf(repoRoot);
  const hasScript = scriptPresent(entry.script, repoRoot, coreDir);
  // `body_exists` used to mean "a file with that name is on disk", which for the thirty core rules
  // that all record 'AGENTS.md' was true no matter what the file contained. It reported true for
  // seven floor rules the forged lightweight core had dropped entirely. It now means what a reader
  // assumes it means: the rule's own prose is present — checked in the workspace and, under a mount,
  // in the core's instruction surface (lib/framework-lifecycle/_body.mjs).
  const body = entry.body_at
    ? inspectBody(entry, repoRoot, coreDir)
    : null;
  const bodyExists = body ? (body.fileFound && body.markerFound !== false) : null;

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        owners: entry.owners,
        body_at: entry.body_at,
        body_exists: bodyExists,
        // Kept separate so a caller can tell "the file is gone" from "the file is there but no
        // longer states the rule" — two different repairs.
        body_file_found: body ? body.fileFound : null,
        body_marker: entry.body_marker,
        body_marker_found: body ? body.markerFound : null,
        script: entry.script,
        // Separate from `enabled` on purpose: a hook can be enabled and still never fire, because
        // the skill that owns its script did not travel into this checkout.
        script_present: hasScript,
        floor: entry.floor,
        waiver: entry.floor ? FLOOR_WAIVER : null,
        registry_source: entry.source,
        enabled: resolved.enabled,
        resolved_from: resolved.source,
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const out = [];
  out.push(`${entry.id} — ${entry.title}`);
  out.push(`  kind:      ${entry.kind}`);
  out.push(`  state:     ${stateWord(resolved)}  [resolved from: ${resolved.source}]`);
  out.push(`  owners:    ${entry.owners.length ? entry.owners.join(', ') : '(framework core)'}`);
  if (entry.body_at) {
    const missing = !body.fileFound
      ? '   ** FILE MISSING **'
      : body.markerFound === false
        ? `   ** RULE NOT STATED IN IT (marker: "${entry.body_marker}") **`
        : '';
    out.push(`  body:      ${entry.body_at}${missing}`);
  }
  if (entry.script) {
    out.push(`  script:    ${entry.script}${hasScript ? '' : '   ** NOT IN THIS CHECKOUT — this hook never fires **'}`);
  }
  out.push(`  declared:  ${entry.source === 'core' ? 'lib/framework-settings/core-registry.mjs' : 'skill descriptor (skill.yaml)'}`);
  if (entry.floor) {
    out.push('');
    out.push(`  ${floorReason(entry.id)}`);
  } else {
    out.push('');
    out.push(`  Turn off with: sidekicks framework disable ${entry.id}`);
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
