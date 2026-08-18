// lib/run-events/commands.mjs
// The `sidekicks artifacts events <append|show|check|unlock>` CLI.
//
// WHY THE CLI IS THE ONLY WRITER. Three engines append to a sidecar and one of them is Python
// (sk-cli-orchestrator's scripts/ledger.py). Re-implementing the schema, the lock rules and the
// tail-recovery policy in a second language would create two authorities that agree until the day
// they do not — so every engine, in every language, shells out to THIS verb with argv arrays and
// `shell: false`. That is also why `append` reads its intent from a FILE rather than from flags: a
// nested `detail` object cannot survive a flag encoding, and a temp file keeps the caller's argv free
// of anything that would need quoting on one platform and not the other.
//
// BOTH SPELLINGS OF EVERY VALUED FLAG WORK. The dispatcher's global parseArgs is `strict: false` and
// declares only --help/--version/--verbose, so `--input intent.json` reaches this verb as
// `{ input: true }` plus a STRAY POSITIONAL, while `--input=intent.json` reaches it as a string. Both
// halves matter here: the stray positional would otherwise be mistaken for the run directory. So the
// raw argv is re-read where the boolean set is known (§ parseEventsArgs) and the dispatcher's own
// positional list is not consulted at all — the same fix lib/scope-lifecycle/_shared.mjs,
// lib/check-lifecycle/_shared.mjs and lib/catalog-lifecycle/_shared.mjs apply, kept as a LOCAL copy
// for the reason they each give: `package transfer` ships lib subsystems by import closure, and
// borrowing another subsystem's parser would drag that subsystem along.
//
// EXIT CODES
//   0  done — appended, duplicate, or a clean report
//   1  `check` produced a report that carries error-severity findings (the report is still on stdout,
//      so the caller reads WHY; the same convention `check run` and `scope explain` use)
//   2  invalid arguments, an invalid intent, or a CONFLICTING duplicate event_id
//   3  the sidecar is corrupt beyond the one repairable case, or the lock could not be acquired
//
// Zero npm dependencies — node:* + lib/ back-edges only; macOS + Windows.

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { SidekicksError, EXIT_OK, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { EVENT_SCHEMA_VERSION, DUAL_WRITE_STEPS } from './schema.mjs';
import {
  EVENTS_FILENAME,
  appendEvent,
  checkEvents,
  replayEvents,
  unlockEvents,
} from './store.mjs';

/** The subcommands, in help order. */
export const EVENT_SUBCOMMANDS = Object.freeze(['append', 'show', 'check', 'unlock']);

/** Flags that never take a value. Everything else in this verb is valued. */
export const EVENTS_BOOLEANS = Object.freeze([
  'json', 'confirm-owner-dead', 'help', 'version', 'verbose',
]);

/** "The report was produced, and the answer is no." Not a SidekicksError — stdout holds the report. */
const EXIT_FINDINGS = 1;

const USAGE = [
  'usage: sidekicks artifacts events append <run-dir> --input <intent.json> [--json]',
  '       sidekicks artifacts events show   <run-dir> [--json]',
  '       sidekicks artifacts events check  <run-dir> [--json]',
  '       sidekicks artifacts events unlock <run-dir> --confirm-owner-dead [--json]',
].join('\n');

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/**
 * Parse `--flag`, `--flag=value` and `--flag value` out of a raw argv slice.
 *
 * @param {string[]} argv - ctx.argv
 * @param {string[]} booleans
 * @returns {Record<string, string|boolean>}
 */
export function parseEventFlags(argv, booleans = []) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  const boolSet = new Set(booleans);
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string' || !tok.startsWith('--')) continue;
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      const key = body.slice(0, eq);
      out[key] = boolSet.has(key) ? true : body.slice(eq + 1);
      continue;
    }
    if (boolSet.has(body)) {
      out[body] = true;
      continue;
    }
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[body] = next;
      i += 1;
    } else {
      out[body] = '';
    }
  }
  return out;
}

