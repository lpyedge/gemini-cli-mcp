import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { jsonSchemaToZod, dereferenceSchema } from '../lib/schemaUtils.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WorkerPool } from '../task/workerPool.js';
import { terminateProcessTree, execGeminiCommand } from '../gemini/processUtils.js';
import { buildSpawnCommand, setGeminiBin, geminiBin } from '../gemini/spawnHelpers.js';
import { SILENT_EXEC_PROMPT, serializeErrorForClient, formatWorkspaceError, normalizeForComparison, resolveWorkspaceRoot, readTimeoutEnv } from '../core/utils.js';
import { createPersistenceManager } from '../task/persistenceManager.js';
import { logger } from '../core/logger.js';
export { buildSpawnCommand, setGeminiBin } from '../gemini/spawnHelpers.js';
import { TaskRecord, TaskStatus } from '../task/types.js';

// geminiBin and related helpers are provided by server/src/gemini/spawnHelpers.ts
const workerCount = Number(process.env.GEMINI_MAX_WORKERS || '3');
let rawWorkspaceRootEnv = (process.env.GEMINI_TASK_CWD ?? '').trim();
if (!rawWorkspaceRootEnv) {
    if (!process.env.GEMINI_MCP_SKIP_START) {
        logger.error('server: GEMINI_TASK_CWD must be defined before startup');
        process.exit(1);
    }
    // When running tests we allow skipping the startup checks; use temp dir as workspaceRoot.
    rawWorkspaceRootEnv = os.tmpdir();
}
const workspaceRoot = resolveWorkspaceRoot(rawWorkspaceRootEnv);
const stateDir = path.join(workspaceRoot, '.vscode', 'gemini-mcp');
const logDir = path.join(stateDir, 'logs');
const stateFile = path.join(stateDir, 'tasks.json');
const statusFile = path.join(stateDir, 'status.json');
const lockFile = path.join(stateDir, 'server.lock');
let lockHeld = false;
const maxQueueSize = Math.max(1, Number(process.env.GEMINI_MAX_QUEUE || '200'));
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const workspaceRootFingerprint = normalizeForComparison(workspaceRoot);
const workspaceRootPrefix = workspaceRootFingerprint.endsWith(path.sep)
    ? workspaceRootFingerprint
    : workspaceRootFingerprint + path.sep;
const completedStatuses: TaskStatus[] = ['succeeded', 'failed', 'canceled'];
const PERSIST_DEBOUNCE_MS = 250;
const MAX_TAIL_CHUNK = 128 * 1024;
const LIVE_STATUS_LIMIT = 200;
let persistTimer: NodeJS.Timeout | undefined;
let statusPersistTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
type CliHealthState = 'unknown' | 'ok' | 'missing' | 'quota_exhausted' | 'unresponsive' | 'error';
interface CliStatusSnapshot {
    state: CliHealthState;
    message: string;
    lastChecked: number;
    version?: string;
}
let cliStatus: CliStatusSnapshot = {
    state: 'unknown',
    message: 'Gemini CLI health check pending.',
    lastChecked: Date.now()
};
let cliCheckPromise: Promise<void> | undefined;
let acceptingTasks = false;
const allowedCwdRoots = [workspaceRoot, os.tmpdir(), os.homedir()].map((p) => path.normalize(p));
const manifestToolTimeoutMs = readTimeoutEnv('GEMINI_TIMEOUT_MANIFEST', 120000);

const tasks = new Map<string, TaskRecord>();
const taskEvents = new EventEmitter();
const pool = new WorkerPool(workerCount);
// Try to reuse a persisted gemini CLI path if the extension previously stored it
try {
    const persisted = fsSync.readFileSync(statusFile, 'utf8');
    if (persisted) {
        try {
            const parsed = JSON.parse(persisted);
            const persistedGemini = parsed && (parsed.geminiPath || parsed.gemini || parsed.cliPath);
            if (persistedGemini && String(persistedGemini).trim().length > 0) {
                try {
                    setGeminiBin(String(persistedGemini));
                    logger.info('server: using persisted gemini path from status.json', {
                        geminiPath: String(persistedGemini)
                    });
                } catch (e) {
                    logger.warn('server: failed to apply persisted gemini path', String(e));
                }
            }
        } catch {
            // ignore malformed status file
        }
    }
} catch {
    // statusFile may not exist yet; ignore
}

const persistence = createPersistenceManager({
    tasks,
    taskEvents,
    stateFile,
    statusFile,
    logDir,
    retentionMs,
    PERSIST_DEBOUNCE_MS,
    LIVE_STATUS_LIMIT,
    pool,
    workerCount,
    getCliStatus: () => cliStatus,
    queueLimit: maxQueueSize
});

const server = new McpServer({
    name: 'gemini-cli-mcp',
    version: '0.2.0'
});

