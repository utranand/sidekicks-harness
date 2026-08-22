// lib/cli-executor-lifecycle/profiles.mjs
// How each agent CLI is invoked for one ROLE — the argv, the prompt transport, the output parser,
// and the containment that role requires.
//
// EVERY FLAG BELOW WAS READ OFF THE INSTALLED CLI, not recalled. Verified 2026-08-21:
//   claude --help  → --permission-mode <mode>, --output-format <format>, --json-schema <schema>
//                    (the help's own example is INLINE JSON; no path form is documented),
//                    --model <model>, --effort <level>
//   gemini --help  → --approval-mode default|auto_edit|yolo|plan, -o/--output-format text|json|
//                    stream-json, -m/--model. There is NO schema flag.
//   agy --help     → --mode accept-edits|plan, --json-schema (string OR path to a schema file),
//                    --output-format text|json|stream-json, --model, --effort low|medium|high
//   codex exec --help → -s/--sandbox <MODE>, --approve-for-me, --output-schema <FILE>, --json,
//                    -m/--model, -c <key=value>; [PROMPT] positional, and `-` means read the
//                    prompt from stdin.
//   codex exec resume --help → exposes NEITHER --sandbox NOR --approve-for-me.
//
// TWO CONSEQUENCES THAT ARE NOT NEGOTIABLE.
//
// 1. CODEX HAS NO PLAN MODE. It has an enforced read-only sandbox, which is a stronger boundary than
//    a cooperative "plan mode" but a different thing, and the engine must not claim otherwise. Its
//    read-only roles are `--sandbox read-only` plus a planning-only role prompt and a strict output
//    schema.
//
// 2. A CODEX IMPLEMENTATION SESSION CANNOT BE RESUMED SAFELY. `codex exec resume` accepts no sandbox
//    or approval flag, so resuming a `workspace-write` session would silently re-enter it under
//    whatever the config default happens to be — a containment downgrade invisible at the call site.
//    So resume is refused for that combination and the correction relaunches a fresh session from
//    the complete on-disk brief. The same fail-closed rule applies to any executor whose resume
//    containment is not demonstrable.
//
// GEMINI HAS NO SCHEMA ENFORCEMENT. Its structured output is validated locally, and the invoker is
// allowed exactly one read-only format-repair turn before failing. Advertising it as `none` here is
// what makes that difference visible to the caller instead of hidden in a parser.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { MODEL_TIERS } from './_shared.mjs';

/** The roles a goal run dispatches. */
export const ROLES = Object.freeze(['plan', 'implement', 'review', 'final-verify']);

/**
 * Containment each role requires. Three of the four are read-only by CLI ENFORCEMENT, not by asking
 * the model nicely: a planner, a reviewer and a final verifier that can edit the tree are not
 * independent of it.
 */
export const ROLE_CONTAINMENT = Object.freeze({
  plan: 'read-only',
  review: 'read-only',
  'final-verify': 'read-only',
  implement: 'bounded-edit',
});

/**
 * Canonical model families for the built-ins.
 *
 * WHY antigravity IS `google` BY DEFAULT. Family answers one question: would two seats be
 * INDEPENDENT of each other? `agy` is Google's agentic CLI and its default backing models are
 * Gemini-class, so a Gemini candidate judged by an Antigravity judge is a vendor grading itself. An
 * operator who has pointed a CLI at a different vendor's models corrects it explicitly with
 * `cli-executor register <name> --family <f>` — and if that makes it collide with another seat, the
 * collision is CORRECT: the contest then declines to treat them as independent.
 */
export const CANONICAL_FAMILIES = Object.freeze({
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  antigravity: 'google',
});

/** How a CLI accepts structured-output schemas. */
export const SCHEMA_TRANSPORTS = Object.freeze(['file', 'inline', 'none']);

/**
 * The mechanisms by which a CLI can be made to REFUSE a command before running it.
 *
 * `tool-deny` is a declarative deny list the CLI enforces on its own tool calls. `tool-allowlist`
 * removes every tool except a named safe set, so there is no command surface to spell around.
 * `os-sandbox` is kernel-level confinement applied to every command the CLI spawns. All three are
 * enforcement; a prompt that asks the model not to do something is not.
 */
export const ENFORCEMENT_MECHANISMS = Object.freeze(['tool-deny', 'tool-allowlist', 'os-sandbox']);

