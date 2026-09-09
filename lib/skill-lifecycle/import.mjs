// lib/skill-lifecycle/import.mjs
// `sidekicks skill import <skill>… | --all --from <path> [--adopt] [--apply] [--force] [--json]`
//
// Bring a skill in from ANY repository that holds skills, reconciling against what is already here.
//
// THE BASELINE IS FOUND, NOT INVENTED. A three-way compare needs a reference distinct from both
// sides, and the local skill's own `bundle{}` IS "the state a human last blessed": `skill verify` is
// precisely the question "has the local copy drifted from it". So the three sides are local-disk,
// local-recorded and incoming-recorded, and for a manifested skill nothing has to be written down to
// make that work. (sk-inherit maintains .sidekicks/inherit.json for the same job because it
// predates AAP-100 and its baseline covers non-skill surfaces too.)
//
// A skill that legitimately needs no manifest has no such baseline, and used to be refused for it —
// 23 of 107 rows against this repo's own two skills repositories. Those fall back to comparing
// CONTENT, which is weaker and says so per row (`verified: false`).
//
// FOREIGN SOURCES. `--from` no longer has to be a sidekicks skills repository. source-layout.mjs
// detects the shape (flat `skills/<n>/`, nested, `.claude/skills/`, bare root) and `--adopt` is the
// explicit consent required to convert one. Nothing about a foreign skill is rewritten: the folder
// is copied byte-exact, and everything a human must decide is emitted as plan lines by adopt.mjs.
//
// The statuses use inherit's STATUS_ORDER vocabulary deliberately, so an operator who has read one
// drift report can read the other. Shared WORDS, not shared code — a lib/ module may not import a
// skill's script, and a relative cross-skill reach is an audit error.
//
// WHAT AN IMPORT DID IS RECORDED. Every applied row writes a registration profile under
// `.sidekicks/registry/skills/` (lib/skill-registry/), because the side-effects of an import —
// where it came from, which criteria it turned on here, whether it was converted — are not
// derivable from the folder afterwards, and `skill remove` needs them. That is a receipt for an
// event, not a cache of facts that already exist elsewhere.
//
// IT NEVER WRITES OUTSIDE .sidekicks/. Hook wiring, repo-root files, AGENTS.md lines and audit-group
// membership come out as an ordered APPLY PLAN on stdout, for the operator to walk with the skill.
// A hook needs the same change in four per-CLI config files (Rule 6) and group membership is a
// judgement call; a verb that guessed at either would break the repo it was extending.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { SKILLS_ROOT_SEGMENTS, SKILLS_ROOT_REL, SKILL_TREE_BY_BASENAME } from '../sk-cli/skill-trees.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT_OK, EXIT_VALIDATION, EXIT_USAGE, EXIT_NOT_FOUND, SidekicksError,
} from '../sk-cli/errors.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { writeAtomic, execAwareMode, rmrf } from '../fs-safety/fsx.mjs';
import { gitExecPaths, resolveSourceMode } from '../skill-manifest/mode.mjs';
import {
  discoverSkills, readSkillManifest, readSkillDescriptor, MANIFEST_NAME,
} from '../skill-manifest/read.mjs';
import { parseManifest } from '../skill-manifest/schema.mjs';
import { hashContent, isBinaryPath } from '../skill-manifest/hash.mjs';
import { bundleFileList } from '../skill-package/portable.mjs';
import { readSource, LAYOUTS } from '../skill-package/source-layout.mjs';
import { adoptionPlan, marketplacePlugins } from '../skill-package/adopt.mjs';
import { recordProfile, readProfile, mirrorFacts, fileHashes } from '../skill-registry/store.mjs';
import { appendHistory } from '../skill-registry/profile.mjs';
import { buildRegistry } from '../framework-settings/registry.mjs';
import { configuredDestinations } from './destinations.mjs';
import { isRepo, remoteUrl, headCommit, currentBranch } from '../git-delegation/git.mjs';
import { nowBangkok } from '../artifacts-lifecycle/_shared.mjs';
import { scanSkill, walkSkillFiles, manifestRequired } from './scan.mjs';
import {
  parseSkillFlags, positionalArgs, backupSkillDir, collectRepeated, versionDelta,
} from './_shared.mjs';

/**
 * The reconcile statuses, in the order a report should present them — worst first, so a reader sees
 * what needs a decision before what needs nothing. Same vocabulary as sk-inherit's drift
 * report.
 */
export const STATUS_ORDER = Object.freeze([
  'broken', 'conflict', 'local-only', 'behind', 'unversioned', 'new', 'ff', 'up-to-date',
]);

/** Statuses that refuse to proceed without --force. */
const NEEDS_FORCE = Object.freeze(new Set(['conflict', 'local-only', 'behind', 'unversioned']));

/**
 * Statuses `--force` does NOT open.
 *
 * `--force` means "I accept losing the local side" — it has never meant "I accept importing
 * something corrupt". An incoming copy that contradicts its own manifest would be written next to
 * that manifest, so the very first `skill doctor` reports `bundle-stale` and the next export
 * refuses; the operator would have forced their way into a skill that cannot be published. The
 * answer is at the source: re-export it.
 */
const NEVER_APPLY = Object.freeze(new Set(['broken']));

/**
 * Every skill directory in a NATIVE incoming tree, keyed by name.
 *
 * Kept as the layout-1 shorthand over the general reader, because a native source is the only one
 * that needs no decisions: it already has the trees, the names and the manifests. Any other shape
 * goes through `readSource` with a layout, and through the `--adopt` gate.
 */
export function readIncoming(fromRoot) {
  return readSource(fromRoot, { layout: 'sidekicks' }).entries;
}

/**
 * The incoming skill's recorded bundle, whether its files match it, and how far it can be trusted.
 *
 * FOUR TRUST STATES, because "no manifest" is two entirely different facts and conflating them is
 * what blocked 23 of 107 rows against this repo's own skills repositories:
 *
 * - `intact`     — a manifest that parses and whose every hash matches. The only state with a
 *                  baseline to reason from.
 * - `broken`     — a manifest that is present but fails validation, or contradicts its own files.
 *                  Never importable; see NEVER_APPLY.
 * - `undeclared` — no manifest, and `manifestRequired()` says one IS required (the skill has
 *                  scripts/, third-party imports, sibling edges, binaries or a descriptor). Its
 *                  dependency closure is genuinely unknown, so this still stops.
 * - `walk`       — no manifest, and none is required. `manifestRequired` (scan.mjs) and
 *                  `skill doctor` both call this skill complete; only import used to call it
 *                  unversioned. There is no baseline, so comparison falls back to file CONTENT,
 *                  which is a weaker but perfectly real answer.
 *
 * A NON-NATIVE (foreign-layout) entry is always `walk`: an upstream repo has no reason to ship a
 * sidekicks manifest, and the apply plan generates one with `skill manifest --apply` after the copy.
 * Holding a foreign skill to `undeclared` would mean no foreign skill could ever be imported.
 *
 * The scan is LAZY — it only runs in the no-manifest lane, so a native `--all` over 84 manifested
 * rows pays nothing for it.
 */
function readIncomingState(entry, ctx = {}) {
  const abs = join(entry.dir, MANIFEST_NAME);
  if (existsSync(abs)) {
    const { manifest, errors } = parseManifest(readFileSync(abs, 'utf8'), entry.skill, entry.relDir);
    if (!manifest || errors.length) {
      return { bundle: null, trust: 'broken', intact: false, mismatches: errors };
    }
    const bundle = manifest.bundle || {};
    const mismatches = [];
    for (const [rel, recorded] of Object.entries(bundle)) {
      const f = join(entry.dir, ...rel.split('/'));
      if (!existsSync(f)) { mismatches.push(`${rel} (absent)`); continue; }
      if (hashContent(readFileSync(f), isBinaryPath(rel)) !== recorded) mismatches.push(`${rel} (hash)`);
    }
    return {
      bundle: mismatches.length ? null : bundle,
      trust: mismatches.length ? 'broken' : 'intact',
      intact: mismatches.length === 0,
      mismatches,
      requires: manifest.requires,
      // The executability the upstream RECORDED. Outranks anything this host can observe about
      // the incoming files, which is the point: a Windows working tree cannot observe it at all.
      modes: manifest.modes || {},
    };
  }

  if (entry.native === false) {
    return { bundle: null, trust: 'walk', intact: false, mismatches: [], because: [], modes: {} };
  }
  const files = walkSkillFiles(entry.dir);
  const scan = scanSkill(ctx.fromRoot || entry.dir, entry, ctx.universe || new Set(), { files });
  const descriptor = readSkillDescriptor(ctx.fromRoot || entry.dir, entry);
  const { required, because } = manifestRequired(scan, Boolean(descriptor));
  return {
    bundle: null,
    trust: required ? 'undeclared' : 'walk',
    intact: false,
    mismatches: [],
    because,
    modes: {},
  };
}

