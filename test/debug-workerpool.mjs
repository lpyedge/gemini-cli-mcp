import { WorkerPool } from '../server/src/task/workerPool.ts';

(async () => {
  const pool = new WorkerPool(1);
  let ran = 0;
  const job = async (signal) => {
    console.log('handler invoked');
    return new Promise((resolve) => {
      setTimeout(() => {
        ran += 1;
        console.log('handler done, ran=', ran);
        resolve();
      }, 50);
    });
  };
  console.log('scheduling at', Date.now());
  pool.enqueueWithDelay(job, 0, 100);
  setTimeout(() => console.log('after 50ms, ran=', ran, 'time=', Date.now()), 50);
  setTimeout(() => console.log('after 150ms, ran=', ran, 'time=', Date.now()), 150);
  // Give enough time for the pool to finish
  setTimeout(() => { console.log('final ran=', ran); process.exit(0); }, 400);
})();
