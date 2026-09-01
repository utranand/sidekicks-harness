#!/usr/bin/env node
// export-picklist.mjs — turn `sidekicks skill destinations` into a PICK LIST the operator ticks,
// then turn the ticks back into the exact export commands.
//
// Usage:
//   node .agents/skills/sk-skill-manager/scripts/export-picklist.mjs plan   [options]
//   node .agents/skills/sk-skill-manager/scripts/export-picklist.mjs resolve <path> [--json]
//
// plan options:
//   --out <dir>            where the pick list lands (default: this run's v2 folder — `scope
//                          run-base sk-skill-manager [--work-item]`, falling back to the
//                          frozen pre-v2 path <artifacts-base>/artifacts/runs/skill-manager when
//                          the CLI verb is unavailable)
//   --work-item <slug>     the work item this run belongs to (runs layout v2); no work item lands
//                          under this project's _adhoc/sk-skill-manager/ — that is normal,
//                          this skill has no natural unit of work of its own
//   --destination <name>   only consider this destination (repeatable)
//   --stale-only           drop the never-exported section entirely
//   --all                  do not suppress rows (see SUPPRESSION below)
//   --stamp <YYYYMMDD-HHMMSS>  fixed folder stamp (tests; default is Asia/Bangkok now)
//   --json                 print the machine report to stdout instead of the human summary
//
// resolve takes the pick-list folder, its picklist.md, or its picklist.json.
//
// Exit 0 = wrote/read a pick list. Exit 3 = nothing to pick (no candidates). Exit 1 = usage/IO.
//
// WHY THIS EXISTS. `skill destinations` answers "what drifted" as 170+ JSON rows across every
// skill and every destination — an answer nobody can act on. Selecting from it by hand is where
// the two expensive mistakes happen: exporting a skill nobody decided should be published, and
// re-exporting a dirty tree so the destination's origin.yaml attributes bytes to a commit that
// does not contain them. This script does the mechanical half of REVIEW (classify, enrich, offer)
// and refuses to do the judgement half.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   - It never summarises a diff. The pick list prints the `diff -ru` command per row; reading it
//     and saying what a consumer GAINS is the agent's job, and a generated summary would be a
//     file-name list wearing a conclusion's clothes.
//   - It never exports. `resolve` PRINTS commands; a human runs them. Export writes into another
//     repository, so it stays an explicit act.
//   - It never writes a skill's `skill_repo:` intent. Deciding a skill is withheld is a skill edit
//     and goes through the improvement funnel, not a checkbox.
//
// SUPPRESSION (plan, default on). A `never-exported` row is hidden when that same skill is
// `in-sync` at a DIFFERENT destination — it is already published somewhere, so "nobody decided" is
// false; that is how the 24 private-resident skills stop drowning the public list. A row whose
// skill declares an intent for another destination is hidden too, because export would refuse it.
// `--all` shows both, each with its `suppressed:` reason.
//
// Zero dependencies — node:* only. Resolves the repo root by walking up for .sidekicks/, never with
// `git rev-parse` (a service's own code repo under projects/ would answer with the wrong root).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_REL = join('.agents', 'skills');
// SKILLS_REL's segments, split separator-agnostically so dirtySkills() can compare against the
// constant instead of repeating its literals (see the comment at the comparison site).
const SKILLS_PARTS = SKILLS_REL.split(/[\\/]/);

function fail(msg) {
  process.stderr.write(`export-picklist: ${msg}\n`);
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

function runNode(root, args) {
  const res = spawnSync(process.execPath, [join(root, 'bin', 'sidekicks'), ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) fail(`could not run sidekicks ${args.join(' ')}: ${res.error.message}`);
  return res;
}

function readJsonVerb(root, args, what) {
  const res = runNode(root, args);
  const out = (res.stdout || '').trim();
  if (!out) fail(`${what} produced no output (exit ${res.status})\n${(res.stderr || '').trim()}`);
  try {
    return JSON.parse(out);
  } catch (err) {
    fail(`${what} did not return JSON: ${err.message}`);
    return null;
  }
}

// Asia/Bangkok, per the framework's timezone rule. Formatted from the UTC epoch with a fixed
// offset so it needs no ICU data and reads the same on macOS and Windows.
function stamps() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const date = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const time = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  const iso =
    `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}:${p(now.getUTCMinutes())}:${p(now.getUTCSeconds())}+07:00`;
  return { folder: `${date}-${time}`, iso };
}

function localVersion(root, skill) {
  const file = join(root, SKILLS_REL, skill, 'VERSION.json');
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return typeof v.version === 'string' ? v.version : null;
  } catch {
    return null;
  }
}

