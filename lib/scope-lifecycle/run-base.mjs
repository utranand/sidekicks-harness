// lib/scope-lifecycle/run-base.mjs
// `scope run-base <skill-id> [<work-item>] [--bare] [--json]` — print the absolute v2 RUNBASE
// for a skill in the active scope (runs layout v2: work-item-first, per-project bases).
//
//   sidekicks scope run-base sk-jira-ready-gate DSHPH2-5398
//     → <repo>/projects/<p>/artifacts/runs/DSHPH2-5398/jira-ready-gate
//   sidekicks scope run-base sk-get-things-done aap-113-sync --bare
//     → <repo>/projects/<p>/artifacts/runs/aap-113-sync        (the run IS the work item)
//   sidekicks scope run-base sk-database-analyst
//     → <repo>/projects/<p>/artifacts/runs/_adhoc/sk-database-analyst
//
// The work item is POSITIONAL (the dispatcher parses boolean flags only). Print-only —
// never creates the directory; skills `mkdir -p` themselves. `--json` adds the service
// association (service rides in run metadata, never in the path). Pre-v2 runs stay frozen
// at `<artifacts-base>/artifacts/runs/<skill-id>/` — read targets only.
//
// Zero npm dependencies. node imports + relative lib imports only.

import { EXIT_OK, SidekicksError, EXIT_USAGE } from '../sk-cli/errors.mjs';
import { read } from '../settings-store/settings.mjs';
import { resolveRunBase } from '../active-scope/run-base.mjs';

/**
 * Run `scope run-base`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object, log: (msg: string) => void }} ctx
 * @param {{ name?: string, rest: string[], flags: object }} args
 *   - name: <skill-id> (required); rest[0]: optional <work-item> slug.
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} EXIT_USAGE on a missing skill id; EXIT_VALIDATION on bad slugs or
 *   --bare without a work item; EXIT_NOT_FOUND when the active service dir is absent.
 */
export async function run(ctx, args) {
  const skillId = args.name;
  if (!skillId) {
    throw new SidekicksError(
      'scope run-base: usage: scope run-base <skill-id> [<work-item>] [--bare] [--json]',
      EXIT_USAGE
    );
  }
  const workItem = (args.rest && args.rest[0]) || null;
  const bare = Boolean(args.flags && args.flags.bare);

  // read() returns {} on missing file; throws EXIT_VALIDATION on corrupt JSON.
  const settings = read(ctx.repoRoot);
  const r = resolveRunBase(settings, ctx.repoRoot, { skillId, workItem, bare });

  if (args.flags && args.flags.json) {
    const payload = {
      run_base: r.runBase,
      runs_root: r.runsRoot,
      facet: r.facet,
      skill: skillId,
      work_item: r.workItem,
      project: r.projectName,
      service: r.serviceName,
      adhoc: r.adhoc,
    };
    return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: EXIT_OK };
  }

  return { stdout: r.runBase + '\n', exitCode: EXIT_OK };
}
