#!/usr/bin/env node
// .agents/skills/sk-inherit/scripts/inherit.mjs
//
// Deterministic engine for sk-inherit: forge and maintain a standalone Sidekicks
// RUNTIME — a lightweight, self-contained repo under runtimes/<name>/ that carries only a
// chosen subset of skills plus the core substrate needed to run them.
//
// DIRECTION IS ONE-WAY: the sidekicks root is the single source of truth and every operation
// runs FROM it. Nothing is ever read back out of a runtime as an upstream change. A runtime's
// local edits are detected (so they are never silently clobbered) but never propagated back.
// Running this engine from inside a runtime is refused outright — see assertSourceRepo().
//
// HARD INVARIANT: a runtime contains COPIES ONLY. It never links back to the source repo.
// Reason (verified): hook scripts resolve their repo root from
// dirname(fileURLToPath(import.meta.url)), and Node resolves a symlink to its realpath — so a
// linked surface silently binds the runtime's hooks to the SOURCE repo. A runtime with an empty
// memory store was observed emitting the source repo's full memory as SessionStart context.
// The only links a runtime carries are INTERNAL (its own .claude/skills -> .agents/skills
// exposure links, self-healed by its own CLI, and its AGENTS.md/GEMINI.md instruction mirrors).
//
// Zero dependencies. Node >= 20. Runs on macOS and Windows (no shell-outs for file work,
// path.join everywhere, venv bin/Scripts resolved per platform).

import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync,
  statSync, lstatSync, realpathSync, readlinkSync, rmSync, symlinkSync, chmodSync,
  renameSync, openSync, closeSync,
} from "node:fs";
import { join, dirname, relative, resolve, basename, sep, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { configurationInventory } from "../../../../lib/core-lifecycle/config-templates.mjs";
import { resolveFrameworkPreset } from "../../../../lib/skill-package/framework-preset.mjs";
import {
  projectSkillRuntime,
  projectedSourceHashes,
  RUNTIME_EXCLUDED_DIRS,
} from "../../../../lib/skill-package/runtime-projection.mjs";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS = join(SKILL_DIR, "assets");
const isWindows = process.platform === "win32";

const MANIFEST_REL = join(".sidekicks", "inherit.json");
const SCHEMA = 1;

// The one key in assets/presets.yaml that is NOT a preset: the skill floor every runtime carries.
// Named here rather than inline so the parser, the selection resolver, the prune guard, drift and
// verify all agree on which block that is.
const REQUIRED_KEY = "required";

// The other non-preset key in assets/presets.yaml: the third-party host plugins a forged runtime may
// DECLARE. Same reason it is named here — the parser, loadPresets and the prune all need to agree.
const HOST_PLUGINS_KEY = "host_plugins";

// ---------------------------------------------------------------------------
// Core distribution (AAP-110): a runtime forged to be MOUNTED, not run standalone
// ---------------------------------------------------------------------------
// `--as-core` adds the files that turn a forged runtime into a distributable FRAMEWORK CORE — a repo
// a user mounts as a git submodule at <workspace>/.sidekicks-core/ and updates with
// `sidekicks core update`. On by default for `--preset framework`, since that preset exists precisely
// to build that repo.
//
// The marker file is the load-bearing one. Both root resolvers (the CLI's, from cwd; every hook's,
// from its own file location) walk up looking for a `.sidekicks/` — and a mounted core HAS one. The
// marker is what makes them walk PAST it to the workspace above, which is the difference between a
// hook reading the workspace's memory and a hook reading the core's. See
// lib/sk-cli/core-mount.mjs.
//
// NOT generated here: a `.githooks/pre-push` refusing pushes. It would fire in a legitimate
// CONTRIBUTOR clone of the framework repo too (anyone who runs scripts/install-hooks.mjs there),
// blocking the very people meant to push. The push guard belongs to the MOUNT, where "mounted" is
// distinguishable from "cloned": `sidekicks core init` installs it into the submodule's own git dir.
const CORE_MARKER_REL = ".sidekicks-core.json";
const CORE_MOUNT_DIR = ".sidekicks-core";
const CORE_LAYOUT = 1;

// The core's own instruction surface — the generated AGENTS.md plus a mount preamble, and the file a
// consumer workspace imports. Named after AGENTS.md because that is the canonical instruction file
// (Rule 6); it shipped as CLAUDE.framework.md before the rename, and every reader still accepts that
// older name so a workspace pinned to an older core keeps resolving.
const CORE_INSTRUCTION_DOC = "AGENTS.framework.md";
const CORE_INSTRUCTION_DOC_LEGACY = "CLAUDE.framework.md";

// ---------------------------------------------------------------------------
// Release delta: what this forge changes in the repository it is about to overwrite
// ---------------------------------------------------------------------------
// A core is regenerated wholesale, so the destination's previous contents are the ONLY record of what
// a release actually changed — and `--force` destroys it. The destination is therefore SNAPSHOTTED
// before the first write, and the README is rendered from the diff at the end of the forge.
//
// Why the README and not just stdout: the README is the one document a consumer reads before running
// `core update`, and until now it described the release in prose a human had to remember to update.
// The pre-rename README named CLAUDE.md as the workspace's instruction file for every release after
// the Rule 6 flip made it a symlink — nothing could catch that, because nothing was derived.
//
// Volatile bytes are MASKED before hashing (`maskVolatile`). Every generated file carries a forge
// timestamp and the source commit, so an unmasked comparison reports the entire distribution as
// changed on every forge, which is the same as reporting nothing.
const DELTA_SKIP_DIRS = new Set([".git", "artifacts", "node_modules", ".venv", "__pycache__", "output", "tmp"]);

// Metadata that changes on every forge by construction, and says nothing about the release: the
// marker (timestamp + commit), the inherit manifest (per-file hashes and timestamps), and the derived
// state the runtime's own CLI rebuilds. README.md is excluded because it is the file being written
// FROM this delta — including it would make every release report itself as changed.
const DELTA_SKIP_RELS = new Set([
  CORE_MARKER_REL,
  "README.md",
  ".sidekicks/inherit.json",
  ".sidekicks/settings.json",
]);
const DELTA_SKIP_PREFIXES = [".sidekicks/state/"];

const TEXTUAL = /\.(md|mjs|js|cjs|json|ya?ml|sh|ps1|toml|txt|py|gitignore)$|(^|\/)\.gitignore$/i;

// Optional AGENT PACKS travel with a core distribution (`--as-core`) and with nothing else.
// A pack is a directory here carrying `pack.yaml`; `lib/agent-lifecycle/_pack.mjs` owns the format.
// Written with forward slashes and split on join, so the constant reads the same on both platforms.
const CORE_PACKS_REL = join(".sidekicks", "agent-packs");
const PACK_MANIFEST_NAME = "pack.yaml";

/**
 * Verify a forged core's agent packs by running the CORE'S OWN CLI against them.
 *
 * Deliberately not a second validator written here. The question this gate answers is "will the
 * consumer's `agent pack install` accept what we shipped", and the only honest way to answer it is
 * to ask the code the consumer will run — the same reasoning as gate 6, which runs the runtime's own
 * `framework sync --check` rather than re-deriving the enable map. A reimplementation here would
 * drift from lib/agent-lifecycle/_pack.mjs and start passing packs that fail on a user's machine.
 *
 * @returns {string[]} problems, empty when every pack is sound
 */
function verifyAgentPacks(dir, packsDir) {
  const r = spawnSync(process.execPath, [join(dir, "bin", "sidekicks"), "agent", "pack", "list", "--json"],
    { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) {
    const first = String(r.stderr || r.stdout || "").trim().split("\n")[0];
    return [`the core cannot read its own agent packs — 'agent pack list' failed: ${first}`];
  }
  let payload = null;
  try { payload = JSON.parse(r.stdout || "null"); } catch { /* below */ }
  if (!payload || !Array.isArray(payload.packs)) {
    return ["'agent pack list --json' produced no readable payload in the forged core"];
  }
  const onDisk = countAgentPacks(packsDir);
  if (payload.packs.length !== onDisk) {
    return [`${CORE_PACKS_REL}/ holds ${onDisk} pack(s) but the core discovers ${payload.packs.length}`
      + " — a pack that cannot be discovered has shipped invisibly"];
  }
  const problems = [];
  for (const p of payload.packs) {
    if (p.state !== "invalid") continue;
    const why = (p.errors || []).join("; ") || "no reason reported";
    problems.push(`agent pack '${p.id}' is invalid in the forged core — ${why}`);
  }
  return problems;
}

/**
 * The skills a published core must carry because of the AGENT PACKS it ships.
 *
 * A pack DECLARES the skills its agents need and never bundles one. Until this existed, nothing
 * connected that declaration to the forge: a core shipped the `core` pack and none of the three
 * skills it requires, so the consumer's very first `agent pack install core` refused. Deriving the
 * set here is also what stops presets.yaml drifting — an agent that starts needing another skill
 * says so in its pack manifest, and the core picks it up with no edit to a hand-kept list.
 *
 * Read through the source repo's own lib/ (same dynamic-import pattern as resolveScriptOwnership),
 * so the definition of a valid pack lives in exactly one place.
 *
 * The result is unioned into a CORE's skill selection only — never into the required floor, which
 * stays the substrate a runtime cannot go without.
 *
 * @returns {Promise<{skills: string[], packs: number, seeds: string[], viaClosure: string[]}>}
 */
async function resolvePackSkills(repoRoot) {
  const empty = { skills: [], packs: 0, seeds: [], viaClosure: [] };
  const packsDir = join(repoRoot, CORE_PACKS_REL);
  if (!existsSync(packsDir) || countAgentPacks(packsDir) === 0) return empty;

  let discoverPacks, skillClosure;
  try {
    ({ discoverPacks } = await import(pathToFileURL(join(repoRoot, "lib", "agent-lifecycle", "_pack.mjs")).href));
    ({ skillClosure } = await import(pathToFileURL(join(repoRoot, "lib", "skill-package", "closure.mjs")).href));
  } catch (e) {
    die(`cannot resolve agent-pack skills — the source repo's lib/ did not load: ${e.message}`, 3);
  }

  const packs = discoverPacks(repoRoot);
  const seeds = new Set();
  // Which pack asked for each seed, so a skill that only travels because a pack named it can say
  // so. Without this, pack-derived skills were the ONLY selection with no recorded reason — and
  // they are precisely the ones nobody named on the command line, so they are the hardest to
  // justify six months later. The publisher was inventing an 'agent-pack' label from the ABSENCE
  // of a reason, which meant the release log and .sidekicks/inherit.json disagreed.
  const seedOwners = new Map();
  const noteOwner = (skill, reason) => {
    if (!seedOwners.has(skill)) seedOwners.set(skill, new Set());
    seedOwners.get(skill).add(reason);
  };
  for (const pack of packs) {
    if (!pack.manifest) continue;
    for (const dep of pack.manifest.requires_skills) {
      // A REQUIRED row always travels. An OPTIONAL one travels when the source repo has it: the
      // pack says what is lost without it, so shipping it when we can is free, and omitting it when
      // we cannot is exactly the documented degraded install rather than a broken core.
      if (dep.required || resolveSkill(repoRoot, dep.name)) {
        seeds.add(dep.name);
        noteOwner(dep.name, `agent-pack:${pack.id}:declared`);
      }
    }
  }
  if (!seeds.size) return { ...empty, packs: packs.length };

  const seedList = [...seeds].sort();
  let all = seedList;
  try {
    const closure = skillClosure(repoRoot, seedList, { scope: "runtime" });
    all = [...new Set([...seedList, ...closure.selected.map((x) => x.skill)])].sort();
    for (const row of closure.selected) {
      if (seeds.has(row.skill)) continue;
      // `via` names every requester the walk passed through, so the reason says which declared seed
      // dragged this one in rather than only that a pack did.
      for (const parent of row.via?.length ? row.via : ["unknown"]) {
        noteOwner(row.skill, `agent-pack:closure:${parent}`);
      }
    }
  } catch { /* a closure that cannot run must not lose the declared seeds */ }
  const reasons = {};
  for (const skill of [...seedOwners.keys()].sort()) reasons[skill] = [...seedOwners.get(skill)].sort();
  return {
    skills: all,
    packs: packs.length,
    seeds: seedList,
    viaClosure: all.filter((n) => !seeds.has(n)),
    reasons,
  };
}

/** How many real packs a packs directory holds — a stray file or an empty folder is not one. */
function countAgentPacks(packsDir) {
  let entries;
  try { entries = readdirSync(packsDir, { withFileTypes: true }); } catch { return 0; }
  let n = 0;
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (existsSync(join(packsDir, e.name, PACK_MANIFEST_NAME))) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// What a runtime carries
// ---------------------------------------------------------------------------

// Core substrate copied into every runtime. Each entry is repo-relative.
// lib/ is copied WHOLE on purpose: the CLI dispatcher lazy-imports by string template
// (`../${namespace}-lifecycle/${verb}.mjs`), which static closure analysis cannot see
// (documented blind spot in lib/package-lifecycle/closure.mjs). A partial lib/ yields a
// CLI that dies on its first unanalyzed verb.
const CORE_SURFACES = [
  "bin",
  "lib",
  // scripts/install-hooks.mjs travels with every runtime and installs core.hooksPath from
  // .githooks/. Without the directory the runtime's readiness check reports a git-hooks failure it
  // can never clear ("Expected hook not found at <runtime>/.githooks/pre-commit").
  //
  // Repo-root tests/ does NOT travel. The hook is written to survive that: its mirror guard runs
  // lib/framework-lifecycle/tests/agent-context-mirror.test.mjs where the file exists and checks the
  // CLAUDE.md/GEMINI.md -> AGENTS.md invariant directly where it does not. Before that, installing
  // the hook in a forged runtime made every commit there fail on a test file it never carried.
  // (That suite and its parity sibling now live under lib/, so a forged runtime DOES carry them —
  // the fallback stays because a trimmed lib/ or a pre-move core still needs it.)
  ".githooks",
  ".sidekicks/RULES.md",
  ".sidekicks/hooks",
  // The framework enable map. Without it a runtime resolves every rule, criterion and hook to
  // the built-in default, so anything the source deliberately DISABLED comes back on — silently.
  // Copied, then re-synced against the runtime's own (smaller) registry, see syncRuntimeFramework.
  //
  // The map is SETTINGS (booleans), not configuration values, and lives in its own directory:
  // .sidekicks/config/settings/{rules,criteria,hooks}.yaml — see
  // docs/guide/settings-vs-configuration.md. Every layout this repo has shipped is listed because a
  // source that has not migrated still carries the older paths and a missing surface is skipped
  // silently; the config/ directory itself is NEVER a copy surface — it holds the SOURCE repo's
  // own values and its git-ignored *.secret.yaml siblings, so only these files are named.
  // The ignore rule that keeps the credential half of every family file out of git, WHICHEVER repo
  // this directory ends up in — which is the whole point of it living inside config/ rather than in
  // a repo-root .gitignore. A runtime is a different repo by construction, so omitting it shipped
  // runtimes whose config/ directory would happily stage a *.secret.yaml. Caught by `config doctor`
  // (secret-files-not-ignored) run INSIDE a forged core.
  ".sidekicks/config/settings/rules.yaml",
  ".sidekicks/config/settings/criteria.yaml",
  ".sidekicks/config/settings/hooks.yaml",
  ".sidekicks/config/framework.example.yaml",
  ".sidekicks/config/.gitignore",
];

// The ONLY framework entries a forged runtime is allowed to ship switched OFF, each with the reason.
//
// A forged core's enable map is a DEFAULT, not a snapshot of whoever forged it. Before this map
// existed the forge copied `.sidekicks/config/settings/*.yaml` out of the source working tree, so
// every consumer inherited one afternoon's toggles — v1.4.4 shipped `hook.enforce-branch-safety:
// false` while the instruction surface it also shipped calls "never hijack a shared working tree" a
// hard rule (INC-2026-09-06-06 B-1). normalizeRuntimeEnableMap now writes `true` for every
// toggleable id EXCEPT the ones named here, and cmdVerify fails a forge that ships any other `false`.
//
// `notStated: true` additionally marks an entry as one the LEAN instruction surface does not carry.
// That subset is the honest half of a two-sided contract enforced by cmdVerify: every framework-core
// entry must EITHER have its registry marker present in the generated AGENTS.md, OR be named here
// and written `false` into the runtime's enable map. A rule that is in neither is a rule the runtime
// claims to follow and never states — which is exactly how v2.0.0 shipped without Teleport-only
// production access, outward-action confirmation, or the autonomous-auditor safety floor while
// `framework show` still reported `body_exists: true` for all three.
//
// TWO RULES ABOUT THIS MAP, and they are what keep it from becoming the escape hatch it looks like:
//   1. A FLOOR id may never appear here. `framework disable` refuses one outright, and
//      lib/framework-settings/resolve.mjs throws on a floor id present in ANY settings layer — so
//      naming one would break the runtime rather than quietly weaken it. cmdVerify asserts it too.
//   2. Membership is DECLARED, never DERIVED. Nothing may ever add an id here (or write a `false`)
//      because a body was not found. That would make the check self-fulfilling: every dropped rule
//      would silence its own alarm, and the contract would be vacuous for every non-floor entry.
//      Removing prose is a decision a human makes here, in a diff, with a reason.
//
// The ONE derived exception lives outside this map, in normalizeRuntimeEnableMap: a HOOK whose every
// owning skill is not on disk in the forged artifact is written `false`. That derivation is safe in
// the way rule 2 forbids for prose, because it is not a judgement about the entry — the script the
// hook names is verifiably absent, so "enabled" could only ever mean "will never fire".
const CORE_SETTINGS_SHIPPED_OFF = Object.freeze({
  // Depends on a project/service artifacts tree and the incident-report layout, neither of which a
  // bare runtime has until it grows projects.
  "rule.incident-reports": {
    notStated: true,
    reason: "needs a project/service artifacts tree a bare runtime has not grown yet",
  },
});

/** The subset of CORE_SETTINGS_SHIPPED_OFF whose prose the lean instruction surface does not state. */
const CORE_RULES_NOT_IN_RUNTIME_INSTRUCTIONS = Object.freeze(
  Object.entries(CORE_SETTINGS_SHIPPED_OFF).filter(([, v]) => v.notStated).map(([id]) => id),
);

// Optional core surfaces, keyed by flag name (--no-<key> drops them).
//
// Every CLI's port of a surface belongs to the same flag (Rule 6). The CLI-neutral
// `.agents/subagents` source travels with every generated host port. `.codex/agents` and
// `.agents/plugins` used to ride in CLI_WIRING instead, which had no flag at all — so `--no-agents`
// dropped the Claude subagents and left 41 Codex and Antigravity ports of the same set behind. And
// `.gemini/commands` was in no list whatsoever, which is why a forged core's readiness reported the
// Claude half of the command stubs and nothing else (INC-2026-09-04-02, N-4).
const OPTIONAL_SURFACES = {
  agents: [".agents/subagents", ".claude/agents", ".codex/agents", ".gemini/agents", ".agents/plugins"],
  commands: [".claude/commands", ".gemini/commands"],
};

// ── Agents and commands travel by OWNERSHIP, not wholesale (INC-2026-09-04-02, N-4) ──────────────
//
// The forge copied these trees whole, so the published core shipped 37 `/bmad:*` commands that load
// `{project-root}/bmad/core/tasks/*.xml` from a tree it does not carry, 16 Codex agents and 4 Claude
// agent packs for skills it does not carry, and a readiness row telling consumers to `git clone
// BMAD-METHOD` — a defect they cannot fix, because the payload is the framework's.
//
// This is the same answer scripts/ already got (AAP-111, resolveScriptOwnership): a surface entry
// travels only when the SELECTION owns it. Ownership metadata does not exist for these files — no
// manifest maps an agent or command to a skill — so the signal is the naming convention the repo
// already uses consistently across all five per-CLI ports, and a test locks it so the convention
// stops being unenforced.
//
// FAMILY_TOKENS: how a family shows up in a path, per CLI.
//   .claude/commands/bmad/**            segment 'bmad'
//   .claude/agents/bmad-planning/**     segment 'bmad-planning'
//   .codex/agents/bmm-api-documenter.toml           basename 'bmm-api-documenter'
//   .gemini/commands/bmad-agent-bmm-analyst.toml    basename 'bmad-agent-bmm-analyst'
//   .agents/plugins/sidekicks-agents/agents/bmm-*   basename 'bmm-*'
// Anything matching NO token is framework floor and always travels: the `sidekicks-*` agent packs
// and their `sk-*` ports are generic dev subagents that depend on no skill.
const FAMILY_TOKENS = Object.freeze({
  bmad: [/^bmad(-|$)/i, /^bmm(-|$)/i],
});

// FAMILY_OWNERS: which selected skills make a family's surface meaningful. No `sk-bmad-*` skill in
// the selection means every BMAD stub would fail at step 1, so none of them ship.
const FAMILY_OWNERS = Object.freeze({
  bmad: [/^sk-bmad-/],
});

/** The family a path inside an agent/command surface belongs to, or null for framework floor. */
function surfaceFamily(rel) {
  for (const seg of String(rel).split(sep).filter(Boolean)) {
    const token = seg.replace(/\.[^.]+$/, "");
    for (const [family, tokens] of Object.entries(FAMILY_TOKENS)) {
      if (tokens.some((re) => re.test(token))) return family;
    }
  }
  return null;
}

/** Families whose agent/command surface this skill selection owns. */
function ownedFamilies(skillNames) {
  const kept = new Set();
  for (const [family, owners] of Object.entries(FAMILY_OWNERS)) {
    if (skillNames.some((s) => owners.some((re) => re.test(s)))) kept.add(family);
  }
  return kept;
}

// Delegate agents — the named persistent agents at .sidekicks/agents/<name>/ driven by the
// `sidekicks agent` verbs. They are NEVER bulk-copied, and the guarantee is STRUCTURAL rather than
// a deny entry: .sidekicks is not a copy surface (see CORE_SURFACES — only named files and hooks/
// under it are), so no copyTree walk ever reaches the folder, and an agent travels only when it is
// named (--delegates, or a preset's `delegates:` block), surface by surface via inheritDelegates.
// Adding .sidekicks/ or the repo root as a copy surface would break that — don't, without
// reinstating a deny rule here. The flag is "delegates", not "agents", because --no-agents already
// means the CLI-neutral subagent set and all generated host ports.
const DELEGATES_DIRNAME = "agents";

// The inherited surface of ONE delegate agent:
//   agent.yaml  — the charter
//   routines/   — its routine definitions
// memory/ is opt-in (--delegate-memory) for exactly the reason .sidekicks/memory/ never travels:
// an agent's memory records the SOURCE repo's decisions. runtime/ (presence, control gate, mailbox,
// threads, PIDs) is per-clone volatile state — git-ignored at the source, never copied here.
const DELEGATE_SURFACES = ["agent.yaml", "routines"];
const DELEGATE_MEMORY_DIR = "memory";

// Skills that drive delegate agents. Inheriting an agent without one of these is legal — the
// `sidekicks agent` verbs live in lib/, which travels whole — but worth saying out loud.
const DELEGATE_SKILL_RE = /^sidekicks-agent-/;

// The agent bridge, .sidekicks/agents/.bridge/. Same safety class as .sidekicks/config.yaml: it
// holds live secrets (the bridge token, the Telegram bot_token/chat_id) plus PID files and logs,
// and lib/agent-lifecycle/_bridge.mjs mkdirp's it on demand. It must never travel, and cmdVerify
// FAILS when a runtime contains one.
const BRIDGE_DIRNAME = ".bridge";

// scripts/ that a runtime needs to OPERATE its delegate agents, claimed by the presence of any
// inherited agent rather than by a skill. Reason: `sidekicks agent start --headless` and the
// LaunchAgent/tray wiring are the operating surface of an agent, not of a skill — a runtime can
// carry a crew before it carries the sk-agent-* skills that document them, and it must still
// be able to start and supervise them. Every one of these resolves its own root from its own
// location (`dirname $0/..`), so none binds back to the source repo, and both plists are
// __REPO_ROOT__/__AGENT__ token templates the installer fills in.
const DELEGATE_SCRIPT_FILES = [
  "start-agent-delegate.sh",              // headless delegate runner, one command
  "install-delegate-launchagent.sh",      // survive logout/reboot
  "uninstall-delegate-launchagent.sh",
  "agent-tray.sh",                        // menu-bar Agent Tray launcher
];
const DELEGATE_SCRIPT_SUBDIRS = ["launchd"];   // the delegate + tray plist templates

// Per-CLI wiring copied for Rule 6 parity. Missing entries are skipped silently.
//
// The per-CLI AGENT ports (.codex/agents, .agents/plugins) deliberately are NOT here any more: they
// are agents, they answer to --no-agents, and they carry the same ownership filter as their Claude
// counterpart. See OPTIONAL_SURFACES.
const CLI_WIRING = [
  ".claude/settings.json",
  ".codex/config.toml",
  ".gemini/settings.json",
  ".agent/settings.json",
];

// scripts/ travels by OWNERSHIP, not by directory (AAP-111). A top-level file is copied only
// when something shipped claims it: a CORE_HOOKS entry with no owner (framework floor), a
// CORE_HOOKS entry whose owners intersect the selection, or a selected skill's manifest
// (requires.framework_files / framework_hooks via lib/skill-package/closure.mjs). Subdirectories
// are gated by SCRIPT_SUBDIR_OWNERS (below) or by a manifest claim inside them. --full-scripts
// bypasses the ownership gate (DENY still applies). See resolveScriptOwnership().
const SCRIPT_SUBDIR_OWNERS = {
  "office-viz-themes": ["sk-office-viz"],
  "office-viz-vendor": ["sk-office-viz"],
  launchd: ["sk-agent-standby", "sk-agent-master", "sk-agent-tray"],
};

// scripts/ subdirectories that ALWAYS travel. scripts/lib/ carries hook-gate.mjs — every hook
// imports it (fail-open), so a runtime without it ships hooks that cannot be gated off.
const SCRIPT_SUBDIR_FLOOR = ["lib"];

// scripts/ FILES that always travel: framework-floor infrastructure owned by no single skill.
// run-tests.mjs is the runtime's `npm test`. It travels unconditionally because the alternative
// is what v2.0.0 shipped — a package.json glob that discovers nothing and still exits 0, so the
// artifact reported a green suite while its 89 real tests were never loaded (F-05).
const SCRIPT_FILE_FLOOR = ["run-tests.mjs"];
const SUBAGENT_PORT_SCRIPT_FILES = ["generate-subagent-ports.mjs"];

// The `npm test` command every forged runtime gets. Never a glob: see scripts/run-tests.mjs.
const RUNTIME_TEST_SCRIPT = "scripts/run-tests.mjs";
const RUNTIME_TEST_COMMAND = `node ${RUNTIME_TEST_SCRIPT}`;

// NEVER copied. Secrets, machine-local state, and — critically — the source repo's memory
// store and projects. A runtime starts with an EMPTY memory store; inheriting the source's
// memory would leak another repo's decisions into it as SessionStart context.
const DENY = new Set([
  ".git", ".venv", "node_modules", ".env", ".DS_Store",
  "artifacts", "output", "tmp", "projects", "docs-history", "experiments",
  "settings.local.json", "config.yaml", "running-agents.json",
  "scheduled_tasks.lock", "index.json", "settings.json",
  // "agents" is deliberately NOT here. It was a bare segment matched at ANY depth, so it also ate
  // .agents/plugins/sidekicks-agents/agents/ (41 Antigravity subagents — a Rule 6 parity hole),
  // .claude/commands/bmad/{core,bmm}/agents/, and four first-party skills' own agents/ directory
  // (which also produced a permanent false FF, since the baseline was hashed from the truncated
  // runtime copy while drift compared the full source tree). The bulk copy of .sidekicks/agents/
  // that the entry was written to stop is held back STRUCTURALLY, not by this set: .sidekicks is
  // never a copy surface (only .sidekicks/RULES.md, /hooks, /config.example.yaml and the two named
  // framework enable-map files under config/ are — see CORE_SURFACES), and a selected delegate
  // travels through inheritDelegates' explicit
  // per-surface list (agent.yaml + routines, memory only on request), which never walks the folder.
  // Guarded by tests/skills/inherit-delegate-agents.test.mjs. ".bridge" and "memory" stay bare
  // segments and are what actually keeps credentials out — do not fold them into anything narrower.
  ".bridge", "memory", "skill-offloaded", "artifacts-inventory.json",
  "artifacts-inventory.md", "__pycache__",
  // The derived-state directory (.sidekicks/state/ — scope index, running agents, artifact
  // inventory). Its individual files are already denied by basename above, so this is the rule that
  // keeps holding when a new state file is added. A runtime rebuilds its own.
  "state",
]);

// Path-segment PATTERNS never copied — build residue and credential files that have no fixed
// name. Checked in isDenied() and the scripts/ loop; --full-scripts does NOT bypass these.
// `*.secret.yaml` is the credential half of every config family file (config/<family>.secret.yaml,
// git-ignored). No copy surface reaches one today — .sidekicks/config/ is not a surface and only
// two named files under it travel — so this is a second, structural line of defence: adding any
// config surface later must not silently start shipping credentials.
const DENY_PATTERNS = [/\.log$/i, /\.secret\.yaml$/i];

// Paths whose basename sits in DENY but which we DO want. An explicit allowlist entry wins.
const DENY_EXCEPTIONS = new Set([
  join(".claude", "settings.json"),
  join(".claude", "agents"),
  join(".codex", "agents"),
]);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function die(msg, code = 1) {
  process.stderr.write(`inherit: ${msg}\n`);
  process.exit(code);
}

function out(msg = "") {
  process.stdout.write(`${msg}\n`);
}

/** Walk up from cwd for the directory containing .sidekicks/. */
function walkUpForSidekicks(start = process.cwd()) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".sidekicks"))) return dir;
    const up = dirname(dir);
    if (up === dir) die("not inside a Sidekicks repo (no .sidekicks/ found walking up)", 2);
    dir = up;
  }
}

/**
 * Resolve the SOURCE repo root and refuse anything else.
 * Sync is one-way (source -> runtime), so the engine must run from the sidekicks root. A
 * runtime carries its own .sidekicks/, so a bare walk-up inside one would silently anchor on
 * the runtime and "inherit" it from itself. Detect that and stop with a usable message.
 */
function resolveSourceRoot() {
  const root = walkUpForSidekicks();
  if (existsSync(join(root, MANIFEST_REL))) {
    const m = readManifest(root);
    die([
      `${root} is an inherited RUNTIME (${m?.runtime ?? "unknown"}), not the sidekicks source repo.`,
      "Sync is one-way: source -> runtime. Run this from the sidekicks root instead.",
    ].join("\n         "), 2);
  }
  if (!existsSync(join(root, "lib", "sk-cli", "cli.mjs")) || !existsSync(join(root, '.agents', 'skills'))) {
    die(`${root} does not look like a sidekicks source repo (missing lib/sk-cli/ or .agents/skills/)`, 2);
  }
  return root;
}

function mkdirp(dir) {
  mkdirSync(dir, { recursive: true });
}

/**
 * Display form for a path: repo-relative when it is inside the repo, absolute otherwise.
 * A bare relative() on an out-of-tree --target yields a wall of "../../.." that reads as noise.
 */
function displayPath(repoRoot, target) {
  const rel = relative(repoRoot, target);
  return !rel ? "." : (rel.startsWith("..") ? target : rel);
}

