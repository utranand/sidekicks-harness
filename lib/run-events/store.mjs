// lib/run-events/store.mjs
// The append-only store behind `<run-dir>/events.v1.jsonl` — the lock, the tail scan, the one append.
//
// THREE RULES SHAPE EVERY LINE OF THIS FILE.
//
//   1. THE SIDECAR IS NEVER AUTHORITATIVE. Nothing here reads, writes, or repairs an engine ledger,
//      and nothing here is allowed to become the resume source. See ./schema.mjs § header.
//
//   2. ONLY A TRUNCATED FINAL LINE IS TOLERATED. A crash between `write` and the newline leaves a
//      partial last line and nothing else — that is the ONE corruption an append-only writer can
//      produce, so it is the only one repaired: the partial bytes are ARCHIVED under
//      `events.v1.recovery/` (never dropped — they are evidence of what the crashed run was doing)
//      and the main file is truncated back to its last newline. A malformed line ANYWHERE ELSE, a
//      complete-but-unparseable final line, or a sequence that does not run 1..n contiguously means
//      something other than this writer edited the file, and auto-repairing that would destroy the
//      only copy of whatever it was. Those are hard errors, always.
//
//   3. SEQUENCE IS ASSIGNED UNDER THE LOCK, WHICH IS WHY THE LOCK EXISTS. Two engines appending to
//      the same run without one would either duplicate a sequence or interleave a half-written line.
//      `O_EXCL` create is the primitive — atomic on every filesystem that matters, and no npm
//      dependency. The lock is per RUN (`<run-dir>/events.v1.lock`), never global: a global log would
//      make unrelated runs contend.
//
// STEALING A LOCK IS ALMOST ALWAYS THE WRONG ANSWER. A lock file whose owner is still alive is
// ACTIVE and is never reclaimed, and `EPERM` from `kill(pid, 0)` counts as alive — the process
// exists, it just belongs to another user. Only a SAME-HOST `ESRCH` (that pid is gone, and this host
// is the one that could know) is reclaimed automatically, and even then the lock is archived rather
// than deleted. A FOREIGN-HOST lock cannot be judged from here at all — pid 4711 on another machine
// says nothing about pid 4711 here — and a MALFORMED lock might have been written by a version whose
// rules we do not know. Both wait out the timeout and then demand the explicit human decision:
// `artifacts events unlock <run-dir> --confirm-owner-dead`.
//
// Zero npm dependencies — node:* only; macOS + Windows (no POSIX-only shell-out; the wait is
// `Atomics.wait`, not `sleep`).

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { hostname as osHostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { SidekicksError, EXIT_IO, EXIT_NOT_FOUND, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  EVENT_SCHEMA_VERSION,
  FIELD_ORDER,
  classifyRecord,
  normalizedIntent,
  normalizeRefPath,
  validateEvent,
  validateIntent,
} from './schema.mjs';

/** The sidecar's filename. The version is IN the name so a v2 file can sit beside it, unread. */
export const EVENTS_FILENAME = 'events.v1.jsonl';

/** The advisory lock. Same version suffix, same reason. */
export const LOCK_FILENAME = 'events.v1.lock';

/** Where recovered tails and archived locks go. Never deleted by this module. */
export const RECOVERY_DIRNAME = 'events.v1.recovery';

/** Lock acquisition ceiling, in ms. Two seconds — an append is milliseconds of work. */
export const LOCK_TIMEOUT_MS = 2000;

/** Poll interval while a lock is held by someone else. */
const LOCK_RETRY_MS = 20;

// ---------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------

/**
 * An ISO-8601 instant with the Asia/Bangkok (+07:00) offset (CLAUDE.md § Timezone).
 *
 * Asia/Bangkok is a fixed +07:00 with no DST, but the wall-clock split still goes through Intl
 * rather than epoch arithmetic — the same approach lib/check-lifecycle/_shared.mjs and
 * lib/memory-lifecycle/_shared.mjs take, so all three agree on a boundary date.
 *
 * @param {number} epochMs
 * @returns {string} e.g. "2026-08-18T22:15:30+07:00"
 */
export function bangkokTimestamp(epochMs) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date(epochMs))
      .map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour; // some ICU builds emit 24 at midnight
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}+07:00`;
}

/**
 * The same instant as a FILENAME-SAFE stamp.
 *
 * `:` is a legal character in a POSIX filename and an illegal one on Windows (it opens an alternate
 * data stream), so a recovery artifact named with the RFC3339 form would be unwritable on half the
 * supported platforms. One implementation, both platforms: strip the punctuation.
 *
 * @param {number} epochMs
 * @returns {string} e.g. "20260818T221530+0700"
 */
export function bangkokStamp(epochMs) {
  return bangkokTimestamp(epochMs).replace(/[-:]/g, '');
}

/**
 * Block the current thread for `ms` — no dependency, no shell, works on both platforms.
 *
 * `Atomics.wait` on a throwaway SharedArrayBuffer is the only synchronous sleep Node offers. The
 * whole append path is synchronous on purpose (an fsync'd append under a lock has nothing to
 * interleave with), so the retry wait has to be synchronous too.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable (an exotic embedding): spin briefly rather than throw.
    const until = Date.now() + ms;
    while (Date.now() < until) { /* busy wait */ }
  }
}

/** Absolute paths for one run directory's three files. */
export function eventPaths(runDir) {
  return {
    runDir,
    events: join(runDir, EVENTS_FILENAME),
    lock: join(runDir, LOCK_FILENAME),
    recovery: join(runDir, RECOVERY_DIRNAME),
  };
}

/**
 * A non-colliding path inside the recovery folder.
 *
 * Two recoveries inside the same second must both survive — the archived bytes are the only copy of
 * what a crashed run was writing, so a name collision may never overwrite.
 *
 * @param {string} recoveryDir
 * @param {string} base
 * @returns {string}
 */
function uniqueRecoveryPath(recoveryDir, base) {
  mkdirSync(recoveryDir, { recursive: true });
  const dot = base.indexOf('.');
  const stem = dot === -1 ? base : base.slice(0, dot);
  const ext = dot === -1 ? '' : base.slice(dot);
  let candidate = join(recoveryDir, base);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(recoveryDir, `${stem}-${n}${ext}`);
    n += 1;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

/**
 * Read a lock file's ownership record. `null` when it is absent or unparseable-as-ours.
 *
 * @param {string} lockPath
 * @returns {{pid: number, hostname: string, acquired_at: string, nonce: string}|null}
 */
export function readLockOwner(lockPath) {
  let raw;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!Number.isInteger(parsed.pid) || typeof parsed.hostname !== 'string' || parsed.hostname === '') {
    return null;
  }
  if (typeof parsed.nonce !== 'string' || parsed.nonce === '') return null;
  if (typeof parsed.acquired_at !== 'string' || parsed.acquired_at === '') return null;
  return parsed;
}

/**
 * Is that pid, on THIS host, still alive?
 *
 * `EPERM` means the process exists and belongs to someone else — alive. Only `ESRCH` is death. Any
 * other errno is treated as alive, because "I could not tell" must never authorize reclaiming.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    return true; // EPERM and everything else: assume alive
  }
}

/**
 * Classify a lock we could not create because it already exists.
 *
 * @param {string} lockPath
 * @param {string} selfHost
 * @returns {{state: 'active'|'reclaimable'|'foreign'|'malformed'|'gone',
 *            owner: object|null, reason: string}}
 */
export function classifyLock(lockPath, selfHost) {
  if (!existsSync(lockPath)) return { state: 'gone', owner: null, reason: 'lock no longer present' };
  const owner = readLockOwner(lockPath);
  if (owner === null) {
    return {
      state: 'malformed',
      owner: null,
      reason: 'lock file is not a readable ownership record — never auto-reclaimed',
    };
  }
  if (owner.hostname !== selfHost) {
    return {
      state: 'foreign',
      owner,
      reason:
        `lock is held by pid ${owner.pid} on host ${owner.hostname}; a pid on another host cannot be `
        + 'judged from here — never auto-reclaimed',
    };
  }
  if (pidAlive(owner.pid)) {
    return {
      state: 'active',
      owner,
      reason: `lock is held by LIVE pid ${owner.pid} on this host`,
    };
  }
  return {
    state: 'reclaimable',
    owner,
    reason: `lock owner pid ${owner.pid} on this host is gone (ESRCH)`,
  };
}

/**
 * Archive a lock file under `events.v1.recovery/`, then remove it from its live path.
 *
 * Archived, never deleted: a lock is the only record that some process believed it owned this run,
 * and a silent delete erases the evidence for the divergence it may have caused.
 *
 * @param {{lock: string, recovery: string}} paths
 * @param {number} nowMs
 * @returns {string} the archive path
 */
function archiveLock(paths, nowMs) {
  const dest = uniqueRecoveryPath(paths.recovery, `${bangkokStamp(nowMs)}-lock.json`);
  try {
    renameSync(paths.lock, dest);
  } catch {
    // Cross-device or a Windows share: copy-then-unlink rather than lose the bytes.
    const body = (() => { try { return readFileSync(paths.lock); } catch { return Buffer.alloc(0); } })();
    writeFileSync(dest, body);
    try { unlinkSync(paths.lock); } catch { /* already gone */ }
  }
  return dest;
}

/**
 * Acquire the run's exclusive lock, or throw.
 *
 * @param {{lock: string, recovery: string}} paths
 * @param {{now?: () => number, hostname?: string, pid?: number, timeoutMs?: number,
 *          retryMs?: number, onWait?: (state: string) => void}} [opts]
 * @returns {{nonce: string, reclaimed: string[]}}
 */
export function acquireLock(paths, opts = {}) {
  const now = opts.now || Date.now;
  const selfHost = opts.hostname || osHostname();
  const selfPid = opts.pid ?? process.pid;
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? LOCK_RETRY_MS;
  const nonce = randomUUID();
  const deadline = Date.now() + timeoutMs;
  /** @type {string[]} */
  const reclaimed = [];
  let last = { state: 'gone', reason: 'lock never inspected', owner: null };

  for (;;) {
    let fd;
    try {
      fd = openSync(paths.lock, 'wx');
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        throw new SidekicksError(
          `cannot create run-event lock ${LOCK_FILENAME}: ${err && err.message ? err.message : String(err)}`,
          EXIT_IO,
        );
      }
      last = classifyLock(paths.lock, selfHost);
      if (last.state === 'reclaimable') {
        reclaimed.push(archiveLock(paths, now()));
        continue; // retry immediately — the slot is free
      }
      if (last.state === 'gone') continue;
      if (Date.now() >= deadline) break;
      if (opts.onWait) opts.onWait(last.state);
      sleepSync(retryMs);
      continue;
    }

    try {
      writeSync(
        fd,
        `${JSON.stringify({
          pid: selfPid,
          hostname: selfHost,
          acquired_at: bangkokTimestamp(now()),
          nonce,
        })}\n`,
        null,
        'utf8',
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { nonce, reclaimed };
  }

  const hint =
    last.state === 'foreign' || last.state === 'malformed'
      ? ` — recover explicitly with 'sidekicks artifacts events unlock <run-dir> --confirm-owner-dead'`
      : '';
  throw new SidekicksError(
    `run-event lock busy after ${timeoutMs}ms (${last.state}): ${last.reason}${hint}`,
    EXIT_IO,
  );
}

/**
 * Release a lock we hold. A lock whose nonce is no longer ours is LEFT ALONE.
 *
 * @param {{lock: string}} paths
 * @param {string} nonce
 */
export function releaseLock(paths, nonce) {
  try {
    const owner = readLockOwner(paths.lock);
    if (owner && owner.nonce !== nonce) return; // someone else's lock now — not ours to remove
    unlinkSync(paths.lock);
  } catch {
    // Already gone, or unlinkable. Never mask the caller's own error with a cleanup failure.
  }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Split a raw sidecar buffer into COMPLETE lines plus an optional truncated tail.
 *
 * Completeness is a byte fact, not a parse fact: a line is complete iff it is followed by `\n`. That
 * is exactly the guarantee the writer gives (one `write` of `<json>\n`, then fsync), so it is the
 * only thing a reader may infer. `\r` is stripped from each line end so a file that passed through a
 * Windows tool reads identically — LF is written, CRLF is tolerated.
 *
 * @param {Buffer} buf
 * @returns {{lines: {text: string, lineNo: number}[], tail: Buffer|null, lastNewlineEnd: number}}
 */
export function splitJsonl(buf) {
  const lastNl = buf.lastIndexOf(0x0a);
  const completeEnd = lastNl === -1 ? 0 : lastNl + 1;
  const tailBytes = buf.subarray(completeEnd);
  const body = buf.subarray(0, completeEnd).toString('utf8');
  /** @type {{text: string, lineNo: number}[]} */
  const lines = [];
  let lineNo = 0;
  for (const raw of body.split('\n')) {
    lineNo += 1;
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text.trim() === '') continue;
    lines.push({ text, lineNo });
  }
  return {
    lines,
    tail: tailBytes.length > 0 ? Buffer.from(tailBytes) : null,
    lastNewlineEnd: completeEnd,
  };
}

/**
 * Read and validate a sidecar without touching it.
 *
 * Findings are STRUCTURED rather than thrown so the three callers can differ: `check` reports them,
 * `show`/`replayEvents` refuse, and `appendEvent` repairs exactly the one that is repairable.
 *
 * @param {string} runDir
 * @returns {{present: boolean, path: string, bytes: number,
 *            events: object[], skipped: {line: number, code: string, message: string}[],
 *            findings: {code: string, severity: string, subject: string, message: string}[],
 *            truncated_tail: {line: number, bytes: number}|null,
 *            next_sequence: number, by_id: Map<string, object>}}
 */
export function scanEvents(runDir) {
  const paths = eventPaths(runDir);
  /** @type {{code: string, severity: string, subject: string, message: string}[]} */
  const findings = [];
  /** @type {object[]} */
  const events = [];
  /** @type {{line: number, code: string, message: string}[]} */
  const skipped = [];
  const byId = new Map();

  let buf;
  try {
    buf = readFileSync(paths.events);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        present: false,
        path: EVENTS_FILENAME,
        bytes: 0,
        events,
        skipped,
        findings,
        truncated_tail: null,
        next_sequence: 1,
        by_id: byId,
      };
    }
    throw new SidekicksError(
      `cannot read ${EVENTS_FILENAME}: ${err && err.message ? err.message : String(err)}`,
      EXIT_IO,
    );
  }

  const { lines, tail } = splitJsonl(buf);
  let expected = 1;

  for (const { text, lineNo } of lines) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      findings.push({
        code: 'line-unparseable',
        severity: 'error',
        subject: `line ${lineNo}`,
        message:
          `line ${lineNo} is a COMPLETE line that is not JSON (${err.message}); only a truncated `
          + 'FINAL line is ever repaired — this file is corrupt and is never auto-repaired',
      });
      continue;
    }

    const verdict = classifyRecord(parsed);
    if (verdict.kind === 'error') {
      findings.push({
        code: verdict.code || 'record-invalid',
        severity: 'error',
        subject: `line ${lineNo}`,
        message: verdict.message || 'record rejected',
      });
      continue;
    }
    if (verdict.kind === 'skip') {
      skipped.push({ line: lineNo, code: verdict.code || 'skipped', message: verdict.message || '' });
      continue;
    }

    const shape = validateEvent(parsed);
    if (!shape.ok) {
      findings.push({
        code: 'event-invalid',
        severity: 'error',
        subject: `line ${lineNo}`,
        message: `line ${lineNo} fails the version-1 contract: ${shape.errors.join('; ')}`,
      });
      continue;
    }

    if (parsed.sequence !== expected) {
      findings.push({
        code: 'sequence-violation',
        severity: 'error',
        subject: `line ${lineNo}`,
        message:
          `line ${lineNo} carries sequence ${parsed.sequence}; the run's sequence must run 1..n `
          + `contiguously, so ${expected} was required`,
      });
    }
    expected = parsed.sequence + 1;

    if (byId.has(parsed.event_id)) {
      findings.push({
        code: 'duplicate-event-id',
        severity: 'error',
        subject: parsed.event_id,
        message:
          `event_id ${JSON.stringify(parsed.event_id)} appears twice (lines `
          + `${byId.get(parsed.event_id).sequence} and ${parsed.sequence}); it is the idempotency key `
          + 'and must be unique within a run',
      });
    } else {
      byId.set(parsed.event_id, parsed);
    }

    events.push(parsed);
  }

  /** @type {{line: number, bytes: number}|null} */
  let truncated = null;
  if (tail !== null) {
    truncated = { line: lines.length + 1, bytes: tail.length };
    findings.push({
      code: 'truncated-final-line',
      severity: 'warning',
      subject: `line ${truncated.line}`,
      message:
        `the final line is ${tail.length} bytes with no terminating newline — the one corruption an `
        + 'append-only writer can produce. The next append archives it under '
        + `${RECOVERY_DIRNAME}/ and truncates the file to its last newline.`,
    });
  }

  const lastSeq = events.length > 0 ? events[events.length - 1].sequence : 0;
  return {
    present: true,
    path: EVENTS_FILENAME,
    bytes: buf.length,
    events,
    skipped,
    findings,
    truncated_tail: truncated,
    next_sequence: lastSeq + 1,
    by_id: byId,
  };
}

