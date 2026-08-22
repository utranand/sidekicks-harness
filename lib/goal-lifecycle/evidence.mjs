// lib/goal-lifecycle/evidence.mjs
// What an attempt ACTUALLY changed, derived from Git rather than reported by the model.
//
// `changed_paths` IN A SESSION'S RESULT IS A CLAIM, NOT EVIDENCE. It is written by the same process
// whose work is being judged, it is written from memory at the end of a long turn, and a session that
// edited a file it was not supposed to touch has every reason — including plain forgetfulness — not to
// list it. So the write-root boundary is checked against a per-checkout before/after comparison of the
// filesystem, and the model's own list is kept only as a cross-check for the report.
//
// BEFORE/AFTER, NOT "DIFF AGAINST HEAD". A plan may legitimately run in a checkout that already had
// uncommitted work in it, and `git diff HEAD` in that tree returns that work too — so an attempt gets
// credit for changes it never made, a reviewer rules on a diff containing someone else's edits, and the
// write-root check flags files the attempt never touched. The baseline is captured immediately before
// dispatch and the delta is computed against it.
//
// EVERY OWNING CHECKOUT, NOT THE OUTER REPOSITORY. A plan that touches a service's own repository under
// `projects/<p>/services/<s>/src` writes into a DIFFERENT git checkout, and the outer repository reports
// that as one dirty gitlink — a single line that says a nested tree moved and nothing about how. Each
// owning checkout is captured and diffed on its own, and each section of the evidence says which
// checkout it came from.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';

/** How much of one checkout's patch is kept. A prompt is not a file, and neither is an artifact. */
export const DIFF_CHAR_CAP = 400_000;

/**
 * Content identity: what a path IS, not merely what git calls it.
 *
 * WHY A STATUS CODE IS NOT ENOUGH. A porcelain status describes a path's relationship to the index,
 * and for some paths that relationship does not move when the bytes do. A file that was already
 * untracked before the attempt is `??` before and `??` after — so a session that overwrote it looked,
 * to a status-code comparison, like a session that never touched it. The attempt was not attributed
 * with the write, and the write-root gate had nothing to reject. The implementation preflight
 * deliberately permits a dirty tree, so this was reachable in an ordinary run, not a corner case.
 *
 * WHAT IS COMPARED. The mode bits, the type (file, directory, symlink), a symlink's target, and the
 * content — so an overwrite, a chmod, a file replaced by a symlink and a symlink repointed are each a
 * change. Hashing is bounded twice: per file by `IDENTITY_HASH_CAP` (a larger file falls back to size
 * and mtime), and per checkout by `IDENTITY_PATH_CAP` (a checkout dirtier than that uses size and
 * mtime throughout). The strategy is recorded in the baseline so the delta compares like with like.
 */
export const IDENTITY_HASH_CAP = 8 * 1024 * 1024;

/** Above this many dirty paths in one checkout, identity is stat-only. */
export const IDENTITY_PATH_CAP = 5_000;

/**
 * The identity of one path, or null when it cannot be read.
 *
 * null is "unknown", never "unchanged": a path that was readable at baseline and is not now HAS
 * changed, and saying so is the point. Two unknowns in a row are the one case that reports nothing —
 * there is no evidence either way, and flagging it every attempt would train an operator to ignore
 * the boundary.
 *
 * @param {string} abs
 * @param {{hash?: boolean}} [opts]
 * @returns {string|null}
 */
export function contentIdentity(abs, opts = {}) {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
    if (st.isDirectory()) return 'dir';
    const mode = (st.mode & 0o777).toString(8);
    if (!st.isFile()) return `other:${mode}`;
    if (opts.hash === false || st.size > IDENTITY_HASH_CAP) {
      return `file:${mode}:size-mtime:${st.size}:${Math.trunc(st.mtimeMs)}`;
    }
    return `file:${mode}:sha256:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`;
  } catch {
    return null;
  }
}

/** Do two identities describe the same thing? Two unknowns are not evidence of sameness. */
function sameIdentity(before, after) {
  if (before === null && after === null) return true;
  return before === after;
}

