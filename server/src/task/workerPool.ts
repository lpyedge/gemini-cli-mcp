import { EventEmitter } from 'node:events';

export type JobHandler = (signal: AbortSignal) => Promise<void>;

interface JobEntry {
    id: number;
    handler: JobHandler;
    controller: AbortController;
    priority: number;
}

export class WorkerPool {
    private readonly concurrency: number;
    private running = 0;
    private queue: JobEntry[] = [];
    private nextId = 0;
    private active = new Map<number, JobEntry>();
    private history = new Map<number, JobEntry>();
    private readonly emitter = new EventEmitter();
    private lock = false; // 防止競態

    constructor(concurrency: number) {
        this.concurrency = Math.max(1, concurrency);
    }

    // Allow external code to subscribe to lifecycle events. We emit 'changed'
    // whenever the running count changes, and 'queue' when the queue length
    // changes (enqueue/cancel).
    on(event: string, cb: () => void) {
        this.emitter.on(event as any, cb);
    }

    enqueue(handler: JobHandler, priority = 0) {
        return this.enqueueWithDelay(handler, priority, 0, undefined);
    }

    enqueueWithDelay(handler: JobHandler, priority = 0, delayMs = 0, scheduleAt?: number) {
        const entry = {
            id: ++this.nextId,
            handler,
            controller: new AbortController(),
            priority
        };
        const enqueueAction = () => {
            this.queue.push(entry);
            this.queue.sort((a, b) => {
                if (b.priority === a.priority) {
                    return a.id - b.id;
                }
                return b.priority - a.priority;
            });
            this.emitter.emit('queue');
            this.pump();
        };
        if (scheduleAt && scheduleAt > Date.now()) {
            setTimeout(enqueueAction, scheduleAt - Date.now());
        } else if (delayMs > 0) {
            setTimeout(enqueueAction, delayMs);
        } else {
            enqueueAction();
        }
        return entry.id;
    }

    cancel(jobId: number) {
        let found = false;
        for (const entry of this.queue) {
            if (entry.id === jobId) {
                entry.controller.abort();
                // move cancelled entry into history so it can be retried later
                this.history.set(entry.id, entry);
                this.queue = this.queue.filter(item => item.id !== jobId);
                this.emitter.emit('queue');
                found = true;
                break;
            }
        }
        if (!found) {
            const running = this.active.get(jobId);
            if (running) {
                running.controller.abort();
                // keep a record so retry() can locate it after it finishes
                this.history.set(jobId, running);
                found = true;
            }
        }
        this.emitter.emit('changed');
        return found ? true : false;
    }

    cancelAll() {
        for (const entry of this.queue) {
            entry.controller.abort();
        }
        for (const entry of this.active.values()) {
            entry.controller.abort();
        }
        this.queue = [];
        this.active.clear();
        this.emitter.emit('queue');
        this.emitter.emit('changed');
    }

    queuedCount() {
        return this.queue.length;
    }

    runningCount() {
        return this.running;
    }

    private pump() {
        if (this.lock) return;
        this.lock = true;
        try {
            while (this.running < this.concurrency && this.queue.length > 0) {
                const entry = this.queue.shift();
                if (!entry) {
                    continue;
                }
                // Skip entries that were aborted while still in the queue so我們不會啟動
                if (entry.controller.signal.aborted) {
                    continue;
                }
                this.running += 1;
                this.emitter.emit('changed');
                this.active.set(entry.id, entry);
                entry.handler(entry.controller.signal)
                    .catch((error) => {
                        console.error(`WorkerPool job ${entry.id} failed`, error);
                    })
                    .finally(() => {
                        this.active.delete(entry.id);
                            // record finished job so retry can reference it later
                            this.history.set(entry.id, entry);
                        this.running -= 1;
                        this.emitter.emit('changed');
                        this.pump();
                    });
            }
        } finally {
            this.lock = false;
        }
    }

    /**
     * 重試指定 jobId（僅限已取消/失敗/完成的任務）
     */
    retry(jobId: number): number | undefined {
        const old = this.active.get(jobId) || this.queue.find(e => e.id === jobId) || this.history.get(jobId);
        if (!old) return undefined;
        // Allow retry for cancelled/finished/failed tasks. If the controller is aborted
        // the job was cancelled; otherwise allow retry if it's not currently active or queued.
        const isQueued = this.queue.some(e => e.id === jobId);
        const isActive = this.active.has(jobId);
        if (!(old.controller.signal.aborted || (!isActive && !isQueued))) return undefined;
        return this.enqueueWithDelay(old.handler, old.priority);
    }
}
