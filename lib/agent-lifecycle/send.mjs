// lib/agent-lifecycle/send.mjs
// `sidekicks agent send <to> --from <n> [--kind task|reply|signal] [--category <c>]
//    [--priority <n>] [--goal <g>] [--acceptance "a;b"] [--options "a;b"]
//    [--work-dir <path>] [--isolation worktree|shared] [--reply-to <id>]
//    [--body-file <path>] [--origin <claimed-msg-id>|none] [--json]`
//
// Drop one message into the recipient's inbox/new/. Validation happens HERE,
// at the single mediated write point: the recipient must exist, a `task` must
// target an active agent AND carry a category the recipient's charter claims.
// Persisted paths (work_dir, body_file) are stored repo-relative.
//
// Cycle guard (kind=task only): every message carries `hops` (task-hop depth)
// and `chain` (upstream task senders, "agent/msg-id"). The origin — the
// claimed message the sender is executing right now — is named with
// --origin <id>, auto-inferred when the sender holds exactly one claimed
// message, or suppressed with --origin none (the deliberate fresh-chain
// escape hatch). A task is refused when it targets the sender itself, when
// the recipient already appears upstream in the chain (A→B→A ping-pong —
// results route back via `agent complete`, not a counter-task), or when the
// chain reaches MAX_TASK_HOPS (a runaway delegation loop).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, join } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { isInside } from '../fs-safety/canonical-path.mjs';
import {
  parseMemoryFlags,
  bangkokTimestamp,
  validateAgentName,
  requireCharter,
  ensureRuntimeTree,
  newMessageId,
  writeMessage,
  readMessage,
  listMessageIds,
  MSG_KINDS,
  MAX_TASK_HOPS,
  toRepoRel,
} from './_shared.mjs';
import { isThreadId } from './_threads.mjs';

const ISOLATIONS = ['worktree', 'shared'];

/**
 * Normalize a user-supplied path to repo-relative (portable-artifact rule) and CONTAIN it:
 * absolute or relative, the path must resolve inside the repository, or it is rejected.
 *
 * Relative input used to be returned unchecked, which meant the containment this function
 * exists to enforce applied to exactly half its inputs: `/etc/hosts` was refused while
 * `../../../../etc/hosts` — the same file — was accepted and persisted. The LAN bridge
 * forwards `body_file` and `work_dir` straight here from an authenticated request, and the
 * standby contract tells the recipient agent to read `body_file`, so a bearer-token holder
 * could aim an agent at any file the user could read. Both forms are resolved first now, and
 * the check is the same one for both.
 *
 * Containment is TWO gates, because neither one alone is sufficient and each catches what the
 * other cannot — see the comments on each below. The lexical gate guards the string that is
 * actually persisted; the realpath gate (isInside(), lib/fs-safety/canonical-path.mjs — symlink
 * and junction resolving, case-folded on Windows) guards where that string really points.
 *
 * Exported so every verb that persists a caller-supplied path (`agent routine` stores a
 * command-sequence path in committed yaml) enforces the SAME contract instead of
 * reimplementing it. `verb` only shapes the error prefix.
 */
export function toPortablePath(repoRoot, value, flagName, verb = 'agent send') {
  const raw = String(value);
  const refuse = (why) => {
    throw new SidekicksError(
      `${verb}: ${flagName} '${raw}' ${why} — persisted paths must be repo-relative`,
      EXIT_VALIDATION
    );
  };

  // Separators are normalized BEFORE anything else, never after. Normalizing afterwards meant
  // the string that was checked and the string that was persisted could differ: on POSIX
  // `..\..\..\etc\hosts` is one odd filename INSIDE the repo, so it passed, and the trailing
  // `\`→`/` rewrite then persisted `../../../etc/hosts`, which escapes the moment anything
  // resolves it. A path component carrying a backslash is either a Windows path or a name no
  // unit is called; either way it must mean the same thing on both platforms.
  const normalized = raw.replace(/\\/g, '/');
  const abs = isAbsolute(normalized) ? normalized : resolve(repoRoot, normalized);

  // GATE 1 — lexical. This is the containment the RETURN VALUE promises, so it is asserted on
  // the very string that gets persisted. Checking only the realpath was not equivalent: a link
  // from outside the repo pointing back INTO it resolves inside, passes, and then yields
  // `../shortcut/docs/a.md` — a machine-specific path that escapes on any other clone. It is
  // also the whole defence against `../../../../etc/hosts`, which needs no symlink at all.
  const rel = relative(repoRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) refuse('is outside the repository');

  // GATE 2 — realpath. Catches what gate 1 cannot see: a symlink INSIDE the repo aimed out of
  // the tree, where the lexical form is innocent and only the resolved one escapes.
  //
  // The one sanctioned escape is a LINKED PROJECT (`sidekicks project link <path>`), which is a
  // supported layout in this repo — `projects/<name>` is a symlink to another volume, so every
  // path under it resolves outside by design. Refusing those would have broken `agent send
  // --work-dir projects/<linked>` and `agent routine --sequence projects/<linked>/…` the moment
  // the volume was mounted: green in CI, broken on the machine that actually has the drive.
  if (!isInside(abs, repoRoot) && !isUnderLinkedProject(repoRoot, rel)) {
    refuse('resolves outside the repository through a symlink');
  }

  return (rel === '' ? '.' : rel).replace(/\\/g, '/');
}

