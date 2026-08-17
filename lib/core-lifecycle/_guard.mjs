// lib/core-lifecycle/_guard.mjs
// The read-only guard on a mounted framework core (AAP-110): a workspace consumes the core, it never
// contributes back through this checkout.
//
// THREE LAYERS, because each one alone has a hole:
//
//   1. `remote set-url --push origin no-push://…` — `git push` inside the core cannot resolve a
//      transport. Fetch keeps working, so `core update` is unaffected. Hole: an explicit
//      `git push <url> HEAD:main` names its own remote and bypasses this.
//   2. `push.default = nothing` — a bare `git push` with no refspec refuses. Hole: an explicit
//      refspec bypasses it.
//   3. a `pre-push` hook in the core's real git dir — runs for EVERY push regardless of remote or
//      refspec, and exits 1. This is the layer that actually closes the door.
//
// HONEST SCOPE: this prevents accidents, not a determined operator. All three layers are local git
// state, and anyone with write access to the checkout can undo them (`--no-verify` alone defeats
// layer 3). Real write protection lives on the remote — branch protection on the framework repo.
// The docs say this plainly rather than implying more.
//
// A submodule's `.git` is a FILE containing `gitdir: …`, so the hooks directory is resolved through
// `git rev-parse --absolute-git-dir` rather than assumed to be `<core>/.git/hooks`.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import * as git from '../git-delegation/git.mjs';
import { NO_PUSH_URL, pushUrlOf } from './_shared.mjs';

/** Marker line inside the generated hook, used to recognize our own hook on re-arm. */
const HOOK_SIGNATURE = 'sidekicks-core-read-only-guard';

/**
 * Quote an arbitrary string as a single POSIX shell literal.
 *
 * `'` is the only character with meaning inside single quotes, and the standard escape is to close
 * the quote, emit a backslash-escaped quote, and reopen — `'\''`. Control characters are stripped
 * rather than escaped: a newline would end the generated line and start a NEW shell command, and
 * nothing legitimate in a remote URL contains one.
 *
 * @param {string} s
 * @returns {string} the text wrapped in single quotes, safe to paste anywhere a word is expected
 */
export function shQuote(s) {
  const clean = String(s).replace(/[\u0000-\u001f\u007f]/g, '');
  return `'${clean.replace(/'/g, "'\\''")}'`;
}

/**
 * Strip a string down to something that cannot alter a generated shell COMMENT.
 *
 * A comment runs to end of line, so a newline is the whole attack: everything after it becomes
 * executable script. Backslash and backtick go too, so the line reads literally in any viewer.
 *
 * @param {string} s
 * @returns {string}
 */
function commentSafe(s) {
  return String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[`\\]/g, '');
}

/**
 * The pre-push hook body. POSIX sh — git runs hooks through sh on Windows too (Git for Windows
 * ships one), which is why this is not a .cmd.
 *
 * THE URL IS DATA, NOT SOURCE. It arrives from `git remote get-url origin`, which reads
 * `.gitmodules` / the remote config — text a repository can carry and a workspace owner may never
 * have looked at. Interpolating it raw into an `echo "…"` (which is what this did) makes a URL
 * containing `$(…)` or a backtick execute the moment anyone runs `git push` from the core. It is now
 * emitted as a single-quoted shell literal, and the copy in the header comment is stripped to one
 * inert line.
 *
 * @param {string} fetchUrl - the real upstream, shown in the refusal message so the operator knows
 *                            where a contribution actually goes.
 * @returns {string}
 */
export function hookBody(fetchUrl) {
  const upstream = fetchUrl || 'the framework repository';
  return `#!/bin/sh
# ${HOOK_SIGNATURE}
#
# Installed by \`sidekicks core init\`. This checkout is a MOUNTED FRAMEWORK CORE — a read-only
# consumer copy of the Sidekicks framework, pinned by the workspace above it. Work done here would
# be lost by the next \`sidekicks core update\`, so pushing from it is refused.
#
# To change the framework, work in the framework source repository and release a new ref:
#   ${commentSafe(upstream)}
# Then point this workspace at it:
#   sidekicks core update --ref <tag>
#
# This hook is local git state, not a security boundary — \`--no-verify\` bypasses it. Enforce the
# real rule with branch protection on the remote.

sidekicks_upstream=${shQuote(upstream)}

echo "sidekicks: refusing to push from a mounted framework core (.sidekicks-core)." >&2
echo "sidekicks: the core is read-only here — change the framework upstream instead:" >&2
printf 'sidekicks:   %s\\n' "$sidekicks_upstream" >&2
exit 1
`;
}

/**
 * Arm all three guard layers on the core checkout. Idempotent.
 *
 * Best-effort per layer: a layer that cannot be applied (no git, an exotic remote) is reported in the
 * result rather than aborting the whole mount — `core init` must still finish a usable workspace, and
 * `core doctor` is what reports an unarmed guard.
 *
 * @param {string} coreDir - absolute path of the core checkout
 * @returns {{pushUrl: boolean, pushDefault: boolean, hook: boolean, hookPath: string|null,
 *            errors: string[]}}
 */
export function armPushGuard(coreDir) {
  const errors = [];
  const fetchUrl = git.remoteUrl(coreDir, 'origin');

  let pushUrl = false;
  try {
    git.setPushUrl(coreDir, 'origin', NO_PUSH_URL);
    pushUrl = pushUrlOf(coreDir) === NO_PUSH_URL;
  } catch (err) {
    errors.push(`push url: ${err.message}`);
  }

  let pushDefault = false;
  try {
    git.setLocalConfig(coreDir, 'push.default', 'nothing');
    pushDefault = git.getLocalConfig(coreDir, 'push.default') === 'nothing';
  } catch (err) {
    errors.push(`push.default: ${err.message}`);
  }

  let hook = false;
  let hookPath = null;
  const dir = git.gitDir(coreDir);
  if (!dir) {
    errors.push('pre-push hook: could not resolve the core\'s git dir');
  } else {
    hookPath = join(dir, 'hooks', 'pre-push');
    try {
      mkdirp(join(dir, 'hooks'));
      writeAtomic(hookPath, hookBody(fetchUrl));
      if (process.platform !== 'win32') chmodSync(hookPath, 0o755);
      hook = true;
    } catch (err) {
      errors.push(`pre-push hook: ${err.message}`);
    }
  }

  return { pushUrl, pushDefault, hook, hookPath, errors };
}

/**
 * Report which guard layers are currently in place. Read-only.
 *
 * @param {string} coreDir
 * @returns {{pushUrl: boolean, pushDefault: boolean, hook: boolean, hookPath: string|null,
 *            armed: boolean}}
 */
export function inspectPushGuard(coreDir) {
  const pushUrl = pushUrlOf(coreDir) === NO_PUSH_URL;
  const pushDefault = git.getLocalConfig(coreDir, 'push.default') === 'nothing';

  const dir = git.gitDir(coreDir);
  const hookPath = dir ? join(dir, 'hooks', 'pre-push') : null;
  let hook = false;
  if (hookPath && existsSync(hookPath)) {
    try {
      hook = readFileSync(hookPath, 'utf8').includes(HOOK_SIGNATURE);
    } catch { hook = false; }
  }

  return { pushUrl, pushDefault, hook, hookPath, armed: pushUrl && pushDefault && hook };
}
