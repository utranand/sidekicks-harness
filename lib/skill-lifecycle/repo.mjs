// lib/skill-lifecycle/repo.mjs
// `sidekicks skill repo init <path> [--private] [--name <n>] [--remote <url>] [--json]`
//
// Scaffold a skills REPOSITORY — the hand-authored half that `skill export` never writes.
//
// WHY THIS IS A VERB AND NOT A RUNBOOK. `skill export` writes exactly three things into a
// destination: the skill folders, `meta/<name>/origin.yaml`, and a wholesale-regenerated
// `catalog.yaml`. Everything else a skills repo needs — `.gitignore`, `LICENSE`, `LAYOUT.md`,
// `README.md`, and one `categories/<family>/README.md` per family — is authored, and the two README
// generators FILL a scaffold rather than create one: the public one throws without a `## Categories`
// heading to wrap and prints `skip:` for a family whose README is absent, and the private one used to
// die with ENOENT on the same. So `git init` + `skill export` produced a tree no generator would
// touch, and the gap was closed by hand every time. A verb is the only form of "reproducible" that is
// testable, and Rule 1 puts structural writes behind the CLI.
//
// IDEMPOTENT, AND THAT IS THE WHOLE CONTRACT. Every file is written only when ABSENT. The generators
// rewrite strictly between their marked regions, so the prose around them is hand-editable and must
// survive a re-run; a verb that re-templated an existing file would silently discard it. The report
// says `created` or `kept` per path so a re-run is legible rather than merely quiet.
//
// IT NEVER WRITES catalog.yaml. An empty repo with a stale catalog is worse than one with no catalog:
// `skill destinations` would compare against rows describing nothing, and the public generator
// already refuses a zero-row catalog outright. The catalog is export's to write, on the first export.
//
// PUBLIC AND PRIVATE DIFFER BY FLAG, NOT BY TWO FORKED COPIES. The variants share every template
// except the four things that genuinely differ — the licence, the two documents' private-only
// sections, and `NOT-CARRIED.md` (public, a rollup of what an export left behind) versus
// `meta/export-notes.md` (private). Before this the two published repos had drifted into different
// README region topologies, which is what a second forked template set does to you.
//
// THE PATH IS THE AUTHORIZATION. `<path>` is normally outside this repo, so assertWritable() is
// deliberately not called on it — the same treatment `skill export --output` and `sk-inherit
// --target` get, documented in export.mjs. What IS refused is a path resolving inside either tree
// this repo READS its skills from: scaffolding into the source would corrupt it.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { SKILLS_ROOT_SEGMENTS } from '../sk-cli/skill-trees.mjs';
import { isInside } from '../fs-safety/canonical-path.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { parseSkillFlags, positionalArgs } from './_shared.mjs';
import { PUBLISHED_TREES } from './destinations.mjs';

/** The sub-verbs `skill repo` understands. Named so an unknown one is a usage error, not a no-op. */
const SUBVERBS = Object.freeze(['init']);

/**
 * Where the bundled templates live.
 *
 * Resolved from this module's own location the way the skill's scripts already do
 * (`dirname(dirname(fileURLToPath(import.meta.url)))` + `assets`), except that this file sits in
 * `lib/` rather than inside the skill — so the skill directory is reached through
 * `SKILLS_ROOT_SEGMENTS`, which is also what makes it follow the canonical tree if that ever moves
 * again.
 */
function templateDir(repoRoot) {
  return join(repoRoot, ...SKILLS_ROOT_SEGMENTS, 'sk-skill-manager', 'assets', 'repo-templates');
}

/** The publication families, derived from the skill's own categories.yaml — never a hardcoded list. */
export function readFamilies(repoRoot) {
  const abs = join(
    repoRoot, ...SKILLS_ROOT_SEGMENTS, 'sk-skill-manager', 'assets', 'categories.yaml'
  );
  if (!existsSync(abs)) {
    throw new SidekicksError(
      `skill repo init: cannot read the family list — ${relative(repoRoot, abs)} is missing`,
      EXIT_VALIDATION
    );
  }
  const out = [];
  for (const raw of readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const header = line.match(/^([a-z][a-z0-9-]*):\s*$/);
    if (header) out.push(header[1]);
  }
  if (!out.length) {
    throw new SidekicksError(
      `skill repo init: no families found in ${relative(repoRoot, abs)}`,
      EXIT_VALIDATION
    );
  }
  // `framework` first, then alphabetical — the same order skill-repo-readmes-public.mjs renders, so a
  // scaffolded README and a regenerated one do not reorder each other's tables.
  const rest = out.filter((f) => f !== 'framework').sort();
  return out.includes('framework') ? ['framework', ...rest] : rest;
}

/**
 * Fill the template placeholders.
 *
 * Three, all repository IDENTITY rather than content: `{{REPO_NAME}}` this repo, `{{PEER_REPO}}` the
 * counterpart skills repo (the private README links to the public one), `{{CORE_REPO}}` the framework
 * core whose install instructions every generated README points at. Parameterising them is what keeps
 * public and private one template set instead of two that drift.
 */
