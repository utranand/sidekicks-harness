// lib/cli-executor-lifecycle/register.mjs
// `sidekicks cli-executor register <name> [flags]` — register (or update) an external agent CLI
// in the scope-resolved registry so sk-cli-executor / sk-cli-orchestrator can
// delegate to it WITHOUT guessing. A generic CLI needs no bespoke Python adapter — it is driven
// entirely by the declared binary + invoke template.
//
// Examples:
//   sidekicks cli-executor register my-cli --binary mycli --invoke '-p,{brief}' --probe '--version'
//   sidekicks cli-executor register my-cli --binary mycli --invoke 'run' --brief-stdin
//   sidekicks cli-executor register codex --disabled          # re-annotate/disable a built-in
//   sidekicks cli-executor register codex --model-high gpt-5-codex --model-mid gpt-5 --model-low gpt-5-mini
//                                                             # set the tier→model map the orchestrator
//                                                             # resolves by task complexity (empty value clears a tier)
//   sidekicks cli-executor register codex --specialties 'code implementation,refactoring,debugging'
//                                                             # capability hints the orchestrator routes
//                                                             # tasks against (empty value clears the list)
//   sidekicks cli-executor register codex --model-specialties-high 'complex implementation,deep debugging' \
//                                         --model-specialties-low 'boilerplate,bulk mechanical edits'
//                                                             # pair each model tier with the jobs it is
//                                                             # best at — the orchestrator picks the item's
//                                                             # model_tier by fit (empty value clears a tier)
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { read } from '../settings-store/settings.mjs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  resolveRegistryPath,
  readRegistry,
  writeRegistry,
  validateSpec,
  parseFlags,
  splitListFlag,
  BUILTIN_NAMES,
  MODEL_TIERS,
} from './_shared.mjs';

