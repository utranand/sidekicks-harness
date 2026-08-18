// lib/run-events/schema.mjs
// The version-1 run-event contract: the enums, the two validators, and the dual-write policy the
// resumable engines follow.
//
// WHAT A RUN EVENT IS, AND WHAT IT IS NOT. `<run-dir>/events.v1.jsonl` is a DIAGNOSTIC AUDIT
// SIDECAR. Each engine's existing durable state — sk-commander's Workflow journal, get-things-done's
// queue YAML, sk-cli-orchestrator's ledger.yaml — REMAINS the resume source of truth, and nothing in
// this subsystem may be made authoritative. The sidecar answers "what happened, in order, and who
// did it" for a human or a doctor reading a finished run; it never answers "where do I resume".
// Replacing the three ledgers in one migration was the rejected alternative: it trades a real
// resume/data-loss risk for a tidier diagram.
//
// It also does not replace, duplicate, or supersede any of the OTHER durable surfaces:
//   * `sidekicks memory`     — decisions a future agent must not re-learn (durable, curated, committed)
//   * `sidekicks journal`    — the agent's own six-layer narrative record
//   * the agent transcript   — the CLI's own conversation log
//   * the agent inbox        — `.sidekicks/agents/<name>/` runtime mail
//   * conversation history   — the session itself
// A run event is a machine row about a state TRANSITION inside one run. If a fact belongs in memory
// or a journal, it belongs there instead — writing it here as well is duplication that will drift.
//
// WHY A VERSIONED SCHEMA AT ALL. The file is append-only and long-lived: a run directory outlives the
// CLI version that wrote it, and three engines in two languages append to it. So the version is
// stamped per LINE, not per file, and the reader's contract is explicit — see {@link classifyRecord}:
// an unknown REQUIRED schema version is a hard error (silently skipping rows would make a replay
// quietly incomplete), while a row a future writer explicitly marked `ignorable: true` is skipped
// with a diagnostic. That is the whole negotiation, and it is deliberately the only one.
//
// NO SECRET AND NO MACHINE-ABSOLUTE PATH CAN BE PERSISTED. The plan states that as a caller
// contract; this module makes it STRUCTURAL instead (§ detail validation), because a caller contract
// is only as good as the least careful caller. Secret-shaped keys, oversized strings (the shape raw
// stdout arrives in), and absolute-path-shaped values are validation errors, so the append fails
// loudly rather than writing the thing the invariant forbids.
//
// Zero npm dependencies — node:* only; macOS + Windows.

import { createHash } from 'node:crypto';

/** The schema version this module writes and reads natively. */
export const EVENT_SCHEMA_VERSION = 1;

/** Lifecycle event types, version 1. Ordered as the lifecycle runs, not alphabetically. */
export const EVENT_TYPES = Object.freeze([
  'run.created',
  'run.approved',
  'run.started',
  'step.started',
  'step.completed',
  'step.failed',
  'run.blocked',
  'run.reconciled',
  'run.completed',
  'run.failed',
]);

/** Status values, version 1. */
export const STATUSES = Object.freeze(['pending', 'running', 'succeeded', 'failed', 'blocked']);

/** The engines that append to a sidecar. A fourth engine is a schema change, not a config value. */
export const ENGINES = Object.freeze(['commander', 'gtd', 'cli-orchestrator']);

/** Who caused the transition. */
export const ACTOR_KINDS = Object.freeze(['skill', 'cli', 'agent', 'human']);

/** Field order every written record uses — determinism, so two runs diff cleanly. */
export const FIELD_ORDER = Object.freeze([
  'schema_version',
  'event_id',
  'sequence',
  'timestamp',
  'run_id',
  'work_item',
  'engine',
  'event',
  'status',
  'actor',
  'refs',
  'detail',
]);

/** Fields the WRITER assigns. A caller supplying one is an error — see {@link validateIntent}. */
export const WRITER_ASSIGNED = Object.freeze(['sequence', 'timestamp']);

/** Ceiling on any single string inside `detail`. Raw stdout does not fit, on purpose. */
export const DETAIL_STRING_MAX = 4096;

/** Ceiling on the serialized `detail` object. A record stays one readable line. */
export const DETAIL_BYTES_MAX = 16384;

