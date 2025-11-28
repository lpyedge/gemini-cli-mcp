process.env.GEMINI_MCP_SKIP_START = '1';
process.env.GEMINI_TASK_CWD = process.env.GEMINI_TASK_CWD || (await import('node:os')).tmpdir();
import { buildSpawnCommand, setGeminiBin } from '../dist/index.js';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { terminateProcessTree } from '../dist/processUtils.js';

(async () => {
  if (process.platform !== 'win32') {
    console.log('skipping on non-windows');
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-test-'));
  console.log('tmp:', tmp);
  try {
    const childJs = path.join(tmp, 'child.js');
    const pidFile = path.join(tmp, 'child.pid');
    await fs.writeFile(childJs, `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`, 'utf8');
    const shim = path.join(tmp, 'shim.cmd');
    const nodeExe = process.execPath;
    const content = `@echo off\nstart "" "${nodeExe}" "${childJs}" %*\n`;
    await fs.writeFile(shim, content, { encoding: 'utf8' });
    fsSync.chmodSync(shim, 0o755);
    setGeminiBin(shim);
    const spawnSpec = buildSpawnCommand([]);
    console.log('spawnSpec:', spawnSpec);
    const child = spawn(spawnSpec.command, spawnSpec.args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    console.log('spawned wrapper pid:', child.pid);
    let pid = null;
    for (let i=0;i<20;i++){
      try { const txt = await fs.readFile(pidFile, 'utf8'); pid = Number(txt.trim()); break;} catch(e){ await new Promise(r=>setTimeout(r,100)); }
    }
    console.log('child pid read:', pid);
    function exists(pidToCheck){ try{ process.kill(pidToCheck,0); return true;}catch(err){ if(err && err.code==='EPERM') return true; return false; } }
    console.log('child exists before:', exists(pid));
    terminateProcessTree(child);
    await new Promise(r=>setTimeout(r,800));
    console.log('child exists after:', exists(pid));
  } finally {
    try{ await fs.rm(tmp, { recursive:true, force:true }); }catch(e){}
  }
})();