/**
 * The files an import would write, and whether that list came from a verified baseline.
 *
 * `source: 'walk'` is the honest half: nothing checked those bytes against a recording, and the
 * report says so per row rather than letting a walk-sourced copy look like a verified one. Same
 * distinction `bundleFileList` draws locally and `origin.yaml` records as `bundle_verified`.
 *
 * walkSkillFiles (not a raw readdir) because it already skips `node_modules`, `__pycache__`,
 * `.venv`, `.git` and `.pytest_cache` — exactly what a foreign checkout arrives carrying, and
 * exactly what must never be copied into `.sidekicks/`.
 */
function incomingFileList(entry, inState) {
  if (inState.bundle) {
    return { files: [...Object.keys(inState.bundle), MANIFEST_NAME].sort(), source: 'bundle' };
  }
  return { files: walkSkillFiles(entry.dir).map((f) => f.rel).sort(), source: 'walk' };
}

/** A stable fingerprint of a recorded bundle, for comparing two baselines. */
function bundleKey(bundle) {
  if (!bundle) return null;
  return Object.keys(bundle).sort().map((k) => `${k}=${bundle[k]}`).join('\n');
}

/**
 * A content fingerprint of a skill folder, EXCLUDING the manifest.
 *
 * The fallback discriminator when at least one side has no recorded baseline. The manifest is left
 * out on purpose: it is the thing being compared *with*, and one side lacking it is the very case
 * this exists to answer.
 */
function contentKey(dir) {
  const rows = [];
  for (const f of walkSkillFiles(dir)) {
    if (f.rel === MANIFEST_NAME) continue;
    rows.push(`${f.rel}=${hashContent(readFileSync(f.abs), isBinaryPath(f.rel))}`);
  }
  return rows.sort().join('\n');
}

/**
 * Classify one incoming skill against the local tree. Pure.
 *
 * @param {string} repoRoot
 * @param {object} incoming - an entry from readIncoming()
 * @param {Map<string, object>} localByName
 * @returns {{skill: string, status: string, detail: string, files: string[], incoming: object}}
 */
/** A recorded path, POSIX. A receipt written on macOS must match a re-import run on Windows. */
function posixPath(v) {
  return String(v === null || v === undefined ? '' : v).split('\\').join('/');
}

/**
 * Does this receipt describe the SAME upstream the incoming entry came from?
 *
 * This is the question the collision gate never asked. A foreign skill arriving under a name this
 * repo already uses is normally a COLLISION — two folders with no shared history, where
 * "fast-forward" would mean overwriting an unrelated skill. But when the local copy came from this
 * very upstream, the same name IS the same skill, and refusing it makes "pull the update" impossible
 * for every third-party skill this repo has ever adopted.
 *
 * Strictness is load-bearing in BOTH directions. Too loose and an unrelated folder gets overwritten;
 * too loose is also unrecoverable downstream, because profileFacts preserves provenance for a
 * matched upstream, so a receipt that matched the wrong one stays wrong for good.
 *
 * `source.remote` is a tiebreaker, not a requirement: a plain-folder source legitimately has none,
 * and sourceGit() is best-effort — every receipt in this repo records `remote: ''` — so demanding
 * one would leave every folder-sourced receipt permanently unmatched. It only ever disqualifies.
 *
 * @param {object|null|undefined} profile - the parsed receipt for the LOCAL name
 * @param {object} entry - the incoming source entry
 * @param {{native: boolean, source_kind: string}} src
 * @param {string} sourceRemote - the incoming source's git remote, or ''
 * @returns {boolean}
 */
export function sameUpstream(profile, entry, src, sourceRemote = '') {
  if (!profile || !entry) return false;
  const up = profile.upstream || {};
  const adapter = profile.adapter || {};
  const source = profile.source || {};
  // The UPSTREAM name, not the local one — they differ exactly when --rename resolved a collision,
  // which is precisely the case a re-import has to keep straight.
  if (String(up.name || '') !== String(entry.skill || '')) return false;
  if (posixPath(up.path) !== posixPath(entry.upstreamRel)) return false;
  if (String(adapter.layout || '') !== String(entry.layout || '')) return false;
  const kindNow = src && src.native ? 'sidekicks' : (src && src.source_kind) || '';
  if (String(source.kind || '') !== kindNow) return false;
  const recordedRemote = String(source.remote || '');
  if (recordedRemote && sourceRemote && recordedRemote !== sourceRemote) return false;
  return true;
}

/** `rel=hash` lines for a recorded hash map, in contentKey()'s shape so the three sides compare. */
function hashKey(map, skip) {
  return Object.keys(map || {})
    .filter((rel) => !skip.has(rel))
    .sort()
    .map((rel) => `${rel}=${map[rel]}`)
    .join('\n');
}

/** contentKey(), but skipping an explicit set rather than only the manifest. */
function contentKeyExcept(dir, skip) {
  const rows = [];
  for (const f of walkSkillFiles(dir)) {
    if (skip.has(f.rel)) continue;
    rows.push(`${f.rel}=${hashContent(readFileSync(f.abs), isBinaryPath(f.rel))}`);
  }
  return rows.sort().join('\n');
}

/**
 * The three-way reconcile with the RECEIPT as base. Null when the receipt cannot serve as one.
 *
 * A foreign skill has no manifest on either side, so before this the only available answer was byte
 * equality — which cannot say who moved, and therefore could never resolve an update. But the first
 * import already recorded the as-installed hashes, and that IS a base distinct from both sides.
 *
 * WHAT IS IGNORED, and why it is a rule rather than a filename. A file present locally but absent
 * from BOTH the receipt and the incoming copy is left out of the compare. The import's own printed
 * plan says to run `skill manifest <name> --apply`, so a synthesized manifest is exactly what an
 * operator who followed instructions will have; counting it as a local edit would report
 * `local-only` on every correctly-followed import's next update — the framework's own step read as
 * the human's. Excluding `skill.manifest.yaml` by name would have fixed that one file and missed
 * the `VERSION.json` lib/package-lifecycle auto-creates for every skill directory, which breaks the
 * identical population in the identical way. So: not in the receipt and not incoming, not compared.
 *
 * A backfilled receipt is NOT a base. Its `files{}` is a snapshot of now, not of the install
 * (registry.mjs backfilledFacts), so using it would attribute post-import edits to the upstream.
 *
 * @returns {{status: string, detail: string}|null}
 */
function receiptStatus(profile, local, incoming) {
  const recorded = (profile && profile.files) || {};
  if (!Object.keys(recorded).length) return null;
  if (String(profile.files_recorded_at || '') === 'backfill') return null;

  const incomingRels = new Set(walkSkillFiles(incoming.dir).map((f) => f.rel));
  const recordedRels = new Set(Object.keys(recorded));
  // Everything the compare must not look at: files neither side of the UPSTREAM relationship knows.
  const skip = new Set([MANIFEST_NAME]);
  for (const f of walkSkillFiles(local.dir)) {
    if (!incomingRels.has(f.rel) && !recordedRels.has(f.rel)) skip.add(f.rel);
  }

  const base = hashKey(recorded, skip);
  const localKey = contentKeyExcept(local.dir, skip);
  const incomingKey = contentKeyExcept(incoming.dir, skip);
  const localMoved = localKey !== base;
  const incomingMoved = incomingKey !== base;

  if (!localMoved && !incomingMoved) {
    return { status: 'up-to-date', detail: 'nothing has moved since the recorded import' };
  }
  if (!localMoved) {
    return {
      status: 'ff',
      detail: 'local is exactly as imported and the upstream has moved — a clean fast-forward '
        + 'against the import receipt',
    };
  }
  if (!incomingMoved) {
    return {
      status: 'local-only',
      detail: 'edits here post-date the recorded import and the upstream has not moved — EXPORT or '
        + 'reconcile by hand rather than importing over them',
    };
  }
  if (localKey === incomingKey) {
    return { status: 'up-to-date', detail: 'both sides moved to the same bytes since the import' };
  }
  return {
    status: 'conflict',
    detail: 'both sides moved differently since the recorded import',
  };
}

/**
 * Was the upstream match made on weak evidence?
 *
 * With no git remote on either side, `upstream.name` + `upstream.path` + `adapter.layout` +
 * `source.kind` are all there is — and two unrelated plain folders holding a same-named skill in the
 * same layout match on every one of them. The reconcile still STOPS in that case (the contents
 * differ, so it is a `conflict`, which needs `--force`), but the operator deserves to be told the
 * match was thin rather than reading "both sides moved" about a repo they have never imported from.
 */
function weakUpstreamMatch(profile, sourceRemote) {
  return !String((profile.source || {}).remote || '') && !sourceRemote;
}

