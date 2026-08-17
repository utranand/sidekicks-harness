// lib/skill-manifest/materialize.mjs
// Build a skill's manifest from what the scanner found, and render it.
//
// THE ONE RULE THIS MODULE OBEYS, taken from lib/framework-settings/materialize.mjs:84-88:
// materialisation NEVER RE-DECIDES A RECORDED CHOICE. An entry already in the file is left exactly
// as it stands — its `why`, its `optional`, its `how`, its `degraded` sentence, its comments. Only
// entries the file LACKS are added, and only the DERIVED sections (config, framework_hooks, bundle)
// are regenerated, because those have another authority.
//
// WHY DRIFT IS PURE AND WRITING IS SEPARATE. `manifestPlan()` computes; `renderManifest()` /
// `applyManifest()` write. That split is what gives `--check` a read-only twin that cannot
// accidentally mutate, and it is what lets the test assert the plan without touching a filesystem.
//
// WHY GENERATED ROWS CARRY TODO. Three fields cannot be derived from code: whether an import sits on
// a lazy path (`optional`), how a binary is obtained (`install_hint`), and what actually breaks when
// a sibling is missing (`degraded`). Inventing plausible text for those would launder an unanswered
// question into a passing gate, so the generator writes the structure and marks the residue. See
// TODO_MARKER in schema.mjs.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { hashFile } from './hash.mjs';
import { MANIFEST_NAME, MANIFEST_SCHEMA, TODO_MARKER } from './schema.mjs';

export { MANIFEST_NAME };

