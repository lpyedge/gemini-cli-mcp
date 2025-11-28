import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { createPersistenceManager } from '../dist/task/persistenceManager.js';
import { WorkerPool } from '../dist/workerPool.js';

import { readStatusFile, waitForTaskCompletion, waitForStatusFileExists } from './helpers/testHelpers.mjs';

const tmpRoot = path.join('test-temp', 'status-tests');

test.before(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(tmpRoot, { recursive: true });
});

test('task completes -> status.json shows succeeded and running becomes 0', async () => {
  const tasks = new Map();
  const taskEvents = new EventEmitter();
  const pool = new WorkerPool(1);
  const stateFile = path.join(tmpRoot, 'tasks1.json');
  const statusFile = path.join(tmpRoot, 'status1.json');

  const persistence = createPersistenceManager({
    tasks,
    taskEvents,
    stateFile,
    statusFile,
    logDir: path.join(tmpRoot, 'logs'),
    retentionMs: 1000 * 60 * 60,
    PERSIST_DEBOUNCE_MS: 10,
    LIVE_STATUS_LIMIT: 50,
    pool,
    workerCount: 1
  });

  // create queued task
  const id = 't-complete-1';
  const now = Date.now();
  const t = {
    id,
    toolName: 'tests.run',
    args: {},
    cmd: ['echo'],
    cwd: process.cwd(),
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    logLength: 0,
    logFile: path.join(tmpRoot, `${id}.log`)
  };
  tasks.set(id, t);
  taskEvents.emit('update', t);
  // persist queued state
  await persistence.persistLiveStatus();
  let payload = await readStatusFile(statusFile);
  assert.equal(payload.queued, 1);
  assert.equal(payload.running, 0);

  // mark running
  t.status = 'running';
  t.startedAt = Date.now();
  t.updatedAt = Date.now();
  taskEvents.emit('update', t);
  await persistence.persistLiveStatus();
  payload = await readStatusFile(statusFile);
  assert.equal(payload.running, 1);

  // mark succeeded
  t.status = 'succeeded';
  t.completedAt = Date.now();
  t.updatedAt = Date.now();
  taskEvents.emit('update', t);
  await persistence.persistLiveStatus();

  payload = await readStatusFile(statusFile);
  assert.equal(payload.running, 0, 'running should be 0 after completion');
  const rec = payload.tasks.find((x) => x.id === id);
  assert.ok(rec, 'task present in snapshot');
  assert.equal(rec.status, 'succeeded');
});

test('concurrent tasks snapshot correctness', async () => {
  const tasks = new Map();
  const taskEvents = new EventEmitter();
  const pool = new WorkerPool(2);
  const stateFile = path.join(tmpRoot, 'tasks2.json');
  const statusFile = path.join(tmpRoot, 'status2.json');

  const persistence = createPersistenceManager({
    tasks,
    taskEvents,
    stateFile,
    statusFile,
    logDir: path.join(tmpRoot, 'logs2'),
    retentionMs: 1000 * 60 * 60,
    PERSIST_DEBOUNCE_MS: 10,
    LIVE_STATUS_LIMIT: 50,
    pool,
    workerCount: 2
  });

  // create 3 tasks: 2 running, 1 queued
  for (let i = 0; i < 3; i++) {
    const id = `con-${i}`;
    const now = Date.now();
    const t = {
      id,
      toolName: 'tests.run',
      args: {},
      cmd: ['echo'],
      cwd: process.cwd(),
      status: i < 2 ? 'running' : 'queued',
      createdAt: now,
      updatedAt: now,
      logLength: 0,
      logFile: path.join(tmpRoot, `${id}.log`)
    };
    tasks.set(id, t);
    taskEvents.emit('update', t);
  }

  await persistence.persistLiveStatus();
  const payload = await readStatusFile(statusFile);
  assert.equal(payload.running, 2);
  assert.equal(payload.queued, 1);
  assert.equal(payload.tasks.length >= 3, true);
});

test('cancel/failed state persisted correctly', async () => {
  const tasks = new Map();
  const taskEvents = new EventEmitter();
  const pool = new WorkerPool(1);
  const stateFile = path.join(tmpRoot, 'tasks3.json');
  const statusFile = path.join(tmpRoot, 'status3.json');

  const persistence = createPersistenceManager({
    tasks,
    taskEvents,
    stateFile,
    statusFile,
    logDir: path.join(tmpRoot, 'logs3'),
    retentionMs: 1000 * 60 * 60,
    PERSIST_DEBOUNCE_MS: 10,
    LIVE_STATUS_LIMIT: 50,
    pool,
    workerCount: 1
  });

  const id = 't-cancel-1';
  const now = Date.now();
  const t = {
    id,
    toolName: 'tests.run',
    args: {},
    cmd: ['badcmd'],
    cwd: process.cwd(),
    status: 'running',
    createdAt: now,
    updatedAt: now,
    logLength: 0,
    logFile: path.join(tmpRoot, `${id}.log`)
  };
  tasks.set(id, t);
  taskEvents.emit('update', t);
  await persistence.persistLiveStatus();

  // simulate cancellation
  t.status = 'canceled';
  t.updatedAt = Date.now();
  t.completedAt = Date.now();
  taskEvents.emit('update', t);
  await persistence.persistLiveStatus();
  let payload = await readStatusFile(statusFile);
  let rec = payload.tasks.find((x) => x.id === id);
  assert.ok(rec, 'task present');
  assert.equal(rec.status, 'canceled');

  // simulate failure with error message
  const id2 = 't-fail-1';
  const t2 = {
    id: id2,
    toolName: 'tests.run',
    args: {},
    cmd: ['badcmd'],
    cwd: process.cwd(),
    status: 'failed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: Date.now(),
    logLength: 0,
    error: 'spawn ENOENT',
    logFile: path.join(tmpRoot, `${id2}.log`)
  };
  tasks.set(id2, t2);
  taskEvents.emit('update', t2);
  await persistence.persistLiveStatus();
  payload = await readStatusFile(statusFile);
  rec = payload.tasks.find((x) => x.id === id2);
  assert.ok(rec && rec.status === 'failed' && rec.error, 'failed task persisted with error');
});
