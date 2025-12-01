import fs from 'node:fs';
import path from 'node:path';

function removeExcept(dir, keepNames = []) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const keep = keepNames.includes(name);
    if (keep) continue;
    try {
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
      } else {
        fs.unlinkSync(full);
      }
    } catch (e) {
      // best-effort
      console.error('clean-dist: failed to remove', full, e?.message ?? e);
    }
  }
}

// Keep these files in root dist
const distDir = path.join(process.cwd(), 'dist');
const keepDist = [];
// Also remove the extension/ directory entirely
if (fs.existsSync(distDir)) {
  for (const name of fs.readdirSync(distDir)) {
    if (keepDist.includes(name)) continue;
    const full = path.join(distDir, name);
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch (e) {
      console.error('clean-dist: failed to remove', full, e?.message ?? e);
    }
  }
}

// server/dist: remove everything so the bundle step can recreate it
const serverDist = path.join(process.cwd(), 'server', 'dist');
const keepServer = [];
removeExcept(serverDist, keepServer);

console.log('clean-dist: completed');