// Build and send a live status snapshot to connected MCP clients (extension).
async function broadcastStatusSnapshot() {
    try {
        const payload = persistence.buildLiveStatusPayload();
        // Prefer high-level send APIs if available, otherwise send raw JSON-RPC notification.
        try {
            const anyServer: any = server as any;
            if (typeof anyServer.sendNotification === 'function') {
                anyServer.sendNotification('gemini/statusSnapshot', payload);
                return;
            }
            if (typeof anyServer.notification === 'function') {
                // some implementations expose notification helper
                anyServer.notification({ method: 'gemini/statusSnapshot', params: payload });
                return;
            }
            // Fallback: use transport.send if available
            const transport = (anyServer as any)._transport;
            if (transport && typeof transport.send === 'function') {
                // send a JSON-RPC notification
                void transport.send({ jsonrpc: '2.0', method: 'gemini/statusSnapshot', params: payload }).catch(() => {});
            }
        } catch {
            // ignore errors when attempting to send
        }
    } catch (err) {
        try { logger.warn('server: failed to build status snapshot', String(err)); } catch {}
    }
}

// Subscribe to task and pool events to propagate live status snapshots to clients.
try {
    taskEvents.on('update', () => {
        try {
            void persistence.persistLiveStatus().then(() => broadcastStatusSnapshot()).catch(() => {});
        } catch {}
    });
    if (typeof pool.on === 'function') {
        pool.on('changed', () => {
            try {
                void persistence.persistLiveStatus().then(() => broadcastStatusSnapshot()).catch(() => {});
            } catch {}
        });
        pool.on('queue', () => {
            try {
                void persistence.persistLiveStatus().then(() => broadcastStatusSnapshot()).catch(() => {});
            } catch {}
        });
    }
} catch {
    // best-effort: do not crash if subscriptions fail
}

const manifestSchema = z
    .object({
        version: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        tools: z
            .array(
                z
                    .object({
                        name: z.string().trim().min(1, 'Tool name is required'),
                        title: z.string().optional(),
                        description: z.string().optional(),
                        arguments: z.unknown().optional(),
                        returns: z.unknown().optional(),
                        metadata: z.record(z.unknown()).optional()
                    })
                    .passthrough()
            )
            .optional(),
        resources: z.array(z.unknown()).optional()
    })
    .passthrough();

const logTemplate = new ResourceTemplate('tasks://{id}/log', {
    list: async () => ({
        resources: Array.from(tasks.values()).map((task) => ({
            uri: `tasks://${task.id}/log`,
            name: `Task ${task.id} log`,
            description: `Output stream for ${task.toolName}`,
            mimeType: 'text/plain'
        }))
    }),
    complete: {
        id: async (value) =>
            Array.from(tasks.keys()).filter((taskId) => taskId.startsWith(value ?? '')).slice(0, 25)
    }
});

const summaryTemplate = new ResourceTemplate('tasks://{id}/summary', {
    list: async () => ({
        resources: Array.from(tasks.values()).map((task) => ({
            uri: `tasks://${task.id}/summary`,
            name: `Task ${task.id} summary`,
            description: `Summary for ${task.toolName}`,
            mimeType: 'application/json'
        }))
    }),
    complete: {
        id: async (value) =>
            Array.from(tasks.keys()).filter((taskId) => taskId.startsWith(value ?? '')).slice(0, 25)
    }
});

server.registerResource(
    'task-log',
    logTemplate,
    {
        title: 'Gemini task log',
        description: 'Streaming stdout/stderr for a Gemini CLI task.',
        mimeType: 'text/plain'
    },
    async (_uri, variables) => {
        const id = normalizeTemplateVariable(variables.id);
        if (!id) {
            return readResourceText('Invalid task id.');
        }
        const task = tasks.get(id);
        if (!task) {
            return readResourceText(`Task ${id} not found.`);
        }
        const logText = await readTaskLog(task);
        return readResourceText(logText, id);
    }
);

server.registerResource(
    'task-summary',
    summaryTemplate,
    {
        title: 'Gemini task summary',
        description: 'Metadata for a Gemini CLI task.',
        mimeType: 'application/json'
    },
    async (_uri, variables) => {
        const id = normalizeTemplateVariable(variables.id);
        if (!id) {
            return readResourceText('Invalid task id.');
        }
        const task = tasks.get(id);
        if (!task) {
            return readResourceText(`Task ${id} not found.`);
        }
        await updateLogLength(task);
        const summary = {
            id: task.id,
            toolName: task.toolName,
            status: task.status,
            createdAt: task.createdAt,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            updatedAt: task.updatedAt,
            exitCode: task.exitCode,
            timeoutMs: task.timeoutMs,
            logUri: `tasks://${task.id}/log`,
            cwd: task.cwd,
            error: task.error,
            logLength: task.logLength
        };
        return readResourceText(JSON.stringify(summary, null, 2), task.id);
    }
);

