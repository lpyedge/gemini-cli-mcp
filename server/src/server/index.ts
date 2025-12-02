import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { jsonSchemaToZod, dereferenceSchema } from '../lib/schemaUtils.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WorkerPool } from '../task/workerPool.js';
import { GeminiProvider, GeminiMode } from '../gemini/geminiProvider.js';
import { SILENT_EXEC_PROMPT, serializeErrorForClient, formatWorkspaceError, normalizeForComparison, resolveWorkspaceRoot, readTimeoutEnv } from '../core/utils.js';
import { loadMcpManifest as loadMcpManifestFromManager } from '../gemini/manifestManager.js';
import { createPersistenceManager } from '../task/persistenceManager.js';
import { logger } from '../core/logger.js';
// gemini provider exports are imported above; no re-exports needed here
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
// lock file logic removed: lock management is not used by this server.
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
    mode?: GeminiMode; // 'core' | 'cli' | 'unknown'
}
let cliStatus: CliStatusSnapshot = {
    state: 'unknown',
    message: 'Gemini CLI health check pending.',
    lastChecked: Date.now(),
    mode: 'unknown'
};
let cliCheckPromise: Promise<void> | undefined;

// Initialize GeminiProvider singleton with workspace settings
let geminiProvider: GeminiProvider | null = null;
function getOrCreateGeminiProvider(): GeminiProvider {
    if (!geminiProvider) {
            geminiProvider = new GeminiProvider({
                cwd: workspaceRoot,
                targetDir: workspaceRoot,
                debugMode: false,
                authType: 'oauth' // Default to free tier (LOGIN_WITH_GOOGLE)
            });
    }
    return geminiProvider;
}
let acceptingTasks = false;
const allowedCwdRoots = [workspaceRoot, os.tmpdir(), os.homedir()].map((p) => path.normalize(p));
const manifestToolTimeoutMs = readTimeoutEnv('GEMINI_TIMEOUT_MANIFEST', 120000);

const tasks = new Map<string, TaskRecord>();
const taskEvents = new EventEmitter();
const pool = new WorkerPool(workerCount);
// Previously we attempted to pre-load a persisted gemini path from status.json.
// That responsibility is now encapsulated within `GeminiProvider` (detection/persistence).

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
// Track the active transport so broadcasts can use it directly when SDK
// doesn't expose a convenient send API on the McpServer instance.
let activeTransport: any = null;

// Build and send a live status snapshot to connected MCP clients (extension).
async function broadcastStatusSnapshot() {
    try {
        const payload = persistence.buildLiveStatusPayload();
        // Prefer high-level send APIs if available, otherwise send raw JSON-RPC notification.
        try {
            const anyServer: any = server as any;
            try {
                logger.info('server: broadcasting status snapshot', { tasks: (payload as any).tasks?.length ?? 0, cliStatus: (payload as any).cliStatus ?? null });
            } catch {
                logger.info('server: broadcasting status snapshot (meta unknown)');
            }
            if (typeof anyServer.sendNotification === 'function') {
                logger.info('server: using server.sendNotification to publish gemini/statusSnapshot');
                anyServer.sendNotification('gemini/statusSnapshot', payload);
                return;
            }
            if (typeof anyServer.notification === 'function') {
                // some implementations expose notification helper
                logger.info('server: using server.notification helper to publish gemini/statusSnapshot');
                anyServer.notification({ method: 'gemini/statusSnapshot', params: payload });
                return;
            }
            // Fallback: use the tracked activeTransport if available
            if (activeTransport && typeof activeTransport.send === 'function') {
                logger.info('server: using activeTransport.send to publish gemini/statusSnapshot via transport');
                void activeTransport.send({ jsonrpc: '2.0', method: 'gemini/statusSnapshot', params: payload }).catch((err: any) => {
                    try { logger.warn('server: activeTransport.send failed to deliver statusSnapshot', String(err)); } catch {}
                });
            } else {
                logger.warn('server: no transport available to send status snapshot');
            }
        } catch (err) {
            try { logger.warn('server: failed to broadcast status snapshot', String(err)); } catch {}
        }
    } catch (err) {
        try { logger.warn('server: failed to build status snapshot', String(err)); } catch {}
    }
}

async function persistAndBroadcastStatus() {
    try {
        await persistence.persistLiveStatus();
    } catch (e) {
        try { logger.warn('server: failed to persist live status', String(e)); } catch {}
    }
    try {
        await broadcastStatusSnapshot();
    } catch (e) {
        try { logger.warn('server: failed to broadcast status snapshot', String(e)); } catch {}
    }
}

// Subscribe to task and pool events to propagate live status snapshots to clients.
    try {
        taskEvents.on('update', () => {
            try {
                void persistAndBroadcastStatus();
            } catch {}
        });
        if (typeof pool.on === 'function') {
            pool.on('changed', () => {
                try {
                    void persistAndBroadcastStatus();
                } catch {}
            });
            pool.on('queue', () => {
                try {
                    void persistAndBroadcastStatus();
                } catch {}
            });
        }
} catch {
    // best-effort: do not crash if subscriptions fail
}

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

function registerResources() {
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
}

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
        pool.cancelAll();
        for (const task of tasks.values()) {
            if (!completedStatuses.includes(task.status)) {
                appendLog(task, `\n${reason}`);
                markTaskStatus(task, 'failed', reason);
            }
        }
        await persistence.flushPendingPersistence();
        // No state lock to release in current implementation.
    } catch (error) {
        logger.error('server: failed to flush tasks during shutdown', String(error));
    }
}

// State lock management removed — not used in this build.

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
// Validation of gemini executable is delegated to GeminiProvider.checkHealth().

