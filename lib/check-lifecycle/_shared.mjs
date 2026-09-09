// lib/check-lifecycle/_shared.mjs
// Shared primitives for the `sidekicks check …` verbs.
//
// Four jobs, each one a thing the result contract depends on:
//
//   1. FLAG PARSING. The dispatcher's global parseArgs runs with `strict: false` and declares only
//      --help/--version/--verbose, so `--profile quick` arrives as `{ profile: true }` plus a stray
//      positional `quick`, while `--profile=quick` arrives as `{ profile: 'quick' }`. Every verb
//      family that takes a valued flag therefore re-reads the raw argv, where the value/boolean
//      nature of each flag is known (lib/skill-lifecycle/_shared.mjs, lib/catalog-lifecycle/
//      _shared.mjs, lib/framework-lifecycle/_shared.mjs all do the same). A LOCAL copy rather than
//      an import from one of those, for the reason catalog gives: `package transfer` ships
//      individual lib subsystems by import closure, and a check runner that dragged
//      skill-lifecycle in would carry the whole skill toolchain with it.
//
//   2. TAILS. A gate's captured output is bounded at TAIL_BYTES from the END (the failing tail is
//      the useful half) and normalized to LF, so a Windows child's CRLF stream and a macOS child's
//      LF stream produce the same row for the same failure.
//
//   3. TIMESTAMPS. Asia/Bangkok with an explicit +07:00 offset (CLAUDE.md § Timezone), taken from an
//      INJECTED clock so a fixture run is byte-deterministic while a production run is real.
//
//   4. READING THE RESULT BACK. `readCheckRun` is the one reader of the json this contract emits, so
//      that a caller judging a `check run` cannot invent its own answer to "did it pass" — which is
//      exactly what the release gate did, twice, in two different wrong ways (INC-2026-09-09).
//
// Zero npm dependencies — node:* only; macOS + Windows.

/** Per-gate capture ceiling, per stream. The final 64 KiB of each. */
export const TAIL_BYTES = 65536;

/**
 * Parse `--flag`, `--flag=value` and `--flag value` out of a raw argv slice.
 *
 * @param {string[]} argv - the raw argv the dispatcher was handed (ctx.argv)
 * @param {string[]} booleans - flags that never take a value
 * @returns {Record<string, string|boolean>}
 */