function fill(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole
  ));
}

/** Read a bundled template, or fail naming the file — a missing template is a broken skill install. */
function template(dir, rel) {
  const abs = join(dir, ...rel.split('/'));
  if (!existsSync(abs)) {
    throw new SidekicksError(
      `skill repo init: bundled template '${rel}' is missing from the skill — `
      + `run 'sidekicks skill heal sk-skill-manager --restore --apply' to put it back`,
      EXIT_VALIDATION
    );
  }
  return readFileSync(abs, 'utf8');
}

/**
 * The family README, composed rather than stored per repo.
 *
 * The blurb comes from `categories.yaml` (one source, shared with both generators and export), the
 * long-form gloss and the fixed Notes body from the bundled per-family template, and the generated
 * regions ship EMPTY but correctly marked. A family with no bundled template still scaffolds — it
 * gets the heading, the blurb and the regions — because a new family must not be blocked on someone
 * writing a paragraph first.
 */
function familyReadme(dir, family, blurb) {
  const rel = `categories/${family}.md`;
  const abs = join(dir, 'categories', `${family}.md`);
  if (existsSync(abs)) return template(dir, rel);
  return [
    `# ${family}`,
    '',
    blurb || '',
    '',
    '## Skills',
    '',
    '<!-- GENERATED from catalog.yaml — do not hand-edit below this line. -->',
    '',
    '_No skills published in this family yet._',
    '',
    '| Skill | Version | Description |',
    '|---|---|---|',
    '',
    '<!-- END GENERATED -->',
    '',
    '## Prerequisites',
    '',
    '<!-- GENERATED prerequisites — do not hand-edit below this line. -->',
    '',
    '<!-- END GENERATED prerequisites -->',
    '',
    '## Notes',
    '',
    'Skill folders live at `../../.agents/skills/<name>/`, never inside this directory — see',
    '[LAYOUT.md](../../LAYOUT.md). This README is a browse view regenerated from `catalog.yaml`; it is',
    'safe to delete and rebuild.',
    '',
  ].join('\n');
}

/** The blurb for each family, from categories.yaml. Absent is not an error here — the README says so. */
function readBlurbs(repoRoot) {
  const abs = join(
    repoRoot, ...SKILLS_ROOT_SEGMENTS, 'sk-skill-manager', 'assets', 'categories.yaml'
  );
  const out = new Map();
  let current = null;
  for (const raw of readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const header = line.match(/^([a-z][a-z0-9-]*):\s*$/);
    if (header) { current = header[1]; continue; }
    const blurb = line.match(/^\s+blurb:\s+'(.*)'\s*$/);
    if (blurb && current) out.set(current, blurb[1].replace(/''/g, "'"));
  }
  return out;
}

/**
 * Refuse a destination that resolves inside a tree this repo reads its own skills from.
 *
 * Both trees, not just `.sidekicks/` — the active tree is `.agents/skills` and holds most of them.
 * Compared through realpath on BOTH sides: on macOS `/tmp` and `/var` are symlinks into `/private`,
 * so a typed path and a resolved one differ as strings while naming the same directory.
 */
function refuseSourceTrees(target, repoRoot) {
  for (const rel of [['.sidekicks'], [...SKILLS_ROOT_SEGMENTS]]) {
    const forbidden = join(repoRoot, ...rel);
    if (!isInside(target, forbidden) && target !== forbidden) continue;
    throw new SidekicksError(
      `skill repo init: <path> must not resolve inside this repo's own ${rel.join('/')}/ `
      + `(${target}) — scaffolding into the tree the exporter reads would corrupt the source`,
      EXIT_VALIDATION
    );
  }
}