/** The error-severity findings of a scan, as one throwable. */
function throwOnErrors(scan) {
  const errs = scan.findings.filter((f) => f.severity === 'error');
  if (errs.length === 0) return;
  throw new SidekicksError(
    `${EVENTS_FILENAME} is corrupt (${errs.length} error${errs.length === 1 ? '' : 's'}): `
    + errs.map((f) => `${f.code} @ ${f.subject}: ${f.message}`).join(' | ')
    + ` — run 'sidekicks artifacts events check <run-dir>' for the full report; this file is never auto-repaired`,
    EXIT_IO,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Replay a run's events in order. READ-ONLY: it takes no lock and repairs nothing.
 *
 * Read-only on purpose — a replay is what a doctor, a report, or a resume comparison calls, and none
 * of those should be able to mutate the run they are inspecting. A pending truncated tail is
 * REPORTED here and repaired only by the next append, which holds the lock.
 *
 * @param {string} runDir
 * @returns {{schema_version: number, present: boolean, path: string, count: number,
 *            events: object[], skipped: object[], truncated_tail: object|null, next_sequence: number}}
 */
export function replayEvents(runDir) {
  const scan = scanEvents(runDir);
  throwOnErrors(scan);
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    present: scan.present,
    path: scan.path,
    count: scan.events.length,
    events: scan.events,
    skipped: scan.skipped,
    truncated_tail: scan.truncated_tail,
    next_sequence: scan.next_sequence,
  };
}

/**
 * Report on a run's sidecar without throwing — the `events check` gate.
 *
 * @param {string} runDir
 * @returns {{schema_version: number, ok: boolean, present: boolean, path: string, bytes: number,
 *            count: number, next_sequence: number, skipped: object[], findings: object[],
 *            lock: object|null}}
 */
export function checkEvents(runDir) {
  const paths = eventPaths(runDir);
  let scan;
  /** @type {object[]} */
  let findings = [];
  let present = false;
  let bytes = 0;
  let count = 0;
  let nextSequence = 1;
  /** @type {object[]} */
  let skipped = [];
  try {
    scan = scanEvents(runDir);
    findings = scan.findings;
    present = scan.present;
    bytes = scan.bytes;
    count = scan.events.length;
    nextSequence = scan.next_sequence;
    skipped = scan.skipped;
  } catch (err) {
    findings = [{
      code: 'unreadable',
      severity: 'error',
      subject: EVENTS_FILENAME,
      message: err && err.message ? err.message : String(err),
    }];
  }

  /** @type {object|null} */
  let lock = null;
  if (existsSync(paths.lock)) {
    const cls = classifyLock(paths.lock, osHostname());
    lock = {
      state: cls.state,
      reason: cls.reason,
      pid: cls.owner ? cls.owner.pid : null,
      hostname: cls.owner ? cls.owner.hostname : null,
      acquired_at: cls.owner ? cls.owner.acquired_at : null,
    };
    if (cls.state === 'foreign' || cls.state === 'malformed') {
      findings = [...findings, {
        code: `lock-${cls.state}`,
        severity: 'warning',
        subject: LOCK_FILENAME,
        message:
          `${cls.reason}. It is NEVER auto-reclaimed — recover with `
          + `'sidekicks artifacts events unlock <run-dir> --confirm-owner-dead'.`,
      }];
    }
  }

  // Findings order is deterministic: severity, then code, then subject (the `scope explain` rule).
  const rank = { error: 0, warning: 1, info: 2 };
  findings = [...findings].sort((a, b) =>
    (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)
    || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
    || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));

  return {
    schema_version: EVENT_SCHEMA_VERSION,
    ok: findings.every((f) => f.severity !== 'error'),
    present,
    path: EVENTS_FILENAME,
    bytes,
    count,
    next_sequence: nextSequence,
    skipped,
    findings,
    lock,
  };
}

