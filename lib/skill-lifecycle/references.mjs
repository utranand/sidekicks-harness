// lib/skill-lifecycle/references.mjs
// Who names this skill, and does it BLOCK taking it away?
//
// Shared by `skill offload` (park it) and `skill remove` (uninstall it), because both are asking
// the same question and two implementations of it would be one implementation that has stopped
// being checked.
//
// WHY NOT `grep -rIlE`, which is what sk-skill-offload's bash engine used: BSD and GNU grep
// disagree on flags, Git-Bash is not guaranteed on Windows, and the shell-out cannot distinguish a
// whole quoted literal (a real invocation) from the same word inside a sentence. `bareNameHit`
// already draws that distinction, and already excludes the `artifacts/runs/<skill-id>/` convention
// that would otherwise make every run folder look like a dependency.
//
// TWO BUCKETS, and the split is the whole point. A reference from another ACTIVE skill is a wire
// that breaks when the target goes. Everything else — docs, AGENTS.md opt-in lists, the nickname
// registry, command-sequences — is a mention someone should tidy, and blocking on those would
// train an operator to reach for --force by reflex.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { discoverSkills, readSkillManifest } from '../skill-manifest/read.mjs';
import { bareNameHit, walkSkillFiles } from './scan.mjs';

/** Text files worth scanning. A binary that happens to contain the name is not a reference. */
const SCANNED = /\.(md|mjs|js|cjs|ts|sh|bash|py|ya?ml|json|toml|txt)$/i;

/** Directories never walked when scanning the repo outside the skill trees. */
const SKIP = Object.freeze(new Set([
  'node_modules', '.git', '.venv', '__pycache__', '.pytest_cache', 'artifacts', 'runtimes',
  'output', 'dist', 'build', '.sidekicks',
]));

/**
 * Everything that names `target`, split into blocking and soft.
 *
 * @param {string} repoRoot
 * @param {string} target
 * @returns {{blocking: Array<{path: string, skill: string, exact: boolean}>,
 *            soft: Array<{path: string}>,
 *            declared: Array<{skill: string, how: string, degraded: string}>}}
 */
export function referencesTo(repoRoot, target) {
  const blocking = [];
  const soft = [];
  const declared = [];

  for (const entry of discoverSkills(repoRoot)) {
    if (entry.skill === target) continue;

    // The authoritative half: another skill DECLARED this one as a sibling. Independent of any
    // text scan, and it carries the `degraded:` sentence that says what the absence costs.
    const read = readSkillManifest(repoRoot, entry);
    for (const s of (read.manifest && read.manifest.requires.sibling_skills) || []) {
      if (s.skill === target) declared.push({ skill: entry.skill, how: s.how, degraded: s.degraded });
    }

    // The safety net: an undeclared edge. Offloaded skills and the nickname registry are excluded
    // the same way the bash engine excluded them — a parked skill cannot break, and a nickname is
    // a label.
    if (entry.offloaded || entry.skill === 'skill-nickname') continue;
    for (const f of walkSkillFiles(entry.dir)) {
      if (!SCANNED.test(f.rel)) continue;
      if (f.rel.startsWith('evals/')) continue;          // sample transcripts, not wiring
      if (f.rel.endsWith('index.json')) continue;
      // The auditor's audit-groups.yaml LISTS every first-party skill by name — it is a membership
      // manifest, not a wire. Counting it made the auditor a blocking dependent of literally every
      // skill in the repo, which would have made this gate unusable and taught everyone to --force.
      // Losing the line is a real consequence, so it is reported: `skill remove` drops it
      // mechanically and names the group it came from.
      if (entry.skill === 'sk-skill-auditor' && f.rel === 'assets/audit-groups.yaml') continue;
      const hit = bareNameHit(safeRead(f.abs), target);
      if (hit.index === -1) continue;
      blocking.push({ path: `${entry.relDir}/${f.rel}`, skill: entry.skill, exact: hit.exact });
    }
  }

  for (const rel of walkRepo(repoRoot)) {
    const hit = bareNameHit(safeRead(join(repoRoot, rel)), target);
    if (hit.index !== -1) soft.push({ path: rel });
  }

  return { blocking, soft, declared };
}

/** Repo files outside `.sidekicks/`, shallow-ish and cheap. */
function walkRepo(repoRoot, dir = repoRoot, depth = 0) {
  const out = [];
  if (depth > 4) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
      out.push(...walkRepo(repoRoot, abs, depth + 1));
      continue;
    }
    if (!SCANNED.test(e.name)) continue;
    try { if (statSync(abs).size > 512 * 1024) continue; } catch { continue; }
    out.push(relative(repoRoot, abs).split('\\').join('/'));
  }
  return out;
}

function safeRead(abs) {
  try { return existsSync(abs) ? readFileSync(abs, 'utf8') : ''; } catch { return ''; }
}