function textResponse(payload: unknown) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    return { content: [{ type: 'text' as const, text }] };
}

function readResourceText(text: string, taskId?: string) {
    return {
        contents: [
            {
                uri: taskId ? `tasks://${taskId}/log` : 'tasks://unknown/log',
                mimeType: 'text/plain',
                text
            }
        ]
    };
}

// `jsonSchemaToZod` moved to `server/src/server/schemaUtils.ts`

// `dereferenceSchema` moved to `server/src/server/schemaUtils.ts`

function normalizeTemplateVariable(value?: string | string[]) {
    if (!value) {
        return undefined;
    }
    return Array.isArray(value) ? value[0] : value;
}

// `tokenizeCommandLine` moved to `server/src/core/utils.ts`

async function fileExists(target: string) {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}

function appendLog(task: TaskRecord, chunk: string) {
    const bytes = Buffer.byteLength(chunk, 'utf8');
    task.logLength += bytes;
    task.updatedAt = Date.now();
    updateLastLogLine(task, chunk);
    taskEvents.emit('update', task);
    void appendLogToFile(task.logFile, chunk);
    persistence.schedulePersist();
}

function updateLastLogLine(task: TaskRecord, chunk: string) {
    if (!chunk) {
        return;
    }
    const normalized = chunk.replace(/\r\n/g, '\n');
    const segments = normalized.split('\n').filter((line) => line.trim().length > 0);
    if (segments.length === 0) {
        return;
    }
    const candidate = segments[segments.length - 1];
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
        return;
    }
    task.lastLogLine = trimmed.slice(-200);
}

function markTaskStatus(task: TaskRecord, status: TaskStatus, error?: string) {
    const prev = task.status;
    task.status = status;
    if (status === 'running') {
        task.startedAt = task.startedAt ?? Date.now();
    }
    if (completedStatuses.includes(status)) {
        task.completedAt = Date.now();
    }
    if (error) {
        task.error = error;
    }
    task.updatedAt = Date.now();
    // diagnostic log to help trace state transitions
    try {
        logger.info('task: status transition', {
            taskId: task.id,
            from: prev,
            to: status,
            jobId: task.jobId ?? 'nil'
        });
    } catch (err) {
        // ignore logging errors
    }
    taskEvents.emit('update', task);
    persistence.schedulePersist();
    if (completedStatuses.includes(status)) {
        void persistence.pruneOldTasks(retentionMs);
        // Ensure completed status is immediately persisted to avoid snapshot
        // races where the live status file still shows running tasks.
        try {
            void persistence.flushPendingPersistence();
        } catch (err) {
            // best-effort: do not throw from status-update path
        }
    }
}

function resolveTaskCwd(cwd?: string) {
    const base = cwd && cwd.trim().length > 0 ? cwd : workspaceRoot;
    const resolved = path.isAbsolute(base) ? path.normalize(base) : path.resolve(workspaceRoot, base);
    return assertAllowedTaskCwd(resolved);
}

function resolveWorkspacePath(file: string) {
    const resolved = path.resolve(workspaceRoot, file);
    return assertWithinWorkspace(resolved);
}

function assertWithinWorkspace(target: string) {
    const normalizedTarget = normalizeForComparison(target);
    if (normalizedTarget !== workspaceRootFingerprint && !normalizedTarget.startsWith(workspaceRootPrefix)) {
        throw new Error('File path is outside the allowed workspace directory.');
    }
    return path.normalize(target);
}

function assertAllowedTaskCwd(target: string) {
    const normalizedTarget = normalizeForComparison(target);
    for (const root of allowedCwdRoots) {
        const normalizedRoot = normalizeForComparison(root);
        const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
        if (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(prefix)) {
            return path.normalize(target);
        }
    }
    throw new Error('Task working directory must be within workspace, user home, or system temp.');
}

// `normalizeForComparison` moved to `server/src/core/utils.ts`

// `resolveWorkspaceRoot` moved to `server/src/core/utils.ts`

async function ensureStateDirs() {
    await fs.mkdir(logDir, { recursive: true });
}

async function appendLogToFile(logFile: string, chunk: string) {
    try {
        await ensureStateDirs();
        await fs.appendFile(logFile, chunk, 'utf8');
    } catch (error) {
        logger.error('task: failed to append log chunk', {
            logFile,
            message: String(error)
        });
    }
}

async function readTaskLog(task: TaskRecord) {
    try {
        const data = await fs.readFile(task.logFile, 'utf8');
        task.logLength = Buffer.byteLength(data, 'utf8');
        return data;
    } catch (error) {
        return formatWorkspaceError(error);
    }
}

