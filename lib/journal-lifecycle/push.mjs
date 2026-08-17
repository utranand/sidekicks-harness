// lib/journal-lifecycle/push.mjs
// `sidekicks journal push [--force] [--json]`
//
// Ship the journal store to its remote. This is the EXPLICIT boundary — the
// other one is `journal diary write`. Under `git.push: "boundary"` the per-entry
// writes only commit; without one of these two calls the store accumulates
// locally exactly the way it did before this subsystem existed (the audit found
// it sitting 2 commits ahead of origin indefinitely).
//
// A push is an outward network write. It happens because the user configured
// `git.push` — `--force` here is not a git force-push, it only overrides a
// `push: "never"` policy for this one invocation.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { hasUnpushedCommits } from '../git-delegation/git.mjs';
import {
  requireJournalConfig,
  parseMemoryFlags,
  storeGitRoot,
  maybePush,
} from './_shared.mjs';

export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json', 'force']);
  const cfg = requireJournalConfig(repoRoot, 'journal push');

  const cwd = storeGitRoot(cfg);
  if (!cwd) {
    const msg = 'journal push: the store is not a git repository — nothing to push';
    return { stdout: flags.json ? JSON.stringify({ pushed: false, reason: 'not-a-repo' }, null, 2) + '\n' : msg + '\n', exitCode: EXIT_OK };
  }

  if (cfg.git.push === 'never' && !flags.force) {
    const ahead = hasUnpushedCommits(cwd);
    const msg = `journal push: policy is push:never — ${ahead ? 'there ARE unpushed commits; ' : ''}` +
      'pass --force to push this once, or run `sidekicks config set agent_memory.git.push boundary` (or "always")';
    return { stdout: flags.json ? JSON.stringify({ pushed: false, reason: 'policy-never', ahead }, null, 2) + '\n' : msg + '\n', exitCode: EXIT_OK };
  }

  if (!hasUnpushedCommits(cwd)) {
    const msg = `journal push: already up to date with ${cfg.git.remote}/${cfg.git.branch}`;
    return { stdout: flags.json ? JSON.stringify({ pushed: false, reason: 'up-to-date' }, null, 2) + '\n' : msg + '\n', exitCode: EXIT_OK };
  }

  // `boundary: true` satisfies every policy except "never", which --force above
  // has already resolved — so this call is the one place both paths converge.
  const forced = { ...cfg, git: { ...cfg.git, push: cfg.git.push === 'never' ? 'always' : cfg.git.push } };
  const { pushed, note } = maybePush(forced, { boundary: true });

  if (flags.json) {
    return { stdout: JSON.stringify({ pushed, remote: cfg.git.remote, branch: cfg.git.branch, note: note.trim() }, null, 2) + '\n', exitCode: EXIT_OK };
  }
  return {
    stdout: pushed
      ? `journal push: ${cfg.git.remote}/${cfg.git.branch} updated\n`
      : `journal push: nothing pushed${note}\n`,
    exitCode: EXIT_OK,
  };
}