/** Ceiling on `refs`. A transition references a handful of things, never a directory listing. */
export const REFS_MAX = 64;

/** The diagnostic code an engine reports when its sidecar append failed. See {@link DUAL_WRITE_STEPS}. */
export const DIVERGED_CODE = 'event-sidecar-diverged';

/**
 * The dual-write policy, in the order an engine performs it.
 *
 * Legacy state is authoritative, so it is mutated FIRST and never rolled back to match the sidecar;
 * the sidecar is allowed to lag, never to lead. Preflight comes before the legacy mutation because a
 * missing CLI discovered afterwards would leave a transition that can never be recorded. And step 5
 * is the only repair: a resume APPENDS `run.reconciled` carrying the legacy digest, rather than
 * back-filling the events that were never written — a fabricated history is worse than a gap,
 * because it reads as evidence.
 */
export const DUAL_WRITE_STEPS = Object.freeze([
  Object.freeze({
    step: 1,
    id: 'preflight',
    summary: 'Verify the artifacts-events CLI is reachable BEFORE mutating legacy state.',
  }),
  Object.freeze({
    step: 2,
    id: 'mutate-legacy',
    summary: 'Mutate the engine\'s own durable state first — it stays the resume authority.',
  }),
  Object.freeze({
    step: 3,
    id: 'append-sidecar',
    summary: 'Append the event with a DETERMINISTIC engine event_id, so a retry is idempotent.',
  }),
  Object.freeze({
    step: 4,
    id: 'halt-on-divergence',
    summary:
      `If the append fails, halt the engine before its next transition and report ${DIVERGED_CODE}; `
      + 'legacy state remains authoritative and resumable.',
  }),
  Object.freeze({
    step: 5,
    id: 'reconcile-on-resume',
    summary:
      'On every resume, compare the sidecar with current legacy state; when the current transition '
      + 'is absent, append run.reconciled with the legacy digest and current state. Never fabricate '
      + 'missing historical events.',
  }),
]);

// ---------------------------------------------------------------------------
// Portability primitives
// ---------------------------------------------------------------------------

/**
 * Absolute-path shapes, in every spelling that reaches a string on a supported platform.
 *
 * POSIX absolute (`/Users/...`), a home shorthand (`~/...`), a Windows drive path (`C:\...` or
 * `C:/...`) and a UNC share (`\\host\share`). Anchored at a string start or at a delimiter so a
 * value that merely CONTAINS one ("wrote /Users/x/out.log") is caught too — that is the shape a
 * machine path actually leaks in.
 */
