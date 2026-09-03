#!/usr/bin/env node
// .agents/skills/sk-hello/scripts/readiness.mjs
//
// Environment-readiness check for resuming work in a Sidekicks clone after the
// development environment changes — a new machine, a switched OS, or a fresh
// checkout. These are the things git does NOT carry across a clone or a
// macOS<->Windows hop, so they silently break until fixed: the git hooks path,
// the CLAUDE.md/GEMINI.md mirrors of AGENTS.md, the host-level skill links, the
// registered-project git submodules, the host plugins, the RTK token-killer
// CLI proxy (its binary and its per-agent activation hook), and `jq` (which host
// hooks shell out to — a missing jq breaks the ralph-loop plugin's Stop hook).
//
// Two further rows are conditional and REPORT-ONLY, added only where they apply:
// BMAD Method (the bmad/ module tree + command stubs the bmad-family skills
// delegate to — installed by an interactive upstream installer, so never
// auto-run), and Framework core release debt (whether the published core owes a
// release — surfaced here so the release log stays automatic, but forging is an
// outward-facing act and stays the operator's call).
//
// Two modes, both idempotent and best-effort (always exit 0 — a not-ready item
// is information for the human, not a failure of this check):
//
//   (default)  REPORT — detect and print state; for anything not ready, print
//              the exact command to run by hand. Mutates nothing. This is the
//              fast path for a plain "where am I?" orientation.
//
//   --apply    PREPARE — actually perform every idempotent fix (install git
//              hooks, recreate the OS-correct symlinks, self-heal skill links,
//              `git submodule update --init` ONLY the uninitialized submodules,
//              seed any missing per-scope config.yaml, and install missing host
//              plugins + their marketplaces), then re-detect and report what
//              remains. This is the first-run / resume / "get me ready" path: it
//              leaves the clone ready to work without a second prompt.
//
// Safety: --apply only INITIALIZES submodules that are not yet checked out. An
// already-populated submodule — even one with local modifications — is never
// touched, so apply can never clobber in-progress work. Host plugins ARE
// auto-installed in --apply mode via the non-interactive `claude plugin` CLI
// (marketplace add + install, both idempotent and additive); when that CLI is
// absent (e.g. running under another agent CLI where plugins do not exist) the
// plugins row is reported N/A rather than a standing failure. A plugin that needs
// a one-time interactive setup after install (PLUGIN_SETUP, e.g. claude-hud's HUD
// statusline) is never run by this script — once it is installed-but-unconfigured a
// "Plugin setup needed" line is surfaced so sk-hello asks the user to run it.
//
// Pure Node, no shell-isms — runs identically on macOS, Linux, and Windows.

