#!/usr/bin/env node
// skill-repo-not-carried.mjs
//
// Turns the `outside{}` block of a `sidekicks skill export --json` report into a durable,
// committed markdown file at the destination repo root — so the things that do NOT travel with
// an export (framework files, framework hooks, host paths, external binaries) survive after the
// terminal that ran the export closes, for whoever installs the exported skills later. The file
// this writes (NOT-CARRIED.md) IS committed to the destination — this script is what regenerates
// it, so it is tracked here rather than left as scratch tooling.
//
// Built for AAP-113 (aap-113-skill-repo-sync) task t12, step 7 of
// inputs/export-public.sequence.yaml — run right after the REAL (non-dry-run) export, against
// that run's own saved --json report (same file shape as the --dry-run report; the dry-run's
// `outside{}` and the real run's are the same closure computation, but this step reads the REAL
// run's report so the file records what a real export actually produced).
//
// Usage:
//   node .agents/skills/sk-skill-manager/scripts/skill-repo-not-carried.mjs \
//     --report <export-report.json> --out <destination-repo-root> [--source-commit <sha>] \
//     [--append <file>]...
//
// Reads:
//   <report>          a `sidekicks skill export --json` report (must have dry_run: false)
//   <append-file>...  each --append file is appended VERBATIM after the generated rollup. Pass
//                     assets/not-carried-withholding.md on every public fill — without it the
//                     addendum must be hand-appended and the next regeneration silently drops it.
// Writes:
//   <out>/NOT-CARRIED.md
//
// Marked-region contract: none — this script REPLACES the whole file each run rather than writing
// between markers (unlike the two README generators alongside it), so "safe to overwrite" is
// stated directly in the file's own closing section.
//
// Zero third-party dependencies — node:fs / node:path only. No machine-absolute path is ever
// baked into the OUTPUT file: destination paths are the caller's argument, and every framework
// file / hook id / binary name recorded is itself a repo-relative path or a bare name.

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const opts = { report: null, out: null, sourceCommit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report') opts.report = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--source-commit') opts.sourceCommit = argv[++i];
    // --append <file>: a WITHHOLDING addendum appended verbatim after the generated rollup.
    // Repeatable. This exists because the rollup is derived from the export report, but a
    // file DELIBERATELY not published (e.g. a git-ignored machine-local cache a skill declares
    // as a framework file) is a decision, not a fact the report carries. Without this the
    // addendum had to be hand-appended after the script ran, which meant the next regeneration
    // silently dropped it — the exact durability trap this script was moved here to escape.
    else if (argv[i] === '--append') (opts.append ||= []).push(argv[++i]);
    else if (argv[i] === '-h' || argv[i] === '--help') opts.help = true;
  }
  return opts;
}

