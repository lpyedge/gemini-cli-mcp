import { randomUUID } from 'node:crypto';
import { spawn, ChildProcess, spawnSync } from 'node:child_process';
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
import { SILENT_EXEC_PROMPT, StructuredError, serializeErrorForClient, tokenizeCommandLine, formatWorkspaceError, normalizeForComparison, resolveWorkspaceRoot, readTimeoutEnv, readPriorityEnv } from '../core/utils.js';
import { createPersistenceManager } from '../task/persistenceManager.js';
export { buildSpawnCommand, setGeminiBin } from '../gemini/spawnHelpers.js';
import { TaskRecord, TaskStatus } from '../task/types.js';

// geminiBin and related helpers are provided by server/src/gemini/spawnHelpers.ts
const workerCount = Number(process.env.GEMINI_MAX_WORKERS || '3');
let rawWorkspaceRootEnv = (process.env.GEMINI_TASK_CWD ?? '').trim();
if (!rawWorkspaceRootEnv) {
    if (!process.env.GEMINI_MCP_SKIP_START) {
        console.error('Gemini CLI MCP server requires GEMINI_TASK_CWD to be set.');
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
const suggestSampleLimit = 200;
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
const defaultTimeouts: Record<string, number> = {
    'tests.run': readTimeoutEnv('GEMINI_TIMEOUT_TESTS_RUN', 10 * 60 * 1000),
    'code.analyze': readTimeoutEnv('GEMINI_TIMEOUT_CODE_ANALYZE', 5 * 60 * 1000),
    'code.format.batch': readTimeoutEnv('GEMINI_TIMEOUT_CODE_FORMAT', 5 * 60 * 1000),
    'gemini.task.submit': readTimeoutEnv('GEMINI_TIMEOUT_TASK_SUBMIT', 0)
};
const defaultPriorities: Record<string, number> = {
    'tests.run': readPriorityEnv('GEMINI_PRIORITY_TESTS_RUN', 0),
    'code.analyze': readPriorityEnv('GEMINI_PRIORITY_CODE_ANALYZE', 0),
    'code.format.batch': readPriorityEnv('GEMINI_PRIORITY_CODE_FORMAT', 0),
    'gemini.task.submit': readPriorityEnv('GEMINI_PRIORITY_TASK_SUBMIT', 0)
};

const tasks = new Map<string, TaskRecord>();
const taskEvents = new EventEmitter();
const pool = new WorkerPool(workerCount);

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

const nonNegativeTimeout = z.number().int().nonnegative().optional();

const taskSchema = z.object({
    command: z.array(z.string()).nonempty(),
    stdin: z.string().optional(),
    cwd: z.string().optional(),
    timeoutMs: nonNegativeTimeout,
    priority: z.number().int().min(-5).max(5).optional()
});

const analyzeSchema = z.object({
    paths: z.array(z.string()).nonempty(),
    prompt: z.string().optional(),
    subcommand: z.string().default('code'),
    cwd: z.string().optional(),
    timeoutMs: nonNegativeTimeout,
    priority: z.number().int().min(-5).max(5).optional()
});

const testSchema = z.object({
    command: z.string().default('npm'),
    args: z.array(z.string()).default(['test']),
    cwd: z.string().optional(),
    timeoutMs: nonNegativeTimeout,
    priority: z.number().int().min(-5).max(5).optional()
});

const formatSchema = z.object({
    files: z.array(z.string()).nonempty(),
    formatter: z.string().default('code edit'),
    extraArgs: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    timeoutMs: nonNegativeTimeout,
    priority: z.number().int().min(-5).max(5).optional()
});

const fileReadSchema = z.object({ file: z.string() });
const fileWriteSchema = z.object({ file: z.string(), contents: z.string() });
const tailLogSchema = z.object({
    taskId: z.string(),
    offset: z.number().int().nonnegative().default(0)
});
const listTasksSchema = z.object({
    limit: z.number().int().positive().max(200).default(50)
});
const pruneSchema = z.object({
    olderThanDays: z.number().int().positive().max(365).default(7)
});
const suggestSchema = z.object({
    limit: z.number().int().positive().max(10).default(5)
});

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

server.registerTool(
    'gemini.task.submit',
    {
        title: 'Submit Gemini CLI command',
        description: 'Delegate any Gemini CLI subcommand to a worker.',
        inputSchema: taskSchema
    },
    async (input, _extra) => {
        try {
            ensureCliReady();
            const { command, stdin, cwd, timeoutMs, priority } = input;
            const effectiveTimeout = timeoutMs ?? defaultTimeouts['gemini.task.submit'] ?? undefined;
            const resolvedPriority = priority ?? defaultPriorities['gemini.task.submit'];
            ensureQueueCapacity();
            const task = await createTask(
                'gemini.task.submit',
                input,
                command,
                stdin,
                cwd,
                effectiveTimeout,
                resolvedPriority
            );
            return textResponse(taskResponse(task.id, task.status, task.logLength));
        } catch (error) {
            return textResponse({ error: serializeErrorForClient(error) });
        }
    }
);

server.registerTool(
    'gemini.task.status',
    {
        title: 'Check Gemini task status',
        description: 'Return the persisted task payload and timestamps.',
        inputSchema: z.object({ taskId: z.string() })
    },
    async ({ taskId }, _extra) => {
        const task = tasks.get(taskId);
        if (!task) {
            return textResponse({ error: 'Task not found' });
        }
        await updateLogLength(task);
        return textResponse({ ...task, logUri: `tasks://${task.id}/log`, nextOffset: task.logLength });
    }
);

server.registerTool(
    'gemini.task.list',
    {
        title: 'List Gemini tasks',
        description: 'Enumerate recent Gemini tasks with status and log pointers.',
        inputSchema: listTasksSchema
    },
    async ({ limit }, _extra) => {
        const maxItems = limit ?? 50;
        const items = Array.from(tasks.values())
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, maxItems)
            .map((task) => ({
                id: task.id,
                toolName: task.toolName,
                status: task.status,
                createdAt: task.createdAt,
                updatedAt: task.updatedAt,
                exitCode: task.exitCode,
                timeoutMs: task.timeoutMs,
                logUri: `tasks://${task.id}/log`,
                cwd: task.cwd
            }));
        return textResponse({ tasks: items });
    }
);

server.registerTool(
    'gemini.task.prune',
    {
        title: 'Prune old Gemini tasks',
        description: 'Delete completed tasks and logs older than the given number of days.',
        inputSchema: pruneSchema
    },
    async ({ olderThanDays = 7 }, _extra) => {
        const windowMs = olderThanDays * 24 * 60 * 60 * 1000;
        const result = await persistence.pruneOldTasks(windowMs);
        return textResponse({
            prunedTasks: result.removedTasks,
            prunedLogs: result.removedLogs,
            cutoff: result.cutoff
        });
    }
);

server.registerTool(
    'gemini.task.cancel',
    {
        title: 'Cancel Gemini task',
        description: 'Abort a queued or running worker job.',
        inputSchema: z.object({ taskId: z.string() })
    },
    async ({ taskId }, _extra) => {
        const task = tasks.get(taskId);
        if (!task) {
            return textResponse({ error: 'Task not found' });
        }
        if (completedStatuses.includes(task.status)) {
            return textResponse({
                ...taskResponse(task.id, task.status, task.logLength),
                note: 'Task already completed.'
            });
        }
        if (task.jobId) {
            pool.cancel(task.jobId);
        }
        task.jobId = undefined;
        appendLog(task, '\nCanceled by user.');
        markTaskStatus(task, 'canceled');
        return textResponse(taskResponse(task.id, task.status, task.logLength));
    }
);

server.registerTool(
    'gemini.task.tail',
    {
        title: 'Stream Gemini task log',
        description: 'Incrementally read task output using an offset cursor.',
        inputSchema: tailLogSchema
    },
    async ({ taskId, offset }, _extra) => {
        const task = tasks.get(taskId);
        if (!task) {
            return textResponse({ error: 'Task not found' });
        }
        const { chunk, nextOffset, size } = await readLogChunk(task, offset ?? 0);
        return textResponse({
            chunk,
            nextOffset,
            status: task.status,
            done: completedStatuses.includes(task.status) && nextOffset >= size,
            logUri: `tasks://${task.id}/log`
        });
    }
);

server.registerTool(
    'fs.read',
    {
        title: 'Read UTF-8 file',
        description: 'Quick read helper flagged as readOnly.',
        inputSchema: fileReadSchema
    },
    async ({ file }, _extra) => {
        try {
            const target = resolveWorkspacePath(file);
            const data = await fs.readFile(target, 'utf8');
            return textResponse(data);
        } catch (error) {
            return textResponse({ error: serializeErrorForClient(error) });
        }
    }
);

server.registerTool(
    'fs.write',
    {
        title: 'Write UTF-8 file',
        description: 'Persist contents to disk using Gemini worker context.',
        inputSchema: fileWriteSchema
    },
    async ({ file, contents }, _extra) => {
        try {
            const target = resolveWorkspacePath(file);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, contents, 'utf8');
            return textResponse({ ok: true, file });
        } catch (error) {
            return textResponse({ error: serializeErrorForClient(error) });
        }
    }
);