/** Quote a scalar only when YAML would otherwise misread it. */
function scalar(v) {
  const s = String(v);
  if (s === '') return "''";
  if (/^[A-Za-z0-9][A-Za-z0-9 ._/@+=-]*$/.test(s) && !/:\s/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * What the manifest SHOULD contain, and what is missing from the one on disk.
 *
 * @param {object} scan - lib/skill-lifecycle/scan.mjs scanSkill() result
 * @param {object|null} existing - the parsed manifest, or null
 * @param {{config: object|null, framework_hooks: object[]}} derived
 * @returns {{
 *   skill: string,
 *   add: {python: object[], node: object[], binaries: object[], sibling_skills: object[]},
 *   derived: object,
 *   bundle: Record<string,string>,
 *   bundleChanged: boolean,
 *   changed: boolean,
 * }}
 */
/**
 * The one-line trailing comment that tells a reviewer WHERE a sibling edge came from — a scanner hit
 * with a file:line, or the author's own frontmatter declaration, which has no line to point at.
 */
function siblingProvenance(s) {
  return s.evidence
    ? `${s.confidence}, seen at ${s.evidence.file}:${s.evidence.line}`
    : 'declared in SKILL.md frontmatter sidekicks.depends-on — no call site found by the scanner';
}

export function manifestPlan(scan, existing, derived, frontmatterDeps = []) {
  const have = existing ? existing.requires : null;
  // A REJECTED finding counts as known, so it is never re-added. Without this, deleting a false
  // positive from `requires:` was pointless — the next `--apply` put it straight back, because this
  // function only refuses to re-decide a choice it can SEE. `not_required:` is that record.
  const no = existing ? existing.not_required : null;
  const known = {
    python: new Set(have ? have.python.map((p) => p.import) : []),
    node: new Set(have ? have.node.map((p) => p.package) : []),
    binaries: new Set([
      ...(have ? have.binaries.map((b) => b.name) : []),
      ...(no ? no.binaries.map((b) => b.name) : []),
    ]),
    sibling_skills: new Set([
      ...(have ? have.sibling_skills.map((s) => s.skill) : []),
      ...(no ? no.sibling_skills.map((s) => s.skill) : []),
    ]),
    // A path may already be declared as a hook body; it must not then be added again as a plain
    // framework file. The DERIVED hooks count too, not just the ones already written: on a FIRST
    // generate there is no existing manifest, so a hook body named in SKILL.md would land in
    // `framework_files` and then be listed a second time by the derived section —
    // sk-validation-gate's scripts/recompile-validation-checklist.mjs did exactly that.
    framework: new Set([
      ...(have ? have.framework_files.map((f) => f.path) : []),
      ...(have ? have.framework_hooks.map((h) => h.script) : []),
      ...(no ? no.framework_files.map((f) => f.path) : []),
      ...derived.framework_hooks.map((h) => h.script),
    ]),
  };

  const add = {
    python: scan.python
      .filter((p) => !known.python.has(p.module))
      .map((p) => ({
        package: p.package,
        import: p.module,
        scope: p.testOnly ? 'test' : 'runtime',
        evidence: p.evidence,
      })),
    node: scan.node
      .filter((n) => !known.node.has(n.package))
      .map((n) => ({ package: n.package, evidence: n.evidence })),
    // Only `wired` binaries are written — a fence or a code file. A `prose` binary (an inline span
    // spelled as an invocation) is a real signal with an irreducible false-positive rate, so the
    // audit reports it and a human answers it: declare it here, or record the rejection under
    // `not_required.binaries` with the reason. Same split as the sibling tiers below.
    binaries: scan.binaries
      .filter((b) => b.confidence !== 'prose' && !known.binaries.has(b.name))
      .map((b) => ({ name: b.name, evidence: b.evidence })),
    // ONLY `wired` and `documented` are written. The other two tiers are real signals but not
    // dependency claims, and writing them would corrupt the manifest with edges nobody has:
    //   prose        — "see also X" in a SKILL.md is a cross-reference.
    //   code-comment — overwhelmingly stale provenance. sk-database-connector/scripts/scope.py
    //                  opens "Adapted from `sk-image-generator/scripts/scope.py`", which is
    //                  history, not a runtime edge; inherit.mjs records the same finding ("pushing an
    //                  unrelated skill into every runtime that copies the file").
    // Both still reach `skill doctor`, which asks a human to either declare or delete them.
    sibling_skills: scan.skills
      .filter((s) => (s.confidence === 'wired' || s.confidence === 'documented')
        && !known.sibling_skills.has(s.skill))
      .map((s) => ({
        skill: s.skill,
        how: s.how,
        scope: s.testOnly ? 'test' : 'runtime',
        evidence: s.evidence,
        confidence: s.confidence,
      }))
      // `sidekicks.depends-on` in SKILL.md frontmatter outranks anything a scan can find: the author
      // WROTE DOWN that the edge exists, and `inherit plan` already treats it as its most
      // authoritative tier. Seeding it here is what keeps the two surfaces from diverging — the
      // alternative is a `depends-on-divergence` error the generator itself cannot clear.
      // `how: prose` is the honest starting point (declared, with no path or call to classify it);
      // upgrade it by hand where the SKILL.md shows a real invocation.
      .concat(frontmatterDeps
        .filter((name) => name !== scan.skill
          && !known.sibling_skills.has(name)
          && !scan.skills.some((s) => s.skill === name
            && (s.confidence === 'wired' || s.confidence === 'documented')))
        .map((name) => ({
          skill: name, how: 'prose', scope: 'runtime', evidence: null, confidence: 'depends-on',
        })))
      .sort((a, b) => (a.skill < b.skill ? -1 : 1)),
    framework_files: (scan.frameworkFiles || [])
      .filter((f) => !known.framework.has(f.path))
      .map((f) => ({ path: f.path, evidence: f.evidence })),
  };

  // The baseline covers every file the skill owns EXCEPT the manifest itself: hashing a file into
  // itself never converges.
  const bundle = {};
  for (const f of scan.files) {
    if (f.rel === MANIFEST_NAME) continue;
    const h = hashFile(f.abs);
    if (h) bundle[f.rel] = h;
  }
  const prevBundle = existing ? existing.bundle : {};
  const bundleChanged = JSON.stringify(prevBundle) !== JSON.stringify(bundle);

  // Every DERIVED section is compared here. Adding one to the emitters without adding it to this
  // comparison is the silent failure mode: the section would be written on a fresh manifest and
  // never on an existing one, so a skill that already had a manifest would keep a stale copy while
  // `--check` reported it current.
  const derivedShape = (config, rules, hooks) => JSON.stringify({
    config: config ? { block: config.block, defaults: config.defaults } : null,
    rules: (rules || []).map((r) => ({ id: r.id, title: r.title || null, body: r.body || null })),
    hooks: hooks.map((h) => ({ id: h.id, script: h.script })),
  });

  const derivedChanged = existing
    ? derivedShape(
      existing.requires.config,
      existing.requires.framework_rules,
      existing.requires.framework_hooks
    ) !== derivedShape(derived.config, derived.framework_rules, derived.framework_hooks)
    : Boolean(derived.config)
      || (derived.framework_rules || []).length > 0
      || derived.framework_hooks.length > 0;

  const addCount = add.python.length + add.node.length + add.binaries.length + add.framework_files.length
    + add.sibling_skills.length;

  return {
    skill: scan.skill,
    add,
    derived,
    bundle,
    bundleChanged,
    derivedChanged,
    changed: !existing || addCount > 0 || bundleChanged || derivedChanged,
  };
}

/**
 * Render a complete manifest for a skill that has none.
 *
 * The comments are part of the deliverable: this file is hand-maintained after generation, and the
 * next person to edit it needs to know which sections they own and which are regenerated.
 *
 * @param {ReturnType<typeof manifestPlan>} plan
 * @param {object|null} existingDegraded - reserved for future merge use
 * @returns {string}
 */
export function renderManifest(plan, existingDegraded = null) {
  void existingDegraded;
  const L = [];
  L.push(`# ${MANIFEST_NAME} — what this skill needs in order to run.`);
  L.push('#');
  L.push('# Sections under `requires:` are AUTHORED: generated once from what the scanner found, then');
  L.push('# maintained by hand. `config:`, `framework_hooks:` and `bundle:` are DERIVED — they are');
  L.push("# regenerated by `sidekicks skill manifest <skill> --apply` and a hand edit is reported as");
  L.push('# drift. Every `TODO` below is a question only a human can answer; `sidekicks skill doctor`');
  L.push('# keeps asking until it is gone.');
  L.push('#');
  L.push('# Writing prose here: `&word` and `*word` are refused by the yaml-subset reader ANYWHERE in');
  L.push('# a line, quoting and block scalars included (lib/yaml-subset/yaml.mjs findPoison) — so');
  L.push('# spell "and", and emphasize without asterisks, or the file stops loading.');
  L.push('');
  L.push(`schema: ${MANIFEST_SCHEMA}`);
  L.push(`skill: ${plan.skill}`);

  const req = [];
  const a = plan.add;

  if (a.python.length) {
    req.push('  # Installed into the single repo-root .venv. `import:` is the name the code uses, so');
    req.push('  # verification can probe it without resolving pip metadata.');
    req.push('  python:');
    // No advisory comment about `optional:` here. The default (required) is the SAFE direction to be
    // wrong in — heal installs it — so a nudge that can never be "done" would sit in 100 files
    // forever pretending to be an open question.
    for (const p of a.python) {
      req.push(`    - package: ${scalar(p.package)}`);
      req.push(`      import: ${scalar(p.import)}`);
      if (p.scope === 'test') req.push('      scope: test');
      req.push(`      # seen at ${p.evidence.file}:${p.evidence.line}`);
    }
  }
  if (a.node.length) {
    req.push('  node:');
    for (const n of a.node) {
      req.push(`    - package: ${scalar(n.package)}`);
      req.push(`      # seen at ${n.evidence.file}:${n.evidence.line}`);
    }
  }
  if (a.binaries.length) {
    req.push('  # External commands. NEVER auto-installed — `skill heal` can only report these.');
    req.push('  binaries:');
    for (const b of a.binaries) {
      req.push(`    - name: ${scalar(b.name)}`);
      req.push(`      # seen at ${b.evidence.file}:${b.evidence.line}`);
      req.push('      # add install_hint / install_hint_windows so the report can tell someone how to get it');
    }
  }
  if (a.sibling_skills.length) {
    req.push('  # Skills this one composes on. A sibling is never copied in and never auto-installed,');
    req.push('  # so `degraded:` has to say what happens when it is absent.');
    req.push('  sibling_skills:');
    for (const s of a.sibling_skills) {
      req.push(`    - skill: ${scalar(s.skill)}`);
      req.push(`      how: ${scalar(s.how)}`);
      if (s.scope === 'test') req.push('      scope: test');
      req.push(`      degraded: ${scalar(`${TODO_MARKER}: state what breaks without this skill`)}`);
      req.push(`      # ${siblingProvenance(s)}`);
    }
  }

  if (a.framework_files.length) {
    req.push('  # Repo-root files this skill runs or reads. They do NOT travel with the skill, so');
    req.push('  # `degraded:` has to say what a lifted copy loses.');
    req.push('  framework_files:');
    for (const f of a.framework_files) {
      req.push(`    - path: ${scalar(f.path)}`);
      req.push(`      degraded: ${scalar(`${TODO_MARKER}: state what breaks without this file`)}`);
      req.push(`      # seen at ${f.evidence.file}:${f.evidence.line}`);
    }
  }

  const d = plan.derived;
  if (d.config) {
    req.push('  # DERIVED from skill.yaml — do not hand-edit.');
    req.push('  config:');
    req.push(`    block: ${scalar(d.config.block)}`);
    if (d.config.defaults) req.push(`    defaults: ${scalar(d.config.defaults)}`);
  }
  if (d.framework_rules && d.framework_rules.length) {
    req.push('  # DERIVED from skill.yaml — do not hand-edit. The rules and criteria this skill OWNS.');
    req.push('  # Unlike a hook, a rule BODY lives inside the skill folder and travels with it, so');
    req.push('  # `sidekicks skill verify` fails when a declared body is missing and `heal --restore`');
    req.push('  # puts it back. See docs/guide/settings-vs-configuration.md.');
    req.push('  framework_rules:');
    for (const r of d.framework_rules) {
      req.push(`    - id: ${scalar(r.id)}`);
      if (r.title) req.push(`      title: ${scalar(r.title)}`);
      if (r.body) req.push(`      body: ${scalar(r.body)}`);
    }
  }
  if (d.framework_hooks.length) {
    req.push('  # DERIVED from skill.yaml + the core hook registry — do not hand-edit. A hook body is');
    req.push('  # framework territory (core-registry.mjs): declared here, never bundled.');
    req.push('  framework_hooks:');
    for (const h of d.framework_hooks) {
      req.push(`    - id: ${scalar(h.id)}`);
      req.push(`      script: ${scalar(h.script)}`);
      req.push(`      degraded: ${scalar(`${TODO_MARKER}: state what happens with this hook absent`)}`);
    }
  }

  if (req.length) {
    L.push('');
    L.push('requires:');
    L.push(...req);
  }

  L.push('');
  L.push('# DERIVED hash baseline (LF-normalized sha256) — do not hand-edit.');
  L.push('bundle:');
  for (const rel of Object.keys(plan.bundle).sort()) {
    L.push(`  ${scalar(rel)}: ${plan.bundle[rel]}`);
  }
  L.push('');
  return L.join('\n');
}

// ── Line-level editing of an EXISTING manifest ────────────────────────────────────
//
// WHY LINE-LEVEL AND NOT parse-then-re-emit. The same reason lib/framework-settings/
// framework-config.mjs:12-14 gives for framework.yaml: serialising a parsed object back over the
// file deletes every comment in it — including the `# seen at …` provenance and the human's own
// notes. So an existing file is edited in place: rows are appended to their block, DERIVED blocks
// are replaced wholesale, and nothing else is touched.

/** Detect the file's line ending so a CRLF checkout round-trips unchanged. */
function eolOf(text) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

/**
 * The line span of a block, given its header indent and name.
 *
 * @returns {{header: number, end: number}|null} end is exclusive
 */
function blockSpan(lines, name, indent) {
  const head = new RegExp(`^${' '.repeat(indent)}${name}:\\s*(#.*)?$`);
  const header = lines.findIndex((l) => head.test(l));
  if (header === -1) return null;
  // Contiguous comment lines directly above the header belong to the block. Absorbing them is what
  // makes replacing a DERIVED block idempotent: without it, every --apply prepends another copy of
  // the generated "do not hand-edit" banner.
  let start = header;
  while (start > 0) {
    const prev = lines[start - 1];
    const lead = prev.length - prev.trimStart().length;
    if (prev.trimStart().startsWith('#') && lead === indent) start--;
    else break;
  }
  let end = header + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() === '') { end++; continue; }
    const lead = l.length - l.trimStart().length;
    if (lead <= indent) break;
    end++;
  }
  // Trailing blank lines belong to whatever follows, not to this block.
  while (end > header + 1 && lines[end - 1].trim() === '') end--;
  return { start, header, end };
}

