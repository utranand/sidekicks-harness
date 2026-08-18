#!/usr/bin/env node
// skill-search.mjs — find a skill that is NOT installed here by describing what you need it to do.
//
// Usage:
//   node .agents/skills/sk-skill-manager/scripts/skill-search.mjs index [options]
//   node .agents/skills/sk-skill-manager/scripts/skill-search.mjs find "<intent text>" [options]
//
// index options:  --destination <name> (repeatable)  --out <dir>  --work-item <slug>  --stamp <s>  --json
//   (--out default: this run's v2 folder via `scope run-base sk-skill-manager [--work-item]`,
//   falling back to the frozen pre-v2 <artifacts-base>/artifacts/runs/skill-manager)
// find options:   --destination <name> (repeatable)  --index <path>  --limit <n>  --json
//
// Exit 0 = results. Exit 3 = no candidates at all (index) / nothing scored above the floor (find).
// Exit 1 = usage/IO.
//
// WHY THIS EXISTS. `skill advise <name>` answers "is this NAMED skill in the skills repository" —
// it takes names, so it only helps once you already know what the thing is called. The case it
// cannot serve is the common one: the user wants something done, no installed skill covers it, and
// nobody knows whether a skill for it exists. That is an INTENT query, and the searchable text for
// it already exists — every skill's `description` frontmatter is written to be a triggering
// surface, so it is exactly the field a task description should be matched against.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   - It never imports. Import writes into .sidekicks/ and prints an apply plan a human has to
//     walk; a search verb that installed things would turn a guess into a repo change.
//   - It never writes to a destination checkout. Both subcommands are read-only over there.
//   - No embeddings, no semantic model. Term matching only, and every result prints the terms that
//     earned it — a ranking nobody can explain is one nobody can correct.
//   - It never returns a least-bad row. Below the floor it says nothing matched, because a
//     confident wrong recommendation costs more than an empty answer.
//
// WHERE THE BODIES LIVE. Layout 3 gives a destination ONE tree, `.agents/skills/<name>/`, whatever a
// skill's load state is in the repo that published it. Older destinations also hold
// `.sidekicks/skill-offloaded/<name>/` (layout 2's parked tree) or `.sidekicks/skills/<name>/`
// (layout 1), so the body is PROBED across all three, first hit wins, exactly as
// `destinationSkillDir` in lib/skill-lifecycle/destinations.mjs does.
//
// `meta/<name>/origin.yaml` records the tree in its `tree:` field as a FULL relative path, so it is
// used as-is and never re-joined onto a `.sidekicks/` prefix — doing that produced
// `<dest>/.sidekicks/.agents/skills/<name>`, a directory that does not exist, and every candidate
// then read as body-less instead of failing.
//
// Zero dependencies — node:* only. Repo root by walking up for .sidekicks/ + bin/sidekicks, never
// `git rev-parse` (a service's own code repo under projects/ would answer with the wrong root).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_REL = join('.agents', 'skills');

function fail(msg) {
  process.stderr.write(`skill-search: ${msg}\n`);
  process.exit(1);
}