/**
 * The hard-stopped action classes, as strings.
 *
 * DUPLICATED ON PURPOSE. The canonical taxonomy with its prose lives in
 * `lib/goal-lifecycle/policy.mjs`, and importing it here would make the executor registry depend on
 * the goal engine — the wrong direction, since `cli-executor` is usable without it. The two lists are
 * kept identical by `tests/goal-lifecycle/policy.test.mjs`, which imports both and fails on drift.
 */
const ENFORCEABLE_CLASSES = Object.freeze([
  'push', 'pull-request', 'deploy', 'db-write', 'prod-access', 'destructive', 'publish',
  'outward-message', 'credential-write',
]);

/**
 * A command deny list cannot safely enumerate every spelling. An absolute path and an
 * in-process API (`node -e "fs.rmSync(…)"`) both name something else, and no flag any installed CLI
 * exposes can close every spelling. That is why the implementation profile below removes the
 * command surface instead of claiming the write-boundary gate can repair a destructive in-root act.
 *
 * Claude implementation exposes file inspection/editing only. Safe mode removes hooks/plugins and
 * custom agents; strict MCP mode with no MCP config removes user/project servers. With no Bash or
 * terminal tool, absolute binaries, wrappers, and interpreter/library process APIs have no execution
 * surface. The engine runs approved tests after the session returns.
 */
const CLAUDE_IMPLEMENT_BOUNDARY = Object.freeze([
  '--safe-mode',
  '--strict-mcp-config',
  '--no-chrome',
  '--tools', 'Read,Edit,Write,Glob,Grep',
]);

/** How a CLI's final result is parsed out of its stdout. */
export const OUTPUT_PARSERS = Object.freeze(['claude-json', 'gemini-json', 'agy-json', 'codex-jsonl', 'text']);

/**
 * Windows command-line ceiling. An INLINE schema plus a prompt has to fit inside it — with the
 * cmd.exe caret escaping the shim path adds on top — so an over-length invocation fails closed
 * BEFORE dispatch rather than being truncated by the OS into a subtly different command.
 */
export const WINDOWS_COMMAND_LIMIT = 32_000;

/**
 * The built-in per-CLI profiles.
 *
 * `read_only_args` / `edit_args` are the containment half; everything else describes transport. A
 * built-in with no `edit_args` would be planning-only — none currently are, but the invoker checks
 * rather than assuming.
 */
