import fs from 'node:fs/promises';
import path from 'node:path';

export async function readStatusFile(statusFile) {
  try {
    const raw = await fs.readFile(statusFile, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return undefined;
  }
}

export async function waitForTaskCompletion(statusFile, taskId, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const payload = await readStatusFile(statusFile);
    if (payload && Array.isArray(payload.tasks)) {
      const t = payload.tasks.find((x) => x.id === taskId);
      if (t && ['succeeded', 'failed', 'canceled'].includes(t.status)) {
        return t;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for task ${taskId} completion`);
}

export async function waitForStatusFileExists(statusFile, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.access(statusFile);
      return true;
    } catch {
      // continue
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