/**
 * Apply a plan to an existing manifest's text, preserving comments and line endings.
 *
 * @param {string} text
 * @param {ReturnType<typeof manifestPlan>} plan
 * @returns {string}
 */
export function upsertManifest(text, plan) {
  const eol = eolOf(text);
  let lines = text.split(/\r?\n/);

  /** Make sure a top-level `requires:` block exists, and return its span. */
  const ensureRequires = () => {
    const found = blockSpan(lines, 'requires', 0);
    if (found) return found;
    // Insert before the DERIVED bundle block if there is one, so the file keeps its
    // authored-then-derived reading order.
    const bundle = blockSpan(lines, 'bundle', 0);
    const at = bundle ? bundle.start : lines.length;
    lines.splice(at, 0, 'requires:', '');
    return blockSpan(lines, 'requires', 0);
  };

  const appendRows = (section, rows) => {
    if (!rows.length) return;
    const reqSpan = ensureRequires();
    const secSpan = blockSpan(lines.slice(reqSpan.header, reqSpan.end), section, 2);
    if (secSpan) {
      lines.splice(reqSpan.header + secSpan.end, 0, ...rows);
    } else {
      lines.splice(reqSpan.end, 0, `  ${section}:`, ...rows);
    }
  };

  /** Replace a whole block (header, its absorbed comments, and its body) with `rows`. */
  const replaceBlock = (section, indent, parent, rows) => {
    const parentSpan = parent ? ensureRequires() : null;
    const from = parentSpan ? parentSpan.header : 0;
    const to = parentSpan ? parentSpan.end : lines.length;
    const span = blockSpan(lines.slice(from, to), section, indent);
    if (span) {
      lines.splice(from + span.start, span.end - span.start, ...rows);
    } else if (rows.length) {
      lines.splice(to, 0, ...rows);
    }
  };

  const a = plan.add;
  appendRows('python', a.python.flatMap((p) => [
    `    - package: ${scalar(p.package)}`,
    `      import: ${scalar(p.import)}`,
    ...(p.scope === 'test' ? ['      scope: test'] : []),
    `      # seen at ${p.evidence.file}:${p.evidence.line}`,
  ]));
  appendRows('node', a.node.flatMap((n) => [
    `    - package: ${scalar(n.package)}`,
    `      # seen at ${n.evidence.file}:${n.evidence.line}`,
  ]));
  appendRows('binaries', a.binaries.flatMap((b) => [
    `    - name: ${scalar(b.name)}`,
    `      # seen at ${b.evidence.file}:${b.evidence.line}`,
    '      # add install_hint / install_hint_windows so the report can tell someone how to get it',
  ]));
  appendRows('framework_files', a.framework_files.flatMap((f) => [
    `    - path: ${scalar(f.path)}`,
    `      degraded: ${scalar(`${TODO_MARKER}: state what breaks without this file`)}`,
    `      # seen at ${f.evidence.file}:${f.evidence.line}`,
  ]));
  appendRows('sibling_skills', a.sibling_skills.flatMap((s) => [
    `    - skill: ${scalar(s.skill)}`,
    `      how: ${scalar(s.how)}`,
    ...(s.scope === 'test' ? ['      scope: test'] : []),
    `      degraded: ${scalar(`${TODO_MARKER}: state what breaks without this skill`)}`,
    `      # ${siblingProvenance(s)}`,
  ]));

  if (plan.derivedChanged) {
    const d = plan.derived;
    replaceBlock('config', 2, 'requires', d.config
      ? [
        '  # DERIVED from skill.yaml — do not hand-edit.',
        '  config:',
        `    block: ${scalar(d.config.block)}`,
        ...(d.config.defaults ? [`    defaults: ${scalar(d.config.defaults)}`] : []),
      ]
      : []);
    replaceBlock('framework_rules', 2, 'requires', (d.framework_rules || []).length
      ? [
        '  # DERIVED from skill.yaml — do not hand-edit. The rules and criteria this skill OWNS.',
        '  framework_rules:',
        ...d.framework_rules.flatMap((r) => [
          `    - id: ${scalar(r.id)}`,
          ...(r.title ? [`      title: ${scalar(r.title)}`] : []),
          ...(r.body ? [`      body: ${scalar(r.body)}`] : []),
        ]),
      ]
      : []);
    replaceBlock('framework_hooks', 2, 'requires', d.framework_hooks.length
      ? [
        '  # DERIVED from skill.yaml + the core hook registry — do not hand-edit.',
        '  framework_hooks:',
        ...d.framework_hooks.flatMap((h) => [
          `    - id: ${scalar(h.id)}`,
          `      script: ${scalar(h.script)}`,
          `      degraded: ${scalar(`${TODO_MARKER}: state what happens with this hook absent`)}`,
        ]),
      ]
      : []);
  }

  if (plan.bundleChanged) {
    replaceBlock('bundle', 0, null, [
      '# DERIVED hash baseline (LF-normalized sha256) — do not hand-edit.',
      'bundle:',
      ...Object.keys(plan.bundle).sort().map((rel) => `  ${scalar(rel)}: ${plan.bundle[rel]}`),
    ]);
  }

  if (lines[lines.length - 1] !== '') lines.push('');
  return lines.join(eol);
}
