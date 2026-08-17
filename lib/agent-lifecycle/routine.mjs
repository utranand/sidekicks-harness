// lib/agent-lifecycle/routine.mjs
// `sidekicks agent routine <add|list|remove|enable|disable|run> <agent> [<id>] [flags]`
//
// CRUD for an agent's scheduled routines — the committed half of the scheduler
// (.sidekicks/agents/<name>/routines/routines.yaml). This verb is the ONLY
// writer of that file: the daemon writes exclusively to the git-ignored runtime
// state, so a schedule change is always a deliberate human act that shows up in
// git.
//
// Sub-verb shape follows `agent bridge` (bridge.mjs:26,58-66): the ACTION is
// args.name and everything else rides in args.rest.

import { SidekicksError, EXIT_OK, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  parseMemoryFlags,
  requireCharter,
  readCharter,
  readPresence,
  presenceState,
  validateAgentName,
} from './_shared.mjs';
import { isDaemonRunning } from './_bridge.mjs';
import {
  ROUTINE_BOOLEANS,
  ROUTINE_KEYS,
  SCHEDULER_AGENT,
  readRoutinesFile,
  writeRoutinesFile,
  partitionRoutines,
  readState,
  writeState,
  markManualRun,
  validateRoutine,
  routineDue,
  nextScheduledInstant,
  bangkokWall,
  graceMinutes,
  buildRoutinePayload,
  routinesPath,
  fireRoutine,
  isTelegramDeliver,
} from './_routines.mjs';

const ACTIONS = ['add', 'list', 'remove', 'enable', 'disable', 'run'];

/**
 * The dispatcher's non-strict parseArgs leaks a space-form flag VALUE
 * (`--at 09:30`) into the positional list, so args.rest would carry '09:30' as
 * if it were the agent name. Re-derive the true positionals from raw argv with
 * the same consumption rule parseMemoryFlags applies.
 */
function cleanPositionals(argv, booleans) {
  const boolSet = new Set([...booleans, 'verbose', 'help', 'version']);
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      if (!body.includes('=') && !boolSet.has(body)) {
        const next = list[i + 1];
        if (next !== undefined && !next.startsWith('--')) i++; // the flag's value token
      }
      continue;
    }
    out.push(tok);
  }
  return out;
}

/** Human "in 2h 15m" from a millisecond delta. */
function humanIn(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const past = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  const bits = [];
  if (d) bits.push(`${d}d`);
  if (h) bits.push(`${h}h`);
  if (!d && m) bits.push(`${m}m`);
  if (!bits.length) bits.push('<1m');
  return past ? `${bits.join(' ')} ago` : `in ${bits.join(' ')}`;
}

/** One-line schedule summary, e.g. `weekly mon,wed,fri 09:30`. */
export function describeSchedule(r) {
  const when = String(r.when || '');
  if (when === 'weekly') return `weekly ${r.days} ${r.at}`;
  if (when === 'once') return `once ${r.at}`;
  if (when === 'cron') return `cron "${r.at}"`;
  if (when === 'every') return `every ${r.at}`;
  return `daily ${r.at}`;
}

function payloadKind(r) {
  return r.sequence ? 'sequence' : 'goal';
}

// ---------------------------------------------------------------------------

