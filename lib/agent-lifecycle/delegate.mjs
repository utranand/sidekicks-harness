// lib/agent-lifecycle/delegate.mjs
// `sidekicks agent delegate <name> [--once] [--status] [--interval 2]
//                                  [--max-runtime 3600] [--rotate-after 20]
//                                  [--rotate-context 180000]
//                                  [--requeue-limit 3] [--settle 3] [--force]
//                                  [--permission-mode <m>] [--model <tier|id>]`
//
// One-delegate policy: only an ORCHESTRATOR charter may run a delegate (the
// user-facing entry point — john); worker charters are refused (--force for
// a deliberate exception). Decision record: memory 'delegate-orchestrator-only'.
//
// The HEADLESS runner — the delegate application that keeps a persistent agent
// alive without any terminal. A plain Node loop (this process) watches the
// agent's inbox/new; when work arrives it wakes a NON-INTERACTIVE agent-CLI
// session (`claude -p …` / `agy -p …`) with cwd = repo root, so the woken session sees the
// exact same world as a terminal session: skills via the self-healed
// `.claude/skills` link, session subagents via the Agent tool, and every
// `sidekicks` verb (including `agent create`). The session drains the inbox,
// completes each message (auto-replies ride back to the sender — e.g. the
// telegram relay), and exits; the loop goes back to watching.
//
// Presence ownership dance (one john at a time, no false foreign-session
// trips): the LOOP owns presence while idle (session `dlg-…`, standby
// heartbeat every tick). The woken session runs sk-agent-master, which
// mints its OWN session id and heartbeats — so the loop RELEASES presence just
// before spawning the child and RECLAIMS it right after the child exits.
// A foreign fresh presence at an idle tick (an interactively started agent)
// makes the delegate yield with exit 4, mirroring `agent wait`. To go the
// other way (delegate running, you want an interactive session), stop the
// delegate first: `sidekicks agent stop <name>`.
//
// CONVERSATION CONTINUITY (the load-bearing mechanism). Every wake is primed
// with a conversation-context block rendered from the agent's recorded
// transcript (lib/agent-lifecycle/_threads.mjs) and INLINED into the `-p`
// prompt: thread digest, the last few turns verbatim, an index of other
// conversations, and pointers to fetch more (`agent thread show` / `search`).
// It is inlined rather than staged in a file because a wake must not depend on
// the model choosing to read something — the same lesson journal-lifecycle
// learned the hard way. An agent with no open conversation gets a byte-identical
// prompt to before this existed. Because the transcript is written by CLI verbs
// on both sides of the chat, continuity survives a cold session, a rotation, a
// crash, and a switch to a CLI that has no session-resume at all.
//
// Wake-session continuity (an OPTIMIZATION on top): each successful wake's
// session_id (claude `--output-format json`) is persisted in
// runtime/delegate.json and resumed on the next wake (`--resume`), so prompt
// caching prices the repeated prefix cheaply. The saved session rotates (fresh
// start) after --rotate-after successful runs, and is dropped immediately when a
// resumed run fails (retry fresh — a dead session must never wedge the loop).
// A CLI with no machine-readable result (antigravity: `agy -p` prints plain
// text) yields no session_id, so every one of its wakes is fresh and the
// rotation flags are inert for it — the optimization is absent, the mechanism
// above is not. Nothing else in the loop depends on it: wake success comes from
// the exit code and progress from inbox-message identity, never from stdout.
//
// Context compaction (rotation is a COMPACTION, not a cold drop): rotation
// fires on whichever signal trips first — the --rotate-after run cap, or
// --rotate-context, the previous wake's RESIDENT context (usage.iterations'
// last entry). That metric matters: the earlier signal summed input +
// cache-creation + cache-read across the whole wake, which scales with turn
// count rather than context size, so over 17 measured wakes it read 336k to
// 11.2M and tripped a 400k threshold every single time — 9 fresh wakes, 0
// resumes. Resident context over the same wakes rose smoothly 81k → 331k.
// When a saved session is due to rotate, the loop first RESUMES it one last
// time with a short bounded handoff wake that refreshes each open conversation's
// digest and writes the agent's WORK state to runtime/handoff.md (in-progress
// assignments, gotchas — the dialogue itself lives in the thread digest, not
// here). Per-wake task summaries ride the master skill's diary buffer, so even a
// lost handoff leaves a trail. The handoff wake is best-effort: if it fails or
// times out, rotation proceeds anyway. --rotate-context 0 disables the context
// signal; --rotate-tokens is accepted as a deprecated alias.
//
// Failure containment: nonzero child exit, max-runtime kill, or a zero-exit
// run that did NOT shrink inbox/new (a hot-loop signature) all count as
// failures — exponential backoff 30s→300s, and after 5 consecutive failures
// the loop exits nonzero so a supervisor (launchd KeepAlive) restarts it with
// its own throttle instead of this process spinning.
//
// Crash recovery (work is never stranded mid-assignment): the loop wakes on
// the inbox/new count only, so a wake session that dies mid-work (max-runtime
// kill, CLI crash, reboot) would leave its claimed messages in claimed/
// forever. Every idle tick therefore requeues orphaned claims back to new/
// (requeueOrphanedClaims — safe because the loop has already yielded to any
// live foreign session), and a max-runtime kill KEEPS the saved session id so
// the retry RESUMES the interrupted session with its mid-run context instead
// of restarting. A message that keeps dying is failed out after
// --requeue-limit requeues with an auto-reply to the sender (the relay ships
// the escalation to the user) — a poison message must not wedge the loop.
//
// Comms ride along: every idle tick calls ensureCommsProcesses, so the
// telegram relay + LAN bridge auto-start switches keep the user reachable for
// as long as the delegate runs — launching the delegate IS launching the
// stack. A long wake would starve those idle ticks, so the in-wake control
// ticker re-checks comms every 30s too.
//
// PACEMAKER (self-injected mission ticks): when the root config's
// `agent_daemon:` block enables it for this agent, an IDLE tick with an empty
// mailbox self-injects a mission tick into the agent's own inbox once its sleep
// budget has elapsed, and the very next iteration wakes on it like any other
// message. That makes autonomy a property of THIS process — if the delegate is
// up, the lane thinks — instead of depending on the routine scheduler being
// alive (it was dead for eight days once, recording every tick as `missed`).
// The tick is always stamped `from: scheduler` (fixed, not configurable: the
// charter and the mission-loop skill route on it, and it is unforgeable from
// chat), and it is never injected while the mailbox is non-empty, while a claim
// is stranded, while the agent is paused or stopped, after a failed wake, or
// during a quota pause. `max_ticks_per_day` is the cost backstop and survives a
// restart on purpose. Config is re-read EVERY tick so an edit lands within
// seconds; the numeric knobs deliberately have no env or flag form (env is
// fixed at process start, which would defeat that) — `--no-pacemaker` and
// SIDEKICKS_DELEGATE_PACEMAKER=0 can only turn it OFF. Decisions live in
// _pacemaker.mjs as pure functions of `nowMs`.
//
// SIDEKICKS_DELEGATE_NO_EXEC=1 dry-runs a wake: the fully resolved command +
// prompt are printed and the loop exits without spawning anything (tests).
// SIDEKICKS_DELEGATE_NO_SEND=1 additionally rehearses the PACEMAKER: the
// decision and payload are printed and neither the mailbox nor the state file is
// touched, so the same command re-runs byte-identically.
// SIDEKICKS_DELEGATE_NOW pins the clock for pacemaker tests and is honoured
// ONLY with --once (a continuous loop on a frozen clock would spin forever).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawn, spawnSync } from 'node:child_process';
import { rmSync, renameSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  SidekicksError,
  EXIT_OK,
  EXIT_VALIDATION,
  EXIT_AGENT_FOREIGN_SESSION,
} from '../sk-cli/errors.mjs';
import {
  parseMemoryFlags,
  bangkokTimestamp,
  validateAgentName,
  requireCharter,
  resolveCharterCli,
  CLI_LAUNCH,
  ensureRuntimeTree,
  readPresence,
  writePresence,
  presenceState,
  readControlStage,
  listMessageIds,
  readMessage,
  writeMessage,
  moveToDone,
  inboxDir,
  runtimeDir,
  presencePath,
} from './_shared.mjs';
import { autoReplyToSender } from './complete.mjs';
import { appendEvent } from '../journal-lifecycle/log.mjs';
import { resolveJournalConfig } from '../journal-lifecycle/_shared.mjs';
import { renderLessonsBlock } from '../journal-lifecycle/lesson.mjs';
import {
  bridgeRuntimeDir,
  pidFilePath,
  writePidFile,
  acquirePidFile,
  isDaemonRunning,
  isProcessAlive,
  readJsonFile,
  writeJsonFile,
} from './_bridge.mjs';
import { ensureCommsProcesses } from './_comms.mjs';
import { resolveModel } from './start.mjs';
import { composePrimaryPrompt } from './_primary-prompt.mjs';
import {
  resolveAgentDaemonConfig,
  readPacemakerState,
  readSleepRequest,
  pacemakerDecision,
  injectPacemakerTick,
  markWakeEnd,
  formatPacemakerStatus,
  writePacemakerState,
  bangkokStamp,
} from './_pacemaker.mjs';
import { classifyWakeStall, quotaPauseActive } from './_quota.mjs';
import { bangkokWallToMs, SCHEDULER_AGENT } from './_routines.mjs';
import { cmdShimSpawn, isCmdShim } from './_win-argv.mjs';
import {
  MAX_CONTEXT_BYTES,
  listThreads,
  digestIsStale,
  writeAutoDigest,
  renderContextBlock,
} from './_threads.mjs';

const DEFAULT_INTERVAL_S = 2;
const DEFAULT_MAX_RUNTIME_S = 3600;
const DEFAULT_ROTATE_AFTER = 20;
// Rotation threshold on the previous wake's RESIDENT CONTEXT (usage.iterations
// last entry — see parseHeadlessResult). When it meets this, the saved session
// is bloated and the next wake rotates, with a handoff compaction wake first.
// 0 disables (run-cap rotation only).
//
// Why 180k, and why this is not the cumulative sum: the old signal summed
// input + cache-creation + cache-read across the WHOLE wake, which scales with
// turn count rather than context size. Measured over 17 real wakes in this repo
// it ran 336k (a 4-turn wake) to 11.2M (59 turns) — so a fresh session's first
// wake already tripped a 400k threshold and EVERY wake rotated: 9 fresh wakes,
// 0 resumes, 8 rotations, and continuity survived only through the handoff
// brief. Resident context over the same wakes rose smoothly 81k → 331k, with
// healthy sessions topping out around 148k. 180k therefore lets a lean session
// keep resuming and rotates one that has genuinely ballooned.
//
// This is a COST lever, not a capacity guard: the result JSON reports
// contextWindow 1000000 for claude-sonnet-5, so even the 331k session had ample
// room. What it did not have was cheap wakes — 59 turns at ~190k resident cost
// 11.2M cache-read tokens and $5.50. Keeping sessions near 180k keeps each turn's
// re-read small. Raising this trades money for fewer rotations and costs nothing
// in continuity, because the conversation is recorded independently of the
// session (see _threads.mjs) — rotation no longer loses anything.
const DEFAULT_ROTATE_CONTEXT = 180_000;
// The handoff compaction wake is one focused write — bound it well below the
// work wake's max-runtime so a wedged handoff can only ever delay real work
// by minutes, never an hour.
const HANDOFF_MAX_RUNTIME_MS = 300_000;
const DEFAULT_REQUEUE_LIMIT = 3;
// Burst batching: how long to settle after first spotting new work before
// waking. Chat messages often arrive in quick bursts (a user typing several
// telegram messages back to back); waking per message pays the session
// bootstrap token cost each time — one settled wake drains the whole burst.
const DEFAULT_SETTLE_S = 3;
// How often a RUNNING wake re-checks the comms daemons — idle ticks already do
// this every interval, but a wake can hold the loop for up to max-runtime, and
// a relay that died mid-wake must not stay dead for an hour.
const COMMS_RECHECK_MS = 30_000;