/** Asia/Bangkok ISO-8601 timestamp with explicit +07:00 offset (AGENTS.md timezone rule). */
function nowBangkok() {
  const ms = Date.now() + 7 * 3600 * 1000;
  return `${new Date(ms).toISOString().replace(/\.\d{3}Z$/, "")}+07:00`;
}

function gitHead(repoRoot) {
  const r = spawnSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

/**
 * Content hash, line-ending normalized.
 * A Windows checkout may materialize CRLF where macOS has LF; hashing raw bytes would then
 * report every inherited file as locally modified. Text files are normalized to LF before
 * hashing; binaries (any NUL byte in the first 8KB) are hashed raw.
 */
function hashFile(path) {
  return hashBuffer(readFileSync(path));
}

/**
 * The same hash for content that is not on disk under its final name.
 *
 * A projected skill carries DERIVED metadata — a manifest whose baseline describes the projected
 * files, a VERSION.json whose list names only what shipped — so the drift comparison has to hash
 * bytes the source folder does not contain. Splitting this out is what keeps the two paths using one
 * definition of "the same file" rather than two that drift apart.
 */
function hashBuffer(buf) {
  const isBinary = buf.subarray(0, 8192).includes(0);
  const payload = isBinary ? buf : Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha256").update(payload).digest("hex");
}

/** { relPath: sha256 } for every regular file under dir. Keys are POSIX-separated. */
function hashTree(dir) {
  const map = {};
  if (!existsSync(dir)) return map;
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs).sort()) {
      if (entry === "__pycache__") continue;
      const childAbs = join(abs, entry);
      const childRel = rel ? `${rel}/${entry}` : entry;
      let st;
      try { st = lstatSync(childAbs); } catch { continue; }
      if (st.isSymbolicLink()) continue;          // links are never inherited content
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) map[childRel] = hashFile(childAbs);
    }
  };
  walk(dir, "");
  return map;
}

// The deny-filtered source hash map that used to live here is gone: `projectedSourceHashes` in
// lib/skill-package/runtime-projection.mjs answers the same question and one more. Both existed to
// stop the same defect — the baseline is hashed from the RUNTIME copy, so any filter applied on one
// side and not the other is a permanent false FF that no patch can close — but a skill's runtime
// copy is now a projection, not just a deny-filtered tree, so filtering alone would still report
// `skill.manifest.yaml` and `VERSION.json` as moved on every run. Keeping a second, weaker filter
// beside the real one is exactly how the two sides drift apart again.

function sameHashes(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i] || a[ka[i]] !== b[kb[i]]) return false;
  }
  return true;
}

function isDenied(relPath) {
  if (DENY_EXCEPTIONS.has(relPath)) return false;
  return relPath.split(sep).some((seg) => DENY.has(seg) || DENY_PATTERNS.some((re) => re.test(seg)));
}

/**
 * Recursive copy, source -> runtime.
 * Symlinks are refused. Dereferencing a harmless-looking in-tree link can copy a denied secret
 * (for example `.agents/subagents/leak.md -> ../../.env`) under the link's allowed destination
 * name, while preserving a link would bind the runtime back to its source checkout.
 * Returns the number of files written.
 */
export function copyTree(srcAbs, dstAbs, { relBase = "", onSkip = null, keep = null } = {}) {
  let st;
  try { st = lstatSync(srcAbs); } catch { return 0; }

  if (st.isSymbolicLink()) {
    const shown = relBase || basename(srcAbs);
    throw new Error(`inherit: refusing symlink in copy surface: ${shown}`);
  }

  if (st.isFile()) {
    mkdirp(dirname(dstAbs));
    copyFileSync(srcAbs, dstAbs);
    if (st.mode & 0o111) {
      try { chmodSync(dstAbs, st.mode & 0o777); } catch { /* best effort */ }
    }
    return 1;
  }

  if (!st.isDirectory()) return 0;   // socket/fifo/device — nothing to inherit

  mkdirp(dstAbs);
  let count = 0;
  for (const entry of readdirSync(srcAbs).sort()) {
    const rel = relBase ? join(relBase, entry) : entry;
    if (isDenied(rel)) {
      if (onSkip) onSkip(rel);
      continue;
    }
    // `keep` is the ownership gate (agent/command surfaces). It is asked about DIRECTORIES too, so a
    // whole family folder is refused in one decision rather than file by file.
    if (keep && !keep(rel)) {
      if (onSkip) onSkip(rel);
      continue;
    }
    count += copyTree(join(srcAbs, entry), join(dstAbs, entry), { relBase: rel, onSkip, keep });
  }
  return count;
}

// ---------------------------------------------------------------------------
// Skill resolution — active set first, then the offloaded archive
// ---------------------------------------------------------------------------

/**
 * Locate a skill by name in the source repo.
 * Offloaded skills (.sidekicks/skill-offloaded/<name>/) are eligible: pulling one into a
 * runtime REACTIVATES it there without restoring it in the source repo.
 * @returns {{name:string, dir:string, origin:"active"|"offloaded"}|null}
 */
function resolveSkill(repoRoot, name) {
  const active = join(repoRoot, '.agents', 'skills', name);
  if (existsSync(join(active, "SKILL.md"))) return { name, dir: active, origin: "active" };
  const off = join(repoRoot, ".sidekicks", "skill-offloaded", name);
  if (existsSync(join(off, "SKILL.md"))) return { name, dir: off, origin: "offloaded" };
  return null;
}

function listAvailableSkills(repoRoot) {
  const res = { active: [], offloaded: [] };
  for (const [key, sub] of [["active", "skills"], ["offloaded", "skill-offloaded"]]) {
    const dir = join(repoRoot, ".sidekicks", sub);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir).sort()) {
      if (existsSync(join(dir, e, "SKILL.md"))) res[key].push(e);
    }
  }
  return res;
}

function skillVersion(skillDir) {
  const vf = join(skillDir, "VERSION.json");
  if (!existsSync(vf)) return null;
  try { return JSON.parse(readFileSync(vf, "utf8")).version ?? null; } catch { return null; }
}

/**
 * Skills this skill DECLARES it needs, from its SKILL.md frontmatter:
 *
 *     sidekicks:
 *       depends-on:
 *         - skill:sk-bmad-epic-tech-context
 *
 * This is the only machine-readable dependency statement in the repo, and it is authoritative in a
 * way the substring scan below can never be: the author wrote it. `sidekicks` itself is dropped —
 * it names the CLI substrate (always copied), not an inheritable skill directory.
 * @returns {string[]}
 */
function declaredDependencies(skillDir) {
  const f = join(skillDir, "SKILL.md");
  if (!existsSync(f)) return [];
  let text;
  try { text = readFileSync(f, "utf8"); } catch { return []; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return [];

  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*depends-on:\s*$/.test(l));
  if (start === -1) return [];

  const deps = [];
  for (let i = start + 1; i < lines.length; i++) {
    const item = /^\s*-\s*(?:skill:)?([A-Za-z0-9._-]+)\s*$/.exec(lines[i]);
    if (!item) break;                      // list ends at the first non-item line
    if (item[1] !== "sidekicks") deps.push(item[1]);
  }
  return [...new Set(deps)].sort();
}

/**
 * Strip comments and docstrings, so a name found in the remainder is found in actual code.
 *
 * Bundled scripts routinely record their provenance in a header comment — "Adapted from
 * `sk-image-generator/scripts/scope.py`", "mirrors confluence_client.py" — and the raw scan
 * reported those as wiring, pushing an unrelated skill into every runtime that copies the file.
 *
 * This is used to SPLIT the hits, never to discard them: measured across the whole registry,
 * stripping removes 49 edges and many are real (`sk-auto-improve -> sk-self-improve`
 * is stated only in prose inside a script). So a comment-only hit is reported on its own line
 * rather than dropped — lower confidence, still shown.
 */
function stripComments(text, file) {
  if (/\.py$/i.test(file)) {
    return text
      .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, " ")
      .replace(/(^|\s)#[^\n]*/g, "$1");
  }
  if (/\.(mjs|js|ts|json)$/i.test(file)) {
    return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  }
  if (/\.(sh|ya?ml|toml)$/i.test(file)) {
    return text.replace(/(^|\s)#[^\n]*/g, "$1");
  }
  return text;
}

/**
 * Other skill names this skill names, split by how load-bearing the mention is.
 *
 * The scan is a substring match, so prose counts as a hit — a SKILL.md that merely says
 * "see also sidekicks-foo" is not a dependency. Hits are therefore tiered:
 *   - `wired`       — the name appears in CODE under the skill's `scripts/` directory (comments
 *                     and docstrings removed). Executable code points at it, so leaving it out of
 *                     the runtime plausibly breaks this skill.
 *   - `codeComment` — the name appears under `scripts/` but only inside a comment or docstring.
 *                     Often a real invocation described in prose, often bare provenance
 *                     ("adapted from X/scripts/scope.py"). Shown, but not asserted as wiring.
 *   - `mentioned`   — the name appears anywhere else (SKILL.md prose, assets/, references/).
 *                     Informational, `--verbose` only.
 *
 * `assets/` is deliberately NOT wired: assets are templates and data, and a catalogue asset that
 * legitimately lists many skill names (this skill's own presets.yaml, an audit-groups file) would
 * otherwise report every entry as a broken dependency.
 * @returns {{wired:string[], codeComment:string[], mentioned:string[]}}
 */
function referencedSkills(skillDir, universe) {
  const wired = new Set();
  const codeComment = new Set();
  const mentioned = new Set();
  const self = basename(skillDir);

  const scan = (dir, inBundle) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory()) { scan(p, inBundle || e === "scripts"); continue; }
      if (!st.isFile() || !/\.(md|mjs|js|sh|py|ya?ml|json|txt|toml)$/i.test(e)) continue;
      let text;
      try { text = readFileSync(p, "utf8"); } catch { continue; }
      if (!inBundle) {
        for (const cand of universe) {
          if (cand !== self && text.includes(cand)) mentioned.add(cand);
        }
        continue;
      }
      const code = stripComments(text, e);
      for (const cand of universe) {
        if (cand === self || !text.includes(cand)) continue;
        (code.includes(cand) ? wired : codeComment).add(cand);
      }
    }
  };
  scan(skillDir, false);

  for (const w of wired) { codeComment.delete(w); mentioned.delete(w); }   // wired is strongest
  for (const c of codeComment) mentioned.delete(c);
  return {
    wired: [...wired].sort(),
    codeComment: [...codeComment].sort(),
    mentioned: [...mentioned].sort(),
  };
}

// ---------------------------------------------------------------------------
// Delegate agents — .sidekicks/agents/<name>/, selected one by one
// ---------------------------------------------------------------------------

function delegatesRoot(repoRoot) {
  return join(repoRoot, ".sidekicks", DELEGATES_DIRNAME);
}

/**
 * Locate a delegate agent by name in the source repo.
 * A directory is an agent only when it carries agent.yaml — .bridge/ never qualifies.
 * @returns {{name:string, dir:string}|null}
 */
function resolveDelegate(repoRoot, name) {
  if (name === BRIDGE_DIRNAME) return null;
  const dir = join(delegatesRoot(repoRoot), name);
  return existsSync(join(dir, "agent.yaml")) ? { name, dir } : null;
}

/** Every inheritable delegate agent in the source repo, sorted. */
function listAvailableDelegates(repoRoot) {
  const root = delegatesRoot(repoRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().filter((e) => e !== BRIDGE_DIRNAME
    && existsSync(join(root, e, "agent.yaml")));
}

/**
 * Hashes of an agent's INHERITED surface only — charter, routines, and memory when it travelled.
 *
 * Deliberately not hashTree(agentDir): a live runtime writes runtime/ (presence, mailbox, threads)
 * and, once the agent runs, memory/ too. Hashing the whole directory would report every agent as
 * locally modified on the first drift check. Both sides of the comparison use this function, so the
 * baseline and the runtime are measured the same way.
 */
function hashDelegateSurface(agentDir, includeMemory) {
  const map = {};
  const surfaces = includeMemory ? [...DELEGATE_SURFACES, DELEGATE_MEMORY_DIR] : DELEGATE_SURFACES;
  for (const rel of surfaces) {
    const abs = join(agentDir, rel);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isFile()) { map[rel] = hashFile(abs); continue; }
    if (!st.isDirectory()) continue;
    for (const [k, v] of Object.entries(hashTree(abs))) map[`${rel}/${k}`] = v;
  }
  return map;
}

/** Charter `default_work_dir`, or "" — a value points at the SOURCE repo's layout, not the runtime's. */
function delegateWorkDir(agentDir) {
  const f = join(agentDir, "agent.yaml");
  if (!existsSync(f)) return "";
  let text;
  try { text = readFileSync(f, "utf8"); } catch { return ""; }
  const m = /^default_work_dir:\s*(.*)$/m.exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * Minimal line-oriented parse of assets/presets.yaml.
 *
 * Two shapes, both supported so existing presets keep working verbatim:
 *   name:              # flat — every item is a skill
 *     - skill
 *   name:              # sectioned — skills and delegate agents named separately
 *     skills:
 *       - skill
 *     delegates:
 *       - agent
 * @returns {Record<string,{skills:string[], delegates:string[]}>}
 */
function loadPresetFile() {
  const f = join(ASSETS, "presets.yaml");
  if (!existsSync(f)) return {};
  const presets = {};
  let current = null;
  let section = "skills";
  for (const raw of readFileSync(f, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const head = line.match(/^([A-Za-z0-9._-]+):\s*$/);
    if (head) {
      current = head[1];
      section = "skills";
      presets[current] = { skills: [], delegates: [] };
      continue;
    }
    const sub = line.match(/^\s+(skills|delegates):\s*$/);
    if (sub && current) { section = sub[1]; continue; }
    const item = line.match(/^\s+-\s+(\S+)\s*$/);
    if (item && current) presets[current][section].push(item[1]);
  }
  return presets;
}

/**
 * The presets an operator may name with --preset.
 *
 * `required:` shares the file's format but is deliberately NOT one of them: it is the floor every
 * runtime carries, so naming it would suggest it is optional and misspelling it would suggest it can
 * be left out. Filtered here rather than at each call site so no verb can accidentally offer it.
 */
function loadPresets() {
  const { [REQUIRED_KEY]: _floor, [HOST_PLUGINS_KEY]: _plugins, ...presets } = loadPresetFile();
  return presets;
}

/**
 * The third-party host plugins a forged runtime is allowed to DECLARE, as `<plugin>@<marketplace>`.
 *
 * The mount contract's "third-party skills are declared, not redistributed" intends the declaration
 * to travel for what the framework USES. Nothing enforced that, so v1.4.4 shipped the source author's
 * whole personal set — `ralph-loop`, `claude-hud` and `slack` alongside `caveman` — into every
 * consumer's `.claude/settings.json`, and `sk-hello --apply` installs each one non-interactively
 * (INC-2026-09-06-06 B-5). This list is the filter.
 *
 * The marketplace half is DERIVED from the `@` suffix rather than listed twice: a marketplace exists
 * in the wiring only to serve a declared plugin, so one that no surviving plugin names is dropped.
 *
 * An absent or empty block means "declare no plugins" — the safe direction for a lifted copy of this
 * skill whose presets.yaml predates the list.
 * @returns {string[]}
 */
function loadHostPlugins() {
  return loadPresetFile()[HOST_PLUGINS_KEY]?.skills ?? [];
}

/**
 * The REQUIRED skill floor — carried by every runtime whatever the operator selected, with no flag
 * to turn it off. See the `required:` block's own comment in assets/presets.yaml for why these four.
 *
 * An absent or empty block is not an error: a lifted copy of this skill whose presets.yaml predates
 * the floor still forges runtimes, it just enforces nothing.
 * @returns {string[]}
 */
function loadRequiredSkills() {
  return loadPresetFile()[REQUIRED_KEY]?.skills ?? [];
}

// ---------------------------------------------------------------------------
// Manifest — the baseline that makes "who changed what" answerable
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Runtime registry — remembers WHERE each runtime lives
// ---------------------------------------------------------------------------
//
// A runtime may sit anywhere: the default runtimes/<name>/, elsewhere in the repo, or entirely
// outside it (a sibling directory, another volume). Without a registry the operator would have to
// re-pass --target on every later drift/patch/add, and `list` could only ever see runtimes/.
//
// Run state, so it lives under the artifacts base (git-ignored), never in .sidekicks/ (Rule 1).
// Paths are stored RELATIVE TO THE REPO ROOT — including the `../..` form for an out-of-tree
// target — because no machine-absolute path may be persisted into an artifact.

// EVERY runtime on this machine shares ONE registry file, and both mutating verbs (`create`'s
// registerRuntime, `forget`) used to be an UNLOCKED read-modify-write ending in a bare
// writeFileSync. Two consequences, both observed:
//   * concurrent runs lost each other's entries, and a reader could see a half-written file;
//   * a parse failure returned {} silently, so the very next write REPLACED a damaged registry
//     with just that one caller's entry — every other runtime gone, with the bytes unrecoverable.
// All three primitives below are written out longhand rather than imported from lib/fs-safety:
// this engine imports node: builtins ONLY (see the header), because a forged runtime carries the
// skill but not necessarily the source tree's lib/.

const REGISTRY_REL = join("artifacts", "runs", "inherit", "runtimes.json");

const REGISTRY_LOCK_RETRIES = 100;
const REGISTRY_LOCK_SLEEP_MS = 20;
const REGISTRY_LOCK_STALE_MS = 10_000;
const CORRUPT_KEEP = 3;

/**
 * Where the registry lives.
 *
 * SIDEKICKS_INHERIT_REGISTRY redirects it. That exists because the inherit tests spawn this
 * engine with `cwd` = the real checkout, so every test run mutated the developer's own
 * registry — and `node --test` running those files in parallel is exactly the race above. The
 * override moves the leaf path only; every verb, lock and atomic write below still runs.
 */
function registryPath(repoRoot) {
  const override = process.env.SIDEKICKS_INHERIT_REGISTRY;
  if (override) return isAbsolute(override) ? override : resolve(process.cwd(), override);
  return join(repoRoot, REGISTRY_REL);
}

/** Diagnostics go to stderr ONLY — stdout is a machine surface (`drift --json`, `list --json`). */
function registryNotice(message) {
  try { process.stderr.write(`NOTICE: inherit registry — ${message}\n`); } catch { /* ignore */ }
}

/** Sleep without a busy-wait: 100 retries × a spin loop would pin a core per waiting process. */
function registrySleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best-effort */ }
}

/**
 * Move a registry we could not parse aside instead of letting the next write erase it.
 *
 * Only ever called by a caller that HOLDS the lock, so two processes never race to rename the
 * same file. mutateRegistry enforces that by passing `quarantine` only when it actually acquired
 * the lock — its proceed-unlocked fallbacks deliberately warn instead, since a rename racing an
 * unknown other writer is the one thing worse than a registry that will not parse.
 */
function quarantineCorruptRegistry(p) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const kept = join(dirname(p), `runtimes.corrupt-${stamp}.json`);
  try {
    renameSync(p, kept);
    registryNotice(`could not parse '${p}'; preserved as '${basename(kept)}' and starting a new registry`);
  } catch (err) {
    registryNotice(`could not parse '${p}' and could not preserve it (${err.code || err.message})`);
    return;
  }
  // Keep the newest few so a repeatedly-broken registry cannot fill the artifacts tree.
  try {
    const olds = readdirSync(dirname(p))
      .filter((f) => /^runtimes\.corrupt-.*\.json$/.test(f))
      .sort()
      .reverse()
      .slice(CORRUPT_KEEP);
    for (const f of olds) rmSync(join(dirname(p), f), { force: true });
  } catch { /* pruning is housekeeping, never a failure */ }
}

function readRegistry(repoRoot, { quarantine = false } = {}) {
  const p = registryPath(repoRoot);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed.runtimes === "object" ? parsed.runtimes : {};
  } catch {
    // A corrupt registry must never block a run — but it must never be silently discarded
    // either. Read-only callers just warn; only a mutation (under the lock) moves it aside.
    if (quarantine) quarantineCorruptRegistry(p);
    else registryNotice(`could not parse '${p}' — treating it as empty for this read only`);
    return {};
  }
}

/** Temp-file-then-rename, so no reader ever sees a partially written registry. */
function writeRegistry(repoRoot, runtimes) {
  const p = registryPath(repoRoot);
  mkdirp(dirname(p));
  const body = `${JSON.stringify({
    schema: SCHEMA,
    comment: "Where each inherited runtime lives. Paths are repo-root-relative (portable-paths rule).",
    runtimes,
  }, null, 2)}\n`;
  const tmp = join(dirname(p), `.runtimes-tmp-${process.pid}-${randomBytes(6).toString("hex")}.json`);
  try {
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, p);   // atomic replace on POSIX and on Windows (MoveFileEx REPLACE_EXISTING)
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * The ONE read-modify-write funnel for the registry. `fn` mutates the runtimes map and returns
 * whether anything changed.
 *
 * On lock-budget exhaustion this PROCEEDS, loudly. Skipping would be wrong — registration is the
 * user-visible outcome of `create` — and blocking forever contradicts "a corrupt registry must
 * never block a run". Two seconds is far beyond the few milliseconds the critical section takes,
 * and because the write is atomic now, the worst case degrades from a torn file to one lost
 * entry, recoverable by re-passing --target once.
 */
function mutateRegistry(repoRoot, fn) {
  const lockPath = `${registryPath(repoRoot)}.lock`;
  mkdirp(dirname(lockPath));
  let fd = null;
  for (let attempt = 0; attempt <= REGISTRY_LOCK_RETRIES && fd === null; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") {
        registryNotice(`cannot create the lock (${err.code || err.message}) — proceeding unlocked`);
        break;
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > REGISTRY_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch { /* it vanished under us — retry */ }
      if (attempt === REGISTRY_LOCK_RETRIES) {
        registryNotice("another process has held the lock for over 2s — proceeding unlocked");
        break;
      }
      registrySleep(REGISTRY_LOCK_SLEEP_MS);
    }
  }
  try {
    // Re-read INSIDE the lock: a snapshot taken before acquiring it is exactly the stale read
    // that loses another process's entry. Quarantine only when the lock was actually acquired
    // (see quarantineCorruptRegistry) — unlocked, a warning is the honest ceiling.
    const runtimes = readRegistry(repoRoot, { quarantine: fd !== null });
    const changed = fn(runtimes);
    if (changed) writeRegistry(repoRoot, runtimes);
    return changed;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
      try { rmSync(lockPath, { force: true }); } catch { /* stale-reclaim covers a failed unlink */ }
    }
  }
}

function registerRuntime(repoRoot, name, dir) {
  mutateRegistry(repoRoot, (runtimes) => {
    runtimes[name] = {
      path_rel: relative(repoRoot, dir).split(sep).join("/"),
      outside_repo: !isInsideRepo(repoRoot, dir),
      registered_at: nowBangkok(),
    };
    return true;
  });
}

function forgetRuntime(repoRoot, name) {
  return mutateRegistry(repoRoot, (runtimes) => {
    if (!(name in runtimes)) return false;
    delete runtimes[name];
    return true;
  });
}

/** Registered location for `name`, or null. */
function lookupRuntime(repoRoot, name) {
  const rec = readRegistry(repoRoot)[name];
  if (!rec?.path_rel) return null;
  return resolve(repoRoot, rec.path_rel);
}

function isInsideRepo(repoRoot, dir) {
  const rel = relative(repoRoot, dir);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

/** True when the runtime sits in the conventional runtimes/ folder of this repo. */
function isInRuntimesDir(repoRoot, dir) {
  const rel = relative(join(repoRoot, "runtimes"), dir);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Manifest — the baseline that makes "who changed what" answerable
// ---------------------------------------------------------------------------

function manifestPath(runtimeRoot) { return join(runtimeRoot, MANIFEST_REL); }

function readManifest(runtimeRoot) {
  const p = manifestPath(runtimeRoot);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) {
    die(`runtime manifest is unreadable (${p}): ${e.message}`, 3);
  }
}

function writeManifest(runtimeRoot, m) {
  mkdirp(dirname(manifestPath(runtimeRoot)));
  writeFileSync(manifestPath(runtimeRoot), `${JSON.stringify(m, null, 2)}\n`, "utf8");
}

function requireManifest(runtimeRoot, name) {
  const m = readManifest(runtimeRoot);
  if (!m) die(`no ${MANIFEST_REL} in ${runtimeRoot} — '${name}' is not an inherited runtime (run 'create' first)`, 3);
  return m;
}

/**
 * Adopt a runtime into the registry when a verb was pointed at it explicitly.
 * Makes "choose any location" sticky from ANY entry point: pass --target once — to a runtime this
 * repo forged elsewhere, or one someone else did — and every later verb finds it by name alone.
 * Only runs for a confirmed runtime (the caller has already required its manifest).
 *
 * `quiet` suppresses the NOTICE, never the adoption: `drift --json` must keep stdout byte-pure for
 * its caller's JSON.parse, but skipping the registry write itself would make --json the one entry
 * point where "pass --target once" silently does not stick, so a later `patch --name N` resolves to
 * runtimes/<name>/ instead. registerRuntime() emits nothing, so gating these two out() calls is the
 * whole of the stdout contract.
 */
function adoptIfTargeted(repoRoot, name, dir, resolvedFrom, { quiet = false } = {}) {
  if (resolvedFrom !== "flag") return;
  const known = lookupRuntime(repoRoot, name);
  if (known && resolve(known) === resolve(dir)) return;   // already registered at this location
  registerRuntime(repoRoot, name, dir);
  if (quiet) return;
  out(`registry: '${name}' now points at ${displayPath(repoRoot, dir)} — later verbs need only --name`);
  out("");
}

function skillUnitRecord(repoRoot, found, runtimeSkillDir, sourceCommit) {
  return {
    kind: "skill",
    origin: found.origin,
    version: skillVersion(found.dir),
    source_path: relative(repoRoot, found.dir).split(sep).join("/"),   // repo-relative, portable
    source_commit: sourceCommit,
    inherited_at: nowBangkok(),
    files: hashTree(runtimeSkillDir),
  };
}

function trackedSkills(manifest) {
  return Object.keys(manifest.units ?? {})
    .filter((k) => k.startsWith("skills/"))
    .map((k) => k.slice("skills/".length));
}

/**
 * Manifest unit for one delegate agent. `include_memory` is recorded, not inferred: the drift
 * baseline covers whichever surface actually travelled, so a later run must know which that was.
 */
function delegateUnitRecord(repoRoot, found, runtimeAgentDir, sourceCommit, includeMemory) {
  return {
    kind: "agent",
    source_path: relative(repoRoot, found.dir).split(sep).join("/"),   // repo-relative, portable
    source_commit: sourceCommit,
    inherited_at: nowBangkok(),
    include_memory: Boolean(includeMemory),
    files: hashDelegateSurface(runtimeAgentDir, includeMemory),
  };
}

function trackedDelegates(manifest) {
  return Object.keys(manifest.units ?? {})
    .filter((k) => k.startsWith("agents/"))
    .map((k) => k.slice("agents/".length));
}

/**
 * "The runtime holds agents" — tracked by the manifest UNION physically present on disk.
 *
 * The manifest alone is not that question. `create --force` rebuilds a manifest with `units: {}`
 * and does NOT delete unselected agents (that needs --prune-delegates), so a re-forge which omits
 * --delegates leaves charters on disk with nothing tracking them; an agent created inside the
 * runtime is never tracked at all. Both cases still need the scripts that START and SUPERVISE an
 * agent, so every gate on "carries agents" — the ops-script claim, cmdVerify's check 10, cmdAdd's
 * stale-surface fallback — reads this, not trackedDelegates().
 * @returns {Set<string>}
 */
function presentDelegates(runtimeRoot, manifest) {
  const present = new Set(trackedDelegates(manifest));
  const dir = join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME);
  if (existsSync(dir)) {
    for (const e of readdirSync(dir).sort()) {
      if (e !== BRIDGE_DIRNAME && existsSync(join(dir, e, "agent.yaml"))) present.add(e);
    }
  }
  return present;
}

// ---------------------------------------------------------------------------
// Python dependency resolution — fresh, minimal, version-pinned venv
// ---------------------------------------------------------------------------

function loadJsonAsset(file, fallback) {
  const p = join(ASSETS, file);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}

function pythonExe() {
  for (const cand of isWindows ? ["python", "python3"] : ["python3", "python"]) {
    if (spawnSync(cand, ["--version"], { encoding: "utf8" }).status === 0) return cand;
  }
  return null;
}

/** Interpreter stdlib names, straight from the interpreter when it can tell us (py>=3.10). */
function stdlibNames(py) {
  if (py) {
    const r = spawnSync(py, ["-c",
      "import sys,json;print(json.dumps(sorted(getattr(sys,'stdlib_module_names',()))))"],
      { encoding: "utf8" });
    if (r.status === 0) {
      try {
        const arr = JSON.parse(r.stdout);
        if (Array.isArray(arr) && arr.length) return new Set(arr);
      } catch { /* fall through to the bundled list */ }
    }
  }
  return new Set(loadJsonAsset("py-stdlib.json", []));
}

/** Top-level module names imported by every .py file under the given dirs. */
function scanPythonImports(dirs) {
  const modules = new Map();    // module -> Set(file)
  const localNames = new Set(); // sibling .py modules / packages living inside the skills
  const pyFiles = [];

  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir).sort()) {
      const p = join(dir, e);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (e === "__pycache__" || e === ".venv") continue;
        if (existsSync(join(p, "__init__.py"))) localNames.add(e);
        walk(p);
      } else if (e.endsWith(".py")) {
        pyFiles.push(p);
        localNames.add(e.slice(0, -3));
      }
    }
  };
  for (const d of dirs) walk(d);

  const importRe = /^\s*(?:import\s+([A-Za-z_][\w.]*)|from\s+([A-Za-z_][\w.]*)\s+import)/;
  for (const f of pyFiles) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = importRe.exec(line);
      if (!m) continue;
      const top = (m[1] ?? m[2]).split(".")[0];
      if (!top || top === "__future__") continue;
      if (!modules.has(top)) modules.set(top, new Set());
      modules.get(top).add(f);
    }
  }
  return { modules, localNames };
}

/** `pip freeze` of the SOURCE venv → { normalizedDistName: "Dist==x.y.z" }. */
function sourceFreeze(repoRoot) {
  const pip = join(repoRoot, ".venv", isWindows ? "Scripts" : "bin", isWindows ? "pip.exe" : "pip");
  if (!existsSync(pip)) return {};
  const r = spawnSync(pip, ["freeze"], { encoding: "utf8" });
  if (r.status !== 0) return {};
  const map = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9._-]+)==(.+)$/.exec(line.trim());
    if (m) map[m[1].toLowerCase().replace(/[-_.]+/g, "-")] = `${m[1]}==${m[2]}`;
  }
  return map;
}

/**
 * Resolve the Python requirements for a set of skills.
 * @returns {{ pinned:string[], unpinned:string[], unknown:Array<{module:string,files:string[]}>, skipped:string[] }}
 */
