// lib/skill-lifecycle/settings-split.mjs
// Two DISCOVERY detectors for the settings-vs-configuration split: a tunable value hard-coded in a
// skill instead of declared as configuration, and a behavioural policy stated in SKILL.md prose
// instead of declared as a criterion.
//
// WHY THESE ARE NOTICES AND NOT ERRORS. Both are heuristics over prose and source, and a heuristic
// that fails CI across 123 skills is a gate nobody can pass — it would be suppressed the day it
// landed, which is worse than not having it. The STRUCTURAL half of the contract is already hard:
//   - `entry-unlisted`      (framework doctor) — a registered id in no settings file
//   - `defaults-missing`    (config doctor)    — a `defaults:` pointing at a file that is not there
//   - `declared-but-absent` (skill audit)      — a declared rule body missing from the skill folder
// These two answer a different question — "what has not been declared YET" — so they are reported
// with file:line evidence and drive the backfill sweep rather than blocking a commit.
//
// EVERY FINDING CARRIES EVIDENCE (Rule 5). A detector that says "this skill probably hard-codes
// something" without naming the line is an opinion; naming `scripts/cli.py:42  MAX_RETRIES = 5` is
// a fact someone can act on or dismiss in one look.
//
// Zero npm dependencies — node:* only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../yaml-subset/yaml.mjs';

/** Files worth scanning for a hard-coded tunable. Anything else is data, not behaviour. */
const CODE_EXT = /\.(mjs|js|cjs|py|sh|ts)$/;

/**
 * A skill's own tests. A constant in a test is FIXTURE DATA — the value the test asserts against —
 * and making it configurable would mean the test asserts whatever the operator configured, which is
 * no assertion at all.
 */
const TEST_FILE = /(^|\/)(tests?|__tests__)\//;

/**
 * An assignment that looks like a TUNABLE — a knob an operator might reasonably want different in
 * their repo — rather than an implementation constant.
 *
 * Deliberately narrow. `const SKIP_DIRS = new Set([...])` is an implementation detail nobody
 * configures; `DEFAULT_TIMEOUT = 30` is a knob. The name carries the signal, so the pattern matches
 * on the NAME and requires the value to be a bare number or quoted string — a computed value or a
 * data structure is not a setting somebody would put in a YAML file.
 */
const TUNABLE_WORD = new Set([
  'TIMEOUT', 'RETRIES', 'RETRY', 'LIMIT', 'MAX', 'MIN', 'PORT', 'INTERVAL', 'BATCH',
  'CONCURRENCY', 'POLL', 'BUDGET', 'THRESHOLD', 'TTL', 'DEFAULT',
]);

/**
 * Matched on whole `_`-delimited SEGMENTS, never as a substring. `CONN_ADMIN_TABLE` is not a
 * minimum — the `MIN` inside `ADMIN` is, and a detector that reads it that way reports a database
 * schema identity as a tunable knob. One such finding is enough to teach a reader to skim the rest.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isTunableName(name) {
  if (!/^[A-Z0-9_]+$/.test(name)) return false;
  return name.split('_').some((seg) => TUNABLE_WORD.has(seg));
}

/** `NAME = 30`, `NAME = "x"`, `const NAME = 30`, `NAME: 30` — the shapes a tunable is written in. */
const ASSIGN_RE = /^\s*(?:(?:const|let|var|export\s+const)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")\s*[;,]?\s*(?:#.*|\/\/.*)?$/;

/**
 * Every key name a skill's declared defaults document, lowercased and stripped of separators.
 *
 * This is what turns the tunable check from "has this skill joined the system at all" into "is THIS
 * knob reachable". The coarse form let a skill declare one block and go silent on every other
 * literal in its scripts — which is exactly the false all-clear a backfill sweep must not produce.
 *
 * Matching is deliberately loose on shape and strict on substance: `DEFAULT_MAX_CARDS` in code and
 * `max_cards` in YAML are the same knob, so both normalize to `maxcards`, and a `DEFAULT_` prefix is
 * tried with and without. Nesting is walked whole — a knob under `block: { retry: { limit: 3 } }` is
 * declared, wherever it sits.
 *
 * @param {{dir: string}} entry
 * @param {object|null} descriptor - as readDescriptor() returns it
 * @returns {Set<string>}
 */
function declaredKeys(entry, descriptor) {
  const keys = new Set();
  if (!descriptor) return keys;
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const v of value) walk(v); return; }
    for (const [k, v] of Object.entries(value)) {
      keys.add(k.toLowerCase().split('_').join('').split('-').join(''));
      walk(v);
    }
  };
  for (const cfg of descriptor.configs || []) {
    walk(cfg.builtin);
    if (!cfg.defaults) continue;
    try {
      walk(parse(readFileSync(join(entry.dir, ...cfg.defaults.split('/')), 'utf8')));
    } catch {
      // A defaults file that is missing or does not parse is `defaults-missing` / a config-doctor
      // finding, reported there. Here it just means "declares no keys".
    }
  }
  return keys;
}