/**
 * Bounded tail of wake stderr, kept ONLY so a usage-limit stall can be told
 * apart from a bug (see _quota.mjs). stderr is otherwise a pure passthrough.
 */
const STDERR_TAIL_CAP = 8 * 1024;
const DEFAULT_PERMISSION_MODE = 'bypassPermissions';
/**
 * Failed wakes the loop tolerates before it EXITS for the supervisor to restart
 * it — the lane's only autonomous recovery path (a fresh generation clears the
 * counter, see the reset near the top of runDelegateLoop).
 *
 * Exported because the pacemaker's `pause_after_failures` gate must never bite
 * BEFORE this ceiling: the pacemaker is the lane's only tick source, so a hold
 * at a lower count stops the wakes that would have carried the counter up to
 * this exit — the lane then sits alive and silent forever, with no supervisor
 * event and nothing but a chat message to un-wedge it. The invariant
 * (DEFAULTS.pause_after_failures >= MAX_CONSECUTIVE_FAILURES) is pinned by
 * tests/agent-pacemaker.test.mjs.
 */
export const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 300_000;
const KILL_GRACE_MS = 10_000;
// Cap the in-memory copy of the child's stdout (kept only to parse the final
// result JSON) — the full stream still flows through to the log unconditionally.
const STDOUT_CAP = 2 * 1024 * 1024;

// The CLIs a headless adapter exists for. start.mjs's --headless branch
// imports this (lazily — no static cycle) to refuse early with a clear
// message; adding a CLI means adding a row to buildHeadlessCommand and
// extending this list.
export const HEADLESS_CLIS = ['claude', 'antigravity', 'codex'];

// How a claude --permission-mode maps onto a `codex exec` sandbox policy.
// Unlike agy, codex HAS a granular surface (-s read-only|workspace-write|
// danger-full-access) plus an all-or-nothing bypass, so a narrower mode is
// honored rather than refused. CODEX_BYPASS is the sentinel for "emit
// --dangerously-bypass-approvals-and-sandbox instead of -s".
// Verified against `codex exec --help` (codex-cli 0.142.5): `exec` has NO
// --ask-for-approval — non-interactive runs have nothing to approve against —
// so the sandbox policy is the whole permission surface here.
const CODEX_BYPASS = Symbol('codex-bypass');
const CODEX_SANDBOX = {
  bypassPermissions: CODEX_BYPASS,
  'dangerously-skip-permissions': CODEX_BYPASS,
  'danger-full-access': CODEX_BYPASS,   // the codex spelling of the same thing
  acceptEdits: 'workspace-write',       // write inside the workspace, sandboxed outside
  default: 'workspace-write',
  plan: 'read-only',
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
};

// The permission modes an `agy` wake can honor. The CLI has exactly one
// permission surface — the all-or-nothing --dangerously-skip-permissions —
// and no --permission-mode equivalent, so these are the only two spellings
// of "run unattended" it can implement. Any narrower mode is REFUSED rather
// than silently widened to full autonomy (see buildHeadlessCommand).
const AGY_BYPASS_MODES = new Set(['bypassPermissions', 'dangerously-skip-permissions']);

/**
 * Does this presence belong to a live FOREIGN session that should make the
 * delegate yield?
 *
 * The subtlety is a crashed predecessor. The loop clears its own presence in a
 * `finally`, so a graceful stop leaves nothing behind — but SIGKILL, an OOM
 * kill, a panic, or a power cut skip that handler and leave an orphan whose
 * heartbeat stays "fresh" for the full PRESENCE_TTL_MS (15 minutes). A
 * supervised delegate (launchd KeepAlive) then respawns, reads that orphan,
 * concludes an interactive session owns the agent, and yields with exit 4 —
 * over and over, for a quarter of an hour, precisely when the supervisor is
 * supposed to be saving you.
 *
 * A delegate's own session id embeds its pid (`dlg-<pid>-<ts>`), so an orphan is
 * identifiable: a `dlg-` session whose process is provably gone is a corpse, not
 * an owner. Interactive sessions (`mst-…`, `std-…`, `tg-…`) carry no pid and are
 * never second-guessed — so the one-live-session guarantee is untouched for the
 * case it exists to protect.
 */
export function isForeignLiveSession(presence, ownSession) {
  if (!presence || !presence.session_id) return false;
  if (presence.session_id === ownSession) return false;
  if (presenceState(presence) !== 'fresh') return false;
  const m = /^dlg-(\d+)-\d+$/.exec(presence.session_id);
  if (m && !isProcessAlive(Number(m[1]))) return false; // crashed predecessor
  return true;
}

/** Where the wake-session continuity state lives (git-ignored runtime/). */
export function delegateStatePath(repoRoot, name) {
  return join(runtimeDir(repoRoot, name), 'delegate.json');
}

/** The delegate's log file (same git-ignored comms log dir as the daemons). */
export function delegateLogPath(repoRoot, name) {
  return join(bridgeRuntimeDir(repoRoot), 'logs', `delegate-${name}.log`);
}

/** The handoff brief the compaction wake writes and a fresh session reads. */
export function handoffPath(repoRoot, name) {
  return join(runtimeDir(repoRoot, name), 'handoff.md');
}

/**
 * The wake prompt. Deliberately free of double-quote characters (same
 * convention as start.mjs's bootstrapPrompt) and explicit about the headless
 * contract: no interactive user, never block on input, escalations travel as
 * completions (the auto-reply is the only channel back to the user), exit
 * when the inbox is drained.
 *
 * A FRESH wake (post-rotation) additionally points at the handoff brief the
 * outgoing session compacted its context into — the only conversational
 * carry-over across a rotation. Every wake closes with the diary-buffer
 * reinforcement so a per-run task summary lands even when a session exits in
 * a hurry.
 *
 * The caller passes `handoffRel` only when a brief is actually on disk, so the
 * carry-over sentence never sends a session hunting for a file that does not
 * exist. That distinction is invisible on claude (only the first-ever wake is
 * fresh without a brief) but load-bearing on a CLI with no session resume:
 * there EVERY wake is fresh and the rotation handoff never runs, so an
 * unconditional sentence would claim a rotation that never happened and cite a
 * brief that can never be written.
 *
 * @param {string} name
 * @param {{ fresh?: boolean, handoffRel?: string|null }} [opts]
 */
export function delegatePrompt(name, { fresh = false, handoffRel = null } = {}) {
  const carryOver = fresh && handoffRel
    ? ` This is a FRESH session after a context rotation: before touching the inbox, read ${handoffRel} if it exists — your predecessor session's brief on WORK state (in-progress assignments, gotchas). The conversation itself is not in there; any open chat is already recorded below and in its thread digest.`
    : '';
  return `You are agent '${name}' running HEADLESS in delegate mode — no interactive user is attached to this session.${carryOver} Run the sk-agent-master skill as '${name}': claim and drain every message in your inbox, route each assignment per your charter, and complete each one with node bin/sidekicks agent complete (attach evidence files with --deliverable so the relay ships them to the user). This session's cwd is the repo root and the CLI is ALWAYS invoked as \`node bin/sidekicks <verb>\` — there is no \`sidekicks\` executable on PATH, so never run a bare \`sidekicks\`, and never go looking for one. Keep every filesystem search inside the repo and narrowly scoped (a named directory, --include, -l): the working tree spans tens of GB of checked-out service code, so an unbounded \`grep -r <pattern> .\` or \`find ~\` costs tens of minutes to HOURS, and it blocks this whole lane — the user's next message cannot be claimed until this wake exits. Prefer the index (node bin/sidekicks index show --json) and targeted paths over scanning. Never ask the user questions and never block waiting for input — anything that needs a human becomes a completion whose summary states the escalation; the completion auto-reply is your only channel to the user. Before exiting, append this wake's noteworthy events to your diary buffer per the master skill's memory rules — that per-run summary is what survives a lost session. When inbox/new is empty and every claimed message is completed, exit the session immediately — do not start unrequested follow-up work.`;
}

/**
 * The compaction prompt for the one-shot handoff wake that RESUMES a session
 * about to be rotated out. Same no-double-quote convention. The brief it
 * writes is the fresh session's bootstrap context; the diary-buffer
 * consolidation is the durable backup if the brief write fails.
 */
/**
 * The conversation-context block for this wake, or '' when the agent has no
 * open conversation (every worker, every non-chat agent — those get a
 * byte-identical prompt to before this existed).
 *
 * Composed at the CALL SITE rather than inside delegatePrompt, deliberately:
 * delegatePrompt must stay free of double-quote characters (asserted by tests,
 * and load-bearing because start.mjs pushes the same style of prompt through
 * POSIX/cmd/AppleScript quoting), while a transcript contains arbitrary user
 * text. Here it is safe: runWakeSession spawns with an ARGV ARRAY and no shell,
 * so quotes and newlines pass through untouched.
 */
export function wakeContextBlock(repoRoot, name, { maxBytes = MAX_CONTEXT_BYTES } = {}) {
  try {
    const open = listThreads(repoRoot, name, { limit: 1, openOnly: true })[0];
    if (!open) return '';
    // Keep the extractive digest current without spending a model token — it is
    // what guarantees the block is never empty just because no session got
    // round to writing prose.
    if (digestIsStale(repoRoot, name, open.id, open)) writeAutoDigest(repoRoot, name, open.id);
    return renderContextBlock(repoRoot, name, { threadId: open.id, maxBytes });
  } catch {
    return ''; // continuity is best-effort; a wake must never fail over it
  }
}

/**
 * The FLEET LESSONS block for this wake, or '' when the journal is off or the
 * pool is empty. Same contract as wakeContextBlock: best-effort, bounded
 * (renderLessonsBlock caps bytes), a wake must never fail over it.
 */
export function fleetLessonsBlock(repoRoot) {
  try {
    return renderLessonsBlock(resolveJournalConfig(repoRoot));
  } catch {
    return '';
  }
}

