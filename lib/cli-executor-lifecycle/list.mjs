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
  readEffectiveRegistry,
  routingPolicy,
  skillRouting,
  parseFlags,
} from './_shared.mjs';
import { ROLES, resolveFamily, roleSupported } from './profiles.mjs';

/**
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx) {
  const { repoRoot } = ctx;
  const flags = parseFlags(ctx.argv, ['json', 'root']);
  const settings = read(repoRoot);
  const { path, pathRel, scopeLabel } = resolveRegistryPath(repoRoot, settings, { root: flags.root === true });
  const registry = flags.root === true ? readRegistry(path) : readEffectiveRegistry(repoRoot, settings);
  const effective = flags.root === true ? effectiveExecutors(registry) : registry.executors;

  const rows = Object.values(effective).map((spec) => ({
    name: spec.name,
    kind: spec.kind,
    enabled: spec.enabled !== false,
    // Canonical family and role dispatchability. `family` is resolved rather than read straight off
    // the spec so a built-in's compiled default shows up here too — an operator asking "can these
    // two seats judge each other" must not have to know which families are declared and which are
    // built in. `roles` reports what the executor may actually hold, because "registered" and
    // "dispatchable for a review" are different facts.
    family: resolveFamily(spec.name, spec),
    roles: Object.fromEntries(ROLES.map((role) => {
      const support = roleSupported(spec.name, spec, role);
      return [role, support.ok ? 'supported' : 'unsupported'];
    })),
    transport: spec.transport || (spec.kind === 'builtin' ? 'json' : 'print-mode'),
    binary: spec.kind === 'generic' ? (spec.binary || null) : `(native adapter)`,
    source: (registry.provenance?.executors?.[spec.name]?.source || 'builtin') === 'builtin' ? 'built-in default' : 'registered',
    models: spec.models && Object.keys(spec.models).length ? spec.models : null,
    specialties: Array.isArray(spec.specialties) && spec.specialties.length ? spec.specialties : null,
    model_specialties: spec.model_specialties && Object.keys(spec.model_specialties).length ? spec.model_specialties : null,
    efforts: spec.efforts && Object.keys(spec.efforts).length ? spec.efforts : null,
    capabilities: spec.capabilities || null,
    provenance: registry.provenance?.executors?.[spec.name] || { source: 'builtin' },
    selection_status: Object.fromEntries(['top', 'high', 'mid', 'low'].map((tier) => {
      const model = spec.models?.[tier];
      if (!model) return [tier, 'unmapped'];
      const caps = spec.capabilities;
      if (!caps || caps.status !== 'complete') return [tier, 'unverified'];
      const row = caps.models?.find((candidate) => candidate.id === model || candidate.aliases?.includes(model));
      if (!row) return [tier, 'stale'];
      const effort = spec.efforts?.[tier];
      return [tier, effort && row.supported_efforts?.length && !row.supported_efforts.includes(effort) ? 'stale' : 'valid'];
    })),
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
    const goalRoles = ROLES.filter((role) => r.roles[role] === 'supported');
    lines.push(
      `  ${pad('', 16)}family: ${r.family || '(none — contest-ineligible until registered)'}`
      + `  roles: ${goalRoles.length ? goalRoles.join(', ') : 'none (no role profile declared)'}`,
    );
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
