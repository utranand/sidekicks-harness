#!/usr/bin/env node
// .agents/skills/sk-hello/scripts/capability.mjs
//
// Capability & config audit for the ACTIVE Sidekicks scope. Answers, in one report-only call:
// "which capabilities of the Sidekicks skill family are configured here, which are not, and where
// does each one get configured?" — so a scope being used for the FIRST TIME (or one whose skills
// were just added or enhanced) can be guided through filling in the essential connectors.
//
// THE CLI IS THE RESOLVER. This script derives NOTHING itself. It asks:
//
//   sidekicks config list --json              every declared block: family, owners, scope rules
//   sidekicks config sync --dry-run --json    what each block's state is in this scope, plus drift
//
// and renders the join. That is a deliberate reversal. This script used to discover capabilities by
// scanning each skill's `config.example.yaml` and classifying them against the scope's
// `config.yaml` — a second implementation of the resolution chain living next to the real one. When
// configuration became a FOLDER (`config/<family>.yaml` + a git-ignored secret sibling, with the
// monolith retired below them), that copy kept reading the old path and reported every connector in
// this repo as "not configured" while `config get jira` returned a live site. An audit that is
// confidently wrong about the whole scope is worse than no audit: it tells a user to set up what
// they already have.
//
// Classification, all of it from the CLI's own answer:
//   [SET] configured   — the block carries live values in this scope (`keep`)
//   [INH] inherited    — not set here, set at ROOT, and the block declares inherits_root
//   [tpl] documented   — the block is present but entirely commented out: the inert scaffold
//                        `config sync` writes, which still resolves to the owning skill's defaults
//   [ - ] absent       — not documented here yet; `config sync` would add it
// plus DRIFT: a live block that does not override every key its skill's current defaults document.
// Drift is never a defect — an un-overridden key resolves from the skill, which is the contract —
// it is a prompt to look at what the skill has grown.
//
// Report-only by design: this script NEVER writes configuration (that is `sidekicks config sync`
// and `config set`, and credentials stay the user's to place) and always exits 0 — an unconfigured
// capability is guidance for a human, not a failure. Pure Node, zero dependency, cross-platform.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Repo root ────────────────────────────────────────────────────────────────
// Walk up for `.sidekicks/`, never `git rev-parse`: a service's src/ is frequently its own git
// repository and rev-parse would resolve to the wrong root.
function repoRoot() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR || process.env.GEMINI_PROJECT_DIR;
  if (fromEnv && existsSync(resolve(fromEnv, ".sidekicks"))) return resolve(fromEnv);
  for (const start of [dirname(fileURLToPath(import.meta.url)), process.cwd()]) {
    let dir = resolve(start);
    for (;;) {
      if (existsSync(join(dir, ".sidekicks"))) return dir;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

const ROOT = repoRoot();
if (!ROOT) {
  process.stdout.write("Capability audit: cannot locate the repo root (.sidekicks marker not found)\n");
  process.exit(0); // report-only: never fail the caller
}

/** Ask the CLI for JSON. Returns null on any failure — the caller degrades, never throws. */
function cli(args) {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "sidekicks"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  // `config sync --dry-run` exits 0; `config list` exits 0. A non-zero exit here means the CLI
  // itself could not answer, which is worth reporting rather than papering over.
  if (r.error || r.status !== 0) return null;
  try {
    return JSON.parse(String(r.stdout ?? ""));
  } catch {
    return null;
  }
}

const listed = cli(["config", "list", "--json"]);
const plan = cli(["config", "sync", "--dry-run", "--json"]);
if (!listed || !plan) {
  process.stdout.write(
    "Capability audit: the CLI could not answer (`sidekicks config list` / `config sync --dry-run`).\n"
    + "  Run them directly to see why — this audit reads nothing on its own.\n"
  );
  process.exit(0);
}

const activeScope = listed.active_scope || "sidekicks";
const isRoot = activeScope === "sidekicks";

// Root's own plan, only when a PROJECT is active: the one thing the active-scope plan cannot tell
// us is whether an inheriting block is satisfied from root.
const rootPlan = isRoot ? plan : cli(["config", "sync", "--dry-run", "--json", "--scope", "root"]);

// ── Join ─────────────────────────────────────────────────────────────────────

/** The connectors that gate whole skill families; an open one is worth leading with. */
const ESSENTIAL = new Set(["jira", "slack", "confluence", "database_connector"]);

const planItems = new Map();
for (const scope of plan.scopes || []) {
  for (const item of scope.items || []) planItems.set(item.block, item);
}
const rootLive = new Set();
for (const scope of (rootPlan && rootPlan.scopes) || []) {
  for (const item of scope.items || []) {
    if (item.action === "keep") rootLive.add(item.block);
  }
}

const familyTitle = new Map((listed.families || []).map((f) => [f.family, f.title || f.family]));

const rows = [];
for (const block of listed.blocks || []) {
  const item = planItems.get(block.block);
  // A block with no plan item was filtered out of this scope — a root-scoped block while a project
  // is active. It is not "absent here", it does not belong here; saying so is the useful answer.
  if (!item) {
    if (!isRoot && block.scope === "root") {
      rows.push({ ...block, status: "root-only", missing: [], why: "" });
    }
    continue;
  }
  let status;
  if (item.action === "keep") status = "configured";
  else if (item.action === "skip" && /scaffold/.test(item.why || "")) status = "scaffold";
  else if (item.action === "skip") status = "unseedable";
  else status = "absent";

  let note = "";
  if (status !== "configured" && !isRoot && rootLive.has(block.block)) {
    if (block.inherits_root) status = "inherited";
    else {
      note = "root has this block, but it does NOT inherit — configure it in this project too";
    }
  }
  rows.push({ ...block, status, note, missing: item.missing_keys || [], why: item.why || "" });
}
rows.sort((a, b) => (a.family || "").localeCompare(b.family || "") || a.block.localeCompare(b.block));

// ── First-time signal ────────────────────────────────────────────────────────
const anyConfigured = rows.some((r) => r.status === "configured" || r.status === "inherited");
const base = isRoot ? ".sidekicks" : join("projects", activeScope);
const configDir = join(base, "config");
let firstTime = null;
if (!existsSync(join(ROOT, configDir))) {
  firstTime = `no ${configDir}/ yet — run 'sidekicks config sync' to document every installed `
    + "skill's block as an inert scaffold";
} else if (!anyConfigured) {
  firstTime = `${configDir}/ documents the schema but nothing carries a value yet — this scope is `
    + "being used for the first time";
}

// ── Render ───────────────────────────────────────────────────────────────────
const TAG = {
  configured: "SET",
  inherited: "INH",
  scaffold: "tpl",
  absent: " - ",
  unseedable: " ? ",
  "root-only": "rt ",
};

const out = [];
out.push(`Capability audit (active scope: ${activeScope} — ${configDir}/):`);
if (firstTime) {
  out.push("");
  out.push(`  FIRST-TIME: ${firstTime}`);
}

const families = [...new Set(rows.map((r) => r.family))];
for (const family of families) {
  const inFamily = rows.filter((r) => r.family === family);
  if (!inFamily.length) continue;
  out.push("");
  out.push(`  ${familyTitle.get(family) || family}  (${family}.yaml)`);
  for (const r of inFamily) {
    const owners = (r.owners || []).length
      ? `skills: ${r.owners.join(", ")}`
      : "repo-level (framework reads it directly)";
    let state;
    if (r.status === "configured") state = "configured";
    else if (r.status === "inherited") state = "inherited from root";
    else if (r.status === "scaffold") state = "documented, no value set — resolves from the skill's defaults";
    else if (r.status === "unseedable") state = "not configured; the owning skill ships no defaults to document";
    else if (r.status === "root-only") state = "root-scoped — configure it at root, not in this project";
    else state = "not documented here yet — 'sidekicks config sync' would add it";
    out.push(`    [${TAG[r.status]}] ${r.block}${ESSENTIAL.has(r.block) ? " *" : ""} — ${state} | ${owners}`);
    if (r.status !== "configured" && r.status !== "inherited" && r.status !== "root-only") {
      out.push(`          configure: sidekicks config set ${r.block}.<key> <value>   (file: ${r.file})`);
      if (r.defaults) out.push(`          defaults:  ${r.defaults}`);
    }
    if (r.missing.length) {
      out.push(
        `          drift: the skill's defaults document ${r.missing.length} key(s) this block does `
        + `not override — ${r.missing.slice(0, 8).join(", ")}${r.missing.length > 8 ? ", …" : ""}`
      );
      out.push("                 (each resolves from the skill, which is the contract — merge only what you want to pin)");
    }
    if (r.note) out.push(`          note: ${r.note}`);
  }
}

const nSet = rows.filter((r) => r.status === "configured").length;
const nInh = rows.filter((r) => r.status === "inherited").length;
const open = rows.filter((r) => ["absent", "scaffold", "unseedable"].includes(r.status));
const openEssential = open.filter((r) => ESSENTIAL.has(r.block));
const drifted = rows.filter((r) => r.missing.length);

out.push("");
out.push(
  `  Summary: ${nSet} configured, ${nInh} inherited, ${open.length} not configured`
  + (openEssential.length
    ? ` — ${openEssential.length} essential (*) still open: ${openEssential.map((r) => r.block).join(", ")}`
    : " — all essential connectors covered")
);
if (drifted.length) {
  out.push(
    `  Drift: ${drifted.length} configured block(s) do not override every key their skill now `
    + `documents: ${drifted.map((r) => r.block).join(", ")} `
    + "(a live block is never rewritten — add by hand only what you want to pin)"
  );
}
if (open.length || firstTime) {
  const only = openEssential.length ? ` --only=${openEssential.map((r) => r.block).join(",")}` : "";
  out.push("  Next: document the open blocks as an inert scaffold, then fill values in. Secrets go");
  out.push("  to the git-ignored '<family>.secret.yaml' — never into the committed file:");
  out.push(`    sidekicks config sync${only} --dry-run     (the plan)`);
  out.push(`    sidekicks config sync${only}               (writes the scaffold, inert)`);
  out.push("    sidekicks config set <block>.<key> <value> [--secret]");
}

process.stdout.write(out.join("\n") + "\n");
process.exit(0); // report-only, best-effort: never fail the caller
