// .agents/skills/sk-commander/scripts/run-event.mjs
//
// The commander's leg of the version-1 RUN-EVENT DUAL WRITE. One command per policy step, so the
// Workflow script and the fallback path share exactly one implementation.
//
// WHAT THE SIDECAR IS. `<run-dir>/events.v1.jsonl` is a DIAGNOSTIC AUDIT TRAIL. The commander's
// resume source of truth does NOT change: it is still the Workflow journal (`resumeFromRunId`) plus
// the `stages` array the script returns. Nothing here is ever read to decide where a run resumes,
// and no legacy state is rewritten, replayed from, or deleted. The sidecar answers "what happened,
// in order, and who did it" for a human or a doctor reading a finished run.
//
// WHY A SCRIPT AND NOT INLINE COMMANDS. Two reasons, both structural:
//   1. A Workflow script has NO filesystem access and cannot call `Date.now()`/`Math.random()`, so it
//      cannot write an intent file or compute a digest. It delegates to a subagent, and a subagent
//      brief must carry ONE literal command — a `node --eval` snippet with embedded JSON does not
//      survive quoting on both macOS and Windows (Git Bash).
//   2. `run.reconciled` carries `legacy_state_digest` — a sha256 over CANONICAL JSON. Only the
//      framework module can compute that identically to every other engine, so this script imports
//      `lib/run-events/schema.mjs` rather than re-deriving it (the plan's "one authority" rule).
//
// THE WRITE ITSELF ALWAYS GOES THROUGH THE CLI. `sidekicks artifacts events append` owns the lock,
// the sequence assignment and the tail-recovery policy; this script only builds the intent. That is
// the same contract the CLI-orchestrator engine's Python leg (scripts/ledger.py) follows, which is why
// the two agree. (Naming that engine here is provenance, not a dependency: nothing in this file calls it.)
//
// EXIT CODES (the caller's whole decision table)
//   0  done — appended, duplicate (idempotent retry), in-sync, or nothing to reconcile
//   2  invalid arguments, or an intent this schema refuses
//   3  event-sidecar-diverged — the append failed. Dual-write policy step 4: the caller HALTS before
//      its next transition. Legacy state stays authoritative and resumable.
//   4  the sidecar subsystem is UNAVAILABLE here (preflight only) — an older CLI, or a lifted skill
//      copy in a repo without lib/run-events. The caller runs with event recording OFF and says so;
//      it never halts a sequence over a missing diagnostic.
//
// Zero npm dependencies — node:* only; macOS + Windows (pure node:path, spawnSync with shell:false).

import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This engine's name in the version-1 `engine` enum. Not a knob: a fourth engine is a schema change. */
const ENGINE = 'commander';

/** Exit codes, named where they are decided. */
const EXIT_OK = 0;
const EXIT_ARGS = 2;
const EXIT_DIVERGED = 3;
const EXIT_UNAVAILABLE = 4;

/** The code the dual-write policy names for a failed append. */
const DIVERGED = 'event-sidecar-diverged';

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/**
 * Parse `--flag`, `--flag=value` and `--flag value`. Repeatable flags collect into an array.
 *
 * @param {string[]} argv
 * @returns {{subcommand: string, flags: Record<string, string|boolean|string[]>}}
 */
export function parseArgv(argv) {
  const repeatable = new Set(['detail', 'ref']);
  const booleans = new Set(['json', 'help']);
  const list = Array.isArray(argv) ? argv.slice() : [];
  const subcommand = list.length > 0 && !list[0].startsWith('--') ? String(list.shift()) : '';
  /** @type {Record<string, string|boolean|string[]>} */
  const flags = {};
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string' || !tok.startsWith('--')) continue;
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    let value;
    if (eq !== -1) value = body.slice(eq + 1);
    else if (booleans.has(key)) value = true;
    else if (i + 1 < list.length && !String(list[i + 1]).startsWith('--')) value = String(list[++i]);
    else value = true;
    if (repeatable.has(key)) {
      const prev = Array.isArray(flags[key]) ? /** @type {string[]} */ (flags[key]) : [];
      prev.push(String(value));
      flags[key] = prev;
    } else {
      flags[key] = value;
    }
  }
  return { subcommand, flags };
}

