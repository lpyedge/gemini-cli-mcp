/**
 * geminiProvider.ts
 *
 * Strategy:
 *   1. Try @google/gemini-cli-core (Core mode).
 *      - Reuse Gemini CLI's auth (OAuth / API key / Vertex) via Config.refreshAuth().
 *      - This lets you piggyback on whatever the user has configured in CLI.
 *   2. If core is unavailable or fails in a "module not found" way, fall back to
 *      spawning `gemini --headless` (CLI mode).
 *
 * You can call `runBest()` as unified entry, or use `runWithCore()` / `runWithCli()` directly.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import fsSync from 'node:fs';
import { logger } from '../core/logger.js';

// Use 'any' type for dynamic import to avoid TypeScript errors when package is not installed
type GeminiCliCoreModule = any;
type GeminiConfig = any;

let coreImportPromise: Promise<GeminiCliCoreModule> | null = null;
// Optional override for the CLI binary path. This replaces the previous
// `spawnHelpers.geminiBin` mutable export so other modules can call
// `setGeminiBin()` when a persisted path is discovered.
// Track any detected explicit CLI path so the server may persist it.
let DETECTED_GEMINI_BIN: string | null = null;

export function getDetectedGeminiPath(): string | null {
    return DETECTED_GEMINI_BIN;
}

// Module name as a variable to prevent TypeScript from attempting to resolve it
const GEMINI_CORE_MODULE = '@google/gemini-cli-core';

// Execution mode tracking
export type GeminiMode = 'core' | 'cli' | 'unknown';

// Simple result type
export interface GeminiResult {
    from: GeminiMode;
    text: string;
    raw?: unknown;
    stdout?: string;
    stderr?: string;
}

// Provider initialization options
export interface GeminiProviderOptions {
    /**
     * Session ID for core's Config / Telemetry etc.
     * If not provided, auto-generates via randomUUID.
     */
    sessionId?: string;

    /**
     * Target directory: usually your workspace root (e.g., VS Code workspace root).
     * Used for file tools / context etc.
     * Defaults to process.cwd().
     */
    targetDir?: string;

    /**
     * Working directory: used for core / CLI execution cwd.
     * Defaults to process.cwd().
     */
    cwd?: string;

    /**
     * Default model name, e.g., "gemini-2.5-flash" / "gemini-2.5-pro" etc.
     * Defaults to GEMINI_MODEL env or core default.
     */
    model?: string;

    /**
     * Whether to enable debugMode (affects core logging behavior etc.).
     */
    debugMode?: boolean;

    /**
     * Auth type:
     * - oauth: LOGIN_WITH_GOOGLE - reuse Google account logged in via gemini CLI (free tier)
     * - api-key: USE_GEMINI - use GEMINI_API_KEY etc.
     * - vertex-ai: USE_VERTEX_AI - Vertex mode.
     * Defaults to oauth (LOGIN_WITH_GOOGLE).
     */
    authType?: 'oauth' | 'api-key' | 'vertex-ai';

    /**
     * Explicit path to gemini CLI binary (for CLI fallback mode).
     * If not provided, will try to locate via PATH.
     */
    geminiBin?: string;

    /**
     * Timeout for CLI invocations in milliseconds.
     * Defaults to 120000 (2 minutes).
     */
    timeoutMs?: number;
}

/**
 * Map our string enum to gemini-cli-core's AuthType.
 * Must be called after core is imported.
 */
function mapAuthType(
    core: GeminiCliCoreModule,
    type: GeminiProviderOptions['authType']
) {
    const { AuthType } = core;
    switch (type) {
        case 'api-key':
            return AuthType.USE_GEMINI;
        case 'vertex-ai':
            return AuthType.USE_VERTEX_AI;
        case 'oauth':
        default:
            return AuthType.LOGIN_WITH_GOOGLE;
    }
}

/**
 * Lazy-load @google/gemini-cli-core.
 * Benefit: if user doesn't have this package installed, extension won't crash on activation.
 */
async function importCoreSafely(): Promise<GeminiCliCoreModule> {
    if (!coreImportPromise) {
        logger.info('gemini: attempting to import @google/gemini-cli-core...');
        // Use variable name to prevent TypeScript from attempting static resolution
        coreImportPromise = (new Function('moduleName', 'return import(moduleName)')(GEMINI_CORE_MODULE) as Promise<GeminiCliCoreModule>).catch((err) => {
            logger.warn('gemini: failed to import @google/gemini-cli-core', {
                error: err instanceof Error ? err.message : String(err),
                code: (err as any)?.code
            });
            coreImportPromise = null;
            throw err;
        });
    }
    return coreImportPromise;
}

