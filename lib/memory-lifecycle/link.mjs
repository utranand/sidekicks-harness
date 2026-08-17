// lib/memory-lifecycle/link.mjs
// `sidekicks memory link <from> <rel> <to> [--agent <a>] [--remove]`
//
// Add (or drop) ONE declared graph edge on an existing entry, then regenerate the
// store's generated faces. Declared edges are the strongest kind — someone wrote this
// relationship down on purpose — so they rank above harvested [[wiki-links]] and above
// inferred same-anchor edges wherever a reader walks the graph.
//
// The edge is written into the SOURCE entry's frontmatter, not into graph.json: the
// entry files are the truth, and graph.json is a generated view of them. Editing the
// generated file would be undone by the next rebuild.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { read } from '../settings-store/settings.mjs';
import { resolveMemoryDir } from '../active-scope/memory-paths.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import * as yaml from '../yaml-subset/yaml.mjs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION, EXIT_NOT_FOUND } from '../sk-cli/errors.mjs';
import {
  validateSlug,
  parseMemoryFlags,
  parseEntryFile,
  requireAgentLayer,
  parseLink,
  LINK_RELS,
} from './_shared.mjs';
import { syncStoreFaces, readIndexJson } from './_store.mjs';

/**
 * Run `memory link`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string, rest?: string[] }} args - name=<from>, rest=[<rel>, <to>]
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseMemoryFlags(ctx.argv, ['remove', 'json']);
  const from = validateSlug(args.name);
  const rest = args.rest || [];
  if (rest.length < 2) {
    throw new SidekicksError(
      `memory link: expected <from> <rel> <to> — rel one of: ${LINK_RELS.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  // parseLink validates both the relation and the target slug in one place.
  const { rel, to } = parseLink(`${rest[0]}:${rest[1]}`);

  const layer = flags.agent
    ? requireAgentLayer(repoRoot, flags.agent)
    : resolveMemoryDir(repoRoot, read(repoRoot));
  const entryPath = join(layer.baseDir, `${from}.md`);
  const entryPathRel = `${layer.baseDirRel}/${from}.md`;

  if (!existsSync(entryPath)) {
    throw new SidekicksError(
      `memory link: no entry '${from}' at ${entryPathRel} — an edge is written into the source entry, `
        + `so that entry must exist in the ACTIVE namespace`,
      EXIT_NOT_FOUND
    );
  }

  // A link to an entry that does not exist is allowed but reported: the target may be
  // registered later, and refusing would make it impossible to record a known
  // relationship in the order it becomes known. `memory doctor` lists it as dangling.
  const targetKnown = readIndexJson(repoRoot).entries.some((e) => e.slug === to);

  const text = readFileSync(entryPath, 'utf8');
  const { frontmatter, body } = parseEntryFile(text);
  const fm = frontmatter && typeof frontmatter === 'object' ? frontmatter : {};
  if (!fm.metadata || typeof fm.metadata !== 'object') fm.metadata = {};
  const links = Array.isArray(fm.metadata.links) ? fm.metadata.links : [];

  const idx = links.findIndex((l) => l && l.rel === rel && l.to === to);
  let verb;
  if (flags.remove) {
    if (idx === -1) {
      throw new SidekicksError(
        `memory link: '${from}' has no '${rel}' edge to '${to}' to remove`,
        EXIT_NOT_FOUND
      );
    }
    links.splice(idx, 1);
    verb = 'removed';
  } else {
    if (idx !== -1) {
      return { stdout: `link already present: ${from} --${rel}--> ${to}\n`, exitCode: EXIT_OK };
    }
    links.push({ rel, to });
    verb = 'linked';
  }

  if (links.length) fm.metadata.links = links.map((l) => ({ rel: l.rel, to: l.to }));
  else delete fm.metadata.links;

  const serialized = yaml.serialize(fm);
  yaml.assertRoundTrips(serialized, `memory entry '${from}' frontmatter`);
  assertWritable(entryPath, repoRoot);
  writeAtomic(entryPath, `---\n${serialized}---\n\n${body}\n`);

  syncStoreFaces(repoRoot);

  const lines = [`${verb} ${from} --${rel}--> ${to}  (${entryPathRel})`];
  if (!flags.remove && !targetKnown) {
    lines.push(`note: '${to}' is not in the store yet — the edge is recorded as dangling until it is`);
  }
  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}