function resolveRequirements(repoRoot, skillDirs) {
  const py = pythonExe();
  const stdlib = stdlibNames(py);
  const modMap = loadJsonAsset("module-distribution.json", {});
  const freeze = sourceFreeze(repoRoot);
  const { modules, localNames } = scanPythonImports(skillDirs);

  const pinned = new Set();
  const unpinned = new Set();
  const unknown = [];
  const skipped = [];

  for (const [mod, files] of [...modules.entries()].sort()) {
    if (stdlib.has(mod)) { skipped.push(`${mod} (stdlib)`); continue; }
    if (localNames.has(mod)) { skipped.push(`${mod} (skill-local)`); continue; }
    const dist = modMap[mod];
    if (dist === null) { skipped.push(`${mod} (mapped to nothing on purpose)`); continue; }
    if (!dist) { unknown.push({ module: mod, files: [...files].slice(0, 3) }); continue; }
    const key = dist.toLowerCase().replace(/[-_.]+/g, "-");
    if (freeze[key]) pinned.add(freeze[key]);
    else unpinned.add(dist);
  }
  return { pinned: [...pinned].sort(), unpinned: [...unpinned].sort(), unknown, skipped: skipped.sort() };
}

function venvBin(runtimeRoot) {
  return join(runtimeRoot, ".venv", isWindows ? "Scripts" : "bin");
}

/**
 * Create the runtime's OWN venv and install the pinned requirements.
 * A venv is never copied: 36 files in the source .venv/bin hardcode its absolute
 * interpreter path in their shebangs, so a copied venv is a broken venv.
 */
function buildVenv(runtimeRoot, reqs, { install = true, force = false } = {}) {
  const lines = [
    "# Generated by sk-inherit — do not hand-edit; re-run `inherit venv` instead.",
    "# Versions are pinned from the source repo's .venv (pip freeze) so the runtime reproduces",
    "# the exact package set its skills were developed against.",
    ...reqs.pinned,
    ...reqs.unpinned,
  ];
  const reqPath = join(runtimeRoot, "requirements.txt");
  const next = `${lines.join("\n")}\n`;
  const prev = existsSync(reqPath) ? readFileSync(reqPath, "utf8") : null;
  writeFileSync(reqPath, next, "utf8");

  if (!install) return { ok: true, installed: false, note: "requirements.txt written; venv not built (--no-venv)" };

  // Nothing to do when the package set is unchanged and the venv is already usable.
  // pip install is the slowest step here; re-running it on every patch buys nothing.
  if (!force && prev === next && existsSync(join(venvBin(runtimeRoot), isWindows ? "pip.exe" : "pip"))) {
    return { ok: true, installed: true, note: "requirements unchanged — venv left as-is" };
  }

  const py = pythonExe();
  if (!py) return { ok: false, installed: false, note: "no python on PATH — requirements.txt written, venv NOT built" };

  const venvDir = join(runtimeRoot, ".venv");
  // Presence of the DIRECTORY is not proof of a venv. An interrupted or failed earlier build leaves an
  // empty .venv/ behind, and skipping creation on that basis produced a runtime that reported
  // "venv created but pip is missing" forever — the directory existed, so it was never rebuilt.
  // The interpreter is the real signal; a venv without one is rubble and gets replaced.
  const venvPython = join(venvBin(runtimeRoot), isWindows ? "python.exe" : "python");
  if (existsSync(venvDir) && !existsSync(venvPython)) {
    rmSync(venvDir, { recursive: true, force: true });
  }
  if (!existsSync(venvDir)) {
    const r = spawnSync(py, ["-m", "venv", venvDir], { encoding: "utf8", stdio: "pipe" });
    if (r.status !== 0) {
      return { ok: false, installed: false, note: `python -m venv failed: ${(r.stderr || "").trim().split("\n").pop()}` };
    }
  }

  const pkgs = [...reqs.pinned, ...reqs.unpinned];
  if (pkgs.length === 0) return { ok: true, installed: true, note: "venv created; no third-party packages needed" };

  const pip = join(venvBin(runtimeRoot), isWindows ? "pip.exe" : "pip");
  if (!existsSync(pip)) return { ok: false, installed: false, note: "venv created but pip is missing" };

  const runPip = () => spawnSync(pip, ["install", "--disable-pip-version-check", "-q", "-r", reqPath],
    { encoding: "utf8", stdio: "pipe" });

  let r = runPip();

  // A pinned version can be absent from PyPI — the source venv may hold a local, pre-release, or
  // withdrawn build (observed: pip freeze reports ImageIO==2.37.3, which PyPI does not serve).
  // pip resolves the whole file at once, so ONE unsatisfiable pin fails EVERY package. Relax only
  // the pins pip names as unsatisfiable and retry, keeping every other version exact.
  const relaxed = [];
  for (let round = 0; r.status !== 0 && round < 5; round++) {
    const blob = `${r.stderr || ""}\n${r.stdout || ""}`;
    const names = [...blob.matchAll(/requirement\s+([A-Za-z0-9._-]+)(?:==|>=|<=)/gi)].map((m) => m[1]);
    const fresh = [...new Set(names)].filter((n) => !relaxed.includes(n));
    if (!fresh.length) break;                       // failure is something else — stop retrying
    relaxed.push(...fresh);

    const norm = (s) => s.toLowerCase().replace(/[-_.]+/g, "-");
    const relaxSet = new Set(relaxed.map(norm));
    const relax = (spec) => {
      const name = spec.split("==")[0];
      return relaxSet.has(norm(name)) ? name : spec;
    };
    writeFileSync(reqPath, `${[
      "# Generated by sk-inherit — do not hand-edit; re-run `inherit venv` instead.",
      "# Versions are pinned from the source repo's .venv (pip freeze).",
      `# UNPINNED (the source venv's version is not available on PyPI): ${relaxed.join(", ")}`,
      ...reqs.pinned.map(relax),
      ...reqs.unpinned,
    ].join("\n")}\n`, "utf8");
    r = runPip();
  }

  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || "").trim().split("\n")
      .filter((l) => /^(ERROR|error:)/.test(l.trim())).slice(0, 2).join(" | ")
      || (r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" | ");
    return { ok: false, installed: false, relaxed, note: `pip install failed (offline?): ${tail}` };
  }
  const note = `installed ${pkgs.length} package(s) into the runtime's own .venv`;
  return relaxed.length
    ? { ok: true, installed: true, relaxed, note: `${note}; UNPINNED ${relaxed.join(", ")} — the source venv's version is not on PyPI, so the runtime got the newest available instead` }
    : { ok: true, installed: true, relaxed, note };
}

// ---------------------------------------------------------------------------
// Generated runtime files
// ---------------------------------------------------------------------------

function renderTemplate(file, vars) {
  const p = join(ASSETS, file);
  if (!existsSync(p)) die(`missing bundled asset: ${file}`, 3);
  let text = readFileSync(p, "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(v);
  return text;
}

// Abbreviations that end in '.' without ending a sentence. Splitting on them truncates a
// description mid-clause ("…git repo (e.g." was the observed failure).
const ABBREV = /(?:e\.g|i\.e|etc|vs|cf|approx|Dr|Mr|Ms|No|Fig|al)\.$/i;

/**
 * One-sentence summary from a skill's frontmatter `description`.
 *
 * The description is commonly a folded/multi-line YAML scalar, so the value is gathered line by
 * line until the next column-0 `key:` — a `$` anchor with the /m flag would stop at the first
 * newline and silently truncate every multi-line description.
 */
function firstLineDescription(skillDir) {
  const f = join(skillDir, "SKILL.md");
  if (!existsSync(f)) return "";
  let text;
  try { text = readFileSync(f, "utf8"); } catch { return ""; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return "";

  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^description:/.test(l));
  if (start === -1) return "";

  const parts = [lines[start].replace(/^description:\s*/, "").replace(/^[|>]-?\s*$/, "")];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z_][\w-]*:/.test(lines[i])) break;   // next frontmatter key at column 0
    parts.push(lines[i]);
  }

  const flat = parts.join(" ").replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "").trim();
  if (!flat) return "";

  // First sentence, skipping abbreviation dots.
  let sentence = flat;
  for (const m of flat.matchAll(/\.\s/g)) {
    const head = flat.slice(0, m.index + 1);
    if (!ABBREV.test(head)) { sentence = head; break; }
  }
  const clean = sentence.replace(/\|/g, "\\|").trim();
  return clean.length > 170 ? `${clean.slice(0, 167)}…` : clean;
}

/** `specialty:` from a delegate charter — the one line worth putting in the runtime's AGENTS.md. */
function delegateSpecialty(agentDir) {
  const f = join(agentDir, "agent.yaml");
  if (!existsSync(f)) return "";
  let text;
  try { text = readFileSync(f, "utf8"); } catch { return ""; }
  const m = /^specialty:\s*(.*)$/m.exec(text);
  if (!m) return "";
  const flat = m[1].trim().replace(/^["']|["']$/g, "").replace(/\|/g, "\\|").trim();
  return flat.length > 170 ? `${flat.slice(0, 167)}…` : flat;
}

/**
 * Minimal AGENTS.md for the runtime, listing only the skills it actually carries — plus the
 * delegate agents, when any travelled. The delegate section renders empty when none did, so a
 * runtime without agents reads exactly as before.
 */
function writeRuntimeAgentsMd(runtimeRoot, { name, skillNames, delegateNames = [], sourceCommit, hasVenv }) {
  const rows = skillNames.map((s) => {
    const desc = firstLineDescription(join(runtimeRoot, '.agents', 'skills', s));
    return `| \`${s}\` | ${desc} |`;
  }).join("\n");

  const agentRows = delegateNames.map((a) => {
    const spec = delegateSpecialty(join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME, a));
    return `| \`${a}\` | ${spec} |`;
  }).join("\n");

  const delegateSection = delegateNames.length ? [
    "",
    "## Delegate agents in this runtime",
    "",
    "| Agent | Specialty |",
    "|---|---|",
    agentRows,
    "",
    `Charters are canonical at \`.sidekicks/${DELEGATES_DIRNAME}/<name>/\` and are reached ONLY through`,
    "the `sidekicks agent` verbs — never by hand-editing the store (Rule 1). Each one arrived with its",
    "charter and routines; their `runtime/` state (presence, control gate, mailbox, threads) and the",
    "shared `.bridge/` are created here on first use and never travelled — so no credential or PID",
    "from the source repo is in this runtime. A charter amended here diverges from the source: the next",
    "sync reports it as a conflict and refuses to overwrite it without `--force`.",
  ].join("\n") : "";

  // AGENTS.min.md.tmpl: it renders AGENTS.md, the canonical instruction file (Rule 6). It shipped as
  // CLAUDE.min.md.tmpl until the instruction surface moved, which left the asset named after a file
  // that is now only a mirror.
  const text = renderTemplate("AGENTS.min.md.tmpl", {
    RUNTIME_NAME: name,
    GENERATED_AT: nowBangkok(),
    SOURCE_COMMIT: sourceCommit,
    // The mount path. AGENTS.framework.md is this same body with a mount preamble prepended, and the
    // body used to describe only the standalone case — so a mounted consumer read a preamble saying
    // "your instructions go in the workspace's AGENTS.md" followed by a body saying "put them in
    // AGENTS.local.md here", in a read-only submodule (INC-2026-09-04-02, N-6). One body, true for
    // both readers: the invariant that AGENTS.framework.md ENDS WITH AGENTS.md is what keeps the two
    // from drifting, and forging a second mount-flavoured body would break it deliberately.
    CORE_DIR: CORE_MOUNT_DIR,
    SKILL_COUNT: String(skillNames.length),
    SKILL_TABLE: rows || "| _(none)_ | |",
    DELEGATE_SECTION: delegateSection,
    // Both branches state rule.single-venv and carry its registry marker verbatim. They differ only
    // in whether the venv is here YET — the rule ("one venv, at the repo root") is the same either
    // way, and making its presence conditional on --no-venv would mean a forged runtime could drop a
    // registered rule with nothing recording that it had.
    PYTHON_SECTION: hasVenv
      ? "- **Python:** the single repo-root `.venv` only — this runtime's own, never another repo's venv, never system Python. All pip installs go there. The package set is pinned in `requirements.txt`."
      : "- **Python:** the single repo-root `.venv` only — this runtime carries none yet, because no "
        + "inherited skill needs one. If one becomes necessary, create it at the WORKSPACE root as "
        + "`.venv` and install everything there — mounted, that is the directory holding "
        + `\`${CORE_MOUNT_DIR}/\`, not this read-only tree; standalone, the two are the same place.`,
  });
  writeFileSync(join(runtimeRoot, "AGENTS.md"), text, "utf8");
}

/** Instruction mirrors for Rule 6. Symlink where possible; copy where symlinks are unavailable. */
function writeInstructionMirrors(runtimeRoot) {
  for (const mirror of ["CLAUDE.md", "GEMINI.md"]) {
    const p = join(runtimeRoot, mirror);
    rmSync(p, { force: true });          // no-op when absent; clears a stale link or copy
    try {
      symlinkSync("AGENTS.md", p, "file");
    } catch {
      copyFileSync(join(runtimeRoot, "AGENTS.md"), p);   // Windows without symlink privilege
    }
  }
}

// ---------------------------------------------------------------------------
// Core distribution
// ---------------------------------------------------------------------------

/**
 * Turn `https://github.com/<owner>/<repo>(.git)` into the raw URL of a file at `ref`.
 * Returns null for any other remote form — a self-hosted GitLab or an ssh remote has no predictable
 * raw URL, and inventing one would put a broken curl command in the README.
 */
function rawGithubUrl(remote, ref, file) {
  if (!remote) return null;
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(remote).trim());
  if (!m) return null;
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${ref}/${file}`;
}

/** The version a target's existing core marker stamps, or null when it carries none. */
function markerVersion(dir) {
  try {
    const marker = JSON.parse(readFileSync(join(dir, CORE_MARKER_REL), "utf8"));
    return typeof marker.version === "string" && marker.version ? marker.version : null;
  } catch {
    return null;
  }
}

/**
 * Is this existing runtime a CORE?
 *
 * `add` has no `--as-core` of its own — it extends whatever is already there — so the question has
 * to be answered from the target rather than the command line. The marker is what every other
 * consumer (both root resolvers, `core init`, the publisher) treats as the answer, so this asks it
 * the same way rather than inventing a second signal.
 */
function isCoreRuntime(dir) {
  return existsSync(join(dir, CORE_MARKER_REL));
}

/** -1 / 0 / 1 over dotted numeric versions; non-numeric parts sort as 0. */
function compareCoreVersions(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The version a core forge stamps must be STATED, and must not go backwards.
 *
 * It used to default to the source repo's package.json, which tracks THIS repo and not the core's
 * own version line — package.json sat at 1.1.0 while the distributed marker was 1.4.1, so a hand
 * forge silently DOWNGRADED every consumer's marker by three minors and then hard-failed the next
 * publish. Requiring the flag removes the silent half of that; the monotonic check removes the
 * other half, because a stated-but-wrong version is the same defect with a witness.
 *
 * @param {string} dir - the target being forged into
 * @param {Record<string, unknown>} flags
 * @returns {string} the validated version
 */
function requireCoreVersion(dir, flags) {
  const stated = flags["core-version"] ? String(flags["core-version"]) : null;
  if (!stated) {
    die(
      "--as-core requires --core-version X.Y.Z.\n" +
        "  Without it the marker would be stamped from this repo's package.json, which tracks the\n" +
        "  REPO and not the core's own version line — that is how a hand forge silently downgrades a\n" +
        "  mounted core's marker.\n" +
        "  Derive it instead:  node scripts/framework-core-publish.mjs publish",
      2
    );
  }
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(stated)) {
    die(`--core-version '${stated}' is not a semver X.Y.Z`, 2);
  }
  const current = markerVersion(dir);
  if (current && compareCoreVersions(stated, current) < 0 && !truthyFlag(flags["force-downgrade"])) {
    die(
      `--core-version ${stated} is LOWER than the ${current} this target already stamps.\n` +
        "  A published core's marker is what consumers pin against, so moving it backwards\n" +
        "  un-publishes work that is already mounted somewhere.\n" +
        "  Cut a higher version, or pass --force-downgrade if the rollback is deliberate.",
      2
    );
  }
  return stated;
}

/**
 * Write the files that make a forged runtime a MOUNTABLE framework core.
 *
 * Must run AFTER writeRuntimeAgentsMd: AGENTS.framework.md is that same generated body with a mount
 * preamble, so a workspace importing it gets exactly the rules the core carries, with no second copy
 * to keep in sync.
 *
 * @returns {{files: string[], notes: string[]}}
 */
/**
 * Blank out the bytes every forge rewrites regardless of what changed.
 *
 * ISO timestamps and git object ids only. Version strings are deliberately NOT masked — a version
 * bump inside a shipped file (a skill's VERSION.json, package.json) is exactly the kind of change a
 * consumer needs to see.
 *
 * @param {string} text
 * @returns {string}
 */
function maskVolatile(text) {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?/g, "<ts>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>");
}

/**
 * Content fingerprint of every regular file under `root`, keyed by forward-slash relative path.
 *
 * Symlinks are skipped: a core's only links are its own exposure links (Rule 3), recreated by its CLI
 * on every run, so they carry no release information and following one would double-count a skill.
 *
 * @param {string} root
 * @returns {{present: boolean, files: Map<string,string>, version: string|null, sourceCommit: string|null}}
 */
function snapshotCoreTree(root) {
  const files = new Map();
  if (!existsSync(root)) return { present: false, files, version: null, sourceCommit: null };

  const walk = (abs, rel) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (DELTA_SKIP_DIRS.has(e.name)) continue;
        walk(join(abs, e.name), childRel);
        continue;
      }
      if (!e.isFile()) continue;
      if (DELTA_SKIP_RELS.has(childRel)) continue;
      if (DELTA_SKIP_PREFIXES.some((p) => childRel.startsWith(p))) continue;
      let buf;
      try { buf = readFileSync(join(abs, e.name)); } catch { continue; }
      const body = TEXTUAL.test(e.name) ? Buffer.from(maskVolatile(buf.toString("utf8")), "utf8") : buf;
      files.set(childRel, createHash("sha256").update(body).digest("hex"));
    }
  };
  walk(root, "");

  let version = null;
  let sourceCommit = null;
  try {
    const marker = JSON.parse(readFileSync(join(root, CORE_MARKER_REL), "utf8"));
    version = marker.version ?? null;
    sourceCommit = marker.source_commit ?? null;
  } catch { /* not a core, or a first forge */ }
  return { present: true, files, version, sourceCommit };
}

/**
 * Group a changed path into the surface a consumer reasons about.
 *
 * @param {string} rel - forward-slash relative path
 * @returns {string}
 */
function deltaSurface(rel) {
  if (rel.startsWith(".agents/skills/")) return `skill \`${rel.split("/")[2]}\``;
  if (rel.startsWith("lib/")) return "`lib/` — framework libraries";
  if (rel.startsWith("scripts/")) return "`scripts/` — hook bodies";
  if (rel.startsWith("bin/")) return "`bin/` — the CLI dispatcher";
  if (rel.startsWith(".sidekicks/agent-packs/")) return "agent packs";
  if (rel.startsWith(".sidekicks/")) return "`.sidekicks/` — rules, config, settings";
  if (/^\.(claude|codex|gemini|agent|agents)\//.test(rel)) return "per-CLI wiring (Rule 6)";
  if (rel.startsWith(".githooks/")) return "`.githooks/` — git hooks";
  if (rel.startsWith("docs/") || rel === "AGENTS.local.md") return "docs";
  if (rel === "AGENTS.md" || rel === CORE_INSTRUCTION_DOC || rel === CORE_INSTRUCTION_DOC_LEGACY) return "instructions";
  if (rel === "install.sh" || rel === "install.ps1") return "installers";
  if (/^(package\.json|requirements\.txt|\.gitignore|\.gitattributes)$/.test(rel)) return "packaging";
  return "other";
}

/**
 * Diff the destination's pre-forge snapshot against what was just written into it.
 *
 * @param {{present: boolean, files: Map<string,string>, version: string|null, sourceCommit: string|null}} before
 * @param {{files: Map<string,string>}} after
 * @returns {{first: boolean, prevVersion: string|null, prevCommit: string|null, added: string[], removed: string[], changed: string[], surfaces: Array<{surface: string, added: number, changed: number, removed: number}>, skillsAdded: string[], skillsRemoved: string[]}}
 */
function coreReleaseDelta(before, after) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [rel, hash] of after.files) {
    if (!before.files.has(rel)) added.push(rel);
    else if (before.files.get(rel) !== hash) changed.push(rel);
  }
  for (const rel of before.files.keys()) if (!after.files.has(rel)) removed.push(rel);

  const skillNames = (list) => [...new Set(
    list.filter((r) => r.startsWith(".agents/skills/")).map((r) => r.split("/")[2]),
  )].sort();
  const before_ = skillNames([...before.files.keys()]);
  const after_ = skillNames([...after.files.keys()]);

  const tally = new Map();
  const bump = (rel, key) => {
    const s = deltaSurface(rel);
    if (!tally.has(s)) tally.set(s, { surface: s, added: 0, changed: 0, removed: 0 });
    tally.get(s)[key] += 1;
  };
  for (const r of added) bump(r, "added");
  for (const r of changed) bump(r, "changed");
  for (const r of removed) bump(r, "removed");

  const surfaces = [...tally.values()].sort((a, b) =>
    (b.added + b.changed + b.removed) - (a.added + a.changed + a.removed) || a.surface.localeCompare(b.surface));

  return {
    first: !before.present || before.files.size === 0,
    prevVersion: before.version,
    prevCommit: before.sourceCommit,
    added, changed, removed, surfaces,
    skillsAdded: after_.filter((s) => !before_.includes(s)),
    skillsRemoved: before_.filter((s) => !after_.includes(s)),
  };
}

/**
 * The README's `## Changes in this release` body, rendered from the delta.
 *
 * @param {ReturnType<typeof coreReleaseDelta>} d
 * @param {{version: string, sourceCommit: string, total: number}} ctx
 * @returns {string}
 */
function renderReleaseChanges(d, ctx) {
  const lines = ["## Changes in this release", ""];
  if (d.first) {
    lines.push(
      `**v${ctx.version} is the first release forged into this repository** — all ${ctx.total} shipped`,
      `file(s) are new. Source commit \`${ctx.sourceCommit}\`.`,
    );
    return lines.join("\n") + "\n";
  }

  const prev = d.prevVersion ? `**v${d.prevVersion}**` : "the previous release";
  lines.push(
    `Forged from source commit \`${ctx.sourceCommit}\`, over ${prev}`
    + `${d.prevCommit ? ` (\`${d.prevCommit}\`)` : ""}.`,
    "",
  );

  if (!d.added.length && !d.changed.length && !d.removed.length) {
    lines.push(
      "**No shipped file changed.** Only the generated headers differ — the forge timestamp and the",
      "recorded source commit. Updating to this release changes nothing you can observe.",
    );
    return lines.join("\n") + "\n";
  }

  lines.push(
    `${d.added.length} added · ${d.changed.length} changed · ${d.removed.length} removed`
    + " (generated headers masked, so only real content counts):",
    "",
    "| Surface | Added | Changed | Removed |",
    "|---|---:|---:|---:|",
  );
  for (const s of d.surfaces) lines.push(`| ${s.surface} | ${s.added} | ${s.changed} | ${s.removed} |`);

  if (d.skillsAdded.length || d.skillsRemoved.length) {
    lines.push("");
    if (d.skillsAdded.length) lines.push(`Skills added: ${d.skillsAdded.map((s) => `\`${s}\``).join(", ")}.`);
    if (d.skillsRemoved.length) {
      lines.push(
        `Skills **removed**: ${d.skillsRemoved.map((s) => `\`${s}\``).join(", ")} — a workspace that`,
        "invokes one of them loses it at `core update`.",
      );
    }
  }
  lines.push(
    "",
    "> This table is derived by comparing the forged tree against what this repository held before the",
    "> forge, not written by hand. A surface absent from it did not change.",
  );
  return lines.join("\n") + "\n";
}

/**
 * Render the core README. Called at the END of a forge, once every file it describes is on disk.
 *
 * Separated from writeCoreDistribution on purpose: the hook-wiring prune and the runtime's own index
 * rebuild both run after that function returns, so a README rendered inside it would compare the
 * destination against a tree that was still being written and report the prune as a change every time.
 *
 * @param {string} runtimeRoot
 * @param {Record<string,string>} vars - the template vars writeCoreDistribution resolved
 * @param {ReturnType<typeof snapshotCoreTree>} before - the destination as it was BEFORE the forge
 * @returns {{delta: ReturnType<typeof coreReleaseDelta>, total: number}}
 */
function writeCoreReadme(runtimeRoot, vars, before) {
  const after = snapshotCoreTree(runtimeRoot);
  const delta = coreReleaseDelta(before, after);
  const releaseChanges = renderReleaseChanges(delta, {
    version: vars.CORE_VERSION,
    sourceCommit: vars.SOURCE_COMMIT,
    total: after.files.size,
  });
  writeFileSync(
    join(runtimeRoot, "README.md"),
    renderTemplate("core-readme.md.tmpl", { ...vars, RELEASE_CHANGES: releaseChanges.trimEnd() }),
    "utf8",
  );
  return { delta, total: after.files.size };
}

function writeCoreDistribution(repoRoot, runtimeRoot, opts) {
  const { name, sourceCommit, skillCount, remote, ref, version } = opts;
  const files = [];
  const notes = [];

  // ── The marker ─────────────────────────────────────────────────────────────────────────────────
  writeFileSync(join(runtimeRoot, CORE_MARKER_REL), `${JSON.stringify({
    schema: 1,
    name,
    version,
    layout: CORE_LAYOUT,
    forged_at: nowBangkok(),
    source_commit: sourceCommit,
  }, null, 2)}\n`, "utf8");
  files.push(`${CORE_MARKER_REL} — the mount marker (both root resolvers walk past a core)`);

  // ── The framework instruction surface a workspace imports ──────────────────────────────────────
  const agentsMd = join(runtimeRoot, "AGENTS.md");
  if (existsSync(agentsMd)) {
    const body = readFileSync(agentsMd, "utf8");
    // The preamble is where the MOUNT is described, because the body below it is the core's own
    // AGENTS.md and speaks for a standalone runtime — "a runtime has no `projects/` tree unless one
    // is created", "skills are canonical at `.agents/skills/`", and no mention at all of the
    // subagents, agent pack, plugin declarations or README that ship in the same tarball. A reader
    // who takes that literally in a mounted workspace is wrong about five things at once
    // (INC-2026-09-06-06 B-4). Correcting it HERE rather than forking the body keeps the invariant
    // cmdVerify depends on: AGENTS.framework.md ends with AGENTS.md, byte for byte.
    const preamble = [
      "<!-- GENERATED by sk-inherit. Do not edit: the next forge overwrites it. -->",
      "",
      "> **This is the framework's instruction surface.** A workspace that mounts this core at",
      `> \`${CORE_MOUNT_DIR}/\` imports this file from its own \`AGENTS.md\` (a managed block written by`,
      "> `sidekicks core init`), so these rules follow whichever framework version the workspace is",
      "> pinned to. Workspace-specific instructions belong in that `AGENTS.md`, below the block —",
      "> `sidekicks core update` never touches them.",
      "",
      "## Reading this in a mounted workspace",
      "",
      "Everything below the rule is the framework's own instruction file, written from the point of",
      "view of a standalone runtime. Five things read differently where you are:",
      "",
      "- **You have a `projects/` tree.** `core init` creates it, and the root project is the",
      "  workspace itself, so the active scope is the root scope until you run `project create`.",
      "  Rules 1–2 still hold exactly as stated — `projects/` is CLI-mediated, never `mkdir`.",
      `- **Your skills are links.** The entries under \`.agents/skills/\` point into \`${CORE_MOUNT_DIR}/\`, so`,
      "  they are read-only and travel with the pinned version. A REAL directory of the same name",
      "  beside them shadows the core's copy — that is how you override or extend one.",
      `- **The CLI, the hook scripts and \`lib/\` are inside \`${CORE_MOUNT_DIR}/\`.** Your workspace has no`,
      "  root `scripts/`; `bin/sidekicks` is a shim, and every wired hook path routes through the mount.",
      "- **Subagents and an agent pack shipped with the core.** `.agents/subagents/` is canonical,",
      "  with generated `.claude/agents/`, `.codex/agents/`, `.gemini/agents/`, and `.agents/plugins/sidekicks-agents/` ports;",
      "  `sidekicks agent pack list` shows the packs, which are shipped but not installed.",
      "- **Third-party plugins are DECLARED, never redistributed.** `.claude/settings.json` names them",
      "  and their marketplaces; nothing is installed until you run `sk-hello --apply`.",
      "",
      `Full reference for the mount itself: \`${CORE_MOUNT_DIR}/README.md\`.`,
      "",
      "---",
      "",
    ].join("\n");
    writeFileSync(join(runtimeRoot, CORE_INSTRUCTION_DOC), preamble + body, "utf8");
    files.push(`${CORE_INSTRUCTION_DOC} — the rules a mounted workspace imports (AAP-106)`);
    // A core forged before the rename shipped this body as CLAUDE.framework.md, and a re-forge over
    // that tree would leave the old name behind as a second, drifting copy of the same rules. Drop
    // it: workspaces pinned to the old core still read their own pinned checkout, and any workspace
    // moving to this one has its import line healed by `core init` / `core update`.
    const legacyDoc = join(runtimeRoot, "CLAUDE.framework.md");
    if (existsSync(legacyDoc)) {
      rmSync(legacyDoc, { force: true });
      notes.push("removed the pre-rename CLAUDE.framework.md — AGENTS.framework.md replaces it");
    }
  } else {
    notes.push(`AGENTS.md was not generated, so ${CORE_INSTRUCTION_DOC} was skipped`);
  }

  // ── The installers ─────────────────────────────────────────────────────────────────────────────
  const defaultRef = ref || "main";
  const rawSh = rawGithubUrl(remote, defaultRef, "install.sh");
  const rawPs1 = rawGithubUrl(remote, defaultRef, "install.ps1");
  if (!rawSh) {
    notes.push(
      `${remote ? `remote '${remote}' is not a github.com https URL` : "no --remote was given"} — the `
      + "installer's documented curl URL is a placeholder; the script itself works when run locally"
    );
  }

  const vars = {
    GENERATED_AT: nowBangkok(),
    SOURCE_COMMIT: sourceCommit,
    CORE_DIR: CORE_MOUNT_DIR,
    // The instruction file a mounted workspace imports. Templated rather than written literally so
    // the README can never again document a filename this forge does not ship — the pre-rename
    // README hard-coded CLAUDE.md as the workspace's instruction surface and survived the flip to
    // AGENTS.md unnoticed, telling every reader to edit a symlink.
    FRAMEWORK_DOC: CORE_INSTRUCTION_DOC,
    FRAMEWORK_REMOTE: remote || "<framework-remote>",
    DEFAULT_REF: defaultRef,
    DEFAULT_DIR: "sidekicks",
    RAW_INSTALL_URL: rawSh || "<raw-url-of-install.sh>",
    RAW_INSTALL_PS1_URL: rawPs1 || "<raw-url-of-install.ps1>",
    RUNTIME_NAME: name,
    CORE_VERSION: version,
    // The tag THIS build is. The README's install commands pin it rather than tracking the remote's
    // default branch: a reader who copies the one-liner gets the version the README describes, not
    // whatever main happens to serve. v2.0.0's README documented an install that would have handed
    // the reader v1.1.5, because main had never been pushed (F-12/F-13).
    CORE_TAG: `v${version}`,
    SKILL_COUNT: String(skillCount),
  };

  const sh = join(runtimeRoot, "install.sh");
  writeFileSync(sh, renderTemplate("install.sh.tmpl", vars), "utf8");
  if (!isWindows) { try { chmodSync(sh, 0o755); } catch { /* non-fatal */ } }
  files.push("install.sh — the curl bootstrap (POSIX sh; macOS, Linux, Git Bash)");

  writeFileSync(join(runtimeRoot, "install.ps1"), renderTemplate("install.ps1.tmpl", vars), "utf8");
  files.push("install.ps1 — the PowerShell twin");

  // ── The README, which IS the install documentation ─────────────────────────────────────────────
  // Written LAST, by writeCoreReadme, once the hook prune and the index rebuild have run: it reports
  // what this release changed in the destination, so it can only be rendered against a finished tree.
  files.push("README.md — install / update / uninstall / release delta, regenerated on every forge");

  // ── Agent packs ────────────────────────────────────────────────────────────────────────────────
  // OPTIONAL crews the consumer may install with `sidekicks agent pack install <id>`. They ship
  // inside the core and are NEVER installed for the user: `core init` and `core update` write no
  // agent, and the only thing that creates one is that explicit verb.
  //
  // This is a CORE-DISTRIBUTION surface, not a CORE_SURFACE, so an ordinary forged runtime is
  // unchanged — a runtime is used by the person who forged it and already has whatever agents they
  // want, while a core is consumed by strangers who have none.
  //
  // It does NOT weaken the guarantee that `.sidekicks/agents/` never bulk-copies. That guarantee is
  // structural (`.sidekicks` is not a copy surface, so no walk reaches the folder) and it stands:
  // this copies a DIFFERENT, separately-authored directory whose contents are validated as portable
  // before they may ship. See lib/agent-lifecycle/_pack.mjs.
  const packSrc = join(repoRoot, CORE_PACKS_REL);
  if (existsSync(packSrc)) {
    const packCount = countAgentPacks(packSrc);
    if (packCount > 0) {
      const written = copyTree(packSrc, join(runtimeRoot, CORE_PACKS_REL));
      files.push(`${CORE_PACKS_REL}/ — ${packCount} optional agent pack(s), ${written} file(s); shipped, never auto-installed`);
    } else {
      notes.push(`${CORE_PACKS_REL}/ exists but holds no pack (a pack is a directory with pack.yaml) — none shipped`);
    }
  } else {
    notes.push(`the source repo carries no ${CORE_PACKS_REL}/ — this core ships no agent packs`);
  }

  // ── One version number, not two ────────────────────────────────────────────────────────────────
  // `sidekicks --version` reads the package.json next to the CLI it ran, which in a mounted workspace
  // is the CORE's. writeRuntimeScaffold seeds that at 0.1.0 (and only when absent), so without this a
  // user sees `--version 0.1.0` next to `core status → version 1.1.0` for the same framework.
  const pkgPath = join(runtimeRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.version !== version) {
        pkg.version = version;
        writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
        files.push(`package.json — version stamped to ${version}, matching the marker`);
      }
    } catch {
      notes.push("package.json is unparseable — its version was left alone and may disagree with the marker");
    }
  }

  // `vars` travels out so the README can be rendered after the rest of the forge finishes.
  return { files, notes, vars };
}

