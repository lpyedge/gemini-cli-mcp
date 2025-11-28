import * as vscode from 'vscode';
import { LiveTaskSummary } from './types';
import { formatDuration } from './configUtils';

// Tree provider and tree item for showing Gemini tasks in the Activity view.

export class GeminiTaskTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
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

export class TaskTreeItem extends vscode.TreeItem {
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