/**
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = args.name;
  if (!name) {
    throw new SidekicksError('cli-executor register: a <name> is required', EXIT_VALIDATION);
  }

  const flags = parseFlags(ctx.argv, ['brief-stdin', 'usage-exposed', 'enabled', 'disabled', 'force']);

  if (flags.enabled && flags.disabled) {
    throw new SidekicksError('cli-executor register: pass at most one of --enabled / --disabled', EXIT_VALIDATION);
  }

  // A bare `register <builtin> [--enabled|--disabled]` re-annotates a native adapter; otherwise
  // the presence of --binary/--invoke means a generic registration.
  const isBuiltinName = BUILTIN_NAMES.includes(name);
  const looksGeneric = flags.binary !== undefined || flags.invoke !== undefined;
  const kind = flags.kind || (isBuiltinName && !looksGeneric ? 'builtin' : 'generic');

  const { path, pathRel } = resolveRegistryPath(repoRoot, read(repoRoot));
  const registry = readRegistry(path);
  const existed = Object.prototype.hasOwnProperty.call(registry.executors, name);
  const prior = existed ? registry.executors[name] : {};

  const spec = { kind, enabled: flags.disabled ? false : true };
  // Carry forward the existing description when --description isn't given (like models/specialties
  // below), so a partial re-register — e.g. setting only a model tier — never silently wipes it.
  if (flags.description) spec.description = String(flags.description);
  else if (prior.description) spec.description = String(prior.description);

  if (kind === 'generic') {
    // Like description/models/specialties: every generic field carries forward from the prior
    // entry when its flag is absent, so a partial re-register (e.g. setting only a model-tier
    // specialty on 'claude') never wipes the binary/invoke template it did not mention.
    if (flags.binary !== undefined) spec.binary = String(flags.binary);
    else if (prior.binary) spec.binary = String(prior.binary);
    const invoke = splitListFlag(flags.invoke);
    if (invoke) spec.invoke = invoke;
    else if (Array.isArray(prior.invoke) && prior.invoke.length) spec.invoke = prior.invoke.slice();
    const probe = splitListFlag(flags.probe);
    if (probe) spec.probe = probe;
    else if (Array.isArray(prior.probe) && prior.probe.length) spec.probe = prior.probe.slice();
    if (flags.transport) spec.transport = String(flags.transport);
    else if (prior.transport) spec.transport = String(prior.transport);
    if (flags.sandbox) spec.sandbox = String(flags.sandbox);
    else if (prior.sandbox) spec.sandbox = String(prior.sandbox);
    spec.brief_stdin = flags['brief-stdin'] === true || (flags['brief-stdin'] === undefined && prior.brief_stdin === true);
    spec.usage_exposed = flags['usage-exposed'] === true || (flags['usage-exposed'] === undefined && prior.usage_exposed === true);
  }

  // Model tiers: carry forward any existing map, then apply `--model-<tier>` overrides. A flag with
  // an EMPTY value (`--model-high ''`) clears that tier — so a re-annotation neither silently wipes
  // configured models nor forces re-supplying every tier just to change one.
  const models = { ...(prior.models && typeof prior.models === 'object' ? prior.models : {}) };
  for (const tier of MODEL_TIERS) {
    const flagVal = flags[`model-${tier}`];
    if (flagVal === undefined) continue;
    if (flagVal === '') delete models[tier];
    else models[tier] = String(flagVal);
  }
  if (Object.keys(models).length) spec.models = models;

  // Specialties: `--specialties 'a,b,c'` sets the whole list (the orchestrator routes tasks against
  // it); carry forward the existing list when the flag is absent, clear it with an empty value.
  if (flags.specialties === undefined) {
    if (Array.isArray(prior.specialties) && prior.specialties.length) spec.specialties = prior.specialties.slice();
  } else if (flags.specialties !== '') {
    spec.specialties = splitListFlag(flags.specialties) || [];
  }

  // Per-tier model specialties: `--model-specialties-<tier> 'a,b'` pairs THAT tier's model with the
  // jobs it is best at. Same merge semantics as `models`: carry the existing map forward, apply the
  // given tiers, an EMPTY value clears just that tier.
  const modelSpecialties = {
    ...(prior.model_specialties && typeof prior.model_specialties === 'object' ? prior.model_specialties : {}),
  };
  for (const tier of MODEL_TIERS) {
    const flagVal = flags[`model-specialties-${tier}`];
    if (flagVal === undefined) continue;
    if (flagVal === '') delete modelSpecialties[tier];
    else modelSpecialties[tier] = splitListFlag(String(flagVal)) || [];
  }
  if (Object.keys(modelSpecialties).length) spec.model_specialties = modelSpecialties;

  const normalized = validateSpec(name, spec); // throws on any invalid field

  registry.executors[name] = normalized;
  writeRegistry(path, registry, repoRoot);

  const verb = existed ? 'updated' : 'registered';
  const state = normalized.enabled ? 'enabled' : 'disabled';
  const detail = normalized.kind === 'generic'
    ? ` (${normalized.binary} ${normalized.invoke.join(' ')})`
    : ' (built-in)';
  const modelDetail = normalized.models
    ? ` models[${MODEL_TIERS.filter((t) => normalized.models[t]).map((t) => `${t}=${normalized.models[t]}`).join(' ')}]`
    : '';
  const specialtyDetail = normalized.specialties ? ` specialties[${normalized.specialties.join(', ')}]` : '';
  const tierSpecialtyDetail = normalized.model_specialties
    ? ` model-specialties[${MODEL_TIERS.filter((t) => normalized.model_specialties[t])
        .map((t) => `${t}: ${normalized.model_specialties[t].join(', ')}`).join(' | ')}]`
    : '';
  return {
    stdout: `${verb} ${normalized.kind} executor '${name}' [${state}]${detail}${modelDetail}${specialtyDetail}${tierSpecialtyDetail} in ${pathRel}\n`,
    exitCode: EXIT_OK,
  };
}
