import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskRecord } from './types.js';
import { persistTasksToFile, loadPersistedTasksFromFile } from './persistence.js';

export type PersistenceManager = {
    persistTasks: () => Promise<void>;
    schedulePersist: () => void;
    scheduleStatusSnapshot: () => void;
    persistLiveStatus: () => Promise<void>;
    flushPendingPersistence: () => Promise<void>;
    buildLiveStatusPayload: () => Record<string, unknown>;
    loadPersistedTasks: () => Promise<void>;
    pruneOldTasks: (olderThanMs?: number) => Promise<{ removedTasks: number; removedLogs: number; cutoff: number }>;
};

export function createPersistenceManager(options: {
    tasks: Map<string, TaskRecord>;
    taskEvents: { on: (ev: string, cb: () => void) => void };
    stateFile: string;
    statusFile: string;
    logDir: string;
    retentionMs: number;
    PERSIST_DEBOUNCE_MS: number;
    LIVE_STATUS_LIMIT: number;
    pool: { runningCount: () => number; queuedCount: () => number; on?: (ev: string, cb: () => void) => void };
    workerCount: number;
    // optional provider for CLI status snapshot
    getCliStatus?: () => unknown;
    // optional queue limit to report in live status
    queueLimit?: number;
}) {
    const { tasks, taskEvents, stateFile, statusFile, logDir, retentionMs, PERSIST_DEBOUNCE_MS, LIVE_STATUS_LIMIT, pool, workerCount, getCliStatus, queueLimit } = options;

    let persistTimer: NodeJS.Timeout | undefined;
    let statusPersistTimer: NodeJS.Timeout | undefined;

    async function persistTasks() {
        try {
            console.log(`[persistence] Persisting ${tasks.size} tasks to ${stateFile}`);
            await persistTasksToFile(stateFile, tasks);
            console.log('[persistence] Persisted tasks successfully');
        } catch (error) {
            console.error('[persistence] Failed to persist tasks', error);
            throw error;
        }
    }

    function schedulePersist() {
        if (persistTimer) {
            clearTimeout(persistTimer);
        }
        persistTimer = setTimeout(() => {
            persistTimer = undefined;
            persistTasks().catch((error) => console.error('Failed to persist Gemini CLI MCP task state', error));
        }, PERSIST_DEBOUNCE_MS);
    }

    function scheduleStatusSnapshot() {
        if (statusPersistTimer) {
            clearTimeout(statusPersistTimer);
        }
        statusPersistTimer = setTimeout(() => {
            statusPersistTimer = undefined;
            persistLiveStatus().catch((error) => console.error('Failed to persist Gemini CLI MCP live status', error));
        }, PERSIST_DEBOUNCE_MS);
    }

    async function persistLiveStatus() {
        try {
            await fs.mkdir(path.dirname(statusFile), { recursive: true });
            const payload = buildLiveStatusPayload();
            console.log(`[persistence] Writing live status (running=${payload.running}, queued=${payload.queued}) to ${statusFile}`);
            await fs.writeFile(statusFile, JSON.stringify(payload, null, 2), 'utf8');
            console.log('[persistence] Wrote live status successfully');
        } catch (error) {
            console.error('[persistence] Failed to write live status', error);
            throw error;
        }
    }

    async function flushPendingPersistence() {
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = undefined;
            await persistTasks();
        }
        if (statusPersistTimer) {
            clearTimeout(statusPersistTimer);
            statusPersistTimer = undefined;
            await persistLiveStatus();
        }
    }

    function buildLiveStatusPayload() {
        const snapshotTasks = Array.from(tasks.values())
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, LIVE_STATUS_LIMIT)
            .map((task) => ({
                id: task.id,
                toolName: task.toolName,
                status: task.status,
                createdAt: task.createdAt,
                startedAt: task.startedAt,
                updatedAt: task.updatedAt,
                completedAt: task.completedAt,
                exitCode: task.exitCode,
                lastLogLine: task.lastLogLine,
                logLength: task.logLength,
                error: task.error,
                priority: task.priority
            }));

        // Derive authoritative running/queued counts from task records to avoid
        // races where the worker pool's internal counters may lag.
        const runningCount = Array.from(tasks.values()).filter((t) => t.status === 'running').length;
        const queuedCount = Array.from(tasks.values()).filter((t) => t.status === 'queued').length;

        return {
            updatedAt: Date.now(),
            running: runningCount,
            queued: queuedCount,
            maxWorkers: workerCount,
            queueLimit: typeof queueLimit === 'number' ? queueLimit : 0,
            cliStatus: typeof getCliStatus === 'function' ? getCliStatus() : undefined,
            tasks: snapshotTasks
        };
    }

    async function loadPersistedTasks() {
        await loadPersistedTasksFromFile(stateFile, logDir, tasks, (p) => p, async (p) => {
            try {
                await fs.access(p);
                return true;
            } catch {
                return false;
            }
        });
    }

    async function pruneOldTasks(olderThanMs = retentionMs) {
        const cutoff = Date.now() - olderThanMs;
        let removedTasks = 0;
        let removedLogs = 0;
        for (const [id, task] of Array.from(tasks.entries())) {
            if ((['succeeded', 'failed', 'canceled'] as const).includes(task.status as any) && task.updatedAt < cutoff) {
                tasks.delete(id);
                removedTasks += 1;
                try {
                    await fs.rm(task.logFile, { force: true });
                    removedLogs += 1;
                } catch {
                    // ignore
                }
            }
        }
        if (removedTasks > 0) {
            schedulePersist();
            scheduleStatusSnapshot();
        }
        return { removedTasks, removedLogs, cutoff };
    }

    // wire task-events to status snapshot
    taskEvents.on('update', () => scheduleStatusSnapshot());

    // If the worker pool exposes lifecycle events, subscribe so we can
    // persist status immediately after the pool's running count changes.
    try {
        if (typeof pool.on === 'function') {
            pool.on('changed', () => {
                try {
                    scheduleStatusSnapshot();
                    void persistLiveStatus().catch((err) => console.error('[persistence] Failed to persist live status (pool change)', err));
                } catch (err) {
                    console.error('[persistence] Error handling pool change event', err);
                }
            });
            pool.on('queue', () => {
                try {
                    scheduleStatusSnapshot();
                } catch (err) {
                    console.error('[persistence] Error handling pool queue event', err);
                }
            });
        }
    } catch {
        // best-effort: ignore subscription failures
    }

    return {
        persistTasks,
        schedulePersist,
        scheduleStatusSnapshot,
        persistLiveStatus,
        flushPendingPersistence,
        buildLiveStatusPayload,
        loadPersistedTasks,
        pruneOldTasks
    } as PersistenceManager;
}
