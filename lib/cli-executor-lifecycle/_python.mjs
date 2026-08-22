import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SidekicksError, EXIT_IO } from '../sk-cli/errors.mjs';

export function runSkillPython(repoRoot, script, args = []) {
  const venv = process.platform === 'win32' ? join(repoRoot, '.venv', 'Scripts', 'python.exe') : join(repoRoot, '.venv', 'bin', 'python');
  const python = existsSync(venv) ? venv : (process.env.PYTHON || 'python3');
  const path = join(repoRoot, '.agents', 'skills', 'sk-cli-executor', 'scripts', script);
  const result = spawnSync(python, [path, ...args], { encoding: 'utf8', cwd: repoRoot, timeout: 130_000 });
  if (result.error) throw new SidekicksError(`cli-executor: could not run ${script}: ${result.error.message}`, EXIT_IO);
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}
