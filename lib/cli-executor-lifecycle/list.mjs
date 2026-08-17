// lib/cli-executor-lifecycle/list.mjs
// `sidekicks cli-executor list [--json]` — show the EFFECTIVE executor set for the active scope:
// the three built-ins merged with anything registered on disk. This is the "what CLIs can I
// delegate to" answer the executor family reads instead of guessing.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { read } from '../settings-store/settings.mjs';
import {
  resolveRegistryPath,
  readRegistry,
  effectiveExecutors,
  routingPolicy,
  skillRouting,
  parseFlags,
} from './_shared.mjs';

/**
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx) {
  const { repoRoot } = ctx;
  const flags = parseFlags(ctx.argv, ['json']);

  const { path, pathRel, scopeLabel } = resolveRegistryPath(repoRoot, read(repoRoot));
  const registry = readRegistry(path);
  const effective = effectiveExecutors(registry);
  const registeredNames = new Set(Object.keys(registry.executors));

  const rows = Object.values(effective).map((spec) => ({
    name: spec.name,
    kind: spec.kind,
    enabled: spec.enabled !== false,
    transport: spec.transport || (spec.kind === 'builtin' ? 'json' : 'print-mode'),
    binary: spec.kind === 'generic' ? (spec.binary || null) : `(native adapter)`,
    source: registeredNames.has(spec.name) ? 'registered' : 'built-in default',
    models: spec.models && Object.keys(spec.models).length ? spec.models : null,
    specialties: Array.isArray(spec.specialties) && spec.specialties.length ? spec.specialties : null,
    model_specialties: spec.model_specialties && Object.keys(spec.model_specialties).length ? spec.model_specialties : null,
  }));
  rows.sort((a, b) => a.name.localeCompare(b.name));

  // Routing rides along so ONE `list --json` call answers everything the orchestrator needs:
  // which CLIs exist, what each (and each model tier) is best at, the global fallback chain, and
  // the per-task-kind recommendations.
  const prefer = routingPolicy(registry);
  const skills = skillRouting(registry);
  const routing = {
    prefer: prefer.length ? prefer : null,
    skills: Object.keys(skills).length ? skills : null,
  };

  if (flags.json) {
    return {
      stdout: JSON.stringify({ scope: scopeLabel, registry_path: pathRel, executors: rows, routing }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const lines = [];
  lines.push(`cli-executor registry — scope: ${scopeLabel} (${pathRel})`);
  lines.push('');
  const pad = (s, n) => String(s).padEnd(n);
  lines.push(`  ${pad('NAME', 16)}${pad('KIND', 10)}${pad('STATE', 10)}${pad('TRANSPORT', 12)}${pad('SOURCE', 18)}INVOKE`);
  for (const r of rows) {
    const invoke = r.kind === 'generic'
      ? `${r.binary} ${(effective[r.name].invoke || []).join(' ')}`.trim()
      : '(native adapter)';
    lines.push(
      `  ${pad(r.name, 16)}${pad(r.kind, 10)}${pad(r.enabled ? 'enabled' : 'disabled', 10)}` +
      `${pad(r.transport, 12)}${pad(r.source, 18)}${invoke}`
    );
    if (r.models) {
      const tiers = ['high', 'mid', 'low'].filter((t) => r.models[t]).map((t) => `${t}=${r.models[t]}`).join(' ');
      lines.push(`  ${pad('', 16)}models: ${tiers}`);
    }
    if (r.specialties) {
      lines.push(`  ${pad('', 16)}best at: ${r.specialties.join(', ')}`);
    }
    if (r.model_specialties) {
      for (const tier of ['high', 'mid', 'low']) {
        if (!r.model_specialties[tier]) continue;
        const modelId = r.models && r.models[tier] ? ` (${r.models[tier]})` : '';
        lines.push(`  ${pad('', 16)}${tier}${modelId}: ${r.model_specialties[tier].join(', ')}`);
      }
    }
  }
  if (routing.skills) {
    lines.push('');
    lines.push('  recommended executors by task kind (routing.skills):');
    for (const key of Object.keys(routing.skills).sort()) {
      const entry = routing.skills[key];
      const avoid = entry.avoid && entry.avoid.length ? `  avoid: ${entry.avoid.join(', ')}` : '';
      lines.push(`    ${key}: ${entry.prefer.join(' → ')}${avoid}`);
      if (entry.note) lines.push(`      note: ${entry.note}`);
    }
  }
  lines.push('');
  lines.push(`Register a new CLI:  sidekicks cli-executor register <name> --binary <exe> --invoke '<args,{brief}>'`);
  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}
