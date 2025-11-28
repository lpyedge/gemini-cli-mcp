import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerPool } from '../dist/workerPool.js';

test('cancel queued job does not start and running count stable', async () => {
  const pool = new WorkerPool(1);
  let ran = 0;

  const longJob = async (signal) => {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        ran += 1;
        resolve();
      }, 200);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });
  };

  const job1 = pool.enqueue(longJob);
  const job2 = pool.enqueue(longJob);
  // cancel the queued job (job2) while job1 runs
  pool.cancel(job2);

  // wait for job1 to finish
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(pool.runningCount(), 0, 'no running jobs after completion');
  assert.equal(pool.queuedCount(), 0, 'no queued jobs remain');
  assert.equal(ran, 1, 'only first job executed');
});