const BUILTIN_PROFILES = Object.freeze({
  claude: Object.freeze({
    bin: 'claude',
    read_only_args: Object.freeze(['--permission-mode', 'plan']),
    edit_args: Object.freeze(['--permission-mode', 'acceptEdits']),
    base_args: Object.freeze(['--output-format', 'json']),
    prompt: 'flag:-p',
    model_flag: '--model',
    effort_flag: '--effort',
    schema: 'inline',
    schema_flag: '--json-schema',
    parser: 'claude-json',
    // Checked by the CLI before tools are exposed — see CLAUDE_IMPLEMENT_BOUNDARY.
    enforcement: Object.freeze({
      mechanism: 'tool-allowlist',
      args: CLAUDE_IMPLEMENT_BOUNDARY,
      enforces: Object.freeze([...ENFORCEABLE_CLASSES]),
      gaps: Object.freeze([]),
      note: 'claude safe mode plus an explicit built-in tool allowlist exposes file inspection and '
        + 'editing only; Bash, interpreters, MCP, plugins, hooks, custom agents and browser '
        + 'integration are unavailable, so hard-stopped commands have no execution surface',
    }),
    resume_flag: '--resume',
    // Claude's resume re-enters the session with the flags given on THIS command line, so
    // containment is re-asserted rather than inherited — safe to resume in any role.
    resume_roles: Object.freeze(['plan', 'implement', 'review', 'final-verify']),
  }),
  gemini: Object.freeze({
    bin: 'gemini',
    read_only_args: Object.freeze(['--approval-mode', 'plan']),
    edit_args: Object.freeze(['--approval-mode', 'auto_edit']),
    base_args: Object.freeze(['-o', 'json']),
    prompt: 'flag:-p',
    model_flag: '-m',
    effort_flag: null,
    // No schema flag exists. The result is validated locally, with one read-only repair turn.
    schema: 'none',
    schema_flag: null,
    parser: 'gemini-json',
    // `--allowed-tools` is DEPRECATED in favour of a Policy Engine configured outside the command
    // line, and `--approval-mode auto_edit` describes which prompts are auto-answered, not which
    // commands are refused. There is nothing here this engine can assert per invocation, so gemini
    // holds no implementation role rather than holding one on an unverifiable boundary.
    enforcement: null,
    enforcement_gap: 'gemini exposes no per-invocation command-deny flag (--allowed-tools is '
      + 'deprecated in favour of an out-of-band Policy Engine), so an implementation session on it '
      + 'cannot be shown to refuse a push or a deploy before it runs',
    resume_flag: null,
    resume_roles: Object.freeze([]),
  }),
  antigravity: Object.freeze({
    bin: 'agy',
    read_only_args: Object.freeze(['--mode', 'plan']),
    edit_args: Object.freeze(['--mode', 'accept-edits']),
    base_args: Object.freeze(['--output-format', 'json']),
    prompt: 'flag:-p',
    model_flag: '--model',
    effort_flag: '--effort',
    // agy's --json-schema takes a string OR a path; a path keeps the command line short.
    schema: 'file',
    schema_flag: '--json-schema',
    parser: 'agy-json',
    // agy's only permission flag is `--dangerously-skip-permissions`, which is the opposite of a deny
    // list. `--mode accept-edits` says which prompts are auto-answered; it does not name a command
    // that will be refused. Same fail-closed conclusion as gemini.
    enforcement: null,
    enforcement_gap: 'agy exposes no command-deny flag — its only permission switch '
      + '(--dangerously-skip-permissions) widens permission rather than narrowing it',
    resume_flag: null,
    resume_roles: Object.freeze([]),
  }),
  codex: Object.freeze({
    bin: 'codex',
    // `exec` is a subcommand, so it leads the argv before anything else.
    lead_args: Object.freeze(['exec']),
    // NOT a plan mode — an enforced read-only sandbox. See the header.
    read_only_args: Object.freeze(['--sandbox', 'read-only']),
    edit_args: Object.freeze(['--sandbox', 'workspace-write', '--approve-for-me']),
    base_args: Object.freeze(['--json']),
    prompt: 'stdin-dash',
    model_flag: '-m',
    effort_flag: 'config:model_reasoning_effort',
    schema: 'file',
    schema_flag: '--output-schema',
    parser: 'codex-jsonl',
    // `workspace-write` is an OS-level sandbox: writes are confined to the workspace and network
    // access is off, which stops every class that has to leave this machine. It does NOT stop a
    // destructive command against files INSIDE the workspace — `rm -rf`, `git reset --hard` — because
    // those are exactly the writes the sandbox is there to permit.
    //
    // THAT GAP MAKES CODEX IMPLEMENTATION-INELIGIBLE. Claude removes the command tool entirely; a
    // workspace-write sandbox cannot be narrowed the same way. The destructive class is outside what
    // the mechanism decides about, and `codex exec --help` exposes no second mechanism to add. The engine's
    // own PATH guard is a floor under a boundary, never the boundary itself, because an absolute path
    // walks around it — so "the guard covers it" is not an answer here.
    enforcement: Object.freeze({
      mechanism: 'os-sandbox',
      args: Object.freeze([]),
      enforces: Object.freeze([
        'push', 'pull-request', 'deploy', 'db-write', 'prod-access', 'publish', 'outward-message',
        'credential-write',
      ]),
      gaps: Object.freeze(['destructive']),
      note: 'codex --sandbox workspace-write confines writes to the workspace and disables network '
        + 'access, so nothing reaches a remote; a destructive command against workspace files is '
        + 'inside the sandbox and is therefore not decided by it',
    }),
    enforcement_gap: 'codex --sandbox workspace-write cannot refuse a destructive command against '
      + 'files inside the workspace — permitting workspace writes is what the mode is for — and '
      + '`codex exec` exposes no command-deny flag to add one, so a destructive class would rest only '
      + 'on the engine PATH guard, which an absolute binary path bypasses',
    resume_flag: null,
    // `codex exec resume` carries no sandbox/approval flag, so resuming an implementation session
    // would re-enter it under an unknown containment. Refused; see the header.
    resume_roles: Object.freeze([]),
  }),
});

/** The built-in executor names this module has a profile for. */
export const PROFILED_BUILTINS = Object.freeze(Object.keys(BUILTIN_PROFILES));