export async function run(ctx, args) {
  const flags = parseMemoryFlags(ctx.argv, ROUTINE_BOOLEANS);
  const action = args.name ? String(args.name) : '';
  if (!ACTIONS.includes(action)) {
    throw new SidekicksError(
      `agent routine: an action is required — one of: ${ACTIONS.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const { repoRoot } = ctx;
  // positionals: ['agent','routine',<action>,<agent>,<id>?]
  const positionals = cleanPositionals(ctx.argv, ROUTINE_BOOLEANS).slice(3);
  const agent = positionals[0] ? String(positionals[0]) : '';
  const id = positionals[1] ? String(positionals[1]) : '';

  if (!agent) {
    throw new SidekicksError(
      `agent routine ${action}: an agent name is required — 'sidekicks agent routine ${action} <agent>'`,
      EXIT_VALIDATION
    );
  }
  validateAgentName(agent);

  switch (action) {
    case 'add': return addRoutine(repoRoot, agent, flags);
    case 'list': return listRoutines(repoRoot, agent, flags);
    case 'remove': return removeRoutine(repoRoot, agent, id, flags);
    case 'enable': return setEnabled(repoRoot, agent, id, true);
    case 'disable': return setEnabled(repoRoot, agent, id, false);
    case 'run': return runNow(repoRoot, agent, id, flags);
    default: /* unreachable */ return { stdout: '', exitCode: EXIT_OK };
  }
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

function addRoutine(repoRoot, agent, flags) {
  const verb = 'agent routine add';
  const doc = readRoutinesFile(repoRoot, agent);
  const { bad } = partitionRoutines(doc);
  if (bad.length > 0) {
    throw new SidekicksError(
      `${verb}: ${routinesPath(repoRoot, agent)} contains a hand-nested entry ('${bad[0].id}' at key '${bad[0].key}') — flatten it to scalars before adding more, or this rewrite would destroy it`,
      EXIT_VALIDATION
    );
  }

  const warnings = [];
  const { entry } = validateRoutine(
    repoRoot,
    agent,
    {
      id: flags.id,
      when: flags.when,
      at: flags.at,
      cron: flags.cron,
      every: flags.every,
      days: flags.days,
      category: flags.category,
      goal: flags.goal,
      sequence: flags.sequence,
      work_dir: flags['work-dir'],
      acceptance: flags.acceptance,
      priority: flags.priority,
      grace: flags.grace,
      deliver: flags.deliver,
      note: flags.note,
      enabled: flags.disabled ? false : true,
    },
    doc.routines.map((r) => String(r.id)),
    verb,
    warnings
  );

  // A one-shot whose instant has already passed: warn inside grace, refuse past
  // it (that instant can never fire) unless --force records it deliberately.
  const nowMs = Date.now();
  if (entry.when === 'once') {
    const verdict = routineDue(entry, null, nowMs);
    if (verdict.action === 'miss' && !flags.force) {
      throw new SidekicksError(
        `${verb}: --at ${entry.at} is ${humanIn(-verdict.lateMs)} and past its ${entry.grace_minutes}m grace — that instant can never fire; pick a future time or pass --force to record it anyway`,
        EXIT_VALIDATION
      );
    }
    if (verdict.action === 'fire') {
      warnings.push(`--at ${entry.at} has already passed but is inside grace — this will fire on the next scheduler tick`);
    }
  }

  // --dry-run: full validation + a real next-fires preview, ZERO writes — the
  // rehearsal that lets a cron expression be checked before it is committed.
  if (flags['dry-run']) {
    const preview = [];
    let cursor = nowMs;
    for (let i = 0; i < 3; i++) {
      const t = nextScheduledInstant(entry, cursor);
      if (t == null) break;
      preview.push(`  ${i + 1}. ${bangkokWall(t)} (+07:00) — ${humanIn(t - nowMs)}`);
      cursor = t;
    }
    const lines = [
      `[dry-run] routine '${entry.id}' for ${agent} validates — nothing written`,
      `  schedule: ${describeSchedule(entry)}  (Asia/Bangkok +07:00)`,
      `  payload:  ${payloadKind(entry) === 'sequence' ? `sequence ${entry.sequence}` : `goal "${entry.goal}"`}`,
      `  category: ${entry.category}   grace: ${entry.grace_minutes}m${entry.deliver ? `   deliver: ${entry.deliver}` : ''}`,
      preview.length ? '  next fires:' : '  next fires: (none)',
      ...preview,
    ];
    for (const w of warnings) lines.push(`  warning: ${w}`);
    return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
  }

  const routines = [...doc.routines, entry];
  const written = writeRoutinesFile(repoRoot, agent, { routines }, verb);

  const next = nextScheduledInstant(entry, nowMs);
  const lines = [
    `added routine '${entry.id}' to ${agent}`,
    `  schedule: ${describeSchedule(entry)}  (Asia/Bangkok +07:00)`,
    `  payload:  ${payloadKind(entry) === 'sequence' ? `sequence ${entry.sequence}` : `goal "${entry.goal}"`}`,
    `  category: ${entry.category}   grace: ${entry.grace_minutes}m${entry.deliver ? `   deliver: ${entry.deliver}` : ''}${entry.enabled ? '' : '   [disabled]'}`,
    next != null
      ? `  next fire: ${bangkokWall(next)} (+07:00) — ${humanIn(next - nowMs)}`
      : `  next fire: (none — the one-shot instant has passed)`,
    `  file: ${written.replace(repoRoot, '').replace(/^[/\\]/, '')}`,
  ];

  if (readCharter(repoRoot, SCHEDULER_AGENT) == null) {
    lines.push(`  note: the '${SCHEDULER_AGENT}' sender charter is created on the first 'agent scheduler serve'`);
  }
  if (!isDaemonRunning(repoRoot, 'scheduler')) {
    lines.push(`  note: the scheduler is not running — start it with 'sidekicks agent scheduler serve' (nothing fires until then)`);
  }
  if (isTelegramDeliver(entry.deliver) && !isDaemonRunning(repoRoot, 'telegram')) {
    lines.push(`  note: the telegram relay is not running — results wait in the relay inbox until 'sidekicks agent telegram serve'`);
  }
  for (const w of warnings) lines.push(`  warning: ${w}`);

  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function listRoutines(repoRoot, agent, flags) {
  requireCharter(repoRoot, agent);
  const doc = readRoutinesFile(repoRoot, agent);
  const state = readState(repoRoot, agent);
  const nowMs = Date.now();
  const { ok, bad } = partitionRoutines(doc);

  const rows = ok.map((r) => {
    const st = state.routines[String(r.id)] || null;
    const next = nextScheduledInstant(r, nowMs);
    const verdict = routineDue(r, st, nowMs);
    return {
      id: String(r.id),
      enabled: r.enabled !== false,
      when: String(r.when || ''),
      at: String(r.at || ''),
      days: String(r.days || ''),
      schedule: describeSchedule(r),
      category: String(r.category || ''),
      payload: payloadKind(r),
      sequence: String(r.sequence || ''),
      goal: String(r.goal || ''),
      grace_minutes: graceMinutes(r),
      deliver: String(r.deliver || ''),
      next_fire: next != null ? bangkokWall(next) : null,
      due_now: verdict.action,
      last_status: st?.last_status ?? null,
      last_fired_at: st?.last_fired_at ?? null,
      last_instant_wall: st?.last_instant_wall ?? null,
      last_error: st?.last_error || '',
      fire_count: st?.fire_count ?? 0,
      miss_count: st?.miss_count ?? 0,
      retired_at: st?.retired_at ?? null,
    };
  });

  if (flags.json) {
    return {
      stdout: `${JSON.stringify({ agent, scheduler_running: isDaemonRunning(repoRoot, 'scheduler'), routines: rows, unreadable: bad }, null, 2)}\n`,
      exitCode: EXIT_OK,
    };
  }

  if (rows.length === 0 && bad.length === 0) {
    return {
      stdout: `no routines for '${agent}'\n  add one: sidekicks agent routine add ${agent} --id=<slug> --when=daily --at=09:30 --category=<c> --goal="..."\n`,
      exitCode: EXIT_OK,
    };
  }

  const lines = [`Routines — ${agent} (${routinesPath(repoRoot, agent).replace(repoRoot, '').replace(/^[/\\]/, '')})`, ''];
  for (const r of rows) {
    const marks = [];
    if (!r.enabled) marks.push('disabled');
    if (r.retired_at) marks.push('spent');
    if (r.last_status === 'error') marks.push('ERROR');
    lines.push(`  ${r.id}${marks.length ? ` [${marks.join(', ')}]` : ''}`);
    lines.push(`      ${r.schedule}  ·  ${r.category}  ·  grace ${r.grace_minutes}m${r.deliver ? `  ·  deliver → ${r.deliver}` : ''}`);
    if (isTelegramDeliver(r.deliver) && !isDaemonRunning(repoRoot, 'telegram')) {
      lines.push(`      note: the telegram relay is not running — the result waits in the relay inbox until 'sidekicks agent telegram serve'`);
    }
    lines.push(`      ${r.payload === 'sequence' ? `sequence: ${r.sequence}` : `goal: ${r.goal}`}`);
    if (r.retired_at) {
      lines.push(`      spent — fired ${r.last_fired_at || r.last_instant_wall}; remove it with 'sidekicks agent routine remove ${agent} ${r.id}'`);
    } else if (r.next_fire) {
      const nextMs = nextScheduledInstant(ok.find((x) => String(x.id) === r.id), nowMs);
      lines.push(`      next fire: ${r.next_fire} (+07:00) — ${humanIn(nextMs - nowMs)}`);
    }
    if (r.last_status) {
      const detail = r.last_status === 'error' ? ` — ${r.last_error}` : '';
      lines.push(`      last: ${r.last_status} ${r.last_instant_wall || ''}${detail}  (fired ${r.fire_count}, missed ${r.miss_count})`);
    }
    lines.push('');
  }
  if (bad.length > 0) {
    lines.push(`  ⚠ ${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} cannot be managed by the CLI (hand-nested values):`);
    for (const b of bad) lines.push(`      ${b.id} — nested value at '${b.key}'; flatten it to a scalar`);
    lines.push('');
  }
  if (!isDaemonRunning(repoRoot, 'scheduler')) {
    lines.push(`  note: the scheduler is not running — nothing fires until 'sidekicks agent scheduler serve'`);
  }
  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------
// remove / enable / disable
// ---------------------------------------------------------------------------

function requireId(action, agent, id) {
  if (!id) {
    throw new SidekicksError(
      `agent routine ${action}: a routine id is required — 'sidekicks agent routine ${action} ${agent} <id>' (see 'sidekicks agent routine list ${agent}')`,
      EXIT_VALIDATION
    );
  }
  return id;
}

function removeRoutine(repoRoot, agent, id, flags) {
  const verb = 'agent routine remove';
  requireCharter(repoRoot, agent);
  requireId('remove', agent, id);
  const doc = readRoutinesFile(repoRoot, agent);
  const keep = doc.routines.filter((r) => String(r.id) !== id);
  if (keep.length === doc.routines.length) {
    throw new SidekicksError(
      `${verb}: no routine '${id}' for '${agent}' — see 'sidekicks agent routine list ${agent}'`,
      EXIT_VALIDATION
    );
  }
  writeRoutinesFile(repoRoot, agent, { routines: keep }, verb);
  // Drop its runtime state too, so a later routine reusing the id starts clean
  // rather than inheriting a stale marker (which would suppress its first fire).
  const state = readState(repoRoot, agent);
  if (state.routines[id]) {
    delete state.routines[id];
    writeState(repoRoot, agent, state);
  }
  return { stdout: `removed routine '${id}' from ${agent}\n`, exitCode: EXIT_OK };
}

function setEnabled(repoRoot, agent, id, enabled) {
  const verb = `agent routine ${enabled ? 'enable' : 'disable'}`;
  requireCharter(repoRoot, agent);
  requireId(enabled ? 'enable' : 'disable', agent, id);
  const doc = readRoutinesFile(repoRoot, agent);
  const target = doc.routines.find((r) => String(r.id) === id);
  if (!target) {
    throw new SidekicksError(
      `${verb}: no routine '${id}' for '${agent}' — see 'sidekicks agent routine list ${agent}'`,
      EXIT_VALIDATION
    );
  }
  if ((target.enabled !== false) === enabled) {
    return { stdout: `routine '${id}' is already ${enabled ? 'enabled' : 'disabled'}\n`, exitCode: EXIT_OK };
  }
  const routines = doc.routines.map((r) => {
    if (String(r.id) !== id) return r;
    const next = {};
    for (const k of ROUTINE_KEYS) if (k in r) next[k] = r[k];
    for (const k of Object.keys(r)) if (!(k in next)) next[k] = r[k];
    next.enabled = enabled;
    return next;
  });
  writeRoutinesFile(repoRoot, agent, { routines }, verb);

  const lines = [`routine '${id}' ${enabled ? 'enabled' : 'disabled'}`];
  if (enabled) {
    const next = nextScheduledInstant(target, Date.now());
    if (next != null) lines.push(`  next fire: ${bangkokWall(next)} (+07:00) — ${humanIn(next - Date.now())}`);
  }
  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------
// run — fire one routine NOW, ignoring its schedule
// ---------------------------------------------------------------------------

async function runNow(repoRoot, agent, id, flags) {
  const verb = 'agent routine run';
  requireCharter(repoRoot, agent);
  requireId('run', agent, id);
  const doc = readRoutinesFile(repoRoot, agent);
  const routine = doc.routines.find((r) => String(r.id) === id);
  if (!routine) {
    throw new SidekicksError(
      `${verb}: no routine '${id}' for '${agent}' — see 'sidekicks agent routine list ${agent}'`,
      EXIT_VALIDATION
    );
  }

  const payload = buildRoutinePayload(agent, routine, {});
  if (flags['dry-run']) {
    return {
      stdout: `[dry-run] would fire '${id}' → ${agent} [${payload.category}]\n  goal: ${payload.goal}\n${payload.body_file ? `  body_file: ${payload.body_file}\n` : ''}`,
      exitCode: EXIT_OK,
    };
  }

  const result = await fireRoutine(repoRoot, agent, routine, { manual: true });
  if (!result.ok) {
    throw new SidekicksError(`${verb}: ${result.error}`, EXIT_VALIDATION);
  }
  markManualRun(repoRoot, agent, id, result.messageId);

  const lines = [
    `fired routine '${id}' → ${agent} [${payload.category}] as ${result.messageId}`,
    `  goal: ${payload.goal}`,
  ];
  if (payload.body_file) lines.push(`  body_file: ${payload.body_file}`);
  lines.push(`  note: a manual run does NOT consume the scheduled occurrence — the timed fire still happens`);

  const presence = presenceState(readPresence(repoRoot, agent));
  if (presence === 'offline' && !isDaemonRunning(repoRoot, `delegate-${agent}`)) {
    lines.push(`  note: nothing is currently draining '${agent}' — the task waits in inbox/new`);
  }
  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
}
