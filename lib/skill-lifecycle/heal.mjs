// lib/skill-lifecycle/heal.mjs
// `sidekicks skill heal [<skill> | --all] [--apply] [--restore] [--from <ref>] [--include-test]
//                       [--no-pip] [--json]`
//
// The REPAIR half of the gate. `verify` proves a skill is broken; this is the verb that fixes it,
// and it has been promised for a while: audit.mjs:493 and :504 already print
// `sidekicks skill heal <skill> --apply` as their remediation.
//
// WHY IT LIVES IN THE CLI AND NOT IN A SKILL'S scripts/. Rule 1 — only `sidekicks` verbs create,
// modify or delete files under `.sidekicks/`, and the restore lane writes
// `.agents/skills/<name>/<file>`. It also has to work when the damaged thing IS a skill folder,
// which a script inside that folder cannot promise.
//
// REPORTS BY DEFAULT, WRITES ONLY ON --apply — same reasoning as manifest.mjs:6-9.
//
// THE ONE INVARIANT: heal never re-records. It never opens skill.manifest.yaml for writing, so
// `skill manifest --check` is unchanged by any heal run and `heal --apply && skill verify` is green.
// The mirror invariant lives in manifest.mjs: that verb never restores. Between them, a hash
// mismatch has exactly two honest answers and the operator picks which one they meant.
//
// WHAT IT WILL NOT DO. The four DEGRADED_REQUIRED sections (sibling_skills, host_paths,
// framework_files, framework_hooks — lib/skill-manifest/schema.mjs:42) cannot be installed, which
// is precisely why the schema forces each of their rows to carry a `degraded:` sentence. Heal
// prints that sentence and moves on. It never wires a hook either: a hook needs the same change in
// four per-CLI config files (Rule 6), so heal points at `sidekicks framework sync` instead.
//
// A LIFTED SKILL CANNOT BE HEALED — verify.mjs:9-10. In a bare copy with no git, every action
// becomes residue with reason `no-content-source` and the exit code says so. It does not pretend.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION, EXIT_IO, SidekicksError } from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { readSkillManifest } from '../skill-manifest/read.mjs';
import { hashFile } from '../skill-manifest/hash.mjs';
import { resolveContent, toRepoRel } from '../skill-package/content.mjs';
import { PY_STDLIB, PY_NAMESPACE_ROOTS } from './scan.mjs';
import { parseSkillFlags, resolveTargets } from './_shared.mjs';

/** Why a row cannot be healed at all — reported, never attempted. */
const NEVER_HEALABLE = Object.freeze({
  sibling_skills: 'a sibling skill is installed by importing it, not by pip — see the degraded: sentence',
  host_paths: 'a path outside the repo belongs to the host, not to this repo',
  framework_files: 'a repo-root file this skill reads — restorable only when the repo tracks it',
  framework_hooks: 'hook WIRING spans four per-CLI config files (Rule 6) — never touched here',
  node: 'this repo installs no npm packages; the row records what a host must already provide',
  binaries: 'an external binary is obtained from the platform, never from here',
});

/**
 * Absolute path to the single repo-root .venv's pip, for the running platform.
 * Returns null when that .venv does not exist — heal never CREATES one (`rule.single-venv` makes
 * the root .venv the only one, and choosing to build it is the operator's call, not a repair).
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function venvPip(repoRoot) {
  const candidates = process.platform === 'win32'
    ? [join(repoRoot, '.venv', 'Scripts', 'pip.exe'), join(repoRoot, '.venv', 'Scripts', 'pip')]
    : [join(repoRoot, '.venv', 'bin', 'pip')];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/**
 * Compute what healing one skill would do. Pure: no writes, no pip, no network.
 *
 * Exported so the tests drive the same code path the verb does — the arrangement audit.mjs:4-6
 * explains and every engine in this directory follows.
 *
 * @param {string} repoRoot
 * @param {{skill: string, dir: string, tree: string}} entry
 * @param {{restore?: boolean, includeTest?: boolean, pip?: boolean, from?: string|null}} [opts]
 * @returns {{skill: string, actions: Array<object>, residue: Array<object>, manifest: boolean}}
 */
