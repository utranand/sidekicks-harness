import { readFileSync } from 'node:fs';
import { read } from '../settings-store/settings.mjs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { parseFlags, resolveRegistryPath, readRegistry, writeRegistry, validateCapabilities, CANDIDATE_VERSION } from './_shared.mjs';

export async function run(ctx) {
  const flags = parseFlags(ctx.argv, ['apply', 'root', 'json']);
  if (!flags.from) throw new SidekicksError('cli-executor sync: --from <candidate.json|-> is required', EXIT_VALIDATION);
  let raw;
  try { raw = flags.from === '-' ? readFileSync(0, 'utf8') : readFileSync(String(flags.from), 'utf8'); }
  catch (err) { throw new SidekicksError(`cli-executor sync: cannot read candidate: ${err.message}`, EXIT_VALIDATION); }
  let candidate;
  try { candidate = JSON.parse(raw); } catch { throw new SidekicksError('cli-executor sync: candidate is not valid JSON', EXIT_VALIDATION); }
  if (!candidate || candidate.candidate_version !== CANDIDATE_VERSION || !candidate.executors || typeof candidate.executors !== 'object') {
    throw new SidekicksError('cli-executor sync: unsupported or malformed candidate', EXIT_VALIDATION);
  }
  // Validate every block before touching the target registry, making apply all-or-nothing.
  const updates = {};
  for (const [name, entry] of Object.entries(candidate.executors)) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some((key) => key !== 'capabilities')) throw new SidekicksError(`cli-executor sync: invalid block for '${name}'`, EXIT_VALIDATION);
    updates[name] = validateCapabilities(name, entry.capabilities);
  }
  const { path, pathRel } = resolveRegistryPath(ctx.repoRoot, read(ctx.repoRoot), { root: flags.root === true });
  const registry = readRegistry(path);
  const diff = [];
  for (const [name, capabilities] of Object.entries(updates)) {
    const previous = registry.executors[name]?.capabilities;
    const oldIds = new Set(previous?.models?.map((row) => row.id) || []);
    const newIds = new Set(capabilities.models.map((row) => row.id));
    diff.push({ executor: name, status: capabilities.status, added: [...newIds].filter((id) => !oldIds.has(id)), removed: [...oldIds].filter((id) => !newIds.has(id)) });
  }
  if (flags.apply) {
    for (const [name, capabilities] of Object.entries(updates)) {
      const prior = registry.executors[name] || { kind: 'builtin', enabled: true };
      // A transient failure records status/diagnostics but never erases known model rows.
      registry.executors[name] = { ...prior, capabilities: capabilities.status === 'unavailable' && prior.capabilities?.models?.length ? { ...capabilities, models: prior.capabilities.models } : capabilities };
    }
    writeRegistry(path, registry, ctx.repoRoot);
  }
  const output = { target: pathRel, applied: flags.apply === true, diff };
  return { stdout: flags.json ? JSON.stringify(output, null, 2) + '\n' : `${flags.apply ? 'applied' : 'preview'} capability sync for ${pathRel}: ${diff.map((d) => `${d.executor} +${d.added.length}/-${d.removed.length} (${d.status})`).join(', ')}\n`, exitCode: EXIT_OK };
}
