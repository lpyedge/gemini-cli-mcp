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

    constructor(concurrency: number) {
        this.concurrency = Math.max(1, concurrency);
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
        this.pump();
        return entry.id;
    }

    cancel(jobId: number) {
        for (const entry of this.queue) {
            if (entry.id === jobId) {
                entry.controller.abort();
                this.queue = this.queue.filter(item => item.id !== jobId);
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
            this.active.set(entry.id, entry);
            entry.handler(entry.controller.signal)
                .catch((error) => {
                    console.error(`WorkerPool job ${entry.id} failed`, error);
                })
                .finally(() => {
                    this.active.delete(entry.id);
                    this.running -= 1;
                    this.pump();
                });
        }
    }
}