// Which skill paths carry uncommitted work. One `git status` for the whole skills tree — a
// per-skill call would be 120 subprocesses to answer the same question.
function dirtySkills(root) {
  const res = spawnSync('git', ['-C', root, 'status', '--porcelain', '--', SKILLS_REL], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const dirty = new Set();
  if (res.error || res.status !== 0) return dirty; // not a git tree: report nothing rather than guess
  for (const line of (res.stdout || '').split('\n')) {
    const path = line.slice(3).trim().replace(/^"|"$/g, '');
    if (!path) continue;
    // Handle a rename's "old -> new" form by taking the destination.
    const target = path.includes(' -> ') ? path.split(' -> ').pop() : path;
    const parts = target.split(/[\\/]/);
    // Compare against SKILLS_REL's own segments, never a literal: this check silently died at
    // 9c9654c1 (the .sidekicks/skills -> .agents/skills rename) because the constant moved and the
    // literal here did not, leaving dirtySkills() permanently empty and the UNCOMMITTED flag dead
    // for eight days. Split the constant the same separator-agnostic way the path above is split —
    // join() yields '.agents\\skills' on Windows while git always emits forward slashes, so
    // startsWith(SKILLS_REL) or a '/'-only split would break on one platform or the other.
    if (parts[0] === SKILLS_PARTS[0] && parts[1] === SKILLS_PARTS[1] && parts[2]) dirty.add(parts[2]);
  }
  return dirty;
}

// Repo-relative when the path is inside the repo (portable-paths rule); left absolute when it is
// not, because a "../../../.." walk out of the tree is neither portable nor readable.
function relPath(root, p) {
  if (!p) return p;
  const abs = isAbsolute(p) ? p : join(root, p);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return abs.split(sep).join('/');
  return rel.split(sep).join('/');
}

function buildPlan(root, opts) {
  const dest = readJsonVerb(root, ['skill', 'destinations', '--json'], 'skill destinations');
  const cfg = readJsonVerb(
    root,
    ['framework', 'config', 'sk-skill-manager', '--json'],
    'framework config',
  );
  const sourceRepo = cfg?.config?.export?.source_repo || '';
  const withDeps = cfg?.config?.export?.with_deps !== false;

  const checkouts = new Map();
  for (const d of dest.destinations || []) checkouts.set(d.name, d);

  const wanted = opts.destinations.length ? new Set(opts.destinations) : null;
  for (const name of wanted || []) {
    if (!checkouts.has(name)) fail(`unknown destination "${name}" (configured: ${[...checkouts.keys()].join(', ') || 'none'})`);
  }

  const dirty = dirtySkills(root);
  const publishedElsewhere = new Map(); // skill -> [destination names where it is in-sync]
  for (const row of dest.skills || []) {
    for (const d of row.destinations || []) {
      if (d.status !== 'in-sync') continue;
      if (!publishedElsewhere.has(row.skill)) publishedElsewhere.set(row.skill, []);
      publishedElsewhere.get(row.skill).push(d.destination);
    }
  }

  const stale = [];
  const untouched = [];
  const notes = [];

  for (const row of dest.skills || []) {
    const skill = row.skill;
    const intent = row.intent ?? null;
    const version = localVersion(root, skill);
    const present = existsSync(join(root, SKILLS_REL, skill));

    for (const d of row.destinations || []) {
      if (wanted && !wanted.has(d.destination)) continue;

      if (d.status === 'destination-only' || d.status === 'unreachable') {
        notes.push({ skill, destination: d.destination, status: d.status });
        continue;
      }
      if (d.status === 'in-sync') continue;

      const checkout = relPath(root, checkouts.get(d.destination)?.checkout || '');
      const base = {
        skill,
        destination: d.destination,
        status: d.status,
        intent,
        local_version: version,
        exported_version: d.exported_version ?? null,
        checkout,
        local_present: present,
        dirty: dirty.has(skill),
      };

      let suppressed = null;
      if (intent && intent !== d.destination) suppressed = `intent is "${intent}" — export to ${d.destination} would refuse`;

      if (d.status === 'stale') {
        stale.push({
          ...base,
          differing: d.differing || [],
          missing: d.missing || [],
          extra: d.extra || [],
          version_delta:
            version && d.exported_version
              ? version === d.exported_version
                ? 'UNCHANGED'
                : `${d.exported_version} -> ${version}`
              : 'unknown',
          suppressed,
        });
        continue;
      }

      if (d.status === 'never-exported') {
        if (opts.staleOnly) continue;
        if (!present) suppressed = suppressed || 'not present locally (destination-resident skill)';
        else if (!suppressed) {
          const others = (publishedElsewhere.get(skill) || []).filter((n) => n !== d.destination);
          if (others.length) suppressed = `already published to ${others.join(', ')}`;
        }
        untouched.push({ ...base, suppressed });
      }
    }
  }

  const visible = (rows) => (opts.all ? rows : rows.filter((r) => !r.suppressed));
  const order = (a, b) => a.skill.localeCompare(b.skill) || a.destination.localeCompare(b.destination);

  return {
    generated_at: opts.stampIso,
    source: 'sidekicks skill destinations --json',
    export: { source_repo: sourceRepo, with_deps: withDeps },
    destinations: (dest.destinations || []).map((d) => ({ ...d, checkout: relPath(root, d.checkout) })),
    filters: { destinations: opts.destinations, stale_only: opts.staleOnly, all: opts.all },
    reexport: visible(stale).sort(order),
    undecided: visible(untouched).sort(order),
    suppressed: [...stale, ...untouched].filter((r) => r.suppressed).sort(order),
    notes: notes.sort(order),
  };
}

function checkboxLine(row, kind) {
  const bits = [`**${row.skill}** -> \`${row.destination}\``];
  if (kind === 'reexport') {
    bits.push(`v${row.version_delta}`);
    bits.push(`${row.differing.length} changed / ${row.missing.length} new / ${row.extra.length} left behind`);
  } else {
    bits.push(row.local_version ? `v${row.local_version}` : 'no VERSION.json');
    bits.push('never published');
  }
  if (row.dirty) bits.push('**UNCOMMITTED**');
  if (row.intent) bits.push(`intent: ${row.intent}`);
  return `- [ ] ${bits.join(' — ')}`;
}

function renderMarkdown(plan) {
  const L = [];
  L.push('# Skill export pick list');
  L.push('');
  L.push(`Generated ${plan.generated_at} from \`${plan.source}\`.`);
  L.push('');
  L.push('Tick `[x]` on every row to export, save the file, then resolve it:');
  L.push('');
  L.push('```sh');
  L.push('node .agents/skills/sk-skill-manager/scripts/export-picklist.mjs resolve <this-folder>');
  L.push('```');
  L.push('');
  L.push('Resolve prints the export commands; it does not run them. A row left unticked is not');
  L.push('exported and nothing else about it changes.');
  L.push('');

  L.push('## 1. Re-export candidates (published copy is out of date)');
  L.push('');
  if (!plan.reexport.length) {
    L.push('_None — every published copy is byte-identical to what an export would write today._');
  } else {
    L.push('Read each diff before ticking. Three things change the decision, so they are on the row:');
    L.push('a version delta of `UNCHANGED` means the bump was forgotten; `left behind` files must be');
    L.push('deleted **at the destination by hand** (export only writes); `UNCOMMITTED` means exporting');
    L.push('now attributes the published bytes to a commit that does not contain them.');
    L.push('');
    for (const row of plan.reexport) {
      L.push(checkboxLine(row, 'reexport'));
      L.push(`      \`diff -ru ${row.checkout}/${SKILLS_REL.split(sep).join('/')}/${row.skill} ${SKILLS_REL.split(sep).join('/')}/${row.skill}\``);
      if (row.missing.length) L.push(`      new here: ${row.missing.join(', ')}`);
      if (row.extra.length) L.push(`      LEFT BEHIND at destination (delete by hand): ${row.extra.join(', ')}`);
      if (row.suppressed) L.push(`      suppressed: ${row.suppressed}`);
      L.push('');
    }
  }
  L.push('');

  L.push('## 2. Never published anywhere (nobody has decided)');
  L.push('');
  if (plan.filters.stale_only) {
    L.push('_Not listed — this pick list was generated with `--stale-only`, so the never-published');
    L.push('rows were skipped rather than found to be empty._');
  } else if (!plan.undecided.length) {
    L.push('_None._');
  } else {
    L.push('A different question from section 1, and only section 1 has an obvious answer. Ticking');
    L.push('one publishes it for the first time; leaving it means the decision is still open. To');
    L.push('withhold a skill permanently, give it `skill_repo: none` in its own `skill.yaml` — that');
    L.push('is a skill edit and goes through the improvement funnel, not this list.');
    L.push('');
    for (const row of plan.undecided) {
      L.push(checkboxLine(row, 'undecided'));
      if (row.suppressed) L.push(`      suppressed: ${row.suppressed}`);
    }
  }
  L.push('');

  if (plan.suppressed.length) {
    L.push('## Suppressed rows');
    L.push('');
    L.push('Hidden from the sections above (re-run `plan --all` to list them inline):');
    L.push('');
    for (const row of plan.suppressed) L.push(`- ${row.skill} -> \`${row.destination}\` — ${row.suppressed}`);
    L.push('');
  }

  if (plan.notes.length) {
    L.push('## Not export candidates');
    L.push('');
    for (const row of plan.notes) L.push(`- ${row.skill} -> \`${row.destination}\` — ${row.status}`);
    L.push('');
  }

  return `${L.join('\n')}\n`;
}

function writePlan(root, plan, outDir) {
  mkdirSync(outDir, { recursive: true });
  const md = join(outDir, 'picklist.md');
  const js = join(outDir, 'picklist.json');
  writeFileSync(md, renderMarkdown(plan), 'utf8');
  writeFileSync(js, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return { md, js };
}

function artifactsBase(root) {
  const res = runNode(root, ['scope', 'artifacts-base']);
  const out = (res.stdout || '').trim();
  return out || root;
}

// runBase — the v2 folder this run's generated output lands in (runs layout v2). No `--bare`: this
// skill is not one of the four engines, so a work item (when given) still gets its own
// `skill-manager` facet. Falls back to the frozen pre-v2 join when the CLI verb is unavailable.
function runBase(root, workItem) {
  const args = ['scope', 'run-base', 'sk-skill-manager'];
  if (workItem) args.push(workItem);
  const res = runNode(root, args);
  const out = (res.stdout || '').trim();
  if (out && res.status === 0) return out;
  return join(artifactsBase(root), 'artifacts', 'runs', 'skill-manager');
}

// ---------------------------------------------------------------------------- resolve

function locatePlan(target) {
  let dir = target;
  if (existsSync(target) && statSync(target).isFile()) dir = dirname(target);
  const js = join(dir, 'picklist.json');
  const md = join(dir, 'picklist.md');
  if (!existsSync(js)) fail(`no picklist.json under ${dir} — pass the pick-list folder or one of its files`);
  if (!existsSync(md)) fail(`no picklist.md under ${dir} — the ticks live there`);
  return { dir, js, md };
}

// A ticked row names one skill and one destination: `- [x] **name** -> `dest` — …`.
function parseTicks(mdText) {
  const picks = [];
  const bad = [];
  for (const line of mdText.split('\n')) {
    const m = /^-\s*\[([ xX])\]\s*\*\*(\S+)\*\*\s*->\s*`([^`]+)`/.exec(line.trim());
    if (!m) {
      if (/^-\s*\[[^\s\]]\]/.test(line.trim()) && !/^-\s*\[[xX]\]/.test(line.trim())) bad.push(line.trim());
      continue;
    }
    if (m[1] === ' ') continue;
    picks.push({ skill: m[2], destination: m[3] });
  }
  return { picks, bad };
}

function resolveCommands(plan, picks) {
  const known = new Map();
  for (const row of [...plan.reexport, ...plan.undecided, ...plan.suppressed]) {
    known.set(`${row.skill}@${row.destination}`, row);
  }

  const chosen = [];
  const unknown = [];
  for (const p of picks) {
    const row = known.get(`${p.skill}@${p.destination}`);
    if (row) chosen.push(row);
    else unknown.push(p);
  }

  const byDest = new Map();
  for (const row of chosen) {
    if (!byDest.has(row.destination)) byDest.set(row.destination, []);
    byDest.get(row.destination).push(row);
  }

  const commands = [];
  for (const [destination, rows] of [...byDest.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const names = rows.map((r) => r.skill).sort();
    const flags = ['--destination', destination];
    if (plan.export.with_deps) flags.push('--with-deps');
    if (plan.export.source_repo) flags.push('--source-repo', plan.export.source_repo);
    const base = ['node', 'bin/sidekicks', 'skill', 'export', ...names, ...flags];
    commands.push({ destination, skills: names, dry_run: [...base, '--dry-run'].join(' '), apply: base.join(' ') });
  }

  const warnings = [];
  for (const row of chosen) {
    if (row.dirty) warnings.push(`${row.skill}: UNCOMMITTED local changes — the destination's origin.yaml would record a source_commit that does not contain these bytes. Commit first.`);
    if (row.version_delta === 'UNCHANGED') warnings.push(`${row.skill}: VERSION.json still ${row.local_version} — the published copy will look current to anything reading the version. Bump it first.`);
    if (row.extra?.length) warnings.push(`${row.skill}: ${row.extra.length} file(s) left behind at ${row.destination} (${row.extra.join(', ')}) — export never deletes; remove them by hand at the destination.`);
    if (row.suppressed) warnings.push(`${row.skill} -> ${row.destination}: picked despite being suppressed (${row.suppressed}).`);
  }

  return { chosen, unknown, commands, warnings };
}