// ---------------------------------------------------------------------------
// create / add
// ---------------------------------------------------------------------------

/**
 * Resolve every selected skill BEFORE anything is written.
 * Without this pre-flight, an unresolvable name partway down the list aborts mid-copy and leaves a
 * half-populated runtime on disk. Reports every missing name at once rather than only the first.
 */
function preflightSkills(repoRoot, skillNames, derivedFromPacks = []) {
  const missing = skillNames.filter((n) => !resolveSkill(repoRoot, n));
  if (!missing.length) return;
  // An unresolvable REQUIRED member is not the operator's mistake — they never named it — so it is
  // reported as what it is: the source repo's presets.yaml points at a skill that is not there.
  const required = new Set(loadRequiredSkills());
  // Same reasoning one layer over: a skill the operator never named, pulled in because a shipped
  // agent pack declares it. The defect is the pack manifest, not the command line.
  const fromPacks = new Set(derivedFromPacks);
  const brokenFloor = missing.filter((n) => required.has(n));
  const brokenPacks = missing.filter((n) => !required.has(n) && fromPacks.has(n));
  const typos = missing.filter((n) => !required.has(n) && !fromPacks.has(n));
  const lines = [];
  if (typos.length) {
    lines.push(`${typos.length} skill(s) not found in .agents/skills/ or .sidekicks/skill-offloaded/: ${typos.join(", ")}`);
  }
  if (brokenPacks.length) {
    lines.push(`${brokenPacks.length} skill(s) required by a shipped AGENT PACK are missing from this SOURCE repo: ${brokenPacks.join(", ")}`);
    lines.push("A pack declares the skills its agents need. Fix the pack's requires_skills, import the");
    lines.push("skill into this repo, or forge with --pack-skills none.");
  }
  if (brokenFloor.length) {
    lines.push(`${brokenFloor.length} REQUIRED skill(s) missing from this SOURCE repo: ${brokenFloor.join(", ")}`);
    lines.push("That is a defect in assets/presets.yaml's 'required:' block, not in your selection —");
    lines.push("fix the source repo before forging anything from it.");
  }
  lines.push("Nothing was written. List what is inheritable with the 'skills' verb.");
  die(lines.join("\n         "), 4);
}

function inheritSkills(repoRoot, runtimeRoot, skillNames, {
  sourceCommit, manifest, verbose, reasons = {}, asCore = false,
}) {
  const avail = listAvailableSkills(repoRoot);
  const universe = new Set([...avail.active, ...avail.offloaded]);
  const inherited = [];
  const warnings = [];
  const projectionErrors = [];

  for (const name of skillNames) {
    const found = resolveSkill(repoRoot, name);
    if (!found) die(`skill not found in .agents/skills/ or .sidekicks/skill-offloaded/: ${name}`, 4);

    // The runtime projection decides what of this skill folder travels. A CORE additionally
    // requires a complete source manifest: publication needs a baseline that says which files were
    // carried on purpose, and a directory walk cannot tell that apart from a file gone missing.
    // An ordinary runtime keeps the walk fallback, which is what general skill transport relies on.
    const projection = projectSkillRuntime(found.dir, {
      skill: name,
      requireManifest: asCore,
      deny: (rel) => isDenied(rel.split("/").join(sep)),
    });
    for (const error of projection.errors) projectionErrors.push(error);

    const dst = join(runtimeRoot, '.agents', 'skills', name);
    rmSync(dst, { recursive: true, force: true });
    const files = copySkillProjection(found.dir, dst, projection);

    manifest.units[`skills/${name}`] = skillUnitRecord(repoRoot, found, dst, sourceCommit);
    if (reasons[name]?.length) {
      manifest.units[`skills/${name}`].selection_reasons = [...reasons[name]];
    }
    // Recorded so `drift` can project the SOURCE side the same way without re-deriving policy, and
    // so a release report can say what this skill left behind rather than only what it carried.
    manifest.units[`skills/${name}`].projection = {
      copied_files: projection.counts.copied_files,
      copied_bytes: projection.counts.copied_bytes,
      excluded_files: projection.counts.excluded_files,
      excluded_bytes: projection.counts.excluded_bytes,
      excluded_by_class: projection.counts.by_class,
      derived: Object.keys(projection.derived).sort(),
    };
    inherited.push({
      name, origin: found.origin, files, version: skillVersion(found.dir), projection,
    });

    // Composition warnings, strongest first: an unmet frontmatter `depends-on` is the skill's own
    // statement that it needs another skill, so it is reported separately from the substring scan.
    const unmetDeps = declaredDependencies(found.dir).filter((d) => !skillNames.includes(d));
    if (unmetDeps.length) {
      warnings.push(`${name}: UNMET declared depends-on — ${unmetDeps.join(", ")} (this skill will fail at that step)`);
    }
    // A bundled script/asset points at a skill that is not being inherited.
    // Prose-only mentions are not reported here — too noisy to be actionable.
    const refs = referencedSkills(found.dir, universe);
    const missing = refs.wired.filter((r) => !skillNames.includes(r) && !unmetDeps.includes(r));
    if (missing.length) {
      warnings.push(`${name}: a bundled script names skills not in this runtime — ${missing.join(", ")}`);
    }
    if (verbose) {
      const dropped = projection.counts.excluded_files;
      out(`  + ${name} (${found.origin}, ${files} files`
        + `${dropped ? `, ${dropped} excluded from the runtime` : ""})`);
    }
  }

  // Fail closed, and only after every skill has been examined: a forge that stopped at the first
  // problem would make the operator rediscover the next one on the next run.
  if (projectionErrors.length) {
    die(`runtime projection cannot be composed:\n         `
      + [...new Set(projectionErrors)].sort().join("\n         "), 4);
  }
  return { inherited, warnings };
}

/**
 * Copy exactly the projected files of one skill, writing DERIVED metadata in place of its source.
 *
 * Not `copyTree(found.dir, dst)`: that carries the whole folder, which is how a forged core ended up
 * shipping every skill's improvement funnel and eval fixtures. The projection is also what decides
 * the drift baseline, so copying anything else here would put the two permanently out of step.
 *
 * Symlinks never reach this function — `walkSkillFiles` refuses to return one as a file row, which
 * is the same refusal `copyTree` makes for the same reason (a link would either bind the runtime
 * back to its source checkout or smuggle a denied file in under an allowed name).
 *
 * @returns {number} files written
 */
function copySkillProjection(srcDir, dstDir, projection) {
  let written = 0;
  for (const rel of projection.files) {
    const parts = rel.split("/");
    const dst = join(dstDir, ...parts);
    mkdirp(dirname(dst));
    if (Object.hasOwn(projection.derived, rel)) {
      writeFileSync(dst, projection.derived[rel]);
    } else {
      copyFileSync(join(srcDir, ...parts), dst);
    }
    // The recorded executability baseline is authoritative where it exists; otherwise carry the
    // source bit. A Windows checkout cannot report one, which is why `modes{}` is recorded at all.
    const recorded = projection.modes?.[rel];
    try {
      if (recorded === 755) chmodSync(dst, 0o755);
      else if (recorded === undefined) {
        const st = statSync(join(srcDir, ...parts));
        if (st.mode & 0o111) chmodSync(dst, st.mode & 0o777);
      }
    } catch { /* best effort, exactly as copyTree treats it */ }
    written += 1;
  }
  return written;
}

/**
 * List the skills a runtime carries that are NOT in `skillNames`.
 *
 * Read-only — `plan` uses it to preview what `--prune-skills` would delete, and
 * pruneUnselectedSkills() uses it to decide what to remove. A runtime that does not exist yet
 * (the usual `plan` case) has nothing to prune.
 *
 * A REQUIRED skill is never returned, whatever the caller passed. Callers already hand in the
 * selection with the floor unioned in, so this is belt-and-braces — but the floor's whole claim is
 * that no code path can remove it, and a guard that lives at the one place doing the deleting is
 * what makes that true rather than merely conventional.
 * @returns {string[]} sorted skill directory names
 */
function unselectedSkills(runtimeRoot, skillNames) {
  const dir = join(runtimeRoot, '.agents', 'skills');
  if (!existsSync(dir)) return [];
  const keep = new Set([...skillNames, ...loadRequiredSkills()]);
  const found = [];
  for (const e of readdirSync(dir).sort()) {
    if (keep.has(e)) continue;
    let st;
    try { st = lstatSync(join(dir, e)); } catch { continue; }
    if (st.isDirectory()) found.push(e);
  }
  return found;
}

/**
 * Delete every skill the runtime carries that is not in `skillNames`, and drop its manifest unit.
 *
 * OPT-IN ONLY (`--prune-skills`). A runtime legitimately grows skills that were never inherited —
 * `drift` classifies those `untracked` and never touches them — so an implicit prune would delete
 * an operator's own work. The flag exists for the re-forge case: `create --force --prune-skills`
 * makes the runtime's skill set EXACTLY the selection, which is what a "redo the framework" run
 * needs.
 *
 * Call AFTER inheritSkills(), so the selected units are recorded before the diff is taken.
 * @returns {string[]} removed skill names
 */
function pruneUnselectedSkills(runtimeRoot, manifest, skillNames) {
  const removed = unselectedSkills(runtimeRoot, skillNames);
  for (const name of removed) {
    rmSync(join(runtimeRoot, '.agents', 'skills', name), { recursive: true, force: true });
    delete manifest.units[`skills/${name}`];
  }
  return removed;
}

/**
 * Resolve every selected delegate agent BEFORE anything is written — same reason as
 * preflightSkills(): an unresolvable name must not abort halfway through a copy.
 */
function preflightDelegates(repoRoot, names) {
  const missing = names.filter((n) => !resolveDelegate(repoRoot, n));
  if (missing.length) {
    die([
      `${missing.length} delegate agent(s) not found in .sidekicks/${DELEGATES_DIRNAME}/: ${missing.join(", ")}`,
      "Nothing was written. List what is inheritable with the 'skills' verb.",
    ].join("\n         "), 4);
  }
}

/**
 * Copy each selected delegate agent's inherited surface into the runtime and record its baseline.
 *
 * Surface by surface, never a directory walk of the agent folder: runtime/ must not travel (volatile
 * per-clone state) and memory/ only travels when asked for. An existing runtime copy of a selected
 * agent is replaced, but its runtime/ is left alone — deleting it would kill a live delegate's
 * presence and mailbox in the runtime.
 */
function inheritDelegates(repoRoot, runtimeRoot, names, { sourceCommit, manifest, includeMemory, skillNames }) {
  const inherited = [];
  const warnings = [];
  const surfaces = includeMemory ? [...DELEGATE_SURFACES, DELEGATE_MEMORY_DIR] : DELEGATE_SURFACES;

  for (const name of names) {
    const found = resolveDelegate(repoRoot, name);
    if (!found) die(`delegate agent not found in .sidekicks/${DELEGATES_DIRNAME}/: ${name}`, 4);

    const dst = join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME, name);
    let files = 0;
    for (const rel of surfaces) {
      const src = join(found.dir, rel);
      if (!existsSync(src)) continue;
      const dstRel = join(dst, rel);
      rmSync(dstRel, { recursive: true, force: true });
      files += copyTree(src, dstRel);
    }

    manifest.units[`agents/${name}`] = delegateUnitRecord(repoRoot, found, dst, sourceCommit, includeMemory);
    inherited.push({ name, files, memory: Boolean(includeMemory) });

    // A charter's default_work_dir names a folder in the SOURCE repo's layout; the runtime has no
    // projects/ at all, so it resolves to nothing there.
    const wd = delegateWorkDir(found.dir);
    if (wd) {
      warnings.push(`${name}: charter default_work_dir='${wd}' points at the source repo's layout — `
        + `re-point it in the runtime with 'sidekicks agent' or clear it`);
    }
  }

  if (names.length && !skillNames.some((s) => DELEGATE_SKILL_RE.test(s))) {
    warnings.push(`${names.length} delegate agent(s) inherited but no sk-agent-* skill is `
      + `selected — the 'sidekicks agent' CLI verbs travel with lib/ and still work, but nothing `
      + `documents how to create, brief or stand them by`);
  }
  return { inherited, warnings };
}

/** Delegate agents the runtime carries that are NOT in `names` (read-only; used by plan and prune). */
function unselectedDelegates(runtimeRoot, names) {
  const dir = join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME);
  if (!existsSync(dir)) return [];
  const keep = new Set(names);
  const found = [];
  for (const e of readdirSync(dir).sort()) {
    if (keep.has(e) || e === BRIDGE_DIRNAME) continue;
    if (!existsSync(join(dir, e, "agent.yaml"))) continue;
    found.push(e);
  }
  return found;
}

/**
 * Delete every delegate agent the runtime carries that is not in `names`, and drop its manifest
 * unit. OPT-IN ONLY (--prune-delegates), for the same reason as --prune-skills: a runtime may grow
 * agents of its own (drift calls those `untracked`), and an implicit prune would delete them.
 * @returns {string[]} removed agent names
 */
function pruneUnselectedDelegates(runtimeRoot, manifest, names) {
  const removed = unselectedDelegates(runtimeRoot, names);
  for (const name of removed) {
    rmSync(join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME, name), { recursive: true, force: true });
    delete manifest.units[`agents/${name}`];
  }
  return removed;
}

function copyCoreSurfaces(repoRoot, runtimeRoot, skillNames, opts) {
  const copied = [];
  const surfaces = [...CORE_SURFACES];
  // Surfaces whose contents are gated by family ownership — every agent and command port, on every
  // CLI. Collected here rather than hard-coded below so adding a port to OPTIONAL_SURFACES cannot
  // silently skip the gate (which is exactly how .codex/agents escaped it).
  const owned = new Set();
  for (const [key, paths] of Object.entries(OPTIONAL_SURFACES)) {
    if (opts[key] === false) continue;
    surfaces.push(...paths);
    for (const rel of paths) owned.add(rel);
  }
  surfaces.push(...CLI_WIRING);

  const families = ownedFamilies(skillNames);
  const dropped = [];
  const keep = (rel) => {
    const family = surfaceFamily(rel);
    if (family === null) return true;              // framework floor
    if (families.has(family)) return true;
    dropped.push({ family, rel });
    return false;
  };

  for (const rel of surfaces) {
    const src = join(repoRoot, ...rel.split("/"));
    if (!existsSync(src)) continue;
    const dst = join(runtimeRoot, ...rel.split("/"));
    rmSync(dst, { recursive: true, force: true });
    const n = copyTree(src, dst, owned.has(rel) ? { keep } : {});
    if (n) copied.push(`${rel} (${n})`);
    // A surface whose every entry was refused leaves an empty directory behind. Ship nothing rather
    // than an empty `.claude/commands/`, which reads to a consumer as "commands, but broken".
    else if (owned.has(rel)) rmSync(dst, { recursive: true, force: true });
  }
  if (dropped.length) {
    const byFamily = new Map();
    for (const d of dropped) byFamily.set(d.family, (byFamily.get(d.family) || 0) + 1);
    for (const [family, count] of byFamily) {
      copied.push(`(held back ${count} ${family} agent/command path(s) — no skill in this runtime owns them)`);
    }
  }
  return copied;
}

/** Copy only the safe, discovered configuration surface for a distributable core. */
function copyConfigurationSurface(repoRoot, runtimeRoot, previousInventory = []) {
  const inventory = configurationInventory(repoRoot);
  const copied = [];
  const current = new Set(inventory.filter((row) => row.mode).map((row) => row.destination));
  const removed = [];
  for (const row of previousInventory.filter((row) => row.mode && !current.has(row.destination))) {
    const dst = join(runtimeRoot, ...row.destination.split('/'));
    rmSync(dst, { force: true });
    removed.push(row.destination);
  }
  for (const row of inventory) {
    if (!row.mode) continue;
    const src = join(repoRoot, ...row.source.split("/"));
    const dst = join(runtimeRoot, ...row.destination.split("/"));
    mkdirp(dirname(dst));
    copyFileSync(src, dst);
    copied.push(`${row.destination} (${row.classification}, ${row.initializer_origin})`);
  }
  return { inventory, copied, removed: removed.sort() };
}

/** Three-way drift for generated core configuration, using the recorded safe inventory. */
function classifyConfiguration(repoRoot, runtimeRoot, manifest) {
  if (!Array.isArray(manifest.configuration) || !manifest.configuration.length) return [];
  const source = new Map(configurationInventory(repoRoot).filter((row) => row.mode).map((row) => [row.destination, row]));
  const rows = [];
  for (const baseline of manifest.configuration.filter((row) => row.mode)) {
    const current = source.get(baseline.destination);
    const path = join(runtimeRoot, ...baseline.destination.split('/'));
    if (!existsSync(path)) {
      rows.push({ name: baseline.destination, status: 'missing-runtime', detail: 'generated configuration file is absent' });
      continue;
    }
    // Framework reconciliation changes these files by design; their safe contract is presence.
    const reconciled = baseline.classification === 'settings'
      || baseline.destination === '.sidekicks/config/framework.yaml';
    const sourceChanged = !current || current.hash !== baseline.hash;
    const runtimeChanged = !reconciled && hashFile(path) !== baseline.hash;
    const status = sourceChanged && runtimeChanged ? 'conflict'
      : sourceChanged ? 'ff' : runtimeChanged ? 'local-only' : 'up-to-date';
    rows.push({ name: baseline.destination, status, detail: status === 'up-to-date' ? '' : 'configuration inventory changed' });
  }
  const baselineDestinations = new Set(manifest.configuration.filter((row) => row.mode).map((row) => row.destination));
  for (const row of source.values()) {
    if (!baselineDestinations.has(row.destination)) {
      rows.push({ name: row.destination, status: 'ff', detail: 'new generated configuration template' });
    }
  }
  return rows.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
}

/**
 * Resolve which scripts/ entries the given skill selection OWNS (AAP-111).
 *
 * Ownership sources, in the source repo's own lib (imported dynamically from repoRoot so the
 * engine works from an overlay-symlinked skill folder; the repo's lib is itself zero-dependency):
 *   - CORE_HOOKS (lib/framework-settings/core-registry.mjs): a hook script with `owners: []` is
 *     framework floor and always travels; one whose owners intersect the selection travels too.
 *   - skillClosure (lib/skill-package/closure.mjs): requires.framework_files[].path and
 *     framework_hooks[].script rows, kept only when needed by a skill in the selection (the
 *     closure walks declared siblings, which may exceed the selection).
 *   - DELEGATE_SCRIPT_FILES / DELEGATE_SCRIPT_SUBDIRS, claimed when `hasDelegates` — the runtime
 *     carries at least one delegate agent, so it needs the scripts that START and SUPERVISE one
 *     regardless of which skills travelled.
 *
 * @returns {{files: Set<string>, subdirs: Set<string>, orphanHookScripts: Set<string>}}
 *   files / subdirs are top-level scripts/ basenames; orphanHookScripts are top-level basenames
 *   of hook scripts whose every owner is OUTSIDE the selection (must not ship — see cmdVerify 9b).
 */
async function resolveScriptOwnership(repoRoot, skillNames, { hasDelegates = false, hasSubagents = false } = {}) {
  let CORE_HOOKS, skillClosure;
  try {
    ({ CORE_HOOKS } = await import(pathToFileURL(join(repoRoot, "lib", "framework-settings", "core-registry.mjs")).href));
    ({ skillClosure } = await import(pathToFileURL(join(repoRoot, "lib", "skill-package", "closure.mjs")).href));
  } catch (e) {
    die(`cannot resolve script ownership — the source repo's lib/ did not load: ${e.message}`, 3);
  }

  const selected = new Set(skillNames);
  const files = new Set(SCRIPT_FILE_FLOOR);
  const subdirs = new Set(SCRIPT_SUBDIR_FLOOR);
  const orphanHookScripts = new Set();

  // Claims are repo-relative ("scripts/foo.mjs", "scripts/launchd/x.plist"); only scripts/ ones
  // matter here (lib/, .sidekicks/hooks/ travel whole via CORE_SURFACES).
  const claim = (relPath) => {
    const parts = String(relPath ?? "").replace(/\\/g, "/").split("/");
    if (parts[0] !== "scripts" || parts.length < 2) return;
    if (parts.length === 2) files.add(parts[1]);
    else subdirs.add(parts[1]);
  };

  for (const h of CORE_HOOKS) {
    const parts = String(h.script || "").split("/");
    const topLevel = parts[0] === "scripts" && parts.length === 2;
    if (h.owners.length === 0 || h.owners.some((o) => selected.has(o))) claim(h.script);
    else if (topLevel) orphanHookScripts.add(parts[1]);
  }

  const closure = skillClosure(repoRoot, [...selected]);
  const needed = (row) => (row.needed_by || []).some((n) => selected.has(n));
  for (const row of closure.framework_files) if (needed(row)) claim(row.path);
  for (const row of closure.framework_hooks) if (needed(row) && row.script) claim(row.script);

  // Delegate-agent operating surface: present because the runtime carries agents, not because a
  // skill declared it. Only what actually exists in the source is claimed, so a repo that retired
  // one of these scripts does not start failing verify over a phantom claim.
  if (hasDelegates) {
    for (const f of DELEGATE_SCRIPT_FILES) {
      if (existsSync(join(repoRoot, "scripts", f))) files.add(f);
    }
    for (const d of DELEGATE_SCRIPT_SUBDIRS) {
      if (existsSync(join(repoRoot, "scripts", d))) subdirs.add(d);
    }
  }

  if (hasSubagents) {
    for (const f of SUBAGENT_PORT_SCRIPT_FILES) {
      if (existsSync(join(repoRoot, "scripts", f))) files.add(f);
    }
  }

  // A script both claimed (e.g. floor) and named by an orphan hook stays claimed.
  for (const f of files) orphanHookScripts.delete(f);
  return { files, subdirs, orphanHookScripts };
}

/**
 * Copy the scripts/ surface by ownership (AAP-111). A top-level file travels only when the
 * selection owns it (resolveScriptOwnership); a subdirectory when it is floor, claimed, or its
 * SCRIPT_SUBDIR_OWNERS entry intersects the selection. opts.hasDelegates adds the delegate-agent
 * operating surface (runner, LaunchAgent installers, tray launcher, launchd/ plist templates),
 * claimed by carrying agents rather than by a skill. opts.fullScripts bypasses the ownership
 * gate; DENY and DENY_PATTERNS always apply. opts.exact (create) rebuilds the surface from
 * scratch so a --force re-forge cannot carry a previously-owned script forward; add stays
 * additive (the tracked set only grows, so the owned set only grows).
 * @returns {{copied: number, skipped: string[]}}
 */
async function copyScriptsSurface(repoRoot, runtimeRoot, skillNames, opts = {}) {
  const res = { copied: 0, skipped: [] };
  const scriptsSrc = join(repoRoot, "scripts");
  if (!existsSync(scriptsSrc)) return res;
  const ownership = await resolveScriptOwnership(repoRoot, skillNames, {
    hasDelegates: Boolean(opts.hasDelegates),
    hasSubagents: Boolean(opts.hasSubagents),
  });
  const scriptsDst = join(runtimeRoot, "scripts");
  if (opts.exact) rmSync(scriptsDst, { recursive: true, force: true });
  mkdirp(scriptsDst);
  for (const e of readdirSync(scriptsSrc).sort()) {
    if (DENY.has(e) || DENY_PATTERNS.some((re) => re.test(e))) continue;
    const p = join(scriptsSrc, e);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    let wanted;
    if (st.isDirectory()) {
      const owners = SCRIPT_SUBDIR_OWNERS[e];
      wanted = Boolean(opts.fullScripts) || ownership.subdirs.has(e)
        || Boolean(owners && owners.some((o) => skillNames.includes(o)));
    } else {
      wanted = Boolean(opts.fullScripts) || ownership.files.has(e);
    }
    if (!wanted) { res.skipped.push(st.isDirectory() ? `${e}/` : e); continue; }
    res.copied += copyTree(p, join(scriptsDst, e), { relBase: e });
  }
  return res;
}

/**
 * Poke the runtime's OWN CLI so it self-heals its skill-exposure links (Rule 3) and refreshes its
 * git-ignored index cache. Without this the runtime's `index get skills` keeps serving the skill
 * list from before an add/patch. Best-effort: never fail the run over it.
 * @returns {{ok:boolean, note:string}}
 */
function refreshRuntimeIndex(runtimeRoot) {
  const cli = join(runtimeRoot, "bin", "sidekicks");
  if (!existsSync(cli)) return { ok: false, note: "runtime has no bin/sidekicks" };
  const r = spawnSync(process.execPath, [cli, "index", "rebuild"], { cwd: runtimeRoot, encoding: "utf8" });
  return r.status === 0
    ? { ok: true, note: "runtime index rebuilt" }
    : { ok: false, note: `runtime index rebuild failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}` };
}

/**
 * Re-materialise the runtime's framework enable map against ITS OWN registry.
 *
 * The copied framework.yaml describes the SOURCE repo: it lists rules and criteria owned by
 * skills that did not travel. `framework sync --prune` fixes both directions in one pass —
 * it drops the keys the runtime's registry no longer declares, and lists any entry the
 * runtime has but the source file did not carry. Disable decisions for skills that DID
 * travel are preserved (sync never re-decides a recorded choice); a decision about a skill
 * that stayed behind is dropped with it, and re-inheriting that skill later brings it back
 * at the built-in default (enabled).
 *
 * Runs the RUNTIME's own CLI, never this repo's — same reason refreshRuntimeIndex does.
 * Best-effort: never fail the run over it.
 * @returns {{ok:boolean, note:string}}
 */
/**
 * Trim the copied config.example.yaml down to the blocks the runtime's OWN skills declare.
 *
 * The example travels whole with CORE_SURFACES, which means a five-skill core shipped the SOURCE
 * repo's documentation for every block the source repo has. Two consequences, one of them a real
 * failure: it documents configuration for skills a consumer does not have, and `image_generation` —
 * a block no shipped skill declares at all — rode along into every install. Seeding it into a fresh
 * workspace (which `core init` no longer does) made `config doctor` fail on an undeclared block and
 * blocked `config migrate` outright.
 *
 * The file is a flat sequence of top-level `name:` blocks with their comments above them, so it can
 * be sliced without a YAML parser (this skill carries no dependencies): a block owns the comment
 * lines directly above it and every indented or blank line below it, up to the next top-level key.
 *
 * A block with no declaring skill in this runtime is DROPPED — including from the source repo's own
 * orphans. Anything the trim removes is listed in the note, so a surprised operator can see it.
 *
 * @param {string} runtimeRoot
 * @param {string[]} skillNames - the skills this runtime carries
 * @returns {{kept: string[], dropped: string[]}}
 */