/**
 * Run `skill repo <subverb>`.
 *
 * The CLI dispatcher understands `<namespace> <verb>` and hands the rest on, so `repo` is the verb
 * and `init` arrives as `args.name` — the same sub-verb shape `lib/agent-lifecycle/` uses.
 *
 * @param {{repoRoot: string, argv: string[]}} ctx
 * @param {{name?: string, rest?: string[]}} args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, args) {
  const subverb = args && args.name ? String(args.name) : '';
  if (!SUBVERBS.includes(subverb)) {
    throw new SidekicksError(
      `skill repo: unknown sub-verb '${subverb || '(none)'}' — use: ${SUBVERBS.join(' | ')}\n`
      + '  sidekicks skill repo init <path> [--private] [--name <n>] [--remote <url>] [--json]',
      EXIT_USAGE
    );
  }
  return init(ctx);
}

/** `skill repo init <path>` — write the hand-authored half of a skills repository, once. */
async function init(ctx) {
  const flags = parseSkillFlags(ctx.argv, ['private', 'json']);
  // positionalArgs drops the namespace and verb; `init` is the sub-verb, so the path is what follows.
  const positional = positionalArgs(ctx.argv, ['name', 'remote', 'peer']).slice(1);
  if (positional.length !== 1) {
    throw new SidekicksError(
      'skill repo init: exactly one <path> is required\n'
      + '  sidekicks skill repo init <path> [--private] [--name <n>] [--remote <url>] [--json]',
      EXIT_USAGE
    );
  }

  const isPrivate = flags.private === true;
  const target = isAbsolute(positional[0])
    ? resolve(positional[0])
    : resolve(ctx.repoRoot, positional[0]);
  refuseSourceTrees(target, ctx.repoRoot);

  const name = flags.name ? String(flags.name) : target.split(/[\\/]/).filter(Boolean).pop();
  const remote = flags.remote ? String(flags.remote) : '';
  const peer = flags.peer
    ? String(flags.peer)
    : (isPrivate ? 'sidekicks-skills' : 'sidekicks-skills-private');
  const vars = {
    REPO_NAME: name,
    PEER_REPO: peer,
    CORE_REPO: 'sidekicks-harness',
  };

  const dir = templateDir(ctx.repoRoot);
  const families = readFamilies(ctx.repoRoot);
  const blurbs = readBlurbs(ctx.repoRoot);
  const variant = isPrivate ? 'private' : 'public';

  /** @type {Array<{path: string, content: string}>} */
  const planned = [
    { path: '.gitignore', content: template(dir, 'gitignore') },
    { path: 'LICENSE', content: template(dir, `LICENSE.${variant}`) },
    { path: 'LAYOUT.md', content: fill(template(dir, `LAYOUT.${variant}.md`), vars) },
    { path: 'README.md', content: fill(template(dir, `README.${variant}.md`), vars) },
    // The ROOT MARKER. `resolveRepoRoot` finds a repository root by walking up for a `.sidekicks/`,
    // and under layout 2 the skill folders no longer create one — so without this every sidekicks
    // verb run inside the clone walks up out of it. Export writes the same placeholder; both are
    // needed, because a repo is scaffolded before it is ever exported to.
    { path: '.sidekicks/skill-offloaded/.gitkeep', content: '' },
    // `meta/` is written per skill by export. The placeholder keeps the directory in git so the
    // layout is visible in a fresh clone rather than appearing at the first publish.
    { path: 'meta/.gitkeep', content: '' },
  ];

  if (isPrivate) {
    // The private counterpart of NOT-CARRIED.md. Deliberately a different file: NOT-CARRIED.md is
    // GENERATED from an export report by skill-repo-not-carried.mjs, while export-notes.md is prose
    // about what belongs in a private repo, which no report can derive.
    planned.push({
      path: 'meta/export-notes.md',
      content: '# Export notes\n\n'
        + 'What this repository deliberately carries, and what an export left behind. Hand-authored:\n'
        + 'unlike the public repo\'s `NOT-CARRIED.md` this is not generated from an export report,\n'
        + 'because the reasons a skill is private are not derivable from one.\n',
    });
  } else {
    // Generated by skill-repo-not-carried.mjs from a real (non-dry-run) `skill export --json` run, so
    // the scaffold only reserves the file and says where its content comes from.
    planned.push({
      path: 'NOT-CARRIED.md',
      content: '# NOT-CARRIED.md — what this export intentionally left behind\n\n'
        + '_Generated._ Run `skill-repo-not-carried.mjs --report <export-report.json> --out .` after an\n'
        + 'export to replace this placeholder with the real cross-skill rollup.\n',
    });
  }

  for (const family of families) {
    planned.push({
      path: `categories/${family}/README.md`,
      content: familyReadme(dir, family, blurbs.get(family)),
    });
  }

  const created = [];
  const kept = [];
  for (const item of planned) {
    const abs = join(target, ...item.path.split('/'));
    if (existsSync(abs)) { kept.push(item.path); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeAtomic(abs, item.content);
    created.push(item.path);
  }

  const report = {
    ok: true,
    path: target,
    name,
    remote,
    private: isPrivate,
    families,
    created,
    kept,
    // Stated rather than implied: the two things a caller is most likely to assume this verb did.
    catalog_written: false,
    git_initialised: false,
  };

  if (flags.json) {
    return { stdout: JSON.stringify(report, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return { stdout: render(report) + '\n', exitCode: EXIT_OK };
}

/** Human rendering. Outcome first, then what changed, then the two things it did NOT do. */
function render(r) {
  const out = [
    `skill repo init: ${r.private ? 'private' : 'public'} skills repository '${r.name}'`,
    `  path      ${r.path}`,
    `  families  ${r.families.length} (${r.families.join(', ')})`,
    `  created   ${r.created.length} file(s)`,
  ];
  for (const p of r.created) out.push(`              + ${p}`);
  if (r.kept.length) {
    out.push(`  kept      ${r.kept.length} existing file(s) — hand-edited prose is never re-templated`);
    for (const p of r.kept) out.push(`              = ${p}`);
  }
  const published = Object.values(PUBLISHED_TREES).join(', ');
  out.push(
    '',
    `  NOT written: catalog.yaml — 'skill export' regenerates it wholesale, and an empty repo with a`,
    '               stale catalog is worse than one with none.',
    '  NOT run:     git init — creating and pushing a repository is outward-facing and yours.',
    '',
    `  Next: 'skill export --destination <name>' fills ${published};`,
    "        then the README generators fill the marked regions.",
  );
  return out.join('\n');
}
