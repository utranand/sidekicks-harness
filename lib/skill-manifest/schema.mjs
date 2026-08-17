// lib/skill-manifest/schema.mjs
// Validation and normalization for `.agents/skills/<skill>/skill.manifest.yaml`.
//
// WHY A SEPARATE FILE FROM skill.yaml. lib/framework-settings/registry.mjs states the invariant
// this module exists to protect: "A skill that owns nothing ships no descriptor. Coverage is
// therefore DISCOVERED, never counted." Only the skills that own a rule, a hook or a config block
// carry a skill.yaml. Runtime dependencies are a different axis with a different consumer, and
// folding them into the descriptor would force ~50 more skills to ship one with empty rules/hooks/
// config — inverting that invariant and coupling two unrelated gates. So the manifest is its own
// file and registry.mjs is not modified at all.
//
// WHY validate() RETURNS ERRORS INSTEAD OF THROWING. `skill doctor` reports every problem it can
// see in one pass (the lib/framework-lifecycle/doctor.mjs contract). A validator that throws on the
// first bad row turns one run into N round trips. Only an unparseable file throws, because there is
// nothing left to inspect.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { parse } from '../yaml-subset/yaml.mjs';

export const MANIFEST_NAME = 'skill.manifest.yaml';
export const MANIFEST_SCHEMA = 1;

// How a skill reaches a sibling. `import` means a language-level import of the sibling's module;
// everything else crosses a process or a document boundary and therefore degrades on its own.
export const HOW_VALUES = Object.freeze(['import', 'subprocess', 'cli-verb', 'handoff', 'prose']);

// Runners the lift-and-run harness knows how to invoke for an `entrypoints:` smoke check.
export const RUNNER_VALUES = Object.freeze(['python', 'node', 'bash']);

// Whether a dependency is needed to RUN the skill or only to run its tests. Applies to
// `requires.python` and `requires.sibling_skills` alike: a lifted skill is complete without its
// test scope, so the distinction has to be recorded rather than inferred. Getting it wrong is not
// cosmetic — it would have `skill heal` install a test harness, or demand a sibling that only a
// test fixture ever reaches, to satisfy a runtime check.
export const DEP_SCOPES = Object.freeze(['runtime', 'test']);

// Sections whose entries are NOT healable, and therefore MUST carry a `degraded:` sentence.
// That prose is what the lift harness reads to know an absence is expected rather than a break,
// and what SKILL.md has to document for the human.
const DEGRADED_REQUIRED = Object.freeze(['sibling_skills', 'host_paths', 'framework_files', 'framework_hooks']);

// The marker `skill manifest --apply` writes where only a human can supply the value.
//
// WHY IT IS TRACKED SEPARATELY FROM ERRORS. The generator has to emit a structurally VALID file or
// nothing downstream can read it, but a placeholder that satisfies the schema would launder an
// unanswered question into a pass. So a TODO validates and is reported: `skill verify` stays green
// (the file is well-formed) while `skill doctor` keeps asking until a human writes the sentence.
export const TODO_MARKER = 'TODO';

/** @param {unknown} v @returns {boolean} */
function isTodo(v) {
  return typeof v === 'string' && v.trimStart().startsWith(TODO_MARKER);
}

// The two sections whose paths legitimately point outside the skill folder: a hook body is
// framework territory (lib/framework-settings/core-registry.mjs:12-14) and a host path is outside
// the repo entirely. Every other path field must stay inside the skill so the folder can be lifted.
const OUTSIDE_OK = Object.freeze(new Set(['framework_files', 'framework_hooks', 'host_paths']));

/** @returns {{schema: number, skill: string|null, requires: object, entrypoints: object[], bundle: Record<string,string>}} */
function emptyManifest() {
  return {
    schema: MANIFEST_SCHEMA,
    skill: null,
    requires: {
      python: [],
      node: [],
      binaries: [],
      sibling_skills: [],
      host_paths: [],
      framework_files: [],
      config: null,
      framework_hooks: [],
      framework_rules: [],
    },
    not_required: {
      binaries: [],
      sibling_skills: [],
      framework_files: [],
    },
    entrypoints: [],
    bundle: {},
  };
}

