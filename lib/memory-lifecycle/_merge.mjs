// lib/memory-lifecycle/_merge.mjs
// The SEMANTIC three-way merge of one memory entry — the engine behind the git merge
// driver (`memory merge driver`) and behind `memory resolve`.
//
// Why an entry is not merged as text: the file is a YAML frontmatter header over markdown
// prose, and the header is a MAP, not lines. A textual three-way merge of
// `metadata.links` drops one side's edges (or duplicates a key, which yaml.parse then
// resolves last-wins), and a textual merge of `metadata.rule` can silently turn a hard
// rule back into an ordinary entry. Both failures are invisible afterwards. So the header
// is merged field-by-field with a stated rule per field, and only the BODY is merged as
// text — by git itself, injected as `mergeBody` so this module stays pure and testable.
//
// Field rules, each chosen so the merge can only ADD knowledge or keep a constraint:
//
//   metadata.links     union (dedup on rel|to) — an edge either side declared survives
//   metadata.rule      true wins — the safety-increasing direction is the only safe guess
//   metadata.created   earliest — the fact was learned when it was FIRST written
//   metadata.category  a real category beats the `general` default; a true divergence
//                      keeps ours and asks for review
//   metadata.source    ours, then theirs — a lineage anchor is never dropped for nothing
//   description/type   plain three-way (the side that changed wins; both changed → ours)
//
// A body git cannot merge cleanly is UNIONED (both hunks, no markers) and the entry is
// stamped `metadata.merge_review` — the merge never leaves markers in the store, but it
// never pretends the result was clean either.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import {
  parseEntryFile,
  buildEntryFile,
  bangkokTimestamp,
  DEFAULT_CATEGORY,
} from './_shared.mjs';

/**
 * Normalize one side of the merge into the field set buildEntryFile consumes.
 * A missing key stays `undefined` rather than becoming a default: buildEntryFile OMITS
 * absent keys, which is what keeps a pre-central entry (no category, no links) byte-stable
 * through a merge that did not touch it.
 *
 * @param {string|null} text - the raw file text, or null when this side does not exist
 * @returns {{
 *   present: boolean, name?: string, description?: string, type?: string, created?: string,
 *   category?: string, rule: boolean, source?: string, mergeReview?: string,
 *   links: Array<{rel:string,to:string}>, body: string,
 * }}
 */
export function readEntryParts(text) {
  if (text == null) return { present: false, rule: false, links: [], body: '' };
  const { frontmatter, body } = parseEntryFile(text);
  const fm = frontmatter && typeof frontmatter === 'object' ? frontmatter : {};
  const meta = fm.metadata && typeof fm.metadata === 'object' ? fm.metadata : {};
  const links = Array.isArray(meta.links)
    ? meta.links
      .filter((l) => l && typeof l === 'object' && typeof l.rel === 'string' && typeof l.to === 'string')
      .map((l) => ({ rel: l.rel, to: l.to }))
    : [];
  const out = { present: true, rule: meta.rule === true, links, body: body ?? '' };
  if (typeof fm.name === 'string' && fm.name) out.name = fm.name;
  if (typeof fm.description === 'string') out.description = fm.description;
  if (typeof meta.type === 'string' && meta.type) out.type = meta.type;
  if (typeof meta.created === 'string' && meta.created) out.created = meta.created;
  if (typeof meta.category === 'string' && meta.category) out.category = meta.category;
  if (typeof meta.source === 'string' && meta.source) out.source = meta.source;
  if (typeof meta.merge_review === 'string' && meta.merge_review) out.mergeReview = meta.merge_review;
  return out;
}

/**
 * Plain three-way pick for a scalar: the side that changed wins; when both changed, ours
 * wins and the caller is told, so a divergence can be surfaced instead of guessed away.
 *
 * @template T
 * @param {T|undefined} base
 * @param {T|undefined} ours
 * @param {T|undefined} theirs
 * @returns {{ value: T|undefined, diverged: boolean }}
 */
function pick3(base, ours, theirs) {
  if (ours === theirs) return { value: ours, diverged: false };
  if (ours === undefined) return { value: theirs, diverged: false };
  if (theirs === undefined) return { value: ours, diverged: false };
  if (ours === base) return { value: theirs, diverged: false };
  if (theirs === base) return { value: ours, diverged: false };
  return { value: ours, diverged: true };
}

/** The earlier of two ISO-8601 timestamps; a value that will not parse loses to one that will. */
function earliest(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  if (ta === tb) return a <= b ? a : b;
  return ta < tb ? a : b;
}

/**
 * Merge the frontmatter of two sides against their base.
 *
 * @param {ReturnType<typeof readEntryParts>} base
 * @param {ReturnType<typeof readEntryParts>} ours
 * @param {ReturnType<typeof readEntryParts>} theirs
 * @returns {{ fields: object, notes: string[] }} fields feed buildEntryFile; notes explain
 *   every non-obvious choice, for the driver's log and for `memory resolve --dry-run`.
 */
