// lib/skill-lifecycle/scan.mjs
// THE dependency scanner. One implementation, shared by `sidekicks skill doctor` and by the
// portability tests.
//
// WHY SHARED. tests/skill-config.test.mjs carried its own inline scanner and it had three holes:
// it matched `.mjs` only (so every Python sys.path splice was invisible), it matched only RELATIVE
// `../` imports (while the dominant idiom in this repo is an ABSOLUTE walk-up to
// `<root>/.agents/skills/<other>/scripts`), and it matched only `from '…'` (not `import()`,
// `require()`, or a subprocess spelling). It has been passing while ~50 real cross-skill edges
// exist. A gate and a verb that scan differently is how that happens, so there is now one scanner
// and the test delegates to it.
//
// WHAT IT DOES NOT DO. It reports EVIDENCE, never a verdict. Grading an edge (is this declared? is
// it allowed?) belongs to audit.mjs; the split is what keeps this module testable against fixtures.
//
// CONFIDENCE TIERS, extending sk-inherit's referencedSkills():
//   wired        — the name appears in CODE under scripts/ (comments and docstrings removed)
//   documented   — a PATH into another skill appears outside scripts/ (SKILL.md tells the agent to
//                  run it). This tier is the addition: it is what makes the ~42 prose-documented
//                  invocations visible without also reporting every "see also" cross-reference.
//   ambiguous    — a borrowed module whose owner cannot be determined (several skills ship a module
//                  of that name and this file names none of them). Reported, never auto-declared.
//   code-comment — under scripts/ but only inside a comment or docstring
//   prose        — a bare NAME anywhere outside scripts/. Informational; never a finding.
//
// AND `how` RECORDS THE SHAPE OF THE EDGE: `import` (a language-level import of the sibling's
// module), `subprocess` (a PATH into the sibling is executed), `handoff` (the sibling is NAMED in
// code — a routing target, not something this skill runs), `prose` (documentation only).
// Comment stripping is used to SPLIT hits, never to discard them: measured across the registry it
// moves 49 edges, and many are real (an invocation described only in prose inside a script). A
// comment-only hit is reported at lower confidence rather than dropped.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { MANIFEST_NAME } from '../skill-manifest/schema.mjs';

// ── What is walked ────────────────────────────────────────────────────────────────

// Never walked: build output and vendored trees. Hashing or scanning these would swamp every
// report and none of it is authored content.
const SKIP_DIRS = Object.freeze(new Set([
  'node_modules', '__pycache__', '.git', '.venv', '.pytest_cache', '.DS_Store',
]));

// Files read for references. Everything else is still hashed into the bundle baseline, just not
// scanned for dependency evidence.
const SCANNED_EXT = /\.(md|mjs|js|cjs|ts|sh|bash|py|ya?ml|json|toml|txt)$/i;

// Directories a skill ships that are ABOUT the skill rather than part of what it runs — see the
// note at the scan loop. Anchored at the start, so a `scripts/evals-runner.py` is still scanned.
const NON_EVIDENCE_DIR = /^(improvements|evals)\//;

// The one repo-root path a skill may name without declaring it: the CLI substrate itself.
// 91 of 105 skills invoke `node bin/sidekicks …`; that is the framework contract, not a dependency
// to be healed. See CLAUDE.md — the repo-root .venv is the same kind of sanctioned exception.
const SANCTIONED_ROOT_PATHS = Object.freeze([
  'bin/sidekicks',
  '.venv/bin/python',
  '.venv/bin/pip',
  '.venv/Scripts/python.exe',
  '.venv/Scripts/pip.exe',
]);

// ── Python ────────────────────────────────────────────────────────────────────────

// sys.stdlib_module_names from CPython 3.13, private names dropped. Static rather than probed so
// the scanner works with no .venv present (a fresh clone, a forged runtime, CI on a bare image).
// A newer Python only ADDS names, and a name missing here surfaces as a reportable third-party
// import rather than a silent miss — the safe direction to be wrong in.
// Exported so `audit.mjs` can check a DECLARED row against the same list the detector filters by.
// One source of truth on purpose: a second copy would drift, and the direction it drifts in is
// "a stdlib name is accepted as a pip package", which is the thing this list exists to prevent.
export const PY_STDLIB = Object.freeze(new Set(`
abc antigravity argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2
cProfile calendar cmath cmd code codecs codeop collections colorsys compileall concurrent
configparser contextlib contextvars copy copyreg csv ctypes curses dataclasses datetime dbm
decimal difflib dis doctest email encodings ensurepip enum errno faulthandler fcntl filecmp
fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib
grp gzip hashlib heapq hmac html http idlelib imaplib importlib inspect io ipaddress itertools
json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap modulefinder
msvcrt multiprocessing netrc nt ntpath nturl2path numbers opcode operator optparse os pathlib
pdb pickle pickletools pkgutil platform plistlib poplib posix posixpath pprint profile pstats
pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib
resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site
smtplib socket socketserver sqlite3 sre_compile sre_constants sre_parse ssl stat statistics
string stringprep struct subprocess symtable sys sysconfig syslog tabnanny tarfile tempfile
termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback
tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uuid venv warnings
wave weakref webbrowser winreg winsound wsgiref xml xmlrpc zipapp zipfile zipimport zlib
zoneinfo
__future__ __main__
`.trim().split(/\s+/)));
// `__future__` and `__main__` are appended by hand: sys.stdlib_module_names contains them, but the
// list above was generated with private names filtered out, and `from __future__ import annotations`
// is the single most common import in this repo's Python. Without them the scanner would tell you to
// `pip install __future__`.

// Import name -> pip package, for the cases where they differ. An unlisted module maps to itself,
// which is right far more often than not; this table only records the divergences.
const PY_PACKAGE = Object.freeze({
  yaml: 'PyYAML',
  psycopg2: 'psycopg2-binary',
  PIL: 'Pillow',
  bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil',
  dotenv: 'python-dotenv',
  markdown: 'Markdown',
  AppKit: 'pyobjc-framework-Cocoa',
  Foundation: 'pyobjc-framework-Cocoa',
  Quartz: 'pyobjc-framework-Quartz',
  objc: 'pyobjc-core',
  git: 'GitPython',
  jwt: 'PyJWT',
  serial: 'pyserial',
  sklearn: 'scikit-learn',
  cv2: 'opencv-python',
});

