import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CliHealthState, CliStatusSnapshot, GeminiConfig } from './types';

// Manages checking the Gemini CLI health and exposing a change event.
// This class executes `gemini --version` to determine whether the CLI is present,
// and classifies common failures like missing binary or quota exhaustion.
export class GeminiCliHealth implements vscode.Disposable {
    private status: CliStatusSnapshot = { state: 'unknown', message: 'Gemini CLI health not checked yet.' };
    private checking: Promise<void> | undefined;
    private lastConfigKey: string | undefined;
    private readonly DEBOUNCE_MS = 3000;
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.onDidChangeEmitter.event;
    private readonly output?: vscode.OutputChannel;

    constructor(output?: vscode.OutputChannel) {
        this.output = output;
    }

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
        const configKey = this.buildConfigKey(config);
        // If a check is already running, return it so callers can await the same promise.
        if (this.checking) {
            return this.checking;
        }

        // If the requested config matches the last requested config and we
        // recently checked, skip re-checking to avoid thrash.
        const lastChecked = this.status?.lastChecked ?? 0;
        const now = Date.now();
        if (this.lastConfigKey === configKey && now - lastChecked < this.DEBOUNCE_MS) {
            // Diagnostic
            try {
                const skipMsg = `Skipping health check; recent check performed ${now - lastChecked}ms ago for ${configKey}`;
                if (this.output) this.output.appendLine(`DEBUG: ${skipMsg}`); else console.log(skipMsg);
            } catch { /* ignore */ }
            return Promise.resolve();
        }

        // update the remembered config key and mark as checking
        this.lastConfigKey = configKey;
        const prevState = this.status && this.status.state;
        this.status = { state: 'checking', message: 'Checking Gemini CLI...' };
        if (prevState !== this.status.state) {
            this.onDidChangeEmitter.fire();
        }
        // Diagnostic: report platform and configured geminiPath to help debug
        try {
            const msg = `Gemini CLI health check: platform=${process.platform} arch=${process.arch} configuredGeminiPath=${String(
                config.geminiPath
            )}`;
            if (this.output) {
                this.output.appendLine(msg);
            } else {
                console.log(msg);
            }
        } catch (e) {
            // ignore logging errors
        }
        // Short-circuit if geminiPath is not configured. If a simple command
        // name is provided (e.g. `gemini`), do NOT perform a raw filesystem
        // existence check because the executable may be resolved via PATH.
        // Only perform fs.existsSync for explicit paths (absolute or containing
        // path separators) to avoid false negatives when users configure the
        // command name instead of an absolute path.
        if (!config.geminiPath) {
            this.status = { state: 'missing', message: 'geminiPath not configured' };
            this.onDidChangeEmitter.fire();
            return Promise.resolve();
        }
        const looksLikePath = path.isAbsolute(config.geminiPath) || config.geminiPath.includes(path.sep) || config.geminiPath.includes('/');
        if (looksLikePath && !fs.existsSync(config.geminiPath)) {
            // Configured path looks like an explicit path but the file is missing.
            // Do NOT immediately fail; try a shell-based lookup (e.g. `cmd /c`) using
            // the basename of the configured value so that PATH-resolved installs
            // can still be detected. Log the situation for diagnostics.
            try {
                const warn = `Configured geminiPath not found on disk: ${config.geminiPath}. Will attempt shell lookup.`;
                if (this.output) {
                    this.output.appendLine(`WARN: ${warn}`);
                } else {
                    console.warn(warn);
                }
            } catch (e) {
                /* ignore */
            }
            const fallbackCmd = path.basename(config.geminiPath || 'gemini');
            // Attempt to execute fallback command via shell resolution.
            this.checking = this.executeVersion({ ...config, geminiPath: fallbackCmd })
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
            let finished = false;
            const timeoutMs = 15000;
            const timer = setTimeout(() => {
                if (!finished) {
                    finished = true;
                    try { child.kill('SIGKILL'); } catch {}
                    reject(new Error('Gemini CLI health check timed out (10s)'));
                }
            }, timeoutMs);
            child.stdout?.on('data', (chunk) => {
                stdout += chunk.toString();
            });
            child.stderr?.on('data', (chunk) => {
                stderr += chunk.toString();
            });
            child.on('error', (error) => {
                if (!finished) {
                    finished = true;
                    clearTimeout(timer);
                    reject(error);
                }
            });
            child.on('close', (code) => {
                if (!finished) {
                    finished = true;
                    clearTimeout(timer);
                    if (code === 0) {
                        resolve((stdout || stderr).trim());
                    } else {
                        const text = (stderr || stdout || `Gemini CLI exited with code ${code}`).trim();
                        reject(new Error(text));
                    }
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
