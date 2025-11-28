import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

interface GeminiConfig {
    geminiPath: string;
    maxWorkers: number;
    taskCwd: string | undefined;
    maxQueue: number;
    defaultTimeouts: TimeoutConfig;
    defaultPriorities: PriorityConfig;
}

interface TimeoutConfig {
    testsRun: number;
    codeAnalyze: number;
    codeFormat: number;
    taskSubmit: number;
}

interface PriorityConfig {
    testsRun: number;
    codeAnalyze: number;
    codeFormat: number;
    taskSubmit: number;
}

interface LiveStatusSnapshot {
    running: number;
    queued: number;
    maxWorkers: number;
    queueLimit: number;
    updatedAt: number;
    tasks: LiveTaskSummary[];
    cliStatus?: ServerCliStatus;
}

interface LiveTaskSummary {
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

type CliHealthState = 'unknown' | 'checking' | 'ok' | 'missing' | 'quota_exhausted' | 'error';

interface CliStatusSnapshot {
    state: CliHealthState;
    message: string;
    lastChecked?: number;
    version?: string;
}

type ServerCliStatus = CliStatusSnapshot;

const STATUS_POLL_INTERVAL_MS = 3000;
const TOOLTIP_TASK_LIMIT = 5;
const COMPLETED_TOOLTIP_LIMIT = 3;
const COMPLETED_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const CLI_HEALTH_REFRESH_INTERVAL_MS = 60 * 1000;
const CLI_HEALTH_FAILURE_INTERVAL_MS = 60 * 1000;
const CLI_UNHEALTHY_STATES = new Set<CliHealthState>(['missing', 'quota_exhausted', 'error']);

class GeminiCliHealth implements vscode.Disposable {
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

