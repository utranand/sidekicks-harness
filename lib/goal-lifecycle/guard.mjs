// lib/goal-lifecycle/guard.mjs
// The engine's own command guard: hard-stopped actions are REFUSED before they run, by the parent,
// regardless of which CLI is implementing.
//
// WHY THIS EXISTS AT ALL. A prompt that tells a session not to push is advice. A CLI deny list is
// enforcement, but only for the CLIs that have one, and only for tool calls that CLI mediates. Neither
// covers "the agent wrote a shell script and ran it". So the engine puts a directory of shims at the
// FRONT of the child's PATH, and every guarded command name resolves to a decision instead of the real
// binary. `git status` passes through untouched; `git push` never executes.
//
// WHAT THIS IS NOT. It is not a sandbox, and it must never be described as one. A child that invokes
// `/usr/bin/git push` by absolute path, or calls a library binding directly, goes around it. That is
// exactly why `roleSupported` ALSO requires the CLI's own enforceable policy before an executor may
// implement: two independent boundaries, each covering what the other misses. The guard's unique value
// is that it is the same boundary on every CLI and that it leaves EVIDENCE — a refusal line naming the
// command that was stopped, which is the difference between "we believe nothing was pushed" and "the
// refusal is on disk".
//
// ONE DECISION IMPLEMENTATION, NOT THIRTY SHELL SCRIPTS. Each shim is two lines that hand the argv to
// `guard-decide.mjs` under the parent's own Node binary. Re-implementing the classification in `sh` and
// again in `cmd` would be two more places for it to be wrong, and the second one would only ever be
// exercised on Windows.
//
// NO ABSOLUTE PATH IS WRITTEN INTO A SHIM. Everything machine-specific — the Node binary, the decision
// script, the log, the real PATH — arrives through the environment the parent sets at dispatch. So the
// guard directory is portable content under `artifacts/runs/`, and a run folder copied to another
// machine carries no `/Users/...` in it.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from '../fs-safety/fsx.mjs';

/** Exit code a refused command returns. Distinctive, so a transcript shows what stopped it. */
export const GUARD_REFUSAL_EXIT = 77;

/** Environment variables the shims read. Named, because the shim files contain nothing else. */
export const GUARD_ENV = Object.freeze({
  node: 'SIDEKICKS_GUARD_NODE',
  decide: 'SIDEKICKS_GUARD_DECIDE',
  log: 'SIDEKICKS_GUARD_LOG',
  grant: 'SIDEKICKS_GUARD_GRANT',
  path: 'SIDEKICKS_GUARD_PATH',
});

/**
 * The guarded command surface, and how each argv is classified.
 *
 * `always` names commands whose every invocation is a hard-stopped class — there is no benign
 * `kubectl`, in a session whose whole job is editing files in a repository.
 *
 * `rules` names commands that have both benign and hard-stopped uses. Order matters: the first
 * matching rule wins, and `null` means allow. A command with rules and no match passes through, which
 * is what keeps `git status`, `git commit` and `npm test` working.
 */
