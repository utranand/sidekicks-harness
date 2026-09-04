#!/usr/bin/env node
// scripts/framework-core-publish.mjs
//
// Publish the framework core — forge the mountable core repo from THIS repo, stamp
// its version, and auto-write the release log. One command instead of the six-step
// hand sequence in docs/guide/v1.5/framework-as-submodule.md § Building and releasing a
// core, which was easy to run with a stale --core-version or with no record of what
// the release actually contained.
//
// Three things this owns that the hand sequence did not:
//
//   1. AUTO LOG. Every publish appends an entry to the release log derived from
//      `git log` over the surfaces that actually travel into the core — never
//      hand-written. A hand-written log inside the core would be destroyed at the
//      next forge anyway (inheritance is one-way: .sidekicks/memory/
//      runtime-inheritance-is-one-way.md), so the log lives in the ROOT repo under
//      the core service's artifacts base, where it commits alongside the gitlink bump.
//
//   2. VERSIONING. The core's version is its OWN line, not the repo's: the source
//      package.json sits at 1.1.0 while the core is already at 1.1.1. The current
//      version is read from the forged marker (.sidekicks-core.json — what was
//      actually stamped, not what someone meant to stamp), bumped semver-wise, and
//      passed back as --core-version. `status` shows the next version before you commit.
//
//      THE SOURCE package.json IS NOT THE CORE VERSION AND IS NOT STALE. It has now
//      been reported as a defect by three consecutive audits (INC-2026-09-04-01 F-5,
//      INC-2026-09-04-02 N-9, INC-2026-09-04-03 U-4), so it is written down here
//      rather than re-litigated a fourth time. It is DECIDED, not open. The forge STAMPS the forged package.json with --core-version
//      (inherit.mjs writeCoreDistribution), so a mounted CLI's `--version` is correct
//      today; the source file versions the source repo, which is a different artifact
//      with a different release cadence and no consumer. Syncing them would create a
//      second version source the release path has to keep true, to remove a mismatch
//      that misleads nobody who reads this paragraph. Decided by the operator,
//      2026-09-04 (Asia/Bangkok).
//
//   3. DRIFT DETECTION. `status` answers "does the core owe a release?" by diffing
//      core-bound paths since the last published source commit. That is what makes the
//      logging automatic rather than remembered — sk-hello's readiness step
//      calls the same computation and surfaces it on every orientation.
//
//   4. BUMP CLASSIFICATION. "Which number moves" is a question about what the release
//      contains, not a flag someone remembers to pass. A skill or lib module leaving the
//      core is breaking (major); one arriving, or a new CLI verb, is additive (minor);
//      anything else is a patch. --bump/--version still override, and `status` prints the
//      signal that decided, so the classification is auditable rather than magic.
//
// What it does NOT do: PUSH. That is the outward-facing half and stays the operator's
// call (CLAUDE.md § irreversible / outward-facing actions); the command block is printed.
// It DOES commit and tag locally once every gate has passed — but never onto a protected
// branch, in either repo, without an explicit --allow-protected.
//
// Verbs:
//   status              what changed since the last publish + the next version (exit 10 if pending)
//   publish             forge + stamp + verify + append the log entry + commit locally
//   ship                ONE command for the whole release: serve anything already cut, publish, then
//                       serve that. A composition of the verbs below — it re-invokes this script
//                       rather than re-implementing them, so it cannot drift from running them by
//                       hand. Refuses a dirty core-bound tree; plan-only until --yes.
//   release             the OUTWARD half of a publish: push the tag, push the core branch, verify
//                       the remote actually serves it, then push the source work branch. Plan-only
//                       until --yes. Pushes the TAG FIRST so the README can never reach the core's
//                       default branch naming a tag the remote does not serve.
//   verify              run every gate against an already-forged core, publish nothing
//   verify-remote       ask the core's remote what it actually serves and record the answer
//                       (read-only: `git ls-remote`, never a push). Nothing else here reaches a
//                       remote, so nothing else may claim a release is published (F-13).
//   log                 print the release log
//
// Flags:
//   --target DIR               the core to forge into (default: the configured service src/)
//   --name NAME                runtime name passed to the inherit engine (default: derived)
//   --preset NAME              inherit preset to forge (default: core — the required floor only)
//   --remote URL               git remote stamped into the generated installers
//   --bump patch|minor|major   override the derived class
//   --version X.Y.Z            set the version explicitly (overrides --bump)
//   --ref REF                  ref the generated install commands default to (default: main)
//   --no-tests                 skip gate 3 (the target's own suite); the skip is LOGGED
//   --no-mount-check           skip gate 5 (mount the core into a throwaway workspace)
//   --no-commit                do not commit/tag locally, just print the steps (pre-AAP-114 behaviour)
//   --allow-protected          permit the local commit even on a protected branch
//   --reland                   re-land an ALREADY-RELEASED version: upsert its log entry instead of
//                              appending a duplicate, move its tag with -f, and skip the
//                              already-released refusals. The operator's explicit per-invocation yes,
//                              same shape as --allow-protected — never self-granted.
//   --branch NAME              with ship: the work branch to move a protected repo onto
//                              (default: chore/framework-core-release)
//   --yes                      with ship and release: actually push. Without it release prints the plan and
//                              writes nothing. The operator's explicit per-invocation yes, the same
//                              shape as --allow-protected and --reland — never self-granted.
//   --allow-unlogged-tags      with release: push even though the remote already serves a tag that
//                              has no release-log entry
//   --dry-run                  with publish: show the forge command and the log entry, write nothing
//   --json                     machine-readable output (status)
//
// Re-publishing a version is IDEMPOTENT, not append-only. Publishing a version that has already
// been released re-forges, runs every gate, and then compares the forged tree against the recorded
// release (normalized: wall-clock timestamps are ignored, see normalizedTreeHash). Identical means
// there is nothing to do and nothing is written; different means the release diverged and the run
// refuses. Neither outcome silently rewrites history — that needs --reland.
//
// Exit codes:
//   0 ok (including "already released, byte-identical — nothing to do")
//   1 a verification gate failed
//   2 bad arguments / unresolvable version
//   3 missing target, version conflict, or an already-released version with no recorded baseline
//   4 forged, gated and logged, but NOT landed locally (protected branch, or a tag that would move)
//   5 the forged tree DIVERGES from the recorded content of that already-released version
//   6 release: a push was refused by the remote, or would not fast-forward (nothing was pushed)
//   7 release: the pushes landed but the remote still does not serve the release
//   8 release: refused for policy — a protected target branch, or a served-but-unlogged tag
//  10 status: a release is pending
//
// Pure Node, no shell-isms beyond git/node spawns — runs identically on macOS,
// Linux and Windows.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  appendFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve, relative, isAbsolute, basename, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { configurationInventory } from "../lib/core-lifecycle/config-templates.mjs";

// ── Repo root ───────────────────────────────────────────────────────────────
// Walk up for .sidekicks/ rather than `git rev-parse`: this script sits next to
// a core service whose src/ is its OWN git repo, and rev-parse from the wrong cwd
// would resolve to that submodule and publish into the wrong tree.
function resolveRepoRoot() {
  let cur = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(cur, ".sidekicks"))) return cur;
    const up = dirname(cur);
    if (up === cur) return process.cwd();
    cur = up;
  }
}
const ROOT = resolveRepoRoot();

const INHERIT_REL = join('.agents', 'skills', "sk-inherit", "scripts", "inherit.mjs");

// ── Args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const VERB = argv.find((a) => !a.startsWith("-")) || "status";
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[i + 1] : "";
};
const has = (name) => argv.includes(`--${name}`);
const DRY = has("dry-run");
const JSON_OUT = has("json");
const NO_TESTS = has("no-tests");
const NO_MOUNT_CHECK = has("no-mount-check");
// The upgrade gate mounts the previous SERVED release and runs its `core update` onto the
// candidate. Costly (a second workspace and a second doctor), and skippable for the same reasons
// the mount check is — but never by default: a release whose fix lives in the update tail is
// exactly the release that cannot verify itself any other way (INC-2026-09-04-03, R-4).
const NO_UPGRADE_CHECK = has("no-upgrade-check");
const NO_COMMIT = has("no-commit");
const ALLOW_PROTECTED = has("allow-protected");
const RELAND = has("reland");
const ALLOW_UNPUSHED = has("allow-unpushed");

// ── Small helpers ───────────────────────────────────────────────────────────
function git(args, cwd = ROOT) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

