// lib/framework-lifecycle/config.mjs
// `sidekicks framework config <skill> [--json]`
//
// Prints a skill's EFFECTIVE configuration and, per key, which layer decided it:
// project config.yaml → root config.yaml (blocks that inherit root) → the skill's
// config.defaults.yaml → the descriptor's documented built-in.
//
// This is the verb that makes "skill config lives in the project's config.yaml, falling back to
// the skill's own defaults" checkable instead of prose repeated in each SKILL.md.
//
// Values are printed as JSON scalars; a missing project config.yaml is never an error.
//
// SECRETS ARE MASKED BY DEFAULT. The resolved config of a connector holds live credentials
// (`jira.<alias>.api_token`, `database_connector.<alias>.password`), and this verb is the one every
// SKILL.md and guide points at — so it used to be the framework's own contradiction of the
// "never print a secret" rail. Credential-shaped keys now render as `*** (len N)`; `--reveal` is the
// explicit opt-out for the one case that needs the value (copying it into a new scope's config).
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK } from '../sk-cli/errors.mjs';
import { resolveSkillConfig, configReadingSkills, SECRET_KEY_RE } from '../skill-config/resolve.mjs';
import { maskValue } from '../config-store/lint.mjs';
import { parseFrameworkFlags, requireId } from './_shared.mjs';

/**
 * Replace credential-shaped values with a mask, at any depth.
 *
 * @param {object} config
 * @returns {object} a copy — the caller's object is never mutated
 */
function redact(config) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = maskValue(value);
    } else if (Array.isArray(value)) {
      // Walk into a sequence: a list of lane mappings (telegram.bots) carries one credential per row,
      // and returning the array whole printed every one of them in clear text.
      out[key] = value.map((item) => (item && typeof item === 'object' ? redact(item) : item));
    } else if (value && typeof value === 'object') {
      out[key] = redact(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Run `framework config <skill>`.
 *
 * @param {{ repoRoot: string, argv: string[], flags: object }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseFrameworkFlags(ctx.argv, ['json', 'list', 'reveal']);

  if (flags.list) {
    const skills = configReadingSkills(repoRoot);
    if (flags.json) {
      return { stdout: JSON.stringify(skills, null, 2) + '\n', exitCode: EXIT_OK };
    }
    const lines = [`Skills that read scope config (${skills.length}):`, ''];
    for (const s of skills) {
      lines.push(`  ${s.skill}  block: ${s.block}  defaults: ${s.defaults || '(none)'}`);
    }
    return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
  }

  const skill = requireId(args.name, 'framework config');
  const resolved = resolveSkillConfig(repoRoot, skill);
  const shown = flags.reveal ? resolved.config : redact(resolved.config);

  if (flags.json) {
    return {
      stdout: JSON.stringify({ ...resolved, config: shown }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  const out = [
    `${resolved.skill} — config block '${resolved.block}' (active scope: ${resolved.scope})`,
    '',
    'layers, highest first:',
  ];
  for (const layer of resolved.layers) {
    const mark = layer.present ? 'carries this block' : 'no block here';
    const note = layer.inherits === false ? ' (block does not inherit root)' : '';
    out.push(`  ${layer.layer.padEnd(15)} ${layer.path || '(none)'} — ${mark}${note}`);
  }
  out.push('');
  const keys = Object.keys(resolved.config);
  if (keys.length === 0) {
    out.push('effective: (nothing configured — the skill uses its documented built-in behaviour)');
  } else {
    out.push('effective values:');
    for (const key of keys) {
      out.push(`  ${key}: ${JSON.stringify(shown[key])}   [${resolved.sources[key]}]`);
    }
    if (!flags.reveal) {
      out.push('');
      out.push('(credential-shaped values are masked — pass --reveal to print them)');
    }
  }
  return { stdout: out.join('\n') + '\n', exitCode: EXIT_OK };
}