export const GUARDED = Object.freeze({
  // --- always, whatever the arguments -----------------------------------------------------------
  gh: { always: 'pull-request' },
  glab: { always: 'pull-request' },
  kubectl: { always: 'deploy' },
  helm: { always: 'deploy' },
  terraform: { always: 'deploy' },
  tofu: { always: 'deploy' },
  pulumi: { always: 'deploy' },
  serverless: { always: 'deploy' },
  flyctl: { always: 'deploy' },
  vercel: { always: 'deploy' },
  aws: { always: 'prod-access' },
  gcloud: { always: 'prod-access' },
  az: { always: 'prod-access' },
  tsh: { always: 'prod-access' },
  psql: { always: 'db-write' },
  mysql: { always: 'db-write' },
  mongosh: { always: 'db-write' },
  mongo: { always: 'db-write' },
  'redis-cli': { always: 'db-write' },
  twine: { always: 'publish' },
  curl: { always: 'outward-message' },
  wget: { always: 'outward-message' },
  ssh: { always: 'prod-access' },
  scp: { always: 'prod-access' },
  rsync: { always: 'prod-access' },
  mail: { always: 'outward-message' },
  mailx: { always: 'outward-message' },
  sendmail: { always: 'outward-message' },

  // --- benign and hard-stopped uses share a binary -----------------------------------------------
  git: {
    rules: [
      { when: ['push'], class: 'push' },
      // Every one of these destroys work that is not this run's, or moves HEAD under whatever else is
      // live in the checkout. The framework forbids them to its own agents for the same reason.
      { when: ['reset'], class: 'destructive' },
      { when: ['stash'], class: 'destructive' },
      { when: ['clean'], class: 'destructive' },
      { when: ['checkout'], class: 'destructive' },
      { when: ['switch'], class: 'destructive' },
      { when: ['worktree'], class: 'destructive' },
      { when: ['branch', '-D'], class: 'destructive' },
      { when: ['branch', '-d'], class: 'destructive' },
      { when: ['restore'], class: 'destructive' },
      { when: ['filter-branch'], class: 'destructive' },
      { when: ['remote', 'set-url'], class: 'push' },
    ],
  },
  npm: { rules: [{ when: ['publish'], class: 'publish' }, { when: ['login'], class: 'credential-write' }] },
  pnpm: { rules: [{ when: ['publish'], class: 'publish' }] },
  yarn: { rules: [{ when: ['publish'], class: 'publish' }] },
  cargo: { rules: [{ when: ['publish'], class: 'publish' }] },
  gem: { rules: [{ when: ['push'], class: 'publish' }] },
  mvn: { rules: [{ when: ['deploy'], class: 'deploy' }] },
  docker: {
    rules: [
      { when: ['push'], class: 'publish' },
      { when: ['login'], class: 'credential-write' },
      { when: ['compose', 'down'], class: 'destructive' },
    ],
  },
  // `rm` with no recursive or force flag deletes one named file, which a node legitimately does. `rm
  // -rf` is the shape that takes a directory tree with it. Both spellings are listed: a rule that
  // only knows the clustered short form is bypassed by `rm --recursive`, which is the same act.
  rm: {
    rules: [
      { flag: /^-[a-zA-Z]*[rRfd]/, class: 'destructive' },
      { flag: /^--(recursive|force|dir)$/, class: 'destructive' },
    ],
  },
});

/** The command names the guard shims. */
export const GUARDED_COMMANDS = Object.freeze(Object.keys(GUARDED));

/**
 * Option flags that consume the NEXT argv word.
 *
 * They matter twice. A value sitting where a sub-command would otherwise be makes `git -C /path push`
 * look like a `git /path` invocation, so classification misses the push. And the same value would be
 * read as part of the action's target, so a grant bound to `origin main` would never match.
 *
 * `-c` is the one that mattered most: `git -c protocol.version=2 push origin main` put `protocol.
 * version=2` in the sub-command slot, and the push classified as benign. A global option is exactly
 * where someone hides a push, so the list is the git/docker/kubectl global-option surface rather than
 * only the flags that happen to appear in this repository's scripts.
 */
export const VALUE_FLAGS = Object.freeze([
  '-C', '-c', '--config-env', '--git-dir', '--work-tree', '--exec-path', '--super-prefix',
  '--namespace', '--context', '--kubeconfig', '--cluster', '--profile', '--region', '--chdir',
  '--host', '--port', '--username', '--dbname',
]);

/**
 * The argv words that are neither an option nor an option's value.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function operandWords(argv) {
  const args = argv.map(String);
  /** @type {string[]} */
  const words = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (VALUE_FLAGS.includes(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    words.push(a);
  }
  return words;
}

/**
 * Classify one invocation.
 *
 * Returns the hard-stopped class, or null when this invocation is benign. Rules are matched against
 * the argv positions that are not option flags, so `git -C /somewhere push` classifies as a push.
 *
 * @param {string} command - the bare command name, without a directory or extension
 * @param {string[]} argv
 * @returns {string|null}
 */
export function classifyInvocation(command, argv) {
  return matchRule(command, argv)?.class ?? null;
}

/**
 * The rule that classifies one invocation, or null when it is benign.
 *
 * Returned rather than folded into `classifyInvocation` because the canonical TARGET depends on which
 * rule matched: `git push origin main` acts on `origin main`, and the sub-command word `push` is the
 * verb, not part of what a grant authorizes.
 *
 * @param {string} command
 * @param {string[]} argv
 * @returns {{class: string, rule: object|null}|null}
 */
