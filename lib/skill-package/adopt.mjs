// lib/skill-package/adopt.mjs
// Converting a foreign skill folder into one this framework can carry — as a PLAN, never as a write.
//
// WHAT CONVERSION IS NOT. It is tempting to have an importer "fix up" an upstream skill: write it a
// skill.yaml, stamp a VERSION.json, generate a manifest, drop it into an audit group. Every one of
// those is refused here, for two different reasons:
//
//   1. POLICY IS NOT DERIVABLE. `rules:`, `hooks:` and `config:` in a skill.yaml are claims about
//      what THIS repo enforces. An importer inventing them would turn somebody else's folder into
//      local policy that nobody decided. Worse, an otherwise-empty descriptor flips
//      manifestRequired(scan, hasDescriptor=true) to true (scan.mjs), forcing a ceremonial manifest
//      onto a skill that needs none.
//   2. AN EDIT COSTS BYTE-EXACTNESS. The folder is copied verbatim, so a later re-import from the
//      same upstream reconciles as `up-to-date` instead of as a permanent conflict, and so the
//      recorded provenance means something. Rewriting frontmatter to "correct" a name would make
//      every future import a conflict, forever.
//
// So conversion synthesizes nothing. What it does is READ the upstream metadata so the registration
// profile can record it, and turn everything a human must decide into ordered plan lines.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readSkillFrontmatter } from '../skill-manifest/read.mjs';
import { walkSkillFiles } from '../skill-lifecycle/scan.mjs';
import { venvCreateHint } from '../skill-lifecycle/heal.mjs';

/** Files at a source ROOT that carry licensing and cannot travel inside a skill folder. */
const ROOT_LICENCE = Object.freeze([
  'LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENCE', 'NOTICE', 'THIRD_PARTY_NOTICES.md',
]);

/** Licence-ish files INSIDE a skill folder, which do travel because they are folder content. */
const CARRIED_LICENCE = /^(LICEN[CS]E|NOTICE|COPYING)(\.[A-Za-z0-9]+)?$/i;

// ── The cross-platform pre-flight ──────────────────────────────────────────────────────────────
//
// WHY IT RUNS ON THE EXPORTING SIDE. A check keyed on the HOST platform is the wrong design: the
// machine that can create `aux.md` is the only one in a position to warn the machine that cannot.
// So every rule below is evaluated against the PLAN — the names and bytes the upstream carries —
// and never against what this filesystem happens to accept. A macOS import therefore protects the
// Windows teammate, and a Windows import protects nobody less (INC-2026-09-05-02, X-2).
//
// Refuse vs warn. A refusal is for a folder that CANNOT land intact somewhere it is meant to land:
// the name is uncreatable on a supported platform, or the folder is not liftable. A warning is for
// something that lands fine and then misbehaves at run time — a CRLF shebang, a PowerShell
// entrypoint — which is the operator's call, not the importer's.

/** Win32 reserved device names. Uncreatable with OR without an extension (`aux.md` included). */
const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

/** Characters Win32 refuses anywhere in a path segment. `/` is already the separator. */
const WIN_ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/;

/**
 * Long enough to be worth saying so. Win32's classic MAX_PATH is 260 for the WHOLE path, and the
 * destination prefix (`C:\Users\…\.agents\skills\<skill>\`) is not knowable from here, so this is
 * headroom advice rather than a limit — hence a warning, never a refusal.
 */
const LONG_PATH = 200;

/**
 * Every reason one skill-relative path cannot be created on Windows.
 *
 * @param {string} rel - POSIX-form, skill-folder-relative
 * @returns {string[]} zero or more reasons
 */
function winPathProblems(rel) {
  const out = [];
  for (const seg of rel.split('/')) {
    if (!seg) continue;
    if (WIN_RESERVED.test(seg)) out.push(`'${seg}' is a Windows reserved device name`);
    const bad = seg.match(WIN_ILLEGAL_CHARS);
    if (bad) {
      const ch = bad[0];
      const shown = ch.charCodeAt(0) < 0x20 ? `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}` : ch;
      out.push(`'${seg}' contains '${shown}', which Windows refuses in a filename`);
    }
    if (/[. ]$/.test(seg)) out.push(`'${seg}' ends in a dot or space, which Windows silently strips`);
  }
  return out;
}

