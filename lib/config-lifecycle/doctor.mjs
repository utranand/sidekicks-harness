// lib/config-lifecycle/doctor.mjs
// `sidekicks config doctor [--json] [--scope <name>]`
//
// The gate that makes configuration health checkable instead of discovered mid-task. Every check here
// exists because the defect it hunts has already cost this repo time:
//
//   duplicate-top-level-key  two blocks of the same name; YAML last-wins silently. Recorded in the
//                            memory entry `shp-config-duplicate-top-level-keys`, where the loser took
//                            `default_namespace: shph` out of PROD cluster-ops.
//   secret-in-committed-file a credential-shaped key with a value in a file that is NOT git-ignored.
//                            A committed credential is a published credential.
//   block-undeclared         a live block nothing declares — invisible to `config get`, `config list`
//                            and every other check. 14 of 25 live blocks were in this state.
//   legacy-monolith          the scope still keeps its pre-family config.yaml. Not an error (it is a
//                            supported layer) — a notice that `config migrate` has work to do.
//   defaults-missing         a declaration points `defaults:` at a file that is not there.
//   defaults-undeclared      a SKILL-owned block that ships no defaults and no builtin, so it has
//                            nothing to fall back to and `config sync` cannot document it. A NOTICE:
//                            some blocks are legitimately empty-by-design (a block keyed by an alias
//                            only the operator knows), so this asks the question rather than
//                            answering it.
//   family-file-unknown      a file in a scope's config/ that no family claims — a typo'd filename
//                            resolves to nothing at all, silently.
//
// Read-only: it never writes, and it never prints a credential's value.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { listBlocks } from '../config-store/read.mjs';
import { buildFamilies, FAMILIES, CONFIG_DIR, LEGACY_FILE } from '../config-store/families.mjs';
import { duplicateTopLevelKeys, secretValuedKeys, topLevelKeyLines } from '../config-store/lint.mjs';
import { SECRET_IGNORE_PATTERN, isSecretFileName } from '../config-store/write.mjs';
import { tightenSecretMode } from '../fs-safety/fsx.mjs';
import { FRAMEWORK_CONFIG_FILES } from '../config-store/paths.mjs';
import { parseConfigFlags } from './_shared.mjs';

/** Severity ranking, worst first. */
const ORDER = ['error', 'warning', 'notice'];

/**
 * Every scope that has configuration on this machine: root plus each project directory.
 *
 * @param {string} repoRoot
 * @returns {Array<{scope: string, base: string}>}
 */
function scopes(repoRoot) {
  const out = [{ scope: 'sidekicks', base: '.sidekicks' }];
  const projects = join(repoRoot, 'projects');
  if (!existsSync(projects)) return out;
  let entries;
  try {
    entries = readdirSync(projects, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of entries) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    const base = join('projects', dirent.name);
    const hasLegacy = existsSync(join(repoRoot, base, LEGACY_FILE));
    const hasDir = existsSync(join(repoRoot, base, CONFIG_DIR));
    if (hasLegacy || hasDir) out.push({ scope: dirent.name, base });
  }
  return out;
}

/**
 * The retired pre-family monolith, kept for one release as a rollback reference.
 * `config migrate` moves it to `<scope>/config/pending-removal.config.yaml` and writes the matching
 * ignore rule; nothing reads it, so it is checked for nothing.
 */
const PENDING_PREFIX = 'pending-removal.';

/** Is this path git-ignored? Decided by the ignore RULES, not by git — no subprocess, no repo state. */
function isIgnoredPath(relPath) {
  const posix = relPath.split('\\').join('/');
  const base = posix.split('/').pop();
  return posix.endsWith('.secret.yaml')
    || base.startsWith(PENDING_PREFIX)
    || posix === '.sidekicks/config.yaml'
    || /^projects\/[^/]+\/config\.yaml$/.test(posix);
}

