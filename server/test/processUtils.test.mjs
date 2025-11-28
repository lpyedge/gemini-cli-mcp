import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { terminateProcessTree } from '../dist/processUtils.js';

test('terminateProcessTree kills child process', async () => {
  const child = spawn(process.execPath, ['-e', "setTimeout(()=>{},10000)"] , { stdio: 'ignore' });
  // give child a moment to start
  await new Promise((r) => setTimeout(r, 50));
  terminateProcessTree(child);
  // wait up to 2s for exit
  const ok = await new Promise((resolve) => {
    let done = false;
    child.on('close', () => { if (!done) { done = true; resolve(true); } });
    setTimeout(() => { if (!done) { done = true; resolve(false); } }, 2000);
  });
  assert.ok(ok, 'child should exit after terminateProcessTree');
});