/**
 * THE ONE PLACE A ROW BECOMES A STATUS — and the only place `ff` is allowed to survive.
 *
 * `ff` says "nothing recorded here would be lost". It never said "the incoming copy is newer", and
 * the reconcile had no way to tell: it compared baselines for EQUALITY only. Against this repo's own
 * published skills that read 20 rows as clean fast-forwards where the LOCAL copy was newer
 * (sk-commander 1.4.1 local against 1.1.0 published), so `--apply` would have replaced current
 * skills with older ones and called it clean. A backup makes that recoverable, not correct.
 *
 * Funnelling every return through here is deliberate: there are now TWO lanes that can produce `ff`
 * (the manifest three-way and the receipt three-way), and a downgrade guard applied per-branch would
 * cover whichever lane was written first and silently miss the other.
 *
 * @param {object} row
 * @param {string} status
 * @param {string} detail
 * @returns {object}
 */
function settle(row, status, detail) {
  const v = row.version;
  if (status === 'ff' && v && v.comparable && v.cmp < 0) {
    return {
      ...row, status: 'behind',
      detail: `the incoming copy is OLDER (${v.incoming} < ${v.local}, per ${v.from}) — importing `
        + 'it would DOWNGRADE this skill',
    };
  }
  return { ...row, status, detail };
}

/** `local 1.4.1 <- incoming 1.1.0` for the human report. Empty when there is nothing to say. */
function versionSuffix(row) {
  const v = row.version;
  if (!v || (!v.local && !v.incoming)) return '';
  if (!v.local) return `  (incoming ${v.incoming})`;
  if (!v.incoming) return `  (local ${v.local})`;
  const arrow = v.comparable && v.cmp < 0 ? '<-' : v.comparable && v.cmp > 0 ? '->' : '==';
  return `  (local ${v.local} ${arrow} incoming ${v.incoming}${v.comparable ? '' : ', direction unknown'})`;
}

export function classifyIncoming(repoRoot, incoming, localByName, ctx = {}) {
  const inState = readIncomingState(incoming, ctx);
  const { files, source } = incomingFileList(incoming, inState);
  // The row is keyed by the name the skill lands under HERE. `upstream` is what the source calls
  // it, which is what a later re-import has to match on and what the profile records — the two
  // differ exactly when --rename resolved a collision.
  const localName = incoming.target || incoming.skill;
  // Carried on EVERY row, including the ones that stop before the local side is read: a report that
  // omits the delta on exactly the rows an operator is about to force is the report they needed.
  const base = {
    skill: localName, upstream: incoming.skill, incoming, files, verified: source === 'bundle',
    file_source: source, requires: inState.requires, base: 'content',
    incoming_modes: inState.modes || {},
    version: versionDelta(localByName.get(localName), incoming),
  };

  // ── The two incoming states that stop before the local side is even looked at ────────────────
  if (inState.trust === 'broken') {
    return settle(base, 'broken',
      inState.mismatches.length && inState.bundle === null && inState.intact === false
        ? `the incoming copy is not self-consistent: ${inState.mismatches.join(', ')}`
        : 'the incoming manifest does not validate, so nothing about this copy can be trusted');
  }
  if (inState.trust === 'undeclared') {
    return settle(base, 'unversioned',
      `the incoming copy carries no manifest but needs one (${
        (inState.because || []).join('; ')}) — its dependency closure is undeclared`);
  }

  const local = localByName.get(localName);
  if (!local) return settle(base, 'new', 'not present locally');

  const localRead = readSkillManifest(repoRoot, local);
  const localBaselined = Boolean(localRead.present && localRead.manifest);
  // What the LOCAL baseline records. Carried on every row so applyOne can prune a file the incoming
  // version dropped — recorded-then-dropped is a deletion; an unrecorded stray is not ours to touch.
  // With no local baseline it stays empty, so nothing is prunable: there is nothing recorded to have
  // been dropped, and treating every untracked file as deletable is the opposite of that rule.
  const local_recorded = localBaselined
    ? [...Object.keys(localRead.manifest.bundle || {}), MANIFEST_NAME].sort()
    : [];
  const row = { ...base, local_recorded };

  // ── Both sides baselined: the original three-way reconcile, unchanged ────────────────────────
  if (inState.trust === 'intact' && localBaselined) {
    row.base = 'bundle';
    const localList = bundleFileList(repoRoot, local);
    const localClean = localList.stale.length === 0;
    const sameBaseline = bundleKey(localRead.manifest.bundle) === bundleKey(inState.bundle);

    if (localClean && sameBaseline) {
      return settle(row, 'up-to-date', 'identical baselines, local is clean');
    }
    if (localClean && !sameBaseline) {
      return settle(row, 'ff',
        'local matches its own baseline and the incoming baseline differs — a clean fast-forward');
    }
    if (!localClean && sameBaseline) {
      return settle(row, 'local-only',
        `local has uncommitted edits the export does not contain (${
          localList.stale.map((s) => `${s.rel} ${s.reason}`).join(', ')})`);
    }
    return settle(row, 'conflict',
      `both sides moved: local is stale against its own baseline (${
        localList.stale.map((s) => s.rel).join(', ')}) and the incoming baseline differs`);
  }

  // ── A receipt from the SAME upstream is a real base, even with no manifest anywhere ──────────
  //
  // Placed AFTER the both-baselined three-way (which uses the blessed `bundle{}` baseline and is
  // strictly stronger) and BEFORE the content fallback (which cannot say who moved). Only rows that
  // would otherwise have fallen through to raw byte comparison change behaviour here.
  const receipt = ctx.receiptFor ? ctx.receiptFor(localName) : null;
  if (receipt && sameUpstream(receipt, incoming, ctx.src, ctx.srcRemote)) {
    const verdict = receiptStatus(receipt, local, incoming);
    if (verdict) {
      if (verdict.status === 'conflict' && weakUpstreamMatch(receipt, ctx.srcRemote)) {
        verdict.detail += '. The receipt matched this source on name, path and layout only — '
          + 'neither side records a git remote — so if these are in fact UNRELATED skills that '
          + `share a name, import it under a different one: --rename ${incoming.skill}=<local-name>`;
      }
      return settle(
        {
          ...row,
          base: 'receipt',
          // What the UPSTREAM actually brought. applyOne narrows its prune to this, so a file the
          // operator added here is never deleted by an update from a source that never carried it.
          receipt_files: Object.keys(receipt.files || {}),
        },
        verdict.status, verdict.detail
      );
    }
  }

  // ── At least one side has no baseline: fall back to comparing CONTENT ────────────────────────
  //
  // Weaker than a three-way compare and openly so — identical bytes mean there is nothing to do,
  // and that is a real answer no matter how it was reached. What content CANNOT say is who moved,
  // which is why every differing case below either resolves to an improvement (`ff`) or stops.
  const sameContent = contentKey(incoming.dir) === contentKey(local.dir);

  if (inState.trust === 'intact' && !localBaselined) {
    if (sameContent) {
      return settle(row, 'ff',
        'the local copy has the same bytes but no manifest — the import adds the baseline');
    }
    return settle(row, 'unversioned',
      'the LOCAL copy carries no manifest, so there is nothing to attribute the difference to');
  }

  // inState.trust === 'walk' — the incoming copy legitimately needs no manifest.
  if (sameContent) {
    return settle(row, 'up-to-date',
      localBaselined
        ? 'byte-identical content; neither side needs a manifest the other has'
        : 'byte-identical content, and neither copy requires a manifest');
  }
  if (localBaselined) {
    const localStale = bundleFileList(repoRoot, local).stale;
    if (!localStale.length) {
      // Local is baselined and clean; the incoming copy has no manifest at all. The difference is
      // work the export predates — `sk-squad` is the live case, having gained skill.yaml,
      // rules/ and a manifest since it was last published. Importing would delete all three.
      return settle(row, 'local-only',
        'local is baselined and clean while the incoming copy carries no manifest — '
        + 'the export predates local work; EXPORT rather than import');
    }
    return settle(row, 'conflict',
      `the incoming copy carries no manifest and local is stale against its own (${
        localStale.map((s) => s.rel).join(', ')})`);
  }
  // Neither side records anything and the bytes differ. Content cannot say who moved, so this is
  // the one place the honest answer is "stop" — an overwrite here destroys local edits that nothing
  // in the repo would show you had existed.
  return settle(row, 'unversioned',
    'neither copy has a baseline and their content differs, so there is nothing to '
    + 'attribute the change to');
}

/**
 * The plan for a whole import.
 *
 * @param {string} repoRoot
 * @param {string} fromRoot
 * @param {string[]|null} names - null means every skill in the incoming tree
 * @returns {{rows: object[], unknown: string[], apply_plan: string[]}}
 */
