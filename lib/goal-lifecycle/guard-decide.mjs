#!/usr/bin/env node
// lib/goal-lifecycle/guard-decide.mjs
// The decision every guard shim makes: refuse, allow once under a grant, or pass through.
//
// THIS RUNS AS A CHILD OF THE AGENT SESSION, not of the engine. So it owns nothing, writes nothing but
// its own append-only refusal log, and never consults run state — a decision that needed `run.json`
// would need the run lease, and taking that here would deadlock against the parent that holds it.
//
// FAIL CLOSED, ALWAYS. Every error path refuses. A guard that cannot tell whether a command is a push
// must not run it, and a guard that cannot write its log must not let the command proceed unrecorded —
// the whole point of the log is that the refusal is provable afterwards.
//
// A GRANT IS SPENT ONCE. The operator granted one action on one target, so the first matching
// invocation consumes it by creating a marker with an EXCLUSIVE create; the second invocation finds the
// marker and is refused like any other. Exclusive create is the same primitive the run lease uses, for
// the same reason: two processes racing must not both win.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, openSync, closeSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { cmdCommandLine, isCmdShim } from '../agent-lifecycle/_win-argv.mjs';
import {
  GUARD_ENV,
  GUARD_REFUSAL_EXIT,
  canonicalTarget,
  classifyInvocation,
  grantCovers,
} from './guard.mjs';

/**
 * Find the real binary for a command name, searching the PATH the guard displaced.
 *
 * The guard directory is excluded explicitly rather than by position: an environment that lists it
 * twice, or a child that re-ordered PATH, must not resolve back to the shim and recurse forever.
 *
 * @param {string} command
 * @param {string} searchPath
 * @param {string} guardBin
 * @returns {string|null}
 */
