// lib/cli-executor-lifecycle/route.mjs
// `sidekicks cli-executor route [set <name>… | clear | skill …]` — manage the ROUTING policy:
//   - `routing.prefer` — the global ordered preference chain ("prefer the first, fall back to the
//     next if unavailable") that `--executor auto` resolves against.
//   - `routing.skills` — the per-task-kind RECOMMENDATION map ("for THIS kind of job these
//     executors work best, in order — and these should be avoided"), e.g. image-generation →
//     antigravity then codex, avoid claude. The orchestrator consults it before the global chain
//     when it knows what kind of task an item is.
// This verb is config CRUD only. Live RESOLUTION (probe each in order, take the first available)
// is the executor's job: `executor.py route` prints the winner and `executor.py invoke
// --executor auto` resolves-then-invokes. That split keeps probing (subprocess territory) out of
// the Node CLI.
//
// Examples:
//   sidekicks cli-executor route                     # show the current policy (chain + skill map)
//   sidekicks cli-executor route set codex gemini    # prefer codex, fall back to gemini
//   sidekicks cli-executor route clear               # remove the global chain (skill map kept)
//   sidekicks cli-executor route skill set image-generation antigravity codex \
//       --avoid claude --note 'Claude CLI has no image generation'
//   sidekicks cli-executor route skill remove image-generation
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { read } from '../settings-store/settings.mjs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  resolveRegistryPath,
  readRegistry,
  writeRegistry,
  effectiveExecutors,
  routingPolicy,
  skillRouting,
  validateRoutingChain,
  validateSkillRoute,
  parseFlags,
  splitListFlag,
} from './_shared.mjs';

// The dispatcher's non-strict parseArgs leaks a space-form flag VALUE (`--avoid claude`) into the
// positional list, so `args.rest` would carry 'claude' as if it were a prefer-chain name. Re-derive
// the true positionals from the raw argv with the exact consumption rule parseFlags applies: an
// `=`-form flag is one token, a bare `--flag` followed by a non-flag token consumes that token as
// its value, and known global booleans consume nothing.
const GLOBAL_BOOLEANS = ['verbose', 'help', 'version', 'json'];
function cleanPositionals(argv) {
  const boolSet = new Set(GLOBAL_BOOLEANS);
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      if (!body.includes('=') && !boolSet.has(body)) {
        const next = list[i + 1];
        if (next !== undefined && !next.startsWith('--')) i++; // the flag's value token
      }
      continue;
    }
    out.push(tok);
  }
  return out;
}

function renderSkillMap(skills, indent = '  ') {
  const lines = [];
  for (const key of Object.keys(skills).sort()) {
    const entry = skills[key] || {};
    const prefer = Array.isArray(entry.prefer) ? entry.prefer.join(' → ') : '(none)';
    const avoid = Array.isArray(entry.avoid) && entry.avoid.length ? `  avoid: ${entry.avoid.join(', ')}` : '';
    lines.push(`${indent}${key}: ${prefer}${avoid}`);
    if (entry.note) lines.push(`${indent}  note: ${entry.note}`);
  }
  return lines;
}