export function importPlan(repoRoot, fromRoot, names, opts = {}) {
  const incoming = opts.incoming || readIncoming(fromRoot);
  const localByName = new Map(discoverSkills(repoRoot).map((e) => [e.skill, e]));
  // Sibling claims are resolved against every skill either side knows about, so an incoming skill
  // reaching a skill that exists only here is a real edge, not an unknown name.
  const ctx = {
    fromRoot,
    src: opts.src || null,
    srcRemote: opts.srcRemote || '',
    // Memoized: an --all run over a whole skills repository must read each receipt at most once.
    receiptFor: (() => {
      const seen = new Map();
      return (name) => {
        if (!seen.has(name)) seen.set(name, readProfile(repoRoot, name));
        return seen.get(name);
      };
    })(),
    // scanSkill matches names with Array#includes. Keep this as an array: a foreign skill that
    // carries a descriptor takes the manifest-free scan path during adoption, and a Set here
    // previously crashed that otherwise valid import before it could produce a plan.
    universe: [...new Set([...incoming.keys(), ...localByName.keys()])],
  };

  const wanted = names && names.length ? names : [...incoming.keys()].sort();
  const unknown = wanted.filter((n) => !incoming.has(n));
  const rows = wanted
    .filter((n) => incoming.has(n))
    .map((n) => classifyIncoming(repoRoot, incoming.get(n), localByName, ctx))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

  // Everything the verb will NOT do, in the order it has to be done. Derived from what the incoming
  // skills declare, so a hook or a repo-root file cannot be forgotten just because it is invisible
  // inside a folder copy.
  const apply_plan = [];
  const outward = {
    framework_files: new Set(),
    framework_hooks: new Set(),
    config_blocks: new Set(),
    framework_rules: new Set(),
  };
  for (const row of rows) {
    if (row.status === 'up-to-date') continue;
    // Read off the row rather than calling readIncomingState again: that function re-parses the
    // manifest AND re-hashes every file in the skill, so re-calling it here doubled the hashing work
    // for an `--all` run over a whole skills repository.
    const req = row.requires;
    if (!req) continue;
    for (const f of req.framework_files) outward.framework_files.add(f.path);
    for (const h of req.framework_hooks) outward.framework_hooks.add(h.id);
    if (req.config && req.config.block) outward.config_blocks.add(req.config.block);
    for (const r of req.framework_rules || []) outward.framework_rules.add(r.id);
  }
  for (const p of outward.framework_files) {
    apply_plan.push(`review meta/<skill>/framework/${p} and decide whether this repo carries ${p}`);
  }
  for (const id of outward.framework_hooks) {
    apply_plan.push(
      `wire hook ${id} in ALL FOUR CLI configs (.claude/settings.json, .codex/config.toml, `
      + '.gemini/settings.json, .agent/settings.json) — Rule 6, same change'
    );
  }
  // A criterion arrives ENABLED — an unlisted id resolves to the built-in default, and `framework
  // sync` then writes it as `true`. Importing a skill therefore turns its policies on in this repo
  // without anyone deciding to, which is exactly the thing worth naming on a checklist.
  for (const id of outward.framework_rules) {
    apply_plan.push(
      `review '${id}' — it arrived with the skill and resolves ENABLED here; turn it off with `
      + `'sidekicks framework disable ${id}' if this repo does not want it`
    );
  }
  for (const b of outward.config_blocks) {
    apply_plan.push(
      `decide what this scope needs for the '${b}' config block — 'sidekicks config sync' documents `
      + "it inert, so it keeps resolving to the skill's own defaults; "
      + `'sidekicks config set ${b}.<key> <value>' overrides one key and routes any credential to `
      + 'the git-ignored secret file'
    );
  }
  // A CONVERTED skill brings its own questions — attribution, python dependencies, whether it is
  // even yours to republish — and none of them is visible in a manifest, because it has none. The
  // plan is built per row by adopt.mjs, which reads the upstream folder and decides nothing.
  const adoptions = [];
  for (const row of rows) {
    if (row.status === 'up-to-date' || row.incoming.native !== false) continue;
    const a = adoptionPlan(fromRoot, row.incoming);
    adoptions.push(a);
    row.adoption = a;
    // A symlink is no longer a file row in the walk, so a link the plan agreed to MATERIALIZE has
    // to be added back to the copy list by hand — otherwise the folder would silently arrive one
    // file short of what the operator was shown.
    if (a.materialize.length && Array.isArray(row.files)) {
      const have = new Set(row.files);
      for (const m of a.materialize) if (!have.has(m.rel)) row.files.push(m.rel);
      row.files.sort();
    }
    for (const step of a.steps) apply_plan.push(step);
  }

  // Only for a skill that is NOT already grouped here. A checklist step that is already done is
  // how a checklist trains people to skim it.
  const grouped = groupedSkills(repoRoot);
  for (const row of rows) {
    if (row.status === 'up-to-date' || grouped.has(row.skill)) continue;
    apply_plan.push(`place ${row.skill} in an audit group in audit-groups.yaml, or it lands unaudited`);
  }
  // Both halves of config/: the settings files list the incoming criteria, the family files
  // document the incoming blocks. See docs/guide/settings-vs-configuration.md.
  apply_plan.push('sidekicks framework sync');
  apply_plan.push('sidekicks config sync');
  for (const row of rows) {
    if (row.status === 'up-to-date') continue;
    apply_plan.push(`sidekicks skill manifest ${row.skill} --apply`);
  }
  apply_plan.push('sidekicks skill doctor');
  apply_plan.push('sidekicks skill heal --all --apply');

  const warnings = adoptions.flatMap((a) => a.warnings);
  // A REFUSAL is not a loud warning. It names a folder that cannot land intact on a supported
  // platform — a name Windows cannot create, a symlink reaching outside the folder, a source
  // checked out with core.symlinks=false — so the row is marked unapplyable here rather than
  // being caught later by a filesystem that happens to say no, half a folder in.
  const refusals = adoptions.flatMap((a) => a.refusals || []);
  for (const row of rows) {
    if (row.adoption && row.adoption.refusals && row.adoption.refusals.length) {
      row.cross_platform_refusals = row.adoption.refusals;
    }
  }
  return { rows, unknown, apply_plan, adoptions, warnings, refusals };
}

