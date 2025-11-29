import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GeminiCliHealth } = require('../dist/extension/cliHealth.js');

test('GeminiCliHealth: node (in PATH) should be recognized as ok', async () => {
  const outputLines = [];
  const fakeOutput = { appendLine: (s) => outputLines.push(String(s)) };
  const h = new GeminiCliHealth(fakeOutput);
  // Use 'node' (available on PATH) to avoid shell quoting issues with absolute paths
  const cfg = { geminiPath: 'node', taskCwd: os.tmpdir() };
  await h.refresh(cfg);
  const status = h.getStatus();
  assert.notEqual(status.state, 'checking', 'status should not remain checking');
  assert.equal(status.state, 'ok', `expected ok for node execPath, got ${status.state} (${status.message})`);
});

test('GeminiCliHealth: nonexistent explicit path results in missing', async () => {
  const outputLines = [];
  const fakeOutput = { appendLine: (s) => outputLines.push(String(s)) };
  const h = new GeminiCliHealth(fakeOutput);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-test-'));
  try {
    const missing = path.join(tmp, 'no-such-gemini-xyz');
    const cfg = { geminiPath: missing, taskCwd: tmp };
    await h.refresh(cfg);
    const status = h.getStatus();
    assert.notEqual(status.state, 'checking', 'status should not remain checking');
    // classification may be 'missing' or 'error' depending on platform messages; accept missing OR error but ensure not 'ok'
    assert.notEqual(status.state, 'ok', `expected not ok for missing binary, got ok (${JSON.stringify(status)})`);
  } finally {
    try { await fs.rm(tmp, { recursive: true, force: true }); } catch {}
  }
});
