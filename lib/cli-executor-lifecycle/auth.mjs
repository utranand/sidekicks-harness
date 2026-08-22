import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { parseFlags } from './_shared.mjs';
import { runSkillPython } from './_python.mjs';

export async function run(ctx, args) {
  const action = args.name;
  const name = args.rest?.[0] || (action === 'status' ? 'all' : undefined);
  const flags = parseFlags(ctx.argv, ['interactive', 'refresh-capabilities', 'json']);
  if (!['status', 'renew'].includes(action) || !name) throw new SidekicksError('cli-executor auth: use status [<name>|all] or renew <name> [--interactive]', EXIT_VALIDATION);
  const result = runSkillPython(ctx.repoRoot, 'auth.py', ['--root', ctx.repoRoot, action, name, ...(flags.interactive ? ['--interactive'] : [])]);
  if (result.status !== 0) throw new SidekicksError(`cli-executor auth ${action} failed: ${result.stderr.trim()}`, EXIT_VALIDATION);
  const payload = JSON.parse(result.stdout);
  if (flags['refresh-capabilities'] && action === 'renew' && payload.outcome === 'renewed') {
    // Candidate only: refresh is explicitly read-only and never applies a selection or snapshot.
    const scan = runSkillPython(ctx.repoRoot, 'capabilities.py', ['--root', ctx.repoRoot, name]);
    payload.capability_candidate = scan.status === 0 ? JSON.parse(scan.stdout) : { diagnostics: [{ executor: name, message: 'refresh unavailable' }] };
  }
  return { stdout: flags.json ? JSON.stringify(payload, null, 2) + '\n' : JSON.stringify(payload) + '\n', exitCode: EXIT_OK };
}
