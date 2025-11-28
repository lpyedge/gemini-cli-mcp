import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { CliHealthState, CliStatusSnapshot, GeminiConfig } from './types';

// Manages checking the Gemini CLI health and exposing a change event.
// This class executes `gemini --version` to determine whether the CLI is present,
// and classifies common failures like missing binary or quota exhaustion.
export class GeminiCliHealth implements vscode.Disposable {
    private status: CliStatusSnapshot = { state: 'unknown', message: 'Gemini CLI health not checked yet.' };
    private checking: Promise<void> | undefined;
    private lastConfigKey: string | undefined;
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.onDidChangeEmitter.event;

    dispose() {
        this.onDidChangeEmitter.dispose();
    }

    getStatus(): CliStatusSnapshot {
        return this.status;
    }

    isHealthy() {
        return this.status.state === 'ok';
    }

    async refresh(config: GeminiConfig) {
        this.lastConfigKey = this.buildConfigKey(config);
        await this.runCheck(config);
    }

    private buildConfigKey(config: GeminiConfig) {
        return `${config.geminiPath}#${config.taskCwd ?? ''}`;
    }

    private runCheck(config: GeminiConfig) {
        if (this.checking) {
            return this.checking;
        }
        this.status = { state: 'checking', message: 'Checking Gemini CLI...' };
        this.onDidChangeEmitter.fire();
        this.checking = this.executeVersion(config)
            .then((versionInfo) => {
                const version = versionInfo.trim() || 'Gemini CLI';
                this.status = {
                    state: 'ok',
                    message: version,
                    version,
                    lastChecked: Date.now()
                };
            })
            .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                const state = this.classifyFailure(message);
                this.status = {
                    state,
                    message,
                    lastChecked: Date.now()
                };
            })
            .finally(() => {
                this.checking = undefined;
                this.onDidChangeEmitter.fire();
            });
        return this.checking;
    }

    private executeVersion(config: GeminiConfig) {
        return new Promise<string>((resolve, reject) => {
            const child = spawn(config.geminiPath, ['--version'], {
                shell: process.platform === 'win32',
                windowsHide: process.platform === 'win32'
            });
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (chunk) => {
                stdout += chunk.toString();
            });
            child.stderr?.on('data', (chunk) => {
                stderr += chunk.toString();
            });
            child.on('error', (error) => {
                reject(error);
            });
            child.on('close', (code) => {
                if (code === 0) {
                    resolve((stdout || stderr).trim());
                } else {
                    const text = (stderr || stdout || `Gemini CLI exited with code ${code}`).trim();
                    reject(new Error(text));
                }
            });
        });
    }

    private classifyFailure(message: string): CliHealthState {
        const lower = message.toLowerCase();
        if (lower.includes('quota') || lower.includes('credit')) {
            return 'quota_exhausted';
        }
        if (lower.includes('enoent') || lower.includes('not found') || lower.includes('is not recognized')) {
            return 'missing';
        }
        return 'error';
    }
}
