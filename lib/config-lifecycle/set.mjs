// lib/config-lifecycle/set.mjs
// `sidekicks config set <block>.<key.path> <value> [--secret] [--root] [--json]`
//
// The Rule 1 mediated write for scope configuration — the verb that did not exist. Before it, the only
// writer for a scope config lived inside a skill and everything else was a hand edit; that is how one
// project's config ended up with three duplicate top-level keys.
//
// It routes by key: a credential-shaped key (or `--secret`) is written to the git-ignored
// `<family>.secret.yaml`, everything else to the committed `<family>.yaml`. It never touches the legacy
// monolith — that layer exists only so an unmigrated scope keeps working.
//
// Values are parsed the way the readers parse them: `true`/`false`/numbers/`null` become scalars, and
// anything else stays a string. Use `--raw` to force a string.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, SidekicksError, EXIT_USAGE } from '../sk-cli/errors.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { blockEntry, CONFIG_DIR } from '../config-store/families.mjs';
import { readBlock, parseValue } from '../config-store/block.mjs';
import { writeBlock, ensureSecretIgnore } from '../config-store/write.mjs';
import { parseConfigFlags, requireBlock } from './_shared.mjs';
import { maskValue } from '../config-store/lint.mjs';

/**
 * Why the JSON payload shows `*** (len N)` instead of the value.
 *
 * Deliberately NOT `_shared.mjs`'s MASK_NOTE: that one offers `--reveal`, which is a READ flag.
 * A mutation has no reveal gate on purpose — the caller supplied the value, so it already has it,
 * and adding a switch that echoes a credential back would recreate the disclosure this closes.
 */
const MASK_NOTE_SET = 'credential values are masked here — the caller already holds the value it wrote';

const SECRET_KEY_RE = /(api_key|apikey|token|password|passwd|secret|pass)/i;

/**
 * Parse a CLI value the way the config readers coerce a bare scalar.
 *
 * A `[a, b]` argument becomes a real ARRAY, which the writer then emits as a BLOCK SEQUENCE. That
 * matters because the agent readers (lib/yaml-subset) support block sequences and not flow ones: a
 * verbatim `allowed_users: [<id>]` line parses to the STRING "[<id>]" there, and
 * telegram.mjs only merges a root `allowed_users` when `Array.isArray` holds — so the value looked
 * right in the file while the allow-list resolved EMPTY. `--raw` keeps the literal string.
 *
 * A non-empty flow MAPPING is refused instead of guessed: set its keys one at a time so each lands
 * as a nested mapping every parser reads.
 */
function coerceValue(raw, keepString) {
  if (keepString) return raw;
  if (raw === 'null' || raw === '~') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  if (raw === '[]') return [];
  if (raw === '{}') return {};
  const t = raw.trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    const parsed = parseValue(t);
    if (Array.isArray(parsed)) return parsed;
  }
  if (t.length > 2 && t.startsWith('{') && t.endsWith('}')) {
    throw new SidekicksError(
      `config set: '${t}' is a flow mapping — set its keys one at a time `
      + '(e.g. `config set telegram.bots.default.username <name>`), so each one is written as a '
      + 'nested mapping every reader parses. Pass --raw to store the literal text.',
      EXIT_USAGE
    );
  }
  return raw;
}

/** Set a dotted path inside an object, creating intermediate mappings. Returns the previous value. */
function setPath(obj, path, value) {
  const parts = path.split('.');
  let cursor = obj;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  const last = parts[parts.length - 1];
  const before = cursor[last];
  cursor[last] = value;
  return before;
}