export function healPlan(repoRoot, entry, opts = {}) {
  const read = readSkillManifest(repoRoot, entry);
  const actions = [];
  const residue = [];

  if (!read.present) {
    return { skill: entry.skill, actions, residue, manifest: false };
  }
  // A manifest that does not VALIDATE is `skill doctor`'s manifest-invalid, and heal stops here.
  // Note the gate is `read.errors`, not `!read.manifest`: parseManifest returns a populated object
  // ALONGSIDE its errors, because an unknown key is reported rather than dropped
  // (lib/skill-manifest/schema.mjs:137-145). Reading only the object would have heal act on a row
  // whose `package:` was rejected — repairing from a declaration nobody has agreed is well-formed
  // is how a repair verb damages the thing it meant to fix.
  if (!read.manifest || read.errors.length) {
    residue.push({
      skill: entry.skill, section: 'manifest', target: read.relPath,
      reason: 'manifest-invalid',
      detail: read.errors[0] || 'the manifest does not parse',
      remediation: `fix ${read.relPath}, then run 'sidekicks skill heal ${entry.skill}' again`,
    });
    return { skill: entry.skill, actions, residue, manifest: true };
  }

  const m = read.manifest;

  // ── the restore lane: bundle rows whose file is gone or has changed ───────────
  for (const [rel, recorded] of Object.entries(m.bundle || {})) {
    const abs = join(entry.dir, rel);
    const onDisk = hashFile(abs);
    if (onDisk === recorded) continue;

    if (!opts.restore) {
      // Opt-in on purpose. A hash mismatch is ambiguous — the edit may be the intended new state,
      // in which case the right verb is `skill manifest --apply`. Restoring by default would
      // silently revert somebody's work, so the ambiguity is handed back with both answers named.
      residue.push({
        skill: entry.skill, section: 'bundle', target: rel,
        reason: onDisk === null ? 'file-absent' : 'hash-mismatch',
        detail: onDisk === null
          ? `bundle records '${rel}', which is not present`
          : `bundle hash for '${rel}' does not match the file on disk`,
        remediation: `sidekicks skill heal ${entry.skill} --restore --apply to put the recorded `
          + `content back, or 'sidekicks skill manifest ${entry.skill} --apply' if the change is intended`,
      });
      continue;
    }

    // `--from <ref>` pins the search to that one revision. Without it the resolver does its own
    // HEAD-then-history walk; the source SET is the same either way, so only `revs` is passed.
    const found = resolveContent(repoRoot, abs, recorded, {
      revs: opts.from ? [opts.from] : undefined,
    });
    if (!found.found) {
      residue.push({
        skill: entry.skill, section: 'bundle', target: rel,
        reason: 'no-content-source',
        detail: `no source holds content hashing to the recorded ${recorded} for '${rel}' `
          + `(tried: ${found.tried.join(', ')})`,
        remediation: `restore the file from wherever it came from, or re-record the current state `
          + `with 'sidekicks skill manifest ${entry.skill} --apply'`,
      });
      continue;
    }
    actions.push({
      skill: entry.skill, section: 'bundle', target: rel, verb: 'restore-file',
      source: found.source, from_hash: onDisk, to_hash: recorded,
      path: toRepoRel(repoRoot, abs),
      _content: found.content,
      applied: false,
    });
  }

  // ── the install lane: requires.python into the single repo-root .venv ─────────
  const python = (m.requires && m.requires.python) || [];
  const wanted = [];
  for (const row of python) {
    const pkg = row.package || row.import;
    const scope = row.scope || 'runtime';
    if (scope === 'test' && !opts.includeTest) {
      // DEP_SCOPES exists for exactly this (schema.mjs:35): a lifted skill is complete without its
      // test harness, and installing one to satisfy a runtime check would be the wrong repair.
      continue;
    }
    // The two WRONG-declaration errors audit.mjs reports are refused before pip is ever reached,
    // and this is the reason both are errors rather than notices
    // (docs/guide/skill-architecture.md:514-522): `pip install __future__` resolves to whatever
    // holds that name on the index, and `pip install google` SUCCEEDS while installing an
    // unrelated abandoned stub, leaving the import it was meant to satisfy still broken.
    if (PY_STDLIB.has(pkg)) {
      residue.push({
        skill: entry.skill, section: 'requires.python', target: pkg,
        reason: 'stdlib-declared-as-package',
        detail: `'${pkg}' is part of the Python standard library and has no pip package — refusing to install it`,
        remediation: `delete the row from ${read.relPath}`,
      });
      continue;
    }
    if (PY_NAMESPACE_ROOTS.has(pkg)) {
      residue.push({
        skill: entry.skill, section: 'requires.python', target: pkg,
        reason: 'namespace-declared-as-package',
        detail: `'${pkg}' is a namespace prefix, not a package — installing it would not satisfy the import`,
        remediation: `name the member instead (e.g. import 'google.genai', package 'google-genai') in ${read.relPath}`,
      });
      continue;
    }
    wanted.push({ pkg, import: row.import || pkg, optional: Boolean(row.optional) });
  }

  if (wanted.length && opts.pip !== false) {
    const pip = venvPip(repoRoot);
    if (!pip) {
      residue.push({
        skill: entry.skill, section: 'requires.python', target: '.venv',
        reason: 'no-venv',
        detail: `${wanted.length} declared package(s) cannot be installed: the repo-root .venv does not exist`,
        remediation: 'create it once with \'python3 -m venv .venv\' — heal never creates it, because '
          + 'the single repo-root .venv is a framework decision, not a repair',
      });
    } else {
      // A skill that ships requirements.txt WINS: that file carries `==` pins, travels inside
      // bundle{}, and is what "bundle the pinned dependency with the skill" actually means. The
      // unpinned package list is the fallback for a skill that has not written one yet.
      const reqAbs = join(entry.dir, 'requirements.txt');
      if (existsSync(reqAbs)) {
        actions.push({
          skill: entry.skill, section: 'requires.python', target: 'requirements.txt',
          verb: 'pip-install-requirements',
          pip, args: ['install', '-r', reqAbs],
          packages: wanted.map((w) => w.pkg),
          applied: false,
        });
      } else {
        actions.push({
          skill: entry.skill, section: 'requires.python', target: wanted.map((w) => w.pkg).join(' '),
          verb: 'pip-install',
          pip, args: ['install', ...wanted.map((w) => w.pkg)],
          packages: wanted.map((w) => w.pkg),
          applied: false,
        });
      }
    }
  }

  // ── everything the schema says cannot be installed: state the cost, do nothing ─
  for (const [section, why] of Object.entries(NEVER_HEALABLE)) {
    const rows = (m.requires && m.requires[section]) || [];
    for (const row of rows) {
      const target = row.skill || row.path || row.name || row.package || row.id || '(row)';
      const scope = row.scope || 'runtime';
      if (scope === 'test' && !opts.includeTest) continue;
      // A row whose thing is already THERE says nothing worth printing, so the two sections heal
      // can check cheaply are checked. Everything else is always reported: heal cannot prove an
      // external binary or an npm package is usable, and staying silent about one would read as
      // "installed". A host path belongs to the host whether it exists or not.
      if (section === 'framework_files' || section === 'framework_hooks') {
        // Note the distinction that keeps the `degraded:` requirement standing: heal can restore a
        // tracked repo-root file's CONTENT, but it can never make one EXIST in a repo that never
        // had it — which is why these stay non-healable sections.
        const relRoot = section === 'framework_hooks' ? row.script : row.path;
        if (relRoot && existsSync(join(repoRoot, relRoot))) continue;
      }
      if (section === 'sibling_skills'
        && (existsSync(join(repoRoot, '.agents', 'skills', target))
          || existsSync(join(repoRoot, '.sidekicks', 'skill-offloaded', target)))) {
        continue;
      }
      residue.push({
        skill: entry.skill, section: `requires.${section}`, target,
        reason: 'never-healable',
        detail: why,
        degraded: row.degraded || null,
        remediation: section === 'framework_hooks'
          ? 'sidekicks framework sync, then propagate the wiring to every CLI (Rule 6)'
          : (section === 'binaries'
            ? (process.platform === 'win32' ? row.install_hint_windows : row.install_hint)
              || 'install it on the host'
            : (section === 'sibling_skills'
              ? `sidekicks skill import ${target} (or restore it with sk-skill-offload)`
              : 'nothing to run — the degraded: sentence is the answer')),
      });
    }
  }

  return { skill: entry.skill, actions, residue, manifest: true };
}