/** A path that would not survive the skill folder being copied somewhere else. */
function escapesSkill(p) {
  if (typeof p !== 'string' || p === '') return true;
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return true;   // absolute, incl. Windows
  return p.split(/[\\/]/).includes('..');
}

function isMap(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// The complete key set each row type reads. A key outside it is REPORTED rather than dropped: an
// unread field looks exactly like an honoured one, so a field nothing implements would silently
// promise behaviour. Same reasoning as `descriptor-unknown-key` one level up.
//
// `optional` on a sibling row was excluded on the grounds that "a sibling is never installed either
// way", which conflated INSTALLATION with INTEGRITY. Nothing installs a sibling, true — but
// `skill verify` grades a declared-and-absent one as a hard integrity error, and some edges are
// genuinely optional: sk-commander calls sk-jira-footprint best-effort and ignores its
// exit code, so a core that ships one and not the other is correct and was failing a gate anyway.
// The field is now read AND honoured (lib/skill-lifecycle/audit.mjs → `declared-optional-absent`,
// a notice), which is what makes declaring it honest rather than decorative.
const ROW_KEYS = Object.freeze({
  python: ['package', 'import', 'scope', 'optional', 'why'],
  node: ['package', 'scope', 'optional', 'why'],
  binaries: ['name', 'optional', 'why', 'install_hint', 'install_hint_windows'],
  sibling_skills: ['skill', 'how', 'entry', 'scope', 'optional', 'degraded'],
  host_paths: ['path', 'degraded'],
  framework_files: ['path', 'degraded'],
  framework_hooks: ['id', 'script', 'degraded'],
  framework_rules: ['id', 'title', 'body'],
  entrypoints: ['path', 'runner', 'smoke'],
});

/**
 * Read a list-of-mappings section, reporting every malformed row instead of skipping it.
 *
 * @param {unknown} raw
 * @param {string} section
 * @param {string} label - the file being validated, for the error text
 * @param {string[]} errors
 * @returns {object[]}
 */
function rows(raw, section, label, errors, opts = {}) {
  const prefix = opts.prefix === undefined ? 'requires.' : opts.prefix;
  const where = `${prefix}${section}`;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${label}: ${where} must be a list`);
    return [];
  }
  const known = opts.keys || ROW_KEYS[section];
  const out = [];
  raw.forEach((row, i) => {
    if (!isMap(row)) {
      errors.push(`${label}: ${where}[${i}] must be a mapping`);
      return;
    }
    if (known) {
      for (const key of Object.keys(row)) {
        if (known.includes(key)) continue;
        errors.push(
          `${label}: ${where}[${i}] has unknown key '${key}' — `
          + `${section} rows read only ${known.join(', ')}`
        );
      }
    }
    out.push(row);
  });
  return out;
}

/** Every non-healable row needs its degradation stated, not implied. */
function requireDegraded(row, section, i, label, errors, todos) {
  if (!DEGRADED_REQUIRED.includes(section)) return;
  if (typeof row.degraded !== 'string' || row.degraded.trim() === '') {
    errors.push(
      `${label}: requires.${section}[${i}] needs a 'degraded:' sentence — this dependency `
      + 'cannot be healed, so what happens without it must be stated'
    );
    return;
  }
  if (isTodo(row.degraded)) {
    todos.push(
      `requires.${section}[${i}] (${row.skill || row.path || row.id}): degraded: is still a `
      + 'placeholder — state what actually breaks without this'
    );
  }
}

/** Reject a path that would break when the skill folder is copied out. */
function checkPath(value, field, section, i, label, errors) {
  if (typeof value !== 'string' || value === '') {
    errors.push(`${label}: requires.${section}[${i}].${field} must be a non-empty string`);
    return;
  }
  if (OUTSIDE_OK.has(section)) return;
  if (escapesSkill(value)) {
    errors.push(
      `${label}: requires.${section}[${i}].${field} is '${value}', which escapes the skill folder `
      + '— a lifted skill cannot resolve it'
    );
  }
}

/**
 * Validate and normalize a parsed manifest object.
 *
 * @param {unknown} obj - the parsed YAML mapping
 * @param {string} skill - the folder name the manifest lives in
 * @param {string} label - repo-relative path, used in every message
 * @returns {{ manifest: ReturnType<typeof emptyManifest>, errors: string[] }}
 */
export function validateManifest(obj, skill, label) {
  const errors = [];
  const todos = [];
  const manifest = emptyManifest();

  if (!isMap(obj)) {
    errors.push(`${label}: top-level value must be a mapping`);
    return { manifest, errors, todos };
  }

  if (obj.schema !== undefined && obj.schema !== MANIFEST_SCHEMA) {
    errors.push(`${label}: schema must be ${MANIFEST_SCHEMA} (found ${JSON.stringify(obj.schema)})`);
  }
  // Same check registry.mjs makes for a descriptor: the file must not claim to be another skill.
  if (obj.skill !== undefined && obj.skill !== skill) {
    errors.push(`${label}: declares skill '${obj.skill}' but lives in '${skill}/'`);
  }
  manifest.skill = skill;

  const req = obj.requires === undefined || obj.requires === null ? {} : obj.requires;
  if (!isMap(req)) {
    errors.push(`${label}: 'requires' must be a mapping`);
    return { manifest, errors, todos };
  }

  // ── requires.python ───────────────────────────────────────────────────────────
  // `import:` is what makes this verifiable with no pip resolution: probe the import name in the
  // repo-root .venv. That is how the 27 skills with third-party imports and no requirements.txt
  // become checkable at all.
  rows(req.python, 'python', label, errors).forEach((row, i) => {
    if (typeof row.package !== 'string' || row.package === '') {
      errors.push(`${label}: requires.python[${i}].package must name a pip package`);
    }
    if (typeof row.import !== 'string' || row.import === '') {
      errors.push(
        `${label}: requires.python[${i}].import must name the module the code imports `
        + '(so verification can probe it without resolving pip metadata)'
      );
    }
    // `scope: test` means the package is needed to run this skill's tests, not the skill itself —
    // so a lifted copy is complete without it and heal must not treat its absence as a break.
    if (row.scope !== undefined && !DEP_SCOPES.includes(row.scope)) {
      errors.push(
        `${label}: requires.python[${i}].scope must be one of ${DEP_SCOPES.join('|')}`
      );
    }
    manifest.requires.python.push({
      package: row.package,
      import: row.import,
      scope: DEP_SCOPES.includes(row.scope) ? row.scope : 'runtime',
      optional: row.optional === true,
      why: typeof row.why === 'string' ? row.why : null,
    });
  });

  // ── requires.node ─────────────────────────────────────────────────────────────
  rows(req.node, 'node', label, errors).forEach((row, i) => {
    if (typeof row.package !== 'string' || row.package === '') {
      errors.push(`${label}: requires.node[${i}].package must name an npm package`);
    }
    manifest.requires.node.push({
      package: row.package,
      scope: typeof row.scope === 'string' ? row.scope : 'dependencies',
      why: typeof row.why === 'string' ? row.why : null,
    });
  });

  // ── requires.binaries ─────────────────────────────────────────────────────────
  rows(req.binaries, 'binaries', label, errors).forEach((row, i) => {
    if (typeof row.name !== 'string' || row.name === '') {
      errors.push(`${label}: requires.binaries[${i}].name must name the command`);
    }
    manifest.requires.binaries.push({
      name: row.name,
      optional: row.optional === true,
      why: typeof row.why === 'string' ? row.why : null,
      install_hint: typeof row.install_hint === 'string' ? row.install_hint : null,
      install_hint_windows: typeof row.install_hint_windows === 'string'
        ? row.install_hint_windows
        : null,
    });
  });

  // ── requires.sibling_skills ───────────────────────────────────────────────────
  rows(req.sibling_skills, 'sibling_skills', label, errors).forEach((row, i) => {
    if (typeof row.skill !== 'string' || row.skill === '') {
      errors.push(`${label}: requires.sibling_skills[${i}].skill must name a skill`);
    } else if (row.skill === skill) {
      errors.push(`${label}: requires.sibling_skills[${i}] declares itself`);
    }
    if (!HOW_VALUES.includes(row.how)) {
      errors.push(
        `${label}: requires.sibling_skills[${i}].how must be one of ${HOW_VALUES.join('|')} `
        + '— it decides whether the edge is copied or only declared'
      );
    }
    if (row.entry !== undefined && row.entry !== null) {
      // entry is a path inside the SIBLING, so it may not climb out of that sibling either.
      if (typeof row.entry !== 'string' || escapesSkill(row.entry)) {
        errors.push(`${label}: requires.sibling_skills[${i}].entry '${row.entry}' is not a sibling-relative path`);
      }
    }
    // Same split as requires.python: an edge reached only from this skill's own tests belongs to
    // the test suite, not to the shipped behaviour. A lifted copy still RUNS without it, so a
    // `heal` that treated it as runtime would demand a sibling the skill never calls in anger.
    if (row.scope !== undefined && !DEP_SCOPES.includes(row.scope)) {
      errors.push(
        `${label}: requires.sibling_skills[${i}].scope must be one of ${DEP_SCOPES.join('|')}`
      );
    }
    requireDegraded(row, 'sibling_skills', i, label, errors, todos);
    manifest.requires.sibling_skills.push({
      skill: row.skill,
      how: row.how,
      entry: typeof row.entry === 'string' ? row.entry : null,
      scope: DEP_SCOPES.includes(row.scope) ? row.scope : 'runtime',
      // Absence of an optional sibling is a notice, not an integrity error — the degraded sentence
      // has to describe a skill that still WORKS without it, which requireDegraded already enforces.
      optional: row.optional === true,
      degraded: typeof row.degraded === 'string' ? row.degraded : null,
    });
  });

  // ── requires.host_paths ───────────────────────────────────────────────────────
  rows(req.host_paths, 'host_paths', label, errors).forEach((row, i) => {
    checkPath(row.path, 'path', 'host_paths', i, label, errors);
    requireDegraded(row, 'host_paths', i, label, errors, todos);
    manifest.requires.host_paths.push({
      path: row.path,
      why: typeof row.why === 'string' ? row.why : null,
      degraded: typeof row.degraded === 'string' ? row.degraded : null,
    });
  });

  // ── requires.config (DERIVED from skill.yaml) ─────────────────────────────────
  if (req.config !== undefined && req.config !== null) {
    if (!isMap(req.config)) {
      errors.push(`${label}: requires.config must be a mapping`);
    } else {
      if (typeof req.config.block !== 'string' || req.config.block === '') {
        errors.push(`${label}: requires.config.block must name the scope-config block`);
      }
      manifest.requires.config = {
        block: req.config.block,
        defaults: typeof req.config.defaults === 'string' ? req.config.defaults : null,
        example: typeof req.config.example === 'string' ? req.config.example : null,
      };
    }
  }

  // ── requires.framework_files ──────────────────────────────────────────────────
  // A repo-root file the skill RUNS or READS that is not a wired hook body: scripts/send-mail.py,
  // lib/database-lifecycle/add.mjs, scripts/launchd/*.plist. framework_hooks cannot hold these — its
  // rows are keyed by a registered hook id — and without a home for them the only remediation the
  // doctor could offer was the wrong one.
  rows(req.framework_files, 'framework_files', label, errors).forEach((row, i) => {
    checkPath(row.path, 'path', 'framework_files', i, label, errors);
    requireDegraded(row, 'framework_files', i, label, errors, todos);
    manifest.requires.framework_files.push({
      path: row.path,
      why: typeof row.why === 'string' ? row.why : null,
      degraded: typeof row.degraded === 'string' ? row.degraded : null,
    });
  });

  // ── requires.framework_hooks (DERIVED from skill.yaml) ────────────────────────
  rows(req.framework_hooks, 'framework_hooks', label, errors).forEach((row, i) => {
    if (typeof row.id !== 'string' || !row.id.startsWith('hook.')) {
      errors.push(`${label}: requires.framework_hooks[${i}].id must be a hook.* id`);
    }
    checkPath(row.script, 'script', 'framework_hooks', i, label, errors);
    requireDegraded(row, 'framework_hooks', i, label, errors, todos);
    manifest.requires.framework_hooks.push({
      id: row.id,
      script: row.script,
      degraded: typeof row.degraded === 'string' ? row.degraded : null,
    });
  });

  // ── requires.framework_rules (DERIVED from skill.yaml) ────────────────────────
  // The rules and criteria this skill OWNS, and where each body lives inside the skill folder.
  //
  // WHY IT HAS TO BE HERE. `requires.config` already made the skill's configuration half portable;
  // without this section the SETTINGS half was invisible to export, import, verify and heal — a
  // lifted skill arrived with a `rules/criterion.*.md` body nothing knew to check, and an id the
  // destination never listed in its own settings files. `body` is skill-relative (unlike a hook
  // script, which is framework territory), so it is held to the escapes-skill rule like every other
  // in-skill path: a body that cannot travel with the folder is the defect this catches.
  rows(req.framework_rules, 'framework_rules', label, errors).forEach((row, i) => {
    if (typeof row.id !== 'string' || !/^(rule|criterion)\./.test(row.id)) {
      errors.push(`${label}: requires.framework_rules[${i}].id must be a rule.* or criterion.* id `
        + '(a hook id belongs in requires.framework_hooks — hook bodies are framework-owned)');
    }
    if (row.body !== undefined && row.body !== null) {
      checkPath(row.body, 'body', 'framework_rules', i, label, errors);
    }
    manifest.requires.framework_rules.push({
      id: row.id,
      title: typeof row.title === 'string' ? row.title : null,
      body: typeof row.body === 'string' ? row.body : null,
    });
  });

  // ── entrypoints ───────────────────────────────────────────────────────────────
  if (obj.entrypoints !== undefined && obj.entrypoints !== null) {
    if (!Array.isArray(obj.entrypoints)) {
      errors.push(`${label}: 'entrypoints' must be a list`);
    } else {
      obj.entrypoints.forEach((row, i) => {
        if (!isMap(row)) {
          errors.push(`${label}: entrypoints[${i}] must be a mapping`);
          return;
        }
        if (typeof row.path !== 'string' || escapesSkill(row.path)) {
          errors.push(`${label}: entrypoints[${i}].path '${row.path}' must be inside the skill folder`);
        }
        if (!RUNNER_VALUES.includes(row.runner)) {
          errors.push(`${label}: entrypoints[${i}].runner must be one of ${RUNNER_VALUES.join('|')}`);
        }
        manifest.entrypoints.push({
          path: row.path,
          runner: row.runner,
          smoke: typeof row.smoke === 'string' ? row.smoke : null,
        });
      });
    }
  }

  // ── not_required (AUTHORED rejections) ────────────────────────────────────────
  //
  // WHY THIS SECTION EXISTS. The scanner cannot be right about prose, and it never will be: the
  // repo names a tool as often to FORBID it as to require it, and a path in a sentence can be an
  // example or an edit target rather than something read. Measured cases from the backfill —
  // "the resolver hard-excludes bmad/bmm/config.yaml", "Do not use this skill to run `pg_dump`",
  // and a list of shared files two parallel stories might both EDIT. Hand review resolves those,
  // and before this section there was nowhere to put the answer: a row deleted from `requires:`
  // came straight back on the next `--apply`, because materialize.mjs only ever refuses to
  // re-decide a choice it can SEE. This is where "looked, not a dependency" is recorded, next to
  // the thing it is about, with the reason — instead of an invisible known-gaps suppression.
  if (obj.not_required !== undefined && obj.not_required !== null) {
    if (!isMap(obj.not_required)) {
      errors.push(`${label}: 'not_required' must be a mapping`);
    } else {
      const nr = obj.not_required;
      const sections = [
        ['binaries', 'name'],
        ['sibling_skills', 'skill'],
        ['framework_files', 'path'],
      ];
      for (const [section, keyField] of sections) {
        const opts = { prefix: 'not_required.', keys: [keyField, 'why'] };
        rows(nr[section], section, label, errors, opts).forEach((row, i) => {
          if (typeof row[keyField] !== 'string' || row[keyField] === '') {
            errors.push(`${label}: not_required.${section}[${i}].${keyField} is required`);
          }
          // A rejection with no reason is indistinguishable from a mistake, and it is the ONLY
          // thing that makes this section auditable rather than a way to silence the gate.
          if (typeof row.why !== 'string' || row.why.trim() === '') {
            errors.push(
              `${label}: not_required.${section}[${i}] needs a 'why:' — a rejected finding without a `
              + 'stated reason is just a suppression'
            );
          } else if (isTodo(row.why)) {
            todos.push(`not_required.${section}[${i}] (${row[keyField]}): why: is still a placeholder`);
          }
          manifest.not_required[section].push({
            [keyField]: row[keyField],
            why: typeof row.why === 'string' ? row.why : null,
          });
        });
      }
      for (const key of Object.keys(nr)) {
        if (!sections.some(([s]) => s === key)) {
          errors.push(
            `${label}: not_required.${key} is not a section — `
            + `only ${sections.map(([s]) => s).join(', ')} can be rejected`
          );
        }
      }
    }
  }

  // ── bundle (DERIVED hash baseline) ────────────────────────────────────────────
  if (obj.bundle !== undefined && obj.bundle !== null) {
    if (!isMap(obj.bundle)) {
      errors.push(`${label}: 'bundle' must be a mapping of path to sha256`);
    } else {
      for (const [p, h] of Object.entries(obj.bundle)) {
        if (escapesSkill(p)) {
          errors.push(`${label}: bundle path '${p}' escapes the skill folder`);
          continue;
        }
        if (typeof h !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(h)) {
          errors.push(`${label}: bundle['${p}'] must be 'sha256:<64 hex>'`);
          continue;
        }
        manifest.bundle[p] = h;
      }
    }
  }

  // A key nobody reads is a typo nobody sees. Report it rather than ignoring it silently —
  // the same failure mode `descriptor-unknown-key` catches on skill.yaml.
  const known = new Set(['schema', 'skill', 'requires', 'not_required', 'entrypoints', 'bundle']);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      errors.push(`${label}: unknown top-level key '${key}' — nothing reads it`);
    }
  }
  const knownRequires = new Set([
    'python', 'node', 'binaries', 'sibling_skills', 'host_paths', 'config',
    'framework_files', 'framework_hooks', 'framework_rules',
  ]);
  for (const key of Object.keys(req)) {
    if (!knownRequires.has(key)) {
      errors.push(`${label}: unknown key 'requires.${key}' — nothing reads it`);
    }
  }

  return { manifest, errors, todos };
}

/**
 * Parse manifest text. Only an unparseable file throws — there is nothing left to report on.
 *
 * @param {string} text
 * @param {string} skill
 * @param {string} label
 * @returns {{ manifest: ReturnType<typeof emptyManifest>, errors: string[] }}
 */
export function parseManifest(text, skill, label) {
  assertNoBlockScalar(text, label);
  let obj;
  try {
    obj = parse(text);
  } catch (err) {
    throw new SidekicksError(`skill: failed to parse '${label}': ${err.message}`, EXIT_VALIDATION);
  }
  return validateManifest(obj, skill, label);
}

/**
 * Refuse a block scalar (`key: >-`, `key: |`) before the yaml-subset reader silently mangles it.
 *
 * WHY THIS EXISTS. lib/yaml-subset supports no block scalars at all, and it does not say so: it
 * takes the INDICATOR as the value — `degraded: >-` parses to the literal string ">-" — and then
 * reads the folded body lines as structure. In a sequence that swallows every following item, so a
 * hand-written manifest with three declared siblings parsed cleanly, reported no error, and returned
 * ONE. Silent truncation of a dependency declaration is the worst failure this file can have: the
 * whole point of the manifest is that what it says is what is there.
 *
 * A prose sentence wants to wrap, so this WILL be reached by an author. Rejecting it loudly, with the
 * line and the fix, is the only safe answer while the shared parser cannot fold. Kept local to the
 * manifest reader on purpose — adding it to yaml-subset's own pre-scan would reject the many
 * improvements/*.yaml files that use block scalars with a different reader.
 */
function assertNoBlockScalar(text, label) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('#')) continue;
    if (!/(?::|^\s*-)\s*[|>][+-]?\d*\s*$/.test(lines[i])) continue;
    throw new SidekicksError(
      `skill: '${label}' line ${i + 1} uses a YAML block scalar (| or >), which the yaml-subset `
      + 'reader parses as the literal indicator and then mis-reads the body as structure — put the '
      + 'sentence on one single-quoted line instead',
      EXIT_VALIDATION
    );
  }
}