// Asia/Bangkok for every timestamp (CLAUDE.md § Operational Rules). Built from the
// en-CA/sv-style parts rather than toISOString so the offset is real, not UTC relabelled.
function nowBangkok() {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return {
    stamp: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+07:00`,
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

function readJson(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // a corrupt state file must never block a publish
  }
}

// Repo-relative, forward-slashed — the portable-paths rule forbids persisting a
// machine-absolute path into any artifact, and \ would not survive a macOS read.
const portable = (rel) => rel.split(sep).join("/");

// ── Normalized content hash ─────────────────────────────────────────────────
// What makes "the same version always forges the same core" checkable.
//
// The forge is content-deterministic but not byte-stable: every run stamps the wall clock into
// ten generated files — `forged_at` (.sidekicks-core.json), `inherited_at` (.sidekicks/inherit.json,
// once per unit), `generated_at` (.sidekicks/state/index.json, the only one carrying milliseconds
// because lib/scope-index writes it), and the "Generated ... at <ts>" banners in AGENTS.md,
// AGENTS.framework.md, CLAUDE.md, GEMINI.md, README.md, install.sh and install.ps1. Measured: two
// forges of one source tree produced 509 files each, 10 differing, 30 differing lines, ALL of them
// timestamps. Those stamps are deliberately kept (they say when a core was cut), so the check
// normalizes them away rather than the forge dropping them.
//
// One regex covers every case, including the millisecond form, because they all carry the
// Asia/Bangkok offset this repo mandates for all timestamps.
const TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\+07:00/g;

/** CRLF-folded and timestamp-masked, so macOS and Windows forges of one source agree. */
function normalizeForHash(buf) {
  return buf.toString("utf8").split("\r\n").join("\n").replace(TS_RE, "<TS>");
}

/**
 * A stable per-file hash map of a forged tree, plus one digest over the whole thing.
 *
 * `.git/` is skipped: it is not part of what a core ships, and its contents (HEAD, index, hooks)
 * are inherently unstable. SYMLINKS ARE HASHED BY THEIR TARGET'S CONTENT, not skipped and not by
 * link text — the forge writes CLAUDE.md and GEMINI.md as symlinks to AGENTS.md on POSIX but as
 * real copies on Windows, so hashing the resolved content is the only way the same source yields
 * the same digest on both.
 *
 * @param {string} dir - absolute path to the forged tree
 * @returns {{digest: string, files: Record<string,string>}} empty digest "" when dir is absent
 */
function normalizedTreeHash(dir) {
  const files = {};
  if (!existsSync(dir)) return { digest: "", files };

  const walk = (abs, rel) => {
    let entries;
    try {
      entries = readdirSync(abs).sort();   // sorted: readdir order is not portable
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === ".git") continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(childAbs);           // follows symlinks on purpose (see above)
      } catch {
        continue;                          // a broken link contributes nothing rather than throwing
      }
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) {
        try {
          files[childRel] = createHash("sha256").update(normalizeForHash(readFileSync(childAbs))).digest("hex");
        } catch {
          /* unreadable file: leave it out rather than abort a release */
        }
      }
    }
  };
  walk(dir, "");

  const roll = createHash("sha256");
  for (const rel of Object.keys(files).sort()) roll.update(`${rel} ${files[rel]}\n`);
  return { digest: roll.digest("hex"), files };
}

/** Sorted paths that differ between two normalizedTreeHash() file maps, with why. */
function hashDiff(before, after) {
  const out = [];
  for (const rel of new Set([...Object.keys(before), ...Object.keys(after)].sort())) {
    if (!(rel in before)) out.push(`+ ${rel} (added)`);
    else if (!(rel in after)) out.push(`- ${rel} (removed)`);
    else if (before[rel] !== after[rel]) out.push(`M ${rel}`);
  }
  return out.sort();
}

// ── What is being published, and where ──────────────────────────────────────
// Everything below used to be four hard-coded constants. They are now resolved, in
// order, from: an explicit flag → the `framework_core` config block → the built-in
// default (which is exactly what the constants said). Missing configuration is never
// an error at any layer, so a checkout that has not run `config sync` behaves as before.

/**
 * The skill's own config block, or {} when nothing declares it yet.
 *
 * Read through the CLI rather than by parsing YAML: `config get` owns the precedence
 * chain (project secret → project family → root → the owning skill's defaults), and a
 * second parser here would resolve differently the first time a project overrode a value.
 */
function loadConfigBlock() {
  const cli = join(ROOT, "bin", "sidekicks");
  if (!existsSync(cli)) return {};
  const r = spawnSync(process.execPath, [cli, "config", "get", "framework_core", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) return {};
  try {
    const payload = JSON.parse(r.stdout || "{}");
    const cfg = payload && typeof payload === "object" ? payload.config : null;
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {}; // an unparsable block must degrade to the defaults, never abort a release
  }
}

const CFG = loadConfigBlock();
const DEFAULT_SERVICE_REL = join("projects", "global", "services", "sidekicks-harness");

/** A target given as an absolute path, or relative to the REPO ROOT — never to cwd. */
function targetRelFromFlag(value) {
  const abs = isAbsolute(value) ? value : resolve(ROOT, value);
  return relative(ROOT, abs);
}

/**
 * The runtime name inherit is driven with. Derived from the target when not given, because
 * `--target ../elsewhere/core` with the default name would forge a second core under the
 * first one's identity and its drift baseline would then describe the wrong tree.
 */
function deriveName(srcRel) {
  const leaf = basename(srcRel);
  return leaf === "src" ? basename(dirname(srcRel)) : leaf;
}

const SRC_REL = flag("target")
  ? targetRelFromFlag(flag("target"))
  : CFG.target
    ? targetRelFromFlag(String(CFG.target))
    : join(DEFAULT_SERVICE_REL, "src");
const SRC_ABS = resolve(ROOT, SRC_REL);
const RUNTIME_NAME = flag("name") || (flag("target") ? deriveName(SRC_REL) : CFG.runtime_name || "sidekicks-harness");
const REMOTE = flag("remote") || CFG.remote || "https://github.com/utranand/sidekicks-harness.git";
// The published core carries the REQUIRED FLOOR and nothing else. `core` is the preset that names
// exactly that floor (presets.yaml keeps it identical to the `required:` block, test-enforced), so a
// mounted core can orient itself, drive every CLI verb, align scope and validate its config — and the
// consumer chooses every other skill instead of inheriting our whole bench. The rest of the framework
// family did not stop being framework skills: they stay in the `framework` preset and are published
// as the `framework` category of the sidekicks-skills repository, installed on demand.
// `--preset framework` still forges the old fat core for anyone who wants it.
const PRESET = flag("preset") || CFG.preset || "core";

/**
 * Run state lives under the SERVICE root when the target IS a service's src/ (artifacts base
 * for a service is the service root, never its src/ — CLAUDE.md § Free-Write Surface &
 * Anchors), so a forge that wipes src/ can never take the release history with it. For any
 * other target there is no service root to hang off, so it lands in the root repo's run
 * folder keyed by runtime name — same invariant, different anchor: never inside the forge.
 */
function resolveRunRel() {
  const parts = SRC_REL.split(sep);
  const isServiceSrc =
    parts.length >= 5 &&
    parts[0] === "projects" &&
    parts[2] === "services" &&
    parts[parts.length - 1] === "src";
  return isServiceSrc
    ? join(parts.slice(0, -1).join(sep), "artifacts", "runs", "framework-core-publish")
    : join("artifacts", "runs", "framework-core-publish", RUNTIME_NAME);
}

const RUN_REL = resolveRunRel();
const LOG_REL = join(RUN_REL, "release-log.md");
const STATE_REL = join(RUN_REL, "state.json");

// Integration/environment branches. A release commit is still a commit, and CLAUDE.md's
// protected-branch rule is a hard floor in EVERY repo a run touches — including the core's
// own. --allow-protected is the operator's explicit per-invocation yes, never self-granted.
const PROTECTED = new Set(["main", "master", "sit", "uat", "staging", "stage", "prod", "production"]);
const isProtected = (branch) => Boolean(branch) && (PROTECTED.has(branch) || branch.startsWith("release/"));

/**
 * Is the target its OWN git repository, rather than a plain directory inside this one?
 *
 * Load-bearing, and not obvious: `git -C <dir> rev-parse HEAD` walks UP, so a target that is a plain
 * folder inside this repo answers with THIS repo's HEAD. Anything that then acts on "the core's git
 * state" — mounting it as a submodule, committing "inside the core" — would silently act on the root
 * repo instead. Comparing the toplevel is the only answer that distinguishes the two.
 */
function targetIsOwnRepo() {
  const top = git(["rev-parse", "--show-toplevel"], SRC_ABS);
  if (!top.ok) return false;
  try {
    return resolve(top.out) === resolve(SRC_ABS);
  } catch {
    return false;
  }
}

// ── Version ─────────────────────────────────────────────────────────────────
// The forged marker is the source of truth for "what is published": it is what the
// last forge actually stamped. state.json is the cross-check, and disagreement is
// reported rather than silently resolved — the two diverging means someone forged by
// hand, which is exactly the case a bump must not paper over.
/**
 * The last LOCAL release recorded in state.json.
 *
 * The key is `last_local_release`, not `last_publish` (F-13). `publish` forges, gates, commits and
 * tags — all local and all reversible — and never pushes, so what it records is a LOCAL fact and
 * the name says so. Pushing is `release`'s job and needs the operator's explicit `--yes` per
 * invocation (CLAUDE.md § irreversible / outward-facing actions); the merges onto a protected
 * branch stay the operator's alone. Calling the result "published" made local
 * state read as a claim about the world, and it was wrong — state.json said v2.0.0 was published
 * while the GitHub remote still served v1.1.5 with no v2.0.0 tag at all. `last_publish` is still
 * READ so an existing state file keeps classifying; only the write side moved.
 *
 * @param {object|null} state - parsed state.json, or null
 * @returns {object|null}
 */
function lastRelease(state) {
  if (!state) return null;
  return state.last_local_release || state.last_publish || null;
}

function publishedVersion() {
  const marker = readJson(join(SRC_REL, ".sidekicks-core.json"));
  const last = lastRelease(readJson(STATE_REL));
  return {
    marker: marker && marker.version ? String(marker.version) : null,
    markerCommit: marker && marker.source_commit ? String(marker.source_commit) : null,
    state: last ? String(last.version) : null,
    stateCommit: last ? String(last.source_commit) : null,
  };
}

/** -1 / 0 / 1, comparing the numeric triple only. Unparsable sorts low. */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || "");
    return m ? m.slice(1, 4).map(Number) : [-1, -1, -1];
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Which version the next bump should be derived FROM, when the marker and the log disagree.
 *
 * They disagree in two very different situations and conflating them is expensive either way:
 *
 *   - The marker is AHEAD. A publish forged and stamped, then a gate failed, so no log entry was
 *     written. The stamped version was never released. Deriving from the marker would climb a
 *     version on every retry (1.2.0 -> 1.3.0 -> 1.4.0) while the log still shows 1.1.5, so the base
 *     is the LOG, and the aborted attempt's number gets reused. This became reachable the moment
 *     verification moved after the forge.
 *   - The marker is BEHIND. The forged core is older than the log claims — the log is describing a
 *     release that is not in the tree. Nothing can safely guess what happened, so it stays a hard
 *     stop.
 */
function releaseBase(ver) {
  if (!ver.marker || !ver.state || ver.marker === ver.state) {
    return { base: ver.marker || ver.state, resumed: false, conflict: false };
  }
  if (compareVersions(ver.marker, ver.state) > 0) {
    return { base: ver.state, resumed: true, conflict: false };
  }
  return { base: ver.state, resumed: false, conflict: true };
}

function bumpVersion(v, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || "");
  if (!m) return null;
  let [, maj, min, pat] = m.map(Number);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/**
 * Every version this repo has already released locally: the last release plus everything
 * `history[]` remembers. Re-publishing one of these is not automatically wrong — a re-land is a
 * legitimate thing to want — but it must never happen by accident, which is what it did before.
 */
function releasedVersions(state) {
  const out = new Set();
  const last = lastRelease(state);
  if (last && last.version) out.add(String(last.version));
  if (Array.isArray(state && state.history)) {
    for (const h of state.history) if (h && h.version) out.add(String(h.version));
  }
  return out;
}

/** Is the core's own working tree clean? Only meaningful when the target is its own repo. */
function coreTreeClean() {
  if (!targetIsOwnRepo()) return false;
  const st = git(["status", "--porcelain"], SRC_ABS);
  return st.ok && st.out === "";
}

/**
 * The content baseline a re-publish of `version` is checked against, captured BEFORE the forge
 * overwrites the target. Three rungs, most authoritative first:
 *
 *   1. state.json's recorded `content_hash` for that version — written by every publish from this
 *      change onward, and the only rung that survives the target being dirty or re-forged.
 *   2. the target tree ON DISK, when its marker stamps this same version and the core repo is
 *      clean. That tree IS the released content, so it is a sound baseline — and it is what lets
 *      the check work for versions released before `content_hash` existed.
 *   3. nothing. A re-publish then cannot be verified, so it is refused rather than guessed at.
 *
 * @returns {{digest: string, files: Record<string,string>|null, source: string}|null}
 */
function referenceContent(version, state, ver) {
  const last = lastRelease(state);
  if (last && String(last.version) === version && last.content_hash) {
    return { digest: String(last.content_hash), files: null, source: "state.json content_hash" };
  }
  if (Array.isArray(state && state.history)) {
    const h = state.history.find((x) => x && String(x.version) === version && x.content_hash);
    if (h) return { digest: String(h.content_hash), files: null, source: "state.json history content_hash" };
  }
  if (ver.marker === version && coreTreeClean()) {
    const snap = normalizedTreeHash(SRC_ABS);
    if (snap.digest) return { ...snap, source: "the forged tree on disk (clean core repo)" };
  }
  return null;
}

// ── Core-bound surfaces ─────────────────────────────────────────────────────
// Which source paths actually end up inside the core. Asking the inherit engine is
// the only answer that cannot drift: `plan` prints the substrate list and the resolved
// skill set from the SAME code that copies them. The literal list below is a fallback
// for the case where plan cannot run (or its output shape changes) — it is reported as
// a fallback so a wrong answer is never mistaken for an authoritative one.
const SUBSTRATE_FALLBACK = [
  "bin",
  "lib",
  "scripts",
  ".githooks",
  ".sidekicks/RULES.md",
  ".sidekicks/hooks",
  ".sidekicks/config.example.yaml",
  ".sidekicks/framework.yaml",
  ".sidekicks/framework.example.yaml",
  ".claude/agents",
  ".claude/commands",
  ".claude/settings.json",
  ".codex/config.toml",
  ".codex/agents",
  ".gemini/settings.json",
  ".agent/settings.json",
  ".agents/plugins",
  "AGENTS.md",
];

function corePaths() {
  const inherit = join(ROOT, INHERIT_REL);
  if (existsSync(inherit)) {
    const r = spawnSync(
      process.execPath,
      [inherit, "plan", "--name", RUNTIME_NAME, "--preset", PRESET],
      { cwd: ROOT, encoding: "utf8" }
    );
    const text = r.stdout || "";
    const skills = [];
    const substrate = [];
    let mode = null;
    for (const raw of text.split("\n")) {
      // The count may carry a qualifier — "skills (17, including 4 required):" — so match the
      // opening paren loosely. Pinning it to `\(\d+\)` silently dropped the whole skill list
      // (and with it every skill path in the pending-file scan) the day the required floor
      // added its suffix.
      if (/^skills \(\d+[^)]*\)/.test(raw)) {
        mode = "skills";
        continue;
      }
      if (/^core substrate/.test(raw)) {
        mode = "substrate";
        continue;
      }
      if (/^\S/.test(raw)) {
        mode = null; // any unindented line ends the current section
        continue;
      }
      if (!mode) continue;
      const line = raw.trim();
      if (!line) continue;
      if (mode === "skills") {
        // "  <name>  active  v1.0.0" — nested advisory lines are deeper-indented
        // and carry a ':' or start with a keyword, so require the 2-space form.
        if (!/^ {2}\S/.test(raw)) continue;
        const name = line.split(/\s+/)[0];
        if (name && !name.includes(":")) skills.push(`.agents/skills/${name}`);
      } else if (/^ {2}\S+$/.test(raw)) {
        substrate.push(line);
      }
    }
    if (skills.length && substrate.length) {
      // CLAUDE.md is imported by the generated core CLAUDE.md's rules and is not in
      // the substrate list, but a change to it does change the core.
      return {
        paths: [...substrate, "AGENTS.md", ...skills].sort(),
        skills: skills.map((p) => p.split("/").pop()).sort(),
        source: "inherit plan",
      };
    }
  }
  return {
    paths: [...SUBSTRATE_FALLBACK].sort(),
    skills: null, // unknown, not empty — an empty set would read as "every skill was removed"
    source: "fallback list (inherit plan unavailable)",
  };
}

// ── Inventory: what the core carries, on each side ──────────────────────────
// Skills and lib modules are the two units that decide the bump class, and both carry a
// VERSION.json, so one reader serves both sides. `null` anywhere means UNKNOWN — never
// treated as an empty set, because "we could not look" and "everything was removed" have
// opposite consequences for the classifier.

/** `<dir>/VERSION.json`'s version, or null. */
function unitVersion(dir) {
  try {
    const v = JSON.parse(readFileSync(join(dir, "VERSION.json"), "utf8"));
    return v && v.version ? String(v.version) : null;
  } catch {
    return null;
  }
}

/** Immediate subdirectory names of `abs`, or null when it does not exist. */
function subdirs(abs) {
  if (!existsSync(abs)) return null;
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
}

/** Directory entries at the core's committed HEAD, or null when that cannot be read. */
function subdirsAtHead(relPosix) {
  if (!targetIsOwnRepo()) return null;
  const r = git(["ls-tree", "--name-only", "-d", `HEAD:${relPosix}`], SRC_ABS);
  if (!r.ok) return null;
  return r.out.split("\n").map((s) => s.trim()).filter(Boolean).sort();
}

/**
 * Agent-pack directory names at the core's committed HEAD.
 *
 * Returns `[]` — not `null` — when HEAD is readable but carries no agent-packs directory, because
 * those two answers classify differently: "this release shipped no pack" makes a new one an
 * ADDITION, while "we cannot tell what it shipped" must compare nothing at all. Collapsing them
 * would either hide the first pack's arrival or invent a removal.
 */
function packsAtHead() {
  const listed = subdirsAtHead(".sidekicks/agent-packs");
  if (listed) return listed;
  if (!targetIsOwnRepo()) return null;
  return git(["rev-parse", "--verify", "HEAD"], SRC_ABS).ok ? [] : null;
}

/** A file's contents at the core's committed HEAD, or null. */
function readAtHead(relPosix) {
  if (!targetIsOwnRepo()) return null;
  const r = git(["show", `HEAD:${relPosix}`], SRC_ABS);
  return r.ok ? r.out : null;
}

/**
 * What the PUBLISHED core carries — in descending order of how much it can be trusted.
 *
 * 1. `state.json` — what the last publish actually recorded.
 * 2. The core's committed **HEAD** — what was actually released.
 * 3. The core's **working tree** — last resort.
 *
 * The order is load-bearing, and (3) is the trap: a publish that forged and then failed a gate
 * leaves the working tree holding UNRELEASED content. Classifying against it then sees nothing
 * added and derives `patch` for a release that adds three lib modules — observed, not theorised,
 * when a config-doctor gate failure produced exactly that on the retry. HEAD cannot lie that way:
 * an aborted forge never commits.
 */
function publishedInventory() {
  const last = lastRelease(readJson(STATE_REL));
  if (last && Array.isArray(last.skills)) {
    return {
      skills: [...last.skills].sort(),
      lib: Array.isArray(last.lib) ? [...last.lib].sort() : null,
      // Absent from every release recorded before agent packs existed, so fall back to the core's
      // committed HEAD rather than to `null`. The distinction that makes this safe is in
      // packsAtHead: a readable HEAD with no agent-packs directory is EMPTY (the release really
      // shipped none, so a new pack is correctly an addition), while an unreadable HEAD stays
      // unknown and the classifier compares nothing.
      packs: Array.isArray(last.packs) ? [...last.packs].sort() : packsAtHead(),
      configuration: Array.isArray(last.configuration) ? last.configuration : null,
      source: "state.json",
      at: "state",
    };
  }
  const headSkills = subdirsAtHead(".agents/skills");
  if (headSkills) {
    return {
      skills: headSkills,
      lib: subdirsAtHead("lib"),
      packs: packsAtHead(),
      configuration: configurationInventory(SRC_ABS).filter((row) => row.mode),
      source: "the core's committed HEAD",
      at: "head",
    };
  }
  return {
    skills: subdirs(join(SRC_ABS, '.agents', 'skills')),
    lib: subdirs(join(SRC_ABS, "lib")),
    packs: subdirs(join(SRC_ABS, ".sidekicks", "agent-packs")),
    configuration: configurationInventory(SRC_ABS).filter((row) => row.mode),
    source: "the forged working tree (unreleased content may be present)",
    at: "worktree",
  };
}

/** What the NEXT forge would carry, read from this working tree. */
function sourceInventory(planSkills) {
  return {
    skills: planSkills, // may be null when `inherit plan` could not run
    lib: subdirs(join(ROOT, "lib")),
    packs: subdirs(join(ROOT, ".sidekicks", "agent-packs")),
    configuration: configurationInventory(ROOT).filter((row) => row.mode),
  };
}

/** CLI verb ids (`namespace verb`) on one side, or null when help.mjs cannot be read. */
async function verbIds(rootDir) {
  const help = join(rootDir, "lib", "sk-cli", "help.mjs");
  if (!existsSync(help)) return null;
  try {
    const mod = await import(`file://${help}`);
    if (!Array.isArray(mod.VERBS)) return null;
    return mod.VERBS.map((v) => `${v.namespace} ${v.verb}`).sort();
  } catch {
    return null;
  }
}

const setDiff = (a, b) => (a && b ? a.filter((x) => !b.includes(x)) : []);

/**
 * Which number moves, and why.
 *
 * A unit LEAVING the core is breaking for anyone who mounted it — a skill they invoke or a
 * lib module they import stops existing — so that is major. A unit ARRIVING, or a new CLI
 * verb, is additive: minor. Everything else changed content behind a stable surface: patch.
 * The deciding signal travels with the answer so `status` can show its work; a classifier
 * nobody can audit is a flag with extra steps.
 */
async function classifyBump(planSkills) {
  const pub = publishedInventory();
  const src = sourceInventory(planSkills);
  const removedSkills = setDiff(pub.skills, src.skills);
  const addedSkills = setDiff(src.skills, pub.skills);
  const removedLib = setDiff(pub.lib, src.lib);
  const addedLib = setDiff(src.lib, pub.lib);
  // Agent packs move the number for the same reason skills do: a pack the consumer installed and
  // then lost is a crew that stops being re-installable, and a new one is an additive capability.
  const removedPacks = setDiff(pub.packs, src.packs);
  const addedPacks = setDiff(src.packs, pub.packs);
  const configMap = (rows) => new Map((rows || []).map((row) => [row.destination, row.hash || '']));
  const publishedConfig = configMap(pub.configuration);
  const sourceConfig = configMap(src.configuration);
  const removedConfiguration = [...publishedConfig.keys()].filter((p) => !sourceConfig.has(p)).sort();
  const addedConfiguration = [...sourceConfig.keys()].filter((p) => !publishedConfig.has(p)).sort();
  const changedConfiguration = [...sourceConfig.keys()].filter((p) => publishedConfig.has(p)
    && sourceConfig.get(p) !== publishedConfig.get(p)).sort();
  const pubVerbs = await verbIds(SRC_ABS);
  const srcVerbs = await verbIds(ROOT);
  const addedVerbs = setDiff(srcVerbs, pubVerbs);
  const removedVerbs = setDiff(pubVerbs, srcVerbs);

  const reasons = [];
  let kind = "patch";
  if (removedSkills.length) reasons.push(`skill removed: ${removedSkills.join(", ")}`);
  if (removedLib.length) reasons.push(`lib module removed: ${removedLib.join(", ")}`);
  if (removedVerbs.length) reasons.push(`CLI verb removed: ${removedVerbs.join(", ")}`);
  if (removedPacks.length) reasons.push(`agent pack removed: ${removedPacks.join(", ")}`);
  if (removedConfiguration.length) reasons.push(`configuration removed: ${removedConfiguration.join(", ")}`);
  if (reasons.length) {
    kind = "major";
  } else {
    if (addedSkills.length) reasons.push(`skill added: ${addedSkills.join(", ")}`);
    if (addedLib.length) reasons.push(`lib module added: ${addedLib.join(", ")}`);
    if (addedVerbs.length) reasons.push(`CLI verb added: ${addedVerbs.join(", ")}`);
    if (addedPacks.length) reasons.push(`agent pack added: ${addedPacks.join(", ")}`);
    if (addedConfiguration.length) reasons.push(`configuration added: ${addedConfiguration.join(", ")}`);
    if (reasons.length) kind = "minor";
    else if (changedConfiguration.length) reasons.push(`configuration template changed: ${changedConfiguration.join(", ")}`);
    else reasons.push("content-only change behind an unchanged surface");
  }
  return {
    kind,
    reasons,
    inventory_source: pub.source,
    added_skills: addedSkills,
    removed_skills: removedSkills,
    added_lib: addedLib,
    removed_lib: removedLib,
    added_verbs: addedVerbs,
    removed_verbs: removedVerbs,
    added_packs: addedPacks,
    removed_packs: removedPacks,
    added_configuration: addedConfiguration,
    removed_configuration: removedConfiguration,
    changed_configuration: changedConfiguration,
    published: pub,
    source: src,
  };
}

/**
 * Per-unit rows: what each skill, lib module and agent pack is at in the published core versus
 * this tree.
 *
 * REPORT ONLY. Nothing here writes a VERSION.json — a skill's version is its author's call,
 * and a release process that silently rewrote them would make every skill's history a lie
 * about who decided what.
 */