server.registerTool(
    'code.analyze',
    {
        title: 'Analyze multiple files with Gemini',
        description: 'Package files plus instructions into Gemini CLI.',
        inputSchema: analyzeSchema
    },
    async ({ paths, prompt, subcommand, cwd, timeoutMs, priority }, _extra) => {
        try {
            ensureCliReady();
            const parts = [`# Instruction\n${prompt ?? 'Analyze the provided files.'}\n`, '# Files'];
            for (const rel of paths) {
                try {
                    const abs = resolveWorkspacePath(rel);
                    if (!(await fileExists(abs))) {
                        parts.push(`\n--- FILE: ${rel} (missing) ---`);
                        continue;
                    }
                    const content = await fs.readFile(abs, 'utf8');
                    parts.push(`\n--- FILE: ${rel} ---\n${content}`);
                } catch (error) {
                    parts.push(`\n--- FILE: ${rel} (unreadable) ---\n${formatWorkspaceError(error)}`);
                }
            }
            const resolvedSubcommand = subcommand ?? 'code';
            const command = tokenizeCommandLine(resolvedSubcommand);
            if (command.length === 0) {
                throw new Error('Gemini code.analyze subcommand cannot be empty.');
            }
            const effectiveTimeout =
                timeoutMs ?? defaultTimeouts['code.analyze'] ?? undefined;
            const resolvedPriority = priority ?? defaultPriorities['code.analyze'];
            ensureQueueCapacity();
            const task = await createTask(
                'code.analyze',
                { paths, prompt, subcommand, timeoutMs: effectiveTimeout, priority: resolvedPriority },
                command,
                parts.join('\n'),
                cwd,
                effectiveTimeout,
                resolvedPriority
            );
            return textResponse(taskResponse(task.id, task.status, task.logLength));
        } catch (error) {
            return textResponse({ error: serializeErrorForClient(error) });
        }
    }
);

