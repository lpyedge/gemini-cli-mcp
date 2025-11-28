import * as vscode from 'vscode';

// Shared types used by the extension modules

export interface GeminiConfig {
    geminiPath: string;
    maxWorkers: number;
    taskCwd: string | undefined;
    maxQueue: number;
    defaultTimeouts: TimeoutConfig;
    defaultPriorities: PriorityConfig;
    unhealthyStates?: string[];
}

export interface TimeoutConfig {
    testsRun: number;
    codeAnalyze: number;
    codeFormat: number;
    taskSubmit: number;
}

export interface PriorityConfig {
    testsRun: number;
    codeAnalyze: number;
    codeFormat: number;
    taskSubmit: number;
}

export interface LiveStatusSnapshot {
    running: number;
    queued: number;
    maxWorkers: number;
    queueLimit: number;
    updatedAt: number;
    tasks: LiveTaskSummary[];
    cliStatus?: ServerCliStatus;
}

export interface LiveTaskSummary {
    id: string;
    toolName: string;
    status: string;
    createdAt: number;
    startedAt?: number;
    updatedAt: number;
    completedAt?: number;
    lastLogLine?: string;
    priority?: number;
}

export type CliHealthState = 'unknown' | 'checking' | 'ok' | 'missing' | 'quota_exhausted' | 'error';

export interface CliStatusSnapshot {
    state: CliHealthState;
    message: string;
    lastChecked?: number;
    version?: string;
}

export type ServerCliStatus = CliStatusSnapshot;

export { vscode };