function repoRoot() {
  // fileURLToPath, not URL.pathname — the latter keeps the Windows "/C:/…" leading slash and leaves
  // %20 in a path with a space, both of which turn into a silent "repo root not found".
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, '.sidekicks')) && existsSync(join(dir, 'bin', 'sidekicks'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  fail('repo root not found (walked up for .sidekicks/ + bin/sidekicks)');
  return '';
}

function readJsonVerb(root, args, what) {
  const res = spawnSync(process.execPath, [join(root, 'bin', 'sidekicks'), ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) fail(`could not run sidekicks ${args.join(' ')}: ${res.error.message}`);
  const out = (res.stdout || '').trim();
  if (!out) fail(`${what} produced no output (exit ${res.status})\n${(res.stderr || '').trim()}`);
  try {
    return JSON.parse(out);
  } catch (err) {
    fail(`${what} did not return JSON: ${err.message}`);
    return null;
  }
}

function artifactsBase(root) {
  const res = spawnSync(process.execPath, [join(root, 'bin', 'sidekicks'), 'scope', 'artifacts-base'], {
    cwd: root,
    encoding: 'utf8',
  });
  return (res.stdout || '').trim() || root;
}

// runBase — the v2 folder this run's generated output (the search index) lands in (runs layout
// v2). No `--bare`: this skill is not one of the four engines. Falls back to the frozen pre-v2
// join when the CLI verb is unavailable.
function runBase(root, workItem) {
  const args = ['scope', 'run-base', 'sk-skill-manager'];
  if (workItem) args.push(workItem);
  const res = spawnSync(process.execPath, [join(root, 'bin', 'sidekicks'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  const out = (res.stdout || '').trim();
  if (out && res.status === 0) return out;
  return join(artifactsBase(root), 'artifacts', 'runs', 'skill-manager');
}

// Asia/Bangkok, per the framework's timezone rule. Formatted from the UTC epoch at a fixed offset so
// it needs no ICU data and reads the same on macOS and Windows.
function stamps() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const time = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  const iso =
    `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}:${p(now.getUTCMinutes())}:${p(now.getUTCSeconds())}+07:00`;
  return { folder: `${date}-${time}`, iso };
}

// Repo-relative inside the repo (portable-paths rule), absolute only when the path is outside it —
// a "../../../.." walk out of the tree is neither portable nor readable.
function relPath(root, p) {
  if (!p) return p;
  const abs = isAbsolute(p) ? p : join(root, p);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return abs.split(sep).join('/');
  return rel.split(sep).join('/');
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------- tiny YAML readers
//
// Hand-rolled on purpose. The three shapes read here are flat and generated (catalog.yaml's list of
// scalar-only entries, origin.yaml's flat scalars, SKILL.md's frontmatter), and reaching into
// lib/yaml-subset/ would make this script depend on a framework file that `skill heal` cannot
// install — a lifted copy of the skill would stop working with no way to repair it.

const unquote = (v) => {
  const s = v.trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return s.slice(1, -1);
  return s;
};

function readFlatYaml(file) {
  const text = readText(file);
  if (text === null) return null;
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

// catalog.yaml: `skills:` then two-space-indented `- name: 'x'` entries with scalar fields.
function readCatalog(file) {
  const text = readText(file);
  if (text === null) return [];
  const entries = [];
  let current = null;
  let inSkills = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^skills:\s*$/.test(line)) {
      inSkills = true;
      continue;
    }
    if (!inSkills) continue;
    if (/^\S/.test(line)) break; // a new top-level key ends the list
    const start = /^\s*-\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (start) {
      current = { [start[1]]: unquote(start[2]) };
      entries.push(current);
      continue;
    }
    const cont = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (cont && current) current[cont[1]] = unquote(cont[2]);
  }
  return entries.filter((e) => e.name);
}

// SKILL.md frontmatter: `name:` and `description:`, the latter usually a `>-` folded block.
function readFrontmatter(file) {
  const text = readText(file);
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  const out = {};
  let key = null;
  let block = [];
  const flush = () => {
    if (key) out[key] = block.join(' ').replace(/\s+/g, ' ').trim();
    key = null;
    block = [];
  };
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) {
      flush();
      const value = kv[2].trim();
      if (value === '' || value === '>-' || value === '>' || value === '|' || value === '|-') {
        key = kv[1];
        block = [];
      } else {
        out[kv[1]] = unquote(value);
      }
      continue;
    }
    if (key) block.push(line.trim());
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------- index

function localSkillNames(root) {
  const dir = join(root, SKILLS_REL);
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir).filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    }),
  );
}

/**
 * The trees a destination may hold, in probe order — layout 3 first (the only one written today),
 * then layout 2's parked tree, then layout 1. Mirrors `DEST_TREES` in
 * lib/skill-lifecycle/destinations.mjs; duplicated on purpose, because a lifted copy of this skill
 * runs with no lib/ import path.
 */