async function readLogChunk(task: TaskRecord, offset: number) {
    let handle: fs.FileHandle | undefined;
    try {
        const stats = await fs.stat(task.logFile);
        const size = stats.size;
        const safeOffset = Math.max(0, Math.min(offset ?? 0, size));
        const remaining = size - safeOffset;
        const readLength = Math.min(remaining, MAX_TAIL_CHUNK);
        handle = await fs.open(task.logFile, 'r');
        const buffer = Buffer.alloc(readLength);
        const { bytesRead } = await handle.read(buffer, 0, readLength, safeOffset);
        const chunk = buffer.subarray(0, bytesRead).toString('utf8');
        const nextOffset = safeOffset + bytesRead;
        task.logLength = size;
        return { chunk, nextOffset, size };
    } catch (error) {
        return { chunk: formatWorkspaceError(error), nextOffset: 0, size: 0 };
    } finally {
        if (handle) {
            try {
                await handle.close();
            } catch {
                // ignore close errors
            }
        }
    }
}

async function updateLogLength(task: TaskRecord) {
    try {
        const stat = await fs.stat(task.logFile);
        task.logLength = stat.size;
    } catch {
        task.logLength = task.logLength ?? 0;
    }
}

// terminateProcessTree moved to server/src/gemini/processUtils.ts

// Persistence responsibilities moved to `persistenceManager`

async function handleShutdown(reason: string) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    try {
        stopCliHealthWatcher();
        pool.cancelAll();
        for (const task of tasks.values()) {
            if (!completedStatuses.includes(task.status)) {
                appendLog(task, `\n${reason}`);
                markTaskStatus(task, 'failed', reason);
            }
        }
        await persistence.flushPendingPersistence();
        // Release any acquired state lock so other server instances can start.
        try {
            await releaseStateLock();
        } catch (err) {
            // best-effort: log and continue
            logger.error('server: failed to release state lock', String(err));
        }
    } catch (error) {
        logger.error('server: failed to flush tasks during shutdown', String(error));
    }
}

async function acquireStateLock() {
    // Ensure state directory exists before attempting lock file operations.
    await fs.mkdir(stateDir, { recursive: true });
    try {
        const raw = await fs.readFile(lockFile, 'utf8').catch(() => undefined);
        if (raw) {
            let parsed: any = undefined;
            try {
                parsed = JSON.parse(raw);
            } catch {
                // malformed lock, remove and continue
                await fs.unlink(lockFile).catch(() => {});
            }
            if (parsed && parsed.pid) {
                const other = Number(parsed.pid);
                if (Number.isFinite(other) && other > 0) {
                    try {
                        process.kill(other, 0);
                        throw new Error(`State directory locked by running process ${other}`);
                    } catch (err: any) {
                        if (err && err.code === 'ESRCH') {
                            // process not found; stale lock - remove and continue
                            await fs.unlink(lockFile).catch(() => {});
                        } else if (err && err.message && err.message.startsWith('State directory locked')) {
                            throw err;
                        } else {
                            // On Windows or permission issues, treat as locked
                            throw new Error(`State directory appears locked by PID ${other}`);
                        }
                    }
                }
            }
        }
        await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
        lockHeld = true;
    } catch (err) {
        throw err;
    }
}

async function releaseStateLock() {
    if (!lockHeld) {
        return;
    }
    try {
        const raw = await fs.readFile(lockFile, 'utf8').catch(() => undefined);
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.pid === process.pid) {
                    await fs.unlink(lockFile).catch(() => {});
                }
            } catch {
                // malformed: ensure removal
                await fs.unlink(lockFile).catch(() => {});
            }
        }
    } finally {
        lockHeld = false;
    }
}

function registerShutdownHandlers() {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) {
        process.once(signal, () => {
            void handleShutdown(`Server stopped (${signal}).`).finally(() => process.exit(0));
        });
    }
    process.once('beforeExit', () => {
        void handleShutdown('Server stopped.').catch(() => {});
    });
}

// `formatWorkspaceError` moved to `server/src/core/utils.ts`

async function validateGeminiExecutable() {
    if (geminiBin.includes(path.sep)) {
        try {
            await fs.access(geminiBin);
        } catch {
            throw new Error(`Gemini CLI not found at ${geminiBin}`);
        }
    }
}

// spawnHelpers provides gemini resolution and spawn command helpers

// execGeminiCommand moved to server/src/gemini/processUtils.ts