export function matchRule(command, argv) {
  const entry = GUARDED[command];
  if (!entry) return null;
  if (entry.always) return { class: entry.always, rule: null };

  const args = argv.map(String);
  const words = operandWords(args);

  for (const rule of entry.rules || []) {
    if (rule.flag) {
      if (args.some((a) => rule.flag.test(a))) return { class: rule.class, rule };
      continue;
    }
    const [head, ...rest] = rule.when;
    if (words[0] !== head) continue;
    // A multi-word rule (`git branch -D`) matches when the remaining tokens appear ANYWHERE after the
    // sub-command — `git branch -D foo` and `git branch foo -D` are the same act.
    if (rest.every((token) => args.includes(token) || words.includes(token))) {
      return { class: rule.class, rule };
    }
  }
  return null;
}

/**
 * The canonical target of one guarded invocation, as a token list.
 *
 * WHY A TOKEN LIST AND NOT A SEARCH OF THE COMMAND TEXT. The first version of this asked whether the
 * grant's target string appeared anywhere in the joined argv, and that quietly widened every grant:
 * a grant for `origin feature/widget` also covered `origin feature/widget-extra`, because one is a
 * substring of the other. The operator approved one push to one branch; the guard authorized a family
 * of them. Tokens cannot do that — `feature/widget` and `feature/widget-extra` are different words.
 *
 * WHAT IS DROPPED, AND WHY. Option flags and their values go, so `git push --tags origin main` and
 * `git -c x=y push origin main` have the same target: an operator granting a push to `origin main` is
 * not deciding about `--tags`, and a grant that a reordered flag could break would be worthless. The
 * sub-command words the rule matched on go too — they are the verb. What is left is what the action
 * acts ON, verbatim: no case folding (a git ref is case-sensitive, and `Main` is not `main`) and no
 * stripping of a leading `+` (a force refspec is a different act from a fast-forward one).
 *
 * @param {string} command
 * @param {string[]} argv
 * @returns {string[]}
 */
export function canonicalTarget(command, argv) {
  const matched = matchRule(command, argv);
  const words = operandWords(argv);
  if (!matched || !matched.rule || !Array.isArray(matched.rule.when)) return words;
  const verb = new Set(matched.rule.when.map(String));
  let i = 0;
  while (i < words.length && verb.has(words[i])) i += 1;
  return words.slice(i);
}

/**
 * The token list a grant's target string denotes.
 *
 * @param {unknown} target
 * @returns {string[]}
 */
export function grantTargetTokens(target) {
  return String(target ?? '')
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter((t) => t !== '');
}

/**
 * Does an approved grant cover this invocation?
 *
 * Deliberately narrow, and now EXACT: the class must match, and the grant's target tokens must equal
 * the invocation's canonical target tokens. Equal, not contain — so a grant to push `origin
 * feature/x` authorizes that push and nothing that merely looks like it, including the same branch
 * with a suffix, an extra refspec appended, or a second remote added to the same command.
 *
 * A grant with an empty target matches nothing: a grant that names no target is not a grant, it is a
 * wildcard. A guarded invocation with no target of its own matches nothing either, for the same
 * reason from the other side.
 *
 * @param {object|null} grant
 * @param {{command: string, actionClass: string, argv: string[]}} invocation
 * @returns {boolean}
 */
export function grantCovers(grant, invocation) {
  if (!grant || typeof grant !== 'object') return false;
  const { command, actionClass, argv } = invocation || {};
  if (grant.action_class !== actionClass) return false;
  const wanted = grantTargetTokens(grant.target);
  if (wanted.length === 0) return false;
  const actual = canonicalTarget(String(command ?? ''), argv || []);
  if (actual.length !== wanted.length) return false;
  return actual.every((token, i) => token === wanted[i]);
}

/** The shim body for one command. POSIX: exec through the parent's Node, nothing else. */
function posixShim(command) {
  return '#!/bin/sh\n'
    + '# sidekicks goal command guard — generated per attempt; contains no machine path.\n'
    + `exec "$${GUARD_ENV.node}" "$${GUARD_ENV.decide}" ${command} "$@"\n`;
}

