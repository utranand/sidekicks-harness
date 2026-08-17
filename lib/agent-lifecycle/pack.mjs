// lib/agent-lifecycle/pack.mjs
// `sidekicks agent pack <list|show|install|status> [<pack-id>] [--dry-run] [--json]`
//
// Agent packs are OPTIONAL. They ship inside a framework release and are never installed for a user
// without them asking — `core init` and `core update` write no agent, ever. This verb is the whole
// opt-in surface: discover what the installation carries, inspect one, and install it.
//
// Three refusals are the point of the install path, and none of them has a --force:
//   1. A missing REQUIRED skill stops the run BEFORE any write, printing the exact commands that
//      fix it. Half a delivery team is worse than none: the agents would still act, and would
//      improvise the planning steps they were supposed to run.
//   2. An existing agent that did not come from this pack is never overwritten. It is somebody
//      else's work; the pack never owned that name.
//   3. An agent the user edited after installing is never rewritten.
// Nothing here reaches the network, and no skill is ever downloaded.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import {
  parseMemoryFlags,
  bangkokTimestamp,
  writeCharter,
  writeControlStage,
  ensureRuntimeTree,
  agentDir,
  agentMemoryDir,
  toRepoRel,
} from './_shared.mjs';
import {
  discoverPacks,
  requirePack,
  packStatus,
  agentInstallState,
  dependencyStatuses,
  remediationCommands,
  charterChecksum,
  PACK_SOURCE,
} from './_pack.mjs';

const SUBS = ['list', 'show', 'install', 'status'];

/**
 * Run `agent pack`.
 *
 * The dispatcher hands `name` = the subcommand and `rest[0]` = the pack id, the same shape
 * `agent daemon <sub> <agent>` uses.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string, rest?: string[] }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const sub = args.name;
  const packId = (args.rest || [])[0];
  const flags = parseMemoryFlags(ctx.argv, ['json', 'dry-run']);

  if (!sub || !SUBS.includes(sub)) {
    throw new SidekicksError(
      `agent pack: expected one of ${SUBS.join(', ')} — e.g. 'sidekicks agent pack list'`,
      EXIT_VALIDATION
    );
  }

  if (sub === 'list') return cmdList(repoRoot, flags);
  if (sub === 'show') return cmdShow(repoRoot, requireId(sub, packId), flags);
  if (sub === 'status') return cmdStatus(repoRoot, packId, flags);
  return cmdInstall(repoRoot, requireId(sub, packId), flags);
}

function requireId(sub, packId) {
  if (!packId) {
    throw new SidekicksError(
      `agent pack ${sub}: a <pack-id> is required — run 'sidekicks agent pack list' to see them`,
      EXIT_VALIDATION
    );
  }
  return packId;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function cmdList(repoRoot, flags) {
  const packs = discoverPacks(repoRoot).map((p) => packStatus(repoRoot, p));

  if (flags.json) {
    return { stdout: JSON.stringify({ packs }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  if (!packs.length) {
    return {
      stdout: 'agent pack list: no agent packs available\n'
        + '  Packs ship inside a framework core. Check the mount with `sidekicks core status`.\n',
      exitCode: EXIT_OK,
    };
  }

  const width = Math.max(...packs.map((p) => p.id.length));
  const out = [];
  for (const p of packs) {
    const version = p.version ? `v${p.version}` : '(unreadable)';
    const label = p.display_name || '';
    out.push(`${p.id.padEnd(width)}  ${version.padEnd(9)}  ${p.state.padEnd(13)}  ${p.agents.length} agent(s)  ${label}`.trimEnd());
  }
  out.push('');
  out.push(`${packs.length} pack(s) — none is installed until you run 'sidekicks agent pack install <id>'`);
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

function cmdShow(repoRoot, packId, flags) {
  const pack = requirePack(repoRoot, packId);
  const status = packStatus(repoRoot, pack);

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        ...status,
        summary: pack.manifest ? pack.manifest.summary : '',
        skills_repo: pack.manifest ? pack.manifest.skills_repo : '',
        source: toRepoRel(repoRoot, pack.dir),
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const out = [];
  out.push(`${pack.id}${status.version ? ` v${status.version}` : ''} — ${status.display_name || '(no display name)'}`);
  if (pack.manifest && pack.manifest.summary) out.push(`  ${pack.manifest.summary}`);
  out.push(`  source: ${toRepoRel(repoRoot, pack.dir)} (${pack.origin})`);
  out.push(`  state:  ${status.state}`);

  if (!pack.valid) {
    out.push('');
    out.push('Problems:');
    for (const e of status.errors) out.push(`  - ${e}`);
    return { stdout: out.join('\n') + '\n', exitCode: EXIT_VALIDATION };
  }

  out.push('');
  out.push('Agents:');
  for (const a of status.agents) out.push(`  ${a.name.padEnd(12)}  ${a.state.padEnd(11)}  ${a.detail}`);

  out.push('');
  out.push('Required skills:');
  if (!status.dependencies.length) out.push('  (none)');
  for (const d of status.dependencies) {
    const req = d.required ? 'required' : 'optional';
    out.push(`  ${d.name.padEnd(34)}  ${d.status.padEnd(20)}  ${req}`);
    if (!d.required && d.degraded) out.push(`    without it: ${d.degraded}`);
  }

  const missing = status.dependencies.filter((d) => d.status === 'missing-installable').map((d) => d.name);
  if (missing.length) {
    out.push('');
    out.push('To make the missing skills available:');
    for (const c of remediationCommands(pack.manifest, missing)) out.push(`  ${c}`);
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Exit code carries the verdict so a sequence step can gate on it:
 * 0 = ready, 2 = anything else (not-installed, degraded, invalid).
 */
