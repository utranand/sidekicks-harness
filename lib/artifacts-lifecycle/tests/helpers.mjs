// lib/artifacts-lifecycle/tests/helpers.mjs
// Shared test helpers — temp repo construction + CLI subprocess runner.
// node: stdlib only.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const bin = join(repoRoot, 'bin/sidekicks');

/** Run the sidekicks CLI with the given args in the given cwd. */
export function sk(cwd, args) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Build a minimal fake Sidekicks repo at a temp path (root scope by default). */
export function makeRepo(settings = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sk-artifacts-')));
  // Both, explicitly. `.sidekicks/` used to be created as a side effect of making the skills tree
  // beneath it; the skills tree now lives under `.agents/`, so the marker directory that makes this
  // a Sidekicks repo has to be asked for by name.
  mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(root, '.sidekicks'), { recursive: true });
  writeFileSync(
    join(root, '.sidekicks', 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n'
  );
  return root;
}

/** Add a user project with a valid manifest. */
export function addProject(root, name, opts = {}) {
  const projDir = join(root, 'projects', name);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, 'manifest.yaml'),
    `name: ${name}\nremote_source: null\nservices: []\noverrides: {}\n`
  );
  if (opts.withService) {
    const svcDir = join(projDir, 'services', opts.withService, 'src');
    mkdirSync(svcDir, { recursive: true });
    writeFileSync(
      join(projDir, 'services', opts.withService, 'service.yaml'),
      `name: ${opts.withService}\nremote_source: null\nbranch: null\ncommit: null\n`
    );
  }
  return projDir;
}

/** Write a run.json directly into a runs root (skipping the CLI). */
export function writeRunJson(runsRoot, skill, slug, manifest) {
  const dir = join(runsRoot, skill, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'run.json'),
    JSON.stringify({ skill, slug, ...manifest }, null, 2) + '\n'
  );
  return dir;
}

/** Write a legacy bespoke ledger (no run.json) into a runs root. */
export function writeLedger(runsRoot, skill, slug, filename, yamlText) {
  const dir = join(runsRoot, skill, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), yamlText);
  return dir;
}

export function cleanup(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}
