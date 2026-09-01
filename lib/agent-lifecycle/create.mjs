// lib/agent-lifecycle/create.mjs
// `sidekicks agent create <name> --specialty <s> --categories <a,b>
//    [--cli claude|codex|gemini|antigravity] [--role orchestrator|worker] [--model <tier|id>]
//    [--persona <s>] [--mission <s>] [--goals "a;b"] [--expertise "a;b"]
//    [--principles "a;b"] [--routines "a;b"] [--output-contract <s>]
//    [--work-dir <path>] [--force]`
//
// Scaffolds a named persistent agent under .sidekicks/agents/<name>/:
// committed charter (agent.yaml, block-style yaml-subset), committed memory
// store (MEMORY.md index), phase-2 routines stub, and the git-ignored runtime
// mailbox tree. Prints the bootstrap prompt the user pastes into a fresh
// terminal tab to bring the agent online.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
// The one containment gate for persisted caller paths — same import route `_routines.mjs` uses.
import { toPortablePath } from './send.mjs';
import {
  parseMemoryFlags,
  bangkokTimestamp,
  validateAgentName,
  charterPath,
  agentDir,
  agentMemoryDir,
  writeCharter,
  writeControlStage,
  ensureRuntimeTree,
  splitList,
  splitSemi,
  toRepoRel,
  assertModelId,
  AGENT_CLIS,
} from './_shared.mjs';

const ROLES = ['orchestrator', 'worker'];