// NAMESPACE packages: roots that are a shared import prefix rather than a distributable of their
// own. `pip install google` does not install anything a `from google import genai` needs — it
// installs an unrelated, long-abandoned stub — so mapping the root to itself here is not a harmless
// guess, it is a wrong package name that `heal --apply` would resolve against the index and install
// into the shared repo-root .venv. Same class of hazard as declaring a stdlib name as a pip package.
//
// A namespace import is therefore identified by TWO segments, which is also how it really works:
// `google.genai` and `google.cloud.storage` are separate distributions that happen to share a
// prefix, and collapsing them to one `google` row would declare one dependency for two.
//
// Exported so audit.mjs can refuse a hand-authored row that declares a bare namespace root.
export const PY_NAMESPACE_ROOTS = Object.freeze(new Set(['google']));

// The default rule is `google.genai` -> `google-genai`. These are the members that break it, listed
// so the rule can be applied without producing a wrong name for the well-known exceptions. Only
// `google.genai` is imported anywhere in this repo today (measured across both skill trees).
const PY_NAMESPACE_PACKAGE = Object.freeze({
  'google.protobuf': 'protobuf',
  'google.auth': 'google-auth',
  'google.oauth2': 'google-auth',
});

/**
 * The pip package for an import name. Accepts a dotted path so a namespace member resolves to its
 * real distribution; anything else is keyed on the name as written.
 *
 * @param {string} mod @returns {string}
 */
export function pipPackageFor(mod) {
  if (PY_NAMESPACE_PACKAGE[mod]) return PY_NAMESPACE_PACKAGE[mod];
  const seg = mod.split('.');
  if (seg.length > 1 && PY_NAMESPACE_ROOTS.has(seg[0])) return seg.slice(0, 2).join('-');
  return PY_PACKAGE[mod] || mod;
}

// ── Node ──────────────────────────────────────────────────────────────────────────

// Node builtins reachable without the `node:` prefix. A bare `import 'fs'` is not a dependency.
const NODE_BUILTINS = Object.freeze(new Set(`
assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel
dns domain events fs http http2 https inspector module net os path perf_hooks process punycode
querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm
wasi worker_threads zlib
`.trim().split(/\s+/)));

// A legal npm package name, scoped or plain. Used to REJECT a match rather than to resolve one: a
// specifier carrying a scheme, a space, a newline or an uppercase letter is not a package, so
// whatever produced it was not an import. See the guard comment at the node scan below.
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/;

// ── External binaries ─────────────────────────────────────────────────────────────

// Non-ubiquitous commands a skill may shell out to. Deliberately NOT including git, node, npm,
// npx, python3, pip, bash, sh, sed, awk, grep, curl: those are either the substrate itself or
// present on any developer machine, so declaring them would be ceremony with no failure mode.
// Extend this list when a skill starts needing a tool that can genuinely be absent.
const EXTERNAL_BINARIES = Object.freeze([
  'psql', 'pg_dump', 'pg_restore', 'pg_isready', 'createdb', 'dropdb',
  'kubectl', 'helm', 'tsh', 'aws', 'gh', 'glab', 'docker', 'jq', 'yq',
  'launchctl', 'osascript', 'sqlite3', 'pandoc', 'rsync', 'ffmpeg', 'ffprobe', 'pbcopy', 'plutil',
]);
// The criterion for membership, written down after it was measured rather than left implicit:
// a name belongs here when it might genuinely BE ABSENT on a machine that otherwise runs this
// repo. Every entry above fails to ship by default somewhere that matters (jq, tsh, pandoc, the
// postgres client tools, ffmpeg). `curl` was measured against that bar and deliberately left OUT:
// adding it finds six real invocations repo-wide (react-components, react-native and remotion's
// fetch scripts, sk-hello's readiness probe, office-viz's and shp-dev-frontend's SKILL.md)
// and no false positives, but it is present on macOS, on Windows 10+ as curl.exe, and in every
// mainstream base image, so detecting it would report six skills as at-risk over a dependency that
// is effectively never missing. A skill whose whole payload is one curl call may still DECLARE it
// by hand - remotion does, with the reason - since over-declaring is allowed and `declared-but-unused`
// only guards sibling_skills.
//
// The agent CLIs — `claude`, `codex`, `gemini` — were measured too and are excluded for a STRONGER
// reason than ubiquity: they are the highest-collision words in this repo. Adding them finds hits in
// eleven skills, and the sample immediately shows the problem: sk-nanobanana-generator
// "invokes gemini" only because `gemini` is the MODEL family it names, and `claude` appears in
// Claude-Code prose in nearly every SKILL.md. Ten of the eleven already carry manifests, so the
// detection would also have to add ten ratchet keys for findings that are mostly wrong. deep-thinker
// really does probe one (`shutil.which("claude")` at subagent.py:57, raising when absent) and
// declares it by hand, which is the right shape for a name a scanner cannot judge.
//
// `ffprobe` is listed SEPARATELY from ffmpeg even though one install usually brings both, because
// the code that needs them probes them separately and reports them separately:
// sk-flow-automator/scripts/storyboard.py:1979 does
// `shutil.which("ffmpeg"), shutil.which("ffprobe")` and hard-exits naming whichever is missing.
// Three skills invoke it (flow-automator, shorts-pipeline, youtube-automator) and all three already
// carry an `undeclared-binary` ratchet key, so detecting it adds no new key — the granularity is
// `<skill>|<check>`, not per-binary.

// ── Helpers ───────────────────────────────────────────────────────────────────────

/**
 * Strip comments and docstrings, so a name found in the remainder is found in actual code.
 * Ported from sk-inherit/scripts/inherit.mjs — the two must agree on what "in code" means,
 * which tests/skills/skill-portability.test.mjs asserts.
 *
 * @param {string} text
 * @param {string} file
 * @returns {string}
 */
export function stripComments(text, file) {
  // Blanked, not deleted: every removed character becomes a space and every newline is kept, so an
  // offset into the stripped text is still a valid offset into the original. That is what lets the
  // scanner report `file:line` for the CODE occurrence of a name instead of for the first occurrence
  // anywhere — which, in a file whose module docstring lists the same names, is a different place
  // entirely and sends the reader to the wrong line.
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  if (/\.py$/i.test(file)) {
    return text
      .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, blank)
      // The leading class MUST include \n and \r: without the `m` flag `^` matches only offset 0, so
      // a class of just [ \t] silently skips every comment that starts at column 0 — which is most
      // of them, and made the whole `code-comment` tier report banner comments as live code.
      .replace(/(^|[ \t\r\n])#[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
  }
  if (/\.(mjs|js|cjs|ts|json)$/i.test(file)) {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, blank)
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
  }
  if (/\.(sh|bash|ya?ml|toml)$/i.test(file)) {
    // \r\n in the leading class for the same reason as the python branch above: with no `m` flag,
    // `^` is offset 0 only, so `[ \t]` alone skips every comment starting at column 0.
    return text.replace(/(^|[ \t\r\n])#[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
  }
  if (/\.mdx?$/i.test(file)) {
    // `[Source: …]` is this repo's citation convention: it records WHERE a rule came from — the
    // sibling SKILL.md a section mirrors, the file a constant was read from. It is the prose twin of
    // the "Adapted from …" provenance comment, and reading it as an invocation manufactures
    // dependency edges out of a bibliography. sk-cli-orchestrator alone cites five siblings
    // it never calls that way.
    return text.replace(/\[Source:[^\]]*\]/g, blank);
  }
  return text;
}

