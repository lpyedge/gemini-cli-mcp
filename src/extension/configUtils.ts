import * as vscode from 'vscode';
import path from 'node:path';
import os from 'node:os';

import { GeminiConfig, TimeoutConfig, PriorityConfig, ModelBridgeConfig, ModelBridgeMode } from './types';

// Utility helpers for reading extension configuration and small format helpers.

const WINDOWS_STDIO_PATH = String.raw`\\.\pipe\gemini-mcp-bridge`;
const DEFAULT_STDIO_PATH = os.platform() === 'win32'
    ? WINDOWS_STDIO_PATH
    : path.join(os.tmpdir(), 'gemini-mcp-bridge.sock');

/**
 * Read the `geminiMcp` configuration from VS Code and return a typed config object.
 */
export function readConfig(): GeminiConfig {
    const config = vscode.workspace.getConfiguration('geminiMcp');
    const defaultTimeouts: TimeoutConfig = {
        testsRun: config.get<number>('defaultTimeouts.testsRun', 600000),
        codeAnalyze: config.get<number>('defaultTimeouts.codeAnalyze', 300000),
        codeFormat: config.get<number>('defaultTimeouts.codeFormat', 300000),
        taskSubmit: config.get<number>('defaultTimeouts.taskSubmit', 0)
    };
    const defaultPriorities: PriorityConfig = {
        testsRun: config.get<number>('defaultPriorities.testsRun', 0),
        codeAnalyze: config.get<number>('defaultPriorities.codeAnalyze', 0),
        codeFormat: config.get<number>('defaultPriorities.codeFormat', 0),
        taskSubmit: config.get<number>('defaultPriorities.taskSubmit', 0)
    };
    const defaultAllowedTools = [
        'gemini.task.submit',
        'gemini.task.suggest',
        'gemini.task.list',
        'gemini.task.status',
        'gemini.task.tail',
        'gemini.task.cancel',
        'gemini.task.prune',
        'fs.read',
        'fs.write',
        'code.analyze',
        'code.format.batch',
        'tests.run'
    ];
    const mode = config.get<ModelBridgeMode>('modelBridge.mode', 'stdio');
    const modelBridge: ModelBridgeConfig = {
        enabled: config.get<boolean>('modelBridge.enabled', false),
        mode,
        httpPort: config.get<number>('modelBridge.httpPort', 46871),
        stdioPath: config.get<string>('modelBridge.stdioPath', DEFAULT_STDIO_PATH),
        authToken: config.get<string>('modelBridge.authToken', ''),
        allowedTools: config.get<string[]>('modelBridge.allowedTools', defaultAllowedTools),
        allowOrchestrator: config.get<boolean>('modelBridge.allowOrchestrator', true),
        requestTimeoutMs: config.get<number>('modelBridge.requestTimeoutMs', 120000),
        captureSdkMessageId: config.get<'sdkHook' | 'bestEffort' | 'disabled'>('modelBridge.captureSdkMessageId', 'bestEffort')
    };
    return {
        geminiPath: config.get<string>('geminiPath', 'gemini'),
        maxWorkers: config.get<number>('maxWorkers', 3),
        taskCwd: config.get<string>('taskCwd'),
        maxQueue: config.get<number>('maxQueue', 200),
        defaultTimeouts,
        defaultPriorities,
        unhealthyStates: config.get<string[]>('unhealthyStates', ['missing']),
        modelBridge
    };
}

/**
 * Resolve a configured `taskCwd` value into an absolute path when possible.
 * Supports ${workspaceFolder} token, absolute paths and workspace-relative paths.
 */
export function resolveTaskCwd(raw: string | undefined): string | undefined {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!raw || raw.trim().length === 0) {
        return workspaceRoot;
    }
    if (raw.includes('${workspaceFolder}')) {
        if (!workspaceRoot) {
            return undefined;
        }
        return path.normalize(raw.replace(/\$\{workspaceFolder\}/g, workspaceRoot));
    }
    if (path.isAbsolute(raw)) {
        return path.normalize(raw);
    }
    if (workspaceRoot) {
        return path.normalize(path.join(workspaceRoot, raw));
    }
    return undefined;
}

/** Clamp priority into allowed integer range [-5, 5]. Accepts non-finite numbers.
 * Returns an integer in the allowed range.
 */
export function clampPriority(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(-5, Math.min(5, Math.trunc(value)));
}

/** Format a duration in milliseconds to a human-readable short string. */
export function formatDuration(ms: number) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return '';
    }
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hrs = Math.floor(minutes / 60);
    if (hrs > 0) {
        return `${hrs}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
}
