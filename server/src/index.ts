import { randomUUID } from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WorkerPool } from './workerPool.js';
import { TaskRecord, TaskStatus } from './types.js';

const geminiBin = resolveGeminiBinary(process.env.GEMINI_CLI || 'gemini');
const workerCount = Number(process.env.GEMINI_MAX_WORKERS || '3');
const rawWorkspaceRootEnv = (process.env.GEMINI_TASK_CWD ?? '').trim();
if (!rawWorkspaceRootEnv) {
    console.error('Gemini CLI MCP server requires GEMINI_TASK_CWD to be set.');
    process.exit(1);
}
const workspaceRoot = resolveWorkspaceRoot(rawWorkspaceRootEnv);
const stateDir = path.join(workspaceRoot, '.vscode', 'gemini-mcp');
const logDir = path.join(stateDir, 'logs');
const stateFile = path.join(stateDir, 'tasks.json');
const statusFile = path.join(stateDir, 'status.json');
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
type CliHealthState = 'unknown' | 'ok' | 'missing' | 'quota_exhausted' | 'error';
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
taskEvents.on('update', () => scheduleStatusSnapshot());
const pool = new WorkerPool(workerCount);

const server = new McpServer({
    name: 'gemini-cli-mcp',
    version: '0.2.0'
});

const taskSchema = z.object({
    command: z.array(z.string()).nonempty(),
    stdin: z.string().optional(),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    priority: z.number().int().min(-5).max(5).optional()
});

const analyzeSchema = z.object({
    paths: z.array(z.string()).nonempty(),
    prompt: z.string().optional(),
    subcommand: z.string().default('code'),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    priority: z.number().int().min(-5).max(5).optional()
});

const testSchema = z.object({
    command: z.string().default('npm'),
    args: z.array(z.string()).default(['test']),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    priority: z.number().int().min(-5).max(5).optional()
});