function deltaRows(cls) {
  const rows = [];
  // The published side is read at the same place the inventory came from — reading a version from
  // the working tree while the inventory came from HEAD would pair a released unit with an
  // unreleased version number and report "unchanged" for a unit that did move.
  const publishedVersionAt = (relPosix, absDir) => {
    if (cls.published.at === "worktree") return unitVersion(absDir);
    const text = readAtHead(`${relPosix}/VERSION.json`);
    if (text === null) return unitVersion(absDir);
    try {
      const v = JSON.parse(text);
      return v && v.version ? String(v.version) : null;
    } catch {
      return null;
    }
  };
  const add = (label, publishedRel, publishedDir, sourceDir, present) => {
    const before = present.published ? publishedVersionAt(publishedRel, publishedDir) : null;
    const after = present.source ? unitVersion(sourceDir) : null;
    let state = "carried";
    if (!present.published) state = "added";
    else if (!present.source) state = "removed";
    else if (before !== after) state = "changed";
    rows.push({ unit: label, published: before, source: after, state });
  };

  // `null` on either side is UNKNOWN, not empty — the same distinction the classifier keeps.
  // Coercing it to `[]` here reported every published skill as `removed` in the delta table and
  // in the release log, while the classifier (which does guard) called the release a minor.
  const pubSkills = cls.published.skills;
  const srcSkills = cls.source.skills;
  for (const name of pubSkills && srcSkills ? [...new Set([...pubSkills, ...srcSkills])].sort() : []) {
    add(
      name,
      `.agents/skills/${name}`,
      join(SRC_ABS, '.agents', 'skills', name),
      join(ROOT, '.agents', 'skills', name),
      { published: pubSkills.includes(name), source: srcSkills.includes(name) }
    );
  }
  const pubLib = cls.published.lib;
  const srcLib = cls.source.lib;
  for (const name of pubLib && srcLib ? [...new Set([...pubLib, ...srcLib])].sort() : []) {
    add(`lib/${name}`, `lib/${name}`, join(SRC_ABS, "lib", name), join(ROOT, "lib", name), {
      published: pubLib.includes(name),
      source: srcLib.includes(name),
    });
  }
  // Agent packs. Their version lives in `pack.yaml`, not a VERSION.json, so they get their own
  // reader rather than being forced into a file shape they do not have.
  const pubPacks = cls.published.packs;
  const srcPacks = cls.source.packs;
  for (const name of pubPacks && srcPacks ? [...new Set([...pubPacks, ...srcPacks])].sort() : []) {
    const rel = `.sidekicks/agent-packs/${name}/pack.yaml`;
    const before = pubPacks.includes(name)
      ? (cls.published.at === "worktree"
        ? packVersion(join(SRC_ABS, ".sidekicks", "agent-packs", name))
        : packVersionFromText(readAtHead(rel)) ?? packVersion(join(SRC_ABS, ".sidekicks", "agent-packs", name)))
      : null;
    const after = srcPacks.includes(name)
      ? packVersion(join(ROOT, ".sidekicks", "agent-packs", name))
      : null;
    let state = "carried";
    if (!pubPacks.includes(name)) state = "added";
    else if (!srcPacks.includes(name)) state = "removed";
    else if (before !== after) state = "changed";
    rows.push({ unit: `agent-pack/${name}`, published: before, source: after, state });
  }
  // A row whose version did not move and which is present on both sides says nothing a
  // reader needs; the commit list already covers content. Keep only what moved.
  return rows.filter((r) => r.state !== "carried");
}

/** An agent pack's declared version, read from its pack.yaml. */
function packVersion(dir) {
  try {
    return packVersionFromText(readFileSync(join(dir, "pack.yaml"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The `version:` line of a pack manifest.
 *
 * A regex rather than a parser on purpose: this script imports node:* only, and the one field it
 * needs is a top-level scalar. A manifest whose version cannot be read yields null ("unknown"),
 * which renders as an em dash — never a wrong number.
 */
function packVersionFromText(text) {
  if (!text) return null;
  const m = /^version:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(text);
  return m ? m[1] : null;
}

/** The delta as fixed-width text, for both the console and the log entry. */
function renderDelta(rows) {
  if (!rows.length) return ["  (no skill, lib module or agent pack added, removed, or version-bumped)"];
  const w = Math.max(6, ...rows.map((r) => r.unit.length));
  const out = [`  ${"unit".padEnd(w)}  published  source     state`];
  for (const r of rows) {
    out.push(
      `  ${r.unit.padEnd(w)}  ${(r.published || "—").padEnd(9)}  ${(r.source || "—").padEnd(9)}  ${r.state}`
    );
  }
  return out;
}

// ── Change detection ────────────────────────────────────────────────────────
// Diff core-bound paths between the last published source commit and HEAD. `git log`
// is given the pathspec directly so a commit that touched only projects/ or docs/ never
// shows up as a pending core release.
function pendingSince(sinceCommit, paths) {
  if (!sinceCommit) return { commits: [], files: [], unknownBase: true };
  const range = `${sinceCommit}..HEAD`;
  // A unit separator, not a space: commit subjects contain spaces, colons and pipes, so
  // any printable delimiter would eventually split one in the wrong place.
  const SEP = "\u001f";
  const verify = git(["cat-file", "-e", `${sinceCommit}^{commit}`]);
  if (!verify.ok) return { commits: [], files: [], unknownBase: true };
  const logRes = git(["log", "--no-merges", `--format=%h${SEP}%s`, range, "--", ...paths]);
  const filesRes = git(["diff", "--name-only", range, "--", ...paths]);
  const commits = logRes.ok
    ? logRes.out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const i = l.indexOf(SEP);
          return i === -1
            ? { sha: l.trim(), subject: "" }
            : { sha: l.slice(0, i), subject: l.slice(i + 1) };
        })
    : [];
  const files = filesRes.ok ? filesRes.out.split("\n").filter(Boolean) : [];
  return { commits, files, unknownBase: false };
}

// Core-bound files dirty in the WORKING TREE. Separate from the committed range on
// purpose: the forge copies the working tree, so an uncommitted change ships — but the
// log records HEAD, so that release is not reproducible from its own sha. Counting the
// two together would hide which of the two situations you are in.
function uncommittedCoreFiles(paths) {
  const tracked = git(["diff", "--name-only", "HEAD", "--", ...paths]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...paths]);
  const set = new Set();
  for (const src of [tracked, untracked]) {
    if (!src.ok) continue;
    for (const f of src.out.split("\n").filter(Boolean)) set.add(f);
  }
  return [...set].sort();
}

function headInfo() {
  return {
    sha: git(["rev-parse", "--short", "HEAD"]).out,
    branch: git(["branch", "--show-current"]).out,
    dirty: git(["status", "--porcelain"]).out.length > 0,
  };
}

// ── status ──────────────────────────────────────────────────────────────────
async function doStatus() {
  const ver = publishedVersion();
  const { paths, skills, source } = corePaths();
  const head = headInfo();
  const base = ver.markerCommit || ver.stateCommit;
  const pending = pendingSince(base, paths);
  const uncommitted = uncommittedCoreFiles(paths);
  const cls = await classifyBump(skills);
  const rows = deltaRows(cls);
  const bump = flag("bump") || cls.kind;
  const { base: versionBase, resumed, conflict } = releaseBase(ver);
  const next = flag("version") || bumpVersion(versionBase, bump);

  // What the REMOTE has to say, read from state.json only — `status` never reaches the network.
  // Three states, not two, and the distinction is the one state.json's own comment fixes: absence
  // means "not verified", NEVER "verified false". A fresh clone has asked nobody, and reporting that
  // as NOT SERVED would make every clone look like a failed release. Only a recorded negative is a
  // negative. Before this, a never-pushed release looked identical to a published one — which is how
  // v1.4.1 sat unpushed while every local signal said the release was done.
  const stateNow = readJson(STATE_REL) || {};
  const lastLocal = lastRelease(stateNow);
  const verified = stateNow.remote_verified && lastLocal
    && String(stateNow.remote_verified.version) === String(lastLocal.version)
    ? stateNow.remote_verified
    : null;
  const negative = stateNow.remote_check && lastLocal
    && String(stateNow.remote_check.version) === String(lastLocal.version)
    && stateNow.remote_check.ok === false
    ? stateNow.remote_check
    : null;
  const remoteState = verified ? "served" : negative ? "not_served" : "unverified";
  // Only classified against the remote when there ARE orphans, so an ordinary status stays offline.
  const orphanTags = unloggedTags();
  const phantomHistory = historyWithoutLog(stateNow);

  const result = {
    runtime: RUNTIME_NAME,
    target: portable(SRC_REL),
    run_state: portable(RUN_REL),
    preset: PRESET,
    published_version: ver.marker,
    published_source_commit: ver.markerCommit,
    state_version: ver.state,
    version_agrees: !ver.state || !ver.marker || ver.state === ver.marker,
    // A marker ahead of the log is an ABORTED publish (forged, stamped, a gate failed), not the
    // hand-forge the mismatch guard exists for. Reported separately so a caller can tell them apart.
    resumed_attempt: resumed,
    version_conflict: conflict,
    head: head.sha,
    branch: head.branch,
    working_tree_dirty: head.dirty,
    // Split from working_tree_dirty on purpose (INC-2026-09-04-03, U-4). head.dirty is
    // `git status --porcelain` over the WHOLE repo, so four unrelated project gitlinks made a
    // release whose every core-bound surface was committed report "working tree DIRTY" — a warning
    // that named nothing the release could act on, next to a refusal (below) that correctly gates on
    // core-bound files only. The honest number was already being computed; it just was not reported.
    core_bound_dirty: uncommitted.length,
    core_bound_path_count: paths.length,
    surface_source: source,
    pending_commits: pending.commits.length,
    pending_files: pending.files.length,
    uncommitted_core_files: uncommitted.length,
    unknown_base: pending.unknownBase,
    bump_class: cls.kind,
    bump_reasons: cls.reasons,
    bump_source: flag("version") ? "explicit --version" : flag("bump") ? "explicit --bump" : "derived",
    inventory_source: cls.inventory_source,
    delta: rows,
    next_version: next,
    remote_state: remoteState,
    remote_verified_version: verified ? String(verified.version) : null,
    remote_checked_at: (verified && verified.verified_at)
      || (negative && negative.checked_at)
      || null,
    unpushed_release: remoteState === "served" || !lastLocal ? null : String(lastLocal.version),
    unlogged_tags: orphanTags,
    // The mirror image of unlogged_tags: history claiming a release the log has no section for.
    history_without_log: phantomHistory,
  };

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    const out = [];
    out.push(`Framework core: ${portable(SRC_REL)}`);
    out.push(`  published:   v${ver.marker || "?"} (source ${ver.markerCommit || "?"})`);
    if (resumed) {
      out.push(
        `  RESUMING:    marker says v${ver.marker}, log's last release is v${ver.state} — a publish ` +
          `forged and stamped, then a gate failed. That number is reused, not skipped.`
      );
    } else if (!result.version_agrees) {
      out.push(
        `  MISMATCH:    release log says v${ver.state} but the forged marker says v${ver.marker} — ` +
          `the forged core is OLDER than the log claims; reconcile before bumping`
      );
    }
    out.push(`  HEAD:        ${head.sha}${head.branch ? ` (${head.branch})` : ""}`
      + (head.dirty
        ? ` — working tree DIRTY (${uncommitted.length} core-bound)`
        : ""));
    out.push(`  surfaces:    ${paths.length} core-bound path(s) — from ${source}`);
    out.push("");
    if (pending.unknownBase) {
      out.push("  Cannot diff: the published source commit is unknown or not in this repo's history.");
      out.push("  Publish once to establish the baseline.");
    } else if (!pending.commits.length && !pending.files.length) {
      out.push("  Committed state is in sync — no core-bound commit since the last publish.");
    } else {
      out.push(`  PENDING: ${pending.commits.length} commit(s), ${pending.files.length} file(s) since v${ver.marker}`);
      for (const c of pending.commits.slice(0, 15)) out.push(`    ${c.sha}  ${c.subject}`);
      if (pending.commits.length > 15) out.push(`    … ${pending.commits.length - 15} more`);
      out.push("");
      out.push(`  units changed (inventory read from ${cls.inventory_source}):`);
      out.push(...renderDelta(rows));
      out.push("");
      out.push(
        `  next version would be v${next} — ${bump.toUpperCase()}` +
          (flag("version") ? " (explicit --version)" : flag("bump") ? " (explicit --bump)" : `, derived: ${cls.reasons.join("; ")}`)
      );
    }
    if (uncommitted.length) {
      out.push("");
      out.push(
        `  UNCOMMITTED: ${uncommitted.length} core-bound file(s) not in HEAD. The forge copies the`
      );
      out.push(
        "  working tree, so these WOULD ship — but the log records HEAD, so the release could not be"
      );
      out.push("  rebuilt from its own commit. Commit them first.");
      for (const f of uncommitted.slice(0, 15)) out.push(`    ${f}`);
      if (uncommitted.length > 15) out.push(`    … ${uncommitted.length - 15} more`);
    }
    if (pending.commits.length || pending.files.length || uncommitted.length) {
      out.push("");
      // The derived class is the default, so the suggested command carries --bump only when
      // the operator already overrode it — otherwise the hint would train them to pin it.
      const targetArg = flag("target") ? ` --target ${portable(SRC_REL)}` : "";
      const bumpArg = flag("bump") ? ` --bump ${bump}` : "";
      out.push(`  run: node scripts/framework-core-publish.mjs publish${targetArg}${bumpArg}`);
    } else {
      out.push("  No release owed.");
    }

    out.push("");
    if (remoteState === "served") {
      out.push(`  remote:      SERVED — v${result.remote_verified_version} verified at ${result.remote_checked_at}`);
    } else if (remoteState === "not_served") {
      const first = (negative.checks || []).find((c) => c && c.ok === false);
      out.push(`  remote:      NOT SERVED — v${lastLocal.version}: ${first ? first.detail : "the remote does not serve this release"}`);
      out.push("               finish it: node scripts/framework-core-publish.mjs release --yes");
    } else if (lastLocal) {
      out.push(`  remote:      NOT VERIFIED — v${lastLocal.version} is a LOCAL release; nothing has asked the remote.`);
      out.push("               run: node scripts/framework-core-publish.mjs verify-remote");
    }

    if (orphanTags.length) {
      out.push("");
      out.push(`  UNLOGGED TAGS: ${orphanTags.length} tag(s) in the core with no release-log entry —`);
      out.push("  cut outside this script, so nothing recorded what they contain.");
      for (const t of orphanTags) {
        const where = t.served === true
          ? "SERVED by the remote — do NOT delete it; backfill its log entry instead"
          : t.served === false
            ? "local only, never pushed — deleting it is safe"
            : "remote unreachable, so whether it is published is unknown";
        out.push(`    ${t.tag}  ${where}`);
      }
    }

    if (phantomHistory.length) {
      out.push("");
      out.push(`  HISTORY WITHOUT A LOG ENTRY: ${phantomHistory.length} version(s) that `
        + `${portable(STATE_REL)} records as released and ${portable(LOG_REL)} has no section for.`);
      out.push("  `history` is appended from whatever the core marker said at each cut, so a hand-forge");
      out.push("  that stamped a version it never released leaves an entry nothing else backs. It is not");
      out.push("  cosmetic: publishedVersions() reads it, so a re-publish of one of these is graded a");
      out.push("  re-land and refused without --reland.");
      for (const h of phantomHistory) {
        out.push(`    v${h.version}${h.source_commit ? `  (source ${h.source_commit})` : ""}`);
      }
      out.push("  Fix by backfilling the log entry if the release was real, or by removing the history");
      out.push("  row if it never was — an operator decision either way; this never edits it.");
    }
    process.stdout.write(out.join("\n") + "\n");
  }
  // Exit 10 on a pending release so a hook or sequence step can gate on it; a dirty
  // tree alone is not a failure (the operator may be mid-change and only checking).
  process.exit(pending.commits.length || pending.files.length || uncommitted.length ? 10 : 0);
}

// ── publish ─────────────────────────────────────────────────────────────────
// Two file lists, never one. They answer different questions and conflating them is what made
// v1.4.1's entry claim AGENTS.md shipped: `coreDiff` is what the release CONTAINS (hashed forged
// trees, before vs after); `pending.files` is the SOURCE churn that justified cutting it. A source
// path can be core-bound and still leave the forged tree untouched — that is not a bug, it is the
// difference between a reason and a payload.
function renderCoreDiff(coreDiff, prevVersion) {
  const lines = [];
  if (!coreDiff) return lines;
  if (coreDiff.baseline === "none") {
    lines.push(
      "**What this release changed in the core** — baseline forge: no previously published core to " +
        `diff against, so all ${coreDiff.fileCount} forged file(s) are new.`
    );
    return lines;
  }
  if (!coreDiff.rows.length) {
    lines.push(
      "**What this release changed in the core** — nothing. The forged tree is byte-identical " +
        "(wall-clock timestamps masked) to the one that preceded it: this release is a re-forge of " +
        "the same content. Any source churn listed below never reached the core."
    );
    return lines;
  }
  const qualifier =
    coreDiff.baseline === "previous-release"
      ? `against the forged tree of v${coreDiff.baselineVersion}`
      : `against the tree ON DISK, which was DIRTY — treat this as indicative, not as a diff ` +
        `against the previous release. A previously REFUSED ` +
        `re-publish is the usual reason: it forges before it compares, so the next run finds the ` +
        `tree it wrote rather than the released one`;
  lines.push(
    `**What this release changed in the core** — ${coreDiff.rows.length} path(s), ${qualifier}. ` +
      "Computed by hashing the forged tree before and after the forge."
  );
  lines.push("");
  lines.push("<details><summary>Core files</summary>");
  lines.push("");
  for (const row of coreDiff.rows.slice(0, 200)) lines.push(`- \`${row}\``);
  if (coreDiff.rows.length > 200) lines.push(`- … and ${coreDiff.rows.length - 200} more`);
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push(
    "> Counts here will not match the README's `## Changes in this release` table: that delta skips " +
      "symlinks and masks shas, this one follows symlinks and masks only timestamps. Both are " +
      "correct for their audience — the README's is consumer-facing, this one is release-engineering."
  );
  return lines;
}

function renderLogEntry({ version, prevVersion, head, branch, pending, uncommitted, when, forgeCmd, surfaceSource, cls, rows, gates, coreDiff = null }) {
  const lines = [];
  lines.push("");
  lines.push(`## v${version} — ${when.date}`);
  lines.push("");
  lines.push(
    `Forged from \`${head}\`${branch ? ` on \`${branch}\`` : ""} at ${when.stamp}. ` +
      `Previous release: ${prevVersion ? `v${prevVersion}` : "none (baseline)"}.` +
      (cls ? ` Version class **${cls.kind}** — ${cls.reasons.join("; ")}.` : "")
  );
  lines.push("");
  for (const line of renderCoreDiff(coreDiff, prevVersion)) lines.push(line);
  if (coreDiff) lines.push("");
  if (pending.unknownBase) {
    lines.push(
      "Baseline release — no previous published commit to diff against, so the change list is not derivable."
    );
  } else if (!pending.commits.length && !pending.files.length) {
    lines.push("No core-bound source change since the previous release (re-forge only).");
  } else {
    lines.push(`**Core-bound source changes** — ${pending.commits.length} commit(s), ${pending.files.length} file(s):`);
    lines.push("");
    lines.push("| Commit | Subject |");
    lines.push("|---|---|");
    for (const c of pending.commits) {
      lines.push(`| \`${c.sha}\` | ${c.subject.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
    lines.push("<details><summary>Source files changed (provenance)</summary>");
    lines.push("");
    lines.push(
      "Paths in THIS repo that changed since the previous release's source commit — the REASON for " +
        "the release, not its contents. What actually shipped is the core-file list above."
    );
    lines.push("");
    for (const f of pending.files) lines.push(`- \`${f}\``);
    lines.push("");
    lines.push("</details>");
  }
  if (uncommitted && uncommitted.length) {
    // Recorded, not hidden: these shipped (the forge copies the working tree) but are
    // absent from the commit named above, so this release is NOT rebuildable from it.
    lines.push("");
    lines.push(
      `**Shipped but uncommitted at forge time** — ${uncommitted.length} file(s) not in \`${head}\`, ` +
        `so this release cannot be rebuilt from that commit:`
    );
    lines.push("");
    for (const f of uncommitted) lines.push(`- \`${f}\``);
  }
  if (rows && rows.length) {
    lines.push("");
    lines.push(`**Units added, removed, or version-bumped** — ${rows.length}:`);
    lines.push("");
    lines.push("| Unit | Published | Source | State |");
    lines.push("|---|---|---|---|");
    for (const r of rows) {
      lines.push(`| \`${r.unit}\` | ${r.published || "—"} | ${r.source || "—"} | ${r.state} |`);
    }
  }
  if (gates && gates.length) {
    // Which gates actually ran is part of what a release IS. A skipped suite recorded as
    // "skipped" is a fact a reader can act on; omitting the row would read as "it passed".
    lines.push("");
    lines.push("**Verification gates**:");
    lines.push("");
    for (const g of gates) lines.push(`- ${g.name} — ${g.result}${g.note ? ` (${g.note})` : ""}`);
  }
  lines.push("");
  lines.push(`Surface set derived from: ${surfaceSource}.`);
  lines.push("");
  lines.push("Forge command:");
  lines.push("");
  lines.push("```sh");
  lines.push(forgeCmd);
  lines.push("```");
  return lines.join("\n") + "\n";
}