export function mergeFrontmatter(base, ours, theirs) {
  const notes = [];
  const fields = {};

  // Only one side has the entry at all — an add/delete race. Whichever exists wins: the
  // store never loses a fact because the other branch had not learned it yet.
  if (ours.present && !theirs.present) return { fields: { ...ours }, notes: ['theirs has no entry — kept ours'] };
  if (theirs.present && !ours.present) return { fields: { ...theirs }, notes: ['ours has no entry — kept theirs'] };

  const name = pick3(base.name, ours.name, theirs.name);
  fields.name = name.value;

  const description = pick3(base.description, ours.description, theirs.description);
  fields.description = description.value;
  if (description.diverged) notes.push('description changed on both sides — kept ours');

  const type = pick3(base.type, ours.type, theirs.type);
  fields.type = type.value;
  if (type.diverged) notes.push(`type changed on both sides ('${ours.type}' vs '${theirs.type}') — kept ours`);

  fields.created = earliest(ours.created, theirs.created);
  if (ours.created && theirs.created && ours.created !== theirs.created) {
    notes.push(`created differs — kept the earliest (${fields.created})`);
  }

  // rule: true wins. The alternative — a plain three-way pick — can turn a hard rule back
  // into an ordinary entry, and a hard rule that stops loading fails silently.
  fields.rule = ours.rule || theirs.rule;
  if (ours.rule !== theirs.rule) notes.push('rule differs — kept rule: true (safety-increasing)');

  // category: a real category beats the `general` default, because `general` is what an
  // entry gets when nobody said anything.
  if (ours.category === theirs.category) {
    fields.category = ours.category;
  } else if (!ours.category || ours.category === DEFAULT_CATEGORY) {
    fields.category = theirs.category;
    notes.push(`category '${theirs.category}' beats '${ours.category ?? '(none)'}'`);
  } else if (!theirs.category || theirs.category === DEFAULT_CATEGORY) {
    fields.category = ours.category;
    notes.push(`category '${ours.category}' beats '${theirs.category ?? '(none)'}'`);
  } else {
    fields.category = ours.category;
    notes.push(`category diverged ('${ours.category}' vs '${theirs.category}') — kept ours, review needed`);
    fields.needsReview = true;
  }

  fields.source = ours.source ?? theirs.source;
  if (ours.source && theirs.source && ours.source !== theirs.source) {
    notes.push(`source diverged ('${ours.source}' vs '${theirs.source}') — kept ours`);
  }

  // links: union, ours order first, then theirs' extras. Deterministic, and no edge is lost.
  const seen = new Set();
  const links = [];
  for (const l of [...ours.links, ...theirs.links]) {
    const key = `${l.rel}|${l.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ rel: l.rel, to: l.to });
  }
  fields.links = links;
  const added = links.length - ours.links.length;
  if (added > 0) notes.push(`links unioned — ${added} edge${added === 1 ? '' : 's'} from theirs`);

  // An unresolved review flag on either side survives the merge; clearing it is a human's
  // call (`memory resolve <slug> --accept`).
  fields.mergeReview = ours.mergeReview ?? theirs.mergeReview;

  return { fields, notes };
}

/**
 * The pure fallback body merge, used when no `mergeBody` is injected (unit tests, and any
 * caller without git). Union on a real divergence — never markers.
 *
 * @param {string} base
 * @param {string} ours
 * @param {string} theirs
 * @returns {{ body: string, conflicted: boolean }}
 */
export function unionBody(base, ours, theirs) {
  if (ours === theirs) return { body: ours, conflicted: false };
  if (ours === base) return { body: theirs, conflicted: false };
  if (theirs === base) return { body: ours, conflicted: false };
  const oursLines = ours.split('\n');
  const theirsLines = theirs.split('\n');
  const have = new Set(oursLines);
  const extra = theirsLines.filter((l) => !have.has(l));
  const merged = extra.length ? `${ours.replace(/\n+$/, '')}\n\n${extra.join('\n')}` : ours;
  return { body: merged, conflicted: true };
}

/**
 * Merge one entry, three sides in and one entry file out.
 *
 * @param {{ base: string|null, ours: string|null, theirs: string|null }} sides - raw file texts
 * @param {{
 *   mergeBody?: (base: string, ours: string, theirs: string) => { body: string, conflicted: boolean },
 *   now?: () => string,
 * }} [opts] - mergeBody defaults to unionBody; `now` is injectable so a test can pin the stamp
 * @returns {{ text: string, conflicted: boolean, review: string|null, notes: string[] }}
 */
export function mergeEntry(sides, opts = {}) {
  const mergeBody = opts.mergeBody ?? unionBody;
  const now = opts.now ?? bangkokTimestamp;

  const base = readEntryParts(sides.base ?? null);
  const ours = readEntryParts(sides.ours ?? null);
  const theirs = readEntryParts(sides.theirs ?? null);

  const { fields, notes } = mergeFrontmatter(base, ours, theirs);

  let body = fields.body ?? '';
  let conflicted = false;
  if (ours.present && theirs.present) {
    const merged = mergeBody(base.body ?? '', ours.body ?? '', theirs.body ?? '');
    body = merged.body;
    conflicted = merged.conflicted === true;
    if (conflicted) notes.push('body diverged — both hunks kept (union), flagged for review');
  }

  const review = (conflicted || fields.needsReview) ? (fields.mergeReview ?? now()) : (fields.mergeReview ?? null);

  const text = buildEntryFile({
    name: fields.name,
    description: fields.description ?? '',
    // buildEntryFile re-derives the stored type; a side that stored `convention` + rule
    // round-trips unchanged through it.
    type: fields.type ?? 'context',
    created: fields.created ?? now(),
    body,
    category: fields.category,
    rule: fields.rule === true,
    source: fields.source,
    links: fields.links ?? [],
    mergeReview: review,
  });

  return { text, conflicted, review, notes };
}