export function findReal(command, searchPath, guardBin) {
  const exts = process.platform === 'win32'
    ? ['.cmd', '.bat', '.exe', '.com', '']
    : [''];
  for (const dir of String(searchPath).split(delimiter)) {
    if (dir === '' || dir === guardBin) continue;
    for (const ext of exts) {
      const candidate = join(dir, `${command}${ext}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch { /* unreadable PATH entry; keep looking */ }
    }
  }
  return null;
}

/**
 * Append one decision to the log.
 *
 * @param {string} logPath
 * @param {object} entry
 * @returns {boolean} whether the entry is on disk
 */
export function appendDecision(logPath, entry) {
  if (!logPath) return false;
  try {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * The guard directory to exclude from a real-binary search.
 *
 * By construction the parent put it first on the child's PATH, so the first entry is it. Derived rather
 * than baked into the shim, because nothing machine-specific is written into a shim file.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
export function guardDirOf(env) {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== 'path') continue;
    return String(env[key] ?? '').split(delimiter)[0] ?? '';
  }
  return '';
}

/**
 * Claim a grant exactly once.
 *
 * @param {string} grantPath
 * @returns {boolean} true when THIS call is the one that consumed it
 */
export function claimGrant(grantPath) {
  const marker = `${grantPath}.used`;
  try {
    // 'wx' fails when the file exists — that is the whole mechanism.
    closeSync(openSync(marker, 'wx'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand a benign invocation to the real binary.
 *
 * Windows `.cmd`/`.bat` shims cannot be spawned with `shell: false` since the CVE-2024-24576 hardening,
 * so they go through the audited `cmd.exe` encoder rather than a second escaping implementation here.
 *
 * @param {string} real
 * @param {string[]} argv
 * @returns {number}
 */
export function passthrough(real, argv) {
  if (process.platform === 'win32' && isCmdShim(real)) {
    const line = cmdCommandLine(real, argv);
    const r = spawnSync(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', line], {
      stdio: 'inherit',
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
    return r.error ? 1 : (r.status ?? 1);
  }
  const r = spawnSync(real, argv, { stdio: 'inherit', windowsHide: true });
  return r.error ? 1 : (r.status ?? 1);
}

/**
 * The refusal message the session reads on stderr.
 *
 * It names the escape hatch, because a session that is refused with no route forward either retries the
 * same command or gives up silently — and the engine can act on a reported blocker.
 *
 * @param {string} command
 * @param {string} actionClass
 * @param {{granted: string, attempted: string}|null} [mismatch]
 * @returns {string}
 */
export function refusalMessage(command, actionClass, mismatch = null) {
  const head = mismatch
    ? `sidekicks goal guard: REFUSED — the operator granted one ${actionClass} against `
      + `'${mismatch.granted}', and this command targets '${mismatch.attempted}'. A grant covers `
      + 'exactly the target it names.\n'
    : `sidekicks goal guard: REFUSED — '${command}' is a ${actionClass} action, and the approval `
      + 'that started this run does not cover it.\n';
  return `${head}This command did not run. Nothing was changed by it.\n`
    + 'If the node genuinely cannot be completed without it, stop and return '
    + `result: "blocked" with an action_request naming action_class "${actionClass}", its exact `
    + 'target, and why. The operator grants that one action, and only then does it become available.\n';
}

/**
 * Decide and act.
 *
 * @param {string[]} argv - [command, ...commandArgs]
 * @param {Record<string, string|undefined>} env
 * @returns {number} the exit code to return
 */
export function decide(argv, env) {
  const [command, ...rest] = argv;
  const logPath = env[GUARD_ENV.log] ?? '';
  const at = new Date().toISOString();
  const guardBin = guardDirOf(env);
  const realPath = env[GUARD_ENV.path] ?? '';

  if (!command) {
    process.stderr.write('sidekicks goal guard: no command was given to the guard shim\n');
    return GUARD_REFUSAL_EXIT;
  }

  const actionClass = classifyInvocation(command, rest);

  if (actionClass !== null) {
    let grant = null;
    const grantPath = env[GUARD_ENV.grant] ?? '';
    if (grantPath) {
      try {
        grant = JSON.parse(readFileSync(grantPath, 'utf8'));
      } catch {
        grant = null;
      }
    }

    const covered = grantCovers(grant, { command, actionClass, argv: rest });
    if (covered && claimGrant(grantPath)) {
      const logged = appendDecision(logPath, {
        decision: 'allowed-by-grant', command, action_class: actionClass, argv: rest, at,
        request_id: grant.request_id ?? null,
      });
      if (!logged) {
        // The grant was consumed but the record failed. Refusing now is the honest outcome: an action
        // taken with no audit line is worse than a granted action that has to be re-granted.
        process.stderr.write(
          'sidekicks goal guard: the grant was claimed but the audit log could not be written, so the '
          + 'action was NOT taken. Nothing ran.\n',
        );
        return GUARD_REFUSAL_EXIT;
      }
      const real = findReal(command, realPath, guardBin);
      if (real === null) {
        process.stderr.write(`sidekicks goal guard: '${command}' is not on the real PATH\n`);
        return 127;
      }
      return passthrough(real, rest);
    }

    // A grant for this class that does NOT cover this target is the confusing case, so the refusal
    // says both targets. Without it the session reads "REFUSED" while holding what looks like the
    // right permission, and retries the same command.
    const mismatch = grant && grant.action_class === actionClass && !covered
      ? { granted: String(grant.target ?? ''), attempted: canonicalTarget(command, rest).join(' ') }
      : null;
    appendDecision(logPath, {
      decision: 'refused', command, action_class: actionClass, argv: rest, at,
      ...(mismatch ? { target_mismatch: mismatch } : {}),
    });
    process.stderr.write(refusalMessage(command, actionClass, mismatch));
    return GUARD_REFUSAL_EXIT;
  }

  const real = findReal(command, realPath, guardBin);
  if (real === null) {
    process.stderr.write(`sidekicks goal guard: '${command}' is not on PATH\n`);
    return 127;
  }
  return passthrough(real, rest);
}

// Entry point when a shim execs this file. `process.argv` is [node, thisFile, command, ...args].
if (process.argv[1] && process.argv[1].endsWith('guard-decide.mjs')) {
  let code;
  try {
    code = decide(process.argv.slice(2), process.env);
  } catch (err) {
    // Fail closed on ANY unexpected error — see the header.
    process.stderr.write(
      `sidekicks goal guard: refused because the guard itself failed (${err && err.message ? err.message : err}). `
      + 'The command did not run.\n',
    );
    code = GUARD_REFUSAL_EXIT;
  }
  process.exit(code);
}