/**
 * Apply a plan. Files first, pip last: a restored requirements.txt must be the one pip reads.
 *
 * @param {string} repoRoot
 * @param {Array<object>} actions
 * @returns {{applied: Array<object>, failures: Array<object>}}
 */
export function applyHeal(repoRoot, actions) {
  const applied = [];
  const failures = [];

  for (const a of actions.filter((x) => x.verb === 'restore-file')) {
    try {
      const abs = join(repoRoot, a.path);
      // Rule 1: everything under .sidekicks/ is written through the CLI, and through the guard.
      assertWritable(abs, repoRoot);
      writeAtomic(abs, a._content);
      const after = hashFile(abs);
      if (after !== a.to_hash) {
        failures.push({ ...a, _content: undefined, error: `restored '${a.target}' still hashes ${after}` });
        continue;
      }
      a.applied = true;
      applied.push({ ...a, _content: undefined });
    } catch (err) {
      failures.push({ ...a, _content: undefined, error: err.message });
    }
  }

  for (const a of actions.filter((x) => x.verb.startsWith('pip-'))) {
    const result = spawnSync(a.pip, a.args, { shell: false, cwd: repoRoot, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      const first = ((result.stderr || result.stdout || '').split('\n').find((l) => l.trim()) || '').trim();
      failures.push({ ...a, error: first || (result.error && result.error.message) || 'pip failed' });
      continue;
    }
    a.applied = true;
    applied.push(a);
  }

  return { applied, failures };
}

/**
 * Run `skill heal`.
 *
 * @param {{repoRoot: string, argv: string[]}} ctx
 * @param {{name?: string}} args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, args) {
  const flags = parseSkillFlags(ctx.argv, ['apply', 'restore', 'json', 'all', 'include-test', 'no-pip']);
  const name = args && args.name ? args.name : null;
  const targets = resolveTargets(ctx.repoRoot, name, { all: true, verb: 'skill heal' });

  const opts = {
    restore: Boolean(flags.restore),
    includeTest: Boolean(flags['include-test']),
    pip: !flags['no-pip'],
    from: typeof flags.from === 'string' && flags.from ? flags.from : null,
  };

  const plans = targets.map((entry) => healPlan(ctx.repoRoot, entry, opts));
  const actions = plans.flatMap((p) => p.actions);
  const residue = plans.flatMap((p) => p.residue);

  let applied = [];
  let failures = [];
  if (flags.apply && actions.length) {
    ({ applied, failures } = applyHeal(ctx.repoRoot, actions));
  }

  const pending = flags.apply ? actions.filter((a) => !a.applied) : actions;
  // Exit 2 whenever something is left to do — under --check because CI must fail on it, and after
  // --apply because residue is the honest answer, not success with a footnote.
  const bad = failures.length ? EXIT_IO
    : ((pending.length || residue.length) ? EXIT_VALIDATION : EXIT_OK);

  if (flags.json) {
    const payload = {
      ok: bad === EXIT_OK,
      checked: plans.length,
      applied: Boolean(flags.apply),
      actions: actions.map((a) => ({ ...a, _content: undefined, pip: undefined })),
      residue,
      failures: failures.map((f) => ({ ...f, _content: undefined, pip: undefined })),
    };
    return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: bad };
  }

  const out = [];
  if (flags.apply) {
    out.push(`skill heal --apply: ${applied.length} action(s) applied`
      + `${failures.length ? `, ${failures.length} failed` : ''}`);
    for (const a of applied) out.push(`  + ${a.skill}: ${a.verb} ${a.target}`
      + `${a.source ? ` (from ${a.source})` : ''}`);
    for (const f of failures) out.push(`  ! ${f.skill}: ${f.verb} ${f.target} — ${f.error}`);
  } else if (actions.length) {
    out.push(`skill heal: ${actions.length} action(s) available (nothing written)`);
    for (const a of actions) out.push(`  ~ ${a.skill}: ${a.verb} ${a.target}`
      + `${a.source ? ` (from ${a.source})` : ''}`);
    out.push('');
    out.push(`  apply with 'sidekicks skill heal ${name || '--all'}`
      + `${opts.restore ? ' --restore' : ''} --apply'`);
  } else {
    out.push(`skill heal: nothing to install or restore (${plans.length} skill(s) checked)`);
  }

  if (residue.length) {
    out.push('');
    out.push(`Residue — ${residue.length} row(s) heal cannot act on:`);
    for (const r of residue) {
      out.push(`  [${r.reason}] ${r.skill}: ${r.section} ${r.target}`);
      out.push(`      ${r.detail}`);
      if (r.degraded) out.push(`      without it: ${r.degraded}`);
      if (r.remediation) out.push(`      -> ${r.remediation}`);
    }
  }

  if (bad === EXIT_IO) {
    throw new SidekicksError(out.join('\n'), EXIT_IO);
  }
  return { stdout: out.join('\n') + '\n', exitCode: bad };
}