const DEST_TREES = ['.agents/skills', '.sidekicks/skill-offloaded', '.sidekicks/skills'];

/**
 * Where a published skill's body is, and which tree it was found in.
 *
 * `recordedTree` (origin.yaml's `tree:`) is a full destination-relative path and is TRIED FIRST, so a
 * destination that carries the same name in two trees resolves to the one the export recorded. It is
 * used verbatim — never re-joined onto a `.sidekicks/` prefix. When it is absent or points at nothing
 * (a hand-migrated destination), the probe decides, and the last fallback is layout 3's tree so the
 * reported path is the one a fresh export would write.
 */
function locateBody(checkoutAbs, name, recordedTree) {
  const order = recordedTree ? [recordedTree, ...DEST_TREES.filter((t) => t !== recordedTree)] : DEST_TREES;
  for (const tree of order) {
    const bodyDir = join(checkoutAbs, ...tree.split('/'), name);
    if (existsSync(join(bodyDir, 'SKILL.md'))) return { tree, bodyDir };
  }
  const tree = recordedTree || DEST_TREES[0];
  return { tree, bodyDir: join(checkoutAbs, ...tree.split('/'), name) };
}

function buildIndex(root, opts) {
  const dest = readJsonVerb(root, ['skill', 'destinations', '--json'], 'skill destinations');
  const configured = (dest.destinations || []).map((d) => ({ ...d, checkout: relPath(root, d.checkout) }));

  const wanted = opts.destinations.length ? new Set(opts.destinations) : null;
  for (const name of wanted || []) {
    if (!configured.some((d) => d.name === name)) {
      fail(`unknown destination "${name}" (configured: ${configured.map((d) => d.name).join(', ') || 'none'})`);
    }
  }

  const local = localSkillNames(root);
  const candidates = new Map(); // name -> record

  // Source 1: the verb's own `destination-only` rows — authoritative, but empty on a repo where
  // every uninstalled skill is also parked in .sidekicks/skill-offloaded/ (the verb sees the
  // offloaded copy as local). Source 2 below is what actually finds those.
  const destinationOnly = new Set();
  for (const row of dest.skills || []) {
    for (const d of row.destinations || []) {
      if (d.status === 'destination-only') destinationOnly.add(`${row.skill}@${d.destination}`);
    }
  }

  for (const d of configured) {
    if (wanted && !wanted.has(d.name)) continue;
    if (!d.present || !d.checkout) continue;
    const checkoutAbs = isAbsolute(d.checkout) ? d.checkout : join(root, d.checkout);
    const catalog = readCatalog(join(checkoutAbs, 'catalog.yaml'));

    for (const entry of catalog) {
      const name = entry.name;
      if (local.has(name)) continue; // installed here — not a candidate, whatever the destination says

      const origin = readFlatYaml(join(checkoutAbs, 'meta', name, 'origin.yaml')) || {};
      const { tree, bodyDir } = locateBody(checkoutAbs, name, origin.tree);
      const fm = readFrontmatter(join(bodyDir, 'SKILL.md')) || {};
      const versionFile = readText(join(bodyDir, 'VERSION.json'));
      let version = entry.version || origin.version || null;
      if (versionFile) {
        try {
          version = JSON.parse(versionFile).version || version;
        } catch {
          /* a malformed VERSION.json is not worth failing a search over */
        }
      }

      const where = {
        destination: d.name,
        checkout: d.checkout,
        tree,
        body_dir: relPath(root, bodyDir),
        skill_md: relPath(root, join(bodyDir, 'SKILL.md')),
        exported_at: origin.exported_at || null,
        destination_only_row: destinationOnly.has(`${name}@${d.name}`),
        has_body: existsSync(join(bodyDir, 'SKILL.md')),
      };

      const existing = candidates.get(name);
      if (existing) {
        existing.available_in.push(where);
        if (!existing.description && fm.description) existing.description = fm.description;
        continue;
      }
      candidates.set(name, {
        name,
        description: fm.description || '',
        frontmatter_name: fm.name || null,
        version,
        group: entry.group || null,
        first_party: entry.first_party === 'true' || entry.first_party === true,
        siblings: entry.siblings ? entry.siblings.split(/[,\s]+/).filter(Boolean) : [],
        binaries: entry.binaries ? entry.binaries.split(/[,\s]+/).filter(Boolean) : [],
        python: entry.python ? entry.python.split(/[,\s]+/).filter(Boolean) : [],
        available_in: [where],
      });
    }
  }

  const rows = [...candidates.values()].sort((a, b) => a.name.localeCompare(b.name));
  const missingBody = rows.filter((r) => !r.available_in.some((w) => w.has_body)).map((r) => r.name);
  const missingDescription = rows.filter((r) => r.available_in.some((w) => w.has_body) && !r.description).map((r) => r.name);

  return {
    generated_at: opts.stampIso,
    source: 'sidekicks skill destinations --json + each destination catalog.yaml',
    destinations: configured,
    filters: { destinations: opts.destinations },
    local_skill_count: local.size,
    candidate_count: rows.length,
    // Named, not silently dropped: a candidate with no readable body cannot be searched, and a
    // search that quietly covers less than it claims is the failure this line exists to prevent.
    unsearchable: { no_body: missingBody, no_description: missingDescription },
    candidates: rows,
  };
}