/**
 * Append one event to a run's sidecar, under the run's exclusive lock.
 *
 * @param {string} runDir - the run directory; must already exist
 * @param {object} intent - a version-1 intent (no `sequence`, no `timestamp`)
 * @param {{now?: () => number, hostname?: string, pid?: number, lockTimeoutMs?: number,
 *          lockRetryMs?: number}} [opts]
 * @returns {{result: 'appended'|'duplicate', event: object, sequence: number,
 *            recovered_tail: {path: string, bytes: number}|null, reclaimed_locks: string[]}}
 */
export function appendEvent(runDir, intent, opts = {}) {
  const now = opts.now || Date.now;
  const paths = eventPaths(runDir);

  // The run directory is REQUIRED to exist rather than created. An engine's run folder always does,
  // so a missing one means a typo'd path — and creating it would silently scatter sidecars into
  // directories nobody will look in.
  let st;
  try {
    st = statSync(runDir);
  } catch {
    throw new SidekicksError(`run directory not found: ${runDir}`, EXIT_NOT_FOUND);
  }
  if (!st.isDirectory()) {
    throw new SidekicksError(`run directory is not a directory: ${runDir}`, EXIT_NOT_FOUND);
  }

  const check = validateIntent(intent);
  if (!check.ok) {
    throw new SidekicksError(
      `invalid run-event intent: ${check.errors.join('; ')}`,
      EXIT_VALIDATION,
    );
  }

  const normalized = normalizedIntent(intent);

  const { nonce, reclaimed } = acquireLock(paths, {
    now,
    hostname: opts.hostname,
    pid: opts.pid,
    timeoutMs: opts.lockTimeoutMs,
    retryMs: opts.lockRetryMs,
  });

  try {
    let scan = scanEvents(runDir);

    // Repair the ONE repairable corruption, before anything else looks at the file.
    /** @type {{path: string, bytes: number}|null} */
    let recoveredTail = null;
    if (scan.truncated_tail !== null) {
      const buf = readFileSync(paths.events);
      const { tail, lastNewlineEnd } = splitJsonl(buf);
      if (tail !== null) {
        const dest = uniqueRecoveryPath(paths.recovery, `${bangkokStamp(now())}-tail.jsonl`);
        writeFileSync(dest, tail);
        truncateSync(paths.events, lastNewlineEnd);
        recoveredTail = { path: `${RECOVERY_DIRNAME}/${basename(dest)}`, bytes: tail.length };
      }
      scan = scanEvents(runDir);
    }

    // Everything else is a hard error — including a sequence violation or a mid-file bad line, which
    // an append must never paper over by writing on top of it.
    throwOnErrors(scan);

    const existing = scan.by_id.get(intent.event_id);
    if (existing !== undefined) {
      const { sequence, timestamp, ...rest } = existing;
      if (normalizedIntent(rest) === normalized) {
        return {
          result: 'duplicate',
          event: existing,
          sequence: existing.sequence,
          recovered_tail: recoveredTail,
          reclaimed_locks: reclaimed,
        };
      }
      throw new SidekicksError(
        `event_id ${JSON.stringify(intent.event_id)} is already recorded at sequence `
        + `${existing.sequence} with a DIFFERENT intent — event_id is the idempotency key, so the `
        + 'same id must describe the same transition; use a distinct id for a distinct event',
        EXIT_VALIDATION,
      );
    }

    const record = buildRecord(intent, scan.next_sequence, bangkokTimestamp(now()));
    const shape = validateEvent(record);
    if (!shape.ok) {
      // Unreachable via validateIntent, kept as the writer's own last gate.
      throw new SidekicksError(`refusing to write an invalid event: ${shape.errors.join('; ')}`, EXIT_VALIDATION);
    }

    const line = `${JSON.stringify(record)}\n`;
    const fd = openSync(paths.events, 'a');
    try {
      writeSync(fd, line, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    return {
      result: 'appended',
      event: record,
      sequence: record.sequence,
      recovered_tail: recoveredTail,
      reclaimed_locks: reclaimed,
    };
  } finally {
    releaseLock(paths, nonce);
  }
}

/**
 * Assemble the durable record: fixed key order, writer-assigned fields filled, defaults applied.
 *
 * @param {object} intent
 * @param {number} sequence
 * @param {string} timestamp
 * @returns {object}
 */
export function buildRecord(intent, sequence, timestamp) {
  const src = { ...intent, sequence, timestamp };
  if (src.schema_version === undefined) src.schema_version = EVENT_SCHEMA_VERSION;
  if (src.work_item === undefined) src.work_item = null;
  if (src.refs === undefined) src.refs = [];
  if (src.detail === undefined) src.detail = {};
  src.refs = src.refs.map((r) => {
    const out = { kind: r.kind };
    if (r.id !== undefined && r.id !== null) out.id = r.id;
    if (r.path !== undefined && r.path !== null) out.path = normalizeRefPath(r.path);
    return out;
  });
  /** @type {Record<string, unknown>} */
  const record = {};
  for (const key of FIELD_ORDER) record[key] = src[key];
  return record;
}

/**
 * The explicit human recovery for a lock this module will never reclaim on its own.
 *
 * Requires `confirmOwnerDead` — the caller is asserting a fact only a human can know (that pid on
 * that host is gone). The lock is ARCHIVED, never deleted, so the assertion stays auditable.
 *
 * @param {string} runDir
 * @param {{confirmOwnerDead?: boolean, now?: () => number}} [opts]
 * @returns {{unlocked: boolean, reason: string, archived: string|null, owner: object|null,
 *            state: string}}
 */
export function unlockEvents(runDir, opts = {}) {
  const now = opts.now || Date.now;
  const paths = eventPaths(runDir);
  if (opts.confirmOwnerDead !== true) {
    throw new SidekicksError(
      'events unlock requires --confirm-owner-dead: you are asserting the recorded owner process is '
      + 'gone. A live owner\'s lock must never be broken — its append is mid-flight.',
      EXIT_VALIDATION,
    );
  }
  if (!existsSync(runDir)) {
    throw new SidekicksError(`run directory not found: ${runDir}`, EXIT_NOT_FOUND);
  }
  if (!existsSync(paths.lock)) {
    return { unlocked: false, reason: 'no lock file present', archived: null, owner: null, state: 'gone' };
  }
  const cls = classifyLock(paths.lock, osHostname());
  const dest = archiveLock(paths, now());
  return {
    unlocked: true,
    reason: `archived a ${cls.state} lock (${cls.reason})`,
    archived: `${RECOVERY_DIRNAME}/${basename(dest)}`,
    owner: cls.owner,
    state: cls.state,
  };
}

/** Recovery-folder contents, newest name last — for a report or a test. */
export function listRecovery(runDir) {
  const paths = eventPaths(runDir);
  try {
    return readdirSync(paths.recovery).sort();
  } catch {
    return [];
  }
}
