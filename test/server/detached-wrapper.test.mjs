import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { terminateProcessTree } from '../../server/src/gemini/processUtils.ts';
// Ensure a workspace CWD is present when importing the bundled module during tests.
process.env.GEMINI_TASK_CWD = process.env.GEMINI_TASK_CWD || os.tmpdir();
import { buildSpawnCommand, setGeminiBin } from '../../server/src/gemini/spawnHelpers.ts';

// This test reproduces a Windows .cmd shim that uses `start` to launch a detached
// node process and then exits immediately. We validate that the server's
// spawn/unwrapping logic runs the underlying node script directly and that
// terminateProcessTree kills the child process.

if (process.platform !== 'win32') {
  test('detached-wrapper (windows-only) - skipped on non-windows', () => {});
} else {
  test('detached-wrapper: unwrap .cmd and terminate child', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-test-'));
    try {
      const childJs = path.join(tmp, 'child.js');
      const pidFile = path.join(tmp, 'child.pid');
      // child.js writes its pid and stays alive
      await fs.writeFile(
        childJs,
        `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`,
        'utf8'
      );

      const shim = path.join(tmp, 'shim.cmd');
      // shim uses start to spawn node detached and then exits immediately
      // Use absolute path to node to avoid PATH issues
      const nodeExe = process.execPath;
      const childJsEscaped = childJs.replace(/"/g, '"');
      const content = `@echo off\nstart "" "${nodeExe}" "${childJs}" %*\n`;
      await fs.writeFile(shim, content, { encoding: 'utf8' });
      fsSync.chmodSync(shim, 0o755);

      // Point the buildSpawnCommand helper at our shim
      setGeminiBin(shim);
      const spawnSpec = buildSpawnCommand([]);

      // spawn via the resolved command (should ideally run node child.js directly)
      const child = spawn(spawnSpec.command, spawnSpec.args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });

      // Wait for pid file to appear
      let pid = null;
      for (let i = 0; i < 20; i++) {
        try {
          const txt = await fs.readFile(pidFile, 'utf8');
          pid = Number(txt.trim());
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert(pid && Number.isFinite(pid), 'child pid was written');

      // helper to check existence
      function exists(pidToCheck) {
        try {
          process.kill(pidToCheck, 0);
          return true;
        } catch (err) {
          if (err && err.code === 'EPERM') return true;
          return false;
        }
      }

      assert(exists(pid), 'child process exists before termination');

      // Now terminate via terminateProcessTree and ensure child is gone
      terminateProcessTree(child);
      // allow a short grace
      await new Promise((r) => setTimeout(r, 800));

      assert(!exists(pid), 'child process no longer exists after termination');

      // ensure spawned wrapper has closed
      // (close event when spawnSpec used cmd.exe might have exited already)

    } finally {
      try {
        await fs.rm(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
}