export function parseCheckFlags(argv, booleans = []) {
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
 * The positionals of a raw argv slice, in order (flag VALUES excluded).
 *
 * `check run quick` has to keep working alongside `--profile quick`, and the dispatcher's own
 * positional list cannot be trusted for it: with `strict: false` the value of a space-form valued
 * flag lands there too, so `check run --profile quick` would otherwise look like the positional
 * form. Re-derived here where the boolean set is known.
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
 * The final {@link TAIL_BYTES} bytes of a captured stream, LF-normalized.
 *
 * @param {Buffer|string|null|undefined} chunk
 * @returns {string}
 */
export function tail(chunk) {
  if (chunk === null || chunk === undefined) return '';
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  const cut = buf.length > TAIL_BYTES ? buf.subarray(buf.length - TAIL_BYTES) : buf;
  return cut.toString('utf8').split('\r\n').join('\n').split('\r').join('\n');
}

/**
 * An ISO-8601 instant with the Asia/Bangkok (+07:00) offset.
 *
 * Asia/Bangkok is a fixed +07:00 with no DST, but the wall-clock split still goes through Intl
 * rather than arithmetic on the epoch, matching lib/memory-lifecycle/_shared.mjs.
 *
 * @param {number} epochMs
 * @returns {string} e.g. "2026-08-18T20:30:00+07:00"
 */
export function bangkokTimestamp(epochMs) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]),
  );
  // hour12:false can yield "24" at midnight in some ICU builds — normalize to "00".
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}+07:00`;
}

/**
 * Replace every occurrence of a temporary root with a placeholder.
 *
 * The package and mounted-core gates work inside a temp directory, and its path is
 * machine-absolute. Nothing may carry one out of the gate (CLAUDE.md § Portable paths), and a
 * redacted tail also compares equal between two machines.
 *
 * @param {string} text
 * @param {string[]} roots - absolute paths to redact
 * @returns {string}
 */
export function redactRoots(text, roots = []) {
  let out = String(text ?? '');
  for (const root of roots) {
    if (!root) continue;
    for (const form of [root, root.split('\\').join('/')]) {
      if (!form) continue;
      out = out.split(form).join('<tmp>');
    }
  }
  return out;
}

/**
 * Read a `check run --json` result: the profile's own verdict, and the rows worth reporting.
 *
 * WHY A READER EXISTS AT ALL. Two defects, both in the framework-core release path's mount gate,
 * both from that gate answering "did the profile pass" for itself (INC-2026-09-09).
 *
 * 1. THE EXIT CODE IS NOT THE VERDICT. `runProfile` exits 1 when ANY gate did not clear — including
 *    a NON-BLOCKING one, deliberately, because a skip is not a pass. `installer.pwsh` is
 *    non-blocking and reports `skipped` wherever `pwsh` is absent, which is most macOS machines. So
 *    the runner said `"status": "passed"` and exited 1, and a caller reading only the exit code
 *    called a passing mount a failed one on every host without PowerShell Core. `status` is the
 *    field that means "a BLOCKING gate did not clear" — the one a release may refuse on. The skips
 *    are still returned, so a caller reports them rather than swallowing them.
 *
 * 2. A BLIND TAIL CANNOT DIAGNOSE IT. The json lists every gate in profile order, and the rows at
 *    the END are the trailing non-blocking ones plus the gates BLOCKED behind the real failure. So
 *    the last lines of a red run show a skip and a dependency notice while the row that actually
 *    failed — with the test output inside it — has already scrolled past. That is how a release
 *    halted with `mount-check-tests.all-dependency-failed` and no test-level cause in its record.
 *
 * `tail` orders FAILED rows first with their captured output, then the merely blocked ones as a
 * one-line list. A wall of "dependency X did not pass" is what buried the cause the first time.
 *
 * @param {string} text - a `check run --json` invocation's whole output; leading human lines are
 *   tolerated, so a caller may pass a combined stdout+stderr capture.
 * @returns {{status: string, failed: object[], blocked: object[], skipped: object[], tail: string}
 *          |null} null when no result json could be read — which a caller must treat as a failure
 *   to judge, never as a pass.
 */
export function readCheckRun(text) {
  const raw = String(text ?? '');
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open === -1 || close <= open) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(open, close + 1));
  } catch {
    return null;
  }
  const gates = Array.isArray(parsed && parsed.gates) ? parsed.gates : null;
  if (!gates || typeof parsed.status !== 'string') return null;

  const of = (status) => gates.filter((g) => g && g.status === status);
  const failed = of('failed');
  const blocked = of('blocked');
  const skipped = of('skipped');

  const lines = [];
  for (const g of failed) {
    const exit = g.exit_code === null || g.exit_code === undefined ? '' : ` (exit ${g.exit_code})`;
    lines.push(`── ${g.id}: FAILED${exit}`);
    if (g.reason) lines.push(`   ${g.reason}`);
    // The gate's own captured output is where a failing TEST is named. Keep the tail of it: node
    // --test prints its "failing tests:" summary last, which is exactly the part worth carrying.
    for (const [what, out] of [['stdout', g.stdout_tail], ['stderr', g.stderr_tail]]) {
      const body = String(out || '').trimEnd();
      if (!body) continue;
      lines.push(`   ${what}:`);
      for (const l of body.split('\n').slice(-40)) lines.push(`     ${l}`);
    }
  }
  if (blocked.length) lines.push(`── blocked behind the above: ${blocked.map((g) => g.id).join(', ')}`);

  return { status: parsed.status, failed, blocked, skipped, tail: lines.join('\n') };
}