async function updateCliStatus(reason: string) {
    if (cliCheckPromise) {
        await cliCheckPromise;
        return;
    }
    cliCheckPromise = (async () => {
        try {
            const v = buildSpawnCommand(['--version']);
            logger.info('cli: checking status', {
                reason,
                command: v.command,
                args: v.args
            });
            const { stdout, stderr } = await execGeminiCommand(v.command, v.args);
            const versionLine =
                stdout
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .find((line) => line.length > 0) ||
                stderr
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .find((line) => line.length > 0) ||
                'Gemini CLI';
            cliStatus = {
                state: 'ok',
                message: versionLine,
                version: versionLine,
                lastChecked: Date.now()
            };
            acceptingTasks = true;
            logger.info('cli: ready', { version: versionLine });
        } catch (error) {
            const message = formatWorkspaceError(error);
            const state = classifyCliFailure(message);
            // Only force marking the CLI as unavailable for high-confidence states
            // like 'missing' or 'quota_exhausted'. Generic 'error' should not
            // immediately force a global failure since it may be transient.
            const shouldForce = state !== 'error';
            logger.warn('cli: failed to update status', {
                reason,
                state,
                message
            });
            enterCliFailure(state, `${message} [${reason}]`, { force: shouldForce });
        } finally {
            cliCheckPromise = undefined;
            persistence.scheduleStatusSnapshot();
        }
    })();
    await cliCheckPromise;
}

function classifyCliFailure(message: string): CliHealthState {
    const lower = message.toLowerCase();
    if (lower.includes('quota') || lower.includes('credit') || lower.includes('billing')) {
        return 'quota_exhausted';
    }
    if (lower.includes('enoent') || lower.includes('not found') || lower.includes('is not recognized')) {
        return 'missing';
    }
    // Detect common network / service failures and treat them as 'unresponsive'
    if (
        lower.includes('failed to connect') ||
        lower.includes('connection refused') ||
        lower.includes('connection reset') ||
        lower.includes('timed out') ||
        lower.includes('timeout') ||
        lower.includes('service unavailable') ||
        lower.includes('503') ||
        lower.includes('502') ||
        lower.includes('ecxn') ||
        lower.includes('network') ||
        lower.includes('could not reach')
    ) {
        return 'unresponsive';
    }
    return 'error';
}

function enterCliFailure(state: CliHealthState, message: string, options?: { force?: boolean }) {
    if (state === 'unknown') {
        return;
    }
    logger.warn('cli: entering failure state', {
        state,
        force: options?.force === true,
        message
    });
    // Do not be aggressive about cancelling running tasks for transient
    // failures. Only force-cancel when we have a high-confidence unusable
    // state (e.g., 'missing' or 'quota_exhausted') or when caller set force.
    if (!options?.force && state === 'error') {
        // transient, record status but do not cancel running tasks
        acceptingTasks = false;
        cliStatus = { state, message, lastChecked: Date.now() };
        persistence.scheduleStatusSnapshot();
        void persistence.persistLiveStatus().then(() => {
            try { void broadcastStatusSnapshot(); } catch {}
        }).catch(() => {});
        return;
    }

    acceptingTasks = false;
    cliStatus = { state, message, lastChecked: Date.now() };

    const shouldCancel = options?.force || state === 'missing' || state === 'quota_exhausted';
    if (shouldCancel) {
        pool.cancelAll();
        for (const task of tasks.values()) {
            if (!completedStatuses.includes(task.status)) {
                appendLog(task, `\nGemini CLI unavailable: ${message}`);
                markTaskStatus(task, 'failed', message);
            }
        }
    }
    persistence.scheduleStatusSnapshot();
    void persistence.persistLiveStatus().then(() => {
        try { void broadcastStatusSnapshot(); } catch {}
    }).catch(() => {});
}

function maybeUpdateCliStatusFromFailure(message: string) {
    if (!message) {
        return;
    }
    const trimmed = message.trim();
    const classification = classifyCliFailure(trimmed);
    enterCliFailure(classification, trimmed);
}

function ensureCliReady() {
    if (acceptingTasks && cliStatus.state === 'ok') {
        return;
    }
    throw new Error(
        `Gemini CLI unavailable (${cliStatus.message}). Reload VS Code after fixing the CLI to re-enable background workers.`
    );
}

function startCliHealthWatcher() {
    // Disable periodic polling to avoid hammering gemini --version.
}

function stopCliHealthWatcher() {
    // Nothing to stop; watcher is disabled.
}

// `readTimeoutEnv` and `readPriorityEnv` moved to `server/src/core/utils.ts`

