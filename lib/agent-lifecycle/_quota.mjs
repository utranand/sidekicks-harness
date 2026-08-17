// lib/agent-lifecycle/_quota.mjs
// CLI quota / usage-limit classification — NOT a dispatchable verb.
//
// THE PROBLEM. The delegate classifies a wake with two bits: an exit-code-ish
// `ok`, and whether any pre-wake inbox id left new/. A wake that died because the
// agent CLI hit its plan quota is therefore indistinguishable from a wake that
// died because of a bug, so it gets the generic ladder — 30/60/120/240/300s of
// backoff, then exit 1 at roughly 12.5 minutes — while the message it claimed is
// requeued up to three times and then FAILED OUT to the user with
// "the work kept dying mid-run". A five-hour reset window turns into a dead lane
// and a destroyed message, and nothing anywhere says "quota".
//
// Meanwhile the information is already on the wire and thrown away: a claude wake
// returns `subtype`, `errors[]`, `terminal_reason` and a `result` string on every
// run, and `parseHeadlessResult` reads exactly four fields. For antigravity
// (`agy -p`, plain text, no JSON at all) the output TEXT is the only signal that
// exists, which is why this module is pattern-driven rather than schema-driven.
//
// THE EVIDENCE GATE IS STILL OPEN. docs/research/rate-limit-resume.md asks for a
// confirmed capture of a real usage-limit event, and this repo has never recorded
// one — the patterns below are the conventional shapes, not verified ones. So:
// every classification logs the RAW matched line, a match that carries no
// parseable reset instant falls back to a fixed cooldown, and the pattern list is
// config-extensible (`agent_daemon.defaults.quota.patterns`) so a vendor wording
// change is a config edit rather than a release. When the first real event lands,
// the log line is what confirms or corrects this.
//
// Bias: a FALSE POSITIVE pauses the lane until the resume instant and says so in
// `agent daemon status` (recoverable, visible). A FALSE NEGATIVE is exactly
// today's behaviour. So the patterns are kept tight rather than generous.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

/**
 * Conventional usage-limit shapes, per adapter.
 *
 * `epoch` captures a unix-seconds reset instant when the CLI reports one — that
 * is the wall-clock instant the resume is scheduled against, and it is strictly
 * better than any guess. `iso` captures a parseable timestamp. A pattern with
 * neither still classifies; it just falls back to the configured cooldown.
 */
