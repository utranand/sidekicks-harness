// lib/skill-lifecycle/audit.mjs
// The findings engine behind `sidekicks skill doctor`.
//
// WHY auditSkills() IS EXPORTED. Same reason lib/framework-lifecycle/doctor.mjs exports
// auditFramework(): the test suite must assert the checks the VERB runs, not a re-implementation of
// them. A gate and a verb that disagree is the failure mode this whole card exists to close.
//
// CONTRACT, inherited from framework doctor:
//   - every problem is reported, never the first one only (a partial report invites a round trip)
//   - every finding names the exact command that fixes it
//   - findings are {skill, check, severity, detail, remediation}
//
// SEVERITY. `error` is a break: something declared is absent, something is unportable in every
// reading, or a manifest does not validate. `notice` is an omission: a real edge nobody has declared
// yet. The backfill drains notices; the ratchet in known-gaps.mjs keeps the gate green meanwhile.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverSkills,
  readSkillManifest,
  readSkillDescriptor,
  readFrontmatterDependsOn,
  derivedSections,
  derivedDrift,
  MANIFEST_NAME,
} from '../skill-manifest/read.mjs';
import { hashFile } from '../skill-manifest/hash.mjs';
import {
  scanSkill, manifestRequired, walkSkillFiles, buildModuleOwners, PY_STDLIB, PY_NAMESPACE_ROOTS,
} from './scan.mjs';
import { isKnownGap } from './known-gaps.mjs';
import { hardcodedTunables, policyProse } from './settings-split.mjs';

/**
 * Audit every skill (or one), returning findings plus the per-skill state the other verbs render.
 *
 * @param {string} repoRoot
 * @param {{skill?: string|null}} [opts]
 * @returns {{
 *   findings: Array<{skill: string, check: string, severity: string, detail: string, remediation: string, suppressed: boolean}>,
 *   skills: Array<object>,
 *   counts: object,
 * }}
 */