/**
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @param {{ name?: string, rest?: string[] }} args - name = sub-action (set|clear|skill|undefined)
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const action = args.name;              // undefined (show) | "set" | "clear" | "skill"
  const names = args.rest || [];         // executor names for `set`, sub-args for `skill`

  const globalFlags = parseFlags(ctx.argv, ['root']);
  const { path, pathRel, scopeLabel } = resolveRegistryPath(repoRoot, read(repoRoot), { root: globalFlags.root === true });
  const registry = readRegistry(path);
  const effective = effectiveExecutors(registry);

  // ── show ──────────────────────────────────────────────────────────────────
  if (!action) {
    const chain = routingPolicy(registry);
    const skills = skillRouting(registry);
    const lines = [];
    if (chain.length === 0) {
      const natural = Object.values(effective)
        .filter((s) => s.enabled !== false)
        .map((s) => s.name);
      lines.push(`no auto-routing policy set (${pathRel}).`);
      lines.push(`  \`--executor auto\` resolves to the first AVAILABLE enabled executor in natural order:`);
      lines.push(`    ${natural.join(' → ')}`);
      lines.push(`  Set an explicit chain:  sidekicks cli-executor route set <name> [<name>...]`);
    } else {
      lines.push(`auto-routing policy (${pathRel}):`);
      lines.push(`  prefer: ${chain.join(' → ')}`);
      lines.push(`  \`--executor auto\` picks the first of these that probes AVAILABLE at run time.`);
      lines.push(`  Resolve live:  <cli-executor scripts>/executor.py route`);
    }
    if (Object.keys(skills).length) {
      lines.push(`  recommended executors by task kind (routing.skills — consulted BEFORE the global chain):`);
      lines.push(...renderSkillMap(skills, '    '));
    } else {
      lines.push(`  no per-task-kind recommendations set:  sidekicks cli-executor route skill set <task-kind> <name>... [--avoid '<a,b>'] [--note '<why>']`);
    }
    return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
  }

  // A project can deliberately drop its complete routing override and reveal the root policy.
  if (action === 'inherit') {
    if (globalFlags.root === true || scopeLabel === 'sidekicks (root)') throw new SidekicksError('cli-executor route inherit is available only for an active user project', EXIT_VALIDATION);
    delete registry.routing;
    writeRegistry(path, registry, repoRoot);
    return { stdout: `removed project routing override from ${pathRel}; root routing is now effective\n`, exitCode: EXIT_OK };
  }

  // ── clear ─────────────────────────────────────────────────────────────────
  if (action === 'clear') {
    const skills = skillRouting(registry);
    if (!registry.routing || !Array.isArray(registry.routing.prefer) || !registry.routing.prefer.length) {
      return { stdout: `no auto-routing chain to clear (${pathRel})\n`, exitCode: EXIT_OK };
    }
    // Clear only the global chain — the per-task-kind skill map is separate config a user set
    // deliberately; wiping it as a side effect of clearing the chain would silently lose it.
    if (Object.keys(skills).length) {
      registry.routing = { skills };
      writeRegistry(path, registry, repoRoot);
      return {
        stdout: `cleared auto-routing chain in ${pathRel} (kept ${Object.keys(skills).length} skill recommendation${Object.keys(skills).length === 1 ? '' : 's'} — remove with 'route skill remove <task-kind>')\n`,
        exitCode: EXIT_OK,
      };
    }
    delete registry.routing;
    writeRegistry(path, registry, repoRoot);
    return { stdout: `cleared auto-routing policy in ${pathRel}\n`, exitCode: EXIT_OK };
  }

  // ── set ───────────────────────────────────────────────────────────────────
  if (action === 'set') {
    const chain = validateRoutingChain(names, effective); // throws on unknown/dupe/empty
    const disabled = chain.filter((n) => effective[n].enabled === false);
    registry.routing = { ...(registry.routing || {}), prefer: chain };
    writeRegistry(path, registry, repoRoot);
    let note = '';
    if (disabled.length) {
      note = `\n  note: ${disabled.join(', ')} ${disabled.length === 1 ? 'is' : 'are'} currently ` +
             `disabled — resolution will skip ${disabled.length === 1 ? 'it' : 'them'} until re-enabled.`;
    }
    return {
      stdout: `set auto-routing policy in ${pathRel}:\n  prefer: ${chain.join(' → ')}${note}\n`,
      exitCode: EXIT_OK,
    };
  }

  // ── skill [set|remove|show] ───────────────────────────────────────────────
  if (action === 'skill') {
    const sub = names[0];                // undefined (show) | "set" | "remove"
    if (!sub) {
      const skills = skillRouting(registry);
      if (!Object.keys(skills).length) {
        return {
          stdout:
            `no per-task-kind recommendations set (${pathRel}).\n` +
            `  Add one:  sidekicks cli-executor route skill set <task-kind> <name> [<name>...] [--avoid '<a,b>'] [--note '<why>']\n`,
          exitCode: EXIT_OK,
        };
      }
      return {
        stdout:
          `recommended executors by task kind (${pathRel}):\n` +
          renderSkillMap(skills).join('\n') + '\n',
        exitCode: EXIT_OK,
      };
    }

    if (sub === 'set') {
      // positionals: ['cli-executor', 'route', 'skill', 'set', <task-kind>, <prefer...>]
      const pos = cleanPositionals(ctx.argv);
      const taskKind = pos[4];
      const prefer = pos.slice(5);
      if (!taskKind) {
        throw new SidekicksError(
          `cli-executor route skill set: usage — route skill set <task-kind> <name> [<name>...] [--avoid '<a,b>'] [--note '<why>']`,
          EXIT_VALIDATION
        );
      }
      const flags = parseFlags(ctx.argv);
      const avoid = splitListFlag(typeof flags.avoid === 'string' ? flags.avoid : undefined);
      const note = typeof flags.note === 'string' ? flags.note : undefined;
      const entry = validateSkillRoute(taskKind, prefer, avoid, note, effective); // throws on any invalid field
      const skills = skillRouting(registry);
      const existed = Object.prototype.hasOwnProperty.call(skills, taskKind);
      skills[taskKind] = entry;
      registry.routing = { ...(registry.routing || {}), skills };
      writeRegistry(path, registry, repoRoot);
      const avoidStr = entry.avoid ? `  avoid: ${entry.avoid.join(', ')}` : '';
      return {
        stdout:
          `${existed ? 'updated' : 'set'} recommendation for '${taskKind}' in ${pathRel}:\n` +
          `  ${taskKind}: ${entry.prefer.join(' → ')}${avoidStr}\n` +
          (entry.note ? `    note: ${entry.note}\n` : ''),
        exitCode: EXIT_OK,
      };
    }

    if (sub === 'remove') {
      const taskKind = names[1];
      if (!taskKind) {
        throw new SidekicksError(`cli-executor route skill remove: a <task-kind> is required`, EXIT_VALIDATION);
      }
      const skills = skillRouting(registry);
      if (!Object.prototype.hasOwnProperty.call(skills, taskKind)) {
        throw new SidekicksError(
          `cli-executor route skill remove: no recommendation for '${taskKind}' — set: ${Object.keys(skills).sort().join(', ') || '(none)'}`,
          EXIT_VALIDATION
        );
      }
      delete skills[taskKind];
      if (Object.keys(skills).length) {
        registry.routing = { ...(registry.routing || {}), skills };
      } else if (registry.routing) {
        delete registry.routing.skills;
        if (!Array.isArray(registry.routing.prefer) || !registry.routing.prefer.length) delete registry.routing;
      }
      writeRegistry(path, registry, repoRoot);
      return { stdout: `removed recommendation for '${taskKind}' in ${pathRel}\n`, exitCode: EXIT_OK };
    }

    throw new SidekicksError(
      `cli-executor route skill: unknown action '${sub}' — use 'set <task-kind> <name>...', 'remove <task-kind>', or no argument to show`,
      EXIT_VALIDATION
    );
  }

  throw new SidekicksError(
    `cli-executor route: unknown action '${action}' — use 'set <name>...', 'clear', 'skill …', or no argument to show`,
    EXIT_VALIDATION
  );
}