server.registerTool(
    'tests.run',
    {
        title: 'Run repo tests/lints via Gemini CLI',
        description: 'Hand off noisy CI chores to Gemini workers.',
        inputSchema: testSchema
    },
    async ({ command, args, cwd, timeoutMs, priority }, _extra) => {
        try {
            ensureCliReady();
            const resolvedCommand = command ?? 'npm';
            const resolvedArgs = args ?? ['test'];
            const effectiveTimeout =
                timeoutMs ?? defaultTimeouts['tests.run'] ?? undefined;
            const resolvedPriority = priority ?? defaultPriorities['tests.run'];
            ensureQueueCapacity();
            const task = await createTask(
                'tests.run',
                {
                    command: resolvedCommand,
                    args: resolvedArgs,
                    timeoutMs: effectiveTimeout,
                    priority: resolvedPriority
                },
                [resolvedCommand, ...resolvedArgs],
                undefined,
                cwd,
                effectiveTimeout,
                resolvedPriority
            );
            return textResponse(taskResponse(task.id, task.status, task.logLength));
        } catch (error) {
            return textResponse({ error: serializeErrorForClient(error) });
        }
    }
);

server.registerTool(
    'code.format.batch',
    {
        title: 'Batch format or refactor files',
        description: 'Send snippets to Gemini for repetitive formatting or documentation edits.',
        inputSchema: formatSchema
    },
    async ({ files, formatter, extraArgs, cwd, timeoutMs, priority }, _extra) => {
        try {
            ensureCliReady();
            const resolvedFormatter = formatter ?? 'code edit';
            const buffer: string[] = [`Apply ${resolvedFormatter} to the following files.`];
            for (const rel of files) {
                try {
                    const abs = resolveWorkspacePath(rel);
                    if (!(await fileExists(abs))) {
                        buffer.push(`\n--- FILE: ${rel} (missing) ---`);
                        continue;
                    }
                    const content = await fs.readFile(abs, 'utf8');
                    buffer.push(`\n--- FILE: ${rel} ---\n${content}`);
                } catch (error) {
                    buffer.push(`\n--- FILE: ${rel} (unreadable) ---\n${formatWorkspaceError(error)}`);
                }
            }
            const formatterTokens = tokenizeCommandLine(resolvedFormatter);
            if (formatterTokens.length === 0) {
                throw new Error('code.format.batch formatter command cannot be empty.');
            }
            const command = [...formatterTokens, ...(extraArgs ?? [])];
            const effectiveTimeout =
                timeoutMs ?? defaultTimeouts['code.format.batch'] ?? undefined;
            const resolvedPriority = priority ?? defaultPriorities['code.format.batch'];
            ensureQueueCapacity();
            const task = await createTask(
                'code.format.batch',
                {
                    files,
                    formatter: resolvedFormatter,
                    timeoutMs: effectiveTimeout,
                    priority: resolvedPriority
                },
                command,
                buffer.join('\n'),
                cwd,
                effectiveTimeout,
                resolvedPriority
            );
            return textResponse(taskResponse(task.id, task.status, task.logLength));
        } catch (error) {
            return textResponse({ error: serializeErrorForClient(error) });
        }
    }
);