/**
 * The positionals of a raw argv slice, in order — flag VALUES excluded.
 *
 * The dispatcher's own positional list cannot be used: with `strict: false` the value of a space-form
 * valued flag lands there too, so `events append <dir> --input i.json` would look like TWO
 * positionals and the intent file would be read as the run directory.
 *
 * @param {string[]} argv
 * @param {string[]} booleans
 * @returns {string[]}
 */
export function positionalArgs(argv, booleans = []) {
  const boolSet = new Set(booleans);
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      if (body.includes('=') || boolSet.has(body)) continue;
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('--')) i += 1; // consumed as this flag's value
      continue;
    }
    out.push(tok);
  }
  return out;
}

/**
 * Read `artifacts events`' options out of a raw argv slice.
 *
 * @param {string[]} argv - ctx.argv; argv[0]/[1] are the namespace and verb
 * @returns {{subcommand: string, runDir: string, input: string|null, json: boolean,
 *            confirmOwnerDead: boolean}}
 * @throws {SidekicksError} EXIT_VALIDATION on a missing/unknown subcommand, a missing run dir, an
 *   extra positional, `append` without `--input`, or a valueless `--input`.
 */
export function parseEventsArgs(argv) {
  const flags = parseEventFlags(argv, EVENTS_BOOLEANS);
  const positionals = positionalArgs(argv, EVENTS_BOOLEANS);
  // argv[0] = 'artifacts', argv[1] = 'events'
  const rest = positionals.slice(2);

  const subcommand = rest[0];
  if (subcommand === undefined || subcommand === '') {
    throw new SidekicksError(
      `artifacts events needs a subcommand (${EVENT_SUBCOMMANDS.join(' | ')})\n${USAGE}`,
      EXIT_VALIDATION,
    );
  }
  if (!EVENT_SUBCOMMANDS.includes(subcommand)) {
    throw new SidekicksError(
      `unknown 'artifacts events' subcommand '${subcommand}' — expected one of `
      + `${EVENT_SUBCOMMANDS.join(', ')}\n${USAGE}`,
      EXIT_VALIDATION,
    );
  }

  const runDir = rest[1];
  if (runDir === undefined || runDir === '') {
    throw new SidekicksError(`artifacts events ${subcommand} needs a <run-dir>\n${USAGE}`, EXIT_VALIDATION);
  }
  if (rest.length > 2) {
    throw new SidekicksError(
      `unexpected argument '${rest[2]}' — artifacts events ${subcommand} takes exactly one <run-dir>\n${USAGE}`,
      EXIT_VALIDATION,
    );
  }

  for (const key of Object.keys(flags)) {
    if (key !== 'input' && !EVENTS_BOOLEANS.includes(key)) {
      throw new SidekicksError(`unknown flag '--${key}'\n${USAGE}`, EXIT_VALIDATION);
    }
  }

  let input = null;
  if (flags.input !== undefined) {
    if (typeof flags.input !== 'string' || flags.input === '') {
      throw new SidekicksError(`--input needs a path to an intent JSON file\n${USAGE}`, EXIT_VALIDATION);
    }
    input = flags.input;
  }
  if (subcommand === 'append' && input === null) {
    throw new SidekicksError(
      'artifacts events append needs --input <intent.json>: the intent carries a nested `detail` '
      + 'object, which no flag encoding can survive portably\n' + USAGE,
      EXIT_VALIDATION,
    );
  }
  if (subcommand !== 'append' && input !== null) {
    throw new SidekicksError(`--input is only valid for 'events append'\n${USAGE}`, EXIT_VALIDATION);
  }
  if (subcommand === 'unlock' && flags['confirm-owner-dead'] !== true) {
    throw new SidekicksError(
      'artifacts events unlock requires --confirm-owner-dead: breaking a lock asserts the recorded '
      + 'owner process is gone, which only a human can know\n' + USAGE,
      EXIT_VALIDATION,
    );
  }
  if (subcommand !== 'unlock' && flags['confirm-owner-dead'] === true) {
    throw new SidekicksError(`--confirm-owner-dead is only valid for 'events unlock'\n${USAGE}`, EXIT_VALIDATION);
  }

  return {
    subcommand,
    runDir,
    input,
    json: flags.json === true,
    confirmOwnerDead: flags['confirm-owner-dead'] === true,
  };
}