const LOG_HEADER = `# Framework core — release log

Auto-generated by \`scripts/framework-core-publish.mjs publish\`. Do not hand-edit: entries are
derived from \`git log\` over the paths that actually travel into the core, and a hand-written note
here would not match the release it describes.

The core repo itself carries no changelog on purpose — its content is forged, so any file written
into it by hand is destroyed at the next \`create --force\` (inheritance is one-way). This log lives
in the root repo, next to the service, and commits with the gitlink bump.

Newest entries are appended at the bottom.
`;

/**
 * Drop every existing `## vX.Y.Z` section for `version` and write `entry` at the bottom — or plain
 * append when the version is not in the log yet. The re-landed entry lands last rather than in its
 * old position, which matches the log's own "newest entries at the bottom" convention: it is the
 * most recently written entry.
 *
 * Only `--reland` takes this path; an ordinary publish still appends, so the log stays a plain
 * append-only history for every version that is cut once. Section boundaries are the `## v` headings
 * — renderLogEntry emits exactly one `##` per entry and nothing nested (subsections are bold text,
 * tables or <details>), so the next `## v` heading is unambiguously the end of this entry, fenced
 * code blocks included.
 *
 * Relanding a version that was accidentally logged twice collapses BOTH sections into one, which is
 * the repair path for a log that already has duplicates.
 */
function upsertLogEntry(logPath, version, entry) {
  const text = readFileSync(logPath, "utf8");
  const lines = text.split("\n");
  const heading = new RegExp(`^## v${version.replace(/\./g, "\\.")}(?:\\s|$)`);
  const anyHeading = /^## v\d+\.\d+\.\d+(?:\s|$)/;

  const kept = [];
  let dropping = false;
  let replaced = false;
  for (const line of lines) {
    if (heading.test(line)) {
      dropping = true;
      replaced = true;
      continue;
    }
    if (dropping && anyHeading.test(line)) dropping = false;
    if (!dropping) kept.push(line);
  }
  if (!replaced) {
    appendFileSync(logPath, entry);
    return { replaced: false };
  }

  // renderLogEntry opens with a blank line, so trim the tail before splicing to avoid growing a
  // run of blank lines every time a version is re-landed.
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  writeFileSync(logPath, `${kept.join("\n")}\n${entry}`);
  return { replaced: true };
}

// ── Verification gates ──────────────────────────────────────────────────────
// A forge that produced files is not a release. Five gates, in ascending order of what
// they can prove, each run against the ARTIFACT rather than against the engine's own
// report of what it did:
//
//   1. inherit verify   — the core is self-contained and its own CLI runs
//   2. doctors          — its configuration and framework enable map resolve INSIDE it
//   3. its test suite   — the code it ships actually passes its own gates
//   4. drift            — what was forged matches what the source says it should be
//   5. mount            — a consumer mounting it gets a working workspace
//   6. upgrade          — a consumer UPGRADING to it from the last served release gets one too
//
// Gate 5 is the one that answers the question the others cannot: everything above tests
// the core as a directory, and only this tests it as a thing someone installs. Gate 6 exists
// because gate 5 installs it FRESH, and a fresh install never runs the update tail — which is
// where a whole class of defect lives, invisible to every gate above it.

/** Run one subprocess and keep only enough output to diagnose a failure. */
function step(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  const text = `${r.stdout || ""}${r.stderr || ""}`.trimEnd();
  const tail = text.split("\n").slice(-25).join("\n");
  return { ok: r.status === 0, status: r.status ?? -1, tail };
}

const nodeStep = (args, cwd) => step(process.execPath, args, cwd);

/**
 * A commit object holding the core's WORKING TREE, created without moving any ref.
 *
 * This exists because the gate below has to mount the candidate, and `git submodule add <path>`
 * clones the source's committed HEAD — which at gate time is the PREVIOUS release, because publish
 * deliberately commits only after every gate passes. So the gate used to validate the last release
 * instead of the one being cut, and on a FIRST-EVER release (HEAD carrying only an unrelated initial
 * commit) it failed outright: no `bin/sidekicks` in the clone, so `core init` died with
 * MODULE_NOT_FOUND. Neither is what the docblock below promises.
 *
 * Plumbing, so the core repo is untouched: a throwaway index built via GIT_INDEX_FILE, `write-tree`
 * to turn it into a tree object, then `commit-tree` to wrap it. No branch moves, HEAD does not move,
 * nothing is staged in the real index, and the resulting commit is unreferenced — git garbage-collects
 * it. `add -A` against a temp index picks up untracked forge output too, which matters: a fresh forge
 * is almost entirely untracked.
 *
 * @returns {{ok: true, sha: string} | {ok: false, note: string}}
 */
function candidateCommit() {
  const idx = join(tmpdir(), `sk-core-gate-index-${process.pid}`);
  const g = (args) => spawnSync("git", args, {
    cwd: SRC_ABS, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: idx },
  });
  try {
    const added = g(["add", "-A"]);
    if (added.status !== 0) {
      return { ok: false, note: `could not stage the forged tree for the mount check: ${(added.stderr || "").trim()}` };
    }
    const tree = g(["write-tree"]);
    if (tree.status !== 0 || !tree.stdout.trim()) {
      return { ok: false, note: `could not write a tree for the mount check: ${(tree.stderr || "").trim()}` };
    }
    // Parented on HEAD when there is one, so the clone below has ordinary history to check out. A core
    // repo with no commit at all yields a parentless commit, which is equally mountable.
    const head = git(["rev-parse", "HEAD"], SRC_ABS);
    const args = ["commit-tree", tree.stdout.trim(), "-m", "mount-check candidate (throwaway)"];
    if (head.ok && head.out) args.push("-p", head.out);
    const commit = g(args);
    if (commit.status !== 0 || !commit.stdout.trim()) {
      return { ok: false, note: `could not create the mount-check commit: ${(commit.stderr || "").trim()}` };
    }
    return { ok: true, sha: commit.stdout.trim() };
  } finally {
    try {
      rmSync(idx, { force: true });
    } catch {
      /* a leftover temp index is not worth failing a release over */
    }
  }
}

/**
 * Mount the forged core into a throwaway workspace the way a consumer does, then ask the
 * workspace's own doctor whether it is sound.
 *
 * Uses a submodule, not a copy: `core init` and `core doctor` reason about a mount that git
 * tracks, and a copied directory would pass checks a real install fails.
 *
 * What is mounted is the CANDIDATE — the forged working tree, wrapped in a throwaway commit by
 * candidateCommit() above and checked out inside the clone. Cloning the core's HEAD instead would
 * gate the previous release, which is the defect this replaced.
 *
 * The doctor run is `--all`: core + framework + config + strict skill integrity, all from the
 * workspace root. See the comment at the call site.
 */
function mountCheck() {
  if (!targetIsOwnRepo()) {
    return { ok: true, skipped: true, note: "the target is not its own git repository, so there is nothing to mount" };
  }
  const candidate = candidateCommit();
  if (!candidate.ok) return { ok: false, note: candidate.note };
  let ws = null;
  try {
    ws = mkdtempSync(join(tmpdir(), "sk-core-mount-"));
    const g = (args) => spawnSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd: ws, encoding: "utf8" });
    g(["init", "-q", "."]);
    g(["config", "user.email", "publish@sidekicks.local"]);
    g(["config", "user.name", "framework-core-publish"]);
    const added = g(["submodule", "add", "-q", SRC_ABS, ".sidekicks-core"]);
    if (added.status !== 0) {
      return { ok: false, note: `could not mount the core as a submodule: ${(added.stderr || "").trim().split("\n").slice(-3).join(" ")}` };
    }
    // Move the mount onto the candidate. `submodule add` cloned HEAD; the release being gated is the
    // working tree, so fetch the throwaway commit by sha and detach onto it.
    const mount = join(ws, ".sidekicks-core");
    const fetched = spawnSync("git", ["-c", "protocol.file.allow=always", "fetch", "-q", SRC_ABS, candidate.sha],
      { cwd: mount, encoding: "utf8" });
    if (fetched.status !== 0) {
      return { ok: false, note: `could not fetch the candidate into the mount: ${(fetched.stderr || "").trim().split("\n").slice(-3).join(" ")}` };
    }
    const checkedOut = spawnSync("git", ["checkout", "-q", "--detach", candidate.sha], { cwd: mount, encoding: "utf8" });
    if (checkedOut.status !== 0) {
      return { ok: false, note: `could not check the candidate out in the mount: ${(checkedOut.stderr || "").trim().split("\n").slice(-3).join(" ")}` };
    }
    const init = nodeStep([join(ws, ".sidekicks-core", "bin", "sidekicks"), "core", "init"], ws);
    if (!init.ok) return { ok: false, note: `core init failed in a fresh workspace`, tail: init.tail };
    // `--all`, not a bare `core doctor` (F-06/F-09). A bare run judges the MOUNT, and the mount was
    // sound in the release this gate passed: the workspace it produced failed framework doctor,
    // config doctor and skill verify, and this gate never asked any of them. --all composes all
    // four, so the gate's question is finally "is the installed workspace healthy" rather than
    // "did the submodule land".
    const doctor = nodeStep([join(ws, "bin", "sidekicks"), "core", "doctor", "--all"], ws);
    if (!doctor.ok) {
      return { ok: false, note: "core doctor --all failed in the mounted workspace", tail: doctor.tail };
    }
    // The doctors answer "is this workspace healthy". They do not answer "does this workspace pass
    // its own gates", and the two came apart: `check run quick` was red in EVERY mounted workspace
    // while this gate was green, because catalog.check resolved framework paths against the
    // workspace root and tests.contract named files a mount does not carry at that path. The release
    // path already builds a real mount here; it simply never asked (INC-2026-09-04-01, F-3).
    //
    // `full`, not `quick` — asking only the cheapest profile is how the SECOND round of the same bug
    // shipped. v1.4.2 passed this gate with a green `quick` while `parity` named two suites living
    // in repo-root tests/, which travels into no core, so `check run full` was red in every consumer
    // install and `release` scored 9/13 (INC-2026-09-04-02, N-3). `full` adds parity, the whole test
    // suite and skill.doctor --strict inside the mount. Not `release`: its `core.mounted` gate would
    // build a core from this core, and `package.clean` is covered directly below instead.
    const check = nodeStep([join(ws, "bin", "sidekicks"), "check", "run", "full", "--json"], ws);
    if (!check.ok) {
      return { ok: false, note: "check run full failed in the mounted workspace", tail: check.tail };
    }
    // `package.clean` is release-profile only, so `full` does not reach it — and it is the gate that
    // died in a mount with "validateSource: lib/sk-cli not found", taking two more down with it as
    // BLOCKED. Ask it directly rather than recursing through the whole release profile.
    const pkg = nodeStep(
      [join(ws, "bin", "sidekicks"), "package", "create", "--output", join(ws, "..", "pkg-smoke"), "--dry-run"],
      ws
    );
    if (!pkg.ok) {
      return {
        ok: false,
        note: "package create could not resolve the framework from the mounted workspace",
        tail: pkg.tail,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, note: `mount check could not run: ${err && err.message ? err.message : String(err)}` };
  } finally {
    if (ws) {
      try {
        rmSync(ws, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not worth failing a release over */
      }
    }
  }
}

/**
 * Install the PREVIOUS served release the way a consumer did, then upgrade it to the candidate.
 *
 * WHY A SECOND MOUNT GATE. `mountCheck` above installs the candidate FRESH, and a fresh install was
 * clean for every release this gate would have caught. `core update` is a verb of the core being
 * REPLACED: the workspace shim forwards into the mount, so after `git checkout` swaps the files it
 * was still the outgoing release's already-imported modules that re-derived the workspace from them.
 * Every fix living in that tail therefore skipped the update that installed it — v1.4.3 shipped with
 * a green mount check while upgrading a v1.4.2 workspace to it reproduced both defects it fixed
 * (INC-2026-09-04-03). A gate that only ever installs the new core cannot see that, by construction.
 *
 * The assertion is step 5: the NEW core's own `core doctor --all` in a workspace that arrived there
 * by upgrading, not by installing. v1.4.3 would have failed it.
 *
 * @returns {{ok: true, skipped?: boolean, note?: string} | {ok: false, note: string, tail?: string}}
 */
