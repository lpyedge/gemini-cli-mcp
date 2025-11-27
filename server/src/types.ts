export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface TaskRecord {
    id: string;
    toolName: string;
    args: Record<string, unknown>;
    cmd: string[];
    cwd: string;
    status: TaskStatus;
    createdAt: number;
    updatedAt: number;
    startedAt?: number;
    completedAt?: number;
    exitCode?: number;
    logLength: number;
    error?: string;
    jobId?: number;
    logFile: string;
    log?: string[];
    timeoutMs?: number;
    priority?: number;
    lastLogLine?: string;
}
