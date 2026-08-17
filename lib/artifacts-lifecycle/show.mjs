// lib/artifacts-lifecycle/show.mjs
// `artifacts show <slug> [--skill <s>] [--json]`
//
// Prints one run's manifest + resolved pointer paths, and — for a parent run — renders
// its subtasks[] as an indented tree, the parent goal, and the exit_check verdict.
//
// Deterministic disambiguation (no interactive prompt — readers are headless): a slug
// may map to runs under several skills. If ambiguous and --skill is absent, --json
// returns ALL matches (array) and the human table lists them and exits non-zero asking
// for --skill; with --skill it returns the one.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { join } from 'node:path';
import { SidekicksError, EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  resolveStores,
  scanRuns,
  readRun,
  parseArtifactFlags,
  computeExitable,
  fromRepoRel,
} from './_shared.mjs';

/**
 * Run `artifacts show <slug>`.
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on all failure paths.
 */
export async function run(ctx, args) {
  const slug = args.name;
  if (!slug) {
    throw new SidekicksError('artifacts show: usage: artifacts show <slug> [--skill <s>] [--json]', EXIT_USAGE);
  }
  const flags = parseArtifactFlags(ctx.argv, ['json']);
  const ad = flags.artifacts_dir || flags['artifacts-dir'];
  const stores = resolveStores(ctx, ad ? { artifacts_dir: String(ad) } : {});

  const scan = scanRuns(stores.scanRoots);
  let matches = scan.filter((r) => r.slug === slug);
  if (flags.skill) matches = matches.filter((r) => r.skill === String(flags.skill));

  if (matches.length === 0) {
    throw new SidekicksError(
      `artifacts show: no run with slug '${slug}'${flags.skill ? ` under skill '${flags.skill}'` : ''}`,
      EXIT_NOT_FOUND
    );
  }

  // Re-read the live run.json for each match (so we get full subtasks, not the index header).
  const full = matches.map((m) => {
    const live = readRun(m.runDir);
    return live ? { ...live, runDir: m.runDir, skill: m.skill, slug: m.slug, inferred: false } : m;
  });

  // Ambiguous and no --skill → all matches (json) / non-zero ask (human).
  if (full.length > 1 && !flags.skill) {
    if (flags.json) {
      return { stdout: JSON.stringify(full, null, 2) + '\n', exitCode: EXIT_OK };
    }
    const lines = [`artifacts show: slug '${slug}' is ambiguous across ${full.length} skills — pass --skill <s>:`, ''];
    for (const r of full) lines.push(`  ${r.skill}/${r.slug} — ${r.title ?? ''}`);
    throw new SidekicksError(lines.join('\n'), EXIT_VALIDATION);
  }

  const r = full[0];
  if (flags.json) {
    return { stdout: JSON.stringify(r, null, 2) + '\n', exitCode: EXIT_OK };
  }

  return { stdout: renderHuman(r, stores) + '\n', exitCode: EXIT_OK };
}

function renderHuman(r, stores) {
  const lines = [];
  lines.push(`Run: ${r.skill}/${r.slug}`);
  lines.push(`  status:     ${r.status ?? 'unknown'}${r.inferred ? ' (inferred)' : ''}`);
  if (r.title) lines.push(`  title:      ${r.title}`);
  if (r.goal) lines.push(`  goal:       ${r.goal}`);
  if (r.jira_card) lines.push(`  jira_card:  ${r.jira_card}`);
  if (r.created_at) lines.push(`  created_at: ${r.created_at}`);
  if (r.updated_at) lines.push(`  updated_at: ${r.updated_at}`);
  if (r.max_attempts != null) lines.push(`  max_attempts: ${r.max_attempts}`);

  // Resolved pointer paths.
  if (r.pointer && Object.keys(r.pointer).length) {
    lines.push('  pointers:');
    for (const [name, rel] of Object.entries(r.pointer)) {
      lines.push(`    ${name}: ${rel}  → ${fromRepoRel(r.sourceRepoRoot || stores.projectWorkdir, rel)}`);
    }
  }

  // Subtask tree (parent run only).
  if (Array.isArray(r.subtasks) && r.subtasks.length) {
    lines.push('  subtasks:');
    for (const st of r.subtasks) {
      const v = st.verdict
        ? (st.verdict.result === 'pass' ? '✓verified' : st.verdict.result === 'fail' ? '✗fail' : '·')
        : '·';
      lines.push(`    [${st.status ?? 'unset'} ${v}] ${st.key} — ${st.title ?? ''}  (${st.updated_at ?? ''})`);
      if (st.reason) lines.push(`        reason: ${st.reason}`);
      if (st.expands_from) lines.push(`        ↳ expands ${st.expands_from}`);
      if (Array.isArray(st.expanded_into) && st.expanded_into.length) {
        lines.push(`        expanded_into: ${st.expanded_into.join(', ')}`);
      }
      if (st.attempts != null) lines.push(`        attempts: ${st.attempts}`);
    }
  }

  // exit_check verdict.
  const { exitable, reasons } = computeExitable(r);
  if (r.exit_check || Array.isArray(r.subtasks)) {
    lines.push(`  exit_check: exitable=${exitable}`);
    const ec = r.exit_check || {};
    if (Array.isArray(ec.remaining) && ec.remaining.length) lines.push(`    remaining: ${ec.remaining.join(', ')}`);
    if (Array.isArray(ec.unmet) && ec.unmet.length) lines.push(`    unmet: ${ec.unmet.join(', ')}`);
    if (!exitable && reasons.length) lines.push(`    not exitable: ${reasons.join('; ')}`);
  }

  return lines.join('\n');
}