/**
 * Run `config set`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string, rest?: string[] }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseConfigFlags(ctx.argv, ['secret', 'root', 'json', 'raw', 'value-stdin']);
  const target = requireBlock(args.name, 'config set');
  // `--value-stdin` keeps a credential out of argv and out of shell history — the two places a
  // token typed on a command line survives long after the rotation that was supposed to retire
  // it (`ps`, `~/.zsh_history`, a CI job's recorded command). The trailing newline a heredoc or
  // `echo` adds is stripped; anything else is taken verbatim.
  let rawValue;
  if (flags['value-stdin']) {
    try {
      rawValue = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      throw new SidekicksError(`config set: --value-stdin could not read stdin: ${err.message}`, EXIT_USAGE);
    }
  } else {
    rawValue = (args.rest || []).find((a) => !a.startsWith('--'));
  }
  if (rawValue === undefined) {
    throw new SidekicksError(
      'config set: missing <value> — usage: sidekicks config set <block>.<key> <value> '
      + '(or pipe it in with --value-stdin)',
      EXIT_USAGE
    );
  }

  const dot = target.indexOf('.');
  if (dot === -1) {
    throw new SidekicksError(
      `config set: '${target}' names a whole block — set one key at a time `
      + '(e.g. `config set jira.shp.jira_url https://…`)',
      EXIT_USAGE
    );
  }
  const blockName = target.slice(0, dot);
  const keyPath = target.slice(dot + 1);

  const entry = blockEntry(repoRoot, blockName);
  if (!entry) {
    throw new SidekicksError(
      `config set: nothing declares block '${blockName}' — run 'sidekicks config list'`,
      EXIT_USAGE
    );
  }

  const settings = readSettings(repoRoot);
  const { projectName, projectRelPath } = resolveEffectiveScope(settings);
  const useRoot = Boolean(flags.root) || entry.scope === 'root' || projectRelPath === null;
  const base = useRoot ? '.sidekicks' : projectRelPath;

  const leaf = keyPath.split('.').pop();
  const toSecret = Boolean(flags.secret) || SECRET_KEY_RE.test(leaf);
  const rel = join(base, CONFIG_DIR, toSecret ? entry.secret : entry.file);

  // A credential written into the committed half would be published — refuse before touching disk.
  // The leaf key is covered by `toSecret`; this catches a credential nested under a secret-shaped
  // parent (`secrets.aws_key.value`), where only the parent matches.
  if (!toSecret && SECRET_KEY_RE.test(keyPath)) {
    throw new SidekicksError(
      `config set: '${keyPath}' looks like a credential path but would be written to the committed `
      + `file '${rel}' — re-run with --secret to put it in '${entry.secret}' instead`,
      EXIT_USAGE
    );
  }

  const abs = join(repoRoot, rel);
  const text = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  const current = text ? (readBlock(text, entry.block) ?? {}) : {};
  const value = coerceValue(rawValue, Boolean(flags.raw));
  const before = setPath(current, keyPath, value);

  const header = toSecret
    ? [
      `# ${rel} — GIT-IGNORED credential half of ${entry.file}.`,
      '# Written by \`sidekicks config set\`. Never commit this file.',
    ]
    : [
      `# ${rel} — committed, non-secret configuration for family '${entry.family}'.`,
      `# Credentials belong in the git-ignored sibling '${entry.secret}'.`,
    ];
  ensureSecretIgnore(repoRoot, join(base, CONFIG_DIR));
  const result = writeBlock(repoRoot, rel, entry.block, current, { header });

  if (flags.json) {
    // A credential write must not PRINT the credential. This endpoint returned `previous` AND
    // `value` in clear text on the very path that had just decided the key belonged in a
    // git-ignored `.secret.yaml` — so rotating a token put the new one and the still-valid old
    // one into CI logs, agent transcripts and automation captures at once. `config get` has
    // masked by default all along; the mutation endpoint now uses the same masker, so the two
    // halves of the store finally state the same policy.
    const show = (v) => (toSecret ? maskValue(v) : v);
    return {
      stdout: JSON.stringify({
        block: entry.block,
        key: keyPath,
        scope: useRoot ? 'sidekicks' : projectName,
        file: result.path,
        secret: toSecret,
        created: result.created,
        previous: before === undefined ? null : show(before),
        value: show(value),
        ...(toSecret ? { note: MASK_NOTE_SET } : {}),
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const what = before === undefined ? 'set' : 'changed';
  return {
    stdout: `${what} ${entry.block}.${keyPath} in ${result.path}`
      + `${result.created ? ' (file created)' : ''}`
      + `${toSecret ? '   [credential — git-ignored]' : ''}\n`,
    exitCode: EXIT_OK,
  };
}