/**
 * The status invocation, and why `--untracked-files=all` is not optional.
 *
 * By default git COLLAPSES an untracked directory to a single entry: a run that created
 * `artifacts/runs/<id>/…` shows up as one line reading `?? artifacts/`. Two things break on that. The
 * boundary check sees a path called `artifacts/`, which is not inside any approved write root and is
 * not inside the exempt run folder either — it is that folder's PARENT — so the engine flags its own
 * bookkeeping as an out-of-root write and fails every attempt. And the change set loses the actual
 * filenames, so a real out-of-root write hidden under a collapsed directory would be reported as the
 * directory rather than the file. Listing every file costs a walk of the untracked tree and buys an
 * accurate boundary.
 */
export const STATUS_ARGS = Object.freeze(['status', '--porcelain', '--untracked-files=all']);

/**
 * A git probe that never lets quoting or pagers change what it reports.
 *
 * `core.quotepath=false` matters: with the default on, a path containing a non-ASCII byte comes back
 * as `"caf\303\251.txt"`, and a write-root check comparing that against `café.txt` finds no match —
 * a file outside the approved roots would read as a path the boundary never saw.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string|null}
 */
export function git(cwd, args) {
  try {
    const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) return null;
    // `git diff --no-index` and `--exit-code` return 1 when files differ, which is the normal case.
    if (r.status !== 0 && r.status !== 1) return null;
    return String(r.stdout ?? '');
  } catch {
    return null;
  }
}

/**
 * Parse `git status --porcelain` into a path → status map.
 *
 * Renames arrive as `R  old -> new` and are recorded under the NEW path with the old one kept, because
 * a rename is a write at the destination and the boundary question is where the bytes landed. A path
 * with a literal ` -> ` in its name is possible and is why the split is bounded to the rename statuses
 * rather than applied to every line.
 *
 * @param {string} porcelain
 * @returns {Map<string, {status: string, from: string|null}>}
 */
export function parseStatus(porcelain) {
  /** @type {Map<string, {status: string, from: string|null}>} */
  const out = new Map();
  for (const raw of String(porcelain ?? '').split('\n')) {
    if (raw.trim() === '') continue;
    const status = raw.slice(0, 2);
    let path = raw.slice(3);
    let from = null;
    if (status.includes('R') || status.includes('C')) {
      const idx = path.indexOf(' -> ');
      if (idx !== -1) {
        from = unquote(path.slice(0, idx));
        path = path.slice(idx + 4);
      }
    }
    out.set(unquote(path), { status, from });
  }
  return out;
}