export function auditSkills(repoRoot, opts = {}) {
  const all = discoverSkills(repoRoot);
  const universe = all.map((s) => s.skill);
  const targets = opts.skill ? all.filter((s) => s.skill === opts.skill) : all;

  // Walk every skill ONCE, up front. The module-owner index has to exist before any skill is
  // scanned: an `import query_runner` is only recognisable as a borrowed sibling module if the
  // scanner already knows which skill's scripts/ provides that name.
  const filesBySkill = new Map(all.map((e) => [e.skill, walkSkillFiles(e.dir)]));
  const moduleOwners = buildModuleOwners(filesBySkill);

  // A declared sibling is resolved by NAME against every discovered skill, never by joining the
  // declaring skill's own tree. Skills live in two trees — `.agents/skills` and
  // `.sidekicks/skill-offloaded` — and a tree-local join reports a present, active sibling as
  // missing whenever the two sit in different trees. The generator produces exactly that row
  // (sk-flow-prompt-smith is offloaded and hands off to the active sk-cli-executor by
  // absolute path, scripts/craft_manifest.py:227), so `skill manifest --apply` was writing a
  // manifest `skill doctor` then called an error.
  const entryByName = new Map(all.map((e) => [e.skill, e]));

  const findings = [];
  const states = [];

  // Basename -> [{skill, rel, hash}] across every scanned skill, for the duplicate check below.
  // Collected over ALL skills even when auditing one, because a duplicate is a property of a pair.
  const byBasename = new Map();

  const add = (skill, check, severity, detail, remediation) => {
    findings.push({
      skill, check, severity, detail, remediation,
      suppressed: isKnownGap(skill, check),
    });
  };

  for (const entry of all) {
    const scan = scanSkill(repoRoot, entry, universe, {
      files: filesBySkill.get(entry.skill),
      moduleOwners,
    });
    const descriptor = readSkillDescriptor(repoRoot, entry);
    const { required, because } = manifestRequired(scan, Boolean(descriptor));
    const read = readSkillManifest(repoRoot, entry);
    const derived = derivedSections(descriptor, entry.skill);

    // Only files under scripts/ participate in the duplicate check: a duplicate README.md or
    // config.example.yaml is expected and says nothing, whereas two copies of an executable module
    // under scripts/ is the shape that drifts.
    for (const f of scan.files) {
      if (!f.inScripts || !/\.(py|mjs|js|sh)$/i.test(f.rel)) continue;
      const base = f.rel.split('/').pop();
      // A shared basename only means something when the AUTHOR CHOSE the name. `__init__.py` is
      // the one filename in Python the author does not choose: the language requires it to mark a
      // package, so two packages will always collide on it no matter how unrelated they are. The
      // repo proves the point — nine of the ten hits are 0-byte markers under `scripts/tests/`
      // and the tenth is sk-watermark-replacer's 15-line `wmr/__init__.py` re-export list.
      // Calling those "forks, not one module" is false, and acting on that remediation would mean
      // unifying files whose whole content is dictated by which package they sit in. Only the
      // reserved name is skipped; every other file inside those packages is still compared, and
      // `conftest.py` deliberately stays reported — pytest reserves that name too, but its
      // content is authored fixtures, and four skills carrying near-identical sys.path boilerplate
      // is exactly the duplication this check exists to surface.
      if (base === '__init__.py') continue;
      const list = byBasename.get(base) || [];
      list.push({ skill: entry.skill, rel: f.rel, hash: hashFile(f.abs) });
      byBasename.set(base, list);
    }

    const isTarget = targets.some((t) => t.skill === entry.skill);
    if (isTarget) {
      states.push(auditOne(
        repoRoot, entry, scan, descriptor, read, derived, required, because, add, entryByName
      ));
    }
  }

  // ── duplicate-basename, across skills ─────────────────────────────────────────
  // Two copies of a same-named module with DIFFERENT content. This is deliberately a notice: the
  // seven scope.py and five config_loader.py copies in this repo are measured forks with real
  // semantic differences (167-232 and 134-216 lines), not drifted duplicates. Unifying them is a
  // semantic merge across production-access paths and belongs to its own card. What this card owes
  // is visibility: an acknowledged duplicate is recorded, and a NEW one fails.
  //
  // ACROSS skills is load-bearing, not decorative. A skill with two same-named files inside itself
  // is not a fork: office-viz ships office-viz-themes/darken-theme/theme-values.js and
  // office-viz-themes/minecraft/theme-values.js, which is the theme system working as designed —
  // they travel together, differ on purpose, and there is nothing to unify. Without the cross-skill
  // requirement that pair was reported anyway, and the sentence rendered with an empty list
  // ("shares a basename with a DIFFERENT file of the same name in  — these are forks").
  for (const [base, list] of byBasename) {
    if (new Set(list.map((x) => x.skill)).size < 2) continue;
    const hashes = new Set(list.map((x) => x.hash));
    if (hashes.size < 2) continue;
    for (const item of list) {
      if (!targets.some((t) => t.skill === item.skill)) continue;
      // Only skills holding a DIFFERENT hash belong in the sentence, because that is what the
      // sentence claims. Listing every other holder made the finding assert a difference that did
      // not exist: sk-image-generator and sk-nanobanana-generator ship
      // BYTE-IDENTICAL copies of generate.py and scope.py (they are one engine ported to two agent
      // CLIs, differing only in SKILL.md), and each was told its file "shares a basename with a
      // DIFFERENT file of the same name in ... sk-nanobanana-generator" purely because a
      // third skill, sk-flow-automator, has a real fork of the name. The remediation then
      // sent a reader to reconcile two files that are already equal.
      const others = [...new Set(
        list.filter((x) => x.skill !== item.skill && x.hash !== item.hash).map((x) => x.skill)
      )];
      if (!others.length) continue;
      add(
        item.skill, 'duplicate-basename', 'notice',
        `${item.rel} shares a basename with a DIFFERENT file of the same name in `
        + `${others.join(', ')} — these are forks, not one module`,
        `compare them (\`sidekicks skill show <skill>\`); declare a shared payload or record why `
        + `the fork is intentional`
      );
    }
  }

  const unsuppressed = findings.filter((f) => !f.suppressed);
  return {
    findings,
    skills: states,
    counts: {
      skills: all.length,
      audited: states.length,
      manifests: states.filter((s) => s.manifest_present).length,
      required: states.filter((s) => s.manifest_required).length,
      findings: findings.length,
      errors: unsuppressed.filter((f) => f.severity === 'error').length,
      notices: unsuppressed.filter((f) => f.severity === 'notice').length,
      suppressed: findings.length - unsuppressed.length,
    },
  };
}

