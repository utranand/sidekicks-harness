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
 * The one line that says whether this mount is current — and, when it cannot say, WHY.
 *
 * The old renderer had two arms and three worlds to describe, so "the remote does not serve the ref
 * you track" and "the network is down" were printed identically. On a tag-pinned mount — every
 * released core — the first was permanent and looked like the second, which is the whole of N-1.
 *
 * A tag pin is also a different question from a branch track. A branch mount can be BEHIND; a tag
 * mount cannot, it is pinned, and the useful thing to say is whether a newer release exists.
 *
 * @param {{remoteReadOk: boolean|null, remoteRef: {sha: string, kind: string}|null,
 *          remoteTip: string|null, behindRemote: boolean|null, want: string,
 *          newerRelease: string|null}} s
 * @returns {string}
 */
function upstreamLine(s) {
  if (s.remoteReadOk === null) return '(no origin to read)';
  if (s.remoteReadOk === false) return '(could not reach the remote)';
  if (!s.remoteRef) {
    return `the remote was reached, and it does not serve '${s.want}' — `
      + "the ref this mount tracks is gone or misspelled; 'sidekicks core update --ref <ref>' re-pins it";
  }
  if (s.remoteRef.kind === 'tag') {
    const pinned = `pinned to ${s.want}`;
    if (s.newerRelease) {
      return `${pinned} — newer release ${s.newerRelease} available; `
        + `run 'sidekicks core update --ref ${s.newerRelease}'`;
    }
    // A tag whose sha no longer matches the checkout means the tag itself moved under the mount.
    if (s.behindRemote) {
      return `${pinned}, but the remote now serves ${shortSha(s.remoteTip)} for that tag — `
        + 'the tag was moved; re-pin deliberately or investigate';
    }
    return `${pinned} — the newest release`;
  }
  return s.behindRemote
    ? `newer commit available on ${s.want} (${shortSha(s.remoteTip)}) — run 'sidekicks core update'`
    : `up to date with ${s.want}`;
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

  // Remote tip of the tracked ref. A network read, so it is skipped under --offline.
  //
  // THREE OUTCOMES, NOT TWO. This block used to collapse every failure into one `remoteTip = null`,
  // which the renderer then printed as "(could not read the remote)". So a mount pinned to a TAG —
  // the normal state of a released core, and what every installer produces — reported a network
  // failure on a working network, because the lookup only ever asked for `refs/heads/<want>`
  // (INC-2026-09-04-02, N-1). The three are now kept apart:
  //
  //   remoteReadOk === false        the remote could not be reached. Nothing is known.
  //   remoteReadOk && !remoteRef    reached, and it does not serve the ref this mount tracks.
  //   remoteReadOk && remoteRef     reached, and here is the sha (from a branch or a peeled tag).
  //
  // `lsRemote` already returns tags and their `^{}` peels, so the tag rung costs no extra round trip.
  let remoteReadOk = null;                  // null = not asked (offline, or no fetch URL)
  let remoteRef = null;                     // {sha, kind} | null
  let newerRelease = null;
  const want = tracked?.ref
    || (info.branch && info.branch !== 'HEAD' ? info.branch : 'main');
  if (!offline && info.fetchUrl) {
    try {
      const refs = git.lsRemote(info.fetchUrl);
      remoteReadOk = true;
      // Prefer the RECORDED intent over the checked-out branch: on a detached mount the branch is
      // the literal 'HEAD', and comparing against main would report "behind" against a branch this
      // workspace never asked for.
      remoteRef = git.findRemoteRef(refs, want);
      // A tag pin does not go stale — it is pinned. The useful question there is not "are you
      // behind" but "has a newer release been published", which is a different sentence.
      if (remoteRef && remoteRef.kind === 'tag') newerRelease = git.newerReleaseTag(refs, want);
    } catch { remoteReadOk = false; }
  }
  const remoteTip = remoteRef ? remoteRef.sha : null;

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
      // Whether the remote could be READ, kept apart from what it served. `remote_tip: null` alone
      // could not tell "the network is down" from "the remote does not serve v1.4.2", and the
      // renderer printed both as a network failure. null here means the question was not asked.
      remote_read_ok: remoteReadOk,
      remote_ref: want,
      remote_ref_kind: remoteRef ? remoteRef.kind : null,
      // A pinned mount is not "behind" — it is pinned. This is the question that actually applies.
      newer_release: newerRelease,
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
    out.push(`upstream:  ${upstreamLine({ remoteReadOk, remoteRef, remoteTip, behindRemote, want, newerRelease })}`);
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
