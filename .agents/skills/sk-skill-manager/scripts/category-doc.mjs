#!/usr/bin/env node
// category-doc.mjs — keep docs/skill-modular-category.md's MECHANICAL parts true.
//
// Usage:
//   node .agents/skills/sk-skill-manager/scripts/category-doc.mjs --check
//   node .agents/skills/sk-skill-manager/scripts/category-doc.mjs --apply
//
// Exit 0 = current (or applied). Exit 2 = drift under --check. Exit 1 = usage/IO.
//
// WHAT IT REGENERATES, AND WHAT IT DELIBERATELY WILL NOT.
//
// Regenerated — pure inventory, derivable and therefore checkable:
//   - the header counts (distinct grouped members, first-party, the directory total)
//   - §1's plain bullet list (Category 1 = the core + skill-improvement groups + the auditor)
//   - §3's plain bullet list (external = active, ungrouped, minus the documented exception)
//   - the Appendix's plain bullet list (whatever is under .sidekicks/skill-offloaded/)
//
// NOT regenerated, and this is a decision rather than a gap:
//   - §2's family lists. Its bullets carry hand-written annotations ("— needs sk-bmad") that
//     no scan produces, and a generator that rewrote §2 would delete them. The membership itself is
//     already gated by tests/skills/skill-modular-category.test.mjs, which is the useful half.
//   - §4's modularity audit. Its "N networked / M standalone" verdicts are human judgement, and the
//     doc's own header records a machine pass that got a family verdict WRONG until a person
//     noticed shared sprint-status.yaml state. Generating that would launder judgement into a gate.
//
// No fences are inserted. The three regenerated lists are unambiguous bullet blocks under known
// headings, so they are rewritten in place — which also means every comment, note and annotation
// elsewhere in the file survives byte-for-byte.
//
// Zero dependencies — node:* only. Resolves the repo root by walking up for .sidekicks/, never with
// `git rev-parse` (a service's own code repo would answer with the wrong root).

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DOC_REL = join('docs', 'skill-modular-category.md');
const GROUPS_REL = join(
  '.agents', 'skills', 'sk-skill-auditor', 'assets', 'audit-groups.yaml'
);
/** Category 1 = these groups plus the auditor, which is ungrouped by design. */
const CATEGORY_ONE_GROUPS = Object.freeze(['core', 'skill-improvement']);
const UNGROUPED_BY_DESIGN = Object.freeze(['sk-skill-auditor']);

function repoRoot() {
  let cur = process.cwd();
  for (;;) {
    if (existsSync(join(cur, '.sidekicks'))) return cur;
    const up = dirname(cur);
    if (up === cur) {
      process.stderr.write('category-doc: not inside a Sidekicks repo — no .sidekicks/ in any ancestor\n');
      process.exit(1);
    }
    cur = up;
  }
}

// The two trees no longer share a parent: the active one is `.agents/skills`, the parked one is
// still `.sidekicks/skill-offloaded`. `tree` is therefore a full relative path, not a basename —
// re-joining a basename onto `.sidekicks/` read an empty directory and reported every skill as
// missing rather than failing outright.
function skillDirs(root, tree) {
  const base = join(root, ...tree.split('/'));
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const dir = join(base, e.name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    if (!existsSync(join(dir, 'SKILL.md'))) continue;   // a skill is defined by having one
    out.push(e.name);
  }
  return out.sort();
}

/** group -> [members], skipping the reserved `single` rotating cursor. */
function groups(root) {
  const byGroup = new Map();
  const text = readFileSync(join(root, GROUPS_REL), 'utf8');
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s+-\s+(\S+)/);
    if (item) { if (current) byGroup.get(current).push(item[1]); continue; }
    const header = line.match(/^\s+([a-z][a-z0-9-]*):\s*$/);
    if (header) {
      current = header[1];
      if (!byGroup.has(current)) byGroup.set(current, []);
      continue;
    }
    if (/^\S/.test(line)) current = null;
  }
  byGroup.delete('single');
  return byGroup;
}

/** Replace the bullet block that follows `heading`, leaving everything else untouched. */
function replaceList(lines, heading, names) {
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start === -1) return { lines, changed: false, found: false };

  // The block runs from the first bullet after the heading to the last consecutive bullet. Blockquote
  // notes and blank lines before it are preserved by starting at the first `- ` line.
  let first = -1;
  let last = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i])) break;
    if (/^-\s+\S/.test(lines[i])) { if (first === -1) first = i; last = i; continue; }
    if (first !== -1 && lines[i].trim() === '') continue;      // blank lines inside a list are fine
    if (first !== -1 && !/^-\s/.test(lines[i])) break;         // prose after the list ends it
  }
  if (first === -1) return { lines, changed: false, found: true };

  const replacement = names.map((n) => `- ${n}`);
  const before = lines.slice(0, first);
  const after = lines.slice(last + 1);
  const next = [...before, ...replacement, ...after];
  const changed = JSON.stringify(lines.slice(first, last + 1)) !== JSON.stringify(replacement);
  return { lines: next, changed, found: true };
}

