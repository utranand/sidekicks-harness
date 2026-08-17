// lib/artifacts-lifecycle/tests/liveness-config.test.mjs
// Unit tests for readLivenessConfig — the centralized .sidekicks/agents-liveness.yaml loader.
// node: stdlib only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readLivenessConfig, DEFAULT_DEBOUNCE_SECONDS } from '../liveness-config.mjs';
import { STALE_RUNNING_SECONDS } from '../_manage.mjs';

function repoWith(yamlText) {
  const root = mkdtempSync(join(tmpdir(), 'sk-lcfg-'));
  mkdirSync(join(root, '.sidekicks'), { recursive: true });
  if (yamlText != null) writeFileSync(join(root, '.sidekicks', 'agents-liveness.yaml'), yamlText, 'utf8');
  return root;
}

describe('readLivenessConfig', () => {
  test('absent file → built-in defaults (always-on)', () => {
    const root = repoWith(null);
    try {
      const c = readLivenessConfig(root);
      assert.deepEqual(c, {
        enabled: true,
        staleSeconds: STALE_RUNNING_SECONDS,
        debounceSeconds: DEFAULT_DEBOUNCE_SECONDS,
        source: 'default',
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('reads the artifact_liveness: block', () => {
    const root = repoWith('artifact_liveness:\n  enabled: false\n  stale_seconds: 600\n  debounce_seconds: 15\n');
    try {
      const c = readLivenessConfig(root);
      assert.equal(c.enabled, false);
      assert.equal(c.staleSeconds, 600);
      assert.equal(c.debounceSeconds, 15);
      assert.equal(c.source, 'file');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('tolerates a flat file with no artifact_liveness wrapper', () => {
    const root = repoWith('stale_seconds: 900\n');
    try {
      assert.equal(readLivenessConfig(root).staleSeconds, 900);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('enabled defaults true when omitted; only explicit false opts out', () => {
    const on = repoWith('artifact_liveness:\n  stale_seconds: 300\n');
    const off = repoWith('artifact_liveness:\n  enabled: false\n');
    try {
      assert.equal(readLivenessConfig(on).enabled, true);
      assert.equal(readLivenessConfig(off).enabled, false);
    } finally { rmSync(on, { recursive: true, force: true }); rmSync(off, { recursive: true, force: true }); }
  });

  test('invalid stale_seconds/debounce fall back to defaults', () => {
    const root = repoWith('artifact_liveness:\n  stale_seconds: 0\n  debounce_seconds: -5\n');
    try {
      const c = readLivenessConfig(root);
      assert.equal(c.staleSeconds, STALE_RUNNING_SECONDS, 'non-positive stale ignored');
      assert.equal(c.debounceSeconds, DEFAULT_DEBOUNCE_SECONDS, 'negative debounce ignored');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('debounce_seconds: 0 is honored (valid — refresh every fire)', () => {
    const root = repoWith('artifact_liveness:\n  debounce_seconds: 0\n');
    try {
      assert.equal(readLivenessConfig(root).debounceSeconds, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('unparseable file → defaults (never throws)', () => {
    const root = repoWith(':\n  : not valid : yaml : @#$\n\t- broken');
    try {
      assert.equal(readLivenessConfig(root).enabled, true);
      assert.equal(readLivenessConfig(root).staleSeconds, STALE_RUNNING_SECONDS);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