/**
 * Every check for one skill. Returns the rendered state; pushes findings through `add`.
 *
 * @returns {object}
 */
function auditOne(
  repoRoot, entry, scan, descriptor, read, derived, required, because, add, entryByName
) {
  const skill = entry.skill;
  const m = read.manifest;

  // ── 1. does it have the manifest it needs? ────────────────────────────────────
  if (required && !read.present) {
    add(
      skill, 'manifest-missing', 'notice',
      `needs a ${MANIFEST_NAME} (${because.join('; ')}) but has none`,
      `sidekicks skill manifest ${skill} --apply`
    );
  }
  if (!required && read.present) {
    // Not a problem — a skill may declare pre-emptively — but worth surfacing so an empty
    // ceremonial manifest does not quietly accumulate.
    add(
      skill, 'manifest-unneeded', 'notice',
      `carries a ${MANIFEST_NAME} but the scanner finds no dependency to declare`,
      `delete it, or leave it if a dependency is about to land`
    );
  }
  for (const err of read.errors) {
    add(skill, 'manifest-invalid', 'error', err, `fix ${read.relPath}`);
  }
  // The generator writes the structure and marks what only a human can supply. A placeholder that
  // silently satisfied the schema would launder an unanswered question into a passing gate, so the
  // residue is reported until someone writes the sentence.
  for (const todo of read.todos || []) {
    add(
      skill, 'manifest-todo', 'notice', todo,
      `edit ${read.relPath} and replace the placeholder with what actually happens`
    );
  }

  // ── 2. DERIVED sections must equal skill.yaml ─────────────────────────────────
  for (const line of derivedDrift(m, derived)) {
    add(
      skill, 'derived-drift', 'error', line,
      `sidekicks skill manifest ${skill} --apply (these sections are derived from skill.yaml, `
      + 'never hand-authored)'
    );
  }

  // ── 3. hard portability breaks — wrong in every reading of the layout ─────────
  for (const hit of scan.relativeCrossSkill) {
    add(
      skill, 'relative-cross-skill-import', 'error',
      `${hit.evidence.file}:${hit.evidence.line} reaches another skill by relative path `
      + `('${hit.target}'), which breaks the moment either folder moves`,
      'resolve the repo root by walking up for .sidekicks/ and declare the edge in '
      + `requires.sibling_skills`
    );
  }
  for (const hit of scan.requirementsEscapes) {
    add(
      skill, 'requirements-escapes-skill', 'error',
      `${hit.evidence.file}:${hit.evidence.line} is '-r ${hit.target}' — the dependency manifest `
      + 'itself escapes the skill folder, so it breaks when the folder is copied alone',
      'inline the pinned packages into this skill\'s own requirements.txt'
    );
  }

  // ── 4. undeclared edges the scanner can see ──────────────────────────────────
  const decl = m ? m.requires : null;
  // A finding recorded under `not_required:` is ANSWERED, not open: a human read the evidence and
  // wrote down why it is not a dependency. It stops being reported for the same reason a declared one
  // does — the question has been settled — and the schema refuses a rejection with no `why:`, so this
  // cannot become a silent way to quiet the gate.
  const no = m ? m.not_required : null;
  const declaredPy = new Set(decl ? decl.python.map((p) => p.import) : []);
  const declaredNode = new Set(decl ? decl.node.map((p) => p.package) : []);
  const declaredBin = new Set([
    ...(decl ? decl.binaries.map((b) => b.name) : []),
    ...(no ? no.binaries.map((b) => b.name) : []),
  ]);
  const declaredSkills = new Set([
    ...(decl ? decl.sibling_skills.map((s) => s.skill) : []),
    ...(no ? no.sibling_skills.map((s) => s.skill) : []),
  ]);
  const declaredFramework = new Set(decl
    ? [
      ...decl.framework_hooks.map((h) => h.script),
      ...decl.framework_files.map((f) => f.path),
      ...(no ? no.framework_files.map((f) => f.path) : []),
    ]
    : (no ? no.framework_files.map((f) => f.path) : []));

  for (const p of scan.python) {
    if (declaredPy.has(p.module)) continue;
    add(
      skill, 'undeclared-python', 'notice',
      `${p.evidence.file}:${p.evidence.line} imports '${p.module}' (pip: ${p.package}), `
      + 'which no manifest entry declares',
      `add it under requires.python, or run 'sidekicks skill manifest ${skill} --apply'`
    );
  }
  for (const n of scan.node) {
    if (declaredNode.has(n.package)) continue;
    add(
      skill, 'undeclared-node', 'notice',
      `${n.evidence.file}:${n.evidence.line} imports npm package '${n.package}', `
      + 'which no manifest entry declares',
      `add it under requires.node`
    );
  }
  for (const b of scan.binaries) {
    if (declaredBin.has(b.name)) continue;
    // A `prose` binary is an inline code span spelled as an invocation ("gh pr create --base …").
    // It is never auto-written, so it gets its own check id and names BOTH answers: some are real
    // dependencies whose only spelling is prose (sk-git-ship's forge CLIs), and some are the
    // opposite — a prohibition or an absence statement naming the tool it forbids.
    if (b.confidence === 'prose') {
      add(
        skill, 'binary-named-in-prose', 'notice',
        `${b.evidence.file}:${b.evidence.line} names '${b.name}' as a command in prose, not in a `
        + 'fenced block or a script',
        'if the skill runs it, add it under requires.binaries with an install_hint; if the mention is '
        + 'a prohibition, an absence statement or an example, record it under not_required.binaries '
        + 'with the reason'
      );
      continue;
    }
    add(
      skill, 'undeclared-binary', 'notice',
      `${b.evidence.file}:${b.evidence.line} invokes '${b.name}', which no manifest entry declares`,
      `add it under requires.binaries with an install_hint (it can never be auto-installed)`
    );
  }
  for (const s of scan.skills) {
    // A prose-only mention is not a dependency claim — "see also X" in SKILL.md must not become a
    // finding, or the report drowns and stops being read.
    if (s.confidence === 'prose') continue;
    if (declaredSkills.has(s.skill)) continue;

    // A name that survives only inside a comment is usually stale provenance ("Adapted from
    // <other>/scripts/scope.py"), not an edge — so it gets its own check with a remediation that
    // offers both answers, and the generator never writes it into a manifest. Occasionally it IS
    // real (an invocation described only in a docstring), which is why it is reported rather than
    // dropped: the same call inherit.mjs makes.
    // The scanner found a borrowed module but cannot say whose: several skills ship a module of that
    // name and this file names none of them. A human has to pick, so nothing is written and the
    // candidates are listed.
    if (s.confidence === 'ambiguous') {
      // If ANY candidate owner is already declared, the human has answered: the module comes from
      // the skill they declared. Keeping the report open would demand an answer that is already in
      // the file — and would demand it once per losing candidate.
      const candidates = s.candidates || [s.skill];
      if (candidates.some((c) => declaredSkills.has(c))) continue;
      add(
        skill, 'borrowed-module-ambiguous', 'notice',
        `${s.evidence.file}:${s.evidence.line} imports ${s.form.replace('module:', '')}, which `
        + `'${s.skill}' also provides — the owner is ambiguous`,
        'declare the ONE skill this module actually comes from under requires.sibling_skills '
        + '(how: import), or rename the local module so the origin is unambiguous'
      );
      continue;
    }

    if (s.confidence === 'code-comment') {
      add(
        skill, 'skill-named-in-comment', 'notice',
        `${s.evidence.file}:${s.evidence.line} names '${s.skill}' without invoking it — in a `
        + 'comment, a data file, a sentence inside a string literal, or a code fragment that is not '
        + 'a whole literal (a glob, a path prefix)',
        'declare it under requires.sibling_skills if the edge is real, or delete the stale mention — '
        + 'neither a provenance note nor prose held in a string is a dependency, and one of these is '
        + 'often a PROHIBITION ("NEVER runs sk-get-things-done inline")'
      );
      continue;
    }

    add(
      skill, 'undeclared-skill', 'notice',
      `${s.evidence.file}:${s.evidence.line} reaches '${s.skill}' (${s.how}, ${s.confidence}, `
      + `by ${s.form}${s.testOnly ? ', tests only' : ''}), which no manifest entry declares`,
      `add it under requires.sibling_skills with how: ${s.how}`
      + `${s.testOnly ? ' and scope: test' : ''} and a degraded: sentence`
    );
  }
  for (const f of scan.frameworkFiles) {
    if (declaredFramework.has(f.path)) continue;
    add(
      skill, 'undeclared-framework-file', 'notice',
      `${f.evidence.file}:${f.evidence.line} reads repo-root '${f.path}', which no manifest entry `
      + 'declares — it does not travel with the skill',
      'declare it under requires.framework_files (or requires.framework_hooks if it is a wired hook '
      + 'body), or move it into the skill folder if this skill is the only thing that runs it'
    );
  }

  // ── 5. declared but not there / not used ─────────────────────────────────────
  if (decl) {
    for (const s of decl.sibling_skills) {
      const sibling = entryByName.get(s.skill);
      const dir = sibling ? sibling.dir : join(repoRoot, entry.tree, s.skill);
      if (!sibling || !existsSync(dir)) {
        // An OPTIONAL sibling's absence is expected, not broken. The manifest has to carry a
        // `degraded:` sentence describing a skill that still works without it (schema.mjs
        // requireDegraded), so the honest grade is a notice — the skill's integrity is intact.
        //
        // Without this, a correctly trimmed distribution failed a hard gate for a dependency it does
        // not need: sk-commander calls sk-jira-footprint best-effort and ignores its
        // exit code, yet a five-skill core shipping commander without it failed `skill verify`.
        // The alternatives were worse — bundling a skill nobody uses, or deleting a real edge.
        add(
          skill,
          s.optional ? 'declared-optional-absent' : 'declared-but-absent',
          s.optional ? 'notice' : 'error',
          s.optional
            ? `declares OPTIONAL sibling '${s.skill}', which is not present — running degraded: ${s.degraded || '(no degraded note)'}`
            : `declares sibling '${s.skill}', which is not present`,
          s.optional
            ? `nothing to do unless you want the full behaviour — install '${s.skill}' to get it`
            : `restore the sibling skill, or drop the declaration if the edge is gone`
        );
        continue;
      }
      if (s.entry && !existsSync(join(dir, ...s.entry.split('/')))) {
        add(
          skill, 'declared-but-absent', 'error',
          `declares '${s.skill}' entry '${s.entry}', which does not exist in that skill`,
          `update the entry path — the borrowed surface moved`
        );
      }
    }
    for (const h of decl.framework_hooks) {
      if (!existsSync(join(repoRoot, ...h.script.split('/')))) {
        add(
          skill, 'declared-but-absent', 'error',
          `declares hook body '${h.script}', which does not exist`,
          `restore it from the framework, or fix the path`
        );
      }
    }
    // A rule body is the opposite of a hook body: it lives INSIDE the skill folder and must travel
    // with it. A declared criterion whose body is missing is a skill that exports an id nobody can
    // read the meaning of — the whole reason the settings half is recorded in the manifest.
    for (const r of decl.framework_rules || []) {
      if (!r.body) continue;   // an id with no body is legal: the body may live in AGENTS.md
      if (!existsSync(join(entry.dir, ...r.body.split('/')))) {
        add(
          skill, 'declared-but-absent', 'error',
          `declares '${r.id}' with body '${r.body}', which does not exist in this skill`,
          "restore it with 'sidekicks skill heal <skill> --restore', or fix the path in skill.yaml"
        );
      }
    }
    // Any tier counts as a sighting, `prose` included, and the frontmatter counts too. This check
    // exists to catch a declaration with NO basis anywhere — invented, or left behind by a deleted
    // call. Requiring a non-prose sighting instead would force `how: prose` onto every composition
    // the SKILL.md states in words, which is most of them: an agent told to "invoke
    // sk-implementation-planner via the Skill tool" performs a real handoff, and there is no
    // spelling of that a code scan can see. Recording it as `prose` to satisfy this check would put
    // a false classification in the manifest to keep a heuristic quiet.
    const seenSkills = new Set([
      ...scan.skills.map((s) => s.skill),
      ...readFrontmatterDependsOn(entry),
    ]);
    for (const s of decl.sibling_skills) {
      if (seenSkills.has(s.skill)) continue;
      add(
        skill, 'declared-but-unused', 'notice',
        `declares sibling '${s.skill}' but nothing in this skill — code, prose, or frontmatter `
        + 'depends-on — mentions it',
        'drop the declaration, or add the call site it is meant to describe'
      );
    }
    // A stdlib module declared as a pip package. An ERROR rather than a notice, because unlike the
    // undeclared-* backlog this is not an incomplete declaration but a WRONG one, and P3's
    // `heal --apply` reads exactly this list to decide what to install into the shared repo-root
    // .venv. `from __future__ import annotations` is a compiler directive; `pip install __future__`
    // resolves to whatever happens to hold that name on the index, which is a supply-chain answer to
    // a question that should never have been asked. The detector already filters these out
    // (scan.mjs PY_STDLIB, and the note there says why `__future__` had to be appended by hand) —
    // this check covers the other direction: a row an older scanner wrote, or a hand edit.
    for (const p of decl.python) {
      const name = p.package || p.import;
      if (!PY_STDLIB.has(name)) continue;
      add(
        skill, 'stdlib-declared-as-package', 'error',
        `declares '${name}' under requires.python, but it is part of the Python standard library `
        + 'and has no pip package',
        'delete the row — nothing needs installing for a stdlib import'
      );
    }

    // Same hazard from the other end of the name space: a NAMESPACE root is a shared import prefix,
    // not a distributable. `pip install google` installs an unrelated abandoned stub, so a row
    // declaring the bare root sends `heal --apply` to the index for a package that cannot satisfy
    // the import — and it succeeds, which is what makes it worse than failing.
    for (const p of decl.python) {
      const name = p.package || p.import;
      if (!PY_NAMESPACE_ROOTS.has(name)) continue;
      add(
        skill, 'namespace-declared-as-package', 'error',
        `declares '${name}' under requires.python, but it is a namespace prefix rather than a `
        + 'package — installing it would not satisfy the import',
        `name the member instead (e.g. '${name}.genai' -> package '${name}-genai'), matching the `
        + 'import the code actually performs'
      );
    }
  }

  // ── 5b. the settings-vs-configuration split: what has not been declared YET ──
  //
  // NOTICES, not errors, and deliberately so: both detectors are heuristics over prose and source,
  // and a heuristic that fails CI across every skill is a gate nobody can pass. They drive the
  // backfill; the structural half of the contract is hard elsewhere (`entry-unlisted`,
  // `defaults-missing`, `declared-but-absent`). See docs/guide/settings-vs-configuration.md.
  //
  // Both run on EVERY ACTIVE skill, declared or not. The earlier form skipped a skill the moment it
  // declared anything at all, which meant one block silenced every other literal in its scripts and
  // one criterion silenced every other policy in its SKILL.md — a false all-clear, and the one
  // outcome a backfill sweep must not produce. Coverage is now per-item: a tunable is answered for
  // by a defaults key of the same name, a policy by no longer being in SKILL.md, and either by a
  // recorded `settings_split:` exemption that states why it is not declarable.
  //
  // The OFFLOADED tree stands outside both. A retired skill is archived, not loaded: it has no
  // running behaviour to configure and no policy anyone can act on, so asking it to declare is
  // backfill with no user — and it is the half of the registry nobody would ever drain, which is
  // how a notice list becomes wallpaper. Its rule fragments stay addressable either way, because
  // registry.mjs scans the tree regardless; only these two discovery detectors stand down.
  if (!entry.offloaded) {
    const tunables = hardcodedTunables(entry, scan.files || [], descriptor);
    if (tunables.length) {
      add(
        skill, 'hardcoded-default', 'notice',
        `${tunables.length} tunable literal(s) an operator cannot override: `
        + tunables.map((t) => `${t.file}:${t.line} ${t.name} = ${t.value}`).join('; '),
        "declare the key in the skill's config.defaults.yaml (with a `config:` block in skill.yaml), "
        + "read it with 'sidekicks config get <block> --json', then run 'sidekicks config sync' — or "
        + 'record why it is not a knob under settings_split.tunable_exempt'
      );
    }
    const policies = policyProse(entry, descriptor);
    if (policies.length) {
      add(
        skill, 'undeclared-criterion', 'notice',
        `${policies.length} policy statement(s) in SKILL.md that no criterion id covers: `
        + policies.map((p) => `SKILL.md:${p.line} "${p.text}"`).join('; '),
        'declare a criterion in skill.yaml with its body in rules/<id>.md, leave a one-line '
        + "reference in SKILL.md, then run 'sidekicks framework sync' — a policy nobody can list "
        + 'is a policy nobody can review or switch off. If it is a hard stop, a framework-owned rule '
        + 'or a required output shape, record that under settings_split.policy_exempt'
      );
    }
  }

  // ── 6. the frontmatter mirror must not drift ─────────────────────────────────
  const fmDeps = readFrontmatterDependsOn(entry);
  if (decl) {
    const declared = new Set(decl.sibling_skills.map((s) => s.skill));
    for (const d of fmDeps) {
      if (!declared.has(d)) {
        add(
          skill, 'depends-on-divergence', 'error',
          `SKILL.md frontmatter depends-on names '${d}' but requires.sibling_skills does not`,
          `add it to requires.sibling_skills (skill.manifest.yaml is the authority; frontmatter `
          + `is the agent-readable mirror)`
        );
      }
    }
  }

  // ── 7. the hash baseline must match disk ─────────────────────────────────────
  let bundleState = 'none';
  if (m && Object.keys(m.bundle).length) {
    const onDisk = new Map(
      scan.files.filter((f) => f.rel !== MANIFEST_NAME).map((f) => [f.rel, f.abs])
    );
    let stale = 0;
    for (const [rel, recorded] of Object.entries(m.bundle)) {
      const abs = onDisk.get(rel);
      if (!abs) {
        stale++;
        add(
          skill, 'bundle-stale', 'error',
          `bundle records '${rel}', which is not present`,
          `sidekicks skill heal ${skill} --apply (or re-record with 'skill manifest --apply' if the `
          + `file was deliberately removed)`
        );
        continue;
      }
      if (hashFile(abs) !== recorded) {
        stale++;
        add(
          skill, 'bundle-stale', 'error',
          `bundle hash for '${rel}' does not match the file on disk`,
          `sidekicks skill manifest ${skill} --apply if the change is intended, or `
          + `'sidekicks skill heal ${skill} --apply' to restore the recorded content`
        );
      }
    }
    for (const rel of onDisk.keys()) {
      if (!(rel in m.bundle)) {
        stale++;
        add(
          skill, 'bundle-stale', 'notice',
          `'${rel}' is not in the bundle baseline`,
          `sidekicks skill manifest ${skill} --apply`
        );
      }
    }
    bundleState = stale ? 'stale' : 'clean';
  }

  return {
    skill,
    tree: entry.tree,
    offloaded: entry.offloaded,
    manifest_required: required,
    manifest_present: read.present,
    manifest_required_because: because,
    descriptor: Boolean(descriptor),
    bundle: bundleState,
    detected: {
      python: scan.python.length,
      node: scan.node.length,
      binaries: scan.binaries.length,
      skills: scan.skills.filter((s) => s.confidence !== 'prose').length,
      framework_files: scan.frameworkFiles.length,
      files: scan.files.length,
    },
    scan,
  };
}