/**
 * Resolve a caller-supplied path against the process cwd.
 *
 * cwd, not the repo root: a run directory may legitimately live in a service checkout or a temp
 * directory outside the repo, and an engine invoking this CLI already knows the path it means.
 *
 * @param {string} p
 * @returns {string}
 */
function resolvePath(p) {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/**
 * Read and parse an intent file.
 *
 * @param {string} path
 * @returns {object}
 */
function readIntent(path) {
  let raw;
  try {
    raw = readFileSync(resolvePath(path), 'utf8');
  } catch (err) {
    throw new SidekicksError(
      `cannot read intent file '${path}': ${err && err.message ? err.message : String(err)}`,
      EXIT_VALIDATION,
    );
  }
  try {
    // A BOM survives a Windows editor; strip it rather than fail on it.
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    throw new SidekicksError(`intent file '${path}' is not valid JSON: ${err.message}`, EXIT_VALIDATION);
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** JSON envelope every subcommand shares. */
function envelope(action, runDirArg, body) {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    action,
    // The path AS GIVEN. A resolved absolute path could not be printed (CLAUDE.md § Portable paths),
    // and the caller's own spelling is the one it can correlate.
    run_dir: runDirArg,
    file: EVENTS_FILENAME,
    ...body,
  };
}

const out = (payload, exitCode = EXIT_OK) => ({
  stdout: `${JSON.stringify(payload, null, 2)}\n`,
  exitCode,
});

/** `artifacts events append` */
function doAppend(opts) {
  const intent = readIntent(/** @type {string} */ (opts.input));
  const res = appendEvent(resolvePath(opts.runDir), intent);
  const payload = envelope('append', opts.runDir, {
    ok: true,
    result: res.result,
    sequence: res.sequence,
    event: res.event,
    recovered_tail: res.recovered_tail,
    reclaimed_locks: res.reclaimed_locks.length,
  });
  if (opts.json) return out(payload);
  const lines = [
    `${res.result === 'duplicate' ? 'duplicate' : 'appended'} — ${res.event.event} `
    + `(${res.event.status}) seq ${res.sequence} @ ${res.event.timestamp}`,
    `  run_id    ${res.event.run_id}`,
    `  work_item ${res.event.work_item === null ? '(none)' : res.event.work_item}`,
    `  engine    ${res.event.engine}`,
    `  event_id  ${res.event.event_id}`,
  ];
  if (res.result === 'duplicate') {
    lines.push('  (idempotent: this event_id already carries an identical intent — nothing written)');
  }
  if (res.recovered_tail) {
    lines.push(
      `  recovered_tail ${res.recovered_tail.bytes} bytes archived to ${res.recovered_tail.path}`,
    );
  }
  if (res.reclaimed_locks.length > 0) {
    lines.push(`  reclaimed ${res.reclaimed_locks.length} dead same-host lock(s), archived not deleted`);
  }
  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
}

/** `artifacts events show` */
function doShow(opts) {
  const rep = replayEvents(resolvePath(opts.runDir));
  const payload = envelope('show', opts.runDir, {
    ok: true,
    present: rep.present,
    count: rep.count,
    next_sequence: rep.next_sequence,
    truncated_tail: rep.truncated_tail,
    skipped: rep.skipped,
    events: rep.events,
  });
  if (opts.json) return out(payload);
  if (!rep.present) {
    return { stdout: `no ${EVENTS_FILENAME} in ${opts.runDir} — no run events recorded\n`, exitCode: EXIT_OK };
  }
  const lines = [`run events — ${opts.runDir}/${EVENTS_FILENAME} (${rep.count}):`, ''];
  for (const e of rep.events) {
    lines.push(
      `  ${String(e.sequence).padStart(4, ' ')}  ${e.timestamp}  ${e.engine.padEnd(15, ' ')} `
      + `${e.event.padEnd(16, ' ')} ${e.status.padEnd(9, ' ')} ${e.actor.kind}:${e.actor.id}`,
    );
  }
  for (const s of rep.skipped) lines.push(`  skipped line ${s.line}: ${s.message}`);
  if (rep.truncated_tail) {
    lines.push(
      `  ! final line is truncated (${rep.truncated_tail.bytes} bytes) — the next append archives it`,
    );
  }
  lines.push('', 'The sidecar is DIAGNOSTIC. The engine\'s own ledger remains the resume authority.', '');
  return { stdout: lines.join('\n'), exitCode: EXIT_OK };
}

/** `artifacts events check` */
function doCheck(opts) {
  const rep = checkEvents(resolvePath(opts.runDir));
  const payload = envelope('check', opts.runDir, {
    ok: rep.ok,
    present: rep.present,
    bytes: rep.bytes,
    count: rep.count,
    next_sequence: rep.next_sequence,
    skipped: rep.skipped,
    findings: rep.findings,
    lock: rep.lock,
    dual_write_policy: DUAL_WRITE_STEPS,
  });
  const exitCode = rep.ok ? EXIT_OK : EXIT_FINDINGS;
  if (opts.json) return out(payload, exitCode);
  const lines = [
    `run events check — ${opts.runDir}/${EVENTS_FILENAME}`,
    `  present   ${rep.present}`,
    `  events    ${rep.count} (next sequence ${rep.next_sequence})`,
    `  bytes     ${rep.bytes}`,
  ];
  if (rep.lock) lines.push(`  lock      ${rep.lock.state} — ${rep.lock.reason}`);
  if (rep.findings.length === 0) {
    lines.push('  findings  none');
  } else {
    lines.push('  findings:');
    for (const f of rep.findings) lines.push(`    [${f.severity}] ${f.code} @ ${f.subject} — ${f.message}`);
  }
  lines.push('', `  ${rep.ok ? 'OK' : 'FAILED'}`, '');
  return { stdout: lines.join('\n'), exitCode };
}

/** `artifacts events unlock` */
function doUnlock(opts) {
  const rep = unlockEvents(resolvePath(opts.runDir), { confirmOwnerDead: opts.confirmOwnerDead });
  const payload = envelope('unlock', opts.runDir, {
    ok: true,
    unlocked: rep.unlocked,
    state: rep.state,
    reason: rep.reason,
    archived: rep.archived,
    owner: rep.owner
      ? { pid: rep.owner.pid, hostname: rep.owner.hostname, acquired_at: rep.owner.acquired_at }
      : null,
  });
  if (opts.json) return out(payload);
  const lines = [rep.unlocked ? `unlocked — ${rep.reason}` : `not unlocked — ${rep.reason}`];
  if (rep.archived) lines.push(`  archived to ${rep.archived} (archived, never deleted)`);
  if (rep.owner) lines.push(`  recorded owner pid ${rep.owner.pid} on ${rep.owner.hostname} @ ${rep.owner.acquired_at}`);
  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
}

/**
 * The `artifacts events` entrypoint.
 *
 * @param {string[]} argv - ctx.argv
 * @returns {{stdout: string, exitCode: number}}
 */
export function runEventsCli(argv) {
  const opts = parseEventsArgs(argv);
  switch (opts.subcommand) {
    case 'append': return doAppend(opts);
    case 'show':   return doShow(opts);
    case 'check':  return doCheck(opts);
    case 'unlock': return doUnlock(opts);
    default:
      // Unreachable — parseEventsArgs validates the set.
      throw new SidekicksError(`unknown subcommand '${opts.subcommand}'\n${USAGE}`, EXIT_VALIDATION);
  }
}
