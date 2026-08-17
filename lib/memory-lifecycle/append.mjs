// lib/memory-lifecycle/append.mjs
// `sidekicks memory append <name> [--agent <a>] --line "<text>"` — append ONE
// line to an existing entry's body, deterministically.
//
// This verb exists because the alternative was a model-held read-modify-write:
// `memory show` prints the file verbatim (frontmatter included), the model
// re-registers with `add --force --body="<held text + new line>"`, and `add`
// wraps a FRESH frontmatter around the held one — stacking a header per cycle
// and tearing them when the reproduction is lossy (observed live on ethan's
// diary-buffer). Here the file never passes through a model: parse, strip any
// embedded-frontmatter damage already present (self-repairing), append the
// line, write back with the ORIGINAL frontmatter (created: preserved).
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
import { syncStoreFaces } from './_store.mjs';
import {
  validateSlug,
  parseMemoryFlags,
  parseEntryFile,
  stripEmbeddedFrontmatter,
  requireAgentLayer,
} from './_shared.mjs';

/**
 * Run `memory append`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = validateSlug(args.name);
  const flags = parseMemoryFlags(ctx.argv, []);

  const line = flags.line != null ? String(flags.line) : '';
  if (line.trim() === '') {
    throw new SidekicksError('memory append: --line "<text>" is required', EXIT_VALIDATION);
  }
  // Single-line contract: an appended entry row is one line, always.
  // (charCode check rather than a control-char regex - no escape pitfalls)
  if ([...line].some((c) => c.charCodeAt(0) < 32)) {
    throw new SidekicksError(
      'memory append: --line contains a newline or control character — append is one line per call',
      EXIT_VALIDATION
    );
  }

  const { baseDir, baseDirRel } = flags.agent
    ? requireAgentLayer(repoRoot, flags.agent)
    : resolveMemoryDir(repoRoot, read(repoRoot));
  const entryPath = join(baseDir, `${name}.md`);
  const entryPathRel = `${baseDirRel}/${name}.md`;

  if (!existsSync(entryPath)) {
    throw new SidekicksError(
      `memory append: no entry '${name}' at ${entryPathRel} — create it first with 'sidekicks memory add ${name} ...'`,
      EXIT_NOT_FOUND
    );
  }

  let text;
  try {
    text = readFileSync(entryPath, 'utf8');
  } catch (err) {
    throw new SidekicksError(`memory append: cannot read ${entryPathRel}: ${err.message}`, EXIT_VALIDATION);
  }
  const { frontmatter, body } = parseEntryFile(text);

  // Repair-on-touch: any stacked/torn frontmatter a past RMW cycle embedded in
  // the body is stripped before the new line lands.
  const cleanBody = stripEmbeddedFrontmatter(body);
  const repaired = cleanBody !== body;
  const nextBody = cleanBody === '' ? line : `${cleanBody}\n${line}`;

  const fm = yaml.serialize(frontmatter || {});
  assertWritable(entryPath, repoRoot);
  writeAtomic(entryPath, `---\n${fm}---\n\n${nextBody}\n`);

  // A body edit can introduce or remove a [[slug]] wiki-link, which is a graph edge —
  // so the generated faces are stale until they are regenerated, even though the
  // frontmatter did not move.
  syncStoreFaces(repoRoot);

  return {
    stdout: `appended to ${entryPathRel}${repaired ? ' (repaired embedded frontmatter)' : ''}\n`,
    exitCode: EXIT_OK,
  };
}