/** POSIX-form relative path, so a finding reads the same on Windows. */
function posix(p) {
  return p.split(sep).join('/');
}

/** 1-indexed line number of a character offset. */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Every file under a skill folder, relative to it, POSIX-form and sorted.
 *
 * @param {string} skillDir
 * @returns {Array<{rel: string, abs: string, inScripts: boolean}>}
 */
export function walkSkillFiles(skillDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;                       // a broken link is not a file this skill owns
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = posix(relative(skillDir, abs));
      out.push({ rel, abs, inScripts: rel === 'scripts' || rel.startsWith('scripts/') });
    }
  };
  walk(skillDir);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** Module names that resolve inside this skill, so an import of one is not third-party. */
function localPythonModules(files) {
  const local = new Set();
  for (const f of files) {
    if (!f.rel.endsWith('.py')) continue;
    const parts = f.rel.split('/');
    const base = parts[parts.length - 1];
    local.add(base.slice(0, -3));                       // sibling module
    if (base === '__init__.py' && parts.length >= 2) {
      local.add(parts[parts.length - 2]);               // package directory
    }
  }
  return local;
}

/**
 * The markdown text with everything OUTSIDE a fenced code block blanked out.
 *
 * Blanked, not removed, so an offset into the result is still valid in the original and `ev()` keeps
 * reporting the true line. Used where prose and executable content must be told apart — see the
 * binary scan, where a command named in a prohibition ("Never raw `kubectl`") sits in prose and a
 * command the agent is told to run sits in a fence.
 */
function fencedBlocks(text) {
  const lines = text.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        return ' '.repeat(line.length);          // the fence marker itself is not content
      }
      return inFence ? line : ' '.repeat(line.length);
    })
    .join('\n');
}

/**
 * Offset of `bin` spelled as an INVOCATION inside a markdown inline code span, or -1.
 *
 * An invocation means: inside single or double backticks, on a line outside any fence, at a command
 * position, and followed by at least one more token WITHIN THE SAME SPAN. That last condition is the
 * whole discriminator — it separates "`gh pr create --base <base>`" from the bare nouns that make up
 * most prose mentions of a tool in this repo ("no `yq`", "run `pg_dump`", "the `psql` equivalents").
 * The measurement behind it is recorded at the binary scan in `scanSkill`.
 *
 * Fenced content is skipped rather than matched, so a binary already found at `wired` tier is never
 * re-reported here; the caller tries the fenced pass first regardless.
 *
 * @param {string} text - markdown, comments already stripped
 * @param {string} bin
 * @returns {number} offset into `text`, or -1
 */