/**
 * The canonical family of an executor, or null when a generic executor has not declared one.
 *
 * A generic executor WITHOUT a family stays fully usable for ordinary execution — that is the
 * backward-compatibility promise — but it is contest-ineligible, because the contest's entire
 * independence guarantee is the family value.
 *
 * @param {string} name
 * @param {object} [spec] - the effective registry entry
 * @returns {string|null}
 */
export function resolveFamily(name, spec = {}) {
  if (typeof spec.family === 'string' && spec.family !== '') return spec.family;
  if (Object.prototype.hasOwnProperty.call(CANONICAL_FAMILIES, name)) return CANONICAL_FAMILIES[name];
  return null;
}

/**
 * The invocation profile for an executor, built-in or generic.
 *
 * @param {string} name
 * @param {object} [spec]
 * @returns {object}
 * @throws {SidekicksError} EXIT_VALIDATION when nothing can describe how to invoke it
 */
export function profileFor(name, spec = {}) {
  const compiled = BUILTIN_PROFILES[name];
  // A spec's OWN profile always wins — that is what declaring one means.
  if (compiled && !spec.profile) {
    // The compiled profile applies when this entry really is that CLI. `kind: 'builtin'` says so
    // directly; a `kind: 'generic'` entry qualifies only when its binary IS the built-in's binary.
    //
    // That second case is not hypothetical. `cli-executor register` refuses a built-in name as
    // generic today, but registries written before that guard exist — this repo's own has `claude`
    // as `kind: generic` with `binary: claude`. Reading that as "unknown CLI, no roles" would leave
    // a correctly-installed Claude undispatchable for reasons an operator cannot see. Matching on
    // the BINARY rather than the name is what keeps it honest: an entry named `claude` pointing at
    // some other executable gets no compiled profile, because these flags are that CLI's flags.
    const declaredBin = typeof spec.binary === 'string' ? spec.binary : null;
    const binMatches = declaredBin === null
      ? true
      : declaredBin === compiled.bin
        || declaredBin.split(/[\\/]/).pop().replace(/\.(cmd|bat|exe)$/i, '') === compiled.bin;
    if ((spec.kind ?? 'builtin') === 'builtin' || binMatches) {
      return declaredBin && declaredBin !== compiled.bin
        ? { ...compiled, bin: declaredBin }
        : compiled;
    }
  }
  const declared = spec.profile;
  if (!declared || typeof declared !== 'object') {
    throw new SidekicksError(
      `cli-executor: '${name}' has no role invocation profile — a generic executor must declare one `
      + '(plan args, edit args, prompt transport, output parser, structured output, session resume) '
      + 'before it can be dispatched for a goal role. Nothing is inferred from an invoke template: a '
      + 'guessed plan-safe or writable invocation is exactly the mistake this refusal prevents.',
      EXIT_VALIDATION,
    );
  }
  return {
    bin: String(spec.binary || name),
    lead_args: Array.isArray(declared.lead_args) ? declared.lead_args.slice() : [],
    read_only_args: Array.isArray(declared.read_only_args) ? declared.read_only_args.slice() : null,
    edit_args: Array.isArray(declared.edit_args) ? declared.edit_args.slice() : null,
    base_args: Array.isArray(declared.base_args) ? declared.base_args.slice() : [],
    prompt: String(declared.prompt || (spec.brief_stdin ? 'stdin' : 'positional')),
    model_flag: declared.model_flag ?? null,
    effort_flag: declared.effort_flag ?? null,
    schema: SCHEMA_TRANSPORTS.includes(declared.schema) ? declared.schema : 'none',
    schema_flag: declared.schema_flag ?? null,
    parser: OUTPUT_PARSERS.includes(declared.parser) ? declared.parser : 'text',
    resume_flag: declared.resume_flag ?? null,
    resume_roles: Array.isArray(declared.resume_roles) ? declared.resume_roles.slice() : [],
    enforcement: normalizeEnforcement(declared.enforcement),
    enforcement_gap: typeof declared.enforcement_gap === 'string' ? declared.enforcement_gap : null,
  };
}

/**
 * Normalize a declared enforcement block, or null when it does not describe enforcement.
 *
 * Anything malformed becomes null rather than a partially-trusted block: a profile that declares
 * `mechanism: "prompt"` is claiming enforcement it does not have, and reading that as "some
 * enforcement" is how an implementation role gets handed to a CLI that refuses nothing.
 *
 * @param {unknown} declared
 * @returns {object|null}
 */
