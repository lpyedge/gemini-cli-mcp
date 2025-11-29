#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve('.', '.');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) {
    console.error('Failed to run', cmd, args, r.error);
    process.exit(1);
  }
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

console.log('Running server build and tests (server) with GEMINI_MCP_SKIP_START=1');
const serverEnv = { ...process.env, GEMINI_MCP_SKIP_START: '1' };
// Run TypeScript compiler for server directly to avoid relying on 'npm' in PATH
const tscJs = path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
if (tscJs) {
  run(process.execPath, [tscJs, '-p', 'server'], { env: serverEnv, cwd: repoRoot });
} else {
  // fallback: try .bin/tsc
  const tscBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  run(tscBin, ['-p', 'server'], { env: serverEnv, cwd: repoRoot });
}
run(process.execPath, ['-r', './test/setup-vscode-mock.cjs', '--test', 'server'], { env: serverEnv, cwd: repoRoot });

console.log('Running root tests');
// Run root tests (tests under ./test)
run(process.execPath, ['-r', './test/setup-vscode-mock.cjs', '--test'], { env: process.env, cwd: repoRoot });
// Also explicitly run the modelbridge sdk id integration test to ensure
// the test is executed across CI or environments where discovery may differ.
run(process.execPath, ['-r', './test/setup-vscode-mock.cjs', '--test', 'test/modelbridge-sdkid.test.mjs'], { env: process.env, cwd: repoRoot });

console.log('All tests passed.');
