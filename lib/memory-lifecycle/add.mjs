// lib/memory-lifecycle/add.mjs
// `sidekicks memory add <name> [flags]` — register a local-memory entry.
//
// Resolves the active namespace inside the CENTRAL store, writes <name>.md atomically
// (refusing to overwrite an existing entry without --force), then regenerates the
// store's three generated faces (MEMORY.md, index.json, graph.json). All printed paths
// are repo-relative.
//
// New in the central store: --category (the action a pack is keyed on), --rule (a hard
// rule whose body always loads when its category fires), --source (a DURABLE lineage
// anchor), --link (typed graph edges), and --snapshot (the answer to a run-folder
// source: copy the decisive content into evidence/ and anchor there instead).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { read } from '../settings-store/settings.mjs';
import { resolveMemoryDir, evidenceDir } from '../active-scope/memory-paths.mjs';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import { LOCKED_IDS } from '../framework-settings/floor.mjs';
import {
  validateSlug,
  parseMemoryFlags,
  buildEntryFile,
  buildDecisionBody,
  bangkokTimestamp,
  requireAgentLayer,
  validateCategory,
  validateSource,
  collectLinkFlags,
  ENTRY_TYPES,
} from './_shared.mjs';
import { syncStoreFaces } from './_store.mjs';

/** An evidence snapshot is an excerpt anchoring a fact, not an archive. */
const EVIDENCE_BUDGET_BYTES = 8 * 1024;

/**
 * Refuse a hard rule whose slug collides with a safety-floor id. A rule entry is DATA:
 * it may add constraints for the agent, never soften the frozen floor. Without this,
 * `memory add protected-branches --rule` would let a data file appear to restate — and
 * therefore appear to relax — a rule the floor exists to make unrelaxable.
 *
 * @param {string} slug
 */
function assertNotFloorId(slug) {
  for (const id of LOCKED_IDS) {
    const bare = id.replace(/^(rule|criterion|hook)\./, '');
    if (slug === id || slug === bare) {
      throw new SidekicksError(
        `memory add: '${slug}' collides with the safety-floor id '${id}' — a rule entry can `
          + `ADD constraints, never restate or soften a floor rule. Choose another slug.`,
        EXIT_VALIDATION
      );
    }
  }
}

/**
 * Copy the decisive content of `--snapshot <path>` into the store's evidence folder and
 * return the durable source anchor pointing at it.
 *
 * This exists because `artifacts/runs/…` is a temporary surface: the knowledge has to
 * outlive the folder it was observed in, so the excerpt is committed INTO the store and
 * the original run path survives as provenance prose rather than as a live pointer.
 *
 * @param {object} p
 * @returns {{ source: string, evidenceRel: string, warning: string|null }}
 */
function writeSnapshot({ repoRoot, namespace, slug, snapshotPath, lines }) {
  const abs = join(repoRoot, snapshotPath);
  if (!existsSync(abs)) {
    throw new SidekicksError(
      `memory add: --snapshot '${snapshotPath}' does not exist (resolved against the repo root)`,
      EXIT_NOT_FOUND
    );
  }
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new SidekicksError(`memory add: cannot read --snapshot '${snapshotPath}' — ${err.message}`, EXIT_VALIDATION);
  }

  let excerpt = text;
  let rangeNote = 'whole file';
  if (lines) {
    const m = /^(\d+)-(\d+)$/.exec(String(lines));
    if (!m) {
      throw new SidekicksError(
        `memory add: --snapshot-lines '${lines}' must be A-B (1-indexed, inclusive)`,
        EXIT_VALIDATION
      );
    }
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (from < 1 || to < from) {
      throw new SidekicksError(`memory add: --snapshot-lines '${lines}' is not a valid range`, EXIT_VALIDATION);
    }
    excerpt = text.replace(/\r\n?/g, '\n').split('\n').slice(from - 1, to).join('\n');
    rangeNote = `lines ${from}-${to}`;
  }

  const name = basename(snapshotPath);
  const dir = evidenceDir(repoRoot, namespace, slug);
  const target = join(dir, name);
  const body = [
    `<!-- Evidence snapshot for memory entry '${slug}' (${namespace}). -->`,
    `<!-- Captured from: ${snapshotPath} (${rangeNote}). -->`,
    `<!-- The source path above may no longer exist: it is recorded as provenance prose, -->`,
    `<!-- not as a live pointer. This copy is the durable anchor. -->`,
    '',
    excerpt.replace(/\s+$/, ''),
    '',
  ].join('\n');

  mkdirp(dir);
  assertWritable(target, repoRoot);
  writeAtomic(target, body);

  const bytes = Buffer.byteLength(body, 'utf8');
  const warning = bytes > EVIDENCE_BUDGET_BYTES
    ? `warning: evidence snapshot is ${bytes} bytes (budget ${EVIDENCE_BUDGET_BYTES}) — `
      + `snapshots anchor a fact, they are not archives; consider --snapshot-lines`
    : null;

  const evidenceRel = `evidence/${namespace}/${slug}/${name}`;
  return { source: evidenceRel, evidenceRel, warning };
}

