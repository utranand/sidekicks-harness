// lib/framework-lifecycle/list.mjs
// `sidekicks framework list [--json] [--kind=rule|criterion|hook] [--disabled]`
//
// Every registered framework rule, CLAUDE.md criterion and hook with its effective state
// and the layer that decided it. The registry is derived (core entries + skill descriptors),
// so a rule extracted into a skill appears here the moment its descriptor exists — there is
// no catalog to update.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { buildRegistry } from '../framework-settings/registry.mjs';
import { loadLayers, resolve } from '../framework-settings/resolve.mjs';
import { discoverSkills } from '../skill-manifest/read.mjs';
import { parseFrameworkFlags, listLine } from './_shared.mjs';

const KINDS = ['rule', 'criterion', 'hook'];

/**
 * Run `framework list`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseFrameworkFlags(ctx.argv, ['json', 'disabled']);

  if (flags.kind !== undefined && !KINDS.includes(String(flags.kind))) {
    throw new SidekicksError(
      `framework list: --kind must be one of ${KINDS.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const { entries } = buildRegistry(repoRoot);
  const layers = loadLayers(repoRoot);

  // Owner-absent annotation (AAP-111): a hook whose every owning skill stayed behind (trimmed
  // framework core) still resolves — but the reader should see the owner is not here.
  const present = new Set(discoverSkills(repoRoot).map((e) => e.skill));
  const ownerAbsent = (entry) =>
    entry.kind === 'hook' && entry.owners.length > 0 && !entry.owners.some((o) => present.has(o));

  let rows = entries.map((entry) => ({ entry, resolved: resolve(repoRoot, entry.id, layers) }));
  if (flags.kind) rows = rows.filter((r) => r.entry.kind === String(flags.kind));
  if (flags.disabled) rows = rows.filter((r) => !r.resolved.enabled);

  if (flags.json) {
    const payload = rows.map(({ entry, resolved }) => ({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      owners: entry.owners,
      body_at: entry.body_at,
      // The distinctive phrase that proves this entry's prose is still present. Emitted so a
      // consumer of `framework list --json` — the forge's own instruction-surface gate among them —
      // can assert the RULE is stated without importing the registry module.
      body_marker: entry.body_marker ?? null,
      script: entry.script,
      floor: entry.floor,
      registry_source: entry.source,
      enabled: resolved.enabled,
      resolved_from: resolved.source,
      ...(ownerAbsent(entry) ? { owner_absent: true } : {}),
    }));
    return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: EXIT_OK };
  }

  if (rows.length === 0) {
    return { stdout: 'No matching framework entries.\n', exitCode: EXIT_OK };
  }

  const idWidth = rows.reduce((w, r) => Math.max(w, r.entry.id.length), 0);
  const out = [];
  const disabledCount = rows.filter((r) => !r.resolved.enabled).length;
  out.push(`Framework entries (${rows.length}; ${disabledCount} disabled) — scope: ${layers.projectName}`);
  out.push('');
  for (const kind of KINDS) {
    const ofKind = rows.filter((r) => r.entry.kind === kind);
    if (ofKind.length === 0) continue;
    const label = kind === 'criterion' ? 'criteria' : `${kind}s`;
    out.push(`${label} (${ofKind.length}):`);
    for (const r of ofKind) {
      out.push('  ' + listLine(r.entry, r.resolved, idWidth) + (ownerAbsent(r.entry) ? '  (owner absent)' : ''));
    }
    out.push('');
  }
  out.push("Change one with: sidekicks framework disable <id> | enable <id>");
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