/** The shim body for one command on Windows. */
function windowsShim(command) {
  return '@echo off\r\n'
    + 'rem sidekicks goal command guard — generated per attempt; contains no machine path.\r\n'
    + `"%${GUARD_ENV.node}%" "%${GUARD_ENV.decide}%" ${command} %*\r\n`;
}

/**
 * Build the guard directory for one attempt.
 *
 * @param {string} attemptDir - the attempt's own folder; the guard lives beside its transcript
 * @param {{grant?: object|null}} [opts]
 * @returns {{dir: string, bin: string, log: string, grant: string|null, commands: string[]}}
 */
export function buildGuard(attemptDir, opts = {}) {
  const dir = join(attemptDir, 'guard');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });

  const isWindows = process.platform === 'win32';
  for (const command of GUARDED_COMMANDS) {
    if (isWindows) {
      // Both spellings: a child that calls `git` gets `git.cmd` through PATHEXT, and one that calls
      // `git.exe` explicitly gets the shim too.
      writeAtomic(join(bin, `${command}.cmd`), windowsShim(command));
      writeAtomic(join(bin, `${command}.bat`), windowsShim(command));
    } else {
      const file = join(bin, command);
      writeAtomic(file, posixShim(command));
      chmodSync(file, 0o755);
    }
  }

  const log = join(dir, 'refusals.jsonl');
  let grantPath = null;
  if (opts.grant) {
    grantPath = join(dir, 'grant.json');
    writeAtomic(grantPath, `${JSON.stringify(opts.grant, null, 2)}\n`);
  }
  return { dir, bin, log, grant: grantPath, commands: [...GUARDED_COMMANDS] };
}

/** Absolute path of the decision script, resolved from this module's own location. */
export function decideScript() {
  return join(dirname(fileURLToPath(import.meta.url)), 'guard-decide.mjs');
}

/**
 * The environment additions that arm the guard for one child.
 *
 * PATH is REPLACED, not appended to: the guard directory has to come first or the real binary wins.
 * The original PATH travels separately so the decision script can still find the real binary for a
 * benign invocation.
 *
 * @param {{bin: string, log: string, grant?: string|null}} guard
 * @param {Record<string, string|undefined>} [baseEnv]
 * @returns {Record<string, string>}
 */
export function guardEnv(guard, baseEnv = process.env) {
  const currentPath = pathOf(baseEnv);
  /** @type {Record<string, string>} */
  const env = {
    PATH: `${guard.bin}${delimiter}${currentPath}`,
    [GUARD_ENV.node]: process.execPath,
    [GUARD_ENV.decide]: decideScript(),
    [GUARD_ENV.log]: guard.log,
    [GUARD_ENV.path]: currentPath,
  };
  if (guard.grant) env[GUARD_ENV.grant] = guard.grant;
  return env;
}

/**
 * Read PATH out of an environment case-insensitively.
 *
 * Windows spells it `Path`, and a lookup of `env.PATH` against a plain object copied from
 * `process.env` misses it — which would hand the child a PATH containing only the guard directory and
 * break every benign command.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
export function pathOf(env) {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') return String(env[key] ?? '');
  }
  return '';
}

/**
 * Read the refusals a guarded attempt produced.
 *
 * A malformed line is REPORTED rather than skipped: the log is the evidence that something was
 * stopped, and quietly dropping an unparseable line loses exactly the record that matters most.
 *
 * @param {{log: string}} guard
 * @returns {{command: string, action_class: string, argv: string[], at: string,
 *            decision: string}[]}
 */
export function readRefusals(guard) {
  if (!existsSync(guard.log)) return [];
  const out = [];
  for (const line of readFileSync(guard.log, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ command: '(unparseable)', action_class: 'unclassified', argv: [], at: '', decision: 'refused', raw: line });
    }
  }
  return out;
}

/**
 * One line per refusal, for a report or a failure message.
 *
 * @param {object[]} refusals
 * @returns {string[]}
 */
export function describeRefusals(refusals) {
  return refusals.map((r) => `${r.decision === 'allowed-by-grant' ? 'ALLOWED BY GRANT' : 'REFUSED'}: `
    + `${r.action_class} — ${[r.command, ...(r.argv || [])].join(' ')}`);
}
