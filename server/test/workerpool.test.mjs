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

  test('retry canceled job works', async () => {
    const pool = new WorkerPool(1);
    let ran = 0;
    const longJob = async (signal) => {
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          ran += 1;
          resolve();
        }, 100);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      });
    };
    const jobId = pool.enqueue(longJob);
    pool.cancel(jobId);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ran, 0, 'job not run after cancel');
    const retryId = pool.retry(jobId);
    assert.ok(retryId, 'retry returns new jobId');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(ran, 1, 'job ran after retry');
  });

  test('enqueue with delay works', async () => {
    const pool = new WorkerPool(1);
    let ran = 0;
    const job = async (signal) => {
      return new Promise((resolve) => {
        setTimeout(() => {
          ran += 1;
          resolve();
        }, 50);
      });
    };
    pool.enqueueWithDelay(job, 0, 100);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ran, 0, 'job not run before delay');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ran, 1, 'job ran after delay');
  });

  test('cancel returns correct status', async () => {
    const pool = new WorkerPool(1);
    let ran = 0;
    const job = async (signal) => {
      return new Promise((resolve) => {
        setTimeout(() => {
          ran += 1;
          resolve();
        }, 50);
      });
    };
    const jobId = pool.enqueue(job);
    const result = pool.cancel(jobId);
    assert.equal(result, true, 'cancel returns true for valid job');
    const result2 = pool.cancel(9999);
    assert.equal(result2, false, 'cancel returns false for invalid job');
  });