/**
 * `DEFAULT_MAX_CARDS`, `BUILTIN_MAX_CARDS` and `max_cards` are one knob under three spellings. The
 * prefix marks which LAYER the literal sits in, never which knob it is.
 */
const LAYER_PREFIX = ['default', 'builtin', 'fallback'];

/**
 * A trailing UNIT segment carries no identity: `KEEPALIVE_MIN_INTERVAL_S` and
 * `keepalive_min_interval` are one knob, and the YAML side documents the unit in a comment rather
 * than in the key. Tried as an ADDITIONAL form, never as a replacement.
 */
const UNIT_SEGMENT = new Set(['s', 'ms', 'sec', 'secs', 'seconds', 'm', 'h', 'hours', 'kb', 'mb']);

function keyForms(name) {
  const segments = name.toLowerCase().split('_').filter(Boolean);
  const bases = [segments];
  if (segments.length > 1 && UNIT_SEGMENT.has(segments[segments.length - 1])) {
    bases.push(segments.slice(0, -1));
  }
  const forms = [];
  for (const base of bases) {
    const flat = base.join('');
    forms.push(flat);
    for (const p of LAYER_PREFIX) if (flat.startsWith(p)) forms.push(flat.slice(p.length));
  }
  return forms;
}

/**
 * Tunable-looking literals in a skill's own code that NOTHING lets an operator override.
 *
 * A literal is answered for when the skill's declared defaults document a key of the same name, or
 * when the descriptor records an exemption saying why it is not a knob. Anything else is a value
 * the skill decided on the operator's behalf with no way to say otherwise.
 *
 * @param {{dir: string}} entry
 * @param {Array<{rel: string, abs: string}>} files
 * @param {object|null} [descriptor] - as readDescriptor() returns it
 * @param {number} [cap] - stop after this many, so one pathological file cannot flood the report
 * @returns {Array<{file: string, line: number, name: string, value: string}>}
 */
export function hardcodedTunables(entry, files, descriptor = null, cap = 8) {
  const declared = declaredKeys(entry, descriptor);
  const exempt = new Set(
    ((descriptor && descriptor.settings_split ? descriptor.settings_split.tunable_exempt : []) || [])
      .map((e) => e.name)
  );
  const hits = [];
  for (const f of files) {
    if (!CODE_EXT.test(f.rel)) continue;
    if (TEST_FILE.test(f.rel.split('\\').join('/'))) continue;
    let text;
    try {
      text = readFileSync(f.abs, 'utf8');
    } catch {
      continue;                       // an unreadable file is the scanner's problem, not this gate's
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = ASSIGN_RE.exec(lines[i]);
      if (!m) continue;
      if (!isTunableName(m[1])) continue;
      if (exempt.has(m[1])) continue;
      if (keyForms(m[1]).some((k) => declared.has(k))) continue;
      hits.push({ file: f.rel, line: i + 1, name: m[1], value: m[2] });
      if (hits.length >= cap) return hits;
    }
  }
  return hits;
}