/**
 * Run `agent create`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = validateAgentName(args.name);
  const flags = parseMemoryFlags(ctx.argv, ['force']);

  const specialty = flags.specialty != null ? String(flags.specialty).trim() : '';
  if (!specialty) {
    throw new SidekicksError(
      'agent create: --specialty is required (one line describing what this agent is for)',
      EXIT_VALIDATION
    );
  }

  const categories = splitList(flags.categories);
  if (categories.length === 0) {
    throw new SidekicksError(
      'agent create: --categories is required (comma-separated task kinds this agent may claim, e.g. --categories frontend,ui-review)',
      EXIT_VALIDATION
    );
  }

  const cli = flags.cli ? String(flags.cli) : 'claude';
  if (!AGENT_CLIS.includes(cli)) {
    throw new SidekicksError(
      `agent create: invalid --cli '${cli}' — one of: ${AGENT_CLIS.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const role = flags.role ? String(flags.role) : 'worker';
  if (!ROLES.includes(role)) {
    throw new SidekicksError(
      `agent create: invalid --role '${role}' — one of: ${ROLES.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  // A tier keyword (top/high/mid/low) or an explicit model id are both valid, and `agent start`
  // is what RESOLVES a tier against the charter's cli. But the SHAPE is checked here, at
  // authoring time: the charter is a launch input, and a value carrying shell syntax must never
  // be persisted for a later `agent start` to interpolate.
  // Empty/absent means "no --model flag" (the CLI default).
  const model = assertModelId(
    flags.model != null ? String(flags.model).trim() : '',
    (message) => { throw new SidekicksError(`agent create: invalid --${message}`, EXIT_VALIDATION); }
  );

  // Identity/behavior fields — all optional, permissive, no validation.
  // Old charters missing these keys read back as '' / [] (backward compatible).
  const persona = flags.persona != null ? String(flags.persona).trim() : '';
  const mission = flags.mission != null ? String(flags.mission).trim() : '';
  const goals = splitSemi(flags.goals);
  const expertise = splitSemi(flags.expertise);
  const principles = splitSemi(flags.principles);
  const behaviorRoutines = splitSemi(flags.routines);
  const outputContract = flags['output-contract'] != null ? String(flags['output-contract']).trim() : '';
  // Memory scenario categories this agent works within. COMMA-split like --categories,
  // not semicolon-split like the prose lists: these are identifiers, not sentences, and
  // a category name never contains a comma.
  const attach = splitList(flags.attach);

  const exists = existsSync(charterPath(repoRoot, name));
  if (exists && !flags.force) {
    throw new SidekicksError(
      `agent create: agent '${name}' already exists — pass --force to rewrite its charter`,
      EXIT_VALIDATION
    );
  }

  const charter = {
    schema: 'agent-charter/v1',
    name,
    specialty,
    categories,
    cli,
    role,
    model,
    persona,
    mission,
    goals,
    expertise,
    principles,
    // Repurposes the former "phase-2 placeholder (parsed, unused)" slot — this
    // now holds prose behavioral habits from --routines (e.g. "restate scope
    // first"), NOT the scheduled-automation routines/routines.yaml stub file
    // written below (a distinct, still-unused future feature).
    routines: behaviorRoutines,
    output_contract: outputContract,
    status: 'active',
    created_at: bangkokTimestamp(),
    // Gated at write time, exactly like `agent send --work-dir`: this value is persisted into
    // a committed charter and later copied into a task's `work_dir`, which the standby contract
    // tells the recipient to work in. Storing it verbatim meant a traversing path was refused on
    // the flag and accepted on the charter — the same field, the same sink.
    default_work_dir: flags['work-dir']
      ? toPortablePath(repoRoot, String(flags['work-dir']), '--work-dir', 'agent create')
      : '',
    improvement: { enabled: false },
    // Private learned skills are explicitly opt-in. Older charters omit this block and
    // therefore resolve to the same disabled state.
    skill_learning: { enabled: false },
  };
  // Omitted entirely when empty: an absent block reads as "attaches nothing", which is
  // the same thing an empty list means, and keeps a charter without --attach byte-identical
  // to the pre-attach shape.
  if (attach.length) charter.memory = { attach };
  writeCharter(repoRoot, name, charter, 'agent create');

  // Committed memory namespace inside the CENTRAL store. No per-agent MEMORY.md any
  // more — the one central index covers every namespace, so seeding a second index
  // here would just be a file that goes stale the moment anything else writes.
  mkdirp(agentMemoryDir(repoRoot, name));

  // Scheduled-routine store — managed by `sidekicks agent routine` and fired by
  // the `sidekicks agent scheduler` daemon. A DISTINCT feature from the
  // charter's own `routines` key (prose behavioral habits, --routines above);
  // left untouched by that repurposing. Seeded empty so a fresh agent carries a
  // valid, committed v1 document from day one.
  const routinesPath = join(agentDir(repoRoot, name), 'routines', 'routines.yaml');
  if (!existsSync(routinesPath)) {
    assertWritable(routinesPath, repoRoot);
    writeAtomic(routinesPath, 'schema: agent-routines/v1\nroutines: []\n');
  }

  // Git-ignored runtime mailbox + control gate.
  ensureRuntimeTree(repoRoot, name);
  writeControlStage(repoRoot, name, 'running');

  const dirRel = toRepoRel(repoRoot, agentDir(repoRoot, name));
  const verb = exists ? 'rewrote' : 'created';
  const bootstrap = role === 'orchestrator'
    ? [
        `${verb} agent '${name}' at ${dirRel}/`,
        '',
        'Bootstrap prompt — paste into a FRESH terminal tab running your agent CLI:',
        '',
        `  You are agent '${name}'. Load your identity with 'sidekicks agent show ${name}' and`,
        `  your memory with 'sidekicks memory list --agent ${name}', then act as the`,
        '  user-facing orchestrator: for each assignment I give you, use the',
        '  sk-agent-master skill to route it — to the specialist agent whose charter',
        '  categories cover the work, or to a session subagent you spawn when no charter',
        '  covers it. You dispatch to other agents and subagents — you never do domain',
        '  work yourself.',
        '',
        `Stop it any time from another terminal with: sidekicks agent stop ${name}`,
        '',
      ].join('\n')
    : [
        `${verb} agent '${name}' at ${dirRel}/`,
        '',
        'Bootstrap prompt — paste into a FRESH terminal tab running your agent CLI:',
        '',
        `  Run the sk-agent-standby skill for agent "${name}".`,
        '',
        `The session enters standby (blocking 'sidekicks agent wait ${name}'), claims tasks`,
        `in categories [${categories.join(', ')}], executes, replies, and returns to standby.`,
        `Stop it any time from another terminal with: sidekicks agent stop ${name}`,
        '',
      ].join('\n');

  return { stdout: bootstrap, exitCode: EXIT_OK };
}