// ---------------------------------------------------------------------------- scoring

const STOPWORDS = new Set([
  'a', 'about', 'all', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can',
  'could', 'do', 'does', 'doing', 'done', 'for', 'from', 'get', 'give', 'has', 'have', 'help',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'my', 'need', 'needs', 'of',
  'on', 'one', 'or', 'our', 'out', 'over', 'please', 'said', 'should', 'so', 'some', 'something',
  'skill', 'skills', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'to', 'up', 'us', 'use', 'used', 'using', 'want', 'wants', 'was', 'way', 'we', 'what', 'when',
  'where', 'which', 'while', 'who', 'will', 'with', 'would', 'you', 'your',
]);

// Crude, deliberate suffix folding so "videos"/"video" and "generating"/"generate" meet. Not a
// stemmer: it only has to be consistent, since both the intent and the haystack go through it.
function fold(word) {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

const SCORE = {
  phrase_in_name: 12,
  phrase_in_description: 6,
  term_in_name: 4,
  term_in_description: 2,
  // A term the description leans on: +1 per 3 occurrences, capped at +3. Capped because a long
  // description would otherwise out-rank a precise short one on sheer repetition alone.
  repeat_in_description: 1,
  repeat_cap: 3,
  coverage: 4, // multiplied by the fraction of intent terms matched anywhere
};

// The floor is two rules, not one number. A single common term hitting a long description is the
// classic false positive, so a multi-term intent must match at least two distinct terms.
const FLOOR_SCORE = 6;
const FLOOR_TERMS_FOR_LONG_INTENT = 2;

function scoreCandidate(candidate, intent) {
  const nameText = candidate.name.replace(/[-_]+/g, ' ').toLowerCase();
  const descText = String(candidate.description || '').toLowerCase();
  const nameFolded = new Set(tokenize(nameText).map(fold));
  const descTokens = tokenize(descText).map(fold);
  const descCounts = new Map();
  for (const t of descTokens) descCounts.set(t, (descCounts.get(t) || 0) + 1);

  let score = 0;
  const matched = [];

  if (intent.phrase && intent.phrase.length >= 6) {
    if (nameText.includes(intent.phrase)) {
      score += SCORE.phrase_in_name;
      matched.push(`phrase:"${intent.phrase}" (name)`);
    } else if (descText.includes(intent.phrase)) {
      score += SCORE.phrase_in_description;
      matched.push(`phrase:"${intent.phrase}"`);
    }
  }

  for (const term of intent.terms) {
    const folded = fold(term);
    const inName = nameFolded.has(folded);
    const count = descCounts.get(folded) || 0;
    if (!inName && !count) continue;
    const where = [];
    if (inName) {
      score += SCORE.term_in_name;
      where.push('name');
    }
    if (count) {
      score += SCORE.term_in_description;
      where.push(count > 1 ? `desc x${count}` : 'desc');
      score += Math.min(SCORE.repeat_cap, Math.floor(count / 3) * SCORE.repeat_in_description);
    }
    matched.push(`${term} (${where.join(' + ')})`);
  }

  const distinct = matched.filter((m) => !m.startsWith('phrase:')).length;
  const coverage = intent.terms.length ? distinct / intent.terms.length : 0;
  score += Math.round(coverage * SCORE.coverage);

  return { score, matched, distinct_terms: distinct, coverage: Number(coverage.toFixed(2)) };
}

function rank(index, intentText, limit) {
  const terms = [...new Set(tokenize(intentText))];
  const intent = { phrase: String(intentText || '').toLowerCase().trim(), terms };
  if (!terms.length) fail('the intent has no searchable words left after stopword removal — describe the task, not the request');

  const minTerms = terms.length >= 3 ? FLOOR_TERMS_FOR_LONG_INTENT : 1;
  const scored = index.candidates
    .map((c) => ({ candidate: c, ...scoreCandidate(c, intent) }))
    .filter((r) => r.score >= FLOOR_SCORE && r.distinct_terms >= minTerms)
    .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name));

  return {
    intent: intentText,
    terms,
    floor: { score: FLOOR_SCORE, distinct_terms: minTerms },
    considered: index.candidates.length,
    matched: scored.length,
    results: scored.slice(0, limit),
  };
}