/** Names already placed in an audit group here — read from the auditor's bundled groups file. */
function groupedSkills(repoRoot) {
  const abs = join(
    repoRoot, ...SKILLS_ROOT_SEGMENTS, 'sk-skill-auditor', 'assets', 'audit-groups.yaml'
  );
  const out = new Set();
  if (!existsSync(abs)) return out;
  for (const raw of readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const m = raw.replace(/\s+$/, '').match(/^\s+-\s+(\S+)/);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * Copy one incoming skill in, backing up whatever was there and pruning what the new version
 * dropped.
 *
 * The backup goes under `artifacts/runs/skill-manager/backups/` — git-ignored, recorded
 * repo-relative (`rule.portable-artifact-paths`), and the one thing that makes a wrong import
 * recoverable. It is taken BEFORE any write or delete, unconditionally.
 *
 * THE SKILL LANDS IN THE TREE IT CAME FROM. An incoming copy under `.sidekicks/skill-offloaded/`
 * is a PARKED skill, and writing it into the active tree would un-park it — a decision
 * `sk-skill-offload` owns after a reference scan, not something an import should do as a
 * side effect of a path join.
 *
 * PRUNING IS NARROW, ON PURPOSE. A file the LOCAL baseline recorded and the incoming baseline does
 * not is a file the new version deleted, so leaving it behind produces a skill that is in drift the
 * moment the import finishes (`bundle-stale`, and a later export refuses it). But a file on disk
 * that NEITHER baseline records is a stray nobody has agreed about, and deleting that would be
 * destroying something no declaration covers. So: prune recorded-then-dropped, keep strays.
 *
 * MODE COMES FROM THE MOST AUTHORITATIVE SIGNAL, NOT FROM THIS FILESYSTEM. `execAwareMode()` reads
 * the source `stat`, which is right on POSIX and useless on Windows — NTFS has no execute bit, so
 * every `.sh` and `.py` arriving through a Windows checkout would land 0644 and nothing downstream
 * could tell (the bundle records content hashes only). `resolveSourceMode()` prefers a recorded
 * `modes{}`, then the SOURCE repository's git index, then the stat, then a shebang, so the answer
 * survives a platform that cannot observe it (INC-2026-09-05-02, X-3).
 *
 * STAGE, VALIDATE, SWAP. The copy used to write straight into the destination file by file. Each
 * write was atomic; the FOLDER was not. A name Windows cannot create, or a rename over a file an
 * editor or indexer holds open, stopped the loop half a folder in — and on a FRESH adopt there is
 * no backup to go back to, because there was nothing there to back up. So the incoming files are
 * copied into a staging folder first (where an illegal name fails outside `.agents/skills/`), and
 * only then moved into place, journaling every write and every prune so any failure can be undone:
 * files this run created are removed, pruned files come back from the backup, and a fresh adopt's
 * destination folder is removed entirely (X-4).
 */
function applyOne(repoRoot, row, stamp) {
  // The destination tree. For a native row this is the tree the copy came FROM; a foreign row has
  // no tree of its own and the adapter has already resolved one.
  const localDir = join(repoRoot, ...row.incoming.tree.split('/'), row.skill);
  const backed = existsSync(localDir)
    ? backupSkillDir(repoRoot, localDir, stamp, row.skill)
    : null;

  // Never null: a row with no incoming bundle carries the walk of its folder instead. It used to be
  // null, and `--force --apply` on any manifest-free skill died here with a TypeError — after the
  // backup, so the operator lost the report as well.
  const files = row.files || [];
  const fresh = backed === null;

  // The executability answers, resolved ONCE per skill rather than per file: the git query is a
  // single spawn for the whole folder, and the recorded modes come off the incoming manifest.
  const recorded = (row.incoming_modes && typeof row.incoming_modes === 'object')
    ? row.incoming_modes
    : {};
  const gitExec = gitExecPaths(row.incoming.dir);

  // A link whose target sits inside the skill folder is copied as the target's BYTES at the link's
  // own path — adopt.mjs decided that and refused every other shape. Keyed by rel so the copy loop
  // below reads one map, whether the path came from the walk or from a materialised link.
  const materialize = new Map(
    ((row.adoption && row.adoption.materialize) || []).map((m) => [m.rel, m.from])
  );

  // ── Stage ────────────────────────────────────────────────────────────────────────────────────
  // Everything lands here first. This is where an unwritable name fails, outside the skills tree.
  const stageDir = join(
    repoRoot, 'artifacts', 'runs', 'skill-manager', 'staging', stamp, row.skill
  );
  const staged = [];
  try {
    for (const rel of files) {
      const src = materialize.get(rel) || join(row.incoming.dir, ...rel.split('/'));
      if (!existsSync(src)) continue;
      const mode = resolveSourceMode(src, { rel, recorded, gitExec });
      writeAtomic(join(stageDir, ...rel.split('/')), readFileSync(src), { mode });
      staged.push({ rel, mode });
    }
  } catch (err) {
    rmrf(stageDir);
    throw err;                          // nothing in the skills tree was touched yet
  }

  // ── Swap ─────────────────────────────────────────────────────────────────────────────────────
  // Per file rather than one folder rename, because this verb deliberately PRESERVES STRAYS (see
  // the pruning note above) and a wholesale directory swap would delete every one of them.
  const wrote = [];
  const pruned = [];
  try {
    for (const { rel, mode } of staged) {
      const dest = join(localDir, ...rel.split('/'));
      // Rule 1: everything under .sidekicks/ is written through the CLI, and through the guard.
      assertWritable(dest, repoRoot);
      const existed = existsSync(dest);
      writeAtomic(dest, readFileSync(join(stageDir, ...rel.split('/'))), { mode });
      wrote.push({ rel, dest, existed });
    }

    const incomingSet = new Set(files);
    // What THIS upstream actually brought, when a receipt says. On a receipt-lane row
    // `local_recorded` is the LOCAL manifest's bundle{}, which — for a skill that followed the
    // import's own printed plan and ran `skill manifest --apply` — covers every local file,
    // including ones this upstream never carried. Pruning against that would have made the first
    // same-upstream re-import delete hand-added local files. Narrowing to the receipt is strictly
    // less deletion than before, never more.
    const broughtByUpstream = row.receipt_files ? new Set(row.receipt_files) : null;
    for (const rel of row.local_recorded || []) {
      if (incomingSet.has(rel)) continue;
      if (broughtByUpstream && !broughtByUpstream.has(rel)) continue;
      // A WALK-SOURCED import has no manifest to offer, which is not the same as having deleted
      // one. Pruning it would destroy the hand-authored `why` / `degraded` / `optional` prose that
      // `skill manifest --apply` is explicitly built never to re-decide. It reads stale for exactly
      // one command, and that command is already on the apply plan.
      if (rel === MANIFEST_NAME && row.file_source === 'walk') continue;
      const abs = join(localDir, ...rel.split('/'));
      if (!existsSync(abs)) continue;
      assertWritable(abs, repoRoot);
      rmSync(abs, { force: true });
      pruned.push(rel);
    }
  } catch (err) {
    rollback(repoRoot, localDir, { fresh, wrote, pruned, backed });
    rmrf(stageDir);
    throw err;
  }

  rmrf(stageDir);
  return { skill: row.skill, backup: backed, files: wrote.length, pruned };
}

/**
 * Undo a half-applied swap.
 *
 * Best-effort by construction: this runs while an exception is already in flight, and a second
 * failure here must not replace the operator's real error with a rollback error. What it cannot
 * restore it leaves alone — the backup path is still in the report, and a fresh adopt has nothing
 * worth keeping in the first place.
 *
 * @param {string} repoRoot
 * @param {string} localDir
 * @param {{fresh: boolean, wrote: Array<{rel: string, dest: string, existed: boolean}>, pruned: string[], backed: string|null}} state
 */
function rollback(repoRoot, localDir, state) {
  // A fresh adopt: the whole folder is this run's doing, so removing it restores the world exactly.
  if (state.fresh) {
    try { rmrf(localDir); } catch { /* the operator's error is the one that matters */ }
    return;
  }
  const backupAbs = state.backed ? join(repoRoot, ...state.backed.split('/')) : null;
  // Files this run CREATED go away; files it overwrote, and files it pruned, come back from the
  // backup — which was taken before anything was written, so it is a complete prior state.
  for (const w of state.wrote) {
    if (w.existed) continue;
    try { rmSync(w.dest, { force: true }); } catch { /* leave it */ }
  }
  if (!backupAbs || !existsSync(backupAbs)) return;
  const restore = [
    ...state.wrote.filter((w) => w.existed).map((w) => w.rel),
    ...state.pruned,
  ];
  for (const rel of restore) {
    const from = join(backupAbs, ...rel.split('/'));
    if (!existsSync(from)) continue;
    try {
      writeAtomic(join(localDir, ...rel.split('/')), readFileSync(from), {
        mode: execAwareMode(from),
      });
    } catch { /* leave it; the backup path is reported either way */ }
  }
}

/** Every framework rule/criterion id this repo's registry currently knows about. */
function frameworkIds(repoRoot) {
  try {
    const reg = buildRegistry(repoRoot);
    return new Set((reg.entries || []).map((e) => e.id));
  } catch {
    // A registry that will not build is a pre-existing problem for `framework doctor`, not a reason
    // to fail an import. An empty set just means the profile records no enabled ids.
    return new Set();
  }
}

/**
 * The facts a registration profile records for one applied row.
 *
 * Split deliberately: `source`/`upstream`/`adapter`/`enabled_here`/`licence` are what nothing on
 * disk can reconstruct afterwards; `mirror` is recomputed and only kept for legibility; `files` is
 * the as-installed baseline that lets a later removal tell a file this import brought from one
 * added since.
 */
function profileFacts(repoRoot, row, o) {
  const entry = discoverSkills(repoRoot).find((e) => e.skill === row.skill);
  const a = row.adoption || { facts: {}, carries: [] };
  const git = sourceGit(o.fromRoot);
  const req = row.requires || {};

  // APPEND, NEVER REPLACE. `recordProfile` is documented "write (or replace)", and this function
  // took the second reading: it built a fresh profile every run, so a re-import reset `history` to
  // one line and discarded the provenance of the first import — the `plain` / `flat` /
  // `converted: true` facts that nothing on disk can reconstruct. `offload` took the first reading
  // and appended. One store, two conventions, and the one that replaced was the one carrying the
  // facts the receipt exists for.
  const prior = readProfile(repoRoot, row.skill);
  const same = Boolean(prior) && sameUpstream(prior, row.incoming, o.src, o.srcRemote || '');
  const keep = (block, key, fallback) => (
    same && prior[block] && String(prior[block][key] || '') ? prior[block][key] : fallback
  );
  // A genuinely DIFFERENT source overwriting the same local name (reachable only with --rename plus
  // --force) is recorded as its own history entry rather than a second timeline: history already
  // carries {at, action, detail} and is already appended to by offload, and a `source_history[]`
  // would mean a new render block, a new RECORDED_KEYS member and a PROFILE_SCHEMA bump — which
  // would invalidate every existing receipt with no migration verb.
  const history = [];
  if (prior && !same) {
    history.push({
      at: o.at,
      action: 'source-change',
      detail: `was ${(prior.source || {}).kind || 'unknown'}/${
        (prior.adapter || {}).layout || 'unknown'} at ${(prior.upstream || {}).path || 'unknown'}`,
    });
  }
  const detail = row.version && row.version.comparable && row.version.local
    ? `${row.status} (${row.version.local} -> ${row.version.incoming})`
    : row.status;
  history.push({ at: o.at, action: 'import', detail });

  return {
    skill: row.skill,
    status: 'installed',
    provenance: 'imported',
    source: {
      kind: o.src.native ? 'sidekicks' : o.src.source_kind,
      destination: keep('source', 'destination', destinationNameFor(repoRoot, o.fromRoot)),
      remote: keep('source', 'remote', git.remote),
      // Commit and branch are REFRESHED even on a match: a re-import genuinely came from a new
      // commit, and that is the fact an operator asks the receipt for.
      commit: git.commit,
      branch: git.branch,
    },
    upstream: {
      name: row.upstream,
      path: row.incoming.upstreamRel,
      // A native import never runs adoptionPlan (importPlan skips it for native and up-to-date
      // rows), so this was empty on every native receipt — visible in all four committed here. The
      // reconcile now reads the incoming version anyway, so use it rather than record a blank.
      version: a.facts.upstream_version
        || (row.version && row.version.incoming)
        || keep('upstream', 'version', ''),
      description: a.facts.upstream_description || keep('upstream', 'description', ''),
    },
    adapter: {
      layout: row.incoming.layout,
      converted: row.incoming.native === false,
      category: row.incoming.category || '',
      // Import synthesizes nothing. The field exists because a later `skill manifest --apply` may,
      // and a removal has to know whether a manifest came from upstream or from this framework.
      synthesized: keep('adapter', 'synthesized', ''),
    },
    enabled_here: {
      // Union with what an earlier import turned on: an id enabled by the first run is still
      // enabled BECAUSE of this skill, and a removal has to unwind it.
      framework_rules: unionCsv(
        same && prior.enabled_here ? prior.enabled_here.framework_rules : '', (o.enabled || []).join(', ')
      ),
      config_blocks: req.config && req.config.block ? req.config.block : '',
      hooks_requested: (req.framework_hooks || []).map((h) => h.id).join(', '),
      repo_root_files: (req.framework_files || []).map((f) => f.path).join(', '),
      audit_group: groupOfSkill(repoRoot, row.skill),
    },
    licence: {
      declared: a.facts.license || '',
      carried: (a.carries || []).join(', '),
      not_carried: (a.steps || []).some((s) => s.includes('did NOT travel'))
        ? 'a licence at the source ROOT did not travel — see the import report'
        : '',
    },
    // WHEN THIS REPO TOOK THE SKILL IN — kept across a re-import from the same upstream. The field
    // names the adoption, not the arrival of the current bytes; every subsequent arrival is in
    // `history`, which is the timeline.
    imported_at: same ? (prior.imported_at || o.at) : o.at,
    imported_by: { tool: 'sidekicks skill import', cli_version: cliVersion() },
    mirror: entry ? mirrorFacts(repoRoot, entry) : null,
    files_recorded_at: 'import',
    // WHAT THIS IMPORT BROUGHT — not a hash of the local folder afterwards. For a first import into
    // an empty directory those are the same set, which is why the difference went unnoticed; on a
    // RE-import over a folder that has since gained local files they are not, and recording the
    // whole folder claimed those local files as imported. That breaks the field's own contract
    // ("so a removal can tell a file it brought from one added afterwards") and, worse, makes the
    // next reconcile read them as files the upstream deleted.
    files: entry ? broughtHashes(entry, row.files) : {},
    history: prior ? appendHistoryAll(prior, history) : history,
  };
}

/** Union of two comma-separated id lists, order-stable, code-point sorted for a stable file. */
function unionCsv(a, b) {
  const out = new Set();
  for (const csv of [a, b]) {
    for (const part of String(csv || '').split(',')) {
      const t = part.trim();
      if (t) out.add(t);
    }
  }
  return [...out].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).join(', ');
}

/** appendHistory, for more than one entry. */
function appendHistoryAll(prior, entries) {
  let history = prior.history || [];
  for (const e of entries) history = appendHistory({ history }, e);
  return history;
}

/**
 * The as-installed hashes of the files this import actually wrote.
 *
 * @param {{dir: string}} entry - the local entry, after the copy
 * @param {string[]} brought - the incoming file list for this row
 * @returns {Record<string, string>}
 */
function broughtHashes(entry, brought) {
  const want = new Set(brought || []);
  const out = {};
  for (const [rel, hash] of Object.entries(fileHashes(entry))) {
    if (want.has(rel)) out[rel] = hash;
  }
  return out;
}

/**
 * Where the source tree came from, as git sees it.
 *
 * Best effort by design: a source may be a plain folder, an unpushed clone, or a marketplace
 * checkout with no remote. An unknown commit is recorded as empty and the receipt stays honest —
 * it is never a reason to fail an import that has already copied the files.
 */
function sourceGit(fromRoot) {
  const safe = (fn) => { try { return fn() || ''; } catch { return ''; } };
  if (!safe(() => isRepo(fromRoot))) return { remote: '', commit: '', branch: '' };
  return {
    remote: safe(() => remoteUrl(fromRoot)),
    commit: safe(() => headCommit(fromRoot)),
    branch: safe(() => currentBranch(fromRoot)),
  };
}

/** The configured destination NAME a path corresponds to, or '' — never the checkout path itself. */
function destinationNameFor(repoRoot, fromRoot) {
  try {
    for (const d of configuredDestinations(repoRoot)) {
      if (d.dir && resolve(d.dir) === resolve(fromRoot)) return d.name;
    }
  } catch { /* an unreadable config is not an import failure */ }
  return '';
}

/** Which audit group a skill sits in here, or ''. */
function groupOfSkill(repoRoot, name) {
  const abs = join(
    repoRoot, ...SKILLS_ROOT_SEGMENTS, 'sk-skill-auditor', 'assets', 'audit-groups.yaml'
  );
  if (!existsSync(abs)) return '';
  let group = '';
  for (const raw of readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const g = raw.match(/^\s{2}([A-Za-z0-9_-]+):\s*$/);
    if (g) { group = g[1]; continue; }
    const m = raw.replace(/\s+$/, '').match(/^\s+-\s+(\S+)/);
    if (m && m[1] === name && group !== 'single') return group;
  }
  return '';
}

/**
 * The version of the CLI DOING the import — resolved from this module, not from the target repo.
 *
 * The target of an import is frequently not a sidekicks checkout at all (that is rather the point),
 * so reading its package.json records an empty version for every real adoption.
 */
function cliVersion() {
  try {
    const pkg = fileURLToPath(new URL('../../package.json', import.meta.url));
    return String(JSON.parse(readFileSync(pkg, 'utf8')).version || '');
  } catch { return ''; }
}

/** `--rename upstream=local`, repeatable, parsed into a Map. */
function parseRenames(raw) {
  const out = new Map();
  for (const spec of raw) {
    const eq = spec.indexOf('=');
    if (eq < 1 || eq === spec.length - 1) {
      throw new SidekicksError(
        `skill import: --rename takes <upstream>=<local>, not '${spec}'`, EXIT_USAGE
      );
    }
    out.set(spec.slice(0, eq), spec.slice(eq + 1));
  }
  return out;
}

/**
 * Re-key the incoming map by the name each skill will land under here.
 *
 * The entry keeps `skill` as the UPSTREAM name — that is what the source calls it and what a later
 * re-import has to match on — and gains `target`, the local folder. Renaming is only offered for a
 * foreign source: a native one shares this framework's namespace already, and renaming there would
 * fork a skill from its own history.
 */
function applyRenames(entries, renames, into, native) {
  if (!renames.size) return entries;
  if (native) {
    throw new SidekicksError(
      'skill import: --rename is for adopting a foreign skill. A skill from a sidekicks skills '
      + 'repository already shares this namespace, and renaming it would fork it from its own '
      + 'history and its published copy.',
      EXIT_USAGE
    );
  }
  const out = new Map();
  // `--into` speaks basenames (`skills` | `skill-offloaded`); the two trees no longer share a
  // parent, so resolve rather than re-join onto a fixed prefix. readSource did the same already —
  // this only has to agree with it, or a rename would land the copy in a different tree.
  const tree = SKILL_TREE_BY_BASENAME[into] || SKILLS_ROOT_REL;
  for (const [name, entry] of entries) {
    const target = renames.get(name) || name;
    out.set(target, { ...entry, target, tree, relDir: `${tree}/${target}` });
  }
  for (const upstream of renames.keys()) {
    if (!entries.has(upstream)) {
      throw new SidekicksError(
        `skill import: --rename names '${upstream}', which is not in this source`, EXIT_VALIDATION
      );
    }
  }
  return out;
}

/**
 * Refuse a `--from` this verb cannot read, BEFORE anything tries to walk it.
 *
 * `resolve()` turns a URL into a path — `https://github.com/x/y` becomes `<repo>/https:/github.com/x/y`
 * — so without this the first `readdirSync` deeper in throws a raw Node ENOENT with a stack trace
 * instead of a refusal. The URL case gets its own sentence because it is a different mistake: this
 * verb has no network path at all, so the answer is "clone it first", not "check the spelling".
 *
 * @param {string} raw - what the operator typed, for the message
 * @param {string} fromRoot - the resolved absolute path
 */
/**
 * An MSYS-style path (`/c/Users/...`) as Windows spells it (`C:\\Users\\...`).
 *
 * Git-Bash normally converts these itself before the argument ever reaches node — but only for
 * arguments it recognises as paths, and `MSYS_NO_PATHCONV=1` turns the whole mechanism off. When
 * the conversion does not happen, `resolve('/c/Users/...')` on Windows produces a path rooted at
 * the current drive that cannot exist, and the operator gets "does not exist" for a path they can
 * `ls` in the very shell they typed it in (INC-2026-09-05-02, X-10).
 *
 * Only on win32, and only for a single-letter first segment: `/c/...` is a drive there and nothing
 * else, while on POSIX it is an ordinary directory that must be left alone.
 *
 * @param {string} raw
 * @param {string} [platform]
 * @returns {string}
 */
export function normalizeMsysPath(raw, platform = process.platform) {
  if (platform !== 'win32') return raw;
  const m = /^\/([A-Za-z])(\/|$)/.exec(raw);
  if (!m) return raw;
  return `${m[1].toUpperCase()}:\\${raw.slice(3)}`;
}

function assertSourceReadable(raw, fromRoot) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^[^/\\]+@[^/\\]+:/.test(raw)) {
    throw new SidekicksError(
      `skill import: --from takes a path, not a URL ('${raw}'). This verb never reaches the network `
      + '— clone the repository first, then point --from at the clone.',
      EXIT_VALIDATION
    );
  }
  let stat;
  try { stat = statSync(fromRoot); } catch {
    throw new SidekicksError(
      `skill import: --from '${raw}' does not exist (resolved to '${fromRoot}')`,
      EXIT_NOT_FOUND
    );
  }
  if (!stat.isDirectory()) {
    throw new SidekicksError(
      `skill import: --from '${raw}' is not a directory (resolved to '${fromRoot}')`,
      EXIT_VALIDATION
    );
  }
}

