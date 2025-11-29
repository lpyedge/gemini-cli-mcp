import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { persistTasksToFile, loadPersistedTasksFromFile } from '../../server/src/task/persistence.ts';

const tmpDir = path.join('test-temp');

test('persistTasksToFile writes tasks without log array', async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  const stateFile = path.join(tmpDir, 'tasks.json');
  const tasks = new Map();
  tasks.set('t1', {
    id: 't1',
    toolName: 'tests.run',
    args: {},
    cmd: ['echo'],
    cwd: process.cwd(),
    status: 'succeeded',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    logLength: 0,
    logFile: path.join(tmpDir, 't1.log'),
    log: ['line1']
  });

  await persistTasksToFile(stateFile, tasks);
  const raw = await fs.readFile(stateFile, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed[0].id, 't1');
  assert.equal(parsed[0].log, undefined);
});

test('loadPersistedTasksFromFile restores tasks and writes log file', async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  const stateFile = path.join(tmpDir, 'tasks-load.json');
  const payload = [
    {
      id: 'x1',
      toolName: 'code.analyze',
      args: {},
      cmd: ['code'],
      cwd: process.cwd(),
      status: 'succeeded',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      logLength: 0,
      logFile: path.join(tmpDir, 'x1.log'),
      log: ['hello']
    }
  ];
  await fs.writeFile(stateFile, JSON.stringify(payload, null, 2), 'utf8');

  const tasks = new Map();
  await loadPersistedTasksFromFile(stateFile, tmpDir, tasks, (cwd) => cwd || process.cwd(), async (p) => {
    try { await fs.access(p); return true; } catch { return false; }
  });

  assert.equal(tasks.has('x1'), true);
  const rec = tasks.get('x1');
  const exists = await fs.stat(rec.logFile).then(() => true).catch(() => false);
  assert.ok(exists, 'log file should have been written');
});
