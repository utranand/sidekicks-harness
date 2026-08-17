// lib/core-lifecycle/status.mjs
// `sidekicks core status [--json] [--offline]`
//
// What framework version this workspace is running, and whether the mount is healthy. Read-only:
// every git call here is non-throwing, because status must be able to DESCRIBE a broken mount rather
// than die on it.
//
// `--offline` skips the network read (the upstream ahead/behind comparison), for a CI box or a
// laptop on a plane.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../sk-cli/errors.mjs';
import { frameworkDrift } from '../framework-settings/materialize.mjs';
import { SETTINGS_REL_DIR } from '../framework-settings/framework-config.mjs';
import * as git from '../git-delegation/git.mjs';
import { parseCoreFlags, requireCore, inspectCore, shortSha } from './_shared.mjs';
import { inspectPushGuard } from './_guard.mjs';
import { auditWiring, WIRING_FILES } from './_wiring.mjs';
import { readTrackedRef } from './_ref.mjs';

/**
 * Count overlay links in .agents/skills and the workspace's own real skill directories.
 *
 * @param {string} repoRoot
 * @param {string} coreDir
 * @returns {{linked: number, own: number, coreShips: number}}
 */
export function countSkills(repoRoot, coreDir) {
  const wsDir = join(repoRoot, '.agents', 'skills');
  const coreSkillsDir = join(coreDir, '.agents', 'skills');

  let coreShips = 0;
  if (existsSync(coreSkillsDir)) {
    try {
      coreShips = readdirSync(coreSkillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink()).length;
    } catch { /* unreadable — reported as 0 */ }
  }

  let linked = 0;
  let own = 0;
  if (existsSync(wsDir)) {
    try {
      for (const d of readdirSync(wsDir, { withFileTypes: true })) {
        const abs = join(wsDir, d.name);
        let st;
        try { st = lstatSync(abs); } catch { continue; }
        if (st.isSymbolicLink()) linked += 1;
        else if (st.isDirectory()) own += 1;
      }
    } catch { /* unreadable */ }
  }

  return { linked, own, coreShips };
}

/**
 * Run `core status`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {object} _args - unused
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const flags = parseCoreFlags(ctx.argv, ['json', 'offline']);
  const offline = flags.offline === true;

  const coreDir = requireCore(repoRoot, 'core status');
  const info = inspectCore(repoRoot, coreDir);
  const guard = inspectPushGuard(coreDir);
  const skills = countSkills(repoRoot, coreDir);
  const wiringProblems = auditWiring(repoRoot);

  // What this mount is MEANT to track, which a detached HEAD cannot tell you — the reason `core
  // update` used to fall through to main on a core installed from another ref. See _ref.mjs.
  const tracked = readTrackedRef(repoRoot, coreDir, info.coreRel);

  // Remote tip of the tracked branch. A network read, so it is skipped under --offline and its
  // failure is a null rather than an error.
  let remoteTip = null;
  if (!offline && info.fetchUrl) {
    try {
      const refs = git.lsRemote(info.fetchUrl);
      // Prefer the RECORDED intent over the checked-out branch: on a detached mount the branch is
      // the literal 'HEAD', and comparing against main would report "behind" against a branch this
      // workspace never asked for.
      const want = tracked?.ref
        || (info.branch && info.branch !== 'HEAD' ? info.branch : 'main');
      const hit = Array.isArray(refs) ? refs.find((r) => r && r.ref === `refs/heads/${want}`) : null;
      remoteTip = hit ? hit.sha : null;
    } catch { remoteTip = null; }
  }

  let sync = null;
  try {
    sync = frameworkDrift(repoRoot);
  } catch { /* an unreadable registry is reported as null */ }

  const behindRemote = remoteTip && info.head ? remoteTip !== info.head : null;

  if (flags.json) {
    const payload = {
      mounted: true,
      path: info.coreRel,
      head: info.head,
      ref: info.describe || info.branch,
      tag: info.describe,
      branch: info.branch,
      tracked_ref: tracked ? tracked.ref : null,
      tracked_ref_source: tracked ? tracked.source : null,
      marker: info.marker,
      fetch_url: info.fetchUrl,
      push_url: info.pushUrl,
      dirty: info.dirty,
      upstream: info.upstream,
      remote_tip: remoteTip,
      behind_remote: behindRemote,
      push_guard: guard,
      skills,
      wiring: { files: WIRING_FILES, problems: wiringProblems },
      framework_sync: sync
        ? { listed: sync.listed.length, toggleable: sync.toggleable, missing: sync.missing }
        : null,
    };
    return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: EXIT_OK };
  }

  const out = [];
  out.push(`core:      ${info.coreRel}`);
  out.push(`version:   ${info.marker?.version || '(marker carries no version)'}`
    + (info.marker?.name ? `  [${info.marker.name}]` : ''));
  out.push(`ref:       ${info.describe ? `${info.describe} (tag)` : info.branch || '(detached)'} @ ${shortSha(info.head)}`);
  out.push(`tracks:    ${tracked
    ? `${tracked.ref}  [${tracked.source}]`
    : "(nothing recorded — 'core update' falls back to main; pin it with 'core update --ref <ref>')"}`);
  out.push(`remote:    ${info.fetchUrl || '(no origin)'}`);
  if (info.upstream) {
    out.push(`tracking:  ${info.upstream.ahead} ahead, ${info.upstream.behind} behind origin/${info.branch}`);
  }
  if (!offline) {
    out.push(`upstream:  ${remoteTip
      ? (behindRemote ? `newer commit available (${shortSha(remoteTip)}) — run 'sidekicks core update'` : 'up to date')
      : '(could not read the remote)'}`);
  }
  out.push(`worktree:  ${info.dirty
    ? 'MODIFIED tracked files — the core is read-only, so this is unexpected'
    : `clean${info.untracked ? ` (${info.untracked} untracked file(s), which is fine)` : ''}`}`);
  out.push(`push:      ${guard.armed ? 'guarded (read-only)' : 'NOT fully guarded — run \'sidekicks core doctor\''}`);
  out.push(`skills:    ${skills.linked} linked from the core, ${skills.own} authored here `
    + `(core ships ${skills.coreShips})`);
  out.push(`wiring:    ${wiringProblems.length === 0
    ? 'all hook paths route through the mount'
    : `${wiringProblems.length} file(s) still bypass the mount — run 'sidekicks core init'`}`);
  if (sync) {
    out.push(`enable map: ${sync.listed.length}/${sync.toggleable} entries listed in ${SETTINGS_REL_DIR}/`
      + (sync.missing.length ? ` — ${sync.missing.length} unlisted, run 'sidekicks framework sync'` : ''));
  }

  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