function trimRuntimeConfigExample(runtimeRoot, skillNames) {
  const path = join(runtimeRoot, ".sidekicks", "config.example.yaml");
  if (!existsSync(path)) return { kept: [], dropped: [] };

  // Which blocks do the runtime's own skills declare? `block: <name>` under a `config:` key, in both
  // the single-block and the list-of-blocks spellings.
  const declared = new Set();
  for (const skill of skillNames) {
    const descriptor = join(runtimeRoot, '.agents', 'skills', skill, "skill.yaml");
    if (!existsSync(descriptor)) continue;
    let text;
    try { text = readFileSync(descriptor, "utf8"); } catch { continue; }
    for (const m of text.matchAll(/^\s*-?\s*block:\s*([A-Za-z0-9_.-]+)\s*$/gm)) declared.add(m[1]);
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const out = [];
  const kept = [];
  const dropped = [];
  let pending = [];           // comment/blank lines not yet attributed to a block
  let skipping = false;

  for (const line of lines) {
    const top = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):\s*(#.*)?$/.exec(line);
    if (top) {
      const name = top[1];
      skipping = !declared.has(name);
      if (skipping) {
        dropped.push(name);
        pending = [];         // its comment header goes with it
        continue;
      }
      kept.push(name);
      out.push(...pending, line);
      pending = [];
      continue;
    }
    if (skipping) {
      // Still inside a dropped block while the line is indented or blank; a new comment header
      // belongs to whatever comes next, so it is buffered rather than discarded.
      if (/^\s+\S/.test(line) || line.trim() === "") continue;
      if (line.startsWith("#")) { skipping = false; pending.push(line); continue; }
      continue;
    }
    if (line.startsWith("#") || line.trim() === "") { pending.push(line); continue; }
    out.push(...pending, line);
    pending = [];
  }
  out.push(...pending);

  writeFileSync(path, `${out.join("\n").replace(/\n{3,}$/, "\n")}`, "utf8");
  return { kept, dropped };
}

/**
 * The runtime's OWN toggleable framework entries, as `framework list --json` reports them.
 *
 * Read through the forged runtime's CLI, never this repo's registry module — the artifact being
 * normalized is the runtime, and its registry is smaller (skills that stayed behind take their
 * declared entries with them). Floor ids are excluded here because they are not toggleable at all:
 * writing one into any settings layer is a validation error, not a weakened runtime.
 *
 * @param {string} runtimeRoot
 * @returns {Array<{id:string, kind:string, enabled:boolean, owner_absent:boolean}>|null}
 *   null when the registry could not be read at all
 */
function runtimeToggleableEntries(runtimeRoot) {
  const cli = join(runtimeRoot, "bin", "sidekicks");
  if (!existsSync(cli)) return null;
  const r = spawnSync(process.execPath, [cli, "framework", "list", "--json"],
    { cwd: runtimeRoot, encoding: "utf8" });
  if (r.status !== 0) return null;
  let rows;
  try { rows = JSON.parse(r.stdout); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  return rows
    .filter((e) => !e.floor)
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      enabled: e.enabled !== false,
      owner_absent: Boolean(e.owner_absent),
    }));
}

/**
 * Make the forged runtime's enable map a DECLARED DEFAULT rather than a copy of the source's toggles.
 *
 * The forge copies `.sidekicks/config/settings/*.yaml` out of the source working tree (CORE_SURFACES),
 * which shipped whatever the author happened to have switched off that afternoon. v1.4.4 went out with
 * `hook.enforce-branch-safety: false` while the instruction surface in the same tarball calls the rule
 * that hook enforces a HARD rule, and the consumer had no way to know (INC-2026-09-06-06 B-1). The copy
 * stays — it is what guarantees the directory shape for a source that has not migrated to the split
 * layout — but this pass then overwrites every value in it.
 *
 * Three outcomes per toggleable id:
 *   - named in CORE_SETTINGS_SHIPPED_OFF  → `false`, with the declared reason
 *   - an owner-absent HOOK                → `false` (see the constant's header for why deriving THIS
 *                                           is safe when deriving prose is not)
 *   - anything else                       → `true`, the framework's own default
 *
 * Writes through the runtime's own `framework enable|disable`, the only sanctioned writers of the
 * settings files (Rule 1), which also refuse a floor id.
 *
 * @param {string} runtimeRoot
 * @returns {{on: string[], off: Array<{id:string, reason:string}>, ok: boolean}}
 */
function normalizeRuntimeEnableMap(runtimeRoot) {
  const cli = join(runtimeRoot, "bin", "sidekicks");
  const entries = runtimeToggleableEntries(runtimeRoot);
  if (!entries) return { on: [], off: [], ok: false };

  const on = [];
  const off = [];
  for (const entry of entries) {
    const declared = CORE_SETTINGS_SHIPPED_OFF[entry.id];
    const reason = declared
      ? declared.reason
      : (entry.kind === "hook" && entry.owner_absent ? "owner skill did not travel" : null);
    const verb = reason ? "disable" : "enable";
    const r = spawnSync(process.execPath, [cli, "framework", verb, entry.id],
      { cwd: runtimeRoot, encoding: "utf8" });
    if (r.status !== 0) continue;
    if (reason) off.push({ id: entry.id, reason });
    else on.push(entry.id);
  }
  return { on, off, ok: true };
}

function syncRuntimeFramework(runtimeRoot) {
  const cli = join(runtimeRoot, "bin", "sidekicks");
  if (!existsSync(cli)) return { ok: false, note: "runtime has no bin/sidekicks" };
  const r = spawnSync(process.execPath, [cli, "framework", "sync", "--prune", "--json"],
    { cwd: runtimeRoot, encoding: "utf8" });
  if (r.status !== 0) {
    return { ok: false, note: `framework sync failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}` };
  }
  let payload;
  try { payload = JSON.parse(r.stdout); } catch { payload = null; }
  // The normalization runs whether or not the sync payload parsed: it reads the runtime's registry
  // itself, and shipping the source's toggles is the defect it exists to prevent.
  const norm = normalizeRuntimeEnableMap(runtimeRoot);
  if (!payload) return { ok: true, note: "framework enable map synced and normalized to declared defaults" };
  const bits = [`${payload.listed}/${payload.toggleable} entries listed`];
  if (payload.added?.length) bits.push(`+${payload.added.length} added`);
  if (payload.pruned?.length) bits.push(`-${payload.pruned.length} pruned (owner skill did not travel)`);
  if (norm.ok) {
    bits.push(`${norm.on.length} enabled by default`);
    if (norm.off.length) bits.push(`${norm.off.length} shipped off (declared): ${norm.off.map((o) => o.id).join(", ")}`);
  } else {
    bits.push("NOT normalized — the runtime's framework registry could not be read");
  }
  return { ok: true, note: `framework enable map: ${bits.join(", ")}` };
}

/**
 * Seed the runtime's CONFIGURATION family files from the skills it actually carries.
 *
 * This deliberately drives the runtime's own `config sync`, rather than copying the source
 * repository's config/ directory or reproducing its family registry here. The CLI discovers the
 * inherited skills' `config:` declarations, writes every block inert, and creates only commented,
 * git-ignored credential skeletons. Consequently the runtime documents what it can configure
 * without inheriting a source value or making the copied defaults shadow their skill-level source.
 *
 * Best-effort: a forge is still useful when one optional skill has a malformed config declaration;
 * `verify` reports the outstanding configuration gap before the runtime is trusted.
 * @returns {{ok:boolean, note:string}}
 */
function syncRuntimeConfig(runtimeRoot) {
  const cli = join(runtimeRoot, "bin", "sidekicks");
  if (!existsSync(cli)) return { ok: false, note: "runtime has no bin/sidekicks" };
  const r = spawnSync(process.execPath, [cli, "config", "sync", "--json"],
    { cwd: runtimeRoot, encoding: "utf8" });
  if (r.status !== 0) {
    return { ok: false, note: `config sync failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}` };
  }
  let payload;
  try { payload = JSON.parse(r.stdout); } catch { payload = null; }
  if (!payload) return { ok: true, note: "configuration templates synced" };
  const scope = payload.scopes?.find((s) => s.base === ".sidekicks") ?? payload.scopes?.[0];
  const families = scope?.written?.length ?? 0;
  const blocks = scope?.items?.filter((i) => i.action === "add").length ?? 0;
  const secrets = scope?.secrets?.length ?? 0;
  const bits = [`${blocks} block(s) documented in ${families} family file(s)`];
  if (secrets) bits.push(`${secrets} inert credential skeleton(s) created (git-ignored)`);

  // Then retire what the copied family files document and NOTHING in this runtime declares.
  // `config sync` is additive — it seeds the blocks the carried skills own but never removes the
  // ones a left-behind skill contributed, so a forged core shipped `run_notify`, `figma`, `teleport`
  // and a nine-key `agent_skill_store` that resolve to nothing at all (INC-2026-09-06-06 B-2), and
  // `config sync --dry-run` inside the core reported each as "the owning skill ships no
  // config.defaults.yaml". --prune-only is the existing verb for exactly that; run it here rather
  // than reimplementing the family registry in this skill.
  const pruned = spawnSync(process.execPath, [cli, "config", "sync", "--scope", "all", "--prune-only", "--json"],
    { cwd: runtimeRoot, encoding: "utf8" });
  if (pruned.status === 0) {
    let pp;
    try { pp = JSON.parse(pruned.stdout); } catch { pp = null; }
    // `--prune-only` deliberately empties `items[]` (it seeds nothing), so what was actually
    // retired is reported in `scopes[].pruned` — reading `items` here would always find zero.
    const dropped = (pp?.scopes ?? []).flatMap((sc) => sc.pruned ?? []);
    if (dropped.length) bits.push(`${dropped.length} orphan block(s) retired (no skill here declares them)`);
  } else {
    bits.push("orphan-block prune did NOT run — `config sync --prune-only` failed in the runtime");
  }
  return { ok: true, note: `configuration templates: ${bits.join(", ")}` };
}

/**
 * The runtime's OWN framework-core rules and criteria, with their markers and resolved state.
 *
 * Read through the runtime's CLI rather than by importing this repo's registry module, for the two
 * reasons that govern every helper in this skill: the skill must run when copied to another repo
 * (no back-edge into lib/), and — more importantly here — the thing being verified is the FORGED
 * ARTIFACT. Asking the source repo what rules exist would re-certify the source, which is exactly
 * the mistake that let the release gates pass a core whose own instruction surface was incomplete.
 *
 * @returns {Array<{id:string, body_marker:string|null, floor:boolean, enabled:boolean}>|null}
 *   null when the registry could not be read at all (reported as a contract failure, not ignored)
 */
function runtimeCoreRules(runtimeRoot) {
  const cli = join(runtimeRoot, "bin", "sidekicks");
  if (!existsSync(cli)) return null;
  const r = spawnSync(process.execPath, [cli, "framework", "list", "--json"],
    { cwd: runtimeRoot, encoding: "utf8" });
  if (r.status !== 0) return null;
  let rows;
  try { rows = JSON.parse(r.stdout); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  return rows
    .filter((e) => e.registry_source === "core" && e.kind !== "hook")
    .map((e) => ({
      id: e.id,
      body_marker: e.body_marker ?? null,
      floor: Boolean(e.floor),
      enabled: e.enabled !== false,
    }));
}

function writeRuntimeScaffold(runtimeRoot, name) {
  // Root scope, no active project — a minimal runtime has no projects/ tree.
  const settings = join(runtimeRoot, ".sidekicks", "settings.json");
  mkdirp(dirname(settings));
  if (!existsSync(settings)) {
    writeFileSync(settings, `${JSON.stringify({ active_project: null, active_service: null }, null, 2)}\n`, "utf8");
  }
  // The memory store starts EMPTY on purpose — never inherit the source repo's memory.
  mkdirp(join(runtimeRoot, ".sidekicks", "memory"));
  const idx = join(runtimeRoot, ".sidekicks", "memory", "MEMORY.md");
  if (!existsSync(idx)) {
    writeFileSync(idx, `# Local memory — ${name}\n\nNo entries yet. Register decisions with \`sidekicks memory add\`.\n`, "utf8");
  }

  const gi = join(runtimeRoot, ".gitignore");
  if (!existsSync(gi)) copyFileSync(join(ASSETS, "runtime.gitignore"), gi);

  const pkg = join(runtimeRoot, "package.json");
  if (!existsSync(pkg)) {
    writeFileSync(pkg, `${JSON.stringify({
      name, version: "0.1.0", private: true, type: "module",
      engines: { node: ">=20" },
      scripts: { test: RUNTIME_TEST_COMMAND },
    }, null, 2)}\n`, "utf8");
  } else {
    // The test command is DERIVED, so it is repaired on every forge rather than left at whatever an
    // older engine wrote. A runtime forged before F-05 carries `node --test 'tests/**/*.test.mjs'`,
    // which on Node 22 discovers nothing and still exits 0 — the false-green this replaces. Only
    // that one key is rewritten; anything the operator added to package.json is left alone.
    try {
      const cur = JSON.parse(readFileSync(pkg, "utf8"));
      if (cur && typeof cur === "object" && cur.scripts?.test !== RUNTIME_TEST_COMMAND) {
        cur.scripts = { ...(cur.scripts || {}), test: RUNTIME_TEST_COMMAND };
        writeFileSync(pkg, `${JSON.stringify(cur, null, 2)}\n`, "utf8");
      }
    } catch { /* an unparseable package.json is the operator's to fix; never clobber it */ }
  }
}

// Matches a hook script reference inside a wiring config's command string.
const HOOK_SCRIPT_RE = /(?:scripts|\.sidekicks[/\\]hooks)[/\\][\w.-]+\.(?:mjs|sh|py|js)/g;

/** Drop hook entries from one JSON wiring config whose script did not travel. */
function pruneHooksJson(runtimeRoot, relConfig) {
  const p = join(runtimeRoot, ...relConfig.split("/"));
  if (!existsSync(p)) return [];
  let cfg;
  try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { return []; }
  const dropped = [];

  for (const [event, groups] of Object.entries(cfg.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) continue;
      group.hooks = group.hooks.filter((h) => {
        for (const ref of String(h.command ?? "").match(HOOK_SCRIPT_RE) ?? []) {
          const relPath = ref.replace(/\\/g, "/");
          if (!existsSync(join(runtimeRoot, ...relPath.split("/")))) {
            dropped.push(`${relConfig}: ${event}: ${relPath}`);
            return false;
          }
        }
        return true;
      });
    }
    cfg.hooks[event] = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length > 0);
    if (cfg.hooks[event].length === 0) delete cfg.hooks[event];
  }
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  return dropped;
}

/**
 * Drop `[[hooks.<Event>.hooks]]` blocks from .codex/config.toml whose script did not travel.
 * Textual, conservative: a block runs from its `[[` header to the next `[[` header or EOF;
 * comment lines contiguously above a dropped block go with it; a bare `[[hooks.<Event>]]`
 * header whose sub-blocks all vanished is dropped too. Everything else — including the
 * top-of-file banner, which a blank line separates from any block — survives byte-for-byte.
 */
