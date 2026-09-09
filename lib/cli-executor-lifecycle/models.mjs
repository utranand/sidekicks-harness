// lib/cli-executor-lifecycle/models.mjs
// `sidekicks cli-executor models [<name>...] [--refresh] [--root] [--json]` — the tier↔catalog
// reconciliation surface: which model each tier selects, whether the discovered catalog still
// carries it, and which catalog models no tier has claimed.
//
// This is the verb to run when a vendor ships a new model. `discover`/`sync` refresh the CATALOG
// (`capabilities.models[]`); `register --model-<tier> <id>` sets the SELECTION (`models`). Nothing
// joined the two, so a released top-tier model and a retired mapped model were both invisible.
//
// It NEVER writes a tier map. A discovered model row carries id/display_name/aliases/efforts and no
// tier hint whatsoever, so promoting one to `top` (or any tier) is a routing decision the operator
// owns — the verb prints the exact `register` command and stops. `--refresh` writes only the
// capability snapshot, through the same discover→sync path an operator would run by hand.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { read } from '../settings-store/settings.mjs';
import {
  MODEL_TIERS,
  effectiveExecutors,
  parseFlags,
  readEffectiveRegistry,
  readRegistry,
  resolveRegistryPath,
  selectionStatus,
} from './_shared.mjs';
import { run as runDiscover } from './discover.mjs';
import { run as runSync } from './sync.mjs';

/**
 * Refresh the capability snapshot for the named executors (all, when none are named) by driving the
 * SAME discover→sync path an operator would run by hand — a candidate is discovered, then applied.
 * Touches `capabilities` only; `models`, `efforts` and every routing field are left alone.
 *
 * @param {string} repoRoot
 * @param {string[]} names
 * @param {boolean} rootScope
 * @returns {Promise<{ diff: Array<object> }>}
 */