/** The first line of a file, without reading all of it into memory twice. */
function firstLine(abs) {
  const text = safeRead(abs);
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

/**
 * Does this small text file look like a symlink git materialised as content?
 *
 * Git on Windows defaults to `core.symlinks=false` and writes a link's TARGET PATH as the file's
 * whole content. There is no flag on disk saying so, so the probe is the shape: one short line, no
 * newline, no NUL, spelled like a relative path, and resolving to something that actually exists
 * next to it. That last clause is what keeps a one-line text file from being mistaken for a link.
 *
 * @param {string} abs
 * @param {number} size
 * @returns {string|null} the target it names, or null
 */
function symlinkTextStub(abs, size) {
  if (size === 0 || size > 512) return null;
  let text;
  try { text = readFileSync(abs, 'utf8'); } catch { return null; }
  if (/[\r\n\u0000]/.test(text)) return null;
  const target = text.trim();
  if (!target || target !== text) return null;
  if (!/^\.{0,2}[\w./\\-]+$/.test(target) || /^[A-Za-z]:/.test(target)) return null;
  if (!target.includes('/') && !target.includes('..')) return null;
  let resolved;
  try { resolved = resolve(dirname(abs), target); } catch { return null; }
  return existsSync(resolved) ? target : null;
}

/**
 * What adopting one foreign skill involves.
 *
 * Pure: reads the source folder, writes nothing, decides nothing a human owns.
 *
 * `refusals` is the channel the caller must treat as fatal: unlike a warning, it names something
 * that cannot land intact on a supported platform, so the import stops before it writes anything.
 *
 * @param {string} fromRoot - the source tree root
 * @param {object} entry - a readSource() entry
 * @returns {{skill: string, warnings: string[], refusals: string[], carries: string[], steps: string[], materialize: object[], facts: object}}
 */
export function adoptionPlan(fromRoot, entry) {
  const fm = readSkillFrontmatter(entry);
  const links = [];
  const files = walkSkillFiles(entry.dir, { onSymlink: (l) => links.push(l) });
  const warnings = [];
  const refusals = [];
  const carries = [];
  const steps = [];
  const materialize = [];

  // ── Symlinks: classified, never followed ─────────────────────────────────────────────────────
  for (const link of links) {
    if (link.dangling) {
      refusals.push(
        `${entry.skill}: '${link.rel}' is a symlink to '${link.target || '(unreadable)'}', which does `
        + 'not exist — a copy of this folder cannot be byte-exact'
      );
    } else if (!link.inside) {
      refusals.push(
        `${entry.skill}: '${link.rel}' is a symlink to '${link.target}', which resolves OUTSIDE the `
        + 'skill folder — the folder is not liftable, and following it would copy in bytes the '
        + 'upstream never put there. Vendor the target into the folder upstream, or drop the link'
      );
    } else {
      warnings.push(
        `${entry.skill}: '${link.rel}' is a symlink to '${link.target}' inside the folder — it is `
        + 'copied as the target\'s BYTES, because a link is not portable (Windows needs privilege '
        + 'to create one) and following it would differ per platform'
      );
      materialize.push({ rel: link.rel, from: link.abs });
    }
  }

  // ── The Windows text-stub form of the same problem ───────────────────────────────────────────
  // Nothing here is a symlink any more: git already flattened it. Detecting it is the only way a
  // POSIX host can tell the operator their SOURCE checkout is the wrong one.
  for (const f of files) {
    let size;
    try { size = statSync(f.abs).size; } catch { continue; }
    const target = symlinkTextStub(f.abs, size);
    if (!target) continue;
    refusals.push(
      `${entry.skill}: '${f.rel}' is a ${size}-byte file whose entire content is the path `
      + `'${target}' — this source was almost certainly checked out with 'core.symlinks=false' `
      + '(the Windows default), which writes a symlink as its target path. Re-clone the source with '
      + 'symlinks enabled, or adopting it here records different bytes than the same commit does '
      + 'on macOS/Linux'
    );
  }

  // ── Names that cannot exist on Windows ───────────────────────────────────────────────────────
  const byLowerRel = new Map();
  for (const f of files) {
    for (const why of winPathProblems(f.rel)) {
      refusals.push(`${entry.skill}: '${f.rel}' cannot be created on Windows — ${why}`);
    }
    if (f.rel.length > LONG_PATH) {
      warnings.push(
        `${entry.skill}: '${f.rel}' is ${f.rel.length} chars before the destination prefix is added `
        + `— close to Windows' 260-char MAX_PATH`
      );
    }
    const key = f.rel.toLowerCase();
    const seen = byLowerRel.get(key);
    if (seen) {
      refusals.push(
        `${entry.skill}: '${seen}' and '${f.rel}' differ only in case — one would overwrite the `
        + 'other on Windows and macOS, whose filesystems are case-insensitive by default'
      );
    } else {
      byLowerRel.set(key, f.rel);
    }
  }

  // ── Things that land fine and then misbehave ─────────────────────────────────────────────────
  for (const f of files) {
    const head = firstLine(f.abs);
    if (head.startsWith('#!') && head.endsWith('\r')) {
      warnings.push(
        `${entry.skill}: '${f.rel}' has a CRLF shebang — Linux and macOS read the '\\r' as part of `
        + 'the interpreter name and fail with \'bad interpreter\'. Convert it to LF upstream'
      );
    }
    if (/\.psm?1$/i.test(f.rel)) {
      warnings.push(
        `${entry.skill}: '${f.rel}' is PowerShell — it needs 'pwsh' on macOS/Linux, which is not `
        + 'installed by default. Declare it under requires.binaries, or ship a POSIX sibling'
      );
    }
  }

  // ── Metadata: reported, never corrected ──────────────────────────────────────────────────────
  if (!fm.present) {
    warnings.push(
      `${entry.skill}: SKILL.md has no frontmatter — no CLI will match this skill on a description`
    );
  } else {
    if (fm.name === null) warnings.push(`${entry.skill}: SKILL.md declares no 'name:'`);
    else if (fm.name !== entry.skill) {
      warnings.push(
        `${entry.skill}: SKILL.md says name: '${fm.name}' but the folder is '${entry.skill}' — `
        + 'the FOLDER name wins here (discovery keys on it); the file is copied unedited'
      );
    }
    if (!fm.description) {
      warnings.push(`${entry.skill}: SKILL.md declares no 'description:' — nothing will trigger it`);
    }
  }

  // ── Python: surfaced, never installed ────────────────────────────────────────────────────────
  const py = files.filter((f) => f.rel.endsWith('.py'));
  const reqTxt = files.find((f) => f.rel === 'requirements.txt');
  if (py.length) {
    steps.push(
      `${entry.skill}: derive its python dependencies — 'sidekicks skill manifest ${entry.skill} `
      + "--apply' writes requires.python with TODO markers; answer those, then 'sidekicks skill "
      + `heal ${entry.skill} --apply' installs them into the single repo-root .venv (it will NOT `
      + `create the .venv — that is yours: ${venvCreateHint()})`
    );
  }
  if (reqTxt) {
    const body = safeRead(reqTxt.abs);
    carries.push('requirements.txt (its pins WIN over the derived package list at heal time)');
    if (/^\s*-r\s+\.\./m.test(body)) {
      warnings.push(
        `${entry.skill}: requirements.txt reaches outside the skill folder (-r ../…) — the folder `
        + 'is not liftable as-is and skill doctor will report requirements-escapes-skill'
      );
    }
  }

  // ── Licensing: what travelled, and what could not ────────────────────────────────────────────
  for (const f of files) {
    if (CARRIED_LICENCE.test(f.rel.split('/').pop() || '')) carries.push(f.rel);
  }
  const rootLicences = ROOT_LICENCE.filter((n) => existsSync(join(fromRoot, n)));
  if (rootLicences.length) {
    steps.push(
      `${entry.skill}: the source root carries ${rootLicences.join(', ')}, which did NOT travel — `
      + 'import writes nothing outside .sidekicks/. Carry or reference it by hand'
    );
  }
  if (fm.license) {
    steps.push(`${entry.skill}: upstream declares license '${fm.license}' — record it where your repo records attribution`);
  } else if (!carries.length && !rootLicences.length) {
    warnings.push(`${entry.skill}: no licence found upstream, in the folder or at the source root`);
  }

  // ── Republication is a decision, not a default ───────────────────────────────────────────────
  steps.push(
    `${entry.skill}: decide whether a skill you did not write is yours to republish — `
    + `'skill_repo: none' in .agents/skills/${entry.skill}/skill.yaml withholds it from every `
    + 'configured destination'
  );

  return {
    skill: entry.skill,
    warnings,
    refusals,
    carries: [...new Set(carries)].sort(),
    steps,
    // Links whose target is inside the folder, for the apply path to copy as bytes at the link's
    // own relative path. Empty for every skill that carries no symlink, which is nearly all of them.
    materialize,
    facts: {
      upstream_name: fm.name,
      upstream_description: fm.description,
      upstream_version: fm.version,
      license: fm.license,
      layout: entry.layout,
      category: entry.category,
      upstream_path: entry.upstreamRel,
      file_count: files.length,
      has_scripts: files.some((f) => f.inScripts),
      python_files: py.length,
    },
  };
}

/** Read a file as text, or '' — a source we do not own may be unreadable for any number of reasons. */
function safeRead(abs) {
  try { return readFileSync(abs, 'utf8'); } catch { return ''; }
}

/**
 * Names at a plugin-marketplace root that hold their own skills subtrees.
 *
 * Used only to make the refusal message actionable when someone points `--from` at a marketplace
 * whose skills live one level further in. Never used to import: a plugin is commands, agents, hooks
 * and skills together, and `skill import` has standing over exactly one of those four.
 */
export function marketplacePlugins(fromRoot) {
  const out = [];
  for (const base of ['plugins', '.']) {
    let entries;
    try { entries = readdirSync(join(fromRoot, base), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const skills = join(fromRoot, base, e.name, 'skills');
      if (existsSync(skills)) out.push(`${base === '.' ? '' : `${base}/`}${e.name}/skills`);
    }
  }
  return [...new Set(out)].sort();
}