const formatSchema = z.object({
    files: z.array(z.string()).nonempty(),
    formatter: z.string().default('code edit'),
    extraArgs: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
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
            return textResponse({ error: formatWorkspaceError(error) });
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
        const result = await pruneOldTasks(windowMs);
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
            return textResponse({ error: formatWorkspaceError(error) });
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
            return textResponse({ error: formatWorkspaceError(error) });
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
            return textResponse({ error: formatWorkspaceError(error) });
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
            return textResponse({ error: formatWorkspaceError(error) });
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
            return textResponse({ error: formatWorkspaceError(error) });
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
    schedulePersist();
    enqueueCliTask(task, stdinText);
    return task;
}

function enqueueCliTask(task: TaskRecord, stdinText?: string) {
    const jobId = pool.enqueue(async (signal) => {
        const finalize = (status: TaskStatus, error?: string) => {
            task.jobId = undefined;
            markTaskStatus(task, status, error);
        };
        if (signal.aborted) {
            appendLog(task, '\nAborted before start.');
            finalize('canceled');
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
            detached: true
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
            finalize('failed', message);
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
            finalize('canceled');
            return;
        }
        if (exitCode === 0) {
            finalize('succeeded');
        } else {
            const stderrText = stderrBuffer.join('').trim() || `Gemini exited with code ${exitCode ?? -1}`;
            maybeUpdateCliStatusFromFailure(stderrText);
            finalize('failed', stderrText);
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

function normalizeTemplateVariable(value?: string | string[]) {
    if (!value) {
        return undefined;
    }
    return Array.isArray(value) ? value[0] : value;
}

function tokenizeCommandLine(input: string) {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | undefined;
    let escaping = false;
    for (let i = 0; i < input.length; i += 1) {
        const char = input[i];
        if (quote) {
            if (escaping) {
                current += char;
                escaping = false;
                continue;
            }
            if (char === '\\') {
                escaping = true;
                continue;
            }
            if (char === quote) {
                quote = undefined;
                continue;
            }
            current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }
    if (escaping) {
        current += '\\';
    }
    if (quote) {
        throw new Error('Unterminated quoted argument in formatter or subcommand.');
    }
    if (current.length > 0) {
        tokens.push(current);
    }
    return tokens;
}

function ensureQueueCapacity() {
    if (pool.queuedCount() >= maxQueueSize) {
        throw new Error(`Queue is full (limit ${maxQueueSize}). Try again later.`);
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
    schedulePersist();
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
    taskEvents.emit('update', task);
    schedulePersist();
    if (completedStatuses.includes(status)) {
        void pruneOldTasks(retentionMs);
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

function normalizeForComparison(target: string) {
    return path.normalize(target).toLowerCase();
}

function resolveWorkspaceRoot(input: string) {
    return path.isAbsolute(input) ? path.normalize(input) : path.resolve(process.cwd(), input);
}

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

function terminateProcessTree(child: ChildProcess) {
    const pid = child.pid;
    if (!pid) {
        child.kill();
        return;
    }
    if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', pid.toString(), '/t', '/f']);
    } else {
        try {
            process.kill(-pid, 'SIGTERM');
        } catch {
            // ignore
        }
        child.kill();
    }
}

async function persistTasks() {
    await ensureStateDirs();
    const payload = Array.from(tasks.values()).map((task) => {
        const { log, ...rest } = task;
        return rest;
    });
    await fs.writeFile(stateFile, JSON.stringify(payload, null, 2), 'utf8');
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
    await ensureStateDirs();
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
        queueLimit: maxQueueSize,
        cliStatus,
        tasks: snapshotTasks
    };
}

async function loadPersistedTasks() {
    try {
        const raw = await fs.readFile(stateFile, 'utf8');
        const saved: TaskRecord[] = JSON.parse(raw);
        await ensureStateDirs();
        for (const record of saved) {
            record.logFile = record.logFile ?? path.join(logDir, `${record.id}.log`);
            try {
                record.cwd = assertAllowedTaskCwd(record.cwd);
            } catch (error) {
                record.status = 'failed';
                record.error = formatWorkspaceError(error);
            }
            if (record.log && record.log.length > 0 && !(await fileExists(record.logFile))) {
                const buffer = record.log.join('');
                await fs.writeFile(record.logFile, buffer, 'utf8');
                record.logLength = Buffer.byteLength(buffer, 'utf8');
            } else if (await fileExists(record.logFile)) {
                const stat = await fs.stat(record.logFile);
                record.logLength = stat.size;
            } else {
                record.logLength = record.logLength ?? 0;
            }
            record.log = undefined;
            if (!completedStatuses.includes(record.status)) {
                record.status = 'failed';
                record.error = 'Server restarted while task was running.';
                record.updatedAt = Date.now();
                record.completedAt = record.completedAt ?? Date.now();
            }
            record.jobId = undefined;
            tasks.set(record.id, record);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('Failed to load Gemini CLI MCP task state', error);
        }
    }
}

async function pruneOldTasks(olderThanMs = retentionMs) {
    const cutoff = Date.now() - olderThanMs;
    let removedTasks = 0;
    let removedLogs = 0;
    for (const [id, task] of Array.from(tasks.entries())) {
        if (completedStatuses.includes(task.status) && task.updatedAt < cutoff) {
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
        await flushPendingPersistence();
    } catch (error) {
        console.error('Failed to flush tasks during shutdown', error);
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

function formatWorkspaceError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

async function validateGeminiExecutable() {
    if (geminiBin.includes(path.sep)) {
        try {
            await fs.access(geminiBin);
        } catch {
            throw new Error(`Gemini CLI not found at ${geminiBin}`);
        }
    }
}

function resolveGeminiBinary(raw: string) {
    if (process.platform === 'win32') {
        const hasSeparator = raw.includes(path.sep);
        const ext = path.extname(raw).toLowerCase();
        if (hasSeparator && !ext) {
            const withCmd = `${raw}.cmd`;
            const withExe = `${raw}.exe`;
            if (fsSync.existsSync(withCmd)) {
                return withCmd;
            }
            if (fsSync.existsSync(withExe)) {
                return withExe;
            }
        }
    }
    return raw;
}

function buildSpawnCommand(taskArgs: string[]) {
    if (process.platform === 'win32') {
        const ext = path.extname(geminiBin).toLowerCase();
        if (ext === '.cmd' || ext === '.bat') {
            return {
                command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
                args: ['/c', geminiBin, ...taskArgs]
            };
        }
    }
    return { command: geminiBin, args: taskArgs };
}

async function execGeminiCommand(args: string[], timeoutMs = 10000) {
    const { command, args: spawnArgs } = buildSpawnCommand(args);
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(command, spawnArgs, {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        const timer = timeoutMs
            ? setTimeout(() => {
                  child.kill();
                  reject(new Error('Timed out during Gemini CLI health check.'));
              }, timeoutMs)
            : undefined;
        child.on('error', (error) => {
            if (timer) {
                clearTimeout(timer);
            }
            reject(error);
        });
        child.on('close', (code) => {
            if (timer) {
                clearTimeout(timer);
            }
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                const text = (stderr || stdout || `Gemini CLI exited with code ${code}`).trim();
                reject(new Error(text));
            }
        });
    });
}

async function updateCliStatus(reason: string) {
    if (cliCheckPromise) {
        await cliCheckPromise;
        return;
    }
    cliCheckPromise = (async () => {
        try {
            const { stdout, stderr } = await execGeminiCommand(['--version']);
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
        } catch (error) {
            const message = formatWorkspaceError(error);
            cliStatus = {
                state: classifyCliFailure(message),
                message: `${message} [${reason}]`,
                lastChecked: Date.now()
            };
        } finally {
            cliCheckPromise = undefined;
            scheduleStatusSnapshot();
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
    return 'error';
}

function maybeUpdateCliStatusFromFailure(message: string) {
    if (!message) {
        return;
    }
    const trimmed = message.trim();
    const classification = classifyCliFailure(trimmed);
    if (classification !== 'error') {
        cliStatus = {
            state: classification,
            message: trimmed,
            lastChecked: Date.now()
        };
        scheduleStatusSnapshot();
    }
}

function ensureCliReady() {
    if (cliStatus.state === 'ok') {
        return;
    }
    throw new Error(`Gemini CLI unavailable (${cliStatus.message}).`);
}

function startCliHealthWatcher() {
    // Disable periodic polling to avoid hammering gemini --version.
}

function stopCliHealthWatcher() {
    // Nothing to stop; watcher is disabled.
}

function readTimeoutEnv(name: string, fallback: number) {
    const raw = process.env[name];
    if (!raw || raw.trim().length === 0) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }
    return parsed;
}

function readPriorityEnv(name: string, fallback: number) {
    const raw = process.env[name];
    if (!raw || raw.trim().length === 0) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    const clamped = Math.max(-5, Math.min(5, Math.trunc(parsed)));
    return clamped;
}

async function start() {
    await validateGeminiExecutable();
    await updateCliStatus('startup');
    await loadPersistedTasks();
    await pruneOldTasks();
    await persistLiveStatus();
    startCliHealthWatcher();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

registerShutdownHandlers();

start().catch((err) => {
    console.error('Failed to start Gemini CLI MCP server', err);
    process.exit(1);
});
