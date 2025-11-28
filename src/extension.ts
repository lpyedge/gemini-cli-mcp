import * as vscode from 'vscode';
import path from 'node:path';

import { readConfig, resolveTaskCwd, clampPriority } from './extension/configUtils';
import { GeminiCliHealth } from './extension/cliHealth';
import { GeminiTaskTreeProvider } from './extension/treeProvider';
import { TaskStatusMonitor } from './extension/statusMonitor';

// The activate module wires the UI pieces together and registers the MCP provider
// and extension commands. It intentionally keeps the wiring logic concise and
// imports well-scoped modules for the implementation details.

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
	const initialHealthCheck = cliHealth.refresh(initialConfig);

	const providerEmitter = new vscode.EventEmitter<void>();
	context.subscriptions.push(providerEmitter);
	context.subscriptions.push(cliHealth.onDidChange(() => providerEmitter.fire()));
	const workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
		providerEmitter.fire();
	});
	context.subscriptions.push(workspaceWatcher);

	const provider = vscode.lm.registerMcpServerDefinitionProvider('gemini-mcp-provider', {
		onDidChangeMcpServerDefinitions: providerEmitter.event,
		provideMcpServerDefinitions: async () => {
			await initialHealthCheck.catch(() => {});
			const servers: vscode.McpServerDefinition[] = [];
			const cfg = readConfig();
			if (!cliHealth.isHealthy()) {
				return servers;
			}
			const serverCwd = vscode.Uri.joinPath(context.extensionUri, 'server').fsPath;
			const args = ['dist/index.js'];
			const resolvedTaskCwd = resolveTaskCwd(cfg.taskCwd);
			if (!resolvedTaskCwd) {
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
			void vscode.window
				.showWarningMessage(
					'Gemini CLI MCP settings changed. Reload VS Code to re-validate the Gemini CLI state.',
					'Reload',
					'Dismiss'
				)
				.then((choice) => {
					if (choice === 'Reload') {
						void vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
		}
	});
	context.subscriptions.push(configWatcher);

	const showStatusCmd = vscode.commands.registerCommand('geminiMcp.showStatus', async () => {
		await initialHealthCheck.catch(() => {});
		const cfg = readConfig();
		statusMonitor.updateConfig(cfg);
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
