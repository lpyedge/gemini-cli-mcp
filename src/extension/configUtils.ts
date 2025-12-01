import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';

import { GeminiConfig, ModelBridgeConfig } from './types';
import { getToolNames } from './mcpManifest';

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
    // Load allowed tool names from the canonical `mcp.json` manifest.
    // Do NOT fall back to a hard-coded static list — keep `mcp.json` as the single source of truth.
    const manifestToolNames = getToolNames();
    const defaultAllowedTools = manifestToolNames ?? [];
    const modelBridge: ModelBridgeConfig = {
        enabled: config.get<boolean>('modelBridge.enabled', false),
        stdioPath: config.get<string>('modelBridge.stdioPath', DEFAULT_STDIO_PATH),
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