/**
 * Lines in SKILL.md that state a POLICY — a behaviour the skill always or never performs.
 *
 * A policy is what a criterion is for: it is the kind of statement a user could reasonably want
 * switched off, and while it lives only in prose it cannot be listed, reviewed or disabled.
 *
 * Two signals must BOTH be present on the line, which is what keeps this from matching ordinary
 * documentation: an emphasised normative modal (the skill shouting a rule), and a line that reads as
 * a standing behaviour rather than a step in a procedure.
 *
 * A hit is answered for by REMOVAL: once the policy is extracted into `rules/<id>.md` and SKILL.md
 * keeps only a one-line reference, the shouting line is no longer in SKILL.md and the detector goes
 * quiet on its own. What cannot be removed — a hard stop belonging to the floor, a restatement of a
 * framework-owned rule, a required output shape — is answered for by a recorded exemption instead.
 *
 * @param {{dir: string}} entry
 * @param {object|null} [descriptor] - as readDescriptor() returns it
 * @param {number} [cap]
 * @returns {Array<{line: number, text: string}>}
 */
export function policyProse(entry, descriptor = null, cap = 6) {
  const exempt = ((descriptor && descriptor.settings_split
    ? descriptor.settings_split.policy_exempt : []) || []).map((e) => e.quote);
  let text;
  try {
    text = readFileSync(join(entry.dir, 'SKILL.md'), 'utf8');
  } catch {
    return [];
  }
  const hits = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  // The YAML frontmatter is skipped wholesale. Its `description:` is a TRIGGERING hint written for
  // the agent choosing a skill ("**ALWAYS** use this skill when…"), not a behaviour of the skill —
  // matching it produced a finding on every well-written description in the repo.
  let i = 0;
  if (/^---\s*$/.test(lines[0] || '')) {
    i = 1;
    while (i < lines.length && !/^---\s*$/.test(lines[i])) i++;
    i++;
  }
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;                       // a code block is an example, not a policy
    if (/^\s*(?:>|\||#{1,6}\s)/.test(line)) continue;  // quotes, tables and headings are framing
    // A numbered step is a line in a PROCEDURE — "3. Annotate … (the value MUST change every run)"
    // states a fact about the system being driven, not a policy of the skill that a user could
    // switch off. Bullets are not skipped: a standing rule is very often written as one.
    if (/^\s*\d+\.\s/.test(line)) continue;

    // `GENERATED ALWAYS AS`, `ALWAYS ON`: the modal is a keyword of a language the skill is talking
    // ABOUT, not the skill stating a rule. Stripped before the test rather than skipped after it, so
    // a line that carries both a keyword and a real policy still matches on the policy.
    const prose = line.replace(/\bGENERATED\s+ALWAYS\b|\bALWAYS\s+ON\b/g, '');
    // The modal has to be EMPHASISED — bare "must" appears in ordinary prose constantly, while
    // `**MUST**` / `NEVER` / `ALWAYS` is the skill deliberately stating a rule.
    if (!/(\*\*(?:MUST|NEVER|ALWAYS|NEVER EVER)\*\*|\b(?:MUST NOT|MUST|NEVER|ALWAYS)\b)/.test(prose)) continue;
    // …and it has to read as a standing behaviour of the skill, not a one-off instruction about
    // the user's input or an external system.
    if (!/\b(?:by default|default|always|never|every run|each run|automatically)\b/i.test(prose)) continue;
    // Matched against the WHOLE line, not the truncated `text` below — an exemption quote long
    // enough to be unambiguous would otherwise fall off the end of the excerpt and never match.
    if (exempt.some((q) => line.includes(q))) continue;

    hits.push({ line: i + 1, text: line.trim().slice(0, 120) });
    if (hits.length >= cap) break;
  }
  return hits;
}
