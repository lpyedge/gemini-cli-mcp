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
    pool: { runningCount: () => number; queuedCount: () => number };
    workerCount: number;
}) {
    const { tasks, taskEvents, stateFile, statusFile, logDir, retentionMs, PERSIST_DEBOUNCE_MS, LIVE_STATUS_LIMIT, pool, workerCount } = options;

    let persistTimer: NodeJS.Timeout | undefined;
    let statusPersistTimer: NodeJS.Timeout | undefined;

    async function persistTasks() {
        await persistTasksToFile(stateFile, tasks);
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
        await fs.mkdir(path.dirname(statusFile), { recursive: true });
        const payload = buildLiveStatusPayload();
        await fs.writeFile(statusFile, JSON.stringify(payload, null, 2), 'utf8');
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
                lastLogLine: task.lastLogLine,
                priority: task.priority
            }));
        return {
            updatedAt: Date.now(),
            running: pool.runningCount(),
            queued: pool.queuedCount(),
            maxWorkers: workerCount,
            queueLimit: 0,
            cliStatus: undefined,
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