/** A required string flag, or a hard argument error. */
function need(flags, key) {
  const v = flags[key];
  if (typeof v !== 'string' || v === '') fail(EXIT_ARGS, `--${key} is required`);
  return /** @type {string} */ (v);
}

/** An optional string flag, or ''. */
function opt(flags, key) {
  const v = flags[key];
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// Repo resolution
// ---------------------------------------------------------------------------

/**
 * The nearest ancestor of `from` holding a `.sidekicks/` directory.
 *
 * @param {string} from
 * @returns {string|null}
 */
export function findRepoRoot(from) {
  let r = path.resolve(from);
  while (!existsSync(path.join(r, '.sidekicks'))) {
    const up = path.dirname(r);
    if (up === r) return null;
    r = up;
  }
  return r;
}

// ---------------------------------------------------------------------------
// Payload hygiene — why an append does not fail on a step's own error text
// ---------------------------------------------------------------------------

/**
 * Make one detail value safe to persist: single-line, bounded, and carrying no machine-absolute path.
 *
 * A step's failure reason is the most useful thing in the sidecar and the most likely to carry a
 * `/Users/...` path or a 40 KB stdout tail — both of which `validateIntent` refuses outright. Left
 * raw, the append would fail and the policy would halt a real pipeline over the shape of an error
 * message. So the value is scrubbed HERE, before the intent is built, and the loss is visible in the
 * record (`<path-redacted>`, a trailing ellipsis) rather than silent.
 *
 * @param {unknown} value
 * @param {(t: unknown) => string|null} findAbsolutePath - the framework's own detector
 * @param {number} max
 * @returns {string|number|boolean|null}
 */
export function scrubDetail(value, findAbsolutePath, max = 480) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  let s = String(value).replace(/[\r\n\t]+/g, ' ').trim();
  // TOKEN-WISE, not window-wise: the detector reports a 60-character slice, and replacing only that
  // slice leaves a remnant carrying most of the machine path while no longer matching the detector.
  s = s.split(/(\s+)/).map((tok) => (findAbsolutePath(tok) ? '<path-redacted>' : tok)).join('');
  // A shape that survives is dropped whole: an append that would be REFUSED is worse than a detail
  // field that says it was withheld.
  if (findAbsolutePath(s)) s = '<withheld: value carried a machine-absolute path>';
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/** `k=v` pairs into a flat detail object; an all-digits value becomes a number. */
function buildDetail(pairs, findAbsolutePath) {
  /** @type {Record<string, unknown>} */
  const detail = {};
  for (const raw of pairs) {
    const eq = String(raw).indexOf('=');
    if (eq <= 0) fail(EXIT_ARGS, `--detail expects key=value, got ${JSON.stringify(raw)}`);
    const key = String(raw).slice(0, eq);
    const value = String(raw).slice(eq + 1);
    detail[key] = /^-?\d+$/.test(value) ? Number(value) : scrubDetail(value, findAbsolutePath);
  }
  return detail;
}

/**
 * `kind=<k>[,id=<i>][,path=<p>]` into a ref object, with the path made repo-relative.
 *
 * `refs[].path` MUST be repo-relative (`validateIntent`), and a commander step's `work_dir` is
 * sometimes absolute. An absolute path inside the repo is relativized; one outside it loses its
 * `path` and keeps its `kind`/`id`, because a ref that names the right thing without a path is
 * still true, and a rejected intent is a halted pipeline.
 */
function buildRef(raw, repoRoot) {
  /** @type {Record<string, string>} */
  const parts = {};
  for (const seg of String(raw).split(',')) {
    const eq = seg.indexOf('=');
    if (eq <= 0) fail(EXIT_ARGS, `--ref expects kind=<k>[,id=<i>][,path=<p>], got ${JSON.stringify(raw)}`);
    parts[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  }
  if (!parts.kind) fail(EXIT_ARGS, `--ref needs a kind= segment, got ${JSON.stringify(raw)}`);
  /** @type {{kind: string, id?: string, path?: string}} */
  const ref = { kind: parts.kind };
  if (parts.id) ref.id = parts.id;
  if (parts.path) {
    let p = parts.path;
    if (path.isAbsolute(p) || /^[A-Za-z]:[/\\]/.test(p)) {
      const rel = path.relative(repoRoot, path.resolve(p));
      p = rel === '' ? '.' : rel.split(path.sep).join('/');
      if (p === '.' || p.split('/').includes('..')) return ref;   // outside the repo — keep kind/id only
    } else {
      p = p.split('\\').join('/');
      if (p.split('/').includes('..')) return ref;
    }
    ref.path = p;
  }
  return ref;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

let JSON_MODE = false;

/** Print a payload and exit 0. */
function done(payload) {
  if (JSON_MODE) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${payload.result} — ${payload.reason || payload.event || ''}\n`);
  process.exit(EXIT_OK);
}

/** Print a failure and exit with `code`. Never throws past here. */
function fail(code, reason, extra = {}) {
  const payload = { ok: false, result: code === EXIT_DIVERGED ? DIVERGED : 'error', reason, ...extra };
  if (JSON_MODE) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.stderr.write(`${code === EXIT_DIVERGED ? `${DIVERGED}: ` : ''}${reason}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// The CLI is the only writer
// ---------------------------------------------------------------------------

/**
 * Invoke `sidekicks artifacts events <args…>` with an argv array and `shell: false`.
 *
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function events(repoRoot, args) {
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'sidekicks'), 'artifacts', 'events', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
  });
  if (r.error) return { status: 127, stdout: '', stderr: String(r.error.message || r.error) };
  return { status: r.status === null ? 129 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Append one intent through the CLI, via a temp file removed in `finally`. */
function appendIntent(repoRoot, runDir, intent) {
  const tmp = path.join(runDir, `.events-intent-${process.pid}-${process.hrtime.bigint()}.json`);
  try {
    writeFileSync(tmp, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
    const r = events(repoRoot, ['append', runDir, `--input=${tmp}`, '--json']);
    if (r.status !== 0) {
      fail(EXIT_DIVERGED, `append exited ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ')}`,
        { event: intent.event, event_id: intent.event_id });
    }
    let body = {};
    try { body = JSON.parse(r.stdout); } catch { /* the append succeeded; a JSON hiccup is not divergence */ }
    return body;
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** Dual-write policy step 1 — is the sidecar reachable BEFORE any legacy state is mutated. */
function cmdPreflight(repoRoot, runDir) {
  if (!existsSync(path.join(repoRoot, 'lib', 'run-events', 'schema.mjs'))
      || !existsSync(path.join(repoRoot, 'bin', 'sidekicks'))) {
    fail(EXIT_UNAVAILABLE, 'this repo has no lib/run-events — run with event recording OFF and say so in the report');
  }
  mkdirSync(runDir, { recursive: true });   // appendEvent refuses to create a run dir, by design
  const r = events(repoRoot, ['check', runDir, '--json']);
  if (r.status === 1 || r.status === 3) {
    fail(EXIT_UNAVAILABLE,
      `the existing sidecar in ${path.basename(runDir)} is not appendable (check exited ${r.status}) — `
      + 'run with event recording OFF, report it, and repair with `sidekicks artifacts events check`');
  }
  if (r.status !== 0) {
    fail(EXIT_UNAVAILABLE, `\`artifacts events\` is unavailable here (exit ${r.status}) — run with event recording OFF`);
  }
  let body = {};
  try { body = JSON.parse(r.stdout); } catch { /* an unparsable OK is still an OK */ }
  done({ ok: true, result: 'available', run_dir: runDir, present: body.present ?? null, count: body.count ?? null, next_sequence: body.next_sequence ?? null });
}

/** Dual-write policy step 3 — append the event for a transition the engine has ALREADY made. */
async function cmdAppend(repoRoot, runDir, flags, schema) {
  const { EVENT_SCHEMA_VERSION, deterministicEventId, validateIntent, findAbsolutePath } = schema;
  const runId = need(flags, 'run-id');
  const event = need(flags, 'event');
  const status = need(flags, 'status');
  const step = opt(flags, 'step');
  const attempt = opt(flags, 'attempt');
  const detail = buildDetail(Array.isArray(flags.detail) ? flags.detail : [], findAbsolutePath);
  if (step) detail.step = detail.step ?? step;
  if (attempt) detail.attempt = Number(attempt);
  const refs = (Array.isArray(flags.ref) ? flags.ref : []).map((r) => buildRef(r, repoRoot));

  const intent = {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: deterministicEventId({ engine: ENGINE, run_id: runId, event, step, attempt }),
    run_id: runId,
    work_item: opt(flags, 'work-item') || null,
    engine: ENGINE,
    event,
    status,
    actor: { kind: opt(flags, 'actor-kind') || 'skill', id: opt(flags, 'actor-id') || 'sk-commander' },
    refs,
    detail,
  };
  const v = validateIntent(intent);
  if (!v.ok) fail(EXIT_ARGS, `the intent is invalid: ${v.errors.join('; ')}`);
  const body = appendIntent(repoRoot, runDir, intent);
  done({ ok: true, result: body.result || 'appended', event, event_id: intent.event_id, sequence: body.sequence ?? null });
}

/**
 * Dual-write policy step 5 — reconcile the sidecar against CURRENT legacy state, before resuming.
 *
 * Only `run.reconciled` is ever written. The events that were never appended stay missing: a
 * fabricated history reads as evidence, which is worse than a gap that is recorded as one.
 */
async function cmdReconcile(repoRoot, runDir, flags, schema) {
  const { reconciliationIntent, legacyStateDigest, validateIntent } = schema;
  const runId = need(flags, 'run-id');
  const currentState = need(flags, 'current-state');
  const expectEvent = opt(flags, 'expect-event');
  const expectStep = opt(flags, 'expect-step');

  let legacy;
  const legacyFile = opt(flags, 'legacy-file');
  const legacyJson = opt(flags, 'legacy-json');
  if (legacyFile) {
    try { legacy = JSON.parse(readFileSync(path.resolve(legacyFile), 'utf8')); }
    catch (e) { fail(EXIT_ARGS, `--legacy-file could not be read as JSON: ${e.message}`); }
  } else if (legacyJson) {
    try { legacy = JSON.parse(legacyJson); }
    catch (e) { fail(EXIT_ARGS, `--legacy-json is not valid JSON: ${e.message}`); }
  } else {
    fail(EXIT_ARGS, 'one of --legacy-file or --legacy-json is required (the state the sidecar is reconciled AGAINST)');
  }

  const shown = events(repoRoot, ['show', runDir, '--json']);
  if (shown.status !== 0) {
    fail(EXIT_DIVERGED, `show exited ${shown.status}: ${(shown.stderr || shown.stdout || '').trim().split('\n').slice(-3).join(' ')}`);
  }
  let replay = { present: false, events: [] };
  try { replay = JSON.parse(shown.stdout); } catch (e) { fail(EXIT_DIVERGED, `show returned unparsable JSON: ${e.message}`); }

  if (!replay.present || (replay.events || []).length === 0) {
    // Nothing recorded yet: there is no history to disagree with, so there is nothing to reconcile.
    done({ ok: true, result: 'not-needed', reason: 'the sidecar holds no events for this run — a fresh run, not a resume' });
  }
  if (expectEvent) {
    const hit = (replay.events || []).some((e) => e && e.event === expectEvent
      && (!expectStep || String((e.detail && e.detail.step) ?? '') === expectStep));
    if (hit) {
      done({ ok: true, result: 'in-sync', reason: `${expectEvent}${expectStep ? ` (step ${expectStep})` : ''} is already recorded`, count: replay.count ?? null });
    }
  }

  const intent = reconciliationIntent({
    engine: ENGINE,
    run_id: runId,
    work_item: opt(flags, 'work-item') || null,
    actor: { kind: opt(flags, 'actor-kind') || 'skill', id: opt(flags, 'actor-id') || 'sk-commander' },
    legacy_state: legacy,
    current_state: currentState,
    status: opt(flags, 'status') || 'running',
    missing_event: expectEvent || null,
  });
  const v = validateIntent(intent);
  if (!v.ok) fail(EXIT_ARGS, `the reconciliation intent is invalid: ${v.errors.join('; ')}`);
  const body = appendIntent(repoRoot, runDir, intent);
  done({
    ok: true,
    result: body.result === 'duplicate' ? 'duplicate' : 'reconciled',
    event: 'run.reconciled',
    legacy_state_digest: legacyStateDigest(legacy),
    missing_event: expectEvent || null,
    sequence: body.sequence ?? null,
  });
}

const USAGE = [
  'usage: run-event.mjs preflight  --run-dir <dir> [--root <dir>] [--json]',
  '       run-event.mjs append     --run-dir <dir> --run-id <id> --event <type> --status <s>',
  '                                [--step <label>] [--attempt <n>] [--work-item <wi>]',
  '                                [--detail k=v]… [--ref kind=<k>[,id=<i>][,path=<p>]]… [--json]',
  '       run-event.mjs reconcile  --run-dir <dir> --run-id <id> --current-state <s>',
  '                                (--legacy-file <p> | --legacy-json <j>) [--expect-event <type>]',
  '                                [--expect-step <label>] [--work-item <wi>] [--json]',
  '',
  'The sidecar is a DIAGNOSTIC audit trail. The commander resumes from its Workflow journal, never',
  'from these events. Exit 3 means event-sidecar-diverged (halt before the next transition); exit 4',
  'means the subsystem is absent here (run with recording OFF, never halt over a missing diagnostic).',
].join('\n');

/** @returns {Promise<void>} */
export async function main(argv) {
  const { subcommand, flags } = parseArgv(argv);
  JSON_MODE = flags.json === true;
  if (flags.help === true || subcommand === '' || subcommand === 'help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(flags.help === true || subcommand === 'help' ? EXIT_OK : EXIT_ARGS);
  }
  if (!['preflight', 'append', 'reconcile'].includes(subcommand)) {
    fail(EXIT_ARGS, `unknown subcommand '${subcommand}'\n${USAGE}`);
  }

  const repoRoot = findRepoRoot(opt(flags, 'root') || process.cwd());
  if (!repoRoot) fail(EXIT_UNAVAILABLE, 'no .sidekicks/ found above the working directory — cannot reach the events CLI');
  const runDir = path.resolve(need(flags, 'run-dir'));

  if (subcommand === 'preflight') return cmdPreflight(repoRoot, runDir);

  if (!existsSync(runDir)) {
    fail(EXIT_DIVERGED, `the run directory ${path.basename(runDir)} does not exist — preflight creates it; run preflight first`);
  }
  let schema;
  try {
    schema = await import(pathToFileURL(path.join(repoRoot, 'lib', 'run-events', 'schema.mjs')).href);
  } catch (e) {
    fail(EXIT_UNAVAILABLE, `lib/run-events/schema.mjs could not be loaded: ${e.message}`);
  }
  if (subcommand === 'append') return cmdAppend(repoRoot, runDir, flags, schema);
  return cmdReconcile(repoRoot, runDir, flags, schema);
}

// --- CLI ---------------------------------------------------------------------------------------
// Main-module guard: compare NATIVE realpaths. A hand-built `file://` + argv[1] string is false
// whenever the path is percent-encoded (a space), separated with `\` (Windows), or reached through
// the `.claude/skills` -> `.agents/skills` exposure link this repo ships (Rule 3). A false guard
// here would exit 0 having written NOTHING, which the caller would read as a successful append.
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(entry) && realpathSync(entry) === fileURLToPath(import.meta.url);
} catch { /* argv[1] is not a real file (e.g. `node --eval`) — not a direct invocation */ }
if (invokedDirectly) await main(process.argv.slice(2));