async function start() {
    logger.info('server: starting', {
        pid: process.pid,
        workspace: workspaceRoot
    });
    await validateGeminiExecutable();
    await updateCliStatus('startup');
    // If we have a discovered absolute gemini binary and the workspace
    // status.json does not already contain a persisted path, write it
    // so subsequent extension/server launches can reuse the absolute path
    // instead of relying on PATH discovery.
    try {
        await persistDiscoveredGeminiPathIfMissing();
    } catch (err) {
        logger.warn('server: failed to persist discovered gemini path', String(err));
    }
    await persistence.loadPersistedTasks();
    // Load and register tool metadata from mcp.json (manifest)
    await loadMcpManifest();
    await persistence.pruneOldTasks();
    await persistence.persistLiveStatus();
    startCliHealthWatcher();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // After transport is connected, send an initial status snapshot to clients
    try {
        await broadcastStatusSnapshot();
    } catch {
        // ignore notification failures
    }

    // Emit an explicit ready line so the extension can detect that the
    // server process has successfully started and bound its transport.
    try {
        logger.info('server: ready', { pid: process.pid, workspace: workspaceRoot });
    } catch {}
}

async function persistDiscoveredGeminiPathIfMissing() {
    try {
        // Only persist when geminiBin looks like an explicit path (contains path separator)
        if (!geminiBin || !geminiBin.includes(path.sep)) {
            return;
        }
        // Ensure state directory exists
        await fs.mkdir(stateDir, { recursive: true });
        // Read existing status file if present
        let raw: string | undefined;
        try {
            raw = await fs.readFile(statusFile, 'utf8');
        } catch {
            raw = undefined;
        }
        let parsed: any = {};
        if (raw) {
            try {
                parsed = JSON.parse(raw) as any;
            } catch {
                parsed = {};
            }
        }
        const existing = parsed && (parsed.geminiPath || parsed.gemini || parsed.cliPath);
        if (existing && String(existing).trim().length > 0) {
            // already persisted
            return;
        }
        parsed.geminiPath = String(geminiBin);
        parsed.updatedAt = Date.now();
        await fs.writeFile(statusFile, JSON.stringify(parsed, null, 2), 'utf8');
        logger.info('server: persisted discovered gemini path', {
            statusFile,
            geminiPath: String(geminiBin)
        });
    } catch (err) {
        // best-effort; do not fail startup
        logger.warn('server: persistDiscoveredGeminiPathIfMissing failed', String(err));
    }
}

async function loadMcpManifest() {
    try {
        const manifestPath = path.join(workspaceRoot, 'mcp.json');
        if (!(await fileExists(manifestPath))) {
            // No manifest present; nothing to do
            logger.info('manifest: not found', { manifestPath });
            return;
        }
        const raw = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw) as any;
        const manifestValidation = manifestSchema.safeParse(manifest);
        if (!manifestValidation.success) {
            logger.error('manifest: validation failed; proceeding with raw manifest', {
                issues: manifestValidation.error.issues
            });
        }
        const manifestData = manifestValidation.success ? manifestValidation.data : manifest;
        const toolEntries = Array.isArray(manifestData.tools) ? manifestData.tools : [];
        logger.info('manifest: loaded', { toolCount: toolEntries.length });
        // Attach manifest to server for inspection by clients if needed
        try {
            (server as any)._mcpManifest = manifestData;
        } catch { /* ignore */ }

        const manifestDir = path.dirname(manifestPath);
        const externalCache: Record<string, any> = {};
        const advertisedTools: string[] = [];
        for (const t of toolEntries) {
            try {
                if (!t || typeof t !== 'object') {
                    logger.warn('manifest: skipping entry with invalid structure', { entry: t });
                    continue;
                }
                if (typeof t.name !== 'string' || t.name.trim().length === 0) {
                    logger.warn('manifest: skipping entry without a valid name', { entry: t });
                    continue;
                }
                const toolName = t.name.trim();
                // If server exposes a hasTool method or internal tools map, try to detect pre-existing registration
                const hasTool = (server as any).hasTool?.(toolName) ?? Boolean((server as any)._tools && (server as any)._tools[toolName]);
                if (hasTool) {
                    // already registered by code; skip
                    continue;
                }

                let resolvedArgs: any = undefined;
                try {
                    if (t.arguments) {
                        resolvedArgs = await dereferenceSchema(t.arguments, manifestData, manifestDir, externalCache);
                    }
                } catch (refErr) {
                    logger.warn('manifest: failed to dereference schema', {
                        toolName,
                        error: String(refErr)
                    });
                    resolvedArgs = t.arguments;
                }
                const inputSchemaZod = resolvedArgs ? jsonSchemaToZod(resolvedArgs) : z.any().optional();

                try {
                    server.registerTool(
                        toolName,
                        {
                            title: t.title ?? toolName,
                            description: t.description ?? '',
                            inputSchema: inputSchemaZod
                        },
                        async (input, _extra) => {
                            try {
                                ensureCliReady();
                                const normalized = sanitizeManifestArgs(toolName, input ?? {});
                                const result = await invokeManifestTool(toolName, normalized);
                                return textResponse(result);
                            } catch (err) {
                                return textResponse({ error: serializeErrorForClient(err) });
                            }
                        }
                    );
                        logger.info('manifest: registered tool', { toolName });
                        // Also emit a clear, human-readable single-line message per tool
                        try {
                            const title = (t.title && String(t.title).trim().length > 0) ? String(t.title) : undefined;
                            const desc = (t.description && String(t.description).trim().length > 0) ? String(t.description) : undefined;
                            const extra = title ? ` title="${title}"` : '';
                            const extraDesc = desc ? ` description="${desc}"` : '';
                            logger.info(`manifest: tool registered: ${toolName}${extra}${extraDesc}`);
                        } catch {
                            // ignore logging formatting errors
                        }
                    advertisedTools.push(toolName);
                } catch (regErr: any) {
                    const msg = String((regErr && regErr.message) || regErr);
                    if (msg.toLowerCase().includes('already registered') || msg.toLowerCase().includes('already exists')) {
                        logger.info('manifest: skipped duplicate tool', { toolName });
                    } else {
                        logger.warn('manifest: failed to register tool', {
                            toolName,
                            error: String(regErr)
                        });
                    }
                }
            } catch (err) {
                const fallbackName = (t && typeof t === 'object' && 'name' in t) ? (t as any).name : '<unknown>';
                logger.warn('manifest: failed to register tool', {
                    toolName: fallbackName,
                    error: String(err)
                });
            }
        }
        if (advertisedTools.length > 0) {
            logger.info('manifest: tools available', { tools: advertisedTools });
        } else {
            logger.warn('manifest: no tools registered from manifest');
        }
    } catch (err) {
        logger.error('manifest: failed to load mcp.json', String(err));
    }
}