function bulletList(items, none) {
  if (!items.length) return [`- ${none}`];
  return items.map((i) => `- \`${i}\``);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.report || !opts.out) {
    process.stdout.write('Usage: node render-not-carried.mjs --report <export-report.json> --out <destination-repo-root>\n');
    process.exitCode = opts.help ? 0 : 2;
    return;
  }
  if (!fs.existsSync(opts.report)) {
    process.stderr.write(`error: report not found at ${opts.report}\n`);
    process.exitCode = 2;
    return;
  }
  const report = JSON.parse(fs.readFileSync(opts.report, 'utf8'));
  if (report.dry_run) {
    process.stderr.write(
      `error: ${opts.report} is a --dry-run report (dry_run: true) — this file must record what a `
      + 'REAL export actually wrote, not a dry-run preview. Re-run the export step 5 first.\n',
    );
    process.exitCode = 2;
    return;
  }
  const outside = report.outside || { framework_files: [], framework_hooks: [], host_paths: [], binaries: [] };

  const lines = [];
  // The JSON report object itself carries no source_commit field (that lands in catalog.yaml /
  // origin.yaml at write time, not in the stdout report) — the caller passes it explicitly, since
  // the sequence step already asserted it against the worktree HEAD before exporting.
  const sourceCommit = opts.sourceCommit || 'unknown — pass --source-commit';

  lines.push('# NOT-CARRIED.md — what this export intentionally left behind');
  lines.push('');
  lines.push(
    `Generated from a real (non-dry-run) \`sidekicks skill export --json\` run: `
    + `${report.carried.length} skill(s) carried, source_commit \`${sourceCommit}\`.`,
  );
  lines.push('');
  lines.push(
    'None of this is missing by accident. Every skill folder is self-contained (its own '
    + '`skill.manifest.yaml` bundle{}), but five kinds of edge are declared as `requires.*` rather '
    + 'than copied in, because each is the DESTINATION repo\'s own decision to make, not something '
    + 'an export can apply blind. See LAYOUT.md section 5 for the full contract.',
  );
  lines.push('');

  // A WITHHELD SKILL is the sixth thing left behind, and the only one that is a whole skill rather
  // than an edge. It is a sibling a carried skill declares, that the export reached through
  // --with-deps and refused to publish because the skill's own skill.yaml says `skill_repo: none`
  // (vendored third-party work) or pins it to a different destination. Recorded here because a
  // reader of the destination sees the dependency declared and nothing explaining the gap.
  const withheld = Array.isArray(report.withheld) ? report.withheld : [];
  if (withheld.length) {
    lines.push('## Skills withheld from this repository (`skill_repo:`)');
    lines.push('');
    lines.push(
      'Declared siblings of carried skills that this export deliberately did NOT publish. Each one '
      + 'says so in its own `skill.yaml`. A skill that depends on one still works without it, minus '
      + 'the step that hands off to it.',
    );
    lines.push('');
    for (const w of withheld) lines.push(`- \`${w.skill}\` — ${w.why || w.intent}`);
    lines.push('');
  }
  lines.push('## Framework files (`requires.framework_files`)');
  lines.push('');
  lines.push(
    'Repo-root files a carried skill reads or runs, at the SOURCE repo path shown. A reference '
    + 'copy of each ships to `meta/<skill>/framework/<path>` (never auto-applied) — reconcile by '
    + 'hand if the destination needs the behaviour these provide.',
  );
  lines.push('');
  lines.push(...bulletList(outside.framework_files, 'none carried by this export'));
  lines.push('');
  lines.push('## Framework hooks (`requires.framework_hooks`)');
  lines.push('');
  lines.push(
    'A hook is TWO things: its body (shipped to `meta/<skill>/framework/` as reference, same as a '
    + 'framework file) AND its wiring — the hook must be registered in FOUR per-CLI config files '
    + 'before it fires anywhere: `.claude/settings.json`, `.codex/config.toml`, '
    + '`.gemini/settings.json`, and `.agent/settings.json`. Copying the body alone leaves the hook '
    + 'silently inert.',
  );
  lines.push('');
  lines.push(...bulletList(outside.framework_hooks, 'none carried by this export'));
  lines.push('');
  lines.push('## Host paths (`requires.host_paths`)');
  lines.push('');
  lines.push('Something expected to exist on the machine running the skill, not in any repo.');
  lines.push('');
  lines.push(...bulletList(outside.host_paths, 'none carried by this export'));
  lines.push('');
  lines.push('## External binaries (`requires.binaries`)');
  lines.push('');
  lines.push('A command the skill shells out to; install it on the host, it is never vendored.');
  lines.push('');
  lines.push(...bulletList(outside.binaries, 'none carried by this export'));
  lines.push('');
  lines.push(
    '## Where the per-skill detail lives',
    '',
    'This file is the cross-skill ROLLUP. The exact edge list for one skill is in that skill\'s own '
    + '`meta/<skill>/origin.yaml` (`outside_edges:`) and in its `requires.*` sections — read those '
    + 'when reconciling a single skill rather than the whole repo.',
    '',
    'Regenerate this file by re-running this script against a fresh export report; it is safe to '
    + 'overwrite.',
  );

  let text = lines.join('\n') + '\n';
  for (const rel of opts.append || []) {
    if (!fs.existsSync(rel)) {
      process.stderr.write(`render-not-carried: --append file not found: ${rel}\n`);
      process.exitCode = 2;
      return;
    }
    text += fs.readFileSync(rel, 'utf8');
  }
  fs.writeFileSync(path.join(opts.out, 'NOT-CARRIED.md'), text);
  process.stdout.write(
    `render-not-carried: wrote NOT-CARRIED.md — ${outside.framework_files.length} framework file(s), `
    + `${outside.framework_hooks.length} hook(s), ${outside.host_paths.length} host path(s), `
    + `${outside.binaries.length} binarie(s)\n`,
  );
}

main();