server.registerTool(
    'gemini.task.suggest',
    {
        title: 'Suggest delegable Gemini tasks',
        description: 'Heuristically suggest background tasks suitable for workers.',
        inputSchema: suggestSchema
    },
    async ({ limit }, _extra) => {
        const suggestions = await buildSuggestions(limit ?? 5);
        return textResponse({ suggestions });
    }
);

async function createTask(
    toolName: string,
    args: Record<string, unknown>,
    command: string[],
    stdinText?: string,
    cwd?: string,
    timeoutMs?: number,
    priority = 0
) {
    const taskCwd = resolveTaskCwd(cwd);
    const id = randomUUID();
    await ensureStateDirs();
    const logFile = path.join(logDir, `${id}.log`);
    await fs.writeFile(logFile, '', 'utf8');
    const now = Date.now();
    const task: TaskRecord = {
        id,
        toolName,
        args,
        cmd: command,
        cwd: taskCwd,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        logLength: 0,
        logFile,
        timeoutMs,
        priority
    };
    tasks.set(id, task);
    taskEvents.emit('update', task);
    persistence.schedulePersist();
    // Inject a short instruction prompting the agent to run silently and
    // avoid spawning new terminal windows. This is a lightweight mitigation
    // that asks Gemini to keep subsequent calls non-interactive; it cannot
    // fully guarantee behavior but reduces accidental external windows.
    const injectedStdin = stdinText ? `${SILENT_EXEC_PROMPT}\n${stdinText}` : `${SILENT_EXEC_PROMPT}\n`;
    enqueueCliTask(task, injectedStdin);
    return task;
}

function enqueueCliTask(task: TaskRecord, stdinText?: string) {
    const jobId = pool.enqueue(async (signal) => {
        const finalize = async (status: TaskStatus, error?: string) => {
            task.jobId = undefined;
            markTaskStatus(task, status, error);
            if (completedStatuses.includes(status)) {
                try {
                    // Wait a tick to allow the WorkerPool to decrement its running
                    // count (which happens in the pool pump's finally) before
                    // persisting the live status. This avoids a race where the
                    // status file is written while the pool still reports the
                    // task as running.
                    await new Promise((resolve) => setImmediate(resolve));
                    await persistence.flushPendingPersistence();
                } catch (err) {
                    // best-effort
                }
            }
        };
        if (signal.aborted) {
            appendLog(task, '\nAborted before start.');
            await finalize('canceled');
            return;
        }
        appendLog(task, `Working directory: ${task.cwd ?? workspaceRoot}\n`);
        markTaskStatus(task, 'running');
        task.startedAt = task.startedAt ?? Date.now();
        let canceledDuringRun = false;
        const stderrBuffer: string[] = [];
        const { command, args } = buildSpawnCommand(task.cmd);
        const child = spawn(command, args, {
            cwd: task.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            // Keep child in the same process group where possible so termination
            // of the parent/child tree is more reliable across platforms.
            detached: false,
            windowsHide: process.platform === 'win32'
        });

        const timeoutTimer = task.timeoutMs
            ? setTimeout(() => {
                  canceledDuringRun = true;
                  appendLog(task, `\nTimed out after ${task.timeoutMs}ms, terminating.`);
                  terminateProcessTree(child);
              }, task.timeoutMs)
            : undefined;

        signal.addEventListener('abort', () => {
            canceledDuringRun = true;
            appendLog(task, '\nCancellation requested.');
            terminateProcessTree(child);
        });

        if (stdinText) {
            child.stdin.write(stdinText);
            child.stdin.end();
        }

        child.stdout.on('data', (chunk: Buffer) => {
            appendLog(task, chunk.toString());
        });
        child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            stderrBuffer.push(text);
            appendLog(task, text);
        });

        let exitCode: number | null;
            try {
                exitCode = await new Promise<number | null>((resolve, reject) => {
                    child.on('error', reject);
                    child.on('close', (code) => resolve(code));
                });
            } catch (error) {
                const message = formatWorkspaceError(error);
                appendLog(task, `\n${message}`);
                await finalize('failed', message);
                maybeUpdateCliStatusFromFailure(message);
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                }
                return;
            }

        if (timeoutTimer) {
            clearTimeout(timeoutTimer);
        }

        task.exitCode = exitCode ?? undefined;
        if (canceledDuringRun) {
            await finalize('canceled');
            return;
        }
        if (exitCode === 0) {
            await finalize('succeeded');
        } else {
            const stderrText = stderrBuffer.join('').trim() || `Gemini exited with code ${exitCode ?? -1}`;
            maybeUpdateCliStatusFromFailure(stderrText);
            await finalize('failed', stderrText);
        }
    });
    task.jobId = jobId;
}