type ManifestInvocationAttempt = {
    label: string;
    args: string[];
    stdin?: string;
    timeoutMs?: number;
};

function sanitizeManifestArgs(toolName: string, rawInput: Record<string, unknown>) {
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawInput ?? {})) {
        if (value === undefined || value === null) {
            continue;
        }
        input[key] = value;
    }

    if (toolName === 'dev.summarizeCode') {
        const inputType = typeof input.inputType === 'string' ? String(input.inputType) : 'path';
        input.inputType = inputType;
        if (inputType === 'path') {
            const relPath = typeof input.path === 'string' ? input.path : undefined;
            if (!relPath) {
                throw new Error('`path` is required when `inputType` is `path`.');
            }
            try {
                input.path = resolveWorkspacePath(relPath);
            } catch {
                input.path = path.resolve(workspaceRoot, relPath);
            }
            delete input.content;
        } else if (inputType === 'text') {
            if (typeof input.content !== 'string' || input.content.trim().length === 0) {
                throw new Error('`content` must be provided when `inputType` is `text`.');
            }
            delete input.path;
        }
    } else if (typeof input.path === 'string') {
        try {
            input.path = resolveWorkspacePath(String(input.path));
        } catch {
            input.path = path.resolve(workspaceRoot, String(input.path));
        }
    }

    return input;
}

function toKebabCase(value: string) {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
}

function stripUndefinedDeep(obj: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined || value === null) {
            continue;
        }
        if (Array.isArray(value)) {
            out[key] = value
                .map((entry) => (typeof entry === 'object' && entry !== null ? stripUndefinedDeep(entry as Record<string, unknown>) : entry))
                .filter((entry) => entry !== undefined && entry !== null);
            continue;
        }
        if (typeof value === 'object') {
            out[key] = stripUndefinedDeep(value as Record<string, unknown>);
            continue;
        }
        out[key] = value;
    }
    return out;
}

function manifestArgsToFlags(args: Record<string, unknown>) {
    const flags: string[] = [];
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null) {
            continue;
        }
        if (key === 'content' && typeof value === 'string') {
            // Large free-form content should be delivered via stdin JSON instead of CLI flags.
            continue;
        }
        const flagName = `--${toKebabCase(key)}`;
        if (Array.isArray(value)) {
            for (const entry of value) {
                if (entry === undefined || entry === null) {
                    continue;
                }
                flags.push(flagName, String(entry));
            }
            continue;
        }
        if (typeof value === 'object') {
            flags.push(flagName, JSON.stringify(value));
            continue;
        }
        flags.push(flagName, String(value));
    }
    return flags;
}

function buildManifestInvocationAttempts(toolName: string, args: Record<string, unknown>): ManifestInvocationAttempt[] {
    const sanitized = stripUndefinedDeep(args);
    const jsonPayload = JSON.stringify({ tool: toolName, arguments: sanitized }, null, 2);
    const attempts: ManifestInvocationAttempt[] = [
        {
            label: 'mcp.call',
            args: ['mcp', 'call', toolName],
            stdin: jsonPayload,
            timeoutMs: manifestToolTimeoutMs
        }
    ];

    const segments = toolName.split('.');
    if (segments.length >= 2) {
        const category = segments[0];
        const action = segments
            .slice(1)
            .map((segment) => toKebabCase(segment))
            .join('-');
        const flagArgs = manifestArgsToFlags(sanitized);
        attempts.push({
            label: 'category-command',
            args: [category, action, ...flagArgs],
            stdin: JSON.stringify(sanitized, null, 2),
            timeoutMs: manifestToolTimeoutMs
        });
    }

    return attempts;
}

