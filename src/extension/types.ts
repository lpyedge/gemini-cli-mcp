import * as vscode from 'vscode';

// Shared types used by the extension modules

// ModelBridge used to support multiple transport modes. The extension
// currently only supports a local stdio/socket bridge, so the explicit
// `ModelBridgeMode` type and `mode` setting were removed in favor of
// a single stdio default.

export interface GeminiConfig {
    maxWorkers: number;
    taskCwd: string | undefined;
    maxQueue: number;
    unhealthyStates?: string[];
    modelBridge: ModelBridgeConfig;
}

export interface ModelBridgeConfig {
    enabled: boolean;
    allowedTools: string[];
    allowOrchestrator: boolean;
    requestTimeoutMs?: number;
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