function cmdStatus(repoRoot, packId, flags) {
  const packs = packId ? [requirePack(repoRoot, packId)] : discoverPacks(repoRoot);
  const rows = packs.map((p) => packStatus(repoRoot, p));

  if (flags.json) {
    return {
      stdout: JSON.stringify(packId ? rows[0] : { packs: rows }, null, 2) + '\n',
      exitCode: rows.every((r) => r.state === 'ready') && rows.length ? EXIT_OK : EXIT_VALIDATION,
    };
  }

  if (!rows.length) {
    return { stdout: 'agent pack status: no agent packs available\n', exitCode: EXIT_VALIDATION };
  }

  const out = [];
  for (const r of rows) {
    out.push(`${r.id}${r.version ? ` v${r.version}` : ''}: ${r.state}`);
    for (const a of r.agents) out.push(`  agent ${a.name.padEnd(12)} ${a.state.padEnd(11)} ${a.detail}`);
    for (const d of r.dependencies) {
      out.push(`  skill ${d.name.padEnd(34)} ${d.status}${d.required ? '' : ' (optional)'}`);
    }
    for (const e of r.errors) out.push(`  problem: ${e}`);
  }
  const allReady = rows.every((r) => r.state === 'ready');
  return { stdout: out.join('\n') + '\n', exitCode: allReady ? EXIT_OK : EXIT_VALIDATION };
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

function cmdInstall(repoRoot, packId, flags) {
  const pack = requirePack(repoRoot, packId);

  // 1. The pack itself must be sound. Nothing is written for a pack we cannot fully read — a
  //    partial install would leave a crew whose missing member is invisible.
  if (!pack.valid) {
    const lines = ['agent pack install: the pack does not validate — nothing was written', ''];
    for (const e of pack.errors) lines.push(`  - ${e}`);
    return { stdout: lines.join('\n') + '\n', exitCode: EXIT_VALIDATION };
  }

  // 2. Dependencies, BEFORE any write. A missing required skill stops the run.
  const deps = dependencyStatuses(repoRoot, pack.manifest);
  const missingRequired = deps.filter((d) => d.required && d.status !== 'available');
  if (missingRequired.length) {
    const installable = missingRequired.filter((d) => d.status === 'missing-installable').map((d) => d.name);
    const unavailable = missingRequired.filter((d) => d.status === 'unavailable').map((d) => d.name);
    const lines = [];
    lines.push(`agent pack install: pack '${pack.id}' requires ${missingRequired.length} skill(s) this installation does not carry — nothing was written`);
    lines.push('');
    for (const d of missingRequired) lines.push(`  missing: ${d.name} (${d.status})`);
    if (installable.length) {
      lines.push('');
      lines.push('Install them, then re-run this command:');
      for (const c of remediationCommands(pack.manifest, installable)) lines.push(`  ${c}`);
      lines.push(`  sidekicks agent pack install ${pack.id}`);
    }
    if (unavailable.length) {
      lines.push('');
      lines.push(`These are not published anywhere this pack knows about: ${unavailable.join(', ')}`);
    }
    return { stdout: lines.join('\n') + '\n', exitCode: EXIT_VALIDATION };
  }

  // 3. Decide per agent. Every state is decided before the first write, so a refusal late in the
  //    list cannot leave the pack half-applied by surprise — the plan is printed either way.
  const plan = pack.agents.map((entry) => {
    const state = agentPlanState(repoRoot, pack, entry);
    return { entry, ...state };
  });

  const missingOptional = deps.filter((d) => !d.required && d.status !== 'available');

  if (flags['dry-run']) {
    return renderInstall(repoRoot, pack, plan, missingOptional, { applied: false, flags });
  }

  for (const step of plan) {
    if (step.action !== 'write') continue;
    installAgent(repoRoot, pack, step.entry);
  }
  return renderInstall(repoRoot, pack, plan, missingOptional, { applied: true, flags });
}

/**
 * What install would do to one agent, and why.
 *
 * @returns {{action: 'write'|'skip', state: string, detail: string}}
 */
function agentPlanState(repoRoot, pack, entry) {
  const status = agentInstallState(repoRoot, pack, entry);
  if (status.state === 'absent') return { action: 'write', state: 'absent', detail: 'will be created' };
  if (status.state === 'installed') return { action: 'skip', state: 'up-to-date', detail: status.detail };
  return { action: 'skip', state: status.state, detail: status.detail };
}

/**
 * Write one pack agent through the ordinary agent-creation path.
 *
 * Everything here goes through `writeCharter` — poison guard, round-trip check, the `assertWritable`
 * surface gate and an atomic write — so a pack install is exactly as mediated as `agent create`.
 * The memory store, the routines stub and the runtime tree are seeded the same way, and each is
 * absent-guarded so a repeat run touches nothing.
 */
function installAgent(repoRoot, pack, entry) {
  const charter = {
    ...entry.charter,
    pack: {
      id: pack.id,
      version: pack.manifest.version,
      source: PACK_SOURCE,
      installed_at: bangkokTimestamp(),
      checksum: charterChecksum(entry.charter),
    },
  };
  writeCharter(repoRoot, entry.name, charter, 'agent pack install');

  // Memory namespace inside the CENTRAL store — one index for the whole store, so
  // there is no per-agent MEMORY.md to seed (see agent create).
  mkdirp(agentMemoryDir(repoRoot, entry.name));

  // A pack may ship routines; otherwise seed the same empty v1 document `agent create` writes.
  const routinesPath = join(agentDir(repoRoot, entry.name), 'routines', 'routines.yaml');
  if (!existsSync(routinesPath)) {
    const packRoutines = join(entry.dir, 'routines', 'routines.yaml');
    assertWritable(routinesPath, repoRoot);
    writeAtomic(
      routinesPath,
      existsSync(packRoutines)
        ? readFileSync(packRoutines, 'utf8')
        : 'schema: agent-routines/v1\nroutines: []\n'
    );
  }

  ensureRuntimeTree(repoRoot, entry.name);
  writeControlStage(repoRoot, entry.name, 'running');
}

function renderInstall(repoRoot, pack, plan, missingOptional, { applied, flags }) {
  const written = plan.filter((s) => s.action === 'write');
  const conflicts = plan.filter((s) => s.state === 'conflict');
  const customized = plan.filter((s) => s.state === 'customized');
  const upToDate = plan.filter((s) => s.state === 'up-to-date');
  const degraded = missingOptional.length > 0;

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        pack: pack.id,
        version: pack.manifest.version,
        applied,
        degraded,
        agents: plan.map((s) => ({ name: s.entry.name, action: s.action, state: s.state, detail: s.detail })),
        missing_optional_skills: missingOptional.map((d) => ({ name: d.name, degraded: d.degraded })),
      }, null, 2) + '\n',
      exitCode: conflicts.length ? EXIT_VALIDATION : EXIT_OK,
    };
  }

  const out = [];
  const verb = applied ? 'installed' : 'would install';
  out.push(`agent pack install ${pack.id} v${pack.manifest.version}${applied ? '' : ' (dry run — nothing written)'}`);
  out.push('');
  for (const s of plan) {
    const mark = s.action === 'write' ? (applied ? 'created ' : 'to create') : `skipped  `;
    out.push(`  ${mark}  ${s.entry.name.padEnd(12)}  ${s.detail}`);
  }
  out.push('');
  out.push(`${written.length} ${verb}, ${upToDate.length} already up-to-date, ${customized.length} customized (left alone), ${conflicts.length} conflict(s)`);

  if (conflicts.length) {
    out.push('');
    out.push('A conflicting agent is never overwritten. Rename or retire it first, then re-run:');
    for (const s of conflicts) out.push(`  sidekicks agent show ${s.entry.name}`);
  }
  if (degraded) {
    out.push('');
    out.push('DEGRADED — an optional skill this pack declares is not installed:');
    for (const d of missingOptional) out.push(`  ${d.name}: ${d.degraded}`);
    const installable = missingOptional.filter((d) => d.status === 'missing-installable').map((d) => d.name);
    if (installable.length) {
      out.push('');
      for (const c of remediationCommands(pack.manifest, installable)) out.push(`  ${c}`);
    }
  }
  if (applied && written.length) {
    out.push('');
    out.push(`Bring one online with: sidekicks agent start ${written[0].entry.name}`);
    out.push(`Check the pack any time with: sidekicks agent pack status ${pack.id}`);
  }
  return { stdout: out.join('\n') + '\n', exitCode: conflicts.length ? EXIT_VALIDATION : EXIT_OK };
}