/** The refusal for a `--from` that holds no skills, saying what was actually found. */
function notASkillsTree(fromRoot, src) {
  const lines = [`skill import: found no skills under '${fromRoot}'.`];
  if (src.detection.ambiguous.length) {
    return new SidekicksError(
      `skill import: '${fromRoot}' matches more than one layout — ${src.detection.evidence}. `
      + `Pick one explicitly with --layout <${LAYOUTS.join('|')}>.`,
      EXIT_VALIDATION
    );
  }
  if (src.source_kind === 'plugin-marketplace') {
    const plugins = marketplacePlugins(fromRoot);
    lines.push(
      'It looks like a CLI plugin marketplace (.claude-plugin/). A plugin bundles commands, agents,'
      + ' hooks and skills, and this verb has standing over the skills only.'
    );
    if (plugins.length) {
      lines.push(`Point --from at one of its skills trees instead: ${plugins.join(', ')}`);
    }
  } else {
    // Defensive despite assertSourceReadable: this builds an ERROR message, and a message builder
    // that can throw replaces a clear refusal with a stack trace.
    let entries = [];
    try { entries = readdirSync(fromRoot, { withFileTypes: true }); } catch { entries = []; }
    const top = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name).slice(0, 12);
    lines.push(
      `Looked for: .agents/skills/<name>/, .sidekicks/skill-offloaded/<name>/, .claude/skills/<name>/, `
      + 'skills/<name>/, skills/<category>/<name>/, <name>/ — each with a SKILL.md inside.'
    );
    if (top.length) lines.push(`Top-level directories here: ${top.join(', ')}`);
  }
  return new SidekicksError(lines.join('\n  '), EXIT_VALIDATION);
}