function upgradeCheck() {
  if (!targetIsOwnRepo()) {
    return { ok: true, skipped: true, note: "the target is not its own git repository, so there is nothing to upgrade" };
  }
  // The previous release must be one the REMOTE actually served: an upgrade path only exists from a
  // version a consumer could have installed. state.json's remote_verified is the only field that
  // means that (last_local_release is explicitly not evidence anyone can fetch it).
  const stateNow = readJson(STATE_REL) || {};
  const prev = stateNow.remote_verified && stateNow.remote_verified.version
    ? String(stateNow.remote_verified.version)
    : null;
  if (!prev) {
    return { ok: true, skipped: true, note: "no verified remote release to upgrade FROM — nothing to check yet" };
  }
  const prevTag = `v${prev}`;
  const prevSha = git(["rev-parse", "--verify", `${prevTag}^{commit}`], SRC_ABS);
  if (!prevSha.ok || !prevSha.out) {
    return { ok: true, skipped: true, note: `${prevTag} was served but does not resolve in this checkout — cannot mount it` };
  }
  const candidate = candidateCommit();
  if (!candidate.ok) return { ok: false, note: candidate.note };

  let ws = null;
  try {
    ws = mkdtempSync(join(tmpdir(), "sk-core-upgrade-"));
    const g = (args, cwd = ws) => spawnSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8" });
    g(["init", "-q", "."]);
    g(["config", "user.email", "publish@sidekicks.local"]);
    g(["config", "user.name", "framework-core-publish"]);
    const added = g(["submodule", "add", "-q", SRC_ABS, ".sidekicks-core"]);
    if (added.status !== 0) {
      return { ok: false, note: `could not mount the previous release: ${(added.stderr || "").trim().split("\n").slice(-3).join(" ")}` };
    }
    const mount = join(ws, ".sidekicks-core");

    // 1. Put the mount on the previous SERVED release, and record it as the tracked ref the way both
    //    installers do — the pin is what makes this an upgrade rather than a re-install.
    const onPrev = g(["checkout", "-q", "--detach", prevSha.out], mount);
    if (onPrev.status !== 0) {
      return { ok: false, note: `could not check out ${prevTag} in the mount: ${(onPrev.stderr || "").trim().split("\n").slice(-3).join(" ")}` };
    }
    g(["config", "-f", ".gitmodules", "submodule..sidekicks-core.branch", prevTag]);
    g(["add", ".gitmodules"]);

    // 2. The OLD core seeds the workspace. Through its own bin, because the workspace has no shim yet.
    const init = nodeStep([join(mount, "bin", "sidekicks"), "core", "init"], ws);
    if (!init.ok) {
      return { ok: false, note: `${prevTag} could not seed a workspace — the upgrade path starts from a broken install`, tail: init.tail };
    }
    // Asked explicitly: a `core init` that exits 0 without writing the shim leaves every step below
    // failing as MODULE_NOT_FOUND, which names the symptom and not the cause.
    if (!existsSync(join(ws, "bin", "sidekicks"))) {
      return {
        ok: false,
        note: `${prevTag} seeded a workspace with no bin/sidekicks shim, so there is nothing to upgrade THROUGH`,
        tail: init.tail,
      };
    }

    // 3. The candidate is an unreferenced throwaway commit, so `core update`'s own
    //    `fetch origin --tags` cannot reach it — and that fetch failing is non-fatal by design.
    //    Put the object in the mount first, so the ref ladder resolves it locally.
    const fetched = spawnSync("git", ["-c", "protocol.file.allow=always", "fetch", "-q", SRC_ABS, candidate.sha],
      { cwd: mount, encoding: "utf8" });
    if (fetched.status !== 0) {
      return { ok: false, note: `could not fetch the candidate into the mount: ${(fetched.stderr || "").trim().split("\n").slice(-3).join(" ")}` };
    }

    // 4. THE UPGRADE, through the WORKSPACE shim — i.e. run by the OLD core, which is the point.
    const upd = nodeStep([join(ws, "bin", "sidekicks"), "core", "update", "--ref", candidate.sha], ws);
    if (!upd.ok) {
      return { ok: false, note: `core update from ${prevTag} to the candidate failed`, tail: upd.tail };
    }

    // 5. THE ASSERTION. The new core's own doctor, in a workspace that got here by upgrading.
    const doctor = nodeStep([join(ws, "bin", "sidekicks"), "core", "doctor", "--all"], ws);
    if (!doctor.ok) {
      return {
        ok: false,
        note: `core doctor --all failed after upgrading a ${prevTag} workspace to this candidate — `
          + "the tail of the update did not run the new core's rules",
        tail: doctor.tail,
      };
    }

    // 6. U-2 directly: the branch key reached the INDEX, not just the worktree. Left unstaged, a
    //    commit records a pin with no tracked ref and a fresh clone falls back to main.
    const inIndex = spawnSync("git", ["show", ":.gitmodules"], { cwd: ws, encoding: "utf8" });
    const onDisk = readFileSync(join(ws, ".gitmodules"), "utf8");
    if (inIndex.status !== 0 || inIndex.stdout.trim() !== onDisk.trim()) {
      return {
        ok: false,
        note: "after the upgrade .gitmodules disagrees with itself — the tracked ref was written to "
          + "the worktree and never staged, so a commit would record a pin with no ref",
        tail: `index:\n${inIndex.stdout}\nworktree:\n${onDisk}`,
      };
    }
    return { ok: true, note: `upgraded a ${prevTag} workspace to the candidate` };
  } catch (err) {
    return { ok: false, note: `upgrade check could not run: ${err && err.message ? err.message : String(err)}` };
  } finally {
    if (ws) {
      try {
        rmSync(ws, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not worth failing a release over */
      }
    }
  }
}

/**
 * Every gate, in order. Returns the rows for the log entry plus the first failure, if any.
 * Stops at the first failure: gate 3 has nothing useful to say about a core whose CLI does
 * not even start, and a wall of downstream noise buries the one line that matters.
 */
function runGates(inheritAbs) {
  const gates = [];
  const targetCli = join(SRC_ABS, "bin", "sidekicks");

  const record = (name, result, note, tail) => {
    gates.push({ name, result, note });
    return { gates, failed: result === "FAIL" ? { name, note, tail } : null };
  };

  // 1 — self-containment, runnability, core distribution, scripts ownership.
  const verify = nodeStep([inheritAbs, "verify", "--name", RUNTIME_NAME, "--target", portable(SRC_REL)], ROOT);
  if (!verify.ok) return record("inherit verify", "FAIL", `exit ${verify.status}`, verify.tail);
  gates.push({ name: "inherit verify", result: "pass" });

  // 2 — the doctors, run INSIDE the core so they read its config, not this repo's.
  for (const [ns, label] of [["config", "config doctor"], ["framework", "framework doctor"]]) {
    const d = nodeStep([targetCli, ns, "doctor"], SRC_ABS);
    if (!d.ok) return record(label, "FAIL", `exit ${d.status} inside the core`, d.tail);
    gates.push({ name: label, result: "pass" });
  }

  // 3 — the core's own suite, run through the ARTIFACT'S OWN declared gate.
  //
  // This gate used to lie in two ways at once (F-05). It skipped silently whenever the core had no
  // top-level tests/ — which the v2.0.0 core did not, so the release recorded "skipped" while 89
  // real tests sat unrun under lib/artifacts-lifecycle/tests/. And when it did run, it ran a glob
  // of its own choosing rather than the command the artifact ships, so it could not have caught
  // that `npm test` in the artifact discovers nothing and exits 0.
  //
  // Now: run the artifact's launcher, require a NON-ZERO discovered test count, and treat an
  // absent gate as a failure. --no-tests remains the one waiver, and it is recorded in the log.
  if (NO_TESTS) {
    gates.push({ name: "core test suite", result: "SKIPPED", note: "--no-tests (explicit, recorded waiver)" });
  } else {
    const launcher = join(SRC_ABS, "scripts", "run-tests.mjs");
    if (!existsSync(launcher)) {
      return record("core test suite", "FAIL",
        "the core ships no scripts/run-tests.mjs — it has no test gate that can fail honestly. "
        + "Re-forge with an engine that carries it, or waive with --no-tests.");
    }
    const disc = spawnSync(process.execPath, [launcher, "--list", "--json"],
      { cwd: SRC_ABS, encoding: "utf8" });
    let found = null;
    try { found = JSON.parse(disc.stdout || "null"); } catch { /* handled below */ }
    if (!found || !found.count) {
      return record("core test suite", "FAIL",
        "the core's own test gate discovers ZERO test files — a green `npm test` there would be "
        + "false confidence, not a passing suite",
        (disc.stderr || disc.stdout || "").trim().split("\n").slice(-10).join("\n"));
    }
    const t = nodeStep([launcher], SRC_ABS);
    if (!t.ok) return record("core test suite", "FAIL", `exit ${t.status} over ${found.count} file(s)`, t.tail);
    gates.push({ name: "core test suite", result: "pass",
      note: `${found.count} file(s) under ${(found.roots || []).join(", ")}` });
  }

  // 4 — the forge produced what the source says it should have.
  const drift = nodeStep([inheritAbs, "drift", "--name", RUNTIME_NAME, "--target", portable(SRC_REL), "--json"], ROOT);
  if (!drift.ok) return record("post-forge drift", "FAIL", `exit ${drift.status} — the forged core is already out of step with its source`, drift.tail);
  gates.push({ name: "post-forge drift", result: "pass" });

  // 5 — a consumer's install actually works.
  if (NO_MOUNT_CHECK) {
    gates.push({ name: "mount check", result: "SKIPPED", note: "--no-mount-check" });
  } else {
    const m = mountCheck();
    if (!m.ok) return record("mount check", "FAIL", m.note, m.tail);
    gates.push({ name: "mount check", result: m.skipped ? "skipped" : "pass", note: m.note });
  }

  // 6 — a consumer's UPGRADE actually works. Gate 5 installs the candidate fresh, which stays green
  // for every defect that lives in the update tail, because a fresh install never runs it.
  //
  // --no-mount-check waives this one too, and deliberately: both gates ask "does this behave as a
  // thing someone installs", and that flag is what a caller passes when the target is not a real
  // mountable core (the publish suite's synthetic fixtures). Honouring only the fresh half would
  // turn every existing --no-mount-check caller red on a question it had already waived.
  // --no-upgrade-check waives the upgrade half alone.
  if (NO_UPGRADE_CHECK || NO_MOUNT_CHECK) {
    gates.push({ name: "upgrade check", result: "SKIPPED",
      note: NO_UPGRADE_CHECK ? "--no-upgrade-check" : "--no-mount-check" });
  } else {
    const u = upgradeCheck();
    if (!u.ok) return record("upgrade check", "FAIL", u.note, u.tail);
    gates.push({ name: "upgrade check", result: u.skipped ? "skipped" : "pass", note: u.note });
  }

  return { gates, failed: null };
}

// ── The local half of a release ─────────────────────────────────────────────
// Committing and tagging is local and reversible; pushing is neither, so it stays printed.
// Both repos are checked against the protected-branch floor first — a release commit is
// still a commit, and "it is only generated output" is not an exemption the rule grants.

function commitLocally(version, when) {
  const out = [];
  const ownRepo = targetIsOwnRepo();
  const coreBranch = ownRepo ? git(["branch", "--show-current"], SRC_ABS).out : null;
  const rootBranch = git(["branch", "--show-current"]).out;
  const blocked = [];
  if (isProtected(coreBranch)) blocked.push(`the core is on '${coreBranch}'`);
  if (isProtected(rootBranch)) blocked.push(`this repo is on '${rootBranch}'`);

  if (blocked.length && !ALLOW_PROTECTED) {
    return {
      committed: false,
      blocked: true,
      lines: [
        `  NOT COMMITTED: ${blocked.join(" and ")} — protected.`,
        "  A release commit is still a commit, and CLAUDE.md's protected-branch rule holds in every",
        "  repo a run touches. Move onto a work branch, or re-run with --allow-protected if landing",
        "  on the protected branch is deliberate.",
      ],
    };
  }
  if (blocked.length) out.push(`  --allow-protected: committing anyway (${blocked.join(", ")}).`);

  const tag = `v${version}`;
  if (!ownRepo) {
    // A target that is a plain directory inside this repo has no history of its own; its content
    // rides in the root commit below. Committing "in the core" would silently commit the ROOT repo.
    out.push("  core:  not its own git repository — its content lands in this repo's commit instead");
  } else {
    git(["add", "-A"], SRC_ABS);
    const commit = git(["commit", "-m", `chore(release): framework core ${tag}`], SRC_ABS);
    if (!commit.ok && !/nothing to commit/i.test(commit.out + commit.err)) {
      return { committed: false, error: `core commit failed: ${commit.err || commit.out}` };
    }
    const head = git(["rev-parse", "HEAD"], SRC_ABS);

    // A tag that already exists is NOT a benign note. Left alone it keeps naming an older commit,
    // so the release the tag points at is not the tree that just passed the gates — which is
    // exactly how v2.0.0 ended up 53 files away from its own tag while the run exited 0. Only a
    // tag that already names THIS commit is benign; anything else is a stop or an explicit --reland.
    const existing = git(["rev-list", "-n", "1", tag], SRC_ABS);
    if (existing.ok && existing.out && existing.out !== head.out) {
      if (!RELAND) {
        return {
          committed: false,
          error:
            `tag ${tag} already exists and points at ${existing.out.slice(0, 7)}, not the release ` +
            `commit ${(head.out || "").slice(0, 7)}. Moving a released tag is not something this ` +
            `script does on its own — re-run with --reland to move it, or cut a new version.`,
        };
      }
      const moved = git(["tag", "-f", "-a", tag, "-m", `framework core ${tag}`], SRC_ABS);
      if (!moved.ok) return { committed: false, error: `could not move tag ${tag}: ${moved.err || moved.out}` };
      out.push(`  core:  committed on '${coreBranch || "(detached)"}', tag ${tag} MOVED ` +
        `${existing.out.slice(0, 7)} → ${(head.out || "").slice(0, 7)} (--reland)`);
    } else if (existing.ok && existing.out) {
      out.push(`  core:  committed on '${coreBranch || "(detached)"}', tag ${tag} already on this commit`);
    } else {
      const tagged = git(["tag", "-a", tag, "-m", `framework core ${tag}`], SRC_ABS);
      if (!tagged.ok) {
        return { committed: false, error: `tag ${tag} could not be created: ${tagged.err || tagged.out}` };
      }
      out.push(`  core:  committed + tagged ${tag} on '${coreBranch || "(detached)"}'`);
    }
  }

  // Register the moved submodule in this repo, then commit the gitlink together with the
  // release log — they describe the same event and must not land in separate commits.
  const cli = join(ROOT, "bin", "sidekicks");
  if (existsSync(cli)) {
    nodeStep([cli, "service", "sync"], ROOT);
    nodeStep([cli, "index", "rebuild"], ROOT);
  }
  git(["add", SRC_REL, RUN_REL]);
  const rootCommit = git(["commit", "-m", `chore(framework): bump ${RUNTIME_NAME} core gitlink to ${tag}`]);
  if (rootCommit.ok) out.push(`  root:  committed the gitlink bump + release log on '${rootBranch}'`);
  else if (/nothing to commit/i.test(rootCommit.out + rootCommit.err)) out.push("  root:  nothing to commit (gitlink already current)");
  else return { committed: false, error: `root commit failed: ${rootCommit.err || rootCommit.out}` };

  return { committed: true, lines: out, tag, when };
}

// ── verify ──────────────────────────────────────────────────────────────────
function doVerify() {
  const inheritAbs = join(ROOT, INHERIT_REL);
  if (!existsSync(inheritAbs)) {
    process.stderr.write(`the inherit engine is missing at ${portable(INHERIT_REL)} — cannot verify\n`);
    process.exit(3);
  }
  process.stdout.write(`Verifying ${portable(SRC_REL)}\n\n`);
  const { gates, failed } = runGates(inheritAbs);
  for (const g of gates) {
    process.stdout.write(`  ${g.result.padEnd(8)} ${g.name}${g.note ? ` — ${g.note}` : ""}\n`);
  }
  if (failed) {
    process.stderr.write(`\n${failed.name} FAILED — ${failed.note || ""}\n${failed.tail ? failed.tail + "\n" : ""}`);
    process.exit(1);
  }
  process.stdout.write("\nEvery gate passed — this core is publishable.\n");
  process.exit(0);
}

// ── GATE: the PREVIOUS release must already be SERVED by the core's remote ──
// A release is not finished when it is tagged; it is finished when the remote serves the tag,
// because the core's README pins installs to `--ref v<version>`. v1.1.0 and v1.1.1 both landed
// on the remote's `main` with NO tag — a bare `git push` instead of the printed
// `push origin HEAD --tags` — so both releases were uninstallable by the only name they
// document, and the first thing to notice was an installer falling back to a commit pin.
//
// Nothing caught it because the one verb that can (`verify-remote`) is a separate command
// nobody ran, so each unpushed release was buried under the next one. Cutting a new version is
// the moment that matters: it is the last point where the previous tag can still be pushed
// without archaeology, so the check goes HERE rather than in a report.
//
// Only the TAG is scored. The per-release core branch may legitimately be absent from the
// remote, and treating that as a failure is the false negative that
// `memory show verify-remote-checks-the-core-branch` records.
//
// It never fails for the network: an unreachable remote, a missing `origin`, or a target that is
// not its own repository all WARN and continue, because a connectivity-shaped problem must not
// be able to block a release. Only a reachable remote that demonstrably does not serve the
// previous tag is a stop, and `--allow-unpushed` is the operator's explicit yes.
//
// @returns {{ok: boolean, version: string, detail: string, blocking: boolean}|null} null when
// there is nothing to check (first release, or the target has no repo of its own).
function previousReleaseServed() {
  if (!targetIsOwnRepo()) return null;
  const last = lastRelease(readJson(STATE_REL));
  if (!last) return null;
  const res = verifyRemote();
  const tag = res.checks.find((c) => c.ref.startsWith("refs/tags/"));
  // No tag check at all means verifyRemote returned early — no origin, or ls-remote failed.
  if (!tag) {
    const why = res.checks[0] ? res.checks[0].detail : "the remote could not be queried";
    return { ok: false, version: String(last.version), detail: why, blocking: false };
  }
  return { ok: tag.ok, version: String(last.version), detail: tag.detail, blocking: !tag.ok };
}

async function doPublish() {
  const ver = publishedVersion();
  const { paths, skills, source } = corePaths();
  const head = headInfo();
  const base = ver.markerCommit || ver.stateCommit;
  const pending = pendingSince(base, paths);
  const uncommitted = uncommittedCoreFiles(paths);
  // Classify BEFORE the forge — afterwards the target holds the new content and the
  // published-versus-source comparison would report every unit as already up to date.
  const cls = await classifyBump(skills);
  const rows = deltaRows(cls);
  const bump = flag("bump") || cls.kind;
  const explicit = flag("version");
  const { base: versionBase, resumed, conflict } = releaseBase(ver);
  const version = explicit || bumpVersion(versionBase || "1.0.0", bump);
  const ref = flag("ref") || "main";
  const when = nowBangkok();

  if (!version) {
    process.stderr.write(
      `cannot resolve the next version: published marker is ${JSON.stringify(ver.marker)} — pass --version X.Y.Z\n`
    );
    process.exit(2);
  }
  if (conflict && !explicit) {
    process.stderr.write(
      `version mismatch: release log says v${ver.state}, forged marker says v${ver.marker}. ` +
        `The forged core is OLDER than the log claims, so the log describes a release that is not in ` +
        `the tree. Reconcile, or pass --version X.Y.Z explicitly.\n`
    );
    process.exit(3);
  }

  // The previous release must be on the remote before a new one buries it (see the gate above).
  const served = previousReleaseServed();
  if (served && !served.ok) {
    const push = [
      `  git -C ${portable(SRC_REL)} push origin v${served.version}`,
      `  node scripts/framework-core-publish.mjs verify-remote`,
    ].join("\n");
    if (!served.blocking) {
      process.stdout.write(
        `NOTE: could not confirm that v${served.version} is served by the core's remote — ` +
          `${served.detail}. Continuing; run verify-remote once the remote is reachable.\n\n`
      );
    } else if (ALLOW_UNPUSHED) {
      process.stdout.write(
        `--allow-unpushed: cutting v${version} while v${served.version} is unpushed ` +
          `(${served.detail}).\n\n`
      );
    } else if (DRY) {
      process.stdout.write(
        `WOULD REFUSE: v${served.version} is a LOCAL release only — ${served.detail}. ` +
          `Push it before cutting v${version}:\n${push}\n\n`
      );
    } else {
      process.stderr.write(
        `v${served.version} was released locally but the remote does not serve its tag: ` +
          `${served.detail}.\n\n` +
          `  The core's README pins installs to \`--ref v<version>\`, so a tag the remote does not\n` +
          `  carry makes that release uninstallable by the name it documents — an installer silently\n` +
          `  falls back to pinning a commit. Cutting v${version} now buries the problem one release\n` +
          `  deeper, so it is refused here instead.\n\n` +
          `  Push the previous release first:\n${push}\n\n` +
          `  Or cut this one deliberately anyway:  --allow-unpushed\n`
      );
      process.exit(5);
    }
  }

  // ── Already released? ─────────────────────────────────────────────────────
  // Re-publishing a released version used to be entirely undetected: the log grew a duplicate
  // section, state.json was overwritten, and the tag silently stayed on the OLD commit. Capture
  // the baseline HERE, before the forge overwrites the target — rung 2 of referenceContent()
  // reads the tree that is about to be destroyed.
  const stateNow = readJson(STATE_REL);
  // A FORGED MARKER IS NOT A RELEASE ON ITS OWN. publish forges and stamps BEFORE it gates, so a run
  // that fails a gate leaves `.sidekicks-core.json` claiming a version that was never released — no
  // log entry, no state record, no tag, no commit. releaseBase() already reasons exactly this way when
  // picking the bump base ("The stamped version was never released"); this check did not, and it took
  // `ver.marker === version` as proof.
  //
  // The consequence was that a FIRST-EVER release could not be retried. The failed attempt's own
  // marker made the retry look like a re-land, and a re-land needs --reland, which is the operator's
  // explicit per-invocation yes and never self-granted — so the run was stuck with nothing published
  // and no non-operator way forward.
  //
  // So the marker's claim is believed only when something CORROBORATES it: a state/log record of any
  // release, or that version's tag. Releases cut before content_hash existed still wrote both.
  //
  // The corroboration is deliberately attached to the MARKER clause rather than replacing it. Making
  // a bare tag mean "already released" on its own looks tidier and is wrong: it short-circuits the
  // tag-safety stop further down, which exists precisely to catch a tag that already names a
  // DIFFERENT commit and says so with a message this refusal cannot give.
  const markerCorroborated = ver.marker === version
    && (Boolean(lastRelease(stateNow))
      || (targetIsOwnRepo() && git(["rev-parse", "-q", "--verify", `refs/tags/v${version}`], SRC_ABS).ok));
  const alreadyReleased = releasedVersions(stateNow).has(version) || markerCorroborated;
  const reference = alreadyReleased && !DRY ? referenceContent(version, stateNow, ver) : null;

  // A digest recorded in state.json proves WHETHER a re-forge diverged but cannot say WHICH paths
  // did — and that is the usual baseline. When the tree still on disk hashes to that same digest it
  // IS the released content, so borrow its per-file map now, before the forge overwrites it, and a
  // refusal can name the files instead of two opaque hashes.
  if (reference && !reference.files) {
    const onDisk = normalizedTreeHash(SRC_ABS);
    if (onDisk.digest === reference.digest) reference.files = onDisk.files;
  }

  if (alreadyReleased && !RELAND && !DRY && !reference) {
    process.stderr.write(
      `v${version} has already been released, and there is no recorded baseline to check a re-forge ` +
        `against (no content_hash in ${portable(STATE_REL)}, and the target on disk is not a clean ` +
        `v${version} tree). Refusing rather than silently appending a second v${version} to the log ` +
        `and leaving the tag where it is.\n\n` +
        `  Note: a PREVIOUS refused re-publish may itself be why the core is dirty — it forges before\n` +
        `  it compares, so the second run finds the tree it wrote rather than the released one. Only\n` +
        `  releases cut before content_hash existed depend on that on-disk fallback.\n\n` +
        `  Re-land it deliberately:  --version ${version} --reland\n` +
        `  Or cut a new version:     omit --version, or pass a higher one\n`
    );
    process.exit(3);
  }

  const inherit = portable(INHERIT_REL);
  const forgeArgs = [
    "create",
    "--name",
    RUNTIME_NAME,
    "--target",
    portable(SRC_REL),
    "--preset",
    PRESET,
    // Explicit, not inferred. The engine turns --as-core on by itself only for `--preset framework`,
    // so the day this script stopped forging that preset the core-distribution files (the
    // .sidekicks-core.json marker, install.sh, install.ps1, AGENTS.framework.md, the generated
    // README) would have silently stopped travelling. What is published is a mountable core whatever
    // skill set it carries, so the flag says so rather than riding on the preset name.
    "--as-core",
    "--force",
    "--prune-skills",
    "--core-version",
    version,
    "--core-ref",
    ref,
    "--remote",
    REMOTE,
  ];
  const forgeCmd = `node ${inherit} \\\n  ${forgeArgs.join(" ").replace(/ --/g, " \\\n  --")}`;

  const out = [];
  out.push(`Publishing framework core v${version}${DRY ? " (dry run — nothing written)" : ""}`);
  out.push(`  from:   ${head.sha}${head.branch ? ` (${head.branch})` : ""}${head.dirty ? " — working tree DIRTY" : ""}`);
  out.push(`  target: ${portable(SRC_REL)}`);
  out.push(
    `  since:  ${base ? `v${ver.marker} (${base})` : "no baseline"} — ${pending.commits.length} commit(s), ` +
      `${pending.files.length} committed file(s), ${uncommitted.length} uncommitted file(s)`
  );
  out.push(
    `  class:  ${bump.toUpperCase()}` +
      (explicit ? " (explicit --version)" : flag("bump") ? " (explicit --bump)" : ` — ${cls.reasons.join("; ")}`)
  );
  if (resumed) {
    out.push(
      `  resume: the marker says v${ver.marker} but the log's last release is v${ver.state} — a previous ` +
        `publish forged and stamped, then a gate failed. Deriving from the LOG, so that number is reused.`
    );
  }
  out.push("");
  out.push(`  units added, removed, or version-bumped (inventory from ${cls.inventory_source}):`);
  out.push(...renderDelta(rows));
  out.push("");

  if (head.dirty) {
    // Not fatal: the forge copies the WORKING TREE, so publishing from a dirty tree is
    // legitimate. But the log records a commit that does not contain those edits, so the
    // release would not be reproducible from that sha — say so loudly.
    out.push(
      "  WARNING: the working tree is dirty. The forge copies working-tree content, but the log"
    );
    out.push(
      `  records ${head.sha}, which does NOT contain the uncommitted edits — the release will not be`
    );
    out.push("  reproducible from that commit. Commit first unless this is deliberate.");
    out.push("");
  }

  if (alreadyReleased) {
    out.push(
      RELAND
        ? `  reland: v${version} is already released — its log entry will be REPLACED and its tag moved.`
        : `  NOTE:   v${version} is already released. The forge will be compared against the recorded` +
          ` release after the gates; identical means nothing is written, different means this stops.`
    );
    out.push("");
  }

  if (DRY) {
    out.push("Would run:");
    out.push("");
    out.push(forgeCmd);
    out.push("");
    out.push(
      RELAND
        ? `Would REPLACE the ## v${version} section in ${portable(LOG_REL)} with:`
        : `Would append to ${portable(LOG_REL)}:`
    );
    out.push("");
    out.push(
      // coreDiff is null: the forge has not run, so there is no forged tree to diff against.
      renderLogEntry({ version, prevVersion: ver.marker, head: head.sha, branch: head.branch, pending, uncommitted, when, forgeCmd, surfaceSource: source, cls, rows, gates: null, coreDiff: null })
    );
    process.stdout.write(out.join("\n") + "\n");
    process.exit(0);
  }

  // The tree as it stands BEFORE the forge overwrites it. This is the only moment it can be
  // captured, and it is what turns the log's file list from "what changed in the SOURCE repo" into
  // "what changed in the CORE" — two different questions the log used to answer with one list, which
  // is how v1.4.1's entry came to name AGENTS.md as shipped when the forged core carried no such
  // change. `coreTreeClean()` decides whether the snapshot is the previous release's tree or merely
  // whatever is on disk; the entry SAYS which, rather than presenting a dirty diff as an exact one.
  //
  // Deliberately a second walk rather than reusing the opportunistic snapshot at the already-released
  // check above: that one sits before this function's dry-run exit and before the no-baseline
  // refusal, and hoisting it would move a filesystem walk across both.
  const preForge = normalizedTreeHash(SRC_ABS);
  // "Is this tree the previous release?" is a cleanliness question, and which repo answers it
  // depends on who tracks the core: its own repo when it has one, otherwise this repo's index over
  // the target path. Asking only `coreTreeClean()` would call every non-submodule target dirty and
  // stamp a correct diff with a false warning.
  const preForgeDirty = targetIsOwnRepo()
    ? !coreTreeClean()
    : (() => {
        const st = git(["status", "--porcelain", "--", SRC_REL]);
        return !st.ok || st.out !== "";
      })();

  // 1) Forge. Inherited from the working tree, one-way, prune-exact.
  out.push("── forge ───────────────────────────────────────────");
  process.stdout.write(out.join("\n") + "\n");
  const forge = spawnSync(process.execPath, [join(ROOT, INHERIT_REL), ...forgeArgs], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (forge.status !== 0) {
    process.stderr.write(`\nforge FAILED (exit ${forge.status}) — nothing logged, no version stamped.\n`);
    process.exit(forge.status || 1);
  }

  // 2) Verify — five gates (self-containment, the doctors inside the core, its own test
  //    suite, post-forge drift, and a real mount). A core that does not verify is not a
  //    release, so the log entry is written only after every gate has passed.
  process.stdout.write("\n── verify ──────────────────────────────────────────\n");
  const { gates, failed } = runGates(join(ROOT, INHERIT_REL));
  for (const g of gates) {
    process.stdout.write(`  ${g.result.padEnd(8)} ${g.name}${g.note ? ` — ${g.note}` : ""}\n`);
  }
  if (failed) {
    process.stderr.write(
      `\n${failed.name} FAILED — ${failed.note || ""}\n${failed.tail ? failed.tail + "\n" : ""}` +
        `\nThe core was forged but is NOT publishable, so no log entry was written and nothing was ` +
        `committed. Fix, then re-run publish.\n`
    );
    process.exit(1);
  }

  // 2b) Reproducibility gate — only when this version was already released.
  //     Everything above proves the forged core is GOOD. This proves it is the SAME good core the
  //     version already names. It runs after the gates and before the first write, so a divergent
  //     re-forge costs a forge but never a log entry, a state overwrite, a commit or a tag.
  const forged = normalizedTreeHash(SRC_ABS);
  if (reference) {
    const same = reference.digest === forged.digest;
    process.stdout.write(
      `  ${(same ? "pass" : "FAIL").padEnd(8)} matches the released v${version} ` +
        `— baseline: ${reference.source}\n`
    );
    if (same && !RELAND) {
      process.stdout.write(
        `\nv${version} is already released and this forge is identical to it (wall-clock timestamps ` +
          `ignored).\nNothing to do — no log entry, no state change, no commit, no tag.\n`
      );
      process.exit(0);
    }
    if (!same && !RELAND) {
      const diff = reference.files ? hashDiff(reference.files, forged.files) : [];
      process.stderr.write(
        `\nv${version} is already released, but this forge DIFFERS from the released content ` +
          `(baseline: ${reference.source}).\n` +
          `Publishing would put two different trees behind one version number.\n` +
          (diff.length
            ? `\n  differing paths (${diff.length}):\n${diff.slice(0, 40).map((d) => `    ${d}`).join("\n")}\n` +
              (diff.length > 40 ? `    … and ${diff.length - 40} more\n` : "")
            : `\n  recorded digest ${reference.digest.slice(0, 12)} vs forged ${forged.digest.slice(0, 12)} ` +
              `(per-file detail is unavailable when the baseline came from state.json)\n`) +
          `\nCut a new version instead, or re-land deliberately with ` +
          `--version ${version} --reland.\n`
      );
      process.exit(5);
    }
  }

  // What this release changed IN THE CORE, from the two forged-tree hashes. `baseline` is carried
  // with it so the entry can qualify itself instead of overstating: only a clean core repo whose
  // marker names the previous release makes `preForge` that release's tree.
  const coreDiff = {
    rows: preForge.digest ? hashDiff(preForge.files, forged.files) : [],
    // "none" keys off the MARKER, not off an empty directory: what makes a diff meaningful is a
    // previously published core to diff against, and a target carrying stray files but no marker
    // has none. Reporting those strays as a release delta would be the same overstatement in a new
    // place.
    baseline: !ver.marker || !preForge.digest
      ? "none"
      : preForgeDirty
        ? "on-disk-dirty"
        : "previous-release",
    baselineVersion: ver.marker || null,
    fileCount: Object.keys(forged.files).length,
  };

  // 3) Auto log + state. Both under the service root, both portable-path only.
  mkdirSync(join(ROOT, RUN_REL), { recursive: true });
  const logPath = join(ROOT, LOG_REL);
  if (!existsSync(logPath)) writeFileSync(logPath, LOG_HEADER);
  const entry = renderLogEntry({ version, prevVersion: ver.marker, head: head.sha, branch: head.branch, pending, uncommitted, when, forgeCmd, surfaceSource: source, cls, rows, gates, coreDiff });
  if (RELAND) upsertLogEntry(logPath, version, entry);
  else appendFileSync(logPath, entry);

  const prevState = readJson(STATE_REL) || {};
  const history = Array.isArray(prevState.history) ? prevState.history : [];
  if (ver.marker && ver.markerCommit && !history.some((h) => h.version === ver.marker)) {
    // Carry the superseded release's content_hash into history too, so a much later re-publish of
    // an old version still has a baseline to check against (rung 1 of referenceContent).
    const prev = lastRelease(prevState);
    const carried =
      prev && String(prev.version) === String(ver.marker) && prev.content_hash
        ? { content_hash: String(prev.content_hash) }
        : {};
    history.push({ version: ver.marker, source_commit: ver.markerCommit, ...carried });
  }
  writeFileSync(
    join(ROOT, STATE_REL),
    JSON.stringify(
      {
        schema: 2,
        comment:
          "Framework-core release state. Written by scripts/framework-core-publish.mjs; paths are "
          + "repo-relative. `last_local_release` is what `publish` cut — it forges, gates, commits "
          + "and tags, all local and all reversible, and never pushes — so its presence is NOT "
          + "evidence that any remote serves this version. That evidence is `remote_verified`, "
          + "written by `verify-remote`, and by `release`/`ship` once they have pushed and "
          + "re-checked. schema 2 carries no `remote_release`; schema 3 adds it, recording which "
          + "refs a release actually pushed and which merges it deliberately left to the operator.",
        runtime: RUNTIME_NAME,
        target_rel: portable(SRC_REL),
        // Renamed from `last_publish` (F-13): local state called v2.0.0 "published" while the
        // GitHub remote still served v1.1.5 and carried no v2.0.0 tag. The reader still accepts
        // the old key, so an existing state file keeps classifying correctly.
        last_local_release: {
          version,
          source_commit: head.sha,
          source_branch: head.branch || null,
          // Where the CORE's own release commit lands, which is a different repository's branch
          // namespace from `source_branch` above. Recorded because verify-remote had nothing else to
          // check and reached for `source_branch` — asking the core's remote for a branch that only
          // ever existed in THIS repo, so the check could pass only while both happened to be called
          // `main`. `core_ref` is not it either: that is the `--ref` INPUT (default 'main'), not
          // where the commit went. Read here rather than after commitLocally() because the branch is
          // already decided — that function reads the same value to make the same commit.
          core_branch: targetIsOwnRepo() ? (git(["branch", "--show-current"], SRC_ABS).out || null) : null,
          core_ref: ref,
          published_at: when.stamp,
          commits: pending.commits.length,
          files: pending.files.length,
          working_tree_dirty: head.dirty,
          uncommitted_core_files: uncommitted.length,
          bump_class: bump,
          bump_reasons: cls.reasons,
          // sha256 over the forged tree with wall-clock timestamps masked out (normalizedTreeHash).
          // This is the baseline a later re-publish of this same version is checked against — it is
          // what makes "the same version always forges the same core" an enforced invariant rather
          // than a hope. Absent on releases cut before this field existed; the reader falls back.
          content_hash: forged.digest,
          // The inventory THIS release shipped. Recording it is what lets the next run
          // classify against what was actually published rather than re-deriving it from a
          // forged tree that has since been overwritten.
          skills: cls.source.skills || [],
          lib: cls.source.lib || [],
          packs: cls.source.packs || [],
          configuration: cls.source.configuration || [],
          gates: gates.map((g) => ({ name: g.name, result: g.result, note: g.note || null })),
        },
        // Null until the release is pushed AND re-checked — by `release`/`ship`, or by a bare
        // `verify-remote` after a hand push. Absence means "not verified", never "verified false"
        // — the distinction matters, because the failure this records was reporting an unpushed
        // release as published.
        remote_verified: prevState.remote_verified && prevState.remote_verified.version === version
          ? prevState.remote_verified
          : null,
        history,
      },
      null,
      2
    ) + "\n"
  );

  // 4) Land it locally. Committing and tagging are reversible and local; PUSHING is
  //    neither, so it stays printed — publishing a core to other people is the operator's
  //    call (CLAUDE.md § irreversible / outward-facing actions).
  const steps = [
    "",
    "── forged and verified. Release log updated: ────────",
    `  ${portable(LOG_REL)}`,
    `  ${portable(STATE_REL)}`,
    "",
  ];

  let landed = null;
  if (NO_COMMIT) {
    steps.push("  --no-commit: nothing was committed. The steps below are yours to run.");
  } else {
    landed = commitLocally(version, when);
    if (landed.error) {
      steps.push(`  COMMIT FAILED: ${landed.error}`);
      steps.push("  The forge and the log stand; land them by hand with the steps below.");
    } else if (landed.blocked) {
      steps.push(...landed.lines);
    } else {
      steps.push("── committed locally (nothing pushed) ──────────────");
      steps.push(...landed.lines);
    }
  }

  const pushOnly = Boolean(landed && landed.committed);
  steps.push("");
  steps.push(
    pushOnly
      ? "Remaining step is OUTWARD-FACING and is not run for you:"
      : "Remaining steps are OUTWARD-FACING or were not run for you:"
  );
  steps.push("");
  steps.push("Finish it in one step, which pushes the TAG FIRST and then PROVES the remote serves it:");
  steps.push("");
  steps.push("```sh");
  steps.push(`node scripts/framework-core-publish.mjs release          # the plan, pushes nothing`);
  steps.push(`node scripts/framework-core-publish.mjs release --yes    # actually push`);
  steps.push("```");
  steps.push("");
  steps.push("or by hand:");
  steps.push("");
  steps.push("```sh");
  if (!pushOnly) {
    steps.push(`# 1) commit + tag inside the core submodule`);
    steps.push(`git -C ${portable(SRC_REL)} add -A`);
    steps.push(`git -C ${portable(SRC_REL)} commit -m "chore(release): framework core v${version}"`);
    steps.push(`git -C ${portable(SRC_REL)} tag -a v${version} -m "framework core v${version}"`);
  }
  // ONE `push origin HEAD --tags` line was too easy to shorten to a bare `git push`, and that is
  // exactly how v1.1.0 and v1.1.1 reached the remote with no tag. The tag is its own step, says
  // why it is not optional, and the verification that proves it landed is printed with it.
  steps.push(`git -C ${portable(SRC_REL)} push origin HEAD`);
  steps.push(
    `git -C ${portable(SRC_REL)} push origin v${version}   ` +
      `# NOT optional — the README pins installs to --ref v${version}`
  );
  if (!pushOnly) {
    steps.push("");
    steps.push(`# 2) register the service state in this repo`);
    steps.push(`node bin/sidekicks service sync`);
    steps.push(`node bin/sidekicks index rebuild`);
    steps.push("");
    steps.push(`# 3) commit the gitlink bump + the release log here`);
    steps.push(`git add ${portable(SRC_REL)} ${portable(RUN_REL)}`);
    steps.push(`git commit -m "chore(framework): bump ${RUNTIME_NAME} core gitlink to v${version}"`);
  }
  steps.push("");
  steps.push(`# ${pushOnly ? "2" : "4"}) prove the remote actually serves it`);
  steps.push(`node scripts/framework-core-publish.mjs verify-remote`);
  steps.push("```");
  steps.push("");
  // The step the hand block never had, and half of why the release stalled: the gitlink bump and
  // the release log sat on a work branch that was pushed nowhere, so this repo's own record of the
  // release was as unpublished as the tag.
  steps.push("Then, in BOTH repos — this script never pushes to a protected branch:");
  steps.push("");
  steps.push(`    core:   merge the release branch into main   (publishes README.md + install.sh)`);
  steps.push(`    source: push this work branch and merge it   (lands the gitlink bump + the log)`);
  process.stdout.write(steps.join("\n") + "\n");
  // A blocked or failed local commit is not a failed release — the core is forged, verified
  // and logged — but it is unfinished, so it must not exit 0 into an unattended sequence.
  process.exit(landed && !landed.committed ? 4 : 0);
}

// ── ship ────────────────────────────────────────────────────────────────────
// ONE command for the whole release, end to end, for an operator who does not want to remember
// the order. It is a composition of the existing verbs and NOTHING else: it re-invokes this same
// script rather than re-implementing publish or release, so `ship` can never drift away from what
// running them by hand does, and every guard they carry still fires.
//
// The order it encodes is the order the incident proved is load-bearing:
//
//   1. serve whatever is ALREADY cut. `publish` refuses (exit 5) to cut the next release while the
//      previous tag is missing from a reachable remote, so an unserved release has to be finished
//      before a new one can start. A no-op when the remote already serves it.
//   2. publish   — forge, gate, log, commit and tag, locally.
//   3. serve it  — push the tag, then the branch, then verify the remote really has it.
//
// TWO THINGS IT WILL NOT DO FOR YOU.
//
// It never commits your working tree. The forge copies the WORKING TREE, so a dirty repo ships
// files the release log's commit does not contain — a release nobody can rebuild from its own sha.
// That is a decision about what belongs in the release, so `ship` refuses and names the files
// rather than guessing.
//
// It never runs without `--yes`. Without it, `ship` prints the whole plan — the branch it would
// move onto, the version it would cut, the refs it would push — and writes nothing.

/** Re-invoke THIS script, inheriting stdio so progress and credential prompts reach the operator. */
function selfRun(args) {
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(process.execPath, [self, ...args], { cwd: ROOT, stdio: "inherit" });
  return r.status === 0 ? 0 : (r.status || 1);
}

/** The invocation's flags, minus the verb and minus anything a sub-verb must not inherit. */
function shipPassthru(drop = []) {
  const out = [];
  const verbAt = argv.indexOf(VERB);
  for (let i = 0; i < argv.length; i += 1) {
    if (i === verbAt) continue;
    if (drop.includes(argv[i])) continue;
    out.push(argv[i]);
  }
  return out;
}

async function doShip() {
  const yes = has("yes");
  const state = readJson(STATE_REL) || {};
  const last = lastRelease(state);

  // ── refuse a dirty tree, in EITHER repo ───────────────────────────────────
  const dirty = [];
  const rootStatus = git(["status", "--porcelain"]);
  // Only paths that would actually travel: an unrelated dirty gitlink elsewhere in the repo is not
  // this release's business, and refusing on it would make `ship` unusable in a real checkout.
  const bound = corePaths().paths;
  // NOT `line.slice(3)`: git() trims its output, so the FIRST line has already lost the leading
  // space of its two-column status and a fixed offset cuts into the path. Match the columns
  // instead, and take the destination half of a rename.
  const porcelainPath = (line) => {
    const m = /^\s*\S{1,2}\s+(.+)$/.exec(line);
    if (!m) return null;
    const rel = m[1].trim();
    const arrow = rel.indexOf(" -> ");
    return arrow === -1 ? rel : rel.slice(arrow + 4);
  };
  for (const line of (rootStatus.out || "").split("\n")) {
    const rel = porcelainPath(line);
    if (!rel) continue;
    if (bound.some((p) => rel === p || rel.startsWith(`${p}/`))) dirty.push(`this repo: ${rel}`);
  }
  if (targetIsOwnRepo() && !coreTreeClean()) {
    for (const line of (git(["status", "--porcelain"], SRC_ABS).out || "").split("\n")) {
      const rel = porcelainPath(line);
      if (rel) dirty.push(`core: ${rel}`);
    }
  }
  if (dirty.length) {
    process.stderr.write(
      `${dirty.length} core-bound file(s) are uncommitted, so this release would not be `
        + "reproducible from the commit its log records — the forge copies the WORKING TREE.\n\n"
        + dirty.slice(0, 20).map((d) => `    ${d}`).join("\n") + "\n"
        + (dirty.length > 20 ? `    … and ${dirty.length - 20} more\n` : "")
        + "\n  Commit them (or stash-free move them to another branch) and re-run. Deciding what "
        + "belongs\n  in a release is not something this command guesses at.\n"
    );
    process.exit(3);
  }

  // ── what would happen ─────────────────────────────────────────────────────
  const ver = publishedVersion();
  const head = headInfo();
  const { paths, skills } = corePaths();
  const pending = pendingSince(ver.markerCommit || ver.stateCommit, paths);
  const owed = pending.commits.length > 0 || pending.files.length > 0;
  const cls = await classifyBump(skills);
  const nextVersion = flag("version") || bumpVersion(releaseBase(ver).base, flag("bump") || cls.kind);

  const rootBranch = head.branch;
  const coreBranch = targetIsOwnRepo() ? git(["branch", "--show-current"], SRC_ABS).out : null;
  const branchName = flag("branch") || "chore/framework-core-release";
  const moves = [];
  if (isProtected(rootBranch)) moves.push({ what: "this repo", from: rootBranch });
  if (coreBranch && isProtected(coreBranch)) moves.push({ what: "the core", from: coreBranch });

  const servedAlready = Boolean(
    state.remote_verified && last && String(state.remote_verified.version) === String(last.version)
  );

  const plan = [];
  plan.push(`ship — ${RUNTIME_NAME}`);
  plan.push("");
  if (last) {
    plan.push(`  already cut:  v${last.version} — ${servedAlready ? "served by the remote" : "NOT served yet; it is pushed first"}`);
  }
  plan.push(owed
    ? `  to cut:       v${nextVersion} — ${(flag("bump") || cls.kind).toUpperCase()}, ${pending.commits.length} commit(s), ${pending.files.length} file(s)`
    : "  to cut:       nothing — no core-bound change since the last release");
  for (const m of moves) plan.push(`  branch move:  ${m.what}: '${m.from}' is protected → switch -C ${branchName}`);
  plan.push("");
  plan.push("  then: publish (forge, 6 gates, log, commit + tag locally)");
  plan.push("        release (push the TAG first, then the branch, then verify the remote serves it)");

  if (!owed && servedAlready) {
    process.stdout.write(`${plan.join("\n")}\n\nNothing to publish and nothing unserved — the remote is up to date.\n`);
    process.exit(0);
  }

  if (!yes) {
    plan.push("");
    plan.push("Nothing was done. This ends in an irreversible outward push, so it needs your");
    plan.push("explicit yes — never self-granted:");
    plan.push("");
    plan.push("```sh");
    plan.push(`node scripts/framework-core-publish.mjs ship --yes${flag("bump") ? ` --bump ${flag("bump")}` : ""}`);
    plan.push("```");
    process.stdout.write(`${plan.join("\n")}\n`);
    process.exit(0);
  }

  process.stdout.write(`${plan.join("\n")}\n`);

  // ── 0. onto a work branch. `switch -C` is create-or-move and carries the tree across; the tree
  //       is already known clean, which is the case that needs no separate ask.
  for (const m of moves) {
    const cwd = m.what === "the core" ? SRC_ABS : ROOT;
    process.stdout.write(`\n── branch: ${m.what} → ${branchName} ─────────────────\n`);
    const sw = git(["switch", "-C", branchName], cwd);
    if (!sw.ok) {
      process.stderr.write(`could not move ${m.what} onto ${branchName}: ${sw.err || sw.out}\n`);
      process.exit(4);
    }
  }

  // ── 1. serve what is already cut, so publish's previous-release gate can pass.
  if (last && !servedAlready) {
    process.stdout.write("\n── serving the previous release ────────────────────\n");
    const code = selfRun(["release", ...shipPassthru()]);
    if (code !== 0) process.exit(code);
  }

  // ── 2. cut it.
  if (owed) {
    process.stdout.write("\n── publish ─────────────────────────────────────────\n");
    const code = selfRun(["publish", ...shipPassthru(["--yes"])]);
    if (code !== 0) process.exit(code);

    // ── 3. serve it.
    process.stdout.write("\n── serving it ──────────────────────────────────────\n");
    const served = selfRun(["release", ...shipPassthru()]);
    if (served !== 0) process.exit(served);
  }

  process.stdout.write("\nshipped.\n");
  process.exit(0);
}

// ── verify-remote ───────────────────────────────────────────────────────────
// F-13. Nothing this script does reaches a remote, so nothing it writes can attest to one.
// This verb is the only thing that may: it asks the remote what it actually serves and records
// the answer. Read-only against the network (`git ls-remote`) — it never pushes.

/**
 * Ask the core's remote what refs it serves, once.
 *
 * Extracted so `verifyRemote`, `unloggedTags` and any future outward verb share ONE network call and
 * ONE failure policy. A connectivity-shaped problem must read the same everywhere: it is never
 * evidence that a ref is absent, only that the question could not be asked.
 *
 * @returns {{ok: true, url: string, refs: Map<string,string>} | {ok: false, url: string|null, detail: string}}
 */
function remoteRefs() {
  const url = git(["remote", "get-url", "origin"], SRC_ABS);
  if (!url.ok || !url.out) {
    return { ok: false, url: null, detail: "the core has no 'origin' remote — nothing to verify against" };
  }
  const ls = git(["ls-remote", url.out], SRC_ABS);
  if (!ls.ok) {
    return {
      ok: false,
      url: url.out,
      detail: `could not reach the remote: ${ls.err.split("\n").pop() || "ls-remote failed"}`,
    };
  }
  /** @type {Map<string,string>} */
  const refs = new Map();
  for (const line of ls.out.split("\n")) {
    const [sha, ref] = line.split(/\s+/);
    if (sha && ref) refs.set(ref, sha);
  }
  return { ok: true, url: url.out, refs };
}

/** The commit a remote serves for `<tag>`, peeling an annotated tag object. Null when absent. */
function remoteTagSha(refs, tag) {
  return refs.get(`refs/tags/${tag}^{}`) || refs.get(`refs/tags/${tag}`) || null;
}

/**
 * Local `v*` tags in the core repo with no section in the release log, CLASSIFIED against the remote.
 *
 * Listing them is not enough, and the difference is not academic. Of the four unlogged tags this
 * repo carried, three were local-only (deletable) and `v1.2.1` was SERVED by the remote — deleting
 * that one would have broken every workspace pinned to `--ref v1.2.1`. A served unlogged tag is a
 * LOG repair; a local-only one is a tag deletion. One code path has to tell them apart.
 *
 * `served` is null when the remote could not be asked: unknown, never "absent".
 *
 * @returns {Array<{tag: string, version: string, served: boolean|null}>}
 */
function unloggedTags() {
  if (!targetIsOwnRepo()) return [];
  const tags = git(["tag", "-l", "v*"], SRC_ABS);
  if (!tags.ok || !tags.out) return [];

  const logged = new Set();
  const logAbs = join(ROOT, LOG_REL);
  if (existsSync(logAbs)) {
    for (const line of readFileSync(logAbs, "utf8").split("\n")) {
      const m = /^##\s+v(\d+\.\d+\.\d+)/.exec(line);
      if (m) logged.add(m[1]);
    }
  }

  const orphans = tags.out
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((tag) => ({ tag, version: tag.replace(/^v/, "") }))
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t.version) && !logged.has(t.version));
  if (orphans.length === 0) return [];

  const remote = remoteRefs();
  return orphans.map((t) => ({
    ...t,
    served: remote.ok ? Boolean(remoteTagSha(remote.refs, t.tag)) : null,
  }));
}