    async ensureRecent(config: GeminiConfig) {
        const key = this.buildConfigKey(config);
        const now = Date.now();
        const lastChecked = this.status.lastChecked ?? 0;
        const healthy = this.status.state === 'ok';
        const interval = healthy ? CLI_HEALTH_REFRESH_INTERVAL_MS : CLI_HEALTH_FAILURE_INTERVAL_MS;
        const needConfigRefresh = !this.lastConfigKey || this.lastConfigKey !== key;
        const stale =
            !this.status.lastChecked ||
            needConfigRefresh ||
            now - lastChecked > interval ||
            this.status.state === 'unknown';
        if (stale) {
            await this.refresh(config);
        }
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
                windowsHide: true
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

function readConfig(): GeminiConfig {
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
    return {
        geminiPath: config.get<string>('geminiPath', 'gemini'),
        maxWorkers: config.get<number>('maxWorkers', 3),
        taskCwd: config.get<string>('taskCwd'),
        maxQueue: config.get<number>('maxQueue', 200),
        defaultTimeouts,
        defaultPriorities
    };
}

function resolveTaskCwd(raw: string | undefined): string | undefined {
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

let workspaceWarningShown = false;

export function activate(context: vscode.ExtensionContext) {
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.name = 'Gemini CLI MCP';
    statusItem.text = '$(hubot) Gemini';
    statusItem.tooltip = 'Copilot orchestrates local Gemini CLI workers via MCP';
    statusItem.show();
    context.subscriptions.push(statusItem);

    const cliHealth = new GeminiCliHealth();
    context.subscriptions.push(cliHealth);

    const taskTreeProvider = new GeminiTaskTreeProvider();
    const treeRegistration = vscode.window.registerTreeDataProvider('geminiMcp.tasks', taskTreeProvider);
    context.subscriptions.push(treeRegistration);

    const statusMonitor = new TaskStatusMonitor(context, statusItem, taskTreeProvider, cliHealth);
    context.subscriptions.push(statusMonitor);

    const initialConfig = readConfig();
    void cliHealth.refresh(initialConfig);

    const providerEmitter = new vscode.EventEmitter<void>();
    context.subscriptions.push(providerEmitter);
    context.subscriptions.push(cliHealth.onDidChange(() => providerEmitter.fire()));
    const workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        workspaceWarningShown = false;
        providerEmitter.fire();
    });
    context.subscriptions.push(workspaceWatcher);

    const provider = vscode.lm.registerMcpServerDefinitionProvider('gemini-mcp-provider', {
        onDidChangeMcpServerDefinitions: providerEmitter.event,
        provideMcpServerDefinitions: async () => {
            const servers: vscode.McpServerDefinition[] = [];
            const cfg = readConfig();
            await cliHealth.ensureRecent(cfg);
            if (!cliHealth.isHealthy()) {
                return servers;
            }
            const serverCwd = vscode.Uri.joinPath(context.extensionUri, 'server').fsPath;
            const args = ['dist/index.js'];
            const resolvedTaskCwd = resolveTaskCwd(cfg.taskCwd);
            if (!resolvedTaskCwd) {
                if (!workspaceWarningShown) {
                    workspaceWarningShown = true;
                    void vscode.window.showWarningMessage(
                        'Gemini CLI MCP requires an open workspace or an absolute taskCwd before it can run.'
                    );
                }
                return servers;
            }
            const env = {
                GEMINI_CLI: cfg.geminiPath,
                GEMINI_MAX_WORKERS: String(Math.max(1, cfg.maxWorkers)),
                GEMINI_TASK_CWD: resolvedTaskCwd,
                GEMINI_MAX_QUEUE: String(Math.max(1, cfg.maxQueue)),
                GEMINI_TIMEOUT_TESTS_RUN: String(Math.max(0, cfg.defaultTimeouts.testsRun)),
                GEMINI_TIMEOUT_CODE_ANALYZE: String(Math.max(0, cfg.defaultTimeouts.codeAnalyze)),
                GEMINI_TIMEOUT_CODE_FORMAT: String(Math.max(0, cfg.defaultTimeouts.codeFormat)),
                GEMINI_TIMEOUT_TASK_SUBMIT: String(Math.max(0, cfg.defaultTimeouts.taskSubmit)),
                GEMINI_PRIORITY_TESTS_RUN: String(clampPriority(cfg.defaultPriorities.testsRun)),
                GEMINI_PRIORITY_CODE_ANALYZE: String(clampPriority(cfg.defaultPriorities.codeAnalyze)),
                GEMINI_PRIORITY_CODE_FORMAT: String(clampPriority(cfg.defaultPriorities.codeFormat)),
                GEMINI_PRIORITY_TASK_SUBMIT: String(clampPriority(cfg.defaultPriorities.taskSubmit))
            };

            const def = new vscode.McpStdioServerDefinition(
                'gemini-cli-mcp',
                'node',
                args,
                env,
                '1.0.0'
            );
            def.cwd = vscode.Uri.file(serverCwd);
            servers.push(def);
            return servers;
        },
        resolveMcpServerDefinition: async (server) => server
    });
    context.subscriptions.push(provider);

    const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('geminiMcp')) {
            providerEmitter.fire();
            const cfg = readConfig();
            statusMonitor.updateConfig(cfg);
            void cliHealth.refresh(cfg);
            workspaceWarningShown = false;
            vscode.window.showInformationMessage('Gemini CLI MCP config updated; server will reload shortly');
        }
    });
    context.subscriptions.push(configWatcher);

    const showStatusCmd = vscode.commands.registerCommand('geminiMcp.showStatus', async () => {
        const cfg = readConfig();
        statusMonitor.updateConfig(cfg);
        await cliHealth.ensureRecent(cfg);
        const cliStatus = cliHealth.getStatus();
        const cliLabel =
            cliStatus.state === 'ok'
                ? `OK (${cliStatus.message})`
                : `${cliStatus.state.toUpperCase()} (${cliStatus.message})`;
        vscode.window.showInformationMessage(
            `Gemini CLI MCP workers: ${cfg.maxWorkers}, CLI: ${cliLabel}`
        );
    });
    context.subscriptions.push(showStatusCmd);

    const openLogCmd = vscode.commands.registerCommand('geminiMcp.openTaskLog', async (taskId: string) => {
        if (!taskId) {
            return;
        }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(`tasks://${taskId}/log`));
    });
    context.subscriptions.push(openLogCmd);

    statusMonitor.updateConfig(initialConfig);
}