import {
  existsSync,
  statSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

// A workspace can CONSUME the framework as a git submodule mounted at <root>/.sidekicks-core/.
// That checkout is itself a forged runtime, so it carries its own .sidekicks/ — which makes a naive
// "nearest ancestor with .sidekicks/" walk stop inside the core and report the CORE's state as the
// workspace's. Mirrors the CLI's own core-mount contract; the marker file is the whole test.
const CORE_DIR = ".sidekicks-core";
const CORE_MARKER = ".sidekicks-core.json";

// Case-insensitively on Windows, exactly like the filesystem compares path components.
function isMountedCore(dir) {
  const base = basename(dir);
  const same =
    process.platform === "win32" ? base.toLowerCase() === CORE_DIR : base === CORE_DIR;
  return same && existsSync(join(dir, CORE_MARKER));
}

// Resolve the repo root by walking up from cwd until a .sidekicks/ dir appears, skipping any
// MOUNTED core on the way up. A STANDALONE core clone is still its own root — it is kept as a
// last-resort answer rather than dropped, so running this inside one reports that clone.
function resolveRepoRoot() {
  let cur = process.cwd();
  let coreFallback = null;
  while (true) {
    if (existsSync(join(cur, ".sidekicks"))) {
      if (isMountedCore(cur)) {
        if (!coreFallback) coreFallback = cur;
      } else {
        return cur;
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return coreFallback || process.cwd(); // fallback: best-effort
    cur = parent;
  }
}

const ROOT = resolveRepoRoot();
// Path of the core this workspace mounts, or null when the framework is the repo itself.
const MOUNTED_CORE = isMountedCore(join(ROOT, CORE_DIR)) ? join(ROOT, CORE_DIR) : null;
const isWindows = process.platform === "win32";
const APPLY = process.argv.includes("--apply");

// Plugins that need a one-time, interactive post-install setup the agent should
// prompt for — installing the package alone does not make them work. Keyed by the
// plugin's base name (the part before "@"). `isConfigured()` is an evidence-based,
// no-network probe of whether that setup has already run; when it returns false
// AND the plugin is installed, the report surfaces a "Plugin setup needed" line so
// sk-hello asks the user to run `command`. Omit `isConfigured` to always
// prompt while the plugin is installed (when no reliable done-signal exists).
const PLUGIN_SETUP = {
  // claude-hud's HUD is wired by writing statusLine.command into the host
  // settings.json; until that key names claude-hud the plugin is installed but the
  // HUD never appears. `/claude-hud:setup` performs it (and needs a restart).
  "claude-hud": {
    command: "/claude-hud:setup",
    note: "configure the HUD statusline (one-time; install does not configure it, and it needs a Claude Code restart)",
    isConfigured: () => {
      try {
        const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
        const s = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
        return !!(
          s.statusLine &&
          typeof s.statusLine.command === "string" &&
          s.statusLine.command.includes("claude-hud")
        );
      } catch {
        return false;
      }
    },
  },
};

// Collected by buildChecks() each pass: declared+installed plugins from PLUGIN_SETUP
// whose setup has not yet run. Rendered as the "Plugin setup needed" section.
let pluginSetupNotes = [];

/**
 * Where this repo's framework core service lives, repo-relative POSIX.
 *
 * Asked of the CLI rather than written down, because the answer is configuration
 * (`framework_core.target`) and a literal goes stale silently: the core repo was renamed
 * sidekicks-framework -> sidekicks-harness, and the hard-coded path did not fail — it simply stopped
 * existing, which the release-debt row below reads as "this is a mounted core, publish nothing".
 *
 * Falls back to the same default the publish script carries, so a checkout whose CLI cannot answer
 * still behaves as before rather than skipping the check.
 */
function coreTargetRel() {
  const fallback = "projects/global/services/sidekicks-harness/src";
  const r = spawnSync(
    process.execPath, [join(ROOT, "bin", "sidekicks"), "config", "get", "framework_core", "--json"],
    { cwd: ROOT, encoding: "utf8" }
  );
  if (r.error || r.status !== 0) return fallback;
  try {
    const target = JSON.parse(String(r.stdout || "")).config?.target;
    return typeof target === "string" && target ? target.split("\\").join("/") : fallback;
  } catch {
    return fallback;
  }
}

// Parse `git submodule status`: first char is the state flag, then `<sha> <path>`.
// Flags: ' ' = in sync, '-' = NOT initialized (empty dir), '+' = checked out at a
// different commit, 'U' = merge conflicts. Only '-' is something apply fixes —
// the rest are already populated and must not be disturbed.
function submoduleStatus() {
  const res = spawnSync("git", ["submodule", "status"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) return [];
  return (res.stdout || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const flag = line[0];
      const rest = line.slice(1).trim().split(/\s+/);
      return { flag, sha: rest[0], path: rest[1] };
    })
    .filter((s) => s.path);
}

// Query the host Claude Code plugin state via the `claude` CLI. Returns
// { available:false } when the CLI is absent (e.g. running under Codex/Gemini,
// where plugins are not a concept) so the plugins check can treat it as N/A
// rather than a permanent failure. Both list verbs read local config only (no
// network), so this is fast and safe to call in report mode.
function claudePluginState() {
  const run = (args) => spawnSync("claude", args, { cwd: ROOT, encoding: "utf8" });
  const m = run(["plugin", "marketplace", "list", "--json"]);
  if (m.error || m.status !== 0) return { available: false };
  const p = run(["plugin", "list", "--json"]);
  if (p.error || p.status !== 0) return { available: false };
  const parse = (s) => {
    try {
      return JSON.parse(s || "[]");
    } catch {
      return [];
    }
  };
  return {
    available: true,
    markets: new Set(parse(m.stdout).map((x) => x.name).filter(Boolean)),
    plugins: new Set(parse(p.stdout).map((x) => x.id).filter(Boolean)),
  };
}

// THE SCOPE-CONFIG ENUMERATOR THAT USED TO LIVE HERE IS GONE, DELIBERATELY.
//
// It listed one git-ignored `config.yaml` per scope so the check below could seed the missing ones.
// Configuration is a FOLDER now — one COMMITTED file per family (`config/jira.yaml`,
// `config/comms.yaml`, …) plus a git-ignored `<family>.secret.yaml` sibling for the credentials —
// so what a clone lacks is no longer the whole configuration, only the secrets. The question worth
// asking became "does the committed half document every block an installed skill declares", and
// that is `sidekicks config sync --check`. Re-deriving the scope list here to ask it a second way
// is exactly the parallel implementation that made this skill's capability audit go stale.

// The scaffold itself (fully-INERT: every generated block commented out, so the file parses as
// empty for that block and the skill keeps its own defaults — no placeholder like
// "YOUR_GEMINI_API_KEY" can ever be actuated as a real key) is composed by `sidekicks config sync`
// from every installed skill's own config.defaults.yaml. See the config check below and
// docs/guide/settings-vs-configuration.md.

// ── RTK (token-killer CLI proxy) ────────────────────────────────────────────
// RTK rewrites Bash dev commands (git/ls/grep/tree/…) into a token-optimized
// `rtk <cmd>` form via a per-agent PreToolUse-style hook, cutting 60–90% of
// dev-command output tokens. Neither the binary (Homebrew/cargo, machine-local)
// nor its activation hook is carried by git, so a fresh clone / new machine has
// neither and rtk is silently inactive. rtk wires its hook GLOBALLY by design
// (`rtk init --global` patches ~/.claude/settings.json). The one agent that also
// supports a clean PROJECT-LOCAL hook is Claude Code: a PreToolUse entry Claude
// honors from the repo's git-ignored .claude/settings.local.json (which never
// commits a machine-specific hook into the shared, committed .claude/settings.json,
// so other clones lacking rtk are never broken by it). Gemini's rtk hook is a
// global hook-SCRIPT only (~/.gemini/hooks/rtk-hook-gemini.sh, via
// `rtk init --gemini --global`) — rtk offers no project-local Gemini path. Codex
// has NO rtk hook processor at all (rtk supports claude/cursor/gemini/copilot),
// so it is always reported N/A — there is nothing to wire or fix for it.
const RTK_CLAUDE_HOOK_CMD = "rtk hook claude";

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// True when a Claude settings object wires a PreToolUse hook (Bash matcher, or an
// empty/absent matcher that applies to all tools) whose command shells out to rtk.
function settingsHasRtkBashHook(settings) {
  const pre = settings && settings.hooks && settings.hooks.PreToolUse;
  if (!Array.isArray(pre)) return false;
  return pre.some(
    (e) =>
      e &&
      (e.matcher === "Bash" || e.matcher === "" || e.matcher == null) &&
      Array.isArray(e.hooks) &&
      e.hooks.some((h) => h && typeof h.command === "string" && h.command.includes("rtk hook"))
  );
}

function claudeGlobalSettingsPath() {
  const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(home, "settings.json");
}

// rtk is active for Claude when ANY settings source Claude merges wires the hook:
// the global ~/.claude/settings.json, the committed repo .claude/settings.json, or
// the git-ignored project .claude/settings.local.json. We check all three so apply
// never ADDS a project-local hook when one is already present elsewhere — two
// matching PreToolUse Bash hooks would run rtk twice on every command.
function claudeRtkState() {
  return {
    global: !!settingsHasRtkBashHook(readJsonSafe(claudeGlobalSettingsPath())),
    committed: !!settingsHasRtkBashHook(readJsonSafe(join(ROOT, ".claude", "settings.json"))),
    local: !!settingsHasRtkBashHook(readJsonSafe(join(ROOT, ".claude", "settings.local.json"))),
  };
}

function rtkBinaryPresent() {
  const r = spawnSync("rtk", ["--version"], { cwd: ROOT, encoding: "utf8" });
  return !r.error && r.status === 0;
}

function brewPresent() {
  const r = spawnSync("brew", ["--version"], { cwd: ROOT, encoding: "utf8" });
  return !r.error && r.status === 0;
}

function geminiRtkHookPath() {
  return join(homedir(), ".gemini", "hooks", "rtk-hook-gemini.sh");
}

// --- jq -----------------------------------------------------------------
// jq is not a Sidekicks dependency, but HOST hooks shell out to it — the
// ralph-loop plugin's Stop hook parses its stdin payload with `jq -r`, and a
// missing jq makes it die with "jq: command not found" on every Stop, before
// its own session-isolation guard can exit clean. It is machine-local (never
// carried by git) and macOS ships without it, so a fresh clone on a host with
// no package manager hits this. apply installs it: brew when present, else the
// official single-file release binary into ~/.local/bin (the same user-local
// bin the rest of this stack already uses).
const JQ_VERSION = "1.7.1";

function jqPresent() {
  const r = spawnSync("jq", ["--version"], { cwd: ROOT, encoding: "utf8" });
  return !r.error && r.status === 0;
}

function jqInstallDir() {
  return join(homedir(), ".local", "bin");
}

// scoop is a .ps1/.cmd shim, so it needs shell:true to resolve on Windows.
function scoopPresent() {
  const r = spawnSync("scoop", ["--version"], { cwd: ROOT, encoding: "utf8", shell: true });
  return !r.error && r.status === 0;
}

function jqTargetPath() {
  return join(jqInstallDir(), process.platform === "win32" ? "jq.exe" : "jq");
}

// Release-asset name for this host. jq publishes one static binary per
// platform+arch; anything unrecognised returns null so apply reports the manual
// path instead of downloading a wrong-arch binary.
function jqAssetName() {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (!arch) return null;
  if (process.platform === "darwin") return `jq-macos-${arch}`;
  if (process.platform === "linux") return `jq-linux-${arch}`;
  if (process.platform === "win32") return `jq-windows-${arch}.exe`;
  return null;
}

// Is the user-local bin dir actually on PATH? Installing there is useless if it
// is not, and the hook would still fail — so this is reported, not assumed.
function jqDirOnPath() {
  const sep = process.platform === "win32" ? ";" : ":";
  const dir = jqInstallDir();
  return (process.env.PATH || "")
    .split(sep)
    .some((p) => p && join(p, ".") === join(dir, "."));
}

// Download the release binary with curl (present on macOS, Linux, and Windows
// 10+ as curl.exe) — no npm dependency, no shell pipeline. Best-effort: any
// failure returns { ok:false } and the caller degrades to the manual path.
function installJqBinary() {
  const asset = jqAssetName();
  if (!asset) {
    return { ok: false, msg: `no jq release asset for ${process.platform}/${process.arch}` };
  }
  const url = `https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/${asset}`;
  const target = jqTargetPath();
  try {
    mkdirSync(jqInstallDir(), { recursive: true });
  } catch (e) {
    return { ok: false, msg: `cannot create ${jqInstallDir()}: ${e.message}` };
  }
  const r = spawnSync("curl", ["-fsSL", "--retry", "2", "-o", target, url], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (r.error || r.status !== 0) {
    const tail = (r.stderr || r.stdout || "").trim().split("\n").pop();
    return { ok: false, msg: `download failed: ${tail || (r.error && r.error.message) || url}` };
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(target, 0o755);
    } catch (e) {
      return { ok: false, msg: `chmod failed: ${e.message}` };
    }
  }
  // Verify the thing we just wrote actually runs — a truncated or HTML error
  // page would otherwise sit on PATH looking installed.
  const v = spawnSync(target, ["--version"], { cwd: ROOT, encoding: "utf8" });
  if (v.error || v.status !== 0) {
    return { ok: false, msg: `downloaded jq does not run (${target})` };
  }
  return { ok: true, msg: `installed jq ${JQ_VERSION} → ${target}` };
}

// Wire the project-local Claude hook into the git-ignored .claude/settings.local.json.
// Idempotent and non-destructive: an existing-but-unparseable file is left untouched
// (so we never clobber the user's permissions/config), and an already-wired hook is a
// no-op. The committed .claude/settings.json is deliberately NOT the target — a hook
// there would force rtk on every clone and error where rtk is absent.
function wireClaudeProjectLocalHook() {
  const file = join(ROOT, ".claude", "settings.local.json");
  let settings;
  if (existsSync(file)) {
    settings = readJsonSafe(file);
    if (settings === null) {
      return { ok: false, msg: `${file} is not valid JSON — wire the hook by hand` };
    }
  } else {
    settings = {};
  }
  if (settingsHasRtkBashHook(settings)) return { ok: true, msg: "already wired" };
  settings.hooks = settings.hooks || {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
  settings.hooks.PreToolUse.push({
    matcher: "Bash",
    hooks: [{ type: "command", command: RTK_CLAUDE_HOOK_CMD }],
  });
  try {
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    return { ok: true, msg: ".claude/settings.local.json: PreToolUse Bash → rtk hook claude" };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

// ── BMAD Method ─────────────────────────────────────────────────────────────
// The bmad-family skills (.agents/skills/sk-bmad-*) do not implement
// BMAD themselves — every one of them activates a BMAD slash command
// (/bmad:bmm:agents:pm, /bmad:bmm:workflows:prd, …). Those commands are two
// separate halves, and either can arrive without the other:
//
//   (a) the COMMAND STUBS — .claude/commands/bmad/** (and the .gemini/commands/
//       bmad-*.toml port). Small files, so they travel in a forged framework
//       core even though no bmad skill does.
//   (b) the MODULE TREE — bmad/ (bmad/core/tasks/workflow.xml, bmad/bmm/
//       workflows/…), which every stub LOADS by {project-root}-relative path on
//       its first line.
//
// A workspace that has (a) without (b) looks wired — the slash command exists
// and is offered — then dies at step 1 on a path that is not there. That is the
// state a mounted framework core starts in, so the row must distinguish it from
// plain "BMAD absent" rather than collapsing both into one message.
//
// BMAD is NOT a Claude plugin: it is absent from .claude/settings.json's
// enabledPlugins/extraKnownMarketplaces, so the Host-plugins row above can never
// cover it. It installs by cloning BMAD-METHOD and running its own installer,
// which is interactive (it asks which IDEs/modules to wire). Hence report-only,
// apply: null — matching sk-skill-manager's ADVISE rule, "guidance only;
// never auto-install". The URL is duplicated from that skill's
// config.defaults.yaml on purpose: importing another skill's config is banned
// (tests/skill-config.test.mjs), and this URL is a fixed upstream, not a setting.
const BMAD_REPO = "https://github.com/bmad-code-org/BMAD-METHOD.git";

// The one file every command stub loads first. Its absence is what actually
// breaks a run, so it — not the bmad/ directory's mere existence — is the probe.
function bmadModuleTreePresent() {
  return (
    existsSync(join(ROOT, "bmad", "core", "tasks", "workflow.xml")) &&
    existsSync(join(ROOT, "bmad", "bmm", "workflows"))
  );
}

// Command stubs, counted per CLI so the row can say which surface is wired.
function bmadCommandState() {
  let claude = 0;
  const claudeDir = join(ROOT, ".claude", "commands", "bmad");
  if (existsSync(claudeDir)) {
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith(".md")) claude += 1;
      }
    };
    try {
      walk(claudeDir);
    } catch {
      /* unreadable tree — treat as none rather than crashing orientation */
    }
  }
  let gemini = 0;
  const geminiDir = join(ROOT, ".gemini", "commands");
  if (existsSync(geminiDir)) {
    try {
      gemini = readdirSync(geminiDir).filter(
        (f) => f.startsWith("bmad-") && f.endsWith(".toml")
      ).length;
    } catch {
      /* same */
    }
  }
  return { claude, gemini };
}

// Which bmad-family sidekicks skills this repo carries. Their presence is what
// makes BMAD *required* here; without them the row is not added at all.
function bmadSkillsPresent() {
  const dir = join(ROOT, '.agents', 'skills');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("sk-bmad-"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// Build the full check list fresh each time it is called, so --apply can
// re-detect after performing fixes and report the true post-apply state. Each
// check carries an `apply()` that performs its fix idempotently and returns
// { ok, msg }; a check with `apply: null` (plugins, BMAD) is report-only.
function buildChecks() {
  const checks = [];
  pluginSetupNotes = []; // recomputed each pass so --apply's re-detect reflects truth

  // Framework-repo helper scripts are absent in a workspace that MOUNTS the framework, and the
  // core's copies resolve their own repo root — so a row may only name one that is really here.
  const hasSetupWindows = existsSync(join(ROOT, "scripts", "setup-windows.mjs"));

  // 1) Git hooks — committed hooks live in .githooks and only run once
  //    core.hooksPath points there. A fresh clone does NOT set this, so the
  //    CLAUDE.md-mirror guard (and any other committed hook) silently does
  //    nothing until install-hooks runs.
  //
  //    Both halves must EXIST here before this is a fixable gap, because this
  //    check travels to layouts that carry neither. A mounted-core workspace is
  //    the one that bites: the framework's .githooks/ and scripts/ live inside
  //    .sidekicks-core/, `core init` leaves core.hooksPath alone on purpose, and
  //    the old unconditional row told the operator to run a root-level script
  //    that is not there. Pointing at the core's copy is not the fix either —
  //    install-hooks.mjs resolves its repo root from its OWN location, so it
  //    would set the hooks path of the core rather than of the workspace.
  {
    const hookScript = join(ROOT, "scripts", "install-hooks.mjs");
    const preCommit = join(ROOT, ".githooks", "pre-commit");
    const installable = existsSync(hookScript) && existsSync(preCommit);
    if (!installable) {
      checks.push({
        ok: true,
        label: "Git hooks",
        detail: MOUNTED_CORE
          ? "mounted-core workspace — the framework's hooks live in .sidekicks-core/ and `core init` leaves core.hooksPath alone on purpose (N/A)"
          : "no .githooks/pre-commit + scripts/install-hooks.mjs pair in this repo — nothing to install (N/A)",
        fix: null,
        apply: null,
      });
    } else {
      const res = spawnSync("git", ["config", "--get", "core.hooksPath"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      const value = (res.stdout || "").trim();
      const ok = value === ".githooks";
      checks.push({
        ok,
        label: "Git hooks",
        detail: ok ? "core.hooksPath=.githooks" : `core.hooksPath=${value || "(unset)"}`,
        fix: "node scripts/install-hooks.mjs",
        apply: () => {
          const r = spawnSync("node", ["scripts/install-hooks.mjs"], {
            cwd: ROOT,
            encoding: "utf8",
          });
          return {
            ok: r.status === 0,
            msg: r.status === 0 ? "core.hooksPath → .githooks" : (r.stderr || r.stdout || "").trim(),
          };
        },
      });
    }
  }

  // 2) Agent-context mirrors — CLAUDE.md and GEMINI.md must equal AGENTS.md.
  //    They are committed as symlinks; on Windows (core.symlinks=false) they
  //    check out as tiny text stubs containing the literal "AGENTS.md", so the
  //    Claude/Gemini CLIs read a 9-byte file instead of the real instructions.
  {
    const target = join(ROOT, "AGENTS.md");
    const mirrorOk = (name) => {
      const link = join(ROOT, name);
      if (!existsSync(link) || !existsSync(target)) return false;
      try {
        if (lstatSync(link).isSymbolicLink()) return true; // POSIX symlink — in sync by construction
        return readFileSync(link, "utf8") === readFileSync(target, "utf8"); // Windows copy fallback
      } catch {
        return false;
      }
    };
    const ok = mirrorOk("CLAUDE.md") && mirrorOk("GEMINI.md");
    checks.push({
      ok,
      label: "Agent-context mirrors (CLAUDE.md, GEMINI.md ↔ AGENTS.md)",
      detail: ok ? "in sync" : "stale or text-stub placeholders",
      // setup-windows.mjs is the Windows implementation, but it only exists in a repo that IS the
      // framework. A mounted-core workspace has no scripts/ of its own, and the core's copy is the
      // wrong target — it resolves its repo root from its own location, so it would repair the
      // CORE's mirrors. There, recreate them here instead.
      fix: isWindows && hasSetupWindows
        ? "node scripts/setup-windows.mjs"
        : isWindows
          ? "node bin/sidekicks core init   (recreates the AGENTS.md mirrors for this workspace)"
          : "ln -sf AGENTS.md CLAUDE.md && ln -sf AGENTS.md GEMINI.md",
      apply: () => {
        // On Windows the OS-correct fix (junctions + file-symlink-or-copy)
        // lives in setup-windows.mjs — one cross-platform implementation, not a
        // Windows-only fork. On POSIX, recreate the symlinks directly.
        if (isWindows && hasSetupWindows) {
          const r = spawnSync("node", ["scripts/setup-windows.mjs"], {
            cwd: ROOT,
            encoding: "utf8",
          });
          return {
            ok: r.status === 0,
            msg: r.status === 0 ? "mirrors recreated (Windows)" : (r.stderr || r.stdout || "").trim(),
          };
        }
        try {
          const target = join(ROOT, "AGENTS.md");
          if (!existsSync(target)) return { ok: false, msg: "no AGENTS.md to mirror" };
          let copied = false;
          for (const name of ["CLAUDE.md", "GEMINI.md"]) {
            const link = join(ROOT, name);
            try {
              rmSync(link, { force: true });
            } catch {
              /* nothing to remove */
            }
            try {
              symlinkSync("AGENTS.md", link, "file"); // repo-relative target, like `ln -sf AGENTS.md`
            } catch {
              // Windows without Developer Mode refuses symlinks; a byte-equal copy is the
              // supported form there, and it is what the mirror check accepts.
              writeFileSync(link, readFileSync(target, "utf8"));
              copied = true;
            }
          }
          return {
            ok: true,
            msg: copied
              ? "CLAUDE.md, GEMINI.md copied from AGENTS.md (symlinks unavailable)"
              : "CLAUDE.md, GEMINI.md → AGENTS.md symlinked",
          };
        } catch (e) {
          return { ok: false, msg: e.message };
        }
      },
    });
  }

  // 3) Host skill links — every per-CLI exposure directory must resolve to the
  //    canonical .agents/skills directory, or that CLI discovers no skills. The
  //    sidekicks CLI self-heals these on every invocation, so this is normally
  //    already green; it is only red before the first CLI call of a session, or
  //    if link creation was blocked.
  //
  //    All THREE are checked. This used to test .claude and .agent only, so a
  //    broken .gemini/skills link reported the repo as ready while Gemini saw
  //    nothing. (.agents/skills is not a link — it is the canonical tree itself.)
  {
    const EXPOSURE_LINKS = [".claude/skills", ".agent/skills", ".gemini/skills"];
    const linkIsDir = (rel) => {
      try {
        return statSync(join(ROOT, rel)).isDirectory(); // follows symlink/junction; a stub file -> false
      } catch {
        return false;
      }
    };
    const broken = EXPOSURE_LINKS.filter((rel) => !linkIsDir(rel));
    const ok = broken.length === 0;
    checks.push({
      ok,
      label: `Host skill links (${EXPOSURE_LINKS.join(", ")})`,
      detail: ok ? "resolve to .agents/skills" : `missing or text-stub placeholders: ${broken.join(", ")}`,
      fix: hasSetupWindows
        ? "run any `node bin/sidekicks` verb (auto-heals), or node scripts/setup-windows.mjs"
        : "run any `node bin/sidekicks` verb (auto-heals)",
      apply: () => {
        // On Windows, setup-windows.mjs ensures the junctions; on POSIX a single
        // CLI verb self-heals the symlinks (the documented mechanism). Where that
        // script does not exist (a mounted-core workspace), the CLI verb is the
        // cross-platform answer — it creates junctions on Windows too.
        if (isWindows && hasSetupWindows) {
          const r = spawnSync("node", ["scripts/setup-windows.mjs"], {
            cwd: ROOT,
            encoding: "utf8",
          });
          return {
            ok: r.status === 0,
            msg: r.status === 0 ? "skill links ensured (Windows)" : (r.stderr || r.stdout || "").trim(),
          };
        }
        const r = spawnSync("node", ["bin/sidekicks", "index", "show", "--json"], {
          cwd: ROOT,
          encoding: "utf8",
        });
        return {
          ok: r.status === 0,
          msg: r.status === 0 ? "skill links self-healed via CLI" : (r.stderr || "").trim(),
        };
      },
    });
  }

  // 4) Git submodules — registered user projects can be wired as git submodules
  //    (see the repo-root .gitmodules). A clone made without
  //    `--recurse-submodules` leaves those project directories EMPTY, so the
  //    work simply is not there until the submodules are initialized. Only
  //    surface this row when the repo actually declares submodules.
  if (existsSync(join(ROOT, ".gitmodules"))) {
    const subs = submoduleStatus();
    const uninit = subs.filter((s) => s.flag === "-").map((s) => s.path);
    const ok = uninit.length === 0;
    checks.push({
      ok,
      label: "Git submodules (registered projects)",
      detail: ok
        ? `${subs.length} initialized`
        : `${uninit.length} uninitialized: ${uninit.join(", ")}`,
      // Scope the fix to the uninitialized paths so already-checked-out
      // submodules (including ones with local edits) are never disturbed.
      fix:
        "git submodule update --init --recursive" +
        (uninit.length ? " -- " + uninit.join(" ") : ""),
      apply: () => {
        if (!uninit.length) return { ok: true, msg: "nothing to initialize" };
        const r = spawnSync(
          "git",
          ["submodule", "update", "--init", "--recursive", "--", ...uninit],
          { cwd: ROOT, encoding: "utf8" }
        );
        return {
          ok: r.status === 0,
          msg: r.status === 0 ? `initialized ${uninit.join(", ")}` : (r.stderr || "").trim(),
        };
      },
    });
  }

  // 5) Scope configuration — every block an installed skill declares should be DOCUMENTED in the
  //    scope's `config/<family>.yaml`, written inert so it still resolves to the skill's own
  //    defaults until a human uncomments a key. Adding or enhancing a skill changes what is owed,
  //    which is why the question is asked of the CLI rather than answered by comparing paths here.
  //
  //    This check runs LAST so that in --apply mode the submodule init above has already populated
  //    any freshly-pulled project before we look at it (the apply() re-asks, too).
  {
    // `config sync --check` exits non-zero exactly when a sync would close a gap, and prints the
    // gaps it found. Drift inside a live block is deliberately NOT a gap: no command may safely
    // merge into a file that can hold real credentials.
    const probe = spawnSync(
      process.execPath, [join(ROOT, "bin", "sidekicks"), "config", "sync", "--check", "--scope", "all"],
      { cwd: ROOT, encoding: "utf8" }
    );
    const reachable = !probe.error;
    const ok = reachable && probe.status === 0;
    // The gap COUNT and the scopes, not the whole listing: `--check` names every missing block, and
    // sixty of them on one readiness line buries every other row in the report. The command in
    // `fix:` prints the detail for anyone who wants it.
    const report = String(probe.stdout || probe.stderr || "");
    const gapCount = (report.match(/^\s+\S+\.yaml: '/gm) || []).length;
    const scopes = [...new Set(
      (report.match(/^\s+(\S+?)\/config\//gm) || []).map((m) => m.trim().split("/config/")[0])
    )];
    checks.push({
      ok,
      label: "Scope configuration (config/<family>.yaml — every declared block documented)",
      detail: !reachable
        ? "could not run `sidekicks config sync --check`"
        : ok
          ? "every installed skill's blocks are documented, in every scope"
          : `${gapCount || "some"} block(s) undocumented`
            + (scopes.length ? ` in ${scopes.join(", ")}` : ""),
      fix: "sidekicks config sync --scope all   (writes each block INERT — it keeps resolving to the owning skill's defaults)",
      apply: () => {
        // The generator is the CLI verb, not a script bundled here: a structural write under
        // .sidekicks/ belongs to the CLI (Rule 1). `config sync` is additive by construction —
        // it appends blocks a scope lacks, never rewrites one that carries live values — so it is
        // safe to run over every scope without first checking which are fresh.
        const r = spawnSync(
          process.execPath, [join(ROOT, "bin", "sidekicks"), "config", "sync", "--scope", "all"],
          { cwd: ROOT, encoding: "utf8" }
        );
        if (r.error || r.status !== 0) {
          return { ok: false, msg: ((r.stderr || r.stdout) || "config sync failed").trim().split("\n")[0] };
        }
        const wrote = String(r.stdout || "")
          .split("\n").filter((l) => l.includes("wrote:")).join("; ").trim();
        return {
          ok: true,
          msg: wrote || "already documented — nothing to write",
        };
      },
    });
  }

  // 6) Host plugins — enabledPlugins + extraKnownMarketplaces in
  //    .claude/settings.json travel with the repo, but the plugin PACKAGES and
  //    their marketplaces must be installed in the host (a fresh clone has
  //    neither). Unlike the old assumption, these ARE installable
  //    non-interactively via the `claude plugin` CLI (marketplace add / install
  //    — both idempotent and purely additive), so --apply performs them. The row
  //    is only added when plugins are declared; when the `claude` CLI is absent
  //    (another agent CLI where plugins do not exist) it is reported N/A, never a
  //    standing failure.
  {
    const declared = buildPlugins();
    if (declared.length) {
      const state = claudePluginState();
      if (!state.available) {
        checks.push({
          ok: true,
          label: "Host plugins",
          detail: "Claude Code CLI not detected — plugins are host-managed (N/A on this CLI)",
          fix: null,
          apply: null,
        });
      } else {
        // Plugins that are installed but still need their one-time setup run.
        for (const p of declared) {
          const base = p.name.includes("@") ? p.name.slice(0, p.name.indexOf("@")) : p.name;
          const setup = PLUGIN_SETUP[base];
          if (!setup) continue;
          if (!state.plugins.has(p.name)) continue; // wait until the package is installed
          if (typeof setup.isConfigured === "function" && setup.isConfigured()) continue; // already set up
          pluginSetupNotes.push({ name: base, command: setup.command, note: setup.note });
        }
        // Marketplaces to add: unique by alias, only those whose source we know.
        const marketByAlias = new Map();
        for (const p of declared) {
          if (p.alias && p.marketArg && !state.markets.has(p.alias)) {
            marketByAlias.set(p.alias, p.marketArg);
          }
        }
        const missingMarkets = [...marketByAlias.entries()]; // [alias, repo]
        const missingPlugins = declared.filter((p) => !state.plugins.has(p.name));
        const unknownSrc = declared.filter(
          (p) => p.alias && !p.marketArg && !state.markets.has(p.alias)
        );
        const ok = missingMarkets.length === 0 && missingPlugins.length === 0;
        const cmds = [
          ...missingMarkets.map(([, repo]) => `claude plugin marketplace add ${repo}`),
          ...missingPlugins.map((p) => `claude plugin install ${p.name}`),
        ];
        const bits = [];
        if (missingMarkets.length) bits.push(`${missingMarkets.length} marketplace(s)`);
        if (missingPlugins.length) bits.push(`${missingPlugins.length} plugin(s)`);
        checks.push({
          ok,
          label: "Host plugins",
          detail: ok
            ? `${declared.length} declared, all installed`
            : `missing ${bits.join(" + ")}: ` +
              [...missingMarkets.map(([a]) => a), ...missingPlugins.map((p) => p.name)].join(", ") +
              (unknownSrc.length
                ? ` (no marketplace source declared for: ${unknownSrc.map((p) => p.alias).join(", ")})`
                : ""),
          fix: cmds.length
            ? cmds.join("  &&  ")
            : "declare the missing marketplace source in .claude/settings.json extraKnownMarketplaces",
          apply: () => {
            const log = [];
            let allOk = true;
            // Add marketplaces first so each plugin's source is present before install.
            for (const [alias, repo] of missingMarkets) {
              const r = spawnSync("claude", ["plugin", "marketplace", "add", repo], {
                cwd: ROOT,
                encoding: "utf8",
              });
              if (r.status === 0) log.push(`+marketplace ${alias}`);
              else {
                allOk = false;
                log.push(`marketplace ${alias} FAILED: ${(r.stderr || r.stdout || "").trim()}`);
              }
            }
            for (const p of missingPlugins) {
              const r = spawnSync("claude", ["plugin", "install", p.name], {
                cwd: ROOT,
                encoding: "utf8",
              });
              if (r.status === 0) log.push(`+${p.name}`);
              else {
                allOk = false;
                log.push(`${p.name} FAILED: ${(r.stderr || r.stdout || "").trim()}`);
              }
            }
            return { ok: allOk, msg: log.length ? log.join(", ") : "nothing to install" };
          },
        });
      }
    }
  }

  // 7) RTK token-killer — see the header block above. High-value but optional dev
  //    tooling; neither its binary nor its activation hook is carried by git, so a
  //    fresh clone / new machine starts with rtk inactive. apply installs the binary
  //    (brew, best-effort) and wires a PROJECT-LOCAL hook for Claude + the
  //    rtk-native GLOBAL hook for Gemini; Codex is always N/A (no rtk hook exists).
  {
    const binary = rtkBinaryPresent();
    const claude = claudeRtkState();
    const claudeActive = claude.global || claude.committed || claude.local;
    const claudeScope = claude.local
      ? "project-local"
      : claude.committed
        ? "repo-committed"
        : claude.global
          ? "global"
          : null;
    // The repo carries a .gemini/ config iff Gemini CLI is used here; only then is a
    // missing Gemini hook worth flagging/wiring (rtk's Gemini hook is global-only).
    const repoUsesGemini = existsSync(join(ROOT, ".gemini"));
    const geminiActive = existsSync(geminiRtkHookPath());

    const detail = [
      `binary ${binary ? "✓" : "✗"}`,
      `Claude: ${claudeActive ? `active (${claudeScope})` : "not wired"}`,
      `Gemini: ${repoUsesGemini ? (geminiActive ? "active (global)" : "not wired") : "n/a (no .gemini)"}`,
      "Codex: N/A (no rtk hook)",
    ].join(" | ");

    // Green once the binary is present, Claude is active, and — when this repo uses
    // Gemini — the Gemini hook is wired too. Codex never gates (it cannot be wired).
    const ok = binary && claudeActive && (!repoUsesGemini || geminiActive);

    // Surface the single most useful next command on the FIX line.
    let fix;
    if (!binary) {
      fix = brewPresent()
        ? "brew install rtk"
        : "install rtk (https://www.rtk-ai.app/) — brew install rtk on macOS/Linux; scoop/cargo or the release binary on Windows";
    } else if (!claudeActive) {
      fix =
        "node .agents/skills/sk-hello/scripts/readiness.mjs --apply  (wires the project-local Claude hook)";
    } else if (repoUsesGemini && !geminiActive) {
      fix = "rtk init --gemini --global --auto-patch";
    } else {
      fix = null;
    }

    checks.push({
      ok,
      label: "RTK (token-killer CLI proxy)",
      detail,
      fix,
      apply: () => {
        const log = [];
        let allOk = true;

        // (a) Binary — install via brew when missing (best-effort; network, can be
        //     slow). On a host without brew (e.g. Windows) we cannot auto-install,
        //     so report the manual path rather than failing the whole orientation.
        let haveBinary = binary;
        if (!haveBinary) {
          if (brewPresent()) {
            const r = spawnSync("brew", ["install", "rtk"], { cwd: ROOT, encoding: "utf8" });
            haveBinary = rtkBinaryPresent();
            if (haveBinary) log.push("installed rtk (brew)");
            else {
              allOk = false;
              const tail = (r.stderr || r.stdout || "").trim().split("\n").pop();
              log.push(`brew install rtk FAILED: ${tail || "see brew output"}`);
            }
          } else {
            allOk = false;
            log.push("rtk missing and no brew on PATH — install manually (https://www.rtk-ai.app/)");
          }
        }

        // Hooks are wired only once the binary exists: a hook that shells out to a
        // missing `rtk` would error on every Bash call, which is worse than inactive.
        if (haveBinary) {
          // (b) Claude — add the project-local hook only when NO settings source
          //     already wires rtk (re-read fresh, post-install), to avoid double-run.
          const st = claudeRtkState();
          if (!(st.global || st.committed || st.local)) {
            const r = wireClaudeProjectLocalHook();
            log.push(`Claude hook: ${r.msg}`);
            if (!r.ok) allOk = false;
          }
          // (c) Gemini — rtk supports only a GLOBAL hook-script, installed by its own
          //     init. Wire it (when this repo uses Gemini and it is not yet present).
          if (repoUsesGemini && !existsSync(geminiRtkHookPath())) {
            const r = spawnSync("rtk", ["init", "--gemini", "--global", "--auto-patch"], {
              cwd: ROOT,
              encoding: "utf8",
            });
            if (r.status === 0 && existsSync(geminiRtkHookPath())) {
              log.push("Gemini hook: wired (global, rtk-native)");
            } else {
              allOk = false;
              const tail = (r.stderr || r.stdout || "").trim().split("\n").pop();
              log.push(`Gemini hook FAILED: ${tail || "rtk init --gemini failed"}`);
            }
          }
        }

        return { ok: allOk, msg: log.length ? log.join("; ") : "nothing to do" };
      },
    });
  }

  // 8) jq — see the helper block above. Host hooks (the ralph-loop plugin's Stop
  //    hook) shell out to `jq`; without it they die with "jq: command not found"
  //    on every Stop. Machine-local, never carried by git, and absent from a
  //    stock macOS — so it belongs in the same "things a fresh clone lacks" set.
  {
    const present = jqPresent();
    const onPath = jqDirOnPath();
    const installed = existsSync(jqTargetPath());
    const detail = present
      ? `binary ✓ (${(spawnSync("jq", ["--version"], { encoding: "utf8" }).stdout || "").trim() || "on PATH"})`
      : installed
        ? `binary at ${jqTargetPath()} but not resolving on PATH`
        : "binary ✗ — host hooks that parse JSON (ralph-loop Stop hook) will fail";

    // The remedy differs by cause: a binary already sitting in ~/.local/bin needs
    // PATH, not another download.
    const fix = present
      ? null
      : installed && !onPath
        ? `add ${jqInstallDir()} to PATH (e.g. in ~/.zshrc) — jq is installed there but not resolving`
        : brewPresent()
          ? "brew install jq"
          : `node .agents/skills/sk-hello/scripts/readiness.mjs --apply  (downloads jq ${JQ_VERSION} to ${jqInstallDir()})`;

    checks.push({
      ok: present,
      label: "jq (JSON CLI used by host hooks)",
      detail,
      fix,
      apply: () => {
        if (jqPresent()) return { ok: true, msg: "already installed" };
        const log = [];
        // Already downloaded, just unreachable — PATH is the user's to change.
        if (existsSync(jqTargetPath()) && !jqDirOnPath()) {
          return {
            ok: false,
            msg: `jq is installed at ${jqTargetPath()} but ${jqInstallDir()} is not on PATH — add it (e.g. in ~/.zshrc)`,
          };
        }
        // brew first when available — a package-managed jq stays upgradable and
        // lands somewhere already on PATH. The release binary is the fallback
        // for hosts with no package manager (stock macOS, Windows).
        if (brewPresent()) {
          const r = spawnSync("brew", ["install", "jq"], { cwd: ROOT, encoding: "utf8" });
          if (jqPresent()) return { ok: true, msg: "installed jq (brew)" };
          const tail = (r.stderr || r.stdout || "").trim().split("\n").pop();
          log.push(`brew install jq failed (${tail || "see brew output"}) — falling back to the release binary`);
        }
        // Windows equivalent: scoop needs no elevation and shims onto PATH, so it
        // beats dropping a loose .exe in ~/.local/bin the shell may never see.
        // (winget is deliberately not used — it can prompt/elevate, and this runs
        // unattended.)
        if (process.platform === "win32" && scoopPresent()) {
          const r = spawnSync("scoop", ["install", "jq"], { cwd: ROOT, encoding: "utf8", shell: true });
          if (jqPresent()) return { ok: true, msg: "installed jq (scoop)" };
          const tail = (r.stderr || r.stdout || "").trim().split("\n").pop();
          log.push(`scoop install jq failed (${tail || "see scoop output"}) — falling back to the release binary`);
        }
        const r = installJqBinary();
        log.push(r.msg);
        if (!r.ok) return { ok: false, msg: log.join("; ") };
        // Installed, but a shell that cannot see ~/.local/bin still cannot run
        // it — say so rather than reporting a green that hooks won't get.
        if (!jqDirOnPath()) {
          log.push(`${jqInstallDir()} is not on PATH — add it (e.g. in ~/.zshrc) for hooks to find jq`);
          return { ok: false, msg: log.join("; ") };
        }
        return { ok: jqPresent(), msg: log.join("; ") };
      },
    });
  }

  // 9) BMAD Method — see the helper block above. CLAUDE.md's rule.bmad-first makes
  //    the BMAD chain mandatory for service code, and every sk-bmad-* skill
  //    delegates to a /bmad:… slash command. Neither the command stubs nor the
  //    bmad/ module tree is installable by us (the upstream installer is
  //    interactive), so this row is REPORT-ONLY: apply: null, never an auto-clone.
  //
  //    Conditional by design — added only when this repo carries bmad-family
  //    skills or bmad command stubs. A runtime forged without either has nothing
  //    to satisfy, and a standing red row there would be noise, not readiness.
  {
    const skills = bmadSkillsPresent();
    const cmds = bmadCommandState();
    const stubs = cmds.claude + cmds.gemini;
    if (skills.length || stubs) {
      const tree = bmadModuleTreePresent();
      const surfaces = [
        `Claude: ${cmds.claude ? `${cmds.claude} command(s)` : "none"}`,
        `Gemini: ${cmds.gemini ? `${cmds.gemini} command(s)` : "none"}`,
      ].join(" | ");
      const who = skills.length
        ? `${skills.length} bmad skill(s) require it`
        : "no bmad skills here, but command stubs are present";

      let detail;
      let fix;
      if (tree && stubs) {
        detail = `bmad/ ✓ | ${surfaces} | ${who}`;
        fix = null;
      } else if (tree && !stubs) {
        // The tree is there but nothing exposes it — the skills' `/bmad:…`
        // activations resolve to nothing, which reads as "skill is broken".
        detail = `bmad/ ✓ but NO command stubs on any CLI — /bmad:… activations will not resolve | ${who}`;
        fix = `re-run the BMAD installer in this repo to wire the IDE commands (clone: ${BMAD_REPO})`;
      } else if (!tree && stubs) {
        // The dangling-stub state: this is what a freshly mounted framework core
        // looks like, and the failure it produces names a missing file, not a
        // missing install — so say the real cause here.
        detail =
          `${stubs} command stub(s) present (${surfaces}) but bmad/ module tree MISSING — ` +
          `every stub loads {project-root}/bmad/core/tasks/workflow.xml and will fail at step 1 | ${who}`;
        fix = `git clone ${BMAD_REPO} && run its installer against this repo (installs the bmad/ tree; interactive — never auto-run)`;
      } else {
        detail = `not installed — no bmad/ tree and no command stubs | ${who}`;
        fix = `git clone ${BMAD_REPO} && run its installer against this repo (interactive — never auto-run)`;
      }

      checks.push({
        ok: tree && stubs > 0,
        label: "BMAD Method (required by bmad-family skills)",
        detail,
        fix,
        apply: null, // guidance only — the upstream installer is interactive
      });
    }
  }

  // 10) Framework core release debt — only in the repo that PUBLISHES the core, i.e.
  //     one carrying both the core service AND scripts/framework-core-publish.mjs.
  //     The publish script DOES travel into a forged core (this skill's manifest claims
  //     it under requires.framework_files, and scripts/ travels by ownership), so the
  //     script alone is not the discriminator — the core SERVICE is. A mounted core has
  //     no core service of its own, so the row is absent there, which is correct: a
  //     mounted core publishes nothing.
  //
  //     WHERE that service lives is CONFIGURED (`framework_core.target`), not a literal.
  //     It used to be hard-coded as `.../services/sidekicks-framework/src`, and renaming
  //     the core repo to sidekicks-harness made this row silently stop firing — the path
  //     simply stopped existing, and an absent service reads exactly like a mounted core.
  //     Asking the CLI is also what framework-core-publish.mjs itself does, so the two
  //     cannot disagree about which core this repo publishes.
  //
  //     This is what makes the release log automatic rather than remembered: the
  //     publish script's own `status --json` is the single computation, surfaced on
  //     every orientation instead of only when someone thinks to check. Report-only:
  //     forging a release is an outward-facing act and stays the operator's call.
  {
    const publish = join(ROOT, "scripts", "framework-core-publish.mjs");
    const service = join(ROOT, ...coreTargetRel().split("/"));
    if (existsSync(publish) && existsSync(service)) {
      const r = spawnSync(process.execPath, [publish, "status", "--json"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      let st = null;
      try {
        st = JSON.parse(r.stdout || "");
      } catch {
        /* unparseable — reported as unknown below rather than crashing orientation */
      }
      if (!st) {
        checks.push({
          ok: true,
          label: "Framework core (release debt)",
          detail: "could not read publish status — reported N/A rather than a false green",
          fix: null,
          apply: null,
        });
      } else {
        const owed = (st.pending_commits || 0) + (st.pending_files || 0);
        const dirty = st.uncommitted_core_files || 0;
        // A release nobody pushed looked exactly like a published one on every orientation, which is
        // how v1.4.1 sat tagged-but-unserved while the README told consumers to install it. Only a
        // RECORDED negative counts: absence means "not verified", never "verified false".
        const notServed = st.remote_state === "not_served";
        const unlogged = Array.isArray(st.unlogged_tags) ? st.unlogged_tags : [];
        const ok = owed === 0 && dirty === 0 && st.version_agrees !== false && !notServed;
        const bits = [`published v${st.published_version || "?"}`];
        if (owed) bits.push(`${st.pending_commits} commit(s) since`);
        if (dirty) bits.push(`${dirty} uncommitted core-bound file(s)`);
        if (st.version_agrees === false) bits.push("log/marker version MISMATCH");
        if (notServed) bits.push(`v${st.unpushed_release} NOT SERVED by the remote`);
        else if (st.remote_state === "unverified") bits.push("remote not verified");
        if (unlogged.length) bits.push(`${unlogged.length} unlogged tag(s)`);
        checks.push({
          ok,
          label: "Framework core (release debt)",
          detail: ok
            ? `${bits.join(", ")} — in sync, no release owed`
            : `${bits.join(", ")} — next would be v${st.next_version || "?"}`,
          fix: ok
            ? null
            : notServed
              ? "node scripts/framework-core-publish.mjs release          (then … release --yes)"
              : "node scripts/framework-core-publish.mjs status   (then … publish)",
          apply: null, // publishing is outward-facing — never automatic
        });
      }
    }
  }

  return checks;
}

// Plugins — enabledPlugins AND extraKnownMarketplaces in .claude/settings.json
// travel with the repo, but the plugin PACKAGES must be installed in the host (a
// fresh clone has neither the marketplace registered nor the plugin cached).
// Derive each declared plugin's { name, alias, marketArg } from the committed
// settings; the plugins check (above) verifies which are installed via the
// `claude plugin` CLI and installs the missing ones in --apply mode.
function buildPlugins() {
  let plugins = [];
  try {
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8"));
    const markets = settings.extraKnownMarketplaces || {};
    const marketArg = (alias) => {
      const src = markets[alias] && markets[alias].source;
      if (!src) return null;
      if (src.source === "github" && src.repo) return src.repo;
      if (src.url) return src.url;
      if (src.path) return src.path;
      if (src.package) return src.package;
      return null;
    };
    plugins = Object.entries(settings.enabledPlugins || {})
      .filter(([, on]) => on === true || Array.isArray(on))
      .map(([name]) => {
        const alias = name.includes("@") ? name.slice(name.lastIndexOf("@") + 1) : null;
        return { name, alias, marketArg: alias ? marketArg(alias) : null };
      });
  } catch {
    /* no settings or unparseable — leave plugins empty */
  }
  return plugins;
}

// ── Detect (and, in --apply mode, prepare) ──────────────────────────────────
let checks = buildChecks();
const appliedLog = [];

if (APPLY) {
  for (const c of checks) {
    if (!c.ok && typeof c.apply === "function") {
      const r = c.apply();
      appliedLog.push(`  [${r.ok ? "DONE" : "FAIL"}] ${c.label} — ${r.msg}`);
    }
  }
  checks = buildChecks(); // re-detect so the report below reflects post-apply truth
}

// ── Render ──────────────────────────────────────────────────────────────────
const out = [];
out.push(`Environment readiness (${process.platform}${APPLY ? ", apply" : ", report-only"}):`);

if (APPLY && appliedLog.length) {
  out.push("");
  out.push("Applied fixes:");
  out.push(...appliedLog);
}

out.push("");
for (const c of checks) {
  const tag = c.ok ? "OK " : "FIX";
  out.push(`  [${tag}] ${c.label} — ${c.detail}`);
  if (!c.ok) out.push(`         run: ${c.fix}`);
}

if (pluginSetupNotes.length) {
  out.push("");
  out.push("Plugin setup needed (package installed, not yet configured — ASK the user before running):");
  for (const n of pluginSetupNotes) {
    out.push(`  • ${n.name} — run ${n.command} to ${n.note}`);
  }
}

const notReady = checks.filter((c) => !c.ok).length;
// Report-only rows (apply: null — plugins N/A, BMAD, core release debt) can never be
// fixed by --apply, so "re-run with --apply" must not be offered when they are all
// that is left. Promising a fix the flag cannot perform is worse than saying nothing.
const fixableByApply = checks.filter((c) => !c.ok && typeof c.apply === "function").length;
out.push("");
if (APPLY) {
  out.push(
    notReady === 0
      ? "All core checks green — clone prepared, safe to resume."
      : `${notReady} item(s) still need attention (commands above; some may require admin/Developer Mode or network access).`
  );
} else {
  out.push(
    notReady === 0
      ? "All core checks green — safe to resume."
      : fixableByApply === 0
        ? `${notReady} item(s) need attention — all of them report-only (run the commands above by hand; --apply cannot perform these).`
        : `${notReady} item(s) need a fix before resuming (${fixableByApply} of them applicable). Re-run with --apply to perform those automatically, or run the commands above by hand.`
  );
}

process.stdout.write(out.join("\n") + "\n");
process.exit(0); // best-effort: never fail the caller