/**
 * Versions `state.json.history` claims were released that the release log has no section for.
 *
 * `history` is APPEND-ONLY from whatever the core marker said at each cut (see doPublish), which
 * makes it an honest record of a hand-cut past and a poor ledger: it carried a phantom `1.2.3` that
 * no tag, no log entry and no remote ref ever backed, sitting out of order before `1.2.0`, while
 * `1.2.1` — a version the remote really does serve — was missing from it entirely
 * (INC-2026-09-04-02, N-9). Nothing reported the disagreement, so it survived two incidents.
 *
 * This is a REPORT, never a repair: `history` feeds publishedVersions() (the re-land guard) and
 * referenceContent()'s first rung, so an entry that turns out to be wrong is an operator decision.
 *
 * @param {object|null} state
 * @returns {{version: string, source_commit: string|null}[]}
 */
function historyWithoutLog(state) {
  const history = Array.isArray(state && state.history) ? state.history : [];
  if (history.length === 0) return [];
  const logAbs = join(ROOT, LOG_REL);
  if (!existsSync(logAbs)) return [];
  const logged = new Set();
  for (const line of readFileSync(logAbs, "utf8").split("\n")) {
    const m = /^##\s+v(\d+\.\d+\.\d+)/.exec(line);
    if (m) logged.add(m[1]);
  }
  return history
    .filter((h) => h && h.version && !logged.has(String(h.version)))
    .map((h) => ({ version: String(h.version), source_commit: h.source_commit ? String(h.source_commit) : null }));
}