function inlineInvocation(text, bin) {
  const re = new RegExp(`(?:^|[|&;(\\s$])${bin}\\s+\\S`);
  let offset = 0;
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence) {
      for (const span of line.matchAll(/`{1,2}([^`]+)`{1,2}/g)) {
        const m = re.exec(span[1]);
        if (m) return offset + span.index + span[0].indexOf(span[1]) + m.index;
      }
    }
    offset += line.length + 1;
  }
  return -1;
}

/**
 * Index of `name` in `text` where it is NOT part of a longer skill name.
 *
 * Skill names nest — `sk-cli` is a prefix of both `sk-cli-executor` and
 * `sk-cli-orchestrator`, and `sk-jira-connector` of nothing today but of anything
 * tomorrow. A plain `indexOf` therefore reports a phantom edge to the shorter skill from every
 * file that names the longer one. `\b` is no help: `-` is a non-word character, so `\bsk-cli\b`
 * still matches inside `sk-cli-executor`. `-` must be excluded from the boundary explicitly.
 *
 * @returns {number} offset, or -1
 */
export function bareNameIndex(text, name) {
  return bareNameHit(text, name).index;
}

/**
 * Where `name` appears as a standalone skill name, and whether that occurrence is the WHOLE of a
 * quoted string literal.
 *
 * The `exact` flag is what separates structured data from prose held in a string. A routing table
 * value — `{"skill": "sk-feasibility-probe"}` — is the entire literal, and calling that wiring
 * is right. A charter principle is also a string literal, and reads:
 *
 *   "one execute per wake — … and NEVER runs sk-get-plan-done, sk-get-things-done,
 *    sk-commander or a BMAD workflow inline: a max-runtime kill can re-enter a nested engine
 *    run from scratch and double-commit."
 *
 * Treating those as `wired` declared three engines as dependencies of sk-agent-mission-loop
 * that its own charter FORBIDS it from running. Same for a findings hint ("create it with
 * sk-agent-creator"). Comment-stripping cannot help — this is a live string, not a comment.
 *
 * @returns {{index: number, exact: boolean}} index -1 when absent
 */
export function bareNameHit(text, name) {
  const re = new RegExp(`(?<![A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'g');
  let first = -1;
  for (const m of text.matchAll(re)) {
    // `artifacts/runs/<skill-id>/…` is the framework's own run-directory convention (CLAUDE.md:
    // RUNBASE = $ARTIFACTSBASE/artifacts/runs/<skill-id>), so the name there LABELS a folder — it
    // does not invoke anything. A captured sample path in a parse test would otherwise read as a
    // dependency on whichever skill's run the sample came from.
    if (/artifacts[\\/]runs[\\/]$/.test(text.slice(Math.max(0, m.index - 15), m.index))) continue;
    const before = text[m.index - 1];
    const after = text[m.index + name.length];
    // An exact literal outranks an earlier prose mention, so keep looking even after a hit.
    if (before && before === after && /["'`]/.test(before)) return { index: m.index, exact: true };
    if (first === -1) first = m.index;
  }
  return { index: first, exact: false };
}

/**
 * Python module name -> the skills whose scripts/ provide it.
 *
 * WHY THIS IS LOAD-BEARING. The `sys.path` splice is this repo's dominant cross-skill idiom, and
 * the imported name gives no hint of its origin: `import query_runner` looks exactly like a pip
 * package. Without this index the scanner reports `query_runner`, `config_loader` and
 * `db_connection` as third-party packages to pip-install — which is the wrong dependency class,
 * the wrong remediation, and would hide the single edge type this card exists to make visible.
 *
 * A name may map to several skills (seven skills ship a `scope.py`), so resolution is done at the
 * call site using the skill names the same file mentions.
 *
 * @param {Map<string, Array<{rel: string, inScripts: boolean}>>} filesBySkill
 * @returns {Map<string, string[]>}
 */
export function buildModuleOwners(filesBySkill) {
  const owners = new Map();
  for (const [skill, files] of filesBySkill) {
    for (const f of files) {
      if (!f.inScripts || !f.rel.endsWith('.py')) continue;
      const base = f.rel.split('/').pop().slice(0, -3);
      if (base === '__init__') continue;
      const list = owners.get(base) || [];
      if (!list.includes(skill)) list.push(skill);
      owners.set(base, list);
    }
  }
  return owners;
}

// ── The scan ──────────────────────────────────────────────────────────────────────

/**
 * Scan one skill for every dependency edge its files reveal.
 *
 * @param {string} repoRoot
 * @param {{skill: string, dir: string, relDir: string}} entry
 * @param {string[]} universe - every known skill name, for bare-name reference detection
 * @returns {{
 *   skill: string,
 *   files: Array<{rel: string, abs: string, inScripts: boolean}>,
 *   python: Array<{module: string, package: string, evidence: object}>,
 *   node: Array<{package: string, evidence: object}>,
 *   binaries: Array<{name: string, confidence: 'wired'|'prose', evidence: object}>,
 *   skills: Array<{skill: string, how: string, confidence: string, form: string, evidence: object}>,
 *   frameworkFiles: Array<{path: string, evidence: object}>,
 *   relativeCrossSkill: Array<{evidence: object, target: string}>,
 *   requirementsEscapes: Array<{evidence: object, target: string}>,
 *   hasScripts: boolean,
 * }}
 */
export function scanSkill(repoRoot, entry, universe, ctx = {}) {
  const files = ctx.files || walkSkillFiles(entry.dir);
  const moduleOwners = ctx.moduleOwners || new Map();
  const localPy = localPythonModules(files);
  const self = entry.skill;

  const python = new Map();
  const node = new Map();
  const binaries = new Map();
  /** @type {Map<string, {skill: string, how: string, confidence: string, form: string, evidence: object}>} */
  const skills = new Map();
  const frameworkFiles = new Map();
  const relativeCrossSkill = [];
  const requirementsEscapes = [];

  // Strongest wins, so one code hit is never downgraded by a later prose hit. At equal confidence,
  // `import` outranks `subprocess`: it is the more consequential classification (an import breaks
  // immediately when the sibling is absent, a subprocess call degrades), and both spellings of the
  // same edge are routinely present in one file.
  const RANK = { prose: 0, 'code-comment': 1, ambiguous: 2, documented: 3, wired: 4 };
  const HOW_RANK = { prose: 0, handoff: 1, 'cli-verb': 2, subprocess: 3, import: 4 };
  // Test scope is a property of the WHOLE edge, not of whichever evidence happens to win the rank
  // contest, so it cannot be carried on the winning row — a runtime hit that loses on rank would
  // leave the edge marked test-only, and a first-seen low-tier hit would mark it runtime forever.
  // Both sides are accumulated across every file and the verdict is taken once, at the end.
  //
  // Only `wired`/`documented` evidence counts as a runtime claim, because only those two tiers are
  // dependency claims at all — the rest are reported and never written. A docstring naming the
  // caller ("the sk-cli-orchestrator loop uses this") must not promote an edge whose sole
  // real use is a test fixture into a runtime dependency of the shipped skill.
  const runtimeClaim = new Set();
  const testEvidence = new Set();
  const noteSkill = (name, how, confidence, form, evidence, candidates = null, fromTest = false) => {
    const claim = confidence === 'wired' || confidence === 'documented';
    if (claim) (fromTest ? testEvidence : runtimeClaim).add(name);
    const prev = skills.get(name);
    if (prev) {
      if (RANK[prev.confidence] > RANK[confidence]) return;
      if (RANK[prev.confidence] === RANK[confidence] && HOW_RANK[prev.how] >= HOW_RANK[how]) return;
    }
    skills.set(name, { skill: name, how, confidence, form, evidence, candidates });
  };

  for (const f of files) {
    if (!SCANNED_EXT.test(f.rel)) continue;
    // The manifest is the DECLARATION side; scanning it would make every declaration its own
    // evidence. `declared-but-unused` could then never fire — the row naming a sibling is itself a
    // bare-name sighting of it — and `bundle:` already excludes the file for the same reason a
    // hash cannot include itself.
    if (f.rel === MANIFEST_NAME) continue;
    // `improvements/` and `evals/` travel with the skill but declare nothing about what it needs,
    // and both are DENSE in other skills' names:
    //   improvements/  — the self-improve funnel's audit trail. An `observation:` cites where the
    //                    auditor looked ("…/sk-agent-master/SKILL.md:41 shows master is
    //                    auto-created earlier"), which is a record of an investigation, not a
    //                    dependency. Nothing here is ever run.
    //   evals/         — trigger-benchmark queries, whose `should_trigger: false` cases name
    //                    COMPETING skills on purpose. Reading those as edges inverts their meaning.
    // Both stay in `bundle:` — they are part of the skill; they are just not evidence.
    if (NON_EVIDENCE_DIR.test(f.rel)) continue;
    let text;
    try {
      text = readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    // Citations are stripped from the TEXT, not just from `code`: a `[Source: …]` block is not
    // evidence of anything at any tier, so neither the path scan nor the bare-name scan may see it.
    // Blanking preserves offsets and line count, so `ev()` still reports the right line.
    if (/\.mdx?$/i.test(f.rel)) text = stripComments(text, f.rel);
    // Stripped for EVERY file type the stripper understands, not only those under scripts/. A comment
    // is a comment wherever it lives, and the previous `inScripts` gate meant a path inside a
    // `skill.yaml` comment counted as `documented` — the tier that gets auto-written. The bmad
    // descriptors carry exactly that: a co-ownership note reading "the canonical body lives with
    // sk-bmad-pm (.agents/skills/sk-bmad-pm/rules/rule.bmad-first.md)", which is
    // provenance, not an invocation.
    const code = stripComments(text, f.rel);
    const ev = (index) => ({ file: f.rel, line: lineAt(text, index) });
    // Evidence found under a `tests` path segment describes the test suite, not the shipped
    // behaviour — see the `testOnly` note on noteSkill and the identical rule for python imports.
    const fromTest = f.rel.split('/').includes('tests');
    // `wired` claims the file EXECUTES the reference, so it is reserved for languages this scanner
    // can actually read. A skill name inside a data file is a string in a blob: sometimes a routing
    // table, but just as often an eval fixture's natural-language query
    // (`sk-cli-executor/scripts/trigger-eval-queries.json`) or a captured sample. Calling
    // those `wired` would auto-write a dependency the skill does not have.
    const isCode = /\.(mjs|js|cjs|py|sh|bash)$/i.test(f.rel);
    // Skill names this ONE file names in code — used below to attribute a borrowed python module
    // to the skill that owns it when several skills ship a module of that name.
    const fileSkills = new Set();

    // ── cross-skill, by PATH. Two spellings, because both are in live use:
    //   literal   ".agents/skills/<other>/scripts"
    //   segmented os.path.join(ROOT, '.agents', 'skills', "<other>", "scripts")
    // The segmented form is the one the repo actually favours (it is the portable spelling), and a
    // regex that only knows the literal form misses every Python connector splice in the tree.
    // BOTH parents are matched, not just the current one. The active tree is `.agents/skills` and
    // the parked tree is still `.sidekicks/skill-offloaded`, so neither prefix alone covers the
    // repo — and a skill authored before the move keeps its old spelling until someone rewrites it.
    // A regex that recognised only the new parent would report zero cross-skill edges for those and
    // silently pass `skill doctor`, which is the failure this scanner exists to prevent.
    const pathRe = /\.(?:agents|sidekicks)[\\/]skill(?:s|-offloaded)[\\/]([A-Za-z0-9._-]+)/g;
    const segmentedRe =
      /["']\.(?:agents|sidekicks)["']\s*,\s*["']skills?["']\s*,\s*["']([A-Za-z0-9._-]+)["']/g;
    for (const re of [pathRe, segmentedRe]) {
      for (const m of text.matchAll(re)) {
        if (m[1] === self) continue;
        if (!universe.includes(m[1])) continue;     // a placeholder like <skill> is not an edge
        // Present in the STRIPPED text means the path is live, not commented out. Checked for every
        // file now, so a commented path is demoted rather than trusted — see the note on `code`.
        const uncommented = code.includes(m[0]);
        const inCode = f.inScripts && uncommented;
        const window = text.slice(Math.max(0, m.index - 400), m.index + 400);
        // A sys.path splice or a language-level import is the only form vendoring would fix;
        // everything else crosses a process boundary and degrades on its own.
        // A path is always an invocation of some kind — inside scripts/ it is executed, inside
        // SKILL.md the agent is told to execute it. Only a bare name can be mere prose.
        const how = /sys\.path\.(insert|append)/.test(window) || /\bfrom\s+\S+\s+import\b/.test(window)
          ? 'import'
          : 'subprocess';
        if (inCode) fileSkills.add(m[1]);
        // A PATH to another skill written in SKILL.md is an invocation the agent is told to run —
        // `documented`, a real edge. A bare NAME in the same file is a cross-reference. That
        // distinction is what separates the ~42 genuine prose-documented dependencies from the
        // "see also" mentions, and reporting both alike would drown the report in the latter.
        // A path inside a COMMENT is `code-comment` wherever the comment lives — under scripts/ or in
        // a descriptor. Only a live path outside scripts/ is `documented`, i.e. an invocation the
        // SKILL.md tells the agent to run.
        const confidence = !uncommented
          ? 'code-comment'
          : (f.inScripts ? 'wired' : 'documented');
        noteSkill(m[1], how, confidence, 'path', ev(m.index), null, fromTest);
      }
    }

    // ── cross-skill, by RELATIVE path, IN CODE. Never acceptable there: it breaks the moment
    // either folder moves, and no repo-root resolution rescues it. Two spellings, because
    // `../../<other-skill>/` (climbing out of scripts/ into a sibling) names no `skills/` segment
    // at all, so a pattern anchored on that segment would miss every real instance.
    //
    // Prose is deliberately exempt. A markdown cross-link between two sibling skill folders
    // (`[x](../sk-self-improve/SKILL.md)`) resolves wherever both folders sit together and
    // is how markdown links are written; flagging those would bury the executable breaks under
    // hundreds of documentation links. requirements.txt is exempt here too — it has its own,
    // sharper check, and one problem should produce one finding.
    if (/\.(mjs|js|cjs|py|sh|bash)$/i.test(f.rel)) {
      for (const m of code.matchAll(/(?:\.\.[\\/])+(?:(?:skills|skill-offloaded)[\\/])?([A-Za-z0-9._-]+)[\\/]/g)) {
        if (m[1] === self) continue;
        if (!universe.includes(m[1])) continue;
        relativeCrossSkill.push({ evidence: ev(m.index), target: m[0] });
      }
    }

    // ── cross-skill, by BARE NAME. Catches the ~42 edges stated only in prose, which carry no
    // path at all. Lower confidence by construction — see the tier note in the header.
    for (const cand of universe) {
      if (cand === self) continue;
      // A plain substring search is wrong here, because skill names nest: `sk-cli` is a
      // prefix of `sk-cli-executor` and `sk-cli-orchestrator`, so every file that
      // named either one silently reported an edge to `sk-cli` as well. `\b` does not help —
      // `-` is a non-word character, so `\bsk-cli\b` still matches inside the longer name.
      // The boundary has to exclude `-` explicitly on both sides.
      const idx = bareNameIndex(text, cand);
      if (idx === -1) continue;
      // No short-circuit on an already-recorded name: noteSkill ranks by confidence, and files are
      // walked alphabetically, so SKILL.md lands before scripts/. Skipping a seen name here would
      // permanently pin every edge at the `prose` tier it happened to be found in first.
      if (f.inScripts) {
        // Prefer the offset of the CODE occurrence. stripComments blanks rather than deletes, so
        // this offset is still valid in the original text — see its header note.
        const hit = bareNameHit(code, cand);
        const codeIdx = hit.index;
        const inCode = codeIdx !== -1;
        if (inCode && isCode) fileSkills.add(cand);
        // A bare NAME in code is a HANDOFF, not an invocation: the commonest shape is a routing
        // table (`{"skill": "sk-feasibility-probe", "engine": "sk-get-things-done"}`)
        // that records which skill the work is routed to. Calling that `subprocess` would claim this
        // skill executes the other one, which it does not — and would put the wrong sentence in
        // every `degraded:` the generator writes. A PATH is what indicates execution.
        // `wired` needs all three: a real code file, an occurrence the comment-stripper kept, and a
        // name that is the WHOLE string literal rather than a word inside a sentence.
        const confidence = inCode && isCode && hit.exact ? 'wired' : 'code-comment';
        noteSkill(cand, 'handoff', confidence, 'name', ev(inCode ? codeIdx : idx), null, fromTest);
      } else {
        noteSkill(cand, 'prose', 'prose', 'name', ev(idx), null, fromTest);
      }
    }

    // ── python imports
    if (/\.py$/i.test(f.rel)) {
      const lines = code.split('\n');
      let offset = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const at = offset;
        offset += line.length + 1;
        // `from . import x` and `from .mod import x` are intra-skill by definition.
        const from = /^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+(.+)$/.exec(line);
        const imp = /^\s*import\s+([A-Za-z_][A-Za-z0-9_.,\s]*)$/.exec(line);
        const mods = [];
        if (from) {
          // `from google import genai` names the same distribution as `from google.genai import
          // types`, and this repo contains both spellings in the same file. Only the second carries
          // the member in the module path, so for a namespace root the imported NAME has to be
          // folded in — otherwise one spelling resolves to `google-genai` and the other to `google`,
          // which is not a package at all.
          if (PY_NAMESPACE_ROOTS.has(from[1])) {
            for (const part of from[2].split(',')) {
              const name = part.trim().replace(/[()]/g, '').split(/\s+as\s+/)[0].trim();
              if (/^[A-Za-z_]\w*$/.test(name)) mods.push(`${from[1]}.${name}`);
            }
          } else {
            mods.push(from[1]);
          }
        }
        if (imp) {
          for (const part of imp[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/)[0].trim();
            if (name) mods.push(name);
          }
        }
        for (const full of mods) {
          const root = full.split('.')[0];
          if (!root || PY_STDLIB.has(root) || localPy.has(root) || root === self) continue;

          // A module another skill's scripts/ provides is a BORROWED SIBLING MODULE, not a pip
          // package. Attribute it to the skill this same file names in code when that is
          // unambiguous; otherwise record every candidate owner so the human can pick.
          const owners = (moduleOwners.get(root) || []).filter((o) => o !== self);
          if (owners.length) {
            const named = owners.filter((o) => fileSkills.has(o));
            // Unambiguous two ways: exactly one skill provides the module at all, or exactly one of
            // the candidates is also named in this same file.
            const resolved = owners.length === 1 ? owners[0] : (named.length === 1 ? named[0] : null);
            if (resolved) {
              noteSkill(resolved, 'import', 'wired', `module:${root}`, { file: f.rel, line: i + 1 }, null, fromTest);
            } else {
              // AMBIGUOUS: seven skills ship a `scope.py` and five a `config_loader.py`, so a bare
              // `import config_loader` in a file that names no skill could come from any of them.
              // Reported at its own tier and NEVER written into a manifest — attributing it to all
              // candidates would declare four dependencies the skill does not have, which is worse
              // than admitting the scanner cannot tell.
              for (const owner of owners) {
                // Each ambiguous edge carries the FULL candidate list, so audit can close the whole
                // set the moment one of them is declared. Without it the winning candidate — which
                // ranks higher and never lands in this tier — is invisible to that check, and the
                // losers keep demanding an answer that is already in the file.
                noteSkill(owner, 'import', 'ambiguous', `module:${root}`, { file: f.rel, line: i + 1 }, owners, fromTest);
              }
            }
            continue;
          }

          // A module imported ONLY from tests/ is a test dependency, not a runtime one. Declaring
          // pytest as something a lifted skill needs in order to run would be simply false, and
          // would make `skill heal` install a test harness to satisfy a runtime check.
          // A namespace member is keyed on TWO segments, so `google.genai` and a hypothetical
          // `google.cloud.storage` stay separate rows. Everything else keys on its root, which is
          // what makes `import yaml` and `from yaml import safe_load` one dependency.
          const key = PY_NAMESPACE_ROOTS.has(root) ? full.split('.').slice(0, 2).join('.') : root;
          const prev = python.get(key);
          if (prev) {
            if (!fromTest) prev.testOnly = false;      // a runtime import outranks a test one
            continue;
          }
          python.set(key, {
            module: key,
            package: pipPackageFor(key),
            testOnly: fromTest,
            evidence: { file: f.rel, line: i + 1 },
          });
        }
        void at;
      }
    }

    // ── node bare imports
    //
    // Two guards, because a bare `from ['"]…['"]` match is not evidence of an import.
    //
    // 1. `from` needs an IMPORT/EXPORT in front of it, inside the same statement. Without that,
    //    ANY string literal whose last word is "from" opens a match, and the `[^'"]+` capture then
    //    runs to the NEXT quote in the file — across newlines, since the class admits them. Real
    //    case: sk-inherit/scripts/inherit.mjs:1277 holds `detail: "no source to patch from"`,
    //    and the reported npm package was 34 lines of source code beginning ' }); continue; }'.
    //    The lookback stops at the previous `;` or blank line, and DELIBERATELY not at a brace: a
    //    multi-line `import {\n  a,\n  b,\n} from 'x'` has braces between its `import` and its
    //    `from`, so a brace-bounded window would cut the keyword off and reject a real import.
    // 2. The resolved root must be a legal npm package name. This is the backstop that catches any
    //    capture the first guard lets through, and it is what rejects a URL specifier:
    //    sk-knowledge/scripts/knowledge.mjs:299 imports mermaid from a jsdelivr CDN inside a
    //    template-string `<script type="module">` that runs in the BROWSER, so `https:` was being
    //    reported as an npm dependency of a Node skill. A scheme can never be a package name.
    //
    // MEASURED repo-wide: 7 raw matches, 5 legal (`@swc/core` twice, `puppeteer` twice,
    // `playwright`) and 2 illegal — exactly the two above. No real dependency is lost.
    if (/\.(mjs|js|cjs)$/i.test(f.rel)) {
      const specRe = /(?:(from)\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
      for (const m of code.matchAll(specRe)) {
        if (m[1]) {
          const window = code.slice(0, m.index).split(/;|\n\s*\n/).pop();
          if (!/\b(?:import|export)\b/.test(window)) continue;
        }
        const spec = m[2];
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
        const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!NPM_PACKAGE.test(root)) continue;
        if (NODE_BUILTINS.has(root) || node.has(root)) continue;
        node.set(root, { package: root, evidence: ev(m.index) });
      }
    }

    // ── external binaries, at a command position only. Matching anywhere would report the word
    // "docker" in prose; requiring a shell command boundary keeps it to actual invocations.
    //
    // Two tiers in MARKDOWN, because a fence-only rule was measurably too narrow and a prose-wide
    // rule measurably too broad:
    //
    //   `wired` — a fenced block, or any code file. What the agent is told to execute. Prose is not a
    //     fence for a reason: sk-agent-mission-loop's safety-floor table reads "Never raw
    //     `kubectl`/`psql`/`tsh kube login`", which a prose-wide first pass turned into three declared
    //     dependencies — a heal report telling someone to install the very tools the skill's contract
    //     says it must never run.
    //
    //   `prose` — an INLINE code span in which the binary is followed by at least one more token, so
    //     it is spelled as an invocation ("gh pr create --base …") rather than named as a bare noun.
    //     Reported, never written: a human declares it or records it under `not_required.binaries`.
    //
    // The inline tier exists because fences alone MISS real dependencies with real failure modes.
    // sk-git-ship's whole PR step is `gh pr create` / `glab mr create`, written as inline spans
    // in a bullet list; under a fence-only rule the skill scanned as needing NOTHING, so it was not
    // even manifest-required and its two forge CLIs could never be declared at all.
    //
    // MEASURED, both ways. Counting every inline span (any position, bare names included) yields 25
    // skill/binary pairs of which 9 are noise — 7 of those bare nouns inside a prohibition or an
    // absence statement ("no `yq`", "Do not use this skill to run `pg_dump`", "the `psql`
    // equivalents"). Requiring a following token kills 7 of those 9.
    //
    // The tier is DELIBERATELY NARROW, and the repo-wide result shows how narrow: exactly 5 pairs
    // land here. Three are real — sk-git-ship's `gh` and `glab`, whose only spelling anywhere
    // is prose, and sk-database-drift's `pg_dump`, which independently reproduces a binary a
    // human had already hand-declared. Two are the inverse — sk-agent-mission-loop's
    // "Never raw … `tsh kube login`" prohibition, and sk-agent-schedule-planner's
    // `launchctl bootstrap`, which the TEMPLATE's own header carries and a human runs. All five are
    // answered in committed manifests, declared or recorded under `not_required.binaries`; there is
    // no residue. Everything else that a first draft of this tier reported turned out to be
    // `wired` in a script and only LOOKED like prose because of the shadowing bug fixed above.
    // The HIGHEST tier across all files wins, not the first hit. First-wins would let a `prose`
    // mention in SKILL.md — walked before scripts/ — permanently shadow a real invocation in a
    // script: sk-hello names `jq -r` in prose at SKILL.md:57 AND probes for it in
    // scripts/readiness.mjs, and first-wins downgraded it to a question a human had to answer about
    // a dependency the scanner could already see wired. Same failure as the `testOnly` verdict in
    // the sibling scan, which is resolved once at the end for the same reason.
    // JSON is DATA, never a command surface — nothing executes a `.json` file, so a binary name
    // inside one is a string in a list or a sentence, not an invocation. Three hits repo-wide, all
    // false, and two of them were actively HARMFUL rather than merely noisy: `VERSION.json`'s
    // `description` field is a copy of SKILL.md's frontmatter description, so
    // sk-shp-backup-table and sk-teleport-database-connector both reported `pg_dump`
    // from VERSION.json:4 — and because VERSION.json is walked before scripts/, that string
    // SHADOWED the real evidence (the shp one is a PROHIBITION, "NOT for full database snapshots or
    // pg_dump operations"; the teleport one genuinely shells out to it from a script). The third is
    // sk-inherit/assets/py-stdlib.json:261, where `sqlite3` is the name of a Python stdlib
    // MODULE in a lookup table. The one shape that could carry a real command is package.json's
    // `scripts:` block; both skills that ship a package.json (react-components, react-native) run
    // only `node` and `bash` there, and both are deliberately outside EXTERNAL_BINARIES anyway.
    // The skip is scoped to THIS loop, not to the file: a `.json` under scripts/ is still read by
    // the framework-file scan below, which is about paths rather than commands.
    const isMarkdown = /\.mdx?$/i.test(f.rel);
    if (!/\.json$/i.test(f.rel)) {
      for (const bin of EXTERNAL_BINARIES) {
        const held = binaries.get(bin);
        if (held && held.confidence === 'wired') continue;
        // MEASURED AND NOT NARROWED FURTHER. The repo has exactly one false positive here:
        // office-viz's Minecraft theme declares `var helm = boxMesh(...)` (a voxel helmet) and
        // passes it as `bodyG.add(helm)`, which is indistinguishable from a command by shape. An
        // assignment filter does not catch the second spelling, and the shapes that would — "only
        // inside a string literal", "only in a .sh/.py file" — either still match (office-viz builds
        // HTML in template literals full of officer prose) or drop a true positive
        // (sk-hello's readiness.mjs probes jq from a .mjs). One identifier is not worth a
        // heuristic that can hide a real spawn: it is answered where the design says to answer it,
        // in the skill's `not_required.binaries` with the reason.
        const re = new RegExp(`(?:^|[|&;(\\s"'\`$])${bin}(?=[\\s"'\`)]|$)`, 'm');
        const m = re.exec(isMarkdown ? fencedBlocks(code) : code);
        if (m) {
          binaries.set(bin, { name: bin, confidence: 'wired', evidence: ev(m.index) });
          continue;
        }
        if (!isMarkdown || held) continue;
        const inline = inlineInvocation(code, bin);
        if (inline !== -1) {
          binaries.set(bin, { name: bin, confidence: 'prose', evidence: ev(inline) });
        }
      }
    }

    // ── repo-root framework files. Disambiguated by EXISTENCE rather than by guessing: a
    // `scripts/x.mjs` that exists inside the skill is the skill's own file; one that exists only
    // at the repo root is a framework dependency. That test is decisive and needs no convention.
    //
    // Only scripts/ and SKILL.md are searched. A path named in a skill.yaml comment or a reference
    // doc is documentation about the framework, not something a run touches — reporting those turns
    // every architectural note into a dependency finding.
    if (f.inScripts || f.rel === 'SKILL.md') {
    // `/` is in the leading class on purpose: the commonest spelling is "$ROOT/scripts/x.py", so a
    // pattern that refuses a preceding slash misses nearly every real reference. It also lets a
    // longer path (…/skills/other/scripts/cli.py) match its tail, which the existence check below
    // then discards — cheap, and far safer than trying to exclude those by pattern.
    // Only `scripts/` and `lib/` — the two repo-root trees that hold Sidekicks CODE.
    //
    // MEASURED, not assumed: `bmad/` was tried here too, since the vendored BMAD framework is a real
    // repo-root dependency of the developer pack. It produced 8 findings of which exactly ONE was a
    // read (sk-bmad-developer, "Config: bmad/bmm/config.yaml"); the other 7 were the same
    // sentence saying the OPPOSITE — "the resolver hard-excludes bmad/bmm/config.yaml", "is **never**
    // read as the cluster-ops config", "NOT BMAD's bmad/bmm/config.yaml". That path is named across
    // this repo almost only to warn about it, which is a direct consequence of the CLAUDE.md rule
    // naming the trap, and two of the false hits would have been auto-written into already-committed
    // manifests. A 7:1 ratio is not a detector. The one real edge is hand-declared instead.
    const rootRe = /(?:^|[\s"'`(=/])((?:scripts|lib)\/[A-Za-z0-9._/-]+\.(?:mjs|js|py|sh|json|plist|ya?ml))/g;
      for (const m of code.matchAll(rootRe)) {
        const p = m[1];
        if (SANCTIONED_ROOT_PATHS.includes(p) || frameworkFiles.has(p)) continue;
        // A tail whose PREFIX names a skill folder is a skill path, never a repo-root file. The
        // existence check below was meant to discard these, and does whenever the tail happens not
        // to exist at the root — but it cannot when the framework owns a file of the same name.
        // Exactly one such collision exists, and it is the one the P5 move is about:
        // sk-hello's retired config-schema.mjs documented the mail_sender schema as living
        // at '.agents/skills/sk-report/scripts/send-mail.py', a path that does not exist
        // yet, while 'scripts/send-mail.py' DOES exist at the root — so the tail matched and hello
        // was reported as depending on a framework file it never reads. The file is gone (the audit
        // reads the CLI now), but the collision shape it demonstrated is why this guard stays.
        const prefix = code.slice(0, m.index + m[0].indexOf(p));
        if (/\.(?:agents|sidekicks)\/skill(?:s|-offloaded)\/[A-Za-z0-9._-]+\/$/.test(prefix)) continue;
        if (existsSync(join(entry.dir, ...p.split('/')))) continue;    // the skill's own file
        if (!existsSync(join(repoRoot, ...p.split('/')))) continue;    // neither — not an edge
        frameworkFiles.set(p, { path: p, evidence: ev(m.index) });
      }
    }

    // ── a requirements.txt that points outside its own skill. The manifest itself has to travel.
    if (/(^|\/)requirements[^/]*\.txt$/i.test(f.rel)) {
      for (const m of text.matchAll(/^\s*-r\s+(\S+)\s*$/gm)) {
        if (m[1].split(/[\\/]/).includes('..')) {
          requirementsEscapes.push({ evidence: ev(m.index), target: m[1] });
        }
      }
    }
  }

  return {
    skill: self,
    files,
    python: [...python.values()].sort((a, b) => (a.module < b.module ? -1 : 1)),
    node: [...node.values()].sort((a, b) => (a.package < b.package ? -1 : 1)),
    binaries: [...binaries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    skills: [...skills.values()]
      .map((s) => ({ ...s, testOnly: testEvidence.has(s.skill) && !runtimeClaim.has(s.skill) }))
      .sort((a, b) => (a.skill < b.skill ? -1 : 1)),
    frameworkFiles: [...frameworkFiles.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
    relativeCrossSkill,
    requirementsEscapes,
    hasScripts: files.some((f) => f.inScripts),
  };
}

/**
 * Does this skill need a manifest at all?
 *
 * DERIVED, never a list. A skill with no scripts, no third-party import, no cross-skill edge, no
 * binary and no descriptor is already independent, and requiring a ceremonial empty manifest for it
 * would only rot. This is the same reasoning registry.mjs applies to descriptors.
 *
 * @param {ReturnType<typeof scanSkill>} scan
 * @param {boolean} hasDescriptor
 * @param {{present: boolean, manifest: object|null}|null} [read] - the manifest as it exists on disk
 * @returns {{required: boolean, because: string[]}}
 */
export function manifestRequired(scan, hasDescriptor, read = null) {
  const because = [];
  if (scan.hasScripts) because.push('has scripts/');
  if (scan.python.length) because.push(`imports ${scan.python.length} third-party python module(s)`);
  if (scan.node.length) because.push(`imports ${scan.node.length} npm package(s)`);
  // Only a tier that is a dependency CLAIM forces a manifest. `prose` ("see also X") and
  // `code-comment` (a provenance or co-ownership note) are both reported and never written, so making
  // either a reason would demand a manifest whose sibling_skills section the generator then leaves
  // empty — and would print a reason ("reaches 1 sibling skill") that the file itself contradicts.
  // `ambiguous` counts: a borrowed module really is imported, the scanner just cannot say from where.
  const claims = scan.skills.filter((s) => ['wired', 'documented', 'ambiguous'].includes(s.confidence));
  if (claims.length) {
    because.push(`reaches ${claims.length} sibling skill(s) in code or documented invocations`);
  }
  if (scan.frameworkFiles.length) because.push(`reads ${scan.frameworkFiles.length} framework file(s)`);
  // BOTH binary tiers count, unlike the sibling tiers above. A `prose` binary is not auto-written
  // either, but its answer — the declaration or the `not_required.binaries` rejection — has to live
  // SOMEWHERE, and the only place is a manifest. sk-git-ship is the case: its `gh`/`glab`
  // invocations are inline spans, so with no manifest required there was nowhere to record them and
  // `skill manifest --apply` refused to generate the file at all.
  const wiredBins = scan.binaries.filter((b) => b.confidence !== 'prose');
  if (wiredBins.length) because.push(`invokes ${wiredBins.length} external binary/binaries`);
  const proseBins = scan.binaries.length - wiredBins.length;
  if (proseBins) because.push(`names ${proseBins} external binary/binaries as a documented command`);
  if (hasDescriptor) because.push('owns a rule, hook or config block');

  // A HAND-AUTHORED declaration the scanner cannot derive is itself a reason (INC-2026-09-04-02,
  // N-8). `requires.` sections are authored, not generated: `sk-cli` declares `lib/sk-cli/help.mjs`
  // because its own comment says "the scanner cannot see bin/ at all", and `sk-config-doctor` does
  // the same. Both were then told their manifest was unneeded and could be deleted — advice that
  // would have destroyed the only record of a real dependency. Only counted when the file exists, so
  // this never conjures a manifest for a skill that has none; it keeps a correct one from being
  // graded away.
  const authored = read && read.present && read.manifest ? read.manifest.requires || {} : null;
  if (authored && !because.length) {
    const declared = [];
    if (Array.isArray(authored.framework_files) && authored.framework_files.length) {
      declared.push(`${authored.framework_files.length} framework file(s)`);
    }
    if (Array.isArray(authored.sibling_skills) && authored.sibling_skills.length) {
      declared.push(`${authored.sibling_skills.length} sibling skill(s)`);
    }
    if (Array.isArray(authored.binaries) && authored.binaries.length) {
      declared.push(`${authored.binaries.length} external binary/binaries`);
    }
    if (declared.length) because.push(`declares by hand what the scanner cannot see: ${declared.join(', ')}`);
  }
  return { required: because.length > 0, because };
}
