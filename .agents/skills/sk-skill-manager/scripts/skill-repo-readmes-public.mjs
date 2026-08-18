#!/usr/bin/env node
// skill-repo-readmes-public.mjs
//
// Regenerates the category READMEs and the top-level README of a `sidekicks-skills`-shaped
// destination repo (references/skill-repo-layout.md "Layout 1") from its own `catalog.yaml`
// (name, version, category) plus each carried skill's own SKILL.md frontmatter `description` field,
// with the family list and blurbs read from this skill's assets/categories.yaml.
//
// Rows are grouped by `category` — the PUBLICATION family — and NOT by `group`, which is the audit
// group. They agree for most skills and deliberately differ for the framework family, whose members
// audit under core/skill-improvement/ops/jira and browse as one.
// Run AFTER the real (non-dry-run) export has already written catalog.yaml and every
// .sidekicks/skills/<name>/SKILL.md into the destination — this script only reads what an export
// already produced, it never runs the export itself.
//
// catalog.yaml carries NO description field (renderCatalogRow, lib/skill-package/portable.mjs) —
// that is why this script reads two sources rather than one.
//
// This is what committed the destination's public README/categories content — it is tracked here
// so a future regeneration is still possible after the run folder that originally held it (AAP-113,
// aap-113-skill-repo-sync) is cleaned up.
//
// Writes ONLY between the generated-region markers:
//   <!-- GENERATED from catalog.yaml — do not hand-edit below this line. -->
//   <!-- END GENERATED -->
// Every categories/<family>/README.md already carries this pair (hand-authored scaffold).
// The top-level README.md does NOT yet carry one around its Categories table — this script adds
// it ONCE (wrapping the existing table + the "Ungrouped skills..." paragraph) if absent, then
// confines every subsequent write to between it, exactly like the category READMEs.
//
// A family with zero carried members KEEPS its existing "no skills published in this family yet"
// text rather than being emptied further. `core` and `skill-improvement` are the families that stay
// near-empty now that the framework family holds most of what used to be theirs.
//
// A family's README is written only if it already exists: this script fills the marked regions of a
// hand-authored scaffold, it does not scaffold one. Adding a family to categories.yaml therefore
// also means creating categories/<name>/README.md in the destination — the run reports `skip:` for
// a family whose README is absent rather than inventing one.
//
// It ALSO writes a second, separately-marked region holding the repo's prerequisites block (AAP-113
// Definition of Done point 4) into every category README and the top-level README:
//   <!-- GENERATED prerequisites — do not hand-edit below this line. -->
//   <!-- END GENERATED prerequisites -->
// The section (`## Prerequisites`, placed before `## Notes` / `## Installing`) is created once if
// absent and rewritten in place afterwards. Putting it here rather than hand-editing the READMEs is
// the point: a regeneration must not be able to silently drop the clause again.
//
// Usage:
//   node .agents/skills/sk-skill-manager/scripts/skill-repo-readmes-public.mjs --dest <path-to-destination-repo-root>
//
// Reads:
//   <dest>/catalog.yaml
//   <dest>/.sidekicks/skills/<name>/SKILL.md   (frontmatter `description:`, already exported)
// Writes:
//   <dest>/categories/<family>/README.md   (12 families)
//   <dest>/README.md
//
// Zero third-party dependencies — node:fs / node:path only. No machine-absolute path is ever
// baked in: --dest is supplied by the caller at run time.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const GEN_START = '<!-- GENERATED from catalog.yaml — do not hand-edit below this line. -->';
const GEN_END = '<!-- END GENERATED -->';

// A SECOND, independently-named generated region carrying the prerequisites block (AAP-113
// Definition of Done point 4). Deliberately distinct markers rather than reusing GEN_START/GEN_END:
// both files now hold two regions, and the readers below locate a region with indexOf, so the two
// pairs must not be substrings of one another. ('<!-- END GENERATED prerequisites -->' does not
// contain '<!-- END GENERATED -->' — the trailing word sits before the closing `-->`.)
const PRE_START = '<!-- GENERATED prerequisites — do not hand-edit below this line. -->';
const PRE_END = '<!-- END GENERATED prerequisites -->';