async function refreshCapabilities(repoRoot, names, rootScope) {
  const discovered = await runDiscover(
    { repoRoot, argv: ['--json', ...names] },
    { name: names[0], rest: names.slice(1) },
  );
  const dir = mkdtempSync(join(tmpdir(), 'sk-cliexec-candidate-'));
  const candidatePath = join(dir, 'candidate.json');
  try {
    writeFileSync(candidatePath, discovered.stdout, 'utf8');
    const applied = await runSync({
      repoRoot,
      argv: ['--from', candidatePath, '--apply', '--json', ...(rootScope ? ['--root'] : [])],
    });
    return JSON.parse(applied.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Catalog model rows that no tier selects. A `hidden` row is excluded: the CLI itself declined to
 * advertise it, so suggesting a binding for it would invent a recommendation the vendor withheld.
 *
 * @param {Record<string, any>} spec
 * @returns {Array<{ id: string, display_name: string, supported_efforts: string[] }>}
 */
function unboundModels(spec) {
  const rows = spec?.capabilities?.models;
  if (!Array.isArray(rows) || !rows.length) return [];
  const selected = new Set(MODEL_TIERS.map((tier) => spec.models?.[tier]).filter(Boolean));
  return rows
    .filter((row) => row && row.hidden !== true)
    .filter((row) => !selected.has(row.id) && !(row.aliases || []).some((alias) => selected.has(alias)))
    .map((row) => ({
      id: row.id,
      display_name: row.display_name || row.id,
      supported_efforts: Array.isArray(row.supported_efforts) ? row.supported_efforts.slice() : [],
    }));
}

/**
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @param {{ name?: string, rest?: string[] }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  // Valued flags are re-parsed off argv, never read from ctx.flags: the dispatcher's parseArgs
  // turns `--flag value` into a boolean plus a positional, so a verb reading ctx.flags works in
  // the `=` spelling and silently breaks in the space spelling.
  const flags = parseFlags(ctx.argv, ['refresh', 'root', 'json']);
  const rootScope = flags.root === true;
  const settings = read(repoRoot);
  const { path, pathRel, scopeLabel } = resolveRegistryPath(repoRoot, settings, { root: rootScope });

  const requested = [args?.name, ...(args?.rest || [])].filter(Boolean);
  let refreshed = null;
  if (flags.refresh === true) {
    refreshed = await refreshCapabilities(repoRoot, requested, rootScope);
  }

  const registry = rootScope ? readRegistry(path) : readEffectiveRegistry(repoRoot, settings);
  const effective = rootScope ? effectiveExecutors(registry) : registry.executors;
  const names = Object.keys(effective).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const selected = requested.length ? names.filter((name) => requested.includes(name)) : names;

  const unknown = requested.filter((name) => !names.includes(name));
  if (unknown.length) {
    throw new SidekicksError(
      `cli-executor models: unknown executor(s): ${unknown.join(', ')} — see 'sidekicks cli-executor list'`,
      EXIT_VALIDATION,
    );
  }

  const drift = [];
  const executors = selected.map((name) => {
    const spec = effective[name];
    const statuses = selectionStatus(spec);
    const caps = spec.capabilities || null;
    for (const tier of MODEL_TIERS) {
      if (statuses[tier] !== 'stale') continue;
      drift.push({
        executor: name,
        tier,
        reason: `selected model '${spec.models[tier]}' is absent from a complete catalog (or its effort is unsupported)`,
      });
    }
    if (caps && caps.status === 'unavailable') {
      drift.push({ executor: name, tier: null, reason: 'capability discovery reported the CLI unavailable' });
    }
    return {
      name,
      enabled: spec.enabled !== false,
      capabilities: caps
        ? {
          status: caps.status,
          cli_version: caps.cli_version || null,
          discovered_at: caps.discovered_at || null,
          source: caps.source?.kind || null,
          model_count: Array.isArray(caps.models) ? caps.models.length : 0,
        }
        : null,
      tiers: Object.fromEntries(MODEL_TIERS.map((tier) => [tier, {
        model: spec.models?.[tier] || null,
        effort: spec.efforts?.[tier] || null,
        status: statuses[tier],
      }])),
      unbound: unboundModels(spec),
    };
  });

  const exitCode = drift.length ? EXIT_VALIDATION : EXIT_OK;

  if (flags.json === true) {
    const payload = { target: pathRel, scope: scopeLabel, refreshed, executors, drift };
    return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode };
  }

  const pad = (value, width) => String(value).padEnd(width);
  const lines = [`cli-executor model tiers — scope: ${scopeLabel} (${pathRel})`, ''];
  if (refreshed) {
    lines.push(`  refreshed capability snapshots: ${refreshed.diff.map((d) => `${d.executor} +${d.added.length}/-${d.removed.length} (${d.status})`).join(', ')}`);
    lines.push('  (a refresh updates the CATALOG only — no tier was remapped)');
    lines.push('');
  }
  for (const row of executors) {
    const caps = row.capabilities;
    const header = caps
      ? `catalog: ${caps.status}  ${caps.model_count} model(s)  cli ${caps.cli_version || '(unknown)'}  discovered ${caps.discovered_at || '(unknown)'}  via ${caps.source || '(unknown)'}`
      : `catalog: none yet — run \`sidekicks cli-executor models ${row.name} --refresh\``;
    lines.push(`  ${pad(row.name, 14)}${row.enabled ? '' : '(disabled)  '}${header}`);
    for (const tier of MODEL_TIERS) {
      const entry = row.tiers[tier];
      const effort = entry.effort ? ` effort=${entry.effort}` : '';
      lines.push(`    ${pad(tier, 7)}${pad(entry.model ? entry.model + effort : '(unmapped)', 34)}${entry.status.toUpperCase() === 'STALE' ? 'STALE — not in catalog' : entry.status}`);
    }
    if (row.unbound.length) {
      lines.push(`    unbound catalog models (${row.unbound.length}) — the tier is yours to pick; nothing in a catalog row implies one:`);
      for (const model of row.unbound) {
        const efforts = model.supported_efforts.length ? `  efforts: ${model.supported_efforts.join(', ')}` : '';
        const display = model.display_name !== model.id ? `  (${model.display_name})` : '';
        lines.push(`      ${pad(model.id, 32)}${display}${efforts}`);
      }
      lines.push(`      bind one:  sidekicks cli-executor register ${row.name} --model-<tier> <id>`);
    }
    lines.push('');
  }
  if (drift.length) {
    lines.push('  drift:');
    for (const item of drift) {
      lines.push(`    ${item.executor}${item.tier ? ` ${item.tier}` : ''}: ${item.reason}`);
    }
    lines.push('');
  }
  lines.push(`Tiers are ${MODEL_TIERS.join(' | ')} — 'top' is the Fable/Mythos-class rung, mapped only where the CLI truly offers one.`);
  lines.push(`Set one:  sidekicks cli-executor register <name> --model-<tier> <id>   (empty value clears that tier)`);

  return { stdout: lines.join('\n') + '\n', exitCode };
}