export function deactivate() {
    // Nothing to dispose; VS Code handles MCP server lifecycle
}

function clampPriority(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(-5, Math.min(5, Math.trunc(value)));
}

class TaskStatusMonitor implements vscode.Disposable {
    private watchers: vscode.FileSystemWatcher[] = [];
    private snapshot: LiveStatusSnapshot | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private config: GeminiConfig | undefined;
    private candidateStatusUris: vscode.Uri[] = [];
    private snapshotSource: vscode.Uri | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;
    private refreshing = false;
    private refreshPending = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly statusItem: vscode.StatusBarItem,
        private readonly treeProvider: GeminiTaskTreeProvider,
        private readonly cliHealth: GeminiCliHealth
    ) {
        this.refreshWatchers();
        void this.refresh();
        this.startPolling();
        this.disposables.push(
            this.cliHealth.onDidChange(() => {
                this.renderStatus();
            })
        );
    }

    updateConfig(cfg: GeminiConfig) {
        this.config = cfg;
        this.refreshWatchers();
        this.renderStatus();
    }

    private async refresh() {
        if (this.refreshing) {
            this.refreshPending = true;
            return;
        }
        this.refreshing = true;
        try {
            await this.readLatestSnapshot();
            this.renderStatus();
        } finally {
            this.refreshing = false;
            if (this.refreshPending) {
                this.refreshPending = false;
                void this.refresh();
            }
        }
    }

    private renderStatus() {
        const cfg = this.config;
        const snapshot = this.snapshot;
        const running = snapshot?.running ?? 0;
        const queued = snapshot?.queued ?? 0;
        const maxWorkers = snapshot?.maxWorkers ?? cfg?.maxWorkers ?? 0;
        const queueLimit = snapshot?.queueLimit ?? cfg?.maxQueue ?? 0;
        const cliStatus = snapshot?.cliStatus ?? this.cliHealth.getStatus();
        const cliHealthy = !cliStatus || !CLI_UNHEALTHY_STATES.has(cliStatus.state);
        const overload =
            queueLimit > 0 ? queued / queueLimit >= 1 : false;
        const warning = !overload && queueLimit > 0 ? queued / queueLimit >= 0.8 : false;
        this.statusItem.text = `$(hubot) Gemini ${running}/${queued}`;
        const lastUpdated = snapshot
            ? `${new Date(snapshot.updatedAt).toLocaleTimeString()} (${this.snapshotSource?.fsPath ?? 'unknown'})`
            : 'No live data';
        this.statusItem.tooltip = this.buildTooltip(
            snapshot,
            running,
            queued,
            maxWorkers,
            queueLimit,
            lastUpdated,
            cliStatus
        );
        this.statusItem.backgroundColor = !cliHealthy
            ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : overload
              ? new vscode.ThemeColor('statusBarItem.errorBackground')
              : warning
                ? new vscode.ThemeColor('statusBarItem.warningBackground')
                : undefined;
        this.treeProvider.update(snapshot?.tasks ?? []);
    }

    dispose() {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.watchers.forEach((w) => w.dispose());
        this.stopPolling();
    }

    private refreshWatchers() {
        this.watchers.forEach((w) => w.dispose());
        this.watchers = [];
        this.candidateStatusUris = this.buildCandidateStatusUris();
        for (const uri of this.candidateStatusUris) {
            const dir = vscode.Uri.file(path.dirname(uri.fsPath));
            const pattern = new vscode.RelativePattern(dir, path.basename(uri.fsPath));
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            this.watchers.push(watcher);
            this.disposables.push(
                watcher.onDidChange(() => this.refresh()),
                watcher.onDidCreate(() => this.refresh()),
                watcher.onDidDelete(() => this.refresh())
            );
        }
    }

    private startPolling() {
        this.stopPolling();
        this.refreshTimer = setInterval(() => {
            void this.refresh();
        }, STATUS_POLL_INTERVAL_MS);
        this.disposables.push(
            new vscode.Disposable(() => {
                this.stopPolling();
            })
        );
    }

    private stopPolling() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private buildTooltip(
        snapshot: LiveStatusSnapshot | undefined,
        running: number,
        queued: number,
        maxWorkers: number,
        queueLimit: number,
        lastUpdated: string,
        cliStatus?: CliStatusSnapshot
    ) {
        const md = new vscode.MarkdownString(undefined, true);
        md.isTrusted = false;
        const lines: string[] = [];
        lines.push('**Gemini CLI MCP**');
        lines.push(`- Workers: ${running}/${maxWorkers}`);
        lines.push(`- Queue: ${queued}/${queueLimit}`);
        lines.push(`- Last update: ${lastUpdated}`);
        if (cliStatus) {
            lines.push(`- CLI: ${this.describeCliStatus(cliStatus)}`);
        }

        if (!snapshot || snapshot.tasks.length === 0) {
            lines.push('\n_No Gemini tasks detected yet._');
            md.value = lines.join('\n');
            return md;
        }

        const runningTasks = snapshot.tasks
            .filter((task) => task.status === 'running')
            .slice(0, TOOLTIP_TASK_LIMIT);
        const queuedTasks = snapshot.tasks
            .filter((task) => task.status === 'queued')
            .slice(0, TOOLTIP_TASK_LIMIT);
        const recentTasks = snapshot.tasks
            .filter((task) => COMPLETED_STATUSES.has(task.status))
            .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
            .slice(0, COMPLETED_TOOLTIP_LIMIT);

        lines.push(...this.formatTaskSection('Running tasks', runningTasks));
        lines.push(...this.formatTaskSection('Queued tasks', queuedTasks));
        lines.push(...this.formatTaskSection('Recent completions', recentTasks));

        md.value = lines.join('\n');
        return md;
    }

    private describeCliStatus(cliStatus: CliStatusSnapshot) {
        const prefix = cliStatus.state === 'ok' ? 'OK' : cliStatus.state.toUpperCase();
        const detail = cliStatus.message ?? '';
        const timestamp = cliStatus.lastChecked
            ? ` (checked ${new Date(cliStatus.lastChecked).toLocaleTimeString()})`
            : '';
        return `${prefix}${detail ? ` - ${detail}` : ''}${timestamp}`;
    }

    private formatTaskSection(title: string, tasks: LiveTaskSummary[]) {
        if (!tasks.length) {
            return [];
        }
        const section: string[] = ['', `**${title}**`];
        for (const task of tasks) {
            section.push(this.describeTask(task));
            if (task.lastLogLine) {
                section.push(`  -> ${task.lastLogLine}`);
            }
        }
        return section;
    }

    private describeTask(task: LiveTaskSummary) {
        const duration = this.getTaskDuration(task);
        const idFragment = task.id.slice(0, 8);
        const durationPart = duration ? ` | ${duration}` : '';
        return `- ${task.toolName} (${task.status}${durationPart}) #${idFragment}`;
    }

    private getTaskDuration(task: LiveTaskSummary) {
        const start = task.startedAt ?? task.createdAt;
        const end = task.completedAt ?? Date.now();
        const span = end - start;
        return span > 0 ? formatDuration(span) : '';
    }

    private buildCandidateStatusUris() {
        const uris: vscode.Uri[] = [];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            uris.push(vscode.Uri.joinPath(folder.uri, '.vscode', 'gemini-mcp', 'status.json'));
        }
        const resolvedTaskCwd = resolveTaskCwd(this.config?.taskCwd);
        if (resolvedTaskCwd) {
            const extra = vscode.Uri.file(path.join(resolvedTaskCwd, '.vscode', 'gemini-mcp', 'status.json'));
            if (!uris.some((u) => u.fsPath === extra.fsPath)) {
                uris.push(extra);
            }
        }
        return uris;
    }

    private async readLatestSnapshot() {
        let best: { snapshot: LiveStatusSnapshot; uri: vscode.Uri; updated: number } | undefined;
        for (const uri of this.candidateStatusUris) {
            try {
                const buffer = await fs.readFile(uri.fsPath, 'utf8');
                const parsed = JSON.parse(buffer) as LiveStatusSnapshot;
                const updated = parsed.updatedAt ?? (await fs.stat(uri.fsPath)).mtimeMs;
                if (!best || updated > best.updated) {
                    best = { snapshot: parsed, uri, updated };
                }
            } catch {
                // ignore and try next candidate
            }
        }
        if (best) {
            this.snapshot = best.snapshot;
            this.snapshotSource = best.uri;
        } else {
            this.snapshot = undefined;
            this.snapshotSource = undefined;
        }
    }
}

class GeminiTaskTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.onDidChangeEmitter.event;
    private items: LiveTaskSummary[] = [];

    update(items: LiveTaskSummary[]) {
        this.items = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
        this.onDidChangeEmitter.fire();
    }

    getTreeItem(element: TaskTreeItem) {
        return element;
    }

    getChildren(): TaskTreeItem[] {
        if (this.items.length === 0) {
            return [
                new TaskTreeItem({
                    id: 'none',
                    label: 'No Gemini tasks',
                    description: '',
                    tooltip: 'Waiting for Copilot to enqueue Gemini worker tasks.',
                    collapsibleState: vscode.TreeItemCollapsibleState.None,
                    contextValue: 'empty'
                })
            ];
        }
        return this.items.map((task) => TaskTreeItem.fromTask(task));
    }
}

class TaskTreeItem extends vscode.TreeItem {
    static fromTask(task: LiveTaskSummary) {
        const duration = task.startedAt
            ? formatDuration((task.completedAt ?? Date.now()) - task.startedAt)
            : '';
        const label = `${task.toolName} (${task.status})`;
        const description = `${task.id.slice(0, 8)}${duration ? ` | ${duration}` : ''}`;
        const tooltipParts = [
            `Tool: ${task.toolName}`,
            `ID: ${task.id}`,
            `Status: ${task.status}`,
            `Created: ${new Date(task.createdAt).toLocaleString()}`,
            task.startedAt ? `Started: ${new Date(task.startedAt).toLocaleString()}` : undefined,
            task.completedAt ? `Completed: ${new Date(task.completedAt).toLocaleString()}` : undefined,
            typeof task.priority === 'number' ? `Priority: ${task.priority}` : undefined,
            task.lastLogLine ? `Last log: ${task.lastLogLine}` : undefined
        ].filter(Boolean);
        const item = new TaskTreeItem({
            id: task.id,
            label,
            description,
            tooltip: tooltipParts.join('\n'),
            collapsibleState: vscode.TreeItemCollapsibleState.None,
            contextValue: 'task'
        });
        item.command = {
            command: 'geminiMcp.openTaskLog',
            title: 'Open Task Log',
            arguments: [task.id]
        };
        return item;
    }

    constructor(options: {
        id: string;
        label: string;
        description: string;
        tooltip: string;
        collapsibleState: vscode.TreeItemCollapsibleState;
        contextValue: string;
    }) {
        super(options.label, options.collapsibleState);
        this.id = options.id;
        this.tooltip = options.tooltip;
        this.description = options.description;
        this.contextValue = options.contextValue;
    }
}

function formatDuration(ms: number) {
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