// The canonical family list + "what it covers" blurb now live in ONE place, this skill's own
// assets/categories.yaml, and are read from there. They used to be a fixed map here, duplicated
// again in skill-repo-readmes-private.mjs and a third time in each destination's LAYOUT.md — three
// copies of a list that has to agree, which is how the framework family could not be added to one
// of them without silently breaking the others.
//
// Read from the SKILL's assets, not the destination's: the taxonomy is a decision of the source
// repo publishing the skills, and a destination that disagreed with it would be reporting its own
// last export rather than the current answer.
const CATEGORIES_YAML = path.join(
  path.dirname(path.dirname(url.fileURLToPath(import.meta.url))), 'assets', 'categories.yaml',
);

/**
 * Parse assets/categories.yaml into an ordered [family, blurb] list.
 *
 * Narrow on purpose, exactly like readCatalog below: family at column 0 ending in ':', an indented
 * `blurb: '<one line>'`, and an optional `members:` list this script ignores (membership reaches it
 * through catalog.yaml's `category` column, already resolved by the export).
 *
 * Families are emitted in file order, with `framework` first if present — a reader looking at the
 * repo for the first time should meet the framework before the domain families.
 */
function readFamilies() {
  const text = fs.readFileSync(CATEGORIES_YAML, 'utf8').replace(/\r\n?/g, '\n');
  const families = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const header = line.match(/^([a-z][a-z0-9-]*):\s*$/);
    if (header) { current = header[1]; families.push([current, '']); continue; }
    const blurb = line.match(/^\s+blurb:\s+(.+)$/);
    if (blurb && current) families[families.length - 1][1] = unquote(blurb[1]);
  }
  if (!families.length) throw new Error(`no families found in ${CATEGORIES_YAML}`);
  const missing = families.filter(([, b]) => !b).map(([f]) => f);
  if (missing.length) {
    throw new Error(`categories.yaml family without a blurb: ${missing.join(', ')} — the READMEs have nothing to say about it`);
  }
  return [
    ...families.filter(([f]) => f === 'framework'),
    ...families.filter(([f]) => f !== 'framework').sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  ];
}