/**
 * Run `config doctor`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  // `--fix` is deliberately narrow: it repairs FILE PERMISSIONS and nothing else. Every other
  // finding here names a decision (which half a credential belongs in, which block owns a key)
  // that a tool must not make on someone's behalf.
  const flags = parseConfigFlags(ctx.argv, ['json', 'fix']);

  const { blocks, byBlock } = buildFamilies(repoRoot);
  const declared = new Set(blocks.flatMap((b) => [b.block, ...b.aliases]));
  const familyFiles = new Set(FAMILIES.flatMap((f) => [f.file, f.secret]));
  for (const b of listBlocks(repoRoot)) {
    familyFiles.add(b.file);
    familyFiles.add(b.secret_file);
  }

  const findings = [];
  const add = (severity, check, scope, path, detail) =>
    findings.push({ severity, check, scope, path, detail });

  // A declaration pointing at a defaults file that is not there.
  for (const b of listBlocks(repoRoot)) {
    if (b.defaults && !existsSync(join(repoRoot, b.defaults))) {
      add('error', 'defaults-missing', '-', b.defaults,
        `block '${b.block}' declares this defaults file, which does not exist`);
    }
    // A skill-owned block with nothing beneath it. The fallback chain ends at the owning skill's
    // defaults, so without them the block resolves to nothing at all unless a scope configures it,
    // and `config sync` has nothing to document. A core block is exempt: framework code reads it,
    // there is no owning skill, and no defaults file is expected.
    // `builtin:` is read off the registry entry rather than the listBlocks row, which does not carry
    // it — checking a field that is always undefined would have made this fire on blocks that DO
    // document a fallback.
    const entry = byBlock.get(b.block);
    if (b.source === 'skill' && !b.defaults && !(entry && entry.builtin)) {
      add('notice', 'defaults-undeclared', '-', `${b.owners[0] || '?'}/skill.yaml`,
        `block '${b.block}' is declared without 'defaults:' and without a 'builtin:' — it resolves `
        + 'to nothing unless a scope configures it. Add a config.defaults.yaml, or record why the '
        + 'block is empty by design in the descriptor comment');
    }
  }

  const wanted = flags.scope ? String(flags.scope) : null;
  for (const { scope, base } of scopes(repoRoot)) {
    if (wanted && scope !== wanted) continue;

    const files = [];
    const legacyRel = join(base, LEGACY_FILE);
    if (existsSync(join(repoRoot, legacyRel))) {
      files.push(legacyRel);
      add('notice', 'legacy-monolith', scope, legacyRel,
        'still the pre-family monolith — run `sidekicks config migrate` to split it by family');
    }
    const dirRel = join(base, CONFIG_DIR);
    if (existsSync(join(repoRoot, dirRel))) {
      // The directory must ignore its own secret files. The repo-root .gitignore is NOT enough: a
      // project may be a git submodule with its own rules (projects/shp-sk, projects/workspace-sk) or
      // a symlink to an out-of-tree directory, and in both cases the root rule does not apply — so
      // `git add config/` in that repo would stage the credentials.
      const ignoreRel = join(dirRel, '.gitignore');
      const ignoreAbs = join(repoRoot, ignoreRel);
      const ignored = existsSync(ignoreAbs)
        && readFileSync(ignoreAbs, 'utf8').split(/\r?\n/).some((l) => l.trim() === SECRET_IGNORE_PATTERN);
      if (!ignored) {
        add('error', 'secret-files-not-ignored', scope, ignoreRel,
          `this directory does not ignore '${SECRET_IGNORE_PATTERN}', so its credential files are `
          + 'committable — run `sidekicks config migrate` or `config set` to write the rule');
      }
      let entries = [];
      try {
        entries = readdirSync(join(repoRoot, dirRel), { withFileTypes: true });
      } catch {
        add('error', 'config-dir-unreadable', scope, dirRel, 'directory could not be read');
      }
      for (const dirent of entries) {
        if (!dirent.isFile()) continue;
        if (!dirent.name.endsWith('.yaml')) continue;
        if (dirent.name.endsWith('.example.yaml')) continue;
        // The retired monolith is inert: no reader looks at it and no check applies to it.
        if (dirent.name.startsWith(PENDING_PREFIX)) continue;
        // FRAMEWORK configuration files share the directory but are not family files: the enable map,
        // the external-CLI registry, the watch list, the office template. Their top-level keys are
        // their own schema (`rules:`, `criteria:`, `hooks:`), owned by the framework rather than
        // declared as config blocks — checking them against the family registry reports a defect for
        // every one of them. This is why FRAMEWORK_CONFIG_FILES exists.
        if (FRAMEWORK_CONFIG_FILES.includes(dirent.name)) continue;
        const rel = join(dirRel, dirent.name);
        files.push(rel);
        if (!familyFiles.has(dirent.name)) {
          add('error', 'family-file-unknown', scope, rel,
            'no family claims this filename, so nothing will ever read it — check the spelling '
            + 'against `sidekicks config list`');
        }
      }
    }

    for (const rel of files) {
      let text;
      try {
        text = readFileSync(join(repoRoot, rel), 'utf8');
      } catch (err) {
        add('error', 'unreadable', scope, rel, err.message);
        continue;
      }
      for (const dup of duplicateTopLevelKeys(text)) {
        add('error', 'duplicate-top-level-key', scope, rel,
          `block '${dup.key}' is declared ${dup.lines.length} times (lines ${dup.lines.join(', ')}) `
          + '— every YAML parser keeps only the last one, silently');
      }
      if (!isIgnoredPath(rel)) {
        // A key a block declares as public is not a credential, and neither is its subtree.
        const publicFor = (blockName) => {
          const entry = blockName ? byBlock.get(blockName) : null;
          return new Set(entry ? entry.public_keys : []);
        };
        for (const hit of secretValuedKeys(text, { publicKeys: publicFor })) {
          add('error', 'secret-in-committed-file', scope, rel,
            `line ${hit.line}: '${hit.key}'${hit.block ? ` under '${hit.block}'` : ''} carries a `
            + `value in a file that is not git-ignored — move it to the '.secret.yaml' sibling`);
        }
      }
      for (const { key, line } of topLevelKeyLines(text)) {
        if (declared.has(key)) continue;
        add('error', 'block-undeclared', scope, rel,
          `line ${line}: block '${key}' is declared by nothing — add a 'config:' entry to the `
          + "owning skill's skill.yaml, or to lib/config-store/core-families.mjs");
      }

      // A credential file readable by every account on the machine. New writes are owner-only
      // (writeSecretAtomic), but a file written before that existed keeps its old mode until
      // something repairs it — and git-ignore has never been a defence against a local reader.
      // Windows is skipped rather than reported: chmod there is the read-only attribute, not an
      // ACL, so a mode check would be answering a different question.
      if (isSecretFileName(rel) && process.platform !== 'win32') {
        try {
          const mode = statSync(join(repoRoot, rel)).mode & 0o777;
          if (mode & 0o077) {
            if (flags.fix) {
              const { repaired } = tightenSecretMode(join(repoRoot, rel));
              add('notice', 'secret-file-mode', scope, rel,
                repaired
                  ? `was ${mode.toString(8).padStart(3, '0')}, tightened to 600 (owner-only)`
                  : `is ${mode.toString(8).padStart(3, '0')} and could not be changed — fix it by hand`);
            } else {
              add('warning', 'secret-file-mode', scope, rel,
                `is mode ${mode.toString(8).padStart(3, '0')} — a credential file readable by other `
                + 'local accounts. Re-run `config doctor --fix` to tighten it to 600');
            }
          }
        } catch { /* the file vanished between listing and stat — nothing to report */ }
      }
    }
  }

  findings.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity)
    || a.scope.localeCompare(b.scope) || a.check.localeCompare(b.check));
  const errors = findings.filter((f) => f.severity === 'error').length;
  const exitCode = errors ? EXIT_VALIDATION : EXIT_OK;

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        checked_scopes: scopes(repoRoot).map((s) => s.scope),
        errors,
        warnings: findings.filter((f) => f.severity === 'warning').length,
        notices: findings.filter((f) => f.severity === 'notice').length,
        findings,
      }, null, 2) + '\n',
      exitCode,
    };
  }

  if (!findings.length) {
    return { stdout: 'config doctor: clean — every live block is declared and no file leaks a credential\n', exitCode };
  }
  const out = [`config doctor: ${errors} error(s), ${findings.length - errors} other finding(s)`, ''];
  for (const f of findings) {
    out.push(`  [${f.severity}] ${f.check}  ${f.scope}`);
    out.push(`      ${f.path}`);
    out.push(`      ${f.detail}`);
  }
  return { stdout: out.join('\n') + '\n', exitCode };
}