/** Rewrite one `key: <n>`-shaped count inside the header, matched by its surrounding prose. */
function replaceCount(text, pattern, value) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let changed = false;
  const next = text.replace(re, (m, pre, _old, post) => {
    const rebuilt = `${pre}${value}${post}`;
    if (rebuilt !== m) changed = true;
    return rebuilt;
  });
  return { text: next, changed };
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const check = args.includes('--check') || !apply;
  if (apply && args.includes('--check')) {
    process.stderr.write('category-doc: --check and --apply are mutually exclusive\n');
    process.exit(1);
  }

  const root = repoRoot();
  const docPath = join(root, DOC_REL);
  if (!existsSync(docPath)) {
    process.stderr.write(`category-doc: ${DOC_REL} not found\n`);
    process.exit(1);
  }

  const active = skillDirs(root, '.agents/skills');
  const offloaded = skillDirs(root, '.sidekicks/skill-offloaded');
  const byGroup = groups(root);
  const grouped = new Set([...byGroup.values()].flat());

  const categoryOne = [
    ...new Set([
      ...CATEGORY_ONE_GROUPS.flatMap((g) => byGroup.get(g) || []),
      ...UNGROUPED_BY_DESIGN,
    ]),
  ].filter((s) => active.includes(s));

  const external = active.filter((s) => !grouped.has(s) && !UNGROUPED_BY_DESIGN.includes(s));
  const firstParty = grouped.size + UNGROUPED_BY_DESIGN.length;

  let text = readFileSync(docPath, 'utf8');
  const original = text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const drift = [];   // things this script will fix
  const notes = [];   // things only a human should decide — reported, never applied

  // §1 is ADDITIVE-ONLY, and that is the most important decision in this script.
  //
  // Its ordering is editorial (grouped by kind, not alphabetical), and more importantly §1 is what
  // `sk-inherit`'s `framework` preset is documented to forge. A member that the group rule
  // does not derive is therefore a QUESTION — today `sk-packager` sits in the `ops` group yet
  // appears here — and answering it by deleting the line would silently change what a runtime is
  // built from, resolving a taxonomy disagreement nobody asked this script to settle.
  //
  // So: a derived-but-unlisted skill is appended (a new Category-1 skill genuinely belongs), and a
  // listed-but-not-derived skill is REPORTED for a human and left exactly where it is.
  const existingOne = (() => {
    const l = text.split(/\r?\n/);
    const s = l.findIndex((x) => x.startsWith('## 1. Sidekicks framework skills'));
    const out = [];
    for (let i = s + 1; i < l.length && !/^#{2,3}\s/.test(l[i]); i++) {
      const m = l[i].match(/^-\s+(\S+)\s*$/);
      if (m) out.push(m[1]);
    }
    return out;
  })();
  const missingFromOne = categoryOne.filter((n) => !existingOne.includes(n));
  const extraInOne = existingOne.filter((n) => !categoryOne.includes(n));
  const oneOrdered = [...existingOne, ...missingFromOne];
  if (missingFromOne.length) {
    drift.push(`§1 is missing ${missingFromOne.length} derived Category-1 skill(s): ${missingFromOne.join(', ')}`);
  }
  for (const n of extraInOne) {
    notes.push(
      `§1 lists '${n}', which the classification rule does not derive (it is in the `
      + `'${[...byGroup.entries()].find(([, m]) => m.includes(n))?.[0] || 'no'}' group). LEFT AS IS — `
      + '§1 is what inherit\'s framework preset forges, so removing a line changes what a runtime '
      + 'is built from. That is a taxonomy decision for a human.'
    );
  }

  let lines = text.split(/\r?\n/);
  for (const [heading, names, label] of [
    ['## 1. Sidekicks framework skills', oneOrdered, '§1'],
    ['## 3. External skills', external, '§3'],
    ['## Appendix — offloaded', offloaded, 'Appendix'],
  ]) {
    const r = replaceList(lines, heading, names);
    if (!r.found) { drift.push(`${label}: heading not found — the doc was restructured`); continue; }
    if (r.changed && !drift.some((d) => d.startsWith(label))) drift.push(`${label} list is stale`);
    lines = r.lines;
  }
  text = lines.join(eol);

  for (const [pattern, value, label] of [
    [/(\(\s*)(\d+)( distinct)/, String(grouped.size), 'distinct grouped members'],
    [/(design\) = \*\*)(\d+)(\*\*)/, String(firstParty), 'first-party total'],
    [/(= )(\d+)(, matching the)/, String(active.length), 'directory total'],
    [/(offloaded \(archived, not active\) \()(\d+)(\))/, String(offloaded.length), 'offloaded count'],
  ]) {
    const r = replaceCount(text, pattern, value);
    if (r.changed) drift.push(`${label} was stale (now ${value})`);
    text = r.text;
  }

  const writeNotes = (out) => {
    if (!notes.length) return;
    out(`  ${notes.length} thing(s) needing a human, not a rewrite:\n`);
    for (const n of notes) out(`    - ${n}\n`);
  };

  if (!drift.length) {
    // Notes alone do NOT fail the check. They are open questions about the taxonomy, and a gate that
    // went red on one would be a gate nobody can turn green without making the decision under
    // pressure — which is how a judgement gets rubber-stamped.
    process.stdout.write('category-doc: OK (the mechanical sections are current)\n');
    writeNotes((s) => process.stdout.write(s));
    process.exit(0);
  }

  if (check) {
    process.stderr.write(`category-doc --check: ${drift.length} drift(s)\n`);
    for (const d of drift) process.stderr.write(`  ${d}\n`);
    writeNotes((s) => process.stderr.write(s));
    process.stderr.write("  fix with '--apply' (§2 and §4 are hand-authored and never touched)\n");
    process.exit(2);
  }

  if (text === original) {
    process.stdout.write('category-doc: nothing to write\n');
    writeNotes((s) => process.stdout.write(s));
    process.exit(0);
  }
  writeFileSync(docPath, text, 'utf8');
  process.stdout.write(`category-doc --apply: updated ${DOC_REL}\n`);
  for (const d of drift) process.stdout.write(`  ${d}\n`);
  writeNotes((s) => process.stdout.write(s));
  process.stdout.write('  §2 (family lists, hand-annotated) and §4 (judgement) untouched.\n');
  process.exit(0);
}

main();