export function normalizeEnforcement(declared) {
  if (!declared || typeof declared !== 'object') return null;
  const mechanism = String(declared.mechanism ?? '');
  if (!ENFORCEMENT_MECHANISMS.includes(mechanism)) return null;
  const enforces = (Array.isArray(declared.enforces) ? declared.enforces : [])
    .map(String)
    .filter((c) => ENFORCEABLE_CLASSES.includes(c));
  if (enforces.length === 0) return null;
  return {
    mechanism,
    args: (Array.isArray(declared.args) ? declared.args : []).map(String),
    enforces,
    gaps: (Array.isArray(declared.gaps) ? declared.gaps : []).map(String),
    note: String(declared.note ?? ''),
  };
}

/**
 * The action classes this executor's own enforcement does NOT cover.
 *
 * Every class outside `enforces` is a gap whether or not the profile listed it — an omission is not a
 * claim of coverage.
 *
 * @param {string} name
 * @param {object} spec
 * @returns {string[]}
 */
export function enforcementGaps(name, spec = {}) {
  let profile;
  try {
    profile = profileFor(name, spec);
  } catch {
    return [...ENFORCEABLE_CLASSES];
  }
  const enforced = new Set(profile.enforcement?.enforces ?? []);
  const declaredGaps = new Set(profile.enforcement?.gaps ?? []);
  return ENFORCEABLE_CLASSES.filter((c) => !enforced.has(c) || declaredGaps.has(c));
}

/**
 * Can this executor be dispatched in `role` at all?
 *
 * @param {string} name
 * @param {object} spec
 * @param {string} role
 * @returns {{ok: boolean, reason: string}}
 */