function usageError(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const opts = { dest: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dest') opts.dest = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') opts.help = true;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// catalog.yaml — narrow reader for the ONE row shape renderCatalogRow emits.
// Does not attempt to be a general YAML parser; refuses (throws) on anything that does not match
// the fixed 10-field row shape, so a drift in the generator format fails loud instead of silently
// mis-reading skills.
// ---------------------------------------------------------------------------

function unquote(v) {
  const t = v.trim();
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

function readCatalog(catalogPath) {
  const text = fs.readFileSync(catalogPath, 'utf8').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const rows = [];
  let cur = null;
  for (const raw of lines) {
    const m = raw.match(/^ {2}- name: (.+)$/);
    if (m) {
      if (cur) rows.push(cur);
      cur = { name: unquote(m[1]) };
      continue;
    }
    if (!cur) continue;
    const field = raw.match(/^ {4}([a-z_]+): (.*)$/);
    if (field) cur[field[1]] = unquote(field[2]);
  }
  if (cur) rows.push(cur);
  return rows;
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter — extract the `description:` value only.
// Handles a bare/quoted single-line value AND a block scalar (`>-`, `>`, `|-`, `|`), the form
// every sampled public-set SKILL.md actually uses. Folds a block scalar per YAML folding: newlines
// between non-blank lines become a single space; a blank line becomes a literal newline. Trailing
// chomp indicator (`-`) strips the final newline either way, which is all this script needs since
// the result is flattened into one README table cell regardless.
// ---------------------------------------------------------------------------

function extractDescription(skillMdPath) {
  const text = fs.readFileSync(skillMdPath, 'utf8').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return '';
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return '';
  const front = lines.slice(1, end);
  for (let i = 0; i < front.length; i++) {
    const m = front[i].match(/^description:\s?(.*)$/);
    if (!m) continue;
    const rest = m[1].trim();
    if (/^[>|][+-]?\d*$/.test(rest) || rest === '') {
      // Block scalar (or bare `description:` with the value starting on the next line) — collect
      // every following line more-indented than the key, fold to one line.
      const keyIndent = front[i].match(/^(\s*)/)[1].length;
      const bodyLines = [];
      for (let j = i + 1; j < front.length; j++) {
        if (front[j].trim() === '') { bodyLines.push(''); continue; }
        const indent = front[j].match(/^(\s*)/)[1].length;
        if (indent <= keyIndent) break;
        bodyLines.push(front[j].trim());
      }
      return bodyLines.join(' ').replace(/\s+/g, ' ').trim();
    }
    // Single-line value: quoted or bare.
    return unquote(rest);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Which declared siblings this repo does NOT carry.
//
// MEASURED from the destination, never a hardcoded pair. It used to be a literal here, copied from
// one export report, so it went stale the moment the published set changed — which is exactly what
// publishing the framework family does to it. Reading it back off the tree means the sentence in
// the README is always the answer for the tree the reader is looking at.
//
// Narrow read of each published skill's own skill.manifest.yaml: the `skill:` value of every row
// under `requires.sibling_skills:`, minus everything the catalog publishes.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Where a skill sits inside a DESTINATION repository
// ---------------------------------------------------------------------------
//
// Probe order, layout 3 first — `.agents/skills` is the ONLY tree `skill export` writes today, for a
// parked source skill as much as an active one — with layout 2's parked tree and layout 1's single
// tree behind it as read tolerance, so a clone published before a bump still regenerates. Mirrors
// `DEST_TREES` in
// lib/skill-lifecycle/destinations.mjs, duplicated on purpose: a skill's script may not import from
// `lib/` or the folder stops being liftable, and `categories.yaml` already has three independent
// readers for the same reason.
//
// The WHOLE relative path, never a basename re-joined onto a fixed prefix. `.agents/skills` and
// `.sidekicks/skill-offloaded` do not share a parent, so a basename cannot say where a skill lives —
// and re-joining one reads EMPTY rather than failing. That is not hypothetical: this script hardcoded
// `path.join(dest, '.sidekicks', 'skills', name)`, and the first layout-2 export made it report
// "every sibling declared here is also published here" for a repo whose own `skill verify` found two
// declared-but-absent siblings.
const DEST_TREES = ['.agents/skills', '.sidekicks/skill-offloaded', '.sidekicks/skills'];

/** The directory a published skill occupies, and the tree it was found in. Null when absent. */
function destSkillDir(dest, name) {
  for (const tree of DEST_TREES) {
    const dir = path.join(dest, ...tree.split('/'), name);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) return { dir, tree };
  }
  return null;
}

function declaredSiblings(skillDir) {
  const abs = path.join(skillDir, 'skill.manifest.yaml');
  if (!fs.existsSync(abs)) return [];
  const out = [];
  let inSiblings = false;
  for (const raw of fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\s{2}sibling_skills:\s*$/.test(line)) { inSiblings = true; continue; }
    // Any other two-space key ends the section; so does anything back at column 0.
    if (inSiblings && (/^\s{2}[a-z_]+:/.test(line) || /^\S/.test(line))) inSiblings = false;
    if (!inSiblings) continue;
    const m = line.match(/^\s+-?\s*skill:\s+(.+)$/);
    if (m) out.push(unquote(m[1]));
  }
  return out;
}

function unpublishedSiblingsOf(dest, published) {
  const have = new Set(published);
  const missing = new Set();
  for (const name of published) {
    const found = destSkillDir(dest, name);
    if (!found) continue;
    for (const sib of declaredSiblings(found.dir)) {
      if (!have.has(sib)) missing.add(sib);
    }
  }
  return [...missing].sort();
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|');
}

function renderFamilyTable(members) {
  if (!members.length) {
    return ['_No skills published in this family yet._', '', '| Skill | Version | Description |', '|---|---|---|'];
  }
  const out = ['| Skill | Version | Description |', '|---|---|---|'];
  for (const m of members) {
    out.push(`| \`${m.name}\` | ${m.version || '0.0.0'} | ${escapeCell(m.description)} |`);
  }
  return out;
}

function replaceGeneratedRegion(text, newBodyLines) {
  const startIdx = text.indexOf(GEN_START);
  const endIdx = text.indexOf(GEN_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error('generated-region markers not found — refusing to guess where to write');
  }
  const before = text.slice(0, startIdx + GEN_START.length);
  const after = text.slice(endIdx);
  return `${before}\n\n${newBodyLines.join('\n')}\n\n${after}`;
}

// ---------------------------------------------------------------------------
// Prerequisites block — AAP-113 Definition of Done point 4.
//
// Emitted into EVERY categories/<family>/README.md (including the empty families, whose
// "_No skills published in this family yet._" table region is left exactly as it is) and into the
// top-level README.md. It lives in the generated region so a later regeneration rewrites it rather
// than dropping it — the whole reason this is fixed here and not by hand-editing the READMEs.
//
// Every number is DERIVED from the destination repo at run time, never hard-coded:
//   total      = catalog.yaml row count
//   noBaseline = those rows with no skill.manifest.yaml on disk
// The no-baseline fact itself is framework behaviour, not a defect of this export:
// lib/skill-lifecycle/manifest.mjs skips a skill that declares no dependency ("a skill that needs
// nothing gets nothing"), so no skill.manifest.yaml and therefore no bundle{} baseline is written;
// lib/skill-lifecycle/import.mjs then classifies such a copy `unversioned`, which is in its
// NEEDS_FORCE set. Accepted under AAP-115 (references/manifest-backfill.md).
// ---------------------------------------------------------------------------

function renderPrerequisites({ total, noBaseline, unpublishedSiblings }) {
  const head = [
    'Install the [Sidekicks framework core](https://github.com/utranand/sidekicks-harness) **first** — this',
    'repo carries skill folders, not the CLI substrate they run on.',
  ];
  if (unpublishedSiblings.length) {
    const siblings = unpublishedSiblings.map((n) => `\`${n}\``).join(', ');
    const one = unpublishedSiblings.length === 1;
    head.push(
      `Skills here declare ${unpublishedSiblings.length} sibling${one ? '' : 's'} that ${one ? 'is' : 'are'} not published in this repo:`,
      // Deliberately does not say WHERE to get them. A sibling is missing here for one of several
      // reasons — vendored third-party work we may not redistribute, a client-specific skill in the
      // private repo, or one nobody has published yet — and this script measures the absence
      // without being able to tell which. Naming a wrong source is worse than naming none.
      // No markdown link: this same block is written into the repo root README and into
      // categories/<family>/README.md, which sit at different depths, so any relative path is wrong
      // in one of them.
      `${siblings}. \`NOT-CARRIED.md\` at the repo root records what each is and why it is absent;`,
      'a skill that declares one still works without it, minus the step that hands off to it.',
    );
  } else {
    head.push('Every sibling skill declared by anything published here is also published here.');
  }
  return [
    ...head,
    '',
    `**Dependency-free skills carry no bundle baseline.** ${noBaseline} of the ${total} skills published here`,
    'declare no Python import, node package, binary, framework file or sibling skill, so the framework',
    'writes them no `skill.manifest.yaml` and they export with no bundle baseline — `sidekicks skill',
    'import` reports them `unversioned` rather than verified, and needs `--force` to land one. That is',
    'framework design, accepted under AAP-115, not a packaging defect: the copy is still',
    'byte-identical and its provenance still travels in `meta/<name>/origin.yaml`.',
  ];
}

// Insert a `## Prerequisites` section carrying its OWN marker pair immediately before `anchor`
// (once, if absent), then always rewrite strictly between those markers.
function upsertPrerequisites(text, bodyLines, anchor) {
  let out = text;
  if (!out.includes(PRE_START)) {
    const needle = `\n${anchor}`;
    const idx = out.indexOf(needle);
    if (idx === -1) {
      throw new Error(`no "${anchor}" heading to anchor the Prerequisites section before`);
    }
    const at = idx + 1; // start of the anchor heading's own line
    out = `${out.slice(0, at)}## Prerequisites\n\n${PRE_START}\n${PRE_END}\n\n${out.slice(at)}`;
  }
  const s = out.indexOf(PRE_START);
  const e = out.indexOf(PRE_END);
  if (s === -1 || e === -1 || e < s) {
    throw new Error('prerequisites markers not found — refusing to guess where to write');
  }
  return `${out.slice(0, s + PRE_START.length)}\n\n${bodyLines.join('\n')}\n\n${out.slice(e)}`;
}

// ---------------------------------------------------------------------------
// Top-level README — insert the marker pair once if absent (wrapping the existing Categories
// table + the "Ungrouped skills..." paragraph), then always rewrite strictly between them.
// ---------------------------------------------------------------------------

function ensureTopLevelMarkers(text) {
  if (text.includes(GEN_START)) return text;
  const headingIdx = text.indexOf('## Categories');
  if (headingIdx === -1) throw new Error('README.md has no "## Categories" heading to wrap');
  const afterHeading = text.indexOf('\n', headingIdx) + 1;
  const nextHeadingIdx = text.indexOf('\n## ', afterHeading);
  if (nextHeadingIdx === -1) throw new Error('README.md "## Categories" section has no following heading');
  const before = text.slice(0, afterHeading);
  const after = text.slice(nextHeadingIdx);
  return `${before}\n${GEN_START}\n${GEN_END}\n${after}`;
}

function renderTopLevelBody(FAMILIES, byFamily, ungrouped) {
  const out = ['| Family | What it covers | Skills |', '|---|---|---|'];
  for (const [family, blurb] of FAMILIES) {
    const count = (byFamily.get(family) || []).length;
    out.push(`| [${family}](categories/${family}/) | ${blurb} | ${count} |`);
  }
  out.push('');
  if (ungrouped.length) {
    out.push(
      'Uncategorised skills carry `category: \'\'` in `catalog.yaml` and are listed here rather than '
      + 'under a category:',
      '',
      '| Skill | Version | Description |',
      '|---|---|---|',
    );
    for (const m of ungrouped) {
      out.push(`| \`${m.name}\` | ${m.version || '0.0.0'} | ${escapeCell(m.description)} |`);
    }
  } else {
    out.push(
      'Uncategorised skills carry `category: \'\'` in `catalog.yaml` and are listed here rather than '
      + 'under a category. There are none yet.',
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.dest) {
    process.stdout.write('Usage: node regen-public-readmes.mjs --dest <destination-repo-root>\n');
    process.exitCode = opts.help ? 0 : 2;
    return;
  }
  const dest = path.resolve(opts.dest);
  const catalogPath = path.join(dest, 'catalog.yaml');
  if (!fs.existsSync(catalogPath)) return usageError(`catalog.yaml not found at ${catalogPath}`);

  const rows = readCatalog(catalogPath);
  if (!rows.length) return usageError('catalog.yaml carries zero rows — refusing to regenerate READMEs against an empty catalog (run the real export first)');

  const enriched = rows.map((r) => {
    // Probed across every layout's trees. A layout-3 destination keeps all of them in `.agents/skills`,
    // but a row in an older clone may still name a skill under a layout-1/2 tree.
    const found = destSkillDir(dest, r.name);
    const skillDir = found ? found.dir : path.join(dest, ...DEST_TREES[0].split('/'), r.name);
    const skillMd = path.join(skillDir, 'SKILL.md');
    const description = fs.existsSync(skillMd) ? extractDescription(skillMd) : '';
    // Measured, not assumed: a skill with no skill.manifest.yaml carries no bundle{} baseline.
    const hasManifest = fs.existsSync(path.join(skillDir, 'skill.manifest.yaml'));
    // `category` is the PUBLICATION family; `group` is the audit group. They differ deliberately for
    // the framework family. An older catalog written before the column existed falls back to group,
    // so regenerating against a pre-category export still works instead of dumping everything into
    // Ungrouped.
    const category = r.category || r.group || '';
    return { name: r.name, version: r.version, category, description, hasManifest };
  });

  const prereqBody = renderPrerequisites({
    total: enriched.length,
    noBaseline: enriched.filter((m) => !m.hasManifest).length,
    unpublishedSiblings: unpublishedSiblingsOf(dest, enriched.map((m) => m.name)),
  });

  const FAMILIES = readFamilies();
  const byFamily = new Map();
  const ungrouped = [];
  for (const m of enriched) {
    if (!m.category) { ungrouped.push(m); continue; }
    if (!byFamily.has(m.category)) byFamily.set(m.category, []);
    byFamily.get(m.category).push(m);
  }
  for (const list of byFamily.values()) list.sort((a, b) => (a.name < b.name ? -1 : 1));
  ungrouped.sort((a, b) => (a.name < b.name ? -1 : 1));

  const knownFamilies = new Set(FAMILIES.map(([f]) => f));
  const unknownFamilies = [...byFamily.keys()].filter((f) => !knownFamilies.has(f));
  if (unknownFamilies.length) {
    throw new Error(
      `catalog.yaml names categor(ies) this script does not know about: ${unknownFamilies.join(', ')} `
      + `— add them to ${CATEGORIES_YAML} before regenerating`,
    );
  }

  let wrote = 0;
  for (const [family] of FAMILIES) {
    const readmePath = path.join(dest, 'categories', family, 'README.md');
    if (!fs.existsSync(readmePath)) { process.stderr.write(`skip: ${readmePath} does not exist\n`); continue; }
    const text = fs.readFileSync(readmePath, 'utf8');
    const body = renderFamilyTable(byFamily.get(family) || []);
    // Table region first, then the prerequisites region — an empty family's
    // "_No skills published in this family yet._" text is inside renderFamilyTable's output and so
    // survives verbatim.
    const next = upsertPrerequisites(replaceGeneratedRegion(text, body), prereqBody, '## Notes');
    if (next !== text) { fs.writeFileSync(readmePath, next); wrote++; }
  }

  const topPath = path.join(dest, 'README.md');
  const topText = ensureTopLevelMarkers(fs.readFileSync(topPath, 'utf8'));
  const topBody = renderTopLevelBody(FAMILIES, byFamily, ungrouped);
  const topNext = upsertPrerequisites(
    replaceGeneratedRegion(topText, topBody), prereqBody, '## Installing',
  );
  fs.writeFileSync(topPath, topNext);
  wrote++;

  process.stdout.write(
    `regen-public-readmes: wrote ${wrote} README file(s); ${enriched.length} skills across `
    + `${byFamily.size} populated famil${byFamily.size === 1 ? 'y' : 'ies'}, ${ungrouped.length} ungrouped\n`,
  );
  for (const [family] of FAMILIES) {
    process.stdout.write(`  ${family}: ${(byFamily.get(family) || []).length}\n`);
  }
}

main();