async function runGeminiCliCommand(commandArgs: string[], options: { stdin?: string; timeoutMs?: number } = {}) {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        try {
            const { command, args } = buildSpawnCommand(commandArgs);
            logger.info('cli: spawning Gemini CLI', {
                command,
                args,
                timeoutMs: options.timeoutMs ?? manifestToolTimeoutMs,
                stdinBytes: options.stdin ? options.stdin.length : 0
            });
            const child = spawn(command, args, {
                cwd: workspaceRoot,
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: false,
                windowsHide: process.platform === 'win32'
            });

            let stdout = '';
            let stderr = '';
            let settled = false;

            child.stdout?.on('data', (chunk) => {
                stdout += chunk.toString();
            });
            child.stderr?.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            const timeoutMs = options.timeoutMs ?? manifestToolTimeoutMs;
            const timer = timeoutMs > 0
                ? setTimeout(() => {
                      try {
                          terminateProcessTree(child);
                      } catch {
                          // ignore
                      }
                      if (!settled) {
                          settled = true;
                          logger.warn('cli: invocation timed out', {
                              timeoutMs,
                              command,
                              args
                          });
                          reject(new Error(`Gemini CLI call timed out after ${timeoutMs}ms.`));
                      }
                  }, timeoutMs)
                : undefined;

            const payload = `${SILENT_EXEC_PROMPT}\n${options.stdin ?? ''}`;
            try {
                child.stdin?.write(payload);
                child.stdin?.end();
            } catch {
                // ignore stdin errors
            }

            child.on('error', (error) => {
                if (!settled) {
                    settled = true;
                    if (timer) {
                        clearTimeout(timer);
                    }
                    reject(error);
                }
            });

            child.on('close', (code) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                }
                if (code === 0) {
                    logger.info('cli: invocation succeeded', {
                        command,
                        args,
                        stdoutBytes: stdout.length,
                        stderrBytes: stderr.length
                    });
                    resolve({ stdout, stderr });
                } else {
                    const message = stderr.trim() || stdout.trim() || `Gemini CLI exited with code ${code}`;
                    logger.warn('cli: invocation exited with non-zero code', {
                        command,
                        args,
                        code,
                        message
                    });
                    reject(new Error(message));
                }
            });
        } catch (error) {
            logger.error('cli: failed to launch Gemini CLI process', String(error));
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

async function invokeManifestTool(toolName: string, args: Record<string, unknown>) {
    const attempts = buildManifestInvocationAttempts(toolName, args);
    const errors: string[] = [];
    for (const attempt of attempts) {
        try {
            logger.info('manifest: invoking tool', {
                toolName,
                attempt: attempt.label,
                args: attempt.args,
                stdinBytes: attempt.stdin ? attempt.stdin.length : 0
            });
            const { stdout } = await runGeminiCliCommand(attempt.args, { stdin: attempt.stdin, timeoutMs: attempt.timeoutMs });
            const trimmed = stdout.trim();
            if (!trimmed) {
                logger.warn('manifest: tool returned empty output', {
                    toolName,
                    attempt: attempt.label
                });
                errors.push(`${attempt.label}: empty output`);
                continue;
            }
            try {
                logger.info('manifest: tool produced JSON output', {
                    toolName,
                    attempt: attempt.label,
                    bytes: Buffer.byteLength(trimmed, 'utf8')
                });
                return JSON.parse(trimmed);
            } catch {
                logger.info('manifest: tool produced text output', {
                    toolName,
                    attempt: attempt.label,
                    bytes: Buffer.byteLength(trimmed, 'utf8')
                });
                return trimmed;
            }
        } catch (error) {
            logger.warn('manifest: tool invocation failed', {
                toolName,
                attempt: attempt.label,
                error: formatWorkspaceError(error)
            });
            errors.push(`${attempt.label}: ${formatWorkspaceError(error)}`);
        }
    }
    throw new Error(errors.join('; '));
}

registerShutdownHandlers();

// Allow tests or embedding tools to import the module without auto-starting
// the server. Set `GEMINI_MCP_SKIP_START=1` in the environment to prevent
// automatic start (used by unit tests).
if (!process.env.GEMINI_MCP_SKIP_START) {
    start().catch((err) => {
        logger.error('server: failed to start Gemini CLI MCP server', String(err));
        process.exit(1);
    });
}

export { server };