/**
 * Compare the local release against what the core's remote actually serves.
 *
 * @returns {{ok: boolean, version: string|null, checks: Array<{ref: string, expected: string|null, remote: string|null, ok: boolean, detail: string}>}}
 */
function verifyRemote() {
  const state = readJson(STATE_REL);
  const last = lastRelease(state);
  const checks = [];
  if (!last) {
    return { ok: false, version: null, checks: [{ ref: "(state)", expected: null, remote: null, ok: false,
      detail: `no local release recorded in ${portable(STATE_REL)} — run publish first` }] };
  }
  const version = String(last.version);
  const tag = `v${version}`;
  // The core's OWN release branch, never this repo's. `source_branch` names the workspace branch the
  // release was cut from and means nothing to the core's remote: checking it against the core told
  // v1.0.0 "the remote has no chore/sk-repos-reforge" while the remote served the release perfectly.
  // Absent on any release cut before core_branch was recorded, and an absent value is reported as
  // unknown rather than checked — a check that cannot run must not be scored either way.
  const branch = last.core_branch || null;

  // The commit the release actually landed on, read from the CORE repo's own tag/branch.
  const localTag = git(["rev-parse", `${tag}^{commit}`], SRC_ABS);
  const expectedSha = localTag.ok ? localTag.out : null;

  const remote = remoteRefs();
  if (!remote.ok) {
    checks.push({ ref: remote.url || "origin", expected: expectedSha, remote: null, ok: false,
      detail: remote.detail });
    return { ok: false, version, checks };
  }
  const refs = remote.refs;

  // A tag may be annotated: refs/tags/<t> is the tag object and refs/tags/<t>^{} the commit.
  const remoteTag = remoteTagSha(refs, tag);
  checks.push({
    ref: `refs/tags/${tag}`,
    expected: expectedSha,
    remote: remoteTag,
    ok: Boolean(remoteTag) && (!expectedSha || remoteTag === expectedSha),
    detail: !remoteTag
      ? `the remote has no ${tag} — this release was never pushed`
      : expectedSha && remoteTag !== expectedSha
        ? `the remote's ${tag} points at ${remoteTag.slice(0, 12)}, the local one at ${expectedSha.slice(0, 12)}`
        : `the remote serves ${tag} at ${remoteTag.slice(0, 12)}`,
  });

  if (branch) {
    const localBranch = git(["rev-parse", `${branch}^{commit}`], SRC_ABS);
    const remoteBranch = refs.get(`refs/heads/${branch}`) || null;
    checks.push({
      ref: `refs/heads/${branch}`,
      expected: localBranch.ok ? localBranch.out : null,
      remote: remoteBranch,
      ok: Boolean(remoteBranch) && (!localBranch.ok || remoteBranch === localBranch.out),
      detail: !remoteBranch
        ? `the remote has no ${branch}`
        : localBranch.ok && remoteBranch !== localBranch.out
          ? `the remote's ${branch} is at ${remoteBranch.slice(0, 12)}, the local one at ${localBranch.out.slice(0, 12)}`
          : `the remote's ${branch} matches the local one`,
    });
  } else {
    // Not scored. The tag is the release identity and it WAS checked above; the branch this release
    // landed on simply is not recorded, and inventing a branch name to check would be the original
    // bug in a different costume.
    checks.push({
      ref: "refs/heads/(unrecorded)",
      expected: null,
      remote: null,
      ok: true,
      detail: "this release recorded no core branch — the tag above is what identifies it",
    });
  }

  return { ok: checks.every((c) => c.ok), version, checks };
}