// ---------------------------------------------------------------------------- main

function parseArgs(argv) {
  const opts = { destinations: [], staleOnly: false, all: false, json: false, out: null, stamp: null, target: null, workItem: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--destination') opts.destinations.push(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--work-item') opts.workItem = argv[++i];
    else if (a === '--stamp') opts.stamp = argv[++i];
    else if (a === '--stale-only') opts.staleOnly = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) fail(`unknown flag ${a}`);
    else rest.push(a);
  }
  opts.target = rest[0] || null;
  return opts;
}

function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0] === 'resolve' ? 'resolve' : 'plan';
  const opts = parseArgs(argv[0] === 'plan' || argv[0] === 'resolve' ? argv.slice(1) : argv);
  const root = repoRoot();

  if (mode === 'resolve') {
    if (!opts.target) fail('resolve needs the pick-list folder (or its picklist.md / picklist.json)');
    const found = locatePlan(resolvePath(opts.target));
    const plan = JSON.parse(readFileSync(found.js, 'utf8'));
    const { picks, bad } = parseTicks(readFileSync(found.md, 'utf8'));
    const out = resolveCommands(plan, picks);

    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ picklist: relPath(root, found.dir), ...out, malformed: bad }, null, 2)}\n`);
      // Same exit contract as the human form: 3 means "nothing was ticked", so a caller does not
      // have to inspect the payload to learn there is nothing to run.
      if (!out.chosen.length) process.exit(3);
      return;
    }

    if (!out.chosen.length) {
      process.stdout.write(`No rows ticked in ${relPath(root, found.md)} — nothing to export.\n`);
      if (bad.length) process.stdout.write(`Malformed checkbox(es), only "[ ]" and "[x]" are read:\n  ${bad.join('\n  ')}\n`);
      process.exit(3);
    }

    process.stdout.write(`Picked ${out.chosen.length} row(s) from ${relPath(root, found.md)}:\n`);
    for (const row of out.chosen) process.stdout.write(`  ${row.skill} -> ${row.destination} (${row.status})\n`);
    if (out.unknown.length) {
      process.stdout.write('\nNot in this pick list (ignored):\n');
      for (const p of out.unknown) process.stdout.write(`  ${p.skill} -> ${p.destination}\n`);
    }
    if (out.warnings.length) {
      process.stdout.write('\nBefore exporting:\n');
      for (const w of out.warnings) process.stdout.write(`  ! ${w}\n`);
    }
    process.stdout.write('\nRun the dry-run FIRST and read what the closure pulled in:\n\n');
    for (const c of out.commands) process.stdout.write(`  ${c.dry_run}\n`);
    process.stdout.write('\nThen, once the plan reads right:\n\n');
    for (const c of out.commands) process.stdout.write(`  ${c.apply}\n`);
    process.stdout.write('\nAfterwards re-run `node bin/sidekicks skill destinations --json` — every picked row must read in-sync.\n');
    return;
  }

  const stamp = stamps();
  const folder = opts.stamp || stamp.folder;
  const plan = buildPlan(root, { ...opts, stampIso: stamp.iso });

  const outBase = opts.out
    ? resolvePath(opts.out)
    : runBase(root, opts.workItem);
  const outDir = join(outBase, `export-review-${folder}`);
  const written = writePlan(root, plan, outDir);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...plan, written: { md: relPath(root, written.md), json: relPath(root, written.js) } }, null, 2)}\n`);
  } else {
    process.stdout.write(`Pick list: ${relPath(root, written.md)}\n`);
    process.stdout.write(`  re-export candidates : ${plan.reexport.length}\n`);
    process.stdout.write(`  never published      : ${plan.undecided.length}\n`);
    process.stdout.write(`  suppressed           : ${plan.suppressed.length}\n`);
    process.stdout.write(`  not candidates       : ${plan.notes.length}\n`);
    for (const row of plan.reexport) {
      const flags = [row.dirty ? 'UNCOMMITTED' : null, row.version_delta === 'UNCHANGED' ? 'VERSION UNCHANGED' : null, row.extra.length ? `${row.extra.length} left behind` : null].filter(Boolean);
      process.stdout.write(`  stale: ${row.skill} -> ${row.destination} (v${row.version_delta})${flags.length ? ` [${flags.join(', ')}]` : ''}\n`);
    }
  }

  if (!plan.reexport.length && !plan.undecided.length) process.exit(3);
}

main();