function importCommand(candidate) {
  const where = candidate.available_in[0];
  return {
    destination: where.destination,
    report: `node bin/sidekicks skill import ${candidate.name} --from ${where.checkout}`,
    apply: `node bin/sidekicks skill import ${candidate.name} --from ${where.checkout} --apply`,
  };
}

function excerpt(text, max = 220) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '(no description in its SKILL.md frontmatter)';
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '), cut.lastIndexOf(' '));
  return `${cut.slice(0, stop > 60 ? stop : max)}…`;
}

// ---------------------------------------------------------------------------- main

function parseArgs(argv) {
  const opts = { destinations: [], out: null, stamp: null, json: false, index: null, limit: 5, workItem: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--destination') opts.destinations.push(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--work-item') opts.workItem = argv[++i];
    else if (a === '--stamp') opts.stamp = argv[++i];
    else if (a === '--index') opts.index = argv[++i];
    else if (a === '--limit') opts.limit = Math.max(1, Number(argv[++i]) || 5);
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) fail(`unknown flag ${a}`);
    else rest.push(a);
  }
  opts.rest = rest;
  return opts;
}

function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0] === 'find' ? 'find' : argv[0] === 'index' ? 'index' : null;
  if (!sub) fail('first argument must be "index" or "find"');
  const opts = parseArgs(argv.slice(1));
  const root = repoRoot();
  const stamp = stamps();

  if (sub === 'index') {
    const index = buildIndex(root, { ...opts, stampIso: stamp.iso });
    const outBase = opts.out ? resolvePath(opts.out) : runBase(root, opts.workItem);
    const outDir = join(outBase, `skill-search-${opts.stamp || stamp.folder}`);
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, 'search-index.json');
    writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ...index, written: relPath(root, file) }, null, 2)}\n`);
    } else {
      process.stdout.write(`Search index: ${relPath(root, file)}\n`);
      process.stdout.write(`  candidates (in a destination, not installed here): ${index.candidate_count}\n`);
      for (const d of index.destinations) {
        const n = index.candidates.filter((c) => c.available_in.some((w) => w.destination === d.name)).length;
        process.stdout.write(`    ${d.name}: ${n}${d.present ? '' : ' (checkout absent)'}\n`);
      }
      if (index.unsearchable.no_body.length) process.stdout.write(`  no readable SKILL.md: ${index.unsearchable.no_body.join(', ')}\n`);
      if (index.unsearchable.no_description.length) process.stdout.write(`  no description: ${index.unsearchable.no_description.join(', ')}\n`);
    }
    if (!index.candidate_count) process.exit(3);
    return;
  }

  const intentText = opts.rest.join(' ').trim();
  if (!intentText) fail('find needs an intent, e.g. find "turn a script into a short vertical video"');

  let index;
  if (opts.index) {
    const p = resolvePath(opts.index);
    const file = existsSync(p) && statSync(p).isDirectory() ? join(p, 'search-index.json') : p;
    const text = readText(file);
    if (text === null) fail(`no search index at ${relPath(root, file)}`);
    index = JSON.parse(text);
  } else {
    index = buildIndex(root, { ...opts, stampIso: stamp.iso });
  }

  if (opts.destinations.length) {
    const wanted = new Set(opts.destinations);
    index = {
      ...index,
      candidates: index.candidates
        .map((c) => ({ ...c, available_in: c.available_in.filter((w) => wanted.has(w.destination)) }))
        .filter((c) => c.available_in.length),
    };
  }

  const ranked = rank(index, intentText, opts.limit);
  const payload = {
    ...ranked,
    results: ranked.results.map((r) => ({
      name: r.candidate.name,
      destination: r.candidate.available_in[0].destination,
      tree: r.candidate.available_in[0].tree,
      version: r.candidate.version,
      score: r.score,
      matched: r.matched,
      coverage: r.coverage,
      description: r.candidate.description,
      skill_md: r.candidate.available_in[0].skill_md,
      siblings: r.candidate.siblings,
      import: importCommand(r.candidate),
    })),
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (!payload.results.length) process.exit(3);
    return;
  }

  if (!payload.results.length) {
    process.stdout.write(`No candidate matched "${intentText}".\n`);
    process.stdout.write(`  searched ${ranked.considered} skill(s) available in a destination but not installed here\n`);
    process.stdout.write(`  intent terms: ${ranked.terms.join(', ')}\n`);
    process.stdout.write(`  floor: score >= ${ranked.floor.score} and >= ${ranked.floor.distinct_terms} distinct term(s)\n`);
    process.stdout.write('\nNothing here does this job. Say so rather than importing the closest row —\n');
    process.stdout.write('the next step is building the skill (CREATE), not installing a near-miss.\n');
    process.exit(3);
  }

  process.stdout.write(`Intent: "${intentText}"\n`);
  process.stdout.write(`Terms: ${ranked.terms.join(', ')} — ${ranked.matched} of ${ranked.considered} candidate(s) above the floor\n\n`);
  let i = 0;
  for (const r of payload.results) {
    i += 1;
    // The tree is only worth naming when it is NOT layout 3's single tree — i.e. an older destination
    // still holding a layout-1/2 copy. The old check compared against a basename that `tree:` never
    // carries, so the tag never once printed.
    const treeTag = r.tree && r.tree !== DEST_TREES[0] ? `, ${r.tree}` : '';
    process.stdout.write(`${i}. ${r.name}  [${r.destination}${treeTag}]  ${r.version ? `v${r.version}` : 'no VERSION.json'}  score ${r.score}\n`);
    process.stdout.write(`   matched: ${r.matched.join(', ')}\n`);
    process.stdout.write(`   ${excerpt(r.description)}\n`);
    if (r.siblings.length) process.stdout.write(`   declared siblings: ${r.siblings.join(', ')}\n`);
    process.stdout.write(`   read it first: ${r.skill_md}\n`);
    process.stdout.write(`   import (report): ${r.import.report}\n`);
    process.stdout.write(`   import (apply) : ${r.import.apply}\n\n`);
  }
  process.stdout.write('A description match is a hint, not a verdict — read the top candidate\'s SKILL.md\n');
  process.stdout.write('before recommending it, then walk the apply plan `skill import` prints.\n');
}

main();