export function handoffPrompt(name, handoffRel) {
  return `You are agent '${name}' — this resumed session is about to be RETIRED by a context rotation, and a fresh session will take over your inbox. Do two things, then exit. FIRST, refresh the digest of every open conversation so the successor inherits the dialogue: node bin/sidekicks agent thread list ${name} --open names them, and for each one run node bin/sidekicks agent thread digest ${name} <thread-id> --set=<one paragraph: what the user wants, what was agreed, what is still pending>. SECOND, compact your WORK state into a handoff brief at ${handoffRel} (overwrite the file): in-progress assignments and their exact state, standing decisions or preferences observed in this session, and any gotchas the successor must know — the conversation itself belongs in the thread digests, so do not restate it here. Be terse — under 60 lines, facts only, no prose padding. Also consolidate this session's noteworthy events into your diary buffer per the sk-agent-master memory rules. Do not start new work, do not claim or complete inbox messages, and exit as soon as both are written.`;
}

/**
 * Build the headless (non-interactive) invocation for a charter CLI.
 * The Rule 6 extension point is this function plus HEADLESS_CLIS (`gemini`
 * is the remaining row with no adapter).
 *
 * The binary comes from the shared CLI_LAUNCH table rather than a literal, so
 * a CLI's executable name lives in exactly one place across start.mjs and
 * this module.
 *
 * `fullContext` (claude row only) opts a wake OUT of the lean context flags —
 * the debugging escape hatch behind `agent delegate --full-context`. Lean is
 * the default because every flag was probe-verified to pay (2026-08-02 matrix,
 * artifacts/runs/wake-lean/probe-matrix.md): together −962 tokens of fixed
 * bootstrap per wake, plus a byte-stable system-prompt prefix that lets
 * --resume hit the prompt cache instead of re-writing it.
 *
 * @param {{ cliName: string, prompt: string, model: string|null,
 *           permissionMode: string, resume: string|null,
 *           maxRuntimeMs?: number|null, fullContext?: boolean }} spec
 * @returns {{ bin: string, args: string[] }}
 */
