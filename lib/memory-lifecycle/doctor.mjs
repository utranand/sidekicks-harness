// lib/memory-lifecycle/doctor.mjs
// `sidekicks memory doctor [--json]` — report what is wrong or about to be wrong.
//
// Nine checks, each earning its place from a specific failure this design can produce:
//
//   drift            the generated faces no longer match the entry files (someone
//                    hand-edited an entry, or a write was interrupted). A trusted index
//                    that lies is worse than no index.
//   dangling         an edge whose target no longer exists. `remove` keeps these on
//                    purpose so a broken link is reportable rather than invisible.
//   superseded-chain the head of a `supersedes` chain is itself superseded — meaning
//                    the entry a reader would land on is not the current one.
//   rule-budget      a category's rule bodies grew past the budget. Hard rules load in
//                    full on every trigger, so rule sprawl re-creates the eager loading
//                    this whole design exists to end.
//   evidence-budget  a snapshot grew into an archive. Snapshots anchor a fact.
//   dormant-legacy   a pre-central store still on disk. Nothing reads it; this line is
//                    the only thing standing between "deliberately dormant" and
//                    "forgotten", which is why it is reported rather than deleted.
//   conflict         an entry file with git conflict markers. Every reader falls back to
//                    its OURS side, so the store serves half a fact — and a hard rule can
//                    lose `rule: true` — until `memory resolve` repairs it.
//   merge-review     an entry the merge driver had to UNION. Both bodies were kept rather
//                    than one silently dropped; a human still has to read the result.
//   merge-driver     .gitattributes is committed but the driver it names lives in
//                    .git/config, which is not. An unregistered driver means memory files
//                    fall back to git's text merge — the conflicts this design ends.
//
// Exit code 2 when anything is found, so a sequence step can gate on it.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  storeRoot,
  machineIndexPath,
  graphPath,
  humanIndexPath,
  layerForNamespace,
} from '../active-scope/memory-paths.mjs';
import { parseMemoryFlags, scanStore, listNamespaces, parseEntryFile } from './_shared.mjs';
import { buildIndex, buildGraph, readIndexJson, readGraphJson, computeFingerprint } from './_store.mjs';
import { rebuildCentralIndexText } from './_shared.mjs';
import { driverStatus, DRIVER_NAME } from './_merge-driver.mjs';

/** Hard-rule bodies load in full on every trigger — keep a category's total small. */
const RULE_BUDGET_BYTES = 2 * 1024;
/** A snapshot anchors a fact; past this it is an archive. */
const EVIDENCE_BUDGET_BYTES = 8 * 1024;
/** Past this a namespace listing stops being scannable; revisit sharding then. */
const NAMESPACE_WARN_COUNT = 500;

/** Pre-central store locations. Nothing reads them; doctor only reports them. */
function dormantLegacyStores(repoRoot) {
  const out = [];
  const projects = join(repoRoot, 'projects');
  if (existsSync(projects)) {
    let names = [];
    try {
      names = readdirSync(projects, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => d.name);
    } catch { names = []; }
    for (const n of names) {
      const dir = join(projects, n, 'memory');
      let count = 0;
      try {
        if (!existsSync(dir)) continue;
        count = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length;
      } catch { continue; }
      if (count) out.push({ path: `projects/${n}/memory`, entries: count });
    }
  }
  const agents = join(repoRoot, '.sidekicks', 'agents');
  if (existsSync(agents)) {
    let names = [];
    try {
      names = readdirSync(agents, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { names = []; }
    for (const n of names) {
      const dir = join(agents, n, 'memory');
      let count = 0;
      try {
        if (!existsSync(dir)) continue;
        count = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length;
      } catch { continue; }
      if (count) out.push({ path: `.sidekicks/agents/${n}/memory`, entries: count });
    }
  }
  return out;
}

/** Total bytes of every file under `dir`, recursively. */
function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let items;
    try { items = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = join(d, it.name);
      if (it.isDirectory()) walk(p);
      else {
        try { total += statSync(p).size; } catch { /* unreadable — skip */ }
      }
    }
  };
  walk(dir);
  return total;
}