export const BUILTIN_PATTERNS = {
  claude: [
    // The conventional claude shape: a `result` string carrying the reset epoch.
    { re: /usage limit reached\|(\d{9,})/i, epoch: 1 },
    { re: /Claude AI usage limit reached/i },
    { re: /\b5-hour limit reached\b/i },
    { re: /\busage limit\b.*\bresets? at\b\s*([^\n"]+)/i, iso: 1 },
    { re: /\brate[_ ]?limit(?:_error)?\b/i },
  ],
  antigravity: [
    // agy prints plain text, so text is all there is.
    { re: /\b(?:quota|usage limit)\b.*\b(?:exceeded|reached|exhausted)\b/i },
    { re: /\bresource[_ ]exhausted\b/i },
    { re: /\btoo many requests\b/i },
    { re: /\brate limit(?:ed)?\b.*\btry again\b/i },
  ],
  codex: [
    { re: /\busage limit\b.*\bresets? at\b\s*([^\n"]+)/i, iso: 1 },
    { re: /\b(?:quota|usage limit)\b.*\b(?:exceeded|reached|exhausted)\b/i },
    { re: /\brate[_ ]?limit(?:_error)?\b/i },
  ],
};

/** Patterns applied to every adapter, whatever its name. */
const UNIVERSAL_PATTERNS = [
  { re: /\bHTTP\s*429\b/ },
  { re: /"?status"?\s*[:=]\s*429\b/ },
];

/** How much of a matched line to keep as evidence. */
const MAX_EVIDENCE_LEN = 300;

/**
 * A quota pause is only believable within a bounded horizon. A reported reset
 * instant further out than this is treated as unparseable garbage rather than
 * silencing the lane for a month.
 */
export const MAX_RESUME_HORIZON_MS = 24 * 3600_000;

function compilePatterns(cliName, extra) {
  const own = BUILTIN_PATTERNS[String(cliName)] || [];
  const configured = [];
  for (const raw of Array.isArray(extra) ? extra : []) {
    const src = String(raw ?? '').trim();
    if (!src) continue;
    try {
      configured.push({ re: new RegExp(src, 'i'), configured: true });
    } catch {
      // A bad regex in config must not break wake classification; it is simply
      // not applied. The warning surfaces through the config normaliser.
    }
  }
  return [...configured, ...own, ...UNIVERSAL_PATTERNS];
}

/** The shortest decisive line containing the match, trimmed for a log. */
function evidenceFor(haystack, matchIndex) {
  const start = haystack.lastIndexOf('\n', matchIndex) + 1;
  const endRaw = haystack.indexOf('\n', matchIndex);
  const end = endRaw === -1 ? haystack.length : endRaw;
  const line = haystack.slice(start, end).trim();
  const compact = line.replace(/\s{2,}/g, ' ');
  return compact.length > MAX_EVIDENCE_LEN ? `${compact.slice(0, MAX_EVIDENCE_LEN - 1)}…` : compact;
}

/**
 * Resolve a reset instant out of a pattern match. Returns null when the pattern
 * carries none, when it does not parse, or when it lands outside the believable
 * horizon.
 */
function resumeFromMatch(pattern, match, nowMs) {
  if (pattern.epoch != null) {
    const secs = Number(match[pattern.epoch]);
    if (Number.isFinite(secs) && secs > 0) {
      // Seconds or milliseconds — a 13-digit value is already ms.
      const ms = secs > 1e12 ? secs : secs * 1000;
      if (ms > nowMs && ms - nowMs <= MAX_RESUME_HORIZON_MS) return ms;
    }
    return null;
  }
  if (pattern.iso != null) {
    const raw = String(match[pattern.iso] ?? '').trim().replace(/[.,;)\]]+$/, '');
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > nowMs && parsed - nowMs <= MAX_RESUME_HORIZON_MS) return parsed;
    return null;
  }
  return null;
}

/**
 * Did this wake stall on a usage limit, and when may the lane resume?
 *
 * PURE — every input, including the clock, arrives as a parameter.
 *
 * Only a FAILED wake is examined: a successful wake that happens to mention a
 * rate limit somewhere in its output (an agent reading this very file, say) must
 * never pause the lane. That check is the difference between a classifier and a
 * grep.
 *
 * @param {object} input
 * @param {string} input.cliName        the adapter (claude | antigravity | codex)
 * @param {object} input.outcome        the delegate's wake outcome
 * @param {string} [input.stdout]       buffered wake stdout
 * @param {string} [input.stderrTail]   bounded tail of wake stderr
 * @param {object} input.cfg            the normalised agent_daemon quota block
 * @param {number} input.nowMs
 * @returns {{quota:boolean, resumeAtMs:number|null, evidence:string, source:'json'|'text'|'fallback', pattern:string}}
 */
export function classifyWakeStall({ cliName, outcome, stdout, stderrTail, cfg, nowMs }) {
  const no = { quota: false, resumeAtMs: null, evidence: '', source: 'text', pattern: '' };
  if (!cfg || cfg.enabled === false) return no;
  if (!outcome || outcome.ok) return no;

  // The outcome already carries the wake's output; the explicit params are an
  // override for callers that hold it separately. Defaulting to the outcome means
  // a caller cannot silently classify against nothing by forgetting a field.
  const out = stdout === undefined ? outcome.stdout : stdout;
  const err = stderrTail === undefined ? outcome.stderrTail : stderrTail;
  const haystack = `${String(out || '')}\n${String(err || '')}`;
  if (!haystack.trim()) return no;

  for (const pattern of compilePatterns(cliName, cfg.patterns)) {
    const match = pattern.re.exec(haystack);
    if (!match) continue;
    const resumeAtMs = resumeFromMatch(pattern, match, nowMs);
    const cooldownMs = Math.max(60, Number(cfg.default_cooldown_seconds) || 3600) * 1000;
    return {
      quota: true,
      resumeAtMs: resumeAtMs ?? (nowMs + cooldownMs),
      evidence: evidenceFor(haystack, match.index),
      // 'json' when the CLI told us the instant, 'fallback' when we guessed it.
      // Worth distinguishing in the log: a guess is the case the evidence gate
      // in docs/research/rate-limit-resume.md is still open on.
      source: resumeAtMs ? 'json' : 'fallback',
      pattern: pattern.configured ? `config:${pattern.re.source}` : pattern.re.source,
    };
  }
  return no;
}

/** Is a recorded quota pause still in force? */
export function quotaPauseActive(quota, nowMs) {
  const until = Number(quota?.resume_at_ms);
  return Number.isFinite(until) && nowMs < until;
}