/** `--list`: what a source holds, without reconciling or writing anything. */
function listSource(fromRoot, src, flags) {
  const rows = [...src.entries.values()].map((e) => ({
    skill: e.skill, layout: e.layout, category: e.category, path: e.upstreamRel,
  }));
  if (flags.json) {
    return {
      stdout: JSON.stringify({
        ok: true, from: fromRoot, layout: src.layout, native: src.native,
        source_kind: src.source_kind, skills: rows, rejected: src.rejected,
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  const out = [
    `skill import --list: ${src.detection.evidence || `${rows.length} skill(s)`} in ${fromRoot}`,
    `  layout: ${src.layout}${src.native ? ' (native — no conversion)' : '  source: ' + src.source_kind}`,
    '',
  ];
  for (const r of rows) out.push(`  ${r.skill}${r.category ? `  [${r.category}]` : ''}  ${r.path}`);
  if (src.rejected.length) {
    out.push('', 'SKIPPED — found but not usable as a skill directory:');
    for (const r of src.rejected) out.push(`  ${r.path}: ${r.reason}`);
  }
  if (!src.native) {
    out.push('', "Nothing is imported by --list. Adopt with '--adopt <skill>… --apply'.");
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}

/**
 * Run `skill import`.
 *
 * @param {{repoRoot: string, argv: string[]}} ctx
 */
export async function run(ctx) {
  const flags = parseSkillFlags(
    ctx.argv, ['apply', 'force', 'json', 'all', 'dry-run', 'adopt', 'list']
  );
  // EVERY value flag has to be listed here too. The dispatcher's parseArgs runs strict:false with
  // no option config, so an omitted one turns `--layout flat` into a positional and the verb
  // reports "not present in <path>: flat".
  const names = positionalArgs(ctx.argv, ['from', 'layout', 'into', 'rename']);
  const renames = parseRenames(collectRepeated(ctx.argv, 'rename'));

  if (typeof flags.from !== 'string' || !flags.from) {
    throw new SidekicksError(
      'skill import: --from <path> is required — the tree to import from (a skills repository, or '
      + 'any repository holding skills)',
      EXIT_USAGE
    );
  }
  // MSYS first, so a Git-Bash `/c/…` that escaped the shell's own conversion resolves rather than
  // becoming a nonexistent path rooted at the current drive.
  const fromRoot = resolve(normalizeMsysPath(String(flags.from)));
  assertSourceReadable(String(flags.from), fromRoot);
  if (flags.layout && !LAYOUTS.includes(String(flags.layout)) && flags.layout !== 'auto'
      && flags.layout !== 'flat+nested') {
    throw new SidekicksError(
      `skill import: unknown --layout '${flags.layout}' — one of ${LAYOUTS.join(', ')}, or auto`,
      EXIT_USAGE
    );
  }
  const into = flags.into ? String(flags.into) : 'skills';
  if (!['skills', 'skill-offloaded'].includes(into)) {
    throw new SidekicksError(
      `skill import: --into takes 'skills' or 'skill-offloaded', not '${into}'`, EXIT_USAGE
    );
  }

  const src = readSource(fromRoot, { layout: flags.layout ? String(flags.layout) : null, into });
  if (!src.layout) throw notASkillsTree(fromRoot, src);

  // --list comes BEFORE the adopt gate on purpose: it writes nothing, and the gate's own advice is
  // to look at the source first. A refusal that forbids the inspection it recommends is a loop.
  if (flags.list) return listSource(fromRoot, src, flags);

  // ADOPTING IS AN EXPLICIT ACT. Auto-detection is what makes a foreign repo reachable at all, and
  // an explicit gate is what keeps a mistyped --from from converting some unrelated checkout.
  if (!src.native && !flags.adopt) {
    throw new SidekicksError(
      `skill import: '${fromRoot}' is in the '${src.layout}' layout, not a sidekicks skills `
      + `repository (${src.detection.evidence}). Importing from it CONVERTS third-party skills into `
      + "this repo, so it needs --adopt. Run the same command with '--list' to see exactly what "
      + 'would come across.',
      EXIT_VALIDATION
    );
  }

  if (!names.length && !flags.all) {
    throw new SidekicksError(
      'skill import: name at least one skill or pass --all (add --list to see what is there)',
      EXIT_USAGE
    );
  }

  const incoming = applyRenames(src.entries, renames, into, src.native);
  // One git read for the whole run — the receipt match and the receipt write both want it, and
  // sourceGit is the verb's only subprocess.
  const srcRemote = sourceGit(fromRoot).remote;
  // A name on the command line is whatever the operator saw in `--list`, i.e. the UPSTREAM name.
  // The map is keyed by the local name a rename resolved to, so translate before looking anything
  // up — otherwise `--rename x=y x` reports that x is not in the source it just came from.
  const targets = names.map((n) => renames.get(n) || n);

  // A foreign skill arriving under a name this repo already uses is a collision, not a reconcile:
  // the two folders have no shared history, so "fast-forward" would mean overwriting an unrelated
  // skill. A NATIVE source is the opposite case — the same name IS the same skill.
  //
  // UNLESS the receipt says otherwise. The first import recorded `upstream.name`, `upstream.path`,
  // `adapter.layout` and `source.kind`; when all of them still match, the local copy came from THIS
  // upstream and the same name IS the same skill. Without this the gate ran before the reconcile
  // and never read the receipt, so an adopted skill could be imported exactly once and never
  // updated — `--force`, `--rename x=x` and `--all` all hit the same refusal. That contradicted
  // docs/guide/skill-import-adapters.md §5, which promises byte-exactness is "what lets a later
  // re-import from the same upstream reconcile as up-to-date".
  if (!src.native) {
    const local = new Set(discoverSkills(ctx.repoRoot).map((e) => e.skill));
    const wanted = targets.length ? targets : [...incoming.keys()];
    const clash = wanted.filter((n) => {
      if (!incoming.has(n) || !local.has(n)) return false;
      return !sameUpstream(readProfile(ctx.repoRoot, n), incoming.get(n), src, srcRemote);
    });
    if (clash.length) {
      throw new SidekicksError(
        `skill import: ${clash.length} incoming skill(s) already exist here: ${clash.join(', ')}. `
        + 'They are unrelated folders that happen to share a name, so nothing is overwritten. Give '
        + `each one a local name: ${clash.map((n) => `--rename ${
          incoming.get(n).skill}=<local-name>`).join(' ')}`,
        EXIT_VALIDATION
      );
    }
  }

  const plan = importPlan(ctx.repoRoot, fromRoot, flags.all ? null : targets, {
    incoming, src, srcRemote,
  });
  if (plan.unknown.length) {
    throw new SidekicksError(
      `skill import: not present in ${fromRoot}: ${plan.unknown.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const unforceable = plan.rows.filter((r) => NEVER_APPLY.has(r.status));
  // A cross-platform refusal is NOT forceable. `--force` means "I accept losing the local side",
  // which is a judgement about THIS repo's copy; it says nothing about a folder that cannot be
  // created on Windows at all, and there is no version of "yes, write a file named aux.md" that
  // ends well for the teammate who pulls it. The fix is upstream, so the row stops here.
  const refused = plan.rows.filter((r) => (r.cross_platform_refusals || []).length > 0);
  const refusedNames = new Set(refused.map((r) => r.skill));
  const blocked = plan.rows.filter(
    (r) => NEVER_APPLY.has(r.status)
      || refusedNames.has(r.skill)
      || (NEEDS_FORCE.has(r.status) && !flags.force)
  );
  const actionable = plan.rows.filter(
    (r) => !NEVER_APPLY.has(r.status)
      && !refusedNames.has(r.skill)
      && (r.status === 'new' || r.status === 'ff' || (NEEDS_FORCE.has(r.status) && flags.force))
  );

  let applied = [];
  const receipts = [];
  if (flags.apply && !blocked.length && actionable.length) {
    const at = nowBangkok();
    const stamp = at.replace(/[:+]/g, '-');
    // What this repo's framework registry lists BEFORE the copy. The diff after is the only way to
    // know which of an incoming skill's declared ids this import actually turned on here — after
    // the fact, rules.yaml cannot tell an id the import enabled from one that was already listed.
    const before = frameworkIds(ctx.repoRoot);
    applied = actionable.map((r) => applyOne(ctx.repoRoot, r, stamp));
    const after = frameworkIds(ctx.repoRoot);
    const enabled = [...after].filter((id) => !before.has(id));

    for (const r of actionable) {
      // A receipt is bookkeeping; the skill is the deliverable. A profile that cannot be written
      // must never undo a copy that succeeded — it degrades to a warning that
      // `skill registry --backfill` can settle later.
      try {
        receipts.push(recordProfile(ctx.repoRoot, profileFacts(ctx.repoRoot, r, {
          src, srcRemote, fromRoot, at, enabled, applied: applied.find((a) => a.skill === r.skill),
        })));
      } catch (err) {
        plan.warnings.push(
          `${r.skill}: imported, but its registration profile was not recorded (${err.message}). `
          + `Run 'sidekicks skill registry --backfill --assume-imported ${r.skill} --apply'.`
        );
      }
    }
  }

  const exitCode = blocked.length ? EXIT_VALIDATION : EXIT_OK;

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        ok: exitCode === EXIT_OK,
        from: fromRoot,
        applied: Boolean(flags.apply),
        rows: plan.rows.map((r) => ({
          skill: r.skill, status: r.status, detail: r.detail, files: r.files ? r.files.length : 0,
          // Whether that file list came from a recorded baseline or from walking the folder. A
          // walk-sourced copy was never checked against anything, and a report that hid the
          // difference would let an unverified import read as a verified one.
          verified: Boolean(r.verified),
          // Which of the three baselines decided this row: the local bundle{}, the import receipt,
          // or nothing but raw bytes.
          base: r.base || 'content',
          // The direction the reconcile could NOT see before `behind` existed.
          version: r.version || { local: '', incoming: '', cmp: null, comparable: false, from: '' },
        })),
        layout: src.layout,
        adopted: !src.native,
        blocked: blocked.map((r) => r.skill),
        unforceable: unforceable.map((r) => r.skill),
        // Refused for a reason --force does not reach: the folder cannot land intact on a
        // supported platform. Reported separately from `blocked` so a caller can tell "you may
        // override this" from "the fix is upstream".
        refused: refused.map((r) => r.skill),
        cross_platform_refusals: plan.refusals || [],
        warnings: plan.warnings || [],
        wrote: applied,
        apply_plan: plan.apply_plan,
      }, null, 2) + '\n',
      exitCode,
    };
  }

  const out = [];
  out.push(flags.apply && applied.length
    ? `skill import: applied ${applied.length} skill(s) from ${fromRoot}`
    : `skill import: ${plan.rows.length} skill(s) in ${fromRoot} (nothing written)`);
  // Name the detection in the first lines. Auto-detection is only safe if the operator can see
  // which shape it decided on before deciding whether to trust the rest of the report.
  out.push(`  layout: ${src.layout}${src.native
    ? ' (native sidekicks skills repository — no conversion)'
    : `  ADOPTING third-party skills (source: ${src.source_kind})`}`);
  if (src.rejected.length) {
    out.push(`  skipped ${src.rejected.length} director${src.rejected.length === 1 ? 'y' : 'ies'} `
      + 'that could not be a skill — add --list to see them');
  }
  out.push('');
  for (const r of plan.rows) {
    out.push(`  [${r.status}] ${r.skill}`
      + `${r.verified ? '' : '  (unverified — no recorded baseline)'}${versionSuffix(r)}`);
    out.push(`      ${r.detail}`);
  }
  if (applied.length) {
    out.push('', 'Written:');
    for (const a of applied) {
      out.push(`  + ${a.skill} (${a.files} files)${a.backup ? `, previous copy backed up to ${a.backup}` : ''}`);
      // A delete is never silent, even though the backup makes it recoverable.
      if (a.pruned && a.pruned.length) {
        out.push(`      removed ${a.pruned.length} file(s) the new version dropped: ${a.pruned.join(', ')}`);
      }
    }
  }
  if (blocked.length) {
    out.push('', `REFUSED — ${blocked.length} skill(s) need a decision, not an overwrite:`);
    // The delta rides along on every refused row. An operator about to reach for --force on twenty
    // `behind` rows needs the numbers here, not twenty status words.
    for (const r of blocked) out.push(`  ${r.skill}: ${r.status}${versionSuffix(r)}`);
    if (blocked.length > unforceable.length) {
      out.push('  Resolve the difference, or pass --force to overwrite (a backup is taken either way).');
    }
    if (unforceable.length) {
      out.push(
        `  ${unforceable.map((r) => r.skill).join(', ')}: --force does NOT open this one. The `
        + 'incoming copy contradicts its own manifest, so forcing it in writes files whose hashes '
        + 'will not match the manifest landing beside them — `skill doctor` reports bundle-stale '
        + 'immediately and the next export refuses. Re-export it at the source instead.'
      );
    }
  } else if (!flags.apply && actionable.length) {
    // Echo back every flag the run actually needs — a suggested command that drops --adopt or
    // --rename is a command that refuses when the operator pastes it.
    const echo = [
      flags.all ? '--all' : names.join(' '),
      `--from ${flags.from}`,
      src.native ? '' : '--adopt',
      flags.layout ? `--layout ${flags.layout}` : '',
      flags.into ? `--into ${flags.into}` : '',
      ...[...renames].map(([u, l]) => `--rename ${u}=${l}`),
      '--apply',
    ].filter(Boolean);
    out.push('', `  apply with 'sidekicks skill import ${echo.join(' ')}'`);
  }
  if (plan.refusals && plan.refusals.length) {
    out.push(
      '',
      'REFUSED — these cannot land intact on every supported platform, and --force does not open',
      'them. The fix is at the source:'
    );
    for (const r of plan.refusals) out.push(`  x ${r}`);
  }
  if (plan.warnings && plan.warnings.length) {
    out.push('', 'WARNINGS — read before applying; none of these is corrected for you:');
    for (const w of plan.warnings) out.push(`  ! ${w}`);
  }
  out.push('', 'Then, in this order — none of it is done by this verb:');
  for (const step of plan.apply_plan) out.push(`  - ${step}`);

  if (blocked.length) throw new SidekicksError(out.join('\n'), EXIT_VALIDATION);
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