/** Strip the quoting git applies to a path with unusual bytes, if any survived. */
function unquote(path) {
  const s = String(path);
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/**
 * Capture the per-checkout baseline immediately before a dispatch.
 *
 * @param {string} repoRoot
 * @param {{path: string, abs?: string}[]} checkouts - repo-relative paths ('.' for the root)
 * @returns {{at_head: Record<string, string|null>,
 *            checkouts: {path: string, abs: string, head: string|null,
 *                        entries: Record<string, string>}[]}}
 */
export function captureBaseline(repoRoot, checkouts) {
  const rows = [];
  for (const checkout of dedupeCheckouts(checkouts)) {
    const abs = checkout.abs || absOf(repoRoot, checkout.path);
    if (!existsSync(abs)) continue;
    /** @type {Record<string, string>} */
    const entries = {};
    for (const [path, info] of parseStatus(git(abs, STATUS_ARGS) ?? '')) {
      entries[path] = info.status;
    }
    // Content identity for every path that is ALREADY dirty. Those are exactly the paths whose status
    // code cannot move when their bytes do, and they are a bounded set — the clean part of the tree is
    // covered by the status comparison alone.
    const paths = Object.keys(entries);
    const hash = paths.length <= IDENTITY_PATH_CAP;
    /** @type {Record<string, string|null>} */
    const identities = {};
    for (const path of paths) identities[path] = contentIdentity(join(abs, path), { hash });
    rows.push({
      path: checkout.path,
      abs,
      head: (git(abs, ['rev-parse', 'HEAD']) ?? '').trim() || null,
      entries,
      identities,
      identity_strategy: hash ? 'sha256' : 'size-mtime',
    });
  }
  const atHead = {};
  for (const row of rows) atHead[row.path] = row.head;
  return { at_head: atHead, checkouts: rows };
}

/** One row per distinct repo-relative checkout path, in a stable order. */
function dedupeCheckouts(checkouts) {
  const seen = new Map();
  for (const c of checkouts || []) {
    const path = String(c?.path ?? '.') || '.';
    if (!seen.has(path)) seen.set(path, { ...c, path });
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Absolute path of a repo-relative checkout path. */
function absOf(repoRoot, relPath) {
  const p = String(relPath ?? '.');
  if (isAbsolute(p)) return p;
  return p === '.' ? repoRoot : resolvePath(repoRoot, p);
}

/**
 * Compute what changed in every captured checkout since the baseline.
 *
 * @param {string} repoRoot
 * @param {object} baseline - from captureBaseline
 * @returns {{changed: {path: string, checkout: string, change: string, from: string|null}[],
 *            sections: {checkout: string, head_before: string|null, head_now: string|null,
 *                       diff: string, changed: object[]}[],
 *            diff: string}}
 */
export function collectDelta(repoRoot, baseline) {
  const sections = [];
  /** @type {object[]} */
  const changed = [];

  for (const row of baseline.checkouts || []) {
    const abs = row.abs || absOf(repoRoot, row.path);
    const now = parseStatus(git(abs, STATUS_ARGS) ?? '');
    const headNow = (git(abs, ['rev-parse', 'HEAD']) ?? '').trim() || null;

    /** @type {object[]} */
    const rows = [];
    /** Checkout-relative paths this attempt touched — used again for the untracked diffs below. */
    const touched = new Set();
    const hash = row.identity_strategy !== 'size-mtime';
    for (const [path, info] of now) {
      const wasStatus = row.entries?.[path];
      // Same path with the same status code is where a status-only comparison stops. A file that was
      // ' M' before and is 'MM' now DID change in this attempt (it was staged), which is why the code
      // and not merely the presence of the path is compared — and a path whose code did not move is
      // then checked by CONTENT, because for an already-dirty path the code cannot move.
      if (wasStatus !== undefined && wasStatus === info.status) {
        const before = row.identities?.[path];
        // A baseline written before identities existed has nothing to compare; the status comparison
        // is all there is, and inventing a change from a missing baseline would fail every attempt.
        if (before === undefined) continue;
        const after = contentIdentity(join(abs, path), { hash });
        if (sameIdentity(before, after)) continue;
        touched.add(path);
        rows.push({
          path: repoRelative(row.path, path),
          checkout: row.path,
          change: `${describeStatus(info.status)} — content changed in place`,
          from: null,
          identity_before: before,
          identity_after: after,
        });
        continue;
      }
      touched.add(path);
      rows.push({
        path: repoRelative(row.path, path),
        checkout: row.path,
        change: describeStatus(info.status),
        from: info.from ? repoRelative(row.path, info.from) : null,
      });
    }
    // A file that WAS dirty and is now clean was reverted or committed during the attempt — also a
    // change this attempt made, and one a reviewer would otherwise never see.
    for (const path of Object.keys(row.entries || {})) {
      if (now.has(path)) continue;
      rows.push({
        path: repoRelative(row.path, path),
        checkout: row.path,
        change: 'no-longer-modified',
        from: null,
      });
    }

    const parts = [];
    const tracked = git(abs, ['diff', '--stat', '--patch', 'HEAD']);
    if (tracked && tracked.trim() !== '') parts.push(tracked);
    // A node that CREATES a file produces no `git diff` at all, and "the attempt did nothing" is
    // exactly the wrong conclusion to hand a reviewer. The path used here is the CHECKOUT-relative one
    // straight off the status map, because that is the only form `git diff --no-index` resolves from
    // inside that checkout.
    for (const [inCheckout, info] of now) {
      if (info.status !== '??') continue;
      // A file that was untracked before AND was rewritten during the attempt still needs its content
      // in front of a reviewer — `touched` is what distinguishes it from the untracked files that were
      // simply sitting there.
      if (row.entries?.[inCheckout] === '??' && !touched.has(inCheckout)) continue;
      const body = git(abs, ['diff', '--no-index', '--', nullDevice(), inCheckout]);
      parts.push(
        body && body.trim() !== ''
          ? body
          : `new file: ${repoRelative(row.path, inCheckout)} (content unavailable)`,
      );
    }
    if (row.head && headNow && headNow !== row.head) {
      const committed = git(abs, ['diff', '--stat', '--patch', `${row.head}..${headNow}`]);
      if (committed && committed.trim() !== '') {
        parts.push(`--- committed during this attempt in ${row.path} ---\n${committed}`);
      }
      for (const line of (git(abs, ['diff', '--name-only', `${row.head}..${headNow}`]) ?? '').split('\n')) {
        const path = line.trim();
        if (path === '') continue;
        const full = repoRelative(row.path, path);
        if (rows.some((r) => r.path === full)) continue;
        rows.push({ path: full, checkout: row.path, change: 'committed', from: null });
      }
    }

    changed.push(...rows);
    sections.push({
      checkout: row.path,
      head_before: row.head,
      head_now: headNow,
      diff: cap(parts.join('\n')),
      changed: rows,
    });
  }

  return { changed: dedupeChanged(changed), sections, diff: renderDelta(sections) };
}

/** One entry per path; the first (most specific) description wins. */
function dedupeChanged(rows) {
  const seen = new Map();
  for (const row of rows) if (!seen.has(row.path)) seen.set(row.path, row);
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The whole delta as one labelled document — what a reviewer and the report both read. */
export function renderDelta(sections) {
  if (sections.length === 0) return '';
  if (sections.length === 1 && sections[0].checkout === '.') return sections[0].diff;
  return sections
    .map((s) => `=== checkout ${s.checkout} (${s.changed.length} path(s) changed) ===\n${s.diff || '(no changes)'}`)
    .join('\n\n');
}

/** A human name for a porcelain status pair. */
function describeStatus(status) {
  if (status === '??') return 'untracked (new)';
  if (status.includes('D')) return 'deleted';
  if (status.includes('R')) return 'renamed';
  if (status.includes('A')) return 'added';
  if (status.includes('C')) return 'copied';
  return 'modified';
}

function cap(text) {
  const s = String(text ?? '');
  if (s.length <= DIFF_CHAR_CAP) return s;
  return `${s.slice(0, DIFF_CHAR_CAP)}\n\n[...truncated ${s.length - DIFF_CHAR_CAP} more characters]`;
}

/** The platform's empty-file path, for `git diff --no-index`. */
function nullDevice() {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

/**
 * A checkout-relative path, expressed relative to the REPO ROOT.
 *
 * Always POSIX-separated, because that is the form the envelope's write roots are written in and a
 * comparison between `lib\goal-lifecycle` and `lib/goal-lifecycle` silently finds nothing.
 *
 * @param {string} checkoutPath - repo-relative, '.' for the root
 * @param {string} inCheckout
 * @returns {string}
 */
export function repoRelative(checkoutPath, inCheckout) {
  const inner = String(inCheckout).split('\\').join('/').replace(/^\.\//, '');
  const base = String(checkoutPath ?? '.').split('\\').join('/').replace(/^\.\//, '');
  if (base === '.' || base === '') return inner;
  return `${base.replace(/\/$/, '')}/${inner}`;
}

/**
 * Is this repo-relative path inside one of the approved write roots?
 *
 * `.` as a root means the whole repository, which is what `deriveWriteRoots` collapses a top-level file
 * to — honest about how wide that approval is rather than hiding it.
 *
 * @param {string} path - repo-relative, POSIX
 * @param {string[]} writeRoots
 * @returns {boolean}
 */
export function withinWriteRoots(path, writeRoots) {
  const p = String(path).split('\\').join('/').replace(/^\.\//, '');
  for (const raw of writeRoots || []) {
    const root = String(raw).split('\\').join('/').replace(/^\.\//, '').replace(/\/$/, '');
    if (root === '.' || root === '') return true;
    if (p === root || p.startsWith(`${root}/`)) return true;
  }
  return false;
}

/**
 * Check an attempt's real changes against the approved boundary.
 *
 * `exempt` is for the engine's OWN artifacts. The run folder lives under `artifacts/runs/`, the engine
 * writes into it on every transition, and counting those as the child's writes would make every attempt
 * a violation — the boundary would be so loud it would be turned off.
 *
 * @param {{changed: object[], writeRoots: string[], exempt?: string[]}} input
 * @returns {{ok: boolean, violations: {path: string, checkout: string, change: string}[],
 *            in_roots: object[], exempted: object[]}}
 */
export function checkWriteRoots(input) {
  const exempt = (input.exempt || []).map((e) => String(e).split('\\').join('/').replace(/\/$/, ''));
  const violations = [];
  const inRoots = [];
  const exempted = [];
  for (const row of input.changed || []) {
    const p = String(row.path).split('\\').join('/');
    if (exempt.some((e) => e !== '' && (p === e || p.startsWith(`${e}/`)))) {
      exempted.push(row);
      continue;
    }
    if (withinWriteRoots(p, input.writeRoots)) inRoots.push(row);
    else violations.push(row);
  }
  return { ok: violations.length === 0, violations, in_roots: inRoots, exempted };
}

/**
 * The lines a violation report shows an operator.
 *
 * @param {object[]} violations
 * @param {string[]} writeRoots
 * @returns {string[]}
 */
export function describeViolations(violations, writeRoots) {
  const out = violations.map((v) => `${v.path} (${v.change}) in checkout ${v.checkout}`);
  out.push(`approved write roots: ${(writeRoots || []).join(', ') || '(none)'}`);
  out.push(
    'The files are still on disk exactly as the session left them — nothing was reverted. Inspect them, '
    + 'then either widen the approval by re-planning or undo them yourself.',
  );
  return out;
}

/**
 * Cross-check the session's own `changed_paths` against what Git shows.
 *
 * Not a gate. A mismatch is worth a reviewer's attention — a session that under-reports its own writes
 * is describing work it did not describe — but the enforcement decision is made on the Git evidence
 * alone, so a model that reports nothing at all changes no outcome here.
 *
 * @param {string[]} claimed
 * @param {object[]} changed
 * @returns {{unclaimed: string[], claimed_not_seen: string[]}}
 */
export function crossCheckClaims(claimed, changed) {
  const normalize = (p) => String(p).split('\\').join('/').replace(/^\.\//, '');
  const actual = new Set((changed || []).map((c) => normalize(c.path)));
  const said = new Set((claimed || []).map(normalize));
  return {
    unclaimed: [...actual].filter((p) => !said.has(p)).sort(),
    claimed_not_seen: [...said].filter((p) => !actual.has(p)).sort(),
  };
}

/**
 * The checkouts an attempt on this node could write into: the envelope's, plus the node's own owners.
 *
 * @param {object} envelope
 * @param {object[]} [owners] - from resolveWriteOwners
 * @returns {{path: string, abs?: string}[]}
 */
export function checkoutsFor(envelope, owners = []) {
  const rows = [...(envelope?.checkouts || []).map((c) => ({ path: c.path }))];
  for (const owner of owners) rows.push({ path: owner.path, abs: owner.abs });
  if (rows.length === 0) rows.push({ path: '.' });
  return dedupeCheckouts(rows);
}

/** The repo-relative form of an absolute path, POSIX-separated. */
export function repoRel(repoRoot, abs) {
  const rel = relative(repoRoot, abs);
  return (rel === '' ? '.' : rel).split('\\').join('/');
}

/** The engine's own write surface for one run — exempt from the child's write-root check. */
export function exemptRunDir(repoRoot, runDir) {
  return [repoRel(repoRoot, runDir)];
}
