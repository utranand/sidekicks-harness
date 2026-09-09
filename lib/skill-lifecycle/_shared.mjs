// lib/skill-lifecycle/_shared.mjs
// Shared helpers for the `sidekicks skill …` verbs.
//
// The CLI's global parseArgs runs with strict:false, so verb-local flags are re-read here where
// their value/boolean nature is known — the same arrangement lib/framework-lifecycle/_shared.mjs
// and lib/memory-lifecycle/_shared.mjs use.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SidekicksError, EXIT_USAGE, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { discoverSkills, readSkillFrontmatter } from '../skill-manifest/read.mjs';
import { MANIFEST_NAME, parseManifest } from '../skill-manifest/schema.mjs';
import { gitExecPaths, resolveSourceMode } from '../skill-manifest/mode.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';

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

/** A dotted release number and nothing else. Anything looser is not safely comparable. */
const SEMVER_EXACT = /^\d+\.\d+\.\d+$/;

/**
 * A skill folder's declared version: `VERSION.json`, then SKILL.md frontmatter, then ''.
 *
 * Two authorities on purpose, because they disagree in practice and only their union is a signal.
 * `lib/package-lifecycle` auto-creates a `VERSION.json` for every skill directory and never bumps
 * it, so a skill can sit at the same VERSION.json on both sides while its hand-maintained
 * frontmatter has moved — sk-skill-manager is 1.6.0/1.6.0 with frontmatter 0.5.2 local against
 * 0.3.0 published, and the frontmatter is the only thing that says which way that row points.
 *
 * @param {{dir: string}} entryLike - anything carrying an absolute `dir`
 * @returns {{version: string, frontmatter: string}}
 */
export function skillVersions(entryLike) {
  let version = '';
  try {
    version = String(JSON.parse(readFileSync(join(entryLike.dir, 'VERSION.json'), 'utf8')).version || '');
  } catch { version = ''; }
  let frontmatter = '';
  try {
    const fm = readSkillFrontmatter(entryLike);
    frontmatter = fm && fm.version ? String(fm.version) : '';
  } catch { frontmatter = ''; }
  return { version, frontmatter };
}

/**
 * Compare two release numbers.
 *
 * Returns null — NOT a guess — unless BOTH sides are exactly `N.N.N`. That refusal is the whole
 * point of having a local copy rather than reusing package-lifecycle's compareVersions, which does
 * `v.split('.').map(Number)`: for '1.2.0-beta' vs '1.2.0' the patch parses as NaN, `NaN !== 0` is
 * true and `NaN > 0` is false, so it returns -1 — reporting a prerelease as OLDER than the release
 * it precedes. Under a downgrade guard that turns a legitimate fast-forward into a refusal.
 * '1.2' vs '1.2.0' fails the same way.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1|null}
 */
export function compareSemver(a, b) {
  if (!SEMVER_EXACT.test(String(a || '')) || !SEMVER_EXACT.test(String(b || ''))) return null;
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/**
 * How the incoming copy's version relates to the local one.
 *
 * `comparable: false` is a real answer and the common one — an unversioned skill, a prerelease tag,
 * a `new` row with no local side. A caller may only assert a DIRECTION when `comparable` is true.
 *
 * @param {{dir: string}|null|undefined} local
 * @param {{dir: string}} incoming
 * @returns {{local: string, incoming: string, cmp: -1|0|1|null, comparable: boolean, from: string}}
 */
export function versionDelta(local, incoming) {
  const none = { local: '', incoming: '', cmp: null, comparable: false, from: '' };
  if (!local || !incoming) {
    if (!incoming) return none;
    const iv = skillVersions(incoming);
    return { ...none, incoming: iv.version || iv.frontmatter || '' };
  }
  const lv = skillVersions(local);
  const iv = skillVersions(incoming);
  // VERSION.json decides; the frontmatter breaks a tie it cannot break itself.
  for (const [from, l, i] of [
    ['VERSION.json', lv.version, iv.version],
    ['frontmatter', lv.frontmatter, iv.frontmatter],
  ]) {
    const cmp = compareSemver(i, l);
    if (cmp === null) continue;
    if (cmp !== 0 || from === 'frontmatter') {
      return { local: l, incoming: i, cmp, comparable: true, from };
    }
    // VERSION.json ties — keep it as the reported pair, but let the frontmatter try to break it.
    const fmCmp = compareSemver(iv.frontmatter, lv.frontmatter);
    if (fmCmp === null) return { local: l, incoming: i, cmp: 0, comparable: true, from };
    return {
      local: lv.frontmatter, incoming: iv.frontmatter, cmp: fmCmp, comparable: true,
      from: 'frontmatter',
    };
  }
  return {
    local: lv.version || lv.frontmatter || '', incoming: iv.version || iv.frontmatter || '',
    cmp: null, comparable: false, from: '',
  };
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
 * checked. THE MODE RIDES ALONG, or a backup restores a script that cannot run: it is resolved with
 * `resolveSourceMode()` rather than the bare local stat, because on Windows the stat cannot report
 * an exec bit at all and the backup would then quietly launder it away — which is the same defect
 * `copyBundle` carried on the way out (INC-2026-09-05-02, X-3).
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
  const gitExec = gitExecPaths(skillDir);
  const recorded = recordedModes(skillDir);
  for (const f of files) {
    writeAtomic(
      join(repoRoot, backupRel, ...f.rel.split('/')), readFileSync(f.abs),
      { mode: resolveSourceMode(f.abs, { rel: f.rel, recorded, gitExec }) }
    );
  }
  return backupRel.split('\\').join('/');
}

/**
 * The `modes{}` a skill folder's own manifest records, or `{}` when it has none.
 *
 * Read straight from the file rather than through readSkillManifest(), which wants a repo root and
 * a discovery entry — neither of which a backup of an arbitrary folder has to hand.
 *
 * @param {string} skillDir
 * @returns {Record<string, number>}
 */
function recordedModes(skillDir) {
  const abs = join(skillDir, MANIFEST_NAME);
  if (!existsSync(abs)) return {};
  try {
    const { manifest } = parseManifest(readFileSync(abs, 'utf8'), name(skillDir), skillDir);
    return (manifest && manifest.modes) || {};
  } catch {
    return {};
  }
}

/** The folder's own basename, which is the name a skill is discovered under. */
function name(skillDir) {
  const parts = skillDir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
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