/**
 * Error indicating core is unavailable.
 * Allows upper layer to decide whether to fallback to CLI.
 */
export class GeminiCoreUnavailableError extends Error {
    constructor(message: string, public readonly original?: unknown) {
        super(message);
        this.name = 'GeminiCoreUnavailableError';
    }
}

/**
 * Error indicating gemini CLI doesn't exist or execution failed.
 */
export class GeminiCliError extends Error {
    constructor(
        message: string,
        public readonly exitCode?: number | null,
        public readonly stdout?: string,
        public readonly stderr?: string
    ) {
        super(message);
        this.name = 'GeminiCliError';
    }
}

/**
 * Health check result
 */
export interface GeminiHealthResult {
    available: boolean;
    mode: GeminiMode;
    version?: string;
    message: string;
}

/**
 * Core Provider: can be instantiated as a singleton in MCP server / VSCode extension.
 */
export class GeminiProvider {
    private readonly options: GeminiProviderOptions;
    private coreConfigPromise: Promise<GeminiConfig> | null = null;
    private _detectedMode: GeminiMode = 'unknown';
    private _healthCheckPromise: Promise<GeminiHealthResult> | null = null;

    constructor(options: GeminiProviderOptions = {}) {
        this.options = options;
    }

    get detectedMode(): GeminiMode {
        return this._detectedMode;
    }

    /**
     * Initialize and cache a core Config instance.
     * - Calls Config.initialize() (if exists)
     * - Calls Config.refreshAuth(AuthType.*) to reuse CLI's auth info
     */
    private async getCoreConfig(): Promise<GeminiConfig> {
        if (this.coreConfigPromise) return this.coreConfigPromise;

        this.coreConfigPromise = (async () => {
            let core: GeminiCliCoreModule;
            try {
                core = await importCoreSafely();
                logger.info('gemini: @google/gemini-cli-core imported successfully');
            } catch (err: any) {
                // @google/gemini-cli-core not installed → throw custom error, upper layer can fallback
                if (this.isModuleNotFoundError(err)) {
                    throw new GeminiCoreUnavailableError(
                        'Cannot find @google/gemini-cli-core. Please install it or rely on CLI fallback.',
                        err
                    );
                }
                throw err;
            }

            const { Config, ApprovalMode } = core;
            logger.info('gemini: creating Config instance...');

            const sessionId = this.options.sessionId ?? `mcp-${randomUUID().slice(0, 8)}`;
            const cwd = this.options.cwd ?? process.cwd();
            const targetDir = this.options.targetDir ?? cwd;
            const model = this.options.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';

            // Create config with minimal required parameters
            const config = new Config({
                sessionId,
                targetDir,
                cwd,
                debugMode: this.options.debugMode ?? false,
                model,
                approvalMode: ApprovalMode.YOLO, // No interactive confirmation, convenient for server / automation
                noBrowser: true // Server / CLI Embedded scenarios prohibit auto-launching browser
            } as any);

            // Some versions of core need initialize() before refreshAuth()
            if (typeof (config as any).initialize === 'function') {
                logger.info('gemini: calling config.initialize()...');
                await (config as any).initialize();
            }

            const authType = mapAuthType(core, this.options.authType);
            logger.info('gemini: calling config.refreshAuth()...', { authType: this.options.authType ?? 'oauth' });
            await config.refreshAuth(authType);
            logger.info('gemini: Config ready');

            return config;
        })();

        return this.coreConfigPromise;
    }