async function updateCliStatus(reason: string) {
    if (cliCheckPromise) {
        await cliCheckPromise;
        return;
    }
    cliCheckPromise = (async () => {
        try {
            logger.info('cli: checking status via GeminiProvider', { reason });
            
            // Use GeminiProvider which tries core first, then CLI fallback
            const provider = getOrCreateGeminiProvider();
            const healthResult = await provider.checkHealth();

            // Log the raw health result for diagnostics and traceability
            try {
                logger.info('cli: health check result', { healthResult });
            } catch {}

            if (healthResult.available) {
                cliStatus = {
                    state: 'ok',
                    message: healthResult.message,
                    version: healthResult.version,
                    lastChecked: Date.now(),
                    mode: healthResult.mode
                };
                acceptingTasks = true;
                logger.info('cli: ready', {
                    mode: healthResult.mode,
                    version: healthResult.version,
                    message: healthResult.message
                });
                // Immediately persist & broadcast the updated status so clients
                // see the new state as soon as possible.
                try {
                    await persistAndBroadcastStatus();
                } catch (e) {
                    logger.warn('server: failed to persist/broadcast status after health check', String(e));
                }
            } else {
                // Neither core nor CLI available
                const message = healthResult.message;
                logger.warn('cli: failed to update status', {
                    reason,
                    state: 'missing',
                    message
                });
                enterCliFailure('missing', `${message} [${reason}]`, { force: true });
                // Ensure clients are notified of failure state promptly
                try {
                    await persistAndBroadcastStatus();
                } catch (e) {
                    logger.warn('server: failed to persist/broadcast failure status', String(e));
                }
            }
        } catch (error) {
            const message = formatWorkspaceError(error);
            const state = classifyCliFailure(message);
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
        void persistAndBroadcastStatus();
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
    void persistAndBroadcastStatus();
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

// CLI health watcher removed; health is managed by GeminiProvider.checkHealth().

// `readTimeoutEnv` and `readPriorityEnv` moved to `server/src/core/utils.ts`

async function start() {
    logger.info('server: starting', {
        pid: process.pid,
        workspace: workspaceRoot
    });
    // Ensure minimal state directories exist so persistence/lock operations work
    try {
        await fs.mkdir(stateDir, { recursive: true });
    } catch (err) {
        logger.warn('server: failed to ensure state directories', String(err));
    }

    // Connect transport early so the MCP host (extension) can detect the server
    // process is up. Post-start work (health checks, manifest loading, task
    // persistence) runs asynchronously and will broadcast snapshots when ready.
    // Load and register tool metadata from mcp.json (manifest) before connecting
    // the transport so tool capabilities can be registered without error.
    try {
        await loadMcpManifestFromManager({ workspaceRoot, server, runGeminiCliCommand, ensureCliReady, manifestToolTimeoutMs });
    } catch (err) {
        logger.warn('server: failed to load MCP manifest (continuing startup)', String(err));
    }

    // Register built-in resources after manifest load but before connect so
    // resource capability registration happens prior to transport connect.
    try {
        registerResources();
    } catch (err) {
        logger.warn('server: failed to register resources (continuing startup)', String(err));
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Keep a reference to the transport for direct sends.
    activeTransport = transport;

    // Immediately publish a lightweight "checking" snapshot so the client
    // knows the server is alive and that CLI health is being probed. This
    // gives the extension a timely update to show a checking UI state.
    try {
        cliStatus = {
            state: 'unknown',
            message: 'Checking Gemini CLI...',
            lastChecked: Date.now(),
            mode: 'unknown'
        };
        logger.info('server: broadcasting preliminary CLI checking snapshot');
        try {
            await persistAndBroadcastStatus();
        } catch (e) {
            logger.warn('server: failed to persist/broadcast preliminary status', String(e));
        }
    } catch {
        // ignore failures here - proceed with background init
    }

    // Emit a ready line for the extension to detect successful startup.
    try {
        logger.info('server: ready', { pid: process.pid, workspace: workspaceRoot });
    } catch {}

    // Run background initialization tasks without blocking server startup.
    (async function postStartWork() {
        try {
            try {
                await updateCliStatus('startup');
            } catch (err) {
                logger.warn('server: initial CLI health check failed (continuing startup)', String(err));
            }

            // Load persisted tasks; manifest is loaded prior to transport connect
            try {
                await persistence.loadPersistedTasks();
            } catch (err) {
                logger.warn('server: failed to load persisted tasks', String(err));
            }

            try {
                await persistence.pruneOldTasks();
            } catch (err) {
                logger.warn('server: pruneOldTasks failed', String(err));
            }

            try {
                await persistAndBroadcastStatus();
            } catch (err) {
                logger.warn('server: persistAndBroadcastStatus failed', String(err));
            }

            // After background init, broadcast an updated snapshot so extensions
            // receive the full state (tasks, cliStatus, etc.). Failures here are
            // non-fatal; clients will receive updates as things change.
            try {
                void broadcastStatusSnapshot();
            } catch (err) {
                logger.warn('server: failed to broadcast post-start snapshot', String(err));
            }
        } catch (err) {
            logger.warn('server: unexpected error during post-start work', String(err));
        }
    })();
}

// Persistence of discovered geminiPath is handled by GeminiProvider or persistence
// layer; server no longer performs direct discovered-path persistence here.

async function runGeminiCliCommand(commandArgs: string[], options: { stdin?: string; timeoutMs?: number } = {}) {
    // Delegate to GeminiProvider which centralizes CLI spawn behavior
    const provider = getOrCreateGeminiProvider();
    const payload = `${SILENT_EXEC_PROMPT}\n${options.stdin ?? ''}`;
    const res = await provider.runCliCommand(commandArgs, { cwd: workspaceRoot, env: undefined, stdin: payload, timeoutMs: options.timeoutMs });
    return { stdout: res.stdout, stderr: res.stderr };
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