export function roleSupported(name, spec, role) {
  if (!ROLES.includes(role)) return { ok: false, reason: `unknown role '${role}'` };
  let profile;
  try {
    profile = profileFor(name, spec);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const containment = ROLE_CONTAINMENT[role];
  if (containment === 'read-only' && !profile.read_only_args) {
    return {
      ok: false,
      reason: `'${name}' declares no read-only invocation, so it cannot hold the ${role} role — a `
        + 'planner or reviewer that can edit the tree is not independent of it',
    };
  }
  if (containment === 'bounded-edit' && !profile.edit_args) {
    return { ok: false, reason: `'${name}' declares no bounded edit invocation, so it cannot implement` };
  }
  // An implementation session is the only role that can act on the world, so it is the only role that
  // needs an enforceable boundary rather than a cooperative one. A CLI that cannot be told to REFUSE
  // a push, a deploy or a database write does not hold this role — the engine's own command guard is a
  // second floor under this one, not a substitute for it, because a guard on PATH is bypassed by an
  // absolute path and a CLI's own deny check is not.
  if (containment === 'bounded-edit' && !profile.enforcement) {
    return {
      ok: false,
      reason: `'${name}' declares no enforceable command policy, so it cannot hold the implement role`
        + `${profile.enforcement_gap ? ` — ${profile.enforcement_gap}` : ''}. Asking a model not to `
        + 'push is not the same as a CLI that refuses to. Register an executor whose profile declares '
        + "an 'enforcement' block (mechanism: tool-deny | tool-allowlist | os-sandbox), or route this "
        + 'node to one that '
        + 'has one.',
    };
  }
  // PARTIAL enforcement is not enforcement for the class it misses. A CLI that covers eight of the
  // nine hard-stopped classes leaves the ninth resting on the engine's PATH guard alone, and that
  // guard is bypassed by an absolute binary path — so the honest reading of "one boundary, and it can
  // be walked around" is that the class has no boundary. The executor keeps every read-only role;
  // it just does not get to be the one holding the edit permission.
  if (containment === 'bounded-edit') {
    const gaps = enforcementGaps(name, spec);
    if (gaps.length > 0) {
      return {
        ok: false,
        reason: `'${name}' cannot hold the implement role: its own enforcement does not cover `
          + `${gaps.join(', ')}${profile.enforcement_gap ? ` — ${profile.enforcement_gap}` : ''}. `
          + "The engine's command guard is a second floor under a CLI boundary, not a substitute for "
          + 'one: a PATH shim is bypassed by an absolute binary path, so a class covered only by the '
          + 'guard is a class with no enforced boundary. Route this node to an executor whose '
          + 'enforcement covers every hard-stopped class.',
      };
    }
  }
  return { ok: true, reason: '' };
}

/**
 * Resolve a tier to this executor's concrete model id, failing closed rather than downgrading.
 *
 * "Never silently downgrade" is the whole rule (CLAUDE.md → subagent model selection): an unmapped
 * tier means the caller must either pick an executor that maps it or request a different tier
 * explicitly. Letting it fall through to the CLI default would run high-stakes work on whatever
 * model happens to be configured.
 *
 * @param {string} name
 * @param {object} spec
 * @param {string} tier
 * @returns {string}
 * @throws {SidekicksError} EXIT_VALIDATION
 */
export function resolveModel(name, spec, tier) {
  if (!MODEL_TIERS.includes(tier)) {
    throw new SidekicksError(
      `cli-executor: '${tier}' is not a model tier (${MODEL_TIERS.join(', ')})`,
      EXIT_VALIDATION,
    );
  }
  const id = spec?.models?.[tier];
  if (typeof id !== 'string' || id === '') {
    throw new SidekicksError(
      `cli-executor: '${name}' maps no model for tier '${tier}' — register one with `
      + `'cli-executor register ${name} --model-${tier} <id>'. A missing tier fails closed; it is `
      + 'never silently downgraded to the CLI default.',
      EXIT_VALIDATION,
    );
  }
  return id;
}

/**
 * This executor's reasoning-effort value for a tier, or null when it maps none.
 *
 * @param {object} spec
 * @param {string} tier
 * @returns {string|null}
 */
export function resolveEffort(spec, tier) {
  const value = spec?.efforts?.[tier];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The highest tier this executor maps, searching `order` in preference sequence.
 *
 * This is the contest's "highest available" policy (top → high) and is deliberately NOT the same
 * thing as a mandatory tier request: it selects among what IS mapped, so it never downgrades a
 * request that was made explicitly.
 *
 * @param {object} spec
 * @param {string[]} [order]
 * @returns {string|null}
 */
export function highestMappedTier(spec, order = ['top', 'high']) {
  for (const tier of order) {
    if (typeof spec?.models?.[tier] === 'string' && spec.models[tier] !== '') return tier;
  }
  return null;
}

/**
 * May this role's session be resumed on this executor?
 *
 * @param {string} name
 * @param {object} spec
 * @param {string} role
 * @returns {{ok: boolean, reason: string}}
 */
export function resumeSupported(name, spec, role) {
  const profile = profileFor(name, spec);
  if (!profile.resume_flag || !profile.resume_roles.includes(role)) {
    return {
      ok: false,
      reason: `'${name}' cannot resume a ${role} session with its containment intact — the correction `
        + 'relaunches a fresh session from the persisted brief instead',
    };
  }
  return { ok: true, reason: '' };
}

/**
 * Build one role invocation.
 *
 * @param {{name: string, spec: object, role: string, tier: string, prompt: string,
 *          schemaPath?: string|null, schemaJson?: string|null, resumeSession?: string|null}} input
 * @returns {{bin: string, args: string[], stdin: string|null, parser: string, containment: string,
 *            model: string, effort: string|null, family: string|null, schema: string,
 *            resumed: boolean, commandLength: number}}
 * @throws {SidekicksError} EXIT_VALIDATION on any unsupported combination
 */
export function buildInvocation(input) {
  const { name, spec = {}, role, tier, prompt } = input;
  const support = roleSupported(name, spec, role);
  if (!support.ok) throw new SidekicksError(`cli-executor: ${support.reason}`, EXIT_VALIDATION);
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new SidekicksError(`cli-executor: ${role} invocation needs a non-empty prompt`, EXIT_VALIDATION);
  }

  const profile = profileFor(name, spec);
  const containment = ROLE_CONTAINMENT[role];
  const model = resolveModel(name, spec, tier);
  const effort = resolveEffort(spec, tier);

  /** @type {string[]} */
  const args = [...(profile.lead_args || [])];

  if (input.resumeSession) {
    const r = resumeSupported(name, spec, role);
    if (!r.ok) throw new SidekicksError(`cli-executor: ${r.reason}`, EXIT_VALIDATION);
    args.push(profile.resume_flag, input.resumeSession);
  }

  // Containment BEFORE anything a model influenced. Ordering does not change how a CLI parses its
  // own flags, but it keeps the boundary at the front of every recorded command line, where a human
  // auditing a transcript will see it first.
  args.push(...(containment === 'read-only' ? profile.read_only_args : profile.edit_args));
  // The deny list rides immediately behind the containment flag, for the same auditing reason and
  // because it is the other half of the same boundary. Read-only roles do not carry it: they cannot
  // run a command in the first place, and a deny list on a session that has no tool to deny reads as
  // if the containment were weaker than it is.
  if (containment === 'bounded-edit' && profile.enforcement?.args?.length) {
    args.push(...profile.enforcement.args);
  }
  args.push(...(profile.base_args || []));

  if (profile.model_flag) args.push(profile.model_flag, model);
  if (effort && profile.effort_flag) {
    if (profile.effort_flag.startsWith('config:')) {
      args.push('-c', `${profile.effort_flag.slice('config:'.length)}=${effort}`);
    } else {
      args.push(profile.effort_flag, effort);
    }
  }

  // Structured output: a FILE wherever the CLI accepts a path, because an inline schema competes
  // with the prompt for the Windows command-line ceiling.
  if (profile.schema === 'file') {
    if (!input.schemaPath) {
      throw new SidekicksError(
        `cli-executor: '${name}' takes its output schema as a FILE path (${profile.schema_flag}) — `
        + 'pass schemaPath',
        EXIT_VALIDATION,
      );
    }
    args.push(profile.schema_flag, input.schemaPath);
  } else if (profile.schema === 'inline') {
    if (!input.schemaJson) {
      throw new SidekicksError(
        `cli-executor: '${name}' takes its output schema INLINE (${profile.schema_flag}) — pass `
        + 'schemaJson, kept compact',
        EXIT_VALIDATION,
      );
    }
    args.push(profile.schema_flag, input.schemaJson);
  }

  /** @type {string|null} */
  let stdin = null;
  if (profile.prompt === 'stdin-dash') {
    args.push('-');
    stdin = prompt;
  } else if (profile.prompt === 'stdin') {
    stdin = prompt;
  } else if (profile.prompt.startsWith('flag:')) {
    args.push(profile.prompt.slice('flag:'.length), prompt);
  } else {
    args.push(prompt);
  }

  // Command length is measured on the argv the parent will hand the OS. On Windows the cmd.exe shim
  // layer adds escaping on top, so this is a floor, not the exact figure — which is why the check
  // lives in the invoker (where the resolved binary is known) and the measurement lives here.
  const commandLength = [profile.bin, ...args].reduce((n, a) => n + String(a).length + 3, 0);

  return {
    bin: profile.bin,
    args,
    stdin,
    parser: profile.parser,
    containment,
    model,
    effort,
    family: resolveFamily(name, spec),
    schema: profile.schema,
    resumed: Boolean(input.resumeSession),
    enforcement: profile.enforcement ?? null,
    enforcement_gaps: containment === 'bounded-edit' ? enforcementGaps(name, spec) : [],
    commandLength,
  };
}

/**
 * A human-readable containment note for a report — the honest version, per executor.
 *
 * @param {string} name
 * @param {object} spec
 * @param {string} role
 * @returns {string}
 */
export function containmentNote(name, spec, role) {
  const containment = ROLE_CONTAINMENT[role];
  if (name === 'codex' && containment === 'read-only') {
    return 'codex has no plan-mode flag; containment is an ENFORCED read-only sandbox plus a '
      + 'planning-only role prompt and a strict output schema';
  }
  if (name === 'gemini') {
    return containment === 'read-only'
      ? 'gemini --approval-mode plan (read-only); no schema flag exists, so the result is validated '
        + 'locally with one read-only repair turn'
      : 'gemini --approval-mode auto_edit (edits auto-approved, no wider bypass)';
  }
  const profile = profileFor(name, spec);
  const args = containment === 'read-only' ? profile.read_only_args : profile.edit_args;
  const base = `${profile.bin} ${args.join(' ')}`;
  if (containment !== 'bounded-edit' || !profile.enforcement) return base;
  const gaps = enforcementGaps(name, spec);
  return `${base} + ${profile.enforcement.mechanism} (${profile.enforcement.note})`
    + `${gaps.length ? `; NOT covered by the CLI itself: ${gaps.join(', ')} — which is why this executor holds no implement role` : ''}`;
}