const ABSOLUTE_PATH_RE =
  /(^|[\s"'`(,;:=[{<])(~[/\\]|[/\\]{2}[A-Za-z0-9._-]+[/\\]|[A-Za-z]:[/\\]|\/(Users|home|root|Volumes|private|tmp|var|opt|srv|mnt|media|Applications|Library|System|proc|dev|etc|usr)\/)/;

/**
 * The offending token when `text` carries a machine-absolute path, else null.
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function findAbsolutePath(text) {
  if (typeof text !== 'string') return null;
  const m = ABSOLUTE_PATH_RE.exec(text);
  if (!m) return null;
  return text.slice(m.index, Math.min(text.length, m.index + 60)).trim();
}

/**
 * A portable identifier: a non-empty, single-line string that is not a machine path.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPortableId(value) {
  if (typeof value !== 'string') return false;
  if (value === '' || value.trim() !== value) return false;
  if (/[\r\n\t]/.test(value)) return false;
  return findAbsolutePath(value) === null;
}

/** Key spellings that name a credential. A `detail` carrying one is refused, never redacted. */
const SECRET_KEY_RE =
  /(pass(word|wd|phrase)|secret|token|api[-_]?key|private[-_]?key|credential|authorization|auth[-_]?header|bearer|session[-_]?id|cookie|access[-_]?key|client[-_]?secret|signing[-_]?key)/i;

/**
 * A repo-relative POSIX path, with `\` folded to `/` — the one form a ref path is stored in.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeRefPath(value) {
  return String(value).split('\\').join('/');
}

// ---------------------------------------------------------------------------
// Canonicalization — the idempotency key's other half
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted by code point, array order preserved.
 *
 * `event_id` is the idempotency key, but "same id, same intent" needs a byte-stable comparison of the
 * intent too, and two callers may build the same object with keys in different orders. Array order is
 * NOT sorted: `refs` order is the caller's meaning, so reordering it is a different intent.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const body = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
    .join(',');
  return `{${body}}`;
}

/**
 * The comparable form of an intent — everything EXCEPT what the writer assigns.
 *
 * `sequence` and `timestamp` are assigned under the lock, so they differ between the first attempt
 * and a retry of the same logical transition. Excluding them is what makes a retried dual-write a
 * `duplicate` rather than a conflict.
 *
 * @param {object} intent
 * @returns {string}
 */
export function normalizedIntent(intent) {
  const src = intent || {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of FIELD_ORDER) {
    if (WRITER_ASSIGNED.includes(key)) continue;
    if (src[key] === undefined) continue;
    out[key] = src[key];
  }
  if (out.schema_version === undefined) out.schema_version = EVENT_SCHEMA_VERSION;
  if (out.work_item === undefined) out.work_item = null;
  if (out.refs === undefined) out.refs = [];
  if (out.detail === undefined) out.detail = {};
  return canonicalJson(out);
}

/**
 * A DETERMINISTIC event id for the dual-write path (policy step 3).
 *
 * Determinism is the point: an engine that crashed between mutating legacy state and appending the
 * event retries with the same id, and the store answers `duplicate` instead of writing the
 * transition twice. So the id is built only from facts that identify the TRANSITION — never from a
 * clock, a pid, or a random value.
 *
 * @param {{engine: string, run_id: string, event: string, step?: string|number|null,
 *          attempt?: string|number|null}} parts
 * @returns {string}
 */
export function deterministicEventId(parts) {
  const p = parts || {};
  const segs = [p.engine, p.run_id, p.event];
  if (p.step !== undefined && p.step !== null && p.step !== '') segs.push(String(p.step));
  if (p.attempt !== undefined && p.attempt !== null && p.attempt !== '') segs.push(`a${p.attempt}`);
  return segs
    .map((s) => String(s).trim().replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter((s) => s !== '')
    .join('|');
}

/**
 * A digest of the engine's LEGACY state — the thing `run.reconciled` carries.
 *
 * The digest, not the state: legacy state is arbitrarily large and may itself hold paths or command
 * output, neither of which may be persisted here. A digest proves "the sidecar was reconciled
 * against exactly this legacy state" without copying it.
 *
 * @param {unknown} legacyState
 * @returns {string} `sha256:<hex>`
 */
export function legacyStateDigest(legacyState) {
  return `sha256:${createHash('sha256').update(canonicalJson(legacyState), 'utf8').digest('hex')}`;
}

/**
 * Build the `run.reconciled` intent a resume appends when the current transition is missing
 * (dual-write policy step 5).
 *
 * @param {{engine: string, run_id: string, work_item?: string|null, actor: {kind: string, id: string},
 *          legacy_state: unknown, current_state: string, status?: string,
 *          missing_event?: string|null, refs?: object[]}} input
 * @returns {object} an intent ready for `appendEvent`
 */
export function reconciliationIntent(input) {
  const i = input || {};
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: deterministicEventId({
      engine: i.engine,
      run_id: i.run_id,
      event: 'run.reconciled',
      step: legacyStateDigest(i.legacy_state).slice(7, 19),
    }),
    run_id: i.run_id,
    work_item: i.work_item ?? null,
    engine: i.engine,
    event: 'run.reconciled',
    status: i.status ?? 'running',
    actor: i.actor,
    refs: i.refs ?? [],
    detail: {
      legacy_state_digest: legacyStateDigest(i.legacy_state),
      current_state: String(i.current_state),
      missing_event: i.missing_event ?? null,
      note: 'Reconciled against legacy state on resume; historical events are NOT fabricated.',
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate one `detail` / `refs` payload for the two things that must never be persisted.
 *
 * @param {unknown} value
 * @param {string} path - dotted location, for the message
 * @param {string[]} errors - accumulator
 */
function checkPayload(value, path, errors) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > DETAIL_STRING_MAX) {
      errors.push(
        `${path}: string exceeds ${DETAIL_STRING_MAX} bytes — raw command output is never stored `
        + 'inline; store a bounded summary or a repo-relative path to the captured file',
      );
    }
    const abs = findAbsolutePath(value);
    if (abs !== null) {
      errors.push(`${path}: machine-absolute path is not portable (${JSON.stringify(abs)})`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkPayload(v, `${path}[${i}]`, errors));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) {
        errors.push(`${path}.${k}: secret-shaped key is refused — never persist a credential`);
        continue;
      }
      checkPayload(v, `${path}.${k}`, errors);
    }
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  errors.push(`${path}: ${typeof value} is not JSON-representable`);
}

/**
 * Validate a caller's APPEND INTENT — everything except the two writer-assigned fields.
 *
 * @param {unknown} intent
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateIntent(intent) {
  /** @type {string[]} */
  const errors = [];
  if (intent === null || typeof intent !== 'object' || Array.isArray(intent)) {
    return { ok: false, errors: ['intent must be a JSON object'] };
  }
  const it = /** @type {Record<string, unknown>} */ (intent);

  for (const key of WRITER_ASSIGNED) {
    if (it[key] !== undefined) {
      errors.push(`${key} is assigned by the writer under the lock — an intent must not supply it`);
    }
  }

  const sv = it.schema_version === undefined ? EVENT_SCHEMA_VERSION : it.schema_version;
  if (!Number.isInteger(sv)) {
    errors.push('schema_version must be an integer');
  } else if (sv !== EVENT_SCHEMA_VERSION) {
    errors.push(
      `schema_version ${sv} is not supported by this writer (writes ${EVENT_SCHEMA_VERSION})`,
    );
  }

  if (!isPortableId(it.event_id)) {
    errors.push('event_id must be a non-empty, single-line portable string (it is the idempotency key)');
  }
  if (!isPortableId(it.run_id)) errors.push('run_id must be a non-empty, single-line portable string');

  if (it.work_item !== undefined && it.work_item !== null && !isPortableId(it.work_item)) {
    errors.push('work_item must be null or a non-empty, single-line portable string');
  }

  if (!ENGINES.includes(/** @type {string} */ (it.engine))) {
    errors.push(`engine must be one of: ${ENGINES.join(', ')}`);
  }
  if (!EVENT_TYPES.includes(/** @type {string} */ (it.event))) {
    errors.push(`event must be one of: ${EVENT_TYPES.join(', ')}`);
  }
  if (!STATUSES.includes(/** @type {string} */ (it.status))) {
    errors.push(`status must be one of: ${STATUSES.join(', ')}`);
  }

  const actor = it.actor;
  if (actor === null || typeof actor !== 'object' || Array.isArray(actor)) {
    errors.push('actor must be an object with kind and id');
  } else {
    const a = /** @type {Record<string, unknown>} */ (actor);
    if (!ACTOR_KINDS.includes(/** @type {string} */ (a.kind))) {
      errors.push(`actor.kind must be one of: ${ACTOR_KINDS.join(', ')}`);
    }
    if (!isPortableId(a.id)) errors.push('actor.id must be a non-empty portable string');
    for (const k of Object.keys(a)) {
      if (k !== 'kind' && k !== 'id') errors.push(`actor.${k}: unknown field`);
    }
  }

  const refs = it.refs === undefined ? [] : it.refs;
  if (!Array.isArray(refs)) {
    errors.push('refs must be an array');
  } else if (refs.length > REFS_MAX) {
    errors.push(`refs holds ${refs.length} entries; at most ${REFS_MAX} are recorded`);
  } else {
    refs.forEach((ref, i) => {
      if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
        errors.push(`refs[${i}] must be an object with kind, optional id and optional path`);
        return;
      }
      const r = /** @type {Record<string, unknown>} */ (ref);
      if (!isPortableId(r.kind)) errors.push(`refs[${i}].kind must be a non-empty portable string`);
      if (r.id !== undefined && r.id !== null && !isPortableId(r.id)) {
        errors.push(`refs[${i}].id must be a non-empty portable string when present`);
      }
      if (r.path !== undefined && r.path !== null) {
        if (typeof r.path !== 'string' || r.path === '') {
          errors.push(`refs[${i}].path must be a non-empty string when present`);
        } else {
          const p = normalizeRefPath(r.path);
          if (findAbsolutePath(p) !== null || p.startsWith('/')) {
            errors.push(`refs[${i}].path must be REPO-RELATIVE, never machine-absolute (${JSON.stringify(r.path)})`);
          } else if (p.split('/').includes('..')) {
            errors.push(`refs[${i}].path must not escape the repo with '..' (${JSON.stringify(r.path)})`);
          }
        }
      }
      for (const k of Object.keys(r)) {
        if (k !== 'kind' && k !== 'id' && k !== 'path') errors.push(`refs[${i}].${k}: unknown field`);
      }
    });
  }

  const detail = it.detail === undefined ? {} : it.detail;
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
    errors.push('detail must be a JSON object');
  } else {
    checkPayload(detail, 'detail', errors);
    if (Buffer.byteLength(canonicalJson(detail), 'utf8') > DETAIL_BYTES_MAX) {
      errors.push(`detail exceeds ${DETAIL_BYTES_MAX} bytes serialized — summarize it`);
    }
  }

  for (const k of Object.keys(it)) {
    if (!FIELD_ORDER.includes(k)) errors.push(`${k}: unknown field for schema ${EVENT_SCHEMA_VERSION}`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a COMPLETE version-1 record — an intent plus the two writer-assigned fields.
 *
 * @param {unknown} record
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateEvent(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, errors: ['event must be a JSON object'] };
  }
  const rec = /** @type {Record<string, unknown>} */ (record);
  const errors = [];

  if (!Number.isInteger(rec.sequence) || /** @type {number} */ (rec.sequence) < 1) {
    errors.push('sequence must be an integer >= 1');
  }
  if (typeof rec.timestamp !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/.test(rec.timestamp)) {
    errors.push('timestamp must be RFC3339 with an explicit +07:00 (Asia/Bangkok) offset');
  }

  const { sequence, timestamp, ...intent } = rec;
  const inner = validateIntent(intent);
  errors.push(...inner.errors);

  return { ok: errors.length === 0, errors };
}