// ── release ─────────────────────────────────────────────────────────────────
// The outward half, and the reason this incident happened: `publish` forges, gates, commits and
// tags — all local — and the two steps that make a release EXIST for consumers (push the tag, merge
// the branch) were printed prose with no automation and no gate at the moment they were skipped.
// v1.4.1 was tagged locally, `push origin HEAD` was run, `push origin v1.4.1` was not, and the
// generated README told every consumer to install `--ref v1.4.1`.
//
// THE ORDER IS THE FIX. The tag is pushed BEFORE the branch, and the README only becomes visible on
// the core's default branch through a MERGE that is strictly later than both. So "the README
// advertises a tag the remote does not serve" stops being a thing that can happen, rather than a
// thing a check catches afterwards.
//
// Three outward refs, and this verb owns only two of them:
//
//   refs/tags/v<version>        pushed here — what `--ref` resolves to
//   refs/heads/<core_branch>    pushed here — carries the release commit
//   refs/heads/main (core)      OPERATOR ONLY, via a merge — publishes README.md + install.sh
//
// Never `--tags` / `--follow-tags`: this repo carried four unpushed tags, three of which should
// never reach the remote. A release pushes ONE tag, by name.

/** Would this push create a ref, fast-forward it, or clobber history? Read-only. */
function pushKind(refs, fullRef, localSha) {
  const remoteSha = refs.get(fullRef) || refs.get(`${fullRef}^{}`) || null;
  if (!remoteSha) return { kind: "create", remoteSha: null };
  if (remoteSha === localSha) return { kind: "already", remoteSha };
  const ancestor = git(["merge-base", "--is-ancestor", remoteSha, localSha], SRC_ABS);
  return { kind: ancestor.ok ? "fast-forward" : "non-fast-forward", remoteSha };
}

function doRelease() {
  const state = readJson(STATE_REL) || {};
  const last = lastRelease(state);
  if (!last) {
    process.stderr.write(
      `no local release recorded in ${portable(STATE_REL)} — there is nothing to publish.\n` +
        "  cut one first:  node scripts/framework-core-publish.mjs publish\n"
    );
    process.exit(3);
  }
  if (!targetIsOwnRepo()) {
    process.stderr.write(
      "the core target is not its own git repository, so it has no remote to publish to.\n"
    );
    process.exit(3);
  }

  const version = String(last.version);
  const tag = `v${version}`;
  const coreBranch = last.core_branch || git(["branch", "--show-current"], SRC_ABS).out;

  // ── 1. Preflight, entirely read-only ───────────────────────────────────────
  const localTag = git(["rev-parse", `${tag}^{commit}`], SRC_ABS);
  if (!localTag.ok || !localTag.out) {
    process.stderr.write(
      `${tag} does not exist in the core repo, so this release was never landed locally.\n` +
        `  run:  node scripts/framework-core-publish.mjs publish --version ${version}\n`
    );
    process.exit(3);
  }
  const tagSha = localTag.out;

  if (!coreBranch) {
    process.stderr.write(
      "the core repo is on a detached HEAD, so there is no branch to push. Check the release " +
        "branch out first — pushing HEAD would leave the release commit on no branch at all.\n"
    );
    process.exit(3);
  }
  if (isProtected(coreBranch)) {
    process.stderr.write(
      `the core is on '${coreBranch}', which is protected. A protected branch receives work only ` +
        "through a merge or PR you approve — never a push from a script.\n" +
        "  cut the release onto a work branch and merge it there instead.\n"
    );
    process.exit(8);
  }
  const branchSha = git(["rev-parse", coreBranch], SRC_ABS);
  if (!branchSha.ok || !branchSha.out) {
    process.stderr.write(`could not resolve '${coreBranch}' in the core repo.\n`);
    process.exit(3);
  }

  const rootBranch = git(["branch", "--show-current"]).out;
  const sourceProtected = isProtected(rootBranch);

  const remote = remoteRefs();
  if (!remote.ok) {
    // Unlike `publish`, an unreachable remote IS fatal here: this verb's entire job is to change
    // what the remote serves, and it cannot report success without having seen it.
    process.stderr.write(`${remote.detail}\n`);
    process.exit(6);
  }

  const tagPlan = pushKind(remote.refs, `refs/tags/${tag}`, tagSha);
  const branchPlan = pushKind(remote.refs, `refs/heads/${coreBranch}`, branchSha.out);

  if (tagPlan.kind === "non-fast-forward" || branchPlan.kind === "non-fast-forward") {
    const which = tagPlan.kind === "non-fast-forward" ? tag : coreBranch;
    process.stderr.write(
      `the remote's ${which} is not an ancestor of the local one, so pushing it would DISCARD ` +
        "commits the remote already serves. Refusing before touching anything.\n" +
        "  fetch and reconcile in the core repo first; this script never force-pushes.\n"
    );
    process.exit(6);
  }

  // Never counts the version it is CURRENTLY serving: a release cut by hand has no log entry, and
  // refusing to publish it because it has no log entry would leave it permanently unservable. The
  // guard is about OTHER releases whose published history and log disagree.
  const orphans = unloggedTags().filter((t) => t.served === true && t.version !== version);
  if (orphans.length && !has("allow-unlogged-tags")) {
    process.stderr.write(
      `the remote already serves ${orphans.length} tag(s) with no release-log entry: ` +
        `${orphans.map((t) => t.tag).join(", ")}.\n` +
        "  Published history and the log disagree, and pushing another release widens the gap.\n" +
        "  Backfill their log entries (they are SERVED — deleting them breaks anyone pinned to " +
        "them), or pass --allow-unlogged-tags.\n"
    );
    process.exit(8);
  }

  // ── 2. The plan. Nothing outward happens without --yes ─────────────────────
  const describe = (p) => (p.kind === "already"
    ? "already serves this commit"
    : p.kind === "create" ? "create" : `fast-forward from ${(p.remoteSha || "").slice(0, 12)}`);
  const lines = [];
  lines.push(`release v${version} — ${remote.url}`);
  lines.push("");
  lines.push(`  refs/tags/${tag}`.padEnd(52) + describe(tagPlan));
  lines.push(`  refs/heads/${coreBranch}`.padEnd(52) + describe(branchPlan));
  const rootHasRemote = (() => { const r = git(["remote", "get-url", "origin"]); return r.ok && Boolean(r.out); })();
  if (rootBranch && !sourceProtected && rootHasRemote) {
    lines.push(`  ${portable(".")} @ ${rootBranch}`.padEnd(52) + "push (source repo)");
  }
  lines.push("");
  lines.push("  The TAG is pushed FIRST, on purpose: the README on the core's default branch names");
  lines.push(`  --ref ${tag}, and it only gets there through a merge that is later than both pushes.`);

  if (!has("yes")) {
    lines.push("");
    lines.push("Nothing was pushed. These are outward-facing and irreversible, so they need your");
    lines.push("explicit yes — the same shape as --allow-protected and --reland, never self-granted:");
    lines.push("");
    lines.push("```sh");
    lines.push("node scripts/framework-core-publish.mjs release --yes");
    lines.push("```");
    process.stdout.write(lines.join("\n") + "\n");
    process.exit(0);
  }

  process.stdout.write(lines.join("\n") + "\n\n── pushing ─────────────────────────────────────────\n");

  // ── 3-4. The pushes. stdio inherited so a credential helper can prompt ─────
  const pushed = [];
  const push = (label, args, result) => {
    process.stdout.write(`  ${label}\n`);
    const r = spawnSync("git", ["-C", SRC_ABS, "push", "origin", ...args], {
      encoding: "utf8", stdio: "inherit",
    });
    if (r.status !== 0) {
      process.stderr.write(`\npush of ${label} was refused by the remote (exit ${r.status}).\n`);
      process.exit(6);
    }
    pushed.push(result);
  };

  if (tagPlan.kind !== "already") {
    push(`refs/tags/${tag}`, [`refs/tags/${tag}`], { ref: `refs/tags/${tag}`, sha: tagSha, result: tagPlan.kind });
  } else {
    pushed.push({ ref: `refs/tags/${tag}`, sha: tagSha, result: "already" });
  }
  if (branchPlan.kind !== "already") {
    // By NAME, never HEAD: a detached HEAD or a different checked-out branch must not decide what
    // ships. `push origin HEAD` is exactly the line that shortened to a bare `git push` twice before.
    push(`refs/heads/${coreBranch}`, [coreBranch], { ref: `refs/heads/${coreBranch}`, sha: branchSha.out, result: branchPlan.kind });
  } else {
    pushed.push({ ref: `refs/heads/${coreBranch}`, sha: branchSha.out, result: "already" });
  }

  // ── 5. Prove it. A push that reported success is a claim, not evidence ─────
  process.stdout.write("\n── verifying ───────────────────────────────────────\n");
  const res = verifyRemote();
  for (const c of res.checks) process.stdout.write(`  ${c.ok ? "ok  " : "FAIL"}  ${c.ref}  ${c.detail}\n`);

  const stamp = nowBangkok().stamp;
  const fresh = readJson(STATE_REL) || {};
  fresh.schema = 3;
  fresh.remote_verified = res.ok
    ? { version: res.version, verified_at: stamp, refs: res.checks.map((c) => ({ ref: c.ref, sha: c.remote })) }
    : null;
  fresh.remote_check = { version: res.version, checked_at: stamp, ok: res.ok,
    checks: res.checks.map((c) => ({ ref: c.ref, ok: c.ok, detail: c.detail })) };

  if (!res.ok) {
    writeFileSync(join(ROOT, STATE_REL), `${JSON.stringify(fresh, null, 2)}\n`);
    process.stderr.write(
      "\nthe pushes reported success but the remote still does not serve this release.\n" +
        "  Nothing is rolled back — a landed tag is not a problem, and undoing it would be.\n" +
        "  Investigate the remote, then re-run:  node scripts/framework-core-publish.mjs verify-remote\n"
    );
    process.exit(7);
  }

  // ── 6. The source side. Its work branch, never a protected one ─────────────
  let sourcePushed = null;
  // A source checkout with no `origin` is a legitimate shape (a local-only clone), and by this
  // point the CORE is already served — the release succeeded. Treating "this workspace has no
  // remote" as a failed release would misreport the thing that actually happened.
  const sourceRemote = git(["remote", "get-url", "origin"]);
  const sourceHasRemote = sourceRemote.ok && Boolean(sourceRemote.out);
  if (rootBranch && !sourceProtected && !sourceHasRemote) {
    process.stdout.write(`\n  ${portable(".")} has no 'origin' — nothing to push the source branch to.\n`);
  }
  if (rootBranch && !sourceProtected && sourceHasRemote) {
    process.stdout.write(`\n  ${portable(".")} @ ${rootBranch}\n`);
    const r = spawnSync("git", ["push", "origin", rootBranch], { cwd: ROOT, encoding: "utf8", stdio: "inherit" });
    if (r.status !== 0) {
      process.stderr.write(`\npush of the source branch '${rootBranch}' was refused (exit ${r.status}).\n`);
      process.exit(6);
    }
    sourcePushed = rootBranch;
  }

  const merges = [
    { repo: "core", from: coreBranch, into: "main",
      why: "publishes README.md + install.sh at the raw URL the README's one-liner fetches" },
  ];
  if (sourcePushed) {
    merges.push({ repo: "source", from: sourcePushed, into: "main",
      why: "lands the gitlink bump and the release log" });
  }

  fresh.remote_release = {
    version, pushed_at: stamp, pushed_by: "release",
    refs: pushed, source_branch_pushed: sourcePushed, merges_outstanding: merges,
  };
  writeFileSync(join(ROOT, STATE_REL), `${JSON.stringify(fresh, null, 2)}\n`);
  appendPublishedBlock(version, { stamp, refs: pushed, sourcePushed, merges });

  const out = [""];
  out.push(`v${version} is SERVED by ${remote.url}.`);
  out.push("");
  if (sourceProtected) {
    out.push(`  NOTE: this repo is on '${rootBranch}', which is protected — the source branch was`);
    out.push("  NOT pushed. Move the release commit onto a work branch and push that.");
    out.push("");
  }
  out.push("  Still outstanding, and yours alone — this script never pushes to a protected branch:");
  for (const m of merges) out.push(`    ${m.repo}: merge ${m.from} -> ${m.into}   (${m.why})`);
  process.stdout.write(out.join("\n") + "\n");
  process.exit(0);
}

/**
 * Record the outward half in the release log, under the version's existing section.
 *
 * The log said a release was CUT and nothing said it had SHIPPED, so the document that is supposed
 * to be the record of a release was silent about the only property a consumer can observe.
 */
function appendPublishedBlock(version, { stamp, refs, sourcePushed, merges }) {
  const logAbs = join(ROOT, LOG_REL);
  if (!existsSync(logAbs)) return;
  const text = readFileSync(logAbs, "utf8");
  const head = new RegExp(`^## v${version.replace(/\./g, "\\.")}\\b.*$`, "m").exec(text);
  if (!head) return;

  const after = text.indexOf("\n## ", head.index + 1);
  const end = after === -1 ? text.length : after;
  if (/\*\*Published\*\*/.test(text.slice(head.index, end))) return;   // idempotent re-run

  const block = ["", "**Published** — pushed and verified at " + stamp + ":", ""];
  for (const r of refs) block.push(`- \`${r.ref}\` at \`${(r.sha || "").slice(0, 12)}\` (${r.result})`);
  if (sourcePushed) block.push(`- source branch \`${sourcePushed}\` pushed`);
  block.push("");
  block.push("Outstanding merges (never performed by this script):");
  block.push("");
  for (const m of merges) block.push(`- ${m.repo}: \`${m.from}\` -> \`${m.into}\` — ${m.why}`);
  block.push("");

  writeFileSync(logAbs, text.slice(0, end) + block.join("\n") + text.slice(end));
}

function doVerifyRemote() {
  const res = verifyRemote();
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  else {
    process.stdout.write(`verify-remote: local release v${res.version || "?"}\n`);
    for (const c of res.checks) {
      process.stdout.write(`  ${c.ok ? "ok  " : "FAIL"}  ${c.ref}  ${c.detail}\n`);
    }
    process.stdout.write(res.ok
      ? "\nthe remote serves this release.\n"
      : "\nthe remote does NOT serve this release — it is a LOCAL release only.\n");
  }

  // Record the answer either way. "Checked and it is not there" is the fact worth keeping.
  const state = readJson(STATE_REL);
  if (state) {
    state.remote_verified = res.ok
      ? { version: res.version, verified_at: nowBangkok().stamp, refs: res.checks.map((c) => ({ ref: c.ref, sha: c.remote })) }
      : null;
    state.remote_check = { version: res.version, checked_at: nowBangkok().stamp, ok: res.ok,
      checks: res.checks.map((c) => ({ ref: c.ref, ok: c.ok, detail: c.detail })) };
    writeFileSync(join(ROOT, STATE_REL), `${JSON.stringify(state, null, 2)}\n`);
  }
  process.exit(res.ok ? 0 : 1);
}

// ── log ─────────────────────────────────────────────────────────────────────
function doLog() {
  const p = join(ROOT, LOG_REL);
  if (!existsSync(p)) {
    process.stdout.write(`no release log yet at ${portable(LOG_REL)} — run publish once.\n`);
    process.exit(0);
  }
  process.stdout.write(readFileSync(p, "utf8"));
  process.exit(0);
}

// ── Dispatch ────────────────────────────────────────────────────────────────
// The target must exist for every verb: with no forged core there is no marker to read a
// version from, no inventory to classify against and nothing to verify. The message names
// the submodule fix for the default target, which is how it is almost always missing.
if (!existsSync(join(ROOT, SRC_REL)) || !statSync(join(ROOT, SRC_REL)).isDirectory()) {
  process.stderr.write(
    `the framework core service is not present at ${portable(SRC_REL)} — ` +
      `run \`git submodule update --init ${portable(SRC_REL)}\` first ` +
      `(or point --target at an existing core).\n`
  );
  process.exit(3);
}

switch (VERB) {
  case "status":
    await doStatus();
    break;
  case "publish":
    await doPublish();
    break;
  case "verify":
    doVerify();
    break;
  case "release":
    doRelease();
    break;
  case "ship":
    await doShip();
    break;
  case "verify-remote":
    doVerifyRemote();
    break;
  case "log":
    doLog();
    break;
  default:
    process.stderr.write(
      `unknown verb '${VERB}'. Use: status | publish | release | ship | verify | verify-remote | log  ` +
        `(flags: --target DIR, --name NAME, --preset NAME, --remote URL, ` +
        `--bump patch|minor|major, --version X.Y.Z, --ref REF, --no-tests, --no-mount-check, ` +
        `--no-commit, --allow-protected, --allow-unpushed, --yes, --allow-unlogged-tags, ` +
        `--dry-run, --json)\n`
    );
    process.exit(2);
}