/**
 * Is `rel` inside a project whose own ROOT resolves outside the repo (a linked / external one)?
 *
 * The test is "where does `projects/<name>` actually resolve", not "is it a symlink". Asking the
 * link TYPE would answer differently per platform: `sidekicks project link` creates a POSIX
 * symlink on macOS and an NTFS junction on Windows (lib/fs-safety/fsx.mjs createDirLink), and a
 * junction does not necessarily report `isSymbolicLink()`. That would have refused a linked
 * project on Windows while allowing the identical layout on macOS — a Rule 6 divergence, and the
 * kind that only shows up on the machine that has the drive.
 *
 * Deliberately narrow: only the `projects/<name>` level may resolve out. A link DEEPER than that
 * still resolves out while its own project root resolves in, so it stays refused — this must not
 * become a way to launder the escape gate 2 exists to catch.
 *
 * @param {string} repoRoot
 * @param {string} rel - already known to be lexically inside the repo
 */
function isUnderLinkedProject(repoRoot, rel) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2 || parts[0] !== 'projects') return false;
  const projectRoot = join(repoRoot, 'projects', parts[1]);
  return existsSync(projectRoot) && !isInside(projectRoot, repoRoot);
}

/**
 * Run `agent send`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args - args.name is the RECIPIENT.
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const to = validateAgentName(args.name);
  const flags = parseMemoryFlags(ctx.argv, ['json']);

  const from = flags.from ? validateAgentName(String(flags.from)) : null;
  if (!from) {
    throw new SidekicksError('agent send: --from <agent> is required (reply routing needs a sender)', EXIT_VALIDATION);
  }

  const kind = flags.kind ? String(flags.kind) : 'task';
  if (!MSG_KINDS.includes(kind)) {
    throw new SidekicksError(
      `agent send: invalid --kind '${kind}' — one of: ${MSG_KINDS.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  // A signal is pure content — the note IS the message. One with no --goal,
  // --body-file, or --options has nothing to deliver, and when the recipient
  // is the telegram relay it would reach the user as an empty placeholder
  // (seen live: a goalless signal posted "(no text)" to the chat). Refused at
  // send time so the sender learns immediately instead of the user.
  if (kind === 'signal' && !flags.goal && !flags['body-file'] && !flags.options) {
    throw new SidekicksError(
      'agent send: a signal with no --goal, --body-file, or --options has nothing to say — put the note in --goal',
      EXIT_VALIDATION
    );
  }

  const recipient = requireCharter(repoRoot, to);

  let category = flags.category ? String(flags.category) : null;
  if (kind === 'task') {
    if (recipient.status !== 'active') {
      throw new SidekicksError(
        `agent send: '${to}' is ${recipient.status} — a task needs an active recipient`,
        EXIT_VALIDATION
      );
    }
    const cats = Array.isArray(recipient.categories) ? recipient.categories : [];
    if (!category) {
      throw new SidekicksError(
        `agent send: --category is required for a task (recipient '${to}' claims: ${cats.join(', ')})`,
        EXIT_VALIDATION
      );
    }
    if (!cats.includes(category)) {
      throw new SidekicksError(
        `agent send: category '${category}' is not in '${to}' charter categories [${cats.join(', ')}] — pick a matching agent or extend the charter`,
        EXIT_VALIDATION
      );
    }
  }

  // ── Cycle guard ────────────────────────────────────────────────────────
  // A task to yourself is a delegation no-op that only churns the standby loop.
  if (kind === 'task' && to === from) {
    throw new SidekicksError(
      `agent send: '${from}' cannot task itself — a task needs a different worker`,
      EXIT_VALIDATION
    );
  }

  // Resolve the ORIGIN — the claimed message the sender is executing right now.
  // Explicit --origin <id> wins; '--origin none' forces a fresh chain (the
  // deliberate human escape hatch); omitted → auto-infer when the sender holds
  // EXACTLY one claimed message (the standby-worker case), else fresh chain.
  let origin = null;
  const originFlag = flags.origin != null ? String(flags.origin) : '';
  if (originFlag && originFlag !== 'none') {
    origin = readMessage(repoRoot, from, 'claimed', originFlag);
    if (!origin) {
      throw new SidekicksError(
        `agent send: --origin '${originFlag}' is not in ${from}/inbox/claimed — the origin must be the message the sender is executing`,
        EXIT_VALIDATION
      );
    }
  } else if (!originFlag) {
    const claimed = listMessageIds(repoRoot, from, 'claimed');
    if (claimed.length === 1) origin = readMessage(repoRoot, from, 'claimed', claimed[0]);
  }

  // Lineage: `hops` counts task hops; `chain` records upstream TASK senders
  // ("agent/msg-id"). A reply origin inherits the chain verbatim — the reply
  // closed that hop, so its sender is NOT upstream (master↔worker iteration
  // stays legal) — but still deepens hops, so endless iteration is bounded too.
  let hops = 0;
  let chain = [];
  if (origin) {
    hops = (Number.isInteger(origin.hops) ? origin.hops : 0) + 1;
    chain = Array.isArray(origin.chain) ? [...origin.chain] : [];
    if (origin.kind === 'task' && origin.from) chain.push(`${origin.from}/${origin.id}`);
  }

  if (kind === 'task') {
    const upstream = chain.find((e) => typeof e === 'string' && e.split('/')[0] === to);
    if (upstream) {
      throw new SidekicksError(
        `agent send: cycle detected — '${to}' is upstream in this delegation chain (${upstream}); return results with 'sidekicks agent complete' (the reply routes back automatically), or start a deliberate fresh chain with --origin none`,
        EXIT_VALIDATION
      );
    }
    if (hops >= MAX_TASK_HOPS) {
      throw new SidekicksError(
        `agent send: delegation chain reached ${hops} task hops (cap ${MAX_TASK_HOPS}) — this is the signature of a runaway agent-to-agent loop; a human re-originates deliberately with --origin none`,
        EXIT_VALIDATION
      );
    }
  }

  const isolation = flags.isolation ? String(flags.isolation) : 'shared';
  if (!ISOLATIONS.includes(isolation)) {
    throw new SidekicksError(
      `agent send: invalid --isolation '${isolation}' — one of: ${ISOLATIONS.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  let bodyFile = null;
  if (flags['body-file']) {
    bodyFile = toPortablePath(repoRoot, flags['body-file'], '--body-file');
    if (!existsSync(resolve(repoRoot, bodyFile))) {
      throw new SidekicksError(`agent send: --body-file '${bodyFile}' does not exist`, EXIT_VALIDATION);
    }
  }

  const priority = flags.priority != null && flags.priority !== '' ? Number(flags.priority) : 2;
  if (!Number.isInteger(priority) || priority < 0) {
    throw new SidekicksError(`agent send: invalid --priority '${flags.priority}' — a non-negative integer`, EXIT_VALIDATION);
  }

  // Conversation binding — deliberately SEPARATE from hops/chain. `chain` is
  // the delegation cycle guard (a recipient already upstream is refused, and
  // MAX_TASK_HOPS caps depth); a human's chat messages all arrive with
  // `--origin none`, which CLEARS the chain by design. So conversation identity
  // cannot live there: eight chat turns would trip the hop cap. It rides as its
  // own nullable top-level field instead, and stays on schema agent-msg/v1 —
  // an added optional field is a compatible extension, and pruneForPrint drops
  // nulls so a non-conversational message costs a reader nothing.
  let threadId = null;
  if (flags.thread != null && flags.thread !== '' && flags.thread !== true) {
    threadId = String(flags.thread);
    if (!isThreadId(threadId)) {
      throw new SidekicksError(
        `agent send: invalid --thread '${threadId}' — expected a thread id like th-20260725-181500-a1b2`,
        EXIT_VALIDATION
      );
    }
  }

  const now = bangkokTimestamp();
  const msg = {
    schema: 'agent-msg/v1',
    id: newMessageId(now),
    kind,
    from,
    to,
    category,
    priority,
    reply_to: flags['reply-to'] ? String(flags['reply-to']) : null,
    thread_id: threadId,
    hops,
    chain,
    created_at: now,
    brief: {
      goal: flags.goal ? String(flags.goal) : '',
      acceptance_criteria: flags.acceptance
        ? String(flags.acceptance).split(';').map((s) => s.trim()).filter(Boolean)
        : [],
      // Choices offered to the recipient — on a message relayed to telegram
      // they render as tap-to-answer inline buttons. Omitted when not given
      // (an added optional field is a compatible agent-msg/v1 extension).
      ...(flags.options
        ? { options: String(flags.options).split(';').map((s) => s.trim()).filter(Boolean) }
        : {}),
      // The charter's default goes through the SAME gate as the flag. It reaches the same field,
      // and the standby contract tells the recipient to work in it — so a traversing value was
      // refused when passed to `agent send` and accepted when it rode in on the charter. The
      // charter is gated at write time too; this covers one written before that gate existed.
      work_dir: flags['work-dir']
        ? toPortablePath(repoRoot, flags['work-dir'], '--work-dir')
        : (kind === 'task' && recipient.default_work_dir
          ? toPortablePath(repoRoot, recipient.default_work_dir, "charter default_work_dir")
          : ''),
      isolation,
      constraints: [],
      body_file: bodyFile,
    },
    claim: null,
    result: null,
  };

  ensureRuntimeTree(repoRoot, to);
  writeMessage(repoRoot, to, 'new', msg);

  if (flags.json) {
    return { stdout: JSON.stringify(msg, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: `sent ${msg.id} (${kind}) ${from} → ${to}${category ? ` [${category}]` : ''}\n`, exitCode: EXIT_OK };
}