/**
 * Run `memory add`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = validateSlug(args.name);

  const flags = parseMemoryFlags(ctx.argv, ['force', 'rule']);
  const type = (flags.type && String(flags.type)) || 'decision';

  if (!ENTRY_TYPES.includes(type)) {
    throw new SidekicksError(
      `memory add: invalid --type '${type}' — one of: ${ENTRY_TYPES.join(', ')}`,
      EXIT_VALIDATION
    );
  }

  const description = flags.description != null ? String(flags.description) : '';
  if (description.trim() === '') {
    throw new SidekicksError(
      'memory add: --description is required (one-line summary used in the index)',
      EXIT_VALIDATION
    );
  }

  const isRule = flags.rule === true || type === 'rule';
  if (isRule) assertNotFloorId(name);

  const { category, warning: categoryWarning } = validateCategory(flags.category);
  const links = collectLinkFlags(ctx.argv);

  // Build the body: structured what/why/alt for decisions, else free-form --body.
  let body;
  if (type === 'decision') {
    body = buildDecisionBody({
      what: flags.what != null ? String(flags.what) : '',
      why: flags.why != null ? String(flags.why) : '',
      alt: flags.alt != null ? String(flags.alt) : '',
    });
  } else {
    body = flags.body != null ? String(flags.body) : '';
  }

  // --agent <name> targets a named persistent agent's own namespace instead of the
  // active scope's; the agent must exist.
  const layer = flags.agent
    ? requireAgentLayer(repoRoot, flags.agent)
    : resolveMemoryDir(repoRoot, read(repoRoot));
  const { baseDir, namespace, baseDirRel } = layer;
  const entryPath = join(baseDir, `${name}.md`);
  const entryPathRel = `${baseDirRel}/${name}.md`;

  // Refuse to overwrite unless --force.
  const exists = existsSync(entryPath);
  if (exists && !flags.force) {
    throw new SidekicksError(
      `memory add: entry '${name}' already exists at ${entryPathRel} — pass --force to overwrite`,
      EXIT_VALIDATION
    );
  }

  // Lineage. --snapshot wins over --source: it PRODUCES the durable anchor, which is
  // the whole reason it exists (a run-folder --source is refused outright).
  const notes = [];
  let source = null;
  if (flags.snapshot) {
    if (flags.source) {
      throw new SidekicksError(
        'memory add: pass --snapshot OR --source, not both — --snapshot writes the anchor it then records',
        EXIT_VALIDATION
      );
    }
    const snap = writeSnapshot({
      repoRoot,
      namespace,
      slug: name,
      snapshotPath: String(flags.snapshot).replace(/\\/g, '/'),
      lines: flags['snapshot-lines'] ? String(flags['snapshot-lines']) : null,
    });
    source = snap.source;
    notes.push(`snapshot ${snap.evidenceRel}`);
    if (snap.warning) notes.push(snap.warning);
  } else {
    source = validateSource(flags.source);
  }

  // Write the entry file atomically (surface-gated).
  mkdirp(baseDir);
  assertWritable(entryPath, repoRoot);
  const created = bangkokTimestamp();
  const content = buildEntryFile({
    name, description, type, created, body, category, rule: isRule, source, links,
  });
  writeAtomic(entryPath, content);

  // Regenerate the store's three generated faces from one scan — they cannot disagree.
  syncStoreFaces(repoRoot);

  const verb = exists ? 'updated' : 'wrote';
  const tags = [`category=${category}`];
  if (isRule) tags.push('rule');
  if (source) tags.push(`source=${source}`);
  if (links.length) tags.push(`${links.length} link${links.length === 1 ? '' : 's'}`);
  const lines = [`${verb} ${entryPathRel}  [${tags.join(', ')}]`];
  for (const n of notes) lines.push(n);
  if (categoryWarning) lines.push(categoryWarning);

  return {
    stdout: lines.join('\n') + '\n',
    exitCode: EXIT_OK,
  };
}