function pruneHooksToml(runtimeRoot) {
  const relConfig = ".codex/config.toml";
  const p = join(runtimeRoot, ...relConfig.split("/"));
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split("\n");
  const dropped = [];

  // Parse into segments: [start, end) line ranges, each a header block or the preamble.
  const headerRe = /^\[\[hooks\.([\w-]+)(\.hooks)?\]\]\s*$/;
  const segments = [];   // {start, end, event, isSub, header}
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (m) {
      if (current) current.end = i;
      current = { start: i, end: lines.length, event: m[1], isSub: Boolean(m[2]), header: true };
      segments.push(current);
    }
  }
  const preambleEnd = segments.length ? segments[0].start : lines.length;

  const drop = new Set();   // line indexes to remove
  for (const seg of segments) {
    if (!seg.isSub) continue;
    const body = lines.slice(seg.start, seg.end).join("\n");
    for (const ref of body.match(HOOK_SCRIPT_RE) ?? []) {
      const relPath = ref.replace(/\\/g, "/");
      if (existsSync(join(runtimeRoot, ...relPath.split("/")))) continue;
      dropped.push(`${relConfig}: ${seg.event}: ${relPath}`);
      for (let i = seg.start; i < seg.end; i++) drop.add(i);
      // Comment lines contiguously above the header belong to this block — but never the
      // preamble banner (a blank line always terminates the walk).
      for (let i = seg.start - 1; i >= preambleEnd && /^\s*#/.test(lines[i]); i--) drop.add(i);
      seg.dropped = true;
      break;
    }
  }
  // Bare [[hooks.<Event>]] headers whose sub-blocks all got dropped.
  for (const seg of segments) {
    if (seg.isSub) continue;
    const subs = segments.filter((s) => s.isSub && s.event === seg.event);
    if (subs.length && subs.every((s) => s.dropped)) {
      for (let i = seg.start; i < seg.end; i++) drop.add(i);
      for (let i = seg.start - 1; i >= preambleEnd && /^\s*#/.test(lines[i]); i--) drop.add(i);
    }
  }
  if (!drop.size) return dropped;

  const kept = lines.filter((_, i) => !drop.has(i));
  // Collapse runs of blank lines the removals left behind.
  const compact = [];
  for (const l of kept) {
    if (l.trim() === "" && compact.length && compact[compact.length - 1].trim() === "") continue;
    compact.push(l);
  }
  writeFileSync(p, compact.join("\n"), "utf8");
  return dropped;
}

/**
 * Drop third-party plugin declarations the runtime is not allowed to carry, across ALL per-CLI
 * configs (Rule 6 parity — today only Claude's settings carries the shape, and the walk finds it
 * wherever another CLI grows one).
 *
 * `enabledPlugins` and `extraKnownMarketplaces` are copied wholesale with the wiring, so whatever the
 * source author had switched on became every consumer's plugin set. The allow-list lives in
 * assets/presets.yaml (`host_plugins:`) with the rule for adding to it; here we only apply it.
 *
 * Marketplaces are pruned by DERIVATION, not by a second list: a marketplace exists to serve a
 * declared plugin, so one no surviving `<plugin>@<marketplace>` names has nothing left to fetch.
 *
 * @param {string} runtimeRoot
 * @param {string[]} allowed - `<plugin>@<marketplace>` identifiers that may stay
 * @returns {string[]} "config: kind: name" lines for what was dropped
 */
function prunePluginDeclarations(runtimeRoot, allowed) {
  const keep = new Set(allowed);
  const keepMarkets = new Set(allowed.map((id) => id.split("@")[1]).filter(Boolean));
  const dropped = [];

  for (const relConfig of [".claude/settings.json", ".gemini/settings.json", ".agent/settings.json"]) {
    const p = join(runtimeRoot, ...relConfig.split("/"));
    if (!existsSync(p)) continue;
    let cfg;
    try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    let changed = false;

    if (cfg.enabledPlugins && typeof cfg.enabledPlugins === "object") {
      for (const id of Object.keys(cfg.enabledPlugins)) {
        if (keep.has(id)) continue;
        delete cfg.enabledPlugins[id];
        dropped.push(`${relConfig}: plugin: ${id}`);
        changed = true;
      }
      if (Object.keys(cfg.enabledPlugins).length === 0) delete cfg.enabledPlugins;
    }
    if (cfg.extraKnownMarketplaces && typeof cfg.extraKnownMarketplaces === "object") {
      for (const name of Object.keys(cfg.extraKnownMarketplaces)) {
        if (keepMarkets.has(name)) continue;
        delete cfg.extraKnownMarketplaces[name];
        dropped.push(`${relConfig}: marketplace: ${name}`);
        changed = true;
      }
      if (Object.keys(cfg.extraKnownMarketplaces).length === 0) delete cfg.extraKnownMarketplaces;
    }
    if (changed) writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  }
  return dropped;
}

/**
 * Drop hook wiring across ALL per-CLI configs (Rule 6 parity) for scripts that did not travel.
 * @returns {string[]} "config: event: script" lines
 */
function pruneHookWiring(runtimeRoot) {
  return [
    ...pruneHooksJson(runtimeRoot, ".claude/settings.json"),
    ...pruneHooksJson(runtimeRoot, ".gemini/settings.json"),
    ...pruneHooksJson(runtimeRoot, ".agent/settings.json"),
    ...pruneHooksToml(runtimeRoot),
  ];
}

function ensureSourceGitignore(repoRoot) {
  const gi = join(repoRoot, ".gitignore");
  if (!existsSync(gi)) return false;
  const text = readFileSync(gi, "utf8");
  if (/^\/runtimes\/\s*$/m.test(text)) return false;
  const block = [
    "# Inherited standalone runtimes (sk-inherit). Each runtimes/<name>/ is its own git",
    "# repo with its own remote — the parent repo never tracks it.",
    "/runtimes/",
    "",
  ].join("\n");
  writeFileSync(gi, `${text.endsWith("\n") ? text : `${text}\n`}\n${block}`, "utf8");
  return true;
}

function initRuntimeGit(runtimeRoot, remote) {
  const res = { initialized: false, remote: null, note: "" };
  if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) {
    res.note = "git not on PATH — runtime left un-initialized";
    return res;
  }
  if (!existsSync(join(runtimeRoot, ".git"))) {
    const r = spawnSync("git", ["-C", runtimeRoot, "init", "-q"], { encoding: "utf8" });
    if (r.status !== 0) { res.note = `git init failed: ${(r.stderr || "").trim()}`; return res; }
    res.initialized = true;
  }
  if (remote) {
    const has = spawnSync("git", ["-C", runtimeRoot, "remote", "get-url", "origin"], { encoding: "utf8" });
    const verb = has.status === 0 ? "set-url" : "add";
    const r = spawnSync("git", ["-C", runtimeRoot, "remote", verb, "origin", remote], { encoding: "utf8" });
    if (r.status === 0) res.remote = remote;
    else res.note = `could not set origin: ${(r.stderr || "").trim()}`;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Drift classification — three-way, one-way propagation
// ---------------------------------------------------------------------------

const STATUS_ORDER = ["conflict", "missing-required", "ff", "local-only", "missing-source",
  "missing-runtime", "untracked", "up-to-date"];

const STATUS_LABEL = {
  "up-to-date": "up to date",
  ff: "FF (clean, safe to patch)",
  conflict: "CONFLICT (both sides changed)",
  "local-only": "local-only (runtime edited, nothing upstream)",
  "missing-source": "MISSING IN SOURCE",
  "missing-runtime": "MISSING IN RUNTIME",
  "missing-required": "MISSING REQUIRED (floor skill absent — patch restores it)",
  untracked: "untracked",
};

/**
 * Three-way compare per inherited skill: SOURCE now, RUNTIME now, and the BASELINE hashes
 * recorded at inherit time. The baseline is what distinguishes "the source moved" from "the
 * runtime was edited" — without it, any difference is ambiguous.
 * Propagation stays one-way: a runtime-side change is only ever REPORTED, never pulled back.
 */
function classifySkills(repoRoot, runtimeRoot, manifest) {
  const rows = [];
  const tracked = new Set();
  const requiredFloor = new Set(loadRequiredSkills());

  for (const [unit, rec] of Object.entries(manifest.units ?? {})) {
    if (rec.kind !== "skill") continue;
    const name = unit.slice("skills/".length);
    tracked.add(name);

    const found = resolveSkill(repoRoot, name);
    const runtimeDir = join(runtimeRoot, '.agents', 'skills', name);
    const baseline = rec.files ?? {};

    if (!existsSync(join(runtimeDir, "SKILL.md"))) {
      // A REQUIRED skill that went missing is the same defect as one that never arrived, so it gets
      // the same status and the same no-force repair — not `missing-runtime`, which patch holds back
      // behind --force because it is normally an operator's deliberate deletion.
      rows.push(requiredFloor.has(name)
        ? { name, status: "missing-required", from: rec.version ?? null, to: null,
          detail: "required by every runtime and absent — 'patch' restores it without --force" }
        : { name, status: "missing-runtime", from: rec.version ?? null, to: null,
          detail: "recorded in the manifest but absent from the runtime" });
      continue;
    }
    const runtimeHashes = hashTree(runtimeDir);
    const localChanged = !sameHashes(runtimeHashes, baseline);

    if (!found) {
      rows.push({ name, status: "missing-source", from: rec.version ?? null, to: null,
        detail: `gone from the source repo${localChanged ? "; runtime copy also locally modified" : ""}` });
      continue;
    }
    // PROJECTED, not merely deny-filtered. The baseline was hashed from the runtime copy, which is
    // a projection of this folder: development evidence was left behind and the metadata that names
    // files was rewritten to match. Comparing against the raw source tree would therefore report
    // every excluded file AND `skill.manifest.yaml`/`VERSION.json` as "the source moved" — on every
    // run, for ever, since patch re-records from the runtime copy again. The same function that
    // produced the copy produces this side, which is the only way the two can agree.
    const sourceHashes = projectedSourceHashes(
      projectSkillRuntime(found.dir, {
        skill: name,
        deny: (rel) => isDenied(rel.split("/").join(sep)),
      }),
      found.dir,
      (abs, derivedContent) => (derivedContent === null ? hashFile(abs) : hashBuffer(derivedContent))
    );
    const sourceChanged = !sameHashes(sourceHashes, baseline);

    let status;
    if (sourceChanged && localChanged) status = "conflict";
    else if (sourceChanged) status = "ff";
    else if (localChanged) status = "local-only";
    else status = "up-to-date";

    rows.push({
      name, status, from: rec.version ?? null, to: skillVersion(found.dir),
      origin: found.origin,
      detail: describeFileDelta(baseline, sourceHashes, runtimeHashes, status),
    });
  }

  // Skills present in the runtime but never recorded — hand-added, outside the contract.
  const runtimeSkillsDir = join(runtimeRoot, '.agents', 'skills');
  if (existsSync(runtimeSkillsDir)) {
    for (const e of readdirSync(runtimeSkillsDir).sort()) {
      if (tracked.has(e)) continue;
      if (!existsSync(join(runtimeSkillsDir, e, "SKILL.md"))) continue;
      rows.push({ name: e, status: "untracked", from: null, to: null,
        detail: "in the runtime but not the manifest — added outside sk-inherit" });
    }
  }

  // A REQUIRED skill the runtime does not carry at all. This is the one absence the manifest cannot
  // report on its own: a runtime forged before the floor existed never tracked these units, so there
  // is nothing for the loop above to classify. Reported here so `drift` exits non-zero and `patch`
  // has a row to act on. A required skill that IS tracked is already covered — it lands on
  // `missing-runtime` or a normal status like any other unit.
  for (const name of requiredFloor) {
    if (tracked.has(name)) continue;
    if (existsSync(join(runtimeSkillsDir, name, "SKILL.md"))) continue;
    const inSource = resolveSkill(repoRoot, name);
    rows.push({
      name,
      status: "missing-required",
      from: null,
      to: inSource ? skillVersion(inSource.dir) : null,
      detail: "required by every runtime and absent — 'patch' restores it without --force",
    });
  }

  rows.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
  return rows;
}

/**
 * Three-way compare per inherited DELEGATE AGENT, over the inherited surface only
 * (hashDelegateSurface — see why there). Statuses and propagation match the skill table: a
 * runtime-side charter edit is reported, never pulled upstream. Charters are amended in place in the
 * runtime, so `local-only` and `CONFLICT` are the expected states here, not exceptions.
 */
function classifyDelegates(repoRoot, runtimeRoot, manifest) {
  const rows = [];
  const tracked = new Set();
  const runtimeDir = join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME);

  for (const [unit, rec] of Object.entries(manifest.units ?? {})) {
    if (rec.kind !== "agent") continue;
    const name = unit.slice("agents/".length);
    tracked.add(name);

    const includeMemory = Boolean(rec.include_memory);
    const found = resolveDelegate(repoRoot, name);
    const dir = join(runtimeDir, name);
    const baseline = rec.files ?? {};

    if (!existsSync(join(dir, "agent.yaml"))) {
      rows.push({ name, status: "missing-runtime", from: null, to: null,
        detail: "recorded in the manifest but absent from the runtime" });
      continue;
    }
    const runtimeHashes = hashDelegateSurface(dir, includeMemory);
    const localChanged = !sameHashes(runtimeHashes, baseline);

    if (!found) {
      rows.push({ name, status: "missing-source", from: null, to: null,
        detail: `gone from the source repo${localChanged ? "; runtime copy also locally modified" : ""}` });
      continue;
    }
    const sourceHashes = hashDelegateSurface(found.dir, includeMemory);
    const sourceChanged = !sameHashes(sourceHashes, baseline);

    let status;
    if (sourceChanged && localChanged) status = "conflict";
    else if (sourceChanged) status = "ff";
    else if (localChanged) status = "local-only";
    else status = "up-to-date";

    const delta = describeFileDelta(baseline, sourceHashes, runtimeHashes, status);
    rows.push({
      name, status, from: null, to: null,
      detail: [delta, includeMemory ? "memory tracked" : "charter+routines only"].filter(Boolean).join("; "),
    });
  }

  if (existsSync(runtimeDir)) {
    for (const e of readdirSync(runtimeDir).sort()) {
      if (tracked.has(e) || e === BRIDGE_DIRNAME) continue;
      if (!existsSync(join(runtimeDir, e, "agent.yaml"))) continue;
      rows.push({ name: e, status: "untracked", from: null, to: null,
        detail: "in the runtime but not the manifest — created there, outside sk-inherit" });
    }
  }

  rows.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
  return rows;
}

function describeFileDelta(baseline, source, runtime, status) {
  const diff = (a, b) => ({
    added: Object.keys(b).filter((k) => !(k in a)),
    removed: Object.keys(a).filter((k) => !(k in b)),
    changed: Object.keys(b).filter((k) => k in a && a[k] !== b[k]),
  });
  const parts = [];
  if (status === "ff" || status === "conflict") {
    const d = diff(baseline, source);
    parts.push(`source +${d.added.length} ~${d.changed.length} -${d.removed.length}`);
  }
  if (status === "local-only" || status === "conflict") {
    const d = diff(baseline, runtime);
    parts.push(`runtime +${d.added.length} ~${d.changed.length} -${d.removed.length}`);
    const touched = [...d.changed, ...d.added].slice(0, 4);
    if (touched.length) parts.push(`local edits: ${touched.join(", ")}`);
  }
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// patch — clean fast-forwards only unless forced
// ---------------------------------------------------------------------------

// Memoized per runtimeRoot — patch/backup loops call this once per row, and it is the same
// answer every time within one invocation of this script.
const inheritRunBaseCache = new Map();

/**
 * Resolve THIS run's v2 folder INSIDE THE RUNTIME for inherit's own generated output (patch
 * backups). Runs the RUNTIME's own CLI, never this repo's (same reason refreshRuntimeIndex /
 * syncRuntimeFramework do — a patch happens against a separate, possibly out-of-tree repo). No
 * `--bare`: this skill is not one of the four engines, and there is no unit of work for a patch
 * run, so it resolves under the runtime's own `_adhoc/sk-inherit/`. Falls back to the
 * frozen pre-v2 join (`<runtimeRoot>/artifacts/runs/inherit`) when the runtime predates `scope
 * run-base` (an older-forged runtime) or has no CLI at all.
 */
function inheritRunBase(runtimeRoot) {
  if (inheritRunBaseCache.has(runtimeRoot)) return inheritRunBaseCache.get(runtimeRoot);
  const fallback = join(runtimeRoot, "artifacts", "runs", "inherit");
  const cli = join(runtimeRoot, "bin", "sidekicks");
  let base = fallback;
  if (existsSync(cli)) {
    const r = spawnSync(process.execPath, [cli, "scope", "run-base", "sk-inherit"],
      { cwd: runtimeRoot, encoding: "utf8" });
    const resolved = (r.stdout || "").trim();
    if (r.status === 0 && resolved) base = isAbsolute(resolved) ? resolved : join(runtimeRoot, resolved);
  }
  inheritRunBaseCache.set(runtimeRoot, base);
  return base;
}

function backupSkill(runtimeRoot, name, stamp) {
  const src = join(runtimeRoot, '.agents', 'skills', name);
  if (!existsSync(src)) return null;
  const dst = join(inheritRunBase(runtimeRoot), "backups", stamp, name);
  copyTree(src, dst);
  return relative(runtimeRoot, dst).split(sep).join("/");   // runtime-relative, portable
}

function applyPatch(repoRoot, runtimeRoot, manifest, rows, { force, only, sourceCommit }) {
  const stamp = nowBangkok().replace(/[:+]/g, "-");
  const applied = [];
  const refused = [];

  for (const row of rows) {
    if (only && !only.includes(row.name)) continue;
    if (row.status === "up-to-date") continue;

    const forceable = row.status === "conflict" || row.status === "local-only" || row.status === "missing-runtime";
    // `missing-required` patches like a clean fast-forward, deliberately without --force: there is no
    // runtime-side work to destroy (the folder is not there) and the floor is not the operator's to
    // opt out of, so demanding --force would only stand between a broken runtime and its repair.
    if (!(row.status === "ff" || row.status === "missing-required" || (force && forceable))) {
      refused.push(row);
      continue;
    }

    const found = resolveSkill(repoRoot, row.name);
    if (!found) { refused.push({ ...row, detail: "no source to patch from" }); continue; }

    // Anything with runtime-side edits is preserved before being overwritten.
    const backup = (row.status === "conflict" || row.status === "local-only")
      ? backupSkill(runtimeRoot, row.name, stamp) : null;

    const dst = join(runtimeRoot, '.agents', 'skills', row.name);
    rmSync(dst, { recursive: true, force: true });
    copyTree(found.dir, dst);
    const previousReasons = manifest.units[`skills/${row.name}`]?.selection_reasons;
    manifest.units[`skills/${row.name}`] = skillUnitRecord(repoRoot, found, dst, sourceCommit);
    if (previousReasons?.length) {
      manifest.units[`skills/${row.name}`].selection_reasons = [...previousReasons];
    }
    applied.push({ ...row, backup });
  }
  return { applied, refused };
}

/** Back up a delegate agent's inherited surface before it is overwritten. */
function backupDelegate(runtimeRoot, name, stamp, includeMemory) {
  const src = join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME, name);
  if (!existsSync(src)) return null;
  const dst = join(inheritRunBase(runtimeRoot), "backups", stamp, "agents", name);
  const surfaces = includeMemory ? [...DELEGATE_SURFACES, DELEGATE_MEMORY_DIR] : DELEGATE_SURFACES;
  for (const rel of surfaces) {
    if (existsSync(join(src, rel))) copyTree(join(src, rel), join(dst, rel));
  }
  return relative(runtimeRoot, dst).split(sep).join("/");   // runtime-relative, portable
}

/**
 * Patch delegate agents — clean fast-forwards only unless forced, mirroring applyPatch().
 * runtime/ is never touched: a live delegate's presence, mailbox and threads survive a patch.
 */
function applyDelegatePatch(repoRoot, runtimeRoot, manifest, rows, { force, only, sourceCommit }) {
  const stamp = nowBangkok().replace(/[:+]/g, "-");
  const applied = [];
  const refused = [];

  for (const row of rows) {
    if (only && !only.includes(row.name)) continue;
    if (row.status === "up-to-date") continue;

    const forceable = row.status === "conflict" || row.status === "local-only" || row.status === "missing-runtime";
    if (!(row.status === "ff" || (force && forceable))) { refused.push(row); continue; }

    const found = resolveDelegate(repoRoot, row.name);
    if (!found) { refused.push({ ...row, detail: "no source to patch from" }); continue; }

    const rec = manifest.units[`agents/${row.name}`] ?? {};
    const includeMemory = Boolean(rec.include_memory);
    const backup = (row.status === "conflict" || row.status === "local-only")
      ? backupDelegate(runtimeRoot, row.name, stamp, includeMemory) : null;

    const dst = join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME, row.name);
    for (const rel of (includeMemory ? [...DELEGATE_SURFACES, DELEGATE_MEMORY_DIR] : DELEGATE_SURFACES)) {
      const src = join(found.dir, rel);
      rmSync(join(dst, rel), { recursive: true, force: true });
      if (existsSync(src)) copyTree(src, join(dst, rel));
    }
    manifest.units[`agents/${row.name}`] = delegateUnitRecord(repoRoot, found, dst, sourceCommit, includeMemory);
    applied.push({ ...row, backup });
  }
  return { applied, refused };
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

function printDriftTable(rows) {
  if (!rows.length) { out("  (no skills tracked)"); return; }
  const w = Math.max(...rows.map((r) => r.name.length), 4);
  for (const r of rows) {
    const ver = r.from && r.to && r.from !== r.to ? `${r.from} -> ${r.to}` : (r.from ?? r.to ?? "-");
    out(`  ${r.name.padEnd(w)}  ${String(ver).padEnd(16)}  ${STATUS_LABEL[r.status]}${r.detail ? `  [${r.detail}]` : ""}`);
  }
}

function summarize(rows) {
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return STATUS_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(", ");
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const verb = argv[0];
  const flags = {};
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { verb, flags, positional };
}

function csv(v) {
  if (!v || v === true) return [];
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * "Present and not explicitly false" for an opt-in flag.
 * parseArgv gives a bare `--flag` the value `true`, but `--flag <positional>` swallows the
 * positional as its value — so presence, not truthiness of the value, is what a boolean flag means.
 */
function truthyFlag(v) {
  return v !== undefined && v !== false && v !== "false" && v !== "0" && v !== "";
}

/**
 * Resolve which runtime a verb acts on, and where it lives.
 *
 * A runtime may be placed anywhere via --target (absolute, or relative to the repo root). The
 * location is remembered in the registry at create time, so later verbs need only --name.
 * Precedence: explicit --target › registered location › the default runtimes/<name>/.
 *
 * @returns {{name:string, dir:string, source:"flag"|"registry"|"default"}}
 */
function resolveRuntime(repoRoot, flags, positional) {
  const name = flags.name ?? positional[0];
  if (!name) die("missing runtime name (--name <n>)", 2);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) die(`invalid runtime name: ${name}`, 2);

  let dir;
  let source;
  if (flags.target) {
    const t = String(flags.target);
    dir = isAbsolute(t) ? resolve(t) : resolve(repoRoot, t);
    source = "flag";
  } else {
    const registered = lookupRuntime(repoRoot, name);
    if (registered) { dir = registered; source = "registry"; }
    else { dir = join(repoRoot, "runtimes", name); source = "default"; }
  }

  if (resolve(dir) === resolve(repoRoot)) die("the target may not be the sidekicks source repo itself", 2);
  // Refuse a target that would swallow the source repo (e.g. --target ..).
  if (isInsideRepo(dir, repoRoot)) {
    die(`the target ${displayPath(repoRoot, dir)} contains the sidekicks source repo — pick a location that is not an ancestor of it`, 2);
  }
  return { name, dir, source };
}

/**
 * A runtime lands at the repo root (runtimes/<name>/), which Rule 2 only grants as free-write
 * when the ROOT scope is active — with a user project active the boundary narrows to
 * projects/<active>/. Report the mismatch rather than block: the target sits outside both
 * .sidekicks/ and projects/, so this is a scope-hygiene notice for the operator, not a breach.
 */
function warnIfProjectScoped(repoRoot) {
  const p = join(repoRoot, ".sidekicks", "settings.json");
  if (!existsSync(p)) return;
  let active = null;
  try { active = JSON.parse(readFileSync(p, "utf8")).active_project ?? null; } catch { return; }
  if (!active || active === "sidekicks") return;
  out(`NOTE: project '${active}' is the active scope, but a runtime is written at the repo root.`);
  out(`      Switch with 'sidekicks project use sidekicks' to keep the Rule 2 boundary aligned.`);
  out("");
}

/**
 * What the operator asked for, what the floor adds, and the union that actually travels.
 *
 * The three are returned separately because they answer different questions. `operator` is what the
 * command line said, so it — never `all` — is what an "nothing selected" check must look at: the
 * floor must not turn a selection-less invocation into a silent four-skill runtime. `all` is what
 * gets copied, pruned against and reported.
 *
 * @returns {{operator: string[], required: string[], all: string[], reasons: Record<string,string[]>}}
 */
function resolveSkillSelection(repoRoot, flags) {
  const presets = loadPresets();
  const names = csv(flags.skills);
  const reasonSets = new Map();
  const addReason = (skill, reason) => {
    if (!reasonSets.has(skill)) reasonSets.set(skill, new Set());
    reasonSets.get(skill).add(reason);
  };
  for (const skill of names) addReason(skill, "selected-by-operator");
  for (const p of csv(flags.preset)) {
    if (!presets[p]) die(`unknown preset '${p}' (available: ${Object.keys(presets).join(", ") || "none"})`, 2);
    if (p === "framework") {
      const resolved = resolveFrameworkPreset(repoRoot, { requiredFloor: loadRequiredSkills() });
      if (resolved.errors.length) {
        die(`framework preset cannot be composed:\n         ${resolved.errors.join("\n         ")}`, 4);
      }
      names.push(...resolved.selected);
      for (const [skill, reasons] of Object.entries(resolved.reasons)) {
        for (const reason of reasons) addReason(skill, reason);
      }
    } else {
      names.push(...presets[p].skills);
      for (const skill of presets[p].skills) addReason(skill, `selected-by-preset:${p}`);
    }
  }
  const operator = [...new Set(names)];
  const required = loadRequiredSkills();
  for (const skill of required) addReason(skill, "required-floor");
  const reasons = {};
  for (const skill of [...reasonSets.keys()].sort()) reasons[skill] = [...reasonSets.get(skill)].sort();
  return { operator, required, all: [...new Set([...required, ...operator])], reasons };
}

/**
 * The derived pack-skill set for THIS forge — empty unless a core is being forged.
 *
 * An ordinary runtime ships no agent pack (packs are a core-distribution surface), so deriving
 * anything for one would put skills in it that nothing there can use. `--no-pack-skills` is the
 * escape hatch for forging a deliberately bare core.
 *
 * @returns {Promise<{skills: string[], packs: number, seeds: string[], viaClosure: string[]}>}
 */
async function packSkillsFor(repoRoot, flags, asCore) {
  const none = { skills: [], packs: 0, seeds: [], viaClosure: [], mode: "none" };
  const mode = String(flags["pack-skills"] ?? "declared").trim() || "declared";
  if (!PACK_SKILL_MODES.includes(mode)) {
    die(`--pack-skills must be one of: ${PACK_SKILL_MODES.join(", ")}`, 2);
  }
  if (!asCore || mode === "none") return none;
  const derived = await resolvePackSkills(repoRoot);
  // DEFAULT `declared`: exactly the skills the pack manifests name, and nothing else. That is what
  // makes the shipped pack installable — `agent pack install` checks the declared rows and refused
  // on all three of them before this existed — while keeping a core the lean substrate presets.yaml
  // says it is. `closure` adds each of those skills' own declared siblings, which they will fail
  // without; it is the honest-but-heavy answer (3 skills become 28 here) and stays opt-in, because
  // the consumer can import a sibling with one `skill import` and cannot un-ship 25 skills.
  if (mode === "declared") return { ...derived, skills: derived.seeds, viaClosure: [], mode };
  return { ...derived, mode };
}

/** How much of the agent packs' declared skill graph a core carries. */
const PACK_SKILL_MODES = ["closure", "declared", "none"];

/**
 * The selection plus whatever the shipped packs declare, order-stable and de-duplicated.
 *
 * `reasons` is merged IN PLACE and deliberately: it is the same map `inheritSkills` writes into
 * `.sidekicks/inherit.json`, and a skill that reached the core through this union with no entry
 * there is a skill the artifact cannot explain. Every other selection path records why; this was
 * the one that did not.
 */
function unionPackSkills(selection, packSkills, reasons = null) {
  if (!packSkills.skills.length) return selection;
  if (reasons) {
    for (const [skill, why] of Object.entries(packSkills.reasons ?? {})) {
      if (!packSkills.skills.includes(skill)) continue;   // `declared` mode ships a subset
      reasons[skill] = [...new Set([...(reasons[skill] ?? []), ...why])].sort();
    }
    for (const skill of packSkills.skills) {
      if (reasons[skill]?.length) continue;
      // The closure could not run (its one catch above) yet the seed still travels. Say that,
      // rather than leaving the only unexplained row in the file.
      reasons[skill] = ["agent-pack:unattributed"];
    }
  }
  return [...new Set([...selection, ...packSkills.skills])];
}

/**
 * Delegate-agent selection: --delegates a,b + any preset's `delegates:` block, or --all-delegates.
 * Empty by default — an agent never travels unless it was asked for.
 */
function resolveDelegateSelection(repoRoot, flags) {
  if (truthyFlag(flags["all-delegates"])) return listAvailableDelegates(repoRoot);
  const presets = loadPresets();
  const names = csv(flags.delegates);
  for (const p of csv(flags.preset)) {
    if (!presets[p]) die(`unknown preset '${p}' (available: ${Object.keys(presets).join(", ") || "none"})`, 2);
    names.push(...presets[p].delegates);
  }
  return [...new Set(names)];
}

function reportRequirements(reqs, { indent = "  " } = {}) {
  if (reqs.pinned.length) out(`${indent}pinned from source venv: ${reqs.pinned.join(", ")}`);
  if (reqs.unpinned.length) out(`${indent}unpinned (absent from source venv): ${reqs.unpinned.join(", ")}`);
  if (!reqs.pinned.length && !reqs.unpinned.length) out(`${indent}(none — no venv needed)`);
  if (reqs.unknown.length) {
    out(`${indent}UNMAPPED imports — add them to assets/module-distribution.json or the venv will be incomplete:`);
    for (const u of reqs.unknown) out(`${indent}  ${u.module}  (seen in ${u.files.map((f) => basename(f)).join(", ")})`);
  }
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

function cmdSkills(repoRoot) {
  const { active, offloaded } = listAvailableSkills(repoRoot);
  out(`active (${active.length}):`);
  for (const s of active) out(`  ${s}`);
  out("");
  out(`offloaded — eligible; inheriting one reactivates it in the runtime only (${offloaded.length}):`);
  for (const s of offloaded) out(`  ${s}`);
  const delegates = listAvailableDelegates(repoRoot);
  out("");
  out(`delegate agents — .sidekicks/${DELEGATES_DIRNAME}/, inherited only when named with `
    + `--delegates (${delegates.length}):`);
  for (const a of delegates) out(`  ${a}`);
  out(`  (charter + routines travel; memory/ only with --delegate-memory; runtime/ and .bridge/ never)`);
  const required = loadRequiredSkills();
  if (required.length) {
    out("");
    out(`required — carried by EVERY runtime whatever you select, no flag turns it off (${required.length}):`);
    for (const s of required) out(`  ${s}`);
  }
  const presets = loadPresets();
  if (Object.keys(presets).length) {
    out("");
    out("presets (optional, compose freely — 'required' above is not one of them):");
    for (const [k, v] of Object.entries(presets)) {
      out(`  ${k}: ${v.skills.join(", ") || "(no skills)"}`);
      if (v.delegates.length) out(`    delegates: ${v.delegates.join(", ")}`);
    }
  }
}

/**
 * List every known runtime, wherever it lives: the registry (which can point anywhere, including
 * outside the repo) unioned with a scan of the conventional runtimes/ folder — so a runtime made
 * before the registry existed, or by hand, still shows up.
 */
function cmdList(repoRoot) {
  const found = new Map();   // name -> { dir, known: "registry"|"runtimes/" }

  for (const [name, rec] of Object.entries(readRegistry(repoRoot))) {
    if (rec?.path_rel) found.set(name, { dir: resolve(repoRoot, rec.path_rel), known: "registry" });
  }

  const conventional = join(repoRoot, "runtimes");
  if (existsSync(conventional)) {
    for (const e of readdirSync(conventional).sort()) {
      if (!statSync(join(conventional, e), { throwIfNoEntry: false })?.isDirectory()) continue;
      if (!found.has(e)) found.set(e, { dir: join(conventional, e), known: "runtimes/" });
    }
  }

  if (!found.size) { out("no runtimes known yet (none registered, and runtimes/ is empty or absent)"); return; }

  for (const [name, { dir, known }] of [...found.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const where = displayPath(repoRoot, dir);
    const outside = !isInsideRepo(repoRoot, dir) ? "  [outside the repo]" : "";
    if (!existsSync(dir)) {
      out(`${name}  ${where}  MISSING — the directory is gone (drop the entry with 'forget')`);
      continue;
    }
    const m = readManifest(dir);
    if (!m) { out(`${name}  ${where}  not an inherited runtime — no ${MANIFEST_REL}${outside}`); continue; }
    out(`${name}  ${where}${outside}`);
    const agentCount = trackedDelegates(m).length;
    out(`  skills=${trackedSkills(m).length}${agentCount ? `  delegates=${agentCount}` : ""}`
      + `  inherited-from=${m.source?.commit ?? "?"}  at=${m.source?.inherited_at ?? "?"}  (known via ${known})`);
  }
}

function cmdForget(repoRoot, flags, positional) {
  const name = flags.name ?? positional[0];
  if (!name) die("missing runtime name (--name <n>)", 2);
  out(forgetRuntime(repoRoot, name)
    ? `forgot '${name}' — the registry entry is gone; the runtime's own files were NOT touched`
    : `'${name}' was not registered — nothing to forget`);
}

/**
 * The machine-readable half of `plan`.
 *
 * WHY THIS EXISTS. `scripts/framework-core-publish.mjs` derived the release's whole composition by
 * REGEXING this command's prose — matching the skills header, the two-space row indent, and the
 * bracketed reason tokens. That is a contract nobody could see: the day the header gained a
 * "including N required" suffix, the parser silently matched nothing and the release lost its entire
 * skill list, and with it every skill path in the pending-file scan. A publisher deciding what
 * changed must not be reading a sentence written for a human.
 *
 * Everything here is byte-sorted, never locale-sorted: this feeds a generated, committed release
 * record, and `localeCompare` orders by the host's ICU locale — the same defect that made the memory
 * faces regenerate differently on a Thai host than on a C one.
 */
function emitPlanJson(repoRoot, { name, dir, skills, required, reasons, packSkills, asCore, flags }) {
  const requiredSet = new Set(required);
  const byteSort = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const rows = [];
  const problems = [];
  const totals = { copied_files: 0, copied_bytes: 0, excluded_files: 0, excluded_bytes: 0 };
  const excludedByClass = {};

  // Deliberately a WARNING, not a problem. `plan` writes nothing, and a caller that only wants the
  // composition (status, the bump classifier) never passes --core-version — so counting this as a
  // policy violation would make every ordinary status report one it cannot act on, which is how a
  // violations list stops being read at all.
  const warnings = [];
  if (asCore && !flags["core-version"]) {
    warnings.push("--as-core is in effect and --core-version is absent — create will refuse");
  }

  for (const skill of [...skills].sort(byteSort)) {
    const found = resolveSkill(repoRoot, skill);
    if (!found) {
      rows.push({ skill, found: false, required: requiredSet.has(skill), reasons: reasons[skill] ?? [] });
      problems.push(requiredSet.has(skill)
        ? `required skill '${skill}' is missing from the source repo — a defect in presets.yaml's required: block`
        : `selected skill '${skill}' is missing from the source repo`);
      continue;
    }
    // Projected with the SAME options the forge uses, so what this reports is what would ship.
    const projection = projectSkillRuntime(found.dir, {
      skill,
      requireManifest: asCore,
      deny: (rel) => isDenied(rel.split("/").join(sep)),
    });
    for (const error of projection.errors) problems.push(error);
    totals.copied_files += projection.counts.copied_files;
    totals.copied_bytes += projection.counts.copied_bytes;
    totals.excluded_files += projection.counts.excluded_files;
    totals.excluded_bytes += projection.counts.excluded_bytes;
    for (const [klass, counts] of Object.entries(projection.counts.by_class)) {
      if (!excludedByClass[klass]) excludedByClass[klass] = { files: 0, bytes: 0 };
      excludedByClass[klass].files += counts.files;
      excludedByClass[klass].bytes += counts.bytes;
    }
    const unmet = declaredDependencies(found.dir).filter((d) => !skills.includes(d));
    for (const dep of unmet) problems.push(`${skill} declares depends-on '${dep}', which is not selected`);
    rows.push({
      skill,
      found: true,
      origin: found.origin,
      version: skillVersion(found.dir),
      required: requiredSet.has(skill),
      reasons: [...(reasons[skill] ?? [])].sort(byteSort),
      unmet_dependencies: unmet,
      projection: {
        copied_files: projection.counts.copied_files,
        copied_bytes: projection.counts.copied_bytes,
        excluded_files: projection.counts.excluded_files,
        excluded_bytes: projection.counts.excluded_bytes,
        excluded_by_class: projection.counts.by_class,
      },
    });
  }

  const substrate = [...CORE_SURFACES, ...Object.values(OPTIONAL_SURFACES).flat(), ...CLI_WIRING, "scripts"]
    .filter((s) => existsSync(join(repoRoot, ...s.split("/"))))
    .sort(byteSort);

  process.stdout.write(`${JSON.stringify({
    schema: 1,
    runtime: name,
    target: displayPath(repoRoot, dir),
    target_exists: existsSync(dir),
    as_core: asCore,
    preset: csv(flags.preset).sort(byteSort),
    pack_skills: packSkills.mode,
    skills: rows,
    skill_names: [...skills].sort(byteSort),
    required_floor: [...required].sort(byteSort),
    substrate,
    agent_packs: {
      shipped: packSkills.packs,
      contributed: [...packSkills.skills].sort(byteSort),
      declared: [...packSkills.seeds].sort(byteSort),
      via_closure: [...packSkills.viaClosure].sort(byteSort),
    },
    payload: { totals, excluded_by_class: excludedByClass },
    // Named here so a consumer grading the FORGED tree does not need a second copy of the policy.
    // The publisher's composition gate reads this rather than importing the projector: a local
    // duplicate of the list is exactly the divergence one projection function exists to prevent.
    runtime_excluded_dirs: [...RUNTIME_EXCLUDED_DIRS],
    problems: [...new Set(problems)].sort(byteSort),
    warnings: [...new Set(warnings)].sort(byteSort),
  }, null, 2)}\n`);
}

async function cmdPlan(repoRoot, flags, positional) {
  const { name, dir } = resolveRuntime(repoRoot, flags, positional);
  const { operator, required, all: selection, reasons } = resolveSkillSelection(repoRoot, flags);
  const requiredSet = new Set(required);
  const delegates = resolveDelegateSelection(repoRoot, flags);
  const includeMemory = truthyFlag(flags["delegate-memory"]);
  const asCore = truthyFlag(flags["no-as-core"])
    ? false : (truthyFlag(flags["as-core"]) || csv(flags.preset).includes("framework"));
  if (!operator.length) die("no skills selected (--skills a,b or --preset <name>; 'skills' lists both)", 2);
  const packSkills = await packSkillsFor(repoRoot, flags, asCore);
  const skills = unionPackSkills(selection, packSkills, reasons);

  // Before ANY prose. A JSON consumer parses this stream, so a warning printed above the payload is
  // not a warning to it — it is a parse error, and the caller's fallback then looks like a missing
  // engine rather than a missing flag. In JSON mode the same fact travels inside `problems`.
  if (truthyFlag(flags.json)) {
    emitPlanJson(repoRoot, { name, dir, skills, required, reasons, packSkills, asCore, flags });
    return;
  }

  // A warning, not a refusal: `plan` writes nothing, so the missing flag costs nothing here — but
  // saying it now is what stops the operator discovering it after typing out a create.
  if (asCore && !flags["core-version"]) {
    out("WARNING: --as-core is in effect and --core-version is absent — `create` will REFUSE.");
    out("         The core's version is its own line, not this repo's package.json version.");
    out("");
  }

  const avail = listAvailableSkills(repoRoot);
  const universe = new Set([...avail.active, ...avail.offloaded]);

  out(`plan: runtime '${name}' -> ${displayPath(repoRoot, dir)}`);
  out(`target exists: ${existsSync(dir) ? "YES — create would refuse without --force" : "no"}`);
  out("");
  // The floor is marked rather than listed apart, so the operator reads one skill list and can still
  // see which members they did not ask for.
  out(`skills (${skills.length}${required.length ? `, including ${required.length} required` : ""}):`);
  const dirs = [];
  const unmetDeps = [];
  for (const s of skills) {
    const f = resolveSkill(repoRoot, s);
    if (!f) {
      out(`  ${s}  NOT FOUND${requiredSet.has(s)
        ? "  [required — this is a defect in the SOURCE repo's presets.yaml, not a typo]" : ""}`);
      continue;
    }
    dirs.push(f.dir);
    const refs = referencedSkills(f.dir, universe);
    const missingDeps = declaredDependencies(f.dir).filter((d) => !skills.includes(d));
    const unsel = (r) => !skills.includes(r) && !missingDeps.includes(r);
    const wired = refs.wired.filter(unsel);
    const inComment = refs.codeComment.filter(unsel);
    const mentioned = refs.mentioned.filter(unsel);
    const floor = requiredSet.has(s) ? "  [required]" : "";
    const why = reasons[s]?.length ? `  [${reasons[s].join(", ")}]` : "";
    out(`  ${s}  ${f.origin}  v${skillVersion(f.dir) ?? "-"}${floor}${why}`);
    if (missingDeps.length) {
      out(`      MISSING DEP (declared depends-on): ${missingDeps.join(", ")}`);
      for (const d of missingDeps) unmetDeps.push(`${s} -> ${d}`);
    }
    if (wired.length) out(`      wired to (not selected): ${wired.join(", ")}`);
    if (inComment.length) out(`      named in script comments only (not selected): ${inComment.join(", ")}`);
    if (flags.verbose && mentioned.length) out(`      mentions in prose only: ${mentioned.join(", ")}`);
  }
  out("");
  if (unmetDeps.length) {
    out(`!! ${unmetDeps.length} declared dependency(ies) unmet — the skill's own frontmatter says it needs these:`);
    for (const d of unmetDeps) out(`     ${d}`);
    out("   Add them with --skills, or accept that the depending skill will fail at that step.");
    out("");
  }
  if (packSkills.packs) {
    out(`agent packs: ${packSkills.packs} shipped, contributing ${packSkills.skills.length} skill(s) `
      + `to this core (--pack-skills ${packSkills.mode})`);
    if (packSkills.seeds.length) out(`  declared by the packs: ${packSkills.seeds.join(", ")}`);
    if (packSkills.viaClosure.length) {
      out(`  pulled in by those skills' own declared siblings (${packSkills.viaClosure.length}): ${packSkills.viaClosure.join(", ")}`);
    }
    if (packSkills.mode === "declared") {
      out("  --pack-skills closure would also ship each of these skills' declared siblings;");
      out("  --pack-skills none ships neither. Default is 'declared' — a core stays substrate.");
    }
    out("  These are NOT part of the required floor — they are here because this core ships the packs.");
    out("");
  }
  if (delegates.length) {
    out(`delegate agents (${delegates.length})  surface: agent.yaml + routines/`
      + `${includeMemory ? " + memory/" : " (memory/ NOT included — pass --delegate-memory)"}:`);
    for (const a of delegates) {
      const f = resolveDelegate(repoRoot, a);
      if (!f) { out(`  ${a}  NOT FOUND`); continue; }
      const wd = delegateWorkDir(f.dir);
      out(`  ${a}${wd ? `      charter default_work_dir='${wd}' — points at the source repo's layout` : ""}`);
    }
    if (!skills.some((s) => DELEGATE_SKILL_RE.test(s))) {
      out("      NOTE: no sk-agent-* skill selected. The 'sidekicks agent' CLI verbs travel");
      out("            with lib/ and still work, but nothing documents driving these agents.");
    }
    out("      never copied per agent: runtime/ (presence, mailbox, threads, PIDs) and .bridge/");
    out("            (bridge token, telegram bot_token) — both recreated locally on demand.");
    out(`      operating scripts claimed by carrying agents: ${DELEGATE_SCRIPT_FILES.join(", ")}, `
      + `${DELEGATE_SCRIPT_SUBDIRS.map((d) => `${d}/`).join(", ")}`);
    out("");
    const staleAgents = unselectedDelegates(dir, delegates);
    if (staleAgents.length) {
      out(`already in the runtime, NOT in this delegate selection (${staleAgents.length}):`);
      for (const a of staleAgents) out(`  ${a}`);
      out(flags["prune-delegates"]
        ? "  --prune-delegates is set: 'create' would DELETE these from the runtime."
        : "  kept as-is; pass --prune-delegates to 'create' to delete them and make the set exact.");
      out("");
    }
  }

  // Dry preview of the one destructive part of a re-forge, so it is visible before it runs.
  const stale = unselectedSkills(dir, skills);
  if (stale.length) {
    out(`already in the runtime, NOT in this selection (${stale.length}):`);
    for (const s of stale) out(`  ${s}`);
    out(flags["prune-skills"]
      ? "  --prune-skills is set: 'create' would DELETE these from the runtime."
      : "  kept as-is; pass --prune-skills to 'create' to delete them and make the set exact.");
    out("");
  }
  out("core substrate — copied, never linked:");
  for (const s of [...CORE_SURFACES, ...Object.values(OPTIONAL_SURFACES).flat(), ...CLI_WIRING, "scripts"]) {
    if (existsSync(join(repoRoot, ...s.split("/")))) out(`  ${s}`);
  }
  out("");
  if (asCore) {
    const inventory = configurationInventory(repoRoot);
    out(`configuration inventory (${inventory.filter((r) => r.mode).length} safe entries; core only):`);
    for (const row of inventory) {
      if (row.mode) out(`  ${row.destination}  ${row.classification}  <- ${row.initializer_origin}`);
      else if (row.classification === 'missing-initializer') out(`  FAIL ${row.destination}  missing ${row.initializer_origin}`);
    }
    out("");
  }
  out("never copied (secrets / machine state / source memory):");
  out(`  ${[...DENY].sort().join(", ")}`);
  out(`  patterns: ${DENY_PATTERNS.map((re) => re.source).join(", ")}`);
  out("");
  out("scripts/: top-level files travel by OWNERSHIP — framework-floor hooks, hooks owned by a");
  out("selected skill, and manifest framework_files/framework_hooks claims. Unowned files stay behind");
  out("(--full-scripts overrides).");
  out("");
  out("python requirements resolved from the selected skills' imports:");
  reportRequirements(resolveRequirements(repoRoot, dirs));
}

async function cmdCreate(repoRoot, flags, positional) {
  const { name, dir } = resolveRuntime(repoRoot, flags, positional);
  const { operator, required, all: selection, reasons } = resolveSkillSelection(repoRoot, flags);
  const delegates = resolveDelegateSelection(repoRoot, flags);
  const includeMemory = truthyFlag(flags["delegate-memory"]);
  const presetNames = csv(flags.preset);
  const asCore = truthyFlag(flags["no-as-core"])
    ? false : (truthyFlag(flags["as-core"]) || presetNames.includes("framework"));
  // Derived from the agent packs this core is about to ship — see resolvePackSkills. Resolved
  // AFTER asCore, because an ordinary runtime ships no pack and so derives nothing.
  const packSkills = await packSkillsFor(repoRoot, flags, asCore);
  const skills = unionPackSkills(selection, packSkills, reasons);
  // Resolved HERE, before the first write: the monotonic check reads the marker the target still
  // carries, and --force is about to overwrite it. Deciding this after the forge would compare the
  // new version against itself.
  const coreVersion = asCore ? requireCoreVersion(dir, flags) : null;
  // Gated on the OPERATOR's selection, not the union: the required floor must never turn a
  // selection-less invocation into a silently forged four-skill runtime.
  if (!operator.length) die("no skills selected (--skills a,b or --preset <name>)", 2);
  if (existsSync(dir) && !flags.force) {
    die(`${displayPath(repoRoot, dir)} already exists — use 'add'/'patch' to update it, or --force to rebuild`, 3);
  }
  preflightSkills(repoRoot, skills, packSkills.skills);
  preflightDelegates(repoRoot, delegates);

  if (isInsideRepo(repoRoot, dir)) warnIfProjectScoped(repoRoot);

  const sourceCommit = gitHead(repoRoot);

  // SCAN THE DESTINATION BEFORE THE FIRST WRITE. A core is regenerated wholesale, so what is there
  // now is the only record of the release being replaced — and the copy below overwrites it. The
  // README's release-delta section is rendered from this snapshot at the end of the forge.
  const destBefore = snapshotCoreTree(dir);

  mkdirp(dir);

  const manifest = {
    schema: SCHEMA,
    runtime: name,
    direction: "one-way: sidekicks source -> this runtime",
    source: {
      repo: basename(repoRoot),
      commit: sourceCommit,
      inherited_at: nowBangkok(),
      tool: "sk-inherit",
    },
    // Recorded so later verbs (add, verify) apply the same scripts/ ownership stance.
    options: { full_scripts: Boolean(flags["full-scripts"]) },
    units: {},
    configuration: [],
  };

  out(`forging runtime '${name}' at ${displayPath(repoRoot, dir)}`);
  out("");
  out("skills:");
  const { inherited, warnings } = inheritSkills(repoRoot, dir, skills, {
    sourceCommit, manifest, verbose: false, reasons, asCore,
  });
  for (const s of inherited) {
    const floor = required.includes(s.name) ? "  [required]" : "";
    const why = reasons[s.name]?.length ? `  [${reasons[s.name].join(", ")}]` : "";
    out(`  ${s.name}  ${s.origin}  v${s.version ?? "-"}  ${s.files} files`
      + floor + why);
  }

  // Opt-in: make the runtime's skill set EXACTLY the selection. On a --force re-forge this is what
  // removes whatever an earlier inherit left behind.
  const pruned = flags["prune-skills"] ? pruneUnselectedSkills(dir, manifest, skills) : [];
  if (pruned.length) {
    out("");
    out(`pruned (--prune-skills — present in the runtime, not in this selection):`);
    for (const p of pruned) out(`  ${p}`);
  }

  // Delegate agents travel only when named. Their charters are hand-amended in the runtime, so each
  // one is baselined like a skill and drift-tracked the same way.
  const delegateRes = inheritDelegates(repoRoot, dir, delegates, {
    sourceCommit, manifest, includeMemory, skillNames: skills,
  });
  if (delegates.length) {
    out("");
    out(`delegate agents (charter + routines${includeMemory ? " + memory" : ""}):`);
    for (const a of delegateRes.inherited) out(`  ${a.name}  ${a.files} files`);
    if (!includeMemory) {
      out("  memory/ NOT inherited — an agent's memory records the SOURCE repo's decisions");
      out("  (--delegate-memory opts in). runtime/ and .bridge/ never travel at all.");
    }
  }
  const prunedAgents = flags["prune-delegates"] ? pruneUnselectedDelegates(dir, manifest, delegates) : [];
  if (prunedAgents.length) {
    out("");
    out(`pruned (--prune-delegates — delegate agents in the runtime, not in this selection):`);
    for (const p of prunedAgents) out(`  ${p}`);
  }

  out("");
  out("core substrate (copies — no link points back at the source repo):");
  for (const c of copyCoreSurfaces(repoRoot, dir, skills, {
    agents: !flags["no-agents"],
    commands: !flags["no-commands"],
  })) out(`  ${c}`);
  if (asCore) {
    const configSurface = copyConfigurationSurface(repoRoot, dir);
    manifest.configuration = configSurface.inventory;
    out(`  configuration (${configSurface.copied.length} safe discovered template(s))`);
    for (const row of configSurface.inventory.filter((r) => r.classification === 'missing-initializer')) {
      out(`  WARNING configuration contract incomplete: ${row.destination} needs ${row.initializer_origin}`);
    }
  }
  const scriptsRes = await copyScriptsSurface(repoRoot, dir, skills, {
    fullScripts: Boolean(flags["full-scripts"]),
    exact: true,
    hasDelegates: delegates.length > 0,
    hasSubagents: !flags["no-agents"],
  });
  out(`  scripts (${scriptsRes.copied})`);
  if (scriptsRes.skipped.length) {
    out(`  scripts skipped — no selected skill owns them (${scriptsRes.skipped.length}):`);
    out(`    ${scriptsRes.skipped.join(", ")}`);
  }

  writeRuntimeScaffold(dir, name);

  const reqs = resolveRequirements(repoRoot, skills.map((s) => join(dir, '.agents', 'skills', s)));
  const needsVenv = reqs.pinned.length > 0 || reqs.unpinned.length > 0;
  const venvResult = needsVenv
    ? buildVenv(dir, reqs, { install: !flags["no-venv"] })
    : { ok: true, installed: false, note: "no python dependency in the selected skills — no venv created" };
  // A requirements.txt left by an EARLIER forge is not evidence that this one needs Python.
  // v2.0.0 shipped `PyYAML==6.0.2` and `pytest==9.0.3` in a core whose five skills contain no .py
  // at all (F-12): a previous, larger selection had written the file and nothing ever removed it.
  // Only the generated file is removed — a hand-authored one has no engine header to match.
  const staleReq = join(dir, "requirements.txt");
  let reqPruned = false;
  if (!needsVenv && existsSync(staleReq)) {
    if (readFileSync(staleReq, "utf8").startsWith("# Generated by sk-inherit")) {
      rmSync(staleReq, { force: true });
      reqPruned = true;
    }
  }

  writeRuntimeAgentsMd(dir, {
    name, skillNames: skills, delegateNames: delegates, sourceCommit,
    hasVenv: needsVenv && venvResult.installed,
  });
  writeInstructionMirrors(dir);

  // A runtime forged from the `framework` preset exists to BE the distributable core, so the
  // distribution files are on by default there; --as-core opts any other selection in, --no-as-core
  // out. Must run after writeRuntimeAgentsMd — AGENTS.framework.md is derived from that output.
  const coreDist = asCore
    ? writeCoreDistribution(repoRoot, dir, {
        name,
        sourceCommit,
        skillCount: skills.length,
        remote: flags.remote ? String(flags.remote) : null,
        ref: flags["core-ref"] ? String(flags["core-ref"]) : null,
        version: coreVersion,
      })
    : null;

  const droppedHooks = pruneHookWiring(dir);
  const droppedPlugins = prunePluginDeclarations(dir, loadHostPlugins());
  writeManifest(dir, manifest);

  // Self-heal the runtime's OWN exposure links and index by running its OWN CLI (Rule 3).
  const linkRes = refreshRuntimeIndex(dir);
  const fwRes = syncRuntimeFramework(dir);
  const configRes = syncRuntimeConfig(dir);
  // The example must describe THIS runtime's skills, not the source repo's whole bench.
  const cfgTrim = trimRuntimeConfigExample(dir, inherited.map((s) => s.name));

  // The README goes last: it documents the release, so it can only be written once every file it
  // describes is on disk — after the hook prune, the manifest, the index rebuild and the framework
  // re-sync. Rendering it earlier reported those steps as changes on every forge.
  const readme = coreDist ? writeCoreReadme(dir, coreDist.vars, destBefore) : null;

  const git = initRuntimeGit(dir, flags.remote ? String(flags.remote) : null);
  const gitignoreTouched = isInRuntimesDir(repoRoot, dir) ? ensureSourceGitignore(repoRoot) : false;
  registerRuntime(repoRoot, name, dir);

  out("");
  out("python:");
  reportRequirements(reqs);
  out(`  ${venvResult.note}`);

  out("");
  out("generated:");
  out("  AGENTS.md — minimal, lists only this runtime's skills");
  out("  CLAUDE.md, GEMINI.md — mirrors of AGENTS.md (Rule 6)");
  out("  .sidekicks/settings.json, .sidekicks/memory/ — EMPTY; source memory is never inherited");
  if (delegates.length) {
    out(`  .sidekicks/${DELEGATES_DIRNAME}/ — ${delegates.length} delegate agent(s): `
      + `${delegates.join(", ")} (bring them online with 'sidekicks agent')`);
  }
  out(`  .sidekicks/config/settings/ — enable map inherited, then re-synced: ${fwRes.note}`);
  out(`  .sidekicks/config/ — inert templates for inherited skills: ${configRes.note}`);
  if (cfgTrim.dropped.length) {
    out(`  .sidekicks/config.example.yaml — trimmed to this runtime's skills; dropped `
      + `${cfgTrim.dropped.length} block(s) nothing here declares: ${cfgTrim.dropped.join(", ")}`);
  }
  out(`  .gitignore, package.json (npm test → ${RUNTIME_TEST_COMMAND})`
    + `${needsVenv ? ", requirements.txt" : " — no requirements.txt: nothing here needs Python"}`
    + `${reqPruned ? " (a stale generated requirements.txt from an earlier forge was removed)" : ""}`);
  out(`  ${MANIFEST_REL} — baseline hashes for drift detection`);
  if (coreDist) {
    out("");
    out("core distribution (this runtime is mountable as a framework core):");
    for (const f of coreDist.files) out(`  ${f}`);
    for (const n of coreDist.notes) out(`  NOTE: ${n}`);
    out("  install it from a workspace with:  sh install.sh --dir <workspace>");
  }
  if (readme) {
    const d = readme.delta;
    out("");
    out("release delta (destination scanned BEFORE the forge; generated headers masked):");
    if (d.first) {
      out(`  first release into this destination — all ${readme.total} shipped file(s) are new`);
    } else if (!d.added.length && !d.changed.length && !d.removed.length) {
      out(`  NO shipped file changed since ${d.prevVersion ? `v${d.prevVersion}` : "the previous forge"}`
        + " — only the generated headers differ");
    } else {
      out(`  vs ${d.prevVersion ? `v${d.prevVersion}` : "the previous forge"}: `
        + `${d.added.length} added, ${d.changed.length} changed, ${d.removed.length} removed`);
      for (const s of d.surfaces.slice(0, 8)) {
        out(`    ${s.surface.replace(/`/g, "")}: +${s.added} ~${s.changed} -${s.removed}`);
      }
      if (d.surfaces.length > 8) out(`    … ${d.surfaces.length - 8} more surface(s), all in the README table`);
      if (d.skillsRemoved.length) out(`    SKILLS REMOVED: ${d.skillsRemoved.join(", ")}`);
    }
    out("  written into README.md — a consumer reads it before running 'core update'");
  }
  if (droppedHooks.length) {
    out("");
    out("hooks pruned (referenced a script that did not travel):");
    for (const d of droppedHooks) out(`  ${d}`);
  }
  if (droppedPlugins.length) {
    out("");
    out("third-party plugin declarations pruned (not in presets.yaml host_plugins:):");
    for (const d of droppedPlugins) out(`  ${d}`);
  }
  out("");
  out(`git: ${git.initialized ? "initialized" : "already a repo"}${git.remote ? `, origin=${git.remote}` : ""}${git.note ? ` (${git.note})` : ""}`);
  out("     nothing is committed or pushed — review, then commit in the runtime yourself");
  if (gitignoreTouched) out("source .gitignore: added /runtimes/");
  out(`location: ${displayPath(repoRoot, dir)} — remembered as '${name}', so later verbs need only --name`);
  if (!isInsideRepo(repoRoot, dir)) {
    out("          this target is OUTSIDE the sidekicks repo, so it is outside the free-write surface;");
    out("          you authorized it by passing --target, and the parent repo neither tracks nor ignores it");
  }
  if (!linkRes.ok) {
    out(`WARNING: the runtime's own CLI did not run cleanly — exposure links may be missing: ${linkRes.note}`);
  }
  if (!fwRes.ok) {
    out(`WARNING: the runtime's framework enable map was not re-synced — ${fwRes.note}`);
  }
  if (!configRes.ok) {
    out(`WARNING: runtime configuration templates were not prepared — ${configRes.note}`);
  }
  if (!venvResult.ok) {
    out(`WARNING: the runtime is assembled but its Python venv is NOT usable — ${venvResult.note}`);
    process.exitCode = 11;
  }
  const allWarnings = [...warnings, ...delegateRes.warnings];
  if (allWarnings.length) {
    out("");
    out("WARNINGS:");
    for (const w of allWarnings) out(`  ${w}`);
  }
  out("");
  out(`next: cd ${displayPath(repoRoot, dir)} && node bin/sidekicks --help`);
}

async function cmdAdd(repoRoot, flags, positional) {
  const { name, dir, source } = resolveRuntime(repoRoot, flags, positional);
  const manifest = requireManifest(dir, name);
  adoptIfTargeted(repoRoot, name, dir, source);
  // `add` names only the NEW units, so the floor is deliberately NOT unioned in here: a runtime that
  // is missing one is repaired by `patch` (drift reports it as MISSING REQUIRED), not by every `add`
  // invocation re-reporting the same six skills as "already inherited".
  const { operator: selected, reasons } = resolveSkillSelection(repoRoot, flags);
  const selectedDelegates = resolveDelegateSelection(repoRoot, flags);
  if (!selected.length && !selectedDelegates.length) {
    die("nothing selected (--skills a,b, --preset <name>, or --delegates a,b)", 2);
  }
  // `add` is additive: its selection names only the NEW units, so pruning against it would delete
  // everything already inherited. Refuse rather than reinterpret the flag into something else.
  for (const f of ["prune-skills", "prune-delegates"]) {
    if (!flags[f]) continue;
    die(`--${f} is a 'create' flag; 'add' is additive and its selection is only the new units, `
      + "so pruning against it would delete the rest of the runtime.\n"
      + `         To make the set exact, re-forge: create --force --${f}`, 2);
  }

  const already = selected.filter((s) => manifest.units[`skills/${s}`]);
  const fresh = selected.filter((s) => !manifest.units[`skills/${s}`]);
  const agentsAlready = selectedDelegates.filter((a) => manifest.units[`agents/${a}`]);
  const agentsFresh = selectedDelegates.filter((a) => !manifest.units[`agents/${a}`]);
  if (already.length) out(`already inherited — use 'patch' to update: ${already.join(", ")}`);
  if (agentsAlready.length) out(`delegate agents already inherited — use 'patch': ${agentsAlready.join(", ")}`);

  // A runtime can carry delegate agents while missing the scripts that operate them — either it was
  // forged before those scripts were claimed, or one was deleted. `patch` cannot fix it (it syncs
  // units, not the scripts surface), so an otherwise no-op `add` falls through to re-register the
  // surface instead of dead-ending on "nothing to add". Idempotent: the same claim resolution runs.
  // "Carries delegate agents" is tracked ∪ physically present, matching cmdVerify's check 10: the
  // failure verify emits must be clearable by the command it names, and an agent the manifest lost
  // (or never had) is exactly the case where verify now speaks up.
  const opsStale = presentDelegates(dir, manifest).size > 0 && [
    ...DELEGATE_SCRIPT_FILES.filter((f) => existsSync(join(repoRoot, "scripts", f))
      && !existsSync(join(dir, "scripts", f))),
    ...DELEGATE_SCRIPT_SUBDIRS.filter((d) => existsSync(join(repoRoot, "scripts", d))
      && !existsSync(join(dir, "scripts", d))),
  ].length > 0;

  if (!fresh.length && !agentsFresh.length) {
    if (!opsStale) { out("nothing to add"); return; }
    out("");
    out("nothing new to inherit, but this runtime carries delegate agents without the scripts that");
    out("operate them — re-registering the scripts surface.");
  }

  preflightSkills(repoRoot, fresh);
  preflightDelegates(repoRoot, agentsFresh);
  const sourceCommit = gitHead(repoRoot);
  const { inherited, warnings } = inheritSkills(repoRoot, dir, fresh, {
    sourceCommit, manifest, verbose: false, reasons, asCore: isCoreRuntime(dir),
  });
  if (inherited.length) out("added:");
  for (const s of inherited) out(`  ${s.name}  ${s.origin}  v${s.version ?? "-"}  ${s.files} files`);

  // A delegate added later inherits the memory stance of THIS run, recorded per agent.
  const includeMemory = truthyFlag(flags["delegate-memory"]);
  const delegateRes = inheritDelegates(repoRoot, dir, agentsFresh, {
    sourceCommit, manifest, includeMemory,
    skillNames: [...new Set([...trackedSkills(manifest), ...fresh])],
  });
  if (agentsFresh.length) {
    out(`delegate agents added (charter + routines${includeMemory ? " + memory" : ""}):`);
    for (const a of delegateRes.inherited) out(`  ${a.name}  ${a.files} files`);
  }

  // Re-register the scripts/ surface for the FULL tracked set (AAP-111): the new skill's owned
  // scripts travel in, and its hook wiring comes back by re-copying the four per-CLI configs
  // verbatim from the source, then re-pruning whatever still has no script. Those configs are
  // inherited surface — runtime-local edits to them are overwritten here.
  const all = trackedSkills(manifest);
  // Same tracked ∪ present notion as cmdVerify's check 10 — and safe to widen here because this
  // call is made WITHOUT opts.exact, so it only ever ADDS to the scripts surface.
  const scriptsRes = await copyScriptsSurface(repoRoot, dir, all, {
    fullScripts: Boolean(manifest.options?.full_scripts),
    hasDelegates: presentDelegates(dir, manifest).size > 0,
    hasSubagents: existsSync(join(dir, ".agents", "subagents")),
  });
  for (const rel of [".claude/settings.json", ".codex/config.toml", ".gemini/settings.json", ".agent/settings.json"]) {
    const src = join(repoRoot, ...rel.split("/"));
    if (!existsSync(src)) continue;
    const dst = join(dir, ...rel.split("/"));
    rmSync(dst, { recursive: true, force: true });
    copyTree(src, dst);
  }
  const droppedHooks = pruneHookWiring(dir);
  const droppedPlugins = prunePluginDeclarations(dir, loadHostPlugins());
  out("");
  out(`scripts registered for the full skill set: ${scriptsRes.copied} file(s); hook wiring refreshed`);
  out(`from source across the four CLI configs (${droppedHooks.length} entr${droppedHooks.length === 1 ? "y" : "ies"} pruned — script did not travel).`);
  if (droppedPlugins.length) {
    out(`third-party plugin declarations pruned (${droppedPlugins.length}): ${droppedPlugins.join("; ")}`);
  }
  out("NOTE: runtime-local edits to those four configs are inherited surface and were overwritten.");

  // A new skill may pull new Python dependencies.
  const reqs = resolveRequirements(repoRoot, all.map((s) => join(dir, '.agents', 'skills', s)));
  let hasVenv = existsSync(join(dir, ".venv"));
  if (reqs.pinned.length || reqs.unpinned.length) {
    const v = buildVenv(dir, reqs, { install: !flags["no-venv"] });
    out("");
    out("python:");
    reportRequirements(reqs);
    out(`  ${v.note}`);
    hasVenv = hasVenv || v.installed;
    if (!v.ok) process.exitCode = 11;   // the skill is inherited but cannot run yet — say so
  }

  writeRuntimeAgentsMd(dir, {
    name, skillNames: all, delegateNames: trackedDelegates(manifest),
    sourceCommit: manifest.source?.commit ?? sourceCommit,
    hasVenv,
  });
  writeInstructionMirrors(dir);
  writeManifest(dir, manifest);
  const idx = refreshRuntimeIndex(dir);
  // A new skill may own rules or criteria the runtime's enable map does not list yet.
  const fw = syncRuntimeFramework(dir);
  const config = syncRuntimeConfig(dir);
  out("");
  out(`AGENTS.md regenerated with the new skill set; ${idx.note}; ${fw.note}; ${config.note}`);
  if (!config.ok) out("WARNING: runtime configuration templates were not prepared — run config sync in the runtime before using the new skill.");
  const allWarnings = [...warnings, ...delegateRes.warnings];
  if (allWarnings.length) {
    out("");
    out("WARNINGS:");
    for (const w of allWarnings) out(`  ${w}`);
  }
}

function cmdDrift(repoRoot, flags, positional) {
  const { name, dir, source } = resolveRuntime(repoRoot, flags, positional);
  const manifest = requireManifest(dir, name);
  adoptIfTargeted(repoRoot, name, dir, source, { quiet: Boolean(flags.json) });
  const rows = classifySkills(repoRoot, dir, manifest);
  const agentRows = classifyDelegates(repoRoot, dir, manifest);
  const configurationRows = classifyConfiguration(repoRoot, dir, manifest);
  const all = [...rows, ...agentRows, ...configurationRows];

  if (flags.json) {
    out(JSON.stringify({
      runtime: name,
      source_commit_at_inherit: manifest.source?.commit ?? null,
      source_commit_now: gitHead(repoRoot),
      skills: rows,
      delegates: agentRows,
      configuration: configurationRows,
    }, null, 2));
    if (all.some((r) => r.status !== "up-to-date")) process.exitCode = 10;
    return;
  }

  out(`runtime '${name}'  inherited from ${manifest.source?.commit ?? "?"}  source now at ${gitHead(repoRoot)}`);
  out("");
  printDriftTable(rows);
  if (agentRows.length) {
    out("");
    out("delegate agents (charter + routines; runtime/ state is never compared):");
    printDriftTable(agentRows);
  }
  if (configurationRows.length) {
    out("");
    out("generated configuration:");
    printDriftTable(configurationRows);
  }
  out("");
  out(`summary: skills ${summarize(rows) || "nothing tracked"}`
    + `${agentRows.length ? ` · delegates ${summarize(agentRows)}` : ""}`
    + `${configurationRows.length ? ` · configuration ${summarize(configurationRows)}` : ""}`);
  const ff = all.filter((r) => r.status === "ff" || r.status === "missing-required");
  const conflict = all.filter((r) => r.status === "conflict");
  if (ff.length) out(`patchable now: ${ff.map((r) => r.name).join(", ")}`);
  if (conflict.length) out(`needs a human: ${conflict.map((r) => r.name).join(", ")} — both sides changed; patch refuses without --force`);

  // Non-zero when anything is out of date, so a caller can gate on it.
  if (all.some((r) => r.status !== "up-to-date")) process.exitCode = 10;
}

function cmdPatch(repoRoot, flags, positional) {
  const { name, dir, source } = resolveRuntime(repoRoot, flags, positional);
  const manifest = requireManifest(dir, name);
  adoptIfTargeted(repoRoot, name, dir, source);
  const rows = classifySkills(repoRoot, dir, manifest);
  const agentRows = classifyDelegates(repoRoot, dir, manifest);
  const configurationRows = classifyConfiguration(repoRoot, dir, manifest);
  const only = flags.only ? csv(flags.only) : null;
  const force = Boolean(flags.force);

  if (flags["dry-run"]) {
    out(`dry run — runtime '${name}'`);
    out("");
    printDriftTable(rows);
    if (agentRows.length) {
      out("");
      out("delegate agents:");
      printDriftTable(agentRows);
    }
    out("");
    const scoped = [...rows, ...agentRows].filter((r) => (only ? only.includes(r.name) : true));
    const would = scoped.filter((r) => r.status === "ff" || r.status === "missing-required"
      || (force && r.status !== "up-to-date" && r.status !== "untracked"));
    out(would.length ? `would patch: ${would.map((r) => r.name).join(", ")}` : "would patch: nothing");
    const held = scoped.filter((r) => r.status === "conflict" || r.status === "local-only");
    if (held.length && !force) out(`would hold back (runtime-side edits): ${held.map((r) => r.name).join(", ")}`);
    return;
  }

  const sourceCommit = gitHead(repoRoot);
  const skillRes = applyPatch(repoRoot, dir, manifest, rows, { force, only, sourceCommit });
  const agentRes = applyDelegatePatch(repoRoot, dir, manifest, agentRows, { force, only, sourceCommit });
  const applied = [...skillRes.applied, ...agentRes.applied];
  const refused = [...skillRes.refused, ...agentRes.refused];

  // A core's generated configuration is a release artifact, not user state. Refresh it wholesale
  // when the recorded inventory moved; ordinary runtimes have no configuration inventory at all.
  const configNeedsPatch = configurationRows.some((row) => row.status !== 'up-to-date');
  if (configNeedsPatch) {
    const surface = copyConfigurationSurface(repoRoot, dir, manifest.configuration);
    manifest.configuration = surface.inventory;
    applied.push({ name: 'configuration inventory', from: null, to: null,
      detail: `${surface.copied.length} safe entries refreshed${surface.removed.length ? `; ${surface.removed.length} obsolete entries removed` : ''}` });
    syncRuntimeFramework(dir);
    syncRuntimeConfig(dir);
  }

  if (applied.length) {
    manifest.source = { ...(manifest.source ?? {}), last_patch_commit: sourceCommit, last_patch_at: nowBangkok() };
    writeManifest(dir, manifest);
    refreshRuntimeIndex(dir);
    out("patched:");
    for (const a of skillRes.applied) {
      out(`  ${a.name}  ${a.from ?? "-"} -> ${a.to ?? "-"}${a.backup ? `  (previous runtime copy saved to ${a.backup})` : ""}`);
    }
    for (const a of agentRes.applied) {
      out(`  ${a.name}  (delegate agent)${a.backup ? `  (previous runtime copy saved to ${a.backup})` : ""}`);
    }
    const all = trackedSkills(manifest);
    writeRuntimeAgentsMd(dir, {
      name, skillNames: all, delegateNames: trackedDelegates(manifest),
      sourceCommit, hasVenv: existsSync(join(dir, ".venv")),
    });
    // Package requirements may have shifted with the new skill versions.
    const reqs = resolveRequirements(repoRoot, all.map((s) => join(dir, '.agents', 'skills', s)));
    if (reqs.pinned.length || reqs.unpinned.length) {
      const v = buildVenv(dir, reqs, { install: !flags["no-venv"] });
      out("");
      out(`python: ${v.note}`);
      if (reqs.unknown.length) reportRequirements(reqs);
      if (!v.ok) process.exitCode = 11;
    }
  } else {
    out("patched: nothing");
  }

  if (refused.length) {
    out("");
    out("held back:");
    for (const r of refused) out(`  ${r.name}  ${STATUS_LABEL[r.status]}${r.detail ? `  [${r.detail}]` : ""}`);
    out("");
    out("A conflict means the source AND the runtime both changed since inherit. Sync is one-way, so");
    out("the runtime's version is never promoted upstream: resolve by hand, or re-run with --force");
    out("(the runtime copy is saved under this run's resolved folder's backups/ first — see");
    out("`applied[].backup` above, or the pre-v2 artifacts/runs/inherit/backups/ on an older runtime).");
    process.exitCode = 10;
  }
}

function cmdVenv(repoRoot, flags, positional) {
  const { name, dir, source } = resolveRuntime(repoRoot, flags, positional);
  const manifest = requireManifest(dir, name);
  adoptIfTargeted(repoRoot, name, dir, source);
  const skills = trackedSkills(manifest);
  const reqs = resolveRequirements(repoRoot, skills.map((s) => join(dir, '.agents', 'skills', s)));

  out(`runtime '${name}' python dependencies (from ${skills.length} skill(s)):`);
  reportRequirements(reqs);
  if (flags.verbose && reqs.skipped.length) out(`  skipped: ${reqs.skipped.join(", ")}`);

  if (!reqs.pinned.length && !reqs.unpinned.length) return;
  if (flags["dry-run"]) { out("dry run — requirements.txt not written"); return; }
  if (flags.rebuild) rmSync(join(dir, ".venv"), { recursive: true, force: true });
  const v = buildVenv(dir, reqs, { install: !flags["no-venv"], force: Boolean(flags.rebuild) });
  out(v.note);
  if (!v.ok) process.exitCode = 11;
}

async function cmdVerify(repoRoot, flags, positional) {
  const { name, dir, source } = resolveRuntime(repoRoot, flags, positional);
  const manifest = requireManifest(dir, name);
  adoptIfTargeted(repoRoot, name, dir, source);
  const problems = [];
  const ok = [];
  const runtimeReal = realpathSync(dir);

  // 1. The no-link-back invariant: nothing inside the runtime may resolve outside it.
  const leaks = [];
  const walk = (abs) => {
    for (const e of readdirSync(abs)) {
      if (e === ".git" || e === ".venv" || e === "node_modules") continue;
      const p = join(abs, e);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) {
        const raw = readlinkSync(p);
        const target = isAbsolute(raw) ? raw : resolve(dirname(p), raw);
        let real = target;
        try { real = realpathSync(target); } catch { /* dangling — judge the literal target */ }
        if (!resolve(real).startsWith(runtimeReal)) leaks.push(`${relative(dir, p)} -> ${real}`);
      } else if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  if (leaks.length) problems.push(`links escape the runtime (would bind it to the source repo):\n          ${leaks.join("\n          ")}`);
  else ok.push("no link escapes the runtime — copies only");

  // 2. The runtime's own CLI must run.
  const cli = spawnSync(process.execPath, [join(dir, "bin", "sidekicks"), "index", "show", "--json"],
    { cwd: dir, encoding: "utf8" });
  if (cli.status !== 0) problems.push(`the runtime's CLI failed: ${(cli.stderr || cli.stdout || "").trim().split("\n")[0]}`);
  else ok.push("runtime CLI runs (index show)");

  // 3. Skills must be discoverable through the runtime's own exposure link.
  if (!existsSync(join(dir, ".claude", "skills"))) {
    problems.push(".claude/skills exposure link missing — run the runtime's own CLI once to self-heal it");
  } else ok.push(".claude/skills exposure link present");

  // 3a. The REQUIRED skill floor must be physically present. Every other check here asks whether
  // what the runtime carries is coherent; this one asks whether it carries enough to be operated at
  // all — a runtime that cannot orient itself, drive a CLI verb, align scope or validate its config
  // is broken even when every file in it is internally consistent. Judged on disk rather than from
  // the manifest, because a floor skill deleted after inheriting is exactly the case worth catching.
  const requiredFloor = loadRequiredSkills();
  if (requiredFloor.length) {
    const absent = requiredFloor.filter((s) => !existsSync(join(dir, '.agents', 'skills', s, "SKILL.md")));
    if (absent.length) {
      problems.push(`required skills missing from the runtime: ${absent.join(", ")} — `
        + "restore them with 'patch --name <n>' (no --force needed) or re-forge with 'create --force'");
    } else ok.push(`all ${requiredFloor.length} required skills present`);
  }

  // 4. Hooks must reference scripts that exist in the runtime.
  const settings = join(dir, ".claude", "settings.json");
  if (existsSync(settings)) {
    const text = readFileSync(settings, "utf8");
    const missing = [...text.matchAll(/(?:scripts|\.sidekicks[/\\]hooks)[/\\][\w.-]+\.(?:mjs|sh|py|js)/g)]
      .map((m) => m[0].replace(/\\/g, "/"))
      .filter((rel) => !existsSync(join(dir, ...rel.split("/"))));
    if (missing.length) problems.push(`hooks reference scripts that did not travel: ${[...new Set(missing)].join(", ")}`);
    else ok.push("every hook script resolves inside the runtime");
  }

  // 5. Python: a declared requirement set needs the runtime's own venv behind it.
  if (existsSync(join(dir, "requirements.txt"))) {
    const declared = readFileSync(join(dir, "requirements.txt"), "utf8")
      .split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
    if (declared.length && !existsSync(join(venvBin(dir), isWindows ? "pip.exe" : "pip"))) {
      problems.push(`requirements.txt declares ${declared.length} package(s) but the runtime has no usable .venv`);
    } else if (declared.length) ok.push(`runtime has its own .venv for ${declared.length} package(s)`);
  }

  // 6. The framework enable map must be present and materialised against the runtime's own
  // registry — otherwise the runtime silently re-enables whatever the source disabled, and the
  // committed file stops showing which rules and criteria this runtime actually carries.
  // Any layout the map has shipped in counts. Canonically it is the per-kind SETTINGS files at
  // .sidekicks/config/settings/{rules,criteria,hooks}.yaml (booleans, split by kind); a runtime
  // forged from a source that has not run `framework sync --split` still carries the pre-split
  // monolith, at .sidekicks/config/framework.yaml or the older top-level path — both of which the
  // framework reader also still honours.
  const settingsPresent = ["rules", "criteria", "hooks"].some((block) =>
    existsSync(join(dir, ".sidekicks", "config", "settings", `${block}.yaml`)));
  const fwPresent = settingsPresent
    || existsSync(join(dir, ".sidekicks", "config", "framework.yaml"))
    || existsSync(join(dir, ".sidekicks", "framework.yaml"));
  if (!fwPresent) {
    problems.push(".sidekicks/config/settings/ did not travel — every rule/criterion/hook "
      + "would resolve to the built-in default, re-enabling anything the source disabled");
  } else {
    const fw = spawnSync(process.execPath, [join(dir, "bin", "sidekicks"), "framework", "sync", "--check", "--json"],
      { cwd: dir, encoding: "utf8" });
    let payload = null;
    try { payload = JSON.parse(fw.stdout || "null"); } catch { /* fall through to the raw status */ }
    if (payload && payload.ok === false) {
      const missing = (payload.missing || []).join(", ");
      const unknown = (payload.unknown || []).join(", ");
      problems.push("the runtime's framework enable map is out of sync — run "
        + `'node bin/sidekicks framework sync --prune' in the runtime${missing ? `; unlisted: ${missing}` : ""}`
        + `${unknown ? `; orphaned: ${unknown}` : ""}`);
    } else if (fw.status !== 0) {
      problems.push(`framework sync --check failed in the runtime: ${(fw.stderr || fw.stdout || "").trim().split("\n")[0]}`);
    } else {
      const listed = payload ? `${payload.listed}/${payload.toggleable} entries` : "all entries";
      ok.push(`framework enable map materialised (${listed})`);
    }
  }

  // 6a. Every config block declared by a carried skill must be scaffolded in this runtime's root
  // scope. `config sync --check` is the canonical gap detector: it knows which defaults belong to
  // which installed skills and intentionally ignores live-block drift it cannot safely rewrite.
  {
    const config = spawnSync(process.execPath, [join(dir, "bin", "sidekicks"), "config", "sync", "--check", "--json"],
      { cwd: dir, encoding: "utf8" });
    let payload = null;
    try { payload = JSON.parse(config.stdout || "null"); } catch { /* fall through to raw status */ }
    if (config.status !== 0) {
      const missing = payload?.scopes?.flatMap((scope) => scope.items ?? [])
        .filter((item) => item.action === "add")
        .map((item) => item.block);
      problems.push("runtime configuration templates are incomplete — run "
        + `'node bin/sidekicks config sync' in the runtime${missing?.length ? `; missing: ${missing.join(", ")}` : ""}`);
    } else {
      const documented = payload?.totals?.skip ?? 0;
      ok.push(`configuration templates materialised for inherited skills (${documented} existing scaffold(s))`);
    }
  }

  // 6b. A framework core has an additional, source-independent configuration contract.
  // The manifest records the exact safe inventory that was forged, so verify can detect a
  // removed template or a value that was replaced with an unsafe source-side canonical file.
  if (Array.isArray(manifest.configuration) && manifest.configuration.length) {
    const missingInitializers = manifest.configuration.filter((row) => row.classification === 'missing-initializer');
    for (const row of missingInitializers) {
      problems.push(`configuration contract incomplete: ${row.destination} needs safe initializer ${row.initializer_origin}`);
    }
    const mismatched = [];
    for (const row of manifest.configuration) {
      // Settings and framework.yaml are deliberately reconciled by the forged runtime's
      // own registry, so their safe source establishes presence, not byte identity.
      if (!row.mode || !row.hash || row.classification === 'settings'
        || row.destination === '.sidekicks/config/framework.yaml') continue;
      const path = join(dir, ...row.destination.split('/'));
      if (!existsSync(path)) { mismatched.push(`${row.destination} missing`); continue; }
      if (hashFile(path) !== row.hash) mismatched.push(`${row.destination} differs from its safe initializer`);
    }
    if (mismatched.length) problems.push(`generated configuration inventory mismatch: ${mismatched.join(', ')}`);
    else if (!missingInitializers.length) ok.push(`safe configuration inventory complete (${manifest.configuration.filter((row) => row.mode).length} entries)`);
  }

  // 7. No machine-absolute path may be persisted in the manifest (portable-paths rule).
  const rawManifest = readFileSync(manifestPath(dir), "utf8");
  if (/"[A-Za-z]:\\\\|"\/(?:Users|home)\//.test(rawManifest)) {
    problems.push("the manifest contains a machine-absolute path — it must stay portable");
  } else ok.push("manifest paths are portable");

  // 8. A runtime forged --as-core must carry the whole distribution, not part of it. A core missing
  //    its marker is the worst case: it mounts, looks fine, and silently captures the root from every
  //    hook — so this is checked rather than assumed.
  if (existsSync(join(dir, CORE_MARKER_REL))) {
    let marker = null;
    try { marker = JSON.parse(readFileSync(join(dir, CORE_MARKER_REL), "utf8")); } catch { /* below */ }
    if (!marker || marker.schema !== 1 || !marker.version) {
      problems.push(`${CORE_MARKER_REL} is unparseable or missing schema/version — a workspace cannot pin it`);
    } else ok.push(`core marker present (v${marker.version}, layout ${marker.layout})`);

    // The instruction doc is checked under EITHER name: a core forged before the rename carries
    // CLAUDE.framework.md, and it is a healthy core — the consumer-side readers accept both.
    const instructionDoc = [CORE_INSTRUCTION_DOC, CORE_INSTRUCTION_DOC_LEGACY]
      .find((f) => existsSync(join(dir, f))) || null;
    const missing = ["install.sh", "install.ps1", "README.md"]
      .filter((f) => !existsSync(join(dir, f)));
    if (!instructionDoc) missing.push(CORE_INSTRUCTION_DOC);
    for (const f of missing) problems.push(`core distribution is incomplete — ${f} is missing`);
    if (!missing.length) {
      ok.push(`core distribution complete (install.sh, install.ps1, README.md, ${instructionDoc})`);
    }

    const installSh = join(dir, "install.sh");
    if (existsSync(installSh)) {
      const text = readFileSync(installSh, "utf8");
      if (text.includes("{{")) problems.push("install.sh still contains an unsubstituted {{PLACEHOLDER}}");
      else if (!text.includes(CORE_MOUNT_DIR)) problems.push(`install.sh does not mount at ${CORE_MOUNT_DIR}`);
      else ok.push("install.sh is fully rendered and mounts at the expected path");
    }

    // 8a. Agent packs, when the core carries any. Same failure class as the distribution files: a
    //     pack that ships broken looks like a pack that shipped, and the consumer only finds out
    //     when `agent pack install` refuses on their machine. The check is CONDITIONAL because a
    //     core carrying no packs is legitimate — but a directory that exists and holds nothing
    //     installable is not, since that is what a copy that silently dropped its payload looks like.
    const packsDir = join(dir, CORE_PACKS_REL);
    if (existsSync(packsDir)) {
      const count = countAgentPacks(packsDir);
      if (count === 0) {
        problems.push(`${CORE_PACKS_REL}/ is present but holds no pack — a shipped packs directory must carry at least one`);
      } else {
        const packProblems = verifyAgentPacks(dir, packsDir);
        if (packProblems.length) problems.push(...packProblems);
        else ok.push(`agent packs valid (${count} pack(s), manifests and charters parse and are portable)`);
      }
    }
  }

  // 8b. THE INSTRUCTION-SURFACE CONTRACT. Every framework-core rule and criterion must either be
  //     STATED in the generated instruction surface or be DECLARED not carried and turned off.
  //
  //     This is the check whose absence let a lightweight core ship without seven safety-floor
  //     rules — Teleport-only production access, the cluster-ops prod hard stop, headful Google
  //     automation, outward-action confirmation, secret-manifest placement, forced-worktree consent,
  //     and the autonomous-auditor floor — while `framework doctor` and `framework show` both
  //     reported them healthy, because `body_at` named a file that existed rather than prose that
  //     did. Runs against the FORGED artifact, which is the thing a consumer actually mounts.
  {
    const surfaces = ["AGENTS.md", CORE_INSTRUCTION_DOC, CORE_INSTRUCTION_DOC_LEGACY]
      .map((f) => join(dir, f))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, "utf8"));
    if (!surfaces.length) {
      problems.push("the runtime has no AGENTS.md — nothing states the rules it claims to follow");
    } else {
      const declaredOff = new Set(CORE_RULES_NOT_IN_RUNTIME_INSTRUCTIONS);
      const coreRules = runtimeCoreRules(dir);
      if (!coreRules) {
        problems.push("could not read the runtime's framework registry — the instruction-surface "
          + "contract could not be checked (run the runtime's own `framework list --json`)");
      }
      for (const rule of coreRules || []) {
        const floor = rule.floor;
        if (declaredOff.has(rule.id) && floor) {
          // Belt and braces: resolve.mjs already refuses a floor id in any settings layer, and
          // `framework disable` refuses one outright. Assert it here too, because the guarantee is
          // enforced at a distance and this list is where someone would try to reach past it.
          problems.push(`${rule.id} is a SAFETY-FLOOR rule and may never be declared uncarried`);
          continue;
        }
        if (!rule.body_marker) {
          problems.push(`${rule.id} is a framework-core rule with no body marker — nothing can prove `
            + "its prose survived the forge (add `marker:` in lib/framework-settings/core-registry.mjs)");
          continue;
        }
        if (surfaces.some((t) => t.includes(rule.body_marker))) continue;
        if (!declaredOff.has(rule.id)) {
          problems.push(
            `${rule.id} is registered${floor ? " as a SAFETY-FLOOR rule" : ""} but its body is absent `
            + `from the runtime instructions (marker: "${rule.body_marker}") — state it in `
            + "assets/AGENTS.min.md.tmpl, or (non-floor only) declare it in "
            + "CORE_SETTINGS_SHIPPED_OFF with `notStated: true` and a reason"
          );
        } else if (rule.enabled) {
          problems.push(
            `${rule.id} is declared uncarried but the runtime's enable map still has it ON — the `
            + "runtime would claim a rule it never states"
          );
        }
      }
      if (coreRules && !problems.length) {
        const stated = coreRules.length - declaredOff.size;
        ok.push(`instruction surface states every framework-core rule (${stated} stated, ${declaredOff.size} declared uncarried and off)`);
      }
    }
  }

  // 8b. THE ENABLE MAP IS A DECLARED DEFAULT — every toggleable entry ships ON unless a reason says
  //     otherwise. Before this gate the forge copied the source repo's working-tree toggles, so
  //     v1.4.4 shipped `hook.enforce-branch-safety: false` — the hook that enforces a rule the same
  //     tarball calls hard — and nothing anywhere said so (INC-2026-09-06-06 B-1). Two escapes, both
  //     narrow and both stated: an id DECLARED in CORE_SETTINGS_SHIPPED_OFF with a reason, and a hook
  //     whose owning skills verifiably did not travel.
  {
    const toggleable = runtimeToggleableEntries(dir);
    if (!toggleable) {
      problems.push("could not read the runtime's framework registry — the enable-map default "
        + "contract could not be checked (run the runtime's own `framework list --json`)");
    } else {
      const undeclared = toggleable.filter((e) => !e.enabled
        && !CORE_SETTINGS_SHIPPED_OFF[e.id]
        && !(e.kind === "hook" && e.owner_absent));
      for (const e of undeclared) {
        problems.push(
          `${e.id} ships DISABLED with no declared reason — a consumer would get the framework's own `
          + "default silently switched off. Name it in CORE_SETTINGS_SHIPPED_OFF with a reason, or "
          + "let normalizeRuntimeEnableMap write it ON"
        );
      }
      if (!undeclared.length) {
        const off = toggleable.filter((e) => !e.enabled).length;
        ok.push(`enable map is a declared default (${toggleable.length - off} on, ${off} off with a stated reason)`);
      }
    }
  }

  // 8c. NO PLUGIN DECLARATION THE ALLOW-LIST DOES NOT NAME. The wiring is copied wholesale, so
  //     without this the source author's personal plugin set rides into every consumer and
  //     `sk-hello --apply` installs it non-interactively (INC-2026-09-06-06 B-5). Checked against the
  //     forged artifact so a hand-edited wiring file cannot slip past the forge-time prune.
  {
    const allowed = new Set(loadHostPlugins());
    const allowedMarkets = new Set([...allowed].map((id) => id.split("@")[1]).filter(Boolean));
    const before = problems.length;
    for (const relConfig of [".claude/settings.json", ".gemini/settings.json", ".agent/settings.json"]) {
      const p = join(dir, ...relConfig.split("/"));
      if (!existsSync(p)) continue;
      let cfg;
      try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
      for (const id of Object.keys(cfg.enabledPlugins ?? {})) {
        if (allowed.has(id)) continue;
        problems.push(`${relConfig} declares the third-party plugin '${id}', which assets/presets.yaml `
          + "host_plugins: does not allow — a consumer would inherit it, and `sk-hello --apply` "
          + "installs every declared plugin without asking");
      }
      for (const name of Object.keys(cfg.extraKnownMarketplaces ?? {})) {
        if (allowedMarkets.has(name)) continue;
        problems.push(`${relConfig} declares the marketplace '${name}', which no allowed plugin needs`);
      }
    }
    // Only when nothing was found: an `ok` printed beside a `FAIL` about the same thing reads as a
    // contradiction, and this gate exists to be believed.
    if (allowed.size && problems.length === before) {
      ok.push(`third-party plugin declarations limited to the allow-list (${[...allowed].join(", ")})`);
    }
  }

  // "The runtime holds agents" — tracked ∪ physically present. Hoisted above checks 9 and 10 so
  // both halves of cmdVerify answer that question the same way: check 9 uses it to justify the
  // operating scripts a runtime ships, check 10 to demand them. Gating check 10 on the manifest
  // alone let a `create --force` that omits --delegates strip those scripts from a runtime whose
  // charters are still on disk, and report clean.
  const agentsPresent = presentDelegates(dir, manifest);

  // 9. Scripts-payload ownership (AAP-111): the runtime must ship no scripts/ entry nothing owns,
  //    and no hook script whose every owner skill is absent — the two defects the v1.1.0 core had.
  //    "Present" = tracked by the manifest ∪ physically present (an operator-added skill counts).
  {
    const present = new Set(trackedSkills(manifest));
    const skillsDir = join(dir, '.agents', 'skills');
    if (existsSync(skillsDir)) {
      for (const e of readdirSync(skillsDir).sort()) {
        if (existsSync(join(skillsDir, e, "SKILL.md"))) present.add(e);
      }
    }
    const ownership = await resolveScriptOwnership(repoRoot, [...present], {
      hasDelegates: agentsPresent.size > 0,
      hasSubagents: existsSync(join(dir, ".agents", "subagents")),
    });
    const fullScripts = Boolean(manifest.options?.full_scripts);

    // 9a — every shipped scripts/ entry is claimed by something present.
    const unclaimed = [];
    const scriptsDir = join(dir, "scripts");
    if (existsSync(scriptsDir)) {
      for (const e of readdirSync(scriptsDir).sort()) {
        let st;
        try { st = lstatSync(join(scriptsDir, e)); } catch { continue; }
        if (st.isDirectory()) {
          const owners = SCRIPT_SUBDIR_OWNERS[e];
          const claimed = ownership.subdirs.has(e)
            || Boolean(owners && owners.some((o) => present.has(o)));
          if (!claimed) unclaimed.push(`${e}/`);
        } else if (!ownership.files.has(e)) {
          unclaimed.push(e);
        }
      }
    }
    if (!unclaimed.length) {
      ok.push("every shipped scripts/ entry is owned by the framework floor or a present skill");
    } else if (fullScripts) {
      ok.push(`scripts/ carries ${unclaimed.length} unowned entr(ies) — permitted, forged with --full-scripts: ${unclaimed.join(", ")}`);
    } else {
      problems.push(`scripts/ ships unclaimed entr(ies) — no present skill or framework hook owns: ${unclaimed.join(", ")}`);
    }

    // 9b — an orphan-owned hook (every owner absent) must ship neither script nor wiring.
    const orphanShipped = [...ownership.orphanHookScripts].filter((f) => existsSync(join(scriptsDir, f)));
    const orphanWired = [];
    for (const rel of [".claude/settings.json", ".codex/config.toml", ".gemini/settings.json", ".agent/settings.json"]) {
      const p = join(dir, ...rel.split("/"));
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      for (const f of ownership.orphanHookScripts) {
        if (text.includes(f)) orphanWired.push(`${rel}: ${f}`);
      }
    }
    if (orphanShipped.length && !fullScripts) {
      problems.push(`hook script(s) shipped although every owner skill is absent: ${orphanShipped.join(", ")}`);
    }
    if (orphanWired.length && !fullScripts) {
      problems.push(`hook wiring references script(s) of absent-owner hooks: ${orphanWired.join(", ")}`);
    }
    if (!orphanShipped.length && !orphanWired.length) {
      ok.push("no hook whose owner skills are all absent ships a script or wiring");
    }
  }

  // 9c — the same question for AGENTS and COMMANDS, on every CLI (INC-2026-09-04-02, N-4).
  //
  // Nothing asked it, so the published core shipped 37 `/bmad:*` commands loading a bmad/ tree it
  // does not carry, 16 Codex agents and 4 Claude agent packs for skills it does not carry, and 14
  // Gemini command stubs the forge was not even aware of. Every one of those is a consumer-visible
  // defect that no consumer can fix, because the payload is the framework's.
  {
    // "Present" the same way 9 defines it: tracked by the manifest, or physically in the runtime.
    const present = new Set(trackedSkills(manifest));
    const skillsDir = join(dir, '.agents', 'skills');
    if (existsSync(skillsDir)) {
      for (const e of readdirSync(skillsDir).sort()) {
        if (existsSync(join(skillsDir, e, "SKILL.md"))) present.add(e);
      }
    }
    const families = ownedFamilies([...present]);
    const strays = [];
    const walk = (absDir, relBase, surface) => {
      let entries;
      try { entries = readdirSync(absDir); } catch { return; }
      for (const entry of entries.sort()) {
        const rel = relBase ? join(relBase, entry) : entry;
        const family = surfaceFamily(rel);
        if (family !== null && !families.has(family)) { strays.push(`${surface}/${rel}`); continue; }
        let st;
        try { st = lstatSync(join(absDir, entry)); } catch { continue; }
        if (st.isDirectory()) walk(join(absDir, entry), rel, surface);
      }
    };
    for (const surface of Object.values(OPTIONAL_SURFACES).flat()) {
      const abs = join(dir, ...surface.split("/"));
      if (existsSync(abs)) walk(abs, "", surface);
    }
    if (strays.length) {
      problems.push(`agent/command path(s) shipped for a family no present skill owns — every one of `
        + `them fails at first use, in every consumer's menu: ${strays.slice(0, 8).join(", ")}`
        + (strays.length > 8 ? ` … and ${strays.length - 8} more` : ""));
    } else {
      ok.push("every shipped agent and command belongs to the framework floor or a present skill");
    }
  }

  // 10. The agent bridge must NOT be here. .sidekicks/agents/.bridge/ holds the bridge token and
  //     the Telegram bot_token/chat_id — same safety class as .sidekicks/config.yaml — plus PID
  //     files that would make the runtime claim another machine's daemons are alive. It is
  //     recreated on demand by lib/agent-lifecycle/_bridge.mjs, so its presence here can only mean
  //     it was copied in.
  {
    const bridge = join(dir, ".sidekicks", DELEGATES_DIRNAME, BRIDGE_DIRNAME);
    if (existsSync(bridge)) {
      problems.push(`.sidekicks/${DELEGATES_DIRNAME}/${BRIDGE_DIRNAME}/ is present — it carries the `
        + "bridge token and Telegram credentials and must never travel; delete it (the runtime "
        + "recreates its own on first use)");
    } else ok.push("no agent bridge inherited — no bridge token or Telegram credential travelled");

    // A tracked delegate whose charter is gone cannot be stood by; report it here too so `verify`
    // alone is enough to trust the runtime (drift reports it as MISSING IN RUNTIME).
    const gone = trackedDelegates(manifest)
      .filter((a) => !existsSync(join(dir, ".sidekicks", DELEGATES_DIRNAME, a, "agent.yaml")));
    if (gone.length) {
      problems.push(`delegate agent(s) recorded in the manifest but absent from the runtime: ${gone.join(", ")}`);
    } else if (trackedDelegates(manifest).length) {
      ok.push(`${trackedDelegates(manifest).length} inherited delegate agent(s) present with a charter`);
    }

    // A runtime that carries agents must carry the scripts that START and SUPERVISE them —
    // otherwise `agent start --headless` works but nothing survives a logout and no tray can open.
    // Claimed by the agents, so their absence means either a pre-delegate forge or a deletion.
    // "Carries agents" is the same tracked ∪ present notion check 9 uses to JUSTIFY those scripts:
    // an agent on disk that the manifest lost (a --force re-forge without --delegates) or never had
    // (created inside the runtime) still needs them.
    if (agentsPresent.size) {
      const missingOps = [
        ...DELEGATE_SCRIPT_FILES.filter((f) => existsSync(join(repoRoot, "scripts", f))
          && !existsSync(join(dir, "scripts", f))),
        ...DELEGATE_SCRIPT_SUBDIRS.filter((d) => existsSync(join(repoRoot, "scripts", d))
          && !existsSync(join(dir, "scripts", d))).map((d) => `${d}/`),
      ];
      if (missingOps.length) {
        problems.push(`the runtime carries delegate agents but not the scripts that operate them: `
          + `${missingOps.join(", ")} — re-register the surface with 'add --name <n> --delegates <a>' `
          + "or re-forge with 'create --force'");
      } else {
        ok.push(`delegate operating scripts present (${DELEGATE_SCRIPT_FILES.join(", ")}, `
          + `${DELEGATE_SCRIPT_SUBDIRS.map((d) => `${d}/`).join(", ")})`);
      }
    }
  }

  // 11. THE TEST GATE MUST BE REAL (F-05). `npm test` in the v2.0.0 core ran
  //     `node --test 'tests/**/*.test.mjs'` against a runtime with no top-level tests/: Node 22
  //     expanded the glob to nothing, ran zero tests, and EXITED 0. The publisher and the
  //     test-gate skill both read that as a pass while the artifact's 89 real tests — under
  //     lib/artifacts-lifecycle/tests/ — were never loaded. So verify asks three things of the
  //     shipped gate: that package.json invokes the launcher, that the launcher travelled, and
  //     that running its discovery finds at least one file.
  {
    const pkgPath = join(dir, "package.json");
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { /* reported below */ }
    const cmd = pkg?.scripts?.test ?? null;
    const launcher = join(dir, ...RUNTIME_TEST_SCRIPT.split("/"));

    if (!pkg) {
      problems.push("package.json is missing or unparseable — the runtime has no declared test gate");
    } else if (cmd !== RUNTIME_TEST_COMMAND) {
      problems.push(`package.json test is ${JSON.stringify(cmd)}, not ${JSON.stringify(RUNTIME_TEST_COMMAND)} — `
        + "a bare `node --test <glob>` reports a PASS on zero discovered tests (re-forge to repair it)");
    } else if (!existsSync(launcher)) {
      problems.push(`package.json runs ${RUNTIME_TEST_SCRIPT} but that file did not travel — `
        + "`npm test` in this runtime cannot start");
    } else {
      const disc = spawnSync(process.execPath, [launcher, "--list", "--json"],
        { cwd: dir, encoding: "utf8" });
      let payload = null;
      try { payload = JSON.parse(disc.stdout || "null"); } catch { /* below */ }
      if (!payload) {
        problems.push(`${RUNTIME_TEST_SCRIPT} did not report its discovery: `
          + `${(disc.stderr || disc.stdout || "").trim().split("\n")[0] || `exit ${disc.status}`}`);
      } else if (!payload.count) {
        problems.push("the runtime's test gate discovers NO test files — `npm test` would be a "
          + "runner failure, and any gate that reads it as a pass is reporting false confidence");
      } else {
        ok.push(`test gate real: ${RUNTIME_TEST_SCRIPT} discovers ${payload.count} file(s) `
          + `under ${(payload.roots || []).join(", ")}`);
      }
    }
  }

  for (const o of ok) out(`  ok    ${o}`);
  for (const p of problems) out(`  FAIL  ${p}`);
  out("");
  out(problems.length ? `verify: ${problems.length} problem(s)` : "verify: clean");
  if (problems.length) process.exitCode = 12;
}

function usage() {
  out(`sk-inherit — forge and maintain standalone Sidekicks runtimes.
Sync is ONE-WAY: the sidekicks source repo is the only source of truth. Run every verb from
the sidekicks root; a runtime's own edits are reported but never propagated back.

Usage: node inherit.mjs <verb> [--name <runtime>] [flags]

  skills                          List what is inheritable — skills (active + offloaded), delegate
                                  agents, and the presets
  list                            List every known runtime and where it lives (registry +
                                  runtimes/ scan)
  plan    --name N --skills a,b   Show what create would copy, and the resolved Python requirements
                                  (--json emits the same composition as a payload: selection with
                                  per-skill reasons, pack policy, substrate, and the runtime
                                  projection's copied/excluded files and bytes)
  create  --name N --skills a,b   Forge runtimes/N: copy skills + core substrate, generate a minimal
                                  AGENTS.md, build its own .venv, git init (+ --remote <url>)
  add     --name N --skills c     Inherit more skills into an existing runtime, regenerate AGENTS.md
  drift (check) --name N          Three-way compare source vs runtime vs baseline; exits 10 if not clean
  patch   --name N                Push clean fast-forwards; runtime-side edits are held back unless
                                  --force
  venv    --name N                Recompute requirements.txt and (re)build the runtime's own venv
  verify  --name N                Assert the runtime is self-contained and runnable
  forget  --name N                Drop a runtime's registry entry (leaves its files alone)

Selection: --skills a,b,c  and/or  --preset <name>
Offloaded skills are eligible: inheriting one activates it in the runtime WITHOUT restoring it here.

REQUIRED FLOOR: the skills in the 'required:' block of assets/presets.yaml are unioned into every
selection and there is no flag that drops them — a runtime that cannot orient itself, drive a CLI
verb, execute a command-sequence, align scope, validate its config or manage skills is a defect, not
a choice. They are not nameable with --preset ('--preset core' asks for the same six and nothing
else), --prune-skills never deletes one,
'verify' fails when one is absent, and 'drift' reports it as MISSING REQUIRED for 'patch' to restore
without --force. An empty --skills/--preset selection still exits 2: the floor never forges a runtime
nobody asked for. Run the 'skills' verb to see the current floor.

Carrying an agent also claims the scripts that OPERATE one — start-agent-delegate.sh, the
install/uninstall LaunchAgent pair, agent-tray.sh and the launchd/ plist templates — because those are
an agent's operating surface, not a skill's. 'verify' fails if agents are present without them.

Delegate agents: --delegates a,b (or --all-delegates) inherits named persistent agents from
.sidekicks/agents/. Nothing travels unless it is named. Per agent, only agent.yaml + routines/ are
copied; memory/ needs --delegate-memory (an agent's memory records the SOURCE repo's decisions), and
runtime/ plus the shared .bridge/ NEVER travel — .bridge/ holds the bridge token and Telegram
credentials, and both are recreated in the runtime on first use. Agents are drift-tracked over that
same surface, so a charter amended in the runtime is reported, never silently overwritten.
Presets may name agents too, via a 'delegates:' block in assets/presets.yaml.
NOTE: --no-agents is a different flag — it drops .agents/subagents/ and every generated SUBAGENT port.

Location: a runtime defaults to runtimes/<name>/, but --target puts it ANYWHERE — an absolute path,
a path relative to the repo root, or a directory outside the repo entirely. The location is
remembered at create time, so later verbs need only --name (pass --target again to override, or to
adopt a runtime this repo has not registered).

Flags: --preset P  --remote URL  --target PATH  --force  --dry-run  --json  --only a,b  --rebuild
       --no-venv  --no-agents  --no-commands  --full-scripts  --prune-skills  --verbose
       --delegates a,b  --all-delegates  --delegate-memory  --prune-delegates
       --as-core / --no-as-core  --core-version V  --core-ref REF  --force-downgrade
       --pack-skills closure|declared|none

--as-core (create only) also writes the files that make the runtime a MOUNTABLE framework core:
.sidekicks-core.json (the marker both root resolvers walk past), install.sh + install.ps1 (the curl
bootstrap), AGENTS.framework.md (the rules a mounted workspace imports) and a generated README. It is
ON by default for --preset framework, which exists to build exactly that repo; --no-as-core opts out.
--core-version stamps the marker and is REQUIRED with --as-core: there is no default, because the
only one available was this repo's package.json version, which tracks the REPO and not the core's
own version line — a hand forge that took it silently downgraded a distributed marker. Derive it with
'node scripts/framework-core-publish.mjs publish'. A version lower than the one the target already
stamps is refused unless --force-downgrade. --core-ref sets the ref the generated install commands
default to (default: main).

--pack-skills (with --as-core only) decides how much of the shipped AGENT PACKS' declared skill
graph the core carries. A pack names the skills its agents need and never bundles one, so without
this a core shipped the pack and none of its skills, and the consumer's first 'agent pack install'
refused. 'declared' (default) ships exactly the rows the manifests name — enough to install the
pack, and a core stays substrate. 'closure' also ships each of those skills' own declared siblings,
which they fail without; honest, but it can turn 3 skills into 28. 'none' ships neither. An ordinary
runtime derives nothing either way: packs travel with a core distribution and nothing else.

--prune-skills / --prune-delegates (create only) delete every skill / delegate agent the runtime
carries that is not in the selection, making the set EXACT. Pair with --force to re-forge a runtime
reproducibly. Without them, units an earlier inherit left behind survive. 'add' refuses both — its
selection is only the new units, so pruning against it would delete the rest of the runtime.

Exit codes: 0 ok · 2 usage · 3 state · 4 unknown skill or delegate · 10 drift/held back · 11 venv · 12 verify
`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { verb, flags, positional } = parseArgv(process.argv.slice(2));

  if (verb === undefined || verb === "help" || verb === "--help" || verb === "-h") {
    usage();
  } else {
    const repoRoot = resolveSourceRoot();
    switch (verb) {
      case "skills":  cmdSkills(repoRoot); break;
      case "list":    cmdList(repoRoot); break;
      case "plan":    await cmdPlan(repoRoot, flags, positional); break;
      case "create":  await cmdCreate(repoRoot, flags, positional); break;
      case "add":     await cmdAdd(repoRoot, flags, positional); break;
      case "drift":
      case "check":   cmdDrift(repoRoot, flags, positional); break;
      case "patch":   cmdPatch(repoRoot, flags, positional); break;
      case "venv":    cmdVenv(repoRoot, flags, positional); break;
      case "verify":  await cmdVerify(repoRoot, flags, positional); break;
      case "forget":  cmdForget(repoRoot, flags, positional); break;
      default:        die(`unknown verb '${verb}' (run 'help')`, 2);
    }
  }
}