    /**
     * Check Gemini availability (core first, then CLI fallback).
     * Returns health status and detected mode.
     */
    async checkHealth(): Promise<GeminiHealthResult> {
        if (this._healthCheckPromise) {
            return this._healthCheckPromise;
        }

        this._healthCheckPromise = (async () => {
            // Try core first
            try {
                logger.info('gemini: checking core availability...');
                await this.runWithCore(async (core, config) => {
                    // Just verify we can initialize - don't actually make a request
                    return true;
                });
                this._detectedMode = 'core';
                logger.info('gemini: core mode available');
                return {
                    available: true,
                    mode: 'core' as GeminiMode,
                    message: 'Gemini CLI Core available'
                };
            } catch (coreErr) {
                logger.info('gemini: core not available, trying CLI fallback...', {
                    error: coreErr instanceof Error ? coreErr.message : String(coreErr)
                });

                // Core unavailable, try CLI
                try {
                    const { stdout } = await this.runCliCommand(['--version']);
                    const version = stdout.trim().split('\n')[0] || 'unknown';
                    this._detectedMode = 'cli';
                    logger.info('gemini: CLI mode available', { version });
                    return {
                        available: true,
                        mode: 'cli' as GeminiMode,
                        version,
                        message: `Gemini CLI available (${version})`
                    };
                } catch (cliErr) {
                    logger.warn('gemini: neither core nor CLI available', {
                        coreError: coreErr instanceof Error ? coreErr.message : String(coreErr),
                        cliError: cliErr instanceof Error ? cliErr.message : String(cliErr)
                    });
                    this._detectedMode = 'unknown';
                    return {
                        available: false,
                        mode: 'unknown' as GeminiMode,
                        message: 'Neither Gemini CLI Core nor CLI available'
                    };
                }
            }
        })();

        try {
            return await this._healthCheckPromise;
        } finally {
            this._healthCheckPromise = null;
        }
    }

    /**
     * Wrapper for core with callback helper.
     * In callback you get Config and can:
     *   - config.getGeminiClient()
     *   - client.initialize() / client.getChat() / streaming etc.
     */
    async runWithCore<T>(
        fn: (
            core: GeminiCliCoreModule,
            config: GeminiConfig
        ) => Promise<T>
    ): Promise<T> {
        try {
            const core = await importCoreSafely();
            const config = await this.getCoreConfig();
            return await fn(core, config);
        } catch (err: any) {
            if (err instanceof GeminiCoreUnavailableError || this.isModuleNotFoundError(err)) {
                throw new GeminiCoreUnavailableError(
                    'Gemini core unavailable. Falling back to CLI is recommended.',
                    err
                );
            }
            throw err;
        }
    }

    /**
     * Run a raw CLI command with arguments.
     */
    async runCliCommand(
        args: string[],
        opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number } = {}
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        const cwd = opts.cwd ?? this.options.cwd ?? process.cwd();
        const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs ?? 120000;
        const env = {
            ...process.env,
            ...opts.env
        };

        const geminiBin = this.resolveGeminiBin();
        const { command, spawnArgs } = this.buildSpawnCommand(geminiBin, args);

        logger.info('gemini: spawning CLI', { command, args: spawnArgs, cwd, timeoutMs });

