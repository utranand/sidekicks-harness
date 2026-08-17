// lib/skill-lifecycle/_shared.mjs
// Shared helpers for the `sidekicks skill …` verbs.
//
// The CLI's global parseArgs runs with strict:false, so verb-local flags are re-read here where
// their value/boolean nature is known — the same arrangement lib/framework-lifecycle/_shared.mjs
// and lib/memory-lifecycle/_shared.mjs use.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SidekicksError, EXIT_USAGE, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { discoverSkills } from '../skill-manifest/read.mjs';
import { writeAtomic, execAwareMode } from '../fs-safety/fsx.mjs';

/**
 * Parse `--flag`, `--flag=value` and `--flag value` out of a raw argv slice.
 *
 * @param {string[]} argv
 * @param {string[]} booleans - flags that never take a value
 * @returns {Record<string, string|boolean>}
 */
export function parseSkillFlags(argv, booleans = []) {
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
      i++;
    } else {
      out[body] = '';
    }
  }
  return out;
}

/**
 * Every occurrence of a repeatable value flag, in order.
 *
 * parseSkillFlags returns a flat record, so `--rename a=b --rename c=d` keeps only the last one.
 * A flag that may legitimately be given more than once has to be read separately, or the second
 * answer silently wins over the first.
 *
 * @param {string[]} argv
 * @param {string} flag - the bare flag name, without leading dashes
 * @returns {string[]}
 */
export function collectRepeated(argv, flag) {
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string' || !tok.startsWith('--')) continue;
    const body = tok.slice(2);
    if (body.startsWith(`${flag}=`)) { out.push(body.slice(flag.length + 1)); continue; }
    if (body !== flag) continue;
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out.push(next); i++; }
  }
  return out;
}

/**
 * Every file under a directory, directory-relative with POSIX separators.
 *
 * Deliberately NOT scan.mjs's walkSkillFiles: that one honours SKIP_DIRS, which is right for
 * deciding what a skill DECLARES and wrong for a backup, where anything left behind is a file the
 * operator cannot get back.
 *
 * @param {string} dir
 * @param {string} prefix
 * @returns {Array<{abs: string, rel: string}>}
 */
export function walkAllFiles(dir, prefix = '') {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkAllFiles(abs, rel));
    else out.push({ abs, rel });
  }
  return out;
}

/**
 * Copy a skill directory into the run-backup tree, and return the repo-relative path it landed at.
 *
 * The one thing that makes a wrong import or a wrong removal recoverable, so it is taken BEFORE any
 * write or delete, unconditionally, by every verb that touches a skill folder. Shared rather than
 * duplicated: two backup implementations are one backup implementation that has stopped being
 * checked. `execAwareMode` rides along or a script chmod +x'd on the way in loses that bit here.
 *
 * The returned path is repo-relative with forward slashes (`rule.portable-artifact-paths`) — never
 * a machine-absolute path, because it gets recorded into artifacts a reader may open elsewhere.
 *
 * @param {string} repoRoot
 * @param {string} skillDir - absolute path to the folder being backed up
 * @param {string} stamp - a filesystem-safe timestamp, shared by every skill in one run
 * @param {string} name - the skill name, the folder it lands under
 * @returns {string|null} repo-relative backup path, or null when there was nothing to back up
 */
export function backupSkillDir(repoRoot, skillDir, stamp, name) {
  const files = walkAllFiles(skillDir);
  if (!files.length) return null;
  const backupRel = join('artifacts', 'runs', 'skill-manager', 'backups', stamp, name);
  for (const f of files) {
    writeAtomic(
      join(repoRoot, backupRel, ...f.rel.split('/')), readFileSync(f.abs),
      { mode: execAwareMode(f.abs) }
    );
  }
  return backupRel.split('\\').join('/');
}

/**
 * The TRUE positional arguments of a verb, given which of its flags take a value.
 *
 * The dispatcher's parseArgs runs with `strict: false` and no option config (cli.mjs:56-62), so it
 * cannot know that `--preset` takes a value: it records `--preset` as a boolean and hands `core` on
 * as a positional. For a verb whose positionals ARE skill names, that turns
 * `skill export --preset core` into "unknown skill 'core'" — which is exactly how this was found.
 *
 * So a verb with value-flags re-reads its own positionals here, the same way parseSkillFlags
 * re-reads its own flags and for the same reason.
 *
 * @param {string[]} argv - ctx.argv, i.e. process.argv.slice(2) — argv[0]/[1] are namespace + verb
 * @param {string[]} valueFlags - flag names that consume the following token
 * @returns {string[]}
 */
export function positionalArgs(argv, valueFlags = []) {
  const takesValue = new Set(valueFlags);
  const out = [];
  const list = Array.isArray(argv) ? argv.slice(2) : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      if (body.includes('=')) continue;                       // --flag=value consumes nothing
      const next = list[i + 1];
      if (takesValue.has(body) && next !== undefined && !next.startsWith('--')) i++;
      continue;
    }
    out.push(tok);
  }
  return out;
}

/**
 * Resolve the skills a verb operates on: one named skill, or all of them.
 *
 * @param {string} repoRoot
 * @param {string|undefined} name
 * @param {{all?: boolean, verb: string}} opts
 * @returns {Array<ReturnType<typeof discoverSkills>[number]>}
 */
export function resolveTargets(repoRoot, name, opts) {
  const all = discoverSkills(repoRoot);
  if (!name) {
    if (opts.all === false) {
      throw new SidekicksError(
        `${opts.verb}: missing required argument <skill> — run 'sidekicks skill list' to see them`,
        EXIT_USAGE
      );
    }
    return all;
  }
  const hit = all.find((s) => s.skill === name);
  if (!hit) {
    throw new SidekicksError(
      `${opts.verb}: unknown skill '${name}' — run 'sidekicks skill list' to see them`,
      EXIT_NOT_FOUND
    );
  }
  return [hit];
}

/**
 * Render `{check, detail}` findings the way `framework doctor` does, so the two verbs read alike.
 *
 * @param {Array<{skill?: string, check: string, detail: string}>} findings
 * @returns {string[]}
 */
export function findingLines(findings) {
  return findings.map((f) => `  [${f.check}] ${f.skill ? `${f.skill}: ` : ''}${f.detail}`);
}