/**
 * Decide what a reader does with one parsed row: read it, skip it, or refuse the file.
 *
 * THE WHOLE SCHEMA NEGOTIATION LIVES HERE, and it is deliberately narrow. A row stamped with a
 * schema version this reader does not implement is a HARD ERROR by default: skipping it silently
 * would turn "I cannot read this run" into "this run had fewer events", which is the failure mode a
 * versioned format exists to prevent. The single escape hatch belongs to the WRITER, not the reader:
 * a future writer that knows a row is optional stamps `ignorable: true` on it, and this reader skips
 * it WITH A DIAGNOSTIC. An unknown `event` type follows the same rule for the same reason.
 *
 * @param {unknown} record
 * @returns {{kind: 'event'|'skip'|'error', code: string|null, message: string|null}}
 */
export function classifyRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { kind: 'error', code: 'event-not-object', message: 'event is not a JSON object' };
  }
  const rec = /** @type {Record<string, unknown>} */ (record);
  const ignorable = rec.ignorable === true;

  if (!Number.isInteger(rec.schema_version)) {
    return {
      kind: 'error',
      code: 'schema-version-missing',
      message: 'schema_version is absent or not an integer',
    };
  }
  if (rec.schema_version !== EVENT_SCHEMA_VERSION) {
    if (ignorable) {
      return {
        kind: 'skip',
        code: 'schema-version-ignorable',
        message: `skipped a row the writer marked ignorable at schema ${rec.schema_version}`,
      };
    }
    return {
      kind: 'error',
      code: 'schema-version-unsupported',
      message:
        `schema_version ${rec.schema_version} is required but unknown to this reader `
        + `(implements ${EVENT_SCHEMA_VERSION}); upgrade sidekicks rather than reading a partial run`,
    };
  }
  if (!EVENT_TYPES.includes(/** @type {string} */ (rec.event))) {
    if (ignorable) {
      return {
        kind: 'skip',
        code: 'event-type-ignorable',
        message: `skipped ignorable unknown event type ${JSON.stringify(rec.event)}`,
      };
    }
    return {
      kind: 'error',
      code: 'event-type-unknown',
      message:
        `event type ${JSON.stringify(rec.event)} is unknown and not marked ignorable`,
    };
  }
  return { kind: 'event', code: null, message: null };
}
