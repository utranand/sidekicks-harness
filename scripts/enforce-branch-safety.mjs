#!/usr/bin/env node
// scripts/enforce-branch-safety.mjs
//
// Tool-call hook that GUARDS a shared git working tree — the failure that costs
// uncommitted work when more than one process is live in the same checkout (a second
// agent CLI session, a dev server, a running build, a delegate agent, the user's own
// editor).
//
// Policy (CLAUDE.md → "Protected branches — never implement on them" and
// "Git worktrees"): a work branch is created in a SIBLING WORKTREE, never by moving
// the shared checkout's HEAD or by parking the tree's changes on the stash. Moving
// HEAD under a running process swaps files beneath it; `git stash`, `reset --hard`,
// `restore` and `clean` delete uncommitted work outright.
//
// Two decision strengths, evaluated per git invocation inside the command:
//
//   ASK — a CONCURRENCY RISK only the user can weigh, because only they know what else
//   is live in this checkout. The hook notifies and hands the call to them; approving
//   the prompt is the go-ahead.
//     1.  HEAD move with tracked changes present — `git switch <b>`, `git checkout <b>`,
//         `git switch -c`, `git checkout -b`. Whether a process IS running here is the
//         user's knowledge, not the hook's.
//     4a. EVERY `git worktree add`. A worktree puts the run's files OUTSIDE the folder
//         the user is watching; a silently-created one is work they never see land. The
//         prompt names the resolved destination path. Creating or checking out a
//         PROTECTED branch gets its own reason on top — git locks a branch to one
//         worktree, so the primary checkout can no longer return to it.
//
//   DENY — unconditional loss or breakage, with nothing for a human to weigh:
//     2.  Destructive to the working tree with tracked changes present — `git stash`
//         (push/save), `git reset --hard|--merge|--keep`, `git restore <path>`,
//         `git checkout -- <path>`. The uncommitted work is gone, approval or not.
//     3.  `git clean` with -f/-d/-x while untracked files exist.
//     4b. `git worktree add` landing INSIDE the repo root — nested worktrees crash
//         indexers; worktrees are siblings: ../worktrees/<name>/. Checked BEFORE the
//         asks above, since a deny outranks them.
//
// Classes 1-3 pass untouched on a clean tree: the risk only exists when there is
// uncommitted work to lose. Class 4 applies always — it does not depend on tree state.
//
// The reason is ALSO written to stderr on every non-allow decision, so a CLI whose hook
// contract understands only allow/deny still surfaces the notification to the agent —
// which must then obtain the user's permission itself rather than proceeding.
//
// Rule 6 wiring (same script, three CLIs):
//   - Claude Code : .claude/settings.json  → PreToolUse (matcher: Bash)
//   - Codex CLI   : .codex/config.toml     → PreToolUse
//   - Gemini CLI  : .gemini/settings.json  → BeforeTool (matcher: run_command)
// Antigravity has no tool-call hook event — it is covered by the CLAUDE.md rule text
// plus the `sidekicks branch switch` / `service checkout` dirty guards in lib/, which
// travel on every CLI.
//
// ESCAPE HATCH — user-sanctioned only: put `SIDEKICKS_BRANCH_SAFETY=off` in the
// command (e.g. `SIDEKICKS_BRANCH_SAFETY=off git switch -c feature/x`). It is the
// STANDING form of the ask decisions above — use it when the user has said the shared
// checkout is theirs alone to move, so the prompt stops repeating. The whole hook is
// also toggleable: `sidekicks framework disable hook.enforce-branch-safety`.
//
// Contract: BEST-EFFORT. Any internal error, unparseable command, or non-repo target
// ALLOWS the call — a hook must never wedge the agent.  Zero npm dependencies.
//
// Direct test mode (prints the decision it WOULD return — {"allow":true} or
// {"decision":"ask"|"deny","reason":"…"}):
//   node scripts/enforce-branch-safety.mjs --command "<shell command>" [--cwd <dir>]

import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve as resolvePath, relative, basename } from 'node:path';

/** Integration / environment branches — CLAUDE.md's protected set, plus `master`. */
const PROTECTED = /^(?:main|master|sit|uat|staging|stage|prod|production|release\/.+)$/;

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * Is this token the override, as a REAL environment assignment?
 *
 * It used to be a regex tested against the whole command string, which is not the same question:
 * `git commit -m 'SIDEKICKS_BRANCH_SAFETY=off' && git reset --hard` disabled the hook for both
 * segments, and so did a code comment, a file name, or a first-segment prefix leaking onto a
 * later one. The override is an env assignment or it is nothing.
 */
