// lib/goal-lifecycle/report.mjs
// `sidekicks goal report <run-id> [--json]` — the evidence report.
//
// READ-ONLY, AND AVAILABLE AT ANY PHASE. A report on an unfinished run is often the most useful one:
// it says what was observed, what is still claimed rather than checked, and what is unresolved. So
// this verb takes no lease and refuses no phase — a run that is blocked is exactly when someone wants
// to read about it.
//
// It writes the rendered markdown into the run folder as well as printing it, because the report is
// itself an artifact of the run and should survive the terminal it was printed in.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { writeAtomic } from '../fs-safety/fsx.mjs';
import { EXIT_OK, EXIT_USAGE, SidekicksError } from '../sk-cli/errors.mjs';
import { canonicalEnvelope } from './schema.mjs';
import { RELATIVE, goalPositionals, loadRun, parseGoalFlags } from './commands.mjs';
import { goalPaths, mkdirp, readJsonIfPresent } from './store.mjs';
import { finalPaths } from './final-verify.mjs';
import { buildReportModel, renderReport } from './report-core.mjs';

const BOOLEANS = ['json'];

/**
 * Run `goal report`.
 *
 * @param {{repoRoot: string, argv: string[], flags: object, log: Function}} ctx
 * @param {object} _args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, _args) {
  const flags = parseGoalFlags(ctx.argv, BOOLEANS);
  const runId = goalPositionals(ctx.argv, BOOLEANS)[0];
  if (!runId) {
    throw new SidekicksError('goal report: usage: goal report <run-id> [--json]', EXIT_USAGE);
  }

  const { runDir, state } = loadRun(ctx.repoRoot, runId);
  const paths = goalPaths(runDir);
  const final = finalPaths(runDir);

  const model = buildReportModel({
    state,
    plan: readJsonIfPresent(paths.plan) ?? { nodes: [] },
    envelope: canonicalEnvelope(readJsonIfPresent(paths.envelope) ?? {}),
    goal: readJsonIfPresent(paths.goal),
    verdict: readJsonIfPresent(final.verdict),
    exitCheck: readJsonIfPresent(final.exitCheck),
    contest: state.planning?.contest ?? null,
    runDirRel: RELATIVE(ctx.repoRoot, runDir),
  });

  if (flags.json === true) {
    return { stdout: `${JSON.stringify(model, null, 2)}\n`, exitCode: EXIT_OK };
  }

  const markdown = renderReport(model);
  // The report is an artifact of the run, not just terminal output.
  mkdirp(final.dir);
  writeAtomic(final.report, markdown);
  return { stdout: markdown, exitCode: EXIT_OK };
}
