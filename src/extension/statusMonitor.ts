import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs/promises';

import { GeminiCliHealth, } from './cliHealth';
import { GeminiTaskTreeProvider } from './treeProvider';
import { LiveStatusSnapshot, LiveTaskSummary } from './types';
import { resolveTaskCwd, formatDuration } from './configUtils';

const STATUS_POLL_INTERVAL_MS = 3000;
const TOOLTIP_TASK_LIMIT = 5;
const COMPLETED_TOOLTIP_LIMIT = 3;
const COMPLETED_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

// Monitors status.json files written by the MCP server and updates the status bar/tree UI.
export class TaskStatusMonitor implements vscode.Disposable {
    private watchers: vscode.FileSystemWatcher[] = [];
    private snapshot: LiveStatusSnapshot | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private config: any | undefined;
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

    updateConfig(cfg: any) {
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
        const unhealthyStates = new Set<string>(this.config?.unhealthyStates ?? ['missing']);
        const cliHealthy = !cliStatus || !unhealthyStates.has(cliStatus.state);
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
        cliStatus?: any
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

    private describeCliStatus(cliStatus: any) {
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