function isOverrideAssignment(token) {
  const m = ASSIGNMENT.exec(String(token));
  if (!m || m[1] !== 'SIDEKICKS_BRANCH_SAFETY') return false;
  return /^(?:off|0|false|no)$/i.test(m[2].replace(/^["']|["']$/g, ''));
}

const SEPARATOR = /\r?\n|&&|\|\||;|(?<!&)&(?!&)|(?<!\|)\|(?!\|)/g;

/**
 * Split a shell command into sequential segments. Best-effort, no real shell parsing.
 *
 * `&` is a separator: `git status & git reset --hard` backgrounds the first command and runs the
 * second, and leaving it out meant the whole thing read as one unclassifiable segment.
 *
 * QUOTED SPANS ARE MASKED FIRST, and that is the load-bearing part. Splitting the raw text meant a
 * separator INSIDE an argument tore the command apart, and the pieces stopped looking like git:
 *
 *     git -C "dir & x" reset --hard   →   `git -C "dir` + `x" reset --hard`
 *
 * Neither piece classified, so a `reset --hard` on a dirty tree was ALLOWED. That held for `;` and
 * `&&` before `&` was ever added here — adding `&` only made it easy to hit, since `Q&A` and `R&D`
 * turn up in real commit messages. Masking keeps the offsets aligned (one character in, one
 * character out), so the pieces returned are cut from the ORIGINAL text and nothing is rewritten.
 */
function segments(command) {
  const text = String(command);
  const chars = [...text];
  let masked = '';
  let quote = null;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    // A backslash escape is literal data, and the character it protects is NOT a quote
    // delimiter. Missing this was a hole, not a nicety: `-m 'it'\''s fine'` — the standard
    // POSIX way to put an apostrophe in a single-quoted string, and what every quoting helper
    // emits — left the masker believing a quote was still open, so the `&&` after it was
    // swallowed and the `git reset --hard` that followed went unclassified.
    //
    // But a backslash NEVER swallows the delimiter that is currently open. A double-quoted
    // value ending in one — `"C:\Users\name\"`, the everyday Windows path shape, where cmd does
    // not treat `\` as an escape at all — otherwise ran past its own closing quote, and a LATER
    // argument's opening quote closed it instead. Everything between the two, separators
    // included, was masked into one unclassifiable blob:
    //
    //     git commit -m "span1\" && git reset --hard && git commit -m "span2\"   → allowed
    //
    // Declining to escape the active delimiter can mis-close a POSIX `"a\"b"`, which yields MORE
    // segments and more classification — the safe direction for a guard, unlike the above.
    if (ch === '\\' && quote !== "'" && !(quote === '"' && chars[i + 1] === quote)) {
      masked += ch + (chars[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (quote) {
      // Inside quotes a separator is data. Blanked to a SPACE, which the split regex cannot
      // match. Not a NUL: a literal NUL in a source file makes git treat it as binary.
      masked += ch === quote ? ch : (/[&|;\r\n]/.test(ch) ? ' ' : ch);
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; }
    masked += ch;
  }

  // An UNBALANCED quote means the mask is a guess, and a wrong guess here hides commands. Fail
  // toward MORE classification: fall back to splitting the raw text, which is what this function
  // did before masking existed.
  const source = quote === null ? masked : text;

  const out = [];
  let last = 0;
  let m;
  SEPARATOR.lastIndex = 0;
  while ((m = SEPARATOR.exec(source)) !== null) {
    out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Tokenize a segment, honouring simple single/double quotes. */
function tokens(segment) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Split leading `VAR=value` assignments off an argv.
 *
 * @returns {{assignments: string[], argv: string[]}}
 */
function stripEnv(toks) {
  let i = 0;
  while (i < toks.length && ASSIGNMENT.test(toks[i])) i += 1;
  return { assignments: toks.slice(0, i), argv: toks.slice(i) };
}

const isGit = (tok) => /(?:^|[\\/])git(?:\.exe)?$/i.test(String(tok));

/** Wrappers that run their argument as a command. `git` behind one is still `git`. */
const WRAPPERS = new Set([
  'command', 'sudo', 'doas', 'nice', 'ionice', 'nohup', 'time', 'xargs', 'stdbuf', 'setsid',
  'timeout', 'proxychains', 'strace', 'ltrace',
]);

/** Shells that take `-c <script>`; the script is a nested command line, not an argument. */
const isShell = (tok) => /(?:^|[\\/])(?:ba|z|k|da|a)?sh(?:\.exe)?$/i.test(String(tok));

/** A construct this tokenizer cannot see through, so a `git` inside it stays hidden. */
const OPAQUE = /\$\(|`|\$\{/;

/**
 * Peel command wrappers until the real argv is exposed.
 *
 * `command git reset --hard` and `env git reset --hard` were both ALLOWED before this existed:
 * the classifier looked at argv[0], saw `command`/`env` rather than `git`, and skipped the
 * segment entirely. Ordinary wrappers are not an authorization mechanism.
 *
 * @returns {{argv: string[], assignments: string[]}} assignments picked up from `env`/prefixes.
 */
function unwrap(argv) {
  let cur = argv.slice();
  const assignments = [];
  for (let guard = 0; guard < 8 && cur.length > 0; guard += 1) {
    const head = basename(String(cur[0]));
    if (head === 'env' || head === 'env.exe') {
      cur = cur.slice(1);
      while (cur.length > 0) {
        if (ASSIGNMENT.test(cur[0])) { assignments.push(cur[0]); cur = cur.slice(1); }
        else if (cur[0] === '-u' || cur[0] === '--unset') cur = cur.slice(2);
        else if (String(cur[0]).startsWith('-')) cur = cur.slice(1);
        else break;
      }
      continue;
    }
    if (WRAPPERS.has(head)) {
      cur = cur.slice(1);
      // Every wrapper takes its own options, and they do not share a shape: `timeout 30 git …`,
      // `nice -n 10 git …`, `sudo -u dev git …`, `xargs -n1 git …`. Rather than model each one,
      // look for the git token itself among the wrapper's arguments — if the line ends up
      // running git, it gets classified. A stray `git` that is really a value (`sudo -u git ls`)
      // costs nothing: classify() returns null for a subcommand it does not guard.
      const gi = cur.findIndex(isGit);
      if (gi >= 0) {
        for (const t of cur.slice(0, gi)) if (ASSIGNMENT.test(t)) assignments.push(t);
        cur = cur.slice(gi);
        break;
      }
      while (cur.length > 0 && (String(cur[0]).startsWith('-') || ASSIGNMENT.test(cur[0]))) {
        if (ASSIGNMENT.test(cur[0])) assignments.push(cur[0]);
        cur = cur.slice(1);
      }
      continue;
    }
    break;
  }
  return { argv: cur, assignments };
}

/**
 * Working-tree state of `dir`, submodule noise excluded (a modified submodule POINTER
 * is not uncommitted work a HEAD move or a stash can destroy, and in a repo of
 * submodules it is chronic — counting it would deny every switch forever).
 *
 * @returns {{tracked: boolean, untracked: boolean}|null} null when `dir` is not a repo.
 */
function treeState(dir) {
  const r = spawnSync('git', ['-C', dir, 'status', '--porcelain', '--ignore-submodules=all'], {
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  const lines = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
  return {
    tracked: lines.some((l) => !l.startsWith('??')),
    untracked: lines.some((l) => l.startsWith('??')),
  };
}

/**
 * realpath of `p`, walking up to the nearest EXISTING ancestor (a worktree path does not
 * exist yet — its parent does). Returns `p` unchanged when nothing resolves.
 */
function realOf(p) {
  let cur = resolvePath(p);
  const tail = [];
  for (;;) {
    try {
      return tail.length ? resolvePath(realpathSync(cur), ...tail.reverse()) : realpathSync(cur);
    } catch {
      const parent = resolvePath(cur, '..');
      if (parent === cur) return resolvePath(p);
      tail.push(relative(parent, cur));
      cur = parent;
    }
  }
}

/** Absolute path of the repo root containing `dir`, or null. */
function repoRootOf(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  const out = String(r.stdout || '').trim();
  return out || null;
}

/** Does `branch` exist as a local branch in `dir`? */
function localBranchExists(dir, branch) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
  });
  return !r.error && r.status === 0;
}

const FIX_WORKTREE =
  'Create the work branch in a SIBLING WORKTREE instead — it never touches this checkout\'s HEAD ' +
  'or its uncommitted files:\n' +
  '  git worktree add ../worktrees/<slug> -b <type>/<key>-<slug> <base>\n' +
  'then do the work with `git -C ../worktrees/<slug> …` (or cd into it).';

const ASK_TAIL =
  '\nOnly the user knows what else is live in this checkout — ask them, and proceed only on a ' +
  'yes. Approving this prompt IS that yes; `SIDEKICKS_BRANCH_SAFETY=off` is its standing form.';

/**
 * Classify ONE git invocation.
 *
 * @param {string[]} argv - argv with `git` at [0], env assignments already stripped.
 * @param {string} cwd    - the directory this invocation would run in.
 * @returns {{decision: 'ask'|'deny', reason: string}|null}
 */
function classify(argv, cwd) {
  // `git -C <dir>` (repeatable — the last one wins, as git itself resolves them in order)
  let dir = cwd;
  const rest = [];
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '-C' && argv[i + 1] != null) {
      dir = isAbsolute(argv[i + 1]) ? argv[i + 1] : resolvePath(dir, argv[i + 1]);
      i += 1;
    } else if ((argv[i] === '-c' || argv[i] === '--config-env' || argv[i] === '--git-dir'
                || argv[i] === '--work-tree' || argv[i] === '--namespace') && rest.length === 0) {
      i += 1; // pre-subcommand global flag that consumes a value
    } else if (argv[i].startsWith('-') && rest.length === 0) {
      continue; // other pre-subcommand global flag (-c key=val, --no-pager, …)
    } else {
      rest.push(argv[i]);
    }
  }
  const sub = rest[0];
  if (!sub) return null;
  const args = rest.slice(1);
  const has = (...names) => args.some((a) => names.includes(a));

  // ---- class 4: worktree add (independent of tree state) -------------------------
  if (sub === 'worktree' && args[0] === 'add') {
    const rest2 = args.slice(1);
    let newBranch = null;
    const positional = [];
    for (let i = 0; i < rest2.length; i += 1) {
      const a = rest2[i];
      if ((a === '-b' || a === '-B') && rest2[i + 1] != null) { newBranch = rest2[i + 1]; i += 1; }
      else if (a.startsWith('-')) continue;
      else positional.push(a);
    }
    const target = positional[1]; // <path> <commit-ish>
    const root = repoRootOf(dir);
    const abs = positional[0]
      ? (isAbsolute(positional[0]) ? positional[0] : resolvePath(dir, positional[0]))
      : null;

    // Nested first: a DENY outranks the asks below, and a nested worktree is broken
    // however anyone feels about it.
    if (root && abs) {
      // Compare REAL paths: git reports the toplevel resolved (/private/var/… on macOS) while
      // the command's own path is not, and a symlinked prefix would hide a nested worktree.
      const rel = relative(realOf(root), realOf(abs));
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
        return {
          decision: 'deny',
          reason:
            `BLOCKED: worktree path '${positional[0]}' resolves INSIDE the repo root ` +
            '(CLAUDE.md → "Git worktrees": always a sibling, never nested — nested copies crash ' +
            `indexers). Use ../worktrees/${basename(abs) || '<name>'}/ instead.`,
        };
      }
    }

    // Where the files would actually land — the whole point of the prompt is that a
    // worktree writes OUTSIDE the folder the user is watching.
    const where = abs
      ? `\nIt would create a second checkout at:\n  ${abs}\nEdits made there do NOT appear in ` +
        `${root ?? 'this repo'} until the branch is merged back.`
      : '';

    if (newBranch && PROTECTED.test(newBranch)) {
      return {
        decision: 'ask',
        reason:
          `PERMISSION NEEDED: \`git worktree add\` would create the PROTECTED branch ` +
          `'${newBranch}' (CLAUDE.md → "Protected branches"). Implementation work never lands ` +
          'on an integration branch, and git locks that branch to the new worktree — the ' +
          'primary checkout can no longer return to it. Name the work branch ' +
          '<type>/<key>-<slug> instead unless the user wants exactly this.' + where + ASK_TAIL,
      };
    }
    if (!newBranch && target && PROTECTED.test(target) && localBranchExists(dir, target)) {
      return {
        decision: 'ask',
        reason:
          `PERMISSION NEEDED: \`git worktree add\` would CHECK OUT the protected branch ` +
          `'${target}' in a second working tree. git then locks that branch — the primary ` +
          `checkout can no longer switch back to '${target}', which strands anything else live ` +
          'in it. Cutting a work branch off it avoids the lock entirely:\n' +
          `  git worktree add ${positional[0] ?? '../worktrees/<slug>'} -b <type>/<key>-<slug> ${target}` +
          where + ASK_TAIL,
      };
    }

    // Catch-all: EVERY worktree add needs the user's go-ahead. A worktree is not a
    // free action — it puts the run's files somewhere the user is not looking, and a
    // silently-created one is work they never see land.
    return {
      decision: 'ask',
      reason:
        'PERMISSION NEEDED: `git worktree add` creates a NEW working tree outside the folder ' +
        'you are watching. Never create one on your own initiative — the user has to know a ' +
        'second checkout exists, where it is, and that the work will not be visible in this ' +
        'folder.' + where +
        '\nSay what the worktree is for and which branch it carries, then let the user decide. ' +
        'Approving this prompt is that decision; `SIDEKICKS_BRANCH_SAFETY=off` is its standing ' +
        'form. Remember to `git worktree remove` it once the branch is merged.',
    };
  }

  // ---- classes 1-3 need the tree state ------------------------------------------
  let kind = null; // 'head-move' | 'destructive' | 'clean'
  let what = '';

  if (sub === 'switch') {
    if (has('-h', '--help')) return null;
    kind = 'head-move';
    what = has('-c', '-C', '--create', '--force-create') ? 'git switch -c' : 'git switch';
  } else if (sub === 'checkout') {
    if (has('-h', '--help')) return null;
    const pathish = args.includes('--') || args.some((a) => a === '.');
    kind = pathish ? 'destructive' : 'head-move';
    what = pathish
      ? 'git checkout -- <path>'
      : (has('-b', '-B') ? 'git checkout -b' : 'git checkout');
  } else if (sub === 'restore') {
    if (has('-h', '--help')) return null;
    // `restore --staged` alone only unstages; it does not touch the working tree.
    if (has('--staged', '-S') && !has('--worktree', '-W')) return null;
    kind = 'destructive';
    what = 'git restore';
  } else if (sub === 'reset') {
    if (!has('--hard', '--merge', '--keep')) return null;
    kind = 'destructive';
    what = `git reset ${args.find((a) => ['--hard', '--merge', '--keep'].includes(a))}`;
  } else if (sub === 'stash') {
    const verb = args.find((a) => !a.startsWith('-')) ?? 'push';
    if (!['push', 'save', 'create', 'store'].includes(verb)) return null; // list/show/pop/apply/drop pass
    kind = 'destructive';
    what = 'git stash';
  } else if (sub === 'clean') {
    if (!args.some((a) => /^-[a-zA-Z]*[fdx]/.test(a) || ['--force'].includes(a))) return null;
    kind = 'clean';
    what = 'git clean';
  } else {
    return null;
  }

  const state = treeState(dir);
  if (!state) return null; // not a repo / git unavailable — allow

  if (kind === 'head-move' && state.tracked) {
    return {
      decision: 'ask',
      reason:
        `PERMISSION NEEDED: \`${what}\` would move HEAD in a SHARED working tree that has ` +
        'uncommitted tracked changes. Anything else live in this checkout (another agent ' +
        'session, a dev server, a build, the user\'s editor) gets its files swapped underneath ' +
        'it, and that is how work gets lost.\n' + FIX_WORKTREE + ASK_TAIL,
    };
  }
  if (kind === 'destructive' && state.tracked) {
    return {
      decision: 'deny',
      reason:
        `BLOCKED: \`${what}\` DISCARDS or parks uncommitted tracked changes in this shared ` +
        'working tree — including work another live process wrote and has not committed. ' +
        'It is never the way to carry work onto a branch.\n' + FIX_WORKTREE +
        '\nTo keep the changes here, commit them on a work branch created as above. If the user ' +
        'has explicitly asked for this discard, re-run prefixed with SIDEKICKS_BRANCH_SAFETY=off.',
    };
  }
  if (kind === 'clean' && state.untracked) {
    return {
      decision: 'deny',
      reason:
        'BLOCKED: `git clean` would delete untracked files in this shared working tree — ' +
        'unrecoverable, and untracked does not mean unwanted (a second process may be mid-write). ' +
        'List them first (`git clean -nd`), show the user, and delete only what they name. ' +
        'If they have asked for the sweep, re-run prefixed with SIDEKICKS_BRANCH_SAFETY=off.',
    };
  }
  return null;
}

/**
 * Not exported on purpose: this module runs main() at load, so a test that imported it
 * would consume the process's stdin. Tests drive it through `--command` as a subprocess,
 * exactly as a CLI invokes it.
 *
 * @returns {{decision: 'ask'|'deny', reason: string}|null}
 */
function decide(command, cwd = process.cwd(), depth = 0) {
  if (!command) return null;
  const text = String(command);
  if (!/\bgit\b/i.test(text)) return null;

  let dir = cwd;
  for (const seg of segments(text)) {
    const raw = tokens(seg);
    if (raw.length === 0) continue;
    const { assignments: prefix, argv: afterEnv } = stripEnv(raw);
    if (afterEnv.length === 0) continue;

    // Track `cd` so `cd repo && git switch x` is judged against `repo`.
    if (afterEnv[0] === 'cd' && afterEnv[1] && !String(afterEnv[1]).startsWith('-')) {
      dir = isAbsolute(afterEnv[1]) ? afterEnv[1] : resolvePath(dir, afterEnv[1]);
      continue;
    }

    const { argv, assignments: inner } = unwrap(afterEnv);
    if (argv.length === 0) continue;

    // `sh -c "git reset --hard"` — the script is a command line of its own. Recurse rather than
    // treat it as an argument, so wrapping a destructive command in a shell is not a bypass.
    if (isShell(argv[0]) && depth < 4) {
      // Bundled short flags are the common spelling, not an exotic one: `bash -lc "…"` (login)
      // and `sh -xc "…"` (trace) both carry the script in the same place, and matching only a
      // bare `-c` left the easiest form of this bypass open.
      //
      // Scanned only across the shell's OWN leading option run, exactly as a shell parses it:
      // once a positional appears the shell is running a script, and every token after that
      // belongs to the script — `bash deploy.sh --mode -c` must not have its script's `-c`
      // mistaken for the shell's.
      let ci = -1;
      for (let k = 1; k < argv.length; k += 1) {
        const tok = String(argv[k]);
        if (!tok.startsWith('-')) break;
        if (/^-[a-zA-Z]*c$/.test(tok) || tok === '--command') { ci = k; break; }
      }
      const script = ci >= 0 ? argv[ci + 1] : null;
      if (script) {
        const d = decide(script, dir, depth + 1);
        if (d) return d;
        continue;
      }
    }

    if (!isGit(argv[0])) {
      // Fail closed rather than fall through to allow: the segment names git, but it is hidden
      // inside a substitution this tokenizer cannot see through, so nothing here can honestly
      // say the command is safe.
      if (OPAQUE.test(seg) && /\bgit\b/i.test(seg)) {
        return {
          decision: 'ask',
          reason:
            'PERMISSION NEEDED: this command runs `git` inside a substitution ' +
            `(\`${seg.trim()}\`), so the branch-safety hook cannot tell which git command it is ` +
            'or whether it would discard uncommitted work in this shared checkout. Run the git ' +
            'command directly so it can be classified, or confirm you know what this one does.' +
            ASK_TAIL,
        };
      }
      continue;
    }

    // The override authorizes THIS invocation, and only as a real leading assignment on it
    // (its own, or one carried by the `env`/wrapper that runs it).
    if ([...prefix, ...inner].some(isOverrideAssignment)) continue;

    const d = classify(argv, dir);
    if (d) return d;
  }
  return null;
}

function extractCommand(evt) {
  const ti = evt?.tool_input ?? {};
  const raw = ti.command ?? ti.cmd ?? ti.script ?? '';
  return Array.isArray(raw) ? raw.join(' ') : String(raw ?? '');
}

function main() {
  const cmdIdx = process.argv.indexOf('--command');
  if (cmdIdx !== -1) {
    const cwdIdx = process.argv.indexOf('--cwd');
    const cwd = cwdIdx !== -1 ? process.argv[cwdIdx + 1] : process.cwd();
    const d = decide(process.argv[cmdIdx + 1] ?? '', cwd);
    console.log(JSON.stringify(d ?? { allow: true }));
    process.exit(0);
  }

  let evt;
  try {
    evt = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // unreadable stdin — allow
  }
  const d = decide(extractCommand(evt), evt?.cwd || process.cwd());
  if (!d) process.exit(0);
  // Notify on stderr too: a CLI whose hook contract knows only allow/deny would drop an
  // `ask` silently, and the notification with it. On stderr the agent still reads it and
  // must obtain the user's permission itself.
  process.stderr.write(`${d.reason}\n`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d.decision,
      permissionDecisionReason: d.reason,
    },
  }));
  process.exit(0);
}

// Framework gate: `sidekicks framework disable hook.enforce-branch-safety` makes this a no-op.
await import('./lib/hook-gate.mjs')
  .then((gate) => gate.exitIfDisabled('hook.enforce-branch-safety'))
  .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

try {
  main();
} catch {
  process.exit(0); // best-effort: never wedge the agent
}