function textResponse(payload: unknown) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    return { content: [{ type: 'text' as const, text }] };
}

function taskResponse(taskId: string, status: string, nextOffset = 0) {
    return {
        taskId,
        status,
        logUri: `tasks://${taskId}/log`,
        nextOffset
    };
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

function ensureQueueCapacity() {
    if (pool.queuedCount() >= maxQueueSize) {
        throw new StructuredError('QUEUE_FULL', `Queue is full (limit ${maxQueueSize}). Try again later.`);
    }
}

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
        console.log(`[task] ${task.id} status ${prev} -> ${status} (jobId=${task.jobId ?? 'nil'})`);
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
        console.error(`Failed to append log to ${logFile}`, error);
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
            console.error('Failed to release state lock', err);
        }
    } catch (error) {
        console.error('Failed to flush tasks during shutdown', error);
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

async function readPackageJson() {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    if (!(await fileExists(pkgPath))) {
        return undefined;
    }
    try {
        const raw = await fs.readFile(pkgPath, 'utf8');
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

async function countWorkspaceFiles(limit = suggestSampleLimit) {
    let count = 0;
    const queue: string[] = [workspaceRoot];
    while (queue.length > 0 && count < limit) {
        const current = queue.pop();
        if (!current) {
            break;
        }
        try {
            const entries = await fs.readdir(current, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    // skip hidden/system directories
                    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
                        continue;
                    }
                    queue.push(full);
                } else {
                    count += 1;
                    if (count >= limit) {
                        break;
                    }
                }
            }
        } catch {
            // ignore traversal errors
        }
    }
    return count;
}

async function buildSuggestions(limit: number) {
    const suggestions: Array<Record<string, unknown>> = [];
    const pkg = await readPackageJson();
    const scripts = (pkg?.scripts as Record<string, string> | undefined) ?? {};

    if (scripts.test && suggestions.length < limit) {
        suggestions.push({
            title: 'Run test suite',
            tool: 'tests.run',
            args: {
                command: 'npm',
                args: ['test'],
                timeoutMs: defaultTimeouts['tests.run'],
                priority: defaultPriorities['tests.run']
            },
            reason: 'package.json defines a test script; offload CI-style checks to a worker.',
            priority: defaultPriorities['tests.run']
        });
    }

    if (scripts.lint && suggestions.length < limit) {
        suggestions.push({
            title: 'Run lint',
            tool: 'tests.run',
            args: {
                command: 'npm',
                args: ['run', 'lint'],
                timeoutMs: defaultTimeouts['tests.run'],
                priority: defaultPriorities['tests.run']
            },
            reason: 'Lint script detected; useful for static checks while coding continues.',
            priority: defaultPriorities['tests.run']
        });
    }

    if (scripts.format && suggestions.length < limit) {
        suggestions.push({
            title: 'Run formatter',
            tool: 'tests.run',
            args: {
                command: 'npm',
                args: ['run', 'format'],
                timeoutMs: defaultTimeouts['code.format.batch'],
                priority: defaultPriorities['code.format.batch']
            },
            reason: 'Format script detected; can tidy files in background.',
            priority: defaultPriorities['code.format.batch']
        });
    }

    const fileSampleCount = await countWorkspaceFiles();
    if (fileSampleCount >= 100 && suggestions.length < limit) {
        suggestions.push({
            title: 'Summarize codebase hotspots',
            tool: 'code.analyze',
            args: {
                paths: ['src'],
                prompt: 'Summarize major modules and surface TODO/FIXME clusters.',
                timeoutMs: defaultTimeouts['code.analyze'],
                priority: defaultPriorities['code.analyze']
            },
            reason: 'Large workspace detected; a quick summary helps navigation.',
            priority: defaultPriorities['code.analyze']
        });
    }

    if (suggestions.length === 0) {
        suggestions.push({
            title: 'Basic status check',
            tool: 'gemini.task.list',
            args: { limit: 20 },
            reason: 'No obvious automation hooks detected; list tasks to decide next actions.',
            priority: 0
        });
    }

    return suggestions.slice(0, limit);
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
        } catch (error) {
            const message = formatWorkspaceError(error);
            const state = classifyCliFailure(message);
            // Only force marking the CLI as unavailable for high-confidence states
            // like 'missing' or 'quota_exhausted'. Generic 'error' should not
            // immediately force a global failure since it may be transient.
            const shouldForce = state !== 'error';
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
    // Do not be aggressive about cancelling running tasks for transient
    // failures. Only force-cancel when we have a high-confidence unusable
    // state (e.g., 'missing' or 'quota_exhausted') or when caller set force.
    if (!options?.force && state === 'error') {
        // transient, record status but do not cancel running tasks
        acceptingTasks = false;
        cliStatus = { state, message, lastChecked: Date.now() };
        persistence.scheduleStatusSnapshot();
        void persistence.persistLiveStatus();
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
    void persistence.persistLiveStatus();
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
    await validateGeminiExecutable();
    await updateCliStatus('startup');
    await persistence.loadPersistedTasks();
    // Load and register tool metadata from mcp.json (manifest)
    await loadMcpManifest();
    await persistence.pruneOldTasks();
    await persistence.persistLiveStatus();
    startCliHealthWatcher();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

async function loadMcpManifest() {
    try {
        const manifestPath = path.join(workspaceRoot, 'mcp.json');
        if (!(await fileExists(manifestPath))) {
            // No manifest present; nothing to do
            return;
        }
        const raw = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw) as any;
        console.log(`Loaded MCP manifest with ${((manifest.tools && manifest.tools.length) || 0)} tools`);
        // Attach manifest to server for inspection by clients if needed
        try {
            (server as any)._mcpManifest = manifest;
        } catch { /* ignore */ }

        const manifestDir = path.dirname(manifestPath);
        const externalCache: Record<string, any> = {};
        for (const t of manifest.tools || []) {
            try {
                // If server exposes a hasTool method or internal tools map, try to detect pre-existing registration
                const hasTool = (server as any).hasTool?.(t.name) ?? Boolean((server as any)._tools && (server as any)._tools[t.name]);
                if (hasTool) {
                    // already registered by code; skip
                    continue;
                }
                // Register a lightweight metadata-only handler for tools not implemented server-side yet.
                // Convert the manifest's JSON Schema to a zod schema when possible,
                // so clients/models receive a stricter inputSchema.
                let resolvedArgs: any = undefined;
                try {
                    if (t.arguments) {
                        resolvedArgs = await dereferenceSchema(t.arguments, manifest, manifestDir, externalCache);
                    }
                } catch (refErr) {
                    console.warn(`Failed to dereference schema for tool ${t.name}:`, refErr);
                    resolvedArgs = t.arguments;
                }
                const inputSchemaZod = resolvedArgs ? jsonSchemaToZod(resolvedArgs) : z.any().optional();
                server.registerTool(
                    t.name,
                    {
                        title: t.title ?? t.name,
                        description: t.description ?? '',
                        inputSchema: inputSchemaZod
                    },
                    async (_input, _extra) => {
                        return textResponse({ error: 'Tool advertised in mcp.json but no server-side handler is implemented.' });
                    }
                );
                console.log(`Advertised tool: ${t.name}`);
            } catch (err) {
                console.warn(`Failed to advertise tool ${t.name}:`, err);
            }
        }
    } catch (err) {
        console.error('Failed to load mcp.json manifest:', err);
    }
}

registerShutdownHandlers();

// Allow tests or embedding tools to import the module without auto-starting
// the server. Set `GEMINI_MCP_SKIP_START=1` in the environment to prevent
// automatic start (used by unit tests).
if (!process.env.GEMINI_MCP_SKIP_START) {
    start().catch((err) => {
        console.error('Failed to start Gemini CLI MCP server', err);
        process.exit(1);
    });
}

export { server };