/**
 * Run `memory doctor`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['json']);
  const findings = [];

  const entries = scanStore(repoRoot, { withBody: true });

  // 1. Drift — regenerate in memory and compare against what is on disk.
  const fingerprint = computeFingerprint(repoRoot);
  const expected = {
    [machineIndexPath(repoRoot)]: JSON.stringify(buildIndex(entries, fingerprint), null, 2) + '\n',
    [graphPath(repoRoot)]: JSON.stringify(buildGraph(entries, fingerprint), null, 2) + '\n',
    [humanIndexPath(repoRoot)]: rebuildCentralIndexText(repoRoot, entries),
  };
  for (const [abs, want] of Object.entries(expected)) {
    const relPath = relative(repoRoot, abs).replace(/\\/g, '/');
    let have = null;
    try { have = existsSync(abs) ? readFileSync(abs, 'utf8') : null; } catch { have = null; }
    if (have === null) {
      findings.push({ check: 'drift', severity: 'error', detail: `${relPath} is missing — run 'sidekicks memory rebuild'` });
    } else if (have.replace(/\r\n/g, '\n') !== want) {
      findings.push({ check: 'drift', severity: 'error', detail: `${relPath} does not match the entry files — run 'sidekicks memory rebuild'` });
    }
  }

  // 2. Dangling edges. `heal: false` — a diagnostic that repairs what it is about to report
  // makes its own findings untrue by the time they are read.
  const graph = readGraphJson(repoRoot, { heal: false });
  for (const e of graph.edges.filter((x) => x.dangling)) {
    findings.push({
      check: 'dangling',
      severity: 'warn',
      detail: `${e.from} --${e.rel}--> ${e.to} (${e.origin}) — target is not in the store`,
    });
  }

  // 3. Superseded chain heads.
  const supersededBy = new Map();
  for (const e of graph.edges) {
    if (e.rel === 'supersedes' && !e.dangling) supersededBy.set(e.to, e.from);
  }
  for (const [old, newer] of supersededBy) {
    if (supersededBy.has(newer)) {
      findings.push({
        check: 'superseded-chain',
        severity: 'warn',
        detail: `'${old}' is superseded by '${newer}', which is itself superseded — a reader lands on a stale head`,
      });
    }
  }

  // 4. Rule-body budget per category.
  const ruleBytes = new Map();
  for (const e of entries) {
    if (!e.rule) continue;
    const n = ruleBytes.get(e.category) ?? 0;
    ruleBytes.set(e.category, n + Buffer.byteLength(e.body ?? '', 'utf8'));
  }
  for (const [cat, bytes] of ruleBytes) {
    if (bytes > RULE_BUDGET_BYTES) {
      findings.push({
        check: 'rule-budget',
        severity: 'warn',
        detail: `category '${cat}' has ${bytes} bytes of rule bodies (budget ${RULE_BUDGET_BYTES}) — `
          + `rule bodies load IN FULL on every trigger, so this re-creates eager loading`,
      });
    }
  }

  // 5. Evidence budget.
  const evidenceRoot = join(storeRoot(repoRoot), 'evidence');
  if (existsSync(evidenceRoot)) {
    for (const ns of listNamespaces(repoRoot)) {
      const nsDir = join(evidenceRoot, ...ns.split('/'));
      if (!existsSync(nsDir)) continue;
      let slugs = [];
      try { slugs = readdirSync(nsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
      for (const slug of slugs) {
        const bytes = dirBytes(join(nsDir, slug));
        if (bytes > EVIDENCE_BUDGET_BYTES) {
          findings.push({
            check: 'evidence-budget',
            severity: 'warn',
            detail: `evidence/${ns}/${slug} is ${bytes} bytes (budget ${EVIDENCE_BUDGET_BYTES}) — `
              + `snapshots anchor a fact, they are not archives`,
          });
        }
      }
    }
  }

  // 6. Namespace size + dormant legacy stores.
  const perNamespace = new Map();
  for (const e of entries) perNamespace.set(e.namespace, (perNamespace.get(e.namespace) ?? 0) + 1);
  for (const [ns, n] of perNamespace) {
    if (n > NAMESPACE_WARN_COUNT) {
      findings.push({
        check: 'namespace-size',
        severity: 'warn',
        detail: `namespace '${ns}' holds ${n} entries (warn at ${NAMESPACE_WARN_COUNT}) — revisit sharding`,
      });
    }
  }
  // 7. Merge state. An entry carrying conflict markers is an ERROR: every reader falls back
  // to its OURS side, so the store is quietly serving half a fact until someone repairs it.
  for (const e of entries.filter((x) => x.conflicted)) {
    findings.push({
      check: 'conflict',
      severity: 'error',
      detail: `${e.file} carries git conflict markers — readers fall back to the OURS side, `
        + `so metadata from theirs is being ignored. Repair: 'sidekicks memory resolve ${e.slug}'`,
    });
  }
  for (const e of entries.filter((x) => x.mergeReview && !x.conflicted)) {
    findings.push({
      check: 'merge-review',
      severity: 'warn',
      detail: `${e.slug} was merged by UNION on ${e.mergeReview} — both bodies were kept because `
        + `they diverged. Read it, then clear the flag: 'sidekicks memory resolve ${e.slug} --accept'`,
    });
  }

  // 8. Is the merge driver actually wired in THIS clone? .gitattributes is committed, the
  // driver registration is not — so a fresh clone conflicts until something registers it.
  const merge = driverStatus(repoRoot);
  if (merge.git && !merge.registered) {
    findings.push({
      check: 'merge-driver',
      severity: 'info',
      detail: merge.disabled
        ? `merge driver '${DRIVER_NAME}' is not registered and SIDEKICKS_MEMORY_MERGE=off blocks `
          + `the self-heal — memory files fall back to git's text merge`
        : `merge driver '${DRIVER_NAME}' is not registered in this clone — run `
          + `'sidekicks memory merge install' (any sidekicks command also self-heals it)`,
    });
  }
  if (merge.git && !merge.attributes) {
    findings.push({
      check: 'merge-driver',
      severity: 'info',
      detail: `.gitattributes has no 'merge=${DRIVER_NAME}' line — nothing routes to the driver, `
        + `so a memory merge still conflicts file-by-file`,
    });
  }
  // The hooks directory is whatever core.hooksPath says, so name the resolved one rather than
  // assuming .git/hooks — a message that points at a directory git ignores sends the reader to
  // check the wrong file.
  const hooksLabel = merge.hooksDir
    ? (relative(repoRoot, merge.hooksDir) || merge.hooksDir).replace(/\\/g, '/')
    : '.git/hooks';
  for (const h of merge.hooks.filter((x) => x.state === 'foreign')) {
    findings.push({
      check: 'merge-driver',
      severity: 'info',
      detail: `${hooksLabel}/${h.name} exists and is not ours — left alone, so the faces are `
        + `regenerated on the next memory read instead of right after the merge`,
    });
  }
  // A hook in the git dir's own hooks/ while core.hooksPath points elsewhere is inert, and it
  // reads as installed. That combination is how a merge kept shipping stale faces unnoticed.
  for (const name of merge.strayHooks ?? []) {
    findings.push({
      check: 'merge-driver',
      severity: 'warn',
      detail: `a '${name}' hook of ours sits in the git dir's own hooks/ directory, which `
        + `core.hooksPath=${merge.hooksPath} makes git ignore entirely — that copy can NEVER fire. `
        + `The live one is ${hooksLabel}/${name}; delete the stray to stop it reading as installed`,
    });
  }

  for (const legacy of dormantLegacyStores(repoRoot)) {
    findings.push({
      check: 'dormant-legacy',
      severity: 'info',
      detail: `${legacy.path}/ holds ${legacy.entries} pre-central entries and is NEVER read — `
        + `re-register one with 'sidekicks memory add' when it next matters`,
    });
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  const infos = findings.filter((f) => f.severity === 'info').length;

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        entries: entries.length,
        namespaces: [...perNamespace.keys()],
        counts: { errors, warnings: warns, info: infos },
        findings,
      }, null, 2) + '\n',
      exitCode: errors || warns ? EXIT_VALIDATION : EXIT_OK,
    };
  }

  const out = [
    `Memory store — ${entries.length} entries across ${perNamespace.size} namespace${perNamespace.size === 1 ? '' : 's'}`,
    '',
  ];
  if (findings.length === 0) {
    out.push('No findings.', '');
    return { stdout: out.join('\n'), exitCode: EXIT_OK };
  }
  for (const sev of ['error', 'warn', 'info']) {
    const rows = findings.filter((f) => f.severity === sev);
    if (!rows.length) continue;
    out.push(`${sev.toUpperCase()}:`);
    for (const f of rows) out.push(`  [${f.check}] ${f.detail}`);
    out.push('');
  }
  out.push(`${errors} error(s), ${warns} warning(s), ${infos} info`);
  out.push('');
  return { stdout: out.join('\n'), exitCode: errors || warns ? EXIT_VALIDATION : EXIT_OK };
}
