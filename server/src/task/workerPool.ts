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
    private readonly emitter = new EventEmitter();

    constructor(concurrency: number) {
        this.concurrency = Math.max(1, concurrency);
    }

    // Allow external code to subscribe to lifecycle events. We emit 'changed'
    // whenever the running count changes, and 'queue' when the queue length
    // changes (enqueue/cancel).
    on(event: string, cb: () => void) {
        this.emitter.on(event as any, cb);
    }

    enqueue(handler: JobHandler, priority = 0): number {
        const entry: JobEntry = {
            id: ++this.nextId,
            handler,
            controller: new AbortController(),
            priority
        };
        this.queue.push(entry);
        this.queue.sort((a, b) => {
            if (b.priority === a.priority) {
                return a.id - b.id;
            }
            return b.priority - a.priority;
        });
        this.emitter.emit('queue');
        this.pump();
        return entry.id;
    }

    cancel(jobId: number) {
        for (const entry of this.queue) {
            if (entry.id === jobId) {
                entry.controller.abort();
                this.queue = this.queue.filter(item => item.id !== jobId);
                this.emitter.emit('queue');
                return;
            }
        }
        const running = this.active.get(jobId);
        running?.controller.abort();
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
        while (this.running < this.concurrency && this.queue.length > 0) {
            const entry = this.queue.shift();
            if (!entry) {
                continue;
            }
            // Skip entries that were aborted while still in the queue so we don't
            // count them as running or start their handler.
            if (entry.controller.signal.aborted) {
                // ensure it's not left referenced anywhere and continue pumping
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
                    this.running -= 1;
                    this.emitter.emit('changed');
                    this.pump();
                });
        }
    }
}