export function buildHeadlessCommand({ cliName, prompt, model, permissionMode, resume, maxRuntimeMs = null, fullContext = false }) {
  if (!HEADLESS_CLIS.includes(cliName)) {
    throw new SidekicksError(
      `agent delegate: cli '${cliName}' has no headless adapter yet — supported: ${HEADLESS_CLIS.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  const bin = CLI_LAUNCH[cliName]?.bin || cliName;

  if (cliName === 'antigravity') {
    // `agy -p` prints PLAIN TEXT — there is no --output-format json, so no
    // session_id ever comes back. parseHeadlessResult therefore returns null,
    // shouldRotateSession sees no saved session and every wake starts FRESH:
    // --resume has no counterpart to pass (--conversation needs an id we can
    // never learn) and the rotation/handoff path never fires. Continuity does
    // not depend on any of it — it rides the conversation-context block, which
    // is CLI-agnostic. `resume` is accepted and ignored for exactly that
    // reason: the caller cannot produce a non-null one for this CLI.
    const args = ['-p', prompt];
    if (model) args.push('--model', model);
    // No --effort: the antigravity tier ids already encode reasoning effort in
    // their suffix (…-high/-medium/-low), see start.mjs TIER_MODELS.
    if (!AGY_BYPASS_MODES.has(permissionMode)) {
      throw new SidekicksError(
        `agent delegate: cli 'antigravity' cannot honor permission mode '${permissionMode}' — `
        + `agy has no --permission-mode gate, only the all-or-nothing --dangerously-skip-permissions. `
        + `Use --permission-mode bypassPermissions (the delegate default) for an unattended lane, or start the `
        + `agent interactively with --spawn, where a narrower mode is enforceable.`,
        EXIT_VALIDATION
      );
    }
    args.push('--dangerously-skip-permissions');
    // agy's own --print-timeout defaults to 5m0s, far INSIDE the delegate's
    // --max-runtime (3600s default): left alone it guillotines any longer wake
    // and the loop reads the truncation as a failed wake. Match the two so the
    // delegate's kill timer stays the single authority on wake length.
    if (Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0) {
      args.push('--print-timeout', `${Math.round(maxRuntimeMs / 1000)}s`);
    }
    return { bin, args };
  }

  if (cliName === 'codex') {
    // `codex exec` — verified against codex-cli 0.142.5 by capturing real runs.
    // Arg ORDER is load-bearing: resume is a SUBCOMMAND taking the thread id
    // positionally (`codex exec resume <id> …`), not a `--resume <id>` flag,
    // and the prompt is the trailing positional.
    const args = ['exec'];
    if (resume) args.push('resume', resume);
    args.push('--json');
    if (model) args.push('-m', model);
    const sandbox = CODEX_SANDBOX[permissionMode];
    if (sandbox === undefined) {
      throw new SidekicksError(
        `agent delegate: cli 'codex' cannot honor permission mode '${permissionMode}' — `
        + `map it to a codex sandbox policy first (read-only | workspace-write | danger-full-access), `
        + `or use bypassPermissions (the delegate default) for a fully unattended lane.`,
        EXIT_VALIDATION
      );
    }
    if (sandbox === CODEX_BYPASS) args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-s', sandbox);
    // NOTE: no --print-timeout equivalent exists; the delegate's own kill timer
    // is the only wake bound, which is what we want.
    // NOTE: `codex exec` READS STDIN when stdin is not at EOF and appends it to
    // the prompt as a <stdin> block — an open stdin makes it hang forever
    // waiting for EOF (observed live). runWakeSession spawns with
    // stdio[0]='ignore' (/dev/null on POSIX, NUL on Windows), which is EOF
    // immediately, so the wake is safe. Do not change that to 'pipe' without
    // closing the stream.
    args.push(prompt);
    return { bin, args };
  }

  // claude
  const args = ['-p', prompt];
  if (model) args.push('--model', model);
  if (permissionMode === 'dangerously-skip-permissions') {
    // The one mode that is its own flag rather than a --permission-mode value.
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', permissionMode);
  }
  args.push('--output-format', 'json');
  if (!fullContext) {
    // Lean wake context (probe matrix 2026-08-02, claude v2.1.220 — each flag
    // individually measured against a ±120-token noise floor):
    //   --strict-mcp-config                        −475: drops user/plugin MCP
    //     servers (deep-thinker, stitch, figma, slack) — no wake path uses MCP.
    //   --setting-sources project                  −~420 more: drops user-scope
    //     settings (pixel-agents hook on 13 events, figma/github/skill-creator
    //     plugins, settings.local.json allow-rules that are moot under
    //     bypassPermissions). Project + local scopes still load, so the repo's
    //     own hooks (memory index, run-notify, office-viz) keep firing.
    //   --exclude-dynamic-system-prompt-sections   small token win; the real
    //     effect is a byte-stable prompt prefix across wakes (cwd/env/git
    //     status move into the first user message), which is what makes a
    //     resumed wake bill the bootstrap at cache-read instead of re-writing.
    args.push('--strict-mcp-config');
    args.push('--setting-sources', 'project');
    args.push('--exclude-dynamic-system-prompt-sections');
  }
  if (resume) args.push('--resume', resume);
  return { bin, args };
}

/**
 * Should the next wake start a FRESH session instead of resuming the saved
 * one? True when nothing is saved, when the saved session has served
 * `rotateAfter` successful runs (run-count cap), or when the previous wake's
 * input-side token usage reached `rotateTokens` (bloat signal — a session
 * whose single wake costs that much rotates NOW instead of serving out the
 * run cap). `rotateTokens` 0 disables the token signal.
 */
export function shouldRotateSession(state, rotateAfter, rotateContext = 0) {
  if (!state || !state.session_id) return true;
  const runs = Number.isInteger(state.runs) ? state.runs : 0;
  if (runs >= rotateAfter) return true;
  if (rotateContext > 0) {
    // Prefer the resident-context measure; fall back to the legacy cumulative
    // field so a delegate upgraded in flight (state written by the previous
    // version) still rotates rather than silently never rotating.
    const ctx = Number.isInteger(state.last_context_tokens)
      ? state.last_context_tokens
      : (Number.isInteger(state.last_wake_tokens) ? state.last_wake_tokens : 0);
    if (ctx >= rotateContext) return true;
  }
  return false;
}

/**
 * The session id to persist after a wake.
 * - Success → the session that ran (or what we resumed).
 * - KILLED (max-runtime) → KEEP the session: the CLI's on-disk session
 *   survives a SIGTERM and still holds the mid-run context, so the next wake
 *   resumes and CONTINUES the interrupted assignment instead of restarting
 *   it from scratch. Dropping it here was how long assignments lost all
 *   progress at every max-runtime boundary.
 * - Genuine failure of a RESUMED session → drop it (a dead/bloated session
 *   must never wedge the loop; retry fresh).
 * - Failure of a fresh run → keep whatever was saved before (nothing new
 *   was learned; rotation state still governs the next wake).
 *
 * @param {{ ok: boolean, killed: boolean, sessionId: string|null }} outcome
 * @param {string|null} resume - the session id this wake resumed (null = fresh)
 * @param {string|null} prev - the previously saved session id
 * @returns {string|null}
 */
export function nextSessionId(outcome, resume, prev) {
  if (outcome.ok) return outcome.sessionId || resume || null;
  if (outcome.killed) return resume || prev || null;
  return resume ? null : (prev || null);
}

/**
 * Did a wake make progress? Compares the inbox/new message IDs seen BEFORE the
 * wake against those still there after, and counts progress when at least one
 * of the original messages left inbox/new (claimed or completed).
 *
 * A plain count comparison (the previous implementation) was wrong in both
 * directions once anything OTHER than the wake session could enqueue:
 * - False failure: a message arriving mid-wake (e.g. the routine scheduler
 *   firing, or a Telegram relay message) keeps the count level, so a wake that
 *   fully drained its own work scored as "no progress" → backoff → after
 *   MAX_CONSECUTIVE_FAILURES the loop deliberately exits 1 and the agent goes
 *   dark, precisely when traffic is heaviest.
 * - False success: a count that dropped for any other reason read as progress.
 *
 * A requeued orphan keeps its id (requeueOrphanedClaims renames it back), so a
 * claimed-then-abandoned message correctly counts as NOT drained.
 *
 * @param {string[]} beforeIds - inbox/new ids observed before the wake
 * @param {string[]} afterIds - inbox/new ids observed after the wake
 * @returns {{ progressed: boolean, drained: string[] }}
 */
export function computeProgress(beforeIds, afterIds) {
  const after = new Set(afterIds);
  const drained = beforeIds.filter((id) => !after.has(id));
  return { progressed: drained.length > 0, drained };
}

/**
 * Requeue orphaned claimed messages back to inbox/new so an interrupted
 * wake's work is RETRIED instead of stranded. The loop wakes only on the
 * inbox/new count, so without this a wake session that died mid-assignment
 * (max-runtime kill, CLI crash, reboot) left its claimed messages in
 * claimed/ forever — the assignment silently lost.
 *
 * Called only from an IDLE tick: the loop has already yielded to any fresh
 * foreign presence, so by the presence protocol every claim still sitting in
 * claimed/ belongs to a dead session. Each requeue is stamped
 * (requeue: {count, last_at}); past `limit` the message is failed out to
 * done/ with an auto-reply to the sender (the telegram relay ships it to the
 * user) — a poison message must not wedge the loop in an endless
 * kill-requeue-kill cycle.
 *
 * `countAttempt: false` requeues WITHOUT advancing the counter. That is for a
 * stall the message did not cause and cannot fix — a CLI usage limit. Counting
 * those would fail the user's message out to done/ after three quota walls with
 * "the work kept dying mid-run", which is both false and destructive: the work
 * never ran at all.
 *
 * @returns {{ requeued: string[], failedOut: string[] }}
 */
export function requeueOrphanedClaims(repoRoot, name, limit, { countAttempt = true } = {}) {
  const requeued = [];
  const failedOut = [];
  for (const id of listMessageIds(repoRoot, name, 'claimed')) {
    const msg = readMessage(repoRoot, name, 'claimed', id) || { id };
    const prior = msg.requeue && Number.isInteger(msg.requeue.count) ? msg.requeue.count : 0;
    const count = countAttempt ? prior + 1 : prior;
    if (countAttempt && count > limit) {
      const result = {
        status: 'failed',
        summary: `delegate: abandoned '${id}' after ${limit} interrupted wake sessions — the work kept dying mid-run (see the delegate log); re-send to retry`,
        branch: null,
        deliverables: [],
        completed_at: bangkokTimestamp(),
      };
      writeMessage(repoRoot, name, 'claimed', { ...msg, result });
      moveToDone(repoRoot, name, id);
      autoReplyToSender(repoRoot, name, msg, id, result);
      // This close path bypasses `agent complete`, so it must log its own L0
      // event — an abandoned poison message is exactly the kind of thing the
      // journal exists to surface, and it is the one failure no human watched.
      appendEvent(repoRoot, { agent: name, msg, result });
      failedOut.push(id);
      continue;
    }
    writeMessage(repoRoot, name, 'claimed', {
      ...msg,
      claim: null,
      requeue: { count, last_at: bangkokTimestamp() },
    });
    // Atomic move back — unique ids mean new/<id>.json never pre-exists
    // (Windows-safe, same idiom as the claim rename in the other direction).
    renameSync(
      join(inboxDir(repoRoot, name, 'claimed'), `${id}.json`),
      join(inboxDir(repoRoot, name, 'new'), `${id}.json`)
    );
    requeued.push(id);
  }
  return { requeued, failedOut };
}

/**
 * Parse a `codex exec --json` JSONL EVENT STREAM. Shape verified by capturing
 * real codex-cli 0.142.5 runs (fresh, resumed, and failed):
 *
 *   {"type":"thread.started","thread_id":"019f…"}                    ← FIRST line
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *   {"type":"turn.completed","usage":{"input_tokens":26862,
 *      "cached_input_tokens":4480,"output_tokens":17,…}}             ← LAST line
 *
 * Four differences from the claude shape make a dedicated parser necessary,
 * and the third is a correctness trap:
 *   1. the session id is `thread_id` on the FIRST line, not `session_id` on
 *      the last (it is echoed unchanged when resuming, so it round-trips);
 *   2. usage keys are `input_tokens` / `cached_input_tokens` — the claude
 *      names (cache_creation/cache_read_input_tokens) are absent;
 *   3. failure is a `turn.failed` EVENT — there is no `is_error` field, so the
 *      generic scanner reads a failed turn as a SUCCESS with no session id;
 *   4. there is no `num_turns` — turns are counted from `turn.started` events.
 *
 * `cached_input_tokens` is a SUBSET of `input_tokens` (observed 25984 of 26870),
 * so they must not be summed. `input_tokens` alone is the per-turn input, i.e.
 * the resident context — which is exactly the rotation signal. That subset is
 * still worth keeping separately as `cacheReadTokens`: it is the cache-served
 * share of the prefix, the signal that proves resume + prompt caching is
 * actually paying per wake.
 *
 * @returns {{ sessionId, isError, wakeTokens, turns, contextTokens, cacheReadTokens }|null}
 */
export function parseCodexResult(stdout) {
  const lines = String(stdout || '').split('\n');
  let sessionId = null;
  let isError = false;
  let contextTokens = null;
  let cacheReadTokens = null;
  let turns = 0;
  let sawCodexEvent = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    switch (obj.type) {
      case 'thread.started':
        sawCodexEvent = true;
        if (typeof obj.thread_id === 'string' && obj.thread_id) sessionId = obj.thread_id;
        break;
      case 'turn.started':
        sawCodexEvent = true;
        turns += 1;
        break;
      case 'turn.completed': {
        sawCodexEvent = true;
        const inTok = obj.usage?.input_tokens;
        if (Number.isFinite(inTok) && inTok > 0) contextTokens = Math.round(inTok);
        const cached = obj.usage?.cached_input_tokens;
        if (Number.isFinite(cached) && cached > 0) cacheReadTokens = Math.round(cached);
        break;
      }
      case 'turn.failed':
      case 'error':
        sawCodexEvent = true;
        isError = true;
        break;
      default:
        break;
    }
  }
  if (!sawCodexEvent) return null;
  return { sessionId, isError, wakeTokens: contextTokens, turns: turns || null, contextTokens, cacheReadTokens };
}

/**
 * Parse the wake session's stdout for the final result JSON
 * (`--output-format json` → one object carrying session_id / is_error /
 * usage). `wakeTokens` sums the input-side usage fields (input + cache
 * creation + cache reads) — the bloat signal token-based rotation keys on;
 * null when the CLI reported no usable usage block.
 * Tolerant: whole-output parse first, then a line scan from the end.
 *
 * Dispatches to parseCodexResult when the output is a codex event stream.
 * Detected by SHAPE rather than by threading cliName down here, so the one
 * call site (runWakeSession's finish) stays CLI-agnostic — codex's typed
 * events (`thread.started` / `turn.completed` / `turn.failed`) are unambiguous
 * and appear in no other CLI's output.
 *
 * `cacheReadTokens` is the cache-served share of the input side (claude:
 * `usage.cache_read_input_tokens`; codex: `cached_input_tokens`) — kept
 * separate so `--status` can show whether resume + prompt caching is landing.
 *
 * @returns {{ sessionId: string|null, isError: boolean, wakeTokens: number|null,
 *             turns: number|null, contextTokens: number|null,
 *             cacheReadTokens: number|null }|null}
 */
export function parseHeadlessResult(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  const codex = parseCodexResult(text);
  if (codex) return codex;
  const inputSide = (u) => ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    .reduce((acc, k) => acc + (Number.isFinite(u?.[k]) ? u[k] : 0), 0);
  const candidates = [text, ...text.split('\n').reverse()];
  for (const c of candidates) {
    const line = c.trim();
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') {
        let wakeTokens = null;
        let contextTokens = null;
        let cacheReadTokens = null;
        const turns = Number.isInteger(obj.num_turns) && obj.num_turns > 0 ? obj.num_turns : null;
        if (obj.usage && typeof obj.usage === 'object') {
          const sum = inputSide(obj.usage);
          if (sum > 0) wakeTokens = Math.round(sum);
          const cached = obj.usage.cache_read_input_tokens;
          if (Number.isFinite(cached) && cached > 0) cacheReadTokens = Math.round(cached);
          // RESIDENT CONTEXT, not cumulative spend. usage.iterations[] carries
          // the per-API-call breakdown and its LAST entry is the context the
          // wake actually loaded — verified against 17 real wakes in this repo,
          // where it rises smoothly 81k → 331k as a session ages while the
          // cumulative sum swings 336k → 11.2M purely with turn count.
          const iters = Array.isArray(obj.usage.iterations) ? obj.usage.iterations : [];
          const last = iters.length ? iters[iters.length - 1] : null;
          const lastCtx = last ? inputSide(last) : 0;
          if (lastCtx > 0) contextTokens = Math.round(lastCtx);
          // Degradations, in order: a per-turn average still tracks size
          // roughly; the cumulative sum at least never under-reports.
          else if (wakeTokens != null && turns) contextTokens = Math.round(wakeTokens / turns);
          else contextTokens = wakeTokens;
        }
        return {
          sessionId: typeof obj.session_id === 'string' ? obj.session_id : null,
          isError: Boolean(obj.is_error),
          wakeTokens,
          turns,
          contextTokens,
          cacheReadTokens,
        };
      }
    } catch { /* not this line */ }
  }
  return null;
}

/**
 * Assemble a wake outcome from the child's stdout and exit disposition.
 *
 * Extracted from runWakeSession's `finish` so the field set is testable: this
 * object is the ONLY channel between a wake and the loop's persisted rotation
 * state, and every field the loop reads must appear here.
 *
 * `turns` and `contextTokens` are load-bearing and were historically DROPPED,
 * which is worth stating plainly because the failure was invisible: the loop
 * persists them as `last_wake_turns` / `last_context_tokens`, and
 * shouldRotateSession prefers `last_context_tokens` (RESIDENT context) over the
 * legacy cumulative `last_wake_tokens`. With them missing, `last_context_tokens`
 * stayed null forever and every rotation decision silently fell back to the
 * cumulative figure — which scales with TURN COUNT rather than context size.
 * Measured over 43 real wakes in this repo: the cumulative signal trips a 180k
 * threshold 40 times, the resident signal 2. So the session was discarded on
 * ~93% of wakes instead of ~5%, and `--resume` almost never fired — the exact
 * symptom the rotation-metric rewrite was supposed to have fixed.
 *
 * @param {{ stdout: string, code: number|null, killed: boolean, err: Error|null }} spec
 * @returns {{ ok: boolean, code: number|null, killed: boolean,
 *             sessionId: string|null, wakeTokens: number|null,
 *             turns: number|null, contextTokens: number|null,
 *             cacheReadTokens: number|null, error: string|null }}
 */
export function buildWakeOutcome({ stdout, stderrTail = '', code, killed, err }) {
  const parsed = parseHeadlessResult(stdout);
  return {
    ok: !err && code === 0 && !killed && !(parsed && parsed.isError),
    code,
    killed,
    // Carried for quota classification only (see _quota.mjs). Nothing else in the
    // loop reads wake output: success comes from the exit code and progress from
    // inbox-message identity.
    stdout: String(stdout || ''),
    stderrTail: String(stderrTail || ''),
    sessionId: parsed ? parsed.sessionId : null,
    wakeTokens: parsed ? parsed.wakeTokens : null,
    turns: parsed ? parsed.turns : null,
    contextTokens: parsed ? parsed.contextTokens : null,
    cacheReadTokens: parsed ? (parsed.cacheReadTokens ?? null) : null,
    error: err ? err.message : null,
  };
}

/**
 * Tell the user, once, that the lane is paused on a usage limit.
 *
 * Written by the DELEGATE itself rather than by a wake, because the whole point
 * is that no wake can run: a quota'd CLI cannot be asked to send anything. It
 * goes through the normal send path into the lane's configured relay mailbox, so
 * the relay renders and delivers it with no new code.
 *
 * Best-effort by contract — a notification that cannot be posted must never turn
 * a recoverable pause into a crash.
 */
async function notifyQuotaPause(repoRoot, name, verdict, cliName) {
  const mailbox = String(resolveAgentDaemonConfig(repoRoot, name).tick.notify || '').trim();
  if (!mailbox) return;
  try {
    const { buildSendArgv } = await import('./serve.mjs');
    const { run: sendRun } = await import('./send.mjs');
    const goal = `⏳ ${name} is paused — ${cliName} usage limit reached. Resuming at `
      + `${bangkokStamp(verdict.resumeAtMs)}${verdict.source === 'fallback' ? ' (estimated — the CLI reported no reset time)' : ''}. `
      + 'Queued messages are safe and will be drained then.';
    await sendRun({
      repoRoot,
      argv: buildSendArgv({
        to: mailbox,
        from: SCHEDULER_AGENT,
        kind: 'signal',
        goal,
        origin: 'none',
      }),
      flags: {},
    }, { name: mailbox });
  } catch (err) {
    process.stderr.write(
      `delegate: could not post the quota notice to ${mailbox} (${err && err.message ? err.message : err}) — continuing\n`
    );
  }
}

/** Positive-number flag parse with a validation error on garbage. */
function numberFlag(flags, key, fallback, { allowZero = false } = {}) {
  const raw = flags[key];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !allowZero)) {
    throw new SidekicksError(
      `agent delegate: invalid --${key} '${raw}' — a number ${allowZero ? '>= 0' : '> 0'}`,
      EXIT_VALIDATION
    );
  }
  return n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the actual spawnable binary. On Windows a `claude` install is a
 * `claude.cmd` shim that bare spawn() cannot exec — probe for the .cmd form
 * first (same `where` probe idiom as start.mjs commandExists).
 *
 * This resolves the NAME only. Actually running a `.cmd` needs a cmd.exe layer,
 * which runWakeSession adds via cmdShimSpawn — returning the shim name here and
 * spawning it directly is what made every Windows wake fail with EINVAL.
 */
function resolveHeadlessBin(bin) {
  if (process.platform !== 'win32') return bin;
  try {
    const probe = spawnSync('where', [`${bin}.cmd`], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return `${bin}.cmd`;
  } catch { /* fall through */ }
  return bin;
}

/**
 * Run one wake session to completion. The child's stdout/stderr stream to
 * THIS process's stdout/stderr (which the detached launcher points at the
 * delegate log). Kills on max-runtime and on a control 'stop' arriving
 * mid-run.
 *
 * @returns {Promise<{ ok: boolean, code: number|null, killed: boolean,
 *                     sessionId: string|null, wakeTokens: number|null,
 *                     turns: number|null, contextTokens: number|null,
 *                     cacheReadTokens: number|null, error: string|null }>}
 */
/**
 * Signal a wake session AND every process it spawned.
 *
 * A wake CLI shells out constantly (`zsh -c grep -rn … .`, test runners, git),
 * and `child.kill()` reaches only the CLI itself — its shells keep running and
 * reparent to pid 1. On a repo whose working tree is tens of GB (a root plus
 * checked-out service submodules), a single orphaned recursive grep can burn
 * CPU for hours, starving every later wake until the lane deadlocks and the
 * user's messages sit unclaimed. Signalling the whole process group reaps the
 * descendants with the CLI; group membership survives reparenting, so this
 * still reaches a grandchild whose own parent is already gone.
 *
 * POSIX: the wake is spawned `detached`, making the CLI a process-group leader,
 * so a negative pid addresses the group. Windows has neither process groups nor
 * real POSIX signals — `taskkill /T /F` is the tree-kill equivalent, and Node
 * already maps SIGTERM to an abrupt TerminateProcess for the direct child, so
 * using the forced tree walk on both tiers gives up no graceful shutdown that
 * the platform ever offered.
 *
 * @param {{ pid?: number, kill: (sig?: string) => boolean }|null} child
 * @param {'SIGTERM'|'SIGKILL'} signal
 */
export function signalWakeTree(child, signal) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // No group to address (spawn raced, or the leader is already reaped) —
    // fall back to the direct child so a kill is never silently skipped.
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function runWakeSession(bin, cliArgs, { repoRoot, name, maxRuntimeMs, warnAfterMs = 0, onSpawn }) {
  return new Promise((resolve) => {
    // A `.cmd` shim is not an executable image, so bare spawn() cannot run it — since the
    // CVE-2024-24576 fix (Node 18.20 / 20.12) that is a hard EINVAL rather than a silent success.
    // resolveHeadlessBin correctly detects that `claude` is `claude.cmd` on Windows and then handed
    // the name straight to spawn(), so every headless wake on a normal npm install died at launch.
    //
    // The fix is a cmd.exe layer built from an audited encoder (_win-argv.mjs), NOT `shell: true`:
    // the wake's argv carries prompt and charter text, and `shell: true` would put all of it through
    // a shell parse. cmdShimSpawn returns the pre-encoded line plus windowsVerbatimArguments so Node
    // does not re-quote what is already quoted.
    const launch = isCmdShim(bin)
      ? cmdShimSpawn([bin, ...cliArgs])
      : { command: bin, args: cliArgs, options: {} };
    const child = spawn(launch.command, launch.args, {
      ...launch.options,
      cwd: repoRoot,
      // Own process group so a max-runtime/stop kill reaps the shells the wake
      // spawned instead of orphaning them to pid 1 (see signalWakeTree). NOT
      // unref'd — the loop still awaits this child.
      detached: process.platform !== 'win32',
      // SIDEKICKS_DELEGATE_WAKE marks the session (and its hooks) as a
      // headless wake — load-local-memory-hook.mjs emits a compact memory
      // index instead of the full listing, and the interactive-only
      // UserPromptSubmit hooks (artifact-autotrigger, enhance-prompt,
      // fable-escalation) exit silently. SIDEKICKS_DELEGATE_AGENT names the
      // waking agent for anything downstream that needs it. Spread, don't
      // mutate process.env: the comms daemons this loop also spawns must
      // keep a clean env.
      env: { ...process.env, SIDEKICKS_DELEGATE_WAKE: '1', SIDEKICKS_DELEGATE_AGENT: name },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (onSpawn) onSpawn(child);
    let out = '';
    let errTail = '';
    let killed = false;
    let settled = false;

    child.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      if (out.length < STDOUT_CAP) out += s;
      process.stdout.write(s);
    });
    // stderr stays a byte-for-byte passthrough; the tail is kept ONLY so a wake
    // that died on a usage limit can be classified as such. Without it a quota
    // wall is indistinguishable from a bug and the lane runs the generic backoff
    // ladder into the ground. Bounded, so a chatty wake cannot grow this.
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      errTail = (errTail + s).slice(-STDERR_TAIL_CAP);
      process.stderr.write(chunk);
    });

    const killChild = () => {
      killed = true;
      signalWakeTree(child, 'SIGTERM');
      const hard = setTimeout(() => {
        signalWakeTree(child, 'SIGKILL');
      }, KILL_GRACE_MS);
      if (hard.unref) hard.unref();
    };

    const killTimer = setTimeout(killChild, maxRuntimeMs);
    // Honor `agent stop` while a wake is in flight — the control gate is the
    // one stop surface every session shape shares. The same ticker keeps the
    // comms daemons (telegram relay / LAN bridge) alive DURING a wake: idle
    // ticks stop while the loop awaits the child, and a wake can run for up
    // to max-runtime — the user must stay reachable the whole time.
    //
    // The same ticker is the LONG-WAKE WATCHDOG. A lane drains one wake at a
    // time, so wake LENGTH — not wake success — is the availability metric: an
    // unbounded command inside a wake is a lane outage, and max-runtime is the
    // only other guard (it once let a lane sit dead for 26 minutes while the
    // roster still read "offline", which reads as a dead runner rather than a
    // wedged one). Warning at a fraction of max-runtime makes a stall visible
    // in the log BEFORE the kill, and names the pid so it can be inspected.
    // This is deliberately NOT a per-adapter inactivity timeout: the claude
    // --print adapter emits output only at the end, so an idle timer would
    // falsely kill healthy wakes.
    const startedAt = Date.now();
    let warnedAt = 0;
    let commsAt = startedAt + COMMS_RECHECK_MS;
    const controlTimer = setInterval(() => {
      if (readControlStage(repoRoot, name) === 'stop') killChild();
      const elapsed = Date.now() - startedAt;
      if (warnAfterMs > 0 && elapsed >= warnAfterMs && elapsed - warnedAt >= warnAfterMs) {
        warnedAt = elapsed;
        process.stderr.write(
          `delegate: wake for '${name}' has run ${Math.round(elapsed / 1000)}s (pid ${child.pid || '?'})`
          + ` — the lane cannot claim anything until it exits; killed at ${Math.round(maxRuntimeMs / 1000)}s\n`
        );
      }
      if (Date.now() >= commsAt) {
        commsAt = Date.now() + COMMS_RECHECK_MS;
        for (const note of ensureCommsProcesses(repoRoot)) process.stderr.write(note + '\n');
      }
    }, 2000);

    const finish = (code, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearInterval(controlTimer);
      resolve(buildWakeOutcome({ stdout: out, stderrTail: errTail, code, killed, err }));
    };
    child.on('error', (err) => finish(null, err));
    child.on('exit', (code) => finish(code, null));
  });
}

/**
 * `SIDEKICKS_DELEGATE_NOW` pins the clock for deterministic pacemaker tests.
 * Honoured ONLY with --once: a long-running loop frozen in time would spin
 * forever re-evaluating the same instant. Same contract as the scheduler's
 * SIDEKICKS_SCHEDULER_NOW.
 */
export function resolveDelegateNow(env, once) {
  const raw = String(env.SIDEKICKS_DELEGATE_NOW || '').trim();
  if (!raw) return null;
  if (!once) {
    throw new SidekicksError(
      'agent delegate: SIDEKICKS_DELEGATE_NOW only applies with --once (a continuous loop cannot run with a frozen clock)',
      EXIT_VALIDATION
    );
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (m) {
    return bangkokWallToMs({ y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5] }) + (+(m[6] || 0)) * 1000;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new SidekicksError(
      `agent delegate: SIDEKICKS_DELEGATE_NOW '${raw}' is not a valid instant — use YYYY-MM-DDTHH:MM (Asia/Bangkok)`,
      EXIT_VALIDATION
    );
  }
  return parsed;
}

/**
 * Run `agent delegate`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = validateAgentName(args.name);
  const flags = parseMemoryFlags(ctx.argv, ['once', 'status', 'force', 'no-pacemaker']);
  // Keep full charter validation, except defer cli to resolveCharterCli below
  // so hand-edited values retain this command's contextual diagnostic.
  const charter = requireCharter(repoRoot, name, { deferCliValidation: true });

  const daemonName = `delegate-${name}`;
  const statePath = delegateStatePath(repoRoot, name);
  const logRel = relative(repoRoot, delegateLogPath(repoRoot, name)).replace(/\\/g, '/');

  // The pacemaker is OFF-only overridable from the command line: it can be
  // disabled for a debugging session, never tuned (the numbers live in config so
  // an edit takes effect live — see the header).
  const pacemakerDisabled = Boolean(flags['no-pacemaker'])
    || process.env.SIDEKICKS_DELEGATE_PACEMAKER === '0';

  if (flags.status) {
    const rec = readJsonFile(pidFilePath(repoRoot, daemonName));
    const running = isDaemonRunning(repoRoot, daemonName);
    const state = readJsonFile(statePath) || {};
    const nowMs = Date.now();
    const pmCfg = resolveAgentDaemonConfig(repoRoot, name);
    const pmState = readPacemakerState(repoRoot, name);
    const { request: pmRequest } = readSleepRequest(repoRoot, name, { nowMs });
    return {
      stdout: [
        `delegate: ${name}`,
        `running:  ${running && rec ? `yes (pid ${rec.pid})` : 'no'}`,
        `log:      ${logRel}`,
        `session:  ${state.session_id || '(none saved)'}`,
        `runs:     ${state.runs ?? 0}   consecutive failures: ${state.consecutive_failures ?? 0}   last run: ${state.last_run_at || '(never)'}`,
        `tokens:   last wake ${state.last_wake_tokens ?? '(unknown)'} input-side over ${state.last_wake_turns ?? '?'} turns`,
        `context:  ${state.last_context_tokens ?? '(unknown)'} resident (rotation compacts past --rotate-context)`,
        `cache:    ${state.last_cache_read_tokens ?? '(unknown)'} served from prompt cache last wake (high = resume+cache landing)`,
        ...formatPacemakerStatus(pmCfg, pmState, pmRequest, nowMs, { disabledByFlag: pacemakerDisabled }),
        '',
      ].join('\n'),
      exitCode: EXIT_OK,
    };
  }

  if (charter.status === 'retired') {
    throw new SidekicksError(
      `agent delegate: agent '${name}' is retired — retired agents do not come online`,
      EXIT_VALIDATION
    );
  }

  // Standing policy: ONE delegate — the user-facing ORCHESTRATOR only. A
  // delegate per specialist multiplies per-assignment wake bootstraps (each
  // wake re-pays the full session bootstrap in tokens) for zero standby gain
  // (idle delegates are free either way). Specialists are reached as the
  // orchestrator's session subagents, or brought online on demand
  // (`agent start <name> --spawn`, which needs a GUI session — inside a
  // delegate wake there is none, so a specialist unit belongs to a session
  // subagent or a deliberate --force here). --force overrides deliberately.
  if ((charter.role || 'worker') !== 'orchestrator' && !flags.force) {
    throw new SidekicksError(
      `agent delegate: '${name}' is a worker charter — the standing policy is one delegate for the user-facing orchestrator only; specialists are reached as the orchestrator's session subagents or brought online on demand ('sidekicks agent start ${name} --spawn', which needs a GUI session — from a headless wake use a session subagent, or '--headless --force' deliberately). Override deliberately with --force.`,
      EXIT_VALIDATION
    );
  }

  // Validated, not trusted: a hand-edited charter cli reached
  // buildHeadlessCommand below and failed as "no headless adapter yet", which
  // is the wrong diagnosis for a value that is not a cli name at all.
  const cliName = resolveCharterCli(charter, name, 'agent delegate');
  let primaryBinding;
  try {
    const { bindDeclaration } = await import('./daemon.mjs');
    primaryBinding = await bindDeclaration(repoRoot, name);
  } catch (err) {
    throw new SidekicksError(
      `agent delegate: primary declaration readiness failed: ${err.message}. Correct with 'node bin/sidekicks agent daemon reconcile ${name}'`,
      EXIT_VALIDATION
    );
  }
  const modelSpec = (flags.model != null ? String(flags.model) : (charter.model || '')).trim();
  const modelInfo = resolveModel(modelSpec, cliName);
  const permissionMode = String(
    flags['permission-mode'] || charter.headless_permission_mode || DEFAULT_PERMISSION_MODE
  );
  const intervalMs = numberFlag(flags, 'interval', DEFAULT_INTERVAL_S) * 1000;
  const maxRuntimeMs = numberFlag(flags, 'max-runtime', DEFAULT_MAX_RUNTIME_S) * 1000;
  const rotateAfter = numberFlag(flags, 'rotate-after', DEFAULT_ROTATE_AFTER);
  // --rotate-context is the flag; --rotate-tokens is kept as a deprecated alias
  // so existing scripts and the `--rotate-tokens 0` disable idiom keep working.
  // Note the SEMANTICS changed with the metric (resident context, not
  // cumulative wake spend) — a script passing the old 400000 gets a 400k
  // resident-context threshold, which is looser, not tighter.
  const rotateContext = flags['rotate-context'] != null && flags['rotate-context'] !== ''
    ? numberFlag(flags, 'rotate-context', DEFAULT_ROTATE_CONTEXT, { allowZero: true })
    : numberFlag(flags, 'rotate-tokens', DEFAULT_ROTATE_CONTEXT, { allowZero: true });
  const requeueLimit = numberFlag(flags, 'requeue-limit', DEFAULT_REQUEUE_LIMIT);
  const settleMs = numberFlag(flags, 'settle', DEFAULT_SETTLE_S, { allowZero: true }) * 1000;
  // Debugging escape hatch: --full-context restores the pre-lean claude wake
  // (all setting sources, MCP servers, dynamic system-prompt sections). The
  // codex/antigravity adapters ignore it — the lean flags are claude-only.
  const fullContext = Boolean(flags['full-context']);
  const handoffRel = relative(repoRoot, handoffPath(repoRoot, name)).replace(/\\/g, '/');
  // Validate the adapter up front (throws for a cli with no headless row, and
  // for a permission mode that cli cannot honor) — the loop rebuilds per-wake
  // with the live resume id and fresh/resume prompt.
  buildHeadlessCommand({
    cliName, prompt: delegatePrompt(name), model: null, permissionMode, resume: null, maxRuntimeMs, fullContext,
  });

  // `agent start --headless` stamps a provisional pid file with the pid of the
  // delegate child it just spawned — i.e. THIS process. A pid file naming
  // ourselves is that stamp, not a rival delegate; only a live FOREIGN pid
  // means one is already running.
  const existingRec = readJsonFile(pidFilePath(repoRoot, daemonName));
  if (existingRec && existingRec.pid !== process.pid && isProcessAlive(existingRec.pid)) {
    throw new SidekicksError(
      `agent delegate: a delegate for '${name}' is already running (pid ${existingRec.pid}) — stop it with 'sidekicks agent stop ${name}'`,
      EXIT_VALIDATION
    );
  }

  const session = `dlg-${process.pid}-${Date.now()}`;

  // One agent, one live session: yield to an interactively started agent.
  const initialPresence = readPresence(repoRoot, name);
  if (isForeignLiveSession(initialPresence, session)) {
    return {
      stdout: `delegate: '${name}' is owned by live session ${initialPresence.session_id} — not starting\n`,
      exitCode: EXIT_AGENT_FOREIGN_SESSION,
    };
  }

  ensureRuntimeTree(repoRoot, name);

  // Atomically claim the pid file — the check above is only a fast-fail; two
  // delegates racing from different terminals can both pass it (TOCTOU), so
  // the exclusive create here is what actually guarantees one runner.
  const claim = acquirePidFile(repoRoot, daemonName, process.pid);
  if (!claim.ok) {
    throw new SidekicksError(
      `agent delegate: a delegate for '${name}' is already running${claim.pid ? ` (pid ${claim.pid})` : ''} — stop it with 'sidekicks agent stop ${name}'`,
      EXIT_VALIDATION
    );
  }

  const noExec = Boolean(process.env.SIDEKICKS_DELEGATE_NO_EXEC);
  const once = Boolean(flags.once);
  // NO_SEND rehearses the pacemaker without touching the mailbox or the state
  // file. NO_EXEC deliberately does NOT suppress injection — it means "spawn no
  // CLI", and the pacemaker spawns nothing, which is what makes the whole
  // mechanism testable end to end with zero model runs.
  const pacemakerNoSend = Boolean(process.env.SIDEKICKS_DELEGATE_NO_SEND);
  const pinnedNow = resolveDelegateNow(process.env, once);
  const processStartMs = pinnedNow ?? Date.now();
  // Skip-log suppression state: in-process only, so a quiet lane costs no writes.
  let lastPacemakerSkip = null;
  let lastPacemakerLogMs = 0;
  let stopRequested = false;
  let liveChild = null;

  const cleanup = () => {
    // Only remove the pid file WE own — when this process exits because a
    // rival delegate took the file over, deleting it would unlock the rival.
    const pidRec = readJsonFile(pidFilePath(repoRoot, daemonName));
    if (pidRec && pidRec.pid === process.pid) {
      try { rmSync(pidFilePath(repoRoot, daemonName), { force: true }); } catch { /* best-effort */ }
    }
    // Only clear presence WE own — never wipe another session's heartbeat.
    const p = readPresence(repoRoot, name);
    if (p && p.session_id === session) {
      try { rmSync(presencePath(repoRoot, name), { force: true }); } catch { /* best-effort */ }
    }
  };

  const onSignal = () => {
    stopRequested = true;
    // Tree kill, not a bare child.kill: a shutting-down delegate must not leave
    // the wake's shells behind to grind against the next generation's wakes.
    if (liveChild) signalWakeTree(liveChild, 'SIGTERM');
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  process.stdout.write(
    `delegate: '${name}' online (session ${session}, cli ${cliName}, model ${modelInfo ? modelInfo.resolved : '(cli default)'}, permission mode ${permissionMode}) — stop with 'sidekicks agent stop ${name}'\n`
  );

  // Fresh process generation → clean failure slate. The loop exits after
  // MAX_CONSECUTIVE_FAILURES "for the supervisor to restart"; if the restarted
  // process inherited a saturated counter it would re-exit on its very first
  // failed wake (no backoff before the exit check), hot-looping under any
  // supervisor. Reset the counter on startup so each generation gets the full
  // failure budget. session_id / runs are preserved for wake continuity.
  {
    const s = readJsonFile(statePath);
    if (s && Number.isInteger(s.consecutive_failures) && s.consecutive_failures > 0) {
      writeJsonFile(repoRoot, statePath, { ...s, consecutive_failures: 0 });
    }
  }

  try {
    for (;;) {
      // 1. Foreign live session → yield (an interactive agent wins the mailbox).
      const presence = readPresence(repoRoot, name);
      if (isForeignLiveSession(presence, session)) {
        return {
          stdout: `delegate: '${name}' is owned by live session ${presence.session_id} — shutting down\n`,
          exitCode: EXIT_AGENT_FOREIGN_SESSION,
        };
      }

      // 2. Own the presence while idle.
      writePresence(repoRoot, name, {
        session_id: session,
        state: 'standby',
        task: null,
        heartbeat_at: bangkokTimestamp(),
      });

      // 3. Keep the comms daemons (telegram relay / LAN bridge) alive.
      for (const note of ensureCommsProcesses(repoRoot)) process.stderr.write(note + '\n');

      // 4. Control gate.
      const stage = readControlStage(repoRoot, name);
      if (stage === 'stop' || stopRequested) {
        return { stdout: 'delegate: control stop — shutting down\n', exitCode: EXIT_OK };
      }

      // 4b. Pid-file ownership. If a rival delegate (another terminal/app, or
      // a later `agent start --headless`) now owns the file, the FILE decides
      // the winner: this process yields, so any interleaving converges to one
      // runner within a tick. A missing file (removed by hand) is re-stamped.
      const pidOwner = readJsonFile(pidFilePath(repoRoot, daemonName));
      if (pidOwner && pidOwner.pid !== process.pid && isProcessAlive(pidOwner.pid)) {
        return {
          stdout: `delegate: pid file for '${name}' is owned by live pid ${pidOwner.pid} — shutting down\n`,
          exitCode: EXIT_AGENT_FOREIGN_SESSION,
        };
      }
      if (!pidOwner || pidOwner.pid !== process.pid) {
        writePidFile(repoRoot, daemonName, process.pid);
      }

      // 4c. Crash recovery: claims left behind by a dead wake session (killed
      // at max-runtime, crashed CLI, reboot) go back to inbox/new so the
      // interrupted assignment is retried, not stranded — the loop only
      // wakes on new/, so without this the work would be silently lost.
      // Safe here because step 1 already yielded to any live foreign session.
      const recovered = requeueOrphanedClaims(repoRoot, name, requeueLimit);
      for (const id of recovered.requeued) {
        process.stdout.write(`delegate: requeued orphaned claim ${id} → inbox/new (interrupted wake will be retried)\n`);
      }
      for (const id of recovered.failedOut) {
        process.stderr.write(`delegate: ${id} failed out after ${requeueLimit} interrupted wakes — sender notified via auto-reply\n`);
      }

      // 4d. QUOTA PAUSE. The wait lives HERE, in the idle tick, and never inside
      // a wake: a lane drains one wake at a time, so blocking inside one is a lane
      // outage. Copied from the only wall-clock-aware pattern in the repo (the
      // routine scheduler's): persist the instant, poll and compare — no timer, so
      // it survives a crash and composes with `agent stop`.
      //
      // While paused the lane wakes for NOTHING, including chat: a quota'd CLI
      // cannot run at all. The mailbox is durable and the relay still acks inbound,
      // so work simply waits.
      {
        const qNow = pinnedNow ?? Date.now();
        const pmState = readPacemakerState(repoRoot, name);
        if (quotaPauseActive(pmState.quota, qNow)) {
          const reason = `quota pause until ${pmState.quota.resume_at || bangkokStamp(pmState.quota.resume_at_ms)}`;
          const heartbeatMs = resolveAgentDaemonConfig(repoRoot, name).log_heartbeat_minutes * 60_000;
          const dueHeartbeat = heartbeatMs > 0 && qNow - lastPacemakerLogMs >= heartbeatMs;
          if (reason !== lastPacemakerSkip || dueHeartbeat) {
            process.stdout.write(`delegate: ${reason} — not waking for anything until then (${pmState.quota.cli || cliName} usage limit)\n`);
            lastPacemakerSkip = reason;
            lastPacemakerLogMs = qNow;
          }
          if (once) return { stdout: `delegate: ${reason}\n`, exitCode: EXIT_OK };
          await sleep(intervalMs);
          continue;
        }
        if (pmState.quota) {
          // The instant passed: clear the marker once and say so, then fall
          // through — the requeued message is still in new/, so this same tick
          // picks it up.
          writePacemakerState(repoRoot, name, { quota: null });
          lastPacemakerSkip = null;
          process.stdout.write(`delegate: quota window passed — resuming '${name}'\n`);
        }
      }

      // 5. Work available (unless paused — paused idles without waking).
      let pendingBeforeIds = stage === 'pause' ? [] : listMessageIds(repoRoot, name, 'new');
      // 5a. Burst batching: settle briefly and re-count so ONE wake (one
      // session-bootstrap token spend) drains a rapid burst of messages
      // instead of a wake per message. --settle 0 disables; dry-run skips.
      if (pendingBeforeIds.length > 0 && settleMs > 0 && !noExec) {
        const until = Date.now() + settleMs;
        while (Date.now() < until && !stopRequested && readControlStage(repoRoot, name) !== 'stop') {
          await sleep(Math.min(500, until - Date.now()));
        }
        if (stopRequested || readControlStage(repoRoot, name) === 'stop') {
          return { stdout: 'delegate: control stop — shutting down\n', exitCode: EXIT_OK };
        }
        pendingBeforeIds = listMessageIds(repoRoot, name, 'new');
      }
      if (pendingBeforeIds.length > 0) {
        const pendingBefore = pendingBeforeIds.length;
        let state = readJsonFile(statePath) || {};
        const fresh = shouldRotateSession(state, rotateAfter, rotateContext);
        const resume = fresh ? null : state.session_id;
        // Rotation with a live saved session compacts it first: one bounded
        // handoff wake resumes the outgoing session so it can write its
        // context brief before the fresh session takes over.
        const outgoing = fresh && state.session_id ? state.session_id : null;
        // Conversation memory: prime the wake with the transcript block. This is
        // what makes a chat continue across wakes AND across a rotation — the
        // session is an optimization, the recorded conversation is the mechanism.
        const convBlock = wakeContextBlock(repoRoot, name);
        // Fleet lessons: the distilled cross-agent rules ride every wake too —
        // same best-effort contract ('' when the journal is off or empty).
        const lessonsBlock = fleetLessonsBlock(repoRoot);
        // Cite the handoff brief only when one is really there. `outgoing` is
        // about to write it for a rotation; otherwise an existing file is a
        // brief an earlier rotation left behind. With neither, there is nothing
        // to read and the carry-over sentence is dropped.
        const briefAvailable = Boolean(outgoing) || existsSync(handoffPath(repoRoot, name));
        const basePrompt = delegatePrompt(name, {
          fresh,
          handoffRel: briefAvailable ? handoffRel : null,
        }) + `\n\n${composePrimaryPrompt(charter, primaryBinding)}`;
        // The dry-run view ELIDES the blocks: they can be kilobytes of
        // multi-line text, and three tests grep this output for the prompt's
        // own phrases. The markers keep it inspectable without drowning it.
        const fmtCmd = (b, a) => `${b} ${a
          .map((x) => {
            let s = x;
            if (convBlock && s.includes(convBlock)) {
              s = s.replace(convBlock, `<conversation context: ${Buffer.byteLength(convBlock, 'utf8')} bytes elided — see: node bin/sidekicks agent thread context ${name}>`);
            }
            if (lessonsBlock && s.includes(lessonsBlock)) {
              s = s.replace(lessonsBlock, `<fleet lessons: ${Buffer.byteLength(lessonsBlock, 'utf8')} bytes elided — see: node bin/sidekicks journal lesson list>`);
            }
            return s !== x || s.includes(' ') ? `'${s}'` : s;
          })
          .join(' ')}`;
        const { bin, args: cliArgs } = buildHeadlessCommand({
          cliName,
          prompt: basePrompt
            + (convBlock ? `\n\n${convBlock}` : '')
            + (lessonsBlock ? `\n\n${lessonsBlock}` : ''),
          model: modelInfo ? modelInfo.resolved : null,
          permissionMode,
          resume,
          maxRuntimeMs,
          fullContext,
        });
        const handoffCmd = outgoing
          ? buildHeadlessCommand({
            cliName,
            prompt: handoffPrompt(name, handoffRel),
            model: modelInfo ? modelInfo.resolved : null,
            permissionMode,
            resume: outgoing,
            maxRuntimeMs: HANDOFF_MAX_RUNTIME_MS,
            fullContext,
          })
          : null;

        if (noExec) {
          const lines = [];
          if (handoffCmd) {
            lines.push(
              `[SIDEKICKS_DELEGATE_NO_EXEC] would first compact '${name}' — handoff wake resuming ${outgoing}:`,
              '',
              `  ${fmtCmd(handoffCmd.bin, handoffCmd.args)}`,
              ''
            );
          }
          lines.push(
            `[SIDEKICKS_DELEGATE_NO_EXEC] would wake '${name}' with (cwd ${repoRoot}, env SIDEKICKS_DELEGATE_WAKE=1 SIDEKICKS_DELEGATE_AGENT=${name}):`,
            '',
            `  ${fmtCmd(bin, cliArgs)}`,
            ''
          );
          return { stdout: lines.join('\n'), exitCode: EXIT_OK };
        }

        if (handoffCmd) {
          const why = (Number.isInteger(state.runs) ? state.runs : 0) >= rotateAfter
            ? `${state.runs} run(s) served`
            : `resident context ${state.last_context_tokens ?? state.last_wake_tokens} tokens (>= ${rotateContext})`;
          process.stdout.write(
            `delegate: rotating session ${outgoing} (${why}) — compaction handoff wake first\n`
          );
          const h = await runWakeSession(resolveHeadlessBin(handoffCmd.bin), handoffCmd.args, {
            repoRoot,
            name,
            maxRuntimeMs: HANDOFF_MAX_RUNTIME_MS,
            onSpawn: (child) => { liveChild = child; },
          });
          liveChild = null;
          const briefLanded = existsSync(handoffPath(repoRoot, name));
          process.stdout.write(
            h.ok && briefLanded
              ? `delegate: handoff brief compacted → ${handoffRel}\n`
              : `delegate: handoff wake ${h.ok ? 'wrote no brief' : 'did not complete'} (best-effort — rotating anyway${briefLanded ? ', an older brief remains' : ''})\n`
          );
          // Commit the rotation NOW (session cleared, run counter reset) so a
          // crash between here and the work wake can never re-run the handoff
          // against the same retired session.
          state = { ...state, session_id: null, runs: 0 };
          writeJsonFile(repoRoot, statePath, { ...state, last_run_at: state.last_run_at || null });
          if (stopRequested || readControlStage(repoRoot, name) === 'stop') {
            return { stdout: 'delegate: control stop — shutting down\n', exitCode: EXIT_OK };
          }
        }

        process.stdout.write(
          `delegate: waking '${name}' — ${pendingBefore} message(s) in inbox/new (${resume ? `resume ${resume}` : 'fresh session'})\n`
        );
        // Release presence: the wake session's master skill owns it while it runs.
        try { rmSync(presencePath(repoRoot, name), { force: true }); } catch { /* best-effort */ }

        const outcome = await runWakeSession(resolveHeadlessBin(bin), cliArgs, {
          repoRoot,
          name,
          maxRuntimeMs,
          // Config is re-read per wake, so raising or lowering the watchdog takes
          // effect on the next one without a restart.
          warnAfterMs: resolveAgentDaemonConfig(repoRoot, name).wake_warn_after_seconds * 1000,
          onSpawn: (child) => { liveChild = child; },
        });
        liveChild = null;

        // Reclaim presence (the child is gone; its last heartbeat is history).
        writePresence(repoRoot, name, {
          session_id: session,
          state: 'standby',
          task: null,
          heartbeat_at: bangkokTimestamp(),
        });

        if (stopRequested || readControlStage(repoRoot, name) === 'stop') {
          return { stdout: 'delegate: control stop — shutting down\n', exitCode: EXIT_OK };
        }

        // Progress is measured by IDENTITY, not count: a message that arrived
        // mid-wake (routine scheduler, relay) must not mask the drain of the
        // work this wake was actually started for. See computeProgress.
        const pendingAfterIds = listMessageIds(repoRoot, name, 'new');
        const pendingAfter = pendingAfterIds.length;
        const { progressed, drained } = computeProgress(pendingBeforeIds, pendingAfterIds);

        // A usage limit is NOT a failure. Without this it lands in the generic
        // ladder — 30/60/120/240/300s then exit 1 at ~12.5 minutes — while the
        // claimed message requeues three times and is failed out to the user with
        // "the work kept dying mid-run". The work never ran at all.
        if (!outcome.ok) {
          const qcfg = resolveAgentDaemonConfig(repoRoot, name).quota;
          const verdict = classifyWakeStall({
            cliName,
            outcome,
            stdout: outcome.stdout,
            stderrTail: outcome.stderrTail,
            cfg: qcfg,
            nowMs: Date.now(),
          });
          if (verdict.quota) {
            // Give the message back WITHOUT spending one of its requeue attempts.
            const back = requeueOrphanedClaims(repoRoot, name, requeueLimit, { countAttempt: false });
            writePacemakerState(repoRoot, name, {
              quota: {
                since: bangkokTimestamp(),
                resume_at: bangkokStamp(verdict.resumeAtMs),
                resume_at_ms: verdict.resumeAtMs,
                evidence: verdict.evidence,
                cli: cliName,
                source: verdict.source,
                pattern: verdict.pattern,
              },
            });
            markWakeEnd(repoRoot, name, Date.now());
            process.stderr.write(
              `delegate: ${cliName} usage limit — pausing until ${bangkokStamp(verdict.resumeAtMs)}`
              + ` (${verdict.source === 'fallback' ? 'no reset instant reported, using the configured cooldown' : 'reset instant reported by the CLI'})`
              + `${back.requeued.length ? `, requeued ${back.requeued.join(', ')} without counting an attempt` : ''}\n`
            );
            // The RAW matched line, every time: this repo has never captured a
            // real usage-limit event, so this log is what confirms or corrects the
            // pattern. Never swallow it.
            process.stderr.write(`delegate: quota evidence [${verdict.pattern}] ${verdict.evidence}\n`);
            if (qcfg.notify) await notifyQuotaPause(repoRoot, name, verdict, cliName);
            if (once) {
              return { stdout: `delegate: usage limit — paused until ${bangkokStamp(verdict.resumeAtMs)}\n`, exitCode: EXIT_OK };
            }
            continue;
          }
        }

        if (outcome.ok && progressed) {
          writeJsonFile(repoRoot, statePath, {
            session_id: nextSessionId(outcome, resume, state.session_id || null),
            runs: fresh ? 1 : (Number.isInteger(state.runs) ? state.runs : 0) + 1,
            last_run_at: bangkokTimestamp(),
            last_wake_tokens: outcome.wakeTokens ?? null,
            last_wake_turns: outcome.turns ?? null,
            last_context_tokens: outcome.contextTokens ?? null,
            last_cache_read_tokens: outcome.cacheReadTokens ?? null,
            consecutive_failures: 0,
          });
          process.stdout.write(
            `delegate: wake done — drained ${drained.length}/${pendingBefore}, inbox/new ${pendingBefore} → ${pendingAfter}\n`
          );
        } else {
          const failures = (Number.isInteger(state.consecutive_failures) ? state.consecutive_failures : 0) + 1;
          const why = outcome.killed
            ? `killed after max-runtime/stop`
            : outcome.error
              ? `spawn error: ${outcome.error}`
              : outcome.ok
                ? `no progress (0 of ${pendingBefore} drained; inbox/new now ${pendingAfter})`
                : `exit code ${outcome.code}`;
          // A failed RESUMED run drops the saved session (retry fresh next
          // wake; a dead or bloated session must never wedge the loop) —
          // EXCEPT a max-runtime kill, which keeps it: the on-disk session
          // survives the SIGTERM with its mid-run context, so the next wake
          // resumes and CONTINUES the interrupted assignment (the requeued
          // message re-fires the wake) instead of restarting from scratch.
          writeJsonFile(repoRoot, statePath, {
            session_id: outcome.ok
              ? (outcome.sessionId || state.session_id || null)
              : nextSessionId(outcome, resume, state.session_id || null),
            runs: Number.isInteger(state.runs) ? state.runs : 0,
            last_run_at: bangkokTimestamp(),
            last_wake_tokens: outcome.wakeTokens
              ?? (Number.isInteger(state.last_wake_tokens) ? state.last_wake_tokens : null),
            last_wake_turns: outcome.turns
              ?? (Number.isInteger(state.last_wake_turns) ? state.last_wake_turns : null),
            last_context_tokens: outcome.contextTokens
              ?? (Number.isInteger(state.last_context_tokens) ? state.last_context_tokens : null),
            consecutive_failures: failures,
          });
          process.stderr.write(`delegate: wake failed (${why}) — failure ${failures}/${MAX_CONSECUTIVE_FAILURES}\n`);
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            return {
              stdout: `delegate: ${MAX_CONSECUTIVE_FAILURES} consecutive failed wakes — exiting for the supervisor to restart\n`,
              exitCode: 1,
            };
          }
          if (!once) {
            const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
            process.stderr.write(`delegate: backing off ${Math.round(backoffMs / 1000)}s\n`);
            // Sleep in short slices so a control stop still lands promptly.
            const until = Date.now() + backoffMs;
            while (Date.now() < until && !stopRequested && readControlStage(repoRoot, name) !== 'stop') {
              await sleep(Math.min(1000, until - Date.now()));
            }
          }
        }

        // The pacemaker's budget is measured from the END of a wake, so the lane
        // rests a real interval after finishing rather than at an appointment it
        // cannot see. EVERY wake stamps it, including a failed one — that is what
        // stops a failing wake from being re-ticked immediately. The early
        // returns above (control stop, five-failure exit) skip it deliberately:
        // the process is leaving.
        markWakeEnd(repoRoot, name, Date.now());

        if (once) {
          return { stdout: 'delegate: single pass done\n', exitCode: EXIT_OK };
        }
        continue;
      }

      // 5b. PACEMAKER — the lane's own clock. This is the only point in the loop
      // that means "the mailbox is empty and this tick has nothing to do", and
      // every precondition the decision needs was established above: the foreign
      // session yield, presence ownership, comms, the control stage, pid-file
      // ownership and the orphan requeue.
      {
        const nowMs = pinnedNow ?? Date.now();
        const pmCfg = resolveAgentDaemonConfig(repoRoot, name);
        const pmState = readPacemakerState(repoRoot, name);
        const { request: pmRequest, warning: pmWarning } = readSleepRequest(repoRoot, name, { nowMs });
        const dstate = readJsonFile(statePath) || {};
        const decision = pacemakerDecision({
          cfg: pmCfg,
          nowMs,
          state: pmState,
          request: pmRequest,
          processStartMs,
          controlStage: stage,
          stopRequested,
          disabledByFlag: pacemakerDisabled,
          inboxNew: pendingBeforeIds.length,
          inboxClaimed: listMessageIds(repoRoot, name, 'claimed').length,
          consecutiveFailures: Number.isInteger(dstate.consecutive_failures) ? dstate.consecutive_failures : 0,
        });

        // Stamp the instant the decision was EVALUATED, not wall-clock-now: under
        // a pinned clock those differ, and a rehearsal has to be reproducible.
        const stamp = () => bangkokStamp(nowMs);
        if (pmWarning && lastPacemakerSkip !== `warn:${pmWarning}`) {
          process.stderr.write(`delegate: pacemaker ignoring the sleep request at ${stamp()} — ${pmWarning}; using the config default\n`);
        }
        for (const w of decision.warnings || []) {
          process.stdout.write(`delegate: pacemaker ${w} at ${stamp()}\n`);
        }
        if (decision.clockWentBackwards) {
          process.stderr.write(`delegate: pacemaker clock moved backwards at ${stamp()} — baseline reset\n`);
        }

        if (decision.action === 'inject') {
          const res = await injectPacemakerTick(repoRoot, name, pmCfg, {
            nowMs,
            noSend: pacemakerNoSend,
            sleepSeconds: decision.sleepSeconds,
            source: decision.source,
            requestedAtMs: decision.request ? decision.request.requested_at_ms : null,
          });
          lastPacemakerSkip = null;
          if (res.dryRun) {
            process.stdout.write(
              `delegate: [pacemaker dry-run] would inject at ${stamp()} — rested ${decision.sleepSeconds}s`
              + ` (source ${decision.source}), payload ${JSON.stringify(res.payload)}\n`
            );
          } else if (res.ok) {
            process.stdout.write(
              `delegate: pacemaker tick injected ${res.messageId || '(no id)'} at ${stamp()}`
              + ` — rested ${decision.sleepSeconds}s (source ${decision.source})\n`
            );
          } else {
            process.stderr.write(`delegate: pacemaker injection refused at ${stamp()} — ${res.error}\n`);
          }
          if (once) {
            return {
              stdout: res.ok
                ? `delegate: pacemaker tick ${res.dryRun ? 'rehearsed' : `injected (${res.messageId || 'no id'})`}\n`
                : `delegate: pacemaker injection failed — ${res.error}\n`,
              exitCode: EXIT_OK,
            };
          }
          // The very next iteration sees a non-empty inbox/new and wakes on it:
          // one loop, one waker, no second code path.
          continue;
        }

        // Rate-limited skip logging: print when the REASON changes, plus one
        // heartbeat per log_heartbeat_minutes. A 2s tick logging unconditionally
        // writes ~43k lines a day into a file an operator is expected to tail.
        const heartbeatMs = pmCfg.log_heartbeat_minutes * 60_000;
        const dueHeartbeat = heartbeatMs > 0 && nowMs - lastPacemakerLogMs >= heartbeatMs;
        if (decision.reason !== lastPacemakerSkip || dueHeartbeat) {
          process.stdout.write(`delegate: pacemaker idle at ${stamp()} — ${decision.reason}\n`);
          lastPacemakerSkip = decision.reason;
          lastPacemakerLogMs = nowMs;
        }
      }

      if (once) {
        return { stdout: 'delegate: nothing to do\n', exitCode: EXIT_OK };
      }
      await sleep(intervalMs);
    }
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    cleanup();
  }
}