        return new Promise((resolve, reject) => {
            const child = spawn(command, spawnArgs, {
                cwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: false,
                windowsHide: process.platform === 'win32'
            });

            let stdout = '';
            let stderr = '';
            let settled = false;

            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString('utf8');
            });

            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString('utf8');
            });

            const timer = timeoutMs > 0
                ? setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        try { child.kill('SIGTERM'); } catch { /* ignore */ }
                        setTimeout(() => {
                            try { child.kill('SIGKILL'); } catch { /* ignore */ }
                        }, 1000);
                        reject(new GeminiCliError(
                            `Gemini CLI timed out after ${timeoutMs}ms`,
                            undefined,
                            stdout,
                            stderr
                        ));
                    }
                }, timeoutMs)
                : undefined;

            if (opts.stdin) {
                try {
                    child.stdin.write(opts.stdin);
                    child.stdin.end();
                } catch { /* ignore stdin errors */ }
            } else {
                child.stdin.end();
            }

            child.on('error', (err: any) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);

                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    reject(new GeminiCliError(
                        'Cannot find `gemini` CLI. Please install @google/gemini-cli or ensure it is on PATH.',
                        undefined,
                        stdout,
                        stderr
                    ));
                } else {
                    reject(new GeminiCliError(
                        `Failed to spawn gemini CLI: ${String(err?.message ?? err)}`,
                        undefined,
                        stdout,
                        stderr
                    ));
                }
            });

            child.on('close', (code) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);

                const exitCode = code ?? 0;
                if (exitCode !== 0) {
                    reject(new GeminiCliError(
                        `gemini CLI exited with code ${exitCode}`,
                        exitCode,
                        stdout,
                        stderr
                    ));
                    return;
                }
                // On successful execution, remember explicit path if it looks like one
                try {
                    if (geminiBin && geminiBin.includes(path.sep)) {
                        DETECTED_GEMINI_BIN = geminiBin;
                    }
                } catch {
                    // ignore
                }
                resolve({ stdout, stderr, exitCode });
            });
        });
    }

    /**
     * CLI headless mode invocation.
     *
     * Default usage:
     *   gemini --prompt "<prompt>" --output=json
     *
     * Can append extraArgs like:
     *   ["--model", "gemini-2.5-pro", "--yolo"]
     */
    async runWithCli(
        prompt: string,
        extraArgs: string[] = [],
        opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        const baseArgs = ['--prompt', prompt, '--output', 'json'];
        const args = baseArgs.concat(extraArgs);
        return this.runCliCommand(args, opts);
    }

    /**
     * High-level wrapper: prefer core (Core mode), fallback to CLI (CLI mode) on failure.
     *
     * For simplicity, this does a "single-turn" interaction:
     *   - core branch: get Config.getGeminiClient(), ensure initialized, add user message to chat and get response.
     *   - cli branch: use gemini --prompt "<prompt>" --output=json, try to parse JSON.
     *
     * For more complex multi-turn / tool calls, use runWithCore() directly.
     */
    async runBest(prompt: string, extraCliArgs: string[] = []): Promise<GeminiResult> {
        // 1. Try core first
        try {
            const core = await importCoreSafely();
            const config = await this.getCoreConfig();

            // Get GeminiClient from Config (prefer official API)
            const client = config.getGeminiClient() as any;

            // Some versions need initialize()
            if (typeof client.initialize === 'function' && !client.isInitialized?.()) {
                await client.initialize();
            }

            if (typeof client.getChat !== 'function') {
                throw new Error('GeminiClient.getChat() not available – core API version mismatch.');
            }

            const chat = client.getChat();
            if (!chat) {
                throw new Error('Gemini chat not initialized.');
            }

            // Add user message and get response
            if (typeof chat.addHistory === 'function') {
                await chat.addHistory({
                    role: 'user',
                    parts: [{ text: prompt }]
                });
            }

            if (typeof chat.send !== 'function') {
                throw new Error('GeminiChat.send() not available – please adjust to actual core API.');
            }

            const response = await chat.send();
            // Extract text from response
            let text = '';
            if (response && Array.isArray(response.candidates)) {
                const first = response.candidates[0];
                const parts = first?.content?.parts ?? [];
                for (const part of parts) {
                    if (typeof part.text === 'string') {
                        text += part.text;
                    }
                }
            }

            if (!text) {
                text = String(response ?? '');
            }

            this._detectedMode = 'core';
            return {
                from: 'core',
                text,
                raw: response
            };
        } catch (err) {
            // If core unavailable / load failed, fall through to CLI
            if (err instanceof GeminiCoreUnavailableError || this.isModuleNotFoundError(err)) {
                logger.info('gemini: core unavailable, falling back to CLI', {
                    error: err instanceof Error ? err.message : String(err)
                });
            } else {
                // Other core errors - you can choose to throw or fallback
                // Here we also fallback to CLI for robustness
                logger.warn('gemini: core error, falling back to CLI', {
                    error: err instanceof Error ? err.message : String(err)
                });
            }
        }

        // 2. Fallback: gemini CLI headless
        const { stdout, stderr } = await this.runWithCli(prompt, extraCliArgs);

        let text = stdout.trim();
        // Try to parse JSON, compatible with --output=json structure
        try {
            const parsed = JSON.parse(stdout);
            if (typeof parsed === 'object' && parsed !== null) {
                if (typeof (parsed as any).response === 'string') {
                    text = (parsed as any).response;
                } else if (Array.isArray((parsed as any).candidates)) {
                    const first = (parsed as any).candidates[0];
                    const parts = first?.content?.parts ?? [];
                    let combined = '';
                    for (const part of parts) {
                        if (typeof part.text === 'string') {
                            combined += part.text;
                        }
                    }
                    if (combined) {
                        text = combined;
                    }
                }
            }
            this._detectedMode = 'cli';
            return {
                from: 'cli',
                text,
                raw: parsed,
                stdout,
                stderr
            };
        } catch {
            // Not JSON, use as plain text
            this._detectedMode = 'cli';
            return {
                from: 'cli',
                text,
                stdout,
                stderr
            };
        }
    }

    // ------------------------
    // helpers
    // ------------------------

    private isModuleNotFoundError(err: any): boolean {
        if (!err) return false;
        if (err.code === 'MODULE_NOT_FOUND') return true;
        if (err.code === 'ERR_MODULE_NOT_FOUND') return true;
        const msg = String(err.message ?? err);
        return (
            msg.includes('@google/gemini-cli-core') &&
            (msg.includes('Cannot find module') || msg.includes('module not found') || msg.includes('Cannot find package'))
        );
    }

    private resolveGeminiBin(): string {
        // 1. Use explicit option
        if (this.options.geminiBin && this.options.geminiBin.trim().length > 0) {
            logger.info('gemini: using geminiBin from options', { geminiBin: this.options.geminiBin });
            DETECTED_GEMINI_BIN = this.options.geminiBin;
            return this.options.geminiBin;
        }

        // 2. Use GEMINI_CLI environment variable
        const envGemini = process.env.GEMINI_CLI;
        if (envGemini && envGemini.trim().length > 0) {
            logger.info('gemini: using GEMINI_CLI from env', { GEMINI_CLI: envGemini.trim() });
            DETECTED_GEMINI_BIN = envGemini.trim();
            return envGemini.trim();
        }

        // 3. Try to locate in common paths (Windows only)
        if (process.platform === 'win32') {
            const found = this.findGeminiInCommonPaths();
            if (found) {
                DETECTED_GEMINI_BIN = found;
                return found;
            }
        }

        // 4. Default to 'gemini' and hope PATH resolves it
        return 'gemini';
    }

    private findGeminiInCommonPaths(): string | undefined {
        const candidates: string[] = [];
        const userProfile = process.env.USERPROFILE;
        const appData = process.env.APPDATA;
        const localAppData = process.env.LOCALAPPDATA;

        // npm global installs
        if (appData) {
            candidates.push(path.join(appData, 'npm', 'gemini.cmd'));
            candidates.push(path.join(appData, 'npm', 'gemini'));
        }

        // Common install locations
        const baseDirs = [localAppData, userProfile].filter((d): d is string => !!d);
        const subPaths = [
            ['Programs', 'Gemini CLI'],
            ['Google', 'Gemini CLI'],
            ['Gemini CLI']
        ];
        const fileNames = ['gemini.exe', 'gemini.cmd'];

        for (const base of baseDirs) {
            for (const sub of subPaths) {
                const root = path.join(base, ...sub);
                for (const file of fileNames) {
                    candidates.push(path.join(root, file));
                }
            }
        }

        for (const candidate of candidates) {
            try {
                if (fsSync.existsSync(candidate)) {
                    logger.info('gemini: found CLI at', { path: candidate });
                    return candidate;
                }
            } catch {
                // ignore access errors
            }
        }

        return undefined;
    }

    private buildSpawnCommand(geminiBin: string, taskArgs: string[]): { command: string; spawnArgs: string[] } {
        if (process.platform === 'win32') {
            const ext = path.extname(geminiBin).toLowerCase();
            if (ext === '.cmd' || ext === '.bat') {
                // Try to extract node script path from .cmd file for direct execution
                try {
                    const content = fsSync.readFileSync(geminiBin, 'utf8');
                    const m1 = content.match(/node\s+["']?([^"'\s]+\.js)["']?/i);
                    const m2 = content.match(/["']([^"']+\.js)["']/i);
                    const candidate = (m1 && m1[1]) || (m2 && m2[1]);
                    if (candidate) {
                        const scriptPath = path.isAbsolute(candidate)
                            ? candidate
                            : path.resolve(path.dirname(geminiBin), candidate);
                        if (fsSync.existsSync(scriptPath)) {
                            return { command: process.execPath, spawnArgs: [scriptPath, ...taskArgs] };
                        }
                    }
                } catch {
                    // fall through
                }
                // Use cmd.exe to execute .cmd file
                const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
                return { command: comspec, spawnArgs: ['/c', geminiBin, ...taskArgs] };
            }
        }

        // POSIX or direct executable
        return { command: geminiBin, spawnArgs: taskArgs };
    }
}

// buildSpawnCommand is intentionally not exported; callers should use GeminiProvider.runCliCommand

// Export a default singleton instance (can be customized via setProvider)
let defaultProvider: GeminiProvider | null = null;

export function getGeminiProvider(options?: GeminiProviderOptions): GeminiProvider {
    if (!defaultProvider) {
        defaultProvider = new GeminiProvider(options);
    }
    return defaultProvider;
}

export function setGeminiProvider(provider: GeminiProvider): void {
    defaultProvider = provider;
}

export function createGeminiProvider(options?: GeminiProviderOptions): GeminiProvider {
    return new GeminiProvider(options);
}
