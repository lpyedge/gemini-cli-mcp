import test from 'node:test';
import assert from 'node:assert/strict';
// Ensure a workspace CWD is present when importing the bundled helpers during tests.
import os from 'node:os';
process.env.GEMINI_TASK_CWD = process.env.GEMINI_TASK_CWD || os.tmpdir();
import { buildSpawnCommand, setGeminiBin } from '../../server/src/gemini/spawnHelpers.ts';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { terminateProcessTree } from '../../server/src/gemini/processUtils.ts';

test('runDetachedDebug (windows only)', async (t) => {
  if (process.platform !== 'win32') {
    t.skip();
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-test-'));
  try {
    const childJs = path.join(tmp, 'child.js');
    const pidFile = path.join(tmp, 'child.pid');
    await fs.writeFile(
      childJs,
      `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`,
      'utf8'
    );

    const shim = path.join(tmp, 'shim.cmd');
    const nodeExe = process.execPath;
    const content = `@echo off\nstart "" "${nodeExe}" "${childJs}" %*\n`;
    await fs.writeFile(shim, content, { encoding: 'utf8' });
    fsSync.chmodSync(shim, 0o755);
    setGeminiBin(shim);

    const spawnSpec = buildSpawnCommand([]);
    const child = spawn(spawnSpec.command, spawnSpec.args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    assert.ok(child.pid > 0, 'wrapper should have pid');

    let pid = null;
    for (let i = 0; i < 20; i++) {
      try {
        const txt = await fs.readFile(pidFile, 'utf8');
        pid = Number(txt.trim());
        break;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(typeof pid === 'number' && !Number.isNaN(pid), 'child pid should be read from pid file');

    function exists(pidToCheck) {
      try {
        process.kill(pidToCheck, 0);
        return true;
      } catch (err) {
        if (err && err.code === 'EPERM') return true;
        return false;
      }
    }

    assert.ok(exists(pid), 'child should exist before termination');
    terminateProcessTree(child);
    await new Promise((r) => setTimeout(r, 800));
    const after = exists(pid);
    assert.ok(!after, 'child should not exist after termination');
  } finally {
    try {
      await fs.rm(tmp, { recursive: true, force: true });
    } catch (e) {
      // ignore
    }
  }
});
